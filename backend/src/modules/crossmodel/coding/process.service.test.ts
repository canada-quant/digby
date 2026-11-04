/**
 * process.service — phantom-process guards (ticket e3f24291).
 *
 * The ticket's failure chain: a deploy wiped the session worktree, every
 * docker exec then failed instantly at OCI level ("OCI runtime exec failed:
 * chdir to cwd(...) failed: no such file or directory") — but the error rode
 * home on a stderr that startBackgroundProcess DISCARDED, so a phantom
 * 'running' handle was registered, and waitForProcessOutput mapped the empty
 * stdout to 'timeout' ("process still running") forever. These tests pin the
 * fast-fail contract: real error surfaced, no phantom handle, never a false
 * "still running".
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { startBackgroundProcess, waitForProcessOutput, processSnapshot, listProcesses } from './process.service';

type Shell = (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

const OCI = 'OCI runtime exec failed: chdir to cwd("/app/coding-workspaces/worktrees/229ffae8-70df") failed: no such file or directory\n[exit: 126]';

/** Register one live handle the healthy way, return its handle id. */
async function mkHandle(sessionId: string): Promise<string> {
  const shell: Shell = jest.fn(async () => ({ stdout: 'pgid=111\n', stderr: '' }));
  const r = await startBackgroundProcess(shell, sessionId, { command: 'npm test' });
  expect(r.error).toBeUndefined();
  return r.handle;
}

describe('startBackgroundProcess — phantom-launch guard (ticket e3f24291)', () => {
  it('exec fails at OCI level (empty stdout, real error on stderr): fails fast, registers NO handle', async () => {
    const shell: Shell = jest.fn(async () => ({ stdout: '', stderr: OCI }));
    const r = await startBackgroundProcess(shell, 's-oci', { command: 'npm test' });
    expect(r.error).toBeTruthy();
    expect(r.error).toContain('never started');
    expect(r.error).toContain('OCI runtime exec failed');
    expect(r.handle).toBe('');
    // The phantom factory is dead: no 'running' handle exists to haunt waits.
    expect(processSnapshot('s-oci')).toHaveLength(0);
  });

  it('exec REJECTS (in-process spawn failure): the error is surfaced, no handle registered', async () => {
    const shell: Shell = jest.fn(async () => { throw new Error('spawn bash ENOENT'); });
    const r = await startBackgroundProcess(shell, 's-rej', { command: 'npm test' });
    expect(r.error).toContain('spawn bash ENOENT');
    expect(processSnapshot('s-rej')).toHaveLength(0);
  });

  it('pgid missing with EMPTY stderr is the benign runner-start race — the handle is kept (regression guard)', async () => {
    const shell: Shell = jest.fn(async () => ({ stdout: 'pgid=\n', stderr: '' }));
    const r = await startBackgroundProcess(shell, 's-race', { command: 'npm test' });
    expect(r.error).toBeUndefined();
    expect(r.handle).not.toBe('');
    expect(processSnapshot('s-race')[0].status).toBe('running');
  });

  it('reviewer B2: pgid missing + benign stderr (disk-headroom guardNote, no [exit:]) is NOT a launch failure — handle kept', async () => {
    const guardNote = '[coding container: workspace volume above the 0.85 soft cap — auto-cleaned before this command]';
    const shell: Shell = jest.fn(async () => ({ stdout: 'pgid=\n', stderr: guardNote }));
    const r = await startBackgroundProcess(shell, 's-guard', { command: 'npm test' });
    expect(r.error).toBeUndefined(); // no false "never started" → no double-run via the rail fallthrough
    expect(r.handle).not.toBe('');
    expect(processSnapshot('s-guard')[0].status).toBe('running');
  });

  it('reviewer B2: a launch exec killed by its own 30s cap (— timed out]) is ambiguous — handle kept, NOT declared dead', async () => {
    const shell: Shell = jest.fn(async () => ({ stdout: '', stderr: '[exit: 1 — timed out]' }));
    const r = await startBackgroundProcess(shell, 's-kill', { command: 'npm test' });
    expect(r.error).toBeUndefined(); // the nohup'd runner may be live — never claim "NOT run"
    expect(r.handle).not.toBe('');
  });

  it('a healthy launch registers the handle with its pgid (regression guard)', async () => {
    const shell: Shell = jest.fn(async () => ({ stdout: 'pgid=4242\n', stderr: '' }));
    const r = await startBackgroundProcess(shell, 's-ok', { command: 'npm test' });
    expect(r.error).toBeUndefined();
    expect(r.pgid).toBe('4242');
    expect(processSnapshot('s-ok')[0].status).toBe('running');
  });
});

