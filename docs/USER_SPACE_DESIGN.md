# User Space — every chat is one session (P3 design)

Status: **SHIPPED 2026-09-02** (commit `7220d13d`; deploy run 33643736840; live-verified on
digby.ai: auto-filing on chat create, one blank user-space per owner, capability flags,
manual + router attach, tier split on a plain question). P3a (transitional rename) was
skipped as moot — the gesture retired directly. The backfill runner
(`backend/src/scripts/backfill-user-space.ts`, dry-run default) has NOT been run on prod —
pre-P3 ungrouped chats stay unfiled until it is (an ec2-ops decision). Remaining open
questions in §8 (provider 'blank' vs 'local', live flip signal, router precision).

Builds on P5-B (capability-not-mode),
the in-place conversion endpoint (`POST /chats/:id/coding`, shipped 2026-08-31), and the
one-session vision in `docs/ONE_SESSION_PLATFORM.md` Part 3.

## 1. The idea

Today a chat is workspace-capable only if a human deliberately puts it in a workspace
folder or converts it. This inverts that: **every user gets ONE hidden, personal
"user-space" project, and every chat they create is filed into it by default.** Since the
user-space project is workspace-capable, **every chat is code-capable from birth** — the
system (router or agent) attaches the `ChatCodingState` satellite the moment a task
actually needs a workspace, lazily and invisibly. "Plain chat" vs "coding session" stops
being a user-facing distinction; there are only chats, some of which have picked up a
workspace along the way.

