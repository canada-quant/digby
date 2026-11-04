# Digby Windows Agent (W3 — Rust helper + UIA perception)

Digby's Windows client agent — the roadmap W3 milestone of
[docs/CLIENT_PLATFORMS_ROADMAP_2026-09.md](../docs/CLIENT_PLATFORMS_ROADMAP_2026-09.md) §2.
It gives Digby **browser use + computer use on the user's own Windows PC**, over
the SAME outbound long-poll channel as the macOS agent (`imessage-agent/`).
The backend's loops (glm-loop, computer-loop) are device-agnostic — this agent
is a dumb executor; the intelligence stays server-side.

```
Digby web UI ──▶ Digby backend ──(parks a command)──▶ [ long-poll ] ◀── digby-win-agent (this)
                                                                          • browser_*  (W1 — Playwright) ✅
                                                                          • computer_* (W3 — Rust helper) ✅
                                                                          • uia_tree/invoke (W3 — UIA perception) ✅
                                                                          • cdp-attach (W2 — Chrome/Edge) ✅
                                                                          • NEVER iMessage (macOS-only)
```

**Status: W3 (Rust helper + UIA perception, 2026-09-25).** `browser_*`
(Playwright persistent profile), `computer_*` (SendInput + **Windows Graphics
Capture** with the GDI fallback, via the Rust helper `digby-win-helper`),
**UIA perception** (`computer_uia_tree` / `computer_uia_invoke` — the semantic
tree alternative to pixels), and **CDP-attach** (the owner's everyday Chrome
**or Edge** in a dedicated tab, `src/cdp-attach.ts`) are all LIVE, at contract
parity with the macOS agent. `AGENT_VERSION` is `0.9.1` (0.9.1 = the
4424ebd6 helper-locator fix — the shipped bundle installs the exe at the
bundle root BESIDE `dist/`, and 0.9.0 probed only inside `dist/`, so a fresh
install could pair but never run computer_*; 0.9.0 = W3 UIA perception;
0.8.0 = W2; 0.7.0 = W1 parity core; 0.6.0 was never released — the W0
scaffold). The desktop
shell + installer live next door in
[`../windows-shell/`](../windows-shell/) — W3 bundles this agent INTO that
installer. Full protocol + shipping detail:
[docs/WINDOWS_W3_SHIPPING.md](../docs/WINDOWS_W3_SHIPPING.md).

## W2 — what shipped

### CDP-attach: the owner's everyday Chrome **or Edge** (`src/cdp-attach.ts`)

Port of `imessage-agent/src/cdp-attach.ts` (ticket 4258335e) with the W2
dual-browser rule: when a browser task carries `attach: true` AND the owner's
master switch is on, the agent runs the task in a **dedicated new tab of the
owner's existing, signed-in everyday browser** instead of Digby's separate
profile — the structural fix for anti-bot escalation against a fresh
zero-history profile.

