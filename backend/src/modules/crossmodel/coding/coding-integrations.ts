/**
 * Digby Code — integration tools (parity with chat Digby's connectors).
 *
 * Chat Digby reaches GitHub / Google / Slack / Asana / X / Xero / Plaid /
 * iMessage by intent-detecting the user's message and injecting fetched context.
 * An AGENT is better served by CALLABLE tools, so we expose the same per-user
 * MCP clients as coding tools the agent can invoke when it needs external
 * context (read a linked GitHub issue, the Slack thread that describes the
 * feature, the Asana task, a design doc, an invoice, a bank balance).
 *
 * Every client takes the userId and returns a pre-formatted string (and an empty
 * string when the user hasn't connected that integration) — so this is a thin,
 * best-effort wrapper: not-connected / no-match degrades to a helpful message,
 * never an error that breaks the run. Reads are best-effort; the WRITES
 * (Google 2026-09-23, the #26 connector set 2026-09-24) answer a JSON envelope
 * and key their human-turn anchor off ctx.userTurnAt — the ONE guard this
 * layer has (integration tools bypass the platform gates; see agent.ts).
 */

import * as github from '../github/github-mcp';
import * as google from '../google/google-mcp';
import * as slack from '../slack/slack-mcp';
import * as discord from '../discord/discord-mcp';
import * as asana from '../asana/asana-mcp';
import * as x from '../x/x-mcp';
import * as xero from '../xero/xero-mcp';
import * as plaid from '../plaid/plaid-mcp';
import { selectAgent, agentDisplayName } from '../imessage/imessage.service';
import { agentBroker, IMESSAGE_READ_DISPATCH_TIMEOUT_MS } from '../imessage/agent-link';
import { agentPlatform, hasCapability } from '../imessage/agent-capabilities';
import { readAppleCalendar, appleCalendarStateLine, appleCalendarDeviceTag } from '../calendar/apple-calendar';
import logger from '../../../utils/logger';

const S = (o: any) => (typeof o === 'string' ? o : String(o ?? ''));
const labelArg = (args: any): string | undefined => (args?.label ? S(args.label) : undefined);
/** github_get_file_contents answer ceiling — GitHub's contents API serves files up to 1 MB. */
const GITHUB_FILE_READ_MAX_CHARS = 120_000;

/**
 * Google reads resolve the account FIRST so failures are actionable instead of
 * the generic notFound conflation: not-connected, token-refresh-failed, and
 * label-not-found (which LISTS the valid labels — the only discovery surface
 * the model has) each produce their own message. Returns null when resolution
 * succeeded and the read itself should run.
 */
async function googleReadPrecheck(userId: string, args: any): Promise<string | null> {
  const resolution = await google.resolveGoogleAccount(userId, labelArg(args));
  return resolution.ok ? null : resolution.message;
}

// Schemas/names live in ./integration-tool-schema (dependency-free) so roles.ts and
// tests can import them without the env-dependent wrapper chain. Re-exported here
// for existing consumers (agent.ts, tests).
import { INTEGRATION_TOOL_SCHEMA, INTEGRATION_TOOL_NAMES, isIntegrationTool, GOOGLE_WRITE_TOOL_NAMES, googleWriteToolsDisabled, CONNECTOR_WRITE_TOOL_NAMES, HUMAN_TURN_CONNECTOR_WRITES, connectorWriteToolsDisabled, githubFileReadToolDisabled, githubFileNotFoundNote } from './integration-tool-schema';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
export { INTEGRATION_TOOL_SCHEMA, INTEGRATION_TOOL_NAMES, isIntegrationTool, GOOGLE_WRITE_TOOL_NAMES };

/** Execute an integration tool for a user. Always resolves to a string. */
export interface IntegrationToolContext {
  /** Set on human-attended runs (the anchor every outward-facing write keys on). */
  userTurnAt?: Date;
  /** The run's project (coding sessions and chat seats both thread it, 99145890):
   *  the gmail_get_attachment auto-ingest hook needs it to know WHICH project's
   *  knowledge base (if any) has autoIngestGmailAttachments enabled. */
  projectId?: string | null;
  /** The run's session/chat id — the auto-ingest hook's rate-slot subject. */
  sessionId?: string | null;
}

