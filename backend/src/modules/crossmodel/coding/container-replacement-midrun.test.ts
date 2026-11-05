/**
 * Ticket c25f8b7e — the "container was replaced under a live run" surface.
 *
 * PINNED INCIDENT: on 2026-11-03 ~05:23Z a deploy/restart wave replaced two
 * Schooltime lanes' session containers in the same minute. Lane 60dfc8a8's
 * container vanished mid-firing; every remaining command in that run died with
 * a bare `Error response from daemon: No such container: digby-code-…` and its
 * last two probes never ran. This suite pins BOTH halves of the fix on the exec
 * path:
 *   - the classifier only fires on the DAEMON's own refusal (never on a command
 *     that merely prints the phrase — a `docker` call inside a script, or a
 *     fixture), so we never announce "your work is gone" spuriously; and
 *   - when it does fire, the lane is told the command did NOT run (so re-running
 *     it cannot double-apply anything), that the container was re-provisioned,
 *     and which of its state survived — and the swap is recorded so the next
 *     run's prompt reports it too.
 */

process.env.CODING_CONTAINER_MODE = '1';
// Keep the identity record out of the real session-env volume.
const IDENTITY_ROOT = process.env.CODING_CONTAINER_IDENTITY_ROOT
  || require('path').join(require('os').tmpdir(), `c25f8b7e-identity-${process.pid}`);
process.env.CODING_CONTAINER_IDENTITY_ROOT = IDENTITY_ROOT;

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatCodingState: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
    agentRun: { count: jest.fn().mockResolvedValue(0) },
  },
}));
jest.mock('fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('fs/promises'),
  // The pre-exec disk guard reads statfs; report plenty of free space so it
  // no-ops. mkdir / writeFile / rename stay REAL — the identity record under
  // test must actually be written to disk (mocking them would make the "swap
  // was recorded" assertion vacuous).
  statfs: jest.fn().mockResolvedValue({ blocks: 1e9, bfree: 1e9, bavail: 1e9, bsize: 4096 }),
}));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { isContainerGoneError, execInContainer, __resetDockerAvailabilityForTest } from './container.service';
import { readContainerIdentity, forgetContainerIdentity } from './container-identity';

const GONE = 'Error response from daemon: No such container: digby-code-60dfc8a8-4b2';

/** Route docker exec calls: the first `exec` fails with `stderr`, everything
 *  after (including the re-provision's `run`/`inspect`) succeeds. */
function dockerGoneOnce(stderr: string, thenContainerId = 'c'.repeat(64)) {
  let execCalls = 0;
  execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
    if (args[0] === 'exec') {
      execCalls += 1;
      if (execCalls === 1) {
        const err: any = new Error('Command failed');
        err.stderr = stderr;
        err.code = 1;
        return cb(err, { stdout: '', stderr });
      }
      return cb(null, { stdout: 'ok after reprovision', stderr: '' });
    }
    if (args[0] === 'inspect') {
      // `docker inspect -f '{{.Id}}' <name>` for the identity record; the
      // containerMountDestinations call uses a different format and wants
      // mount destinations.
      if (args[2] === '{{.Id}}') return cb(null, { stdout: `${thenContainerId}\n`, stderr: '' });
      return cb(null, { stdout: '', stderr: '' });
    }
    // run / rm / ps / start etc — success.
    return cb(null, { stdout: 'container-new-id\n', stderr: '' });
  });
}

beforeAll(async () => { await fs.mkdir(IDENTITY_ROOT, { recursive: true }).catch(() => {}); });
afterAll(async () => { await fs.rm(IDENTITY_ROOT, { recursive: true, force: true }).catch(() => {}); });

beforeEach(async () => {
  jest.clearAllMocks();
  __resetDockerAvailabilityForTest();
  await forgetContainerIdentity('sess-gone');
});

