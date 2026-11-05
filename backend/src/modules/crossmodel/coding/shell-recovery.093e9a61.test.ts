/**
 * REPLAY — ticket 093e9a61 (family deploy-kills-lane-background-workers).
 *
 * THE RECURRENCE (filed 2026-11-03T08:42Z, two Schooltime lanes in one hour):
 *   - lane 0037460b: executor died 08:29-08:30Z mid-probe with 3x
 *     `Error response from daemon: No such container: digby-code-0037460b-d23`
 *     (the truncated id in the log is already the tell: a NEW container was
 *     created under the same deterministic name, so the lane could not see the
 *     swap). A supervisor-ordered GPU-quiet render probe missed its window.
 *   - lane 60dfc8a8: 4th container death of the session at ~08:32Z mid-verify;
 *     all three acceptance legs of an ASR restore went unverified that firing.
 * Recovery was only ever at the NEXT run boundary, so every death cost a whole
 * firing. The family's own acceptance bar: "a deploy wave must not orphan a live
 * lane's executor — either the container swap rebinds the executor mid-run, or
 * the lane gets an immediate resume notice instead of a dead shell mid-step."
 *
 * WHAT WAS ALREADY CLOSED BEFORE THIS TICKET (on main, verified by ancestry):
 *   - db50bb288a / #2385 + 8ff282e3a1 / #2388 (c25f8b7e): container-identity.ts
 *     records the docker ID on the coding_session_env volume; a swapped ID
 *     reaches the lane as a run-start prompt block; a mid-run exec that finds
 *     the container GONE re-provisions it and says THIS COMMAND DID NOT RUN.
 *   - 7231ca8690 / #2386 (e2f40d10): the executor rebind (rebindSessionContainer),
 *     isContainerGoneError anchored to docker's OWN refusal, and the missing
 *     uid-1001 passwd rows.
 *
 * THE TIMING FACT THAT MAKES THIS A NEW TICKET, NOT A DUPLICATE (verified from
 * deploy telemetry, corrected after adversarial review: an earlier draft of this
 * note named 84aec07f, which DOES contain the rebind — wrong sha):
 *   - box-c/worker was serving db50bb288a (c25f8b7e's #2385, which LACKS
 *     rebindSessionContainer) until 2026-11-03T08:57:35Z, when it flipped to
 *     84aec07f (which contains the #2386 rebind).
 *   - The deaths are 08:29Z and 08:32Z — i.e. 25-28 minutes BEFORE that flip.
 *   - #2386 itself merged 08:14:30Z, but its deploy run was CANCELED
 *     (41601819238, conclusion `cancelled` — a coalesced wave), so the rebind
 *     reached the box only when 84aec07f landed at 08:57:35Z.
 * So the two deaths ran on a worker that did NOT yet implement the rebind, which
 * is why lane 0037460b saw the bare "No such container" ×3 with no
 * THIS COMMAND DID NOT RUN addendum. The first half of this suite pins the fact
 * those fixes are load-bearing; the second half pins the seam they left open.
 *
 * THE GAP THIS TICKET FIXES (the "executor never rebound" half of the report):
 * `ensureSessionContainer` is called ONCE per run and its result is captured in
 * a constant (agent.ts). When that single call misses — a wave re-provisioning
 * the container at that instant, a Docker probe blip, or the 5-minute
 * failed-session memo left by an earlier failure — execShell refused EVERY shell
 * tool for the whole firing (fail-closed, by design) with no re-resolve. The
 * memo's expiry never helped because nothing re-read it. So one miss cost the
 * firing, and the lane could not even probe to find out why — the exact
 * "no shell commands possible until the next run boundary" symptom reported.
 * recoverSessionShellContainer() re-resolves LIVE, once per run, and re-arms the
 * backoff on failure so a still-broken host costs one attempt, not one per call.
 *
 * SECOND GAP (same family, same "lane believes its work is gone" cost): the glob
 * tool rendered an exec FAILURE as "(no matches)" — a false zero — so a lane
 * whose container had just been replaced was told its files do not exist. grep
 * was fixed for this exact false zero (b6d50f4a); glob never was.
 *
 * DETECTOR NOTE: this suite changes no framework detector (action-verifier,
 * run-evidence-guard, handback-detector, query-suite.py) — it reuses the
 * existing isExecTransportFailure classifier and adds no exemption tier.
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

import prisma from '../../../config/database';
import {
  ensureSessionContainer, recoverSessionShellContainer,
  __resetPreExecDiskGuardForTest, __resetDockerAvailabilityForTest,
  __resetSessionUserRowMemoForTest,
} from './container.service';

const mockedPrisma = prisma as unknown as {
  chatCodingState: { findMany: jest.Mock; findUnique: jest.Mock };
  agentRun: { count: jest.Mock };
};

const SESSION = 'sess-093e9a61-shell-01';

/** Route docker CLI calls to a scripted host. `provisionable` is the knob the
 *  incident needs: a wave window where the daemon answers but cannot create.
 *  A successful `run` really DOES create the container, so `ps` reports it —
 *  without that, "no spurious re-provision" could never be observed. */
