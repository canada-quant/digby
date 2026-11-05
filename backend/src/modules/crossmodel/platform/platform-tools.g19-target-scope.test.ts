/**
 * G19 (repo-integrity remediation, 2026-09-09) — the BOUNDED auto-mode bypass,
 * end-to-end through executePlatformTool with the REAL autonomy.service
 * (prisma mocked).
 *
 * Real risk: `gateConsequentialPlatformTool` executed EVERY consequential
 * platform tool live for auto-mode coding runs (db747817 waiver). A coding
 * session ingests untrusted repo/ticket/scraped-web text — injected content
 * could arm schedules on ANY owned chat, steer the fleet supervisor, or push
 * to a paired instance on the strength of the mode alone.
 *
 * Owner ruling: auto-mode = full autonomy FOR THE LANE'S OWN WORK. So the
 * implicit MODE authority — the ctx waiver AND its materialized
 * 'agent_mode_auto' ChatAutonomy row — is bounded for chat-TARGETED tools to
 * the lane's own chat or a first-degree child; everything else stages a
 * confirmation. EXPLICIT (source 'manual') grants keep their full reach — the
 * supervisor's legitimate cross-chat steering is untouched.
 *
 * Matrix (tool = send_chat_message): own chat / first-degree child / unrelated
 * owned chat / supervisor target × machine run vs user-present run.
 *
 * Scaffolding mirrors platform-tools.autonomy.test.ts (tools.ts transitive
 * mocks) + autonomy.implicit.test.ts (real autonomy.service over mocked prisma).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tools.ts transitively imports plan.service → context-store → DB/env (process.exit).
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));

// The service layer under the tools — mocked; the gate + real autonomy.service
// are what we pin.
const svc = {
  listChats: jest.fn(),
  createChat: jest.fn(),
  getChatStatus: jest.fn(),
  getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(),
  renameChat: jest.fn(),
  archiveChat: jest.fn(),
  moveChat: jest.fn(),
  deleteChat: jest.fn(),
  createProject: jest.fn(),
  getProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  moveFolder: jest.fn(),
  startCodingSession: jest.fn(),
  scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(),
  cancelSchedule: jest.fn(),
};
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// error-handler imports config/env (process.exit without env vars) — real
// autonomy.service imports it, so mock the boundary (autonomy.implicit pattern).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
// crossmodel.service pulls the model-integration/env chains — mock the boundary.
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) },
}));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// REAL autonomy.service over this prisma mock (+ the pending-confirmation
// registry the gate's staging path uses).
const mockConfirmations = createPendingConfirmationTable();
const mockChatFindUnique: jest.Mock = jest.fn();
// findMany = the unique ≥8-char own-scoped chat prefix lookup (owner pending-card incident 2026-09-14).
const mockChatFindMany: jest.Mock = jest.fn(async () => []);
const mockScheduleFindFirst: jest.Mock = jest.fn();
// Gate flip 2026-09-11: the G19 schedule-target resolver accepts a UNIQUE
// ≥8-char owner-scoped prefix (startsWith findMany) after the exact miss.
const mockScheduleFindMany: jest.Mock = jest.fn(async () => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    chatAutonomy: { findUnique: jest.fn(async () => mockAutonomyRow), upsert: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
    activity: { create: jest.fn(async () => ({})) },
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
    },
    chatSchedule: {
      findFirst: (...a: any[]) => mockScheduleFindFirst(...a),
      findMany: (...a: any[]) => mockScheduleFindMany(...a),
    },
  },
}));

// Mutable stored-grant row the chatAutonomy.findUnique mock serves.
let mockAutonomyRow: { allowedTools: string[]; scheduleCap: number; source: string } | null = null;

import { executePlatformTool, TARGET_SCOPED_CONSEQUENTIAL_TOOLS } from './platform-tools';
import { AUTO_MODE_TARGET_SCOPED_TOOLS, autoModeTargetAllows } from './autonomy.service';
import { ToolContext } from '../coding/tools';

const LANE = 'lane-1';
const USER = 'u1';
/** The lane's world: own chat, a first-degree child, an unrelated owned chat,
 *  and the fleet supervisor chat (also unrelated — parent of nothing here). */
