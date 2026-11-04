/**
 * FO firing 19 regression (prod run d2c9ad39 / session 356cea22, 2026-09-24
 * 22:00Z): a 'local'-provider project (repoUrl NULL by design — mirrors are
 * Digby-owned bare repos born in project-workspace ensureProvisioned, never
 * cloned from a remote) whose mirror directory is gone made ensureRepoMirror
 * run `git clone --mirror '' <mirror>` → "fatal: repository '' does not
 * exist" — the run failed with a cryptic cause and the session stayed
 * permanently unrunnable with no repair hint. The fix fails FAST with the
 * actionable truth when there is no remote to clone from and no mirror on
 * disk. REAL git against tmp dirs, same style as workspace-mirror-lock.test.ts.
 *
 * Also pins the unaffected paths: a mirror that EXISTS is still returned
 * (local mirrors are served from cache), and a project WITH a repoUrl still
 * clones normally.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-localmirror-'));
process.env.CODING_WORKSPACE_ROOT = ROOT;
const ENV_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'digby-ws-localmirror-envstore-'));
process.env.CODING_ENV_ROOT = ENV_ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), eval: jest.fn(async () => 1) },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ws = require('./workspace.service') as typeof import('./workspace.service');

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(ENV_ROOT, { recursive: true, force: true });
});

describe('ensureRepoMirror fails fast on a missing local mirror (FO firing 19)', () => {
  it('throws the actionable error — NOT a cryptic empty-clone fatal — when repoUrl is null and no mirror exists', async () => {
    await expect(ws.ensureRepoMirror('proj-local-dead', null as any, null))
      .rejects.toThrow(/no repoUrl and its local mirror is missing/);
    // and no half-created mirror directory is left behind
    expect(fs.existsSync(path.join(ROOT, 'repos', 'proj-local-dead.git'))).toBe(false);
  });

  it('treats an empty-string repoUrl identically (the authedUrl("") shape)', async () => {
    await expect(ws.ensureRepoMirror('proj-local-empty', '' as any, null))
      .rejects.toThrow(/no repoUrl and its local mirror is missing/);
  });

  it('still SERVES an existing local mirror with a null repoUrl (local mirrors are cache-served, never cloned)', async () => {
    // A local bare repo as it would be born in project-workspace ensureProvisioned
    const mirror = path.join(ROOT, 'repos', 'proj-local-live.git');
    fs.mkdirSync(mirror, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: mirror });
    const got = await ws.ensureRepoMirror('proj-local-live', null as any, null);
    expect(got).toBe(mirror);
    expect(fs.existsSync(mirror)).toBe(true);
  });

  it('still clones normally when a repoUrl IS present (github/git providers unaffected)', async () => {
    // The "remote" is a local bare repo passed by filesystem path (same trick
    // as workspace-mirror-lock.test.ts — ensureRepoMirror does not URL-validate).
    const remote = path.join(ROOT, 'remote.git');
    fs.mkdirSync(remote, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remote });
    const got = await ws.ensureRepoMirror('proj-remote-ok', remote, null);
    expect(got).toBe(path.join(ROOT, 'repos', 'proj-remote-ok.git'));
    expect(fs.existsSync(path.join(got, 'HEAD'))).toBe(true);
  });
});
