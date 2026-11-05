# Windows Client — W1 Parity Core (shipped 2026-09-25)

W1 makes a paired Windows PC a **full peer** of the Mac agent for local-browser and
computer-use tasks, and makes the backend route correctly when both are paired.
The W0 capability handshake (see `docs/WINDOWS_CLIENT_W0.md`) answered *whether* a
device can serve a surface; W1 adds the surfaces themselves and the multi-device
routing on top.

Two halves:

| Half | Where | Review |
|---|---|---|
| The Windows agent's `browser_*` + `computer_*` implementations | `windows-agent/` (agent v0.7.0) | PR #1048 |
| Backend multi-device capability routing | `backend/src/modules/crossmodel/` | the W1 backend PR |

## 1. The Windows agent surfaces (PR #1048)

- **`browser_*`** — a Playwright port of `imessage-agent/src/browser.ts`:
  `launchPersistentContext` with the Digby profile at
  `%LOCALAPPDATA%\Digby\browser-profile`, headless by default with pop-out
  escalation, the lazy one-time Chromium download gate, `chromiumSandbox: true`.
  Method names, request params, and result JSON shapes are byte-compatible with
  the macOS agent — the backend's `LocalBrowserDriver` marshalling is unchanged.
- **`computer_*`** — a `koffi` FFI adapter (`src/win32.ts`, lazily required only on
  win32) over user32/shell32: BitBlt virtual-screen capture → JPEG, SendInput
  scancode typing with the modifier-clearing pre-sweep, GetCursorPos
  verify-or-refuse clicks, `MOUSEEVENTF_ABSOLUTE|VIRTUALDESK` multi-monitor moves,
  GetForegroundWindow/GetWindowTextW frontmost detection, ShellExecuteW open, and
  TokenElevation detection surfaced as a structured `elevation_blocked` error
  (never a silent no-op — the UIPI wall is detectable and model-visible).
- **DPI reconciliation** — pure geometry converts image-pixel → physical-pixel
  coordinates from per-monitor DPI and the virtual-screen origin, and REFUSES on
  unreconcilable mismatch (the Windows analogue of the macOS geometry-reconciliation
  doctrine, roadmap §2.2). The math is Linux-testable and Linux-tested.
- **Test posture** — all pure layers run on Linux CI (`.mjs` node:test importing
  built `dist/*.js`, no `os` gate in package.json); 39+ tests at ship. The FFI
  seam stays behind the W0 `Win32Surface`/`Win32Input` interfaces, so the null
  implementation keeps every non-Windows platform safe.
- **Deferred to W2+** (deliberate, see the roadmap): CDP-attach, WebView2 shell,
  installer/signing; W3: UIA tree dumps + invoke fallback, WGC capture.

## 2. Backend multi-device routing (this PR)

The W0 gates (`computerUseAvailable` / `localBrowserAvailable`) already answered
availability from the advertisement. W1 closes every remaining Mac-only seam so a
Windows box and a Mac **coexist**:

### 2.1 Capability-tagged dispatch → capability-gated claiming

Every broker dispatch now tags the surface it needs: `computer` (computer driver),
`browser` (local browser driver: ping, execute, pop-out, live-view, close),
`imessage` (list_chats / get_messages / send_message). The broker's
`waitForCommand` gains the poller's advertised capability set (the agent's poll
already carries it since W0) and **requeues** a command for a capable poller when
the polling agent lacks the tag — the same contract as the version gate. A poller
with NO advertisement (every pre-W0 Mac) claims everything: legacy fleets are
byte-identical.

### 2.2 iMessage never routes to Windows

`requireOnlineAgent` (chats/messages/send) now selects under an iMessage
capability gate. A Windows-only fleet gets a clean "no paired device can send
iMessage" 404 naming each device's reason, and a mixed fleet picks the Mac. An
explicitly-targeted Windows device is never silently re-routed.

### 2.3 Per-platform computer-use doctrine

`computerToolsForPlatform(platform)` rewrites the vision-model tool descriptions
for Windows sessions — Win key (`key "win"`), `ctrl/alt/shift/win` modifiers,
Chrome/Notepad/Settings examples, "Windows screen" — while macOS (and legacy
null-platform) sessions keep the exact historical toolset. The loop's user-facing
notices (unavailable / busy / first-screenshot failure / first-frame prompt /
vision failure) branch the same way, naming the real failure modes per platform
(Screen Recording/Accessibility on macOS; elevated/UIPI-protected windows on
Windows). The W0 `instructionsForPlatform` model instructions already covered the
prompt side.

### 2.4 Platform-neutral product copy

`browser_task` / `computer_task` tool descriptions, their `device` params, and the
local-browser disclosure brackets now describe "their computer (Mac or Windows
PC)" and "Chrome/Safari/Edge", trigger on "on my PC" as well as "on my Mac", and
teach both no-visible-change failure modes (elevated/UIPI window on Windows,
Accessibility on Mac). The 88915954 separate-profile disclosure is unchanged in
meaning.

### 2.5 Status lines

`localBrowserStatusMulti` per-device lines and the local-fallback gate are
capability-aware (mirroring the primary router gate), and the computer driver's
own status strings say "device" where they said "Mac". macOS strings are
byte-identical wherever the platform is macos/legacy.

## 3. What W2 adds (next milestone)

WebView2 shell + `__digbyDesktop` bridge, NSIS per-user installer, Azure Artifact
Signing in CI, CDP-attach probing both chrome.exe and msedge.exe, wdsi submission,
internal-beta distribution — see roadmap §2.10 and todo bbccd505.

## 4. Verification evidence (W1)

- `backend` jest: the routing suites (`agent-link`, `multi-mac`, `router`,
  `multi-mac-routing`, `computer-tools.platform`) — 131/131 targeted, full suite
  green at ship; `tsc --noEmit` clean.
- `windows-agent` (PR #1048): Linux `npm test` 39/39 at review (plus the
  reviewer-driven scroll-regression and geometry-refusal tests), `tsc --noEmit`
  clean, CI 4/4 on the PR head.
- Adversarial review of PR #1048 (FIX-FIRST findings B1 negative wheel delta,
  N1 silent geometry fallback) fixed on the branch before merge.
