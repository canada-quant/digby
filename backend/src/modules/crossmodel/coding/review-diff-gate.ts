/**
 * A3 — INDEPENDENT REVIEWER ONLY WHERE IT PAYS (2026-10-04, coding quick wins;
 * the owner chose option A of the coding dynamic-roster options readout).
 *
 * Why: the 2026-10-01 independent review (independent-review.ts) dispatches a
 * whole `reviewer` worker (up to 40 steps on the Reviewer seat) for every
 * eligible finish — a top-level coding run in auto mode whose request is a
 * TASK (human message or agent send), no blocked plan step, ≥ 1 work call. A
 * one-line typo fix paid the same reviewer as a 30-file feature. The reviewer
 * exists for the TB 2.1 failure class (artifacts that drift from the original
 * request), which is a property of real work, not of a two-line edit.
 *
 * Added gate (deterministic): skip the reviewer when this run's OWN diff is
 * TRIVIAL — at most TRIVIAL_DIFF_MAX_FILES files and TRIVIAL_DIFF_MAX_LINES
 * changed lines (added + deleted), at least one file changed — AND it touches
 * no RISKY path (migrations, prisma schema, auth, CI, deploy scripts, compose
 * / Dockerfiles, env files, secrets, infra). Measured, not trusted: `git diff
 * --numstat` of the worktree against the HEAD captured at this run's start
 * (committed + uncommitted tracked changes, renames as delete + add) plus the
 * untracked, non-ignored files. Receipts were the other option; they were
 * rejected because write_file / edit_file leave no receipt and run_command can
 * write anything — only git sees the real change. Uncommitted changes that
 * were already in the worktree when the run started count too: that can only
 * over-count, i.e. keep the reviewer more often, never skip it wrongly (a run
 * that REVERTS earlier dirty work is the one residual under-count).
 *
 * Always KEEP the reviewer (the gate never skips) when:
 *  - the request is ASSIGNED WORK — a supervisor relaying the OWNER's own-turn
 *    ask (the ownerDispatchHeader "dispatching work the OWNER asked for" —
 *    this is how the TB 2.1 bench reaches its lanes) or a ticket / platform
 *    task brief ([TICKET DISPATCH …], [TICKET BATCH DISPATCH …], [PLATFORM
 *    TASK …]); a plain peer / supervisor agent send is gated like a human ask;
 *  - the request came from history (a harness continuation / resume / provider-
 *    limit resume): this run's diff covers only the tail of the task;
 *  - the diff is EMPTY although the run did work calls — the work happened
 *    outside the worktree (bench task files live under /app) or was reverted,
 *    so git cannot measure it;
 *  - the measurement failed (no start HEAD, git error): unmeasured ⇒ keep.
 *
 * The skip rides the existing loop_metrics `independent_review` row: reason
 * 'trivial_diff' + meta.diffGate + meta.diff {files, lines, binary, risky}.
 * Kill switch INDEPENDENT_REVIEW_DIFF_GATE_DISABLED=1 — no start-HEAD read,
 * no measurement, the row and the reviewer exactly as before.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { git } from './workspace.service';

export function independentReviewDiffGateDisabled(): boolean {
  const v = String(process.env.INDEPENDENT_REVIEW_DIFF_GATE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** A diff is trivial at ≤ this many changed files … */
export const TRIVIAL_DIFF_MAX_FILES = 2;
/** … and ≤ this many changed lines (added + deleted, untracked files counted whole). */
export const TRIVIAL_DIFF_MAX_LINES = 40;
/** An untracked file larger than this is never counted line by line (it is not trivial). */
const UNTRACKED_READ_MAX_BYTES = 256 * 1024;

/** Paths a reviewer is always worth paying for, whatever the size of the change. */
export const RISKY_PATH_RULES: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'migrations', re: /(?:^|\/)migrations?\//i },
  { label: 'prisma_schema', re: /(?:^|\/)schema\.prisma$/i },
  { label: 'auth', re: /(?:^|\/)(?:o?auth|authenticat\w*|authoriz\w*)(?:[._-][^/]*)?(?:\/|$)/i },
  { label: 'secrets', re: /(?:^|\/)(?:secrets?|credentials?)(?:[._-][^/]*)?(?:\/|$)/i },
  { label: 'ci', re: /(?:^|\/)\.github\//i },
  { label: 'deploy', re: /(?:^|\/)deploy\w*(?:[._-][^/]*)?(?:\/|$)/i },
  { label: 'compose', re: /(?:^|\/)docker-compose[^/]*$/i },
  { label: 'dockerfile', re: /(?:^|\/)Dockerfile[^/]*$/i },
  { label: 'env', re: /(?:^|\/)[^/]*\.env(?:\.[^/]*)?$/i },
  { label: 'infra', re: /(?:^|\/)(?:infra|infrastructure|terraform|k8s|kubernetes|helm|ansible)(?:\/|$)|\.tf(?:vars)?$/i },
];

