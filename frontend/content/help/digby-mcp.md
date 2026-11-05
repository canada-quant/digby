# digby-mcp — the Digby platform as MCP tools

> Phase P6 of `DIGBY_PLATFORM_UNIFICATION_PLAN.md`: the platform REST API
> (`/api/crossmodel/platform`, see **[DIGBY_PLATFORM_API.md](./DIGBY_PLATFORM_API.md)**)
> exposed as MCP tools so any MCP-capable client/agent can drive Digby **as a
> specific user** — list and manage chats, folders, and schedules, send
> messages, start coding sessions — with that user's permissions.

The server is a **dumb pipe**: 17 tools, each mapping 1:1 to a platform REST
endpoint (the same endpoints the in-loop agent tools and the web UI use). All
authorization — agent-token scopes, owner/member scoping, audit — stays in the
backend (`middleware/agent-auth.ts`, `platform.service.ts`).

## Auth model: per-user pass-through — NEVER shared-key

The MCP client supplies the **end user's own credential** per connection:

- their **Digby JWT** (full access to their own resources), or
- an **agent token** (`dgt_` + 48 hex chars, minted in **Account → Developer**),
  limited to the token's scopes.

How it flows:

1. Client connects with the credential — `Authorization: Bearer <token>`
   header (HTTP transport) or `DIGBY_USER_TOKEN` env (stdio transport).
2. digby-mcp forwards it **verbatim** as `Authorization: Bearer <token>` to
   `${DIGBY_API_URL:-http://localhost:4000}/api/crossmodel/platform/*`.
3. The backend validates the JWT *or* resolves the agent token, enforces its
   scopes (`requireScope`), then applies normal owner/member scoping — and
   audits every mutation (`Activity`, resource `platform`).

digby-mcp holds **no token of its own, no shared secret, and no permission
logic**. If a request arrives without an `Authorization: Bearer …` header it is
rejected with 401 before any tool exists.

**Why never shared-key (confused-deputy note):** the `mcp-gateway/` BrightData
proxy authenticates every caller with one shared `MCP_API_KEY` and then acts
with a single over-privileged identity. Copied here, that would mean *anyone
holding the shared key could act as any user* — the gateway would become a
confused deputy that turns "can call the MCP server" into "can run coding
sessions / delete chats as someone else". Per-user pass-through keeps the
delegation chain intact: the backend always sees *who* is acting and *with
what scopes*, and a leaked `dgt_…` token is revocable per user in Account →
Developer.

**Error surfacing:**

| Upstream | Tool result |
|---|---|
| 401 (bad/expired/revoked token) | `isError` — "Authentication failed (401): … mint a new agent token in Account → Developer (or sign in again for a fresh JWT)." |
| 403 `insufficient_scope` | `isError` — "Insufficient scope (403): this call requires scope(s): X. Re-mint your agent token with the required scope(s)…" |
| 429 / 4xx / 5xx | `isError` — the API's error message passed through |

## Tools

Names mirror the P1 internal platform tool set; input schemas mirror the REST
bodies (`platform.validation.ts`). Responses are a one-line summary plus the
REST JSON.

