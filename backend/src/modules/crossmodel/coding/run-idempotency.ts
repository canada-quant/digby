/**
 * Idempotent push/PR on resume (audit #8, item 3).
 *
 * A RESUMED run's in-flight tool turn is DISCARDED at the checkpoint rewind
 * (trimToPreModel), so the model legitimately re-issues `git_push` /
 * `open_pull_request` calls whose prior attempt ALREADY executed — the push
 * re-ran and the PR create 422'd ("A pull request already exists"), confusing
 * the model into failure narratives. This module gives the two handlers a
 * receipts-backed pre-check: the run's durable tool receipts (run_tool_receipts
 * — all attempts of one agent_runs row share the runId, run-receipts.service)
 * are THE evidence of what this run already did, so a matching completed
 * receipt lets the handler no-op with an honest '[idempotent skip]' result.
 *
 * SAME-RUN ONLY, and exact-identity matched — never suppress genuinely new work:
 *   - push: the prior ok git_push receipt must name the SAME branch AND the
 *     SAME sha as the current HEAD (new commits move HEAD ⇒ no match ⇒ the
 *     push executes). A receipt without a sha (best-effort capture failed)
 *     never matches.
 *   - PR: the prior ok open_pull_request receipt's PR is re-read from GitHub
 *     and must still have the SAME head branch (an agent that switched to a
 *     new feature branch mid-run gets its new PR). Any read failure ⇒ execute.
 *
 * Everything here is best-effort and FAILS OPEN to execution: chat runs (no
 * agent_runs row), receipt-read errors, and GitHub hiccups all return null —
 * the guard must never block a real push/PR.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { getRunReceipts, getRecentChatReceipts } from './run-receipts.service';
import type { ToolReceipt } from './run-receipts';

/**
 * The agent_runs row currently executing this session, if any. The handler
 * runs INSIDE the run (the executor holds the session run-lock), so the
 * session's single 'running' row IS this run. Chat runs have no row → null.
 */
