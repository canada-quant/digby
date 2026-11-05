# Windows Client — W3 Shipping (Rust helper + UIA perception, 2026-09-25)

W3 replaces the W1 native-FFI adapter (retired) with a **Rust helper
process** (`digby-win-helper`), adds **UI Automation perception**
(`computer_uia_tree` / `computer_uia_invoke`), the **safety surfaces**
(elevation / secure desktop / DRM / anti-cheat, frozen `UIA_*` refusal
codes), and **bundles the agent into the NSIS installer**. See
`docs/CLIENT_PLATFORMS_ROADMAP_2026-09.md` §2.10 for the milestone frame;
`docs/WINDOWS_CLIENT_W1.md` / `WINDOWS_W2_SHIPPING.md` for the prior waves.

**What shipped in code + CI (this lane):** everything below except the
OWNER-GATED items in §6.

---

## 1. The Rust helper (`windows-agent/rust-helper/`)

A single static-ish binary spawned by the agent, speaking **line-delimited
JSON over stdio** (one request line in → exactly one response line out —
NOT JSON-RPC 2.0; the envelope below is the whole protocol):

```
→ {"id":1,"method":"ping","params":{}}
← {"id":1,"ok":true,"result":{"version":"0.9.0","platform":"windows"}}
← {"id":1,"ok":false,"error":{"code":"UIA_E_ELEVATED","message":"…"}}
```

- **Crate layout** — pure modules (`protocol`, `input`, `uia_model`, `drm`)
  compile + unit-test on ANY host (Linux CI runs `cargo test`: 26 units);
  the Win32 implementation (`win/`: capture, input, uia, env) is
  `#[cfg(windows)]` + a `[target.'cfg(windows)'.dependencies]` windows-rs
  entry, so `cargo check` on Linux still validates the protocol layer.
- **Capture** — Windows Graphics Capture (D3D11 → DXGI interop →
  FramePool → staging texture → CPU map, BGRA) with the **W1 GDI BitBlt
  path as fallback** (preserves W1 behavior when WGC init fails). The
  helper returns raw **BGRA + dims + backend + virtual-screen origin**;
  the AGENT keeps JPEG encoding + downscaling in TypeScript (jpeg-js) —
  encode never moved into Rust.
- **Input** — SendInput through the pure `InputBuilder` byte serializer
  (the 40-byte x64 INPUT ABI, two's-complement wheel encoding, surrogate
  pairs — the W1 pins, now cargo tests).
- **UIA** — tree walk (control view) + pattern invoke via the TYPED
  getters (`CurrentName`/`GetRuntimeId`/`GetCurrentPatternAs::<T>`), no
  VARIANT decoding.

### Method table (frozen)

| method | params | result |
|---|---|---|
| `ping` | — | `{version, platform}` |
| `monitor_size` | — | `{width, height}` (virtual screen, physical px) |
| `capture_bgra` | — | `{bgra_b64, width, height, backend: "wgc"\|"gdi", vx, vy, drm_suspected: boolean}` |
| `frontmost` | — | `{app, window}` \| `null` |
| `geometry` | — | `{x, y, width, height, monitors: [{x,y,width,height,dpi}]}` \| `null` |
| `cursor_pos` | — | `{x, y}` \| `null` |
| `move_to` | `{x, y}` | `{ok}` (VIRTUALDESK-normalized absolute) |
| `mouse_down` / `mouse_up` | `{button: "left"\|"right"}` | `{ok}` |
| `scroll` | `{amount}` (positive = up) | `{ok}` (±20 notches clamp) |
| `key_down` / `key_up` | `{vk, scan, extended, shift}` | `{ok}` (the WinKeySpec contract) |
| `unicode_char` | `{ch}` | `{ok}` (UTF-16 units; surrogate pairs) |
| `clear_modifiers` | — | `{ok}` (ctrl/alt/shift/win KEYUP sweep) |
| `open` | `{target}` | `{ok}` (ShellExecuteW) |
| `uia_tree` | `{root?: "foreground"\|"desktop", max_depth?≤32, max_nodes?≤2000}` | `{ok, tree: UiaNode, text, node_count}` (defaults 6 / 300) |
| `uia_invoke` | `{runtime_id: number[], pattern, value?}` | `{ok}` — see §2 |
| `environment_check` | — | `{secure_desktop, elevated_foreground, foreground_exe, foreground_title, foreground_rect, foreground_pid}` |

