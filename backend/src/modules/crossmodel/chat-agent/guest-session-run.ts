/**
 * Guest (anonymous) session runs — the liveness marker a RELOADED guest tab
 * reads (owner report 2026-09-26: a guest who refreshed mid-answer came back
 * to a chat with the assistant turn GONE — the run kept going server-side,
 * but a guest chat lives in localStorage + the 24h Redis `cm_session:<id>`
 * history, and the assistant message was only ever appended from the stream
 * in the tab that was open).
 *
 * Chat runs already publish their liveness cross-process (chat-busy.ts, keyed
 * on chatId). Anonymous runs are keyed on the session id and used to be
 * process-local only. This leaf module mirrors the chat-busy pattern for them:
 *   - `chatSessionRunKey(sid)` — the in-process live-runs key (moved here from
 *     chat-agent.service so the controller can read it without the service's
 *     import graph; the service re-exports it).
 *   - a Redis marker `cm_session_run:<sid>` (TTL 60 s, heartbeat-refreshed by
 *     the run) so `GET /session/:id/state` answers `active` truthfully on
 *     EITHER blue/green instance — the ALB has no stickiness, so the reloaded
 *     tab lands on the other box half the time.
 *   - `isGuestSessionRunActive(sid)` — local registry OR the Redis marker.
 * Fail-open on Redis errors (a hiccup reads "not active" — the client then
 * shows what the session history holds, never a phantom spinner).
 */

import redisClient from '../../../config/redis';
import { isRunActive } from '../coding/live-runs';
import logger from '../../../utils/logger';

/** Live-run key for an ANONYMOUS session's agent run (cm_session identity). */
export function chatSessionRunKey(sessionId: string): string {
  return `chat:session:${sessionId}`;
}

const MARKER_PREFIX = 'cm_session_run:';
/** Same window as chat-busy's LIVE_RUN_TTL_SEC: a hard-crashed run stops
 *  reading "active" within a minute; the heartbeat keeps a live one fresh. */
export const GUEST_RUN_TTL_SEC = 60;

export const guestSessionRunMarkerKey = (sessionId: string): string => `${MARKER_PREFIX}${sessionId}`;

/** Write (or refresh) the cross-process liveness marker. Best-effort. */
export async function markGuestSessionRunLive(sessionId: string): Promise<void> {
  try {
    await redisClient.set(guestSessionRunMarkerKey(sessionId), String(Date.now()), { EX: GUEST_RUN_TTL_SEC });
  } catch (err: any) {
    logger.warn(`guest-session-run: marker write failed for ${sessionId.slice(0, 8)}: ${err?.message ?? err}`);
  }
}

/** Drop the marker at run end (the TTL is the backstop for a lost finally). */
export async function clearGuestSessionRunLive(sessionId: string): Promise<void> {
  try {
    await redisClient.del(guestSessionRunMarkerKey(sessionId));
  } catch { /* the key expires on its own within GUEST_RUN_TTL_SEC */ }
}

/**
 * TRUE while a run for this session is live in THIS process (registry) or in
 * any process (marker). A Redis error degrades to the local answer only.
 */
export async function isGuestSessionRunActive(sessionId: string): Promise<boolean> {
  if (isRunActive(chatSessionRunKey(sessionId))) return true;
  try {
    const n = await redisClient.exists(guestSessionRunMarkerKey(sessionId));
    return Number(n) > 0;
  } catch {
    return false;
  }
}
