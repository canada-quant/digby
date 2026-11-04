/**
 * decision-gate-stall.ts — ticket 4d476b9a (2026-10-21): when a decision leg times out, was
 * it THIS PROCESS (an event-loop stall) or the WIRE (provider latency / egress)?
 *
 * The incident (prod 2026-10-21 16:58:25.352–25.835Z, then 17:00:44Z): five all_legs_failed
 * asks (memory_extract / task_kind / turn_plan), every one "TypeSafe Jev: timeout of
 * 595–1499ms exceeded" followed by "DeepSeek logprob readout: timeout of 249–1417ms
 * exceeded"; live probes right after answered (jev 221 ms, deepseek-flash 1067 ms). The leg
 * budgets carry the signature. decide() runs the legs IN SEQUENCE inside one deadline, so
 * on a 1200 ms ask Jev's share was 595 ms (legShareCap) and the readout should have started
 * with about 595 ms left. It started with 249–349 ms. So 250–350 ms passed between Jev's
 * timer coming due and the next leg's first line. That gap only opens when the timer fires
 * LATE, i.e. when the event loop was blocked (on the 16:58 asks the gap was about 170 ms on
 * the 1200 ms ask and about 80 ms on the 3000 ms memory_extract ask). After a stall, Node
 * runs expired timers BEFORE the poll phase reads the sockets, so a reply already sitting in
 * the socket buffer still loses to its own timeout. Every ask in flight across the stall then
 * fails together, on both legs.
 *
 * Three measures, all recorded on the rows:
 *   lateMs: wall clock at the leg's failure minus the leg's own deadline. Every post inside a
 *           leg sets its axios timeout to that deadline, so on a free loop a timeout fires AT
 *           it. A failure DECISION_STALL_LATE_MS or more late means the loop could not run
 *           the timer on time.
 *   busy:   performance.eventLoopUtilization() over the leg window. This is concurrency-safe
 *           because each leg diffs its own mark. A window at least
 *           DECISION_STALL_BUSY_UTILIZATION busy, with at least DECISION_STALL_BUSY_MIN_MS
 *           active, means the loop was saturated for most of the leg. A reply could not be
 *           read in that window even when the timer fired on time (a stall that ends just at
 *           the due time).
 *   dispatchLagMs / wireLateMs (round 2; round 3 marks EVERY post): axios (1.20 + follow-redirects) arms its
 *           wall-clock timer at the request's 'socket' event, not when the post computed its timeout, so a block between
 *           the post and that event delays the timer too — the backend then had its FULL wire budget and still did not
 *           answer, which is not a stall. The transport has no public hook for that event (a custom `transport` / agent
 *           would replace axios's redirect, proxy and body-limit handling), so every post a leg issues (callSystemOne's
 *           429 re-ask and the readout's bare re-post included — round 3) reports its issue time through `onPost`, and
 *           the leg schedules a setImmediate right then: the loop's first check phase after the post comes after the
 *           socket event (axios issues a JSON post with no await before transport.request, and Node emits 'socket' on the
 *           next tick). Every post's timeout is the leg deadline minus its issue time, so dispatchLagMs = that moment
 *           minus the LAST post's issue time is an UPPER bound on the arming delay of the timer that fired, and
 *           wireLateMs = lateMs − dispatchLagMs is a LOWER bound on how late it fired past its armed due time (with
 *           the default agent, which never queues a request for a free socket). Known limitation, erring toward
 *           counting the row and toward no retry, never toward an exemption: a stall that begins in the same loop turn
 *           as the post, after the socket event but before the check phase, is subtracted as if it were pre-dispatch.
 *           Unmeasured (the probe had not run by the failure) = lateness cannot confirm, only the meter can. Checked with
 *           real timers on axios 1.20 against a local server that never answers (200 ms timeout): 80 ms of synchronous
 *           work right after the post → lateMs 85, dispatchLagMs 85, wireLateMs 0 (not a stall); a 150 ms block from
 *           +150 ms → lateMs 102, dispatchLagMs 2, wireLateMs 100; a free loop → lateMs 3, wireLateMs 1.
 *
 * Two verdicts per failed attempt (round 2 splits what round 1 used for both):
 *   stall:          the CHEAP signal — a timeout ≥ DECISION_STALL_LATE_MS late (round 3: WIRE-late when the dispatch
 *                   probe measured it, so a block before the request left the process never buys the retry), or inside
 *                   a saturated window. It never exempts a row; it buys the one retry only where no later leg could
 *                   answer in what is left (round 4).
 *   stallConfirmed: the STRONG signal — a timeout inside a saturated window, or wireLateMs ≥
 *                   stallConfirmLateMs(budget) = max(DECISION_STALL_CONFIRM_LATE_MIN_MS,
 *                   DECISION_STALL_CONFIRM_LATE_SHARE × budget). Only this exempts a row from the streak / sweep, and
 *                   (round 4) only this buys a retry while a later leg could still answer: a 50 ms-late timer says the
 *                   loop was blocked for 50 ms, not that the other ~1,950 ms of a 2,000 ms budget went unanswered
 *                   because of it.
 *
 * What decide() does with the verdicts (DECISION_GATE_STALL_RECOVERY_DISABLED=1 turns all of it off, byte for byte):
 *   - a TIMEOUT the cheap signal explains may re-ask the SAME leg once per ask, inside the caller's deadline
 *     (stallRetryDeadline). Every ms a retry takes comes out of the window of the legs after it, so (round 4) the rule is:
 *       · no later leg can be called (none, or all auth-latched) → the whole residual: nobody else could use it;
 *       · less is left than every later leg's minimum useful budget (DECISION_STALL_LEG_NEED.minMs) → the later legs
 *         could not answer in it anyway, so the retry takes the whole residual (the incident's own 1200 ms asks: 300–430
 *         ms left against the readout's 500 ms minimum). The cheap signal is enough here: the later legs lose a window
 *         under their minimum;
 *       · otherwise a later leg could still answer in what is left, and the retry is taken ONLY on a CONFIRMED stall
 *         (stallConfirmed, the evidence the streak exemption uses) — and then bounded: at most its original budget, half
 *         of what is left (legShareCap) and what is left minus the later legs' reserve (laterLegsReserveMs) minus the
 *         lateness already seen. A timeout that was on time or only cheaply late (an unconfirmed stall) takes no retry
 *         there, so a later leg that could answer gets EXACTLY the budget the pre-ticket loop gave it (round 3 retried on
 *         the cheap signal and its fixed 1100 ms readout reserve cut a 4000 ms ask's readout from 1940 to 1100 ms);
 *       · in every branch a retry shorter than the retried leg's own minimum (and never under DECISION_STALL_RETRY_MIN_MS)
 *         is no retry: the ask falls through to the later legs exactly as before.
 *     What a retry can still cost: on a confirmed stall the later leg keeps its reserve (the readout ~1.1 s, about its
 *     p90) plus the lateness already seen, not its whole pre-ticket share; and in the full-residual branch it loses a
 *     window under its own minimum (a 1200 ms ask whose Jev timer fired 101–199 ms late leaves the readout 401–499 ms).
 *     An HTTP error, a refused connection, a parse error or a timeout on a free loop is never retried.
 *   - an ask whose every timed-out leg is a CONFIRMED stall (and nothing else failed) still writes its all_legs_failed
 *     row, with cause 'stall'. It does not advance the streak alert, and the infra-watch sweep does not count it
 *     either (the sweep re-checks the evidence on the row). A process that stalls is not a backend that is down; a
 *     backend that hangs on a free loop is, and counts (cause egress / mixed) exactly as before.
 * Pure leaf (perf_hooks, plus the one setImmediate of the dispatch probe): decide() and the
 * infra-watch sweep share one verdict and one switch.
 */
