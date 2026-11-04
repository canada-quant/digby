/**
 * Chat-list events (ticket 6201e0ee) — per-user server push for sidebar
 * invalidation.
 *
 * WHY: framework lanes (supervisors, ticket dispatchers, spawned children)
 * mutate chat rows server-side — archive_chat, rename_chat, move_chat,
 * start_coding_session, create_chat — while the owner's web sidebar held a
 * list fetched at mount. The existing delta feed (GET /chats/changes, ticket
 * d6b2eef5) already reconciles on a poll, but its cadence is 15 s active /
 * 60 s idle AND it can never report an ARCHIVE made by another lane (the
 * default list excludes archived rows — the feed answers "what is visible
 * and changed", so a row that just became invisible is not in it). The owner
 * had to refresh the page to see any of it.
 *
 * This module is the push half: an invalidation notice per affected user,
 * delivered to every connected client of that user. Delivery is a hint to
 * re-run the existing delta fetch — the notice itself carries NO chat data
 * (no title, no content): just { kind, chatId, at }. The client then pulls
 * GET /chats/changes with its watermark, so authorization, row shape, and
 * visibility stay in exactly one place: the existing list path.
 *
 * Fan-out is two-tier, mirroring worktree-remote-read:
 *   1. in-process subscribers (this box's own /chats/events streams) —
 *      delivered synchronously by the mutating request, and
 *   2. a Redis pub/sub channel shared by every box, so a mutation served by
 *      box A invalidates a sidebar connected to box B behind the ALB. The
 *      publishing box skips its OWN echo (it already delivered locally) —
 *      a per-process sender id in the envelope, never a payload field.
 *
 * SECURITY: the SSE endpoint authenticates (optionalAuthenticate — the
 * ?token= EventSource fallback is accepted) and subscribes the caller as
 * their OWN user id; emissions carry only the target userId and a chat id —
 * a chat id by itself leaks nothing (the row still 404s without access).
 *
 * Kill switch: CHAT_EVENTS_DISABLED=1 — emissions and the endpoint both
 * answer empty; the sidebar falls back to the existing delta poll alone.
 *
 * Best-effort by design: publishChatListEvent never throws — an invalidation
 * hiccup must never fail the mutation it observes (same posture as audit()).
 */

import { randomUUID } from 'crypto';
import logger from '../../../utils/logger';

/** The Redis channel every box's web backend shares (cross-box fan-out). */
export const CHAT_EVENTS_CHANNEL = 'digby:chat-events';

/** One invalidation notice — a hint to re-run the delta fetch, never data. */
export interface ChatListEvent {
  /**
   * Which mutation class the sidebar should reconcile (client-side logging).
   * 'chat.message' (ticket a4370dd1) is NOT a list mutation: it announces an
   * ACCEPTED machine message (an agent-to-agent send_chat_message) landed in
   * chatId — the sidebar quietly refreshes the row (the a4370dd1 toast was
   * retired by the 9d07fd1f quiet front end; no toast fires).
   *
   * project.* kinds (owner 2026-10-27 stale-rename sweep, review round 2
   * defect 2): a FOLDER row mutated — renamed/archived/restored/deleted. The
   * chat-row delta feed (GET /chats/changes) is chat-scoped and can never see
   * folder rows, so a folder renamed in another tab kept the old name in
   * every other sidebar until a manual reload. The client's answer is ONE
   * projectsApi.list() pull (authorization/visibility stay in that path).
   */
  kind: 'chat.created' | 'chat.archived' | 'chat.restored' | 'chat.renamed' | 'chat.moved' | 'chat.deleted' | 'chat.message'
    | 'project.renamed' | 'project.archived' | 'project.restored' | 'project.deleted';
  /** The chat row that changed (chat.* kinds — a bare id; authorization stays in the fetch). */
  chatId?: string;
  /** The project/folder row that changed (project.* kinds — same hint-only contract). */
  projectId?: string;
  /** Wall-clock ISO at emission (frames stamp delivery for the client log). */
  at: string;
  /**
   * 'chat.message' only — the SENDING chat (agent traffic). Same-user fleet:
   * the sender is one of the receiving user's own chats, so its id/title
   * leaks nothing (the row 404s without access). Never message content.
   */
  sourceChatId?: string;
  /** 'chat.message' only — the sending chat's title at send time. */
  sourceTitle?: string;
}

