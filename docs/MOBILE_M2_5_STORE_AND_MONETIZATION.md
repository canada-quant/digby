# Mobile M2.5 — Android Store Release + Monetization (PLANNING BRIEF)

> **Status: PLANNED — not started.** Execution brief for **M2.5**, the final
> mobile milestone of the client-platforms program, re-cut on 2026-09-25 for
> the parked-Apple world. Companion brief: `docs/MOBILE_M1_5_ANDROID_ROLLOUT.md`
> (M1.5 — read §1–2 there for the shipped-state table; not repeated here).
>
> **The re-cut:** roadmap §3.4's M2 was "App Store + Play" with M2.5 as
> "RevenueCat subscriptions" after it, and §3.4's original M2.5 row read
> "monetization — RevenueCat (StoreKit 2 + Play Billing 8) — IAP outside
> the US; optional US external-link experiment". With the Apple Developer
> account migration **PARKED** (owner answer `oq_e70a3c0b`, 2026-09-25
> 02:41Z, verbatim: "Later — park the Apple migration, keep Windows/mobile
> planning moving."), the iOS half of both is parked with it. The owner's
> instruction for this lane: **"The Android store path proceeds when
> ready."** So M2.5 re-cuts into three parts:
>
> - **Part A — Play production release** (the Play half of original M2;
>   the M2-prep code surface from PR #1054 is its compliance base).
> - **Part B — PARKED: iOS store + everything Apple-account** (§4).
> - **Part C — Monetization** (original M2.5): **Android-only IAP** via
>   RevenueCat + Play Billing; iOS IAP stays parked with Part B.
>
> **⚠ Park LIFTED 2026-09-30** (owner on `oq_e70a3c0b`: "start building the
> ios and android apps as they will take a longer time to get polished"):
> Part B is no longer parked indefinitely — it unblocks when the Apple
> enrollment + APNs credentials exist (consolidated console-gate list:
> `docs/MOBILE_M1_5_ANDROID_ROLLOUT.md` §7.2). Sequencing is unchanged:
> A → C remain first (Android internal ring → production → monetization);
> B follows once iOS builds are on devices. The "parked-Apple world"
> framing below is retained as the 2026-09-25 record.
>
> **Parent:** goal 7b830773 "Client platforms phase 3", todo fdb0b724.

---

## 1. Scope

| Part | In scope | Out of scope |
|---|---|---|
| **A — Play production** | Play Console listing (store listing, Data safety, content rating, screenshots), production track promotion from the M1.5 internal ring, production rollout (staged %), staged-rollout monitoring + halt criteria, Play policy re-check against shipped surface | iOS App Store anything (Part B) |
| **B — PARKED** | Nothing — planning only (§4: what unblocks, what it costs) | All Apple-account actions |
| **C — Monetization** | Backend: plan/entitlement model (free tier + subscription tier), entitlement gate, webhook receiver for Play Billing (RTDN via Pub/Sub), RevenueCat project + entitlement mapping. App: paywall UI, upgrade/restore flows, Play purchase flow, `react-native-purchases` SDK | iOS IAP / StoreKit 2 (parked with Part B); US external-link experiment (defer — no US-storefront external-link surface is needed for an Android-only launch); pricing decisions (owner, §6) |

**Deferred beyond M2.5** (roadmap §3.4 "Later"): Sign in with Apple /
Google sign-in; share sheet / widgets / App Intents; EAS Update OTA;
direct FCM/APNs if Expo push limits bite. Coding-session streaming UI on
mobile stays deferred as in M1.5.

## 2. What is buildable/testable in CI now

- **Backend (Part C server half):** the entitlement model, webhook receiver,
  and gate are ordinary Express + Prisma surface — unit-tested with jest like
  every other module, full CI coverage from day one. Play webhooks are
  testable with recorded/fixture payloads (Google publishes RTDN payload
  shapes); a live Pub/Sub subscription is integration-tested manually.
- **App (Part C client half):** `apps/mobile` typecheck (once the M1.5
  `mobile` CI job exists); paywall/purchase flows beyond tsc need real
  devices + a Play license-tester account — same class as M1.5's §5 battery.
- **Part A:** nothing is CI-testable — listing content, Data safety form,
  content rating, staged rollout are all Play Console work against the live
  app. The CI-testable part of A is simply "the production AAB builds via
  `eas build --profile production` and the app passes the M1.5 §5 battery on
  the release build".
- **Compliance surface (already shipped, PR #1054):** account deletion
  (in-app, Settings), report/block/contact surface, `PrivacyInfo.xcprivacy`
  + `docs/MOBILE_PRIVACY_LABELS.md`, `docs/MOBILE_REVIEW_NOTES.md` — the
  Play Data safety answers are already mapped to actual data flows; Part A
  transcribes them into the Console form.

## 3. Work items

### Part A — Play production release

**A1. Store listing.** Title (≤30 chars: "Digby AI — Ask once. Get the
best of every AI."), short description (≤80), full description (≤4000),
icon + feature graphic (1024×500) + phone screenshots (min 2, from the
M1.5 asset work; production-quality captures of chats list / streaming
chat / settings), category (Productivity), contact details (support@
digby.ai), privacy-policy URL (the live web one — verify it renders), a
Data-safety section filled from `docs/MOBILE_PRIVACY_LABELS.md`.

**A2. Content rating questionnaire** (IARC): answers from
`docs/MOBILE_REVIEW_NOTES.md` §3 — expect **Teen** (unrestricted web
access via the AI's server-side search; user + AI-generated content with
moderation surface; no gambling, no purchases until Part C).

**A3. Production track.** `eas build --profile production` AAB → upload →
promote from internal (M1.5) to **production**, staged rollout: start at
10–20%, hold ≥48h watching ANR/crash rates + Play vitals, step to 50%,
100%. **Halt criteria** (define before rollout): crash-free users <99%,
ANR rate >0.47% (Play's bad-behavior threshold), or any spike in
1-star reviews mentioning a reproducible defect → halt rollout, fix,
new build. Target: **first production release = free, no IAP** (Part C
ships in a later release — keeps review surface minimal and matches
roadmap §3.3 "ship v1 free").

**A4. Play policy re-check** against the shipped surface before each
release: account deletion works (Play requires it too), Data safety matches
actual flows, no background-location/contacts/sms declarations, AI-content
moderation surface reachable (report + contact support), no misleading
claims. The M2-prep docs are the checklist source.

### Part B — PARKED (iOS store + Apple account)

See §4. Nothing executes here. Planning note only: when the owner re-opens
Workstream C, the iOS path is: Apple conversion completes (roadmap §4) →
EAS iOS credentials → TestFlight (original M1's iOS half) → App Store
submission (original M2's iOS half) — the code surface is identical to
Android's; only store/console work differs.

### Part C — Monetization (Android-only IAP)

**C1. Product decision (owner-gated, do first — §6).** Free tier limits +
subscription tier(s) + price points. Nothing downstream is buildable
without it.

**C2. Backend entitlement model.** New `subscriptions`/`entitlements`
tables + a `billing` module: entitlement read on the paths that gate
(plan enforcement), Play RTDN webhook receiver
(`POST /api/billing/play/webhook` — Pub/Sub push, authenticated by OIDC
token verification), grace-period + account-hold handling (Play's
subscription lifecycle states: active/grace/account_hold/canceled/
expired → mapped to entitlement states), RevenueCat REST calls as the
alternative to raw RTDN (pick ONE source of truth — recommended:
RevenueCat, and the backend consumes RC webhooks instead of raw Play
webhooks; one integration, works for iOS the day Part B unblocks).
**No provider credentials in code/logs** (same discipline as the push
module, `backend/src/modules/crossmodel/push/push.service.ts`).

**C3. App purchase surface.** `react-native-purchases` (RevenueCat's SDK;
free tier, no Apple dependency) → paywall in Settings + a gate moment
(wherever the free-tier limit is hit) → purchase flow via Play Billing →
restore purchases → entitlement reflected on next app start. The paywall
must render and degrade gracefully when Play is unavailable.

**C4. Store compliance for paid tier.** Play Billing policy: all digital
goods through Play Billing (no external payment links in-app for digital
goods — the US external-link carve-out is Stripe-class external *for
goods*, and irrelevant while Android-only with Play Billing); price
displaying in local currency; a functional free tier must remain (the
"free tier + limits" product decision from C1 becomes a policy
requirement, not just a design choice); Data safety + listing updated
(purchases now collected); Tax settings in Play Console (Google handles
most jurisdictions as merchant of record for Play Billing).

## 4. PARKED — Apple items (owner `oq_e70a3c0b`)

**Everything Apple-account stays parked: App Store submission, Apple
Developer individual→company conversion, bundle-id registration in Apple
systems, App Store Connect, TestFlight, iOS EAS credentials, iOS IAP
(StoreKit 2), `PrivacyInfo.xcprivacy` *submission* (the manifest itself is
shipped and harmless).** What unblocks them: the owner re-opening
Workstream C (roadmap §4.3) — or an explicit owner decision to publish iOS
under the existing personal seller name, which is NOT recommended because
the seller name is permanent per app record (roadmap §3.3/§4.4) and would
forever show a person's name. The Apple-side cost when it unblocks:
conversion typically 1–2 weeks (worst case 6) + TestFlight/App Store
review on top. **Nothing in Parts A or C touches any Apple system — that
is the design constraint that lets the Android path proceed now.**

## 5. Acceptance criteria

**Part A — Play production:**
- [ ] Store listing complete (title/short/full descriptions, icon, feature graphic, ≥4 phone screenshots, category, contact, privacy URL)
- [ ] Data safety form filled, answers matching `docs/MOBILE_PRIVACY_LABELS.md` exactly
- [ ] IARC content rating completed (expected Teen)
- [ ] Production AAB built (`eas build --profile production`) and passing the M1.5 §5 battery on a release build
- [ ] Internal-track soak ≥1 week with no open P1/P2 before production promotion
- [ ] Staged rollout executed (10–20% → 50% → 100%, ≥48h holds) with vitals green at each step; halt criteria pre-written in the release notes
- [ ] Play policy re-check pass recorded (account deletion, Data safety, moderation surface, no over-declared permissions)
- [ ] First production release ships FREE (no IAP) — Part C is a later release

**Part B — PARKED:** no criteria — nothing scheduled. Unblocking
conditions documented (§4) and the iOS release checklist sketched for the
day it unblocks.

**Part C — Monetization (separate later release):**
- [ ] Owner product decision recorded: free-tier limits, tier(s), price points
- [ ] Backend: entitlement model + webhook receiver + grace/account-hold states, unit-tested (jest) — green in CI
- [ ] App: paywall + purchase + restore flows on-device against Play license testers; entitlement reflected server-side
- [ ] Data safety + listing updated for purchases; Play Console tax profile set
- [ ] No Apple surface touched (iOS paywall code may compile behind the same RN-Purchases SDK but no iOS credentials/IAP configuration — stays parked)

## 6. Effort estimate

| Part | Item | Effort |
|---|---|---|
| A | A1 listing + assets | 1–2 days |
| A | A2 content rating | 0.5 day |
| A | A3 production + staged rollout | 0.5 day eng + 1–2 weeks calendar (internal soak + staged holds + Play review — first-review latency typically days) |
| A | A4 policy re-check | 0.5 day |
| B | (parked — none) | 0 |
| C | C1 product decision | owner-gated (days of owner thought, not eng) |
| C | C2 backend entitlement + webhooks | 3–5 days |
| C | C3 app purchase surface | 3–4 days |
| C | C4 compliance + tax | 1 day |
| — | docs + roadmap tick | 0.5 day |

**Eng totals: Part A ≈ 3–4 focused days (spread over ~2–3 weeks calendar
with soak/review holds); Part C ≈ 7–10 focused days after the owner's
product decision.** Part A first, Part C in a later release.

## 7. Dependencies

- **M1.5 complete** (internal ring live, `mobile` CI job, assets, EAS
  wiring) — hard prerequisite for Part A.
- **Play Console org account** (M1.5 item E; also resolves the D-U-N-S
  decision, M1.5 §7.1) — hard prerequisite for both A and C.
- **Owner decisions:** D-U-N-S/Play-account-type (M1.5 §7.1); Part A
  rollout timing; Part C product/pricing (C1) + when to schedule Part C
  at all.
- **Play review latency** (external): first production review typically
  days; plan no time-critical launch around it.
- **Backend deploy waves** for the Part C module + any entitlement
  migrations (routine).
- **NOT a dependency:** anything Apple (parked, §4).

## 8. Execution order

1. **Part A after M1.5's internal soak** — A1/A2 listing prep can start
   the moment M1.5's F lands (the app exists; the listing describes it);
   A3 production promotion after ≥1 clean internal-track week; A4 before
   each release.
2. **Part C strictly after Part A's production release** — a free
   production app live in the store first, then the paid tier as its own
   release (keeps each review surface small). C1 (owner decision) can run
   in parallel with all of Part A — it gates only C2–C4.
3. **Part B never executes** until the owner un-parks Apple; the day it
   un-parks, the sequence is roadmap §4.3 (conversion) → iOS EAS
   credentials → TestFlight → App Store, reusing everything A/C built.

Program view: M1.5 (internal ring) → M2.5-A (Play production) → M2.5-C
(monetization) — with M2.5-B parked indefinitely per the owner. When all
three movable parts are done, the client-platforms program's mobile
workstream is complete for the parked-Apple world.
