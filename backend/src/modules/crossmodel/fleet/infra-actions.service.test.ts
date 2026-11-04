/**
 * Replay pin for ticket c12239c1 (owner analysis 2026-09-10: "why did the
 * self-merging / self-fixing loop and the ticket system not fix the OOM on
 * their own?"). Replays the 2026-09-09 incident signature — verify chains
 * SIGKILLed (exit 137, empty output) by the shared dev container's exhausted
 * cgroup (memory.current ≈ memory.max, oom_kill climbing 70→219) — and pins
 * the lever the 14 correctly-diagnosing lanes did NOT have:
 *
 *   1. TOOL — runInfraAction backs the `infra_action` platform tool:
 *      env_probe is read-only and ALWAYS executes; the mutating kinds are
 *      dry-run receipts until INFRA_ACTIONS_ENABLED=1 (observe-only default,
 *      ASK #4), hard-capped (host−4GiB / host−2cpus, ASK #1), grow-only, and
 *      per-kind+target NX-cooldowned; EVERY call receipts one loop_metrics
 *      infra_action row.
 *   2. TRIGGER (ASK #2) — sweepEnvRedInfraStreak: ≥3 verify_env_red metrics
 *      across ≥2 distinct sessions in 30 min ⇒ env_probe THEN
 *      dev_container_resize for the implicated owner, within ONE watchdog
 *      cadence — instead of a fifteenth stand-down.
 *   3. worker_restart stays PROPOSE-ONLY even fully armed (self-restart
 *      paradox + deploy-owned lifecycle) without INFRA_WORKER_RESTART_ARMED=1.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// loop-metrics: capture every receipt; kinds carry their real strings.
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { INFRA_ACTION: 'infra_action', VERIFY_ENV_RED: 'verify_env_red' },
}));

// prisma: sweep reads loop_metrics (verify_env_red rows) + chats (session→user).
const mockLoopMetricFind = jest.fn(async (): Promise<any[]> => []);
const mockChatFind = jest.fn(async (): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    loopMetric: { findMany: (...a: any[]) => (mockLoopMetricFind as any)(...a) },
    crossModelChat: { findMany: (...a: any[]) => (mockChatFind as any)(...a) },
  },
}));

// redis: NX cooldown claims — 'OK' = claimed, null = on cooldown; del = release.
const mockRedisSet = jest.fn(async (..._a: any[]): Promise<string | null> => 'OK');
const mockRedisDel = jest.fn(async (..._a: any[]): Promise<number> => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => (mockRedisSet as any)(...a), del: (...a: any[]) => (mockRedisDel as any)(...a) },
}));
/** NX-honouring redis for the cooldown-release tests: keys live in `held` until DEL. */
const useNxRedis = () => {
  const held = new Set<string>();
  mockRedisSet.mockImplementation(async (k: any, _v: any, opts: any) => { if (opts?.NX && held.has(k)) return null; held.add(k); return 'OK'; });
  mockRedisDel.mockImplementation(async (k: any) => (held.delete(k) ? 1 : 0));
  return held;
};

// dev-container.service's own deps (its pure exports — parseMemoryBytes,
// resolveDevMemoryCeiling, devContainerName — load for REAL; dockerHostCapacity
// routes through the scripted execFile below).
const mockIsDockerAvailable = jest.fn(async () => true);
jest.mock('../coding/container.service', () => ({ __esModule: true, isDockerAvailable: (...a: any[]) => (mockIsDockerAvailable as any)(...a) }));
jest.mock('../coding/workspace.service', () => ({ __esModule: true, CODING_WORKSPACE_ROOT: '/app/coding-workspaces' }));
jest.mock('../coding/credentials.service', () => ({ __esModule: true, getCredentialValueDecrypted: jest.fn(async () => null) }));
// statfs: the root disk reading prune_build_cache / propose_volume_growth read (WI-Q).
// bsize 4096; blocks/bfree/bavail scripted per test (default: 200 GiB volume, 88% used).
let statfsBlocks = (200 * 1024 ** 3) / 4096;
let statfsBfree = (24 * 1024 ** 3) / 4096;
let statfsFail = false;
jest.mock('fs/promises', () => ({
  __esModule: true,
  mkdir: jest.fn(async () => undefined),
  statfs: jest.fn(async () => {
    if (statfsFail) throw new Error('ENOENT');
    return { bsize: 4096, blocks: statfsBlocks, bfree: statfsBfree, bavail: statfsBfree };
  }),
}));

