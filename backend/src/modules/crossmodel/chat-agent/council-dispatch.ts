/**
 * Council dispatch bounding (ticket 9aedb32f, 2026-09-29).
 *
 * Problem: a `dispatch_colleagues` round raced each colleague run against a
 * 12-minute ceiling and, when the ceiling won, resolved with a placeholder
 * note — the lead answered alone (deep-research quota paid for a single-model
 * run) with NO retry, NO telemetry, and NO user-visible notice. Observed in
 * chat 2f25f493 (2026-09-29): every dispatch timed out, zero council reports.
 *
 * Why colleagues blow the ceiling: the ceiling bounds the LEAD's wait, not the
 * colleague's budget (colleague runs are deadline-bounded at ~30 min — see
 * COUNCIL_COLLEAGUE_BACKSTOP_MS — and a full-budget run legitimately outlives
 * the 12-minute dispatch window). A wedge (provider stall, stuck tool call)
 * also outlives it. Those two cases need different treatment:
 *   - wedged  → ONE fresh retry of the mission (fresh run, fresh provider
 *     connection); the timed-out attempt is cancelled by the CALLER via its
 *     cancel latch so it stops spending and cannot interleave streams.
 *   - slow    → the terminal straggler keeps running (established doctrine:
 *     stragglers are never killed at the terminal attempt) and its report is
 *     handed to the lead's council-note inbox when it lands (onLateReport)
 *     instead of being silently discarded.
 *
 * Everything timer-driven is injectable so tests drive ceilings by hand.
 */

export const COUNCIL_DISPATCH_CEILING_MS = 12 * 60_000;
export const COUNCIL_DISPATCH_MAX_ATTEMPTS = 2;

export type CouncilTimer = { set(cb: () => void, ms: number): unknown; clear(handle: unknown): void };

/**
 * DEEP RESEARCH HAS NO WALL CLOCK (owner 2026-10-20: "deep research shouldn't have any limit"). The L3 preset, the
 * turn-plan research lane and the Dig-deeper research rung used to run under six stacked clocks — the lead's 40-min
 * final-turn backstop, the colleagues' 9-min (retry 3-min) fitted deadlines inside a 12 / 6-min dispatch wait, and on
 * the rung a 15-min budget for the whole council. Every one of them ended research that was still PROGRESSING. Now:
 *   - no council profile carries a final-turn deadline; the step caps (lead 24 / colleague 16 / clone 8) are the
 *     termination guarantee;
 *   - every council model turn runs a token-idle STALL watchdog (coding-model.ts runModelTurn `stallMs`) — a stream
 *     that delivers no token for COUNCIL_STALL_MS is cut with ESTALL and the agent loop's transient lane retries it;
 *   - the lead waits for a colleague while it PROGRESSES (any event, or a tool in flight) and gives up on an attempt
 *     only after 1.5 × COUNCIL_STALL_MS without progress (the colleague's own in-run retry acts first); reasoning
 *     alone is bounded progress (councilReasoningOnlyMs) and a looping reasoning stream ends its turn
 *     (coding-model.ts looksReasoningLoop);
 *   - a stalled colleague's late report is never dropped (council-late-addendum.ts markDelivered / track).
 * Release switch RESEARCH_NO_WALL_CLOCK_DISABLED=1 restores today's clocks byte-for-byte. Ops knob COUNCIL_STALL_MS
 * (default 10 min, clamped 2..60 min).
 */
export const researchNoWallClockDisabled = (): boolean => process.env.RESEARCH_NO_WALL_CLOCK_DISABLED === '1';
export const researchNoWallClock = (): boolean => !researchNoWallClockDisabled();

export const COUNCIL_STALL_MS_DEFAULT = 10 * 60_000;
export const COUNCIL_STALL_MS_MIN = 2 * 60_000;
export const COUNCIL_STALL_MS_MAX = 60 * 60_000;
/** COUNCIL_STALL_MS — how long a council model stream may go without a single token (default 10 min; blank /
 *  garbage ⇒ the default; clamped 2..60 min so a typo can neither cut a thinking model nor disable the watchdog). */
