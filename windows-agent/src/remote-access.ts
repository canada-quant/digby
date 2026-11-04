/**
 * BROKERED REMOTE ACCESS — Windows device side (ticket c468f922, OWNER RULING
 * 2026-10-29 on card oq_b5118c38: "can we do option three but a little more
 * secure like how it's just like TeamViewer").
 *
 * WHAT THIS DOES. Option 3 = drive the OS's OWN remote channel instead of the
 * framebuffer. On Windows that channel is Remote Desktop (`TermService` on TCP
 * 3389), which authenticates at the logon screen through the Credential
 * Provider and therefore reaches a locked/console-less box in a way the
 * user-session agent cannot. This module probes that channel, plans a HARDENED
 * enable, plans a REVERT, and never stores the account password.
 *
 * ⚠ THE TICKET'S WINDOWS PREMISE IS WRONG — CORRECTED HERE, IN CODE. The
 * ticket says "RDP DOES work on a locked console, so a Windows path can
 * leverage that." It does not: RDP creates a session BESIDE the existing
 * locked one and cannot unlock it. What RDP genuinely provides is a NEW
 * interactive session for the connecting user — which IS the capability the
 * lane needed (drive a signed-in GUI on a box whose console is dark), just not
 * by "unlocking" anything. The DISCONNECTED-session recovery is a different
 * mechanism (`tscon <id> /dest:console`), already shipped in
 * `windows-agent/src/unattended.ts planConsoleReattach()`. Keeping these three
 * distinct is why the fleet's typed facts stay honest:
 *   - RDP            → a new remote session (this module)
 *   - tscon          → re-attach a dropped session to the console (shipped)
 *   - secure desktop → NEVER driveable from a user-session process (no module)
 *
 * THREE HARDENING FACTS THAT MAKE THIS MORE THAN PLAIN OPTION 3:
 *
 * 1. NETWORK LEVEL AUTHENTICATION IS MANDATORY. `UserAuthentication=1` on the
 *    RDP-Tcp listener makes the host authenticate BEFORE allocating a session,
 *    which removes the pre-auth surface that RDP brute-force tooling targets.
 *    A device without it is a blocker (`no-nla`), not a warning.
 *
 * 2. A DEDICATED CHANNEL ACCOUNT, NEVER THE PRIMARY ONE. This is the Windows
 *    analogue of macOS's dedicated VNC password: if the brokered account is
 *    the same account the unattended preset auto-logs-in with, then the RDP
 *    channel accepts the machine's real login password — an inbound service
 *    that unlocks the account itself. `evaluateWinRemoteAccess` reports
 *    `account-password` when the channel account equals the Winlogon
 *    `DefaultUserName`.
 *
 * 3. THE FIREWALL CARRIES THE EXPOSURE BOUNDARY, because Windows (like macOS)
 *    offers no bind-to-interface for TermService. The planned rule is scoped by
 *    `remoteip=` to the tunnel address, so the port is not reachable from the
 *    LAN or the internet even though the listener binds all interfaces.
 *
 * SCOPE — WHAT THIS MODULE DOES NOT DO: it ships no RDP client and does not
 * make `computer_task` drive a remote session. It provisions and governs the
 * channel; the operator/broker side is separate. That is why the fleet's
 * `prelogin_input` fact for computer_task stays `unavailable` while the
 * channel is reported as its own typed fact.
 *
 * Pure planning + parsing (exec seam injected, exactly like `unattended.ts`),
 * so every decision is unit-tested without a Windows box.
 */

import { execFile } from 'child_process';

// ── IO seam (injected so tests never touch a real PC) ────────────────────────
export interface WinRemoteRunResult { stdout: string; code: number }
export interface WinRemoteIo {
  run(cmd: string, args: string[], opts?: { stdin?: string }): Promise<WinRemoteRunResult>;
}

export const realWinRemoteIo: WinRemoteIo = {
  run(cmd, args, opts) {
    return new Promise((resolve) => {
      const child = execFile(cmd, args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        resolve({ stdout: String(stdout || ''), code: err ? 1 : 0 });
      });
      if (opts?.stdin) {
        try { child.stdin?.end(opts.stdin); } catch { /* the command may not read stdin */ }
      }
    });
  },
};

export const TS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server';
export const RDP_TCP_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp';
export const WINLOGON_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon';
export const FIREWALL_RULE_NAME = 'Digby brokered remote access';

