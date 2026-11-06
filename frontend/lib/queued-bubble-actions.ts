/**
 * Per-BUBBLE queued-message controls (ticket fb3cb4e2 — owner report 2026-11-05:
 * "why does it show the queed message twice? … i just asked for a simple send
 * now icon on te original queud place not a whole new duplicate container").
 *
 * WHAT WENT WRONG. Ticket ea04454c added the queue CONTROL PLANE (position,
 * reorder, run-now, cancel) and shipped it as `QueuedMessagesPanel` — a bordered
 * list stacked directly above the composer. But the queued message was ALREADY
 * on screen: the in-flow queued bubble (ticket 08d31b1a) that the owner asked
 * for — the one that lives "in the original queued place". So one queued message
 * rendered TWICE: once as its bubble and once as a row in the new container.
 * The owner's words are precise about which of the two is wanted: keep the
 * place, move the affordance onto it.
 *
 * WHAT THIS IS. The same decisions, expressed per BUBBLE instead of per panel:
 * given the id of a queued bubble, which server queue row is it, and which
 * controls are legal on it right now. Pure and total so the view can call it in
 * a render map and so it is pinned without mounting the 10k-line component.
 *
 * WHY THE MAPPING NEEDS A MODULE OF ITS OWN. A queued bubble's id is NOT the
 * server queue row id — there are two id families and they must not be
 * conflated:
 *   - `pending-<rowId>` — the server-listings from a plain GET's
 *     `pendingMessages` (ticket c0b2b0c8). The row id is the id minus the
 *     prefix; the control endpoints take the ROW id, so sending the prefixed id
 *     would 404.
 *   - `tmp-<epochMs>` — the optimistic echo minted at send time. It becomes a
 *     real row only once the server's `queued` ack lands, and the exact pairing
 *     is recorded then (ticket 81b229e1 moved this from a clock guess to an
 *     identity map, because a promote re-stamps the row's createdAt and breaks
 *     any text+time match).
 * `steer-*` (coding steers, persisted eagerly and folded into the live run),
 * provision-queue and guest-hold ids are deliberately NOT resolvable: those
 * messages are not in the server's user queue, so a cancel/run-now on them
 * could only produce a refusal toast.
 */

import { queueRowActions } from './queue-controls';

/** The `pending-` id prefix the plain GET stamps on server-listed queue rows
 *  (backend crossmodel.service.ts maps `id: \`pending-${r.id}\``). */
export const PENDING_ROW_PREFIX = 'pending-';

/**
 * Resolve a queued BUBBLE's id to the server queue row it controls.
 *
 * Returns null when the bubble is not a server-queue message (a coding steer, a
 * provision-queue hold, a guest hold, or a `tmp-*` echo whose enqueue has not
 * been acknowledged yet) — in every one of those cases there is no row for the
 * control endpoints to act on, and rendering an action that can only fail is
 * worse than rendering none.
 *
 * The `tmp-*` lookup is the identity map filled by the enqueue ack. It is
 * consumed destructively nowhere: a bubble is re-read on every render until its
 * row drains, so the entry must stay until `reloadPlain` releases it.
 */
export function pendingRowIdFor(
  bubbleId: string | null | undefined,
  echoToPending: ReadonlyMap<string, string> | null | undefined,
): string | null {
  if (typeof bubbleId !== 'string' || !bubbleId) return null;
  if (bubbleId.startsWith(PENDING_ROW_PREFIX)) {
    const rowId = bubbleId.slice(PENDING_ROW_PREFIX.length);
    return rowId || null;
  }
  // `tmp-*` is the only other family that can own a server queue row. Anything
  // else (steer-*, provision-*, guest-*, a persisted server id) returns null.
  if (!/^tmp-\d+$/.test(bubbleId)) return null;
  const rowId = echoToPending?.get(bubbleId);
  return rowId || null;
}

