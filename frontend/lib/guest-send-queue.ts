/**
 * Send-while-running queue for CHATLESS plain sends (guest sessions — ticket
 * d0777a67). Guests mount CodeSessionView with chatId null, so the server's
 * per-chat busy-queue (pending_chat_messages, reached via queuePlainBehindLive)
 * does not exist for them: a mid-run guest send used to be dropped silently by
 * the C3 chatless guard while the composer's footer promise said "your message
 * queues and sends next" — the reported "queued messages doesn't seem to work
 * when not logged in".
 *
 * The queue keeps the message CLIENT-side (the provision queue for coding
 * sessions — lib/provision-queue.ts — is the template): the mid-run send is
 * echoed as a queued bubble and one merged send fires the moment the live run
 * ends (CodeSessionView's drain effect).
 *
 * Scope notes:
 *  - GUEST sessions only (plainCfg.guest === true). The signed-in
 *    createChat-failure FALLBACK also mounts chatId-less but keeps full
 *    features; it stays on the C3 hold (its sends have a real chat row on the
 *    server once the failure clears, and inventing a client queue for it would
 *    double-send with the reconcile path).
 *  - Text AND staged attachments (ticket 625773b5). Guests have the full
 *    attach surface now (the C3 "no attachments for guests" gate is lifted —
 *    the backend's open /upload route always accepted anonymous callers), so a
 *    held send must carry its uploads: the bar is snapshotted at hold time and
 *    the ids ride the drain send. Ids live their own ~15-min Redis TTL — a
 *    hold that outlives it resolves to the controller's honest drop
 *    annotation (attachment-resolution.ts), never a silent loss.
 *  - In-memory by design (a guest tab that dies mid-run loses the held draft —
 *    the draft would be equally lost typed in the composer; the guest session
 *    store keeps everything the server actually received).
 *
 * Pure + SSR-safe like provision-queue.ts: no React, no window at import.
 */

/** Echo bubble id prefix (`gq-*`) — never collides with server ids, provision
 *  echoes (`pq-*`) or send echoes (`tmp-*`). */
export const GUEST_QUEUE_ID_PREFIX = 'gq-';
/** Caption under a guest-queued bubble. */
export const GUEST_QUEUE_CAPTION = 'Queued — sends when this answer finishes';

/** A staged document chip (AttachmentInfo shape, kept loose so this leaf has no
 *  UI import) — the same shape lib/provision-queue.ts carries. */
export interface GuestQueuedUpload {
  uploadId: string;
  filename?: string;
  type?: string;
  localPreview?: string;
}

export interface GuestQueuedSend {
  /** Echo bubble id (`gq-*`). */
  id: string;
  message: string;
  /** Staged attachments held with this send (ticket 625773b5). */
  uploads: GuestQueuedUpload[];
  createdAt: string;
}

export function isGuestQueueId(id: string | undefined | null): boolean {
  return typeof id === 'string' && id.startsWith(GUEST_QUEUE_ID_PREFIX);
}

export function makeGuestQueued(args: { message: string; uploads?: GuestQueuedUpload[]; now?: number }): GuestQueuedSend {
  const now = args.now ?? Date.now();
  return {
    id: `${GUEST_QUEUE_ID_PREFIX}${now}-${Math.random().toString(36).slice(2, 8)}`,
    message: args.message,
    uploads: args.uploads ?? [],
    createdAt: new Date(now).toISOString(),
  };
}

/** Join queued messages (oldest first) into ONE send — text paragraphs
 *  separated by a blank line (mergeQueued's convention), every held upload. */
export function mergeGuestQueued(items: GuestQueuedSend[]): { message: string; uploads: GuestQueuedUpload[] } {
  return {
    message: items.map((i) => i.message.trim()).filter(Boolean).join('\n\n'),
    uploads: items.flatMap((i) => i.uploads ?? []),
  };
}

/**
 * What the guest drain effect should do this render.
 * - 'wait'  — nothing queued, or the run is still live.
 * - 'send'  — fire ONE fresh send with the merged queue (the run ended).
 */
export function guestDrainAction(args: { queued: number; liveRunning: boolean }): 'wait' | 'send' {
  if (args.queued <= 0) return 'wait';
  if (args.liveRunning) return 'wait';
  return 'send';
}

/** True when a mid-run chatless send must be HELD in the guest queue instead
 *  of dropped by the C3 guard: a live run AND a guest plain session (the
 *  authed fallback keeps the old hold). */
export function stageChatlessBehindLive(args: { liveRunning: boolean; guest: boolean }): boolean {
  return args.liveRunning && args.guest;
}
