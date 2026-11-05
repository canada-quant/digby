/**
 * LANE BOARD (ticket 2c203dac) — the mishap replay + the lane board contract.
 *
 * The mishap: chat 1ea4621f (a plain Sunday Market lane, no supervisor role)
 * was woken by an agent steer on 2026-10-16 and asserted in its final note
 * that three owner questions "sit open in the ledger (oq_3dab2289,
 * oq_c620c908, oq_dcc88817) — content not read this run". The ledger said
 * ANSWERED on all three (the owner answered Oct 9-12; the lane even processed
 * one answer on Oct 12). The verifier's board-assertion lane correctly struck
 * the note — the rows were answered DAYS before the run, so the a9846924
 * mid-run race tier rightly did not exonerate.
 *
 * Root cause (structural, not detector): the "inject the board, don't let the
 * model recall it" doctrine (owner 2026-09-16) was wired SUPERVISOR-ONLY —
 * buildBoardDigestBlock rides the supervisor state block, which a plain lane
 * never receives. A lane gated on owner questions (forChatId) had NO fresh
 * ledger in its wake, so its status claims could only come from transcript
 * memory. The fix is buildLaneBoardBlock: the lane's OWN linked rows (owner
 * questions filed by it or gating it, todos assigned to it) injected into
 * non-supervisor machine wakes.
 *
 * Pins here:
 *  - the mishap replay: the lane board renders the three oq rows ANSWERED, so
 *    the model reads "NOT open; cite it as answered" at compose time;
 *  - the kill switch restores the pre-fix behavior (empty block);
 *  - fail-open: a read failure returns '' (never blocks a run start);
 *  - the wiring: a NON-supervisor machine-origin run's wake prompt carries the
 *    lane board, a supervisor wake keeps its own [BOARD] (no duplicate), and a
 *    USER-anchored run gets none (the doctrine is a machine-wake contract);
 *  - DETECTOR-RECALL REPLAY: the verifier still convicts the specimen note
 *    (mineBoardAssertions finds all three asserted-open claims against
 *    answered rows) — the fix removes the CAUSE (no fresh ledger), never the
 *    detector's recall.
 */
const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findMany: jest.fn(async () => []) },
  projectGoal: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  agentRun: { findMany: jest.fn(async () => []) },
  chatSchedule: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findFirst: jest.fn(async () => null) },
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRedisGet: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: (...a: any[]) => mockRedisGet(...a), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  buildLaneBoardBlock, LANE_BOARD_BLOCK_CAP, LANE_BOARD_MAX_ROWS, BOARD_BLOCK_PREFIX,
} from './board-digest.service';
import { findPhantomBoardAssertions, mineBoardAssertions, BOARD_ASSERTION_TAG } from './action-verifier';

const NOW = new Date('2026-10-16T12:39:00Z');
const uuid = (seed: string) => `${seed.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`;

// The mishap's three rows (verbatim ids from ticket 2c203dac / the ledger):
// all three ANSWERED — oq_dcc88817 on Oct 9, oq_3dab2289 / oq_c620c908 by Oct
// 12 — days before the 2026-10-16 12:34Z run that asserted them open.
const MISHAP_OQ = [
  { id: 'oq_3dab2289-1111-4000-8000-000000000000', status: 'answered', createdAt: new Date('2026-10-06T18:00:00Z'), resolvedAt: new Date('2026-10-09T02:00:00Z'), answeredBy: 'owner', question: 'Should the Sunday Market digest switch to the fixed 15:00Z window?', chatId: uuid('lane1ea4'), forChatId: uuid('lane1ea4') },
  { id: 'oq_c620c908-2222-4000-8000-000000000000', status: 'answered', createdAt: new Date('2026-10-07T18:00:00Z'), resolvedAt: new Date('2026-10-11T22:00:00Z'), answeredBy: 'owner', question: 'Reconnect Slack today?', chatId: uuid('supc0e22'), forChatId: uuid('lane1ea4') },
  { id: 'oq_dcc88817-3333-4000-8000-000000000000', status: 'answered', createdAt: new Date('2026-10-08T18:00:00Z'), resolvedAt: new Date('2026-10-12T19:00:00Z'), answeredBy: 'owner', question: 'Did the Slack reconnect fix the DM reads?', chatId: uuid('supc0e22'), forChatId: uuid('lane1ea4') },
];

