<h1 align="center">Digby</h1>

<p align="center"><strong>Ask once. Get the best of every AI.</strong><br/>
A self-hostable, model-agnostic agentic AI workspace.</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/badge/license-AGPL--3.0-blue.svg"></a>
  <img alt="Docker" src="https://img.shields.io/badge/self--host-Docker%20Compose-2496ED.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-Express%20%2B%20Next.js-3178C6.svg">
</p>

---

## What is Digby?

Digby is a complete, self-hostable AI application — not a library and not a thin
chat wrapper. It gives one person or a whole organisation a private AI workspace
with the pieces you normally have to assemble yourself:

- **Multi-model orchestration.** Ask a question once and Digby answers with a
  lead model, can cross-check itself with an independent second model, and can
  convene a council of models for deep research — then synthesises one answer.
- **Long-running coding sessions.** An agent that reads your repository, edits
  files, runs commands, verifies its own work and reports back — with a plan,
  per-step checkpoints and an audit trail you can inspect.
- **Memory that persists.** Digby remembers you and your projects across
  conversations, with a searchable memory you can inspect.
- **MCP integrations.** Connect Google, GitHub, X, Slack, Asana, Discord,
  Telegram, Plaid, Xero, Gmail and more through the Model Context Protocol.
- **Scheduling and autonomy.** Recurring tasks, reminders and event hooks that
  wake Digby on their own.
- **Bring your own models.** Any OpenAI-compatible endpoint, or first-class
  DeepSeek, Moonshot/Kimi and Z.AI seats. No frontier key is required.

Everything runs on your hardware, against your database, with your keys. Digby
does not call home unless you configure it to.

## Quick start

**Requirements:** Docker with Compose v2, ~8 GB RAM (4 GB floor without the STT
service), and at least one model provider API key.

```bash
git clone https://github.com/canada-quant/digby.git
cd digby

cp selfhost.env.example .env
# Edit .env and set, at minimum:
#   JWT_SECRET            → openssl rand -hex 32
#   JWT_REFRESH_SECRET    → openssl rand -hex 32
#   one model provider key (e.g. DEEPSEEK_API_KEY)
#   SELFHOST_ADMIN_EMAIL  → the account that becomes ADMIN

docker compose -f docker-compose.selfhost.yml up -d --build
```

Open **http://localhost:8080** and register. Database migrations run
automatically on every `up` via a one-shot `migrate` service; the backend and
worker wait for it.

Then open **Account → Admin → Setup** — a live checklist of everything this
instance can and cannot do, naming the exact environment variables still
missing. That page is the shortest path from "it booted" to "it does everything".

→ **Full guide: [`docs/SELF_HOST.md`](./docs/SELF_HOST.md)** — LAN access, TLS
with your own domain, OAuth callbacks, MCP profiles, voice/STT, hosted browser,
backups and upgrades.

## Architecture at a glance

```
                    ┌──────────┐
   browser ────────▶│  caddy   │ :8080  single entrypoint
                    └────┬─────┘
                 /api/*  │  everything else
              ┌──────────┴─────────┐
              ▼                    ▼
        ┌──────────┐        ┌──────────┐
        │ backend  │        │ frontend │   Next.js UI
        │ Express  │        └──────────┘
        └────┬─────┘
             │            ┌──────────┐
             ├───────────▶│  worker  │  coding-session runner
             │            └──────────┘
             ▼
      ┌────────────┐   ┌────────┐   ┌──────┐
      │  postgres  │   │ redis  │   │ stt  │
      │ (pgvector) │   │        │   │      │
      └────────────┘   └────────┘   └──────┘
```

| Service | Purpose |
|---|---|
| **caddy** | Single entrypoint — `/api/*` to backend, everything else to frontend |
| **frontend** | Next.js web UI |
| **backend** | Express API, chat agent, orchestration, memory |
| **worker** | Claims and runs coding sessions from Postgres |
| **relay** | Holds paired edge-device tunnels and proxies admin/SSE traffic |
| **postgres** | Application database (pgvector for embeddings) |
| **redis** | Cross-process state, rate limits, run mirrors |
| **stt** | Speech-to-text for voice notes and media transcription |

Optional profiles: `--profile mcp` (integration servers), `--profile tools`
(Adminer), `--profile browser` (hosted browser for unattended browsing).

## Repository layout

| Path | What lives there |
|---|---|
| `backend/` | Express API, agent runtime, coding sessions, memory, Prisma schema |
| `frontend/` | Next.js application |
| `packages/` | Shared TypeScript packages |
| `docker-compose.selfhost.yml` | The self-host stack |
| `selfhost.env.example` | Every environment variable, documented |
| `deploy/selfhost/` | Caddyfile and systemd units for self-hosting |
| `docker/` | Development image |
| `digby-mcp/`, `github-mcp/`, `slack-mcp/`, `google-mcp/`, `asana-mcp/`, `discord-mcp/`, `x-mcp/`, `mcp-gateway/` | MCP integration servers |
| `imessage-agent/`, `browser-service/` | Device bridge and hosted browser |
| `docs/` | Self-host guide, API reference, architecture notes |
| `.github/workflows/ci.yml` | Test gate (backend + frontend + typecheck) |

## Development

```bash
# Backend
cd backend
npm ci
npx prisma generate
npm run dev              # tsx watch src/server.ts
npm test                 # jest
npx tsc --noEmit         # typecheck

# Frontend
cd frontend
npm ci
npm run dev              # next dev
npm test                 # vitest
npm run lint             # eslint
```

## Documentation

- [`docs/SELF_HOST.md`](./docs/SELF_HOST.md) — self-hosting, TLS, OAuth, backups
- [`docs/DIGBY_PLATFORM_API.md`](./docs/DIGBY_PLATFORM_API.md) — platform API
- [`docs/api-reference.md`](./docs/api-reference.md) — HTTP API reference
- [`docs/DIGBY_MCP.md`](./docs/DIGBY_MCP.md) — MCP integration servers
- [`docs/DIGBY_CODE.md`](./docs/DIGBY_CODE.md) — the coding agent
- [`docs/DIGBY_EDGE_TESTING.md`](./docs/DIGBY_EDGE_TESTING.md) — edge devices
- [`docs/DEPTH_AND_DIG_DEEPER.md`](./docs/DEPTH_AND_DIG_DEEPER.md) — answer depth

## Contributing

Contributions are welcome — read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first.
This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).

Found a security issue? **Do not open a public issue.** Follow
[`SECURITY.md`](./SECURITY.md).

## Licensing

Digby is **dual-licensed**:

- **Open source — AGPL-3.0-or-later** (see [`LICENSE`](./LICENSE)). Free to use,
  study, modify and self-host. If you modify Digby and let others use it over a
  network, the AGPL asks you to publish your modifications.
- **Commercial licence** (see [`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md)).
  For embedding Digby in a closed-source product, running a managed service
  without publishing your changes, rebranding, or buying support, warranty and
  indemnity — plus the enterprise tier (SSO, SCIM, advanced RBAC, audit-log
  export).

Self-hosting Digby for yourself or your own organisation is free under the AGPL.

Copyright (C) 2026 Canada Quant Labs Inc.
