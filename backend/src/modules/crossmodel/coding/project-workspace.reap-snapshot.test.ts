/**
 * snapshotBeforeReap against a REAL git repo (review of #1768, 2026-10-19):
 * the reaper deletes a worktree only when its uncommitted work is safely
 * committed. The old code swallowed add/commit failures and deleted anyway.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./workspace.service', () => {
  const { execFile } = jest.requireActual('child_process');
  const { promisify } = jest.requireActual('util');
  const run = promisify(execFile);
  return {
    __esModule: true,
    git: async (args: string[], cwd?: string) => {
      const { stdout, stderr } = await run('git', args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
  };
});

import { snapshotBeforeReap } from './project-workspace.service';

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-snap-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir, env });
  return dir;
}

describe('snapshotBeforeReap (real git)', () => {
  it('clean tree → clean', async () => {
    const dir = repo();
    expect(await snapshotBeforeReap(dir, 'wip')).toBe('clean');
  });

  it('dirty tree with NO git identity configured → saved (explicit identity), tree clean after', async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\n');
    expect(await snapshotBeforeReap(dir, 'wip: test')).toBe('saved');
    const log = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: dir }).toString().trim();
    expect(log).toBe('wip: test');
  });

  it('a commit blocked by a failing pre-commit hook still lands (--no-verify)', async () => {
    const dir = repo();
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'three\n');
    expect(await snapshotBeforeReap(dir, 'wip')).toBe('saved');
  });

  it('a directory that is not a git worktree → unknown', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reap-nogit-'));
    expect(await snapshotBeforeReap(dir, 'wip')).toBe('unknown');
  });
});
