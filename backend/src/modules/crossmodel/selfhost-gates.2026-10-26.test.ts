/**
 * Self-host / Digby Edge honesty gates (2026-10-26, the digby.cql.ca outage).
 *
 * The owner's Edge instance (digby.cql.ca — a gateway-only self-host: every
 * model served through custom endpoints, no DEEPSEEK_API_KEY /
 * DASHSCOPE_API_KEY) showed "Personalized news is temporarily unavailable —
 * we'll retry automatically" forever. Root cause: the 2026-10-20 news gate
 * covered the no-SEARCH corner; the no-FORMATTER corner (search configured,
 * utility chain structurally absent) fell through to the degrade-forever
 * loop — fetchNewsHeadlines bails at isUtilityLLMAvailable() on every pass,
 * the 5-min backoff + fetch breaker arm, and retrying can never succeed
 * because the missing piece is CONFIGURATION, not a transient outage.
 *
 * This suite pins the fix shape:
 *   1. utilityChainUnconfigured — the truth table (env keys, seat overrides,
 *      the fallback slot, fail-open on read errors);
 *   2. the wiring — the GET /news + GET /suggested-questions gates and the
 *      scheduler tick consult the gate BEFORE any prefetch/poll machinery
 *      (source-pin assertions, the feeds-retirement.43c24152 read pattern:
 *      the controller/tick are not importable in isolation);
 *   3. embedTexts — a keyless instance gets a CONFIG-SHAPED error (naming
 *      the Embeddings seat + DASHSCOPE_API_KEY), never a provider 401
 *      masked as an outage, and never a POST;
 *   4. the memory-embed-backfill cron — idles on a keyless instance instead
 *      of burning a doomed embed per row every 15 minutes.
 *
 * No network or DB: the module graph is re-loaded per case in a fresh
 * registry (jest.resetModules + doMock) so the module-load-time env captures
 * differ per case (the utility-llm.test.ts convention, inverted).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

const read = (p: string): string => readFileSync(resolve(__dirname, p), 'utf8');

/** Re-load the module graph with a keyless (or given) env; returns a restore fn. */
function keylessModules(env: Record<string, string | undefined> = {}) {
  jest.resetModules();
  const had = {
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
    DIGBY_INSTANCE: process.env.DIGBY_INSTANCE,
  };
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DASHSCOPE_API_KEY;
  delete process.env.DIGBY_INSTANCE;
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }
  // The shared mock chain (news.service.test.ts idiom): logger transitively
  // imports config/env whose Zod validation process.exit(1)s keyless.
  jest.doMock('../../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }));
  jest.doMock('../../config/redis', () => ({
    __esModule: true,
    default: { get: jest.fn(), set: jest.fn(), setEx: jest.fn(), del: jest.fn(), ttl: jest.fn(), multi: jest.fn() },
  }));
  jest.doMock('../../config/database', () => ({
    __esModule: true,
    default: {
      userMemory: { findUnique: jest.fn(), findMany: jest.fn() },
      crossModelChat: { findMany: jest.fn() },
      user: { findMany: jest.fn() },
      $executeRawUnsafe: jest.fn(),
      $queryRawUnsafe: jest.fn(),
    },
  }));
  jest.doMock('./feedback/feedback.service', () => ({
    __esModule: true,
    fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 'stub' } })),
  }));
  return () => {
    for (const [k, v] of Object.entries(had)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    for (const k of Object.keys(env)) if (!(k in had)) delete process.env[k];
  };
}

