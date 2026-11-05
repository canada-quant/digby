/**
 * REPLAY — ticket 4bb6a68a (bug_report, ops).
 *
 * THE INCIDENT. Lane f7e14cf8 (project "raspi") had its runs die mid-capture
 * three times inside one session body (≈02:27Z, 07:31Z, 08:22Z on 2026-11-03),
 * each with a wrapper SIGKILL / "No such container: digby-code-f7e14cf8-2d0"
 * while the HOST was healthy (8 CPU / 33 GB free). The lane's model council
 * read it as deterministic environment death.
 *
 * WHAT THE PRODUCTION LOG ACTUALLY HELD (24h app_error_logs sweep, this
 * ticket's diagnosis):
 *   - `coding container: reaped idle container …`      → 0 rows
 *   - `coding container: age-recycled …`               → 0 rows
 *   - `coding container: recycling … hard cap`         → 0 rows
 *   - `coding container: session-bg reap failed for <sid> (non-fatal):
 *      docker exec digby-code-<sid12> bash -lc # DIGBY-SESSION-BG-RUNEND`
 *      → f7e14cf8 at 07:31:52Z AND 08:31:48Z, plus 8 MORE sessions
 *        (3556c8a4, 60dfc8a8, c5290a6a, 4a57774f, 3db3c592, 0ef29d23,
 *         5c598313, cd705927, 0037460b, bc2a3817)
 *   - `coding container: REPLACED … digby-dev-83e4fbf9-e18 now d4e6431c627d,
 *      previous b56a5ecea6bb`                          → many sessions
 *
 * So NO reaper and NO disk-pressure guard removed anything: the container-gone
 * deaths are the documented deploy-wave replacement (already surfaced by
 * c25f8b7e / e2f40d10, both on main). The UNFIXED defect is the second one:
 * the reap execs a container name that has never existed for these sessions.
 *
 * THE BUG. `execTargetName()` is `sharedOverride.get(sid) ?? containerName(sid)`
 * — an IN-PROCESS Map populated only by the process that ran
 * ensureSessionContainer. A reap in any other process has a cold map and falls
 * back to `digby-code-<sid12>`, which exists ONLY for sessions that did NOT get
 * the shared dev container. For a session that DID, the reap therefore execs a
 * phantom, throws "No such container", logs a warning and SILENTLY REAPS
 * NOTHING. The leaked background processes then pin the shared container's
 * cgroup and the NEXT run's verify dies SIGKILLed (exit 137, empty output) —
 * the orphan doctrine already written down at reapOrphanedBuildProcesses.
 *
 * THE FIX (this suite pins it). Resolve the reap target from the daemon's own
 * durable labels — `digby.code.session=<full session id>` on a per-session
 * container, `digby.dev.container=<userId>` on the shared one — consulting the
 * warm map first and NEVER inventing a target: no match keeps the pre-existing
 * fallback exactly.
 */

process.env.CODING_CONTAINER_MODE = '1';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique = jest.fn();
// The idle sweep batches its user-id lookup through findMany({where:{id:{in}}}).
// Answer it per requested id (default: every id belongs to USER) so the sweep
// sees the same reality findUnique would have reported one session at a time.
const mockFindMany = jest.fn(async (args: any): Promise<Array<{ id: string; userId: string }>> => {
  const ids: string[] = args?.where?.id?.in ?? [];
  return ids.map((id) => ({ id, userId: USER }));
});
const MOCK_USER = '83e4fbf9-e18a-4c5d-9f11-2b6c8a1d0e33';
void MOCK_USER;
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatCodingState: {
      findUnique: (a: any) => mockFindUnique(a),
      findMany: (a: any) => mockFindMany(a),
    },
    agentRun: { count: jest.fn(async () => 0) },
  },
}));

jest.mock('fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('fs/promises'),
  access: jest.fn(async () => undefined),
  statfs: jest.fn(async () => ({ blocks: 100, bavail: 50, bsize: 4096, bfree: 50 })),
  rm: jest.fn(async () => undefined),
  mkdir: jest.fn(async () => undefined),
}));

const execFileMock = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args: any[]) => execFileMock(...args) }));

import {
  reapSessionBackgroundProcesses,
  reapIdleSessionBackgroundProcesses,
  __resetDockerAvailabilityForTest,
  __resetPreExecDiskGuardForTest,
} from './container.service';

const SESSION = 'f7e14cf8-2d0f-4e61-b152-81c1376d4b77';
const SID12 = SESSION.slice(0, 12);
const PHANTOM = `digby-code-${SID12}`;      // never existed for a shared session
const USER = '83e4fbf9-e18a-4c5d-9f11-2b6c8a1d0e33';
const DEV = `digby-dev-${USER.slice(0, 12)}`; // the shared dev container

