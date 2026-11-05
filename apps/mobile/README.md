# Digby mobile (M0 + M1 shipped; M1.5 in progress)

Expo app for iOS + Android — Workstream B of
[docs/CLIENT_PLATFORMS_ROADMAP_2026-09.md §3](../../../docs/CLIENT_PLATFORMS_ROADMAP_2026-09.md).

> **Where the plan lives now (2026-09-30):** roadmap §3.4 carries the
> milestone ladder with ship ticks; the current milestone is
> [`docs/MOBILE_M1_5_ANDROID_ROLLOUT.md`](../../docs/MOBILE_M1_5_ANDROID_ROLLOUT.md)
> (M1.5 — Android-first internal rollout: EAS builds + Play internal track),
> followed by
> [`docs/MOBILE_M2_5_STORE_AND_MONETIZATION.md`](../../docs/MOBILE_M2_5_STORE_AND_MONETIZATION.md)
> (M2.5 — Play production + Android-only monetization).
> **The Apple park is LIFTED (2026-09-30):** owner answer to `oq_e70a3c0b`
> — *"start building the ios and android apps as they will take a longer
> time to get polished"* — so iOS build work is back in scope (Apple
> enrollment remains an owner-console gate, see **Owner-console gates**
> below). M1.5 stays Android-first because it needs no Apple account to
> ship.

- **Stack:** Expo SDK 57 (expo `~57.0.25`, React Native 0.86.3, React 19.2) +
  expo-router + TypeScript — the roadmap §3.1 decision.
- **API:** the shared typed client in [`packages/api`](../../packages/api)
  (`@digby/api`) — injected here with the platform `fetch`.
- **Auth:** email/password against `/api/auth/*`. The 15-min access token lives
  in memory only; the refresh token persists in `expo-secure-store`
  (Keychain/Keystore) and is sent in the **body** of `/auth/refresh` (the
  backend accepts `req.cookies.refreshToken || req.body?.refreshToken`) —
  roadmap §3.2 item 4.

## What's here (M0 scope)

| File | Purpose |
|---|---|
| `app/_layout.tsx` | Root layout: `AuthProvider` (session owner) + expo-router `Stack` |
| `app/index.tsx` | Auth-state redirect: restoring → spinner, signed-out → `/sign-in`, signed-in → `/chats` |
| `app/sign-in.tsx` | Email + password → `auth.login`, errors inline |
| `app/chats.tsx` | Chat list (`GET /api/ai-chats`), pull-to-refresh, empty state, sign out |
| `app/chat/[id].tsx` | Chat detail: transcript + LIVE SSE streaming (send via `@digby/api` `sendMessageStream` — Bearer on both legs), markdown/code rendering (`react-native-enriched-markdown`, streaming-aware), composer with image attachments (`expo-image-picker` → base64 `POST /api/crossmodel/upload` → `uploadId`s ride the send) |
| `lib/auth-context.tsx` | Session owner: access token in memory, refresh token in SecureStore, launch restore (`refresh` → `me`), `signIn`/`signOut`; injects **`expo/fetch`** as the client transport (native response streaming — `resp.body.getReader()`); registers the device's Expo Push token once signed in |
| `lib/push.ts` | **M1:** expo-notifications permission → Expo Push token → `@digby/api` push registration; notification taps deep-link `digby://chat/<id>` via expo-router. Token registration is **silent** (`registerExpoPushTokenIfGranted`) — the ask happens in the soft-prompt. `getExpoPushTokenAsync` reads its `projectId` at runtime from `expo-constants` (`extra.eas.projectId`), so the EAS project id lands in `app.json` with no code change. |
| `lib/push-soft-prompt.tsx` | **M1.5 item G:** the notification permission ask moved off sign-in to the value moment — the first completed run. One-screen pre-prompt overlay (mounted at the root layout), OS ask only on "Turn on", once-per-install (SecureStore), denial non-blocking. **Skips (without settling) until `extra.eas.projectId` exists** — pre-`eas init` the token call cannot register anything, so the prompt arms itself on the first completed run after the owner's `eas init` writes the id. |
| `lib/config.ts` | `API_BASE_URL` (app.json `extra.apiBaseUrl` → `EXPO_PUBLIC_API_BASE_URL` → `https://digby.ai`) |

