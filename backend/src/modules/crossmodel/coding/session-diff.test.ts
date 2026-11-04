/**
 * audit 2026-10-06 T5-6 (litellm F3): readWorktreeDiff / sessionDiffForUser —
 * a FAILED git read is source 'error' (never an empty = clean tree), and the
 * read names HEAD + ahead/behind the upstream. Kill switch
 * SESSION_DIFF_ERROR_STATE_DISABLED=1 restores the swallow-to-empty read.
 */
const mockGit: jest.Mock = jest.fn();
jest.mock('./workspace.service', () => ({
  __esModule: true,
  worktreePath: (id: string) => `/wt/${id}`,
  git: (...a: any[]) => mockGit(...a),
}));
jest.mock('./coding-data.service', () => ({
  __esModule: true,
  getSessionForUser: jest.fn(async (id: string) => ({ id, branch: 'digby/session-x', worktreePath: `/wt/${id}` })),
}));
const mockRemote: jest.Mock = jest.fn(async () => null);
jest.mock('./worktree-remote-read', () => ({ __esModule: true, requestRemoteWorktreeDiff: (...a: any[]) => mockRemote(...a) }));
jest.mock('fs/promises', () => ({ __esModule: true, stat: jest.fn(async () => ({ isDirectory: () => true })) }));

import { readWorktreeDiff, sessionDiffForUser } from './session-diff';

/** Route git(args) by its first arguments. */
function gitRoutes(routes: Record<string, string | Error>) {
  mockGit.mockImplementation(async (args: string[]) => {
    const key = args.join(' ');
    for (const [k, v] of Object.entries(routes)) {
      if (key.startsWith(k)) {
        if (v instanceof Error) throw v;
        return { stdout: v, stderr: '' };
      }
    }
    throw Object.assign(new Error(`unrouted git ${key}`), { stderr: 'fatal: no upstream' });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SESSION_DIFF_ERROR_STATE_DISABLED;
});

describe('audit 2026-10-06 T5-6 — readWorktreeDiff', () => {
  it('a failing git status is an ERROR, never an empty (clean) read', async () => {
    gitRoutes({ 'status': Object.assign(new Error('Command failed'), { stderr: "fatal: detected dubious ownership in repository at '/wt/s1'" }), 'diff': '' });
    const d = await readWorktreeDiff('/wt/s1');
    expect(d.error).toContain('git status: fatal: detected dubious ownership');
    expect(d.status).toBe('');
    const s = await sessionDiffForUser('s1', 'u1');
    expect(s).toMatchObject({ source: 'error', branch: 'digby/session-x' });
    expect(s!.error).toContain('dubious ownership');
  });

  it('a healthy read carries HEAD, the upstream and ahead/behind', async () => {
    gitRoutes({ 'status': ' M a.ts\n', 'diff': ' a.ts | 2 +-', 'rev-parse HEAD': 'abc123\n', 'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/digby/session-x\n', 'rev-list --left-right --count': '3\t1\n' });
    const s = await sessionDiffForUser('s1', 'u1');
    expect(s).toEqual({ branch: 'digby/session-x', status: ' M a.ts\n', diffStat: ' a.ts | 2 +-', source: 'disk', head: 'abc123', upstream: 'origin/digby/session-x', ahead: 3, behind: 1 });
  });

  it('no @{u}: falls back to origin/<branch> when it exists, else upstream null (never pushed) — not an error', async () => {
    gitRoutes({ 'status': '', 'diff': '', 'rev-parse HEAD': 'abc123\n', 'rev-parse --abbrev-ref HEAD': 'digby/session-x\n', 'rev-parse --verify --quiet refs/remotes/origin/digby/session-x': 'deadbeef\n', 'rev-list --left-right --count HEAD...origin/digby/session-x': '0\t0\n' });
    expect(await readWorktreeDiff('/wt/s1')).toMatchObject({ head: 'abc123', upstream: 'origin/digby/session-x', ahead: 0, behind: 0 });
    gitRoutes({ 'status': '', 'diff': '', 'rev-parse HEAD': 'abc123\n', 'rev-parse --abbrev-ref HEAD': 'digby/session-x\n' });
    const d = await readWorktreeDiff('/wt/s1');
    expect(d.error).toBeUndefined();
    expect(d).toMatchObject({ head: 'abc123', upstream: null, ahead: null, behind: null });
  });

  it("a remote reply carrying the box's git error is source 'error' too", async () => {
    const fsp = require('fs/promises');
    fsp.stat.mockResolvedValueOnce(null);
    mockRemote.mockResolvedValueOnce({ id: 'r', ok: true, path: '', content: '', diff: { status: '', diffStat: '', error: 'git status: fatal: not a git repository' } });
    expect(await sessionDiffForUser('s1', 'u1')).toMatchObject({ source: 'error', error: 'git status: fatal: not a git repository' });
  });

  it('kill switch SESSION_DIFF_ERROR_STATE_DISABLED=1: the failed read swallows to empty (the legacy clean-looking shape)', async () => {
    process.env.SESSION_DIFF_ERROR_STATE_DISABLED = '1';
    gitRoutes({ 'status': new Error('boom'), 'diff': new Error('boom') });
    expect(await readWorktreeDiff('/wt/s1')).toEqual({ status: '', diffStat: '' });
    expect(await sessionDiffForUser('s1', 'u1')).toEqual({ branch: 'digby/session-x', status: '', diffStat: '', source: 'disk' });
  });
});
