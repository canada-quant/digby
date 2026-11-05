/**
 * TICKET dca83b85 — "Fleet supervision opt-out is bypassed by wildcard hooks,
 * sweeps and fleet reporting".
 *
 * The owner's `crossModelProject.supervised === false` opt-out must remove a
 * project from the FLEET's automatic view. Before this suite the emit/delivery
 * gates (hooks.service), the digest writer and the watchdog honored it, but
 * every FLEET COMPOSITION surface read account-wide and ignored it:
 *
 *   - the fleet board roll-up   (board-digest.service, scope='fleet')
 *   - the fleet attention block (supervisor-state.buildFleetAttentionBlock)
 *   - the fleet liveness table  (supervisor-state.buildFleetLivenessBlock)
 *   - the liveness SNAPSHOT that grounds the owner briefing
 *     (supervisor-state.getFleetLivenessSnapshot)
 *   - the needs-you union read  (owner-needs-you.loadNeedsYouUnion, userId leg)
 *
 * This suite replays each of those with an opted-out project present, and pins
 * the three rules the ticket names:
 *
 *   (2) supervised=false excludes the project BEFORE composition/steering/
 *       briefing — its rows never reach the Fleet's block or numbers;
 *   (3) `projectSupervisorEnabled` stays INDEPENDENT: an opted-out project that
 *       still runs its own supervisor is excluded from the FLEET's roll-up
 *       (and the reverse — an unsupervised project is NOT dropped merely
 *       because projectSupervisorEnabled is false);
 *   (5) the framework project can never be opted out (backend refusal), and it
 *       stays in scope even if a legacy row says otherwise.
 *
 * Everything is asserted on the REAL modules with a mocked prisma, following
 * the supervisor-state.liveness.test.ts idiom.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// config/redis is pulled LAZILY through board-digest → adoption-ladder, and the
// real module runs config/env's parseEnv (process.exit without a full env).
const mockRedisGet: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockRedisGet(...a), incr: jest.fn(async () => 1), del: jest.fn(async () => 1) },
}));

const mockProjectFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockChatFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockChatFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockSchedGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockSchedFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockRunGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockRunFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockGoalGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockGoalFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockGoalCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockTodoGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTodoFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTodoCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockWatchedGroupBy = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockOqFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockOqCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelProject: { findMany: (...a: any[]) => mockProjectFindMany(...a) },
    crossModelChat: {
      findMany: (...a: any[]) => mockChatFindMany(...a),
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findFirst: (...a: any[]) => mockChatFindFirst(...a),
    },
    chatSchedule: { groupBy: (...a: any[]) => mockSchedGroupBy(...a), findMany: (...a: any[]) => mockSchedFindMany(...a) },
    agentRun: { groupBy: (...a: any[]) => mockRunGroupBy(...a), findMany: (...a: any[]) => mockRunFindMany(...a) },
    projectGoal: {
      groupBy: (...a: any[]) => mockGoalGroupBy(...a),
      findMany: (...a: any[]) => mockGoalFindMany(...a),
      count: (...a: any[]) => mockGoalCount(...a),
    },
    projectTodo: {
      groupBy: (...a: any[]) => mockTodoGroupBy(...a),
      findMany: (...a: any[]) => mockTodoFindMany(...a),
      count: (...a: any[]) => mockTodoCount(...a),
    },
    watchedResource: { groupBy: (...a: any[]) => mockWatchedGroupBy(...a) },
    ownerQuestion: { findMany: (...a: any[]) => mockOqFindMany(...a), count: (...a: any[]) => mockOqCount(...a) },
    supervisorState: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
  },
}));

import {
  buildFleetAttentionBlock, buildFleetLivenessBlock, getFleetLivenessSnapshot,
} from './supervisor-state.service';
import { buildBoardDigestBlock } from './board-digest.service';
import { loadNeedsYouUnion } from './owner-needs-you';
import {
  isUnsupervisedProject, unsupervisedProjectIds, chatIdsInUnsupervisedProjects,
} from './supervision-scope';
import { frameworkGuardMessage, frameworkProjectRefusal } from './framework-project';

const UID = 'u-owner-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-04T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

/** The one opted-out project used by every case, plus a plainly supervised one. */
const OPTED_OUT = { id: 'p-opted', supervised: false };
const IN_SCOPE = { id: 'p-inscope', supervised: true };

