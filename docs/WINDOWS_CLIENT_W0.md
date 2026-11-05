# Windows Client — W0 Architecture + Capability Mapping (shipped 2026-09-25)

> **Status:** W0 SHIPPED (this document maps what landed). Companion to
> [CLIENT_PLATFORMS_ROADMAP_2026-09.md](./CLIENT_PLATFORMS_ROADMAP_2026-09.md) §2 —
> the roadmap explains WHY; this maps WHAT EXISTS NOW and what W1 adds.
> Milestone track: goal `09a1ec04`, todo `2e8bcf20` (W0) / `2294dad8` (M0 mobile).

---

## 1. What W0 shipped

| Piece | Where | State |
|---|---|---|
| **Capability handshake (backend)** | `backend/src/modules/crossmodel/imessage/agent-capabilities.ts` | Shipped + tested — agents advertise `platform` + `capabilities`; gates prefer the advertisement, legacy Mac rows keep version gates |
| **Prisma columns** | `IMessageAgent.platform` (nullable) + `.capabilities` (`String[]`, default `[]`) — migration `20260925031500_agent_platform_capabilities` | Shipped; additive, zero behavior change for existing rows |
| **Pair/poll wire** | `POST /pair/complete` body `{platform, capabilities}` · `GET /agent/poll?platform=…&capabilities=…` | Shipped — normalized server-side (unknown values dropped) |
| **Capability-aware gates** | `computer-agent/availability.ts` (`computerUseAvailable`), `browser-agent/router.ts` (`localBrowserAvailable`) | Shipped — advertisement wins; legacy rows byte-identical |
| **Per-platform loop instructions** | `computer-agent/computer-loop.ts` `instructionsForPlatform()` | Shipped — Windows targets get Win-key/alt-tab/UIPI doctrine; macOS text unchanged |
| **Windows agent scaffold** | `windows-agent/` | Shipped — pairing, long-poll loop, pure command dispatch, null Win32 seam |
| **Frontend per-device surface** | `/status` + `/agents` payloads carry `platform` + `capabilities` per device | Shipped (payload) — UI rendering is W1 polish |

**W0 does NOT ship** the Win32 FFI layer (koffi), Playwright browser commands,
the WebView2 shell, or any installer — the seam's null implementation refuses
`computer_*`/`browser_*` with a clear `not yet implemented (W1)` error, which
is the deliberate W0 milestone definition (roadmap §2.10: "spike week").

---

## 2. The capability handshake (the backend change, §2.7 of the roadmap)

### 2.1 The problem it solves

Until W0, "what can this agent do" was inferred from `agentVersion` alone
(browser ≥ 0.2.0, computer ≥ 0.3.0). That is single-axis and Mac-shaped: a
Windows agent that never ships iMessage cannot express "browser + computer,
no iMessage" through a version number, and its version history is its own.

### 2.2 The model

```
agent pair  → POST /crossmodel/imessage/pair/complete
              body: { pairingCode, deviceName, agentVersion, deviceId,
                      platform: 'windows',            ← NEW
                      capabilities: ['browser','computer'] }  ← NEW

agent poll  → GET /crossmodel/imessage/agent/poll
              ?version=0.6.0&platform=windows&capabilities=browser,computer   ← NEW
```

The backend normalizes and stores both (migration `20260925031500`):

- `IMessageAgent.platform TEXT NULL` — `null` = legacy row → resolved as `macos`
- `IMessageAgent.capabilities TEXT[] NOT NULL DEFAULT '{}'` — `[]` = no
  advertisement → the historical Mac version gates apply

**Resolution order (agent-capabilities.ts `hasCapability`):**

1. Row advertises capabilities → **the advertisement is the answer**
2. Legacy Mac row → the historical version gates (imessage always; browser ≥
   0.2.0; computer ≥ 0.3.0)
3. Windows row with no advertisement → can do nothing (it must speak the
   handshake — the W0+ scaffold always does)

**Invariants pinned by `agent-capabilities.test.ts` (21 tests):**

- unknown capability tokens are DROPPED server-side — an agent can never
  inject arbitrary capability strings into the registry
- an absent advertisement never clobbers a stored one (legacy agents keep
  stored values intact; a re-advertising agent self-heals its row)
- every existing Mac status string stays byte-identical for legacy rows
- the gates answer from the advertisement for advertising agents at ANY version

### 2.3 Where the answer flows

```
pair/poll ──▶ imessage.service (stores advert)
                 │
                 ├─▶ agent-capabilities.ts hasCapability()          [pure leaf]
                 │       ├─▶ computer-agent/availability.ts computerUseAvailable()
                 │       │       └─▶ driver.ts selectComputerDriver() ─ platform surfaced
                 │       │               └─▶ computer-loop.ts instructionsForPlatform()
                 │       └─▶ browser-agent/router.ts localBrowserAvailable()
                 │               └─▶ selectBrowserDriver() three-way choice
                 └─▶ imessage.controller devicePayload() ─ /status + /agents payloads
```