Deliberately NOT part of this (rejected in discussion):
- **One shared worktree per user** — per-session worktrees are the isolation boundary that
  lets concurrent runs not share a git index; a universal worktree is a global
  serialization point with broken Push/PR semantics and an ACL hole (shared-project
  members could read the owner's universal filesystem). Per-chat satellites/worktrees stay.
- **Merging the execution tiers** — the interactive chat pipeline (seconds) and the
  durable worker (minutes-hours) are both features (`ONE_SESSION_PLATFORM.md`: "D → B;
  never merge the two execution tiers").

## 2. The user-space project

New marker on `crossmodel_projects`:

```sql
ALTER TABLE "crossmodel_projects" ADD COLUMN "isUserSpace" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "crossmodel_projects_one_userspace_per_owner"
    ON "crossmodel_projects" ("userId") WHERE "isUserSpace";
```

- Column-add precedent: `20260829133000_project_supervised_flag`. Partial-unique precedent:
  `20260804120000_global_fleet_supervisor` (Prisma can't express partial indexes — DB-only,
  same as the supervisor's).
- One per user, ensured lazily via the `ensureFleetSupervisor` pattern
  (`platform/supervisor.service.ts:557-640`): find-first → heal drift → create with P2002
  convergence → never throw (a hiccup must not fail the triggering request).
- **Personal forever**: `isPublic=false`, no members, sharing endpoints refuse it (guard on
  `isUserSpace`), it never appears in the folder tree, Move-to-Folder pickers, or project
  pages (frontend filters, §5).
- **`supervised: true`** (integration finding 2026-09-02): `false` would deafen
  wildcard-hook emission (`hooks.service.ts:252`), delivery re-check (`:516`) and the
  attention watchdog (`:360-361`) for every auto-filed chat — most of the owner's fleet.
  Digests + the fleet overview stay clean because their mappings key on `isUserSpace`,
  not `supervised`.
- **Provider decision (open question, §8)**: `'blank'` works today for per-session
  worktrees but is legacy — `ensureProvisioned` 409s it, no `workspaceAt`, no knowledge
  branch (`commitKnowledge` refuses blank, `project-workspace.service.ts:308`). `'local'`
  likely gives the full vision (platform-managed repo → knowledge branch = the user's
  universal, git-backed memory store that RAG already indexes). Decide in implementation;
  v1 can ship with `'blank'` and upgrade.
- **Kids**: a kid's user-space project is created with `repoProvider = NULL` (plain).
  Non-negotiable: `streamChatRun` 403s kid + codeCapable (`crossmodel.controller.ts:294`),
  and the kid interactive pipeline deliberately bypasses coding (`:971`). A capable folder
  would break their chat attach and open a platform-path hole (§6.4).
- The existing user-visible blank "Coding" folders stay as normal folders (no migration of
  their content; new auto-filing targets the user space instead).

## 3. Auto-filing (creation + moves + backfill)

Chat creation paths that must default `projectId` to the user's space when null:

| Path | Today | Change |
|---|---|---|
| `crossmodel.service.ts:64` createChat | null allowed | resolve user space when `projectId` null (skip for kids? no — file them too, their space is plain) |
| `platform.service.ts:278` createChat (REST + tool + home composer) | null | inherits the service default |
| `context.service.ts:652` `migrateSessionToChat` (guest claim) | null | file into user space |
| ~~`feed.service.ts:281` createFeed~~ | — | retired with the feed subsystem (2026-10-20, ticket 43c24152) — feed chats are ordinary chats now |
| `supervisor.service.ts:600` ensureFleetSupervisor | deliberately null | **exempt** — the supervisor is globally ungrouped by design; its heal at :581-586 keeps it so |
| `coding-data.service.ts:186` createCodingChat / `projects.controller.ts:460` | already filed | unchanged |

Move rules (`crossmodel.service.ts:713-716`): the plain-chat disconnect-to-null path goes
away — "move out of folder" becomes "move to user space" (the frontend's "No folder
(ungrouped)" option maps to it). The coding-chat null 400 already exists and stays.

Backfill: idempotent runner script (pattern: `backend/src/scripts/reconcile-coding-unify.ts`)
— for each user: ensure user space, then `UPDATE crossmodel_chats SET "projectId" = <space>
WHERE "projectId" IS NULL AND "isSupervisor" = false` (the `feed IS NULL` predicate went
with the feed subsystem, 2026-10-20, ticket 43c24152; supervisor stays per the live schema).
Prod runs it once post-deploy; new chats never need it.

Fleet digest: the 'Ungrouped' bucket (`fleet.service.ts:1118`,
`project-digest.service.ts:658`, unique key `project_digests_userId_ungrouped_key`) maps
user-space chats into the same bucket — the digest surface doesn't change.

## 4. Escalation — the system, not the user

**THE ROUTING RULE (load-bearing, supersedes P5-B folder semantics):** the coding
pipeline (view AND sends) keys off the **satellite** (`hasWorkspaceState`), never off
folder capability (`codeCapable`). Capability now means exactly one thing: *attachable on
demand.* Without this rule, auto-filing every chat into a capable project would route
EVERY message — including "what's the weather" — to the durable worker, merging the tiers
this design explicitly keeps separate.

- Sends (both `streamQuery` and `sendChatMessage`): coding pipeline iff a satellite
  exists; otherwise the plain pipeline. The old lazy-attach-on-any-send-to-a-capable-chat
  is REMOVED from `sendChatMessage` (replaced by the router-gated attach below, evaluated
  first); `streamCapabilityRun` keeps its lazy attach purely as a backstop for callers
  that already chose the coding entry.
- Semantics change vs P5-B: a satellite-less chat sitting in a workspace folder (a moved
  plain chat) no longer auto-runs coding on every send — it escalates on demand via the
  triggers below. Deliberately-created chats in workspace projects
  (`startCodingChatFromComposer`/`startNewChatInProject`) still get a satellite AT BIRTH
  via `createCodingChat`, so "new chat in a repo folder" stays always-coding.
- Attach triggers (all owner-only, all non-kid): the send-time router (4a), the agent's
  `attach_workspace` tool (4b), the manual ⋯-menu "Attach a workspace" (§6.3) — all three
  converge on the same satellite-attach primitive.

### 4a. Send-time (router-driven)

`routeMessageHeuristic` (`platform/auto-router.ts:93-126`) is pure regex, zero-latency, and
ALREADY computes `suggestCode` with `hasWorkspace` inputs — it just has no consumer. Add a
`needsWorkspace` outcome and consume it at the two send seams, BEFORE the satellite check
of the Routing Rule:

- `crossmodel.controller.ts:962-984` (interactive SSE): when it fires (owner only, non-kid,
  no satellite yet), `ensureChatWorkspaceState` → the satellite branch then routes THIS
  message to `streamCapabilityRun`; lazy attach inside becomes a no-op.
- `platform.service.ts:633-641` (sendChatMessage): same, so agent-sent and scheduled
  messages escalate too (fireScheduleTarget already checks `chat.codingState`).

Attach cost on a false positive: one `provisioning` row, no disk, no container (worktree
provisions only on the first coding-profile send; the reaper flips stuck `provisioning` →
`ready` after 20 min — `run-reaper.ts:71-92`). Reversible in effect: the chat just gains a
dormant satellite.

### 4b. Mid-run (agent-driven)

New platform tool `attach_workspace` (registered in `PLATFORM_TOOL_SCHEMA`,
`platform-tools.ts:76`; dispatched to `convertChatToCoding`). **Non-consequential** —
attaching is cheap, owner-scoped (runs execute with the chat owner's identity, so the
service's `chat.userId !== userId` check passes), reversible-in-effect; shape follows
`flag_owner_question` rather than `set_chat_autonomy`.

Hard rule (concurrency): **attach, don't fire.** A plain run holds only the chat-busy Redis
claim while a coding run gates on `chatCodingState.status` — firing a coding run mid-plain-
run writes two lanes to one transcript. The tool attaches and the NEXT send/wake routes to
the coding harness automatically (`fireScheduleTarget` checks `chat.codingState`,
`schedule.service.ts:705-762`; `sendChatMessage` checks the satellite per the Routing Rule).
The agent tells the user the workspace is ready in its own answer.

### 4c. Guards

- **Owner-only everywhere**: the interactive route requires owner (`:975`);
  `streamCapabilityRun` 403s non-owners (`coding-stream.controller.ts:433`);
  `convertChatToCoding` owner-checks. Non-owner members of shared-project chats keep plain
  sends (today's behavior — see the divergence note below).
- **Kids**: kid user-space is plain (§2), so kid chats are never capable; ALSO close the
  existing gap that `sendChatMessage`'s coding branch has no `isChild` check (defense in
  depth — today only reachable via REST on an already-capable chat).
- Shared-project divergence (pre-existing, document don't fix here): `sendChatMessage`
  coding runs are owner-only, while the interactive stream lets members run the plain
  pipeline on a capable chat. Auto-filing never touches shared-project chats (they're
  already filed), so this doesn't widen.

## 5. The view — satellite decides, not capability

**This is the load-bearing frontend change — the view half of the Routing Rule (§4).**
Today `loadChat` mounts the coding view on `codeCapable` (`page.tsx:1353`); after
auto-filing EVERY chat is capable, and a satellite-less capable chat mounted as coding
404s (`getSessionForUser` → the "Could not open this coding chat" lie at
`CodeSessionView.tsx:2244`). New rule:

```
hasWorkspaceState (satellite exists)  → coding flavor (view + sends)
anything else                         → plain flavor (view + sends)
```

- `codeCapable` keeps one job: "attachable" — it gates ONLY the attach triggers (router,
  tool, menu item, convert endpoint), never the pipeline. View AND sends key off
  `hasWorkspaceState`.
- Carry `hasWorkspaceState` through the three minimal-row builders (`page.tsx:1273, 1423,
  1461`) and the two optimistic session rows (`:1604, :2178`); server list rows already
  include it.
- The mount key `${chatId}:${plain|coding}` (2026-08-31) already supports the same-chat
  flip when the system attaches mid-session.
- **Open chat, system attaches elsewhere**: needs a live signal — SSE event on the chat
  stream or piggyback the 8s/60s running-ids poll (`page.tsx:1118`). Small design point (§8);
  until then a stale open chat simply flips on next load. (2026-10-27 update: the
  delete/archive path now clears the view live via `dropDeletedChatFromView` — see
  `frontend/app/crossmodel/deleted-chat-stale-view.test.tsx` — including the files panel.)
- Satellite-less 404 copy becomes honest: "no workspace yet" instead of "may have been
  archived or deleted".

**Sidebar**: chats filed in the hidden project must render as today's "ungrouped" section —
otherwise they vanish (neither folder tree nor ungrouped matches). Extend the ungrouped
filter (`page.tsx:2419`) to treat the user-space project id as null; hide the project from
`visibleProjects`/pickers via the DTO marker (fleetHidden-style filtering precedent at
`:735, :1203-1208`). The sidebar looks EXACTLY as today.

## 6. UI end-state — "Code session" disappears

### 6.1 The ⋯ menu: one menu, capability-conditional

Collapse FloatingChrome's chat/coding `variant` into one menu (`page.tsx:2703` computation
and the prop die): chat block always (New chat, Patience, Autonomy…, Side panel, guest
CTAs); workspace block (branch/status label, Push branch, Open PR, Agent mode, New session
in folder) renders when `codeChrome` is non-null — which already means "satellite present"
(`CodeSessionView.tsx:1825-1837` returns null otherwise). Pin to rewrite:
`inplace-conversion.test.tsx:68-72`.

### 6.2 The gesture retires (footprint)

- `handleCodeChip` (`page.tsx:1712-1757`), `convertChatToCoding` (`:1652-1705`),
  `launchCodeSession`/`startCodingChatFromComposer` (`:1580-1643`), `codeDestPicker` +
  dialog (`:629-633, :4426-4472`), `onCodeSession` in FloatingChrome AND PatiencePicker,
  `CODE_CHIP_TOAST_KEY` + effect (`:142, :872-884`), orphan comment `:143`.
- `resolveBlankCodingProject` survives only if the transition phase still needs it (§7).
- `crossModelApi.convertToCoding` + the endpoint STAY — they're the system primitive.
- Tests: `inplace-conversion.test.tsx` retires/rewrites; `c3-legacy-retirement.test.tsx:77-79`
  key pin survives while the flavor key exists.

### 6.3 What replaces the concept for users

- **Nothing, mostly.** Send a message; if it needs a workspace the thread just gains one
  (router or agent attaches; the view flips on `hasWorkspaceState`).
- **One power-user escape hatch (recommended):** a single ⋯-menu item — "Attach a
  workspace" — visible when the open chat has none. No composer item, no picker (every chat
  is already filed), one click, uses the same endpoint. This covers router under-firing
  without resurrecting the "Code session" concept. (Owner decision: keep this or go fully
  automatic.)
- **Workspace indicator**: a thread-level chip (composer `topContent`, mirroring the home
  breadcrumb at `page.tsx:3955-3969`) and/or a sidebar badge beside the schedule icon
  (`:3081-3083`), keyed on `hasWorkspaceState` — so "this thread has a workspace" is visible
  without opening the menu.
- **Naming sweep** (full inventory gathered 2026-09-01): menu items (`FloatingChrome.tsx:212`,
  `PatiencePicker.tsx:102`), toasts (`page.tsx:881, 1626, 1696-1697, 1717`), dialog
  (`:4432-4468`), `CodeSessionView.tsx:2244`, project-page "New coding chat"
  (`projects/[id]/page.tsx:614` → the project page just gets "New chat", which today already
  creates a workspace chat there), projects-page icon to `hasWorkspaceState` (`:429`).
  Account/management surfaces (CodingTab, AgentTokensTab, DashboardTab) keep the word
  "coding" where it names the WORKER capability (Settings → Coding stays — that tab
  configures the coding model/permission defaults).

### 6.4 Kid gates (restated, load-bearing)

Kid user-space is plain (`repoProvider` NULL) so kid chats are never codeCapable:
`streamChatRun` never 403s their attach (`crossmodel.controller.ts:294`), the kid pipeline
keeps bypassing coding (`:971`), and the new `isChild` guard in `sendChatMessage`'s coding
branch closes the REST gap.

## 7. Phasing

- **P3a — transitional wording (cheap, independent):** rename the existing menu item
  "Code session" → "Switch to coding session" in `FloatingChrome.tsx:212` +
  `PatiencePicker.tsx:102` (+ toast `:1717`). Keeps yesterday's convert gesture honest
  while the rest lands. Optional but trivial.
- **P3b — backend foundation:** `isUserSpace` migration + partial unique index; ensure
  service (supervisor pattern; kid variant plain); auto-filing in createChat +
  migrateSessionToChat; move-rule change (null → user space); backfill runner; digest
  mapping; `sendChatMessage` kid guard.
- **P3c — view truth:** `hasWorkspaceState` mount rule + row plumbing; sidebar hidden-
  project rendering; honest satellite-less copy; workspace indicator chip/badge.
- **P3d — system escalation:** router `needsWorkspace` + both send seams; `attach_workspace`
  platform tool (union-heal into `AUTONOMY_GRANTABLE_TOOLS`? — NO: it is NOT a
  grant-gated consequential tool; it registers as a normal platform tool); live flip signal
  for the open chat (or defer to next-load).
- **P3e — concept retirement:** §6.2 sweep, merged ⋯ menu, naming sweep, test rewrites,
  help-KB sync (`frontend/content/help` copies via `npm run sync-help-docs`).

Each phase ships green independently (the verify chain: backend tsc + lint both + full jest
+ frontend vitest + `openapi:generate`).

## 8. Open questions

1. **Provider for the user space**: `'blank'` (works now, legacy, no knowledge branch) vs
   `'local'` (knowledge branch = user-universal git memory; verify `ensureProvisioned`
   semantics for `'local'` first). Leaning: v1 `'blank'`, upgrade path in a later migration.
2. **Live flip signal** for an open chat when the system attaches elsewhere (new SSE event
   type vs poll diff). Cheapest honest v1: flip on next load; nicer: piggyback the
   running-ids poll.
3. **Router precision**: regex `needsWorkspace` will over/under-fire at the margins; the
   "Attach a workspace" menu item is the under-fire escape hatch; over-fire costs one
   dormant row. Tune `CODE_INTENT` regexes (`auto-router.ts:55-62`) with prod samples before
   enabling the auto-attach (can ship P3d with the tool only, router dark-launched logging
   `needsWorkspace` without acting).
4. ~~Feed/supervisor predicates in the backfill~~ — resolved with the feeds retirement
   (2026-10-20, ticket 43c24152): the feed predicate is gone; supervisor (`isSupervisor`) is
   confirmed against the live schema.
5. AGENTS.md's "supervisor pins as a dedicated row at the TOP of the sidebar" is stale
   (code hides fleet chats instead, `page.tsx:420-423, 1198-1211`) — fix the doc when P3c
   touches the sidebar.

## 9. Non-goals

- Shared/per-user universal worktree or always-on containers (§1).
- Execution-tier merge (fast pipeline vs durable worker stays).
- Patience ↔ permission-mode control unification (separate increment; the merged ⋯ menu in
  §6.1 keeps them as separate blocks for now).
- Guests (no chats, no filing, untouched) and the iMessage/MCP/edge surfaces (they ride the
  same REST paths; auto-filing covers them via createChat, no per-surface work).
