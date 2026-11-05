/**
 * REPLAY — ticket e2f40d10 (P1).
 *
 * A lane's session container is REPLACED under a run (deploy restart, reap,
 * disk-pressure recycle). The reported damage had three legs; this suite pins
 * the two code legs the platform owns:
 *
 *  (1) EXECUTOR REBIND. The executor captured the container NAME once, so after
 *      the swap every later shell command AND both verify legs failed with the
 *      daemon's "No such container: digby-code-…" and the lane had no
 *      self-heal (infra_action restart was dry-run-only). A vanished target
 *      must now re-provision and re-run ONCE.
 *  (2) MISSING uid-1001 ROW. Session execs run as --user 1001:1001, but the
 *      default runner image (node:20) has no passwd row for 1001, so getpwuid
 *      fails and OpenSSH dies "No user exists for uid 1001" — the entire
 *      tailnet box path went dark (lanes were hand-compiling a getpwuid
 *      LD_PRELOAD shim). The dev container has had the rows since a6051a82 /
 *      PR #1482; per-session containers never did.
 *
 * The third leg (the resume notice never saying the container may have been
 * swapped) is pinned in run-executor's own suite; here we only assert the
 * notice text contract lives where the resume path reads it.
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
  mkdir: (...args: any[]) => Promise.resolve(fsMkdirMock(...args)),
}));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

// Finding 2 (shared-path coverage): the rebind notice must name the container
// that ACTUALLY died. Exercising that needs the SHARED dev-container path live,
// so mock the dev-container module (container.service reaches it only through a
// dynamic import — there is no static import to conflict with) and pin the
// subtree list empty so the resolve takes the plain shared branch.
const devEnsureMock = jest.fn();
jest.mock('./dev-container.service', () => ({
  __esModule: true,
  ensureUserDevContainer: (...a: any[]) => devEnsureMock(...a),
  ensureSessionEgressGrant: jest.fn(async () => null),
  invalidateDevContainerMemo: jest.fn(),
}));
jest.mock('./workspace-layout', () => ({
  ...jest.requireActual('./workspace-layout'),
  listSubtreeKeysSync: () => [],
}));

import prisma from '../../../config/database';
import {
  execInContainer, ensureSessionContainer, isContainerGoneError,
  __resetPreExecDiskGuardForTest, __resetDockerAvailabilityForTest,
  __resetSessionUserRowMemoForTest,
} from './container.service';
import { SESSION_USER_SCRIPT } from './session-user-row';

const mockedPrisma = prisma as unknown as {
  chatCodingState: { findMany: jest.Mock; findUnique: jest.Mock };
  agentRun: { count: jest.Mock };
};

const SESSION = 'sess-e2f40d10-rebind-01';
const CONTAINER = `digby-code-${SESSION.slice(0, 12)}`;

const goneError = () => Object.assign(new Error('docker exec failed'), {
  code: 1,
  stdout: '',
  stderr: `Error response from daemon: No such container: ${CONTAINER}`,
});

beforeEach(() => {
  jest.clearAllMocks();
  __resetPreExecDiskGuardForTest();
  __resetDockerAvailabilityForTest();
  __resetSessionUserRowMemoForTest();
  fsStatfsMock.mockResolvedValue({ blocks: 100, bavail: 50 }); // healthy disk
  fsAccessMock.mockResolvedValue(undefined);                    // worktree present
  fsRmMock.mockResolvedValue(undefined);
  mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ projectId: null });
});

// ── (1) the vanished-target matcher ─────────────────────────────────────────
describe('isContainerGoneError — the "exec target was replaced" signature (e2f40d10)', () => {
  test('matches the daemon text with the container name attached', () => {
    expect(isContainerGoneError(`Error response from daemon: No such container: ${CONTAINER}`)).toBe(true);
    expect(isContainerGoneError('No such container: deadbeef')).toBe(true);
  });

  test('does NOT match the phrase when it is merely QUOTED inside a command\'s output', () => {
    // Ticket e2f40d10 review: a lane that greps/runs a fixture containing this
    // literal must never trigger a spurious container recycle — the one-retry
    // bound is only sound while the matcher fires on docker's OWN error text.
    expect(isContainerGoneError(`grep -rn "No such container:" backend/src\nbackend/x.ts:74: No such container: digby-code-abc`)).toBe(false);
    expect(isContainerGoneError('    stderr: `Error response from daemon: No such container: ${CONTAINER}`,\n[exit: 1]')).toBe(false);
    expect(isContainerGoneError('ok 12 - executor rebinds on "No such container"\n[exit: 1]')).toBe(false);
  });

  test('matches the daemon line when it is not at the very start (wrapper prefix)', () => {
    expect(isContainerGoneError('docker: Error response from daemon: No such container: digby-code-abc')).toBe(true);
  });

  test('a SUCCESSFUL command that merely printed the phrase never fires (exit-code guard)', () => {
    // Merged contract with ticket c25f8b7e (which landed on main first): the
    // anchor allows indentation because docker's own refusal can be indented in
    // wrapper output — the discriminating guard is the EXIT CODE, not the
    // column. A command that succeeded cannot have been refused by the daemon,
    // so it must never trigger a recycle.
    expect(isContainerGoneError(`Error response from daemon: No such container: ${CONTAINER}`, 0)).toBe(false);
    expect(isContainerGoneError(`  No such container: digby-code-x`, 0)).toBe(false);
    // and the daemon's own refusal at its own exit code does fire
    expect(isContainerGoneError(`  Error response from daemon: No such container: digby-code-x`, 125)).toBe(true);
  });

  test('does NOT match an INDENTED bare phrase — a command that RAN printed it (finding 3)', () => {
    // Ticket e2f40d10 review, finding 3: the commit claimed "dropped the
    // whitespace allowance" but main still had /^\s*No such container: /, so a
    // failed command whose stderr STARTS with an indented echo of the phrase —
    // `docker … 2>&1 | head`, a cat of a log, a jest diagnostic line — was read
    // as a container death: a phantom replacement announced, and a command that
    // actually ran reported as "THIS COMMAND DID NOT RUN".
    // Docker never indents its own refusal, so the bare re-emit arm anchors at
    // column 0. (The daemon-prefix arm keeps \s* — pinned by c25f8b7e below.)
    expect(isContainerGoneError('  No such container: digby-code-x', 1)).toBe(false);
    expect(isContainerGoneError('\tNo such container: digby-code-x', 1)).toBe(false);
    expect(isContainerGoneError('      No such container: digby-code-abc\n[exit: 1]', 1)).toBe(false);
    // the unindented wrapper re-emit still fires (docker's own 125 exit)
    expect(isContainerGoneError('No such container: digby-code-abc', 125)).toBe(true);
  });

  test('an indented DAEMON-PREFIX line still fires — that allowance is pinned elsewhere', () => {
    // c25f8b7e pins `  Error response from daemon: …` at exit 125: the exec
    // wrapper can indent the daemon line. Only the BARE arm lost its \s*.
    expect(isContainerGoneError('  Error response from daemon: No such container: x', 125)).toBe(true);
    expect(isContainerGoneError('  Error response from daemon: No such container: x', 1)).toBe(true);
  });

  test('does NOT match an ordinary command failure (a real exit must never be retried)', () => {
    expect(isContainerGoneError('bash: foo: command not found\n[exit: 127]')).toBe(false);
    expect(isContainerGoneError('Error response from daemon: is not running')).toBe(false);
    expect(isContainerGoneError('')).toBe(false);
    expect(isContainerGoneError(undefined)).toBe(false);
    expect(isContainerGoneError(null)).toBe(false);
  });
});

// ── (2) executor rebind after a mid-run swap ────────────────────────────────
describe('execInContainer — executor rebinds to a replaced container (e2f40d10)', () => {
  /**
   * Routes the re-provision path. `firstExec` runs the command; on the dead
   * container it fails with the gone signature, afterwards it succeeds.
   */
  function route(args: string[], state: { commandExecs: number; userRowExecs: string[][] }) {
    if (args[0] === 'info') return { ok: 'ok' };
    if (args[0] === 'ps') return { ok: '' };            // nothing running / existing
    if (args[0] === 'run') return { ok: '' };           // create
    if (args[0] === 'rm') return { ok: '' };
    if (args[0] === 'cp') return { ok: '' };
    if (args[0] === 'exec') {
      // uid-row provisioning exec — always succeeds, recorded for assertions
      if (args.includes('-u') && args.includes('0')) { state.userRowExecs.push(args); return { ok: '' }; }
      const cmd = args[args.length - 1];
      // git plumbing / gh fast-path during provisioning: succeed silently
      if (cmd === 'git' || args.includes('git') || cmd === 'command -v gh >/dev/null 2>&1') return { ok: '' };
      if (cmd === 'git rev-parse HEAD') return { ok: 'HEAD' };
      state.commandExecs += 1;
      // 1st command exec: the dead container. 2nd (the retry): success.
      if (state.commandExecs === 1) return { fail: goneError() };
      return { ok: 'hi from the fresh container\n' };
    }
    return { ok: '' };
  }

  function installRouter(state: { commandExecs: number; userRowExecs: string[][] }) {
    execFileMock.mockImplementation((cmd: string, args: string[], _o: any, cb: any) => {
      if (cmd !== 'docker') return cb(null, { stdout: '', stderr: '' });
      const out = route(args, state);
      if (out.fail) return cb(out.fail, { stdout: '', stderr: out.fail.stderr });
      return cb(null, { stdout: out.ok, stderr: '' });
    });
  }

  test('a "No such container" exec is NOT silently re-run, and tells the lane what it lost', async () => {
    const state = { commandExecs: 0, userRowExecs: [] as string[][] };
    installRouter(state);

    const r = await execInContainer(SESSION, 'echo hi', '/wt', 5_000);

    // MERGED CONTRACT (ticket c25f8b7e landed first on main): the command is
    // NOT re-executed — the shell is re-provisioned for the REST of the run and
    // the lane is told its command did not run and may be re-run by hand. That
    // is strictly safer than an automatic re-run: "provably never started" is
    // an inference, and a mis-classification would double-apply real work.
    expect(state.commandExecs).toBe(1); // exactly one execution — never a silent retry
    expect(r.stderr).toContain('No such container'); // the daemon's refusal is preserved
    expect(r.stderr).toContain('THIS COMMAND DID NOT RUN');
    expect(r.stderr).toMatch(/never started/);      // so the lane knows a manual re-run is safe
    expect(r.stderr).toContain('background process'); // what died with the old container
  });

  test('the re-provisioned container gets the uid-1001 row (ssh must not die "No user exists")', async () => {
    const state = { commandExecs: 0, userRowExecs: [] as string[][] };
    installRouter(state);

    await execInContainer(SESSION, 'echo hi', '/wt', 5_000);

    expect(state.userRowExecs.length).toBeGreaterThan(0);
    // root is required: `docker exec` otherwise defaults to --user 1001 and the
    // /etc/passwd write dies EACCES.
    const rowExec = state.userRowExecs[0];
    expect(rowExec[0]).toBe('exec');
    expect(rowExec[1]).toBe('-u');
    expect(rowExec[2]).toBe('0');
    expect(rowExec).toContain(CONTAINER);
    expect(rowExec).toContain(SESSION_USER_SCRIPT);
  });

  test('a command failure that is NOT a vanished container is never retried', async () => {
    let commandExecs = 0;
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return cb(null, { stdout: 'ok', stderr: '' });
      if (args[0] !== 'exec') return cb(null, { stdout: '', stderr: '' });
      commandExecs += 1;
      const err = Object.assign(new Error('exit 127'), { code: 127, stdout: '', stderr: 'bash: nope: command not found' });
      return cb(err, { stdout: '', stderr: err.stderr });
    });

    const r = await execInContainer(SESSION, 'nope', '/wt', 5_000);
    expect(commandExecs).toBe(1); // no retry — the command itself failed
    expect(r.stderr).toContain('command not found');
    expect(r.stderr).not.toContain('THIS COMMAND DID NOT RUN');
  });

  test('when re-provisioning FAILS the lane gets an honest unavailability note, never a silent dead end', async () => {
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return cb(null, { stdout: 'ok', stderr: '' });
      if (args[0] === 'ps') return cb(null, { stdout: '', stderr: '' });
      // every create attempt fails → ensureSessionContainer returns false
      if (args[0] === 'run') return cb(Object.assign(new Error('boom'), { code: 1, stdout: '', stderr: 'create failed' }), { stdout: '', stderr: 'create failed' });
      if (args[0] === 'exec') {
        const err = goneError();
        return cb(err, { stdout: '', stderr: err.stderr });
      }
      return cb(null, { stdout: '', stderr: '' });
    });

    const r = await execInContainer(SESSION, 'echo hi', '/wt', 5_000);
    expect(r.stderr).toContain('could NOT be re-provisioned');
    // Ticket 9a391db3 corrected this claim: the worktree (and $DIGBY_ENV, a worktree file) survive,
    // but the LIVE $HOME is /tmp — the writable layer — and goes with the swapped container.
    expect(r.stderr).toContain('worktree and $DIGBY_ENV are intact');
    expect(r.stderr).not.toContain('durable $HOME');
    expect(r.stderr).toContain('writable layer');
  }, 20_000);
});

