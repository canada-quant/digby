/**
 * Ticket status vocabulary — ONE place for the `user_feature_requests.status`
 * enum (backlog audit T8, 2026-09-28).
 *
 * The column is a plain String, so over time it collected values outside the
 * canonical set: six rows sat in 'resolved' (two April 2026 user tickets, four
 * Sep 2026 agent/watch-session closes). Every writer today writes 'done', but
 * the readers disagreed on what "closed" meant — feedback.service's done-dedup
 * reopen scan and the closure manifest matched 'done' only, while
 * stopped-schedule-alert's CLOSED_TICKET_STATUSES accepted 'resolved' — so a
 * re-filed twin of a 'resolved' ticket filed a fresh row instead of reopening,
 * and the Account → Feedback tab (open / active / done filters) showed the row
 * in NO tab.
 *
 * Contract:
 *   - FEEDBACK_STATUSES is the CANONICAL write set (validation, admin PUTs).
 *   - CLOSED_TICKET_STATUSES is what a READER treats as "work is over" —
 *     canonical 'done' plus every legacy closed spelling.
 *   - normalizeTicketStatus() folds a legacy closed spelling to 'done' on the
 *     READ paths (list/get/user listing) so the UI and the model see one
 *     vocabulary; it never rewrites a row (that is the one-shot backfill,
 *     scripts/framework-audit/backfill-ticket-status-done.js).
 *
 * POST-DEPLOY DONE-BAR EXTENSION (ticket 6665fff6 — b4824553's lifecycle
 * half, 2026-10-17): two NEW canonical statuses join the vocabulary.
 *   - 'deployed_verified' — TERMINAL, work is over, and MORE than done: the
 *     fix not only merged and deployed, its acceptance METRIC was re-measured
 *     post-deploy and passed. Written ONLY by the post-deploy verifier job
 *     (ticket-postdeploy-verifier.service.ts) — the machine close gate refuses
 *     a direct hand-set of it. Reads as closed everywhere.
 *   - 'reopened' — work is OWED: the verifier measured the ticket's acceptance
 *     metric FAILING after its fix deployed (window elapsed). It re-enters the
 *     dispatch drain (OPEN_TICKET_STATUSES includes it) so a fresh lane picks
 *     the class up — this is the "did it actually work in prod" loop that
 *     previously had no owner.
 * A ticket WITHOUT an acceptance metric keeps the plain 'done' bar (merged ∧
 * deployed, proven at close time) — the verifier only owns metric-carrying
 * rows. Both statuses are readable by every existing reader through
 * CLOSED_TICKET_STATUSES / OPEN_TICKET_STATUSES below, so no call site needs
 * a new branch for correctness.
 *
 * Import-free leaf on purpose: the feedback service, the closure manifest,
 * the REST controller and the coding stopped-schedule alert all read it.
 */

export const FEEDBACK_STATUSES = ['open', 'in_progress', 'queued', 'done', 'awaiting_verification', 'deployed_verified', 'reopened'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

// The ticket TYPE vocabulary lives here too (moved from feedback.service.ts —
// ticket 6665fff6, review A8): the acceptance-metric validator refuses typo'd
// params.kind/type/status at filing and must import the vocabulary from an
// import-free leaf, not from feedback.service (whose error-handler chain
// validates env at module load and process.exit(1)s in a Jest worker).
// feedback.service.ts re-exports it, so existing importers are unchanged.
export const FEEDBACK_TYPES = [
  'feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea',
] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** The post-deploy verifier's two terminal/owed writes (6665fff6) — never hand-settable by a lane. */
export const VERIFIER_TICKET_STATUSES = ['deployed_verified', 'reopened'] as const;
export type VerifierTicketStatus = (typeof VERIFIER_TICKET_STATUSES)[number];

/**
 * Statuses a ticket can sit in while its work is still owed (triage / dispatch
 * scans). 'reopened' (the verifier measured the acceptance metric FAILING
 * post-deploy) re-enters the dispatch queue. NOTE: 'awaiting_verification' is
 * deliberately NOT here — the fix lane already ran; the post-deploy verifier
 * owns its next transition, so the drain must never re-dispatch it.
 */
export const OPEN_TICKET_STATUSES = ['open', 'in_progress', 'queued', 'reopened'] as const;

/**
 * Legacy closed spellings seen in the table or written by older paths. None
 * is written today; each reads as 'done'.
 */
export const LEGACY_CLOSED_TICKET_STATUSES = ['resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix'] as const;

/**
 * Every status that means "this ticket's work is over" — canonical first.
 * 'deployed_verified' is the done-bar's terminal state: merged ∧ deployed ∧
 * acceptance metric re-measured passing post-deploy. 'awaiting_verification'
 * is NOT closed (the metric has not ruled).
 */
export const CLOSED_TICKET_STATUSES: ReadonlyArray<string> = ['done', 'deployed_verified', ...LEGACY_CLOSED_TICKET_STATUSES];

/**
 * The closure manifest's closable set (6665fff6): deliberately NARROWER than
 * OPEN_TICKET_STATUSES — a 'reopened' row (the verifier measured the fix
 * failing in prod) must never be re-closed by an old manifest entry: the
 * manifest's own contract is "a reopened ticket is never re-closed by an old
 * entry — a reopen wins forever". 'awaiting_verification' is excluded for the
 * same reason (the verifier owns it).
 */
export const MANIFEST_CLOSABLE_STATUSES = ['open', 'in_progress', 'queued'] as const;

/** Triage sort rank — owed work first (open → in_progress → queued → reopened), then limbo, then closed; unknown last. */
export const STATUS_RANK: Readonly<Record<string, number>> = {
  open: 0,
  in_progress: 1,
  queued: 2,
  reopened: 3,
  awaiting_verification: 4,
  done: 5,
  deployed_verified: 6,
};


export function isCanonicalTicketStatus(status: unknown): status is FeedbackStatus {
  return typeof status === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(status);
}

/** True for 'done' and every legacy closed spelling (case-insensitive, trimmed). */
export function isClosedTicketStatus(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  return CLOSED_TICKET_STATUSES.includes(status.trim().toLowerCase());
}

/**
 * The status a READER should show / branch on: a legacy closed spelling
 * becomes 'done'; canonical and unknown values pass through unchanged.
 */
export function normalizeTicketStatus(status: string | null | undefined): string {
  const raw = String(status ?? '');
  const key = raw.trim().toLowerCase();
  // Only a LEGACY spelling folds to 'done' — the canonical 'deployed_verified'
  // (6665fff6) is NOT folded: read paths must keep the terminal distinction
  // (done = merged ∧ deployed; deployed_verified = … ∧ acceptance metric
  // re-measured passing) for the UI, the board and list_feedback.
  if (key !== 'done' && (LEGACY_CLOSED_TICKET_STATUSES as readonly string[]).includes(key)) return 'done';
  return raw;
}

/**
 * The `status IN (...)` list a "closed rows" query should use: 'done' plus the
 * legacy spellings.
 */
export function closedTicketStatusesForQuery(): string[] {
  return [...CLOSED_TICKET_STATUSES];
}

/** Rank for the explicit open-first sort; a legacy closed spelling ranks with 'done'. */
export function ticketStatusRank(status: string | null | undefined): number {
  const key = normalizeTicketStatus(status);
  return STATUS_RANK[key] ?? FEEDBACK_STATUSES.length; // unknown → last
}
