# Unattended / Autonomous use — the device preset (macOS + Windows)

> **Status:** detector + preset + fleet verdict shipped 2026-10-28 (owner request on card
> `oq_f7955582`: *"how can you fix this for all mac and windows clients to give full remote login
> permissions etc as this will be a requirement for most users to use their remote devices
> autonomously"*). Live machine verification is **pending an unlocked window** — see §7.

## 1. The problem, in one paragraph

macOS puts the **login window below every TCC permission**: the Digby agent can see and drive only
*inside a logged-in session*. Windows is the same shape — the secure desktop (and the BitLocker
pre-boot prompt) are deliberately unreachable by any process. So a paired machine that reboots,
sleeps into a lock, or whose screensaver asks for a password **strands the fleet behind a screen
only a human finger can clear.** Three separate owner cards asked for that same physical act in
one day. No OS lets remote software type the login password (that would defeat the entire point of
the credential prompt), so the fix is not "remote unlock" — it is **make the session never end**,
as a per-device setting.

## 2. What each OS actually allows (and what it fundamentally does not)

| | macOS | Windows |
|---|---|---|
| Auto-login at boot | ✅ `autoLoginUser` in `/Library/Preferences/com.apple.loginwindow.plist` **+** the account password in `/etc/kcpassword` | ✅ `AutoAdminLogon=1` + `DefaultUserName` + the **LSA secret** `DefaultPassword` |
| …with FileVault ON | ❌ **impossible** — pre-boot unlock has no user context | — |
| …with BitLocker TPM+PIN | — | ❌ **impossible** — the PC stops at a BIOS-level PIN prompt before Windows starts |
| …with Credential Guard / LSA protection | — | ❌ Windows refuses to store the secret |
| …with Windows Hello-only policy | — | ❌ auto-logon blocked by policy |
| Kill the idle lock | ✅ `screensaver askForPassword=0`, `idleTime=0` | ✅ `NoLockScreen=1`, `InactivityTimeoutSecs=0`, screensaver `Secure=0` |
| No idle sleep | ✅ `pmset -a sleep 0 disksleep 0 powernap 0` | ✅ `powercfg /change standby-timeout-ac 0` |
| Session keep-awake | ✅ `caffeinate -i -s -w <pid>` | ✅ `SetThreadExecutionState(CONTINUOUS\|SYSTEM_REQUIRED\|DISPLAY_REQUIRED)` |
| **Type the login password remotely** | ❌ never | ❌ never (the secure desktop) |
| **Re-attach a session the box lost** | ⚠️ `caffeinate -u` wakes DISPLAY sleep (a real lock still needs one keystroke) | ⚠️ `tscon <id> /dest:console` returns a DISCONNECTED session to the console — see §2.1 |
| Recover a device whose password EXPIRED | ❌ | ❌ — hence the `pwd-expiry` blocker |

Two honest consequences that belong in the decision, not in a footnote:

- **Fast user switching** (macOS) can land the machine on the login window after a logout even with
  auto-login configured — reported as the `fast-user` blocker.
- **FileVault / BitLocker pre-boot** means a reboot returns to an *unlock* screen even with
  auto-login on. The preset refuses rather than half-configuring; a FileVault Mac that reboots
  needs one human keystroke, and that is a property of disk encryption, not a Digby gap.

### 2.2 "Why doesn't TeamViewer require FileVault off?" — the honest answer (2026-11-03)

A fair question, asked on feedback ticket `539a99c3`, and the answer is: **it doesn't, and neither do
we for the path that is shaped like TeamViewer.** The confusion is real and this section exists so a
future editor does not have to re-derive it.

**FileVault guards exactly one boundary, and it is not the one remote control works at.**

| Stage | FileVault ON | What can reach it |
|---|---|---|
| **Pre-boot unlock** (the key icon, before macOS loads) | 🔒 present | **Nothing.** No OS, no network stack, no agent. TeamViewer cannot reach it either. |
| **Login window** (macOS running, nobody signed in) | ✅ permitted — the volume is already unlocked | The OS's own remote channel (Screen Sharing/RFB, RDP). This is where TeamViewer works, and where our brokered channel works. |
| **Logged-in, locked session** | ✅ permitted | The agent, via synthetic input. |

**So why does our preset refuse?** Because the "Unattended" preset is *not* a remote-control
mechanism — it is **auto-login**, which types the account password at the **pre-boot/login boundary
on the machine itself**. macOS performs auto-login before a user session exists, which on a
FileVault volume is impossible: there is no unlocked volume to log in to until a human (or a
one-time token) unlocks it. That is a property of the mechanism we chose, and it is why the refusal
is correct **for that mechanism**.

**The TeamViewer-shaped path does not have this constraint, and we already built it.** The brokered
Screen Sharing channel (§10) authenticates **at the login window** with its own dedicated VNC
credential. Its blocker vocabulary — `REMOTE_BLOCKER_PRIORITY` in `remote-access-verdict.ts` — is
`exposed` / `account-password` / `no-firewall` / `no-nla` / `no-cred` / `no-tunnel` / `stale`. **There
is no `filevault` token, because FileVault does not block it.** A Mac with FileVault ON can serve
Screen Sharing at its login window today. Anyone who reads the `filevault` blocker as "Digby needs
FileVault off to control my Mac" is reading the *auto-login preset's* blocker as if it governed the
remote channel — it does not.

**What Apple gives you for the one case that is genuinely blocked** — a Mac that has **rebooted** and
is sitting at the pre-boot unlock screen — is `fdesetup authrestart`: an administrator-supplied
one-time unlock so an unattended reboot completes without a human present. That is the real answer
the MDM world uses, it keeps FileVault ON, and it is **not implemented here**. It is listed as an
owner-gated follow-up because it reboots the device and needs an admin credential at the console —
neither is something a lane may do to a user's Mac unprompted.

**The one-line answer for the owner:** FileVault never had to be turned off to *see and drive* a Mac.
It only forbids *auto-login at boot*. Our remote-control path (the TeamViewer-shaped one) works with
FileVault ON; the preset that asks you to turn FileVault off is opting into a different, weaker
trade — an always-signed-in session — and you can simply not use it.

**Power tradeoff of the never-sleep settings** (`pmset -a sleep 0 disksleep 0 powernap 0` on macOS,
`powercfg /change standby-timeout-ac 0` on Windows): a machine that never sleeps keeps drawing
power and stays warm around the clock. That is the price of "always reachable" and it is why the
preset is only sensible on a **plugged-in** desktop or a Mac mini used as a node — on a laptop it
means the battery drains in sleep-less idle, a closed lid may still sleep (macOS clamshell sleep is
independent of `pmset sleep`), and Power Nap being off costs you background Time Machine / iCloud
sync while the display is off. On Windows the preset deliberately touches **AC only**
(`standby-timeout-ac`), never `-dc`: a laptop on battery *should* sleep. If a machine is on battery
most of the time, do not enable the preset on it — the fleet will lose it to sleep, and that is the
correct tradeoff.

### 2.1 Remote-unlock — what is actually possible, and what the agent really wires

The request asked for the remote-unlock path, documented honestly. Two halves:

**Possible, and used by the agent:**

- **A DISCONNECTED session is recoverable.** When an RDP/screen-share session drops, Windows leaves
  the session *Disconnected* — the desktop is alive but no longer on the console, so it looks dark
  and captures nothing useful. `tscon <sessionId> /dest:console` re-attaches it. The Windows agent
  runs this automatically, gated on the preset being enabled and on `query user` genuinely reporting
  a `Disc` row (see `planConsoleReattach()` in `windows-agent/src/unattended.ts` — it never acts on
  an `Active` session, and never escalates what it cannot see).
- **Display sleep is not a lock.** On macOS `caffeinate -u` wakes the DISPLAY while leaving the
  security posture intact; synthetic input arrives normally after that. This is already covered by
  the keep-awake assertion (`caffeinate -i -s`).
- **RDP with saved credentials** works for a HUMAN to reach a box that is signed-out, and a
  credential-provider unlock plugin can be installed by an administrator as a third-party product.
  Both need either a person or software this preset does not install.

**Not possible — and no setting changes it:**

- Typing the password at the macOS login window, the Windows sign-in / lock screen (the secure
  desktop is deliberately unreachable from a normal process — that is its whole purpose), or the
  FileVault / BitLocker pre-boot prompt (it runs before any OS the agent lives in).
- RDP does **not** unlock an existing locked console session: it creates its own session beside it.

So the preset's job is not to defeat a lock — it is to make sure the session never locks in the
first place, and to recover the one case that *is* mechanically recoverable.

## 3. Security posture (this LOWERS a device's security — deliberately, reversibly)

**Everything here is opt-in, per device, and OFF by default.** Nothing is enabled by installing or
updating an agent. The user runs `enable` on the machine itself.

- **The password never goes to Digby.** On macOS the account password is typed into the machine's
  own terminal (hidden input, non-TTY refused) and used exactly once to write `/etc/kcpassword` —
  the file `loginwindow` reads *before any user session exists*, which is why it cannot live in the
  Keychain. On Windows it is piped on **stdin** into a PowerShell child that calls `LsaStorePrivateData`
  — the same mechanism Sysinternals Autologon uses. It is never in argv, a file, an env var, Agnt's
  `config.json`, Digby's database, or a request body. Both agents' tests pin that (a source pin
  asserts the network client never imports the preset module).
- **Why the LSA secret and not `HKLM\…\Winlogon\DefaultPassword`:** the plaintext registry value is
  readable by any process on the box and is the first thing a credential stealer harvests. The LSA
  private data is stored by the LSA and can only be written/cleared with policy access. An
  administrator on the machine can still recover it (Microsoft documents this) — which is exactly
  why this is an opt-in switch and not a default.
- **`/etc/kcpassword` is obfuscated, not encrypted** (XOR with a fixed Apple key, `0600 root:wheel`).
  That is a macOS constraint, stated here rather than glossed: while the preset is on, the account
  password exists in a recoverable form on that disk. Turning FileVault **off** (required for
  auto-login) removes the at-rest disk protection at boot — the two are mutually exclusive.
- **⚠ OWNER SIGN-OFF ITEM — this is a disclosed deviation from the brief, not a satisfied
  requirement.** The brief named "the OS secret store (macOS **Keychain** / Windows DPAPI + LSA)".
  Windows meets it (the LSA secret store). **macOS cannot**: `loginwindow` must read the auto-login
  credential *before any user session exists*, so there is no Keychain to read from — `/etc/kcpassword`
  is the only mechanism macOS provides, and it is XOR obfuscation behind root-only permissions, not
  encryption. Writing the password "into the Keychain" would produce a preset that looks configured
  and silently never auto-logs-in. The choice was therefore: refuse to implement macOS auto-login at
  all (leaving every Mac to the finger-unlock cards), or implement it with the platform's real
  mechanism and say plainly what it is. This change takes the second path **and flags it here for the
  owner's explicit decision** — per machine, since it is opt-in. If the owner prefers no on-disk
  recoverable form at all, the correct outcome is: leave FileVault on, do not enable the preset on
  that Mac, and accept that a rebooted Mac needs one physical keystroke. Nothing in this change
  silently chooses otherwise.
- **Physical access = that account.** An unlocked, never-sleeping machine on a desk is usable by
  anyone who sits at it. Decide per machine.
- **One kill switch restores everything.** `enable` captures the pre-change values first
  (`backup` in the agent's local config — values only, no secret) and `disable` restores exactly
  those: auto-login off, `/etc/kcpassword` removed, the LSA secret cleared with a NULL
  `LsaStorePrivateData`, screensaver/lock/sleep back to the captured values (a key that was absent
  before is deleted, not "restored" to a guess).
- **What is NOT weakened:** Digby's own auth (the agent token, the fleet's permissions), FileVault's
  at-rest encryption of the disk (only the *pre-boot unlock* is affected, and only by turning it
  off), and any other device's settings. The preset never touches another machine.

## 4. Enabling it

> **Where the `digby-agent` command is (ticket 69ce3f01).** The installer does **not** put
> `digby-agent` on your `PATH` — a one-line install writes a shim next to the runtime at
> `$HOME/Library/Application Support/Digby/bin/digby-agent`, and `package.json`'s `bin` entry never
> reaches `PATH` because nothing is installed globally. Typing the bare command on a stock install
> fails with `sudo: digby-agent: command not found`, which reads like the feature does not exist.
>
> Make the bare command work **once**, then it survives every self-update:
>
> ```bash
> echo 'export PATH="$HOME/Library/Application Support/Digby/bin:$PATH"' >> ~/.zshrc && exec zsh
> ```
>
> The blocks below use a variable instead, so they are copy-paste safe whether or not you have added
> that line **and under `sudo`, which resets `PATH`** (so `sudo digby-agent …` fails even with the
> line above — `$HOME` is expanded by *your* shell before `sudo` runs):
>
> ```bash
> DIGBY_AGENT="$HOME/Library/Application Support/Digby/bin/digby-agent"
> ```
>
> Every command below is also valid verbatim as `digby-agent …` once the `PATH` line is in place —
> except the `sudo` ones, which must keep the full path.

> **Already installed before ticket 69ce3f01?** Older installers did not write the shim. Create it
> yourself — no re-install needed, and it is the same file a fresh install writes:
>
> ```bash
> digby_root="$HOME/Library/Application Support/Digby"
> mkdir -p "$digby_root/bin"
> printf '#!/bin/sh\nexec "%s/bin/DigbyAgent" "%s/imessage-agent/dist/index.js" "$@"\n' \
>   "$digby_root" "$digby_root" > "$digby_root/bin/digby-agent"
> chmod 755 "$digby_root/bin/digby-agent"
> "$digby_root/bin/digby-agent" status    # sanity: it exists and runs
> ```
>
> The agent's self-update swaps only the *tree* (`imessage-agent/`), never this directory, so the
> shim keeps working across updates — no need to re-create it.

> **Elevation differs per command, and getting it backwards is silent.** These `unattended`
> commands run as **your own user** — *not* `sudo` (see §10.4.1 for the full table and why). The
> `remote-access` commands in §10.4 are the opposite and **do** need `sudo`.

**macOS** (on the Mac, in Terminal — no `sudo`):

```bash
DIGBY_AGENT="$HOME/Library/Application Support/Digby/bin/digby-agent"   # or plain 'digby-agent' after the PATH line
"$DIGBY_AGENT" unattended status          # read-only: what the fleet sees right now
"$DIGBY_AGENT" unattended enable          # agent ≥ 0.9.21: asks for admin rights ITSELF, then the account password (hidden); refuses on FileVault
"$DIGBY_AGENT" unattended disable         # the kill switch: restores every captured value
```

> **You never type `sudo` for the enable (ticket bcdf5d2f).** Agent **0.9.21** is the first build
> that obtains administrator rights itself: when sudo is not already authorised it runs `sudo -v`
> attached to your terminal, so you see the ordinary macOS `Password:` line and nothing else. There
> is no separate `sudo -v` step to run first, and no `sudo` command to compose.
>
> **Do not prefix the enable with `sudo`** — under `sudo`, `$USER` is `root`, so the preset would
> configure auto-login for the **root** account. A machine that boots to the login window cannot
> complete that login: the preset looks applied and strands the device (first row of the table
> above). The command runs as your own user; it just *asks* for admin rights when it needs them.
>
> **Older agents (< 0.9.21) still need priming.** Those builds gate on a bare `sudo -n`, which
> NEVER prompts, so on a fresh Terminal the enable refuses with *"administrator rights are
> required … Nothing was changed"* and it looks like nothing happened. On those, run `sudo -v` once
> in that same terminal first — or simply update the agent, which removes the step. The card
> (Account → Integrations → iMessage) renders whichever of the two applies to the device's reported
> version, so its paste never contradicts the binary on the other end.

**Windows** (elevated PowerShell/terminal on the PC):

```bat
digby-win-agent unattended status
digby-win-agent unattended enable
digby-win-agent unattended disable
```

> **These commands are not yet reachable on Windows, and the two platforms differ.** The macOS CLI
> ships: the served `digby-imessage-agent.tar.gz` carries whichever version
> `AGENT_RELEASE.version` names in `backend/src/modules/crossmodel/imessage/agent-release.ts` — read
> that pin, never a remembered number (a stale sentence here fooled a reader once already) — and it
> contains `remote-access`.
> The **Windows** agent is still **0.9.1** — the published `windows-latest.json` reads
> `"version": "1.0.2" … (agent 0.9.1)`, and the `unattended` / `remote-access` subcommands landed
> on `main` on 2026-10-28, after that installer was built. So on a PC, `digby-win-agent unattended`
> and `digby-win-agent remote-access` do not exist yet — use the one-liners in §8 until the update
> lands. This is the §10.7 defect class (on `main` and on no device) in its ordinary form, recorded
> here rather than discovered as a "command not found".

The **separate** brokered remote-access channel (Screen Sharing / RDP, which can authenticate *at* a
login window) has its own runbook — every command, verification step and revoke check lives in
**§10.4** and is not repeated here.

### 4a. "I see TWO Digby agents" — the duplicate-install map (ticket 36d1c99f)

Three separately-versioned Digby pieces can exist on one Mac, and macOS's permission panes and the
device list name the **binary**, not the product — so two rows is a normal symptom of two install
shapes, not a second account. The map (from `imessage-agent/README.md`, ticket 933e6ca4):

| What you see | Where it lives | How it goes away |
| --- | --- | --- |
| **Bundled helper** `DigbyHelper` | inside `Digby.app/Contents/Resources` — written by the desktop app's one-click "Set up iMessage on this Mac" | Retired automatically by agent ≥ 0.9.1 (it is booted out and removed on every idle re-check) |
| **`.pkg` install** `DigbyAgent` at `/Library/Digby/…` | the signed installer's copy — a **separate TCC entry** from the self-managed agent | Retired automatically by agent ≥ 0.9.2 — but ONLY when another agent is running beside it to do the retiring: a `.pkg` install that is a Mac's only install is never retired (nothing executes the retire code). Its LaunchAgent is removed, so the leftover payload at `/Library/Digby` is inert — remove it with `sudo rm -rf /Library/Digby`. **Its device row does NOT disappear by itself**: it lingers as `Offline` until you Disconnect it |
| **The self-managed agent** `com.digby.agent` | `~/Library/Application Support/Digby/` | This is the one to KEEP — it self-updates from `digby.ai/digby-imessage-agent.tar.gz` |

**Without a terminal.** The extra *device row* is removable in the app: Account → Integrations →
iMessage → the device list shows one block per paired Mac, each with its own **Disconnect**
(`DELETE /imessage/agents/:id`). Disconnect the row you do not want and the other keeps working —
this is per-device and never nukes a sibling pairing.

**The rule that prevents a third.** A Mac should have exactly ONE self-managed agent. Installing the
one-line installer **retires** a bundled helper and an old `.pkg` install on the way in (`install.sh`
boots out their LaunchAgents), so the stale shapes never poll side by side — they share one token and
the last poller wins the Mac's reported version (ticket 405927c9's "still says I have old 0.63").
Do not hand-install a second copy to "fix" a stale version: run the installer once, then
`"$HOME/Library/Application Support/Digby/bin/digby-agent" --version` to confirm which build is live.

