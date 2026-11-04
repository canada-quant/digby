/**
 * Replay pin — log-signal ticket c6af45ef (2026-10-29, 29 rows / 3 h across 3
 * distinct hours).
 *
 * THE FINGERPRINT: "runModelTurn: tt-qwen3.8-flash-next (llm-cql (custom
 * endpoint)) rejected max_tokens <n> (HTTP 400) — retrying once at <m> (the cap
 * the provider named, learned for this model)."
 *
 * ADJUDICATION (this lane, 2026-10-29): a GENUINE framework defect. The
 * budget ladder (`outputBudgetFixForRejection` → `learnOutputCap`) treated
 * EVERY number a provider names in an output-budget 400 as the model's static
 * output ceiling and kept the MINIMUM (`prev ? Math.min(prev, cap) : cap`).
 * `tt-qwen3.8-flash-next` names a different figure on each rejection, so the
 * learned "cap" ratcheted DOWN one rejected round-trip at a time and never
 * recovered. The live sequence (from the rows):
 *   131072 → 43421 → 42902 → 38236 → 33840 → 31473 → 29117 → 29003 → 28243 → 17268
 * (note it ROSE 43421 → 42902 and 29117 → 29003: a value that moves is not a
 * model property — it tracks the prompt, i.e. it is a window remainder. The
 * reader should notice the sequence is not even monotonic.)
 *
 * Each turn then paid a fresh 400 to "learn" a smaller ceiling, the class could
 * never fall to the sweep's ≤2 bar, and the model was progressively crippled
 * (131072 → 17268 is an 87% loss of usable output budget).
 *
 * THE FIX: a named cap is latched only while the number stays STABLE for the
 * (endpoint, model). The moment two different numbers are named, the figure is
 * proven prompt-derived — the learned cap is CLEARED and that lane stops
 * latching for good. The per-turn retry still uses the value the provider just
 * named (the turn still succeeds), and `learnContextWindow` is untouched (a
 * context window IS a model property, learned by its own, different lane).
 *
 * This pin asserts: (a) a stable number still latches exactly as before (the
 * real fix for static-cap providers must not regress), (b) a VARYING number
 * stops latching and clears the ceiling, (c) once proven varying it never
 * latches again, and (d) the recognised prod shapes still parse to a per-turn
 * retry value.
 */

import {
  learnOutputCap, learnedOutputCap, learnContextWindow, learnedContextWindow,
  outputBudgetFixForRejection, __resetThinkingBudgetLatchForTests,
  __resetVariedOutputCapsForTests,
} from './coding-model';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** The failing spec, as the live rows name it. */
const P: any = { url: 'https://llm-cql.example/v1/chat/completions', model: 'tt-qwen3.8-flash-next' };

/** The figure a provider names for a static output ceiling (ZAI/DashScope range shape). */
const STATIC_CAP_BODY = 'max_tokens is invalid for this model: expected a value in [1, 16384]';

beforeEach(() => {
  __resetThinkingBudgetLatchForTests();
  __resetVariedOutputCapsForTests();
});

describe('ticket c6af45ef — a PROMPT-derived "cap" is not latched as a model ceiling', () => {
  it('(a) a STABLE named cap still latches (static-cap providers keep their fix)', () => {
    learnOutputCap(P, 16_384);
    expect(learnedOutputCap(P)).toBe(16_384);
    // The same number again is not a change — it stays latched.
    learnOutputCap(P, 16_384);
    expect(learnedOutputCap(P)).toBe(16_384);
  });

  it('(b) the live ratchet sequence stops latching and CLEARS the ceiling', () => {
    // Verbatim from the prod rows (newest last).
    const seq = [43_421, 42_902, 38_236, 33_840, 31_473, 29_117, 29_003, 28_243, 17_268];
    learnOutputCap(P, 131_072);          // the model's own family default
    expect(learnedOutputCap(P)).toBe(131_072);

    learnOutputCap(P, seq[0]);           // 131072 → 43421: two numbers ⇒ varying
    // The prompt-derived figure is NOT kept as a ceiling...
    expect(learnedOutputCap(P)).toBeUndefined();

    // ...and the rest of the ratchet changes nothing.
    for (const n of seq.slice(1)) learnOutputCap(P, n);
    expect(learnedOutputCap(P)).toBeUndefined();
  });

  it('(c) once proven varying, a later STABLE-looking number never re-latches', () => {
    learnOutputCap(P, 33_840);
    learnOutputCap(P, 31_473);           // proven prompt-derived
    expect(learnedOutputCap(P)).toBeUndefined();
    // Same number twice afterwards must not sneak back in.
    learnOutputCap(P, 17_268);
    learnOutputCap(P, 17_268);
    expect(learnedOutputCap(P)).toBeUndefined();
  });

  it('(d) the per-turn retry still gets a value — the turn is not sacrificed', () => {
    // The window lane is untouched: a context window is a real model property.
    learnContextWindow(P, 32_768);
    expect(learnedContextWindow(P)).toBe(32_768);

    // A static cap rejection still parses to a per-turn retry figure.
    expect(outputBudgetFixForRejection(131_072, STATIC_CAP_BODY)).toEqual({ cap: 16_384, learn: 'cap' });
    // The context-overflow shape still parses to window-minus-prompt: the
    // 1024 in-messages tokens AND the 1024-token safety margin both come off.
    const overflow = "This model's maximum context length is 29638 tokens. However, you requested 31473 tokens (1024 in the messages, 30449 in the completion). Please reduce the length of the messages or completion.";
    expect(outputBudgetFixForRejection(31_473, overflow)).toEqual({ cap: 27_590, learn: 'window', window: 29_638 });
  });

  it('two providers/models do not share a variation verdict', () => {
    const other: any = { url: P.url, model: 'some-other-model' };
    learnOutputCap(P, 40_000);
    learnOutputCap(P, 30_000);            // P proven varying
    learnOutputCap(other, 40_000);        // other is untouched
    expect(learnedOutputCap(P)).toBeUndefined();
    expect(learnedOutputCap(other)).toBe(40_000);
  });
});