/**
 * Operator / reads / inbox tools — agent capability gap audit, tranche 3a
 * (P1 #8, #9, #14, #15, #17, #18; 2026-09-24):
 *
 *   get_model_roles            {}                       READ, ADMIN at execution
 *   set_model_role_fallback    {role, fallback}         MUTATING, ADMIN, ASK-ONLY (instance-wide)
 *   get_run_receipts           {chatId, runId?, limit?} READ, owner or project member
 *   get_chat_autonomy          {chatId?}                READ, owner-scoped
 *   search_chats               {q, projectId?, limit?, includeArchived?}  READ, own chats (archived included by default)
 *   dismiss_owner_question     {questionId, reason?}    MUTATING; supervisor seat (owner-dismiss rails) / filing chat / user-present
 *   cancel_confirmation        {confirmationId}         MUTATING; the staging chat / supervisor seat / user-present
 *   list_pending_confirmations {}                       READ, own account
 *
 * Every executor delegates to the same service functions the REST/UI twins
 * use. Import-light: heavy modules ride dynamic imports.
 */

import { redactStringsDeep, REDACTED_NOTE } from './secret-scan';
import { ownerDismissRailsDisabled } from './owner-authority-switches';

export const OPS_TOOL_NAMES = ['get_model_roles', 'set_model_role_fallback', 'get_run_receipts', 'get_chat_autonomy', 'search_chats', 'dismiss_owner_question', 'cancel_confirmation', 'list_pending_confirmations'] as const;
export type OpsToolName = (typeof OPS_TOOL_NAMES)[number];
export const isOpsTool = (name: string): name is OpsToolName => (OPS_TOOL_NAMES as readonly string[]).includes(name);

export const OPS_TOOL_SCHEMA = [
  { type: 'function' as const, function: { name: 'get_model_roles', description: "ADMIN ONLY. Read the instance's model SEATS (Digby, Fleet Supervisor, Double/Triple Checker, Workspace default, Helper, Utility, Image reader, PDF reader, Browser agent, Computer-use vision, Digby Kids, Embeddings, Reranker, ASR, TTS): the built-in default, any admin override, the custom fallback, whether the seat is SERVABLE and which env key is missing when it is not, plus which provider keys are present and the fixed fallback chains. Use it before diagnosing a 'provider dead' incident or choosing a set_session_model route. Read-only.", parameters: { type: 'object', properties: {} } } },
  { type: 'function' as const, function: { name: 'set_model_role_fallback', description: "ADMIN ONLY, ASK-ONLY (a human approves every call — this is an INSTANCE-WIDE setting). Set (or clear with '') the custom FALLBACK model for one seat: when the seat's primary fails at the provider the runtime routes to it. Never re-seats the primary. fallback must be a built-in id or an enabled registry model; the call is refused otherwise. Use get_model_roles first.", parameters: { type: 'object', properties: { role: { type: 'string', description: 'Seat key from get_model_roles (e.g. supervisor, coding_default, utility).' }, fallback: { type: 'string', description: "Model id or '' to clear." } }, required: ['role', 'fallback'] } } },
  { type: 'function' as const, function: { name: 'get_run_receipts', description: "Read the TOOL RECEIPTS a chat's runs actually produced — the durable evidence rows (tool, ok, the ids envelope: prNumber/sha/branch/chatId/scheduleId/ticketId/sessionId, timestamps) plus each run's status/steps/error. `chatTurns` (always present) groups the CHAT-turn receipts a supervisor / plain-chat turn minted — each turn under its own run id (chat-<uuid>); owner-card executions keep runId null. Mid-run text never reaches get_chat_messages; receipts are how you verify a lane DID what it said (a PR number, a merge sha, a schedule id). runId narrows to one run OR one chat turn's id; otherwise the latest `limit` runs (default 3, max 10) plus the latest chatTurns. Owner or project member.", parameters: { type: 'object', properties: { chatId: { type: 'string' }, runId: { type: 'string' }, limit: { type: 'number' } }, required: ['chatId'] } } },
  { type: 'function' as const, function: { name: 'get_chat_autonomy', description: "Read a chat's autonomy grant: allowedTools, scheduleCap and the grant's source (manual / agent_mode_auto / machine_delegated), or null when it has none — plus the spend cap governing its machine firings (spendCap {spendCapUsdPerDay, spendCapSource: 'project' | null}): the ONLY cost cap in the framework is a user-set project spendCapUsdPerDay (project settings); null = no cap. There is no chat-level cap, env default or fleet budget. chatId omitted = this chat. Read it before relying on a lane executing a consequential tool unattended, before a set_chat_autonomy request (a subset of an existing grant executes card-free), and whenever firings are being skipped on a spend cap. Owner-scoped, never gated.", parameters: { type: 'object', properties: { chatId: { type: 'string' } } } } },
  { type: 'function' as const, function: { name: 'search_chats', description: "Full-text search across YOUR chats — titles AND message content, ARCHIVED chats included (each archived hit carries archived:true). Returns chat id/title, the matching snippet, the matched message role and time, and projectId; optional projectId filter; limit ≤ 50; includeArchived:false skips archived chats (the sidebar box's scope). Use it to find where something was discussed or decided before re-asking; list_chats only filters titles.", parameters: { type: 'object', properties: { q: { type: 'string', description: '2–200 chars.' }, projectId: { type: 'string' }, limit: { type: 'number' }, includeArchived: { type: 'boolean', description: 'Default true — archived chats are searched too.' } }, required: ['q'] } } },
  { type: 'function' as const, function: { name: 'dismiss_owner_question', description: "DISMISS (withdraw) a flagged owner question so it leaves the owner's inbox without an answer — for a question that is moot, was answered elsewhere, or was filed by mistake. Scope: a supervisor seat, the chat that filed it (withdrawing its OWN question), or a user-present turn; a machine lane cannot dismiss another lane's question. A supervisor seat cannot dismiss an owner-only class card, a card the owner has posted about in the filing chat since it was filed, or (a project supervisor) another project's card — those refuse with the reason. The filing lane is told the question was dismissed, and WHO dismissed it is recorded and shown (your seat — supervisor, filing chat, or the owner — never narrated as the owner when it was not). Audited. Not consequential.", parameters: { type: 'object', properties: { questionId: { type: 'string', description: 'oq_… id (full, or a unique ≥8-char prefix).' }, reason: { type: 'string', description: 'Why it is moot / withdrawn (one line).' } }, required: ['questionId'] } } },
  { type: 'function' as const, function: { name: 'cancel_confirmation', description: "CANCEL a staged confirmation card (a consequential tool call waiting for the owner's click) that is no longer wanted — e.g. you staged a send/schedule that a later turn superseded, or the card is moot. Scope: the chat that staged it, a supervisor seat, or a user-present turn. Confirming stays owner-only by design. Returns already_resolved when the card was consumed/cancelled/expired first.", parameters: { type: 'object', properties: { confirmationId: { type: 'string', description: 'cf_… id (from the staging result, list_pending_confirmations, or get_fleet_telemetry view cards).' }, reason: { type: 'string' } }, required: ['confirmationId'] } } },
  { type: 'function' as const, function: { name: 'list_pending_confirmations', description: "List YOUR account's staged confirmation cards still waiting for the owner: id, tool, staging chat, summary, staged/expires times. Read it to avoid staging a duplicate, to find a card to cancel_confirmation, or to explain to the owner what is waiting on them. Read-only.", parameters: { type: 'object', properties: {} } } },
];

