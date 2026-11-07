# Digby AI

> Ask once. Get the best of every AI.

**Digby AI** is an agentic chat platform where **every model is an admin-assignable seat** — no model is hard-wired. It answers directly for quick lookups, cross-checks itself with an independent second model for harder questions, and convenes a multi-model research council for deep research, blending everything into one synthesized answer and streaming it in real time. It learns who you are, remembers context across sessions, and turns the bugs and feature requests you submit into shipped code.

> **Model-agnostic by design.** Out of the box the lead seat ships on Kimi K3, the Double Checker on DeepSeek V4.1 Flash and the third council seat on GLM-5.3 — but those are **defaults on editable seats**, not dependencies. Every model call in the product is a seat an administrator can repoint (Account → Admin → Endpoints → Model roles), to another built-in model or to **any OpenAI-compatible server** you run yourself (Ollama, vLLM, LM Studio, an OpenRouter or LiteLLM proxy). A single-endpoint instance is a supported configuration: the Double Checker then resolves to the lead's own model and the independent check is honestly reported as skipped rather than faked. No frontier-provider key is read anywhere.

Live at: **[digby.ai](https://digby.ai)**

![Digby AI](https://img.shields.io/badge/AI-Multi--Model-7C3AED?style=for-the-badge)
![License](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue?style=for-the-badge)
![Stack](https://img.shields.io/badge/Stack-Next.js_16_+_Express-000?style=for-the-badge)
![Self-host](https://img.shields.io/badge/Self--host-Docker_Compose-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![CI](https://github.com/canada-quant/digby/actions/workflows/ci.yml/badge.svg)

---

## ✨ Features

### Core Chat
- **🧠 Auto / Quick / Ensemble / Deep Research** — Digby picks the shape per message: one fast agent answer, an independently cross-checked answer, or a full multi-model research council — with **Dig deeper** under answers to take them further
- **🔀 Smart Synthesis** — the lead seat (Digby) blends everything into one coherent answer
- **📡 Real-Time Streaming** — SSE streams each step as it happens
- **🌐 Web Search** — Live internet access via BrightData MCP
- **⏹️ Stop Button** — Cancel any in-progress response
- **📊 Model Transparency** — the "How Digby answered" disclosure under each answer shows timing, whether web search ran and which sources were used; administrators additionally see the per-model breakdown
- **🛠️ Digby Operates Digby** — 17 account tools let Digby set things up for you from inside the chat (memory, schedules, project knowledge bases, canvases, share links, Telegram notifications, per-chat instructions) — and it proactively offers the next step ("would you like me to…")
- **🎨 Rich Markdown** — Tables, code blocks, syntax highlighting, headings

### The Lineup (defaults, 2026-11-06)
- **The lead seat (`chat_orchestrator`, persona "Digby") orchestrates every depth** — it runs the tools, talks to you, writes the final answer, and reconciles what the checkers found. Out of the box it ships on **Kimi K3**; the production instance seats it on `glm-5.3` with a `kimi-k3` fallback. **Either way it is one editable seat, not a dependency** — point it at any built-in or any OpenAI-compatible endpoint and the whole pipeline follows.
- **DeepSeek V4.1 Flash** (`deepseek-flash`, reasoning max, 1M context, native vision) — the **Double Checker** (a full agentic peer with its own tool loop) for a verified answer, and a council colleague for deep research (the vendor retired V4 Pro / V4 Flash on 2026-09-10; both legacy ids alias forward)
- **GLM-5.3** (reasoning max) — the third council seat and the default coding model
- **No frontier models** (since 2026-09-22) — every model call is an admin-editable seat on the open-model providers (Moonshot, DeepSeek, Z.AI, DashScope) **or your own endpoint**; a seat you cannot serve falls back along its declared chain rather than failing the turn
- **23 seats, one registry** — lead, Quick lane, both supervisors, both checkers, coding/worker roles, utility, embeddings, reranker, ASR/TTS, image reader, PDF OCR, browser agent, computer-use vision, kids, decision gate, image generation. Nothing in the product calls a model outside a seat.

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
- **Docs:** [`docs/DIGBY_CODE.md`](docs/DIGBY_CODE.md)

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

### One super-agent, many lanes
- **🧭 The agent can spawn agents** — a chat can start a full coding session (`start_coding_session`) as a **child with its own git worktree and container**; children run in parallel on the worker fleet, report back by waking the parent, and a project supervisor fans work out across its project. Deep, independent work therefore lands as a lane, not as a longer chat.
- **🛰️ Fleet + supervisors on two tiers** — a **Fleet Supervisor** watches every chat and session you own (wildcard event hooks + a periodic sweep) and a **Project Supervisor** does the same inside one project; both are steerable chats you talk to directly, and both triage tickets, steer lanes and report upward.
- **❓ Async Q&A — the run asks, you answer when you can** — a run that needs a decision raises an inline card (`ask_user`), or flags a decision into a persistent **Management → Inbox** "Needs owner" list that never expires and posts the answer back into the chat that asked. Agents also message each other directly (`send_chat_message`), so a parent can steer a child mid-run without you relaying anything.
- **🧮 Decision-model routing** — the harness's own small judgments (route this send, park this wake, is this claim evidenced, which lane owns this goal…) are **typed decisions**, not prose: every registered purpose is asked of a calibrated **decision seat** (TypeSafe Jev by default, any decision model you register), each with a readiness bar before it may act and a fail-open to the deterministic rule it replaces. Live state: `get_decision_gate_status`.
- **🔁 Self-improving by design** — the fleet that fixes Digby *is* Digby: tickets from the feedback loop are triaged by the supervisors and implemented by coding lanes, verified by the same typecheck→lint→test chain, and merged through the same gates.

---

## 📦 Editions — Self-Hosted, Cloud, Enterprise

One codebase, three ways to run it. The distinction is who operates it, not what the features are.

| | **Self-Hosted** | **Cloud** | **Enterprise** |
|---|---|---|---|
| **Who runs it** | You — your machine or server | Us ([digby.ai](https://digby.ai)) | You, under the commercial licence |
| **Install** | `docker compose -f docker-compose.selfhost.yml up -d --build`, or `scripts/selfhost/install.sh` pulling published images (no clone needed) | — | Delivered with the commercial licence |
| **Your data** | Your own Postgres + Redis in your own compose stack; nothing reaches digby.ai unless you pair it | Managed AWS (ca-central-1) | Your infrastructure |
| **Models** | Your provider keys, or your own OpenAI-compatible endpoint — at least one is required | Managed seats | Managed seats, or point them at your own endpoints |
| **Ads & product telemetry** | **No first-party ads or analytics in the build.** The self-host images ship with no ad or tracking tags: no Google Ads/GA4 tag, no Meta pixel, no Meta Conversions API, and no `ads.txt` (pinned by a build-posture test). Nothing is sent anywhere except to the model providers you configure | Runs Digby's own measurement on digby.ai | **Off by default**, same posture as Self-Hosted |
| **Autonomy boundary** | `DIGBY_INSTANCE=selfhost`: the self-improvement loop resolves its repo/DB/deploy targets from *your* env and hard-fails with an `ISOLATION BOUNDARY` error rather than reaching for production Digby's repo — point it at your fork to let it improve itself | Production instance | Your targets |
| **Cloud link** | An Edge instance can pair **to** a cloud Digby over an outbound WSS tunnel (no inbound ports) | Accepts paired Edge instances | Same, on your terms |
| **Licence** | AGPL-3.0-or-later | AGPL-3.0-or-later | Commercial — see [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) |

**Enterprise tier.** The commercial licence is for organisations that need to embed Digby in a closed-source product, host a modified version without publishing changes, or obtain warranty/indemnity/support. The enterprise edition adds the controls large deployments ask for that are deliberately **not** in this repository — single sign-on (SAML/OIDC), SCIM provisioning, RBAC beyond the per-project `viewer`/`editor`/`admin` roles, and compliance audit-log export. **This repository is a complete, self-hostable product**; nothing in the table above is a crippled demo of the other editions.

---

## 🤖 AI Model Matrix

### Agentic Lineup (built-in defaults, 2026-11-06)
| Role | Model | Provider |
|------|-------|----------|
| **Orchestrator / lead** (the chat seat at every depth: answers, synthesizes, reconciles the checkers) | `kimi-k3` (built-in default; prod store seats `glm-5.3` with a `kimi-k3` fallback) | Moonshot AI / Z.ai |
| **Quick answers** (the Auto Quick lane — lookups and live facts, thinking off) | follows the Helper seat until assigned | — |
| **Double Checker** (the independent second model: the parallel verified answer, and a deep-research council colleague) | `deepseek-flash` (DeepSeek V4.1 Flash; legacy `deepseek-v4-pro` aliases forward) | DeepSeek |
| **Triple Checker** (the third deep-research council seat) | `glm-5.3` | Z.ai |
| **Decision gate** (the harness's own typed judgments — never a chat answer) | TypeSafe Jev `jev-1.13.0` (built-in chain; DeepSeek logprob readout fallback) | TypeSafe |

_Every row is a **default on an editable seat**, never a hard dependency — Account → Admin → Endpoints → Model roles is the source of truth, and any seat can be repointed at any OpenAI-compatible endpoint. One-shot GPT-5.6 / Grok 4.5 council consultants are retired and the Gemini frontier fact-check route was deleted on 2026-09-22, so no frontier provider is called anywhere. The deep-research council is the lead + the Double Checker + the Triple Checker; on a single-model instance the check that cannot disagree is skipped and reported honestly rather than faked._

### Digby Code (coding sessions)
| Role | Model |
|------|-------|
| **Default coding model** | `glm-5.3` |
| **Alternatives** | `deepseek-flash`, `kimi-k3` (both vision-capable) — legacy `glm-5.2`/`kimi-k2.6`/`deepseek-v4-pro` picks alias forward |
| **Helper tier** (verifier worker, web/YouTube digests) | `qwen3.6-27b` — the editor runs on the coding model |

### Background & Utility
| Role | Model |
|------|-------|
| **Profile interview / companion voice** | the lead seat's model (built-in default: Kimi K3 via Moonshot) |
| **Memory consolidation + extraction** | DeepSeek V4.1 Flash `deepseek-flash`, thinking pinned off (utility LLM; Qwen3.6-27B fallback) |

_All three tables describe **built-in defaults**; every row is an editable seat (Account → Admin → Endpoints → Model roles) and can be repointed at a built-in model or any OpenAI-compatible endpoint._

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
Compute policy (per human send — answers the depth question from the send's own signals)
  ├── Quick: the lead answers directly, grounded, live web search, thinking off
  ├── Ensemble: the lead answers FIRST and streams; the Double Checker (a different
  │     seat, full agentic peer, own web search) works the same question IN PARALLEL
  │     behind it and its verdict is the Checked / Updated pill — the answer never waits
  └── Deep Research: the lead dispatches council colleagues (Double + Triple Checker)
        as autonomous researchers — all streamed live
     │  Dig deeper under any answer buys the next unspent rung (verify → research)
     ▼
Synthesis — the lead seat blends everything into one coherent answer
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
│  GitHub Actions build/test CI gates the merge                │
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
- **Docker** + **Docker Compose** — `docker-compose.selfhost.yml` is the complete self-host stack; `docker-compose.selfhost.published.yml` is the same stack pulling published images (no source clone)
- **GitHub Actions** — build/test CI, image publishing and an anonymous install-smoke run; all of it build/test/publish only, with no production credentials
- **PostgreSQL 16** (+ pgvector) and **Redis 7** run as containers in the same compose stack
- **Caddy** terminates TLS and fronts the frontend + backend on a single port (`8080` by default)

### Self-Improvement
- **Feedback → shipped code** — the `file_feedback` platform tool loop (agents file tickets into `user_feature_requests` with dedup + rate caps; a supervisor triages; Digby Code sessions implement) — see the diagram above.

---

## 📦 Quick Start

Two ways to run Digby. The **published images** path needs no source clone and
no build; the **from-source** path builds the stack locally.

### A. Install from published images (no clone)

```bash
curl -fsSLO https://raw.githubusercontent.com/canada-quant/digby/main/scripts/selfhost/install.sh
sh install.sh
```

`install.sh` writes the compose file and a `.env` seeded from
[`selfhost.env.example`](selfhost.env.example), then pulls and starts the stack
on **http://localhost:8080**. It never overwrites an existing `.env`, and it
never writes a secret for you. Pin a release with
`DIGBY_IMAGE_TAG=<version> sh install.sh`.

### B. Build from source

Prerequisites: Docker with the Compose v2 plugin.

```bash
git clone https://github.com/canada-quant/digby.git
cd digby

cp selfhost.env.example .env    # then edit — see the variables below
docker compose -f docker-compose.selfhost.yml up -d --build
```

Schema migrations run automatically via the one-shot `migrate` service.

### Environment

At minimum you need the two JWT secrets (generate your own — `openssl rand -hex 32`)
and **one** model API key. Every model call is an admin-editable seat, so no
particular provider is required; the built-in defaults use Moonshot (lead),
DeepSeek (checker) and Z.AI (council/coding).

```env
# Database + cache (compose service names by default)
DATABASE_URL=postgresql://admin:password@postgres:5432/admin_db
REDIS_URL=redis://redis:6379

# Auth — generate your own, never reuse an example
JWT_SECRET=<openssl rand -hex 32>
JWT_REFRESH_SECRET=<openssl rand -hex 32>

# One model provider is enough to start (seats are editable in Account → Admin)
MOONSHOT_API_KEY=...        # Kimi K3 — built-in default for the lead seat
DEEPSEEK_API_KEY=...        # DeepSeek V4.1 Flash — Double Checker + utility
ZAI_API_KEY=...             # GLM-5.3 — council seat + default coding model
DASHSCOPE_API_KEY=...       # embeddings / rerank / STT

# Optional
BRIGHTDATA_API_TOKEN=...    # web search
MCP_DIGBY_TOKEN=...         # shared secret for the MCP gateway
GOOGLE_OAUTH_CLIENT_ID=...  # Google Workspace integration
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_TOKEN_ENCRYPTION_KEY=<openssl rand -hex 32>
```

The full operator guide — LAN access, TLS, integrations, backups, auto-update,
branding, and every switch — is [`docs/SELF_HOST.md`](docs/SELF_HOST.md).

### Access
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
5. **Ask anything** — the answer streams immediately; the independent check lands behind it as the **Checked ✓ / Updated** pill, and deep research dispatches the council
6. **Open** "How Digby answered" under a response for its timing, web-search use and sources (administrators also see the per-model breakdown)
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

// Synthesis chunks (streaming lead-model output)
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
digby/
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
│       │       │   └── moonshot.integration.ts  # Moonshot provider client (hosts the lead seat; Kimi K3 is the fallback default)
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
├── scripts/                           # Deploy + self-host + CI scripts (see docs/SELF_HOST.md)
│
├── docker-compose.selfhost.yml        # Self-host full-stack compose (see docs/SELF_HOST.md)
├── docker-compose.selfhost.published.yml  # Same stack, published images (no clone)
└── README.md
```

---

## 🔧 Configuration Details

### Port Mapping (self-host stack)

| Container | Internal | External |
|-----------|----------|---------|
| Caddy (public entrypoint) | 8080 | **`${SELFHOST_PORT:-8080}`** on `${SELFHOST_BIND_ADDR:-0.0.0.0}` |
| backend | 4000 | **4000** (127.0.0.1 only) |
| relay | 4100 | **4100** (127.0.0.1 only) |
| PostgreSQL | 5432 | internal only |
| Redis | 6379 | internal only |
| Adminer (`--profile tools`) | 8080 | **9521** (127.0.0.1 only) |
| MCP gateway / connectors (`--profile mcp`) | 8000 | **8200**–**8207** (127.0.0.1 only) |

### Deployment

The self-host stack deploys with compose:

```bash
# Build locally and start (from-source path)
docker compose -f docker-compose.selfhost.yml up -d --build

# Or pull published images (no clone)
docker compose -f docker-compose.selfhost.published.yml pull
docker compose -f docker-compose.selfhost.published.yml up -d

# Health
curl -s http://localhost:8080/api/health
```

Schema migrations run automatically through the one-shot `migrate` service
before the backend starts. Updates are `pull` + `up -d`, not `git pull`; the
published-image path is documented in
[`docs/SELF_HOST.md`](docs/SELF_HOST.md#install-from-published-images-no-source-clone).
`deploy/selfhost/` carries the optional Caddy + auto-update systemd units.

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
- TLS terminated by Caddy in the compose stack (no ports need to be exposed beyond it)
- MCP gateway requires `MCP_DIGBY_TOKEN` secret (auth-proxy fails closed: a
  missing key is rejected, not treated as "no auth")
- The one keyless MCP service — `digby-mcp`, which re-exports the platform API
  via per-user token pass-through — binds to `127.0.0.1:8206` only, never all
  interfaces; `backend/scripts/mcp-surface.test.ts` fails if a public listener
  is ever added without a shared-key gate, and
  `scripts/mcp/probe-public-mcp-surface.sh` verifies the deployed host denies
  anonymous callers

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
- Verify all required env vars are set in `.env` (the two JWT secrets and at least one model key)
- Check container logs: `docker compose -f docker-compose.selfhost.yml logs backend --tail=50`
- Check the one-shot migration ran: `docker compose -f docker-compose.selfhost.yml logs migrate --tail=50`
- Restart a single service: `docker compose -f docker-compose.selfhost.yml restart backend`
- Published-image path: `docker compose -f docker-compose.selfhost.published.yml logs backend --tail=50`

### Synthesis returns very short responses
- The 200-char safe-streaming buffer and MIN_SYNTHESIS_LENGTH guard should prevent this
- Check logs for `synthesizeNode: suspiciously short synthesis`

### Canvas edits return 404 after AI creates them
- Backend now saves canvases to DB first before emitting canvas SSE events (fixed Session 69)
- If still occurring: check `parseCanvasTags` in `langgraph/pipeline-utils.ts`

### Google OAuth fails
- Verify `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_TOKEN_ENCRYPTION_KEY` in `.env`
- Verify the redirect URI registered in Google Cloud Console matches your instance's public URL: `<SELFHOST_PUBLIC_URL>/api/crossmodel/google/callback`
- Check the `google-mcp` container is running: `docker ps | grep google-mcp`

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

- **Moonshot AI** — Kimi K3 (built-in default for the lead seat)
- **Z.ai** — GLM-5.3
- **DeepSeek** — DeepSeek V4.1 Flash (`deepseek-flash`)
- **Alibaba DashScope** — Qwen (embeddings, rerank, helper, kids, speech)
- **BrightData** — Web search MCP
- **shadcn/ui** — Beautiful React components

---

**Built with ❤️ by Digby AI — Ask once. Get the best of every AI.**
