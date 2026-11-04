/**
 * firing-superseded-gate.ts — backlog E09 (2026-09-28): the call-site ordering
 * that starved the purpose (0 decision rows all-time — a busy-parked STOCK SWEEP
 * always carries a sweep_triage stash, and the site asked this gate only when
 * no other stash rode the firing). Pins the pure site helpers:
 *   - supersededAskEligibleAtSite: every busy-parked recurring row is consulted,
 *     with or without a primary stash;
 *   - closeUnstartedSupersededStash: an unlabelled outcome row for a stash whose
 *     firing never started (a skip by another gate, a busy re-arm), so the
 *     decision still pairs; other purposes' stashes are ignored.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: { agentRun: { findFirst: jest.fn() }, codingMessage: { findFirst: jest.fn() } } }));
// MERGE-1 slice 1: read-switch seam, mocked so this suite never drags in
// coding-data.service -> middleware/error-handler -> config/env (process.exit(1) at
// import time without env vars). 'legacy' preserves every existing expectation.
jest.mock('./coding-data.service', () => ({ __esModule: true, pickTranscriptSource: jest.fn(async () => 'legacy') }));

const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: jest.fn(async () => null),
  decisionMode: jest.fn(() => 'off'),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  stashDecision: (d: any, purpose: string) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now' } : null),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));
jest.mock('../platform/supervisor.service', () => ({ __esModule: true, classifySupervisorNote: () => 'supervisor_note' }));

import { closeUnstartedSupersededStash, supersededAskEligibleAtSite, FIRING_SUPERSEDED_QUESTION } from './firing-superseded-gate';

beforeEach(() => { jest.clearAllMocks(); });

describe('E09 — supersededAskEligibleAtSite', () => {
  it('a busy-parked recurring row is consulted whether or not a primary (delta / sweep) stash rides the firing', () => {
    expect(supersededAskEligibleAtSite({ kind: 'recurring', busySkips: 3 })).toBe(true);
  });
  it('never a one-shot, never an unparked row (the leaf re-checks the full predicate)', () => {
    expect(supersededAskEligibleAtSite({ kind: 'once', busySkips: 3 })).toBe(false);
    expect(supersededAskEligibleAtSite({ kind: 'recurring', busySkips: 0 })).toBe(false);
    expect(supersededAskEligibleAtSite({ kind: 'recurring', busySkips: null })).toBe(false);
    expect(supersededAskEligibleAtSite({ kind: 'recurring' })).toBe(false);
  });
});

describe('E09 — closeUnstartedSupersededStash', () => {
  const stash = { id: 'fs-1', purpose: 'firing_superseded' as const, mode: 'shadow' as const, backend: 'TypeSafe Jev', backendSpec: 'jev', answers: { disposition: { type: 'choice' as const, choice: 'fire', confidence: 0.6, probabilities: { fire: 0.6 } } }, decidedAt: 'now' };
  it('writes ONE unlabelled outcome row (actual null, acted false) naming the reason, on the disposition question, with the backend spec carried', () => {
    closeUnstartedSupersededStash(stash, 's1', 'sweep_triage skip');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [decision, purpose, outcome] = mockRecord.mock.calls[0];
    expect(decision).toMatchObject({ id: 'fs-1', mode: 'shadow', backend: 'TypeSafe Jev', backendSpec: 'jev', ms: 0 });
    expect(purpose).toBe('firing_superseded');
    expect(outcome).toMatchObject({ question: FIRING_SUPERSEDED_QUESTION, actual: null, acted: false, sessionId: 's1', note: 'not started: sweep_triage skip' });
  });
  it('a null stash or another purpose’s stash writes nothing; never throws', () => {
    closeUnstartedSupersededStash(null, 's1', 'x');
    closeUnstartedSupersededStash({ ...stash, purpose: 'sweep_triage' as any }, 's1', 'x');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(() => closeUnstartedSupersededStash({} as any, 's1', 'x')).not.toThrow();
  });
});
