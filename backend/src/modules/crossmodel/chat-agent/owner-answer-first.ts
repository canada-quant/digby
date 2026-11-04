/**
 * ANSWER-FIRST on OWNER turns in supervisor chats (build 2026-10-08 A1 —
 * audit 2026-10-08 architecture.md item D, stage D2; owner: "yes lets do all
 * this").
 *
 * WHAT THE AUDIT MEASURED: an owner message on a Fleet / Project Supervisor
 * chat waited p50 79 s / p90 256 s for its first word over 7 days (152 turns;
 * 31 % over 2 min, max 52.8 min). The wait is the tool loop — the first word
 * IS the final answer, and a 0-tool answer lands in p50 15 s while 9–20 tool
 * calls take p50 237 s. The state an answer needs ([SUPERVISOR STATE] +
 * [BOARD]) is already injected on owner turns, and turn continuation — the
 * plain-chat "Still working on this — I will post the result here" machinery
 * with its task card — never armed on supervisor chats.
 *
 * WHAT THIS DOES (D2, staged):
 *   1. a doctrine row replaces the 45-min budget line on the owner turn:
 *      answer the owner first from what is already in context;
 *   2. a SOFT DEADLINE (~45 s from the turn start): the agent loop's
 *      `endTurnAfterToolRound` hook (the same tools-off FINAL-TURN collapse
 *      the deadline uses) ends the tool rounds and the model answers with
 *      what it holds, closing with ONE "Follow-through: …" line; every loop
 *      invocation still gets its first tool round (a retry never starts
 *      tools-off);
 *   3. the remaining work runs as the EXISTING turn continuation
 *      (turn-continuation.ts, reason 'answer_first_split') on the supervisor
 *      profile, with the task card on the owner's chat — and the owner ASK
 *      closes only when that follow-through settles (done / failed), never on
 *      the split answer (supervisor-reply-row.ts skips a split answer while
 *      its card runs; the round's finalize closes the ask, source
 *      'continuation');
 *   4. "resume after the owner's turn": a newer owner message never DROPS a
 *      follow-through (no supersede) and an owner message that PREEMPTS a
 *      running round re-queues it to run right after the owner's turn
 *      (≤ ANSWER_FIRST_MAX_RESUMES), held from the queue drain for
 *      ANSWER_FIRST_PREEMPT_HOLD_MS so the owner's own turn starts first.
 * Machine wakes are untouched; the W6 material gate and drain_triage only see
 * AGENT rows (a continuation is a 'schedule' row without a schedule id), so
 * they never gate a follow-through round.
 *
 * The follow-through round runs MACHINE-triggered (origin 'schedule'), so the
 * supervisor harness-receipts finalize (platform/harness-receipts.ts) records
 * it — and with zero lane actions it used to close the owner's own answer with
 * the wake line 'WAKE: no-op (harness: 0 lane actions)' (prod 2026-10-22: the
 * Fleet Supervisor's owner replies read as stray no-op wakes). A round marked
 * by isAnswerFirstFollowThrough is the answer the owner was promised, so it
 * gets the owner-ask reply's neutral 'Harness record:' line instead (and its
 * note classifies as a plain note, never a wake no-op); executed actions list
 * under 'ACTIONS TAKEN (harness):' as for any wake. Kill switch
 * SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1 restores the no-op line.
 *
 * ONE switch, SUPERVISOR_OWNER_ANSWER_FIRST:
 *   unset / 'canary'  — DEFAULT (ticket 4f7263e4, 2026-10-10): act on the
 *                       default canary list (the owner's two busiest project
 *                       supervisors), shadow everywhere else. On an instance
 *                       where those id prefixes match no chat this is inert
 *                       (≡ shadow);
 *   'shadow'          — records only, everywhere;
 *   'canary[:id8,…]'  — act on the listed supervisor chats (8-hex id
 *                       prefixes; a bare list overrides the default);
 *   'act' / '1'       — act on every supervisor chat;
 *   'off' / '0'       — nothing runs, nothing is recorded (the kill switch).
 *   any other value  — SHADOW (fail-safe, review F1 2026-10-10): an operator who
 *                       set the variable expects it honored — a typo'd rollback
 *                       must never silently keep answer-first ACT. Only unset /
 *                       blank reads the canary default.
 * Act is held at shadow (meta.degraded 'continuation_off') while
 * TURN_CONTINUATION_DISABLED=1 / CONTINUATION_MAX_ROUNDS=0 — a split with no
 * follow-through would drop the owner's work.
 *
 * Telemetry (loop_metrics): `owner_answer_first` per owner turn (value = the
 * first-word ms; meta: mode, wouldSplitAtMs / splitAtMs, tools / mutations
 * before + after the split, followThrough, armed, verdict) — the bar is owner
 * first word p90 ≤ 90 s; `turn_continuation` rows carry `answerFirst:true` +
 * `duplicates` (mutating calls repeated from the answer turn) + `resumes` —
 * the bar is ≥ 95 % of armed follow-throughs reaching done / failed.
 *
 * Pure apart from the env read and the Redis helpers at the bottom (dynamic
 * import, fail-open) — the chat-agent run-start path loads it under thin mocks.
 */