// execFile: script the docker CLI by args (the 2026-09-09 box state).
const dockerCalls: string[][] = [];
let hostMemTotal = 32 * 1024 ** 3; // 32 GiB host
let hostNcpu = 8;
let containerMemBytes = String(4 * 1024 ** 3); // the 4 GiB cgroup that OOMed
let containerRunning = true;
let oomKillCount = 219;                          // flatlined at 219 after the human fix
let orphanPsLines = '';
let builderStdout = 'Deleted build cache objects:\nabc\n\nTotal reclaimed space: 12.3GB\n';
let builderErr = '';
jest.mock('child_process', () => ({
  __esModule: true,
  execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
    dockerCalls.push(args);
    let stdout = '';
    let err: any = null;
    if (args[0] === 'info') stdout = `${hostMemTotal} ${hostNcpu}`;
    else if (args[0] === 'inspect' && args.some((a) => a.includes('State.Running'))) {
      if (!containerRunning) err = Object.assign(new Error('no such container'), { stderr: 'no such container' });
      else stdout = `true ${containerMemBytes} 0`;
    } else if (args[0] === 'inspect') stdout = containerMemBytes;
    else if (args[0] === 'exec' && args.some((a) => a.includes('memory.current'))) {
      stdout = `${Number(containerMemBytes) - 2_000_000}\n${containerMemBytes}\nlow 0\nhigh 0\nmax 0\noom ${oomKillCount}\noom_kill ${oomKillCount}\n`;
    } else if (args[0] === 'exec' && args.some((a) => a.includes('ps -eo'))) stdout = orphanPsLines;
    else if (args[0] === 'builder') {
      if (builderErr) err = Object.assign(new Error(builderErr), { stderr: builderErr });
      else stdout = builderStdout;
    }
    const child: any = { stdin: { write: () => {}, end: () => {} } };
    process.nextTick(() => cb(err, stdout, err ? String(err.stderr) : ''));
    return child;
  },
}));

import {
  runInfraAction, sweepEnvRedInfraStreak, infraActionsArmed, INFRA_ACTION_KINDS,
  proposeVolumeGrowth, parseReclaimedSpace, pruneBuildCacheArgs,
} from './infra-actions.service';

const UID = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4'; // the 2026-09-09 account
const DEV = 'digby-dev-83e4fbf9-e18';
const GIB = 1024 ** 3;

const dockerCallsOf = (verb: string) => dockerCalls.filter((a) => a[0] === verb);

beforeEach(() => {
  jest.clearAllMocks();
  dockerCalls.length = 0;
  hostMemTotal = 32 * GIB; hostNcpu = 8;
  containerMemBytes = String(4 * GIB);
  containerRunning = true; oomKillCount = 219; orphanPsLines = '';
  builderStdout = 'Deleted build cache objects:\nabc\n\nTotal reclaimed space: 12.3GB\n'; builderErr = '';
  statfsBlocks = (200 * GIB) / 4096; statfsBfree = (24 * GIB) / 4096; statfsFail = false;
  delete process.env.INFRA_ACTIONS_ENABLED;
  delete process.env.INFRA_PRUNE_KEEP_STORAGE_GB;
  delete process.env.INFRA_PRUNE_UNTIL;
  delete process.env.INFRA_VOLUME_ID;
  delete process.env.INFRA_INSTANCE_ID;
  delete process.env.INFRA_GP3_USD_PER_GB_MONTH;
  delete process.env.BOX_NAME;
  delete process.env.INFRA_WORKER_RESTART_ARMED;
  delete process.env.CODING_DEV_CONTAINER_MEMORY;
  mockRedisSet.mockReset(); mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockReset(); mockRedisDel.mockResolvedValue(1);
  mockLoopMetricFind.mockResolvedValue([]);
  mockChatFind.mockResolvedValue([]);
});

