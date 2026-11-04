/**
 * Remediation P0 — `scaffold_commit_failed` emission: scaffoldProjectDocs
 * writes AGENTS.md + .digby/ into a real temp worktree, then commits; when the
 * commit fails (git identity missing, hook rejection, read-only checkout) the
 * scaffold silently survived only as a warn log. Now it also emits ONE
 * loop_metrics row per failed commit lane so the failure rate is chartable.
 *
 * Real fs (temp dir), workspace.service `git` mocked at the boundary.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGit: jest.Mock = jest.fn();
jest.mock('./workspace.service', () => ({
  __esModule: true,
  git: (...a: any[]) => mockGit(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { SCAFFOLD_COMMIT_FAILED: 'scaffold_commit_failed' },
}));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { scaffoldProjectDocs } from './scaffolding.service';

let worktree: string;

beforeEach(async () => {
  jest.clearAllMocks();
  worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'scaffold-p0-'));
});

describe('scaffold_commit_failed emission (remediation P0)', () => {
  it('a failing `git commit` emits ONE row with lane scaffold + project + error', async () => {
    mockGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'commit') throw new Error('empty ident name (for <>) not allowed');
      return { stdout: '', stderr: '' };
    });
    const res = await scaffoldProjectDocs(worktree, { projectName: 'p0-proj', commit: true });
    expect(res.scaffolded).toBe(true);
    expect(res.committed).toBe(false); // the failure this telemetry observes
    const rows = mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'scaffold_commit_failed');
    expect(rows).toHaveLength(1);
    expect(rows[0][0].meta).toMatchObject({ project: 'p0-proj', lane: 'scaffold' });
    expect(rows[0][0].meta.error).toContain('empty ident');
  });

  it('a successful commit emits nothing', async () => {
    mockGit.mockResolvedValue({ stdout: '', stderr: '' });
    const res = await scaffoldProjectDocs(worktree, { projectName: 'p0-proj', commit: true });
    expect(res.committed).toBe(true);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('commit:false (caller defers committing) emits nothing', async () => {
    const res = await scaffoldProjectDocs(worktree, { projectName: 'p0-proj', commit: false });
    expect(res.scaffolded).toBe(true);
    expect(mockGit).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });
});
