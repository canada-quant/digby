/**
 * Ticket queue ordering + dependency gating (ticket 9dacab1a, 2026-10-17
 * overnight-stall remediation batch) — the drain-time SCORING layer.
 *
 * Before this leaf the dispatch queue was a STATIC priority queue
 * (`orderBy priority desc, createdAt asc`, top FRESH_SCAN=60 rows): every
 * ticket lands at the default priority 0, so the queue was effectively FIFO
 * — with no re-ranking as fixes land, no signal that one fix UNBLOCKS
 * several others, and no path for an old low-priority row ever to rise (a
 * low-priority ticket older than the newest 60 higher-priority rows never
 * entered the scan at all: the FETCH itself was priority-first, the exact
 * "static/starving" shape the ticket names).
 *
 * This module is a PURE LEAF (import-free by design — the ticket-status /
 * lane-home family discipline): every export is a pure function over the
 * ticket row shape the drains already hold, so the drain keeps its TOTAL
 * (never throws) contract and the tests pin ordering without Prisma mocks.
 *
 * Scoring model (deliberately linear and cheap — one integer per row):
 *
 *   score = 15 × priority            the operator's explicit intent — one
 *                                    priority raise (15) outweighs ALL the
 *                                    accrual a row can pick up on its own
 *                                    (max 14, below); only the multi-unblock
 *                                    LEVERAGE term may cross a band, and at
 *                                    most one (documented below)
 *        + min(occurrences, 8)       recurrence: the filers bump context
 *                                    .occurrences per incident — a ticket
 *                                    the fleet keeps hitting is higher
 *                                    leverage than a one-off
 *        + agePoints                starvation relief: 1 point per AGE_POINT
 *                                    days, capped at AGE_POINTS_CAP (3) so
 *                                    accrual can lift an old default-
 *                                    priority row above NEW work in its band
 *                                    but never above a priority raise
 *        + (reopened ? REOPEN_BONUS : 0)
 *                                    post-deploy-reopened (verifier wrote
 *                                    'reopened' / context.verification
 *                                    .lastVerdict === 'reopened'): a fix
 *                                    that shipped and did NOT hold is the
 *                                    strongest owed-work signal there is
 *        + 2 × min(unblockCount, 3)  how many OTHER dispatchable tickets
 *                                    name this one in dependsOnTicketIds —
 *                                    one lane fixing this ticket releases
 *                                    its whole dependent chain, so a
 *                                    multi-unblock row jumps the queue
 *
 * Max SELF-accrual (8 + 3 + 3) = 14 < 15: no stack of row-local accrual
 * outranks even one priority raise — operator intent is sacred. Max total
 * (14 + 6) = 20 < 30 (two raises): only the LEVERAGE term can cross a band,
 * at most one — a P0 that unblocks three waiting rows edges past a fresh P1
 * (20 > 16) but never past a P2 (31). Within a band, an old starved row
 * rises above fresh work — exactly what the static queue never did.
 *
 * Dependencies (the todo pattern, mirrored for tickets):
 * `context.dependsOnTicketIds` is a plain array of ticket ids a lane or an
 * admin set; a ticket with an OPEN blocker WAITS (never dispatches, never
 * takes a slot) and the note explains why; the blocker closing (done, or a
 * legacy closed spelling, or deployed_verified) is the auto-unblock — the
 * next drain sees no open blocker and dispatches normally. A blocker that
 * does not exist / is unknown is treated as UNBLOCKED (an admin typo must
 * not wedge a ticket forever — the todo pattern's 404 fires at WRITE time;
 * this is the read-time backstop). Cycles are refused at write time
 * (setTicketDependencies); at read time a cycle would just mean both rows
 * wait — no infinite loop, the drain visits each row once.
 */

/** Age accrual: one point per AGE_POINT_DAYS days old, capped. */
export const AGE_POINT_DAYS = 7;
/** The cap on age points (a 90-day-old ticket earns the same as a 2-year-old one). */
export const AGE_POINTS_CAP = 3;
/** Points for a post-deploy-reopened row (verifier-owned 'reopened' status). */
export const REOPEN_BONUS = 3;
/** Points per unblocked dependent ticket (this row unblocks N others), capped. */
export const UNBLOCK_POINTS_EACH = 2;
/** The cap on the unblock leverage term (max +6 — may cross at most one priority band). */
export const UNBLOCK_COUNT_CAP = 3;
/** The occurrences accrual cap. */
export const OCCURRENCES_CAP = 8;
/** The occurrences read defaults to 1 (a row with no bumps is a single incident). */
export const OCCURRENCES_DEFAULT = 1;
/** The priority weight: one raise (15) outweighs all row-local accrual (max 14). */
export const PRIORITY_WEIGHT = 15;

