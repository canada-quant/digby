/**
 * recordWorkspaceMissing (hardening loop 2026-09-23): a blank-provider session
 * whose worktree vanished fails every firing with the permanent "Workspace
 * missing on disk" error — prod: one chat 4×/h all afternoon, nobody told.
 * Pins the observe-first posture: ONE attention_needed hook per session (NX),
 * no schedule mutation by default, pause only with the opt-in switch.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test' } }));
const mockUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: { update: (...a: any[]) => mockUpdate(...a), findMany: (...a: any[]) => mockFindMany(...a), findUnique: jest.fn(async () => null), count: jest.fn(async () => 0) },
    crossModelChat: { findUnique: jest.fn(async () => null) },
  },
}));
const store = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: any) => { if (opts?.NX && store.has(k)) return null; store.set(k, v); return 'OK'; }),
    get: jest.fn(async (k: string) => store.get(k) ?? null), del: jest.fn(async () => 1), incr: jest.fn(async () => 1), expire: jest.fn(async () => 1),
  },
  redisSubscriber: { subscribe: jest.fn(), on: jest.fn() },
}));
const mockEmitHook = jest.fn(async (..._a: any[]) => undefined);
jest.mock('../platform/hooks.service', () => ({ __esModule: true, emitHookEvent: (...a: any[]) => mockEmitHook(...a) }));

import { recordWorkspaceMissing } from './schedule.service';

beforeEach(() => { jest.clearAllMocks(); store.clear(); });

describe('recordWorkspaceMissing', () => {
  it('emits ONE attention_needed hook per session and touches no schedule', async () => {
    const r1 = await recordWorkspaceMissing('sess-1', 'Workspace missing on disk — start a new session');
    const r2 = await recordWorkspaceMissing('sess-1', 'Workspace missing on disk — start a new session');
    expect(r1).toEqual({ alerted: true, paused: 0 });
    expect(r2).toEqual({ alerted: false, paused: 0 });
    expect(mockEmitHook).toHaveBeenCalledTimes(1);
    const [sessionId, type, summary, extra] = mockEmitHook.mock.calls[0];
    expect(sessionId).toBe('sess-1');
    expect(type).toBe('attention_needed');
    expect(summary).toContain('workspace is MISSING on disk');
    expect(summary).toContain('start a NEW coding session');
    expect(summary).toContain('keep firing as honest failed runs');
    expect(extra).toMatchObject({ sessionId: 'sess-1', reason: 'workspace_missing', paused: 0 });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('a different session gets its own alert', async () => {
    await recordWorkspaceMissing('sess-1', 'x');
    await recordWorkspaceMissing('sess-2', 'x');
    expect(mockEmitHook).toHaveBeenCalledTimes(2);
  });

  it('never throws when redis and prisma fail', async () => {
    mockFindMany.mockRejectedValueOnce(new Error('db down'));
    await expect(recordWorkspaceMissing('sess-4', 'x')).resolves.toEqual(expect.objectContaining({ paused: 0 }));
  });
});