import { firedReplayUnsafeTool } from './tool-call-leak';
import { CONTINUATION_LINE, type ContinuationRun, type RunEndVerdict } from './turn-continuation';

export const OWNER_ANSWER_FIRST_ENV = 'SUPERVISOR_OWNER_ANSWER_FIRST';
/** The audit's canary: the two busiest project supervisors by 7-day owner turns (41bd202a Schooltime, 99e63f86 StAnne). */
export const OWNER_ANSWER_FIRST_DEFAULT_CANARY: readonly string[] = Object.freeze(['41bd202a', '99e63f86']);
/** The soft deadline (from the owner turn's start) after which the answer is written with what the run holds. */
export const ANSWER_FIRST_DEADLINE_MS = 45_000;
/** Re-queues of a follow-through round an owner message preempted, per task. */
export const ANSWER_FIRST_MAX_RESUMES = 2;
/** How long the queue drain holds a re-queued round so the preempting owner turn starts first. */
export const ANSWER_FIRST_PREEMPT_HOLD_MS = 20_000;
/** The loop_metrics kind of the per-owner-turn row. */
export const OWNER_ANSWER_FIRST_METRIC = 'owner_answer_first';
/** The answer row's metadata stamp (supervisor-reply-row.ts reads it). */
export const OWNER_ANSWER_FIRST_META_KEY = 'ownerAnswerFirst';
/** The task-card note of a round paused by an owner message. */
export const ANSWER_FIRST_RESUME_NOTE = 'Paused for your newer message — the follow-through resumes right after it.';

export type OwnerAnswerFirstSetting = 'off' | 'shadow' | 'canary' | 'act';
export type OwnerAnswerFirstMode = 'off' | 'shadow' | 'act';

export interface OwnerAnswerFirstConfig {
  setting: OwnerAnswerFirstSetting;
  /** Lower-case 8+ hex chat-id prefixes the canary acts on. */
  canaryChats: string[];
}

const CHAT_PREFIX_RE = /^[0-9a-f][0-9a-f-]{7,35}$/;

/**
 * Parse SUPERVISOR_OWNER_ANSWER_FIRST. UNSET / BLANK reads the canary default (ticket
 * 4f7263e4, 2026-10-10): the shadow stage ran two days over the owner's two busiest project
 * supervisors (33 rows, 18 would-splits, owner first-word p90 239 s vs the module's own
 * ≤ 90 s bar) while three of the ten over-240 s turns of the ttft tail were exactly this
 * class — owner turns on the canary chats (99e63f86, would-split at 57 s / 53 s but still
 * answered at 391 s / 283 s). Canary ≡ shadow on any other instance (the default list's
 * id prefixes match nothing there), so the unset default stays inert outside prod.
 * Any OTHER unrecognized value fails SAFE to 'shadow' (review F1, 2026-10-10): an operator
 * who set the variable at all expects it honored — a typo'd rollback ('shaddow', trailing
 * garbage) must never leave answer-first ACT on the canary chats while the operator
 * believes it is off, with no warn and a 'canary' telemetry row indistinguishable from a
 * deliberate canary. The pre-4f7263e4 module read unknown as shadow for exactly this
 * reason; the flip must not convert that fail-safe into a fail-open.
 */
