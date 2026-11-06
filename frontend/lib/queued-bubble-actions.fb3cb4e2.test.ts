/**
 * Ticket fb3cb4e2 — "why does it show the queed message twice?"
 *
 * Owner report, verbatim: "this is not what i asked for i just asked for a
 * simple send now icon on te original queud place not a whole new duplicate
 * container".
 *
 * THE DEFECT. Ticket ea04454c added the queue control plane and surfaced it as
 * `QueuedMessagesPanel` — a bordered list above the composer. But the queued
 * message was ALREADY on screen: the in-flow queued bubble (ticket 08d31b1a)
 * that the owner calls "the original queued place". Nothing prevented both
 * surfaces from rendering the same row, so one queued message painted TWICE —
 * its bubble, plus a list row repeating its text — and the extra container also
 * pushed the composer down.
 *
 * WHAT THESE PINS PROTECT (three separate ways this could regress):
 *   1. a container coming BACK — the whole point of the fix is that there is
 *      exactly one place a queued message renders;
 *   2. the controls NOT riding the bubble — dropping them would be the
 *      regression ea04454c existed to prevent (a queue you cannot act on);
 *   3. the bubble→row RESOLUTION breaking — every control is keyed on a server
 *      queue row id, and a queued bubble's id is NOT that id. Get the mapping
 *      wrong and the buttons 404 instead of acting, or worse, act on a
 *      different message.
 *
 * Why a source pin for (1) and (2): the container is JSX inside a 10k-line
 * component; there is no unit seam that can "render a queued message twice".
 * The pure decision helper (queuedBubbleActions) carries the logic and is
 * pinned behaviourally below; the two structural facts — no second surface,
 * controls inside the bubble map — can only be pinned by reading the source.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { pendingRowIdFor, queuedBubbleActions, queuedSlotFor, PENDING_ROW_PREFIX } from './queued-bubble-actions';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const VIEW = read('../app/crossmodel/components/CodeSessionView.tsx');

/** The exact source slice between two anchors — used so a pin cannot be
 *  satisfied by a match elsewhere in the file. */
function region(src: string, start: string, end: string): string {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a + start.length);
  expect(a).toBeGreaterThanOrEqual(0);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
}

describe('fb3cb4e2 — the duplicate queued container is GONE', () => {
  it('the view imports no queued-messages panel and renders no second surface', () => {
    // Pinned on the IMPORT and the RENDER CALL, not the bare name: a comment
    // explaining why the container is gone legitimately names it.
    expect(VIEW).not.toMatch(/import\s+QueuedMessagesPanel\s+from/);
    expect(VIEW).not.toMatch(/<QueuedMessagesPanel\b/);
    // The panel's root attribute: if a list container comes back, this catches
    // it even under a different component name.
    expect(VIEW).not.toContain('data-queued-messages');
  });

  it('the panel component itself is deleted, not merely unused', () => {
    // An orphaned panel is how this regresses: someone re-imports the file that
    // is still sitting there. Its absence from disk is the stronger gate.
    let gone = false;
    try {
      read('../app/crossmodel/components/QueuedMessagesPanel.tsx');
    } catch {
      gone = true;
    }
    expect(gone).toBe(true);
  });

  it('the composer is not preceded by a second transcript of queued rows', () => {
    // The container used to sit between the transcript and <ChatComposer>. Pin
    // the composition directly: the queued-messages panel render call is the
    // exact shape that produced the duplicate, and it must not exist anywhere.
    expect(VIEW).not.toMatch(/<Queued[A-Za-z]*Panel\b/);
    expect(VIEW).not.toContain('items={queueItems}');
  });
});

