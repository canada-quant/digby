/**
 * BROKERED REMOTE ACCESS — macOS device side (ticket c468f922, OWNER RULING
 * 2026-10-29 on card oq_b5118c38: "can we do option three but a little more
 * secure like how it's just like TeamViewer").
 *
 * WHAT THIS DOES. Option 3 = drive the OS's OWN remote channel instead of the
 * framebuffer. On macOS that channel is Screen Sharing / ARD: `screensharingd`,
 * installed and configured by ARDAgent's `kickstart` tool, listening on RFB
 * 5900 — and, critically, able to authenticate **at the login window**, which
 * is the whole reason it is worth having. This module probes that channel,
 * plans a HARDENED enable, plans a REVERT, and never stores the account
 * password.
 *
 * THREE THINGS THAT MAKE THIS "MORE SECURE" THAN PLAIN OPTION 3 — each is a
 * verified platform fact, not a preference:
 *
 * 1. NO ACCOUNT PASSWORD. The shipped unattended PRESET needs the account
 *    password (`/etc/kcpassword`) because auto-login runs before any session
 *    exists. This channel does NOT: Screen Sharing takes its own VNC password
 *    (`kickstart -configure -clientopts -setvncpw -vncpw …` with
 *    `-setvnclegacy -vnclegacy yes`). Using the account password here would be
 *    strictly worse than the preset — an inbound service accepting the real
 *    login password is a remotely-usable credential that also unlocks every
 *    other power of that account.
 *
 * 2. IT DOES NOT TRUST BINDING, BECAUSE macOS CANNOT BIND. `kickstart` has NO
 *    interface-restriction flag. Its `-targetdisk` option is a MOUNTPOINT for
 *    operating on another boot volume (verified against the authoritative flag
 *    reference, ss64.com/mac/kickstart.html) and is NOT an interface control —
 *    mistaking it for one is exactly how a device ends up with a public VNC
 *    port. So "never publicly exposed" is enforced by a PF anchor rule
 *    (`planFirewallRule`) that passes the port ONLY on the tunnel interface and
 *    drops it everywhere else, and the verdict treats a missing firewall rule
 *    as a blocker rather than a nicety.
 *
 * 3. NO "ALL USERS, ALL PRIVILEGES". `kickstart -configure -allowAccessFor
 *    -allUsers -privs -all` is what most recipes online paste, and ss64
 *    explicitly warns it "can be used to grant very permissive incoming access
 *    permissions". The plan here uses `-allowAccessFor -specifiedUsers` and
 *    lists only the designated brokered account.
 *
 * ⚠ THE ONE LEAK THIS DESIGN CANNOT CLOSE, STATED PLAINLY. `kickstart` accepts
 * the VNC password ONLY as an argv argument — it reads no stdin, no file, no
 * env var. For the seconds the command runs, any local user can see it in
 * `ps`. That is why the credential MUST be dedicated (a stolen VNC password
 * grants VNC-through-the-firewall, not the account), why the enable runs
 * immediately rather than being queued, and why this module NEVER logs argv
 * (`argvContainsSecret` regressions are pinned by test). Do not describe the
 * VNC password as "secret at rest" — it is passed in the clear to a process.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: it ships no RFB/VNC client and
 * does not make `computer_task` type at a login window. It provisions and
 * governs the channel; the operator/broker path that drives it is separate.
 * That distinction is why the fleet's `prelogin_input` fact stays honest.
 *
 * Pure planning + parsing (the exec seam is injected, exactly like
 * `unattended.ts`), so every decision here is unit-tested without a Mac.
 */

import { execFile } from 'child_process';

// ── IO seam (injected so tests never touch a real Mac) ───────────────────────
export interface MacRemoteRunResult { stdout: string; code: number }
export interface MacRemoteIo {
  /** Run a command; never throws — a failure is `{stdout:'', code≠0}`. */
  run(cmd: string, args: string[], opts?: { stdin?: string }): Promise<MacRemoteRunResult>;
  /** True when a path exists (fire-and-forget stat; never throws). */
  exists(path: string): Promise<boolean>;
}

/** The executable that owns the macOS channel. Absolute: ARDAgent's Resources
 *  dir is not on PATH, and a PATH lookup would let an earlier dir shadow it. */
export const KICKSTART =
  '/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart';

