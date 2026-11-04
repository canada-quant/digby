/**
 * BROKERED REMOTE ACCESS — the hardened "drive the OS's own remote channel"
 * policy (ticket c468f922, OWNER RULING 2026-10-29 on card oq_b5118c38).
 *
 * THE OWNER'S DECISION, verbatim: "can we do option three but a little more
 * secure like how it's just like TeamViewer".
 *
 * Option 3 in the ticket was "drive the OS's own remote-access channel instead
 * of the framebuffer" — macOS Screen Sharing (`screensharingd`, launched by
 * ARDAgent's `kickstart`) and Windows Remote Desktop (`TermService`). What the
 * owner asked us to harden away is the part that makes plain option 3 weak:
 * **an inbound listening port permanently open on every device.** TeamViewer's
 * shape is the opposite — the device dials OUT to a broker we control, the
 * operator's session is brokered through that outbound path, and nothing on
 * the device's network is reachable just because the device exists.
 *
 * WHAT THIS BUILD ALREADY HAD (verified, not assumed — do not rebuild it):
 * the paired-agent channel is ALREADY outbound-only. `agent-link.ts`: "The
 * macOS agent runs on the user's own Mac (behind NAT) and 'dials home' by
 * long-polling GET /api/crossmodel/imessage/agent/poll. The backend can
 * therefore never open a connection TO the Mac." Neither agent contains an
 * inbound listener at all (grep for `createServer` / `listen(` across
 * `imessage-agent/src` and `windows-agent/src` returns nothing). So the
 * "device initiates outbound, operator is brokered" half of the TeamViewer
 * model is the existing floor — this module governs the half that does NOT
 * exist yet: the OS remote channel those brokered sessions would drive.
 *
 * THE UNCOMFORTABLE FACT THIS MODULE IS BUILT AROUND. The OS channel DOES
 * listen on a port (5900 for Screen Sharing, 3389 for RDP), and NEITHER OS
 * gives us a way to bind it to a private interface only:
 *   - macOS `kickstart` has no interface flag. Its `-targetdisk` option is a
 *     MOUNTPOINT for operating on another boot volume (verified against the
 *     authoritative flag reference, ss64.com/mac/kickstart.html) — it is not,
 *     and must never be mistaken for, an interface restriction.
 *   - Windows `fDenyTSConnections` / `TermService` likewise expose the RDP
 *     listener on all interfaces.
 * "Never publicly exposed" is therefore NOT a property of binding. It is a
 * property of the HOST FIREWALL (plus Network Level Authentication on the
 * Windows side) — which is exactly why `no-firewall` outranks almost every
 * other blocker below. A device that enables the channel without the firewall
 * rule has a public RDP/VNC port, and that is the failure this policy exists
 * to refuse.
 *
 * THE SECOND HARDENING AXIS: THE CREDENTIAL. The shipped unattended PRESET
 * stores the account password (`/etc/kcpassword` on macOS, the LSA secret on
 * Windows) because auto-login runs before any user session exists. This
 * channel needs NO such thing, and using the account password for it would be
 * strictly worse than the preset: an inbound service that accepts the user's
 * real password is a remotely-usable credential that also unlocks everything
 * else on that account. Both OSes offer a DEDICATED channel credential, so
 * that is what the policy requires:
 *   - macOS: a VNC password (`kickstart -configure -clientopts -setvncpw
 *     -vncpw <pw>` with `-setvnclegacy -vnclegacy yes`) — a separate secret
 *     that authenticates AT the login window and grants none of the account's
 *     other powers.
 *   - Windows: a dedicated local account used only for brokered RDP, with NLA
 *     required (`UserAuthentication=1`).
 * `account-password` below exists to catch a device configured the other way.
 *
 * SCOPE — WHAT THIS MODULE DOES NOT DO (state it plainly, never imply it):
 * it does not ship a VNC/RFB or RDP client, and it does not make
 * `computer_task` able to type at a login window. A hardened channel an
 * OPERATOR (or a future brokered session) can drive is not the same fact as
 * "computer_task lands input on the secure desktop". That is why
 * `prelogin-capability.ts` keeps reporting `unavailable` for computer_task and
 * exposes the channel as its OWN typed fact — two different questions, two
 * different answers, so no lane acts on a merged half-truth.
 *
 * ABSENT-NEVER-CLOBBERS, the house contract: a poll with no `remoteaccess`
 * param (every agent that shipped before this change) advertises NOTHING,
 * `normalizeRemoteAccess()` returns undefined, and the stored row is left
 * untouched. Unknown tokens are DROPPED (a newer agent may report a blocker
 * this backend has not learned — it must never break the poll and must never
 * read as a false "ready").
 *
 * Pure leaf: no Prisma / Redis / logger imports, so the device list, the
 * computer loop and the agents' own planners answer from ONE definition.
 */