import { performance } from 'perf_hooks';

/** A timeout this late (ms past the leg's own deadline) means the event loop could not run the timer on time. */
export const DECISION_STALL_LATE_MS = 50;
/** Event-loop utilization over the leg window at or above which the loop was saturated. */
export const DECISION_STALL_BUSY_UTILIZATION = 0.8;
/** ...and the minimum active ms for the utilization verdict (a 3 ms window that ran hot is not a stall). */
export const DECISION_STALL_BUSY_MIN_MS = 200;
/** The stall retry needs at least this much of the caller's deadline left: of the measured decision backends only
 *  Laya (~85 ms) answers faster (Jev p50 140–164 ms), so a shorter retry would mostly add a second timeout. Every retry
 *  share must clear it, and (round 4, in every branch) the retried leg's own DECISION_STALL_LEG_NEED minMs too. */
export const DECISION_STALL_RETRY_MIN_MS = 100;
/** Round 3: the two backend kinds a decision leg can be (decision-gate.ts Backend['kind']). */
export type DecisionLegKind = 'systemone' | 'logit';
/**
 * Round 3: what a leg needs to answer, by backend kind — constants, not a live measure (a live p90 would make a slow
 * gateway readout look unanswerable and hand the retry its whole share, the opposite of what the readout needs).
 *   minMs:     a budget under which a healthy leg of this kind usually does NOT answer. A later leg with less than
 *              this left could not serve the ask anyway (the retry may then take the whole residual), and a retry of
 *              THIS kind with less than it is no retry (round 4: in every branch).
 *   reserveMs: what a bounded retry leaves a later leg of this kind (plus the lateness the loop already showed).
 * systemone — TypeSafe Jev p50 140–164 / p95 192 ms on ≤ 4k-char states (418- and 720-call replays, 2026-09-27),
 *             p50 265 / p90 320 ms on wake_triage's larger states; Laya ~85 ms. Round 4: minMs 200 → 120 — 200 sat ABOVE
 *             Jev's small-state p95, so "under this it usually misses" was false and a 120–199 ms Jev window that often
 *             answers counted as useless. 120 sits under Jev's measured small-state p50 (roughly its fast quartile if
 *             the spread is as tight as the p95 suggests — an estimate, not a measured percentile) and far under its
 *             large-state latency. Laya-class servers answer under it; the kind-level constant cannot tell them apart.
 * logit     — the DeepSeek logprob readout: one prefill per question in parallel, p50 569–900 ms / p90 ~1000 ms; the
 *             incident's own live probe answered in 1067 ms.
 */
