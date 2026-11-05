/**
 * First-class confirmation UX — HTTP surface (backend half).
 *
 *  - POST /chats/:chatId/questions/:questionId { answer } — resolves an
 *    ask_user question a CHAT run is blocked on. Chat runs execute IN THIS
 *    PROCESS (unlike coding runs, which live on the worker tier), so the
 *    pending question sits in this process's question-registry and resolves
 *    directly — no Redis mailbox hop (that transport is the coding endpoint's:
 *    POST /coding/questions/:questionId, unchanged for coding sessions).
 *  - GET  /confirmations/pending — the sidebar indicator poll: one Prisma read
 *    for the user's (non-archived) chats, one MGET over their
 *    `confirm:pending:{chatId}` presence keys (confirm-pending.ts), PLUS the
 *    DB-persisted consequential-tool confirmations (platform/pending-confirmations)
 *    merged in as kind:'confirmation' entries — including recently-expired
 *    unresolved ones, marked expired:true (non-actionable trace, f789d84e).
 *  - POST /confirmations/:confirmationId/confirm — the owner clicked Confirm on
 *    the sidebar card: consumes the staged row (one-shot) and executes the
 *    STORED args server-side (never client-supplied ones).
 *  - POST /confirmations/:confirmationId/cancel — discards a staged action.
 *
 * Auth is app-level (crossmodel.routes.ts mounts behind the single
 * /api/crossmodel `authenticate` guard); ownership is re-checked per request.
 */

import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { readConfirmPendingForChats } from './confirm-pending';
import { extractReceipt, ToolReceipt, WEB_PROBE_RECEIPT_TOOLS_SET } from './coding/run-receipts';
import { recordRunReceiptAsync } from './coding/run-receipts.service';
import {
  getPendingConfirmation,
  listPendingConfirmationsForUser,
  listRecentlyExpiredConfirmationsForUser,
  recordConfirmationResult,
  resolveConfirmationIfMoot,
  resolvePendingConfirmation,
} from './platform/pending-confirmations';
import {
  answerOwnerQuestion,
  dismissOwnerQuestion,
  listOpenOwnerQuestionsForUser,
  resolveOwnerQuestionsForChatAnswer,
} from './platform/owner-questions';

/** One sidebar-poll entry — the Redis presence shape (question|approval), the
 *  DB-persisted staged-action shape (confirmation), and the "Needs owner"
 *  persistent-inbox shape (owner_question). */
type PendingEntry = {
  chatId: string;
  title: string;
  kind: 'question' | 'approval' | 'confirmation' | 'owner_question';
  id: string;
  question: string;
  options: string[];
  tool?: string;
  ts: number;
  expiresAt?: number;
  /** Confirmations only (ticket f789d84e): the staged action LAPSED without a
   *  decision — render as a non-actionable expired trace, never Confirm/Cancel. */
  expired?: boolean;
  /** Confirmations only (ticket 7705fec2): still pending — the card persists
   *  until answered — but PAST the execution-freshness horizon: Confirm would
   *  refuse ("stale — re-stage"); render Dismiss + a re-stage hint instead. */
  stale?: boolean;
  /** Owner questions only (owner 2026-09-18 — "chats say waiting for my
   *  response but my inbox is empty"): the row is in the supervisor's
   *  first-responder window. Rendered as a muted "being answered by your
   *  supervisor" entry the owner CAN pre-empt; it surfaces as a normal
   *  question at `triageUntil` (ms epoch) if still open. */
  triaged?: boolean;
  triageUntil?: number;
};