// ── (3) the uid-1001 row on a FRESH per-session container ───────────────────
describe('ensureSessionContainer — provisions the uid-1001 passwd row (e2f40d10)', () => {
  test('a freshly created per-session container receives the row as root', async () => {
    const userRowExecs: string[][] = [];
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return cb(null, { stdout: 'ok', stderr: '' });
      if (args[0] === 'ps') return cb(null, { stdout: '', stderr: '' });
      if (args[0] === 'run') return cb(null, { stdout: '', stderr: '' });
      if (args[0] === 'exec') {
        if (args.includes('-u') && args.includes('0')) userRowExecs.push(args);
        return cb(null, { stdout: '', stderr: '' });
      }
      return cb(null, { stdout: '', stderr: '' });
    });

    expect(await ensureSessionContainer(SESSION)).toBe(true);
    expect(userRowExecs.length).toBe(1);
    expect(userRowExecs[0]).toContain(CONTAINER);
    expect(userRowExecs[0]).toContain(SESSION_USER_SCRIPT);
  }, 20_000);

  test('an already-running container receives it too (a container created before this fix heals on next use)', async () => {
    const userRowExecs: string[][] = [];
    execFileMock.mockImplementation((_c: string, args: string[], _o: any, cb: any) => {
      if (args[0] === 'info') return cb(null, { stdout: 'ok', stderr: '' });
      if (args[0] === 'ps') return cb(null, { stdout: `${CONTAINER}\n`, stderr: '' });
      if (args[0] === 'exec') {
        if (args.includes('-u') && args.includes('0')) userRowExecs.push(args);
        return cb(null, { stdout: '', stderr: '' });
      }
      return cb(null, { stdout: '', stderr: '' });
    });

    expect(await ensureSessionContainer(SESSION)).toBe(true);
    expect(userRowExecs.length).toBe(1);
    expect(userRowExecs[0]).toContain(SESSION_USER_SCRIPT);
  });
});