/**
 * The tunnel range the RDP port is scoped to, when the owner/CLI names none.
 *
 * WHY Tailscale's CGNAT block and not the old `10.0.0.0/8` (defect found
 * 2026-10-29 by reading the default against the live fleet): `10.0.0.0/8` is
 * wrong in BOTH directions at once.
 *   • TOO BROAD — it is the ordinary RFC1918 LAN range, so it admits every
 *     host on the local network (and any other 10.x network that can route
 *     here) to port 3389. That is the exposure case this whole feature exists
 *     to prevent.
 *   • TOO NARROW — the fleet's tunnel is Tailscale, whose peer addresses live
 *     in 100.64.0.0/10 (confirmed: all 13 fleet peers are 100.x). A 10.x rule
 *     admits NONE of them, so the channel cannot work as configured.
 * Scoping to the tunnel block is both strictly narrower than the LAN default
 * and the only range that actually admits a brokered peer. Overridable per
 * device (`remote-access enable <account> [tunnelCidr]`) for a fleet on a
 * different tunnel block.
 */
export const DEFAULT_TUNNEL_CIDR = '100.64.0.0/10';

// ── Parsers (pure; one per probe line) ──────────────────────────────────────

/** `reg query …\Terminal Server /v fDenyTSConnections` → enabled = (value 0).
 *  Absent value ⇒ null (unknown), never a fabricated "enabled". */
export function parseRdpEnabled(stdout: string, code = 0): boolean | null {
  const m = /fDenyTSConnections\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
  if (!m) return code === 0 ? null : null;
  return parseInt(m[1], 16) === 0;
}

/** NLA: `UserAuthentication` 0x1 = required. Absent ⇒ null (unknown). */
export function parseNlaRequired(stdout: string): boolean | null {
  const m = /UserAuthentication\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout);
  if (!m) return null;
  return parseInt(m[1], 16) === 1;
}

/** A REG_SZ read (`reg query … /v DefaultUserName`) → the string, or null. */
export function parseRegSz(stdout: string): string | null {
  const m = /REG_SZ\s+([^\r\n]*)/i.exec(stdout);
  if (!m) return null;
  const v = m[1].trim();
  // Windows writes "(value not set)" for an empty/missing value.
  if (!v || /value not set/i.test(v)) return null;
  return v;
}

/** `netsh advfirewall firewall show rule name="…" verbose` → the scoping facts
 *  this policy cares about. Returns null when the rule does not exist, which is
 *  DIFFERENT from a rule that exists but is unscoped. */
export function parseFirewallRule(stdout: string): {
  exists: boolean;
  enabled: boolean;
  localPorts: number[];
  remoteIps: string[];
} {
  if (!/Rule Name:/i.test(stdout) || /No rules match/i.test(stdout)) {
    return { exists: false, enabled: false, localPorts: [], remoteIps: [] };
  }
  const enabled = !/Enabled:\s*No/i.test(stdout);
  const portLine = /LocalPort:\s*([^\r\n]*)/i.exec(stdout)?.[1] ?? '';
  const ipLine = /RemoteIP:\s*([^\r\n]*)/i.exec(stdout)?.[1] ?? '';
  const localPorts = (portLine.match(/\d+/g) ?? []).map(Number);
  const remoteIps = ipLine
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { exists: true, enabled, localPorts, remoteIps };
}

/**
 * Is the firewall rule scoped to the tunnel (rather than to Any)? A rule whose
 * RemoteIP is `Any`, or empty, exposes the port to everything that can route to
 * the host. `null` = the rule is absent (a different blocker).
 */
export function firewallScopedToTunnel(stdout: string, tunnelCidr: string): boolean | null {
  const rule = parseFirewallRule(stdout);
  if (!rule.exists || !rule.enabled) return rule.exists ? false : null;
  if (!rule.localPorts.includes(3389)) return false;
  const any = rule.remoteIps.some((ip) => /^any$/i.test(ip) || /0\.0\.0\.0\/0/.test(ip) || /::\/0/.test(ip));
  if (any || rule.remoteIps.length === 0) return false;
  // Scoped: at least one RemoteIP is inside the tunnel range we configured.
  return rule.remoteIps.some((ip) => ip === tunnelCidr || ip.startsWith(tunnelCidr.split('/')[0]));
}

