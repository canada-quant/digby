/**
 * "Unattended / autonomous use" device preset — the FLEET-SIDE verdict
 * (2026-10-28, owner request on card oq_f7955582: "how can you fix this for all
 * mac and windows clients to give full remote login permissions etc as this
 * will be a requirement for most users to use their remote devices
 * autonomously").
 *
 * THE PROBLEM THIS SOLVES. Three separate owner cards in one day asked for the
 * same single physical act — unlock mbp-1 at the macOS login screen — because
 * macOS puts the login window BELOW every TCC permission: the agent can see and
 * drive only INSIDE a logged-in session. A lane had no way to know, from the
 * device list, whether the machine it wanted could ever have been configured to
 * stay logged in. So it filed "please unlock <device>" for a device that might
 * have been fixable in one setting. That is the card spam this module ends.
 *
 * DIVISION OF LABOUR (do not duplicate the table):
 *   - The AGENTS detect facts on the box (fdesetup / defaults / pmset on macOS,
 *     registry / manage-bde / powercfg on Windows) and advertise a CLOSED
 *     vocabulary of tokens on every poll (`?unattended=on,ok` / `?unattended=on,filevault`).
 *     See imessage-agent/src/unattended.ts and windows-agent/src/unattended.ts
 *     — both carry the same token list, pinned to this file by a test.
 *   - THIS module owns normalization + the ONE-REASON verdict, i.e. the
 *     priority order in which blockers are reported. A lane reads exactly one
 *     sentence and knows what to do, instead of a checklist it must triage.
 *   - Unknown tokens are IGNORED (forward compatible: a newer agent may report
 *     a blocker this backend has not learned yet — it must never break the
 *     poll, and it must never turn into a false "ready").
 *
 * ABSENT-NEVER-CLOBBERS, the house contract: a poll without the `unattended`
 * param (pre-2026-10-28 agents, i.e. every agent that shipped before this
 * change) advertises NOTHING — normalizeUnattended() returns undefined and the
 * stored row is left untouched.
 *
 * Pure leaf: no Prisma / Redis / logger imports, so account-tools, the poll
 * controller and the integration card all answer from ONE definition.
 */

/** The wire vocabulary. `on`/`off`/`ok` are state marks; every other token is
 *  a BLOCKER the agent detected on the box. Order in BLOCKER_PRIORITY decides
 *  which single reason a lane sees first. */
export const UNATTENDED_ON = 'on';
export const UNATTENDED_OK = 'ok';
/** `off` — a POSITIVELY REPORTED "the preset is not enabled on this device"
 *  (ticket 11b6974f). It exists because an ABSENT param used to be the only way
 *  a switched-off preset could be expressed, and absent is ALSO what a legacy
 *  build emits — so "the owner never turned it on" and "this agent build cannot
 *  report it at all" were literally the same bytes on the wire, and every
 *  paired device read the second sentence regardless of the truth. With `off`
 *  on the wire the two are distinguishable: `off` = measured and not enabled;
 *  absent = unknown (never reported by this build). Mirrors
 *  remote-access-verdict.ts's `off`, and carries the same rule — `on` always
 *  wins a conflict so an ambiguous advert can never clear a stored green. */
export const UNATTENDED_OFF = 'off';

/** Every blocker token an agent may advertise, with the exact one-line reason
 *  the fleet renders. PRIORITY ORDER — a physical impossibility (FileVault,
 *  Credential Guard, BitLocker pre-boot, Hello-only) outranks a setting a user
 *  can change (lock / sleep / fast user switching), which outranks a detected
 *  drift. A device can report several; the verdict reports the first. */
