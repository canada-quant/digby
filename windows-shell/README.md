# Digby for Windows — the desktop shell (W2)

A thin native host around **https://digby.example.com/crossmodel**, the Windows port of
the macOS shell (`macos-app/Sources/Digby/main.swift`). C#/.NET 8 + WinForms +
[Microsoft Edge WebView2](https://learn.microsoft.com/microsoft-edge/webview2/) —
chosen per roadmap §2.8 ("smallest conceptual jump from the Swift shell,
single-file publish"). Self-contained single-file publish means **no runtime
dependency** on user machines: no .NET install, no admin rights, one `Digby.Shell.exe`.

The web app it hosts is the same digby.example.com everyone uses — every web deploy shows
up on next launch. The shell only adds: a persistent login profile, an in-app
host policy, the desktop bridge, close-to-tray, and an update check.

## Layout

| File | Role |
|---|---|
| `Digby.Shell.csproj` | .NET 8 WinForms project; self-contained single-file win-x64 publish; only NuGet dep = `Microsoft.Web.WebView2` |
| `Program.cs` | entry point, single-instance mutex + second-launch activation, `ApplicationConfiguration.Initialize()` (PerMonitorV2 DPI) |
| `MainForm.cs` | the window, WebView2 wiring, host allowlist, new-window/download/bridge event handlers, menu, tray, update prompt, and the bounded bootstrap (2026-10-09 hang fix) |
| `Bridge.cs` | the `__digbyDesktop` flag + WebKit shim (exact injected JS) + message dispatch |
| `HostPolicy.cs` | `KeepInApp(host)` — the keep-in-app allowlist (port of `main.swift:10-19`) |
| `WindowPlacement.cs` | window size/position persistence (`%LOCALAPPDATA%\Digby\window.json`) |
| `UpdateCheck.cs` | `windows-latest.json` feed fetch + dotted-numeric version compare |
| `StartupPanel.cs` | the visible startup/error panel over the WebView2 (2026-10-09 hang fix) |
| `ShellLog.cs` | append-only log at `%LOCALAPPDATA%\Digby\shell.log` (bridge no-ops land here; every boot milestone since the hang fix) |
| `installer/digby.nsi` | NSIS 3 per-user installer |
| `installer/build-installer.sh` | CI-runnable build: `dotnet publish` + `makensis` |

## Build & run

Requires the **.NET 8 SDK** and Windows (or a Linux/macOS box for a cross-build):

```bash
# from windows-shell/
dotnet run                      # dev run

dotnet publish -c Release -r win-x64 -o publish
# Linux cross-build adds: /p:EnableWindowsTargeting=true
# → publish/Digby.Shell.exe  (~170MB self-contained single file)

bash installer/build-installer.sh   # publish + NSIS → dist/Digby-Setup.exe
```

CI builds the shell + installer on `windows-latest`
(`.github/workflows/windows.yml`): `dotnet publish -o publish\shell` →
makensis runs the .nsi **from the repo root with no defines** (it is
CWD-independent) → the installer lands at **`publish\Digby-Setup.exe`**, is
uploaded as the workflow artifact, and is signed when the six `AZURE_*`
secrets are configured.

## The bridge

Two scripts are injected via `AddScriptToExecuteOnDocumentCreatedAsync` (the
WebView2 equivalent of the macOS `WKUserScript` at `documentStart`):

```js
window.__digbyDesktop = { version: "1.0.0", platform: "windows", canSetupIMessage: true };

window.webkit = window.webkit || { messageHandlers: { digby: {
  postMessage: (msg) => window.chrome.webview.postMessage(msg)
} } };
```

- **The flag** mirrors the macOS shell's `main.swift:47-56` with two changed
  values: `platform: "windows"` and `canSetupIMessage: true` — since 2026-10-06
  the bundled agent runs on Windows too (digby-win-helper + Node runtime), so
  the web app's one-click iMessage setup UI renders on both platforms.
- **The WebKit shim** is the piece that makes the port a zero-frontend-change
  drop-in: the web app sends its messages through
  `window.webkit.messageHandlers.digby.postMessage(...)` (a WebKit-only API —
  `IMessageCard.tsx:143`); WebView2's host channel is
  `window.chrome.webview.postMessage`. The shim routes one to the other and
  never overwrites an existing `window.webkit`.

### Message table (web → shell)

Dispatch port of `main.swift:215-233`: the body must be a JSON object with a
string `type`; anything else is **silently ignored** (parity with macOS).

| `type` | Payload | Windows action | macOS action |
|---|---|---|---|
| `setupIMessage` | `{ pairingCode?: string, apiBase?: string }` | spawns the **bundled agent** (`Path.Combine(AppContext.BaseDirectory, "agent")`) with `DIGBY_PAIR_CODE` + `DIGBY_API_URL` env, hidden window, stdout/stderr → `%LOCALAPPDATA%\Digby\agent.log` | writes `~/Library/LaunchAgents/ai.digby.imessage-agent.plist` + `launchctl bootstrap` |
| `disconnectIMessage` | *(none)* | accepted, logged no-op | `launchctl bootout` + delete plist |
| `voice` | `{ event, phase?, reason? }` | accepted, ignored | routes to `VoiceMode.swift` |
| *(anything else)* | any | silently ignored | silently ignored |

The web sends `setupIMessage` when the user submits the one-click setup form
(rendered only when `canSetupIMessage` is true — always true since the bundled
agent landed). `disconnectIMessage` stays a logged no-op: the Windows path
disconnects via the web app's per-device controls (`disconnectAgent`), not a
shell message. Shell → web traffic is none: the web app never
listens for messages from the shell (verified across `frontend/` this run —
the only `postMessage` send-site in the web app is the one above).

### What the web app reads

| Read | Where (web) | Effect in this shell |
|---|---|---|
| `window.__digbyDesktop` truthiness | `use-voice-composer.ts:34-36`, `IntegrationsTab.tsx:1375`, `page.tsx`, `CodeSessionView.tsx` | hides the browser mic button (voice is macOS-shell-only), Slack OAuth append `&desktop=1` (handoff page instead of 302 dead-end) |
| `canSetupIMessage` | `IMessageCard.tsx:133-137` | `true` → one-click iMessage setup (this shell ships `true` — see the injected-flags section); macOS-unset → download/pairing-code fallback |
| `platform` / `version` | *(nothing reads them today)* | set anyway (future-proof; the roadmap's §2.8 note about a platform branch is not yet implemented in the web) |

## Startup (bounded bootstrap — the 2026-10-09 hang fix)

Owner report that drove this: *"i have it installed on my windows laptop
currently but when it opens it just spins forever."* The shell used to render
NOTHING of its own during startup: a hung WebView2 init await left a blank
white client area, the only log line in the whole boot path was the
`CreateAsync` exception, and the first navigation had no completion handler —
a hang and a failed navigation looked identical, and neither was logged.

Now:

- **`StartupPanel`** (`StartupPanel.cs`) covers the blank client area during
  boot: a loading state ("Opening Digby…" with an elapsed-seconds readout that
  names the log file once it climbs), and an error state + Retry button when
  any boot step fails or times out. The panel dismisses on the first
  successful `NavigationCompleted`.
- **Every init await is bounded** (`MainForm.WithTimeout`):
  `CoreWebView2Environment.CreateAsync` 30s, `EnsureCoreWebView2Async` 30s,
  both `AddScriptToExecuteOnDocumentCreatedAsync` 15s. On timeout the milestone
  is logged and the panel shows what hung and what to do about it.
- **Milestone logging** end to end (`%LOCALAPPDATA%\Digby\shell.log`): init
  started (version/OS/exe), environment ready (runtime version), core ready,
  scripts registered, navigating, first navigation completed/failed, plus
  `ProcessFailed` (browser/renderer death), every `SourceChanged` hop, and
  the second-launch single-instance path (a wedged first instance used to
  make every later launch a silent no-op).
- **Honest UA**: `Chrome/131` was frozen (~2 years stale) and contradicted the
  runtime's own current-Chromium client hints — a spoofing signal to
  bot-management. Now pinned to the current stable Chrome major (155 as of
  2026-10); bump it with release cadence.
- The **update check runs before the WebView2 awaits** (it used to run at the
  end of init — a failed bootstrap returned before it, so a broken install
  could never be told a fix exists).

The web app has its own half of the fix (default axios timeout + auth-boot
retry banner in `app/crossmodel/page.tsx`) — the in-page spinners the shell
hosts could also hang forever; see `frontend/lib/api-client.ts`.

## Host policy (keepInApp)

`digby.example.com`, `*.digby.example.com`, and anything containing `google.com`, `github.com`,
`githubusercontent.com`, or `apple.com` stays **in-app** (so primary login and
the Google/GitHub/Apple OAuth flows work inside the shell). Any **user-clicked**
link to another host is cancelled and opened in the **OS default browser**.
Non-user-initiated navigations (JS, redirects) always stay in-app — same rule
as the macOS shell (`main.swift:151-163`). `target=_blank` / `window.open`
loads in the **same** webview (never a popup window) — OAuth popups must not
escape.

## Downloads

WebView2's native download experience stays on: default UI, default Downloads
location, any file type. The shell only logs each download starting. (macOS
filters `pkg/dmg/zip/exe/msi` and reveals in Finder — see deviations.)

## Updates

On launch and via **File → Check for Updates…** the shell fetches
`https://digby.example.com/windows-latest.json` (the Windows mirror of the macOS
`desktop-latest.json` feed — same shape: `{version, url, notes?}`), compares
dotted-numeric versions (`1.10` > `1.9`), and on a newer version offers to
**open the download URL in the default browser**. It never self-updates and
never downloads the installer in-app — W2's deliberate simplification (the
per-user NSIS installer owns installation). A feed fetch failure is silent.

**Version bump checklist:** a Windows version bump must move THREE strings
together — `Digby.Shell.csproj` `<Version>`, `installer/digby.nsi`
`APPVERSION`, and the `windows-latest.json` feed `version`.
`frontend/app/windows-feed-pins.test.ts` pins feed == csproj == NSI at source
level — run `npx vitest run app/windows-feed-pins.test.ts` in `frontend/`
locally BEFORE pushing a bump; the C# files only build on Windows runners, so
CI catches the drift only after the release ships (reviewer NIT, 2026-10-25).

## Close-to-tray (the "close hides, not quits" port)

The red ✕ **hides** the window and shows a tray icon (Digby keeps running, the
web session stays alive — the port of `main.swift:95-100`; Windows has no Dock,
so the NotifyIcon is the equivalent). Double-click the tray icon (or "Open
Digby" in its menu) to restore. **Exit** — tray menu or File menu — is the real
quit. The tray icon appears only after the first hide.

## Deviations from the macOS shell

| Area | macOS | Windows (this shell) | Why |
|---|---|---|---|
| Close semantics | ✕ hides window; Dock icon reopens | ✕ hides to NotifyIcon; tray reopens | no Dock on Windows; NotifyIcon is the standard equivalent |
| Update download | loads the new `.dmg` through the in-app downloader | opens the download URL in the default browser | W2 rule: never self-update, never download in-app; the installer owns install/upgrade |
| Update feed | `desktop-latest.json` | `windows-latest.json` (new feed file — CI/infra to host it) | separate artifact streams |
| iMessage setup | `setupIMessage` writes a LaunchAgent | `setupIMessage` spawns the bundled agent (`<exe>\agent`, `DIGBY_PAIR_CODE` + `DIGBY_API_URL` env, hidden window) | same one-click contract via the W3 agent (since PR #1299, 2026-10-06) |
| Voice mode | push-to-talk + reply watcher (`VoiceMode.swift`) | none | macOS-shell-native feature, W3+ candidate |
| Downloads | filtered to `pkg/dmg/zip/exe/msi`, saved to `~/Downloads`, revealed in Finder | WebView2 native download UI, any type | WebView2 already ships a complete download experience |
| First-run relocation | offers move to `/Applications` | none (installer puts it in `%LOCALAPPDATA%\Programs\Digby`) | per-user installer removes the ran-it-from-Downloads trap |
| User agent | Safari-like | Chrome-like, **without** the `Edg/` token | same rationale (site compatibility in embedded web views); plain-Chrome UA avoids sites taking Edge-specific paths |
| Window placement | `setFrameAutosaveName` (OS-provided) | `%LOCALAPPDATA%\Digby\window.json` | no OS API for it; includes off-screen recovery |
| Downloads of the agent | `.pkg` in-app | bundled into the installer's optional "Digby Agent" section (W3: `publish/agent/` → `$INSTDIR\agent`, own HKCU Run key `DigbyAgent`) | Windows agent ships as an installer section, not an in-app download |

## The installer (`installer/digby.nsi`)

NSIS 3, **per-user**, `RequestExecutionLevel user` — **no UAC prompt**, no
admin rights, nothing in HKLM or `C:\Program Files`:

- Installs to `%LOCALAPPDATA%\Programs\Digby` (the per-user convention).
- Start-menu shortcut (always) + optional desktop shortcut.
- **Opt-in autostart**: an unchecked-by-default section writes
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\Digby` — or pass
  `/AUTOSTART` on the installer command line to pre-check it (silent:
  `Digby-Setup.exe /S /AUTOSTART`).
- Uninstaller removes shortcuts, the Run key, files, and the HKCU entries.
  It **deliberately keeps `%LOCALAPPDATA%\Digby`** (the WebView2 login
  profile, window state, `shell.log`) so uninstall+reinstall does not log the
  user out; a full wipe is a manual folder delete, documented above.
- Add/Remove Programs entry is HKCU (per-user "Apps & features" — standard
  for per-user installs).

`installer/build-installer.sh` (bash, runs on `windows-latest` CI and Linux
dev boxes): checks for the .NET 8 SDK, `dotnet publish`s the shell (adding
`/p:EnableWindowsTargeting=true` when cross-building from Linux), stages
**the W3 agent bundle** to `publish/agent/` (agent `dist/` via npm
build, production-only `node_modules/`, the cargo-built
`digby-win-helper.exe`, the official `node.exe` win-x64 runtime, and
`launch-agent.bat` — every stage skippable, `DIGBY_SKIP_AGENT_BUNDLE=1`
skips the whole thing), then compiles
`digby.nsi` with makensis (auto-detecting the windows-latest NSIS path or a
Linux `makensis`), passing its local layout as defines
(`-DPUBLISH_DIR=..\publish -DAGENT_PUBLISH_DIR=..\publish\agent
-DDIST_DIR=..\dist` — the .nsi's defaults are the
CI layout). Without NSIS it warns, runs textual sanity checks
(balanced Section/SectionEnd, key directives present) and exits 0.

The installer's **"Digby Agent (browser + computer use)"** section
(default ON, `SecAgent`) copies that bundle to `$INSTDIR\agent\` and writes
its OWN per-user autostart (`HKCU\…\Run\DigbyAgent` →
`launch-agent.bat`) — deliberately SEPARATE from the shell's opt-in
autostart (independent lifecycles). The uninstaller terminates the agent
processes, removes both Run keys and the agent dir; user data
(`%LOCALAPPDATA%\Digby`, including `agent.log`) is kept per the W2 policy.

## What's next (W4+, other lanes)

- **Hardening** (roadmap W4): multi-monitor/DPI matrix, locked-workstation
  behavior, AV-quarantine runbook (the signed helper helps), Store-MSIX
  evaluation.
- **Windows-agent E2E on a paired box** — CI covers compile + protocol +
  pure units; WGC/UIA/SendInput against a live desktop is W4 scope
  (see docs/WINDOWS_W3_SHIPPING.md §6).
- **Hosting `Digby-Setup.exe`** publicly (digby.example.com or an Azure blob) —
  owner-gated; today the artifact lives in GitHub Actions (30-day
  retention).
- Voice mode — if product wants it on Windows.