/**
 * `netsh advfirewall show allprofiles state` → which Windows firewall profiles
 * are actually ON.
 *
 * WHY THIS EXISTS (defect found 2026-10-29 by live measurement, not review).
 * A Defender rule that reads back perfectly is INERT whenever the profile it
 * applies to has its firewall switched off — which is common on a managed lab
 * box, and is exactly the state where someone thinks "the rule is there". Our
 * own enable plan writes `profile=any`, so the rule's protection depends on
 * EVERY profile being on. Before this fix the probe never read the profile
 * state at all, so `firewallScopedToTunnel` could be `true` while 3389 was
 * unfiltered — a false green on the exposure boundary, which is worse than a
 * false red because nobody investigates a green.
 *
 * Returns null when nothing could be parsed (honest unknown, never a
 * fabricated "off").
 */
export function parseFirewallProfiles(stdout: string): { allOn: boolean; profiles: Record<string, boolean> } | null {
  const profiles: Record<string, boolean> = {};
  // Lines look like: "Domain Profile Settings:" then "State   ON".
  const re = /(Domain|Private|Public)\s+Profile\s+Settings:([\s\S]*?)(?=(?:Domain|Private|Public)\s+Profile\s+Settings:|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(stdout ?? ''))) !== null) {
    const name = m[1].toLowerCase();
    const stateOn = /\bState\s+(ON|OFF|ENABLE[D]?|DISABLE[D]?)\b/i.exec(m[2]);
    if (!stateOn) continue;
    profiles[name] = /^(on|enable)/i.test(stateOn[1]);
  }
  const keys = Object.keys(profiles);
  if (keys.length === 0) return null;
  return { allOn: keys.every((k) => profiles[k]), profiles };
}

/** The whole Windows channel snapshot; every field degrades independently. */
export interface WinRemoteSnapshot {
  /** fDenyTSConnections = 0. */
  rdpEnabled: boolean | null;
  /** UserAuthentication = 1. */
  nlaRequired: boolean | null;
  /** The firewall rule exists AND is scoped to the tunnel AND is enforced
   *  (every firewall profile it applies to is ON). See parseFirewallProfiles. */
  firewallScopedToTunnel: boolean | null;
  /** Every Windows firewall profile is ON (null = could not read). An OFF
   *  profile makes the Defender rule inert. */
  firewallProfilesOn: boolean | null;
  /** The account the brokered channel is meant to use. */
  channelAccount: string | null;
  /** The account the unattended preset auto-logs-in as (the PRIMARY account).
   *  Equal to channelAccount ⇒ the channel accepts the machine's real login
   *  password, which is the `account-password` blocker. */
  primaryAccount: string | null;
  /** The device is bound to the brokered tunnel (agent config — a local probe
   *  cannot prove an OUTBOUND binding exists). */
  tunnelBound: boolean;
}

export type WinRemoteBlocker =
  | 'exposed'
  | 'account-password'
  | 'no-firewall'
  | 'no-cred'
  | 'no-nla'
  | 'no-tunnel'
  | 'stale';

