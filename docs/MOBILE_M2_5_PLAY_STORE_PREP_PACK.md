# Mobile M2.5 — Play Store prep pack (preparable-before-ORG)

> **Scope:** every Play-side M2.5 Part-A item that can be fully prepared
> BEFORE the Play Console ORG account exists (owner gate `oq_fee2d8eb`).
> Items that HARD-DEPEND on the ORG account are listed at the bottom only
> for orientation — nothing here waits on them. Build input verified:
> PR #1168 MERGED (mergeCommit `104eec4d1`, 2026-09-30T19:25:02Z,
> ancestry-checked on `origin/main`), which shipped `apps/mobile/eas.json`
> (production AAB profile + `submit.production`), assets, and the CI mobile
> job. Source docs: `MOBILE_M2_5_STORE_AND_MONETIZATION.md` §3/§7,
> `MOBILE_PRIVACY_LABELS.md`, `MOBILE_REVIEW_NOTES.md` §3,
> `MOBILE_M1_5_ANDROID_ROLLOUT.md` §7.
>
> **Status:** M2-prep, verified 2026-10-01. This is a drafting pack — no
> store console is touched.

## 1. Store listing drafts

| Field | Play limit | Draft | Chars (verified `wc -c`) |
|---|---|---|---|
| Title | ≤30 | `Digby AI — Best of Every AI` (preferred) or `Digby: Ask Once, Get Every AI` | 29 / 29 |
| Short description | ≤80 | `Ask once, get the best of every AI — chat, deep research, and code in one app.` | 80 |
| Full description | ≤4000 | see §1.1 draft below (~1,100) | — |
| Category | — | Productivity | — |
| Contact email | — | **reconcile first** — see §1.2 | — |
| Privacy-policy URL | required | `https://digby.ai/crossmodel/privacy` — see §5 | — |

⚠ The M2.5 doc's own title candidate ("Digby AI — Ask once. Get the best of
every AI.") is **46 chars — over Play's 30-char limit and invalid as-is**.
Both replacement candidates above were byte-counted at 29.

### 1.1 Full-description draft (≤4000)

> Digby is a multi-model AI assistant: ask once, and it orchestrates several
> frontier AI models in parallel — then blends their answers into one
> reliable response.
>
> ASK ANYTHING
> • Quick answers from a fast lead model
> • Cross-checked answers (an independent second model verifies the first)
> • Deep research: a multi-model research council for hard questions
> • Live web search baked into every answer
>
> BUILT FOR REAL WORK
> • Long-running coding sessions — watch edits, tests and PRs stream live
> • Attach images and screenshots
> • Streaming, real-time responses with a stop button
> • Chat history synced with digby.ai
>
> YOUR DATA, YOUR CONTROL
> • In-app account deletion — everything goes, self-serve
> • No tracking, no ads, no data sold or shared
> • Report any AI-generated message for human review
>
> Free to start. Sign in with your digby.ai account.

### 1.2 Contact email — DISCREPANCY to reconcile

`MOBILE_M2_5_STORE_AND_MONETIZATION.md` says `support@digby.ai`; every other
source — the shipped app's Settings + chat ⋯ menu (`mailto:` link), the
mailbox Digby actually authenticates as (`docs/EMAIL_AS_DIGBY.md`:
`DIGBY_SMTP_USER=digby@digby.ai`), and `MOBILE_PRIVACY_LABELS.md` flow #7 —
use **`digby@digby.ai`**. Before the listing is filed: either provision a
`support@digby.ai` mailbox/alias, or correct the M2.5 doc + listing to
`digby@digby.ai`. Default recommendation: **use `digby@digby.ai`** (it is
the verified, monitored mailbox today).

## 2. Data-safety form draft (from MOBILE_PRIVACY_LABELS.md — 1:1, no invented flows)

Header answers:

- **Data collected:** Yes (personal data only)
- **Data encrypted in transit:** Yes (HTTPS to digby.ai)
- **Users can request data deletion:** Yes (in-app: Settings → Delete
  account → password re-auth → `DELETE /api/auth/account`; per-chat delete
  also available)

Per-type rows (all: purpose = **App functionality**, shared = **No**,
collected = **Yes**):

| Data type | Play Data-safety entry | Flow backing it |
|---|---|---|
| Email address | Personal — email | account auth (`sign-in.tsx`) |
| User ID | Personal — user ID | account UUID keys all data |
| Messages / chat content (Other user content) | Personal — messages | `crossmodel_chats` → `crossmodel_messages` |
| Photos and videos | Personal — photos | `expo-image-picker`, explicit ＋ attach only |
| Device or other IDs | Personal — device ID | push token registration (opt-in, best-effort) |

