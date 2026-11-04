/**
 * ff262da5 (todo 4ecfd309, 2026-10-16) — the dev-container memory-starvation
 * fix's INTEGRATION pins. The incident: shared dev container 22.4/24.5 GiB
 * (91.6%), 54 session daemons, 311 cumulative OOM kills, 4/4 verify runs in
 * 30 min failed environmentally.
 *
 * This suite pins the THREE charter items at their seams:
 *   1. ENV-STARVED verdicts (container pressure / host pressure / session
 *      allowance) — the ticket ask: "an 'env-starved' verify verdict
 *      instead of retries", at the ~85% working-set threshold;
 *   2. the per-session allowance (the cgroup-equivalent accounting);
 *   3. the RUN admission probe (worker.ts's admitClaimedRun rides
 *      devContainerMemoryAdmission — its parse + thresholds live here).
 *
 * The pure attribution/script half is pinned in session-bg.test.ts.
 */
import { runVerifyChain, parseOomKillCount, type VerifyChainEntry } from './verify.service';

// ── The verify.service test harness (same shape as verify-pressure-defer.test.ts:
//    mock the logger only — verify.service is an env-free leaf; loop-metrics is
//    DYNAMIC-imported so its graph never loads in these tests) ──────────────────
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Import-graph landmine (see verify-env-red.test.ts / verify-pressure-defer.test.ts):
// the ENV-STARVED telemetry reaches loop-metrics via DYNAMIC import — jest still
// resolves it at runtime, dragging config/database → config/env (process.exit(1)
// on missing env) into this env-free-leaf suite. Mock it, exactly like the
// pressure-defer suite does.
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { VERIFY_PRESSURE_DEFERRED: 'verify_pressure_deferred', VERIFY_ENV_RED: 'verify_env_red' },
}));

const execShell = jest.fn();

beforeEach(() => {
  jest.resetModules();
  execShell.mockReset();
  delete process.env.VERIFY_PRESSURE_DEFER_PCT;
  delete process.env.VERIFY_SESSION_ALLOWANCE_DISABLED;
  delete process.env.VERIFY_SESSION_ALLOWANCE_MB;
  delete process.env.VERIFY_HOST_PRESSURE_DEFER_PCT;
});

/** One cgroup __CG__ reading: current, max, inactive_file (KB units don't
 *  matter to the parser — percentages do). */
const cg = (currentKb: number, maxKb: number, inactiveKb: number, oomKill?: number) =>
  `__CG__ ${currentKb} ${maxKb} ${inactiveKb}\n__MEM__ 999999 2000000\n__OOM__ ${oomKill ?? 0}`;

/** A successful chain LEG answer (the `__DIGBY_EXIT__ 0` marker is what the
 *  runner greps — without it the leg classifies as terminated/environmental
 *  and retries after a 20 s backoff, blowing jest's 5 s timeout). */
const LEG_OK = { stdout: 'ok\n__DIGBY_EXIT__ 0', stderr: '' };

const CHAIN: VerifyChainEntry[] = [{ key: 'typecheck', command: 'true' }];

describe('ff262da5 — ENV-STARVED verdict (container working-set pressure)', () => {
  test('working set ≥ 85% → ENV-STARVED stage (not DEFERRED wording), chain does NOT run', async () => {
    // ~86% raw with almost nothing reclaimable — REAL pressure
    execShell.mockResolvedValue({ stdout: cg(21_200, 24_500, 300, 319), stderr: '' });
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000);
    expect(res.ran).toBe(false);
    expect(res.unverified).toBe(true);
    const stage = res.stages[0];
    expect(stage?.envStarved).toBe(true);
    expect(stage?.deferred).toBe(true);
    expect(stage?.outputTail).toContain('ENV-STARVED');
    expect(stage?.outputTail).toContain('NOT be retried');
    // the chain legs never ran — only the pre-flight reap round-trip executed
    expect(execShell).toHaveBeenCalledTimes(1);
  });

  test('the threshold is the WORKING SET: raw 91.6% with 62% reclaimable cache ADMITS (the live census shape)', async () => {
    execShell.mockImplementation(async (cmd: string) =>
      cmd.includes('__CG__') || cmd.includes('memory.current') || cmd.includes('pgrep')
        ? { stdout: cg(22_400, 24_500, 15_300), stderr: '' } : LEG_OK);
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000);
    expect(res.ran).toBe(true);
    expect(res.passed).toBe(true);
  });

  test('default threshold is 85 (the ticket ask; was 92 pre-ff262da5)', async () => {
    // 86.5% working set — would have ADMITTED at the old 92 default, defers now
    execShell.mockResolvedValue({ stdout: cg(21_200, 24_500, 50), stderr: '' });
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000);
    expect(res.ran).toBe(false);
    expect(res.stages[0]?.envStarved).toBe(true);
  });

  test('VERIFY_PRESSURE_DEFER_PCT still overrides the default', async () => {
    process.env.VERIFY_PRESSURE_DEFER_PCT = '95';
    execShell.mockImplementation(async (cmd: string) =>
      cmd.includes('__CG__') || cmd.includes('memory.current') || cmd.includes('pgrep')
        ? { stdout: cg(21_200, 24_500, 50), stderr: '' } : LEG_OK); // ~86.5%
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000);
    expect(res.ran).toBe(true);
  });

  });

