/**
 * Typed endpoint namespaces — auth + chats, matching the web client's calls
 * (frontend/lib/auth.ts, frontend/lib/api/ai-chat.ts) and the backend routes
 * (backend/src/modules/auth/auth.routes.ts, ai-chat.routes.ts):
 *
 *   POST /api/auth/login     { email, password }
 *   POST /api/auth/refresh   {} | { refreshToken }        (cookie OR body)
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   POST /api/auth/change-password { currentPassword, newPassword }
 *   GET  /api/ai-chats       ?page&limit
 *   GET  /api/ai-chats/:id
 *   POST /api/ai-chats       { title }                    (create)
 *   POST /api/ai-chats/:id/messages { content }           (send)
 */

import { DigbyApiClient, ApiError, ApiEnvelope } from './client';
import type {
  User,
  LoginCredentials,
  LoginResponse,
  RefreshResponse,
  ChangePasswordArgs,
  ChangePasswordResponse,
  ChatsListResponse,
  ListChatsParams,
  Chat,
  Message,
  AddMessageData,
  CrossModelChat,
  CrossModelChatDetail,
  CrossModelMessage,
  ListCrossModelChatsParams,
} from './types';

export function fetchAuth(client: DigbyApiClient) {
  return {
    /** POST /api/auth/login — sets the client's access token. */
    async login(credentials: LoginCredentials): Promise<LoginResponse> {
      const res = await client.request<ApiEnvelope<LoginResponse>>(
        '/api/auth/login',
        { method: 'POST', body: credentials, skipRefresh: true }
      );
      // The client owns the in-memory access token (the web client instead
      // parks it in localStorage for its axios interceptor to read).
      client.setAccessToken(res.data.accessToken);
      // The backend ALSO sets the 7-day refresh token as an httpOnly cookie —
      // web reads it via the cookie jar; native clients can't rely on the
      // cookie jar surviving process death (Android's CookieManager syncs
      // lazily), so surfaces it here for SecureStore persistence. Rotation:
      // every refresh deletes the presented token, so persist the LATEST.
      const fromCookie = client.lastSetCookieRefreshToken;
      if (fromCookie) client.onRefreshToken?.(fromCookie);
      return fromCookie ? { ...res.data, refreshToken: fromCookie } : res.data;
    },

    /** POST /api/auth/refresh — single-flight refresh (see DigbyApiClient.refresh). */
    async refresh(): Promise<RefreshResponse> {
      const token = await client.refresh();
      return { accessToken: token };
    },

    /** GET /api/auth/me — the current user (Bearer-authenticated). */
    async me(): Promise<User> {
      // Backend shape: { success, data: User } — data IS the user (the web
      // client's getCurrentUser returns response.data.data directly).
      const res = await client.request<ApiEnvelope<User>>('/api/auth/me');
      return res.data;
    },

    /** POST /api/auth/logout — best-effort; never throws. */
    async logout(): Promise<void> {
      try {
        await client.request<ApiEnvelope<unknown>>('/api/auth/logout', {
          method: 'POST',
          skipRefresh: true,
        });
      } catch {
        // Logout is fire-and-forget (web client does the same — the local
        // session is cleared regardless of the server's answer).
      }
    },

    /**
     * DELETE /api/auth/account — permanent account deletion (App Store
     * 5.1.1(v) / Play Data-deletion; the mobile Settings screen's destructive
     * action). Requires the account password (re-auth). THROWS on failure —
     * unlike logout, a failed deletion must surface to the user (they must
     * know their data was NOT deleted). The host clears local session state
     * (SecureStore refresh token + in-memory access token + user state) only
     * on success.
     */
    async deleteAccount(args: { password: string }): Promise<{ deleted: boolean }> {
      const res = await client.request<ApiEnvelope<{ deleted: boolean }>>(
        '/api/auth/account',
        { method: 'DELETE', body: args }
      );
      // The account is gone server-side; drop the client's token so nothing
      // retries with it (the backend clears cookies for the web session).
      client.setAccessToken(undefined);
      return res.data;
    },

    /**
     * POST /api/auth/change-password — THROWS on failure (wrong current
     * password → 400, child account → 403) so the host can show the reason.
     * On success the backend revokes every refresh token of the user and
     * cuts off older access tokens, then hands THIS caller a fresh pair: the
     * new access token replaces the client's, and the rotated refresh token
     * (Set-Cookie) goes to the host's onRefreshToken exactly like login.
     */
    async changePassword(args: ChangePasswordArgs): Promise<ChangePasswordResponse> {
      const res = await client.request<ApiEnvelope<ChangePasswordResponse>>(
        '/api/auth/change-password',
        { method: 'POST', body: args }
      );
      client.setAccessToken(res.data.accessToken);
      const fromCookie = client.lastSetCookieRefreshToken;
      if (fromCookie) client.onRefreshToken?.(fromCookie);
      return fromCookie ? { ...res.data, refreshToken: fromCookie } : res.data;
    },
  };
}

