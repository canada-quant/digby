/**
 * REPLAY — ticket 9ecabc73 (defect family: severed-write).
 *
 * THE REPORT. A supervisor chat dispatched `computer_task` / `browser_task` with
 * the platform's own stated contract — "its result will arrive as a
 * [BACKGROUND TOOL RESULT] harness message" / "the result will land in the
 * transcript" — and the result never arrived. Three sightings, and the reporter's
 * distinguishing probe (a third dispatch) proved the IN-RUN channel works, so the
 * loss had to be at a boundary rather than in the channel itself.
 *
 * THE DEFECT, precisely. The registry has two loss windows at run end and the old
 * run-end path treated both as prose:
 *
 *   · WINDOW A — SETTLED BUT NEVER DRAINED. The call finished after the last step
 *     boundary, so `ready[]` holds the FULL result … and `closeRun()` returned
 *     bare ids, so the caller could not post what it was holding. The only trace
 *     was `agentWarn` + `emit('progress')` — neither of which is a transcript
 *     row. The result EXISTED and was unreachable. This is the window the
 *     production metric rows for the reported call show: `threshold_crossed` at
 *     15:09:09Z, then two `orphaned` rows (15:10:14Z, 15:10:33Z) and no
 *     `delivered` row.
 *   · WINDOW B — STILL RUNNING AT RUN END. Nothing cancels the work (the
 *     `tool-hard-timeout` discipline), so it completes seconds later; the settle
 *     path saw `closed === true` and dropped the result into a log line.
 *
 * THE CONTRACT THESE TESTS PIN, and it is the ticket's own acceptance bar: a
 * dispatched background tool result either LANDS (a transcript message carrying
 * the real result text) or SURFACES A TERMINAL STATUS (a message saying it is
 * still running and will be posted) — never silence.
 *
 * These tests are written to FAIL against the pre-fix implementation: the old
 * `closeRun()` returned `string[]` (no result payload), so window A could not be
 * posted at all, and there was no late-result sink, so window B's output was
 * discarded.
 */
import { AsyncToolRegistry, formatAsyncToolResult, formatLateToolResult, formatOwedToolResults } from './async-tool-registry';
import type { AsyncToolDone } from './async-tool-registry';

/** A controllable clock + timer queue, so a 60 s threshold is instant. */
function fakeTime() {
  let now = 1_000_000;
  type Timer = { at: number; fn: () => void; cancelled: boolean };
  const timers: Timer[] = [];
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (;;) {
        const due = timers.filter(t => !t.cancelled && t.at <= now).sort((a, b) => a.at - b.at);
        if (!due.length) return;
        for (const t of due) { t.cancelled = true; t.fn(); }
      }
    },
    setTimer: (fn: () => void, ms: number) => {
      const t: Timer = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t: Timer) => { if (t) t.cancelled = true; },
  };
}

const flush = () => new Promise<void>(r => setImmediate(r));
const AFTER_MS = 60_000;

