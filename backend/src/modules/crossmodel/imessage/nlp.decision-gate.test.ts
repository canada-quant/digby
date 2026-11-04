/**
 * classifySendDraft × decision gate (2026-09-24, purpose 'imessage_send').
 *
 * The gate sits BEFORE the ~8 s utility reasoning call:
 *  - off    → utility call exactly as before; the gate is never consulted.
 *  - shadow → gate consulted, utility call runs as before, and the utility
 *             verdict is recorded next to the gate's answer (acted:false).
 *  - act    → a confidently-NOT-a-send answer (noul ≤ 1 − threshold, default
 *             0.85 → ≤ 0.15) returns null WITHOUT the utility call
 *             (acted:true); anything less confident runs the utility call.
 *  - the gate can only remove work: a null / throwing gate falls through.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));

const mockDecide: jest.Mock = jest.fn();
const mockMode: jest.Mock = jest.fn();
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  // Mirror the real contract: a null decision records nothing.
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
  // E5: the real stash shape (id/purpose/mode/backend/answers/decidedAt); null for a null decision.
  stashDecision: (d: any, purpose: string) => d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now' } : null,
}));

import { classifySendDraft } from './nlp';

const chats = [{ chatId: 1, identifier: '+15551234567', displayName: 'Sarah Connor' }];
const history = [
  { role: 'user' as const, content: 'Draft a text to Sarah saying I am running late' },
  { role: 'assistant' as const, content: 'Hey Sarah, running about 10 minutes late — see you soon!' },
];
const LATEST = 'ok send it to Sarah';
const ANSWER = 'Sending: "Hey Sarah, running about 10 minutes late — see you soon!"';

const gateAnswer = (noul: number, mode: 'shadow' | 'act' = 'act') => ({
  id: 'dec1', answers: { send: { type: 'noul', noul } }, backend: 'test', ms: 7, mode,
});
const SEND_JSON = '{"send":true,"recipient":"Sarah","message":"Hey Sarah, running about 10 minutes late — see you soon!"}';
const NO_SEND_JSON = '{"send":false,"recipient":"","message":""}';

beforeEach(() => jest.clearAllMocks());

describe('classifySendDraft × decision gate', () => {
  it('(a) mode off → the utility call runs, the gate is never consulted, nothing is recorded', async () => {
    mockMode.mockReturnValue('off');
    mockUtilityChat.mockResolvedValue(SEND_JSON);
    const draft = await classifySendDraft(LATEST, ANSWER, history, chats);
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(draft).toMatchObject({ to: '+15551234567', displayName: 'Sarah Connor', resolved: true });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('(b) act + confidently NOT a send → null without the utility call; outcome acted:true', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gateAnswer(0.05));
    const draft = await classifySendDraft('can you make it a bit warmer?', ANSWER, history, chats);
    expect(draft).toBeNull();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][1]).toBe('imessage_send');
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'send', actual: null, acted: true });
  });

  it('(b′) act + exactly at the cutoff (noul 0.15 for the 0.85 default) still skips', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gateAnswer(0.15));
    expect(await classifySendDraft(LATEST, ANSWER, history, chats)).toBeNull();
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('(c) act + uncertain answer → the utility call runs; a SURFACING draft DEFERS its label (E5: the card labels it), carrying the decision stash', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gateAnswer(0.5));
    mockUtilityChat.mockResolvedValue(SEND_JSON);
    const draft = await classifySendDraft(LATEST, ANSWER, history, chats);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(draft?.resolved).toBe(true);
    expect(mockRecord).not.toHaveBeenCalled();
    expect(draft?.decision).toMatchObject({ id: 'dec1', purpose: 'imessage_send', mode: 'act', answers: { send: { type: 'noul', noul: 0.5 } } });
  });

  it('(c′) act + confidently a send → utility call runs (the gate only ever removes the call)', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gateAnswer(0.97));
    mockUtilityChat.mockResolvedValue(NO_SEND_JSON);
    const draft = await classifySendDraft(LATEST, ANSWER, history, chats);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(draft).toBeNull();
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'send', actual: false, acted: false });
  });

  it('(d) shadow → the utility call runs even on a confident NOT-a-send; the surfacing draft defers its label to the card (stash rides the draft)', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer(0.02, 'shadow'));
    mockUtilityChat.mockResolvedValue(SEND_JSON);
    const draft = await classifySendDraft(LATEST, ANSWER, history, chats);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(draft?.to).toBe('+15551234567');
    expect(mockRecord).not.toHaveBeenCalled();
    expect(draft?.decision).toMatchObject({ id: 'dec1', purpose: 'imessage_send', mode: 'shadow', backend: 'test', answers: { send: { type: 'noul', noul: 0.02 } } });
  });

  it('(d′) shadow + a NON-surfacing verdict (send:false) still closes the decision at classification time', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer(0.9, 'shadow'));
    mockUtilityChat.mockResolvedValue(NO_SEND_JSON);
    expect(await classifySendDraft(LATEST, ANSWER, history, chats)).toBeNull();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][0].id).toBe('dec1');
    expect(mockRecord.mock.calls[0][2]).toEqual({ question: 'send', actual: false, acted: false });
  });

  it('shadow: the state is small and code-selected (latest message + answer head), purpose + short timeout set', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(null);
    mockUtilityChat.mockResolvedValue(NO_SEND_JSON);
    const longAnswer = 'x'.repeat(5000);
    await classifySendDraft('m'.repeat(3000), longAnswer, history, chats);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(Object.keys(state).sort()).toEqual(['assistant_answer_head', 'latest_user_message']);
    expect(state.latest_user_message).toHaveLength(2000);
    expect(state.assistant_answer_head).toHaveLength(1200);
    expect(questions.send.type).toBe('noul');
    expect(opts).toEqual({ purpose: 'imessage_send', timeoutMs: 1500 });
  });

  it('shadow: a utility failure still records the (false) verdict and returns null', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer(0.9, 'shadow'));
    mockUtilityChat.mockRejectedValue(new Error('provider down'));
    expect(await classifySendDraft(LATEST, ANSWER, history, chats)).toBeNull();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'send', actual: false, acted: false });
  });

  it('a null gate answer (no backend / timeout) falls through to the utility call and records nothing', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(null);
    mockUtilityChat.mockResolvedValue(SEND_JSON);
    const draft = await classifySendDraft(LATEST, ANSWER, history, chats);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(draft?.resolved).toBe(true);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('a throwing gate (contract violation) fails OPEN to the utility call', async () => {
    mockMode.mockImplementation(() => { throw new Error('boom'); });
    mockUtilityChat.mockResolvedValue(SEND_JSON);
    const draft = await classifySendDraft(LATEST, ANSWER, history, chats);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(draft?.resolved).toBe(true);
  });
});