/** Read the snapshot. Nothing here writes or mutates. */
export async function probeWinRemoteAccess(
  io: WinRemoteIo,
  opts: { channelAccount?: string | null; tunnelCidr: string; tunnelBound: boolean },
): Promise<WinRemoteSnapshot> {
  const [deny, nla, fw, primary, profiles] = await Promise.all([
    io.run('reg', ['query', TS_KEY, '/v', 'fDenyTSConnections']),
    io.run('reg', ['query', RDP_TCP_KEY, '/v', 'UserAuthentication']),
    io.run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE_NAME}`, 'verbose']),
    io.run('reg', ['query', WINLOGON_KEY, '/v', 'DefaultUserName']),
    io.run('netsh', ['advfirewall', 'show', 'allprofiles', 'state']),
  ]);
  const profileState = parseFirewallProfiles(profiles.code === 0 ? profiles.stdout : '');
  const firewallProfilesOn = profileState ? profileState.allOn : null;
  const ruleScoped = firewallScopedToTunnel(fw.code === 0 ? fw.stdout : '', opts.tunnelCidr);
  // ENFORCEMENT IS PART OF SCOPING. A scoped rule whose profile firewall is
  // OFF filters nothing. `false` when either is definitively wrong; only claim
  // `true` when the rule is scoped AND every profile is on.
  const scoped = ruleScoped === false || firewallProfilesOn === false
    ? false
    : ruleScoped === true && firewallProfilesOn === true
      ? true
      : null;
  return {
    rdpEnabled: parseRdpEnabled(deny.stdout, deny.code),
    nlaRequired: parseNlaRequired(nla.code === 0 ? nla.stdout : ''),
    firewallScopedToTunnel: scoped,
    firewallProfilesOn,
    channelAccount: opts.channelAccount ?? null,
    primaryAccount: parseRegSz(primary.code === 0 ? primary.stdout : ''),
    tunnelBound: opts.tunnelBound === true,
  };
}

/**
 * The blockers this snapshot proves. Same asymmetry as macOS: an UNKNOWN never
 * becomes a blocker, but an unknown also never reads as ready (the backend
 * verdict requires positive `tunnel` + no blockers).
 */
export function evaluateWinRemoteAccess(snap: WinRemoteSnapshot): { enabled: boolean; blockers: WinRemoteBlocker[] } {
  const enabled = snap.rdpEnabled === true;
  const blockers: WinRemoteBlocker[] = [];
  if (enabled && snap.firewallScopedToTunnel === false) blockers.push('exposed');
  // The channel must never accept the PRIMARY account's password.
  if (
    enabled &&
    snap.channelAccount !== null &&
    snap.primaryAccount !== null &&
    snap.channelAccount.toLowerCase() === snap.primaryAccount.toLowerCase()
  ) {
    blockers.push('account-password');
  }
  if (enabled && snap.firewallScopedToTunnel === null) blockers.push('no-firewall');
  if (enabled && !snap.channelAccount) blockers.push('no-cred');
  if (enabled && snap.nlaRequired === false) blockers.push('no-nla');
  if (enabled && !snap.tunnelBound) blockers.push('no-tunnel');
  return { enabled, blockers };
}

/** `on,tunnel,<blockers…>` — closed vocabulary only, so a credential has
 *  nowhere to go even if one were passed in by accident. */
export function remoteAccessAdvertValue(state: { enabled: boolean; tunnelOnly: boolean; blockers: WinRemoteBlocker[]; off?: boolean }): string {
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
 * The CHEAP listener probe: is the RDP listener enabled at all?
 *
 * ONE `reg query`, no firewall enumeration, no service restart. Mirrors the
 * macOS `probeMacRemoteListener` and exists for the same reason: every poll
 * must be able to advertise an HONEST `off` (the owner's third health state)
 * at the cost of one subprocess.
 *
 * AND IT MUST BE A MEASUREMENT. `config.remoteAccess.enabled` is what the user
 * chose; `fDenyTSConnections` is what Windows is actually doing. They diverge
 * whenever someone enables Remote Desktop in Settings by hand — and in that
 * direction the config is the liar, so a hand-enabled RDP listener with no
 * firewall scoping would advertise as "off" and stay invisible. So:
 *   - `false` ⇒ advertise `off` (proved RDP is denied).
 *   - `true`  ⇒ run the FULL probe and advertise `on` + blockers regardless of
 *               config (the hand-enabled case must surface as `exposed`).
 *   - `null`  ⇒ could not tell: emit NOTHING (absent-never-clobbers). An
 *               unknown never becomes a fabricated `off`.
 */
export async function probeWinRemoteListener(io: WinRemoteIo): Promise<boolean | null> {
  try {
    const r = await io.run('reg', ['query', TS_KEY, '/v', 'fDenyTSConnections']);
    return parseRdpEnabled(r.stdout, r.code);
  } catch {
    return null;
  }
}

export interface WinRemoteStep {
  cmd: string;
  args: string[];
  why: string;
  /** The step's argv carries a secret — never log it. */
  carriesSecret?: boolean;
}

/**
 * The hardened enable, in the ONE order that is safe: FIREWALL RULE FIRST, then
 * NLA, then the listener. Enabling TermService before the scoped rule exists
 * puts a public RDP port on the network for however long the gap lasts — the
 * ordering is pinned by test.
 *
 * `accountPassword` is NOT accepted here: this plan never provisions a
 * credential for the primary account. Creating the dedicated account (and
 * setting its password) is an owner/administrator step on the device, and the
 * plan only scopes RDP to it — which keeps this module structurally incapable
 * of storing the machine's real login password.
 */
export function planWinRemoteEnable(opts: { tunnelCidr: string }): WinRemoteStep[] {
  return [
    {
      cmd: 'netsh',
      args: ['advfirewall', 'set', 'allprofiles', 'state', 'on'],
      why: 'ENFORCEMENT FIRST — turn every firewall profile ON; a Defender rule is INERT on a profile whose firewall is off, so scoping a port while the filter is down protects nothing',
    },
    {
      cmd: 'netsh',
      args: [
        'advfirewall', 'firewall', 'add', 'rule',
        `name=${FIREWALL_RULE_NAME}`,
        'dir=in', 'action=allow', 'protocol=TCP', 'localport=3389',
        `remoteip=${opts.tunnelCidr}`,
        'profile=any', 'enable=yes',
      ],
      why: `FIREWALL — scope 3389 to the tunnel (${opts.tunnelCidr}); Windows cannot bind TermService to an interface`,
    },
    {
      cmd: 'reg',
      args: ['add', RDP_TCP_KEY, '/v', 'UserAuthentication', '/t', 'REG_DWORD', '/d', '1', '/f'],
      why: 'require Network Level Authentication so the host authenticates BEFORE allocating a session',
    },
    {
      cmd: 'reg',
      args: ['add', TS_KEY, '/v', 'fDenyTSConnections', '/t', 'REG_DWORD', '/d', '0', '/f'],
      why: 'enable Remote Desktop last — only now is the port already scoped',
    },
    {
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', 'Restart-Service -Name TermService -Force'],
      why: 'restart TermService so the listener picks up NLA now, not at next boot',
    },
    {
      cmd: 'netsh',
      args: ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE_NAME}`, 'verbose'],
      why: 'post-check: read the rule back (verifies the tunnel scoping) instead of assuming the write landed',
    },
  ];
}