/**
 * The receipt of an owner-card execution (review 2026-09-25, WI-K follow-up).
 * The ONLY other writer of run_tool_receipts is the agent loop's tool_result
 * seam (coding/agent.ts) — so the dominant confirm path (the owner clicking
 * the sidebar / Management card) used to execute the staged pause/stop/send
 * with NO row, leaving the staged ok:false {staged:true} row as the last word
 * and telling every later reader the call was still parked. Now the card
 * execution mints the same receipt the loop would have: ok per the tool's
 * own envelope (a thrown execution = ok:false), runId null (no run owns it),
 * ids.confirmationId = the card, ids.ownerConfirmed:true — so get_run_receipts
 * pairs the staged row with its execution and follow-through / cross-wake
 * exoneration see owner-confirmed actions. Fire-and-forget, never throws;
 * skipped for anon- chats (no crossmodel_chats row to FK).
 *
 * INVARIANT — the web-probe receipt class is COLLECTOR-ONLY (WP-3, backlog
 * 2026-11-03 / review 66007a6e advisory A5). `extractReceipt` admits
 * `WEB_PROBE_RECEIPT_TOOLS_SET` (scrape_as_markdown, scrape_batch,
 * search_engine, web_pipe, youtube_pipe), and the agent seam deliberately
 * SKIPS recordRunReceiptAsync for that set (agent.ts:6262-6270): web tools are
 * the hottest tool class fleet-wide, its receipt is gate evidence for
 * observe_resource — never claim evidence — and keeping it out of
 * run_tool_receipts leaves every DB-reading pool untouched by construction.
 * This function is the ONE other writer, so it must uphold the same skip or a
 * hypothetical future stageable web tool would silently start writing rows
 * from the card path and break that invariant. UNREACHABLE TODAY (web tools
 * execute read-only through the ToolCache with no confirmation gate) — this is
 * a seam guard, not a live hole. If the platform ever makes a web tool
 * confirmation-staged, decide DELIBERATELY: keep the skip, or widen the
 * invariant in run-receipts.ts + agent.ts together — never let the two writers
 * drift.
 */
function recordConfirmedCardReceipt(row: { id: string; chatId: string; tool: string; args: unknown }, resultText: string): void {
  try {
    if (!row.chatId || row.chatId.startsWith('anon-') || row.chatId.startsWith('chatless-')) return;
    if (WEB_PROBE_RECEIPT_TOOLS_SET.has(row.tool)) return; // WP-3 collector-only invariant
    const draft = extractReceipt(row.tool, row.args, resultText, new Date());
    if (!draft) return;
    const receipt: ToolReceipt = {
      ...draft,
      id: randomUUID(),
      chatId: row.chatId,
      runId: null,
      ids: { ...draft.ids, confirmationId: row.id, ownerConfirmed: true },
    };
    recordRunReceiptAsync(receipt);
  } catch (err: any) {
    logger.warn(`confirmations: card receipt for ${row.tool} (${row.id}) not recorded: ${err?.message}`);
  }
}

