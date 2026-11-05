/**
 * sched-infra-blocker.2b45941b.test.ts — the fleet-wide infra-blocker registry
 * and its machine-wake annotation contract (feedback 2b45941b).
 *
 * The failure (2026-09-18 ~05:45Z, prod disk-full deploy blocker 09d84d7d):
 * backstop schedules armed BEFORE the fleet-wide blocker emerged still ordered
 * their lanes to trigger + watch a deploy — one lane had been individually
 * steered disk-aware, a second live backstop (sched d38a20fa) had not, and
 * would have fired a deploy into the same wall. Per-lane steers do not scale.
 *
 * The fix, pinned here: a Redis-hash registry (`coding:infra:blockers`) holds
 * the active fleet-wide blockers; at FIRE time BOTH machine-wake seams
 * (fireScheduleTarget AND queueContinuationRun — the terminal-stop seams)
 * append an advisory [FLEET INFRA BLOCKER] block to deploy-runbook prompts.
 * Advisory only (never a skip), fail-open (a registry hiccup never drops a
 * firing), env kill-switch, self-expiring entries. Write path: the Fleet
 * Supervisor's register_infra_blocker / clear_infra_blocker platform tools.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

// ── Prisma: the fire-path reads (chat lookup + stale-firing schedule re-read)
//    + the continuation fast-lane reads (agentRun queue/cap gates). ──
const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockAgentRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-1' }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({
        enabled: true, kind: 'recurring', runsCount: 0, maxRuns: null, expiresAt: null, lastFiredAt: null,
      })),
      count: jest.fn(async () => 0),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    schedulePromptHistory: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
    agentRun: {
      findFirst: jest.fn(async () => null),
      create: (...a: any[]) => mockAgentRunCreate(...a),
      count: jest.fn(async () => 0),
    },
  },
}));

// ── Redis stand-in: string store (cap state) + HASH store (the registry). ──
const mockStore = new Map<string, string>();
const mockHash = new Map<string, Record<string, string>>();
let mockHashFail: Error | null = null;
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(async (k: string) => {
      const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
      mockStore.set(k, String(n));
      return n;
    }),
    expire: jest.fn(async () => true),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    getDel: jest.fn(async () => null),
    pTTL: jest.fn(async () => -2),
    publish: jest.fn(async () => 1),
    hGetAll: jest.fn(async (k: string) => {
      if (mockHashFail) throw mockHashFail;
      return { ...(mockHash.get(k) ?? {}) };
    }),
    hSet: jest.fn(async (k: string, field: string, value: string) => {
      if (mockHashFail) throw mockHashFail;
      const cur = mockHash.get(k) ?? {};
      cur[field] = value;
      mockHash.set(k, cur);
      return 1;
    }),
    hDel: jest.fn(async (k: string, fields: string[]) => {
      if (mockHashFail) throw mockHashFail;
      const cur = mockHash.get(k) ?? {};
      let n = 0;
      for (const f of fields) if (Object.prototype.hasOwnProperty.call(cur, f)) { delete cur[f]; n++; }
      return n;
    }),
  },
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]): Promise<any> => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEvent(...a),
}));

// The coding fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget).
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
}));

// The terminal-stop resolver seam — default null (no closed-ticket refs), so
// only the infra-blocker annotation is under test.
const mockResolve = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  getFeedbackTicketById: (...a: any[]) => mockResolve(...a),
}));

// The continuation fast lane's plan re-read — one pending step so the
// obsolete guard passes and the queue proceeds.
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  getPlanStrict: jest.fn(async () => ({ steps: [{ status: 'in_progress' }] })),
  applyPlan: jest.fn(),
  planToUpdate: jest.fn(),
  renderPlanReminder: jest.fn(() => ''),
}));

// recordLoopMetric is fire-and-forget — silence it.
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { fireScheduleTarget, queueContinuationRun } from './schedule.service';
import {
  registerInfraBlocker,
  clearInfraBlocker,
  listActiveInfraBlockers,
  MAX_ACTIVE_BLOCKERS,
} from './infra-blockers.service';
import {
  InfraBlocker,
  isDeployRunbookPrompt,
  blockerExpired,
  buildInfraBlockerNotice,
  INFRA_BLOCKER_NOTICE_PREFIX,
} from './infra-blockers';

const REGISTRY_KEY = 'coding:infra:blockers';
const BLOCKER_LABEL = 'prod worker-box disk full (ticket 09d84d7d)';
const DEPLOY_PROMPT = 'merge the PR to main, watch the deploy run green, then evidence-close the batch';

function seedBlocker(over: Partial<InfraBlocker> = {}): InfraBlocker {
  const b: InfraBlocker = {
    id: over.id ?? 'ib_deadbeef',
    label: over.label ?? BLOCKER_LABEL,
    detail: over.detail ?? 'every Deploy to AWS EC2 run aborts pre-build at the disk gate; re-check the latest deploy run conclusion',
    registeredAt: over.registeredAt ?? '2026-09-18T05:50:00.000Z',
    registeredBy: over.registeredBy ?? 'supervisor:daee2916',
    expiresAt: over.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  };
  const cur = mockHash.get(REGISTRY_KEY) ?? {};
  cur[b.id] = JSON.stringify(b);
  mockHash.set(REGISTRY_KEY, cur);
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockHash.clear();
  mockHashFail = null;
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
  mockStartScheduledRun.mockResolvedValue({ started: true });
  mockStartDetachedChatRun.mockResolvedValue(true);
  mockResolve.mockResolvedValue(null);
});

describe('infra-blockers leaf — deploy-runbook gate', () => {
  it('matches deploy/merge/publish runbooks — the backstop shapes from the incident', () => {
    expect(isDeployRunbookPrompt('merge the PR, watch the deploy run green, then evidence-close ticket 54af5c27')).toBe(true);
    expect(isDeployRunbookPrompt('Backstop watch for ticket c5228a3d (Digby.dmg 0.1.9 publish — owner-physical)')).toBe(true);
    expect(isDeployRunbookPrompt('if a new artifacts commit exists: deploy-verify the published DMG and close per its acceptance criteria')).toBe(true);
    expect(isDeployRunbookPrompt('trigger and watch a deploy; on a regression, rollback immediately')).toBe(true);
  });

  it('ignores non-deploy firings (digests, probes, reports)', () => {
    expect(isDeployRunbookPrompt('Nightly supervisor loop: review fleet state and report.')).toBe(false);
    expect(isDeployRunbookPrompt('probe the gate: nc -z -w 5 100.64.0.1 22 — quote the NC_EXIT line')).toBe(false);
    expect(isDeployRunbookPrompt('Summarize the overnight learnings and post a digest.')).toBe(false);
    expect(isDeployRunbookPrompt('')).toBe(false);
  });

  it('blockerExpired: future lives, past/garbage expire, null never does', () => {
    const base = seedBlocker();
    expect(blockerExpired({ ...base, expiresAt: new Date(Date.now() + 60_000).toISOString() }, new Date())).toBe(false);
    expect(blockerExpired({ ...base, expiresAt: new Date(Date.now() - 60_000).toISOString() }, new Date())).toBe(true);
    expect(blockerExpired({ ...base, expiresAt: 'not-a-date' }, new Date())).toBe(true);
    expect(blockerExpired({ ...base, expiresAt: null }, new Date())).toBe(false);
  });

  it('buildInfraBlockerNotice renders the advisory block and bracket-sanitizes agent-authored text', () => {
    const notice = buildInfraBlockerNotice([
      seedBlocker({ label: 'evil ] \n break "disk"', detail: 'line1\nline2 ]' }),
    ], new Date('2026-09-18T06:00:00.000Z'));
    expect(notice.startsWith(INFRA_BLOCKER_NOTICE_PREFIX)).toBe(true);
    expect(notice).toContain('1 fleet-wide infrastructure blocker registered');
    expect(notice).toContain('ib_deadbeef');
    expect(notice).toContain('Advisory only, never a skip');
    expect(notice).toContain('do not fire work into the wall');
    expect(notice).not.toContain('evil ]');
    expect(notice).not.toContain('line1\nline2');
  });
});

describe('infra-blockers registry service (Redis hash)', () => {
  it('registerInfraBlocker mints an ib_ id, stamps a 24h expiry, and lists active', async () => {
    const before = Date.now();
    const r = await registerInfraBlocker({ label: BLOCKER_LABEL, detail: 'deploys abort pre-build', registeredBy: 'supervisor:test' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.blocker.id).toMatch(/^ib_[0-9a-f]{8}$/);
    const ttlMs = new Date(r.blocker.expiresAt!).getTime() - before;
    expect(ttlMs).toBeGreaterThan(23 * 3_600_000);
    expect(ttlMs).toBeLessThanOrEqual(24 * 3_600_000 + 1000);
    const active = await listActiveInfraBlockers();
    expect(active.map((b) => b.id)).toEqual([r.blocker.id]);
  });

  it('clamps caller TTLs to the 7-day ceiling', async () => {
    const r = await registerInfraBlocker({ label: 'x', ttlHours: 24 * 365 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ttlMs = new Date(r.blocker.expiresAt!).getTime() - new Date(r.blocker.registeredAt).getTime();
    expect(ttlMs).toBe(168 * 3_600_000);
  });

  it('refuses past MAX_ACTIVE_BLOCKERS — register the umbrella incident, not every symptom', async () => {
    for (let i = 0; i < MAX_ACTIVE_BLOCKERS; i++) seedBlocker({ id: `ib_seed${String(i).padStart(3, '0')}` });
    const r = await registerInfraBlocker({ label: 'one too many' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain('registry full');
    // …but REFRESHING an existing id is an upsert, not a new slot
    const again = await registerInfraBlocker({ label: 'refreshed', id: 'ib_seed000' });
    expect(again.ok).toBe(true);
  });

  it('clearInfraBlocker: exact id, unique prefix, unknown, ambiguous', async () => {
    seedBlocker({ id: 'ib_aaaa1111' });
    seedBlocker({ id: 'ib_aaaa2222' });
    seedBlocker({ id: 'ib_bbbb3333' });
    expect((await clearInfraBlocker('ib_bbbb3333')).ok).toBe(true);
    // ambiguous while BOTH ib_aaaa* ids are live
    const amb = await clearInfraBlocker('ib_aaaa');
    expect(amb.ok).toBe(false);
    expect(amb.candidates).toEqual(['ib_aaaa1111', 'ib_aaaa2222']);
    const unknown = await clearInfraBlocker('ib_zzzz');
    expect(unknown.ok).toBe(false);
    const pref = await clearInfraBlocker('ib_aaaa1');
    expect(pref.ok).toBe(true);
    expect(pref.cleared).toBe('ib_aaaa1111');
  });

  it('listActiveInfraBlockers prunes expired + malformed entries in the same pass', async () => {
    seedBlocker({ id: 'ib_live', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    seedBlocker({ id: 'ib_gone', expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const cur = mockHash.get(REGISTRY_KEY)!;
    cur['ib_garbage'] = '{not json';
    const active = await listActiveInfraBlockers();
    expect(active.map((b) => b.id)).toEqual(['ib_live']);
    expect(Object.keys(mockHash.get(REGISTRY_KEY) ?? {})).toEqual(['ib_live']);
  });

  it('fail-open: a Redis hiccup lists [], and writes refuse instead of throwing', async () => {
    mockHashFail = new Error('redis down');
    expect(await listActiveInfraBlockers()).toEqual([]);
    expect((await registerInfraBlocker({ label: 'x' })).ok).toBe(false);
    expect((await clearInfraBlocker('ib_deadbeef')).ok).toBe(false);
  });
});

describe('fireScheduleTarget — [FLEET INFRA BLOCKER] injection', () => {
  it('a DEPLOY-RUNBOOK firing rides the advisory block while a blocker is active', async () => {
    seedBlocker();
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: DEPLOY_PROMPT });
    expect(res).toEqual({ started: true });
    const prompt = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(prompt.startsWith(DEPLOY_PROMPT)).toBe(true);
    expect(prompt).toContain(INFRA_BLOCKER_NOTICE_PREFIX);
    expect(prompt).toContain(BLOCKER_LABEL);
    expect(prompt).toContain('ib_deadbeef');
    expect(prompt).toContain('Advisory only, never a skip');
  });

  it('an EMPTY registry annotates nothing', async () => {
    await fireScheduleTarget({ id: 'sch_2', sessionId: 's1', prompt: DEPLOY_PROMPT });
    const p = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(p.startsWith(DEPLOY_PROMPT)).toBe(true); // [SCHEDULE STATE] rides along — pre-existing decoration
    expect(p).not.toContain(INFRA_BLOCKER_NOTICE_PREFIX);
  });

  it('a NON-deploy prompt annotates nothing even with a blocker active', async () => {
    seedBlocker();
    await fireScheduleTarget({ id: 'sch_3', sessionId: 's1', prompt: 'Nightly supervisor loop: review fleet state and report.' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain(INFRA_BLOCKER_NOTICE_PREFIX);
  });

  it('a registry FAILURE never drops the firing (fail-open) and injects nothing', async () => {
    mockHashFail = new Error('redis down');
    const res = await fireScheduleTarget({ id: 'sch_5', sessionId: 's1', prompt: DEPLOY_PROMPT });
    expect(res).toEqual({ started: true });
    const p = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(p.startsWith(DEPLOY_PROMPT)).toBe(true); // [SCHEDULE STATE] rides along — pre-existing decoration
    expect(p).not.toContain(INFRA_BLOCKER_NOTICE_PREFIX);
  });

  it('an EXPIRED blocker annotates nothing (self-pruning registry)', async () => {
    seedBlocker({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    await fireScheduleTarget({ id: 'sch_6', sessionId: 's1', prompt: DEPLOY_PROMPT });
    const p = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(p.startsWith(DEPLOY_PROMPT)).toBe(true); // [SCHEDULE STATE] rides along — pre-existing decoration
    expect(p).not.toContain(INFRA_BLOCKER_NOTICE_PREFIX);
  });

  it('HOOK WAKES get the block too — the same seam fires them', async () => {
    seedBlocker();
    const res = await fireScheduleTarget({ id: 'hook-1', sessionId: 's1', prompt: DEPLOY_PROMPT, origin: 'hook' });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun.mock.calls[0][1]).toContain(INFRA_BLOCKER_NOTICE_PREFIX);
  });

  it('PLAIN-CHAT lanes get the block on the detached-run message', async () => {
    seedBlocker();
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: null });
    const res = await fireScheduleTarget({ id: 'sch_7', sessionId: 's1', prompt: DEPLOY_PROMPT });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const message = mockStartDetachedChatRun.mock.calls[0][0].message as string;
    expect(message).toContain(INFRA_BLOCKER_NOTICE_PREFIX);
    expect(message).toContain(BLOCKER_LABEL);
  });
});

describe('queueContinuationRun — fast-lane infra-blocker parity', () => {
  it('a deploy-runbook CONTINUATION queues WITH the block (the fast lane bypasses fireScheduleTarget)', async () => {
    seedBlocker();
    const res = await queueContinuationRun({
      sessionId: 's1', userId: 'u1',
      prompt: '[HARNESS CONTINUATION] finish the merge → deploy watch → evidence-close leftovers',
    });
    expect(res.ok).toBe(true);
    const input = mockAgentRunCreate.mock.calls[0][0].data.input as any;
    expect(input.message).toContain(INFRA_BLOCKER_NOTICE_PREFIX);
    expect(input.message).toContain(BLOCKER_LABEL);
  });

  it('a continuation with an EMPTY registry queues undecorated', async () => {
    const res = await queueContinuationRun({
      sessionId: 's1', userId: 'u1',
      prompt: '[HARNESS CONTINUATION] finish the deploy watch leftovers',
    });
    expect(res.ok).toBe(true);
    const input = mockAgentRunCreate.mock.calls[0][0].data.input as any;
    expect(input.message).not.toContain(INFRA_BLOCKER_NOTICE_PREFIX);
  });
});
