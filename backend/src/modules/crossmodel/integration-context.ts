/**
 * Integration pre-injection (agentic-only cutover, 2026-07-23).
 *
 * Extracted VERBATIM from crossmodel.controller.ts streamQuery: intent-detect +
 * pre-fetch connected integration data (Google Workspace incl. the [SEND_EMAIL]
 * instructions, GitHub, X, Slack, Asana, Xero, Plaid, iMessage capability+read)
 * into ONE additionalContext block that is fed into the agent run via
 * buildChatQueryContext's additionalContext param.
 *
 * Graceful degradation throughout: any failure returns empty context, never
 * blocks the query. All sendEvent('progress', …) calls work unchanged — pass
 * the run's SSE send.
 */
import prisma from '../../config/database';
import logger from '../../utils/logger';
// Status copy: Digby's voice (chat-agent/status-voice.ts, 2026-10-04).
import { STATUS } from './chat-agent/status-voice';

export interface IntegrationContextResult {
  /** Combined integration data block for the system prompt (undefined when nothing matched). */
  additionalContext?: string;
  /** Paired + online Mac bridge agent id — when set, the post-answer draft classifier runs. */
  imessagePairedAgentId: string | null;
}

// ── Prefetch deadline (ticket 11d98377, 2026-10-10) ────────────────────────────
//
// The controller fully awaits buildIntegrationContext BEFORE the model run starts
// (crossmodel.controller.ts streamQuery: the await sits above startDetachedChatRun),
// so the prefetch is first-word latency on EVERY lane. The per-family fetch legs have
// their own HTTP timeouts (25 s Google / 25 s GitHub / 25 s Slack / 25 s Asana /
// 15 s Xero / 15 s Plaid / 60 s X / 8 s iMessage) but families run SEQUENTIALLY and no
// global deadline existed — a multi-family turn could stack several slow legs (worst
// additive case well over a minute) before the first word could stream. The nightly
// query suite (run 37962929291, seed 20261009) breached the Quick-lane first-chunk bar
// exactly this way: a "trending on X" turn paid the X trends prefetch before the run
// started (49.7 s to the first chunk, zero tool calls).
//
// The deadline bounds the WHOLE prefetch, not each family: the race resolves with
// whatever has settled (a partial context is strictly better than a wedged turn —
// the agent can still call the read tools itself once it runs), the underlying
// promise keeps settling in the background (no leg is aborted; its work is not
// lost, this call just stops waiting on it), and a never-resolving build never
// wedges the send. (Anonymous users short-circuit inside the build — the race's
// timer arms and clears a microtask later on their early return.)
// Default 45 s — the wide cut: normal prefetches (a few fast families) finish far
// inside it, and the pathological shapes the incident showed (a slow X trends leg
// riding a sequential family chain) land at the bar the nightly suite enforces
// (QUERY_SUITE_LATENCY_QUICK_P50_S = 45). Kill switch: INTEGRATION_PREFETCH_DEADLINE_MS
// <= 0 disables the race (unbounded wait, the pre-fix behaviour).
export const INTEGRATION_PREFETCH_DEADLINE_MS = (() => {
  const raw = process.env.INTEGRATION_PREFETCH_DEADLINE_MS;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    // An unparseable value (e.g. "45s") is NaN — treat it as an operator typo and
    // FALL CLOSED (the default bound), never silently back to the unbounded wait
    // (reviewer F2: `!(NaN > 0)` would have disabled the race by accident).
    if (Number.isFinite(n)) return n;
    logger.warn(`INTEGRATION_PREFETCH_DEADLINE_MS unparseable (${raw}) — using the 45 s default`);
  }
  return 45_000;
})();

