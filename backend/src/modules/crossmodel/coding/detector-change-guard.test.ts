/**
 * audit 2026-10-08 W5-3 — a ticket lane's DETECTOR CHANGE must ship a recall replay.
 *
 * REPLAY (goals.md F5): in ~44 h ticket lanes merged + deployed five detector
 * RELAXATIONS — 81b7f636 / 81a87c68 / 5bffa38c (action-verifier exemption
 * tiers), a3a4613e (hand-back detector evidence gate), 4ece357b (nightly suite
 * FAIL→WARN). 5bffa38c's diff touched platform/action-verifier.ts plus its own
 * incident pin (action-verifier.7cabb0cc.test.ts) — a test that proves the new
 * exemption ACQUITS, not that the prior true positives still CONVICT. The diffs
 * below carry that shape. A ticket lane's merge is now refused without a
 * "DETECTOR-RECALL REPLAY" test; other sessions get an observe-only note.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUfrFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userFeatureRequest: { findFirst: (...a: any[]) => mockUfrFindFirst(...a) },
    loopMetric: { findMany: jest.fn(async () => []) },
  },
}));
jest.mock('../platform/folder-inheritance', () => ({ __esModule: true, getMergedProjectStoreState: jest.fn(async () => null) }));
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) }));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { GUARD_MISS: 'guard_miss', GUARD_STRIKE: 'guard_strike', MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success' },
}));
jest.mock('./verify-state', () => ({ __esModule: true, getVerifyState: jest.fn(async () => null) }));
jest.mock('../platform/owner-questions', () => ({ __esModule: true, flagOwnerQuestion: jest.fn(async () => ({ kind: 'created' })) }));
// ticket-dispatch.service (the charter constant) imports config/redis → config/env (process.exit without env vars).
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assessDetectorChange, diffAddedLines, detectorChangeGuardDisabled, DETECTOR_RECALL_MARKER, DETECTOR_RECALL_SUGGESTED_FIX,
} from './detector-change-guard';
import { evaluateMergeGates, isDispatchedTicketLane, type GithubApi, type GateFailure, type GatePass } from './self-merge.service';
import { DETECTOR_CHANGE_RULE } from '../feedback/ticket-dispatch.service';

const fileDiff = (path: string, added: string[], removed: string[] = []) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${removed.length + 1} +1,${added.length + 1} @@\n${removed.map((l) => `-${l}`).join('\n')}\n${added.map((l) => `+${l}`).join('\n')}\n`;

/** The 5bffa38c shape: a new exemption tier in the verifier + its own acquittal pin, no recall replay. */
const RELAXATION_5BFFA38C = fileDiff('backend/src/modules/crossmodel/platform/action-verifier.ts', [
  '  // (ticket 7cabb0cc) a COUNCIL DISPATCH exoneration tier',
  '  if (opts.councilDispatched && isCouncilDispatchNarration(claim)) { councilDispatchExonerated++; continue; }',
]) + fileDiff('backend/src/modules/crossmodel/platform/action-verifier.7cabb0cc.test.ts', [
  "  it('REPLAYS the mishap: both [dispatch] claims audit CLEAN', async () => {",
  '    expect(comp.phantoms).toEqual([]);',
]);
/** The 4ece357b shape: a nightly-suite FAIL becomes a WARN. */
const DOWNGRADE_4ECE357B = fileDiff('scripts/e2e/query-suite.py', ["        verdict = 'WARN'  # an inline-canvas route for a document ask"], ["        verdict = 'FAIL'"]);
const RECALL_TEST = fileDiff('backend/src/modules/crossmodel/platform/action-verifier.recall.test.ts', [
  `// ${DETECTOR_RECALL_MARKER}: the convicting cases of action-verifier.test.ts / .61b9200a / .d78f477b still convict`,
  '  expect(comp.phantoms).toHaveLength(1);',
]);

describe('assessDetectorChange — pure', () => {
  it('REPLAY 5bffa38c: a verifier exemption tier + its own acquittal pin is a detector change with NO recall replay', () => {
    const v = assessDetectorChange(RELAXATION_5BFFA38C);
    expect(v).toEqual({ detectors: ['action-verifier'], replayFiles: [], missingReplay: true });
  });
  it('REPLAY 4ece357b: a nightly-suite FAIL→WARN downgrade is a detector change', () => {
    expect(assessDetectorChange(DOWNGRADE_4ECE357B)).toMatchObject({ detectors: ['nightly-suite'], missingReplay: true });
  });
  it('the evidence guard and the hand-back detector are detectors too', () => {
    expect(assessDetectorChange(fileDiff('backend/src/modules/crossmodel/coding/run-evidence-guard.ts', ['x'])).detectors).toEqual(['evidence-guard']);
    expect(assessDetectorChange(fileDiff('backend/src/modules/crossmodel/chat-agent/handback-detector.ts', ['x'])).detectors).toEqual(['handback-detector']);
  });
  it('a recall-replay test carrying the marker satisfies the rule', () => {
    expect(assessDetectorChange(RELAXATION_5BFFA38C + RECALL_TEST)).toMatchObject({ missingReplay: false, replayFiles: ['backend/src/modules/crossmodel/platform/action-verifier.recall.test.ts'] });
  });
  it("the marker inside the detector's own SOURCE does not count; the nightly suite's in-file self-test does", () => {
    const inSource = fileDiff('backend/src/modules/crossmodel/platform/action-verifier.ts', [`// ${DETECTOR_RECALL_MARKER}`]);
    expect(assessDetectorChange(inSource).missingReplay).toBe(true);
    const suiteSelfTest = fileDiff('scripts/e2e/query-suite.py', ["    # DETECTOR-RECALL REPLAY: the canvas-route FAIL cases still FAIL", "        verdict = 'WARN'"]);
    expect(assessDetectorChange(suiteSelfTest).missingReplay).toBe(false);
  });
  it('a diff that touches no detector is not a detector change', () => {
    expect(assessDetectorChange(fileDiff('backend/src/app.ts', ['x']))).toEqual({ detectors: [], replayFiles: [], missingReplay: false });
  });
  it('diffAddedLines keeps only + lines per file', () => {
    expect(diffAddedLines(fileDiff('a.ts', ['one', 'two'], ['old'])).get('a.ts')).toEqual(['one', 'two']);
  });
  it('kill switch reads DETECTOR_CHANGE_GUARD_DISABLED', () => {
    expect(detectorChangeGuardDisabled({} as any)).toBe(false);
    expect(detectorChangeGuardDisabled({ DETECTOR_CHANGE_GUARD_DISABLED: '1' } as any)).toBe(true);
  });
});

