/**
 * PR diff SHAPE — the dependency-free leaf behind three observe-only seams
 * (tt-rd audit 2026-09-27, findings docs-churn-log-1 / -3 / -4).
 *
 * Why: over 14 days one project opened 280 PRs and merged 273; 253 touched
 * ONLY markdown (a one-file append to a results log), 165 of 166 runs with any
 * git receipt opened a PR, and six PRs of an identical 4,703-line diff were
 * opened across runs and all closed unmerged. Nothing in the harness could
 * SEE any of that: the open_pull_request receipt carried {prNumber, url} and
 * nothing about what the PR changed, so a docs-only append counted as "landed
 * movement" up the supervisor chain and a duplicate re-open was invisible.
 *
 * What this leaf does (pure, deterministic, never throws):
 *   - prDiffShape(files)      — the GitHub compare / pulls-files JSON reduced
 *                                to {fileCount, files, +/−, filesOnlyMd, diffHash}
 *   - renderPrDiffLine / parsePrDiffLine — the ONE harness-authored line
 *                                appended to the open_pull_request result
 *                                ("[PR DIFF] …") that run-receipts parses into
 *                                receipt ids (filesOnlyMd, files, diffHash, …)
 *   - docsOnlyPrPriorCount     — the Nth docs-only PR in the batch window that
 *                                touched a file this PR touches (notice trigger)
 *   - duplicatePrReceipt       — a prior receipt whose diffHash equals this
 *                                PR's (duplicate re-open across runs)
 *   - docsOnlyPrCount / docsOnlyPrCountLine — the [SCHEDULE STATE] churn line
 *
 * Kill switch (read per call from process.env — the leaf stays import-free):
 *   DOCS_ONLY_PR_ENFORCE=1          the docs-only notice REFUSES the PR on a
 *                                   machine run (default off — 2026-09-11 flip)
 *   DOCS_ONLY_PR_BATCH_HOURS=24     the batch window
 *
 * A PR touching only .digby/** is "state-only" — never noticed, refused or
 * counted (fixer 2026-09-27, finding 2).
 */

import { createHash } from 'crypto';

/** One entry of GitHub's compare `files[]` / `pulls/{n}/files` JSON (the fields read here). */
export interface PrFile {
  filename: string;
  additions?: number;
  deletions?: number;
  status?: string;
  previous_filename?: string;
}

export interface PrDiffShape {
  fileCount: number;
  /** Changed paths, sorted, capped at PR_DIFF_FILES_CAP (the receipt carries these). */
  files: string[];
  additions: number;
  deletions: number;
  /**
   * Every changed NON-state file is markdown (.md / .markdown / .mdx). False
   * for an empty diff and for a state-only diff (fixer 2026-09-27: `.digby/**`
   * is harness STATE, classified apart — see isStatePath).
   */
  filesOnlyMd: boolean;
  /** Every changed file lives under `.digby/` (rules / notes / config): harness state — neither a record nor a change. */
  filesOnlyState: boolean;
  /** sha256/16 of the sorted "path:+a:-d" list — equal ⇔ the same file set with the same line counts. */
  diffHash: string;
}

/** The receipt fields a prior open_pull_request receipt may carry (structural — no ToolReceipt import). */
export interface PrReceiptLike {
  tool: string;
  ok: boolean;
  ids: Record<string, unknown>;
  createdAt: Date | string;
}

export const PR_DIFF_LINE_PREFIX = '[PR DIFF]';
export const PR_DIFF_FILES_CAP = 8;
export const DOCS_ONLY_PR_BATCH_HOURS_DEFAULT = 24;
/** Duplicate-PR lookback: the audit's six duplicates spanned five days. */
export const DUP_PR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const MD_RE = /\.(?:md|markdown|mdx)$/i;

/**
 * Harness STATE paths — `.digby/**` (rules, notes, config). A PR that touches
 * ONLY these is "state-only": neither a record nor a change, and never in the
 * docs-only class (fixer 2026-09-27, finding docs-churn-log-2). The lane
 * doctrine routes the cross-run queue / next step / of-record numbers to
 * `.digby/rules/00-current-state.md`, and the supervisors' program-truth
 * reader (fleet/project-digest.service readProgramState) reads that file
 * from the mirror's DEFAULT branch — so landing it on main is exactly what the
 * doctrine asks for, and the docs-only notice / refusal must not fire on it.
 * A mixed PR (state + a results log) is classified on its NON-state files.
 */
