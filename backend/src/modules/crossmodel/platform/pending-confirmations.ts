/**
 * Platform unification (security hardening) — USER-TURN-ANCHORED confirmations
 * for CONSEQUENTIAL platform tools.
 *
 * Chat-profile runs execute with permissionMode 'auto' (the agent browses the
 * web, reads Gmail, etc. — all prompt-injection surfaces). The ask-mode approval
 * registry (coding/approval-registry.ts) only gates 'ask' runs, so an injected
 * instruction could silently fire mutating platform tools — worst case a
 * RECURRING schedule_message, a persistence primitive executing as the user
 * indefinitely. This registry is the deterministic choke point: the
 * consequential tools (schedule_message / cancel_schedule / send_chat_message /
 * start_coding_session) NEVER execute on their first in-loop call. Instead the
 * call registers a pending confirmation here and the model must ask the user in
 * natural language; the tool executes only when re-called with the
 * confirmationId from a LATER, REAL user turn:
 *
 *   confirm ⇔ pending exists AND status='pending' AND not expired AND
 *   pending.createdAt < ctx.userTurnAt — the timestamp of the USER MESSAGE
 *   that triggered the current run.
 *
 * An injected turn can REGISTER a pending but can never CONFIRM it: its run's
 * userTurnAt is the message that started the run (≤ the pending's createdAt),
 * and machine-triggered runs (schedule firings, auto-resumes) carry NO
 * userTurnAt at all (fail-closed). Confirmation therefore always requires a
 * NEW real user message after registration — never just agent output.
 *
 * STAGED-ARGS EXECUTION (WYSIWYG confirm): the registry stores the exact
 * arguments from the registration call, and a successful confirm executes
 * THOSE — the re-call's own arguments are ignored. The user always confirms
 * precisely what the deterministic summary showed, confirm-then-swap is
 * structurally impossible (there is no model-supplied args channel on the
 * confirm path at all), and the model never has to retype long arguments it
 * can no longer see (plain-chat history carries role+content only — the
 * original tool result with the full args evaporates between turns).
 *
 * DB-PERSISTED (pending_confirmations table): the store is Postgres, not a
 * process-local Map — a staged action survives deploys/restarts and is visible
 * to BOTH tiers (web chat runs + worker coding runs stage; web REST endpoints
 * resolve). Two confirmation surfaces:
 *   1. model re-call with confirmationId from a NEW user turn (this module's
 *      consume path — anchor semantics above, unchanged), and
 *   2. the owner clicking Confirm/Cancel on the sidebar card
 *      (GET /confirmations/pending merges these rows; POST /confirmations/:id/
 *      confirm executes the STORED args — never client-supplied ones — after an
 *      ownership check; the row's one-shot status flip makes double-clicks and
 *      cross-surface races safe).
 *
 * PERSISTENT UNTIL ANSWERED (ticket 7705fec2 — "owner decisions aren't
 * persistent until they are answered makes no sense"): a pending row never
 * leaves the owner's listing on a timer — it stays visible and dismissible
 * until the owner confirms or cancels it (or the model completes it from a
 * new user turn). expiresAt is therefore NOT a visibility TTL; it is the
 * EXECUTION-FRESHNESS horizon (CONFIRMATION_TTL_MS, 7 days): a confirm inside
 * the horizon executes the staged args; past it, both execute paths (model
 * consume + REST confirm) REFUSE and flip the row to 'expired' with an
 * explicit "stale — re-stage" outcome, so an ancient staged mutation can
 * never fire silently — the owner sees WHY it did not run and can ask the
 * chat to re-stage it. (History: entries were 14 min when the store was
 * process-local, then 24h once Postgres-backed; the 24h death still vanished
 * cards before the owner ever saw them — the exact FW29 complaint.)
 */

import { randomUUID } from 'crypto';
import { stripAgentSendHeader } from './agent-send-header';

/** EXECUTION-freshness horizon, NOT a visibility TTL (see the module header):
 *  pending rows stay listed until answered; only EXECUTION is bounded. */
