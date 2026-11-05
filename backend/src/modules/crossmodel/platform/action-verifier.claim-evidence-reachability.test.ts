/**
 * N5 reachability (2026-09-26) — the claim-evidence gate must be CONSULTED
 * on the observe-only verifier path for the notes the fleet actually writes.
 *
 * Defect: purpose `claim_evidenced` had ZERO decision rows all-time (deploy
 * bff9033e, 16 wake_delivered + 3 verifier guard rows in the window). The gate
 * was fed `mineReceiptIdiomClaims` — the first-person LLM-miss fallback ("I
 * sent … to <id>") — which mined 0 claims in 0 of the 60 most recent prod
 * supervisor notes, so `startClaimEvidenceGate` returned null before decide()
 * on every wake. The fleet writes tool-name receipt lines and passive
 * report-up idioms; `mineGateClaimCandidates` now feeds the gate.
 *
 * Pins:
 *  - a supervisor note with two mined fleet-idiom claims, under observe-only
 *    verifier settings, produces ONE decide() call with two nouls — started
 *    before the LLM extraction and never awaited on the path — and two
 *    outcome rows labelled from the verifier's verdicts;
 *  - the old miner mines NOTHING from that note (the root cause, kept honest);
 *  - the sub-floor path, the no-claims path and the kill switch produce none;
 *  - the candidate miner's idiom table (positives from prod notes, negatives
 *    for the precision rails), first-person lines byte-identical to the old
 *    miner.
 *
 * Mock discipline mirrors action-verifier.claim-evidence-n5.test.ts.
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

import { computePhantomClaims, mineGateClaimCandidates, mineReceiptIdiomClaims } from './action-verifier';
import type { ToolReceipt } from '../coding/run-receipts';

const CHAT = 'c6941c11-4271-4efa-bdfc-628dc5e1eecd';
const USER = 'user-1';
const LANE = '7a8913e9-1111-4222-8333-444455556666';
const MSG = '7d1f3308-1111-4222-8333-444455556666';
const RECEIPT_ROW = 'e0ffbf1e-1111-4222-8333-444455556666';
const INVENTED = '9cb2cebf';

/**
 * The fleet's idiom — a project supervisor's close-out, verbatim shapes from
 * prod notes (2026-09-26): a tool-name receipt line (receipted) and a passive
 * report-up with a receipt anchor (invented). NO first person anywhere.
 */
const NOTE = `**Wake close-out (00:24Z).** Board unchanged; deploy landed, roster lane green.

- send_chat_message → ${MSG.slice(0, 8)} — ack/steer to roster lane ${LANE.slice(0, 8)}: four receipts logged, laya flag resolved
- Relay sent to the inference supervisor carrying the H100 ask — receipt ${INVENTED}
Next tick 02:24Z; nothing else changed this run.`;

const LLM_CLAIMS = JSON.stringify({
  claims: [
    { kind: 'message', detail: `send_chat_message → ${MSG.slice(0, 8)} — ack/steer to roster lane ${LANE.slice(0, 8)}`, id: MSG.slice(0, 8) },
    { kind: 'message', detail: `Relay sent to the inference supervisor carrying the H100 ask — receipt ${INVENTED}`, id: INVENTED },
  ],
});

const RECEIPTS: ToolReceipt[] = [
  {
    id: RECEIPT_ROW, chatId: CHAT, runId: 'run-1',
    tool: 'send_chat_message', ok: true,
    ids: { chatId: LANE, messageId: MSG },
    inputHash: 'in', outputHash: 'out', createdAt: new Date('2026-09-26T00:20:00Z'),
  } as any,
];

