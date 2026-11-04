# Digby — macOS desktop app

A real native Mac app: a thin **WKWebView** wrapper around **digby.example.com**. It gives
you a proper `.app` in /Applications, a dock icon, native window + menus
(⌘C/⌘V/⌘R/⌘W), persistent login, and external links that open in your default
browser. No Electron, no Chrome PWA — it uses Safari's engine, so the binary is tiny.

Distribution is **direct download** (a signed + notarized `Digby.dmg` served from
digby.example.com). This is **not** an App Store build — see `../macos-pkg/README.md` notes;
the App Store rejects pure web-wrappers and forbids the iMessage agent's Full Disk
Access. Direct download avoids all of that.

## Prereqs (same as the iMessage installer)
- Xcode **Command Line Tools** (`xcode-select --install`) — provides `swiftc`.
- **Developer ID Application** cert in your login keychain.
- notarytool profile: `xcrun notarytool store-credentials digby-notary --apple-id … --team-id Z5U9T5PUJ3 --password …`

## Build
```bash
cd macos-app
./build-app.sh        # → ../Digby.dmg  (universal, signed, notarized, stapled)
```
It compiles a universal (arm64 + Intel) binary, assembles `Digby.app`, makes an icon
from `frontend/public/icon-512x512.png`, signs with hardened runtime, notarizes the
app **and** the dmg, and staples both. The dmg is a **drag-to-Applications** installer
(Digby sits next to an Applications symlink), and on first launch the app offers to
**move itself into /Applications** (and eject the dmg) if it's run from the disk image
or Downloads — so it can't get stuck running from the wrong place.

## Publish (serve from digby.example.com)
```bash
cp ../Digby.dmg ../frontend/public/Digby.dmg
git add ../frontend/public/Digby.dmg
git commit -m "chore: publish Digby.dmg"
git push origin main
```
Then it's at **https://digby.example.com/Digby.dmg** and we can add a "Download for Mac" button in the UI.

## Bundled iMessage helper (one download, no separate installer)
The app **ships the iMessage agent inside it** (`Contents/Resources/imessage-agent/`:
the Node runtime + the agent from `../imessage-agent`). When you open
**Account → Integrations → iMessage → Connect your Mac** *inside the desktop app*, you
get a single **"Set up iMessage on this Mac"** button instead of a `.pkg` download:
- `IMessageCard.tsx` posts `{type:'setupIMessage', pairingCode, apiBase}` to the native
  bridge (`window.webkit.messageHandlers.digby`).
- `main.swift` writes `~/Library/LaunchAgents/ai.digby.imessage-agent.plist` (pointing at
  the bundled `node` + `dist/index.js`, with `DIGBY_PAIR_CODE`/`DIGBY_API_URL` in the env)
  and `launchctl bootstrap`s it.
- The agent pairs silently (env code) and then prompts for **Full Disk Access** itself
  (drag the revealed `node` into the list). FDA is granted to
  `…/Digby.app/Contents/Resources/imessage-agent/node`, a stable path, so it survives
  web-app updates.

The standalone `../macos-pkg` `.pkg` remains for users on a browser (not the app); the
web UI shows the `.pkg` flow when **not** running inside the desktop shell.

