/**
 * Replay pin for ticket e72b88f9 / backlog DC-1 (2026-10-14): the stray
 * session-spawned tailscaled that lived 33 days in the SHARED dev container.
 *
 * The incident shape (probe lane d66291a7, read-only report 2026-10-14T04:48Z):
 * pid 3763549, uid 1001, started 2026-09-11, launched from a FINISHED
 * session's worktree scratch dir
 * (/app/coding-workspaces/worktrees/a8976e11-…/.scratch-qb2key/ts-recovery/),
 * serving SOCKS5 on localhost:1057 — while the PLATFORM tailscaled (uid 0,
 * statedir /var/lib/digby-tailscale, ports 1055/1056) kept the real egress.
 * Its "General SOCKS server failure" answers fed a false wedged-egress
 * diagnosis; infra_action reap_orphans covered only tsc/jest.
 *
 * What this pins:
 *   1. KIND — reap_orphans_session_daemons lists session-spawned daemons in
 *      the dev container (receipt = the surfacing half of the ask) and reaps
 *      ONLY the orphans: worktree cwd + non-root uid + age ≥ floor + owning
 *      session has no queued/running run. Platform daemons are excluded by
 *      uid AND by the egress args SHAPE (DC-1: identify by function, never by
 *      a remembered pid — it respawned 1588133 → 1663628 the same night).
 *   2. LIVENESS — a daemon whose session has a queued/running run is never a
 *      victim; an unreadable liveness read is FAIL-CLOSED (nothing reaped).
 *   3. KILL SWITCH — INFRA_SESSION_DAEMON_REAP_DISABLED=1 refuses the reap.
 *   4. SURFACING — env_probe reports the candidates, so a lane diagnosing a
 *      "wedged egress" sees the stray daemon's provenance in the standing
 *      read-only probe.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...args: any[]) => mockRecordLoopMetric(...args),
  LOOP_METRIC_KINDS: { INFRA_ACTION: 'infra_action', VERIFY_ENV_RED: 'verify_env_red' },
}));

// prisma: daemonSessionIdsWithInFlightRun reads agentRun; the sweep reads
// loopMetrics + chats. Scripted per test.
const mockAgentRunFind = jest.fn(async (): Promise<any[]> => []);
const mockLoopMetricFind = jest.fn(async (): Promise<any[]> => []);
const mockChatFind = jest.fn(async (): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    agentRun: { findMany: (...a: any[]) => (mockAgentRunFind as any)(...a) },
    loopMetric: { findMany: (...a: any[]) => (mockLoopMetricFind as any)(...a) },
    crossModelChat: { findMany: (...a: any[]) => (mockChatFind as any)(...a) },
  },
}));

const mockRedisSet = jest.fn(async (..._a: any[]): Promise<string | null> => 'OK');
const mockRedisDel = jest.fn(async (..._a: any[]): Promise<number> => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => (mockRedisSet as any)(...a), del: (...a: any[]) => (mockRedisDel as any)(...a) },
}));

const mockIsDockerAvailable = jest.fn(async () => true);
jest.mock('../coding/container.service', () => ({ __esModule: true, isDockerAvailable: (...a: any[]) => (mockIsDockerAvailable as any)(...a) }));
jest.mock('../coding/workspace.service', () => ({ __esModule: true, CODING_WORKSPACE_ROOT: '/app/coding-workspaces' }));
jest.mock('../coding/credentials.service', () => ({ __esModule: true, getCredentialValueDecrypted: jest.fn(async () => null) }));

let statfsBlocks = (200 * 1024 ** 3) / 4096;
let statfsBfree = (24 * 1024 ** 3) / 4096;
jest.mock('fs/promises', () => ({
  __esModule: true,
  mkdir: jest.fn(async () => undefined),
  statfs: jest.fn(async () => ({ bsize: 4096, blocks: statfsBlocks, bfree: statfsBfree, bavail: statfsBfree })),
}));

// execFile: script the docker CLI. The dev container's process table is the
// 2026-10-14 04:4xZ box state (probe lane d66291a7's reading).
const dockerCalls: string[][] = [];
let hostMemTotal = 32 * 1024 ** 3;
let hostNcpu = 8;
let containerMemBytes = String(12 * 1024 ** 3);
let containerRunning = true;
let oomKillCount = 3;
/** `ps -eo pid,uid,etimes,args` inside the dev container. */
let containerPs = '';
/** the `readlink /proc/<pid>/cwd` round-trip: lines of "<pid> <cwd>". */
let containerCwds = '';
/** when true, every `docker exec` call fails (scan-error paths). */
let containerExecFails = false;
jest.mock('child_process', () => ({
  __esModule: true,
  execFile: (_cmd: string, args: string[], _opts: any, cb: any) => {
    dockerCalls.push(args);
    let stdout = '';
    let err: any = null;
    if (containerExecFails && args[0] === 'exec') {
      err = Object.assign(new Error('docker exec failed'), { stderr: 'docker exec failed' });
    } else if (args[0] === 'info') stdout = `${hostMemTotal} ${hostNcpu}`;
    else if (args[0] === 'inspect' && args.some((a) => a.includes('State.Running'))) {
      if (!containerRunning) err = Object.assign(new Error('no such container'), { stderr: 'no such container' });
      else stdout = `true ${containerMemBytes} 0`;
    } else if (args[0] === 'inspect') stdout = containerMemBytes;
    else if (args[0] === 'exec' && args.some((a) => a.includes('memory.current'))) {
      stdout = `${Number(containerMemBytes) - 2_000_000}\n${containerMemBytes}\nlow 0\nhigh 0\nmax 0\noom ${oomKillCount}\noom_kill ${oomKillCount}\n`;
    } else if (args[0] === 'exec' && args.some((a) => a.includes('ps -eo'))) stdout = containerPs;
    else if (args[0] === 'exec' && args.some((a) => a.includes('readlink /proc'))) stdout = containerCwds;
    else if (args[0] === 'exec') stdout = '';
    const child: any = { stdin: { write: () => {}, end: () => {} } };
    process.nextTick(() => cb(err, stdout, err ? String(err.stderr) : ''));
    return child;
  },
}));

