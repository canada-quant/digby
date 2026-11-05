# Digby Platform Unification Plan — "Digby can use Digby"

> **ARCHIVED 2026-09-28 (backlog audit DOI-25): the P5 remainder — the
> transcript merge and the physical rename `crossmodel_projects→folders`
> (model `Folder`) — is NOT planned. Nothing owes it: the table stays
> `crossmodel_projects`, the API and docs call it a project / folder
> interchangeably, and no commit since 2026-08-31 references the rename. If it
> is ever wanted it is a new plan, not this one.**
>
> **STATUS 2026-08-31: P0–P4 + P6 landed; P5 partially landed as P5-B (mode
> marker/guard/satellite shipped) — transcript merge + physical folder rename
> (crossmodel_projects→folders, model Folder) were still pending at that date
> (see the archive banner above). The "Current state" section below is as-of
> authorship, not current.**

> Status: **proposal** (architecture review). Authored from a full codebase survey
> (backend API/data model, frontend UX, coding-session harness) + architect pass.
> Related: `docs/DIGBY_CODE.md`, `docs/DIGBY_CODE_HARNESS.md`, the One-Digby merge
> notes in `memory-bank/crossmodel-progress.md`.

## The vision (three pillars)

1. **Model-callable platform.** Everything a user can do in the UI, the models can do
   on the user's behalf, with that user's permissions: start a new coding session in a
   folder, send a message to any chat, schedule background processes/runs in chats,
   move chats between folders, rename/archive/delete sessions, manage folders.
   "Digby can use Digby" — and the user watches it happen in their UI in real time.
2. **Folders supersede projects.** Phase out "projects" as a concept. A folder is a
   collection of sessions with shared memory/docs/workspace — exactly what a project
   already is — **plus nesting**: folders contain folders.
3. **Chats and coding sessions are one thing.** Not a slider notch, not a separate
   entity — one thread model where "coding" is a capability a thread can have.

---

## Current state (verified — this is what we build on)

The **One-Digby merge (2026-07) already unified identity at the DB level**:

- A coding session **is** a `CrossModelChat` row with `mode='code'` + a
  `ChatCodingState` satellite row (same id: `branch`, `baseBranch`, `worktreePath`,
  `permissionMode`, `model`, `status`). Coding projects are `CrossModelProject` rows
  with workspace fields (`repoUrl`, `repoProvider`, `defaultBranch`, `workspaceAt`).
- `CrossModelMessage.parts Json?` **already exists** with the comment "ordered agent
  parts (CodingMessage shape)" — the transcript merge was anticipated; it's a data
  migration, not a schema invention.
- SSE has **half-converged**: `live-runs.ts` is a generic in-memory run registry;
  `chat-agent.service.ts` already runs chat turns through it under `chat:${chatId}`
  keys. Two attach endpoints remain (`/crossmodel/stream` vs
  `/coding/sessions/:id/stream`), but the engine is one.
- **The agent loop is one**: `chat-agent.service.ts` invokes `runCodingAgent` with a
  `chatProfile`. A platform tool set added to `CODING_TOOL_SCHEMA` /
  `executeCodingTool` (`coding/tools.ts`) reaches **both** surfaces if profiles opt in.

Remaining seams:

| Seam | Today |
|---|---|
| Transcripts | Two tables: `CrossModelMessage` vs `CodingMessage` (same parts shape) |
| API surface | `/crossmodel/chats/*` vs `/crossmodel/coding/projects/:id/sessions/*` |
| Frontend | Patience slider notch 5 = "Coding" (`PATIENCE_MAP`, `page.tsx:200`); `startCodingChatFromComposer` (`page.tsx:2367`); second composer inside `CodeSessionView.tsx`; guard refuses `mode='code'` on a plain chat (`page.tsx:3951`) |
| Schedules | `CodingSchedule` exists, keyed `sessionId → crossmodel_chats.id`, but only fires coding runs; `schedule_self` is only available *inside* coding sessions |
| Platform tools | **None.** The agent has ~27 tools (files, shell, git, verify, delegate, schedule_self, background processes) + read-only integration tools — but nothing that manages the platform itself |