`UiaNode` = `{ name, role, automation_id, runtime_id: number[], rect:
{x,y,w,h}, focused, value?, children: UiaNode[] }`; `text` is the compact
indented linearization hard-bounded by `max_nodes` (elision markers, never
silent truncation) — the payload the model reads.

### Refusal codes (frozen — relayed VERBATIM as `<CODE>: <human guidance>`)

| code | meaning |
|---|---|
| `UIA_E_ELEVATED` | target window elevated (UIPI blocks synthetic input) |
| `UIA_E_SECURE_DESKTOP` | UAC prompt / lock screen active |
| `UIA_E_DRM` | window refuses capture (DRM / exclusive fullscreen) |
| `UIA_E_ANTICHEAT` | foreground process anti-cheat protected |
| `UIA_E_NOT_FOUND` | stale runtime_id (tree changed) |
| `UIA_E_UNSUPPORTED` | pattern not on that element |
| `UIA_W_DRM_SUSPECTED` | **warning** (never an error result): uniform-black foreground rect — embedded as a prefix line in observation text |

Helper-internal codes (never relayed as UIA_*): `HELPER_E_PLATFORM`
(non-Windows binary), `HELPER_E_PARAMS`, `HELPER_E_INTERNAL`.

---

## 2. The agent migration (koffi → helper)

- `src/win32.ts` **deleted**; the koffi dependency is **gone** from
  package.json. `grep -r koffi windows-agent/{src,package.json,test}`
  returns nothing — the koffi-era tests were RETIRED-AND-REPLACED (the
  INPUT-ABI pin moved into the Rust crate's cargo tests; the laziness pin
  became the helper client's lazy-spawn test; the dependency pin became
  "koffi ABSENT").
- `src/rust-helper.ts` — the seam client: spawns the helper lazily (never
  at import; resolution: `helperPath` config > `DIGBY_WIN_HELPER` env >
  `digby-win-helper.exe` at the BUNDLE ROOT beside `dist/` — the installer's
  layout — then inside `dist/` as the legacy fallback (0.9.1, ticket
  4424ebd6: 0.9.0 probed only inside `dist/` and a fresh install could pair
  but never run computer_*)), serializes requests, 15s
  timeout, garbage-line skip, structured `HelperProtocolError` with
  `isRefusal`. Implements the **unchanged** `Win32Surface`/`Win32Input`
  interfaces from `win-platform.ts` — nothing above the seam changed.
- `src/safety.ts` — the safety gate: elevation / secure-desktop /
  anti-cheat preflights over the helper's `environment_check`, the
  anti-cheat list merge (defaults `vgc.exe, vgtray.exe,
  EasyAntiCheat.exe, EasyAntiCheat_EOS.exe, BEService.exe` + config.json
  `antiCheatProcesses[]`), and the agent-side DRM heuristic.
- `AGENT_VERSION` → **0.9.1** (capabilities unchanged
  `['browser','computer']` — the UIA actions ride `computer`). 0.9.1 is the
  4424ebd6 helper-locator fix (bundle-root probe); 0.9.0 was the W3 UIA
  release. The backend's UIA commands carry a `0.9.0` minAgentVersion
  gate so macOS agents (0.5.0) never claim them — 0.9.1 clears it.
- **Safety wiring in commands.ts** — input actions (click/type/key/scroll)
  preflight elevation + secure desktop + anti-cheat; capture preflights
  secure desktop + anti-cheat; `computer_screenshot` appends the
  `UIA_W_DRM_SUSPECTED` warning line when the heuristic trips (the
  screenshot is still delivered); `computer_uia_tree` / `computer_uia_invoke`
  are new dispatch actions with agent-side param validation mirroring the
  helper's. A missing/failed helper NEVER touches `browser_*`.
- The backend driver follows `computer_uia_invoke` with
  `computer_screenshot` exactly as after click/type — the helper does NOT
  capture on invoke.

---

## 3. Bundling + installer layout

```
$INSTDIR\
  Digby.Shell.exe            (W2 shell)
  uninstall.exe
  agent\                     (W3 — optional section, DEFAULT ON)
    launch-agent.bat         ← HKCU Run "DigbyAgent" target
    node.exe                 (official Node v22.23.3 win-x64)
    digby-win-helper.exe     (cargo-built, signed in CI when secrets exist)
    dist\                    (the compiled agent)
    node_modules\            (PRODUCTION deps only)
```

