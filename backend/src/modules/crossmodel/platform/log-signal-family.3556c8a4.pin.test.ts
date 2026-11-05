/**
 * Replay pin — log-signal family lane 3556c8a4 (2026-11-03), 2 tickets.
 *
 * Both members are the SAME root cause, verified per member against LIVE
 * app_error_logs rows (not the ticket text) rather than assumed from the shared
 * family slug: a DESIGNED outcome that is driven by an EXTERNAL dependency is
 * emitted at warn with NO logClass tag, so the log-signal sweep's
 * isNonFaultLogRow() reads it as an internal framework fault and re-files it
 * every week, forever. Earlier lanes adjudicated each class a non-defect and
 * pinned the CONTRACT while leaving the emit site untagged — which is why the
 * tickets kept coming: a pin on the semantics never stopped the sweep.
 *
 *  bb6a3aa3 — `coding agent: api-optimize-xiaomi-mimo-v2.6-pro stream ended
 *              CLEANLY ([DONE] seen) after 1 tool call(s) … (severed-stream
 *              recovery)`. 35 rows / 13 distinct hours. The upstream gateway
 *              ended the turn mid-payload (efdb3d31 measured recv==acc, drop=0,
 *              buf=0 — every byte it sent we appended; the payload stopped) and
 *              agent.ts RECOVERED the turn by re-emitting it. External.
 *
 *  d883ae45 — `decision-gate[compute_policy]: earlier leg(s) failed, TypeSafe
 *              Jev answered — llm-cql (typed decisions via chat completions):
 *              timeout timeout of 593ms exceeded …`. 29 rows / 12 hours. An
 *              owner-side gateway leg timed out inside its legShareCap share
 *              and the built-in Jev ANSWERED the ask. Already adjudicated a
 *              designed WI-H non-defect three times (f68b611e compute_policy,
 *              0c86f97f task_kind, 22afdd2d turn_plan). External.
 *
 * THIS PIN asserts, per member: (a) the emit site carries logClass:'external',
 * (b) the message text is UNCHANGED (so the fingerprint, the existing d37054e9
 * `c[0]` pins and the F2 splat-safety contract keep matching), (c) the loss /
 * degradation signal those warns pointed at is STILL instrumented on a
 * loop_metric row — i.e. the tag hides no regression — and (d) the sweep's own
 * predicate really honours the tag while still convicting a genuinely untagged
 * fault (the conservative direction: the fix must not blunt the detector).
 */

import fs from 'fs';
import path from 'path';

// The sweep service's import graph reaches config/database → config/env, which
// calls process.exit(1) in a worker with no env (the repo's documented idiom —
// see model-endpoints/endpoint-verifier.test.ts:29). Only its PURE predicate
// (isNonFaultLogRow) is under test, so the DB/Redis/logger chain is stubbed.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: {} }));

import { isNonFaultLogRow } from '../fleet/log-signal-sweep.service';

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, rel), 'utf8').replace(/\r\n/g, '\n');

