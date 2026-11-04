/**
 * Recency sections for the Digby Frontier sidebar (2026-10-06 redesign).
 *
 * Pure helpers — no React. The rail used to render ONE "Chats" list under an
 * uppercase tracking label; it now groups the ungrouped chats by recency under
 * sentence-case section labels ("Today", "Yesterday", "Previous 7 days",
 * "Previous 30 days", "Older"), the way frontier assistants do.
 *
 * Lineage stays intact: the input is the FLATTENED lineage rows
 * (lib/chat-lineage.ts flattenChatGroups) — a child row always follows its
 * parent and is bucketed WITH it (by the parent's activity), so the indent +
 * connector render never splits across two sections.
 */

export type RecencyBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';

export const RECENCY_LABELS: Record<RecencyBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  month: 'Previous 30 days',
  older: 'Older',
};

const ORDER: RecencyBucket[] = ['today', 'yesterday', 'week', 'month', 'older'];

/** Local-midnight start of `d`'s calendar day. */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * Which section a timestamp lands in, by LOCAL calendar day relative to `now`.
 * Unparseable / missing stamps fall to 'older' (never hidden). Future stamps
 * (clock skew) count as today.
 */
export function recencyBucket(stamp: string | number | Date | null | undefined, now: Date = new Date()): RecencyBucket {
  if (stamp == null || stamp === '') return 'older';
  const t = stamp instanceof Date ? stamp.getTime() : new Date(stamp).getTime();
  if (!Number.isFinite(t)) return 'older';
  const today = startOfDay(now);
  if (t >= today) return 'today';
  const dayMs = 24 * 60 * 60 * 1000;
  if (t >= today - dayMs) return 'yesterday';
  if (t >= today - 7 * dayMs) return 'week';
  if (t >= today - 30 * dayMs) return 'month';
  return 'older';
}

/** The activity stamp the sidebar sorts by: newest message, else the row's update. */
export interface RecencyChat {
  lastMessageAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

export function chatActivityStamp(chat: RecencyChat): string | null {
  return chat.lastMessageAt || chat.updatedAt || chat.createdAt || null;
}

export interface RecencySection<R> {
  bucket: RecencyBucket;
  label: string;
  rows: R[];
}

/**
 * Split flattened lineage rows into recency sections. A non-child row starts a
 * new "unit" (it plus the child rows that follow it) and the unit is bucketed
 * by the parent row's activity. Sections come back in fixed order (Today
 * first), empty ones omitted; rows keep their input order inside a section.
 */
export function groupRowsByRecency<R extends { chat: RecencyChat; isChild: boolean }>(
  rows: readonly R[],
  now: Date = new Date(),
): Array<RecencySection<R>> {
  const buckets = new Map<RecencyBucket, R[]>();
  let current: RecencyBucket = 'older';
  for (const row of rows) {
    if (!row.isChild) current = recencyBucket(chatActivityStamp(row.chat), now);
    const list = buckets.get(current) ?? [];
    list.push(row);
    buckets.set(current, list);
  }
  return ORDER
    .filter((b) => (buckets.get(b)?.length ?? 0) > 0)
    .map((b) => ({ bucket: b, label: RECENCY_LABELS[b], rows: buckets.get(b)! }));
}