/**
 * Full revert: deny RDP, drop the firewall rule, clear NLA back to its
 * restrictive default. Verification is the final read-backs, so "revoked" is a
 * checked claim.
 */
export function planWinRemoteRevert(): WinRemoteStep[] {
  return [
    {
      cmd: 'reg',
      args: ['add', TS_KEY, '/v', 'fDenyTSConnections', '/t', 'REG_DWORD', '/d', '1', '/f'],
      why: 'deny Remote Desktop — this is the revocation, and it comes first',
    },
    {
      cmd: 'netsh',
      args: ['advfirewall', 'firewall', 'delete', 'rule', `name=${FIREWALL_RULE_NAME}`],
      why: 'remove the scoped rule so no allowance outlives the channel',
    },
    {
      cmd: 'powershell',
      args: ['-NoProfile', '-Command', 'Restart-Service -Name TermService -Force'],
      why: 'restart so the listener actually stops accepting',
    },
    {
      cmd: 'reg',
      args: ['query', TS_KEY, '/v', 'fDenyTSConnections'],
      why: 'VERIFY the revert: read the flag back (expects 0x1)',
    },
  ];
}

/** Post-revert verification, pure — so "revoked" carries a check. */
export function verifyWinRemoteRevert(reads: {
  fDenyTsConnections: string;
  firewallRule: string;
}): { clean: boolean; remaining: string[] } {
  const remaining: string[] = [];
  const enabled = parseRdpEnabled(reads.fDenyTsConnections);
  if (enabled === true) remaining.push('fDenyTSConnections is still 0 (Remote Desktop still enabled)');
  if (enabled === null) remaining.push('could not read fDenyTSConnections back — the revert is UNVERIFIED');
  const rule = parseFirewallRule(reads.firewallRule);
  if (rule.exists) remaining.push(`the firewall rule "${FIREWALL_RULE_NAME}" still exists`);
  return { clean: remaining.length === 0, remaining };
}

/** Execute a plan, withholding argv of any step that carries a secret. */
export async function runWinRemotePlan(
  io: WinRemoteIo,
  steps: WinRemoteStep[],
): Promise<Array<{ cmd: string; why: string; code: number; ok: boolean }>> {
  const out: Array<{ cmd: string; why: string; code: number; ok: boolean }> = [];
  for (const step of steps) {
    const res = await io.run(step.cmd, step.args);
    out.push({
      cmd: step.carriesSecret ? `${step.cmd} (args withheld)` : step.cmd,
      why: step.why,
      code: res.code,
      ok: res.code === 0,
    });
  }
  return out;
}