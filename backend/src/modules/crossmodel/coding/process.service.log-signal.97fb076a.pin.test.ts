/**
 * Replay pin — log-signal ticket 97fb076a (family log-signal, 1 member), 2026-11-04.
 *
 * THE TICKET: 501 warn rows / 14 distinct hours for the fingerprint
 * `coding process: background launch failed for session <uuid> — not registering
 * a handle: error response from daemon: no s…`, auto-filed by the hourly
 * log-signal sweep as an internal fault.
 *
 * THE ROOT CAUSE (verified against LIVE app_error_logs rows this run, not the
 * ticket text): the class is an ENVIRONMENTAL transport death — a deploy /
 * restart wave or a host reprovision replaced the session container under a
 * live run, so `docker exec` had no container. The live rows carry TWO daemon
 * dialects, and BOTH belong to the same hand-off:
 *
 *   `Error response from daemon: No such container: digby-dev-83e4fbf9-e18`  (c76cc1b8, 23:29:18Z)
 *   `Error response from daemon: container 6466b239258c… is not running`      (a6b64040, 23:29:05Z)
 *
 * container.service.ts already OWNS this outcome: isContainerGoneError() /
 * the `No such container` leg detects the daemon's refusal, re-provisions via
 * rebindSessionContainer(), and appends the lane-facing "THIS COMMAND DID NOT
 * RUN … the container has now been re-provisioned" addendum (c25f8b7e /
 * e2f40d10). This rail's fail-closed return (no phantom 'running' handle) is
 * the e3f24291 guard WORKING correctly. Nothing in our code is broken — so the
 * sweep filing it forever is a TAXONOMY defect at the emit site: it was an
 * untagged `logger.warn`, which utils/log-level.ts reserves for a genuine
 * internal fault.
 *
 * THIS PIN asserts the taxonomy BEHAVIOURALLY, per the family precedent
 * (cf7baffd): (a) a transport death is emitted through logExternal, so the row
 * carries logClass:'external' and log-signal-sweep.isNonFaultLogRow() accepts
 * it — the sweep never files it again; (b) a failure that is OURS is still an
 * UNTAGGED warn, so detection is NOT weakened; (c) the handle is never
 * registered either way (the phantom-handle contract must survive this change).
 *
 * The assertions read the ARGUMENTS the logger received, not the source text —
 * a string-containment pin would stay green if the call were reverted to
 * `logger.warn(message, { logClass: 'external' })`, which is precisely the
 * splat bug (log-level.ts) that destroys the tag on the most interesting rows.
 */

// The sweep service's import graph reaches config/database → config/env, which
// process.exit(1)s in a worker with no env (the repo's documented idiom — see
// log-signal-family.cf7baffd.pin.test.ts). Only its PURE predicate is under
// test, so the DB/Redis/logger/loop-metric chain is stubbed.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn(), LOOP_METRIC_KINDS: {} }));

import logger from '../../../utils/logger';
import { startBackgroundProcess, processSnapshot } from './process.service';
import { isNonFaultLogRow } from '../fleet/log-signal-sweep.service';