/** The JSON envelope every Google WRITE answers with — the verifier / receipt parsers read `ids`. */
function googleWriteEnvelope(tool: string, r: { ok: boolean; text: string; account?: string; reason?: string }): string {
  const ids: Record<string, string> = {};
  const m = /\b(documentId|spreadsheetId|presentationId|fileId|folderId|messageId|draftId|eventId) ([A-Za-z0-9_-]{6,})/g;
  let x: RegExpExecArray | null;
  while ((x = m.exec(r.text)) !== null) ids[x[1]] = x[2];
  const link = /(https:\/\/\S+)/.exec(r.text)?.[1];
  if (link) ids.link = link;
  return JSON.stringify({ ok: r.ok, tool, ...(r.account ? { account: r.account } : {}), ...(r.reason ? { reason: r.reason } : {}), ids, message: r.text }, null, 1);
}

/** Envelope for the #26 connector writes — ids harvested from the MCP text. */
function connectorWriteEnvelope(tool: string, ok: boolean, text: string, extra: Record<string, unknown> = {}): string {
  const ids: Record<string, string> = {};
  const m = /\b(taskId|ts|tweetId|messageId) ([A-Za-z0-9_.-]{4,})/g;
  let x: RegExpExecArray | null;
  while ((x = m.exec(text)) !== null) ids[x[1]] = x[2];
  const link = /(https:\/\/\S+)/.exec(text)?.[1];
  if (link) ids.link = link;
  return JSON.stringify({ ok, tool, ...extra, ids, message: text }, null, 1);
}
const IMESSAGE_SEND_DAILY_CAP = () => Math.max(1, Number(process.env.IMESSAGE_SEND_DAILY_CAP) || 40);
/**
 * Kill switch (ticket 99145890, switch #541): GmailAttachment auto-ingest —
 * the gmail_get_attachment hook that files an attachment into the project KB
 * when autoIngestGmailAttachments is on. A new DB write + model-call path
 * inside a Gmail READ tool must be instantly revertible from box env (the
 * GMAIL_ATTACHMENT_VISION_DISABLED precedent, switch #513).
 */