**Declare as NOT collected** (verify nothing regressed before submitting):
location, contacts, browsing history (web search runs server-side; the app
stores none), financial info / purchases (v1 has no payments), biometrics,
health, fitness, diagnostics beyond crash-free operation, advertising IDs.
**No tracking** (`NSPrivacyTracking=false`, no analytics SDK, no tracking
domains).

## 3. Content-rating (IARC) questionnaire answers (from MOBILE_REVIEW_NOTES.md §3)

Expected rating: **Teen** (Android).

- Violence (cartoon/fantasy + realistic): **None**
- Profanity / crude humor: **Infrequent/Mild** (model output filtered, not guaranteed)
- Mature/suggestive themes: **Infrequent/Mild**
- Alcohol/drug/tobacco references: **None**
- Gambling: **False**
- **Unrestricted web access: TRUE** (web-search-capable AI assistant — this is the Teen driver)
- AI-generated content: **Yes** — with a human-review reporting surface
  (report message → `POST /api/crossmodel/reports`; contact support)
- **Not made for kids** — no child-directed design; the backend child-account
  mode is NOT surfaced in the app. Never claim "made for kids".

## 4. Asset inventory (needed vs in-repo)

| Asset | Play requirement | In repo today (dims verified `file`) | Action |
|---|---|---|---|
| App icon | 512×512 min, 32-bit PNG | `assets/icon.png` 1024×1024 RGB | ✅ none |
| Adaptive icon foreground | 1024×1024 rec. | `assets/adaptive-icon.png` 1024×1024 RGBA | ✅ none |
| Splash (not a Play req) | — | `assets/splash-icon.png` 1024×1024 RGBA | ✅ none |
| **Feature graphic** | **1024×500, PNG/JPG** | ❌ **missing** | generate (brand violet #7C3AED, tagline "Ask once. Get the best of every AI.", no device-frame clichés; keep key art in center 80% — Play crops edges) |
| **Phone screenshots** | **min 2** (min 320px, max 3840px; ≤8MB) | ❌ **missing** | capture from a production-profile build: chats list, streaming chat, settings (delete-account + report surfaces visible for review-proof) |

Screenshot capture is fully preparable now (`eas build --profile preview`
APK or local `expo start` + emulator); no Console access needed.

## 5. Privacy-policy URL — VERDICT (live-checked 2026-10-01)

- `https://digby.ai/crossmodel/privacy` → **HTTP 200**, real policy page,
  "Last updated: October 1, 2026" — **use this URL.**
- `https://digby.ai/privacy` (what the M2.5 doc implies) → **HTTP 404** —
  do NOT use; correct the M2.5 doc when next edited.

## 6. Production rollout runbook + halt criteria (from M2.5 §3A3)

**Before rollout:** internal track (M1.5) live and smoke-tested; listing +
data safety + IARC filed; screenshots uploaded.

**Staged rollout (production track):**

1. `eas build --profile production` (AAB, autoIncrement, channel
   `production`; `submit.production` configured) → upload → promote from
   internal to **production**.
2. Start at **10–20%**, hold **≥48h**, watching: crash-free users, ANR
   rate, Play vitals (Android vitals dashboard), review stream.
3. Step to **50%**, hold ≥24h clean → **100%**.
4. v1 ships **free, no IAP** (Part C is a later release — minimal review
   surface, matches roadmap §3.3).

**HALT criteria (any one ⇒ halt rollout, fix, ship a NEW build — do not
"ride it out"):**

- crash-free users **< 99%**
- ANR rate **> 0.47%** (Play's bad-behavior threshold)
- any spike of 1-star reviews naming a **reproducible defect**

**Escalation:** halt in Play Console (stop staged rollout — already-released
users keep the build) → reproduce → fix on a branch → CI mobile job green →
new production build at versionCode+1 → restart rollout at 10%.
If a halt was triggered by a policy/rejection issue rather than a crash,
re-run the §A4 policy re-check (account deletion works, data safety matches
shipped flows, no unexpected permission declarations, moderation surface
reachable) before resubmitting.

## 7. Items that HARD-DEPEND on the Play Console ORG account (NOT preparable)

- ORG account signup + free D&B lookup / D-U-N-S (owner, `oq_fee2d8eb`;
  M1.5 item E + §7.1)
- Every Console form: listing fields, data-safety form, IARC questionnaire
  submission, production-track promotion, staged-rollout percentages
- Play policy re-check happens at submission time against the shipped build
- Part C (IAP) additionally waits on the owner's product/pricing decision (C1)

Everything in §1–§6 above is done or doable without any of these.