/** Kill switch (9dacab1a): '1' restores the pre-fix static queue order —
 *  priority desc, createdAt asc — byte-for-byte (dependencies still gate;
 *  only the RANKING reverts). Read at CALL time. */
export function dispatchScoringDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TICKET_DISPATCH_SCORING_DISABLED === '1';
}

/** A row in the shape the drains already scan — enough to score, no Prisma types. */
export interface ScorableTicketRow {
  id: string;
  priority?: number | null;
  status?: string | null;
  createdAt?: Date | string | null;
  context?: unknown;
}

/** Read a ticket's context as a plain object (null-safe, same idiom as ctxOf). */
export function ticketCtxOf(t: { context?: unknown }): Record<string, unknown> {
  return (t.context ?? {}) as Record<string, unknown>;
}

/** The dependency id list on a ticket's context — normalized (trimmed,
 *  non-empty strings, de-duplicated, self-references dropped). Exported for
 *  the write-side validator and the drain alike. */
export function ticketDependsOnIds(t: { id?: string; context?: unknown }): string[] {
  const raw = ticketCtxOf(t).dependsOnTicketIds;
  if (!Array.isArray(raw)) return [];
  const selfId = typeof t.id === 'string' ? t.id : '';
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const id = v.trim();
    if (!id || (selfId && id === selfId) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** True when the row's status reads as work-over (canonical + legacy closed
 *  spellings — 'done', 'deployed_verified', 'resolved', 'closed',
 *  'archived', 'rejected', 'duplicate', 'wontfix'). Kept LOCAL to this leaf
 *  so it stays import-free (ticket-status.ts holds the canonical list; this
 *  is the read-time mirror of the same vocabulary). */
export function isClosedTicketRow(t: { status?: string | null }): boolean {
  const s = typeof t.status === 'string' ? t.status.trim().toLowerCase() : '';
  if (!s) return false;
  return ['done', 'deployed_verified', 'resolved', 'closed', 'archived', 'rejected', 'duplicate', 'wontfix'].includes(s);
}

/** A ticket whose fix shipped and did NOT hold — the strongest owed-work
 *  signal: the post-deploy verifier wrote status 'reopened' (its own write,
 *  6665fff6) or stamped context.verification.lastVerdict === 'reopened'. */
export function isPostDeployReopened(t: { status?: string | null; context?: unknown }): boolean {
  if (typeof t.status === 'string' && t.status.trim().toLowerCase() === 'reopened') return true;
  const ver = ticketCtxOf(t).verification;
  if (ver && typeof ver === 'object') {
    const verdict = (ver as Record<string, unknown>).lastVerdict;
    if (typeof verdict === 'string' && verdict.trim().toLowerCase() === 'reopened') return true;
  }
  return false;
}

/** Age points for a row: one per AGE_POINT_DAYS of queue age, capped. A
 *  malformed/missing createdAt earns 0 (a data glitch must never invent
 *  priority). */
export function ticketAgePoints(createdAt: Date | string | null | undefined, now: number = Date.now()): number {
  const t = createdAt instanceof Date ? createdAt.getTime()
    : typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(t)) return 0;
  const days = Math.max(0, now - t) / (24 * 3600_000);
  return Math.min(AGE_POINTS_CAP, Math.floor(days / AGE_POINT_DAYS));
}

/** The occurrences a row has accrued (filers bump context.occurrences per
 *  incident; a row with none is a single incident — OCCURRENCES_DEFAULT). */
export function ticketOccurrences(t: { context?: unknown }): number {
  const n = ticketCtxOf(t).occurrences;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : OCCURRENCES_DEFAULT;
}

/** How many OTHER dispatchable rows name this ticket in their
 *  dependsOnTicketIds — the multi-unblock leverage term. `rows` is the full
 *  drain scan (any ScorableTicketRow[]); a dependent that is itself closed
 *  or already dispatched does not count (its unblock already happened or is
 *  moot). */
export function ticketUnblockCount(id: string, rows: ReadonlyArray<ScorableTicketRow>): number {
  let n = 0;
  for (const r of rows) {
    if (r.id === id) continue;
    if (isClosedTicketRow(r)) continue;
    if (ticketDependsOnIds(r).includes(id)) n++;
  }
  return n;
}

/** The drain-time score for one row — exported for tests and telemetry.
 *  `unblockCount` is precomputed by the caller (the drain builds the reverse
 *  index once per scan, not per row). Pure; never throws. */
