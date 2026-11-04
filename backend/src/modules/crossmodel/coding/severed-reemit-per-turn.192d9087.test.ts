/**
 * TICKET 192d9087 F2 (2026-10-30) — `re`/`rl` are PER-TURN facts.
 *
 * THE DEFECT (confirmed in code by an independent lane, then by reading the turn
 * loop directly). Two fields that describe "a re-emit happened" rode per-RUN
 * state:
 *
 *   - `severedReemitLens` was assigned ONLY inside the re-emit branch and never
 *     cleared (agent.ts ~5295/5296), and
 *   - `ctx.severedRecovered` was copied from the per-run `severedStreamRecovered`
 *     bound onto the ctx on EVERY turn (~5277).
 *
 * So once a run re-emitted once, EVERY later reject row of that run carried
 * `re:1` and the lens of an EARLIER turn. `re:1` therefore read "a re-emit
 * happened at some point in this run" rather than "this row followed a re-emit",
 * and an `rl`-vs-`argLen` comparison could silently pair two unrelated turns.
 * The family's handoff had to carry a READING RULE ("scope the comparison to the
 * FIRST post-recovery row of a run") precisely because no stored field enforced
 * it — a rule in a brief is not a guarantee in data.
 *
 * WHAT THIS FILE PINS. Not "does the value exist" (that is the source-wiring
 * test) but the SEQUENCE: a replay of turns through the real `noteReemit` /
 * `beginTurn` pair, asserting that the lens rides exactly the retry the re-emit
 * bought, and is GONE on the turn after — with `re:0` on both the recovery
 * turn's own row and every later turn.
 *
 * WHY PURE LOGIC AND NOT A FULL AGENT RUN. The carry is the whole mechanism: the
 * turn loop only reads it at turn start and writes it at the re-emit branch, so
 * driving the pair through a realistic turn sequence exercises every state that
 * can produce a wrong key. A full agent run would additionally need a mocked
 * provider that severs a stream on cue — cost without coverage, since the branch
 * wiring itself is asserted in severed-reemit-lens.test.ts.
 */
import { noteReemit, beginTurn, type ReemitTurnCarry } from './severed-stream';

/** One simulated turn: what the loop does at turn start, then (maybe) at re-emit. */
function turn(carry: ReemitTurnCarry, cutLens?: string) {
  const read = beginTurn(carry);      // loop top (agent.ts ~3410)
  if (cutLens !== undefined) noteReemit(carry, cutLens); // re-emit branch (~5328)
  return read;
}

describe('192d9087 F2 — per-turn `re`/`rl` semantics', () => {
  it('the reported defect: turn 1 re-emits, turn 2 is the RETRY, turn 3 is CLEARED', () => {
    const carry: ReemitTurnCarry = {};

    // Turn 1: a clean turn that never re-emitted → no re-emit claimed.
    expect(turn(carry)).toEqual({ re: 0 });

    // Turn 2: the payload is cut at 39 bytes → the branch re-emits and hands the
    // lens on. THIS turn's own row must NOT claim the re-emit: the re-request has
    // not run yet, so nothing was "recovered" as of this turn.
    expect(turn(carry, '39')).toEqual({ re: 0 });

    // Turn 3: the retry the re-emit bought. `re:1` AND the attempt-1 lens, so a
    // single row answers "did the re-request re-cut at the same byte?".
    expect(turn(carry)).toEqual({ re: 1, rl: '39' });

    // Turn 4: ★ THE REGRESSION LINE ★ — under the old sticky code this read
    // `{ re: 1, rl: '39' }`, describing turn 2's re-emit as if it were this
    // row's own. It must now be a plain turn.
    expect(turn(carry)).toEqual({ re: 0 });
    expect(turn(carry)).toEqual({ re: 0 });
  });

  it('the carry is CONSUMED, not copied — reading twice does not resurrect the lens', () => {
    const carry: ReemitTurnCarry = {};
    turn(carry, '39');
    expect(beginTurn(carry)).toEqual({ re: 1, rl: '39' });
    // A second read at the same turn boundary (defensive re-entry) must not
    // hand the same lens to another row.
    expect(beginTurn(carry)).toEqual({ re: 0 });
  });

  it('a multi-call cut renders the whole comma-joined lens, exactly as captured', () => {
    const carry: ReemitTurnCarry = {};
    turn(carry, '39,67,17');           // three calls, three cut lengths
    expect(turn(carry)).toEqual({ re: 1, rl: '39,67,17' });
    expect(turn(carry)).toEqual({ re: 0 });
  });

  it('a re-emit on CONSECUTIVE turns still yields exactly one retry row each', () => {
    // The gate allows one re-emit per RUN, so this is not reachable today — but
    // the carry must not accumulate a queue if that bound ever moves. Each
    // hand-off replaces the pending lens rather than stacking one.
    const carry: ReemitTurnCarry = {};
    turn(carry, '39');
    turn(carry, '41');
    expect(beginTurn(carry)).toEqual({ re: 1, rl: '41' });
    expect(beginTurn(carry)).toEqual({ re: 0 });
  });

  it('a fresh run starts with no pending lens (the carry is run-scoped)', () => {
    expect(beginTurn({})).toEqual({ re: 0 });
  });
});