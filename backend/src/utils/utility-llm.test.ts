/**
 * Regression tests for the dual-provider outage observability (ticket 26fe2168).
 *
 * 2026-08-29: DeepSeek returned EMPTY content AND the DashScope fallback timed
 * out for ~6h — every utilityChat consumer silently degraded to defaults with
 * zero alerts. The fix counts consecutive total failures per process and, past
 * UTILITY_OUTAGE_ALERT_THRESHOLD, files an agent feedback ticket (stable title
 * → the feedback service's dedup bumps the existing ticket = "file/refresh").
 *
 * Env keys are read at module load, so they are set BEFORE the import below
 * (ts-jest compiles to CJS; statement order is preserved).
 */
process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
process.env.DASHSCOPE_API_KEY = 'test-dashscope-key';
process.env.DEEPSEEK_BALANCE_WARN_FLOOR = '1.00'; // probe floor tests — read at module load

import axios from 'axios';
import {
  utilityChat,
  utilityLLM,
  __resetUtilityOutageCounterForTests,
  __resetDeepseekBillingLatchForTests,
  __resetDeepseekBalanceProbeForTests,
  __resetDeadFallbackWarnForTests,
  __resetUtilityOverrideLatchForTests,
  deepseekBillingLatched,
  utilityOverrideLatched,
  probeDeepSeekBalance,
  DEEPSEEK_BILLING_LATCH_MS,
  DEEPSEEK_BALANCE_LOW_TICKET_REFIRE_MS,
  DEEPSEEK_BALANCE_WARN_FLOOR,
  UTILITY_OUTAGE_ALERT_THRESHOLD,
  UTILITY_OUTAGE_ALERT_REFIRE_MS,
  UTILITY_OVERRIDE_LATCH_MS,
  UTILITY_OVERRIDE_BACKOFF_STEPS_MS,
  UTILITY_OVERRIDE_FALLBACK_RESERVE_MS,
  utilityOverrideLegTimeout,
  utilityLLMHealthSnapshot,
} from './utility-llm';
import { fileFeedbackTicket } from '../modules/crossmodel/feedback/feedback.service';
// REAL helper-completion (only coding-model's resolveProviderForRun is stubbed
// above): the reset hook clears its per-model thinking-off latch between tests.
import { __resetThinkingOffLatchForTests, postNonStreamingCompletion } from '../modules/crossmodel/coding/helper-completion';

