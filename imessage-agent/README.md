# Digby iMessage Agent (macOS)

A tiny background agent you run on your **own Mac**. It lets Digby read your recent
iMessages and send messages on your behalf — without exposing your Mac to the
internet. The agent **dials home** to Digby over an outbound HTTPS long-poll, so it
works behind any home router/firewall with no port-forwarding or tunnels.

```
Digby web UI ──▶ Digby backend ──(parks a command)──▶  [ long-poll ]  ◀── Digby Mac agent
                                                                            • reads ~/Library/Messages/chat.db (read-only)
                                                                            • sends via Messages.app (AppleScript)
```

Your message history stays on your Mac. Only the specific conversations/messages you
ask about (or the message you send) ever leave the machine.

---

## Which component is which (naming)

Three separately-versioned Digby pieces can live on one Mac — the permission panes
name the **binary**, so this is the map from component → binary → pane entry
(ticket 933e6ca4):

| Component | What it is | Binary macOS asks about | Updates via |
| --- | --- | --- | --- |
| **Digby desktop app** | The window you chat in (`Digby.app`, v0.1.x) | `Digby` (its own app sandbox — not in the FDA/Screen Recording lists for the agent) | The app's own updater (`digby.example.com/desktop-latest.json`) |
| **Bundled helper** (`DigbyHelper`) | The agent copy inside `Digby.app/Contents/Resources` — installed by the app's one-click "Set up iMessage on this Mac" (which now refuses when a self-managed agent exists, ticket 405927c9) | `DigbyHelper` | Nothing (frozen at the app's build) — retired automatically by agent ≥ 0.9.1 |
| **`.pkg` install** (`DigbyAgent`) | The signed installer's copy at `/Library/Digby/imessage-agent` | `DigbyAgent` (a second, separate TCC entry from the self-managed one) | Nothing (root-owned, no bundled npm) — retired automatically by agent ≥ 0.9.2; the fresh .pkg also yields to a self-managed install |
| **Digby agent** (`DigbyAgent`) | The self-managed background agent this repo builds (label `com.digby.agent`) | `DigbyAgent` | Itself (self-update, `digby.example.com/digby-imessage-agent.tar.gz`) |

