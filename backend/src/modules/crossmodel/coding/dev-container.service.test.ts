/**
 * Pins the HARDENED shared tailnet dev container (post-adversarial-review of
 * PR #326): the admin-only enable gate, tri-state preference reads, the
 * fall-back-to-null contract, out-of-band key delivery + JOIN VERIFICATION
 * (running ≠ joined — a non-joining container is torn down), the
 * name-conflict-adopt create race, and the reaper's skip-on-unknown +
 * in-flight-run guards.
 */
process.env.DEV_JOIN_VERIFY_TIMEOUT_MS = '150';
process.env.DEV_JOIN_VERIFY_POLL_MS = '20';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  userPreferences: { findUnique: jest.fn() },
  user: { findUnique: jest.fn() },
  chatCodingState: { findMany: jest.fn(async () => []) },
  agentRun: { count: jest.fn(async () => 0), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedis = { set: jest.fn(async (): Promise<string | null> => 'OK'), del: jest.fn(async () => 1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockMkdir = jest.fn(async () => undefined);
jest.mock('fs/promises', () => ({ __esModule: true, mkdir: (...a: any[]) => (mockMkdir as any)(...a) }));

const mockIsDockerAvailable = jest.fn(async () => true);
// Hermeticity (4f7263e4 follow-up, 2026-10-10): isoInPlay() reads the REAL volume at
// CODING_WORKSPACE_ROOT — on a prod-co-located dev container that path holds the ISO
// canary's per-user subtree, so the ISO branch runs here and calls
// containerMountDestinations(name) (an inspect) that this mock previously omitted →
// TypeError → the outer catch → null (CI is green only because ITS volume is empty).
// Mock it (null = "unknown mounts" — devMountsMatch returns true, never churn).
jest.mock('./container.service', () => ({
  __esModule: true,
  isDockerAvailable: (...a: any[]) => (mockIsDockerAvailable as any)(...a),
  SANDBOX_HOMES_ROOT: '/tmp/digby-sandbox-homes',
  containerMountDestinations: jest.fn(async () => null),
}));
jest.mock('./workspace.service', () => ({ __esModule: true, CODING_WORKSPACE_ROOT: '/app/coding-workspaces' }));
// Hermeticity (61d33af9 lane): these suites were written against an EMPTY
// workspace volume (the CI premise — empty ⇒ isoInPlay() stays off and the
// whole_volume plan rides without docker-inspect). A sandbox whose shared
// volume carries per-user subtree keys flips isoInPlay() on (workspace-layout
// reads the LIVE volume) and routes ensureUserDevContainer through mount-plan
// + inspect paths the tests never mock. Pin the volume read to the empty-
// volume premise the suite was authored under.
jest.mock('./workspace-layout', () => ({
  __esModule: true,
  ...jest.requireActual('./workspace-layout'),
  listSubtreeKeysSync: () => [],
}));

const mockGetCred = jest.fn(async (): Promise<string | null> => 'tskey-auth-abc123');
jest.mock('./credentials.service', () => ({ __esModule: true, getCredentialValueDecrypted: (...a: any[]) => (mockGetCred as any)(...a) }));

// execFile: script the docker sub-invocations by args.
const dockerCalls: string[][] = [];
let psRunning = false;        // `ps --filter name` → running?
let psExists = false;         // `ps -a --filter name` → exists?
let tailnetJoins = true;      // `exec <name> tailscale status --json` → Running?
let runError: string | null = null; // stderr for `run` (null = success)
let loginUrlScrape = '';      // stdout for the login-URL grep exec (feedback 0bd05198)
let egressMarked = false;     // probeEgressState bash -c marker probe → MARKER (scoped layout)
let inspectMemoryBytes = '';  // `inspect -f {{.HostConfig.Memory}}` → current cgroup memory (db25c401)
let infoStdout = '';          // `info --format {{.MemTotal}} {{.NCPU}}` → host capacity (c12239c1)
let labelPsNames = '';        // `ps --filter label=digby.dev.container` → running dev containers (c12239c1)
jest.mock('child_process', () => ({
  __esModule: true,
  execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
    dockerCalls.push(args);
    const nameFilter = args.find(a => a.startsWith('name=^'));
    const wantName = nameFilter ? nameFilter.replace(/^name=\^/, '').replace(/\$$/, '') : '';
    let stdout = '';
    let err: any = null;
    if (args[0] === 'info') stdout = infoStdout;
    else if (args[0] === 'ps' && args.includes('-a')) stdout = psExists ? wantName : '';
    else if (args[0] === 'ps' && args.some(a => a.startsWith('label='))) stdout = labelPsNames;
    else if (args[0] === 'ps') stdout = psRunning ? wantName : '';
    else if (args[0] === 'inspect') stdout = inspectMemoryBytes;
    else if (args[0] === 'run' && runError) err = Object.assign(new Error('run failed'), { stderr: runError });
    else if (args[0] === 'exec' && args.includes('status')) {
      if (tailnetJoins) stdout = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.1.2.3'], HostName: 'digby-dev' } });
      else err = Object.assign(new Error('not running'), { stderr: 'no status' });
    }
    else if (args[0] === 'exec' && args.includes('bash')) stdout = egressMarked ? 'MARKER\n' : '';
    else if (args[0] === 'exec' && args.some(a => a.includes('ts-up.log'))) stdout = loginUrlScrape;
    const child: any = { stdin: { write: () => {}, end: () => {} } };
    process.nextTick(() => cb(err, stdout, err ? String(err.stderr) : ''));
    return child;
  },
}));

import {
  devContainerName, devContainerEnabled, devContainerEnabledTriState,
  ensureUserDevContainer, reapDisabledDevContainers, restartUserDevContainer,
  restartDevTailnet, getDevContainerStatus, parseMemoryBytes,
  resolveDevMemoryCeiling, dockerHostCapacity, convergeDevContainerCeilings, memoryGrowArgs, parseMemoryInspect,
  SESSION_USER_SCRIPT,
} from './dev-container.service';

let uidCounter = 0;
const freshUid = () => `user-${String(uidCounter++).padStart(4, '0')}-xxxx`; // distinct per test: the health memo is per-user

beforeEach(() => {
  jest.clearAllMocks();
  dockerCalls.length = 0;
  psRunning = false; psExists = false; tailnetJoins = true; runError = null; loginUrlScrape = ''; inspectMemoryBytes = '';
  infoStdout = ''; labelPsNames = '';
  delete process.env.CODING_DEV_CONTAINER_MEMORY;
  mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: true });
  mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
  mockPrisma.chatCodingState.findMany.mockResolvedValue([]);
  mockPrisma.agentRun.count.mockResolvedValue(0);
  mockPrisma.agentRun.findMany.mockResolvedValue([]);
  mockIsDockerAvailable.mockResolvedValue(true);
  mockGetCred.mockResolvedValue('tskey-auth-abc123');
  mockRedis.set.mockResolvedValue('OK');
});

