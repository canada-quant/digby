/**
 * Digby Code — the MONITOR primitive: background process supervisor.
 *
 * run_command blocks with a timeout, so a dev server / test-watcher can't run.
 * This layer runs long-lived processes DETACHED on top of the same execShell
 * primitive (docker exec in container mode, bash in-process otherwise): a new
 * session (setsid → own process group) writing to a log file, with a tiny on-disk
 * registry under /tmp/digby-proc/<sessionId>/<handle>. The agent reads new output
 * from a byte offset (Claude Code's BashOutput "new-since-last" model), and status
 * is recomputed from ground truth (exit file / kill -0) on every read — never cached.
 *
 * Cleanup is free: `docker rm -f` (session stop / idle reaper) kills the whole
 * container, its process groups, and the /tmp registry. We also clear the
 * in-memory offset map via clearProcessRegistry(). Kill uses the process GROUP
 * (kill -- -pgid) so forked workers (webpack, vite) don't survive.
 *
 * The handle cap counts only LIVE processes: when the in-memory registry is at
 * the cap, startBackgroundProcess first auto-reaps dead entries (tier 1: last-
 * known-exited, free; tier 2: one ground-truth exit-file/kill -0 probe), so a
 * long-lived session's registry can't saturate on leaked dead handles (ticket
 * d2531cf5 — a 20h monitor session hit "1730/5" with ZERO live OS processes).
 *
 * Pitfalls handled: stdin from /dev/null (avoids TTY-wait wedge), group-kill,
 * ground-truth status, bounded reads. Deferred (roadmap): PTY for tools that only
 * flush to a TTY; publishing a port so browser_task can reach the dev server
 * (today: drive it with curl from inside the container via run_command).
 */

import logger from '../../../utils/logger';
import { logExternal } from '../../../utils/log-level';
import { isExecTransportFailure } from './exec-transport';

type ExecShell = (command: string, cwd?: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string }>;

interface Handle {
  name: string; command: string; offset: number;
  startedAt?: number;
  status?: 'running' | 'exited';
  exitCode?: string | null;
  port?: number; // declared readiness port (dev servers) — drives the preview pane
}
interface SessionProcs { counter: number; handles: Map<string, Handle>; }

const registry = new Map<string, SessionProcs>();
const MAX_HANDLES = 5;
const READ_CAP = 20_000;
const PROC_ROOT = '/tmp/digby-proc';

function sess(sessionId: string): SessionProcs {
  let s = registry.get(sessionId);
  if (!s) { s = { counter: 0, handles: new Map() }; registry.set(sessionId, s); }
  return s;
}

/** Drop a session's in-memory handles (call when its container is removed). */
export function clearProcessRegistry(sessionId: string): void { registry.delete(sessionId); }

/**
 * Forget one handle WITHOUT killing anything — for processes that already
 * exited (the auto-mode run_command rail returns fast commands and releases
 * the slot so MAX_HANDLES doesn't fill up with finished one-shots).
 */
export function releaseHandle(sessionId: string, handle: string): void {
  registry.get(sessionId)?.handles.delete(handle);
}

export interface ProcSnapshot {
  handle: string; name: string; command: string;
  status: 'running' | 'exited';
  exitCode: string | null;
  port?: number;
  startedAt?: number;
}

/**
 * In-memory view of a session's background processes — no shell round-trip, so
 * it's cheap enough to emit to the sidebar on every process-affecting tool.
 * Status is last-KNOWN (reads/waits/stops update it); the disk is ground truth.
 */
export function processSnapshot(sessionId: string): ProcSnapshot[] {
  const s = registry.get(sessionId);
  if (!s) return [];
  return [...s.handles.entries()].map(([handle, h]) => ({
    handle, name: h.name, command: h.command.slice(0, 120),
    status: h.status ?? 'running',
    exitCode: h.exitCode ?? null,
    port: h.port,
    startedAt: h.startedAt,
  }));
}

