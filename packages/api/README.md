# @digby/api

Typed Digby API client — pure TypeScript, zero React, injectable `fetch`.

Extracted from the web client (`frontend/lib/api-client.ts`, `frontend/lib/auth.ts`,
`frontend/lib/api/ai-chat.ts`) per the client-platforms roadmap §3.2 item 5, so
the mobile apps share one typed surface with the web app.

## Design

- **Injectable transport** — the constructor takes a `fetch` (or defaults to the
  global). Mobile injects `expo/fetch` in M1; tests inject a stub.
- **Bearer auth, 15-min access token** — set at construction (`accessToken`) or
  via `setAccessToken`; every call sends `Authorization: Bearer <token>`.
- **401 → single-flight refresh → one retry** — concurrent 401s share a single
  refresh round-trip (the promise itself is the guard). A 401 that survives the
  retry fires `onSessionExpired` — that's the definitive-auth-failure signal the
  web client exposes as `isDefinitiveAuthFailure`.
- **Refresh token transport is host-owned**: the backend accepts
  `req.cookies.refreshToken || req.body?.refreshToken` (auth.controller.ts), so
  mobile (which cannot read the httpOnly cookie) persists the refresh token in
  `expo-secure-store` and supplies `getRefreshToken` — the client then sends it
  in the refresh body. Web hosts omit `getRefreshToken` and rely on the cookie
  (`credentials: 'include'`).
- **No SSE here.** Streaming is M1 (`expo/fetch` + the Bearer-on-SSE backend
  change, roadmap §3.2 item 1) — deliberately out of scope.

## Endpoints covered

| Namespace | Endpoint | Notes |
|---|---|---|
| `auth.login` | `POST /api/auth/login` | → `{ user, accessToken }` |
| `auth.refresh` | `refresh()` | single-flight; body `refreshToken` if host supplies it |
| `auth.me` | `GET /api/auth/me` | |
| `auth.logout` | `POST /api/auth/logout` | fire-and-forget |
| `chats.list` | `GET /api/ai-chats` | paginated, newest first |
| `chats.get` | `GET /api/ai-chats/:id` | full transcript |
| `chats.create` | `POST /api/ai-chats` | |
| `chats.send` | `POST /api/ai-chats/:id/messages` | no SSE (M1) |

## Usage

```ts
import { DigbyApiClient, fetchAuth, fetchChats } from '@digby/api';

const api = new DigbyApiClient({
  baseUrl: 'https://digby.ai',
  getRefreshToken: () => secureStoreRead('digby.refreshToken'),
  onAccessToken: (t) => (accessTokenInMemory = t),
});
const auth = fetchAuth(api);
const chats = fetchChats(api);

await auth.login({ email, password });
const list = await chats.list({ page: 1, limit: 20 });
```
