# Session UI Convergence — C0 Drift-Reconciliation Audit

> Tracking: feedback ticket `71b1fec6-54c1-4cbd-ae0d-1f2f5844fd9a` (C0–C3
> implementation queue). Design doc of record:
> `docs/SESSION_UI_CONVERGENCE_DESIGN.md` (merged PR #485, commit `86ffea30`).
> Follow-up lane records: `docs/SESSION_UI_CONVERGENCE_C1_SMOKE.md` (C1),
> `docs/SESSION_UI_CONVERGENCE_C2.md` (C2 — the §4a ports landed as `a6b87d69`;
> the §4b-item-8 attribution gap is PORTED there).
> Audit date: 2026-08-29. Audit base: `origin/main` @ `60b31a8f` (workspace
> snapshot; outbound git fetch is unavailable in the session container, so this
> is the freshest main ref locally — noted for honesty, all 13 candidates
> predate it). **Scope: audit only — no runtime code changed;
> `PLAIN_SESSION_VIEW` remains `false` (verified `page.tsx:311` on the audit
> base).**

## Method (evidence discipline)

1. Seed list: ticket `71b1fec6` + design doc §1 ("The real remaining gap"),
   which enumerates 13 drift-candidate commits across 12 bullets.
2. `git show -s` on every seed sha: **all 13 resolve on main**, commit dates
   2026-08-22 → 2026-08-29 — inside the design doc's drift window
   (2026-08-15 → 2026-08-29). **No seed mismatches.**
3. `git log --since=2026-08-15 --until=2026-08-30` over the session-UI surfaces
   the design doc names (`frontend/app/crossmodel/page.tsx`,
   `frontend/app/crossmodel/plain-session.ts`,
   `frontend/app/crossmodel/components/{CodeSessionView,code-transcript,ChatComposer,WorkspacePanel,MachineWakeBlock,ChatFilesSection,FleetPanel,CanvasPanel}.tsx`,
   `frontend/app/crossmodel/model-display.ts`, plus their `frontend/lib/`
   helpers) to confirm the full set. Plausible additional candidates surfaced
   by that log are accounted for in §3 — none extend the set of 13.
4. Per commit: `git show` (full diff, frontend + backend) for the behavioral
   summary, then current-state greps on the audit base to determine whether the
   behavior already holds in the converged (`CodeSessionView` /
   `code-transcript`) path.

Verdict key — **PORT** = the behavior must carry into the converged view;
**DROP** = superseded/redundant under the convergence design. Where a PORT is
already present in the converged path, the rationale says so explicitly (C1
work = smoke verification, not a re-port).

## 1. The 13 drift candidates — classification table

| # | Commit (sha / PR) | Title | Key files touched | Verdict | Design-doc ref | One-line rationale |
|---|---|---|---|---|---|---|
| 1 | `1b1ce2af` / #477 | Persona display names for models | `model-display.ts` (new shared module + tests), `code-transcript.tsx`, `page.tsx`, `CodeSessionView.tsx`, `account/CodingTab.tsx`, `crossmodel.controller.ts` | **PORT** | §1; D3 | Landed on BOTH transcript paths in one commit (`plainCleanModelId = displayModelName` in code-transcript); D3's "persona names must hold in the code-transcript path" is already satisfied — C1 smoke-verifies (More-info). |
| 2 | `ae3ef713` | Patience picker names the models each level runs | `page.tsx` (`PATIENCE_DESCRIPTIONS` copy) | **PORT** | D4.1; §3 C2 | Copy defined and referenced ONLY in the legacy picker (`PATIENCE_*` live references are page.tsx-only; the sole `components/` mention is a code comment in `FloatingChrome.tsx:190`); must move with the picker into the composer `rightActions` slot — real C2 port work. |
| 3 | `edf3e247` | Collapse inter-agent + system rows everywhere | `frontend/lib/machine-wake.ts` (`classifySystemRow`), `MachineWakeBlock.tsx`, `CodeSessionView.tsx`, `page.tsx`, `SupervisorChatTab.tsx`, `frontend/lib/api/coding.ts` (`plainMeta.origin`), `supervisor.service.ts` | **PORT** | §1; D3 | Already in the unified plain path: CodeSessionView's message loop classifies via `classifySystemRow({metadata: m.plainMeta})`, origin rides `plainMeta` from `mapPlainMessages`; supervisor prompt table-format is surface-agnostic backend copy. |
| 4 | `1bd184ae` / #396 | Machine-wake envelope one-line rows | `frontend/lib/machine-wake.ts`, `MachineWakeBlock.tsx` (new shared component), `page.tsx`, `CodeSessionView.tsx` | **PORT** | §1; D3 | Shared component mounted in BOTH message loops (grep-verified on the audit base) — nothing to re-port; C1 smoke: wake rows collapse in a flipped plain chat. |
| 5 | `590031fb` / #465 | Queued steer echoes below the live block | `CodeSessionView.tsx`, `frontend/lib/queued-echoes.ts` (+tests) | **PORT** | §1; §3 C1.2 | Landed ON the converged view (supersedes #328's at-array-position treatment on the same surface, preserving its always-visibly-echoed invariant) — C1 smoke: queued-message rendering mid-run (a design C1.2 addition), incl. the plain busy-queue echo position. |
| 6 | `42aeabf3` | Queued messages carry attachments | Prisma migration + schema (`pending_chat_messages.uploadIds`), `chat-agent.service.ts`, `message-queue.service.ts`, `platform.service.ts`, `upload.controller.ts`, `CodeSessionView.tsx` (refusal gate removed) | **PORT** | §1; §3 C1.2 | Backend capability is surface-agnostic (stage-on-select, resolve-on-drain); the frontend change is in the unified view's plain send path — carries by construction; C1 smoke: queued message with attachment on a flipped plain chat. |
| 7 | `10199291` / #433 | Prose-fragment grouping around thought rows | `frontend/lib/prose-grouping.ts`, `code-transcript.tsx` (`ProseGroup`, `hideThinking`/`disableGrouping`), `CodeSessionView.tsx` (Hide-thinking pill), `assistant-parts.test.tsx`, `prose-grouping.test.ts` | **PORT** | §1; §3 C0 acceptance | Consumed ONLY via `code-transcript.tsx` (grep-verified) = the converged renderer, with the `assistant-parts.test.tsx`-style unit coverage C0 requires; the #435 rules-of-hooks hotfix is already folded in on main. |
| 8 | `96b0da27` / #375 | Per-message timestamps in the coding view | `CodeSessionView.tsx`, `frontend/lib/format-message-time.ts` (new) | **PORT** | §1; D3 | Scope verified via `git show`: coding-view rows only (desktop hover corner stamps + mobile always-visible, user+assistant, null-guarded; live-stream block timestamp-free); page.tsx keeps its own copy (`page.tsx:1166`) until C3 deletes the legacy view. |
| 9 | `d181b391` / #382 | Per-chat Files panel sections | `ChatFilesSection.tsx` (new + tests), `CodeSessionView.tsx`, `page.tsx`, `frontend/lib/api/crossmodel.ts`, `generated-files.controller.ts` | **PORT** | §1; D1 | `ChatFilesSection` mounted in BOTH the session-view WorkspacePanel and the page-level panel (grep-verified); C2 re-keys it in the section registry, the page-level mount dies in C3 — no behavior port. |
| 10 | `75b7c548` | Chat-side persistent FleetPanel (Phase D) | `FleetPanel.tsx` (new + tests), `frontend/lib/fleet-panel.ts`, `frontend/lib/api/platform.ts`, `page.tsx` | **PORT** | §1; D1 | Mounted ONLY in the page-level WorkspacePanel arrays (desktop aside + mobile drawer, isKid-gated; grep-verified NOT in CodeSessionView) — data-agnostic component; C2 mounts it via the section registry for both session kinds (real port work, no rewrite). |
| 11 | `2cb3018d` / #434 | Composer placeholder truth per session status | `CodeSessionView.tsx` | **PORT** | §1; D4 | Placeholder is a `ChatComposer` prop driven per status (incl. the `plain ?` branch) — already in the converged composer path; C1 smoke only. |
| 12 | `97af2895` / #436 | Sends to a running-but-detached session steer immediately | `CodeSessionView.tsx` | **PORT** | §1; D4 | Steer-now + resync instead of swallow-on-reconnect lives in the unified composer send path; codified as `routeSend` → `'steer-reroute'` by #454's composer-guard. |
| 13 | `20ca951e` / #454 | Unwedge composer after steer-409 on a stale running flag | `frontend/lib/composer-guard.ts` (new `routeSend` decision table + tests), `frontend/lib/api/coding.ts` (`STEER_TIMEOUT_MS`), `CodeSessionView.tsx` | **PORT** | §1; D4 | The one-time `bypassRunningGuard` escape + finite steer timeout live in the converged view + shared API lib; pure decision table with regression tests. |

**Result: 13 × PORT, 0 × DROP.** The two-week drift is materially smaller than
the ticket framing feared: **11 of 13 candidates already hold in the converged
view** (landed there directly, on both sides at once, or in surface-agnostic
backend/shared-component layers). Only #2 (patience naming) and #10 (FleetPanel
mount) are absent from the converged path, and both are C2-shaped work (composer
slot wiring; panel section registry) that the design already schedules. No
candidate is DROP: every listed behavior is one the converged view must have;
the legacy-side renderings some of them replaced (e.g. #328's chronological
queued echoes, legacy hover timestamps) die with the legacy view in C3 **by
construction** and were never in the candidate set.