jest.mock('axios');
// model-roles seam (utilityChat tries the 'utility' role override first, then
// the 'utility_fallback' middle leg): default unset → the built-in
// DeepSeek → DashScope chain, behavior identical. The real module pulls
// config/env (worker-killing process.exit in jest).
const mockResolveRoleModel = jest.fn(async (..._a: any[]): Promise<string> => '');
jest.mock('../modules/crossmodel/model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...a),
  // Owner 2026-09-15: the 'utility_fallback' ROLE became the utility seat's
  // custom-fallback SLOT — utility-llm reads it via resolveRoleFallback('utility').
  // Routed through the same mock under the legacy key so every case below
  // keeps its `key === 'utility_fallback'` implementation unchanged.
  resolveRoleFallback: (key: string) => mockResolveRoleModel(key === 'utility' ? 'utility_fallback' : key),
}));
// coding-model is partial-mocked (the model-roles.service.test.ts pattern —
// proven jest-loadable): the pure helpers helper-completion needs
// (THINKING_OFF_EXTRA / DEEPSEEK_THINKING_OFF_EXTRA / isDeepSeekBuiltInProvider)
// stay REAL, only the run-path resolution is stubbed. helper-completion is
// partial-mocked below: postNonStreamingCompletion DEFAULTS to the real
// implementation, so the 'utility'/'utility_fallback' legs' payload assembly
// + extractNonStreamingAnswer still run for real against the axios automock.
const mockResolveProviderForRun = jest.fn();
jest.mock('../modules/crossmodel/coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../modules/crossmodel/coding/coding-model'),
  resolveProviderForRun: (...a: any[]) => mockResolveProviderForRun(...a),
}));
// helper-completion is partial-mocked the same way (merge of rollout-watch tick 11,
// 2026-09-15): postNonStreamingCompletion defaults to the REAL implementation (the
// 402-replay / fallback-leg tests exercise the real payload assembly, thinking-off
// directive and <think> strip); the utility-override-latch suite mockResets it and
// drives it per-test with mockRejectedValue/mockResolvedValue.
jest.mock('../modules/crossmodel/coding/helper-completion', () => {
  const actual = jest.requireActual('../modules/crossmodel/coding/helper-completion');
  return {
    __esModule: true,
    ...actual,
    postNonStreamingCompletion: jest.fn(actual.postNonStreamingCompletion),
  };
});
jest.mock('../modules/crossmodel/feedback/feedback.service', () => ({
  fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-outage-1' } })),
}));
// The dual-failure path dynamically imports the loop-metrics service (telemetry
// half of the alarm). MUST be mocked here: the real module pulls config/database
// → config/env, which process.exit(1)s in this env-less test process.
jest.mock('../modules/crossmodel/platform/loop-metrics.service', () => ({
  noteUtilityLlmFailure: jest.fn(),
}));
jest.mock('./logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { noteUtilityLlmFailure } = require('../modules/crossmodel/platform/loop-metrics.service');

const mockPost = axios.post as jest.Mock;
const mockGet = axios.get as jest.Mock;
const mockFileTicket = fileFeedbackTicket as jest.Mock;
const mockNoteFailure = noteUtilityLlmFailure as jest.Mock;

// ── Provider response helpers ────────────────────────────────────────────────

function deepseekSuccess(content = 'ds-ok') {
  return { data: { choices: [{ message: { content } }], model: 'deepseek-flash' } };
}
function deepseekEmpty() {
  return { data: { choices: [{ message: { content: '', reasoning_content: '' } }] } };
}
function dashscopeSuccess(content = 'fb-ok') {
  return { data: { choices: [{ message: { content } }] } };
}
function dashscopeEmpty() {
  return { data: { choices: [{ message: { content: '', reasoning_content: '' } }] } };
}

/** Both legs fail with transport errors (no 'not_found' — that would retry). */
function bothLegsThrow() {
  mockPost.mockImplementation((url: string) =>
    Promise.reject(new Error(url.includes('deepseek') ? 'ds ETIMEDOUT' : 'fb ETIMEDOUT')),
  );
}

/** Both legs return empty content (the exact 2026-08-29 failure shape). */
function bothLegsEmpty() {
  mockPost.mockImplementation((url: string) =>
    Promise.resolve(url.includes('deepseek') ? deepseekEmpty() : dashscopeEmpty()),
  );
}

async function failCalls(n: number) {
  for (let i = 0; i < n; i++) {
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('');
  }
}

/** Flush the fire-and-forget ticket filing (dynamic import + async IIFE). */
async function flushAlert() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

describe('utilityChat dual-provider outage observability (ticket 26fe2168)', () => {
  let nowSpy: jest.SpyInstance;
  let now: number;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetUtilityOutageCounterForTests();
    __resetDeepseekBillingLatchForTests();
    now = 1_800_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('DeepSeek success returns content and resets the streak — no ticket after < threshold failures', async () => {
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD - 1); // 4 consecutive failures
    await flushAlert();
    expect(mockFileTicket).not.toHaveBeenCalled();

    // One healthy call proves the path is alive → streak resets.
    mockPost.mockImplementation((url: string) =>
      Promise.resolve(url.includes('deepseek') ? deepseekSuccess('alive') : dashscopeSuccess()),
    );
    expect(await utilityChat([{ role: 'user', content: 'hi' }])).toBe('alive');

    // 4 more failures — the streak is 4, not 8: still below threshold.
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD - 1);
    await flushAlert();
    expect(mockFileTicket).not.toHaveBeenCalled();
  });

  it('1105650b: utilityLLMHealthSnapshot carries the dual-failure streak + per-leg errors, and a healthy call CLEARS the leg errors', async () => {
    // The 2026-10-12 outage shape: both legs 401 on dead keys.
    const http401 = (leg: string) => Object.assign(new Error(`${leg} HTTP 401: Authentication Fails`), { response: { status: 401 } });
    mockPost.mockImplementation((url: string) =>
      url.includes('deepseek') ? Promise.reject(http401('DeepSeek deepseek-flash')) : Promise.reject(http401('DashScope qwen3.6-27b')),
    );
    await failCalls(2);
    let snap = utilityLLMHealthSnapshot();
    expect(snap.detail.dualFailureStreak).toBe(2);
    expect(snap.detail.lastDeepseekError).toContain('HTTP 401');
    expect(snap.detail.lastDashscopeError).toContain('HTTP 401');
    expect(snap.summary).toContain('dual-provider failure streak 2');
    // A healthy call clears the recorded leg errors — a later non-provider
    // outage must not carry a stale 401 line into its snapshot. (Both legs
    // answer 'healed': the two 401s above latched DeepSeek off for the billing
    // window, so the call may legitimately be served by DashScope.)
    mockPost.mockImplementation((url: string) =>
      Promise.resolve(url.includes('deepseek') ? deepseekSuccess('healed') : dashscopeSuccess('healed')),
    );
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('healed');
    snap = utilityLLMHealthSnapshot();
    expect(snap.detail.dualFailureStreak).toBe(0);
    expect(snap.detail.lastDeepseekError).toBe('');
    expect(snap.detail.lastDashscopeError).toBe('');
  });

  it('a DeepSeek 402 (billing) latches the DeepSeek leg off for DEEPSEEK_BILLING_LATCH_MS — the next calls go straight to DashScope, then DeepSeek is retried (rollout watch 2026-09-14)', async () => {
    const http402 = () => Object.assign(new Error('DeepSeek deepseek-flash HTTP 402: Insufficient Balance'), { response: { status: 402 } });
    mockPost.mockImplementation((url: string) =>
      url.includes('deepseek') ? Promise.reject(http402()) : Promise.resolve(dashscopeSuccess('fb-402')));
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('fb-402');
    expect(deepseekBillingLatched()).toBe(true);
    const deepseekCalls = () => mockPost.mock.calls.filter((c: any[]) => String(c[0]).includes('deepseek')).length;
    expect(deepseekCalls()).toBe(1);
    // Tick 8 (2026-09-14): the latch also files ONE deduped owner-action ticket
    // (process-level, userId null) — the outage had no owner-visible signal.
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    expect(mockFileTicket.mock.calls[0][0]).toMatchObject({
      userId: null, type: 'mishap', priority: 5, area: 'owner-action',
      title: 'PROVIDER BILLING OUTAGE — DeepSeek answered HTTP 402 to utility calls (owner top-up / re-key needed)',
    });
    expect(mockFileTicket.mock.calls[0][0].description).toContain('Insufficient Balance');
    // Latched: the second call never touches DeepSeek, DashScope answers directly.
    expect(await utilityChat([{ role: 'user', content: 'again' }], { contentOnly: true })).toBe('fb-402');
    expect(deepseekCalls()).toBe(1);
    // After the latch window DeepSeek is tried again (and, still 402, re-latches).
    now += DEEPSEEK_BILLING_LATCH_MS + 1;
    expect(await utilityChat([{ role: 'user', content: 'later' }], { contentOnly: true })).toBe('fb-402');
    expect(deepseekCalls()).toBe(2);
    expect(deepseekBillingLatched()).toBe(true);
    // The re-latch inside the ticket refire window does NOT file again (one
    // dedup bump per process per DEEPSEEK_BILLING_TICKET_REFIRE_MS).
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    // A transient failure (500) never latches.
    __resetDeepseekBillingLatchForTests();
    mockPost.mockImplementation((url: string) =>
      url.includes('deepseek') ? Promise.reject(Object.assign(new Error('boom'), { response: { status: 500 } })) : Promise.resolve(dashscopeSuccess('fb-500')));
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('fb-500');
    expect(deepseekBillingLatched()).toBe(false);
  });

  it('replays the exact prod 402 of ticket 2b7ceafa (2026-09-14): provider body {error:{message:"Insufficient Balance"}} → latch + DashScope serves + the verbatim owner-action ticket', async () => {
    // Ticket 2b7ceafa (mishap, 2026-09-14): the DeepSeek account went to a
    // NEGATIVE balance (-$0.49; /user/balance answered is_available:false) and
    // every utility call failed HTTP 402 with this EXACT provider body (quoted
    // from a live replay probe during the outage):
    //   {"error":{"message":"Insufficient Balance","type":"unknown_error","param":null,"code":"invalid_request_error"}}
    // utilityLLM rethrows it as a plain Error carrying the status only in the
    // message text ("DeepSeek deepseek-flash HTTP 402: Insufficient Balance" —
    // the verbatim prod log/ticket string); the latch must still recover the
    // 402 from the message, skip DeepSeek for DEEPSEEK_BILLING_LATCH_MS, let
    // DashScope serve, and file exactly ONE owner-action ticket whose verbatim
    // title this incident's dedup keys on.
    const prod402 = () => Object.assign(new Error('Request failed with status code 402'), {
      response: {
        status: 402,
        data: { error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } },
      },
    });
    mockPost.mockImplementation((url: string) =>
      url.includes('deepseek') ? Promise.reject(prod402()) : Promise.resolve(dashscopeSuccess('fb-2b7ceafa')));

    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('fb-2b7ceafa');
    expect(deepseekBillingLatched()).toBe(true);

    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    const arg = mockFileTicket.mock.calls[0][0];
    expect(arg).toMatchObject({ userId: null, type: 'mishap', priority: 5, area: 'owner-action' });
    // The verbatim prod filing (the exact title ticket 2b7ceafa's dedup bumps):
    expect(arg.title).toBe('PROVIDER BILLING OUTAGE — DeepSeek answered HTTP 402 to utility calls (owner top-up / re-key needed)');
    // The provider's OWN detail survived extraction (response.data.error.message):
    expect(arg.description).toContain('Provider said: DeepSeek deepseek-flash HTTP 402: Insufficient Balance');
    expect(arg.description).toContain('served by the DashScope fallback');
    expect(arg.context).toMatchObject({ surface: 'utility-llm', class: 'provider_billing', status: 402 });
  });

  it('replays the exact prod 401 of ticket f9637864 (2026-10-12): provider body {error:{message:"Authentication Fails, Your api key: ****fb3e is invalid"}} → latch + DashScope serves + the verbatim 401 owner-action ticket', async () => {
    // Ticket f9637864 (mishap, 2026-10-12, dispatch 1 of 3): during the
    // 2026-10-10/11 breach key-rotation window the DeepSeek key (…fb3e) was
    // INVALID — every utility call answered HTTP 401 with this EXACT provider
    // body (quoted verbatim from the ticket's sightings, request_id
    // 6f6da9d6-8bab-4944-aaea-27a7f329811f):
    //   {"error":{"message":"Authentication Fails, Your api key: ****fb3e is invalid","type":"authentication_error","param":null,"code":"invalid_request_error"}}
    // A 401 is in BILLING_AUTH_STATUSES (401/402/403) — the same auth class
    // the 402 latch covers — so the DeepSeek leg must latch, DashScope must
    // serve, and the ticket title must carry HTTP 401 (the dedup key that
    // rolled all 22 occurrences into the f9637864 row). The outage resolved
    // ~05:56Z when the rotated keys landed (commit 8cbdeebd, "coding box C
    // receives rotated JWT/MCP/Bright Data/provider secrets"); this replay
    // pins the detector that surfaced it.
    const prod401 = () => Object.assign(new Error('Request failed with status code 401'), {
      response: {
        status: 401,
        data: { error: { message: 'Authentication Fails, Your api key: ****fb3e is invalid', type: 'authentication_error', param: null, code: 'invalid_request_error' } },
      },
    });
    mockPost.mockImplementation((url: string) =>
      url.includes('deepseek') ? Promise.reject(prod401()) : Promise.resolve(dashscopeSuccess('fb-f9637864')));

    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('fb-f9637864');
    expect(deepseekBillingLatched()).toBe(true);

    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    const arg = mockFileTicket.mock.calls[0][0];
    expect(arg).toMatchObject({ userId: null, type: 'mishap', priority: 5, area: 'owner-action' });
    // The verbatim prod filing (the exact title ticket f9637864's dedup bumps):
    expect(arg.title).toBe('PROVIDER BILLING OUTAGE — DeepSeek answered HTTP 401 to utility calls (owner top-up / re-key needed)');
    // The provider's OWN detail survived extraction (response.data.error.message):
    expect(arg.description).toContain('Provider said: DeepSeek deepseek-flash HTTP 401: Authentication Fails, Your api key: ****fb3e is invalid');
    expect(arg.description).toContain('served by the DashScope fallback');
    expect(arg.context).toMatchObject({ surface: 'utility-llm', class: 'provider_billing', status: 401 });
    // Latched: the next call never touches DeepSeek — DashScope answers directly.
    expect(await utilityChat([{ role: 'user', content: 'again' }], { contentOnly: true })).toBe('fb-f9637864');
    expect(mockPost.mock.calls.filter((c: any[]) => String(c[0]).includes('deepseek')).length).toBe(1);
  });

  it('DashScope fallback success returns content, resets the streak, and files nothing', async () => {
    // Pre-load failures so the streak-reset is actually exercised: without the
    // reset on the fallback success, the post-success failures below would
    // carry the streak past the threshold and file a ticket.
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD - 1); // streak 4
    mockPost.mockImplementation((url: string) =>
      Promise.resolve(url.includes('deepseek') ? deepseekEmpty() : dashscopeSuccess('fb-alive')),
    );
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('fb-alive');
    await flushAlert();
    expect(mockFileTicket).not.toHaveBeenCalled();
    // 4 more failures: streak is 4 only if the fallback success reset it
    // (otherwise 4+4=8 ≥ threshold → ticket — this assertion pins that hook).
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD - 1);
    await flushAlert();
    expect(mockFileTicket).not.toHaveBeenCalled();
  });

  it('files exactly one outage ticket at the threshold (the 6h-silent-outage regression)', async () => {
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD);
    await flushAlert();

    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    const arg = mockFileTicket.mock.calls[0][0];
    expect(arg.type).toBe('bug_report');
    expect(arg.priority).toBe(2);
    expect(arg.area).toBe('platform');
    expect(arg.title).toBe('Utility-LLM outage auto-detected: DeepSeek + DashScope both failing in backend process');
    expect(arg.description).toContain(`${UTILITY_OUTAGE_ALERT_THRESHOLD} CONSECUTIVE total utility-LLM failures`);
    expect(arg.description).toContain('26fe2168');
    expect(arg.context).toMatchObject({
      surface: 'utility-llm',
      consecutiveDualFailures: UTILITY_OUTAGE_ALERT_THRESHOLD,
      threshold: UTILITY_OUTAGE_ALERT_THRESHOLD,
    });
  });

  it('empty-content dual failures (the 2026-08-29 exact shape) count toward the threshold', async () => {
    bothLegsEmpty();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
  });

  it('suppresses refires inside the window, then re-files after it while the outage persists', async () => {
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD + 3); // past threshold, same window
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);

    now += UTILITY_OUTAGE_ALERT_REFIRE_MS + 1; // outage still going 31min later
    await failCalls(1);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(2);
    expect(mockFileTicket.mock.calls[1][0].context.consecutiveDualFailures).toBe(UTILITY_OUTAGE_ALERT_THRESHOLD + 4);
  });

  it('records one utility_llm_dual_failure loop metric per dual failure, with streak + last provider error strings', async () => {
    bothLegsThrow();
    await failCalls(2);
    await flushAlert();
    expect(mockNoteFailure).toHaveBeenCalledTimes(2);
    const first = mockNoteFailure.mock.calls[0][0];
    const second = mockNoteFailure.mock.calls[1][0];
    expect(first.streak).toBe(1);
    expect(second.streak).toBe(2);
    expect(first.callerContext).toContain('contentOnly=true');
    expect(first.lastErrors.join(' | ')).toContain('ds ETIMEDOUT');
    expect(first.lastErrors.join(' | ')).toContain('fb ETIMEDOUT');
    // Below the alert threshold: telemetry recorded, no ticket filed.
    expect(mockFileTicket).not.toHaveBeenCalled();
  });

  it('a successful call records no dual-failure metric', async () => {
    mockPost.mockImplementation((url: string) =>
      Promise.resolve(url.includes('deepseek') ? deepseekSuccess('fine') : dashscopeSuccess()),
    );
    expect(await utilityChat([{ role: 'user', content: 'hi' }])).toBe('fine');
    await flushAlert();
    expect(mockNoteFailure).not.toHaveBeenCalled();
  });

  it('the outage ticket carries the last provider error strings (description + context)', async () => {
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    const arg = mockFileTicket.mock.calls[0][0];
    expect(arg.description).toContain('Last provider errors on the failing call');
    expect(arg.description).toContain('ds ETIMEDOUT');
    expect(arg.description).toContain('fb ETIMEDOUT');
    expect(arg.context.lastErrors.join(' | ')).toContain('ds ETIMEDOUT');
    expect(arg.context.lastErrors.join(' | ')).toContain('fb ETIMEDOUT');
  });

  it('a loop-metric telemetry crash never breaks or delays the caller degradation path', async () => {
    bothLegsThrow();
    mockNoteFailure.mockImplementation(() => { throw new Error('metrics down'); });
    try {
      await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD); // returns '' cleanly every time
      await flushAlert();
      expect(mockFileTicket).toHaveBeenCalledTimes(1); // the alert half still fires
    } finally {
      mockNoteFailure.mockReset();
    }
  });

  it('a ticket-filing crash never breaks or delays the caller degradation path', async () => {
    bothLegsThrow();
    // Once (not a sticky implementation) so later tests keep the factory default.
    mockFileTicket.mockRejectedValueOnce(new Error('db down'));
    // Threshold crossing must still return '' cleanly (no throw, no hang).
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
  });

  it('success on a later call stops the streak — post-recovery failures start from zero', async () => {
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);

    // Recovery.
    mockPost.mockImplementation((url: string) =>
      Promise.resolve(url.includes('deepseek') ? deepseekSuccess('recovered') : dashscopeSuccess()),
    );
    expect(await utilityChat([{ role: 'user', content: 'hi' }])).toBe('recovered');

    // A fresh outage must rebuild the full streak before the next alert — and
    // the refire window (anchored at the FIRST alert) must have elapsed.
    bothLegsThrow();
    await failCalls(UTILITY_OUTAGE_ALERT_THRESHOLD - 1);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    now += UTILITY_OUTAGE_ALERT_REFIRE_MS + 1;
    await failCalls(1);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Thinking explicitly DISABLED on utility legs (owner-briefing outage
// 2026-09-04): DeepSeek's V4 API drifted to thinking-on-by-default — small
// max_tokens burned entirely on reasoning, content arrived empty, contentOnly
// callers got ''. The DashScope qwen fallback likewise reasoned into its
// timeout. These pins keep both legs no-thinking forever.
// ═════════════════════════════════════════════════════════════════════════════
describe('utility legs disable thinking (2026-09-04 briefing outage)', () => {
  beforeEach(() => { mockPost.mockReset(); });

  it('the DeepSeek utilityLLM leg sends thinking:{type:disabled}', async () => {
    mockPost.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } });
    await utilityLLM([{ role: 'user', content: 'hi' }]);
    const payload = mockPost.mock.calls[0][1];
    expect(payload.thinking).toEqual({ type: 'disabled' });
  });

  it('the DashScope fallback sends enable_thinking:false', async () => {
    // DeepSeek leg returns empty content → falls to DashScope.
    mockPost
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '' } }] } })
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'fallback ok' } }] } });
    const out = await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true });
    expect(out).toBe('fallback ok');
    const fbPayload = mockPost.mock.calls[mockPost.mock.calls.length - 1][1];
    expect(fbPayload.enable_thinking).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Opt-in thinking (2026-09-08, owner: "are you sure it is reasoning for these?"):
