/**
 * Fleet supervisor (slice A) — autonomy.service unit tests with mocked Prisma.
 * Pins: PK lookup semantics, owner-only authorization (mirrors
 * platform.service.scheduleChatRun), the allowedTools subset validation,
 * scheduleCap clamping (1..1440), revoke-on-empty, and the Activity audit rows.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  chatAutonomy: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn(async () => ({ count: 1 })) },
  crossModelChat: { findUnique: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// crossmodel.service's real module pulls the model integrations + DB/env chains;
// autonomy.service only needs getChatAccess — mock the boundary.
const mockGetChatAccess = jest.fn();
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

import {
  getChatAutonomy, setChatAutonomy, auditAutonomousExecution, syncAutonomyWithAgentMode,
  selfGrantSubsetVerdict,
  AUTONOMY_GRANTABLE_TOOLS, DEFAULT_SCHEDULE_CAP, MAX_SCHEDULE_CAP,
  AUTONOMY_SOURCE_MANUAL, AUTONOMY_SOURCE_AGENT_MODE,
} from './autonomy.service';

const base = { userId: 'u1', chatId: 'c1', allowedTools: ['send_chat_message'] };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  mockPrisma.chatAutonomy.upsert.mockImplementation(({ create }: any) => Promise.resolve({
    allowedTools: create.allowedTools,
    scheduleCap: create.scheduleCap ?? DEFAULT_SCHEDULE_CAP,
  }));
  mockPrisma.crossModelChat.findUnique.mockResolvedValue({ userId: 'owner-1' });
});

describe('getChatAutonomy', () => {
  it('returns null when the chat has no grant row', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(getChatAutonomy('c1')).resolves.toBeNull();
    expect(mockPrisma.chatAutonomy.findUnique).toHaveBeenCalledWith({
      where: { chatId: 'c1' },
      select: { allowedTools: true, scheduleCap: true, source: true },
    });
  });

  it('returns the grant (allowedTools + scheduleCap + source) for a granted chat', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: ['schedule_message'], scheduleCap: 96, source: 'manual' });
    await expect(getChatAutonomy('c1')).resolves.toEqual({ allowedTools: ['schedule_message'], scheduleCap: 96, source: 'manual' });
  });
});

describe('setChatAutonomy — ownership', () => {
  it('rejects an unknown chat with 404', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: false });
    await expect(setChatAutonomy(base)).rejects.toMatchObject({ statusCode: 404, message: 'Chat not found' });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('rejects a non-member with 404 (existence is not leaked)', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'none', exists: true });
    await expect(setChatAutonomy(base)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('rejects a project MEMBER (write access) with 403 — owner-only (confused-deputy guard)', async () => {
    mockGetChatAccess.mockResolvedValue({ access: 'write', exists: true });
    await expect(setChatAutonomy(base)).rejects.toMatchObject({ statusCode: 403, message: expect.stringContaining('owner') });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });
});

describe('setChatAutonomy — validation', () => {
  it('rejects tool names outside the grantable consequential subset', async () => {
    await expect(setChatAutonomy({ ...base, allowedTools: ['send_chat_message', 'delete_chat'] }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('delete_chat') });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('set_chat_autonomy itself is NOT grantable (no self-granting of autonomy)', async () => {
    await expect(setChatAutonomy({ ...base, allowedTools: ['set_chat_autonomy'] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('accepts every grantable tool and dedupes repeats', async () => {
    const all = [...AUTONOMY_GRANTABLE_TOOLS, 'send_chat_message'];
    const r = await setChatAutonomy({ ...base, allowedTools: all });
    const data = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(data.create.allowedTools).toEqual([...AUTONOMY_GRANTABLE_TOOLS]);
    expect(r.allowedTools).toEqual([...AUTONOMY_GRANTABLE_TOOLS]);
  });

  it('dispatch_platform_task is grantable (Option D 2026-08-22: a machine run needs the grant or it stages a confirmation)', async () => {
    expect(AUTONOMY_GRANTABLE_TOOLS).toContain('dispatch_platform_task');
    const r = await setChatAutonomy({ ...base, allowedTools: ['dispatch_platform_task'] });
    expect(r.allowedTools).toEqual(['dispatch_platform_task']);
  });

  it('clamps scheduleCap into 1..1440', async () => {
    await setChatAutonomy({ ...base, scheduleCap: 0 });
    expect(mockPrisma.chatAutonomy.upsert.mock.calls[0][0].create.scheduleCap).toBe(1);

    await setChatAutonomy({ ...base, scheduleCap: 5000 });
    expect(mockPrisma.chatAutonomy.upsert.mock.calls[1][0].create.scheduleCap).toBe(MAX_SCHEDULE_CAP);

    const r = await setChatAutonomy({ ...base, scheduleCap: 96 });
    expect(mockPrisma.chatAutonomy.upsert.mock.calls[2][0].create.scheduleCap).toBe(96);
    expect(r.scheduleCap).toBe(96);
  });

  it('rejects a non-numeric scheduleCap', async () => {
    await expect(setChatAutonomy({ ...base, scheduleCap: Number('lots') }))
      .rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('scheduleCap') });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('omits scheduleCap from the upsert when not provided (model default / unchanged)', async () => {
    await setChatAutonomy(base);
    const data = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(data.create).not.toHaveProperty('scheduleCap');
    expect(data.update).not.toHaveProperty('scheduleCap');
  });
});

describe('setChatAutonomy — grant / revoke', () => {
  it('upserts the grant keyed on the chat PK and audits autonomy.grant (resource platform)', async () => {
    const r = await setChatAutonomy({ ...base, scheduleCap: 60 });
    expect(r).toEqual({ granted: true, chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: 60, source: 'manual' });
    const data = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(data.where).toEqual({ chatId: 'c1' });
    expect(data.create).toMatchObject({ chatId: 'c1', userId: 'u1', allowedTools: ['send_chat_message'] });
    expect(data.update).toMatchObject({ userId: 'u1', allowedTools: ['send_chat_message'] });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', action: 'autonomy.grant', resource: 'platform' }),
    });
  });

  it("stamps source 'manual' on BOTH create and update — a manual save converts an auto-granted row to manual (mode flips then never touch it)", async () => {
    await setChatAutonomy(base);
    const data = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(data.create).toMatchObject({ source: AUTONOMY_SOURCE_MANUAL });
    expect(data.update).toMatchObject({ source: AUTONOMY_SOURCE_MANUAL });
  });

  it('an EMPTY allowedTools revokes: deletes the row and audits autonomy.revoke', async () => {
    const r = await setChatAutonomy({ ...base, allowedTools: [] });
    expect(r).toEqual({ granted: false, chatId: 'c1', allowedTools: [], scheduleCap: null, source: null });
    expect(mockPrisma.chatAutonomy.deleteMany).toHaveBeenCalledWith({ where: { chatId: 'c1' } });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'u1', action: 'autonomy.revoke', resource: 'platform' }),
    });
  });
});

// ── Agent-mode auto-grant (owner 2026-09-07: Auto ⇒ Autonomy granted) ─────────
describe('syncAutonomyWithAgentMode', () => {
  const FULL_AUTO_ROW = {
    userId: 'owner-1',
    allowedTools: [...AUTONOMY_GRANTABLE_TOOLS],
    scheduleCap: DEFAULT_SCHEDULE_CAP,
    source: AUTONOMY_SOURCE_AGENT_MODE,
  };

  it("mode 'auto' with NO grant → materializes the FULL grant: all grantable tools, DEFAULT cap 48, source 'agent_mode_auto', owner-attributed", async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(syncAutonomyWithAgentMode({ chatId: 'c1', permissionMode: 'auto' })).resolves.toBe('granted');
    const data = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(data.where).toEqual({ chatId: 'c1' });
    expect(data.create).toMatchObject({
      chatId: 'c1',
      userId: 'owner-1', // the CHAT OWNER (resolved live), never a member
      allowedTools: [...AUTONOMY_GRANTABLE_TOOLS],
      scheduleCap: DEFAULT_SCHEDULE_CAP, // the runaway backstop stays at the default — auto-grant never raises it
      source: AUTONOMY_SOURCE_AGENT_MODE,
    });
    expect(data.update).toMatchObject({ allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: DEFAULT_SCHEDULE_CAP, source: AUTONOMY_SOURCE_AGENT_MODE });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner-1', action: 'autonomy.grant', resource: 'platform',
        metadata: expect.objectContaining({ chatId: 'c1', source: AUTONOMY_SOURCE_AGENT_MODE }),
      }),
    });
  });

  it("mode 'auto' with a MANUAL grant → untouched (an owner-curated set is never widened by a mode flip)", async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ userId: 'owner-1', allowedTools: ['send_chat_message'], scheduleCap: 96, source: AUTONOMY_SOURCE_MANUAL });
    await expect(syncAutonomyWithAgentMode({ chatId: 'c1', permissionMode: 'auto' })).resolves.toBe('unchanged');
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it("mode 'auto' with an IDENTICAL auto grant → no rewrite, no audit spam (idempotent re-sync)", async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(FULL_AUTO_ROW);
    await expect(syncAutonomyWithAgentMode({ chatId: 'c1', permissionMode: 'auto' })).resolves.toBe('unchanged');
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it("mode 'auto' with a DRIFTED auto grant (a tool joined AUTONOMY_GRANTABLE_TOOLS since) → re-materialized to the full set", async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ ...FULL_AUTO_ROW, allowedTools: FULL_AUTO_ROW.allowedTools.slice(1) });
    await expect(syncAutonomyWithAgentMode({ chatId: 'c1', permissionMode: 'auto' })).resolves.toBe('granted');
    expect(mockPrisma.chatAutonomy.upsert.mock.calls[0][0].create.allowedTools).toEqual([...AUTONOMY_GRANTABLE_TOOLS]);
  });

  it("mode 'auto' for a vanished chat → unchanged (nothing to grant against)", async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(null);
    await expect(syncAutonomyWithAgentMode({ chatId: 'gone', permissionMode: 'auto' })).resolves.toBe('unchanged');
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it("leaving auto REVOKES an auto-granted row (source-filtered delete) and audits autonomy.revoke", async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(FULL_AUTO_ROW);
    await expect(syncAutonomyWithAgentMode({ chatId: 'c1', permissionMode: 'ask' })).resolves.toBe('revoked');
    expect(mockPrisma.chatAutonomy.deleteMany).toHaveBeenCalledWith({
      where: { chatId: 'c1', source: AUTONOMY_SOURCE_AGENT_MODE }, // the source filter — a concurrent manual save is never clobbered
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner-1', action: 'autonomy.revoke', resource: 'platform',
        metadata: expect.objectContaining({ chatId: 'c1', source: AUTONOMY_SOURCE_AGENT_MODE }),
      }),
    });
  });

  it('leaving auto NEVER touches a manually-curated grant', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ userId: 'owner-1', allowedTools: ['send_chat_message'], scheduleCap: 96, source: AUTONOMY_SOURCE_MANUAL });
    await expect(syncAutonomyWithAgentMode({ chatId: 'c1', permissionMode: 'plan' })).resolves.toBe('unchanged');
    expect(mockPrisma.chatAutonomy.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('leaving auto with NO grant is a no-op', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(syncAutonomyWithAgentMode({ chatId: 'c1', permissionMode: 'ask' })).resolves.toBe('unchanged');
    expect(mockPrisma.chatAutonomy.deleteMany).not.toHaveBeenCalled();
  });
});

describe('auditAutonomousExecution', () => {
  it('writes a best-effort Activity row (resource platform) for an autonomous run', async () => {
    await auditAutonomousExecution({ chatId: 'c1', tool: 'send_chat_message', userId: 'u1' });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'u1', action: 'autonomy.execute', resource: 'platform',
        metadata: expect.objectContaining({ chatId: 'c1', tool: 'send_chat_message', note: 'autonomous execution' }),
      }),
    });
  });

  it('an audit failure never throws (the autonomous action must not be blocked)', async () => {
    mockPrisma.activity.create.mockRejectedValue(new Error('db down'));
    await expect(auditAutonomousExecution({ chatId: 'c1', tool: 'cancel_schedule', userId: 'u1' })).resolves.toBeUndefined();
  });
});

describe('selfGrantSubsetVerdict (ticket 9341e862)', () => {
  // Every test sets its own findUnique value — jest.clearAllMocks() in the
  // outer beforeEach clears CALLS, not implementations (sticky-mock hazard).
  const call = (args: any, modeAuthority = false) =>
    selfGrantSubsetVerdict({ callerChatId: 'c1', args, modeAuthority });

  it('cross-chat requests are ALWAYS beyond — even for an auto-mode caller asking within the grantable set', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(call({ chatId: 'c2', allowedTools: ['send_chat_message'] }, true)).resolves.toEqual({ kind: 'beyond' });
    expect(mockPrisma.chatAutonomy.findUnique).not.toHaveBeenCalled(); // the row is never even consulted for a foreign target
  });

  it('modeAuthority: a subset of the grantable template (no cap) is mode_covered with the DEFAULT cap', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message', 'schedule_message'] }, true))
      .resolves.toEqual({ kind: 'mode_covered', effectiveCap: DEFAULT_SCHEDULE_CAP });
  });

  it('modeAuthority: the FULL template at cap 48 is mode_covered (the exact 9341e862 lane request)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: 48, source: AUTONOMY_SOURCE_AGENT_MODE });
    await expect(call({ chatId: 'c1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: 48 }, true))
      .resolves.toEqual({ kind: 'mode_covered', effectiveCap: 48 });
  });

  it('modeAuthority: a cap ABOVE the effective cap is beyond (raising the cap is a real widening)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: 49 }, true)).resolves.toEqual({ kind: 'beyond' });
  });

  it('modeAuthority: the effective cap comes from the row when present (100 covers 80, not 120)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 100, source: AUTONOMY_SOURCE_MANUAL });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: 80 }, true)).resolves.toEqual({ kind: 'mode_covered', effectiveCap: 100 });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: 120 }, true)).resolves.toEqual({ kind: 'beyond' });
  });

  it('modeAuthority: a tool outside the grantable template is beyond', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(call({ chatId: 'c1', allowedTools: ['delete_chat'] }, true)).resolves.toEqual({ kind: 'beyond' });
  });

  it("modeAuthority: an empty array (self-revoke) is mode_covered — the gate's honest mode-lifecycle no-op answers it", async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(call({ chatId: 'c1', allowedTools: [] }, true)).resolves.toEqual({ kind: 'mode_covered', effectiveCap: DEFAULT_SCHEDULE_CAP });
  });

  it('stored grant: a subset of the row is within_grant', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: ['send_chat_message', 'schedule_message'], scheduleCap: 48, source: AUTONOMY_SOURCE_MANUAL });
    await expect(call({ chatId: 'c1', allowedTools: ['schedule_message'] })).resolves.toEqual({ kind: 'within_grant' });
  });

  it('stored grant: a tool the row does NOT name is beyond', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48, source: AUTONOMY_SOURCE_MANUAL });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message', 'cancel_schedule'] })).resolves.toEqual({ kind: 'beyond' });
  });

  it('stored grant: cap at/below the row cap is within, above is beyond, omitted never widens', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 96, source: AUTONOMY_SOURCE_MANUAL });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: 96 })).resolves.toEqual({ kind: 'within_grant' });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: 97 })).resolves.toEqual({ kind: 'beyond' });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'] })).resolves.toEqual({ kind: 'within_grant' });
  });

  it('stored grant: an empty array (self-revoke) is within_grant — shrinking never needs an owner', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48, source: AUTONOMY_SOURCE_MANUAL });
    await expect(call({ chatId: 'c1', allowedTools: [] })).resolves.toEqual({ kind: 'within_grant' });
  });

  it('NO grant: any non-empty request is beyond — a run can never bootstrap its own autonomy', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'] })).resolves.toEqual({ kind: 'beyond' });
  });

  it('NO grant: an empty array is within_grant (a harmless no-op self-revoke)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(call({ chatId: 'c1', allowedTools: [] })).resolves.toEqual({ kind: 'within_grant' });
  });

  it('the requested cap is clamped like setChatAutonomy before comparison (5000 clamps to 1440)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: MAX_SCHEDULE_CAP, source: AUTONOMY_SOURCE_MANUAL });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: 5000 })).resolves.toEqual({ kind: 'within_grant' });
  });

  it('a non-finite cap is beyond (the staged path surfaces the validation error)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: ['send_chat_message'], scheduleCap: 48, source: AUTONOMY_SOURCE_MANUAL });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: Number.NaN })).resolves.toEqual({ kind: 'beyond' });
  });

  it('malformed allowedTools (not an array) is beyond', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
    await expect(call({ chatId: 'c1', allowedTools: 'send_chat_message' }, true)).resolves.toEqual({ kind: 'beyond' });
  });

  it('a grant-row READ failure is beyond (fail-closed — not the same as a null row)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockRejectedValue(new Error('db down'));
    await expect(call({ chatId: 'c1', allowedTools: [] }, true)).resolves.toEqual({ kind: 'beyond' });
  });

  it('auto-sourced row: a covered non-empty request from a NON-modeAuthority caller is mode_covered — NEVER written manual (the row is mode-managed)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: 48, source: AUTONOMY_SOURCE_AGENT_MODE });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message', 'update_schedule'] })).resolves.toEqual({ kind: 'mode_covered', effectiveCap: 48 });
  });

  it('auto-sourced row: a self-revoke from a NON-modeAuthority caller is within_grant (executes — the dispatcher mode_auto guard answers honestly)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: 48, source: AUTONOMY_SOURCE_AGENT_MODE });
    await expect(call({ chatId: 'c1', allowedTools: [] })).resolves.toEqual({ kind: 'within_grant' });
  });

  it('auto-sourced row: a cap raise from a NON-modeAuthority caller is beyond (the owner still cards)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: 48, source: AUTONOMY_SOURCE_AGENT_MODE });
    await expect(call({ chatId: 'c1', allowedTools: ['send_chat_message'], scheduleCap: 49 })).resolves.toEqual({ kind: 'beyond' });
  });
});
