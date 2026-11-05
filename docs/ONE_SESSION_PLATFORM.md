# One-Session Platform — Fleet Supervisor v2 + Chat/Coding Unification Roadmap

> **STATUS 2026-08-31: P1 shipped; P2 shipped AND flag-flipped
> (PLAIN_SESSION_VIEW removed — CodeSessionView is the only session view);
> Part 2's goal achieved differently — the supervisor stayed a plain chat, the
> durable blackboard shipped as a supervisor_states DB row +
> update_supervisor_state platform tool (2026-08-22), not a worktree file; P3
> transcript merge (coding_messages) still pending. Part 1 is a pre-P1
> snapshot.**

> Status: **active execution plan** (owner directive 2026-08-11: "analyze moving
> everything into the coding session framework… make Digby SOTA… GO").
> Builds on `DIGBY_PLATFORM_UNIFICATION_PLAN.md` (Options 1–3), the "Unifying Chat
> and Coding Interfaces" research chat (2922e8f6: verdict **D → B, never C**), and a
> fresh root-cause audit of the Fleet Supervisor's hallucination failures.
> Related: `FLEET_SUPERVISOR_DESIGN.md`, `pain-points-audit-2026-08-07.md`.

---

## Part 1 — Why the plain-chat Fleet Supervisor hallucinates (root causes, evidence)

Observed failures (supervisor chat `0ff9996f…`, transcript 2026-08-10/11):

1. **Phantom "PR #188 needs merge"** repeated in every "Needs you" list for 4+ hours;
   repo had zero open PRs, #188 never existed.
2. **Stale owner-asks fossilized**: "AUTO flip + grant card", "add node-2 to tailscale"
   kept surfacing after the owner had already done them (directives were embedded in
   monitor prompts; node-2 was proven in use).
3. **Clock fabrication** (ticket `7739f1d8`): reported a 06:33Z firing as "landed" at
   05:39Z — 54 min before it could happen.
4. **Misreported TB2.1 as "complete"** at 01:59Z; self-corrected 40 min later.
5. **Acted on truncated event digests** ("8/15" vs real "7/15"; "0 result.json files"
   was mid-finalize, not data loss) — hook summaries truncate mid-word (ticket
   `62799318`).
6. **Frozen-prompt incident** (2026-08-10, ticket `566e1c5f`): a stale "PARKED" sweep
   prompt made it cancel Tenstorrent's monitor twice → 6h unwatched gap.

Code-level mechanisms (each verified in source):

| # | Mechanism | Evidence |
|---|---|---|
| R1 | **Context amputation** — chat runs see only the last **8 messages** (`chat-agent.service.ts:831` `slice(-8)`), each assistant note hard-truncated to **2400 chars** (`chat-context.ts:99-145`). The supervisor's prior status notes — its only state — are mutilated before re-ingestion. | `chat-agent.service.ts:831`, `chat-context.ts:99-145` |
| R2 | **Tool history invisible** — context loads only `role`+`content` (`context.service.ts:87-108`); `metadata`/`parts` are never selected, so prior runs' tool calls/results don't exist for the next run. It cannot see *what it already verified*. | `context.service.ts:87-108` |
| R3 | **No durable scratchpad** — plain chats have no worktree/files. Coding sessions keep `supervision_notes.md`-style files and re-read them each run; the supervisor can only reconstruct from a mutilated transcript. | — (architectural) |
| R4 | **No plan / self-audit / verify in the chat tier** — `update_plan`, the deterministic `<plan>` re-injection, the harness self-audit, and the verify chain exist only in the coding profile (`planReminders: false` for chat). Nothing forces "re-verify fresh before claiming." | `agent-profiles.ts` (`chatProfile` vs `CODING_PROFILE`) |
| R5 | **Noise injected into every wake** — B1 always-on web SERP (`chat-agent.service.ts:~494-504`) treats a fleet-event payload as a web question; thinking-mode L2 cross-checker burns up to 420s producing a glm draft on the *event text*, which the supervisor then litigates ("Cross-check vs glm" in every note) instead of pulling fresh state. | `chat-agent.service.ts`, `CROSS_CHECK_SOFT/HARD_MS` |
| R6 | **Latency budgets hostile to autonomy** — chat profile: `maxSteps 8`, `runDeadlineMs 480s`, `workspaceTools: false`. A real sweep needs 15-40 tool calls; the supervisor routinely runs out of steps mid-verification and answers from fragments. | `agent-profiles.ts` (`chatProfile`) |
| R7 | **Memory pipeline tuned for consumer chat** — thread-state extraction is debounced (every 2nd turn; full extraction every 6th/12th; skipped for <30-char messages), so wake-run outcomes are learned late or never; the supervisor is ungrouped (`projectId: null`) → no project-state block at all. | `memory.graph.ts:1132-1167`, `supervisor.service.ts:172` |
| R8 | **Wake carries no ground truth** — the wake prompt is the event digest + a one-line instruction; no current time, no freshness contract. The model reconstructs times/state from stale context (→ R1) instead of being forced to pull. | `hooks.service.ts:64-68` (`DEFAULT_PROMPT_TEMPLATE`) |
| R9 | **Stale sweep prompt** — recurring-schedule prompts were frozen at creation until `update_schedule` shipped (2026-08-11); prompt now carries standing sections, but the tier's other limits remain. | fixed: `schedule.service.ts` |

**Synthesis:** autonomy failures here are *structural*, not model quality. The coding
tier already solved every one of R1–R8 (200 steps, no deadline, worktree files,
plan + self-audit + verify, platform tools). The fix is not a better plain-chat
supervisor — it is **moving the supervisor onto the coding tier** (Part 2) and then
**erasing the tier distinction entirely** (Part 3).

---

## Part 2 — Fleet Supervisor v2: a coding-tier session (P0, this session)

Design decisions (grounded in Part 1 + research chats):

- **New coding session** in the Digby project (`e5734bd2`), `permissionMode: auto`,
  model default. Its worktree gives it a durable scratchpad; the coding harness gives
  it plan/audit/verify; platform tools are all available to coding runs.
- **Blackboard state file**: `.digby/session/fleet-state.md` (git-ignored scratch
  area, survives across runs) — the supervisor rewrites it every sweep: fleet table,
  monitors, caps, open owner-asks (each with first-surfaced date → TTL), KPIs.
  This is the Voyager/MemGPT pattern: state lives in a file the agent owns, not in
  transcript memory. **Never cite fleet state from memory — pull fresh or read the
  state file's own "last verified" timestamps.**
- **Freshness contract** (in its standing prompt): every factual claim in a status
  note must come from a tool call made *this run*; times come only from tool output;
  if an event digest looks truncated or surprising, read the source chat before
  reporting.
- **Owner-report style** (owner directive 2026-08-11): high-level plain English;
  every "needs you" item carries *project + why it matters to the goal + a
  recommendation*. No raw IDs/timestamps unless asked.
- **Wiring**: wildcard hook (all 7 event types — `schedule_disabled` joined 2026-08-24 — 3600s debounce since the supervisor-window widening; this doc originally said 6/600s) re-pointed to v2;
  120-min sweep schedule recreated on v2; autonomy grant
  (`send_chat_message`, `start_coding_session`, `schedule_message`,
  `cancel_schedule`, `update_schedule`, cap 288/day) staged for owner confirm.
- **Cutover discipline**: the legacy supervisor keeps its hook + sweep until v2 is
  granted and has fired once — then legacy wiring is retired (no dual supervisors),
  legacy chat renamed `(legacy)` and kept for history.

---

## Part 3 — One-session unification roadmap (the end-state)

Vision (unchanged from `DIGBY_PLATFORM_UNIFICATION_PLAN.md` pillar 3): **one thread
model where "coding" is a capability a thread escalates into** — every chat is a
session; sessions scale from "quick question" to "hardcore long-running coding with
fleet supervision" without the user changing apps. SOTA consensus (OpenAI agent
mode, Anthropic Cowork, Copilot/Cursor): one session surface, capability modes,
isolated execution per session. Per the research verdict: **D → B; never merge the
two execution tiers** (interactive fast-path vs durable worker are both features).