beforeEach(() => {
  jest.clearAllMocks();
  mockProjectFindMany.mockResolvedValue([]);
  mockChatFindMany.mockResolvedValue([]);
  mockSchedGroupBy.mockResolvedValue([]);
  mockSchedFindMany.mockResolvedValue([]);
  mockRunGroupBy.mockResolvedValue([]);
  mockRunFindMany.mockResolvedValue([]);
  mockGoalGroupBy.mockResolvedValue([]);
  mockGoalFindMany.mockResolvedValue([]);
  mockGoalCount.mockResolvedValue(0);
  mockTodoGroupBy.mockResolvedValue([]);
  mockTodoFindMany.mockResolvedValue([]);
  mockTodoCount.mockResolvedValue(0);
  mockWatchedGroupBy.mockResolvedValue([]);
  mockOqFindMany.mockResolvedValue([]);
  mockOqCount.mockResolvedValue(0);
});

describe('supervision-scope leaf (the one answer to "is this in the Fleet\'s scope?")', () => {
  it('only an EXPLICIT false opts a project out — absent/null/true all read as supervised', () => {
    expect(isUnsupervisedProject({ supervised: false })).toBe(true);
    expect(isUnsupervisedProject({ supervised: true })).toBe(false);
    expect(isUnsupervisedProject({ supervised: null })).toBe(false);
    expect(isUnsupervisedProject({})).toBe(false);
    // FAIL-OPEN: a deleted/partial row must never silently drop work.
    expect(isUnsupervisedProject(null)).toBe(false);
    expect(isUnsupervisedProject(undefined)).toBe(false);
  });

  it('collects the opted-out ids from a fetched row set', () => {
    const ids = unsupervisedProjectIds([OPTED_OUT, IN_SCOPE, { id: 'p-legacy' }] as any);
    expect([...ids]).toEqual(['p-opted']);
    expect(unsupervisedProjectIds(null).size).toBe(0);
  });

  it('resolves opted-out CHAT ids (owner questions and schedules key on a chat)', () => {
    const ids = chatIdsInUnsupervisedProjects(
      [{ id: 'c1', projectId: 'p-opted' }, { id: 'c2', projectId: 'p-inscope' }, { id: 'c3', projectId: null }] as any,
      new Set(['p-opted']),
    );
    expect([...ids]).toEqual(['c1']);
  });
});

describe('buildBoardDigestBlock (fleet scope) — the roll-up excludes opted-out projects', () => {
  it('queries ONLY supervised projects, so an opted-out project never reaches SUPERVISED PROJECTS', async () => {
    mockProjectFindMany.mockResolvedValue([{ id: 'p-inscope', name: 'CanLaw' }]);
    await buildBoardDigestBlock({ scope: 'fleet', userId: UID, now: NOW });

    // The exclusion is in the WHERE, not a post-filter: the opted-out row is
    // never even fetched.
    const where = mockProjectFindMany.mock.calls[0][0].where;
    expect(where.supervised).toEqual({ not: false });
    expect(where.userId).toBe(UID);
    expect(where.archivedAt).toBe(null);
  });

  it('an opted-out project that KEEPS its own project supervisor is still excluded from the fleet roll-up (requirement 3)', async () => {
    // projectSupervisorEnabled is independent: it must not re-enrol the project
    // in FLEET supervision. Today the query ANDs both flags, so such a row can
    // never be returned.
    mockProjectFindMany.mockResolvedValue([]);
    const block = await buildBoardDigestBlock({ scope: 'fleet', userId: UID, now: NOW });
    expect(block).toBe(''); // nothing supervised → no fleet board at all
    const where = mockProjectFindMany.mock.calls[0][0].where;
    expect(where.projectSupervisorEnabled).toBe(true);
    expect(where.supervised).toEqual({ not: false });
  });

  it('BEHAVIOUR: an owner question raised inside an opted-out project never renders on the fleet board (adversarial review B1)', async () => {
    // The scope read MUST carry `supervised` in its projection — without it the
    // opt-out set is silently empty and this filter is a no-op. Asserted on the
    // RENDERED BLOCK, not on the query shape, so a {id}-only select fails here.
    mockProjectFindMany.mockImplementation(async (args: any) => {
      if (args?.where?.supervised === false) return [{ id: 'p-opted', supervised: false }];
      return [{ id: 'p-inscope', name: 'CanLaw' }];
    });
    mockChatFindMany.mockImplementation(async (args: any) => {
      const inOptedOut = args?.where?.projectId?.in;
      if (Array.isArray(inOptedOut) && inOptedOut.includes('p-opted')) return [{ id: 'c-opted' }];
      return [];
    });
    mockOqFindMany.mockResolvedValue([
      { id: 'oq_opted01-1111-4000-8000-000000000000', status: 'open', createdAt: hoursAgo(2), resolvedAt: null, answeredBy: null, question: 'OPTED OUT PROJECT SECRET?', chatId: 'c-opted', forChatId: null },
      { id: 'oq_inscope1-2222-4000-8000-000000000000', status: 'open', createdAt: hoursAgo(3), resolvedAt: null, answeredBy: null, question: 'Supervised project question?', chatId: 'c-inscope', forChatId: null },
    ]);

    const block = await buildBoardDigestBlock({ scope: 'fleet', userId: UID, now: NOW });
    expect(block).not.toContain('OPTED OUT PROJECT SECRET');
    expect(block).toContain('Supervised project question');
  });
});

