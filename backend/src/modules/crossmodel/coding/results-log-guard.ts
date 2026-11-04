/**
 * Results-log TRUNCATION guard — dependency-free leaf (tt-rd audit 2026-09-27,
 * finding docs-churn-log-2).
 *
 * Why: a project's results log (the lane's own "truth source + queue") was
 * reset to a stub TWICE on main — PR #601 took it from 8,419 lines / 1.43 MB
 * to 29 lines (−8,409 lines, 228 '##' sections) and PR #809 from 4,238 lines
 * to 20 (−4,232 lines, 171 sections) — and both PRs passed every self-merge
 * gate, because no gate reads DELETIONS (G4's secret scan filters the '+'
 * lines only) and no doctrine said a results log is append-only. 399 sections
 * of the program's record now exist only in git history, with no archive
 * file added in either PR.
 *
 * What this leaf does (pure, deterministic, never throws):
 *   - parseUnifiedDiff(diff)           — per-file added/deleted line counts,
 *                                         deleted BYTES, '##' sections deleted,
 *                                         the old-side line span the hunks
 *                                         cover, new/removed flags
 *   - diffStatsFromPatches(files)      — the same from GitHub's compare /
 *                                         pulls-files JSON (per-file `patch`)
 *   - matchesResultsLog(path)          — RESULTS_LOG_GLOB (default
 *                                         'results/**\/*.md,**\/*results*.md,
 *                                         **\/*tracker*.md,**\/*log*.md')
 *   - findResultsLogTruncations(...)   — a results-log file losing ≥
 *                                         RESULTS_LOG_MAX_DELETED_LINES (200)
 *                                         lines AND ≥ 50 % of its pre-PR BYTES
 *                                         (one contents GET gives `size`; when
 *                                         that read fails the hunk span is the
 *                                         fallback: ≥ 90 % of the covered old
 *                                         lines deleted = a stub rewrite)
 *   - hasArchiveAdded(stats)           — a file ADDED under an archive/ path in
 *                                         the same diff exonerates the removal
 *
 * Consumers: self-merge.service evaluateMergeGates (after G4 — the diff is
 * already in hand; note + guard_strike seam 'results_log_truncate' observed;
 * RESULTS_LOG_GUARD_ENFORCE=1 promotes it to merge gate 'results_log') and
 * coding/tools.ts open_pull_request (notice-only, via the compare files).
 */

export const RESULTS_LOG_DEFAULT_GLOBS = ['results/**/*.md', '**/*results*.md', '**/*tracker*.md', '**/*log*.md'];
export const RESULTS_LOG_MAX_DELETED_LINES_DEFAULT = 200;
/** Deleted bytes ÷ pre-PR file bytes at or above this = a truncation. */
export const RESULTS_LOG_TRUNCATION_RATIO = 0.5;
/** Fallback (pre-size unreadable): deleted lines ÷ hunk-covered old lines at or above this. */
export const RESULTS_LOG_HUNK_RATIO = 0.9;
/** Candidates inspected per diff (one contents GET each) — a truncation is one file, never twenty. */
export const RESULTS_LOG_MAX_CANDIDATES = 3;