Already done (One-Digby merge + P1 generalization): one `CrossModelChat` identity +
`ChatCodingState` satellite; one agent loop (`runCodingAgent` under profiles);
platform tools on both profiles; schedules fire any chat; nested folders; hooks.

### Phase P1 — Chat-tier hallucination hardening (THIS SESSION, ships with this doc)
Small, bounded fixes benefiting every plain chat + any future plain-chat automation:
1. **Machine-wake freshness header** — `startDetachedChatRun` prepends
   current-UTC time + a freshness contract to the prompt (attacks R3/R8, ticket
   `7739f1d8`).
2. **Skip SERP + L2 cross-checkers on hook wakes** — fleet payloads aren't web
   questions; removes noise/latency/cost (attacks R5). Hook deliveries pass a flag
   through `fireScheduleTarget`; interactive and plain scheduled runs unchanged.
3. **Deeper machine-run history** — detached runs get `slice(-24)` instead of `-8`
   (they aren't latency-bound; attacks R1).
4. **Word-boundary hook-digest truncation** with an explicit `…[truncated — read the
   source chat]` marker (ticket `62799318`; attacks the "8/15" class).

### Phase P2 — One surface (NEXT session-sized chunk, ~1 week)
Frontend-led, per Option 2 pillar 3:
1. Single composer: `CodeSessionView` composer and the plain composer merge into one
   `ChatComposer`; the "Code" chip becomes the escalation gesture.
2. Unified stream attach: `/chats/:id/stream` serves both run types (live-runs
   already half-converged); old endpoints 308.
3. Remove the `mode='code'` guard refusal (`page.tsx:~3951`) — a plain chat can
   **escalate to coding** in place (attach a `ChatCodingState` satellite to the
   existing chat row; backend endpoint + migration-safe defaults).
   **SHIPPED 2026-08-31:** `POST /api/crossmodel/chats/:id/coding` converts an
   open plain chat in place (owner-only, optional folder move first); the "Code
   session" menu gesture on an open chat converts it with full history — the
   home composer still creates a new session. Same release unified the right
   side panel (one page-owned open state, one "Side panel" ⋯-menu toggle, one
   WorkspacePanel close X for every session kind).
4. Patience slider loses the "Coding" notch; sessions render one transcript with
   `parts` (rich tool rendering becomes universal, not coding-only).

### Phase P3 — User space: every chat is one session (DESIGN 2026-09-01)

Full design: **`docs/USER_SPACE_DESIGN.md`**. A hidden per-user "user-space" project
(`isUserSpace` marker, one per owner, kids get a plain variant) becomes the default filing
for every chat — so every chat is workspace-capable from birth and the SYSTEM (router at
send time, or the agent via an `attach_workspace` tool) attaches the satellite when a task
earns it. The view mounts coding flavor on `hasWorkspaceState` (satellite), not
`codeCapable`; "Code session" as a user-facing concept retires (one ⋯-menu "Attach a
workspace" power gesture remains the escape hatch); the ⋯ menu merges to one variant with
capability-conditional workspace chrome. Phased P3a→P3e in the doc.

**P2 increment 1 — SHIPPED 2026-08-14 (chat 2922e8f6, flagged OFF):** plain-chat
mode for `CodeSessionView`. A plain chat renders in the realtime coding-session
view with ZERO backend changes: transcript loads via `crossModelApi.getChat` and
maps into `CodingMessage` rows (persisted `parts` render via `AssistantParts`);
sends ride the legacy chat SSE (`GET /crossmodel/stream`, large-message
`/stream/register` mirrored); the legacy event vocabulary is normalized into
coding events per-connection by `frontend/app/crossmodel/plain-session.ts`
(`chunk→text`, `thinking-summary/agent-activity→reasoning/tool_call/tool_result/
subagent_*`, `ask-user→ask_user`, `chat-title→session_title`, payload-less
`complete`→synthesized `finalText` from the accumulated stream — without that
the view appended an empty bubble). Coding-only chrome is gated (workspace
panel, branch/publish chrome, vision paperclip, steer, plan); ask_user answers +
stop route through the page's endpoints; canvas events forward to the page's
panel. Flip: `PLAIN_SESSION_VIEW` in `frontend/app/crossmodel/page.tsx` (~:260)
— kids stay on the legacy view either way.

Known gaps to close before the flip (in priority order):
> Status 2026-08-14: PR #217 (`62db53cf`) shipped the CODING-session side of
> attach (drag-drop + always-open paperclip, text/code inlining) and removed the
> Models tab — the plain-mode gaps below are untouched; the flag stays OFF.
> Status 2026-08-15 (increment 2): all six gaps below are CLOSED — plain
> attachments ride `PlainSessionProps.takeAttachments`/`attachmentsBar`/
> `onAttachFiles` (bar state stays in the page; the view renders it into the
> composer topContent slot); busy-queue passthrough hands send-while-running to
> the server queue over a THROWAWAY EventSource (the live stream is never
> clobbered) with a post-`complete` liveness drain-attach; the More-info panel,
> email confirm card, Sources pills and Suggested-next chips are ported into
> `code-transcript.tsx` (metadata rides `CodingMessage.plainMeta` via
> `mapPlainMessages`); `resyncActive` re-attaches a dead plain stream via
> `GET /crossmodel/agent/active` liveness (and plain attaches now use the plain
> stream URL — increment 1 wrongly rode the coding one); bg-ES handoff claims
> the stream via `onStreamClaim` (the page closes its pipe, and
> `attachAgentRunIfLive` never opens a competing one) while the reconcile poll
> prunes plain generating-marks against the liveness truth. The flag stays OFF
> — the flip is owner-gated on the prod smoke below.

1. ~~**Plain attachments**~~ — CLOSED (increment 2): page-owned bar wired
   through `takeAttachments` + the composer topContent slot; paperclip/drop/
   paste route to the page's `processFiles`; echoes render chips/thumbnails.
2. ~~**Busy-queue passthrough**~~ — CLOSED (increment 2): send-while-running
   queues server-side via a throwaway connection (`queued` ack + position
   toast); the echo is captioned "Queued" until the turn ends; a liveness
   drain-check attaches the drained follow-up run.
3. ~~**More-info panel** (per-model responses + sources) and the **email
   confirm card**~~ — CLOSED (increment 2): both ported into
   `code-transcript.tsx` (email card is self-sufficient: fetches Google
   accounts + sends via `googleApi`; cc/bcc micro-fix vs the legacy card).
4. ~~**Follow-up suggestions** ("Suggested next" chips from message
   metadata)~~ — CLOSED (increment 2): `PlainFollowUps` fills the composer
   (never auto-sends), hidden while a run is live.
5. ~~**Focus re-attach**~~ — CLOSED (increment 2): plain `resyncActive` probes
   liveness and re-attaches a dead stream (or drops stale live state when the
   run finished while away).
6. ~~**bg-ES handoff**~~ — CLOSED (increment 2): the view claims the stream
   (`onStreamClaim` → the page closes its agent-attach/backgrounded pipe);
   `attachAgentRunIfLive` skips the view-owned chat; the reconcile poll prunes
   plain generating-marks via the liveness endpoint (a run that ends while its
   view is unmounted no longer spins the sidebar dot forever).

Smoke plan (prod, claudebot@digby.ai, after flip): open a plain chat with
history (renders, Load-earlier hidden page); send a thinking-mode question
(reasoning + tool parts stream live; answer persists across reload); attach to
a scheduled/detached run mid-flight (`attachOnLoad`); ask_user round-trip
(fleet supervisor questions); stop button; canvas creation opens the panel;
chat switch mid-run (sidebar dot honest, no orphaned page ES).

### Phase P3 — One transcript (data convergence, ~1 week + migration)
1. Dual-write: chat pipeline writes `parts` on `CrossModelMessage` (field exists).
2. Read-path convergence: both UIs read one shape.
3. Backfill `CodingMessage → CrossModelMessage`; drop the second table
   (physical rename migration while data is already moving — per Option 3).

### Phase P4 — Capability model + rename (the "remove the chat UI" step)
1. "Sessions" replaces "chats"/"coding sessions" in UI copy; sidebar unifies.
2. Workspace resolution generalizes: folder-chain workspace lookup (exists) + a
   per-user home folder so ungrouped sessions can touch files without project
   ceremony (research Option D — shared data plane, isolated execution plane;
   guardrails: per-chat cwd subdir, read-only default, lazy attach).
3. `docs/DIGBY_PLATFORM_UNIFICATION_PLAN.md` Option 3 remainder: platform REST API +
   `digby-mcp` per-user JWT pass-through (three transports over one service).

### Explicit non-goals
- **No execution-tier merge** (research verdict "C never"): interactive fast-path and
  durable worker tier stay separate.
- **No new guardrails** (owner directive): autonomy friction stays at the existing
  confirmation-card model; this plan removes stale bookkeeping, not owner control.
- Legacy chat data is never deleted; renames are Prisma-level first, physical later.

### KPIs (how we know it worked)
- Supervisor stale-claim rate: owner-visible corrections per week → target 0.
- Supervisor wake→report latency and % of claims backed by a same-run tool call.
- % of sessions created as one type that never need the other UI.
- Chat-tier machine-run SERP/checker spend after P1 (expect ~100% reduction on wakes).