import {
  runInfraAction,
  filterSessionDaemonLines, attachDaemonCwds, sessionDaemonReapCommand, sessionDaemonMinAgeSec,
  PLATFORM_EGRESS_ARGS_PATTERN, INFRA_ACTION_KINDS,
} from './infra-actions.service';

const UID = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';
const DEV = 'digby-dev-83e4fbf9-e18';
const DAY = 86400;

// The incident cast (ps + cwd readings as the 2026-10-14 box presented them):
const ORPHAN_PID = '3763549'; // the 33-day stray tailscaled (uid 1001, :1057)
const ORPHAN_SESSION = 'a8976e11-77af-4b7c-8ca5-f2f3f31cb903'; // FINISHED session
const ORPHAN_CWD = `/app/coding-workspaces/worktrees/${ORPHAN_SESSION}/.scratch-qb2key/ts-recovery`;
const LIVE_PID = '4001'; // a daemon a LIVE session owns (in-flight run) — never a victim
const LIVE_SESSION = '11111111-2222-3333-4444-555555555555';
const LIVE_CWD = `/app/coding-workspaces/worktrees/${LIVE_SESSION}`;
const YOUNG_PID = '4002'; // session daemon under the age floor — not yet a victim
const YOUNG_SESSION = '99999999-8888-7777-6666-555555555555';
const YOUNG_CWD = `/app/coding-workspaces/worktrees/${YOUNG_SESSION}`;