/** Wire state marks. `on` = the channel is enabled; `tunnel` = the operator
 *  path is the brokered outbound tunnel (the TeamViewer property the owner
 *  asked for); `off` = the agent POSITIVELY PROVED nothing is listening.
 *  Everything else is a BLOCKER. */
export const REMOTE_ON = 'on';
export const REMOTE_TUNNEL = 'tunnel';

/**
 * `off` — the agent POSITIVELY PROVED the channel is not listening (owner
 * ruling 2026-10-30, health-line item 2 of the security contract: the product
 * must show "off / on / unavailable", three states, not two).
 *
 * WHY THIS TOKEN HAS TO EXIST. Before it, a device whose channel was
 * deliberately OFF advertised NOTHING (the param was omitted), and the backend's
 * absent-never-clobbers rule then answered with whatever row was already
 * stored. Two consequences, both measured on this codebase:
 *
 *   1. HONEST OFF READ AS "TOO OLD TO REPORT". A correctly-configured device
 *      that simply never opted in got the `undefined` verdict — "the agent on
 *      this device never reported brokered remote access (update the agent,
 *      then run `remote-access enable`)". That is the exact OPPOSITE of the
 *      ownership posture: it tells an operator to switch a LISTENING SERVICE ON
 *      as a remedy for a device that is healthy precisely because it is off.
 *
 *   2. A VERIFIED REVOKE LEFT A FALSE GREEN. `disable` writes `enabled:false`
 *      locally and then advertises nothing, so the last stored row —
 *      `{enabled:true,tunnelOnly:true,blockers:[]}` — survived, and the fleet
 *      kept reporting `ready:true` on a box whose listener, firewall anchor and
 *      credential had just been removed and read back gone. A green that
 *      outlives the revoke is a worse failure than the exposure it hides,
 *      because the revoke is the control.
 *
 * THE ONE RULE THAT MAKES `off` SAFE: it is emitted from a LIVE PROBE, never
 * from local config. A device whose config says "disabled" but whose OS says
 * the service IS listening must advertise `on` + `exposed`, so a listener
 * somebody switched on by hand (macOS System Settings → Screen Sharing) is
 * VISIBLE rather than silently absent. `off` therefore means "probed and not
 * listening", which is the only reading under which it may clear a stored
 * green. An UNPROVABLE probe still emits nothing — absence stays honest.
 */
export const REMOTE_OFF = 'off';

/** The typed health state of one device's remote channel — the owner's
 *  "off / on / unavailable", plus `blocked` for "on but not safely usable".
 *  A lane reads THIS, not a boolean. */
export type RemoteChannelState = 'off' | 'on' | 'blocked' | 'unavailable';

/**
 * The reason for the PROVED-OFF state. Deliberately does NOT say "enable it":
 * this is the healthy default posture (opt-in, nothing listening), and telling
 * an operator to switch a listening service on as a remedy for a correctly-off
 * device is the nag this state exists to end. It names the one step an owner
 * takes only when they WANT the channel.
 */
export const REMOTE_OFF_REASON =
  'off — brokered remote access is not enabled on this device and nothing is listening; that is the default. Turn it on for this device only if you want Digby to be able to reach it while it is locked';

/** The OS channel a device is advertising. Chosen per platform, never by the
 *  caller — a Mac has no RDP and a Windows PC has no Screen Sharing. */
export type RemoteChannel = 'macos-screen-sharing' | 'windows-rdp';

/** Every blocker an agent may advertise, with the ONE line the fleet renders.
 * PRIORITY ORDER — a device that is exposed to the public internet outranks
 * every configuration nag, because it is a live security hole rather than a
 * setup step, and a channel that accepts the ACCOUNT password outranks a
 * missing nicety because it silently widens what a stolen secret unlocks. */
