/**
 * Local agent configuration — stored at ~/.config/digby-agent/config.json (chmod 600).
 * Holds the backend URL plus the agent identity issued during pairing.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';

export interface AgentConfig {
  apiBaseUrl: string;   // e.g. https://digby.ai/api
  agentId: string;
  agentToken: string;
  /** Stable per-device identity (multi-Mac, 2026-09-24): a uuid generated on
   *  this Mac at first pair and persisted here forever. The backend upserts
   *  on (userId, deviceId), so re-pairing rotates only THIS Mac's token and
   *  never disturbs the user's other Macs. Absent on configs written by
   *  pre-multi-Mac agents (the backend treats those as the legacy device). */
  deviceId?: string;
  /** CDP-attach owner master switch (v0.5.0, ticket 4258335e) — off by default.
   *  The backend's per-task attach param only takes effect when this is true
   *  (or DIGBY_BROWSER_CDP_ATTACH=1 is set). */
  browserCdpAttach?: boolean;
  /** The owner's Chrome remote-debugging port (default 9222). */
  browserCdpPort?: number;
  /** v0.6.3 first-launch permission onboarding stamp: the helper binary
   *  (dev/ino) + agent version the native permission prompts were fired for.
   *  A different binary or version re-arms the onboarding (a reinstall or app
   *  update may need its TCC grants re-made). */
  permissionsOnboarded?: { version: string; dev: number; ino: number; at: string };
  /** e2915963: the grants the agent last ADVERTISED (ax/sr/fda) + when —
   *  written by the run loop each time the state CHANGES so a successor
   *  process (a runtime swap restarts us) can seed its regression baseline
   *  from the predecessor's beliefs instead of reading post-swap state as
   *  "never granted". */
  lastAdvertisedPermissions?: {
    ax: boolean; sr: boolean; fda: boolean; cal?: boolean;
    /** 30d3c366: Input Monitoring (im) and Automation (ae) ride the baseline
     *  for the same reason `cal` does — the successor of a self-update seeds
     *  its post-update comparison from the PREDECESSOR's beliefs, so a grant
     *  the swap orphaned is detectable across the process boundary. */
    im?: boolean; ae?: boolean;
    at: string;
  };
  /** "Unattended / Autonomous use" preset (2026-10-28, owner request on card
   *  oq_f7955582). OFF by default and opt-in per device. `enabled` is set only
   *  by `digby-agent unattended enable` (which applies the preset); the
   *  backup is the CAPTURED PRE-CHANGE state the kill switch restores — it
   *  holds login-window / screensaver / pmset values ONLY, never a password.
   *  The auto-login password itself lives in /etc/kcpassword (root-only, the
   *  file loginwindow reads) and nowhere else. */
  unattended?: {
    enabled: boolean;
    backup?: {
      capturedAt: string; user: string;
      autoLoginUser: string | null; kcPasswordExisted: boolean;
      askForPassword: number | null; askForPasswordDelay: number | null; idleTime: number | null;
      acSleep: number | null; acDiskSleep: number | null; acPowerNap: number | null;
    };
    enabledAt?: string;
  };
  /** BROKERED REMOTE ACCESS (ticket c468f922, owner ruling 2026-10-29). OFF by
   *  default and opt-in per device. `enabled` is set only by
   *  `digby-agent remote-access enable`, which runs the HARDENED plan (firewall
   *  scoping BEFORE the service listens, dedicated VNC password, designated
   *  account only).
   *
   *  ⚠ NO SECRET IS STORED HERE. Unlike `unattended` (whose auto-login password
   *  has to live in /etc/kcpassword because loginwindow reads it before any
   *  session exists), this channel's credential is owned by macOS itself in
   *  /Library/Preferences/com.apple.VNCSettings.txt. This config holds the
   *  NON-secret facts needed to advertise and to revoke: the account, the
   *  tunnel interface, and whether the operator path is the brokered tunnel. */
  remoteAccess?: {
    enabled: boolean;
    /** The designated brokered account (Screen Sharing access is scoped to it;
     *  never -allUsers). */
    account?: string;
    /** The tunnel interface the PF anchor scopes 5900 to. */
    tunnelInterface?: string;
    /** The operator path is the brokered OUTBOUND tunnel (the TeamViewer
     *  property the owner asked for). A device that cannot attest this
     *  advertises no `tunnel` mark and the fleet reads it as not-ready. */
    tunnelOnly?: boolean;
    enabledAt?: string;
  };
}