function markStatus(sessionId: string, handle: string, status: 'running' | 'exited', exitCode?: string | null): void {
  const h = registry.get(sessionId)?.handles.get(handle);
  if (h) { h.status = status; if (exitCode !== undefined) h.exitCode = exitCode; }
}

function b64(s: string): string { return Buffer.from(s, 'utf8').toString('base64'); }
function dirFor(sessionId: string, handle: string): string { return `${PROC_ROOT}/${sessionId}/${handle}`; }

/**
 * Auto-reap dead registry entries BEFORE the handle cap is enforced (ticket
 * d2531cf5). The cap used to count EVERY in-memory entry, and entries were
 * removed only by stop_process / the run_command fast-path releaseHandle — a
 * process that exited naturally (e.g. a promoted run_command nobody read
 * again) leaked its entry forever, so a long-lived session's registry grew
 * monotonically until start_background_process hard-failed with ZERO live OS
 * processes (a 20h monitor session reported "1730/5"). Two tiers, run only
 * when the registry is at the cap (zero cost in the common case):
 *   1. free — drop entries whose last-KNOWN status is 'exited' (a read/wait/
 *      list already observed ground truth);
 *   2. one shell pass — re-derive liveness from the on-disk ground truth (exit
 *      file / kill -0, the same probes readProcessOutput uses) and drop every
 *      remaining entry not confirmed live. This catches entries with a STALE
 *      'running' status (started, promoted, never read again — the 1730 case).
 * On-disk state dirs are left untouched, so final output stays readable;
 * stop_process / the container reaper still own real cleanup. Best-effort: a
 * probe failure reaps nothing (fail safe — never drop a handle on a hunch).
 *
 * Returns false ONLY when the tier-2 probe ran and FAILED (survivors are then
 * of unknown liveness — the cap error must not claim them LIVE, review N1-r2);
 * true when no failed probe happened (including "below cap, never ran").
 */
async function reapDeadHandles(execShell: ExecShell, sessionId: string, cwd?: string): Promise<boolean> {
  const s = registry.get(sessionId);
  if (!s || s.handles.size < MAX_HANDLES) return true;
  for (const [handle, h] of [...s.handles]) {
    if (h.status === 'exited') s.handles.delete(handle);
  }
  if (s.handles.size < MAX_HANDLES) return true;
  const BASE = `${PROC_ROOT}/${sessionId}`;
  // A handle whose pgid file is missing/empty is treated as LIVE: the e3f24291
  // "benign runner-start race" registers the handle before run.sh lands the
  // pgid, and kill -0 cannot prove such a process dead (adversarial review N1).
  // The script ALWAYS ends with the __DIGBY_REAP_OK__ sentinel, and the probe
  // is valid ONLY when the sentinel comes back: the production execShell NEVER
  // rejects — infra failures RESOLVE with empty stdout + '[exit: …]' stderr
  // (container.service.ts:405, agent.ts:107), or as fail-closed refusal
  // literals with NO [exit: marker (agent.ts:687/:694) — so a resolved-but-
  // failed probe must reap NOTHING. The old `catch → null` check was void
  // under that contract and would have wiped the registry while the processes
  // were alive (adversarial review B1, empirically reproduced).
  const script = `[ -d "${BASE}" ] || { echo "__DIGBY_REAP_OK__"; exit 0; }
for d in "${BASE}"/*/; do
  [ -d "$d" ] || continue
  if [ -f "$d/exit" ]; then continue; fi
  if [ ! -s "$d/pgid" ]; then basename "$d"; continue; fi
  if kill -0 -"$(cat "$d/pgid" 2>/dev/null)" 2>/dev/null; then basename "$d"; fi
done
echo "__DIGBY_REAP_OK__"`;
  const { stdout } = await execShell(script, cwd, 15_000).catch(() => ({ stdout: '' }));
  if (!stdout.includes('__DIGBY_REAP_OK__')) return false; // probe failed — reap nothing rather than guess
  const live = new Set(stdout.split('\n').map(l => l.trim()).filter(l => l && l !== '__DIGBY_REAP_OK__'));
  for (const handle of [...s.handles.keys()]) {
    if (!live.has(handle)) s.handles.delete(handle);
  }
  return true;
}

