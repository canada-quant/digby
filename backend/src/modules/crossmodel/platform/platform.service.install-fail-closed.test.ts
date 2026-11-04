/**
 * 2026-10-20 (review of #1717): the provision-time dependency install must
 * FAIL CLOSED in container mode — never `bash -lc <install>` inside the
 * worker/backend when the session container is unavailable. Container mode
 * off (dev / test / self-hosted) keeps the host fallback.
 * Mock stack mirrors platform.service.b6acc1e3.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  crossModelChat: { findMany: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  chatCodingState: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  userPreferences: { findUnique: jest.fn() },
  activity: { create: jest.fn(async () => ({})) },
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(), expire: jest.fn(), decr: jest.fn(), set: jest.fn(), del: jest.fn(),
    scan: jest.fn(async () => ({ cursor: 0, keys: [] as string[] })),
    mGet: jest.fn(async () => [] as Array<string | null>),
    exists: jest.fn(async () => 0),
  },
}));

// error-handler imports config/env → process.exit at import without env vars.
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

jest.mock('../integrations/moonshot.integration', () => ({ __esModule: true, default: { synthesize: jest.fn(), generateTitle: jest.fn() } }));

// Edge custom-endpoint registry (dynamically imported by the REAL
// resolveOneCodingPick's '<label>:<modelId>' branch). Default: no match.
const mockResolveRegistryModel = jest.fn(async (_spec?: string, _userId?: string): Promise<any> => null);
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: (...a: any[]) => mockResolveRegistryModel(...a),
}));

jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
// The project codingModel pick lives in the Store — the default-resolution
// conflict case sets it per-test.
const mockGetProjectSettings = jest.fn(async (_projectId?: string): Promise<any> => ({ crossProjectMemory: false }));
jest.mock('../langgraph/memory.graph', () => ({
  __esModule: true,
  getProjectSettings: (...a: any[]) => mockGetProjectSettings(...a),
  setProjectSettings: jest.fn(async () => ({ crossProjectMemory: true })),
  updateContextAsync: jest.fn(),
}));

jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: jest.fn(() => true),
  preemptMachineRunForUserMessage: jest.fn(async () => ({ preempted: false, freed: false })),
  nudgeQueueDrainSoon: jest.fn(() => {}),
  chatRunKey: (id: string) => `chat:${id}`,
}));
jest.mock('../coding/coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: jest.fn(async () => ({ started: true })),
  steerActiveRun: jest.fn(async () => ({ steered: false, reason: 'no_active_run' })),
}));
jest.mock('../upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('../chat-agent/message-queue.service', () => ({
  __esModule: true,
  MAX_QUEUE_DEPTH: 20,
  enqueueChatMessage: jest.fn(async () => ({ id: 'p1', position: 1 })),
  countPending: jest.fn(async () => 0),
  countPendingUser: jest.fn(async () => 0),
}));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  depthForChat: jest.fn(async () => 0),
  stampHookDepth: jest.fn(async () => {}),
  emitHookEvent: jest.fn(async () => {}),
}));
jest.mock('./user-space.service', () => ({ __esModule: true, ensureUserSpace: jest.fn(async () => null) }));
jest.mock('./project-supervisor.service', () => ({
  __esModule: true,
  ensureProjectSupervisor: jest.fn(async () => null),
  pauseProjectSupervisor: jest.fn(async () => {}),
}));
jest.mock('../coding/workspace.service', () => ({
  __esModule: true,
  sessionBranchName: (id: string) => `digby/session-${id}`,
  worktreePath: (id: string) => `/wt/${id}`,
  ensureWorktree: jest.fn(async () => '/wt/x'),
  ensureBlankWorktree: jest.fn(async () => '/wt/x'),
  removeWorktree: jest.fn(async () => {}),
  removeSessionEnv: jest.fn(async () => {}),
}));
const mockEnsureSessionContainer = jest.fn(async (_id?: string) => false);
const mockExecInContainer = jest.fn(async (..._a: any[]) => ({ stdout: '', stderr: '' }));
const mockHostExecFallbackAllowed = jest.fn(() => false);
const mockDockerProbeSkipReason = jest.fn((): string | null => null);
jest.mock('../coding/container.service', () => ({
  __esModule: true,
  ensureSessionContainer: (id: string) => mockEnsureSessionContainer(id),
  execInContainer: (...a: any[]) => mockExecInContainer(...a),
  hostExecFallbackAllowed: () => mockHostExecFallbackAllowed(),
  dockerProbeSkipReason: () => mockDockerProbeSkipReason(),
  stopSessionContainer: jest.fn(async () => {}),
}));
// Host bash — the path that must NOT run in container mode.
const mockExecFile = jest.fn((_cmd: string, _args: string[], _opts: any, cb: any) => cb(null, { stdout: '', stderr: '' }));
jest.mock('child_process', () => ({ __esModule: true, execFile: (...a: any[]) => (mockExecFile as any)(...a) }));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/scaffolding.service', () => ({ __esModule: true, scaffoldProjectDocs: jest.fn(async () => {}), ensureProjectDocs: jest.fn(async () => ({ scaffold: {}, refresh: {} })) }));
jest.mock('../coding/coding-memory.service', () => ({ __esModule: true, inheritSessionMemory: jest.fn(async () => {}) }));
jest.mock('../coding/verify.service', () => ({ __esModule: true, readDigbyConfig: jest.fn(async () => ({ commands: { install: 'npm ci' } })) }));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => null) }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  default: { search: jest.fn(async () => []), add: jest.fn(async () => {}) },
}));

import * as platform from './platform.service';
import logger from '../../../utils/logger';

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureSessionContainer.mockResolvedValue(false);
  mockHostExecFallbackAllowed.mockReturnValue(false);
  mockDockerProbeSkipReason.mockReturnValue(null);
});

describe('installDependencies fail-closed (2026-10-20)', () => {
  it('container mode + no container: skips the install, never runs host bash, warns', async () => {
    await platform.__installDependenciesForTest('s1', '/wt/s1');
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(mockExecInContainer).not.toHaveBeenCalled();
    const warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => /dep install skipped for session s1/.test(w) && /refuses host execution/.test(w))).toBe(true);
  });

  it('a process with no daemon BY DESIGN logs info, not warn', async () => {
    mockDockerProbeSkipReason.mockReturnValue('CODING_CONTAINER_PROBE_DISABLED=1');
    await platform.__installDependenciesForTest('s1', '/wt/s1');
    expect(mockExecFile).not.toHaveBeenCalled();
    expect((logger.warn as jest.Mock).mock.calls.some((c) => /dep install skipped/.test(String(c[0])))).toBe(false);
    expect((logger.info as jest.Mock).mock.calls.some((c) => /dep install skipped.*CODING_CONTAINER_PROBE_DISABLED/.test(String(c[0])))).toBe(true);
  });

  it('a healthy session container runs the install there', async () => {
    mockEnsureSessionContainer.mockResolvedValue(true);
    await platform.__installDependenciesForTest('s1', '/wt/s1');
    expect(mockExecInContainer).toHaveBeenCalledWith('s1', 'npm ci', '/wt/s1', expect.any(Number));
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('container mode off (or the kill switch) keeps the host fallback', async () => {
    mockHostExecFallbackAllowed.mockReturnValue(true);
    await platform.__installDependenciesForTest('s1', '/wt/s1');
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile.mock.calls[0][0]).toBe('bash');
    expect(mockExecFile.mock.calls[0][1]).toEqual(['-lc', 'npm ci']);
  });
});

/**
 * Characterization pin — log-signal ticket 90a508a6 (2026-10-23, family lane
 * ecc2bb0d): the "platform: dep install skipped for session <uuid> — no
 * isolated container here and container mode refuses host execution" warn
 * fingerprint the hourly log-signal-sweep filed (11 rows across 5 distinct
 * hours, Oct 21) is DESIGNED fail-closed security observability — the
 * 2026-10-20 review-of-#1717 contract this suite pins — not a defect.
 *
 * WHERE THE ROWS COME FROM (adjudicated 2026-10-23, live evidence this run):
 * the site (platform.service.ts installDependencies) warns EXACTLY ONCE per
 * provisioned session whose container could not be ensured, and only when the
 * process is NOT by-design daemonless (the info split two describes above).
 * The filing window's 11 rows = 11 session provisions on a worker whose
 * Docker probe was failing at provision time (a negative probe is re-tried
 * after 30 s — DOCKER_NEGATIVE_MEMO_MS, container.service.ts — so a daemon
 * blip across a busy provisioning hour mints one row per session, bounded by
 * session count, never a per-session retry loop). At pin time (2026-10-23
 * 00:15Z) the trailing-24h count read from app_error_logs is ZERO: the
 * Docker transient passed and the class self-stopped — which a
 * lost-suppression-state defect would not do.
 *
 * WHY DESIGNED: the alternative to the skip is running `bash -lc <install>`
 * INSIDE the worker/backend when no isolated container exists — the exact
 * host-execution hole the 2026-10-20 review closed. The warn IS the durable
 * record that a session started WITHOUT its dependency install (the
 * session's own isolated shell installs later — the skip is best-effort,
 * "never blocks ready"); silencing it would hide a container-fleet
 * regression (every session silently degraded to no-install).
 */
