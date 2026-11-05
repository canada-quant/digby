/**
 * N5 (2026-09-25) — the claim-evidence decision gate inside computePhantomClaims.
 *
 *  - SHADOW runs CONCURRENTLY with the utility-LLM extraction: decide() is
 *    started BEFORE utilityChat is called and never awaited on the path — the
 *    matcher returns while the gate is still pending, and the per-claim
 *    outcome rows land afterwards with the VERIFIER'S verdict as the label;
 *  - a receipted claim labels actual:true, a phantom labels actual:false;
 *  - ACT (designed, not enabled) awaits the gate in place of the LLM call and
 *    skips the extraction when every mined claim is confidently evidenced —
 *    the tier chain still judges the claims;
 *  - mode off / kill switch: byte-identical verifier, no seat call.
 *
 * Mock discipline mirrors action-verifier.5ad80b27.test.ts.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '{"claims":[]}');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
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

import { computePhantomClaims } from './action-verifier';
import type { ToolReceipt } from '../coding/run-receipts';

const CHAT = 'c0e22e36-4271-4efa-bdfc-628dc5e1eecd';
const USER = 'user-1';
const SESSION = '3e1cae6f-1111-4222-8333-444455556666';
const PHANTOM = '88d9287e-1111-4222-8333-444455556666';

/** Two first-person id-bearing claims the deterministic miner finds: one receipted, one invented. */
const NOTE = `## Wake close-out

I dispatched session ${SESSION.slice(0, 8)} to run the CanLaw bench on the fresh checkout.
I scheduled sweep ${PHANTOM.slice(0, 8)} to re-check the lane hourly.
Nothing else was changed this run.`;

const RECEIPTS: ToolReceipt[] = [
  {
    id: 'rcpt-0001-1111-2222-333344445555', chatId: CHAT, runId: 'run-1',
    tool: 'start_coding_session', ok: true,
    ids: { sessionId: SESSION },
    inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-09-25T07:05:00Z'),
  } as any,
];

const flush = () => new Promise((r) => setImmediate(r));
beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockUtilityChat.mockResolvedValue('{"claims":[]}');
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
});
const audit = () => computePhantomClaims({ chatId: CHAT, userId: USER, finalText: NOTE, parts: [], receipts: RECEIPTS, runStartedAt: new Date('2026-09-25T07:00:00Z') });

describe('N5 claim-evidence gate in computePhantomClaims', () => {
  it('mode off: no seat call; the verifier still convicts the invented schedule and exonerates the receipted dispatch', async () => {
    const out = await audit();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(out.phantoms.map((p) => p.id?.toLowerCase())).toContain(PHANTOM.slice(0, 8));
    expect(out.phantoms.some((p) => String(p.id ?? '').toLowerCase().startsWith(SESSION.slice(0, 8)))).toBe(false);
  });

  it('SHADOW: decide() starts before the LLM extraction and is never awaited on the path; labels land afterwards from the verdict', async () => {
    mockMode.mockReturnValue('shadow');
    let resolveGate!: (v: any) => void;
    const pending = new Promise((r) => { resolveGate = r; });
    mockDecide.mockReturnValue(pending);
    let decideCalledBeforeLlm = false;
    mockUtilityChat.mockImplementation(async () => { decideCalledBeforeLlm = mockDecide.mock.calls.length === 1; return '{"claims":[]}'; });

    const out = await audit(); // returns while the gate is still pending
    expect(decideCalledBeforeLlm).toBe(true);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(opts).toMatchObject({ purpose: 'claim_evidenced', sessionId: CHAT });
    expect(Object.keys(questions)).toEqual(['claim_0_evidenced', 'claim_1_evidenced']);
    expect(state).toMatchObject({ receipts_total: 1, receipts_ok: 1 });
    expect((state.claims as any[])[0]).toMatchObject({ kind: 'dispatch', cited_id_appears_in_a_receipt: true, a_successful_receipt_of_this_kind_exists: true });
    expect((state.claims as any[])[1]).toMatchObject({ kind: 'schedule', cited_id_appears_in_a_receipt: false, a_successful_receipt_of_this_kind_exists: false });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(out.phantoms.length).toBe(1);

    resolveGate({ id: 'g1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 7, answers: { claim_0_evidenced: { type: 'noul', noul: 0.96 }, claim_1_evidenced: { type: 'noul', noul: 0.08 } } });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[0][1]).toBe('claim_evidenced');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'claim_0_evidenced', actual: true, acted: false, sessionId: CHAT });
    expect(mockRecord.mock.calls[0][2].note).toContain('verdict:exonerated; lane:miner; note:struck 1; label:verifier');
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'claim_1_evidenced', actual: false });
    expect(mockRecord.mock.calls[1][2].note).toContain('verdict:convicted');
  });

  it('ACT (designed, not enabled): every mined claim confidently evidenced ⇒ the LLM extraction is skipped and the tier chain still judges the claims', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue({ id: 'g2', mode: 'act', backend: 'TypeSafe Jev', ms: 7, answers: { claim_0_evidenced: { type: 'noul', noul: 0.97 }, claim_1_evidenced: { type: 'noul', noul: 0.95 } } });
    const out = await audit();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(out.claims.map((c) => c.kind)).toEqual(['dispatch', 'schedule']);
    expect(out.phantoms.length).toBe(1); // the gate never overrides the verifier — the invented schedule still convicts
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ acted: true, actual: true });
    expect(mockRecord.mock.calls[0][2].note).toContain('lane:gate');
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ acted: true, actual: false });
  });

  it('ACT with one claim below τ, or a RESULT downgraded to shadow (E2), keeps the LLM lane', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue({ id: 'g3', mode: 'act', backend: 'b', ms: 7, answers: { claim_0_evidenced: { type: 'noul', noul: 0.97 }, claim_1_evidenced: { type: 'noul', noul: 0.5 } } });
    await audit();
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    mockUtilityChat.mockClear();
    mockDecide.mockResolvedValue({ id: 'g4', mode: 'shadow', backend: 'b', ms: 7, answers: { claim_0_evidenced: { type: 'noul', noul: 0.99 }, claim_1_evidenced: { type: 'noul', noul: 0.99 } } });
    await audit();
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
  });

  it('a gate that rejects fails open: the verifier runs as before and no row is recorded', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockRejectedValue(new Error('seat down'));
    const out = await audit();
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(out.phantoms.length).toBe(1);
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
  });
});
