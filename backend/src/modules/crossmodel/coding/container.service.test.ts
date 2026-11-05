/**
 * Tests for the container reaper's idle decision + safe defaults.
 * Docker + prisma are mocked; no daemon or DB required.
 */

process.env.CODING_CONTAINER_MODE = '1';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatCodingState: { findMany: jest.fn(), findUnique: jest.fn() },
    agentRun: { count: jest.fn() },
  },
}));

const fsAccessMock = jest.fn();
const fsStatfsMock = jest.fn();
const fsRmMock = jest.fn();
const fsMkdirMock = jest.fn();
jest.mock('fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('fs/promises'),
  access: (...args: any[]) => fsAccessMock(...args),
  statfs: (...args: any[]) => fsStatfsMock(...args),
  rm: (...args: any[]) => fsRmMock(...args),
  // Wrapper returns a real Promise so service-side `.catch()` chains work even
  // when the mock has no configured implementation (undefined is not thenable).
  mkdir: (...args: any[]) => Promise.resolve(fsMkdirMock(...args)),
}));

// Mock child_process.execFile so `docker ...` calls are intercepted.
const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

import prisma from '../../../config/database';
import {
  ensureSessionContainer, reapIdleContainers, execInContainer,
  isNoSpaceError, isNoSpaceSpawnError, workspaceVolumeUsage,
  buildOrphanReapScript, reapOrphanedBuildProcesses,
  __resetPreExecDiskGuardForTest, SOFT_CLEAN_NOOP_COOLDOWN_MS,
  isDockerAvailable, __resetDockerAvailabilityForTest, DOCKER_NEGATIVE_MEMO_MS,
  DOCKER_POSITIVE_MEMO_MS, DOCKER_STARTUP_PROBE_ATTEMPTS, dockerProbeStartupDelayMs,
  workspaceExecExposure, stopSessionContainer,
} from './container.service';

const mockedPrisma = prisma as unknown as {
  chatCodingState: { findMany: jest.Mock; findUnique: jest.Mock };
  agentRun: { count: jest.Mock };
};

// Helper: make execFile(cmd,args,opts,cb) resolve with given stdout based on args.
function dockerReturns(router: (args: string[]) => string) {
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
    cb(null, { stdout: router(args), stderr: '' });
  });
}

const removed: string[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  removed.length = 0;
});

describe('reapIdleContainers', () => {
  test('removes containers for idle (>24h) and unknown sessions, keeps fresh ones', async () => {
    const now = Date.now();
    const fresh = 'sess-fresh', idle = 'sess-idle', gone = 'sess-gone';
    dockerReturns((args) => {
      if (args[0] === 'info') return 'ok';
      // ps -a --filter label=... --format {{.Label ...}}
      if (args[0] === 'ps') return [fresh, idle, gone].join('\n');
      if (args[0] === 'rm') { removed.push(args[args.length - 1]); return ''; }
      return '';
    });
    mockedPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: fresh, updatedAt: new Date(now - 60_000) },            // 1 min ago → keep
      { id: idle, updatedAt: new Date(now - 25 * 3600 * 1000) },   // 25h ago → reap
      // `gone` not returned → unknown session → reap
    ]);

    await reapIdleContainers();

    // rm -f digby-code-<id> — the last arg is the container name.
    expect(removed.some(n => n.includes(idle.slice(0, 12)))).toBe(true);
    expect(removed.some(n => n.includes(gone.slice(0, 12)))).toBe(true);
    expect(removed.some(n => n.includes(fresh.slice(0, 12)))).toBe(false);
  });

  test('no containers → no prisma query, no removals', async () => {
    dockerReturns((args) => (args[0] === 'info' ? 'ok' : ''));
    await reapIdleContainers();
    expect(mockedPrisma.chatCodingState.findMany).not.toHaveBeenCalled();
    expect(removed).toHaveLength(0);
  });

  // Age-recycle (2026-08-19): self-scheduled sessions refresh updatedAt on every
  // heartbeat, so their containers never looked idle and grew multi-GB writable
  // layers for weeks. A >7d-old container is recycled when no run is in flight.
  test('age-recycles a never-idle container older than 7d when no run is in flight', async () => {
    const active = 'sess-scheduled';
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    dockerReturns((args) => {
      if (args[0] === 'info') return 'ok';
      if (args[0] === 'ps') return active;
      if (args[0] === 'inspect') return eightDaysAgo;
      if (args[0] === 'rm') { removed.push(args[args.length - 1]); return ''; }
      return '';
    });
    mockedPrisma.chatCodingState.findMany.mockResolvedValue([
      { id: active, updatedAt: new Date() }, // heartbeat-fresh — never idle
    ]);
    mockedPrisma.agentRun.count.mockResolvedValue(0);
    await reapIdleContainers();
    expect(mockedPrisma.agentRun.count).toHaveBeenCalledWith({
      where: { sessionId: active, status: { in: ['queued', 'running'] } },
    });
    expect(removed.some(n => n.includes(active.slice(0, 12)))).toBe(true);
  });

  test('never recycles mid-run: an in-flight agent run blocks the age-recycle', async () => {
    const active = 'sess-running';
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    dockerReturns((args) => {
      if (args[0] === 'info') return 'ok';
      if (args[0] === 'ps') return active;
      if (args[0] === 'inspect') return eightDaysAgo;
      if (args[0] === 'rm') { removed.push(args[args.length - 1]); return ''; }
      return '';
    });
    mockedPrisma.chatCodingState.findMany.mockResolvedValue([{ id: active, updatedAt: new Date() }]);
    mockedPrisma.agentRun.count.mockResolvedValue(1);
    await reapIdleContainers();
    expect(removed).toHaveLength(0);
  });

  test('a young container is neither idle-reaped nor age-recycled', async () => {
    const active = 'sess-young';
    dockerReturns((args) => {
      if (args[0] === 'info') return 'ok';
      if (args[0] === 'ps') return active;
      if (args[0] === 'inspect') return new Date(Date.now() - 3600 * 1000).toISOString();
      if (args[0] === 'rm') { removed.push(args[args.length - 1]); return ''; }
      return '';
    });
    mockedPrisma.chatCodingState.findMany.mockResolvedValue([{ id: active, updatedAt: new Date() }]);
    await reapIdleContainers();
    expect(mockedPrisma.agentRun.count).not.toHaveBeenCalled();
    expect(removed).toHaveLength(0);
  });
});

