/**
 * Connected instances API — Digby Edge (Phase 4) cloud-side browser + edge-side
 * cloud link.
 *
 * CLOUD side (`/api/crossmodel/instances/*`): ADMIN-only server-side (403 for
 * non-admins). The tunnel proxy
 *   ALL /api/crossmodel/instances/:instanceId/proxy/<path>
 * forwards to the paired edge instance's own `/api/<path>` as the edge admin —
 * responses stream (SSE works through it). An offline edge answers
 * 502 `{ error: 'instance offline' }`.
 *
 * EDGE side (`/api/crossmodel/cloud-link/*`): the SAME Next.js codebase running
 * as an edge instance manages its singleton link TO a cloud. The dgi_ tunnel
 * token is write-only — responses carry state/connected, never the token.
 *
 * Non-SSE proxy calls ride the normal apiClient (Bearer JWT — the relay accepts
 * header or cm_access cookie). The SSE attach builds its URL from
 * NEXT_PUBLIC_API_URL like the main chat stream (api-client.ts): EventSource
 * can't set headers, so the httpOnly cm_access cookie is its only auth.
 */

import apiClient from '../api-client';
import type { CrossModelChat, CrossModelChatDetail } from './crossmodel';

export interface ConnectedInstance {
  id: string;
  name: string;
  status: string;
  protocolVersion: number;
  lastSeenAt: string | null;
  createdAt: string;
  /** Live tunnel presence (Redis-backed), refreshed on each list call. */
  online: boolean;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

/** 202 response of the platform messages endpoint (no success envelope). */
export interface EdgeSendResult {
  ok: boolean;
  queued: boolean;
  chatId: string;
  position?: number;
  note?: string;
  delivery?: string;
}

export interface CloudLinkStatus {
  state: string; // 'unlinked' when no link row exists
  cloudUrl: string | null;
  instanceName: string | null;
  /** Live tunnel socket flag. */
  connected: boolean;
  lastError: string | null;
}

/** The relay's offline sentinel: 502 { error: 'instance offline' }. */
export function isInstanceOfflineError(err: unknown): boolean {
  const status = (err as any)?.response?.status;
  const msg = (err as any)?.response?.data?.error;
  return status === 502 && typeof msg === 'string' && msg.toLowerCase().includes('offline');
}

/** Human message for a proxied call failure (offline gets its own state). */
export function instanceErrorMessage(err: unknown, fallback: string): string {
  return (err as any)?.response?.data?.error || fallback;
}

const proxyPrefix = (instanceId: string) =>
  `/crossmodel/instances/${instanceId}/proxy`;

export const instancesApi = {
  // ── Cloud side: pairing management ──────────────────────────────────────────

  list: async (opts?: { signal?: AbortSignal }): Promise<ConnectedInstance[]> => {
    const response = await apiClient.get('/crossmodel/instances', { signal: opts?.signal });
    return response.data.data.instances;
  },

  /** Mint a 10-min single-use pairing code (shown ONCE — never re-readable). */
  startPairing: async (): Promise<PairingCode> => {
    const response = await apiClient.post('/crossmodel/instances/pair/start');
    return response.data.data;
  },

  /**
   * Device activation (cloud side): redeem the code shown on the EDGE's
   * "Pair to a cloud" screen. No instance row exists yet — the edge mints it
   * by dialing the tunnel; poll list() until it appears (or the code lapses).
   */
  redeemPairing: async (code: string): Promise<{ pending: true; expiresAt: string }> => {
    const response = await apiClient.post('/crossmodel/instances/pair/redeem', { code });
    return response.data.data;
  },

  revoke: async (id: string): Promise<void> => {
    await apiClient.delete(`/crossmodel/instances/${id}`);
  },

  // ── Cloud side: through the tunnel proxy (edge's own REST API) ──────────────

  /** The edge instance's chat list (GET /api/crossmodel/chats on the edge). */
  listEdgeChats: async (instanceId: string, limit = 50): Promise<CrossModelChat[]> => {
    const response = await apiClient.get(`${proxyPrefix(instanceId)}/crossmodel/chats`, {
      params: { limit },
    });
    return response.data.data.chats;
  },

  /** One edge chat plus its transcript (same shape as crossModelApi.getChat). */
  getEdgeChat: async (instanceId: string, chatId: string): Promise<CrossModelChatDetail> => {
    const response = await apiClient.get(`${proxyPrefix(instanceId)}/crossmodel/chats/${chatId}`);
    return response.data.data;
  },

  /**
   * Delete a chat ON THE EDGE — the proxy forwards DELETE to the edge's own
   * DELETE /api/crossmodel/chats/:id. An offline edge answers 502.
   */
  deleteEdgeChat: async (instanceId: string, chatId: string): Promise<void> => {
    await apiClient.delete(`${proxyPrefix(instanceId)}/crossmodel/chats/${chatId}`);
  },

  /**
   * Send a message into an edge chat. Uses the edge's platform messages
   * endpoint (POST /api/crossmodel/platform/chats/:id/messages { content }) —
   * a 202 detached agent turn: idle chat starts a run, busy chat queues.
   * Attach to the run via edgeChatStreamUrl afterwards.
   */
  sendEdgeMessage: async (instanceId: string, chatId: string, content: string): Promise<EdgeSendResult> => {
    const response = await apiClient.post(
      `${proxyPrefix(instanceId)}/crossmodel/platform/chats/${chatId}/messages`,
      { content },
    );
    return response.data;
  },

  /**
   * SSE attach URL for an edge chat's active run — the edge's unified
   * GET /api/crossmodel/chats/:id/stream, tunneled. No token query param: a
   * same-origin EventSource sends the httpOnly cm_access cookie automatically
   * (the relay accepts it). Emits the same `{type, data}` JSON events as the
   * main chat stream ('chunk' / 'progress' / 'complete' / 'error' / …).
   */
  edgeChatStreamUrl: (instanceId: string, chatId: string): string => {
    const apiBase = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
    return `${apiBase}/crossmodel/instances/${instanceId}/proxy/crossmodel/chats/${chatId}/stream`;
  },

  // ── Edge side: this instance's link TO a cloud ──────────────────────────────

  getCloudLink: async (opts?: { signal?: AbortSignal }): Promise<CloudLinkStatus> => {
    const response = await apiClient.get('/crossmodel/cloud-link', { signal: opts?.signal });
    return response.data.data;
  },

  /** Redeem a cloud pairing code + start the tunnel (replaces any existing link). */
  pairCloud: async (input: { cloudUrl: string; pairingCode: string; instanceName?: string }): Promise<CloudLinkStatus> => {
    const response = await apiClient.post('/crossmodel/cloud-link/pair', input);
    return response.data.data;
  },

  /**
   * Device activation (edge side): mint the pairing code HERE and start the
   * tunnel client's pending-pair dial. The cloud admin redeems the code under
   * Connected instances → Add by code; the link flips to state 'linked' when
   * the tunnel lands. The link row shows state 'pending' while waiting.
   */
  startCloudPairCode: async (input: { cloudUrl: string; instanceName?: string }): Promise<PairingCode> => {
    const response = await apiClient.post('/crossmodel/cloud-link/code/start', input);
    return response.data.data;
  },

  unlinkCloud: async (): Promise<CloudLinkStatus> => {
    const response = await apiClient.post('/crossmodel/cloud-link/unlink');
    return response.data.data;
  },
};