type Ctx = { sessionId: string; userId: string; userTurnAt?: Date | null; machineTriggered?: boolean };
type Deps = { platform: any; isAdmin: (userId: string) => Promise<boolean> };
const out = (o: Record<string, unknown>): string => JSON.stringify(o, null, 1);

/**
 * Machine-run classification for the chat-read redaction (review fix): the
 * executor's ORIGIN-aware `machineTriggered` (an agent-origin coding wake
 * whose sending run was user-anchored carries a userTurnAt but is still a
 * machine run) OR the absence of a user-turn anchor. Either signal ⇒ machine.
 */
export function chatReadIsMachine(ctx: { userTurnAt?: Date | null; machineTriggered?: boolean }): boolean {
  return ctx?.machineTriggered === true || !ctx?.userTurnAt;
}

/**
 * Secret-scrubbing D4 (2026-09-27): a READ envelope (get_run_receipts — its
 * `ids` / `error` fields carry lane-authored strings; search_chats — message
 * snippets) is redacted on a MACHINE run before the model sees it. Review
 * fix: the redaction runs per STRING LEAF of the envelope OBJECT and the
 * result is serialized afterwards — a regex over the serialized JSON text
 * consumed the backslash of an escaped quote and handed the model a malformed
 * document with no notice. When anything was hit the notice leads the
 * envelope and one telemetry row is recorded. Fail-open at every step: a
 * throw returns the plain envelope.
 */
async function redactReadEnvelope(ctx: Ctx, tool: string, chatId: string | null, envelope: Record<string, unknown>): Promise<string> {
  try {
    const machine = chatReadIsMachine(ctx);
    const r = redactStringsDeep(envelope, { machineRun: machine });
    if (!r.hits.length) return out(envelope);
    try {
      const m: any = await import('./loop-metrics.service');
      if (typeof m?.recordLoopMetric === 'function') {
        m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS?.CHAT_READ_SECRET_REDACTED ?? 'chat_read_secret_redacted', sessionId: ctx.sessionId, meta: { tool, chatId, hits: r.hits, count: 1, machine } });
      }
    } catch { /* telemetry never blocks a read */ }
    return out({ secretRedactionNotice: `CREDENTIALS REDACTED — this envelope contained credential-shaped strings (${r.hits.join(', ')}); each was replaced with "${REDACTED_NOTE}" before you saw it. Never copy, restate or file a credential into a directive, note, ticket or message.`, ...r.value });
  } catch {
    return out(envelope);
  }
}
const short = (s: string) => String(s || '').slice(0, 8);
async function db(): Promise<any> { return (await import('../../../config/database')).default; }
async function supervisorSeat(chatId: string): Promise<boolean> {
  try { const m = await import('./supervisor-state.service'); return await m.isSupervisorChat(chatId); } catch { return false; }
}

