# Session UI Convergence — C2 Panel + Composer-Slot Convergence

> Tracking: feedback ticket `71b1fec6-54c1-4cbd-ae0d-1f2f5844fd9a` (C0–C3
> implementation queue; stays `in_progress` until C3). Documents of record:
> `docs/SESSION_UI_CONVERGENCE_DESIGN.md` (design; PR #485),
> `docs/SESSION_UI_CONVERGENCE_C0_AUDIT.md` (C0 audit; PR #488, merge sha
> `660a9a8937f7aecaccfd87e2a24f5492040b2c6e`), and
> `docs/SESSION_UI_CONVERGENCE_C1_SMOKE.md` (C1 smoke matrix; PR #501, merge
> sha `9eab85866d383088c4734fc33508d3a6d6994ef3`). Lane date: 2026-08-30.
> Lane base: `main` @ `b0bddc69` (session branch `digby/session-4291e875`).
> **Scope: the C2 phase exactly as the design defines it — this lane's runtime
> change is the shared-chat author-attribution port (the one C2 gap C1 left
> open); the rest of C2 is fresh verification of already-landed work.**

## Design-doc C2 definition (quoted verbatim, design §3)

> ### C2 — Panel + composer slot convergence
> Section-registry WorkspacePanel (D1), one resize implementation, patience-control slot
> (D4.1). Ships behind the same toggle; visible only to flipped accounts.

---

## 1. Reconciliation — the documents vs current `main` (mismatches, reported not papered over)

`main` moved after both the C0 audit base (`60b31a8f`) and the C1 lane base
(`62e928eb`). Three mismatches, each verified fresh on the lane base
`b0bddc69`:

### 1a. "Ships behind the same toggle; visible only to flipped accounts" is superseded — there is no toggle

The C2 definition's gating clause predates the C1 flip landing. As the C1 doc
recorded (§1a): `7a5fd24b` straight-enabled `PLAIN_SESSION_VIEW`, then
`4dabda78`/`bbb2658c` (C3 partial) removed the flag entirely. Fresh
verification on `b0bddc69`: `grep -rn PLAIN_SESSION_VIEW frontend/` → **0
hits**; `page.tsx` mounts `<CodeSessionView>` unconditionally for any
`codeChatId` (plain chats via `codeChatPlain`). **Consequence: C2's
panel/composer work ships ungated on `main`; "visible only to flipped
accounts" is a dead clause — reported here, not silently dropped.**

### 1b. The C2 panel/composer scope already landed — verified, not re-implemented

The C2 charter scoped four items; three landed on `main` **before this lane
ran** (the C1 doc §1b recorded the same for its base). Fresh verification on
`b0bddc69` (each claim re-grepped this run, not cited from memory):

| Charter item | Landed as | Fresh evidence on `b0bddc69` |
|---|---|---|
| §3-C2 core: WorkspacePanel section registry, both session kinds, kid gating preserved | `a6b87d69` (registry + FleetPanel port) + the C3-unblock work (plain sections in-view) | `frontend/lib/workspace-sections.ts`: `workspaceSectionIds({kind,isKid})` → coding `overview/files/fleet`, plain `artifacts/files/fleet`, fleet withheld for kids; `CodeSessionView.tsx` registry cases `overview`/`files`/`fleet` (`case 'fleet'` → `node: <FleetPanel />`); plain sections arrive page-built via `plain.panelSections` (`PlainSessionProps.panelSections`); the page-level aside/drawer mounts render only when `!codeChatId` (`page.tsx:6909`, `:6931`) |
| §3-C2 core: one resize implementation | `a6b87d69` + C3-unblock | Converged path: single `--panel-w` in-flow column (`CodeSessionView.tsx:2552`). The page-level `canvasWidth` (`page.tsx:1871`, `:6910`) survives ONLY on the legacy route (anonymous/home, `!codeChatId`) — design D1 schedules its deletion with the legacy view in C3; touching it now is a C3 non-goal |
| Port (a): patience-level model naming in the composer `rightActions` slot (D4.1, from `ae3ef713`) | `a6b87d69` | `frontend/app/crossmodel/patience.ts`: `PATIENCE_SHORT`/`PATIENCE_DESCRIPTIONS`/`AUTO_DESCRIPTION` build the per-level model-naming copy from `MODEL_PERSONAS` (model-display.ts — the naming source of truth); `page.tsx:5741` passes `composerRightActions: <PatiencePicker …/>` in the plain props; `CodeSessionView.tsx` wires `rightActions={plain ? plain.composerRightActions : undefined}` |
| Port (b): FleetPanel via the section registry for both session kinds (D1, from `75b7c548`) | `a6b87d69` | Registry `case 'fleet'` → `node: <FleetPanel />`; executable pin: `workspaceSectionIds` emits `fleet` for `{kind:'plain'}` and `{kind:'coding'}`, withholds it for `isKid:true` (smoke matrix row 13) |

**Consequence: this lane re-verifies items 1–3 (smoke matrix rows 12–13 pin
them) and implements only the fourth** — the author-attribution gap (§2).

### 1c. The C1 doc's "the legacy view renders it" evidence is superseded — attribution was absent from BOTH paths

C1 doc §3 item 3 records the legacy teammate rendering at
`page.tsx:318`/`:348`/`:7046–7056`. Since then, `4777e94a` ("refactor(ui): C3 —
delete the dead legacy transcript paths; anonymous + home survive") deleted
`isTeammateMessage`, the violet tint, the `From:` footnote, and the
`authorId`/`authorName` fields from `page.tsx` (as dead code: signed-in chats
no longer render the legacy transcript). Fresh on `b0bddc69`: `grep -rn
"messageAuthors\|authorId\|authorName" frontend/` (excluding tests) → **0
hits** outside this lane's diff. The C1 doc's "silent regression of a shipped
prod feature" was therefore literal at pick-up time: **no path — legacy or
converged — rendered author attribution** for shared-project chats. This
lane's port (§2) restores it in the converged view, the only path shared-chat
members reach (anonymous chats, the legacy route's sole remaining purpose,
have no stored rows and no authors).

---

## 2. What this lane changed — shared-chat author attribution (`58ffcf86` → C2 port)

Decision was made upstream (C1 doc §3: **PORT — needed**); this lane is the
implementation + regression tests. Mirrors the legacy semantics of `58ffcf86`
exactly, recovered from git history (`git show 58ffcf86`):

| File | Change |
|---|---|
| `frontend/lib/api/coding.ts` | `PlainMessageMeta` declares `authorId?: string` (backend `metadata.authorId` stamp, user rows only) + `authorName?: string` (resolved at map time; absent → footnote falls back to `'teammate'`) |
| `frontend/app/crossmodel/plain-session.ts` | `mapPlainMessages(full)` resolves `authorName` from the payload's additive `messageAuthors` map for stamped USER rows only (assistant/machine rows and unstamped legacy rows pass through untouched; shallow-copied so the fetched payload is never mutated). New pure `isPlainTeammateMessage(meta, viewerId)` = `meta?.authorId && viewerId && meta.authorId !== viewerId` — the legacy `isTeammateMessage` predicate |
| `frontend/app/crossmodel/components/CodeSessionView.tsx` | `PlainSessionProps.viewerId?: string \| null`; the converged user-bubble branch renders the legacy teammate treatment via `isPlainTeammateMessage(m.plainMeta, plain?.viewerId)`: bubble tint `bg-violet-100/70 dark:bg-violet-900/30 text-foreground` (the `58ffcf86` tint — distinct from the viewer's own solid `bg-violet-600 text-white`, same accent family, dark-mode aware) + `<span className="text-[10px] text-muted-foreground">From: {m.plainMeta?.authorName \|\| 'teammate'}</span>`. Own/unstamped rows and coding sessions (no `plain.viewerId`, never stamped) are pixel-identical |
| `frontend/app/crossmodel/page.tsx` | The plain props hand the view `viewerId: user?.id ?? null` |
| `frontend/app/crossmodel/c1-convergence-smoke.test.tsx` | Matrix row 14 upgraded exactly as the C1 lane prescribed ("replace gap pins (b)/(c) with a render-level pin"): 6 tests — (a) map-time carriage + name resolution, (a2) unresolvable-author fallback, (a3) user-rows-only resolution, (a4) `isPlainTeammateMessage` truth table, (b) positive type pin, (c) render/wiring source pins — replacing the 3 gap pins (41 → 44 tests in the file) |

Zero backend change: `getChatById` already appends `messageAuthors` in both
branches (`crossmodel.service.ts:474–475`, `:533–540`); the converged view's
loader (`CodeSessionView` → `crossModelApi.getChat`) receives it on the
initial load, the paging prepend, and the resync refetch — all three flow
through `mapPlainMessages`.

**Non-goals honored:** no execution-tier merge, no plain-chat plan board, no
new guardrails, no C3 work — the legacy in-page transcript / `AgentSteps` /
page-level panel mount / `canvasWidth` are untouched (the page-level mount
still serves the anonymous/home legacy route).

---

## 3. Execution evidence (this lane, fresh on `b0bddc69`)

| Check | Command | Result |
|---|---|---|
| Smoke matrix | `cd frontend && npx vitest run app/crossmodel/c1-convergence-smoke.test.tsx` | **exit 0** — 1 file, **44 tests passed** (row 14: 6 attribution tests) — 2026-08-30 13:35 UTC |
| Full frontend suite | `cd frontend && npx vitest run` | **exit 0** — 22 files, **461 tests passed** — 2026-08-30 13:35 UTC |
| Verify chain (typecheck → lint → test) | `verify` tool (`.digby/config.json`: backend `tsc --noEmit`, backend+frontend `npm run lint`, backend `npx jest`) | **PASSED: typecheck exit 0, lint exit 0, test exit 0** — 2026-08-30 13:37 UTC |

Lane artifacts: this document + the §2 diff (5 files, +143/−46), one PR from
`digby/session-4291e875`; PR number + merge sha are recorded in ticket
`71b1fec6`'s adminNote (this lane's closing act) alongside these test counts.

---

## 4. What remains for C3 (legacy retirement — design §3)

- Delete the legacy in-page transcript block, `AgentSteps`, the duplicated
  strip helpers (keep plain-session.ts's copies), and the page-level
  WorkspacePanel mounts + `canvasWidth` resize — all still live ONLY for the
  anonymous/guest + home-screen legacy route (`!codeChatId`), which C3 must
  either converge or consciously keep (C0 audit §5 records the product
  decision as OUT OF SCOPE for convergence: anonymous keeps the legacy
  transcript — the deletion boundary runs through that decision).
- The `4777e94a` C3-partial leftovers: any remaining dead legacy branches the
  deletion pass identified but blocked on.
- Design D5's kid-guardrail verification is already satisfied on `main`
  (C3-unblock: kids flip into the unified view with rails honored — registry
  fleet-withholding, `!isKid` ThinkingAd, adult-only Report-issue) — C3 only
  needs to not regress it.
- The flag/toggle machinery is already gone (§1a) — C3 has no flag removal
  left; it is purely the legacy-route deletion + the anonymous decision.

---

*Produced by the C2 panel/composer-convergence lane (Digby Code session branch
`digby/session-4291e875`), 2026-08-30. Every sha, line reference, grep claim,
and test count above comes from a fresh invocation against the lane base
`b0bddc69` in that session.*