// the home-screen starter questions need judgment (date awareness, one topic per
// chip, stale-fact handling), so a caller may turn reasoning ON per call. The
// pins above stay the DEFAULT — only an explicit `thinking:true` flips them.
// ═════════════════════════════════════════════════════════════════════════════
describe('utility legs: opt-in thinking per call', () => {
  beforeEach(() => { mockPost.mockReset(); });

  it('thinking:true → the DeepSeek leg sends thinking:{type:enabled}', async () => {
    mockPost.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok', reasoning_content: 'thought…' } }] } });
    const out = await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true, maxTokens: 6000 });
    expect(out).toBe('ok');
    const payload = mockPost.mock.calls[0][1];
    expect(payload.thinking).toEqual({ type: 'enabled' });
    // 2026-09-11: a thinking call is floored at DEEPSEEK_THINKING_MIN_MAX_TOKENS —
    // reasoning counts against max_tokens and an 8000 budget came back EMPTY
    // (finish_reason=length) in prod; a caller asking for MORE keeps its number.
    expect(payload.max_tokens).toBe(16384);
    mockPost.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok2' } }] } });
    await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true, maxTokens: 20000 });
    expect(mockPost.mock.calls[1][1].max_tokens).toBe(20000);
  });

  it('thinking:true → the DashScope fallback STILL sends enable_thinking:false (stream-only on DashScope) and warns that it served the call unreasoned', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '' } }] } })
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'fallback ok' } }] } });
    const out = await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true });
    expect(out).toBe('fallback ok');
    const fbPayload = mockPost.mock.calls[mockPost.mock.calls.length - 1][1];
    expect(fbPayload.enable_thinking).toBe(false);
    const log = require('./logger').default;
    expect(log.warn.mock.calls.some((c: any[]) => /WITHOUT reasoning/.test(String(c[0])))).toBe(true);
  });

  it('iteration 13: thinking:true sends reasoning_effort low by default (UTILITY_THINKING_EFFORT overrides; off omits)', async () => {
    mockPost.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok', reasoning_content: 't' } }] } });
    await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true });
    expect(mockPost.mock.calls[0][1].reasoning_effort).toBe('low');
    process.env.UTILITY_THINKING_EFFORT = 'high';
    mockPost.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok', reasoning_content: 't' } }] } });
    await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true });
    expect(mockPost.mock.calls[1][1].reasoning_effort).toBe('high');
    process.env.UTILITY_THINKING_EFFORT = 'off';
    mockPost.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok', reasoning_content: 't' } }] } });
    await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true });
    expect(mockPost.mock.calls[2][1].reasoning_effort).toBeUndefined();
    delete process.env.UTILITY_THINKING_EFFORT;
    // no-thinking calls never carry an effort
    mockPost.mockResolvedValueOnce({ data: { choices: [{ message: { content: 'ok' } }] } });
    await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true });
    expect(mockPost.mock.calls[3][1].reasoning_effort).toBeUndefined();
  });

  it('iteration 13: reasoning exhausted the budget (finish_reason=length, empty content) → ONE thinking-off retry on DeepSeek answers; DashScope is never called', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '', reasoning_content: 'x'.repeat(52000) }, finish_reason: 'length' }] } })
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'plain answer' }, finish_reason: 'stop' }] } });
    const out = await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true, maxTokens: 3200 });
    expect(out).toBe('plain answer');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(mockPost.mock.calls[0][1].thinking).toEqual({ type: 'enabled' });
    expect(mockPost.mock.calls[1][1].thinking).toEqual({ type: 'disabled' });
    expect(mockPost.mock.calls[1][1].reasoning_effort).toBeUndefined();
    expect(String(mockPost.mock.calls[1][0])).toMatch(/deepseek/i);
  });

  it('iteration 13: the retry never fires on a plain empty answer', async () => {
    // empty content with finish_reason stop (a provider blank) → no thinking-off retry, straight to the fallback
    mockPost
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '', reasoning_content: '' }, finish_reason: 'stop' }] } })
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'fb2' } }] } });
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true })).toBe('fb2');
    expect(mockPost.mock.calls[1][1].enable_thinking).toBe(false);
  });

  it('thinking:true + contentOnly still never leaks reasoning_content when content is empty', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '', reasoning_content: 'We need to craft…' } }] } })
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '', reasoning_content: 'thinking…' } }] } });
    const out = await utilityChat([{ role: 'user', content: 'hi' }], { thinking: true, contentOnly: true });
    expect(out).toBe('');
  });

  it('omitting the flag keeps both legs pinned to no-thinking (regression guard for every other utility caller)', async () => {
    mockPost
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: '' } }] } })
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'fb' } }] } });
    await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true });
    expect(mockPost.mock.calls[0][1].thinking).toEqual({ type: 'disabled' });
    expect(mockPost.mock.calls[1][1].enable_thinking).toBe(false);
  });
});