Folders/projects today:

- `CrossModelProject` is the only organizer. **No `parentId` — no nesting.**
- It already carries everything the "folder" vision needs: name/emoji/color,
  `systemPrompt`, members (`ProjectMember` viewer/editor/admin), share tokens,
  documents + pgvector RAG chunks, `ContextStoreEntry` memory
  (`[projectId,'context'|'settings']`), unified-memory scopes
  (`user/project/chat/session`), and coding-workspace fields.
- Delete semantics: chats' `projectId` SetNull (ungrouped); `ProjectDocument.projectId = null` is the virtual "Files" area.

Auth & permissions:

- Header JWT (`authenticate` middleware); SSE uses query-token JWT.
- Owner-scoping where-clauses on chat/project endpoints; `ProjectMember` roles for shared projects.
- Agent tool gating: `checkPermission` + `MUTATING_TOOLS` in `coding/tools.ts` (auto/plan/ask modes).
- `mcp-gateway/` is a BrightData-only auth-proxy container using a single shared
  `MCP_API_KEY` — **no per-user identity**. It is a deployment pattern to copy, not a
  surface to reuse for act-as-user calls.

---

## Option 1 — "Sidecar Tools & Folder Flag" (conservative)

**Concept.** In-process platform tools in the existing agent loops (no new HTTP
surface), nesting bolted onto `CrossModelProject` via self-relation, UX unified only
at the composer. Everything additive; nothing renamed; the app is never at risk.

### Pillar 1 — model-callable platform
- New module `backend/src/modules/crossmodel/platform-tools/`: `PLATFORM_TOOL_SCHEMA`
  + `executePlatformTool(ctx, name, args)`, registered into `executeCodingTool`'s
  dispatch (`coding/tools.ts`) and the chat profile's tool list (`agent-profiles.ts`).
- Tools: `list_chats`, `get_chat_status`, `create_chat`, `send_chat_message`,
  `start_coding_session` (wraps the same service path as
  `coding.controller.createSession`), `move_chat`, `rename_chat`, `archive_chat`,
  `delete_chat`, `create_project`, `update_project`, `delete_project`,
  `schedule_message` (generalizes `schedule_self` to target any chat — the sweeper
  fires a coding run for `mode='code'` rows and a detached chat-agent turn
  otherwise), `list_schedules`, `cancel_schedule` (widened to the user).
- **Auth: act-as-user, in-process.** `ToolContext.userId` *is* the acting user; tools
  call the same Prisma/service paths as controllers with owner-scoping where-clauses;
  shared-project access via `ProjectMember` role lookup (viewer = read tools only,
  editor/admin = mutating). Mutating tools join `MUTATING_TOOLS` → existing
  auto/plan/ask gating applies. Every mutation writes an `Activity` row
  (`resource: 'platform'`) for audit.
- No tokens, no new routes, nothing network-exposed.