export const BLOCKER_PRIORITY: ReadonlyArray<{ token: string; reason: string }> = [
  // ── Physical / cryptographic impossibilities (cannot be worked around) ──
  {
    token: 'filevault',
    reason: 'FileVault is on — macOS cannot auto-login to a FileVault volume; turn FileVault off for this Mac first',
  },
  {
    token: 'bitlocker-pin',
    reason: 'BitLocker pre-boot PIN — the PC stops at a BIOS-level PIN prompt before Windows (or the agent) starts',
  },
  {
    token: 'credguard',
    reason: 'Credential Guard / LSA protection is enabled — Windows will not let an auto-logon secret be stored',
  },
  {
    token: 'hello',
    reason: 'Windows Hello is the only allowed sign-in method — auto-logon is blocked by policy',
  },
  {
    token: 'domain-policy',
    reason: 'A domain / Intune / MDM policy overrides auto-logon on this device',
  },
  // ── Settings the preset owns but that reverted or never applied ──────────
  {
    token: 'autologin',
    reason: 'auto-login is not configured — the device will boot to a login screen the agent cannot drive',
  },
  {
    token: 'drift',
    reason: 'the preset reverted (a macOS update or a policy reset it) — re-apply it on the device',
  },
  {
    token: 'no-admin',
    reason: 'the agent lacks the administrator rights the preset needs — run the enable step on the device itself',
  },
  {
    token: 'pwd-expiry',
    reason: 'the account password has an expiry policy — an expired password on a remote device cannot be renewed remotely',
  },
  {
    token: 'fast-user',
    reason: 'fast user switching is on — after a logout or a reboot the device can land on the login window',
  },
  {
    token: 'lock',
    reason: 'the screen locks again on wake / idle — the session ends and the agent is stranded behind it',
  },
  {
    token: 'sleep',
    reason: 'the machine still sleeps — the agent goes offline until someone wakes it',
  },
  // ── Live state (not a configuration problem) ────────────────────────────
  {
    token: 'locked',
    reason: 'the device is at a lock / login screen right now — nothing can drive it until it is unlocked once',
  },
];

const BLOCKER_TOKENS: ReadonlySet<string> = new Set(BLOCKER_PRIORITY.map((b) => b.token));

/** The stored / advertised shape (imessage_agents.unattended JSONB). */
export interface UnattendedAdvert {
  /** The user opted this device in (the preset was applied at least once). */
  enabled: boolean;
  /** Blocker tokens the agent detected on its LAST pass, in agent order. */
  blockers: string[];
  /** Ticket 11b6974f: the agent POSITIVELY reported "not enabled" (`off` on
   *  the wire). Absent/false means enabled-unknown-or-on — the distinction that
   *  lets the verdict tell "the owner never switched it on" apart from "this
   *  build cannot report the preset at all". Persisted so a stored row keeps
   *  the claim across polls (absent-never-clobbers still holds: a build that
   *  emits nothing never rewrites this). */
  off?: boolean;
}

/** The typed health line, mirroring remote-access-verdict.ts's three states so
 *  the two device capabilities read the same way and a consumer cannot confuse
 *  a deliberate "off" with an unknown. */
export type UnattendedState =
  /** Measured: the preset is on and nothing blocks it. */
  | 'ready'
  /** Measured: the preset is on but the named blocker stops it. */
  | 'blocked'
  /** Measured: the preset is NOT enabled (the owner has not opted in). */
  | 'off'
  /** NOT measured: no agent build on this device ever reported the preset. */
  | 'unavailable';

/** The fleet-facing verdict a lane reads before filing any "unlock" card. */
export interface UnattendedVerdict {
  /** The typed state — read THIS for branching. `off` is a healthy, deliberate
   *  state; `unavailable` is the agent gap. `enabled:false` alone cannot tell
   *  them apart, which is exactly the defect ticket 11b6974f reported. */
  state: UnattendedState;
  /** The preset is enabled on this device (the user opted in). */
  enabled: boolean;
  /** YES = the agent can start work on this device unattended. */
  ready: boolean;
  /** The ONE reason when ready is false; '' when ready. */
  reason: string;
}

/** The exact on-device command per platform — the ONE working enable path, so
 *  the reason strings name something the owner can actually run instead of
 *  "the preset". Kept in step with the card's `unattendedEnableCmd`. */
export function unattendedEnableCmd(platform: string | null | undefined): string {
  return platform === 'windows'
    ? 'digby-win-agent unattended enable'
    : 'digby-agent unattended enable';
}

/**
 * Normalize the poll query param / pair-body value into the advert shape.
 *
 * Accepts a comma list ('on,ok'), an array (pair body), or the stored object
 * round-tripped back. Returns `undefined` when NOTHING recognisable was
 * advertised — the absent-never-clobbers contract (an empty / garbage advert
 * must never wipe a stored verdict, and must never read as "ready: no,
 * reason: 'preset not enabled'" when the truth is "this agent cannot report").
 */
