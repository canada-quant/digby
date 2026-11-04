/**
 * Session diff — ONE implementation for the REST changes view
 * (GET /coding/sessions/:id/diff) and the get_session_diff platform tool
 * (capability gap audit T4b #30, 2026-09-24).
 *
 * The worktree lives on box C only. On the box that hosts it the two git
 * reads run locally; on a web box the request rides the same Redis
 * request/reply channel the Files tab uses (worktree-remote-read.ts, op
 * 'diff'). Before this the REST handler swallowed the missing-directory error
 * on A/B and answered an EMPTY diff indistinguishable from a clean tree.
 */
import * as fs from 'fs/promises';
import { getSessionForUser } from './coding-data.service';
import { worktreePath, git } from './workspace.service';
import { requestRemoteWorktreeDiff } from './worktree-remote-read';

export interface SessionDiff {
  branch: string | null;
  status: string;
  diffStat: string;
  /** 'error' (audit 2026-10-06 T5-6): a git read FAILED — never a clean tree. */
  source: 'disk' | 'remote' | 'unavailable' | 'error';
  /** The failing git read's message (credential-scrubbed by workspace.service git()). */
  error?: string;
  /** HEAD commit sha of the worktree, when readable. */
  head?: string | null;
  /** The upstream ref compared against (the branch's @{u}, else origin/<branch>); null = the branch is not on origin. */
  upstream?: string | null;
  /** Commits on HEAD not on the upstream (unpushed) / on the upstream not on HEAD. */
  ahead?: number | null;
  behind?: number | null;
}

/** The worktree diff read: the two git reads + (T5-6) HEAD / upstream / ahead-behind, or the read error. */
export interface WorktreeDiffRead {
  status: string;
  diffStat: string;
  error?: string;
  head?: string | null;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
}

/**
 * audit 2026-10-06 T5-6 (litellm F3): both reads used to `.catch(() =>
 * ({ stdout: '' }))`, so a FAILED git read (safe.directory / ownership against
 * the sandbox uid, a snapshot dir without git metadata) rendered as "Worktree
 * clean" — a supervisor then told the owner an uncommitted edit was a verified
 * commit for 3.5 h. A failure is now an error state carrying git's message,
 * and the read adds HEAD + ahead/behind the upstream so committed / pushed /
 * uncommitted are explicit. Kill switch SESSION_DIFF_ERROR_STATE_DISABLED=1
 * restores the swallow-to-empty read byte-for-byte.
 */
export function sessionDiffErrorStateDisabled(): boolean {
  return process.env.SESSION_DIFF_ERROR_STATE_DISABLED === '1';
}

const gitErrorText = (err: any): string =>
  String(err?.stderr || err?.message || err || 'git failed').replace(/\s+/g, ' ').trim().slice(0, 300);

/** The two git reads the changes view shows, for a worktree root on THIS box. */
export async function readWorktreeDiff(root: string): Promise<WorktreeDiffRead> {
  if (sessionDiffErrorStateDisabled()) {
    const status = await git(['status', '--porcelain=v1'], root).catch(() => ({ stdout: '' }));
    const diffStat = await git(['diff', '--stat'], root).catch(() => ({ stdout: '' }));
    return { status: status.stdout, diffStat: diffStat.stdout };
  }
  let error: string | undefined;
  const status = await git(['status', '--porcelain=v1'], root).catch((err: any) => { error = `git status: ${gitErrorText(err)}`; return null; });
  const diffStat = await git(['diff', '--stat'], root).catch((err: any) => { error ??= `git diff --stat: ${gitErrorText(err)}`; return null; });
  if (error || !status || !diffStat) return { status: '', diffStat: '', error: error ?? 'git read failed' };
  // HEAD + upstream are best-effort context: a missing upstream is a fact
  // (never pushed), not an error.
  const head = (await git(['rev-parse', 'HEAD'], root).catch(() => null))?.stdout?.trim() || null;
  let upstream: string | null = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root).catch(() => null))?.stdout?.trim() || null;
  if (!upstream) {
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root).catch(() => null))?.stdout?.trim();
    if (branch && branch !== 'HEAD') {
      const remote = await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], root).catch(() => null);
      if (remote?.stdout?.trim()) upstream = `origin/${branch}`;
    }
  }
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream && head) {
    const counts = (await git(['rev-list', '--left-right', '--count', `HEAD...${upstream}`], root).catch(() => null))?.stdout?.trim();
    const m = counts ? /^(\d+)\s+(\d+)$/.exec(counts) : null;
    if (m) { ahead = Number(m[1]); behind = Number(m[2]); }
  }
  return { status: status.stdout, diffStat: diffStat.stdout, head, upstream, ahead, behind };
}

/** The extra T5-6 fields of a read, for spreading onto a SessionDiff (omitted when absent). */
function diffContext(d: Partial<WorktreeDiffRead>): Partial<SessionDiff> {
  const out: Partial<SessionDiff> = {};
  if (d.head !== undefined) out.head = d.head;
  if (d.upstream !== undefined) out.upstream = d.upstream;
  if (d.ahead !== undefined) out.ahead = d.ahead;
  if (d.behind !== undefined) out.behind = d.behind;
  return out;
}

/** Owner or project member ('read'); null when the session is unknown / not readable / not provisioned. */
export async function sessionDiffForUser(sessionId: string, userId: string): Promise<SessionDiff | null> {
  const session = await getSessionForUser(sessionId, userId, 'read');
  if (!session || !session.worktreePath) return null;
  const root = worktreePath(session.id);
  const st = await fs.stat(root).catch(() => null);
  if (st && st.isDirectory()) {
    const d = await readWorktreeDiff(root);
    if (d.error) return { branch: session.branch ?? null, status: '', diffStat: '', source: 'error', error: d.error };
    if (sessionDiffErrorStateDisabled()) return { branch: session.branch ?? null, ...d, source: 'disk' };
    return { branch: session.branch ?? null, status: d.status, diffStat: d.diffStat, source: 'disk', ...diffContext(d) };
  }
  const remote = await requestRemoteWorktreeDiff(session.id);
  // The reply union now also carries op 'raw' (ticket 19fbd876) — a diff
  // request can never yield that shape, but TS needs the narrowing.
  if (remote && remote.ok && 'diff' in remote && remote.diff) {
    const rd = remote.diff as WorktreeDiffRead;
    if (rd.error && !sessionDiffErrorStateDisabled()) return { branch: session.branch ?? null, status: '', diffStat: '', source: 'error', error: rd.error };
    if (sessionDiffErrorStateDisabled()) return { branch: session.branch ?? null, status: remote.diff.status, diffStat: remote.diff.diffStat, source: 'remote' };
    return { branch: session.branch ?? null, status: rd.status, diffStat: rd.diffStat, source: 'remote', ...diffContext(rd) };
  }
  return { branch: session.branch ?? null, status: '', diffStat: '', source: 'unavailable' };
}