export const DECISION_STALL_LEG_NEED: Readonly<Record<DecisionLegKind, { minMs: number; reserveMs: number }>> = {
  systemone: { minMs: 120, reserveMs: 400 },
  logit: { minMs: 500, reserveMs: 1100 },
};
/** An unknown kind is treated as the slower one: as a later leg it keeps the readout's reserve, as the retried leg it
 *  needs the readout's minimum. */
function legNeed(kind: string | undefined): { minMs: number; reserveMs: number } {
  return kind === 'systemone' ? DECISION_STALL_LEG_NEED.systemone : DECISION_STALL_LEG_NEED.logit;
}
/** Round 2 (the streak / sweep exemption): wire lateness that CONFIRMS a stall is at least this many ms… */
export const DECISION_STALL_CONFIRM_LATE_MIN_MS = 200;
/** …and at least this share of the attempt's budget. */
export const DECISION_STALL_CONFIRM_LATE_SHARE = 0.25;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** DECISION_GATE_STALL_RECOVERY_DISABLED=1: no stall attribution, no stall retry, no streak exemption (pre-4d476b9a). */
export function decisionStallRecoveryDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return onFlag(env.DECISION_GATE_STALL_RECOVERY_DISABLED);
}

// ── event-loop meter (performance.eventLoopUtilization, with a test seam) ────