/** Wire envelope: the target user, the notice, and the publishing process. */
interface ChatEventEnvelope {
  sender: string;
  userId: string;
  event: ChatListEvent;
}

type Listener = (e: ChatListEvent) => void;

/** Per-process identity — lets the bridge skip its own publishes (already
 * delivered synchronously) so a local listener is never notified twice. */
const SENDER_ID = randomUUID();

/** In-process per-user listeners — one open sidebar tab per entry. */
const listenersByUser = new Map<string, Set<Listener>>();

/** The app's Redis client slice this module uses (worktree-remote-read's
 * injectable-shape discipline). */
interface PubSubRedis {
  publish: (channel: string, message: string) => Promise<number>;
  duplicate: () => PubSubRedis;
  connect: () => Promise<unknown>;
  on?: (event: string, cb: (...a: any[]) => void) => unknown;
  subscribe: (channel: string, listener: (message: string) => void) => Promise<unknown>;
  quit?: () => Promise<unknown>;
}

/** The app's Redis client, loaded lazily: config/redis validates the whole
 * env at import time, and this module is reached from platform.service, which
 * many hermetic suites import without a Redis mock (worktree-remote-read
 * discipline). */
async function appRedis(): Promise<PubSubRedis | null> {
  try {
    const mod = await import('../../../config/redis');
    return mod.default as unknown as PubSubRedis;
  } catch {
    return null;
  }
}

// ── In-process fan-out ────────────────────────────────────────────────────────

/** Deliver a notice to this user's in-process listeners (local + bridge leg). */
function deliverLocal(userId: string, event: ChatListEvent): void {
  const set = listenersByUser.get(userId);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(event);
    } catch {
      /* one broken subscriber never breaks the fan-out */
    }
  }
}

// ── Redis cross-box leg ───────────────────────────────────────────────────────

/**
 * The cross-box bridge: ONE subscriber per process, lazily connected on the
 * FIRST listener (Redis pub/sub does not replay missed messages, so the
 * bridge only needs to run while this box holds open /chats/events streams),
 * re-delivering every other box's messages to the local listeners. A bridge
 * hiccup is a warn + in-process-only mode — the delta poll backstops.
 */
let bridgeStarting: Promise<void> | null = null;
let bridgeUp = false;

function startRedisBridge(): Promise<void> {
  if (bridgeUp) return Promise.resolve();
  if (bridgeStarting) return bridgeStarting;
  // Review N6 (6201e0ee): the previous sentinel compared the cached promise
  // against a DERIVED one and never matched, so a FAILED bridge attempt was
  // latched for the process lifetime (never retried — the docblock's "a later
  // subscribe retries" was dead code). Plain shape now: an `up` flag set only
  // on success, and the in-flight promise CLEARED after settle (finally), so
  // the next subscribe genuinely retries a failed bridge.
  bridgeStarting = (async () => {
    const client = await appRedis();
    if (!client) throw new Error('redis client unavailable');
    const sub = client.duplicate();
    sub.on?.('error', (err: any) => logger.warn(`chat-events: bridge subscriber error — ${err?.message ?? err}`));
    await sub.connect();
    await sub.subscribe(CHAT_EVENTS_CHANNEL, (message: string) => {
      let env: ChatEventEnvelope | null = null;
      try { env = JSON.parse(message); } catch { return; }
      if (!env || typeof env.userId !== 'string' || !env.event) return;
      if (env.sender === SENDER_ID) return; // own echo — already delivered locally
      deliverLocal(env.userId, env.event);
    });
    bridgeUp = true; // connected + subscribed — never re-subscribe this process
  })().catch((err: any) => {
    logger.warn(`chat-events: cross-box bridge unavailable — ${err?.message ?? err} (in-process fan-out only)`);
  }).finally(() => {
    bridgeStarting = null; // settled (either way) — a later subscribe may retry
  });
  return bridgeStarting;
}