export function councilStallMs(): number {
  const raw = process.env.COUNCIL_STALL_MS;
  if (raw === undefined || String(raw).trim() === '') return COUNCIL_STALL_MS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return COUNCIL_STALL_MS_DEFAULT;
  return Math.min(COUNCIL_STALL_MS_MAX, Math.max(COUNCIL_STALL_MS_MIN, Math.floor(n)));
}
/**
 * The colleague's own longest silent wait for a model RESPONSE: coding/agent.ts gives every chat-profile model call a
 * 290 s per-call timeout and runModelTurn's stall mode waits max(that, stallMs) for the response headers, so a
 * colleague whose request is still legitimately pending emits nothing for up to that long (review 2026-10-20).
 */
export const COUNCIL_TURN_HEADER_WAIT_MS = 290_000;
/**
 * The dispatch wait's idle bound: 1.5 × the colleague's longest own silent wait — the stream stall, or the 290 s
 * pre-header wait when COUNCIL_STALL_MS is set below it (below ~193 s, 1.5 × the stall alone was SHORTER than the
 * header wait, so the lead gave up on a request still pending) — so the colleague's own stall / timeout retry always
 * acts first. Pure.
 */
export const COUNCIL_DISPATCH_STALL_FACTOR = 1.5;
export function councilDispatchStallMs(stallMs: number = councilStallMs()): number {
  return Math.round(Math.max(stallMs, COUNCIL_TURN_HEADER_WAIT_MS) * COUNCIL_DISPATCH_STALL_FACTOR);
}
/**
 * Reasoning alone is BOUNDED liveness (review 2026-10-20): a colleague stuck in a looping or endless reasoning stream
 * emits an event per reasoning token, so counted as progress it held the lead's wait for hours. Reasoning keeps a seat
 * alive for at most this long past its last MATERIAL event (answer text, a tool call or result, a harness progress
 * line — anything but reasoning); beyond it the reasoning-only time counts as idle, so a seat that only reasons is
 * given up after this + the dispatch window = 2 × councilDispatchStallMs (30 min by default). Pure.
 */
export function councilReasoningOnlyMs(stallMs: number = councilStallMs()): number {
  return councilDispatchStallMs(stallMs);
}
/**
 * How long the late-findings follow-up (council-late-addendum.ts settle) keeps posting tracked stragglers' findings
 * after its first flush (review 2026-10-20): 6 × COUNCIL_STALL_MS (60 min by default). A straggler is a colleague the
 * lead already gave up on — a finding in hand is posted at once; this only bounds the wait for one that never lands.
 */
export const COUNCIL_LATE_STRAGGLER_WAIT_FACTOR = 6;
export function councilLateStragglerWaitMs(stallMs: number = councilStallMs()): number {
  return stallMs * COUNCIL_LATE_STRAGGLER_WAIT_FACTOR;
}
/**
 * A tool in flight counts as progress for at most this long past the seat's last event — mirrors coding/agent.ts
 * TOOL_HARD_TIMEOUT_MS (every leaf tool is aborted there), so a tool_start whose tool_end never arrives can not hold
 * the lead's wait open forever. spawn_self (exempt from the hard timeout) is covered by its clone's own events.
 */
export const COUNCIL_TOOL_IN_FLIGHT_GRACE_MS = 15 * 60_000;

/** Per-attempt progress of one council seat (colleague + its clones). `lastMaterialAt` = the last NON-reasoning event. */
export interface CouncilSeatProgress { lastAt: number; lastMaterialAt: number; toolsInFlight: number }
export type CouncilProgressEvent = 'event' | 'reasoning' | 'tool_start' | 'tool_end';
export function createSeatProgress(now: number = Date.now()): CouncilSeatProgress {
  return { lastAt: now, lastMaterialAt: now, toolsInFlight: 0 };
}
export function noteSeatProgress(p: CouncilSeatProgress, e: CouncilProgressEvent, now: number = Date.now()): void {
  p.lastAt = now;
  if (e !== 'reasoning') p.lastMaterialAt = now;
  if (e === 'tool_start') p.toolsInFlight += 1;
  else if (e === 'tool_end') p.toolsInFlight = Math.max(0, p.toolsInFlight - 1);
}
/**
 * How long the seat has made no progress: 0-ish while a tool runs (up to the tool grace), else since its last event —
 * and, with a finite `reasoningOnlyMs` (councilReasoningOnlyMs), the reasoning-only time past that allowance (never
 * below the tool grace while a tool is in flight, so a clone's reasoning under a running spawn_self never undercuts
 * it). `reasoningOnlyMs` omitted ⇒ reasoning is unbounded progress. Pure.
 */