const flush = () => new Promise((r) => setImmediate(r));
const ENV = ['ACTION_VERIFIER_ENFORCE'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  mockUtilityChat.mockResolvedValue('{"claims":[]}');
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** The observe-only supervisor wake shape chat-agent's pre-delivery guard passes (ACTION_VERIFIER_ENFORCE unset). */
const audit = (finalText = NOTE, parts: any[] = []) => computePhantomClaims({
  chatId: CHAT, userId: USER, finalText, parts, receipts: RECEIPTS,
  runStartedAt: new Date('2026-09-26T00:15:00Z'),
  supervisor: true, supervisorScope: 'project', machineTriggered: true,
  deferConsequences: true, consequenceScope: 'citation-only',
} as any);

describe('N5 reachability — the gate is consulted on the fleet\'s real notes', () => {
  it('ROOT CAUSE, kept honest: the first-person fallback miner mines NOTHING from the fleet-idiom note; the candidate miner mines both claims', () => {
    expect(mineReceiptIdiomClaims(NOTE)).toEqual([]);
    const mined = mineGateClaimCandidates(NOTE);
    expect(mined.map((c) => [c.kind, c.id])).toEqual([['message', MSG.slice(0, 8)], ['message', INVENTED]]);
  });

  it('SHADOW, observe-only verifier: ONE decide() with two nouls, started before the LLM extraction and never awaited; outcome rows labelled from the verdicts', async () => {
    mockMode.mockReturnValue('shadow');
    let resolveGate!: (v: any) => void;
    const pending = new Promise((r) => { resolveGate = r; });
    mockDecide.mockReturnValue(pending);
    let decideCalledBeforeLlm = false;
    mockUtilityChat.mockImplementation(async () => { decideCalledBeforeLlm = mockDecide.mock.calls.length === 1; return LLM_CLAIMS; });

    const out = await audit(); // returns while the gate is still pending
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(decideCalledBeforeLlm).toBe(true);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(opts).toMatchObject({ purpose: 'claim_evidenced', sessionId: CHAT });
    expect(Object.keys(questions)).toEqual(['claim_0_evidenced', 'claim_1_evidenced']);
    expect(questions.claim_0_evidenced.type).toBe('noul');
    expect(questions.claim_1_evidenced.type).toBe('noul');
    expect(state).toMatchObject({ receipts_total: 1, receipts_ok: 1 });
    expect((state.claims as any[])[0]).toMatchObject({ kind: 'message', cited_id: MSG.slice(0, 8), cited_id_appears_in_a_receipt: true, a_successful_receipt_of_this_kind_exists: true });
    expect((state.claims as any[])[1]).toMatchObject({ kind: 'message', cited_id: INVENTED, cited_id_appears_in_a_receipt: false, a_successful_receipt_of_this_kind_exists: true });
    // The verifier's own verdicts: the receipted send exonerated, the invented receipt convicted.
    expect(out.claims.map((c) => c.id)).toEqual([MSG.slice(0, 8), INVENTED]);
    expect(out.phantoms.map((p) => p.id)).toEqual([INVENTED]);
    expect(mockRecord).not.toHaveBeenCalled(); // nothing lands while the gate is pending — never awaited on the path

    resolveGate({ id: 'g1', mode: 'shadow', backend: 'TypeSafe Jev', ms: 9, answers: { claim_0_evidenced: { type: 'noul', noul: 0.95 }, claim_1_evidenced: { type: 'noul', noul: 0.12 } } });
    await flush();
    expect(mockRecord).toHaveBeenCalledTimes(2);
    expect(mockRecord.mock.calls[0][1]).toBe('claim_evidenced');
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'claim_0_evidenced', actual: true, acted: false, sessionId: CHAT });
    expect(mockRecord.mock.calls[0][2].note).toContain('verdict:exonerated; lane:llm; note:struck 1; label:verifier');
    expect(mockRecord.mock.calls[1][2]).toMatchObject({ question: 'claim_1_evidenced', actual: false, acted: false });
    expect(mockRecord.mock.calls[1][2].note).toContain('verdict:convicted');
  });

  it('sub-floor note (< 40 chars, no args): no gate, no LLM call', async () => {
    mockMode.mockReturnValue('shadow');
    const out = await audit('Wake: no-op — nothing moved.');
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(out.phantoms).toEqual([]);
  });

  it('no-claims note (≥ 40 chars, no deed idiom): no gate; the LLM extraction still runs as before', async () => {
    mockMode.mockReturnValue('shadow');
    await audit('Board unchanged this wake; every lane healthy; next tick 02:24Z; nothing moved on any project.');
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    await flush();
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('mode off: no gate (the NODE_ENV=test default) — byte-identical verifier', async () => {
    mockUtilityChat.mockResolvedValue(LLM_CLAIMS);
    const out = await audit();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(out.phantoms.map((p) => p.id)).toEqual([INVENTED]);
  });
});

describe('mineGateClaimCandidates — the fleet idiom table', () => {
  const one = (line: string) => mineGateClaimCandidates(line).map((c) => [c.kind, c.id]);

  it('tool-name receipt lines mine by KIND_TOOLS kind (→ / bare / — separators)', () => {
    expect(one('- send_chat_message 69c724f9 — Fleet delta (queued pos 3): deploy landed, goal 00ec236b done')).toEqual([['message', '69c724f9']]);
    expect(one('- send_chat_message → 7d1f3308 — ack/steer to roster lane 7a8913e9: four receipts logged')).toEqual([['message', '7d1f3308']]);
    expect(one('- schedule_message → 5f90c628 — hourly sweep re-armed for the roster lane')).toEqual([['schedule', '5f90c628']]);
    expect(one('- file_feedback → 56d6b204 — owner mishap: sub-session results hidden behind the accordion')).toEqual([['ticket', '56d6b204']]);
    expect(one('- start_coding_session: 3e1cae6f — CanLaw bench on the fresh checkout')).toEqual([['dispatch', '3e1cae6f']]);
  });

  it('receipt-anchored completed-action verbs mine in ANY grammatical person', () => {
    expect(one('- Reported delta to Fleet Supervisor (receipt 74f01852, queued position 1)')).toEqual([['message', '74f01852']]);
    expect(one('- Relay sent to the inference supervisor (chat 2da8766f) carrying the H100 ask — receipt 9cb2cebf')).toEqual([['message', '9cb2cebf']]);
    expect(one('- Steered harvest lane 11449a0a (input restored, finish tgz ship → STEP B chain) — receipt 2d3a19be')).toEqual([['message', '2d3a19be']]);
    expect(one('- receipt 4466368f — Fleet report-up sent (chain-collision ruling landed, verdict-watch armed)')).toEqual([['message', '4466368f']]);
    expect(one('- Mishap filed for the owner: the accordion hides sub-session results — receipt 1a2b3c4d')).toEqual([['ticket', '1a2b3c4d']]);
  });

  it('the first-person rule without its person: verb + kind noun + kind anchor', () => {
    expect(one('Dispatched session 3e1cae6f to run the CanLaw bench on the fresh checkout.')).toEqual([['dispatch', '3e1cae6f']]);
    expect(one('Scheduled sweep 88d9287e to re-check the lane hourly.')).toEqual([['schedule', '88d9287e']]);
  });

  it('first-person lines stay byte-identical to the fallback miner (positions preserved for the N5 fixtures)', () => {
    const note = 'I dispatched session 3e1cae6f to run the CanLaw bench on the fresh checkout.\nI scheduled sweep 88d9287e to re-check the lane hourly.\nI started session abcdef12 for the bench.';
    expect(mineGateClaimCandidates(note)).toEqual(mineReceiptIdiomClaims(note));
    expect(one(note)).toEqual([['dispatch', '3e1cae6f'], ['schedule', '88d9287e'], ['dispatch', 'abcdef12']]);
  });

  it('precision rails: generic "started", blockquotes, the honesty register, non-claim tools, short lines, non-hex ids — never mined; dedupe per kind|id', () => {
    expect(one('Deploy started on lane 7a8913e9 at 00:17Z — endpoints live, four green e2e receipts')).toEqual([]);
    expect(one('> - send_chat_message → 7d1f3308 — quoted from an earlier note for audit')).toEqual([]);
    expect(one('- send_chat_message → 7d1f3308 — PLANNED, NOT EXECUTED: the steer goes out next wake')).toEqual([]);
    expect(one('- add_knowledge_note → 43db7012 — Laya contract filed to project KB (processing)')).toEqual([]);
    expect(one('sent rcpt 1a2b3c4d')).toEqual([]); // 18 chars — below the 20-char line floor
    expect(one('- send_chat_message → 68844 — Fleet delta queued behind the busy run this wake')).toEqual([]);
    expect(one('- send_chat_message → 7d1f3308 — first mention of the steer\n- send_chat_message → 7d1f3308 — restated in the close-out')).toEqual([['message', '7d1f3308']]);
  });
});