// --- uid-drift fix (nightly 2026-08-02) + durable sandbox HOME (e267b760) ---
// Runners previously ran as root (stock node:20 default) and wrote root-owned
// objects/paths into the shared volume, breaking the backend's uid-1001 git ops
// (128 snapshot fails/48h). BASE_CREATE pins --user 1001:1001, and HOME is the
// per-session DURABLE dir on the workspace volume — /tmp (the old HOME) is
// wiped aggressively + on every deploy, taking ~/.aws/~/.ssh/tool installs.
describe('ensureSessionContainer uid alignment', () => {
  test('creates the runner as uid 1001 with a durable per-session HOME', async () => {
    const sessionId = 'sess-uidalign-0001';
    const runArgs: string[][] = [];
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'run') runArgs.push(args);
      const out = args[0] === 'info' ? 'ok' : args[0] === 'exec' ? 'HEAD' : '';
      cb(null, { stdout: out, stderr: '' });
    });
    fsAccessMock.mockResolvedValue(undefined); // worktree + mirror exist → scoped mounts
    mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ projectId: 'proj-1' });

    const ok = await ensureSessionContainer(sessionId);

    expect(ok).toBe(true);
    expect(runArgs).toHaveLength(1);
    const args = runArgs[0];
    expect(args).toContain('--user');
    expect(args[args.indexOf('--user') + 1]).toBe('1001:1001');
    // Durable per-session HOME (e267b760) — never /tmp.
    const expectedHome = `/app/coding-workspaces/worktrees/.sandbox-home/${sessionId}`;
    const homeIdx = args.indexOf(`HOME=${expectedHome}`);
    expect(homeIdx).toBeGreaterThan(0);
    expect(args[homeIdx - 1]).toBe('-e');
    expect(args).not.toContain('HOME=/tmp');
    // …created BEFORE docker run (backend uid 1001 → runner-owned) …
    expect(fsMkdirMock).toHaveBeenCalledWith(expectedHome, { recursive: true });
    // …and mounted as a scoped subpath at its absolute path.
    expect(args.some((a) => typeof a === 'string'
      && a.includes(`target=${expectedHome}`)
      && a.includes(`volume-subpath=worktrees/.sandbox-home/${sessionId}`))).toBe(true);
  });
});

// --- Whole-volume fallback keeps HOME=/tmp (PR #359 review F2) ---
// A fallback-mounted session sees the WHOLE workspace volume — it must never
// get an on-volume home it (or another session) could read/poison.
describe('ensureSessionContainer fallback posture (F2)', () => {
  test('whole-volume fallback uses container-local HOME=/tmp, .sandbox-home tmpfs-masked', async () => {
    const sessionId = 'sess-fallback-0001';
    const runArgs: string[][] = [];
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'run') runArgs.push(args);
      const out = args[0] === 'info' ? 'ok' : args[0] === 'exec' ? 'HEAD' : '';
      cb(null, { stdout: out, stderr: '' });
    });
    fsAccessMock.mockRejectedValue(new Error('ENOENT')); // worktree/mirror missing → fallback
    mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ projectId: 'proj-1' });

    const ok = await ensureSessionContainer(sessionId);

    expect(ok).toBe(true);
    expect(runArgs).toHaveLength(1);
    const args = runArgs[0];
    const homeIdx = args.indexOf('HOME=/tmp');
    expect(homeIdx).toBeGreaterThan(0);
    expect(args[homeIdx - 1]).toBe('-e');
    // The ONLY .sandbox-home reference is the empty tmpfs mask over the root —
    // the fallback can neither read nor poison other sessions' homes (F2).
    const tmpfsIdx = args.indexOf('--tmpfs');
    expect(tmpfsIdx).toBeGreaterThan(0);
    expect(args[tmpfsIdx + 1]).toBe('/app/coding-workspaces/worktrees/.sandbox-home:rw,noexec,nosuid,size=64k');
    expect(args.filter((a) => typeof a === 'string' && a.includes('.sandbox-home'))).toHaveLength(1);
  });
});