const flag = (name: string): boolean => {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
};
export function resultsLogGuardEnforced(): boolean { return flag('RESULTS_LOG_GUARD_ENFORCE'); }
export function resultsLogMaxDeletedLines(): number {
  const n = Number(process.env.RESULTS_LOG_MAX_DELETED_LINES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : RESULTS_LOG_MAX_DELETED_LINES_DEFAULT;
}
export function resultsLogGlobs(): string[] {
  const raw = String(process.env.RESULTS_LOG_GLOB ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return raw.length ? raw : RESULTS_LOG_DEFAULT_GLOBS;
}

/** Minimal glob → RegExp: `**` spans directories, `*` one path segment, `?` one char. Case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` matches zero or more directories; a bare `**` matches anything.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

export function matchesResultsLog(path: string, globs: string[] = resultsLogGlobs()): boolean {
  const p = String(path ?? '').replace(/^\.\//, '');
  if (!p) return false;
  return globs.some((g) => { try { return globToRegExp(g).test(p); } catch { return false; } });
}

export interface DiffFileStat {
  path: string;
  added: number;
  deleted: number;
  /** Bytes of the deleted lines (newline included); null when only counts were available (no patch). */
  deletedBytes: number | null;
  /** Deleted lines that were markdown headings ('#', '##', …) — the sections lost. */
  sectionsDeleted: number;
  /** Old-side line span the hunks cover (max oldStart + oldCount − 1); 0 without hunks. */
  hunkCoveredOld: number;
  isNew: boolean;
  isRemoved: boolean;
}

interface Acc { stat: DiffFileStat; sawOld: boolean; sawNew: boolean }

function newAcc(path: string): Acc {
  return { stat: { path, added: 0, deleted: 0, deletedBytes: 0, sectionsDeleted: 0, hunkCoveredOld: 0, isNew: false, isRemoved: false }, sawOld: false, sawNew: false };
}

const HEADING_RE = /^-#{1,6} /;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Apply one hunk-body / hunk-header line to a file accumulator. */
function applyLine(acc: Acc, line: string): void {
  const h = line.match(HUNK_RE);
  if (h) {
    const start = Number(h[1]);
    const count = h[2] === undefined ? 1 : Number(h[2]);
    acc.stat.hunkCoveredOld = Math.max(acc.stat.hunkCoveredOld, count === 0 ? start : start + count - 1);
    return;
  }
  if (line.startsWith('+')) { acc.stat.added += 1; return; }
  if (line.startsWith('-')) {
    acc.stat.deleted += 1;
    acc.stat.deletedBytes = (acc.stat.deletedBytes ?? 0) + Buffer.byteLength(line.slice(1), 'utf8') + 1;
    if (HEADING_RE.test(line)) acc.stat.sectionsDeleted += 1;
  }
}

/**
 * Per-file stats from a unified diff (GitHub's application/vnd.github.diff).
 * File boundaries come from `diff --git` headers (fallback: `---`/`+++`
 * pairs); `/dev/null` sides mark added / removed files. Never throws.
 */
export function parseUnifiedDiff(diff: string): DiffFileStat[] {
  const out: Acc[] = [];
  let cur: Acc | null = null;
  const lines = String(diff ?? '').split('\n').map((raw) => (raw.endsWith('\r') ? raw.slice(0, -1) : raw));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const g = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (g) { cur = newAcc(g[2]); out.push(cur); continue; }
    // A `--- ` header is only a header when `+++ ` follows it — a DELETED body
    // line whose content starts with "-- " renders as "--- …" too.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (!cur || (cur.sawOld && cur.sawNew)) { cur = newAcc(p.startsWith('a/') ? p.slice(2) : p); out.push(cur); }
      cur.sawOld = true;
      if (p === '/dev/null') cur.stat.isNew = true;
      continue;
    }
    if (line.startsWith('+++ ') && (lines[i - 1] ?? '').startsWith('--- ')) {
      const p = line.slice(4).trim();
      if (!cur) { cur = newAcc(p.startsWith('b/') ? p.slice(2) : p); out.push(cur); }
      cur.sawNew = true;
      if (p === '/dev/null') cur.stat.isRemoved = true;
      else if (!cur.stat.path || cur.stat.path === '/dev/null') cur.stat.path = p.startsWith('b/') ? p.slice(2) : p;
      continue;
    }
    if (cur) applyLine(cur, line);
  }
  return out.map((a) => a.stat).filter((s) => s.path && s.path !== '/dev/null');
}

/** The same stats from GitHub's compare / pulls-files JSON; the per-file `patch` (hunks only) supplies bytes + sections when present. */
export function diffStatsFromPatches(files: Array<{ filename?: string; additions?: number; deletions?: number; status?: string; patch?: string | null }> | null | undefined): DiffFileStat[] {
  const out: DiffFileStat[] = [];
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.filename !== 'string' || !f.filename) continue;
    const acc = newAcc(f.filename);
    if (typeof f.patch === 'string' && f.patch) {
      for (const raw of f.patch.split('\n')) applyLine(acc, raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    } else {
      acc.stat.added = Number(f.additions) || 0;
      acc.stat.deleted = Number(f.deletions) || 0;
      acc.stat.deletedBytes = null;
    }
    acc.stat.isNew = f.status === 'added';
    acc.stat.isRemoved = f.status === 'removed';
    out.push(acc.stat);
  }
  return out;
}