/** Every docker invocation the code made this test. */
let calls: string[][] = [];

/**
 * Script the docker CLI. `ps` answers the label table the daemon would print;
 * `exec` echoes a reap-script transcript (so a real reap is distinguishable
 * from a phantom-target throw). `null` for a row value = a failed daemon read.
 */
function installDocker(opts: {
  psRows?: Array<{ name: string; session?: string; dev?: string }> | null;
  psFails?: boolean;
}) {
  execFileMock.mockImplementation((cmd: string, args: string[], _o: any, cb: any) => {
    if (cmd !== 'docker') return cb(null, { stdout: '', stderr: '' });
    calls.push(args);
    if (args[0] === 'info') return cb(null, { stdout: 'ok', stderr: '' });
    if (args[0] === 'ps') {
      if (opts.psFails || opts.psRows === null) {
        return cb(Object.assign(new Error('daemon down'), { code: 1, stderr: 'Cannot connect to the Docker daemon' }), { stdout: '', stderr: 'Cannot connect to the Docker daemon' });
      }
      const rows = (opts.psRows ?? []).map((r) => `${r.name}\t${r.session ?? ''}\t${r.dev ?? ''}`).join('\n');
      return cb(null, { stdout: rows ? `${rows}\n` : '', stderr: '' });
    }
    if (args[0] === 'exec') {
      if (opts.psFails) {
        return cb(Object.assign(new Error('Cannot connect to the Docker daemon'), { code: 1, stderr: 'Cannot connect to the Docker daemon' }), { stdout: '', stderr: 'Cannot connect to the Docker daemon' });
      }
      // The daemon refuses a name it has no container for — the exact mistake
      // this ticket is about.
      const target = args.find((a) => a.startsWith('digby-'));
      const known = new Set([DEV, PHANTOM]);
      if (opts.psRows !== null && opts.psRows && !opts.psRows.some((r) => r.name === target) && target === PHANTOM && opts.psRows.length > 0) {
        return cb(
          Object.assign(new Error('docker exec failed'), { code: 1, stderr: `Error response from daemon: No such container: ${target}` }),
          { stdout: '', stderr: `Error response from daemon: No such container: ${target}` },
        );
      }
      if (!known.has(target!) && target !== PHANTOM) {
        return cb(Object.assign(new Error('nope'), { code: 1, stderr: `Error response from daemon: No such container: ${target}` }), { stdout: '', stderr: '' });
      }
      // A real reap: one victim + the success sentinel.
      return cb(null, { stdout: '__REAPED__ 4242 node --watch\n__BG_REAP_OK__\n', stderr: '' });
    }
    return cb(null, { stdout: '', stderr: '' });
  });
}

const execCalls = () => calls.filter((a) => a[0] === 'exec');
const reapTargets = () => execCalls().map((a) => a.find((x) => x.startsWith('digby-')));

beforeEach(() => {
  jest.clearAllMocks();
  calls = [];
  __resetDockerAvailabilityForTest();
  __resetPreExecDiskGuardForTest();
  mockFindUnique.mockResolvedValue({ userId: USER });
});