// 0.2.0 — adds local browser automation (Playwright) for the browser-agent feature.
// The backend's browser router only routes to a local agent at version ≥ 0.2.0.
// 0.3.1 — computer use: treat screencapture's "could not create image from display"
// as ground-truth Screen Recording denial (CGPreflightScreenCaptureAccess can
// false-positive) so the permission-guidance dialog keeps firing.
// 0.4.0 — local browser runs HEADLESS by default (the chat side panel already
// streams a screenshot of every step); new `browser_pop_out` command relaunches
// it HEADED on the same persistent profile (URL restored) so the user can
// complete a login/2FA. DIGBY_BROWSER_HEADED=1 restores always-headed;
// DIGBY_BROWSER_HEADLESS=1 still forces headless and wins over everything.
// 0.4.2 — computer use typeText: type via REAL keycode events planned by
// computer-keymap.ts (ticket cbaf3e08 — the UnicodeString-override design
// garbled every typed char to 'a' under macOS 26's JXA bridging).
// 0.4.3 — computer use input hardening (ticket 4e4d56ff): clicks verify the
// cursor actually reached the target (read-back + one retry; refuse to click
// blind); scroll accepts an optional x/y target moved+verified before the
// wheel; screenshot geometry is cross-checked (CGDisplayBounds vs NSScreen vs
// image aspect) and clicks/scoll-xy are REFUSED on mismatch instead of being
// scaled with a wrong point size (wrong-display → wrong coordinates).
// 0.4.4 — local browser launches WITH the Chromium sandbox (ticket 88915954):
// Playwright defaults chromiumSandbox off, which passes --no-sandbox — Chrome's
// "unsupported command-line flag" warning in headed pop-outs and a strong
// automation tell on anti-bot surfaces. The macOS Seatbelt sandbox needs no
// setuid helper, so the launch now enables it.
// 0.5.0 — CDP-attach mode (ticket 4258335e — 88915954 ask c): opt-in
// connection to the owner's EXISTING signed-in Chrome via
// chromium.connectOverCDP (they launch it with --remote-debugging-port=9222).
// Two off-by-default gates (owner switch in config.json + per-task attach
// param), tasks run in a DEDICATED NEW TAB, hard safety rails refuse
// credential fields + form submits, close() closes only our tab(s) and
// DISCONNECTS (never quits their Chrome), every observation reports the actual
// mode. The backend gates attach dispatches on agent ≥ 0.5.0.
// 0.6.0 — Mac permission onboarding + self-diagnostics (ticket 2f646c10):
// the agent advertises {ax, sr, fda, relaunch} on EVERY poll (and at pair
// time), so the Account → Integrations card shows live TCC status with
// Open System Settings / Reveal DigbyHelper buttons (backend route
// POST /agents/:id/permission-action → permission_relaunch | permission_open_pane
// | permission_reveal). The FDA gate at startup is GONE — the agent keeps
// polling when Full Disk Access is missing (the card live-updates as the user
// grants it; chat reads fail with a clear permission error until then). A
// bundle swap under the running helper (app update) or 3+ consecutive verified
// cursor mis-lands while Accessibility reports granted trip relaunch — the
// backend's Relaunch helper button restarts the agent, and launchd's KeepAlive
// brings it back from the CURRENT bundle (self-heal).
// 0.6.1 — multi-display capture + owner-presence facts (cu-diag 2026-09-25
// fix #1/#6/#9): computer_screenshot captures the display that OWNS the
// frontmost window (pointer's display, then main, as fallbacks — the
// 2026-09-25 incident: a lid-closed MacBook kept its built-in panel as
// CG-main while TextEdit opened on the external Dell, so every frame was
// byte-identical while every keystroke landed) and stamps {displayId,
// displayIndex, displayCount, imageWidth, imageHeight,
// frontmostWindowDisplayId, hidIdleSeconds, remoteSession} on every result;
// clicks translate through the captured display's CG bounds. hidIdleSeconds
// excludes the agent's own posted events. DIGBY_CAPTURE_DISPLAY=main
// restores the always-main capture.
// 0.6.2 — review of the 0.6.1 wave (2026-09-25): the captured-PNG pixel
// check is REAL (the `displays` JXA action emits NUMERIC backing pixels via
// CGDisplayModeGetPixelWidth/High — the bridge returned strings and
// CGDisplayPixelsWide is point-sized on HiDPI, so 0.6.1's check never
// matched; the TS side Number()-coerces and accepts point size × integer
// scale; identical panels → ambiguous, never re-attributed by guess); the
// System Events frontmost-window probe is a separate parallel osascript
// (5 s) so an Automation stall cannot kill the display-topology read;
// remote-session kinds are separable. Kill switches:
// DIGBY_CAPTURE_PIXEL_CHECK=off, DIGBY_FRONT_WINDOW_PROBE=off,
// DIGBY_REMOTE_SESSION_IGNORE=<kinds|all>.
// 0.6.3 — first-launch permission onboarding (owner 2026-09-26: "shouldn't
// the macOS client request all necessary system settings changes the first
// time you install?"): once per helper BINARY (config permissionsOnboarded —
// a reinstall/update re-arms it) the agent fires the NATIVE Accessibility
// prompt (AXIsProcessTrustedWithOptions, pre-lists DigbyHelper) and the
// native Screen Recording prompt (a throwaway screencapture), opens Full Disk
// Access with the helper revealed, and shows ONE checklist of whatever is
// still missing. Never a gate. The advertised `sr` flag now prefers the
// screencapture ground truth (macOS 26's preflight cannot see Screen
// Recording) and re-probes on the status TTL while denied.
// DIGBY_PERMISSIONS_ONBOARD=0 disables the prompts (log only).
// 0.7.0 — calendar read path (ticket 1ea9a120): calendar_list_events command
// + a `cal` TCC advert key derived from real calendar reads (absent until the
// first read happens — the same never-clobber contract as 2f646c10).
// 0.7.1 — read-engine swap (same ticket): EventKit over the ObjC bridge
// (ASOC) replaces the broken JXA Calendar.app automation bridge; auth-tier
// gate added, contract unchanged.
// 0.7.2 — bridge-language swap (same ticket): JXA measured DEAD on both
// controlled macOSes (ek6: macOS 26.6.2 AND 14.5, 'Object is not a
// function' on the EKEventStore construction); the read now runs as
// AppleScript-ObjC (osascript -e, no -l JavaScript) with a strict
// auth-tier gate — only tiers 3 (full access) and 5 (defensive future
// full-access) read; 4 (write-only, the silent-zero trap) and 0 (not
// determined) deny fast as calendar-denied. Never-throws contract
// unchanged.
// 0.7.3 — sign-in guard (owner directive 2026-10-07): cqlstannembp2 is NOT
// signed in to the owner's Apple account and holds none of their events —
// a zero-calendars Mac now classifies as no-calendar-account instead of a
// silent empty success; calendar services are only trusted on signed-in
// Macs (Pauls-MBP, home Mac mini).
// 0.8.0 — self-update (ticket 4e75cdea, 2026-10-08): the backend's poll/pair
// responses carry an additive `update` block when this agent is older than
// the released one; this agent verifies the artifact (sha256 + tarball
// version), builds + smoke-tests the new tree, swaps itself with the prior
// tree kept for rollback, arms a health watchdog and restarts via launchd
// KeepAlive. Only self-managed (tarball/install.sh) installs self-swap —
// .app-bundled, /Library/Digby and dev checkouts are excluded. Kill switch:
// DIGBY_SELF_UPDATE=0. Bootstrap note: agents BELOW 0.8.0 have no updater —
// the last manual push to the fleet brings them to 0.8.0 and everything
// after that is automatic.
// 0.8.2 — Node 24/25/26 install fix (ticket a9a74086): better-sqlite3
// 11.10.0 shipped darwin prebuilds only for Node ABI 108/115/127/131
// (Node 18–23) — on newer Node (current Homebrew installs 26) the install
// fell to node-gyp and died on removed V8 APIs ("No prebuilt binaries found
// (target=26.0.0 …)"). Bumped to better-sqlite3 12.11.1 (prebuilds for ABI
// 127/137/141/147 = Node 22/24/25/26; JS API unchanged) and raised the
// engines floor 18 → 20; install.sh preflights the Node major and explains
// native-build failures. NATIVE DEP CHANGED → this is a MANUAL release
// (self-update's native carry refuses a dep-version change by design,
// ticket 0e4c9601): minUpdaterVersion 0.8.2 — existing Macs move to 0.8.2
// via the one-line installer (Account → Integrations → iMessage), not
// self-update.
// 0.8.3 — npm >= 12 install-scripts fix (ticket 8bcd1c4a): npm 12 blocks a
// dependency's install scripts unless the project's package.json carries
// allowScripts — with none, `npm install` completes "up to date" WITHOUT
// building better_sqlite3.node (fresh install) or rebuilding a stale-ABI
// one (Node-major upgrade over an existing tree), and the selftest then
// fails with a message that guessed "signature refused?" while discarding
// the child's real dlopen error. package.json now ships allowScripts;
// install.sh probes the built addon in a fresh child and rebuilds it when
// missing/unloadable; the selftest prints the child's actual error.
// 0.9.0 — Digby-named runtime (ticket 51d8dbe0): the launchd service runs a
// copy of the node interpreter named DigbyAgent at
// ~/Library/Application Support/Digby/bin/DigbyAgent (stable path OUTSIDE
// the self-update swap tree), so the Full Disk Access entry the user adds
// reads "DigbyAgent" instead of a generic "node" (which also over-scoped
// the grant to EVERY node process on the Mac). install.sh writes
// .node-origin (the real node path) so self-update's npm lookup still
// finds npm-cli.js; the fda-check subcommand lets install.sh probe the
// grant through the new binary and skip the add-the-file dance on re-runs.
// better-sqlite3 stays 12.11.1 — a NORMAL self-update release.
// 0.9.1 — installer/app duality release (ticket 933e6ca4): the installer
// now REMOVES the desktop app's bundled-agent plist (bootout alone let
// launchd resurrect the stale helper at every login — the persistent
// "update the agent" nag), the 45s post-install restart runs only when a
// permission was just granted (never on --update-only), and the agent
// retires the bundled plist itself on startup (retire-bundled-helper.ts)
// so already-installed Macs heal via self-update. probeScreenRecording and
// the live capture now detect the solid-black placeholder frame macOS
// hands a TCC-orphaned binary (a replaced helper's grant died with the old
// binary) instead of advertising Screen Recording ✓ while blind, and the
// permission hint names the real binary (DigbyAgent/DigbyHelper).
// 0.9.2 — single-agent convergence (ticket 405927c9, "streamline it"):
// every install shape that can never self-update is now retired by the
// self-managed agent — not just the .app-bundled helper but ALSO the
// /Library/Digby .pkg install (its served .pkg froze agent 0.1.0 for four
// months, never updates itself, and polls with the same token, flapping
// the Mac's reported version — the "still says I have old 0.63" report).
// The .pkg agent itself never retires anything (identity guard: it yields
// in postinstall to a self-managed install; the bundled helper keeps its
// own guard from 933e6ca4). The .pkg builder now stamps the AGENT version
// (not a hardcoded 0.1.0), gives the installer a title ("Digby iMessage
// Agent" — no more nameless "Installer installed ''"), and refuses to
// build a .pkg/DMG bundling an agent older than the release manifest.
// 0.9.3 — running-agent stamp + installer verification (ticket c6e91d19):
// the one-line updater "completed" while the Mac kept reporting 0.6.3 — a
// stale app-bundled helper stayed the only running poller (the served 0.1.10
// desktop app has no self-managed guard and its one-click re-registers the
// bundled job at any time), and nothing in the installer could tell. The
// agent now stamps ~/.config/digby-agent/running-agent.json (version, pid,
// entry) first thing in runLoop; install.sh waits for the stamp to name the
// installed tree's version (one kickstart retry, then a LOUD failure with
// next steps instead of silent success). The idle poll loop re-runs the
// bundled-helper retire every 5 min so an app re-registration mid-run is
// cleaned within minutes, not at next reboot. NORMAL self-update release
// (no native dep change; minUpdaterVersion stays 0.8.2).
// 0.9.4 — installer verification HARDENED (post-merge adversarial review of
// 5e8d73fc / PR #1918): the 0.9.3 wait loop could falsely FAIL (an
// apostrophe in the tree path broke the interpolated JS literal — a home
// like /Users/example'Brien made every install "THE AGENT DID NOT COME UP"; a
// symlinked invocation compared a logical path against the agent's
// realpaths entry) and falsely PASS (a stale same-version stamp from a dead
// pid verified instantly — the silent-success class this ticket exists to
// kill). All paths now cross into node via $ENV per the file's own line-124
// convention, the stamp is invalidated before `launchctl load`, the
// verifier requires a LIVE pid (kill -0), and the entry match accepts the
// realpathed tree. Same-version re-release: every Mac on ≤ 0.9.3 takes it.
// 0.9.5 — SELF-CONTAINED RUNTIME (ticket 21c68e74, 2026-10-23): the CLI
// installer copied the HOMEBREW `node` verbatim as the launchd runtime
// (~/…/Digby/bin/DigbyAgent) — a KEG-COUPLED build (LC_LOAD_DYLIB
// @rpath/libnode.147.dylib through @loader_path/../lib, ~100
// /opt/homebrew/opt/* deps), so `brew upgrade node` (SONAME bump) or
// `brew cleanup` left the service with the ticket's dyld crash-loop and
// the Mac silently "offline — last seen 5h" (all computer_task dispatches
// [COMPUTER TASK — UNAVAILABLE] while the Mac was awake). BOTH ends fixed:
// install.sh now detects a coupled interpreter via otool and installs the
// OFFICIAL self-contained build of the same version (sha256-verified
// against nodejs.org SHASUMS256.txt) as DigbyAgent, and the agent
// (src/runtime-dylib.ts) self-heals an EXISTING coupled runtime on its
// first idle poll — stage the official build, SELFTEST under the new
// binary, swap at the stable path, exit 1 → launchd relaunches from it
// (a failed heal is never fatal; the old binary keeps polling). The
// .node-origin contract, stable path, binary name and TCC story
// (51d8dbe0/933e6ca4) are unchanged. Native deps unchanged
// (better-sqlite3 12.11.1); floor stays 0.8.2.
// 0.9.6 — owner-presence classifier uses TWO CLOCKS (ticket
// 81105154): the raw HID idle is read inside the `displays` JXA, but
// humanIdleSeconds was called with Date.now() AFTER the whole screenshot
// pipeline (front-window probe + screencapture + sips — 2–8 s later), which
// shifted eventAt forward past the own-input interval end (+ 1.5 s slack)
// and made the agent's own click/type read as "human input N s ago" — the
// backend owner-presence gate then latched unattended machine runs
// camera-only (one-way) in exactly the owner-absent windows they exist
// for. classifyHidReading now receives the moment the OS value was read
// (topoReadAt / the ioreg stamp); no stamp → falls back to the report
// clock (pre-fix behavior, never a silently widened own-input window).
// Follows the 0.9.5 self-contained-runtime release (21c68e74): the
// classifier notes below describe the SECOND fix in this line.
// NORMAL self-update release (no native dep change; floor stays 0.8.2).
//
// 0.9.12 (ticket c468f922) — the FIRST release that actually ships the
// `remote-access` subcommand. Why that needs saying: 2a3b4bb80c and 335706fd64
// added the whole brokered-remote-access feature straight into
// imessage-agent/src at version 0.9.11, WITHOUT bumping this constant or
// re-publishing the tarball. The result was a release that could never reach
// anyone: the served tarball was still the old 0.9.11 build (zero occurrences
// of `remote-access`), and the advert gate is strictly-newer, so no Mac was
// ever offered an update — and every Mac already AT 0.9.11 stayed there. The
// command existed in git and on no device. Hence the bump.
//
// 0.9.20 (ticket 36d1c99f) — the agent's OWN runtime output was still handing
// the user a bare `digby-agent` remedy. `privilegedRunRefusal` printed
// "sudo digby-agent remote-access enable <account>" and four `index.ts` sites
// printed bare `digby-agent pair|unattended disable|remote-access disable|
// remote-access status`. Both installers put the shim at
// ~/Library/Application Support/Digby/bin/digby-agent and NOTHING adds that
// directory to PATH, so on a stock install every one of those lines answered
// `command not found` — a refusal message teaching the user a command that does
// not resolve. They now print the absolute path via MAC_AGENT_CLI_PATH. Bumped
// (not republished in place) because the advert gate is strictly-newer: a
// same-version republish reaches no device.
//
// 0.9.21 (ticket bcdf5d2f) — the enable could only ever succeed on a Mac where
// the operator ALREADY knew to run `sudo -v` in that same terminal. The gate was
// `sudo -n true` and `-n` means NEVER PROMPT, so a stock Mac failed it and the
// refusal said "run it in a terminal where sudo is already authorised" — while
// docs/UNATTENDED_DEVICES.md simultaneously forbade the obvious workaround,
// because prefixing the enable with `sudo` makes $USER root and configures
// auto-login for root (a machine that then boots to the login window can never
// complete that login). Two opposite hidden prerequisites, neither on the card:
// the owner's "still very messy setup flow.. normal users wouldnt know to run
// sudo prefix to command". `applyMacPreset` now asks for the rights itself via
// `ensureAdminRights` → `sudo -v` attached to the user's terminal (MacIo
// .runInteractive, stdio inherit), and the CLI says the prompt is coming before
// it appears. No second command, no `sudo` prefix, nothing to look up.
//
// 0.9.23 (ticket e530220e) — 0.9.22 shipped the three reporting fixes (admin via
// group membership not `sudo -n`; an absent ARD key reads a measured `off`; the
// pre-login reason is printed, not a hover-only title). Re-published because the
// 0.9.22 tarball carried a package-lock.json still stamping 0.9.21 — the lock
// ships INSIDE the artifact, so the release misstated its own version (caught by
// adversarial review, not by CI: only package.json was checked). Bumped rather
// than republished in place because the advert gate is strictly-newer, so a
// same-version republish would reach no device. publish-agent-tarball.sh now
// verifies BOTH files' versions before it will publish.
export const AGENT_VERSION = '0.9.24';