> **Arch note:** the bundled agent's `node` + native `better-sqlite3` are built for the
> **build machine's** architecture (same as the `.pkg`). Build on Apple Silicon → the
> agent is arm64 (fine on Apple Silicon; on Intel Macs the helper won't load). The
> WKWebView shell itself is universal regardless.

## Permissions & DigbyHelper

**The app's own microphone entitlement (0.1.13+, ticket 61823826).** The app is
signed with the hardened runtime (notarization requires it), and under the
hardened runtime **microphone capture is additionally gated by the
`com.apple.security.device.audio-input` entitlement** — `macos-app/Digby.entitlements`.
Without it, `AVAudioApplication.requestRecordPermission` (macOS 14+) /
`AVCaptureDevice.requestAccess(for: .audio)` return `granted=false` immediately
with **no TCC prompt and no entry under Privacy & Security → Microphone** — the
request runs (the in-app denial alert fires) but macOS silently auto-denies it.
Every DMG ≤ 0.1.12 shipped entitlement-less, which is why the mic prompt never
appeared on any Mac even after `tccutil reset`. The build script self-verifies
the entitlement is in the signed binary and fails otherwise.

**Microphone vs the helper's permissions.** The helper needs **three macOS
permissions** (System Settings → Privacy & Security):

| Permission | Pane | What it unlocks |
|---|---|---|
| **Accessibility** | Privacy & Security → Accessibility | Computer control — moving the mouse and typing (the `computer_*` commands, CGEvent input) |
| **Screen Recording** | Privacy & Security → Screen Recording | Screenshots and screen visibility (computer use, image grounding) |
| **Full Disk Access** | Privacy & Security → Full Disk Access | Reading your Messages (`~/Library/Messages/chat.db`) |

**Grants attach to the DigbyHelper binary**, not to "Digby" the app:
`Digby.app → Contents → Resources → imessage-agent → DigbyHelper`. That path is
**stable across web-app updates** (the .app bundle's helper location never moves),
so a grant survives an update. To add it: open the pane, click **+**, and select
the revealed `DigbyHelper` (the card's **Reveal DigbyHelper in Finder** button
highlights the exact file), then toggle its switch ON.

**Post-update relaunch self-heal (agent v0.6.0+).** When the .app bundle is swapped
under a *running* helper — an update while the Mac agent was live — the old process
is a ghost whose TCC grants no longer apply, while System Settings still shows the
switch ON (an owner lost ~24h of computer-use input to exactly this). The helper
now detects the swap (`bundleReplaced()`, dev/ino of its own binary) and either
exits for launchd's `KeepAlive` to restart it from the CURRENT bundle, or reports
`relaunch: true` — the card then shows an amber banner with a **Relaunch helper**
button. Relaunching re-evaluates TCC against the new binary and self-heals.

**Self-update permission loss is closed (agent v0.9.9+, tickets e2915963 + c44b19e9).** The
agent's runtime heal never swaps a byte-identical binary — a re-heal on an
already-healed Mac keeps the existing file (and its TCC grants) instead of
recreating the inode for nothing. When the runtime REALLY changes (the grants
genuinely cannot carry across a new binary), the swap is stamped and the agent
watches every poll for a previously-granted Accessibility / Screen Recording /
Full Disk Access / Calendars flag reading false. Since 0.9.9 the surfacing is
ONE consolidated re-grant card (the older per-key regression message is
suppressed when the card covers the same grants): after every self-update +
relaunch the agent preflights the whole permission surface with NON-REQUESTING
status queries only, and a runtime watchdog classifies call-time TCC denials
(a denied calendar read, the corroborated solid-black capture conviction, the
Full Disk Access block) as a lost grant. The card lists every missing grant
with its System Settings pane and ends with the instruction that matters:
QUIT and RELAUNCH the agent after re-granting — a newly granted permission
only applies to a freshly launched process. The surfacing arrives
IMMEDIATELY — a macOS notification + dialog on the Mac (deep-linking the
Privacy & Security pane) and one Telegram push to you through the backend —
instead of dying at the next `computer_*` dispatch with "Missing macOS
permission(s)" and nobody told (the 2026-10-24 incident: a 0.9.4→0.9.6
self-update silently orphaned Accessibility and a scheduled AWS-console drive
stood down at zero steps). The re-grant itself stays a one-click owner action —
macOS attaches these grants to the exact file — but it is now ASKED FOR the
moment it is needed, not discovered hours later.

**Live status in the app.** Account → Integrations → your Mac shows a per-device
permission checklist (Accessibility / Screen Recording / Full Disk Access, each
✓ granted or ✗ missing) that **updates live** while the card is open and something
is missing — the helper advertises its TCC state on every poll (15s probe TTL), so
the chips flip within seconds of you toggling a switch. The same section carries
**Open System Settings** (jumps to the first missing pane), **Reveal DigbyHelper
in Finder**, and the **Relaunch helper** button. A Mac on agent < 0.6.0 shows
"update the Mac agent to see permission status" instead (legacy agents never
advertise).

## Voice conversation mode (push-to-talk — v0.1.7)
The smallest shippable voice slice, all native side — **no web-app changes**:
- **Press ⇧⌘Space or ⌃⇧Space** (or **Voice → Push to Talk**), speak, **press again to send**.
  `VoiceMode.swift` records with `AVAudioEngine` and transcribes on-device with
  **SFSpeechRecognizer** (first use asks for **Microphone** + **Speech
  Recognition** — the microphone request fires FIRST and unconditionally, so
  Digby always lands in Privacy & Security → Microphone even when Speech was
  previously denied; denial alerts deep-link the exact sub-pane — ticket
  8b13ec2b; the two `Info.plist` usage strings; this native path replaces
  the WKWebView `getUserMedia` route, which cannot record in this shell —
  ticket 00504a77).
- **The composer mic button dictates through the same native recorder**
  (2026-10-20, one composer UI for chats and coding sessions): tap the mic in
  any chat or coding session to start, tap again to stop — the transcript is
  inserted into the composer for you to edit and send (never auto-sent; the
  web app posts `{type:'voice', event:'dictate'}` over the `digby` bridge and
  the shell advertises it with `__digbyDesktop.canDictate`; an older app shows
  a hint naming ⇧⌘Space instead).
- **Long dictation is segmented** (0.1.14, ticket 9255c3f0): the recognizer
  session seals and rotates every 45 s (handing each fresh task a short
  audio-overlap ring so no word is lost or doubled at the seam), so a long
  dictation is no longer truncated to its last few words — and a mid-utterance
  recognizer final no longer ends the session early. The status line (Voice
  menu + window title) shows a **word count, never the transcript text** — the
  dictated words appear only in the composer.
- The transcript is sent through the **already-loaded chat UI** (JS bridge:
  native text-setter + `input` event on the composer textarea, then a synthetic
  **⌘Enter** — the submit gesture for both composer variants), so the reply uses
  your normal modes, streaming, and memory.
- **TTS out rides the web app's own Read-aloud**: a watcher waits for the
  composer's Stop button to appear (run live) then disappear (run done),
  settles 1.5 s, and clicks the newest message's **"Read aloud"** — the proven
  `voiceApi.tts` pipeline speaks the reply. Toggle with **Voice → Speak Replies
  Automatically** (default on). If the button isn't found, you get a status
  hint instead of silence.
- Limits of the slice: press-to-toggle PTT only (**no wake-word**), English
  recognizer (`en-US`), and the reply watcher keys off three DOM anchors in the
  web app (composer textarea, Stop button, Read-aloud button) — a web redesign
  that renames them degrades voice to a status message, never a crash.

## What it does / limits
- Loads `https://digby.example.com/`; stays logged in (persistent data store).
- **File pickers work in-app** (v0.1.9): clicking an attachment/paperclip button
  opens a native open panel. macOS WKWebView has no default one — the shell
  implements `WKUIDelegate.runOpenPanelWith` (ticket 8a25754c); before 0.1.9 the
  click was silently dropped (drag-and-drop still worked).
- Requires **macOS 12+** (native in-app downloads via `WKDownloadDelegate` need 11.3+).
- `digby.example.com`, Google, GitHub and Apple hosts stay in-app (so sign-in works); other
  links open in your default browser.
- **Downloads happen in-app.** Clicking the iMessage helper `.pkg`, the app `.dmg`,
  or any `.pkg/.dmg/.zip/.exe/.msi` downloads it with WKWebView's own downloader
  straight to `~/Downloads`, then reveals it in Finder and opens it (a `.pkg` launches
  Installer). It does **not** hand the URL to the system browser — doing so used to
  route the download to whatever app claims `digby.example.com` (e.g. a leftover Chrome PWA),
  which rendered the raw binary as garbled text.
- **OAuth caveat:** Google sometimes blocks its sign-in inside embedded web views
  ("this browser may not be secure"). Primary digby.example.com login (email) works fine; if a
  Google *integration* connect is blocked, do it once in a normal browser at digby.example.com —
  the session syncs. A v2 can route OAuth through `ASWebAuthenticationSession`.
- If `codesign` throws `errSecInternalComponent` / "unable to build chain", see the
  **Troubleshooting** section in `../macos-pkg/README.md` (almost always a leftover
  "Always Trust" override on your Developer ID cert).

## Updates
- **Web app changes are automatic.** The app loads digby.example.com live, so every web deploy
  shows up on next launch/reload — no rebuild, no re-download.
- **The bundled Mac agent is NOT updated by re-downloading the app or by the app's
  self-update.** The `.dmg` bundles one agent version at build time (stamped as
  `agentVersion` in `desktop-latest.json`, shown next to the download button and on
  the iMessage card). That bundled copy (0.6.3 in the served 0.1.10 DMG) predates
  self-update and can never catch up. The app's one-click "Set up on this Mac"
  installs that copy **only when no self-managed agent exists** — with one present
  (label `com.digby.agent`) it refuses and explains instead of clobbering (ticket
  405927c9), and agent ≥ 0.9.2 retires the old bundled/.pkg jobs automatically.
  To move a Mac to the CURRENT agent, use the one-line
  installer with `--update-only` (Account → Integrations → iMessage shows it when a
  Mac's agent is behind the release): `curl -fsSL https://digby.example.com/install-digby-agent.sh
  | bash -s -- --update-only`. It keeps the existing pairing, stops the app-bundled
  helper, and installs the current release at
  `~/Library/Application Support/Digby/imessage-agent`, which then keeps itself
  updated (ticket 31fd8440).
- **Native shell changes** (this file, menus, download handling) need a new build. The
  app self-checks `https://digby.example.com/desktop-latest.json` on launch (and via
  **Check for Updates…** in the app menu); if it advertises a newer version it offers
  to download the new `.dmg`.
- **To ship a shell update:** bump `VERSION` in `build-app.sh` **and** the `version` in
  `frontend/public/desktop-latest.json` to the same value, rebuild, republish the
  `.dmg`, and commit the json. The build stamps `agentVersion` from
  `imessage-agent/package.json` into the json automatically — keep the hand-stamp
  in sync until the next build. Users on older builds get prompted automatically.

## Customizing
- Home URL / in-app hosts: top of `Sources/Digby/main.swift`.
- Bundle id / version: env vars on `build-app.sh` (`BUNDLE_ID`, `VERSION`).
- The app injects `window.__digbyDesktop = { version }` so the web app can detect the
  desktop shell (e.g. hide the "Download for Mac" button when already running in it).
