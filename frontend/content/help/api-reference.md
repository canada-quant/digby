# CrossModel — Backend API Reference

> ⚠️ STALE (2026-08-14): endpoint inventory predates the ca-central-1 fleet (dead tailscale URLs); trust backend route files; kept for history.

> 📖 This inventory covers the **core surface only** — see also the OpenAPI spec served by the backend at `/api/openapi.json` (Swagger UI at `/api/docs`).

Base URL: `http://localhost:4000/api` (dev) | `https://digby.ai/api` (prod)
Swagger docs: `http://localhost:4000/api/docs` (alias: `/api-docs`)

---

## Authentication

All protected endpoints require a JWT Bearer token.

SSE endpoints (`/stream`, `/profile/stream`) also accept `?token=<jwt>` as a query parameter because `EventSource` cannot set custom headers.

### Auth Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | Public | Create account (also creates a personal org; the account is email-verified at creation) |
| POST | `/auth/login` | Public | Get access + refresh tokens |
| POST | `/auth/logout` | Required | Revoke refresh token |
| POST | `/auth/refresh` | Cookie | Refresh access token |
| GET | `/auth/me` | Required | Get current user |
| POST | `/auth/verify-email` | Public | Consume an email-verification token (`{ token }`) |
| POST | `/auth/resend-verification` | Required | Re-send the verification link |

Rate limit on `/auth/login` and `/auth/register`: **20 requests per 15 minutes**.

#### Email verification

`register` creates the account **already verified** (`emailVerifiedAt` is stamped at creation),
so signing up needs no confirmation step and the "verify your email" prompt does not appear.
The verification machinery is retained for the resend surface: `resend-verification` mints a
single-use, 24-hour token and emails `<SELFHOST_PUBLIC_URL>/verify-email?token=…`; only the
token's **sha256** is stored, so a database read cannot mint a link. Re-requesting supersedes
the previous link. A mail failure never fails the signup.

