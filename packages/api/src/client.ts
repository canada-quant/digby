/**
 * @digby/api — the typed Digby API client.
 *
 * Extracted from the web client (`frontend/lib/api-client.ts` + `frontend/lib/api/`)
 * so the mobile apps can share it (roadmap §3.2 item 5). PURE TypeScript: zero
 * React, zero platform APIs, zero localStorage. The transport is an INJECTABLE
 * `fetch` (constructor option) so each host picks its own:
 *
 *   - web (later):      the browser `fetch` (cookie jar for the refresh cookie)
 *   - mobile:           `expo/fetch` (M1 — WinterCG-compliant, streaming-capable)
 *
 * AUTH MODEL (verified against backend/src/modules/auth/auth.controller.ts):
 *   - login/register    → `{ data: { user, accessToken } }` + an httpOnly
 *                          `refreshToken` cookie (7 days) — mobile cannot read
 *                          that cookie, so it must persist the refresh token
 *                          itself (expo-secure-store) and send it in the body
 *                          of `/auth/refresh` (the backend accepts either
 *                          `req.cookies.refreshToken || req.body?.refreshToken`).
 *   - every API call    → `Authorization: Bearer <accessToken>` (15 min TTL).
 *   - 401 on a Bearer   → single-flight refresh, then ONE retry of the original
 *                          request (the web client's `_retry` semantics).
 *
 * SSE streaming is deliberately NOT here (M1 — see apps/mobile/README.md).
 */

/** Minimal fetch-like transport. Hosts inject their own. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    credentials?: 'include' | 'omit' | 'same-origin';
    /** AbortSignal (structural — the SSE teardown path passes one through). */
    signal?: unknown;
  }
) => Promise<FetchResponse>;

/** A streaming body reader (the half of the WinterCG Response the SSE path needs). */
export interface StreamReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | string }>;
  cancel?(): Promise<void> | void;
}

/** The response shape the client consumes (a structural subset of Response). */
export interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /**
   * Optional response-header accessor. Native fetch and expo/fetch expose it;
   * the client uses it to capture the ROTATED refresh token from Set-Cookie
   * (the backend hands the new refresh token out ONLY as an httpOnly cookie —
   * auth.controller.ts — so a body-token client must read it here or lose it).
   */
  headers?: { get(name: string): string | null };
  /**
   * Optional streaming body (M0): expo/fetch (and native fetch) expose
   * `body.getReader()` for SSE. Non-streaming hosts omit it — only the SSE
   * namespace reads it.
   */
  body?: { getReader(): StreamReader };
}

/**
 * Extract the refresh token from a `Set-Cookie` header value, if present.
 * Express sets `refreshToken=<jwt>; HttpOnly; ...` on login/register/refresh.
 * RN's header map comma-joins multiple Set-Cookie headers, so the regex takes
 * the first `refreshToken=` segment and stops at the next `;` or `,`.
 */
export function refreshTokenFromSetCookie(
  headers: FetchResponse['headers']
): string | undefined {
  const raw = headers?.get?.('set-cookie');
  if (!raw) return undefined;
  const m = /(?:^|,\s*)refreshToken=([^;,\s]+)/.exec(raw);
  return m ? decodeURIComponent(m[1]) : undefined;
}

/**
 * Default transport: the host's global fetch (browser, Node 18+, RN, expo/fetch
 * — all structurally compatible). Reached via `globalThis` with a cast so this
 * package needs NO DOM lib types (it stays pure TS, lib: ES2022 only).
 */
function defaultFetch(input: string, init?: Parameters<FetchLike>[1]): Promise<FetchResponse> {
  const g = globalThis as unknown as {
    fetch?: (i: string, o?: unknown) => Promise<FetchResponse>;
  };
  if (!g.fetch) {
    return Promise.reject(
      new ApiError(0, 'No fetch implementation found — inject one via DigbyApiOptions.fetch', input)
    );
  }
  return g.fetch(input, init);
}

/** Envelope every Digby endpoint answers with (`{ success, data, message? }`). */
export interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  message?: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly url: string,
    /** True when a 401 survived a refresh attempt — the session is over. */
    public readonly definitiveAuthFailure = false
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface DigbyApiOptions {
  /** API origin, e.g. `https://digby.ai` or `http://localhost:4000`. No trailing slash. */
  baseUrl: string;
  /** Injectable transport. Defaults to global `fetch`. */
  fetch?: FetchLike;
  /**
   * The host's refresh-token source. Mobile: expo-secure-store; web: the
   * httpOnly cookie (return undefined to send a cookie-credentials request,
   * exactly like the web client's `withCredentials` refresh).
   */
  getRefreshToken?: () => string | undefined | Promise<string | undefined>;
  /** Called when login/register/refresh produce a new access token. */
  onAccessToken?: (token: string) => void;
  /** Called when a response exposes a fresh refresh token (login/refresh
   * rotation) so the host can persist it (SecureStore on mobile). */
  onRefreshToken?: (token: string) => void;
  /** Called when the session is definitively over (refresh failed). */
  onSessionExpired?: () => void;
  /** Endpoints that must NOT trigger the 401→refresh→retry loop. */
  noRefreshPaths?: string[];
}

/** Endpoints where a 401 is the answer, never a trigger to refresh. */
export const NO_REFRESH_DEFAULT: readonly string[] = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/refresh',
  '/api/auth/logout',
];

