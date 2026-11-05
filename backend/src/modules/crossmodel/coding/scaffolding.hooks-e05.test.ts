/**
 * E05 (docs/FRAMEWORK_BACKLOG.md) — "harness roadmap #2 repo-level tool hooks:
 * shipped, never exercised". `coding/repo-hooks.ts` shipped 2026-09-19 and
 * recorded ZERO `repo_hook` loop_metrics rows all-time, because no project ever
 * had a `hooks` section: `loadRepoHooks` reads one, and the scaffold never
 * wrote one.
 *
 * This suite is the gate for the fix. It is deliberately END-TO-END rather than
 * a shape assertion: a real temp worktree is scaffolded, the emitted
 * `.digby/config.json` is read back through the REAL `loadRepoHooks` (no mock of
 * `readDigbyConfig`), and the REAL `runPostEditHooks` runs a REAL executable
 * through a REAL shell. The assertion is that the formatter binary actually ran
 * and the `repo_hook` metric row was written — the exact artifact whose absence
 * defined the backlog entry.
 *
 * The negative half is pinned too: a repo that does not own the tooling gets NO
 * `hooks` key, so the pre-E05 config stays byte-identical and a scaffold can
 * never emit a hook that fails on every edit.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// repo-hooks → loop-metrics → config/database → config/env (exits without env vars).
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockMetric(...a),
}));

import { exec } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

import { detectStack, renderConfigJson, renderStarterHooks, scaffoldProjectDocs } from './scaffolding.service';
import { loadRepoHooks, runPostEditHooks, __resetRepoHooksForTests } from './repo-hooks';

const execP = promisify(exec);
const realShell = async (command: string, cwd?: string, timeoutMs = 20_000) =>
  execP(command, { cwd, timeout: timeoutMs, shell: '/bin/bash' });

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'digby-e05-'));
}

/**
 * A worktree that OWNS a formatter the way the detector requires: declared at
 * the ROOT manifest AND its binary present at `./node_modules/.bin`. The binary
 * is a real shell script that rewrites the file and leaves a marker, so the
 * test observes the hook's actual effect, not just its note.
 */
async function nodeRepoWithLocalPrettier(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: { next: '^16.0.0' },
    devDependencies: { typescript: '^5.4.0', prettier: '^3.7.4' },
    scripts: { build: 'next build', test: 'jest', lint: 'eslint .' },
  }, null, 2));
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  await fs.writeFile(path.join(dir, 'tsconfig.json'), '{}');
  await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  const bin = path.join(dir, 'node_modules', '.bin', 'prettier');
  await fs.writeFile(bin, `#!/bin/bash\n# stub formatter: prove the hook really ran\nfor a in "$@"; do f="$a"; done\nprintf '// formatted\\n' > "$f"\necho "formatted 1 file"\n`);
  await fs.chmod(bin, 0o755);
}

beforeEach(() => { jest.clearAllMocks(); __resetRepoHooksForTests(); });

