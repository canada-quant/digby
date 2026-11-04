/**
 * Acceptance replay — todo 76d78ad7 (goal fa54f4b9, framework audit
 * 2026-10-15): the monitor heuristic the PR #1576 lane suggested — "the
 * missing-receipt check should read the deploy timeline: a receipt gap
 * inside a deploy window with a durable state row classifies as
 * drain-loss, not invented-claim."
 *
 * SPECIMENS (docs/FRAMEWORK_LESSONS.md row 1e356736, the caveat row that
 * is this suite's starting point):
 *   S1 — the Fleet Supervisor save ~08:34Z 2026-10-16: supervisor_states
 *        row durable, update_supervisor_state receipt missing, inside the
 *        #1568 deploy window 08:09–08:32Z (past its end by ~2 min — the
 *        drain margin exists for exactly this shape).
 *   S2 — the crossmodel supervisor save ~08:31Z 2026-10-16: same class,
 *        INSIDE the recorded window.
 *   S3 — the monitor caveat: a run STARTED on the pre-#1576 color is
 *        EXPECTED to lack the receipt (the class shipped in #1568) —
 *        pre-class wins over every other verdict.
 *
 * The suite pins the pure classifier (receipt-gap.ts) — the probe
 * (scripts/framework-audit/probe-76d78ad7.js) embeds the same logic and is
 * exercised by the framework-audit README contract (read-only, one JSON).
 */
import {
  classifyReceiptGap,
  coveringWindow,
  DEFAULT_DEPLOY_DRAIN_MARGIN_MIN,
  type DeployWindow,
} from './receipt-gap';

const D = (s: string) => new Date(s);

// The #1568 deploy wave (state-tools receipt class shipped IN it — wave
// 38869942923 created 07:52:15Z, boxes restarted through 08:09–08:32Z; the
// window end 08:32:25Z is the last restart's conclusion, #1567's wave
// 38871773678 per the 77c88942 evidence). The specimens' runs ran ON the
// #1568 color: post-class, receipt-minting, killed mid-write.
const W1568: DeployWindow = {
  runId: '38869942923',
  startedAt: D('2026-10-16T08:09:00Z'),
  concludedAt: D('2026-10-16T08:32:25Z'),
};

describe('todo 76d78ad7 — coveringWindow', () => {
  it('1. a save INSIDE the recorded window is covered', () => {
    expect(coveringWindow(D('2026-10-16T08:31:00Z'), [W1568])?.runId).toBe('38869942923');
  });

  it('2. a save past the end is covered by the drain margin (S1: 08:34Z vs end 08:32:25Z)', () => {
    expect(coveringWindow(D('2026-10-16T08:34:00Z'), [W1568])?.runId).toBe('38869942923');
  });

  it('3. a save past end + margin is NOT covered, and one before the start is NOT covered', () => {
    const pastMargin = new Date(W1568.concludedAt.getTime() + (DEFAULT_DEPLOY_DRAIN_MARGIN_MIN + 1) * 60_000);
    expect(coveringWindow(pastMargin, [W1568])).toBeNull();
    expect(coveringWindow(D('2026-10-16T07:00:00Z'), [W1568])).toBeNull();
  });

  it('4. empty windows / a null-ish margin never cover anything (fail-closed shape)', () => {
    expect(coveringWindow(D('2026-10-16T08:34:00Z'), [])).toBeNull();
  });
});