describe('dev-container.service (hardened)', () => {
  it('names the container per-user (12-char prefix)', () => {
    expect(devContainerName('user123456789abc')).toBe('digby-dev-user12345678');
  });

  it('ADMIN-ONLY gate: enabled pref alone is NOT enough (cross-tenant guard until per-user volume layout)', async () => {
    const u = freshUid();
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'USER' });
    expect(await devContainerEnabled(u)).toBe(false);
    expect(await ensureUserDevContainer(u)).toBeNull();
    expect(dockerCalls).toHaveLength(0);
    mockPrisma.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
    expect(await devContainerEnabled(freshUid())).toBe(true);
  });

  it('tri-state: DB error reads as UNKNOWN (null) — never as disabled', async () => {
    mockPrisma.userPreferences.findUnique.mockRejectedValue(new Error('db blip'));
    expect(await devContainerEnabledTriState(freshUid())).toBeNull();
    expect(await devContainerEnabledTriState('anonymous')).toBe(false);
  });

  it('returns null (fallback) when disabled / docker down', async () => {
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: false });
    expect(await ensureUserDevContainer(freshUid())).toBeNull();
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: true });
    mockIsDockerAvailable.mockResolvedValue(false);
    expect(await ensureUserDevContainer(freshUid())).toBeNull();
  });

  it('starts an existing stopped container without recreating it', async () => {
    const u = freshUid();
    psExists = true;
    expect(await ensureUserDevContainer(u)).toBe(devContainerName(u));
    expect(dockerCalls.some(c => c[0] === 'start')).toBe(true);
    expect(dockerCalls.some(c => c[0] === 'run')).toBe(false);
  });

  /**
   * Ticket db25c401 — the 4 GiB dev-container cgroup OOM-killed co-tenant
   * verify chains (tsc SIGKILLed → exit 137, empty output). The ceiling is
   * raised to 12g by default (env-tunable) AND live-grown on already-running
   * legacy containers via `docker update` (grow-only, never shrink).
   */
  it('parseMemoryBytes parses docker memory strings; garbage → 0', () => {
    expect(parseMemoryBytes('8g')).toBe(8 * 1024 ** 3);
    expect(parseMemoryBytes('512m')).toBe(512 * 1024 ** 2);
    expect(parseMemoryBytes('4294967296')).toBe(4294967296);
    expect(parseMemoryBytes('1.5g')).toBe(Math.floor(1.5 * 1024 ** 3));
    expect(parseMemoryBytes('2GiB')).toBe(2 * 1024 ** 3);
    expect(parseMemoryBytes('')).toBe(0);
    expect(parseMemoryBytes('lots')).toBe(0);
  });

  it('live-GROWS a running legacy 4g container to the configured ceiling (db25c401)', async () => {
    const u = freshUid();
    psRunning = true;
    inspectMemoryBytes = String(4 * 1024 ** 3); // legacy 4 GiB container
    expect(await ensureUserDevContainer(u)).toBe(devContainerName(u));
    const upd = dockerCalls.find(c => c[0] === 'update');
    expect(upd).toBeTruthy();
    expect(upd).toContain('--memory');
    expect(upd).toContain(String(12 * 1024 ** 3)); // 12g default
    expect(upd).toContain(devContainerName(u));
  });

  it('2026-09-29: a live grow of a container with a positive MemorySwap passes --memory-swap (docker refuses --memory above it)', async () => {
    const u = freshUid();
    psRunning = true;
    inspectMemoryBytes = `${4 * 1024 ** 3} ${6 * 1024 ** 3}`; // 4g memory, 6g memory+swap
    expect(await ensureUserDevContainer(u)).toBe(devContainerName(u));
    const upd = dockerCalls.find(c => c[0] === 'update' && c.includes(devContainerName(u)))!;
    expect(upd).toEqual(['update', '--memory', String(12 * 1024 ** 3), '--memory-swap', String(14 * 1024 ** 3), devContainerName(u)]);
  });

  it('never SHRINKS a live container (ceiling already ≥ configured) and never updates on unknown (0) inspect', async () => {
    const u = freshUid();
    psRunning = true;
    inspectMemoryBytes = String(16 * 1024 ** 3); // already bigger than 12g
    expect(await ensureUserDevContainer(u)).toBe(devContainerName(u));
    expect(dockerCalls.some(c => c[0] === 'update')).toBe(false);
    const u2 = freshUid();
    psRunning = true;
    inspectMemoryBytes = ''; // inspect unparsable → no-op
    expect(await ensureUserDevContainer(u2)).toBe(devContainerName(u2));
    expect(dockerCalls.some(c => c[0] === 'update' && c.includes(devContainerName(u2)))).toBe(false);
  });

  it('honors CODING_DEV_CONTAINER_MEMORY on create AND on the live-grow target', async () => {
    process.env.CODING_DEV_CONTAINER_MEMORY = '16g';
    const u = freshUid();
    const name = await ensureUserDevContainer(u);
    expect(name).toBe(devContainerName(u));
    const runCall = dockerCalls.find(c => c[0] === 'run')!;
    const memIdx = runCall.indexOf('--memory');
    expect(memIdx).toBeGreaterThan(-1);
    expect(runCall[memIdx + 1]).toBe('16g');

    const u2 = freshUid();
    psRunning = true;
    inspectMemoryBytes = String(12 * 1024 ** 3); // 12g container, configured 16g → grow
    expect(await ensureUserDevContainer(u2)).toBe(devContainerName(u2));
    const upd = dockerCalls.find(c => c[0] === 'update' && c.includes(devContainerName(u2)));
    expect(upd).toBeTruthy();
    expect(upd).toContain(String(16 * 1024 ** 3));
  });

  it('creates, pre-creates the ts-state dir, delivers the key OUT OF BAND, and verifies the join', async () => {
    const u = freshUid();
    const name = await ensureUserDevContainer(u);
    expect(name).toBe(devContainerName(u));
    // ts-state subpath pre-created backend-side (review F5: docker refuses missing subpaths)
    expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining(`devcontainers/${u.slice(0, 12)}/ts-state`), { recursive: true });
    const runCall = dockerCalls.find(c => c[0] === 'run')!;
    expect(runCall.join(' ')).toContain('volume-subpath=devcontainers/');
    expect(runCall.join(' ')).toContain('tun=userspace-networking');
    // key NEVER on argv — delivered via stdin exec to a root-0600 file
    expect(dockerCalls.every(c => !c.join(' ').includes('tskey-auth-abc123'))).toBe(true);
    expect(dockerCalls.some(c => c.join(' ').includes('/run/secrets/ts_authkey'))).toBe(true);
    // join verified before reporting usable
    expect(dockerCalls.some(c => c[0] === 'exec' && c.includes('status'))).toBe(true);
  });

  it('tears the container down and falls back when the tailnet join never completes (running ≠ joined)', async () => {
    const u = freshUid();
    tailnetJoins = false;
    expect(await ensureUserDevContainer(u)).toBeNull();
    // created, then removed on verify failure
    expect(dockerCalls.some(c => c[0] === 'run')).toBe(true);
    expect(dockerCalls.some(c => c[0] === 'rm' && c.includes(devContainerName(u)))).toBe(true);
  });

  it('no-key create: short baked key wait, NO teardown — pending URL-flow authorization (review B1, PR #473)', async () => {
    const u = freshUid();
    mockGetCred.mockResolvedValue(null);   // no TS_AUTHKEY configured
    tailnetJoins = false;                   // and no persisted identity joining
    const name = await ensureUserDevContainer(u);
    // adopted as pending-authorization — never null, never rm'd (the keyed
    // teardown above would have destroyed it ~60s before the URL-flow elif
    // fired inside the old flat 120s key wait)
    expect(name).toBe(devContainerName(u));
    expect(dockerCalls.some(c => c[0] === 'rm')).toBe(false);
    const runCall = dockerCalls.find(c => c[0] === 'run')!;
    const script = runCall[runCall.length - 1];
    expect(script).toContain('while [ $i -lt 5 ]');        // short wait baked
    expect(script).not.toContain('while [ $i -lt 120 ]');  // keyed wait NOT baked
    expect(script).toContain('--timeout=30s');             // URL-flow elif present
    // no key was ever delivered
    expect(dockerCalls.every(c => !c.join(' ').includes('tskey-auth-abc123'))).toBe(true);
  });

  it('create race: a docker name-conflict ADOPTS the winner — never rm -f', async () => {
    const u = freshUid();
    runError = `Conflict. The container name "/${devContainerName(u)}" is already in use`;
    psRunning = false;
    // after the conflict the winner's container comes up
    const p = ensureUserDevContainer(u);
    psRunning = true;
    expect(await p).toBe(devContainerName(u));
    expect(dockerCalls.some(c => c[0] === 'rm')).toBe(false);
  });

  it('waits for a concurrent creator instead of racing when the Redis lock is held', async () => {
    const u = freshUid();
    mockRedis.set.mockResolvedValue(null); // lock held elsewhere
    psRunning = false;
    const p = ensureUserDevContainer(u);
    setTimeout(() => { psRunning = true; }, 30);
    expect(await p).toBe(devContainerName(u));
    expect(dockerCalls.some(c => c[0] === 'run')).toBe(false);
  }, 10_000);

  it('reaper: skips UNKNOWN prefs (DB error) and users with in-flight runs; reaps only explicit disable', async () => {
    // one labeled container owned by user "gone-user"
    const label = 'digby.dev.container';
    const psLine = `digby-dev-gone-user-00\tgone-user-0000`;
    // reuse the execFile mock: `ps -a --filter label` returns our line
    const origPush = dockerCalls.push.bind(dockerCalls);
    (dockerCalls as any).push = (args: string[]) => origPush(args);
    const psaListIdx = () => dockerCalls.findIndex(c => c[0] === 'ps' && c.some(a => a.includes(label)));
    // Patch: label listing goes through the same mock — emulate via psExists trick is not enough;
    // instead, monkey-patch the mock's stdout by running with a custom scenario:
    const cp = require('child_process');
    const realExec = cp.execFile;
    cp.execFile = (_cmd: string, args: string[], _opts: any, cb: any) => {
      dockerCalls.push(args);
      let stdout = '';
      if (args[0] === 'ps' && args.some(a => String(a).includes(label))) stdout = psLine;
      process.nextTick(() => cb(null, stdout, ''));
      return { stdin: { write: () => {}, end: () => {} } };
    };
    try {
      // 1) UNKNOWN pref (DB error) → skip
      mockPrisma.userPreferences.findUnique.mockRejectedValue(new Error('db blip'));
      await reapDisabledDevContainers();
      expect(dockerCalls.some(c => c[0] === 'rm')).toBe(false);
      // 2) explicit disable but a run in flight → skip
      dockerCalls.length = 0;
      mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: false });
      mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1' }]);
      mockPrisma.agentRun.count.mockResolvedValue(1);
      await reapDisabledDevContainers();
      expect(dockerCalls.some(c => c[0] === 'rm')).toBe(false);
      // 3) explicit disable, idle → reap
      dockerCalls.length = 0;
      mockPrisma.agentRun.count.mockResolvedValue(0);
      await reapDisabledDevContainers();
      expect(dockerCalls.some(c => c[0] === 'rm')).toBe(true);
    } finally {
      cp.execFile = realExec;
    }
  });

  it('restart refuses while a run is in flight (rm -f under a live exec bricks the run) — and names the blocking sessions + Reconnect (2026-10-13)', async () => {
    const u = freshUid();
    mockPrisma.chatCodingState.findMany.mockResolvedValue([{ id: 's1', title: 'Schooltime nightly' }, { id: 's2', title: 'Idle lane' }]);
    mockPrisma.agentRun.count.mockResolvedValue(1);
    mockPrisma.agentRun.findMany.mockResolvedValue([{ sessionId: 's1' }]);
    const st = await restartUserDevContainer(u);
    expect(st.note).toContain('1 coding run is still going');
    expect(st.note).toContain('“Schooltime nightly”');
    expect(st.note).not.toContain('Idle lane');
    expect(st.note).toContain('use Reconnect');
    expect(dockerCalls.some(c => c[0] === 'rm')).toBe(false);
  });

  it('keyed boot join retries ONCE with --force-reauth when the plain join leaves the node short of Running (2026-10-13)', async () => {
    const u = freshUid();
    await ensureUserDevContainer(u);
    const runCall = dockerCalls.find(c => c[0] === 'run')!;
    const script: string = runCall[runCall.length - 1];
    const lines = script.split('\n');
    const first = lines.findIndex(l => l.startsWith('if [ -n "$TS_KEY" ]; then tailscale up --authkey'));
    const retry = lines.findIndex(l => l.includes('--force-reauth'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(retry).toBe(first + 1);
    expect(lines[first]).toContain('--timeout=90s');
    expect(lines[retry]).toMatch(/^if \[ -n "\$TS_KEY" \] && ! tailscale status --json/);
    expect(lines[retry]).toContain('--timeout=60s');
    // the key is unset right after both joins
    expect(lines[retry + 1]).toBe('unset TS_KEY');
  });

  it('boot script waits for the key, never bakes it in, and avoids the global ALL_PROXY footgun', async () => {
    const u = freshUid();
    await ensureUserDevContainer(u);
    const runCall = dockerCalls.find(c => c[0] === 'run')!;
    const script = runCall[runCall.length - 1];
    expect(script).toContain('while [ $i -lt 120 ]'); // poll-wait closes the read-before-write race
    expect(script).toContain('rm -f /run/secrets/ts_authkey');
    expect(script).not.toContain('ALL_PROXY');        // opt-in DIGBY_TAILNET_PROXY instead
    expect(script).toContain('DIGBY_TAILNET_PROXY');
    expect(script).not.toContain('tskey-');
  });

  it('boot script bakes the tssh/tcurl helpers — SOCKS5-routed, idempotently installed, no key material', async () => {
    const u = freshUid();
    await ensureUserDevContainer(u);
    const runCall = dockerCalls.find(c => c[0] === 'run')!;
    const script = runCall[runCall.length - 1];
    // helpers exist and route via the tailnet SOCKS5 proxy (ticket d3a983ca)
    expect(script).toContain('/usr/local/bin/tssh');
    expect(script).toContain('/usr/local/bin/tcurl');
    expect(script).toContain('nc -x localhost:1055 %h %p');       // tssh ProxyCommand
    expect(script).toContain('socks5h://localhost:1055');         // tcurl proxy
    expect(script).toContain('chmod 755 /usr/local/bin/tssh /usr/local/bin/tcurl');
    // nc install guarded like the tailscale install — a prebuilt CODING_DEV_IMAGE skips it (ticket 793f5130)
    expect(script).toContain('command -v nc >/dev/null 2>&1 ||');
    expect(script).toContain('netcat-openbsd');
    // the helper lines carry NO auth-key material — they're static text
    const helperLines = script.split('\n').filter((l: string) => l.includes('tssh') || l.includes('tcurl'));
    expect(helperLines.length).toBeGreaterThanOrEqual(3); // two printf writes + chmod
    for (const l of helperLines) expect(l).not.toMatch(/tskey|TS_KEY|ts_authkey/);
  });

  it('boot script gives session uid 1001 a passwd/group row so ssh can start (2026-10-13)', async () => {
    const u = freshUid();
    await ensureUserDevContainer(u);
    const runCall = dockerCalls.find(c => c[0] === 'run')!;
    const lines: string[] = runCall[runCall.length - 1].split('\n');
    // right after `set -e`, before any install step that could stall
    expect(lines[0]).toBe('set -e');
    expect(lines[1]).toMatch(/^getent passwd 1001 .*:x:1001:1001:Digby session:\/tmp:\/bin\/bash.*>> \/etc\/passwd; \} \|\| true$/);
    expect(lines[2]).toMatch(/^getent group 1001 .*>> \/etc\/group; \} \|\| true$/);
    expect(SESSION_USER_SCRIPT.split('\n')).toEqual([lines[1], lines[2]]);
  });

  it('a RUNNING container gets the session-user rows once per process, without a restart', async () => {
    const u = freshUid();
    psRunning = true;
    await ensureUserDevContainer(u);
    const userExecs = () => dockerCalls.filter(c => c[0] === 'exec' && c[c.length - 1] === SESSION_USER_SCRIPT);
    expect(userExecs()).toHaveLength(1);
    expect(userExecs()[0]).toEqual(['exec', expect.stringMatching(/^digby-dev-/), 'sh', '-c', SESSION_USER_SCRIPT]);
    expect(dockerCalls.some(c => c[0] === 'run' || c[0] === 'rm')).toBe(false);
  });

  it('boot script falls back to URL-flow join when no key arrives and no identity persists (feedback 0bd05198)', async () => {
    const u = freshUid();
    await ensureUserDevContainer(u);
    const runCall = dockerCalls.find(c => c[0] === 'run')!;
    const script = runCall[runCall.length - 1];
    // auth-key path unchanged and still first
    expect(script).toContain('if [ -n "$TS_KEY" ]; then tailscale up --authkey="$TS_KEY" --hostname="digby-dev" --accept-dns=false');
    // URL-flow elif: only when tailscaled is NOT already Running, non-blocking --timeout
    expect(script).toContain('elif ! tailscale status --json');
    expect(script).toContain('"BackendState":"Running"');
    expect(script).toContain('tailscale up --hostname="digby-dev" --accept-dns=false --timeout=30s');
    // the elif branch carries NO key material (scope to the segment after
    // 'elif' on that one line — the if-branch legitimately references both)
    const line = script.split('\n').find((l: string) => l.includes('--timeout=30s'))!;
    const afterElif = line.split('elif')[1];
    expect(afterElif).toContain('--timeout=30s');
    expect(afterElif).not.toContain('--authkey');
    expect(afterElif).not.toContain('$TS_KEY');
  });

  it('status surfaces the tailnet login URL when the node is not Running and NO key is saved (feedback 0bd05198)', async () => {
    const u = freshUid();
    mockGetCred.mockResolvedValue(null);
    psRunning = true; psExists = true; tailnetJoins = false;
    loginUrlScrape = 'https://login.tailscale.com/a/abc123xyz\n';
    const st = await getDevContainerStatus(u);
    expect(st.running).toBe(true);
    expect(st.tailscale?.state).not.toBe('Running');
    expect(st.tailscale?.loginUrl).toBe('https://login.tailscale.com/a/abc123xyz');
    expect(st.tailscale?.loginPending).toBe(true);
  });

  it('with a saved key the login URL is WITHHELD — the fix is Reconnect, never a personal login (2026-10-13)', async () => {
    const u = freshUid();
    psRunning = true; psExists = true; tailnetJoins = false;
    loginUrlScrape = 'https://login.tailscale.com/a/abc123xyz\n';
    const st = await getDevContainerStatus(u);
    expect(st.keyConfigured).toBe(true);
    expect(st.tailscale?.loginUrl).toBeUndefined();
    expect(dockerCalls.some(c => c[0] === 'exec' && c.some(a => a.includes('ts-up.log')))).toBe(false);
  });

  it('status omits loginUrl when the node IS Running (no scrape exec issued)', async () => {
    const u = freshUid();
    psRunning = true; psExists = true; tailnetJoins = true;
    const st = await getDevContainerStatus(u);
    expect(st.tailscale?.state).toBe('Running');
    expect(st.tailscale?.loginUrl).toBeUndefined();
    expect(dockerCalls.some(c => c[0] === 'exec' && c.some(a => a.includes('ts-up.log')))).toBe(false);
  });
});

