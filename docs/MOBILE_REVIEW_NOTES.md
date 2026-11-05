# Mobile App Review Notes — demo account, backend status, age rating

> **Scope:** the reviewer-facing notes for the Digby iOS (App Store) and
> Android (Play) submissions at M2. This is the **M2-prep** version — the code
> surface and documentation only; **no submission happens here** and Apple
> Developer account actions remain **PARKED** per owner decision
> `oq_e70a3c0b` (no D-U-N-S, no App Store Connect, no bundle-id registration).
> Fill the demo credentials in at submission time.
>
> Last verified against the codebase 2026-09-25.

## 1. Demo account (guideline 2.1 — Performance: Completeness)

Reviewers need a functioning account with pre-populated content.

- **Plan:** a dedicated `demo` account created at submission time through the
  public registration flow (`POST /api/auth/register`), email format
  `demo+review@digby.ai` (alias of the ops inbox), a strong stored password
  (in the owner's password manager — NOT in this repo), and a couple of
  seeded chats so the reviewer lands on a populated chat list.
- **Reset procedure:** the account is a normal user account; if a reviewer
  deletes it via the in-app Delete account flow (which works — that is the
  point of 5.1.1(v)), re-register and re-seed before the next submission
  attempt. The seeded content is a few chat transcripts; no special backend
  state is required.
- **What the reviewer can do with it:** sign in, stream a chat reply over
  SSE, attach an image, receive a push (if a build is pushed with push
  credentials configured), long-press a reply to report it, open Settings →
  Contact support, and delete the account.

## 2. Backend live during review (guideline 2.1 — no dead ends)

- The app talks to the production backend at **`https://digby.ai`**
  (`API_BASE_URL` in `apps/mobile/lib/config.ts` — overridable via
  `EXPO_PUBLIC_API_BASE_URL` for dev builds). It is a live, monitored
  service: blue-green deploys, AWS RDS Postgres (ca-central-1), 24/7.
- **No dead-end logged-out states:** every screen guards on auth state —
  `app/index.tsx` redirects to sign-in, and the sign-in screen offers
  registration from the same flow. A signed-out user can always reach sign-in
  → register; a failed session restores automatically via the refresh flow.
- If a reviewer cannot reach the backend during the review window, that is an
  incident, not a state of the app — the app surfaces a retry on the chat
  list (`Something went wrong → Retry`) and never a blank screen.

## 3. Age rating rationale

- **Expected: 12+ (App Store) / Teen (Play).** The app is a general-purpose
  AI assistant. It does not target children (no child-directed design, no
  cartoon mascots, no child-appealing themes), and includes:
  - **User-generated + AI-generated content** with a moderation surface
    (report content → human review; contact support).
  - **Web search** — Digby can fetch and summarize live web content, which
    may occasionally include mature themes; answers are model-generated and
    can be imperfect.
  - No unrestricted mature/sexual/violent content by design; no gambling, no
    purchases (v1 has no payments at all — roadmap §3.3: ship free, no IAP).
- **Questionnaire answers (App Store age-rating form):**
  - Cartoon/Fantasy violence — None; Realistic violence — None
  - Profanity/Crude humor — Infrequent/Mild (model output is filtered but not
    guaranteed)
  - Mature/Suggestive themes — Infrequent/Mild
  - Alcohol/Drug/Tobacco references — None (no depictions)
  - Gambling — False; Unrestricted web access — **True** (the app includes a
    web-search-capable AI assistant)
  - AI-generated content — Yes, with a human-review reporting surface
- **Digby Kids note:** the backend has a child-account mode (`isChild`, a
  locked-down pipeline), but the mobile app does NOT surface child-account
  creation — the mobile app is adult/teen only; rejectChild excludes child
  accounts from the reports + push surfaces. Do not claim "made for kids".

## 4. Guideline coverage map (what to cite in Review notes)

| Guideline | What ships | Where |
|---|---|---|
| 5.1.1(v) account deletion | In-app Settings → Delete account (password re-auth, hard delete + cascade) | `apps/mobile/app/settings.tsx` + `DELETE /api/auth/account` |
| 1.2 / 1.4 UGC moderation | Long-press any message → Report content (10-reason vocabulary) → moderation queue; Contact support in chat ⋯ menu + Settings | `apps/mobile/app/chat/[id].tsx`, `POST /api/crossmodel/reports` |
| 2.1 completeness | Demo account (§1), live backend (§2), no dead-end logged-out states | — |
| Privacy 5.1.1 / Play Data safety | `PrivacyInfo.xcprivacy` + App Privacy label answers documented | `apps/mobile/PrivacyInfo.xcprivacy`, `docs/MOBILE_PRIVACY_LABELS.md` |
| 4.2 minimum functionality | Native navigation (expo-router), push, camera/share-sheet attach, haptic-ready — not a repackaged website | throughout `apps/mobile/` |

## 5. Not in this release (be upfront with reviewers)

- **No payments / IAP** — the app is free; no external purchase links.
- **Sign in with Apple / Google** — email/password only in v1 (guideline 4.8
  applies only when third-party/social login exists, which it does not).
- **Push delivery depends on credentials** — push registration is
  permission-gated and works with Expo Push once EAS credentials are
  configured; without them the app is fully functional, just without
  background notifications.