describe('waitForProcessOutput — dead-shell fast-fail (ticket e3f24291)', () => {
  it('exec fails at OCI level mid-wait: not_found carrying the real error — never "still running"', async () => {
    const handle = await mkHandle('s-w1');
    const dead: Shell = jest.fn(async () => ({ stdout: '', stderr: OCI }));
    const w = await waitForProcessOutput(dead, 's-w1', handle, { timeoutSec: 1 });
    expect(w.outcome).toBe('not_found');
    expect(w.detail).toContain('OCI runtime exec failed');
    expect(w.detail).not.toContain('exit within'); // the old phantom "still running" timeout phrasing
    // …and the wait script itself probes the state dir before polling.
    expect((dead as jest.Mock).mock.calls[0][0]).toContain('__DIGBY_NF__');
  });

  it('the state directory is gone: not_found via the __DIGBY_NF__ short-circuit', async () => {
    const handle = await mkHandle('s-w2');
    const gone: Shell = jest.fn(async (cmd: string) => ({ stdout: cmd.includes('__DIGBY_NF__') ? '__DIGBY_NF__\n' : '', stderr: '' }));
    const w = await waitForProcessOutput(gone, 's-w2', handle, { timeoutSec: 1 });
    expect(w.outcome).toBe('not_found');
    expect(w.detail).toContain('state directory vanished');
    expect(w.detail).not.toMatch(/still running/);
  });

  it('an unknown handle is still not_found (pre-existing contract)', async () => {
    // Since ticket d2531cf5 existence is judged by the script's on-disk
    // __DIGBY_NF__ probe, not the in-memory registry — a real shell answers
    // NF for a handle with no state dir, which is what this mock replays.
    const noDir: Shell = jest.fn(async () => ({ stdout: '__DIGBY_NF__\n', stderr: '' }));
    const w = await waitForProcessOutput(noDir, 's-w3', 'p-nope', { timeoutSec: 1 });
    expect(w.outcome).toBe('not_found');
  });

  it('a genuine poll-loop timeout still reports timeout/"still running" (regression guard)', async () => {
    const handle = await mkHandle('s-w4');
    const slow: Shell = jest.fn(async () => ({ stdout: 'TIMEOUT\n', stderr: '' }));
    const w = await waitForProcessOutput(slow, 's-w4', handle, { timeoutSec: 1 });
    expect(w.outcome).toBe('timeout');
    expect(w.detail).toContain('still running');
  });

  it('reviewer B1: a wait exec KILLED by its own (timeout+10)s cap (— timed out]) reports timeout, NEVER not_found — the detached process survives the client kill', async () => {
    const handle = await mkHandle('s-w6');
    const killed: Shell = jest.fn(async () => ({ stdout: '', stderr: '[exit: 1 — timed out]' }));
    const w = await waitForProcessOutput(killed, 's-w6', handle, { timeoutSec: 1 });
    expect(w.outcome).toBe('timeout'); // the old load-bearing 'TIMEOUT' default behavior, preserved
    expect(w.detail).toContain('still running');
    expect(w.outcome).not.toBe('not_found');
  });

  it('an exit-file appearance still reports exited with the code (regression guard)', async () => {
    const handle = await mkHandle('s-w5');
    const done: Shell = jest.fn(async () => ({ stdout: 'EXITED 0\n', stderr: '' }));
    const w = await waitForProcessOutput(done, 's-w5', handle, { timeoutSec: 1 });
    expect(w.outcome).toBe('exited');
    expect(w.exitCode).toBe('0');
  });

  it('ticket d2531cf5: a wait on an EXITED handle that is NOT in the in-memory registry still resolves from on-disk ground truth', async () => {
    // listProcesses no longer re-registers exited handles; the wait must not
    // falsely report "No such process handle" for a real on-disk one.
    const done: Shell = jest.fn(async () => ({ stdout: 'EXITED 0\n', stderr: '' }));
    const w = await waitForProcessOutput(done, 's-w7', 'p-old-turn', { timeoutSec: 1 });
    expect(w.outcome).toBe('exited');
    expect(w.exitCode).toBe('0');
  });
});

