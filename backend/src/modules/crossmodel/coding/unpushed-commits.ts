/**
 * UNPUSHED COMMITS at run end (audit 2026-10-06 T7-8 — spark.md #4).
 *
 * Evidence: lane a9ef85f3 committed 07d91d2f (a docs fix) and lane c90fed41
 * committed 54c84686 (an incident doc, via run_command) — neither was ever
 * pushed; origin still carried the stale text, the supervisor closed a
 * directive citing the local sha, and the session status card said "Made 1
 * commit" with no push state. Commits stranded on a local session branch are
 * invisible to everyone but the worktree.
 *
 * At a run's finalize the executor measures the worktree's commits that no
 * remote-tracking ref contains (`git rev-list --count HEAD --not --remotes` —
 * a pushed session branch or a merged PR clears them) and:
 *   - stamps the count in the context store ([sessionId, 'git-state'] /
 *     'unpushed') — the session status card reads it ("N local commits — NOT
 *     pushed"); the stamp is state, refreshed every run (0 clears it);
 *   - when commits are unpushed and HEAD moved since the last stamp (this run
 *     committed), appends ONE harness line to the final — which the persisted
 *     answer, the run_completed hook summary and the deliverable hand-off all
 *     carry.
 * Skipped for a worktree with NO remote-tracking refs (a local-provider /
 * blank repo has nothing to push to). Every read fails open (no line, no
 * stamp change). Kill switch UNPUSHED_COMMITS_NOTE_DISABLED=1 (read per call).
 */

import { execFile } from 'child_process';
import { storeGet, storePut } from '../memory/context-store';
import { parseClaimsBlock, refNamesSha, type ParsedClaimsBlock } from './claims-block';

export function unpushedCommitsNoteDisabled(): boolean {
  const v = String(process.env.UNPUSHED_COMMITS_NOTE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * audit 2026-10-08 W2-2 (lanes.md F3): the note was FALSE in 18 of 25 prod
 * cases — git_push publishes to an authenticated URL
 * (`git push <url> HEAD:refs/heads/<branch>`), which never moved
 * refs/remotes/origin/* on git ≤2.55 (git ≥2.56 now updates the tracking ref
 * itself when the URL uniquely matches the configured remote — the same sha
 * git_push sets below), so `--not --remotes` counted every commit since the
 * last fetch as "unpushed" even when the SAME final cited its push receipt
 * (c742c817: push of 2b7bc8aa at 17:14:50, then "26 local commits … NOT
 * pushed (HEAD 2b7bc8aa)"). Squash merges + head-branch deletion (a fetch
 * --prune drops the tracking ref) produce the same false count. Now:
 *   - git_push updates refs/remotes/origin/<branch> to the pushed sha
 *     (tools.ts pushSessionBranch), and
 *   - every sha a git_push in this session published is remembered here
 *     ([sessionId,'git-state'] / 'pushed', newest PUSHED_SHAS_KEEP) and
 *     excluded from the count (`--not --remotes <shas> --ignore-missing`), so
 *     a commit a receipt proves pushed is never "unpushed" again — even after
 *     the branch was deleted on origin.
 * Kill switch UNPUSHED_PUSHED_SHAS_DISABLED=1 restores the remotes-only count.
 */
export function unpushedPushedShasDisabled(): boolean {
  const v = String(process.env.UNPUSHED_PUSHED_SHAS_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** Newest pushed shas remembered per session. */
export const PUSHED_SHAS_KEEP = 20;
const PUSHED_KEY = 'pushed';
const SHA_RE = /^[0-9a-f]{7,40}$/i;

/** The shas this session's git_push calls published (newest first). Never throws. */
export async function readPushedShas(sessionId: string): Promise<string[]> {
  try {
    const v = await storeGet<{ shas?: unknown }>(NS(sessionId), PUSHED_KEY);
    return Array.isArray(v?.shas) ? (v!.shas as unknown[]).map(String).filter((x) => SHA_RE.test(x)) : [];
  } catch { return []; }
}

/** Remember a pushed sha (git_push success). Best-effort, never throws. */
export async function recordPushedSha(sessionId: string, sha: string, now: Date = new Date()): Promise<void> {
  try {
    const clean = String(sha ?? '').trim();
    if (!sessionId || !SHA_RE.test(clean)) return;
    const prev = await readPushedShas(sessionId);
    const shas = [clean, ...prev.filter((x) => x !== clean)].slice(0, PUSHED_SHAS_KEEP);
    await storePut(NS(sessionId), PUSHED_KEY, { shas, at: now.toISOString() });
  } catch { /* the push already happened — remembering it is best-effort */ }
}

export interface UnpushedState {
  count: number;
  /** Short HEAD sha at measure time. */
  headSha: string;
  branch: string | null;
  at: string;
}

const NS = (sessionId: string): string[] => [sessionId, 'git-state'];
const KEY = 'unpushed';
const GIT_TIMEOUT_MS = 15_000;

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout ?? '')));
    } catch { resolve(null); }
  });
}

/**
 * Commits on HEAD that no remote-tracking ref (and no sha this session's
 * git_push published — `pushedShas`, W2-2) contains; null = unmeasurable or
 * no remote to push to. Never throws.
 */