type Shell = (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

const mockLogger = logger as unknown as Record<string, jest.Mock>;
const shellReturning = (stderr: string): Shell => jest.fn(async () => ({ stdout: '', stderr }));

/** The exact daemon dialects present in the LIVE rows for this fingerprint. */
const GONE_NO_SUCH = 'Error response from daemon: No such container: digby-dev-83e4fbf9-e18\n[exit: 1]';
const GONE_NOT_RUNNING = 'Error response from daemon: container 6466b239258c93a314d8a6a4e866822e3e0a8282d658bc51325d702b03b22f8e is not running\n[exit: 1]';
/** The wrapper was SIGKILLed mid-exec — same class, command never ran. */
const WRAPPER_SIGKILL = '[exit: 137]';
/** OURS: the shell died for a reason that is not a transport death (a bare
 *  command-not-found, exit 127, carries no daemon/wrapper signature). */
const COMMAND_OWN_FAILURE = 'bash: line 3: some-tool: command not found\n[exit: 127]';

/** The tags the emit site actually handed the logger for this call. */
function emitted(): { tagged: any[]; untagged: string[] } {
  const tagged = mockLogger.log.mock.calls.map((c) => c[0]).filter(Boolean);
  const untagged = mockLogger.warn.mock.calls.map((c) => String(c[0]));
  return { tagged, untagged };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('97fb076a — a container-replacement transport death is logExternal, not a fault', () => {
  it('"No such container" (the newest live row c76cc1b8) is tagged external and the sweep skips it', async () => {
    const r = await startBackgroundProcess(shellReturning(GONE_NO_SUCH), 's-gone-no-such', { command: 'npm test' });

    // The lane-facing behaviour is UNCHANGED: fail closed, no phantom handle.
    expect(r.error).toContain('never started');
    expect(r.handle).toBe('');
    expect(processSnapshot('s-gone-no-such')).toHaveLength(0);

    const { tagged, untagged } = emitted();
    expect(untagged).toEqual([]); // never an untagged warn => never a sweep ticket
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toMatchObject({ level: 'warn', logClass: 'external' });
    expect(tagged[0].message).toContain('not registering a handle');
    // The message TEXT is unchanged, so existing greps/audit pins keep matching.
    expect(tagged[0].message).toContain('coding process: background launch FAILED for session s-gone-no-such');
    // …and the sweep's own predicate agrees (the two halves must not drift).
    expect(isNonFaultLogRow({ context: { logClass: tagged[0].logClass } })).toBe(true);
  });

  it('"container <id> is not running" (the sibling dialect, a6b64040) is the SAME class', async () => {
    const r = await startBackgroundProcess(shellReturning(GONE_NOT_RUNNING), 's-not-running', { command: 'npm test' });

    expect(r.handle).toBe('');
    expect(processSnapshot('s-not-running')).toHaveLength(0);

    const { tagged, untagged } = emitted();
    expect(untagged).toEqual([]);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toMatchObject({ level: 'warn', logClass: 'external' });
    expect(isNonFaultLogRow({ context: { logClass: tagged[0].logClass } })).toBe(true);
  });

  it('a wrapper SIGKILL ([exit: 137]) is a transport death too, not a command verdict', async () => {
    await startBackgroundProcess(shellReturning(WRAPPER_SIGKILL), 's-137', { command: 'npm test' });

    const { tagged, untagged } = emitted();
    expect(untagged).toEqual([]);
    expect(tagged[0]).toMatchObject({ level: 'warn', logClass: 'external' });
  });
});

describe('97fb076a — a failure that IS ours keeps filing (detection is not weakened)', () => {
  it('a command-own failure (exit 127, no transport signature) stays an UNTAGGED warn', async () => {
    const r = await startBackgroundProcess(shellReturning(COMMAND_OWN_FAILURE), 's-own', { command: 'some-tool' });

    // Still fail-closed for the lane…
    expect(r.handle).toBe('');
    expect(processSnapshot('s-own')).toHaveLength(0);

    // …but never classified as external: this is a real, actionable failure.
    const { tagged, untagged } = emitted();
    expect(tagged).toEqual([]);
    expect(untagged).toHaveLength(1);
    expect(untagged[0]).toContain('not registering a handle');
    expect(untagged[0]).toContain('command not found');
    // An untagged row is a FAULT for the sweep — it must keep filing.
    expect(isNonFaultLogRow({ context: {} })).toBe(false);
    expect(isNonFaultLogRow({ context: undefined })).toBe(false);
  });

  it('a healthy launch logs neither a warn nor an external row', async () => {
    const shell: Shell = jest.fn(async () => ({ stdout: 'pgid=4242\n', stderr: '' }));
    const r = await startBackgroundProcess(shell, 's-ok', { command: 'npm test' });

    expect(r.error).toBeUndefined();
    expect(r.handle).toBeTruthy();
    const { tagged, untagged } = emitted();
    expect(tagged).toEqual([]);
    expect(untagged).toEqual([]);
  });
});