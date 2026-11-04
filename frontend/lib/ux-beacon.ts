/**
 * The perceived-latency beacon emitter (audit 2026-09-26 guest-persistence-4 —
 * the server side `POST /api/crossmodel/ux/beacon` had shipped with NO client
 * sender, so first paint / Dig-deeper taps / the guest "Sign in for a deeper
 * look" tap / abandons were never measured for anyone).
 *
 * Fire-and-forget, never throws, never blocks: `navigator.sendBeacon` when the
 * browser has it (survives a closing tab — the `abandon` event's whole point),
 * else `fetch` with `keepalive`. A guest passes its client-minted session uuid
 * so the row keys on `anon-<sid>` next to ux_ttft / compute_policy.
 *
 * Server kill switch: UX_BEACON_DISABLED=1 records nothing.
 */

export type UxBeaconEvent = 'first_paint' | 'revision_seen' | 'tap' | 'abandon' | 'chip_seen'
  /** Stream drops (2026-10-20, lib/stream-drop-beacon.ts): the live answer's SSE dropped / came back. */
  | 'stream_drop' | 'stream_resume';

export interface UxBeaconPayload {
  event: UxBeaconEvent;
  chatId?: string | null;
  messageId?: string | null;
  /** client-measured ms (send → first paint, …) — integers ≥ 0 only */
  ms?: number;
  mode?: string;
  /** tap target: 'escalate' | 'signin_deeper' */
  target?: string;
  /** guest sessions: the client-minted anonymous session uuid */
  sessionId?: string | null;
  /** stream_drop / stream_resume: reconnect attempts so far (integer ≥ 0) */
  attempts?: number;
  /** stream_drop / stream_resume: a lowercase slug — 'retrying' | 'resend' | 'resumed' | 'ended' | 'gone' | … */
  outcome?: string;
  /** stream_drop / stream_resume: whether this tab is a guest */
  guest?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const UX_BEACON_PATH = '/api/crossmodel/ux/beacon';

/** The JSON body the server's zod schema accepts (pure; invalid ids / ms dropped, never a throw). */
export function uxBeaconBody(p: UxBeaconPayload): Record<string, unknown> {
  const body: Record<string, unknown> = { event: p.event };
  if (typeof p.chatId === 'string' && UUID_RE.test(p.chatId)) body.chatId = p.chatId;
  if (typeof p.messageId === 'string' && UUID_RE.test(p.messageId)) body.messageId = p.messageId;
  if (typeof p.sessionId === 'string' && UUID_RE.test(p.sessionId)) body.sessionId = p.sessionId;
  if (typeof p.ms === 'number' && Number.isFinite(p.ms) && p.ms >= 0) body.ms = Math.min(24 * 60 * 60 * 1000, Math.round(p.ms));
  if (typeof p.mode === 'string' && p.mode) body.mode = p.mode.slice(0, 32);
  if (typeof p.target === 'string' && p.target) body.target = p.target.slice(0, 32);
  if (typeof p.attempts === 'number' && Number.isFinite(p.attempts) && p.attempts >= 0) body.attempts = Math.min(10_000, Math.floor(p.attempts));
  if (typeof p.outcome === 'string' && /^[a-z_]{1,32}$/.test(p.outcome)) body.outcome = p.outcome;
  if (typeof p.guest === 'boolean') body.guest = p.guest;
  return body;
}

export interface UxBeaconTransport {
  sendBeacon?: (url: string, data: Blob) => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}

/** Send one beacon. Returns true when a transport accepted it (best-effort; never throws). */
export function sendUxBeacon(p: UxBeaconPayload, transport?: UxBeaconTransport): boolean {
  try {
    const body = JSON.stringify(uxBeaconBody(p));
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const sendBeacon = transport?.sendBeacon ?? (nav && typeof nav.sendBeacon === 'function' ? nav.sendBeacon.bind(nav) : undefined);
    if (sendBeacon) {
      try {
        if (sendBeacon(UX_BEACON_PATH, new Blob([body], { type: 'application/json' }))) return true;
      } catch { /* fall through to fetch */ }
    }
    const f = transport?.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) return false;
    void Promise.resolve(f(UX_BEACON_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'include' })).catch(() => { /* never surfaces */ });
    return true;
  } catch {
    return false;
  }
}
