# Mobile M1.5 — Android-First Internal Rollout (EXECUTION BRIEF)

> **Status: IN PROGRESS — code items A/B/C(code)/G complete 2026-09-30;
> D/E/F/H pending owner-console gates (§7).** This is the execution brief
> for **M1.5**, the mobile distribution milestone inserted between M1 and
> M2 on 2026-09-25. It follows the W3/W4 brief pattern
> (`docs/WINDOWS_W3_SHIPPING.md`) applied *before* execution: scope,
> acceptance criteria, CI-testable items, dependencies, effort, execution
> order.
>
> **Why M1.5 exists (the re-cut):** roadmap §3.4's original ladder was
> M0 → M1 (TestFlight + Play internal) → M2 (App Store + Play) → M2.5
> (monetization). M1's *code* shipped (PR #1051) but its *distribution* did
> not — the owner parked the Apple Developer account migration (owner answer
> `oq_e70a3c0b`, 2026-09-25 02:41Z, verbatim: **"Later — park the Apple
> migration, keep Windows/mobile planning moving."**), which parks every
> Apple-account action (bundle-id registration, App Store Connect,
> TestFlight) — and the Android half of M1's distribution never got its own
> milestone. M1.5 is that milestone: **get the shipped M0–M1 app onto real
> Android hardware through EAS Build + the Play internal track, with mobile
> CI green first.** No iOS distribution work in this milestone (it needs an
> Apple account — §7.2).
>
> **UPDATE 2026-09-30 — the Apple park is LIFTED.** The owner answered with
> **"start building the ios and android apps as they will take a longer
> time to get polished"** — so iOS build work is back in scope alongside
> Android. M1.5 remains Android-first only because Android needs no Apple
> account to reach the internal ring; the Apple enrollment / APNs key /
> bundle-id registration stay owner-console gates (§7.2) and are collected
> on the consolidated gate list carried to the owner by the supervisor.
>
> **Parent:** goal 7b830773 "Client platforms phase 3", todo fdb0b724.
> **Companion brief:** `docs/MOBILE_M2_5_STORE_AND_MONETIZATION.md` (M2.5).

---

## 1. Scope

| In scope | Out of scope (and where it lives) |
|---|---|
| Mobile CI job in `.github/workflows/ci.yml` (typecheck `apps/mobile` + `packages/api`) | iOS builds / TestFlight / App Store Connect — **PARKED** (§7.2) |
| App identity assets: icon, Android adaptive icon, splash (`apps/mobile/assets/`) | Store production release — M2.5 Part A |
| `apps/mobile/eas.json` (dev / preview / production build profiles) | Monetization / IAP — M2.5 Part C |
| EAS project wiring + the `projectId` fix in push registration | Sign in with Apple / Google — roadmap §3.4 "Later" |
| FCM v1 credentials for Expo Push on Android (EAS-managed) | Coding-session streaming UI (live runs / plan / diff panels) — README "M1+"; deliberately later: it is product surface, not distribution. Revisit after M2.5-A |
| EAS Android builds (dev-client + internal-distribution AAB) | EAS Update (OTA) — roadmap §3.4 "Later" |
| Play Console **organization** account (owner-gated) + internal track upload | |
| Notification **soft-prompt** timing (roadmap M1 content that shipped as a hard prompt) | |
| On-device validation battery (§5) | |

## 2. Current state (verified in-repo 2026-09-25)

Already shipped and merged to main — M1.5 builds on all of it, changes none of it:

| Milestone | What | PR |
|---|---|---|
| M0 | Expo SDK 57 monorepo scaffold, `packages/api` typed client, auth (SecureStore refresh), chat list + streaming chat screen (Bearer-on-SSE both legs), markdown/code render, image attachments | #1046, #1049 |
| M1 | Push client (`apps/mobile/lib/push.ts` — permission → Expo Push token → register, tap deep-links `digby://chat/<id>`), backend push module (Expo Push / APNs .p8 / FCM HTTP v1, env-gated and **inert without credentials**), `push_tokens` migration (20260925054000 — **runs on next `prisma migrate deploy`**), backgrounding/reconnect (AppState close-on-background, re-attach on foreground) | #1051 |
| M2-prep | In-app account deletion, report-content surface (10-reason vocabulary), `PrivacyInfo.xcprivacy` + privacy-labels doc, review-notes doc | #1054 |

Gaps M1.5 must close (all verified 2026-09-25):

- **No mobile CI**: `.github/workflows/ci.yml` has `shell-scripts` / `backend` / `frontend` jobs only — nothing typechecks `apps/mobile` or `packages/api` on PRs.
- **No `eas.json`**, no `assets/` directory — `app.json` has no `icon`/`splash`; an EAS build today would ship Expo's placeholder icon.
- **`getExpoPushTokenAsync({ projectId: undefined })`** (`apps/mobile/lib/push.ts:62`) — works only with the default project slug resolution; needs the real EAS project id once EAS exists (the M0 README flagged this).
- **Notification permission prompts at sign-in** (`usePushRegistration` requests immediately once signed in) — the roadmap M1 row says "notification soft-prompt": ask after a value moment (first completed run), not at first sign-in.
- **No store/developer accounts**: no EAS project, no Firebase (FCM) project, no Play Console account. All three are owner actions (§7).

## 3. Work items

**A. Mobile CI (no external dependency — do first).** New `mobile` job in
`ci.yml`: `npm install` at the workspace root (workspaces cover
`apps/*` + `packages/*`), then `npx tsc --noEmit` in `apps/mobile` and
`packages/api` (both already have `typecheck` scripts). Keep it off the
deploy-critical path (backend/frontend jobs unchanged). This is the only
M1.5 item that changes CI; a docs-only PR must not need it, but every
M1.5 code PR after it does.

**B. App identity assets.** 1024×1024 icon + Android adaptive icon
(foreground/background layers) + splash, committed under
`apps/mobile/assets/`, wired into `app.json` (`icon`, `android.adaptiveIcon`,
`splash`). Brand color `#7C3AED` (the notification color already in
`app.json`). Source art from the existing web/marketing assets — no new
design work if a 1024 master exists; budget half a day if it must be
produced.

**C. EAS project + build profiles.** Owner runs `eas init` (creates the
project, gets the id) → commit it in `app.json` (`expo.extra.eas.projectId`)
→ add `apps/mobile/eas.json` with `development` (dev-client),
`preview` (internal-distribution APK, easiest sideload),
`production` (AAB for Play) profiles. Fix
`getExpoPushTokenAsync({ projectId: <the real id> })` in `lib/push.ts`.

**D. FCM credentials for Android push.** Create a Firebase project, register
the Android app (`ai.digby.mobile`), and register the FCM v1 service-account
credentials with the Expo project (`eas credentials` / Expo dashboard). No
Apple credentials are involved anywhere in this step. The backend keeps
Expo Push as its transport (it already sends to Expo tokens; only
`EXPO_ACCESS_TOKEN` is optionally needed there for rate limits —
`backend/.env.example` L34).

**E. Play Console organization account (owner paperwork — start day 1).**
$25 one-time. **Organization accounts require a D-U-N-S number** plus
business registration docs, with name/address matching exactly across D&B,
government records, and the Google payments profile (web-verified 2026-09-25;
also Google's own enrollment docs). See §7.1 for the D-U-N-S decision point
— it is the one place the parked Apple work and the Android path share an
artifact. **Testing mandate:** Google's 12-tester/14-day closed-testing
requirement applies to *personal* accounts created after 2023-11-13;
organization accounts are exempt (verify in Console at signup — policy
evolves). Roadmap §4.5 already says: create the account as an organization
from day one.

**F. Build + internal track.** `eas build -p android --profile preview` →
install on real hardware → `eas build --profile production` (AAB) → upload
to the Play **internal track** (fastest review, up to 100 internal testers,
distribution via opt-in link). Internal track is the M1.5 finish line —
production is M2.5.

**G. Notification soft-prompt.** Move the permission ask from sign-in to
after the first completed run in a chat (the value moment), with a
one-screen pre-prompt explaining what the notification is for. Permission
denial must stay a non-blocking path (it already is — registration is
best-effort).

**H. On-device validation battery** (§5 acceptance criteria) on at least:
one physical Android phone (API 33+ for the POST_NOTIFICATIONS path) and,
if available, one tablet/alternate DPI. Emulator only for smoke, never for
sign-off.

## 4. What is buildable/testable in CI now

Nothing mobile runs in CI today (§2). After M1.5 item A lands:

- `apps/mobile` + `packages/api` typecheck on every PR (the same bar the M0
  lane met by hand: `npx tsc --noEmit` exit 0).
- `packages/api` has no test suite today (only `smoke.ts`, which needs a live
  backend) — M1.5 does not add one; note for M2.5 if the client grows.
- EAS builds can run from GitHub Actions later (`eas build` with
  `EXPO_TOKEN`); M1.5 runs them from the CLI/owner laptop — CI-built
  artifacts are an optimization, not a gate.
- Everything else (real-device push, deep links, backgrounding) is
  physical-hardware work — CI cannot cover it, which is exactly why the
  validation battery in §5 is a checklist a human/agent executes on-device.

## 5. Acceptance criteria (the M1.5 definition of done)

- [x] `mobile` CI job green on main (tsc exit 0 for `apps/mobile` AND `packages/api`) — job added, locally proven (npm ci + both tsc exit 0); PR CI run is the green proof
- [x] `apps/mobile/assets/` committed: icon, adaptive icon, splash — wired in `app.json`; no Expo placeholder in a build
- [x] `apps/mobile/eas.json` committed with `development` / `preview` / `production` profiles
- [ ] EAS project id in `app.json` (`expo.extra.eas.projectId`); `lib/push.ts` passes the real `projectId` (no `undefined`) — **code ready** (push.ts reads `Constants.expoConfig.extra.eas.projectId` at runtime); the id itself needs `eas init` (owner)
- [ ] EAS Android dev-client build installs and signs in on real hardware — gated on EAS project + FCM (§7.3)
- [ ] Expo Push token returned on-device; FCM v1 credentials registered with the Expo project — gated on Firebase project (§7.3)
- [ ] Play Console **organization** account created + verified (owner-gated)
- [ ] Production-profile AAB uploaded to the Play **internal track**; app installs from the internal-track opt-in link — gated on Play account (§7.1)
- [ ] End-to-end push: a chat run completed while the app is backgrounded on-device → system notification arrives → tap deep-links `digby://chat/<id>` to the right chat — gated on F (builds)
- [ ] Backgrounding/reconnect verified on-device: stream closes on background, transcript resyncs on foreground, no duplicated or lost messages — gated on F
- [x] Notification soft-prompt: permission asked after first completed run; denial leaves chat fully functional
- [x] `apps/mobile/README.md` updated (EAS id wired; deferred-items list shrunk to the true remainder)
- [ ] Roadmap §3.4 M1.5 row ticked with PR cites; this doc's status header flipped to SHIPPED — **ticked with PR cite on the session-branch PR; header flips to SHIPPED when the hardware items land**

## 6. Effort estimate

| Item | Effort |
|---|---|
| A mobile CI | 0.5 day |
| B assets | 0.5–1 day (0.5 if a 1024 master exists) |
| C EAS project + profiles + projectId | 0.5 day eng + ~1h owner |
| D FCM credentials | 0.5 day (mostly owner console work) |
| E Play Console org account | ~1h owner + **external lead: days–weeks** (verification; D-U-N-S creation up to 30 days if no number exists — lookup is free and instant if it does) |
| F builds + internal track | 1 day |
| G soft-prompt | 1 day |
| H on-device battery + fixes | 1–2 days |
| docs/roadmap tick | 0.5 day |
| **Total eng** | **~5–7 focused days** |

Calendar: ~1–1.5 weeks of engineering, but the **critical path is the Play
Console account's external verification clock** — start E (and the D-U-N-S
decision, §7.1) on day 1, in parallel with all code items.

## 7. Dependencies and owner-gated items

### 7.1 The D-U-N-S decision (the one shared artifact)

The Apple park (goal 09a1ec04: "no D-U-N-S lookup, no App Store Connect…")
was written when D-U-N-S was only the Apple-conversion prerequisite. But a
Play **organization** account needs the *same* D-U-N-S number for the same
legal entity. The lookup itself is a free D&B read (no Apple system is
touched), yet the standing park names it. **Decision for the owner** —
either:

- **(a)** allow the D-U-N-S lookup/creation for the Play account (recommended:
  it is a D&B identifier, not an Apple action; the Apple conversion stays
  parked regardless), or
- **(b)** create a Play **personal** account now for the internal ring and
  accept the org conversion later (Play name change is a payments-profile
  replacement, not an edit — roadmap §3.3) plus, for production access, the
  12-tester/14-day closed-testing mandate that org accounts avoid.

Until the owner answers, items E/F block; A–D, G, H (dev-client ring) do not.

### 7.2 Apple-account actions (park LIFTED 2026-09-30 — still owner-console)

**UPDATE 2026-09-30:** the owner answered `oq_e70a3c0b` with **"start building
the ios and android apps as they will take a longer time to get polished"** —
the Apple park is LIFTED and iOS build work is in scope. What remains
owner-console (no code can do it): Apple Developer **enrollment** ($99/yr —
the individual→company conversion from roadmap §4 Workstream C, or a fresh
decision on seller name), **bundle-id registration** (`ai.digby.mobile`
already reserved in `app.json`), APNs **.p8 key** creation + upload to the
EAS project, and App Store Connect / TestFlight setup. All are collected on
the consolidated owner-console gate list carried to the owner by the
supervisor — code work proceeds meanwhile (the `eas.json` `production`
profile is platform-agnostic; iOS builds start the moment credentials
exist).

### 7.3 Other dependencies

- **EAS account** (free tier: 15 builds/mo per platform per roadmap §3.5;
  production tier ~$19+/mo if outgrown) — owner, ~1h.
- **Firebase project** (FCM v1 credentials; free) — owner, ~1h.
- **Backend deploy**: `push_tokens` migration 20260925054000 must reach prod
  (`prisma migrate deploy`) before on-device push registration can persist —
  rides the next routine deploy wave.
- `EXPO_ACCESS_TOKEN` on the backend (optional, higher rate limits) — ops
  env, `backend/.env.example` L34.

## 8. Execution order (M1.5 internal)

1. **A (mobile CI)** — first PR; every later item lands under its protection.
2. **B + C + G** (assets, EAS wiring, soft-prompt) — pure code/asset PRs, no external dep.
3. **D (FCM)** — needs the Firebase project (owner, day 1).
4. **E (Play Console org)** — owner starts day 1; external clock runs while eng proceeds.
5. **F (build + internal track)** — gated on C+D+E.
6. **H (on-device battery)** — gated on F; fix-forward anything it catches.
7. Docs + roadmap tick — last.

Relative to M2.5: M1.5 finishes first; M2.5 Part A (Android production) can
start its listing/prep work while the M1.5 internal ring soaks — see the
M2.5 brief's execution order.