function incidentPs(): string {
  return [
    // the incident orphan: 33 days old, uid 1001, the SOCKS5 :1057 shape
    `${ORPHAN_PID} 1001 ${33 * DAY} tailscaled --tun=userspace-networking --socks5-server=localhost:1057 --socket=/dev/shm/tsr.sock`,
    // the PLATFORM egress daemon: uid 0 + the statedir/ports SHAPE (DC-1) — twice excluded
    `1588133 0 ${9 * DAY} tailscaled --statedir=/var/lib/digby-tailscale --socks5-server=localhost:1055 --outbound-http-proxy-listen=localhost:1056`,
    // belt-and-braces: the egress SHAPE run NON-root (cwd /) still never reaps
    `4003 1001 ${9 * DAY} tailscaled --statedir=/var/lib/digby-tailscale --socks5-server=localhost:1055`,
    // a LIVE session's daemon (2 days) — its session has a queued/running run
    `${LIVE_PID} 1001 ${2 * DAY} python3 -m http.server 8080`,
    // a young session daemon (1 h) — under the floor
    `${YOUNG_PID} 1001 ${3600} node server.js`,
    // the tsc one-shot class — its own reap kind, excluded here
    `4004 1001 ${4000} node /wt/backend/node_modules/.bin/tsc --noEmit`,
    // uid-0 generic root process, cwd / — not session-spawned
    `4005 0 ${5 * DAY} cron -f`,
  ].join('\n');
}

function incidentCwds(): string {
  return [
    `${ORPHAN_PID} ${ORPHAN_CWD}`,
    '1588133 /',
    '4003 /',
    `${LIVE_PID} ${LIVE_CWD}`,
    `${YOUNG_PID} ${YOUNG_CWD}`,
    '4004 /wt/backend',
    '4005 /',
    '', // the trailing echo
  ].join('\n');
}

const dockerCallsOf = (verb: string) => dockerCalls.filter((a) => a[0] === verb);
const execCmds = () => dockerCallsOf('exec').map((a) => a.join(' '));

beforeEach(() => {
  jest.clearAllMocks();
  dockerCalls.length = 0;
  hostMemTotal = 32 * 1024 ** 3; hostNcpu = 8;
  containerMemBytes = String(12 * 1024 ** 3);
  containerRunning = true; oomKillCount = 3;
  containerPs = incidentPs(); containerCwds = incidentCwds();
  containerExecFails = false;
  delete process.env.INFRA_ACTIONS_ENABLED;
  delete process.env.INFRA_SESSION_DAEMON_MIN_AGE_SEC;
  delete process.env.INFRA_SESSION_DAEMON_REAP_DISABLED;
  delete process.env.CODING_WORKSPACE_ROOT;
  mockRedisSet.mockReset(); mockRedisSet.mockResolvedValue('OK');
  mockRedisDel.mockReset(); mockRedisDel.mockResolvedValue(1);
  // standing box state: the LIVE session has a queued/running run (that is
  // what makes its daemon live) — tests that orphan it override this.
  mockAgentRunFind.mockReset(); mockAgentRunFind.mockResolvedValue([{ sessionId: LIVE_SESSION }]);
  mockLoopMetricFind.mockReset(); mockLoopMetricFind.mockResolvedValue([]);
  mockChatFind.mockReset(); mockChatFind.mockResolvedValue([]);
});