The iMessage read/send surface stays gate-free (it needs only the agent link)
— but a Windows agent never registers iMessage handlers, so a `list_chats`
dispatched to a Windows device fails cleanly with `unknown method` (pinned by
`windows-agent` tests). W1 adds an iMessage capability gate to `selectAgent`
calls in the iMessage controller so a mixed fleet routes correctly.

---

## 3. The Windows agent (windows-agent/) — module map macOS → Windows

| macOS (imessage-agent/) | Windows (windows-agent/) | Fate |
|---|---|---|
| `src/api.ts` — pair/poll/result, X-Agent-Token | `src/api.ts` | **Identical endpoints + wire**, plus the platform/capability advert on pair + poll |
| `src/config.ts` — `~/.config/digby-agent/config.json`, device-id file | `src/config.ts` | **Same layout** (`%USERPROFILE%\.config\digby-agent\`), same 0600 + stable deviceId semantics |
| `src/index.ts` — pair/run/status, UNAUTHORIZED → re-pair, 5s backoff | `src/index.ts` | **Same run-loop contract**; no osascript dialogs (console prompt at W0, native dialog in W2's shell) |
| `src/computer.ts` — JXA CGEvent runner (macOS-only) | `src/win-platform.ts` | **Replaced** — the seam: `Win32Surface` + `Win32Input` interfaces, null impl at W0, koffi FFI at W1, Rust helper at W3 |
| `src/computer-keymap.ts` — HIToolbox keycodes + typing planner | `src/win-platform.ts` (VK + Set-1 scan codes) | **Ported** — same planner contract, Windows key tables (incl. `win`/`cmd` aliases, extended-key flags) |
| `src/browser.ts` — Playwright persistent profile | *(W1)* | **Not yet scaffolded** — ports nearly verbatim (profile at `%LOCALAPPDATA%\Digby\browser-profile`) |
| `src/cdp-attach.ts` — everyday-Chrome attach | *(W2)* | **Not yet** — W2 probes `msedge.exe` in addition to `chrome.exe` |
| `src/chatdb.ts` / `contacts.ts` / `sender.ts` — iMessage | — | **Intentionally absent** — iMessage is macOS-only; the agent advertises `['browser','computer']` |
| `launchd/` + `install.sh` | *(W2)* | **Replaced** by Task Scheduler logon trigger + NSIS installer |
| `test/*.mjs` — node:test on built dist | `test/win-scaffold.test.mjs` | **Same pattern** — 23 tests, run on Linux CI |

### 3.1 The platform seam (the architectural decision)

Everything Windows-specific lives behind two interfaces in
`windows-agent/src/win-platform.ts`:

```ts
interface Win32Surface {          // SEEING
  monitorSize(): Promise<{width, height}>;      // physical px (SendInput space)
  captureJpeg(maxDim, quality): Promise<{base64, width, height}>;
  frontmost(): Promise<{app, window} | null>;   // GetForegroundWindow/GetWindowText
}
interface Win32Input {            // ACTING
  cursorPos(): Promise<{x, y} | null>;          // GetCursorPos (verify-or-refuse)
  moveTo(x, y): Promise<void>;                  // SendInput MOUSEEVENTF_MOVE|ABSOLUTE
  mouseDown/mouseUp(button): Promise<void>;
  scroll(amount): Promise<void>;                // wheel, + = up
  keyDown/keyUp(spec: WinKeySpec): Promise<void>; // SendInput scancode events
  unicodeChar(ch): Promise<void>;               // KEYEVENTF_UNICODE fallback
  clearModifiers(): Promise<void>;              // pre-sweep before every sequence
  open(target): Promise<void>;                  // Win-key search / ShellExecute
}
```

Above the seam, everything is pure TypeScript — the keymap, the typing
planner, geometry reconciliation, and the whole `computer_*` command dispatch
(verify-or-refuse clicks, modifier pre-sweep, image→screen conversion). That
is what the 23-test suite exercises **on Linux CI, no Windows box needed**.
Below the seam, W1 swaps `NullWin32*` for koffi FFI bindings and W3 for the
Rust helper (WGC + UIA) — nothing above changes.

### 3.2 Ported macOS contracts (the hard-won lessons)

| Contract | macOS origin | Windows implementation |
|---|---|---| 
| **Verify-or-refuse** — never click blind | ticket `4e4d56ff` | `moveToVerified()` in `commands.ts`: move → `GetCursorPos` read-back → one retry → refuse |
| **Geometry reconciliation** — refuse wrong-scale coordinates | ticket `4e4d56ff` | `imageToScreen()` in `win-platform.ts`: aspect-check image vs monitor; mismatch (>2% drift) refuses (the per-monitor DPI trap) |
| **Real scan codes** — never "keycode 0 + hope" | ticket `cbaf3e08` | `typeStepsFor()`: every printable US-ASCII char → real VK + Set-1 scan code + shift flag; non-ASCII → one intact `KEYEVENTF_UNICODE` code point |
| **Modifier-clearing pre-sweep** | macOS stuck-shift lessons | `clearModifiers()` runs before every planned input sequence |
| **Never throw into the run loop** | agent stability doctrine | every command returns an Observation; the null seam refuses with a W1-naming error |

### 3.3 Version policy

`AGENT_VERSION = '0.6.0'` — deliberately above every backend dispatch gate
(browser `0.2.0`, computer `0.3.0`, computer-claim `0.3.2`, pop-out `0.4.0`,
CDP-attach `0.5.0`). The broker's `minAgentVersion` requeue logic compares
plain versions; until W1 moves command-claiming onto the capability
handshake, 0.6.0 lets this agent claim everything the backend parks. (A
regression test pins "version must be ≥ 0.5.0".)

---

## 4. Capability mapping (what each surface does, by device class)

| Surface | macOS agent (legacy + advertising) | Windows agent (W0/W1) |
|---|---|---|
| iMessage read/send | ✅ (always for legacy rows; advertised for new) | ❌ never — no handlers registered; `unknown method` refusal |
| Local browser (Playwright persistent profile) | ✅ v0.2.0+ (legacy gate) or advertised | ��� W1 (advertised `browser`) |
| Computer use (screenshots + input) | ✅ v0.3.0+ (legacy gate) or advertised | ✅ W1 (advertised `computer`); W0 = clean refusal |
| CDP-attach (everyday browser) | ✅ v0.5.0+ + owner switch + per-task param | W2 — probes Edge too |
| Vision-model instructions | macOS doctrine (Spotlight, ⌘, TCC) | Windows doctrine (Win-key, alt+tab, UIPI/elevation) — `instructionsForPlatform()` |
| Status strings | "Mac app v…" (byte-identical for legacy) | "Windows agent v…" / "your paired Windows PC is offline…" |
| Routing | `selectAgent(target → default → most-recently-online)`, capability-gated per surface | Same router, same gate — a Mac + PC fleet routes per capability |

**Mixed-fleet semantics:** a user with a MacBook Pro (legacy row) and a
Windows PC (advertising `browser,computer`) gets: browser tasks may route to
either (both capable); computer tasks likewise; iMessage read/send routes to
the Mac only (once W1 adds the iMessage gate to the iMessage controller's
`selectAgent` calls — today it targets any online agent, and the Windows agent
refuses cleanly).

---

## 5. What W1 adds (next milestone)

1. **koffi FFI layer** implementing `Win32Surface`/`Win32Input`: GDI BitBlt
   capture (+ JPEG encode/downscale to the ≤1568px/quality-75 contract),
   SendInput mouse/keyboard, GetCursorPos, GetForegroundWindow/GetWindowText,
   ShellExecute, modifier clearing.
2. **Playwright browser_\*** with the persistent profile at
   `%LOCALAPPDATA%\Digby\browser-profile` (ports nearly verbatim from
   `imessage-agent/src/browser.ts`).
3. **Post-action screenshot** after every input action (the macOS contract:
   the model always sees the result of its last action) — wire it into
   `executeComputer`'s click/type/key/scroll/open handlers.
4. **iMessage capability gate** on the iMessage controller's read/send
   `selectAgent` calls (mixed-fleet routing).
5. **Frontend polish**: render `platform` + `capabilities` per device in the
   Account → Integrations device list (payload already carries them).
6. First round-trip: `digby-win-agent run` against a dev backend, computer-loop
   driving a real Windows box (manual — no Windows CI runner yet; the pure
   layers stay Linux-tested).

**Later milestones (unchanged from the roadmap):** W2 WebView2 shell +
`__digbyDesktop` bridge (`platform:'windows'` via `window.chrome.webview.postMessage`)
+ NSIS per-user installer + Azure Artifact Signing + Edge CDP-attach probe;
W3 Rust helper (WGC capture, UIA tree dumps + invoke fallback, elevation/
secure-desktop/DRM detection, anti-cheat refusal list); W4 hardening matrix.

---

## 6. Verification evidence (W0)

- `backend` jest: `agent-capabilities.test.ts` 21/21 new tests; full
  imessage/computer-agent/browser-agent/coding-integrations suites 276/276
  pass (legacy behavior pinned).
- `windows-agent`: `npm test` — 23/23 node:test tests pass (advertisement,
  keymap, typing planner, geometry, dispatch contracts, null-seam refusals).
- `backend` `tsc --noEmit` clean after `prisma generate`.
