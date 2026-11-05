/**
 * open_pull_request verify gate — the A5 relief (2026-09-27).
 *
 * The gate used to REFUSE any PR until the verify chain had passed this session
 * on the current content — including docs-only PRs. Every docs-keeper PR since
 * 2026-09-25 therefore cost a refusal, a verify round and a retry (prod receipts:
 * open_pull_request ok=false 3/7/4 vs ok=true 3/7/4 with a verify row between
 * each pair). Two changes, both kill-switched and fail-safe:
 *
 *   1. DOCS-ONLY BYPASS — when every file the PR would carry (branch commits
 *      against the merge-base with the base branch, UNION the working tree's
 *      modified / staged / untracked files) is under `docs/` or ends in `.md`,
 *      the gate is skipped and the PR body carries a "docs-only, unverified"
 *      note. Any non-docs file, an unresolvable merge-base, an empty diff or a
 *      git failure ⇒ NOT docs-only (the gate proceeds as before).
 *
 *   2. AUTO-VERIFY — otherwise, instead of refusing ("run verify and retry"),
 *      the tool runs the verify chain itself and opens the PR on a green
 *      result (one round instead of three); a red chain still refuses, with
 *      the failing stage's output tail. (The 2026-09-27 release switch that
 *      restored the plain refusal was retired by RSW-1 on 2026-11-12 — the
 *      auto-verify arm is unconditional; a lane that wants the old refusal
 *      just runs `verify` itself first.)
 *
 * The docs-only classification is a pure function over paths so the rule is
 * testable without git; the diff listing is injectable for the same reason.
 */

/** Repo-relative path counts as documentation: anywhere under `docs/` or a `.md` file. */
export function isDocsPath(file: string): boolean {
  const p = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return false;
  if (/^docs\//.test(p)) return true;
  return /\.md$/i.test(p);
}

export interface DocsOnlyVerdict {
  /** true only when files is non-empty AND every file is a docs path. */
  docsOnly: boolean;
  files: string[];
  nonDocs: string[];
}

export function classifyDocsOnly(files: string[]): DocsOnlyVerdict {
  const uniq = [...new Set((files || []).map(f => String(f || '').trim()).filter(Boolean))];
  const nonDocs = uniq.filter(f => !isDocsPath(f));
  return { docsOnly: uniq.length > 0 && nonDocs.length === 0, files: uniq, nonDocs };
}

export type GitRunner = (args: string[], cwd: string) => Promise<{ stdout: string }>;

const splitLines = (out: string): string[] =>
  String(out || '').split('\n').map(l => l.trim()).filter(Boolean);

/**
 * Every file the PR would carry: the branch's commits against the merge-base
 * with the base branch (origin/<base> first, then a local <base>), UNION the
 * working tree's modified / staged / untracked files (conservative — a stray
 * uncommitted code edit keeps the gate on). null when the merge-base cannot be
 * resolved or git fails — the caller treats null as "not docs-only".
 */
export async function listPrDiffFiles(runGit: GitRunner, worktree: string, baseBranch: string): Promise<string[] | null> {
  const base = String(baseBranch || 'main').replace(/[^A-Za-z0-9._/-]/g, '');
  if (!base) return null;
  let mergeBase = '';
  for (const ref of [`origin/${base}`, base]) {
    try {
      mergeBase = (await runGit(['merge-base', ref, 'HEAD'], worktree)).stdout.trim();
      if (mergeBase) break;
    } catch { /* try the next ref */ }
  }
  if (!mergeBase) return null;
  try {
    const committed = splitLines((await runGit(['diff', '--name-only', mergeBase, 'HEAD'], worktree)).stdout);
    const dirty = splitLines((await runGit(['diff', '--name-only', 'HEAD'], worktree)).stdout);
    const untracked = splitLines((await runGit(['ls-files', '--others', '--exclude-standard'], worktree)).stdout);
    return [...new Set([...committed, ...dirty, ...untracked])];
  } catch {
    return null;
  }
}

/** The PR-body trailer for a docs-only PR that skipped the verify chain. */
export function docsOnlyPrBodyNote(fileCount: number): string {
  return `\n\n---\n_Docs-only change (${fileCount} file${fileCount === 1 ? '' : 's'}, all under docs/ or *.md): the verify chain was not run for this PR — unverified by design. CI on the PR is the verification of record._`;
}

/** PR-body trailer for a PR opened from an out-of-band head (explicit
 *  headBranch ≠ the worktree checkout — review fix 2026-09-27 MEDIUM kept the
 *  fall-through to the chain; this note, from the nightly shortfall fix
 *  2026-10-04, discloses the scope gap). The auto-verify chain attests the
 *  WORKTREE checkout it ran against, not this head; CI on the PR is the
 *  verification of record. Same principle as docsOnlyPrBodyNote: an honest
 *  trailer on the PR itself, never an unqualified/false one. */
export function prHeadMismatchBodyNote(headBranch: string): string {
  return `\n\n---\n_Verification scope note: this PR opens from out-of-band head \`${String(headBranch)}\`, which is NOT the worktree checkout the auto-verify chain ran against — the green result attests the checkout, not this head. CI on the PR is the verification of record._`;
}

// ── Auto-verify deadline (review fix 2026-09-27, HIGH) ───────────────────────
// The agent loop races every non-delegation tool against TOOL_HARD_TIMEOUT_MS
// (15 min, agent.ts) WITHOUT cancelling it — a tool that outlives the timer keeps
// running and its side effects land AFTER the model was told "aborted, proceed".
// The in-tool auto-verify (verify-slot queue wait + chain: 3 attempts at the
// per-command cap — 600 s per stage, both from DEFAULT_LOOP and from a
// scaffolded config since ticket 91120212 aligned them) must therefore give up
// safely under that timer and REFUSE without pushing or opening anything.
export const PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS = 12 * 60 * 1000;
/** Hard ceiling — one minute under the loop's 15-min hard abort. */
export const PR_GATE_AUTO_VERIFY_DEADLINE_MAX_MS = 14 * 60 * 1000;

/** PR_GATE_AUTO_VERIFY_DEADLINE_MS (ms; default 12 min; clamped to [1 ms, 14 min];
 *  non-numeric / ≤0 ⇒ default). A too-small value can only ever REFUSE (fail-safe). */
export function prGateAutoVerifyDeadlineMs(): number {
  const raw = Number(process.env.PR_GATE_AUTO_VERIFY_DEADLINE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return PR_GATE_AUTO_VERIFY_DEADLINE_DEFAULT_MS;
  return Math.min(PR_GATE_AUTO_VERIFY_DEADLINE_MAX_MS, Math.max(1, Math.floor(raw)));
}

export type DeadlineOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Race `work` against `ms`. On the deadline the caller gets `{timedOut:true}`
 * and MUST take no side effect; the work itself is NOT cancelled (it finishes
 * on its own — a late rejection is swallowed so it never surfaces as an
 * unhandled rejection). The timer is always cleared.
 */
export async function withDeadline<T>(work: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guarded: Promise<DeadlineOutcome<T>> = work.then(value => ({ timedOut: false as const, value }));
  const deadline = new Promise<DeadlineOutcome<T>>(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), ms); });
  try {
    const outcome = await Promise.race([guarded, deadline]);
    if (outcome.timedOut) guarded.catch(() => { /* finished late and failed — the background result is advisory */ });
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