describe('ticket 9ecabc73 — a background tool result never vanishes in silence', () => {
  // ── WINDOW A: the result is IN HAND when the run ends ────────────────────
  it('9ecabc73 WINDOW A: closeRun hands back the RESULT it holds, so the caller can post it', async () => {
    const clock = fakeTime();
    const reg = new AsyncToolRegistry({
      afterMs: AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      makeId: () => 'att_9ecabc73001',
    });

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>(r => { resolveWork = r; });
    const p = reg.run('browser_task', work);
    clock.advance(AFTER_MS);
    const outcome = await p;
    expect(outcome.kind).toBe('handed_off');

    // The call SETTLES after the last step boundary drained…
    resolveWork('The page renders correctly: header, sidebar and footer all present.');
    await flush();

    // …and then the run ends.
    const owed = reg.closeRun();

    // THE REGRESSION: the old signature returned ids only, so the text below was
    // unreachable and the run could only say "a result was lost".
    expect(owed).toHaveLength(1);
    expect(owed[0].correlationId).toBe('att_9ecabc73001');
    expect(owed[0].settled).toBe(true);
    expect(owed[0].ok).toBe(true);
    expect(owed[0].result).toContain('The page renders correctly');

    // THE CONTRACT: the posted text carries the REAL result, not an apology.
    const posted = formatOwedToolResults(owed);
    expect(posted).toContain('[BACKGROUND TOOL RESULT');
    expect(posted).toContain('att_9ecabc73001');
    expect(posted).toContain('The page renders correctly');
  });

  it('9ecabc73 WINDOW A: a FAILED held result still posts, saying it failed', async () => {
    const clock = fakeTime();
    const reg = new AsyncToolRegistry({
      afterMs: AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      makeId: () => 'att_9ecabc73002',
    });

    let rejectWork!: (e: Error) => void;
    const work = new Promise<string>((_, rej) => { rejectWork = rej; });
    const p = reg.run('computer_task', work);
    clock.advance(AFTER_MS);
    await p;

    rejectWork(new Error('device offline'));
    await flush();

    const owed = reg.closeRun();
    expect(owed).toHaveLength(1);
    expect(owed[0].settled).toBe(true);
    expect(owed[0].ok).toBe(false);

    const posted = formatOwedToolResults(owed);
    expect(posted).toContain('FAILED');
    expect(posted).toContain('device offline'); // the failure reason reaches the transcript too
  });

  // ── WINDOW B: the tool is STILL RUNNING when the run ends ────────────────
  it('9ecabc73 WINDOW B: a result settling AFTER closeRun reaches the late-result sink', async () => {
    const clock = fakeTime();
    const late: AsyncToolDone[] = [];
    const reg = new AsyncToolRegistry({
      afterMs: AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      makeId: () => 'att_9ecabc73003',
      onLateResult: (done) => late.push(done),
    });

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>(r => { resolveWork = r; });
    const p = reg.run('computer_task', work);
    clock.advance(AFTER_MS);
    await p; // handed off — the call is STILL RUNNING when the run ends

    const owed = reg.closeRun();
    // Reported as a terminal status the chat can act on: still running, will be posted.
    expect(owed.map(o => o.settled)).toEqual([false]);
    expect(formatOwedToolResults(owed)).toContain('still running at run end');
    expect(late).toHaveLength(0); // nothing to deliver yet — the work is genuinely unfinished

    // It finishes seconds later. THE REGRESSION: this output used to be dropped
    // into a log line even though the "Started" text had promised delivery.
    resolveWork('late but real');
    await flush();

    expect(late).toHaveLength(1);
    expect(late[0].correlationId).toBe('att_9ecabc73003');
    expect(late[0].result).toBe('late but real');
    expect(reg.takeReady()).toEqual([]); // never re-queued after close
  });

  it('9ecabc73 WINDOW B: a call still running at close delivers through the sink exactly once', async () => {
    const clock = fakeTime();
    const late: AsyncToolDone[] = [];
    const reg = new AsyncToolRegistry({
      afterMs: AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      makeId: () => 'att_9ecabc73004',
      onLateResult: (done) => late.push(done),
    });

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>(r => { resolveWork = r; });
    const p = reg.run('browser_task', work);
    clock.advance(AFTER_MS);
    await p; // handed off — still running

    const owed = reg.closeRun();
    expect(owed).toHaveLength(1);
    expect(owed[0].settled).toBe(false);
    expect(formatOwedToolResults(owed)).toContain('still running at run end');

    // The tool finishes after the run closed: its output is REAL and must land.
    resolveWork('the hosted browser finished the navigation');
    await flush();

    expect(late).toHaveLength(1);
    expect(late[0].correlationId).toBe('att_9ecabc73004');
    expect(late[0].result).toContain('finished the navigation');

    // And the text posted for it is the honest post-run framing.
    const posted = formatOwedToolResults([{ ...late[0], settled: true }]);
    expect(posted).toContain('[BACKGROUND TOOL RESULT');
    expect(posted).toContain('after the run that started it had ended');
    expect(posted).toContain('finished the navigation');

    // A late post must never be double-delivered through the normal drain.
    expect(reg.takeReady()).toEqual([]);
  });

  // ── THE CHANNEL ITSELF STILL WORKS (control) ─────────────────────────────
  it('9ecabc73 CONTROL: a result drained IN-RUN keeps the original event framing', async () => {
    const clock = fakeTime();
    const reg = new AsyncToolRegistry({
      afterMs: AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      makeId: () => 'att_9ecabc73005',
    });

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>(r => { resolveWork = r; });
    const p = reg.run('browser_task', work);
    clock.advance(AFTER_MS);
    await p;
    resolveWork('in-run result');
    await flush();

    const drained = reg.takeReady();
    expect(drained).toHaveLength(1);
    const text = formatAsyncToolResult(drained[0]);
    expect(text).toContain('[BACKGROUND TOOL RESULT');
    expect(text).toContain('finished after');
    expect(text).not.toContain('after the run that started it had ended'); // in-run is NOT late-framed
    expect(reg.closeRun()).toEqual([]); // nothing left owed
  });

  // ── NEVER SILENT: the framing lemma, both populations ────────────────────
  it('9ecabc73 NEVER SILENT: every owed call yields a posted line — settled or running', () => {
    const settled = formatOwedToolResults([{
      correlationId: 'att_9ecabc73006', tool: 'computer_task', settled: true, result: 'held output', ok: true, elapsedMs: 90_000,
    }]);
    const running = formatOwedToolResults([{
      correlationId: 'att_9ecabc73007', tool: 'browser_task', settled: false, elapsedMs: 75_000,
    }]);

    // Neither population may produce an empty string — silence is the defect.
    expect(settled.trim().length).toBeGreaterThan(0);
    expect(running.trim().length).toBeGreaterThan(0);
    expect(settled).toContain('held output');
    expect(running).toContain('att_9ecabc73007');
    expect(running).toContain('will be posted to this chat');

    // The late framing is distinct from the in-run framing, so a reader can tell
    // which contract a message is fulfilling.
    expect(formatLateToolResult({ correlationId: 'att_9ecabc73006', tool: 'computer_task', result: 'x', elapsedMs: 1000, ok: true }))
      .toContain('after the run that started it had ended');
  });

  it('9ecabc73 NO DOUBLE POST: closeRun is idempotent and clears what it returned', async () => {
    const clock = fakeTime();
    const reg = new AsyncToolRegistry({
      afterMs: AFTER_MS, apply: true, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      makeId: () => 'att_9ecabc73008',
    });

    let resolveWork!: (v: string) => void;
    const work = new Promise<string>(r => { resolveWork = r; });
    const p = reg.run('run_command', work);
    clock.advance(AFTER_MS);
    await p;
    resolveWork('output');
    await flush();

    expect(reg.closeRun()).toHaveLength(1);
    expect(reg.closeRun()).toEqual([]); // a second close never re-posts the same result
    expect(reg.takeReady()).toEqual([]);
  });

  it('9ecabc73 SHADOW MODE: observe mode still owes nothing and posts nothing', async () => {
    const clock = fakeTime();
    const reg = new AsyncToolRegistry({
      afterMs: AFTER_MS, apply: false, now: clock.now,
      setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      makeId: () => 'att_9ecabc73009',
    });

    const work = Promise.resolve('inline result');
    const p = reg.run('run_command', work);
    clock.advance(AFTER_MS);
    const outcome = await p;
    // Shadow never hands off, so nothing can be owed — the fix cannot make an
    // observe-mode deploy post phantom messages.
    expect(outcome.kind).toBe('immediate');
    expect(reg.closeRun()).toEqual([]);
  });
});