export const REMOTE_BLOCKER_PRIORITY: ReadonlyArray<{ token: string; reason: string }> = [
  {
    token: 'exposed',
    reason:
      'the remote-access port is reachable from beyond the tunnel — this is a PUBLIC listening service; disable it now (revoke) and re-enable only once the host firewall restricts the port to the tunnel interface',
  },
  {
    token: 'account-password',
    reason:
      'the channel is configured with the ACCOUNT password instead of a dedicated channel credential — revoke and re-enable with the dedicated credential; an inbound service that accepts the login password also unlocks everything else on that account',
  },
  {
    token: 'no-firewall',
    reason:
      'no host firewall rule restricts the remote-access port — the OS cannot bind these services to one interface, so the firewall is the ONLY thing keeping the port off the network; add it before enabling',
  },
  {
    token: 'no-nla',
    reason:
      'Remote Desktop is enabled without Network Level Authentication — Windows would accept pre-authentication connections; require NLA (UserAuthentication=1)',
  },
  {
    token: 'no-cred',
    reason:
      'no dedicated channel credential is provisioned — the service cannot authenticate an operator before a user session exists, so a login-window session would be refused',
  },
  {
    token: 'no-tunnel',
    reason:
      'the device has no brokered-tunnel binding — enabling the OS channel without it would leave the port listening for anyone on the network rather than reachable only through the operator tunnel',
  },
  {
    token: 'stale',
    reason:
      'a brokered session outlived its window — the channel stays authenticated past the session that opened it; revoke and re-enable to clear it',
  },
];

const REMOTE_BLOCKER_TOKENS: ReadonlySet<string> = new Set(REMOTE_BLOCKER_PRIORITY.map((b) => b.token));

/** The stored / advertised shape (imessage_agents.remote_access JSONB). */
export interface RemoteAccessAdvert {
  /** The user enabled it on this device. */
  enabled: boolean;
  /** True when the operator path is the outbound brokered tunnel (the
   *  TeamViewer property). A device that never says so is NOT tunnel-only. */
  tunnelOnly: boolean;
  /** Blocker tokens the agent detected on its LAST pass, agent order. */
  blockers: string[];
  /** The agent POSITIVELY PROVED nothing is listening (see REMOTE_OFF). Only
   *  ever set by a live probe that could read the listener state, never by a
   *  config flag — and never alongside `enabled`. */
  off?: boolean;
}

/** The fleet-facing verdict a lane reads before claiming a pre-login path
 *  exists on this device. */
export interface RemoteAccessVerdict {
  /** The typed health line — the owner's "off / on / unavailable", with
   *  `blocked` for enabled-but-not-safely-usable. Read THIS, not `ready`
   *  alone: `off` is a HEALTHY state, and a consumer that treats it as a
   *  failure will nag the owner to turn a listener on. */
  state: RemoteChannelState;
  /** The user enabled it on this device (opt-in, per device). */
  enabled: boolean;
  /** The operator reaches it only through the brokered outbound tunnel. */
  tunnelOnly: boolean;
  /** YES = a hardened channel exists that an operator/brokered session can
   *  use to reach the login window. NEVER true for a device that advertises
   *  nothing — unknown is not ready. */
  ready: boolean;
  /** The ONE reason when ready is false; '' when ready. */
  reason: string;
}

/**
 * THE HARDENING CONTRACT, in one place, so the installer UI, the device
 * planners and the docs cannot drift from the verdict. Each entry names the
 * requirement and the blocker token that reports it as unmet. Ordered the way
 * the requirements must be satisfied: the exposure boundary first, then the
 * credential, then the transport binding.
 */
export const REMOTE_HARDEN_REQUIREMENTS: ReadonlyArray<{
  id: string;
  requirement: string;
  blocker: string;
}> = [
  {
    id: 'exposure',
    requirement: 'the port is unreachable from outside the tunnel; verified by probing the port from off-device, not just by trusting the rule',
    blocker: 'exposed',
  },
  {
    id: 'firewall',
    requirement: 'a host firewall rule scopes the port (macOS pf / socketfilterfw; Windows Defender Firewall) — the OS offers no bind-to-interface option',
    blocker: 'no-firewall',
  },
  {
    id: 'credential',
    requirement: 'a DEDICATED channel credential (never the account password): macOS VNC password, Windows a brokered-only local account',
    blocker: 'account-password',
  },
  {
    id: 'credential-present',
    requirement: 'the dedicated credential is actually provisioned, so a pre-login session can authenticate',
    blocker: 'no-cred',
  },
  {
    id: 'nla',
    requirement: 'Windows only: Network Level Authentication required, so the host authenticates before allocating a session',
    blocker: 'no-nla',
  },
  {
    id: 'transport',
    requirement: 'the operator path is the brokered outbound tunnel — the device dials out; it never waits for an inbound operator connection',
    blocker: 'no-tunnel',
  },
  {
    id: 'session-window',
    requirement: 'every brokered session is time-boxed and closes with the session that opened it',
    blocker: 'stale',
  },
];

