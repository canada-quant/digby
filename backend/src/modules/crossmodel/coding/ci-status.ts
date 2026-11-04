/**
 * Digby Code — remote CI observation (P5 publish-path remediation, v1#28).
 *
 * Nothing used to observe CI on a pushed sha: a lane would push, declare the
 * work done, and the red-CI email storm (100+) was the only signal. This module
 * gives the harness eyes on GitHub's checks:
 *
 *   - fetchCiStatus(): one bounded query of the GitHub Checks API for a sha —
 *     check-runs first (max CI_CHECKS_CAP), falling back to the legacy commit
 *     status API when a repo uses statuses instead of check runs. Auth is the
 *     session's own GitHub OAuth token (ctx.getGithubToken → github/token-manager
 *     getValidToken — the same credential every publish tool uses).
 *   - observeCiAfterPush(): the ONE bounded post-push poll git_push /
 *     open_pull_request append to their results (wait PUSH_CI_OBSERVE_DELAY_MS,
 *     default 30s, then query once — total ≤45s, never a long-poll). Returns a
 *     "\nCI: pending|success|failure|none …" suffix line.
 *   - emitCiFailed(): fires the `ci_failed` hook event (hooks.service —
 *     registered in HOOK_EVENT_TYPES; deliberately NOT alarm-class: it is a
 *     per-lane work signal, the lane's own hooks subscribe to it) when an
 *     observation sees failure on a sha this session pushed.
 *
 * Gate flip 2026-09-11 (owner: full steam): the post-push poll is OFF by
 * default — 183 blocking 30s waits (~90 min of lane wall-clock) produced
 * 'CI: none' 136 / 'pending' 71 / 'success' 1 / 'failure' 0, because ci.yml
 * runs only on pull_request / push-to-main and PR checks are still pending at
 * 30s; merge safety is independently covered by the G2 ci gate and lanes call
 * the explicit check_ci READ tool (unaffected) when they want a verdict.
 * Opt-in PUSH_CI_OBSERVE_ENABLED=1 restores the poll (the old
 * PUSH_CI_OBSERVE_DISABLED kill-switch is retired).
 */

import logger from '../../../utils/logger';

export interface CiCheckRun {
  name: string;
  status: string;              // queued | in_progress | completed
  conclusion: string | null;   // success | failure | neutral | cancelled | timed_out | action_required | skipped | …
}

export interface CiStatus {
  state: 'pending' | 'success' | 'failure' | 'none';
  checks: CiCheckRun[];
  failing: string[];
  total: number;
}

/** Per-check-run listing bound (result size discipline). */
export const CI_CHECKS_CAP = 20;

/** Conclusions that make the combined state 'failure'. */
const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);

/** Post-push wait before the single CI query (env-overridable for tests). */
export function pushCiObserveDelayMs(): number {
  const v = Number(process.env.PUSH_CI_OBSERVE_DELAY_MS);
  return Number.isFinite(v) && v >= 0 ? v : 30_000;
}

/**
 * ONE bounded read of GitHub CI for a commit. Two GETs max (check-runs, then
 * the legacy status API only when zero check runs exist). Throws on transport/
 * auth errors — callers decide how to degrade honestly.
 */
export async function fetchCiStatus(token: string, owner: string, repo: string, sha: string): Promise<CiStatus> {
  const axios = (await import('axios')).default;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  const resp = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=${CI_CHECKS_CAP}`,
    { headers, timeout: 10_000 },
  );
  const total = Number(resp.data?.total_count ?? 0);
  const runs: any[] = Array.isArray(resp.data?.check_runs) ? resp.data.check_runs : [];
  const checks: CiCheckRun[] = runs.slice(0, CI_CHECKS_CAP).map((r) => ({
    name: String(r?.name ?? 'unnamed check'),
    status: String(r?.status ?? 'unknown'),
    conclusion: r?.conclusion != null ? String(r.conclusion) : null,
  }));

  if (total === 0) {
    // Repos wired to the legacy commit-status API (no check runs at all).
    const st = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/status`,
      { headers, timeout: 10_000 },
    );
    const count = Number(st.data?.total_count ?? 0);
    if (count === 0) return { state: 'none', checks: [], failing: [], total: 0 };
    const state = String(st.data?.state ?? 'pending');
    const failing = (Array.isArray(st.data?.statuses) ? st.data.statuses : [])
      .filter((s: any) => ['failure', 'error'].includes(String(s?.state)))
      .slice(0, CI_CHECKS_CAP)
      .map((s: any) => String(s?.context ?? 'status'));
    return {
      state: state === 'success' ? 'success' : state === 'failure' || state === 'error' ? 'failure' : 'pending',
      checks: [],
      failing,
      total: count,
    };
  }

  const failing = checks.filter((c) => c.conclusion !== null && FAILING_CONCLUSIONS.has(c.conclusion)).map((c) => c.name);
  const anyIncomplete = checks.some((c) => c.status !== 'completed');
  const state: CiStatus['state'] = failing.length ? 'failure' : anyIncomplete ? 'pending' : 'success';
  return { state, checks, failing, total };
}

