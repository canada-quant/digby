/**
 * Durable on-disk copy of a DELEGATED WORKER's report (ticket 95210e7e).
 *
 * Evidence (prod 2026-11-05, a coding lane): a deploy restarted the server
 * mid-turn while a FOREGROUND `delegate({role:'reviewer'})` had already run to
 * COMPLETION. The regenerated turn's `[COMPLETED DELEGATIONS THIS RUN]` note
 * listed the worker as completed but carried only a 200-character head of its
 * verdict ("The selector fix itself is real, landed, and correct — ... But the
 * second half…"), and warned that its tool results were not in the transcript.
 * The verdict — an independent adversarial review, whose whole value is the
 * findings in its SECOND half — was unrecoverable:
 *
 *   · `.digby/session/worker-reports/` held no file for it, because the write
 *     existed only on the OVER-CAP path (report > REPORT_CLIP cap, 12,000
 *     chars): a normal 4–8k verdict was never written at all;
 *   · session memory holds a worker's TOOL OUTPUTS, never its final text;
 *   · `delegate_status` covers BACKGROUND handles only — a foreground worker
 *     has no handle to poll, and the resumed run legitimately reports "no
 *     background workers were started".
 *
 * So the ONLY durable artefact of a completed delegation was a head fragment.
 * The reporter had to re-derive the review by hand against the live system.
 *
 * Now: EVERY completed worker report is written to the worktree's git-ignored
 * scratch (`.digby/session/worker-reports/<ts>-<role>-<n>.md`) at COMPLETION
 * time — before the dispatch checkpoint that can survive the turn — whether or
 * not it also needs the clip tail. The worktree survives a process restart, a
 * redeploy and a session-container replacement (it is the same premise the
 * `.digby/session/todo.md` lifeboat rests on), so the report cannot be orphaned
 * by anything short of losing the worktree itself. The completed-delegations
 * note (delegation.ts) names this path, so a resumed turn can read the whole
 * report instead of guessing at its first sentence.
 *
 * The write is BEST-EFFORT by contract: persistence must never break a run, so
 * a filesystem failure returns null and the caller falls back to the in-memory
 * summary (which at least says the rest was not persisted).
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Worktree-relative directory every worker report is spilled to. Git-ignored scratch. */
export const WORKER_REPORT_DIR = '.digby/session/worker-reports';

/**
 * The worktree-relative path for one worker report.
 * `<ISO ts with ':'/'.' → '-'>-<role>-<ordinal>-<rand>.md`.
 *
 * The 6-hex random suffix is load-bearing (ticket 95210e7e review finding 2),
 * not decoration: `delegate_parallel` prepares every task before awaiting any,
 * so same-role workers in one batch share a millisecond, and the ordinal alone
 * was not enough to keep them apart. Two reports colliding on one path meant
 * the second write SILENTLY overwrote the first while the resume note still
 * pointed at the (now wrong) survivor — worse than the bug being fixed,
 * because it looks like success. Concretely: a report is a delegation's
 * verdict, and a lost verdict is exactly what this ticket exists to prevent.
 */
export function workerReportRelPath(role: string, ordinal: number, now: Date = new Date(), rand?: string): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  const safeRole = String(role || 'worker').replace(/[^a-zA-Z0-9_-]/g, '-');
  const suffix = rand ?? crypto.randomBytes(3).toString('hex');
  return `${WORKER_REPORT_DIR}/${ts}-${safeRole}-${ordinal}-${suffix}.md`;
}

/**
 * Read a persisted worker report back (ticket d7e82531).
 *
 * The delegate seam returns the worker's CLIPPED summary (`buildWorkerSummary`),
 * so a consumer that needs the WHOLE verdict — the harness's independent-review
 * injection — must read the durable copy instead of reasoning about the clipped
 * text. Returns the report body with the writer's `# <title> (<role> worker
 * report)` header stripped, or null when the file is missing/unreadable/empty.
 * Never throws: the caller falls back to the in-memory summary.
 */
export async function readWorkerReport(worktree: string, relPath: string): Promise<string | null> {
  const rel = String(relPath ?? '').trim();
  if (!worktree || !rel) return null;
  try {
    const raw = await fs.readFile(path.join(worktree, rel), 'utf8');
    // Strip the single header line the writer prepends.
    const body = raw.replace(/^#[^\n]*\((?:\w+) worker report\)\n+/, '');
    const trimmed = body.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null; // best-effort: the caller keeps the in-memory summary
  }
}

export interface PersistWorkerReportInput {
  /** The session worktree (absolute). */
  worktree: string;
  role: string;
  title?: string;
  /** This delegation's 1-based ordinal in the run — keeps two same-role reports apart. */
  ordinal: number;
  /** The worker's FINAL text, unclipped. */
  report: string;
  now?: Date;
  /** Injected for tests; production passes nothing and gets 3 random bytes. */
  rand?: string;
}

/**
 * Write one completed worker's report to the durable scratch dir.
 * Returns the worktree-RELATIVE path (what the note and the clip tail quote),
 * or null when there is nothing to write or the write failed. Never throws.
 */
export async function persistWorkerReport(input: PersistWorkerReportInput): Promise<string | null> {
  const report = String(input.report ?? '');
  if (!report.trim()) return null;
  if (!input.worktree) return null;
  try {
    const rel = workerReportRelPath(input.role, input.ordinal, input.now, input.rand);
    const absDir = path.join(input.worktree, WORKER_REPORT_DIR);
    await fs.mkdir(absDir, { recursive: true });
    // SELF-IGNORE (ticket 95210e7e review finding 3): `.digby/session/` is
    // excluded only by the per-checkout `.git/info/exclude` written at
    // provisioning, NOT by the COMMITTED .gitignore — so a fresh clone running
    // this writer would stage worker reports and dirty the tree. Write the same
    // `*` marker plan.service.ts / attachments.service.ts use, so the guarantee
    // travels with the code instead of with one checkout's provisioning.
    await fs.writeFile(path.join(absDir, '.gitignore'), '*\n', 'utf8').catch(() => { /* best-effort */ });
    await fs.writeFile(
      path.join(input.worktree, rel),
      `# ${input.title || input.role} (${input.role} worker report)\n\n${report}\n`,
      'utf8',
    );
    return rel;
  } catch {
    return null; // best-effort: the run continues on the in-memory summary
  }
}