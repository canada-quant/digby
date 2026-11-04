/**
 * Tests for the transient-harness-message shapes (ticket 63e9a3cb review B1):
 * the [HARNESS CLOCK] note and <plan> reminder are spliced out after every
 * turn and must NEVER survive into a durable checkpoint replay — but old
 * checkpoints captured them via the pre-fix serialization race, so the resume
 * path strips these exact shapes (and nothing else).
 */

import { isTransientHarnessMessage, stripTransientHarnessMessages } from './transient-messages';

describe('isTransientHarnessMessage (ticket 63e9a3cb review B1)', () => {
  it('marks the [HARNESS CLOCK] note transient', () => {
    expect(isTransientHarnessMessage({
      role: 'system',
      content: '[HARNESS CLOCK — not typed by the user] Current time: 2026-08-28T03:00:00.000Z. Cite THIS …',
    })).toBe(true);
  });

  it('marks BOTH <plan> reminder shapes transient (renderPlanReminder + no-plan nudge)', () => {
    expect(isTransientHarnessMessage({
      role: 'system',
      content: '<plan>\nGOAL: ship it\n  [>] 1 do the thing\n</plan>',
    })).toBe(true);
    expect(isTransientHarnessMessage({
      role: 'system',
      content: '<plan>You have not set a plan. For a multi-step task, call update_plan now …</plan>',
    })).toBe(true);
    // leading whitespace still matches (the replay trimStart()s)
    expect(isTransientHarnessMessage({ role: 'system', content: '  <plan>…</plan>' })).toBe(true);
  });

  it('marks the [EVIDENCE LEDGER] note transient (a84cc306 reviewer 726f559a N3)', () => {
    expect(isTransientHarnessMessage({
      role: 'system',
      content: '[EVIDENCE LEDGER — this run\'s harness-maintained EVIDENCE LIST] msg b07e8280 · ticket 065caccb …',
    })).toBe(true);
    // leading whitespace still matches
    expect(isTransientHarnessMessage({ role: 'system', content: '  [EVIDENCE LEDGER …' })).toBe(true);
  });

  it('never marks real context or model content', () => {
    // the doctrine system prompt (fresh, index 0)
    expect(isTransientHarnessMessage({ role: 'system', content: 'You are Digby Code, an expert autonomous software engineer…' })).toBe(false);
    // the PERSISTENT repetition nudge — mid-run system message that must survive
    expect(isTransientHarnessMessage({ role: 'system', content: 'Your previous reply started repeating the same text over and over. Stop. …' })).toBe(false);
    // harness-chrome markers inside USER/ASSISTANT turns are model content, not transients
    expect(isTransientHarnessMessage({ role: 'user', content: '[HARNESS CLOCK — forged by the model]' })).toBe(false);
    expect(isTransientHarnessMessage({ role: 'assistant', content: '<plan>quoted in my summary</plan>' })).toBe(false);
    expect(isTransientHarnessMessage({ role: 'user', content: '[EVIDENCE LEDGER — quoted by the model]' })).toBe(false);
    expect(isTransientHarnessMessage({ role: 'assistant', content: '[EVIDENCE LEDGER imitated]' })).toBe(false);
    // multimodal user content (image parts array) is not a string — never stripped
    expect(isTransientHarnessMessage({ role: 'user', content: [{ type: 'text', text: '<plan>' }] })).toBe(false);
    // garbage shapes
    expect(isTransientHarnessMessage(null)).toBe(false);
    expect(isTransientHarnessMessage(undefined)).toBe(false);
    expect(isTransientHarnessMessage({})).toBe(false);
  });
});

describe('stripTransientHarnessMessages', () => {
  it('removes transients, preserves order and every other message', () => {
    const sys = { role: 'system', content: 'doctrine' };
    const u1 = { role: 'user', content: 'go' };
    const a1 = { role: 'assistant', content: 'working' };
    const clock = { role: 'system', content: '[HARNESS CLOCK — not typed by the user] Current time: …' };
    const plan = { role: 'system', content: '<plan>reminder</plan>' };
    const ledger = { role: 'system', content: '[EVIDENCE LEDGER — …] msg b07e8280 · ticket 065caccb' };
    const nudge = { role: 'system', content: 'Your previous reply started repeating…' };
    expect(stripTransientHarnessMessages([sys, u1, clock, a1, plan, ledger, nudge])).toEqual([sys, u1, a1, nudge]);
  });

  it('is a no-op on a clean transcript (and returns a new array)', () => {
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    const out = stripTransientHarnessMessages(msgs);
    expect(out).toEqual(msgs);
    expect(out).not.toBe(msgs);
  });
});