describe('runInfraAction — the lever (ticket c12239c1)', () => {
  it('env_probe ALWAYS executes (read-only, unarmed): host capacity + the cgroup OOM signature, receipted', async () => {
    const r = await runInfraAction({ kind: 'env_probe', userId: UID, reason: 'replay 2026-09-09' });
    expect(r.ok).toBe(true);
    expect(r.executed).toBe(true);
    expect(r.dryRun).toBe(false);
    expect(r.host).toMatchObject({ memTotalBytes: 32 * GIB, ncpu: 8 });
    expect(r.probe?.container).toMatchObject({ running: true, memoryBytes: 4 * GIB });
    // THE signature: memory.current ≈ memory.max with oom_kill climbing.
    expect(r.probe?.cgroup).toEqual({ currentBytes: 4 * GIB - 2_000_000, maxBytes: 4 * GIB, oomKill: 219 });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'infra_action', meta: expect.objectContaining({ action: 'env_probe', executed: true }),
    }));
  });

  it('dev_container_resize is a DRY-RUN receipt by default (observe-only posture, ASK #4): desired state + exact command, no docker update', async () => {
    const r = await runInfraAction({ kind: 'dev_container_resize', userId: UID, reason: 'replay 2026-09-09' });
    expect(r.dryRun).toBe(true);
    expect(r.executed).toBe(false);
    // host-derived (2026-09-29): env unset ⇒ host − 8 GiB = 24g on the 32 GiB mock host (floor 12g, cap 28g).
    expect(r.desired).toMatchObject({ memoryBytes: 24 * GIB, currentMemoryBytes: 4 * GIB });
    expect(String(r.desired?.command)).toBe(`docker update --memory ${24 * GIB} ${DEV}`);
    expect(dockerCallsOf('update')).toHaveLength(0);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'infra_action', meta: expect.objectContaining({ action: 'dev_container_resize', dryRun: true, executed: false }),
    }));
  });

  it('ARMED (INFRA_ACTIONS_ENABLED=1): the resize actually runs docker update and re-inspects', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    expect(infraActionsArmed()).toBe(true);
    const r = await runInfraAction({ kind: 'dev_container_resize', userId: UID, reason: 'replay 2026-09-09' });
    expect(r.executed).toBe(true);
    expect(r.dryRun).toBe(false);
    expect(dockerCallsOf('update')).toEqual([['update', '--memory', String(24 * GIB), DEV] /* 2026-09-29: host-derived (32 GiB − 8) */]);
  });

  it('hard cap: a request above host−4GiB is clamped and marked cappedBy (ASK #1)', async () => {
    const r = await runInfraAction({ kind: 'dev_container_resize', userId: UID, memoryBytes: 64 * GIB, reason: 'greedy' });
    expect(r.desired?.memoryBytes).toBe(28 * GIB); // 32−4
    expect(r.cappedBy).toBe('host-mem-reserve');
    expect(dockerCallsOf('update')).toHaveLength(0); // dry-run
  });

  it('grow-only: desired ≤ current is an honest refusal, never a shrink (the OOM-killer doctrine)', async () => {
    containerMemBytes = String(26 * GIB); // already bigger than the host-derived 24g target (2026-09-29)
    const r = await runInfraAction({ kind: 'dev_container_resize', userId: UID, reason: 'replay' });
    expect(r.executed).toBe(false);
    expect(r.refused).toMatch(/grow-only/);
    expect(dockerCallsOf('update')).toHaveLength(0);
  });

  it('REGRESSION (adversarial review B1): a cpus request NEVER smuggles a memory shrink — armed cpus-only update omits --memory when the derived target < current', async () => {
    containerMemBytes = String(26 * GIB); // prior manual raise ABOVE the host-derived 24g target (2026-09-29)
    process.env.INFRA_ACTIONS_ENABLED = '1';
    const r = await runInfraAction({ kind: 'dev_container_resize', userId: UID, cpus: 4, reason: 'cpus only' });
    expect(r.executed).toBe(true);
    expect(dockerCallsOf('update')).toEqual([['update', '--cpus', '4', DEV]]); // NO --memory
    expect(r.desired?.memoryUntouched).toMatch(/grow-only/);
  });

  it('REGRESSION (adversarial review B1): an EXPLICIT memory shrink is refused even with cpus set', async () => {
    containerMemBytes = String(16 * GIB);
    process.env.INFRA_ACTIONS_ENABLED = '1';
    const r = await runInfraAction({ kind: 'dev_container_resize', userId: UID, memoryBytes: 12 * GIB, cpus: 4, reason: 'shrink attempt' });
    expect(r.executed).toBe(false);
    expect(r.refused).toMatch(/grow-only: explicit memory/);
    expect(dockerCallsOf('update')).toHaveLength(0);
  });

  it('fail-closed (review #3): an ARMED mutation refuses when host capacity is unreadable — no caps, no update', async () => {
    hostMemTotal = NaN; // docker info unreadable/garbage
    process.env.INFRA_ACTIONS_ENABLED = '1';
    const r = await runInfraAction({ kind: 'dev_container_resize', userId: UID, reason: 'armed with blind host' });
    expect(r.executed).toBe(false);
    expect(r.refused).toMatch(/host capacity unreadable/);
    expect(dockerCallsOf('update')).toHaveLength(0);
  });

  it('per-kind+target NX cooldown suppresses repeats as loops, not fixes — fail-CLOSED for mutations', async () => {
    mockRedisSet.mockResolvedValue(null); // already claimed (or Redis down — indistinguishable on purpose)
    const r = await runInfraAction({ kind: 'dev_container_resize', userId: UID, reason: 'replay' });
    expect(r.cooldown).toBe(true);
    expect(r.refused).toMatch(/cooldown/);
    expect(dockerCalls).toHaveLength(0); // refused before even inspecting
    // …and the cooldown itself is receipted.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'infra_action', meta: expect.objectContaining({ cooldown: true }),
    }));
  });

  it('reap_orphans: dry-run lists >30-min tsc/jest victims; armed runs the same >30-min reap signature as the verify pre-chain', async () => {
    orphanPsLines = '101 3600 node /wt/backend/node_modules/.bin/tsc --noEmit\n102 120 node /wt/backend/node_modules/.bin/jest\n103 7200 node /wt/backend/node_modules/.bin/jest';
    const dry = await runInfraAction({ kind: 'reap_orphans', userId: UID, reason: 'replay' });
    expect(dry.dryRun).toBe(true);
    expect(dry.desired?.orphanLines).toBe(2); // the 3600s + 7200s ones; the 120s leg is legitimate
    expect(dockerCallsOf('exec').some((a) => a.some((x) => x.includes('pgrep')))).toBe(false);
    process.env.INFRA_ACTIONS_ENABLED = '1';
    const armed = await runInfraAction({ kind: 'reap_orphans', userId: UID, reason: 'replay' });
    expect(armed.executed).toBe(true);
    expect(dockerCallsOf('exec').some((a) => a.some((x) => x.includes('pgrep') && x.includes('1800')))).toBe(true);
  });

  it('worker_restart is PROPOSE-ONLY even when armed (self-restart paradox) without INFRA_WORKER_RESTART_ARMED=1', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    const r = await runInfraAction({ kind: 'worker_restart', reason: 'replay' });
    expect(r.executed).toBe(false);
    expect(r.refused).toMatch(/proposal-only/);
    expect(dockerCallsOf('restart')).toHaveLength(0);
  });

  it('unknown kind + missing userId are honest refusals, never throws', async () => {
    const bad = await runInfraAction({ kind: 'nuke' as any, userId: UID, reason: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.refused).toMatch(/unknown kind/);
    const noUser = await runInfraAction({ kind: 'dev_container_resize', reason: 'x' });
    expect(noUser.ok).toBe(false);
    expect(noUser.refused).toMatch(/needs userId/);
  });
});