const CHATS: Record<string, { parentChatId: string | null; userId: string }> = {
  'child-1': { parentChatId: LANE, userId: USER },
  'other-1': { parentChatId: null, userId: USER },
  'sup-1': { parentChatId: null, userId: USER },
  [LANE]: { parentChatId: null, userId: USER },
};

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: LANE, userId: USER, permissionMode: 'auto',
    agentSurface: 'coding',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

const J = (s: string) => JSON.parse(s);
const staged = (out: string) => {
  try { return J(out).needsConfirmation === true; } catch { return false; }
};

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  mockAutonomyRow = null;
  mockChatFindUnique.mockImplementation(async ({ where }: any) => CHATS[where.id] ?? null);
  // The DB-shaped prefix lookup over the same world: owner-scoped startsWith, capped by take.
  mockChatFindMany.mockImplementation(async ({ where, take }: any) =>
    Object.entries(CHATS)
      .filter(([id, row]) => row.userId === where.userId && id.startsWith(where.id.startsWith))
      .map(([id, row]) => ({ id, ...row }))
      .slice(0, take ?? 50));
  mockScheduleFindFirst.mockResolvedValue(null);
  mockScheduleFindMany.mockResolvedValue([]);
  svc.sendChatMessage.mockResolvedValue({ queued: true, chatId: 'x', mode: 'single_thinking' });
  svc.scheduleChatRun.mockResolvedValue({
    id: 'sch-1', sessionId: LANE, kind: 'recurring', intervalSec: 3600,
    nextRunAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  svc.cancelSchedule.mockResolvedValue(true);
});

describe('G19: scoped-tool sets stay in sync (platform-tools mirror of autonomy.service)', () => {
  it('mirrors AUTO_MODE_TARGET_SCOPED_TOOLS exactly', () => {
    expect([...TARGET_SCOPED_CONSEQUENTIAL_TOOLS].sort()).toEqual([...AUTO_MODE_TARGET_SCOPED_TOOLS].sort());
  });
});

describe('G19 matrix: auto-mode coding lane × send_chat_message target × run type', () => {
  // machine run = no userTurnAt (schedule firing / hook wake — where injected
  // content is most dangerous); user-present = userTurnAt set (injection can
  // still arrive mid-run via scraped text, so the bound holds there too).
  const RUN_TYPES: Array<[string, Partial<ToolContext>]> = [
    ['machine run', {}],
    ['user-present run', { userTurnAt: new Date() }],
  ];

  for (const [label, ctxOverrides] of RUN_TYPES) {
    it(`${label}: OWN chat target EXECUTES (full autonomy for the lane's own work)`, async () => {
      const out = await executePlatformTool(makeCtx(ctxOverrides), 'send_chat_message', { chatId: LANE, content: 'note to self' });
      expect(staged(out)).toBe(false);
      expect(svc.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: LANE }));
    });

    it(`${label}: FIRST-DEGREE CHILD target EXECUTES (steering its own children is the lane's work)`, async () => {
      const out = await executePlatformTool(makeCtx(ctxOverrides), 'send_chat_message', { chatId: 'child-1', content: 'reprioritize your task' });
      expect(staged(out)).toBe(false);
      expect(svc.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'child-1' }));
    });

    it(`${label}: SAME-OWNER fleet sibling EXECUTES (owner directive 2026-09-10 — sibling messaging IS the fleet bus; content stays governed by the outbound-claim audit)`, async () => {
      const out = await executePlatformTool(makeCtx(ctxOverrides), 'send_chat_message', { chatId: 'other-1', content: 'FYI from the dispatch lane' });
      expect(staged(out)).toBe(false);
      expect(svc.sendChatMessage).toHaveBeenCalled();
    });

    it(`${label}: DIFFERENT-OWNER target still STAGES (fleet scope never crosses users)`, async () => {
      mockChatFindUnique.mockImplementation(async ({ where }: any) =>
        where.id === 'other-1' ? { parentChatId: null, userId: 'someone-else' } : (CHATS[where.id] ?? null));
      const out = await executePlatformTool(makeCtx(ctxOverrides), 'send_chat_message', { chatId: 'other-1', content: 'cross-user write' });
      expect(staged(out)).toBe(true);
      expect(svc.sendChatMessage).not.toHaveBeenCalled();
    });
  }
});

