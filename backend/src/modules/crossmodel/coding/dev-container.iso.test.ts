/**
 * build 2026-10-08 ISO — the owner's dev container under the per-user subtree:
 * the mount plan (whole volume unless the switch applies AND every live
 * worktree is in the user's subtree), byte-identical whole-volume args, the
 * subtree create args (+ shared-project mirrors one by one), and the
 * quiet-window convergence sweep (never mid-run). Docker + prisma mocked; a
 * real tmp volume root for the layout census.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-dev-'));
process.env.DEV_JOIN_VERIFY_TIMEOUT_MS = '100';
process.env.DEV_JOIN_VERIFY_POLL_MS = '10';

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockPrisma: any = {
  userPreferences: { findUnique: jest.fn(async () => ({ devContainerEnabled: true })) },
  user: { findUnique: jest.fn(async () => ({ role: 'ADMIN' })) },
  chatCodingState: { findMany: jest.fn(async () => []) },
  agentRun: { count: jest.fn(async () => 0) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) } }));
const mockDests = jest.fn(async (): Promise<string[] | null> => null);
jest.mock('./container.service', () => ({
  __esModule: true,
  isDockerAvailable: jest.fn(async () => true),
  SANDBOX_HOMES_ROOT: `${ROOT}/worktrees/.sandbox-home`,
  containerMountDestinations: (...a: any[]) => (mockDests as any)(...a),
}));
jest.mock('./workspace.service', () => ({ __esModule: true, CODING_WORKSPACE_ROOT: ROOT }));
jest.mock('./credentials.service', () => ({ __esModule: true, getCredentialValueDecrypted: jest.fn(async () => null) }));
const mockRecord = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecord(...a), LOOP_METRIC_KINDS: { WORKSPACE_ISOLATION: 'workspace_isolation' } }));

const calls: string[][] = [];
let psRunning = false;
let psExists = false;
let labelPs = '';
jest.mock('child_process', () => ({
  __esModule: true,
  execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
    calls.push(args);
    let stdout = '';
    const nameFilter = args.find((a) => a.startsWith('name=^'));
    const want = nameFilter ? nameFilter.replace(/^name=\^/, '').replace(/\$$/, '') : '';
    if (args[0] === 'ps' && args.includes('-a')) stdout = psExists ? want : '';
    else if (args[0] === 'ps' && args.some((a) => a.startsWith('label='))) stdout = labelPs;
    else if (args[0] === 'ps') stdout = psRunning ? want : '';
    else if (args[0] === 'exec' && args.includes('status')) stdout = JSON.stringify({ BackendState: 'Running' });
    const child: any = { stdin: { write: () => {}, end: () => {} } };
    process.nextTick(() => cb(null, stdout, ''));
    return child;
  },
}));

import { desiredDevMountPlan, devMountArgs, devMountsMatch, ensureUserDevContainer, convergeDevContainerMounts, devContainerName } from './dev-container.service';
import { ensureUserSubtreeSync, userSubtreeKey } from './workspace-layout';

const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
const KEY = userSubtreeKey(OWNER);
const VOL = 'crossmodel_coding_workspaces';
const flush = () => new Promise((r) => setTimeout(r, 0));

function wt(dir: string, mirror: string, sid: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${mirror}/worktrees/${sid}\n`);
}

beforeAll(() => {
  ensureUserSubtreeSync(OWNER, ROOT);
  fs.mkdirSync(path.join(ROOT, 'repos', 'shared.git'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, KEY, 'repos', 'own.git'), { recursive: true });
  wt(path.join(ROOT, KEY, 'worktrees', 's1'), path.join(ROOT, KEY, 'repos', 'own.git'), 's1');
  wt(path.join(ROOT, KEY, 'worktrees', 's2'), path.join(ROOT, 'repos', 'shared.git'), 's2');
  wt(path.join(ROOT, 'worktrees', 'old'), path.join(ROOT, 'repos', 'shared.git'), 'old');
});
afterAll(() => { fs.rmSync(ROOT, { recursive: true, force: true }); });
beforeEach(() => {
  calls.length = 0; psRunning = false; psExists = false; labelPs = '';
  mockRecord.mockClear(); mockDests.mockReset(); mockDests.mockResolvedValue(null);
  mockPrisma.agentRun.count.mockResolvedValue(0);
  mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1', status: 'ready' }, { id: 's2', status: 'ready' }]);
  delete process.env.CODING_WORKSPACE_PER_USER_SUBTREE;
});

describe('the mount plan', () => {
  it('switch off → whole volume (no census); its args are the pre-ISO args byte-for-byte', async () => {
    const plan = await desiredDevMountPlan(OWNER);
    expect(plan).toEqual({ mode: 'whole_volume', reason: 'switch_off' });
    expect(mockPrisma.chatCodingState.findMany).not.toHaveBeenCalled();
    expect(devMountArgs(plan)).toEqual(['-v', `${VOL}:${ROOT}`, '--tmpfs', `${ROOT}/worktrees/.sandbox-home:rw,noexec,nosuid,size=64k`]);
  });
  it('a live LEGACY worktree keeps the whole volume (never strand a session)', async () => {
    process.env.CODING_WORKSPACE_PER_USER_SUBTREE = OWNER;
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1', status: 'ready' }, { id: 'old', status: 'ready' }]);
    expect(await desiredDevMountPlan(OWNER)).toEqual({ mode: 'whole_volume', reason: 'legacy_worktrees:1' });
  });
  it('fully contained → ONLY the user subtree (+ the shared mirror its session uses), homes masked', async () => {
    process.env.CODING_WORKSPACE_PER_USER_SUBTREE = OWNER;
    const plan = await desiredDevMountPlan(OWNER);
    expect(plan).toEqual({ mode: 'user_subtree', key: KEY, extraMirrors: [path.join(ROOT, 'repos', 'shared.git')], reason: 'contained:2' });
    const args = devMountArgs(plan);
    expect(args).toEqual([
      '--mount', `type=volume,source=${VOL},target=${ROOT}/${KEY},volume-subpath=${KEY}`,
      '--tmpfs', `${ROOT}/${KEY}/.sandbox-home:rw,noexec,nosuid,size=64k`,
      '--mount', `type=volume,source=${VOL},target=${ROOT}/repos/shared.git,volume-subpath=repos/shared.git`,
    ]);
    expect(args.join(' ')).not.toContain(`${VOL}:${ROOT}`);
    expect(devMountsMatch(plan, [`${ROOT}/${KEY}`, `${ROOT}/repos/shared.git`, '/var/lib/digby-tailscale'])).toBe(true);
    expect(devMountsMatch(plan, [ROOT])).toBe(false);
    expect(devMountsMatch(plan, [`${ROOT}/${KEY}`])).toBe(false); // the shared mirror is missing
    expect(devMountsMatch({ mode: 'whole_volume', reason: 'x' }, [ROOT])).toBe(true);
    expect(devMountsMatch(plan, null)).toBe(true); // unknown → never churn
  });
  it('a census DB error keeps the whole volume', async () => {
    process.env.CODING_WORKSPACE_PER_USER_SUBTREE = '1';
    mockPrisma.chatCodingState.findMany.mockRejectedValue(new Error('db'));
    expect(await desiredDevMountPlan(OWNER)).toEqual({ mode: 'whole_volume', reason: 'census_failed' });
  });
});

describe('create + converge', () => {
  it('a contained canary owner gets a SUBTREE-only dev container', async () => {
    process.env.CODING_WORKSPACE_PER_USER_SUBTREE = OWNER;
    expect(await ensureUserDevContainer(OWNER)).toBe(devContainerName(OWNER));
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain(`type=volume,source=${VOL},target=${ROOT}/${KEY},volume-subpath=${KEY}`);
    expect(run).not.toContain(`${VOL}:${ROOT}`);
    await flush();
    expect(mockRecord.mock.calls.map((c) => c[0].meta)).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'dev_mount', plan: 'user_subtree', outcome: 'created' })]));
  });
  it('build 2026-10-11 ISO-GH hardening check: with the switch on for EVERYONE the dev container is still never hardened (its root boots tailscaled, apt and the egress shim; session execs are uid 1001)', async () => {
    process.env.CODING_WORKSPACE_PER_USER_SUBTREE = '1';
    const other = '0441ef49-0000-4000-8000-000000000001'; // a fresh user (the OWNER's container is memoized healthy by now)
    expect(await ensureUserDevContainer(other)).toBe(devContainerName(other));
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain('--init');
    for (const flag of ['--cap-drop', 'no-new-privileges', '--pids-limit', '--read-only', '--user']) expect(run).not.toContain(flag);
  });
  it('converge: a drifted RUNNING container is recreated when idle, deferred while a run is in flight', async () => {
    process.env.CODING_WORKSPACE_PER_USER_SUBTREE = OWNER;
    const name = devContainerName(OWNER);
    labelPs = `${name}\t${OWNER}`;
    mockDests.mockResolvedValue([ROOT, '/var/lib/digby-tailscale']); // still whole-volume
    mockPrisma.agentRun.count.mockResolvedValue(2);
    await convergeDevContainerMounts();
    expect(calls.some((c) => c[0] === 'rm')).toBe(false);
    mockPrisma.agentRun.count.mockResolvedValue(0);
    await convergeDevContainerMounts();
    expect(calls.some((c) => c[0] === 'rm' && c.includes(name))).toBe(true);
    expect(calls.some((c) => c[0] === 'run')).toBe(true);
    await flush();
    const outcomes = mockRecord.mock.calls.map((c) => c[0].meta).filter((m: any) => m.phase === 'dev_mount').map((m: any) => m.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(['deferred_in_flight', 'recreated']));
  });
  it('switch off: a whole-volume dev container matches its plan → never recreated', async () => {
    labelPs = `${devContainerName(OWNER)}\t${OWNER}`;
    mockDests.mockResolvedValue([ROOT]);
    await convergeDevContainerMounts();
    expect(calls.some((c) => c[0] === 'rm' || c[0] === 'run')).toBe(false);
  });
  it('the switch going OFF converges a subtree-mounted container back to the whole volume (when idle)', async () => {
    labelPs = `${devContainerName(OWNER)}\t${OWNER}`;
    mockDests.mockResolvedValue([`${ROOT}/${KEY}`]);
    await convergeDevContainerMounts();
    const run = calls.find((c) => c[0] === 'run')!;
    expect(run).toContain(`${VOL}:${ROOT}`);
  });
});
