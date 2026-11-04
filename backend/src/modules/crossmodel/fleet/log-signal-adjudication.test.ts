/**
 * Per-fingerprint adjudication suppression (ticket 0ef6794e) — the pure
 * gate pinned directly, plus the DETECTOR-RECALL REPLAY obligations of the
 * ticket-lane detector-change rules: this change relaxes WHEN the log-signal
 * sweep files tickets (a new skip branch in its filing walk), so every
 * PRIOR true positive of the filing decision must be replayed here and
 * asserted to STILL file / still surface.
 *
 * The sweep-suite integration (log-signal-sweep.service.test.ts) replays
 * the walk end-to-end over the REAL feedback insert path; this file pins
 * the gate's own decisions (the four gates, the epidemic carve-outs, the
 * fail-open direction) and carries the recall markers:
 *
 *   DETECTOR-RECALL REPLAY (filing true positive #1): a GENUINELY-NEW
 *   fingerprint — no closed row at all — files; the gate returns
 *   not-suppressed (see `recall: a fingerprint with NO standing closed
 *   row never suppresses`).
 *
 *   DETECTOR-RECALL REPLAY (filing true positive #2): an EPIDEMIC-level
 *   recurrence over the recorded re-open bar — a breach the verdict itself
 *   demanded re-examination for — still files; the gate returns
 *   not-suppressed (see `recall: a count over the recorded re-open bar
 *   still files`).
 *
 *   DETECTOR-RECALL REPLAY (filing true positive #3): a baseline SURGE at
 *   3× the class's own recorded filing baseline still files; the gate
 *   returns not-suppressed (see `recall: a 3x-baseline surge still
 *   files`).
 */
// The leaf's prisma seam (config/database pulls env validation at import —
// the same module-factory mock posture as the sweep suite; the pure gate
// never reads it, loadAdjudicationCandidate's suites inject loadRow).
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userFeatureRequest: { findMany: jest.fn(async () => []) } },
}));

import {
  LOG_SIGNAL_ADJUDICATION_MIN_CYCLES,
  LOG_SIGNAL_SURGE_MULTIPLE,
  adjudicationSuppresses,
  logSignalAdjudicatedSuppressionDisabled,
  rowAdjudicationCycles,
  rowBaseline,
  rowReplayPin,
} from './log-signal-adjudication';
import type { AdjudicationRow } from './log-signal-adjudication';

/** The exact closure-evidence stamp shape (closure-evidence.ts:442/480, verified against live rows fc1fd22f / 8386e3e8). */
const verifiedPin = (prefix: string, path: string) =>
  `[machine-close evidence: replay test ${path} (verified: exists + cites ${prefix})]`;
const originMainPin = (prefix: string, path: string) =>
  `[machine-close evidence: replay test ${path} (verified via origin/main: exists + cites ${prefix}; the instance checkout did not have it — stale-checkout tolerated)]`;

const FP = 'action-verifier: dropped <n> llm-extracted note claim(s) with no verbatim support';
const title = `log-signal: ${FP}`;
const PREFIX = 'fc1fd22f';
const PIN_PATH = 'backend/src/modules/crossmodel/platform/action-verifier.log-signal-fc1fd22f.test.ts';

/** A row shaped like the live fc1fd22f member the ticket cites (occurrences 2 while OPEN, close 10-26, baseline 19). */
type RowCtx = Record<string, unknown>;
const BASE_CTX: RowCtx = {
  fingerprintHash: '4b2b02a2d87ab48e',
  count: 19,
  occurrences: 2,
  acceptanceMetricBaseline: { baseline: 19, measurable: true, vacuous: false },
  sightings: [{ duplicateSuppressedBy: 'adjudicated-class', at: '2026-11-02T01:10:49.696Z' }],
};
const adjudicatedRow = (over: { adminNote?: string | null; context?: RowCtx } = {}): AdjudicationRow => ({
  id: 'fc1fd22f-0716-4e4c-a9e8-fe78ea662438',
  title,
  status: 'done',
  adminNote:
    'Adjudicated (family lane f02ac12e, 2026-10-26): false positive — no deterministic framework defect; guard correct. ' +
    'The warn class is the action-verifier doing its DESIGNED job on the correct side of the precision/recall trade.\n' +
    `Re-open bar: reopen if the fingerprint's 24h count exceeds 13,149 rows or a GROUNDED true claim is ever dropped.\n` +
    verifiedPin(PREFIX, PIN_PATH),
  // Full-replacement semantics: an explicit context REPLACES the base (tests assert absence by passing a context without the field).
  context: over.context ?? BASE_CTX,
  ...(over.adminNote !== undefined ? { adminNote: over.adminNote } : {}),
});