export async function measureUnpushed(worktree: string | null | undefined, now: Date = new Date(), pushedShas: readonly string[] = []): Promise<UnpushedState | null> {
  if (!worktree) return null;
  const remotes = await git(worktree, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes']);
  if (remotes === null || !remotes.trim()) return null;
  // --ignore-missing: a remembered sha that no longer resolves (gc'd, a
  // re-cloned mirror) is skipped instead of failing the whole count.
  const known = pushedShas.filter((x) => SHA_RE.test(String(x ?? '')));
  const [count, head, branch] = await Promise.all([
    git(worktree, ['rev-list', '--count', ...(known.length ? ['--ignore-missing'] : []), 'HEAD', '--not', '--remotes', ...known]),
    git(worktree, ['rev-parse', '--short=8', 'HEAD']),
    git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  const n = Number(String(count ?? '').trim());
  if (count === null || !Number.isFinite(n) || !head) return null;
  const b = String(branch ?? '').trim();
  return { count: Math.max(0, Math.floor(n)), headSha: head.trim(), branch: b && b !== 'HEAD' ? b : null, at: now.toISOString() };
}

export async function readUnpushedStamp(sessionId: string): Promise<UnpushedState | null> {
  try { return await storeGet<UnpushedState>(NS(sessionId), KEY); } catch { return null; }
}

/**
 * Ticket 6d7b379f (2026-10-12): a WELL-FORMED claims block that already
 * declares the stranded commit in typed form (a `commit` entry naming the
 * unpushed sha — the finish_run vocabulary the fence now shares) has made
 * exactly the disclosure the note exists to extract ("say in one line why it
 * stays local"). The run is not re-nagged for a disclosure it already made:
 * the line is suppressed, while the STATUS-CARD STAMP (the machine-readable
 * 'unpushed' state the session card reads) is still written — the commits
 * remain invisible to everyone but the worktree, and the stamp says so.
 *
 * Match discipline: EVERY unpushed sha must be named by a commit entry — a
 * block that names one of two stranded commits still gets the note (partial
 * disclosure is not disclosure). The headSha match rides refNamesSha (7-40
 * hex, prefix either way) — the same match the claims lane itself uses, so
 * the nag's read of the block can never disagree with the lane's. A
 * MALFORMED block never suppresses anything (it verified nothing).
 */
export function claimsBlockDeclaresLocal(o: {
  finalText: string;
  shas: readonly string[];
  parse: (text: string) => ParsedClaimsBlock;
  refNamesSha: (ref: string, sha: string) => boolean;
}): boolean {
  if (!o.finalText || o.shas.length === 0) return false;
  let parsed: ParsedClaimsBlock;
  try {
    parsed = o.parse(o.finalText);
  } catch {
    return false;
  }
  if (!parsed.present || !parsed.claims) return false;
  const commitEntries = parsed.claims.filter((e) => e.type === 'commit');
  if (!commitEntries.length) return false;
  return o.shas.every((sha) => commitEntries.some((e) => o.refNamesSha(e.ref, sha)));
}

/** The ONE harness line (pure). */
export function unpushedNoteLine(u: UnpushedState): string {
  return `⚠ HARNESS NOTE: ${u.count} local commit${u.count === 1 ? '' : 's'}${u.branch ? ` on ${u.branch}` : ''} NOT pushed to origin (HEAD ${u.headSha}) — nobody else can see ${u.count === 1 ? 'it' : 'them'}. Push and open a PR (git_push / open_pull_request), or say in one line why ${u.count === 1 ? 'it stays' : 'they stay'} local; never cite a local sha as landed work.`;
}

/**
 * Measure + stamp + decide. Returns the note line to append, or null. The
 * line fires only when commits are unpushed AND HEAD moved since the last
 * stamp (or there was none) — a steady lane is not re-told every firing.
 * Ticket 6d7b379f: when the final's claims block already declares every
 * unpushed sha in typed form (`commit` entries), the note is suppressed but
 * the state stamp is STILL written.
 */
export async function unpushedCommitsAtRunEnd(o: { sessionId: string; worktree: string | null | undefined; now?: Date; finalText?: string }): Promise<{ line: string | null; state: UnpushedState | null }> {
  if (unpushedCommitsNoteDisabled()) return { line: null, state: null };
  try {
    const pushed = unpushedPushedShasDisabled() ? [] : await readPushedShas(o.sessionId);
    const state = await measureUnpushed(o.worktree, o.now, pushed);
    if (!state) return { line: null, state: null };
    const prev = await readUnpushedStamp(o.sessionId);
    await storePut(NS(o.sessionId), KEY, { ...state }).catch(() => undefined);
    const shouldNote = state.count > 0 && (!prev || prev.headSha !== state.headSha || prev.count !== state.count);
    if (!shouldNote) return { line: null, state };
    // Ticket 6d7b379f: a typed local-commit declaration suppresses the note.
    // Narrow on purpose: the stamp carries only the tip sha, so the check is
    // wired for the SINGLE-commit strand (the incident shape — one banked
    // commit behind a push gate, declared as one `commit` entry naming it).
    // A multi-commit strand still gets the note: naming the tip discloses the
    // tip, and the state cannot verify the ancestors were named too.
    if (state.count === 1 && o.finalText && claimsBlockDeclaresLocal({ finalText: o.finalText, shas: [state.headSha], parse: parseClaimsBlock, refNamesSha })) {
      return { line: null, state };
    }
    return { line: unpushedNoteLine(state), state };
  } catch {
    return { line: null, state: null };
  }
}
