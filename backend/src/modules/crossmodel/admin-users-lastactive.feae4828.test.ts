/**
 * GET /api/crossmodel/admin/users — the "Last Active" column's human-shaped
 * computation (ticket feae4828: "admin panel users last active looks
 * suspiciously incorrect").
 *
 * The OLD shape was MAX(crossmodel_chats.updatedAt) over ALL of a user's
 * chats — machine traffic included. Scheduled / hook / agent runs bump that
 * column constantly (supervisor lanes idle-heartbeat it; ack-only drains
 * write `updatedAt: new Date()`), so a user whose supervisor chat woke 10
 * minutes ago renders "last active 10m ago" even when their last human
 * message was weeks old. Prod probe 2026-10-26 (read-only, box A): 15/21
 * users showed active <24h while the human truth was 4/21; worst
 * overstatement ~30 days, driven entirely by a supervisor chat with 0
 * messages in 7 days.
 *
 * The NEW shape mirrors the Traffic tab's trafficUsers last_active
 * (visitor-analytics.service.ts):
 *   GREATEST(
 *     MAX(createdAt of human-authored messages: role='user' AND
 *         COALESCE(metadata->>'origin','user')='user'),
 *     MAX(updatedAt of human-shaped chats: isSupervisor=false AND
 *         isProjectSupervisor=false AND parentChatId IS NULL),
 *     user.createdAt)                       -- floor: join date
 *
 * Machine-origin rows ('agent'/'schedule'/'hook'/'webhook'/'machine' — the
 * MACHINE_ROW_ORIGINS family) and machine lanes (supervisor, project
 * supervisor, spawned sub-sessions) never advance the stamp.
 *
 * Boundaries mocked per .digby/notes/learnings.md: importing the real
 * controller graph pulls config/database + config/redis → config/env, which
 * exits the jest worker at import. Prisma's queryRaw seams answer by SQL
 * shape; findMany/groupBy stand-ins record calls.
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The handler's prisma seams. Default export carries findMany + $queryRaw
// (tagged-template raw calls land as $queryRaw(...[sql, ...params])).
const mockFindMany: jest.Mock = jest.fn();
const mockQueryRaw: jest.Mock = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    findMany: (...a: any[]) => mockFindMany(...a),
    user: { findMany: (...a: any[]) => mockFindMany(...a) },
    $queryRaw: (...a: any[]) => mockQueryRaw(...a),
    crossModelChat: { groupBy: jest.fn() },
  },
}));

jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));

// Load-bearing controller imports get load-time stand-ins (see header).
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: {} }));
jest.mock('./platform/platform.service', () => ({ __esModule: true, default: {} }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['bug_report', 'feature_request', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: () => Promise.resolve() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: () => null, generateKidStatus: () => 'ok' }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./view/view-mode', () => ({
  resolveViewModeForRequest: () => 'full',
  isAdminViewer: (u: any) => !!u?.admin,
}));

import crossmodelController from './crossmodel.controller';

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse('2026-10-26T15:46:12.000Z');
const H = 3_600_000;
const D = 86_400_000;

type Res = { status: (n: number) => Res; json: (b: any) => Res; statusCode?: number; body?: any };
const res = (): Res => {
  const r: Res = {
    status: (n: number) => { r.statusCode = n; return r; },
    json: (b: any) => { r.body = b; return r; },
  };
  return r;
};

/** Route a $queryRaw tagged-template call by its SQL text. */
function answerQueryRaw(args: any[]) {
  const sql = String(args[0]);
  if (sql.includes(`WHERE m.role = 'assistant'`)) {
    // messageCount + (legacy, unused now) assistant max
    return [
      { userId: 'u1', messageCount: BigInt(12), lastActiveAt: new Date(T0 - 30 * D) },
      { userId: 'u2', messageCount: BigInt(4), lastActiveAt: new Date(T0 - 2 * H) },
    ];
  }
  if (sql.includes(`COALESCE(m."metadata"->>'origin', 'user') = 'user'`)) {
    // last HUMAN-authored message leg
    return [
      { userId: 'u1', lastActiveAt: new Date(T0 - 50 * D) },
      { userId: 'u2', lastActiveAt: new Date(T0 - 26 * H) },
    ];
  }
  if (sql.includes(`MAX(c."updatedAt")`)) {
    // human-shaped chat updatedAt leg
    return [
      { userId: 'u1', lastActiveAt: new Date(T0 - 40 * D) },
      { userId: 'u2', lastActiveAt: new Date(T0 - 3 * H) },
    ];
  }
  return [];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getAdminUsers — human-shaped lastActive (ticket feae4828)', () => {
  it('403s for non-admin viewers', async () => {
    mockFindMany.mockResolvedValue([]);
    const r = res();
    await crossmodelController.getAdminUsers({ user: { admin: false } } as any, r as any);
    expect(r.statusCode).toBe(403);
  });

  it('excludes machine traffic: a stale human beats a fresh supervisor heartbeat', async () => {
    // u1: supervisor chat woke 10 MINUTES ago (machine), last human message
    // 50 days ago, human-shaped chat row 40 days ago, joined 60 days ago.
    // OLD shape answered MAX over all chats → "10m ago" (the bug).
    // NEW shape must answer the human legs: max(50d msg, 40d chat, 60d join) = join date.
    mockFindMany.mockResolvedValue([
      {
        id: 'u1', email: 'a@x.test', name: 'A', role: 'USER', isActive: true,
        createdAt: new Date(T0 - 60 * D), updatedAt: new Date(T0 - 60 * D),
        _count: { crossModelChats: 3, featureRequests: 1 },
      },
    ]);
    mockQueryRaw.mockImplementation((...a: any[]) => Promise.resolve(answerQueryRaw(a)));

    const r = res();
    await crossmodelController.getAdminUsers({ user: { admin: true } } as any, r as any);

    expect(r.statusCode).toBeUndefined();
    expect(r.body.success).toBe(true);
    const u1 = r.body.data[0];
    // Legs: human message 50d ago, human-shaped chat row 40d ago, join 60d ago
    // → GREATEST = 40d ago (the human chat touch — a rename/archive — is still
    // human activity). A machine wake 10 minutes ago NEVER appears.
    expect(u1.lastActive).toBe(iso(T0 - 40 * D));
    expect(u1.messageCount).toBe(12);
    expect(u1.chatCount).toBe(3);
    expect(u1.ticketCount).toBe(1);

    // The supervisor-shaped chats must NOT be read at all: no groupBy over all
    // chats (the old machine-noise source), and the human-chat leg filters
    // supervisor / project-supervisor / sub-session rows in SQL.
    const humanChatSql = mockQueryRaw.mock.calls
      .map((c: any[]) => String(c[0]))
      .find((s: string) => s.includes(`MAX(c."updatedAt")`));
    expect(humanChatSql).toBeDefined();
    expect(humanChatSql).toContain(`c."isSupervisor" = false`);
    expect(humanChatSql).toContain(`c."isProjectSupervisor" = false`);
    expect(humanChatSql).toContain(`c."parentChatId" IS NULL`);
    // The human-message leg filters machine-origin rows.
    const humanMsgSql = mockQueryRaw.mock.calls
      .map((c: any[]) => String(c[0]))
      .find((s: string) => s.includes(`COALESCE(m."metadata"->>'origin', 'user') = 'user'`));
    expect(humanMsgSql).toBeDefined();
    expect(humanMsgSql).toContain(`m.role = 'user'`);
  });

  it('takes the greatest HUMAN leg — a fresh human message beats the chat leg and the join floor', async () => {
    // u2: human message 1h ago, human chat row 3h ago (a rename/archive —
    // human-shaped chat activity), joined 90d ago. Answer: 1h ago — the
    // human-message leg WINS. This pins that the human-message leg is live
    // (reviewer F4: a regression dropping that query, or returning [] from
    // it, must fail here, not silently fall back to the chat leg).
    mockFindMany.mockResolvedValue([
      {
        id: 'u2', email: 'b@x.test', name: 'B', role: 'USER', isActive: true,
        createdAt: new Date(T0 - 90 * D), updatedAt: new Date(T0 - 90 * D),
        _count: { crossModelChats: 2, featureRequests: 0 },
      },
    ]);
    mockQueryRaw.mockImplementation((...a: any[]) => {
      const sql = String(a[0]);
      if (sql.includes(`COALESCE(m."metadata"->>'origin', 'user') = 'user'`)) {
        return Promise.resolve([{ userId: 'u2', lastActiveAt: new Date(T0 - 1 * H) }]);
      }
      if (sql.includes(`MAX(c."updatedAt")`)) {
        return Promise.resolve([{ userId: 'u2', lastActiveAt: new Date(T0 - 3 * H) }]);
      }
      if (sql.includes(`WHERE m.role = 'assistant'`)) {
        return Promise.resolve([{ userId: 'u2', messageCount: BigInt(4) }]);
      }
      return Promise.resolve([]);
    });

    const r = res();
    await crossmodelController.getAdminUsers({ user: { admin: true } } as any, r as any);
    const u2 = r.body.data[0];
    expect(u2.lastActive).toBe(iso(T0 - 1 * H));
  });

  it('a user with no activity at all falls back to their join date, never null-before-join', async () => {
    mockFindMany.mockResolvedValue([
      {
        id: 'u3', email: 'c@x.test', name: 'C', role: 'USER', isActive: true,
        createdAt: new Date(T0 - 5 * D), updatedAt: new Date(T0 - 5 * D),
        _count: { crossModelChats: 0, featureRequests: 0 },
      },
    ]);
    mockQueryRaw.mockImplementation((...a: any[]) => Promise.resolve(answerQueryRaw(a)));

    const r = res();
    await crossmodelController.getAdminUsers({ user: { admin: true } } as any, r as any);
    const u3 = r.body.data[0];
    expect(u3.lastActive).toBe(iso(T0 - 5 * D));
    expect(u3.messageCount).toBe(0);
  });

  it('never reads the machine-noise source: no groupBy over ALL chats', async () => {
    mockFindMany.mockResolvedValue([]);
    mockQueryRaw.mockImplementation((...a: any[]) => Promise.resolve([]));
    const r = res();
    await crossmodelController.getAdminUsers({ user: { admin: true } } as any, r as any);
    expect(r.body.success).toBe(true);
    // Every $queryRaw issued must be one of the three whitelisted shapes:
    // the assistant messageCount, the human-chat updatedAt leg, and the
    // human-message leg. The OLD machine-noise source — MAX(updatedAt) over
    // ALL chats incl. supervisor lanes — must never be issued: its shape
    // would be a chat-only aggregate WITHOUT the isSupervisor filter.
    for (const call of mockQueryRaw.mock.calls) {
      const sql = String(call[0]);
      if (sql.includes(`MAX(c."updatedAt")`)) {
        expect(sql).toContain(`c."isSupervisor" = false`);
        expect(sql).toContain(`c."isProjectSupervisor" = false`);
        expect(sql).toContain(`c."parentChatId" IS NULL`);
      }
      expect(sql.includes('GROUP BY')).toBe(true); // every raw statement is an aggregate
    }
  });
});
