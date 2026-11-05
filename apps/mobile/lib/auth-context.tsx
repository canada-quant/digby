/**
 * Auth context — the mobile session owner (roadmap §3.2 item 4).
 *
 * Token model (verified against backend/src/modules/auth/):
 *   - ACCESS token: 15-min TTL, kept IN MEMORY only (this file's state) —
 *     never persisted (a stolen access token expires on its own).
 *   - REFRESH token: 7-day TTL, issued as an httpOnly cookie on the web. The
 *     mobile app cannot read that cookie, so it persists the token it sends in
 *     the refresh BODY in expo-secure-store (Keychain on iOS / Keystore on
 *     Android) — the backend accepts `req.cookies.refreshToken ||
 *     req.body?.refreshToken`.
 *
 * On launch: restore the refresh token from SecureStore → refresh() → if it
 * survives, we have a session; if not, the user signs in again.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import * as SecureStore from 'expo-secure-store';
// expo/fetch (SDK 57): the WinterCG-compliant fetch with NATIVE response
// streaming (resp.body.getReader()) — the transport @digby/api's SSE layer
// needs. Injected once here so EVERY request (REST + SSE) rides it.
import { fetch as expoFetch } from 'expo/fetch';
import { DigbyApiClient, fetchAuth, fetchChats, fetchCrossModelChats } from '@digby/api';
import type { User } from '@digby/api';
import { API_BASE_URL } from './config';
import { usePushRegistration } from './push';

const REFRESH_TOKEN_KEY = 'digby.refreshToken';
export interface AuthState {
  /** The @digby/api client, wired for refresh-from-SecureStore. */
  api: DigbyApiClient;
  auth: ReturnType<typeof fetchAuth>;
  /** Legacy /api/ai-chats surface (kept for compatibility). */
  chats: ReturnType<typeof fetchChats>;
  /** /api/crossmodel/chats — the surface the SSE stream targets (M0). */
  crossChats: ReturnType<typeof fetchCrossModelChats>;
  /** null = still restoring; undefined = signed out; User = signed in. */
  user: User | null | undefined;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // access token lives in memory inside the client; refresh token in SecureStore
  const [client] = useState(
    () =>
      new DigbyApiClient({
        baseUrl: API_BASE_URL,
        // expo/fetch: streaming-capable (M0 SSE) — see the import note above.
        fetch: expoFetch as unknown as DigbyApiClient['transport']['doFetch'],
        getRefreshToken: async () => {
          try {
            return (await SecureStore.getItemAsync(REFRESH_TOKEN_KEY)) ?? undefined;
          } catch {
            return undefined;
          }
        },
        onAccessToken: () => {
          // access token stays in-memory on the client — nothing to persist
        },
        // ROTATION: the backend deletes the presented refresh-token row on
        // every login/refresh and hands the new one out ONLY as an httpOnly
        // Set-Cookie (auth.service.ts / auth.controller.ts). The client reads
        // it off the response headers and calls this hook — persist the LATEST
        // token or the next refresh replays a deleted token and kills the
        // session.
        onRefreshToken: (token) => {
          void SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token).catch(() => {});
        },
        onSessionExpired: () => {
          setUser(undefined);
          void SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {});
        },
      })
  );

  const [user, setUser] = useState<User | null | undefined>(null);

  const auth = useMemo(() => fetchAuth(client), [client]);
  const chats = useMemo(() => fetchChats(client), [client]);
  const crossChats = useMemo(() => fetchCrossModelChats(client), [client]);

  // Launch restore: refresh → me. Works with EITHER refresh transport — the
  // body token from SecureStore (getRefreshToken) OR the transport's cookie
  // jar (React Native's fetch persists the httpOnly refresh cookie on both
  // platforms, so a same-session relaunch can refresh via cookie). A failure
  // of both = signed out.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await client.refresh();
        const me = await auth.me();
        if (!cancelled) setUser(me);
      } catch {
        if (!cancelled) setUser(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const res = await auth.login({ email, password });
      // LoginResponse.refreshToken carries the Set-Cookie refresh token when
      // the transport exposed headers (native fetch does). Persist it; the
      // client's onRefreshToken hook covers later rotations.
      if (res.refreshToken) {
        await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, res.refreshToken);
      }
      client.setAccessToken(res.accessToken);
      setUser(res.user);
    },
    [auth, client]
  );

  const signOut = useCallback(async () => {
    await auth.logout().catch(() => {});
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {});
    client.setAccessToken(undefined);
    setUser(undefined);
  }, [auth, client]);

  const value = useMemo<AuthState>(
    () => ({ api: client, auth, chats, crossChats, user, signIn, signOut }),
    [client, auth, chats, crossChats, user, signIn, signOut]
  );

  // M1: register the device's Expo Push token once signed in (permission →
  // token → backend row); notification taps deep-link via lib/push.ts.
  // user is null while restoring, undefined when signed out, a User when in.
  usePushRegistration(user ? client : undefined, !!user);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