describe('G19: the other target-scoped tools under the auto-mode waiver', () => {
  it('schedule_message with NO chatId is stamped to the lane\'s OWN chat and executes', async () => {
    const out = await executePlatformTool(makeCtx(), 'schedule_message', { prompt: 'nightly check', intervalMinutes: 60 });
    expect(staged(out)).toBe(false);
    expect(svc.scheduleChatRun).toHaveBeenCalledWith(expect.objectContaining({ chatId: LANE }));
  });

  it('schedule_message targeting a SAME-OWNER sibling now executes (fleet scope, owner 2026-09-10); a different owner still stages', async () => {
    const out = await executePlatformTool(makeCtx(), 'schedule_message', { chatId: 'other-1', prompt: 'hourly bench sweep', intervalMinutes: 60 });
    expect(staged(out)).toBe(false);
    expect(svc.scheduleChatRun).toHaveBeenCalled();
  });

  it("cancel_schedule resolves the schedule's chat: own AND same-owner sibling schedules execute (a burn-down lane re-arming the bench lane was staging hourly into the void)", async () => {
    mockScheduleFindFirst.mockResolvedValue({ sessionId: LANE });
    const own = await executePlatformTool(makeCtx(), 'cancel_schedule', { id: 'sch-own' });
    expect(staged(own)).toBe(false);
    expect(svc.cancelSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'sch-own' }));

    svc.cancelSchedule.mockClear();
    mockScheduleFindFirst.mockResolvedValue({ sessionId: 'other-1' });
    const sibling = await executePlatformTool(makeCtx(), 'cancel_schedule', { id: 'sch-other' });
    expect(staged(sibling)).toBe(false);
    expect(svc.cancelSchedule).toHaveBeenCalled();
  });

  it('send_to_instance ALWAYS stages under the mode waiver (a remote-instance chat is never the lane\'s own scope)', async () => {
    const out = await executePlatformTool(makeCtx(), 'send_to_instance', { instanceId: 'edge-1', chatId: LANE, message: 'hi' });
    expect(staged(out)).toBe(true);
  });
});

describe('G19 composition with stored ChatAutonomy grants', () => {
  it("the supervisor's MANUAL grant keeps full cross-chat steering (machine run, chat surface, unrelated target)", async () => {
    mockAutonomyRow = { allowedTools: ['send_chat_message'], scheduleCap: 120, source: 'manual' };
    const ctx = makeCtx({ sessionId: 'sup-1', agentSurface: 'chat' } as any); // supervisor wake — no userTurnAt
    const out = await executePlatformTool(ctx, 'send_chat_message', { chatId: 'other-1', content: 'Status on your goal?' });
    expect(staged(out)).toBe(false);
    expect(svc.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'other-1' }));
  });

  it("an 'agent_mode_auto' row (the materialized mode grant — covers worker subagents) carries the SAME lane bound", async () => {
    mockAutonomyRow = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'agent_mode_auto' };
    const worker = makeCtx({ allowedTools: new Set(['send_chat_message']) } as any); // worker: no ctx waiver, grant path only
    const child = await executePlatformTool(worker, 'send_chat_message', { chatId: 'child-1', content: 'x' });
    expect(staged(child)).toBe(false);

    svc.sendChatMessage.mockClear();
    // Fleet scope (owner 2026-09-10): a same-owner sibling now executes for the
    // materialized-grant path too; the cross-USER refusal pin lives above.
    const sibling = await executePlatformTool(worker, 'send_chat_message', { chatId: 'other-1', content: 'x' });
    expect(staged(sibling)).toBe(false);
    expect(svc.sendChatMessage).toHaveBeenCalled();
  });
});

