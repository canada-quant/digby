/**
 * terminal-step-brief.0973bdd7.test.ts — replay fixtures for ticket 0973bdd7
 * (2026-11-01): a daily Slack digest in a PLAIN chat reached its tools-off
 * final turn without executing the notify_user step its own stored prompt
 * mandates, two mornings running.
 *
 * These tests pin BOTH halves of the fix against the incident's own artefacts:
 * the schedule's real stored prompt (schedule b174c336) must yield a checklist
 * block, and the two outcomes that looked identical in the durable record —
 * "the platform delivered it" vs "nobody did" — must classify differently.
 */

import {
  declareTerminalStep,
  renderTerminalStepBrief,
  resolveTerminalStepOutcome,
} from './terminal-step-brief';
import { scheduleMandatesTrailingNotify } from './trailing-notify-backstop';

/** The schedule's stored prompt, as reported in ticket 0973bdd7 (schedule b174c336,
 *  promptLength 1645). Trailing-step wording is verbatim. */
const DIGEST_PROMPT =
  '☀️ DAILY 8AM SUNDAY MARKET SLACK DIGEST (recurring — fires ~14:59Z).\n' +
  'Read the Sunday Market Slack channels and summarize what changed since yesterday.\n' +
  'Owner standing preference: a Telegram ping with every morning\'s digest.\n' +
  'Order: post the digest as your reply, THEN call notify_user with a 1-3 line summary.';

/** A schedule that asks for a digest and NO ping — must pay zero prompt cost. */
const NO_PING_PROMPT =
  'Nightly repo sweep: read origin/main, summarize the commits that landed since the last firing, and reply with the list.';

/** The explicit prohibition shape — the polarity trap every detector in this
 *  family has had to survive: ordering a notification and then forbidding it. */
const PROHIBITION_PROMPT =
  'Post the digest as your reply, then call notify_user with a summary — except on weekends: do NOT call notify_user on weekends.';

describe('ticket 0973bdd7 — terminal step surfaced in the firing brief', () => {
  it('detects the digest schedule\'s declared terminal side-effect', () => {
    expect(declareTerminalStep(DIGEST_PROMPT)).toBe('notify_user');
  });

  it('emits NO block for a schedule that declares no terminal step (zero prompt cost)', () => {
    expect(declareTerminalStep(NO_PING_PROMPT)).toBeNull();
    expect(renderTerminalStepBrief(declareTerminalStep(NO_PING_PROMPT))).toBeNull();
    expect(renderTerminalStepBrief(null)).toBeNull();
  });

  it('reuses the hardened mandate detector, so a prohibition does not become a ping', () => {
    // The point of DELEGATING instead of growing a second regex: whatever the
    // accumulated negation discipline decides is what the brief says.
    const verdict = declareTerminalStep(PROHIBITION_PROMPT);
    // The accumulated discipline resolves this sentence to NO mandate (the
    // trailing prohibition wins over the ordering clause), so the brief asks
    // for no ping — pinned as a verdict, not as an identity, so a regression
    // that starts demanding a ping fails HERE.
    expect(verdict).toBeNull();
    // ...and it must equal what the trailing-notify backstop acts on: a brief
    // that demanded a ping the backstop refuses (or vice versa) would be worse
    // than silence. Both readers share one function.
    expect(verdict === 'notify_user').toBe(scheduleMandatesTrailingNotify(PROHIBITION_PROMPT));
  });

  it('renders a checklist item that names the step, the budget rule and the honesty rule', () => {
    const block = renderTerminalStepBrief('notify_user');
    expect(block).toBeTruthy();
    // It must read as an ORDERED checklist item, not prose (the incident's
    // whole failure mode: the mandate was prose at the end of a long prompt).
    expect(block).toContain('[TERMINAL STEP — REQUIRED]');
    expect(block).toContain('1. [ ]');
    expect(block).toContain('notify_user');
    // The budget rule — the run must spend a round on this BEFORE the pull
    // exhausts the 8-step chatProfile('thinking') budget.
    expect(block).toMatch(/Budget rule:/);
    expect(block).toMatch(/second-to-last tool round/);
    // The honesty rule — the incident's second wound was a durable row that
    // claimed "NOT sent" about a ping the platform then delivered.
    expect(block).toMatch(/Honesty rule:/);
    expect(block).toContain('never narrate delivery status');
  });

});

describe('ticket 0973bdd7 — terminal step OUTCOME classification', () => {
  const ANSWER = 'Sunday Market digest: 3 new #general posts, 1 pricing change in #ops.';

  it('the 2026-11-01 shape: model stayed silent, platform backstop DELIVERED ⇒ platform', () => {
    // The run's own prose said "the Telegram ping was NOT sent this run".
    // The metric shows outcome:'ok' at 15:15:52.392Z, one second after the
    // final text — so this was a DELIVERY the row wrongly recorded as a miss.
    expect(resolveTerminalStepOutcome({
      finalText: `${ANSWER}\n\nTelegram ping: NOT sent.`,
      modelNotified: false,
      platformDelivered: true,
      platformRefused: false,
    })).toBe('platform');
  });

  it('the genuine miss: nobody delivered ⇒ missed (the only alarm value)', () => {
    expect(resolveTerminalStepOutcome({
      finalText: `${ANSWER}\n\nTelegram ping: NOT sent.`,
      modelNotified: false,
      platformDelivered: false,
      platformRefused: true,
    })).toBe('missed');
    // An unparsed/never-attempted backstop is equally a miss from the owner's
    // side — "no attempt" and "refused" both mean no ping arrived.
    expect(resolveTerminalStepOutcome({
      finalText: ANSWER,
      modelNotified: false,
      platformDelivered: false,
      platformRefused: false,
    })).toBe('missed');
  });

  it('the happy path: the model made the call itself ⇒ model (no double ping)', () => {
    expect(resolveTerminalStepOutcome({
      finalText: ANSWER,
      modelNotified: true,
      platformDelivered: false,
      platformRefused: false,
    })).toBe('model');
  });

  it('a quiet morning is neither a delivery nor a miss', () => {
    expect(resolveTerminalStepOutcome({
      finalText: 'Nothing new.',
      modelNotified: false,
      platformDelivered: false,
      platformRefused: false,
    })).toBe('quiet');
  });

  it('every incident outcome is distinguishable (no two states collapse)', () => {
    const seen = new Set([
      resolveTerminalStepOutcome({ finalText: ANSWER, modelNotified: true, platformDelivered: false, platformRefused: false }),
      resolveTerminalStepOutcome({ finalText: ANSWER, modelNotified: false, platformDelivered: true, platformRefused: false }),
      resolveTerminalStepOutcome({ finalText: ANSWER, modelNotified: false, platformDelivered: false, platformRefused: true }),
      resolveTerminalStepOutcome({ finalText: 'Nothing new.', modelNotified: false, platformDelivered: false, platformRefused: false }),
    ]);
    expect(seen.size).toBe(4);
  });
});