// ── Proactive DeepSeek balance probe (nightly 2026-09-14, ticket 2b7ceafa class) ──
// The reactive billing latch learns the balance is empty from the first FAILED
// utility call; the probe asks GET /user/balance directly (hourly durable cron
// 'deepseek-balance-probe' in worker.ts) and latches/files BEFORE that. Floor
// is '1.00' here via the env set at the top of this file (module-load read).
describe('probeDeepSeekBalance — proactive DeepSeek balance check (nightly 2026-09-14)', () => {
  let nowSpy: jest.SpyInstance;
  let now: number;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetUtilityOutageCounterForTests();
    __resetDeepseekBillingLatchForTests();
    __resetDeepseekBalanceProbeForTests();
    now = 1_800_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('healthy balance → ok line, no latch, no ticket; calls /user/balance with the Bearer key', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '25.00', granted_balance: '0.00', topped_up_balance: '25.00' }] } });
    const line = await probeDeepSeekBalance();
    expect(line).toBe('ok total=25 USD');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][0]).toBe('https://api.deepseek.com/user/balance');
    expect(mockGet.mock.calls[0][1].headers.Authorization).toBe('Bearer test-deepseek-key');
    expect(deepseekBillingLatched()).toBe(false);
    await flushAlert();
    expect(mockFileTicket).not.toHaveBeenCalled();
  });

  it('is_available=false → latches the DeepSeek leg + files the billing ticket (once per refire window) BEFORE any utility call fails', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] } });
    const line = await probeDeepSeekBalance();
    expect(line).toContain('exhausted: is_available=false total=0 USD');
    expect(deepseekBillingLatched()).toBe(true);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    expect(mockFileTicket.mock.calls[0][0]).toMatchObject({
      userId: null, type: 'mishap', priority: 5, area: 'owner-action',
      title: 'PROVIDER BILLING OUTAGE — DeepSeek answered HTTP 402 to utility calls (owner top-up / re-key needed)',
    });
    expect(mockFileTicket.mock.calls[0][0].description).toContain('balance probe: is_available=false');
    // A second probe inside the ticket refire window re-latches but does NOT re-file.
    expect(await probeDeepSeekBalance()).toContain('exhausted');
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
  });

  it('HTTP 402 from the balance endpoint → latches + files the same deduped billing ticket', async () => {
    mockGet.mockResolvedValue({ status: 402, data: { error: { message: 'Insufficient Balance' } } });
    expect(await probeDeepSeekBalance()).toBe('billing-auth HTTP 402 (latched, ticket deduped)');
    expect(deepseekBillingLatched()).toBe(true);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    expect(mockFileTicket.mock.calls[0][0].title).toContain('PROVIDER BILLING OUTAGE');
  });

  it('replays the balance-probe 401 of ticket f9637864 (2026-10-12, sighting 8): GET /user/balance answered HTTP 401 → latch + the same deduped 401 billing ticket BEFORE any utility call fails', async () => {
    // Ticket f9637864 sighting 8 is the PROACTIVE half of the same outage: the
    // hourly deepseek-balance-probe cron (worker.ts) hit the invalid rotated-in
    // key BEFORE any utility call burned a round-trip — the ticket body quotes
    // "balance probe: GET /user/balance answered HTTP 401" verbatim. A 401 from
    // the balance endpoint is in BILLING_AUTH_STATUSES, so the probe must
    // latch the DeepSeek leg and file the SAME title-deduped owner-action row
    // (this is the row the 22 occurrences rolled into).
    mockGet.mockResolvedValue({ status: 401, data: { error: { message: 'Authentication Fails' } } });
    expect(await probeDeepSeekBalance()).toBe('billing-auth HTTP 401 (latched, ticket deduped)');
    expect(deepseekBillingLatched()).toBe(true);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    const arg = mockFileTicket.mock.calls[0][0];
    expect(arg).toMatchObject({ userId: null, type: 'mishap', priority: 5, area: 'owner-action' });
    expect(arg.title).toBe('PROVIDER BILLING OUTAGE — DeepSeek answered HTTP 401 to utility calls (owner top-up / re-key needed)');
    // The probe's own error line survives verbatim (sighting 8's exact text):
    expect(arg.description).toContain('Provider said: balance probe: GET /user/balance answered HTTP 401');
    expect(arg.context).toMatchObject({ surface: 'utility-llm', class: 'provider_billing', status: 401 });
  });

  it('balance under DEEPSEEK_BALANCE_WARN_FLOOR → DISTINCT low-balance early-warning ticket (priority 3), NO latch; refire suppressed in-window, re-files after it', async () => {
    expect(DEEPSEEK_BALANCE_WARN_FLOOR).toBe(1.0); // env at the top of this file
    mockGet.mockResolvedValue({ status: 200, data: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.42' }] } });
    const line = await probeDeepSeekBalance();
    expect(line).toContain('low: total=0.42 USD < floor 1');
    expect(deepseekBillingLatched()).toBe(false); // account still serves — no latch
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    expect(mockFileTicket.mock.calls[0][0]).toMatchObject({
      userId: null, type: 'mishap', priority: 3, area: 'owner-action',
      title: 'DeepSeek balance LOW — proactive probe (owner top-up before utility degradation)',
    });
    expect(mockFileTicket.mock.calls[0][0].context).toMatchObject({ surface: 'deepseek-balance-probe', totalBalance: 0.42, currency: 'USD' });
    // In-window: suppressed. After the refire window: filed again.
    expect(await probeDeepSeekBalance()).toContain('low:');
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    now += DEEPSEEK_BALANCE_LOW_TICKET_REFIRE_MS + 1;
    expect(await probeDeepSeekBalance()).toContain('low:');
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(2);
  });

  it('transient probe failures (network throw, HTTP 500, malformed body) → probe-failed line, NO latch, NO ticket', async () => {
    mockGet.mockRejectedValueOnce(new Error('ETIMEDOUT'));
    expect(await probeDeepSeekBalance()).toBe('probe-failed: ETIMEDOUT');
    mockGet.mockResolvedValueOnce({ status: 500, data: {} });
    expect(await probeDeepSeekBalance()).toBe('probe-failed: HTTP 500');
    mockGet.mockResolvedValueOnce(undefined); // auto-mock default shape — guarded
    expect(await probeDeepSeekBalance()).toBe('probe-failed: malformed response');
    expect(deepseekBillingLatched()).toBe(false);
    await flushAlert();
    expect(mockFileTicket).not.toHaveBeenCalled();
  });

  it('a 200 with missing/empty balance_infos is schema DRIFT, not a zero balance — warn-only, NO low-balance ticket even with the floor armed (PR #771 review)', async () => {
    mockGet.mockResolvedValueOnce({ status: 200, data: { is_available: true } }); // balance_infos absent
    expect(await probeDeepSeekBalance()).toBe('probe-failed: malformed body (no balance_infos)');
    mockGet.mockResolvedValueOnce({ status: 200, data: { is_available: true, balance_infos: [] } }); // present but empty
    expect(await probeDeepSeekBalance()).toBe('probe-failed: malformed body (no balance_infos)');
    expect(deepseekBillingLatched()).toBe(false);
    await flushAlert();
    expect(mockFileTicket).not.toHaveBeenCalled(); // floor is 1.00 here — total=0 must NOT file
    // …but the vendor's OWN is_available=false flag still latches even without the array.
    mockGet.mockResolvedValueOnce({ status: 200, data: { is_available: false } });
    expect(await probeDeepSeekBalance()).toContain('exhausted: is_available=false');
    expect(deepseekBillingLatched()).toBe(true);
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    expect(mockFileTicket.mock.calls[0][0].title).toContain('PROVIDER BILLING OUTAGE');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Digby Edge 'utility_fallback' leg (2026-09-15 — the Nebius-B300 fallback):
// utilityChat's leg order is now 'utility' override → DeepSeek primary →
// 'utility_fallback' custom endpoint → DashScope safety net. These tests
// replay ticket 2b7ceafa's HTTP 402 with a configured custom endpoint and pin
// that it serves BEFORE DashScope. helper-completion stays REAL (the fallback
// leg's payload assembly, thinking-off directive and <think> strip are Digby's
// own); only coding-model's resolveProviderForRun is stubbed.
// ═════════════════════════════════════════════════════════════════════════════

/** The admin-registered Nebius B300 node the 'utility_fallback' seat points at. */
const NEBIUS_SPEC = 'nebius-b300:Qwen/Qwen3-32B';
const NEBIUS_PROVIDER = {
  url: 'http://10.0.0.8:8000/v1/chat/completions',
  apiKey: 'sk-nebius',
  model: 'Qwen/Qwen3-32B',
  label: 'nebius-b300 (custom endpoint)',
  extra: {},
  omitParams: [] as string[],
};

/** The prod-verbatim 402 ticket 2b7ceafa replayed (provider body shape). */
function prod402() {
  return Object.assign(new Error('Request failed with status code 402'), {
    response: {
      status: 402,
      data: { error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } },
    },
  });
}

/** DeepSeek 402s (billing); the Nebius B300 serves 'nb-ok'; DashScope would answer but must never be reached. */
function deepseek402NebiusServes() {
  mockPost.mockImplementation((url: string) => {
    if (url.includes('deepseek')) return Promise.reject(prod402());
    if (url.includes('10.0.0.8')) return Promise.resolve({ data: { choices: [{ message: { content: 'nb-ok' } }] } });
    return Promise.resolve(dashscopeSuccess('fb-ok'));
  });
}

describe("utilityChat 'utility_fallback' leg (Nebius-B300 fallback, 2026-09-15)", () => {
  let nowSpy: jest.SpyInstance;
  let now: number;

  beforeEach(() => {
    jest.clearAllMocks();
    __resetUtilityOutageCounterForTests();
    __resetDeepseekBillingLatchForTests();
    __resetThinkingOffLatchForTests();
    __resetDeadFallbackWarnForTests();
    // No seats configured unless a test says so; the fallback spec resolves to
    // the Nebius B300 provider (leg-3 shape).
    mockResolveRoleModel.mockImplementation(async () => '');
    mockResolveProviderForRun.mockResolvedValue(NEBIUS_PROVIDER);
    now = 1_800_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    nowSpy.mockRestore();
  });

  it('402 replay, custom fallback wins: DeepSeek bills out, the Nebius B300 serves BEFORE DashScope, the latch engages + files exactly ONE owner-action billing ticket', async () => {
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility_fallback' ? NEBIUS_SPEC : ''));
    deepseek402NebiusServes();

    const out = await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true });
    expect(out).toBe('nb-ok');

    // The custom fallback served SECOND — right after the failing DeepSeek leg…
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(String(mockPost.mock.calls[0][0])).toContain('deepseek');
    expect(String(mockPost.mock.calls[1][0])).toBe('http://10.0.0.8:8000/v1/chat/completions');
    // …and the DashScope safety net was NEVER burned.
    expect(mockPost.mock.calls.some((c: any[]) => String(c[0]).includes('dashscope'))).toBe(false);

    // The payload on the B300 carries the registry model and respects the
    // DEEPSEEK_MIN_MAX_TOKENS floor; the endpoint key rides ONLY in the
    // Authorization header — never in any returned string or payload.
    const fbPayload = mockPost.mock.calls[1][1];
    expect(fbPayload.model).toBe('Qwen/Qwen3-32B');
    expect(fbPayload.max_tokens).toBeGreaterThanOrEqual(256);
    expect(mockPost.mock.calls[1][2].headers.Authorization).toBe('Bearer sk-nebius');
    expect(out).not.toContain('sk-nebius');
    expect(JSON.stringify(mockPost.mock.calls.map((c: any[]) => c[1]))).not.toContain('sk-nebius');

    // The 402 (recovered from utilityLLM's rethrown message) latched the leg off…
    expect(deepseekBillingLatched()).toBe(true);
    // …and the latch filed exactly ONE deduped owner-action billing ticket
    // (mirrors the existing latch tests). A fallback SERVED call is no outage:
    // no dual-failure metric, no outage ticket.
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
    expect(mockFileTicket.mock.calls[0][0]).toMatchObject({
      userId: null, type: 'mishap', priority: 5, area: 'owner-action',
      title: 'PROVIDER BILLING OUTAGE — DeepSeek answered HTTP 402 to utility calls (owner top-up / re-key needed)',
    });
    expect(mockNoteFailure).not.toHaveBeenCalled();
  });

  it('latch-hot serving path: with the billing latch engaged the DeepSeek leg is SKIPPED — the B300 answers directly, DashScope still untouched', async () => {
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility_fallback' ? NEBIUS_SPEC : ''));
    deepseek402NebiusServes();
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('nb-ok');
    expect(deepseekBillingLatched()).toBe(true);

    mockPost.mockClear();
    expect(await utilityChat([{ role: 'user', content: 'again' }], { contentOnly: true })).toBe('nb-ok');
    // ONE call, straight to the custom fallback — DeepSeek was skipped by the latch.
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(String(mockPost.mock.calls[0][0])).toBe('http://10.0.0.8:8000/v1/chat/completions');
    expect(mockPost.mock.calls.some((c: any[]) => String(c[0]).includes('deepseek'))).toBe(false);
    expect(mockPost.mock.calls.some((c: any[]) => String(c[0]).includes('dashscope'))).toBe(false);
    // Still exactly the one billing ticket from the latch — no refire inside the window.
    await flushAlert();
    expect(mockFileTicket).toHaveBeenCalledTimes(1);
  });

  it('fallback leg failure → the DashScope safety net serves; the scrubbed fallback error reaches the next total-failure telemetry', async () => {
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility_fallback' ? NEBIUS_SPEC : ''));
    // The B300 refuses the connection (server echoing the key in its 500 body —
    // the scrub pin: utility-llm never surfaces response bodies, so the key
    // cannot reach telemetry/tickets).
    const nebiusDown = () => Object.assign(new Error('Request failed with status code 500'), {
      response: { status: 500, data: { error: { message: 'bad key sk-nebius' } } },
    });
    mockPost.mockImplementation((url: string) => {
      if (url.includes('deepseek')) return Promise.reject(prod402());
      if (url.includes('10.0.0.8')) return Promise.reject(nebiusDown());
      return Promise.resolve(dashscopeSuccess('fb-ok'));
    });

    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('fb-ok');
    // DashScope answered AFTER the failed custom leg (order pinned).
    const urls = mockPost.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls[0]).toContain('deepseek');
    expect(urls[1]).toContain('10.0.0.8');
    expect(urls[2]).toContain('dashscope');

    // Now the safety net fails too → total failure: telemetry must carry the
    // utility_fallback leg's error string, key-free.
    mockPost.mockImplementation((url: string) => {
      if (url.includes('deepseek')) return Promise.reject(prod402());
      if (url.includes('10.0.0.8')) return Promise.reject(nebiusDown());
      return Promise.reject(Object.assign(new Error('fb ETIMEDOUT'), { response: { status: 500 } }));
    });
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('');
    await flushAlert();
    expect(mockNoteFailure).toHaveBeenCalledTimes(1);
    const lastErrors: string[] = mockNoteFailure.mock.calls[0][0].lastErrors;
    expect(lastErrors.join(' | ')).toContain('utility_fallback (HTTP 500)');
    expect(JSON.stringify(lastErrors)).not.toContain('sk-nebius');
  });

  it('fallback leg empty content (reasoning burned the budget) → falls through to DashScope', async () => {
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility_fallback' ? NEBIUS_SPEC : ''));
    mockPost.mockImplementation((url: string) => {
      if (url.includes('deepseek')) return Promise.reject(prod402());
      // contentOnly: the reasoning_content fallback is NOT accepted either.
      if (url.includes('10.0.0.8')) return Promise.resolve({ data: { choices: [{ message: { content: '', reasoning_content: '' } }] } });
      return Promise.resolve(dashscopeSuccess('fb-ok'));
    });
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('fb-ok');
    const urls = mockPost.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls[0]).toContain('deepseek');
    expect(urls[1]).toContain('10.0.0.8');
    expect(urls[2]).toContain('dashscope');
  });

  it("no fallback configured → today's behavior: the 402 falls straight through to DashScope (pre-existing shape, re-pinned on this seam)", async () => {
    // resolveRoleModel '' for both seats (the beforeEach default).
    mockPost.mockImplementation((url: string) =>
      url.includes('deepseek') ? Promise.reject(prod402()) : Promise.resolve(dashscopeSuccess('fb-ok')));
    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('fb-ok');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(String(mockPost.mock.calls[0][0])).toContain('deepseek');
    expect(String(mockPost.mock.calls[1][0])).toContain('dashscope');
    expect(deepseekBillingLatched()).toBe(true);
    // resolveProviderForRun was never needed — no custom leg resolved.
    expect(mockResolveProviderForRun).not.toHaveBeenCalled();
  });

  it("leg ORDER: 'utility' override fails, then DeepSeek fails (transient, no latch), then utility_fallback serves — DashScope untouched", async () => {
    mockResolveRoleModel.mockImplementation(async (key: string) =>
      key === 'utility' ? 'my-ollama:x' : key === 'utility_fallback' ? NEBIUS_SPEC : '');
    mockResolveProviderForRun.mockImplementation(async (spec: string) =>
      spec === 'my-ollama:x'
        ? { url: 'http://10.0.0.5:11434/v1/chat/completions', apiKey: undefined, model: 'x', label: 'my-ollama (custom endpoint)', extra: {}, omitParams: [] }
        : NEBIUS_PROVIDER);
    mockPost.mockImplementation((url: string) => {
      if (url.includes('10.0.0.5')) return Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:11434'));
      if (url.includes('deepseek')) return Promise.reject(new Error('ds ETIMEDOUT'));
      if (url.includes('10.0.0.8')) return Promise.resolve({ data: { choices: [{ message: { content: 'nb-ok' } }] } });
      return Promise.resolve(dashscopeSuccess('fb-ok'));
    });

    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('nb-ok');
    const urls = mockPost.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('10.0.0.5');   // 1. the 'utility' override, tried FIRST
    expect(urls[1]).toContain('deepseek');   // 2. the DeepSeek primary
    expect(urls[2]).toContain('10.0.0.8');   // 3. the 'utility_fallback' custom endpoint
    expect(mockPost.mock.calls.some((c: any[]) => String(c[0]).includes('dashscope'))).toBe(false);
    // A transient DeepSeek error (ETIMEDOUT, not 40x billing) never latches.
    expect(deepseekBillingLatched()).toBe(false);
    await flushAlert();
    expect(mockFileTicket).not.toHaveBeenCalled();
  });

  it("isUtilityLLMAvailable counts a configured 'utility_fallback' on a keyless box (cold gate call kicks the refresh, then converges true)", async () => {
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility_fallback' ? NEBIUS_SPEC : ''));
    // The availability gate reads the API keys at MODULE LOAD — a keyless box
    // needs a fresh module instance with the keys scrubbed from the env (the
    // openai.integration.test.ts withFreshModule idiom).
    const savedDs = process.env.DEEPSEEK_API_KEY;
    const savedDash = process.env.DASHSCOPE_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      let mod: any;
      jest.isolateModules(() => { mod = require('./utility-llm'); });
      expect(mod).toBeTruthy();
      // Cold start: the gate says 'unavailable' once (and kicks the async refresh).
      expect(mod.isUtilityLLMAvailable()).toBe(false);
      await flushAlert();
      // Converged: the configured utility_fallback seat alone makes utility calls available.
      expect(mod.isUtilityLLMAvailable()).toBe(true);
      expect(mockResolveRoleModel).toHaveBeenCalledWith('utility_fallback');
    } finally {
      if (savedDs !== undefined) process.env.DEEPSEEK_API_KEY = savedDs;
      if (savedDash !== undefined) process.env.DASHSCOPE_API_KEY = savedDash;
    }
  });

  it("F1: a built-in id on the seat skips STRAIGHT to DashScope — never resolved, never re-calls the latched-off 402ing DeepSeek", async () => {
    // Legacy/mis-set config: 'deepseek-flash' (no colon) on the utility_fallback
    // seat. Save-time validation now refuses this (model-roles assertAssignable);
    // the runtime skip covers configs stored before the gate (review F1).
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility_fallback' ? 'deepseek-flash' : ''));
    mockPost.mockImplementation((url: string) => {
      if (url.includes('deepseek')) return Promise.reject(prod402());
      return Promise.resolve(dashscopeSuccess('fb-ok'));
    });

    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('fb-ok');
    const urls = mockPost.mock.calls.map((c: any[]) => String(c[0]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('deepseek');   // the failing primary (402)
    expect(urls[1]).toContain('dashscope');  // the safety net — NOT a second DeepSeek hit
    // The skip happens BEFORE provider resolution — a built-in seat value is
    // known to be a chain-leg duplicate without resolving anything.
    expect(mockResolveProviderForRun).not.toHaveBeenCalled();
    expect(deepseekBillingLatched()).toBe(true);
  });

  it('F3: a DEAD fallback spec is skipped but NEVER silent — named in the total-failure telemetry + throttled warn', async () => {
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility_fallback' ? 'gone:model' : ''));
    // The dead spec resolves to a BUILT-IN (the run path's silent fallback)…
    mockResolveProviderForRun.mockResolvedValue({
      url: 'https://api.z.ai/api/paas/v4/chat/completions', apiKey: 'sk-zai', model: 'glm-5.3', label: 'Z.AI', extra: {}, omitParams: [] as string[],
    });
    // …and both built-in legs fail, so the call reaches total failure.
    mockPost.mockImplementation((url: string) =>
      Promise.reject(new Error(url.includes('deepseek') ? 'ds ETIMEDOUT' : 'fb ETIMEDOUT')));

    expect(await utilityChat([{ role: 'user', content: 'hi' }], { contentOnly: true })).toBe('');
    // The custom endpoint was never called — the dead leg was skipped…
    expect(mockPost.mock.calls.some((c: any[]) => String(c[0]).includes('10.0.0.8'))).toBe(false);
    // …but it is NAMED in the telemetry (it used to skip with zero signal).
    await flushAlert();
    expect(mockNoteFailure).toHaveBeenCalledTimes(1);
    const metric = mockNoteFailure.mock.calls[0][0];
    expect(metric.lastErrors.join(' | ')).toContain('gone:model');
    expect(metric.lastErrors.join(' | ')).toContain('no longer resolves');
    // And the throttled warn fired (logger is mocked at the top of this file).
    const logger = require('./logger').default;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('utility_fallback (gone:model)'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('DEAD'));
  });
});

