# Digby Client Platforms Roadmap — Windows, iOS/Android, and the Apple Developer Account

> **Status:** Phase-1 plan (researched, not yet built) · **Date:** 2026-09-24
> **Scope:** (A) a Windows client with computer-use + browser-use parity to the macOS
> client, (B) full-fledged native iOS and Android apps, (C) migrating the Apple
> Developer account from a personal name to the company.
> **Research base:** current macOS/agent code in this repo (read 2026-09-24) + web
> research against 2025–2026 official docs (Microsoft, Apple, Expo, Playwright) —
> sources cited inline. Key pages are ingested in the 2026-09-24 planning session's
> memory for build-time follow-up.
>
> **⚠ 2026-09-25 WORKSTREAM-C PARK — LIFTED 2026-09-30 (owner answer on
> `oq_e70a3c0b`: "start building the ios and android apps as they will take a
> longer time to get polished"):** the park on Apple-account actions is over —
> iOS build work is in scope alongside Android. The §0/§4.3/§4.5 "start the
> conversion / D-U-N-S lookup NOW" instructions remain **pre-park plan text:
> verify against §4 Workstream C's current state before executing** — the
> Apple enrollment itself is an owner-console action (consolidated gate list,
> see `docs/MOBILE_M1_5_ANDROID_ROLLOUT.md` §7.2). (A) shipped through W4;
> (B) runs Android-first to the internal ring (M1.5), with iOS builds
> unblocked the moment Apple credentials exist. Working plans:
> `docs/MOBILE_M1_5_ANDROID_ROLLOUT.md` (M1.5),
> `docs/MOBILE_M2_5_STORE_AND_MONETIZATION.md` (M2.5).

---

## 0. Executive summary

| Workstream | Recommendation | First ship | Critical path / gate |
|---|---|---|---|
| **A. Windows client** | Reuse the `imessage-agent` Node daemon protocol + a small **Rust helper** (WGC capture, SendInput, UIA) + a **WebView2** shell | Internal beta in ~4–6 weeks of focused work | Azure Artifact Signing identity validation (days) — start it week 1 |
| **B. iOS + Android** | **Expo SDK 57** (`expo-router`, `expo/fetch` streaming, EAS Build/Submit) in a monorepo beside the web app | TestFlight/Play internal in ~3–4 weeks; store release after that | Backend needs Bearer-auth on the SSE route + a push-notification module; **store submission waits for (C)** |
| **C. Apple dev account** | **Convert the existing individual membership to an organization in place** (free, keeps Team ID) | 1–2 weeks typical, 6 weeks worst case | **Owner paperwork** (D-U-N-S + legal-entity docs). Start NOW — it gates the iOS App Store seller name, which is permanent per app record |

**Sequencing rule:** (C) is pure owner paperwork with a multi-week external timeline —
start it today, in parallel with everything. (A) and (B) have no Apple dependency and
can start immediately. The only hard ordering constraint: **do not submit the iOS app
to the App Store until (C) completes** — the seller name is stamped per-app at first
submission and re-submitting under a new seller name later is a much bigger lift
(app-transfer route).

> **⚠ PARKED 2026-09-25 (`oq_e70a3c0b`):** the "start it today" instruction above
> (and §4.3 step 1, §4.5's "Start (C) immediately") is superseded — Workstream C is
> parked by the owner; do not start any Apple-account paperwork. The ordering
> constraint itself remains true and is why the iOS path stays parked while Android
> proceeds (§3.4).

---

## 1. Reference architecture — what we're porting (macOS, as shipped)

Three components, cleanly separated. This layering is what makes the Windows port a
port and not a rewrite.

```
┌────────────────────────┐   ┌──────────────────────────────────┐   ┌─────────────────────┐
│ macos-app/ (Swift)     │   │ imessage-agent/ (Node daemon)   │   │ backend (Express)   │
│ WKWebView shell        │   │ "DigbyHelper" bundled in the app │   │ digby.ai/api        │
│ · loads digby.ai       │   │ · long-poll ⇄ pollCommand       │   │ · pair-link mint    │
│ · native file picker   │   │ · X-Agent-Token auth            │   │ · poll/result park  │
│ · downloads, voice     │   │ · iMessage (chat.db/AppleScript)│   │ · 45s presence gate │
│ · self-update feed     │   │ · browser_* (Playwright)        │   │ · version gates     │
│ · JS↔native bridge     │   │ · computer_* (CGEvent)          │   │ · glm/computer loops│
└────────────────────────┘   └──────────────────────────────────┘   └─────────────────────┘
```

Key facts (verified in-repo 2026-09-24):

- **Agent protocol:** `digby-agent pair` → backend mints a single-use 600s code, agent
  upserts on `(userId, deviceId)` (multi-Mac, PR #1034; 5-device cap; `isDefault`
  routing) → `digby-agent run` long-polls `pollCommand`, executes, `postResult`s.
  Agent token stored SHA-256-hashed server-side; config at
  `~/.config/digby-agent/config.json` (chmod 600) + stable `device-id`.
- **Command surface:** `list_chats`/`get_messages`/`send_message` (iMessage);
  `browser_navigate/get_content/extract/click/type/scroll/screenshot/close`
  (Playwright, persistent Digby-owned profile at `~/.config/digby-agent/browser-profile`,
  headless by default + pop-out + CDP-attach v0.5.0); `computer_screenshot/frontmost/
  click/type/key/scroll/open` (CGEvent input, `screencapture`+`sips` JPEG q75 ≤1568px,
  verify-or-refuse cursor read-back, real-scancode typing with modifier-clearing
  pre-sweep, named-key map incl. Win-key analogue).
- **Backend gates:** `computerUseAvailable()` = paired + online (45s) + agent ≥ 0.3.0;
  browser router does a three-way choice (cloud / local-Mac / computer) with
  `MIN_LOCAL_BROWSER_VERSION`; the loops (glm-loop, computer-loop) live server-side —
  **the agent is a dumb executor; the intelligence is server-side**. This is why the
  same backend can drive a Windows agent unchanged.
- **Distribution (macOS):** `macos-app/build-app.sh` — `swiftc` universal, signs
  inside-out (helper with JIT entitlements, hardened runtime), Developer ID
  Application cert, `notarytool` profile `digby-notary`, staple, DMG +
  `frontend/public/desktop-latest.json` self-update feed (app polls
  `https://digby.ai/desktop-latest.json`; the PWA service worker already passes
  `.exe`/`.msi` download URLs through natively — `sw.js` bypass list).

**What ports as-is, what does not:**

| macOS piece | Windows fate |
|---|---|
| Long-poll agent protocol, pair flow, token auth, deviceId upsert | **Ports verbatim** (Node runs on Windows; `better-sqlite3` is the only native dep and it builds on Windows — but the Windows agent drops chat.db/AppleScript anyway) |
| Playwright local browser driver (persistent profile, headless, pop-out, CDP-attach) | **Ports nearly verbatim** — Playwright is first-class on Windows; CDP attach additionally probes Edge (`msedge.exe`, guaranteed present) |
| Backend loops, router, vision seats | **No change** (add a capability field — §2.7) |
| CGEvent input / screencapture / sips | **Replaced** — SendInput + Windows Graphics Capture + encode step (§2.2–2.3) |
| TCC permissions (Full Disk Access, Accessibility, Screen Recording) | **Gone** — no TCC equivalent for classic Win32; the analog walls are UIPI/secure-desktop/DRM (§2.5) |
| LaunchAgent (user session, KeepAlive) | **Replaced** — logon-started user-session process; a Session-0 Windows Service *cannot* see or drive the desktop (§2.6) |
| Swift/WKWebView shell | **Replaced** — WebView2 shell (§2.8) |
| Developer ID + notarization | **Replaced** — Azure Artifact Signing + NSIS installer (§2.9) |
| iMessage surface | **Dropped** — macOS-only; Windows agent ships browser + computer |

---

## 2. Workstream A — the Windows client

### 2.1 Stack decision

**Node orchestrator (port of `imessage-agent`) + one small Rust helper + WebView2 shell.**

- The daemon keeps the proven architecture: outbound HTTPS long-poll (works behind
  any NAT/firewall — no port forwarding), command dispatch, Observation/result JSON,
  verify-or-refuse discipline. Rewriting this in Rust/C# buys nothing.
- What Node cannot do well on Windows is the Win32/WinRT layer: WGC has no
  first-class Node binding, and shimming SendInput/UIA through FFI is fine for a
  prototype but brittle long-term. So the capture/input/UIA layer is a **single
  static Rust exe** (`digby-helper.exe`) the daemon spawns and talks to over
  stdio/JSON-RPC. Rust via the `windows` crate is the ecosystem consensus for
  exactly this (the `windows-capture` crate wraps WGC and is actively maintained,
  Aug 2026; `IUIAutomation` COM interfaces come from the `windows` crate).
- **Rejected alternatives:** nut.js (prebuilt binaries went commercial, $20–75+/mo;
  the community fork is ~2 years stale — a licensing trap), pyautogui (Python-only,
  latency-bound), Anthropic's computer-use reference (Linux/X11 Docker only — its
  action vocabulary is portable, its implementation is not), Microsoft UFO (UIA-first
  Python agent framework — study it for prompting patterns, don't adopt).

### 2.2 Screen capture

| | GDI BitBlt | DXGI Desktop Duplication | **Windows.Graphics.Capture** ✅ |
|---|---|---|---|
| Perf | slowest (CPU copy) | fastest (GPU, dirty rects) | fast (GPU-composited) |
| Multi-monitor | awkward | same-GPU constraint, needs physical monitor | cross-GPU, no monitor dependency |
| Used by | legacy | older OBS | **OBS display capture, `windows-capture` crate** |

- **v1 parity path:** GDI BitBlt via `koffi` FFI straight from Node — zero native
  toolchain, genuinely adequate for the macOS agent's cadence (one JPEG per action,
  not video). Fails on exclusive-fullscreen games.
- **Production path:** WGC in the Rust helper. Same output contract as macOS:
  JPEG (quality ~75), long edge capped ~1568px, dims readback, base64 in the result
  JSON.
- **The Windows-specific trap — per-monitor DPI scaling.** macOS taught us
  geometry-reconciliation (image-pixel vs physical-pixel coordinates); Windows'
  analogue is DPI virtualization on mixed-DPI multi-monitor setups. The helper must
  do the image-pixel → physical-pixel conversion itself and refuse on unreconcilable
  mismatch (same verify-or-refuse doctrine).
- **Hard limits (all APIs), to model as detectable "camera dark" states:** UAC
  secure desktop (not capturable, even as admin in most configs), DRM/protected
  content and `SetWindowDisplayAffinity` windows (black frames), locked workstation.

Sources: learn.microsoft.com Desktop Duplication API; OBS WGC-vs-DXGI threads;
docs.rs/windows-capture; robmikh capture-sample issues (headless/DXGI monitor req).

### 2.3 Input injection

- **SendInput (user32)** is the standard; no permission prompt needed for
  same-integrity targets — a genuine onboarding win vs macOS TCC.
- **Port the hard-won macOS contracts:** GetCursorPos read-back before clicking
  (verify-or-refuse), real-scancode keyboard events with a modifier-clearing
  pre-sweep (the stuck-shift lessons), named-key table incl. the Windows key,
  scroll with optional verified x/y target.
- **UIPI wall:** SendInput from a normal (medium-IL) agent into an **elevated/admin
  window is blocked**. Microsoft's own agent CLI documents the failure modes:
  "If send-input reports a failure, the target is likely elevated or an AppX app"
  (learn.microsoft.com winapp-cli/ui-automation). Detect elevation
  (`GetWindowLong`/integrity level) and return a structured `elevation_blocked`
  error to the model — never a silent no-op. **Do NOT run the agent elevated by
  default**; if we ever offer an elevated helper it must be an explicit, visible
  install-time choice.
- **Anti-cheat hostility:** SendInput is flagged (`LLMHF_INJECTED`) and online games
  kick for it (CS2 2024–2026). Detect game/anti-cheat processes and refuse
  computer-use there by default; surface the policy.

### 2.4 UIA perception layer (the Windows advantage)

Windows has something macOS lacks: **UI Automation**, a first-class accessibility
tree. Microsoft now ships a first-party agent CLI on top of it (`winappCli` /
`winapp ui`) whose design validates our pattern: most verbs drive apps **through UIA
patterns** (headless/locked-session friendly, works across integrity levels) and only
a fallback set injects real input; it re-resolves the element right before clicking
and fails with `target_moved`/`foreground_not_target` instead of clicking blind —
the same verify-or-refuse contract as our macOS v0.4.3 (the installed build as of 2026-09-26; main is agent 0.6.2 with frontmost-display capture — `docs/IMESSAGE_AGENT.md`).

Plan: the Rust helper exposes UIA tree dumps (via the `windows` crate COM
interfaces) as an **optional perception input** to the model — control-tree context
beats pixel-guessing on Windows demonstrably (UFO's core insight) — and UIA
`invoke`/`set-value` as a deterministic fallback for controls that ignore synthetic
input or sit elevated. Phase this (§2.10): ship pixel+coordinate parity first, add
UIA as a fast-follow.

### 2.5 Permissions story

No TCC. No consent prompt blocks capture or injection for classic Win32 apps —
the entire Windows RPA ecosystem ships without a permissions onboarding flow.
**UX: say so.** Windows 11's Settings → Privacy "Screenshots and screen recording"
per-app toggle exists but governs packaged/UWP surfaces, not classic Win32 (verify
per release — expect this class of gate to expand). Keep the macOS preflight
*contract* though: detect (a) locked/secure desktop, (b) elevated target,
(c) capture-denied/DRM-black windows; return structured, actionable errors to model
and user.

### 2.6 Service model — the Session-0 wall

A Windows Service runs in Session 0, which "cannot create windows visible to users
or interact with the user shell… architectural, not configurable" (Microsoft). So a
service **cannot capture or click the user's desktop**. The pattern every
remote-support/RPA tool uses (TeamViewer, AnyDesk): a **user-session tray/UI process
+ agent started at logon** (Task Scheduler logon trigger primary, HKCU Run key
fallback), no Session-0 service for GUI work in v1. KeepAlive/ThrottleInterval
semantics port to the logon task's restart policy.

### 2.7 Backend changes (small)

- **Capability field instead of version-guessing:** the backend currently infers
  "can do computer use" from `agentVersion ≥ 0.3.0` (`availability.ts`). A Windows
  agent that never ships iMessage shouldn't fake it via version numbers. Add an
  agent-advertised `capabilities: ['browser','computer']` (falling back to the
  version gate for old Mac agents) so router/status strings stay honest
  ("no capable Windows device" vs "no capable Mac").
- The browser router's local-driver marshalling and the computer loop need zero
  changes (they already speak device-agnostic command/result JSON).

### 2.8 Desktop shell

WebView2 wrapper (Edge WebView2 runtime is present on all current Windows
installs): persistent profile (stays logged in), host allowlist, native file picker
(WebView2 has one by default — no macos-app ticket-8a25754c class fix needed),
in-app downloads, relocate-to-`%LOCALAPPDATA%\Digby`, and the
`__digbyDesktop` bridge with `platform: 'windows'` (`window.chrome.webview.postMessage`
is the WebView2 equivalent of `window.webkit.messageHandlers`). Decide at build time:
**C#/.NET (smallest conceptual jump from the Swift shell, single-file publish)** —
or Win32/C++ if we want zero runtime dependency; both are fine, C# recommended for
velocity. The web side already has a `platform` field in the bridge to branch on.

### 2.9 Packaging, signing, distribution

- **Installer:** NSIS, **per-user** install (no UAC on install — matches the
  user-session agent model; Program Files relocation only if we later need UIAccess).
- **Signing: Azure Artifact Signing (formerly Trusted Signing), Basic $9.99/mo**
  (5,000 sigs/mo). Microsoft's recommended non-Store path; no hardware token; CI
  integration (GitHub Actions). Org eligibility: USA/Canada/EU/UK — we're fine
  (Canada). **Sign everything with one stable identity from release 1** — publisher
  reputation accumulates across releases.
- **EV certs no longer buy SmartScreen trust** (removed 2024) — paying the $400+/yr
  EV premium is not justified; OV is functionally equivalent for SmartScreen.
- **The AV problem is real and must be designed for:** a binary profile of
  SendInput + screen capture + HTTPS long-poll + process spawning is textbook
  RAT heuristics; Defender's `Wacatac.H!ml` class routinely quarantines such tools.
  Mitigations: no packers/compression/obfuscation (community-confirmed trigger),
  native-compiled helper (not script-embedding), proactive submission of each
  release at microsoft.com/wdsi/filesubmission, documented enterprise-allowlist
  steps. Budget **weeks of SmartScreen reputation warnings for early adopters**
  regardless of signing.
- **Microsoft Store MSIX lane** (Store re-signs, zero SmartScreen, free): a credible
  later add-on if download friction hurts conversion — not v1 (packaged-identity
  changes the capture/privacy surface).
- Update feed: mirror `desktop-latest.json` → `windows-latest.json` (the web already
  serves the macOS one; the SW bypass list already passes `.exe`/`.msi`).

### 2.10 Phased milestones

| Phase | Deliverable | Contents |
|---|---|---|
| **W0 — spike (week 1)** | `digby-agent` runs on Windows | Node daemon port minus iMessage; GDI BitBlt + SendInput via `koffi`; pairs with a dev backend; `computer_screenshot/click/type` round-trip through the existing computer-loop against a test user. Start Artifact Signing identity validation NOW. |
| **W1 — parity core (weeks 2–3)** | Browser + computer on Windows | Full `browser_*` (Playwright persistent profile at `%LOCALAPPDATA%\Digby\browser-profile`, headless, pop-out) and `computer_*` with verify-or-refuse, scancode typing, named-key map, DPI reconciliation; capability field in backend; multi-device routing works (a Windows box and a Mac coexist). **Shipped 2026-09-25 — see `docs/WINDOWS_CLIENT_W1.md`.** |
| **W2 — ship shape (weeks 3–4)** | Installable client | WebView2 shell + bridge; NSIS per-user installer; Artifact Signing in CI; CDP-attach probes chrome.exe AND msedge.exe (Edge guaranteed present ≈10–14% of users' everyday browser); wdsi submission; internal-beta distribution. **Shipped 2026-09-25 (code + pipeline) — see `docs/WINDOWS_W2_SHIPPING.md`; signing identity validation + first wdsi submission remain OWNER-gated (checklist §1).** |
| **W3 — UIA perception (fast-follow)** | Smarter, safer driving | Rust helper replaces koffi: WGC capture + SendInput + UIA tree dumps + UIA invoke fallback; elevation/secure-desktop/DRM detection surfaces; anti-cheat refusal list. **Shipped 2026-09-25 (code + pipeline) — see `docs/WINDOWS_W3_SHIPPING.md`; backend dispatch half shipped in PR #1064 (uia_tree/uia_invoke behind the 0.9.0 gate, windows-latest.json feed); signing identity validation + first wdsi submission remain OWNER-gated (W3 checklist §6).** |
| **W4 — hardening** | Public beta | Multi-monitor/DPI matrix, locked-workstation behavior, AV-quarantine runbook, Store-MSIX evaluation. **Live-desktop validation shipped 2026-09-25 — see `docs/WINDOWS_W4_LIVE_DESKTOP_VALIDATION.md` (harness + windows-w4-live.yml CI job; 10/10 criteria green on windows-latest, run 36163611290; caught + fixed a real W3 bug: SAFEARRAY dim-0 indexing left every UIA runtime_id empty, making uia_invoke dead on live desktops). Multi-monitor/DPI matrix, locked-workstation, AV runbook, MSIX remain physical-box/beta work (checklist in the doc).** |

Top 3 risks: (1) the elevation wall — mitigate with per-action detection + model-facing
structured errors (never silent failure); (2) AV/SmartScreen quarantine — stable
identity from release 1, no obfuscation, proactive submissions; (3) anti-cheat —
detect and refuse.

---

## 3. Workstream B — iOS and Android apps

### 3.1 Stack decision

**Expo (SDK 57) + expo-router + expo/fetch + EAS.** One TypeScript codebase, ~95%
skill reuse from the Next.js app, cloud builds (no local Xcode dependency),
OTA JS updates (EAS Update), and the escape hatch always open (any native module or
custom Swift/Kotlin via dev builds + config plugins).

| Option | Verdict | Why |
|---|---|---|
| Fully native Swift + Kotlin | No (for now) | 2 codebases, 2 languages, ~2× review surface. Revisit only if deep on-device integrations (App Intents, widgets, Metal) become the product |
| Bare React Native | No | RN docs themselves say "use a framework"; we'd hand-assemble navigation/native modules/builds |
| **Expo** ✅ | **Yes** | SDK 57 stable (RN 0.86, Android API 36, iOS 16.4+); `expo/fetch` is WinterCG-compliant with **native streaming** (`resp.body.getReader()`) — SSE from the existing Express endpoint works with a small adapter |
| Flutter | No | Dart wastes the team's TS/React depth and the markdown/highlight ecosystem |
| Capacitor wrap | No | needs Next.js static export (kills SSR/streaming); CapacitorHttp doesn't patch EventSource (known open gap, capacitor#6582); Apple 4.2 "repackaged website" risk. The PWA already covers that niche |

Chat-app library needs are all covered: `react-native-enriched-markdown`
(Software Mansion, actively maintained — `react-native-markdown-display` is dead),
`react-native-svg`/Skia, `expo-image-picker`, `expo-notifications`, `expo-secure-store`.

### 3.2 Backend touchpoints (the real work is here)

1. **SSE auth — Bearer on the stream route.** Today the chat stream authenticates
   via the `cm_access` cookie only (EventSource can't set headers; see
   `crossmodel.controller.ts` anonymous-arrival handling and the api-client note).
   `expo/fetch` CAN set headers, so the mobile client should stream with
   `Authorization: Bearer <access token>` — this needs the Express auth middleware to
   accept a Bearer token on the SSE route (and on the coding-session/live-run stream
   routes). Bonus: it removes the web app's 15-min cookie-staleness class for mobile.
2. **Push notifications module (new).** Server-side: APNs **token-based auth**
   (.p8 key + Key ID + Team ID — Apple's recommended method, no expiry, one key for
   sandbox+prod; sign a JWT, HTTP/2 to api.push.apple.com) and **FCM HTTP v1**
   (`firebase-admin`, service account with FCM Admin role; use the Play Console
   app-signing-key SHA-1 in Firebase, not the upload key). Client-side: start with
   **Expo Push Service** (one token for both platforms, credentials managed by EAS) —
   drop to direct FCM/APNs only if its throughput limits ever matter. Add a
   `push_tokens` table + register/unregister endpoints; fire on run-completed /
   attention-needed events (the fleet already has the event plumbing). Deep links
   (`digby://chat/<id>` + universal links/app links) for notification taps.
3. **Streaming lifecycle on mobile is NOT push.** iOS suspends the app and kills
   sockets seconds after backgrounding; Android 15 cuts background network in 3–5s.
   Pattern (what chat apps do): close the SSE stream on `AppState` background,
   re-open on foreground, **resync via the existing REST transcript endpoints**;
   push notifications carry the "your run finished" signal when backgrounded. The
   backend's detached-run model already guarantees a dropped connection never kills
   a run — the mobile app is just a reconnecting viewer. Keep the heartbeat;
   reconnect-with-backoff on cellular.
4. **Auth:** v1 = existing email/password against `/api/auth/*`, 15-min access token
   in memory + refresh flow via `expo-secure-store` (Keychain/Keystore). Later:
   Sign in with Apple (iOS) + Google Credential Manager (Android) for guideline-4.8
   parity — add only when we add a third-party/social login, which 4.8 requires
   Apple-sign-in to accompany.
5. **Monorepo:** `apps/mobile` beside the web app; extract the API client + shared
   types into `packages/api` (standard Expo-monorepo pattern; the existing
   `frontend/.../api-client.ts` is the seed).

### 3.3 Store-policy essentials (what gets AI chat apps rejected)

Verified against the App Review Guidelines (Jun 2026 revision) and current analyses:

| Risk | Rule | Mitigation |
|---|---|---|
| Charging for AI usage without IAP | **3.1.1** | **Ship v1 free** (no end-user billing exists in the backend today — all "billing" code is provider latches, so this is a green-field decision, not a retrofit). When payments land: IAP everywhere except the US storefront (US allows external links without entitlement since May 2025, post-Epic); never a bare Stripe link in-app |
| Repackaged website | **4.2** | Native navigation, haptics, push, camera/share-sheet — the app must *feel* native (the anti-Capacitor argument); PWA already covers the webview niche |
| UGC / AI-output moderation | **1.2 / 1.4** | Visible report/block/contact in-app; a content-filtering story for AI output; reviewers actively probe AI apps for harmful output |
| Completeness | **2.1** | Demo account in review notes; backend live during the review window; no dead-end logged-out states |
| Account deletion | **5.1.1(v)** + Play equivalent | In-app account deletion (plus the web link) — **required by both stores** |
| Privacy | 5.1.1 / Play Data safety | `PrivacyInfo.xcprivacy` manifest + App Privacy labels matching actual behavior (SSE + push + attachments data flows) — strictly enforced at upload since 2024/2026 |
| Age rating | — | Answer honestly; expect 12+/13+ with age-appropriate controls rather than 4+ |
| Seller name | — | **The seller name on the first submission is permanent for that app record — this is why (C) must complete first** |

Google Play: $25 one-time; org account required for finance/health/VPN categories
(not us); name-change there is a payments-profile *replacement*, not an edit.

### 3.4 Phased milestones

| Phase | Deliverable | Contents |
|---|---|---|
| **M0 — scaffold (week 1)** | `apps/mobile` in the repo | Expo monorepo, `packages/api` extraction, email/password login with SecureStore refresh, chat list + chat screen with SSE via `expo/fetch` (Bearer), markdown/code rendering, image attachments through the existing upload endpoints. **Shipped 2026-09-25 — PRs #1046, #1049.** |
| **M1 — internal (weeks 2–3)** | TestFlight + Play internal track | Push (Expo Push + backend module + token registration + deep links), backgrounding/reconnect behavior, notification soft-prompt; backend Bearer-on-SSE shipped. **Code shipped 2026-09-25 — PR #1051; distribution (TestFlight + Play internal) did NOT ship — the Apple half was parked (oq_e70a3c0b, lifted 2026-09-30), the Android half is re-cut as M1.5.** |
| **M1.5 — Android-first internal rollout** | EAS builds + Play internal track | The distribution half of M1: mobile CI job, app identity assets, `eas.json` + EAS project wiring (incl. the push `projectId` fix), FCM v1 credentials, Play Console **organization** account, dev-client + internal-track builds, notification soft-prompt, on-device validation battery. **In progress 2026-09-30 — code items A (CI job) / B (assets) / C (EAS profiles + projectId fix) / G (soft-prompt) complete; D/E/F/H gated on owner consoles — see `docs/MOBILE_M1_5_ANDROID_ROLLOUT.md` §5/§7.** |
| **M2 — store release (after (C) completes)** | App Store + Play | Account deletion in-app; 1.2 compliance surface; age questionnaire; demo account + review notes; privacy manifest + labels; submission. **No payments in this release.** Compliance code surface shipped 2026-09-25 (PR #1054 — `docs/MOBILE_REVIEW_NOTES.md`, `docs/MOBILE_PRIVACY_LABELS.md`); submission is re-cut into M2.5 Part A (Play, proceeds) / Part B (App Store, PARKED with the Apple migration). |
| **M2.5 — store release + monetization** | Play production + Android-only subscriptions | **Re-cut 2026-09-25 for the parked-Apple world.** Part A: Play production release (listing, Data safety, content rating, staged rollout) — proceeds when M1.5 lands. Part B: iOS store path — **PARKED with Workstream C** (oq_e70a3c0b). Part C: monetization — RevenueCat + Play Billing on Android only; iOS IAP/StoreKit stays parked with Part B; the US external-link experiment is deferred (no surface needed for an Android-only launch). **Planned — see `docs/MOBILE_M2_5_STORE_AND_MONETIZATION.md`.** |
| **Later** | — | Sign in with Apple + Google sign-in; share sheet/widgets (expo-widgets, App Intents); EAS Update OTA hotfixes; direct FCM/APNs if Expo push limits bite |

Costs: Apple $99/yr (already paying), Google $25 once, EAS free tier (15 iOS
builds/mo; ~$19+/mo production).

### 3.5 What mobile is NOT

Not a computer-use target — iOS/Android cannot drive the OS the way the desktop
agents do, and we shouldn't pretend otherwise. The mobile apps are the chat +
runs + notifications + files surface; device control stays on Mac/Windows agents.
(The PWA remains the installable web fallback and gains nothing from being wrapped.)

---

## 4. Workstream C — Apple Developer account: personal → company

**Goal:** the App Store / notarized builds say the company name, not a person's name.

### 4.1 The mechanism

Apple **converts the membership in place** — still the officially supported path in
2026 (the old `/support/upgrade/` URL 404s; the content moved to Account Help):

> "If you'd like to update your membership from an individual to an organization,
> please submit a request. You'll need to be the founder/cofounder of the
> organization and provide details such as your organization's D-U-N-S Number."
> — developer.apple.com/help/account/membership/updating-your-account-information

No second $99 membership, no app transfers.

### 4.2 Prerequisites (all required)

1. **A real legal entity** — LLC/corp. **DBAs, trade names, and branches are
   rejected outright.** (If the business is a sole proprietorship, Apple says stay
   individual.)
2. **D-U-N-S number** — free lookup first (many companies already have one):
   developer.apple.com/enroll/duns-lookup/. If it must be created: up to
   **5 business days** from D&B + **2 more** to propagate to Apple. The D-U-N-S
   record's legal name/address must match the entity exactly — stale D&B records
   are the #1 cause of delays (fix at dnb.com *before* submitting; 2 business days
   to propagate).
3. **Founder/cofounder authority** (that's the owner) + a work email on the org's
   domain.
4. **A functional public website** on that domain (registrar placeholders and
   social-links-only are rejected). digby.ai qualifies.
5. Possibly **notarized business documents** (Apple's enrollment page: notarized
   copies "to certify that the copy you intend to provide to Apple is a true copy").

### 4.3 The exact steps

1. Look up / request the D-U-N-S number **today** (it's the longest-lead item).
2. Gather paperwork: legal entity name exactly as in D-U-N-S, registered
   address/phone, articles of incorporation / business license (notarized if asked),
   Apple ID with 2FA, Team ID.
3. Submit the request as the Account Holder:
   **https://developer.apple.com/contact/request/migrate-individual-account**
   (sign-in gated; also reachable from Membership Details → "Submit a request").
   **While submitting, ask Apple to confirm in writing that the Team ID is
   unchanged** (see 4.4).
4. Apple verifies: automated D-U-N-S match (minutes–hours) → phone/email authority
   check (1–5 business days) → possibly a DocuSign Account Transfer Agreement →
   legal review. **Timeline: typically 1–2 weeks, worst-case reports up to 6 weeks.**
   Stuck >2 weeks on "Processing your membership migration"? Reply to the case email
   or call Apple Developer Support with the case number.
5. Completion email ("Your Apple Developer membership has been updated") → confirm
   the new legal entity in App Store Connect → Agreements, Tax & Banking.

**Caveat during the wait:** practitioner reports say conversion can **temporarily
lock publishing** on some accounts. If we need to ship the macOS app mid-conversion,
ask Support to allow interim submissions.

### 4.4 What survives vs. what changes

| Item | Effect |
|---|---|
| Team ID (`Z5U9T5PUJ3`), Apple ID/login, App Store Connect records | **Believed to survive unchanged** — practitioner-reported (Church Plant Media, Choicely), **not Apple-documented** — hence "confirm in writing" in step 3. If Apple ever surprises with a *new* Team ID, stop and re-verify everything (that would be fresh-enrollment semantics, not conversion) |
| Existing Developer ID Application/Installer certs | **Keep working** (same Team ID, not revoked) — already-notarized macOS builds keep verifying |
| `digby-notary` notarytool profile | **Unaffected** — App Store Connect API key + profile are account-scoped, not name-scoped |
| New Developer ID certificates | CN will carry the **company name** — create a fresh Developer ID Application cert after conversion and use it for the **next** macOS release; re-sign + re-notarize that release so Gatekeeper starts showing the company name. Old builds stay valid; no forced re-release |
| Seller name on apps | Becomes the company name — **for apps submitted after conversion**. An app already submitted under the personal name keeps that seller name on its record (why the iOS app must wait) |
| `identifierForVendor` (IDFV) | Apple documents that an org-name *change* resets IDFV for existing users; it does **not** say whether individual→org conversion triggers it. Irrelevant pre-first-app, but if attribution ever matters, ask Apple |

### 4.5 Sequencing with the other workstreams

- **Start (C) immediately** — it's owner paperwork with an external 1–6 week clock,
  and it gates the iOS App Store seller name. Nothing else waits on it except the
  M2 store submission.
- macOS and Windows work is unaffected (notarization keeps working; Windows uses
  Microsoft signing, not Apple's).
- Google Play has no dependency on Apple's conversion; create that account as an
  organization from day one ($25, one-time) and avoid the same problem there.

---

## 5. Cross-workstream plan (what to do in what order)

```
Week 0 (now):   ── Owner: D-U-N-S lookup + submit Apple conversion (C) ──
                ── Start Azure Artifact Signing identity validation ──────
                ── Eng: W0 Windows spike + M0 Expo scaffold, in parallel ─
Week 1–2:       Windows W1 (parity core)  ‖  Mobile M0→M1 (Bearer SSE + push)
Week 3–4:       Windows W2 (installer/shell/beta)  ‖  Mobile M1 TestFlight/Play-internal
Week 5+:        Apple conversion lands (typical) → Mobile M2 store submission
                Windows W3 (UIA/Rust helper) → W4 public beta
Later:          Mobile M2.5 RevenueCat subscriptions; macOS re-sign under company cert
```

> **2026-09-25 re-cut (owner `oq_e70a3c0b`: "Later — park the Apple migration,
> keep Windows/mobile planning moving") — park LIFTED 2026-09-30 ("start
> building the ios and android apps as they will take a longer time to get
> polished"):** as executed, the plan ran W0–W4 through Windows (§2.10 ticks)
> and mobile M0→M1 code (PRs #1046, #1049, #1051, #1054). The forward path is
> now: **M1.5** (Android-first internal rollout — EAS + Play internal; code
> items A/B/C/G done 2026-09-30, D/E/F/H on owner consoles) → **M2.5 Part A**
> (Play production release) → **M2.5 Part C** (monetization). With the park
> lifted, the iOS store path (**M2.5 Part B**) unblocks as soon as the Apple
> enrollment lands — it no longer sits behind Workstream C. Briefs:
> `docs/MOBILE_M1_5_ANDROID_ROLLOUT.md`,
> `docs/MOBILE_M2_5_STORE_AND_MONETIZATION.md`.

Shared backend changes, in dependency order (all independent of the clients, can
land first):
1. Capability field on agents (unblocks honest Windows routing) — small.
2. Bearer-auth on SSE routes (unblocks mobile streaming) — small, test with curl.
3. Push-notification module + token registration (unblocks mobile M1) — the biggest
   single backend item.
4. `windows-latest.json` update feed endpoint (trivial, mirrors the macOS one).

## 6. Open questions for the owner (non-blocking)

- Exact legal entity name + jurisdiction for the Apple conversion paperwork (needs
  to match D-U-N-S exactly).
- Whether the Windows shell should be C# (recommended) or C++ — velocity vs
  zero-runtime-dependency.
- App pricing/subscription intent for mobile v1 (the plan assumes free v1; payments
  as M2.5).
- Branding: bundle ids for the mobile apps (e.g. `ai.digby.app` / `ai.digby.ios`) —
  pick once, they're permanent.

---

*Sources (primary): Apple Account Help (membership update, D-U-N-S, enrollment,
Developer ID certs), developer.apple.com App Review Guidelines (Jun 2026 rev);
Microsoft Learn (winapp-cli/ui-automation, Desktop Duplication API, Artifact
Signing, code-signing options, Session 0 isolation); docs.expo.dev (SDK versions,
authentication, secure-store, push/FCM credentials); playwright.dev MCP
configuration + playwright issues #35928/#39483; capacitor#6582; docs.rs
windows-capture; github.com microsoft/UFO + microsoft/winappCli + OpenAdaptAI;
gs.statcounter.com; Church Plant Media + Choicely conversion write-ups; PTKD
3.1.1 analysis. Full ingested pages retrievable from the 2026-09-24 planning
session memory.*
