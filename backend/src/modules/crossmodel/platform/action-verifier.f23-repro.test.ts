/**
 * LOCAL REPRO (FO firing 23, 2026-09-25) — do the two POST-fix reject_back
 * strikes still convict on current code? Decides deploy-lag vs real hole.
 * CanLaw line (c0e22e36 21:44:00Z, token "2:45 PM PDT" +9min) and the
 * f5c2c1f4 20:50:06Z line (token "22:10Z" +83min, has sent/landed verbs).
 */
const mockPrisma: any = { crossModelChat: { findUnique: jest.fn(async () => null) }, $queryRawUnsafe: jest.fn(async () => []) };
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
jest.mock('./supervisor-state.service', () => ({ __esModule: true, getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })), appendVerifierRefutation: jest.fn(async () => {}) }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { findFutureObservedTimestamps } from './action-verifier';

const CANLAW_NOW = new Date('2026-09-25T21:36:00Z'); // token 2:45 PM PDT = 21:45Z, +9 min
const F5_NOW = new Date('2026-09-25T20:47:00Z');     // token 22:10Z, +83 min

describe('firing-23 repro: post-fix prod strikes on current code', () => {
  it('CanLaw 21:44Z line (tilde range END, no verbs) — expect CLEAR on fixed code', () => {
    const line = '| CanLaw | Final SFT round training, no 5th preemption | TRAIN_DONE ~2:30–2:45 PM PDT |';
    const hits = findFutureObservedTimestamps(line, CANLAW_NOW);
    console.log('CANLAW_HITS=' + JSON.stringify(hits));
    expect(hits).toEqual([]);
  });

  it('ITER-15 PIN: the f5c2c1f4 20:50Z line (verbs in UNRELATED clauses) now CLEARS', () => {
    const line = '- Delta report-up sent to Fleet Supervisor (receipt 5f010ac6): capacity landed, cyan RUNNING, TRAIN_DONE re-anchored ≈21:55–22:10Z.';
    const hits = findFutureObservedTimestamps(line, F5_NOW);
    console.log('F5_HITS=' + JSON.stringify(hits));
    expect(hits).toEqual([]);
  });

  it('ITER-15 ANTI-SMUGGLE: same-clause verb still convicts ("merged by ~18:00–19:00Z")', () => {
    const NOW = new Date('2026-09-25T17:50:00Z'); // 18:00–19:00Z is FUTURE here
    const hits = findFutureObservedTimestamps('PR #1074 merged by ~18:00–19:00Z, all checks green.', NOW);
    expect(hits).toHaveLength(1);
    expect(hits[0].token).toContain('19:00Z');
  });

  it('ITER-15 ANTI-SMUGGLE: unmarked range still convicts ("stayed green across 18:00–19:40Z")', () => {
    const NOW = new Date('2026-09-25T17:50:00Z'); // 19:40Z is FUTURE here
    const hits = findFutureObservedTimestamps('Serving stayed green across 18:00–19:40Z during the soak.', NOW);
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('CONTROL: the pinned i14 shape still clears ("~19:00–19:40Z")', () => {
    expect(findFutureObservedTimestamps('Recovery verdict ~18:45–19:15Z, watch continues.', new Date('2026-09-25T18:14:53.275Z'))).toEqual([]);
  });
});

describe('firing-23 diagnostic: WHERE does the f5c2c1f4 conviction happen?', () => {
  it('estimateGovernedStamp on the f5 line end-token: exemptAt passes but LINE backstop kills it', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { estimateGovernedStamp } = require('./action-verifier');
    const line = '- Delta report-up sent to Fleet Supervisor (receipt 5f010ac6): capacity landed, cyan RUNNING, TRAIN_DONE re-anchored ≈21:55–22:10Z.';
    const idx = line.indexOf('22:10Z');
    const governed = estimateGovernedStamp(line, idx);
    console.log('F5_GOVERNED=' + governed);
    // If governed=true the whole line clears (no strike). Prod struck it, and
    // findFutureObservedTimestamps convicted — so governed must be false HERE.
    expect(typeof governed).toBe('boolean');
  });
});