/** Where macOS keeps the Screen Sharing authorization flags. */
export const REMOTE_MANAGEMENT_PLIST = '/Library/Preferences/com.apple.RemoteManagement';

/** The VNC password file macOS writes when legacy VNC auth is configured. Its
 *  PRESENCE is probeable; its CONTENT is deliberately never read. */
export const VNC_SETTINGS_FILE = '/Library/Preferences/com.apple.VNCSettings.txt';

/**
 * The ENFORCEMENT preamble the enable plan runs before it writes any rule.
 *
 * WHY THIS EXISTS (defect found 2026-10-29 by live measurement). `pfctl -a NAME
 * -f -` loads rules into a named anchor and they read back perfectly — while
 * filtering NOTHING, because:
 *   • stock macOS ships pf DISABLED, and
 *   • stock `/etc/pf.conf` references only `com.apple/*`, so a named anchor that
 *     nothing points at is never evaluated.
 * Before this preamble existed, `remote-access enable` could report success and
 * the probe could report `scoped=true` with port 5900 completely unfiltered.
 *
 * WHAT IT DOES, in order, and why each part is safe:
 *   1. Appends ONE `anchor "com.digby.brokered"` line to /etc/pf.conf — purely
 *      additive, idempotent (grep-guarded), with a one-time .digby.bak copy. It
 *      never rewrites or removes an existing line, so the stock com.apple/* rules
 *      are untouched.
 *   2. Reloads the main ruleset so the reference takes effect.
 *   3. Enables pf if it is off (`pfctl -e`; "already enabled" is tolerated).
 *   4. VERIFIES both conditions and exits non-zero if either is unmet — so the
 *      caller's fail-closed path reverts instead of leaving a half-open device.
 *
 * The anchor reference persisting in /etc/pf.conf is what makes this survive a
 * reboot; `planMacRemoteRevert` removes the anchor's RULES, and an empty anchor
 * filters nothing, so the leftover reference is inert after a revoke.
 */
export const PLAN_PF_ENFORCEMENT_SCRIPT = [
  'set -e',
  'CONF=/etc/pf.conf',
  'ANCHOR=com.digby.brokered',
  'if ! grep -q "anchor \\"$ANCHOR\\"" "$CONF" 2>/dev/null; then',
  '  cp -n "$CONF" "$CONF.digby.bak" 2>/dev/null || true',
  '  printf \'\\nanchor "%s"\\n\' "$ANCHOR" >> "$CONF"',
  'fi',
  'pfctl -f "$CONF" >/dev/null 2>&1 || pfctl -f "$CONF"',
  'pfctl -e >/dev/null 2>&1 || true',
  'pfctl -s info | grep -q "Status: Enabled"',
  'pfctl -sr | grep -q "anchor \\"$ANCHOR\\""',
].join('\n');

/** REALRUN runner. Same discipline as `unattended.ts`'s realMacIo: execFile (no
 *  shell, so no quoting surprises). NOTE — `maxBuffer` and `timeout` are the
 *  only knobs; there is no argv logging here or anywhere in this module. */
export const realMacRemoteIo: MacRemoteIo = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      const child = execFile(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        resolve({ stdout: String(stdout || ''), code: err ? 1 : 0 });
      });
      if (opts?.stdin) {
        try { child.stdin?.end(opts.stdin); } catch { /* the command may not read stdin */ }
      }
    });
  },
  exists(path) {
    return new Promise((resolve) => {
      execFile('test', ['-e', path], (err) => resolve(!err));
    });
  },
};

// ── Parsers (pure; one per probe line) ──────────────────────────────────────

/** `defaults read …Remotemanagement ALLOW_SCREENSHARING` → 1 ⇒ enabled.
 *  Absent key ⇒ null (unknown, NEVER a fabricated false).
 *
 *  TWO REAL OUTPUT SHAPES, both handled: reading a SPECIFIC key prints the bare
 *  value ("1" / "0"), while the whole-domain form prints `ALLOW_SCREENSHARING =
 *  1`. A bare value that this missed would silently read as UNKNOWN — which
 *  would hide a DISABLED screen-sharing behind "unknown" and, worse, hide an
 *  ENABLED one that lost its firewall scope (the exposure case). */