/** What one queued bubble can do right now. `pendingId` null ⇒ render nothing. */
export interface QueuedBubbleActions {
  /** The server queue row id, or null when this bubble has no row to control. */
  pendingId: string | null;
  /** Stop the live run and start THIS message immediately. Only while a run is
   *  live: with nothing running the drain has already picked the queue up, so
   *  the button would promise a no-op. */
  runNow: boolean;
  /** Drop the row before it fires. Always legal — a queue entry can always be
   *  withdrawn. */
  cancel: boolean;
  /** Reorder one slot, by the CHAT's drain order (never a cosmetic order). */
  up: boolean;
  down: boolean;
  /** Whether to draw the reorder pair at all — a single queued message has
   *  nothing to reorder against, and the arrows would be dead chrome on the
   *  bubble the owner asked to be simple. */
  reorder: boolean;
}

/**
 * Find a bubble's queue slot even when the bubble id is not a map key.
 *
 * THE TRAP THIS CLOSES (adversarial review of fb3cb4e2, BLOCKING). The server
 * list keys its rows by the RAW pending row id (`listUserQueue` selects
 * `id: full.id`), while a bubble freshly minted by a send is `tmp-<epochMs>`.
 * Nothing re-keys that `tmp-*` id until `reloadPlain` runs
 * reconcilePendingEchoes — i.e. on a focus resync, a stop, or the drain, and
 * NOT during the unattended live run the person is watching. So for the exact
 * bubble in front of them, a lookup keyed on the bubble id alone missed the row
 * that was ALREADY in the list (the enqueue ack refreshes it), and the position
 * badge plus the whole reorder pair silently disappeared — a capability the
 * deleted panel had. Resolving through `pendingId` (the row id the same
 * `plainEchoToPendingRef` identity map yields) is what makes the controls
 * behave identically for a `tmp-*` echo and its `pending-<rowId>` twin.
 *
 * Read the row id FIRST, never the bubble id, for anything positional: the row
 * id is the identity the server actually drains.
 */
export function queuedSlotFor<T>(
  bubbleId: string | null | undefined,
  pendingId: string | null | undefined,
  byRowId: ReadonlyMap<string, T> | null | undefined,
): T | null {
  if (!byRowId) return null;
  const direct = typeof bubbleId === 'string' && bubbleId ? byRowId.get(bubbleId) : undefined;
  if (direct !== undefined) return direct;
  const viaRow = typeof pendingId === 'string' && pendingId ? byRowId.get(pendingId) : undefined;
  return viaRow === undefined ? null : viaRow;
}

/**
 * Derive one queued bubble's controls.
 *
 * `queueIndex` is the bubble's position in the SERVER's list (`queueItems`), not
 * its index among the rendered bubbles: guest/provision holds are on screen
 * too and are not in that list, so a bubble-ordinal would silently shift the
 * ends. Pass -1 when the bubble's row is not in the last-known list (a fresh
 * enqueue the next poll has not picked up yet) — every positional action then
 * disables while run-now/cancel still work off the id.
 */
export function queuedBubbleActions(args: {
  bubbleId: string | null | undefined;
  echoToPending?: ReadonlyMap<string, string> | null;
  /** Index in the server list, or -1 when unknown. */
  queueIndex: number;
  /** Length of the server list. */
  queueLength: number;
  /** A run is live (the only state in which "run now" means anything). */
  running: boolean;
}): QueuedBubbleActions {
  const pendingId = pendingRowIdFor(args.bubbleId, args.echoToPending);
  if (!pendingId) {
    return { pendingId: null, runNow: false, cancel: false, up: false, down: false, reorder: false };
  }
  const known = args.queueIndex >= 0 && args.queueIndex < args.queueLength;
  const ends = known
    ? queueRowActions(args.queueIndex, args.queueLength)
    : { up: false, down: false, promote: false };
  return {
    pendingId,
    runNow: !!args.running,
    cancel: true,
    up: ends.up,
    down: ends.down,
    reorder: args.queueLength > 1 && known,
  };
}