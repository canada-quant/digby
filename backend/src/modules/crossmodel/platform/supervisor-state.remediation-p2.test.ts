/**
 * Remediation P2 — supervisor-state directive integrity:
 *   v1#3 / spark B6  cap eviction (done-first, standing never, all-open
 *                    overflow raises the effective cap + directive_overflow
 *                    metric), ack/status-question capture classification,
 *                    standing-flag capture
 *   v1#4 / CanLaw B4 evidence-TYPED closure + owner-gate directives +
 *                    existence checks
 *   v1#2             [FLEET ATTENTION] sizing (hoisted boilerplate, per-item
 *                    cap, whole-item overflow drops)
 *   v1#5 helpers     appendAnsweredQuestionDirective + listOpenDirectivesForUser
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  supervisorState: { findUnique: jest.fn(), upsert: jest.fn(), findMany: jest.fn(async () => []) },
  crossModelChat: { findUnique: jest.fn(), findFirst: jest.fn(async () => null) },
  projectTodo: { findMany: jest.fn(async () => []) },
  codingSchedule: { findMany: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  userFeatureRequest: { findFirst: jest.fn(async () => null) },
  // Ticket 8f5a45f7: stalled-todo liveness suppression reads run activity.
  agentRun: { groupBy: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// directive_overflow metric — dynamic import boundary.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

// cfeb1a57 citation lane — keep the real miners, mock the row checks (the
// supervisor-state.service.test.ts pattern).
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));
const mockCitedMessageRowExists = jest.fn(async (_id: string) => true);
const mockCitedScheduleRowExists = jest.fn(async (_id: string) => true);
jest.mock('./action-verifier', () => {
  const actual = jest.requireActual('./action-verifier');
  return {
    ...actual,
    citedMessageRowExists: (...a: any[]) => (mockCitedMessageRowExists as any)(...a),
    citedScheduleRowExists: (...a: any[]) => (mockCitedScheduleRowExists as any)(...a),
    samePrefixRealIds: jest.fn(async () => []),
  };
});

import {
  applyStateUpdate,
  appendDirective,
  appendAnsweredQuestionDirective,
  listOpenDirectivesForUser,
  evictDirectivesAtCap,
  isAckOrStatusQuestion,
  parseTypedEvidence,
  buildFleetAttentionBlock,
  STANDING_DIRECTIVE_RE,
  OWNER_GATE_DIRECTIVE_RE,
  ATTENTION_ITEM_CAP,
  SupervisorDirective,
  SupervisorStateDoc,
} from './supervisor-state.service';

const CHAT = 'sup-1';
const UID = 'u1';
const EMPTY: SupervisorStateDoc = { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '' };

let table: Map<string, unknown>;

beforeEach(() => {
  jest.clearAllMocks();
  table = new Map();
  mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) =>
    table.has(where.chatId) ? { state: table.get(where.chatId) } : null);
  mockPrisma.supervisorState.upsert.mockImplementation(async ({ where, create, update }: any) => {
    table.set(where.chatId, table.has(where.chatId) ? update.state : create.state);
    return {};
  });
  mockPrisma.supervisorState.findMany.mockResolvedValue([]);
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ isSupervisor: true });
  mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
  mockPrisma.ownerQuestion.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockCitedMessageRowExists.mockResolvedValue(true);
  mockCitedScheduleRowExists.mockResolvedValue(true);
});

const stored = (): SupervisorStateDoc => table.get(CHAT) as SupervisorStateDoc;
const d = (over: Partial<SupervisorDirective>): SupervisorDirective =>
  ({ id: 'x', text: 't', at: '2026-09-01T00:00:00.000Z', status: 'open', ...over });

// ── v1#3 / spark B6 — eviction + capture classification ─────────────────────

describe('spark B6 / v1#3 — directive-ledger eviction', () => {
  it('evictDirectivesAtCap: DONE non-standing rows evict oldest-first; OPEN rows never do', () => {
    const rows = [
      d({ id: 'done-old', status: 'done' }),
      d({ id: 'open-old' }),
      d({ id: 'done-new', status: 'done' }),
      d({ id: 'open-new' }),
    ];
    const r = evictDirectivesAtCap(rows, 3);
    expect(r.overflow).toBe(0);
    expect(r.directives.map((x) => x.id)).toEqual(['open-old', 'done-new', 'open-new']);
  });

  it('evictDirectivesAtCap: a standing DONE row survives while a plain done one evicts', () => {
    const rows = [
      d({ id: 'done-standing', status: 'done', standing: true }),
      d({ id: 'done-plain', status: 'done' }),
      d({ id: 'open-1' }),
      d({ id: 'open-2' }),
    ];
    const r = evictDirectivesAtCap(rows, 3);
    expect(r.directives.map((x) => x.id)).toEqual(['done-standing', 'open-1', 'open-2']);
    expect(r.overflow).toBe(0);
  });

  it('evictDirectivesAtCap: ALL-OPEN over the cap keeps everything and reports the overflow', () => {
    const rows = Array.from({ length: 5 }, (_, i) => d({ id: `o${i}` }));
    const r = evictDirectivesAtCap(rows, 3);
    expect(r.directives).toHaveLength(5);
    expect(r.overflow).toBe(2);
  });

  it('applyStateUpdate emits the directive_overflow metric on an all-open overflow', async () => {
    // Fresh rows: the directive archive (autonomy loop #6) would move OPEN
    // rows older than 7 d out of the live ledger first — this test is about
    // an overflow of rows that are all still current.
    const fresh = new Date().toISOString();
    table.set(CHAT, {
      ...EMPTY,
      directives: Array.from({ length: 50 }, (_, i) => d({ id: `o${i}`, text: `order ${i}`, at: fresh })),
    });
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ text: 'the fifty-first owner order' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives).toHaveLength(51);
    await new Promise((res) => setTimeout(res, 5)); // fire-and-forget metric
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'directive_overflow', sessionId: CHAT }));
  });

  it('isAckOrStatusQuestion: acks and bare status questions are not directives; real orders are', () => {
    expect(isAckOrStatusQuestion('ok thanks!')).toBe(true);
    expect(isAckOrStatusQuestion('👍')).toBe(true);
    expect(isAckOrStatusQuestion('how did it go?')).toBe(true);
    expect(isAckOrStatusQuestion('any update?')).toBe(true);
    expect(isAckOrStatusQuestion("what's the status?")).toBe(true);
    expect(isAckOrStatusQuestion('Swap the bench lane to Machete and run the cutover tonight')).toBe(false);
    expect(isAckOrStatusQuestion('ok, but also re-run the failing suite before merging')).toBe(false);
  });

  it('appendDirective SKIPS acks, ledgers a status question as kind:"ask" (tt-rd audit 2026-09-27), and flags grant-ish phrasing standing', async () => {
    await appendDirective(CHAT, UID, 'thanks!');
    expect(table.has(CHAT)).toBe(false); // an ack is never recorded
    await appendDirective(CHAT, UID, 'how did it go?');
    expect(stored().directives).toHaveLength(1); // a status question IS recorded — as an ask, never standing
    expect(stored().directives[0]).toMatchObject({ text: 'how did it go?', status: 'open', kind: 'ask' });
    expect(stored().directives[0].standing).toBeUndefined();
    await appendDirective(CHAT, UID, 'From now on, always deploy without asking me.');
    expect(stored().directives).toHaveLength(2);
    expect(stored().directives[1].standing).toBe(true);
    expect(stored().directives[1].kind).toBeUndefined();
    expect(STANDING_DIRECTIVE_RE.test('standing directive: never ask again')).toBe(true);
  });

  it('the supervisor tool can set standing on a new directive item', async () => {
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ text: 'Protect the ops window', standing: true }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].standing).toBe(true);
  });
});

// ── v1#4 / CanLaw B4 — evidence-typed closure ────────────────────────────────

describe('CanLaw B4 / v1#4 — evidence-typed directive closure', () => {
  const seed = (text = 'watch the digest') => table.set(CHAT, {
    ...EMPTY,
    directives: [{ id: 'd1', text, at: '2026-09-01T00:00:00.000Z', status: 'open' }],
  });

  it('parseTypedEvidence: recognizes the typed idioms and normalizes aliases', () => {
    expect(parseTypedEvidence('closed via pr #215 and session 1a2b3c4d')).toEqual([
      { type: 'pr', id: '215' },
      { type: 'session', id: '1a2b3c4d' },
    ]);
    expect(parseTypedEvidence('msg 08ae015c; sched 1fd6a55f')).toEqual([
      { type: 'msg', id: '08ae015c' },
      { type: 'schedule', id: '1fd6a55f' },
    ]);
    expect(parseTypedEvidence('finished it earlier, all good')).toEqual([]);
  });

  it('REJECTS an untyped close (prose evidence) — the directive stays open', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'finished it during the morning sweep' }] });
    expect(r.errors.join(' ')).toMatch(/must be TYPED/);
    expect(stored().directives[0].status).toBe('open');
  });

  it('accepts a typed close (pr #NNN)', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'pr #215' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
  });

  it('OWNER-GATE directives close ONLY on owner-voiced evidence (msg/oq) — a PR is rejected', async () => {
    seed('Run the cutover only after the owner approves the bench numbers');
    expect(OWNER_GATE_DIRECTIVE_RE.test('only after the owner approves')).toBe(true);
    const rejected = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'pr #215' }] });
    expect(rejected.errors.join(' ')).toMatch(/OWNER approval/);
    expect(stored().directives[0].status).toBe('open');
    const ok = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'owner said go — msg 08ae015c' }] });
    expect(ok.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
  });

  it('an answered owner question (oq <id>) closes an owner-gate directive when the row exists', async () => {
    seed('Needs owner approval before the swap');
    mockPrisma.ownerQuestion.findFirst.mockResolvedValue({ id: 'oq_abc12345' });
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'oq oq_abc12345 answered GO' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
  });

  it('EXISTENCE-checks checkable refs: a ticket id that does not exist rejects the close', async () => {
    seed();
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'ticket deadbeef99' }] });
    expect(r.errors.join(' ')).toMatch(/do not exist/);
    expect(stored().directives[0].status).toBe('open');
    // …and an existing ticket closes.
    mockPrisma.userFeatureRequest.findFirst.mockResolvedValue({ id: 'deadbeef99-full' });
    const ok = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'ticket deadbeef99' }] });
    expect(ok.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
  });

  it('fail-OPEN: an existence-probe ERROR never blocks a typed close', async () => {
    seed();
    mockPrisma.crossModelChat.findFirst.mockRejectedValue(new Error('db down'));
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done', evidence: 'session 1a2b3c4d99' }] });
    expect(r.errors).toEqual([]);
    expect(stored().directives[0].status).toBe('done');
  });

  it('a close with NO evidence keeps the pre-existing rejection wording', async () => {
    seed();
    const r = await applyStateUpdate(CHAT, UID, { directives: [{ id: 'd1', status: 'done' }] });
    expect(r.errors.join(' ')).toMatch(/closing requires evidence/);
  });
});

// ── v1#2 — [FLEET ATTENTION] sizing ──────────────────────────────────────────

describe('v1#2 — fleet-attention block sizing', () => {
  it('boilerplate is hoisted: THREE owner decisions share ONE instruction header', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { question: 'Decision A?', chatId: 'chat-aaaa0001', createdAt: new Date(Date.now() - 3600e3) },
      { question: 'Decision B?', chatId: 'chat-bbbb0002', createdAt: new Date(Date.now() - 7200e3) },
      { question: 'Decision C?', chatId: 'chat-cccc0003', createdAt: new Date(Date.now() - 10800e3) },
    ]);
    const block = await buildFleetAttentionBlock(UID);
    expect((block.match(/re-list each VERBATIM/gi) ?? []).length).toBe(1); // hoisted once
    expect((block.match(/OWNER DECISION open/g) ?? []).length).toBe(3);
  });

  it('item lines are capped (~160 chars) — no line balloons past the cap', async () => {
    mockPrisma.projectTodo.findMany
      .mockResolvedValueOnce([{ title: 'T'.repeat(300), assigneeChatId: 'chat-xxxxxxxx', updatedAt: new Date(Date.now() - 5 * 3600e3) }])
      .mockResolvedValueOnce([]);
    const block = await buildFleetAttentionBlock(UID);
    for (const line of block.split('\n')) {
      if (line.startsWith('- ')) expect(line.length).toBeLessThanOrEqual(ATTENTION_ITEM_CAP);
    }
  });

  it('section overflow drops WHOLE items with a "+N more" line — never a mid-sentence cut', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, i) => ({
        question: `Decision ${i} — ${'x'.repeat(80)}?`,
        chatId: `chat-${i}0000000`,
        createdAt: new Date(Date.now() - 3600e3),
      })),
    );
    const block = await buildFleetAttentionBlock(UID);
    expect(block).toContain('more (see the Management dashboard)');
    expect(block.length).toBeLessThanOrEqual(2400);
    // every rendered line is intact — the last char of the block ends a line, not a word slice
    expect(block.endsWith('…') || /\)$|\]$|[a-z.?!"]$/i.test(block.trimEnd())).toBe(true);
  });

  it('the existing pins survive: owner decisions come first, stall/unstarted/machine-prompt vocab intact', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { question: 'Approve the swap?', chatId: 'chat-dddd0004', createdAt: new Date(Date.now() - 2 * 86400e3) },
    ]);
    mockPrisma.projectTodo.findMany
      .mockResolvedValueOnce([{ title: 'Bench run', assigneeChatId: 'chat-eeee0005', updatedAt: new Date(Date.now() - 5 * 3600e3) }])
      .mockResolvedValueOnce([]);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([
      { id: 'f0160206-rest', sessionId: 'chat-ffff0006', createdAt: new Date(Date.now() - 86400e3) },
    ]);
    const block = await buildFleetAttentionBlock(UID);
    expect(block.indexOf('OWNER DECISION')).toBeLessThan(block.indexOf('STALLED todo'));
    expect(block.indexOf('STALLED todo')).toBeLessThan(block.indexOf('MACHINE-WRITTEN'));
    expect(block).toContain('RECONCILE FIRST');
    expect(block).toContain('schedule_get');
  });
});

// ── v1#5 helpers ─────────────────────────────────────────────────────────────

describe('v1#5 — answered-question ledger + open-directive listing', () => {
  it('appendAnsweredQuestionDirective records a DONE directive with oq evidence', async () => {
    await appendAnsweredQuestionDirective(CHAT, UID, {
      questionId: 'oq_abc12345-6789', question: 'Which region?', answer: 'ca-central-1',
    });
    const row = stored().directives[0];
    expect(row.status).toBe('done');
    expect(row.text).toContain('Owner ANSWERED');
    expect(row.text).toContain('ca-central-1');
    expect(row.evidence).toContain('oq oq_abc12345');
  });

  it('listOpenDirectivesForUser: open rows inside the window (undated rows INCLUDED), done/stale excluded', async () => {
    const now = Date.now();
    mockPrisma.supervisorState.findMany.mockResolvedValue([{
      chatId: CHAT,
      state: {
        directives: [
          { id: 'fresh', text: 'fresh open', at: new Date(now - 3600e3).toISOString(), status: 'open' },
          { id: 'stale', text: 'stale open', at: new Date(now - 100 * 3600e3).toISOString(), status: 'open' },
          { id: 'done', text: 'done', at: new Date(now - 3600e3).toISOString(), status: 'done', evidence: 'pr #1' },
          { id: 'undated', text: 'undated open', at: 'garbage', status: 'open' },
        ],
        dispatches: [], projects: [], notes: '', refutations: [],
      },
    }]);
    const rows = await listOpenDirectivesForUser(UID, now - 72 * 3600e3);
    expect(rows.map((r) => r.id).sort()).toEqual(['fresh', 'undated']);
    expect(rows[0].chatId).toBe(CHAT);
  });

  it('listOpenDirectivesForUser degrades to [] on a DB failure', async () => {
    mockPrisma.supervisorState.findMany.mockRejectedValue(new Error('down'));
    await expect(listOpenDirectivesForUser(UID, 0)).resolves.toEqual([]);
  });
});