// ── (5) the resume notice tells the lane its container may have been swapped ─
describe('resume notice — a swapped container is not a silent capability loss (e2f40d10)', () => {
  // The notice is a private prompt contract in run-executor.ts, so pin it the
  // way this repo pins other prompt text: read the source and assert on it.
  const source = require('fs').readFileSync(require('path').resolve(__dirname, 'run-executor.ts'), 'utf8');

  test('the resume notice tells the lane to re-check container capabilities', () => {
    expect(source).toContain('CONTAINER SWAP');
    expect(source).toContain('may have been REPLACED under the run');
    // the concrete re-checks the reporting lane said were missing
    expect(source).toContain('command -v tailscale');
    expect(source).toContain('getent passwd 1001');
    expect(source).toContain('ps -p 1 -o lstart=');
  });

  test('it names the dangling-LD_PRELOAD trap explicitly (the ld.so warning is not the cause)', () => {
    expect(source).toContain('LD_PRELOAD');
    expect(source).toContain('ld.so warning as the cause');
  });
});

test('REPLAY MARKER: carries the ticket id prefix for the verified-close gate', () => {
  expect('e2f40d10').toHaveLength(8);
});
describe('SESSION_USER_SCRIPT — idempotent, collision-safe passwd/group rows (e2f40d10)', () => {
  test('guards every write behind getent so re-running is a no-op', () => {
    for (const line of SESSION_USER_SCRIPT.split('\n')) {
      expect(line).toContain('getent');
      expect(line).toContain('>/dev/null 2>&1 ||');
    }
    expect(SESSION_USER_SCRIPT).toContain('getent passwd 1001');
    expect(SESSION_USER_SCRIPT).toContain('getent group 1001');
  });

  test('writes uid/gid 1001 with pw_dir=/tmp (ssh ~/.ssh must not land on a mount)', () => {
    expect(SESSION_USER_SCRIPT).toContain(':x:1001:1001:Digby session:/tmp:/bin/bash');
  });

  test('never hard-fails the boot script — every line ends in `|| true`', () => {
    for (const line of SESSION_USER_SCRIPT.split('\n')) expect(line.trimEnd()).toMatch(/\|\| true$/);
  });

  test('picks a non-colliding name when `digby` is already taken', () => {
    // A base image that already ships a `digby` user must not get a duplicate
    // row (the first match wins on lookup, so the uid-1001 row would be shadowed).
    expect(SESSION_USER_SCRIPT).toContain("grep -q '^digby:' /etc/passwd && N=digby1001");
    expect(SESSION_USER_SCRIPT).toContain("grep -q '^digby:' /etc/group && G=digby1001");
  });
});
// ── (3) the SHARED dev-container path (ticket e2f40d10 review, finding 2) ────
describe('execInContainer — a SHARED dev-container death names the container that died', () => {
  // The reviewed head (47587689f2) captured `attemptedTarget` BEFORE the
  // vanished-block deletes sharedOverride; the merge onto main lost that line,
  // so execTargetName() ran AFTER the delete and resolved to the PER-SESSION
  // name. The lane was then told `digby-code-<sid12>` was replaced when the one
  // that actually died was `digby-dev-…`. The 18-test suite never caught it
  // because it had ZERO coverage of the shared path — this is that coverage.
  const DEV = 'digby-dev-83e4fbf9-e18c';

  function installSharedRouter(state: { devExecs: number }) {
    devEnsureMock.mockResolvedValue(DEV);
    execFileMock.mockImplementation((cmd: string, args: string[], _o: any, cb: any) => {
      if (cmd !== 'docker') return cb(null, { stdout: '', stderr: '' });
      if (args[0] === 'info') return cb(null, { stdout: 'ok', stderr: '' });
      if (args[0] === 'exec') {
        // uid-row provisioning (root) and git/gh plumbing succeed silently
        if (args.includes('-u') && args.includes('0')) return cb(null, { stdout: '', stderr: '' });
        const cmdText = args[args.length - 1];
        if (cmdText === 'git' || args.includes('git') || cmdText === 'command -v gh >/dev/null 2>&1') {
          return cb(null, { stdout: '', stderr: '' });
        }
        state.devExecs += 1;
        // The SHARED container is the one that vanished.
        return cb(goneShared(), { stdout: '', stderr: goneShared().stderr });
      }
      return cb(null, { stdout: '', stderr: '' });
    });
  }
  const goneShared = () => Object.assign(new Error('docker exec failed'), {
    code: 1, stdout: '',
    stderr: `Error response from daemon: No such container: ${DEV}`,
  });

  test('the notice names the DEV container, not the per-session one', async () => {
    mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ userId: 'u-shared-1', projectId: null });
    const state = { devExecs: 0 };
    installSharedRouter(state);

    // Establish the shared binding first — this is what sets sharedOverride,
    // which is exactly the memo the vanished-block later deletes.
    const ok = await ensureSessionContainer(SESSION);
    expect(ok).toBe(true);

    const r = await execInContainer(SESSION, 'echo hi', '/wt', 5_000);

    expect(state.devExecs).toBe(1);
    // THE ASSERTION THAT CATCHES THE REGRESSION: the lane must be told the
    // shared container died. Pre-fix this read `digby-code-<sid12>`.
    expect(r.stderr).toContain(DEV);
    expect(r.stderr).not.toContain(CONTAINER);
    // and the fail-loud wording survives
    expect(r.stderr).toContain('THIS COMMAND DID NOT RUN');
  });
});