export function seatIdleMs(p: CouncilSeatProgress, now: number = Date.now(), toolGraceMs: number = COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, reasoningOnlyMs: number = Number.POSITIVE_INFINITY): number {
  const raw = Math.max(0, now - p.lastAt);
  const idle = p.toolsInFlight > 0 ? Math.max(0, raw - toolGraceMs) : raw;
  if (!Number.isFinite(reasoningOnlyMs)) return idle;
  const allowance = p.toolsInFlight > 0 ? Math.max(reasoningOnlyMs, toolGraceMs) : reasoningOnlyMs;
  return Math.max(idle, Math.max(0, now - p.lastMaterialAt - allowance));
}

/**
 * A "real" report is colleague research the lead can synthesize from.
 * `runColleague` reports failures as parenthesised lead-directives
 * (`(X failed: …)`, `(X unavailable …)`, `(no report produced)`) and the
 * ceiling adds `(X is still working past …)` / the stall `(X stopped responding …)` — none of those are research.
 */
export function isRealCouncilReport(text: string): boolean {
  const t = (text || '').trim();
  if (!t || t === '(no report produced)') return false;
  return !/^\([^()]*(?:failed|unavailable|still working past|stopped responding)[^()]*\)$/i.test(t);
}

/**
 * A straggler's late text worth posting as a late FINDING (no wall clock, 2026-10-20): real research only — never a
 * failure note, nor the "(Stopped.)" a cancelled (abandoned) attempt's loop returns. Pure.
 */
export function isLateCouncilFinding(text: string): boolean {
  const t = (text || '').trim();
  return t !== '(Stopped.)' && isRealCouncilReport(t);
}

/** The note the lead receives when a colleague never reports in budget —
 *  wording unchanged from the pre-retry race so lead behaviour is stable. */
export function councilCeilingPlaceholder(persona: string, ceilingMs: number): string {
  return `(${persona} is still working past the ${Math.round(ceilingMs / 60000)}-minute dispatch ceiling — proceed with the reports you have; late findings may still arrive as council notes.)`;
}

/** No-wall-clock twin of councilCeilingPlaceholder: the colleague STALLED (no progress for the window), it did not run out of time. */
export function councilStalledPlaceholder(persona: string, stallMs: number): string {
  return `(${persona} stopped responding — no progress for ${Math.round(stallMs / 60000)} minutes — proceed with the reports you have; late findings may still arrive as council notes.)`;
}

/**
 * audit 2026-10-08 W4-8 — a Dig-deeper RESEARCH rung's colleagues are FITTED inside the lead's dispatch wait.
 * The rung gives each colleague what is LEFT of its 15-min budget as its FINAL-TURN deadline (compute-policy-wiring
 * researchRungDeadlineMs — ~13.5 min at a 1.5-min dispatch), while the lead waits only COUNCIL_DISPATCH_CEILING_MS
 * (12 min) and then retries at half. A colleague that used its budget was therefore GUARANTEED to time out: prod
 * 10-08 (chat 182f27b7) both seats timed out at 720 s twice and at 360 s on the terminal attempt, the lead shipped a
 * degraded synthesis 26 min into the re-run, and the three real reports landed 2 min AFTER it as a late addendum.
 * On a budgeted rung the colleague's deadline is now min(left budget, ceiling − FINAL_TURN_GRACE) so its forced
 * final report lands inside the wait, the wait is that deadline + the grace, and there is ONE attempt (a half-ceiling
 * retry would push the lead past the rung budget). The L3 preset keeps its plain backstops + the retry.
 * Kill switch RESEARCH_RUNG_COLLEAGUE_FIT_DISABLED=1.
 */
export const COUNCIL_FINAL_TURN_GRACE_MS = 3 * 60_000;
export const researchRungColleagueFitDisabled = (): boolean => process.env.RESEARCH_RUNG_COLLEAGUE_FIT_DISABLED === '1';
/**
 * The L3 PRESET had the same guaranteed timeout (2026-10-20 real-user audit): its colleagues ran on the plain 30-min
 * backstop (clones 15 min) against the lead's 12-min dispatch wait — prod 7 d: every dispatch timed out on attempt 1
 * AND on the terminal retry (4 + 4 council_dispatch_timeout rows over 3 research turns); a probe's research report took
 * 35.7 min with both seats restarted at 12 min. The preset now fits colleague / clone FINAL-TURN deadlines inside the
 * wait too (fitColleagueDeadline of the backstop — 9 min), so the forced final report lands before the ceiling. The
 * lead keeps its 40-min backstop and the dispatch keeps its retry (a genuinely wedged attempt still restarts).
 * Kill switch COUNCIL_PRESET_COLLEAGUE_FIT_DISABLED=1.
 */