## 5. Drift detection (why no lane discovers a lock screen any more)

The agent re-reads **every setting the preset owns on every poll** (25 s). A macOS update resets
auto-login; a Windows policy refresh resets `NoLockScreen`. The agent logs the flip once
(`⚠️ unattended-ready: NO — …`) and advertises it on the poll:

```
?unattended=on,ok              ← everything holds
?unattended=on,filevault       ← on, but FileVault makes auto-login impossible
?unattended=on,drift,lock      ← a macOS/Windows update reverted the preset
?unattended=off                ← MEASURED: the preset is not enabled (ticket 11b6974f)
?unattended=off,locked         ← not enabled, and the device is at a lock/login screen now
```
(no param = a **pre-2026-10-28 agent**: silence is never a claim)

**`off` vs no param is the whole point** (ticket 11b6974f). A disabled preset used to advertise
*nothing*, which is byte-identical to what a build too old to report the preset sends — so the fleet
rendered its "never reported by this build — update the agent" sentence on **every** paired device
regardless of the owner's toggle, and could not tell a human gap from a build gap. A disabled preset
now says `off` (a positive claim about a measured state); absence means only "this build cannot
report it".

The backend normalizes the tokens against a **closed vocabulary**, drops unknown ones (a newer
agent must never break the poll nor read as a false ready), and ranks them into **one reason** a lane
reads from `get_account_overview → pairedMac.devices[].unattendedReady`:

```json
{ "state": "blocked", "enabled": true, "ready": false,
  "reason": "FileVault is on — macOS cannot auto-login to a FileVault volume; turn FileVault off for this Mac first" }
```

Read **`state`**, not `enabled` alone — it is the four-value line that keeps a deliberate
non-enablement distinct from an agent gap:

| `state` | meaning | the remedy |
| --- | --- | --- |
| `ready` | on, nothing blocking | — |
| `blocked` | on, but the named blocker stops it | the reason names the setting |
| `off` | **measured** not-enabled (opt-in, per device) | run `"$HOME/Library/Application Support/Digby/bin/digby-agent" unattended enable` on a Mac, `digby-win-agent unattended enable` on a PC |
| `unavailable` | **not measured** — no build on this device ever reported the preset | update the agent first |

`enabled:false` alone cannot tell `off` from `unavailable`, which is exactly the confusion ticket
11b6974f reported. In `off` the reason text (and the device card) print the exact per-platform
command. Ticket 36d1c99f: the macOS form is the shim's **absolute path**, because a bare
`digby-agent …` is not on `PATH` on a stock install and the owner got `command not found` from the
remedy the product printed; the device card also carries a **Copy** button, so nobody has to
hand-select a shell string.

**This is the part that stops the card spam:** `unattendedReady` is on every device row and the tool
description teaches lanes to read it *before* filing a "please unlock <device>" card. `ready:false`
with a fixable reason means tell the user the one setting to change, not ask him to walk to a desk.
A device that never advertised is `state:'unavailable', ready:false` with a "not reported …" reason —
an honest unknown, never a fabricated ready and never worded as if the owner could have flipped a
switch.