export interface LoopBusy {
  /** ms the loop spent running callbacks (not waiting on I/O) inside the window. */
  activeMs: number;
  /** activeMs / window, 0..1. */
  utilization: number;
}
export interface LoopMeter {
  /** An opaque mark (null when the platform cannot measure). */
  mark(): unknown;
  /** The loop's busy share since `mark` (null when unmeasurable). */
  since(mark: unknown): LoopBusy | null;
}
type Elu = ReturnType<typeof performance.eventLoopUtilization>;
const perfMeter: LoopMeter = {
  mark: () => {
    try { return performance.eventLoopUtilization(); } catch { return null; }
  },
  since: (mark) => {
    if (!mark || typeof mark !== 'object') return null;
    try {
      const d = performance.eventLoopUtilization(mark as Elu);
      if (!Number.isFinite(d?.active) || !Number.isFinite(d?.utilization)) return null;
      return { activeMs: d.active, utilization: d.utilization };
    } catch {
      return null;
    }
  },
};
let meter: LoopMeter = perfMeter;
/** Seam: tests inject a fake meter; null restores performance.eventLoopUtilization. */
export function setDecisionLoopMeter(m: LoopMeter | null): void {
  meter = m ?? perfMeter;
}
export function loopMark(): unknown {
  try { return meter.mark(); } catch { return null; }
}
export function loopSince(mark: unknown): LoopBusy | null {
  try { return meter.since(mark); } catch { return null; }
}

// ── dispatch probe (when the loop first ran after a post was issued; a test seam) ──

/** `at` = epoch ms of the loop's first check phase after the post was issued; null until then (or unmeasurable). */
export interface DispatchMark { at: number | null }
/** Called right after a post is issued, with the moment its timeout was computed (round 3: every post of a leg). */
export type DispatchProbe = (issuedAt: number) => DispatchMark;
const immediateProbe: DispatchProbe = () => {
  const m: DispatchMark = { at: null };
  try {
    const h = setImmediate(() => { m.at = Date.now(); });
    // Never keeps the process alive on its own (a shutdown mid-leg).
    (h as any)?.unref?.();
  } catch { /* unmeasurable: lateness then cannot confirm a stall */ }
  return m;
};
let dispatchProbe: DispatchProbe = immediateProbe;
/** Seam: tests inject a deterministic probe; null restores the setImmediate probe. */
export function setDecisionDispatchProbe(p: DispatchProbe | null): void {
  dispatchProbe = p ?? immediateProbe;
}
export function dispatchMark(issuedAt: number): DispatchMark {
  try { return dispatchProbe(issuedAt) ?? { at: null }; } catch { return { at: null }; }
}
/** Round 3: the callback a leg's transport calls right after EACH post is issued (callSystemOne's 429 re-ask and the
 *  readout's bare re-post included), with the moment that post computed its timeout. Never throws into the transport. */
export type DecisionPostHook = (issuedAt: number) => void;
export function notePostIssued(hook: DecisionPostHook | undefined, issuedAt: number): void {
  if (!hook) return;
  try { hook(issuedAt); } catch { /* telemetry only: never fails the post */ }
}

// ── leg verdicts ─────────────────────────────────────────────────────────────

/** timeout = the provider call ran out of time (no HTTP status); budget = the leg had no time left to call at all
 *  (decide()'s own 'deadline exhausted'); error = anything the provider (or the network) actively answered. */
export type LegFailure = 'timeout' | 'budget' | 'error';

/** Pure: how a leg failed. Only a status-less axios timeout is a 'timeout'. */
export function legFailureOf(err: any): LegFailure {
  if (typeof err?.response?.status === 'number') return 'error';
  const msg = String(err?.message ?? err ?? '');
  if (/^deadline exhausted/i.test(msg)) return 'budget';
  const code = String(err?.code ?? '');
  if ((code === 'ECONNABORTED' || code === 'ETIMEDOUT') && /time ?out/i.test(msg)) return 'timeout';
  return 'error';
}