export function fetchChats(client: DigbyApiClient) {
  return {
    /** GET /api/ai-chats — paginated chat list, newest first. */
    async list(params?: ListChatsParams): Promise<ChatsListResponse> {
      // Manual query string (no URLSearchParams — keeps the package DOM-free).
      const parts: string[] = [];
      if (params?.page != null) parts.push(`page=${params.page}`);
      if (params?.limit != null) parts.push(`limit=${params.limit}`);
      const query = parts.join('&');
      const res = await client.request<ApiEnvelope<ChatsListResponse>>(
        query ? `/api/ai-chats?${query}` : '/api/ai-chats'
      );
      return res.data;
    },

    /** GET /api/ai-chats/:id — a chat with its full transcript. */
    async get(id: string): Promise<Chat> {
      const res = await client.request<ApiEnvelope<Chat>>(
        `/api/ai-chats/${encodeURIComponent(id)}`
      );
      return res.data;
    },

    /** POST /api/ai-chats — create a chat. */
    async create(title: string): Promise<Chat> {
      const res = await client.request<ApiEnvelope<Chat>>('/api/ai-chats', {
        method: 'POST',
        body: { title },
      });
      return res.data;
    },

    /** POST /api/ai-chats/:id/messages — send a message (NO SSE here; M1). */
    async send(chatId: string, data: AddMessageData): Promise<Chat> {
      const res = await client.request<ApiEnvelope<Chat>>(
        `/api/ai-chats/${encodeURIComponent(chatId)}/messages`,
        { method: 'POST', body: data }
      );
      return res.data;
    },
  };
}

/**
 * Crossmodel chats (/api/crossmodel/chats) — the surface the SSE stream
 * targets. The web sidebar lists THIS (not /api/ai-chats): the unified stream
 * endpoint + register chatId + attach all resolve crossModelChat rows. The
 * mobile chat list/detail must use these, or streaming sends 404.
 */
export function fetchCrossModelChats(client: DigbyApiClient) {
  return {
    /** GET /api/crossmodel/chats — paginated, newest first; ?archived=true = Archived view. */
    async list(params?: ListCrossModelChatsParams): Promise<CrossModelChat[]> {
      const parts: string[] = [];
      if (params?.page != null) parts.push(`page=${params.page}`);
      if (params?.limit != null) parts.push(`limit=${params.limit}`);
      if (params?.archived) parts.push('archived=true');
      const query = parts.join('&');
      const res = await client.request<ApiEnvelope<{ chats: CrossModelChat[] }>>(
        query ? `/api/crossmodel/chats?${query}` : '/api/crossmodel/chats'
      );
      // The backend returns the list directly (platformService.listChats shape);
      // tolerate both {chats:[…]} and a bare array.
      const data = res.data as unknown as CrossModelChat[] | { chats: CrossModelChat[] };
      return Array.isArray(data) ? data : (data.chats ?? []);
    },

    /** GET /api/crossmodel/chats/:id — chat + transcript (owner or project member). */
    async get(id: string, opts?: { messageLimit?: number; messagesBefore?: string }): Promise<CrossModelChatDetail> {
      const parts: string[] = [];
      if (opts?.messageLimit != null) parts.push(`messageLimit=${opts.messageLimit}`);
      if (opts?.messagesBefore) parts.push(`messagesBefore=${encodeURIComponent(opts.messagesBefore)}`);
      const query = parts.join('&');
      const res = await client.request<ApiEnvelope<CrossModelChatDetail>>(
        `/api/crossmodel/chats/${encodeURIComponent(id)}${query ? `?${query}` : ''}`
      );
      return res.data;
    },

    /** POST /api/crossmodel/chats — create a chat (mode defaults server-side). */
    async create(data: { title: string; mode?: string; projectId?: string }): Promise<CrossModelChat> {
      const res = await client.request<ApiEnvelope<CrossModelChat>>('/api/crossmodel/chats', {
        method: 'POST',
        body: data,
      });
      return res.data;
    },
  };
}

export { ApiError };
export type { Message };