- **Two independent autostarts**: the shell's opt-in `SecAutostart`
  (`HKCU\…\Run\Digby` → Digby.Shell.exe, W2) and the agent's default-on
  `SecAgent` (`HKCU\…\Run\DigbyAgent` → launch-agent.bat). Deliberately
  separate keys: shell and agent have independent lifecycles.
- **Uninstall mirror**: taskkill `digby-win-helper.exe` + the agent node
  process, delete both Run keys, `RMDir /r $INSTDIR\agent`. User data
  (`%LOCALAPPDATA%\Digby` — login profile, agent.log) is deliberately
  KEPT (reinstall must not log the user out).
- Every agent `File` in digby.nsi is `/nonfatal` — an incomplete bundle
  installs what exists and the agent refuses cleanly at runtime; the
  SHELL install never fails on the agent's behalf (the W2 contract).
- `build-installer.sh` stages the same bundle locally (every stage
  skippable; `DIGBY_SKIP_AGENT_BUNDLE=1` skips entirely; the helper exe
  from `DIGBY_WIN_HELPER_EXE` or `rust-helper/target/release/`).

## 4. CI pipeline (`.github/workflows/windows.yml`)

- **agent-tests (ubuntu-latest)**: `npm install` → `tsc --noEmit` →
  `npm test` — 107 tests (0.9.1: +3 win-helper-bundle layout-contract
  tests, ticket 4424ebd6), no helper binary needed (the fake-helper
  fixture in `test-fixtures/` — NOT `test/`, which node --test scans).
- **build (windows-latest)**: resolve step (also probes the crate) →
  .NET 8 → **Rust toolchain (dtolnay/rust-toolchain@stable) + Swatinem/
  rust-cache** → **cargo build --release** (MSVC; hard-fails when the exe
  is missing) → **stage the agent bundle** (node.exe from nodejs.org,
  agent build + production node_modules, helper, launcher) → dotnet
  publish shell → **sign shell + helper** (Azure Artifact Signing over
  the whole `publish/` tree, recursive — picks up
  `publish/agent/digby-win-helper.exe`) → NSIS → sign installer →
  upload artifact.
- The sign steps still branch on the resolve-step boolean (`signing`
  output) — `secrets.*` NEVER appears in a step-level `if:` (the PR #1060
  parse-failure lesson).

## 5. Verify recipe (the lane's own checks)

```bash
cd windows-agent && npm install && npm test          # 107 tests green (Linux)
$HOME/.local/cargo/bin/cargo test  \
  --manifest-path windows-agent/rust-helper/Cargo.toml   # 26 units (Linux)
$HOME/.local/cargo/bin/cargo check --manifest-path …     # protocol layer
# (optional, strongest): cargo check --target x86_64-pc-windows-gnu —
#  type-checks the entire win/ tree against windows-rs without a linker.
# NSIS standalone: makensis via apt-get download nsis + nsis-common +
#  dpkg-deb -x to $HOME/.local/nsis-linux, NSISDIR=<…>/usr/share/nsis.
```

## 6. OWNER-GATED remainder (checklist per release)

1. **Artifact Signing identity validation** (Azure, Basic tier) — 1-3
   business days (individual) / 3-5 (organization). Until the six
   `AZURE_*` repo secrets exist, CI uploads UNSIGNED builds with a
   visible notice (internal testing only). Start this BEFORE the first
   public release; it is the long pole.
2. **First wdsi submission** — submit `Digby-Setup.exe` (and the signed
   `digby-win-helper.exe` + `Digby.Shell.exe`) at
   https://www.microsoft.com/wdsi/filesubmission as a software vendor
   (Developer account) so SmartScreen reputation accrues. Per release:
   sign → submit → note the submission IDs → re-check false-positive
   status before announcing.
3. **Hosting Digby-Setup.exe itself** — the artifact is in GitHub Actions
   (30-day retention); a public download needs durable hosting (the
   digby.ai site or an Azure blob) — owner decision, not wired here.
4. **Windows-agent E2E on a real box** — the CI covers compile +
   protocol + pure units; the WGC capture, UIA walk and SendInput paths
   against a live desktop need a paired Windows PC (W4 hardening scope).

## 7. W4 (next)

Multi-monitor/DPI matrix, locked-workstation behavior (the secure-desktop
refusals are already in place), AV-quarantine runbook (signed helper
helps), Store-MSIX evaluation.
