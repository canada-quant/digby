/**
 * Session background-process attribution inside a shared dev container —
 * ticket ff262da5 / todo 4ecfd309 (2026-10-16).
 *
 * The problem this leaf solves: the shared dev container (digby-dev-<uid12>)
 * outlives every session, so a session's background processes survive its
 * runs FOREVER unless something reaps them. The e72b88f9 reaper
 * (infra-actions.service reap_orphans_session_daemons) is operator-invoked,
 * 24 h age-floored, and attributes ONLY by cwd — the 2026-10-16 census found
 * the blind spots this leaf closes:
 *
 *   - a daemon whose worktree cwd was DELETED (8 × 50-day ssh-agents) is
 *     unattributable by cwd; environ DIGBY_ENV still names the session
 *     (every execShell command exports DIGBY_ENV=<worktree>/.digby/session/
 *     env.sh — container.service.ts shellPrefix — and children inherit it).
 *     Best-effort: a process that set dumpable=0 (ssh-agent) denies environ
 *     reads even same-uid; that residual class is tiny (MBs) and documented.
 *   - TRACKED monitors (start_background_process handles, the /tmp/digby-proc/
 *     <sid>/<handle>/pgid registry) are a FEATURE that spans runs of a live
 *     session (process.service.ts header, ticket d2531cf5) — a run-end reap
 *     must SPARE them; they die when the session idles out (the idle sweep)
 *     or via stop_process.
 *
 * Pure leaf by design (the verify.service import-graph landmine: no imports
 * beyond types) — every function here is deterministic over its arguments so
 * both the fleet reaper and the verify chain can build on it. The shell
 * scripts it emits run INSIDE the container as the session uid (1001) —
 * same-uid /proc reads need no capability (the e72b88f9 E2E lesson).
 */

/** The marker every script below embeds so a script never reaps ITSELF (its
 *  own argv — and the bash -lc wrapper's argv — contains the script text). */
export const SESSION_BG_MARKER = 'DIGBY-SESSION-BG';

/** The platform-egress daemon's args SHAPE (e72b88f9 doctrine: identify by
 *  function — statedir / bound ports — NEVER by a remembered pid; it
 *  respawns). Belt-and-braces under the uid-0 exclusion. */
export const SESSION_BG_EGRESS_CASE =
  '*--statedir=/var/lib/digby-tailscale*|*--statedir=/var/lib/tailscale*|*socks5-server=localhost:1055*|*outbound-http-proxy-listen=localhost:1056*';

/** sh(1) case patterns matching a path under ONE session's worktree or
 *  sandbox-home, in BOTH workspace layouts (workspace-layout.ts: legacy
 *  <root>/worktrees/<sid>, per-user <root>/<key>/worktrees/<sid>) and both
 *  sandbox-home forms (<root>/worktrees/.sandbox-home/<sid> legacy,
 *  <root>/<key>/.sandbox-home/<sid> per-user). */