/** The deadline race itself — exported for unit tests. */
export async function buildIntegrationContextBounded(
  build: () => Promise<IntegrationContextResult>,
  ms: number = INTEGRATION_PREFETCH_DEADLINE_MS,
): Promise<IntegrationContextResult> {
  if (!(ms > 0)) return build(); // disabled → the unbounded pre-fix wait
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      build(),
      new Promise<IntegrationContextResult>((resolve) => {
        timer = setTimeout(() => {
          logger.warn(
            `Integration prefetch exceeded its ${ms} ms deadline — starting the run with whatever settled; ` +
            `the fetch keeps settling in the background (the agent can read the integrations itself).`,
          );
          resolve({ additionalContext: undefined, imessagePairedAgentId: null });
        }, ms);
        if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
          (timer as unknown as { unref: () => void }).unref(); // never hold the process open
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function buildIntegrationContext(args: {
  userId: string | null;
  message: string;
  sendEvent: (type: string, data: any) => void;
}): Promise<IntegrationContextResult> {
  const { userId, message, sendEvent } = args;
  // Anonymous users have no connected integrations — skip everything.
  if (!userId) return { imessagePairedAgentId: null };

  // ── Google Workspace context injection ──────────────────────────────
  // Detect Google intent, check if user has connected Google, and pre-fetch
  // relevant data (Gmail, Calendar, Drive) to inject into the system context.
  // Graceful degradation: any failure returns empty context, never blocks the query.
  let googleAdditionalContext: string | undefined;
  if (userId && process.env.GOOGLE_OAUTH_CLIENT_ID) {
    try {
      const { detectGoogleIntent, hasAnyGoogleIntent, extractGmailSearchQuery, extractGmailMaxResults } = await import('./google/intent-detector');
      const intents = detectGoogleIntent(message);
      if (hasAnyGoogleIntent(intents)) {
        const googleRow = await (prisma as any).googleOAuthToken.findFirst({
          where: { userId },
          select: { userId: true },
        });
        if (googleRow) {
          sendEvent('progress', { message: STATUS.integration.google, stage: 'google' });
          const googleMcp = await import('./google/google-mcp');
          const fetches: Promise<string>[] = [];
          if (intents.gmail) {
            // Extract a Gmail search query from the user's natural language message.
            // e.g. "emails from today" → "newer_than:1d", "unread emails from John" → "is:unread from:John"
            // This ensures Gmail API returns relevant results instead of just the N most recent.
            const gmailQuery = extractGmailSearchQuery(message);
            const gmailMax   = extractGmailMaxResults(message);
            logger.info(`Gmail search query extracted: "${gmailQuery}" (maxResults=${gmailMax}) from message: "${message.substring(0, 100)}"`);
            fetches.push(googleMcp.getGmailMessages(userId, gmailQuery, gmailMax));
          }
          if (intents.calendar) fetches.push(googleMcp.getCalendarEvents(userId));
          if (intents.drive)    fetches.push(googleMcp.listDriveFiles(userId, ''));

          const results = await Promise.allSettled(fetches);
          const parts: string[] = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && !!r.value)
            .map(r => r.value);

          if (parts.length > 0) {
            googleAdditionalContext =
              `═══ GOOGLE WORKSPACE DATA (fetched for this query) ═══\n` +
              parts.join('\n\n') +
              `\n═══ END GOOGLE DATA ═══`;
          }
          if (intents.sendEmail) {
            googleAdditionalContext = (googleAdditionalContext || '') +
              `\n\n═══ EMAIL SENDING INSTRUCTIONS ═══
You CAN send emails on behalf of the user. The UI will show a confirmation card with Send/Edit/Cancel buttons before anything is delivered.

When the user asks you to write, compose, or send an email:
1. Draft the complete email
2. Output it using EXACTLY this format (no deviations, no extra text inside the block):

[SEND_EMAIL to="recipient@example.com" subject="Your Subject Here"]
The full email body goes here.

It can span multiple paragraphs.
[/SEND_EMAIL]

3. After the block, add ONE brief sentence like: "Here's the draft — tap Send to deliver it, or Edit to make changes."

CRITICAL RULES:
- NEVER say "I can't send emails" — you CAN, with user confirmation
- NEVER output plain "Yes / No / Cancel" text options — always use [SEND_EMAIL] block
- NEVER add commentary or explanations INSIDE the [SEND_EMAIL] block
- The block must contain ONLY the email body text
═══ END EMAIL INSTRUCTIONS ═══`;
          }
          logger.info(`Google context injected for userId=${userId}: ${parts.length} data source(s)`);
        }
      }
    } catch (googleErr: any) {
      logger.warn(`Google context injection failed (non-blocking): ${googleErr.message}`);
    }
  }

  // ── Xero Accounting context injection ─────────────────────────────────
  // Same pattern as Google: detect intent, check connection, pre-fetch data.
  // Graceful degradation: any failure returns empty context, never blocks.
  let xeroAdditionalContext: string | undefined;
  if (userId && process.env.XERO_CLIENT_ID) {
    try {
      const { detectXeroIntent, hasAnyXeroIntent, hasXeroMention } = await import('./xero/intent-detector');
      const xeroIntents = detectXeroIntent(message);
      if (hasAnyXeroIntent(xeroIntents) || hasXeroMention(message)) {
        const xeroRow = await (prisma as any).xeroOAuthToken.findFirst({
          where: { userId },
          select: { userId: true },
        });
        if (xeroRow) {
          sendEvent('progress', { message: STATUS.integration.xero, stage: 'xero' });
          const xeroMcp = await import('./xero/xero-mcp');
          const fetches: Promise<string>[] = [];
          // Always fetch org info for context
          fetches.push(xeroMcp.getOrganisation(userId));
          if (xeroIntents.contacts)      fetches.push(xeroMcp.getContacts(userId));
          if (xeroIntents.invoices)      fetches.push(xeroMcp.getInvoices(userId));
          if (xeroIntents.bills)         fetches.push(xeroMcp.getBills(userId));
          if (xeroIntents.accounts)      fetches.push(xeroMcp.getAccounts(userId));
          if (xeroIntents.bank)          fetches.push(xeroMcp.getBankSummary(userId));
          if (xeroIntents.profitAndLoss) fetches.push(xeroMcp.getProfitAndLoss(userId));
          if (xeroIntents.balanceSheet)  fetches.push(xeroMcp.getBalanceSheet(userId));
          // If general "xero" mention with no specific intent, fetch invoices + contacts
          if (!hasAnyXeroIntent(xeroIntents) && hasXeroMention(message)) {
            fetches.push(xeroMcp.getInvoices(userId));
            fetches.push(xeroMcp.getContacts(userId, '', 5));
          }

          const results = await Promise.allSettled(fetches);
          const parts: string[] = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && !!r.value)
            .map(r => r.value);

          if (parts.length > 0) {
            xeroAdditionalContext =
              `═══ XERO ACCOUNTING DATA (fetched for this query) ═══\n` +
              parts.join('\n\n') +
              `\n═══ END XERO DATA ═══`;
          }
          logger.info(`Xero context injected for userId=${userId}: ${parts.length} data source(s)`);
        }
      }
    } catch (xeroErr: any) {
      logger.warn(`Xero context injection failed (non-blocking): ${xeroErr.message}`);
    }
  }

  // ── Slack context injection ─────────────────────────────────────────────
  // Detect Slack intent, check connection, pre-fetch channels/messages/search/users.
  // Graceful degradation: any failure returns empty context, never blocks.
  let slackAdditionalContext: string | undefined;
  if (userId && process.env.SLACK_CLIENT_ID) {
    try {
      const { detectSlackIntent, hasAnySlackIntent, hasSlackMention, extractSlackChannel } = await import('./slack/intent-detector');
      const slackIntents = detectSlackIntent(message);
      if (hasAnySlackIntent(slackIntents) || hasSlackMention(message)) {
        const slackRow = await (prisma as any).slackOAuthToken.findFirst({
          where: { userId },
          select: { userId: true },
        });
        if (slackRow) {
          sendEvent('progress', { message: STATUS.integration.slack, stage: 'slack' });
          const slackMcp = await import('./slack/slack-mcp');
          const channel = extractSlackChannel(message);
          const fetches: Promise<string>[] = [];
          if (slackIntents.search)             fetches.push(slackMcp.searchMessages(userId, message));
          if (slackIntents.messages && channel) fetches.push(slackMcp.getChannelHistory(userId, channel));
          if (slackIntents.channels)           fetches.push(slackMcp.listChannels(userId));
          if (slackIntents.users)              fetches.push(slackMcp.listUsers(userId));
          // General Slack mention with no specific intent — list channels.
          if (!hasAnySlackIntent(slackIntents) && hasSlackMention(message)) {
            fetches.push(slackMcp.listChannels(userId));
          }

          const results = await Promise.allSettled(fetches);
          const parts: string[] = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && !!r.value)
            .map(r => r.value);

          if (parts.length > 0) {
            slackAdditionalContext =
              `═══ SLACK DATA (fetched for this query) ═══\n` +
              parts.join('\n\n') +
              `\n═══ END SLACK DATA ═══`;
          }
          logger.info(`Slack context injected for userId=${userId}: ${parts.length} data source(s)`);
        }
      }
    } catch (slackErr: any) {
      logger.warn(`Slack context injection failed (non-blocking): ${slackErr.message}`);
    }
  }

  // ── Asana context injection ─────────────────────────────────────────────
  // Detect Asana intent, check connection, pre-fetch tasks/projects/search.
  // Graceful degradation: any failure returns empty context, never blocks.
  let asanaAdditionalContext: string | undefined;
  if (userId && process.env.ASANA_CLIENT_ID) {
    try {
      const { detectAsanaIntent, hasAnyAsanaIntent, hasAsanaMention } = await import('./asana/intent-detector');
      const asanaIntents = detectAsanaIntent(message);
      if (hasAnyAsanaIntent(asanaIntents) || hasAsanaMention(message)) {
        const asanaRow = await (prisma as any).asanaOAuthToken.findFirst({
          where: { userId },
          select: { userId: true },
        });
        if (asanaRow) {
          sendEvent('progress', { message: STATUS.integration.asana, stage: 'asana' });
          const asanaMcp = await import('./asana/asana-mcp');
          const fetches: Promise<string>[] = [];
          if (asanaIntents.tasks)    fetches.push(asanaMcp.listMyTasks(userId));
          if (asanaIntents.projects) fetches.push(asanaMcp.listProjects(userId));
          if (asanaIntents.search)   fetches.push(asanaMcp.searchTasks(userId, message));
          // General Asana mention with no specific intent — list the user's tasks.
          if (!hasAnyAsanaIntent(asanaIntents) && hasAsanaMention(message)) {
            fetches.push(asanaMcp.listMyTasks(userId));
          }

          const results = await Promise.allSettled(fetches);
          const parts: string[] = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && !!r.value)
            .map(r => r.value);

          if (parts.length > 0) {
            asanaAdditionalContext =
              `═══ ASANA DATA (fetched for this query) ═══\n` +
              parts.join('\n\n') +
              `\n═══ END ASANA DATA ═══`;
          }
          logger.info(`Asana context injected for userId=${userId}: ${parts.length} data source(s)`);
        }
      }
    } catch (asanaErr: any) {
      logger.warn(`Asana context injection failed (non-blocking): ${asanaErr.message}`);
    }
  }

  // ── GitHub context injection ────────────────────────────────────────────
  let githubAdditionalContext: string | undefined;
  // A PAT-only instance (no OAuth app, GITHUB_TOKEN_ENCRYPTION_KEY set) stores
  // tokens too (2026-10-20 self-host hardening): every GitHub row is encrypted
  // with that key, so the key is the real precondition for a decryptable row.
  if (userId && (process.env.GITHUB_OAUTH_CLIENT_ID || process.env.GITHUB_TOKEN_ENCRYPTION_KEY)) {
    try {
      const { detectGitHubIntent, hasAnyGitHubIntent, extractRepoContext } = await import('./github/intent-detector');
      const gitHubIntents = detectGitHubIntent(message);
      if (hasAnyGitHubIntent(gitHubIntents)) {
        const gitHubRow = await (prisma as any).gitHubOAuthToken.findFirst({
          where: { userId },
          select: { userId: true },
        });
        if (gitHubRow) {
          sendEvent('progress', { message: STATUS.integration.github, stage: 'github' });
          const gitHubMcp = await import('./github/github-mcp');
          const fetches: Promise<string>[] = [];
          const repoCtx = extractRepoContext(message);

          if (gitHubIntents.repos) fetches.push(gitHubMcp.listUserRepos(userId));
          if (gitHubIntents.issues && repoCtx.owner && repoCtx.repo)
            fetches.push(gitHubMcp.listIssues(userId, repoCtx.owner, repoCtx.repo));
          if (gitHubIntents.pullRequests && repoCtx.owner && repoCtx.repo)
            fetches.push(gitHubMcp.listPullRequests(userId, repoCtx.owner, repoCtx.repo));
          if (gitHubIntents.codeSearch)
            fetches.push(gitHubMcp.searchCode(userId, message));
          if (gitHubIntents.files && repoCtx.owner && repoCtx.repo)
            fetches.push(gitHubMcp.getFileContents(userId, repoCtx.owner, repoCtx.repo, 'README.md'));

          const results = await Promise.allSettled(fetches);
          const parts: string[] = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && !!r.value)
            .map(r => r.value);

          if (parts.length > 0) {
            githubAdditionalContext =
              `═══ GITHUB DATA (fetched for this query) ═══\n` +
              parts.join('\n\n') +
              `\n═══ END GITHUB DATA ═══`;
          }
          logger.info(`GitHub context injected for userId=${userId}: ${parts.length} data source(s)`);
        }
      }
    } catch (gitHubErr: any) {
      logger.warn(`GitHub context injection failed (non-blocking): ${gitHubErr.message}`);
    }
  }

  // ── X (Twitter) context injection ──────────────────────────────────────
  // Reads use Bright Data (no per-user auth). Writes require OAuth — we
  // only pre-fetch READ data here; the AI will explicitly invoke write
  // tools (post/like/etc.) when requested by the user.
  let xAdditionalContext: string | undefined;
  if (userId && process.env.X_MCP_API_KEY) {
    try {
      const { detectXIntent, hasReadIntent, hasAnyXIntent, extractXContext } = await import('./x/intent-detector');
      const xIntents = detectXIntent(message);
      if (hasReadIntent(xIntents) || hasAnyXIntent(xIntents)) {
        sendEvent('progress', { message: STATUS.integration.x, stage: 'x' });
        const xMcp = await import('./x/x-mcp');
        const ctx = extractXContext(message);
        const fetches: Promise<string | null>[] = [];
        if (xIntents.profile && ctx.handle)      fetches.push(xMcp.getUserProfile(ctx.handle, userId));
        if (xIntents.tweet   && ctx.tweetUrl)    fetches.push(xMcp.getTweet(ctx.tweetUrl, userId));
        if (xIntents.search  && ctx.searchQuery) fetches.push(xMcp.search(ctx.searchQuery, userId));
        if (xIntents.trends)                     fetches.push(xMcp.getTrends(undefined, userId));
        // List every connected X account so the AI knows which handles
        // are available and can choose by label when posting.
        const xRows = await (prisma as any).xOAuthToken.findMany({
          where:   { userId },
          select:  { label: true, screenName: true },
          orderBy: { createdAt: 'asc' },
        });
        const hasWriteIntent =
          xIntents.post || xIntents.reply || xIntents.like || xIntents.retweet || xIntents.follow;
        // Reviewer nuance (fa956f09): the connected-accounts note is NOT a
        // fetch leg — it used to ride `fetches` and inflated the "N of M
        // failed legs" denominator (a 1-read failure reported "1 of 2").
        let connectedAccountsNote: string | null = null;
        if (xRows.length && hasWriteIntent) {
          const list = xRows
            .map((r: any) => `  - ${r.label}: ${r.screenName ? '@' + r.screenName : '(handle unknown)'}`)
            .join('\n');
          connectedAccountsNote =
            `Connected X accounts (pass label="<label>" to a write tool to act as a specific account; default = primary):\n${list}`;
        }

        const results = await Promise.allSettled(fetches);
        const parts: string[] = results
          .filter((r): r is PromiseFulfilledResult<string | null> => r.status === 'fulfilled' && !!r.value)
          .map(r => r.value as string);
        if (connectedAccountsNote) parts.unshift(connectedAccountsNote);
        // Ticket fa956f09 (2026-09-22): a null or rejected X fetch leg used to
        // be dropped SILENTLY here — the digest's X reads failed all day and
        // the model never learned why (empty context, "Loading X data..."
        // already streamed, zero trace). Failed legs now become an explicit
        // context part so the model tells the user the X read failed and why,
        // instead of implying there were no results.
        const failedLegs: string[] = [];
        results.forEach((r, i) => {
          if (r.status === 'rejected') {
            failedLegs.push(`X fetch leg ${i + 1} threw: ${String((r as PromiseRejectedResult).reason).slice(0, 200)}`);
          } else if (!r.value) {
            failedLegs.push(`X fetch leg ${i + 1} returned no data (x-mcp/gateway/network failure)`);
          }
        });
        if (failedLegs.length > 0) {
          logger.warn(`X context fetch failures for userId=${userId}: ${failedLegs.join(' | ')}`);
          sendEvent('progress', { message: STATUS.integration.xUnavailable, stage: 'x' });
          parts.push(
            `⚠ X DATA UNAVAILABLE — ${failedLegs.length} of ${results.length} X fetch leg(s) failed (${failedLegs.join('; ')}). ` +
            `The user's X connection is fine; the platform-side read service (x-mcp) is failing. ` +
            `Tell the user X data could not be fetched for this reply, do NOT present this as "no results found", ` +
            `and suggest retrying later or using web search as a fallback.`,
          );
        }

        if (parts.length > 0) {
          xAdditionalContext =
            `═══ X (TWITTER) DATA (fetched for this query) ═══\n` +
            parts.join('\n\n') +
            `\n═══ END X DATA ═══`;
        }
        logger.info(`X context injected for userId=${userId}: ${parts.length} data source(s)`);
      }
    } catch (xErr: any) {
      logger.warn(`X context injection failed (non-blocking): ${xErr.message}`);
    }
  }

  // ── Plaid Banking context injection ────────────────────────────────────
  // Same pattern as Xero: detect intent, check connection, pre-fetch data.
  // Graceful degradation: any failure returns empty context, never blocks.
  let plaidAdditionalContext: string | undefined;
  if (userId && process.env.PLAID_CLIENT_ID) {
    try {
      const { detectPlaidIntent, hasAnyPlaidIntent, hasPlaidMention } = await import('./plaid/intent-detector');
      const plaidIntents = detectPlaidIntent(message);
      if (hasAnyPlaidIntent(plaidIntents) || hasPlaidMention(message)) {
        const plaidRow = await (prisma as any).plaidAccessToken.findFirst({
          where: { userId },
          select: { userId: true },
        });
        if (plaidRow) {
          sendEvent('progress', { message: STATUS.integration.plaid, stage: 'plaid' });
          const plaidMcp = await import('./plaid/plaid-mcp');
          const fetches: Promise<string>[] = [];
          // Always fetch accounts for context
          fetches.push(plaidMcp.getAccounts(userId));
          if (plaidIntents.balances)     fetches.push(plaidMcp.getBalances(userId));
          if (plaidIntents.transactions)  fetches.push(plaidMcp.getTransactions(userId, 30, 25));
          if (plaidIntents.recurring)     fetches.push(plaidMcp.getRecurringTransactions(userId));
          if (plaidIntents.identity)      fetches.push(plaidMcp.getIdentity(userId));
          // If general "plaid" mention with no specific intent, fetch balances + transactions
          if (!hasAnyPlaidIntent(plaidIntents) && hasPlaidMention(message)) {
            fetches.push(plaidMcp.getBalances(userId));
            fetches.push(plaidMcp.getTransactions(userId, 30, 15));
          }

          const results = await Promise.allSettled(fetches);
          const parts: string[] = results
            .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && !!r.value)
            .map(r => r.value);

          if (parts.length > 0) {
            plaidAdditionalContext =
              `═══ PLAID BANKING DATA (fetched for this query) ═══\n` +
              parts.join('\n\n') +
              `\n═══ END PLAID DATA ═══`;
          }
          logger.info(`Plaid context injected for userId=${userId}: ${parts.length} data source(s)`);
        }
      }
    } catch (plaidErr: any) {
      logger.warn(`Plaid context injection failed (non-blocking): ${plaidErr.message}`);
    }
  }

  // ── macOS iMessage: read context + confirm-before-send ──────────────────
  // If the user has paired a Mac AND it's online AND the message is about
  // texts/iMessages:
  //   • SEND intent → parse a draft and emit an `imessage-draft` event so the
  //     UI can show a confirm-before-send card. We do NOT send here, and we
  //     short-circuit the model pipeline (no synthesis needed for a draft).
  //   • READ intent → pull the relevant conversation (a named thread's actual
  //     messages if we can resolve one, else the recent-conversation list)
  //     into context so the AI can reason over it.
  // ── macOS iMessage — MODEL-REASONED, no keyword routing for sending ─────
  // If the user has a paired+online Mac we (1) always tell the model it CAN
  // send/read texts (a capability note — the MODEL decides when to use it, no
  // trigger words), and (2) decide whether the user actually wants to SEND
  // AFTER synthesis, via a reasoning classifier over the composed answer (see
  // the post-pipeline block). READ context is still pre-fetched only when the
  // message is about reading messages — that's a latency optimization (pulling
  // the Mac's chat list costs a round-trip), not send routing.
  let imessageAdditionalContext: string | undefined;
  let imessagePairedAgentId: string | null = null;
  if (userId) {
    try {
      const { listAgents, isOnline, agentDisplayName } = await import('./imessage/imessage.service');
      // Multi-Mac (2026-09-24): the capability note + read enrichment use the
      // default online Mac (any paired online Mac keeps the capability on).
      const agents = await listAgents(userId);
      const agent = agents.find((a) => a.isDefault && isOnline(a.lastSeenAt))
        ?? agents.find((a) => isOnline(a.lastSeenAt))
        ?? null;
      if (agent) {
        imessagePairedAgentId = agent.id;
        const deviceNote = agents.length > 1 ? ` (via '${agentDisplayName(agent)}'${agents.length > 1 ? `, ${agents.length} Macs paired` : ''})` : '';
        let ctx =
          `═══ IMESSAGE CAPABILITY ═══\n` +
          `The user has a paired Mac, so you CAN send iMessages/texts on their behalf. When they ask you ` +
          `to send or text a message, compose the EXACT message you would send (and confirm who it goes to); ` +
          `a confirm-and-send card then appears for them to tap Send — you do not need any special command. ` +
          `Never tell the user you are unable to send texts/iMessages. You can also reference their recent ` +
          `messages when relevant.${deviceNote}\n═══ END IMESSAGE CAPABILITY ═══`;

        // READ enrichment (optional, latency-gated): if the message is about
        // reading messages, pull the relevant thread / recent conversation list.
        const { detectIMessageIntent } = await import('./imessage/intent-detector');
        if (detectIMessageIntent(message).read) {
          sendEvent('progress', { message: STATUS.integration.imessage, stage: 'imessage' });
          const { agentBroker, IMESSAGE_READ_DISPATCH_TIMEOUT_MS } = await import('./imessage/agent-link');
          const { resolveNamedChat } = await import('./imessage/nlp');
          let chats: any[] = [];
          try {
            const c = await agentBroker.dispatch(agent.id, 'list_chats', { limit: 25 }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS);
            if (Array.isArray(c)) chats = c;
          } catch (e: any) { logger.warn(`iMessage list_chats failed (non-blocking): ${e?.message || e}`); }
          let injected = '';
          const named = resolveNamedChat(message, chats);
          if (named) {
            try {
              const target = named.identifier || String(named.chatId);
              const msgs = await agentBroker.dispatch(agent.id, 'get_messages', { chat: target, limit: 25 }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS);
              const body = typeof msgs === 'string' ? msgs : JSON.stringify(msgs, null, 2);
              if (body && body !== 'null' && body !== '[]') injected = `Conversation with ${named.displayName || named.identifier}:\n${body}`;
            } catch (e: any) { logger.warn(`iMessage get_messages failed (non-blocking): ${e?.message || e}`); }
          }
          if (!injected && chats.length > 0) injected = `Recent conversations:\n${JSON.stringify(chats, null, 2)}`;
          if (injected) ctx += `\n\n═══ IMESSAGE DATA (from the user's Mac) ═══\n${injected}\n═══ END IMESSAGE DATA ═══`;
        }
        imessageAdditionalContext = ctx;
        logger.info(`iMessage capability available for userId=${userId}`);
      }
    } catch (imErr: any) {
      logger.warn(`iMessage handling failed (non-blocking): ${imErr.message}`);
    }
  }

  // ── macOS Apple Calendar: prefetch on calendar intent (2026-11-06) ───────
  // The owner's report ("calendar sync isn't working or showing in my digby
  // calendar on new chats or context") had TWO halves. The device half is the
  // agent's consent path; THIS is the context half: Google Calendar was
  // prefetched on calendar intent while Apple Calendar — the calendar actually
  // holding the owner's day — was never fetched at all, so the assistant
  // answered new-chat questions about "today" with no knowledge of the events
  // on the Macs. Latency-bounded and intent-gated exactly like the other
  // families: one dispatch on a calendar-ish message, never on every send.
  //
  // It runs INSIDE the existing prefetch deadline race (`buildIntegrationContext
  // Bounded`), and the read itself is bounded by the read dispatch timeout, so
  // a wedged Mac cannot wedge a turn. A failure is CLASSIFIED, never an empty
  // day: `readAppleCalendar` answers a state, and the non-ok states reach the
  // prompt as one honest line (so the model says "I can't see your Mac's
  // calendar because X" instead of inventing a free day).
  let appleCalendarContext: string | undefined;
  if (userId) {
    try {
      const { detectGoogleIntent } = await import('./google/intent-detector');
      // Reuse the Google calendar intent detector: it is the project's single
      // definition of "this message is about a calendar/schedule" (calendar,
      // calendars, "what's on my agenda", "meeting … today", "<name> calendar").
      // A second regex set would drift from it.
      if (detectGoogleIntent(message).calendar) {
        sendEvent('progress', { message: STATUS.integration.appleCalendar, stage: 'apple-calendar' });
        const { listAgents, isOnline } = await import('./imessage/imessage.service');
        const agents = await listAgents(userId);
        // Only pay the dispatch when some Mac could plausibly answer; the
        // policy module still owns WHICH Mac and why.
        if (agents.some((a) => isOnline(a.lastSeenAt))) {
          const { readAppleCalendar, appleCalendarEventsForPrompt, appleCalendarDeviceTag } = await import('./calendar/apple-calendar');
          const read = await readAppleCalendar(userId, { days: 7, agents });
          const tag = appleCalendarDeviceTag(read);
          if (read.state === 'ok') {
            const body = appleCalendarEventsForPrompt(read);
            if (body) {
              appleCalendarContext =
                `═══ APPLE CALENDAR (from the user's Mac) ═══\n` +
                `${body}\n${tag}\n` +
                `(These are the user's own macOS/Apple Calendar events, read from their Mac — distinct from any Google calendar data above.)\n` +
                `═══ END APPLE CALENDAR ═══`;
            }
          } else {
            // Classified failure: say WHY inside the context so the answer can
            // be honest ("I can't see the Mac calendar because access was never
            // granted") instead of silently omitting the family — which is the
            // shape that made the owner believe nothing was wired up.
            appleCalendarContext =
              `═══ APPLE CALENDAR (UNAVAILABLE) ═══\n` +
              `${read.error || 'The Mac calendar could not be read.'}\n` +
              `Do NOT tell the user their calendar is empty — say the macOS calendar could not be read and name the reason.\n` +
              `═══ END APPLE CALENDAR ═══`;
          }
        }
      }
    } catch (calErr: any) {
      // Graceful: a broken Apple calendar leg must never block the turn (the
      // same contract as every other family).
      logger.warn(`Apple Calendar context injection failed (non-blocking): ${calErr?.message || calErr}`);
    }
  }

  // Combine additional contexts (Google + GitHub + X + Slack + Asana + Xero + Plaid + iMessage + Apple Calendar)
  const contextParts = [googleAdditionalContext, githubAdditionalContext, xAdditionalContext, slackAdditionalContext, asanaAdditionalContext, xeroAdditionalContext, plaidAdditionalContext, imessageAdditionalContext, appleCalendarContext]
    .filter((c): c is string => !!c);
  const combinedAdditionalContext = contextParts.length > 0
    ? contextParts.join('\n\n')
    : undefined;

  return { additionalContext: combinedAdditionalContext, imessagePairedAgentId };
}