describe('prune_build_cache — the disk-alert lever (WI-Q, 2026-09-25)', () => {
  const PRUNE_CMD = 'docker builder prune -af --filter until=72h --keep-storage 20GB';

  it('is registered as a kind; the command is exactly the 72h / size-capped prune', () => {
    expect(INFRA_ACTION_KINDS).toContain('prune_build_cache');
    expect(INFRA_ACTION_KINDS).toContain('propose_volume_growth');
    expect(`docker ${pruneBuildCacheArgs({} as any).join(' ')}`).toBe(PRUNE_CMD);
    expect(`docker ${pruneBuildCacheArgs({ INFRA_PRUNE_UNTIL: '24h', INFRA_PRUNE_KEEP_STORAGE_GB: '5' } as any).join(' ')}`).toBe('docker builder prune -af --filter until=24h --keep-storage 5GB');
    expect(pruneBuildCacheArgs({ INFRA_PRUNE_UNTIL: 'rm -rf /' } as any)).toContain('until=72h'); // malformed → default
    // INFRA_PRUNE_KEEP_STORAGE_GB=0 omits the (deprecated-alias) flag entirely — the CLI-bump escape hatch
    expect(`docker ${pruneBuildCacheArgs({ INFRA_PRUNE_KEEP_STORAGE_GB: '0' } as any).join(' ')}`).toBe('docker builder prune -af --filter until=72h');
  });

  it('UNARMED: a dry-run receipt with the exact command and the disk reading, no docker call, host-keyed target, receipted', async () => {
    process.env.BOX_NAME = 'box-c';
    const r = await runInfraAction({ kind: 'prune_build_cache', reason: '[INFRA ALERT — disk warning] box-c 88%' });
    expect(r).toMatchObject({ ok: true, kind: 'prune_build_cache', target: 'box-c', dryRun: true, executed: false });
    expect(r.desired).toMatchObject({ host: 'box-c', command: PRUNE_CMD, until: '72h', keepStorageGb: 20, diskPctBefore: 88 });
    expect(dockerCallsOf('builder')).toHaveLength(0);
    // no userId needed — it targets the HOST, and the cooldown key is per host
    expect(mockRedisSet).toHaveBeenCalledWith('infra-action:cooldown:prune_build_cache:box-c', expect.any(String), expect.objectContaining({ NX: true, EX: 6 * 3600 }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'infra_action', meta: expect.objectContaining({ action: 'prune_build_cache', target: 'box-c', dryRun: true, executed: false }),
    }));
  });

  it('ARMED (INFRA_ACTIONS_ENABLED=1): runs the prune through the docker CLI and reports the reclaimed space', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    const r = await runInfraAction({ kind: 'prune_build_cache', userId: UID, reason: 'disk 88%' });
    expect(r).toMatchObject({ ok: true, executed: true, dryRun: false });
    expect(dockerCallsOf('builder')).toEqual([['builder', 'prune', '-af', '--filter', 'until=72h', '--keep-storage', '20GB']]);
    expect(r.desired).toMatchObject({ reclaimed: '12.3GB', command: PRUNE_CMD });
    expect(parseReclaimedSpace('Total reclaimed space: 1.5 GB')).toBe('1.5GB');
    expect(parseReclaimedSpace('')).toBeNull();
    // the receipt's telemetry carries the command + reclaimed + disk readings (the prod verification query reads meta->>'action')
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'infra_action', meta: expect.objectContaining({ action: 'prune_build_cache', executed: true, command: PRUNE_CMD, reclaimed: '12.3GB', diskPctBefore: 88, diskPctAfter: 88 }),
    }));
    // an executed prune KEEPS its 6 h window
    expect(mockRedisDel).not.toHaveBeenCalled();
  });

  it('cooldown release (review fix): an unarmed dry-run hands the 6 h window back, so arming inside it executes; a 403 receipt releases it too', async () => {
    process.env.BOX_NAME = 'box-c';
    const held = useNxRedis();
    const dry = await runInfraAction({ kind: 'prune_build_cache', reason: 'disk 88%' });
    expect(dry).toMatchObject({ dryRun: true, executed: false });
    expect(mockRedisDel).toHaveBeenCalledWith('infra-action:cooldown:prune_build_cache:box-c');
    expect(held.has('infra-action:cooldown:prune_build_cache:box-c')).toBe(false);
    // ops arms the lever within the window: the next call runs the prune
    process.env.INFRA_ACTIONS_ENABLED = '1';
    const armed = await runInfraAction({ kind: 'prune_build_cache', reason: 'disk 88% (armed)' });
    expect(armed).toMatchObject({ ok: true, executed: true });
    expect(armed.cooldown).toBeUndefined();
    expect(dockerCallsOf('builder')).toHaveLength(1);
    // …and an executed prune is now on cooldown for real
    const repeat = await runInfraAction({ kind: 'prune_build_cache', reason: 'again' });
    expect(repeat.cooldown).toBe(true);
    expect(dockerCallsOf('builder')).toHaveLength(1);
    // a proxy 403 (nothing reclaimed) releases the window as well
    held.clear();
    builderErr = 'Error response from daemon: <h1>403 Forbidden</h1>';
    const failed = await runInfraAction({ kind: 'prune_build_cache', reason: 'disk' });
    expect(failed.ok).toBe(false);
    expect(held.has('infra-action:cooldown:prune_build_cache:box-c')).toBe(false);
    builderErr = '';
    const retry = await runInfraAction({ kind: 'prune_build_cache', reason: 'after BUILD=1' });
    expect(retry).toMatchObject({ ok: true, executed: true });
  });

  it('cooldown:true on a repeat inside the 6 h window (fail-CLOSED — a Redis hiccup is a cooldown, not a free volley)', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    mockRedisSet.mockResolvedValueOnce(null);
    const r = await runInfraAction({ kind: 'prune_build_cache', reason: 'again' });
    expect(r.cooldown).toBe(true);
    expect(r.executed).toBe(false);
    expect(dockerCallsOf('builder')).toHaveLength(0);
  });

  it('ARMED through the filtered socket proxy: a 403 is an honest ok:false receipt that names BUILD=1', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    builderErr = 'Error response from daemon: <h1>403 Forbidden</h1>';
    const r = await runInfraAction({ kind: 'prune_build_cache', reason: 'disk' });
    expect(r.ok).toBe(false);
    expect(r.executed).toBe(false);
    expect(r.error).toMatch(/BUILD=1/);
  });
});

