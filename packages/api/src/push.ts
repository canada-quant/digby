/**
 * Mobile push registration (M1 — roadmap §3.2 item 2).
 *
 * The mobile app registers its Expo Push token after sign-in (and on token
 * rotation); the backend fires on chat run completion. These ride the client's
 * normal Bearer + refresh loop — no separate auth surface.
 */

import { DigbyApiClient, ApiError } from './client';

export interface RegisterPushArgs {
  /** The device token (Expo Push token by default). */
  token: string;
  provider?: 'expo' | 'apns' | 'fcm';
  platform?: 'ios' | 'android';
  /** Client-stable device id (advisory — (userId, token) is the real key). */
  deviceId?: string;
  appVersion?: string;
}

export interface PushTransports {
  expo: boolean;
  apns: boolean;
  fcm: boolean;
}

export function fetchPush(client: DigbyApiClient) {
  return {
    /** POST /api/crossmodel/push/register — idempotent; bumps lastSeenAt. */
    async register(args: RegisterPushArgs): Promise<PushTransports> {
      const res = await client.request<{ success: boolean; data: { registered: boolean; transports: PushTransports } }>(
        '/api/crossmodel/push/register',
        { method: 'POST', body: args }
      );
      return res.data.transports;
    },

    /** DELETE /api/crossmodel/push/:token — logout / OS revoked it. */
    async unregister(token: string): Promise<void> {
      await client.request<{ success: boolean }>(
        `/api/crossmodel/push/${encodeURIComponent(token)}`,
        { method: 'DELETE' }
      ).catch((err) => {
        // Unregister is best-effort (mirrors logout): the server row goes
        // stale via lastSeenAt anyway. Surfacing a 404 as a hard error would
        // block sign-out.
        if (!(err instanceof ApiError)) throw err;
      });
    },

    /** GET /api/crossmodel/push/status — which transports the server configured. */
    async status(): Promise<PushTransports> {
      const res = await client.request<{ success: boolean; data: PushTransports }>(
        '/api/crossmodel/push/status'
      );
      return res.data;
    },
  };
}