/**
 * True only when stderr carries a REAL exec-failure signature. Both exec
 * wrappers (container.service.ts:377, agent.ts:111) append `[exit: …]` to
 * stderr on EVERY failure — so its absence means the exec succeeded (benign
 * stderr like the disk-headroom guardNote, container.service.ts:417, or a
 * bash locale warning must never fast-fail anything). The one exception we
 * must NOT treat as dead: a client-side timeout KILL appends `— timed out]`
 * — ambiguous, because the detached setsid process is unaffected by the
 * client kill and may be perfectly alive (adversarial review B1/B2).
 */
function execFailedHard(stderr: string): boolean {
  return /\[exit:/.test(stderr) && !/— timed out\]/.test(stderr);
}

export interface StartResult { handle: string; name: string; pgid: string | null; logPath: string; ready?: { ok: boolean; detail: string }; error?: string; }

export async function startBackgroundProcess(
  execShell: ExecShell,
  sessionId: string,
  opts: { command: string; name?: string; cwd?: string; ready?: { port?: number; httpPath?: string; logMatch?: string; timeoutSec?: number } },
): Promise<StartResult> {
  const s = sess(sessionId);
  const probeOk = await reapDeadHandles(execShell, sessionId, opts.cwd);
  const live = [...s.handles.keys()];
  if (live.length >= MAX_HANDLES) {
    // probeOk ⇒ survivors were confirmed live by the ground-truth probe; a
    // failed probe leaves liveness UNKNOWN — say so instead of overclaiming.
    const verdict = probeOk ? ' LIVE' : ' (liveness probe unavailable — some may be dead but could not be confirmed)';
    return { handle: '', name: '', pgid: null, logPath: '', error: `Too many background processes (${live.length}/${MAX_HANDLES}${verdict} — confirmed-dead handles were auto-reaped first). stop_process one first (handles: ${live.join(', ')}).` };
  }
  const command = String(opts.command || '').trim();
  if (!command) return { handle: '', name: '', pgid: null, logPath: '', error: 'No command provided.' };

  s.counter += 1;
  const handle = `p${Date.now().toString(36).slice(-5)}${s.counter}`;
  const H = dirFor(sessionId, handle);
  const runner = `echo $$ > "${H}/pgid"\nbash "${H}/cmd" < /dev/null > "${H}/log" 2>&1\necho $? > "${H}/exit"\n`;
  const script = [
    `mkdir -p "${H}"`,
    `printf %s ${b64(command)} | base64 -d > "${H}/cmd"`,
    `printf %s ${b64(runner)} | base64 -d > "${H}/run.sh"`,
    `nohup setsid bash "${H}/run.sh" >/dev/null 2>&1 &`,
    `disown 2>/dev/null || true`,
    `sleep 0.2`,
    `echo "pgid=$(cat "${H}/pgid" 2>/dev/null)"`,
  ].join('\n');

  const { stdout, stderr } = await execShell(script, opts.cwd, 30_000).catch((e: any) => ({ stdout: '', stderr: `[exit: exec] ${e.message}` }));
  const pgid = (stdout.match(/pgid=(\d+)/) || [])[1] || null;
  // Ticket e3f24291: when the exec ITSELF fails (OCI chdir on a vanished
  // worktree, daemon down, spawn error) stdout is empty and the real error is
  // on stderr — the old code discarded stderr and registered a PHANTOM
  // 'running' handle that then hung every wait/read forever. Fail fast with
  // the real error instead; the run_command rail falls through to a direct
  // exec, which surfaces the same error as the command result.
  // Reviewer B2 — fast-fail ONLY on a real failure signature: a successful
  // exec can still carry stderr (the disk-headroom guardNote is prepended to
  // every exec past the soft cap, container.service.ts:417; bash can warn on
  // its own), and a client-side timeout kill ('— timed out]') is ambiguous —
  // the nohup'd runner may already be live. Both keep the handle, exactly as
  // before. pgid=null with clean stderr stays the benign 0.2s runner race.
  if (!pgid && stderr && execFailedHard(stderr)) {
    const detail = stderr.trim().split('\n').slice(0, 4).join('\n').slice(0, 400);
    // LOG TAXONOMY (ticket 97fb076a, family log-signal — 501 rows / 14 hours).
    // TWO different things reach this branch and they are NOT the same class:
    //
    //  1. The exec TRANSPORT died — the session container was replaced or
    //     stopped under a live run by a deploy/restart wave or a host
    //     reprovision ("No such container: digby-dev-…", "container <id> is
    //     not running", a wrapper SIGKILL). container.service.ts ALREADY owns
    //     this: it detects the daemon's refusal, re-provisions, and hands the
    //     lane a "THIS COMMAND DID NOT RUN … the container has now been
    //     re-provisioned" addendum (c25f8b7e / e2f40d10), and this rail's
    //     fail-closed return is the e3f24291 phantom-handle guard WORKING.
    //     Nothing is wrong with our code, so an untagged warn made the hourly
    //     log-signal sweep fingerprint an environmental class as an internal
    //     fault and re-file it every week, forever. Tag it logExternal (the
    //     utils/log-level.ts three-way convention) so the sweep can tell it
    //     from a real fault — the same adjudication the cf7baffd family made
    //     for three other designed-outcome sites.
    //  2. The command itself never produced a shell for a reason that IS ours
    //     (a genuine spawn/OCI failure with no transport signature). That
    //     stays an UNTAGGED warn so it still files.
    //
    // isExecTransportFailure is the leaf predicate (./exec-transport, no
    // imports) that already names exactly this class elsewhere in the harness,
    // so this seam cannot drift from the rest of the exec layer. Never weaken
    // the return below: the handle must not be registered either way.
    const message = `coding process: background launch FAILED for session ${sessionId} — not registering a handle: ${detail}`;
    if (isExecTransportFailure(stderr)) {
      // OBJECT form on purpose: `detail` can carry printf tokens (a provider
      // body, SQL with '%foo%'), and the two-arg splat form would format the
      // meta into the message and DESTROY the logClass tag (see log-level.ts).
      logExternal(message, { source: 'coding-process' });
    } else {
      logger.warn(message);
    }
    return { handle: '', name: opts.name || command.slice(0, 40), pgid: null, logPath: '', error: `Background launch failed — the process never started (the command was NOT run).\n${detail}` };
  }
  s.handles.set(handle, {
    name: opts.name || command.slice(0, 40), command, offset: 0,
    startedAt: Date.now(), status: 'running', port: opts.ready?.port,
  });
  logger.info(`coding process: started ${handle} (${command.slice(0, 60)}) for session ${sessionId}`);

  const result: StartResult = { handle, name: opts.name || command.slice(0, 40), pgid, logPath: `${H}/log` };
  if (opts.ready && (opts.ready.port || opts.ready.logMatch)) {
    result.ready = await waitForReady(execShell, sessionId, handle, opts.ready, opts.cwd);
  }
  return result;
}

