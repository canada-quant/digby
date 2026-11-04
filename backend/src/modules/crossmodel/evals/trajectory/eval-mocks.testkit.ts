/**
 * Trajectory evals — the module SEAMS (build 2026-10-08 E-6). JEST ONLY.
 *
 * Import this module FIRST in an eval test file (before ./runner): it
 * registers the jest module mocks that put the REAL agent loop on frozen
 * inputs. Only the true infrastructure boundaries are replaced:
 *
 *   - the provider call (coding-model runModelTurn) → the replay model, or the
 *     real call recorded (live);
 *   - the three tool executors (coding/tools executeCodingTool, the web
 *     ToolCache, coding-integrations executeIntegrationTool) → the case's
 *     fixtures; mutating tools are captured, never executed;
 *   - the registry / seat lookups (gateway seats resolve from the case);
 *   - the DB, Redis, env, logger, context store, metrics sink, clock blocks.
 *
 * Every seam consults the CURRENT trial (eval-runtime.ts AsyncLocalStorage);
 * outside a trial the real implementation answers.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

jest.mock('../../../../utils/logger', () => ({
  __esModule: true,
  default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// A null database: every model method answers an empty / echo result, so
// fire-and-forget writes and best-effort reads inside the loop succeed
// harmlessly (the eval grades captured tool calls, never DB rows).
jest.mock('../../../../config/database', () => {
  const echo = async (a: any) => ({ id: `eval-row-${Math.random().toString(36).slice(2, 10)}`, ...(a?.data ?? a?.create ?? {}) });
  const model = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'findMany' || prop === 'groupBy') return async () => [];
      if (prop === 'findFirst' || prop === 'findUnique' || prop === 'findFirstOrThrow' || prop === 'findUniqueOrThrow') return async () => null;
      if (prop === 'count') return async () => 0;
      if (prop === 'aggregate') return async () => ({ _sum: {}, _count: {}, _max: {}, _min: {} });
      if (prop === 'create' || prop === 'update' || prop === 'upsert') return echo;
      if (prop === 'createMany' || prop === 'updateMany' || prop === 'deleteMany') return async () => ({ count: 0 });
      if (prop === 'delete') return async () => ({});
      return undefined;
    },
  });
  const client: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === '$transaction') return async (arg: any) => (typeof arg === 'function' ? arg(client) : Promise.all(arg));
      if (prop === '$queryRaw' || prop === '$queryRawUnsafe') return async () => [];
      if (prop === '$executeRaw' || prop === '$executeRawUnsafe') return async () => 0;
      if (prop === '$connect' || prop === '$disconnect') return async () => {};
      if (prop === 'then') return undefined;
      return model;
    },
  });
  return { __esModule: true, default: client };
});

jest.mock('../../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'e'.repeat(32), JWT_REFRESH_SECRET: 'f'.repeat(32), REDIS_URL: 'redis://eval.invalid:0' },
}));

jest.mock('../../../../config/redis', () => {
  const kv = new Map<string, string>();
  const client: any = new Proxy({}, {
    get(_t, prop: string) {
      if (prop === 'get') return async (k: string) => kv.get(k) ?? null;
      if (prop === 'set') return async (k: string, v: string) => { kv.set(k, String(v)); return 'OK'; };
      if (prop === 'del') return async (k: string) => (kv.delete(k) ? 1 : 0);
      if (prop === 'isOpen' || prop === 'isReady') return false;
      if (prop === 'then') return undefined;
      return async () => null;
    },
  });
  return { __esModule: true, default: client, connectRedis: async () => {}, redisSubscriber: { subscribe: async () => {}, on: () => {} } };
});

jest.mock('../../github/github-mcp', () => ({ __esModule: true, isGitHubMcpConfigured: () => false, callGitHubMcpTool: async () => '' }));
jest.mock('../../google/google-mcp', () => ({ __esModule: true, isGoogleMcpConfigured: () => false, callGoogleMcpTool: async () => '' }));
jest.mock('../../imessage/agent-link', () => ({ agentBroker: { dispatch: async () => ({ ok: false }) } }));

// ── the provider call ────────────────────────────────────────────────────────
jest.mock('../../coding/coding-model', () => {
  const actual = jest.requireActual('../../coding/coding-model');
  const rt = require('./eval-runtime');
  return { ...actual, runModelTurn: (...a: any[]) => rt.evalRunModelTurn(actual.runModelTurn, a) };
});

// ── the three tool executors ────────────────────────────────────────────────
jest.mock('../../coding/tools', () => {
  const actual = jest.requireActual('../../coding/tools');
  const rt = require('./eval-runtime');
  return {
    ...actual,
    executeCodingTool: async (ctx: any, name: string, args: any) => {
      const out = rt.evalToolCall(name, args, ctx?.allowedTools ? 'worker' : 'lead');
      return out ?? actual.executeCodingTool(ctx, name, args);
    },
  };
});

jest.mock('../../tool-executor', () => {
  const actual = jest.requireActual('../../tool-executor');
  const rt = require('./eval-runtime');
  class EvalToolCache extends actual.ToolCache {
    async getOrExecute(name: string, args: any): Promise<string> {
      const out = rt.evalToolCall(name, args);
      return out ?? super.getOrExecute(name, args);
    }
  }
  return { ...actual, ToolCache: EvalToolCache };
});

jest.mock('../../coding/coding-integrations', () => {
  const actual = jest.requireActual('../../coding/coding-integrations');
  const rt = require('./eval-runtime');
  return {
    ...actual,
    executeIntegrationTool: async (userId: string, name: string, args: any, ctx: any) => {
      const out = rt.evalToolCall(name, args);
      return out ?? actual.executeIntegrationTool(userId, name, args, ctx);
    },
  };
});

// ── registry / seats ────────────────────────────────────────────────────────
jest.mock('../../model-endpoints/model-endpoints.service', () => {
  const actual = jest.requireActual('../../model-endpoints/model-endpoints.service');
  const rt = require('./eval-runtime');
  return {
    ...actual,
    resolveRegistryModel: async (spec: string, userId?: string) => {
      const t = rt.currentTrial();
      return t ? t.registry(spec) : actual.resolveRegistryModel(spec, userId);
    },
  };
});

jest.mock('../../model-endpoints/model-roles.service', () => {
  const actual = jest.requireActual('../../model-endpoints/model-roles.service');
  const rt = require('./eval-runtime');
  return {
    ...actual,
    resolveRoleFallback: async (...a: any[]) => {
      const t = rt.currentTrial();
      return t ? (t.fallbackModel ?? '') : actual.resolveRoleFallback(...a);
    },
    resolveRoleModel: async (...a: any[]) => {
      const t = rt.currentTrial();
      return t ? '' : actual.resolveRoleModel(...a);
    },
  };
});

// ── sinks + side services the loop touches ──────────────────────────────────
jest.mock('../../platform/loop-metrics.service', () => {
  const actual = jest.requireActual('../../platform/loop-metrics.service');
  const rt = require('./eval-runtime');
  const capture = (row: any) => { const t = rt.currentTrial(); if (t && row) t.metrics.push({ kind: row.kind, meta: row.meta }); };
  return {
    ...actual,
    recordLoopMetric: capture,
    recordLoopMetrics: (rows: any[]) => (rows || []).forEach(capture),
    recordRunSpend: () => {},
    noteSeatFallback: (n: any) => capture({ kind: 'seat_fallback', meta: n }),
    noteUtilityLlmFailure: () => {},
    flushLoopMetrics: async () => {},
  };
});

jest.mock('../../feedback/feedback.service', () => {
  const actual = jest.requireActual('../../feedback/feedback.service');
  return { ...actual, fileFeedbackTicket: async () => ({ id: 'eval-ticket' }) };
});

jest.mock('../../memory/context-store', () => {
  const rt = require('./eval-runtime');
  const key = (ns: string[], k: string) => `${(ns || []).join('/')}::${k}`;
  const mem = () => rt.currentTrial()?.store ?? new Map();
  return {
    __esModule: true,
    storeGet: async (ns: string[], k: string) => mem().get(key(ns, k)) ?? null,
    storePut: async (ns: string[], k: string, v: unknown) => { mem().set(key(ns, k), v); },
    storeCreate: async (ns: string[], k: string, v: unknown) => { const m = mem(); if (m.has(key(ns, k))) return false; m.set(key(ns, k), v); return true; },
    storeDelete: async (ns: string[], k: string) => { mem().delete(key(ns, k)); },
  };
});

jest.mock('../../coding/datetime-context', () => {
  const actual = jest.requireActual('../../coding/datetime-context');
  const rt = require('./eval-runtime');
  const nowIso = () => (rt.currentTrial()?.now ?? new Date()).toISOString();
  return {
    ...actual,
    loadUserTimezone: async () => rt.currentTrial()?.timezone ?? 'UTC',
    buildCodingDateTimeBlock: () => `[CURRENT DATE & TIME]\nCurrent time (UTC): ${nowIso()}`,
    buildCodingClockNote: () => `[HARNESS CLOCK — not typed by the user] Current time: ${nowIso()}.`,
    buildChatWakeClockNote: () => `[HARNESS CLOCK — not typed by the user] Current time: ${nowIso()}.`,
  };
});

// Workspace / journal / retrieval services: the real module with its I/O
// entry points stubbed (a chat-profile trial has no worktree or container).
jest.mock('../../coding/run-journal.service', () => ({
  ...jest.requireActual('../../coding/run-journal.service'),
  getRecentJournalEntries: async () => [],
  formatJournalBlock: () => '',
}));
jest.mock('../../coding/container.service', () => ({
  ...jest.requireActual('../../coding/container.service'),
  ensureSessionContainer: async () => false,
  execInContainer: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  isContainerMode: () => false,
  reapOrphanedBuildProcesses: async () => {},
  workspaceExecExposure: () => null,
}));
jest.mock('../../coding/session-credentials', () => ({
  ...jest.requireActual('../../coding/session-credentials'),
  gatherSessionCredentialEnv: async () => ({}),
  credentialEnvNote: () => '',
}));
jest.mock('../../coding/code-index.service', () => ({
  ...jest.requireActual('../../coding/code-index.service'),
  kickCodeIndexSync: () => {},
  buildCodeMatchesBlock: async () => '',
  searchCodeSemantic: async () => [],
}));
jest.mock('../../github/token-manager', () => ({ ...jest.requireActual('../../github/token-manager'), getValidToken: async () => null }));
jest.mock('../../coding/coding-retrieval.service', () => ({
  ...jest.requireActual('../../coding/coding-retrieval.service'),
  storeFindings: async () => 0,
  buildSessionMemoryInventory: async () => '',
  searchMemory: async () => [],
  clearSessionMemory: async () => {},
}));
jest.mock('../../coding/verify-state', () => {
  const actual = jest.requireActual('../../coding/verify-state');
  return { ...actual, recordVerify: async () => {}, getVerifyState: async () => null, recordVerifyAbsent: async () => {} };
});
jest.mock('../../../../utils/utility-llm', () => {
  const actual = jest.requireActual('../../../../utils/utility-llm');
  // Background helper calls (summaries, extractors) fail closed → every caller takes its fail-open path; no hidden spend.
  return { ...actual, utilityChat: async () => { throw new Error('utility LLM disabled in trajectory evals'); } };
});

// Nobody is at the keyboard during a trial: ask_user gets no answer and an
// approval prompt is denied at once (a live trial must never block for the
// real one-hour human wait).
jest.mock('../../coding/question-registry', () => {
  const actual = jest.requireActual('../../coding/question-registry');
  const rt = require('./eval-runtime');
  return { ...actual, awaitAnswer: (...a: any[]) => (rt.currentTrial() ? Promise.resolve(null) : actual.awaitAnswer(...a)) };
});
jest.mock('../../coding/approval-registry', () => {
  const actual = jest.requireActual('../../coding/approval-registry');
  const rt = require('./eval-runtime');
  return { ...actual, awaitApproval: (...a: any[]) => (rt.currentTrial() ? Promise.resolve('deny') : actual.awaitApproval(...a)) };
});

// Decision-gate asks inside a trial answer "no decision" (the documented
// fail-open — every caller then runs its pre-gate path): no Jev / logprob
// calls, no hidden spend, deterministic replays.
jest.mock('../../platform/decision-gate', () => {
  const actual = jest.requireActual('../../platform/decision-gate');
  const rt = require('./eval-runtime');
  return { ...actual, decide: async (...a: any[]) => (rt.currentTrial() ? null : actual.decide(...a)) };
});

// OFFLINE MEANS OFFLINE: inside a REPLAY trial every axios / fetch call is
// refused (recorded as eval_network_blocked) — a replay can never reach a
// provider, a gateway or the web. Live trials and code outside a trial pass
// through untouched.
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const rt = require('./eval-runtime');
  const guard = (name: string) => (...a: any[]) => {
    const t = rt.currentTrial();
    if (t && t.mode === 'replay') {
      t.metrics.push({ kind: 'eval_network_blocked', meta: { via: `axios.${name}`, url: String(a[0]?.url ?? a[0] ?? '').slice(0, 200) } });
      return Promise.reject(new Error(`trajectory replay: network call blocked (axios.${name})`));
    }
    return (actual as any)[name](...a);
  };
  const wrapped: any = Object.assign((...a: any[]) => guard('request')(...a), actual, {
    get: guard('get'), post: guard('post'), put: guard('put'), patch: guard('patch'), delete: guard('delete'), request: guard('request'),
  });
  wrapped.default = wrapped;
  return wrapped;
});

{
  const rt = require('./eval-runtime');
  const realFetch = (globalThis as any).fetch;
  if (typeof realFetch === 'function' && !(realFetch as any).__evalGuarded) {
    const guarded = (...a: any[]) => {
      const t = rt.currentTrial();
      if (t && t.mode === 'replay') {
        t.metrics.push({ kind: 'eval_network_blocked', meta: { via: 'fetch', url: String(a[0]?.url ?? a[0] ?? '').slice(0, 200) } });
        return Promise.reject(new Error('trajectory replay: network call blocked (fetch)'));
      }
      return realFetch(...a);
    };
    (guarded as any).__evalGuarded = true;
    (globalThis as any).fetch = guarded;
  }
}

export {};