/** OWNER-DISMISS-RAILS (2026-10-20): WHICH supervisor seat a confirmed supervisor chat is — a project
 *  supervisor (with its project) or the Fleet Supervisor. A row that is not a project supervisor, or a
 *  read hiccup, answers 'fleet' (the pre-rails attribution; rails 1–2 still apply). */
async function supervisorSeatRole(chatId: string): Promise<{ role: 'fleet' | 'project'; projectId: string | null }> {
  try {
    const prisma = await db();
    const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { isSupervisor: true, isProjectSupervisor: true, projectId: true } });
    if (chat?.isProjectSupervisor === true && chat?.isSupervisor !== true) return { role: 'project', projectId: typeof chat.projectId === 'string' ? chat.projectId : null };
  } catch { /* fall through — the Fleet Supervisor attribution */ }
  return { role: 'fleet', projectId: null };
}

/** The model-facing refusal text per OWNER-DISMISS-RAILS reason (exported for tests). */
export function dismissRailRefusalMessage(reason: string): string {
  switch (reason) {
    case 'owner_only_class':
      return 'REFUSED — owner-only class: this card falls in a class only the OWNER closes (another-account security, cross-project scope, credentials, irreversible, external send, or physically-human). Nothing was dismissed. A generic standing directive does not cover it — leave it on the owner\'s card and continue with everything it does not block.';
    case 'owner_engaged':
      return 'REFUSED — the owner has posted in the FILING chat since this card was filed, so a dismissal would race their newer words. Nothing was dismissed. Re-read the filing chat with get_chat_messages; if the owner resolved it there, leave the card to them.';
    case 'out_of_project':
      return 'REFUSED — a project supervisor dismisses only cards filed by (or linked to) its OWN project\'s chats. Nothing was dismissed. If the card is moot, tell the Fleet Supervisor (send_chat_message) instead.';
    default:
      return 'REFUSED — the dismissal rails declined this card. Nothing was dismissed.';
  }
}

/**
 * get_run_receipts' reading guide (WI-K + review 2026-09-25). Rows are
 * point-in-time records and are NEVER updated: a confirmation-STAGED call
 * mints ok:false {staged:true, confirmationId} at staging, and the owner's
 * later confirmation (sidebar / Management card — confirmations.controller.ts;
 * or the rare model re-call with the confirmationId) mints a SEPARATE row for
 * the execution. Pinned by platform-tools.ops-tools.test.ts.
 */
export const RUN_RECEIPTS_NOTE = '`id` on each receipt row is the receipt id (8-char prefix) — the receiptId a kpi: premise cites in goal_premise_set (a run\'s own `id` from runs[] is accepted there too and resolves to that run\'s latest ok run_command receipt). ids envelopes are the durable evidence (prNumber/sha/branch/chatId/scheduleId/ticketId). ok=false rows were refused or errored — or, when ids.staged is true, the call was PARKED on a confirmation card (ids.confirmationId) at that moment. A staged row is a point-in-time record and is never updated: when the owner confirms the card (sidebar / Management) the execution mints a NEW row (ok per the tool result, runId null, ids.confirmationId = the same card, ids.ownerConfirmed=true). So a staged row whose confirmationId has no later row is still parked — confirm with list_pending_confirmations before treating it as unexecuted, and never read a staged row as done. Finals live in get_chat_messages.';

/**
 * Ticket e225aad8 — the discovery window for get_run_receipts' chatTurns
 * lane: the newest N receipts of the chat read to discover distinct chat
 * turns. A chat turn stamps all its receipts with the turn's telemetry id
 * (chat-<uuid>) and can mint dozens of rows (run_command every step), so the
 * old 200-row window could end mid-older-turn; 500 covers a busy lane's
 * recent turns.
 */
export const CHAT_TURNS_DISCOVERY = 500;

