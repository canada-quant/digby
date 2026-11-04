/**
 * displayModelId (P2 item 7) — the ONE legacy-model-id read-alias table,
 * extracted from account/CodingTab.tsx and shared with FloatingChrome's
 * workspace block (the session ⋯ menu showed the STORED 'glm-5.2').
 */

import { describe, expect, it } from 'vitest';
import { displayModelId, MODEL_ID_READ_ALIASES } from './model-alias';

describe('displayModelId (P2 item 7)', () => {
  it('normalizes the legacy ids to their current models', () => {
    expect(displayModelId('glm-5.2')).toBe('glm-5.3');
    expect(displayModelId('kimi-k2.6')).toBe('kimi-k3');
    expect(displayModelId('deepseek-v4-pro')).toBe('deepseek-flash'); // V4.1 Flash cutover 2026-09-10
  });

  it('passes current and unknown ids through unchanged', () => {
    expect(displayModelId('glm-5.3')).toBe('glm-5.3');
    expect(displayModelId('kimi-k3')).toBe('kimi-k3');
    expect(displayModelId('deepseek-flash')).toBe('deepseek-flash');
    expect(displayModelId('ollama:qwen3.6-27b')).toBe('ollama:qwen3.6-27b');
    expect(displayModelId('')).toBe('');
  });

  it('never maps an alias onto another alias (one hop resolves fully)', () => {
    for (const target of Object.values(MODEL_ID_READ_ALIASES)) {
      expect(MODEL_ID_READ_ALIASES[target]).toBeUndefined();
    }
  });
});