describe('pure parsing — the incident classification', () => {
  it('filterSessionDaemonLines: keeps the uid-1001 daemon, drops uid 0, the egress SHAPE, and tsc/jest', () => {
    const { candidates, lines } = filterSessionDaemonLines(incidentPs());
    // every numeric line parsed; 7 processes in the fixture
    expect(lines).toHaveLength(7);
    const pids = candidates.map((c) => c.pid);
    expect(pids).toContain(ORPHAN_PID); // the orphan IS a candidate
    expect(pids).toContain(LIVE_PID); // liveness is a LATER gate, not the filter's
    expect(pids).toContain(YOUNG_PID); // age is a later gate too
    expect(pids).not.toContain('1588133'); // uid 0 platform daemon
    expect(pids).not.toContain('4003'); // egress SHAPE even non-root
    expect(pids).not.toContain('4004'); // tsc one-shot — its own class
    expect(pids).not.toContain('4005'); // uid 0
  });

  it('PLATFORM_EGRESS_ARGS_PATTERN matches the real platform daemon args (statedir + the 1055/1056 ports)', () => {
    expect(PLATFORM_EGRESS_ARGS_PATTERN.test('--statedir=/var/lib/digby-tailscale --socks5-server=localhost:1055')).toBe(true);
    expect(PLATFORM_EGRESS_ARGS_PATTERN.test('tailscaled --outbound-http-proxy-listen=localhost:1056')).toBe(true);
    // the ORPHAN's shape (worktree state, :1057) must NOT match the platform pattern
    expect(PLATFORM_EGRESS_ARGS_PATTERN.test('--socks5-server=localhost:1057 --socket=/dev/shm/tsr.sock')).toBe(false);
  });

  it('attachDaemonCwds: both workspace layouts attribute the owning session; non-worktree cwds drop', () => {
    const base = filterSessionDaemonLines(incidentPs()).candidates;
    // legacy layout (the incident): <root>/worktrees/<sid>/…
    const legacy = attachDaemonCwds(base, { [ORPHAN_PID]: ORPHAN_CWD, [LIVE_PID]: LIVE_CWD }, '/app/coding-workspaces');
    expect(legacy.find((c) => c.pid === ORPHAN_PID)?.sessionId).toBe(ORPHAN_SESSION);
    expect(legacy.find((c) => c.pid === LIVE_PID)?.sessionId).toBe(LIVE_SESSION);
    // per-user subtree layout: <root>/<userKey>/worktrees/<sid>/… (workspace-layout.ts)
    const subtree = attachDaemonCwds(base, {
      [ORPHAN_PID]: `/app/coding-workspaces/83e4fbf9-e18/worktrees/${ORPHAN_SESSION}/.scratch/ts-recovery`,
    }, '/app/coding-workspaces');
    expect(subtree.find((c) => c.pid === ORPHAN_PID)?.sessionId).toBe(ORPHAN_SESSION);
    // a cwd under the volume but NOT under a worktree (e.g. a repo mirror) is not a session daemon
    const mirror = attachDaemonCwds(base, { [ORPHAN_PID]: '/app/coding-workspaces/repos/abc.git' }, '/app/coding-workspaces');
    expect(mirror.find((c) => c.pid === ORPHAN_PID)).toBeUndefined();
    // review N1: the legacy sandbox-home layout (<root>/worktrees/.sandbox-home/<sid>)
    // attributes the OWNING session, never the '.sandbox-home' marker itself
    const sandbox = attachDaemonCwds(base, {
      [ORPHAN_PID]: `/app/coding-workspaces/worktrees/.sandbox-home/${ORPHAN_SESSION}/home`,
    }, '/app/coding-workspaces');
    expect(sandbox.find((c) => c.pid === ORPHAN_PID)?.sessionId).toBe(ORPHAN_SESSION);
    // N1 residual: a cwd ENDING at the marker itself (no session after it) must
    // yield NO candidate — the regex used to backtrack and capture '.sandbox-home'
    // as the id, which passes the liveness gate (no run ever has that id) and so
    // reaped the pid under a phantom session. Marker with AND without trailing
    // slash, in both workspace layouts.
    for (const bare of [
      '/app/coding-workspaces/worktrees/.sandbox-home',
      '/app/coding-workspaces/worktrees/.sandbox-home/',
      '/app/coding-workspaces/83e4fbf9-e18/worktrees/.sandbox-home',
    ]) {
      const phantom = attachDaemonCwds(base, { [ORPHAN_PID]: bare }, '/app/coding-workspaces');
      expect(phantom.find((c) => c.pid === ORPHAN_PID)).toBeUndefined();
    }
  });

  it('sessionDaemonReapCommand re-verifies EVERY gate at kill time (cwd case, non-root uid, age floor)', () => {
    const cmd = sessionDaemonReapCommand([ORPHAN_PID], DAY, '/app/coding-workspaces');
    expect(cmd).toContain('/app/coding-workspaces/worktrees/'); // cwd case pattern
    expect(cmd).toContain(`'*'/worktrees/'*`); // per-user subtree pattern
    expect(cmd).toContain('[ "$u" != "0" ]'); // uid re-check
    expect(cmd).toContain(`[ "$e" -ge ${DAY} ]`); // age re-check
    expect(cmd).toContain('kill -9');
  });

  it('the age floor defaults to 24 h and is env-tunable with a 10-min minimum', () => {
    expect(sessionDaemonMinAgeSec()).toBe(DAY);
    expect(sessionDaemonMinAgeSec({ INFRA_SESSION_DAEMON_MIN_AGE_SEC: '3600' } as any)).toBe(3600);
    expect(sessionDaemonMinAgeSec({ INFRA_SESSION_DAEMON_MIN_AGE_SEC: '60' } as any)).toBe(DAY); // < 600 → default
  });
});