const CONFIG_DIR = join(configHomeDir(), '.config', 'digby-agent');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/**
 * Which `$HOME` the agent's config lives under.
 *
 * WHY THIS IS NOT JUST `homedir()` (defect found 2026-10-29 while trying to
 * enable brokered remote access on a real Mac). Two facts collide:
 *   • `remote-access enable`/`disable` MUST run as root — they write a PF
 *     anchor, enable pf, and drive ARDAgent's `kickstart`.
 *   • the pairing config (`config.json` + `device-id`) lives in the USER's
 *     `~/.config/digby-agent`, written by the agent, which runs as a
 *     LaunchAgent in that user's session.
 * So under plain `sudo`, `homedir()` becomes ROOT's, the config is not found,
 * and every privileged subcommand answered "Not paired — nothing to disable."
 * — indistinguishable from a genuinely unpaired device. That is a refusal that
 * sends the owner chasing a pairing problem they do not have.
 *
 * `SUDO_USER` is set by sudo to the invoking account; using ITS home keeps the
 * agent's own (unprivileged) launchd run byte-identical — no SUDO_USER there —
 * while making the privileged path read the same config the agent wrote.
 * Deliberately does NOT consult `$HOME` override: argv-shaped config injection
 * is how a root-owned tool gets pointed at an attacker's directory.
 */