describe('E05: starter hooks are GATED on tooling the repo actually owns', () => {
  test('no detected tooling → no hooks key at all (pre-E05 config, byte-identical)', async () => {
    expect(renderStarterHooks({})).toBeUndefined();
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'go.mod'), 'module x\n');
    const stack = await detectStack(dir);
    expect(stack.hooks).toBeUndefined();
    const cfg = JSON.parse(renderConfigJson('main', stack));
    expect(cfg).not.toHaveProperty('hooks');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a devDependency declared only in a WORKSPACE PACKAGE earns no root hook (the monorepo trap)', async () => {
    const dir = await tmpDir();
    // Root owns neither; backend/ declares both — a root-relative ./node_modules/.bin
    // hook would fail on every edit here, which is exactly what must not ship.
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
      devDependencies: { typescript: '^5.4.0' }, scripts: { build: 'tsc' },
    }));
    await fs.mkdir(path.join(dir, 'backend'), { recursive: true });
    await fs.writeFile(path.join(dir, 'backend', 'package.json'), JSON.stringify({
      devDependencies: { prettier: '^3.7.4', eslint: '^9.39.2' },
    }));
    await fs.mkdir(path.join(dir, 'backend', 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(dir, 'backend', 'node_modules', '.bin', 'prettier'), '#!/bin/bash\n');
    await fs.mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true });

    const stack = await detectStack(dir);
    expect(stack.hooks).toBeUndefined();
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('root-declared + locally resolvable formatter earns ONE postEdit hook, local binary only', async () => {
    const dir = await tmpDir();
    await nodeRepoWithLocalPrettier(dir);
    const stack = await detectStack(dir);
    expect(stack.hooks?.postEdit).toHaveLength(1);
    const hook = stack.hooks!.postEdit![0] as { run: string; match: string; timeoutMs: number };
    expect(hook.run).toBe('./node_modules/.bin/prettier --write {file}');
    // LOCAL binary only — no npx/dlx/bunx, which fetch on a miss and would make
    // an edit-time hook depend on the network.
    expect(hook.run).not.toMatch(/\b(npx|bunx|dlx)\b/);
    expect(hook.match).toContain('{ts,tsx,js,jsx');
    // Never a blocking shape: a scaffold writes postEdit only; preCommand stays
    // the project's own opt-in.
    expect(stack.hooks).not.toHaveProperty('preCommand');
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('build files (lock/manifest) are NOT formatted — the match glob excludes them on purpose', async () => {
    const dir = await tmpDir();
    await nodeRepoWithLocalPrettier(dir);
    const stack = await detectStack(dir);
    const { fileMatches } = await import('./repo-hooks');
    const match = (stack.hooks!.postEdit![0] as { match: string }).match;
    expect(fileMatches('src/app.ts', match)).toBe(true);
    expect(fileMatches('package-lock.json', match)).toBe(false);
    expect(fileMatches('src/app.tsx', match)).toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('E05 GATE: a scaffolded config makes the shipped hook path FIRE (end to end)', () => {
  test('scaffold → real loadRepoHooks → real runPostEditHooks → formatter ran + repo_hook metric recorded', async () => {
    const dir = await tmpDir();
    await nodeRepoWithLocalPrettier(dir);

    // 1. The real scaffold writes the framework (no commit; hermetic).
    const r = await scaffoldProjectDocs(dir, { projectName: 'e05-proj', defaultBranch: 'main', commit: false });
    expect(r.wroteFramework).toBe(true);
    const written = JSON.parse(await fs.readFile(path.join(dir, '.digby', 'config.json'), 'utf8'));
    expect(written.hooks).toBeDefined();
    expect(Array.isArray(written.hooks.postEdit)).toBe(true);
    expect(written.hooks.postEdit.length).toBe(1);

    // 2. The shipped loader reads it back — no mock, real file, real memo.
    const hooks = await loadRepoHooks(dir);
    expect(hooks.postEdit).toHaveLength(1);
    expect(hooks.postEdit[0].match).toContain('{ts,tsx,js,jsx');

    // 3. The shipped runner executes it through a REAL shell against a REAL file.
    const target = path.join(dir, 'src');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'app.ts'), 'export const x=1\n');

    const note = await runPostEditHooks(realShell, dir, hooks, 'src/app.ts', 'sess-e05');

    expect(note).toContain('[post-edit hook]');
    expect(note).toContain('→ ok');
    // The formatter really rewrote the file — this is the end-to-end proof, not
    // a string match on the note.
    expect(await fs.readFile(path.join(target, 'app.ts'), 'utf8')).toBe('// formatted\n');

    // 4. The artifact whose absence DEFINED the backlog entry: the metric row.
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'repo_hook',
      sessionId: 'sess-e05',
      meta: expect.objectContaining({ kind: 'postEdit', ok: true, file: 'src/app.ts' }),
    }));

    await fs.rm(dir, { recursive: true, force: true });
  });

  test('a hook that fails is reported, never thrown, and still records its row (a broken project hook cannot break a lane)', async () => {
    const dir = await tmpDir();
    await nodeRepoWithLocalPrettier(dir);
    // Break the binary AFTER detection: the hook must degrade to a reported note.
    await fs.writeFile(path.join(dir, 'node_modules', '.bin', 'prettier'), '#!/bin/bash\necho "boom: cannot format" >&2\nexit 1\n');
    const hooks = { postEdit: [{ run: './node_modules/.bin/prettier --write {file}', match: '**/*.ts', timeoutMs: 10_000 }], preCommand: [] };
    const note = await runPostEditHooks(realShell, dir, hooks, 'a.ts', 'sess-fail');
    expect(note).toContain('→ FAILED');
    expect(note).toContain('boom: cannot format');
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'repo_hook', meta: expect.objectContaining({ ok: false }),
    }));
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('E05: the scaffolded AGENTS.md tells lanes the section exists', () => {
  test('the brief names the hooks section, both kinds, and that it is the repo\'s own rule', async () => {
    const dir = await tmpDir();
    await nodeRepoWithLocalPrettier(dir);
    const r = await scaffoldProjectDocs(dir, { projectName: 'e05-doc', defaultBranch: 'main', commit: false });
    expect(r.wroteAgentsMd).toBe(true);
    const md = await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('`hooks`');
    expect(md).toContain('postEdit');
    expect(md).toContain('preCommand');
    expect(md).toContain('repo-hooks.ts');
    await fs.rm(dir, { recursive: true, force: true });
  });
});