describe('reap_orphans_session_daemons — the incident lever (ticket e72b88f9)', () => {
  it('is a registered infra kind', () => {
    expect(INFRA_ACTION_KINDS).toContain('reap_orphans_session_daemons');
  });

  it('DRY-RUN (unarmed): lists every session-spawned daemon and marks ONLY the finished-session orphan a victim', async () => {
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'replay e72b88f9' });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.executed).toBe(false);
    expect(r.target).toBe(DEV);
    // 3 session-spawned daemons exist (orphan + live-session + young); the
    // platform daemon, its non-root twin, the tsc one-shot and cron are not.
    expect(r.desired?.sessionDaemons).toBe(3);
    expect(r.desired?.sessionDaemonVictims).toBe(1); // ONLY the 33-day orphan
    expect(r.desired?.minAgeSec).toBe(DAY);
    const victims = (r.desired?.candidates as any[]).filter((c) => c.pid === ORPHAN_PID);
    expect(victims).toHaveLength(1);
    expect(victims[0]).toMatchObject({ session: ORPHAN_SESSION, cwd: ORPHAN_CWD, uid: '1001' });
    // no kill happened unarmed
    expect(execCmds().some((c) => c.includes('kill -9'))).toBe(false);
    // the receipt exists (the surfacing half)
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'infra_action', meta: expect.objectContaining({ action: 'reap_orphans_session_daemons', dryRun: true, executed: false }),
    }));
  });

  it('ARMED: reaps the orphan — the kill command re-verifies cwd + uid + age inside the container', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'replay e72b88f9' });
    expect(r.executed).toBe(true);
    const kill = execCmds().find((c) => c.includes('kill -9'));
    expect(kill).toBeDefined();
    expect(kill).toContain(ORPHAN_PID);
    expect(kill).not.toContain(LIVE_PID);   // live session — spared
    expect(kill).not.toContain(YOUNG_PID);  // under the floor — spared
    expect(kill).not.toContain('1588133');  // platform egress — spared
    expect(kill).not.toContain('4003');     // egress shape — spared
    expect(kill).toContain(`'*'/worktrees/'*`); // both layouts in the case pattern
  });

  it('LIVENESS: a daemon whose session has a queued/running run is never a victim', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    // standing fixture: LIVE_SESSION is in flight → its 2-day daemon is spared
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'live-session daemon' });
    expect(r.desired?.sessionDaemons).toBe(3);
    expect(r.desired?.sessionDaemonVictims).toBe(1); // the 33-day orphan only
    const kill = execCmds().find((c) => c.includes('kill -9'));
    expect(kill).toContain(ORPHAN_PID);
    expect(kill).not.toContain(LIVE_PID);
    // and once that run finishes (no in-flight rows), the aged daemon IS a victim
    mockAgentRunFind.mockResolvedValue([]);
    const r2 = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'run finished' });
    expect(r2.desired?.sessionDaemonVictims).toBe(2);
    const kill2 = execCmds().filter((c) => c.includes('kill -9')).pop();
    expect(kill2).toContain(LIVE_PID);
  });

  it('FAIL-CLOSED: an unreadable liveness read reaps NOTHING', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    mockAgentRunFind.mockRejectedValue(new Error('db down'));
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'db down' });
    expect(r.executed).toBe(false);
    expect(r.refused).toMatch(/fail-closed/);
    expect(r.desired?.livenessUnreadable).toBe(true);
    expect(execCmds().some((c) => c.includes('kill -9'))).toBe(false);
  });

  it('KILL SWITCH: INFRA_SESSION_DAEMON_REAP_DISABLED=1 refuses before any scan', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    process.env.INFRA_SESSION_DAEMON_REAP_DISABLED = '1';
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'switched off' });
    expect(r.executed).toBe(false);
    expect(r.refused).toMatch(/INFRA_SESSION_DAEMON_REAP_DISABLED/);
    expect(execCmds().some((c) => c.includes('readlink /proc'))).toBe(false); // no scan at all
  });

  it('clean container: an honest nothing-to-reap refusal with zero candidates', async () => {
    containerPs = `1588133 0 ${9 * DAY} tailscaled --statedir=/var/lib/digby-tailscale --socks5-server=localhost:1055`;
    containerCwds = '1588133 /';
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'clean' });
    expect(r.desired?.sessionDaemons).toBe(0);
    expect(r.refused).toMatch(/nothing to reap/);
    expect(r.executed).toBe(false);
  });

  it('AGE FLOOR is env-tunable: a 2-day finished-session daemon becomes a victim only past the floor', async () => {
    process.env.INFRA_SESSION_DAEMON_MIN_AGE_SEC = String(DAY); // 24 h floor
    mockAgentRunFind.mockResolvedValue([]); // both sessions finished
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'floor' });
    expect(r.desired?.sessionDaemons).toBe(3);
    expect(r.desired?.sessionDaemonVictims).toBe(2); // the 33-day orphan AND the 2-day finished-session daemon; the 1-h one is under the floor
  });

  // 2026-10-14 live E2E (fresh session 37b18a71 against the DEPLOYED backend):
  // the scan returned sessionDaemons:0 with dozens of qualifying uid-1001
  // worktree-cwd processes present — because `docker exec` (no -u) runs as
  // root and the dev container's default capability set LACKS CAP_SYS_PTRACE,
  // so every cross-uid readlink /proc/<pid>/cwd returns EACCES, every cwd
  // lands null and attachDaemonCwds drops every candidate. Both the cwd
  // round-trip and the kill must exec AS THE OWNING UID.
  it('E2E regression: the cwd round-trip AND the kill exec carry -u <owning uid> (root-default exec is cross-uid blind)', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    mockAgentRunFind.mockResolvedValue([]); // sessions finished → the 33-day orphan + the 2-day daemon are victims
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'replay 2026-10-14 E2E' });
    expect(r.executed).toBe(true);
    expect(r.desired?.sessionDaemonVictims).toBe(2);
    const readlinkCalls = dockerCallsOf('exec').filter((a) => a.some((x) => String(x).includes('readlink /proc')));
    expect(readlinkCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of readlinkCalls) {
      expect(call[1]).toBe('-u');
      expect(call[2]).toBe('1001'); // the sessions' uid — same-uid readlink needs no capability
    }
    const killCalls = dockerCallsOf('exec').filter((a) => a.some((x) => String(x).includes('kill -9')));
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of killCalls) {
      expect(call[1]).toBe('-u');
      expect(call[2]).toBe('1001'); // same-uid kill: no capability, and root never owns session daemons
    }
  });

  // review N1: grouping by uid must produce SEPARATE execs with DISJOINT pid
  // lists — a regression to a single all-pids exec (with one uid) would break
  // the capability model again (a uid-1001 exec cannot readlink a uid-1002 cwd).
  it('multi-uid candidates: one exec per uid, disjoint pid lists (review N1)', async () => {
    process.env.INFRA_ACTIONS_ENABLED = '1';
    mockAgentRunFind.mockResolvedValue([]); // both owning sessions finished
    const OTHER_SESSION = 'aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    containerPs = [
      `${ORPHAN_PID} 1001 ${33 * DAY} tailscaled --tun=userspace-networking --socks5-server=localhost:1057 --socket=/dev/shm/tsr.sock`,
      `4006 1002 ${40 * DAY} python3 devserver.py`,
    ].join('\n');
    containerCwds = [
      `${ORPHAN_PID} ${ORPHAN_CWD}`,
      `4006 /app/coding-workspaces/worktrees/${OTHER_SESSION}`,
      '',
    ].join('\n');
    const r = await runInfraAction({ kind: 'reap_orphans_session_daemons', userId: UID, reason: 'multi-uid grouping' });
    expect(r.desired?.sessionDaemons).toBe(2);
    expect(r.desired?.sessionDaemonVictims).toBe(2);
    const readlinkExecs = dockerCallsOf('exec').filter((a) => a.some((x) => String(x).includes("printf '%s '")));
    expect(readlinkExecs).toHaveLength(2);
    expect(readlinkExecs.map((a) => a[2]).sort()).toEqual(['1001', '1002']); // one per uid, -u at argv[1..2]
    const killExecs = dockerCallsOf('exec').filter((a) => a.some((x) => String(x).includes('kill -9')));
    expect(killExecs).toHaveLength(2);
    const killByUid = new Map(killExecs.map((a) => [String(a[2]), a.join(' ')]));
    expect(killByUid.get('1001')).toContain(ORPHAN_PID);
    expect(killByUid.get('1001')).not.toContain('4006');
    expect(killByUid.get('1002')).toContain('4006');
    expect(killByUid.get('1002')).not.toContain(ORPHAN_PID); // disjoint pid lists
  });
});