describe('buildLaneBoardBlock — the 2c203dac mishap shape', () => {
  beforeEach(() => {
    mockPrisma.ownerQuestion.findMany.mockReset().mockResolvedValue(MISHAP_OQ);
    mockPrisma.projectTodo.findMany.mockReset().mockResolvedValue([]);
    delete process.env.LANE_BOARD_BLOCK_DISABLED;
  });
  afterEach(() => { delete process.env.LANE_BOARD_BLOCK_DISABLED; });

  it('renders the three mishap oq rows as ANSWERED with the "NOT open; cite it as answered" line — the model reads the answer at compose time', async () => {
    const block = await buildLaneBoardBlock(uuid('lane1ea4'), { now: NOW });
    expect(block.startsWith(BOARD_BLOCK_PREFIX)).toBe(true);
    expect(block).toContain('OWNER QUESTIONS linked to this chat: 0 open · 3 answered/dismissed');
    expect(block).toContain('oq_3dab2289 ANSWERED');
    expect(block).toContain('oq_c620c908 ANSWERED');
    expect(block).toContain('oq_dcc88817 ANSWERED');
    expect(block).toContain('OPEN owner questions: NONE — nothing is waiting on the owner');
    // the doctrine line the supervisor board pins for the same class
    expect(block).toContain('NOT open; cite it as answered');
    // forChatId linkage is what makes these rows THIS lane's business
    expect(block).not.toContain('gates this lane'); // none of the mishap rows are OPEN here
  });

  it('an OPEN question linked via forChatId renders OPEN with the "gates this lane" marker', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { ...MISHAP_OQ[0], status: 'open', resolvedAt: null, answeredBy: null },
    ]);
    const block = await buildLaneBoardBlock(uuid('lane1ea4'), { now: NOW });
    expect(block).toContain('OWNER QUESTIONS linked to this chat: 1 open · 0 answered/dismissed');
    expect(block).toContain('oq_3dab2289 OPEN since');
    expect(block).toContain('(gates this lane)');
    expect(block).not.toContain('OPEN owner questions: NONE');
  });

  it('assigned todos render with status + blocked reason only for blocked rows', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([
      { id: uuid('t1inprog'), title: 'Fix the Sunday Market digest reliability defects', status: 'in_progress', blockedReason: null, updatedAt: new Date('2026-10-16T12:39:29Z') },
      { id: uuid('t2blockd'), title: 'Flash firmware', status: 'blocked', blockedReason: 'Waiting on the vendor firmware drop', updatedAt: new Date('2026-10-16T12:00:00Z') },
      { id: uuid('t3done00'), title: 'Closed earlier today', status: 'done', blockedReason: null, updatedAt: new Date('2026-10-16T09:00:00Z') },
    ]);
    const block = await buildLaneBoardBlock(uuid('lane1ea4'), { now: NOW });
    expect(block).toContain('TODOS assigned to this chat: 2 open (1 in_progress · 1 blocked · 0 pending) · 1 closed in the last 24h');
    expect(block).toContain('todo t1inprog [in_progress] "Fix the Sunday Market digest reliability defects"');
    expect(block).toContain('todo t2blockd [blocked] "Flash firmware" — blocked: Waiting on the vendor firmware drop');
    expect(block).not.toContain('t3done00'); // done rows only count, never list (the supervisor board idiom)
  });

  it('no linked rows at all ⇒ empty block (a lane with nothing on the board pays nothing)', async () => {
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([]);
    expect(await buildLaneBoardBlock(uuid('lane1ea4'), { now: NOW })).toBe('');
  });

  it('kill switch LANE_BOARD_BLOCK_DISABLED=1 restores the pre-fix behavior (empty block)', async () => {
    process.env.LANE_BOARD_BLOCK_DISABLED = '1';
    expect(await buildLaneBoardBlock(uuid('lane1ea4'), { now: NOW })).toBe('');
  });

  it('fail-open: a prisma read failure returns the empty block, never throws', async () => {
    mockPrisma.ownerQuestion.findMany.mockRejectedValue(new Error('db down'));
    await expect(buildLaneBoardBlock(uuid('lane1ea4'), { now: NOW })).resolves.toBe('');
  });

  it('caps at LANE_BOARD_BLOCK_ROWS rendered rows per section with a "+N more" marker, and the block never exceeds LANE_BOARD_BLOCK_CAP', async () => {
    const many = Array.from({ length: LANE_BOARD_MAX_ROWS + 5 }, (_v, i) => ({
      id: `oq_cap000${i}-4444-4000-8000-000000000000`, status: i % 4 === 3 ? 'answered' : 'open',
      createdAt: new Date('2026-10-01T00:00:00Z'), resolvedAt: i % 4 === 3 ? new Date('2026-10-14T00:00:00Z') : null,
      answeredBy: i % 4 === 3 ? 'owner' : null, question: `Question number ${i} about the digest`, chatId: uuid('lane1ea4'), forChatId: uuid('lane1ea4'),
    }));
    mockPrisma.ownerQuestion.findMany.mockResolvedValue(many);
    const block = await buildLaneBoardBlock(uuid('lane1ea4'), { now: NOW });
    expect(block.length).toBeLessThanOrEqual(LANE_BOARD_BLOCK_CAP);
    expect(block).toContain('more open (use list_owner_questions)');
    // the answered side is within LANE_BOARD_MAX_ROWS here (3 of 13) — no
    // answered marker fires from this fixture; the OPEN side's marker proves
    // the overflow path renders.
  });
});