describe('ff262da5 — host-pressure arm keeps the ENV-STARVED shape', () => {
  test('host MemAvailable under the floor → envStarved (the 7fbc34cd class)', async () => {
    execShell.mockResolvedValue({ stdout: `__CG__ 100 24_500 0\n__MEM__ 200000 2000000\n__OOM__ 3`, stderr: '' });
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000);
    expect(res.ran).toBe(false);
    expect(res.stages[0]?.envStarved).toBe(true);
    expect(res.stages[0]?.outputTail).toContain('ENV-STARVED');
  });
});

describe('ff262da5 — per-session allowance (the cgroup-equivalent accounting)', () => {
  const SID = 'a1cd1d3f-5a7f-43c5-a7bc-17b0ba620687';
  const bg = (rssKb: number) =>
    `__BG__ 123 1001 123 ${rssKb} 4321 0 ${SID} node server.js`;

  test('a session whose own daemons exceed the allowance → ENV-STARVED (session_allowance), chain does not run', async () => {
    // healthy container; the session daemon holds 3 GB RSS > 2048 MB default
    execShell.mockResolvedValueOnce({ stdout: cg(100, 24_500, 0), stderr: '' }) // pre-flight
      .mockResolvedValueOnce({ stdout: bg(3 * 1024 * 1024), stderr: '' }); // session-bg scan
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000, { sessionId: SID });
    expect(res.ran).toBe(false);
    expect(res.stages[0]?.envStarved).toBe(true);
    expect(res.stages[0]?.key).toBe('session_allowance');
    expect(res.stages[0]?.outputTail).toContain('ENV-STARVED');
  });

  test('under the allowance → the chain runs (accounting is advisory until exceeded)', async () => {
    execShell.mockImplementation(async (cmd: string) =>
      cmd.includes('memory.current') || cmd.includes('pgrep') ? { stdout: cg(100, 24_500, 0), stderr: '' }
        : cmd.includes('DIGBY-SESSION-BG') ? { stdout: bg(512 * 1024), stderr: '' }
        : LEG_OK);
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000, { sessionId: SID });
    expect(res.ran).toBe(true);
  });

  test('another session daemons do not count against mine (attribution is per-session)', async () => {
    execShell.mockImplementation(async (cmd: string) =>
      cmd.includes('memory.current') || cmd.includes('pgrep') ? { stdout: cg(100, 24_500, 0), stderr: '' }
        : cmd.includes('DIGBY-SESSION-BG') ? { stdout: `__BG__ 5 1001 5 ${3 * 1024 * 1024} 10 0 someone-else x`, stderr: '' }
        : LEG_OK);
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000, { sessionId: SID });
    expect(res.ran).toBe(true);
  });

  test('no sessionId hint (auto seams that thread none) → the allowance arm is skipped, fail-open', async () => {
    execShell.mockImplementation(async (cmd: string) =>
      cmd.includes('memory.current') || cmd.includes('pgrep') ? { stdout: cg(100, 24_500, 0), stderr: '' } : LEG_OK);
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000);
    expect(res.ran).toBe(true);
    expect(execShell).toHaveBeenCalledTimes(2); // pre-flight + the leg, NO scan
  });

  test('kill switch VERIFY_SESSION_ALLOWANCE_DISABLED=1 skips the arm', async () => {
    process.env.VERIFY_SESSION_ALLOWANCE_DISABLED = '1';
    execShell.mockImplementation(async (cmd: string) =>
      cmd.includes('memory.current') || cmd.includes('pgrep') ? { stdout: cg(100, 24_500, 0), stderr: '' } : LEG_OK);
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000, { sessionId: SID });
    expect(res.ran).toBe(true);
    expect(execShell).toHaveBeenCalledTimes(2); // no scan round-trip
  });

  test('an unreadable session-bg scan (garbage output) never blocks the chain', async () => {
    execShell.mockImplementation(async (cmd: string) =>
      cmd.includes('memory.current') || cmd.includes('pgrep') ? { stdout: cg(100, 24_500, 0), stderr: '' }
        : cmd.includes('DIGBY-SESSION-BG') ? { stdout: 'permission denied garbage', stderr: '' }
        : LEG_OK);
    const res = await runVerifyChain(execShell as any, '/wt', CHAIN, 30_000, { sessionId: SID });
    expect(res.ran).toBe(true);
  });
});