describe('env_probe surfacing — the standing read-only probe sees the class', () => {
  it('reports the session-spawned daemons (count + provenance) alongside the cgroup reading', async () => {
    const r = await runInfraAction({ kind: 'env_probe', userId: UID, reason: 'replay e72b88f9 wedge diagnosis' });
    expect(r.ok).toBe(true);
    expect(r.executed).toBe(true);
    expect(r.probe?.cgroup).toBeDefined();
    const sd = r.probe?.sessionDaemons as any;
    expect(sd.count).toBe(3);
    expect(sd.agedPastFloor).toBe(2); // orphan (33d) + live-session daemon (2d)
    expect(sd.minAgeSec).toBe(DAY);
    const orphan = sd.candidates.find((c: any) => c.pid === ORPHAN_PID);
    expect(orphan).toMatchObject({ session: ORPHAN_SESSION, cwd: ORPHAN_CWD });
    // the note names the reap lever — the lane's next step
    expect(String(sd.note)).toContain('reap_orphans_session_daemons');
  });

  it('omits the block entirely on a clean container (no noise)', async () => {
    containerPs = `1588133 0 ${9 * DAY} tailscaled --statedir=/var/lib/digby-tailscale`;
    containerCwds = '1588133 /';
    const r = await runInfraAction({ kind: 'env_probe', userId: UID, reason: 'clean' });
    expect(r.probe?.sessionDaemons).toBeUndefined();
  });

  it('a FAILED scan surfaces its error instead of a silent gap (review N4)', async () => {
    // make the in-container ps exec fail → scanSessionDaemons returns ok:false
    // → the probe must carry scanError, not a silent gap.
    containerExecFails = true;
    const r = await runInfraAction({ kind: 'env_probe', userId: UID, reason: 'scan error' });
    expect(r.probe?.sessionDaemons).toMatchObject({ scanError: expect.stringContaining('exec ps') });
  });
});
