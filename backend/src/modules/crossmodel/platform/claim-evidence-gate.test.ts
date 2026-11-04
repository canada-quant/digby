/**
 * claim-evidence-gate.ts — decision-gate purpose 'claim_evidenced' (N5, 2026-09-25).
 *
 *  - the kill switch, mode 'off' and an empty miner never call the seat;
 *  - the state is CODE-COMPUTED (receipts compacted ≤1.5k, per-claim id-match and
 *    kind-match facts), one noul per claim BY POSITION, capped;
 *  - the act contract skips the LLM lane only on the RESULT's act mode with
 *    every noul ≥ τ;
 *  - settle labels each claim from the VERIFIER'S verdict (convicted / exonerated /
 *    unjudged) and a thrown verifier pairs unlabelled rows.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import {
  CLAIM_EVIDENCE_RECEIPTS_CAP_CHARS,
  buildClaimEvidenceQuestions,
  buildClaimEvidenceState,
  claimEvidenceMaxClaims,
  claimEvidenceWouldSkipLlm,
  claimIdMatches,
  claimQuestionKey,
  settleClaimEvidenceGate,
  startClaimEvidenceGate,
  verifierVerdictFor,
} from './claim-evidence-gate';
import type { ExecutedAction } from './executed-actions';

const KIND_TOOLS = {
  dispatch: ['start_coding_session', 'dispatch_platform_task'],
  message: ['send_chat_message', 'notify_user'],
  schedule: ['schedule_message', 'update_schedule', 'cancel_schedule'],
  ticket: ['file_feedback'],
} as const;

const SESSION_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const SCHED_ID = 'f9e8d7c6-0000-4000-8000-000000000002';
const executed: ExecutedAction[] = [
  { tool: 'start_coding_session', ok: true, staged: false, ids: { sessionId: SESSION_ID, receiptId: 'rcpt-1' } },
  { tool: 'schedule_message', ok: false, staged: true, ids: { confirmationId: 'conf-9' } },
  { tool: 'todo_update', ok: true, staged: false, ids: { todoId: '0a7f2a5e-aaaa-bbbb-cccc-dddddddddddd' } },
];
const claims = [
  { kind: 'dispatch', detail: `I dispatched session ${SESSION_ID.slice(0, 8)} to run the bench.`, id: SESSION_ID.slice(0, 8) },
  { kind: 'schedule', detail: `I scheduled sweep ${SCHED_ID.slice(0, 8)} hourly.`, id: SCHED_ID.slice(0, 8) },
];

const ENV = ['DECISION_GATE_CLAIM_EVIDENCE_MAX_CLAIMS'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  jest.clearAllMocks();
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const flush = () => new Promise((r) => setImmediate(r));

describe('pure builders', () => {
  it('claimIdMatches is prefix-tolerant at 8 hex chars, case-insensitive, and never matches short ids', () => {
    expect(claimIdMatches(SESSION_ID, SESSION_ID.slice(0, 8).toUpperCase())).toBe(true);
    expect(claimIdMatches('a1b2c3d', 'a1b2c3d')).toBe(false);
    expect(claimIdMatches(SESSION_ID, SCHED_ID)).toBe(false);
    expect(claimIdMatches(undefined, SESSION_ID)).toBe(false);
  });

  it('buildClaimEvidenceState compacts the receipts within the cap and pre-computes the id-match / kind-match facts', () => {
    const state = buildClaimEvidenceState({ claims, executed, kindTools: KIND_TOOLS });
    expect(state).toMatchObject({ receipts_total: 3, receipts_ok: 2, receipts_shown: 3 });
    expect((state.receipts as any[])[0]).toEqual({ tool: 'start_coding_session', ok: true, ids: [SESSION_ID, 'rcpt-1'] });
    expect((state.receipts as any[])[1]).toEqual({ tool: 'schedule_message', ok: false, staged: true, ids: ['conf-9'] });
    expect((state.claims as any[])[0]).toMatchObject({ index: 0, kind: 'dispatch', cited_id: SESSION_ID.slice(0, 8), cited_id_appears_in_a_receipt: true, a_successful_receipt_of_this_kind_exists: true });
    expect((state.claims as any[])[1]).toMatchObject({ index: 1, kind: 'schedule', cited_id_appears_in_a_receipt: false, a_successful_receipt_of_this_kind_exists: false });
    expect(JSON.stringify(state.receipts).length).toBeLessThanOrEqual(CLAIM_EVIDENCE_RECEIPTS_CAP_CHARS + 2);
    // A flood of receipts is truncated to the cap, never the claims.
    const many = Array.from({ length: 200 }, (_, i) => ({ tool: 'send_chat_message', ok: true, staged: false, ids: { messageId: `m${i}-0000-4000-8000-000000000000` } }));
    const big = buildClaimEvidenceState({ claims, executed: many, kindTools: KIND_TOOLS });
    expect(big.receipts_total).toBe(200);
    expect(Number(big.receipts_shown)).toBeLessThan(200);
    expect(JSON.stringify(big.receipts).length).toBeLessThanOrEqual(CLAIM_EVIDENCE_RECEIPTS_CAP_CHARS + 2);
    expect((big.claims as any[]).length).toBe(2);
    // The head is bounded at 300 chars.
    const long = buildClaimEvidenceState({ claims: [{ kind: 'ticket', detail: 'I filed ticket 12345678 ' + 'y'.repeat(900), id: '12345678' }], executed, kindTools: KIND_TOOLS });
    expect(((long.claims as any[])[0].head as string).length).toBe(300);
  });

  it('buildClaimEvidenceQuestions is by position — the same count yields the same keys and texts', () => {
    const q2 = buildClaimEvidenceQuestions(2);
    expect(Object.keys(q2)).toEqual([claimQuestionKey(0), claimQuestionKey(1)]);
    expect(q2.claim_0_evidenced.type).toBe('noul');
    expect((q2.claim_0_evidenced as any).criteria).toEqual(expect.objectContaining({ true: expect.any(String), false: expect.any(String) }));
    expect(buildClaimEvidenceQuestions(2)).toEqual(q2);
    expect(buildClaimEvidenceQuestions(0)).toEqual({});
  });

  it('claimEvidenceMaxClaims is clamped 1..20', () => {
    expect(claimEvidenceMaxClaims()).toBe(8);
    process.env.DECISION_GATE_CLAIM_EVIDENCE_MAX_CLAIMS = '0';
    expect(claimEvidenceMaxClaims()).toBe(1);
    process.env.DECISION_GATE_CLAIM_EVIDENCE_MAX_CLAIMS = '99';
    expect(claimEvidenceMaxClaims()).toBe(20);
  });
});

describe('startClaimEvidenceGate', () => {
  it('returns null (no call) when the mode is off, or when nothing was mined', () => {
    mockMode.mockReturnValue('off');
    expect(startClaimEvidenceGate({ chatId: 'c1', claims, executed, kindTools: KIND_TOOLS })).toBeNull();
    mockMode.mockReturnValue('shadow');
    expect(startClaimEvidenceGate({ chatId: 'c1', claims: [], executed, kindTools: KIND_TOOLS })).toBeNull();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('starts ONE request with a noul per mined claim (capped) under purpose claim_evidenced and the chat as sessionId — without awaiting it', async () => {
    mockMode.mockReturnValue('shadow');
    process.env.DECISION_GATE_CLAIM_EVIDENCE_MAX_CLAIMS = '1';
    let resolve!: (v: any) => void;
    mockDecide.mockReturnValue(new Promise((r) => { resolve = r; }));
    const gate = startClaimEvidenceGate({ chatId: 'chat-xyz', claims, executed, kindTools: KIND_TOOLS });
    expect(gate).not.toBeNull();
    expect(gate!.claims).toHaveLength(1);
    expect(gate!.requestedMode).toBe('shadow');
    expect(mockDecide).toHaveBeenCalledTimes(1);
    const [, questions, opts] = mockDecide.mock.calls[0];
    expect(Object.keys(questions)).toEqual(['claim_0_evidenced']);
    expect(opts).toMatchObject({ purpose: 'claim_evidenced', sessionId: 'chat-xyz' });
    resolve({ id: 'g1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 5, answers: { claim_0_evidenced: { type: 'noul', noul: 0.95 } } });
    await expect(gate!.decision).resolves.toMatchObject({ id: 'g1' });
  });

  it('a rejecting decide() resolves the handle to null (never rejects)', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockRejectedValue(new Error('seat down'));
    const gate = startClaimEvidenceGate({ chatId: 'c1', claims, executed, kindTools: KIND_TOOLS });
    await expect(gate!.decision).resolves.toBeNull();
  });
});

describe('claimEvidenceWouldSkipLlm (act contract)', () => {
  const d = (mode: 'shadow' | 'act', ...nouls: number[]) => ({
    id: 'x', mode, backend: 'b', ms: 1,
    answers: Object.fromEntries(nouls.map((n, k) => [claimQuestionKey(k), { type: 'noul', noul: n }])),
  }) as any;
  it('skips only on the RESULT mode act with every noul ≥ τ (0.9)', () => {
    expect(claimEvidenceWouldSkipLlm(d('act', 0.95, 0.91), 2)).toBe(true);
    expect(claimEvidenceWouldSkipLlm(d('shadow', 0.99, 0.99), 2)).toBe(false);
    expect(claimEvidenceWouldSkipLlm(d('act', 0.95, 0.6), 2)).toBe(false);
    expect(claimEvidenceWouldSkipLlm(d('act', 0.95), 2)).toBe(false); // a missing noul never skips
    expect(claimEvidenceWouldSkipLlm(null, 1)).toBe(false);
    expect(claimEvidenceWouldSkipLlm(d('act', 0.99), 0)).toBe(false);
  });
});

describe('verifierVerdictFor + settleClaimEvidenceGate', () => {
  const computation = {
    claims: [claims[0], { kind: 'ticket', detail: 'filed ticket', id: 'deadbeef' }],
    phantoms: [{ kind: 'receipt', detail: 'receipt f9e8d7c6', id: 'f9e8d7c6' }, { kind: 'ticket', detail: 'filed ticket', id: 'deadbeef' }],
  };
  it('convicted when any phantom carries the cited id (any lane); exonerated when surfaced and not convicted; unjudged otherwise', () => {
    expect(verifierVerdictFor(claims[0], computation)).toBe('exonerated');
    expect(verifierVerdictFor(claims[1], computation)).toBe('convicted');
    expect(verifierVerdictFor({ kind: 'ticket', detail: 'x', id: 'deadbeef' }, computation)).toBe('convicted');
    expect(verifierVerdictFor({ kind: 'message', detail: 'x', id: '0123abcd' }, computation)).toBe('unjudged');
  });

  it('settle records one outcome row per claim with the verifier verdict as the label and the lane in the note', async () => {
    const decision = { id: 'g2', mode: 'shadow', backend: 'TypeSafe Jev', ms: 3, answers: { claim_0_evidenced: { type: 'noul', noul: 0.9 }, claim_1_evidenced: { type: 'noul', noul: 0.2 } } } as any;
    settleClaimEvidenceGate({ claims, requestedMode: 'shadow', decision: Promise.resolve(decision), sessionId: 'chat-1' }, { computation, lane: 'llm' });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[0][1]).toBe('claim_evidenced');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'claim_0_evidenced', actual: true, acted: false, sessionId: 'chat-1' });
    expect(mockRecord.mock.calls[0][2].note).toContain('verdict:exonerated; lane:llm; note:struck 2; label:verifier');
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'claim_1_evidenced', actual: false });
    expect(mockRecord.mock.calls[1][2].note).toContain('verdict:convicted');
  });

  it('a verifier that threw pairs every claim unlabelled; a null decision / null gate records nothing', async () => {
    const decision = { id: 'g3', mode: 'shadow', backend: 'b', ms: 3, answers: { claim_0_evidenced: { type: 'noul', noul: 0.9 } } } as any;
    settleClaimEvidenceGate({ claims: [claims[0]], requestedMode: 'shadow', decision: Promise.resolve(decision), sessionId: 'c' }, { computation: null, lane: 'llm', error: 'db down' });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ actual: null });
    expect(mockRecord.mock.calls[0][2].note).toContain('verdict:verifier_threw');
    expect(mockRecord.mock.calls[0][2].note).toContain('error:db down');
    mockRecord.mockClear();
    settleClaimEvidenceGate({ claims, requestedMode: 'shadow', decision: Promise.resolve(null), sessionId: 'c' }, { computation, lane: 'llm' });
    settleClaimEvidenceGate(null, { computation, lane: 'llm' });
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