export function sessionPathCasePatterns(sessionId: string, workspaceRoot: string): string {
  const sid = String(sessionId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const root = String(workspaceRoot || '/app/coding-workspaces').replace(/\/+$/, '').replace(/'/g, '');
  if (!sid) return '';
  return [
    `"${root}"/worktrees/"${sid}"`,
    `"${root}"/worktrees/"${sid}"/*`,
    `"${root}"/*/worktrees/"${sid}"`,
    `"${root}"/*/worktrees/"${sid}"/*`,
    `"${root}"/worktrees/.sandbox-home/"${sid}"`,
    `"${root}"/worktrees/.sandbox-home/"${sid}"/*`,
    `"${root}"/*/.sandbox-home/"${sid}"`,
    `"${root}"/*/.sandbox-home/"${sid}"/*`,
  ].join('|');
}

/** sed program extracting the session id from a worktree-shaped path (the
 *  first segment after worktrees/, or after the .sandbox-home marker — the
 *  e72b88f9 N1 lesson: the bare marker itself is never a session id). */
const SESS_FROM_PATH_SED = 's#.*worktrees/\\.sandbox-home/\\([^/]*\\).*#\\1#p; s#.*worktrees/\\([^/.][^/]*\\).*#\\1#p';

/** One row per attributed process (parse of a __BG__ line). rssKb is ps RSS
 *  (KiB) — resident set, which double-counts shared pages across processes;
 *  fine for an allowance heuristic, never an exact footprint. */
export interface SessionBgRow {
  pid: string;
  uid: string;
  pgid: string;
  rssKb: number;
  etimes: number;
  tracked: boolean;
  sessionId: string;
  args: string;
}

/**
 * The SCAN script: list every session-attributed process in the container
 * with its RSS, age, tracked-ness and args. One pass over ps; per candidate
 * a readlink (cwd), a best-effort environ read (DIGBY_ENV) and a
 * /tmp/digby-proc glob (tracked pgid). Emits `__BG__ <pid> <uid> <pgid>
 * <rssKb> <etimes> <tracked 0|1> <sessionId> <args…120>` lines. Read-only —
 * no kill decision happens here (the reap scripts re-derive victims with
 * gates evaluated AT kill time).
 */
export function sessionBgScanScript(workspaceRoot: string): string {
  const root = String(workspaceRoot || '/app/coding-workspaces').replace(/'/g, '');
  return `# ${SESSION_BG_MARKER}-SCAN
ROOT='${root}'
ps -eo pid=,uid=,pgid=,rss=,etimes=,args= 2>/dev/null | while read -r pid uid pgid rss et args; do
  [ "$uid" != "0" ] || continue
  case "$et" in ''|*[!0-9]*) continue;; esac
  case "$args" in ${SESSION_BG_EGRESS_CASE}) continue;; esac
  case "$args" in *${SESSION_BG_MARKER}*) continue;; esac
  sess=''
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null)
  case "$cwd" in
    "$ROOT"/worktrees/*|"$ROOT"/*/worktrees/*)
      sess=$(printf '%s' "$cwd" | sed -n '${SESS_FROM_PATH_SED}' | head -1);;
  esac
  if [ -z "$sess" ]; then
    de=$(tr '\\0' '\\n' < /proc/$pid/environ 2>/dev/null | sed -n 's/^DIGBY_ENV=//p' | head -1)
    case "$de" in
      "$ROOT"/worktrees/*|"$ROOT"/*/worktrees/*)
        sess=$(printf '%s' "$de" | sed -n '${SESS_FROM_PATH_SED}' | head -1);;
    esac
  fi
  case "$sess" in ''|'.sandbox-home') continue;; esac
  tracked=0
  for g in /tmp/digby-proc/$sess/*/pgid; do
    [ -s "$g" ] || continue
    [ "$(cat "$g" 2>/dev/null)" = "$pgid" ] && tracked=1 && break
  done
  echo "__BG__ $pid $uid $pgid $rss $et $tracked $sess $(printf '%s' "$args" | cut -c1-120)"
done
exit 0`;
}

/** Pure parse of scan output → rows. Malformed / partial lines are skipped
 *  (the shell is best-effort; an unreadable environ reads as empty). */
export function parseSessionBgRows(stdout: string): SessionBgRow[] {
  const rows: SessionBgRow[] = [];
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('__BG__')) continue;
    const cols = line.slice(6).trim().split(/\s+/);
    if (cols.length < 7) continue;
    const [pid, uid, pgid, rss, et, tracked, sessionId] = cols;
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(uid) || !/^\d+$/.test(pgid)) continue;
    const rssKb = Number(rss);
    const etimes = Number(et);
    if (!Number.isFinite(rssKb) || rssKb < 0) continue;
    if (!sessionId || sessionId === '.sandbox-home') continue;
    rows.push({
      pid, uid, pgid,
      rssKb, etimes: Number.isFinite(etimes) ? etimes : 0,
      tracked: tracked === '1', sessionId, args: cols.slice(7).join(' '),
    });
  }
  return rows;
}

/** Aggregate rows per session: total RSS + process count (+ tracked count). */
export function sessionBgAccounting(rows: SessionBgRow[]): Map<string, { rssKb: number; count: number; tracked: number }> {
  const acc = new Map<string, { rssKb: number; count: number; tracked: number }>();
  for (const r of rows) {
    const a = acc.get(r.sessionId) ?? { rssKb: 0, count: 0, tracked: 0 };
    a.rssKb += r.rssKb;
    a.count += 1;
    if (r.tracked) a.tracked += 1;
    acc.set(r.sessionId, a);
  }
  return acc;
}

/**
 * The RUN-END reap script for ONE session (ticket ff262da5 charter item 1):
 * kill the session's UNTRACKED background processes — the orphans no handle
 * claims (the agent can neither read their output nor stop them via tools).
 * Tracked monitors are spared (cross-run feature); they die in the idle sweep
 * or via stop_process. EVERY gate is evaluated at kill time inside one shell
 * pass — there is no scan-then-kill window, and a recycled pid can never die
 * on stale scan data (the e72b88f9 kill-time-recheck doctrine, one step
 * tighter). Gates: non-root uid; age ≥ floor; attribution to THIS session by
 * cwd OR inherited DIGBY_ENV (both layouts + sandbox-home); NOT the platform
 * egress shape; NOT a live /tmp/digby-proc handle's pgid; NOT this script.
 * Emits `__REAPED__ <pid> <args…140>` lines, terminated by __BG_REAP_OK__.
 */