async function currentRunIdForSession(sessionId: string): Promise<string | null> {
  try {
    const row = await prisma.agentRun.findFirst({
      where: { sessionId, status: 'running' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  } catch {
    return null;
  }
}

/** This run's durable receipts (all attempts — same row), or [] when unavailable. */
async function currentRunReceipts(sessionId: string): Promise<ToolReceipt[]> {
  const runId = await currentRunIdForSession(sessionId);
  if (!runId) return [];
  return getRunReceipts(runId).catch(() => [] as ToolReceipt[]);
}

/**
 * A completed same-run push of EXACTLY this branch+sha, or null. Null on any
 * uncertainty (no run row, no receipts, sha-less receipt) — fail open.
 */
export async function findPriorRunPushReceipt(
  sessionId: string,
  branch: string,
  headSha: string,
): Promise<ToolReceipt | null> {
  try {
    if (!branch || !headSha) return null;
    const receipts = await currentRunReceipts(sessionId);
    return receipts.find(
      (r) => r.ok && r.tool === 'git_push'
        && String(r.ids?.branch ?? '') === branch
        && String(r.ids?.sha ?? '') === headSha,
    ) ?? null;
  } catch {
    return null;
  }
}

/**
 * The LATEST completed same-run open_pull_request receipt carrying a PR number
 * + url, or null. The caller must still verify the head branch via
 * prHeadMatchesReceipt below before skipping.
 */
export async function findPriorRunPrReceipt(sessionId: string): Promise<ToolReceipt | null> {
  try {
    const receipts = await currentRunReceipts(sessionId);
    for (let i = receipts.length - 1; i >= 0; i--) {
      const r = receipts[i];
      if (r.ok && r.tool === 'open_pull_request' && r.ids?.prNumber != null && r.ids?.url) return r;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * audit 2026-10-08 W2-5 (plumbing.md F3): the guard matched a PR that was
 * already MERGED — head.ref survives a merge — and answered "[idempotent skip]
 * … git_push them — they appear on the existing PR", which is false once the
 * PR is merged: all 10 failing open_pull_request receipts in the audit window
 * were this skip, follow-up commits stranded (StAnne dee34c3, crossmodel
 * 3d24debd) and one lane force-pushed around the publish gates. The skip now
 * needs the matched PR to be OPEN and unmerged. Kill switch
 * PR_IDEMPOTENCY_OPEN_ONLY_DISABLED=1 restores the head-only match.
 */
export function prIdempotencyOpenOnlyDisabled(): boolean {
  const v = String(process.env.PR_IDEMPOTENCY_OPEN_ONLY_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

export interface PrReceiptHeadState {
  /** The PR's head.ref is the branch this call would open a PR for. */
  headMatches: boolean;
  /** GitHub's state ('open' | 'closed'). */
  state: string;
  merged: boolean;
}

/**
 * Re-read the receipt's PR from GitHub: does its head match, and is it still
 * open + unmerged? null on ANY failure (bad number, 404, network, no token) —
 * the caller fails open (executes normally; GitHub's own duplicate rejection
 * stays the backstop).
 */
export async function prReceiptHeadState(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  headBranch: string,
): Promise<PrReceiptHeadState | null> {
  try {
    if (!Number.isFinite(prNumber) || !headBranch) return null;
    const axios = (await import('axios')).default;
    const resp = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }, timeout: 10_000 },
    );
    return {
      headMatches: String(resp.data?.head?.ref ?? '') === headBranch,
      state: String(resp.data?.state ?? ''),
      merged: resp.data?.merged === true || !!resp.data?.merged_at,
    };
  } catch (err: any) {
    logger.debug(`run-idempotency: PR #${prNumber} head re-read failed (guard fails open): ${err?.message}`);
    return null;
  }
}

/** Pure: does a re-read PR state justify the idempotent skip? */
export function prStateWarrantsSkip(st: PrReceiptHeadState | null): boolean {
  if (!st || !st.headMatches) return false;
  if (prIdempotencyOpenOnlyDisabled()) return true;
  return st.state === 'open' && !st.merged;
}

/**
 * Re-read the receipt's PR from GitHub and confirm its head branch is the one
 * this call would open a PR for ("same head branch" — the receipt itself
 * doesn't record the head) AND that the PR is still OPEN and unmerged (W2-5).
 * ANY failure returns false ⇒ the handler executes normally and GitHub's own
 * duplicate rejection stays the backstop.
 */
export async function prHeadMatchesReceipt(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  headBranch: string,
): Promise<boolean> {
  return prStateWarrantsSkip(await prReceiptHeadState(token, owner, repo, prNumber, headBranch));
}

/**
 * This CHAT's ok open_pull_request receipts inside `sinceMs` (any run) — the
 * cross-run evidence behind the docs-only-PR and duplicate-PR notices (tt-rd
 * audit 2026-09-27, findings docs-churn-log-1 / -4). Newest first. [] on any
 * failure — both notices are observe-only and fail open.
 */
export async function findRecentChatPrReceipts(sessionId: string, sinceMs: number): Promise<ToolReceipt[]> {
  try {
    // Filter AT THE DB (fixer 2026-09-27, HIGH): the cross-wake reader caps at
    // the 500 newest ok receipts of EVERY tool, and a busy lane mints a
    // run_command receipt per step — that cap reached back only 13–17 h on
    // the audited lanes, so the 7-day duplicate window and the 24-h docs-only
    // window silently saw a fraction of themselves (prod: 125 of chat
    // ddd26be0's 135 PR receipts in 7 d sat beyond the cap; the six re-opens
    // the audit found could never have matched). Note (ticket e225aad8): chat
    // turns' receipts now carry the turn's telemetry id (chat-<uuid>) instead
    // of null — this reader keys on chatId, so the cap math is unchanged.
    const rows = await getRecentChatReceipts(sessionId, sinceMs, { tools: ['open_pull_request'] });
    return rows.filter((r) => r.ok && r.tool === 'open_pull_request').reverse();
  } catch {
    return [];
  }
}