// ── Utility role-override latch (rollout watch tick 11, 2026-09-15) ───────────
// The owner's custom utility seat (a local model) timed out on 221 calls in one
// hour; every call paid the full timeout before the built-in chain answered.
describe('utility role override latch — an unreachable custom seat is skipped for UTILITY_OVERRIDE_LATCH_MS', () => {
  const mockOverridePost = postNonStreamingCompletion as jest.Mock;
  /** The fixed custom seat the shared coding-model partial mock resolves for the override leg. */
  const LOCAL_PROVIDER = { label: 'local (custom endpoint)', model: 'qwen3-4b', extra: {}, omitParams: [] as string[] };
  let nowSpy: jest.SpyInstance;
  let now: number;

  beforeEach(() => {
    mockPost.mockReset();
    mockOverridePost.mockReset();
    __resetUtilityOutageCounterForTests();
    __resetDeepseekBillingLatchForTests();
    __resetUtilityOverrideLatchForTests();
    now = 1_800_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    mockResolveRoleModel.mockResolvedValue('local:qwen3-4b');
    mockResolveProviderForRun.mockResolvedValue(LOCAL_PROVIDER);
    mockPost.mockImplementation((url: string) => Promise.resolve(url.includes('deepseek') ? deepseekSuccess('ds-ok') : dashscopeSuccess('fb-ok')));
  });
  afterEach(() => {
    nowSpy.mockRestore();
    mockResolveRoleModel.mockResolvedValue('');
    __resetUtilityOverrideLatchForTests();
  });

  it('a timeout latches the override off: the next calls skip it (built-in chain answers directly), then it is retried after the window', async () => {
    mockOverridePost.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    expect(await utilityChat([{ role: 'user', content: 'title me' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(1);
    expect(utilityOverrideLatched()).toBe(true);
    // Latched: the override is not touched again.
    expect(await utilityChat([{ role: 'user', content: 'again' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(1);
    // After the window the override is retried — and it recovers.
    now += UTILITY_OVERRIDE_LATCH_MS + 1;
    mockOverridePost.mockResolvedValue({ data: { choices: [{ message: { content: 'local-ok' } }] } });
    expect(await utilityChat([{ role: 'user', content: 'later' }], { contentOnly: true })).toBe('local-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(2);
    expect(utilityOverrideLatched()).toBe(false);
  });

  it('connection refusals and 5xx latch too; a 4xx config error does NOT latch (it must keep surfacing)', async () => {
    mockOverridePost.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8000'), {}));
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    expect(utilityOverrideLatched()).toBe(true);
    __resetUtilityOverrideLatchForTests();
    mockOverridePost.mockRejectedValue(Object.assign(new Error('Request failed with status code 502'), { response: { status: 502 } }));
    expect(await utilityChat([{ role: 'user', content: 'y' }], { contentOnly: true })).toBe('ds-ok');
    expect(utilityOverrideLatched()).toBe(true);
    __resetUtilityOverrideLatchForTests();
    mockOverridePost.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
    expect(await utilityChat([{ role: 'user', content: 'z' }], { contentOnly: true })).toBe('ds-ok');
    expect(utilityOverrideLatched()).toBe(false);
    expect(await utilityChat([{ role: 'user', content: 'z2' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(4); // the 401 was retried on the next call
  });

  it('a healthy override is unaffected: answers come from the custom seat and nothing latches', async () => {
    mockOverridePost.mockResolvedValue({ data: { choices: [{ message: { content: 'local-ok' } }] } });
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('local-ok');
    expect(utilityOverrideLatched()).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('FO firing 47: a SUSTAINED outage escalates the backoff 5→15→30→60 (cap) — the flat window re-paid the full 30s timeout every 5 min for 4h in prod', async () => {
    mockOverridePost.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    // First failure: 5-min window, streak 1
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    expect(utilityOverrideLatched()).toBe(true);
    // Advance past the window; the retry fails again → 15-min window, streak 2
    now += UTILITY_OVERRIDE_BACKOFF_STEPS_MS[0] + 1;
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(2);
    // Advance past 15 min → 30-min window, streak 3
    now += UTILITY_OVERRIDE_BACKOFF_STEPS_MS[1] + 1;
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(3);
    // Advance past 30 min → 60-min window, streak 4
    now += UTILITY_OVERRIDE_BACKOFF_STEPS_MS[2] + 1;
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(4);
    // Advance past 60 min → still the 60-min cap, streak 5 (no unbounded growth)
    now += UTILITY_OVERRIDE_BACKOFF_STEPS_MS[3] + 1;
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(5);
    // The streak-5 window is still the cap: latched now, and one call inside
    // the window does NOT retry the override (the whole point of the backoff).
    expect(utilityOverrideLatched()).toBe(true);
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(5);
  });

  it('FO firing 47: an override SUCCESS resets the streak — a recovered seat returns to the short window on its next outage', async () => {
    mockOverridePost.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    // Escalate once to streak 2 (15-min window)
    now += UTILITY_OVERRIDE_BACKOFF_STEPS_MS[0] + 1;
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    // The seat recovers on the next retry → success resets the streak
    mockOverridePost.mockResolvedValue({ data: { choices: [{ message: { content: 'local-ok' } }] } });
    now += UTILITY_OVERRIDE_BACKOFF_STEPS_MS[1] + 1;
    expect(await utilityChat([{ role: 'user', content: 'y' }], { contentOnly: true })).toBe('local-ok');
    // Next outage starts over at the FIRST backoff step (5 min), not 30
    mockOverridePost.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    expect(await utilityChat([{ role: 'user', content: 'z' }], { contentOnly: true })).toBe('ds-ok');
    now += UTILITY_OVERRIDE_BACKOFF_STEPS_MS[0] + 1; // 5 min later the override IS retried (step 1 window, not step 3)
    expect(await utilityChat([{ role: 'user', content: 'w' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(5); // timeout, retry-timeout, recovery, post-recovery timeout, retry
  });

  it('FO firing 46: the override leg reports onMeta (leg=override) — it was the ONLY leg that did not, so project_brief rows landed leg=null', async () => {
    // The admin's Edge utility seat IS this leg in prod (firing 45's root cause
    // sat on it) — without onMeta here, every project_brief outcome row carried
    // budgetTokens but leg=null, unattributable from the audit.
    mockOverridePost.mockResolvedValue({ data: { choices: [{ message: { content: 'local-ok' }, finish_reason: 'length' }] } } as any);
    const seen: Array<Record<string, unknown>> = [];
    expect(await utilityChat([{ role: 'user', content: 'brief me' }], { contentOnly: true, onMeta: (m) => seen.push({ ...m }) })).toBe('local-ok');
    expect(seen).toHaveLength(1);
    expect(seen[0].leg).toBe('override');
    expect(seen[0].model).toBe('qwen3-4b');
    expect(seen[0].finishReason).toBe('length');
    // No onMeta when the caller passes none — the hook is optional and never throws.
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('local-ok');
    expect(seen).toHaveLength(1);
  });
});

// ── Log-signal family lane d37054e9 — ticket 8386e3e8 (2026-10-24) ─────────────
// The sweep filed 157 rows/24h of the unreachable-override warn. Adjudication
// (lane d37054e9): NOT a framework defect. The escalating backoff ladder
// (FO firing 47) already bounds a sustained outage to ONE full-timeout retry
// per backoff step (5→15→30→60 min, per process), the built-in chain answers
// every call, and the warn is the DESIGNED operator signal for an owner-side
// seat misconfiguration: in prod the 'utility' seat resolves to
// llm-cql:stanne-qwen3-4b-utility on the owner's LiteLLM gateway
// (llm.cql.ca), whose origin is dead after the 2026-10-11 incident retirement
// — the gateway restore is owner-side (backlog FO f124, oq_63f66). Like the
// credential-gate lead of family 5ae52ca3, this emit site stays UNTAGGED on
// purpose: a recurring owner-action-needed class must keep sweep-filing
// until the seat is re-pointed. This block pins that contract so a future
// taxonomy pass cannot silence it.
describe('utility override unreachable warn — log-signal 8386e3e8 (one warn per backoff step, deliberately untagged)', () => {
  const mockOverridePost = postNonStreamingCompletion as jest.Mock;
  const LOCAL_PROVIDER = { label: 'local (custom endpoint)', model: 'qwen3-4b', extra: {}, omitParams: [] as string[] };
  const loggerMock = require('./logger').default as { warn: jest.Mock };
  const unreachableWarns = () => loggerMock.warn.mock.calls.filter((c: any[]) => String(c[0] ?? '').includes('utility role override unreachable'));
  let nowSpy: jest.SpyInstance;
  let now: number;

  beforeEach(() => {
    mockPost.mockReset();
    mockOverridePost.mockReset();
    __resetUtilityOutageCounterForTests();
    __resetDeepseekBillingLatchForTests();
    __resetUtilityOverrideLatchForTests();
    loggerMock.warn.mockClear();
    now = 1_800_000_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    // Narrow to the 'utility' role ONLY (review D6): the default
    // mockResolveRoleModel also routes resolveRoleFallback('utility') through
    // this mock, so an un-narrowed resolvedValue would arm the
    // utility_fallback middle leg with the same failing override post.
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility' ? 'local:qwen3-4b' : ''));
    mockResolveProviderForRun.mockResolvedValue(LOCAL_PROVIDER);
    mockPost.mockImplementation((url: string) => Promise.resolve(url.includes('deepseek') ? deepseekSuccess('ds-ok') : dashscopeSuccess('fb-ok')));
  });
  afterEach(() => {
    nowSpy.mockRestore();
    mockResolveRoleModel.mockResolvedValue('');
    __resetUtilityOverrideLatchForTests();
  });

  it('ONE warn per backoff step (not per call), with the exact operator-guidance text — the prod rows are the ladder working', async () => {
    mockOverridePost.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    let warns = unreachableWarns();
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0])).toContain('utilityChat: utility role override unreachable (timeout of 30000ms exceeded); skipping the override for 5 min (streak 1)');
    expect(String(warns[0][0])).toContain('the built-in chain serves utility calls directly. Check the custom utility endpoint (Account → Admin → Endpoints → Model roles)');
    // Every call while latched is a SILENT skip — no warn, no override attempt.
    expect(await utilityChat([{ role: 'user', content: 'y' }], { contentOnly: true })).toBe('ds-ok');
    expect(await utilityChat([{ role: 'user', content: 'z' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(1);
    expect(unreachableWarns()).toHaveLength(1);
    // Past the 5-min window the ONE retry fails again → the next step's single warn.
    now += UTILITY_OVERRIDE_BACKOFF_STEPS_MS[0] + 1;
    expect(await utilityChat([{ role: 'user', content: 'w' }], { contentOnly: true })).toBe('ds-ok');
    warns = unreachableWarns();
    expect(warns).toHaveLength(2);
    expect(String(warns[1][0])).toContain('skipping the override for 15 min (streak 2)');
    expect(mockOverridePost).toHaveBeenCalledTimes(2);
  });

  it('the warn row is deliberately UNTAGGED (source=utility-override, NO logClass) — an owner-action class must keep sweep-filing', async () => {
    // The #1931 lead-member doctrine: tagging this site 'external' would hide
    // the recurrence of a seat pointed at a dead owner-side gateway. The 45s/
    // 90s timeouts in later prod rows are caller-chosen budgets (memory /
    // project-brief passes) inherited by the override leg — same class.
    mockOverridePost.mockRejectedValue(new Error('timeout of 45000ms exceeded'));
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    const warns = unreachableWarns();
    expect(warns).toHaveLength(1);
    expect(String(warns[0][0])).toContain('(timeout of 45000ms exceeded); skipping the override for 5 min (streak 1)');
    expect(warns[0][1]).toMatchObject({ source: 'utility-override' });
    expect(warns[0][1]).not.toHaveProperty('logClass');
  });

  it('a 4xx config error never emits the unreachable warn (the per-call fallback warn instead) — the unreachable class is only timeout/connection/5xx', async () => {
    mockOverridePost.mockRejectedValue(Object.assign(new Error('Request failed with status code 401'), { response: { status: 401 } }));
    expect(await utilityChat([{ role: 'user', content: 'x' }], { contentOnly: true })).toBe('ds-ok');
    expect(utilityOverrideLatched()).toBe(false);
    expect(unreachableWarns()).toHaveLength(0);
    const fallbackWarns = loggerMock.warn.mock.calls.filter((c: any[]) => String(c[0] ?? '').includes('utility role override failed'));
    expect(fallbackWarns).toHaveLength(1);
    expect(String(fallbackWarns[0][0])).toContain('utilityChat: utility role override failed (401) — falling back to the built-in chain');
    // A fast 4xx is retried on the very next call — the operator must keep seeing it.
    expect(await utilityChat([{ role: 'user', content: 'y' }], { contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(2);
  });
});

// ── Log-signal family lane 88351f83 — ticket 3769b1b3 (2026-11-06) ────────────
// The override leg used to inherit the CALLER's whole timeout. Prod proof that
// this was the residual defect (and that the dead-gateway premise of the
// 2026-10-24 adjudication is refuted): every residual `unreachable` row in the
// 24 h window is `streak 1`, i.e. the override SUCCEEDS between failures — an
// intermittent seat, not a dead endpoint — and `test_model_role utility`
// answered the live seat in 1,331 ms while 45 s caller budgets still expired.
// A 45 s dream_ops caller let the override sit 45 s and then handed the
// built-in chain a caller that had already spent its budget, so the designed
// failover DOUBLED worst-case latency instead of rescuing it.
describe('utilityOverrideLegTimeout — the override never eats the caller\'s whole deadline (ticket 3769b1b3)', () => {
  it('leaves a RESERVE for the built-in chain and never exceeds the caller budget', () => {
    expect(UTILITY_OVERRIDE_FALLBACK_RESERVE_MS).toBe(15_000);
    // The prod caller budgets seen on the residual rows (12/15/30/45/60/90 s).
    for (const caller of [12_000, 15_000, 30_000, 45_000, 60_000, 90_000]) {
      const leg = utilityOverrideLegTimeout(caller);
      expect(leg).toBeLessThan(caller);   // a real reserve remains for the fallback
      expect(leg).toBeGreaterThan(0);
      // The reserve is capped at half the budget, so a tight caller keeps half.
      const reserve = Math.min(UTILITY_OVERRIDE_FALLBACK_RESERVE_MS, Math.floor(caller / 2));
      expect(caller - leg).toBe(reserve);
    }
    // The two shapes the ticket names, and the generous one that must NOT be
    // over-trimmed (a flat halving would have cut this to 45 s).
    expect(utilityOverrideLegTimeout(45_000)).toBe(30_000);
    expect(utilityOverrideLegTimeout(90_000)).toBe(75_000);
    expect(utilityOverrideLegTimeout(30_000)).toBe(15_000);
  });

  it('a tiny caller budget is capped BY that budget, never over-run', () => {
    // The floor must never exceed the caller's own deadline (a 400 ms caller
    // cannot be given a 1 s leg) — the whole point is to leave budget behind.
    for (const caller of [400, 900, 1_000, 1_999]) {
      expect(utilityOverrideLegTimeout(caller)).toBeLessThanOrEqual(caller);
    }
    expect(utilityOverrideLegTimeout(400)).toBe(400);
    expect(utilityOverrideLegTimeout(1_000)).toBe(1_000);
    expect(utilityOverrideLegTimeout(2_000)).toBe(1_000);
  });

  it('a missing / nonsensical budget falls back to the 20 s default budget', () => {
    // budget falls back to 20 s; the reserve is capped at half of that (10 s),
    // so the leg is 10 s — NOT 15 s, which would leave only 5 s to answer.
    for (const bad of [NaN, 0, -5, Infinity]) {
      expect(utilityOverrideLegTimeout(bad)).toBe(10_000);
    }
    expect(utilityOverrideLegTimeout(20_000)).toBe(10_000);
  });

  it('EDGE (review C4): with NO built-in leg configured the override keeps the FULL budget', () => {
    // A keyless self-host Edge serves utility calls ONLY from the override, so
    // a reserve would have nothing to buy and a shorter leg would strictly
    // lose capacity. The flag opts out; omitting it keeps the prod behaviour.
    for (const caller of [8_000, 15_000, 45_000, 90_000]) {
      expect(utilityOverrideLegTimeout(caller, { hasBuiltInChain: false })).toBe(caller);
    }
    expect(utilityOverrideLegTimeout(NaN, { hasBuiltInChain: false })).toBe(20_000);
    // Default (flag omitted) is the reserve — prod-shaped, fail-safe.
    expect(utilityOverrideLegTimeout(45_000)).toBe(30_000);
    expect(utilityOverrideLegTimeout(45_000, { hasBuiltInChain: true })).toBe(30_000);
  });

  it('the ≤30 s band is a documented HALVING and the >30 s band a flat 15 s reserve', () => {
    // Reviewer C1 asked for the table in the doc comment to be executable, so a
    // future edit cannot silently reintroduce a false claim about the shape.
    // Floor: below 2 s the 1 s minimum-leg floor dominates, so the clean
    // halving band starts at 2 s (see the tiny-budget test above).
    const halving = [2_000, 4_000, 5_000, 6_000, 8_000, 10_000, 12_000, 15_000, 25_000, 30_000];
    for (const budget of halving) {
      expect(utilityOverrideLegTimeout(budget)).toBe(Math.floor(budget / 2));
    }
    const flatReserve = [30_001, 45_000, 60_000, 90_000, 100_000, 120_000];
    for (const budget of flatReserve) {
      expect(utilityOverrideLegTimeout(budget)).toBe(budget - UTILITY_OVERRIDE_FALLBACK_RESERVE_MS);
    }
  });
});

describe('utilityChat override leg — the reserved budget is what the leg actually posts with', () => {
  const mockOverridePost = postNonStreamingCompletion as jest.Mock;
  const LOCAL_PROVIDER = { label: 'local (custom endpoint)', model: 'qwen3-4b', extra: {}, omitParams: [] as string[] };
  const loggerMock = require('./logger').default as { warn: jest.Mock };

  beforeEach(() => {
    mockOverridePost.mockReset();
    mockPost.mockClear();
    __resetUtilityOutageCounterForTests();
    __resetDeepseekBillingLatchForTests();
    __resetUtilityOverrideLatchForTests();
    loggerMock.warn.mockClear();
    mockResolveRoleModel.mockImplementation(async (key: string) => (key === 'utility' ? 'local:qwen3-4b' : ''));
    mockResolveProviderForRun.mockResolvedValue(LOCAL_PROVIDER);
    mockPost.mockImplementation((url: string) => Promise.resolve(url.includes('deepseek') ? deepseekSuccess('ds-ok') : dashscopeSuccess('fb-ok')));
  });
  afterEach(() => {
    mockResolveRoleModel.mockResolvedValue('');
    __resetUtilityOverrideLatchForTests();
  });

  it('a 45 s caller budget posts the override at 30 s and the built-in chain still answers', async () => {
    mockOverridePost.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    expect(await utilityChat([{ role: 'user', content: 'dream' }], { timeout: 45_000, contentOnly: true })).toBe('ds-ok');
    // The leg's OWN deadline is the reserved budget — not the caller's 45 s.
    expect(mockOverridePost).toHaveBeenCalledTimes(1);
    expect(mockOverridePost.mock.calls[0][2]).toMatchObject({ timeout: 30_000 });
    // The fallback actually served: the built-in leg ran with the caller's
    // remaining budget instead of inheriting an already-expired deadline.
    expect(mockPost).toHaveBeenCalled();
    // …and the warn names the RESERVED timeout, so the operator reads the leg's
    // real budget rather than the caller's (the ticket's 45 s rows were this).
    const warns = loggerMock.warn.mock.calls.filter((c: any[]) => String(c[0] ?? '').includes('utility role override unreachable'));
    expect(String(warns[0][0])).toContain('(timeout of 30000ms exceeded)');
  });

  it('a 90 s project-brief caller keeps 75 s of override time (a flat halving would over-trim)', async () => {
    mockOverridePost.mockRejectedValue(new Error('timeout of 75000ms exceeded'));
    expect(await utilityChat([{ role: 'user', content: 'brief' }], { timeout: 90_000, contentOnly: true })).toBe('ds-ok');
    expect(mockOverridePost.mock.calls[0][2]).toMatchObject({ timeout: 75_000 });
  });

  it('a fast override is untouched: a HEALTHY seat still answers and nothing is capped away', async () => {
    mockOverridePost.mockResolvedValue({ data: { choices: [{ message: { content: 'local-ok' } }] } });
    expect(await utilityChat([{ role: 'user', content: 'x' }], { timeout: 45_000, contentOnly: true })).toBe('local-ok');
    expect(mockOverridePost).toHaveBeenCalledTimes(1);
    expect(mockOverridePost.mock.calls[0][2]).toMatchObject({ timeout: 30_000 });
    expect(utilityOverrideLatched()).toBe(false);
    expect(mockPost).not.toHaveBeenCalled(); // the built-in chain was never needed
  });
});