describe('buildFleetAttentionBlock — no evaluation/listing of opted-out work', () => {
  it('subtracts the opted-out project from BOTH todo pulls and its chats from schedules + owner questions', async () => {
    mockProjectFindMany.mockResolvedValue([OPTED_OUT]);
    mockChatFindMany.mockResolvedValue([{ id: 'c-opted' }]); // chats of the opted-out project

    await buildFleetAttentionBlock(UID, NOW);

    const stalledWhere = mockTodoFindMany.mock.calls[0][0].where;
    expect(stalledWhere.projectId).toEqual({ notIn: ['p-opted'] });
    const unstartedWhere = mockTodoFindMany.mock.calls[1][0].where;
    expect(unstartedWhere.projectId).toEqual({ notIn: ['p-opted'] });

    const schedWhere = mockSchedFindMany.mock.calls[0][0].where;
    expect(schedWhere.sessionId).toEqual({ notIn: ['c-opted'] });

    const oqWhere = mockOqFindMany.mock.calls[0][0].where;
    expect(oqWhere.chatId).toEqual({ notIn: ['c-opted'] });
  });

  it('with no opt-outs the reads stay account-wide (no empty notIn filter breaks an existing install)', async () => {
    mockProjectFindMany.mockResolvedValue([]);
    await buildFleetAttentionBlock(UID, NOW);
    expect(mockTodoFindMany.mock.calls[0][0].where.projectId).toBeUndefined();
    expect(mockOqFindMany.mock.calls[0][0].where.chatId).toBeUndefined();
    // No project scan at all is fine too — the point is the ABSENT filter.
    expect(mockChatFindMany).not.toHaveBeenCalled();
  });

  it('a prisma failure on the scope read fails OPEN (supervised by default, block still composes)', async () => {
    mockProjectFindMany.mockRejectedValue(new Error('boom'));
    const block = await buildFleetAttentionBlock(UID, NOW);
    expect(typeof block).toBe('string');
    // Fail-open: the account-wide reads ran WITHOUT an exclusion filter.
    expect(mockTodoFindMany.mock.calls[0][0].where.projectId).toBeUndefined();
  });
});

describe('buildFleetLivenessBlock — opted-out lanes never table', () => {
  it('scopes the chat scan and re-checks in memory (a mock/SQL mismatch cannot leak a row)', async () => {
    // One implementation for BOTH project reads: the scope read (supervised:false)
    // and the later name lookup.
    mockProjectFindMany.mockImplementation(async (args: any) => (
      args?.where?.supervised === false
        ? [OPTED_OUT]
        : [{ id: 'p-inscope', name: 'CanLaw' }]
    ));
    mockChatFindMany.mockResolvedValue([
      { id: 'c-inscope', projectId: 'p-inscope' },
      { id: 'c-opted', projectId: 'p-opted' }, // returned anyway — the belt must drop it
    ]);
    mockSchedGroupBy.mockResolvedValue([
      { sessionId: 'c-inscope', _count: { _all: 1 }, _max: { lastFiredAt: hoursAgo(2) } },
      { sessionId: 'c-opted', _count: { _all: 3 }, _max: { lastFiredAt: hoursAgo(1) } },
    ]);

    const block = await buildFleetLivenessBlock(UID, NOW);
    expect(block).toContain('CanLaw');
    expect(block).toContain('1 enabled schedule(s)');
    // The opted-out lane's heartbeat (3 schedules) is NOT in the table.
    expect(block).not.toContain('3 enabled schedule(s)');
  });
});