async function waitForReady(
  execShell: ExecShell,
  sessionId: string,
  handle: string,
  ready: { port?: number; httpPath?: string; logMatch?: string; timeoutSec?: number },
  cwd?: string,
): Promise<{ ok: boolean; detail: string }> {
  const H = dirFor(sessionId, handle);
  const timeout = Math.min(180, Math.max(1, ready.timeoutSec || 30));
  const checks: string[] = [];
  if (ready.logMatch) checks.push(`grep -q -- "$(printf %s ${b64(ready.logMatch)} | base64 -d)" "${H}/log" 2>/dev/null && { echo "READY log"; exit 0; }`);
  if (ready.port) {
    if (ready.httpPath) {
      checks.push(`(exec 3<>/dev/tcp/127.0.0.1/${ready.port}) 2>/dev/null && curl -sf "http://127.0.0.1:${ready.port}${ready.httpPath}" >/dev/null 2>&1 && { echo "READY http"; exit 0; }`);
    } else {
      checks.push(`(exec 3<>/dev/tcp/127.0.0.1/${ready.port}) 2>/dev/null && { echo "READY port"; exit 0; }`);
    }
  }
  // Run readiness checks BEFORE the exit check (mirroring waitForProcessOutput),
  // and — for logMatch readiness — re-check the log ONE last time on exit: a
  // fast command that printed its success marker and exited between poll ticks
  // was wrongly reported "NOT ready (EXITED 0)" though the marker was present
  // (prod session 7242c1e4). Port-only readiness keeps exit ⇒ not-ready.
  const finalLogCheck = ready.logMatch
    ? `grep -q -- "$(printf %s ${b64(ready.logMatch)} | base64 -d)" "${H}/log" 2>/dev/null && { echo "READY log (exited $(cat "${H}/exit"))"; exit 0; }`
    : '';
  const script = `for i in $(seq 1 ${timeout}); do
  ${checks.join('\n  ')}
  if [ -f "${H}/exit" ]; then ${finalLogCheck} echo "EXITED $(cat "${H}/exit")"; exit 1; fi
  sleep 1
done
echo "TIMEOUT"; exit 1`;
  const { stdout } = await execShell(script, cwd, (timeout + 5) * 1000).catch((e: any) => ({ stdout: e.stdout?.toString?.() || 'TIMEOUT', stderr: '' }));
  const out = (stdout || '').trim();
  return { ok: out.startsWith('READY'), detail: out.split('\n').pop() || out };
}

