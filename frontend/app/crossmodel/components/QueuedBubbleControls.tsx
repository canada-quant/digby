'use client';

/**
 * QueuedBubbleControls (ticket fb3cb4e2 — owner report 2026-11-05).
 *
 * The owner's words, verbatim: "why does it show the queed message twice? this
 * is not what i asked for i just asked for a simple send now icon on te original
 * queud place not a whole new duplicate container".
 *
 * WHAT IT REPLACES. Ticket ea04454c built the queue CONTROL PLANE (position,
 * reorder, run-now, cancel) and rendered it as `QueuedMessagesPanel` — a
 * bordered list stacked above the composer. The queued message was ALREADY on
 * screen as the in-flow queued bubble (ticket 08d31b1a), so every queued message
 * appeared twice: its bubble, and a row in the new container. The control plane
 * was right; the SURFACE was wrong. The affordance belongs ON the bubble the
 * person is already looking at, not in a second copy of it.
 *
 * WHY A SEPARATE COMPONENT, NOT INLINE JSX. The actions are per-bubble and the
 * row-id resolution is subtle (`pending-<rowId>` vs the `tmp-*` echo → row
 * identity map — see lib/queued-bubble-actions.ts), so it lives in two testable
 * pieces: a pure decision module and this thin presentational row. Deleting the
 * panel also means there is exactly ONE place a queued message renders, which is
 * what makes the class of duplicate the owner reported unrepresentable rather
 * than merely fixed.
 *
 * Deliberately icon-only and at bubble scale: the owner asked for "a simple send
 * now icon", not a toolbar. Reorder arrows appear only when there is more than
 * one message queued (nothing to reorder otherwise) and the accessible names
 * carry the side effect, since these sit inside a message bubble where a bare
 * play glyph reads as decoration.
 */

import { ArrowDown, ArrowUp, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface QueuedBubbleControlsProps {
  /** A control round-trip is in flight — buttons disable so a double-tap
   *  cannot queue two promotes onto the same row. */
  busy?: boolean;
  /** Stop the live run and send THIS message now. */
  runNow: boolean;
  /** Withdraw the row before it fires. */
  cancel: boolean;
  /** Draw the reorder pair (only meaningful with more than one queued). */
  reorder: boolean;
  up: boolean;
  down: boolean;
  onRunNow: () => void;
  onCancel: () => void;
  onMove: (direction: 'up' | 'down') => void;
}

/** Bubble-scale icon button: 22px, no chrome until hover, and a small invisible
 *  hit-area extension so a touch target stays usable without growing the row. */
const BUBBLE_BTN =
  'relative flex size-[22px] shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors duration-150 ' +
  'hover:bg-hover hover:text-ink-2 touch-manipulation disabled:opacity-30 disabled:pointer-events-none ' +
  "before:absolute before:-inset-[6px] before:rounded-full before:content-['']";

export default function QueuedBubbleControls({
  busy, runNow, cancel, reorder, up, down, onRunNow, onCancel, onMove,
}: QueuedBubbleControlsProps) {
  return (
    <span data-queued-bubble-actions className="inline-flex items-center gap-0.5">
      {/* "Send now" — the ONE control the owner asked for. It is only rendered
          while a run is live: with nothing running the drain already owns the
          queue, so the button would promise a no-op. */}
      {runNow && (
        <button type="button" className={BUBBLE_BTN} disabled={!!busy}
          onClick={onRunNow} data-queued-run-now
          title="Send now — stop the current answer and send this message immediately"
          aria-label="Send now — stop the current answer and send this message immediately">
          <Play className="size-[12px]" strokeWidth={2.25} />
        </button>
      )}
      {reorder && (
        <>
          <button type="button" className={BUBBLE_BTN} disabled={!!busy || !up}
            onClick={() => onMove('up')} title="Move up one place" aria-label="Move up one place">
            <ArrowUp className="size-[12px]" strokeWidth={2.25} />
          </button>
          <button type="button" className={BUBBLE_BTN} disabled={!!busy || !down}
            onClick={() => onMove('down')} title="Move down one place" aria-label="Move down one place">
            <ArrowDown className="size-[12px]" strokeWidth={2.25} />
          </button>
        </>
      )}
      {cancel && (
        <button type="button" className={cn(BUBBLE_BTN, 'hover:text-destructive')} disabled={!!busy}
          onClick={onCancel} title="Remove this queued message" aria-label="Remove this queued message">
          <X className="size-[13px]" strokeWidth={2.25} />
        </button>
      )}
    </span>
  );
}