### Pillar 2 — nested folders
- `parentId String?` self-relation on `CrossModelProject` + `@@index([parentId])`.
  One trivial migration (all NULL = today's flat list). Depth cap 5; cycle check on move.
- `projects.controller.ts`: create/update accept `parentId`; list returns the flat
  list (per-user, small) and the frontend assembles the tree; get gains
  `children`/`ancestors` (breadcrumb).
- Delete semantics unchanged (children promote to root; chats ungrouped) — deliberately boring.
- UI: sidebar "PROJECTS" section becomes a tree (indent + chevrons); labels say
  "Folders". No route/API/table renames.

### Pillar 3 — chat/coding UX
- Keep the patience slider as-is (notch 5 = coding creation gesture).
- **Single composer**: extract `CodeSessionView`'s composer into a shared
  `ChatComposer` (code chats: permission-mode chip + stop/steer; plain chats:
  attachments/voice). Kills the composer seam without touching transcripts or SSE.

### Changes
- **New:** `platform-tools/` (+ tests), `ChatComposer.tsx`.
- **Edited:** `schema.prisma` (parentId), `projects.controller.ts/routes.ts`,
  `coding/tools.ts`, `agent-profiles.ts`, `schedule.service.ts`, sidebar in
  `page.tsx`, `CodeSessionView.tsx`.
- **Deleted:** nothing.

### Tradeoffs
- ✅ Minimal risk; every step additive and independently revertable. ~1–1.5 weeks.
- ✅ Folder tree instantly understood; slider stays familiar.
- ❌ "Coding" as a *patience* notch remains conceptually wrong (it's a capability,
  not an amount of patience — the `PATIENCE_DESCRIPTIONS` copy already strains).
- ❌ Two transcript tables and two SSE paths remain as permanent maintenance tax.
- ❌ No external/programmatic API: "Digby can use Digby" only from *inside* Digby's
  own agent loops — under-delivers pillar 1.

---

## Option 2 — "Platform API + Folder Tree" (recommended shape)

**Concept.** Everything in Option 1, but platform capabilities sit behind a **real
REST API backed by an extracted service layer** — internal tools, web UI, and later
external agents all call the same code. Folders get first-class tree semantics
(materialized path, inherited context) while remaining the same table. The slider
loses notch 5 in favor of an explicit **Code capability chip** on the unified
composer; SSE converges to one attach endpoint.

### Pillar 1 — model-callable platform
- **Service extraction:** `backend/src/modules/crossmodel/platform/platform.service.ts`
  — `createChat`, `moveChat`, `deleteChat`, `startCodingSession`, `scheduleChatRun`,
  `createFolder`, … `crossmodel.controller.ts`, `projects.controller.ts`, and
  `coding.controller.ts` are progressively re-pointed to it (thin controllers) →
  exactly one authorization + validation implementation.
- **REST surface** (`platform.routes.ts`, mounted `/api/crossmodel/platform/`):
  - `GET /chats?folderId=&mode=&status=` · `POST /chats {title, folderId?, mode?}` ·
    `POST /chats/:id/messages {content}` · `POST /chats/:id/code {permissionMode?}`
    (turns a chat into / starts a coding session) ·
    `PATCH /chats/:id {title, folderId, archived}` · `DELETE /chats/:id` ·
    `GET /chats/:id/status` (run state, plan, branch, PR url)
  - `GET /folders` (tree) · `POST /folders {name, parentId?, emoji?, color?, systemPrompt?}` ·
    `PATCH /folders/:id` · `DELETE /folders/:id?reparentTo=` ·
    `POST /folders/:id/workspace`
  - `POST /schedules {chatId, prompt, kind, intervalSec}` · `GET /schedules` · `DELETE /schedules/:id`
- **Caller types:** (1) user JWT — full access to own resources; (2) **agent tokens** —
  new `AgentToken` table (`id, userId, name, scopes[], expiresAt, lastUsedAt`, hashed
  token), scopes like `chats:read`, `chats:write`, `folders:write`, `schedules:write`,
  `code:run`. Users mint/revoke them in Account settings.
  `authenticateAgentToken` middleware resolves `req.user` + `req.agentScopes`;
  controllers enforce scope *before* owner/member scoping.
- **Internal tools** = thin wrappers over `platform.service.ts`: the model inside a
  run and a curl script outside get identical behavior and identical permissions.
  In-loop tools act-as-user via `ToolContext.userId`, still gated by
  `checkPermission`; destructive ones (`delete_chat`, `delete_folder`) are
  **ask-mode-only regardless of `auto`** (mirrors the git safety rules).

### Pillar 2 — nested folders
- Schema: `parentId String?` self-relation **plus `depth Int @default(0)` and
  `path String @default("")`** (materialized `/rootId/.../id`) on `CrossModelProject`.
  `path` makes subtree queries (`startsWith`) and breadcrumbs O(1); maintained on
  create/move inside a transaction.
- Prisma-level rename without DB rename: `model Folder { ... @@map("crossmodel_projects") }`
  — code reads `prisma.folder`, zero data movement; physical table rename deferred to
  a later housekeeping migration.
- **Hierarchy semantics (nearest-ancestor, explicit):**
  - *systemPrompt*: concatenate root→leaf (leaf last, highest precedence), depth-capped.
  - *Documents/RAG*: retrieval queries the chat's folder **+ ancestors** (cheap via
    `path`) — knowledge filed at "Work" is visible in "Work/Client A".
  - *Memory*: reads merge ancestor scopes nearest-first; **writes always go to the
    leaf**. Scope values unchanged (they hold ids either way); code renames the scope
    label `'project' → 'folder'`.
  - *Members*: effective role = **max(own row, nearest ancestor row)** — sharing
    "Work" with an editor implicitly shares "Work/*". Revocation at a child requires
    an explicit `role='none'` row (documented).
  - *Workspace*: **owned** by one folder (its own repo fields), **resolvable** from
    descendants (nearest ancestor with `repoProvider`) — matches today's
    current-project heuristic. Not auto-inherited downward.