export function parseAllowScreenSharing(stdout: string, code = 0): boolean | null {
  const s = String(stdout ?? '').trim();
  // Bare-value form (`defaults read <plist> <key>`).
  const bare = /^([01])$/.exec(s);
  if (bare) return bare[1] === '1';
  const m = /ALLOW_SCREENSHARING\s*=\s*(\d+)/i.exec(s);
  if (m) return m[1] === '1';
  // No value found: a non-zero exit OR a "does not exist" body is an honest
  // unknown, never a fabricated false.
  if (code !== 0 || /does not exist/i.test(s)) return null;
  return null;
}

/** `socketfilterfw --getglobalstate` → true only for an explicitly ENABLED
 *  firewall. Any other wording is unknown (null), because "not enabled" and
 *  "could not read" lead to different advice. */
export function parseSocketfilterState(stdout: string): boolean | null {
  const s = stdout.toLowerCase();
  if (/firewall is enabled/.test(s)) return true;
  if (/firewall is disabled/.test(s)) return false;
  return null;
}

/**
 * `pfctl -s info` → is pf actually FILTERING?
 *
 * WHY THIS EXISTS (defect found 2026-10-29 by live measurement, not review).
 * Writing rules into a named anchor with `pfctl -a NAME -f -` is NOT the same
 * as them being enforced. Two independent conditions must hold, and NEITHER
 * was checked before this fix:
 *
 *   1. pf itself must be enabled. Stock macOS ships pf **disabled**, so an
 *      anchor can load and read back perfectly while every packet passes.
 *   2. The anchor must be REFERENCED from the main ruleset. Stock
 *      `/etc/pf.conf` references only `com.apple/*`; a named anchor that no
 *      `anchor "NAME"` rule points at is never evaluated.
 *
 * Without both, `pfctl -a com.digby.brokered -sr` still prints our `pass` and
 * `block` lines — so the old probe read them back, called it
 * `firewallScopedToTunnel: true` and the fleet reported the channel as
 * HARDENED while port 5900 was wide open. That is a false green on the one
 * boundary the whole feature rests on, which is strictly worse than a false
 * red: a false red gets investigated, a false green gets trusted.
 */
export function parsePfEnabled(stdout: string): boolean | null {
  const s = String(stdout ?? '');
  if (/Status:\s*Enabled/i.test(s)) return true;
  if (/Status:\s*Disabled/i.test(s)) return false;
  return null;
}

/**
 * `pfctl -sr` (the MAIN ruleset, no `-a`) → does it reference our anchor?
 * A rule of the form `anchor "com.digby.brokered" all` is what makes the
 * anchor's contents live. Absent ⇒ the anchor is inert.
 */
export function parseAnchorReferenced(stdout: string, anchorName: string): boolean | null {
  const s = String(stdout ?? '');
  if (!s.trim()) return null;
  const escaped = anchorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`anchor\\s+"${escaped}"`, 'i').test(s);
}

/** `pfctl -a com.digby.brokered -sr` → which ports our anchor passes.
 *  Returns the set of ports mentioned in PASS rules; a `block` line for the
 *  same port is what makes the anchor meaningful. */
export function parsePfAnchor(stdout: string): { passPorts: number[]; blockPorts: number[]; passOnInterfaces: string[] } {
  const passPorts: number[] = [];
  const blockPorts: number[] = [];
  const passOnInterfaces: string[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const iface = /\bon\s+(\w+)/.exec(line)?.[1];
    const port = /\bport\s+(\d+)/.exec(line)?.[1];
    if (/^pass\b/i.test(line)) {
      if (port) passPorts.push(Number(port));
      if (iface) passOnInterfaces.push(iface);
    } else if (/^block\b/i.test(line)) {
      if (port) blockPorts.push(Number(port));
    }
  }
  return { passPorts, blockPorts, passOnInterfaces };
}

/**
 * Every fact the macOS channel reports, each degrading to null/unknown
 * independently — one unreadable key never blinds the detector, and never
 * fabricates a blocker.
 */
