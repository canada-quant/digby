/**
 * Fleet dashboard helpers (Management → Dashboard tab).
 *
 * Pure derivations behind the Dashboard's Goals board and the Coding Sessions
 * lane enrichment (ticket/PR refs in lane titles, goal bucketing, todo
 * rollups, assignee labels). No imports — the leaf-module idiom, so the
 * vitest node-environment tests can load it bare.
 */

/** Work references extracted from a lane/session title. */
export interface WorkRefs {
  /** GitHub PR refs, normalized "#123" — first-seen order, deduped, max 3. */
  prs: string[];
  /** 8-char lowercase hex id prefixes (feedback tickets, session ids) — max 3. */
  tickets: string[];
}

/** Max refs of each kind surfaced per lane title (badge real estate). */
const WORK_REF_CAP = 3;

/**
 * Pull PR refs (#123) and 8-hex id prefixes (85f8d318) out of a lane title —
 * the supervisor names lanes after the work they're doing ("Fix login #523,
 * ticket 85f8d318"). Deduped, first-seen order, capped at 3 of each kind.
 * Lowercase hex ONLY (an uppercase word is prose, not an id), and exactly 8
 * chars bounded by non-word characters (a 9-char hex run is a hash, not an
 * id prefix).
 */
export function extractWorkRefs(title: string): WorkRefs {
  const prs: string[] = [];
  const prRe = /#(\d{1,6})/g;
  let m: RegExpExecArray | null;
  while ((m = prRe.exec(title)) !== null && prs.length < WORK_REF_CAP) {
    const ref = `#${m[1]}`;
    if (!prs.includes(ref)) prs.push(ref);
  }
  const tickets: string[] = [];
  const ticketRe = /\b[0-9a-f]{8}\b/g;
  while ((m = ticketRe.exec(title)) !== null && tickets.length < WORK_REF_CAP) {
    if (!tickets.includes(m[0])) tickets.push(m[0]);
  }
  return { prs, tickets };
}

/** One goal row as the board needs it (structural — FleetGoal fits). */
export interface GoalBoardRow {
  status: string;
  updatedAt?: string | null;
}

/** updatedAt as ms; absent/unparseable sorts oldest (0). */
function goalTime(g: GoalBoardRow): number {
  if (!g.updatedAt) return 0;
  const t = Date.parse(g.updatedAt);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Split goals into the board's two buckets. live = active|blocked with
 * BLOCKED FIRST (they need the owner's attention), then active, each by
 * updatedAt desc; finished = done|archived by updatedAt desc. Non-mutating
 * (filter/sort operate on copies).
 */
export function goalBoardBuckets<T extends GoalBoardRow>(goals: T[]): { live: T[]; finished: T[] } {
  const byUpdatedDesc = (a: T, b: T) => goalTime(b) - goalTime(a);
  const blocked = goals.filter((g) => g.status === 'blocked').sort(byUpdatedDesc);
  const active = goals.filter((g) => g.status === 'active').sort(byUpdatedDesc);
  const finished = goals
    .filter((g) => g.status === 'done' || g.status === 'archived')
    .sort(byUpdatedDesc);
  return { live: [...blocked, ...active], finished };
}

/** Todo rollup for one goal's row: done count over the embedded summaries. */
export function todoProgress(goal: { todos?: Array<{ status: string }> | null }): { done: number; total: number } {
  const todos = goal.todos ?? [];
  return { done: todos.filter((t) => t.status === 'done').length, total: todos.length };
}

/**
 * Assignee cell for one todo: the chat's title when the id→title map knows
 * it, otherwise a short "chat <prefix>" fallback; '—' when unassigned.
 */
export function assigneeLabel(
  todo: { assigneeChatId?: string | null },
  titleById: Map<string, string>,
): string {
  const id = todo.assigneeChatId;
  if (!id) return '—';
  return titleById.get(id) ?? `chat ${id.slice(0, 8)}`;
}