/** One failed leg attempt, as the rows carry it. */
export interface LegTiming {
  backend: string;
  /** 1 = the leg's first attempt, 2 = the stall retry. */
  attempt: 1 | 2;
  failure: LegFailure;
  /** The leg's own budget (its deadline minus its start). */
  budgetMs: number;
  elapsedMs: number;
  /** elapsedMs minus budgetMs: how late the failure landed past the leg's own deadline. */
  lateMs: number;
  /** Round 2: the dispatch probe minus the issue time of the leg's LAST post (round 3; round 2 used the leg start and
   *  the first post) — an upper bound on how long after that post computed its timeout the wire timer was armed
   *  (absent when the probe had not run by the failure). */
  dispatchLagMs?: number;
  /** Round 2: lateMs minus dispatchLagMs — a lower bound on how late the timer fired past its armed due time. */
  wireLateMs?: number;
  /** Event-loop active ms and utilization over the leg window (absent when unmeasurable). */
  busyMs?: number;
  busy?: number;
  /** The CHEAP signal (never an exemption; a retry only where no later leg could answer — round 4): a timeout ≥
   *  DECISION_STALL_LATE_MS late — wire-late when measured (round 3) — or in a saturated window. */
  stall: boolean;
  /** Round 2, the STRONG signal (the streak / sweep exemption): a timeout in a saturated window, or wire-late by at
   *  least stallConfirmLateMs(budgetMs). */
  stallConfirmed: boolean;
}

/** Pure: the loop meter says the leg window was saturated (≥ DECISION_STALL_BUSY_UTILIZATION busy, ≥ DECISION_STALL_BUSY_MIN_MS active). */
function loopSaturated(busy: LoopBusy | null | undefined): boolean {
  return !!busy && busy.activeMs >= DECISION_STALL_BUSY_MIN_MS && busy.utilization >= DECISION_STALL_BUSY_UTILIZATION;
}

/** Pure, the cheap signal: a timeout is stall-explained when it landed late or the loop was saturated over the leg window. */
export function stallExplains(failure: LegFailure, lateMs: number, busy: LoopBusy | null | undefined): boolean {
  if (failure !== 'timeout') return false;
  if (lateMs >= DECISION_STALL_LATE_MS) return true;
  return loopSaturated(busy);
}

/** Pure: the wire lateness that confirms a stall for an attempt of this budget — max(200 ms, 25 % of the budget). */
export function stallConfirmLateMs(budgetMs: number): number {
  const b = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0;
  return Math.max(DECISION_STALL_CONFIRM_LATE_MIN_MS, Math.ceil(DECISION_STALL_CONFIRM_LATE_SHARE * b));
}

/** Pure, the strong signal: a timeout the loop meter saw saturated, or one whose timer fired at least
 *  stallConfirmLateMs(budget) past its wire-armed due time. Unmeasured wire lateness never confirms on its own. */
export function stallConfirms(failure: LegFailure, wireLateMs: number | null | undefined, budgetMs: number, busy: LoopBusy | null | undefined): boolean {
  if (failure !== 'timeout') return false;
  if (loopSaturated(busy)) return true;
  return typeof wireLateMs === 'number' && Number.isFinite(wireLateMs) && wireLateMs >= stallConfirmLateMs(budgetMs);
}

/** Pure: the timing record of a failed leg attempt. `dispatchedAt` = the dispatch probe's reading (null / absent / later
 *  than the failure = unmeasured); `dispatchIssuedAt` = the issue time of the post it marks (default the leg start).
 *  Round 3: the cheap signal reads the WIRE lateness whenever it was measured — lateness the loop accrued before the
 *  request left the process (the backend still had its full wire budget) never buys the retry; raw lateness only when
 *  the probe had not run. */