export interface MacRemoteSnapshot {
  /** ALLOW_SCREENSHARING (null = unreadable). */
  screenSharingEnabled: boolean | null;
  /** The VNC password file exists ⇒ a dedicated channel credential is set.
   *  null = could not tell. */
  vncCredentialPresent: boolean | null;
  /** The application firewall is enabled (null = unknown). */
  firewallEnabled: boolean | null;
  /** The anchor passes 5900 on the tunnel and drops it elsewhere AND is
   *  actually ENFORCED (pf enabled + anchor referenced). A rule that merely
   *  reads back correctly is not scoping anything — see parsePfEnabled. */
  firewallScopedToTunnel: boolean | null;
  /** pf packet filtering is ON (`pfctl -s info`). Stock macOS ships it OFF. */
  pfEnabled: boolean | null;
  /** The main ruleset references our anchor. An unreferenced anchor is inert. */
  anchorReferenced: boolean | null;
  /** The device is bound to the brokered tunnel (from agent config — a local
   *  probe cannot prove an outbound binding exists). */
  tunnelBound: boolean;
  /** The tunnel interface name used in the PF rule. */
  tunnelInterface: string;
}

/** The closed blocker vocabulary this module emits — mirrors the backend leaf
 *  `remote-access-verdict.ts` REMOTE_BLOCKER_PRIORITY tokens. A token the
 *  backend does not know is dropped there, so adding one here is safe but a
 *  MISSPELLING would silently vanish: the agent test pins the two lists equal. */
export type MacRemoteBlocker =
  | 'exposed'
  | 'account-password'
  | 'no-firewall'
  | 'no-cred'
  | 'no-tunnel'
  | 'stale';

/** Read the whole snapshot. Nothing here writes or mutates. */
export async function probeMacRemoteAccess(
  io: MacRemoteIo,
  opts: { tunnelBound: boolean; tunnelInterface?: string },
): Promise<MacRemoteSnapshot> {
  const iface = opts.tunnelInterface || 'utun';
  const [sharing, vncFile, fw, anchor, pfInfo, mainRules] = await Promise.all([
    io.run('defaults', ['read', REMOTE_MANAGEMENT_PLIST, 'ALLOW_SCREENSHARING']),
    io.exists(VNC_SETTINGS_FILE),
    io.run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate']),
    io.run('pfctl', ['-a', 'com.digby.brokered', '-sr']),
    io.run('pfctl', ['-s', 'info']),
    io.run('pfctl', ['-sr']),
  ]);
  const pf = parsePfAnchor(anchor.code === 0 ? anchor.stdout : '');
  const rulesPresent =
    pf.passPorts.includes(5900) && pf.blockPorts.includes(5900) && pf.passOnInterfaces.includes(iface);
  const pfEnabled = parsePfEnabled(pfInfo.code === 0 ? pfInfo.stdout : '');
  const anchorReferenced = parseAnchorReferenced(mainRules.code === 0 ? mainRules.stdout : '', 'com.digby.brokered');
  // ENFORCEMENT IS PART OF SCOPING. Rules that read back correctly but sit in
  // an unreferenced anchor with pf disabled are scoping NOTHING. Only claim
  // `true` when all three hold; `false` when the rules are wrong (a definite
  // exposure); `null` when we genuinely cannot tell.
  const scoped = !rulesPresent
    ? anchor.code === 0
      ? false
      : null
    : pfEnabled === false || anchorReferenced === false
      ? false
      : pfEnabled === true && anchorReferenced === true
        ? true
        : null;
  return {
    screenSharingEnabled: parseAllowScreenSharing(sharing.stdout, sharing.code),
    // `exists` is a boolean, never "unknown" — a probe that could not stat
    // resolves false, which is the SAFE direction here: an unreadable
    // credential file reads as missing (a blocker), never as provisioned.
    vncCredentialPresent: vncFile,
    firewallEnabled: parseSocketfilterState(fw.code === 0 ? fw.stdout : ''),
    firewallScopedToTunnel: scoped,
    pfEnabled,
    anchorReferenced,
    tunnelBound: opts.tunnelBound === true,
    tunnelInterface: iface,
  };
}

/**
 * The blockers this snapshot proves. NOTE the asymmetry that keeps the fleet
 * honest: an UNKNOWN never becomes a blocker (a device we cannot probe is not
 * accused of being exposed), but an unknown also never reads as ready — the
 * backend verdict requires positive `tunnel` + no blockers.
 *
 * THE ENFORCEMENT RULE (added 2026-10-29). `exposed` fires whenever the
 * channel is enabled and the scoping is `false` — and `firewallScopedToTunnel`
 * is already `false` for a rule that exists but is NOT enforced (pf disabled,
 * or the anchor unreferenced by the main ruleset). That collapse is deliberate:
 * an inert rule IS exposure, and inventing a second token would let a lane
 * read "rules present" as safe. There is exactly one meaning of scoped-true —
 * rules present AND pf enabled AND anchor referenced.
 */