describe('rowReplayPin — the evidence gate', () => {
  it('accepts the platform\'s verified local stamp, an id-named pin', () => {
    expect(rowReplayPin(adjudicatedRow())).toBe(PIN_PATH);
  });

  it('accepts the verified-via-origin/main spelling (stale-checkout tolerance lane)', () => {
    const row = adjudicatedRow({ adminNote: 'False positive — guard correct.\n' + originMainPin(PREFIX, PIN_PATH) });
    expect(rowReplayPin(row)).toBe(PIN_PATH);
  });

  it('rejects a pin that cites a DIFFERENT ticket\'s prefix (not id-named for this row)', () => {
    // 8386e3e8's own pin (utility-llm.test.ts): the segment cites 8386e3e8 and
    // neither path nor citation names fc1fd22f — it does not vouch here.
    const row = adjudicatedRow({ adminNote: 'False positive.\n' + verifiedPin('8386e3e8', 'backend/src/utils/utility-llm.test.ts') });
    expect(rowReplayPin(row)).toBeNull();
  });

  it('rejects a pin with no VERIFIED stamp (a lane\'s bare mention is say-so, not evidence)', () => {
    const row = adjudicatedRow({
      adminNote: `False positive — designed. This lane added a pin: ${PIN_PATH} replays the prod shape.\n(no machine-close stamp at all)`,
    });
    expect(rowReplayPin(row)).toBeNull();
  });

  it('rejects a note with NO evidence block, and a null/empty note', () => {
    expect(rowReplayPin(adjudicatedRow({ adminNote: 'false positive — by design, no code change needed' }))).toBeNull();
    expect(rowReplayPin(adjudicatedRow({ adminNote: null }))).toBeNull();
  });

  it('reads the pin from a MULTI-SEGMENT block without cross-segment contamination', () => {
    const note =
      'Adjudicated: sibling — same root cause as the lead.\n' +
      `[machine-close evidence: replay test ${PIN_PATH} (verified: exists + cites ${PREFIX}); PR https://github.com/canada-quant/digby/pull/1977; deploy run 40239422237]`;
    expect(rowReplayPin({ id: 'fc1fd22f-0000-0000-0000-000000000000', adminNote: note })).toBe(PIN_PATH);
    // The PR segment cites a number, not the prefix; the deploy segment
    // neither — only the pin segment vouches.
  });
});

describe('rowBaseline + rowAdjudicationCycles — the history the row recorded', () => {
  it('picks the LOUDEST of the filing count and the acceptance-metric baseline', () => {
    expect(rowBaseline(adjudicatedRow())).toBe(19);
    expect(rowBaseline(adjudicatedRow({ context: { count: 5, acceptanceMetricBaseline: { baseline: 157 } } }))).toBe(157);
    expect(rowBaseline(adjudicatedRow({ context: {} }))).toBeNull();
  });

  it('counts POST-CLOSE witnesses only: close (1) + reopenCount + absorbed sightings', () => {
    expect(rowAdjudicationCycles(adjudicatedRow())).toBe(2); // close + one absorbed sighting
    expect(rowAdjudicationCycles(adjudicatedRow({ context: { ...BASE_CTX, reopenCount: 1 } }))).toBe(3);
    // occurrences (a while-OPEN bump) is NOT a witness:
    expect(rowAdjudicationCycles(adjudicatedRow({ context: { occurrences: 5 } }))).toBe(1);
  });
});