### Pillar 3 — chat/coding UX
- **Single composer + one stream:** shared `ChatComposer`; `live-runs` keyed by bare
  `chatId` for both pipelines; unified `/chats/:id/stream` with replay/steer; old
  endpoints 308-redirect.
- **Slider → 4 notches + Code chip.** The Code chip is the creation gesture (same
  fallback to a default "Coding" folder as `startCodingChatFromComposer` today);
  `mode='code'` persists as the routing marker until Option 3's transcript merge.

### Tradeoffs
- ✅ True external API with scoped agent tokens → pillar 1 fully delivered.
- ✅ One authz implementation (service layer) reduces drift between UI and agent behavior.
- ✅ Every phase shippable; moderate risk concentrated in well-tested seams.
- ❌ New public surface = new compatibility/maintenance responsibility.
- ❌ Two transcript tables remain until Option 3. ~3–4 weeks total.

---

## Option 3 — "One Thread, One Table, One Protocol" (the end-state)

**Concept.** Complete the One-Digby merge: one transcript table, one stream, coding
as a **capability of any chat in a workspace folder**, physical renames included, and
an MCP server so *external* models/agents can drive Digby too.

### Pillar 1 — model-callable platform
- Everything in Option 2, **plus a `digby-mcp` server in `mcp-gateway/`**: a new
  container beside the BrightData one — same auth-proxy pattern, but **per-request
  JWT pass-through** instead of the shared `MCP_API_KEY`: the gateway forwards the
  caller's `Authorization` header to the backend platform API; the backend validates
  and acts as that user; agent tokens work too. MCP tools mirror the platform tool
  names 1:1 (`create_chat`, `start_coding_session`, `schedule_message`, …).
  `docker-compose.base.yml` gains one service.
- Internal agent-loop tools, REST API, and MCP server = **three transports over
  `platform.service.ts`**. Scope enforcement in one middleware; `Activity` audit on
  every mutation.

### Pillar 2 — nested folders
- Option-2 schema **completed by physical rename**: `crossmodel_projects → folders`,
  `project_members → folder_members`, `ProjectDocument.projectId → folderId`,
  `ChatCodingState.projectId → folderId`, memory scope label `'project' → 'folder'`
  (real migration, done while data is already moving for transcripts). The word
  "project" disappears from code and UI. Nesting/inheritance identical to Option 2.

### Pillar 3 — chat/coding UX
- **One transcript table.** Backfill `coding_messages → crossmodel_messages`
  (`sessionId → chatId`; `parts` column already matches), dual-write for one release,
  switch reads, then `DROP TABLE coding_messages` / delete the `CodingMessage` model.