export interface ReadResult { chunk: string; nextOffset: number; status: string; exitCode: string | null; notFound?: boolean; }

/**
 * wait_for_process_output (2026-07-14): block SERVER-SIDE until a log pattern
 * appears or the process exits — ONE tool call instead of an agent-step-burning
 * read_process_output poll loop. Mirrors waitForReady's shell technique (the
 * wait happens in the session shell/container, not the Node event loop). Caps
 * at 240s per call; the agent can re-call for longer waits.
 */
export async function waitForProcessOutput(
  execShell: ExecShell,
  sessionId: string,
  handle: string,
  opts: { logMatch?: string; timeoutSec?: number },
  cwd?: string,
): Promise<{ outcome: 'matched' | 'exited' | 'timeout' | 'not_found'; detail: string; exitCode: string | null }> {
  // Existence is judged by ON-DISK ground truth (the script's __DIGBY_NF__
  // probe below), not the in-memory registry: handles from a previous turn are
  // only re-registered while RUNNING (ticket d2531cf5), so an exited-but-real
  // handle must still resolve here instead of falsely reporting "No such".
  const H = dirFor(sessionId, handle);
  const timeout = Math.min(240, Math.max(1, opts.timeoutSec || 120));
  const matchCheck = opts.logMatch
    ? `grep -q -- "$(printf %s ${b64(opts.logMatch)} | base64 -d)" "${H}/log" 2>/dev/null && { echo "MATCHED"; exit 0; }`
    : '';
  const script = `if [ ! -d "${H}" ]; then echo "__DIGBY_NF__"; exit 0; fi
for i in $(seq 1 ${timeout}); do
  ${matchCheck}
  if [ -f "${H}/exit" ]; then echo "EXITED $(cat "${H}/exit")"; exit 0; fi
  sleep 1
done
echo "TIMEOUT"`;
  const { stdout, stderr } = await execShell(script, cwd, (timeout + 10) * 1000)
    .catch((e: any) => ({ stdout: e.stdout?.toString?.() || '', stderr: (e.stderr?.toString?.() || '') || `[exit: exec] ${e.message || 'exec failed'}` }));
  const out = (stdout || '').trim().split('\n').pop() || '';
  if (out === '__DIGBY_NF__') {
    // Ground truth is gone (worktree/container wiped, e.g. by a deploy) — the
    // process is dead; never report it as still running (ticket e3f24291).
    markStatus(sessionId, handle, 'exited', null);
    return { outcome: 'not_found', detail: `The process's state directory vanished (the worktree/container was lost, e.g. by a deploy) — it is NOT running. Stop waiting on it; re-run the command once the workspace is re-provisioned.`, exitCode: null };
  }
  // Ticket e3f24291: when the exec ITSELF fails (OCI chdir on a vanished
  // worktree, daemon down) stdout is empty and the real error is on stderr —
  // the old code mapped that to 'timeout' ("process still running"), which is
  // how a dead handle burned waits forever. Surface the real error instead.
  // Reviewer B1 — a client-side timeout KILL ('— timed out]') is NOT a death
  // certificate: the detached setsid process survives the kill, so that case
  // must fall through to the genuine 'timeout' verdict below, exactly as the
  // old 'TIMEOUT' default handled it.
  if (!out && stderr && execFailedHard(stderr)) {
    const detail = stderr.trim().split('\n').slice(0, 4).join('\n').slice(0, 400);
    return { outcome: 'not_found', detail: `The wait could not reach the process's shell — treating the process as dead, NOT still running. Underlying error:\n${detail}`, exitCode: null };
  }
  if (out.startsWith('MATCHED')) return { outcome: 'matched', detail: `Pattern "${opts.logMatch}" appeared in the log.`, exitCode: null };
  if (out.startsWith('EXITED')) {
    const code = out.split(' ')[1] ?? null;
    markStatus(sessionId, handle, 'exited', code);
    return { outcome: 'exited', detail: `Process exited with code ${code}.`, exitCode: code };
  }
  return { outcome: 'timeout', detail: `No ${opts.logMatch ? 'match or ' : ''}exit within ${timeout}s — process still running.`, exitCode: null };
}