export function ownerAnswerFirstConfig(env: Record<string, string | undefined> = process.env): OwnerAnswerFirstConfig {
  const raw = String(env[OWNER_ANSWER_FIRST_ENV] ?? '').trim().toLowerCase();
  const colon = raw.indexOf(':');
  const head = colon >= 0 ? raw.slice(0, colon).trim() : raw;
  const list = colon >= 0 ? raw.slice(colon + 1) : '';
  const defaults = [...OWNER_ANSWER_FIRST_DEFAULT_CANARY];
  if (head === '0' || head === 'off' || head === 'false' || head === 'disabled') return { setting: 'off', canaryChats: [] };
  if (head === '1' || head === 'on' || head === 'true' || head === 'act') return { setting: 'act', canaryChats: [] };
  if (head === 'canary') {
    const chats = list.split(',').map((s) => s.trim()).filter((s) => CHAT_PREFIX_RE.test(s));
    return { setting: 'canary', canaryChats: list.trim() ? chats : defaults };
  }
  if (head === 'shadow') return { setting: 'shadow', canaryChats: [] };
  // Only unset/blank reads the canary default; everything else unknown is a typo → shadow.
  if (!raw) return { setting: 'canary', canaryChats: defaults };
  return { setting: 'shadow', canaryChats: [] };
}

export interface OwnerAnswerFirstResolution {
  mode: OwnerAnswerFirstMode;
  /** True when the act verdict came from the canary list. */
  canary: boolean;
  setting: OwnerAnswerFirstSetting;
  /** Set when an act verdict was held at shadow: turn continuation is off, so a split would drop the remaining work. */
  degraded?: 'continuation_off';
}

/**
 * The mode for ONE supervisor chat: canary acts only on its listed chats (shadow elsewhere). An act verdict is held at
 * SHADOW when the follow-through cannot run (`continuationAvailable: false` — TURN_CONTINUATION_DISABLED=1 or
 * CONTINUATION_MAX_ROUNDS=0): speed without the follow-through would drop the owner's work.
 */
export function resolveOwnerAnswerFirst(
  chatId: string,
  env: Record<string, string | undefined> = process.env,
  opts: { continuationAvailable?: boolean } = {},
): OwnerAnswerFirstResolution {
  const cfg = ownerAnswerFirstConfig(env);
  if (cfg.setting === 'off') return { mode: 'off', canary: false, setting: cfg.setting };
  let out: OwnerAnswerFirstResolution;
  if (cfg.setting === 'act') out = { mode: 'act', canary: false, setting: cfg.setting };
  else if (cfg.setting === 'canary') {
    const id = String(chatId ?? '').toLowerCase();
    const hit = cfg.canaryChats.some((p) => id.startsWith(p));
    out = { mode: hit ? 'act' : 'shadow', canary: hit, setting: cfg.setting };
  } else out = { mode: 'shadow', canary: false, setting: cfg.setting };
  if (out.mode === 'act' && opts.continuationAvailable === false) return { ...out, mode: 'shadow', degraded: 'continuation_off' };
  return out;
}

// ── Doctrine + the split notice ─────────────────────────────────────────────

/** Replaces the 45-min budget line on an acting owner turn (chat-agent chatDoctrine `deadlineNote`). */
export function answerFirstDoctrineLine(deadlineMs: number = ANSWER_FIRST_DEADLINE_MS): string {
  const s = Math.round(deadlineMs / 1000);
  return `- ANSWER FIRST — the owner is waiting on this reply. Answer their message first, from [SUPERVISOR STATE], [BOARD] and the transcript you already hold, and make only the reads the question itself needs — no survey or sweep before the answer. An action the owner asked for that takes one or two tool calls, do now. About ${s} s into this turn the harness ends your tool rounds and you write the answer; whatever is still left (dispatches, steers, todo / goal changes, verification) then runs automatically as a background follow-through on this chat and posts its result here — never hold the answer for it, and never ask the owner to confirm it.`;
}