export function legTiming(input: { backend: string; attempt: 1 | 2; err: any; legStart: number; legDeadlineAt: number; failedAt: number; busy: LoopBusy | null; dispatchedAt?: number | null; dispatchIssuedAt?: number }): LegTiming {
  const failure = legFailureOf(input.err);
  const budgetMs = Math.max(0, Math.round(input.legDeadlineAt - input.legStart));
  const elapsedMs = Math.max(0, Math.round(input.failedAt - input.legStart));
  const lateMs = Math.round(input.failedAt - input.legDeadlineAt);
  const d = input.dispatchedAt;
  const issuedAt = typeof input.dispatchIssuedAt === 'number' && Number.isFinite(input.dispatchIssuedAt) ? input.dispatchIssuedAt : input.legStart;
  const dispatchLagMs = typeof d === 'number' && Number.isFinite(d) && d <= input.failedAt ? Math.max(0, Math.round(d - issuedAt)) : undefined;
  const wireLateMs = dispatchLagMs === undefined ? undefined : lateMs - dispatchLagMs;
  return {
    backend: input.backend, attempt: input.attempt, failure, budgetMs, elapsedMs, lateMs,
    ...(dispatchLagMs !== undefined ? { dispatchLagMs, wireLateMs } : {}),
    ...(input.busy ? { busyMs: Math.round(input.busy.activeMs), busy: Number(input.busy.utilization.toFixed(3)) } : {}),
    stall: stallExplains(failure, wireLateMs ?? lateMs, input.busy),
    stallConfirmed: stallConfirms(failure, wireLateMs, budgetMs, input.busy),
  };
}

/**
 * Pure (round 4): how much of the caller's deadline the LATER legs need left so that EACH keeps its reserveMs under
 * decide()'s own sharing rule — a non-final leg gets min(legTimeoutMs, half of what is left) (decision-gate.ts
 * legShareCap), the last leg everything that is left. Round 3 kept only the slowest later leg's reserve (a max), so in a
 * three-leg chain the middle leg took half of it and a hung middle leg left the tail readout ~half its reserve. Walked
 * from the last leg back: a non-final leg in front of legs that need N needs R with R − min(T, ⌊R/2⌋) ≥ N (R ≥ 2N when
 * N ≤ T, else N + T) and min(T, ⌊R/2⌋) ≥ its own reserve (capped at T). With legTimeoutMs ≤ 0 (DECISION_GATE_LEG_TIMEOUT_MS
 * = 0: every leg gets the whole residual, so a hung later leg leaves the ones behind it nothing whatever is kept) only
 * the first later leg's reserve is kept. A single later leg needs exactly its own reserve, as in round 3.
 */
export function laterLegsReserveMs(laterKinds: ReadonlyArray<string>, legTimeoutMs: number): number {
  if (!laterKinds.length) return 0;
  if (!(Number.isFinite(legTimeoutMs) && legTimeoutMs > 0)) return legNeed(laterKinds[0]).reserveMs;
  let need = legNeed(laterKinds[laterKinds.length - 1]).reserveMs;
  for (let i = laterKinds.length - 2; i >= 0; i--) {
    const own = Math.min(legNeed(laterKinds[i]).reserveMs, legTimeoutMs);
    need = Math.max(need <= legTimeoutMs ? 2 * need : need + legTimeoutMs, 2 * own);
  }
  return need;
}