export function sessionRunEndReapScript(sessionId: string, workspaceRoot: string, minAgeSec: number): string {
  const sid = String(sessionId || '').replace(/[^a-zA-Z0-9-]/g, '');
  const root = String(workspaceRoot || '/app/coding-workspaces').replace(/'/g, '');
  const floor = Math.max(60, Math.floor(Number(minAgeSec) || 0));
  const own = sessionPathCasePatterns(sid, root);
  return `# ${SESSION_BG_MARKER}-RUNEND sid=${sid}
ROOT='${root}'; SID='${sid}'; FLOOR=${floor}
ps -eo pid=,uid=,pgid=,etimes=,args= 2>/dev/null | while read -r pid uid pgid et args; do
  [ "$uid" != "0" ] || continue
  case "$et" in ''|*[!0-9]*) continue;; esac
  [ "$et" -ge "$FLOOR" ] || continue
  case "$args" in *${SESSION_BG_MARKER}*) continue;; esac
  case "$args" in ${SESSION_BG_EGRESS_CASE}) continue;; esac
  cwd=$(readlink /proc/$pid/cwd 2>/dev/null)
  de=$(tr '\\0' '\\n' < /proc/$pid/environ 2>/dev/null | sed -n 's/^DIGBY_ENV=//p' | head -1)
  own=0
  for x in "$cwd" "$de"; do
    case "$x" in ${own}) own=1;; esac
  done
  [ "$own" = "1" ] || continue
  t=0
  for g in /tmp/digby-proc/$SID/*/pgid; do
    [ -s "$g" ] || continue
    [ "$(cat "$g" 2>/dev/null)" = "$pgid" ] && t=1 && break
  done
  [ "$t" = "0" ] || continue
  kill -9 "$pid" 2>/dev/null && echo "__REAPED__ $pid $(printf '%s' "$args" | cut -c1-140)"
done
echo "__BG_REAP_OK__"
exit 0`;
}

/**
 * The IDLE sweep script for sessions that are DONE (idle past the reaper's
 * cutoff, no queued/running run — decided DB-side by the caller, the e72b88f9
 * liveness doctrine): kill EVERY attributed process (tracked monitors
 * included — a dead session's monitors are garbage) and remove the session's
 * /tmp/digby-proc registry dir. Gates at kill time: non-root uid, attribution
 * to one of the victim sessions, not the platform egress shape, not this
 * script. No age floor — session idleness is the gate.
 */
export function sessionIdleReapScript(sessionIds: string[], workspaceRoot: string): string {
  const sids = [...new Set((sessionIds || []).map((s) => String(s).replace(/[^a-zA-Z0-9-]/g, '')).filter(Boolean))];
  const root = String(workspaceRoot || '/app/coding-workspaces').replace(/'/g, '');
  const list = sids.join(' ');
  const patterns = sids.map((s) => sessionPathCasePatterns(s, root)).join('|');
  const rm = sids.map((s) => `rm -rf /tmp/digby-proc/${s}`).join('; ');
  return `# ${SESSION_BG_MARKER}-IDLE
ROOT='${root}'
for p in $(ps -eo pid=,uid=,etimes=,args= 2>/dev/null | awk '$2!=0{print $1}'); do
  args=$(ps -o args= -p $p 2>/dev/null) || continue
  case "$args" in *${SESSION_BG_MARKER}*) continue;; esac
  case "$args" in ${SESSION_BG_EGRESS_CASE}) continue;; esac
  cwd=$(readlink /proc/$p/cwd 2>/dev/null)
  de=$(tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | sed -n 's/^DIGBY_ENV=//p' | head -1)
  own=0
  for x in "$cwd" "$de"; do
    case "$x" in ${patterns}) own=1;; esac
  done
  [ "$own" = "1" ] || continue
  kill -9 "$p" 2>/dev/null && echo "__REAPED__ $p $(printf '%s' "$args" | cut -c1-140)"
done
${list ? rm + '; true' : 'true'}
echo "__BG_REAP_OK__"
exit 0`;
}

/** Count __REAPED__ lines in a reap script's output (0 on any garbage). */
export function countReaped(stdout: string): number {
  return String(stdout || '').split('\n').filter((l) => l.trim().startsWith('__REAPED__')).length;
}

/** The run-end reap age floor: default 300 s (a daemon younger than this is
 *  probably still being set up by the dying run's final commands — it dies at
 *  the NEXT run end or the idle sweep). Env-tunable, hard minimum 60 s
 *  (a too-low tuning would race the dying run's own final commands). */
export function sessionBgReapMinAgeSec(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.SESSION_BG_REAP_MIN_AGE_SEC);
  if (!Number.isFinite(v)) return 300;
  return Math.max(60, Math.floor(v));
}

/** The workspace root every session-bg script keys on (the same default as
 *  infra-actions sessionDaemonWorkspaceRoot — duplicated deliberately so this
 *  leaf stays import-free for verify.service). */
export function sessionBgWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.CODING_WORKSPACE_ROOT || '/app/coding-workspaces').replace(/\/+$/, '');
}

/** Ops kill switch (doctrine — every automated reaper carries one):
 *  SESSION_BG_REAP_DISABLED=1 refuses the run-end reap AND the idle sweep
 *  (the e72b88f9 operator kind and env_probe surfacing keep working). */
export function sessionBgReapDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SESSION_BG_REAP_DISABLED === '1';
}