/**
 * DETECTOR-RECALL REPLAY (ticket 2c203dac) — the board-assertion lane's prior
 * TRUE POSITIVES must still fire after the lane-board fix. The fix removes
 * the CAUSE of the mishap (no fresh ledger in a lane's machine wake); it does
 * NOT touch the detector. Replayed here:
 *   - the 2c203dac specimen itself (three asserted-open vs answered rows — a
 *     genuine true positive the mishap ticket was filed on), and
 *   - the oq_bd1130d5 class (owner 2026-09-16: a supervisor asserting a row
 *     "still OPEN" two days after the owner answered it — the founding case of
 *     the board-assertion lane, from action-verifier.board-assertions.
 *     2026-09-16.test.ts's convicting shapes).
 * The race tier (a9846924) stays one-directional: an answer landing AFTER
 * runStart exonerates (the assertion was true when the model could read it),
 * an answer that predates the run never does.
 */
describe('DETECTOR-RECALL REPLAY — the board-assertion lane still convicts asserted-open vs answered rows (2c203dac)', () => {
  const SPECIMEN_NOTE = '[board assertion] Three owner questions also sit open in the ledger (oq_3dab2289, oq_c620c908, oq_dcc88817) — content not read this run.';
  const statusLookup = async (kind: 'oq' | 'todo' | 'goal', id: string): Promise<string | null> => {
    if (kind !== 'oq') return null;
    const row = MISHAP_OQ.find((q) => q.id.startsWith(`oq_${id}`));
    return row ? row.status : null;
  };

  it('mines all three oq assertions from the specimen note', () => {
    const assertions = mineBoardAssertions(SPECIMEN_NOTE);
    expect(assertions.map((a) => a.id).sort()).toEqual(['3dab2289', 'c620c908', 'dcc88817'].sort());
    expect(assertions.every((a) => a.kind === 'oq' && a.asserted === 'open')).toBe(true);
  });

  it('convicts all three against the answered ledger (the true positive that filed the mishap)', async () => {
    const claims = await findPhantomBoardAssertions(SPECIMEN_NOTE, [], {}, statusLookup);
    expect(claims).toHaveLength(3);
    for (const c of claims) {
      expect(c.kind).toBe('oq');
      expect(c.asserted).toBe('open');
      expect(c.ledger).toBe('answered');
      expect(String(c.detail)).toContain(BOARD_ASSERTION_TAG);
    }
  });

  it('the a9846924 race tier still exonerates a mid-run answer and still refuses one that predates the run', async () => {
    // The owner answers oq_3dab2289 30 min AFTER the run started (race):
    // exonerated — the assertion was true when the model could have read it.
    const racedLookup = async (kind: 'oq' | 'todo' | 'goal', id: string): Promise<string | null> => {
      if (kind === 'oq' && id === '3dab2289') return 'answered';
      return statusLookup(kind, id);
    };
    const racedAt = async (_k: 'oq' | 'todo' | 'goal', id: string): Promise<Date | null> =>
      id === '3dab2289' ? new Date('2026-10-16T13:05:00Z') : new Date('2026-10-09T02:00:00Z');
    const runStartedAt = new Date('2026-10-16T12:34:00Z');
    const raced = await findPhantomBoardAssertions(SPECIMEN_NOTE, [], { runStartedAt }, racedLookup, undefined as any, racedAt);
    const racedIds = raced.map((c) => c.id);
    expect(racedIds).not.toContain('3dab2289'); // exonerated by the race tier
    expect(racedIds).toContain('c620c908');
    expect(racedIds).toContain('dcc88817');
    // And the plain (non-raced) shape still convicts all three — the tier is a
    // carve-out for genuine mid-run flips, never a general amnesty.
    const plain = await findPhantomBoardAssertions(SPECIMEN_NOTE, [], { runStartedAt }, statusLookup);
    expect(plain).toHaveLength(3);
  });

  it('the founding class still convicts: a note asserting an oq row "still open" that the ledger answered days ago (oq_bd1130d5, owner 2026-09-16)', async () => {
    // verbatim from action-verifier.board-assertions.2026-09-16.test.ts's
    // convicting incident shape
    const foundingNote = 'Owner ruling oq_bd1130d5 is still open, so the decision stays parked.';
    const foundingStatus = async (kind: 'oq' | 'todo' | 'goal', id: string): Promise<string | null> =>
      kind === 'oq' && id === 'bd1130d5' ? 'answered' : null;
    const claims = await findPhantomBoardAssertions(foundingNote, [], {}, foundingStatus);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ kind: 'oq', id: 'bd1130d5', asserted: 'open', ledger: 'answered' });
    expect(String(claims[0].detail)).toContain('asserted oq_bd1130d5 is "open"; the ledger says "answered"');
  });
});