class ConfirmationsController {
  /** POST /chats/:chatId/questions/:questionId { answer } — resolve a chat ask_user. */
  async postChatQuestion(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      const { chatId, questionId } = req.params;
      const answer = typeof req.body?.answer === 'string' ? req.body.answer : '';
      if (!answer.trim()) return res.status(400).json({ error: 'answer is required' });
      // Ownership: only the user who owns the question's chat may answer it
      // (question ids are semi-guessable; every other endpoint scopes by userId).
      const chat = await prisma.crossModelChat.findFirst({ where: { id: chatId, userId }, select: { id: true } });
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
      // Decision-card coherence (ticket 992c8374): capture the asked question's
      // TEXT before resolving — the resolve clears the confirm-pending presence
      // key. The text drives the auto-resolve of the matching flagged
      // owner-question below (a decision answered on the card must also close
      // the flag, or the fleet-attention block re-lists it forever).
      let askedQuestion = '';
      try {
        const entry = (await readConfirmPendingForChats([chatId])).get(chatId);
        if (entry?.kind === 'question' && entry.id === questionId) askedQuestion = entry.question;
      } catch { /* best-effort — the resolve below is authoritative */ }
      // Lazy import — the coding module graph is heavy + cycle-prone (the same
      // dynamic-import pattern crossmodel.controller/crossmodel.routes use).
      const { questionSession, resolveAnswer } = await import('./coding/question-registry');
      // The registry keys the wait on the run's sessionId — for a chat run that
      // IS the chat id (chat-agent runSessionId). Fast path: the run lives in
      // THIS process — resolve directly.
      if (questionSession(questionId) === chatId) {
        if (!resolveAnswer(questionId, answer.slice(0, 8000))) {
          return res.json({ success: false, error: 'unknown_or_expired' });
        }
        await resolveOwnerQuestionsForChatAnswer({ chatId, userId, askedQuestion, answer: answer.slice(0, 8000) });
        return res.json({ success: true });
      }
      // Cross-instance path (2026-08-16): detached chat runs execute on
      // whichever web instance received POST /stream, but this answer can land
      // on the peer instance (~50% behind the ALB) — the local registry is
      // empty there while the question is genuinely live. Same shape as the
      // coding endpoint (coding-stream.controller.postQuestion): consult the
      // Redis pending key the run's awaitAnswer published, then RPUSH the
      // resolution mailbox that the run's heartbeat drains. Ownership was
      // already proven by the chat lookup above; the pending key must agree.
      const { getQuestionPendingSession, publishQuestionResolution } = await import('./coding/session-run-lock');
      const pendingSession = await getQuestionPendingSession(questionId);
      if (pendingSession !== chatId) {
        return res.json({ success: false, error: 'unknown_or_expired' });
      }
      await publishQuestionResolution(chatId, questionId, answer.slice(0, 8000));
      await resolveOwnerQuestionsForChatAnswer({ chatId, userId, askedQuestion, answer: answer.slice(0, 8000) });
      return res.json({ success: true });
    } catch (err: any) {
      logger.error(`confirmations: postChatQuestion failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * GET /confirmations/pending — every chat of the requesting user currently
   * blocked on a human, for the sidebar indicator. Lightweight by design
   * (polled every ~20s): one Prisma read + one MGET, all best-effort.
   */
  async getPendingConfirmations(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      // Archived chats never ping the sidebar indicator: the chat-level
      // archivedAt stamp (owner 2026-09-08) plus the pre-existing
      // coding-satellite 'archived' status (reaper-parked sessions).
      const chats = await prisma.crossModelChat.findMany({
        where: { userId, archivedAt: null, NOT: { codingState: { status: 'archived' } } },
        select: { id: true, title: true },
      }).catch(() => [] as Array<{ id: string; title: string }>);
      const entries = await readConfirmPendingForChats(chats.map(c => c.id));
      const pending: PendingEntry[] = chats
        .filter(c => entries.has(c.id))
        .map(c => ({ chatId: c.id, title: c.title, ...entries.get(c.id)! }));
      // DB-persisted consequential-tool confirmations (platform-tools gate):
      // durable across deploys, confirmed inline from the sidebar card. A chat
      // can carry BOTH a Redis presence entry and staged actions — both render.
      // Persistent until answered (ticket 7705fec2): the listing has no time
      // cutoff — a row past the execution-freshness horizon still appears,
      // marked stale (Confirm would refuse; the card offers Dismiss instead).
      const staged = await listPendingConfirmationsForUser(userId).catch(() => []);
      const titleById = new Map(chats.map(c => [c.id, c.title] as const));
      for (const row of staged) {
        const stale = row.expiresAt.getTime() <= Date.now();
        pending.push({
          chatId: row.chatId,
          title: titleById.get(row.chatId) ?? 'Chat',
          kind: 'confirmation',
          id: row.id,
          question: row.summary,
          options: stale ? ['Dismiss'] : ['Confirm', 'Cancel'],
          tool: row.tool,
          ts: row.createdAt.getTime(),
          expiresAt: row.expiresAt.getTime(),
          ...(stale ? { stale: true } : {}),
          // Cohesive chat (2026-09-28): who staged it (pending_confirmations
          // .origin) — informational for the client; every staged card renders
          // and needs its click. Legacy rows (NULL origin) carry no flag.
          ...(row.origin === 'machine' ? { machine: true } : row.origin === 'user' ? { machine: false } : {}),
        });
      }
      // Expired-recently trace (ticket f789d84e): staged actions that lapsed
      // without a decision stay visible (marked, non-actionable) for a short
      // window instead of vanishing silently while the agent still cites them.
      const lapsed = await listRecentlyExpiredConfirmationsForUser(userId).catch(() => []);
      for (const row of lapsed) {
        pending.push({
          chatId: row.chatId,
          title: titleById.get(row.chatId) ?? 'Chat',
          kind: 'confirmation',
          id: row.id,
          question: row.summary,
          options: [],
          tool: row.tool,
          ts: row.createdAt.getTime(),
          expiresAt: row.expiresAt.getTime(),
          expired: true,
        });
      }
      // "Needs owner" persistent inbox (ticket 7705fec2): questions an agent
      // run flagged with flag_owner_question. They NEVER expire, so they
      // persist in the sidebar rail + Management inbox until answered or
      // dismissed via the /owner-questions endpoints.
      // Review 2026-09-13 issue 11: supervisor-first triage — rows still in
      // the supervisor's triage window used to be HIDDEN here (they reached
      // the rail only when the SLA elapsed unanswered). Owner 2026-09-18: lanes
      // kept writing "waiting for the owner" about those rows while the inbox
      // showed nothing, so the owner could not tell a real wait from a lane's
      // wording. They are listed WITH `triaged: true` + `triageUntil` now — the
      // UI renders them as a muted "being answered by your supervisor" block
      // (still answerable to pre-empt) and keeps them out of the needs-you count.
      const ownerQuestions = await listOpenOwnerQuestionsForUser(userId, { includeTriaged: true }).catch(() => []);
      // Typed options (remediation P2 N3): rendered as numbered quick-pick
      // buttons on the card — the clicked label posts through the normal
      // answer endpoint, where matchAnswerToOption stamps chosenOption.
      // Tolerant seam: suites partially mock owner-questions, so a missing
      // parseStoredOptions degrades to "no options", never a 500.
      const oqMod = await import('./platform/owner-questions').catch(() => null as any);
      const parseOptions: (raw: unknown) => Array<{ id: string; label: string; consequence?: string }> =
        typeof oqMod?.parseStoredOptions === 'function' ? oqMod.parseStoredOptions : () => [];
      // Cost-of-delay + default-answer lines (P7 S2b) — same tolerant seam.
      const costOfDelay: (q: any) => string =
        typeof oqMod?.renderCostOfDelay === 'function' ? oqMod.renderCostOfDelay : () => '';
      // Ticket 26786762: delivered-credential previews (masked, owner-scoped)
      // so the card can render a Reveal/Copy affordance per secret. Tolerant
      // seam — a missing module or table hides the affordance, never errors.
      const oqSecrets: any = await import('./platform/owner-question-secrets').catch(() => null as any);
      const secretPreviewsFor = async (q: any): Promise<Array<{ ordinal: number; label: string; preview: string }>> => {
        if (!oqSecrets || typeof oqSecrets.listQuestionSecretPreviews !== 'function') return [];
        try { return await oqSecrets.listQuestionSecretPreviews(prisma, userId, q.id); } catch { return []; }
      };
      for (const row of ownerQuestions) {
        const typedOptions = parseOptions((row as any).options);
        const delayBlock = costOfDelay(row as any); // '' unless the flagger set idleUsdPerDay / a default pair
        // Todo 77c88942 item 2: a credential gate tells the card the ask shape —
        // answer text can never resolve it; the key must land via the card's key
        // field, store_secret or the Account UI (ticket 238c9e2a — the same
        // three channels the backend gate lifts on).
        const needsCredential = String((row as any).expectedAnswerType ?? '').startsWith('credential');
        // Ticket 1b1c41bc: a console-action card — the UI renders it fully
        // expanded (the payload must be visible + copyable, never collapsed).
        // Tolerant seam like parseOptions above.
        const isConsoleAction =
          typeof oqMod?.parseStoredConsoleAction === 'function' && !!oqMod.parseStoredConsoleAction((row as any).consoleAction);
        // Ticket 26786762: the masked previews of delivered credentials.
        const secretPreviews = await secretPreviewsFor(row);
        pending.push({
          chatId: row.chatId,
          title: titleById.get(row.chatId) ?? 'Chat',
          kind: 'owner_question',
          id: row.id,
          question: (typedOptions.length
            ? `${row.question}\n${typedOptions.map((o, i) => `${i + 1}. ${o.label}${o.consequence ? ` — ${o.consequence}` : ''}`).join('\n')}`
            : row.question) + delayBlock,
          options: typedOptions.map((o) => o.label),
          ts: row.createdAt.getTime(),
          ...(needsCredential ? { needsCredential: true } : {}),
          ...(isConsoleAction ? { consoleAction: true } : {}),
          // 2026-10-20: the flagger's context (what it tried, the policy /
          // steps the owner needs) was never owner-visible — the card and the
          // Telegram DM carried the question alone, so "the read-only policy
          // I sent" could sit in context unseen while the owner replied "i
          // never got the json policy". Scrubbed at flag time
          // (redactInboundSecrets + echoScrub), clipped to the flag-time cap.
          ...(typeof (row as any).context === 'string' && String((row as any).context).trim()
            ? { context: String((row as any).context).slice(0, 4000) } : {}),
          // Ticket f3a69ed3 (defect 1): a recorded owner reply on this OPEN
          // card — the owner's words + the one-line reason they did not
          // resolve + where they went — rendered back ON the card instead of
          // bouncing to a toast. Same tolerant seam as parseOptions above.
          ...(() => {
            const rec = typeof oqMod?.parseOwnerRecordedReply === 'function' && row.status === 'open' && (row as any).answer
              ? oqMod.parseOwnerRecordedReply((row as any).answer)
              : null;
            if (!rec) return {};
            return {
              recordedReply: {
                text: rec.text.slice(0, 1000),
                receivedAt: rec.receivedAt || null,
                reason: rec.reason,
                delivered: rec.woken
                  ? 'sent into the asking chat and the agent was woken with it'
                  : 'sent into the asking chat as context',
                ...(rec.legacy ? { legacy: true } : {}),
              },
            };
          })(),
          ...((typeof oqMod?.parseReplacedReplyFold === 'function' && oqMod.parseReplacedReplyFold(row.question))
            ? { priorReplyFold: oqMod.parseReplacedReplyFold(row.question) } : {}), ...(secretPreviews.length ? { secrets: secretPreviews } : {}),
          ...((row as any).triaged === true
            ? { triaged: true, ...((row as any).triageUntil ? { triageUntil: new Date((row as any).triageUntil).getTime() } : {}) }
            : {}),
        });
      }
      return res.json({ pending });
    } catch (err: any) {
      logger.error(`confirmations: getPendingConfirmations failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /confirmations/:confirmationId/confirm — execute a staged action the
   * OWNER clicked Confirm on. The consumed DB row IS the confirmation (the
   * user-turn anchor's UI equivalent: only the authenticated owner can reach
   * this, and the one-shot status flip lands before dispatch so a double-click
   * or a simultaneous model re-call can never execute the action twice).
   * Executes the STORED args — the client supplies nothing but the id.
   */
  async postConfirmationConfirm(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      const id = String(req.params.confirmationId || '');
      const row = await getPendingConfirmation(id);
      if (!row || row.userId !== userId) return res.status(404).json({ error: 'Confirmation not found' });
      if (row.status !== 'pending') return res.json({ success: false, error: 'already_resolved' });
      if (row.expiresAt.getTime() <= Date.now()) {
        // Stale-action safety (ticket 7705fec2): the card persisted until the
        // owner acted, but the staged args are past the execution-freshness
        // horizon — refuse to fire them, flip the row so it leaves WITH an
        // outcome, and let the client say "re-stage it in the chat".
        await resolvePendingConfirmation(id, 'expired');
        return res.json({ success: false, error: 'expired' });
      }
      // Moot auto-resolve (ticket 3ce5f6d0 case A): the requested end state
      // already holds (e.g. the schedule disabled itself) — resolve WITH a
      // receipt; an owner click on a moot card never executes a no-op.
      const mootReason = await resolveConfirmationIfMoot(row as any).catch(() => null);
      if (mootReason) return res.json({ success: false, error: 'moot', reason: mootReason });
      if (!(await resolvePendingConfirmation(id, 'consumed'))) {
        return res.json({ success: false, error: 'already_resolved' }); // lost a race with another surface
      }
      try {
        // Lazy import — the platform-tools graph is heavy + cycle-prone (the
        // same dynamic-import pattern this controller uses for question-registry).
        const { executeConfirmedPlatformTool } = await import('./platform/platform-tools');
        const out = await executeConfirmedPlatformTool(
          // ownerBrowser: this execution answers the OWNER's click — the one
          // surface a minted secret (create_chat_webhook) may be shown on.
          { userId, sessionId: row.chatId, userTurnAt: new Date(), ownerBrowser: true } as any,
          row.tool,
          row.args,
        );
        await recordConfirmationResult(id, { output: out.slice(0, 4000) });
        // The execution's receipt (review 2026-09-25): the card path is the
        // dominant confirm path and used to leave no row — see
        // recordConfirmedCardReceipt.
        recordConfirmedCardReceipt(row, out);
        return res.json({ success: true, result: out.slice(0, 2000) });
      } catch (execErr: any) {
        await recordConfirmationResult(id, { error: execErr.message }, true);
        // A thrown execution is an ok:false receipt (the tools.ts catch-all
        // prose shape parseResult already treats as not-executed).
        recordConfirmedCardReceipt(row, `Tool ${row.tool} failed: ${String(execErr?.message ?? execErr)}`);
        return res.json({ success: false, error: execErr.message });
      }
    } catch (err: any) {
      logger.error(`confirmations: postConfirmationConfirm failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /** POST /confirmations/:confirmationId/cancel — discard a staged action. */
  async postConfirmationCancel(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      const id = String(req.params.confirmationId || '');
      const row = await getPendingConfirmation(id);
      if (!row || row.userId !== userId) return res.status(404).json({ error: 'Confirmation not found' });
      if (!(await resolvePendingConfirmation(id, 'cancelled'))) {
        return res.json({ success: false, error: 'already_resolved' });
      }
      return res.json({ success: true });
    } catch (err: any) {
      logger.error(`confirmations: postConfirmationCancel failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /owner-questions/:id/answer { answer } — the owner answered a flagged
   * "Needs owner" question (ticket 7705fec2). Ownership-scoped; the service
   * flips open → answered and posts the answer back into the originating
   * chat's transcript (best-effort) so the agent sees it next turn.
   */
  async postOwnerQuestionAnswer(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      const id = String(req.params.id || '');
      const answer = typeof req.body?.answer === 'string' ? req.body.answer : '';
      if (!answer.trim()) return res.status(400).json({ error: 'answer is required' });
      // Ticket ad4fae90: the card's dedicated secret input sets credentialPaste —
      // the owner's explicit "this text IS the key" intent, honored by the vault
      // leg without shape guessing. Only an authenticated owner request can set
      // it (this route IS the owner surface), and the service only honors it on
      // a credential-gated row.
      const credentialPaste = req.body?.credentialPaste === true;
      const r = await answerOwnerQuestion(id, userId, answer, { credentialPaste });
      if (r === 'not_found') return res.status(404).json({ error: 'Question not found' });
      // Todo 77c88942 item 2: a credential gate refused the text answer — the
      // row stays OPEN and the reply is recorded as a counter-question. Tell
      // the card the truth (ticket 238c9e2a: the gate opens only when the key
      // is stored — the card's key field, store_secret or the Account UI)
      // instead of the misleading blanket not_open.
      if (r === 'credential_pending') return res.json({ success: false, error: 'credential_pending', message: 'This question needs a credential — the reply was recorded, but the gate opens only when the key is stored (the card\'s key field, store_secret or Account → Coding credentials), never from answer text. The question stays open.' });
      // Todo 0dd7d3f2: a choice/yes_no gate got text that doesn't match an
      // option — the reply WAS delivered to the asking chat as conversation;
      // only the card resolution is refused. The old code conflated this with
      // credential_pending, so the Inbox showed the credential banner on
      // non-credential cards (specimen oq_17b85b72) and the owner's draft
      // never cleared.
      // 2026-10-20: the credential branch answers reply_recorded too when the
      // owner typed WORDS (not the key) — the asking lane is woken to answer on
      // the card; the gate still needs the key through the key field.
      if (r === 'reply_recorded') return res.json({ success: false, error: 'reply_recorded', message: 'Sent to the chat as a reply — the asking chat is being woken with it (ticket c1714329): the reply is delivered and the lane acts on any instruction in your words, even though the card stays open until it gets the answer shape it declared: an option pick, a yes/no ruling, or the key through the key field, which you can do right on the card.' });
      // Ticket ad4fae90 / post-merge review F-A: the paste resolved the question
      // (the gate lifted — possibly from a PRE-EXISTING credential) but this
      // answer stored NOTHING (preset-managed key, size limit, kill switch).
      // success:true clears the card; pasteRefused:true makes the toast honest
      // so the owner knows the vault kept the old value.
      if (r === 'ok_paste_refused') return res.json({ success: true, pasteRefused: true, message: 'The question was resolved, but the pasted value was NOT stored — the vault refused it (the key may be managed by an Account preset, over the size limit, or vaulting is disabled). A previously stored key still governs; to replace it use Account → Coding → Credentials.' });
      if (r !== 'ok') return res.json({ success: false, error: 'not_open' });
      return res.json({ success: true });
    } catch (err: any) {
      logger.error(`confirmations: postOwnerQuestionAnswer failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /** POST /owner-questions/:id/dismiss — "stop raising this" (ticket 7705fec2). */
  async postOwnerQuestionDismiss(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      const id = String(req.params.id || '');
      const r = await dismissOwnerQuestion(id, userId);
      if (r === 'not_found') return res.status(404).json({ error: 'Question not found' });
      if (r !== 'ok') return res.json({ success: false, error: 'not_open' });
      return res.json({ success: true });
    } catch (err: any) {
      logger.error(`confirmations: postOwnerQuestionDismiss failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }

  /**
   * POST /owner-questions/:id/secrets/:ordinal/reveal — ticket 26786762: the
   * owner reveals ONE credential a card delivered. Owner-scoped by (id,
   * userId, ordinal): a row filed for another owner never resolves, and no
   * agent surface calls this (REST + authenticate only). 200 {value} on
   * success; 404 not_found (wrong owner / wrong ordinal / no such row);
   * 200 {error:'unreadable'} when the stored value no longer decrypts
   * (JWT_SECRET rotated since delivery — the card text still stands).
   */
  async postOwnerQuestionSecretReveal(req: Request, res: Response) {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'Authentication required' });
      const id = String(req.params.id || '');
      const ordinal = parseInt(String(req.params.ordinal || ''), 10);
      if (!Number.isFinite(ordinal) || ordinal < 1) return res.status(400).json({ error: 'Bad ordinal' });
      const oqSecrets: any = await import('./platform/owner-question-secrets').catch(() => null as any);
      if (!oqSecrets || typeof oqSecrets.revealQuestionSecret !== 'function') {
        return res.status(404).json({ error: 'Not found' });
      }
      const r = await oqSecrets.revealQuestionSecret(prisma, userId, id, ordinal);
      if (!r.ok) {
        if (r.reason === 'unreadable') return res.json({ error: 'unreadable' });
        return res.status(404).json({ error: 'Not found' });
      }
      // The response body IS the credential — never let a shared cache or
      // intermediate store it (review advisory 6).
      res.set('Cache-Control', 'no-store');
      return res.json({ ordinal: r.ordinal, label: r.label, value: r.value });
    } catch (err: any) {
      logger.error(`confirmations: postOwnerQuestionSecretReveal failed: ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
}

const confirmationsController = new ConfirmationsController();
export default confirmationsController;