describe('adjudicationSuppresses — THE GATE (pure)', () => {
  it('suppresses a fully-evidenced twice-adjudicated designed class inside its bar and surge line', () => {
    const v = adjudicationSuppresses(adjudicatedRow(), 5);
    expect(v.suppressed).toBe(true);
    expect(v).toMatchObject({ ticketId: 'fc1fd22f-0716-4e4c-a9e8-fe78ea662438', cycles: 2, baseline: 19, pin: PIN_PATH });
  });

  it('gate 1 — a TRUE-DEFECT close (fix evidence present) never suppresses', () => {
    const row = adjudicatedRow({
      adminNote:
        'Fixed: the retry no longer loops. ' +
        `Re-open bar: reopen if the 24h count exceeds 13,149.\n${verifiedPin(PREFIX, PIN_PATH)}`,
    });
    expect(adjudicationSuppresses(row, 5).suppressed).toBe(false);
  });

  it('gate 1 — an UNKNOWN close (no verdict phrase, no fix evidence) never suppresses', () => {
    const row = adjudicatedRow({ adminNote: `Closed after review.\n${verifiedPin(PREFIX, PIN_PATH)}` });
    expect(adjudicationSuppresses(row, 5).suppressed).toBe(false);
  });

  it('gate 2 — a lazy close (verdict, cycles, but NO verified id-named pin) never suppresses', () => {
    const row = adjudicatedRow({ adminNote: 'False positive — by design, nothing to fix. No pin recorded.' });
    expect(adjudicationSuppresses(row, 5).suppressed).toBe(false);
  });

  it('gate 3 — ONE adjudication cycle (close only) never suppresses', () => {
    const row = adjudicatedRow({ context: { count: 19, acceptanceMetricBaseline: { baseline: 19 } } });
    expect(rowAdjudicationCycles(row)).toBe(1);
    expect(adjudicationSuppresses(row, 5).suppressed).toBe(false);
    expect(LOG_SIGNAL_ADJUDICATION_MIN_CYCLES).toBe(2);
  });

  it('gate 4 — the STRUCTURAL re-open bar (context.reopenBar) breaches and still files', () => {
    const row = adjudicatedRow({ context: { ...BASE_CTX, reopenBar: 25 } });
    expect(adjudicationSuppresses(row, 26).suppressed).toBe(false);
    expect(adjudicationSuppresses(row, 25).suppressed).toBe(true); // at the bar is inside
    expect(adjudicationSuppresses(row, 24).suppressed).toBe(true);
  });

  it('gate 4 — the PROSE re-open bar (the verdict\'s own phrase) parses and breaches', () => {
    // "exceeds 13,149" → bar 13149 (comparator-anchored, comma-grouped).
    const v = adjudicationSuppresses(adjudicatedRow(), 13150);
    expect(v.bar).toBe(13149);
    expect(v.suppressed).toBe(false);
    expect(adjudicationSuppresses(adjudicatedRow(), 40).suppressed).toBe(true);
  });

  // ── DETECTOR-RECALL REPLAY — the filing decision's PRIOR true positives ──

  it('recall: a fingerprint with NO standing closed row never suppresses (a genuinely-new class files)', () => {
    // DETECTOR-RECALL REPLAY (filing true positive #1): pre-0ef6794e the
    // sweep filed every qualifying new fingerprint; the gate must keep
    // that true positive — no closed row, no suppression, the sweep files.
    const v = adjudicationSuppresses(null, 100);
    expect(v.suppressed).toBe(false);
    expect(v.ticketId).toBeNull();
  });

  it('recall: a count over the recorded re-open bar still files (the epidemic carve-out holds)', () => {
    // DETECTOR-RECALL REPLAY (filing true positive #2): a recurrence the
    // verdict itself demanded re-examination for — over its own recorded
    // re-open bar — must still surface to operators, suppression or not.
    const v = adjudicationSuppresses(adjudicatedRow(), 14000);
    expect(v.suppressed).toBe(false);
  });

  it('recall: a 3x-baseline SURGE still files even with no parseable bar', () => {
    // DETECTOR-RECALL REPLAY (filing true positive #3): an epidemic by the
    // class's own history — 3× its recorded filing baseline — is a level
    // breach the metric surface must never hide. 19 × 3 = 57.
    expect(LOG_SIGNAL_SURGE_MULTIPLE).toBe(3);
    const row = adjudicatedRow({
      adminNote: 'Adjudicated: false positive — designed, no code change needed.\n' + verifiedPin(PREFIX, PIN_PATH),
    });
    const v = adjudicationSuppresses(row, 57);
    expect(v.baseline).toBe(19);
    expect(v.suppressed).toBe(false);
    expect(adjudicationSuppresses(row, 56).suppressed).toBe(true);
  });

  it('the kill switch LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED=1 reads true', () => {
    expect(logSignalAdjudicatedSuppressionDisabled({})).toBe(false);
    expect(logSignalAdjudicatedSuppressionDisabled({ LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED: '1' })).toBe(true);
    expect(logSignalAdjudicatedSuppressionDisabled({ LOG_SIGNAL_ADJUDICATED_SUPPRESSION_DISABLED: '' })).toBe(false);
  });
});