function apiFor(diff: string): GithubApi {
  return {
    async get(url: string, accept?: string) {
      if (accept === 'application/vnd.github.diff') return { status: 200, data: diff };
      if (url.includes('/check-runs')) return { status: 200, data: { check_runs: [{ name: 'Backend tests', status: 'completed', conclusion: 'success' }] } };
      if (url.includes('/status')) return { status: 200, data: { state: 'success', statuses: [{ state: 'success' }] } };
      if (url.includes('/pulls/9')) return { status: 200, data: { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'a'.repeat(40) } } };
      throw new Error(`unrouted GET ${url}`);
    },
    async put() { return { status: 405, data: {} }; },
  };
}
const base = { owner: 'example-org', repo: 'crossmodel', pullNumber: 9, sessionId: 'lane-1' };
const strikes = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'guard_strike' && r?.meta?.seam === 'detector_change');

describe('evaluateMergeGates — G7 detector_recall', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DETECTOR_CHANGE_GUARD_DISABLED;
    delete process.env.DETECTOR_CHANGE_GUARD_OBSERVE_ONLY;
    mockUfrFindFirst.mockResolvedValue(null);
  });
  const asTicketLane = () => mockUfrFindFirst.mockResolvedValue({ context: { dispatchMode: 'ticket_lane', dispatchedTo: 'lane-1' } });

  it('REPLAY 5bffa38c on a TICKET LANE: REFUSED with gate detector_recall and the recall-replay fix', async () => {
    asTicketLane();
    const v = await evaluateMergeGates({ ...base, api: apiFor(RELAXATION_5BFFA38C) }) as GateFailure;
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('detector_recall');
    expect(v.suggestedFix).toBe(DETECTOR_RECALL_SUGGESTED_FIX);
    expect(v.suggestedFix).toContain('needs owner review: detector relaxation');
    expect(strikes()[0]).toMatchObject({ sessionId: 'lane-1', meta: { seam: 'detector_change', state: 'enforced', outcome: 'refused', detectors: ['action-verifier'], ticketLane: true } });
    expect(mockUfrFindFirst.mock.calls[0][0]).toMatchObject({ where: { context: { path: ['dispatchedTo'], equals: 'lane-1' } } });
  });

  it('the same lane WITH a recall-replay test merges (noted)', async () => {
    asTicketLane();
    const v = await evaluateMergeGates({ ...base, api: apiFor(RELAXATION_5BFFA38C + RECALL_TEST) }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toContain('detector_recall: DETECTOR CHANGE (action-verifier) — recall replay in');
  });

  it('a NON-ticket session is observe-only: noted + metered, the merge proceeds', async () => {
    const v = await evaluateMergeGates({ ...base, api: apiFor(RELAXATION_5BFFA38C) }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toContain('with NO recall replay');
    expect(strikes()[0].meta).toMatchObject({ state: 'observed', outcome: 'observed', ticketLane: false });
  });

  it('DETECTOR_CHANGE_GUARD_OBSERVE_ONLY=1 notes on a ticket lane too; DETECTOR_CHANGE_GUARD_DISABLED=1 skips the check', async () => {
    asTicketLane();
    process.env.DETECTOR_CHANGE_GUARD_OBSERVE_ONLY = '1';
    expect((await evaluateMergeGates({ ...base, api: apiFor(RELAXATION_5BFFA38C) })).ok).toBe(true);
    delete process.env.DETECTOR_CHANGE_GUARD_OBSERVE_ONLY;
    process.env.DETECTOR_CHANGE_GUARD_DISABLED = '1';
    mockRecordLoopMetric.mockClear();
    const v = await evaluateMergeGates({ ...base, api: apiFor(RELAXATION_5BFFA38C) }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).not.toContain('detector_recall');
    expect(strikes()).toHaveLength(0);
  });

  it('isDispatchedTicketLane fails open to false on a read error', async () => {
    mockUfrFindFirst.mockRejectedValue(new Error('db down'));
    await expect(isDispatchedTicketLane('lane-1')).resolves.toBe(false);
  });
});

describe('the ticket-lane charter carries the rule', () => {
  it('TICKET_INSTRUCTIONS names the detectors, the marker and the "needs owner review" stop', () => {
    expect(DETECTOR_CHANGE_RULE).toContain('DETECTOR-RECALL REPLAY');
    expect(DETECTOR_CHANGE_RULE).toContain('needs owner review: detector relaxation');
    const src = readFileSync(join(__dirname, '..', 'feedback', 'ticket-dispatch.service.ts'), 'utf8');
    expect(src).toMatch(/DETECTOR_CHANGE_RULE \+\n\s+VERDICT_WAIT_POSTURE \+/);
  });
});