**Streaming contract** (backend pinned by `route-posture.test.ts` — "mobile
Bearer-on-SSE"): `POST /api/crossmodel/stream/register` (Bearer) →
`{streamToken}` → `GET /api/crossmodel/stream?streamToken=…` (Bearer). The
register's ownership check binds the token to the authenticated user, so the
same identity must ride BOTH legs. `Authorization: Bearer` is checked FIRST by
`optionalAuthenticate` (backend/src/middleware/auth.ts) — the roadmap §3.2
"cookie-only" premise was stale; no backend code change was needed, only
pinned tests + live curl proofs.

## Explicitly deferred (NOT shipped yet)

- **Backend push credentials** — the push module is env-gated and **inert without
  credentials** (`.env.example` documents `EXPO_ACCESS_TOKEN`, `APNS_*`,
  `FCM_*`). Expo Push — the default transport — needs none; APNs/FCM direct
  transports are the fallback for when Expo's throughput limits matter. The
  `push_tokens` migration (`20260925054000`) must run via `prisma migrate
  deploy` on the next prod deploy.
- **EAS project id** — `eas.json` (development / preview / production
  profiles) is committed; the **EAS account + project** (`eas init` →
  `expo.extra.eas.projectId` in `app.json`) is an owner-console gate — see
  **Owner-console gates** below. Push token fetch degrades gracefully
  (returns `null` → registration skips) until the id exists.
- **First real EAS builds (item F) + on-device validation battery (item H)**
  — need the EAS project + Firebase/FCM (Android) and Apple
  enrollment/APNs key (iOS) — owner-console gates. The build profiles and
  credentials wiring in code are ready for the moment they exist.
- **Sign in with Apple / Google** — post-M2 (roadmap §3.2 item 4).
- **Coding-session streaming (live runs / plan / diff panels)** — the unified
  stream endpoint carries coding runs too, but the mobile coding workspace UI
  is M1+; this milestone ships the plain-chat surface.

## Owner-console gates (owner actions, none block code work)

Everything below needs the owner at a vendor console. Code-side wiring is
done; each gate names the code that consumes it.

1. **EAS project** — `eas init` in `apps/mobile` (creates the project, prints
   the id) → owner pastes the id into `app.json`
   `expo.extra.eas.projectId`. Unblocks: real builds, push tokens with a
   pinned project.
2. **Firebase project + FCM v1 service account (Android push)** — create a
   Firebase project, register the Android app (`ai.digby.mobile`), register
   the FCM v1 service-account credentials with the Expo project
   (`eas credentials` / Expo dashboard). Backend side already coded:
   `FCM_SERVICE_ACCOUNT_JSON` / `FCM_SERVICE_ACCOUNT_FILE` env
   (backend push module, inert without creds).
3. **Apple Developer enrollment + APNs .p8 key (iOS push/builds)** — park
   LIFTED 2026-09-30 (oq_e70a3c0b answered); enrollment is still an
   owner-console action. APNs key upload to Expo (`eas credentials`).
   Backend side already coded: `APNS_*` env.
4. **Play Console organization account + D-U-N-S number** — $25 one-time;
   organization accounts need a D-U-N-S number with name/address matching
   across D&B, government records, and the Google payments profile
   (M1.5 brief §3.E / §7.1).

## Run it

```sh
# from the repo root (npm workspaces)
npm install
cd apps/mobile
EXPO_PUBLIC_API_BASE_URL=http://<your-dev-backend>:4000 npx expo start
```

## Typecheck

```sh
cd apps/mobile && npx tsc --noEmit
```
