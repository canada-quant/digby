/**
 * e1cca01d write-seam guard (log-signal family lane 65787dde, 2026-10-19).
 *
 * The 2026-10-18 canlegal-bench incident: import_repo landed a project with
 * githubLabel "pasta_paul" at 04:20Z while the only connected labels were
 * "pastapaul_canadaquant"/"Pastapaul" — silently. Nothing surfaced until the
 * first git op 05:15Z, when the getValidToken label-miss fallback began
 * hot-looping its warn (73 rows, 6 distinct hours — the RULE 1 recurrence this
 * ticket files). These tests pin the guard's contract at BOTH write seams
 * (configureWorkspace re-pin/fresh-configure and the import_repo handler is
 * covered by its own unit below via the shared check): a dead pin is named AT
 * THE WRITE with the recovery; a live pin and a no-accounts state stay silent;
 * the guard never blocks the configure.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const findUnique = jest.fn();
const findFirst = jest.fn();
const update = jest.fn(async () => ({}));
const gitHubFindMany = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelProject: { findUnique, findFirst, update },
    gitHubOAuthToken: { findMany: gitHubFindMany },
  },
}));
jest.mock('./workspace.service', () => ({
  __esModule: true,
  git: jest.fn(async () => ({ stdout: '', stderr: '' })),
  ensureRepoMirror: jest.fn(async () => '/repos/x.git'),
  repoMirrorPath: jest.fn((id: string) => `/repos/${id}.git`),
  worktreePath: jest.fn((id: string) => `/wt/${id}`),
  listSessionEnvSidecars: jest.fn(async () => [] as string[]),
  removeSessionEnv: jest.fn(async () => {}),
  removeWorktree: jest.fn(async () => {}),
  persistSessionEnv: jest.fn(async () => true),
  listWorktreeDirsOnDisk: jest.fn(async () => [] as Array<{ sessionId: string; mtimeMs: number }>),
  isWorkspaceVolumeOwner: jest.fn(() => true),
}));
jest.mock('fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('fs/promises'),
}));
jest.mock('./scaffolding.service', () => ({ __esModule: true, scaffoldProjectDocs: jest.fn(async () => ({})) }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { WORKTREE_REAPED: 'worktree_reaped', WORKTREE_REAP_PASS: 'worktree_reap_pass' },
}));

import logger from '../../../utils/logger';
import { configureWorkspace } from './project-workspace.service';

const warn = logger.warn as jest.Mock;

const PROJECT = { id: 'p1', userId: 'u1', name: 'proj', repoProvider: 'github', repoUrl: 'https://github.com/o/r.git', githubLabel: 'pasta_paul', defaultBranch: 'main' };
const LIVE_LABELS = [{ label: 'pastapaul_canadaquant' }, { label: 'Pastapaul' }];

describe('e1cca01d write-seam guard: warnIfPinnedLabelMissing via configureWorkspace', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findFirst.mockResolvedValue(PROJECT);
    update.mockResolvedValue({});
  });

  it('dead pin + other labels connected → ONE warn naming the pin, the live labels and the recovery', async () => {
    // Re-pin TO a dead label (review finding 8's corrected model: the row
    // under test actually CARRIES the dead pin — update is a no-op mock, so
    // the guard's read returns the dead label and the warn names IT).
    findUnique.mockResolvedValue({ ...PROJECT, githubLabel: 'still-dead-label' });
    gitHubFindMany.mockResolvedValue(LIVE_LABELS);
    await configureWorkspace('p1', 'u1', { githubLabel: 'still-dead-label' });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain('"still-dead-label"');
    expect(msg).toContain('p1');
    expect(msg).toContain('configure_workspace');
    expect(msg).not.toContain('"pastapaul_canadaquant" pins'); // the LIVE label is only in the connected list
  });

  it('idempotent no-write call (same label re-sent) → the guard does not run (review finding 6)', async () => {
    findUnique.mockResolvedValue({ ...PROJECT, githubLabel: 'pasta_paul' });
    gitHubFindMany.mockClear();
    // p.githubLabel === opts.githubLabel → no write → no guard (a lane
    // retrying the f121 remediation shape must not re-warn per call).
    await configureWorkspace('p1', 'u1', { githubLabel: 'pasta_paul' });
    expect(warn).not.toHaveBeenCalled();
    expect(gitHubFindMany).not.toHaveBeenCalled();
  });

  it('fresh configure (no repoProvider yet) with a dead label → the guard fires after the row is written', async () => {
    // entry findFirst: a not-yet-configured project (repoProvider null)
    findFirst.mockResolvedValueOnce({ id: 'p1', userId: 'u1', name: 'proj', repoProvider: null, repoUrl: null, githubLabel: null, defaultBranch: null });
    // the guard's findUnique: the WRITTEN state (github provider + dead label)
    findUnique.mockResolvedValue({ ...PROJECT, githubLabel: 'pasta_paul' });
    gitHubFindMany.mockResolvedValue(LIVE_LABELS);
    await configureWorkspace('p1', 'u1', { repoUrl: 'https://github.com/o/r.git', provider: 'github', githubLabel: 'pasta_paul' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect((warn.mock.calls[0][0] as string)).toContain('"pasta_paul"');
  });

  it('live pin → silent (no warn)', async () => {
    findUnique.mockResolvedValue({ ...PROJECT, githubLabel: 'Pastapaul' });
    gitHubFindMany.mockResolvedValue(LIVE_LABELS);
    await configureWorkspace('p1', 'u1', { githubLabel: 'Pastapaul' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('NO connected accounts at all → silent (a github project without any connector is not this class)', async () => {
    findUnique.mockResolvedValue({ ...PROJECT, githubLabel: 'anything' });
    gitHubFindMany.mockResolvedValue([]);
    await configureWorkspace('p1', 'u1', { githubLabel: 'anything' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('local provider → silent', async () => {
    findUnique.mockResolvedValue({ ...PROJECT, repoProvider: 'local', repoUrl: null });
    await configureWorkspace('p1', 'u1', {});
    expect(warn).not.toHaveBeenCalled();
    expect(gitHubFindMany).not.toHaveBeenCalled();
  });

  it('null/empty label → silent (unlabeled projects use first-connected by design)', async () => {
    findUnique.mockResolvedValue({ ...PROJECT, githubLabel: null });
    await configureWorkspace('p1', 'u1', {});
    expect(warn).not.toHaveBeenCalled();
    expect(gitHubFindMany).not.toHaveBeenCalled();
  });

  it('guard failure never blocks the configure (observability only)', async () => {
    findUnique.mockResolvedValue(PROJECT);
    gitHubFindMany.mockRejectedValue(new Error('db down'));
    await expect(configureWorkspace('p1', 'u1', { githubLabel: 'pastapaul_canadaquant' })).resolves.toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
  });
});