// --- Pre-exec disk guard + recycle recovery (ticket dc05bc31, 2026-08-19 incident) ---
// A full workspace volume kills every docker exec at spawn (runc cannot write
// /tmp/runc-process*), leaving zero in-session recovery. The guard checks
// headroom BEFORE each exec (cleanup past 85%, recycle past 95%) and recycles
// + retries once when an exec still fails with the no-space signature.
describe('pre-exec disk guard (dc05bc31)', () => {
  const sessionId = 'sess-diskguard-01';
  const noSpace = () => Object.assign(new Error('exit 128'), {
    code: 128,
    stdout: '',
    stderr: 'OCI runtime exec failed: write /tmp/runc-process123: no space left on device',
  });
  /** Volume usage as a fraction, via the statfs mock (blocks=100). */
  const setUsage = (frac: number) => fsStatfsMock.mockResolvedValue({ blocks: 100, bavail: Math.round(100 * (1 - frac)) });
  /** Router for a healthy re-provision path: ps/ps -a empty → run → git ok. */
  const provisionRoutes = (args: string[], execs: string[][], removals: string[], runs: string[][]) => {
    if (args[0] === 'info') return 'ok';
    if (args[0] === 'ps') return ''; // not running / gone
    if (args[0] === 'rm') { removals.push(args[args.length - 1]); return ''; }
    if (args[0] === 'run') { runs.push(args); return ''; }
    if (args[0] === 'exec') { execs.push(args); return 'HEAD'; }
    return '';
  };

  beforeEach(() => {
    setUsage(0.5); // healthy by default
    fsAccessMock.mockResolvedValue(undefined); // worktree exists → scoped mount
    fsRmMock.mockResolvedValue(undefined);
    mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ projectId: null });
    // Review 2026-09-13 issue 8: the soft-cap wipe memo persists per container
    // across execs — every test starts with an empty memo.
    __resetPreExecDiskGuardForTest();
  });

  test('isNoSpaceError (advisory matcher) matches ENOSPC/runc text only', () => {
    expect(isNoSpaceError('OCI runtime exec failed: write /tmp/runc-process9: no space left on device')).toBe(true);
    expect(isNoSpaceError("dd: error writing 'x': No space left on device")).toBe(true);
    expect(isNoSpaceError('bash: foo: command not found\n[exit: 127]')).toBe(false);
    expect(isNoSpaceError('')).toBe(false);
    expect(isNoSpaceError(undefined)).toBe(false);
  });

  test('isNoSpaceSpawnError (auto-recycle gate): exit 128 + OCI/runc + ENOSPC in the stderr HEAD', () => {
    expect(isNoSpaceSpawnError('OCI runtime exec failed: write /tmp/runc-process9: no space left on device', 128)).toBe(true);
    // right text, wrong exit — a failing jest run of THIS repo's disk-guard
    // tests echoes the fixture inside code frames (exit 1): never recycle.
    expect(isNoSpaceSpawnError('OCI runtime exec failed: write /tmp/runc-process9: no space left on device', 1)).toBe(false);
    // exit 128 but the command's OWN ENOSPC report (no runc marker)
    expect(isNoSpaceSpawnError("dd: error writing 'x': No space left on device", 128)).toBe(false);
    // signature buried past the 500-char stderr head
    expect(isNoSpaceSpawnError('x'.repeat(600) + ' OCI runtime exec failed: write /tmp/runc-process9: no space left on device', 128)).toBe(false);
    expect(isNoSpaceSpawnError(undefined, 128)).toBe(false);
  });

  test('workspaceVolumeUsage returns the used fraction and fails open', async () => {
    setUsage(0.9);
    expect(await workspaceVolumeUsage()).toBeCloseTo(0.9);
    fsStatfsMock.mockRejectedValue(new Error('unsupported'));
    expect(await workspaceVolumeUsage()).toBeNull();
  });

  test('healthy disk: no cleanup exec, no note, plain result', async () => {
    const execs: string[][] = [];
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec') execs.push(args);
      cb(null, { stdout: args[0] === 'exec' ? 'hi\n' : 'ok', stderr: '' });
    });
    const r = await execInContainer(sessionId, 'echo hi', '/wt', 1000);
    expect(r.stdout).toBe('hi\n');
    expect(r.stderr).not.toContain('coding container:');
    expect(execs).toHaveLength(1); // the command only — no cleanup exec
  });

  test('soft pressure (>=85%): cleans /tmp + caches BEFORE the command exec', async () => {
    setUsage(0.9);
    const execs: string[][] = [];
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec') execs.push(args);
      cb(null, { stdout: 'ok', stderr: '' });
    });
    const r = await execInContainer(sessionId, 'echo hi', '/wt', 1000);
    expect(execs.length).toBe(2);
    // First exec is the cleanup (find /tmp … preserving digby-proc), then the command.
    expect(execs[0].join(' ')).toContain('find /tmp');
    expect(execs[0].join(' ')).toContain('digby-proc');
    expect(execs[1][execs[1].length - 1]).toBe('echo hi');
    expect(r.stderr).toContain('auto-cleaned');
  });

  test('the /tmp wipe keeps $HOME install homes (.local, bin) so tool installs survive to the verify call (ticket 6a8dddd3)', async () => {
    // The reported bug: with the volume chronically over the soft cap, the
    // pre-exec wipe ran before EVERY command and deleted pip --user installs
    // (HOME=/tmp → /tmp/.local) between the installing run_command and the
    // verify leg, which then misreported "tool not installed". The keep-list
    // must cover the documented install homes ($HOME/.local, $HOME/bin) as
    // well as the live background-process registry.
    setUsage(0.9);
    const execs: string[][] = [];
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec') execs.push(args);
      cb(null, { stdout: 'ok', stderr: '' });
    });
    await execInContainer(sessionId, 'echo hi', '/wt', 1000);
    const cleanup = execs[0].join(' ');
    expect(cleanup).toContain('! -name digby-proc');
    expect(cleanup).toContain('! -name .local');
    expect(cleanup).toContain('! -name bin');
  });

  // Review 2026-09-13 issue 8 (option B): with the volume chronically in the
  // soft band the wipe ran before EVERY exec — 1,386 '89% → 89%' no-ops in
  // 3.3h, each wiping the shared dev container's /tmp (= HOME) every ~9s. A
  // wipe that freed nothing is remembered per container and not repeated
  // inside the cooldown; a productive wipe stays eligible.
  describe('idempotent soft-cap wipe (review 2026-09-13 issue 8)', () => {
    const cleanupExecs = (execs: string[][]) => execs.filter(e => e.join(' ').includes('find /tmp'));
    const routeExecs = (execs: string[][]) => execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec') execs.push(args);
      cb(null, { stdout: 'ok', stderr: '' });
    });

    test('a NO-OP wipe (usage unchanged) is not repeated on the next exec: one cleanup exec, no second note', async () => {
      setUsage(0.9); // constant: the wipe frees nothing
      const execs: string[][] = [];
      routeExecs(execs);
      const first = await execInContainer(sessionId, 'echo one', '/wt', 1000);
      expect(first.stderr).toContain('auto-cleaned'); // the first wipe still runs + notes
      const second = await execInContainer(sessionId, 'echo two', '/wt', 1000);
      const third = await execInContainer(sessionId, 'echo three', '/wt', 1000);
      expect(cleanupExecs(execs)).toHaveLength(1); // wiped once, not three times
      expect(execs.map(e => e[e.length - 1])).toEqual(expect.arrayContaining(['echo one', 'echo two', 'echo three'])); // every command still ran
      expect(second.stderr).not.toContain('coding container:'); // no note when nothing was wiped
      expect(third.stderr).not.toContain('coding container:');
    });

    test('a PRODUCTIVE wipe (usage dropped) stays eligible: the next soft-band exec wipes again', async () => {
      const u = (frac: number) => ({ blocks: 100, bavail: Math.round(100 * (1 - frac)) });
      // exec 1: measure 0.90 → wipe → measure 0.85 (freed 5 pt); exec 2: measure 0.90 again → wipe again
      fsStatfsMock
        .mockResolvedValueOnce(u(0.90)).mockResolvedValueOnce(u(0.85))
        .mockResolvedValueOnce(u(0.90)).mockResolvedValueOnce(u(0.85));
      const execs: string[][] = [];
      routeExecs(execs);
      await execInContainer(sessionId, 'echo one', '/wt', 1000);
      const second = await execInContainer(sessionId, 'echo two', '/wt', 1000);
      expect(cleanupExecs(execs)).toHaveLength(2);
      expect(second.stderr).toContain('auto-cleaned');
    });

    test('the suppression EXPIRES: past the cooldown the wipe runs once more (a refilled /tmp gets cleaned)', async () => {
      setUsage(0.9);
      const execs: string[][] = [];
      routeExecs(execs);
      const realNow = Date.now;
      const t0 = realNow();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);
      try {
        await execInContainer(sessionId, 'echo one', '/wt', 1000);
        await execInContainer(sessionId, 'echo two', '/wt', 1000);
        expect(cleanupExecs(execs)).toHaveLength(1);
        nowSpy.mockReturnValue(t0 + SOFT_CLEAN_NOOP_COOLDOWN_MS + 1_000);
        const later = await execInContainer(sessionId, 'echo three', '/wt', 1000);
        expect(cleanupExecs(execs)).toHaveLength(2);
        expect(later.stderr).toContain('auto-cleaned');
      } finally {
        nowSpy.mockRestore();
      }
    });

    test('the memo is per CONTAINER: another session (own container) still gets its first wipe', async () => {
      setUsage(0.9);
      const execs: string[][] = [];
      routeExecs(execs);
      // Container names are `digby-code-<first 12 chars of the session id>` —
      // the second id must differ within those 12 chars to be a different container.
      const otherSession = 'other-sess-diskguard-02';
      await execInContainer(sessionId, 'echo one', '/wt', 1000);
      await execInContainer(sessionId, 'echo again', '/wt', 1000); // suppressed
      await execInContainer(otherSession, 'echo other', '/wt2', 1000); // different container → wipes
      const cleanups = cleanupExecs(execs);
      expect(cleanups).toHaveLength(2);
      expect(cleanups[0].join(' ')).toContain(sessionId.slice(0, 12));
      expect(cleanups[1].join(' ')).toContain(otherSession.slice(0, 12));
    });

    test('an unmeasurable AFTER (statfs failed) never suppresses — uncertainty is not a no-op', async () => {
      const u = (frac: number) => ({ blocks: 100, bavail: Math.round(100 * (1 - frac)) });
      fsStatfsMock
        .mockResolvedValueOnce(u(0.90)).mockRejectedValueOnce(new Error('statfs unsupported'))
        .mockResolvedValueOnce(u(0.90)).mockResolvedValueOnce(u(0.90));
      const execs: string[][] = [];
      routeExecs(execs);
      await execInContainer(sessionId, 'echo one', '/wt', 1000);
      await execInContainer(sessionId, 'echo two', '/wt', 1000);
      expect(cleanupExecs(execs)).toHaveLength(2);
    });
  });

  test('hard pressure (>=95%): recycles + re-provisions BEFORE the exec, prunes worktree artifacts', async () => {
    setUsage(0.97);
    const execs: string[][] = [], removals: string[] = [], runs: string[][] = [];
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      cb(null, { stdout: provisionRoutes(args, execs, removals, runs), stderr: '' });
    });
    const r = await execInContainer(sessionId, 'echo hi', '/wt', 1000);
    // rm -f of the old container, a fresh docker run, and worktree artifact prune.
    expect(removals.some(n => n.includes(sessionId.slice(0, 12)))).toBe(true);
    expect(runs).toHaveLength(1);
    expect(fsRmMock.mock.calls.some(c => String(c[0]).endsWith('/node_modules'))).toBe(true);
    expect(r.stderr).toContain('recycled the session container');
  });

  test('no-space exec failure: recycles and retries the command ONCE on a fresh container', async () => {
    const execs: string[][] = [], removals: string[] = [], runs: string[][] = [];
    let cmdAttempts = 0;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec' && args[args.length - 1] === 'echo hi') {
        cmdAttempts += 1;
        if (cmdAttempts === 1) return cb(noSpace());
        return cb(null, { stdout: 'hi\n', stderr: '' });
      }
      cb(null, { stdout: provisionRoutes(args, execs, removals, runs), stderr: '' });
    });
    const r = await execInContainer(sessionId, 'echo hi', '/wt', 1000);
    expect(cmdAttempts).toBe(2); // exactly one retry
    expect(r.stdout).toBe('hi\n');
    expect(removals.some(n => n.includes(sessionId.slice(0, 12)))).toBe(true);
    expect(runs).toHaveLength(1); // re-provisioned
    expect(r.stderr).toContain('automatically recycled');
  });

  test('no-space failure persisting after the recycle gives an honest terminal note (no loop)', async () => {
    const execs: string[][] = [], removals: string[] = [], runs: string[][] = [];
    let cmdAttempts = 0;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec' && args[args.length - 1] === 'echo hi') { cmdAttempts += 1; return cb(noSpace()); }
      cb(null, { stdout: provisionRoutes(args, execs, removals, runs), stderr: '' });
    });
    const r = await execInContainer(sessionId, 'echo hi', '/wt', 1000);
    expect(cmdAttempts).toBe(2); // tried once + one recycle-retry, never more
    expect(r.stderr).toContain('needs operator attention');
  });

  // PR #285 adversarial review (blocking): the recycle+retry must be gated on
  // an actual FAILURE carrying the runc SPAWN signature — anything else either
  // double-applies a succeeded command or destroys state over reported text.
  test('a SUCCESSFUL command whose stderr mentions ENOSPC is never recycled or retried', async () => {
    const execs: string[][] = [], removals: string[] = [], runs: string[][] = [];
    let cmdAttempts = 0;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec' && args[args.length - 1] === 'grep -r "no space left" /var/log') {
        cmdAttempts += 1;
        // exit 0 with ENOSPC-flavored text on stderr (e.g. diagnosing old logs)
        return cb(null, { stdout: '', stderr: 'grep: /var/log/x: earlier failure: no space left on device' });
      }
      cb(null, { stdout: provisionRoutes(args, execs, removals, runs), stderr: '' });
    });
    const r = await execInContainer(sessionId, 'grep -r "no space left" /var/log', '/wt', 1000);
    expect(cmdAttempts).toBe(1);
    expect(removals).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect(fsRmMock).not.toHaveBeenCalled();
    expect(r.stderr).not.toContain('coding container:');
  });

  test('a FAILED command reporting its own ENOSPC gets an advisory — never recycled or retried', async () => {
    const execs: string[][] = [], removals: string[] = [], runs: string[][] = [];
    let cmdAttempts = 0;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec' && args[args.length - 1] === 'dd if=/dev/zero of=big') {
        cmdAttempts += 1;
        return cb(Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: "dd: error writing 'big': No space left on device" }));
      }
      cb(null, { stdout: provisionRoutes(args, execs, removals, runs), stderr: '' });
    });
    const r = await execInContainer(sessionId, 'dd if=/dev/zero of=big', '/wt', 1000);
    expect(cmdAttempts).toBe(1); // never re-executed (may have partially run)
    expect(removals).toHaveLength(0);
    expect(fsRmMock).not.toHaveBeenCalled();
    expect(r.stderr).toContain('NOT retried automatically');
  });

  test('the spawn TEXT at a non-128 exit (failing-test code frame) does NOT trigger a recycle', async () => {
    const execs: string[][] = [], removals: string[] = [], runs: string[][] = [];
    let cmdAttempts = 0;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'exec' && args[args.length - 1] === 'npx jest disk') {
        cmdAttempts += 1;
        // jest exit 1; a code frame echoes this repo's disk-guard fixture text
        return cb(Object.assign(new Error('exit 1'), { code: 1, stdout: '', stderr: "● disk guard › …\n  Received stderr: 'OCI runtime exec failed: write /tmp/runc-process123: no space left on device'" }));
      }
      cb(null, { stdout: provisionRoutes(args, execs, removals, runs), stderr: '' });
    });
    const r = await execInContainer(sessionId, 'npx jest disk', '/wt', 1000);
    expect(cmdAttempts).toBe(1);
    expect(removals).toHaveLength(0);
    expect(runs).toHaveLength(0);
    expect(fsRmMock).not.toHaveBeenCalled();
    expect(r.stderr).toContain('NOT retried automatically'); // advisory only
  });
});

