/**
 * turn-recovery.ts — the truncated-thinking recovery decision (2026-09-11):
 * a thinking model that spent its whole per-turn budget reasoning and returned
 * no content must be retried with more budget / less thinking, not treated as
 * "the model answered nothing" (the glm-5.3 supervisor-seat failure).
 */

import { isEmptyTruncatedTurn, recoveryExtras, truncationCapKey, TRUNCATION_RECOVERY_MIN_MAX_TOKENS } from './turn-recovery';

// The live kimi-k3 seat shape (coding-model.ts resolveProvider('kimi-k3'):
// extra + omitParams), mirrored here so this file stays pure — importing
// coding-model.ts pulls in env validation, which exits the jest process.
// Seat cap 16,384 → 65,536 on 2026-09-20 (ticket 22c309f4): K3's reasoning
// counts against max_completion_tokens; 65,536 = the recovery floor below.
const KIMI_K3_SEAT = {
  model: 'kimi-k3',
  extra: { max_completion_tokens: 65536 } as Record<string, any>,
  omitParams: ['max_tokens', 'stream_options'] as string[],
};

describe('isEmptyTruncatedTurn', () => {
  it('true for finish_reason length with no content (the GLM final-note failure)', () => {
    expect(isEmptyTruncatedTurn({ content: '', reasoning: 'x'.repeat(5000), finishReason: 'length', toolCalls: [] })).toBe(true);
    expect(isEmptyTruncatedTurn({ content: '   ', finishReason: 'length', toolCalls: [] })).toBe(true);
  });
  it('true for reasoning-only output even when the provider said stop', () => {
    expect(isEmptyTruncatedTurn({ content: '', reasoning: 'thinking…', finishReason: 'stop', toolCalls: [] })).toBe(true);
  });
  it('false when the model answered, called a tool, was cancelled, or errored', () => {
    expect(isEmptyTruncatedTurn({ content: 'Here is the ledger.', reasoning: 'r', finishReason: 'length', toolCalls: [] })).toBe(false);
    expect(isEmptyTruncatedTurn({ content: '', reasoning: 'r', finishReason: 'tool_calls', toolCalls: [{}] })).toBe(false);
    expect(isEmptyTruncatedTurn({ content: '', reasoning: 'r', finishReason: 'cancelled', toolCalls: [] })).toBe(false);
    expect(isEmptyTruncatedTurn({ content: '', reasoning: '', finishReason: 'error', toolCalls: [] })).toBe(false);
    // A plain empty 'stop' with no reasoning is a different (provider blip) class — not ours.
    expect(isEmptyTruncatedTurn({ content: '', reasoning: '', finishReason: 'stop', toolCalls: [] })).toBe(false);
  });
});

describe('recoveryExtras', () => {
  it('doubles the output budget with a 65,536 floor and steps max reasoning down to high, preserving other extras', () => {
    const glm = { thinking: { type: 'enabled' }, reasoning_effort: 'max', temperature: 0.6, max_tokens: 65536 };
    const out = recoveryExtras(glm);
    expect(out).toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'high', temperature: 0.6, max_tokens: 131072 });
    expect(glm.reasoning_effort).toBe('max'); // pure — input untouched
  });
  it('uses the 16k runModelTurn default when the seat carries no max_tokens and leaves non-max effort alone', () => {
    expect(recoveryExtras({ reasoning_effort: 'high' })).toEqual({ reasoning_effort: 'high', max_tokens: TRUNCATION_RECOVERY_MIN_MAX_TOKENS });
    expect(recoveryExtras(undefined)).toEqual({ max_tokens: TRUNCATION_RECOVERY_MIN_MAX_TOKENS });
  });

  // Review 2026-09-13 issue 6: Kimi K3 strips max_tokens via omitParams, so the
  // recovery must raise max_completion_tokens — the old shape re-rolled 16,384.
  describe('provider-aware cap key (review 2026-09-13 issue 6)', () => {
    it('raises max_completion_tokens (not max_tokens) when the seat carries that key', () => {
      const out = recoveryExtras({ max_completion_tokens: 16384 }, ['max_tokens', 'stream_options']);
      expect(out).toEqual({ max_completion_tokens: TRUNCATION_RECOVERY_MIN_MAX_TOKENS });
      expect(out).not.toHaveProperty('max_tokens');
    });
    it('doubles an already-raised max_completion_tokens above the floor', () => {
      expect(recoveryExtras({ max_completion_tokens: 65536 }, ['max_tokens'])).toEqual({ max_completion_tokens: 131072 });
    });
    it('uses max_completion_tokens when max_tokens is omitted even if no cap is set yet', () => {
      expect(recoveryExtras({}, ['max_tokens'])).toEqual({ max_completion_tokens: TRUNCATION_RECOVERY_MIN_MAX_TOKENS });
      expect(truncationCapKey({}, ['max_tokens'])).toBe('max_completion_tokens');
    });
    it('keeps max_tokens for seats that honour it (GLM/DeepSeek/custom endpoints)', () => {
      expect(truncationCapKey({ max_tokens: 65536 }, ['stream_options'])).toBe('max_tokens');
      expect(truncationCapKey(undefined, undefined)).toBe('max_tokens');
      expect(recoveryExtras({ max_tokens: 65536, reasoning_effort: 'max' }, ['stream_options']))
        .toEqual({ max_tokens: 131072, reasoning_effort: 'high' });
    });
    it('survives the real payload assembly for the live kimi-k3 seat: the raised cap is not the stripped key', () => {
      const kimi = KIMI_K3_SEAT;
      const recovered = { ...kimi, extra: recoveryExtras(kimi.extra, kimi.omitParams) };
      // Mirror runModelTurn's assembly: default max_tokens, spread extras, then strip omitParams.
      const payload: any = { max_tokens: 16384, ...recovered.extra };
      for (const k of recovered.omitParams ?? []) delete payload[k];
      expect(payload.max_tokens).toBeUndefined();
      // Seat cap 65,536 (22c309f4) doubles to 131,072 — K3's documented default.
      expect(payload.max_completion_tokens).toBe(131_072);
      expect(payload.max_completion_tokens).toBeGreaterThan(kimi.extra.max_completion_tokens);
      // Kimi K3's documented max_completion_tokens ceiling (platform.kimi.ai, 2026-09-13) — the raise must stay inside it.
      expect(payload.max_completion_tokens).toBeLessThanOrEqual(1_048_576);
      expect(kimi.extra.max_completion_tokens).toBe(65536); // pure — the resolved config is untouched
    });
  });
});