function configHomeDir(): string {
  const sudoUser = (process.env.SUDO_USER || '').trim();
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (!isRoot) return homedir();
  // Root with no (or an implausible) SUDO_USER is a genuine root login: root's
  // own home is then the honest answer, and the "Not paired" refusal is real.
  if (!/^[a-z_][a-z0-9_.-]*$/i.test(sudoUser) || sudoUser === 'root') return homedir();
  // Prefer the invoking account's real home. /Users/<user> is the macOS
  // convention, but resolve-and-verify rather than assume: a home that does not
  // exist would silently restore the exact bug this fixes.
  for (const candidate of [join('/Users', sudoUser), join('/home', sudoUser)]) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch { /* fall through to the next candidate */ }
  }
  return homedir();
}

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): AgentConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AgentConfig>;
    if (!parsed.apiBaseUrl || !parsed.agentId || !parsed.agentToken) return null;
    return parsed as AgentConfig;
  } catch {
    return null;
  }
}

/**
 * Re-read the config from disk, falling back to what the caller already holds.
 *
 * TICKET 11b6974f — WHY THE DAEMON MUST DO THIS. The interactive subcommands
 * (`unattended enable` / `disable`, `remote-access …`) run in a SEPARATE
 * process and persist their choice by rewriting config.json. The long-running
 * poll loop used to read the config ONCE at startup and keep that snapshot in
 * a closure for the life of the process, which produced two coupled failures:
 *
 *   1. the agent kept advertising the PRESET IT BOOTED WITH, so an owner who
 *      ran `unattended enable` never saw the fleet flip — the loop's own probe
 *      passed `enabled: false` forever; and
 *   2. worse, the loop writes back to config.json on its permission-baseline
 *      change (`saveConfig({ ...config, lastAdvertisedPermissions })`) using
 *      that SAME stale snapshot — silently ERASING the `unattended` block the
 *      CLI had just written. The preset then looked never-configured even
 *      after a relaunch.
 *
 * A missing or unreadable file keeps the previous value: a transient read
 * failure must not wipe the agent's identity mid-run (loadConfig already
 * returns null for a parse error, so a torn concurrent write is safe here).
 */