/**
 * Ticket db25c401 — the orphaned build-process reaper. Orphaned tsc/jest exec
 * legs from "terminated" runs pinned the shared dev container's 4 GiB cgroup
 * and got the NEXT run's verify tsc SIGKILLed (exit 137, empty output).
 */
describe('reapOrphanedBuildProcesses (ticket db25c401)', () => {
  const sessionId = 'sess-reap-1234abcd';

  test('buildOrphanReapScript scopes kills to THIS session, spares watch-mode, tracked pgids, and itself', () => {
    const script = buildOrphanReapScript(sessionId);
    // (a) scoped to this session's worktree path (co-tenants untouched)
    expect(script).toContain(`worktrees/${sessionId}`);
    // (b) build/verify tools only
    expect(script).toContain('*tsc*|*jest*|*prisma*|*eslint*');
    // (c) watch-mode spared (tsc --watch / jest --watch are deliberate servers)
    expect(script).toContain('*watch*|*Watch*');
    // (d) tracked background processes spared by pgid from the on-disk registry
    expect(script).toContain(`/tmp/digby-proc/${sessionId}/`);
    // (e) the reaper never kills its own script (argv embeds the marker)
    expect(script).toContain('DIGBY-ORPHAN-REAPER');
    expect(script).toContain('*DIGBY-ORPHAN-REAPER*');
    expect(script).toContain('kill -9');
  });

  test('reaps the processes the in-container script reports, targeting the session container', async () => {
    const execs: string[][] = [];
    dockerReturns((args) => {
      if (args[0] === 'info') return 'ok';
      if (args[0] === 'exec') {
        execs.push(args);
        if (args.some(a => a.includes('DIGBY-ORPHAN-REAPER'))) {
          return 'REAPED 123 node /app/coding-workspaces/worktrees/sess-reap-1234abcd/backend/node_modules/.bin/tsc --noEmit\nREAPED 456 node /app/coding-workspaces/worktrees/sess-reap-1234abcd/node_modules/.bin/jest\n';
        }
        return '';
      }
      return '';
    });
    const reaped = await reapOrphanedBuildProcesses(sessionId);
    expect(reaped).toBe(2);
    expect(execs).toHaveLength(1);
    // the exec targets THIS session's container with bash -lc
    expect(execs[0].join(' ')).toContain(sessionId.slice(0, 12));
    expect(execs[0]).toContain('bash');
    expect(execs[0]).toContain('-lc');
  });

  test('a silent script (nothing orphaned) reaps zero', async () => {
    dockerReturns((args) => (args[0] === 'info' ? 'ok' : ''));
    expect(await reapOrphanedBuildProcesses(sessionId)).toBe(0);
  });

  test('a docker/exec failure returns 0 and never throws (best-effort — must not block a run)', async () => {
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return cb(null, { stdout: 'ok', stderr: '' });
      if (args[0] === 'exec') return cb(Object.assign(new Error('boom'), { stdout: '', stderr: 'No such container' }));
      cb(null, { stdout: '', stderr: '' });
    });
    await expect(reapOrphanedBuildProcesses(sessionId)).resolves.toBe(0);
  });
});

