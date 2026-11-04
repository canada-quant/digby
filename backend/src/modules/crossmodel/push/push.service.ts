/**
 * Push notification service (Mobile M1 — roadmap §3.2 item 2, todo 7cbf46a4).
 *
 * Fires on chat run completion so a backgrounded mobile app can surface
 * "your run finished" (roadmap §3.2 item 3: iOS suspends the app seconds
 * after backgrounding — push is the wake signal, the REST transcript is the
 * resync source).
 *
 * TRANSPORTS, in priority order (all env-gated — the module is INERT when
 * its credentials are absent; no env → no provider → register routes still
 * work but sends are no-ops logged at debug):
 *
 *   1. Expo Push (EXPO_ACCESS_TOKEN optional) — one token for both
 *      platforms; Expo's service fans out to APNs/FCM. The default.
 *   2. APNs token-based auth (APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID /
 *      APNS_BUNDLE_ID) — Apple's recommended method: sign a short-lived ES256
 *      JWT with the .p8 key, POST to api.push.apple.com/3/device/<token>.
 *   3. FCM HTTP v1 (FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_FILE) —
 *      Google OAuth2 (RS256, the firebase-admin scope), POST
 *      fcm.googleapis.com/v1/projects/<id>/messages:send.
 *
 * SECURITY: provider credentials NEVER appear in code, logs, or error
 * messages — only their ENV VAR NAMES. Push payloads carry chat ids and
 * titles only (never message bodies — the transcript is authed).
 */

import jwt from 'jsonwebtoken';
import logger from '../../../utils/logger';
import prisma from '../../../config/database';

// ── Env shape (read lazily so tests never need it set) ──────────────────────

export interface PushEnv {
  expoAccessToken?: string;
  apns?: { keyP8: string; keyId: string; teamId: string; bundleId: string };
  fcm?: { serviceAccountJson: string };
}

/** Read push env once per process (lazy — absent creds keep the module inert). */
let cachedEnv: PushEnv | null | undefined;
function pushEnv(): PushEnv | null {
  if (cachedEnv !== undefined) return cachedEnv;
  const e = process.env;
  const apns =
    e.APNS_KEY_P8 && e.APNS_KEY_ID && e.APNS_TEAM_ID && e.APNS_BUNDLE_ID
      ? { keyP8: e.APNS_KEY_P8, keyId: e.APNS_KEY_ID, teamId: e.APNS_TEAM_ID, bundleId: e.APNS_BUNDLE_ID }
      : undefined;
  const fcm = e.FCM_SERVICE_ACCOUNT_JSON
    ? { serviceAccountJson: e.FCM_SERVICE_ACCOUNT_JSON }
    : e.FCM_SERVICE_ACCOUNT_FILE
      ? { serviceAccountJson: readFileSyncSafe(e.FCM_SERVICE_ACCOUNT_FILE) ?? '' }
      : undefined;
  cachedEnv = {
    expoAccessToken: e.EXPO_ACCESS_TOKEN,
    apns: apns && apns.keyP8 ? apns : undefined,
    fcm: fcm && fcm.serviceAccountJson ? fcm : undefined,
  };
  return cachedEnv;
}

/** Test hook: reset the cached env (never used in prod paths). */
export function resetPushEnvCacheForTests(): void {
  cachedEnv = undefined;
}

function readFileSyncSafe(path: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    return fs.readFileSync(path, 'utf8');
  } catch {
    logger.warn(`push: FCM_SERVICE_ACCOUNT_FILE unreadable (${path}) — FCM transport disabled`);
    return undefined;
  }
}

// ── Token registration ──────────────────────────────────────────────────────

export interface RegisterPushArgs {
  userId: string;
  token: string;
  provider?: string;
  platform?: string;
  deviceId?: string;
  appVersion?: string;
}

