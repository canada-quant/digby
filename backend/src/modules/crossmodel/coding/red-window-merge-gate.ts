/**
 * G2.5 red-window MERGE-TIME gate (feedback ticket 2bccefe0, 2026-10-18) —
 * the merge-time FRESH verdict the PR-head guard check cannot provide.
 *
 * THE GAP THIS CLOSES (PR #1754, the 2026-10-18 15:11–15:37Z window): the
 * red-window guard (scripts/deploy/red-window-guard.sh via
 * .github/workflows/red-window-guard.yml) mints its verdict on the PR HEAD
 * at push time, and the platform's merge gate (G2) reads only the check-run
 * CONCLUSION — so a merge can land inside an open red window by riding a
 * verdict minted BEFORE the window opened: #1754 merged 15:16:54Z carrying
 * a guard SUCCESS minted 15:07:18Z (run 39139038689) while main's deploy
 * run 39139333344 had already concluded failure at 15:16:04Z — 50 seconds
 * of observable red a fresh read would have caught. The guard workflow
 * itself ARMED CORRECTLY and HELD for every merge whose verdict was minted
 * inside the window (docs lane 881326a8 was blocked 15:24:46Z).
 *
 * This leaf classifies main's window state from a LIVE Actions snapshot at
 * MERGE time — the same single-source rule the script's jq implements:
 *   - ANY deploy.yml run on the target branch still ACTIVE (queued /
 *     in_progress / pending-hole) → UNPROVEN → fail-open (blocking an
 *     in-flight deploy would deadlock the queue behind every ~30-min wave);
 *   - else the NEWEST COMPLETED run by CONCLUSION time (updated_at — a
 *     long-running older run can conclude after a newer one); conclusion
 *     'failure' → RED (the window); anything else (success / cancelled —
 *     cancelled = a coalesced wave, the newer run carries the commit — /
 *     timed_out) → CLEAN;
 *   - no completed runs at all → CLEAN (fresh repo).
 *
 * PARITY CONTRACT: the selection rule mirrors scripts/deploy/red-window-guard.sh
 * VERBATIM (one unfiltered `actions/runs?per_page=100` snapshot, client-side
 * path+branch filter, newest-completed-by-updated_at). The parity pin
 * (red-window-merge-gate.2bccefe0.test.ts) reads the SHIPPED script and
 * fails when its jq decision arms change, so this mirror cannot drift
 * silently — edit the script and this leaf together.
 *
 * The gate itself (I/O, labels, base-branch scope, refusal shape) lives in
 * self-merge.service.ts G2.5 — this file is pure helpers only, same shape
 * as detector-change-guard.ts. Kill switch: RED_WINDOW_MERGE_GATE_DISABLED=1.
 */

/** The deploy workflow the window watches (same path the script pins). */
export const DEPLOY_WORKFLOW_PATH = '.github/workflows/deploy.yml';

/** The PR label that lawfully overrides a red window (deploy-repair PRs). */
export const DEPLOY_FIX_LABEL = 'deploy-fix';

export function redWindowMergeGateDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.RED_WINDOW_MERGE_GATE_DISABLED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/** A deploy.yml run row from the Actions list-runs snapshot (the fields the
 *  script's jq reads; extra API fields are ignored). */
export interface RedWindowRun {
  id?: number | string | null;
  status?: string | null;
  conclusion?: string | null;
  head_sha?: string | null;
  head_branch?: string | null;
  path?: string | null;
  updated_at?: string | null;
}

export type RedWindowState = 'red' | 'clean' | 'unproven';

export interface RedWindowVerdict {
  state: RedWindowState;
  /** The newest completed run the verdict rests on (absent on a fresh repo). */
  runId?: string;
  runSha?: string;
  conclusion?: string;
  concludedAt?: string;
}

/**
 * Classify the red-window state of a branch from ONE unfiltered Actions
 * snapshot — the jq selection rule of red-window-guard.sh, mirrored. Pure.
 *
 * @param runs  every workflow run row the snapshot returned (all workflows,
 *              all branches — the filter is applied here, exactly like the
 *              script's `map(select(.path == $dpath and .head_branch == …))`).
 * @param branchRef the branch whose deploy signal is the window (the PR's
 *        base ref — 'main' for this repo; the script hard-codes main because
 *        it ships in this repo).
 */
export function classifyRedWindow(runs: RedWindowRun[], branchRef: string): RedWindowVerdict {
  const onBranch: RedWindowRun[] = (Array.isArray(runs) ? runs : []).filter(
    (r) => String(r?.path ?? '') === DEPLOY_WORKFLOW_PATH && String(r?.head_branch ?? '') === String(branchRef ?? ''),
  );
  // ANY active run shadows everything older — the window is UNPROVEN, not
  // red (and blocking an in-flight deploy would deadlock the queue).
  if (onBranch.some((r) => String(r?.status ?? '') !== 'completed')) {
    return { state: 'unproven' };
  }
  // Newest COMPLETED by CONCLUSION time (updated_at): a long-running older
  // run can conclude after a newer one, and the jq's sort_by is the same
  // lexicographic ISO-8601 Z-suffix sort reproduced here.
  const completed = onBranch
    .filter((r) => String(r?.status ?? '') === 'completed')
    .sort((a, b) => String(b?.updated_at ?? '').localeCompare(String(a?.updated_at ?? '')));
  const newest = completed[0];
  if (!newest) return { state: 'clean' };
  const base: RedWindowVerdict = {
    state: 'clean',
    runId: newest.id != null ? String(newest.id) : undefined,
    runSha: newest.head_sha ? String(newest.head_sha).slice(0, 8) : undefined,
    conclusion: newest.conclusion ? String(newest.conclusion) : undefined,
    concludedAt: newest.updated_at ? String(newest.updated_at) : undefined,
  };
  if (String(newest.conclusion ?? '') === 'failure') return { ...base, state: 'red' };
  return base;
}
