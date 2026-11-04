/**
 * send-draft-outcome.ts (E5 honest labels, 2026-09-25): the imessage_send
 * decision of a SURFACED draft parks in Redis and the confirm card's Send /
 * Cancel writes the outcome row against the STORED answer.
 *  - stash: user + id keyed, TTL set; junk ids / null stashes store nothing
 *  - confirmed ⇒ actual:true, declined ⇒ actual:false, note 'modal: …'
 *  - one-shot: the key is deleted after the label; a second answer records nothing
 *  - unknown / expired id, wrong purpose, Redis failure ⇒ recorded:false, never throws
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const store = new Map<string, string>();
const mockSet = jest.fn(async (k: string, v: string, _o?: unknown) => { store.set(k, v); return 'OK'; });
const mockGet = jest.fn(async (k: string) => store.get(k) ?? null);
const mockDel = jest.fn(async (k: string) => { store.delete(k); return 1; });
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => mockSet(...(a as [string, string, unknown])), get: (...a: any[]) => mockGet(a[0]), del: (...a: any[]) => mockDel(a[0]) },
}));

const mockRecord = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/decision-gate')),
  recordDecisionOutcome: (...a: any[]) => mockRecord(...a),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: jest.fn(),
}));

import { stashSendDraftDecision, recordSendDraftOutcome, validSendDraftDecisionId, SEND_DRAFT_DECISION_TTL_SEC } from './send-draft-outcome';

const stash = (id = 'ab12cd34') => ({ id, purpose: 'imessage_send' as const, mode: 'shadow' as const, backend: 'TypeSafe Jev', answers: { send: { type: 'noul' as const, noul: 0.9 } }, decidedAt: 'now' });

beforeEach(() => { jest.clearAllMocks(); store.clear(); });

describe('stashSendDraftDecision', () => {
  it('parks the stash under user + id with the TTL', async () => {
    expect(await stashSendDraftDecision('u1', stash())).toBe(true);
    expect(mockSet).toHaveBeenCalledWith('imsg_send_decision:u1:ab12cd34', JSON.stringify(stash()), { EX: SEND_DRAFT_DECISION_TTL_SEC });
  });
  it('stores nothing for a null stash, a missing user, or a junk id', async () => {
    expect(await stashSendDraftDecision('u1', null)).toBe(false);
    expect(await stashSendDraftDecision('', stash())).toBe(false);
    expect(await stashSendDraftDecision('u1', stash('bad id!'))).toBe(false);
    expect(mockSet).not.toHaveBeenCalled();
  });
  it('a Redis failure is swallowed (false)', async () => {
    mockSet.mockRejectedValueOnce(new Error('down'));
    expect(await stashSendDraftDecision('u1', stash())).toBe(false);
  });
});

describe('recordSendDraftOutcome', () => {
  it('confirmed ⇒ actual:true against the stored answer; the key is consumed', async () => {
    await stashSendDraftDecision('u1', stash());
    expect(await recordSendDraftOutcome('u1', 'ab12cd34', 'confirmed')).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const [decision, purpose, outcome] = mockRecord.mock.calls[0];
    expect(decision).toMatchObject({ id: 'ab12cd34', purpose: 'imessage_send', mode: 'shadow', backend: 'TypeSafe Jev', answers: { send: { type: 'noul', noul: 0.9 } } });
    expect(purpose).toBe('imessage_send');
    expect(outcome).toEqual({ question: 'send', actual: true, acted: false, note: 'modal: confirmed' });
    expect(mockDel).toHaveBeenCalledWith('imsg_send_decision:u1:ab12cd34');
    // one-shot
    expect(await recordSendDraftOutcome('u1', 'ab12cd34', 'declined')).toBe(false);
    expect(mockRecord).toHaveBeenCalledTimes(1);
  });
  it('declined ⇒ actual:false', async () => {
    await stashSendDraftDecision('u1', stash());
    expect(await recordSendDraftOutcome('u1', 'ab12cd34', 'declined')).toBe(true);
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'send', actual: false, acted: false, note: 'modal: declined' });
  });
  it('another user cannot label it; unknown ids and junk ids record nothing', async () => {
    await stashSendDraftDecision('u1', stash());
    expect(await recordSendDraftOutcome('u2', 'ab12cd34', 'confirmed')).toBe(false);
    expect(await recordSendDraftOutcome('u1', 'nope0000', 'confirmed')).toBe(false);
    expect(await recordSendDraftOutcome('u1', { id: 'x' }, 'confirmed')).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(store.has('imsg_send_decision:u1:ab12cd34')).toBe(true);
  });
  it('a malformed or wrong-purpose stash records nothing', async () => {
    store.set('imsg_send_decision:u1:ab12cd34', '{not json');
    expect(await recordSendDraftOutcome('u1', 'ab12cd34', 'confirmed')).toBe(false);
    store.set('imsg_send_decision:u1:ab12cd34', JSON.stringify({ ...stash(), purpose: 'wake_triage' }));
    expect(await recordSendDraftOutcome('u1', 'ab12cd34', 'confirmed')).toBe(false);
    expect(mockRecord).not.toHaveBeenCalled();
  });
  it('a Redis read failure is swallowed (false)', async () => {
    mockGet.mockRejectedValueOnce(new Error('down'));
    expect(await recordSendDraftOutcome('u1', 'ab12cd34', 'confirmed')).toBe(false);
  });
  it('validSendDraftDecisionId accepts decide() ids and rejects garbage', () => {
    expect(validSendDraftDecisionId('9f693276')).toBe(true);
    expect(validSendDraftDecisionId('a'.repeat(65))).toBe(false);
    expect(validSendDraftDecisionId('x y')).toBe(false);
    expect(validSendDraftDecisionId(12)).toBe(false);
  });
});
