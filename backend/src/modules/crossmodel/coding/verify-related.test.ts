jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockMetric(...a), LOOP_METRIC_KINDS: { VERIFY_RELATED: 'verify_related' } }));

import { deriveRelatedTestCommand, listChangedFiles, parsePackageScript, packageScriptReader, RELATED_MAX_FILES, RELATED_STAGE_KEY } from './verify-related';
import { runVerifyChain } from './verify.service';

beforeEach(() => { mockMetric.mockReset(); });

describe('deriveRelatedTestCommand', () => {
  it('scopes a cd-prefixed jest command to the changed files inside that directory, quoted, relative to it', async () => {
    expect(await deriveRelatedTestCommand('cd backend && npx jest', ['backend/src/a.ts', "backend/src/it's.test.ts", 'frontend/app/x.tsx', 'README.md', './backend/src/a.ts']))
      .toBe("cd backend && npx jest --findRelatedTests 'src/a.ts' 'src/it'\\''s.test.ts' --passWithNoTests");
    expect(await deriveRelatedTestCommand('npx jest --ci', ['src/a.ts'])).toBe("npx jest --ci --findRelatedTests 'src/a.ts' --passWithNoTests");
    expect(await deriveRelatedTestCommand('cd frontend && npx vitest run', ['frontend/lib/x.ts'])).toBe("cd frontend && npx vitest related 'lib/x.ts' run --run --passWithNoTests");
  });
  it('derives nothing for chains, other runners, already-scoped commands, no in-scope files, or too many files', async () => {
    expect(await deriveRelatedTestCommand('cd a && npx jest && cd ../b && npx jest', ['a/x.ts'])).toBeNull();
    expect(await deriveRelatedTestCommand('pytest -q', ['pkg/a.py'])).toBeNull();
    expect(await deriveRelatedTestCommand('npx jest --onlyChanged', ['a.ts'])).toBeNull();
    expect(await deriveRelatedTestCommand('cd backend && npx jest', ['frontend/app/x.tsx', 'docs/y.md'])).toBeNull();
    expect(await deriveRelatedTestCommand('npx jest', Array.from({ length: RELATED_MAX_FILES + 1 }, (_, i) => `src/f${i}.ts`))).toBeNull();
    expect(await deriveRelatedTestCommand('', ['a.ts'])).toBeNull();
  });
  it('resolves a package script (npm run test / pnpm test / yarn test) through package.json and appends the args THROUGH the script (live 2026-09-20: `npm run test` derived nothing)', async () => {
    expect(parsePackageScript('npm run test')).toEqual({ pm: 'npm', script: 'test' });
    expect(parsePackageScript('npm test')).toEqual({ pm: 'npm', script: 'test' });
    expect(parsePackageScript('pnpm test:unit')).toEqual({ pm: 'pnpm', script: 'test:unit' });
    expect(parsePackageScript('yarn run test')).toEqual({ pm: 'yarn', script: 'test' });
    expect(parsePackageScript('npx jest')).toBeNull();
    const scripts: Record<string, Record<string, string>> = { '.': { test: 'jest --ci', 'test:vi': 'vitest run', chain: 'tsc && jest' }, web: { test: 'vitest' } };
    const reader = async (dir: string, name: string) => scripts[dir]?.[name] ?? null;
    expect(await deriveRelatedTestCommand('npm run test', ['src/a.ts'], reader)).toBe("npm run test -- --findRelatedTests 'src/a.ts' --passWithNoTests");
    expect(await deriveRelatedTestCommand('yarn test', ['src/a.ts'], reader)).toBe("yarn test --findRelatedTests 'src/a.ts' --passWithNoTests");
    expect(await deriveRelatedTestCommand('npm run test:vi', ['src/a.ts'], reader)).toBe("npx vitest related 'src/a.ts' --run --passWithNoTests");
    expect(await deriveRelatedTestCommand('cd web && npm test', ['web/lib/x.ts'], reader)).toBe("cd web && npx vitest related 'lib/x.ts' --run --passWithNoTests");
    expect(await deriveRelatedTestCommand('npm run chain', ['src/a.ts'], reader)).toBeNull(); // a multi-step script is not scopable
    expect(await deriveRelatedTestCommand('npm run missing', ['src/a.ts'], reader)).toBeNull();
    expect(await deriveRelatedTestCommand('npm run test', ['src/a.ts'])).toBeNull(); // no reader → cannot resolve
    // The shell-backed reader parses <dir>/package.json.
    const shell = async (command: string) => ({ stdout: command.includes("'backend/package.json'") ? JSON.stringify({ scripts: { test: 'jest' } }) : '{}', stderr: '' });
    expect(await packageScriptReader(shell, '/wt')('backend', 'test')).toBe('jest');
    expect(await packageScriptReader(shell, '/wt')('.', 'test')).toBeNull();
  });
});

