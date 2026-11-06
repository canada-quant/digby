# Digby AI

> Ask once. Get the best of every AI.

**Digby AI** is an agentic chat platform orchestrated by **Kimi K3** — it answers directly for quick lookups, cross-checks itself with independent AI researchers for harder questions, and convenes a multi-model research council (GLM-5.3 + DeepSeek V4.1 Flash — both autonomous agentic researchers) for deep research — blending everything into one synthesized answer and streaming it in real time. It learns who you are, remembers context across sessions, and turns the bugs and feature requests you submit into shipped code.

Live at: **[digby.ai](https://digby.ai)**

![Digby AI](https://img.shields.io/badge/AI-Multi--Model-7C3AED?style=for-the-badge)
![License](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue?style=for-the-badge)
![Stack](https://img.shields.io/badge/Stack-Next.js_16_+_Express-000?style=for-the-badge)
![Deploy](https://img.shields.io/badge/Deploy-AWS_EC2_via_GitHub_Actions-orange?style=for-the-badge)

---

## ✨ Features

### Core Chat
- **🧠 Auto / Quick / Ensemble / Deep Research** — Digby picks the shape per message: one fast agent answer, an independently cross-checked answer, or a full multi-model research council — with **Dig deeper** under answers to take them further
- **🔀 Smart Synthesis** — Kimi K3 blends all responses into one coherent answer
- **📡 Real-Time Streaming** — SSE streams each step as it happens
- **🌐 Web Search** — Live internet access via BrightData MCP
- **⏹️ Stop Button** — Cancel any in-progress response
- **📊 Model Transparency** — See individual model responses, timing, and source models
- **🛠️ Digby Operates Digby** — 17 account tools let Digby set things up for you from inside the chat (memory, schedules, project knowledge bases, canvases, share links, Telegram notifications, per-chat instructions) — and it proactively offers the next step ("would you like me to…")
- **🎨 Rich Markdown** — Tables, code blocks, syntax highlighting, headings

### The Lineup (2026-09-10)
- **Kimi K3 orchestrates every level** — L1 Quick, L2 Ensemble main + synthesis, L3 Deep Research council lead (the built-in default; the prod store override since 2026-09-22 seats glm-5.3 there with kimi-k3 fallback — see the model matrix note below)
- **DeepSeek V4.1 Flash** (`deepseek-flash`, reasoning max, 1M context, native vision) — the Double Checker (a full agentic peer with its own tool loop) at Level 2 and an autonomous Level 3 council colleague (the vendor retired V4 Pro / V4 Flash on 2026-09-10; both legacy ids alias forward)
- **GLM-5.3** (reasoning max) — autonomous L3 council colleague
- **No frontier models** (since 2026-09-22) — every model call is an admin-editable seat on the four open-model providers (Moonshot, DeepSeek, Z.AI, DashScope) or your own endpoint

### Memory & Personalization
- **🧠 User Memory** — Digby remembers facts across every session (name, occupation, tech level, etc.)
- **👤 Profile Interview** — Digby assigns a companion voice matched to who you are
- **📍 Location Awareness** — Browser geolocation → AI knows if you're home or traveling
- **🎯 Companion Voice** — Response style adapts to your persona (tech professional, student, executive, etc.)

### Canvas & Projects
- **🎨 Canvas/Artifacts** — AI can create rich documents, code, diagrams in a side panel
- **📁 Projects** — Organize chats into folders with shared knowledge (RAG)
- **🔗 Chat Sharing** — Share any conversation via public read-only link

### Integrations
- **🔊 Voice Input** — Speech-to-text via the self-hosted STT service (Parakeet), with OpenAI Whisper-1 as fallback
- **🔈 Text-to-Speech** — Hear any response read aloud (OpenAI Nova voice)
- **📎 File Uploads** — Images, PDFs, Word docs (multi-file, drag-and-drop)
- **📧 Google Workspace** — Gmail, Calendar, Drive auto-injected when you ask (connect in Account → Integrations)
- **🖼️ Email Send** — Digby drafts emails and shows a Send/Edit/Cancel confirmation card

### Digby Code — Agentic Coding (`/crossmodel/code`)
- **🧑‍💻 Autonomous coding** — point GLM-5.3 at a GitHub repo, any git URL, or a blank project; it builds features, fixes bugs, and opens PRs in an isolated per-session git worktree + Docker container, streaming its work live.
- **🧭 Orchestrator + specialized workers** — the agent delegates to 8 role-scoped subagents (planner, architect, explorer, web-researcher, coder, editor, verifier, reviewer), with parallel read-only investigation, delegation linked to your todos, and per-run budgets.
- **🎯 Goals + todos, ✅ verify loop, 🖥️ background processes** — plan tracking (editable from the Overview sidebar), a cheapest-first typecheck→lint→test verify chain with a **hard "green-before-PR" gate**, and dev-server/watcher monitoring.
- **🧠 3-tier memory + 🔎 retrieval** — user / project / session memory, plus explorer/researcher findings offloaded to a searchable session store (`search_memory`) for large codebases.
- **♻️ Resilient runs** — reattach to an in-progress run after navigating away, Stop button, partial-transcript durability, and in-loop context compaction.
- **Docs:** [`docs/DIGBY_CODE.md`](docs/DIGBY_CODE.md) · [`docs/DIGBY_CODE_HARNESS.md`](docs/DIGBY_CODE_HARNESS.md)

### Feedback & Self-Improvement
- **👍/👎 Message Feedback** — Rate any response (thumbs up/down with reasons)
- **💡 Feature Requests & Bug Reports** — Submit via Account → Feedback tab
- **🔁 Feedback → shipped code** — tickets land in a shared triage queue (agents file there too, with dedup + rate caps); the fleet supervisor triages them and Digby Code sessions implement the fixes — 15 PRs merged in a typical week

### Fleet Management (`/crossmodel/management`)
- **🛰️ Fleet dashboard** — live view of every running agent session, schedules, and hooks
- **💬 Fleet Supervisor chat** — every user gets one pinned, full-autonomy supervisor chat that watches all their chats + coding sessions (wildcard event hooks, 2h sweep) — steer it directly from the UI
- **📜 Logs** — live, auto-refreshing run logs across the fleet

### Self-hosting & Digby Edge
- **🏠 Self-host the full stack** — one compose file (`docker-compose.selfhost.yml`) runs everything on your own machine or server: [`docs/SELF_HOST.md`](docs/SELF_HOST.md)
- **🔌 Custom model endpoints** — admins can point the instance at any OpenAI-compatible server (Ollama, vLLM, LM Studio, OpenRouter) from Account → Admin → Model endpoints
- **☁️↔️🖥️ Connected instances** — pair a self-hosted "edge" instance to a cloud Digby over an outbound WSS tunnel (no inbound ports): [`docs/DIGBY_EDGE_TESTING.md`](docs/DIGBY_EDGE_TESTING.md)

### PWA
- **📱 Installable PWA** — Install on iOS/Android/macOS like a native app
- **🔔 Update Notifications** — Users see a toast with what changed on each deploy
- **⚡ Offline Support** — Basic offline page via service worker

---

## 🤖 AI Model Matrix

### Agentic Lineup (2026-09-10)
| Role | Model | Provider |
|------|-------|----------|
| **Orchestrator** (L1 Quick, L2 Ensemble main + synthesis, L3 council lead) | `kimi-k3` | Moonshot AI |
| **Double Checker** (L2 full agentic peer) + L3 council colleague | `deepseek-flash` (DeepSeek V4.1 Flash; legacy `deepseek-v4-pro` aliases forward) | DeepSeek |
| **L3 council colleague** | `glm-5.3` | Z.ai |
| **Decision gate** (seat #19 — the harness's own typed judgments, never a chat answer) | TypeSafe Jev `jev-1.13.0` (built-in chain; DeepSeek logprob readout fallback) | TypeSafe |

_One-shot GPT-5.6 / Grok 4.5 council consultants are retired — the deep-research council is Kimi K3 + DeepSeek V4.1 Flash + GLM-5.3. The Gemini frontier fact-check route was deleted on 2026-09-22 (no frontier provider is called anywhere). The rows above are the UNSET built-in defaults: the production store override (2026-09-22, recorded 2026-09-25) seats glm-5.3 as chat orchestrator / supervisor / coding default with kimi-k3 fallback — Account → Admin → Endpoints → Model roles is the source of truth._

### Digby Code (coding sessions)
| Role | Model |
|------|-------|
| **Default coding model** | `glm-5.3` |
| **Alternatives** | `deepseek-flash`, `kimi-k3` (both vision-capable) — legacy `glm-5.2`/`kimi-k2.6`/`deepseek-v4-pro` picks alias forward |
| **Helper tier** (verifier worker, web/YouTube digests) | `qwen3.6-27b` — the editor runs on the coding model |

### Background & Utility
| Role | Model |
|------|-------|
| **Profile interview / companion voice** | Kimi K3 via Moonshot |
| **Memory consolidation + extraction** | DeepSeek V4.1 Flash `deepseek-flash`, thinking pinned off (utility LLM; Qwen3.6-27B fallback) |

---

## 🏗️ Architecture

### Agentic Query Pipeline

```
User Question (SSE stream)
     │
     ▼
buildChatQueryContext
  ├── User memory (facts, persona, location)
  ├── Conversation history
  ├── Project context (RAG vector search)
  └── Google Workspace data (if connected + relevant)
     │
     ▼
Agentic harness (Kimi K3 orchestrator)
  ├── L1 Quick: direct grounded answer, live web search
  ├── L2 Ensemble: the Double Checker (DeepSeek V4.1 Flash, a full agentic peer) drafts IN PARALLEL, reconciled into the final answer
  └── L3 Deep Research: council lead dispatches autonomous colleagues
        (GLM-5.3, DeepSeek V4.1 Flash) — all streamed live
     │
     ▼
Synthesis — Kimi K3 blends everything into one coherent answer
     │
     ▼
postProcess
  ├── Parse [CANVAS] blocks → save to DB → send canvas SSE events
  ├── Parse [FOLLOWUPS] → extract follow-up question buttons
  ├── Extract [SEND_EMAIL] blocks → render EmailConfirmCard in UI
  ├── Auto-title generation (first message in chat)
  └── Send "complete" SSE event → client displays response
     │
     ▼ (fire-and-forget after SSE ends)
memoryGraphNode (LangGraph)
  ├── Extract memory facts from conversation
  ├── Update user context summary (every 3rd turn)
  └── Update thread state summary (every other turn after turn 3)
```

### Feedback → Shipped Code

```
┌─────────────────────────────────────────────────────────────┐
│  User submits bug / feature request (Account → Feedback),   │
│  or an agent files a ticket via file_feedback               │
│       ↓                                                     │
│  Shared triage queue (user_feature_requests)                │
│  — dedup on repeat sightings, rate caps on agent filings    │
│       ↓                                                     │
│  Fleet supervisor triages → spins up a Digby Code session   │
│       ↓                                                     │
│  Session branches, implements, runs typecheck→lint→test,    │
│  opens a PR → review → merge to main                        │
│       ↓                                                     │
│  GitHub Actions blue-green deploys to production            │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Tech Stack

### Backend
- **Node.js 20** + **Express.js 5** + **TypeScript**
- **@langchain** (core + textsplitters) — RAG chunking/embeddings tooling (query & memory pipelines are plain async state-threading steps — LangGraph removed 2026-07-10)
- **Prisma 7** + **PostgreSQL 16** + **pgvector** (for RAG embeddings)
- **Redis 7** (session, cache, stream token registration)
- **JWT Authentication** (httpOnly cookies, 15min access / 7d refresh rotation)
- **Server-Sent Events** (real-time streaming)
- **Zod** (input validation), **Helmet** (security headers)

### Frontend
- **Next.js 16** (App Router, standalone output, Turbopack)
- **React 19**
- **shadcn/ui** (Radix UI components)
- **Tailwind CSS 4**
- **react-markdown** + **remark-gfm** + **shiki** (syntax highlighting)
- **Service Worker** (PWA, update notifications)
- **TypeScript**

### Infrastructure
- **Docker** + **Docker Compose** (blue-green: `docker-compose.base.yml` + `docker-compose.app.yml`; `docker-compose.prod.yml` is an emergency fallback only)
- **GitHub Actions** (push to main → EC2 deploy, `prisma migrate deploy`)
- **AWS ca-central-1** — two EC2 t3.large (box A `203.0.113.10` stateful, box B `203.0.113.11` stateless) behind ALB `example-alb`
- **AWS RDS Postgres** (ca-central-1) — the app database (pgvector); Redis runs on box A
- **Box C** `example-ca-node` (m7i-flex.2xlarge, 1 TB root) — the coding worker (`CODING_WORKER_CONCURRENCY=32`, compose default 12), deployed by the workflow's extra-hosts step, never in `EC2_HOSTS`. Since the 2026-09-26 deploy speed-ups a wave takes ~18 min of deploy-job time (run 36209251894: 17.7 min; 28 min incl. queue) against the 49–59 min baseline — switches in `docs/REMOTE_OPS.md`
- **nginx** on the boxes terminates TLS for `digby.ai` (direct, no tunnel)

### Self-Improvement
- **Feedback → shipped code** — the `file_feedback` platform tool loop (agents file tickets into `user_feature_requests` with dedup + rate caps; the fleet supervisor triages; Digby Code sessions implement) — see the diagram above. The old external autopilot (Cline/Claude Code on a dev box) was removed 2026-07-20.

---

## 📦 Quick Start

### Prerequisites
- Docker & Docker Compose
- API keys (see Environment Variables below)

### 1. Clone
```bash
git clone https://github.com/example-org/crossmodel.git
cd crossmodel
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your API keys
```

**Required `.env` variables:**
```env
# Database
DATABASE_URL=postgresql://admin:password@postgres:5432/admin_db
REDIS_URL=redis://redis:6379

# Auth
JWT_SECRET=<min 32 chars>
JWT_REFRESH_SECRET=<min 32 chars>

# Frontier models: NONE since 2026-09-22 — no OPENAI / XAI / GOOGLE key is read anywhere
MOONSHOT_API_KEY=sk-...    # Kimi K3 synthesis + orchestration
TYPESAFE_API_KEY=...       # optional (2026-09-24): decision gate seat #19 on TypeSafe Jev; falls back to a DeepSeek logprob readout

# Open source models (all direct provider APIs)
ZAI_API_KEY=...             # GLM-5.3 + glm-5.3-flash vision (api.z.ai international)
DEEPSEEK_API_KEY=...        # DeepSeek V4.1 Flash (deepseek-flash): Double Checker (L2 + L3 council) + utility LLM
DASHSCOPE_API_KEY=...       # RAG embeddings/rerank + utility/helper fallback (intl)

# Web search (optional)
BRIGHTDATA_API_TOKEN=...
MCP_DIGBY_TOKEN=...         # Shared secret for MCP gateway

# Google Workspace (optional)
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_TOKEN_ENCRYPTION_KEY=<32 bytes hex = openssl rand -hex 32>
GOOGLE_MCP_API_KEY=...
```

### 3. Start (self-host stack)
```bash
cp selfhost.env.example .env   # then edit .env — see docs/SELF_HOST.md
docker compose -f docker-compose.selfhost.yml up -d --build
```
Schema migrations run automatically via the one-shot `migrate` service. Full
guide (LAN access, TLS, integrations, backups, auto-updates):
[`docs/SELF_HOST.md`](docs/SELF_HOST.md). (`docker-compose.prod.yml` still
exists but is an emergency fallback only.)

### 4. Access
| Service | URL |
|---------|-----|
| App (Caddy entrypoint) | http://localhost:8080 |
| Backend API (debug) | http://localhost:4000/api |
| DB Admin (Adminer, `--profile tools`) | http://localhost:9521 |

---

## 🎮 How to Use

1. **Open** Digby AI at `/crossmodel`
2. **Complete the profile interview** — Digby learns who you are and adapts its voice
3. **Depth is automatic** — Digby picks the shape per message (✨ fast answer, cross-checked, or research council); tap **Dig deeper** under an answer to go further
4. **Toggle Web Search** 🌐 for real-time internet access
5. **Ask anything** — see three models respond in parallel, then see the synthesis
6. **Click** "How each AI answered" to see individual model responses
7. **Use Canvas** — AI creates rich documents in a side panel (like Claude artifacts)
8. **Upload files** — images, PDFs, Word docs (drag-and-drop or paperclip icon)
9. **Connect Google** — Account → Integrations → "Connect Google" for Gmail/Calendar/Drive
10. **Submit feedback** — Account → Feedback to report bugs or request features (triaged by the fleet supervisor via the `file_feedback` loop)

---

## 🔌 API Reference

### CrossModel Streaming

```
GET /api/crossmodel/stream?message=Hello&mode=fast&webSearch=true
```

Or for large messages (> 1.5KB):
```
POST /api/crossmodel/stream/register   → { streamToken }
GET  /api/crossmodel/stream?streamToken=xxx
```

| Param | Type | Values | Description |
|-------|------|--------|-------------|
| `message` | string | any | The user's question |
| `mode` | string | `auto` \| `single_thinking` \| `thinking` \| `deep_research` \| `deep_research_all` | Patience level (legacy `fast`/`single` → `single_thinking`; `deep_research_all` aliases to `deep_research`) |
| `webSearch` | boolean | `true` \| `false` | Enable web search |
| `chatId` | string | UUID | Continue existing chat |
| `uploadId` | string[] | UUID(s) | Attached file IDs |
| `streamToken` | string | UUID | Pre-registered token for large messages |

### SSE Event Types

```javascript
// Progress (while models are running)
{ type: "progress", data: { message: "Querying models...", stage: "models" } }

// Model responses (real-time as each completes)
{ type: "model-response", data: { model, response, time, modelUsed, webSearchUsed, error? } }

// Synthesis chunks (streaming Kimi output)
{ type: "chunk", data: { content: "..." } }

// Canvas creation
{ type: "canvas", data: { id, title, type, content } }

// Final complete event
{ type: "complete", data: {
    summary,            // clean synthesis (canvas/followup tags stripped)
    rawSummary,         // full synthesis with all tags
    models: {...},      // per-model responses + timing
    synthesisTime,
    followUps: string[], // suggested follow-up questions
    canvasCount: number,
    sources: null | [{documentId, content, relevanceScore}],
    autoTitle: string | null,
    sessionId: string | null  // anonymous users only
} }

// Error
{ type: "error", data: { message: "..." } }
```

### Key Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/api/crossmodel/stream` | Optional | SSE stream query |
| `POST` | `/api/crossmodel/stream/register` | Optional | Pre-register large message |
| `POST` | `/api/crossmodel/chats` | Required | Create chat |
| `GET` | `/api/crossmodel/chats` | Required | List chats |
| `PUT` | `/api/crossmodel/preferences` | Required | Set model set (frontier/open_source) |
| `GET` | `/api/crossmodel/memory` | Required | Get memory facts |
| `PUT` | `/api/crossmodel/memory` | Required | Update a memory fact |
| `POST` | `/api/crossmodel/transcribe` | Required | Audio transcription (self-hosted STT first, Whisper-1 fallback) |
| `POST` | `/api/crossmodel/tts` | Required | Text-to-speech (Nova) |
| `POST` | `/api/crossmodel/upload` | Required | Upload file (base64 JSON) |
| `POST` | `/api/crossmodel/feedback` | Optional | Submit thumbs up/down |
| `POST` | `/api/crossmodel/feature-request` | Required | Submit bug report or feature request |
| `GET` | `/api/crossmodel/feature-requests` | Required | Get user's own submissions |
| `GET` | `/api/crossmodel/admin/feature-requests` | Admin | All submissions across all users |
| `PATCH` | `/api/crossmodel/admin/feature-requests/:id` | Admin | Update status + adminNote |
| `GET` | `/api/crossmodel/google/start` | Required | Start Google OAuth flow |
| `GET` | `/api/crossmodel/google/accounts` | Required | List connected Google accounts |

---

## 📁 Project Structure

```
crossmodel/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma              # All models (User, CrossModelChat, UserMemory,
│   │   │                              #   Canvas, Project, UserFeatureRequest, etc.)
│   │   └── migrations/                # All DB migrations
│   └── src/
│       ├── modules/
│       │   └── crossmodel/
│       │       ├── crossmodel.controller.ts    # HTTP handlers, SSE streaming
│       │       ├── crossmodel.service.ts       # Chat CRUD
│       │       ├── crossmodel.routes.ts        # Route definitions
│       │       ├── context.service.ts          # Message persistence, memory loading
│       │       ├── mcp-search.ts              # BrightData MCP client (circuit breaker)
│       │       ├── integrations/
│       │       │   ├── anthropic.integration.ts # Claude Sonnet/Opus 4 (fallback, not wired into pipeline)
│       │       │   ├── glm.integration.ts       # GLM-5.3 (open source)
│       │       │   ├── deepseek.integration.ts  # DeepSeek V4.1 Flash (deepseek-flash) — legacy query/synthesis paths
│       │       │   ├── qwen-kid.integration.ts  # Digby Kids (Qwen 3.6 Flash, child-safe chat)
│       │       │   └── moonshot.integration.ts  # Kimi K3 synthesis + companion voice
│       │       ├── langgraph/
│       │       │   ├── memory.graph.ts          # Memory pipelines (plain async steps; LangGraph removed 2026-07-10)
│       │       │   ├── pipeline-utils.ts        # Shared follow-up/canvas parsing
│       │       │   └── integration-status-cache.ts
│       │       └── google/                     # Google Workspace integration
│       │           ├── google-oauth.controller.ts
│       │           ├── google-mcp.ts           # Gmail, Calendar, Drive fetchers
│       │           ├── intent-detector.ts      # Regex-based intent detection
│       │           └── token-manager.ts        # AES-256-GCM token storage
│       └── config/
│           ├── env.ts                          # Zod env validation
│           ├── database.ts                     # Prisma client
│           ├── redis.ts                        # Redis connection
│           └── langgraph-checkpointer.ts       # PostgresStore (mutex-protected)
│
├── frontend/
│   ├── app/
│   │   └── crossmodel/
│   │       ├── page.tsx               # Main chat UI (SSE, canvas, email card, etc.)
│   │       ├── account/               # Account tabs (Profile, Memory, Integrations, Feedback)
│   │       └── projects/              # Project management pages
│   └── public/
│       ├── sw.js                      # Service worker (PWA, update notifications)
│       └── manifest.json              # PWA manifest
│
├── google-mcp/                        # Google Workspace MCP server (Docker container)
│   └── src/
│       ├── server.ts                  # MCP tool handler
│       └── tools/                     # Gmail, Calendar, Drive, Sheets, Docs tools
│
├── scripts/                           # Ops scripts (ec2-ops/, backup/, deploy helpers)
│
├── memory-bank/                       # Project memory (session documentation)
├── docker-compose.selfhost.yml        # Self-host full-stack compose (see docs/SELF_HOST.md)
├── docker-compose.prod.yml            # Emergency-fallback production compose
└── README.md
```

---

## 🔧 Configuration Details

### Port Mapping (Production — blue-green architecture)

| Container | Internal | External |
|-----------|----------|---------|
| frontend (blue) | 3000 | **8248** |
| frontend (green) | 3000 | **8249** |
| backend (blue) | 4000 | **4001** |
| backend (green) | 4000 | **4002** |
| PostgreSQL | 5432 | **9384** |
| Redis | 6379 | **7856** |
| Adminer | 8080 | **9521** |
| MCP Gateway | 8000 | **8200** |
| Google MCP | 3001 | **8201** |

### Deployment
```bash
# Deploy to production (triggers GitHub Actions):
git push origin main

# Check deployment status:
gh run list --limit 5

# SSH to production:
ssh -i /home/paul/.ssh/crossmodel-prod.pem ubuntu@203.0.113.10

# View production logs (active color — check /opt/crossmodel/.active-color):
ssh -i /home/paul/.ssh/crossmodel-prod.pem ubuntu@203.0.113.10 \
  "docker logs admin-backend-green --tail=50"

# Blue-green deploy (zero downtime):
ssh -i /home/paul/.ssh/crossmodel-prod.pem ubuntu@203.0.113.10 \
  "sudo bash /opt/crossmodel/deploy-blue-green.sh"

# Instant rollback:
ssh -i /home/paul/.ssh/crossmodel-prod.pem ubuntu@203.0.113.10 \
  "sudo bash /opt/crossmodel/rollback.sh"

# Manual health check:
curl -s https://digby.ai/api/health
```

### Service Worker (PWA)
Every deploy must increment `CACHE_NAME` in `frontend/public/sw.js`:
```javascript
const CACHE_NAME = 'digby-v391';  // increment on every deploy
const VERSION_MESSAGE = '✨ What changed · Tap to reload!';
```

---

## 🔐 Security

- JWT access tokens (15min) + refresh tokens (7d, httpOnly cookie, rotation on use)
- API keys stored as GitHub Secrets, never in code
- Input validation via Zod schemas on all endpoints
- SQL injection prevention (Prisma ORM)
- `helmet` security headers
- Rate limiting on stream endpoint (25 queries/10min per user/IP)
- Stream token ownership check (prevents cross-user token theft)
- O(1) per-identity rate limit counters (no O(n) cache scans)
- Google OAuth tokens encrypted at rest (AES-256-GCM)
- TLS terminated by nginx behind the AWS ALB (instance ports closed except via the load balancer + SSH)
- MCP gateway requires `MCP_DIGBY_TOKEN` secret

---

## 🧪 Testing

### Backend E2E test
```bash
# Health + auth + stream test (requires containers running):
cd backend && CROSSMODEL_API_URL=http://localhost:4000/api npx tsx scripts/e2e-test.ts
```

### Manual curl tests
```bash
# Anonymous stream (no auth)
curl -N "http://localhost:4000/api/crossmodel/stream?message=Hello&mode=fast&webSearch=false"

# With authentication (get token first)
TOKEN=$(curl -s -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}' | jq -r '.data.accessToken')

curl -N -H "Authorization: Bearer $TOKEN" \
  "http://localhost:4000/api/crossmodel/stream?message=What+is+AI&mode=fast"
```

---

## 🐛 Troubleshooting

### Backend won't start
- Check active color: `cat /opt/crossmodel/.active-color`
- Check container logs: `docker logs admin-backend-green --tail=50` (replace green with blue if active)
- Verify all required env vars are set in `.env`
- Run `sudo docker compose -f docker-compose.prod.yml restart admin-backend-green`

### Synthesis returns very short responses
- The 200-char safe-streaming buffer and MIN_SYNTHESIS_LENGTH guard should prevent this
- Check logs for `synthesizeNode: suspiciously short synthesis`

### Canvas edits return 404 after AI creates them
- Backend now saves canvases to DB first before emitting canvas SSE events (fixed Session 69)
- If still occurring: check `parseCanvasTags` in `langgraph/pipeline-utils.ts`

### Google OAuth fails
- Verify `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` in `.env`
- Verify redirect URI registered in Google Cloud Console: `https://digby.ai/api/crossmodel/google/callback`
- Check `google-mcp-prod` container is running: `docker ps | grep google-mcp`

### MCP web search failing
- Circuit breaker may be open (after 3 failures, 5-min cooldown)
- Check logs for `BrightData MCP circuit OPEN`
- Breaker auto-resets after 5 minutes

---

## 📄 License

Digby is **dual-licensed**:

- **AGPL-3.0-or-later** (the default) — the full text is in [LICENSE](LICENSE).
- **A commercial licence** for organisations that need to embed Digby in a
  closed-source product, host a modified version without publishing their
  changes, or obtain warranty/indemnity/support — see
  [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).

Self-hosting Digby for yourself or your own organisation normally requires
nothing beyond keeping the copyright notices intact. The AGPL's §13 network
obligation attaches to **modifications you distribute or operate for others**.

> **Earlier releases.** Commits published before 2026-11-06 carried an MIT
> `LICENSE` file. Changing the licence now cannot, and does not, revoke rights
> already granted for those earlier commits — anyone who obtained the code under
> MIT may continue to use *that* code under MIT. The AGPL applies to the tree
> from this release forward.

---

## 🙏 Acknowledgments

- **Moonshot AI** — Kimi K3 synthesis + orchestration
- **Z.ai** — GLM-5.3
- **DeepSeek** — DeepSeek V4.1 Flash (`deepseek-flash`)
- **Moonshot** — Kimi K3
- **Alibaba DashScope** — Qwen (embeddings, rerank, helper, kids, speech)
- **BrightData** — Web search MCP
- **shadcn/ui** — Beautiful React components

---

**Built with ❤️ by Digby AI — Ask once. Get the best of every AI.**
