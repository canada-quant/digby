/**
 * terminal-step-brief.ts — ticket 0973bdd7 (2026-11-01).
 *
 * A scheduled digest in a PLAIN chat burned its whole tool-round budget on the
 * data pull (Slack channel-by-channel reads under chatProfile('thinking'),
 * maxSteps 8) and reached the tools-off final turn without ever executing the
 * TERMINAL side-effect its own stored prompt mandates ("post the digest as
 * your reply, THEN call notify_user with a 1-3 line summary"). The mandate sat
 * as prose at the end of a 1,600-char instruction, so nothing in the firing
 * made it a first-class obligation — the run discovered it at the wall.
 *
 * Two separate defects, both fixed here:
 *
 *  1. BRIEF: a schedule prompt that declares an ordered terminal side-effect
 *     never surfaced it as a checklist item. renderTerminalStepBrief() emits a
 *     short [TERMINAL STEP — REQUIRED] block appended to the firing brief
 *     (schedule.service fireScheduleTarget), so the obligation and its budget
 *     rule are read BEFORE the pull rather than buried after it.
 *
 *  2. RECORD: the model's final prose asserted "Telegram ping: NOT sent" —
 *     true at finalize from the model's own view, but the PLATFORM backstop
 *     (trailing-notify-backstop, ticket 8aa5688f) delivered the ping about one
 *     second later, so the durable assistant row carried a false delivery
 *     record for two consecutive mornings. resolveTerminalStepOutcome()
 *     classifies what ACTUALLY happened (model delivered / platform delivered /
 *     neither) and the finalize records it as a loop metric, so "the owner got
 *     nothing" stops being invisible and the two delivered cases are never
 *     confused with it.
 *
 * KEEP LEAN: this module has NO logger and NO prisma on purpose (its only
 * import is the mandate detector it must share), so it unit-tests without the
 * chat-agent service's import graph — the same discipline as machine-wake.ts
 * and trailing-notify-backstop.ts.
 *
 * No kill switch: the block is purely ADDITIVE text gated on the schedule's
 * own prompt (a schedule that mandates nothing pays zero characters), and the
 * fleet is actively deleting release-kind switches rather than minting new
 * ones. The telemetry half is always-on by design.
 */

import { isQuietRunReply, scheduleMandatesTrailingNotify } from './trailing-notify-backstop';

/** The terminal side-effects this framework can name in a schedule brief. */
export type TerminalSideEffect = 'notify_user';

/**
 * Which terminal side-effect does a SCHEDULE's stored prompt declare, if any?
 *
 * Deliberately reuses scheduleMandatesTrailingNotify() rather than growing a
 * second mandate detector: that function already carries the accumulated
 * negation / prohibition / polarity-flip discipline (ten hardened rounds of
 * adversarial fixtures), and a parallel regex here would silently drift from
 * it — the exact class where a "then do NOT notify" prohibition starts pinging.
 * Returns null when the prompt declares no terminal side-effect (the brief
 * block is then not emitted at all).
 */
export function declareTerminalStep(prompt: string): TerminalSideEffect | null {
  if (!prompt) return null;
  return scheduleMandatesTrailingNotify(prompt) ? 'notify_user' : null;
}

/** The human label used inside the rendered checklist line. */
function sideEffectLabel(effect: TerminalSideEffect): string {
  return effect === 'notify_user' ? 'send the notify_user summary (the owner-facing ping)' : effect;
}

/**
 * Render the firing-brief checklist block for a declared terminal step.
 *
 * Appended (never prepended) by the caller — the schedule-service contract:
 * prompt HEAD is read by title seeds and the [HARNESS CONTINUATION]
 * startsWith check, so every [SCHEDULE STATE]-family block rides the tail.
 * `null` when nothing was declared (no block, no prompt cost).
 *
 * The wording pins three behaviours the incident needed:
 *  - the step is REACHED before the rounds run out (budget is the failure mode);
 *  - it is a tool CALL, not a sentence — a run that only writes "I will ping"
 *    has not done it;
 *  - never narrate delivery status from the absence of one's own receipt. The
 *    false record that motivated this ticket was a model stating "NOT sent"
 *    about a ping the platform then delivered a second later.
 */
export function renderTerminalStepBrief(effect: TerminalSideEffect | null): string | null {
  if (!effect) return null;
  return (
    `[TERMINAL STEP — REQUIRED] This schedule's prompt declares a terminal side-effect that is part of the deliverable, not optional cleanup:\n` +
    `1. [ ] ${sideEffectLabel(effect)} — as your LAST tool call, after the content you were asked for is written.\n` +
    `Budget rule: do the reads FIRST and keep them tight, then EXECUTE this step no later than your second-to-last tool round. Reading is not the deliverable; this call is.\n` +
    `Honesty rule: if you reach the end without making the call, say exactly that ("no ${effect} call this run") — never narrate delivery status (sent / not sent) you did not observe, because the turn is not over when you stop talking.`
  );
}

/** What actually happened to a fired run's declared terminal step. */
export type TerminalStepOutcome =
  /** the model itself made the call and it succeeded */
  | 'model'
  /** the model did not, but the platform executed it at the finalize */
  | 'platform'
  /** nobody delivered it — the owner-facing half of the deliverable is MISSING */
  | 'missed'
  /** a quiet ("Nothing new.") firing: no ping was wanted */
  | 'quiet';

/**
 * Classify a fired run's declared terminal step.
 *
 * `modelNotified` = the run produced an ok notify_user receipt or a delivered
 * tool-result envelope (modelAlreadyNotified). `platformDelivered` = the
 * finalize backstop's own call succeeded; `platformRefused` = it was attempted
 * and refused (rate cap / unlinked) or errored. A quiet run wins over
 * everything: the backstop deliberately does not ping on a "Nothing new."
 * morning, so that case is neither a delivery nor a miss.
 *
 * The ONLY alarm value is 'missed' — it is the single state where the owner
 * asked for a ping and got none, which until now was indistinguishable from
 * the two success shapes (both left the same false prose in the row).
 */
export function resolveTerminalStepOutcome(input: {
  finalText: string;
  modelNotified: boolean;
  platformDelivered: boolean;
  platformRefused: boolean;
}): TerminalStepOutcome {
  if (isQuietRunReply(input.finalText)) return 'quiet';
  if (input.modelNotified) return 'model';
  if (input.platformDelivered) return 'platform';
  // platformRefused and "never attempted" land together: from the owner's side
  // both mean the ping did not arrive, and the brief's alarm is about the
  // owner-facing miss, not about which layer failed to try.
  void input.platformRefused;
  return 'missed';
}