/**
 * Ticket d927d0cd / 769fa54a / 28ab7db2 / 733ffdef / fe0a8dc2 (mishap cluster,
 * 2026-10-17) — a FAILED verify stage's outputTail named ZERO failing tests:
 * in a ~20k-test run, jest prints the failing tests' identities in-line
 * thousands of lines before the end, so the last-60-lines tail carried only
 * trailing PASS lines + the worker-exit warning, and five lanes hit
 * 3×-tool-failure streaks on diagnose-blind evidence ("FAIL s" — cut
 * mid-line). This suite replays the exact tail shape from ticket d927d0cd
 * (read verbatim via get_feedback) and pins both halves of the fix:
 *
 * 1) appendFailureExcerpt (pure): the failing-test identities that scrolled
 *    out of the tail are prepended in a bounded excerpt; identities already
 *    inside the tail are not duplicated; green output passes through
 *    untouched; jest's repeated final-summary identities appear once.
 * 2) runVerifyChain (integration): a red test stage's recorded outputTail
 *    carries the FAIL identities even when the last 60 lines contain none,
 *    while a green stage keeps the plain tail.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { VERIFY_ENV_RED: 'verify_env_red', VERIFY_STAGE_TIMEOUT: 'verify_stage_timeout' },
}));

import { runVerifyChain, appendFailureExcerpt } from './verify.service';

const CHAIN = [{ key: 'test', command: 'npm test' }];

// Answer the chain's git-listing legs (related-tests-first) with nothing
// derivable so 'test' runs as the full stage, and answer the session-bg scan
// empty (no attributed background processes → allowance never defers).
const noExtras = (exec: jest.Mock): any => (cmd: string, ...rest: any[]) =>
  /git diff|git merge-base|session-bg|ps -eo/.test(cmd) ? Promise.resolve({ stdout: '', stderr: '' }) : exec(cmd, ...rest);

beforeEach(() => {
  process.env.VERIFY_ENV_RETRY_BACKOFF_MS = '1';
  delete process.env.VERIFY_SESSION_ALLOWANCE_MB;
});

const out = (text: string, code: number) => ({ stdout: `${text}\n__DIGBY_EXIT__ ${code}`, stderr: '' });

// The tail shape from ticket d927d0cd (verbatim class): trailing PASS lines +
// the worker-exit warning, THEN the summary block starting mid-line.
const ticketTail = [
  'PASS src/middleware/token-noise.test.ts',
  'PASS src/modules/crossmodel/coding/retiring.test.ts',
  'A worker process has failed to exit gracefully and has been force exited. This is likely caused by tests leaking due to improper teardown. Try running with --detectOpenHandles to find leaks.',
  '',
  'Summary of all failing tests',
].join('\n');

describe('appendFailureExcerpt (pure, ticket d927d0cd cluster)', () => {
  test('FAIL identities that scrolled OUT of the tail ride in an excerpt above it', () => {
    // ~20k-test shape: the FAIL block sits thousands of lines before the end.
    const padding = Array.from({ length: 5000 }, (_, i) => `PASS src/generated/pad-${i}.test.ts`).join('\n');
    const full = [
      'FAIL src/modules/crossmodel/coding/web-pipe.test.ts',
      '  ● web-pipe › zero-source honesty › names the degraded provider class',
      padding,
      ticketTail,
    ].join('\n');
    const tailText = full.split('\n').slice(-60).join('\n');
    const result = appendFailureExcerpt(full, tailText);
    expect(result).not.toBe(tailText); // the excerpt was prepended
    expect(result.startsWith('--- failing-test identities (excerpt')).toBe(true);
    expect(result).toContain('FAIL src/modules/crossmodel/coding/web-pipe.test.ts');
    expect(result).toContain('● web-pipe › zero-source honesty › names the degraded provider class');
    expect(result).toContain(ticketTail); // the tail itself is preserved verbatim below
  });

  test('identities already inside the tail are NOT duplicated into the excerpt', () => {
    const full = ['FAIL src/a.test.ts', 'PASS src/b.test.ts', 'Summary of all failing tests', 'FAIL src/a.test.ts'].join('\n');
    const tailText = full; // tiny run: the whole output IS the tail
    const result = appendFailureExcerpt(full, tailText);
    expect(result).toBe(tailText); // nothing lost, nothing duplicated — byte-identical
  });

  test('green output (no failure-identity lines) passes through byte-identical', () => {
    const full = Array.from({ length: 100 }, (_, i) => `PASS src/p-${i}.test.ts`).join('\n');
    const tailText = full.split('\n').slice(-60).join('\n');
    expect(appendFailureExcerpt(full, tailText)).toBe(tailText);
  });

  test('jest final-summary repeats of an identity appear once (dedup)', () => {
    const full = [
      'FAIL src/a.test.ts',
      ...Array.from({ length: 200 }, (_, i) => `PASS src/pad-${i}.test.ts`),
      'Summary of all failing tests',
      'FAIL src/a.test.ts', // jest repeats it in the summary
    ].join('\n');
    const tailText = full.split('\n').slice(-60).join('\n'); // tail holds the summary repeat only
    const result = appendFailureExcerpt(full, tailText);
    const excerptBlock = result.split('--- end excerpt')[0];
    expect((excerptBlock.match(/FAIL src\/a\.test\.ts/g) ?? []).length).toBe(1);
  });

  test('excerpt is bounded at 25 identities', () => {
    const many = Array.from({ length: 60 }, (_, i) => `FAIL src/too-many-${i}.test.ts`);
    const full = [...many, ...Array.from({ length: 100 }, (_, i) => `PASS src/p-${i}.test.ts`)].join('\n');
    const tailText = full.split('\n').slice(-60).join('\n');
    const result = appendFailureExcerpt(full, tailText);
    expect((result.match(/^FAIL /gm) ?? []).length).toBe(25);
  });

  test('empty inputs degrade to the tail unchanged', () => {
    expect(appendFailureExcerpt('', 'the tail')).toBe('the tail');
    expect(appendFailureExcerpt('full output', '')).toBe('');
  });

  test('tsc shape: "src/file.ts(1,2): error TS2345: …" rides in the excerpt', () => {
    const full = [
      'src/modules/crossmodel/coding/broken.ts(42,7): error TS2345: Argument of type string is not assignable to parameter of type number.',
      ...Array.from({ length: 300 }, (_, i) => `PASS src/pad-${i}.test.ts`),
    ].join('\n');
    const tailText = full.split('\n').slice(-60).join('\n');
    const result = appendFailureExcerpt(full, tailText);
    expect(result).toContain('error TS2345');
    expect(result).toContain('broken.ts(42,7)');
  });

  test('pytest short-summary shape: "FAILED tests/x.py::test_y" rides in the excerpt', () => {
    const full = [
      ...Array.from({ length: 300 }, (_, i) => `pad line ${i}`),
      'short test summary info',
      'FAILED tests/test_pipeline.py::test_coalesce[gate]',
    ].join('\n');
    const tailText = full.split('\n').slice(-60).join('\n');
    const result = appendFailureExcerpt(full, tailText);
    expect(result).toContain('FAILED tests/test_pipeline.py::test_coalesce[gate]');
  });
});

describe('runVerifyChain surfaces the excerpt on a red test stage (d927d0cd cluster)', () => {
  test('red stage: outputTail names the failing test even though the last 60 lines do not', async () => {
    const padding = Array.from({ length: 5000 }, (_, i) => `PASS src/generated/pad-${i}.test.ts`).join('\n');
    const full = ['FAIL src/modules/crossmodel/coding/retiring.test.ts', padding, ticketTail].join('\n');
    const exec = jest.fn(async () => out(full, 1));
    const result = await runVerifyChain(noExtras(exec as any), '/wt', CHAIN, 60_000);
    expect(result.passed).toBe(false);
    expect(result.failedStage).toBe('test');
    const stage = result.stages.find((s) => s.key === 'test');
    expect(stage?.outputTail).toContain('FAIL src/modules/crossmodel/coding/retiring.test.ts');
    expect(stage?.outputTail).toContain('--- failing-test identities (excerpt');
  });

  test('green stage: outputTail stays the plain 60-line tail (no excerpt header)', async () => {
    const full = Array.from({ length: 100 }, (_, i) => `PASS src/green-${i}.test.ts`).join('\n');
    const exec = jest.fn(async () => out(full, 0));
    const result = await runVerifyChain(noExtras(exec as any), '/wt', CHAIN, 60_000);
    expect(result.passed).toBe(true);
    const stage = result.stages.find((s) => s.key === 'test');
    expect(stage?.outputTail).not.toContain('--- failing-test identities');
    expect(stage?.outputTail).toContain('PASS src/green-99.test.ts');
  });

  test('environmental death keeps its dedicated shape (never an excerpt)', async () => {
    const exec = jest.fn(async () => ({ stdout: '', stderr: '' })); // no marker → terminated
    const result = await runVerifyChain(noExtras(exec as any), '/wt', CHAIN, 60_000);
    expect(result.passed).toBe(false);
    const stage = result.stages.find((s) => s.key === 'test');
    expect(stage?.environmental).toBe(true);
    expect(stage?.outputTail).toContain('[ENVIRONMENTAL]');
    expect(stage?.outputTail).not.toContain('--- failing-test identities');
  });
});
