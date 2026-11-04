/**
 * Program-truth reader (remediation P7, spark G16) — readProgramState reads
 * `.digby/rules/00-current-state.md` from the bare mirror's default branch:
 * bounded 4k, 30-min Redis cache ('' caches the absent case), fail-open null,
 * and — load-bearing for the jest graphs — the mirror-existence probe runs
 * BEFORE any Redis touch.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The digest module statically imports prisma/utility-llm/fleet.service — stub
// the boundaries exactly like project-digest.service.test.ts does.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('./fleet.service', () => ({ __esModule: true, getSidebarHiddenFleetArtifacts: jest.fn(async () => new Set()) }));
jest.mock('../cron.service', () => ({ __esModule: true, CRON_LEASE_MS: 60_000 }));

const mockRepoMirrorPath = jest.fn((projectId: string) => `/definitely/missing/${projectId}`);
const mockGit = jest.fn(async (..._a: any[]): Promise<any> => ({ stdout: '', stderr: '' }));
jest.mock('../coding/workspace.service', () => ({
  __esModule: true,
  repoMirrorPath: (...a: any[]) => mockRepoMirrorPath(...(a as [string])),
  git: (...a: any[]) => mockGit(...a),
}));

const mockRedisGet = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRedisSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: (...a: any[]) => mockRedisGet(...a), set: (...a: any[]) => mockRedisSet(...a) },
}));

import * as os from 'os';
import { readProgramState, PROGRAM_STATE_CACHE_KEY, PROGRAM_STATE_MAX_CHARS, PROGRAM_STATE_CACHE_SEC } from './project-digest.service';

beforeEach(() => {
  jest.clearAllMocks();
  mockRepoMirrorPath.mockImplementation((projectId: string) => `/definitely/missing/${projectId}`);
  mockRedisGet.mockResolvedValue(null);
  mockGit.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('readProgramState (G16)', () => {
  it('no mirror ⇒ null, and Redis is NEVER touched (the jest-graph contract)', async () => {
    expect(await readProgramState('p-nomirror')).toBeNull();
    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockGit).not.toHaveBeenCalled();
  });

  it('reads the doc from the mirror default branch (origin ref first), bounds it, and caches 30 min', async () => {
    mockRepoMirrorPath.mockReturnValue(os.tmpdir()); // an existing dir stands in for the mirror
    mockGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'show' && args[1] === 'refs/remotes/origin/main:.digby/rules/00-current-state.md') {
        return { stdout: `# Current state\nPhase 2 of 3 — training run live.\n${'x'.repeat(5000)}`, stderr: '' };
      }
      throw new Error('no such ref');
    });
    const out = await readProgramState('p1');
    expect(out).toContain('Phase 2 of 3');
    expect(out!.length).toBeLessThanOrEqual(PROGRAM_STATE_MAX_CHARS);
    expect(mockRedisSet).toHaveBeenCalledWith(PROGRAM_STATE_CACHE_KEY('p1'), out, { EX: PROGRAM_STATE_CACHE_SEC });
  });

  it('falls back to the bare local branch ref when no origin ref exists', async () => {
    mockRepoMirrorPath.mockReturnValue(os.tmpdir());
    mockGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'show' && args[1] === 'main:.digby/rules/00-current-state.md') return { stdout: 'local-branch doc', stderr: '' };
      throw new Error('no such ref');
    });
    expect(await readProgramState('p1')).toBe('local-branch doc');
  });

  it("caches the ABSENT case as '' (no re-read storm) and serves cache hits without git", async () => {
    mockRepoMirrorPath.mockReturnValue(os.tmpdir());
    mockGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' };
      throw new Error('file not on any ref');
    });
    expect(await readProgramState('p1')).toBeNull();
    expect(mockRedisSet).toHaveBeenCalledWith(PROGRAM_STATE_CACHE_KEY('p1'), '', { EX: PROGRAM_STATE_CACHE_SEC });
    // Cache hit: '' means "known absent" — null, no git calls.
    mockGit.mockClear();
    mockRedisGet.mockResolvedValue('');
    expect(await readProgramState('p1')).toBeNull();
    expect(mockGit).not.toHaveBeenCalled();
    // Cache hit with content.
    mockRedisGet.mockResolvedValue('cached doc');
    expect(await readProgramState('p1')).toBe('cached doc');
  });

  it('a Redis outage degrades to a cacheless read (never a throw)', async () => {
    mockRepoMirrorPath.mockReturnValue(os.tmpdir());
    mockRedisGet.mockRejectedValue(new Error('redis down'));
    mockGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'show') return { stdout: 'doc body', stderr: '' };
      throw new Error('nope');
    });
    expect(await readProgramState('p1')).toBe('doc body');
  });
});
