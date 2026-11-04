/**
 * RUN_COMMAND WORKSPACE-SCOPE GUARD (audit 2026-10-06 T7-7 — security).
 *
 * Evidence (stanne.md #1, P0): the owner's shared dev container
 * (`digby-dev-<uid12>`, dev-container.service) mounts the WHOLE coding
 * workspace volume — every session's worktree (other USERS' included) and
 * every project's bare repo mirror. An autonomous independent-reviewer worker
 * in one of the owner's sessions ran `ls /app/coding-workspaces/worktrees/`
 * (144 session dirs), enumerated every bare repo with its remote, and looped
 * `git log; git status` over `/app/coding-workspaces/worktrees/*`, reading
 * another user's worktree. The file tools were already worktree-scoped; the
 * shell was not. The per-user volume layout that would remove the exposure is
 * NOT built (ticket 4ed6eb2e closed as a tailnet-egress item).
 *
 * Mitigation: when a session's commands run where the whole volume is visible
 * (container.service workspaceExecExposure — the shared dev container, a
 * whole-volume fallback container, or the in-process fallback), run_command /
 * start_background_process REFUSE a command whose text references a workspace
 * path other than this session's OWN worktree, its project's mirror and its
 * sandbox home — before anything executes. Deterministic text analysis, within
 * reason (a shell is Turing-complete; this is a guard rail, not a sandbox):
 *   - absolute references under the root (incl. `//`, `/./`, `/proc/self/root`
 *     prefixes, `--opt=` / `VAR=` / `a:b` / redirect positions);
 *   - `..` escapes and plain relative paths resolved against a SIMULATED cwd
 *     that follows `cd` / `pushd` (a `cd` to an unknowable target makes later
 *     relative tokens unjudgeable — they pass);
 *   - `$PWD` / `${PWD}` / `$(pwd)` / backtick pwd / `$(git rev-parse
 *     --show-toplevel)` read as the simulated cwd;
 *   - globs (`* ? [ {`) whose literal prefix is not inside an allowed path but
 *     whose pattern can reach the root (`/app/coding-work*`, `/app/*\/worktrees`);
 *   - recursive traversal of an ANCESTOR of the root (`find /`, `grep -r … /app`,
 *     `du /app`, `ls -R /`, `rg … /`, `tar … /app` …) — the walk would enter
 *     every tenant's worktree;
 *   - `dirname <own root>` (the classic `cd "$(dirname "$PWD")"` climb).
 * The session's own work is never touched: its worktree, mirror and sandbox
 * home (and anything below them, globs included) always pass.
 *
 * Pure leaf (path only). Kill switch RUN_COMMAND_WORKSPACE_GUARD_DISABLED=1
 * (read per call) — no analysis, every command executes exactly as before.
 */

import * as path from 'path';

