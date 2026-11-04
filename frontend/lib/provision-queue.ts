/**
 * Send-while-provisioning queue for coding sessions (owner 2026-10-14: "when
 * you send a message and the session isn't provisioned you should queue it
 * and not show 'Session is still provisioning — one moment' but store it and
 * then send when it's ready").
 *
 * A send on a session whose worktree is still provisioning used to toast and
 * drop on the floor (lib/composer-guard.ts 'blocked-toast'). Now the view
 * keeps the message here — echoed as a queued bubble — and hands it to the
 * normal send path the moment the session reads 'ready':
 *
 *   - with a pending auto-start message (the message that CREATED the
 *     session) the queued text rides that first run (`mergeIntoInitial`), so
 *     the two never race for the session's single run slot;
 *   - otherwise the queue drains as one fresh run (`mergeQueued`).
 *
 * The queue is mirrored to localStorage per session so a reload while
 * provisioning keeps it (images only when the stash stays small — upload ids
 * ride their own 15-min Redis TTL). Pure + storage-guarded: every accessor
 * swallows a throwing / missing storage and the view works without it.
 */

import type { ChatImage } from './api/coding';

/** A staged document chip (AttachmentInfo shape, kept loose so this leaf has no UI import). */
export interface QueuedUpload {
  uploadId: string;
  filename?: string;
  type?: string;
  localPreview?: string;
}

export interface ProvisionQueued {
  /** Echo bubble id (`pq-*`) — never collides with server ids. */
  id: string;
  message: string;
  images: ChatImage[];
  uploads: QueuedUpload[];
  createdAt: string;
}

export const PROVISION_QUEUE_ID_PREFIX = 'pq-';
export const PROVISION_QUEUE_CAPTION = 'Queued — sends as soon as the session is ready';
/** A stash older than this is stale (the session long since provisioned or was abandoned). */
export const PROVISION_QUEUE_TTL_MS = 6 * 60 * 60 * 1000;
/** Images are dropped from the persisted copy above this many JSON chars. */
export const PROVISION_QUEUE_IMAGE_BUDGET = 1_500_000;

const storageKey = (sessionId: string) => `digby.provisionQueue.${sessionId}`;

export function isProvisionQueueId(id: string | undefined | null): boolean {
  return typeof id === 'string' && id.startsWith(PROVISION_QUEUE_ID_PREFIX);
}

export function makeQueued(args: { message: string; images?: ChatImage[]; uploads?: QueuedUpload[]; now?: number }): ProvisionQueued {
  const now = args.now ?? Date.now();
  return {
    id: `${PROVISION_QUEUE_ID_PREFIX}${now}-${Math.random().toString(36).slice(2, 8)}`,
    message: args.message,
    images: args.images ?? [],
    uploads: args.uploads ?? [],
    createdAt: new Date(now).toISOString(),
  };
}

/** Join queued messages (oldest first) into ONE send: text paragraphs, every image, every upload. */
export function mergeQueued(items: ProvisionQueued[]): { message: string; images: ChatImage[]; uploads: QueuedUpload[] } {
  const message = items.map((i) => i.message.trim()).filter(Boolean).join('\n\n');
  return {
    message,
    images: items.flatMap((i) => i.images),
    uploads: items.flatMap((i) => i.uploads),
  };
}

/** The auto-start (session-creating) message first, then everything queued behind it. */
export function mergeIntoInitial(initialMessage: string, items: ProvisionQueued[]): string {
  const rest = mergeQueued(items).message;
  const head = initialMessage.trim();
  if (!rest) return head;
  return head ? `${head}\n\n${rest}` : rest;
}

/**
 * What the drain effect should do this render.
 * - 'wait'  — nothing queued, the session is not ready yet, a run is live
 *             (the queue goes out as the next run once it ends), or the
 *             session-creating message has not been auto-started (it carries
 *             the queue itself).
 * - 'send'  — start one fresh run with the merged queue.
 */
export function drainAction(args: {
  queued: number;
  sessionStatus?: string;
  liveRunning: boolean;
  initialPending: boolean;
}): 'wait' | 'send' {
  if (args.queued <= 0) return 'wait';
  if (args.initialPending) return 'wait';
  if (args.sessionStatus !== 'ready') return 'wait';
  if (args.liveRunning) return 'wait';
  return 'send';
}

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, on an empty list) the session's queue. Never throws. */
export function saveProvisionQueue(sessionId: string, items: ProvisionQueued[], store: Storage | null = storage()): void {
  if (!store || !sessionId) return;
  try {
    if (!items.length) { store.removeItem(storageKey(sessionId)); return; }
    let json = JSON.stringify({ at: Date.now(), items });
    if (json.length > PROVISION_QUEUE_IMAGE_BUDGET) {
      json = JSON.stringify({ at: Date.now(), items: items.map((i) => ({ ...i, images: [] })) });
    }
    store.setItem(storageKey(sessionId), json);
  } catch {
    /* quota / private mode — the in-memory queue still works */
  }
}

/** Read the session's persisted queue (stale or malformed stashes read as empty and are removed). */
export function loadProvisionQueue(sessionId: string, store: Storage | null = storage(), now = Date.now()): ProvisionQueued[] {
  if (!store || !sessionId) return [];
  try {
    const raw = store.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { at?: number; items?: unknown };
    const fresh = typeof parsed.at === 'number' && now - parsed.at < PROVISION_QUEUE_TTL_MS;
    const items = Array.isArray(parsed.items) ? parsed.items.filter(isQueued) : [];
    if (!fresh || !items.length) { store.removeItem(storageKey(sessionId)); return []; }
    return items;
  } catch {
    return [];
  }
}

function isQueued(v: unknown): v is ProvisionQueued {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return isProvisionQueueId(o.id as string)
    && typeof o.message === 'string'
    && Array.isArray(o.images)
    && Array.isArray(o.uploads)
    && typeof o.createdAt === 'string';
}