function gmailAutoIngestDisabled(): boolean {
  const v = String(process.env.GMAIL_AUTO_INGEST_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
async function imessageSendSlot(userId: string): Promise<{ ok: true } | { ok: false; cap: number }> {
  try {
    const redis = (await import('../../../config/redis')).default as any;
    const key = `imessage_send:user:${userId}:${new Date().toISOString().slice(0, 10)}`;
    const n = await redis.incr(key);
    await redis.expire(key, 2 * 86_400);
    if (n > IMESSAGE_SEND_DAILY_CAP()) { await redis.decr(key).catch(() => {}); return { ok: false, cap: IMESSAGE_SEND_DAILY_CAP() }; }
    return { ok: true };
  } catch { return { ok: true }; } // counter unavailable — allow (user-scoped, human-attended)
}

export async function executeIntegrationTool(userId: string, name: string, args: any, ctx: IntegrationToolContext = {}): Promise<string> {
  // Only for a wrapper's '' (not connected / genuinely nothing matched): since 2026-10-04 a FAILED
  // read returns its own one-line reason (integrations/integration-error.ts; Xero: XeroApiError),
  // which passes through the `||` below untouched.
  const notFound = (svc: string) => `No result from ${svc} — the integration may not be connected (Settings → Integrations) or nothing matched.`;
  // ── Connector WRITE tools (capability gap #26, 2026-09-24) ──
  if (CONNECTOR_WRITE_TOOL_NAMES.includes(name)) {
    if (connectorWriteToolsDisabled()) return JSON.stringify({ ok: false, tool: name, reason: 'disabled', message: 'Connector write tools are switched off on this instance.' });
    if (HUMAN_TURN_CONNECTOR_WRITES.has(name) && !ctx.userTurnAt) {
      return JSON.stringify({ ok: false, tool: name, reason: 'machine_run', message: `NOT SENT: a machine-triggered run may not ${name === 'x_post' ? 'post on X' : name === 'slack_post_message' ? 'post to Slack' : name.startsWith('discord_') ? 'send a Discord message' : 'send an iMessage'} on the user's behalf. It needs a human-attended turn where the user asked for it — put the draft text in your answer and say so.` }, null, 1);
    }
    const note = (ok: boolean, text: string, extra: Record<string, unknown> = {}) => connectorWriteEnvelope(name, ok, text, extra);
    try {
      if (name === 'imessage_send') {
        const to = S(args?.to).trim(); const text = S(args?.text);
        if (!to || !text) return note(false, 'imessage_send needs `to` (a phone/email handle) and `text`.', { reason: 'invalid' });
        const slot = await imessageSendSlot(userId);
        if (!slot.ok) return note(false, `NOT SENT: this account already sent ${slot.cap} iMessages today (IMESSAGE_SEND_DAILY_CAP).`, { reason: 'rate_limited' });
        const selection = await selectAgent(userId, args?.device ? S(args.device) : undefined);
        if (!selection.agent) return note(false, `NOT SENT: iMessage isn't available — ${selection.error || 'no paired Mac is online.'}`, { reason: 'no_agent' });
        const device = agentDisplayName(selection.agent);
        const result = await agentBroker.dispatch(selection.agent.id, 'send_message', { to, text }, 20_000);
        const body = typeof result === 'string' ? result : JSON.stringify(result ?? null);
        return note(true, `Sent via ${device} to ${to}: ${body}`, { device });
      }
      if (name === 'slack_post_message') {
        const channel = S(args?.channel).trim(); const text = S(args?.text);
        if (!channel || !text) return note(false, 'slack_post_message needs channel and text.', { reason: 'invalid' });
        const r = await slack.postMessage(userId, channel, text, args?.thread_ts ? S(args.thread_ts) : undefined);
        if (r === null) return note(false, 'NOT POSTED: Slack is not connected for this user (Account → Integrations) or the Slack service did not answer.', { reason: 'not_connected' });
        return note(!/^Error/i.test(r), r, /^Error/i.test(r) ? { reason: /chat:write|missing_scope/i.test(r) ? 'missing_scopes' : 'call_failed' } : {});
      }
      if (name === 'discord_send_message' || name === 'discord_send_dm') {
        const isDm = name === 'discord_send_dm';
        const target = S(isDm ? args?.userId : args?.channelId).trim(); const text = S(args?.text);
        if (!target || !text) return note(false, `${name} needs ${isDm ? 'userId' : 'channelId'} and text.`, { reason: 'invalid' });
        const r = isDm ? await discord.sendDm(target, text) : await discord.sendMessage(target, text);
        if (r === null) return note(false, 'NOT SENT: the Discord integration is not configured for this instance (admin: DISCORD_BOT_TOKEN + discord-mcp container) or the Discord service did not answer.', { reason: 'not_connected' });
        return note(!/^Error/i.test(r), r, /^Error/i.test(r) ? { reason: /401|403|Missing Permissions/i.test(r) ? 'missing_permissions' : 'call_failed' } : {});
      }
      if (name === 'asana_create_task' || name === 'asana_update_task') {
        if (name === 'asana_create_task' && !S(args?.name).trim()) return note(false, 'asana_create_task needs name.', { reason: 'invalid' });
        if (name === 'asana_update_task' && !S(args?.taskId).trim()) return note(false, 'asana_update_task needs taskId.', { reason: 'invalid' });
        const r = name === 'asana_create_task'
          ? await asana.createTask(userId, { name: S(args?.name), ...(args?.notes ? { notes: S(args.notes) } : {}), ...(args?.project ? { project: S(args.project) } : {}), ...(args?.workspace ? { workspace: S(args.workspace) } : {}), ...(args?.dueOn ? { dueOn: S(args.dueOn) } : {}), ...(args?.assignee ? { assignee: S(args.assignee) } : {}) })
          : await asana.updateTask(userId, S(args?.taskId), { ...(args?.name !== undefined ? { name: S(args.name) } : {}), ...(args?.notes !== undefined ? { notes: S(args.notes) } : {}), ...(typeof args?.completed === 'boolean' ? { completed: args.completed } : {}), ...(args?.dueOn !== undefined ? { dueOn: args.dueOn === null ? null : S(args.dueOn) } : {}) });
        if (r === null) return note(false, 'NOT DONE: Asana is not connected for this user (Account → Integrations) or the Asana service did not answer.', { reason: 'not_connected' });
        return note(!/^Error/i.test(r), r, /^Error/i.test(r) ? { reason: 'call_failed' } : {});
      }
      if (name === 'x_post') {
        const text = S(args?.text);
        if (!text.trim()) return note(false, 'x_post needs text.', { reason: 'invalid' });
        const r = await x.postTweet(userId, text, { ...(args?.label ? { label: S(args.label) } : {}), ...(args?.replyToTweetId ? { replyToTweetId: S(args.replyToTweetId) } : {}), ...(args?.quoteTweetId ? { quoteTweetId: S(args.quoteTweetId) } : {}) });
        if (r === null) return note(false, 'NOT POSTED: the user has not connected an X account (Account → Integrations) or the X service did not answer.', { reason: 'not_connected' });
        return note(!/^(Error|Cannot post)/i.test(r), r, /^(Error|Cannot post)/i.test(r) ? { reason: 'call_failed' } : {});
      }
    } catch (e: any) {
      return note(false, `${name} failed: ${String(e?.message ?? e).slice(0, 200)}`, { reason: 'error' });
    }
  }
  // ── Google WRITE tools (2026-09-23) ──
  if (GOOGLE_WRITE_TOOL_NAMES.includes(name)) {
    if (googleWriteToolsDisabled()) return JSON.stringify({ ok: false, tool: name, reason: 'disabled', message: 'Google editing tools are switched off on this instance.' });
    if (name === 'gmail_send_email' && !ctx.userTurnAt) {
      return JSON.stringify({ ok: false, tool: name, reason: 'machine_run', message: 'NOT SENT: a machine-triggered run may not send email on the user\'s behalf. Sending needs a human-attended turn where the user asked for it — draft it with gmail_create_draft instead and say so.' }, null, 1);
    }
    const { label, ...rest } = (args && typeof args === 'object') ? args : {};
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null) params[k] = v;
    try {
      const r = await google.runGoogleWriteTool(userId, name, params, label ? S(label) : undefined);
      // 32d0ebc8 verification (firing 11): one loop_metrics row per write call —
      // the ok/reason distribution the owner asked for. The refusal reason is
      // recovered from the resolver contract (the envelope's `reason` field is
      // threaded for the same purpose).
      try {
        const reasonMatch = /The Google account .+ was connected without the|Google is not connected|could not be refreshed|No connected Google account matches|WRITE and \d+ Google accounts/.exec(r.text);
        recordLoopMetric({
          kind: LOOP_METRIC_KINDS.GOOGLE_WRITE_TOOL,
          meta: { tool: name, ok: r.ok, ...(r.ok ? {} : { reason: r.reason ?? (reasonMatch ? 'resolution' : 'call_failed') }), ...(r.account ? { account: r.account } : {}) },
        });
      } catch { /* telemetry must never break the tool */ }
      return googleWriteEnvelope(name, r);
    } catch (e: any) {
      // Always resolves to a string — the executor contract every connector keeps.
      return googleWriteEnvelope(name, { ok: false, text: `Google ${name} failed: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }
  // X reads never used the user's X connection (public data — the OAuth token,
  // when attached, only switches x-mcp to the authenticated API path). A null
  // here means the x-mcp CALL itself failed (service/gateway/network) — the
  // legacy notFound('X') misread that as "not connected" and sent CONNECTED
  // users to Settings → Integrations for a platform-side outage (f609ec35).
  // fa956f09: when the read path's health row exists, its recorded reason
  // rides along so the agent knows WHY the read failed and can say so.
  const xReadFailed = async (): Promise<string> => {
    const { getReadHealth } = await import('../integration-health');
    const health = await getReadHealth('x');
    // Self-host setup hardening (2026-10-20): no X_MCP_API_KEY = the x-mcp
    // connector is not wired on this instance — a configuration fact, never a
    // transient outage to retry.
    if (!process.env.X_MCP_API_KEY) {
      return 'X read unavailable — X reads are not configured on this Digby instance (X_MCP_API_KEY is unset, so the x-mcp connector is not wired), which is unrelated to whether the user\'s X account is connected (reads use public data). Retrying will not help: fall back to search_engine with a site:x.com query when web search is available, and tell the user an admin must set up the X integration (Account → Admin → Setup).';
    }
    const base = 'X read unavailable — the x-mcp service call failed (service/gateway/network), which is unrelated to whether the user\'s X account is connected (reads use public data). Retry once; if it persists, fall back to search_engine with a site:x.com query.';
    if (!health || health.status !== 'fail') return base;
    const age = health.lastErrorAt ? Math.round((Date.now() - new Date(health.lastErrorAt).getTime()) / 60000) : null;
    return `${base} Last recorded failure: ${health.lastError ?? 'unknown reason'}${age !== null ? ` (${age} min ago)` : ''}${health.failureCount > 1 ? `, ${health.failureCount} consecutive failures` : ''}.`;
  };
  try {
    switch (name) {
      case 'github_search_code': return (await github.searchCode(userId, S(args.query))) || notFound('GitHub');
      case 'github_get_file_contents': {
        // Read-only file / directory read (fs-code-knowledge 2026-10-22) — the
        // existence check github_search_code's description always pointed at.
        if (githubFileReadToolDisabled()) return 'github_get_file_contents is switched off on this instance.';
        const owner = S(args.owner).trim();
        const repo = S(args.repo).trim().replace(/\.git$/, '');
        const filePath = S(args.path).trim().replace(/^\/+/, '');
        if (!owner || !repo) return 'github_get_file_contents needs owner and repo (e.g. owner "acme", repo "app").';
        const out = await github.getFileContents(userId, owner, repo, filePath, args.ref ? S(args.ref).trim() : undefined);
        if (!out) return notFound('GitHub');
        // A 404 is the answer the incident class turns into "it does not exist" —
        // say it is not proof of absence (review 2026-10-22).
        const absenceNote = githubFileNotFoundNote(out, filePath);
        if (absenceNote) return `${out}\n${absenceNote}`;
        return out.length > GITHUB_FILE_READ_MAX_CHARS
          ? `${out.slice(0, GITHUB_FILE_READ_MAX_CHARS)}\n…[truncated ${out.length - GITHUB_FILE_READ_MAX_CHARS} chars — read a narrower path]`
          : out;
      }
      case 'github_list_issues': return (await github.listIssues(userId, S(args.owner), S(args.repo), args.state ? S(args.state) : undefined)) || notFound('GitHub');
      case 'github_get_issue':   return (await github.getIssue(userId, S(args.owner), S(args.repo), Number(args.number))) || notFound('GitHub');
      case 'github_list_prs':    return (await github.listPullRequests(userId, S(args.owner), S(args.repo), args.state ? S(args.state) : undefined)) || notFound('GitHub');
      case 'gmail_search': {
        const pre = await googleReadPrecheck(userId, args);
        if (pre) return pre;
        return (await google.getGmailMessages(userId, S(args.query), 10))
          || 'No Gmail messages matched that query in any connected account.';
      }
      case 'drive_search': {
        const pre = await googleReadPrecheck(userId, args);
        if (pre) return pre;
        return (await google.listDriveFiles(userId, S(args.query), labelArg(args)))
          || 'No Google Drive files matched that query.';
      }
      case 'slack_search':       return (await slack.searchMessages(userId, S(args.query))) || notFound('Slack');
      case 'asana_search':       return (await asana.searchTasks(userId, S(args.query))) || notFound('Asana');
      case 'gmail_get_message': {
        const pre = await googleReadPrecheck(userId, args);
        if (pre) return pre;
        return (await google.getGmailMessage(userId, S(args.messageId), labelArg(args)))
          || 'No Gmail message with that ID was found — message IDs are account-specific and come from gmail_search results.';
      }
      case 'gmail_get_attachment': {
        const pre = await googleReadPrecheck(userId, args);
        if (pre) return pre;
        // 99145890 Gmail→KB: fetch the RAW envelope ONCE — the agent-facing
        // text is the same transform getGmailAttachment applies, and the raw
        // answer feeds the project auto-ingest hook (below) without a second
        // download.
        const raw = await google.fetchGmailAttachmentRaw(userId, S(args.messageId), S(args.attachmentId), S(args.filename), labelArg(args));
        const out = await google.gmailAttachmentTextFromRaw(raw);
        // Gmail rotates attachmentIds per format=full fetch (tickets 9a818013/a7f6c4e4,
        // 2026-10-01): the server resolves stale-but-valid IDs by downloading directly
        // and stamps 'stale-id-fallback' on the answer. One loop_metrics row per such
        // resolution measures the rotation-hit rate live (kill switch:
        // GMAIL_STALE_ATTACHMENT_ID_FALLBACK_DISABLED=1 disables the fallback itself).
        if (out && out.includes('stale-id-fallback')) {
          try { recordLoopMetric({ kind: LOOP_METRIC_KINDS.GMAIL_STALE_ATTACHMENT_ID, meta: { messageId: S(args.messageId) } }); } catch { /* telemetry never breaks the tool */ }
        }
        // AUTO-INGEST RULE (ticket 99145890): when the run's project has
        // autoIngestGmailAttachments enabled, the attachment just fetched is
        // filed into that project's KB — fire-and-forget (never blocks or
        // fails the tool), dedup-guarded (a re-download is a no-op), reusing
        // the SAME raw fetch. Gated + settings-checked inside
        // autoIngestGmailAttachmentIfEnabled (review F2: never call
        // ingestGmailAttachment directly here). Needs a filename to key on
        // (the dedup key's second half) and an ENVELOPE answer (review F5: a
        // text-like attachment, ok:true envelope:false, has no binary body to
        // file — burning rate slots to learn that is waste). The 'chat'
        // sentinel (ungrouped chats) is guarded inside the callee.
        if (raw.ok && raw.envelope && ctx.projectId && ctx.projectId !== 'chat' && S(args.filename).trim() && !gmailAutoIngestDisabled()) {
          import('../gmail-knowledge.service')
            .then((m) => m.autoIngestGmailAttachmentIfEnabled({
              projectId: String(ctx.projectId), userId,
              messageId: S(args.messageId), filename: S(args.filename).trim(),
              sessionId: ctx.sessionId || undefined,
              label: labelArg(args),
              raw,
            }))
            .catch(() => { /* auto-ingest is best-effort — the tool answer already succeeded */ });
        }
        return out || 'No matching Gmail attachment — verify the messageId/attachmentId from gmail_search or gmail_get_message.';
      }
      case 'calendar_list_events': {
        const pre = await googleReadPrecheck(userId, args);
        if (pre) return pre;
        return (await google.getCalendarEvents(userId, undefined,
          args.daysAhead ? new Date(Date.now() + Number(args.daysAhead) * 86400000).toISOString() : undefined,
          args.maxResults ? Number(args.maxResults) : undefined))
          || 'No calendar events found in that window.';
      }
      case 'drive_get_doc': {
        const pre = await googleReadPrecheck(userId, args);
        if (pre) return pre;
        return (await google.getDocContent(userId, S(args.documentId), labelArg(args)))
          || 'Could not read that Google Doc from any connected account — check the documentId (from drive_search).';
      }
      case 'sheets_get_data': {
        const pre = await googleReadPrecheck(userId, args);
        if (pre) return pre;
        return (await google.getSheetData(userId, S(args.spreadsheetId), args.range ? S(args.range) : undefined, labelArg(args)))
          || 'Could not read that Google Sheet from any connected account — check the spreadsheetId (and A1 range, if given).';
      }
      case 'slack_list_channels':  return (await slack.listChannels(userId)) || notFound('Slack');
      case 'slack_get_channel_history': return (await slack.getChannelHistory(userId, S(args.channel), args.limit ? Number(args.limit) : undefined)) || notFound('Slack');
      case 'discord_list_guilds':  return (await discord.listGuilds(args.limit ? Number(args.limit) : undefined)) || notFound('Discord');
      case 'discord_list_channels': return (await discord.listChannels(S(args.guildId))) || notFound('Discord');
      case 'discord_channel_history': return (await discord.getChannelHistory(S(args.channelId), args.limit ? Number(args.limit) : undefined, args.before ? S(args.before) : undefined)) || notFound('Discord');
      case 'discord_list_dms':     return (await discord.listDms()) || notFound('Discord');
      case 'discord_scrape_channel': return (await discord.scrapeChannel(S(args.channelId), args.maxMessages ? Number(args.maxMessages) : undefined, args.before ? S(args.before) : undefined)) || notFound('Discord');
      case 'asana_list_tasks':     return (await asana.listMyTasks(userId)) || notFound('Asana');
      case 'asana_list_projects':  return (await asana.listProjects(userId)) || notFound('Asana');
      // X reads are app-level (Bright Data) — no user token needed, so no userId.
      case 'x_search':           return (await x.search(S(args.query), userId)) || (await xReadFailed());
      case 'x_get_user_profile': return (await x.getUserProfile(S(args.username), userId)) || (await xReadFailed());
      case 'x_get_trends':       return (await x.getTrends(args.woeid ? S(args.woeid) : undefined, userId)) || (await xReadFailed());
      case 'xero_get_organisation': return (await xero.getOrganisation(userId, args.label ? S(args.label) : undefined)) || notFound('Xero');
      case 'xero_get_contacts':    return (await xero.getContacts(userId, args.search ? S(args.search) : undefined, undefined, args.label ? S(args.label) : undefined)) || notFound('Xero');
      case 'xero_get_invoices':    return (await xero.getInvoices(userId, args.status ? S(args.status) : undefined, undefined, args.label ? S(args.label) : undefined)) || notFound('Xero');
      case 'plaid_get_accounts':   return (await plaid.getAccounts(userId)) || notFound('Plaid');
      case 'plaid_get_balances':   return (await plaid.getBalances(userId)) || notFound('Plaid');
      case 'plaid_get_transactions': return (await plaid.getTransactions(userId, args.days != null ? Number(args.days) : undefined, args.limit != null ? Number(args.limit) : undefined, args.offset != null ? Number(args.offset) : undefined)) || notFound('Plaid');
      case 'imessage_list_chats':
      case 'imessage_get_messages': {
        try {
          // Multi-Mac (2026-09-24): args.device targets a specific Mac by
          // label/name/id; without a target the default Mac serves (single-Mac
          // users see zero change). The result header names the device that ran.
          const selection = await selectAgent(userId, args.device ? String(args.device) : undefined);
          if (!selection.agent) {
            return `iMessage isn't available — ${selection.error || 'no paired Mac is online.'}`;
          }
          const device = agentDisplayName(selection.agent);
          const result = name === 'imessage_list_chats'
            ? await agentBroker.dispatch(selection.agent.id, 'list_chats', { limit: args.limit ? Number(args.limit) : undefined }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS)
            : await agentBroker.dispatch(selection.agent.id, 'get_messages', { chat: S(args.chat), limit: args.limit ? Number(args.limit) : undefined }, IMESSAGE_READ_DISPATCH_TIMEOUT_MS);
          // `?? null` — JSON.stringify(undefined) returns the VALUE undefined (not a
          // string), which would crash the tool-result path upstream (adversarial M1).
          const body = typeof result === 'string' ? result : JSON.stringify(result ?? null);
          return `[device: ${device}] ${body}`;
        } catch (e: any) {
          return `iMessage request failed: ${e.message}`;
        }
      }
      case 'mac_calendar_list_events': {
        try {
          // Mac-agent calendar read (ticket 1ea9a120). LLM-facing name is
          // distinct from the Google 'calendar_list_events' connector, but the
          // AGENT dispatch command is 'calendar_list_events' — the macos-app
          // 0.7.0 command name (schema and executor names are independent).
          //
          // 2026-11-06: the whole read now goes through readAppleCalendar
          // (calendar/apple-calendar.ts) — ONE device policy + ONE classifier
          // shared with the new-chat context prefetch and the home card. The
          // copy comes from appleCalendarStateLine, which states only what was
          // OBSERVED; the old inline branch told the user "a one-time consent
          // dialog was just triggered" for a tier-0 read, a claim nothing
          // verified (the agent's request is asynchronous and its outcome was
          // discarded) and which sent the owner hunting for dialogs that never
          // appeared.
          const read = await readAppleCalendar(userId, {
            device: args.device ? String(args.device) : null,
            days: args.daysAhead != null ? Number(args.daysAhead) : 7,
          });
          const tag = appleCalendarDeviceTag(read);
          if (read.state !== 'ok') {
            return `macOS Calendar isn't available — ${tag ? `${tag} ` : ''}${read.error || appleCalendarStateLine(read.state, read.device || 'your Mac', read.consent)}`;
          }
          const body = JSON.stringify({ events: read.events });
          return tag ? `${tag} ${body}` : body;
        } catch (e: any) {
          return `macOS Calendar request failed: ${e.message}`;
        }
      }
      default: return `Unknown integration tool: ${name}`;
    }
  } catch (e: any) {
    logger.warn(`coding integration ${name} failed: ${e.message}`);
    return `${name} failed: ${e.message}`;
  }
}