- `ChatCodingState` becomes `ChatWorkspaceState` (`@@map("coding_sessions")`
  initially): a **nullable satellite created lazily** the first time a chat in a
  workspace folder actually needs a worktree. A chat can start as pure conversation
  and "go code" mid-thread — "they are basically the same thing," made literal.
- `CrossModelChat.mode` stops carrying `'code'`; it records only the patience
  pipeline. The "coding chat must never enter the chat stream path" guard
  (`crossmodel.controller.ts:837`) is **deleted** — there is only the chat stream
  path; the harness profile (chat vs coding) is chosen **per message** by
  (capability enabled AND workspace resolvable), not by a sticky row flag.
- **UX:** one composer, one sidebar of threads in a folder tree, one stream endpoint.
  The Code chip becomes per-chat capability state; the Overview panel
  (plan/diff/PR/processes) appears as a right-hand panel for any thread with
  workspace state. Patience (1–4) and Code are **orthogonal** — "deep research
  *about* the repo" and "quick code edit" both become expressible (impossible today).
- Schedules unify naturally: `CodingSchedule → ChatSchedule`
  (`@@map("coding_schedules")`), firing whatever profile the chat + prompt imply.
  "Schedule background processes in chats" falls out of the Option-2 generalization
  for free.

### Changes / deletions
- All of Option 2, plus: transcript backfill migration + dual-write shim in
  `coding-data.service.ts`; delete `CodingMessage`, the `mode='code'` guard,
  `coding.routes.ts`' sessions-nested-under-projects surface (sessions *are* chats —
  `POST /folders/:id/chats {capability:'code'}` replaces it), `coding.controller.ts`'s
  CRUD halves (keep run/steer/approve handlers, moved under chats);
  `frontend/lib/api/coding.ts` collapses into `crossmodel.ts`;
  `coding-public.routes.ts` folds into one chat-stream public route; new
  `digby-mcp/` gateway service.
- **Deleted (net):** `coding_messages` table, `/coding/sessions` REST tree, second
  composer, second SSE attach path, `startCodingChatFromComposer`, the
  `/crossmodel/code` redirect stub, the deprecated `CodingProject` rollback table.

### Tradeoffs
- ✅ Best UX clarity — one mental model: "threads in folders; threads can think
  deeper and can touch code."
- ❌ Highest risk: transcript backfill touches every historical coding session; the
  mode→capability change alters routing invariants the codebase treats as
  load-bearing. Needs a dual-write window and blue-green overlap like the original merge.
- ❌ ~6–8 weeks.
- Backwards compat: API aliases preserve integrations; the only user-visible loss is
  the word "Coding" on the slider.

---

## Recommendation: **Option 2 as the plan of record, landing on Option 3**

Option 1 under-delivers pillar 1 (no external act-as-user surface) and leaves the UX
seam permanent. Option 3's end-state is correct but its risk is front-loaded.
**Adopt Option 2 with Option 3 as the declared destination**, phased so every phase
ships green:

| Phase | Scope | Ships when |
|---|---|---|
| **0. Schema (non-breaking)** | `parentId/depth/path` on `CrossModelProject` (NULL/`/id` backfill — instant); `AgentToken` table; indexes. No behavior change. | Day 1 |
| **1. Platform service + internal tools** | Extract `platform.service.ts` (chat CRUD + move + delete + session-start first; controllers become shims one route at a time). Platform tools into `coding/tools.ts` + chat profile, `MUTATING_TOOLS` gating, `Activity` audit. Generalize `schedule.service.ts` to fire non-code chats via `startDetachedChatRun`. | ~1 wk — "Digby can use Digby" inside agent loops |
| **2. Folder tree** | Folder endpoints accept `parentId`; move with cycle/depth checks; ancestor inheritance for systemPrompt/docs/memory/members (behind a `folders` flag in `platform.service.ts`); sidebar tree UI + "Folders" copy; drag-drop move for chats and folders. Existing users' projects appear as root folders — zero migration. | ~1 wk after P1 |
| **3. Platform REST + agent tokens** | Mount `/api/crossmodel/platform/`; `AgentToken` mint/revoke UI in Account; scope middleware; short docs page. | ~3–4 days after P2 |
| **4. Single composer + one stream** | `ChatComposer.tsx` shared; `live-runs` keyed by bare `chatId` for both pipelines; unified `/chats/:id/stream` with replay/steer; old endpoints 308. Slider → 3 notches + Code chip (`deep_research_all` aliased to `deep_research` at the controller — see (d); behind flag; one-time toast for notch-5 users). | ~1 wk after P3 |
| **5. (Option 3) Transcript + capability merge** | Dual-write `CodingMessage → CrossModelMessage`, backfill, read-switch, drop table; delete the `mode='code'` guard; lazy `ChatWorkspaceState`; collapse `coding.routes.ts` session CRUD into chats. | ~2 wks, blue-green overlap like the original One-Digby migration |
| **6. (Option 3) MCP exposure** | `digby-mcp` container in `mcp-gateway/` with JWT pass-through (not the shared-key pattern); compose service + docs. Only after P3 proves the REST surface stable. | ~3–4 days |

**Existing-user migration:** projects → root folders automatically (P0/P2 need no
data change); coding sessions/chats untouched until P5's idempotent, resumable
backfill; the only UX retraining is notch 5 → Code chip, softened by a one-time toast
(and keeping notch 5 functional-but-deprecated for one release if dogfooding complains).

---

## Design questions, answered

### (a) Internal tools vs REST vs MCP? — **Combination, in that order of priority.**

Internal tool set **first** (zero latency, reuses `checkPermission`, act-as-user is
free because `ToolContext.userId` is captured at run start from the authenticated
request), backed from day one by `platform.service.ts` so the REST API is a thin
transport added in P3. MCP **only in P6**, and only with per-user JWT pass-through —
the current `mcp-gateway/auth-proxy.js` shared-`MCP_API_KEY` pattern has no user
identity and must not be reused for act-as-user.

Permission flow: user JWT or scoped `AgentToken` (`chats:write`, `folders:write`,
`code:run`, `schedules:write`) → middleware resolves `req.user` + scopes → service
enforces scope **then** owner/member scoping → mutation audited in `Activity`.
In-loop tools never see a token: they inherit the human's identity and are
additionally bound by the session's `permissionMode`, with destructive platform ops
hard-pinned to `ask`.

### (b) Nested folders: extend `CrossModelProject` with `parentId` — **yes; no new model.**

A parallel `Folder` model would fork every organizer query (chats, documents,
members, memory scopes, workspace, share tokens, schedules) into
"resolve project-or-folder" branches and force a second migration of every FK later —
the exact seam-count this initiative exists to reduce. Self-relation +
`@@map("crossmodel_projects")` gives nesting with one additive migration and a clean
code-level name. Hierarchy semantics: **nearest-ancestor everywhere, writes always to
the leaf** — systemPrompt concatenated root→leaf; docs/RAG and memory reads merge
ancestors; membership effective-role = max(own, nearest ancestor) with explicit
`none` opt-out; workspace owned by one folder, resolvable from descendants (nearest
ancestor with `repoProvider`). Depth cap 5, cycle-checked moves, materialized `path`
for O(1) subtree/breadcrumb queries.

### (c) Chat/coding UX: **capability, not a slider notch.**

- **Recommended end-state (P5):** coding is a capability any chat gains when attached
  to a workspace folder — one composer, one `crossmodel_messages` table, one
  `/chats/:id/stream`, `ChatWorkspaceState` created lazily on first worktree need,
  patience slider (1–4) orthogonal to the Code chip. Unlocks combos the current model
  forbids (deep-research-about-repo, quick-code-edit).
- **Interim state (P4):** shared `ChatComposer` + one stream endpoint land first; the
  **Code chip replaces notch 5** as the creation gesture (same default-"Coding"-folder
  fallback as today); `mode='code'` persists as the routing marker until P5.