### 5.1 `prelogin_input` — the typed capability a dispatcher refuses on (ticket c468f922)

`unattendedReady` answers "will this device still have a live session tomorrow". It does **not**
answer "is it sitting at a lock screen *right now*", and that is the second half of the 2026-10-28
incident: a `computer_task` on `cql-stanne-mbp1` (agent v0.9.11) at the login window accepted **0
input** — `refusedRepeats=0`, `noChangeStrikes=0`, and the harness positive control (every leg —
Cmd+Space then Cmd+Tab, since ticket a40f64d9) produced byte-identical frames with an unchanged
frontmost app. An OS-level refusal reads exactly like a stuck agent, so the lane retried and burned
4+ runs on a task that could never land.

> **Reading a FAILED positive control correctly (ticket a40f64d9).** The control only convicts the
> write path when *every* leg is inert; a delivered-but-remapped shortcut is not dead input. A
> `PASSED` probe whose Note says a leg "changed nothing on this Mac" means that shortcut is remapped
> or unbound (System Settings → Keyboard → Shortcuts) — take the open tool or a click instead. When
> you need to separate "shortcut does nothing" from "keystrokes are not landing", the decisive,
> cheap test is **one `type` into a focused text field**: typing that lands proves the keyboard works.

Every device row therefore also carries a **typed pre-login capability**
(`backend/src/modules/crossmodel/imessage/prelogin-capability.ts`):

```json
"prelogin": {
  "status": "unavailable",
  "blockedNow": true,
  "reason": "the device is at a lock / login screen right now — Digby cannot type there, so dispatch work that needs input would burn the run without landing a single event; unlock the device once, or enable the device preset (\"Unattended / Autonomous use\") so the session never ends"
}
```

**⚠ Ticket e530220e — none of these reasons may assert an install state.** The reason strings used to
say *"no pre-login helper is installed on this device"* (both standing variants) and *"an agent older
than the release that introduced it … until the agent is updated"* (`HELPER_UNKNOWN_REASON`). Both were
unmeasured claims about the device: **no agent build emits the `preloginhelper` advert at all** — zero
producers in `imessage-agent/src`, `windows-agent/src` and `macos-app`, and zero occurrences inside the
shipped 0.9.23 tarball; only the BACKEND poll/pair seams parse it. So every device reads `unavailable`,
an owner on the current release was told to update, updated, and the row never moved. The copy now names
the real cause — a fleet-side gap (`PRELOGIN_STANDING_REASON`, `PRELOGIN_OPTED_IN_REASON`,
`PRELOGIN_LOCKED_REASON`, `HELPER_UNKNOWN_REASON`) — and `prelogin-capability.2026-10-28.test.ts`
scans the agent trees and goes RED the moment a release starts reporting it, so the claim cannot rot
into the same lie in the other direction. The one fact these strings MAY state is the lock, because
that token is genuinely measured.

Two deliberately separate facts, never collapsed:

| Field | Kind | Meaning |
|---|---|---|
| `status` | configuration | `available` / `unavailable` — can input be delivered **while no user session exists**? Since 2026-11-01 this is the **real probe**, not a constant: `available` only when the device advertises a pre-login helper that is both **installed and loaded in the system launchd domain** with no blocker set. A device that never advertised reads `unavailable` (unknown is never ready). See §5.2a for the helper itself. |
| `blockedNow` | live state | The console is at a lock/login screen **at this moment** — from the agent's own probe (`stat -f %Su /dev/console` on macOS, `query user` on Windows), riding the poll as the `locked` blocker token. |

**Silence never refuses.** Only a POSITIVE lock report sets `blockedNow` — a device that never
advertised (every agent from before 2026-10-28) is an honest unknown and proceeds exactly as before.
Refusals are reserved for a device the fleet has positively observed at a lock screen.

**Where it bites, and why there:**

- `get_account_overview → pairedMac.devices[].prelogin` — a scheduler reads it and does not dispatch.
- `/imessage/status` + `/imessage/agents → agents[].prelogin` — the **owner-facing** surface (same
  `devicePayload()`), so the person who owns the machine sees the same typed fact a lane reads. It
  also carries `remoteAccess` and `unattendedReady`; Account → Integrations → the paired-Mac card
  renders all three as a per-device **Remote control** health line.
- `selectComputerDriver` — the selection carries it on every device-selecting path (task-text
  auto-bound, explicit `device:` target, default pick).
- `runComputerAgentSession` — a `blockedNow` device is refused **before a frame is captured and
  before the per-device use-lock is taken**, so a locked device never contends for (and wins) the
  lock against a device that could actually be driven. The result is a structured
  `capabilityNotice` (`COMPUTER USE BLOCKED — prelogin_input: unavailable …`) that tells the caller
  to stop retrying, not to try again.
- The `computer_task` tool-result header renders `· prelogin_input: unavailable`, so the typed fact
  reaches the calling lane on **successful** runs too — it is the capability, not just an error.

**The card is a STATUS surface, not a control.** Enabling the brokered channel drives root tooling
on the device (`kickstart`, a PF anchor, `pfctl`; or TermService and a firewall rule), and the paired
agent runs as the logged-in user with no dispatchable command for it — its broker vocabulary is
`permission_relaunch` / `permission_open_pane` only. So there is deliberately **no enable/revoke
button** in the card: it shows the state, the blocker reason, and the one on-device command, and
only in the states where that command is both correct and possible — `off`. In `blocked` the channel
is already enabled (the remedy is the named blocker or a revoke); in `unavailable` the agent predates
the command entirely (`remote-access` shipped in agent 0.9.12), so the card points at the update
instead. §10.4 remains the enable/revoke runbook.

### 5.2 The credential model — SETTLED by the owner 2026-11-01 (ticket c468f922)

For two days the pre-login fork was open: a privileged helper that can type at the login window is
only useful if it can get *past* the password, and every way of doing that looked like taking custody
of the owner's password. The owner settled it on card `oq_96b31bed`:

> **"(d) + (b) together — recommended"**

What that means, and the part a future editor is most likely to undo:

| | |
|---|---|
| **(b) — the default posture** | The "Unattended / Autonomous use" preset stays the default answer, so most devices never idle to a lock screen in the first place. **Built** (§4, §5): auto-login, no password after sleep, no idle sleep. ⚠ **`fdesetup authrestart` is NOT built** — an earlier revision of this row claimed it was "FileVault-aware", and that was false: `git grep authrestart` matches this document and nothing else, and `unattended.ts` only ever runs `fdesetup status` (a read). See §2.2 for what that leaves open. |
| **(d) — the locked-screen escape hatch** | A privileged helper (root LaunchDaemon on macOS) that buys **capability only**: the ability to render and post input at the login window. **THE POLICY, PLANS AND PROBE NOW LANDED** (2026-11-01): `prelogin-helper.ts` owns the daemon identity (`ai.digby.prelogin-helper`, `/Library/LaunchDaemons`, loaded in the **system** domain), the install plan, the bootout-then-rm revoke plan, the verdict and the closed blocker vocabulary; the agent advertises its probe as `?preloginhelper=on[,<blockers>]`; `imessage_agents."preloginHelper"` stores it; and `prelogin_input.status` flips to `available` for a device whose helper is installed AND loaded. **The signed daemon BINARY is not in this tree** — it must be built on a Mac with a Developer ID identity (see §5.2a), so no device reports `available` in practice yet. |
| **REJECTED — option (a)** | A helper holding the login password in the root Keychain. **Never.** See the hard rule below. |

**THE HARD RULE — no stored OS login password, ever.** Not in the root Keychain, not in
`/etc/kcpassword`, not in a service config, not in this backend, not on the wire. The password is
typed by **the human, only when the device is actually locked**. This is not a stylistic preference —
it is what TeamViewer actually does (its "Easy Access" stores no OS password; the operator who
connects types it), and it is the reason capability and credential custody are separable at all.

The ruling is encoded, not just documented: `PRELOGIN_CREDENTIAL_MODEL` /
`PRELOGIN_CREDENTIAL_POLICY` in `prelogin-capability.ts`, pinned by
`prelogin-credential-model.c468f922.test.ts`. **A helper that ships with a stored credential
contradicts this ruling and must be rejected in review**, however convenient it looks.

**THE ACCEPTED COST, stated so nobody "fixes" it later.** A 3am autonomous run against a device that
is genuinely sitting at the login window still **waits for a human**. That is the price of the ruling,
not a defect — the fix for it is (b) (the device should not have reached a lock screen), never a
stored secret.

**Still required before criterion 1 can be called done:** real-hardware evidence. No official
TeamViewer source claims it can *control* the macOS `loginwindow` (only that the screen is
reachable), and macOS Screen Recording / Accessibility / Remote Desktop "cannot be granted
remotely" per TeamViewer's own KB — a person must switch those on at that Mac once (or MDM
pre-seeds them). So on macOS, (d) is *very likely works once permissions are set up*, unproven
until a locked Mac is actually driven end-to-end.

### 5.2a The (d) helper — what landed, and what is deliberately still a Mac-side build

`backend/src/modules/crossmodel/imessage/prelogin-helper.ts` is the operator surface for option (d).
It is a **pure leaf** (it imports nothing) so every decision is unit-testable without a Mac, and the
exec seam is injected exactly like `remote-access.ts`.

**Landed here:**

| Piece | Where |
|---|---|
| Daemon identity | `PRELOGIN_HELPER_LABEL = ai.digby.prelogin-helper`, `/Library/LaunchDaemons/…plist`, binary at `/Library/Digby/prelogin-helper/DigbyPreloginHelper` — deliberately its **own** root tree, not `/Library/Digby/imessage-agent`, because postinstall's 405927c9 *yield* removes that payload when a self-managed install owns the Mac and a system daemon must not be collateral damage of a user-level installer standing down |
| Plist render | `renderHelperPlist()` — a LaunchDaemon in the **system** domain, the only position outside every user session, which is the entire reason a daemon is needed. It carries **no credential key of any kind** (pinned by test) |
| Install plan | `planMacHelperInstall()` — install binary → install plist `0644 root:wheel` (launchd **refuses** a group/world-writable daemon plist) → `launchctl bootstrap system` → `enable` → `print` as the verification read-back |
| Revoke plan | `planMacHelperRevert()` — **bootout → disable → rm plist → rm tree → `print` (which must now FAIL)**. Order is load-bearing: launchd reloads any plist that still exists at boot, so `rm` first leaves the daemon running until reboot (the `retire-bundled-helper.ts` lesson, adapted `gui/<uid>` → `system`) |
| Verdict | `preloginHelperVerdict()` — `off` / `on` / `blocked` / `unavailable`, never ready on unknown, and **never ready while a credential-custody blocker is set** |
| Blocker vocabulary | closed, priority-ordered: `credential-custody` (a ruling breach, outranks everything) > `unsigned` > `no-binary` > `not-loaded` > `stale` |
| Advert | agent → `?preloginhelper=on[,<blockers>]`; backend `normalizePreloginHelper()` drops unknown tokens and returns `undefined` when absent (absent-never-clobbers) |
| Storage | `imessage_agents."preloginHelper"` (JSONB, camelCase — a Prisma field with no `@map`), migration `20261101234500_agent_prelogin_helper` **+ repair `20261102013000_agent_prelogin_helper_column_repair`**. The first migration shipped `prelogin_helper` and was **applied to prod at 2026-11-02T00:53:56Z**, taking `IMessageAgent` reads down with P2022 until the repair landed; applied migration files are immutable, so the correction is a NEW migration, never an edit |
| Fleet surface | `devicePayload().preloginHelper`, and `prelogin_input.status` now composes from it |

