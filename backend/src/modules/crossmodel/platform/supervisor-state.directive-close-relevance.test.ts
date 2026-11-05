/**
 * audit 2026-10-06 T5-8 (fleet F4, spark F9): a directive closed with evidence
 * about a DIFFERENT item (real ids, wrong incident) is recorded + warned —
 * OBSERVE-ONLY, the close always lands. Pure leaf
 * (directive-close-relevance.ts) + the applyStateUpdate seam.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn() },
  // The typed-evidence existence probe resolves 'session <id>' via findFirst — a real lane.
  crossModelChat: { findUnique: jest.fn(async () => null), findFirst: jest.fn(async () => ({ id: 'c90fed41-0000-4000-8000-000000000001' })) },
  projectTodo: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  agentRun: { groupBy: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: jest.fn(),
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));
jest.mock('./action-verifier', () => {
  const actual = jest.requireActual('./action-verifier');
  return { ...actual, citedMessageRowExists: jest.fn(async () => true), citedScheduleRowExists: jest.fn(async () => true), samePrefixRealIds: jest.fn(async () => []) };
});

import { applyStateUpdate, SupervisorStateDoc } from './supervisor-state.service';
import { directiveCloseRelevance, salientTokens, directiveCloseRelevanceDisabled } from './directive-close-relevance';

const CHAT = 'sup-chat-1';
const UID = 'u1';
const EMPTY: SupervisorStateDoc = { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };
let table: Map<string, unknown>;
const stored = (): SupervisorStateDoc => table.get(CHAT) as SupervisorStateDoc;
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  table = new Map();
  delete process.env.DIRECTIVE_CLOSE_RELEVANCE_DISABLED;
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) => (table.has(where.chatId) ? { state: table.get(where.chatId) } : null));
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return {};
  });
});

describe('directiveCloseRelevance (pure)', () => {
  it('the spark replay: an AGX reflash HOLD closed with a watchdog S4 power-cycle is UNRELATED', () => {
    const r = directiveCloseRelevance({
      directiveText: 'AGX reflash HOLD — green-signal = AGX lane 88ced668 verify chain',
      evidence: 'session c90fed41 — watchdog lane resolved S4 device hang via Hue power-cycle; GLM healthy',
    });
    expect(r).toEqual({ related: false, shared: [], undecidable: false });
  });

  it('the fleet replay: the owner autonomy question closed with an unrelated Schooltime steer is UNRELATED', () => {
    const r = directiveCloseRelevance({
      directiveText: 'what the hell is going on with the autonomy of the supervisors — why is nothing moving',
      evidence: 'oq_d2110692 answered by supervisor; steer queued msg 56102fff to Schooltime Supervisor about the lesson planner',
    });
    expect(r.related).toBe(false);
  });

  it('a shared id prefix, scope or key noun relates them; inflections meet ("deployed" ~ "deploy")', () => {
    expect(directiveCloseRelevance({ directiveText: 'relay the routes ask to lane 88ced668', evidence: 'session 88ced668-1111-4222-8333-444455556666 picked it up and wrote the handler' }).shared).toEqual(['id:88ced668']);
    expect(directiveCloseRelevance({ directiveText: 'deploy the bench harness', evidence: 'pr #41 deployed — harness bench green on main' }).related).toBe(true);
    expect(directiveCloseRelevance({ directiveText: 'fix it', scope: 'f4f34898-afb7-47ae-9f9b-4c68757d09be', evidence: 'pr #9 in project f4f34898 merged, gateway fixed' }).related).toBe(true);
  });

  it('id-only / terse evidence and a token-less directive are UNDECIDABLE — never flagged', () => {
    expect(directiveCloseRelevance({ directiveText: 'move the H100 job', evidence: 'pr #215' })).toMatchObject({ related: true, undecidable: true });
    expect(directiveCloseRelevance({ directiveText: 'move the H100 job', evidence: 'session 1a2b3c4d merged' })).toMatchObject({ related: true, undecidable: true });
    expect(directiveCloseRelevance({ directiveText: 'do it now', evidence: 'session 1a2b3c4d resolved watchdog device hang' })).toMatchObject({ related: true, undecidable: true });
  });

  it('salientTokens: ids by 8-char prefix (digits-only runs are not ids), stopwords and fleet words dropped', () => {
    const t = salientTokens('Supervisor lane 2602af09-aaaa-4bbb fixed 20261006 GPU routes');
    expect(t.has('id:2602af09')).toBe(true);
    expect(t.has('id:20261006')).toBe(false);
    expect(t.has('supervisor')).toBe(false);
    expect(t.has('lane')).toBe(false);
    expect(t.has('route')).toBe(true);
  });
});

describe('applyStateUpdate — the observe-only mismatch warning', () => {
  const seed = (text: string) => table.set(CHAT, { ...EMPTY, directives: [{ id: 'd1', text, at: new Date().toISOString(), status: 'open' }] });

  it('a close whose evidence shares nothing LANDS, the ack warns, one directive_close_mismatch row', async () => {
    seed('AGX reflash HOLD — green-signal = AGX lane verify chain');
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'session c90fed41 — watchdog resolved S4 device hang via Hue power-cycle' }] });
    await flush();
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
    expect(r.applied.join(' ')).toMatch(/directive d1 closed with evidence that shares NO id or key noun with the directive \(observed only — the close stands\)/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'directive_close_mismatch', sessionId: CHAT,
      meta: expect.objectContaining({ directiveId: 'd1', outcome: 'observed' }),
    }));
  });

  it('a related close is silent', async () => {
    seed('Wire the node-b gateway routes');
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'session c90fed41 wrote the node-b routes; gateway answered 200' }] });
    await flush();
    expect(r.applied.join(' ')).not.toMatch(/shares NO id/);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_close_mismatch' }));
  });

  it('kill switch DIRECTIVE_CLOSE_RELEVANCE_DISABLED=1: no warning, no row', async () => {
    process.env.DIRECTIVE_CLOSE_RELEVANCE_DISABLED = '1';
    expect(directiveCloseRelevanceDisabled()).toBe(true);
    seed('AGX reflash HOLD — green-signal = AGX lane verify chain');
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'session c90fed41 — watchdog resolved S4 device hang via Hue power-cycle' }] });
    await flush();
    expect(stored().directives[0].status).toBe('done');
    expect(r.applied.join(' ')).not.toMatch(/shares NO id/);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_close_mismatch' }));
  });
});