- **Rejected alternatives:** keeping notch 5 permanently (patience is an *amount*,
  coding is a *kind* — the slider copy already strains to justify it); a per-message
  mode dropdown (modes-per-message confuses thread identity and transcript
  rendering).

### (d) Patience levels in the end state: **3 levels; Auto is a router, not a level.**

Today's surface is a 2-axis matrix hiding inside one slider: 4 chat levels
(`single_thinking`, `thinking`, `deep_research`, `deep_research_all`) × 2 model sets
(frontier / open_source), with `code` bolted on as notch 5 and `browser_agent` as a
hidden side-mode. Three moves collapse it to the target shape, and they reinforce
each other:

1. **Code comes off the slider** (per (c)) — it is a capability chip, not patience.
2. **Killing frontier is what makes 3 levels coherent.** `deep_research_all` (L4)
   only exists to mean "research across all 6 models (both sets)". With one model
   set left, L4 ≡ L3 — alias `deep_research_all → deep_research` at the controller
   boundary (exactly the normalization pattern already used for retired
   `fast`/`single → single_thinking`, `crossmodel.controller.ts:718`) and drop the
   notch. Old chats keep rendering; `modelSet` metadata on historical messages is
   display-only. Result: **L1 Quick (`single_thinking`), L2 Ensemble (`thinking`,
   the signature multi-model + synthesis mode — stays the default), L3 Deep
   Research (`deep_research`)**.
3. **`browser_agent` becomes a capability too** — it already isn't on the slider
   (controller routes it straight to `runBrowserAgentSession`); in the end state
   the router/agent triggers it, like code.

**Auto is not a 4th level — it is a detent above the levels:** `[Auto ✨ | 1 | 2 | 3]`
(Auto = default for new users). When Auto is on, each message first passes a cheap
router that returns `{level: 1|2|3, capabilities: [code?, browser?]}`; the choice is
shown in the transcript ("Answering with Ensemble") and a manual slider move
overrides Auto per message. This converges with Pillar 1 rather than competing with
it: the router is the *same agent surface* the platform tools expose — "Auto" is
literally the model choosing among the pipelines/capabilities the UI exposes.
Rollout: (i) ship the 3-notch slider + Code chip first (P4); (ii) add Auto with
**heuristic routing** (message length/question-shape → level; repo-intent → code
chip suggestion) — no extra model call, zero latency; (iii) upgrade to a **model
router** (L1 model, short routing prompt, ~100ms, decision emitted in SSE metadata
and callable as a tool) once P1's platform tools exist. Guardrails: bias cheap —
never route to L3 unless the query clearly warrants research; per-tier cost caps;
cache the decision per conversation topic.

---

## Risks & open questions

- **Agent-token abuse / confused-deputy:** a model holding a user's token (or acting
  in-loop) could be prompt-injected into destructive platform ops. Mitigations:
  destructive tools ask-only; scope minimization on minted tokens; `Activity` audit;
  rate limits on the platform REST surface. Consider per-run "platform tool budget".
- **Folder inheritance surprises:** nearest-ancestor memory/doc merging can leak
  sibling-ish context upward if users file sensitive docs high in the tree. Ship P2
  behind a flag and dogfood; document the model plainly in the UI ("contents of
  parent folders are visible here").
- **P5 backfill correctness:** dual-write verification needs a row-count + checksum
  job per chat before read-switch; keep the rollback path (read from
  `coding_messages`) for one release after switch — mirror the original merge's
  blue-green discipline.
- **Kids accounts:** code mode is currently force-blocked for child accounts; the
  Code chip and `code:run` token scope must enforce the same (`rejectChild`
  middleware + UI hide).
- **Naming cutover:** decide the user-facing word ("Folders") in P2 and don't ship
  half-renamed copy; internal Prisma rename (`model Folder`) can land earlier since
  it's invisible.
