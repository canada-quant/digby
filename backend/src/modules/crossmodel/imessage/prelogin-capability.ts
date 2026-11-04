/**
 * PRE-LOGIN INPUT — the typed capability a dispatch lane reads BEFORE it
 * spends a run on a device that cannot be driven (ticket c468f922).
 *
 * THE PROBLEM THIS SOLVES. macOS puts the login window in a separate security
 * context: an app running INSIDE a logged-in user session is deliberately not
 * permitted to post events to `loginwindow`, and the Windows secure desktop
 * (lock screen / UAC) is likewise unreachable from a user-session process. So
 * a `computer_task` aimed at a locked device cannot land input at all. Observed
 * live 2026-10-28 on `cql-stanne-mbp1` (agent v0.9.11) at the login screen:
 * 0 input accepted, refusedRepeats=0 / noChangeStrikes=0 — an OS-level refusal
 * that reads exactly like "the agent is stuck", so the lane retried instead of
 * failing fast and the deerland Amplify lane burned 4+ runs on it.
 *
 * WHAT THIS MODULE IS NOT. It does not MOVE the boundary. Delivering input
 * before a user session exists needs a privileged helper (a root LaunchDaemon
 * on macOS, a LocalSystem service on Windows) that this build does not ship;
 * `available` is therefore `false` today, stated as a typed fact rather than
 * implied by a hung loop. When such a helper ships, the helper's own install
 * probe flips `available` — the shape is already the thing lanes read.
 *
 * TWO DISTINCT FACTS, deliberately not collapsed:
 *   - `available`   — a CONFIGURATION capability: can this device ever accept
 *                     input pre-login? false for every device in this build.
 *   - `blockedNow`  — a LIVE fact: is the console sitting at a lock/login
 *                     screen at this moment? Comes from the agent's own probe
 *                     (`atLoginScreen` on macOS, `query user` on Windows) and
 *                     rides the poll as the `locked` blocker token, so it is
 *                     reported whether or not the user opted into the
 *                     unattended preset — a locked device is locked either way.
 *
 * A device that never advertised the preset (every pre-2026-10-28 agent) has
 * `blockedNow: false` — an honest unknown, never a fabricated refusal. Only a
 * POSITIVE lock report refuses a run; silence never does.
 *
 * Pure leaf: no Prisma / Redis / logger, so account-tools (the scheduler's
 * device list), the driver selection and the computer loop all answer from ONE
 * definition.
 */

import { normalizeUnattended } from './unattended-verdict';
import { preloginHelperReadyFor } from './prelogin-helper';

/** The typed capability marker a lane greps for in a tool result. */
export const PRELOGIN_INPUT = 'prelogin_input';

/**
 * THE CREDENTIAL MODEL — settled by the OWNER, not by this module
 * (owner ruling 2026-11-01 on card oq_96b31bed: "(d) + (b) together —
 * recommended", answering ticket c468f922).
 *
 * (d) + (b) together means: keep the "Unattended / Autonomous use" preset as the
 * DEFAULT posture so a device does not idle to a lock screen at all (that is
 * (b), already built — see unattended-verdict.ts), AND add a privileged
 * pre-login helper for the genuinely-locked case (that is (d), NOT built yet).
 *
 * What the owner REJECTED is the important half, and it is binding on every
 * future lane that touches this area: option (a) — a helper holding the login
 * password in the root Keychain — was explicitly NOT chosen. So:
 *
 *   1. NO STORED OS LOGIN PASSWORD. Ever. Not in the root Keychain, not in
 *      /etc/kcpassword, not in a service config, not in this backend, not on
 *      the wire. The password is typed by the human only when the device is
 *      actually locked — which is what TeamViewer really does (its "Easy
 *      Access" stores no OS password either; the operator types it).
 *   2. A helper buys CAPABILITY ONLY: the ability to render and post input at
 *      the login window. Capability and credential custody are separable, and
 *      the owner chose the separation. A helper that ships with a stored
 *      credential contradicts this ruling and must be rejected in review.
 *   3. The consequence, stated honestly so no lane "fixes" it away: a 3am
 *      autonomous run against a device that is genuinely at the login window
 *      still WAITS for a human. That is the accepted cost of the ruling, not a
 *      bug to work around by adding a stored secret later.
 *
 * This constant exists so the ruling has ONE citable definition in the tree
 * rather than living only in a card and a doc paragraph — `preloginInputFor`
 * and every helper-facing surface read it from here. Pinned by
 * prelogin-credential-model.c468f922.test.ts.
 */
export const PRELOGIN_CREDENTIAL_MODEL = 'owner-typed-never-stored' as const;

/** The decision shape the credential model encodes: a privileged helper MAY
 *  post input at the login window, but MUST NOT hold the OS login password. */
export interface PreloginCredentialPolicy {
  /** A privileged helper may be installed (opt-in, per device, revocable). */
  privilegedHelper: true;
  /** …but it may never persist the user's OS login password. */
  storesOsPassword: false;
  /** The human supplies the password, at the moment the device is locked. */
  passwordSource: 'human-on-demand';
  /** The (b) half: the unattended preset is the default posture. */
  unattendedPresetDefault: true;
}

/** The ruling as data, so a caller can act on it instead of parsing prose. */
export const PRELOGIN_CREDENTIAL_POLICY: PreloginCredentialPolicy = {
  privilegedHelper: true,
  storesOsPassword: false,
  passwordSource: 'human-on-demand',
  unattendedPresetDefault: true,
};