export function scoreTicketRow(
  t: ScorableTicketRow,
  opts: { unblockCount?: number; now?: number; scoringDisabled?: boolean } = {},
): number {
  const unblockCount = Math.min(UNBLOCK_COUNT_CAP, Math.max(0, Math.floor(opts.unblockCount ?? 0)));
  if (opts.scoringDisabled ?? dispatchScoringDisabled()) {
    // Kill switch: the score degenerates to the STATIC queue key — a pure
    // `priority * PRIORITY_WEIGHT` keeps number ordering IDENTICAL to
    // orderBy priority desc, createdAt asc when the sort below breaks ties
    // by createdAt asc (the drain applies that tie-break in the comparator).
    return (typeof t.priority === 'number' && Number.isFinite(t.priority) ? t.priority : 0) * PRIORITY_WEIGHT;
  }
  const now = opts.now ?? Date.now();
  const priority = typeof t.priority === 'number' && Number.isFinite(t.priority) ? t.priority : 0;
  const occurrences = Math.min(OCCURRENCES_CAP, ticketOccurrences(t));
  const age = ticketAgePoints(t.createdAt, now);
  const reopened = isPostDeployReopened(t) ? REOPEN_BONUS : 0;
  return priority * PRIORITY_WEIGHT + occurrences + age + reopened + unblockCount * UNBLOCK_POINTS_EACH;
}

/**
 * Sort a drain scan by score desc, createdAt asc (FIFO within a score — the
 * static queue's deterministic tie-break, preserved). PURE: returns a NEW
 * array, never mutates the input (the drain's eligibility loop reads rows in
 * scan order elsewhere; the sort only decides WHICH rows claim free slots
 * first). With the kill switch on this is exactly the pre-fix order
 * (priority desc, createdAt asc) — the byte-for-byte revert.
 */
export function sortTicketsByScore(
  rows: ReadonlyArray<ScorableTicketRow>,
  opts: { now?: number; scoringDisabled?: boolean } = {},
): ScorableTicketRow[] {
  const now = opts.now ?? Date.now();
  const unblockCounts = new Map<string, number>();
  const disabled = opts.scoringDisabled ?? dispatchScoringDisabled();
  if (!disabled) {
    for (const r of rows) unblockCounts.set(r.id, ticketUnblockCount(r.id, rows));
  }
  const scored = rows.map((r) => ({
    r,
    s: scoreTicketRow(r, { unblockCount: unblockCounts.get(r.id) ?? 0, now, scoringDisabled: disabled }),
  }));
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    const at = a.r.createdAt instanceof Date ? a.r.createdAt.getTime() : typeof a.r.createdAt === 'string' ? Date.parse(a.r.createdAt) : 0;
    const bt = b.r.createdAt instanceof Date ? b.r.createdAt.getTime() : typeof b.r.createdAt === 'string' ? Date.parse(b.r.createdAt) : 0;
    return at - bt;
  });
  return scored.map((x) => x.r);
}

// ── Dependency gating (the read side) ────────────────────────────────────────

export interface OpenDependencyBlocker {
  /** The blocker's id (first 8 chars render in notes). */
  id: string;
  title?: string | null;
  status?: string | null;
}

/**
 * Which of a ticket's blockers are still OPEN. A blocker that is closed
 * (canonical or legacy spelling) no longer gates. A blocker id that matches
 * NO scanned row is treated as UNBLOCKED — an admin typo or a deleted row
 * must not wedge the dependent forever (the write path validates existence;
 * this is the read-time backstop, mirroring the todo pattern's fail-open
 * direction for missing rows). `rows` is the drain scan to resolve against
 * (the drains scan the same open set the blocker would be in — a closed
 * blocker is ALSO unblocked by the closedRows argument below).
 */
export function openDependencyBlockers(
  t: { id: string; context?: unknown },
  rowsById: ReadonlyMap<string, ScorableTicketRow>,
): OpenDependencyBlocker[] {
  const out: OpenDependencyBlocker[] = [];
  for (const depId of ticketDependsOnIds(t)) {
    const blocker = rowsById.get(depId);
    if (blocker && !isClosedTicketRow(blocker)) {
      const title = (blocker as { title?: unknown }).title;
      out.push({ id: blocker.id, title: typeof title === 'string' ? title : null, status: blocker.status ?? null });
    }
  }
  return out;
}

/** The dispatcher note when a ticket WAITS on blockers (registered shape —
 *  DISPATCHER_NOTE_RE owns "Waiting on ticket dependencies" so later drains
 *  keep rewriting it as blockers close). */
export const DEPENDENCY_WAIT_NOTE_PREFIX = 'Waiting on ticket dependencies';