/** Human/model-readable rendering of one CiStatus (bounded). */
export function renderCiStatus(sha: string, ci: CiStatus): string {
  const head = `CI for ${sha.slice(0, 12)}: ${ci.state.toUpperCase()} (${ci.total} check${ci.total === 1 ? '' : 's'}${ci.total > CI_CHECKS_CAP ? `, showing ${CI_CHECKS_CAP}` : ''})`;
  if (!ci.checks.length && !ci.failing.length) {
    return ci.state === 'none'
      ? `${head} — no CI is configured on this commit (no check runs, no statuses).`
      : head;
  }
  const lines = ci.checks.length
    ? ci.checks.map((c) => `- ${c.name}: ${c.conclusion ?? c.status}`)
    : ci.failing.map((n) => `- ${n}: failure`);
  return `${head}\n${lines.join('\n')}`;
}

/**
 * Fire the ci_failed hook event for this session's chat. Fire-and-forget
 * (dynamic import — the run-executor pattern): CI signalling must never delay
 * or break a tool result.
 *
 * CI-WATCH (2026-10-20, coding/ci-watch.service.ts): `opts.note` appends one
 * context sentence to the summary (the escalation line: who was woken, when),
 * and `opts.extra` rides the payload. The project-scope (project supervisor)
 * row is written only when the lane is NOT live or when `extra.ciWatchEscalation`
 * says the lane-first leg already ran (hooks.service emitHookEvent) — the
 * in-run check_ci / post-push emissions therefore never wake the supervisor
 * while the lane itself is reading the red verdict.
 */
export function emitCiFailed(
  sessionId: string,
  sha: string,
  failing: string[],
  opts?: { note?: string; extra?: Record<string, unknown> },
): void {
  void import('../platform/hooks.service')
    .then((m) => m.emitHookEventSafe(sessionId, 'ci_failed', ciFailedSummary(sha, failing, opts?.note), { ...(opts?.extra ?? {}), sha }))
    .catch(() => {});
}

/** The ci_failed summary line (shared by the fire-and-forget and the awaited emitters). Pure. */
export function ciFailedSummary(sha: string, failing: string[], note?: string): string {
  return `CI FAILED on pushed commit ${sha.slice(0, 12)}: ${failing.length ? failing.join(', ') : 'combined status failure'}. The pushed work is NOT done until CI is green.${note ? ` ${note}` : ''}`;
}

/**
 * CI-WATCH review fix (2026-10-20): the ci-watch escalation's AWAITED twin of
 * emitCiFailed. It returns how many hook rows were written and whether the
 * emission failed (hooks.service emitHookEventCounted), so the cron can
 * release its once-per-sha claim and retry a failed emission, and records
 * 'no_supervisor' (not 'escalated') when no hook heard it. Never throws.
 */
export async function emitCiFailedAwaited(
  sessionId: string,
  sha: string,
  failing: string[],
  opts?: { note?: string; extra?: Record<string, unknown> },
): Promise<{ written: number; error: boolean }> {
  try {
    const m = await import('../platform/hooks.service');
    return await m.emitHookEventCounted(sessionId, 'ci_failed', ciFailedSummary(sha, failing, opts?.note), { ...(opts?.extra ?? {}), sha });
  } catch {
    return { written: 0, error: true };
  }
}

/**
 * The ONE bounded post-push observation (v1#28b): wait, query once, return a
 * result suffix. Never throws; a query failure degrades to an honest
 * "CI: unobserved" line pointing at check_ci. Emits ci_failed on failure (the
 * sha was, by construction, just pushed by this session).
 */
export async function observeCiAfterPush(opts: {
  token: string | null;
  owner: string;
  repo: string;
  sha: string;
  sessionId: string;
}): Promise<string> {
  // Gate flip 2026-09-11 (owner: full steam): default OFF — no in-run sleep,
  // no Checks query, no CI suffix — opt-in PUSH_CI_OBSERVE_ENABLED=1 restores it.
  if (process.env.PUSH_CI_OBSERVE_ENABLED !== '1') return '';
  if (!opts.token || !opts.sha) return '';
  const delay = pushCiObserveDelayMs();
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  try {
    const ci = await fetchCiStatus(opts.token, opts.owner, opts.repo, opts.sha);
    if (ci.state === 'failure') emitCiFailed(opts.sessionId, opts.sha, ci.failing);
    switch (ci.state) {
      case 'none':
        return `\nCI: none — no checks are configured on this commit.`;
      case 'pending':
        return `\nCI: pending (${ci.total} check${ci.total === 1 ? '' : 's'} still running ${delay / 1000}s after the push) — re-check with check_ci before claiming the work is done.`;
      case 'success':
        return `\nCI: success (${ci.total} check${ci.total === 1 ? '' : 's'} green).`;
      case 'failure':
        return `\nCI: failure — ${ci.failing.slice(0, CI_CHECKS_CAP).join(', ') || 'combined status failure'}. The pushed work is NOT done: read the failing checks, fix, and push again (or report the red CI honestly).`;
    }
  } catch (err: any) {
    logger.debug(`ci-status: post-push observation failed (non-fatal): ${err?.message}`);
    return `\nCI: unobserved — the status query failed (${String(err?.message || 'error').slice(0, 120)}); use check_ci to re-check before claiming the work is done.`;
  }
}