describe('restartDevTailnet (tailnet session-recourse, platform task 2026-08-28)', () => {
  it('bounces tailscaled via ONE root exec, then verifies the re-join (no rm/run/start)', async () => {
    psRunning = true; psExists = true;
    const st = await restartDevTailnet(freshUid());
    expect(st.note).toContain('re-joined (Running)');
    // exactly one bounce exec carrying the /proc capture→kill→respawn/re-exec script
    const bounce = dockerCalls.filter((c) => c[0] === 'exec' && c[2] === 'sh' && c[3] === '-c');
    expect(bounce).toHaveLength(1);
    const script = bounce[0][4];
    expect(script).toContain('tailscaled*--tun*');
    expect(script).toContain('kill -9');
    expect(script).toContain('nohup');
    expect(script).toContain('--statedir=/var/lib/digby-tailscale');
    // re-join verified via tailscale status
    expect(dockerCalls.some((c) => c[0] === 'exec' && c.includes('status'))).toBe(true);
    // ticket db587fc1: the result carries the daemon's real socket + posture
    // proxy ports so agents can adapt explicitly instead of declaring a failed
    // restart when the defaults lag. Test env has no CODING_EGRESS_SECRET →
    // legacy layout → 1055/1056 (review B1: keyed on the container's actual
    // layout, never the server's current env).
    expect(st.tailscale?.socket).toBe('/var/run/tailscale/tailscaled.sock');
    expect(st.tailscale?.socks5).toBe('localhost:1055');
    expect(st.tailscale?.httpProxy).toBe('localhost:1056');
    // mid-run-safe: never removes/recreates/(re)starts the container itself
    expect(dockerCalls.some((c) => ['rm', 'run', 'start', 'restart'].includes(c[0]))).toBe(false);
  });

  it('scoped-layout container reports the upstream port, never 1055 (review B1: keyed on actual layout)', async () => {
    psRunning = true; psExists = true;
    process.env.CODING_EGRESS_SECRET = 'test-pepper';
    egressMarked = true;
    try {
      const st = await restartDevTailnet(freshUid());
      expect(st.tailscale?.socket).toBe('/var/run/tailscale/tailscaled.sock');
      expect(st.tailscale?.socks5).toBe('127.0.0.1:1057');
      expect(st.tailscale?.httpProxy).toBeUndefined();
    } finally {
      delete process.env.CODING_EGRESS_SECRET;
      egressMarked = false;
    }
  });

  it('not-enabled account: reports it without a bounce (status reads only)', async () => {
    mockPrisma.userPreferences.findUnique.mockResolvedValue({ devContainerEnabled: false });
    const st = await restartDevTailnet(freshUid());
    expect(st.note).toContain('not enabled');
    expect(dockerCalls.some((c) => c[0] === 'exec')).toBe(false);
    expect(dockerCalls.some((c) => ['rm', 'run', 'start'].includes(c[0]))).toBe(false);
  });

  it('container not running: advises the full restart, no bounce exec', async () => {
    psRunning = false; psExists = false;
    const st = await restartDevTailnet(freshUid());
    expect(st.note).toContain('not running');
    expect(dockerCalls.some((c) => c[0] === 'exec')).toBe(false);
  });

  it('join-verify timeout: still returns status with an honest note', async () => {
    psRunning = true; psExists = true; tailnetJoins = false;
    process.env.DEV_JOIN_VERIFY_TIMEOUT_MS = '5';
    process.env.DEV_JOIN_VERIFY_POLL_MS = '1';
    try {
      const st = await restartDevTailnet(freshUid());
      expect(st.note).toContain('did not reach Running');
      expect(dockerCalls.some((c) => c[0] === 'exec' && c[2] === 'sh')).toBe(true);
    } finally {
      delete process.env.DEV_JOIN_VERIFY_TIMEOUT_MS;
      delete process.env.DEV_JOIN_VERIFY_POLL_MS;
    }
  });

  it('boot script carries the pid-guarded tailscaled respawn loop (self-healing wedge recourse)', async () => {
    await ensureUserDevContainer(freshUid());
    const runCall = dockerCalls.find((c) => c[0] === 'run')!;
    expect(runCall.join(' ')).toContain('digby-ts-loop.pid');
    expect(runCall.join(' ')).toContain('while true; do tailscaled --tun=userspace-networking');
    expect(runCall.join(' ')).toContain('--socks5-server=localhost:1055');
    // B1 regression pin (PR review 2026-08-28): the boot script runs `set -e`, which
    // backgrounded subshells inherit — without `|| true` the first non-zero tailscaled
    // exit kills the loop instead of respawning. Pin the guard so a refactor can't hollow it.
    expect(runCall.join(' ')).toContain('|| true; sleep 2; done');
  });
});