const ARCHIVE_PATH_RE = /(^|\/)archive\//i;

/** A file ADDED under an archive/ directory in the same diff — the removal was an archive move. */
export function hasArchiveAdded(stats: DiffFileStat[]): boolean {
  return stats.some((s) => s.isNew && ARCHIVE_PATH_RE.test(s.path));
}

/** The results-log files whose deletions clear the line floor — the ones worth one contents GET each. */
export function resultsLogCandidates(stats: DiffFileStat[], opts: { maxDeleted?: number; globs?: string[] } = {}): DiffFileStat[] {
  const maxDeleted = opts.maxDeleted ?? resultsLogMaxDeletedLines();
  const globs = opts.globs ?? resultsLogGlobs();
  return stats
    .filter((s) => !s.isNew && s.deleted >= maxDeleted && matchesResultsLog(s.path, globs))
    .sort((a, b) => b.deleted - a.deleted)
    .slice(0, RESULTS_LOG_MAX_CANDIDATES);
}

export interface ResultsLogTruncation {
  path: string;
  deleted: number;
  added: number;
  sectionsDeleted: number;
  /** Pre-PR size in bytes (contents API `size`), null when unreadable. */
  preBytes: number | null;
  /** deletedBytes ÷ preBytes, or the hunk-span fallback ratio (see hunkEstimated). */
  ratio: number;
  /** True when the ratio is deleted ÷ hunk-covered old lines (pre-size unreadable). */
  hunkEstimated: boolean;
  /** No file was added under archive/ in the same diff. */
  archiveMissing: boolean;
}

/**
 * Truncations among the candidates. `preBytes(path)` is the pre-PR byte size
 * (null = unreadable → hunk-span fallback). Pure; the caller fetched sizes.
 */
export function findResultsLogTruncations(
  candidates: DiffFileStat[],
  preBytes: (path: string) => number | null,
  allStats: DiffFileStat[] = candidates,
): ResultsLogTruncation[] {
  const archiveMissing = !hasArchiveAdded(allStats);
  const out: ResultsLogTruncation[] = [];
  for (const s of candidates) {
    const pre = preBytes(s.path);
    let ratio = 0;
    let hunkEstimated = false;
    if (pre != null && pre > 0 && s.deletedBytes != null) {
      ratio = s.deletedBytes / pre;
      if (ratio < RESULTS_LOG_TRUNCATION_RATIO) continue;
    } else {
      hunkEstimated = true;
      if (!(s.hunkCoveredOld > 0)) continue;
      ratio = s.deleted / s.hunkCoveredOld;
      if (ratio < RESULTS_LOG_HUNK_RATIO) continue;
    }
    out.push({ path: s.path, deleted: s.deleted, added: s.added, sectionsDeleted: s.sectionsDeleted, preBytes: pre ?? null, ratio: Math.min(1, Math.round(ratio * 1000) / 1000), hunkEstimated, archiveMissing });
  }
  return out;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;

/** The lane-facing note / gate evidence line for one truncation. */
export function renderResultsLogNote(t: ResultsLogTruncation): string {
  const basis = t.hunkEstimated
    ? `${pct(t.ratio)} of the lines the diff touches (pre-PR size unreadable)`
    : `${pct(t.ratio)} of its ${t.preBytes} pre-PR bytes`;
  return `results_log: ${t.path} −${t.deleted} lines (${t.sectionsDeleted} section${t.sectionsDeleted === 1 ? '' : 's'}, +${t.added}) = ${basis}${t.archiveMissing ? ' with NO archive file added' : ' (an archive/ file is added in the same diff)'} — results logs and trackers are APPEND-ONLY on main: move the removed sections to results/archive/<name>-<YYYY-MM-DD>.md in this PR, or roll the log over into a new dated file`;
}

export const RESULTS_LOG_SUGGESTED_FIX = 'move the removed sections to results/archive/<name>-<YYYY-MM-DD>.md in this PR, or split the log by month; a results log is append-only on main (RESULTS_LOG_GUARD_ENFORCE=1 is on)';