describe('todo 76d78ad7 — classifyReceiptGap', () => {
  const base = {
    tool: 'update_supervisor_state',
    // The pre-class boundary is when the #1568 color BEGAN SERVING (~08:09Z,
    // first box restart) — a run started before that ran on the old color
    // and could never mint the receipt (the monitor caveat). S1/S2's runs
    // started 08:25/08:28: on the new color, receipt-minting, killed
    // mid-write by the drain — the lesson's drain-loss specimens.
    classShippedAt: D('2026-10-16T08:09:00Z'),
  };

  it('5. SPECIMEN S2 (crossmodel save ~08:31Z): durable row + inside window → drain_loss', () => {
    const r = classifyReceiptGap({
      ...base,
      actionAt: D('2026-10-16T08:31:00Z'),
      runStartedAt: D('2026-10-16T08:25:00Z'),
      durableRow: true,
      deployWindows: [W1568],
    });
    expect(r.verdict).toBe('drain_loss');
    expect(r.coveredByWindow).toBe('38869942923');
    expect(r.reason).toContain('38869942923');
  });

  it('6. SPECIMEN S1 (Fleet save ~08:34Z): durable row + inside window+margin → drain_loss (not invented_claim)', () => {
    const r = classifyReceiptGap({
      ...base,
      actionAt: D('2026-10-16T08:34:00Z'),
      runStartedAt: D('2026-10-16T08:28:00Z'),
      durableRow: true,
      deployWindows: [W1568],
    });
    expect(r.verdict).toBe('drain_loss');
    expect(r.reason).not.toContain('invented');
  });

  it('7. SPECIMEN S3 (the monitor caveat): run started pre-class → expected_pre_class, even when a window covers the action', () => {
    const r = classifyReceiptGap({
      ...base,
      actionAt: D('2026-10-16T08:31:00Z'),
      runStartedAt: D('2026-10-16T08:05:00Z'), // BEFORE the #1568 color began serving 08:09Z — old color
      durableRow: true,
      deployWindows: [W1568],
    });
    expect(r.verdict).toBe('expected_pre_class');
    // and pre-class wins with NO durable row either — the caveat is about
    // the class, not the side effect
    const r2 = classifyReceiptGap({
      ...base,
      actionAt: D('2026-10-16T08:31:00Z'),
      runStartedAt: D('2026-10-16T08:05:00Z'),
      durableRow: false,
      deployWindows: [W1568],
    });
    expect(r2.verdict).toBe('expected_pre_class');
  });

  it('8. a window NEVER launders a claim whose side effect never landed — no durable row inside a window stays invented_claim', () => {
    const r = classifyReceiptGap({
      ...base,
      actionAt: D('2026-10-16T08:31:00Z'),
      runStartedAt: D('2026-10-16T08:40:00Z'), // post-class run
      durableRow: false,
      deployWindows: [W1568],
    });
    expect(r.verdict).toBe('invented_claim');
    expect(r.coveredByWindow).toBe('38869942923');
    expect(r.reason).toContain('never excuses');
  });

  it('9. durable row, NO window covering it → unexplained_gap (watch-list, not model-behavior signal)', () => {
    const r = classifyReceiptGap({
      ...base,
      actionAt: D('2026-10-16T11:00:00Z'),
      runStartedAt: D('2026-10-16T10:50:00Z'),
      durableRow: true,
      deployWindows: [W1568],
    });
    expect(r.verdict).toBe('unexplained_gap');
    expect(r.coveredByWindow).toBeNull();
    expect(r.reason).toContain('watch-list');
  });

  it('10. no durable row, no window, post-class run → invented_claim (the monitor signal class)', () => {
    const r = classifyReceiptGap({
      ...base,
      actionAt: D('2026-10-16T11:00:00Z'),
      runStartedAt: D('2026-10-16T10:50:00Z'),
      durableRow: false,
      deployWindows: [],
    });
    expect(r.verdict).toBe('invented_claim');
  });

  it('11. the drain margin is configurable — a tighter margin flips S1 to unexplained_gap', () => {
    // margin 0: 08:34Z is past the 08:32:25Z end → no cover
    const r = classifyReceiptGap({
      ...base,
      actionAt: D('2026-10-16T08:34:00Z'),
      runStartedAt: D('2026-10-16T08:28:00Z'),
      durableRow: true,
      deployWindows: [W1568],
    }, 0);
    expect(r.verdict).toBe('unexplained_gap');
  });

  it('12. classShippedAt null (class predates lookback) → no pre-class verdicts, pure window logic', () => {
    const r = classifyReceiptGap({
      tool: 'archive_chat',
      actionAt: D('2026-10-16T08:31:00Z'),
      runStartedAt: D('2026-10-16T08:20:00Z'),
      classShippedAt: null,
      durableRow: true,
      deployWindows: [W1568],
    });
    expect(r.verdict).toBe('drain_loss');
  });
});