/** Upsert a device token for a user (idempotent — re-registration bumps lastSeenAt). */
export async function registerPushToken(args: RegisterPushArgs): Promise<void> {
  const provider = normalizeProvider(args.provider);
  await prisma.pushToken.upsert({
    where: { userId_token: { userId: args.userId, token: args.token } },
    create: {
      userId: args.userId,
      token: args.token,
      provider,
      platform: args.platform ?? null,
      deviceId: args.deviceId ?? null,
      appVersion: args.appVersion ?? null,
    },
    update: {
      provider,
      platform: args.platform ?? null,
      deviceId: args.deviceId ?? null,
      appVersion: args.appVersion ?? null,
      lastSeenAt: new Date(),
    },
  });
}

/** Remove a token (logout / OS revoked it). Unknown tokens are a no-op. */
export async function unregisterPushToken(userId: string, token: string): Promise<void> {
  await prisma.pushToken.deleteMany({ where: { userId, token } });
}

function normalizeProvider(p?: string): string {
  return p === 'apns' || p === 'fcm' ? p : 'expo';
}

/** Drop a token the provider rejected as invalid (410/InvalidRegistration). */
async function dropInvalidToken(token: string): Promise<void> {
  await prisma.pushToken.deleteMany({ where: { token } }).catch(() => {});
}

// ── Send paths (one per provider) ───────────────────────────────────────────

export interface PushMessage {
  title: string;
  body: string;
  /** Deep-link target — the mobile app routes digby://chat/<chatId>. */
  chatId?: string;
  /** Data payload key/value pairs (kept primitive — providers restrict values). */
  data?: Record<string, string>;
}

/** Normalize the token per provider (Expo tokens arrive with the full form). */
function expoToken(t: string): string {
  return t.startsWith('ExponentPushToken[') ? t : `ExponentPushToken[${t}]`;
}

async function sendViaExpo(msg: PushMessage, tokens: string[], accessToken?: string): Promise<void> {
  // One POST for all tokens (Expo's batch API — max 100 per call).
  for (let i = 0; i < tokens.length; i += 100) {
    const batch = tokens.slice(i, i + 100);
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(
        batch.map((t) => ({
          to: expoToken(t),
          title: msg.title,
          body: msg.body,
          sound: 'default',
          channelId: 'runs',
          priority: 'high',
          data: { ...(msg.data ?? {}), ...(msg.chatId ? { chatId: msg.chatId } : {}), digbyPush: '1' },
        }))
      ),
    });
    if (!res.ok) {
      // Log STATUS only — never the body (it echoes tokens).
      logger.warn(`push: Expo send failed with status ${res.status} (${batch.length} tokens)`);
      continue;
    }
    // Expo's response marks per-token failures (device uninstalled etc.) —
    // drop those rows so the table self-cleans.
    try {
      const json = (await res.json()) as { data?: Array<{ status?: string; message?: string }> };
      const results = json.data ?? [];
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r?.status === 'error' && /DeviceNotKnown|InvalidCredentials/i.test(r.message ?? '')) {
          await dropInvalidToken(batch[j]);
        }
      }
    } catch { /* response shape drift — non-fatal */ }
  }
}

/** APNs provider JWT (token-based auth): short-lived ES256, signed per batch. */
function apnsProviderJwt(apns: NonNullable<PushEnv['apns']>): string {
  return jwt.sign({}, apns.keyP8, {
    algorithm: 'ES256',
    keyid: apns.keyId,
    issuer: apns.teamId,
    expiresIn: '30m',
  });
}

async function sendViaApns(msg: PushMessage, tokens: string[], apns: NonNullable<PushEnv['apns']>): Promise<void> {
  const providerJwt = apnsProviderJwt(apns);
  for (const token of tokens) {
    const res = await fetch(`https://api.push.apple.com/3/device/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${providerJwt}`,
        'apns-topic': apns.bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
      },
      body: JSON.stringify({
        aps: {
          alert: { title: msg.title, body: msg.body },
          sound: 'default',
        },
        ...(msg.chatId ? { chatId: msg.chatId } : {}),
        digbyPush: '1',
      }),
    });
    if (res.status === 410 || res.status === 403) await dropInvalidToken(token);
    else if (!res.ok) logger.debug(`push: APNs device send status ${res.status}`);
  }
}