## 2. Per-commit behavioral summaries (evidence)

1. **`1b1ce2af` (#477, 2026-08-28)** — Replaces vendor model names with personas
   (kimi=Digby, glm=The Professor, deepseek=The Logician, openai=The Veteran,
   grok=The Maverick, gemini=The Scholar, qwen-vl=The Scout, utility=The
   Helper) via ONE shared `displayModelName()` normalizer (Fireworks paths,
   legacy aliases, backend labels; unknown ids → "AI Agent", never a raw vendor
   string). Diff evidence: `code-transcript.tsx` imports `displayModelName`
   (`plainCleanModelId = displayModelName`, `PLAIN_MODEL_LABELS` → personas);
   `page.tsx` −76/+… uses the same module; backend `modelLabels` fallbacks and
   coding-model picker copy updated. Current state: `model-display` consumers =
   `code-transcript.tsx` + `page.tsx` (grep on the audit base).
2. **`ae3ef713` (2026-08-29)** — Copy-only: `PATIENCE_DESCRIPTIONS` now names
   the actual orchestration (L1 Kimi K3 full-tool agent; L2 Kimi K3 + DeepSeek
   V4 parallel cross-check with Kimi synthesis; L3 Kimi-led council with
   GLM-5.2 + DeepSeek V4 Pro). Current state: `PATIENCE_SHORT` /
   `PATIENCE_DESCRIPTIONS` defined and referenced only in `page.tsx` (legacy
   picker at `page.tsx:5848, 7752–7772`); the only `components/` mention is a
   code comment (`FloatingChrome.tsx:190`) — the unified view has no patience
   picker UI yet (design D4.1's open work item).
3. **`edf3e247` (2026-08-28)** — Extends wake collapsing to ALL machine rows:
   `classifySystemRow()` → 'wake'|'agent'|'system'|null; `MachineWakeBlock`
   gains kind/origin ("⚙ Machine wake" / "⇄ Agent message" / "⚙ System
   message"); SupervisorChatTab classifies via backend origin stamps;
   supervisor prompt gains a table-form status-note contract + generalized
   stock-prompt heal. Unified-path evidence: CodeSessionView's loop calls
   `classifySystemRow({role, content, metadata: m.plainMeta})` and this commit
   adds `origin`/`sourceChatId` to `PlainMessageMeta` so `mapPlainMessages`
   carries the stamps. Conservative classifier: absent/'user'/unknown origin ⇒
   human, always visible (collapse-never-filter discipline from the 2026-08-26
   regression).
4. **`1bd184ae` (#396, 2026-08-26)** — Machine-wake envelopes (`[MACHINE-
   TRIGGERED RUN` preamble rows) render as one-line expandable system rows
   (collapsed: truncated summary; expanded: full payload verbatim in a `<pre>`,
   never Markdown). Presentation-only; persistence untouched. Current state:
   `MachineWakeBlock` imported by `CodeSessionView.tsx`, `page.tsx`,
   `SupervisorChatTab.tsx` (grep on the audit base) — both transcript paths.
5. **`590031fb` (#465, 2026-08-28)** — Partitions pending steer/queue echoes
   out of the persisted history (`partitionQueuedEchoes`) and renders them
   in-flow AFTER the live run block, just above the composer, with the "Queued"
   caption + always-visible send time. Fixes "queued messages appear very high
   up" (the live block grows thousands of px; array-position echoes landed at
   its top edge). Explicitly preserves #328's core invariant (the echo is
   ALWAYS visibly echoed; the messages array stays the chronological record and
   the server row takes its true slot on run-complete).
6. **`42aeabf3` (2026-08-22)** — `pending_chat_messages.uploadIds` persists
   staged `/crossmodel/upload` ids with a queued message (Redis blob TTL
   stretched to 24h); `drainChatQueue` resolves them exactly like an immediate
   send (userImages/documentText/attachmentMeta) with honest expiry annotation;
   coding steer inlines extracted text. Frontend: CodeSessionView's plain-path
   refusal gate ("queued messages can't carry attachments yet") removed — the
   chips ride the echo bubble, the drain resolves the blobs. Both busy-409s
   removed. Backend is surface-agnostic ⇒ both UIs inherit the capability.
7. **`10199291` (#433, 2026-08-27)** — Interleaved-thinking models (kimi-k3)
   stream T,R,T,R… deltas; the trailing-same-kind merge fragments live prose
   around "Thought process" rows. `groupProseParts()` (pure, byte-lossless
   `join('')`) groups runs with ≥2 text fragments + ≥1 reasoning part into one
   flowing markdown block + compact "N thoughts" chip (expandable, arrival
   order) + raw-order toggle; tools/subagents/images break runs.
   `AssistantParts` gains `hideThinking`/`disableGrouping`; CodeSessionView adds
   the "Hide thinking" pill. Reasoning is not persisted (stored transcripts
   already coalesce) — targets live/replay render. Current state:
   `prose-grouping` consumed only by `code-transcript.tsx` (grep).
8. **`96b0da27` (#375, 2026-08-25)** — Exact scope verified via `git show`:
   adds `formatMessageTime()` (deliberate mirror of page.tsx's, kept out of the
   hot file) and timestamp spans on CodeSessionView transcript rows — desktop
   hover-revealed corner stamps (under-right for user, top-right for assistant,
   same placement as the chat UI) + always-visible `sm:hidden` spans on mobile;
   null-guarded; the in-flight live block stays timestamp-free. Does NOT touch
   page.tsx (legacy keeps its own `formatMessageTime` at `page.tsx:1166` — that
   copy dies with the legacy view in C3). The same `timeLabel` now also feeds
   the MachineWakeBlock rows (#396/#4959bb1c integration).
9. **`d181b391` (#382, 2026-08-25)** — New `ChatFilesSection` (per-chat uploads
   via ChatFile + agent-generated docs; preview/download with refresh key)
   mounted in BOTH the page-level WorkspacePanel (`page.tsx`) and
   CodeSessionView's panel; backend `generated-files` listing widened. Shipped
   with the review-driven XSS gate: html/svg uploads render Download-only
   (blob re-serve strips the CSP sandbox header). Current state: mounts in
   `CodeSessionView.tsx` + `page.tsx` (grep).
10. **`75b7c548` (2026-08-27)** — New `FleetPanel` + pure `fleet-panel.ts`
    helpers: per-chat status rows (attention > running > idle), live goals with
    todo progress, upcoming schedule firings — three existing owner-scoped
    GETs, 30s poll with in-flight guard, last-good data on refresh failure,
    per-section error notes; global quiet state when idle. Mounted in page.tsx's
    two page-level WorkspacePanel arrays (desktop aside + mobile drawer) behind
    the isKid gate. Zero backend changes. Current state: NO mount in
    CodeSessionView (grep) — design D1's end state wants `fleet` ✓ both session
    kinds (non-kid), so the registry mount is C2 work.
11. **`2cb3018d` (#434, 2026-08-27)** — Composer placeholder maps each session
    status honestly: running → "Steer the run…"; ready → "Describe what to
    build or fix…"; status running-but-detached → "Run in progress —
    attaching… your message steers it"; error → "Workspace setup hit an error —
    send a message to retry…"; otherwise "Setting up the workspace — you can
    type; it sends when ready…" (was: every non-ready status read "Waiting for
    the worktree…", including errored sessions). The `plain ?` branch strings
    are part of the same prop — the converged composer covers plain mode.
12. **`97af2895` (#436, 2026-08-27)** — A send to a session that is running
    SERVER-side but detached locally now resyncs AND steers immediately
    (previously: reconnect toast, message swallowed — the owner "smash enter"
    bug); steer guard widened from `live.running` to `live.running ||
    status === 'running'`. Unified composer path only.
13. **`20ca951e` (#454, 2026-08-28)** — New pure `routeSend` decision table
    (`frontend/lib/composer-guard.ts`) with ONE explicit escape:
    `bypassRunningGuard`, legitimate only immediately after a
    server-authoritative steer-409 — reconcile (close dead ES, clear running
    state), then send as a fresh run instead of looping steer → 409 → send →
    silent-skip forever. `steerRun` POST gains `STEER_TIMEOUT_MS` (30s) so a
    hung POST can no longer wedge `steering` forever. Draft cleared after the
    bypassed send (double-send review fix). 10 composer-guard regression tests
    (8 `routeSend` decision-table + 2 `classifySteerFailure` cases) + 3
    steer-timeout tests = 13 total.

## 3. Git-log cross-check — notable in-window surface commits NOT in the 13

`git log` over the surfaces shows ~50 landings in the window; the 13 candidates
are the transcript/composer-rendering divergences between the two
implementations. The closest calls, reviewed and excluded:

| Commit | Title | Why excluded from the candidate set |
|---|---|---|
| `6794481e` / #328 | Render queued/steer messages at chronological position | The PREDECESSOR treatment on the SAME unified surface (CodeSessionView-only); superseded within the window by `590031fb` (#465), which preserves its always-visibly-echoed invariant. No independent port — covered by candidate 5. |
| `06f49fa3` / #435 | Move hideThinking hooks above early returns | Rules-of-hooks hotfix to #433's regression — same behavior as candidate 7; any port re-implements from current main, which already contains it. |
| `58ffcf86` | Shared-project chats — author attribution on messages | Backend (author stamp through context/crossmodel services) + legacy-side bubble rendering in `page.tsx` (42 lines). Backend is surface-agnostic; the legacy bubble treatment is not in the design's 13. **Open question for C1:** verify `mapPlainMessages`/`plainMeta` carries author attribution for shared-project plain chats under the flip — recommended as a C1 smoke addition. |
| `780f2769` / #369 | Re-attach banner to transcript tail + server chat.running gate | Legacy-chat attach chrome (page.tsx-only), not transcript-content rendering; the converged view has its own attach/resync flow (`resyncActive`, candidate 12/13 machinery). |
| `c23030b6` | Desktop send transition + user hover timestamp placement | Legacy-side user-bubble polish; superseded in the converged view by candidate 8's unified timestamps. Dies with the legacy view in C3. |
| `dcff68a7` / #413 | Close residual file:-scheme link gaps | Shared `file-link-card.tsx` component (`components/ui/`) + profile/shared pages — surface-agnostic, no per-view divergence. |
| (classes) | Loader hats (`e0ee4910`, `cfbe431f`), deep search (`ed5c453d`), mic/send UX (`da50378d`, `7110b5de`, `7546191a`), tailnet dev-container (`976e52f0`, `441b51ac`, `5d21866f`, `fa24e849`, `63f52aca`), chat titles (`74a02a04`, `26385762`), calendar labels (#478), starter questions (`209ddb5b`), integrity/fleet waves, merges | Either shared components, backend/ops, or single-surface behavior outside the two-transcript divergence the C0 audit covers. |

## 4. C1 readiness — the PORT work queue

Design §3 phases C1 (the flip, owner-gated) and C2 (panel + composer slot
convergence). From the 13 PORT verdicts, the work splits into two real ports
and eleven smoke-verifications.

### 4a. Real port work (absent from the converged path today)

| Queue item | From candidate | Design ref | Phase |
|---|---|---|---|
| Wire the patience picker into the unified view's composer `rightActions` slot, carrying the per-level model-naming copy (`PATIENCE_DESCRIPTIONS` / `PATIENCE_SHORT` / `AUTO_DESCRIPTION`) | `ae3ef713` | D4.1; §3 C2 | C2 (before the C1 smoke can cover design §3 C1.2's "patience-level model naming" addition — order dependency) |
| Mount `FleetPanel` through the WorkspacePanel section registry for BOTH session kinds (non-kid gate), retiring the page-level mount with the legacy view | `75b7c548` | D1; §3 C2 | C2 |

### 4b. Already in the converged view — C1 smoke-verification queue

Mapped to the owner-account prod smoke (design §3 C1.2, ONE_SESSION_PLATFORM.md
:180–185 + the three late-drift additions):

1. **Persona names in More-info / per-model responses** (`1b1ce2af`) — design
   C1.2 addition "persona names in More-info"; also modelUsed badges, Sources
   pills, coding-model picker, and the no-vendor-strings invariant
   (`model-display.test.ts` pins it).
2. **Queued-message rendering mid-run** (`590031fb` + `42aeabf3`) — design C1.2
   addition; cover (a) steer echo lands below the live block with Queued caption
   + send time, (b) a queued message WITH an attachment drains and resolves the
   blobs on a flipped plain chat, (c) plain busy-queue echo position.
3. **Machine/system row collapsing** (`1bd184ae` + `edf3e247`) — wake envelopes,
   inter-agent relays, and system rows collapse to one-liners in a flipped
   plain chat; expand shows the verbatim payload; no human message ever
   collapses (absent-origin discipline).
4. **Prose grouping + Hide-thinking pill** (`10199291`) — interleaved T/R live
   stream renders as one flowing block + "N thoughts" chip; raw-order toggle
   works; persisted plain transcripts render via `AssistantParts` grouping.
5. **Per-message timestamps** (`96b0da27`) — desktop hover stamps + mobile
   always-visible on flipped plain rows (both roles); none on the live block.
6. **Files section** (`d181b391`) — uploads + generated docs list in the flipped
   view's panel; html/svg rows stay Download-only.
7. **Composer truth + send routing** (`2cb3018d`, `97af2895`, `20ca951e`) —
   per-status placeholders on a flipped plain chat; steer-to-detached and
   steer-409 bypass paths (coding sessions exercise these directly; plain mode
   rides the same composer state machine).
8. **Cross-check follow-up** (§3): shared-project author attribution on flipped
   plain chats (`58ffcf86` backend stamps vs `mapPlainMessages`) — confirm or
   file as a C2 gap.

### 4c. C0 acceptance mapping (design §3)

- *"A checked-off parity table appended to this doc"* — §1 of this audit is the
  checked-off parity table (13/13 verdicts with evidence); it lives in its own
  doc per the C0 lane's charter, linked from here for the C1 lane to fold back
  or reference.
- *"`assistant-parts.test.tsx`-style unit coverage for any ported rendering"* —
  no rendering was re-ported in C0 (audit-only phase); the 11 already-converged
  behaviors carry their own pins (`model-display.test.ts`,
  `machine-wake.test.ts`, `queued-echoes.test.ts`, `prose-grouping.test.ts` +
  `assistant-parts.test.tsx`, `composer-guard.test.ts`,
  `ChatFilesSection.test.tsx`, `FleetPanel.test.tsx`). The 4a ports must add
  coverage when they land in C2.
- *"The flag still OFF"* — verified: `PLAIN_SESSION_VIEW = false`
  (`page.tsx:311` on the audit base `60b31a8f`).

---

## 5. C3 status (2026-08-29, branch `digby/fw29-c3`) — flag removed; transcript deletion BLOCKED

C3's first work item is done: the `PLAIN_SESSION_VIEW` compile-time flag is
**removed** (folded in as permanently true at all four gate sites in
`page.tsx`; zero references remain in `frontend/`). The unified view is now the
non-optional surface for every plain chat a signed-in adult opens from the
sidebar; rollback is a git revert, no longer a one-line toggle.

**The legacy in-page transcript was NOT deleted.** Reachability tracing on
current main shows the design's premise ("the legacy path is dead once the
flip lands") does not hold — four independent consumers keep it live:

1. **New-chat sends (every signed-in user).** The home screen renders in the
   legacy branch (`codeChatId === null`), and `handleSendMessageInner` streams
   the whole conversation through the legacy transcript — nothing sets
   `codeChatId`/`codeChatPlain` on the send path, and `CodeSessionView`'s
   `initialMessage` auto-start requires a coding satellite
   (`activeSession.status === 'ready'`, CodeSessionView.tsx ~1509) that plain
   mode never has. A chat only lands in the unified view when re-opened via
   `loadChat`. **Unblock:** a create-then-hand-off (create chat → mount the
   view with the message; plain-mode auto-start support in the view).
2. **Anonymous/guest chats.** They stream via the Redis `sessionId` with no
   chat row; `CodeSessionView` is keyed on a required `chatId` (transcript GET,
   stream/attach URLs). **Unblock:** a chatId-less plain mode (significant),
   or a product decision to require sign-in.
3. **Kid accounts.** `loadChat` still routes kids to the legacy view (D5: they
   flip only after kid rails — ad slot, content guard, kid status lines — are
   verified in the unified view), and kids hit blocker 1 for new chats too.
4. **Page-level WorkspacePanel + `canvasWidth` resize are not legacy-only.**
   `CodeSessionView` gates its in-view panel with `{!plain}` (~:2471), so the
   page-level mounts (desktop aside + mobile drawer) are the ONLY workspace
   panel for plain-in-unified chats. They cannot die until the plain sections
   (canvas state, files, fleet — all page-owned) mount inside the view.

Consequently every "dies in C3" item (legacy bubbles, hover timestamps,
`AgentSteps` at page.tsx ~7099, re-attach banner, `canvasWidth`, page-level
panel mounts, duplicated strip helpers) is still referenced by a live path and
stays. Deletion order when the blockers close: (1) new-chat hand-off, (2) plain
sections into the view's panel, (3) kid flip after rails verify, (4) anonymous
decision — then the transcript block deletes in one pass.

### 5a. Unblock status (2026-08-29, branch `digby/fw29-c3-unblock`) — blockers 1–3 BUILT

Blockers 1 (new-chat create-then-hand-off), 2 (plain panel sections in the
unified view), and 3 (kid flip, rails honored) are implemented on
`digby/fw29-c3-unblock`:

1. **New-chat hand-off** — `handleSendMessageInner` (page.tsx): a home-screen
   send by a signed-in user (kids included) creates the chat row first
   (`crossModelApi.createChat`, same placeholder-title shape), then mounts
   `CodeSessionView` in plain mode with the message as `initialMessage`
   (`''` = attachment-only; staged attachments carry via
   `plain.takeAttachments`; `initialDisplayContent` carries news-follow-up
   display text). The view's plain auto-start fires once the initial
   transcript GET settles (`plainLoaded`) with no live run — no coding
   satellite required. Anonymous sends are untouched (legacy path).
2. **Plain panel in-view** — `CodeSessionView` mounts its workspace panel for
   BOTH session kinds; plain sections arrive page-built through the
   workspace-sections registry via `plain.panelSections`, open state stays
   page-owned (`plain.panelOpen` = `canvasPanelOpen`). The page-level
   aside/drawer mounts render only when `!codeChatId`. FloatingChrome's
   variant is `'chat'` for plain-in-unified (restores the workspace toggle +
   mobile patience; the coding menu showed a permanent "Loading session…").
3. **Kid flip** — `loadChat` flips kids into the unified plain view. Rails:
   PatiencePicker renders nothing for kids (pinned); ThinkingAd `!isKid` in
   the view; Report-issue now adult-only in `PlainMessageActions` (pinned);
   Fleet withheld by the registry (pinned); kid web-search cue ported; kid
   status lines restored by forwarding `progress` in `makeLegacyNormalizer`
   (pinned); content guard is backend-side (surface-agnostic).

**Residual legacy consumers for the deletion pass:** anonymous/guest chats
(blocker record item 2 — unchanged, needs the product decision); the home
screen itself (empty-state + composer render in the legacy branch); the
deep-link fallback for a chat NOT in the sidebar's first page (page.tsx
initial-load effect maps messages inline instead of flipping — convert to a
loadChat call carrying `codeCapable`); `handleSendMessageInner`'s legacy
streaming machinery (now the anonymous + createChat-failure path);
`loadChat`'s legacy tail (unreachable, kept behind an always-true `chat.id`
guard so tsc keeps type-checking it); the page-level panel mounts +
`canvasWidth` (home/legacy-only now); `AgentSteps`, legacy bubbles, hover
timestamps, re-attach banner, duplicated strip helpers.

### 5b. C3 deletion pass (2026-08-29, branch `digby/fw29-c3-delete`) — legacy transcript reduced to its two living consumers; C3 CLOSED

With §5a's blockers 1–3 merged, the deletion pass removed every part of the
legacy plain-chat transcript that reachability tracing proved dead, and
recorded what SURVIVES and why. `page.tsx` went from **8,514 → 7,426 lines**
(−1,088). tsc: zero new errors vs the pristine-HEAD baseline (sorted diff
clean); vitest: 19 files / 328 tests green, **no tests deleted** (nothing
pinned the deleted paths — page.tsx has no test file).

**DELETED (with proof-of-deadness):**

1. **`loadChat`'s legacy tail** (§5a item 5) — the always-true `if (chat.id)`
   guard is unwrapped and everything after it is gone: the bg-state restore
   branches, the paged DB transcript fetch into the legacy view, its canvas/
   patience/project-context sync. Proof: `chat.id` is always truthy, so the
   tail was unreachable on every call.
2. **Deep-link fallback** (§5a item 3) — the initial-load not-in-sidebar path
   no longer inline-maps messages into the legacy view; it fetches a minimal
   row (`messageLimit: 1`) carrying `codeCapable` and opens it through
   `loadChat`, exactly like `handleOpenSearchResult`.
3. **Re-attach banner + its server-truth pruning effect +
   `currentChatRunning`** — the banner's gate needs `currentChatId`, which
   anonymous chats never have; every signed-in stored chat now opens in the
   unified view (which owns attach/re-attach). Also unblocked deleting the
   `messages.length === 0 && !showReattachBanner` term on the empty state.
4. **Idle-chat liveness watch** (`IDLE_CHAT_RUN_WATCH_MS`) — reconciled runs
   started elsewhere into an OPEN legacy chat; that chat class is extinct
   (gate: `user && currentChatId && !codeChatId`, reachable only inside the
   createChat-failure fallback, where degraded no-live-reconcile is accepted).
5. **"Load earlier" paging apparatus** — `hasMoreMessages`,
   `messagesBeforeCursor`, `loadingEarlier`, `loadEarlierMessages`, the
   IntersectionObserver sentinel, the prepend scroll-restore
   (`useLayoutEffect`), `chatPrependRef`/`prependScrollRef`, the index-shift
   block, and the render block. Proof: after 1–4, nothing ever set a non-null
   cursor — anonymous transcripts live purely in client state (no DB fetch);
   the drain watcher's refetch deliberately no longer re-seeds paging.
6. **bg-chat snapshot machinery** — `bgChatStateRef` + `fgStreamStateRef` and
   every write site (loadChat/startNewChat/startNewChatInProject moves; the
   chunk/ask-user/complete/error background else-branches in the send stream).
   Proof: the only reads were loadChat's restore branches (item 1).
   `bgEventSourcesRef` SURVIVES — the ES handoff (background move, queued/
   complete/error cleanup, `onStreamClaim`) still uses it.
7. **`AgentSteps` in the legacy transcript + `StreamMessage.parts`** — parts
   only ever entered legacy messages via stored-row mapping
   (`mapStoredMessages` / the attach-pipe finish); the live anonymous SSE
   pipeline never emits them. Anonymous never renders parts → deleted (import,
   render, field, mappings).
8. **Per-message feedback UI + `handleFeedbackSubmit`** (panel gated on
   `currentChatId`), **Check-for-Errors / `handleFactCheck`** (gated
   `user && currentChatId`), **admin More-info model panel + `ModelCard` +
   `MODEL_ROLES` + `inferModelSet` + `modelInfoOpenIndex`** (gated `isAdmin`)
   — all authed-only; signed-in chats no longer render here. The unified
   view's `PlainMessageActions` owns Report-issue.
9. **Shared-project teammate rendering** — `isTeammateMessage`, the violet
   tint, the "From:" footnote, and `authorId`/`authorName` on `StreamMessage`
   + `mapStoredMessages`. Proof: author stamps only arrive on stored rows;
   the sole remaining stored-row path (drain watcher) serves only fallback
   chats the viewer authored.
10. **Kid web-search cue** in the legacy transcript — kids are signed-in and
    always land in the unified view (home-screen hand-off + loadChat flip);
    the cue was ported there in §5a item 3.
11. **Dead-weight sweep** — `thinkingSummaries` (write-only even before this
    pass), `cleanModelId` alias, the duplicated local `formatMessageTime`
    (replaced by the shared `@/lib/format-message-time` import), the `stage`
    local in the progress branch, `isSynthesizing` (its last readers were the
    deleted snapshots), and now-unused imports (`AgentSteps`, `MessagePart`,
    `feedbackApi`, `factCheckApi`, `FeedbackReason`, `useLayoutEffect`,
    `ThumbsDown`, `AlertCircle`, `Brain`, `Zap`). ESLint unused-var warnings
    on page.tsx are now a strict subset of the pristine baseline.

**SURVIVES (load-bearing — verified against the code, not assumed):**

- **Anonymous/guest chats** (§5a item 2 — product decision recorded: anonymous
  convergence is OUT OF SCOPE for C3; they keep the legacy transcript). Kept
  fully functional: `handleSendMessageInner`'s streaming machinery end-to-end
  (SSE URL build incl. large-message register, silence watchdog, onerror
  recovery, parse-error salvage), user/assistant bubbles + markdown +
  timestamps (hover + swipe-reveal), the streaming card with live model
  timings + agent-activity feed + routing line + ThinkingAd (still
  `!isKid`-gated — COPPA), sources pills, follow-ups, email confirm card,
  **canvas cards + page-level WorkspacePanel mounts + `canvasWidth` resize**
  (the SSE canvas handler explicitly supports anonymous tempIds),
  **attachments** (`/crossmodel/upload` is open-posture; cm_session),
  Copy/Read-aloud actions, the local queued-message flow, the ask_user card
  (`chatId: null` is an explicit anonymous state), and the composer.
- **Home screen** (§5a item 2): the `codeChatId === null` branch stays — the
  greeting/weather header, Daily Briefing, calendar, starter questions, and
  composer render in the legacy branch for signed-in users with no open chat.
- **The createChat-failure fallback — KEPT (as §5a shaped it), noted:** a
  home-screen send whose `createChat` fails falls through to the legacy path
  (which retries the create). In that degraded state a signed-in user chats on
  the legacy transcript until they reopen the chat (which flips it into the
  unified view). Consciously degraded there: no re-attach banner, no idle
  reconcile, no per-message feedback/More-info, no parts rendering. The
  server-queued cluster (SSE 'queued' handler, inline caption, badge, drain
  watcher + `mapStoredMessages`) is KEPT because it completes that fallback's
  send contract ("your message runs automatically") — it is the sole remaining
  `mapStoredMessages` consumer.
- The recovery limbs of the send machinery (`attachAgentRunIfLive`,
  `recoverUnansweredExchange`, the foreground-recovery effect,
  `isChatRunActive`) — wired into the kept send closure's watchdog/onerror
  paths.
- Everything the unified view consumes via props/refs from page.tsx
  (`plain.*` parity props, `pagePanelSections`, PatiencePicker wiring,
  FloatingChrome, `handleCodeRunning`/`handleCodeTitle`/
  `handleCodeInitialConsumed`, `onStreamClaim`).

**C3 is closed.** The remaining legacy surface is exactly: anonymous chats +
the home screen + the noted createChat-failure fallback. Any future anonymous
convergence (a chatId-less plain mode in `CodeSessionView`, or requiring
sign-in) is a new product decision, not C3 residue.

---

*Produced by the C0 drift-reconciliation lane (Digby Code session branch
`digby/session-4f918389`), 2026-08-29. Every sha, line reference, and grep
claim above was produced by a fresh `git`/`grep` invocation against the audit
base in that session. §5 added by the C3 lane (`digby/fw29-c3`), same date;
§5a added by the C3 unblock lane (`digby/fw29-c3-unblock`), same date; §5b
added by the C3 deletion lane (`digby/fw29-c3-delete`), same date.*