/** Round 3: what the stall retry is decided from. */
export interface StallRetryInput {
  /** When the failed attempt ended (the retry starts now). */
  now: number;
  /** The caller's deadline. */
  deadlineAt: number;
  /** The failed attempt's own budget: a bounded retry never gets more. */
  budgetMs: number;
  /** How late the failed attempt's timer fired. The retry's timer is expected to land as late, so a bounded retry
   *  leaves the later legs this much on top of their reserve. */
  lateMs: number;
  /** Round 4: the failed attempt was a CONFIRMED stall (LegTiming.stallConfirmed). Only that buys a retry while a later
   *  leg could still answer in what is left. */
  confirmed: boolean;
  /** The retried leg's kind: a retry shorter than its minimum useful budget is no retry. */
  ownKind?: string;
  /** The kinds of the LATER legs that can still be called (not auth-latched), in chain order. */
  laterKinds: ReadonlyArray<string>;
  /** Round 4: decide()'s per-leg cap (DECISION_GATE_LEG_TIMEOUT_MS) — how the later legs will share what is left. */
  legTimeoutMs: number;
}

/**
 * The stall-retry deadline, or null for no retry (the ask then falls through to the later legs exactly as before).
 * floor = max(DECISION_STALL_RETRY_MIN_MS, the retried leg's own minMs); round 4 applies it in EVERY branch — a retry
 * that cannot answer only adds a second timeout and, timing out on time, turns a cause-'stall' row into a counted one.
 *   - less than the floor of the caller's deadline left → null;
 *   - no later servable leg → the whole residual (the caller's deadline);
 *   - less left than the fastest later leg's minMs → the later legs could not answer in it anyway → the whole residual;
 *   - else a later leg could still answer in what is left: null unless the failed attempt was a CONFIRMED stall, then
 *     bounded — now + min(budgetMs, ⌊remaining / 2⌋, remaining − laterLegsReserveMs − lateMs), null under the floor.
 * Why CONFIRMED for the bounded retry, not the cheap signal (round 4 — the least surprising rule): there the retry is
 * paid for out of a window another leg can answer in, so it has to be the likelier answer. A timer ≥ 50 ms late on a
 * free-ish loop says the loop was blocked for 50 ms, not that the other ~1,950 ms of a 2 s window went unanswered
 * because of it; a healthy Jev (p95 ~0.2 s on small states, p90 ~0.3 s on large ones) misses a 1–2 s window only if
 * the loop stayed busy from its reply's arrival to the deadline, which the meter or the wire lateness then confirms. An
 * unconfirmed late timeout on such a leg is nearly always a slow or hung backend, and retrying it only shrinks the later
 * leg's window — round 3's fixed reserve then cost the readout its 1.1–1.9 s replies. So a hung first leg on a free loop
 * (on time, or only cheaply late) now leaves a later leg that could answer exactly its pre-ticket budget, and the
 * streak exemption and the bounded retry read the same evidence. On a SHORT window (a 1200 ms ask's 600 ms Jev share)
 * the confirm bar can miss a real stall; there a timer ≥ 101 ms late leaves the readout under its minimum, so the
 * full-residual branch still retries on the cheap signal, and at 50–100 ms late the readout keeps its pre-ticket
 * 500–550 ms. The bounded share is never more than decision-gate.ts legShareCap(budgetMs, remaining) (the non-final leg
 * rule).
 */
export function stallRetryDeadline(input: StallRetryInput): number | null {
  const { now, deadlineAt } = input;
  const remaining = deadlineAt - now;
  const floor = Math.max(DECISION_STALL_RETRY_MIN_MS, input.ownKind ? legNeed(input.ownKind).minMs : 0);
  if (!(remaining >= floor)) return null;
  const later = input.laterKinds ?? [];
  if (!later.length) return deadlineAt;
  const laterMinMs = Math.min(...later.map(k => legNeed(k).minMs));
  if (remaining < laterMinMs) return deadlineAt;
  if (input.confirmed !== true) return null;
  const late = Number.isFinite(input.lateMs) ? Math.max(0, input.lateMs) : 0;
  const share = Math.floor(Math.min(Math.max(0, input.budgetMs), remaining / 2, remaining - laterLegsReserveMs(later, input.legTimeoutMs) - late));
  if (!(share >= floor)) return null;
  return Math.min(deadlineAt, now + share);
}