export const councilPresetColleagueFitDisabled = (): boolean => process.env.COUNCIL_PRESET_COLLEAGUE_FIT_DISABLED === '1';
/** The colleague's FINAL-TURN deadline fitted inside the dispatch wait (floor 60 s). Pure. */
export function fitColleagueDeadline(deadlineMs: number, ceilingMs: number = COUNCIL_DISPATCH_CEILING_MS, graceMs: number = COUNCIL_FINAL_TURN_GRACE_MS): number {
  const d = Number.isFinite(deadlineMs) ? deadlineMs : ceilingMs;
  return Math.max(60_000, Math.min(d, ceilingMs - graceMs));
}
/** The lead's wait for a fitted colleague: its deadline + the final-turn grace, never past the standard ceiling. Pure. */
export function fittedDispatchCeiling(deadlineMs: number, ceilingMs: number = COUNCIL_DISPATCH_CEILING_MS, graceMs: number = COUNCIL_FINAL_TURN_GRACE_MS): number {
  const d = Number.isFinite(deadlineMs) ? deadlineMs : ceilingMs;
  return Math.min(ceilingMs, d + graceMs);
}

/** Attempt 1 gets the full ceiling; a retry gets HALF (floor 60 s) so the
 *  worst-case lead wait stays bounded at 1.5× the ceiling (18 min at 12 min)
 *  while a fresh — merely unwedged — run, typically minutes, still completes
 *  comfortably. */
export function councilAttemptCeiling(ceilingMs: number, attempt: number): number {
  return attempt <= 1 ? ceilingMs : Math.max(Math.round(ceilingMs / 2), 60_000);
}

export interface BoundedColleagueOutcome {
  /** The report text for the lead (real report, failure note, or ceiling placeholder). */
  report: string;
  /** True when a colleague actually reported research (see isRealCouncilReport). */
  realReport: boolean;
  /** True when the FINAL attempt hit the ceiling (no report in budget). */
  timedOut: boolean;
  /** How many colleague runs were started (1, or 2 when a retry was armed). */
  attempts: number;
}

export interface BoundedColleagueDeps {
  persona: string;
  /** Starts one colleague attempt; resolves to its report text (never rejects — runColleague catches). Receives the
   *  attempt number and THIS attempt's ceiling so the caller can fit the colleague's deadline inside it (2026-10-20). */
  run: (attempt?: { attempt: number; ceilingMs: number }) => Promise<string>;
  classify?: (text: string) => boolean;
  /** Fired when an attempt hits the ceiling; `terminal` = no retry follows (caller flips its cancel latch when !terminal). */
  onTimeout?: (info: { attempt: number; attempts: number; terminal: boolean; ceilingMs: number }) => void;
  /** Fired (at most once, async) when a TERMINAL straggler still finishes later — its report, not lost. */
  onLateReport?: (text: string) => void;
  ceilingMs?: number;
  maxAttempts?: number;
  retryDisabled?: boolean;
  timer?: CouncilTimer;
  /**
   * No-wall-clock mode (RESEARCH_NO_WALL_CLOCK, 2026-10-20): an attempt ends only when the colleague has made NO
   * progress for `ms` (`idleMs() > ms`, polled every `pollMs`) — a colleague that keeps working is never timed out —
   * and every attempt gets the same window (no half-ceiling retry). `ceilingMs` is ignored. Absent ⇒ the ceiling.
   */
  stall?: { ms: number; idleMs: () => number; pollMs?: number };
  /** Fired with the run promise of every attempt the wait gave up on (the cancelled one AND the terminal straggler)
   *  so the caller can await them before it flushes late findings (council-late-addendum.ts track). */
  onStraggler?: (p: Promise<string>) => void;
}