describe('G19: autoModeTargetAllows unit truth table (real service, fail-closed)', () => {
  const call = (tool: string, args: any) => autoModeTargetAllows({ callerChatId: LANE, userId: USER, tool, args });

  it('non-listed tools are own work by construction', async () => {
    await expect(call('start_coding_session', { projectId: 'p1' })).resolves.toBe(true);
    await expect(call('dispatch_platform_task', { title: 't' })).resolves.toBe(true);
    await expect(call('create_feed', { topic: 'x' })).resolves.toBe(true);
  });

  it('send_to_instance is never own scope', async () => {
    await expect(call('send_to_instance', { instanceId: 'e1', chatId: LANE })).resolves.toBe(false);
  });

  it('child → its PARENT is allowed (delegated lanes must report back without staging; integration arm 2026-09-09)', async () => {
    mockChatFindUnique.mockImplementation(async ({ where }: any) =>
      where.id === LANE
        ? { parentChatId: 'parent-1', userId: USER } // the caller lane is a child of parent-1
        : { parentChatId: null, userId: USER });      // the target (parent-1) is a root chat
    await expect(call('send_chat_message', { chatId: 'parent-1' })).resolves.toBe(true);
  });

  it('child → a FOREIGN-owner parent still refuses', async () => {
    mockChatFindUnique.mockImplementation(async ({ where }: any) =>
      where.id === LANE
        ? { parentChatId: 'parent-1', userId: 'someone-else' }
        : { parentChatId: null, userId: USER });
    await expect(call('send_chat_message', { chatId: 'parent-1' })).resolves.toBe(false);
  });

  it('same-owner grandchild now allows (fleet scope 2026-09-10); foreign-owner and unknown targets refuse', async () => {
    mockChatFindUnique.mockResolvedValue({ parentChatId: 'child-1', userId: USER }); // grandchild = same-owner sibling
    await expect(call('send_chat_message', { chatId: 'grandchild-1' })).resolves.toBe(true);
    mockChatFindUnique.mockResolvedValue({ parentChatId: LANE, userId: 'someone-else' }); // confused deputy
    await expect(call('send_chat_message', { chatId: 'child-x' })).resolves.toBe(false);
    mockChatFindUnique.mockResolvedValue(null);
    await expect(call('send_chat_message', { chatId: 'gone' })).resolves.toBe(false);
  });

  it('fails CLOSED on lookup errors', async () => {
    mockChatFindUnique.mockRejectedValue(new Error('db down'));
    await expect(call('send_chat_message', { chatId: 'child-1' })).resolves.toBe(false);
    mockScheduleFindFirst.mockRejectedValue(new Error('db down'));
    await expect(call('cancel_schedule', { id: 'sch-1' })).resolves.toBe(false);
  });

  // Owner pending-card incident 2026-09-14 (rollout watch): five machine
  // lanes' sibling/parent sends staged cards because the target was named
  // with the fleet's 8-char idiom — findUnique on the prefix returned null and
  // the refusal was telemetered as 'foreign_owner' (17 refusals from 9 lanes,
  // all same-owner). The target now resolves like the executor does.
  describe('chat targets named by the fleet\'s 8-char idiom (owner pending-card incident 2026-09-14)', () => {
    const WORLD: Record<string, { parentChatId: string | null; userId: string }> = {
      'cec340f2-f605-4370-b87a-d85b59cb243f': { parentChatId: null, userId: USER },        // a same-owner sibling lane
      'daee2916-fa75-4159-94a1-3d767abfd192': { parentChatId: null, userId: USER },        // the caller's PARENT (below)
      'b0960d27-c5e5-488f-a6c6-d803ab03a432': { parentChatId: 'daee2916-fa75-4159-94a1-3d767abfd192', userId: USER },
      'ffffffff-0000-4000-8000-000000000001': { parentChatId: null, userId: 'someone-else' }, // a foreign chat
      'ffffffff-0000-4000-8000-000000000002': { parentChatId: null, userId: 'someone-else' },
      'aaaaaaaa-1111-4000-8000-000000000001': { parentChatId: null, userId: USER },        // two same-owner chats sharing a prefix
      'aaaaaaaa-1111-4000-8000-000000000002': { parentChatId: null, userId: USER },
      [LANE]: { parentChatId: 'daee2916-fa75-4159-94a1-3d767abfd192', userId: USER },
    };
    beforeEach(() => {
      mockChatFindUnique.mockImplementation(async ({ where }: any) => WORLD[where.id] ?? null);
      mockChatFindMany.mockImplementation(async ({ where, take }: any) =>
        Object.entries(WORLD)
          .filter(([id, row]) => row.userId === where.userId && id.startsWith(where.id.startsWith))
          .map(([id, row]) => ({ id, ...row }))
          .slice(0, take ?? 50));
    });

    it('a same-owner SIBLING named by its 8-char prefix ALLOWS (the cec340f2 class — 3 of the 5 cards)', async () => {
      await expect(call('send_chat_message', { chatId: 'cec340f2', content: 'W3 → PATH C — SHARD C LANDED' })).resolves.toBe(true);
      await expect(call('schedule_message', { chatId: 'cec340f2', prompt: 'x', at: 'later' })).resolves.toBe(true);
    });

    it('the caller\'s PARENT named by its 8-char prefix ALLOWS (the daee2916 card)', async () => {
      await expect(call('send_chat_message', { chatId: 'daee2916', content: 'P2 batch final report' })).resolves.toBe(true);
    });

    it('a longer unique prefix (8–35 chars) resolves too', async () => {
      await expect(call('send_chat_message', { chatId: 'cec340f2-f605-4370', content: 'x' })).resolves.toBe(true);
    });

    it('the caller\'s OWN chat named by its 8-char prefix is own work', async () => {
      // A UUID-shaped caller whose prefix resolves to itself (review 2026-09-15:
      // the arm `target.id === callerChatId` short-circuits BEFORE the
      // family/fleet checks).
      const SELF = 'aaaaaaaa-2222-4000-8000-000000000009';
      WORLD[SELF] = { parentChatId: null, userId: USER };
      try {
        await expect(autoModeTargetAllows({ callerChatId: SELF, userId: USER, tool: 'send_chat_message', args: { chatId: 'aaaaaaaa-2222', content: 'x' } })).resolves.toBe(true);
        await expect(autoModeTargetAllows({ callerChatId: SELF, userId: USER, tool: 'schedule_message', args: { chatId: 'aaaaaaaa-2222', prompt: 'p' } })).resolves.toBe(true);
      } finally {
        delete WORLD[SELF];
      }
    });

    it('an AMBIGUOUS prefix (two same-owner chats) fails CLOSED → the confirmation path', async () => {
      await expect(call('send_chat_message', { chatId: 'aaaaaaaa', content: 'x' })).resolves.toBe(false);
    });

    it('a prefix that only matches a FOREIGN-owner chat never resolves (owner-scoped lookup) → refuses', async () => {
      await expect(call('send_chat_message', { chatId: 'ffffffff-0000-4000-8000-00000000000', content: 'x' })).resolves.toBe(false);
    });

    it('a reconstructed FULL-LENGTH id one character off a same-owner chat (the b0960d27…438f card — real chat ends …488f) now RESOLVES to it (owner 2026-09-18: the card class was exactly this); three characters off still refuses', async () => {
      await expect(call('send_chat_message', { chatId: 'b0960d27-c5e5-438f-a6c6-d803ab03a432', content: 'x' })).resolves.toBe(true);
      await expect(call('send_chat_message', { chatId: 'b0960d27-c5e5-438f-a6c6-d803ab03a999', content: 'x' })).resolves.toBe(false);
      // …and the true prefix does too.
      await expect(call('send_chat_message', { chatId: 'b0960d27', content: 'x' })).resolves.toBe(true);
    });

    it('a SHORT (<8 char) prefix still refuses', async () => {
      await expect(call('send_chat_message', { chatId: 'cec340', content: 'x' })).resolves.toBe(false);
    });

    it('a foreign EXACT id still refuses as foreign_owner (exact lookup is owner-blind; the owner check is not)', async () => {
      await expect(call('send_chat_message', { chatId: 'ffffffff-0000-4000-8000-000000000001', content: 'x' })).resolves.toBe(false);
    });
  });

  // Gate flip 2026-09-11 (owner: full steam): the resolver accepts the SAME
  // unique ≥8-char prefix the schedule tools invite (7/7 stagings since 09-08
  // were 8-char prefixes) — ambiguity and short/unknown prefixes still refuse.
  it('update/cancel_schedule: exact id still resolves first (owner-scoped)', async () => {
    mockScheduleFindFirst.mockResolvedValue({ sessionId: LANE });
    await expect(call('update_schedule', { id: 'sch-full-id' })).resolves.toBe(true);
    expect(mockScheduleFindFirst).toHaveBeenCalledWith({
      where: { id: 'sch-full-id', userId: USER }, select: { sessionId: true },
    });
    expect(mockScheduleFindMany).not.toHaveBeenCalled();
  });

  it('update/cancel_schedule: a UNIQUE ≥8-char owner-scoped prefix RESOLVES (the 8accf96b class)', async () => {
    mockScheduleFindFirst.mockResolvedValue(null); // exact lookup missed
    mockScheduleFindMany.mockResolvedValue([{ id: '8accf96b-1111-2222-3333-444444444444', sessionId: LANE }]);
    await expect(call('cancel_schedule', { id: '8accf96b' })).resolves.toBe(true);
    expect(mockScheduleFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: USER, id: { startsWith: '8accf96b' } },
    }));
  });

  it('update/cancel_schedule: an AMBIGUOUS prefix fails CLOSED (never a guess)', async () => {
    mockScheduleFindFirst.mockResolvedValue(null);
    mockScheduleFindMany.mockResolvedValue([
      { id: '8accf96b-aaaa', sessionId: LANE },
      { id: '8accf96b-bbbb', sessionId: 'other-1' },
    ]);
    await expect(call('update_schedule', { id: '8accf96b' })).resolves.toBe(false);
  });

  it('update/cancel_schedule: a SHORT (<8 char) or UNKNOWN prefix still refuses', async () => {
    mockScheduleFindFirst.mockResolvedValue(null);
    await expect(call('update_schedule', { id: 'sch-pre' })).resolves.toBe(false); // 7 chars — no prefix lookup at all
    expect(mockScheduleFindMany).not.toHaveBeenCalled();
    mockScheduleFindMany.mockResolvedValue([]);
    await expect(call('cancel_schedule', { id: 'deadbeef-unknown' })).resolves.toBe(false);
  });

  it('update/cancel_schedule: a prefix resolving to a FOREIGN-owner chat still refuses (the resolver is owner-scoped AND the target check holds)', async () => {
    mockScheduleFindFirst.mockResolvedValue(null);
    mockScheduleFindMany.mockResolvedValue([{ id: '8accf96b-cccc', sessionId: 'foreign-1' }]);
    mockChatFindUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'foreign-1' ? { parentChatId: null, userId: 'someone-else' } : (CHATS[where.id] ?? null));
    await expect(call('cancel_schedule', { id: '8accf96b' })).resolves.toBe(false);
  });
});