**Not here, on purpose — the signed binary.** A Mach-O that posts events at `loginwindow` must be
signed and notarized with the Developer ID **Application** identity and bundled by `macos-pkg`, and
the macOS TCC grants (Screen Recording / Accessibility / Remote Desktop) *cannot be granted
remotely* — a person switches them on at that Mac once, or MDM pre-seeds them. Neither can be done
from this repo's Linux CI. So the shape is landed and the artifact is a Mac-side build step; until it
ships, every device honestly reports `unavailable` (a device that never advertised) and the accepted
cost of §5.2 stands.

**The no-stored-credential rule is enforced, not just written.** `PRELOGIN_CREDENTIAL_POLICY
.storesOsPassword` is `false` and pinned by test; `preloginHelperVerdict()` takes the policy as an
argument and refuses `ready` if it ever says otherwise, so flipping the constant does **not** produce
a green fleet — it produces a `credential-custody` block. The revoke plan deliberately has **no**
credential-deleting step (option (d) never creates one), and `verifyMacHelperRevert()` checks for
surviving credential artifacts positively and reports any as an **owner-ruling breach** rather than a
tidy-up.

### 5.2b Windows — the elevation design, written down BEFORE any code

The request is explicit that `windows-shell/installer/digby.nsi` is **`RequestExecutionLevel user`**
by design (roadmap §2.9: no UAC, `HKCU` only, nothing touches `HKLM`), and that the elevation design
must be written down *before* it is coded. This is that design. **Nothing here is built.**

**The problem has the same shape as macOS, and so does the ruling.** Windows runs the sign-in / lock
screen (and the UAC secure desktop) on a separate desktop object that no process inside an
interactive user session may synthesize input into. The only position from which `SendInput` reaches
it is a service in **session 0** running as `LocalSystem` with access to `Winlogon`. That is option
(d)'s Windows equivalent: capability only.

**Four constraints that make this NOT a copy of the macOS plan:**

1. **The installer must not change.** `digby.nsi` staying `user` is a feature. Elevation belongs in a
   *separate opt-in action* the operator runs once — never a silent consequence of installing the
   tray agent. Changing the installer's execution level would UAC-prompt every existing user on
   upgrade, which is the opposite of opt-in.
2. **A SYSTEM service obeys the same no-stored-credential rule.** `storesOsPassword` stays `false` on
   Windows exactly as on macOS. The service may drive the secure desktop; it may **not** hold the
   account password, a DPAPI blob of it, or an LSA private-data entry for it. Note the contrast with
   the *preset* path (§3), which genuinely may use `LsaStorePrivateData` for auto-logon — that is
   option **(b)**, a different mechanism with a different threat model, and this helper must never
   read or write that secret. `credential-custody` blocks identically.
3. **The service must not become a general remote-execution surface.** It exposes exactly one verb —
   "post these events at the secure desktop, on request from the paired agent" — authenticated to the
   agent, never a shell. A SYSTEM service accepting arbitrary commands is a remote-admin backdoor: a
   strictly worse outcome than the locked-device cost this ticket removes.
4. **BitLocker TPM+PIN and Credential Guard stay unreachable** (§2). No session-0 service gets past a
   pre-boot PIN. Those devices remain honestly `unavailable`, never a false green.

**Sketch (not implemented):** a `DigbyPreloginHelper` service registered
`sc create … start= demand`, installed only behind an explicit elevated command; it advertises through
the same `?preloginhelper=on[,<blockers>]` param and the same closed vocabulary, so the fleet verdict
and both operator surfaces need no Windows-specific branch. The blocker a Windows build hits first is
`unsigned`, which the vocabulary already names.

## 6. Automated coverage

