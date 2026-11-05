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

/**
 * The PLAIN busy-queue echo id family — `send()` mints `tmp-<epochMs>` for the
 * optimistic bubble of a message handed to the server's pending queue.
 * Deliberately narrow: `steer-*` (coding steers, persisted eagerly) and the
 * provision / guest queue ids never reach the server queue this reconciles
 * against, so they must not be matched here.
 */
export function isPlainQueueEchoId(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^tmp-\d+$/.test(id);
}

/**
 * reconcilePendingEchoes ("Send now" shows the message TWICE — owner report
 * 2026-11-05, ticket 81b229e1).
 *
 * The plain-chat Send now path queues the message, PROMOTES it, then STOPS the
 * live run. Stopping triggers `reloadPlain` while the promoted row is still
 * sitting in `pending_chat_messages` (nothing has drained it yet), so the same
 * text arrives twice over different render paths:
 *   - the optimistic `tmp-*` echo the composer appended at send time, still in
 *     `pendingSteerIds` (the run has not persisted anything to reconcile it
 *     with), and
 *   - that same message as the server-listed `pending-<rowId>` row.
 * `reconcileQueuedEchoes` cannot merge them: its twin search only looks at the
 * PERSISTED page, and a queue entry is not persisted until it drains. The
 * id-only append therefore keeps both, and the queued part renders two
 * identical bubbles — the bug the owner screenshotted.
 *
 * The server's queue row is the record (it is what will actually run), so the
 * local echo is DROPPED in favour of it, and `idMap` maps the echo id onto the
 * row id for callers that track the pending set.
 *
 * IDENTITY FIRST (adversarial review, blocking #2). A clock heuristic alone is
 * unsound here because `promoteQueuedUserMessage` REWRITES the very row this
 * matches (backend …/chat-agent/queue-controls.ts):
 *     const desired = new Date(order[myFirst].createdAt.getTime() - ORDER_EPSILON_MS);
 *     await prisma.pendingChatMessage.update({ … data: { createdAt: target } });
 * i.e. promoting re-stamps the row to just before the caller's OLDEST queued
 * message — so its createdAt can jump arbitrarily BACK in time relative to the
 * echo, and any fixed window either misses the real pair or starts claiming
 * unrelated same-text rows.
 *
 * The send path knows the pairing EXACTLY (`onQueued` carries the row id next
 * to the `tmp-<epochMs>` echo it belongs to), so `echoToPending` is passed in
 * and wins outright. That is the authoritative path and it is immune to the
 * re-stamp.
 *
 * The clock path is only a FALLBACK for a reattach that has lost the pairing,
 * and it is deliberately tight and symmetric: when we cannot prove identity we
 * would rather MISS (the duplicate stays visible for one more render, failing
 * safe) than claim an unrelated row that happens to hold the same text.
 *
 * Matching also requires the same user role and the same non-empty trimmed
 * content, and each row is claimed at most ONCE, so two consecutive identical
 * sends map onto two distinct rows in order.
 *
 * Pure + total: inputs are not mutated; order is preserved.
 */
export function reconcilePendingEchoes<T extends EchoRow>(
  messages: T[],
  pendingRows: T[],
  opts?: {
    isQueueEcho?: (id: string) => boolean;
    /** Exact echo→row pairing recorded at send time (authoritative). */
    echoToPending?: ReadonlyMap<string, string>;
    windowMs?: number;
  },
): { messages: T[]; idMap: Map<string, string> } {
  const isQueueEcho = opts?.isQueueEcho ?? isPlainQueueEchoId;
  const windowMs = opts?.windowMs ?? 2 * 60_000;
  const norm = (s: unknown) => String(s ?? '').trim();
  const ms = (s: unknown) => { const t = new Date(String(s ?? '')).getTime(); return Number.isFinite(t) ? t : NaN; };
  const byId = new Set(pendingRows.map((p) => p.id));
  const idMap = new Map<string, string>();
  const claimed = new Set<string>();
  const out: T[] = [];
  for (const m of messages) {
    if (!isQueueEcho(m.id)) { out.push(m); continue; }
    // 1. The exact pairing the send recorded — no guessing, no clock.
    const known = opts?.echoToPending?.get(m.id);
    if (known && byId.has(known) && !claimed.has(known)) {
      claimed.add(known); idMap.set(m.id, known); continue;
    }
    // 2. Fallback: same role + identical non-empty text, close in time.
    const t0 = ms(m.createdAt);
    const twin = pendingRows.find((p) => {
      if (claimed.has(p.id)) return false;
      if (isQueueEcho(p.id)) return false;
      if ((p.role ?? 'user') !== 'user' || (m.role ?? 'user') !== 'user') return false;
      if (norm(p.content) !== norm(m.content) || norm(m.content) === '') return false;
      const t1 = ms(p.createdAt);
      // An unparseable timestamp cannot be placed in time — refuse the match
      // rather than letting content alone claim a row of any age.
      if (!Number.isFinite(t0) || !Number.isFinite(t1)) return false;
      return Math.abs(t1 - t0) <= windowMs;
    });
    if (twin) { claimed.add(twin.id); idMap.set(m.id, twin.id); continue; } // server row renders instead
    out.push(m);
  }
  return { messages: out, idMap };
}