/**
 * Subscribe this user's in-process listener (one open /chats/events stream).
 * Returns an unsubscribe fn. Starting the Redis bridge lazily here (not at
 * import) keeps hermetic suites that never subscribe off Redis entirely.
 */
export function subscribeChatEvents(userId: string, listener: Listener): () => void {
  let set = listenersByUser.get(userId);
  if (!set) {
    set = new Set();
    listenersByUser.set(userId, set);
  }
  set.add(listener);
  void startRedisBridge();
  return () => {
    const s = listenersByUser.get(userId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) listenersByUser.delete(userId);
  };
}

// ── Emission (the seam mutation sites call) ──────────────────────────────────

/**
 * Notify every connected client of this user that their chat list changed
 * (or, for kind 'chat.message', that an accepted machine message landed —
 * ticket a4370dd1: the sidebar reconciles the row instead of waiting for
 * the poll; the toast itself was retired by 9d07fd1f's quiet front end).
 * Best-effort fire-and-forget: in-process listeners synchronously, the Redis
 * leg async — neither allowed to throw into the mutation. A malformed chat id
 * (short / wrong charset) is dropped rather than riding the wire; real ids are
 * uuids or anon-<sid> shapes.
 */
export function publishChatListEvent(userId: string, event: Omit<ChatListEvent, 'at'>): void {
  if (typeof userId !== 'string' || !userId) return;
  // project.* kinds carry the FOLDER id in projectId; chat.* kinds the chat id
  // in chatId (owner 2026-10-27). Either way a malformed id never rides the
  // wire — dropped rather than pushed.
  const isProjectKind = typeof event.kind === 'string' && event.kind.startsWith('project.');
  const chatId = String(event.chatId || '');
  const projectId = String(event.projectId || '');
  if (isProjectKind) {
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(projectId)) return;
  } else if (!/^[A-Za-z0-9_-]{8,64}$/.test(chatId)) return;
  if (event.kind === 'chat.message') {
    // The sender id is optional on the wire (a re-added arrival surface
    // would fall back to a generic label) — but a MALFORMED one never rides
    // it (same shape gate as chatId).
    const sourceChatId = String(event.sourceChatId || '');
    if (sourceChatId && !/^[A-Za-z0-9_-]{8,64}$/.test(sourceChatId)) return;
  }
  const notice: ChatListEvent = {
    kind: event.kind,
    ...(isProjectKind ? { projectId } : { chatId }),
    ...(event.kind === 'chat.message' ? { sourceChatId: event.sourceChatId, sourceTitle: event.sourceTitle } : {}),
    at: new Date().toISOString(),
  };
  // Always ride Redis: the mutating request may live on a DIFFERENT box than
  // every open sidebar (behind the ALB), and this box's bridge skips its own
  // echo, so local listeners are never double-delivered.
  deliverLocal(userId, notice);
  void appRedis()
    .then((client) => client
      ? client.publish(CHAT_EVENTS_CHANNEL, JSON.stringify({ sender: SENDER_ID, userId, event: notice } satisfies ChatEventEnvelope))
      : Promise.resolve(0))
    .catch((err: any) => logger.warn(`chat-events: publish failed — ${err?.message ?? err}`));
}

/** Test seam: reset the bridge state + drop every listener (hermetic suites). */
export function __resetChatEventsForTest(): void {
  listenersByUser.clear();
  bridgeStarting = null;
  bridgeUp = false;
}
