# CrossModel — Backend API Reference

> ⚠️ STALE (2026-08-14): endpoint inventory predates the ca-central-1 fleet (dead tailscale URLs); trust backend route files; kept for history.

> 📖 This inventory covers the **core surface only** — see also the OpenAPI spec served by the backend at `/api/openapi.json` (Swagger UI at `/api/docs`).

Base URL: `http://localhost:4000/api` (dev) | `https://digby.example.com/api` (prod)
Swagger docs: `http://localhost:4000/api/docs` (alias: `/api-docs`)

---

## Authentication

All protected endpoints require a JWT Bearer token.

SSE endpoints (`/stream`, `/profile/stream`) also accept `?token=<jwt>` as a query parameter because `EventSource` cannot set custom headers.

### Auth Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/register` | Public | Create account |
| POST | `/auth/login` | Public | Get access + refresh tokens |
| POST | `/auth/logout` | Required | Revoke refresh token |
| POST | `/auth/refresh` | Cookie | Refresh access token |
| GET | `/auth/me` | Required | Get current user |

Rate limit on `/auth/login` and `/auth/register`: **20 requests per 15 minutes**.

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

## Admin Dashboard Endpoints

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