describe('handle cap auto-reap (ticket d2531cf5: "Too many background processes (1730/5)" with ZERO live OS processes)', () => {
  const LAUNCH_OK = { stdout: 'pgid=111\n', stderr: '' };

  /** Start n handles in a session (each with its own healthy launch shell). */
  async function fill(sessionId: string, n: number): Promise<string[]> {
    const handles: string[] = [];
    for (let i = 0; i < n; i++) {
      const shell: Shell = jest.fn(async () => LAUNCH_OK);
      const r = await startBackgroundProcess(shell, sessionId, { command: `watch-${i}` });
      expect(r.error).toBeUndefined();
      handles.push(r.handle);
    }
    return handles;
  }

  it('below the cap, start performs NO reap probe (zero added shell round-trips)', async () => {
    const shell: Shell = jest.fn(async () => LAUNCH_OK);
    const r = await startBackgroundProcess(shell, 's-c0', { command: 'npm test' });
    expect(r.error).toBeUndefined();
    expect((shell as jest.Mock).mock.calls.some(c => String(c[0]).includes('kill -0'))).toBe(false);
  });

  it('tier 1: last-known-exited entries are reaped for FREE (no ground-truth probe), freeing the slot', async () => {
    const handles = await fill('s-c1', 5);
    // Mark 4 exited via ground-truth waits (exit file appeared).
    for (const h of handles.slice(0, 4)) {
      const done: Shell = jest.fn(async () => ({ stdout: 'EXITED 0\n', stderr: '' }));
      await waitForProcessOutput(done, 's-c1', h, { timeoutSec: 1 });
    }
    expect(processSnapshot('s-c1')).toHaveLength(5);
    const next: Shell = jest.fn(async () => LAUNCH_OK);
    const r = await startBackgroundProcess(next, 's-c1', { command: 'new monitor' });
    expect(r.error).toBeUndefined();
    // Tier 1 sufficed → the ground-truth probe never ran.
    expect((next as jest.Mock).mock.calls.some(c => String(c[0]).includes('kill -0'))).toBe(false);
    // 4 reaped + 1 survivor + 1 new = 2 registered.
    expect(processSnapshot('s-c1')).toHaveLength(2);
  });

  it('tier 2: entries with a STALE "running" status are reaped via the ground-truth probe (the 1730 case)', async () => {
    await fill('s-c2', 5); // never read/waited → status 'running' but the OS processes are long dead
    const shell: Shell = jest.fn(async (cmd: string) =>
      String(cmd).includes('kill -0') ? { stdout: '__DIGBY_REAP_OK__\n', stderr: '' } : LAUNCH_OK); // probe: nothing live
    const r = await startBackgroundProcess(shell, 's-c2', { command: 'replacement watchdog' });
    expect(r.error).toBeUndefined();
    const probeCmd = (shell as jest.Mock).mock.calls.find(c => String(c[0]).includes('kill -0'))?.[0];
    expect(probeCmd).toBeTruthy();
    // Fail-safe pins: the probe is valid only with its success sentinel, and a
    // handle whose pgid file is missing/empty is treated as LIVE (review N1).
    expect(probeCmd).toContain('__DIGBY_REAP_OK__');
    expect(probeCmd).toContain('-s "$d/pgid"');
    // All 5 stale entries reaped; only the new handle remains.
    expect(processSnapshot('s-c2')).toHaveLength(1);
  });

  it('the cap error now fires ONLY against confirmed-LIVE processes', async () => {
    const handles = await fill('s-c3', 5);
    const shell: Shell = jest.fn(async (cmd: string) =>
      String(cmd).includes('kill -0') ? { stdout: `${handles.join('\n')}\n__DIGBY_REAP_OK__\n`, stderr: '' } : LAUNCH_OK); // probe: all 5 live
    const r = await startBackgroundProcess(shell, 's-c3', { command: 'one too many' });
    expect(r.error).toBeTruthy();
    expect(r.error).toContain('Too many background processes (5/5 LIVE');
    expect(r.handle).toBe('');
    expect(processSnapshot('s-c3')).toHaveLength(5); // nothing reaped — all genuinely live
  });

  it('a partially-live probe reaps only the dead entries', async () => {
    const handles = await fill('s-c4', 5);
    const shell: Shell = jest.fn(async (cmd: string) =>
      String(cmd).includes('kill -0') ? { stdout: `${handles[0]}\n${handles[1]}\n__DIGBY_REAP_OK__\n`, stderr: '' } : LAUNCH_OK); // 2 live
    const r = await startBackgroundProcess(shell, 's-c4', { command: 'new monitor' });
    expect(r.error).toBeUndefined();
    expect(processSnapshot('s-c4')).toHaveLength(3); // 2 live + 1 new
  });

  it('a failed ground-truth probe reaps NOTHING (fail safe — never drop a handle on a hunch)', async () => {
    await fill('s-c5', 5);
    const shell: Shell = jest.fn(async (cmd: string) => {
      if (String(cmd).includes('kill -0')) throw new Error('docker daemon unreachable');
      return LAUNCH_OK;
    });
    const r = await startBackgroundProcess(shell, 's-c5', { command: 'one too many' });
    expect(r.error).toContain('Too many background processes');
    expect(r.error).toContain('liveness probe unavailable'); // never overclaim LIVE on a failed probe
    expect(r.error).not.toContain(' LIVE');
    expect(processSnapshot('s-c5')).toHaveLength(5);
  });

  it('reviewer B1: a RESOLVED-but-failed probe (empty stdout + [exit:] stderr — the real exec contract) reaps NOTHING', async () => {
    await fill('s-c6', 5);
    // The production execShell never rejects: a daemon-down probe resolves
    // with the error on stderr. Without the success sentinel the old code
    // wiped the registry while the processes were alive (empirical repro).
    const daemonDown: Shell = jest.fn(async (cmd: string) =>
      String(cmd).includes('kill -0')
        ? { stdout: '', stderr: 'Error response from daemon: dial unix /var/run/docker.sock: connect: no such file or directory\n[exit: 1]' }
        : LAUNCH_OK);
    const r = await startBackgroundProcess(daemonDown, 's-c6', { command: 'one too many' });
    expect(r.error).toContain('Too many background processes');
    expect(r.error).toContain('liveness probe unavailable');
    expect(processSnapshot('s-c6')).toHaveLength(5);
  });

  it('reviewer B1: a fail-closed refusal with NO [exit:] marker (agent.ts container-unhealthy literal) reaps NOTHING', async () => {
    await fill('s-c7', 5);
    const refused: Shell = jest.fn(async (cmd: string) =>
      String(cmd).includes('kill -0')
        ? { stdout: '', stderr: '[coding container: not healthy — refusing exec]' }
        : LAUNCH_OK);
    const r = await startBackgroundProcess(refused, 's-c7', { command: 'one too many' });
    expect(r.error).toContain('Too many background processes');
    expect(r.error).toContain('liveness probe unavailable');
    expect(processSnapshot('s-c7')).toHaveLength(5);
  });
});

describe('listProcesses re-registration (ticket d2531cf5)', () => {
  it('re-registers RUNNING disk handles but NOT exited ones (the re-inflation vector)', async () => {
    const shell: Shell = jest.fn(async () => ({
      stdout: 'pd1|exited:0|120|old one-shot\npd2|running|2048|live watcher\n',
      stderr: '',
    }));
    const procs = await listProcesses(shell, 's-l1');
    expect(procs).toHaveLength(2); // both still surface in the tool result
    const snap = processSnapshot('s-l1').map(p => p.handle);
    expect(snap).toContain('pd2');
    expect(snap).not.toContain('pd1'); // dead entries no longer re-inflate the registry
  });
});