- **Both browsers attach-eligible**: the `/json/version` `Browser` header
  distinguishes Chrome (`Chrome/131…`) from Edge (`Chrome/131… Edg/131…`);
  `isAttachBrowser()` accepts either (Edge is guaranteed present on Windows
  and is ~10–14% of users' everyday browser, roadmap §2.10). Non-Chromium
  endpoints (a stray `node --inspector` on the port) are refused before the
  wasted connect attempt.
- **Two off-by-default gates, both required** (the macOS contract): the
  owner's master switch `browserCdpAttach: true` in
  `%USERPROFILE%\.config\digby-agent\config.json` (or
  `DIGBY_BROWSER_CDP_ATTACH=1`) AND the backend's per-task `attach: true` —
  never a default, never sticky beyond one session.
- **The probe**: a single 2 s-bounded GET of `http://127.0.0.1:<port>/json/version`
  (port = `browserCdpPort` config > `DIGBY_BROWSER_CDP_PORT` env > 9222) that
  never throws. No `/json/list`, no retries. Any failure → graceful fallback
  to Digby's own profile; the observation's `mode` field reports what actually
  drove (`attached` | `digby-profile`), so the backend's disclosure wording can
  never misname it.
- **Hard safety rails in the owner's browser** (same as macOS): never type
  into password/credential fields, never submit forms (submit buttons or
  Enter-to-submit) — hard refusals, not confirmation gates. The visible-text
  click fallback inspects the same element it is about to click (the macOS C4
  review finding, ported).
- **Disconnect, never quit**: `browser_close` closes only the tab(s) the agent
  opened and disconnects the CDP connection — never the owner's live context,
  never their browser process.
- **Capabilities unchanged**: `['browser','computer']` — cdp-attach rides the
  existing `browser` capability (no new backend gate; the backend's per-task
  attach param is the switch).
- `cdp-attach.ts` is deliberately **Playwright-free** (fetch + pure
  predicates) so the node:test suite exercises the real logic on Linux CI
  (`test/win-cdp-attach.test.mjs`, 32 tests).

### The desktop shell + installer (`../windows-shell/`)

W2's installable-client half — a C#/.NET 8 WinForms + WebView2 shell around
`https://digby.example.com/` (the port of the macOS `main.swift`), plus an
NSIS per-user installer. Full architecture, the `__digbyDesktop` bridge
message table, and the deviation table live in
[`../windows-shell/README.md`](../windows-shell/README.md); the short version:

- **Shell**: persistent login profile under `%LOCALAPPDATA%\Digby\WebView2`,
  host allowlist (`digby.example.com` + OAuth hosts in-app, user-clicked external
  links → default browser), `__digbyDesktop = { platform: 'windows',
  canSetupIMessage: true }` + a WebKit shim so the web app needs **zero
  changes**, native downloads, close-to-tray, update check against
  `windows-latest.json` (opens the download in the default browser — never
  self-updates). Since 2026-10-06 the shell also spawns this agent on the
  `setupIMessage` bridge message (one-click pairing from the web app; env
  `DIGBY_PAIR_CODE` + `DIGBY_API_URL`, log at
  `%LOCALAPPDATA%\Digby\agent.log`) — see the message table in
  `../windows-shell/README.md`.
- **Installer**: NSIS 3 per-user — `RequestExecutionLevel user` (no UAC),
  `%LOCALAPPDATA%\Programs\Digby`, per-user Start-menu/desktop shortcuts,
  opt-in HKCU Run-key autostart (`/AUTOSTART` flag), uninstaller that keeps
  user data (login profile survives reinstall). Built by
  `windows-shell/installer/build-installer.sh` (runs on windows-latest CI and
  Linux dev boxes).

### What remains (other lanes / W3)

- **Signing, CI, and the `windows-latest.json` feed hosting** — the parent
  session's lane (this PR ships source + installer script only).
- **Agent-daemon bundling into the installer** — the hook is commented into
  `digby.nsi` (the W3 agent bundle section installs from `publish/agent/`).
- **W3 (UIA perception)**: Rust helper — Windows Graphics Capture, UIA tree
  dumps + invoke fallback, elevation/secure-desktop/DRM detection, anti-cheat
  refusal list.

## W1 — what shipped

### `browser_*` — Playwright port (`src/browser.ts`)

Port of `imessage-agent/src/browser.ts` (v0.5.0 contract): `navigate`,
`get_content` (text/html/snapshot), `extract`, `click` (CSS selector +
visible-text fallback), `type` (with submit), `scroll`, `screenshot`
(PNG/JPEG + mime), `pop_out` (headed escalation for login/2FA, per-session,
never sticky), `close` (leaves a popped-out window open for the user).

- **Persistent profile** at `%LOCALAPPDATA%\Digby\browser-profile`
  (`DIGBY_BROWSER_PROFILE` overrides; non-Windows dev boxes fall back to
  `~/.config/digby-agent/browser-profile`). Once the user logs into a site
  through Digby, later tasks reuse that session — the whole point of the
  local driver.
- **Headless by default**; `DIGBY_BROWSER_HEADED=1` restores always-headed;
  `DIGBY_BROWSER_HEADLESS=1` wins over everything (pop-out refuses) — the
  exact macOS precedence.
- **Lazy Chromium download** with the same first-command gate: the agent
  ships the Playwright package but NOT the ~170 MB binary; the first
  `browser_*` command waits up to 35 s for the download, then returns the
  clean "being set up" error while the download continues. `run` kicks the
  download off in the background at startup so the first command usually
  finds it ready.
- **Chromium sandbox ON** (`chromiumSandbox: true`) — the 88915954 fix
  ported. The Windows sandbox (restricted tokens + job objects) needs no
  setuid helper and no extra privileges for a standard user process, so the
  default is safe here (unlike Linux containers).
- **CDP-attach (W2)**: the dual gates + the Chrome/Edge probe are live (see
  "W2 — what shipped" above). The `attach` param rides the wire; when both
  gates are off the task runs on Digby's own profile and the observation's
  `mode` field reports what actually drove.

### `computer_*` — the Rust helper (`src/rust-helper.ts` + `rust-helper/`, behind the `src/win-platform.ts` seam)

`screenshot`, `click` (left/right, single/double), `type`, `key`
(named keys + modifiers), `scroll` (with optional verified x/y target),
`open`, `frontmost`, `ping` — plus the W3 additions
`uia_tree` / `uia_invoke` (below).

- **The helper** (`digby-win-helper`, Rust, `rust-helper/`): a stdio
  JSON-lines subprocess the agent spawns lazily. It owns the Win32
  surface: **Windows Graphics Capture** (the production capture path —
  GPU copy, handles the cases BitBlt can't) with the **W1 GDI BitBlt
  chain as fallback** when WGC init fails, SendInput, UI Automation, and
  the environment probes (elevation / secure desktop / foreground exe).
  See [docs/WINDOWS_W3_SHIPPING.md](../docs/WINDOWS_W3_SHIPPING.md) for
  the frozen method table + refusal codes.
- **The retired W1 FFI adapter is GONE** — `src/win32.ts` was deleted and
  the native-FFI dependency removed from package.json (the W1 laziness
  contract translated to the helper: the process spawns on FIRST USE,
  never at import, and the spawn command is injectable —
  `helperPath` config > `DIGBY_WIN_HELPER` env > `digby-win-helper.exe` at
  the bundle root beside `dist/` — the installer's layout — then inside
  `dist/` as the legacy fallback; see ticket 4424ebd6). The Linux suite
  exercises the whole client protocol
  against a fake helper (`test-fixtures/fake-helper.mjs`).
- **JPEG encoding stays in TypeScript** (`src/jpeg-encode.ts`, jpeg-js):
  BGRA → RGB channel swap, box downscale to the 1568-px long-edge cap,
  quality 75 — the macOS screenshot contract. The helper returns raw
  BGRA; encoding never moved into Rust.
- **SendInput INPUT structs** are serialized by the helper's pure Rust
  `InputBuilder` into the 40-byte little-endian x64 layout (type DWORD at
  0, the 16-byte union at offset 8) — pinned by cargo unit tests on
  Linux, including the two's-complement wheel encoding and surrogate-pair
  unicode events (the W1 pins, ported).

### DPI reconciliation (the 4e4d56ff contract, DPI edition)

The capture covers the **entire virtual screen** (the bounding box of all
monitors), and clicks map image-pixel → physical-pixel by linear proportion
across that same box — per-monitor DPI affects only WHERE each monitor sits
inside the box (already reflected in the reported rects), never the
conversion. `SetProcessDPIAware` is stamped once so metrics + BitBlt report
physical pixels, the coordinate space SendInput uses.

- Mixed-DPI multi-monitor is the trap (a 200% primary beside a 100%
  secondary): the aspect check between the screenshot and the reported
  virtual-screen size (drift > 2%) REFUSES clicks rather than landing them
  at wrong coordinates.
- **Origin verify-or-refuse** (PR #1048 review N1): the virtual-screen
  ORIGIN is folded in on every screenshot. When the surface exposes
  `geometry()` but the probe fails, returns null, or reports a snapshot
  that disagrees with the capture (topology change mid-shot), the cache is
  stamped `originUnknown` and coordinate actions (`click`, targeted
  `scroll`) REFUSE with a structured error — never a silent origin-(0,0)
  fallback that would click the WRONG monitor on a left/above-secondary
  desktop. `type`/`key` (no coordinates) are not gated — macOS parity. A
  subsequent screenshot with a verified origin clears the flag.
- `validateGeometry` refuses degenerate snapshots (zero monitors, absurd
  DPI, non-finite rects); `monitorAt` classifies which monitor a point
  falls on (null in the gaps between monitors).
- Mouse moves are `MOUSEEVENTF_ABSOLUTE|VIRTUALDESK` — normalized
  0..65535 across the whole desktop, multi-monitor correct with no
  per-monitor math in the input path.

### The UIPI wall (elevation detection)

`SendInput` from a normal (medium-IL) agent into an elevated/admin window is
blocked by Windows UIPI. W3 surfaces this as the frozen **`UIA_E_ELEVATED`
refusal code** (never a silent no-op — roadmap §2.3; the W1
`elevation_blocked` string is superseded):

- input actions (`click`/`type`/`key`/`scroll`) preflight the foreground
  window's process integrity (the helper's `environment_check`:
  `OpenProcessToken` + `GetTokenInformation(TokenElevation)`; an
  `OpenProcess` failure on a visible foreground process is itself reported
  as elevated) and refuse with `<code>: <guidance>` BEFORE injecting
  anything;
- `SendInput` returning fewer events than requested (the documented UIPI
  signature mid-action) is the same `UIA_E_ELEVATED` refusal from the
  helper — the backstop behind the preflight;
- `open` is NOT input injection (ShellExecute spawns/activates) and stays
  allowed.

### W3 safety surfaces (`src/safety.ts`)

Beyond elevation, the same preflight gate answers for:

- **`UIA_E_SECURE_DESKTOP`** — a UAC prompt / lock screen is active
  (`OpenInputDesktop` fails for a normal-integrity process): capture AND
  input both refuse until the user dismisses it.
- **`UIA_E_ANTICHEAT`** — the foreground process is on the refusal list
  (defaults `vgc.exe`, `vgtray.exe`, `EasyAntiCheat.exe`,
  `EasyAntiCheat_EOS.exe`, `BEService.exe`, merged case-insensitively with
  `config.json` `antiCheatProcesses[]`): hard refusal for capture+input —
  driving a protected game risks the user's account.
- **`UIA_W_DRM_SUSPECTED`** — a WARNING, never an error: the captured
  frame's foreground-window rect is uniformly black (DRM / exclusive
  fullscreen refusing pixels). The screenshot is still delivered with the
  warning line in the observation; the model falls back to
  `computer_uia_tree` for structural perception.

### `computer_uia_tree` / `computer_uia_invoke` (UIA perception — W3)

The semantic-tree alternative to pixel screenshots: the helper walks the
UI Automation **control view** and returns the frozen `UiaNode` shape
(`name, role, automation_id, runtime_id, rect, focused, value?, children`)
plus `text` — a compact indented linearization hard-bounded by `max_nodes`
(default 300, ceiling 2000; `max_depth` default 6, ceiling 32) with
elision markers instead of silent truncation. `uia_invoke` drives an
element by `runtime_id` + pattern (`invoke|toggle|expand|select|focus|
set_value`); the backend driver follows up with `computer_screenshot`
exactly as after click/type. Refusals: `UIA_E_NOT_FOUND` (stale
runtime_id), `UIA_E_UNSUPPORTED` (pattern not on that element).

## Known limits (W3)

- **Elevated windows**: input into admin/elevated apps is UIPI-blocked —
  reported as `UIA_E_ELEVATED`, not driven. The agent itself never runs
  elevated (roadmap §2.3: an elevated helper would be an explicit,
  visible install-time choice, not a default).
- **UAC secure desktop / locked workstation**: not capturable and not
  drivable — surfaces as the `UIA_E_SECURE_DESKTOP` refusal (W1's
  confusing capture error class, now a named code with guidance).
- **DRM/protected content + exclusive-fullscreen games**: black frames —
  the `UIA_W_DRM_SUSPECTED` warning in the observation (the screenshot
  still rides along) + `computer_uia_tree` as the structural fallback;
  a hard capture failure surfaces `UIA_E_DRM`.
- **Anti-cheat**: the refusal list is LIVE (defaults + config
  `antiCheatProcesses[]`) — capture+input refuse with `UIA_E_ANTICHEAT`
  when the foreground process matches.
- **CDP-attach** (driving the user's everyday Chrome/Edge in a dedicated
  tab) shipped in W2 (off by default, owner master switch).
- **Capture cadence**: one JPEG per action (the macOS agent's cadence),
  not video — WGC made each frame cheaper, the cadence contract is
  unchanged.
- **The helper binary ships with the installer** (W3), installed at the
  agent bundle root — BESIDE `dist/`, not inside it (digby.nsi SecAgent);
  the agent probes the bundle root first, then inside `dist/` (0.9.1,
  ticket 4424ebd6 — 0.9.0 probed only inside `dist/` and a fresh install
  could pair but never run computer_*). A manual `npm`-only agent install
  has no `digby-win-helper.exe` — computer_* then refuses with the
  actionable `DIGBY_WIN_HELPER` message (set the env or place the exe at
  the bundle root beside `dist/`).

## Brokered relay + the RFB carrier (ticket c468f922)

The backend carries a brokered operator session over the outbound relay. On this
side the pieces are:

| File | Role |
|---|---|
| `src/api.ts` | `fetchRelayFrames` / `postRelayFrame` — the outbound relay calls (no inbound port) |
| `src/rfb-client.ts` | **RFB 3.8 CLIENT**: the §7.1 handshake, the `SetEncodings` advertisement (derived from `DECODABLE_ENCODINGS`, guarded by `assertAdvertisable`), `FramebufferUpdateRequest`, pointer/key encoding |
| `src/relay-rfb.ts` | **The carrier**: dials the PC's own RFB server, drives the handshake, re-requests frames continuously, forwards server bytes into the relay |
| `src/index.ts` | `pumpRelay` starts the carrier when a session goes live and forwards operator input back to the RFB server |

**Configuration.** The carrier dials an RFB server **already running on this PC**
— it is not a capture stack and starts nothing:

| Env var | Default | Meaning |
|---|---|---|
| `DIGBY_RFB_HOST` | `127.0.0.1` | RFB server host |
| `DIGBY_RFB_PORT` | `5900` | RFB server port — the port the PF/firewall anchor already scopes to the tunnel interface |

With no RFB server listening, the carrier fails to connect, logs it, and
**retries on the next poll tick** (a failed carrier is deliberately not cached,
so starting the server later begins carrying without restarting the agent).

**Security type: `None` only.** The client selects RFB security type 1 and
REFUSES a server that offers only VncAuth (type 2) — VNC's DES challenge is not
implemented, and the operator channel reaches the host over the tailnet, so the
transport is the auth boundary. It speaks **3.8 only**: 3.3/3.7 lack the
security-types list this parser reads.

**Supported encodings.** The advertisement is derived from `DECODABLE_ENCODINGS`,
in preference order — the list is the single source of truth and
`assertAdvertisable` refuses anything no decoder claims:

| Order | Encoding | Id | Decoded by |
|---|---|---|---|
| 1 | **Tight** | 7 | `decodeTightRect` — Copy, Palette (1-bit and 8-bit) and Gradient filters; BasicCompression (zlib) and FillCompression |
| 2 | Hextile | 5 | `decodeHextileToWirePixels` (Raw/Background/Foreground/Coloured subrects) |
| 3 | CopyRect | 1 | move-within-framebuffer, source snapshotted for overlap |
| 4 | Raw | 0 | verbatim |
| — | DesktopSize | −223 | pseudo-encoding: resize |
| — | LastRect | −224 | pseudo-encoding: end-of-update marker |

**Tight leads because both TightVNC and TigerVNC PREFER it** (§7.5.2: the server
takes the first normal encoding in the client's list that it supports). Listing
Hextile first ordered those hosts to send the costlier encoding on every update,
and a host forced to `-encoding tight` had no legal answer except a rect we
refused. Tight's zlib streams **persist across rectangles**, so the decoder keeps
all four stream windows and continues them (`inflateRawSync` with the previous
32 KiB as dictionary) — a per-rect inflate fails with
`Z_DATA_ERROR incorrect header check` on the second rect.

**Refused encodings.** RRE (2) / TRLE (16) / ZRLE (17) are not decoded — a rect
using one halts the stream (`unsupported-encoding`) rather than mis-parsing every
later byte. **Tight JPEG is likewise refused** (`bad-tight`) and is *not* faked:
we never advertise a JPEG quality level, so a compliant server will not send it,
and a non-compliant one gets an honest refusal instead of a hole in the picture.
Tight rects wider than 2048 pixels are refused (the format's own limit).

## Capability handshake (W0's backend change)

This agent **advertises** its platform + capabilities at pair time and on every
poll (`platform=windows&capabilities=browser,computer`), and the backend stores
them (`IMessageAgent.platform` / `.capabilities` — migration
`20260925031500_agent_platform_capabilities`). The availability gates
(`computerUseAvailable`, `localBrowserAvailable`) answer from the advertisement;
legacy Mac rows keep the historical version gates. See
`backend/src/modules/crossmodel/imessage/agent-capabilities.ts`.

`AGENT_VERSION` is `0.8.0` — above every backend dispatch gate
(browser 0.2.0, computer 0.3.0, computer-claim 0.3.2, pop-out 0.4.0, attach
0.5.0) so the broker's `minAgentVersion` requeue logic never holds commands
back from this agent.

## Layout

| File | Role |
|---|---|
| `src/advertisement.ts` | Platform + capability advert (pair body / poll query) + AGENT_VERSION |
| `src/config.ts` | `%USERPROFILE%\.config\digby-agent\config.json` + stable device id |
| `src/api.ts` | Pair / long-poll / result — the same endpoints as the macOS agent |
| `src/win-platform.ts` | **The platform seam**: VK/scan-code map, typing planner, geometry reconciliation (incl. virtual-screen DPI math), `Win32Surface`/`Win32Input` interfaces + the null fallback |
| `src/rust-helper.ts` | **W3 helper client** (lazy, injectable spawn): spawns `digby-win-helper`, implements `Win32Surface`/`Win32Input`, the UIA actions, `environment_check`; frozen refusal-code constants |
| `src/safety.ts` | **W3 safety gate**: elevation/secure-desktop/anti-cheat preflights, the anti-cheat list merge, the DRM heuristic + warning line |
| `src/jpeg-encode.ts` | BGRA → JPEG (jpeg-js): channel swap, long-edge cap, box downscale — the macOS screenshot contract (encoding stays in TS) |
| `rust-helper/` | **W3 the helper itself** (Rust): stdio JSON-lines protocol, WGC + GDI-fallback capture, SendInput, UIA tree/invoke, environment checks — pure modules unit-test on Linux |
| `src/browser.ts` | **W1 Playwright browser**: persistent profile, headless default, pop-out, lazy Chromium gate — the macOS browser contract; **W2**: the CDP-attach branch + safety rails |
| `src/cdp-attach.ts` | **W2 CDP-attach** (Playwright-free): the dual gates, the Chrome/Edge probe (`/json/version`), the attach-eligibility predicates, the credential/submit rail classifier |
| `src/commands.ts` | Pure command dispatch: `computer_*` orchestration (verify-or-refuse clicks, the W3 safety preflights, modifier pre-sweep, image→screen mapping, `uia_tree`/`uia_invoke`), `browser_*` routing |
| `src/index.ts` | pair / run / status entry point — the macOS run-loop contract |
| `test/` + `test-fixtures/` | node:test suites + the fake-helper fixture — run on Linux CI, no Windows box needed |

## Development

```bash
cd windows-agent
npm install
npm run build
npm test        # builds then runs node --test test/ (104 tests, all pure)

# The Rust helper — pure units on any host (the Linux CI path):
cargo test --manifest-path rust-helper/Cargo.toml
cargo check --manifest-path rust-helper/Cargo.toml
```

Manual (against a local backend):

```bash
node dist/index.js pair     # enter the code from the Digby web UI
node dist/index.js status   # config + platform support (helper found?)
node dist/index.js run      # the long-poll loop
```

`DIGBY_API_URL=http://localhost:4000/api` and `DIGBY_PAIR_CODE=XXXX-XXXX`
behave exactly as on macOS (env-driven non-interactive pairing). The helper
binary is resolved as `helperPath` config > `DIGBY_WIN_HELPER` env >
`digby-win-helper.exe` at the bundle root beside `dist/` (where the
installer puts it) > inside `dist/` (legacy manual workaround).

## Ported macOS contracts (why this file looks familiar)

- **Verify-or-refuse** (macOS 4e4d56ff): a click moves the pointer, reads the
  cursor back, retries once, and REFUSES to click blind.
- **Geometry reconciliation** (macOS 4e4d56ff, DPI edition): image-pixel →
  physical-pixel conversion is aspect-checked against the reported
  virtual-screen size; on mismatch, clicks refuse rather than land at wrong
  coordinates (Windows' analogous trap is per-monitor DPI scaling).
- **Real scan codes** (macOS cbaf3e08): text is planned as real VK + Set-1
  scan codes with shift flags — never "keycode 0 + hope". Non-ASCII rides a
  `KEYEVENTF_UNICODE` fallback, iterated by code point.
- **Modifier-clearing pre-sweep** (the stuck-shift lessons): UP-only SendInput
  releases for ctrl/alt/shift/win before every planned sequence — never a
  press-down "warm-up" (a char racing a modifier press becomes a shortcut).
- **Never throw into the run loop**: a failed action is a result, not a crash.

## Roadmap

- **W2 (ship shape) — SHIPPED (this repo, 2026-09-25):** WebView2 shell +
  `__digbyDesktop` bridge (`platform: 'windows'`) + NSIS per-user installer
  (`../windows-shell/`), CDP-attach with the Chrome **and** Edge probe
  (`src/cdp-attach.ts`). Still open on other lanes: Azure Artifact Signing in
  CI, the `windows-latest.json` feed hosting, internal beta.
- **W3 (UIA perception) — SHIPPED (this repo, 2026-09-25):** the Rust helper
  (`rust-helper/`) — Windows Graphics Capture (GDI fallback), UIA tree dumps +
  invoke fallback, elevation/secure-desktop/DRM detection, anti-cheat
  refusal list — plus agent bundling in the installer and the frozen
  `UIA_*` refusal codes. See
  [docs/WINDOWS_W3_SHIPPING.md](../docs/WINDOWS_W3_SHIPPING.md).
  refusal list.
- **W4 (hardening):** multi-monitor/DPI matrix, locked-workstation behavior,
  AV-quarantine runbook, Store/MSIX evaluation.