/** Google OAuth2 access token from the FCM service account (RS256 JWT → token). */
async function fcmAccessToken(serviceAccountJson: string): Promise<string | undefined> {
  let sa: { client_email?: string; private_key?: string; project_id?: string };
  try {
    sa = JSON.parse(serviceAccountJson);
  } catch {
    logger.warn('push: FCM_SERVICE_ACCOUNT_JSON is not valid JSON — FCM transport disabled');
    return undefined;
  }
  if (!sa.client_email || !sa.private_key) {
    logger.warn('push: FCM service account missing client_email/private_key — FCM transport disabled');
    return undefined;
  }
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
    sa.private_key,
    { algorithm: 'RS256' }
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  if (!res.ok) {
    logger.warn(`push: FCM token exchange failed with status ${res.status}`);
    return undefined;
  }
  const json = (await res.json()) as { access_token?: string };
  return json.access_token;
}

async function sendViaFcm(msg: PushMessage, tokens: string[], serviceAccountJson: string): Promise<void> {
  let sa: { project_id?: string };
  try {
    sa = JSON.parse(serviceAccountJson);
  } catch { return; }
  if (!sa.project_id) return;
  const accessToken = await fcmAccessToken(serviceAccountJson);
  if (!accessToken) return;
  for (const token of tokens) {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: msg.title, body: msg.body },
          android: { priority: 'high' },
          data: { ...(msg.data ?? {}), ...(msg.chatId ? { chatId: msg.chatId } : {}), digbyPush: '1' },
        },
      }),
    });
    if (res.status === 404 || res.status === 400) await dropInvalidToken(token);
    else if (!res.ok) logger.debug(`push: FCM device send status ${res.status}`);
  }
}

// ── Public API: notify a user's registered devices ──────────────────────────

/** All transports currently configured (env-gated). */
export function pushTransportsConfigured(): { expo: boolean; apns: boolean; fcm: boolean } {
  const env = pushEnv();
  return { expo: true, apns: !!env?.apns, fcm: !!env?.fcm };
}

/**
 * Push to every registered device of a user. Fire-and-forget safe: NEVER
 * throws (callers run it off the request path). Splits by provider and uses
 * the best configured transport per token; a token with no configured
 * transport is skipped silently (the Expo transport is the default and needs
 * no credentials).
 */
export async function pushToUserDevices(userId: string, msg: PushMessage): Promise<void> {
  try {
    const rows = await prisma.pushToken.findMany({ where: { userId }, select: { token: true, provider: true } });
    if (rows.length === 0) return;
    const env = pushEnv();
    const expoTokens = rows.filter((r: { provider: string }) => r.provider === 'expo').map((r: { token: string }) => r.token);
    const apnsTokens = rows.filter((r: { provider: string }) => r.provider === 'apns').map((r: { token: string }) => r.token);
    const fcmTokens = rows.filter((r: { provider: string }) => r.provider === 'fcm').map((r: { token: string }) => r.token);
    const jobs: Promise<void>[] = [];
    if (expoTokens.length) jobs.push(sendViaExpo(msg, expoTokens, env?.expoAccessToken).catch(() => {}));
    if (apnsTokens.length && env?.apns) jobs.push(sendViaApns(msg, apnsTokens, env.apns).catch(() => {}));
    if (fcmTokens.length && env?.fcm) jobs.push(sendViaFcm(msg, fcmTokens, env.fcm.serviceAccountJson).catch(() => {}));
    if (jobs.length) await Promise.all(jobs);
  } catch (err: any) {
    // Never log credentials/tokens — the error class only.
    logger.debug(`push: send skipped (${err?.name ?? 'error'})`);
  }
}