| Tool | Endpoint | Required scope |
|---|---|---|
| `list_chats` | `GET /chats` | `chats:read` |
| `get_chat_status` | `GET /chats/:id/status` | `chats:read` |
| `create_chat` | `POST /chats` | `chats:write` |
| `send_chat_message` | `POST /chats/:id/messages` | `chats:write` |
| `start_coding_session` | `POST /chats/:id/code` | `code:run` |
| `move_chat` | `PATCH /chats/:id` `{folderId}` | `chats:write` |
| `rename_chat` | `PATCH /chats/:id` `{title}` | `chats:write` |
| `archive_chat` | `PATCH /chats/:id` `{archived}` | `chats:write` |
| `delete_chat` | `DELETE /chats/:id` | `chats:write` |
| `list_folders` | `GET /folders` | `folders:read` |
| `create_folder` | `POST /folders` | `folders:write` |
| `update_folder` | `PATCH /folders/:id` | `folders:write` |
| `move_folder` | `PATCH /folders/:id` `{parentId}` | `folders:write` |
| `delete_folder` | `DELETE /folders/:id?reparentTo=` | `folders:write` |
| `create_schedule` | `POST /schedules` | `schedules:write` |
| `list_schedules` | `GET /schedules` | `schedules:write` (list is privileged — a schedule fires with the owner's identity) |
| `cancel_schedule` | `DELETE /schedules/:id` | `schedules:write` |

A user JWT passes every scope check (full access to own resources). Agent
tokens get exactly the scopes they were minted with.

## Run it

### stdio (local MCP clients — Claude Desktop-style)

```bash
cd digby-mcp
npm ci && npm run build
DIGBY_USER_TOKEN=dgt_… DIGBY_API_URL=https://digby.ai node dist/server.js --stdio
# or: DIGBY_MCP_TRANSPORT=stdio … node dist/server.js
```

- `DIGBY_USER_TOKEN` (required): the raw token — your JWT or `dgt_…` agent
  token. (A leading `Bearer ` is tolerated and stripped.)
- `DIGBY_API_URL` (optional): backend base URL, default `http://localhost:4000`.
- All logs go to stderr; stdout carries the JSON-RPC protocol only.

### HTTP (house pattern — how the other `*-mcp` services run)

```bash
cd digby-mcp
npm ci && npm run build
DIGBY_API_URL=http://localhost:4000 node dist/server.js   # listens on :8000 (MCP_SERVER_PORT)
```

- `POST /mcp` — StreamableHTTP (stateless); every request must carry
  `Authorization: Bearer <jwt-or-dgt_…>` and `Accept: application/json, text/event-stream`.
- `GET /health` — liveness.

### Container

Declared as `digby-mcp` in `docker-compose.base.yml` (host port `8206` →
container `8000`), same shape as the other `*-mcp` services — except there is
**no** `*_MCP_API_KEY`; only `DIGBY_API_URL` (default `https://digby.ai` —
the public URL: the ALB routes to the live blue-green color. NEVER pin
`admin-backend-blue`/`admin-backend-green` — the losing color's containers
are stopped after each flip):

```bash
docker compose -f docker-compose.base.yml up -d --build digby-mcp
curl -X POST http://localhost:8206/mcp \
  -H "authorization: Bearer $DIGBY_TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## MCP client config (example)

Generic `mcpServers` block — stdio flavor (the common case for desktop
clients):

```json
{
  "mcpServers": {
    "digby": {
      "command": "node",
      "args": ["/path/to/crossmodel/digby-mcp/dist/server.js", "--stdio"],
      "env": {
        "DIGBY_USER_TOKEN": "dgt_paste_your_agent_token_here",
        "DIGBY_API_URL": "https://digby.ai"
      }
    }
  }
}
```

HTTP flavor (clients that speak StreamableHTTP):

```json
{
  "mcpServers": {
    "digby": {
      "url": "http://localhost:8206/mcp",
      "headers": { "Authorization": "Bearer dgt_paste_your_agent_token_here" }
    }
  }
}
```

Mint the token first: **Account → Developer → Agent tokens** (or
`POST /api/crossmodel/platform/tokens` with your JWT). Give it only the scopes
the client actually needs — e.g. `chats:read` + `chats:write` for a chat
assistant; add `code:run` only for clients that should start coding sessions.

## Development

```bash
npm run dev     # tsx watch (HTTP mode)
npm run build   # tsc → dist/
npm run smoke   # end-to-end: login + mint token + stdio & HTTP JSON-RPC
                # (initialize / tools/list / tools/call) + auth-negative checks,
                # then revokes the token. Needs a live backend (default
                # http://localhost:4000) and the e2e user (override with
                # E2E_EMAIL / E2E_PASSWORD).
```

## See also

- [DIGBY_PLATFORM_API.md](./DIGBY_PLATFORM_API.md) — the REST surface, scopes,
  error shapes, and token management this server forwards to.
- `DIGBY_PLATFORM_UNIFICATION_PLAN.md` — P6 and design question (a) (why MCP is
  last, and why only with per-user JWT pass-through).
