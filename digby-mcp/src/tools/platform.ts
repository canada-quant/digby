/**
 * digby-mcp — platform API layer.
 *
 * Thin REST wrappers over the Digby platform API
 * (`${DIGBY_API_URL}/api/crossmodel/platform`, see docs/DIGBY_PLATFORM_API.md).
 *
 * AUTH: per-user pass-through. Every function takes the caller's `authorization`
 * value ("Bearer <jwt-or-dgt_…>") and forwards it VERBATIM. This server holds no
 * token of its own, no shared secret, and no permission logic — scope
 * enforcement (agent-token scopes) and owner/member scoping live entirely in
 * the backend (middleware/agent-auth.ts + platform.service.ts). Never add an
 * API-key check here: a shared key would make this server a confused deputy
 * (every caller acting with the same over-privileged identity).
 */

import axios, { AxiosInstance } from 'axios';

const BASE_URL = `${process.env.DIGBY_API_URL || 'http://localhost:4000'}/api/crossmodel/platform`;

function client(authorization: string): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: authorization },
    timeout: 30000,
  });
}

/**
 * Map an upstream failure to a clear, actionable message. 401/403 get
 * token-specific guidance (mint a new agent token / add the missing scope);
 * everything else passes the API's error text through.
 */
function errMessage(err: any): string {
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      return `Cannot reach the Digby API at ${BASE_URL} (${err.code || err.message}) — is the backend running? Set DIGBY_API_URL to its base URL.`;
    }
    const status = err.response.status;
    const data: any = err.response.data;
    const apiError = typeof data?.error === 'string' ? data.error : typeof data === 'string' ? data : err.message;
    if (status === 401) {
      return `Authentication failed (401): ${apiError}. Your token is invalid or expired — mint a new agent token in Account → Developer (or sign in again for a fresh JWT).`;
    }
    if (status === 403) {
      if (data?.error === 'insufficient_scope') {
        const required = Array.isArray(data.required) ? data.required.join(', ') : 'unknown';
        return `Insufficient scope (403): this call requires scope(s): ${required}. Re-mint your agent token with the required scope(s) in Account → Developer.`;
      }
      return `Forbidden (403): ${apiError}`;
    }
    if (status === 429) {
      return `Rate limited (429): ${apiError}`;
    }
    return `Platform API error (${status}): ${apiError}`;
  }
  return err?.message || String(err);
}

/** Wrap an endpoint call so failures surface as clean tool errors. */
async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    throw new Error(errMessage(err));
  }
}

// ── Chats ─────────────────────────────────────────────────────────────────────

export interface ListChatsParams {
  folderId?: string;
  mode?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export async function listChats(auth: string, params: ListChatsParams): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).get('/chats', { params });
    return data;
  });
}

export async function getChatStatus(auth: string, chatId: string): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).get(`/chats/${chatId}/status`);
    return data;
  });
}

export async function createChat(
  auth: string,
  body: { title: string; folderId?: string | null; mode?: string },
): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).post('/chats', body);
    return data;
  });
}

export async function sendChatMessage(
  auth: string,
  chatId: string,
  body: { content: string; mode?: string },
): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).post(`/chats/${chatId}/messages`, body);
    return data;
  });
}

export async function startCodingSession(
  auth: string,
  chatId: string,
  body: { permissionMode?: string },
): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).post(`/chats/${chatId}/code`, body);
    return data;
  });
}

/** Shared transport for move_chat / rename_chat / archive_chat (all PATCH /chats/:id). */
export async function patchChat(auth: string, chatId: string, body: Record<string, unknown>): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).patch(`/chats/${chatId}`, body);
    return data;
  });
}

export async function deleteChat(auth: string, chatId: string): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).delete(`/chats/${chatId}`);
    return data;
  });
}

// ── Folders ───────────────────────────────────────────────────────────────────

export async function listFolders(auth: string): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).get('/folders');
    return data;
  });
}

export async function createFolder(
  auth: string,
  body: {
    name: string;
    parentId?: string | null;
    emoji?: string;
    color?: string;
    systemPrompt?: string | null;
    description?: string | null;
  },
): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).post('/folders', body);
    return data;
  });
}

/** Shared transport for update_folder / move_folder (both PATCH /folders/:id). */
export async function patchFolder(auth: string, folderId: string, body: Record<string, unknown>): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).patch(`/folders/${folderId}`, body);
    return data;
  });
}

export async function deleteFolder(auth: string, folderId: string, reparentTo?: string): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).delete(`/folders/${folderId}`, {
      params: reparentTo ? { reparentTo } : {},
    });
    return data;
  });
}

// ── Schedules ─────────────────────────────────────────────────────────────────

export async function createSchedule(
  auth: string,
  body: { chatId: string; prompt: string; kind: string; intervalSec: number },
): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).post('/schedules', body);
    return data;
  });
}

export async function listSchedules(auth: string): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).get('/schedules');
    return data;
  });
}

export async function cancelSchedule(auth: string, scheduleId: string): Promise<any> {
  return call(async () => {
    const { data } = await client(auth).delete(`/schedules/${scheduleId}`);
    return data;
  });
}