export function reloadConfig(previous: AgentConfig): AgentConfig {
  return loadConfig() ?? previous;
}

export function saveConfig(config: AgentConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* best-effort */
  }
}

/** Remove the saved config (e.g. after the token is revoked) so the agent re-pairs. */
export function clearConfig(): void {
  try {
    if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH);
  } catch {
    /* best-effort */
  }
}

/**
 * Multi-Mac (2026-09-24): the stable per-device identity. Persists SEPARATELY
 * from the pair config (its own file) so unpairing (clearConfig) does NOT
 * lose the identity — a re-pair on the same Mac rejoins the SAME device row
 * instead of minting a new one.
 */
const DEVICE_ID_PATH = join(CONFIG_DIR, 'device-id');

/** This Mac's stable device id — generated once, persisted forever. */
export function getDeviceId(): string {
  try {
    if (existsSync(DEVICE_ID_PATH)) {
      const existing = readFileSync(DEVICE_ID_PATH, 'utf8').trim();
      if (/^[A-Za-z0-9-]{8,64}$/.test(existing)) return existing;
    }
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    const fresh = randomUUID();
    writeFileSync(DEVICE_ID_PATH, fresh + '\n', { mode: 0o600 });
    try { chmodSync(DEVICE_ID_PATH, 0o600); } catch { /* best-effort */ }
    return fresh;
  } catch {
    // Unwritable disk — a per-process id still gives this pair a unique row.
    return randomUUID();
  }
}
