import { describe, expect, it } from 'vitest';
import { displayModelBlurb, displayModelName, FALLBACK_PERSONA_NAME, MODEL_PERSONAS, SEAT_LABELS, isSeatLabel } from './model-display';

describe('displayModelName (owner ticket 7bdbe40c — persona labels)', () => {
  it('maps the six provider keys to personas', () => {
    expect(displayModelName('kimi')).toBe('Digby');
    expect(displayModelName('glm')).toBe('Triple Checker');
    expect(displayModelName('deepseek')).toBe('Double Checker');
    expect(displayModelName('openai')).toBe('The Veteran');
    expect(displayModelName('grok')).toBe('The Maverick');
    expect(displayModelName('gemini')).toBe('The Scholar');
  });

  it('normalizes Fireworks path ids', () => {
    expect(displayModelName('accounts/fireworks/models/deepseek-v4-pro')).toBe('Double Checker');
    expect(displayModelName('accounts/fireworks/models/kimi-k2p6')).toBe('Digby');
    expect(displayModelName('accounts/fireworks/models/glm-5p1')).toBe('Triple Checker');
  });

  it('normalizes legacy direct API ids and aliases', () => {
    expect(displayModelName('deepseek-chat')).toBe('Double Checker');
    expect(displayModelName('deepseek-reasoner')).toBe('Double Checker');
    expect(displayModelName('deepseek-v4-flash')).toBe('Double Checker');
    expect(displayModelName('accounts/fireworks/models/deepseek-v3p2')).toBe('Double Checker');
    expect(displayModelName('kimi-k2-0711-chat')).toBe('Digby');
    expect(displayModelName('kimi-k3')).toBe('Digby');
    expect(displayModelName('glm-5.1')).toBe('Triple Checker');
    expect(displayModelName('glm-5.2')).toBe('Triple Checker'); // legacy stored transcripts
    expect(displayModelName('glm-5.3')).toBe('Triple Checker'); // 2026-09-03 cutover id
    expect(displayModelName('glm-5.3-flash')).toBe('Triple Checker'); // vision utility (ZAI)
  });

  it('normalizes already-clean display names and backend-sent labels', () => {
    expect(displayModelName('DeepSeek V4 Pro')).toBe('Double Checker');
    expect(displayModelName('Kimi K3')).toBe('Digby');
    expect(displayModelName('GLM-5.2')).toBe('Triple Checker');
    expect(displayModelName('Gemini (thinking)')).toBe('The Scholar');
    expect(displayModelName('ChatGPT')).toBe('The Veteran');
    expect(displayModelName('Grok')).toBe('The Maverick');
  });

  it('routes vision + utility models to role personas', () => {
    expect(displayModelName('accounts/fireworks/models/qwen3-vl-30b-a3b-instruct')).toBe('The Scout');
    expect(displayModelName('accounts/fireworks/models/llama-v3p3-70b-instruct')).toBe('The Helper');
    expect(displayModelName('accounts/fireworks/models/gpt-oss-20b')).toBe('The Helper');
  });

  it('never leaks a raw vendor id: unknown values fall back to AI Agent', () => {
    expect(displayModelName('accounts/fireworks/models/some-future-model-9')).toBe(FALLBACK_PERSONA_NAME);
    expect(displayModelName('claude-opus-99')).toBe(FALLBACK_PERSONA_NAME);
    expect(displayModelName('')).toBe(FALLBACK_PERSONA_NAME);
    expect(displayModelName(null)).toBe(FALLBACK_PERSONA_NAME);
    expect(displayModelName(undefined)).toBe(FALLBACK_PERSONA_NAME);
  });

  it('is idempotent: persona names map to themselves (review N1 — fallback chains stay alive)', () => {
    for (const p of Object.values(MODEL_PERSONAS)) {
      expect(displayModelName(p.name)).toBe(p.name);
    }
    expect(displayModelName('AI Agent')).toBe(FALLBACK_PERSONA_NAME);
  });

  it('path keywords never beat the basename (review N5 — fails if the path strip is lost)', () => {
    // 'deepseek' lives in the PATH, 'llama' in the basename: without the
    // accounts/…/models/ strip this wrongly routes to The Logician.
    expect(displayModelName('accounts/deepseek/models/llama-v3p3-70b-instruct')).toBe('The Helper');
    expect(displayModelName('accounts/moonshot/models/gpt-oss-20b')).toBe('The Helper');
  });

  it('no persona name contains a vendor string', () => {
    for (const p of Object.values(MODEL_PERSONAS)) {
      expect(p.name).not.toMatch(/kimi|glm|deepseek|gpt|grok|gemini|qwen|llama|claude|openai|moonshot|zai/i);
    }
  });
});

describe('seat labels (owner 2026-09-15 — Digby / Double Checker / Triple Checker)', () => {
  it('seat CARD KEYS render as their seat label (the backend keys chat cards by seat)', () => {
    expect(displayModelName('digby')).toBe('Digby');
    expect(displayModelName('double_checker')).toBe('Double Checker');
    expect(displayModelName('triple_checker')).toBe('Triple Checker');
  });

  it('a seat label sent by the backend passes through verbatim (case-insensitive match, never "AI Agent")', () => {
    for (const label of Object.values(SEAT_LABELS)) expect(displayModelName(label)).toBe(label);
    expect(displayModelName('double checker')).toBe('Double Checker'); // canonical casing
    expect(isSeatLabel('Triple Checker')).toBe(true);
    expect(isSeatLabel('The Professor')).toBe(false);
    expect(isSeatLabel('')).toBe(false);
  });

  it('the retired persona names are gone from the vocabulary', () => {
    const names = Object.values(MODEL_PERSONAS).map(p => p.name).join(' | ');
    expect(names).not.toMatch(/Professor|Logician|Fact-checker|Cross-checker|Researcher/);
    expect(Object.values(SEAT_LABELS).join(' | ')).not.toMatch(/Professor|Logician|Fact-checker|Cross-checker/);
  });
});

describe('displayModelBlurb', () => {
  it('returns the persona blurb for ids and labels', () => {
    expect(displayModelBlurb('kimi-k3')).toContain('The lead');
    expect(displayModelBlurb('glm-5.2')).toContain('Third opinion');
    expect(displayModelBlurb('glm-5.3')).toContain('Third opinion');
    expect(displayModelBlurb('deepseek-flash')).toContain('Second opinion');
  });

  it('returns empty string for unknown/empty input', () => {
    expect(displayModelBlurb('nope-9')).toBe('');
    expect(displayModelBlurb(null)).toBe('');
  });
});
