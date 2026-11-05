# Session UI Convergence — C1 Smoke-Verification Matrix

> Tracking: feedback ticket `71b1fec6-54c1-4cbd-ae0d-1f2f5844fd9a` (C0–C3
> implementation queue; stays `in_progress` until C3). Documents of record:
> `docs/SESSION_UI_CONVERGENCE_DESIGN.md` (design; PR #485) and
> `docs/SESSION_UI_CONVERGENCE_C0_AUDIT.md` (C0 audit; PR #488, merge sha
> `660a9a8937f7aecaccfd87e2a24f5492040b2c6e`). Lane date: 2026-08-29. Lane base:
> `main` @ `62e928eb` (session branch `digby/session-ebd36896`). **Scope: smoke
> verification only — zero runtime code changed by this lane; the only code
> artifact is a test file.**

## Design-doc C1 definition (quoted verbatim, design §3)

> ### C1 — The flip (owner-gated, reversible)
> 1. Convert `PLAIN_SESSION_VIEW` from a compile-time const to a **per-account preview
>    toggle** (settings-level, default ON for admin/owner accounts first) so the smoke is
>    a UI action, not a deploy.
> 2. Run the prod smoke plan (ONE_SESSION_PLATFORM.md:180–185) on the owner account, plus
>    three additions covering late drift: persona names in More-info, patience-level model
>    naming, queued-message rendering mid-run.
> 3. Rollback = toggle off (per-account) — no deploy, no data migration (zero backend
>    change; the bridge is read/write-compatible by design).

---

## 1. Reconciliation — the documents vs current `main` (mismatches, reported not papered over)

The C0 audit's §4 queue is this lane's work queue, but `main` moved after the
audit base (`60b31a8f`, 2026-08-29 workspace snapshot). Three mismatches,
each verified fresh on the lane base `62e928eb`:

### 1a. The flip mechanics in design C1.1/C1.3 are superseded — the flag no longer exists

Design C1.1 specifies a **per-account preview toggle** (default ON for
admin/owner first); C1.3 makes rollback a toggle-off. What actually landed on
`main` (all citing ticket `71b1fec6`):

| Commit | Subject |
|---|---|
| `7a5fd24b` | feat(ui): **C1 — enable PLAIN_SESSION_VIEW** (unified session view for plain chats) — a straight enable, not a per-account toggle |
| `a6b87d69` | feat(ui): **C2 ports** — patience picker in composer rightActions + FleetPanel via section registry |
| `4dabda78` / `bbb2658c` | refactor(ui): **C3 (partial)** — remove the PLAIN_SESSION_VIEW flag; legacy transcript deletion BLOCKED |

Fresh verification on `62e928eb`: `grep -rn PLAIN_SESSION_VIEW frontend/` →
**0 hits**; `page.tsx` (~:6385–6392) mounts `<CodeSessionView>` unconditionally
for any `codeChatId` and passes `plain={codeChatPlain ? {…} : undefined}`.
Rollback is now a git revert, not a toggle-off (C0 audit §5, written by the C3
lane, records the same). **Consequence for this lane: there is no flag to flip
and no per-account toggle to build in C1 — the flip already happened on `main`
by other lanes' commits. This lane changes no gating.** The design's owner-gated
prod smoke (C1.2) remains owner-account production work outside an unattended
coding lane; what this lane delivers is the **executable, CI-runnable half** of
that smoke plan (§2 below). Note the C3 lane's caveats still stand (audit §5):
new-chat sends, anonymous/guest chats, and kid accounts remain legacy-routed —
"the converged view is the only surface" holds only for re-opened signed-in
adult chats.

### 1b. The audit §4a "real port work" queue is stale — both C2 ports already landed

Audit §4a queued two ports for C2 as not-yet-done. Both landed on `main` as
`a6b87d69` (before this lane ran), verified fresh:

- **Patience picker → composer `rightActions` slot (D4.1, from `ae3ef713`):**
  `page.tsx:6452` passes `composerRightActions: <PatiencePicker …/>` in the
  plain props; `CodeSessionView.tsx:2370` wires
  `rightActions={plain ? plain.composerRightActions : undefined}`.
- **FleetPanel → WorkspacePanel section registry (D1, from `75b7c548`):**
  `CodeSessionView.tsx:2541` — `case 'fleet': return { … node: <FleetPanel /> }`.

**Consequence: this lane implements neither port (they exist); matrix rows 12–13
verify them as landed behavior** — which also unblocks the design C1.2
"patience-level model naming" smoke addition the audit had order-gated on the
C2 port.

### 1c. "The repo's existing test setup (jest)" — frontend surfaces test under vitest

The lane charter named jest. Reality on `main`: the backend verify-chain test
step is jest (`cd backend && npx jest`), but every frontend surface this matrix
covers tests under **vitest** (`cd frontend && npx vitest run`;
`frontend/vitest.config.mts`: node environment, `**/*.test.{ts,tsx}`). The
matrix therefore lands as a frontend vitest file — where the surfaces under
test live and where its sibling pins (`model-display.test.ts`,
`machine-wake.test.ts`, `queued-echoes.test.ts`, `prose-grouping.test.ts`,
`composer-guard.test.ts`, `ChatFilesSection.test.tsx`, …) already run. The one
backend-flavored behavior (`42aeabf3` drain-side) is already covered by
existing jest tests (`backend/src/modules/crossmodel/chat-agent/message-queue.test.ts:350,367`),
so no backend test was added; row 5 pins that coverage with a tripwire.

---

## 2. The C1 smoke-verification matrix (executable)

Test file: **`frontend/app/crossmodel/c1-convergence-smoke.test.tsx`** — 14
describes / **41 tests**. Idioms: pure-helper unit tests + SSR renders of leaf
components (`renderToStaticMarkup`, the repo's node-environment vitest idiom) +
source-level mount/wiring pins anchored on stable identifiers (never line
numbers). Every describe cites its drift sha(s) and design-doc section. Rows
1–11 are the audit §4b already-holding behaviors; rows 12–13 verify the two
C2 ports as landed on `main` (§1b); row 14 is the author-attribution gap pin
(§3).

| # | Drift sha(s) | Behavior | Design ref | Executable check (all in `c1-convergence-smoke.test.tsx`) | Status |
|---|---|---|---|---|---|
| 1 | `1b1ce2af` | Persona display names for models | §1; D3; §3 C1.2 | SSR `PlainMoreInfo` collapsed mount; `displayModelName()` on fixture labels → persona names, zero vendor-string matches; source pins: `code-transcript.tsx` label call sites + `CodeSessionView` `plain.isAdmin && m.plainMeta?.models` gate | PASS |
| 2 | `edf3e247` | Collapse inter-agent + system rows | §1; D3 | `mapPlainMessages` carries `metadata.origin` → `plainMeta.origin`; `classifySystemRow({metadata: plainMeta})` classifies machine origins (`wake`/`agent`/`system`); absent/`'user'`/unknown origin → `null` (human never collapses) | PASS |
| 3 | `1bd184ae` | Machine-wake envelope one-line rows | §1; D3 | SSR collapsed `MachineWakeBlock` (kind label, source title, time label, `aria-expanded="false"`, truncated preview, no payload `<pre>`); source pin: `<MachineWakeBlock … origin={m.plainMeta?.origin} … timeLabel={timeLabel ?? undefined} />` mount in the message loop | PASS |
| 4 | `590031fb` | Queued steer echoes below the live block | §1; §3 C1.2 | `partitionQueuedEchoes` partitions `steer-*`/`tmp-*` echoes out of history (order-preserving, non-mutating); source ordering pin: live-run block anchor precedes `{queuedEchoes.map(...)}`; `Queued` captions (plain + coding) + per-echo `formatMessageTime` send-time label | PASS |
| 5 | `42aeabf3` | Queued messages carry attachments | §1; §3 C1.2 | Refusal-gate strings absent; attachment-chips render pin (`m.plainMeta?.attachments` map); `uploadIds` pinned through send → `queuePlainBehindLive` → `buildPlainStreamUrl`; backend drain coverage tripwire-pinned: `message-queue.test.ts:350` (resolve-on-drain) + `:367` (expired-blob honest annotation) | PASS |
| 6 | `10199291` | Prose-fragment grouping + Hide-thinking pill | §1; §3 C0 acceptance | `groupProseParts` on T,R,T,R,T interleave → one prose group (byte-lossless join) + 2-thoughts chip; SSR `AssistantParts` `hideThinking` keeps joined prose, drops reasoning; source pins: `hideThinking={hideThinking}` at history + live sites, Hide-thinking pill | PASS |
| 7 | `96b0da27` | Per-message timestamps | §1; D3 | `formatMessageTime` unit (valid → label, null/invalid → null); source pins: user-row desktop hover span (`hidden sm:block` + `group-hover/msg:opacity-100`) + mobile `sm:hidden` span, assistant mirror; live-block region contains no `formatMessageTime` | PASS |
| 8 | `d181b391` | Per-chat Files panel section | §1; D1 | Source pins: import + `case 'files':` registry mount of `<ChatFilesSection chatId={chatId} refreshKey=…>`; html/svg Download-only XSS gate re-pinned (SSR: html upload → Download, zero Preview) | PASS |
| 9 | `2cb3018d` | Composer placeholder truth per status | §1; D4 | Source pins: all five per-status placeholder strings (running → "Steer the run…"; ready → "Describe what to build or fix…"; detached → "Run in progress — attaching…"; error → "Workspace setup hit an error…"; fallback → "Setting up the workspace…") + the plain-mode branch in the same computation | PASS |
| 10 | `97af2895` | Steer to running-but-detached | §1; D4 | `routeSend` routes running-detached to steer; source pins: steer guard widened (`live.running \|\| status === 'running'`) + resync-then-steer flow in `CodeSessionView` | PASS |
| 11 | `20ca951e` | Steer-409 bypass | §1; D4 | `classifySteerFailure(409) === 'fallback-send'`; source pins: bypassed re-send `void send(message, undefined, { bypassRunningGuard: true })`; `STEER_TIMEOUT_MS` on the steer POST | PASS |
| 12 | `ae3ef713` + `a6b87d69` | Patience-level model naming rides the converged composer (verify-only — C2 port landed on `main`, §1b) | D4.1; §3 C1.2 | Source pins: `page.tsx` `composerRightActions: <PatiencePicker …/>`; `CodeSessionView` `rightActions={plain ? plain.composerRightActions : undefined}`; `patience.ts` builds picker copy from `MODEL_PERSONAS` names | PASS |
| 13 | `75b7c548` + `a6b87d69` | FleetPanel via WorkspacePanel section registry (verify-only — C2 port landed on `main`, §1b) | §1; D1 | Source pins: `CodeSessionView` imports `FleetPanel`; registry `case 'fleet'` returns `node: <FleetPanel />` | PASS |
| 14 | `58ffcf86` | Shared-chat author attribution — **C2 GAP PIN** (§3; do NOT implement in C1) | §3 cross-check | (a) Executable: `mapPlainMessages` carries `metadata.authorId` into `plainMeta` at runtime (bridge holds the stamp); (b) gap pin: `PlainMessageMeta` declares no `authorId`/`authorName`; (c) gap pin: zero `messageAuthors` references across `plain-session.ts` + `components/*.tsx` | PASS (gap pinned) |

### Coverage map vs audit §4b items

§4b.1 → row 1 · §4b.2 → rows 4–5 · §4b.3 → rows 2–3 · §4b.4 → row 6 ·
§4b.5 → row 7 · §4b.6 → row 8 · §4b.7 → rows 9–11 · §4b.8 → row 14 (§3).

---

## 3. Open-question resolution — shared-chat author attribution (`58ffcf86` vs `mapPlainMessages`)

**Decision: PORT — needed. Absent from the converged view today; filed as a C2
gap (per audit §4b item 8: "confirm or file as a C2 gap"). NOT implemented in
this lane — C1 is smoke verification, not re-implementation.**

Evidence chain (every line verified fresh on `62e928eb`):

1. **Backend stamps the author** on user rows only:
   `chat-agent.service.ts:874–880` (`metadata.authorId`, human-origin rows;
   queue drains thread the enqueuer), `context.service.ts:304` + `:672`
   (legacy history save / anonymous-session migration), declared at
   `types.ts:68` ("names resolve at read time — never denormalized").
2. **The messages GET carries everything needed**: `getChatById` appends
   `messageAuthors` in BOTH the legacy (:474–475) and paged (:533–540)
   branches via `resolveMessageAuthors` (batched id→name lookup, omitted when
   empty). The converged view's loader hits exactly this endpoint.
3. **The legacy view renders it**: `page.tsx:318` (resolve `authorName` from
   `full.messageAuthors`), `:348` (`isTeammateMessage` = user row ∧ authorId ∧
   authorId ≠ viewer), `:7046–7056` (violet teammate bubble + `From: {name}`
   footnote; own/unstamped rows pixel-identical).
4. **The converged path drops it**: `mapPlainMessages` (`plain-session.ts:65–78`)
   wholesale-casts `m.metadata` into `plainMeta`, so `authorId` rides at
   runtime — but `PlainMessageMeta` (`frontend/lib/api/coding.ts:104–122`)
   declares **no `authorId`/`authorName`**, nothing reads it, and
   `messageAuthors` has **zero** references in `plain-session.ts` +
   `components/` (grep → 0). Under the now-complete flip this is a **silent
   regression of a shipped prod feature** for every member of a shared-project
   chat.

**Minimal C2 diff sketch (for the picking lane):** declare
`authorId?: string; authorName?: string` on `PlainMessageMeta`; carry
`messageAuthors` from the `getChat` payload through the plain loader (resolve
to `authorName` at map time, mirroring `page.tsx:318`); port the teammate
treatment (violet bubble + `From:` footnote, `isTeammateMessage` semantics) into
the `code-transcript` user-bubble branch. Then replace matrix row 14's gap pins
(b)/(c) with a render-level pin. Until then, row 14 fails safe: any accidental
removal of the runtime `authorId` carriage breaks (a), and the gap pins break
the moment the port lands — forcing the row to be upgraded, not forgotten.

---

## 4. Execution evidence (this lane)

| Check | Command | Result |
|---|---|---|
| Full frontend suite | `cd frontend && npx vitest run` | **exit 0** — 18 files passed, **361 tests passed** (incl. `c1-convergence-smoke.test.tsx`: 41 tests, 298 ms) — 2026-08-29 22:44 UTC |
| Verify chain (typecheck → lint → test) | `verify` tool (`.digby/config.json`) | recorded in the PR body / ticket adminNote |
| Existing backend drain coverage | `backend/src/modules/crossmodel/chat-agent/message-queue.test.ts:350,367` | pre-existing jest coverage, tripwire-pinned by row 5 |

## 5. Deliberately not done by this lane

- No flag/gating change — the `PLAIN_SESSION_VIEW` flag no longer exists on
  `main` (§1a); nothing to flip, nothing reintroduced.
- No C2 port implementation — both ports already landed as `a6b87d69` (§1b);
  rows 12–13 verify them only.
- No author-attribution port — decided PORT, filed as a C2 gap with a minimal
  diff sketch (§3).
- No legacy-view deletion (C3) and no kid-flip work (D5).
- The owner-account production smoke of design C1.2 remains owner-gated prod
  work; this lane delivers its executable half (§2).

---

*Produced by the C1 smoke-verification lane (Digby Code session branch
`digby/session-ebd36896`), 2026-08-29. Every sha, line reference, grep claim,
and test count above comes from a fresh invocation against the lane base
`62e928eb` in that session.*