**Email verification gates NOTHING** (owner directive 2026-11-07T06:40Z: "we dont want to limit
usage by email verfication at all … people need to freely use digby.ai logged in or not").
`assertEmailVerifiedForSend` is a permanent no-op: it reads no setting and no user row, and
cannot throw, so an unverified account can always send. The `require_email_verification`
SystemSetting is no longer consulted on any send path — do not restore that read.

#### Org quota (Phase 2 Cloud)

Every account is placed in exactly one auto-created **personal organization** (`personal: true`,
an `OWNER` membership flagged `isDefault`). Sends are metered against that org:

- `organizations.dailyMessageLimit` — per-UTC-day messages. **`NULL` means unlimited, and that
  is the default for every org**: new orgs are created with `NULL` and no creation-time default
  exists any more (owner directive 2026-11-07T06:40Z: "we dont want to limit by messages or
  anything for digby.ai"). There is no `ORG_DEFAULT_DAILY_MESSAGE_LIMIT` env var. An operator
  can still cap **one specific** org through the admin quota PUT — that is an abuse lever, not
  a product default.
- `org_model_usage_daily` — per-org, per-day, **per-model** token totals, capped via the
  `org_model_token_limits` SystemSetting (`{"default": n, "<model>": n|null}`).

Exhaustion **fails closed**: the send is refused with `429` and
`code: "ORG_QUOTA_EXCEEDED"`, never silently degraded to a cheaper model. The reservation is
taken before the run starts and the compute plan is chosen inside the run, so no deeper rung
(deeper look, council, double checker) can reach a model without first paying it. Machine
wakes (schedules, hooks, webhooks) are metered too, so they cannot be used to dodge the cap.
A suspended org (`suspended: true`) is refused regardless of remaining quota — the per-tenant
kill switch.

#### Lifetime spend cap (the ONE usage limit)

The only usage ceiling on digby.ai is a hard **lifetime model-spend cap**, enforced per
non-admin user (`org/spend-cap.service.ts`):

- `DIGBY_LIFETIME_SPEND_CAP_USD` — default **100**. Unset/blank, malformed or negative all
  resolve to 100 (a typo must never silently uncap spend); `0`, `unlimited` or `none` disable
  the cap (ops escape hatch).
- `DIGBY_SPEND_RESERVATION_USD` — default **1**. The budget **hold** taken by each admitted
  send. Malformed, negative or `0` all resolve to 1: a zero hold would restore exactly the
  concurrent-admission race the hold exists to close.
- Spend is the user's cumulative `run_spend` — live `loop_metrics` rows attributed to chats
  they own, **plus** `spend_daily_rollups` for older days, so the lifetime total survives the
  30-day `loop_metrics` sweep. It reuses the visitor-analytics attribution rule rather than
  defining a second one.
- **Admins are exempt** (the repo's `isAdminViewer` predicate).
- At or over the cap the send is refused with `402` and `code: "SPEND_CAP_REACHED"`, with a
  message naming the limit. It runs **before** the message reservation.
- **Admission is atomic.** Checking a total and then starting a run is not a cap — two
  concurrent sends read the same number and both pass — so the send guard admits under a
  **per-user Postgres transaction-scoped advisory lock** (`pg_advisory_xact_lock` on the user
  id, `spend_cap_admissions` table): inside that one transaction it reads the settled lifetime
  total, adds the user's live holds, compares `settled + holds + DIGBY_SPEND_RESERVATION_USD`
  against the cap, and writes one hold row before committing. Admissions for one user
  serialize; different users never block each other.
- A hold is a **reservation, not a charge** — it expires **30 minutes** after it is written
  (`RESERVATION_TTL_MS`), so a crashed or killed run cannot permanently occupy budget. Rows
  past their expiry are ignored by the admission read and swept opportunistically.
- **Residual limitation (the honest bound).** The ledger records actual cost *after* a run, so
  a single admitted run can exceed its $1 hold; the hold bounds concurrent-admission overshoot,
  not what one run costs — and because holds are counted alongside settled spend the guard errs
  conservative, refusing a send up to one hold early but never a dollar late.
- An unreadable spend total **fails open** (a database blip must not refuse every user); a
  **known** total at or over the cap **fails closed**, and an unreadable *hold* table is also a
  fail-open (infra) case. Machine wakes honour it too.

**Operator surface (admin only).** Both levers above have a reader in the quota guard, so they
also need a writer an operator can actually reach — a control you cannot apply is not a control.
Mounted behind the normal auth guard; each handler applies `isAdminViewer` (ADMIN role, plus the
owner e-mail on production only — on a self-hosted instance the ADMIN role is the only authority).

- `GET /api/crossmodel/admin/orgs?q=&limit=` — list workspaces (name/slug match, newest first).
  Discovery for the two writes below, which both take an org id.
- `PUT /api/crossmodel/admin/orgs/:orgId/suspension` — body `{ suspended: boolean, reason?: string }`.
  Suspending REQUIRES a non-empty `reason` (400 otherwise); reinstating (`suspended: false`) clears
  it, so a lifted suspension leaves no stale explanation on a live workspace. Members can still
  sign in and read their data while suspended — they cannot send.
- `PUT /api/crossmodel/admin/orgs/:orgId/quota` — body `{ dailyMessageLimit: number | null }`.
  A whole number ≥ 0 meters that tenant per UTC day; `null` restores unlimited (the self-host and
  pre-existing-account posture). `0` is a hard stop: the counter increments before the compare, so
  `0` refuses every send while leaving the tenant un-suspended.

Both writes are idempotent and reversible with the same call, and neither touches usage history.

---

## CrossModel Chat

Rate limit on all `/crossmodel` routes: **25 requests per 10 minutes**.

### Stream Endpoint (SSE)

```
GET /api/crossmodel/stream
```

| Param | Type | Values | Description |
|-------|------|--------|-------------|
| `message` | string | any | User's question |
| `mode` | string | `fast` \| `thinking` | Response depth |
| `webSearch` | string | `"true"` \| `"false"` | Enable web search |
| `chatId` | string | UUID | Optional: persist to chat |
| `projectId` | string | UUID | Optional: use project context |
| `token` | string | JWT | Optional: auth token (for EventSource) |
| `sessionId` | string | UUID | Optional: anonymous session ID |
| `modelSet` | string | `"frontier"` \| `"open_source"` | Override user preference |

SSE event types: `init`, `progress`, `model-response`, `chunk`, `followups`, `complete`, `error`

---

### Chat CRUD

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/crossmodel/chats` | Required | Create new chat |
| GET | `/crossmodel/chats` | Required | List user's chats (paginated) |
| GET | `/crossmodel/chats/:id` | Required | Get chat by ID |
| PUT | `/crossmodel/chats/:id` | Required | Update title / mode / projectId |
| DELETE | `/crossmodel/chats/:id` | Required | Delete chat |
| POST | `/crossmodel/chats/:id/messages` | Required | Add message (non-streaming) |

#### Create Chat Request
```json
{
  "title": "My Chat",
  "mode": "fast",
  "projectId": null
}
```

#### List Chats Query Params
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | 1 | Page number |
| `limit` | number | 20 | Results per page |

---

### Projects

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/crossmodel/projects` | Required | Create project |
| GET | `/crossmodel/projects` | Required | List user's projects |
| GET | `/crossmodel/projects/:id` | Member | Get project + chats + docs |
| PUT | `/crossmodel/projects/:id` | Owner | Update name/description/systemPrompt |
| DELETE | `/crossmodel/projects/:id` | Owner | Delete project |
| POST | `/crossmodel/projects/:id/members` | Admin | Add member |
| DELETE | `/crossmodel/projects/:id/members/:memberId` | Admin | Remove member |

#### Create Project Request
```json
{
  "name": "My Project",
  "description": "What this project is about",
  "systemPrompt": "Custom instructions for all chats in this project",
  "emoji": "🚀",
  "color": "violet"
}
```

---

### Documents (RAG Knowledge Base)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/crossmodel/projects/:id/documents` | Required | Upload file to project (multipart) |
| POST | `/crossmodel/projects/:id/documents/url` | Required | Ingest URL into project knowledge base |
| GET | `/crossmodel/documents/:docId/status` | Required | Get document status (for polling) |
| DELETE | `/crossmodel/documents/:docId` | Required | Delete document + chunks |

#### File Upload
- `Content-Type: multipart/form-data`
- Field: `file` (PDF, DOCX, TXT, XLSX, PNG, JPG, GIF, WEBP)
- The target project is the `:id` path parameter

---

### Canvas

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/crossmodel/canvases` | Required | List all canvases for the user |
| GET | `/crossmodel/chats/:id/canvases` | Required | List canvases for chat |
| POST | `/crossmodel/chats/:id/canvases` | Required | Create canvas in chat |
| GET | `/crossmodel/canvases/:id` | Required | Get canvas document |
| PUT | `/crossmodel/canvases/:id` | Required | Update canvas content |
| DELETE | `/crossmodel/canvases/:id` | Required | Delete canvas |
| GET | `/crossmodel/canvases/:id/share` | Required | Get canvas share status |
| POST | `/crossmodel/canvases/:id/share` | Required | Share canvas |
| DELETE | `/crossmodel/canvases/:id/share` | Required | Revoke canvas share |

Canvas types: `document`, `code`, `html`, `mermaid`, `table`

---

### Sharing

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/crossmodel/chats/:id/share` | Required | Create/get share link |
| DELETE | `/crossmodel/chats/:id/share` | Required | Revoke share link |
| GET | `/crossmodel/shared/chat/:token` | Public | Get shared chat (read-only) |
| GET | `/crossmodel/shared/project/:token` | Public | Get shared project (read-only) |

---

### Memory & Profile

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/crossmodel/memory` | Required | Get user memory facts |
| PUT | `/crossmodel/memory` | Required | Update memory fact |
| DELETE | `/crossmodel/memory` | Required | Clear all memory |
| GET | `/crossmodel/profile/stream` | Optional | SSE: profile interview stream |
| GET | `/crossmodel/preferences` | Required | Get model set preference |
| PUT | `/crossmodel/preferences` | Required | Update model set preference |

---

## Admin Endpoints

### Users (Admin only)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/users` | List all users |
| POST | `/users` | Create user |
| GET | `/users/:id` | Get user |
| PUT | `/users/:id` | Update user |
| DELETE | `/users/:id` | Soft-delete user |

### Other Modules
| Module | Base Path | Notes |
|--------|-----------|-------|
| Analytics | `/analytics` | Event log + stats |
| Dashboard | `/dashboard` | Stats aggregation |
| AI Chat (legacy) | `/ai-chats` | Single-model chat |

---

## Error Responses

All errors follow this format:

```json
{
  "status": "error",
  "message": "Human-readable error message"
}
```

| Status Code | Meaning |
|-------------|---------|
| 400 | Validation error (Zod) |
| 401 | Missing or invalid JWT |
| 403 | Authenticated but not authorized |
| 404 | Resource not found |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

---

## Health Check

```
GET /health
→ { "status": "ok", "timestamp": "2026-03-05T..." }
```
