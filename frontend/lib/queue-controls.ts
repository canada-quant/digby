/**
 * Queued-message CONTROL helpers (ticket ea04454c — owner ask 2026-11-05:
 * "we need to add interrupt/steer options in ui as well not just queued
 * messages").
 *
 * THE GAP: a message typed while a run was active was silently queued — the
 * composer promised "queues and sends next", the person had no position, no
 * cancel, no "run this one now", and no way to interrupt-and-steer short of
 * Stop (which ends the whole run and loses its work-in-progress).
 *
 * This leaf holds the DECISIONS the view renders, kept pure so they are pinned
 * by tests without mounting a 5,000-line component:
 *   - what the composer's send button should DO this press (queue vs send-now),
 *   - which per-row actions are legal at a given position,
 *   - how an optimistic reorder maps a move onto the array,
 *   - what each server refusal actually means to the person.
 *
 * The server is the source of truth for ORDER (backend/…/queue-controls.ts
 * re-stamps createdAt so the drain truly delivers the moved row next); the
 * helpers here only keep the UI honest in the moment between a click and the
 * fresh list.
 */

/** One of the caller's own queued messages, in drain order (server truth). */
export interface QueuedItem {
  /** pending_chat_messages id — the handle the control endpoints take. */
  id: string;
  /** 1-based position in the caller's user queue. */
  position: number;
  content: string;
  createdAt: string;
  attachmentCount: number;
}

/** Server refusal codes (backend crossmodel.controller applyQueueControl). */
export type QueueRefusalCode = 'QUEUE_ITEM_GONE' | 'QUEUE_NOT_OWNER' | 'QUEUE_NOT_USER_ROW' | 'QUEUE_BLOCKED_BY_OTHER';

/**
 * The INTERRUPT affordance (ticket b54efe5d — owner report 2026-11-05: "poor ui
 * design choice for steer/send now … it should just be a small button to
 * interrupt next to queued text area").
 *
 * WHAT IT REPLACED. The first cut of interrupt (ea04454c) put a two-word
 * segmented pill in the toolbar — "Queue | Send now" ("Steer | Send now" on a
 * coding run) — sitting beside the send circle. Three problems, all structural:
 *   1. it took more horizontal room than the control it changed, on a toolbar
 *      that already holds attach, effort, mic, stop and send;
 *   2. it was a STICKY MODE: after one interrupt the composer stayed armed, so
 *      the next ordinary send silently interrupted a later run — a mode with a
 *      destructive meaning left switched on;
 *   3. it duplicated the queued-messages panel, which already offers per-row
 *      "Run now" (promote + stop) for exactly the message you want to send.
 *
 * WHAT IT IS NOW. The send circle keeps exactly ONE meaning per surface —
 * queue (plain chat) / steer (coding run) — and interrupting is its own SMALL
 * gesture shown only while it can do something: a run is live AND there is a
 * draft to send. No mode, no stored state, nothing to leave armed.
 */

/** The interrupt control's words. `label` is the ACCESSIBLE NAME — it must
 *  carry the side effect ("stop"), because an icon-only button beside a submit
 *  circle otherwise reads as a second, ordinary "Send now" and a voice-control
 *  user saying "click Send now" would silently kill their live run. `title` is
 *  the hover/long-press tooltip with the same promise in friendlier words. */
export const INTERRUPT_AFFORDANCE: Record<'chat' | 'code', { label: string; title: string }> = {
  chat: {
    label: 'Send now — stop the current answer',
    title: 'Send now — stop this answer and send your message immediately.',
  },
  code: {
    label: 'Send now — stop this run',
    title: 'Send now — stop this run and send your message immediately.',
  },
};

/**
 * Whether the small interrupt control should render. It is a GESTURE, not a
 * mode: it appears only when pressing it does something the send circle does
 * not, and disappears again the moment the run ends or the draft is cleared.
 *
 * NOTE the inputs describe the COMPOSER's state, not the send circle's verb: a
 * live run means the plain send queues and the coding send steers, so either
 * way the interrupt is a distinct action. `hasDraft` is what makes the gesture
 * meaningful — with an empty draft the send circle is already Stop
 * (`stopAsPrimary`), and rendering this too would put two Stops on screen.
 */
export function showInterruptControl(args: {
  /** A run is live — so a plain send queues it, and a coding send steers it. */
  streaming: boolean;
  /** A draft (text, image or upload) exists that the interrupt would send. */
  hasDraft: boolean;
  /** The host can actually interrupt here (a signed-in chat queue, or a live
   *  coding session). A guest/chatless composer passes false. */
  canInterrupt: boolean;
}): boolean {
  return !!args.streaming && !!args.hasDraft && !!args.canInterrupt;
}

/** The caption under a queued bubble — states the POSITION when known, so the
 *  person can see their own place instead of a bare "Queued". */
export function queuedCaption(args: { position: number | null; coding: boolean; held?: boolean }): string {
  if (args.held) return 'Queued — sends when this answer finishes';
  if (args.coding) return 'Queued — folds into the run at its next step';
  if (args.position && args.position > 0) {
    return `Queued #${args.position} — runs when this turn finishes`;
  }
  return 'Queued — runs when this turn finishes';
}

/** Which per-row controls are usable at an index (ends disable cleanly rather
 *  than firing a no-op round trip). */
export function queueRowActions(index: number, total: number): { up: boolean; down: boolean; promote: boolean } {
  return {
    up: index > 0,
    down: index >= 0 && index < total - 1,
    promote: index > 0,
  };
}

/**
 * Optimistic reorder for the instant between the click and the server's fresh
 * list. Returns a NEW array (never mutates) and is a no-op at the ends, so a
 * double-click can never corrupt the rendering order.
 */
export function moveItem<T extends { id: string }>(items: readonly T[], id: string, direction: 'up' | 'down'): T[] {
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return [...items];
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [row] = next.splice(idx, 1);
  next.splice(target, 0, row);
  return next;
}

/** Re-number positions after a local move so a badge never shows a stale slot. */
export function withPositions<T extends { position: number }>(items: readonly T[]): T[] {
  return items.map((it, i) => ({ ...it, position: i + 1 }));
}

/** What a server refusal means to the person — never a bare "failed". */
export function queueRefusalMessage(code: QueueRefusalCode | string | undefined): string {
  switch (code) {
    case 'QUEUE_NOT_OWNER':
      return 'Only the sender can change that queued message.';
    case 'QUEUE_NOT_USER_ROW':
      return 'That queued message came from a machine sender — it can’t be changed from here.';
    case 'QUEUE_ITEM_GONE':
      return 'That message already started or was removed — the queue is refreshed.';
    case 'QUEUE_BLOCKED_BY_OTHER':
      return 'Someone else is waiting on the message next to that one — its place is theirs to keep.';
    default:
      return 'Could not update the queue — refreshing it now.';
  }
}

/** Extract the queue payload from an axios-shaped error (the control endpoints
 *  return the FRESH list even on a refusal, so the UI recovers in one hop). */
export function queueFromError(err: any): QueuedItem[] | null {
  const raw = err?.response?.data?.data?.queue;
  return Array.isArray(raw) ? (raw as QueuedItem[]) : null;
}

/** Extract the refusal code from an axios-shaped error. */
export function refusalCodeFromError(err: any): QueueRefusalCode | undefined {
  const code = err?.response?.data?.code;
  return typeof code === 'string' ? (code as QueueRefusalCode) : undefined;
}