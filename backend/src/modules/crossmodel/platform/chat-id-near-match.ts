/**
 * Near-miss chat-id resolution (owner 2026-09-18: "aren't all these messages
 * machine to machine to go autonomously?").
 *
 * Every send_chat_message confirmation card the owner was clicking through
 * came from ONE defect class: the lane re-typed a full 36-char chat id with a
 * single wrong hex character ("615723ba-2bcd-…" for "615723ba-2bcc-…"). The
 * autonomy scope check could not resolve the target ('unresolved' — 48 such
 * refusals in a week, zero genuinely foreign targets), so the gate staged a
 * card "as you" addressed to a chat that does not exist; the executor would
 * have 404ed it after the click anyway.
 *
 * Rule: a full-shape id that misses exactly resolves to the ONE chat, owned by
 * the SAME user, that shares its 8-char time prefix and differs in at most
 * NEAR_MATCH_MAX_DISTANCE characters. Ambiguity or no candidate → null (the
 * caller then refuses with a did-you-mean instead of carding). Owner-scoped by
 * construction: candidates are read with the caller's userId, so a typo can
 * never resolve into another account's chat.
 */

export const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Hex characters that may differ between the typed id and the real one. */
export const NEAR_MATCH_MAX_DISTANCE = 2;
/** Candidates share this many leading characters (the uuid time prefix). */
export const NEAR_MATCH_PREFIX_CHARS = 8;

export function isFullChatIdShape(id: unknown): boolean {
  return typeof id === 'string' && UUID_SHAPE_RE.test(id.trim());
}

/** Positions that differ between two equal-length strings; -1 when lengths differ. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/**
 * The single candidate within `maxDistance` of `id` (case-insensitive), or
 * null when none or more than one qualifies. An exact match (distance 0) wins
 * outright even when other near candidates exist.
 */
export function nearMatchChatId<T extends { id: string }>(
  candidates: readonly T[],
  id: string,
  maxDistance: number = NEAR_MATCH_MAX_DISTANCE,
): T | null {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return null;
  const exact = candidates.find((c) => c.id.toLowerCase() === want);
  if (exact) return exact;
  const near = candidates.filter((c) => {
    const d = hammingDistance(c.id.toLowerCase(), want);
    return d > 0 && d <= maxDistance;
  });
  return near.length === 1 ? near[0] : null;
}