describe('ff262da5 — parseOomKillCount (the ticket AFTER-number series)', () => {
  test('parses the __OOM__ marker', () => {
    expect(parseOomKillCount('__CG__ 1 2 3\n__OOM__ 319\n')).toBe(319);
    expect(parseOomKillCount('__OOM__ 0')).toBe(0);
  });
  test('missing / malformed → null (fail-open, same contract as the other parsers)', () => {
    expect(parseOomKillCount('no marker')).toBeNull();
    expect(parseOomKillCount('__OOM__ x')).toBeNull();
    expect(parseOomKillCount('')).toBeNull();
  });
});

describe('ff262da5 — RUN admission probe (devContainerMemoryAdmission)', () => {
  // The probe lives in dev-container.service (docker CLI helper). Its shell
  // command + parse are pinned via the exported function with the docker
  // child_process mock, the same harness shape as infra-actions tests.
  let dockerCalls: string[][] = [];
  let containerOut = '';
  let realExecFile: any = null;

  beforeEach(() => {
    dockerCalls = [];
    containerOut = '';
    delete process.env.RUN_ADMISSION_DISABLED;
    delete process.env.RUN_ADMISSION_PCT;
    const cp = require('child_process');
    if (realExecFile === null) realExecFile = cp.execFile;
    cp.execFile = ((_cmd: string, args: string[], _opts: any, cb: any) => {
      dockerCalls.push(args);
      cb(null, containerOut, '');
      return undefined;
    }) as any;
  });

  // Jest runs suites SEQUENTIALLY in the same worker process: without this,
  // a later suite inherits BOTH the stubbed execFile (any real child_process
  // user silently no-ops) and the RUN_ADMISSION_* env residue from the last
  // test (beforeEach cleans before each test, nothing cleaned after the LAST
  // one). Restore both — the suite must be invisible to its neighbors.
  afterAll(() => {
    const cp = require('child_process');
    if (realExecFile !== null) cp.execFile = realExecFile;
    delete process.env.RUN_ADMISSION_DISABLED;
    delete process.env.RUN_ADMISSION_PCT;
    delete process.env.VERIFY_PRESSURE_DEFER_PCT;
    delete process.env.VERIFY_SESSION_ALLOWANCE_DISABLED;
    delete process.env.VERIFY_SESSION_ALLOWANCE_MB;
    delete process.env.VERIFY_HOST_PRESSURE_DEFER_PCT;
    delete process.env.RUN_ADMISSION_MAX_DEFERRALS;
  });

  const load = () => {
    jest.resetModules();
    // dev-container.service imports prisma/redis — stub their graphs.
    jest.doMock('../../../config/database', () => ({ __esModule: true, default: {} }));
    jest.doMock('../../../config/redis', () => ({ __esModule: true, default: { on: jest.fn() } }));
    jest.doMock('./container.service', () => ({ isDockerAvailable: async () => true, SANDBOX_HOMES_ROOT: '/x', containerMountDestinations: () => [] }));
    jest.doMock('./workspace.service', () => ({ CODING_WORKSPACE_ROOT: '/app/coding-workspaces' }));
    return require('./dev-container.service');
  };

  test('working set ≥ 85% → admit:false with the ff262da5 reason naming the threshold', async () => {
    containerOut = '21600000\n24500000\n1000\n'; // ~88% raw, ~88% working set
    const { devContainerMemoryAdmission } = load();
    const r = await devContainerMemoryAdmission('user-1234567890ab');
    expect(r.admit).toBe(false);
    expect(r.reason).toContain('run admission deferred');
    expect(r.reason).toContain('ff262da5');
    expect(r.workingSetPct).not.toBeNull();
    // the probe read the cgroup v2 files (current, max, inactive_file)
    expect(dockerCalls[0].join(' ')).toContain('memory.current');
  });

  test('raw 91.6% with 62% reclaimable page cache ADMITS (the live census shape)', async () => {
    containerOut = '22400000\n24500000\n15300000\n'; // raw 91.4%, working set ~29%
    const { devContainerMemoryAdmission } = load();
    const r = await devContainerMemoryAdmission('user-1234567890ab');
    expect(r.admit).toBe(true);
    expect(r.workingSetPct).toBeLessThan(85);
  });

  test('threshold override + kill switch', async () => {
    containerOut = '21000000\n24500000\n1000\n'; // ~85.7% working set
    const { devContainerMemoryAdmission } = load();
    process.env.RUN_ADMISSION_PCT = '50';
    expect((await devContainerMemoryAdmission('u')).admit).toBe(false); // 85.7 ≥ 50
    process.env.RUN_ADMISSION_DISABLED = '1';
    expect((await devContainerMemoryAdmission('u')).admit).toBe(true); // killed
  });

  test('any read failure → admit (fail-open: a wedged docker socket must never wedge the queue)', async () => {
    const cp = require('child_process');
    cp.execFile = ((_c: string, _a: string[], _o: any, cb: any) => cb(new Error('docker socket gone'))) as any;
    const { devContainerMemoryAdmission } = load();
    const r = await devContainerMemoryAdmission('u');
    expect(r.admit).toBe(true);
    expect(r.workingSetPct).toBeNull();
  });
});