/**
 * Why EVERY leg of an ask failed:
 *   stall    — every leg that called timed out and every one of those timeouts is a CONFIRMED stall;
 *   egress   — every leg that called timed out and none is a confirmed stall (provider latency or the network —
 *              a timer only cheaply late, e.g. 60 ms on a 2 s budget, on a free loop lands here);
 *   provider — no leg timed out (HTTP errors, refused connections, latched keys, bad bodies);
 *   mixed    — timeouts next to provider errors, or confirmed-stall timeouts next to unconfirmed ones;
 *   budget   — no leg got to call at all (the deadline was gone before the first post).
 * Only 'stall' is exempt from the streak alert. A mixed burst still counts.
 */
export type AllFailedCause = 'stall' | 'egress' | 'provider' | 'mixed' | 'budget';
export function classifyAllLegsFailed(legs: ReadonlyArray<Pick<LegTiming, 'failure' | 'stallConfirmed'>>, latchedSkips = 0): AllFailedCause {
  const timeouts = legs.filter(l => l.failure === 'timeout');
  const providerSide = legs.filter(l => l.failure === 'error').length + Math.max(0, latchedSkips);
  if (!timeouts.length) return providerSide > 0 ? 'provider' : 'budget';
  if (providerSide > 0) return 'mixed';
  const stalled = timeouts.filter(l => l.stallConfirmed).length;
  if (stalled === timeouts.length) return 'stall';
  if (stalled === 0) return 'egress';
  return 'mixed';
}

/** The tail decide() appends to the leg error of a failed STALL RETRY (attempt 2): ' [stall retry]', or
 *  '; stall retry]' closing a ' [loop stall: …' / ' [timer … late …' annotation. */
export const STALL_RETRY_LEG_ERROR_TAIL = 'stall retry]';
/** Pure: this legErrors entry is a failed stall retry — the SAME leg's second attempt within one ask, so per-backend
 *  call / failure counters (decision-gate-fit.ts) count it once with the first attempt, not as a second call. */
export function isStallRetryLegError(entry: unknown): boolean {
  return typeof entry === 'string' && entry.endsWith(STALL_RETRY_LEG_ERROR_TAIL);
}

/** Pure: a stored decision_gate_backend_down row that must NOT count toward the all-failed streak (the infra-watch
 *  sweep's twin of decide()'s in-process exemption). Round 2: the sweep re-checks the evidence on the row — cause
 *  'stall' AND legTimings carrying at least one timed-out attempt, every one of them `stallConfirmed: true` — so a
 *  row without the confirming measurement counts. Honours the kill switch of the reading process. */
export function isStallExemptAllFailedRow(meta: any, env: NodeJS.ProcessEnv = process.env): boolean {
  if (decisionStallRecoveryDisabled(env)) return false;
  if (!meta || typeof meta !== 'object' || meta.event !== 'all_legs_failed' || meta.cause !== 'stall') return false;
  const legs: any[] = Array.isArray(meta.legTimings) ? meta.legTimings : [];
  const timeouts = legs.filter(l => l && typeof l === 'object' && l.failure === 'timeout');
  return timeouts.length > 0 && timeouts.every(l => l.stallConfirmed === true);
}

/** The short clause the all-failed alert / log line carries for a cause. */
export function allFailedCauseText(cause: AllFailedCause): string {
  switch (cause) {
    case 'stall': return 'event-loop stall in this process (every timeout was confirmed: well past its due time, or in a saturated loop window)';
    case 'egress': return 'egress or provider latency (every leg timed out; no timeout was a confirmed event-loop stall)';
    case 'provider': return 'provider errors (no leg timed out)';
    case 'mixed': return 'mixed (timeouts and provider errors, or stall and free-loop timeouts)';
    default: return 'no leg had time to call (the caller budget was gone)';
  }
}
