/**
 * session-browser-client.ts (ticket ea3ad8a8) — the backend's HTTP client for
 * the hosted hardened browser service.
 *
 * The service is a standalone pinned-Chromium container (browser-service/);
 * this module is the pure-HTTP caller: it derives the SAME per-session HMAC
 * token the service derives (secret shared via env), and POSTs actions.
 *
 * All routing decisions live in the router/driver — this module never decides
 * anything, it just talks HTTP. No Playwright import on the backend side.
 */

import axios, { AxiosInstance } from 'axios';
import logger from '../../../utils/logger';

export const BROWSER_SERVICE_ENABLED = () =>
  /^(1|true|yes)$/i.test(process.env.BROWSER_SERVICE_ENABLED || '');

export const BROWSER_SERVICE_URL = () =>
  process.env.BROWSER_SERVICE_URL || 'http://browser-service:3100';

const BROWSER_SERVICE_SECRET = () => process.env.BROWSER_SERVICE_SECRET || '';

/** Derived token cache (per session key) — HMAC is cheap but we memoize anyway. */
const tokenCache = new Map<string, string>();

export function sessionBrowserToken(sessionKey: string): string {
  const cached = tokenCache.get(sessionKey);
  if (cached) return cached;
  const secret = BROWSER_SERVICE_SECRET();
  if (!secret) return '';
  // Keep the derivation in sync with browser-service/src/core.ts tokenFor().
  // crypto is imported lazily so this module stays importable in test envs
  // that mock child_process but not crypto (it's a Node builtin — always there).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHmac } = require('crypto') as typeof import('crypto');
  const token = createHmac('sha256', secret).update(`ctx:${sessionKey}`).digest('hex');
  tokenCache.set(sessionKey, token);
  return token;
}

function client(sessionKey: string, timeoutMs = 60_000): { http: AxiosInstance; token: string } | null {
  const token = sessionBrowserToken(sessionKey);
  if (!token) {
    logger.warn('session-browser: BROWSER_SERVICE_SECRET unset — hosted browser unavailable');
    return null;
  }
  const http = axios.create({
    baseURL: BROWSER_SERVICE_URL(),
    timeout: timeoutMs,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return { http, token };
}

export interface SessionBrowserAction {
  name: string;
  url?: string;
  format?: 'text' | 'html' | 'snapshot';
  selector?: string;
  text?: string;
  submit?: boolean;
  direction?: string;
  amount?: number;
  reasoning?: string;
}

export interface SessionBrowserActionResponse {
  ok: boolean;
  action: string;
  url?: string;
  content?: string;
  screenshotBase64?: string;
  links?: Array<{ text: string; href: string }>;
  error?: string;
  truncated?: boolean;
}

/** Execute one browser action in the session's own persistent context. */
export async function sessionBrowserAction(
  sessionKey: string,
  action: SessionBrowserAction,
  timeoutMs = 60_000,
): Promise<SessionBrowserActionResponse> {
  const c = client(sessionKey, timeoutMs);
  if (!c) return { ok: false, action: action.name, error: 'hosted browser service not configured (BROWSER_SERVICE_SECRET unset)' };
  try {
    const res = await c.http.post('/v1/action', { sessionId: sessionKey, action });
    return res.data as SessionBrowserActionResponse;
  } catch (e: unknown) {
    const msg = (e as { response?: { data?: { error?: string } }; message?: string });
    const detail = msg.response?.data?.error || msg.message || String(e);
    return { ok: false, action: action.name, error: `hosted browser service error: ${detail}`.slice(0, 500) };
  }
}

/** Close the session's context (state persists — next call resumes it). */
export async function sessionBrowserClose(sessionKey: string): Promise<void> {
  const c = client(sessionKey, 15_000);
  if (!c) return;
  try {
    await c.http.post('/v1/close', { sessionId: sessionKey });
  } catch {
    /* best-effort: the service's idle reaper also closes idle contexts */
  }
}

/** Cheap liveness probe — used by the router before selecting the hosted driver. */
export async function sessionBrowserAvailable(sessionKey: string): Promise<boolean> {
  const c = client(sessionKey, 3_000);
  if (!c) return false;
  try {
    const res = await c.http.get('/health');
    return res.status === 200 && res.data?.ok === true;
  } catch {
    return false;
  }
}

/** Test hook: clear the token memo (tokens are secret-derived, stable per key). */
export function __resetTokenCacheForTests(): void {
  tokenCache.clear();
}