describe('fb3cb4e2 — the controls ride the ORIGINAL queued bubble', () => {
  it('the queued-echo render block carries the per-bubble control call', () => {
    // The block the owner calls "the original queued place" is the queuedEchoes
    // map; the controls must be inside it, next to the caption, not elsewhere.
    const block = region(VIEW, '{queuedEchoes.map(m => {', '{showJumpToEnd');
    expect(block).toContain('queuedBubbleActions({');
    expect(block).toContain('<QueuedBubbleControls');
    // Wired to the REAL control handlers — a rendered button with no handler
    // would look fixed while doing nothing.
    expect(block).toContain('runQueuedNow(acts.pendingId!)');
    expect(block).toContain('cancelQueued(acts.pendingId!)');
    expect(block).toContain("moveQueued(acts.pendingId!, dir)");
  });

  it('the bubble still shows the queue POSITION the removed container showed', () => {
    // Losing the container must not lose information: it was the only place a
    // position badge appeared. The caption now states it — read through the
    // RESOLVED row id, not the bubble id (see the describe block below; this
    // pin alone was too weak, which is how the reviewer's BLOCKING finding
    // slipped past the first cut).
    const block = region(VIEW, '{queuedEchoes.map(m => {', '{showJumpToEnd');
    expect(block).toContain('queuedCaption({');
    expect(block).toContain('queuedSlotFor(m.id, pendingId, queuePositionById) ?? null');
  });

  it('the queued block resolves the bubble row ONCE and reads every slot through it', () => {
    // The BLOCKING finding of the adversarial review: a fresh `tmp-*` bubble is
    // not a key in the position/index maps (they hold the raw row id), so a
    // bubble-id-only lookup dropped both the position badge and the reorder pair
    // for exactly the message the person was looking at.
    const block = region(VIEW, '{queuedEchoes.map(m => {', '{showJumpToEnd');
    expect(block).toContain('const pendingId = pendingRowIdFor(m.id, plainEchoToPendingRef.current);');
    expect(block).toContain('queuedSlotFor(m.id, pendingId, queueIndexById) ?? -1');
    expect(block).not.toContain('queueIndexById.get(m.id) ?? -1');
    expect(block).not.toContain('queuePositionById.get(m.id) ?? null');
  });

  it('the memberViewOnly gate the deleted panel carried is preserved on the controls', () => {
    // Defense in depth: the server refuses a non-owner, but losing the guard
    // silently is how a deliberate protection decays.
    const block = region(VIEW, '{queuedEchoes.map(m => {', '{showJumpToEnd');
    expect(block).toContain('{!memberViewOnly && acts.pendingId && (');
  });

  it('the position/index maps are keyed on BOTH id spellings a bubble carries', () => {
    // queueItems rows use the raw row id; a reloaded bubble uses
    // `pending-<rowId>`. Keying only one of them silently disables every
    // positional control after a reload — the sort of half-fix that reads as a
    // design choice.
    const mapBlock = region(VIEW, 'const queueIndexById = useMemo(', 'const queuePositionById = useMemo(');
    expect(mapBlock).toContain('map.set(item.id, i);');
    expect(mapBlock).toContain('map.set(`${PENDING_ROW_PREFIX}${item.id}`, i);');
    const posBlock = region(VIEW, 'const queuePositionById = useMemo(', '// Scroll-up auto-load');
    expect(posBlock).toContain('map.set(item.id, pos);');
    expect(posBlock).toContain('map.set(`${PENDING_ROW_PREFIX}${item.id}`, pos);');
  });
});

describe('fb3cb4e2 — bubble id → server queue row resolution', () => {
  it('strips the `pending-` listing prefix to get the row the endpoints take', () => {
    // A server-listed queued row arrives as `pending-<rowId>` (ticket c0b2b0c8).
    // Posting the prefixed id to the control endpoints would 404 — and 404 reads
    // to the user as "that message is already gone".
    expect(PENDING_ROW_PREFIX).toBe('pending-');
    expect(pendingRowIdFor('pending-row-123', null)).toBe('row-123');
  });

  it('resolves a `tmp-*` echo through the enqueue-ack identity map', () => {
    // The optimistic echo becomes a real row only when the `queued` ack lands;
    // the pairing is recorded then (ticket 81b229e1 made it identity-based
    // because a promote re-stamps createdAt).
    const echoes = new Map([['tmp-1793943856000', 'row-abc']]);
    expect(pendingRowIdFor('tmp-1793943856000', echoes)).toBe('row-abc');
  });

  it('an unacked `tmp-*` echo resolves to nothing — there is no row to act on yet', () => {
    expect(pendingRowIdFor('tmp-1793943856000', new Map())).toBeNull();
    expect(pendingRowIdFor('tmp-1793943856000', null)).toBeNull();
  });

  it('coding steers, provisioning holds, guest holds and server ids render NO controls', () => {
    // These are on screen in the same queued slot but are NOT in the server's
    // user queue: cancel/promote on them can only produce a refusal toast, and
    // a `steer-*` fold-in is not a queue turn at all.
    const echoes = new Map([['steer-1', 'row-x']]);
    for (const id of ['steer-1788042547001', 'provision-1', 'guest-1', 'srv-persisted-1', '', null, undefined]) {
      expect(pendingRowIdFor(id as any, echoes)).toBeNull();
    }
  });

  it('a bare `pending-` with no row id is not a row', () => {
    expect(pendingRowIdFor('pending-', null)).toBeNull();
  });
});