describe('runVerifyChain — related-tests-first', () => {
  const shell = (script: Record<string, { out: string; exit: number }>, calls: string[]) => async (command: string) => {
    calls.push(command);
    if (command.startsWith('git diff')) return { stdout: 'backend/src/a.ts\n', stderr: '' };
    if (command.startsWith('for p in')) return { stdout: '', stderr: '' }; // orphan reaper
    const hit = Object.entries(script).find(([k]) => command.includes(k));
    if (!hit) return { stdout: '__DIGBY_EXIT__ 0', stderr: '' };
    return { stdout: `${hit[1].out}\n__DIGBY_EXIT__ ${hit[1].exit}`, stderr: '' };
  };
  const CHAIN = [{ key: 'typecheck', command: 'cd backend && npx tsc --noEmit' }, { key: 'test', command: 'cd backend && npx jest' }];

  it('a failing related subset stops the chain in one stage — the full suite never runs', async () => {
    const calls: string[] = [];
    const r = await runVerifyChain(shell({ '--findRelatedTests': { out: 'FAIL src/a.test.ts', exit: 1 } }, calls), '/wt', CHAIN, 60_000);
    expect(r.passed).toBe(false);
    expect(r.failedStage).toBe(RELATED_STAGE_KEY);
    expect(r.stages.map((s) => s.key)).toEqual(['typecheck', RELATED_STAGE_KEY]);
    expect(calls.some((c) => c.includes("--findRelatedTests 'src/a.ts' --passWithNoTests"))).toBe(true);
    expect(calls.filter((c) => /npx jest;/.test(c))).toHaveLength(0); // the full stage did not run
  });

  it('a green related subset is followed by the full test stage (verify stays the check of record)', async () => {
    const calls: string[] = [];
    const r = await runVerifyChain(shell({ '--findRelatedTests': { out: 'PASS', exit: 0 } }, calls), '/wt', CHAIN, 60_000);
    expect(r.passed).toBe(true);
    expect(r.stages.map((s) => s.key)).toEqual(['typecheck', RELATED_STAGE_KEY, 'test']);
    expect(calls.filter((c) => /npx jest; echo/.test(c))).toHaveLength(1);
  });

  it('a related pass whose tool is missing is recorded skipped and the full stage still decides', async () => {
    const calls: string[] = [];
    const r = await runVerifyChain(shell({ '--findRelatedTests': { out: 'sh: 1: jest: not found', exit: 127 } }, calls), '/wt', CHAIN, 60_000);
    expect(r.stages.find((s) => s.key === RELATED_STAGE_KEY)).toMatchObject({ passed: true, skipped: true });
    expect(r.stages.map((s) => s.key)).toEqual(['typecheck', RELATED_STAGE_KEY, 'test']);
  });

  it('listChangedFiles unions worked tree, index and untracked, and is total', async () => {
    const files = await listChangedFiles(async () => ({ stdout: 'a.ts\nb.ts\na.ts\n\n', stderr: '' }), '/wt');
    expect(files).toEqual(['a.ts', 'b.ts']);
    expect(await listChangedFiles(async () => { throw new Error('no git'); }, '/wt')).toEqual([]);
  });

  it('a CLEAN worked tree falls back to the branch\'s commits against the base branch (lanes commit before they verify)', async () => {
    const calls: string[] = [];
    const shell = async (command: string) => {
      calls.push(command);
      if (command.startsWith('git diff --name-only HEAD')) return { stdout: '', stderr: '' };
      if (command.includes('merge-base')) return { stdout: 'backend/src/modules/crossmodel/fleet/infra-watch.service.ts\nbackend/src/modules/crossmodel/fleet/infra-watch.service.test.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    expect(await listChangedFiles(shell, '/wt', 'main')).toEqual(['backend/src/modules/crossmodel/fleet/infra-watch.service.ts', 'backend/src/modules/crossmodel/fleet/infra-watch.service.test.ts']);
    expect(calls[1]).toContain('git merge-base origin/main HEAD');
    // An odd base-branch name is sanitized before it reaches the shell.
    await listChangedFiles(shell, '/wt', 'release; rm -rf /');
    expect(calls[3]).toContain('origin/releaserm-rf/ HEAD');
  });
});