export function runCommandWorkspaceGuardDisabled(): boolean {
  const v = String(process.env.RUN_COMMAND_WORKSPACE_GUARD_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface WorkspaceGuardScope {
  /** The workspace volume root (e.g. /app/coding-workspaces). */
  root: string;
  /** This session's worktree (the shell's starting cwd). */
  worktree: string;
  /** Paths this session may reference (worktree, project mirror, sandbox home); the worktree is always included. */
  allowed: string[];
  /** The project's bare mirror (also in `allowed`), when the session has one — `$(git rev-parse --git-common-dir)` reads as it. */
  mirror?: string | null;
}

export type WorkspaceGuardReason = 'foreign_path' | 'workspace_root' | 'glob' | 'ancestor_traversal' | 'dirname_escape';

export interface WorkspaceGuardVerdict {
  refused: boolean;
  reason?: WorkspaceGuardReason;
  /** The offending path references (normalized, ≤ 5). */
  refs: string[];
}

const CWD_TOKEN = '\u0001CWD\u0001';
/** Flags whose NEXT word is an exclusion pattern (find / grep / rg / tar / du / rsync). */
const EXCLUDE_FLAG_RE = /^(?:-path|-ipath|-wholename|-iwholename|--exclude|--exclude-dir|-g|--glob|--iglob)$/;
const GLOB_CHARS_RE = /[*?[{]/;
/** Programs that walk a directory tree (their argument being an ANCESTOR of the root walks every tenant). */
const ALWAYS_RECURSIVE = new Set(['find', 'du', 'tree', 'rg', 'ag', 'ack', 'fd', 'fdfind', 'rsync', 'tar', 'zip', 'bsdtar', 'ncdu', 'locate', 'updatedb']);
/** Programs that walk only with a recursive flag. */
const FLAG_RECURSIVE = new Set(['grep', 'egrep', 'fgrep', 'ls', 'cp', 'chmod', 'chown', 'chgrp', 'rm', 'scp']);
/** Wrappers whose first non-option argument is the real program. */
const WRAPPERS = new Set(['sudo', 'env', 'nice', 'nohup', 'time', 'timeout', 'xargs', 'stdbuf', 'ionice', 'command', 'exec', 'builtin', 'bash', 'sh']);

function norm(p: string): string {
  let n = path.posix.normalize(p.replace(/\/{2,}/g, '/'));
  if (n.length > 1 && n.endsWith('/')) n = n.slice(0, -1);
  return n;
}

function within(p: string, base: string): boolean {
  return p === base || p.startsWith(base === '/' ? '/' : `${base}/`);
}

/** One glob path segment → an anchored regex (pure). */
function segRegex(seg: string): RegExp {
  let out = '';
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '[') {
      const close = seg.indexOf(']', i + 1);
      if (close === -1) { out += '\\['; continue; }
      let cls = seg.slice(i + 1, close);
      if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
      out += `[${cls.replace(/\\/g, '\\\\')}]`;
      i = close;
    } else if (c === '{') {
      const close = seg.indexOf('}', i + 1);
      if (close === -1) { out += '\\{'; continue; }
      out += `(?:${seg.slice(i + 1, close).split(',').map((a) => a.replace(/[.+^$()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')).join('|')})`;
      i = close;
    } else out += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  try { return new RegExp(`^${out}$`); } catch { return /^.*$/; }
}

/**
 * Can this absolute glob pattern match the root, a path below it, or an
 * ancestor of it? 'below' = at/under the root; 'ancestor' = shallower than
 * the root along its path; null = it cannot reach the root at all. Pure.
 */
export function globReach(pattern: string, root: string): 'below' | 'ancestor' | null {
  const p = pattern.split('/').filter(Boolean);
  const r = root.split('/').filter(Boolean);
  for (let i = 0; i < r.length; i += 1) {
    if (i >= p.length) return 'ancestor';
    if (p[i] === '**') return 'below';
    if (!segRegex(p[i]).test(r[i])) return null;
  }
  return 'below';
}

/** Split a command into simple-command segments (control operators, pipes, subshell parens). */
function segments(command: string): string[] {
  return command.split(/&&|\|\||;|\||\n|&|\(|\)/).map((s) => s.trim()).filter(Boolean);
}

/** Words of one segment: quotes stripped, split on whitespace and redirect operators. */
function words(segment: string): string[] {
  return segment.replace(/['"`]/g, ' ').split(/[\s<>]+/).filter(Boolean);
}

/** Path-ish candidates inside one word (VAR=… / --opt=… / a:b lists). */
function pieces(word: string): string[] {
  return word.split(/[=:]/).filter(Boolean);
}

/** The real program of a segment (skips env assignments and wrapper commands). */
function programOf(ws: string[]): { prog: string; argStart: number } {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    const base = path.posix.basename(w);
    if (WRAPPERS.has(base) && i + 1 < ws.length) {
      i += 1;
      while (i < ws.length && ws[i].startsWith('-')) i += 1;
      // `timeout 30 cmd` / `nice -n 5 cmd`: skip a bare numeric arg too.
      while (i < ws.length && /^\d+[smhd]?$/.test(ws[i])) i += 1;
      continue;
    }
    return { prog: base, argStart: i + 1 };
  }
  return { prog: '', argStart: ws.length };
}

function isRecursive(prog: string, args: string[]): boolean {
  if (ALWAYS_RECURSIVE.has(prog)) return true;
  if (!FLAG_RECURSIVE.has(prog)) return false;
  return args.some((a) => /^--recursive$|^-d\s*recurse$|^--directories=recurse$/.test(a) || /^-[A-Za-z]*[rR]/.test(a) || (prog === 'cp' && /^-[A-Za-z]*a/.test(a)));
}

/**
 * Programs that run their (quoted) arguments on ANOTHER machine — the text inside their quotes is a REMOTE
 * command, never a local path (2026-10-06 live false positive: the Framework Operator lane's
 * `bash scripts/framework-audit/run-on-box.sh A 'sudo find / …'` was refused as a local `find /`).
 * Kill switch WORKSPACE_GUARD_REMOTE_EXEC_EXEMPT_DISABLED=1.
 */
const REMOTE_EXEC = new Set(['ssh', 'mosh', 'tssh', 'sshpass', 'run-on-box.sh', 'sshx.py', 'aws', 'gcloud', 'kubectl', 'az']);
const SCRIPT_RUNNERS = new Set(['python', 'python3', 'node', 'perl', 'ruby']);
export function remoteExecExemptDisabled(): boolean {
  const v = String(process.env.WORKSPACE_GUARD_REMOTE_EXEC_EXEMPT_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * Blank (with spaces) the QUOTED text of every simple command whose program is a remote executor, so the
 * segment / word analysis below never reads a remote command as local. Quote-aware split on unquoted
 * `;` `&&` `||` `|` `&` and newlines; the unquoted words of a simple command decide its program (wrappers and
 * `python3 <script>` runners skipped). Pure; never throws (returns the input on any surprise).
 */
export function blankRemoteExecArgs(command: string): string {
  try {
    const s = String(command ?? '');
    const out = s.split('');
    // Pass 1: simple-command ranges + quoted spans, quote-aware.
    const ranges: Array<{ start: number; end: number; quoted: Array<[number, number]> }> = [];
    let start = 0; let quote: string | null = null; let qStart = -1; let quoted: Array<[number, number]> = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\' && quote === '"') { i += 1; continue; }
        if (c === quote) { quoted.push([qStart + 1, i]); quote = null; }
        continue;
      }
      if (c === '\\') { i += 1; continue; }
      if (c === "'" || c === '"') { quote = c; qStart = i; continue; }
      const two = s.slice(i, i + 2);
      if (two === '&&' || two === '||') { ranges.push({ start, end: i, quoted }); quoted = []; start = i + 2; i += 1; continue; }
      if (c === ';' || c === '|' || c === '&' || c === '\n') { ranges.push({ start, end: i, quoted }); quoted = []; start = i + 1; }
    }
    if (quote) quoted.push([qStart + 1, s.length]);
    ranges.push({ start, end: s.length, quoted });
    // Pass 2: the program of each simple command from its UNQUOTED words.
    for (const r of ranges) {
      if (!r.quoted.length) continue;
      let unq = '';
      let k = r.start;
      for (const [a, b] of r.quoted) { unq += s.slice(k, a) + ' Q '; k = b; }
      unq += s.slice(k, r.end);
      const ws = unq.replace(/['"`]/g, ' ').split(/[\s<>]+/).filter(Boolean);
      const { prog, argStart } = programOf(ws);
      const runnerScript = SCRIPT_RUNNERS.has(prog) ? path.posix.basename(ws.slice(argStart).find((w) => !w.startsWith('-')) ?? '') : '';
      if (!REMOTE_EXEC.has(prog) && !REMOTE_EXEC.has(runnerScript)) continue;
      for (const [a, b] of r.quoted) for (let i = a; i < b; i++) out[i] = ' ';
    }
    return out.join('');
  } catch {
    return String(command ?? '');
  }
}

/**
 * Analyse one shell command. Pure — the caller decides what a refusal does.
 * Never throws (an analysis error passes the command: the guard can only
 * remove access, never break a session).
 *
 * audit 2026-10-08 W2-8: the DATA-AWARE reading (checkCommandWorkspaceScopeDataAware
 * below) is the default; WORKSPACE_GUARD_DATA_AWARE_DISABLED=1 restores the
 * pre-2026-10-08 literal reading (checkCommandWorkspaceScopeLegacy) byte-for-byte.
 */
export function checkCommandWorkspaceScope(command: string, scope: WorkspaceGuardScope): WorkspaceGuardVerdict {
  if (workspaceGuardDataAwareDisabled()) return checkCommandWorkspaceScopeLegacy(command, scope);
  return checkCommandWorkspaceScopeDataAware(command, scope);
}

/** The pre-2026-10-08 literal reading (heredoc bodies and quoted data read as shell). Kept byte-for-byte for the kill switch. */
export function checkCommandWorkspaceScopeLegacy(command: string, scope: WorkspaceGuardScope): WorkspaceGuardVerdict {
  try {
    const root = norm(scope.root);
    const worktree = norm(scope.worktree);
    const allowed = Array.from(new Set([worktree, ...scope.allowed.filter(Boolean).map(norm)]));
    const inAllowed = (p: string): boolean => allowed.some((a) => within(p, a));
    const refs: string[] = [];
    let reason: WorkspaceGuardReason | undefined;
    const flag = (r: WorkspaceGuardReason, ref: string): void => {
      if (!reason) reason = r;
      if (refs.length < 5 && !refs.includes(ref)) refs.push(ref);
    };

    // $PWD-family substitutions read as the simulated cwd of their segment;
    // git's own path queries read as the paths they print (the mirror for
    // --git-common-dir, a worktree-admin dir under it for --git-dir).
    const mirror = scope.mirror ? norm(scope.mirror) : null;
    let text = (remoteExecExemptDisabled() ? String(command ?? '') : blankRemoteExecArgs(String(command ?? '')))
      .replace(/\$\(\s*pwd(?:\s+-[LP])?\s*\)|`\s*pwd(?:\s+-[LP])?\s*`|\$\{PWD\}|\$PWD\b|\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)/g, CWD_TOKEN);
    if (mirror) {
      text = text
        .replace(/\$\(\s*git\s+rev-parse\s+--git-common-dir\s*\)/g, mirror)
        .replace(/\$\(\s*git\s+rev-parse\s+--(?:absolute-)?git-dir\s*\)/g, `${mirror}/worktrees/_`);
    }

    // `dirname <own root>` — judged against the command's STARTING cwd (a
    // `cd "$(dirname "$PWD")"` substitution runs before its cd).
    {
      const re = /\bdirname\s+(?:--\s+)?['"]?([^\s'";|&)`]+)/g;
      let m: RegExpExecArray | null;
      const t0 = text.split(CWD_TOKEN).join(worktree);
      while ((m = re.exec(t0))) {
        const arg = m[1];
        if (arg.startsWith('$') || arg.startsWith('~') || GLOB_CHARS_RE.test(arg)) continue;
        const abs = arg.startsWith('/') ? norm(arg) : norm(path.posix.join(worktree, arg));
        if (allowed.includes(abs) || (within(abs, root) && !inAllowed(abs))) flag('dirname_escape', abs);
      }
    }

    let cwd: string | null = worktree;
    for (const seg of segments(text)) {
      const ws = words(seg.split(CWD_TOKEN).join(cwd ?? CWD_TOKEN));
      if (!ws.length) continue;
      const { prog, argStart } = programOf(ws);
      const args = ws.slice(argStart);
      const recursive = isRecursive(prog, args);
      // An EXCLUSION of the workspace root (find -path <root> -prune, grep
      // --exclude-dir=coding-workspaces, rg -g '!coding-workspaces', tar/du
      // --exclude=…) is not a reference to it, and it makes a recursive walk
      // of an ancestor (find /app …) stay out of every tenant's worktree.
      const rootBase = path.posix.basename(root);
      const excludedIdx = new Set<number>();
      // Exactly the root (by name or path, optionally as a */** glob) — a value
      // that merely CONTAINS the name (coding-workspaces-x) excludes nothing.
      const excludesExactly = (value: string): boolean => {
        const v = value.replace(/^!/, '').replace(/\/\*\*?$/, '').replace(/\/+$/, '');
        return v === rootBase || v === root || v === `*/${rootBase}` || v === `**/${rootBase}`;
      };
      ws.forEach((w, i) => {
        if (EXCLUDE_FLAG_RE.test(ws[i - 1] ?? '') && excludesExactly(w)) excludedIdx.add(i);
        else if (/^--exclude(?:-dir)?=/.test(w) && excludesExactly(w.replace(/^--exclude(?:-dir)?=/, ''))) excludedIdx.add(i);
      });
      const excludesRoot = excludedIdx.size > 0;

      const resolve = (piece: string): string | null => {
        if (piece.includes(CWD_TOKEN)) return null; // relative to an unknowable cwd
        if (piece.startsWith('-') && !piece.includes('/')) return null; // a flag
        if (piece.startsWith('/')) {
          const n = norm(piece);
          // /proc/self/root/<root>…, file:// remnants, etc.: judge from the root onward.
          const at = n.indexOf(root);
          return at > 0 ? n.slice(at) : n;
        }
        if (piece.startsWith('~') || piece.startsWith('$')) return null;
        if (cwd === null) return null;
        // Inside an allowed path a plain relative token (no `..`) cannot leave it.
        if (inAllowed(cwd) && !/(^|\/)\.\.(\/|$)/.test(piece)) return null;
        return norm(path.posix.join(cwd, piece));
      };

      const judge = (abs: string): void => {
        if (GLOB_CHARS_RE.test(abs)) {
          // The literal prefix inside an allowed path ⇒ the glob only matches there.
          const literal = abs.slice(0, abs.search(GLOB_CHARS_RE)).replace(/\/+$/, '');
          if (literal && inAllowed(literal)) return;
          const reach = globReach(abs, root);
          if (reach === 'below') flag('glob', abs);
          else if (reach === 'ancestor' && recursive && !excludesRoot) flag('ancestor_traversal', abs);
          return;
        }
        if (within(abs, root)) {
          if (inAllowed(abs)) return;
          const parts = abs.slice(root.length).split('/').filter(Boolean);
          const container = parts.length === 0
            || (parts.length === 1 && (parts[0] === 'worktrees' || parts[0] === 'repos'))
            || (parts.length === 2 && parts[0] === 'worktrees' && parts[1] === '.sandbox-home');
          flag(container ? 'workspace_root' : 'foreign_path', abs);
          return;
        }
        if (recursive && !excludesRoot && within(root, abs)) flag('ancestor_traversal', abs);
      };

      ws.forEach((w, i) => {
        if (excludedIdx.has(i)) return;
        for (const piece of pieces(w)) {
          const abs = resolve(piece);
          if (abs) judge(abs);
        }
      });

      if (prog === 'cd' || prog === 'pushd') {
        const target = args.find((a) => !a.startsWith('-'));
        if (!target) cwd = null; // $HOME — not modelled
        else {
          const abs: string | null = target.startsWith('/') ? norm(target)
            : (target.startsWith('~') || target.startsWith('$') || target.includes(CWD_TOKEN) || cwd === null) ? null
              : norm(path.posix.join(cwd, target));
          cwd = abs && !GLOB_CHARS_RE.test(abs) ? abs : null;
        }
      } else if (prog === 'popd') cwd = null;
    }
    return reason ? { refused: true, reason, refs } : { refused: false, refs: [] };
  } catch {
    return { refused: false, refs: [] };
  }
}

// ── DATA-AWARE reading (audit 2026-10-08 W2-8) ────────────────────────────────
// Prod 2026-10-07/08: 27 refusals in 24 h across 13 sessions, the nightly
// adjudicator judged 12 false positive / 0 true positive. The literal reading
// split the WHOLE command on newlines and stripped quotes, so:
//   - heredoc BODIES were judged as shell — `cat > /tmp/x.test.ts <<'EOF'` with
//     `/** … */` (a glob `/**`) or `jest.mock('../../utils/logger')` (a `..`
//     climb), and `python3 - <<'PY'` code run from the lane's OWN worktree;
//   - multi-word QUOTED data was judged as shell — a remote command handed to a
//     custom runner (`python3 scratch/labcmd.py host -- '…; find / …'`,
//     `python3 scripts/box_exec.py "docker exec … grep -rn \"../\" …"`);
//   - quotes became word breaks — `cd "$(git rev-parse --show-toplevel)"/backend`
//     read as `cd <wt>` + `/backend`, so a later `cd ../frontend` left the
//     worktree;
//   - `find / -maxdepth 3 -name .git` was an "ancestor traversal" although a
//     depth-3 walk of `/` cannot even list a session directory name;
//   - `ln -sfn ../../../backend/node_modules backend/node_modules` resolved the
//     symlink TARGET against the cwd instead of the link's directory.
// The data-aware reading keeps every true-positive shape: a heredoc / quoted
// string handed to a LOCAL shell (bash/sh … -c, `bash <<EOF`, eval, a "$(…)"
// command substitution) is still read as shell; interpreter CODE (python -c,
// `python3 - <<PY`, node -e …) is judged for absolute workspace paths and
// path-shaped string literals ('..', '../x') against the simulated cwd; any
// other DATA (cat / tee bodies, commit messages, a runner script's arguments)
// is judged for absolute references under the workspace root only.
// Kill switch WORKSPACE_GUARD_DATA_AWARE_DISABLED=1 (read per call) restores
// the literal reading byte-for-byte.

export function workspaceGuardDataAwareDisabled(): boolean {
  const v = String(process.env.WORKSPACE_GUARD_DATA_AWARE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Local shells: a quoted string after `-c` / a heredoc fed to them IS shell. */
const LOCAL_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);
/** WRAPPERS minus the shells (the raw-program scan must SEE bash/sh). */
const NON_SHELL_WRAPPERS = new Set([...WRAPPERS].filter((w) => !LOCAL_SHELLS.has(w)));
/** Code interpreters: a heredoc fed to them / their -c / -e string is CODE. */
const INTERPRETER_RE = /^(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|deno|bun|perl|ruby|php|lua|luajit|Rscript|tsx|ts-node|osascript|irb)$/;
/** Placeholder for an extracted heredoc body (H) / multi-word quoted string (Q). No whitespace, no shell metachar. */
const PH_RE = /\u0002([HQ])(\d+)\u0002/g;
const UNKNOWN_CWD = '\u0003';

interface Heredoc { delim: string; stripTabs: boolean; quoted: boolean; body: string }
interface QuotedSpan { text: string; hasSubst: boolean }

/**
 * Lift every heredoc BODY out of the command (quote-aware; `<<`, `<<-`, `<<~`,
 * quoted or bare delimiter; a numeric "delimiter" is an arithmetic shift, not
 * a heredoc). The operator is replaced by a placeholder token on its own line,
 * so the segment that feeds the heredoc carries it; the body lines and the
 * terminator line are removed. Pure.
 */
export function extractHeredocs(s: string): { text: string; docs: Heredoc[] } {
  const docs: Heredoc[] = [];
  const pending: number[] = [];
  let out = '';
  let quote: string | null = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      out += c;
      if (c === '\\' && quote === '"' && i + 1 < s.length) { out += s[i + 1]; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '\\' && i + 1 < s.length && s[i + 1] !== '\n') { out += c + s[i + 1]; i += 2; continue; }
    if (c === "'" || c === '"') { quote = c; out += c; i += 1; continue; }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] === '<') { out += '<<<'; i += 3; continue; } // a here-string, not a heredoc
    if (c === '<' && s[i + 1] === '<') {
      const m = /^<<([-~]?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|([^\s;&|<>()'"]+))/.exec(s.slice(i));
      const delim = m ? (m[2] ?? m[3] ?? m[4] ?? '') : '';
      if (m && delim && !/^\d+$/.test(delim)) {
        const idx = docs.length;
        docs.push({ delim, stripTabs: m[1] !== '', quoted: m[2] !== undefined || m[3] !== undefined, body: '' });
        pending.push(idx);
        out += ` \u0002H${idx}\u0002 `;
        i += m[0].length;
        continue;
      }
    }
    if (c === '\n' && pending.length) {
      out += '\n';
      let j = i + 1;
      for (const idx of pending) {
        const d = docs[idx];
        const lines: string[] = [];
        while (j < s.length) {
          const nl = s.indexOf('\n', j);
          const line = nl === -1 ? s.slice(j) : s.slice(j, nl);
          j = nl === -1 ? s.length : nl + 1;
          const cmp = (d.stripTabs ? line.replace(/^\t+/, '') : line).replace(/\r$/, '');
          if (cmp === d.delim) break;
          lines.push(line);
        }
        d.body = lines.join('\n');
      }
      pending.length = 0;
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return { text: out, docs };
}

/**
 * Lift every quoted string that contains whitespace (a multi-word string is
 * DATA for its program — or a script for a shell / interpreter, decided at its
 * segment) into a placeholder. Single-word quoted strings stay in place (their
 * quotes are dropped by wordsDataAware: shell concatenation). Pure.
 */
function extractQuotedSpans(s: string): { text: string; spans: QuotedSpan[] } {
  const spans: QuotedSpan[] = [];
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { out += c + s[i + 1]; i += 2; continue; }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== c) j += c === '"' && s[j] === '\\' ? 2 : 1;
      const content = s.slice(i + 1, Math.min(j, s.length));
      if (/\s/.test(content)) {
        out += `\u0002Q${spans.length}\u0002`;
        spans.push({ text: content, hasSubst: c === '"' && /\$\(|`/.test(content) });
      } else {
        out += s.slice(i, Math.min(j + 1, s.length));
      }
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return { text: out, spans };
}

/** Words of one segment, quotes REMOVED (shell concatenation: `"$X"/backend` is one word). */
function wordsDataAware(segment: string): string[] {
  return segment.replace(/['"`]/g, '').split(/[\s<>]+/).filter(Boolean);
}

/** The RAW program of a segment: like programOf, but bash/sh/… are the program, not wrappers. */
function rawProgramOf(ws: string[]): { prog: string; flags: string[] } {
  let i = 0;
  while (i < ws.length) {
    const w = ws[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    const base = path.posix.basename(w);
    if (NON_SHELL_WRAPPERS.has(base) && i + 1 < ws.length) {
      i += 1;
      while (i < ws.length && ws[i].startsWith('-')) i += 1;
      while (i < ws.length && /^\d+[smhd]?$/.test(ws[i])) i += 1;
      continue;
    }
    const flags: string[] = [];
    let k = i + 1;
    while (k < ws.length && ws[k].startsWith('-')) flags.push(ws[k++]);
    return { prog: base, flags };
  }
  return { prog: '', flags: [] };
}

/** An interpreter code flag (python -c, node -e/-p, perl -ne/-E, ruby -e, php -r) before the first non-flag argument. */
function hasCodeFlag(ws: string[], argStart: number): boolean {
  for (let k = argStart; k < ws.length && ws[k].startsWith('-'); k += 1) {
    if (/^-[A-Za-z]*[ceEpr]$/.test(ws[k]) || /^--(?:eval|print)$/.test(ws[k])) return true;
  }
  return false;
}

function pathDepth(p: string): number {
  return p.split('/').filter(Boolean).length;
}

/** The data-aware reading. Never throws. */
export function checkCommandWorkspaceScopeDataAware(command: string, scope: WorkspaceGuardScope): WorkspaceGuardVerdict {
  try {
    const root = norm(scope.root);
    const worktree = norm(scope.worktree);
    const allowed = Array.from(new Set([worktree, ...scope.allowed.filter(Boolean).map(norm)]));
    const inAllowed = (p: string): boolean => allowed.some((a) => within(p, a));
    const refs: string[] = [];
    let reason: WorkspaceGuardReason | undefined;
    const flag = (r: WorkspaceGuardReason, ref: string): void => {
      if (!reason) reason = r;
      if (refs.length < 5 && !refs.includes(ref)) refs.push(ref);
    };
    const mirror = scope.mirror ? norm(scope.mirror) : null;
    const remoteExemptOff = remoteExecExemptDisabled();

    const subst = (t: string): string => {
      let out = t.replace(/\$\(\s*pwd(?:\s+-[LP])?\s*\)|`\s*pwd(?:\s+-[LP])?\s*`|\$\{PWD\}|\$PWD\b|\$\(\s*git\s+rev-parse\s+--show-toplevel\s*\)/g, CWD_TOKEN);
      if (mirror) {
        out = out
          .replace(/\$\(\s*git\s+rev-parse\s+--git-common-dir\s*\)/g, mirror)
          .replace(/\$\(\s*git\s+rev-parse\s+--(?:absolute-)?git-dir\s*\)/g, `${mirror}/worktrees/_`);
      }
      return out;
    };

    // An absolute path at/under the root that this session may not touch.
    const flagUnderRoot = (abs: string): void => {
      const parts = abs.slice(root.length).split('/').filter(Boolean);
      const container = parts.length === 0
        || (parts.length === 1 && (parts[0] === 'worktrees' || parts[0] === 'repos'))
        || (parts.length === 2 && parts[0] === 'worktrees' && parts[1] === '.sandbox-home');
      flag(container ? 'workspace_root' : 'foreign_path', abs);
    };

    // DATA mode: only explicit workspace references (absolute paths / globs whose literal prefix is under the root).
    const judgeDataAbs = (abs: string): void => {
      let n = norm(abs);
      const at = n.indexOf(root);
      if (at > 0) n = n.slice(at);
      if (GLOB_CHARS_RE.test(n)) {
        const literal = n.slice(0, n.search(GLOB_CHARS_RE)).replace(/\/+$/, '');
        if (literal && within(literal, root) && !inAllowed(literal)) flag('glob', n);
        return;
      }
      if (within(n, root) && !inAllowed(n)) flagUnderRoot(n);
    };
    const judgeData = (rawText: string, cwd: string | null, code: boolean): void => {
      const t = subst(rawText).split(CWD_TOKEN).join(cwd ?? UNKNOWN_CWD);
      const absRe = /(^|[\s'"`=([{,:;|&<>])(\/[^\s'"`;|&<>(){}[\],]*)/g;
      let m: RegExpExecArray | null;
      while ((m = absRe.exec(t))) {
        let tok = m[2];
        if (tok.includes(UNKNOWN_CWD)) continue;
        if (tok.startsWith('///')) tok = tok.replace(/^\/+/, '/'); // file:///abs
        else if (tok.startsWith('//')) continue; // a URL authority (http://host/…), never a local path
        tok = tok.replace(/[.,:;!?]+$/, '');
        if (tok) judgeDataAbs(tok);
      }
      if (!code || cwd === null) return;
      // CODE mode: a string literal that IS a relative path climbing with `..`.
      const litRe = /(['"])([^'"\s]*)\1/g;
      while ((m = litRe.exec(t))) {
        const v = m[2];
        if (!v || v.startsWith('/') || v.startsWith('~') || v.startsWith('$') || v.includes('://') || v.includes(UNKNOWN_CWD)) continue;
        if (!/(^|\/)\.\.(\/|$)/.test(v)) continue;
        judgeDataAbs(norm(path.posix.join(cwd, v)));
      }
    };

    const analyze = (input: string, startCwd: string | null, depth: number): void => {
      if (depth > 4) return;
      const { text: noDocs, docs } = extractHeredocs(input);
      const s = subst(remoteExemptOff ? noDocs : blankRemoteExecArgs(noDocs));

      // `dirname <own root>` — judged against the command's STARTING cwd (as the literal reading).
      {
        const re = /\bdirname\s+(?:--\s+)?['"]?([^\s'";|&)`]+)/g;
        let m: RegExpExecArray | null;
        const t0 = s.split(CWD_TOKEN).join(worktree);
        while ((m = re.exec(t0))) {
          const arg = m[1].replace(PH_RE, '');
          if (!arg || arg.startsWith('$') || arg.startsWith('~') || GLOB_CHARS_RE.test(arg)) continue;
          const abs = arg.startsWith('/') ? norm(arg) : norm(path.posix.join(worktree, arg));
          if (allowed.includes(abs) || (within(abs, root) && !inAllowed(abs))) flag('dirname_escape', abs);
        }
      }

      const { text: shellText, spans } = extractQuotedSpans(s);
      let cwd: string | null = startCwd;
      for (const seg of segments(shellText)) {
        const joined = seg.split(CWD_TOKEN).join(cwd ?? CWD_TOKEN);
        const embedded: Array<{ kind: string; idx: number }> = [];
        joined.replace(PH_RE, (_all, k: string, n: string) => { embedded.push({ kind: k, idx: Number(n) }); return ''; });
        const ws = wordsDataAware(joined.replace(PH_RE, ''));
        if (!ws.length && !embedded.length) continue;
        const { prog, argStart } = programOf(ws);
        const args = ws.slice(argStart);
        const recursive = isRecursive(prog, args);
        const rootBase = path.posix.basename(root);
        const excludedIdx = new Set<number>();
        const excludesExactly = (value: string): boolean => {
          const v = value.replace(/^!/, '').replace(/\/\*\*?$/, '').replace(/\/+$/, '');
          return v === rootBase || v === root || v === `*/${rootBase}` || v === `**/${rootBase}`;
        };
        ws.forEach((w, i) => {
          if (EXCLUDE_FLAG_RE.test(ws[i - 1] ?? '') && excludesExactly(w)) excludedIdx.add(i);
          else if (/^--exclude(?:-dir)?=/.test(w) && excludesExactly(w.replace(/^--exclude(?:-dir)?=/, ''))) excludedIdx.add(i);
        });
        const excludesRoot = excludedIdx.size > 0;
        // find -maxdepth N: a walk of an ancestor that stops above the session
        // directories (depth(path) + N < depth(root) + 2) cannot enter — or even
        // name — any tenant's worktree.
        let maxdepth: number | null = null;
        if (prog === 'find') {
          const k = args.indexOf('-maxdepth');
          const n = k >= 0 ? Number(args[k + 1]) : NaN;
          if (Number.isFinite(n) && n >= 0) maxdepth = Math.floor(n);
        }
        const shallowWalk = (abs: string): boolean => maxdepth !== null && pathDepth(abs) + maxdepth < pathDepth(root) + 2;

        const resolve = (piece: string): string | null => {
          if (piece.includes(CWD_TOKEN)) return null;
          if (piece.startsWith('-') && !piece.includes('/')) return null;
          if (piece.startsWith('/')) {
            const n = norm(piece);
            const at = n.indexOf(root);
            return at > 0 ? n.slice(at) : n;
          }
          if (piece.startsWith('~') || piece.startsWith('$')) return null;
          if (cwd === null) return null;
          if (inAllowed(cwd) && !/(^|\/)\.\.(\/|$)/.test(piece)) return null;
          return norm(path.posix.join(cwd, piece));
        };
        const judge = (abs: string): void => {
          if (GLOB_CHARS_RE.test(abs)) {
            const literal = abs.slice(0, abs.search(GLOB_CHARS_RE)).replace(/\/+$/, '');
            if (literal && inAllowed(literal)) return;
            const reach = globReach(abs, root);
            if (reach === 'below') flag('glob', abs);
            else if (reach === 'ancestor' && recursive && !excludesRoot) flag('ancestor_traversal', abs);
            return;
          }
          if (within(abs, root)) {
            if (inAllowed(abs)) return;
            flagUnderRoot(abs);
            return;
          }
          if (recursive && !excludesRoot && within(root, abs) && !shallowWalk(abs)) flag('ancestor_traversal', abs);
        };

        // `ln -s TARGET LINK`: a relative TARGET is resolved from the LINK's directory.
        let lnTargetIdx = -1;
        let lnBase: string | null = null;
        if (prog === 'ln' && cwd !== null && args.some((a) => /^-[A-Za-z]*s/.test(a) || a === '--symbolic')) {
          const nonFlag: number[] = [];
          ws.forEach((w, i) => { if (i >= argStart && !w.startsWith('-')) nonFlag.push(i); });
          if (nonFlag.length >= 2) {
            const target = ws[nonFlag[0]];
            const link = ws[nonFlag[nonFlag.length - 1]];
            const opaque = (x: string): boolean => x.startsWith('~') || x.startsWith('$') || x.includes(CWD_TOKEN);
            if (!target.startsWith('/') && !opaque(target) && !opaque(link)) {
              const linkAbs = link.startsWith('/') ? norm(link) : norm(path.posix.join(cwd, link));
              lnBase = link.endsWith('/') ? linkAbs : path.posix.dirname(linkAbs);
              lnTargetIdx = nonFlag[0];
            }
          }
        }

        ws.forEach((w, i) => {
          if (excludedIdx.has(i)) return;
          if (i === lnTargetIdx && lnBase) {
            if (inAllowed(lnBase) && !/(^|\/)\.\.(\/|$)/.test(w)) return;
            judge(norm(path.posix.join(lnBase, w)));
            return;
          }
          for (const piece of pieces(w)) {
            const abs = resolve(piece);
            if (abs) judge(abs);
          }
        });

        // Embedded heredoc bodies / quoted strings — judged with THIS segment's cwd (before its own cd).
        if (embedded.length) {
          const runner = SCRIPT_RUNNERS.has(prog) ? path.posix.basename(ws.slice(argStart).find((w) => !w.startsWith('-')) ?? '') : '';
          const remote = REMOTE_EXEC.has(prog) || REMOTE_EXEC.has(runner);
          const raw = rawProgramOf(ws);
          for (const e of embedded) {
            if (e.kind === 'H') {
              const d = docs[e.idx];
              if (!d) continue;
              if (remote) { if (remoteExemptOff) analyze(d.body, cwd, depth + 1); continue; }
              if (LOCAL_SHELLS.has(raw.prog)) { analyze(d.body, cwd, depth + 1); continue; }
              judgeData(d.body, cwd, INTERPRETER_RE.test(prog));
              // An UNQUOTED delimiter expands $(…) in the body — that part runs locally.
              if (!d.quoted) for (const sub of d.body.match(/\$\(([^()]*)\)/g) ?? []) analyze(sub.slice(2, -1), cwd, depth + 1);
            } else {
              const sp = spans[e.idx];
              if (!sp) continue;
              if (sp.hasSubst) { analyze(sp.text, cwd, depth + 1); continue; }
              if (remote) { if (remoteExemptOff) analyze(sp.text, cwd, depth + 1); continue; }
              if (raw.prog === 'eval' || (LOCAL_SHELLS.has(raw.prog) && raw.flags.some((f) => /^-[A-Za-z]*c[A-Za-z]*$/.test(f)))) {
                analyze(sp.text, cwd, depth + 1);
                continue;
              }
              judgeData(sp.text, cwd, INTERPRETER_RE.test(prog) && hasCodeFlag(ws, argStart));
            }
          }
        }

        if (prog === 'cd' || prog === 'pushd') {
          const target = args.find((a) => !a.startsWith('-'));
          // A cd whose target was a multi-word quoted string is unknowable.
          if (!target || embedded.some((e) => e.kind === 'Q')) cwd = null;
          else {
            const abs: string | null = target.startsWith('/') ? norm(target)
              : (target.startsWith('~') || target.startsWith('$') || target.includes(CWD_TOKEN) || cwd === null) ? null
                : norm(path.posix.join(cwd, target));
            cwd = abs && !GLOB_CHARS_RE.test(abs) ? abs : null;
          }
        } else if (prog === 'popd') cwd = null;
      }
    };

    analyze(String(command ?? ''), worktree, 0);
    return reason ? { refused: true, reason, refs } : { refused: false, refs: [] };
  } catch {
    return { refused: false, refs: [] };
  }
}

/** The tool-result text for a refusal — leads with "[command REFUSED" so receipts record ok:false. */
export function workspaceGuardRefusalMessage(v: WorkspaceGuardVerdict, scope: WorkspaceGuardScope): string {
  const why: Record<WorkspaceGuardReason, string> = {
    foreign_path: "it names another session's worktree or another project's repo mirror",
    workspace_root: 'it lists the shared workspace volume itself (every session / every project)',
    glob: 'its wildcard can match other sessions\' worktrees or other projects\' mirrors',
    ancestor_traversal: 'it walks a parent of the shared workspace volume recursively, which would enter every session\'s worktree — narrow the path (e.g. the task directory itself) or exclude the volume (find … -path <root> -prune -o …, grep -r --exclude-dir=coding-workspaces)',
    dirname_escape: 'it climbs out of this session\'s own workspace',
  };
  return `[command REFUSED — workspace scope] NOTHING was executed.\n` + JSON.stringify({
    ok: false,
    reason: 'run_command_workspace_scope',
    detail: v.reason ? why[v.reason] : 'it references a path outside this session\'s workspace',
    refs: v.refs,
    message: `This shell can see a shared volume that holds OTHER users' sessions; commands may only touch this session's own worktree (${norm(scope.worktree)})${scope.allowed.length > 1 ? `, its project mirror and its home` : ''}. Other sessions are never yours to read — work inside the worktree (relative paths), use the file / search tools, or ask the owning lane via send_chat_message. To search code for this path as a literal string, use the grep / search tools instead of the shell.`,
  }, null, 1);
}