export function normalizeUnattended(raw: unknown): UnattendedAdvert | undefined {
  if (raw === null || raw === undefined) return undefined;
  let tokens: string[] = [];
  let explicitEnabled: boolean | undefined;
  let offExplicit = false;
  if (typeof raw === 'string') {
    tokens = raw.split(',');
  } else if (Array.isArray(raw)) {
    tokens = raw.filter((t): t is string => typeof t === 'string');
  } else if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (typeof o.enabled === 'boolean') explicitEnabled = o.enabled;
    // A stored row round-tripped back carries the proved-off fact as a boolean,
    // not a token — read it as one so the state survives storage.
    if (o.off === true) offExplicit = true;
    if (Array.isArray(o.blockers)) tokens = o.blockers.filter((t): t is string => typeof t === 'string');
    else return undefined;
  } else {
    return undefined;
  }

  const seen = new Set<string>();
  let enabled = explicitEnabled === true;
  // A stored row's boolean `off` and a wire `off` token are the same claim.
  let off = offExplicit;
  for (const rawToken of tokens) {
    const token = String(rawToken).trim().toLowerCase();
    if (!token) continue;
    if (token === UNATTENDED_ON) { enabled = true; continue; }
    if (token === UNATTENDED_OFF) { off = true; continue; }
    if (token === UNATTENDED_OK) continue; // a state mark, not a blocker
    if (BLOCKER_TOKENS.has(token)) seen.add(token);
  }
  // `on` and `off` are mutually exclusive claims about the same preset. A wire
  // value carrying BOTH is self-contradictory, and the safe reading of "it
  // might be on" is the ENABLED one — off must never be able to clear a stored
  // green (identical rule to remote-access-verdict.ts).
  if (enabled) off = false;
  // No `on` / `off` and no blocker and no explicit flag ⇒ nothing was
  // advertised. An explicit `enabled:false` alone IS a report (a stored row
  // from a build that used the object shape), so it survives.
  if (explicitEnabled === undefined && !enabled && !off && seen.size === 0) return undefined;
  // Blocker tokens are emitted in PRIORITY order so the stored JSONB is stable
  // across agents (and a human reading the row sees the deciding one first).
  const blockers = BLOCKER_PRIORITY.map((b) => b.token).filter((t) => seen.has(t));
  const alreadyOff = !enabled && (off || explicitEnabled === false);
  return { enabled, blockers, ...(alreadyOff ? { off: true } : {}) };
}

/**
 * The verdict. `ready` is true ONLY for an enabled preset with no blockers —
 * an agent that advertises `on,ok` (or `on` with no blockers) is ready; one
 * that advertises nothing is unknown, and unknown is NEVER ready (a lane must
 * not assume a device it knows nothing about can run unattended).
 *
 * TICKET 11b6974f — WHY THERE IS A `state`. `enabled:false` used to be the ONLY
 * signal, and it covered two completely different facts: "this owner has not
 * switched the preset on" (act on the device) and "no agent build on this
 * device has ever reported the preset" (act on the agent). Every paired device
 * therefore read the second sentence — the alarm-flavoured one — no matter what
 * the owner toggled, which is precisely how the fleet lost the ability to tell
 * a human gap from a build gap. `state` makes the two explicit, and each reason
 * names the exact command to run, per platform.
 *
 * `platform` is optional so every existing caller keeps its behaviour; it only
 * selects which device command the reason text names.
 */
export function unattendedVerdict(
  advert: UnattendedAdvert | null | undefined,
  platform?: string | null,
): UnattendedVerdict {
  const cmd = unattendedEnableCmd(platform);
  if (!advert) {
    return {
      state: 'unavailable',
      enabled: false,
      ready: false,
      reason:
        `not reported — the Digby agent on this device has never reported the unattended preset, ` +
        `so the fleet cannot say whether it is on; update the agent, then run \`${cmd}\` on the device`,
    };
  }
  // `off` is a POSITIVELY REPORTED not-enabled state: healthy and deliberate,
  // so its reason must not read like a fault — it names the one command that
  // would change it.
  if (!advert.enabled) {
    return {
      state: 'off',
      enabled: false,
      ready: false,
      reason: `preset not enabled on this device — it is opt-in, per device, off by default (run \`${cmd}\` on the device to turn it on)`,
    };
  }
  const first = BLOCKER_PRIORITY.find((b) => advert.blockers.includes(b.token));
  if (first) return { state: 'blocked', enabled: true, ready: false, reason: first.reason };
  return { state: 'ready', enabled: true, ready: true, reason: '' };
}

/** Convenience for a stored row: normalize then verdict. Never throws.
 *  `platform` (optional) only picks which device command the reason names. */
export function unattendedReadyFor(
  agent: { unattended?: unknown; platform?: string | null } | null | undefined,
): UnattendedVerdict {
  const a = agent as { unattended?: unknown; platform?: string | null } | null | undefined;
  return unattendedVerdict(normalizeUnattended(a?.unattended), a?.platform);
}

/** The reason text for a single token (agent-facing self-check + tests). */
export function reasonForBlocker(token: string): string {
  return BLOCKER_PRIORITY.find((b) => b.token === token)?.reason ?? '';
}