/** The tools-off FINAL-TURN notice of the split. Starts with the FINAL TURN prefix so a correction round splices it (agent.ts grantToolRound). */
export function answerFirstSplitNotice(elapsedMs: number): string {
  const s = Math.max(1, Math.round(elapsedMs / 1000));
  return `[HARNESS NOTICE — not typed by the user] FINAL TURN: ANSWER FIRST — the owner has waited ${s} s, so tool calls end here and this answer goes to them now. Answer their message from what you hold: lead with the answer, then say plainly what is NOT done yet. Report only what the tool results above show — never describe a send, change or check as done unless its tool result is above. End with ONE line in exactly this form: "Follow-through: <the remaining actions, separated by ';'>" — or "Follow-through: none" when nothing is left. The harness runs the follow-through in the background right after this answer and posts its result in this chat; do not ask the owner to confirm, say the word or check back.`;
}

// ── The observer (the hook + the emit tap) ──────────────────────────────────

/** True when a tool name is a side-effecting (replay-unsafe) call. */
export function isMutatingToolName(name: string): boolean {
  return !!name && !!firedReplayUnsafeTool([{ type: 'tool_call', name }]);
}

export interface AnswerFirstSplit {
  /** ms from the turn start to the step boundary where the split fired (act) or would have fired (shadow). */
  atMs: number;
  toolsBefore: number;
  mutationsBefore: number;
}

export interface AnswerFirstObserver {
  readonly act: boolean;
  readonly deadlineMs: number;
  /** A fresh `endTurnAfterToolRound` hook for ONE agent-loop invocation — its first poll never splits. */
  hook(): () => string | null;
  /** The orchestrator's emit tap (counts tool calls in order). */
  observe(type: string, data: unknown): void;
  /** The first step boundary past the deadline (null = the turn answered inside it). */
  split(): AnswerFirstSplit | null;
  /** Tool names called so far, in order. */
  toolNames(): string[];
}

export function createAnswerFirstObserver(opts: { act: boolean; turnStartedAt: number; deadlineMs?: number; now?: () => number }): AnswerFirstObserver {
  const deadlineMs = opts.deadlineMs ?? ANSWER_FIRST_DEADLINE_MS;
  const now = opts.now ?? (() => Date.now());
  const names: string[] = [];
  let first: AnswerFirstSplit | null = null;
  return {
    act: opts.act,
    deadlineMs,
    hook() {
      let polls = 0;
      return () => {
        polls += 1;
        if (polls === 1) return null; // every invocation (first attempt, a retry) keeps its first tool round
        const elapsed = now() - opts.turnStartedAt;
        if (elapsed <= deadlineMs) return null;
        if (!first) first = { atMs: elapsed, toolsBefore: names.length, mutationsBefore: names.filter(isMutatingToolName).length };
        return opts.act ? answerFirstSplitNotice(elapsed) : null;
      };
    },
    observe(type, data) {
      if (type !== 'tool_call') return;
      const name = (data as { name?: unknown } | null)?.name;
      if (typeof name === 'string' && name) names.push(name);
    },
    split: () => first,
    toolNames: () => names.slice(),
  };
}

// ── The follow-through line ─────────────────────────────────────────────────

export interface FollowThrough {
  /** A "Follow-through:" line was written. */
  found: boolean;
  /** It said none / nothing. */
  none: boolean;
  /** The remaining actions (≤ 280 chars), or null. */
  items: string | null;
  /** The text without that line. */
  stripped: string;
}

