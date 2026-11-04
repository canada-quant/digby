import axios from 'axios';
import { isSessionDead, markSessionAlive, markSessionDead } from './session-latch';
import { VISITOR_HEADER, visitorIdForHeader } from './visitor-analytics';

// Default request timeout (2026-10-09 Windows-shell hang fix). axios has NO
// default timeout — a request whose TCP connection is established but whose
// response never arrives (a wedged proxy, a stalled backend, half-open NAT
// state on a laptop resuming from sleep) NEVER rejects. Every startup fetch
// that clears its loading state in .then/.finally then hangs forever, which
// is exactly the "shell opens and spins forever" report: the app renders,
// but the sidebar/news/auth promises never settle.
//
// 45s is deliberately generous — the bound exists to convert "an hour of
// spinner" into "an honest error state", not to race slow-but-healthy
// requests. LLM-backed REST endpoints that legitimately take longer must
// pass their own `{ timeout: ... }` (axios per-request overrides the
// instance default). SSE/chat STREAMS are unaffected: they ride EventSource
// or raw fetch (see lib/chat-events.ts, CodeSessionView), never this client.
export const API_TIMEOUT_MS = 45_000;

const apiClient = axios.create({
  baseURL: '/api', // Use Next.js API proxy
  withCredentials: true,
  timeout: API_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json',
  },
});


// Request interceptor to add auth token
apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    // First-party visitor analytics (owner 2026-10-07): the visitor id rides API calls so login / register stitch
    // this browser to the account even when the dg_vid cookie is blocked. Null for a Digby Kids session and under
    // NEXT_PUBLIC_VISITOR_ANALYTICS_DISABLED=1 (lib/visitor-analytics.ts).
    const visitorId = visitorIdForHeader();
    if (visitorId) config.headers[VISITOR_HEADER] = visitorId;
    return config;
  },
  (error) => Promise.reject(error)
);

// ── SSE auth freshness (2026-07-23 "Chat not found" fix) ────────────────────
// The EventSource stream GET authenticates ONLY via the httpOnly cm_access
// cookie (EventSource can't set headers). That cookie holds a short-lived
// (15m) access token, so after ~15m of page idle the stream silently arrives
// anonymous even though the app looks logged in — and the backend ownership
// gate then rejects the user's own chatId. The backend now re-issues the
// cookie on every Bearer-authenticated response (sliding re-issue), so any
// recent apiClient call guarantees a fresh cookie. Track the last one here.
let lastAuthedSuccessAt = 0;

// Response interceptor to handle token refresh
apiClient.interceptors.response.use(
  (response) => {
    // Any successful request that carried a Bearer token re-issued cm_access.
    if (response.config?.headers?.Authorization) { lastAuthedSuccessAt = Date.now(); markSessionAlive(); }
    return response;
  },
  async (error) => {
    const originalRequest = error.config;

    // If token expired, try to refresh
    // Skip refresh for auth endpoints — let the original error propagate (e.g. "Invalid credentials")
    const reqUrl: string = originalRequest.url || '';
    const isAuthEndpoint = reqUrl.includes('/auth/login') || reqUrl.includes('/auth/register') || reqUrl.includes('/auth/refresh');

    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint) {
      // Dead-session refresh gate (f129, FS disposition 2026-10-13): once a refresh
      // was REFUSED (401/403 → markSessionDead below) and no fresh login has stored
      // a new access token, re-attempting refresh only re-presents the dead refresh
      // cookie — the post-rotation invalid-signature stream (~550 401s/h, fed every
      // 60 s by the supervisor side panels polling on a corpse session). Reject
      // immediately; a fresh login stores a token (this gate lifts) and the next
      // Bearer success clears the latch (markSessionAlive above).
      if (isSessionDead() && !localStorage.getItem('accessToken')) {
        return Promise.reject(error);
      }
      originalRequest._retry = true;

      try {
        const { data } = await axios.post(
          '/api/auth/refresh',
          {},
          // BOUNDED (2026-10-09 hang fix): this raw axios call bypassed the
          // instance timeout above — a hung refresh left the ORIGINAL request
          // (and every await behind it) pending forever. 15s is plenty for a
          // token round-trip; on timeout the rejection lands in the catch below
          // exactly like a refused refresh.
          { withCredentials: true, timeout: 15_000 }
        );

        localStorage.setItem('accessToken', data.data.accessToken);
        originalRequest.headers.Authorization = `Bearer ${data.data.accessToken}`;

        return apiClient(originalRequest);
      } catch (refreshError) {
        // Refresh failed, clear auth but don't redirect (let pages handle it)
        localStorage.removeItem('accessToken');
        // Loop #19: a refresh the server REFUSED (401/403 — the refresh token is
        // gone) means no poller can succeed until a new login; latch it so
        // usePolling stops re-presenting the dead session every tick. A network
        // blip during refresh is NOT definitive — keep polling.
        const st = (refreshError as { response?: { status?: number } } | null)?.response?.status;
        if (st === 401 || st === 403) markSessionDead();
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

const AUTH_FRESH_WINDOW_MS = 60_000;

/**
 * Definitive-auth-failure predicate (ticket 05303f58, BUG 1). The response
 * interceptor above already runs 401 → refresh → retry, so a rejection that
 * reaches a page means refresh genuinely failed (a surviving 401 = the session
 * is over) OR the call hit a non-auth error (network drop, 5xx, an aborted
 * request). Only the first case justifies deleting localStorage 'accessToken'
 * and bouncing to /login with a "session expired" toast — pages used to treat
 * ANY rejection as expiry, signing users out over a transient blip. Pages:
 * gate the token-delete + bounce on this helper; on false keep the token and
 * fail soft (console.warn + the page's existing loading/error state).
 */
export function isDefinitiveAuthFailure(err: unknown): boolean {
  return (err as { response?: { status?: number } } | null)?.response?.status === 401;
}

/**
 * Guarantee the httpOnly cm_access cookie (the SSE stream's ONLY auth transport)
 * is fresh before opening an EventSource. No-ops for anonymous users and when
 * an authed API call succeeded within the last minute (the normal case right
 * after createChat). Otherwise makes one cheap authed round-trip — the sliding
 * backend re-issue refreshes the cookie, and the 401 path self-heals via the
 * refresh interceptor above. Never rejects: a failed ping must not block a send.
 */
export async function ensureFreshAuthCookie(): Promise<void> {
  try {
    if (typeof window === 'undefined') return;
    if (!localStorage.getItem('accessToken')) return; // anonymous — nothing to refresh
    if (Date.now() - lastAuthedSuccessAt < AUTH_FRESH_WINDOW_MS) return;
    await apiClient.get('/auth/me');
    lastAuthedSuccessAt = Date.now();
  } catch {
    // Worst case: the stream errors with the actionable STREAM_AUTH_REQUIRED
    // message instead of the misleading 'Chat not found'.
  }
}

export default apiClient;