export async function runBoundedColleague(deps: BoundedColleagueDeps): Promise<BoundedColleagueOutcome> {
  const ceilingMs = deps.ceilingMs ?? COUNCIL_DISPATCH_CEILING_MS;
  const maxAttempts = deps.retryDisabled ? 1 : Math.max(1, deps.maxAttempts ?? COUNCIL_DISPATCH_MAX_ATTEMPTS);
  const timer: CouncilTimer = deps.timer ?? { set: setTimeout, clear: clearTimeout };
  const classify = deps.classify ?? isRealCouncilReport;
  const stall = deps.stall;

  for (let attempt = 1; ; attempt += 1) {
    const terminal = attempt >= maxAttempts;
    const attemptCeiling = stall ? stall.ms : councilAttemptCeiling(ceilingMs, attempt);
    let runP: Promise<string>;
    try {
      runP = Promise.resolve(deps.run({ attempt, ceilingMs: attemptCeiling }));
    } catch {
      runP = Promise.resolve('');
    }
    let ceilHandle: unknown;
    const settled = await new Promise<{ kind: 'run'; text: string } | { kind: 'ceiling' }>(resolve => {
      let done = false;
      if (stall) {
        // Progress-based wait: re-arm a poll; resolve 'ceiling' only once the colleague has been idle past the window.
        const pollMs = Math.max(1_000, Math.round(stall.pollMs ?? Math.min(30_000, stall.ms / 6)));
        const poll = () => {
          if (done) return;
          if (stall.idleMs() > stall.ms) { done = true; resolve({ kind: 'ceiling' }); return; }
          ceilHandle = timer.set(poll, pollMs);
        };
        ceilHandle = timer.set(poll, pollMs);
      } else {
        ceilHandle = timer.set(() => { if (!done) { done = true; resolve({ kind: 'ceiling' }); } }, attemptCeiling);
      }
      runP.then(
        text => { if (!done) { done = true; timer.clear(ceilHandle); resolve({ kind: 'run', text: String(text ?? '') }); } },
        () => { if (!done) { done = true; timer.clear(ceilHandle); resolve({ kind: 'run', text: '' }); } },
      );
    });
    if (settled.kind === 'run') {
      const text = settled.text;
      return { report: text || '(no report produced)', realReport: classify(text), timedOut: false, attempts: attempt };
    }
    deps.onTimeout?.({ attempt, attempts: maxAttempts, terminal, ceilingMs: attemptCeiling });
    if (terminal) {
      // Doctrine: the terminal straggler keeps running. Its report is no
      // longer discarded — hand it to the caller's inbox hook. The .catch
      // keeps a late rejection from becoming an unhandledRejection.
      runP.then(text => { const t = String(text ?? '').trim(); if (t) deps.onLateReport?.(t); }).catch(() => {});
      deps.onStraggler?.(runP);
      return { report: stall ? councilStalledPlaceholder(deps.persona, stall.ms) : councilCeilingPlaceholder(deps.persona, ceilingMs), realReport: false, timedOut: true, attempts: attempt };
    }
    // Non-terminal: the caller cancels this attempt's run via its latch so
    // it stops spending. A truly wedged attempt (a stuck tool call, a dead
    // provider connection) never wakes to check its cancel flag — it can
    // still finish later, and its report must not be silently discarded:
    // hand a late-arriving report to the same onLateReport inbox hook the
    // terminal straggler uses (the lead may still be alive and drain it;
    // if not, the drop is no worse than pre-retry behaviour). The .catch
    // keeps an abandoned rejection from crashing the process.
    runP.then(text => { const t = String(text ?? '').trim(); if (t) deps.onLateReport?.(t); }).catch(() => {});
    deps.onStraggler?.(runP);
  }
}

/**
 * A council seat named by the lead or a colleague → the seat key (audit
 * 2026-10-03): the lead's doctrine used to name the colleagues 'deepseek' /
 * 'glm' while dispatch_colleagues / send_note accept only the seat keys, so a
 * call that followed the prose was refused — and still spent one of the
 * MAX_DISPATCH_ROUNDS — and a note to 'glm' was dropped while reporting
 * "Note delivered". The legacy persona names alias forward (the seats' models
 * are admin-set; in prod neither is DeepSeek-direct or GLM). Pure.
 */
export function normalizeCouncilSeat(raw: unknown): 'double_checker' | 'triple_checker' | null {
  const k = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (k === 'double_checker' || k === 'double' || k === 'deepseek') return 'double_checker';
  if (k === 'triple_checker' || k === 'triple' || k === 'glm') return 'triple_checker';
  return null;
}