describe('propose_volume_growth — READ + PROPOSE only (WI-Q, 2026-09-25)', () => {
  it('never calls a mutating exec: statfs only, no docker at all; returns the exact modify-volume command + the cost line', async () => {
    process.env.BOX_NAME = 'box-a';
    const r = await runInfraAction({ kind: 'propose_volume_growth', reason: 'still 88% after prune' });
    expect(r).toMatchObject({ ok: true, kind: 'propose_volume_growth', target: 'box-a', executed: true, dryRun: false });
    expect(dockerCalls).toHaveLength(0); // not even `docker info` — the web boxes' DOCKER_HOST path is dead
    // 200 GiB volume, 176 used (88%) ⇒ next 50 GiB step landing ≤70%: ceil(176/0.7=251.4 → /50 → 6)*50 = 300 GiB
    expect(r.desired).toMatchObject({
      proposalOnly: true, volumePath: '/', host: 'box-a', currentSizeGib: 200, usedGib: 176, usedPct: 88,
      proposedSizeGib: 300, deltaGib: 100, usdPerGibMonth: 0.088, monthlyCostDeltaUsd: 8.8,
      command: 'aws ec2 modify-volume --region ca-central-1 --volume-id <volume-id> --size 300',
    });
    expect(String(r.desired?.discoverCommand)).toContain('describe-volumes');
    expect(String(r.desired?.discoverCommand)).toContain('<instance-id of box-a>');
    expect(String(r.desired?.followUp)).toMatch(/growpart.*resize2fs/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'infra_action', meta: expect.objectContaining({ action: 'propose_volume_growth', executed: true, dryRun: false }),
    }));
  });

  it('fills the volume id from the request or the per-box env; the instance id from the per-box env; the rate from env', async () => {
    process.env.INFRA_INSTANCE_ID = 'i-0ae7b0080cfc5caf8';
    process.env.INFRA_GP3_USD_PER_GB_MONTH = '0.1';
    const r = await runInfraAction({ kind: 'propose_volume_growth', volumeId: 'vol-0123456789abcdef0', reason: 'x' });
    expect(r.desired).toMatchObject({ volumeId: 'vol-0123456789abcdef0', instanceId: 'i-0ae7b0080cfc5caf8', monthlyCostDeltaUsd: 10 });
    expect(String(r.desired?.command)).toBe('aws ec2 modify-volume --region ca-central-1 --volume-id vol-0123456789abcdef0 --size 300');
    expect(String(r.desired?.discoverCommand)).toContain('Values=i-0ae7b0080cfc5caf8');
    process.env.INFRA_VOLUME_ID = 'vol-envdefault00';
    const r2 = await runInfraAction({ kind: 'propose_volume_growth', reason: 'x' });
    expect(r2.desired?.volumeId).toBe('vol-envdefault00');
  });

  it('pure math: a nearly-empty volume still proposes current + one step; the ceiling is the volume size', () => {
    const p = proposeVolumeGrowth({ totalBytes: 100 * GIB, freeBytes: 90 * GIB, usedBytes: 10 * GIB }, { volumePath: '/', host: 'box-b', usdPerGibMonth: 0.088 });
    expect(p).toMatchObject({ currentSizeGib: 100, proposedSizeGib: 150, deltaGib: 50, monthlyCostDeltaUsd: 4.4, usedPct: 10 });
  });

  it('an unreadable mount / a relative or traversing path is an honest refusal, never a throw', async () => {
    statfsFail = true;
    const r = await runInfraAction({ kind: 'propose_volume_growth', volumePath: '/mnt/nope', reason: 'x' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/statfs \/mnt\/nope/);
    statfsFail = false;
    mockRedisSet.mockResolvedValue('OK');
    const bad = await runInfraAction({ kind: 'propose_volume_growth', volumePath: '../etc', reason: 'x' });
    expect(bad.ok).toBe(false);
    expect(bad.refused).toMatch(/absolute mount path/);
    expect(dockerCalls).toHaveLength(0);
  });
});