// ── bb6a3aa3 — a RECOVERED severed stream is external, not a fault ───────────
describe('bb6a3aa3 — the severed-stream recovery notice is tagged external', () => {
  const src = read('../coding/agent.ts');

  it('the emit site carries logClass: external', () => {
    // The exact prod fingerprint must still be produced at the same site…
    expect(src).toContain('stream ended ${turn.streamCompleted === false ? \'WITHOUT [DONE]\' : \'CLEANLY ([DONE] seen)\'} after ${turn.toolCalls.length} tool call(s)');
    // …and the object-form meta must carry the tag that stops the sweep.
    expect(src).toContain('(severed-stream recovery)`, { logClass: \'external\' });');
  });

  it('the message text is unchanged — the fingerprint and the audit pins keep matching', () => {
    expect(src).toContain('the assembled payload stops mid-structure; re-emitting the turn once instead of dispatching a partial call');
    expect(src).toContain('${(turn.reasoning || \'\').length} chars, partial args ${partial || \'none\'}');
  });

  it('the recovery itself is untouched — the turn is still re-emitted once', () => {
    // Tagging a recovery must not disable it: the re-emit + the metric stay.
    expect(src).toContain('noteReemit(severedReemitCarry,');
    expect(src).toContain('severed-stream-recovery');
  });

  it('the LOSS signal survives on a loop_metric row — the tag hides no regression', () => {
    // The warn is only the human-readable notice; the countable, alertable
    // signal is the metric. If a future pass deletes these, tagging WOULD hide
    // a severance regression and this pin must fail.
    expect(src).toContain('LOOP_METRIC_KINDS.SEVERED_STREAM_RECOVERY');
  });

  it('a TRUE severance in the same path stays an untagged warn (nothing widened)', () => {
    // The un-recovered severance (no recovery possible) is a different, real
    // signal and must NOT have been swept up by this re-classification.
    expect(src).toContain('WITHOUT [DONE]');
  });
});

// ── d883ae45 — a designed backend fall-through is external, not a fault ──────
describe('d883ae45 — the decision-gate fall-through warn is tagged external', () => {
  const src = read('./decision-gate.ts');

  it('the emit site uses the OBJECT form with logClass: external', () => {
    // Object form is load-bearing (5ae52ca3): a two-arg logger.warn(message,
    // meta) would splat the meta into the message and destroy the tag exactly
    // on the rows that carry provider prose.
    expect(src).toContain('logger.warn({\n    level: \'warn\',');
    expect(src).toContain('logClass: \'external\',');
    // …and NOT the old positional form.
    expect(src).not.toContain('logger.warn(`decision-gate[${purpose}]: earlier leg(s) failed');
  });

  it('the message text is unchanged — the ticket fingerprint keeps matching', () => {
    expect(src).toContain('decision-gate[${purpose}]: earlier leg(s) failed, ${answered} answered — ${legErrors.map(scrubLegError).join(\' | \')}');
    expect(src).toContain('(further fall-throughs in loop_metrics decision_gate meta.legErrors)');
  });

  it('the per-instance trace survives on loop_metrics — the tag hides no degradation', () => {
    // The message points AT the metric row; that row (not this warn) is the
    // measurable trace. Tagging the notice cannot lose it.
    expect(src).toContain('legErrors');
    expect(src).toContain('onAllLegsFailed');
  });

  it('the throttle and the decision are untouched — still one row per 5 min', () => {
    expect(src).toContain('if (Date.now() - lastFallThroughWarnAt < 5 * 60_000) return;');
  });

  it('a genuinely dead chain still raises its OWN untagged warn (nothing widened)', () => {
    // all-legs-failed is a real fault and must stay sweep-visible.
    expect(src).toContain('all_legs_failed');
  });
});

// ── the sweep predicate really honours the tag, and still convicts a fault ───
describe('the sweep predicate — external rows are non-fault, untagged warn rows still convict', () => {
  it('a logClass external row is treated as NON-fault', () => {
    expect(isNonFaultLogRow({ context: { logClass: 'external' } })).toBe(true);
    expect(isNonFaultLogRow({ context: { logClass: 'handled' } })).toBe(true);
  });

  it('an UNTAGGED warn row is still a fault — the detector is not blunted', () => {
    // THE conservative direction: if the tag were read broadly (or the
    // predicate loosened), a real regression would stop filing tickets. Both
    // members are only safe because the tag is narrow and explicit.
    expect(isNonFaultLogRow({ context: {} })).toBe(false);
    expect(isNonFaultLogRow({ context: { source: 'coding-agent' } })).toBe(false);
    expect(isNonFaultLogRow({ context: undefined })).toBe(false);
    expect(isNonFaultLogRow({ context: { logClass: 'unhandled' } })).toBe(false);
  });
});