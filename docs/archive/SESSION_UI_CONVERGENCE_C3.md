# Session UI Convergence — C3 Legacy Retirement (final phase)

> Tracking: feedback ticket `71b1fec6-54c1-4cbd-ae0d-1f2f5844fd9a` (C0–C3
> implementation queue; this lane closes it). Documents of record:
> `docs/SESSION_UI_CONVERGENCE_DESIGN.md` (design; PR #485),
> `docs/SESSION_UI_CONVERGENCE_C0_AUDIT.md` (C0 audit; PR #488, merge sha
> `660a9a8937f7aecaccfd87e2a24f5492040b2c6e`),
> `docs/SESSION_UI_CONVERGENCE_C1_SMOKE.md` (C1 smoke matrix; PR #501, merge
> sha `9eab85866d383088c4734fc33508d3a6d6994ef3`), and
> `docs/SESSION_UI_CONVERGENCE_C2.md` (C2 lane record; PR #517, merge sha
> `1476eda525a8ff34beb4ab35015524cd96675f20`). Lane date: 2026-08-30.
> Lane base: `main` @ `240b3c4d` (session branch `digby/session-fcdb185a`).
> **Scope: the C3 phase exactly as the design defines it — the legacy
> in-page transcript, `AgentSteps`, and the page-level WorkspacePanel mount
> are retired; the converged plain path (CodeSessionView) is the ONLY
> session view.**

## Design-doc C3 definition (quoted verbatim, design §3)

> ### C3 — Legacy retirement
> Delete the legacy in-page transcript (~700 lines of page.tsx:6990–7787), `AgentSteps`,
> the page-level panel mount + `canvasWidth` resize, and the duplicated strip helpers
> (keep plain-session.ts's copies, per its docstring). Kid accounts flip first within this
> phase (D5). The flag/toggle itself is removed last; `PLAIN_SESSION_VIEW` call sites
> (page.tsx:1580–1585, 2081, 2771–2803, 3169–3221) collapse to the unified path.

---

## 1. Reconciliation — the documents vs current `main` (mismatches, reported not papered over)

`main` moved after the C2 merge (`1476eda5`). Four mismatches between the
documents of record and the lane base `240b3c4d`, each verified fresh this
run:

### 1a. "The flag/toggle itself is removed last" is superseded — the flag was already gone

Design C3 sequences flag removal as this phase's last act. As the C1 doc §1a
and C2 doc §1a both recorded, `7a5fd24b` straight-enabled
`PLAIN_SESSION_VIEW` and `4dabda78`/`bbb2658c` (C3 partial) removed the flag
entirely — before C1 even ran. Fresh verification on `240b3c4d`:
`grep -rn PLAIN_SESSION_VIEW frontend/` → **0 hits** outside the C1 smoke
test's historical comment. **Consequence: C3 had no flag removal left; this
lane was purely the legacy-route deletion + the anonymous decision.**

### 1b. "Kid accounts flip first within this phase (D5)" is superseded — kids already flip

The C3-unblock work (pre-C1, recorded in C0 audit §5a) plus the C2 registry
withholding already flip kid accounts into the unified plain view with rails
honored (C2 doc §4: "C3 only needs to not regress it"). This lane's
obligation was preservation, not sequencing: verified and pinned (§3).

### 1c. The C0 audit's anonymous decision is superseded — the C2 lane's bounding decision is RESOLVED

C0 audit §5 recorded: "product decision … anonymous convergence is OUT OF
SCOPE for C3; they keep the legacy transcript" — which made the entire
legacy route (`!codeChatId`) undeletable and is what the C2 lane §4 meant by
"the deletion boundary runs through that decision". **Resolved this lane by
owner directive (2026-08-30, asked in-session): anonymous/guest sends
converge into a deliberately LIMITED guest mode with sign-up CTAs — not the
legacy transcript, and not the full converged feature set.** The deletion
boundary therefore closed: the legacy route became fully deletable the
moment the guest mount existed. Implementation in §2.

### 1d. Post-C2-merge main movement does not collide with the deletion

Commits on `main` between `1476eda5` (C2 merge) and the lane base
`240b3c4d`: `5f49c34f`, `bd32bf61`, `13c37413`, `e5b6dd41`, `56fa1fc6`,
`3a79253a`, `240b3c4d`. Only `13c37413` (#524, strip [FOLLOWUPS]/canvas
markup from persisted transcript parts) touches session-UI-adjacent code —
backend `chat-agent.service.ts` / `pipeline-utils.ts` plus
`frontend/app/crossmodel/plain-session.ts`. It landed cleanly **before**
this lane's base (this lane's plain-session.ts edits apply on top of it; the
strip helpers it added to plain-session.ts are exactly the copies the design
says to KEEP). No other mismatch found.

### 1e. The C1 smoke matrix's composer-slot pin is updated, not weakened — C3 changed that arrangement deliberately

`c1-convergence-smoke.test.tsx` pinned
`composerRightActions: (<PatiencePicker …` unconditionally. C3's guest mode
(owner directive, §1c) makes the slot conditional: signed-in sessions keep
the picker, anonymous guests get a static sign-up chip. The pin now asserts
the guest gate AND the picker on the non-guest branch (the second C1 pin —
CodeSessionView feeding `plain.composerRightActions` into ChatComposer — is
untouched and still passes). Recorded here per the evidence rule; the
executable half of the row (patience copy from MODEL_PERSONAS) is unchanged.

---

## 2. What this lane changed (implementation commit `a1bc90b5147abf7794b3a7fcefc7681d08e161ba`)

`5 files changed, 364 insertions(+), 3285 deletions(-)`;
`frontend/app/crossmodel/page.tsx` **7494 → 4477 lines**.

### 2a. Removed (the C3 deletion proper)

- **The legacy in-page transcript** (page.tsx): every `!codeChatId` session
  branch — user/assistant bubbles with hover/swipe timestamp reveal
  (`handleTimeSwipe`), the streaming card with live model timings +
  agent-activity feed + routing line, sources pills, follow-ups, email
  confirm card, ask_user card, canvas cards, the local queued-message flow —
  and all machinery existing solely to serve it:
  - SSE plumbing: `new EventSource` stream handlers, large-message register,
    silence watchdog, onerror recovery, parse-error salvage,
    `streamEndedNaturallyRef`, `statusCycleRef`, `handleStop`,
    `attachAgentRunIfLive` + its recovery plumbing;
  - stream state: `const [isStreaming …]`, `const [messages …]`,
    `queuedMessage`, `serverQueued` + the drain watch;
  - the duplicated strip helpers `stripCanvasTags` / `mapStoredMessages`
    (plain-session.ts's canonical copies survive, per the design);
  - scroll-pin apparatus and every now-orphaned helper/type/import.
- **The page-level WorkspacePanel mounts** — both the desktop `<aside>` and
  the mobile `<Drawer>` panel — plus the `canvasWidth` drag-resize state and
  handlers (design D1's single `--panel-w` implementation in
  CodeSessionView is now the only resize).
- **`AgentSteps`** — the export deleted from
  `components/code-transcript.tsx` (the canonical in-view copies own step
  rendering); zero importers remained.

After the deletion the render fork is total:

```tsx
{(codeChatId || chatlessActive) ? (
  <CodeSessionView key={codeChatId ?? `chatless-${chatlessActive!.nonce}`} … />
) : (
  /* home screen — greeting, weather, briefing, calendar, starters, composer */
)}
```

Every home-composer send now hands off to the converged view; the home
screen itself (never a transcript) is untouched.

### 2b. The anonymous-route resolution (owner directive, §1c) — guest mode

Anonymous sends mount the view's chatId-less **GUEST** mode
(`setChatless({ guest: true, nonce: Date.now() })`):

- **Limited features**: locked to `single_thinking` (no patience picker — a
  static `Auto ✨ · sign in for more` chip replaces it in both the view slot
  and the home composer), no attachments (paperclip, attachment bar, hidden
  input, drop/paste gestures all `user`-gated; `takeAttachments` undefined
  for guests — adversarial-review F2 follow-up), no workspace panel
  (`panelSections: []`, no workspace toggle), no deep-research gestures,
  no Report-issue control (`PlainMessageActions` gates it on `!!chatId` —
  feedback needs a saved chat; review F3 follow-up).
- **Sign-up CTAs**: a persistent `GuestBanner` ("Guest session … Sign up
  free") atop the transcript, plus the static chips.
- **Transport**: `plain-session.ts` `PlainSendParams.chatId` is now
  optional; the `/crossmodel/stream` register body and both GET-fallback
  URL builders set `chatId` only when present — the server's existing
  cm_session cookie context carries the anonymous conversation (no backend
  change; the endpoint already supported chatId-less anonymous streams, C0
  audit §5a). Canvas events convert to inline markdown text
  (`canvasEventToText`) since guests have no panel to receive them.

### 2c. The createChat-failure fallback — KEPT, converged (C0 §5a's surviving requirement)

A signed-in home-composer send whose `createChat` fails gets **one inline
retry** (`for (let attempt = 0; attempt < 2 && !newChatId; attempt++)`),
then mounts the chatId-less **FALLBACK** mode
(`setChatless({ guest: false, … })`): the full converged feature set,
ephemeral (nothing to re-attach to — `attachOnLoad: false`,
`onStreamClaim: undefined`), panel derived from the registry-composed page
sections minus Files (`pagePanelSectionsChatless = pagePanelSections.filter(s
=> s.id !== 'files')` — there is no session to scope Files to). The send
never dead-ends, which is what the fallback existed to guarantee.

### 2d. CodeSessionView chatless readiness

`chatId: string | null`; `PlainSessionProps.guest?: boolean`; session-only
calls (files create, plan/session/title loads, attach) guarded
(`if (!chatId) return;` / `return null;`); `GuestBanner`; composer gates
(paperclip and attachment surfaces hidden in guest mode).

### 2e. Registry caps (workspace-sections.ts)

Guest mounts get **no sections**; chatless fallback mounts get the plain
kind minus `files`. Kid withholding (fleet) composes unchanged through both.

---

## 3. Kid gating (design D5) — verified with the legacy mount removed

Kids flip last, into the SAME converged view, with every rail intact and
pinned by test:

| Rail | Mechanism | Pin |
|---|---|---|
| View mount | `isKid={isKid}` on the one CodeSessionView mount (coded + chatless alike) | `c3-legacy-retirement.test.tsx` mount-region pin |
| Fleet withholding | `workspaceSectionIds({kind:'plain', isKid:true})` → `['artifacts','files']` (registry, C2) | `workspace-sections.test.ts` (pre-existing) |
| Fallback composes withholding | kid fallback → `['artifacts']` (files cap × fleet withholding) | `workspace-sections.test.ts` C3 describe |
| Patience picker | renders nothing for kids (pre-existing) | untouched this lane |
| ThinkingAd | `!isKid`-gated in the view (pre-existing) | untouched this lane |
| Report-issue | adult-only in `PlainMessageActions` (pre-existing) | untouched this lane |
| Guest mode | orthogonal to kids (a kid is signed in by definition); guest caps apply to anonymous only | `c3-legacy-retirement.test.tsx` guest pins |

## 4. Execution evidence (this lane)

- **Regression pins** (`frontend/app/crossmodel/c3-legacy-retirement.test.tsx`,
  28 tests): absence pins for every deleted surface (AgentSteps, page-level
  `<WorkspacePanel`, `canvasWidth`, `new EventSource(`, stream state,
  queue/drain, attach plumbing, strip/map helpers, `handleTimeSwipe`);
  presence pins for the render fork, guest caps, fallback composition, and
  chatless guards; executable `canvasEventToText` cases.
- **Registry composition** (`frontend/lib/workspace-sections.test.ts`, +2
  tests): the fallback's files-cap × kid-withholding composition.
- `npx vitest run app/crossmodel/c3-legacy-retirement.test.tsx lib/workspace-sections.test.ts`
  → **36 passed (36), exit 0**.
- Full verify chain (backend tsc, backend+frontend lint, backend jest,
  frontend vitest): see the PR body — run fresh on the PR head with exit
  codes quoted there.

## 5. Program closeout — what remains after C3

- **C3 is the final phase.** C0 audited the drift, C1 smoked the flip, C2
  converged the panel + composer slot, C3 retired the legacy route. Ticket
  `71b1fec6` closes with this lane's artifact chain (PR, merge sha, deploy
  run, prod probes).
- **Non-goals honored**: no execution-tier merge, no plain-chat plan board,
  no new guardrails, zero backend changes (the stream endpoint's chatless
  support already existed).
- **Rollback** = git revert of the squash-merge (the flag-based rollback is
  long gone — C1 §1a). The converged view has been the live default since
  `7a5fd24b`; this phase removed only the code that had become unreachable
  for signed-in users and the anonymous route the owner chose to converge.

---

*Produced by the C3 legacy-retirement lane (Digby Code session branch
`digby/session-fcdb185a`), 2026-08-30. Every sha, grep claim, line count, and
test count above comes from a fresh invocation against the lane base
`240b3c4d` in that session.*