describe('sweepEnvRedInfraStreak — the watchdog trigger (ticket c12239c1 ASK #2/#5)', () => {
  const seedReds = (rows: Array<{ sessionId: string | null }>) => mockLoopMetricFind.mockResolvedValue(rows);

  it('REPLAY 2026-09-09: ≥3 env reds across ≥2 sessions in 30m ⇒ env_probe THEN dev_container_resize for the owner within one cadence', async () => {
    seedReds([{ sessionId: 'sess-a' }, { sessionId: 'sess-b' }, { sessionId: 'sess-a' }]);
    mockChatFind.mockResolvedValue([
      { id: 'sess-a', userId: UID }, { id: 'sess-b', userId: UID },
    ]);
    const s = await sweepEnvRedInfraStreak({ now: new Date('2026-09-10T03:00:00Z') });
    expect(s.tripped).toBe(true);
    expect(s.reds).toBe(3);
    expect(s.sessions).toBe(2);
    expect(s.users).toEqual([UID]);
    // Probe executed for real (read-only); resize proposed as a dry-run receipt (unarmed).
    const kinds = s.receipts.map((r) => r.kind);
    expect(kinds).toEqual(['env_probe', 'dev_container_resize']);
    expect(s.receipts[0]).toMatchObject({ kind: 'env_probe', executed: true, dryRun: false });
    expect(s.receipts[1]).toMatchObject({ kind: 'dev_container_resize', executed: false, dryRun: true });
    // The sweep summary itself is receipted.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'infra_action', meta: expect.objectContaining({ action: 'env_red_streak_sweep', reds: 3, sessions: 2 }),
    }));
  });

  it('armed sweep: the streak resize executes docker update (the fix the lanes could not apply)', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    seedReds([{ sessionId: 'sess-a' }, { sessionId: 'sess-b' }, { sessionId: 'sess-b' }]);
    mockChatFind.mockResolvedValue([{ id: 'sess-a', userId: UID }, { id: 'sess-b', userId: UID }]);
    const s = await sweepEnvRedInfraStreak();
    expect(s.tripped).toBe(true);
    expect(s.receipts[1]).toMatchObject({ kind: 'dev_container_resize', executed: true, dryRun: false });
    expect(dockerCallsOf('update')).toEqual([['update', '--memory', String(24 * GIB), DEV] /* 2026-09-29: host-derived (32 GiB − 8) */]);
  });

  it('below threshold: 2 reds (count), or 3 reds in ONE session (blast radius), never trips', async () => {
    seedReds([{ sessionId: 'sess-a' }, { sessionId: 'sess-b' }]);
    expect((await sweepEnvRedInfraStreak()).tripped).toBe(false);
    seedReds([{ sessionId: 'sess-a' }, { sessionId: 'sess-a' }, { sessionId: 'sess-a' }]);
    expect((await sweepEnvRedInfraStreak()).tripped).toBe(false);
    expect(mockChatFind).not.toHaveBeenCalled();
  });

  it('sweep-level NX dedupe: a second volley inside the window is suppressed once', async () => {
    seedReds([{ sessionId: 'sess-a' }, { sessionId: 'sess-b' }, { sessionId: 'sess-a' }]);
    mockRedisSet.mockResolvedValueOnce(null); // sweep key already held
    const s = await sweepEnvRedInfraStreak();
    expect(s.tripped).toBe(false);
    expect(s.note).toMatch(/dedupe/);
    expect(mockChatFind).not.toHaveBeenCalled();
  });
});
