# Fleet Supervisor — design

> **STATUS: IMPLEMENTED — 2026-08-03, branch `digby/session-06c1d5b6`.** This was
> the pre-implementation spec, kept as the design record; `> **As built:**`
> asides mark where the implementation differs from the spec. Acceptance e2e:
> `backend/src/modules/crossmodel/platform/fleet-supervisor.e2e.test.ts`; UI:
> `frontend/app/crossmodel/components/FleetPanel.tsx`.
>
> **Evolution** (rewritten 2026-09-14 — Project-supervisor preflight: the
> previous note recorded the per-project model as dead and misattributed
> ticket 3217e287; #741 did not update it, so this record and AGENTS.md
> disagreed):
>
> - **2026-08-04 — per-project model superseded by the GLOBAL Fleet
>   Supervisor.** The first per-project design (#153, migration
>   `20260804000000_project_supervisors`: one `isSupervisor` chat per project,
>   cap 288, 2h sweep, per-chat DIRECT `EventHook`s auto-wired from every
>   project chat, pinned per folder) was replaced the same day by ONE
>   one-per-user Fleet Supervisor chat (`platform/supervisor.service.ts`
>   `ensureFleetSupervisor`, owner-scope wildcard `EventHook`s, migration
>   `20260804120000_global_fleet_supervisor` — which DELETEd the per-project
>   chats). Reason (owner direction): the fleet layer must be invisible
>   infrastructure — a single always-present pinned chat, zero per-chat
>   wiring, near-zero new UI concepts. A 5th consequential tool
>   (`send_to_instance`) was added 2026-08-30 and existing autonomy grants
>   union-healed.
> - **2026-09-14 (ticket 3217e287, #734, `41a46652`) — `supervised` gate.**
>   The lazy auto-provisioning triggers on chat/session creation became GATED
>   on the filing project's `supervised` flag (a chat/session created in an
>   opted-out project no longer scaffolds the FLEET supervisor framework), and
>   the project settings tab (sidebar gear → folder) gained the same
>   supervise toggle as the Management dashboard. This ticket is about
>   `crossmodel_projects.supervised` (fleet coverage), NOT the per-project
>   supervisor flag below — the two flags are independent.
> - **2026-09-14 (#741, `987b1595`) — opt-in per-project supervisors
>   re-introduced as a LAYER UNDER the fleet supervisor, not a replacement.**
>   The Fleet Supervisor stays the single owner-facing surface; a project
>   supervisor is an ordinary chat (`crossmodel_chats.isProjectSupervisor`,
>   title `<project> Supervisor`, mode `thinking`, stock prompt
>   `buildProjectSupervisorPrompt`, `projectSupervisorProfile`: 24 steps / 8
>   delegations / 1M-char context / 45-min deadline) that owns its project's
>   goals/todos, fans work out via `start_coding_session`, and REPORTS UP to
>   the fleet chat via `send_chat_message`. Shipped anatomy
>   (`platform/project-supervisor.service.ts`, migration
>   `20260914000000_project_supervisors`):
>   - **Flag:** `crossmodel_projects.projectSupervisorEnabled` (default
>     `false`; set via `updateProject` from the folder Settings page /
>     Management Dashboard "Supervisor" column / `update_project` tool). The
>     lane is scaffolded only while the flag is true; the 15-min
>     attention-watchdog heals missing lanes and pauses orphaned ones. One
>     supervisor per project is guaranteed by a partial unique index; the
>     P2002 race converges on the winner.
>   - **One project-scope hook:** a single `EventHook` with `sourceChatId`
>     NULL + `projectId` set (fleet event set + `todo_done`, debounce 600 s)
>     matches every chat in the project — zero per-chat wiring, which answers
>     the objection that killed the 2026-08-04 model.
>   - **60-min sweep:** recurring schedule (`intervalSec` 3600, goal-ledger
>     diff with a STUCK-since-when clause) under a full autonomy grant with
>     `scheduleCap` 480/day (hook wakes share that budget; alarm-class events
>     bypass debounce).
>   - **Spawn guard caps** on `start_coding_session` for `isProjectSupervisor`
>     callers only (`platform-tools.ts`, all env-tunable
>     `DIGBY_PROJECT_SUPERVISOR_*`, fail-open on Redis/DB errors): concurrent
>     active workers (default 24), spawns per hour (32), daily spend envelope,
>     storm breaker (12 per 10 min → cooldown key). Measured fan-out before
>     enablement was 2 spawns/parent/hour and 2/project/10 min, so the caps
>     do not bind on observed behaviour.
>   - **Pause-never-delete:** toggling the flag off, archiving the project, or
>     an unowned/missing project disables the hook + schedules and audits
>     `project_supervisor.pause`; nothing is deleted (a 48 h trial is free to
>     reverse). Project delete GCs the detached lane (hooks/schedules off,
>     `isProjectSupervisor` cleared, chat kept).
> - **2026-09-14 corrections (pre-enablement; owner directives: full
>   autonomy, "very very high limits — hardware-bound, not harness-bound",
>   no blocking gate / refusal / owner card on a machine lane's own work,
>   budgets pre-approved):**
>   - `a04d094e` — the spend envelope is OPT-IN:
>     `DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD` defaults to 0 = no check
>     (the shipped $25 default would have refused the first spawn on every
>     main project — trailing-24h project spend was $80–280/day), and the
>     refusal text no longer orders an owner cost card ("Do NOT file an owner
>     card — report the trip to the Fleet Supervisor").
>   - Preflight fixes (2026-09-14 review; landing as one batch with this
>     note before any project is enabled; all observe/route/coalesce — no
>     new refusal or owner card): (1) **fleet feed shed** — when a project has
>     a supervisor, the owner-scope wildcard delivers only alarm-class events
>     for that project (`attention_needed`, `goal_blocked`, `run_failed`,
>     `schedule_disabled`, `schedule_cap_skipped`) and drops
>     `run_completed`/`todo_done`, so the fleet feed SHRINKS when the layer is
>     enabled instead of growing (as shipped it was purely additive: ~+320
>     project wakes/day + 80–160 report-up fleet wakes); (2) a dedicated
>     **`project_supervisor` model role** (default `deepseek-flash`, thinking
>     on) so the fleet chat keeps the owner's `kimi-k3` voice while the layer
>     that spawns and steers runs on a seat that uses tools (the shared
>     `supervisor` seat measured 58% zero-tool machine finals and ~50%
>     unresolvable cited ids); (3) **precedence rule** stated in both prompt
>     bodies behind the same standing-owner-directive header: owner
>     directives > project supervisor inside its project > fleet for
>     cross-project work + owner comms; the fleet never restamps a goal in a
>     supervised project; peer lane-to-lane sends stay DIRECT (32% of lane
>     messaging is cross-project — never route it up through supervisors);
>     the fleet keeps a direct-nudge fallback when a project supervisor has
>     not acted in 2 h; "spend beyond a pre-registered envelope" is deleted
>     from the owner-flag class; (4) **storm breaker observe-only** — the
>     `project_supervisor_breaker` loop_metrics row is written but the spawn
>     is not refused, `MAX_ACTIVE_WORKERS` follows `CODING_WORKER_CONCURRENCY`
>     (the 64 constant is gone — hardware-bound); (5) **no double child
>     hook** — `ensureChildResultHook` is skipped when the parent is a project
>     supervisor (the project-scope hook already covers the child) and the
>     09-13 window-drain digest applies to project-scope hooks so parked
>     events coalesce; (6) **owner surfaces read project supervisor state** —
>     owner briefing, Project Pulse and the watchdog note scan read the
>     `[SUPERVISOR STATE]` of `isProjectSupervisor` chats and run the same
>     observe-only receipt/action verifier, so a stalled or fabricating
>     project supervisor is visible without depending on the fleet chat
>     relaying it.
> - **Rollout / measurement gate (2026-09-14 assessment — the expansion
>   rule):** no flag flips until `a04d094e` is live on both web boxes, the
>   envelope env is UNSET, and the six preflight fixes are merged; caps at the
>   hardware bound (`MAX_ACTIVE_WORKERS` = box C `CODING_WORKER_CONCURRENCY`,
>   24 today; `SPAWNS_PER_HOUR` 200; `STORM_MAX_SPAWNS_10MIN` 60;
>   `STORM_COOLDOWN_SEC` 300; storm trip observe-only). **First project:
>   spark-cluster** (self-contained, highest spend at $145/day, the
>   "86 runs but PULSE said no active goals" incident, the only project
>   emitting `todo_done`) — NOT CanLaw first (its program spans two projects,
>   the case the hierarchy handles worst), NOT crossmodel in the first wave
>   (22 hooks, 80 active chats; the platform/nightly lanes already do this job
>   there). **Measure for 48 h** on `loop_metrics` / `agent_runs` / `run_spend`
>   against the 7-day baseline: children spawned/day + box C slot utilisation
>   (baseline 0–2/day, 12/24 slots — want independent goals running in
>   parallel); event→wake latency on the project hook (want p90 < 10 min);
>   `wake_parked:wake_delivered` on the project chat (fleet baseline ~3:1 to
>   12:1 — want < 2:1); `supervisor_action:(note+noop)` (fleet baseline
>   ~1:25 — want ≥ 1:5); unresolvable-id rate in its notes (baseline ~50% —
>   want < 10%); zero-tool machine finals (58% — want < 20%); fleet supervisor
>   wakes/day (185) must NOT rise; money/approval-class `owner_questions`
>   filed by the lane = 0; owner→leaf directive latency p50 stays < 10 min;
>   spend shifting from serial polling ticks to parallel workers (rising spend
>   is fine, rising spend on no-ops is not; cold-start wakes may cost 2–3× the
>   $0.22 steady state for the first days). **Day 2:** if the action ratio,
>   unresolvable-id rate, zero-tool rate and zero-cards checks pass, enable
>   **CanLaw and canlegal-bench TOGETHER** (a supervisor on each end of the
>   handoff, peer sends staying direct); if they fail, toggle spark-cluster
>   off (pauses, deletes nothing), keep the code, and fix the seat first — a
>   seat result, not a shape result. **Day 4:** tt-rd + CQL LiteLLM Gateway as
>   a pair, same 48 h measurements. **Hold crossmodel** until the platform
>   lane's job and the project supervisor's job are explicitly separated.
>   **Week 2:** if fleet wakes/day fell or held flat across enabled projects,
>   relax the sweep to 120–180 min (the hook is the detection path; the sweep
>   is a ledger diff); if fleet wakes rose, the feed-shed fix is not working —
>   stop expanding until it is.

Goal: let a dedicated "supervisor" chat/project autonomously monitor, nudge, and
dispatch work across the user's other chats/projects, with structured
goals/todos, cross-project dependencies, and event-driven wake-ups — while
preserving the platform's fail-closed security posture.

## 1. Autonomy allowlist (per-chat, owner-granted)

- New model `ChatAutonomy` (`chat_autonomy`): `chatId` (PK == crossmodel_chats.id),
  `userId`, `allowedTools String[]` (⊆ the 4 consequential platform tools:
  `send_chat_message`, `start_coding_session`, `schedule_message`,
  `cancel_schedule`), `scheduleCap Int @default(48)` (max 1440 — MAX_SCHEDULE_CAP in autonomy.service.ts; this doc originally said 288, reconciled 2026-09-09).
- Grant/revoke ONLY via a new consequential platform tool `set_chat_autonomy`
  (user-turn-anchored confirmation, like the other consequential tools — a
  machine-triggered run can never grant itself autonomy; prompt injection can
  register a pending confirmation but never confirm it). Exception (2026-09-11,
  ticket 9341e862 — `selfGrantSubsetVerdict` in autonomy.service): a
  SELF-request that cannot WIDEN the caller's own authority resolves card-free —
  within the Agent-mode-Auto template it is an honest no-op (nothing written);
  a subset/shrink/revoke of an existing stored grant auto-executes. Widening
  requests (new tools, higher cap) still card.
  **Scoped cross-chat delegation exception (ticket eb4337fe, 2026-09-23 —
  ruling oq_2674964f, the Fleet Supervisor answering under the owner's
  standing directives 2026-09-13 "APPROVE BOTH, STOP ASKING ME SO MUCH…" /
  2026-09-12 "CLEAR GATES ALWAYS ON MY BEHALF"):** a SUPERVISOR-CLASS granter
  may grant a supervised lane card-free, via `supervisorDelegationVerdict` +
  `delegateChatAutonomy` (autonomy.service), stamping the row source
  `'machine_delegated'` and auditing action `autonomy.grant.machine_delegated`
  with the granter + target ids. SIX scope guards, ALL fail-closed (any throw/
  read failure → the confirmation card, exactly as before):
  1. Kill switch `AUTONOMY_DELEGATION_DISABLED=1` restores always-card.
  2. Target must be a different, non-empty, RESOLVABLE chat (self is the
     9341e862 path; unresolvable → card).
  3. Granter must be supervisor-class — `isSupervisorChat` (Fleet Supervisor
     `isSupervisor` or a project supervisor `isProjectSupervisor`); a plain
     lane always cards.
  4. SAME OWNER only — the acting user must be the granter chat's owner and
     the target chat's owner; cross-account targets stay carded.
  5. A PROJECT supervisor may delegate only WITHIN its own project
     (`target.projectId === granter.projectId`); the FLEET supervisor may
     reach any same-owner lane.
  6. Requested tools must be a non-empty subset of `AUTONOMY_GRANTABLE_TOOLS`
     AND of the GRANTER'S EFFECTIVE set (the full template for an
     Agent-mode-Auto orchestrator, else its stored grant), and any requested
     `scheduleCap` (clamped 1..1440) must be ≤ the granter's effective cap —
     a raise is a real widening and still cards.
  Motivation: 5 owner confirmation cards in 24h were all redundant
  re-confirmations — 3 supervisor-initiated `set_chat_autonomy` grants to lanes
  they supervise (one left an AWS monitor unable to message peers ~110 min).
  A `machine_delegated` row is treated like a curated row by Agent-mode flips
  (`syncAutonomyWithAgentMode` neither widens nor deletes it), and an empty
  allowedTools list is never routed into the delegated write (an empty array
  is a REVOKE — supervisor delegation only ever GRANTS).
  **Preference-covered recurring digests (same ticket, limb B):** a first-use
  `schedule_message` with kind `recurring` whose prompt matches a stored owner
  digest preference (`UserMemoryFact` — cadence/time signal AND
  delivery/content signal on the preference, plus — reviewer D2 of the
  2026-09-23 adversarial review — a three-rule prompt conjunct: a
  delivery-family keyword in the prompt, ≥2 shared MEANINGFUL keywords
  between prompt and preference (stopwords and digit-leading tokens
  excluded), and intervalMinutes ≥ 60; see `ownerDigestPreferenceCoversDigest`)
  arms DIRECTLY with no
  card, audited with the matched preference key + one
  `preference_digest_armed` loop metric. Kill switch
  `PREFERENCE_DIGEST_GATE_DISABLED=1`. Everything else — kind `once`, no
  preference, no qualifying overlap, a sub-hourly cadence, any read failure —
  stages as before.
- Gate change (`gateConsequentialPlatformTool` in platform/platform-tools.ts):
  when a consequential tool is called WITHOUT a confirmationId AND the run is
  machine-triggered (`ctx.userTurnAt` undefined), look up `ChatAutonomy` for
  `ctx.sessionId` (PK lookup per call → revocation is immediate). If the tool is
  in `allowedTools` → skip the pending-confirmation flow and execute (audit-log
  the autonomous execution). Otherwise fall through to the existing
  register-pending flow (which will correctly deny `no_user_turn` on confirm).
  The gate becomes async. User-turn runs are unchanged (existing confirmation
  flow still applies; autonomy only matters when there is no user turn).

## 2. Schedule daily-cap fix

- `schedule.service.ts`: replace hard-coded `MAX_FIRES_PER_SESSION_PER_DAY = 48`
  with the per-chat `ChatAutonomy.scheduleCap` (default 48, clamped ≤ 1440 — MAX_SCHEDULE_CAP).
- On cap skip: set `CodingSchedule.lastStatus = 'skipped:daily_cap'`, log, and
  emit a `schedule_cap_skipped` hook event (§3) so a supervisor can react.
  Deduped to ONE event per chat per cap window (feedback a30b6ad9, Redis NX
  gate `coding:sched:capevent:<chatId>:<flavor>` with the FIRES_KEY window's
  PTTL): every later identical skip in the same window is muted supervisor-side
  (the in-lane `[SCHEDULER NOTICE]` count + one owner notice per window are
  unchanged). The same gate dedupes the spend-cap skip flavor (24h flat TTL)
  and capped hook-wake drops in hooks.service.
- Early warning (feedback 190d68aa): the first firing that pushes the live
  counter to ≥ ceil(0.8·cap) emits ONE `schedule_cap_skipped` event per window
  with `kind:'warn'` + `{used, cap, threshold}` (same NX gate, `warn` flavor) —
  the supervisor can re-space the lane's interval schedules BEFORE the cap
  trips instead of learning ~48 min after deafness began. Parent-attributed
  firings warn on the parent's counter.

## 3. Event hooks + supervisor wake (durable outbox)

- `EventHook` (`event_hooks`): id, userId, `sourceChatId`, `targetChatId`,
  `eventTypes String[]` (⊆ `run_completed`, `run_failed`, `attention_needed`,
  `goal_blocked`, `todo_done`, `schedule_cap_skipped`, `schedule_disabled`,
  `schedule_near_cap`, `ci_failed`), `promptTemplate`
  (placeholders `{{eventType}}` `{{sourceChatTitle}}` `{{summary}}`; empty =
  default), `enabled`, `debounceSec` (default 60), `lastFiredAt`.
- `HookEvent` (`hook_events`) outbox: id, hookId (FK cascade), userId,
  `eventType`, `payload Json` ({sourceChatId, sourceChatTitle, summary, depth,
  runId?}), `status` (`pending|delivering|delivered|failed`), `attempts`,
  timestamps. Index `[status, createdAt]`.
- Emission (`hooks.service.ts emitHookEvent(sourceChatId, eventType, summary,
  extra?)`): find enabled hooks on sourceChatId subscribed to eventType; insert
  pending rows. Loop prevention: skip when `sourceChatId === targetChatId`;
  payload `depth` (default 0, incremented on wake-delivery); drop when
  `depth >= 3`.

  > **As built:** depth propagates via a Redis stamp, not the payload alone — a
  > wake delivery sets `fleet:hookdepth:<chatId>` = depth+1 (1h TTL); the woken
  > run's own emissions read the stamp, and the run's finalize path
  > (run-executor / chat-agent) clears it after emitting, so the bump applies
  > to exactly one run. Emissions at depth ≥ 3 are dropped.
- Sweep (`sweepHookEvents()`, runs inside the existing 60 s schedule sweeper in
  the web process AND a new sweeper started in the worker): claim pending rows
  (`delivering`; stale `delivering` > 5 min reclaimed), group by hookId,
  respect debounce (fired < debounceSec ago → leave pending to coalesce),
  wake the target chat with the rendered prompt via the same internal
  fire-prompt-into-chat path the schedule sweeper uses (plain chat → chat run;
  code-capable → queued coding run). Busy target → leave pending, attempts++
  (fail after 60 attempts). On success: `delivered`, `lastFiredAt = now`.

  > **As built:** no worker sweeper was added — the web process's existing 60 s
  > schedule sweeper is the SINGLE sweeper (`schedule.service` calls
  > `sweepHookEvents()` via dynamic import on its tick), so there is no
  > cross-process claim race; the worker only EMITS via the DB outbox. Delivery
  > reuses `fireScheduleTarget`, imported STATICALLY from
  > `coding/schedule.service` (the reverse edge — sweeper → hooks.service —
  > stays dynamic).
  >
  > ⚠ **CORRECTION (2026-11-04) — "the worker only EMITS" is true of the
  > untargeted TICK, not of delivery.** `sweepHookEvents`
  > (`platform/hooks.service.ts:3422`) has **no process-role guard** — its only
  > early-out is `isRetiring()` (`:3429`). `emitHookEvent` kicks a **targeted**
  > sweep in the **emitting** process (`:1218` → `deliverHookGroup:2292`, sole
  > call site `:3501` → the `hook_thread_passthrough_observe` metric at `:3208`),
  > and a run-finalize emits through a dynamic `import('../platform/hooks.service')`
  > (`coding/run-executor.ts:3546` for `run_completed`/`run_failed`; `:2708` is
  > the `attention_needed` alarm). So **a run-finalize delivery happens wherever
  > the run executed** — in practice the worker. The single-sweeper claim above
  > still holds for the TICK (worker.ts never registers it), and the claim race
  > is still avoided by the atomic pending→delivering flip plus the debounce
  > `SET NX PX` gate; what changes is only WHO runs the delivery pass. Practical
  > consequence for debugging: a draining box returns at `isRetiring()` before
  > claiming, delivering or writing a metric, so a stale wake row can only come
  > from a box that is neither draining nor post-flip — treat such a row as a
  > stale-emitter artifact, not as a failed routing change.
- Emission points: run finalize (web plain-chat path + worker coding path →
  `run_completed`/`run_failed`), pending-question/approval set
  (`attention_needed`), goal/todo blocked transitions (`goal_blocked`), todo
  done (`todo_done`), schedule cap skip (`schedule_cap_skipped`).

  > **As built:** `attention_needed` is emitted from
  > `coding/session-run-lock.ts` — the single place the pending-presence Redis
  > keys are set (`emitAttentionNeeded`) — threaded there through
  > `publishApprovalPending` / `publishQuestionPending` (approval-registry and
  > question-registry pass an `attentionSummary`). Best-effort: dynamic import,
  > failures swallowed so emission never affects the wait path.

## 4. Goals + todos with cross-project dependencies

- `ProjectGoal` (`project_goals`): id, userId, projectId (FK Cascade), title,
  description, `status` (`active|blocked|done|archived`, default active),
  `blockedReason?`, `createdByChatId?`, timestamps. Indexes `[projectId]`,
  `[userId]`.
- `ProjectTodo` (`project_todos`): id, userId, goalId (FK Cascade), projectId
  (denormalized), title, `status` (`pending|in_progress|blocked|done`),
  `blockedReason?`, `assigneeChatId?`, timestamps. Indexes `[goalId]`,
  `[projectId]`.
- `GoalDependency` (`goal_dependencies`): `@@id([goalId, dependsOnGoalId])`,
  both FK Cascade. `TodoDependency` (`todo_dependencies`): same for todos.
  Dependencies may point at goals/todos in OTHER projects — same-owner enforced
  in the service. Cycle-checked (DFS) on write.

  > **As built:** goal/todo rows are owned by the PROJECT OWNER (`userId =
  > project.userId` — the fleet the goal joins), whoever writes them; access
  > mirrors platform.service's split — READ = owner or any project member
  > (viewers included), WRITE = owner/editor/admin (viewers 403; non-members
  > 404).
- Blocked propagation (`goals.service.ts`): a todo is `blocked` while any
  dependency todo is not `done`; a goal is `blocked` while any dependency goal
  is not `done`. On any status change, dependents recompute recursively;
  auto-unblock when all deps done. Goal auto-completes when all its todos are
  `done` and all goal-deps are `done`. Transitions into `blocked` emit
  `goal_blocked`; todo → `done` emits `todo_done`.

  > **As built:** rows blocked BY THE PROPAGATOR carry a `'[deps]'` prefix on
  > `blockedReason`, and ONLY those auto-unblock once every dependency is done
  > — a manually blocked row (no prefix) is never auto-unblocked. `archived`
  > counts as done for dependency purposes: an archived goal no longer blocks
  > its dependents.

## 5. Agent tools (platform surface) + REST

New platform tools (registered per the platform-tool-names.ts leaf pattern —
names leaf, schemas in PLATFORM_TOOL_SCHEMA, dispatch in executePlatformTool):
- READ: `goal_list` (projectId, includeDescendants?), `todo_list` (goalId |
  projectId), `hook_list`.
- MUTATING: `goal_create`, `goal_update`, `todo_create` (goalId, title,
  dependsOn[], assigneeChatId?), `todo_update` (status, dependsOn, …),
  `hook_subscribe`, `hook_unsubscribe`.

  > **As built (ticket dd3a19fa, 2026-09-20):** the hook tools stay
  > organizational (never confirmation-gated — machine runs can call them),
  > but a MACHINE-triggered `hook_subscribe` now requires an explicit
  > non-empty `promptTemplate`, a NEW wildcard duplicating coverage an
  > existing project-scope/specific hook already provides for the target is
  > REFUSED (a user turn gets a warning), machine-run `hook_update` may not
  > clear a `promptTemplate` to empty, and every hook row carries creator
  > provenance (`createdVia` / `createdByChatId` / `createdByRunId`, exposed
  > by `hook_list`; kill switch `HOOK_MACHINE_GUARD_DISABLED=1`).
- CONSEQUENTIAL (user-turn-only): `set_chat_autonomy` (chatId, allowedTools[],
  scheduleCap?) — empty allowedTools deletes the grant. Two authority-neutral
  card-free resolutions (see §1): the 9341e862 non-widening self-request, and
  the eb4337fe scoped supervisor delegation to a same-owner supervised lane.
- REST (platform router, same auth/ownership patterns): CRUD
  `/platform/goals`, `/platform/todos`, `/platform/hooks`, GET/PUT
  `/platform/chats/:id/autonomy`. (Frontend panel is a follow-up; REST first.)

  > **As built:** `GET /chats/:id/autonomy` returns **404** when no grant
  > exists (grant presence isn't leaked as an empty object). The frontend panel
  > SHIPPED with the feature rather than as a follow-up:
  > `frontend/app/crossmodel/components/FleetPanel.tsx` — one drawer (bottom
  > sheet on mobile, side panel on desktop) with Goals / Hooks / Autonomy tabs,
  > opened from sidebar and folder-row entry points in
  > `frontend/app/crossmodel/page.tsx`.

## 6. Security posture

- Autonomy is opt-in per chat, per tool, granted only in a real user turn;
  revocation takes effect immediately (per-call PK lookup).
- The set_chat_autonomy grant path itself takes NO autonomy bypass — with two
  authority-neutral exceptions (both bounded so the caller can never exceed
  authority it legitimately holds): the 9341e862 non-widening SELF-request,
  and the eb4337fe scoped SUPERVISOR DELEGATION to a same-owner supervised
  lane (tools/cap ⊆ the granter's own effective set; project supervisors
  within their own project only; kill switch `AUTONOMY_DELEGATION_DISABLED=1`;
  rows stamped source 'machine_delegated'). See §1 for the full six-guard
  list and ruling provenance (oq_2674964f).
- All hook wakes and autonomous sends are same-owner only (checked at subscribe
  AND at wake).
- Depth cap + self-hook suppression + debounce bound autonomous loop churn.
- Every autonomous consequential execution is audit-logged (Activity, resource
  'platform') and the wake prompt includes provenance (event type, source chat).

## 7. Migration

One hand-written migration `20260803000000_fleet_supervisor` covering all five
new models (via `prisma migrate diff` per AGENTS.md — no DB in the container).

> **As built:** SEVEN tables — "five" above undercounted (the two dependency
> joins are models too): `chat_autonomy`, `event_hooks`, `hook_events`,
> `project_goals`, `project_todos`, `goal_dependencies`, `todo_dependencies`.
> Prod applies it via `migrate deploy` during the blue-green deploy.

## 8. Value upgrade — goal-diff supervision (2026-09-02)

The original sweep contract ("post a SHORT status note with a compact status
table every 2h") produced full-fleet bulletins regardless of change — the
owner's assessment: real catches buried in re-narration. Replaced with:

- **Goal-ledger diff sweeps** (`buildFleetSweepPrompt`): pull `goal_list` +
  each watched lane's last outcome, diff against the previous sweep note,
  report ONLY deltas (toward-goal with artifact citation / regressed / stuck
  across 2+ sweeps / needs-action). Close with exactly `SWEEP: no-op — nothing
  moved on any project since last sweep` (one goal-framed line, owner directive
  2026-09-13 feedback ed04c9b2) or `ACTIONS TAKEN` (1–3 receipted lines).
  Repetition ban: unchanged state = one line, never a table.
- **Goal-progress note format** (owner directive 2026-09-13, feedback
  ed04c9b2): every owner-facing supervisor note leads with per-PROJECT
  plain-English progress tied to current goals — project name → goal → what
  moved → next → ETA (from goal/todo state; "no ETA yet" when underivable).
  Technical ids/probe output collect into ONE closing `Receipts:` line (the
  evidence rules still apply there); no-change wakes stay one goal-framed
  line (`WAKE: no-op — nothing moved on any project since <time>`), never
  machine refs. Jargon appears only when an owner decision rides on it, with
  a one-line plain-English gloss.
- **Wake economy** (`buildFleetSupervisorPrompt` §Wake economy): no-op hook
  wakes end in one `WAKE: no-op` line; an owner item is raised at most once
  per 6h unless its state changed; identical wake content 3+ times = STUCK →
  one corrective receipted action or one ticket, then stand down.
- **Deterministic stuck detector** (`attention-watchdog.service.ts`
  `scanSupervisorNotes`): Jaccard ≥0.85 on normalized token sets over the
  newest 3 machine-wake notes (ids/digits/chrome stripped) → one `[WATCHDOG]
  act or stand down` nudge per streak (Redis-fingerprint deduped, 7d TTL;
  compliant no-op one-liners exempt).
- **Self-measurement** (`classifySupervisorNote` + watchdog cursor seam):
  every supervisor note is harness-classified into loop_metrics as
  `supervisor_action` / `supervisor_noop` / `supervisor_note` — "is the
  supervisor helping?" is now a query on the admin loop-metrics endpoint
  (actions-with-receipts vs noise, per day).

Both prompt upgrades ride the existing stock-prompt heals, so live
supervisors adopt them on their next ensure. Caveat: the action metric counts
the note before the action verifier strikes unreceipted claims — read it
alongside guard_strike.
