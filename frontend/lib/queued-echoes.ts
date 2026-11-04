/**
 * partitionQueuedEchoes (ticket 08d31b1a) — split a transcript into the
 * persisted history and the locally-echoed messages still queued behind a
 * live run (optimistic steer bubbles `steer-*`, plain busy-queue echoes
 * `tmp-*` — their ids are tracked in the view's pendingSteerIds set).
 *
 * Why: the echo is appended at the END of the messages array at send time
 * (its true chronological position — PR #328 / ticket 3d6a8cb2 keeps that
 * array as the record), but the LIVE run block renders AFTER the whole
 * array. In a coding session the live block grows thousands of pixels tall
 * (streamed tool cards, thoughts), so an echo rendered at its array slot
 * lands at the live block's TOP edge — the user, pinned to the live tail,
 * never sees it and later finds the bubble "very high up". The view
 * partitions instead: history renders in the list, the live block follows,
 * and the queued echoes render IN-FLOW at the bottom (before the composer)
 * where the user's attention actually is. On run complete the pending set
 * clears and the server-persisted steer row takes its true chronological
 * slot via reloadSession — the echo ids (`steer-*` / `tmp-*`) never collide
 * with server ids, so the handoff is seamless.
 *
 * Pure + total: the inputs are not mutated; both output arrays preserve
 * their source relative order.
 */
export function partitionQueuedEchoes<T extends { id: string }>(
  messages: T[],
  pendingIds: ReadonlySet<string>,
): { history: T[]; queuedEchoes: T[] } {
  const history: T[] = [];
  const queuedEchoes: T[] = [];
  for (const m of messages) {
    (pendingIds.has(m.id) ? queuedEchoes : history).push(m);
  }
  return { history, queuedEchoes };
}

/**
 * reconcileQueuedEchoes (owner report 2026-09-16, "I don't visually see my
 * queued messages in coding sessions like I used to") — merge a freshly
 * fetched transcript page into the loaded transcript WITHOUT losing the
 * queued bubbles.
 *
 * The old merge dropped every local echo (`steer-*` / `tmp-*`) on ANY reload,
 * and a coding session reloads mid-run on every re-attach (tab switch, network
 * blip, deploy flip). The server persists a steer eagerly as a user row, so
 * after the reload that row sat in `history` at its chronological slot —
 * ABOVE the live block, thousands of pixels from the pinned viewport — while
 * the pending set still held a `steer-*` id that no longer matched any row.
 * Net effect: the queued bubble vanished the moment the view re-attached.
 *
 * Here a pending echo is RECONCILED with its server twin (same role 'user',
 * same trimmed text, created within `windowMs`): the echo row is replaced by
 * the server row and the caller re-keys the pending set through `idMap`, so
 * the server row keeps rendering in the queued slot until the run ends. A
 * pending echo with no twin yet (the persist has not landed) is KEPT. Local
 * echoes that are not pending are dropped as before; server rows always win
 * on id.
 *
 * Window (owner report 2026-09-18, "when I send a message and it queues it
 * disappears … then later reappears"): a CODING steer is persisted eagerly, so
 * its twin sits within seconds of the echo — the symmetric `windowMs` fits.
 * A PLAIN busy-queue message is persisted only when the drain RUNS it — the
 * twin's createdAt is the drain time, minutes or hours after the send. Plain
 * callers pass an asymmetric window (`windowBeforeMs` small, `windowAfterMs`
 * Infinity): a twin may be arbitrarily NEWER than the echo, never older — so
 * an old row with the same text ("ok") can't be claimed as the twin.
 *
 * Pure + total; output sorted by createdAt then id (the previous merge order).
 */
export interface EchoRow { id: string; role?: string; content?: string; createdAt?: string }
export function reconcileQueuedEchoes<T extends EchoRow>(
  prev: T[],
  page: T[],
  pendingIds: ReadonlySet<string>,
  opts: { isLocalEcho: (id: string) => boolean; windowMs?: number; windowBeforeMs?: number; windowAfterMs?: number; dropPrevAbsent?: (id: string) => boolean },
): { messages: T[]; idMap: Map<string, string> } {
  const windowMs = opts.windowMs ?? 10 * 60_000;
  const beforeMs = opts.windowBeforeMs ?? windowMs; // twin may be this much OLDER than the echo
  const afterMs = opts.windowAfterMs ?? windowMs;   // twin may be this much NEWER than the echo
  const byId = new Map<string, T>();
  const idMap = new Map<string, string>();
  const claimed = new Set<string>();
  const norm = (s: unknown) => String(s ?? '').trim();
  const ms = (s: unknown) => { const t = new Date(String(s ?? '')).getTime(); return Number.isFinite(t) ? t : NaN; };
  for (const m of page) byId.set(m.id, m);
  for (const m of prev) {
    // Server-listed rows (ticket c0b2b0c8 — the plain GET now returns
    // `pendingMessages`, mapped as `pending-<rowId>` rows): the server list
    // is the source of truth for queue state, so a prev pending row ABSENT
    // from the fresh page has been drained (persisted as a real row in the
    // page) — keeping it would render a duplicate beside that real row.
    if (opts.dropPrevAbsent?.(m.id) && !byId.has(m.id)) continue;
    if (!opts.isLocalEcho(m.id)) { if (!byId.has(m.id)) byId.set(m.id, m); continue; }
    if (!pendingIds.has(m.id)) continue; // stale local echo — the server copy is the record
    const t0 = ms(m.createdAt);
    const twin = page.find((p) => !claimed.has(p.id) && !opts.isLocalEcho(p.id) && (p.role ?? 'user') === 'user'
      && norm(p.content) === norm(m.content) && norm(m.content) !== ''
      && (!Number.isFinite(t0) || !Number.isFinite(ms(p.createdAt))
        || (ms(p.createdAt) >= t0 - beforeMs && ms(p.createdAt) <= t0 + afterMs)));
    if (twin) { claimed.add(twin.id); idMap.set(m.id, twin.id); continue; }
    byId.set(m.id, m); // persist not landed yet — keep the bubble
  }
  const messages = Array.from(byId.values()).sort((a, b) => {
    const ca = String(a.createdAt ?? ''), cb = String(b.createdAt ?? '');
    return ca < cb ? -1 : ca > cb ? 1 : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  return { messages, idMap };
}