export async function executeOpsTool(ctx: Ctx, name: OpsToolName, args: any, deps: Deps): Promise<string> {
  const { platform } = deps;
  const userId = ctx.userId;
  switch (name) {
    case 'get_model_roles': {
      if (!(await deps.isAdmin(userId))) return 'get_model_roles is restricted to admin users — model seats are instance-wide settings, not this account\'s data.';
      const svc: any = await import('../model-endpoints/model-roles.service');
      const roles = await svc.listModelRoles(userId);
      return out({ ok: true, tool: name, roles, providerKeys: svc.listProviderKeyStatus(), chains: svc.listFixedChains() });
    }
    case 'set_model_role_fallback': {
      if (!(await deps.isAdmin(userId))) return 'set_model_role_fallback is restricted to admin users — model seats are instance-wide settings.';
      const role = String(args?.role || '').trim();
      const fallback = typeof args?.fallback === 'string' ? args.fallback.trim() : null;
      if (!role || fallback === null) return out({ ok: false, tool: name, reason: 'invalid', message: "role and fallback ('' clears) are required." });
      const svc: any = await import('../model-endpoints/model-roles.service');
      const key = svc.normalizeRoleKey(role);
      if (!key) {
        // No dead ends (7a078b4d): list the keys inline — the caller may not
        // have get_model_roles loaded in its tool list at all.
        const seatKeys = Array.isArray(svc.MODEL_ROLES) ? svc.MODEL_ROLES.map((r: any) => r.key).filter((k: any) => typeof k === 'string') : [];
        return out({ ok: false, tool: name, reason: 'invalid', message: seatKeys.length ? `Unknown seat "${role}" — the seat keys are: ${seatKeys.join(', ')}.` : `Unknown seat "${role}" — get_model_roles lists the keys.` });
      }
      try {
        // ownerConfirmed: this tool is ASK-ONLY by construction — it executes
        // only after a human approved THIS call (an owner card click, or the
        // session's requestApproval prompt) — so an opt-in seat-governance
        // refusal (FRONTIER_SEATS_REFUSE=1) yields to the owner's decision
        // (review fixer 2026-09-27).
        const roles = await svc.updateModelRoles({}, userId, { fallbacks: { [key]: fallback }, ownerConfirmed: true });
        const seat = (roles as any[]).find((r) => r.key === key) ?? null;
        return out({ ok: true, tool: name, role: key, fallback: fallback || null, seat, message: fallback ? `Seat ${key}: custom fallback set to ${fallback}.` : `Seat ${key}: custom fallback cleared.` });
      } catch (err: any) {
        return out({ ok: false, tool: name, role: key, reason: 'refused', message: String(err?.message || err) });
      }
    }
    case 'get_run_receipts': {
      const raw = String(args?.chatId || '').trim();
      if (!raw) return out({ ok: false, tool: name, reason: 'invalid', message: 'chatId is required.' });
      const chatId = typeof platform?.resolveOwnedChatIdPrefix === 'function' ? await platform.resolveOwnedChatIdPrefix(userId, raw).catch(() => raw) : raw;
      const cm: any = (await import('../crossmodel.service')).default;
      const access = await cm.getChatAccess(chatId, userId).catch(() => ({ access: 'none', exists: false }));
      if (!access || access.access === 'none') return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat you can read matches that id.' });
      const prisma = await db();
      const limit = Math.min(10, Math.max(1, Number(args?.limit) || 3));
      const runId = String(args?.runId || '').trim();
      const runs = await prisma.agentRun.findMany({
        where: { sessionId: chatId, ...(runId ? { id: runId } : {}) },
        orderBy: { createdAt: 'desc' }, take: runId ? 1 : limit,
        select: { id: true, status: true, attempts: true, currentStep: true, error: true, createdAt: true, startedAt: true, finishedAt: true, input: true },
      }).catch(() => []);
      // Ticket e225aad8: a runId query that names NO agent_runs row used to
      // 404 immediately even when it IS a chat / supervisor turn's telemetry
      // id (chat-<uuid>) — the API was structurally blind to chat turns. Fall
      // back to the receipts table (the [runId] index) BEFORE refusing: when
      // rows exist under that id for THIS chat, surface them as ONE chatTurns
      // entry so a turn id resolves the same way a coding run id does. The
      // not_found contract is kept for ids with no rows anywhere.
      let runIdTurnReceipts: any[] = [];
      if (runId && !runs.length) {
        runIdTurnReceipts = await prisma.runToolReceipt.findMany({
          where: { chatId, runId },
          orderBy: { createdAt: 'asc' }, take: 500,
          select: { id: true, runId: true, tool: true, ok: true, ids: true, createdAt: true },
        }).catch(() => []);
        if (!runIdTurnReceipts.length) return out({ ok: false, tool: name, reason: 'not_found', message: 'No run with that id on that chat.' });
      }
      // The main receipts read skips the runId-turn path entirely (review
      // finding 2: the take-500 read ran and its result was discarded) —
      // a runId that resolved to a chat turn has its rows above.
      const receipts = runId && !runs.length ? [] : await prisma.runToolReceipt.findMany({
        where: { chatId, ...(runs.length ? { runId: { in: runs.map((r: any) => r.id) } } : {}) },
        orderBy: { createdAt: 'asc' }, take: 500,
        select: { id: true, runId: true, tool: true, ok: true, ids: true, createdAt: true },
      }).catch(() => []);
      // The receipt row's own id (8-char prefix) rides every row (fixer follow-up 1,
      // 2026-09-27): the Mission KPI contract asks a lane for "the receipt id as
      // get_run_receipts prints it" and nothing printed it — every kpi: premise
      // registration was refusable by construction. A cited prefix resolves
      // through goals.service's startsWith read; the verifier's receipt lane
      // exonerates on row existence, so citing a shown id never convicts.
      const receiptRow = (r: any) => ({ ...(r.id ? { id: String(r.id).slice(0, 8) } : {}), tool: r.tool, ok: r.ok, ids: r.ids, at: r.createdAt });
      const byRun: Record<string, any[]> = {};
      for (const r of receipts as any[]) (byRun[r.runId ?? '_'] ||= []).push(receiptRow(r));
      // Chat-lane receipts (peer verification 2026-09-25 P1-1): plain-chat
      // runs (supervisor wakes, user turns) are NOT agent_runs rows — their
      // receipts carry a chat-run id or NULL and used to vanish from this
      // view (runs:[] after five tool-calling chat turns). Surface the most
      // recent ones as `chatTurns`, grouped by their run key, oldest-first.
      // Ticket e225aad8: since the write seam stamps chat-turn receipts with
      // the turn's telemetry id (chat-<uuid>), each turn groups under its OWN
      // id — one chatTurns entry PER TURN (pre-fix rows keep runId null and
      // still group under '_' — the owner-card executions mint runId null by
      // design, ops-tools comment in confirmations.controller.ts). Discovery
      // reads the newest CHAT_TURNS_DISCOVERY (500) rows of the chat, NOT the
      // runId-narrowed set: a busy lane mints far more receipts per turn than
      // the limit, and the old 200-row window could end mid-older-turn.
      let chatTurns: Array<{ runId: string | null; receipts: any[] }> = [];
      if (!runId) {
        const known = new Set((runs as any[]).map((r) => r.id));
        const recent = await prisma.runToolReceipt.findMany({
          where: { chatId, ...(known.size ? { OR: [{ runId: null }, { runId: { notIn: Array.from(known) } }] } : {}) },
          orderBy: { createdAt: 'desc' }, take: CHAT_TURNS_DISCOVERY,
          select: { id: true, runId: true, tool: true, ok: true, ids: true, createdAt: true },
        }).catch(() => []);
        const byTurn = new Map<string, { runId: string | null; receipts: any[] }>();
        for (const r of (recent as any[]).reverse()) {
          const key = r.runId ?? '_';
          if (!byTurn.has(key)) byTurn.set(key, { runId: r.runId ?? null, receipts: [] });
          byTurn.get(key)!.receipts.push(receiptRow(r));
        }
        chatTurns = Array.from(byTurn.values()).slice(-limit);
      }
      if (runId && !runs.length) chatTurns = [{ runId, receipts: runIdTurnReceipts.map(receiptRow) }];
      // E5 context_window_used: the run's context FILL at finalize — the peak
      // prompt_tokens per model (vs its known window) from the run_context_fill
      // loop_metrics rows this run's spend accounting minted. Surfaced here so
      // a lane can cite fill the same place it cites PRs and schedules —
      // measure-only, no decision reads it. Chat-turn rows (runId null /
      // agent-run-less keys) are NOT matched: the metrics rows key on the
      // usage runId ('r…'), not a chat-turn key — matching them would be guesswork.
      const runIds = (runs as any[]).map((r) => r.id);
      const contextFill = runIds.length
        ? await prisma.loopMetric.findMany({
            where: { kind: 'run_context_fill', runId: { in: runIds } },
            orderBy: { createdAt: 'asc' },
            select: { runId: true, value: true, meta: true, createdAt: true },
          }).catch(() => [] as any[])
        : [];
      const fillByRun = new Map<string, any[]>();
      for (const f of contextFill as any[]) {
        const k = f.runId ?? '_';
        if (!fillByRun.has(k)) fillByRun.set(k, []);
        const m = (f.meta ?? {}) as any;
        fillByRun.get(k)!.push({ model: m.model, peakPromptTokens: m.peakPromptTokens ?? f.value, windowTokens: m.windowTokens, fillRatio: m.fillRatio, at: f.createdAt });
      }
      const envelope = { ok: true, tool: name, ids: { chatId }, runs: (runs as any[]).map((r) => {
        // SAA-1.4 PHASE 0: `input` is now SELECTED (so the schedule hop below can
        // resolve — it was structurally unreachable before, independent review
        // 2026-11-02), but it must NOT ride the envelope: `input` is a large
        // per-run blob and the Phase 0 gate requires this read's output to stay
        // byte-identical to the pre-feature shape. Destructured out, not spread.
        const { input: _runInput, ...rest } = r as any;
        return { ...rest, receipts: byRun[r.id] ?? [], contextFill: fillByRun.get(r.id) ?? [] };
      }), chatTurns /* always present (live check 2026-09-25: consumers read {runs, chatTurns}) */, note: RUN_RECEIPTS_NOTE };
      // SAA-1.4 PHASE 1 (todo 2ef2b254): the envelope the caller actually reads.
      // Stays the SAME reference unless the chain applied, so observe/off are
      // byte-identical by construction (see `withRecallChainField`).
      let recallEnvelope: Record<string, unknown> = envelope;
      // SAA-1.4 PHASE 0 (todo 9114e7b5) — Resolve the NEXT HOPS a
      // reader wants after citing a receipt (the lane's charter goal and todo,
      // the schedule a machine firing came from) and record what a Phase-1
      // `next:` line WOULD have offered. In observe mode (the default) NOTHING
      // is appended and NO field is added, so the text an agent reads here is
      // byte-identical with the feature on and off — the Phase 0 exit gate.
      //
      // PHASE 1 CORRECTION: this block used to compute the chain and stop. The
      // metric fired while the envelope was never touched, so an ARMED box still
      // got no `next:` field here — the surface read as "wired" in the closed-set
      // accounting while being structurally observe-only. The apply-mode canary
      // caught it (probe-saa1-phase1-canary.js CHECK 5, which classified the
      // surface SILENT against 484 injectable hops recorded in the 7 days to
      // 2026-11-04). The render call below is the missing half.
      try {
        const chainMod = await import('./chain-of-recall');
        const hops: Array<{ kind: 'run' | 'goal' | 'todo' | 'receipt' | 'chat' | 'schedule'; id: string; label?: string }> = [];
        // A charter edge on the chat row is the stable hop; goal-spend's resolver
        // is deliberately NOT reused because it consults in-progress todos,
        // which would make the hop depend on what the lane is doing right now
        // rather than on the chat. Fail-open: a read hiccup must never cost a
        // lane its receipts.
        const charter = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { charterGoalId: true, charterTodoId: true } }).catch(() => null) as { charterGoalId?: string | null; charterTodoId?: string | null } | null;
        if (charter?.charterGoalId) hops.push({ kind: 'goal', id: String(charter.charterGoalId) });
        if (charter?.charterTodoId) hops.push({ kind: 'todo', id: String(charter.charterTodoId) });
        for (const r of (runs as any[]).slice(0, 3)) {
          const sid = (r as any)?.input?.scheduleId;
          if (sid) hops.push({ kind: 'schedule', id: String(sid) });
        }
        const chain = chainMod.planRecallChain({ surface: 'get_run_receipts', hops });
        // THE RENDER SITE (this is the line Phase 0 was missing): an additive
        // `next` key on the envelope, or the SAME envelope reference when the
        // chain did not apply.
        recallEnvelope = chainMod.withRecallChainField(envelope, chain) as Record<string, unknown>;
        const meta = chainMod.recallChainMetricMeta(chain, { chatId, runId: runId ?? null });
        if (meta) {
          const m: any = await import('./loop-metrics.service');
          if (typeof m?.recordLoopMetric === 'function') {
            m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS?.CHAIN_OF_RECALL_OBSERVE ?? 'chain_of_recall_observe', sessionId: chatId, value: 1, meta });
          }
        }
      } catch { /* observe-only: never blocks a read */ }
      // SAA-1.4 PHASE 1 (todo 2ef2b254): give the chain a RENDER site.
      // Phase 0 computed the hops only to record what a Phase-1 `next:` line WOULD
      // have offered — the observation went to telemetry and the envelope was left
      // alone. That is why this surface read as "wired" while an armed box still
      // got no `next:` field: the metric fired (484 injectable hops in the 7d to
      // 2026-11-04) and nothing was appended. The apply-mode canary caught it
      // (probe-saa1-phase1-canary.js CHECK 5 classified it SILENT).
      // `withRecallChainField` returns the SAME envelope reference unless the chain
      // actually applied, so observe/off stay byte-identical by construction.
      return redactReadEnvelope(ctx, name, chatId, recallEnvelope);
    }
    case 'get_chat_autonomy': {
      const raw = String(args?.chatId || '').trim() || ctx.sessionId;
      const chatId = raw === ctx.sessionId ? raw : (typeof platform?.resolveOwnedChatIdPrefix === 'function' ? await platform.resolveOwnedChatIdPrefix(userId, raw).catch(() => raw) : raw);
      const prisma = await db();
      const chat = await prisma.crossModelChat.findUnique({ where: { id: chatId }, select: { id: true, userId: true } }).catch(() => null);
      if (!chat || chat.userId !== userId) return out({ ok: false, tool: name, reason: 'not_found', message: 'No chat of yours matches that id.' });
      const { getChatAutonomy } = await import('./autonomy.service');
      const grant = await getChatAutonomy(chat.id).catch(() => null);
      // Ticket 1769c8d1 (2026-09-27): the governing spend cap rides the read.
      // Owner directive 2026-09-27: the ONLY cost cap is a user-set PROJECT
      // spendCapUsdPerDay — no chat row, env default or fleet budget exists.
      // Same presence contract as get_spend's cap: present with nulls =
      // checked, none set; ABSENT = the read failed (fail-open, never errors).
      let spendCap: { spendCapUsdPerDay: number | null; spendCapSource: 'project' | null } | null = null;
      try {
        const { getLaneSpendCap } = await import('../coding/spend-cap.service');
        spendCap = await getLaneSpendCap(chat.id);
      } catch { /* leave null — the cap could not be determined */ }
      const capLine = spendCap?.spendCapUsdPerDay != null ? `, spend cap $${spendCap.spendCapUsdPerDay}/day (${spendCap.spendCapSource})` : '';
      return out({ ok: true, tool: name, ids: { chatId: chat.id }, autonomy: grant, ...(spendCap ? { spendCap } : {}), message: grant ? `Chat ${short(chat.id)} may execute [${(grant.allowedTools ?? []).join(', ')}] unattended (source ${grant.source}${grant.scheduleCap != null ? `, schedule cap ${grant.scheduleCap}/day` : ''}${capLine}).` : `Chat ${short(chat.id)} has no autonomy grant — its consequential tools stage a confirmation unless the auto-mode/parent scopes apply${capLine}.` });
    }
    case 'search_chats': {
      const q = String(args?.q || '').trim().slice(0, 200);
      if (q.length < 2) return out({ ok: false, tool: name, reason: 'invalid', message: 'q must be at least 2 characters.' });
      const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
      const projectId = String(args?.projectId || '').trim() || null;
      // audit 2026-10-08 W1-3 (supervisors F3): archived chats are searched by default (each hit
      // marked archived:true) — the tt-rd supervisor told the owner "archived sessions are fully
      // searchable" after a search that never looked at them. includeArchived:false opts out;
      // SEARCH_CHATS_INCLUDE_ARCHIVED_DISABLED=1 restores the archive-excluding default.
      const includeArchived = args?.includeArchived === false || String(args?.includeArchived) === 'false'
        ? false
        : args?.includeArchived === true || String(args?.includeArchived) === 'true' || process.env.SEARCH_CHATS_INCLUDE_ARCHIVED_DISABLED !== '1';
      const cm: any = (await import('../crossmodel.service')).default;
      const { results } = await cm.searchChatsAndMessages(userId, q, { includeArchived });
      const rows = (results as any[]).filter((r) => !projectId || r.projectId === projectId).slice(0, limit);
      const archivedHits = rows.filter((r) => r?.archived === true).length;
      try {
        const { recordLoopMetric } = await import('./loop-metrics.service');
        recordLoopMetric({ kind: 'search_chats', sessionId: ctx.sessionId, value: rows.length, meta: { includeArchived, archivedHits } });
      } catch { /* telemetry never blocks */ }
      // Review fix: snippets are 90-char windows of message text — a pasted
      // key rides one exactly like a get_chat_messages body. Same policy.
      return redactReadEnvelope(ctx, name, null, {
        ok: true, tool: name, query: q, count: rows.length, includeArchived,
        ...(includeArchived ? { archivedHits } : { scope: 'archived chats EXCLUDED — 0 hits here does not mean the words were never discussed; re-run with includeArchived:true' }),
        results: rows,
      });
    }
    case 'dismiss_owner_question': {
      const idRaw = String(args?.questionId || '').trim();
      if (!idRaw) return out({ ok: false, tool: name, reason: 'invalid', message: 'questionId is required.' });
      const prisma = await db();
      // OWNER-DISMISS-RAILS (2026-10-20): the rails read the card's text / context / filing time / lane link.
      // Ticket 1a56f816: plus the PAYLOAD columns the owner-only class now reads
      // (typed options, declared answer type, console action) — a rail that
      // cannot see the payload would let a supervisor withdraw an owner-only
      // card the flag path had correctly kept out of triage.
      const rowSelect = { id: true, userId: true, chatId: true, status: true, question: true, context: true, createdAt: true, forChatId: true, options: true, expectedAnswerType: true, consoleAction: true };
      let row = await prisma.ownerQuestion.findUnique({ where: { id: idRaw }, select: rowSelect }).catch(() => null);
      if (!row && idRaw.length >= 8) {
        const cands = await prisma.ownerQuestion.findMany({ where: { userId, id: { startsWith: idRaw } }, select: rowSelect, take: 2 }).catch(() => []);
        if (cands.length > 1) return out({ ok: false, tool: name, reason: 'ambiguous', message: 'That prefix matches more than one of your owner questions — list_owner_questions for the full id.' });
        row = cands[0] ?? null;
      }
      if (!row || row.userId !== userId) return out({ ok: false, tool: name, reason: 'not_found', message: 'No owner question with that id belongs to this owner.' });
      const filingChat = row.chatId === ctx.sessionId;
      const allowed = !!ctx.userTurnAt || filingChat || (await supervisorSeat(ctx.sessionId));
      if (!allowed) return out({ ok: false, tool: name, reason: 'scope', message: 'dismiss_owner_question is scoped to a supervisor seat, the chat that filed the question, or a user-present turn — a machine lane may not withdraw another lane\'s question. Continue with what the question does not block.' });
      const { dismissOwnerQuestion } = await import('./owner-questions');
      // abca56ce: the actor mirrors the scope gate's own precedence — a
      // user-present turn is the owner acting (even from a supervisor chat's
      // seat); a supervisor seat acting under standing directives is named as
      // itself, never "the owner"; the filing chat withdrawing its own card is
      // 'agent'. Review F5: derived in the gate's order so a supervisor seat
      // in a user-present turn cannot be stamped 'supervisor' for the owner's
      // own click, nor 'owner' for the supervisor's own tool call.
      const dismissedBy = filingChat && !ctx.userTurnAt ? 'agent' as const : ctx.userTurnAt ? 'owner' as const : 'supervisor' as const;
      const reason = typeof args?.reason === 'string' ? args.reason.slice(0, 200) : undefined;
      // OWNER-DISMISS-RAILS (2026-10-20): a SUPERVISOR seat on a machine turn
      // passes the same checks the answer path makes — owner-only class, the
      // owner engaged in the filing chat since the card was filed, and (for a
      // PROJECT supervisor) the card belongs to its own project. Each refusal
      // records owner_question_dismiss_refused. OWNER_DISMISS_RAILS_DISABLED=1.
      const seat = dismissedBy === 'supervisor' && !ownerDismissRailsDisabled() ? await supervisorSeatRole(ctx.sessionId) : null;
      if (seat) {
        const oqMod: any = await import('./owner-questions');
        if (typeof oqMod?.checkSupervisorDismissRails === 'function') {
          const rail = await oqMod.checkSupervisorDismissRails(
            { id: row.id, chatId: row.chatId, question: String(row.question ?? ''), context: row.context ?? null, createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt ?? 0), forChatId: row.forChatId ?? null, options: (row as any).options, expectedAnswerType: (row as any).expectedAnswerType, consoleAction: (row as any).consoleAction },
            seat,
          ).catch(() => ({ ok: true }));
          if (rail && rail.ok === false) {
            return out({ ok: false, tool: name, reason: rail.reason, questionId: row.id, ...(rail.detail ? { detail: rail.detail } : {}), message: dismissRailRefusalMessage(rail.reason) });
          }
        }
      }
      const r = await dismissOwnerQuestion(row.id, userId, { dismissedBy, reason, ...(seat ? { supervisorRole: seat.role } : {}) });
      if (r !== 'ok') return out({ ok: false, tool: name, reason: r, questionId: row.id, message: r === 'not_open' ? 'That question is no longer open (answered or dismissed already).' : 'Not found.' });
      try {
        const { recordLoopMetric, LOOP_METRIC_KINDS } = await import('./loop-metrics.service');
        recordLoopMetric({ kind: (LOOP_METRIC_KINDS as any).OWNER_QUESTION_DISMISSED_BY_AGENT ?? 'owner_question_dismissed_by_agent', sessionId: ctx.sessionId, meta: { questionId: row.id, by: dismissedBy, reason: reason ?? null, ...(seat ? { role: seat.role } : {}) } });
      } catch { /* telemetry never blocks */ }
      const actorText = dismissedBy === 'agent' ? 'the filing chat' : dismissedBy === 'owner' ? 'the owner (user-present turn)' : seat?.role === 'project' ? 'the project supervisor (standing directives)' : 'the Fleet Supervisor (standing directives)';
      return out({ ok: true, tool: name, questionId: row.id, dismissedBy, message: `Dismissed owner question ${short(row.id)} as ${actorText}${reason ? ` — ${reason}` : ''}; the filing lane was told not to re-raise it.` });
    }
    case 'cancel_confirmation': {
      const id = String(args?.confirmationId || '').trim();
      if (!id) return out({ ok: false, tool: name, reason: 'invalid', message: 'confirmationId is required.' });
      const pc = await import('./pending-confirmations');
      const row = await pc.getPendingConfirmation(id).catch(() => null);
      if (!row || row.userId !== userId) return out({ ok: false, tool: name, reason: 'not_found', message: 'No confirmation card of yours matches that id.' });
      const allowed = !!ctx.userTurnAt || row.chatId === ctx.sessionId || (await supervisorSeat(ctx.sessionId));
      if (!allowed) return out({ ok: false, tool: name, reason: 'scope', message: 'cancel_confirmation is scoped to the chat that staged the card, a supervisor seat, or a user-present turn.' });
      if (!(await pc.resolvePendingConfirmation(id, 'cancelled'))) return out({ ok: false, tool: name, reason: 'already_resolved', message: 'That card was already consumed, cancelled or expired.' });
      return out({ ok: true, tool: name, confirmationId: id, cancelledTool: row.tool, message: `Cancelled staged ${row.tool} card ${short(id)} ("${String(row.summary || '').slice(0, 120)}").` });
    }
    case 'list_pending_confirmations': {
      const pc = await import('./pending-confirmations');
      const rows = await pc.listPendingConfirmationsForUser(userId).catch(() => []);
      return out({ ok: true, tool: name, count: rows.length, cards: (rows as any[]).map((r) => ({ id: r.id, tool: r.tool, chatId: r.chatId, summary: r.summary, createdAt: r.createdAt, expiresAt: r.expiresAt })) });
    }
  }
}