export function dependencyWaitNote(blockers: ReadonlyArray<OpenDependencyBlocker>, unblockedAtIso?: string): string {
  const ids = blockers.map((b) => b.id.slice(0, 8)).join(', ');
  const unblockLine = unblockedAtIso
    ? ` — all blockers closed at ${unblockedAtIso}; it dispatches on this drain.`
    : '.';
  return `Waiting on ticket dependencies ${ids} (their fixes must close first; this ticket then dispatches automatically)${unblockLine}`;
}

// ── Dependency write side (validation, shared by admin PATCH + tool) ─────────

export type SetDependenciesResult =
  | { ok: true; dependsOnTicketIds: string[] }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Validate + store a dependency set on a ticket (the write side both the
 * admin PATCH and triage_ticket call). Same contract as the todo pattern's
 * createTodo: self-reference 400, unknown blocker 404, cycle 409 (A already
 * waits on B, B waits on A). `loadTicket(id)` resolves a ticket row or null
 * (exact id OR a unique ≥8-char prefix — the callers route getFeedbackTicket
 * / updateFeedbackTicket, which resolve prefixes); cycle detection walks the
 * existing dependsOnTicketIds graph via loadTicket, so it sees the same rows
 * the drain will. A null/undefined/empty-array input CLEARS the set. Never
 * throws; every refusal names the offending id.
 *
 * F2 (round-1 review): every input id is RESOLVED TO ITS CANONICAL FULL id
 * before anything else — the tool schema advertises "full or ≥8-char prefix"
 * and the drain's blocker index keys on full ids, so storing the raw prefix
 * made the gate never engage (and a self-prefix bypassed the 400, a prefix
 * cycle the 409). Existence, self-check, dedupe, cap and the cycle walk all
 * run on the CANONICAL ids now; the stored set is canonical.
 */
export async function setTicketDependencies(
  ticketId: string,
  dependsOnTicketIds: string[] | null | undefined,
  loadTicket: (id: string) => Promise<ScorableTicketRow | null>,
): Promise<SetDependenciesResult> {
  if (dependsOnTicketIds === null || dependsOnTicketIds === undefined) {
    return { ok: true, dependsOnTicketIds: [] };
  }
  if (!Array.isArray(dependsOnTicketIds)) {
    return { ok: false, status: 400, error: 'dependsOnTicketIds must be an array of ticket ids.' };
  }
  const ticket = await loadTicket(ticketId);
  if (!ticket) return { ok: false, status: 404, error: `Feedback ticket "${ticketId}" not found.` };
  // Resolve + canonicalize: trim, drop empties, resolve each id through
  // loadTicket (404 when it matches no row), self-check + dedupe on the
  // CANONICAL id. The raw input names the offending id in every refusal.
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const v of dependsOnTicketIds) {
    if (typeof v !== 'string') return { ok: false, status: 400, error: 'dependsOnTicketIds must be an array of ticket ids (strings).' };
    const raw = v.trim();
    if (!raw) continue;
    const row = await loadTicket(raw);
    if (!row || !row.id) return { ok: false, status: 404, error: `Dependency ticket "${raw.slice(0, 8)}" not found.` };
    if (row.id === ticket.id) return { ok: false, status: 400, error: `A ticket cannot depend on itself (${ticket.id.slice(0, 8)}).` };
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    canonical.push(row.id);
  }
  if (canonical.length > 20) {
    return { ok: false, status: 400, error: `dependsOnTicketIds is capped at 20 (got ${canonical.length}).` };
  }
  // Cycle: walk the graph the new edges create (BFS from the new blockers,
  // following existing dependsOnTicketIds links; if the walk reaches the
  // ticket being edited, the new set closes a loop). Depth-bounded — a
  // corrupted/oversized graph cannot loop the validator forever.
  const MAX_CYCLE_WALK = 64;
  const visited = new Set<string>();
  const queue = [...canonical];
  let walked = 0;
  while (queue.length && walked < MAX_CYCLE_WALK) {
    const cur = queue.shift()!;
    walked++;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const row = await loadTicket(cur);
    if (!row) continue;
    for (const n of ticketDependsOnIds(row)) {
      if (n === ticket.id) {
        // The graph reaches back to the ticket being edited — a cycle
        // THROUGH the new edges.
        return { ok: false, status: 409, error: `Setting these dependencies would create a cycle: ticket ${cur.slice(0, 8)} already (transitively) depends on ${ticket.id.slice(0, 8)}.` };
      }
      if (!visited.has(n)) queue.push(n);
    }
  }
  return { ok: true, dependsOnTicketIds: canonical };
}