describe('getFleetLivenessSnapshot — the owner BRIEFING numbers are fleet-scoped', () => {
  it("excludes an opted-out project's schedules and live runs from the counts (requirement 2: briefings)", async () => {
    mockProjectFindMany.mockResolvedValue([OPTED_OUT]);
    mockChatFindMany.mockResolvedValue([
      { id: 'c-inscope', projectId: 'p-inscope' },
      { id: 'c-opted', projectId: 'p-opted' },
    ]);
    mockSchedGroupBy.mockResolvedValue([
      { sessionId: 'c-inscope', _count: { _all: 2 }, _max: { lastFiredAt: hoursAgo(1) } },
      { sessionId: 'c-opted', _count: { _all: 9 }, _max: { lastFiredAt: hoursAgo(1) } },
    ]);
    mockRunGroupBy.mockResolvedValue([
      { sessionId: 'c-inscope', _count: { _all: 1 } },
      { sessionId: 'c-opted', _count: { _all: 7 } },
    ]);

    const snap = await getFleetLivenessSnapshot(UID);
    expect(snap).not.toBeNull();
    // 2 (in scope) — NOT 11, and 1 live run — NOT 8.
    expect(snap!.enabledSchedules).toBe(2);
    expect(snap!.liveRuns).toBe(1);
  });
});

describe('loadNeedsYouUnion — the account-wide union is fleet-scoped, the project read is not', () => {
  it('subtracts opted-out projects from the userId legs', async () => {
    mockChatFindMany.mockResolvedValueOnce([{ id: 'c-keep' }, { id: 'c-opted' }]); // owned chats
    mockChatFindMany.mockResolvedValueOnce([{ id: 'c-opted' }]); // chats of opted-out projects
    const view = await loadNeedsYouUnion({ userId: UID, excludeProjectIds: ['p-opted'] });
    expect(view).not.toBeNull();
    expect(mockOqCount.mock.calls[0][0].where.chatId).toEqual({ in: ['c-keep'] });
    const todoWhere = mockTodoCount.mock.calls[0]?.[0]?.where ?? mockTodoFindMany.mock.calls[0]?.[0]?.where ?? {};
    if (todoWhere && Object.keys(todoWhere).length) expect(todoWhere.projectId).toEqual({ notIn: ['p-opted'] });
  });

  it('a PROJECT-scoped call is never narrowed by the exclusion (the project supervisor sees its own cards)', async () => {
    await loadNeedsYouUnion({ projectId: 'p-opted', excludeProjectIds: ['p-opted'] });
    const chatWhere = mockChatFindMany.mock.calls[0][0].where;
    expect(chatWhere.projectId).toBe('p-opted');
  });
});

describe('framework project is PERMANENTLY fleet-supervised (requirement 1)', () => {
  it('renders a dedicated refusal naming the permanent supervision', () => {
    const msg = frameworkGuardMessage('unsupervise');
    expect(msg).toContain('always stays inside Fleet supervision');
    expect(msg).toContain('[refused: framework surface]');
    // The plain refusal (no suffix) carries the same sentence.
    expect(frameworkProjectRefusal('unsupervise')).toContain('cannot be taken out of it');
  });

  it('a legacy row flipped to supervised:false still counts as IN scope when it is the framework repo', async () => {
    // Simulates a row that predates the write guard (or a direct DB edit):
    // identity wins over the stale flag, so the platform surface never drops
    // out of the Fleet's view.
    const prev = process.env.SELF_REPO;
    process.env.SELF_REPO = 'example-org/crossmodel';
    try {
      mockProjectFindMany.mockImplementation(async (args: any) => {
        // The scope read: an opted-out FRAMEWORK row.
        if (args?.where?.supervised === false) {
          return [{ id: 'p-framework', supervised: false, repoUrl: 'https://github.com/example-org/crossmodel' }];
        }
        return [{ id: 'p-inscope', name: 'CanLaw' }];
      });
      mockChatFindMany.mockResolvedValue([]);
      await buildFleetAttentionBlock(UID, NOW);
      // No opt-outs survive the framework re-assertion → account-wide reads.
      expect(mockTodoFindMany.mock.calls[0][0].where.projectId).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.SELF_REPO; else process.env.SELF_REPO = prev;
    }
  });
});