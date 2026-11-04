/**
 * PRE-LOGIN REFUSAL NOTICE — the two-question refusal (ticket c468f922, OWNER
 * RULING 2026-10-30 on card oq_b5118c38: "can we do option three but a little
 * more secure like how it's just like TeamViewer").
 *
 * WHY THIS IS A SEPARATE PURE LEAF. The refusal used to be one interpolated
 * string inside `runComputerAgentSession` (a 1000-line function that reaches
 * for the driver, the lock, the vision seat and the SSE stream). A string that
 * cannot be called cannot be TESTED — any assertion about it degrades to a
 * regex over the source file, which passes on a comment and cannot tell the
 * three branches apart. Pulling the notice out as a pure function is what lets
 * the branches be pinned by CALLING them.
 *
 * THE BUG CLASS THIS ENCODES AWAY (found by review of PR #2129, which shipped
 * the typed three-state health line but left the refusal branching on
 * `prelogin.blockedNow` alone): a locked device with a WORKING hardened remote
 * channel read EXACTLY like a locked device with no path at all. Both emitted
 * "Do NOT retry … until it is unlocked", so the operator was sent to walk to a
 * machine they could have reached remotely — and a scheduler had no way to tell
 * "this device is genuinely unreachable, drop the work" from "this device is
 * reachable, use the channel". Two different dead ends, one message.
 *
 * THE ASYMMETRY THAT MUST NOT BE FLATTENED. `remoteAccess.ready === false` is
 * NOT "broken": `off` is the HEALTHY default on every ordinary device (nobody
 * opted in, and `computer_task` never needed a listener). So this module
 * NAMES the state and never claims a fault — and it never turns `off` into a
 * refusal of its own: refusing `computer_task` because remote access is off
 * would break normal computer use on every device in the fleet. The refusal
 * happens because the device is at a login screen; the channel only decides
 * which sentence follows.
 *
 * Deliberately pure: no Prisma / Redis / logger / driver import, so it is
 * importable from a test with no harness and cannot drift from the loop that
 * calls it (one definition, one caller).
 */

import type { RemoteChannelState } from '../imessage/remote-access-verdict';

/** The slice of the verdict this notice reads. Structurally a subset of
 *  `RemoteAccessVerdict`, so the loop can pass its value straight through —
 *  and a test can build one without inventing the invariants the real verdict
 *  function enforces. */
export interface RemoteAccessForRefusal {
  state: RemoteChannelState;
  ready: boolean;
  reason: string;
}

/**
 * Strip a leading `<state> — ` from a verdict reason. The verdict's own reason
 * strings for `off` and `unavailable` are themselves prefixed (REMOTE_OFF_REASON
 * starts `off — `, the unknown reason starts `unavailable — `), so a naive
 * template renders `remoteAccess: off — off — brokered…`. Cosmetic, but this
 * text is read by an operator under pressure; a doubled token reads like a bug.
 */
function stripStatePrefix(reason: string, state: string): string {
  const prefix = `${state} — `;
  return reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

/**
 * The sentence that distinguishes the two dead ends. Exported separately so a
 * caller (or a test) can assert the channel half without re-deriving the rest
 * of the notice.
 *
 * THE TRAP THIS FUNCTION MUST NOT FALL INTO (found by independent review of
 * PR #2139, which shipped the first version of it): the `on` branch originally
 * read "reach the device through it instead of waiting for a physical unlock".
 * That is an instruction a lane CANNOT carry out — Digby ships no RFB/VNC/RDP
 * client (see remote-access-verdict.ts:61 "it does not ship a VNC/RFB or RDP
 * client", and types.ts:218 "still NO — no RFB/RDP client"). Telling a lane to
 * "reach it through the channel" re-creates the exact c468f922 bug class: a
 * message that sends a lane down a path that cannot work, so it burns runs
 * discovering that. The channel is an OPERATOR fact, not a capability of the
 * run being refused — so this line says who can use it, and never implies the
 * lane can.
 */
export function preloginChannelLine(remote: RemoteAccessForRefusal | undefined): string {
  // `ready` is a sound proxy for "the channel is on": remoteAccessVerdict() has
  // exactly ONE `ready: true` return and it carries `state: 'on'` (tunnel-bound
  // and blocker-free). Asserted by test so a future verdict branch cannot add a
  // second green without this being revisited.
  if (remote?.ready) {
    return (
      ' A hardened remote channel IS enabled on this device (remoteAccess: on) — an' +
      ' OPERATOR can reach the login window through it.' +
      ' This run cannot: no RFB/RDP client ships, so computer_task still cannot land' +
      ' input here. Escalate to the owner; do not retry it as a computer_task.'
    );
  }
  const state = remote?.state ?? 'unavailable';
  const raw = remote?.reason || '';
  const why = raw ? stripStatePrefix(raw, state) : '';

  // `off` is the HEALTHY default — the whole point of the three-state line. It
  // must never be framed as a deficiency ("not available either"), because that
  // reading is what nags an operator to switch a listening service on for a
  // device that is correctly off.
  //
  // The reason is deliberately NOT appended here: REMOTE_OFF_REASON already
  // restates exactly this ("not enabled … nothing is listening; that is the
  // default"), so appending it produced a sentence that said "not enabled"
  // twice. The full reason still reaches the caller on `remoteAccess.reason`,
  // so nothing is lost — this line just stops duplicating it.
  if (state === 'off') {
    return (
      ' Brokered remote access is OFF on this device (remoteAccess: off) — that is the' +
      ' healthy default, not a fault: it is opt-in per device and nobody opted in.' +
      ' Enable it for this device only if you want Digby to be able to reach it while' +
      ' it is locked.'
    );
  }
  const sentence = why || 'the device never reported one';
  return ` No hardened remote channel is available (remoteAccess: ${state}) — ${sentence}.`;
}

/**
 * Build the full refusal. Never throws, never mentions a credential, and always
 * carries the `prelogin_input: <status>` marker a lane greps for.
 */
export function preloginRefusalNotice(input: {
  /** Typed prelogin status — 'locked' on a positive lock report. */
  status: string;
  /** 'Mac' | 'Windows PC' — already resolved by the caller (it knows the platform). */
  noun: string;
  /** The prelogin module's own reason text (why input cannot land). */
  preloginReason: string;
  remoteAccess?: RemoteAccessForRefusal | undefined;
}): string {
  return (
    `COMPUTER USE BLOCKED — prelogin_input: ${input.status}. ` +
    `No screen was captured and no input was sent to the ${input.noun}. ${input.preloginReason}.` +
    preloginChannelLine(input.remoteAccess) +
    ' Do NOT retry this task against the same device until it is unlocked or the' +
    ' device preset is applied — a retry cannot land an event and only burns the run.'
  );
}