/** The platform's channel. Total by construction — an unknown platform is
 *  treated as macOS, matching `agentPlatform()`'s legacy-rows-are-Macs rule. */
export function remoteChannelFor(platform: string | null | undefined): RemoteChannel {
  return platform === 'windows' ? 'windows-rdp' : 'macos-screen-sharing';
}

/** The port the channel listens on. Used by the exposure check and by the
 *  docs table; macOS Screen Sharing = 5900 (RFB), Windows RDP = 3389. */
export function remoteChannelPort(channel: RemoteChannel): number {
  return channel === 'windows-rdp' ? 3389 : 5900;
}

/**
 * Normalize the poll query param / pair-body value into the advert shape.
 *
 * Accepts a comma list ('on,tunnel'), an array (pair body), or the stored
 * object round-tripped back. Returns `undefined` when NOTHING recognisable was
 * advertised — the absent-never-clobbers contract (an empty / garbage advert
 * must never wipe a stored verdict, and must never read as "not configured"
 * when the truth is "this agent cannot report").
 */
export function normalizeRemoteAccess(raw: unknown): RemoteAccessAdvert | undefined {
  if (raw === null || raw === undefined) return undefined;
  let tokens: string[] = [];
  let explicitEnabled: boolean | undefined;
  let explicitTunnel: boolean | undefined;
  let offExplicit = false;
  if (typeof raw === 'string') {
    tokens = raw.split(',');
  } else if (Array.isArray(raw)) {
    tokens = raw.filter((t): t is string => typeof t === 'string');
  } else if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.enabled === 'boolean') explicitEnabled = o.enabled;
    if (typeof o.tunnelOnly === 'boolean') explicitTunnel = o.tunnelOnly;
    // A stored row round-tripped back carries the proved-off fact as a boolean,
    // not a token — read it as one so the state survives storage.
    if (o.off === true) offExplicit = true;
    // A stored row carries `blockers`; a wire object may carry `tokens`.
    if (Array.isArray(o.blockers)) tokens = o.blockers.filter((t): t is string => typeof t === 'string');
    else if (Array.isArray(o.tokens)) tokens = o.tokens.filter((t): t is string => typeof t === 'string');
    else return undefined;
  } else {
    return undefined;
  }

  const seen = new Set<string>();
  let enabled = explicitEnabled === true;
  let tunnelOnly = explicitTunnel === true;
  // A stored row's boolean `off` and a wire `off` token are the same claim.
  let off = offExplicit;
  for (const rawToken of tokens) {
    const token = String(rawToken).trim().toLowerCase();
    if (!token) continue;
    if (token === REMOTE_ON) { enabled = true; continue; }
    if (token === REMOTE_TUNNEL) { tunnelOnly = true; continue; }
    if (token === REMOTE_OFF) { off = true; continue; }
    if (REMOTE_BLOCKER_TOKENS.has(token)) seen.add(token);
  }
  // `on` and `off` are mutually exclusive claims about the same listener. A
  // wire value carrying BOTH is self-contradictory, and the safe reading of
  // "it might be listening" is the ENABLED one — off must never be able to
  // clear a green, so enabled wins any conflict.
  if (enabled) off = false;
  // Nothing advertised at all ⇒ undefined (never clobber, never false-ready).
  if (explicitEnabled === undefined && explicitTunnel === undefined && !off && !enabled && !tunnelOnly && seen.size === 0) {
    return undefined;
  }
  // Blocker tokens are emitted in PRIORITY order so the stored JSONB is stable
  // across agents (and a human reading the row sees the deciding one first).
  const blockers = REMOTE_BLOCKER_PRIORITY.map((b) => b.token).filter((t) => seen.has(t));
  return { enabled, tunnelOnly, blockers, ...(off ? { off: true } : {}) };
}