describe('isContainerGoneError — only the DAEMON\'s own refusal', () => {
  test('fires on the real daemon refusal', () => {
    expect(isContainerGoneError(GONE, 1)).toBe(true);
    expect(isContainerGoneError(`  ${GONE}`, 125)).toBe(true); // docker's own exit code
    expect(isContainerGoneError(GONE.toUpperCase(), 1)).toBe(true);
  });

  test('does NOT fire when the exit code is 0 — a successful command that merely printed the phrase', () => {
    expect(isContainerGoneError(GONE, 0)).toBe(false);
  });

  test('does NOT fire on a command\'s own output that mentions the phrase MID-STREAM (a docker call inside a script, a test fixture)', () => {
    // The phrase must be the FIRST thing the daemon says. A lane running
    // `docker exec … || echo "…"`, or a test asserting on the message, prints
    // it after other output — treating that as "our container vanished" would
    // announce a phantom replacement and send the lane chasing a non-event.
    expect(isContainerGoneError(`foo\n${GONE}`, 1)).toBe(false);
    expect(isContainerGoneError(`ok: 3 tests, 1 message: ${GONE}`, 1)).toBe(false);
    expect(isContainerGoneError(`bash: ${GONE}`, 1)).toBe(false);
  });

  test('empty / missing stderr never fires', () => {
    expect(isContainerGoneError('', 1)).toBe(false);
    expect(isContainerGoneError(undefined, 1)).toBe(false);
    expect(isContainerGoneError(null, 'error')).toBe(false);
  });

  test('a different daemon refusal (disk full, permission) never fires', () => {
    expect(isContainerGoneError('Error response from daemon: No space left on device', 1)).toBe(false);
    expect(isContainerGoneError('Error response from daemon: permission denied', 1)).toBe(false);
    expect(isContainerGoneError('Error: No such container', 1)).toBe(false); // not the daemon's wording
  });
});

describe('execInContainer — a container replaced mid-run (ticket c25f8b7e)', () => {
  test('says the command did NOT run + what died, re-provisions, and records the swap for the next run', async () => {
    dockerGoneOnce(GONE);

    const r = await execInContainer('sess-gone', 'echo hi', '/app/coding-workspaces/worktrees/x', 5_000);

    // The daemon's original refusal is preserved (never silently swallowed) …
    expect(r.stderr).toContain('No such container');
    // … and the lane is told, in the same result, the three things it needs.
    expect(r.stderr).toContain('THIS COMMAND DID NOT RUN');
    expect(r.stderr).toContain('re-provisioned');
    expect(r.stderr).toContain('background process');
    // It must state the command provably never started, so re-running it is safe
    // (a lane that believes a command MIGHT have partially run cannot recover).
    expect(r.stderr).toMatch(/never started/);

    // The swap is on record, so the NEXT run's prompt reports it too.
    const stored = await readContainerIdentity('sess-gone');
    expect(stored).not.toBeNull();
    expect(stored!.id).toBe('c'.repeat(64));
  });

  test('a mid-stream mention of the phrase does NOT trigger the replacement path', async () => {
    dockerGoneOnce(`some script output\n${GONE}`);
    const r = await execInContainer('sess-gone', 'docker exec nope true; true', '/tmp', 5_000);
    expect(r.stderr).toContain('No such container');
    expect(r.stderr).not.toContain('THIS COMMAND DID NOT RUN');
    // Nothing recorded — no phantom replacement.
    expect(await readContainerIdentity('sess-gone')).toBeNull();
  });

  test('an ordinary successful exec writes no replacement record and no note', async () => {
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: any, cb: any) => {
      if (args[0] === 'inspect' && args[2] === '{{.Id}}') return cb(null, { stdout: 'd'.repeat(64), stderr: '' });
      return cb(null, { stdout: 'fine', stderr: '' });
    });
    const r = await execInContainer('sess-gone', 'echo hi', '/tmp', 5_000);
    expect(r.stderr).not.toContain('THIS COMMAND DID NOT RUN');
    expect(r.stderr).not.toContain('No such container');
  });
});