| Suite | What it pins |
|---|---|
| `imessage-agent/test/unattended.2026-10-28.test.mjs` (23) | fdesetup/defaults/pmset/pwpolicy/console parsers against real output shapes; the verdict (FileVault first, drift only when auto-login vanished, unknown ≠ blocker); `kcpassword` encoding vs Apple's XOR key; `enable` refuses on FileVault/no-sudo **having touched nothing**; `disable` restores captured values |
| `windows-agent/test/win-unattended.2026-10-28.test.mjs` (32) | manage-bde/DG/reg/powercfg/net accounts/dsregcmd/quser parsers; the verdict (every hard blocker outranks every setting); auto-logon needs **all three** of AutoAdminLogon + DefaultUserName + the LSA secret; the LSA script uses `LsaStorePrivateData` and **never** a plaintext `DefaultPassword` value; the password appears in exactly one place — a stdin slot; the kill switch nulls the secret |
| `backend/src/modules/crossmodel/imessage/unattended-verdict.2026-10-28.test.ts` (18) | token normalization + dropping, absent-never-clobbers, first-reason ranking, never-ready-on-unknown, and a **wire-parity pin**: every token both agents emit must exist in the backend vocabulary (a drift here would silently show a stranded device as ready) |
| `backend/src/modules/crossmodel/imessage/prelogin-capability.2026-10-28.test.ts` (13) | the typed pre-login capability (§5.1): `status` is a self-describing string not a boolean; `blockedNow` fires ONLY on a positive `locked` report (silence never refuses); garbage never throws; `locked` is reported regardless of the preset opt-in; only the live lock state blocks (FileVault does not); both agents really emit `locked` from their own console probe; and all four carriers (device rows, driver selection ×3 paths, loop gate before the use-lock, tool-result header) actually read the module |
| `backend/src/modules/crossmodel/imessage/prelogin-credential-model.c468f922.test.ts` | the owner's ruling as DATA (§5.2): `PRELOGIN_CREDENTIAL_POLICY.storesOsPassword` is `false`; the capability wire shape is exactly `status`/`blockedNow`/`reason` (no slot a credential could ride in on); no shipped reason string asks for a password; and `prelogin-capability.ts` is structurally a pure leaf |
| `backend/src/modules/crossmodel/imessage/prelogin-helper.c468f922.test.ts` | the (d) helper (§5.2a): the daemon is a **system** LaunchDaemon in its own root tree; the advert vocabulary is closed and cannot carry a secret; unknown never reads as ready; **a credential-custody blocker can never read as ready** (the owner's rejected option (a) fails closed); the plist carries no credential key; the revoke is **bootout-then-rm** with a read-back verification and a positive check for surviving credential artifacts; and `prelogin_input` composes from the verdict while keeping its exact three-key shape |
| `backend/src/modules/crossmodel/platform/account-tools.test.ts` | `unattendedReady` rides every device row; a never-advertised row is an honest `ready:false` |

## 7. Manual verification (the parts that genuinely need a real machine)

Nothing below types a password anywhere but that machine's own terminal.

**macOS — a Mac that is unlocked and idle (do NOT use the owner's active machine):**

```bash
# The installer writes this shim (ticket 69ce3f01) — it is NOT on PATH by default,
# so bind it once here. After the PATH line in §4, plain 'digby-agent' works too.
DIGBY_AGENT="$HOME/Library/Application Support/Digby/bin/digby-agent"

# 1. Baseline: what the fleet thinks (should be "not configured" / off)
"$DIGBY_AGENT" unattended status

# 2. The FileVault refusal, proven without changing anything
fdesetup status                        # FileVault is On ⇒ enable MUST refuse with the explanation

# 3. Enable, then confirm each leg
"$DIGBY_AGENT" unattended enable       # type the password into THAT terminal only
defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser     # → your short name
sudo ls -l /etc/kcpassword             # → -rw------- root wheel
defaults read com.apple.screensaver askForPassword                          # → 0
defaults -currentHost read com.apple.screensaver idleTime                   # → 0
pmset -g custom | sed -n '/AC Power/,/^$/p'                                 # → sleep 0, powernap 0
"$DIGBY_AGENT" unattended status       # → unattended-ready: YES

# 4. The reboot proof (the whole point) — do this only on a machine you can walk to
sudo reboot            # the Mac must come back to a LOGGED-IN desktop, no login window
"$DIGBY_AGENT" unattended status       # → YES again after boot

# 5. Drift detection
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string ""
"$DIGBY_AGENT" unattended status       # → NO … autologin (within ~25 s), and the fleet row flips
"$DIGBY_AGENT" unattended disable      # restore

# 6. Kill switch proof
"$DIGBY_AGENT" unattended disable
sudo ls /etc/kcpassword                # → No such file
"$DIGBY_AGENT" unattended status       # → OFF (opt-in, per device)
```

**Windows — an elevated terminal on the PC:**

```bat
digby-win-agent unattended status
manage-bde -protectors -get C:                    :: TPM+PIN ⇒ enable MUST refuse
digby-win-agent unattended enable
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v AutoAdminLogon   :: 1
reg query "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v NoLockScreen :: 0x1
powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE                                      :: AC 0x00000000
:: the secret must NOT be a plaintext registry value:
reg query "HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" /v DefaultPassword  :: ERROR (absent) ✅
shutdown /r /t 0                                  :: must come back signed in
digby-win-agent unattended disable
```

**Fleet-side proof (no machine needed):**

```bash
# the verdict a lane reads, with the reason
curl -s https://digby.ai/api/... # or, from a session: get_account_overview → pairedMac.devices[].unattendedReady
```

> **Live-verification status (2026-10-28):** the code + tests are green; the macOS/Windows reboot
> proofs above are **PENDING an unlocked machine** — both candidate Macs were unavailable this run
> and no password was typed anywhere. Re-run §7 on the next unlocked window and record the output
> here.

## 8. If the owner wants it before the app update (one-liners)

**macOS** (Terminal, on the Mac):

```bash
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$USER" && \
defaults write com.apple.screensaver askForPassword -int 0 && \
defaults -currentHost write com.apple.screensaver idleTime -int 0 && \
sudo pmset -a sleep 0 disksleep 0 powernap 0
# auto-login also needs the password in /etc/kcpassword — `"$DIGBY_AGENT" unattended enable` writes it
# correctly (Apple's XOR encoding); don't hand-roll that file. Check first: fdesetup status
# ($DIGBY_AGENT = "$HOME/Library/Application Support/Digby/bin/digby-agent" — see §4)
```

**Windows** (elevated PowerShell, on the PC):

```powershell
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v NoLockScreen /t REG_DWORD /d 1 /f
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v InactivityTimeoutSecs /t REG_DWORD /d 0 /f
powercfg /change standby-timeout-ac 0
# auto-logon: use Sysinternals `Autologon64.exe` (it writes the LSA secret, not a plaintext
# DefaultPassword) — or `digby-win-agent unattended enable` once the app update lands
# (it does NOT exist on the currently published 0.9.1 agent — see the note in §4).
```

## 9. The owner-facing answer (five lines)

1. **What was broken:** macOS and Windows will never let remote software type the login password —
   that prompt is deliberately unreachable — so a rebooted or locked machine strands the fleet until
   someone physically unlocks it. That is what the cards were asking you to do.
2. **The fix:** a per-device "Unattended / Autonomous use" switch that makes the session never end —
   auto-login at boot, no lock screen, no idle sleep, plus a keep-awake — on both Macs and Windows PCs.
3. **Where each OS says no:** macOS can't auto-login with **FileVault** on (and a reboot then needs a
   pre-boot password); Windows can't with **BitLocker TPM+PIN**, **Credential Guard**, or a
   **Windows-Hello-only** policy. The switch refuses with that exact reason instead of
   half-configuring.
4. **What it costs:** it is off by default, per machine, and it lowers that machine's security
   (anyone at the unlocked device is you; FileVault-off means no at-rest boot protection). The
   password goes only into the OS's own store on that device — never to Digby. One command undoes
   every change.
5. **What you do:** run `"$DIGBY_AGENT" unattended enable` on a Mac (`$DIGBY_AGENT` =
   `"$HOME/Library/Application Support/Digby/bin/digby-agent"`, see §4), `digby-win-agent unattended enable`
   on a PC, once, when you're at that machine — after that no lane needs to ask you to unlock it, and
   `get_account_overview` will say `unattendedReady: yes` (or the one thing standing in the way).

**And for the login window itself (§10, the option-3 ruling):** that is a *separate*, per-device
opt-in — **you turn the remote channel on for one device at a time**, you do not hand Digby your
password. The channel uses the OS's own Screen Sharing / Remote Desktop, which can authenticate *at*
the login window; the credential is set once on that device and lives in the OS, never in Digby and
never in a receipt, log or chat. When it is off — the default — the product says `off` and means it,
and one command removes the listener, the firewall rule and the stored credential and reads all three
back to prove it. You never need to give Digby a login password for any of this.
## 10. Brokered remote access — the owner's option-3 ruling (2026-10-29)

The preset above makes the session never end. It does **not** give a path into a machine that is
already at a login screen, and no OS will let a user-session process type the login password. The
owner was asked which way to go and ruled on **2026-10-29** (card `oq_b5118c38`), verbatim:

> **"can we do option three but a little more secure like how it's just like TeamViewer"**

Option 3 in the ticket was *"drive the OS's own remote-access channel instead of the framebuffer"* —
macOS Screen Sharing / ARD (RFB, port 5900) and Windows Remote Desktop (TermService, port 3389). The
weak part of plain option 3 is **a permanently open inbound port on every device**. The TeamViewer
shape the owner asked for is the inverse: the device dials **out** to a broker and the operator is
brokered through that path.

### 10.1 What was already true before this change (do not rebuild it)

The paired-agent channel is **already outbound-only**: `agent-link.ts` states *"The macOS agent runs
on the user's own Mac (behind NAT) and 'dials home' by long-polling … The backend can therefore never
open a connection TO the Mac."* Neither agent contains an inbound listener at all — grep for
`createServer` / `listen(` across `imessage-agent/src` and `windows-agent/src` returns nothing. So the
"device initiates outbound" half of the TeamViewer model is the existing floor. What this change adds
is governance of the **OS channel** those brokered sessions drive.

### 10.2 TeamViewer parity — honest scorecard

| TeamViewer property | This build | Where |
|---|---|---|
| Device dials OUT; nothing inbound on the device's network | ✅ (for the *agent* channel) | `agent-link.ts` long-poll; no inbound listener in either agent |
| No permanently-open public port for the channel | ✅ enforced — the port is firewalled to the tunnel, because **neither OS can bind these services to one interface**. ⚠ A rule only counts once it is actually **filtering**: see §10.2a | macOS PF anchor `com.digby.brokered` (pf ON + anchor referenced); Windows Defender rule `remoteip=<tunnelCidr>` (profiles ON) |
| Per-session / per-device authorization | ✅ opt-in per device + a dedicated channel account, **and** a time-boxed single-use operator grant (`brokered-session.ts`): one device, ≤1 h hard ceiling, consumed exactly once, never extended by use. A live session that outlives its window is reported as the `stale` blocker — see §10.2b. **The relay layer adds a third gate** (2026-11-02): a 32-byte session *capability* minted at open, shown once, stored only as a SHA-256 hash and compared in constant time on **every** frame — so a `sessionId` alone never carries traffic (§10.5) | §10.4, §10.2b, §10.5 |
| Strong auth before the OS allocates a session | ✅ Windows: NLA mandatory (`UserAuthentication=1`). macOS: VNC auth at the login window | `windows-agent/src/remote-access.ts` |
| Dedicated credential (never the account password) | ✅ macOS dedicated VNC password; Windows dedicated account (`account-password` blocker fires if it equals the auto-logon account) | both `remote-access.ts` modules |
| End-to-end encrypted tunnel | ⚠️ **partly** — the relay data plane (§10.5) rides HTTPS end to end (TLS at the ALB, frames opaque to the server). The OS channel underneath is still RFB/RDP, where macOS VNC auth is not TLS and RDP negotiates its own | §10.4, §10.5 |
| Relay infrastructure | ⚠️ **data plane + macOS RFB codec built; RDP and the operator's renderer not** — a session-carrying frame relay ships (`relay-dataplane.ts` + `.store.ts`; store-and-forward over the existing outbound long-poll, **no new listening port anywhere**), and as of 2026-11-02 a macOS RFB codec sits above it (`imessage-agent/src/rfb-codec.ts` + `relay-session.ts`): carried `FramebufferUpdate`/Raw bytes decode into real screen state and carried `KeyEvent`/`PointerEvent` decode into executable input actions. Windows/RDP has **no** codec, and the operator UI does not yet render the decoded screen — see §10.5 | `relay-dataplane*.ts`, `imessage-agent/src/rfb-codec.ts` |
| Operator can drive the login window | ❌ **not built** — no RFB/VNC or RDP *client* ships | §10.4 |

### 10.2a A rule only counts once it is FILTERING (defect found and fixed 2026-10-29)

This subsection exists because the first cut of this feature could report a device as **hardened
while the port was wide open**. It was found by live measurement against a real paired Mac, not by
review, and it is recorded here so nobody "simplifies" the check back out.

**The macOS half.** `pfctl -a com.digby.brokered -f -` loads rules into a named anchor, and
`pfctl -a com.digby.brokered -sr` reads them back perfectly. That proves the rules **exist**; it does
not prove they **filter**. Two independent conditions must also hold:

1. **pf itself must be enabled.** Stock macOS ships pf *disabled*.
2. **The anchor must be referenced from the main ruleset.** Stock `/etc/pf.conf` references only
   `com.apple/*`; a named anchor that no `anchor "NAME"` rule points at is never evaluated.

With either unmet, every packet passes while the anchor reads back correct — so the old probe called
it `firewallScopedToTunnel: true` and the fleet rendered the channel as hardened. A **false green on
the exposure boundary**, which is worse than a false red: nobody investigates a green.

*The fix.* The probe now also reads `pfctl -s info` (`parsePfEnabled`) and the **main** ruleset
`pfctl -sr` (`parseAnchorReferenced`). `scoped` is `true` only when the rules are present **and** pf is
enabled **and** the anchor is referenced; `false` when either is definitively wrong (an inert rule
**is** exposure, so it reports the existing `exposed` blocker — deliberately not a new token, so a lane
can never read "rules present" as safe); `null` when enforcement cannot be read, which never reads as
ready. The enable plan now **establishes** enforcement first
(`PLAN_PF_ENFORCEMENT_SCRIPT`): idempotently append one `anchor "com.digby.brokered"` line to
`/etc/pf.conf` (append-only, one-time `.digby.bak`, never truncates the stock rules), reload pf, enable
pf, then verify both conditions and exit non-zero so the caller fails closed and reverts.

**The Windows half.** A Defender rule that reads back perfectly is **inert** on any profile whose
firewall is off — and our own enable plan writes `profile=any`, so protection depends on *every*
profile being on. The probe never read the profile state. It now reads
`netsh advfirewall show allprofiles state` (`parseFirewallProfiles`) and requires the rule scoped
**and** all profiles on; the enable plan turns profiles on **before** adding the rule.

**What this does NOT prove, and must never be claimed.** Enforcement of a rule on one OS build is not
reachability from the internet. Proving the port is genuinely unreachable off-tunnel requires an
external probe against a device whose public endpoint actually answers probes at all — that is a
real-machine item, tracked in §10.6 alongside the other things the suite cannot prove.

### 10.2b Per-session authorization — the grant, and why `stale` was a token with no producer

The hardening contract in `remote-access-verdict.ts` has always **declared** two things about
sessions:

```
REMOTE_HARDEN_REQUIREMENTS → session-window:
  'every brokered session is time-boxed and closes with the session that opened it'
REMOTE_BLOCKER_PRIORITY → stale:
  'a brokered session outlived its window …'
```

Both agents even carried `stale` in their local blocker unions. **Nothing could ever emit it.** A
requirement with no producer is prose, and the concrete consequence was that a channel kept
authenticated by an operator session that walked away still read `ready: true` — the fleet could not
tell a cleanly closed session from a standing door.

**`brokered-session.ts` (pure leaf) + `brokered-session.store.ts` (Redis) close that.** The grant has
three properties, each load-bearing:

| Property | Enforced how | Why it matters |
|---|---|---|
| Time-boxed | `BROKERED_SESSION_HARD_MAX_SEC` = 3600s, default 600s | "pass a big number" cannot create an unbounded window; one hour is a ceiling because a session that outlives a commute and a night is a standing backdoor |
| Single-use | `consumeBrokeredSession` stamps `consumedAt`; a replay is refused from **any** process (the consumed row is written back to Redis) | a captured authorization cannot open a second session |
| Device-bound | the claim's `agentId` **and** `channel` must match | a grant for the office Mac cannot drive the home mini, and a macOS grant cannot be presented to a Windows agent |

**`stale` is not `expired`, and the distinction is the whole point.** A grant that expired *unused*
authenticated nothing — the operator never showed up, so there is no session past its window, and
reporting `stale` there would be a false alarm that teaches lanes to ignore the token. `stale` is
reserved for the dangerous shape: a grant that **was** consumed, whose window has since passed, and
which carries no recorded `closedAt`. That channel is authenticated right now with nobody's session
behind it.

The fold is **additive only** (`applyBrokeredSessionWindow`): it can add `stale`, and can never
remove a blocker, clear `off`, or flip `enabled`. A bug there can only make a verdict stricter,
never greener. It returns the advert unchanged when there is no session, so a device that never had
one is byte-identical to before. And because `stale` is an **already-declared** token, this adds no
wire vocabulary — the existing normalizer understands it.

**What this still does not do:** it now does carry one (§10.5) and the macOS codec decodes it, but
the path is not yet a working remote desktop end to end. What ships is: the grant authorizes, the
relay carries, and the RFB codec on the macOS agent renders carried bytes into screen state and turns
carried input into executable actions. What is still missing is a Windows/RDP codec, an operator-side
renderer that paints the decoded screen, and a live device e2e on hardware. The grant remains the
authorization half of "strong per-session auth", which is the half the ruling named.

### 10.3 What this does NOT do — three limits, stated rather than glossed

1. **No RFB/RDP proxy — for RDP, and no renderer yet for either.** The session-carrying relay
   *forwarder* ships (§10.5) and carries an authorized session's byte stream over the outbound
   channel, and the **macOS RFB codec now sits above it** (2026-11-02, §10.5): carried
   `FramebufferUpdate`/Raw bytes decode into real screen state and carried `KeyEvent`/`PointerEvent`
   decode into executable input actions. What is still missing is (a) a **Windows/RDP** codec,
   (b) an operator-side **renderer** that paints the decoded screen, and (c) a live device e2e
   driving the capture→codec→relay path on real hardware. The reference implementation also
   provisions and *governs* the OS channel.
2. **No client.** `computer_task` still **cannot** type at a login window — no RFB/VNC or RDP client
   is implemented. This is why `prelogin_input` continues to report `unavailable`: flipping it to
   `available` would re-create the exact bug this ticket was filed for (a lane dispatches input to a
   locked device, lands nothing, burns the run). The honest model is **two separate typed facts**:
   - `prelogin_input` — *"can THIS run's input land at a login window?"* → **`unavailable`**
   - `remoteAccess` — *"is there a hardened operator channel that reaches the login window?"* →
     `ready` only when enabled **and** tunnel-attested **and** blocker-free
3. **E2E encryption is now partial, and it stops at the OS channel.** The relay data plane (§10.5)
   rides HTTPS end to end, so the frames we carry are TLS-protected and opaque to our server. The
   RFB/RDP payload *inside* those frames is still the OS's own crypto — macOS VNC auth is not TLS —
   so "the operator's session is end-to-end encrypted all the way to the OS" remains unbuilt.
    Authorization is now three-deep (§10.2b grant + the §10.5 session capability on top of the
    pairing token); the data plane now carries AND the macOS codec decodes it, but the payload inside
    is still the OS's own crypto. Listed rather than glossed.

### 10.5 The relay DATA PLANE — what now carries a session (2026-11-02)

Until this landed, the grant verbs **authorized** a session and nothing **carried** one: a lane could
hold a perfectly valid grant and there was still no path for a single byte to reach the other end.
That is the same defect class as §10.2b's missing `stale` producer — a requirement no live surface
satisfies — so it is worth stating what actually moves now.

**The shape: store-and-forward over the EXISTING outbound long-poll.** Both ends poll the server:
the device with its agent token (`GET /agent/relay/frames`) and the operator with their JWT
(`GET /agents/:id/relay/frames`). Nothing listens. No WebSocket upgrade, no new port, no new
infrastructure, no TLS change — which is exactly the ruling's "device dials out, nothing inbound".

**Three gates, all of which must pass before a byte moves:**

| Gate | Proves | Where |
|---|---|---|
| Transport identity | device is a paired Mac (agent token, SHA-256 lookup) / operator is the account owner (JWT) | `authenticateAgent`, `authenticate` |
| Session | a grant that is **consumed**, **unclosed** and **inside its window**, bound to the presenting device id *and* channel | `relaySessionRefusal` (re-derived on EVERY frame, never cached) |
| Capability | a 32-byte session secret minted at open, shown **once**, stored only as a SHA-256 hash, compared in constant time | `relayGate` / `mintRelayCapability` |

The capability is what makes a stolen `sessionId` useless on its own — the id *names* the session,
the capability *proves* the caller was given it. It deliberately lives at its own Redis key rather
than on the grant, so `brokered-session.ts`'s "the grant is an authorization, not a secret" property
(and the key-set test that pins it) keeps holding.

**The device side needs no capability, and that is not a weakening.** The device's identity is
already a per-device secret, and the session is resolved *from that device's own grant* — the device
cannot name a session, so there is no id to steal. The operator is a human JWT that outlives any one
session, which is precisely why that side needs the session-scoped secret. These are two separate
functions (`relayGate` / `relayDeviceGate`), not a flag whose `false` value disables a check.

**Replay is unrepresentable, not merely rejected.** The server allocates the sequence number
(`INCR`); a client-chosen `seq` would have made replay representable and required a high-water-mark
check the receiver could get subtly wrong across processes. A replayed POST simply receives the next
number and is delivered as new data — which is what a replayed request *is*.

**Refusals are honest and named.** `no-session` 404 · `not-open` 409 · `stale` 409 ·
`wrong-capability`/`wrong-device` 403 · `frame-too-large` 413 · `malformed` 400 · `queue-full` 429.
A full queue refuses the writer rather than silently dropping a frame: a screen that loses frames
must look like a stalled session, never like a corrupted one.

**What this is NOT — updated 2026-11-02 when the macOS codec landed.** The relay now speaks RFB on
the macOS path. `imessage-agent/src/rfb-codec.ts` is a stream codec for post-handshake RFB 6143:

- **Inbound (device → operator):** `RfbServerDecoder` decodes `FramebufferUpdate` with Raw
  rectangles into `RfbScreen`/`RfbSession` — real width/height/pixel bytes plus a content hash.
- **Outbound (operator → device):** `RfbClientDecoder` decodes `KeyEvent`, `PointerEvent`,
  `FramebufferUpdateRequest`, `SetEncodings` and `ClientCutText` into executable input actions, which
  `pumpRelay` runs through the agent's own `computer.click` / `computer.keyPress` / `computer.typeText`.
- **The 64 KiB problem, and why the codec is a STREAM codec.** One Raw 1280×800 update is 4 MB — 64×
  a relay frame — so `chunkForRelay` splits one RFB stream across many frames and both decoders
  accept arbitrary chunk boundaries. A codec that assumed one frame = one message would pass every
  toy test and carry no real screen at all.
- **Refusal, not desync-guessing.** `imessage-agent`'s own codec implements Raw only: every other
  encoding has a payload length we cannot know, so it is REFUSED (`unsupported-encoding`) rather than
  mis-parsed. Nothing in the codec throws into the poll loop — a hostile stream emits a `desync`
  event and halts that decoder, because one bad frame must never cost the Mac its command channel.
  *(The **backend** operator decoder additionally implements CopyRect, Hextile, **Tight** and the
  LastRect extension — 2026-11-02, Tight added the same day — with a decoded-size ceiling of its
  own; the agent-side codec above is unchanged, and the Mac path still emits Raw. Tight covers the
  Copy, Palette (1-bit and 8-bit) and Gradient filters plus FillCompression; its four zlib streams
  PERSIST across rectangles, so the decoder continues them rather than re-inflating per rect
  (which fails `Z_DATA_ERROR incorrect header check` on the second). Tight JPEG and rects wider than
  2048 px are refused, never guessed.)*
- **No credential slot, and no handshake.** The codec starts AFTER the handshake: security-type
  negotiation and the VNC challenge/response are deliberately absent, because the ruling replaces
  them with the relay's per-session capability. A rectangle is geometry plus opaque pixels; an input
  event is a keysym or a button mask. Pinned by shape.
- **Duplicated constant, drift-guarded.** The agent ships as a src-only tarball with no backend in
  it, so `RFB_RELAY_FRAME_BYTES` mirrors the backend's `RELAY_MAX_FRAME_BYTES`, and a backend test
  reads both and fails on divergence — a silent drift would surface as an agent whose every frame the
  backend refuses.

**Still NOT built, stated plainly.** (a) A Windows **screen source** — `windows-agent` now has the
RFB *client* (`rfb-client.ts` + `relay-rfb.ts`, 2026-11-02: a real 3.8 handshake, a `SetEncodings`
advertisement, and a carrier that tunnels the PC's own RFB server into the relay), but it still has
no codec and no capture of its own: it forwards a server that something else must be running, and
`queueRelayFrame` now has exactly one producer — that carrier. (b) A **live device e2e**:
`captureScreenRgba` shells out to `screencapture -t bmp` and its decoder (`parseBmpToRgba`) is
tested against a real BMP fixture, but the capture→codec→relay path has NOT been driven on hardware.
The carry is proven over the live HTTP surface, not on a Mac driving a session.

*(The operator **renderer** named here as unbuilt now exists — `relay-operator.controller.ts` +
`relay-operator-viewer.ts` — and renders carried screens as JSON + PNG over `GET …/relay/screen`.)*

**A bug this slice found and fixed in the transport underneath.** The relay's cheap base64 pre-check
was `Math.ceil(len * 3 / 4)`, which ignores padding and overestimates by up to 2 bytes — so a payload
of EXACTLY the 64 KiB ceiling was refused `frame-too-large` before the exact check ran. Nothing had
noticed because no test had ever pushed a payload at the ceiling. The RFB codec made it fatal:
`chunkForRelay` emits full-ceiling frames by construction, so in the field every frame of every
screen would have been refused. Fixed to subtract the padding and pinned with a regression test that
feeds the real chunker's output through `validateRelayPayload`.

**A credential never rides a URL.** The session capability travels in an `x-session-capability`
header and nowhere else. A `?capability=` query string is REFUSED (`capability-in-url`, 400) rather
than ignored: a secret in a query string is written to ALB/nginx access logs, proxies and `Referer`
before any application code runs, so silently ignoring it would leave it logged while the caller
debugged something else. (Independent review of the first cut caught exactly that; the device side
never holds a capability at all, so it has none to leak.)

### 10.3a The health line — three states, and why `off` is the honest default

The owner's security contract (item 2) asks the agent to report a health line the product can show
per device, and for exactly three states: **off / on / unavailable**. That third state is not
decoration — collapsing it is what made the previous build lie in two directions.

| State | Means | What a lane should do |
|---|---|---|
| `off` | **Positively measured**: the OS is not listening. This is the *healthy default* (opt-in, per device) | Nothing. Do **not** treat it as a failure, and never nag the owner to "enable it" |
| `on` | Measured listening **and** enabled, tunnel-attested, blocker-free | The channel can be used |
| `blocked` | Listening but not safely usable (a blocker is named — `exposed` ranks first) | Fix the named blocker *before* any use |
| `unavailable` | **Nothing was reported** — the cause depends on the build: `<0.9.12` the `remote-access` command does not exist, `0.9.12–0.9.21` a stock Mac still goes silent by design, `>=0.9.22` the `ALLOW_SCREENSHARING` read failed for a reason other than the key being absent, and on **Windows no release reports it at all** | Do not assume either way. The card names the true remedy per build (update vs. a device-side probe): on `>=0.9.22` run `remote-access status` on the device |

> **The card no longer prints one cause for every silent row (ticket c735df85).** It used to say
> *"the agent on this Mac is too old to report a remote channel — update it"* unconditionally, which
> is true only **below 0.9.22** — the release where an absent Screen Sharing key started reading as a
> measured `off`. At `0.9.22+` the identical build reports an honest `off` on a stock Mac, so a silent
> row there is that device's own probe failing and an update cannot change it. The card now branches
> on the agent version: below `0.9.12` it points at the update (the command is absent), `0.9.12–0.9.21`
> points at the update **and says why** (the honest `off` had not shipped), `>=0.9.22` prints the
> read-only `remote-access status` command to run on the device, Windows says plainly that no release
> reports it, and an unreadable version accuses nobody. The classifier is
> `remoteUnavailableCause()` in `frontend/app/crossmodel/account/IMessageCard.tsx`, pinned by
> `__tests__/IMessageCard.remote-unavailable.c735df85.test.tsx`.

> **macOS `unavailable` got materially narrower in 0.9.22 (ticket e530220e).** A stock Mac has never
> enabled Screen Sharing, so `ALLOW_SCREENSHARING` is simply absent and macOS answers *"The
> domain/default pair … does not exist"*. That used to resolve `null` ⇒ no `remoteaccess` param ⇒
> absent-never-clobbers ⇒ `unavailable`, which the card rendered as *"the agent on this Mac is too
> old to report a remote channel — update it"* **on a current build**. The sentence was false. macOS
> *saying the key does not exist* is a **measurement, not a read failure**: it now reads `off`. Only a
> genuinely unreadable read (permissions, an uninterpretable plist) is still `unavailable`, so on
> macOS `unavailable` now means "the read broke", not "Screen Sharing was never configured".

**`off` is emitted from a live probe, never from local config.** `config.remoteAccess.enabled` records
what the *user chose*; `ALLOW_SCREENSHARING` (macOS) / `fDenyTSConnections` (Windows) record what the
*OS is doing*. They diverge whenever someone ticks Screen Sharing or Remote Desktop in System
Settings by hand — and in that direction the config is the liar. Advertising "off" from config would
make a hand-enabled listener **invisible on the one surface built to show exposure**; so the cheap
probe asks the OS, and a listener it finds is advertised as `on` + its blockers regardless of config.

**Two defects this state closes, both measured on this codebase:**

- **"Off" read as "too old to report."** A correctly-configured, deliberately-off device advertised
  *nothing*, so the fleet printed *"not configured — update the agent, then run `remote-access
  enable`"*. That instructs an operator to switch a **listening service on** as the remedy for a
  device that is healthy precisely because it is off — the exact inversion of "off by default".
- **A verified revoke left a false green.** `disable` writes `enabled:false` and then advertised
  nothing, so the last stored row (`enabled:true, tunnelOnly:true, blockers:[]`) survived
  absent-never-clobbers and the fleet kept reporting **`ready: true`** on a box whose listener,
  firewall anchor and credential had just been removed *and read back gone*. A green that outlives
  the revoke is worse than the exposure it hides, because the revoke **is** the control.

Two invariants keep `off` from becoming a way to hide a listener: `on` always wins a self-contradictory
advert (an ambiguous value can never clear a green), and a probe that cannot decide emits **nothing**
— unknown is never fabricated into `off`, exactly as unknowable is never fabricated into a blocker.

### 10.4 Enabling / revoking — THE runbook

**This is the only place the enable/revoke procedure is written down.** §4 describes the unattended
*preset* and §10.2a explains *why a rule only counts once it is filtering*; neither restates these
commands — they link here. If you change a command or a verification step, change it **here**.

#### 10.4.1 Elevation — the four commands do NOT share a model

The most common operator error on this feature is assuming one `sudo` rule covers all of it. It does
not: `unattended` and `remote-access` are deliberately **opposite**, and getting it backwards is
silent in both directions.

> **Invocation first (ticket 69ce3f01).** The commands below are written `digby-agent …` for
> readability, but the installer does **not** put that name on `PATH`. Bind it once:
>
> ```bash
> DIGBY_AGENT="$HOME/Library/Application Support/Digby/bin/digby-agent"
> ```
>
> and read every `digby-agent <sub>` in this table as `"$DIGBY_AGENT" <sub>`. Under `sudo` the full
> path is **required** — `sudo` resets `PATH`, so `sudo digby-agent …` fails even after the §4 PATH
> line; the form `sudo "$HOME/Library/Application Support/Digby/bin/digby-agent" …` works because
> your shell expands `$HOME` before `sudo` runs. After the §4 PATH line, the non-`sudo` rows work as
> plain `digby-agent`.

| Command | Run as | Why | What goes wrong if you get it wrong |
|---|---|---|---|
| `digby-agent unattended enable` / `disable` | **your own user** — *no* `sudo` | Writes the *user-scoped* screensaver + login-window preferences, and asks for administrator rights itself (`sudo -v` through your terminal, then `sudo` for the root-owned pieces) | Under `sudo`, `$USER` is `root`, so the preset configures auto-login for **root**. A machine that boots to the login window cannot complete that login — the preset looks applied and strands the device |
| `digby-agent remote-access enable` / `disable` | **`sudo`** | Drives ARDAgent's `kickstart`, a PF anchor, and `pfctl -e` — all root-owned | Unprivileged, every step exits non-zero, the fail-closed path reverts, and you get a wall of per-command failures instead of the one fact that matters: *you are not root* |
| `digby-agent remote-access status` | `sudo` **for the firewall facts** | The PF facts come from `pfctl`, which needs root to read | Unprivileged those reads fail and degrade to `null` — the line prints `firewall=null scopedToTunnel(utun)=null`, and `unknown` is easy to misread as `fine` |
| `digby-win-agent remote-access` / `unattended …` | an **elevated** terminal | Registry writes, `netsh advfirewall`, `Restart-Service`, LSA secret | ⚠ **There is no up-front elevation check on Windows** (unlike macOS's `privilegedRunRefusal`). An unelevated run gets as far as the first privileged step, fails there, and `remote-access enable` reverts / `unattended enable` skips the step — so the failure arrives as a per-command error, not one clean "you are not an administrator" |

`remote-access enable` **refuses up front** via `privilegedRunRefusal` when `getuid() !== 0`, before
touching anything. The pairing config is the reason this is subtle: under plain `sudo`, `homedir()`
becomes root's, the config is not found, and the command answers *"Not paired — nothing to disable"*
about a correctly paired device — a refusal that sends you chasing a pairing problem you do not have.
`config.ts:configHomeDir()` therefore prefers `$SUDO_USER`'s real home whenever it runs as root.
**So: pair as your normal user first, then `sudo` for the privileged subcommands.**

> **The `unattended` trap — FIXED in ticket bcdf5d2f, kept here as history.** `unattended enable` is
> run *without* `sudo`, and it used to abort with *"administrator rights are required … Run it in a
> terminal where sudo is already authorised. Nothing was changed."* That message asked the operator to
> already know about `sudo -v`: the preset escalated **internally** with `sudo -n true` as its first
> check (`-n` means *never prompt*), so the enable could only succeed if a sudo timestamp already
> existed in that shell — and the obvious workaround was forbidden, because prefixing the command
> itself with `sudo` makes `$USER` `root` and configures auto-login for `root` (first row of the table).
> Two opposite hidden prerequisites, neither discoverable from the product: that was the “very messy
> setup flow… normal users wouldn't know to run sudo” report.
>
> **The agent now obtains the rights itself.** When sudo is not already authorised, `applyMacPreset`
> runs `sudo -v` attached to the terminal (`MacIo.runInteractive`, `stdio: 'inherit'`), so the operator
> sees the standard macOS `Password:` line and types the password they already know. There is **no
> second command to run first** and **no `sudo` prefix on the enable**: one command, one prompt. The
> password goes to sudo, never through the agent's process, argv, env, logs or the pairing config. With
> no controlling terminal (a script, a launchd job) the enable still fails closed with an actionable
> sentence rather than hanging on a prompt nobody can see.
>
> **Requires agent ≥ 0.9.21.** Older agents still carry the `sudo -n` gate, so on those the old
> `sudo -v` advice remains the only workaround until the self-update lands.

#### 10.4.2 macOS — enable, verify, revoke

**The password is typed, never passed.** `enable` prompts for a **dedicated VNC password** on the
local terminal with echo off (`readSecret`). It accepts it from nowhere else: not argv, not an env
var, not a pipe — a non-TTY invocation is refused outright (`"Refusing to read a password from a
non-interactive shell — run this in Terminal.app"`), because a password in a script or a shell
history is exactly the mistake that rule exists to prevent. Run it **in Terminal.app**, as `sudo`.

> ⚠ **This password is not "secret at rest" while the command runs.** `kickstart` accepts a VNC
> password *only* as an argv argument — it reads no stdin, file or env var — so for the seconds the
> step runs it is visible to any local user in `ps`. That is precisely why it must be **dedicated**:
> a stolen VNC password buys VNC-through-the-firewall, never the account. The CLI withholds that
> step's argv from its own output (`runMacRemotePlan(…, {secret})`), but it cannot hide it from the
> kernel's process list.

```bash
# The shim the installer writes (ticket 69ce3f01). $HOME is expanded by YOUR
# shell before sudo runs, so this absolute form survives sudo's PATH reset.
DIGBY_AGENT="$HOME/Library/Application Support/Digby/bin/digby-agent"

# 0. Pair as your NORMAL user, once (see §10.4.1 — sudo would look "not paired")
"$DIGBY_AGENT" pair

# 1. Provision. Prompts for the dedicated VNC password (hidden). Sudo required.
sudo "$DIGBY_AGENT" remote-access enable <account> [tunnelInterface]

# 2. Read back what the fleet sees. Sudo, or the firewall facts print as `null`.
sudo "$DIGBY_AGENT" remote-access status
```

**What `enable` does, in order — the ordering is the safety property, not a detail.** The firewall is
established *before* anything can listen; a rule applied second leaves the port briefly public.

1. **PF enforcement preamble** (`PLAN_PF_ENFORCEMENT_SCRIPT`): append one
   `anchor "com.digby.brokered"` line to `/etc/pf.conf` (additive, grep-guarded, one-time
   `.digby.bak`), reload it, `pfctl -e`, then **verify** both conditions — failing the preamble exits
   non-zero so the caller's fail-closed path reverts. Without this, the anchor loads, reads back
   perfectly, and filters nothing (§10.2a).
2. **The PF anchor body** (`pfctl -a com.digby.brokered -f -`, rules on stdin):
   `pass in quick on <iface> … port 5900` then `block drop in quick … port 5900`.
3. **Dedicated VNC credential** (`kickstart … -setvncpw -vncpw <pw>`) — never the account password.
4. **Access limited to the designated account** (`-allowAccessFor -specifiedUsers`), never `-allUsers`.
5. `kickstart -activate`, then `-restart -agent` so it is live now, not at next boot.
6. **Post-check read-back** of the anchor.

**Verify the port is actually filtered** — the whole feature rests on this, and a rule that only
*reads back* proves nothing (§10.2a). All three must hold:

```bash
# 1. pf is ON (stock macOS ships it OFF)
sudo pfctl -s info | grep 'Status'                        # → Status: Enabled
# 2. the MAIN ruleset references our anchor (an unreferenced anchor is never evaluated)
sudo pfctl -sr | grep 'anchor "com.digby.brokered"'       # → anchor "com.digby.brokered" all
# 3. the anchor passes 5900 ONLY on the tunnel and drops it elsewhere
sudo pfctl -a com.digby.brokered -sr                      # → pass … on utun …
                                                          #   block drop … port 5900
```

If any of the three is missing, the verdict reports `exposed` — **not** "hardened". That is
deliberate: an inert rule *is* exposure, and a false green here is worse than a false red because
nobody investigates a green.

**Revoke — and confirm the stored credential is gone.** `disable` is verified, not narrated:
it re-reads three surfaces and exits non-zero naming anything that survived.

```bash
sudo "$DIGBY_AGENT" remote-access disable
```

1. `kickstart -deactivate` → `-configure -access -off` → `-stop` (service off, denied inbound).
2. **`rm -f /Library/Preferences/com.apple.VNCSettings.txt`** — the revoke is *not* done while a
   channel secret remains on disk.
3. `pfctl -a com.digby.brokered -F rules` — clear the anchor (a stale pass rule is a hole).
4. **Read-back**: `ALLOW_SCREENSHARING` (expects absent/`0`), the VNC file (expects gone), the anchor
   (expects no `pass` on 5900). Any survivor ⇒ exit 2 with a named remainder.

Two things `disable` deliberately does **not** undo, stated so nobody reports them as failures:
it does **not** turn pf back off (other anchors may be relying on it), and it leaves the
`anchor "com.digby.brokered"` line in `/etc/pf.conf` — an **empty** anchor filters nothing, so that
leftover reference is inert. Confirm the credential removal independently if you want to be certain:

```bash
sudo test -e /Library/Preferences/com.apple.VNCSettings.txt && echo "STILL PRESENT" || echo "removed ✅"
```

#### 10.4.3 Windows — enable, verify, revoke

Run from an **elevated** terminal. The CLI **never accepts, stores or sets a password** — for the
primary account or any other. The dedicated channel account is created by an administrator on the
device first (`net user`, or Settings → Accounts); this command only scopes RDP to it.

```bat
digby-win-agent remote-access enable <dedicatedAccount> [tunnelCidr]
digby-win-agent remote-access status
digby-win-agent remote-access disable
```

**`enable` order** (same principle — scope before listening): every firewall profile ON → add the
inbound rule `Digby brokered remote access` (`localport=3389`, `remoteip=<tunnelCidr>`,
`profile=any`) → `UserAuthentication=1` (NLA mandatory) → `fDenyTSConnections=0` (enable RDP **last**)
→ restart `TermService` → read the rule back.

**Verify the 3389 scoping** (the Windows counterpart of the `:5900` check above):

```bat
netsh advfirewall show allprofiles state                  :: every profile must read ON
netsh advfirewall firewall show rule name="Digby brokered remote access" verbose
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server" /v fDenyTSConnections   :: 0x0
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" /v UserAuthentication :: 0x1
```

**Revoke** — `fDenyTSConnections=1` first (that *is* the revocation), then delete the rule, restart
`TermService`, and read both back. A rule that outlives the channel is the lingering allowance this
checks for. Unlike macOS there is **no stored channel credential to clean up** — the design never
creates one, which is also why the revoke has only two surfaces to verify.

**The Windows `tunnelCidr` default is `100.64.0.0/10`** (the Tailscale CGNAT block). It used to
default to `10.0.0.0/8`, which was wrong in both directions at once: too broad (the ordinary RFC1918
LAN range, admitting every local 10.x host to 3389) and too narrow (no tailnet peer is in 10/8, so a
device enabled with the default could never be reached by a brokered peer). If your fleet's tunnel is
NOT Tailscale, pass your own block explicitly.

#### 10.4.4 What both paths guarantee

Both `enable` paths **fail closed**: if any step fails they revert immediately rather than leave the
service listening without its firewall scoping. Both `disable` paths **verify** — they re-read the
service flag, the credential file (macOS) and the firewall rule, and name anything that survived
instead of printing "done".

The channel survives a reboot to the login window (that is the point), so `remote-access disable` is
the only thing that removes it. The owner-facing switch is the per-device opt-in; nothing here is
enabled by installing an agent.

**A fresh `enable` reads `remote-ready: NO` on the fleet, and that is correct.** Neither CLI can
attest its own outbound broker binding from a local probe, so it saves `tunnelOnly: false` and the
verdict stays not-ready until the broker path confirms the tunnel. Do not "fix" that by flipping the
flag — it is the rule that an unprovable exposure boundary never reads as ready.

### 10.5 The two facts most likely to be "simplified" away by a future editor

- **`kickstart` has no interface-restriction flag.** Its `-targetdisk` option is a *mountpoint* for
  operating on another boot volume — **not** an interface control. Mistaking it for one is how a
  device ends up with a public VNC port. The firewall is the boundary, and the verdict treats a
  missing rule as a blocker (`no-firewall`), with a live exposure (`exposed`) ranked above every
  configuration nag.
- **RDP does not unlock a locked console.** The ticket asserted it does; it does not — RDP creates a
  session *beside* the locked one. `tscon /dest:console` (already shipped) is the separate
  disconnected-session recovery. Three mechanisms, three distinct facts.

### 10.6 Automated coverage

| Suite | What it pins |
|---|---|
| `backend/.../remote-access-verdict.c468f922.test.ts` | closed vocabulary, priority order (exposure first), unknown-never-ready, **enabled-but-unproven fails CLOSED**, absent-never-clobbers, credential cannot ride the wire, wire parity across all four fleet surfaces, separation from `prelogin_input`, **the three-state health line** (`off`/`on`/`blocked`/`unavailable` reachable and mutually exclusive; a verified revoke clears the stored green; `on` beats a self-contradictory `off`) |
| `imessage-agent/test/remote-access.c468f922.test.mjs` | bare-value vs `KEY = 1` parser forms, firewall-before-listen ordering, PF anchor pass/block shape, `-allUsers` never used, argv-secret withholding, 3-surface verified revert, **the listener probe measures the OS (true/false/null) in one `defaults read`** |
| `windows-agent/test/remote-access.c468f922.test.mjs` | `fDenyTSConnections` / NLA / firewall parsers, rule-before-listener ordering, NLA-before-listener, dedicated-vs-primary account, no-password-parameter, 2-surface verified revert, corrected RDP premise, **the listener probe is one `reg query`** |
| `backend/.../agent-release.c468f922.test.ts` | **the artifact is a build of the CURRENT tree**: every `src/*.ts` on disk is present in the served tarball, no extra file is, each is byte-identical, `index.ts` carries `case 'remote-access'`, and artifact version = manifest version = `package.json` = `AGENT_VERSION` |

None of these needs a real Mac or PC (the IO seams are injected). **What still needs a real machine:**
the preset items in §7 (the reboot / kill-switch proofs), plus the remote-access verification steps
now written in §10.4.2 (macOS `pfctl` read-backs) and §10.4.3 (Windows `netsh` / `reg` read-backs) —
each needs the device it describes. One item no document can close: **proving the port is genuinely
unreachable from off-tunnel** requires a device on the tunnel *and* a probe from outside it. Until
that is measured, the honest claim is "the rule is filtering", never "the device is unreachable".

### 10.7 Release discipline — a feature on `main` is not a feature on a device

The brokered-remote-access code was committed to `main` at version **0.9.11** (`2a3b4bb80c`,
`335706fd64`) **without bumping `AGENT_VERSION` or re-publishing the tarball**. Nothing failed, and
nothing in CI noticed. The consequences were only visible by measuring the artifact devices actually
download:

- the served `digby-imessage-agent.tar.gz` was still the **pre-feature** 0.9.11 build — **zero**
  occurrences of `remote-access` in the packed `index.ts`;
- every paired Mac also reported **0.9.11**, and the self-update advert is **strictly newer-than**,
  so no Mac was ever offered an update;
- net effect: the command existed **on `main` and on no device**, and both `enable` and `disable`
  were unreachable for every user who read the docs and tried them.

It shipped as **0.9.12** (`6060d7c640487ab833e8785010024eceee5d47ff3b9ac61ed2ddf5939da02f9c`).

The **0.9.14** release (owner ruling 2026-10-30, the three-state health line) is the same rule applied
to a *reporting* surface rather than a command: `off` is a new wire token, so an agent that does not
carry it cannot report the state, and shipping the backend half alone would leave every device on
`unavailable` — the state that nags the owner. The artifact governs whether the fleet can tell "off"
from "too old to report", so `src/` and the artifact moved together
(`sha256=5d6d21d74c540f5d7f25a59ae5bfacb048dde337d5d86c38aabf571a01d2d1f5`). Verify delivery the same
way — the token must be in the **packed** file, not merely in git:

```bash
tar -xzOf frontend/public/digby-imessage-agent.tar.gz imessage-agent/src/remote-access.ts | grep -c "'off'"
```

**The rule this yields:** any change under `imessage-agent/src` or `windows-agent/src` that adds or
alters a **CLI/runtime surface** is not delivered until the version is bumped and the artifact is
re-published. Check delivery by inspecting the packed artifact, never by reading git:

```bash
tar -xzOf frontend/public/digby-imessage-agent.tar.gz imessage-agent/src/index.ts | grep -c '<your-subcommand>'
```

A version bump re-anchors the version pins across the agent's test files (11 of them as of 0.9.12) —
that is intentional: the pins exist so no stray edit silently changes what version ships. Re-anchor
the assertion literals **and** their message strings; leave historical prose naming an older release
alone.

**Why nothing caught it, and what now does.** The existing consistency suite
(`agent-release.a9a74086.test.ts`) pins the tarball **↔** manifest agreement — version, sha256, native
deps, engines. That is hygiene: it asks *"do these two committed artifacts agree?"*, and while the
feature was invisible they both said 0.9.11 and both agreed. Nothing compared the artifact against the
**source tree it is supposed to be a build of**. A stale artifact agreeing with a stale manifest is
exactly the shape that passes every check and ships nothing.

`agent-release.c468f922.test.ts` closes that hole by pinning the publish contract itself
(`scripts/publish-agent-tarball.sh` copies `src/` verbatim, so the artifact's `src/` MUST equal the
on-disk `src/`): every module on disk present in the tarball, no extra module, each byte-identical, and
the artifact/manifest/`package.json`/`AGENT_VERSION` all naming one version. It was verified as a real
detector, not merely a green test — replaying the pre-release 0.9.11 artifact against it fails four of
six assertions and names the defect (`remote-access.ts` absent; `0.9.11` vs `0.9.12`).

**The contract that implies, stated plainly so it is a known rule rather than a surprise red build:**
an `imessage-agent/src` change that is **not** a release **is a red backend build**. You cannot land an
agent change and cut the release later — the guard makes those the same act. That is the point (a
feature that is merged but unpublished is exactly the defect this section records), but it does change
how a small source fix must land: run `scripts/publish-agent-tarball.sh`, re-anchor the version pins,
and commit the tarball + manifest + `config.ts` + `package.json` together. If a change genuinely must
land without a release, it has to argue for that in review — not assume it.