/** The blocker token the agents emit when the console is at a lock/login
 *  screen right now (see `unattended-verdict.ts` BLOCKER_PRIORITY and both
 *  agents' snapshot probes). */
const LOCKED_TOKEN = 'locked';

/** Everything this module needs from a paired-agent row. */
export interface PreloginAgentLike {
  unattended?: unknown;
  /** The agent-advertised helper advert (ticket c468f922, option (d)).
   *  Absent ⇒ a legacy agent that never reported it ⇒ `unavailable`. */
  preloginHelper?: unknown;
  /** Platform narrows the wording only — the boundary exists on both. */
  platform?: string | null;
}

export interface PreloginInputCapability {
  /** 'available' ⇒ a privileged pre-login helper is installed AND loaded on
   *  this device, so input CAN be posted at the login window. A typed string
   *  (not a boolean) so the wire value is self-describing in a tool result. */
  status: 'available' | 'unavailable';
  /** true ⇒ the console is at a lock/login screen right now AND signing in
   *  still needs the login password typed by a human (never stored). */
  blockedNow: boolean;
  /** The ONE sentence a lane acts on. Names what is true and what to do. */
  reason: string;
}

/** The single reason string for "this device is sitting at a lock screen and
 *  has no helper". */
export const PRELOGIN_LOCKED_REASON =
  'the device is at a lock / login screen right now — no pre-login helper is installed on this device, so Digby cannot type there; dispatch work that needs input would burn the run without landing a single event; unlock the device once, or enable the device preset ("Unattended / Autonomous use") so the session never ends';

/** The reason for the standing (not-currently-locked) case on a device whose
 *  user has NOT opted into the preset — actionable, because enabling it is the
 *  fix. */
export const PRELOGIN_STANDING_REASON =
  'pre-login input is unavailable on this device (no pre-login helper installed): a locked or signed-out device cannot be driven, so a device that can end up at a login screen should have the "Unattended / Autonomous use" preset enabled';

/** The reason for a device that HAS the preset enabled and is not locked now.
 *  Deliberately NOT a nag: `unattendedReady` already owns "is this device set
 *  up", and repeating "enable the preset" at a device that enabled it is the
 *  card-spam class the verdict module exists to end. */
export const PRELOGIN_OPTED_IN_REASON =
  'pre-login input is unavailable on this device (no pre-login helper installed) — the device preset keeps the session alive, so the console does not reach a lock screen';

/** The reason for a device whose helper IS installed and loaded (option (d)
 *  shipped) and which is not locked right now. */
export const PRELOGIN_HELPER_READY_REASON =
  'the pre-login helper is installed and loaded on this device — it can render and post input at the login window; the login password is typed by a human at the Mac and is never stored';

/** The reason for a device whose helper is installed and loaded BUT which is
 *  sitting at a login screen right now — the exact accepted cost of the
 *  owner's ruling, stated so no lane reads it as a bug to work around. */
export const PRELOGIN_HELPER_READY_LOCKED_REASON =
  'the device is at a lock / login screen right now and the pre-login helper is installed and loaded — Digby can render that screen and post input there, but signing IN needs the login password typed by a human at the Mac (never stored); prepare what you can, but do not expect to get past the password unattended';

/**
 * The capability for one paired device. Never throws; garbage resolves to an
 * honest unknown (available:false, blockedNow:false) rather than a refusal.
 *
 * COMPOSITION, one-way: the (d) half comes from `prelogin-helper.ts`, whose
 * verdict is the real probe result the agent advertised. `status` is
 * 'available' only when a helper is installed AND loaded AND no blocker is
 * set — and the verdict itself refuses ready while the owner's policy says a
 * helper may hold an OS credential, so option (a) can never read as ready.
 *
 * The wire shape stays EXACTLY status/blockedNow/reason. That is not
 * incidental: with no fourth slot, a future helper cannot start shipping a
 * credential, a session token or a password hint on this capability without
 * failing prelogin-credential-model.c468f922.test.ts.
 */
export function preloginInputFor(
  agent: PreloginAgentLike | null | undefined,
): PreloginInputCapability {
  const advert = normalizeUnattended(agent?.unattended);
  const lockedNow = !!advert && advert.blockers.includes(LOCKED_TOKEN);
  const helper = preloginHelperReadyFor(agent, PRELOGIN_CREDENTIAL_POLICY);

  if (helper.ready) {
    return {
      status: 'available',
      blockedNow: lockedNow,
      reason: lockedNow ? PRELOGIN_HELPER_READY_LOCKED_REASON : PRELOGIN_HELPER_READY_REASON,
    };
  }
  // No usable helper. A blocked helper (credential custody, unsigned, not
  // loaded…) outranks the generic standing line, because its reason names the
  // actual remedy. A device that never advertised falls through to the
  // standing/opted-in wording.
  const standingReason = advert?.enabled ? PRELOGIN_OPTED_IN_REASON : PRELOGIN_STANDING_REASON;
  const helperReason = helper.state === 'blocked' ? helper.reason : '';
  return {
    status: 'unavailable',
    blockedNow: lockedNow,
    reason: lockedNow ? PRELOGIN_LOCKED_REASON : helperReason || standingReason,
  };
}

/**
 * Convenience for surfaces that carry a capability and want the one-line marker
 * a lane can grep: `prelogin_input: unavailable (…reason…)`.
 */
export function preloginInputMarker(cap: PreloginInputCapability): string {
  return `${PRELOGIN_INPUT}: ${cap.status} (${cap.reason})`;
}