export function evaluateMacRemoteAccess(snap: MacRemoteSnapshot): { enabled: boolean; blockers: MacRemoteBlocker[] } {
  const enabled = snap.screenSharingEnabled === true;
  const blockers: MacRemoteBlocker[] = [];
  if (snap.firewallEnabled === false) blockers.push('no-firewall');
  // A known-enabled channel whose scoping is NOT PROVEN is the exposure case:
  // covers both "no rule" and "rule present but not enforced".
  if (enabled && snap.firewallScopedToTunnel === false) blockers.push('exposed');
  if (enabled && snap.vncCredentialPresent === false) blockers.push('no-cred');
  if (enabled && !snap.tunnelBound) blockers.push('no-tunnel');
  return { enabled, blockers };
}

/** The advert value the agent sends on the poll: `on,tunnel,<blockers…>`.
 *  Emits ONLY closed-vocabulary tokens — a credential has nowhere to go. */
export function remoteAccessAdvertValue(state: { enabled: boolean; tunnelOnly: boolean; blockers: MacRemoteBlocker[]; off?: boolean }): string {
  const out: string[] = [];
  if (state.enabled) out.push('on');
  // A proved-not-listening device advertises `off` (owner ruling 2026-10-30,
  // health-line item 2). `on` always wins a conflict so an ambiguous value can
  // never clear a stored green on the fleet.
  else if (state.off) out.push('off');
  if (state.tunnelOnly) out.push('tunnel');
  out.push(...state.blockers);
  return out.join(',');
}

/**
 * The CHEAP listener probe: is Screen Sharing listening at all?
 *
 * ONE `defaults read`, no pfctl, no kickstart. It exists so every poll can
 * advertise an HONEST `off` (the owner's third health state) at the cost of one
 * subprocess instead of six — and, critically, so `off` is a MEASUREMENT rather
 * than a restatement of local config.
 *
 * WHY IT MUST BE A MEASUREMENT. `config.remoteAccess.enabled` is what the user
 * chose; `ALLOW_SCREENSHARING` is what the OS is actually doing. They diverge
 * whenever someone ticks "Screen Sharing" in System Settings by hand — and in
 * that direction the config is the liar. Trusting config for `off` would let a
 * hand-enabled public VNC listener be advertised as "off", i.e. invisible on
 * the one surface built to show exposure. So:
 *   - `false`  ⇒ advertise `off` (proved nothing is listening).
 *   - `true`   ⇒ run the FULL probe and advertise `on` + blockers, whatever
 *               the config says (that is the hand-enabled case, and it must
 *               show up as `exposed` rather than vanish).
 *   - `null`   ⇒ could not tell: emit NOTHING (absent-never-clobbers). An
 *               unknown never becomes a fabricated `off`, for the same reason
 *               an unknown never becomes a fabricated blocker.
 */
export async function probeMacRemoteListener(io: MacRemoteIo): Promise<boolean | null> {
  try {
    const r = await io.run('defaults', ['read', REMOTE_MANAGEMENT_PLIST, 'ALLOW_SCREENSHARING']);
    return parseAllowScreenSharing(r.stdout, r.code);
  } catch {
    return null;
  }
}

// ── Enable / revert plans (pure args; no execution) ─────────────────────────

/** One planned command. `stdin` carries a payload the command reads from its
 *  stdin (the PF anchor body) — it is NEVER a credential: the whole point of
 *  the credential design is that `kickstart` has no stdin path. */
export interface MacRemoteStep {
  cmd: string;
  args: string[];
  /** Why this step exists, in the device's own terms (surfaced by the CLI). */
  why: string;
  /** Optional stdin payload (firewall rules only). */
  stdin?: string;
}

/**
 * The hardened enable, in the ONE order that is safe: scope the firewall
 * BEFORE the service can listen. If the rule is applied second, the port is
 * briefly public — that ordering is the difference between a policy and a
 * gesture, so it is pinned by test.
 *
 * `vncPassword` is passed in argv because `kickstart` accepts it nowhere else
 * (documented above). Callers must not log the returned args.
 */