export async function readProcessOutput(
  execShell: ExecShell,
  sessionId: string,
  handle: string,
  opts: { sinceOffset?: number; filter?: string; maxBytes?: number } = {},
  cwd?: string,
): Promise<ReadResult> {
  const s = sess(sessionId);
  const known = s.handles.get(handle);
  const offset = opts.sinceOffset ?? known?.offset ?? 0;
  const maxBytes = Math.min(READ_CAP, Math.max(256, opts.maxBytes || READ_CAP));
  const H = dirFor(sessionId, handle);
  const filterPipe = opts.filter ? `| grep -E -- "$(printf %s ${b64(opts.filter)} | base64 -d)"` : '';
  const script = `if [ ! -d "${H}" ]; then echo "__DIGBY_NF__"; exit 0; fi
SIZE=$(wc -c < "${H}/log" 2>/dev/null || echo 0)
tail -c +${offset + 1} "${H}/log" 2>/dev/null ${filterPipe} | head -c ${maxBytes}
echo ""
if [ -f "${H}/exit" ]; then echo "__DIGBY_META__ status=exited code=$(cat "${H}/exit") size=$SIZE";
elif kill -0 -"$(cat "${H}/pgid" 2>/dev/null)" 2>/dev/null; then echo "__DIGBY_META__ status=running size=$SIZE";
else echo "__DIGBY_META__ status=exited code=unknown size=$SIZE"; fi`;
  const { stdout } = await execShell(script, cwd, 20_000).catch((e: any) => ({ stdout: e.stdout?.toString?.() || '', stderr: '' }));
  if (stdout.includes('__DIGBY_NF__')) return { chunk: '', nextOffset: offset, status: 'not_found', exitCode: null, notFound: true };
  const metaMatch = stdout.match(/__DIGBY_META__ status=(\w+)(?: code=(\S+))? size=(\d+)/);
  const status = metaMatch ? metaMatch[1] : 'unknown';
  const exitCode = metaMatch && metaMatch[2] ? metaMatch[2] : null;
  const size = metaMatch ? Number(metaMatch[3]) : offset;
  const chunk = stdout.replace(/__DIGBY_META__ .*$/s, '').replace(/\n+$/, '');
  if (known) known.offset = size;
  if (status === 'exited' || status === 'running') markStatus(sessionId, handle, status as 'running' | 'exited', exitCode);
  return { chunk, nextOffset: size, status, exitCode };
}

