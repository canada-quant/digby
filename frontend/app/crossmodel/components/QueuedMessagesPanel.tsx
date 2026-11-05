'use client';

/**
 * QueuedMessagesPanel (ticket ea04454c — owner ask 2026-11-05: "we need to add
 * interrupt/steer options in ui as well not just queued messages").
 *
 * THE GAP IT CLOSES. A message typed while a run was answering was persisted
 * and drained FIFO — correctly — but the person who typed it saw a toast and a
 * bare "Queued" bubble. No position, no cancel, no "run this one now", no
 * reorder. Their only lever was Stop, which ends the whole run.
 *
 * This panel is the missing control surface: it renders the caller's own
 * queued messages in DRAIN ORDER (the order they will actually be delivered),
 * each with a position badge and four actions:
 *
 *   ↑ / ↓   reorder one slot (server re-stamps createdAt, so the order shown IS
 *           the order the drain will use — never a cosmetic-only reorder)
 *   Run now promote to the head AND stop the live run, so it starts immediately
 *   ✕       cancel before it fires
 *
 * The panel is deliberately presentational: all state lives in the host view
 * (CodeSessionView), which owns the API calls and the optimistic order. That
 * keeps this file small and lets the host reuse it for any queue-backed surface.
 */

import { ArrowDown, ArrowUp, Play, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { queuedCaption, queueRowActions, type QueuedItem } from '@/lib/queue-controls';

export interface QueuedMessagesPanelProps {
  items: QueuedItem[];
  /** True while the run is live — the only time a prompt occupies the chat. */
  running: boolean;
  /** A control round-trip is in flight (buttons disable; never queue doubles). */
  busy?: boolean;
  /** Move one slot. */
  onMove: (id: string, direction: 'up' | 'down') => void;
  /** Promote + stop the live run so it starts now. */
  onRunNow: (id: string) => void;
  /** Drop it before it fires. */
  onCancel: (id: string) => void;
}

const ROW_BTN =
  'relative flex size-7 shrink-0 items-center justify-center rounded-full text-ink-3 transition-colors duration-150 ' +
  'hover:bg-hover hover:text-ink-2 touch-manipulation disabled:opacity-30 disabled:pointer-events-none ' +
  "before:absolute before:-inset-[5px] before:rounded-full before:content-['']";

export default function QueuedMessagesPanel({
  items, running, busy, onMove, onRunNow, onCancel,
}: QueuedMessagesPanelProps) {
  // Nothing queued → render nothing (no empty chrome above the composer).
  if (!items.length) return null;
  return (
    <div
      data-queued-messages
      className="mb-2 rounded-2xl border border-line bg-raised/60 px-2.5 py-2"
      aria-label="Queued messages"
    >
      <div className="mb-1 flex items-center gap-1.5 px-1">
        <span className="text-[11.5px] font-medium text-ink-2">
          {items.length === 1 ? '1 message queued' : `${items.length} messages queued`}
        </span>
        <span className="text-[11.5px] text-ink-3">· they send in this order</span>
      </div>
      <ul className="space-y-1">
        {items.map((item, index) => {
          const acts = queueRowActions(index, items.length);
          const text = item.content.trim() || (item.attachmentCount > 0 ? 'Attachment' : 'Empty message');
          return (
            <li key={item.id} className="flex items-center gap-1.5 rounded-xl px-1 py-1 hover:bg-hover/40">
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-hover text-[10.5px] font-medium text-ink-2"
                aria-label={`Queue position ${item.position}`}
              >
                {item.position}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink" title={text}>
                {text}
              </span>
              {item.attachmentCount > 0 && (
                <span className="shrink-0 text-[11px] text-ink-3" title={`${item.attachmentCount} attachment(s)`}>
                  📎{item.attachmentCount > 1 ? item.attachmentCount : ''}
                </span>
              )}
              <button type="button" className={ROW_BTN} disabled={busy || !acts.up}
                onClick={() => onMove(item.id, 'up')} title="Move up one place" aria-label="Move up one place">
                <ArrowUp className="size-[15px]" strokeWidth={2} />
              </button>
              <button type="button" className={ROW_BTN} disabled={busy || !acts.down}
                onClick={() => onMove(item.id, 'down')} title="Move down one place" aria-label="Move down one place">
                <ArrowDown className="size-[15px]" strokeWidth={2} />
              </button>
              <button type="button" className={ROW_BTN} disabled={busy || !running}
                onClick={() => onRunNow(item.id)}
                title="Stop the running answer and send this message now"
                aria-label="Stop the running answer and send this message now">
                <Play className="size-[14px]" strokeWidth={2} />
              </button>
              <button type="button" className={cn(ROW_BTN, 'hover:text-destructive')} disabled={busy}
                onClick={() => onCancel(item.id)} title="Remove this queued message" aria-label="Remove this queued message">
                <X className="size-[15px]" strokeWidth={2} />
              </button>
            </li>
          );
        })}
      </ul>
      {/* The same truth the bubble captions carry — one voice, stated once. */}
      <p className="mt-1 px-1 text-[11px] text-ink-3">
        {queuedCaption({ position: null, coding: false })}
        {running ? ' Run now stops the current answer and sends immediately.' : ''}
      </p>
    </div>
  );
}