describe('isDockerAvailable — a negative probe expires (autonomy loop #16: a deploy-time docker-proxy blip used to fail every container op for the process lifetime)', () => {
  let nowSpy: jest.SpyInstance;
  let now = 1_700_000_000_000;
  beforeEach(() => {
    __resetDockerAvailabilityForTest();
    now = 1_700_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => { nowSpy.mockRestore(); __resetDockerAvailabilityForTest(); });

  test('down → memoized false for DOCKER_NEGATIVE_MEMO_MS (no re-probe) → re-probed after the window → positive memo expires', async () => {
    let infoOk = false;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return infoOk ? cb(null, { stdout: '27.0\n', stderr: '' }) : cb(new Error('Cannot connect to the Docker daemon at tcp://10.0.0.15:2375'), { stdout: '', stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    });
    expect(await isDockerAvailable()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(DOCKER_STARTUP_PROBE_ATTEMPTS);
    now += DOCKER_NEGATIVE_MEMO_MS - 1;
    expect(await isDockerAvailable()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(DOCKER_STARTUP_PROBE_ATTEMPTS);
    now += 2;
    infoOk = true;
    expect(await isDockerAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(DOCKER_STARTUP_PROBE_ATTEMPTS + 1);
    now += DOCKER_POSITIVE_MEMO_MS - 1_000;
    expect(await isDockerAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(DOCKER_STARTUP_PROBE_ATTEMPTS + 1);
    now += 2_000;
    expect(await isDockerAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(DOCKER_STARTUP_PROBE_ATTEMPTS + 2);
  });

  test('the outage is logged once (not on every re-probe) and recovery is logged', async () => {
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear(); (logger.info as jest.Mock).mockClear();
    let infoOk = false;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) =>
      (args[0] === 'info' && !infoOk ? cb(new Error('down'), { stdout: '', stderr: '' }) : cb(null, { stdout: 'ok', stderr: '' })));
    await isDockerAvailable();
    now += DOCKER_NEGATIVE_MEMO_MS + 1;
    await isDockerAvailable(); // still down — no second warn
    const warns = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /Docker not available/.test(String(c[0])));
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0])).toContain('fail closed');
    now += DOCKER_NEGATIVE_MEMO_MS + 1;
    infoOk = true;
    expect(await isDockerAvailable()).toBe(true);
    expect((logger.info as jest.Mock).mock.calls.some((c: any[]) => /Docker reachable again/.test(String(c[0])))).toBe(true);
  });

  test('a cold start retries quietly and warns once only after every attempt fails', async () => {
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return cb(new Error('Cannot connect to the Docker daemon'), { stdout: '', stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    });
    expect(await isDockerAvailable()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(DOCKER_STARTUP_PROBE_ATTEMPTS);
    const warns = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /Docker not available/.test(String(c[0])));
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0])).toContain('fail closed');
    expect(String(warns[0][0])).toContain('Cannot connect to the Docker daemon');
  });

  test('a cold start that answers on the 4th try warns nothing and does not claim a recovery', async () => {
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
    let infos = 0;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') {
        infos += 1;
        if (infos < DOCKER_STARTUP_PROBE_ATTEMPTS) return cb(new Error('starting'), { stdout: '', stderr: '' });
        return cb(null, { stdout: '27.0\n', stderr: '' });
      }
      return cb(null, { stdout: '', stderr: '' });
    });
    expect(await isDockerAvailable()).toBe(true);
    expect(infos).toBe(DOCKER_STARTUP_PROBE_ATTEMPTS);
    expect((logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /Docker not available/.test(String(c[0])))).toHaveLength(0);
    expect((logger.info as jest.Mock).mock.calls.some((c: any[]) => /Docker reachable again/.test(String(c[0])))).toBe(false);
  });

  test('a cached success expires after DOCKER_POSITIVE_MEMO_MS and a miss fails closed', async () => {
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
    let infoOk = true;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return infoOk ? cb(null, { stdout: '27.0\n', stderr: '' }) : cb(new Error('daemon gone'), { stdout: '', stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    });
    expect(await isDockerAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    now += DOCKER_POSITIVE_MEMO_MS - 1_000;
    expect(await isDockerAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    now += 2_000;
    infoOk = false;
    expect(await isDockerAvailable()).toBe(false);
    // 2026-10-20: a previously-healthy daemon gets ONE quiet retry before the miss.
    expect(execFileMock).toHaveBeenCalledTimes(3);
    const warns = (logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /Docker not available/.test(String(c[0])));
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0])).toContain('fail closed');
    now += DOCKER_NEGATIVE_MEMO_MS + 1;
    infoOk = true;
    expect(await isDockerAvailable()).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect((logger.info as jest.Mock).mock.calls.some((c: any[]) => /Docker reachable again/.test(String(c[0])))).toBe(true);
  });

  test('2026-10-20: ONE failed re-probe of a previously-healthy daemon is retried once — a single blip does not mark Docker down', async () => {
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    let infos = 0;
    let failNext = 0;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') {
        infos += 1;
        if (failNext > 0) { failNext -= 1; return cb(new Error('blip'), { stdout: '', stderr: '' }); }
        return cb(null, { stdout: '27.0\n', stderr: '' });
      }
      return cb(null, { stdout: '', stderr: '' });
    });
    expect(await isDockerAvailable()).toBe(true);
    now += DOCKER_POSITIVE_MEMO_MS + 1;
    failNext = 1;
    expect(await isDockerAvailable()).toBe(true);
    expect(infos).toBe(3);
    // The retry re-armed the positive memo — no probe inside it.
    now += 1_000;
    expect(await isDockerAvailable()).toBe(true);
    expect(infos).toBe(3);
    expect((logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /Docker not available/.test(String(c[0])))).toHaveLength(0);
  });

  test('2026-10-20: DOCKER_REPROBE_RETRY_DISABLED=1 restores the single-try re-probe', async () => {
    const prev = process.env.DOCKER_REPROBE_RETRY_DISABLED;
    process.env.DOCKER_REPROBE_RETRY_DISABLED = '1';
    try {
      let infos = 0;
      let infoOk = true;
      execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
        if (args[0] === 'info') { infos += 1; return infoOk ? cb(null, { stdout: '27.0\n', stderr: '' }) : cb(new Error('blip'), { stdout: '', stderr: '' }); }
        return cb(null, { stdout: '', stderr: '' });
      });
      expect(await isDockerAvailable()).toBe(true);
      now += DOCKER_POSITIVE_MEMO_MS + 1;
      infoOk = false;
      expect(await isDockerAvailable()).toBe(false);
      expect(infos).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.DOCKER_REPROBE_RETRY_DISABLED; else process.env.DOCKER_REPROBE_RETRY_DISABLED = prev;
    }
  });

  test('startup delays are 0 under NODE_ENV=test and the production table otherwise', () => {
    expect(dockerProbeStartupDelayMs(0)).toBe(0);
    expect(dockerProbeStartupDelayMs(1)).toBe(0);
    expect(dockerProbeStartupDelayMs(3)).toBe(0);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(dockerProbeStartupDelayMs(0)).toBe(0);
      expect(dockerProbeStartupDelayMs(1)).toBe(50);
      expect(dockerProbeStartupDelayMs(2)).toBe(150);
      expect(dockerProbeStartupDelayMs(3)).toBe(400);
      expect(dockerProbeStartupDelayMs(9)).toBe(400);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

const { dockerProbeSkipReason } = require('./container.service');

describe('isDockerAvailable — web-tier / cron-only processes skip the probe (telemetry-noise audit PE-11 / T11: the "fail closed" warn re-fired on every blue/green start of the A/B backends + workers, 47 rows / 7 d, none a real outage)', () => {
  const saved = { c: process.env.CODING_WORKER_CONCURRENCY, d: process.env.CODING_CONTAINER_PROBE_DISABLED };
  beforeEach(() => {
    __resetDockerAvailabilityForTest();
    delete process.env.CODING_WORKER_CONCURRENCY; delete process.env.CODING_CONTAINER_PROBE_DISABLED;
    execFileMock.mockReset();
  });
  afterEach(() => {
    __resetDockerAvailabilityForTest();
    for (const [k, v] of [['CODING_WORKER_CONCURRENCY', saved.c], ['CODING_CONTAINER_PROBE_DISABLED', saved.d]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test('dockerProbeSkipReason is pure: 0 slots or the explicit flag skip; slots / unset probe', () => {
    expect(dockerProbeSkipReason({})).toBeNull();
    expect(dockerProbeSkipReason({ CODING_WORKER_CONCURRENCY: '32' })).toBeNull();
    expect(dockerProbeSkipReason({ CODING_WORKER_CONCURRENCY: '' })).toBeNull();
    expect(dockerProbeSkipReason({ CODING_WORKER_CONCURRENCY: '0' })).toContain('CODING_WORKER_CONCURRENCY=0');
    expect(dockerProbeSkipReason({ CODING_CONTAINER_PROBE_DISABLED: '1' })).toContain('CODING_CONTAINER_PROBE_DISABLED=1');
  });

  test('a 0-slot process never runs `docker info`, answers false, and says so ONCE at info — never warn', async () => {
    process.env.CODING_WORKER_CONCURRENCY = '0';
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear(); (logger.info as jest.Mock).mockClear();
    expect(await isDockerAvailable()).toBe(false);
    expect(await isDockerAvailable()).toBe(false);
    expect(await isDockerAvailable()).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    const notices = (logger.info as jest.Mock).mock.calls.filter((c: any[]) => /Docker probe skipped/.test(String(c[0])));
    expect(notices).toHaveLength(1);
    expect(String(notices[0][0])).toContain('route to the coding box over Redis');
  });

  test('CODING_CONTAINER_PROBE_DISABLED=1 (the A/B backends) skips the same way', async () => {
    process.env.CODING_CONTAINER_PROBE_DISABLED = '1';
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    expect(await isDockerAvailable()).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a process WITH worker slots (box C) probes and warns exactly as before', async () => {
    process.env.CODING_WORKER_CONCURRENCY = '32';
    const logger = require('../../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return cb(new Error('Cannot connect to the Docker daemon'), { stdout: '', stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    });
    expect(await isDockerAvailable()).toBe(false);
    expect(execFileMock).toHaveBeenCalledTimes(DOCKER_STARTUP_PROBE_ATTEMPTS);
    expect((logger.warn as jest.Mock).mock.calls.filter((c: any[]) => /fail closed/.test(String(c[0])))).toHaveLength(1);
  });
});

// --- audit 2026-10-06 T7-7: which sessions' shells see the WHOLE volume ---
describe('workspaceExecExposure (T7-7 — arms the run_command workspace-scope guard)', () => {
  const router = (inspectOut: string) => (_cmd: string, args: string[], _opts: any, cb: any) => {
    const out = args[0] === 'info' ? 'ok' : args[0] === 'exec' ? 'HEAD' : args[0] === 'inspect' ? inspectOut : '';
    cb(null, { stdout: out, stderr: '' });
  };

  test('a SCOPED container is not exposed; a whole-volume FALLBACK is', async () => {
    execFileMock.mockImplementation(router(''));
    fsAccessMock.mockResolvedValue(undefined); // worktree + mirror exist → scoped
    mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ projectId: 'proj-1' });
    expect(await ensureSessionContainer('sess-expo-scoped-01')).toBe(true);
    expect(workspaceExecExposure('sess-expo-scoped-01')).toBeNull();

    fsAccessMock.mockRejectedValue(new Error('ENOENT')); // can't scope → whole-volume fallback
    expect(await ensureSessionContainer('sess-expo-whole-001')).toBe(true);
    expect(workspaceExecExposure('sess-expo-whole-001')).toBe('whole_volume');
    await stopSessionContainer('sess-expo-whole-001'); // a recreate re-learns its mode
    expect(workspaceExecExposure('sess-expo-whole-001')).toBeNull();
  });

  test('an already-RUNNING container (created by an earlier process) is probed once via docker inspect', async () => {
    const name = 'digby-code-sess-expo-run';
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      const out = args[0] === 'info' ? 'ok'
        : args[0] === 'ps' ? name
          : args[0] === 'inspect' ? '/app/coding-workspaces|/tmp/x|' : '';
      cb(null, { stdout: out, stderr: '' });
    });
    mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ projectId: 'proj-1' });
    expect(await ensureSessionContainer('sess-expo-running-0001')).toBe(true);
    expect(workspaceExecExposure('sess-expo-running-0001')).toBe('whole_volume');
    const inspects = execFileMock.mock.calls.filter((c) => c[1]?.[0] === 'inspect').length;
    await ensureSessionContainer('sess-expo-running-0001');
    expect(execFileMock.mock.calls.filter((c) => c[1]?.[0] === 'inspect').length).toBe(inspects); // memoized
  });
});

describe('hostExecFallbackAllowed (2026-10-20 — install/preview fail closed in container mode)', () => {
  const { hostExecFallbackAllowed } = require('./container.service');
  test('container mode refuses host execution unless the kill switch is set', () => {
    expect(hostExecFallbackAllowed({})).toBe(false);
    expect(hostExecFallbackAllowed({ CODING_HOST_EXEC_FAIL_CLOSED_DISABLED: '1' })).toBe(true);
  });
  test('container mode off (dev / test) keeps the host fallback', () => {
    const prev = process.env.CODING_CONTAINER_MODE;
    process.env.CODING_CONTAINER_MODE = '0';
    try {
      jest.isolateModules(() => {
        const mod = require('./container.service');
        expect(mod.hostExecFallbackAllowed({})).toBe(true);
      });
    } finally {
      process.env.CODING_CONTAINER_MODE = prev;
    }
  });
});