export function planMacRemoteEnable(opts: {
  vncPassword: string;
  account: string;
  tunnelInterface: string;
}): MacRemoteStep[] {
  const iface = opts.tunnelInterface;
  return [
    {
      cmd: 'sh',
      args: ['-c', PLAN_PF_ENFORCEMENT_SCRIPT],
      why: 'ENFORCEMENT FIRST — pf ON and our anchor REFERENCED by the main ruleset; without both, every rule below is inert (stock macOS ships pf disabled and references only com.apple/*)',
    },
    {
      cmd: 'pfctl',
      args: ['-a', 'com.digby.brokered', '-f', '-'],
      why: 'FIREWALL — pass 5900 only on the tunnel, drop it everywhere else (macOS cannot bind Screen Sharing to an interface)',
      // The anchor body rides stdin; it is built by planFirewallRule() so the
      // rule text lives in ONE place. Carrying it here (rather than the
      // executor) keeps the plan self-contained and lets a test prove the
      // firewall step precedes every kickstart step.
      stdin: planFirewallRule(iface),
    },
    {
      cmd: KICKSTART,
      args: [
        '-configure',
        '-clientopts',
        '-setvnclegacy',
        '-vnclegacy',
        'yes',
        '-setvncpw',
        '-vncpw',
        opts.vncPassword,
      ],
      why: 'dedicated VNC password (never the account password) so a pre-login session can authenticate',
    },
    {
      cmd: KICKSTART,
      args: ['-configure', '-access', '-on', '-allowAccessFor', '-specifiedUsers', '-users', opts.account, '-privs', '-all'],
      why: 'grant access to the DESIGNATED account only — never -allUsers (ss64 warns that grants very permissive access)',
    },
    {
      cmd: KICKSTART,
      args: ['-activate'],
      why: 'activate the ARD agent so it starts at boot and survives a reboot to the login window',
    },
    {
      cmd: KICKSTART,
      args: ['-restart', '-agent'],
      why: 'restart the agent so the new configuration is live now, not at next boot',
    },
    {
      cmd: 'pfctl',
      args: ['-a', 'com.digby.brokered', '-sr'],
      why: `post-check: read the anchor back (verifies ${iface} scoping) instead of assuming the write landed`,
    },
  ];
}

/**
 * The PF anchor body. ORDER MATTERS: the tunnel `pass` is `quick`, so traffic
 * arriving on the tunnel interface is accepted before the blanket `block`
 * below it can see it; everything else falls through to the block.
 */
export function planFirewallRule(tunnelInterface: string): string {
  return [
    '# com.digby.brokered — managed by Digby (ticket c468f922). Do not edit by hand.',
    `pass in quick on ${tunnelInterface} proto tcp from any to any port 5900`,
    'block drop in quick proto tcp from any to any port 5900',
    '',
  ].join('\n');
}

/**
 * Why the privileged half of this feature cannot run at all, or null when it
 * can. Checked BEFORE a single step runs.
 *
 * WHY THIS EXISTS (defect found 2026-10-29 by running the command on a real
 * Mac, not by review). `planMacRemoteEnable` shells out to `pfctl` (write a PF
 * anchor, enable pf) and to ARDAgent's `kickstart` (configure Screen Sharing).
 * Every one of those needs root. But the agent that owns this config runs as a
 * per-user LaunchAgent, so `remote-access enable` typed in that user's terminal
 * ran the whole plan unprivileged: each step exited non-zero, the fail-closed
 * path reverted, and the operator saw a wall of per-command failures instead of
 * the one fact that mattered — "you are not root". The reverse mistake was
 * equally silent: under `sudo`, `homedir()` is root's, so the command answered
 * "Not paired" about a device that is paired.
 *
 * Fails CLOSED and names the exact remedy. Pure, so it is unit-tested without a
 * Mac and cannot regress into "the plan was attempted anyway".
 */
export function privilegedRunRefusal(opts: {
  /** process.getuid() — undefined on Windows, hence optional. */
  uid: number | undefined;
  /** True when loadConfig() found a usable pairing. */
  paired: boolean;
}): string | null {
  if (!opts.paired) {
    return (
      'Not paired — run `digby-agent pair` first (the fleet can only see a paired device). ' +
      'If this device IS paired, you are probably running under sudo: the pairing lives in the ' +
      "invoking user's ~/.config/digby-agent, so use `sudo -E` or run as that user."
    );
  }
  // undefined uid = a platform without getuid; do not invent a refusal for it.
  if (opts.uid === undefined) return null;
  if (opts.uid !== 0) {
    return (
      'Administrator rights are required: this configures ARDAgent (Screen Sharing) and a PF ' +
      'anchor, which are root-owned. Re-run as: sudo digby-agent remote-access enable <account> ' +
      '[tunnelInterface]. Nothing was changed.'
    );
  }
  return null;
}