describe('utilityChainUnconfigured — the structural gate (2026-10-26)', () => {
  it('false when DEEPSEEK_API_KEY is set (the configured instance)', async () => {
    const restore = keylessModules({ DEEPSEEK_API_KEY: 'k' });
    try {
      const { utilityChainUnconfigured } = await import('../../utils/utility-llm');
      await expect(utilityChainUnconfigured()).resolves.toBe(false);
    } finally { restore(); }
  });

  it('false when DASHSCOPE_API_KEY is set', async () => {
    const restore = keylessModules({ DASHSCOPE_API_KEY: 'k' });
    try {
      const { utilityChainUnconfigured } = await import('../../utils/utility-llm');
      await expect(utilityChainUnconfigured()).resolves.toBe(false);
    } finally { restore(); }
  });

  it('false when a utility seat override is configured (the gateway-only Edge with the seat assigned)', async () => {
    const restore = keylessModules({});
    try {
      jest.doMock('./model-endpoints/model-roles.service', () => ({
        __esModule: true,
        resolveRoleModel: jest.fn(async (k: string) => (k === 'utility' ? 'my-gw:qwen3.8-27b' : '')),
        resolveRoleFallback: jest.fn(async () => ''),
      }));
      const { utilityChainUnconfigured } = await import('../../utils/utility-llm');
      await expect(utilityChainUnconfigured()).resolves.toBe(false);
    } finally { restore(); }
  });

  it('false when only the utility seat FALLBACK is configured', async () => {
    const restore = keylessModules({});
    try {
      jest.doMock('./model-endpoints/model-roles.service', () => ({
        __esModule: true,
        resolveRoleModel: jest.fn(async () => ''),
        resolveRoleFallback: jest.fn(async (k: string) => (k === 'utility' ? 'my-gw:deepseek-v4' : '')),
      }));
      const { utilityChainUnconfigured } = await import('../../utils/utility-llm');
      await expect(utilityChainUnconfigured()).resolves.toBe(false);
    } finally { restore(); }
  });

  it('TRUE when keyless with no seat assignment (the digby.cql.ca outage shape)', async () => {
    const restore = keylessModules({});
    try {
      jest.doMock('./model-endpoints/model-roles.service', () => ({
        __esModule: true,
        resolveRoleModel: jest.fn(async () => ''),
        resolveRoleFallback: jest.fn(async () => ''),
      }));
      const { utilityChainUnconfigured } = await import('../../utils/utility-llm');
      await expect(utilityChainUnconfigured()).resolves.toBe(true);
    } finally { restore(); }
  });

  it('FAIL-OPEN: a seat-resolution error answers false (never unconfigured on a transient read)', async () => {
    const restore = keylessModules({});
    try {
      jest.doMock('./model-endpoints/model-roles.service', () => ({
        __esModule: true,
        resolveRoleModel: jest.fn(async () => { throw new Error('db down'); }),
        resolveRoleFallback: jest.fn(async () => { throw new Error('db down'); }),
      }));
      const { utilityChainUnconfigured } = await import('../../utils/utility-llm');
      await expect(utilityChainUnconfigured()).resolves.toBe(false);
    } finally { restore(); }
  });
});