describe('fb3cb4e2 — slot resolution survives the tmp-* / row-id split', () => {
  // The adversarial review's BLOCKING finding, pinned behaviourally: the server
  // list is keyed by the RAW row id, but a freshly sent bubble is `tmp-<ms>`
  // until a reload re-keys it. A bubble-id-only lookup therefore missed the row
  // the enqueue ack had already listed.
  const byRowId = new Map([['row-1', 0], ['row-2', 1]]);

  it('a tmp-* bubble resolves its slot through the row id', () => {
    // This is the exact shape that regressed: bubble id not a key, row id is.
    expect(queuedSlotFor('tmp-1793943856000', 'row-2', byRowId)).toBe(1);
  });

  it('a server-listed pending-<rowId> bubble resolves directly', () => {
    // The maps store both spellings too, so the direct branch must win.
    const withPending = new Map([['pending-row-1', 0], ['row-1', 0]]);
    expect(queuedSlotFor('pending-row-1', 'row-1', withPending)).toBe(0);
  });

  it('a bubble whose row is genuinely absent resolves to null (controls fall back)', () => {
    expect(queuedSlotFor('tmp-1793943856000', null, byRowId)).toBeNull();
    expect(queuedSlotFor('tmp-1793943856000', 'row-gone', byRowId)).toBeNull();
  });

  it('a missing map resolves to null rather than throwing mid-render', () => {
    expect(queuedSlotFor('tmp-1', 'row-1', null)).toBeNull();
    expect(queuedSlotFor('tmp-1', 'row-1', undefined)).toBeNull();
  });

  it('index 0 is a real slot, not a falsy miss (the off-by-one that disables the head row)', () => {
    // `?? -1` and `|| -1` differ exactly here; a falsy check would disable the
    // head bubble's "move down".
    expect(queuedSlotFor('row-1', null, byRowId)).toBe(0);
  });

  it('carries the position payload too (the caption reads the same resolver)', () => {
    const positions = new Map([['row-2', 2]]);
    expect(queuedSlotFor('tmp-1793943856000', 'row-2', positions)).toBe(2);
  });
});

describe('fb3cb4e2 — which per-bubble controls are legal', () => {
  const base = { echoToPending: null, queueLength: 3, running: true };

  it('the head bubble can go down but not up; run-now and cancel stay available', () => {
    const a = queuedBubbleActions({ ...base, bubbleId: 'pending-a', queueIndex: 0 });
    expect(a).toEqual({ pendingId: 'a', runNow: true, cancel: true, up: false, down: true, reorder: true });
  });

  it('the tail bubble can go up but not down', () => {
    const a = queuedBubbleActions({ ...base, bubbleId: 'pending-c', queueIndex: 2 });
    expect(a.up).toBe(true);
    expect(a.down).toBe(false);
  });

  it('a lone queued message draws no reorder chrome (nothing to reorder against)', () => {
    // The owner asked for a SIMPLE send-now icon. Two dead arrows on a
    // single-message queue is exactly the clutter that report was about.
    const a = queuedBubbleActions({ ...base, bubbleId: 'pending-a', queueIndex: 0, queueLength: 1 });
    expect(a.reorder).toBe(false);
    expect(a.up).toBe(false);
    expect(a.down).toBe(false);
    expect(a.runNow).toBe(true);
  });

  it('run-now is hidden when no run is live — the drain already owns the queue', () => {
    const a = queuedBubbleActions({ ...base, bubbleId: 'pending-a', queueIndex: 0, running: false });
    expect(a.runNow).toBe(false);
    // Cancelling a queued row is always allowed.
    expect(a.cancel).toBe(true);
  });

  it('an unknown index (row not in the last known list yet) disables only the POSITIONAL ends', () => {
    // A just-enqueued row the next poll has not picked up: its ordinal is
    // unknown, so a move would guess. Run-now/cancel work off the id alone.
    const a = queuedBubbleActions({ ...base, bubbleId: 'pending-new', queueIndex: -1 });
    expect(a).toEqual({ pendingId: 'new', runNow: true, cancel: true, up: false, down: false, reorder: false });
  });

  it('a bubble with no server row yields no controls at all', () => {
    const a = queuedBubbleActions({ ...base, bubbleId: 'steer-1', queueIndex: -1 });
    expect(a).toEqual({ pendingId: null, runNow: false, cancel: false, up: false, down: false, reorder: false });
  });

  it('is PURE: repeated calls on the same inputs agree (a render map re-reads it)', () => {
    const args = { ...base, bubbleId: 'tmp-5', echoToPending: new Map([['tmp-5', 'row-5']]), queueIndex: 1 };
    expect(queuedBubbleActions(args)).toEqual(queuedBubbleActions(args));
  });
});