export class DigbyApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: FetchLike;
  private readonly opts: DigbyApiOptions;
  private accessToken: string | undefined;
  /** Single-flight: concurrent 401s share ONE refresh call. */
  private refreshPromise: Promise<string> | null = null;
  /**
   * The refresh token from the most recent response's Set-Cookie (login/
   * refresh). Native hosts persist this to SecureStore; the web host ignores
   * it (its cookie jar owns rotation).
   */
  private lastRefreshTokenFromCookie: string | undefined;

  /** Latest refresh token captured from a response Set-Cookie, if any. */
  get lastSetCookieRefreshToken(): string | undefined {
    return this.lastRefreshTokenFromCookie;
  }

  /** Exposed for endpoint namespaces: the host's rotation callback. */
  get onRefreshToken(): ((token: string) => void) | undefined {
    return this.opts.onRefreshToken;
  }

  constructor(opts: DigbyApiOptions & { accessToken?: string }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? defaultFetch;
    this.opts = opts;
    this.accessToken = opts.accessToken;
  }

  /** Set/replace the in-memory access token (host calls this on launch restore). */
  setAccessToken(token: string | undefined): void {
    this.accessToken = token;
  }

  get currentAccessToken(): string | undefined {
    return this.accessToken;
  }

  /**
   * Core request wrapper: Bearer auth, `{ success, data }` unwrap, 401 →
   * single-flight refresh → single retry. Mirrors the web client's interceptor
   * semantics but without axios/localStorage. Exported for the endpoint
   * namespaces (same package).
   */
  async request<T>(path: string, init?: {
    method?: string;
    body?: unknown;
    /** Skip refresh-retry for this call (used by refresh itself). */
    skipRefresh?: boolean;
  }): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (init?.body !== undefined) headers['Content-Type'] = 'application/json';
    const token = this.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;

    const doCall = async (): Promise<T> => {
      const res = await this.doFetch(url, {
        method: init?.method ?? 'GET',
        headers,
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      // Capture the rotated refresh token off EVERY response (login/refresh
      // set it; other calls don't) — see lastSetCookieRefreshToken.
      const fromCookie = refreshTokenFromSetCookie(res.headers);
      if (fromCookie) this.lastRefreshTokenFromCookie = fromCookie;
      if (res.ok) return (await res.json()) as T;
      const text = await res.text().catch(() => '');
      throw new ApiError(
        res.status,
        text || `Request failed with status ${res.status}`,
        url,
        res.status === 401
      );
    };

    try {
      return await doCall();
    } catch (err) {
      const is401 =
        err instanceof ApiError && err.status === 401 && !init?.skipRefresh;
      const isAuthEndpoint = (this.opts.noRefreshPaths ?? NO_REFRESH_DEFAULT).some(
        (p) => path.startsWith(p)
      );
      if (!(is401 && !isAuthEndpoint && !init?.skipRefresh)) throw err;

      // 401 on a data call → single-flight refresh → retry ONCE.
      let freshToken: string;
      try {
        freshToken = await this.refresh();
      } catch (refreshErr) {
        this.opts.onSessionExpired?.();
        throw refreshErr;
      }
      // Retry with the new token (set on the shared header object).
      headers.Authorization = `Bearer ${freshToken}`;
      try {
        return await doCall();
      } catch (retryErr) {
        // A 401 that survives refresh is definitive (web: isDefinitiveAuthFailure).
        if (retryErr instanceof ApiError && retryErr.status === 401) {
          this.opts.onSessionExpired?.();
        }
        throw retryErr;
      }
    }
  }

  /**
   * Refresh the access token. SINGLE-FLIGHT: concurrent callers await the same
   * in-flight promise (the web client serializes via axios `_retry` flags; here
   * the promise itself is the guard, so a burst of 401s costs one round-trip).
   *
   * Mobile: sends `{ refreshToken }` in the body (backend accepts cookie OR
   * body) AND captures the ROTATED refresh token from Set-Cookie — the backend
   * deletes the presented token row on every refresh (auth.service.ts), so a
   * body-token client that doesn't read the new one loses the session on its
   * second refresh. Web hosts (cookie jar) can ignore the rotation callback.
   */
  async refresh(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const refreshToken = await this.opts.getRefreshToken?.();
      const body: Record<string, string> | undefined = refreshToken
        ? { refreshToken }
        : undefined;
      const res = await this.doFetch(`${this.baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: body
          ? { 'Content-Type': 'application/json' }
          : undefined,
        body: body ? JSON.stringify(body) : JSON.stringify({}),
        credentials: 'include',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new ApiError(
          res.status,
          text || `Refresh failed with status ${res.status}`,
          '/api/auth/refresh'
        );
      }
      const json = (await res.json()) as ApiEnvelope<{ accessToken: string }>;
      const token = json.data?.accessToken;
      if (!token) throw new ApiError(500, 'Refresh response missing accessToken', '/api/auth/refresh');
      this.accessToken = token;
      this.opts.onAccessToken?.(token);
      // Rotation capture: the new refresh token rides Set-Cookie only.
      const rotated = refreshTokenFromSetCookie(res.headers);
      if (rotated) this.opts.onRefreshToken?.(rotated);
      return token;
    })();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Ensure a fresh access token for a STREAMING call (M0). SSE connections are
   * long-lived; the 15-min access token may expire between turns. The
   * streaming namespaces call this before opening a connection — refreshes
   * single-flight when the in-memory token is missing.
   */
  async freshAccessToken(): Promise<string | undefined> {
    if (this.accessToken) return this.accessToken;
    try {
      return await this.refresh();
    } catch {
      return undefined;
    }
  }

  /** The transport + baseUrl pair, for the streaming namespace (same package). */
  get transport(): { baseUrl: string; doFetch: FetchLike } {
    return { baseUrl: this.baseUrl, doFetch: this.doFetch };
  }
}