function installHost(state: { provisionable: boolean; creates: number; probes: number; running: boolean; ghost?: boolean }) {
  execFileMock.mockImplementation((cmd: string, args: string[], _o: any, cb: any) => {
    if (cmd !== 'docker') return cb(null, { stdout: '', stderr: '' });
    if (args[0] === 'info') { state.probes += 1; return cb(null, { stdout: 'ok', stderr: '' }); }
    if (args[0] === 'ps') {
      // `ps --filter name=^<name>$ --format {{.Names}}` — docker's answer is the
      // container NAME, so derive it from the filter (the format arg is last).
      const filter = args.find(a => /^name=/.test(a)) || '';
      const nm = filter.replace(/^name=\^?/, '').replace(/\$$/, '');
      // -a lists stopped containers too; both are empty unless a run succeeded.
      return cb(null, { stdout: state.running ? `${nm}\n` : '', stderr: '' });
    }
    if (args[0] === 'run') {
      state.creates += 1;
      if (!state.provisionable) {
        // The wave is mid-flight: the daemon is up but the create cannot land.
        const e: any = Object.assign(new Error('docker run failed'), { code: 1, stdout: '', stderr: 'Error response from daemon: conflict' });
        return cb(e, { stdout: '', stderr: e.stderr });
      }
      // `ghost` = the create reports success but the container never comes up
      // (the F3 shape: a NAME resolves, nothing is runnable behind it).
      if (!state.ghost) state.running = true;
      return cb(null, { stdout: '', stderr: '' });
    }
    if (args[0] === 'inspect') {
      // The LIVENESS check (adversarial review F3). A container that is not
      // running cannot be inspected — that is the whole point of the check.
      if (!state.running) {
        const e: any = Object.assign(new Error('docker inspect failed'), { code: 1, stdout: '', stderr: `Error: No such object: ${args[args.length - 1]}` });
        return cb(e, { stdout: '', stderr: e.stderr });
      }
      return cb(null, { stdout: 'sha256:0123456789abcdef0123456789abcdef\n', stderr: '' });
    }
    // provisioning plumbing (uid row, gh fast path, git safe.directory, cp)
    return cb(null, { stdout: '', stderr: '' });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetPreExecDiskGuardForTest();
  __resetDockerAvailabilityForTest();
  __resetSessionUserRowMemoForTest();
  fsStatfsMock.mockResolvedValue({ blocks: 100, bavail: 50 }); // healthy disk
  fsAccessMock.mockResolvedValue(undefined);
  fsRmMock.mockResolvedValue(undefined);
  mockedPrisma.chatCodingState.findUnique.mockResolvedValue({ projectId: null, userId: null });
});

describe('093e9a61 — a stale "no container" binding is re-resolved mid-run, not for the whole firing', () => {
  test('THE INCIDENT: a run that started with NO container recovers its shell without a new run', async () => {
    // Run start: the wave is re-provisioning, so ensureSessionContainer misses.
    // THIS is the state the old code froze into a constant for the whole run.
    const state = { provisionable: false, creates: 0, probes: 0, running: false };
    installHost(state);
    expect(await ensureSessionContainer(SESSION)).toBe(false);

    // Mid-run, the host recovers (the wave finished). The executor's live
    // re-resolve must now find a container — pre-fix, every shell tool for the
    // rest of the firing refused with "Isolated execution is temporarily
    // unavailable" and the lane lost the firing.
    state.provisionable = true;
    expect(await recoverSessionShellContainer(SESSION)).toBe(true);
    expect(state.creates).toBeGreaterThan(0);
  });

  test('the failed-session memo does NOT pin the session for the rest of the firing', async () => {
    // A provisioning failure arms failedSessions for FAILED_SESSION_MEMO_MS
    // (5 min) — far longer than the gap between a wave's teardown and its new
    // worker coming up. Without clearing it, the recovery attempt is a no-op
    // that returns false for five minutes, which on a lane firing every few
    // minutes is indistinguishable from "for the whole run".
    const state = { provisionable: false, creates: 0, probes: 0, running: false };
    installHost(state);
    await ensureSessionContainer(SESSION); // arms the memo
    const createsAfterFirst = state.creates;

    state.provisionable = true;
    expect(await recoverSessionShellContainer(SESSION)).toBe(true);
    // It really re-provisioned rather than taking a memoized "still failed".
    expect(state.creates).toBeGreaterThan(createsAfterFirst);
  });

  test('a STILL-broken host re-arms the memo so the shell does not hammer the daemon', async () => {
    const state = { provisionable: false, creates: 0, probes: 0, running: false };
    installHost(state);

    expect(await recoverSessionShellContainer(SESSION)).toBe(false);
    // A failure RE-ARMS the failed-session memo (the recovery clears it first,
    // because a stale binding is not a provisioning verdict).
    expect(await ensureSessionContainer(SESSION)).toBe(false);
    // …and with the memo armed, the next ensure is memoized: no new create.
    const createsAfterRecovery = state.creates;
    expect(await ensureSessionContainer(SESSION)).toBe(false);
    expect(state.creates).toBe(createsAfterRecovery);
  });

  test('a healthy binding is returned unchanged (no spurious re-provision)', async () => {
    const state = { provisionable: true, creates: 0, probes: 0, running: false };
    installHost(state);
    expect(await ensureSessionContainer(SESSION)).toBe(true);
    const createsAfterRunStart = state.creates;

    // Docker answers and the container is running on the second call, so the
    // ps fast-path returns true without creating anything again.
    expect(await recoverSessionShellContainer(SESSION)).toBe(true);
    expect(state.creates).toBe(createsAfterRunStart);
  });

  test('F3 REGRESSION: a resolved binding whose container is NOT actually there is refused, not reported as recovered', async () => {
    // Adversarial review of this change (finding F3), pinned: a resolution can
    // name a container while NOTHING is running — dev-container.service's
    // `healthyMemo` returns the shared container NAME for 20 s with no liveness
    // check, and a reaped container is still inspectable/named. If recovery
    // trusted that resolution it would tell the lane "the container was
    // re-provisioned, shell tools work again" while every `docker exec` still
    // answered "No such container" — losing the firing AND mislabeling the
    // cause, with the one-attempt-per-run bound already spent.
    //
    // Simulated faithfully: provisioning RESOLVES (the create reports success)
    // but the container never actually comes up, so it is not inspectable.
    const state = { provisionable: true, creates: 0, probes: 0, running: false, ghost: true };
    installHost(state);
    expect(await recoverSessionShellContainer(SESSION)).toBe(false);
  });
});