describe('reap target resolution — a shared-dev-container session must never exec a phantom per-session name (4bb6a68a)', () => {
  test('THE FIX: a COLD map + a shared dev container resolves to the REAL container, and the reap actually runs', async () => {
    // The session lives in the shared dev container; this process never ran
    // ensureSessionContainer for it, so sharedOverride is cold — production's
    // exact situation (a different worker, or this one after a deploy).
    installDocker({
      psRows: [
        { name: DEV, dev: USER },
        { name: 'digby-code-aaaaaaaa-bbbb', session: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      ],
    });

    const r = await reapSessionBackgroundProcesses(SESSION);

    const targets = reapTargets();
    expect(targets.length).toBeGreaterThan(0);
    // The whole ticket: it must NOT be the phantom per-session name.
    expect(targets).not.toContain(PHANTOM);
    expect(targets[0]).toBe(DEV);
    // ...and because it resolved to the SHARED container, the exec must drop to
    // uid 1001 (the container's session user), exactly as a warm resolve does.
    const exec = execCalls()[0];
    expect(exec.slice(0, 3)).toEqual(['exec', '-u', '1001:1001']);
    // A real reap happened rather than a silent no-op.
    expect(r.ok).toBe(true);
    expect(r.reaped).toBe(1);
  });

  test('THE BUG IT REPLACES: with the cold map and no label match, nothing is invented (fallback preserved)', async () => {
    // A daemon that answers but knows no container for this session — the
    // pre-fix behaviour must be kept byte-for-byte rather than guessing.
    installDocker({ psRows: [{ name: 'digby-code-ffffffff-0000', session: 'ffffffff-0000-1111-2222-333333333333' }] });

    const r = await reapSessionBackgroundProcesses(SESSION);

    expect(reapTargets()).toEqual([PHANTOM]); // today's fallback, unchanged
    expect(r.ok).toBe(false);                 // the daemon refuses it
  });

  test('a per-session container is found by its FULL-session-id label (not the truncated name)', async () => {
    // containerName() truncates to 12 chars, so the NAME alone can never prove
    // identity; the label carries the full id and a recreated container keeps
    // its name while its id changes.
    const live = `digby-code-${SID12}`;
    installDocker({ psRows: [{ name: live, session: SESSION }] });

    const r = await reapSessionBackgroundProcesses(SESSION);

    expect(reapTargets()[0]).toBe(live);
    // NOT the shared -u arm: a per-session reap execs as the container's own
    // create-time --user, exactly as before this change.
    expect(execCalls()[0].slice(0, 2)).toEqual(['exec', live]);
    expect(r.ok).toBe(true);
  });

  test('an unreadable daemon keeps the fallback and never throws (reap must not block a finalize path)', async () => {
    installDocker({ psFails: true });

    const r = await reapSessionBackgroundProcesses(SESSION);

    expect(r.ok).toBe(false);
    expect(reapTargets()).toEqual([PHANTOM]);
  });

  test('no chatCodingState row (an unknown user) still finds the per-session container by label alone', async () => {
    mockFindUnique.mockResolvedValue(null);
    installDocker({ psRows: [{ name: PHANTOM, session: SESSION }] });

    const r = await reapSessionBackgroundProcesses(SESSION);

    expect(reapTargets()[0]).toBe(PHANTOM);
    expect(r.ok).toBe(true);
  });
});

/**
 * The IDLE SWEEP is the path that is genuinely cold in production — it runs in
 * the worker reaper process, which never calls ensureSessionContainer, so
 * before this change it ALWAYS fell back to `digby-code-<sid12>` and never
 * swept a shared-container daemon at all. It is also the only path whose
 * grouping semantics changed, so it gets its own pins.
 */
describe('idle sweep — label-backed grouping, one daemon read per sweep (4bb6a68a)', () => {
  const OTHER = 'c5290a6a-d040-4ea4-b75f-d5499ac61934';
  const PER_SESSION = `digby-code-${OTHER.slice(0, 12)}`;

  test('two sessions sharing the dev container collapse to ONE sweep against the REAL container', async () => {
    installDocker({ psRows: [{ name: DEV, dev: USER }] });

    const reaped = await reapIdleSessionBackgroundProcesses([SESSION, OTHER]);

    // One group => one exec, against the shared container (not either phantom).
    expect(execCalls().length).toBe(1);
    expect(reapTargets()).toEqual([DEV]);
    expect(execCalls()[0].slice(0, 3)).toEqual(['exec', '-u', '1001:1001']);
    expect(reaped).toBe(1);
  });

  test('ONE `docker ps` and ONE findMany cover the whole sweep — never one per session', async () => {
    installDocker({ psRows: [{ name: DEV, dev: USER }] });

    await reapIdleSessionBackgroundProcesses([SESSION, OTHER, PER_SESSION.slice(-12)]);

    expect(calls.filter((a) => a[0] === 'ps').length).toBe(1);
    // findMany is batched: mockFindUnique is the per-session path and must not
    // be used by the sweep at all.
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  test('a per-session container in the same batch keeps its own uid arm', async () => {
    // Mixed batch: one shared-container session, one with its own container.
    installDocker({
      psRows: [
        { name: DEV, dev: USER },
        { name: PER_SESSION, session: OTHER },
      ],
    });

    await reapIdleSessionBackgroundProcesses([SESSION, OTHER]);

    const targets = reapTargets();
    expect(targets).toContain(DEV);
    expect(targets).toContain(PER_SESSION);
    const perSessionExec = execCalls().find((a) => a.includes(PER_SESSION))!;
    expect(perSessionExec.slice(0, 2)).toEqual(['exec', PER_SESSION]); // no -u arm
  });

  test('the sweep still degrades to the old name when the daemon cannot be read', async () => {
    installDocker({ psFails: true });

    const reaped = await reapIdleSessionBackgroundProcesses([SESSION, OTHER]);

    expect(reaped).toBe(0);
    expect(reapTargets().every((t) => t!.startsWith('digby-code-'))).toBe(true);
  });
});