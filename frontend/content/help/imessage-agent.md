# Digby iMessage Bridge — Architecture & Runbook

A downloadable macOS agent that runs 24/7 on the user's Mac and lets Digby **read
and send iMessages**, **drive a browser** on the Mac (Playwright, 8 `browser_*`
commands), and **control the screen** (7 `computer_*` commands — the agent doubles
as the computer-use target), plus `ping` and contact-name resolution. Inspired by
[apple-flow](https://github.com/dkyazzentwatwa/apple-flow), but deliberately
simpler: no local AI, no inbound `!!agent` triggers — everything is dispatched by
the Digby backend.

---

## Topology — "agent dials home" (HTTP long-poll)

The Mac sits behind a home NAT, so the cloud can't connect to it. Instead the agent
opens **outbound** HTTPS long-polls to Digby; the backend parks a command and the
agent picks it up on its next poll, runs it locally, and POSTs the result back. No
tunnels, no port-forwarding, no WebSocket/nginx changes.

```
Digby Web UI ─▶ Backend ─(park command in in-memory broker)─┐
                                                            │   GET /imessage/agent/poll  (long-poll, X-Agent-Token)
                       macOS agent  ◀─────────────────────── ┘
                       • read chat.db (read-only, FDA)
                       • send via Messages.app (AppleScript, Automation)
                       └─ POST /imessage/agent/result ──▶ Backend resolves the awaiting request
```

Production is blue-green (one active backend), so command↔result correlation lives
in-memory (`agent-link.ts`). A backend restart mid-command just times the request
out and the user retries.

---

## Components

### Backend (`backend/src/modules/crossmodel/imessage/`)
- `agent-link.ts` — in-memory broker: `dispatch()` (park + await), `waitForCommand()` (long-poll), `deliverResult()`.
- `imessage.service.ts` — pairing codes (Redis, 10-min TTL, single-use), token mint + **SHA-256 hash** storage, agent registry helpers, online window (45s).
- `imessage.controller.ts` — web-UI endpoints + agent transport endpoints.
- `imessage.routes.ts` — mounted at `/api/crossmodel/imessage` (before global auth; agent endpoints use `X-Agent-Token`, user endpoints use JWT).
- `intent-detector.ts` — regex intent so chat queries about "texts/imessages" pull recent conversations into context.
- `nlp.ts` — resolves which conversation the user means (contact/conversation matcher) and parses a "text <someone> <message>" request into a confirmable draft (utility LLM).

Computer-use wire vocabulary (`backend/src/modules/crossmodel/computer-agent/`): the macOS agent implements `computer_screenshot/click/type/key/scroll/open/frontmost` (7 commands, agent v0.3.0+, dispatch gate `minAgentVersion` 0.3.2). **W3 (2026-09-25) adds two Windows-only methods** — `computer_uia_tree` (read the UI Automation accessibility tree: params `root`/`max_depth`/`max_nodes`, server-clamped to depth 1..12 and 1..1000 nodes) and `computer_uia_invoke` (activate an element by `runtime_id` with pattern `invoke|toggle|expand|select|focus|set_value`) — both dispatched with the stricter `minAgentVersion: '0.9.0'`, so a Mac (agent 0.6.x on main; the owner's INSTALLED build is still 0.4.3 as of 2026-09-26) never claims them; the backend offers the matching `uia_tree`/`uia_invoke` tools to the vision model on Windows sessions only.

**Input-injection integrity (agent 0.9.16, ticket 746c4d4f — "left-click arrives as right-click, Cmd-shortcuts go to Finder"):** modifier state is **NOT per-event state** — it is the WindowServer's GLOBAL state (`kCGEventSourceStateHIDSystemState`), and only a physical modifier **key-UP transition** clears it. The agent has swept it before every typed character since 0.4.2, but the `click` and `key` paths never did, so one `key` chord left a modifier latched and every later event was silently corrupted:

- macOS resolves a **LEFT mouse-down carrying the Control flag as a SECONDARY (right) click**. A latched Control therefore turns every left-click into a context menu (the report: Discord's channel list opening Mark As Read / Add to Favorites / Invite / Pin / Copy Link / Mute instead of selecting the channel), and turns a Dock click into the Dock's own menu instead of activating the app (the report's "cannot re-front").
- A chord posted as **flag bits on a single keydown**, with no modifier-key transition, is not a chord to the target app: apps that key off `modifierKeyDown` (Discord included) see a bare `k`, and whatever owns the global handler eats it — Finder (the report's "Cmd+K goes to Finder").

Since 0.9.16: `click` calls `clearModifiers()` (every modifier key-UP) **before** the move+click; `key` posts a real modifier-key **DOWN** before the char and **UP** after it, released in **reverse** press order, then sweeps clean again so the next action starts from a known state. The flags read back *before* the sweep ride out on every result as `clearedModifiers` — device-side proof that an event was corrupted, without a trace. Shift is deliberately **not** in the pre-click sweep (shift-click selection must survive). Modifier keycodes now come from one unit-tested source (`computer-keymap.ts` → `modifierKeyTableJson()`/`ALL_MODIFIER_KEYCODES`), not hand-typed literals in the JXA runner. Regression replay: `imessage-agent/test/computer-input-focus.746c4d4f.test.mjs`.
**Display topology + new tool-result surfaces (agent 0.6.2, 2026-09-26 — shipped in DMG 0.1.10 with agent 0.6.3 the same day; see the v0.6.3 onboarding note under Setup):** the 2026-09-25 "dead input" was NOT permissions — the tccd log showed every DigbyHelper PostEvent / ScreenCapture / Accessibility request ALLOWED. The agent captured only display index 1 (`screencapture -D 1`) and mapped clicks through `CGMainDisplayID` while focus lived on another display (lid-closed MBP with the built-in LCD still "main" + the Dell at x=1728; each macOS Screen Sharing connect/disconnect collapsed the topology to one 1920×1080 virtual display), so input landed off-camera → identical frames → the watchdog blamed input delivery. 0.6.2 captures the display that owns the FRONTMOST window (pointer, then main, as fallbacks; `displays` JXA action; PNG pixel-size verification; `DIGBY_CAPTURE_DISPLAY=main` restores the old behaviour), translates clicks through the CAPTURED display's origin, and stamps `{displayId, displayIndex, displayCount, imageWidth, imageHeight, frontmostWindowDisplayId, pointerDisplayId, hidIdleSeconds (own events excluded), remoteSession}` on every `computer_screenshot`. The backend (`computer-agent/`) forwards them into `screenshotFrame` + `browser_observation` and adds these result surfaces: `[FOCUS ON UNCAPTURED DISPLAY]` instead of a dead-input strike (`FOCUS_SPLIT_NOTICE_DISABLED`); a harness-stated diff after every action ("bytes identical / N% pixels changed / frontmost A→B / display M of K", `COMPUTER_HARNESS_DIFF_DISABLED`) + harness counters in the tool-result header; a frontmost-app change is POSITIVE input evidence ("INPUT DELIVERED"); a MULTI-LEG positive-control probe at 2 strikes before any abort (Cmd+Space then Cmd+Tab, PASS if ANY leg changes the screen; an inconclusive leg stops the probe rather than dispatching the next one blind, and a probe that never produced a compared frame pair does not spend the attempt budget — ticket 09c984d8; `COMPUTER_WATCHDOG_PROBE_DISABLED`; the abort copy names the real agentVersion + "the app may be on a display I am not capturing", and a PASSED probe whose note says a leg "changed nothing on this Mac" means that shortcut is remapped, not that the keyboard is dead); `[COMPUTER_TASK — BUSY]` naming the holder chat/lane after `COMPUTER_LOCK_WAIT_MS` 60 s (also `get_account_overview.pairedMac.devices[].busy`); the OWNER-PRESENCE GATE — a MACHINE-triggered run is camera-only while a human typed in the last `OWNER_PRESENCE_IDLE_SEC`=120 s or a Screen Sharing / TeamViewer session is active (`OWNER_PRESENCE_GATE_DISABLED=1`; reported on the result, never silent); settle 600 ms / 1.5 s after `open` or Spotlight-Return (`COMPUTER_SETTLE_MS` / `_LONG_MS`); a bounded `wait` tool (≤10 s, `COMPUTER_WAIT_TOOL_DISABLED`); decoded frame readability (jpeg-js, `COMPUTER_FRAME_READABILITY_DISABLED`); one corrective retry on a DSML/tool-call leak in the vision seat's final text (`COMPUTER_LEAK_RETRY_DISABLED`); the degeneration signature ignores screenshots/reads and honours modifiers (`COMPUTER_DEGENERATION_GUARD_LEGACY`). Owner steps until the new DMG: run the target Mac with ONE display, expect topology flips on Screen Sharing connect/disconnect, do not toggle TCC for this symptom; after the REAL reinstall re-grant Accessibility + Screen Recording once (tccd keys DigbyHelper by path).

Plus: `IMessageAgent` Prisma model (`imessage_agents` table), chat-context injection in `crossmodel.controller.ts`, optional env vars in `config/env.ts`.

### Frontend
- `lib/api/crossmodel.ts` → `imessageApi` + types.
- `app/crossmodel/account/IMessageCard.tsx` → pairing, status, read recent chats, send a message. Rendered in `IntegrationsTab.tsx`.

### Agent (`imessage-agent/`)
Node/TypeScript. `index.ts` (CLI `pair|run|status` + the command dispatch switch), `config.ts` (pairing config at `~/.config/digby-agent/config.json`), `api.ts` (outbound HTTP), `chatdb.ts` (read-only chat.db + `attributedBody` decode), `contacts.ts` (handle → name resolution via the macOS AddressBook store), `sender.ts` (AppleScript), `browser.ts` (Playwright — the 8 `browser_*` commands, v0.2.0+), `computer.ts` (CGEvent screen control — the 7 `computer_*` commands, v0.3.0+). launchd service + `install.sh`. See `imessage-agent/README.md`.

---

## HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/crossmodel/imessage/pair/start` | JWT | Issue a pairing code |
| POST | `/api/crossmodel/imessage/pair/complete` | pairing code | Agent redeems code → `{ agentId, agentToken }` |
| GET | `/api/crossmodel/imessage/status` | JWT | `{ connected, online, deviceName, lastSeenAt }` |
| GET | `/api/crossmodel/imessage/agents` | JWT | List paired devices (Macs and Windows PCs — each row carries `platform`) |
| DELETE | `/api/crossmodel/imessage/disconnect` | JWT | Revoke (`?label=` optional) |
| GET | `/api/crossmodel/imessage/chats?limit=` | JWT | Recent conversations (dispatched to Mac) |
| GET | `/api/crossmodel/imessage/messages?chat=&limit=` | JWT | Messages in a conversation |
| POST | `/api/crossmodel/imessage/send` | JWT | Send `{ to, text }` |
| POST | `/api/crossmodel/imessage/agents/:id/permission-action` | JWT | Permission onboarding buttons `{ action: 'relaunch' \| 'open-pane' \| 'reveal', pane? }` (agent ≥ 0.6.0) |
| GET | `/api/crossmodel/imessage/agent/poll` | `X-Agent-Token` | Long-poll for next command (also advertises `ax`/`sr`/`fda`/`relaunch` TCC state) |
| POST | `/api/crossmodel/imessage/agent/result` | `X-Agent-Token` | Return a command result |

---

## Activation (production) — LIVE

The feature is fully activated in production (signed `DigbyAgent.pkg` /
`Digby.dmg` published under `frontend/public/`; 2026-10-25 interim: the .pkg
download flow is freshness-gated — see the installer section below — and stays
de-featured until the branded rebuild publishes with its stamp). Operational notes:

1. **Migrations run automatically during deploy** (`deploy-blue-green.sh` runs
   `prisma migrate deploy`) — the additive `imessage_agents` table needs no
   manual step.
2. **(Optional) env** in production `.env`:
   - `IMESSAGE_AGENT_API_URL` — base URL the agent dials home to (default `https://digby.ai/api`).
   - `IMESSAGE_AGENT_DOWNLOAD_URL` — where the UI links the agent download.
3. Long-poll uses plain HTTPS, so **no nginx changes** are needed (each
   poll is < 30s, well under the proxy idle timeout).

---

## Testing on your Mac

### Option A — against production
1. In Digby: **Account → Integrations → iMessage → Connect your Mac**. The dialog
   shows a **one-line command with your pairing code already filled in**.
2. On the Mac, open **Terminal** (⌘-Space → "Terminal") and paste the command:
   ```bash
   curl -fsSL https://digby.ai/install-digby-agent.sh | bash -s -- YOUR-CODE
   ```
   It installs Node if needed (via Homebrew), downloads + builds the agent, pairs it,
   and installs the 24/7 launchd service — no manual `pair` step.
3. At the end it auto-opens **System Settings → Full Disk Access** and reveals the
   **DigbyAgent** binary in Finder (the Digby-named Node runtime the installer
   installs at `~/Library/Application Support/Digby/bin/DigbyAgent` — a copy of
   your Node for a self-contained build, or the official nodejs.org build of
   the same version when your Node is a Homebrew keg-coupled one, 0.9.5) —
   drag it into
   the list and toggle it ON. (First send also
   triggers a one-time Automation→Messages prompt — click Allow.) Since agent v0.6.0
   the helper **keeps running without FDA and picks the grant up live** (the probe
   re-runs on a 15s TTL) — no restart needed; iMessage reads simply start working
   once the switch is ON. **Since agent v0.6.3 (2026-09-26, owner ask "shouldn't
   the client request all necessary system settings the first time you install?")
   the first launch of each helper BINARY requests everything up front:** the
   native Accessibility prompt (`AXIsProcessTrustedWithOptions` — macOS pre-lists
   DigbyHelper, one switch), the native Screen Recording prompt (a throwaway
   `screencapture`, which is also the only trustworthy probe on macOS 26 — the CG
   preflight is not bridged and reads "granted"), Full Disk Access (no prompt API:
   pane + Finder reveal), then ONE checklist dialog of whatever is still missing.
   Calendars (EventKit) is NOT a launch prompt: it is granted on the first
   calendar read (or via the re-grant card) — and since agent v0.9.11
   (ticket daf8706a) the FIRST tier-0 read (no Calendars row for the agent
   binary at all) fires a one-time EventKit consent request from the agent
   binary itself, so a native Calendars prompt appears on the Mac and the
   agent gets its OWN TCC row (the "Digby" app row in System Settings is a
   DIFFERENT client — granting it alone never helps the agent; the row that
   must be ON is the agent binary's). Since 0.9.9 (ticket c44b19e9)
   `permission_open_pane` also accepts pane `calendars`, and a lost Calendars
   grant rides the same consolidated re-grant card the post-update preflight and
   the call-time denial watchdog surface (see README "Replacing or deleting a
   binary invalidates its macOS grants").
   The stamp lives in `config.json` (`permissionsOnboarded` = agent version +
   the helper's dev/ino), so a reinstall or app update re-arms it — exactly the
   case where the re-signed helper needs its grants re-made. Never a gate; the
   advertised `sr` flag now prefers the capture ground truth and re-probes on
   the 15s TTL while denied. `DIGBY_PERMISSIONS_ONBOARD=0` disables the prompts.
4. Back in Digby the card flips to **Online**. Click **Load** to see recent
   conversations, open one to read messages, and use the composer to **send**.

The installer lives at `frontend/public/install-digby-agent.sh` (served at
`/install-digby-agent.sh`); it pulls `frontend/public/digby-imessage-agent.tar.gz`
(`/digby-imessage-agent.tar.gz`).

### Option B — fully local (no production needed)
1. Run the stack locally (`docker-compose up` dev) so the backend is at
   `http://localhost:4000`. Open the frontend, sign in, generate a pairing code.
2. `cd imessage-agent && npm install && npm run build`
3. `node dist/index.js pair` → enter `http://localhost:4000/api` and the code.
4. `node dist/index.js run` (foreground). Grant Full Disk Access to your terminal's
   node, allow Automation on first send.
5. Drive it from the UI card, the REST API, or chat ("what are my recent imessages?").

### Quick API smoke test (with a JWT)
```bash
# pairing code
curl -s -X POST https://digby.ai/api/crossmodel/imessage/pair/start -H "Authorization: Bearer $JWT"
# status
curl -s https://digby.ai/api/crossmodel/imessage/status -H "Authorization: Bearer $JWT"
# send (after agent online)
curl -s -X POST https://digby.ai/api/crossmodel/imessage/send -H "Authorization: Bearer $JWT" \
  -H 'Content-Type: application/json' -d '{"to":"+15551234567","text":"hi from Digby"}'
```

---

## Native signed installer (.pkg) — zero-Terminal path

For non-technical users, `macos-pkg/` builds a **signed + notarized `DigbyAgent.pkg`**
that bundles its own Node runtime (no prerequisites) and self-pairs via a **native
popup** (no Terminal). Build it on a Mac (`cd macos-pkg && ./build-pkg.sh` — needs the
Developer ID Application + Developer ID Installer certs, Team ID `Z5U9T5PUJ3`, and a
`notarytool` credential profile), then publish `frontend/public/DigbyAgent.pkg`
together with its `DigbyAgent.pkg.json` freshness stamp (build-pkg.sh stages both
into `frontend/public/`). The iMessage card features the .pkg download flow ONLY
while the stamp says the served pkg bundles the current agent release (405927c9
interim, 2026-10-25) — an unstamped or stale pkg falls back to the one-line
installer, so publish both files or neither.
The build is macOS-only (codesign/notarytool) and can't run in CI/Linux. See
`macos-pkg/README.md`.

Installer identity + fleet rules (ticket 405927c9): the distribution carries the title
**"Digby iMessage Agent"** (no more nameless `Installer installed ""`), the pkg version
always equals the bundled agent's version, and the build refuses an agent older than
the release manifest — publish the tarball (`scripts/publish-agent-tarball.sh`) first.
A `.pkg` install never self-updates (root-owned, no npm); the self-managed agent
(≥ 0.9.2) retires its LaunchAgent when both exist, and a fresh `.pkg` yields to a
self-managed install instead of polling beside it.

## Removing an old install (cleanup)

Every install shape and how to remove it (see also the component table in
`imessage-agent/README.md`):

- **Self-managed agent** (the one-line installer's; label `com.digby.agent`):
  `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.digby.agent.plist && rm ~/Library/LaunchAgents/com.digby.agent.plist`
  (tree at `~/Library/Application Support/Digby/imessage-agent`; binary at
  `~/Library/Application Support/Digby/bin/DigbyAgent`).
- **Old `.pkg` install** (label `ai.digby.imessage-agent`, payload at
  `/Library/Digby`): agent ≥ 0.9.2 retires it automatically when a self-managed
  agent exists; to remove the inert payload outright:
  `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.digby.imessage-agent.plist; rm ~/Library/LaunchAgents/ai.digby.imessage-agent.plist; sudo rm -rf /Library/Digby`.
- **Desktop app's bundled helper** (label `ai.digby.imessage-agent`): retired
  automatically by agent ≥ 0.9.1 whenever a self-managed agent runs; removing the
  desktop app removes it too. Stale **DigbyHelper / DigbyAgent / node entries in the
  permission panes** (System Settings → Privacy & Security) can be deleted with their
  − buttons — macOS keeps rows for binaries that no longer exist.

## Security & privacy
- chat.db is opened **read-only**; history stays on the Mac except the rows a tool returns.
- Agent token stored **hashed (SHA-256)** server-side — not recoverable.
- Pairing code is single-use, 10-min TTL.
- Sends are explicit user actions; revoke instantly via Disconnect.

## Self-update (v0.8.0, ticket 4e75cdea)

Before 0.8.0 the agent NEVER upgraded itself — 0.6.3 stayed live below the
0.7.0 protocol floor for days after 0.7.3 shipped until a human pushed the
tarball over SSH. Now the release travels the same outbound long-poll the
agent already uses:

1. **Advert** — every `GET /agent/poll` (and pair) response may carry an
   additive `update: { version, url, sha256 }` block, present ONLY when the
   polling agent is strictly older than the release named in the backend
   manifest (`agent-release.ts` — rewritten by `scripts/publish-agent-tarball.sh`
   together with the tarball itself, so the two can never drift).
2. **Act** — when idle (no command in hand), a self-managed install
   (`~/Library/Application Support/Digby/imessage-agent`, or any tree carrying
   the `.digby-selfupdate` marker) downloads the tarball, verifies the sha256,
   peeks the tarball's OWN package.json version (a stale artifact is a no-op,
   never a downgrade), runs `npm ci && npm run build`, carries the current
   tree's proven-loadable (Team-signed) `better_sqlite3.node` over the staged
   adhoc rebuild when the native dep version is unchanged — and REFUSES the
   swap when it changed (ticket 0e4c9601: `npm ci` builds adhoc-signed native
   modules that a hardened-runtime interpreter (DigbyHelper) refuses at
   dlopen, and the agent then runs degraded without failing a health check),
   smoke-tests the new tree (`node dist/index.js selftest` — imports every
   runtime module and loads each native addon in a FRESH child process, so a
   cached vnode signature cannot mask a Team-ID refusal), then swaps: old tree
   → `*.bak-<ts>` (kept), staged tree → agentRoot.
3. **Recover** — a detached watchdog spawned from the OLD tree waits 3 min for
   the new binary's first healthy poll (the ok-marker); missing → the backup
   is restored automatically. The agent restarts itself via `exit(1)` +
   launchd `KeepAlive` (the `permission_relaunch` idiom).
4. **Guardrails** — `DIGBY_SELF_UPDATE=0` on the Mac disables it;
   `AGENT_UPDATE_ADVERT_DISABLED=1` on the backend stops advertising to
   everyone; retry backoff (6h, max 3 attempts) stops a poison release from
   crash-looping a fleet. `.app`-bundled helpers, `/Library/Digby` `.pkg`
   installs and repo checkouts NEVER self-swap (their update paths are the
   app DMG and the installer). The manifest may also carry
   `minUpdaterVersion` (ticket 0e4c9601): the POLLER's own code performs the
   swap, so a release can require a minimum updater generation — the live
   floor follows the manifest (0.8.2 since a9a74086; 0.8.1-era releases were
   gated to 0.8.1 updaters because the 0.8.0 updater lands the adhoc-signed
   `better_sqlite3.node` under DigbyHelper (silent degraded boot).

#### Releasing with a `better-sqlite3` version change (ticket 0e4c9601)

A better-sqlite3 bump CANNOT ship as a plain self-update: the staged `npm ci`
builds the new version adhoc-signed and **wipes `node_modules`** before
rebuilding, so the updater refuses the swap by design ("native dep version
changed — needs a signed manual release") and agents stay on their current
release. It needs a **manual release** whose install context ends up with a
Team-signed module for the NEW version:

1. Run `install.sh` on each Mac from a context whose `node` is the Team-signed
   DigbyHelper (the b811d9f7 fleet pattern), then codesign the freshly built
   module with the Digby Developer ID and relaunch — or copy an already-signed
   module for the new version into
   `node_modules/better-sqlite3/build/Release/` after the build (install.sh's
   native-carry block only reuses a sibling module when versions match, so a
   bumped version needs its own signed module).
2. `install.sh` gates the install on `selftest` — which loads every native
   addon in a FRESH child process — and FAILS LOUDLY (exit 1, actionable
   message) when the tree cannot load its native modules, so an adhoc-only
   bootstrap can never install silently.

Bootstrap: agents below 0.8.0 have no updater and agents at 0.8.0 sit below
the 0.8.1 updater floor — the fleet's LAST manual push brings them to 0.8.1
(install.sh now carries a signed module from a sibling tree and gates on
selftest); everything after that is automatic EXCEPT native-dep-change
releases like 0.8.2 (below).

**0.8.2 (ticket a9a74086) is such a manual release** — better-sqlite3 moved
11.10.0 → 12.11.1 (Node 24/25/26 prebuilds; 11.10.0 shipped none past Node 23
and its C++ fails to compile on Node 26's V8), so `minUpdaterVersion` is
0.8.2 and the updater refuses the swap on every 0.8.1 Mac by design. A Mac
moves to 0.8.2 by running the one-line installer (Account → Integrations →
iMessage → the card's command — `--update-only` works when already paired):
it downloads the current tarball and builds fresh, so the new module is
signed by whatever context runs the install (see step 1 above for the
DigbyHelper fleet pattern). On a plain `node` (no hardened runtime) the
locally built 12.11.1 prebuild just works.

**0.8.3 (ticket 8bcd1c4a) is a NORMAL self-update release** — better-sqlite3
stays 12.11.1 and the floor stays 0.8.2, so 0.8.2 Macs take it automatically.
It fixes the npm ≥ 12 install-scripts block that reproduced EVEN ON 0.8.2
(verified: `npm install --ignore-scripts` on a 12.11.1 tree leaves
`better_sqlite3.node` missing — npm 12 blocks a dependency's install script
unless the project's package.json carries `allowScripts`, which 0.8.2 did not
ship): the tarball now ships `allowScripts: { "better-sqlite3": true }`, and
`install.sh` probes the built addon in a fresh child process and runs
`npm rebuild better-sqlite3` when it is missing or unloadable (npm prints
"up to date" and never rebuilds on a tree that satisfies the lockfile — the
stale-ABI-after-Node-upgrade class); a rebuild that still does not load
falls through to the sibling-tree carry and the selftest gate rather than
exiting (the DigbyHelper install path depends on that order). The selftest
now prints the child's real dlopen error plus the candidate causes instead
of guessing "signature refused?" (that guess is only true under a
hardened-runtime interpreter). The native carry also gained a loadability
guard: a current tree whose better_sqlite3.node does not load is never the
carry source (skip, not poison). NOTE: that guard only protects updaters
ALREADY on 0.8.3+ — a 0.8.2 poller still carries its broken module, fails
the staged smoke and refuses the swap, so a stale-ABI 0.8.2 Mac recovers by
re-running the one-line installer (a MISSING-module 0.8.2 Mac self-heals:
nothing to carry, the staged build passes the smoke).

**0.9.5 (ticket 21c68e74) makes the runtime self-contained** — the CLI
installer used to copy the *Homebrew* `node` binary verbatim as the DigbyAgent
runtime. Homebrew's node is a **keg-coupled** build (`@rpath/libnode.NN.dylib`
through the runtime's own `../lib` rpath plus ~100 `/opt/homebrew/opt/*`
dylibs), so a `brew upgrade node` that bumps the libnode SONAME — or a
`brew cleanup` that removes the old keg — stranded the launchd service with
`dyld: Library not loaded: @rpath/libnode.147.dylib` and the Mac silently
read "offline" in the paired-device registry (the 2026-10-23 incident: every
computer_task dispatch went [COMPUTER TASK — UNAVAILABLE] while the Mac was
awake). Both ends are fixed: the installer now *otool-checks* the resolved
interpreter and, when it is keg-coupled, installs the **official
nodejs.org build of the same version** (sha256-verified against
`SHASUMS256.txt`) as DigbyAgent; and the agent itself (≥ 0.9.5)
**self-heals** an existing coupled runtime on its first idle poll — stage the
official build, sha-verify, selftest the current tree under the *new* binary,
atomic swap at the stable path, then exit 1 so launchd relaunches from it. A
failed heal is never fatal (the old binary keeps polling; three attempts max).
The stable path, binary name, TCC story and `.node-origin` contract are
unchanged. Every Mac on ≤ 0.9.4 takes 0.9.5 by normal self-update and heals
its runtime on the next poll.
**0.9.6 fixes the owner-presence self-trip** (ticket 81105154): a
machine-triggered run's OWN synthetic click/type was being read as "human
input N s ago" — the raw HID idle is read inside the `displays` JXA, but the
classifier was called with `Date.now()` AFTER the whole screenshot pipeline
(front-window probe + `screencapture` + `sips` — 2–8 s later), which shifted
the event the reading points at forward past the own-input ledger window and
made the run's own input look like the owner's. Unattended drives then
self-latched camera-only in exactly the owner-absent windows they exist for.
The classifier now uses the READING's clock (the moment the OS value was
taken; the ioreg fallback stamps its own read); a missing stamp falls back to
the report clock — never a widened own-input window. Owner-presence TRUE
positives (a real keypress seconds before the reading) are unchanged. Every
Mac on ≤ 0.9.5 takes 0.9.6 by normal self-update.

**0.9.4 hardens that verification** (post-merge adversarial review of the
0.9.3 change): paths now cross into node via environment variables (a home
like `/Users/example'Brien` no longer makes the check fail on a broken JS literal),
the stamp is **invalidated before `launchctl load`** so a stale stamp from an
already-dead process can never satisfy the check, the verifier requires the
stamp's pid to be **alive** (`kill -0`), and the entry match accepts the
realpathed tree (a symlinked invocation no longer falsely fails). Every Mac
on ≤ 0.9.3 takes 0.9.4 by normal self-update.

**0.9.3 (ticket c6e91d19) is a NORMAL self-update release** — "the update
command completes but the agent still shows an old version" used to be a
SILENT failure: `launchctl load` returning 0 proved the plist was read, not
that any process launched, and nothing could distinguish "installed AND
running" from "downloaded while a stale app-bundled helper stayed the only
poller". The agent now stamps `~/.config/digby-agent/running-agent.json`
(`{version, pid, entry}`) the moment its run loop starts — one authoritative
answer to "what is actually running" (a disk tree only proves what was
downloaded). `install.sh` waits for that stamp to name the INSTALLED tree's
version + entry after `launchctl load` (one `kickstart -k` retry at 20s, a
loud exit-1 failure with the exact next steps at 90s), and the idle poll
loop re-runs the bundled-helper retire every 5 minutes so a desktop-app
one-click re-registration mid-run is cleaned in minutes, not at the next
reboot. **Checking what a Mac actually runs** (the old advice named a path
that never existed):

```
cat ~/.config/digby-agent/running-agent.json   # version + pid + entry of the RUNNING agent
launchctl list | grep -i digby                 # com.digby.agent (self-managed) should be the only Digby job
```

If the card shows an old version right after an update: re-run the card's
command — the installer now either verifies the running version out loud or
fails with the diagnostics to send.


## Roadmap
Group-chat sends, attachments, inbound "new message" triggers + push, chat-driven
send-with-confirmation card, WebSocket transport for lower latency.

(Shipped since v1: browser automation via Playwright — v0.2.0; computer use via
CGEvent — v0.3.0; the Swift menu-bar app + notarized `.dmg` — `macos-app/`,
published at `frontend/public/Digby.dmg`.)