/**
 * The verdict. `ready` is true ONLY for an ENABLED, TUNNEL-BOUND device with
 * no blockers. Unknown is never ready: a lane must not assume a device it
 * knows nothing about offers a pre-login path — that assumption is what burned
 * four runs on the deerland lane before the typed capability existed.
 */
export function remoteAccessVerdict(advert: RemoteAccessAdvert | null | undefined): RemoteAccessVerdict {
  if (!advert) {
    return {
      // 'unavailable' and NOT 'off': nobody reported anything, so we cannot
      // claim the channel is down. The distinction is the whole point of the
      // health line — an agent too old to report must not look like a device
      // the owner deliberately left off.
      state: 'unavailable',
      enabled: false,
      tunnelOnly: false,
      ready: false,
      reason:
        'unavailable — the Digby agent on this device never reported a remote channel, so the fleet cannot say whether one is listening; update the agent, then check `remote-access status` on the device',
    };
  }
  // `off` is a POSITIVELY PROVED not-listening state: healthy, and the ONLY
  // state whose reason may not nag the owner to switch a listener on.
  if (advert.off && !advert.enabled) {
    return {
      state: 'off',
      enabled: false,
      tunnelOnly: false,
      ready: false,
      reason: REMOTE_OFF_REASON,
    };
  }
  if (!advert.enabled) {
    return {
      state: 'off',
      enabled: false,
      tunnelOnly: advert.tunnelOnly,
      ready: false,
      reason: 'brokered remote access is not enabled on this device — it is opt-in, per device, off by default',
    };
  }
  const first = REMOTE_BLOCKER_PRIORITY.find((b) => advert.blockers.includes(b.token));
  if (first) {
    return { state: 'blocked', enabled: true, tunnelOnly: advert.tunnelOnly, ready: false, reason: first.reason };
  }
  // An enabled channel the agent did NOT declare tunnel-bound is a public
  // listener as far as the fleet can prove — fail closed rather than assume
  // the better property. The agent must positively advertise `tunnel`.
  if (!advert.tunnelOnly) {
    return {
      state: 'blocked',
      enabled: true,
      tunnelOnly: false,
      ready: false,
      reason:
        'the channel is enabled but the device did not advertise the brokered-tunnel binding — the fleet cannot prove the port is unreachable from the network, so it is treated as exposed until the agent reports `tunnel`',
    };
  }
  return { state: 'on', enabled: true, tunnelOnly: true, ready: true, reason: '' };
}

/** Convenience for a stored row: normalize then verdict. Never throws. */
export function remoteAccessReadyFor(
  agent: { remoteAccess?: unknown } | null | undefined,
): RemoteAccessVerdict {
  return remoteAccessVerdict(
    normalizeRemoteAccess((agent as { remoteAccess?: unknown } | null | undefined)?.remoteAccess),
  );
}

/**
 * The advert VALUE an agent sends on the poll.
 *
 * Structurally cannot leak a credential: it emits ONLY tokens drawn from the
 * closed vocabulary above plus the caller's state marks. A VNC password or an
 * RDP credential passed in by accident has nowhere to go, which is the
 * property criterion 5 ("no credential is ever logged, echoed into a chat, or
 * committed") needs at the one place the advert is built. Pinned by test.
 */
export function remoteAccessAdvertValue(
  advert: Pick<RemoteAccessAdvert, 'enabled' | 'tunnelOnly' | 'blockers'> & { off?: boolean },
): string {
  const out: string[] = [];
  if (advert.enabled) out.push(REMOTE_ON);
  // `on` wins a conflict, always: an ambiguous advert must never be able to
  // clear a stored green (see normalizeRemoteAccess).
  else if (advert.off) out.push(REMOTE_OFF);
  if (advert.tunnelOnly) out.push(REMOTE_TUNNEL);
  for (const token of REMOTE_BLOCKER_PRIORITY) {
    if (advert.blockers.includes(token.token)) out.push(token.token);
  }
  return out.join(',');
}

/** The reason text for a single token (agent-facing self-check + tests). */
export function reasonForRemoteBlocker(token: string): string {
  return REMOTE_BLOCKER_PRIORITY.find((b) => b.token === token)?.reason ?? '';
}