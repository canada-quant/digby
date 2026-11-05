/**
 * Ticket b1852d45 replay/fix pin — new-project GitHub bootstrap order + ownership.
 *
 * The report ("github repo new project bugs… it should have my gh. pat token…
 * the framework isn't understanding how to properly scaffold a new project
 * when the github doesn't exist yet"): the user's ericfoundation.com sessions
 * produced a private repo the user could not find anywhere. Two verified
 * defects in the ONE repo-creation seam:
 *
 *  1. WRONG-ACCOUNT class — github/token-manager.getValidToken's no-label path
 *     did findFirst({ where: { userId } }) with NO orderBy: with multiple
 *     connected GitHub accounts the creation token (and thus repo ownership)
 *     was an arbitrary Postgres row. Fix: deterministic orderBy createdAt asc
 *     (first-connected = primary), matching getAllValidTokens.
 *
 *  2. ORDER/OPACITY class — coding/tools.ensureGithubRepoForBlank silently
 *     reused ANY same-named repo on collision (a session's pushes could land
 *     in an unrelated pre-existing repo) and emitted repo_created without the
 *     owner. Fix: reuse only EMPTY repos (an earlier creation retry), fall
 *     through to a deterministic session-suffixed name on a non-empty
 *     collision, and carry owner + name in the event.
 *
 * These tests exercise the REAL functions with axios / child_process / prisma
 * mocked at the boundary (same mock discipline as tools.test.ts).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// tools.ts's import graph reaches config/env (process.exit landmine) through
// several modules — same boundary mocks as tools.test.ts.
jest.mock('../platform/platform.service', () => ({ __esModule: true }));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'],
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
  buildSessionMemoryInventory: jest.fn(async () => ''),
}));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { CODING_RETRIEVAL_USAGE: 'coding_retrieval_usage', CODING_RETRIEVAL_HITS: 'coding_retrieval_hits' },
}));
jest.mock('./self-merge.service', () => ({
  __esModule: true,
  selfMergeDisabled: () => false,
  resolveSelfMergePolicy: jest.fn(async () => ({ policy: 'on', source: 'setting' })),
  checkOrAskOwner: jest.fn(async () => 'pending'),
  evaluateMergeGates: jest.fn(async () => ({ ok: true, alreadyMerged: false, headSha: 'h', evidenceHash: 'e', evidenceNotes: [] })),
  readAttempt: jest.fn(async () => ({})),
  writeAttempt: jest.fn(async () => {}),
  clearAttempt: jest.fn(async () => {}),
  recordMergeLearning: jest.fn(async () => {}),
  nothingChanged: () => false,
  selfMergeMaxCycles: () => 3,
  defaultGithubApi: () => ({ put: jest.fn(), get: jest.fn() }),
}));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: jest.fn(async () => ({ kind: 'created' })),
}));
jest.mock('./ci-status', () => ({
  __esModule: true,
  observeCiAfterPush: jest.fn(async () => ''),
  fetchCiStatus: jest.fn(async () => ({ state: 'none', checks: [], failing: [], total: 0 })),
  renderCiStatus: jest.fn(() => ''),
  emitCiFailed: jest.fn(),
}));
jest.mock('./process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('./code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('./schedule.service', () => ({
  __esModule: true,
  createSchedule: jest.fn(async () => ({ ok: true, schedule: { id: 'sch1' } })),
}));
jest.mock('./run-idempotency', () => ({
  __esModule: true,
  findPriorRunPushReceipt: jest.fn(async () => null),
  findPriorRunPrReceipt: jest.fn(async () => null),
  prHeadMatchesReceipt: jest.fn(async () => false),
}));

// ── Boundary mocks under test control ────────────────────────────────────────
const mockPost: jest.Mock = jest.fn();
const mockGet: jest.Mock = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { post: (...a: any[]) => mockPost(...a), get: (...a: any[]) => mockGet(...a) },
}));

// tools.ts promisifies child_process.execFile at module scope (base-branch
// push). Callback-style mock: success with empty output.
jest.mock('child_process', () => ({
  __esModule: true,
  execFile: jest.fn((_cmd: string, _args: string[], _opts: any, cb: (e: any, so: string, se: string) => void) => cb(null, '', '')),
}));

const mockPersistProjectRepo: jest.Mock = jest.fn(async () => {});
jest.mock('./coding-data.service', () => ({
  __esModule: true,
  persistProjectRepo: (...a: any[]) => mockPersistProjectRepo(...a),
}));

// token-manager boundaries: prisma + the decryptor.
const mockGhFindFirst: jest.Mock = jest.fn();
const mockGhFindUnique: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    gitHubOAuthToken: {
      findFirst: (...a: any[]) => mockGhFindFirst(...a),
      findUnique: (...a: any[]) => mockGhFindUnique(...a),
    },
  },
}));
jest.mock('../google/crypto', () => ({
  __esModule: true,
  decryptWith: (val: string) => `dec:${val}`,
}));

import { ensureGithubRepoForBlank } from './tools';
import { getValidToken } from '../github/token-manager';

const SESSION_ID = 'aaaa1111-bbbb-cccc-dddd-eeeeffff0000';
const SUFFIX = SESSION_ID.slice(0, 8); // 'aaaa1111'

const makeCtx = (over: Record<string, any> = {}): any => ({
  worktree: '/tmp/wt',
  sessionId: SESSION_ID,
  userId: 'u1',
  permissionMode: 'auto',
  provider: 'blank',
  branch: 'digby/session-x',
  baseBranch: 'main',
  projectId: 'proj-1',
  projectName: 'EricFoundation',
  getGithubToken: async () => 'tok-123',
  emit: jest.fn(),
  requestApproval: async () => 'allow' as const,
  execShell: async () => ({ stdout: '', stderr: '' }),
  ...over,
});

const repoJson = (name: string, login = 'example-org') => ({
  name,
  html_url: `https://github.com/${login}/${name}`,
  clone_url: `https://github.com/${login}/${name}.git`,
  owner: { login },
});

const alreadyExistsErr = () => {
  const err: any = new Error('Request failed with status code 422');
  err.response = { data: { errors: [{ message: 'name already exists on this account' }] } };
  return err;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ticket b1852d45 — token-manager deterministic primary account', () => {
  it('no-label: findFirst is deterministic (orderBy createdAt asc — first-connected = primary) and returns that row token', async () => {
    mockGhFindFirst.mockResolvedValue({ accessToken: 'enc-oldest', label: 'Personal' });
    const tok = await getValidToken('u1');
    expect(tok).toBe('dec:enc-oldest');
    expect(mockGhFindFirst).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(mockGhFindUnique).not.toHaveBeenCalled();
  });

  it('label: the explicit-account path is unchanged (findUnique on userId_label)', async () => {
    mockGhFindUnique.mockResolvedValue({ accessToken: 'enc-labeled' });
    const tok = await getValidToken('u1', 'Work');
    expect(tok).toBe('dec:enc-labeled');
    expect(mockGhFindUnique).toHaveBeenCalledWith({ where: { userId_label: { userId: 'u1', label: 'Work' } } });
    expect(mockGhFindFirst).not.toHaveBeenCalled();
  });
});

describe('ticket b1852d45 — ensureGithubRepoForBlank bootstrap hardening', () => {
  it('creates the private repo, mutates ctx, persists, and emits repo_created WITH owner + name', async () => {
    mockPost.mockResolvedValue({ data: repoJson('ericfoundation') });
    const ctx = makeCtx();
    const err = await ensureGithubRepoForBlank(ctx);
    expect(err).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost.mock.calls[0][1]).toMatchObject({ name: 'ericfoundation', private: true, auto_init: false });
    expect(ctx.provider).toBe('github');
    expect(ctx.repoUrl).toBe('https://github.com/example-org/ericfoundation.git');
    expect(ctx.emit).toHaveBeenCalledWith('repo_created', {
      url: 'https://github.com/example-org/ericfoundation',
      private: true,
      owner: 'example-org',
      name: 'ericfoundation',
    });
    expect(mockPersistProjectRepo).toHaveBeenCalledWith('proj-1', 'https://github.com/example-org/ericfoundation.git');
  });

  it('collision + existing repo EMPTY (409 on commits) → reuses it (no new repo, no suffix)', async () => {
    mockPost.mockRejectedValueOnce(alreadyExistsErr());
    mockGet.mockImplementation(async (url: string) => {
      if (url === 'https://api.github.com/user') return { data: { login: 'example-org' } };
      if (url.endsWith('/commits')) { const e: any = new Error('empty'); e.response = { status: 409 }; throw e; }
      return { data: repoJson('ericfoundation') };
    });
    const ctx = makeCtx();
    const err = await ensureGithubRepoForBlank(ctx);
    expect(err).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1); // no second creation attempt
    expect(ctx.repoUrl).toBe('https://github.com/example-org/ericfoundation.git');
    expect(ctx.emit).toHaveBeenCalledWith('repo_created', expect.objectContaining({ owner: 'example-org', name: 'ericfoundation' }));
  });

  it('collision + existing repo NON-EMPTY → does NOT hijack it — falls through to the session-suffixed name', async () => {
    mockPost
      .mockRejectedValueOnce(alreadyExistsErr())                    // slug collides
      .mockResolvedValueOnce({ data: repoJson(`ericfoundation-${SUFFIX}`) }); // suffixed creation succeeds
    mockGet.mockImplementation(async (url: string) => {
      if (url === 'https://api.github.com/user') return { data: { login: 'example-org' } };
      if (url.endsWith('/commits')) return { data: [{ sha: 'deadbeef' }] }; // non-empty
      return { data: repoJson('ericfoundation') };
    });
    const ctx = makeCtx();
    const err = await ensureGithubRepoForBlank(ctx);
    expect(err).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[0][1]).toMatchObject({ name: 'ericfoundation' });
    expect(mockPost.mock.calls[1][1]).toMatchObject({ name: `ericfoundation-${SUFFIX}` });
    expect(ctx.repoUrl).toBe(`https://github.com/example-org/ericfoundation-${SUFFIX}.git`);
    expect(ctx.emit).toHaveBeenCalledWith('repo_created', expect.objectContaining({ name: `ericfoundation-${SUFFIX}` }));
  });

  it('both candidates collide NON-EMPTY → clear user-facing error, ctx untouched, no emit, no persist', async () => {
    mockPost.mockRejectedValue(alreadyExistsErr());
    mockGet.mockImplementation(async (url: string) => {
      if (url === 'https://api.github.com/user') return { data: { login: 'example-org' } };
      if (url.endsWith('/commits')) return { data: [{ sha: 'deadbeef' }] };
      return { data: repoJson('ericfoundation') };
    });
    const ctx = makeCtx();
    const err = await ensureGithubRepoForBlank(ctx);
    expect(typeof err).toBe('string');
    expect(err).toContain('non-empty repo named');
    expect(err).toContain('Rename the conflicting repo');
    expect(ctx.provider).toBe('blank');
    expect(ctx.repoUrl).toBeUndefined();
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(mockPersistProjectRepo).not.toHaveBeenCalled();
  });

  it('no connected GitHub token → the connect-GitHub guidance, zero API calls', async () => {
    const ctx = makeCtx({ getGithubToken: async () => null });
    const err = await ensureGithubRepoForBlank(ctx);
    expect(err).toContain('No connected GitHub account/token');
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockGet).not.toHaveBeenCalled();
  });
});