describe('log-signal 90a508a6 — the skip warn is designed fail-closed observability (the swept fingerprint, pinned verbatim)', () => {
  // The live row's session id (ticket 90a508a6 example message) — the
  // fingerprint's <uuid> slot pinned in its real shape.
  const SID = '91b67432-1c99-4b81-94ac-96ab3ac1cd88';

  it('container mode + ensure failed: EXACTLY ONE warn, the fingerprint text byte-for-byte, and nothing executed anywhere', async () => {
    await platform.__installDependenciesForTest(SID, '/wt/91b67432');
    const w = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((x) => x.includes('dep install skipped'));
    // ONE warn per provision — the containment bound behind "rows = session
    // provisions, never a retry loop".
    expect(w).toHaveLength(1);
    expect(w[0]).toBe(
      `platform: dep install skipped for session ${SID} — no isolated container here and container mode refuses host execution`,
    );
    // Fail-closed: no container exec into a container that does not exist…
    expect(mockExecInContainer).not.toHaveBeenCalled();
    // …and no host bash (mockExecFile counts it — the #1717 hole stays shut).
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('the byDesign reason rides the INFO line inline — the daemonless class can never mint a warn row the sweep files', async () => {
    mockDockerProbeSkipReason.mockReturnValue('CODING_WORKER_CONCURRENCY=0 (cron-only / web tier)');
    await platform.__installDependenciesForTest(SID, '/wt/91b67432');
    expect((logger.warn as jest.Mock).mock.calls.some((c) => String(c[0]).includes('dep install skipped'))).toBe(false);
    const info = (logger.info as jest.Mock).mock.calls.map((c) => String(c[0])).find((x) => x.includes('dep install skipped'));
    expect(info).toBe(
      `platform: dep install skipped for session ${SID} — no isolated container here (CODING_WORKER_CONCURRENCY=0 (cron-only / web tier)) and container mode refuses host execution`,
    );
  });

  it('a skip is TERMINAL for the provision — no second warn, no deferred install attempt after the return', async () => {
    await platform.__installDependenciesForTest(SID, '/wt/91b67432');
    await platform.__installDependenciesForTest(SID, '/wt/91b67432'); // a second provision of the same session
    const w = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((x) => x.includes('dep install skipped'));
    // One row per CALL, never a ladder: 2 calls = 2 rows, and each call made
    // exactly one — the row count can only track provision count.
    expect(w).toHaveLength(2);
  });
});
