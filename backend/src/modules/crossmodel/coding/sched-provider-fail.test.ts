/**
 * cff523e7 — SILENT provider-killed scheduled runs.
 *
 * The bug: a scheduled monitoring run whose provider 429s and exhausts the agent
 * loop's 3 transient retries finalizes as a SUCCESS everywhere (agent_runs
 * 'completed', coding_schedules.lastStatus 'started', a run_completed hook
 * event) because the modelErrored signal never left the agent loop — ~6
 * consecutive silent failures once delayed incident detection ~1h15m.
 *
 * The fix, pinned here:
 *  (a) fireScheduleTarget stamps the REAL schedule row id onto the queued run
 *      input — but NEVER on a hook wake (hook-${hookId} synthetic ids);
 *  (b) the agent loop propagates the provider-gave-up signal on AgentRunResult
 *      (modelErrored + status + kind) — a clean finish carries none of it;
 *  (c) recordScheduleProviderFail counts CONSECUTIVE provider-killed runs per
 *      schedule and at the threshold sets a digest-visible lastStatus +
 *      fires attention_needed;
 *  (d) a genuine success resets the streak;
 *  (e) the attention event fires ONCE per crossing (NX gate) and re-arms after
 *      a reset.
 * The executor-level wiring (schedule-triggered finalize → these helpers) is
 * covered in run-executor.test.ts ('provider-killed scheduled runs' describe).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// config/env calls process.exit(1) without env vars and kills the jest worker at
// import (agent → tools → platform-tools → platform.service reaches it).
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

// ── Prisma: the schedule lastStatus write + the fireScheduleTarget chat lookup. ──
const mockScheduleUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockChatFindUnique = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    codingSchedule: {
      update: (...a: any[]) => mockScheduleUpdate(...a),
      // fbe65673: fireScheduleTarget's stale-firing guard re-reads the row at
      // fire time — default ENABLED so these fire-path tests proceed.
      findUnique: jest.fn(async (..._a: any[]): Promise<any> => ({ enabled: true })),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
  },
}));

// ── Redis: small in-memory stand-in with REAL INCR + SET-NX semantics, so the
//    once-per-crossing gate is exercised honestly rather than by stub returns. ──
const mockStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(async (k: string) => {
      const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
      mockStore.set(k, String(n));
      return n;
    }),
    expire: jest.fn(async () => true),
    set: jest.fn(async (k: string, v: string, opts?: any) => {
      if (opts?.NX && mockStore.has(k)) return null;
      mockStore.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => { mockStore.delete(k); return 1; }),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    publish: jest.fn(async () => 1),
  },
}));

// The hook-event emission seam (schedule.service's local emitHookEventSafe
// dynamic-imports hooks.service and calls emitHookEvent).
const mockEmitHookEvent = jest.fn(async (..._a: any[]) => {});
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

// ── agent.ts graph seams: the REAL agentLoop runs in the (b) cases with only the
//    model turn + the IO-boundary services stubbed. ──
const mockRunModelTurn = jest.fn();
jest.mock('./coding-model', () => ({
  ...(jest.requireActual('./coding-model')),
  seatUnservableReason: async () => null, // worker pre-flight (2026-09-08) — every seat servable here
  runModelTurn: (...a: any[]) => mockRunModelTurn(...a),
}));
jest.mock('./coding-memory.service', () => ({
  __esModule: true,
  getUserCodingMemory: jest.fn(async () => null),
  getProjectMemory: jest.fn(async () => null),
  getSessionMemory: jest.fn(async () => null),
  formatCodingMemoryBlock: jest.fn(() => ''),
  updateCodingMemoryAsync: jest.fn(),
}));
jest.mock('./run-journal.service', () => ({
  __esModule: true,
  getRecentJournalEntries: jest.fn(async () => []),
  formatJournalBlock: jest.fn(() => ''),
}));
jest.mock('./run-receipts.service', () => ({ __esModule: true, recordRunReceiptAsync: jest.fn() }));
jest.mock('./datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: jest.fn(async () => 'UTC'),
  buildCodingDateTimeBlock: jest.fn(() => ''),
  buildCodingClockNote: jest.fn(() => '[HARNESS CLOCK — test]'),
  buildChatWakeClockNote: jest.fn(() => ""),
}));
jest.mock('../github/token-manager', () => ({ __esModule: true, getValidToken: jest.fn(async () => 'tok') }));
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: jest.fn(async () => null),
  execInContainer: jest.fn(),
  isContainerMode: jest.fn(() => false),
}));
jest.mock('./session-credentials', () => ({
  __esModule: true,
  gatherSessionCredentialEnv: jest.fn(async () => ({})),
  credentialEnvNote: jest.fn(() => ''),
}));
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  getPlanStrict: jest.fn(async () => null),
  applyPlan: jest.fn(),
  planToUpdate: jest.fn(),
  renderPlanReminder: jest.fn(() => ''),
}));
jest.mock('./code-index.service', () => ({ __esModule: true, kickCodeIndexSync: jest.fn(), buildCodeMatchesBlock: jest.fn(async () => '') }));
jest.mock('./coding-retrieval.service', () => ({ __esModule: true, storeFindings: jest.fn(async () => 0), buildSessionMemoryInventory: jest.fn(async () => '') }));
jest.mock('./verify-state', () => ({ __esModule: true, recordVerify: jest.fn(async () => {}) }));
jest.mock('./usage-store', () => ({
  __esModule: true,
  loadSessionUsage: jest.fn(async () => ({})),
  commitRunUsage: jest.fn(async (_s: string, snap: any) => snap),
  mergeRunIntoSession: jest.fn((_prior: any, snap: any) => snap),
  emptySessionUsage: jest.fn(() => ({})),
}));
// No verify chain + zero loop budgets: a clean one-turn finish exits immediately
// (the auto-verify / goal-continue gates are not what these cases exercise).
jest.mock('./verify.service', () => ({
  __esModule: true,
  readDigbyConfig: jest.fn(async () => null),
  resolveVerifyChain: jest.fn(() => []),
  runVerifyChain: jest.fn(),
  loopConfig: jest.fn(() => ({
    maxAutoContinueRounds: 0, maxAutoVerifyIterations: 0, resumeStepBudget: 30,
    sameFailureStop: 3, oscillationWindow: 5, perCommandTimeoutMs: 1000,
  })),
  failureSignature: jest.fn(() => ''),
  renderVerifyFeedback: jest.fn(() => ''),
}));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  // Keep the REAL constants (platform-tools.ts reads FEEDBACK_TYPES at module
  // load); stub only the ticket-writing entry the billing path fires.
  ...(jest.requireActual('../feedback/feedback.service')),
  fileFeedbackTicket: jest.fn(async () => ({})),
}));

// Integration wrapper modules pulled in transitively via tools → platform-tools
// (same base set as coding-integrations.test.ts — they must never load for real).
jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(), listIssues: jest.fn(), getIssue: jest.fn(), listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(), getGmailMessages: jest.fn(), getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(), getCalendarEvents: jest.fn(), listDriveFiles: jest.fn(),
  getDocContent: jest.fn(), getSheetData: jest.fn(),
}));
jest.mock('../slack/slack-mcp', () => ({
  searchMessages: jest.fn(), listChannels: jest.fn(), getChannelHistory: jest.fn(),
}));
jest.mock('../asana/asana-mcp', () => ({
  searchTasks: jest.fn(), listMyTasks: jest.fn(), listProjects: jest.fn(),
}));
jest.mock('../x/x-mcp', () => ({
  search: jest.fn(), getUserProfile: jest.fn(), getTrends: jest.fn(),
}));
jest.mock('../xero/xero-mcp', () => ({
  getOrganisation: jest.fn(), getContacts: jest.fn(), getInvoices: jest.fn(),
}));
jest.mock('../plaid/plaid-mcp', () => ({
  getAccounts: jest.fn(), getBalances: jest.fn(), getTransactions: jest.fn(),
}));
jest.mock('../imessage/imessage.service', () => ({
  getPrimaryAgent: jest.fn(), isOnline: jest.fn(),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));

import {
  fireScheduleTarget,
  recordScheduleProviderFail,
  providerFailLastStatus,
  resetScheduleProviderFail,
  PROVIDER_FAIL_ALERT_THRESHOLD,
} from './schedule.service';
import { runCodingAgent } from './agent';
import type { AgentRunInput } from './agent';

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
  mockStartScheduledRun.mockResolvedValue({ started: true });
});

describe('(a) fireScheduleTarget scheduleId stamping', () => {
  it('a REAL schedule firing rides startScheduledRun with scheduleId = the row id', async () => {
    const res = await fireScheduleTarget({ id: 'sch_1', sessionId: 's1', prompt: 'check the monitor' });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    const [sessionId, prompt, opts] = mockStartScheduledRun.mock.calls[0];
    expect(sessionId).toBe('s1');
    expect(prompt).toBe('check the monitor');
    expect(opts).toEqual({ origin: 'schedule', scheduleId: 'sch_1' });
  });

  it('an explicit origin:schedule firing is stamped the same way', async () => {
    await fireScheduleTarget({ id: 'sch_2', sessionId: 's1', prompt: 'check again', origin: 'schedule' });
    expect(mockStartScheduledRun.mock.calls[0][2]).toEqual({ origin: 'schedule', scheduleId: 'sch_2' });
  });

  it('a HOOK WAKE (synthetic hook-${hookId} id) is NEVER stamped — it is not a schedule firing', async () => {
    const res = await fireScheduleTarget({ id: 'hook-42', sessionId: 's1', prompt: 'hook wake delivery', origin: 'hook' });
    expect(res).toEqual({ started: true });
    const opts = mockStartScheduledRun.mock.calls[0][2];
    expect(opts).toEqual({ origin: 'hook' });
    expect(opts).not.toHaveProperty('scheduleId');
  });
});

describe('(c)+(d)+(e) recordScheduleProviderFail / resetScheduleProviderFail', () => {
  const KEY = 'coding:sched:provfail:sch_1';
  const GATE = 'coding:sched:provfail:alerted:sch_1';
  const fail = (runId?: string) =>
    recordScheduleProviderFail('sch_1', 's1', { status: 429, kind: 'transient', runId });

  it('below the threshold: counts but stays silent (no lastStatus write, no event)', async () => {
    expect(await fail('r1')).toBe(1);
    expect(await fail('r2')).toBe(2);
    expect(PROVIDER_FAIL_ALERT_THRESHOLD).toBe(3); // pin the contract
    expect(mockStore.get(KEY)).toBe('2');
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  it('AT the threshold: digest-visible lastStatus + ONE attention_needed with the full payload', async () => {
    await fail('r1');
    await fail('r2');
    expect(await fail('r3')).toBe(3);
    expect(mockScheduleUpdate).toHaveBeenCalledWith({
      where: { id: 'sch_1' },
      data: { lastStatus: 'error:provider_429' },
    });
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    const [chatId, eventType, summary, extra] = mockEmitHookEvent.mock.calls[0];
    expect(chatId).toBe('s1');
    expect(eventType).toBe('attention_needed');
    expect(summary).toContain('3 consecutive scheduled runs');
    expect(summary).toContain('HTTP 429');
    expect(extra).toMatchObject({
      scheduleId: 'sch_1', sessionId: 's1', consecutiveFailures: 3,
      modelErrorStatus: 429, modelErrorKind: 'transient', runId: 'r3',
    });
  });

  it('past the threshold the event does NOT spam (NX gate) but lastStatus is re-asserted', async () => {
    await fail('r1');
    await fail('r2');
    await fail('r3');
    expect(await fail('r4')).toBe(4);
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1); // still the one crossing event
    expect(mockScheduleUpdate).toHaveBeenCalledTimes(2); // idempotent re-assert at n=3 and n=4
    expect(mockStore.get(KEY)).toBe('4');
    expect(mockStore.get(GATE)).toBe('3'); // the gate holds the crossing count
  });

  it('a genuine success RESETS the streak + the gate; a NEW crossing re-alerts', async () => {
    await fail('r1');
    await fail('r2');
    await fail('r3');
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);

    await resetScheduleProviderFail('sch_1');
    expect(mockStore.has(KEY)).toBe(false);
    expect(mockStore.has(GATE)).toBe(false);

    // Fresh streak: below threshold again → silent; crossing again → ONE new event.
    await fail('r4');
    await fail('r5');
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(1);
    expect(await fail('r6')).toBe(3);
    expect(mockEmitHookEvent).toHaveBeenCalledTimes(2);
    expect(mockEmitHookEvent.mock.calls[1][3]).toMatchObject({ consecutiveFailures: 3, runId: 'r6' });
  });

  it('best-effort: a Redis outage returns 0 and never throws into the finalize path', async () => {
    const redis = require('../../../config/redis').default;
    redis.incr.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(fail('rX')).resolves.toBe(0);
    expect(mockScheduleUpdate).not.toHaveBeenCalled();
    expect(mockEmitHookEvent).not.toHaveBeenCalled();
  });

  // Ticket d36344ed — a 30-min monitor on a tool-less seat died 3+ firings in
  // a row (HTTP 400 capability) and the digest called it "error:provider_429".
  it('the digest-visible lastStatus names the REAL cause (a capability 400 is not a 429)', async () => {
    expect(providerFailLastStatus({ status: 400, kind: 'capability' })).toBe('error:provider_400');
    expect(providerFailLastStatus({ status: 429, kind: 'transient' })).toBe('error:provider_429');
    expect(providerFailLastStatus({ kind: 'billing' })).toBe('error:provider_billing');
    expect(providerFailLastStatus()).toBe('error:provider_killed');
    const cap = () => recordScheduleProviderFail('sch_1', 's1', { status: 400, kind: 'capability', runId: 'c' });
    await cap(); await cap(); await cap();
    expect(mockScheduleUpdate).toHaveBeenCalledWith({ where: { id: 'sch_1' }, data: { lastStatus: 'error:provider_400' } });
    const summary = mockEmitHookEvent.mock.calls[0][2] as string;
    expect(summary).toContain('HTTP 400');
    expect(summary).toContain('each finalized as a FAILED run');
    expect(summary).toContain('rejects the request shape');
    expect(summary).not.toContain('silent SUCCESS');
    expect(mockEmitHookEvent.mock.calls[0][3]).toMatchObject({ paused: false });
  });

  it('the cadence is NOT paused at the crossing (gate flip 2026-09-11 — observe only)', async () => {
    await fail('r1'); await fail('r2'); await fail('r3');
    for (const call of mockScheduleUpdate.mock.calls) expect(call[0].data).not.toHaveProperty('enabled');
    expect(mockEmitHookEvent.mock.calls.map((c) => c[1])).toEqual(['attention_needed']);
  });
});

describe('(b) agentLoop propagates the provider-gave-up signal on AgentRunResult', () => {
  const baseInput = (): AgentRunInput => ({
    worktree: '/tmp/wt-cff523e7-nonexistent',
    sessionId: 's1',
    projectId: 'p1',
    userId: 'u1',
    permissionMode: 'auto',
    model: 'kimi-k3',
    projectName: 'proj',
    branch: 'digby/x',
    history: [],
    userMessage: 'run the monitor check',
    emit: jest.fn(),
  });

  it('a BILLING-class provider rejection fail-fasts and surfaces modelErrored + status + kind', async () => {
    // Keyed-shell determinism (2026-09-17): with ZAI/DEEPSEEK/MOONSHOT keys in
    // the env the lead-seat HTTP fallback (1b1d81f35) finds a servable built-in
    // and RETRIES instead of fail-fasting (CI is keyless). Scrub for this test.
    const savedKeys = { ZAI_API_KEY: process.env.ZAI_API_KEY, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY };
    delete process.env.ZAI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    try {
      mockRunModelTurn.mockResolvedValue({
        content: '', reasoning: '', toolCalls: [], finishReason: 'error',
        errorMessage: 'Error code: 429 — account suspended due to insufficient balance',
        errorStatus: 429,
      });
      const result = await runCodingAgent(baseInput());
      expect(mockRunModelTurn).toHaveBeenCalledTimes(1); // fail-fast: no futile retries
      expect(result.modelErrored).toBe(true);
      expect(result.modelErrorStatus).toBe(429);
      expect(result.modelErrorKind).toBe('billing');
      expect(result.finalText).toContain('PROVIDER BILLING OUTAGE');
    } finally {
      if (savedKeys.ZAI_API_KEY !== undefined) process.env.ZAI_API_KEY = savedKeys.ZAI_API_KEY;
      if (savedKeys.DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = savedKeys.DEEPSEEK_API_KEY;
      if (savedKeys.MOONSHOT_API_KEY !== undefined) process.env.MOONSHOT_API_KEY = savedKeys.MOONSHOT_API_KEY;
    }
  });

  it('a clean finish carries NO provider-gave-up trace (the counter only keys off its presence)', async () => {
    mockRunModelTurn.mockResolvedValue({
      content: 'Monitor is healthy.', reasoning: '', toolCalls: [], finishReason: 'stop',
    });
    const result = await runCodingAgent(baseInput());
    expect(result.finalText).toBe('Monitor is healthy.');
    expect(result.modelErrored).toBeUndefined();
    expect(result).not.toHaveProperty('modelErrored');
    expect(result).not.toHaveProperty('modelErrorStatus');
    expect(result).not.toHaveProperty('modelErrorKind');
  });

  it('review B1 (ticket 63e9a3cb): checkpoint payloads never carry the transient [HARNESS CLOCK] note or <plan> reminder', async () => {
    mockRunModelTurn.mockResolvedValue({
      content: 'done', reasoning: '', toolCalls: [], finishReason: 'stop',
    });
    // Capture the payload as the PERSISTED layer would see it (JSON round-trip)
    // — the pre-fix race serialized the LIVE array after the loop had pushed
    // its per-turn transients into it.
    const checkpoints: any[] = [];
    await runCodingAgent({
      ...baseInput(),
      onCheckpoint: (cp: any) => { checkpoints.push(JSON.parse(JSON.stringify(cp))); },
    });
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const cp of checkpoints) {
      const blob = JSON.stringify(cp.messages);
      expect(blob).not.toContain('[HARNESS CLOCK');
      expect(blob).not.toContain('<plan>');
    }
  });

  it('review B1 (ticket 63e9a3cb): resume replay strips transient harness messages leaked into old checkpoints', async () => {
    mockRunModelTurn.mockResolvedValue({
      content: 'resumed done', reasoning: '', toolCalls: [], finishReason: 'stop',
    });
    const resumeFrom = {
      version: 1,
      step: 1,
      stepBudget: 4,
      phase: 'preModel',
      messages: [
        { role: 'system', content: 'OLD STALE SYSTEM PROMPT FROM CHECKPOINT' },
        { role: 'user', content: 'original ask' },
        { role: 'system', content: '[HARNESS CLOCK — STALE FROM CHECKPOINT] 2020-01-01T00:00:00.000Z' },
        { role: 'assistant', content: 'working on it' },
        { role: 'system', content: '<plan>REMINDER-FROM-CHECKPOINT</plan>' },
      ],
    };
    await runCodingAgent({ ...baseInput(), resumeFrom: resumeFrom as any });
    const seen = mockRunModelTurn.mock.calls[0][1] as any[];
    const blob = JSON.stringify(seen);
    // the leaked transients are gone — a stale clock note must never come back
    expect(blob).not.toContain('STALE FROM CHECKPOINT');
    expect(blob).not.toContain('REMINDER-FROM-CHECKPOINT');
    // the checkpoint's stale system prompt is replaced by the fresh one, and
    // the real conversation survives intact
    expect(blob).not.toContain('OLD STALE SYSTEM PROMPT FROM CHECKPOINT');
    expect(blob).toContain('original ask');
    expect(blob).toContain('working on it');
  });
});
