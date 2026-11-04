jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// loop-metrics.service imports config/database → config/env, which exits without env vars.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockReadConfig = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('./verify.service', () => ({ __esModule: true, readDigbyConfig: (...a: any[]) => mockReadConfig(...a) }));
const mockMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockMetric(...a),
}));

import {
  globToRegExp, fileMatches, parseRepoHooks, preCommandBlock, runPostEditHooks, loadRepoHooks, __resetRepoHooksForTests,
  REPO_HOOKS_MAX, REPO_HOOK_MAX_TIMEOUT_MS, REPO_HOOK_DEFAULT_TIMEOUT_MS,
} from './repo-hooks';

beforeEach(() => { jest.clearAllMocks(); __resetRepoHooksForTests(); });

describe('glob subset', () => {
  it('handles **, *, ?, {a,b} and basename-only patterns', () => {
    expect(globToRegExp('**/*.{ts,tsx}').test('backend/src/a.ts')).toBe(true);
    expect(globToRegExp('**/*.{ts,tsx}').test('a.tsx')).toBe(true);
    expect(globToRegExp('**/*.{ts,tsx}').test('a.js')).toBe(false);
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false);
    expect(globToRegExp('file?.md').test('file1.md')).toBe(true);
    expect(fileMatches('./frontend/app/x.tsx', '*.tsx')).toBe(true); // no slash → basename
    expect(fileMatches('frontend/app/x.tsx', 'backend/**')).toBe(false);
    expect(fileMatches('anything.py', undefined)).toBe(true);
  });
});

describe('parseRepoHooks', () => {
  it('validates, bounds and defaults; drops junk; compiles block patterns (substring or /regex/)', () => {
    const raw = {
      postEdit: [
        { run: 'npx prettier --write {file}', match: '**/*.ts', timeoutMs: 999_999 },
        { run: '', match: '*' }, { run: 'x'.repeat(600) }, { run: 'ok-cmd' }, 'junk',
        ...Array.from({ length: 10 }, (_, i) => ({ run: `extra-${i}` })),
      ],
      preCommand: [
        { block: 'git push --force', message: 'No force pushes.' },
        { block: '/rm\\s+-rf\\s+\\//', message: 'No root rm.' },
        { block: '' }, { block: '/[unclosed/' }, { block: 'sudo' },
      ],
    };
    const h = parseRepoHooks(raw);
    expect(h.postEdit).toHaveLength(REPO_HOOKS_MAX);
    expect(h.postEdit[0]).toEqual({ run: 'npx prettier --write {file}', match: '**/*.ts', timeoutMs: REPO_HOOK_MAX_TIMEOUT_MS });
    expect(h.postEdit[1]).toEqual({ run: 'ok-cmd', match: undefined, timeoutMs: REPO_HOOK_DEFAULT_TIMEOUT_MS });
    expect(h.preCommand.map((p) => p.block)).toEqual(['git push --force', '/rm\\s+-rf\\s+\\//', 'sudo']);
    expect(h.preCommand[2].message).toContain('matches this project');
    expect(parseRepoHooks(null)).toEqual({ postEdit: [], preCommand: [] });
    expect(parseRepoHooks({ postEdit: 'nope' })).toEqual({ postEdit: [], preCommand: [] });
  });
});

describe('preCommandBlock', () => {
  it("refuses a matching command with the project's own message; substring matching is case-insensitive; regex form honoured", () => {
    const h = parseRepoHooks({ preCommand: [{ block: 'git push --force', message: 'No force pushes.' }, { block: '/rm\\s+-rf\\s+\\//', message: 'No root rm.' }] });
    expect(preCommandBlock(h, 'GIT PUSH --FORCE origin main')).toContain('No force pushes.');
    expect(preCommandBlock(h, 'rm -rf /')).toContain('No root rm.');
    expect(preCommandBlock(h, 'rm -rf ./dist')).toBeNull();
    expect(preCommandBlock(h, 'git push origin HEAD')).toBeNull();
    expect(preCommandBlock(h, 'git push --force origin main')!.startsWith('[command REFUSED')).toBe(true);
  });
});

describe('runPostEditHooks', () => {
  const shell = (calls: string[], exit = 0, out = 'formatted 1 file') => async (command: string) => { calls.push(command); return { stdout: `${out}\n__DIGBY_EXIT__ ${exit}`, stderr: '' }; };

  it('runs every matching hook with {file} shell-quoted, appends ok notes, records a metric per hook', async () => {
    const calls: string[] = [];
    const h = parseRepoHooks({ postEdit: [{ run: 'npx prettier --write {file}', match: '**/*.ts' }, { run: 'echo never', match: '**/*.py' }] });
    const note = await runPostEditHooks(shell(calls), '/wt', h, "./src/it's.ts", 'sess-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`npx prettier --write 'src/it'\\''s.ts'; echo "__DIGBY_EXIT__ $?"`);
    expect(note).toContain('[post-edit hook] npx prettier --write {file} → ok');
    expect(note).toContain('formatted 1 file');
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'repo_hook', sessionId: 'sess-1', meta: expect.objectContaining({ kind: 'postEdit', ok: true }) }));
  });

  it('a failing hook is reported with its output tail, never thrown; no matching hook → empty note', async () => {
    const calls: string[] = [];
    const h = parseRepoHooks({ postEdit: [{ run: 'eslint --fix {file}' }] });
    const note = await runPostEditHooks(shell(calls, 1, '3:1 error no-unused-vars'), '/wt', h, 'a.ts');
    expect(note).toContain('→ FAILED');
    expect(note).toContain('3:1 error no-unused-vars');
    expect(await runPostEditHooks(shell(calls), '/wt', parseRepoHooks({ postEdit: [{ run: 'x', match: '*.py' }] }), 'a.ts')).toBe('');
    const boom = async () => { throw new Error('exec died'); };
    expect(await runPostEditHooks(boom, '/wt', h, 'a.ts')).toContain('exec died');
  });
});

describe('loadRepoHooks', () => {
  it('reads .digby/config.json hooks, memoizes per worktree, and returns empty when unconfigured', async () => {
    mockReadConfig.mockResolvedValue({ hooks: { preCommand: [{ block: 'sudo', message: 'no sudo' }] } });
    const a = await loadRepoHooks('/wt');
    expect(a.preCommand).toHaveLength(1);
    await loadRepoHooks('/wt');
    expect(mockReadConfig).toHaveBeenCalledTimes(1); // memoized
    mockReadConfig.mockResolvedValue({ commands: {} });
    expect((await loadRepoHooks('/other')).preCommand).toEqual([]);
  });
});