const FOLLOW_THROUGH_LINE_RE = /^[ \t]*(?:[-*•>][ \t]*)?(?:\*\*|__)?[ \t]*follow[- ]?through[ \t]*(?:\*\*|__)?[ \t]*(?:\([^)\n]{0,40}\))?[ \t]*:[ \t]*(?:\*\*|__)?[ \t]*(.*?)[ \t]*$/gim;
const NONE_RE = /^(?:(?:none|nothing(?: (?:left|remains|else|more))?|n\/a|no (?:follow[- ]?through|further (?:action|work)))(?:$|[.,;:!]|\s*[—–-])|[-—–]+$)/i;

/** Parse the LAST "Follow-through: …" line of an answer. Pure. */
export function parseFollowThrough(text: string): FollowThrough {
  const t = String(text ?? '');
  let last: RegExpExecArray | null = null;
  FOLLOW_THROUGH_LINE_RE.lastIndex = 0;
  for (let m = FOLLOW_THROUGH_LINE_RE.exec(t); m; m = FOLLOW_THROUGH_LINE_RE.exec(t)) {
    last = m;
    if (m[0].length === 0) FOLLOW_THROUGH_LINE_RE.lastIndex += 1;
  }
  if (!last) return { found: false, none: false, items: null, stripped: t };
  const raw = String(last[1] ?? '').replace(/(?:\*\*|__)\s*$/, '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim().replace(/[.;,\s]+$/, '');
  const stripped = (t.slice(0, last.index) + t.slice(last.index + last[0].length)).replace(/\n{3,}/g, '\n\n').trim();
  const none = !raw || NONE_RE.test(raw);
  return { found: true, none, items: none ? null : raw.slice(0, 280), stripped };
}

/** The one continuation line of a split answer: names what is still running, never a question. */
export function followThroughContinuationLine(items: string | null | undefined): string {
  const i = String(items ?? '').replace(/\s+/g, ' ').trim().replace(/[.;,\s]+$/, '');
  return i ? `Still working on this in the background — ${i}. I will post the result here.` : CONTINUATION_LINE;
}

/**
 * The run-end verdict of an ACTING owner turn on a supervisor chat. `base` is
 * classifyRunEnd over the answer (the follow-through line stripped).
 *   - no split: only an OPEN PLAN written this run continues — offers and
 *     card hand-backs on supervisor answers stay exactly as they were;
 *   - split, "Follow-through: none": done (a question back stays the owner's);
 *   - split, the answer needs the owner (credentials, an ambiguous target —
 *     or a plain question with no follow-through items): waiting_user, no round;
 *   - split otherwise: continue 'answer_first_split' (mid-loop by construction —
 *     the loop was still calling tools when the deadline collapsed it).
 */
export function ownerAnswerFirstVerdict(input: { split: boolean; followThrough: FollowThrough; base: RunEndVerdict }): RunEndVerdict {
  const { base, followThrough } = input;
  if (!input.split) {
    return base.kind === 'continue' && (base.reason === 'unfinished_plan' || base.reason === 'deadline_unfinished_plan') ? base : { kind: 'done' };
  }
  if (followThrough.found && followThrough.none) return base.kind === 'waiting_user' ? base : { kind: 'done' };
  if (base.kind === 'waiting_user' && (base.reason !== 'clarifying_question' || !followThrough.items)) return base;
  return { kind: 'continue', reason: 'answer_first_split', ...(followThrough.items ? { matched: followThrough.items.slice(0, 120) } : {}) };
}

// ── The follow-through round's harness record (2026-10-22) ──────────────────

/** SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1|true|on — a follow-through round closes with the wake no-op line again. */
export function followThroughQuietZeroDisabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = String(env.SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * True when a run's continuation stash is an answer-first FOLLOW-THROUGH round — read from the marks this module and
 * turn-continuation.ts put on the stash, never from text: `answerFirst` (the owner turn's armNext mints it on round 1,
 * every later round and a re-queue after a preempt carry it, and a lost Redis stash recovers it from the prompt
 * marker's ` af=<n>` — recoverContinuationFromPrompt) or round 1's reason 'answer_first_split'. A plain continuation
 * (a human chat's offer / unfinished plan) carries neither. Pure.
 */
export function isAnswerFirstFollowThrough(continuation: Pick<ContinuationRun, 'answerFirst' | 'reason'> | null | undefined): boolean {
  if (!continuation) return false;
  return continuation.answerFirst != null || continuation.reason === 'answer_first_split';
}

// ── Duplicate-dispatch accounting ───────────────────────────────────────────

const TARGET_ARG_KEYS = ['chatId', 'targetChatId', 'sessionId', 'todoId', 'goalId', 'scheduleId', 'ticketId', 'feedbackId', 'id', 'projectId'];

/** "<tool>→<target>" for every MUTATING tool call in a run's parts (todo / goal creates key on their title). ≤ 16. Pure. */
export function mutatingCallSignatures(parts: ReadonlyArray<{ type?: string; name?: string; args?: unknown }> | null | undefined): string[] {
  const out: string[] = [];
  for (const p of parts ?? []) {
    if (p?.type !== 'tool_call' || typeof p.name !== 'string' || !isMutatingToolName(p.name)) continue;
    if (p.name === 'update_supervisor_state') continue; // the ledger merge is idempotent — never a duplicate dispatch
    const args = (p.args && typeof p.args === 'object') ? p.args as Record<string, unknown> : {};
    const key = TARGET_ARG_KEYS.find((k) => typeof args[k] === 'string' && String(args[k]).trim());
    let target = key ? String(args[key]).trim().slice(0, 8).toLowerCase() : '';
    if (!target && typeof args.title === 'string') target = `"${String(args.title).replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 40)}"`;
    const sig = `${p.name}→${target || '?'}`;
    if (!out.includes(sig)) out.push(sig);
    if (out.length >= 16) break;
  }
  return out;
}

/** Signatures of `round` that repeat one from the answer turn (`done`). Unknown-target signatures never count. Pure. */
export function duplicateSignatures(done: ReadonlyArray<string> | null | undefined, round: ReadonlyArray<string>): string[] {
  const prior = new Set((done ?? []).filter((s) => !s.endsWith('→?')));
  return round.filter((s) => prior.has(s));
}

/**
 * The sentence that tells a follow-through round it is not a wake (2026-10-22 minors): the core wake.close rule rides
 * every supervisor prompt, so a round could close the owner's answer with 'WAKE: no-op — nothing moved'. Omitted under
 * SUPERVISOR_FOLLOWTHROUGH_QUIET_ZERO_DISABLED=1 (the round then closes with the wake no-op line again by design).
 */
export const ANSWER_FIRST_NOT_A_WAKE_LINE = "This message finishes the owner's answer, not a wake — never close it with WAKE: no-op.";

/** The note appended to an answer-first continuation prompt (what is done, what remains, the owner's newest words govern). */
export function answerFirstContinuationNote(input: { items: string | null; done: ReadonlyArray<string> }, env: Record<string, string | undefined> = process.env): string {
  const done = input.done.length ? input.done.join('; ') : 'nothing that changes state';
  return [
    `ANSWER-FIRST FOLLOW-THROUGH: the owner already has your answer (your previous message in this chat) and was told this work continues in the background.${input.items ? ` It named: ${input.items}.` : ''}`,
    `Already executed in that answer turn — do NOT repeat: ${done}. Before any send, dispatch, todo / goal change or schedule, check it was not already done (its receipt, the todo state, the transcript).`,
    'If the owner has written since that answer, their newest message governs: change or drop this follow-through to match it and say so in one line.',
    'LEAD the result with what you did (ids, links) — this message is the follow-through result the owner was promised.',
    ...(followThroughQuietZeroDisabled(env) ? [] : [ANSWER_FIRST_NOT_A_WAKE_LINE]),
  ].join('\n');
}

// ── Telemetry ───────────────────────────────────────────────────────────────

export interface OwnerAnswerFirstMetricInput {
  chatId: string;
  scope: 'fleet' | 'project';
  resolution: OwnerAnswerFirstResolution;
  observer: AnswerFirstObserver;
  ttftMs: number | null;
  completionMs: number;
  followThrough: FollowThrough | null;
  verdict: string;
  armed: boolean;
  askMessageId?: string | null;
}

/** The `owner_answer_first` row's meta (value = the first-word ms). Pure. */
export function ownerAnswerFirstMetricMeta(input: OwnerAnswerFirstMetricInput): Record<string, unknown> {
  const s = input.observer.split();
  const names = input.observer.toolNames();
  const after = s ? names.slice(s.toolsBefore) : [];
  return {
    chatId: input.chatId,
    scope: input.scope,
    mode: input.resolution.mode,
    setting: input.resolution.setting,
    canary: input.resolution.canary,
    ...(input.resolution.degraded ? { degraded: input.resolution.degraded } : {}),
    deadlineMs: input.observer.deadlineMs,
    split: !!s,
    ...(input.resolution.mode === 'act' ? { splitAtMs: s?.atMs ?? null } : { wouldSplitAtMs: s?.atMs ?? null }),
    toolsBeforeSplit: s ? s.toolsBefore : names.length,
    mutationsBeforeSplit: s ? s.mutationsBefore : names.filter(isMutatingToolName).length,
    // Shadow: the mutating work an act run would have moved to the follow-through.
    toolsAfterSplit: after.length,
    mutationsAfterSplit: after.filter(isMutatingToolName).length,
    totalTools: names.length,
    ttftMs: input.ttftMs,
    completionMs: input.completionMs,
    followThrough: input.followThrough ? (input.followThrough.found ? (input.followThrough.none ? 'none' : 'items') : 'missing') : null,
    verdict: input.verdict,
    armed: input.armed,
    ...(input.askMessageId ? { askMessageId: String(input.askMessageId).slice(0, 8) } : {}),
  };
}

// ── Redis: the preempt marker + the drain hold (fail-open) ──────────────────

const PREEMPT_KEY = (chatId: string) => `af-preempt:${chatId}`;
const HOLD_KEY = (chatId: string) => `af-hold:${chatId}`;
/** A cancel applies at the next step boundary — a marker older than this reads as a Stop (the card settles "stopped"). */
const PREEMPT_TTL_SEC = 180;

async function redis(): Promise<any | null> {
  try { return (await import('../../../config/redis')).default as any; } catch { return null; }
}

/** preemptMachineRunForUserMessage: an OWNER message is cancelling this chat's machine run (vs a Stop). Never throws. */
export async function markChatRunPreempted(chatId: string): Promise<void> {
  try { await (await redis())?.set(PREEMPT_KEY(chatId), String(Date.now()), { EX: PREEMPT_TTL_SEC }); } catch { /* best-effort */ }
}

/** Read-and-clear the preempt marker (a cancelled round's finalize). false on any error — a Stop stays a Stop. */
export async function takeChatRunPreempted(chatId: string): Promise<boolean> {
  try {
    const r = await redis();
    if (!r) return false;
    const v = await r.get(PREEMPT_KEY(chatId));
    if (v == null) return false;
    await r.del(PREEMPT_KEY(chatId)).catch(() => {});
    return true;
  } catch { return false; }
}

/** Hold a re-queued follow-through from the queue drain until the preempting owner turn has started. Never throws. */
export async function setFollowThroughHold(chatId: string, ms: number = ANSWER_FIRST_PREEMPT_HOLD_MS, now: number = Date.now()): Promise<void> {
  try { await (await redis())?.set(HOLD_KEY(chatId), String(now + ms), { EX: Math.ceil(ms / 1000) + 5 }); } catch { /* best-effort */ }
}

/** ms left on the drain hold (0 = none / expired / unreadable — the drain proceeds). */
export async function followThroughHoldMs(chatId: string, now: number = Date.now()): Promise<number> {
  try {
    const v = await (await redis())?.get(HOLD_KEY(chatId));
    const until = Number(v);
    return Number.isFinite(until) && until > now ? until - now : 0;
  } catch { return 0; }
}