/**
 * Full revert: deactivate the channel, clear the dedicated credential, remove
 * the firewall anchor. This is the "revoke path removes the daemon/service and
 * any stored credential, VERIFIED" criterion — the verification is the final
 * read-back commands, not an assumption.
 */
export function planMacRemoteRevert(tunnelInterface: string): MacRemoteStep[] {
  return [
    { cmd: KICKSTART, args: ['-deactivate'], why: 'stop the ARD agent running at boot' },
    { cmd: KICKSTART, args: ['-configure', '-access', '-off'], why: 'deny inbound access' },
    { cmd: KICKSTART, args: ['-stop'], why: 'stop the running agent and helpers' },
    {
      cmd: 'rm',
      args: ['-f', VNC_SETTINGS_FILE],
      why: 'remove the dedicated VNC credential — the revoke is not done while a channel secret remains on disk',
    },
    {
      cmd: 'pfctl',
      args: ['-a', 'com.digby.brokered', '-F', 'rules'],
      why: `clear the anchor (${tunnelInterface}) — a stale pass rule is a credential-free hole`,
    },
    {
      cmd: 'defaults',
      args: ['read', REMOTE_MANAGEMENT_PLIST, 'ALLOW_SCREENSHARING'],
      why: 'VERIFY the revert: read the flag back (expects absent or 0)',
    },
  ];
}

/**
 * Post-revert verification, pure: given the read-back values, is the device
 * clean? Used by the agent's `remote-access disable` output so "revoked" is a
 * claim with a check behind it rather than a printed intention.
 */
export function verifyMacRemoteRevert(reads: {
  allowScreenSharing: string;
  vncFileExists: boolean;
  anchorRules: string;
}): { clean: boolean; remaining: string[] } {
  const remaining: string[] = [];
  const sharing = parseAllowScreenSharing(reads.allowScreenSharing);
  if (sharing === true) remaining.push('ALLOW_SCREENSHARING is still 1');
  if (reads.vncFileExists) remaining.push(`${VNC_SETTINGS_FILE} still exists (dedicated credential not removed)`);
  const pf = parsePfAnchor(reads.anchorRules);
  if (pf.passPorts.includes(5900)) remaining.push('the PF anchor still passes 5900');
  return { clean: remaining.length === 0, remaining };
}

/**
 * Execute a plan. Returns the per-step outcome WITHOUT the argv of any step
 * that carried a secret — this is the one place a careless implementation
 * would echo the VNC password into a log or a result envelope, so the shape
 * itself makes that impossible: a step whose args contain `secret` is reported
 * by `cmd` + `why` only.
 *
 * `secret` is passed in explicitly (not scraped from the plan) so the caller
 * must name the value it is protecting.
 */
export async function runMacRemotePlan(
  io: MacRemoteIo,
  steps: MacRemoteStep[],
  opts: { secret?: string } = {},
): Promise<Array<{ cmd: string; why: string; code: number; ok: boolean }>> {
  const out: Array<{ cmd: string; why: string; code: number; ok: boolean }> = [];
  for (const step of steps) {
    const carriesSecret =
      !!opts.secret && step.args.some((a) => argvContainsSecret(a, opts.secret as string));
    const res = await io.run(step.cmd, step.args, step.stdin ? { stdin: step.stdin } : undefined);
    out.push({ cmd: carriesSecret ? `${step.cmd} (args withheld)` : step.cmd, why: step.why, code: res.code, ok: res.code === 0 });
  }
  return out;
}

/**
 * Guard against the ONE way this module could leak: putting a secret into a
 * log line or an error message. Returns true when `text` contains the
 * credential, so a caller can refuse to log it. Pinned by test — the enable
 * path passes argv through here before any `logger`/`console` call.
 */
export function argvContainsSecret(text: string, secret: string): boolean {
  if (!secret || secret.length < 4) return false;
  return text.includes(secret);
}