describe('near-miss / unknown targets (owner 2026-09-18: "aren\'t all these messages machine to machine to go autonomously?")', () => {
  const SUP = '615723ba-2bcc-4964-baa4-4759616e8fc5';        // the canlegal-bench supervisor (real id)
  const SUP_TYPO = '615723ba-2bcd-4964-baa4-4759616e8fc5';   // what the lane typed (one hex char off)
  const SIBLING = '615723ba-9999-4964-baa4-4759616e8fc5';    // same prefix, far away
  const NOWHERE = '00000000-0000-4000-8000-000000000000';
  beforeEach(() => {
    CHATS[SUP] = { parentChatId: null, userId: USER };
    CHATS[SIBLING] = { parentChatId: null, userId: USER };
  });
  afterEach(() => { delete CHATS[SUP]; delete CHATS[SIBLING]; });

  for (const [label, ctxOverrides] of [['machine run', {}], ['user-present run', { userTurnAt: new Date() }]] as Array<[string, Partial<ToolContext>]>) {
    it(`${label}: a one-character typo of a same-owner chat id EXECUTES against the REAL chat — no card`, async () => {
      const out = await executePlatformTool(makeCtx(ctxOverrides), 'send_chat_message', { chatId: SUP_TYPO, content: 'Step-9 heartbeat' });
      expect(staged(out)).toBe(false);
      expect(svc.sendChatMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: SUP }));
      expect(mockConfirmations.api.create).not.toHaveBeenCalled();
    });

    it(`${label}: an id that resolves to NO chat is REFUSED with the did-you-mean recovery — nothing staged, nothing sent`, async () => {
      const out = await executePlatformTool(makeCtx(ctxOverrides), 'send_chat_message', { chatId: NOWHERE, content: 'hello?' });
      expect(staged(out)).toBe(false);
      expect(out).toContain('Chat not found');
      expect(out).toContain('No confirmation card was staged');
      expect(svc.sendChatMessage).not.toHaveBeenCalled();
      expect(mockConfirmations.api.create).not.toHaveBeenCalled();
    });
  }

  it('an AMBIGUOUS near-miss (two owned chats equally close) still refuses rather than guessing', async () => {
    CHATS['615723ba-2bce-4964-baa4-4759616e8fc5'] = { parentChatId: null, userId: USER };
    try {
      const out = await executePlatformTool(makeCtx(), 'send_chat_message', { chatId: SUP_TYPO, content: 'x' });
      expect(out).toContain('Chat not found');
      expect(svc.sendChatMessage).not.toHaveBeenCalled();
    } finally { delete CHATS['615723ba-2bce-4964-baa4-4759616e8fc5']; }
  });

  it('a near-miss of ANOTHER owner\'s chat never resolves (candidates are read under the caller\'s userId)', async () => {
    CHATS[SUP] = { parentChatId: null, userId: 'someone-else' };
    const out = await executePlatformTool(makeCtx(), 'send_chat_message', { chatId: SUP_TYPO, content: 'x' });
    expect(out).toContain('Chat not found');
    expect(svc.sendChatMessage).not.toHaveBeenCalled();
  });

  it('autoModeTargetAllows resolves the typo to the real same-owner chat (fleet scope) and refuses the unknown id as unresolved', async () => {
    await expect(autoModeTargetAllows({ callerChatId: LANE, userId: USER, tool: 'send_chat_message', args: { chatId: SUP_TYPO } })).resolves.toBe(true);
    await expect(autoModeTargetAllows({ callerChatId: LANE, userId: USER, tool: 'send_chat_message', args: { chatId: NOWHERE } })).resolves.toBe(false);
  });
});