const STATE_PATH_RE = /^\.digby\//;
export function isStatePath(path: string): boolean { return STATE_PATH_RE.test(String(path ?? '')); }

const flag = (name: string): boolean => {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
};

export function docsOnlyPrEnforced(): boolean { return flag('DOCS_ONLY_PR_ENFORCE'); }
export function docsOnlyPrBatchMs(): number {
  const h = Number(process.env.DOCS_ONLY_PR_BATCH_HOURS);
  return (Number.isFinite(h) && h > 0 ? h : DOCS_ONLY_PR_BATCH_HOURS_DEFAULT) * 60 * 60 * 1000;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/** Reduce the compare / pulls-files JSON to the shape. Pure; tolerates junk entries. */
export function prDiffShape(files: PrFile[] | null | undefined): PrDiffShape {
  const rows = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.filename === 'string' && f.filename.length > 0)
    .map((f) => ({ path: f.filename, add: num(f.additions), del: num(f.deletions) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const additions = rows.reduce((s, r) => s + r.add, 0);
  const deletions = rows.reduce((s, r) => s + r.del, 0);
  const canonical = rows.map((r) => `${r.path}:+${r.add}:-${r.del}`).join('\n');
  // State paths (.digby/**) are classified apart: a mixed PR is judged on its
  // non-state files; a PR of ONLY state files is state-only, not docs-only.
  const judged = rows.filter((r) => !STATE_PATH_RE.test(r.path));
  return {
    fileCount: rows.length,
    files: rows.slice(0, PR_DIFF_FILES_CAP).map((r) => r.path),
    additions,
    deletions,
    filesOnlyMd: judged.length > 0 && judged.every((r) => MD_RE.test(r.path)),
    filesOnlyState: rows.length > 0 && judged.length === 0,
    diffHash: createHash('sha256').update(canonical).digest('hex').slice(0, 16),
  };
}

/**
 * The harness-authored tail line on the open_pull_request result:
 *   "[PR DIFF] 1 file · +18/−0 · docs-only · hash 0123456789abcdef · results/x.md"
 *   "[PR DIFF] 1 file · +12/−9 · state-only · hash … · .digby/rules/00-current-state.md"
 * The class is docs-only | code | state-only. Paths ride LAST (they may
 * contain " · "-free but otherwise arbitrary chars); parsePrDiffLine reads the
 * fixed fields first and the rest as paths.
 */
export function renderPrDiffLine(shape: PrDiffShape): string {
  const n = shape.fileCount;
  const more = n > shape.files.length ? ` (+${n - shape.files.length} more)` : '';
  const cls = shape.filesOnlyState ? 'state-only' : shape.filesOnlyMd ? 'docs-only' : 'code';
  return `${PR_DIFF_LINE_PREFIX} ${n} file${n === 1 ? '' : 's'} · +${shape.additions}/−${shape.deletions} · ${cls} · hash ${shape.diffHash} · ${shape.files.join(', ')}${more}`;
}

const PR_DIFF_LINE_RE = /^\[PR DIFF\] (\d+) files? · \+(\d+)\/−(\d+) · (docs-only|code|state-only) · hash ([0-9a-f]{16}) · (.*)$/m;

/** Parse the [PR DIFF] line out of a tool result (any position). Null when absent / malformed. */
export function parsePrDiffLine(text: string): { fileCount: number; additions: number; deletions: number; filesOnlyMd: boolean; filesOnlyState: boolean; diffHash: string; files: string[] } | null {
  const m = String(text ?? '').match(PR_DIFF_LINE_RE);
  if (!m) return null;
  const files = m[6].replace(/ \(\+\d+ more\)$/, '').split(',').map((s) => s.trim()).filter(Boolean);
  return { fileCount: Number(m[1]), additions: Number(m[2]), deletions: Number(m[3]), filesOnlyMd: m[4] === 'docs-only', filesOnlyState: m[4] === 'state-only', diffHash: m[5], files };
}

const toMs = (d: Date | string): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** This chat's ok open_pull_request receipts inside the window, newest first. */
function priorPrReceipts(prior: PrReceiptLike[], nowMs: number, windowMs: number): PrReceiptLike[] {
  return (Array.isArray(prior) ? prior : [])
    .filter((r) => r && r.ok && r.tool === 'open_pull_request' && r.ids && typeof r.ids === 'object')
    .filter((r) => { const t = toMs(r.createdAt); return Number.isFinite(t) && t <= nowMs && nowMs - t <= windowMs; })
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));
}

const receiptFiles = (r: PrReceiptLike): string[] => (Array.isArray(r.ids.files) ? (r.ids.files as unknown[]).filter((f): f is string => typeof f === 'string') : []);

/**
 * Docs-only churn trigger: this PR is docs-only AND a prior docs-only PR of
 * this chat inside the window touched one of the same files. Returns the
 * count INCLUDING this PR (the "Nth such PR in 24h") and the shared file, or
 * null when the pattern is absent (a first docs-only PR is never noticed).
 */
export function docsOnlyPrPriorCount(
  shape: PrDiffShape,
  prior: PrReceiptLike[],
  now: Date,
  windowMs: number = docsOnlyPrBatchMs(),
): { count: number; sharedFile: string } | null {
  if (!shape.filesOnlyMd) return null;
  // The state file is never the notice's "shared file": a daily state + results
  // PR pair would otherwise notice on .digby/rules/00-current-state.md, the
  // very file the doctrine tells the lane to land (fixer 2026-09-27).
  const mine = new Set(shape.files.filter((f) => !STATE_PATH_RE.test(f)));
  const docsOnlyPrior = priorPrReceipts(prior, now.getTime(), windowMs).filter((r) => r.ids.filesOnlyMd === true);
  let sharedFile: string | null = null;
  for (const r of docsOnlyPrior) {
    const hit = receiptFiles(r).find((f) => mine.has(f));
    if (hit) { sharedFile = hit; break; }
  }
  if (!sharedFile) return null;
  return { count: docsOnlyPrior.length + 1, sharedFile };
}

/** A prior open_pull_request receipt of this chat carrying the SAME diffHash inside the window (newest), or null. */
export function duplicatePrReceipt(
  shape: PrDiffShape,
  prior: PrReceiptLike[],
  now: Date,
  windowMs: number = DUP_PR_WINDOW_MS,
): PrReceiptLike | null {
  if (shape.fileCount === 0) return null;
  return priorPrReceipts(prior, now.getTime(), windowMs).find((r) => r.ids.diffHash === shape.diffHash) ?? null;
}

/** Docs-only PRs this chat opened inside the window (the [SCHEDULE STATE] / timing count). */
export function docsOnlyPrCount(prior: PrReceiptLike[], now: Date, windowMs: number = docsOnlyPrBatchMs()): number {
  return priorPrReceipts(prior, now.getTime(), windowMs).filter((r) => r.ids.filesOnlyMd === true).length;
}

export function renderDocsOnlyPrNotice(shape: PrDiffShape, hit: { count: number; sharedFile: string }, hours: number = docsOnlyPrBatchMs() / 3_600_000): string {
  return `[DOCS-ONLY PR NOTICE] this PR only appends to ${hit.sharedFile} (+${shape.additions}/−${shape.deletions}), the ${ordinal(hit.count)} such PR in ${hours}h — a results/tracker/journal APPEND is a RECORD, not a change: batch appends on the session branch and open ONE PR per day (or when a code/script change lands); the queue / next step / of-record numbers belong in .digby/rules/00-current-state.md, not in a log that must be re-landed on main every firing.`;
}

export function renderDocsOnlyPrRefusal(shape: PrDiffShape, hit: { count: number; sharedFile: string }): string {
  return `PR REFUSED (DOCS_ONLY_PR_ENFORCE=1, machine run): this PR only appends to ${hit.sharedFile} (+${shape.additions}/−${shape.deletions}) and is the ${ordinal(hit.count)} docs-only PR on that file in the batch window. The branch is pushed — keep appending on it and open one PR per day or with the next code change. Nothing was opened.`;
}

export function renderDuplicatePrNotice(prior: PrReceiptLike, headBranch: string | null): string {
  const n = prior.ids.prNumber != null ? `#${prior.ids.prNumber}` : '(number unknown)';
  return `[DUPLICATE PR NOTICE] open PR ${n} already carries this exact file set and line counts${headBranch ? ` (its head branch: ${headBranch})` : ''} — push your commits to that branch (open_pull_request with headBranch, or git_push after checking it out) or close it first; a fresh PR per run of the same diff leaves closed duplicates and a self-merge attempt trail.`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}