/** The first risky-path label the path matches, or null. Pure. */
export function riskyPathLabel(p: string): string | null {
  const norm = String(p ?? '').replace(/\\/g, '/');
  for (const r of RISKY_PATH_RULES) if (r.re.test(norm)) return r.label;
  return null;
}

/** One `git diff --numstat -z --no-renames` record; added/deleted null for a binary file. */
export interface NumstatRow { path: string; added: number | null; deleted: number | null }

/** Pure: parse `git diff --numstat -z --no-renames` output (`<a>\t<d>\t<path>\0` …). */
export function parseNumstatZ(stdout: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const rec of String(stdout ?? '').split('\0')) {
    if (!rec) continue;
    const m = rec.match(/^\s*(-|\d+)\t(-|\d+)\t([\s\S]+)$/);
    if (!m) continue;
    rows.push({ path: m[3], added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
  }
  return rows;
}

export interface RunDiffStat {
  /** Changed files (tracked vs the start HEAD + untracked non-ignored). */
  files: number;
  /** Changed lines (added + deleted; an untracked file counts all its lines). A
   *  binary / oversized file makes this exceed TRIVIAL_DIFF_MAX_LINES. */
  lines: number;
  /** Binary (or unreadable / oversized untracked) files among them. */
  binary: number;
  /** Risky-path labels touched (deduped, e.g. ['migrations', 'auth']). */
  risky: string[];
}

/** HEAD sha at run start — the diff gate's baseline (null on an unborn HEAD / failure). */
export async function readRunStartHead(worktree: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', 'HEAD'], worktree, 15_000)).stdout.trim() || null;
  } catch { return null; }
}

/**
 * Measure this run's diff against `startHead`. Read-only: never touches the
 * index or the worktree. null when it cannot be measured (the gate keeps the
 * reviewer). Stops reading untracked files once the change is already larger
 * than trivial.
 */
export async function measureRunDiff(worktree: string, startHead: string | null | undefined): Promise<RunDiffStat | null> {
  if (!worktree || !startHead) return null;
  try {
    const tracked = parseNumstatZ((await git(['diff', '--numstat', '-z', '--no-renames', startHead, '--'], worktree, 30_000)).stdout);
    const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'], worktree, 30_000)).stdout
      .split('\0').filter(Boolean);
    const stat: RunDiffStat = { files: tracked.length + untracked.length, lines: 0, binary: 0, risky: [] };
    const noteRisky = (p: string) => { const l = riskyPathLabel(p); if (l && !stat.risky.includes(l)) stat.risky.push(l); };
    for (const r of tracked) {
      noteRisky(r.path);
      if (r.added === null || r.deleted === null) { stat.binary += 1; stat.lines += TRIVIAL_DIFF_MAX_LINES + 1; }
      else stat.lines += r.added + r.deleted;
    }
    for (const p of untracked) noteRisky(p);
    // Line-count untracked files only while the answer can still be "trivial".
    if (stat.files <= TRIVIAL_DIFF_MAX_FILES) {
      for (const rel of untracked) {
        if (stat.lines > TRIVIAL_DIFF_MAX_LINES) break;
        try {
          const abs = path.join(worktree, rel);
          const st = await fs.stat(abs);
          if (!st.isFile() || st.size > UNTRACKED_READ_MAX_BYTES) { stat.binary += 1; stat.lines += TRIVIAL_DIFF_MAX_LINES + 1; continue; }
          const buf = await fs.readFile(abs);
          if (buf.includes(0)) { stat.binary += 1; stat.lines += TRIVIAL_DIFF_MAX_LINES + 1; continue; }
          const text = buf.toString('utf8');
          stat.lines += text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
        } catch { stat.binary += 1; stat.lines += TRIVIAL_DIFF_MAX_LINES + 1; }
      }
    } else {
      stat.lines += untracked.length; // already past the file bound — exact count is moot
    }
    return stat;
  } catch {
    return null;
  }
}

