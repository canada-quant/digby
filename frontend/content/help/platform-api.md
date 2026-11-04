# Digby Platform API

> External REST API + scoped agent tokens (Phase P3 of
> `DIGBY_PLATFORM_UNIFICATION_PLAN.md`). Base URL: `/api/crossmodel/platform`.
>
> Everything here is a thin transport over `platform.service.ts` — the **same**
> service the internal agent platform tools (`platform-tools.ts`) call. A model
> inside a run and a curl script outside get identical behavior and identical
> permissions. All mutations are audited (`Activity`, resource `platform`).

## Authentication

Two caller types, one header:

```
Authorization: Bearer <token>
```

| Caller | Token | Access |
|---|---|---|
| **User JWT** | The normal login access token | Full access to your own resources (scope checks pass) |
| **Agent token** | `dgt_` + 48 hex chars, minted in Account → Developer | Only the token's scopes; then normal owner/member rules |

Agent tokens are **sha256-hashed at rest** — the raw token is shown exactly
once at mint and cannot be retrieved later. Revocation and expiry are enforced
on every request. `lastUsedAt` is best-effort (throttled to one write/minute).
A token whose owner is missing or inactive is `401` with the exact text
`Agent token owner not found`.

### Scopes

| Scope | Allows |
|---|---|
| `chats:read` | `GET /chats`, `GET /chats/:id/status`, `GET /chats/:id/messages`, `GET /hooks`, `GET /chats/:id/autonomy` |
| `chats:write` | `POST /chats`, `POST /chats/:id/messages`, `PATCH /chats/:id` (`{title?, mode?, folderId?, archived?, systemPrompt?}` — `mode` sets the patience level and `systemPrompt` the standing instructions since 2026-09-24), `PATCH /hooks/:id` (`{eventTypes?, promptTemplate?, debounceSec?, enabled?}`, T4c 2026-09-24), `DELETE /chats/:id`, `POST /supervisor/ensure`, `POST /hooks` (`{sourceChatId?, projectId?, targetChatId, eventTypes, promptTemplate?, debounceSec?}` — `projectId` = project-scope wildcard, mutually exclusive with `sourceChatId`, since 2026-09-25), `DELETE /hooks/:id`, `PUT /chats/:id/autonomy` |
| `folders:read` | `GET /folders`, `GET /goals`, `GET /goals/:id`, `GET /todos` |
| `folders:write` | `POST /folders`, `PATCH /folders/:id`, `DELETE /folders/:id`, `POST /goals`, `PATCH /goals/:id`, `POST /todos`, `PATCH /todos/:id` |
| `schedules:write` | `POST /schedules`, `GET /schedules`, `PATCH /schedules/:id` (`enabled` pause/resume, and/or `prompt`, and/or `intervalSec` — integer, min **900** = 15 min, max 31 days), `DELETE /schedules/:id`. Schedule and todo ids may be a uuid **or** a unique ≥8-character hex prefix. Chat ids stay UUID. — **note: list is gated on the write scope too** (a schedule fires with the chat owner's identity, so reading them is treated as privileged) |
| `code:run` | `POST /chats/:id/code`, `POST /folders/:id/workspace` — start coding sessions |

Missing a scope → `403 { "error": "insufficient_scope", "required": ["chats:write"] }`.

**Child accounts:** `code:run` routes and all token-management routes reject
child users (`403 CHILD_ACCOUNT_FORBIDDEN`), same as the coding surface.

## Endpoints

### Chats

```bash
# List (filter by folder / mode / coding status / free-text q; derived filters
# running=true|false and codeCapable=true|false; paginated). `mode` includes
# `auto`. `limit` defaults to 50 and is capped at 200.
curl "$BASE/chats?folderId=$FOLDER&mode=thinking&status=running&q=market&running=true&page=1&limit=50" \
  -H "Authorization: Bearer $TOKEN"

# Create
curl -X POST "$BASE/chats" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"title": "Research: market map", "folderId": null, "mode": "deep_research"}'

# Send a message (queues a detached agent turn; attach via the live stream).
# Optional per-message `mode` override — any patience mode, or 'auto' for
# heuristic routing; omitted → the chat's stored mode. The 202 response echoes
# the RESOLVED mode (+ the routing decision for 'auto'). Never persisted.
# Since 2026-09-26 this seam resolves the level exactly like the web stream
# (platform/send-mode.ts): under the instance's `patience_auto_only` switch a
# human explicit level is routed as Auto (kept as routing.requestedMode); a
# resolved deep_research RESERVES the daily council quota and demotes to
# 'thinking' (routing.clamped 'quota') when none is left; a supervisor chat
# never runs the council on a human turn; agent / webhook sends are floored
# to 'thinking' (routing.reasonKey 'channel_floor').
# Optional `as`: `user` | `agent`. A `dgt_` token is always agent; `as: "user"`
# from one is 403 "Agent tokens cannot send as a user". Only a JWT may send
# `as: "user"`. Optional `delivery`: `queue` | `steer` | `interrupt`. Omitted
# on a JWT keeps today's behavior (a coding chat steers the live run; a busy
# plain human turn answers a pending ask_user and preempts). Agents default to
# `queue`. An agent send is origin `agent` and omits `userTurnAt`, so it never
# answers ask_user, never preempts a running run, never confirms a pending
# action, and is never injected into a coding run as a user turn — `interrupt`
# for an agent queues the same way `queue` does. The 202 may include `delivery`
# (`queue` | `steer` | `started`) and `runId` when a run id exists (a plain
# start, and a coding send queued behind a busy run). An immediate coding start
# and a steer omit `runId`.
curl -X POST "$BASE/chats/$CHAT/messages" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"content": "Summarize what you found", "mode": "auto"}'

# Live status (run state, coding state, plan progress)
curl "$BASE/chats/$CHAT/status" -H "Authorization: Bearer $TOKEN"

# Transcript read (paginated — pages BACKWARD: pass the previous page's
# `nextBefore` as ?before=; messages within a page are chronological)
curl "$BASE/chats/$CHAT/messages?limit=50&before=$MSG_ID" -H "Authorization: Bearer $TOKEN"

# Start a coding session from a chat (uses the chat's folder workspace) — code:run
curl -X POST "$BASE/chats/$CHAT/code" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"permissionMode": "auto"}'

# Rename / move / archive
curl -X PATCH "$BASE/chats/$CHAT" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title": "New title", "folderId": null, "archived": true}'

# Delete
curl -X DELETE "$BASE/chats/$CHAT" -H "Authorization: Bearer $TOKEN"
```

### Folders

```bash
# Tree (flat lists with parentId/depth/path for owned + shared — client assembles).
# `?archived=true` lists archived folders; omitted or `false` is the live tree.
curl "$BASE/folders" -H "Authorization: Bearer $TOKEN"

# Create (parentId nests; depth cap 5)
curl -X POST "$BASE/folders" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name": "Client A", "parentId": "'$WORK'", "emoji": "🗂️", "color": "violet", "systemPrompt": "…"}'

# Edit / move (parentId in PATCH = move, with cycle + depth checks)
curl -X PATCH "$BASE/folders/$FOLDER" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name": "Client A (2026)", "parentId": "'$ARCHIVE'"}'

# Delete (children promote to root, or move under ?reparentTo=)
curl -X DELETE "$BASE/folders/$FOLDER?reparentTo=$WORK" -H "Authorization: Bearer $TOKEN"

# Start a coding session in the folder's workspace — code:run
curl -X POST "$BASE/folders/$FOLDER/workspace" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"title": "Fix the build", "permissionMode": "plan"}'
```

### Schedules

```bash
# Create: fire a prompt into a chat on an interval (kind: once | recurring)
curl -X POST "$BASE/schedules" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"chatId": "'$CHAT'", "prompt": "Check CI and report", "kind": "recurring", "intervalSec": 3600}'

# List (all your schedules across chats)
curl "$BASE/schedules" -H "Authorization: Bearer $TOKEN"

# Cancel
curl -X DELETE "$BASE/schedules/$SCHEDULE" -H "Authorization: Bearer $TOKEN"

# Pause / resume (2026-09-24): keeps prompt, cadence and history; 409 with the reason when it cannot resume.
# The body may also set `prompt` and/or `intervalSec` (integer, min 900 = 15 min, max 31 days).
# `:id` may be a uuid or a unique ≥8-character hex prefix.
curl -X PATCH "$BASE/schedules/$SCHEDULE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"enabled":false}'
curl -X PATCH "$BASE/schedules/$SCHEDULE" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"enabled":true}'
```

### Fleet supervisor

Goals / todos / hooks / autonomy — thin transport over `goals.service` /
`hooks.service` / `autonomy.service`, the same services the in-loop fleet
tools call. Goals and todos are **folder-scoped** (`folders:read` /
`folders:write`); hooks and autonomy are **chat-scoped** (`chats:read` /
`chats:write`). There is deliberately NO delete for goals/todos — archive via
status instead; hooks unsubscribe via `DELETE`.

```bash
# Ensure the caller's ONE global "Fleet Supervisor" chat exists (idempotent).
# JWT only — NEVER an agent token, never a child account.
curl -X POST "$BASE/supervisor/ensure" -H "Authorization: Bearer $JWT"

# Goals — list (projectId optional; omitted = account-wide across owned
# folders, tagged with projectName) / detail / create / update.
# status: active | blocked | done | archived
curl "$BASE/goals?projectId=$FOLDER&status=active" -H "Authorization: Bearer $TOKEN"
curl "$BASE/goals/$GOAL" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/goals" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"projectId": "'$FOLDER'", "title": "Ship the migration", "dependsOnGoalIds": []}'
curl -X PATCH "$BASE/goals/$GOAL" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"status": "blocked", "blockedReason": "waiting on DNS"}'

# Todos — list (goalId= or projectId=, at most one; neither = account-wide) /
# create / update. status: pending | in_progress | blocked | done.
# GET and PATCH `:id` may be a uuid or a unique ≥8-character hex prefix.
curl "$BASE/todos?goalId=$GOAL" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/todos" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"goalId": "'$GOAL'", "title": "Cut the DNS over", "assigneeChatId": "'$CHAT'"}'
curl -X PATCH "$BASE/todos/$TODO" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"status": "done"}'

# Event hooks — list / subscribe / unsubscribe. An omitted/null sourceChatId
# is an owner-scope WILDCARD: every chat the caller owns emits to the target.
curl "$BASE/hooks?targetChatId=$CHAT" -H "Authorization: Bearer $TOKEN"
curl -X POST "$BASE/hooks" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"targetChatId": "'$CHAT'", "eventTypes": ["run_completed", "run_failed"], "debounceSec": 60}'
# PROJECT-SCOPE hook (parity with the hook_subscribe tool): projectId bounds the
# wildcard to ONE folder the caller OWNS — only chats in that folder emit (the
# project-supervisor wiring shape). projectId and sourceChatId are mutually
# exclusive (400); a folder that is missing or not owned is a 404. The created
# row carries createdVia "rest" and GET /hooks lists it with projectId.
curl -X POST "$BASE/hooks" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"projectId": "'$FOLDER'", "targetChatId": "'$CHAT'", "eventTypes": ["run_completed", "run_failed"]}'
curl -X DELETE "$BASE/hooks/$HOOK" -H "Authorization: Bearer $TOKEN"

# Autonomy — read a chat's grant (404 when none exists) / grant or revoke
# (empty allowedTools revokes). PUT is JWT only — NEVER an agent token (a
# machine principal must not self-grant autonomy) and never a child account.
curl "$BASE/chats/$CHAT/autonomy" -H "Authorization: Bearer $TOKEN"
curl -X PUT "$BASE/chats/$CHAT/autonomy" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"allowedTools": ["send_chat_message", "schedule_message"], "scheduleCap": 48}'
```

### Agent tokens (JWT only — an agent token can NEVER manage tokens)

```bash
# List (id, name, prefix, scopes, lastUsedAt, expiresAt, createdAt — never the hash)
curl "$BASE/tokens" -H "Authorization: Bearer $JWT"

# Mint — the raw token is returned ONCE
curl -X POST "$BASE/tokens" -H "Authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"name": "CI bot", "scopes": ["chats:read", "chats:write"], "expiresAt": "2026-12-31T00:00:00Z"}'
# → { "id": "…", "tokenPrefix": "dgt_ab12cd34", "token": "dgt_ab12cd34…48hex", … }

# Revoke
curl -X DELETE "$BASE/tokens/$TOKEN_ID" -H "Authorization: Bearer $JWT"
```

You can also mint/revoke in the UI: **Account → Developer → Agent tokens**.

## In-loop platform tools vs this REST API

The model-facing platform tools (`platform/platform-tools.ts`, plus — since
2026-09-08 — the **account-tool group** in `platform/account-tools.ts`) and this
REST surface sit on the SAME service layer: a tool call inside a run and a curl
from outside reach identical code with identical ownership checks. Two things
differ.

**The account tools wrap EXISTING routes outside `/platform`.** Nothing new was
added under `/api/crossmodel/platform` for them — their REST twins are the
authenticated app routes that already existed (all under `/api/crossmodel`):

| Tool(s) | REST twin |
|---|---|
| `list_memory`, `remember_fact`, `forget_fact` | `GET` / `PUT` / `DELETE /memory` |
| `list_canvases`, `get_canvas`, `update_canvas` | `GET /canvases`, `GET` / `PUT /canvases/:id` |
| `create_share_link`, `revoke_share_link` | `POST` / `DELETE /chats/:id/share` (both delegate to `sharing.service.ts`) |
| `add_knowledge_url` (and `add_knowledge_note`, `list_knowledge_documents`) | `POST /projects/:id/documents/url` — same ingestion pipeline as the documents routes (in-loop: capped 10/hour per chat + 50/day per user; the URL form needs a live user turn) |
| `telegram_connect_link` | none directly — it returns the Account → Integrations page, whose browser calls `POST /telegram/connect-link` to mint the one-time link (the token never reaches the model) |
| `create_chat_webhook`, `get_chat_webhook`, `revoke_chat_webhook` | `POST` / `GET` / `DELETE /chats/:id/webhook` — in-loop, create is CONSEQUENTIAL + never autonomous; two token routes (ticket 2eef354e): pass `envKey` and the minted bearer is stored SERVER-SIDE in the encrypted coding credentials (the store_secret destination — every coding session shell gets `$ENVKEY`), or omit it and the token is returned only on the owner-browser confirm (`ctx.ownerBrowser`, shown once) — either way never to the model; a no-`envKey` confirm that is not the owner's browser refuses BEFORE minting (the token is unrecoverable by design). Drive change notifications: use `subscribe_drive_watch` (first-class, no token) |
| `set_chat_instructions`, `get_chat_instructions` | the chat's standing `systemPrompt` — since 2026-09-24 editable over REST: `PUT /chats/:id {systemPrompt}` (app route) and `PATCH /platform/chats/:id {systemPrompt}` (owner-only; supervisor chats refused; `''`/null clears; Activity-audited). In-loop: THIS chat needs a live user turn; ANOTHER owned chat (`chatId`) is consequential (card / autonomy grant / parent-implicit / supervisor seat). Read back via `get_chat_instructions` (full text) or `get_account_overview.thisChat.instructions` (preview) |
| `stop_run` | the UI Stop button's own endpoint: `POST /api/crossmodel/agent/stop` body `{chatId}` for a plain chat's detached run; `POST /api/crossmodel/coding/sessions/:id/stop` for a coding session's active/queued run. In-loop the tool is consequential and target-scoped (own chat + first-degree children card-free; supervisor seat pre-granted; anything else stages a confirmation) |
| `answer_chat_question`, `approve_request` | `POST /api/crossmodel/chats/:chatId/questions/:questionId` (answer an ask_user a chat's run is parked on) and `POST /api/crossmodel/chats/:id/approvals/:approvalId` (decide a permission request) — the question/approval cards' own endpoints. `approve_request` additionally refuses ask-only (destructive) tools in machine-triggered runs — humans decide those, always |
| `pause_schedule`, `resume_schedule` | `PATCH /platform/schedules/:id {enabled:false\|true}` — pause keeps the schedule resumable (`DELETE /platform/schedules/:id` is `cancel_schedule`, the permanent retire). The same PATCH also accepts `prompt` and `intervalSec` (min 900 seconds, max 31 days), and `:id` may be a unique ≥8-character prefix |
| `set_chat_mode` (`{mode?, leadModel?}`) | `PUT /chats/:id {mode, leadModel}` (app route — there is NO `PATCH` on the app route; `PATCH /platform/chats/:id` carries `mode` but not `leadModel`). Per-chat lead model since 2026-09-25 (`crossmodel_chats.leadModel`, migration 20260925190000): pick set = Digby seat built-ins + enabled registry models, 400 on an invalid id, refused on supervisor chats + coding sessions, `CHAT_LEAD_MODEL_OVERRIDE_DISABLED=1` ignores it at run time |
| `get_run_receipts` | `GET /platform/chats/:id/receipts` — since 2026-09-25 the response ALWAYS carries `chatTurns` (empty array, never omitted) beside the tool receipts; since ticket e225aad8 (2026-10-18) each chat/supervisor turn's receipts group under the turn's own telemetry id (`chat-<uuid>`, `chatTurns[].runId`) — owner-card executions keep `runId` null — and a `?runId=` that names a chat turn's id returns that turn's receipts instead of 404. A confirmation-STAGED call shows as an ok:false `{staged:true, confirmationId}` receipt (never evidence) and the owner's confirm as its own ok:true/false row. The REST query schema accepts `limit` 1–50 and an optional `runId`; omitted `limit` stays the tool default of 3, and the executor still caps a present limit at 10 |
| `test_model_role` (`{role, candidate?, fallback?}`, admin READ, 60 s cap — the image seat 190 s since 61d33af9 (2026-10-10), Activity `model_role.test`) | `POST /admin/model-roles/test` — the same live per-role probe with the real call shape; a non-admin caller gets an honest ok:false receipt (verified live 2026-09-25). Since 7a078b4d (2026-09-28) the agent tool ALSO heals the admin panel's own seat labels: `role:'decision_gate'` → seat `decision` (echoed `healedFrom`), and a decision BACKEND spec as `role` (`jev` / `deepseek-flash`) probes `{role:'decision', candidate:<spec>}`; the REST twin stays strict (`normalizeRoleKey` synonyms aside). The ADMIN UI's Test for image seats rides the SSE twin `POST /admin/model-roles/test/stream` (61d33af9): same probe, keepalive comments every 15 s + ONE terminal result frame — the image probe's 180 s budget outlives the ALB's 60 s idle timeout |
| decision gate — no in-loop tool | admin only (403 otherwise): `GET` / `PUT /admin/model-roles/decision-modes` (store-backed fleet-wide gate mode per purpose, `{modes:{<purpose>: off\|shadow\|act\|''}}`; since the E12 admission of 2026-09-25 the PUT refuses `act` with a 409 naming the missing bar unless a fresh ≤7-day `ready:true` readiness stamp exists) and `GET /admin/model-roles/decision-readiness` (the 6-h `decision-gate-readiness` cron's latest report + `computedAt`; the GET never recomputes). Canonical: `docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md` §6 |
| `get_fleet_telemetry` views `jobHealth` / `deploy` | `GET /admin/job-health` — both call `fleet/deploy-health.ts probeDeployHealth()` (`DEPLOY_HEALTH_PROBE_DISABLED`, `DEPLOY_HEALTH_PROBE_BASE_URL`) |
| `get_account_overview`, `notify_user` | in-loop only — no REST twin (`notify_user` pushes to the caller's OWN linked Telegram, Redis-capped 30/day per user + 5/hour per chat) |

**Consequential / never-autonomous semantics are enforced in the TOOL layer, not
here.** Inside a run, `create_share_link` requires a
user-turn-anchored confirmation (like `schedule_message`), and the
never-autonomous set (`set_chat_autonomy`, `create_share_link`) accepts no
auto-mode bypass, no ChatAutonomy grant and no implicit parent→child path — a
model that has ingested untrusted text must never be able to change the
account's security posture. Two authority-neutral, fail-closed exceptions exist
for `set_chat_autonomy`: the 9341e862 non-widening self-request, and the
eb4337fe scoped supervisor delegation (a supervisor-class lane granting a
same-owner supervised lane within its own effective tools/cap; source
'machine_delegated'). A first-use RECURRING `schedule_message` whose prompt
matches a stored owner digest preference also arms card-free (eb4337fe limb B).
`remember_fact`, `forget_fact`,
`set_chat_instructions` and `add_knowledge_url` refuse machine-triggered runs
outright (persistence primitives).
REST callers are authenticated humans (JWT) or scoped agent tokens acting on
their own behalf, so those routes carry no confirmation handshake: the token's
scopes and the existing ownership checks are the whole gate.

## Rate limit

**300 requests/minute per user** across the whole platform surface
(`429 { "error": "Too many requests…" }`, standard `RateLimit-*` headers).

## Error shapes

| Status | Body | When |
|---|---|---|
| 401 | `{ "error": "No token provided" }` / `"Invalid agent token"` / `"...revoked"` / `"...expired"` / `"Agent token owner not found"` (missing or inactive owner) | Auth failed |
| 403 | `{ "error": "insufficient_scope", "required": [...] }` | Agent token lacks a scope |
| 403 | `{ "error": "This route requires your account session" }` | Agent token hit a JWT-only route (`/tokens`, `PUT /chats/:id/autonomy`, `POST /supervisor/ensure`) |
| 403 | `{ "error": "Agent tokens cannot send as a user" }` | A `dgt_` token sent `as: "user"` on `POST /chats/:id/messages` |
| 403 | `{ "error": "…child account.", "code": "CHILD_ACCOUNT_FORBIDDEN" }` | Child user on `code:run` / `/tokens` |
| 400/404/409 | `{ "error": "<message>" }` | From `platform.service` (validation, not-found, run-already-active…) |
| 400 | `{ "error": "Validation error", "details": [...] }` | Zod body/query/param failure |
| 429 | `{ "error": "Too many requests…" }` | Rate limit |
