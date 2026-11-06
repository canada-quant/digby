# Digby Code — Agentic Coding

> The authoritative developer reference for **Digby Code**, Digby AI's agentic
> coding surface (rendered inline in the main chat page via
> `frontend/app/crossmodel/components/CodeSessionView.tsx`; the legacy
> `/crossmodel/code` page was retired). For the harness/scaffolding deep
> dive see [`DIGBY_CODE_HARNESS.md`](./DIGBY_CODE_HARNESS.md).

Digby Code lets a user point an open-source model (GLM-5.2 by default) at a
repository and have it build features, fix bugs, and open PRs — autonomously,
in an isolated per-session git worktree + Docker container, streaming its work
in real time. It is an **orchestrator-worker multi-agent** system with goal/todo
tracking, a verify loop, background-process monitoring, three tiers of memory, a
session-scoped retrieval store, and a hard "green-before-PR" gate.

---

## Table of contents

1. [Architecture at a glance](#architecture-at-a-glance)
2. [Data model](#data-model)
3. [Session lifecycle](#session-lifecycle)
4. [Run lifecycle & streaming](#run-lifecycle--streaming)
5. [The agent (orchestrator loop)](#the-agent-orchestrator-loop)
6. [Harness primitives — GOAL / LOOP / MONITOR](#harness-primitives--goal--loop--monitor)
7. [Memory (3 tiers + retrieval RAG)](#memory-3-tiers--retrieval-rag)
8. [Multi-agent system (roles / delegation / PR gate)](#multi-agent-system)
9. [Scaffolding](#scaffolding)
10. [Frontend](#frontend)
11. [REST + SSE API reference](#rest--sse-api-reference)
12. [Agent tool reference](#agent-tool-reference)
13. [Configuration](#configuration)
14. [Extending Digby Code](#extending-digby-code)
15. [Testing](#testing)
16. [File map](#file-map)

---

## Architecture at a glance

```
Frontend  /crossmodel  (Next.js — app/crossmodel/page.tsx → components/CodeSessionView.tsx)
   │  REST (projects/sessions/plan/…)     SSE (run stream)
   ▼                                        ▼
Express routes                          crossmodel-open.routes.ts  (query-token SSE)
  coding.routes.ts (header-auth, adult-only)   GET /chats/:id/stream
   │                                       (/coding/sessions/:id/stream → 308)
   ▼                                            ▼
coding.controller.ts                    coding-stream.controller.ts
  projects / sessions / plan / stop        starts a run (detached) → live-runs registry
   │                                            │
   ▼                                            ▼
workspace.service (git worktree)        agent.ts  agentLoop()  ── ORCHESTRATOR
container.service (per-session Docker)     │ delegates → WORKER subagents (roles.ts)
   │                                        │ tools: tools.ts + web tool-executor
   ▼                                        ▼
PostgreSQL (Prisma)  +  pgvector      GLM-5.3 / DeepSeek V4.1 Flash / Kimi K3 (coding-model.ts)
  crossmodel_chats + coding_sessions (ChatCodingState satellite)
  digby_memory (retrieval; legacy coding_memory_chunks read-fallback)
  store (plan / memory tiers / verify state)
```

A run is **decoupled from the HTTP request**: the agent writes events into an
in-memory registry (`live-runs.ts`); the SSE response subscribes. This is what
makes runs **reattachable** and survivable across a navigation.

---

## Data model

Prisma models (`backend/prisma/schema.prisma`):

| Model / table | Purpose | Key fields |
|---|---|---|
| `CrossModelChat` (`crossmodel_chats`) | The session itself — a coding session IS a chat (`mode='code'`) | `id`, `mode`, `title`, `projectId` |
| `ChatCodingState` (`coding_sessions`) | Worktree/run satellite of the chat (SAME id — the chat id) | `branch`, `baseBranch`, `worktreePath`, `permissionMode`, `model`, `status` |
| `CodingMessage` (`coding_messages`) | User + assistant turns (`chatId` column physically named `sessionId`) | `role`, `content`, `parts Json[]` |
| `CodingProject` (`coding_projects`) | **@deprecated (One-Digby merge)** — projects merged into `crossmodel_projects`; retained for rollback, UNREAD by current code | — |
| `coding_memory_chunks` | **Legacy** session retrieval table — read-fallback only (see below) | `session_id`, `source`, `ref`, `content`, `embedding` |

Session retrieval is a facade over the unified `digby_memory` store
(`memory/unified-memory.service.ts`): new writes land in `digby_memory` (scope
`session`, per-scope cap 800); reads query the unified store first and fall back
to the legacy `coding_memory_chunks` table for pre-migration sessions
(`coding-retrieval.service.ts`).

Session `status`: `provisioning` → `ready` → `running` → `ready` (or `error`,
`archived`).

Non-relational state lives in the namespaced `store` table (via
`memory/context-store.ts`):

| Namespace | Key | Value |
|---|---|---|
| `[userId, 'coding-user']` | `memory` | `UserCodingMemory` (tier 1) |
| `[projectId, 'coding-project']` | `memory` | `ProjectCodingMemory` (tier 2) |
| `[sessionId, 'coding-session']` | `memory` | `SessionCodingMemory` (tier 3) |
| `[sessionId, 'coding-plan']` | `plan` | `CodingPlan` (goal + todos) |
| `[sessionId, 'coding-verify']` | `state` | `VerifyState` (PR gate) |

---

## Session lifecycle

1. **Import a project** (`POST /coding/projects`): github repo, any https git URL,
   or a `blank` project (empty git repo). No worktree yet.
2. **Create a session** (`POST /coding/projects/:id/sessions`): a row is created
   with a generated branch name, `status: provisioning`; `provisionWorktree` runs
   in the background.
3. **Provision worktree** (`workspace.service.ts`): a per-session git worktree off
   a fresh branch from the project's default branch (N sessions share one mirror
   clone). Blank projects get an initialized empty repo.
4. **Scaffold** (`scaffolding.service.ts` → `scaffoldProjectDocs`): if absent,
   writes `AGENTS.md` + `.digby/` from detected ground truth (see [Scaffolding](#scaffolding)).
4b. **Install dependencies** (imported projects only): runs the scaffolded
   `commands.install` (npm/pnpm/yarn install, uv sync, bundle install, cargo
   fetch, …) in the session so the real toolchain (tsc/ruff/jest) exists and
   `verify` runs for real. The session stays `provisioning` until this finishes;
   best-effort + capped (a failed/absent install never blocks `ready`).
5. **Container** (`container.service.ts`, if `CODING_CONTAINER_MODE=1`): a
   per-session Docker container (`--init`, memory/cpu-capped, mounts the workspace
   volume) runs shell tools via `docker exec`. Falls back to in-process bash.
6. Session → `ready`. The 24h idle reaper stops+removes idle containers.

---

## Run lifecycle & streaming

The SSE endpoint is `GET /api/crossmodel/chats/:id/stream` (query-token auth;
`crossmodel-open.routes.ts`, mounted before auth-bearing routers). The legacy
`GET /coding/sessions/:id/stream` is a 308 redirect that preserves the query
string (`token` / back-compat `message`) onto the canonical mount
(`coding-public.routes.ts`).

- **Start** (message present): `coding-stream.controller.ts` reserves a live-run
  slot (`startLiveRun`, synchronous — prevents a double-start race), persists the
  user message, sets `status: running`, and kicks off `executeRun` **detached**.
  This HTTP request then just subscribes to the run.
- **Attach** (empty message): if a run is active for the session, the request
  subscribes and **replays the buffered events** then streams live — this is how a
  client that navigated away rejoins. The frontend opens this automatically when a
  reopened session has `status: running`.
- **Orphan recovery**: empty message, no live run, but `status: running` (killed by
  a deploy/restart) → the row is reset to `ready` and a synthetic
  `complete{interrupted:true}` is emitted, so a session is never stuck blank.
- **Durability**: `executeRun` throttle-upserts the assistant transcript to one
  `CodingMessage` every ~8s (text coalesced + tool/subagent parts; reasoning
  omitted), reusing that row for the final write. A run killed mid-flight leaves
  its partial work on reopen.
- **Stop** (`POST /chats/:id/stop`; `/coding/sessions/:id/stop` alias): live run →
  `cancelRun` flag (the agent bails at its next step/tool checkpoint, finalizes,
  emits `complete{stopped}`); orphaned row → reset to `ready`.
- **Tool timeout**: each tool call is raced against a 4-min backstop so one wedged
  tool can't freeze the run.
- **Compaction** (`compaction.ts`): when the running message array exceeds ~90k
  chars over the ≤200-step run, the middle is summarized into a recap and the
  most-recent turns are kept verbatim — without orphaning a tool result from its
  assistant tool_call.

### SSE events

`init` · `progress{stage}` · `reasoning{delta}` · `text{delta}` · `tool_call{name,args}` ·
`tool_result{name,result}` · `plan_update{plan}` · `verify_start` / `verify_result` ·
`process_start` / `process_stop` · `subagent_start{role,title}` / `subagent_end{role,title,summary}` ·
`permission_request` / `permission_resolved` · `ask_user{questionId,question,options,expiresAt}` ·
`loop_update{kind,round,max,detail}` · `stopped` · `git_committed` / `pr_opened` ·
`complete{finalText,parts,stopped?,interrupted?}` · `error{message}`.
Worker (subagent) events are prefixed `subagent:` **except** permission prompts,
which use the un-prefixed channel so ask-mode approvals from workers reach the UI.

---

## The agent (orchestrator loop)

`agent.ts` `agentLoop()` drives the model turn-by-turn: build context → stream a
turn → execute tool calls → repeat → final answer. `MAX_STEPS = 200` top-level
(`CODING_PROFILE.maxSteps`).

- **System prompt** = Digby defaults (explore → plan → change → verify → commit;
  read-before-edit; prefer `edit_file`; permission modes; all-mode safety) +
  `AGENTS.md`/`.digby` guide + the 3 memory tiers + the role roster (orchestrator)
  or the worker's role prompt.
- **Permission modes**: `auto` (no prompts), `plan` (read-only — mutating +
  code-executing tools blocked), `ask` (approve each mutation via
  `approval-registry.ts`, 5-min auto-deny).
- **Model layer** (`coding-model.ts`): resolves GLM-5.3 / DeepSeek V4.1 Flash
  (`deepseek-flash`) / Kimi K3 (glm-5.2, kimi-k2.6, deepseek-v4-pro and
  deepseek-v4-flash are legacy aliases; qwen3.6-27b is the helper tier), streams
  reasoning + content, assembles tool calls from fragments.

---

## Harness primitives — GOAL / LOOP / MONITOR

Full detail in [`DIGBY_CODE_HARNESS.md`](./DIGBY_CODE_HARNESS.md). In brief:

- **GOAL** (`plan.service.ts`): `update_plan({goal, acceptance_criteria, steps})`
  — one full-array-rewrite tool, server-enforced single `in_progress`, mirrored to
  git-ignored `.digby/session/todo.md`. A compact `<plan>` reminder is re-injected
  **every turn** (the anti-drift lever). User-editable from the Overview sidebar
  via the plan REST endpoints (same `applyPlan` normalization).
- **LOOP** (`verify.service.ts`): `verify({only?})` runs the cheapest-first chain
  (typecheck → lint → test) from `.digby/config.json`, fail-fast. In **auto** mode
  the harness auto-verifies on a clean finish and feeds failures back, bounded by
  no-progress / oscillation / repeated-failure guards.
- **MONITOR** (`process.service.ts`): `start_background_process` / `read_process_output`
  / `list_processes` / `stop_process` — detached `setsid` processes with byte-offset
  cursors and ground-truth status; enables dev servers/watchers.

---

## Memory (3 tiers + retrieval RAG)

**Three durable tiers** (`coding-memory.service.ts`), injected into every run's
system prompt and updated fire-and-forget after each run (cheap utility LLM):

1. **User** (`[userId,'coding-user']`) — cross-project developer preferences
   (tooling, style, commit conventions).
2. **Project** (`[projectId,'coding-project']`) — codebase overview, commands, notes.
3. **Session** (`[sessionId,'coding-session']`) — rolling summary of this session.

**Retrieval RAG** (`coding-retrieval.service.ts`) — the multi-agent leg:
explorer/web-researcher/architect workers **offload** the full content they gather
(files read, pages scraped, search results, their digest) into the session scope of
the unified `digby_memory` store (`memory/unified-memory.service.ts`; pgvector 1536,
DashScope `text-embedding-v4`; keyword tsvector fallback — long queries reduce to
OR-ed distinctive tokens via `ftsQueryFor` so the keyword leg survives them). Reads
query `digby_memory` first and fall back to the legacy `coding_memory_chunks` table
for pre-migration sessions. EVERY role can retrieve via the `search_memory({query,
scope?, source?})` and `search_code_semantic({query})` tools. Cleared on session
delete; per-scope cap 800 (the shared project scope is source-scoped: the code
index sweeps only its own 'code' rows).

**Retrieval is pushed, not just pulled** (owner 2026-09-04 — "doesn't read memory
or embeds very often"): the run-start assembly injects, beside the 3-tier memory
block and run journal, `[RELEVANT LEARNINGS]` (learnings.md entries semantically
matched to the task), `[CODE INDEX MATCHES]` (files the repo embedding index
matches to the task — `buildCodeMatchesBlock`), and `[SESSION MEMORY INVENTORY]`
(per-source counts of what `search_memory` holds — a model that believes memory is
empty never searches it). The doctrine carries a "Memory first" bullet + an Explore
bullet that leads with `search_code_semantic`; every role prompt names its
retrieval tools; worker offloads append a model-facing `[HARNESS: … search_memory
…]` pointer to the delegate return (they used to be UI-only progress events); the
repeat-failure nudge suggests `search_memory(source:'learning')`. Usage is
telemetered: `coding_retrieval_usage` (per terminal run: retrieval vs raw-read
counts) + `coding_retrieval_hits` (per call, value = hits; 0 charts the
empty-result rate) in `loop_metrics`.

---

## Multi-agent system

Orchestrator-worker. The main agent is the **orchestrator** (owns goal + todos,
all tools + `delegate`/`delegate_parallel`). It delegates scoped work to bounded,
depth-1 **worker** subagents (`roles.ts`), each with a role prompt + a tool policy.

| Role | Writes? | Purpose |
|---|---|---|
| `planner` | no | decompose the goal → todos (read + `update_plan`) |
| `architect` | no | propose a design/approach before coding |
| `explorer` | no | map a large codebase → digest + offload to RAG |
| `web_researcher` | no | gather external facts via web search/scrape → RAG |
| `coder` | yes | implement a scoped task, verify as it goes |
| `editor` | yes | surgical refactor/cleanup/docs on named files |
| `verifier` | no | run the verify chain + inspect the diff; report issues |
| `reviewer` | no | adversarial correctness/security review of the change set |

**Guarantees**: read-only roles can't mutate the worktree; `git_push` /
`open_pull_request` / `delegate` are orchestrator-only; `update_plan` is
orchestrator + planner only; workers can't delegate further (depth-1).
A delegate brief demanding a **file artifact** from a **read-only role**
("write the annotations to `tmp/out.json`", ticket 68a36304) is refused at
dispatch — before a worker runs or budget is charged — with the re-route
(coder/editor, or keep the analysis role and the orchestrator writes the file
itself); the refusal also covers `delegate_parallel` legs.

- **`delegate({role, task, title?, todo_id?})`** — runs one worker; `todo_id` links
  it to a plan step, marked completed/blocked with the worker's summary as its note
  on return (emits `plan_update`).
- **`delegate_parallel({tasks:[…]})`** — runs up to 6 **read-only** workers
  concurrently (writers rejected — concurrent worktree writes corrupt state).
- **Budgets**: per-run delegation budget `CODING_PROFILE.maxDelegations = 100`
  (the old `MAX_DELEGATIONS = 20` const was removed — the profile budget is the
  only enforcement); per-role step budgets (`ROLES[role].maxSteps`).
- **PR gate** (`verify-state.ts`): the agent's autonomous `open_pull_request` is
  hard-blocked unless the verify chain passed this session (enforced when a chain
  exists **and** `loop.gatePullRequest`, default true). The human "Open PR" button
  bypasses it (`ctx.prGateBypass`).

---

## Scaffolding

On the first worktree provision, if the repo has no `AGENTS.md`/`.digby`,
`scaffolding.service.ts` detects the stack from **ground truth** (manifests /
lockfiles only, no execution) and writes a lean project-specific `AGENTS.md`,
`.digby/config.json` (commands + verify chain + `loop` block, plus a starter
repo-owned `hooks` section when the detected tooling supports one), `.digbyignore`,
`.digby/notes/learnings.md`, `.digby/README.md`, then commits on the session
branch. An existing `AGENTS.md` is respected, never clobbered. Full detail in
[`DIGBY_CODE_HARNESS.md`](./DIGBY_CODE_HARNESS.md).

---

## Frontend

`frontend/app/crossmodel/components/CodeSessionView.tsx` (client component, mounted
inline by `app/crossmodel/page.tsx` — the legacy `code/page.tsx` was retired) +
`frontend/lib/api/coding.ts`.

- **Layout**: resizable left rail (projects + sessions, drag handle, width persisted
  to localStorage) · main chat · right **Overview** panel (persistent at xl, drawer
  below).
- **Overview panel**: Project info · Goal (editable) · Todos linked to the goal
  (add / cycle status / delete, progress bar). Live from `plan_update`; editable
  when idle (locked while running).
- **Chat rendering**: chronological live stream (text/reasoning/tool cards coalesced
  in arrival order), Claude-Code-style borderless tool cards, `+/-` git diff colors
  (`DiffText`), collapsible "Thinking" blocks, a "Working · Xs" elapsed timer, live
  **worker chips** (from `subagent_start`/`subagent_end`), and permission-approval
  prompts. Message list is **windowed** (last 20 + "Load earlier") to keep the DOM small.
- **Composer**: auto-growing textarea; a red **Stop** button while running.
- **Preview**: a Preview section renders the session's dev server in a sandboxed
  iframe. The backend proxies via `curl http://localhost:<port>` **inside** the
  session (`docker exec`; base64 for binary), rewriting HTML (`<base>` +
  root-absolute paths) so it loads. Iframe auth = `?token=` → path-scoped httpOnly
  cookie for sub-resources; a port denylist blocks loopback infra
  (`coding-preview.controller.ts`). The sandbox omits `allow-same-origin` by
  default (so a previewed app's JS can't read the user's token), which keeps
  SSR / plain-HTML / relative-asset apps rendering well while SPA dev servers with
  absolute JS-built asset URLs don't fully load. Set `CODING_PREVIEW_HOST` (see
  [Configuration](#configuration)) to serve previews cross-origin and unlock full
  SPA previews.
- **Sessions**: archive / unarchive (collapsible "Archived (N)" group).
- **Runs**: started via `POST /chats/:id/run` (canonical mount; `/coding/sessions/:id/run`
  remains a working alias) — prompt in the body → no URL-length limit; the client
  then opens the SSE stream in attach mode.
- **Reconnect**: reopening a `running` session attaches to the live run; a transient
  SSE drop re-attaches with backoff; terminal events reconcile from the DB.

---

## REST + SSE API reference

All under `/api/crossmodel`. REST routes are header-auth + adult-only
(`coding.routes.ts`); the SSE stream + preview are query-token
(`crossmodel-open.routes.ts` / `coding-public.routes.ts`).

Run control and the stream have canonical CHAT mounts — `POST /chats/:id/run` ·
`POST /chats/:id/stop` · `POST /chats/:id/steer` (`crossmodel.routes.ts`) and
`GET /chats/:id/stream` (`crossmodel-open.routes.ts`). The `/coding/sessions/:id/*`
forms below are compat aliases (the stream is a 308 redirect preserving the query
string). Core set:

| Method | Path | Purpose |
|---|---|---|
| GET | `/coding/github-repos` | list importable GitHub repos |
| GET | `/coding/projects` | list projects |
| POST | `/coding/projects` | import a project (`{provider, repoUrl?, name?, defaultBranch?}`) |
| DELETE | `/coding/projects/:id` | delete a project (+ worktrees) |
| POST | `/coding/projects/:id/knowledge` | "Save canvas to project" → knowledge branch commit |
| GET | `/coding/projects/:projectId/sessions` | list sessions |
| POST | `/coding/projects/:projectId/sessions` | create a session |
| GET | `/coding/sessions/running` | ids of the caller's currently-running sessions |
| GET | `/coding/sessions/:id` | get a session (+ messages, project) |
| PUT | `/coding/sessions/:id` | update `{title?, permissionMode?, archived?}` |
| DELETE | `/coding/sessions/:id` | delete a session (+ worktree, retrieval memory) |
| GET | `/coding/sessions/:id/diff` | git status + diffstat |
| POST | `/coding/sessions/:id/push` | push the branch |
| POST | `/coding/sessions/:id/pr` | open a PR (human — bypasses the verify gate) |
| POST | `/coding/sessions/:id/run` | **start a run** (`{message}` in the body; alias of `POST /chats/:id/run`) |
| POST | `/coding/sessions/:id/stop` | stop / unstick a run (alias of `POST /chats/:id/stop`) |
| POST | `/coding/sessions/:id/steer` | steer a live run (alias of `POST /chats/:id/steer`) |
| GET | `/coding/sessions/:id/plan` | get the plan (goal + todos) |
| PUT | `/coding/sessions/:id/plan/goal` | set goal (`{goal, acceptanceCriteria?}`) |
| POST | `/coding/sessions/:id/plan/todos` | add a todo (`{text}`) |
| PATCH | `/coding/sessions/:id/plan/todos/:stepId` | set todo status |
| DELETE | `/coding/sessions/:id/plan/todos/:stepId` | remove a todo |
| POST | `/coding/approvals/:approvalId` | resolve an ask-mode prompt (`{decision}`) |
| POST | `/coding/questions/:questionId` | answer an `ask_user` question |
| GET | `/chats/:id/stream?token=[&message=]` | **SSE run stream** (canonical; attach; message= starts a run, back-compat) |
| GET | `/coding/sessions/:id/stream?…` | 308 redirect to the canonical stream |
| GET | `/coding/sessions/:id/preview/:port(/*)?token=` | **live app preview** proxy (iframe) |

Newer route families (full source of truth: `coding.routes.ts`):

| Method | Path | Purpose |
|---|---|---|
| GET/PUT/DELETE | `/coding/credentials` (`/:id`) | coding CLI/API credentials (write-only values, masked list) |
| GET/POST | `/coding/dev-container/status` · `/restart` · `/tailnet/restart` | shared tailnet dev container |
| GET/PUT | `/coding/dev-container/egress` + PUT `/coding/sessions/:id/tailnet-egress` | tailnet egress policy (per-user default + per-session override) |
| GET | `/coding/cron-status` | durable cron supervision (cron_jobs + agent_runs queue counts) |
| POST | `/chats/:chatId/messages/:messageId/vault` | **one-tap "Vault this"** on the owner's own credential paste (ticket f95e1e30) — no body, no client value: the route lifts the value server-side from that persisted row (owner-only; 404 on a foreign row) |

---

## Agent tool reference

Defined in `tools.ts` (`CODING_TOOL_SCHEMA` = `BASE_CODING_TOOL_SCHEMA` +
`PLATFORM_TOOL_SCHEMA`) + the shared web tools (`tool-executor.ts`) +
`delegate`/`delegate_parallel` (`agent.ts`). "Roles" = which workers may call it
(orchestrator has all). Core set below — the full source of truth is `tools.ts` +
`roles.ts` (`ROLE_TOOLS`).

| Tool | Mutating | Roles |
|---|---|---|
| `read_file`, `list_dir`, `glob`, `grep`, `git_status`, `git_diff`, `git_log`, `git_show` | no | all |
| `write_file`, `edit_file` | yes | coder, editor |
| `run_command` | yes | coder, editor, verifier, reviewer |
| `git_commit` | yes | coder, editor |
| `git_push`, `open_pull_request` | yes | orchestrator only |
| `update_plan` | no | orchestrator, planner |
| `verify` | executes code | coder, verifier, reviewer |
| `start_background_process`, `read_process_output`, `wait_for_process_output`, `list_processes`, `stop_process` | proc | coder |
| `search_memory`, `search_code_semantic` | no | planner, architect, explorer, web_researcher, coder, reviewer (+ orchestrator) |
| `search_engine`, `scrape_as_markdown`, `browser_task`, `web_pipe`, `youtube_pipe` | web | web_researcher (+ orchestrator; architect/explorer also get `scrape_as_markdown` + `web_pipe`) — note: a **worker's** `browser_task` runs the COMPUTER destination **camera-only** (ticket 8fe9429c: screenshots/reads allowed, click/type/key/scroll/open refused at the harness gate); the orchestrator keeps full computer use |
| `session_browser` | hosted browser (raw single-action) | orchestrator only — Digby's own pinned-Chromium container, ONE persistent context per session (cookies/localStorage survive between runs; ticket ea3ad8a8). Schema present only when `BROWSER_SERVICE_ENABLED=1`; `browser_task` (the agentic loop) routes to the same hosted browser for app-less users |
| `ask_user`, `schedule_self` | no | orchestrator only |
| `github_search_code`, `github_list_issues`, `github_get_issue`, `github_list_prs`, `gmail_search`, `drive_search`, `slack_search`, `asana_search` | no (read-only connectors) | planner, architect, explorer, web_researcher, coder, reviewer (+ orchestrator) |
| `delegate`, `delegate_parallel` | — | orchestrator only |
| `file_feedback` | platform (low-risk: dedup'd + rate-capped) | every role (+ orchestrator) |

The **platform tool set** ("Digby can use Digby" — chat/project/schedule/goal/todo/
hook management, `send_chat_message`, `start_coding_session`, `send_to_instance`,
feedback triage; `platform/platform-tools.ts` — plus, since 2026-09-08, the
**account-tool group** in `platform/account-tools.ts`: memory (`list_memory` /
`remember_fact` / `forget_fact`),
knowledge base (`list_knowledge_documents` / `add_knowledge_url` /
`add_knowledge_note`), canvases (`list_canvases` / `get_canvas` / `update_canvas`),
share links (`create_share_link` / `revoke_share_link`), Telegram (`notify_user`
push + the read-only `telegram_connect_link`, which returns the in-app
Integrations connect page — never the bearer token), per-chat standing
instructions (`set_chat_instructions`) and `get_account_overview`) is appended to
`CODING_TOOL_SCHEMA`, so the orchestrator gets it too; workers get only
`file_feedback`. Gating matches chat: reads are never gated, non-consequential
mutations follow the session's permission mode like every other mutating tool
(`remember_fact`, `forget_fact`, `set_chat_instructions` and `add_knowledge_url`
additionally require a REAL user turn — a machine-fired run on injected text may
not plant memory, prompts or RAG; knowledge ingestion is capped 10/hour per chat
+ 50/day per user), and the consequential ones (`create_share_link`
— like `schedule_message`) need a user-turn-anchored
confirmation. The **never-autonomous set** (`set_chat_autonomy`,
`create_share_link`; `NEVER_AUTONOMOUS_TOOLS` in platform-tools.ts) additionally
takes NO auto-mode bypass, no ChatAutonomy grant and no implicit parent→child
path: a coding session ingests untrusted ticket text, and those tools change the
account's security posture — with TWO authority-neutral exceptions for
`set_chat_autonomy` (both fail-closed): the 9341e862 non-widening SELF-request,
and the eb4337fe scoped supervisor DELEGATION (a supervisor-class granter
granting a same-owner supervised lane within its own effective tools/cap;
source 'machine_delegated'; kill switch `AUTONOMY_DELEGATION_DISABLED=1`).
`notify_user` is the one push that works unattended
(Redis-capped 30/day per user + 5/hour per chat; the user's OWN linked Telegram
only). The user-wide `list_schedules` /
`cancel_schedule` / `update_schedule` are platform-owned (the coding schema's
per-session `schedule_self` is the coding-side counterpart; `schedule_message`'s
`chatId` is optional since 2026-09-08 and defaults to the current chat).

**Connector tools** (`coding-integrations.ts`) give the agent the same
integrations as chat Digby (GitHub / Google / Slack / Asana) — but as *callable
tools* rather than chat's intent-injection. They wrap the existing per-user MCP
clients (`github/`, `google/`, `slack/`, `asana/`), are read-only, and degrade
gracefully to a "not connected" message.

`edit_file` / `write_file` return a compact `+/-` hunk so the UI shows diff colors.

---

## Configuration

Env (backend):

| Var | Default | Effect |
|---|---|---|
| `CODING_CONTAINER_MODE` | off | `1` → per-session Docker container for shell tools (else in-process bash) |
| `CODING_RUNNER_IMAGE` | `node:20` | container image |
| `CODING_DEV_CONTAINER_MEMORY` | `12g` | memory ceiling for the shared per-user dev container (raised from `4g` — tickets db25c401/5a4e47ce; main shipped the `12g` raise, this knob makes it tunable). Running legacy containers are live-GROWN to this via `docker update` on ensure (never shrunk). Per-session containers stay `2g` (host oversubscription at worker concurrency). |
| `CODING_WORKSPACE_VOLUME` | `crossmodel_coding_workspaces` | shared workspace volume |
| `DASHSCOPE_API_KEY` | — | embeddings for `search_memory` (keyword fallback if unset) |
| `CODING_PREVIEW_HOST` | — | dedicated cross-origin preview host (see below); unset → same-origin preview |

Frontend: `NEXT_PUBLIC_CODING_PREVIEW_HOST` must match `CODING_PREVIEW_HOST` (it's baked into the client build).

Per-user (`user_preferences`): `codingModel` (stored default `glm-5.2` — a legacy
alias that `normalizeCodingModel` resolves to **`glm-5.3`**, today's effective
coding default), `codingPermissionMode`.
Per-project (`.digby/config.json`): `commands`, `verify` chain, `loop.*` (incl.
`gatePullRequest`), and an optional `hooks` section (repo-level `postEdit` /
`preCommand` rules — `coding/repo-hooks.ts`; a starter `postEdit` section is
scaffolded only when the repo root declares *and* resolves the formatter/linter
it names).

`verify[]` entry shapes (the tt-rd defect, dispatched 2026-10-01 23:49Z — a
hand-authored object-form chain was silently emptied before #1202): each entry
is either a bare **string** — the key into `commands.*` (`"verify": ["typecheck", "test"]`) — or an **object** `{name?, command?}`. Resolution order
per entry: `commands[name]` wins (a matching name re-points every surface with
one edit to `commands.*`); else the entry's own inline `command` runs (a
nameless inline command is reverse-mapped to its `commands.*` key when the
exact command text matches one, so `only:['test']` still selects it); else the
entry is skipped. Unknown keys and null-valued commands do not error — the
entry is just not runnable. `config.verify` absent or empty falls back to
`['typecheck','lint','test']` — but only when the config *parses*: a config
`readDigbyConfig` cannot parse resolves to an EMPTY chain instead
(`resolveVerifyChain` returns `[]` at :121 before the :123 fallback fires, so
the tool answers "No verify chain configured" — see FRAMEWORK_BACKLOG DW-2).
There is **no** `verified` or `docsHash` input:
`unverified` is only a *result* flag (`stages.some(s => s.skipped)`), never a
discovery gate.

### Dedicated cross-origin preview host (optional — full SPA previews)

By default the live preview is served **same-origin** and the iframe sandbox omits
`allow-same-origin`, so a previewed (possibly third-party) dev server's JS cannot
read the user's token from `localStorage`. The tradeoff: SPA dev servers that build
absolute asset URLs or use `localStorage` don't fully render.

To unlock full SPA previews, serve previews from a **dedicated origin** so the frame
is structurally isolated from the app (its JS runs on a different origin and can't
reach the app's `localStorage`), which lets the iframe safely use `allow-same-origin`:

1. **DNS**: add `preview.digby.ai` (an A/CNAME to the same EC2).
2. **TLS**: issue a cert covering it (or a wildcard `*.digby.ai`).
3. **nginx**: a server block for `preview.digby.ai` that proxies **only** the preview
   path to the backend, preserving the path:
   ```nginx
   server {
     server_name preview.digby.ai;
     # … TLS …
     location /api/crossmodel/coding/ { proxy_pass http://127.0.0.1:<active-backend-port>; }
     location / { return 404; }
   }
   ```
4. **Env**: set `CODING_PREVIEW_HOST=preview.digby.ai` (backend) **and**
   `NEXT_PUBLIC_CODING_PREVIEW_HOST=preview.digby.ai` (frontend build), then redeploy.

With it set, the backend swaps `X-Frame-Options: SAMEORIGIN` for
`Content-Security-Policy: frame-ancestors <app origin>` (so only the app may frame it),
issues the `dcp` auth cookie as `SameSite=None; Secure` (embedded cross-origin
sub-resources), and the frontend points the iframe at the preview host with
`allow-same-origin`. HMR websockets still need the dev server to accept the proxied
host; that remains best-effort.

---

## Extending Digby Code

**Add a worker role** — in `roles.ts`: add the key to `CodingRole`, an entry in
`ROLES` (prompt, `maxSteps`, `writes`) and `ROLE_TOOLS` (its allowed tools). It's
auto-listed in `orchestratorRoleGuidance()` and the `delegate` enum. Add a test in
`roles.test.ts` asserting its tool policy.

**Add an agent tool** — add a schema to `CODING_TOOL_SCHEMA` (`tools.ts`), a `case`
in `executeCodingTool`, and (if mutating) add it to `MUTATING_TOOLS`. Grant it to
roles via `ROLE_TOOLS`. Give it a frontend icon/summary in
`components/code-transcript.tsx` (`toolIcon`/`toolSummary`).

**Add an SSE event** — `emit('my_event', data)` in `agent.ts`/`tools.ts`; handle
`type === 'my_event'` in `connectStream` (`components/CodeSessionView.tsx`). Worker
emits are `subagent:`-prefixed.

**Add a REST endpoint** — controller method in `coding.controller.ts` + route in
`coding.routes.ts` (auth) or `coding-public.routes.ts` (query-token). Add a client
method in `lib/api/coding.ts`.

**Persist per-session state** — use `memory/context-store.ts` (`storeGet`/`storePut`)
with a `[sessionId, 'your-namespace']` key; no migration needed.

---

## Testing

Jest (ts-jest). Coding suite: `npx jest src/modules/crossmodel/coding` (from
`backend/`). Notable specs: `roles.test.ts` (tool policies), `live-runs.test.ts`
(reattach/cancel), `compaction.test.ts` (safe cut), `coding-memory.test.ts`
(3-tier format), `loop-goal-monitor.test.ts`, `tools.test.ts` (path-escape +
mutating classification), `scaffolding.service.test.ts`. Tests that transitively
import env-touching modules mock `../memory/context-store`, `./coding-retrieval.service`,
and `../../../utils/utility-llm`.

---

## File map

```
backend/src/modules/crossmodel/coding/
  agent.ts                    orchestrator + worker loop, delegate(_parallel), compaction hook
  roles.ts                    8 role defs + tool policies
  coding-model.ts             model resolution + streaming turn
  tools.ts                    coding tool schemas + executor + permission gate
  plan.service.ts             GOAL: plan/todos
  verify.service.ts           LOOP: verify chain
  verify-state.ts             per-session verify pass (PR gate)
  process.service.ts          MONITOR: background processes
  live-runs.ts                in-memory run registry (reattach + cancel)
  coding-memory.service.ts    3-tier memory
  coding-retrieval.service.ts session RAG (offload + search_memory)
  scaffolding.service.ts      AGENTS.md + .digby scaffolding
  workspace.service.ts        git worktrees
  container.service.ts        per-session Docker + idle reaper
  approval-registry.ts        ask-mode approvals
  coding.controller.ts        REST (projects/sessions/plan/stop)
  coding-stream.controller.ts SSE run (start/attach/orphan) + executeRun
  coding.routes.ts / coding-public.routes.ts   routes
  *.test.ts                   unit tests
frontend/
  app/crossmodel/components/CodeSessionView.tsx   the Code UI (mounted by app/crossmodel/page.tsx)
  app/crossmodel/components/code-transcript.tsx   tool cards (toolIcon/toolSummary)
  lib/api/coding.ts                               API client
  components/ui/custom/resize-handle.tsx          resizable-rail handle
```

See also: [`DIGBY_CODE_HARNESS.md`](./DIGBY_CODE_HARNESS.md) (scaffolding + harness
internals), [`crossmodel-architecture-v2.md`](./archive/crossmodel-architecture-v2.md),
[`deployment.md`](./archive/deployment.md).