describe('the wiring — every degrade-forever surface consults the gate first', () => {
  it('GET /news: the formatter gate answers unconfigured (with the reason) BEFORE any cache-miss machinery', () => {
    const src = read('./crossmodel.controller.ts');
    const searchGate = src.indexOf("webSearchMissingOnInstance())");
    const formatterGate = src.indexOf("utilityChainUnconfigured())");
    const cacheMiss = src.indexOf('getNewsFromCache(userId)');
    const prefetchKick = src.indexOf('triggering background fetch');
    expect(searchGate).toBeGreaterThan(-1);
    expect(formatterGate).toBeGreaterThan(searchGate);
    expect(cacheMiss).toBeGreaterThan(formatterGate);
    expect(prefetchKick).toBeGreaterThan(formatterGate);
    expect(src).toContain("unconfiguredReason: 'formatter'");
  });

  it('GET /suggested-questions: the same gate answers unconfigured BEFORE the generation kick', () => {
    const src = read('./crossmodel.controller.ts');
    // The gate text appears TWICE (news handler first) — the suggested-questions
    // copy is the second. Scope to the suggested-questions handler block.
    const handlerStart = src.indexOf('async getSuggestedQuestions');
    const gate = src.indexOf('if (await utilityChainUnconfigured())', handlerStart);
    const generateKick = src.indexOf('generateQuestionsForUser(userId).catch', handlerStart);
    expect(handlerStart).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(handlerStart);
    expect(generateKick).toBeGreaterThan(gate);
    expect(src.slice(gate - 1400, gate)).toContain('suggested-questions.service');
  });

  it('the news scheduler tick skips on a structurally-missing formatter (news.service)', () => {
    const src = read('./news.service.ts');
    const tickGate = src.indexOf('if (await utilityChainUnconfigured())');
    const searchGate = src.indexOf('webSearchMissingOnInstance()) {');
    const breaker = src.indexOf('isSchedulerCircuitOpen())');
    expect(searchGate).toBeGreaterThan(-1);
    expect(tickGate).toBeGreaterThan(searchGate);
    expect(breaker).toBeGreaterThan(tickGate);
  });

  it('F1 (review 2026-10-27): the gates are CAPABILITY-keyed — no isProdInstance() conjunct anywhere in the three gate sites', () => {
    // An Edge deployed without DIGBY_INSTANCE reads as 'prod' (instanceKind
    // defaults unset→'prod'); a !isProdInstance() guard would silently
    // no-op the gates on exactly that box. The capability check is prod-safe
    // alone: env keys make it false before any config read.
    const controller = read('./crossmodel.controller.ts');
    const news = read('./news.service.ts');
    expect(controller).not.toMatch(/if\s*\(\s*!\s*isProdInstance\(\)\s*&&\s*await\s+utilityChainUnconfigured/);
    expect(news).not.toMatch(/!\s*prod\s*&&\s*\(?\s*await\s+utilityChainUnconfigured/);
    // And the bare gate is present exactly twice in the controller (news +
    // suggested-questions) and once in the scheduler tick.
    expect(controller.match(/if \(await utilityChainUnconfigured\(\)\)/g) || []).toHaveLength(2);
    expect(news.match(/if \(await utilityChainUnconfigured\(\)\)/g) || []).toHaveLength(1);
  });

  it('F2 (review 2026-10-27): the vision upgrade consults the vision_describe seat only via an OVERRIDE — never the effective default', () => {
    const src = read('./chat-agent/chat-agent.service.ts');
    // The seat read is override-only (roleOverrideForRun), NOT the effective
    // model (resolveRoleModelForRun would return the built-in glm-5.3-flash on
    // every untouched instance and displace the kimi-k3 whole-turn upgrade).
    expect(src).toContain("await roleOverrideForRun('vision_describe')");
    expect(src).not.toMatch(/resolveRoleModelForRun\(\s*['"]vision_describe['"]/);
    // And the ladder ORDER is: lead's custom fallback → the seat's admin
    // override → the built-in kimi-k3 leg. The override READ is hoisted above
    // the IIFE (for the log label); the ORDER lives in the guards inside it.
    const fallbackLeg = src.indexOf('if (orchestratorCustomFallback &&');
    const overrideGuard = src.indexOf('if (visionSeatOverride &&');
    const builtInLeg = src.indexOf('if (process.env.MOONSHOT_API_KEY) return VISION_ORCHESTRATOR_MODEL;');
    expect(fallbackLeg).toBeGreaterThan(-1);
    expect(overrideGuard).toBeGreaterThan(fallbackLeg);
    expect(builtInLeg).toBeGreaterThan(overrideGuard);
    // coding-model exports the override-only helper and documents why.
    const codingModel = read('./coding/coding-model.ts');
    expect(codingModel).toContain('export async function roleOverrideForRun');
  });

  it('the frontend news card renders a distinct formatter-missing message (page.tsx)', () => {
    const src = read('../../../../frontend/app/crossmodel/page.tsx');
    expect(src).toContain("newsUnconfiguredReason === 'formatter'");
    expect(src).toContain('background summarizer model');
    // The dishonest degrade-forever copy still exists for REAL outages —
    // the fix split the states, it did not delete the outage copy.
    expect(src).toContain('Personalized news is temporarily unavailable');
  });

  it('the suggested-questions poll chain stops on unconfigured (no ~140s poll of a dead pipeline)', () => {
    const src = read('../../../../frontend/app/crossmodel/page.tsx');
    const stop = src.indexOf('if (data.unconfigured) return;');
    expect(stop).toBeGreaterThan(-1);
    // And it sits before the pending re-poll arm.
    const repoll = src.indexOf('if (data.pending && attempt < 14)');
    expect(repoll).toBeGreaterThan(stop);
  });
});

describe('embedTexts on a keyless instance — config-shaped error, not a masked 401', () => {
  it('throws naming the Embeddings seat and DASHSCOPE_API_KEY, and never POSTs', async () => {
    const restore = keylessModules({});
    try {
      jest.doMock('./model-endpoints/model-roles.service', () => ({
        __esModule: true,
        getModelRoleOverrides: jest.fn(async () => ({})),
        getModelRoleFallbacks: jest.fn(async () => ({})),
      }));
      jest.doMock('./model-endpoints/model-endpoints.service', () => ({
        __esModule: true,
        resolveRegistryModel: jest.fn(async () => null),
      }));
      let posted = false;
      jest.doMock('axios', () => ({
        __esModule: true,
        default: { post: jest.fn(async () => { posted = true; throw new Error('must not POST'); }) },
      }));
      const { embedTexts } = await import('./rag.service');
      await expect(embedTexts(['hello'])).rejects.toThrow(/no embeddings backend configured[\s\S]*DASHSCOPE_API_KEY[\s\S]*Embeddings seat/);
      expect(posted).toBe(false);
    } finally { restore(); }
  });
});

describe('runMemoryEmbedBackfillOnce on a keyless instance — idles instead of erroring per row', () => {
  it('returns the idle summary and embeds nothing', async () => {
    const restore = keylessModules({});
    try {
      jest.doMock('./model-endpoints/model-roles.service', () => ({
        __esModule: true,
        getModelRoleOverrides: jest.fn(async () => ({})),
        getModelRoleFallbacks: jest.fn(async () => ({})),
      }));
      jest.doMock('./model-endpoints/model-endpoints.service', () => ({
        __esModule: true,
        resolveRegistryModel: jest.fn(async () => null),
      }));
      const { runMemoryEmbedBackfillOnce } = await import('./memory/embed-backfill.service');
      const summary = await runMemoryEmbedBackfillOnce({ now: new Date('2026-10-26T00:00:00Z') });
      expect(summary).toContain('idle (no embeddings backend configured');
    } finally { restore(); }
  });
});