export const CONFIRMATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Lazy prisma: a static import would pull config/database → config/env
// (process.exit at import when env vars are missing) into EVERY jest graph that
// reaches platform-tools.ts. The dynamic import keeps this module's import-time
// graph clean and is still intercepted by jest.mock (the fleet suites' pattern).
type Prisma = typeof import('../../../config/database').default;
let _db: Prisma | null = null;
async function db(): Promise<Prisma> {
  if (!_db) _db = (await import('../../../config/database')).default;
  return _db;
}

/** Register a pending confirmation; returns the id the model must round-trip. */
export async function registerPendingConfirmation(input: {
  sessionId: string;
  userId: string;
  tool: string;
  args: any;
  summary: string;
  /** Who staged it (cohesive chat, 2026-09-28): 'user' = a real human turn
   *  (user anchor AND not machineTriggered — platform-tools stamps it with the
   *  work-tools human-turn predicate), 'machine' = a schedule / hook / agent
   *  wake. The pending listing exposes it as `machine` — INFORMATIONAL: a
   *  staged card always renders and needs its click; requested work on a
   *  human turn is never staged in the first place. Omitted ⇒ NULL (legacy). */
  origin?: 'user' | 'machine';
}): Promise<{ confirmationId: string; summary: string; expiresInMinutes: number; expiresAt: number }> {
  const confirmationId = `cf_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  // Snapshot the args NOW (deep clone — the same object keeps flowing through
  // the registering turn's agent loop and must not be mutated under us).
  // Tool args arrive JSON-parsed, so structuredClone cannot fail; the JSON
  // fallback also strips any non-JSON values defensively.
  let stagedArgs: any;
  try {
    stagedArgs = structuredClone(input.args ?? {});
  } catch {
    stagedArgs = JSON.parse(JSON.stringify(input.args ?? {}));
  }
  await (await db()).pendingConfirmation.create({
    data: {
      id: confirmationId,
      chatId: input.sessionId,
      userId: input.userId,
      tool: input.tool,
      args: stagedArgs,
      summary: input.summary,
      expiresAt,
      ...(input.origin ? { origin: input.origin } : {}),
    },
  });
  return {
    confirmationId,
    summary: input.summary,
    expiresInMinutes: CONFIRMATION_TTL_MS / 60_000,
    expiresAt: expiresAt.getTime(),
  };
}

export type ConfirmationCheck =
  | { ok: true; args: any }
  | { ok: false; reason: 'unknown' | 'wrong_session' | 'no_user_turn' | 'same_turn' }
  // The staged action's requested end state already holds (ticket 3ce5f6d0 —
  // moot auto-resolve): nothing to confirm or execute; `detail` says why.
  | { ok: false; reason: 'moot'; detail: string };

/**
 * Consume (one-shot) a pending confirmation for execution. Every check must
 * pass; ANY failure denies (the pending stays registered unless it matched
 * fully — a failed re-call never burns the pending, the user can still
 * confirm the original). On success the STAGED registration-time arguments
 * are returned — the caller executes those, never the re-call's own args
 * (WYSIWYG confirm; see the module header). The final status flip is a
 * conditional UPDATE … WHERE status='pending', so exactly ONE consumer wins
 * even across processes (web + worker) — a deploy no longer strands a staged
 * action, and a double-confirm can never execute twice.
 */
export async function consumePendingConfirmation(input: {
  confirmationId: string;
  sessionId: string;
  tool: string;
  /** Timestamp of the USER MESSAGE that triggered the CURRENT run; undefined for
   *  machine-triggered runs (schedule firings, auto-resumes) — fail-closed. */
  userTurnAt?: Date;
}): Promise<ConfirmationCheck> {
  const prisma = await db();
  const p = await prisma.pendingConfirmation.findUnique({ where: { id: input.confirmationId } });
  if (!p || p.status !== 'pending') return { ok: false, reason: 'unknown' }; // never registered, resolved, or expired-consumed
  // Moot auto-resolve (ticket 3ce5f6d0 case A — checked on every resolution
  // path): the requested end state already holds, so there is nothing to
  // confirm — resolve WITH a receipt and tell the lane why (it sees 'moot').
  const moot = await resolveConfirmationIfMoot(p as any);
  if (moot) return { ok: false, reason: 'moot', detail: moot };
  if (p.expiresAt.getTime() <= Date.now()) {
    // Stale-action safety: past the execution-freshness horizon the staged
    // args must never fire — flip once (lazily, no sweeper) so the card leaves
    // the pending listing WITH an outcome, and the model is told to re-stage.
    await prisma.pendingConfirmation.updateMany({
      where: { id: p.id, status: 'pending' },
      data: { status: 'expired', resolvedAt: new Date(Date.now()) },
    });
    return { ok: false, reason: 'unknown' };
  }
  if (p.chatId !== input.sessionId || p.tool !== input.tool) return { ok: false, reason: 'wrong_session' };
  if (!input.userTurnAt) return { ok: false, reason: 'no_user_turn' };
  if (p.createdAt.getTime() >= input.userTurnAt.getTime()) return { ok: false, reason: 'same_turn' };
  const flip = await prisma.pendingConfirmation.updateMany({
    where: { id: p.id, status: 'pending' },
    data: { status: 'consumed', resolvedAt: new Date(Date.now()) },
  });
  if (flip.count === 0) return { ok: false, reason: 'unknown' }; // lost a cross-surface race — already resolved
  return { ok: true, args: p.args };
}

/**
 * Sidebar/Management poll: EVERY still-pending staged action of the owner,
 * newest first — deliberately NO expiresAt cutoff (ticket 7705fec2): an
 * unanswered owner decision stays listed until the owner acts on it. Rows past
 * the freshness horizon are still returned (the caller may mark them stale —
 * Confirm on one refuses with the explicit stale outcome; Cancel dismisses).
 */
export async function listPendingConfirmationsForUser(userId: string) {
  // Listing-time moot sweep (ticket 3ce5f6d0 case A — "run the check at
  // listing time"): a staged action whose requested end state already holds
  // resolves as 'moot' WITH a receipt instead of sitting in the owner's inbox
  // for hours (cf_10407: a cancel card for an already-disabled schedule).
  await resolveMootConfirmationsForUser(userId).catch(() => 0);
  return (await db()).pendingConfirmation.findMany({
    where: { userId, status: 'pending' },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

/** How long an expired-unresolved card stays visible in the sidebar listing. */
export const EXPIRED_LISTING_WINDOW_MS = 30 * 60 * 1000;

/**
 * Sidebar poll companion (ticket f789d84e — expired confirm cards leave no
 * trace): staged actions that LAPSED to 'expired' without a resolution in the
 * last EXPIRED_LISTING_WINDOW_MS. Since ticket 7705fec2 a still-'pending' row
 * past expiresAt is a LIVE (stale) card in the pending listing — never a
 * trace here — so only rows the execute paths flipped to 'expired' appear.
 * Resolved rows (consumed/cancelled/failed) never appear: they left WITH an
 * outcome.
 */
export async function listRecentlyExpiredConfirmationsForUser(userId: string) {
  const now = Date.now();
  return (await db()).pendingConfirmation.findMany({
    where: {
      userId,
      status: 'expired',
      expiresAt: { lte: new Date(now), gt: new Date(now - EXPIRED_LISTING_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
}

/** REST confirm/cancel lookup (ownership re-checked by the caller). */
export async function getPendingConfirmation(id: string) {
  return (await db()).pendingConfirmation.findUnique({ where: { id } });
}

/**
 * Conditional pending → next flip (one-shot). Returns false when the row was
 * already resolved or absent — the caller reports already_resolved.
 */
export async function resolvePendingConfirmation(
  id: string,
  next: 'consumed' | 'cancelled' | 'expired' | 'failed' | 'moot',
  result?: any,
): Promise<boolean> {
  const r = await (await db()).pendingConfirmation.updateMany({
    where: { id, status: 'pending' },
    data: { status: next, resolvedAt: new Date(Date.now()), ...(result !== undefined ? { result } : {}) },
  });
  return r.count > 0;
}

/** Record the execution outcome on an ALREADY-consumed row (REST confirm path). */
export async function recordConfirmationResult(id: string, result: any, failed = false): Promise<void> {
  await (await db()).pendingConfirmation.updateMany({
    where: { id },
    data: failed ? { status: 'failed', result } : { result },
  });
}

/* ── Moot auto-resolve (ticket 3ce5f6d0 case A) ─────────────────────────────
 * Owner-inbox noise (2026-09-10): cf_10407 staged cancel_schedule for a
 * once-kind backstop that FIRED (and self-disabled at 15:02Z) while the card
 * awaited the owner — the card then sat 4h asking to confirm a cancel of a
 * schedule that no longer existed as enabled. A pending confirmation whose
 * target is ALREADY in the requested end state auto-resolves as 'moot' WITH a
 * receipt (the result json + a transcript note to the staging lane), checked
 * at listing time (listPendingConfirmationsForUser), in the consume path (the
 * model re-call sees a 'moot' result), and on the REST confirm path (an owner
 * click on a moot card never executes).
 * Per-tool end-state checkers: ONLY a tool with a deterministic checker can
 * resolve moot; every other tool returns null and is never auto-resolved.
 * Any read failure fails OPEN to null (a missed moot keeps the card — a
 * wrongly-mooted card would silently drop an owner decision).
 *
 * Checker set (ticket ba41858d — the 2026-08-11 16:33Z incident class: stale
 * staged cards whose directive was superseded out-of-band kept firing
 * verbatim): cancel_schedule (3ce5f6d0 — target already disabled / gone) +
 * the three incident-class tools:
 *   - schedule_message: an ENABLED, still-live schedule already exists for
 *     the same user + target chat with the SAME normalized prompt, kind and
 *     cadence — confirming would arm a duplicate of an already-armed arm.
 *   - send_chat_message: the identical message is verifiably ALREADY
 *     DELIVERED in the target chat — a role-'user' row with the exact staged
 *     content (modulo the deterministic [AGENT-SENT MESSAGE — …] provenance
 *     header), metadata.origin 'agent' stamped with THIS staging lane's
 *     sourceChatId, created AFTER the card was staged. Provenance + timestamp
 *     + exact content: anything looser could moot a deliberate repeat.
 *   - start_coding_session: an identical child session already exists — same
 *     parentChatId (strict lineage), canonical projectId, title (the exact
 *     createCodingChat derivation) and first prompt (the delivered first user
 *     message, or the pre-delivery Redis stash), created after the card was
 *     staged and not archived.
 * Tools without a checker (set_chat_autonomy, update_schedule,
 * dispatch_platform_task, send_to_instance, the account tools) keep returning
 * null — no deterministic end-state verifier exists for them.
 */

/** Whitespace/case fold for prompt comparisons — the SAME fold the create-time
 *  duplicate-backstop uses (schedule.service normalizeArmPrompt). */
function normalizeMootText(p: unknown): string {
  return String(p ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Provenance/time context of the STAGED row — the two delivered-marker
 *  checkers (send_chat_message, start_coding_session) must order candidate
 *  end-state evidence strictly AFTER the card was staged and attribute it to
 *  the staging lane; a caller that cannot supply both gets null from those
 *  checkers (unverifiable → fail open, the card stays). */
export type MootStagedContext = { stagedAt?: Date | string | number | null; stagingChatId?: string | null };

function stagedMsOf(staged?: MootStagedContext): number {
  const ms = staged?.stagedAt != null ? new Date(staged.stagedAt).getTime() : NaN;
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * start_coding_session: does this child chat's first prompt equal the staged
 * one? Two primary sources, checked in delivery order:
 *   1. DELIVERED — the child's FIRST role-'user' message. The execute path
 *      may prepend an [AGENT-SENT MESSAGE — …] provenance header at delivery
 *      (platform.service sendChatMessage, origin 'agent') and a
 *      [PARENT SESSION CONTEXT — …] journal digest at spawn (platform-tools
 *      start_coding_session) — both position-0 machine chrome; the staged
 *      prompt is always the exact SUFFIX, verified by STRICTLY stripping the
 *      digest (stripParentContextBlock) and demanding exact equality — a bare
 *      endsWith false-moots when the REAL first prompt merely ends with
 *      '\n\n'+staged (ticket ba41858d, adversarial-reviewer finding D-F1).
 *      sendChatMessage trims the body, so the canonical comparison form is
 *      the trimmed staged prompt.
 *   2. PRE-DELIVERY — the Redis first-prompt stash (first-prompt-recovery
 *      PENDING_KEY): the prompt lives ONLY there until the workspace is
 *      ready. Both stash payload shapes are accepted (JSON {prompt,origin}
 *      and the legacy plain string), mirroring parsePendingFirstPrompt.
 * Anything else (no message yet AND no stash, a hiccup reading either) is
 * unverifiable → false (fail open — the card keeps its owner decision).
 */
/** Position-0 header literal of the [PARENT SESSION CONTEXT] digest block the
 *  spawn path prepends to the child's first prompt as `${block}\n\n${prompt}`
 *  (run-journal.service buildParentContextBlock). Imported from the
 *  zero-import leaf parent-context-block.ts (ticket 161d39e9) — the strict
 *  grammar stripper lives there so every consumer shares ONE parser and
 *  whole-module mocks of run-journal.service don't shadow it. */
import { stripParentContextBlock } from '../coding/parent-context-block';

async function childFirstPromptMatches(childChatId: string, stagedPromptRaw: string): Promise<boolean> {
  const want = stagedPromptRaw.trim();
  const withChrome = (body: string): boolean => {
    if (body === want) return true;
    // The delivered/stashed form is `${digestBlock}\n\n${prompt}` — strip the
    // digest STRICTLY and require the remainder to be the staged prompt
    // EXACTLY (edge-whitespace tolerant only: the store trims the whole
    // message, and the block-prepended form preserves the prompt's leading
    // edge). A bare suffix match is the D-F1 false-moot class.
    const rest = stripParentContextBlock(body);
    return rest !== null && (rest === want || rest.trim() === want);
  };
  const prisma = await db();
  const first = await prisma.crossModelMessage.findFirst({
    where: { chatId: childChatId, role: 'user' },
    orderBy: { createdAt: 'asc' },
  });
  const body = typeof first?.content === 'string' ? stripAgentSendHeader(first.content) : '';
  if (body && withChrome(body)) return true;
  try {
    const redis = (await import('../../../config/redis')).default;
    const raw = await redis.get(`coding:first-prompt:pending:${childChatId}`).catch(() => null);
    if (typeof raw === 'string' && raw) {
      let stashed = raw;
      if (raw.startsWith('{')) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.prompt === 'string' && parsed.prompt) stashed = parsed.prompt;
        } catch { /* a plain prompt that happens to start with '{' */ }
      }
      if (withChrome(stashed.trim())) return true;
    }
  } catch { /* the stash read failing open must not un-verify nothing — it just keeps the card */ }
  return false;
}

/** The moot reason iff the staged action's requested end state verifiably
 *  ALREADY holds — null when it does not, or cannot be proven. */
export async function mootReasonForStagedAction(
  tool: string,
  args: any,
  userId: string,
  staged?: MootStagedContext,
): Promise<string | null> {
  try {
    switch (tool) {
      case 'cancel_schedule': {
        const id = String(args?.id ?? '').trim();
        if (!id) return null;
        const prisma = await db();
        let row = await prisma.codingSchedule.findFirst({ where: { id, userId } });
        if (!row && id.length >= 8) {
          // Same prefix tolerance as the tool: a severed id resolves when it
          // names exactly ONE of the owner's schedules; ambiguity is never moot.
          const matches = await prisma.codingSchedule.findMany({ where: { userId, id: { startsWith: id } } });
          if (matches.length === 1) row = matches[0];
          else if (matches.length > 1) return null;
        }
        if (!row) return `schedule ${id} no longer exists — there is nothing to cancel`;
        if (!row.enabled) {
          return `schedule ${row.id} is already disabled${row.disabledAt ? ` (at ${new Date(row.disabledAt).toISOString()})` : ''} — the cancel already happened`;
        }
        return null;
      }
      case 'schedule_message': {
        // Superseded premise (ticket ba41858d): the lane (or the owner)
        // re-armed the SAME directive out-of-band while the card sat — an
        // ENABLED, still-live schedule with the same normalized prompt, kind
        // and cadence already exists on the target chat, so confirming would
        // arm a verbatim duplicate (the 16:33Z incident shape).
        const chatId = String(args?.chatId ?? '').trim();
        const prompt = String(args?.prompt ?? '');
        if (!chatId || !prompt.trim()) return null;
        const kind = args?.kind === 'once' ? 'once' : 'recurring';
        const mins = Number(args?.intervalMinutes);
        if (!Number.isFinite(mins) || mins <= 0) return null;
        const intervalSec = Math.round(mins * 60);
        const prisma = await db();
        // The gate stamps the full chatId at staging (default-to-THIS-chat);
        // an explicit fleet-idiom ≥8-char prefix is tolerated only when it
        // names exactly ONE chat with candidate rows — ambiguity is never moot
        // (same rule as cancel_schedule above).
        let rows = await prisma.codingSchedule.findMany({
          where: { userId, sessionId: chatId, kind, enabled: true },
        });
        if (!rows.length && chatId.length >= 8) {
          const prefixed = await prisma.codingSchedule.findMany({
            where: { userId, kind, enabled: true, sessionId: { startsWith: chatId } },
          });
          if (new Set(prefixed.map((r: any) => r.sessionId)).size > 1) return null;
          rows = prefixed;
        }
        const want = normalizeMootText(prompt);
        const dupe = rows.find((r: any) =>
          // "Live" mirrors the create-time duplicate-backstop (schedule.service
          // ticket 1ead3b52): an exhausted/spent row is not an armed duplicate —
          // a chain's next-link re-arm must keep its card.
          (r.maxRuns == null || r.runsCount < r.maxRuns)
          && r.intervalSec === intervalSec
          && normalizeMootText(r.prompt) === want);
        return dupe
          ? `chat ${dupe.sessionId} already has an enabled identical ${kind} schedule ${dupe.id} (same prompt and ${mins}-minute ${kind === 'once' ? 'delay' : 'cadence'}) — confirming would arm a duplicate`
          : null;
      }
      case 'send_chat_message': {
        // Superseded premise (ticket ba41858d): the lane re-sent the identical
        // message out-of-band while the card sat — verifiably DELIVERED means
        // a role-'user' row in the target chat carrying (a) the EXACT staged
        // content (the deterministic [AGENT-SENT MESSAGE — …] provenance
        // header stripped — the delivery path prepends it, platform.service
        // sendChatMessage), (b) metadata.origin 'agent' with THIS staging
        // lane's sourceChatId, (c) createdAt strictly AFTER the card was
        // staged. All three conjuncts are required — a looser match could
        // moot a deliberate repeat (an owner's own retype, a recurring nudge).
        const chatId = String(args?.chatId ?? '').trim();
        const content = String(args?.content ?? '').trim();
        if (!chatId || !content) return null;
        // Attachment-carrying sends transform the stored body (queue/steer
        // inlining) — the delivered marker is not verifiable; fail open.
        if (Array.isArray(args?.uploadIds) && args.uploadIds.length) return null;
        const stagedMs = stagedMsOf(staged);
        const stagingChatId = String(staged?.stagingChatId ?? '').trim();
        if (!Number.isFinite(stagedMs) || !stagingChatId) return null;
        const prisma = await db();
        // chatId exact only: the staging gate canonicalizes the target to the
        // full id (platform-tools, 2026-09-18) before the card is written, so
        // no prefix tolerance is needed here (unlike schedule_message, whose
        // explicit chatId is only resolved at execution).
        const delivered = await prisma.crossModelMessage.findMany({
          where: {
            chatId, role: 'user', createdAt: { gt: new Date(stagedMs) },
            AND: [
              { metadata: { path: ['origin'], equals: 'agent' } },
              { metadata: { path: ['sourceChatId'], equals: stagingChatId } },
            ],
          },
          orderBy: { createdAt: 'desc' },
          take: 25,
        });
        const hit = delivered.find((m: any) => {
          const body = typeof m.content === 'string' ? m.content : '';
          return body === content || stripAgentSendHeader(body) === content;
        });
        return hit
          ? `the identical message is already delivered in chat ${chatId} (message ${hit.id} at ${new Date(hit.createdAt).toISOString()}, agent-origin from this lane) — confirming would send a duplicate`
          : null;
      }
      case 'start_coding_session': {
        // Superseded premise (ticket ba41858d): the lane re-spawned the
        // identical session out-of-band while the card sat — an existing chat
        // row proves it iff ALL of: strict lineage (parentChatId = the staging
        // lane), same CANONICAL project (execution may re-file a plain child
        // folder into its workspace ancestor — resolve the staged id the same
        // way startCodingSession does), same title (createCodingChat's exact
        // derivation), same first prompt (childFirstPromptMatches), created
        // strictly AFTER the card was staged, and not archived. A promptless
        // staged spawn has no first prompt to identity-match → never moot.
        const projectId = String(args?.projectId ?? '').trim();
        const stagedMs = stagedMsOf(staged);
        const stagingChatId = String(staged?.stagingChatId ?? '').trim();
        const stagedPrompt = typeof args?.prompt === 'string' ? args.prompt : '';
        if (!projectId || !Number.isFinite(stagedMs) || !stagingChatId || !stagedPrompt.trim()) return null;
        const wantTitle = (args?.title && String(args.title).trim()) || 'Untitled session';
        const prisma = await db();
        let wantProjectId = projectId;
        // SHARED-PROJECT-DISPATCH (2026-10-20): a member-authorized spawn's child
        // is owned by the PROJECT OWNER (target.runUserId), not the stager.
        let childOwnerId = userId;
        try {
          const svc: any = await import('./platform.service');
          if (typeof svc?.resolveCodingSessionTarget === 'function') {
            const target = await svc.resolveCodingSessionTarget(userId, projectId);
            if (!target?.ok || typeof target.projectId !== 'string' || !target.projectId) return null;
            wantProjectId = target.projectId;
            if (typeof target.runUserId === 'string' && target.runUserId) childOwnerId = target.runUserId;
          }
        } catch { return null; } // the canonical project is unverifiable — fail open
        const children = await prisma.crossModelChat.findMany({
          where: {
            userId: childOwnerId, parentChatId: stagingChatId, projectId: wantProjectId,
            title: wantTitle, archivedAt: null, createdAt: { gt: new Date(stagedMs) },
          },
          orderBy: { createdAt: 'asc' },
          take: 5,
        });
        for (const child of children) {
          if (await childFirstPromptMatches(child.id, stagedPrompt)) {
            return `an identical coding session already exists — chat ${child.id} "${child.title}" in project ${wantProjectId}, spawned by this lane at ${new Date(child.createdAt).toISOString()} with the same first prompt — confirming would spawn a duplicate`;
          }
        }
        return null;
      }
      default:
        return null; // no deterministic end-state checker — never auto-resolved
    }
  } catch {
    return null; // a read failure fails OPEN: keep the card, never guess moot
  }
}

/**
 * Flip ONE pending row to 'moot' WITH a receipt iff its requested end state
 * already holds. Returns the moot reason when this call resolved it (null
 * otherwise). The one-shot conditional flip means only the FIRST resolver
 * posts the lane note; later racers see null.
 */
export async function resolveConfirmationIfMoot(row: {
  id: string; chatId: string; userId: string; tool: string; args: any; summary: string;
  /** Staging timestamp — the delivered-marker checkers (send_chat_message,
   *  start_coding_session) only accept end-state evidence created strictly
   *  AFTER this; absent, those checkers fail open (ticket ba41858d). */
  createdAt?: Date | string | number | null;
}): Promise<string | null> {
  const reason = await mootReasonForStagedAction(row.tool, row.args, row.userId, {
    stagedAt: row.createdAt ?? null,
    stagingChatId: row.chatId,
  });
  if (!reason) return null;
  const flipped = await resolvePendingConfirmation(row.id, 'moot', {
    moot: true, reason, checkedAt: new Date(Date.now()).toISOString(),
  });
  if (!flipped) return null; // resolved elsewhere in the race
  try {
    const logger = (await import('../../../utils/logger')).default;
    logger.info(`pending-confirmations: auto-resolved ${row.id} as MOOT (${row.tool}, chat ${row.chatId}): ${reason}`);
  } catch { /* logging never breaks resolution */ }
  await postLaneMootNote(
    row.chatId,
    `[Owner inbox] Auto-resolved a staged action as MOOT — ${row.summary} — because ${reason}. The requested end state already holds, so no confirmation was needed and nothing executed (ticket 3ce5f6d0). Do not re-stage the same action.`,
  );
  return reason;
}

/** Listing-time sweep: resolve every moot pending row of this owner. */
export async function resolveMootConfirmationsForUser(userId: string): Promise<number> {
  const prisma = await db();
  const pending = await prisma.pendingConfirmation.findMany({ where: { userId, status: 'pending' }, take: 50 });
  let resolved = 0;
  for (const row of pending) {
    try {
      if (await resolveConfirmationIfMoot(row as any)) resolved++;
    } catch { /* per-row fail-open: a checker hiccup keeps that card */ }
  }
  return resolved;
}

/** Transcript receipt for the staging lane — the same CrossModelMessage
 *  convention as owner-questions' postOwnerInboxNote (role 'assistant' +
 *  metadata.origin 'owner-inbox' + the sidebar updatedAt bump). Best-effort:
 *  a note hiccup must not un-resolve the moot flip. */
async function postLaneMootNote(chatId: string, content: string): Promise<void> {
  try {
    const prisma = await db();
    await prisma.crossModelMessage.create({
      data: { chatId, role: 'assistant', content, metadata: { origin: 'owner-inbox' } },
    });
    await prisma.crossModelChat.update({ where: { id: chatId }, data: { updatedAt: new Date(Date.now()) } }).catch(() => {});
  } catch { /* never propagate */ }
}

/**
 * The newest live pending confirmation for a chat session, if any — used to
 * rehydrate the confirmation protocol into plain-chat history (the model's
 * next turn cannot see the original tool result, so without this the
 * confirmationId is deterministically lost and a user's "confirm" can never
 * complete). DB-backed: live = status 'pending' AND still inside the
 * execution-freshness horizon — a STALE pending row is deliberately excluded
 * (the model could never complete it; consume would refuse and tell it to
 * re-stage). Args are deliberately NOT exposed here — the confirm path never
 * needs the model to see them.
 */
export async function getActivePendingForSession(
  sessionId: string,
): Promise<{ confirmationId: string; tool: string; summary: string; createdAt: number } | null> {
  const row = await (await db()).pendingConfirmation.findFirst({
    where: { chatId: sessionId, status: 'pending', expiresAt: { gt: new Date(Date.now()) } },
    orderBy: { createdAt: 'desc' },
  });
  return row ? { confirmationId: row.id, tool: row.tool, summary: row.summary, createdAt: row.createdAt.getTime() } : null;
}

/** Test hook: how many staged confirmations are still pending. */
export async function pendingConfirmationCount(): Promise<number> {
  return (await db()).pendingConfirmation.count({ where: { status: 'pending' } });
}
