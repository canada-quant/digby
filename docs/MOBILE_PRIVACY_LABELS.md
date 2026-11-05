# Mobile Privacy Labels — mapping data flows to store answers

> **Scope:** the iOS App Privacy label (App Store Connect) and the Play Console
> Data safety form for the Digby mobile app. Every entry maps to an ACTUAL data
> flow in the shipped code — this document is the source of truth for filling
> the store forms at M2 submission time. The iOS `PrivacyInfo.xcprivacy`
> manifest ships in `apps/mobile/PrivacyInfo.xcprivacy` (EAS prebuild copies it
> into the native `ios/` folder at build time).
>
> **Status:** M2-prep (code surface only — no submission; Apple-account items
> are PARKED per owner decision `oq_e70a3c0b`). Last verified against the
> codebase 2026-09-25.

## Tracking

**We do not track.** `NSPrivacyTracking = false`, no tracking domains, no
third-party analytics SDK. The app collects nothing for advertising, and
nothing collected is linked to identity for cross-app tracking purposes.

## Data flows → label answers

| # | Flow (code) | iOS label category | iOS purposes | Play Data safety | Notes |
|---|---|---|---|---|---|
| 1 | **Account auth** — email + password (`POST /api/auth/login`, `register`; `apps/mobile/app/sign-in.tsx`) | Email address — **linked** to identity, not used for tracking | App functionality | Personal — email address; collected, shared = no | Email is the account identity; it is never displayed publicly |
| 2 | **User ID** — the account UUID keys chats, memories, preferences, push tokens (`users.id`, every `userId` FK in `schema.prisma`) | User ID — **linked**, not tracking | App functionality | Personal — user ID; collected, shared = no | |
| 3 | **Chat content** — messages sent (`POST /api/crossmodel/stream/register` + SSE send) and Digby's streamed replies; stored per-account (`crossmodel_chats` → `crossmodel_messages`) | Other user content — **linked**, not tracking | App functionality | Personal — messages/chat content; collected, shared = no | The core product. Deletable per-chat (chat delete) and wholesale via in-app account deletion (Settings → Delete account → `DELETE /api/auth/account`) |
| 4 | **Image attachments** — photos the user explicitly picks via `expo-image-picker` and uploads (`POST /api/crossmodel/upload`) | Photos or videos — **linked**, not tracking | App functionality | Personal — photos; user-initiated upload only, shared = no | Only on explicit user action (the ＋ attach button); no background photo access |
| 5 | **Push token** — Expo Push / APNs / FCM device token registered for "run finished" notifications (`apps/mobile/lib/push.ts` → `POST /api/crossmodel/push/register`) | Device ID — **linked**, not tracking | App functionality | Personal — device ID; collected, shared = no | Permission-gated prompt; registration is best-effort and never blocks chat. Cleared server-side on account deletion (cascade) |
| 6 | **Content reports** — the report-a-message action (`POST /api/crossmodel/reports`) | Not collected for tracking; the report content is moderation data | App functionality (moderation) | Not personal data (moderation records) | `reporterId` is SetNull — reports are anonymized when the reporter deletes their account |
| 7 | **Support contact** — `mailto:digby@digby.ai` (Settings + chat ⋯ menu) | No data collected by the app — the user's own mail client sends the email | — | — | No in-app support form, no support-account creation |

**Not collected:** precise/coarse location, contacts, browsing history (the
in-app web search runs server-side; results render in chat — the app itself
stores no browsing history), purchase data (v1 has no payments — roadmap
§3.3: no IAP, no external billing), biometrics, health, fitness, financial
info, sensitive info, diagnostics beyond crash-free operation, advertising
identifiers.

## Deletion story (the answer to "can users request data deletion?")

**Yes — in-app, self-serve:**

- **Whole account:** Settings → Delete account → password re-auth →
  `DELETE /api/auth/account`. Hard-deletes the user row; all FK-cascade data
  (chats, messages, coding sessions/runs, receipts, push tokens, OAuth
  tokens, memory) goes with it, plus the FK-less memory-fact index and
  context-store user namespace. See `backend/src/modules/auth/auth.service.ts`
  (`deleteAccount`).
- **Per-chat:** delete a chat in the app/web → its messages, files, runs, and
  receipts cascade.
- **Report anonymization:** content reports survive (anonymized) — a
  moderation trail must not vanish with its reporter.

## Play Data safety summary

- Data collected: Personal (email, user ID, chat content, photos on explicit
  upload, device ID for push) — all app-functionality, none shared with third
  parties, none used for advertising.
- Data encrypted in transit: **Yes** (HTTPS to `digby.ai`).
- Users can request data deletion: **Yes** (in-app account deletion).
