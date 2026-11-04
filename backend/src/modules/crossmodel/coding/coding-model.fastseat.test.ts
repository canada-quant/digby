/**
 * fastSeatProvider / resolveProviderForRun({fastSeat}) — the Helper-SEAT shape
 * (DeepSeek V4.1 Flash cutover 2026-09-10).
 *
 * deepseek-flash is a FAST built-in for the utility / coding_helper seats, but
 * its provider entry carries the agent-seat extras (thinking ON +
 * reasoning_effort max) because the same id serves the L2 checker and coding
 * sessions. Helper-tier WORKERS stream through runModelTurn (not the
 * non-streaming helper-completion path), so without this shaping a DeepSeek
 * Helper would run mechanical verify/digest work at reasoning_effort 'max' —
 * the adversarial review finding this file pins.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  fastSeatProvider, isDeepSeekBuiltInProvider, resolveProvider, resolveProviderForRun,
  DEEPSEEK_THINKING_OFF_EXTRA, DASHSCOPE_THINKING_OFF_EXTRA, isDashScopeQwenBuiltInProvider, type ProviderConfig,
} from './coding-model';

describe('fastSeatProvider — the Helper-seat shape', () => {
  it('a DeepSeek built-in loses reasoning_effort and gets thinking switched OFF; nothing else changes', () => {
    const agentShape = resolveProvider('deepseek-flash');
    expect((agentShape.extra as any).thinking).toEqual({ type: 'enabled' });
    expect((agentShape.extra as any).reasoning_effort).toBe('max');

    const fast = fastSeatProvider(agentShape);
    expect(fast.extra).toEqual({ ...DEEPSEEK_THINKING_OFF_EXTRA });
    expect((fast.extra as any).reasoning_effort).toBeUndefined();
    // The agent-seat max_tokens is a THINKING budget (2026-09-11; the vendor
    // max 393,216 since 2026-09-29) — a no-think seat drops it and runs at the
    // runModelTurn default.
    expect((agentShape.extra as any).max_tokens).toBe(393216);
    expect((fast.extra as any).max_tokens).toBeUndefined();
    // Identity fields are untouched — same model, url, key, budget, vision.
    expect(fast.model).toBe('deepseek-flash');
    expect(fast.url).toBe(agentShape.url);
    expect(fast.contextChars).toBe(agentShape.contextChars);
    expect(fast.supportsVision).toBe(true);
    // Pure: the agent-seat provider object is not mutated.
    expect((agentShape.extra as any).thinking).toEqual({ type: 'enabled' });
  });

  it('GLM / Kimi built-ins are returned untouched (GLM cannot disable thinking; Kimi has its own contract)', () => {
    for (const id of ['glm-5.3', 'kimi-k3', 'kimi-k2.6'] as const) {
      const p = resolveProvider(id);
      expect(fastSeatProvider(p)).toBe(p);
    }
  });

  // QTH1020 (2026-10-20): qwen3.6-27b reasoned ~1.4–2.1k tokens per web_pipe digest (25–36 s vs 5–7 s off).
  it('a DashScope Qwen3 built-in gets enable_thinking:false and keeps everything else', () => {
    for (const id of ['qwen3.6-27b', 'qwen3.6-flash'] as const) {
      const p = resolveProvider(id);
      expect(isDashScopeQwenBuiltInProvider(p)).toBe(true);
      const fast = fastSeatProvider(p);
      expect(fast.extra).toEqual({ ...(p.extra ?? {}), ...DASHSCOPE_THINKING_OFF_EXTRA });
      expect(fast.model).toBe(p.model);
      expect(fast.url).toBe(p.url);
      expect((p.extra as any)?.enable_thinking).toBeUndefined(); // pure: the agent-seat provider is not mutated
    }
  });

  it('FAST_SEAT_QWEN_THINKING_OFF_DISABLED=1 returns the Qwen built-in untouched; a custom endpoint proxying DashScope is never touched', () => {
    const p = resolveProvider('qwen3.6-27b');
    process.env.FAST_SEAT_QWEN_THINKING_OFF_DISABLED = '1';
    try { expect(fastSeatProvider(p)).toBe(p); } finally { delete process.env.FAST_SEAT_QWEN_THINKING_OFF_DISABLED; }
    const custom: ProviderConfig = { url: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: 'k', model: 'qwen3.6-27b', label: 'my-proxy (custom endpoint)', extra: {} };
    expect(isDashScopeQwenBuiltInProvider(custom)).toBe(false);
    expect(fastSeatProvider(custom)).toBe(custom);
  });

  it('a CUSTOM endpoint that happens to proxy DeepSeek is not treated as the built-in (it carries the admin no-think flag instead)', () => {
    const custom: ProviderConfig = {
      url: 'https://api.deepseek.com/chat/completions', apiKey: 'k', model: 'deepseek-flash',
      label: 'my-proxy (custom endpoint)', extra: {},
    };
    expect(isDeepSeekBuiltInProvider(custom)).toBe(false);
    expect(fastSeatProvider(custom)).toBe(custom);
    expect(isDeepSeekBuiltInProvider(resolveProvider('deepseek-flash'))).toBe(true);
  });
});

describe('resolveProviderForRun({ fastSeat })', () => {
  it('applies the fast shape only when asked — the default (agent seats) keeps thinking + effort max', async () => {
    const agent = await resolveProviderForRun('deepseek-flash', 'u1');
    expect((agent.extra as any).reasoning_effort).toBe('max');
    const fast = await resolveProviderForRun('deepseek-flash', 'u1', { fastSeat: true });
    expect(fast.extra).toEqual({ thinking: { type: 'disabled' } });
  });

  it('the retired ids alias forward BEFORE shaping, so a legacy Helper override (deepseek-v4-flash) still runs fast on deepseek-flash', async () => {
    const fast = await resolveProviderForRun('deepseek-v4-flash', 'u1', { fastSeat: true });
    expect(fast.model).toBe('deepseek-flash');
    expect(fast.extra).toEqual({ thinking: { type: 'disabled' } });
  });
});