/** The owner-dispatch header phrase (platform/agent-send-header.ts ownerDispatchHeader). */
const OWNER_DISPATCH_RE = /^\s*\[AGENT-SENT MESSAGE — [^\]\n]*dispatching work the OWNER asked for/;
/** Ticket / platform-task briefs (feedback/ticket-dispatch.service.ts), after an optional agent-send header. */
const TASK_BRIEF_RE = /^\s*(?:\[AGENT-SENT MESSAGE — [^\]\n]*\]\s*)?\[(?:TICKET (?:BATCH )?DISPATCH|PLATFORM TASK)\b/;

/** Pure: the raw run message is ASSIGNED WORK — an owner dispatch or a ticket / platform-task brief. */
export function isAssignedWorkRequest(rawMessage: string | null | undefined): boolean {
  const raw = String(rawMessage ?? '');
  return OWNER_DISPATCH_RE.test(raw) || TASK_BRIEF_RE.test(raw);
}

export type ReviewDiffGate = 'trivial' | 'non_trivial' | 'risky' | 'no_diff' | 'no_diff_no_mutation' | 'unmeasured' | 'assigned' | 'continuation';

// ── audit 2026-10-06 T7-5: an empty diff with NO mutating work is not "work outside the worktree" ──
//
// Evidence (stanne.md #3, schooltime.md #6, others.md #13): 17 reviews in 50 h,
// median ≈ 20 min; zero-file reviews ran 13–39 min on a "why?" question, a
// merge-only steer ("merge PR #9": run_command ×4 reads + merge_pull_request)
// and a read-only orientation — because `files === 0 ⇒ keep` assumed the work
// happened outside the worktree, and countWorkToolCalls counts ANY run_command
// as work. Now an empty diff keeps the reviewer only when the run did
// MUTATING work: a file-writing tool, git_commit / git_push, or a run_command
// the conservative classifier below cannot prove read-only (an unknown program,
// an output redirect, sed -i, find -delete, curl -d … all count as mutating).
// A merge is not work to review (merge_pull_request is not counted).
// Kill switch INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED=1 (no_diff keeps, as before).

export function independentReviewNoDiffSkipDisabled(): boolean {
  const v = String(process.env.INDEPENDENT_REVIEW_NO_DIFF_SKIP_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Tools whose call is mutating work by itself (file writes + local git history). */
export const MUTATING_WORK_TOOLS: ReadonlySet<string> = new Set([
  'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'delete_file', 'move_file', 'ast_rewrite', 'git_commit', 'git_push',
]);

/** Programs that only read (sub-checked below where a flag can make them write). */
const READ_ONLY_PROGRAMS: ReadonlySet<string> = new Set([
  'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'wc', 'echo', 'printf', 'pwd', 'which', 'type', 'stat',
  'file', 'du', 'df', 'ps', 'uname', 'whoami', 'id', 'date', 'env', 'printenv', 'jq', 'yq', 'sort', 'uniq', 'cut', 'tr', 'diff',
  'cmp', 'comm', 'tree', 'nl', 'xxd', 'od', 'hexdump', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', 'true', 'false',
  'sleep', 'column', 'less', 'more', 'md5sum', 'sha1sum', 'sha256sum', 'free', 'uptime', 'nproc', 'lsof', 'netstat', 'ss', 'ping',
  'dig', 'nslookup', 'host', 'getent', 'locale', 'hostname', 'cd', 'journalctl', 'nvidia-smi', 'fd', 'fdfind', 'zcat', 'strings',
]);
/** Wrappers whose first non-option word is the real program. */
const CMD_WRAPPERS: ReadonlySet<string> = new Set(['time', 'timeout', 'nice', 'nohup', 'stdbuf', 'xargs', 'command', 'builtin', 'env']);
const GIT_READ_SUBS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'describe', 'blame', 'shortlog',
  'grep', 'fetch', 'reflog', 'merge-base', 'rev-list', 'name-rev', 'for-each-ref', 'count-objects', 'whatchanged', 'help', 'version',
]);
const GH_READ_VERBS: ReadonlySet<string> = new Set(['list', 'view', 'status', 'checks', 'diff', 'watch']);
const KUBECTL_READ: ReadonlySet<string> = new Set(['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'cluster-info']);
const DOCKER_READ: ReadonlySet<string> = new Set(['ps', 'logs', 'inspect', 'images', 'version', 'info', 'stats', 'top', 'port', 'history']);
const SYSTEMCTL_READ: ReadonlySet<string> = new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-timers', 'show', 'cat']);
const TAILSCALE_READ: ReadonlySet<string> = new Set(['status', 'ip', 'ping', 'netcheck', 'version', 'whois']);
const PKG_READ: ReadonlySet<string> = new Set(['ls', 'list', 'view', 'info', 'outdated', 'show', 'freeze', 'why', '--version', '-v']);

function readOnlySegment(words: string[], rawSegment: string): boolean {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1; // FOO=bar cmd
  while (i < words.length && CMD_WRAPPERS.has(words[i])) {
    i += 1;
    while (i < words.length && (words[i].startsWith('-') || /^\d+[smhd]?$/.test(words[i]))) i += 1;
  }
  if (i >= words.length) return true;
  const prog = words[i].split('/').pop() ?? '';
  const args = words.slice(i + 1);
  const has = (re: RegExp): boolean => args.some((a) => re.test(a));
  if (prog === 'find') return !has(/^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/);
  if (prog === 'sed') return !has(/^(-i\S*|--in-place\S*|-[a-zA-Z]*i[a-zA-Z]*)$/);
  if (prog === 'awk' || prog === 'gawk') return !/system\(|>\s*"|>>/.test(rawSegment);
  if (prog === 'curl') {
    if (has(/^(-d|--data\S*|-F|--form\S*|-T|--upload-file|-o|-O|--output|--remote-name\S*)$/) || has(/^-[a-zA-Z]*[dFTOo]$/)) return false;
    const xi = args.findIndex((a) => a === '-X' || a === '--request' || /^--request=/.test(a) || /^-X./.test(a));
    if (xi < 0) return true;
    const m = (args[xi].startsWith('--request=') ? args[xi].slice(10) : args[xi].startsWith('-X') && args[xi].length > 2 ? args[xi].slice(2) : args[xi + 1] ?? '').toUpperCase();
    return m === 'GET' || m === 'HEAD';
  }
  if (prog === 'wget') return has(/^--spider$/) || /-q?O\s*-(\s|$)/.test(rawSegment);
  if (prog === 'git') {
    let j = 0;
    while (j < args.length && args[j].startsWith('-')) j += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(args[j]) ? 2 : 1;
    const sub = args[j] ?? '';
    const rest = args.slice(j + 1);
    if (GIT_READ_SUBS.has(sub)) return true;
    if (sub === 'remote') return rest.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(rest[0]);
    if (sub === 'branch') return rest.every((a) => /^(-a|-r|-v|-vv|--all|--remotes|--list|--show-current|--contains|--merged|--no-merged|--format=\S*)$/.test(a));
    if (sub === 'tag') return rest.length === 0 || rest.every((a) => /^(-l|--list|-n\d*|--contains|--points-at|--sort=\S*)$/.test(a) || !a.startsWith('-') && rest.includes('-l'));
    if (sub === 'config') return rest.some((a) => /^(--get|--get-all|--list|-l|--get-regexp)$/.test(a));
    if (sub === 'worktree' || sub === 'stash') return rest[0] === 'list';
    return false;
  }
  if (prog === 'gh') {
    if (args[0] === 'api') return !has(/^(-X|--method|-f|-F|--field|--raw-field|--input)$/) || has(/^GET$/i) && !has(/^(-f|-F|--field|--raw-field|--input)$/);
    if (args[0] === 'auth') return args[1] === 'status';
    return GH_READ_VERBS.has(args[1] ?? '');
  }
  if (prog === 'kubectl') return KUBECTL_READ.has(args[0] ?? '');
  if (prog === 'docker') return DOCKER_READ.has(args[0] ?? '');
  if (prog === 'systemctl') return SYSTEMCTL_READ.has(args.find((a) => !a.startsWith('-')) ?? '');
  if (prog === 'tailscale') return TAILSCALE_READ.has(args[0] ?? '');
  if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'pip' || prog === 'pip3') return PKG_READ.has(args[0] ?? '');
  if (prog === 'python' || prog === 'python3' || prog === 'node') return args.length > 0 && args.every((a) => /^(--version|-V|-v)$/.test(a));
  return READ_ONLY_PROGRAMS.has(prog);
}

/**
 * Conservative read-only classifier for one shell command (pure): true ONLY
 * when every simple command in it is a known read and nothing redirects
 * output into a file. Anything unknown is mutating — the reviewer stays.
 */
export function isReadOnlyShellCommand(command: unknown): boolean {
  const raw = String(command ?? '');
  if (!raw.trim()) return true;
  // awk's own output redirection / system() lives INSIDE its quoted program.
  if (/\b[gm]?awk\b/.test(raw) && /system\s*\(|printf?[^;}|]*>/.test(raw)) return false;
  // Harmless redirections (to /dev/null, fd dups like 2>&1) are dropped before
  // judging — they write nothing and their `&` must not split a segment.
  const unquoted = raw.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' Q ')
    .replace(/&>>?\s*\/dev\/null\b/g, ' ')
    .replace(/\d*>>?\s*\/dev\/null\b/g, ' ')
    .replace(/\d*>&\d+/g, ' ');
  // Output redirection into a file writes something.
  if (/(^|[^<>&0-9])\d*>>?/.test(unquoted)) return false;
  if (/\btee\b/.test(unquoted)) return false;
  for (const seg of unquoted.split(/&&|\|\||;|\||&|\n|\(|\)|`/)) {
    const words = seg.trim().split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (!readOnlySegment(words, seg)) return false;
  }
  return true;
}

/** Is one dispatched tool call MUTATING work for the no-diff review gate? Pure. */
export function isMutatingWorkCall(name: unknown, rawArgs: unknown): boolean {
  const n = String(name ?? '');
  if (MUTATING_WORK_TOOLS.has(n)) return true;
  if (n !== 'run_command' && n !== 'start_background_process') return false;
  let cmd: unknown = '';
  try { cmd = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}')?.command : (rawArgs as any)?.command; } catch { return true; }
  return !isReadOnlyShellCommand(cmd);
}

/** Mutating work calls already in the transcript (a resumed run keeps its count). Pure. */
export function countMutatingWorkCalls(messages: ReadonlyArray<unknown>): number {
  let n = 0;
  for (const m of messages) {
    const msg = m as { role?: unknown; tool_calls?: unknown } | null | undefined;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls as Array<{ function?: { name?: unknown; arguments?: unknown } } | null | undefined>) {
      if (isMutatingWorkCall(tc?.function?.name, tc?.function?.arguments)) n += 1;
    }
  }
  return n;
}

/** Pure verdict. Only 'trivial' and (T7-5) 'no_diff_no_mutation' skip the reviewer. */
export function reviewDiffGateVerdict(o: { assigned: boolean; source: 'message' | 'history'; stat: RunDiffStat | null; mutatingWork?: number }): { skip: boolean; gate: ReviewDiffGate } {
  if (o.assigned) return { skip: false, gate: 'assigned' };
  if (o.source !== 'message') return { skip: false, gate: 'continuation' };
  if (!o.stat) return { skip: false, gate: 'unmeasured' };
  if (o.stat.files === 0) {
    if (typeof o.mutatingWork === 'number' && o.mutatingWork === 0 && !independentReviewNoDiffSkipDisabled()) return { skip: true, gate: 'no_diff_no_mutation' };
    return { skip: false, gate: 'no_diff' };
  }
  if (o.stat.risky.length) return { skip: false, gate: 'risky' };
  if (o.stat.files > TRIVIAL_DIFF_MAX_FILES || o.stat.lines > TRIVIAL_DIFF_MAX_LINES || o.stat.binary > 0) return { skip: false, gate: 'non_trivial' };
  return { skip: true, gate: 'trivial' };
}

/**
 * The gate at the review seam: measures only when the verdict can still be
 * 'trivial' (never for assigned work or a continuation). Never throws.
 */
export async function reviewDiffGate(o: {
  worktree: string;
  startHead: string | null | undefined;
  source: 'message' | 'history';
  rawMessage: string | null | undefined;
  /** T7-5: this run's mutating work calls (isMutatingWorkCall); omitted = the pre-T7-5 no_diff ⇒ keep. */
  mutatingWork?: number;
}): Promise<{ skip: boolean; gate: ReviewDiffGate; stat: RunDiffStat | null }> {
  try {
    const assigned = isAssignedWorkRequest(o.rawMessage);
    if (assigned || o.source !== 'message') return { ...reviewDiffGateVerdict({ assigned, source: o.source, stat: null }), stat: null };
    const stat = await measureRunDiff(o.worktree, o.startHead);
    return { ...reviewDiffGateVerdict({ assigned, source: o.source, stat, ...(typeof o.mutatingWork === 'number' ? { mutatingWork: o.mutatingWork } : {}) }), stat };
  } catch {
    return { skip: false, gate: 'unmeasured', stat: null };
  }
}
