# Session UI Convergence — Plain Chat on the Coding-Session Look

> Status: **design accepted for implementation queue** (feedback ticket
> `1b0c44bd`, owner request `4550ee11`: *"I thought it should all look like
> coding sessions now no matter if you are in a coding session or a normal chat
> session."*).
> Extends `docs/ONE_SESSION_PLATFORM.md` (Phase P2 — the unification execution
> plan). This document is the **component-level design for finishing P2**: the
> verified current state, a decision for every remaining divergence, and the
> phased path to flipping `PLAIN_SESSION_VIEW` and retiring the legacy
> transcript.

---

## 1. Verified current state (2026-08-29, against `main`)

The 2026-08-29 audit in ticket `1b0c44bd` is **partially stale** — convergence is
further along than it records. Verified fresh:

| Surface element | State | Evidence |
|---|---|---|
| Page tree | **ONE tree, already converged.** Both chat kinds render from `frontend/app/crossmodel/page.tsx`; the render fork is `codeChatId ? <CodeSessionView/> : legacy transcript` (page.tsx:6321), decided in `loadChat` (page.tsx:3169–3221). | page.tsx:311, 6321 |
| The flip mechanism | **Built, complete, flagged OFF.** `PLAIN_SESSION_VIEW = false` (page.tsx:311). The flagged branch renders plain chats inside `CodeSessionView` via `codeChatPlain` (page.tsx:3184–3218). All six documented flip blockers were CLOSED 2026-08-15 ("increment 2", PR #254). | page.tsx:311, 3184–3218; ONE_SESSION_PLATFORM.md:137–178 |
| Event bridge | **Built.** `frontend/app/crossmodel/plain-session.ts` maps stored plain messages → `CodingMessage` rows (`mapPlainMessages`), normalizes the legacy SSE vocabulary → coding events per connection, builds plain send/stream URLs, and carries transcript extras (follow-ups, sources, models) on `plainMeta` (`buildPlainMeta`). | plain-session.ts |
| Composer | **ONE shared `ChatComposer`** (extracted P4): one shell, `variant="chat"\|"code"`, surface controls passed as slot props (`topContent`, `leftActions`, `rightActions`, `footerNote`). Plain-in-unified renders the code layout with chat Enter semantics (`submitOnEnter=false`). | ChatComposer.tsx docstring |
| Right panel shell | **ONE shared `WorkspacePanel`** (data-agnostic tab shell of `WorkspaceSection` nodes). Coding mounts `overview` + `files` (CodeSessionView.tsx:2458–2524, `{!plain}`-gated). Plain mounts `artifacts` + `files` + `fleet` from the page (page.tsx:7800–7868). | WorkspacePanel.tsx:26–53 |
| Transcript primitives | **Shared** (`code-transcript.tsx`): `PlanCard` (102–122), `AssistantParts`, the More-info panel, email-confirm card, Sources pills, "Suggested next" chips — the last four ported for plain mode in increment 2. | code-transcript.tsx; ONE_SESSION_PLATFORM.md:157–170 |

### The real remaining gap: two transcript implementations, drifting

The flip never executed (owner-gated on the prod smoke, ONE_SESSION_PLATFORM.md:180–185),
so **two live transcript implementations have drifted for two weeks**
(2026-08-15 → 2026-08-29). Drift candidates landed on one or both sides and must be
reconciled before the flip — each needs a "ported already / port / consciously drop"
verdict:

- Persona display names for models (#477, `1b1ce2af`; owner ticket `7bdbe40c`)
- Patience picker names the models each level runs (`ae3ef713`; owner ticket `4550ee11`)
- Collapse inter-agent + system rows everywhere (`edf3e247`; feedback `4959bb1c`)
- Machine-wake envelope one-line rows (#396, `1bd184ae`)
- Queued steer echoes below the live block (#465, `590031fb`)
- Queued messages carry attachments (`42aeabf3`; ticket `ac65d51e`)
- Prose-fragment grouping around thought rows (#433, `10199291`)
- Per-message timestamps in the coding view (#375, `96b0da27`)
- Per-chat Files panel sections (#382, `d181b391`)
- Chat-side persistent FleetPanel — Phase D (`75b7c548`)
- Composer placeholder truth per session status (#434, `2cb3018d`)
- Steer fixes: send to running-but-detached (#436, `97af2895`), steer-409 unwedge (#454, `20ca951e`)

---

## 2. A decision for every intentional divergence

Numbering follows the ticket's audit. Each decision names the **converged end state**
and what changes to reach it.

### D1 — Right panel: converge on ONE WorkspacePanel mount + a section registry

**Audit claim was stale:** plain chat is not "Artifacts/Canvas only" — it already mounts
`WorkspacePanel` with `artifacts`/`files`/`fleet` sections, but through a **second,
page-level mount** with its own resize implementation (`canvasWidth`, page.tsx:7800–7868)
versus CodeSessionView's `--panel-w` in-flow column (CodeSessionView.tsx:2461–2477).

**End state:** exactly one panel mount (inside the session view) with a *section
registry* keyed by session capability, not by surface:

| Section | Plain session | Coding session |
|---|---|---|
| `overview` (goal/AC/todos/usage/context/processes) | — (codingApi-only data) | ✓ |
| `artifacts` (CanvasPanel) | ✓ | ✓ (today folded into `files`) |
| `files` (ChatFilesSection) | ✓ | ✓ |
| `fleet` (FleetPanel) | ✓ (non-kid) | ✓ (non-kid) |

One resize implementation (`--panel-w`) survives; the page-level `canvasWidth` path is
deleted with the legacy view. The `Overview` section stays coding-only until/unless a
plain-grade data source exists (see D2) — the panel shell no longer cares.

### D2 — Plan/todo/goal board: stays a coding-tier feature (explicit non-goal for the flip)

Server-persisted plans exist only in the coding harness (`coding/plan.service.ts`;
`update_plan` only in `coding/tools.ts:326`, orchestrator/planner roles). Plain chats
have no plan surface and the inline `PlanCard` (code-transcript.tsx:102–122) already
renders any `update_plan` tool call that does appear in a transcript.

**Decision:** do **not** build a plain-chat plan board as part of UI convergence. It is
a *capability* question (does the chat tier get the planning tool?), tracked by
ONE_SESSION_PLATFORM.md Phase P4 (capability model), not a look-and-feel gap. The
converged UI renders plans identically *when they exist* — that is the convergence
contract.

### D3 — Tool-call rendering: one entry family survives; `AgentSteps` retires with the legacy view

Today the legacy view renders live agent work via `AgentSteps` (page.tsx) while the
unified view renders `AssistantParts`/`code-transcript` components. Under the flip this
divergence **disappears by construction**: plain live events are normalized into the
coding event vocabulary by plain-session.ts and render through the same
`code-transcript` path as coding sessions; persisted `parts` already render via
`AssistantParts` through `mapPlainMessages`.

Plain-only extras are already ported (increment 2): More-info panel (admin-gated via
`PlainSessionProps.isAdmin`), per-model responses, Sources pills, Suggested-next chips,
email-confirm card. Coding-only rows (permission approval cards, live worker/verify
chips) stay coding-only — they render from coding-run state that plain runs do not have.

**Work item:** reconcile the post-increment-2 drift (§1 table) — e.g. persona display
names and inter-agent row collapsing must hold in the `code-transcript` path, not just
the legacy one.

### D4 — Composer: already one composer; remaining work is slot wiring in the unified view

`ChatComposer` is the single composer. What remains:

1. **Patience control as a slot.** The legacy composer hosts the patience picker
   (Auto ✨|1|2|3, now naming models per level — `ae3ef713`). The unified view's plain
   mode receives `plain.mode` but the *picker UI* must be passed into the composer's
   `rightActions` slot (page owns patience state already) so a flipped plain chat keeps
   level switching, including the per-level model naming.
2. **Permission-mode picker stays coding-only chrome** (Auto/Plan/Ask —
   `MODE_LABEL`, CodeSessionView.tsx:109, 1514–1518); plain chats have no permission
   mode and gain none.
3. **"Code session" escalation chip** remains the plain→coding gesture
   (ONE_SESSION_PLATFORM.md P2 item 3; in-place escalation is a later increment).

### D5 — Kid accounts: stay on the legacy view until guard rails port

Kid guard rails live in the legacy view; `PLAIN_SESSION_VIEW` already excludes kids
(`!isKid`, page.tsx:3184). `CodeSessionView` carries an `isKid` gate for the sponsored
ThinkingAd slot. **Decision:** kids flip last, as their own checklist item inside C3 —
the legacy view cannot be deleted until kid rails (ad slot, content guard) are verified
in the unified view.

---

## 3. Phased implementation plan

### C0 — Drift reconciliation + flip readiness (pre-flip)
For every drift candidate in §1: verify whether the unified plain path already has the
behavior; port what's missing; record conscious drops. Acceptance: a checked-off parity
table appended to this doc; `assistant-parts.test.tsx`-style unit coverage for any
ported rendering; the flag still OFF.

### C1 — The flip (owner-gated, reversible)
1. Convert `PLAIN_SESSION_VIEW` from a compile-time const to a **per-account preview
   toggle** (settings-level, default ON for admin/owner accounts first) so the smoke is
   a UI action, not a deploy.
2. Run the prod smoke plan (ONE_SESSION_PLATFORM.md:180–185) on the owner account, plus
   three additions covering late drift: persona names in More-info, patience-level model
   naming, queued-message rendering mid-run.
3. Rollback = toggle off (per-account) — no deploy, no data migration (zero backend
   change; the bridge is read/write-compatible by design).

### C2 — Panel + composer slot convergence
Section-registry WorkspacePanel (D1), one resize implementation, patience-control slot
(D4.1). Ships behind the same toggle; visible only to flipped accounts.

### C3 — Legacy retirement
Delete the legacy in-page transcript (~700 lines of page.tsx:6990–7787), `AgentSteps`,
the page-level panel mount + `canvasWidth` resize, and the duplicated strip helpers
(keep plain-session.ts's copies, per its docstring). Kid accounts flip first within this
phase (D5). The flag/toggle itself is removed last; `PLAIN_SESSION_VIEW` call sites
(page.tsx:1580–1585, 2081, 2771–2803, 3169–3221) collapse to the unified path.

### Non-goals (unchanged from ONE_SESSION_PLATFORM.md)
No execution-tier merge (interactive fast-path vs durable worker both stay). No plain-chat
plan board (D2). No new guardrails. Legacy message data is never deleted.

### KPIs
- % of sessions that never need the other UI → ~100% (already a P2 KPI; the flip makes
  it measurable).
- Transcript drift candidates per month → 0 after C3 (one implementation).
- Flip rollback rate: smoke failures requiring toggle-off → 0 after C1 gate passes.

---

## 4. What ships this ticket

This document only (a design deliverable, per ticket `1b0c44bd`'s scope). Implementation
of C0→C3 is queued as a follow-up engineering ticket referencing this doc. No runtime
code changes; `PLAIN_SESSION_VIEW` remains `false`.