describe('host-derived memory ceiling (ticket c12239c1 ASK #3)', () => {
  const GIB = 1024 ** 3;

  it('default: env unset + unknown host → the 12g floor (the 03:30Z human fix)', () => {
    expect(resolveDevMemoryCeiling(null)).toBe(12 * GIB);
  });
  it('env 16g honored above the floor when the host is unknown (db25c401 hardening preserved)', () => {
    process.env.CODING_DEV_CONTAINER_MEMORY = '16g';
    expect(resolveDevMemoryCeiling(null)).toBe(16 * GIB);
  });
  it('floor beats a SMALLER explicit config on a big host (owner: min 12g)', () => {
    process.env.CODING_DEV_CONTAINER_MEMORY = '8g';
    expect(resolveDevMemoryCeiling(64 * GIB)).toBe(12 * GIB);
  });
  it('host cap (host−4 GiB) clamps an oversized config', () => {
    process.env.CODING_DEV_CONTAINER_MEMORY = '64g';
    expect(resolveDevMemoryCeiling(32 * GIB)).toBe(28 * GIB);
  });
  it('a tiny host lands BELOW the floor via the cap — safety wins over the floor', () => {
    expect(resolveDevMemoryCeiling(8 * GIB)).toBe(4 * GIB);
  });
  it('2026-09-29: env unset + a 32 GiB host → HOST-DERIVED ceiling (host − 8 GiB = 24g), never below the floor', () => {
    expect(resolveDevMemoryCeiling(32 * GIB)).toBe(24 * GIB);
    expect(resolveDevMemoryCeiling(33089572864)).toBe(33089572864 - 8 * GIB); // box C's docker MemTotal
    expect(resolveDevMemoryCeiling(16 * GIB)).toBe(12 * GIB); // 16 − 8 = 8 < floor → 12g (cap 12g)
  });
  it('2026-09-29: an EXPLICIT env value keeps the old rule — no host derivation on top of it', () => {
    process.env.CODING_DEV_CONTAINER_MEMORY = '16g';
    expect(resolveDevMemoryCeiling(64 * GIB)).toBe(16 * GIB);
  });
  it('2026-09-29: memoryGrowArgs keeps the swap allowance when MemorySwap is a positive limit; 0 / -1 / missing add no flag', () => {
    expect(memoryGrowArgs(24 * GIB, 12 * GIB, 14 * GIB)).toEqual(['--memory', String(24 * GIB), '--memory-swap', String(26 * GIB)]);
    expect(memoryGrowArgs(24 * GIB, 12 * GIB, 0)).toEqual(['--memory', String(24 * GIB)]);
    expect(memoryGrowArgs(24 * GIB, 12 * GIB, -1)).toEqual(['--memory', String(24 * GIB)]);
    expect(memoryGrowArgs(24 * GIB, 12 * GIB, null)).toEqual(['--memory', String(24 * GIB)]);
    expect(memoryGrowArgs(24 * GIB, 12 * GIB, 12 * GIB)).toEqual(['--memory', String(24 * GIB), '--memory-swap', String(24 * GIB)]);
  });
  it('2026-09-29: parseMemoryInspect reads "<memory> <swap>" and tolerates a single field', () => {
    expect(parseMemoryInspect(`${12 * GIB} ${14 * GIB}\n`)).toEqual({ memory: 12 * GIB, swap: 14 * GIB });
    expect(parseMemoryInspect(String(4 * GIB))).toEqual({ memory: 4 * GIB, swap: null });
    expect(parseMemoryInspect('').memory || 0).toBe(0); // unparsable ⇒ 0 ⇒ the caller's cur > 0 guard no-ops (the old Number('') = 0)
  });

  it('dockerHostCapacity parses MemTotal/NCPU and degrades to nulls on an unreadable daemon', async () => {
    infoStdout = `${32 * GIB} 8`;
    expect(await dockerHostCapacity()).toEqual({ memTotalBytes: 32 * GIB, ncpu: 8 });
    infoStdout = '';
    expect(await dockerHostCapacity()).toEqual({ memTotalBytes: null, ncpu: null });
  });

  it('convergeDevContainerCeilings live-grows EVERY running dev container to the host-derived ceiling (one host read)', async () => {
    labelPsNames = 'digby-dev-aaaaaaaaaa\ndigby-dev-bbbbbbbbbb';
    infoStdout = `${32 * GIB} 8`;
    inspectMemoryBytes = String(4 * GIB); // legacy 4g containers, like 2026-09-09
    await convergeDevContainerCeilings();
    const updates = dockerCalls.filter((c) => c[0] === 'update');
    expect(updates).toEqual([
      // 2026-09-29: env unset + a 32 GiB host ⇒ host-derived 24g
      ['update', '--memory', String(24 * GIB), 'digby-dev-aaaaaaaaaa'],
      ['update', '--memory', String(24 * GIB), 'digby-dev-bbbbbbbbbb'],
    ]);
    expect(dockerCalls.filter((c) => c[0] === 'info')).toHaveLength(1); // host read ONCE, not per container
  });

  it('convergeDevContainerCeilings: no running dev containers → zero docker mutations', async () => {
    labelPsNames = '';
    await convergeDevContainerCeilings();
    expect(dockerCalls.filter((c) => c[0] === 'update' || c[0] === 'info')).toHaveLength(0);
  });
});