export async function stopProcess(
  execShell: ExecShell,
  sessionId: string,
  handle: string,
  signal: 'TERM' | 'KILL' = 'TERM',
  cwd?: string,
): Promise<{ ok: boolean; exitCode: string }> {
  const H = dirFor(sessionId, handle);
  const script = `PG=$(cat "${H}/pgid" 2>/dev/null)
if [ -n "$PG" ]; then kill -${signal} -"$PG" 2>/dev/null; fi
${signal === 'TERM' ? `sleep 1\nif [ -n "$PG" ]; then kill -KILL -"$PG" 2>/dev/null; fi` : ''}
CODE=$(cat "${H}/exit" 2>/dev/null || echo "killed")
rm -rf "${H}"
echo "exit=$CODE"`;
  const { stdout } = await execShell(script, cwd, 15_000).catch(() => ({ stdout: 'exit=error' }));
  sess(sessionId).handles.delete(handle);
  return { ok: true, exitCode: (stdout.match(/exit=(\S+)/) || [])[1] || 'killed' };
}

export interface ProcInfo { handle: string; status: string; bytes: number; command: string; }

export async function listProcesses(execShell: ExecShell, sessionId: string, cwd?: string): Promise<ProcInfo[]> {
  const BASE = `${PROC_ROOT}/${sessionId}`;
  const script = `[ -d "${BASE}" ] || { echo "__DIGBY_NONE__"; exit 0; }
for d in "${BASE}"/*/; do
  [ -d "$d" ] || continue
  h=$(basename "$d")
  size=$(wc -c < "$d/log" 2>/dev/null || echo 0)
  if [ -f "$d/exit" ]; then st="exited:$(cat "$d/exit")"; elif kill -0 -"$(cat "$d/pgid" 2>/dev/null)" 2>/dev/null; then st="running"; else st="exited:unknown"; fi
  cmd=$(head -c 160 "$d/cmd" 2>/dev/null | tr '\\n' ' ')
  echo "$h|$st|$size|$cmd"
done`;
  const { stdout } = await execShell(script, cwd, 15_000).catch(() => ({ stdout: '' }));
  if (stdout.includes('__DIGBY_NONE__')) return [];
  const procs: ProcInfo[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('|');
    if (parts.length >= 4 && parts[0].trim()) {
      procs.push({ handle: parts[0].trim(), status: parts[1], bytes: Number(parts[2]) || 0, command: parts.slice(3).join('|').trim() });
      // Re-register rediscovered RUNNING handles so cross-turn reads/waits
      // track them. Exited handles are NOT re-registered (ticket d2531cf5):
      // their state dirs persist until container teardown, so re-adding them
      // re-inflated the registry with every dead handle the session ever had
      // on EVERY list — the vector that saturated the handle cap (1730/5).
      // Exited handles still appear in the returned ProcInfo list, and
      // read/wait resolve them from on-disk ground truth without a map entry.
      const s = sess(sessionId);
      const st = parts[1].startsWith('exited') ? 'exited' as const : 'running' as const;
      if (!s.handles.has(parts[0].trim())) {
        if (st === 'running') {
          s.handles.set(parts[0].trim(), { name: parts[0].trim(), command: parts.slice(3).join('|').trim(), offset: 0, status: st });
        }
      } else {
        markStatus(sessionId, parts[0].trim(), st, parts[1].startsWith('exited:') ? parts[1].slice(7) : undefined);
      }
    }
  }
  return procs;
}
