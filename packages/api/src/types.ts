/**
 * DTO types for the Digby API — extracted from the web client
 * (frontend/lib/auth.ts + frontend/lib/api/ai-chat.ts) and verified against the
 * backend controllers (auth.controller.ts, ai-chat.controller.ts).
 */

// ── Auth ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: string;
  avatar?: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

/** POST /api/auth/login → data */
export interface LoginResponse {
  user: User;
  accessToken: string;
  /**
   * The 7-day refresh token — present only when the transport exposed the
   * response's Set-Cookie header (native fetch / expo/fetch do; the backend
   * otherwise hands it out ONLY as an httpOnly cookie). Native hosts persist
   * it (expo-secure-store); web hosts ignore it in favor of the cookie jar.
   */
  refreshToken?: string;
}

/** POST /api/auth/refresh → data */
export interface RefreshResponse {
  accessToken: string;
}

/** POST /api/auth/change-password ← body */
export interface ChangePasswordArgs {
  currentPassword: string;
  newPassword: string;
}

/** POST /api/auth/change-password → data */
export interface ChangePasswordResponse {
  /** The caller's fresh access token (every older one is cut off). */
  accessToken: string;
  /** Refresh-token rows revoked: every device's, the caller's old one included. */
  refreshTokensRevoked: number;
  /** false = other devices cannot refresh, but an access token they hold works until it expires. */
  accessTokensCutOff: boolean;
  /** The rotated refresh token, when the transport exposed Set-Cookie (as LoginResponse). */
  refreshToken?: string;
}

// ── Chats (/api/ai-chats) ───────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Message {
  id?: string;
  role: MessageRole;
  content: string;
  timestamp: string;
}

export interface Chat {
  id: string;
  title: string;
  messages: Message[];
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  lastMessage?: string | null;
}

export interface ChatsPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

export interface ChatsListResponse {
  chats: Chat[];
  pagination: ChatsPagination;
}

export interface ListChatsParams {
  page?: number;
  limit?: number;
}

export interface AddMessageData {
  content: string;
}

// ── Crossmodel chats (/api/crossmodel/chats) — the SSE stream's surface ─────
// The unified stream endpoint (GET /api/crossmodel/chats/:id/stream) and the
// register body's chatId target the crossModelChat table — the SAME surface
// the web sidebar lists (/api/crossmodel/chats), NOT the legacy /api/ai-chats.
// Sending an ai-chats id to the stream 404s ("Chat not found").

/** A crossmodel chat row (list + detail share the shape; detail adds access). */
export interface CrossModelChat {
  id: string;
  title: string;
  mode: string;
  projectId?: string | null;
  parentChatId?: string | null;
  messages: CrossModelMessage[];
  messageCount?: number;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  lastMessageRole?: string | null;
  running?: boolean;
  awaitingInput?: boolean;
  hasActiveSchedule?: boolean;
  isSupervisor?: boolean;
  isProjectSupervisor?: boolean;
  codeCapable?: boolean;
  hasWorkspaceState?: boolean;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CrossModelChatDetail extends CrossModelChat {
  access?: 'none' | 'read' | 'write' | 'owner';
  /** Paged fetch only: older messages exist beyond this page. */
  hasMoreMessages?: boolean;
  /** Paged fetch only: cursor for the next OLDER page. */
  nextMessagesBefore?: string;
}

export interface CrossModelMessage {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  metadata?: {
    mode?: string;
    webSearch?: boolean;
    models?: Record<string, unknown>;
    summary?: string;
    totalTime?: number;
    /** Attachment chips on USER rows: filename + type + staged uploadId. */
    attachments?: Array<{ filename?: string; type?: string; uploadId?: string; fileId?: string; mimeType?: string }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ListCrossModelChatsParams {
  page?: number;
  limit?: number;
  /** true = the Archived browse view. */
  archived?: boolean;
}