The one-line installer updates **only the Digby agent** — never the desktop app
and never the bundled helper. Installing it retires a bundled helper **and any
old `.pkg` install** so the stale shapes never poll side by side with it (they
share one token; the last poller wins the Mac's reported version — ticket
405927c9's "still says I have old 0.63"). The retired `.pkg`'s payload stays at
`/Library/Digby` but is inert (its LaunchAgent is gone); remove it any time
with `sudo rm -rf /Library/Digby`.

**What is actually RUNNING (ticket c6e91d19):** every install tree on disk only
proves what was *downloaded*. The running agent (≥ 0.9.3) stamps
`~/.config/digby-agent/running-agent.json` — `{version, pid, entry}` — first
thing in its run loop, and the idle loop re-runs the bundled-helper retire
every 5 minutes (the desktop app's one-click can re-register the stale helper
at any moment; apps older than the 405927c9 guard have no self-managed check).
`install.sh` waits for the stamp to name the installed tree's version after
`launchctl load` and fails loudly (exit 1 + the diagnostics to run) when the
service never comes up — the update command can no longer "complete" while the
Mac keeps polling an old helper. 0.9.4 hardens the check itself (the stamp is
dropped before the load and its pid must be alive, so a dead process's stale
stamp can never verify; paths with apostrophes and symlinked invocations work).
0.9.5 (ticket 21c68e74) then fixed the RUNTIME under the service: the
installer had been copying the Homebrew `node` binary verbatim as DigbyAgent —
a keg-coupled build that `brew upgrade`/`brew cleanup` strands with
`dyld: Library not loaded: @rpath/libnode.NN.dylib` (the 2026-10-23 incident:
the Mac silently read offline and every computer_task dispatch failed). The
installer now installs the official nodejs.org build of the same version when
your Node is keg-coupled, and the agent self-heals an existing coupled runtime
on its first idle poll (sha-verified + selftested before the swap).
0.9.6 fixes the owner-presence self-trip (ticket 81105154): the run's own
synthetic input no longer reads as "human input N s ago" — the HID reading is
attributed at the moment it was taken while the reported idle is measured at
the report clock, so unattended machine runs no longer self-latch camera-only.
0.9.7 (ticket e2915963) closes the silent-permission-loss loop that self-update
swap opened: the runtime heal never swaps a byte-identical binary (the grants
survive — install.sh's `cmp -s` idiom carried into the agent-side swap), a REAL
swap stamps `runtime-swap.json` so its successor attributes the cause, and the
run loop watches every poll for a previously-granted Accessibility / Screen
Recording / Full Disk Access flag reading false — a regression surfaces
immediately on the Mac (notification + dialog + the Privacy & Security pane)
and via Telegram through the backend's poll-seam regression detector, instead
of dying at the next `computer_*` dispatch with "Missing macOS permission(s)"
and nobody told. The grants themselves cannot be preserved across a REAL
runtime change (macOS attaches them to the exact file) — the re-grant stays a
one-click owner action, but it is now ASKED FOR the moment it is needed, not
discovered hours later at task time.
Quick check on any Mac:

0.9.8 (ticket 30787bc4) closes the every-minute permission-dialog loop the
0.9.7 story left behind: the permission-status path re-probed Screen Recording
with a REAL `screencapture` on every 15 s TTL, so a TCC-orphaned (self-updated)
binary re-raised the native "DigbyAgent would like to record this computer's
screen and audio" dialog roughly every minute while System Settings still
showed the old entry's toggle ON. The status poll now gates that probe behind a
hard exponential backoff (5 min → 20 min → 80 min → 6 h, advanced at the
probe's single choke point — onboarding's once-per-binary native ask and
computer_use captures stay prompt-armed and feed the same ladder, so their
prompt is never echoed 15 s later). First-launch onboarding and a real
computer_use capture remain the prompt-bearing paths.

```sh
cat ~/.config/digby-agent/running-agent.json   # version/pid/entry of the RUNNING agent
launchctl list | grep -i digby                 # com.digby.agent should be the only Digby job
```

**Replacing or deleting a binary invalidates its macOS grants.** Screen Recording,
Accessibility, Full Disk Access and Calendars (EventKit) are tied to the exact
file; a new binary is a new app to macOS, and the panes may keep showing a
stale entry for the old one while the new binary's captures come back
solid-black. Since 0.9.9 (ticket c44b19e9) the agent self-heals this: after
every self-update + relaunch it runs ONE non-requesting permission preflight
(authorization-status queries only — it never re-raises a consent dialog), and
a runtime watchdog classifies call-time TCC denials (calendar-denied, the
solid-black-capture conviction, the Full Disk Access block) as a lost grant.
Either path surfaces ONE consolidated re-grant card listing every missing
grant with its System Settings pane and the instruction to quit + relaunch
(the new grant only applies to a freshly launched process). After replacing a
helper: follow the card, remove any stale entry, re-add the binary the
installer reveals, then quit and relaunch Digby.

**The Calendars TCC row belongs to the agent binary, not the Digby app**
(ticket daf8706a). macOS attributes the EventKit request to whichever process
asks — the launchd `DigbyAgent` (or the app-bundled `DigbyHelper`), never the
"Digby" app shell. If a Calendar read reports denied or never-requested, the
agent's own unavailable payload now names the exact client binary; enabling
the "Digby" app row in System Settings → Privacy & Security → Calendars does
NOT grant the agent. Since agent v0.9.11, a first-ever read on a Mac with no
Calendars row for the agent fires a one-time consent request from the agent
binary itself (the native prompt appears on the Mac); if it was dismissed or
the idiom is unsupported on that macOS build, enable the agent binary's row
directly (System Settings → Privacy & Security → Calendars) and quit +
relaunch the agent.

---

## Requirements

- macOS with **iMessage signed in** (Messages.app working).
- **Node.js 20+** (`brew install node` — current Homebrew Node 24/25/26 all work).
- Two macOS permissions for messaging (the installer reminds you):
  - **Full Disk Access** for the **DigbyAgent** binary (the installer installs the
    Node runtime at `~/Library/Application Support/Digby/bin/DigbyAgent` — a copy
    of your Node when it is a self-contained build, or the official nodejs.org
    build of the same version when your Node is a Homebrew keg-coupled one, which
    a `brew upgrade` would otherwise break — and reveals that file) — needed to
    read `chat.db` (and the AddressBook store,
    for contact-name resolution). Older installs added a `node` entry instead —
    you can remove it; it is no longer used.
  - **Automation → Messages** — needed to send (the first send shows a prompt).
- Two more if you use browser/computer control:
  - **Screen Recording** — needed for `browser_screenshot` / `computer_screenshot`.
  - **Accessibility** — needed for `computer_*` input (click/type/key/scroll via CGEvent).

---

## Install — the easy way (recommended)

In Digby go to **Account → Integrations → iMessage → Connect your Mac**. It shows a
**single command with your pairing code already in it**. Open **Terminal** on your
Mac (⌘-Space → "Terminal") and paste it:

```bash
curl -fsSL https://digby.example.com/install-digby-agent.sh | bash -s -- YOUR-CODE
```

On a **self-hosted Digby** the card builds the command from that instance's own
address — the script and the agent tarball come from your server and the pairing
API is your `/api`, never digby.example.com:

```bash
curl -fsSL https://digby.example.com/install-digby-agent.sh | DIGBY_INSTALL_HOST=https://digby.example.com bash -s -- YOUR-CODE https://digby.example.com/api
```

That downloads + builds the agent, pairs it, and installs the 24/7 background
service. At the end it opens **System Settings → Full Disk Access** and reveals the
**DigbyAgent** binary — drag it into the list and switch it ON. Done.

## Install — manual (developers)

```bash
cd imessage-agent
./install.sh          # builds, pairs (prompts for the code), installs the launchd service
```

`DIGBY_PAIR_CODE=XXXX DIGBY_API_URL=http://localhost:4000/api ./install.sh` pairs
non-interactively (handy for local testing). After granting Full Disk Access, the
service restarts itself; to do it manually:

```bash
launchctl unload ~/Library/LaunchAgents/com.digby.agent.plist
launchctl load   ~/Library/LaunchAgents/com.digby.agent.plist
```

---

## Manual / development usage

```bash
npm install
npm run build

# npm >= 12 blocks dependency install scripts unless the project opts in —
# package.json's allowScripts covers better-sqlite3, so its prebuilt/downloaded
# native module is fetched normally. If the addon ends up missing or unloadable
# (npm said "up to date" over a stale one), `npm rebuild better-sqlite3` fixes
# it; install.sh's self-update does this automatically.

node dist/index.js pair      # pair with a code from the Digby UI
node dist/index.js status    # show config + check chat.db access
node dist/index.js run       # run the loop in the foreground (Ctrl-C to stop)
```

Pairing during development against a local backend? Enter your backend URL when
prompted, e.g. `http://localhost:4000/api`.

---

## What the agent can do

### iMessage

| Command (from Digby) | Action on your Mac |
|---|---|
| `list_chats`   | Recent conversations (contact name resolved via AddressBook, last message, time) |
| `get_messages` | Recent messages in one conversation |
| `send_message` | Send an iMessage to a phone number or email |

Sending is to a **direct recipient** (phone/email). Group chats, attachments, and
inbound "new message" triggers are planned follow-ups.

### Browser automation (v0.2.0+)

The backend's browser agent can drive a real browser on your Mac (Playwright,
persistent logged-in profile) — the agent doubles as the **local browser driver**:

| Command | Action |
|---|---|
| `browser_navigate` / `browser_get_content` / `browser_extract` | Open a URL, read text/HTML/snapshot |
| `browser_click` / `browser_type` / `browser_scroll` | Interact with the page |
| `browser_screenshot` / `browser_close` | Capture the page, close the browser |

### Computer use (v0.3.0+)

The agent is also the **computer-use target**: Digby can see your screen and drive
it (CGEvent):

| Command | Action |
|---|---|
| `computer_screenshot` / `computer_frontmost` | Capture the screen, report the frontmost app |
| `computer_click` / `computer_type` / `computer_key` / `computer_scroll` | Mouse + keyboard input |
| `computer_open` | Open an app by name |

`ping` (liveness/version check) and contact-name resolution round out the command
set.

---

## Config & security

- Config lives at `~/.config/digby-agent/config.json` (chmod 600). It contains your
  backend URL and the agent token issued at pairing.
- The backend stores only a **SHA-256 hash** of that token — it can verify the agent
  but cannot recover the token.
- Revoke at any time from **Digby → Account → Integrations → iMessage → Disconnect**
  (then quit the agent: `launchctl unload …`).

---

## Notes / known limitations

- **`attributedBody` decoding:** modern macOS stores some message text in a binary
  `attributedBody` field instead of `text`. The agent best-effort-decodes it; rare
  messages (rich content) may come back empty.
- The Mac must be awake and online to respond. While asleep, requests from Digby
  simply time out; they work again once it wakes and the long-poll reconnects.
- Native dependency `better-sqlite3` compiles on install — that's expected.
  Under a **hardened-runtime interpreter** (DigbyHelper) the locally built
  (adhoc-signed) module is REFUSED at dlopen: install.sh then carries a signed
  module from a sibling `agent-*` tree (same dep version) and FAILS LOUDLY if
  none loads. A `better-sqlite3` version bump requires a Team-signed module
  shipped with the release tarball — see `docs/IMESSAGE_AGENT.md` (ticket 0e4c9601).
