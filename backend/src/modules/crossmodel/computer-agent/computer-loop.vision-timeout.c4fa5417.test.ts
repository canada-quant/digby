/**
 * Ticket c4fa5417 (2026-10-29) — REPLAY: the computer-use vision hop had NO
 * provider chain and NO per-attempt bound, so ONE hung seat ended the session.
 *
 * THE INCIDENT. Camera-only, read-only probes on a HEALTHY paired Mac
 * (cql-stanne-mbp1) died at step 1 with
 *
 *   "the vision model call failed (timeout of 90000ms exceeded)"
 *
 * four times across two supervisor sweeps (2026-10-29 00:5xZ and 04:01–04:06Z),
 * while the capture stream itself was fine every time (Mac connected, app
 * v0.9.11, frame 1568×882, displays=1, refusedRepeats=0, noChangeStrikes=0,
 * degenerateFrames=0). Every screen observation on every device was blocked.
 *
 * THE CAUSE, measured live at 04:1xZ on the production seat:
 *   - the `computer_vision` seat served `llm-cql:tt-qwen3.8-flash-next`, which
 *     produced NO first token in 55 s (test_model_role computer_vision);
 *   - the seat's own built-in default `deepseek-flash` answered the identical
 *     call shape in 683 ms, and `glm-5.3-flash` in 2.6 s.
 * `visionChat` resolved exactly ONE provider (resolveVisionSeat) and called it
 * with `timeoutMs ?? 90000`; the axios client timeout surfaced as
 * "timeout of 90000ms exceeded" and computer-loop.ts aborted the whole session.
 * The sibling vision hop (image-describe.ts) has always walked
 * `seatProviderChain` and never had this failure mode.
 *
 * THE FIX (vision-client.ts):
 *   - visionChat walks the seat CHAIN (seat model → custom fallback → built-in
 *     default), so a hung seat model is not the whole hop.
 *   - each attempt is bounded (COMPUTER_VISION_ATTEMPT_TIMEOUT_MS 45 s) inside
 *     a total hop budget that is the SAME 90 s the old single call had — the
 *     chain can never cost more wall clock than the call it replaced.
 *   - a provider that TIMED OUT is latched (10 min, per process) and moved to
 *     the BACK of every later step's chain, so a hung seat is not re-paid on
 *     each of the loop's ≤12 steps.
 *
 * These tests replay BOTH sides: the prior true positive (a hung provider DID
 * abort a healthy-capture session) and the fix (the same hung provider no
 * longer stops the step).
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockResolveRoleModel = jest.fn(async (_r: string) => '');
const mockResolveRoleFallback = jest.fn(async (_r: string) => '');
jest.mock('../model-endpoints/model-roles.service', () => ({
  __esModule: true,
  resolveRoleModel: (...a: any[]) => mockResolveRoleModel(...(a as [string])),
  resolveRoleFallback: (...a: any[]) => mockResolveRoleFallback(...(a as [string])),
}));

/** The hung seat model exactly as production carried it (llm-cql gateway). */
const HUNG_SPEC = 'llm-cql:tt-qwen3.8-flash-next';
const HUNG_URL = 'http://llm.cql.ca/v1/chat/completions';

jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: async (spec: string) => (spec === 'llm-cql:tt-qwen3.8-flash-next' ? {
    url: 'http://llm.cql.ca/v1/chat/completions',
    baseUrl: 'http://llm.cql.ca/v1',
    apiKey: 'sk-cql',
    model: 'tt-qwen3.8-flash-next',
    label: 'llm-cql',
    supportsVision: true,
    chatCapable: true,
    coding: true,
    matryoshka: false,
    thinkingOff: false,
  } : null),
}));

import axios from 'axios';
import {
  COMPUTER_VISION_ATTEMPT_TIMEOUT_MS,
  COMPUTER_VISION_BUDGET_MS,
  COMPUTER_VISION_DEFAULT_MODEL,
  COMPUTER_VISION_TIMEOUT_LATCH_MS,
  __resetComputerVisionTimeoutLatchForTests,
  isVisionTimeout,
  toChatMessages,
  visionChat,
  type VisionInputItem,
} from './vision-client';

const mockedPost = axios.post as jest.Mock;
const ok = (message: any, finish = 'stop') => ({ data: { choices: [{ message, finish_reason: finish }] } });

/** axios's own client timeout — the EXACT error class and message text of the ticket. */
const clientTimeout = (ms: number) => Object.assign(new Error(`timeout of ${ms}ms exceeded`), { code: 'ECONNABORTED' });

const ENV = ['ZAI_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'DASHSCOPE_API_KEY'] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  jest.clearAllMocks();
  __resetComputerVisionTimeoutLatchForTests();
  mockResolveRoleModel.mockResolvedValue('');
  mockResolveRoleFallback.mockResolvedValue('');
  saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  for (const k of ENV) process.env[k] = `sk-${k.toLowerCase()}`;
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

/** The step the loop issues: one screenshot + the camera tools. */
const screenshotStep = (): Parameters<typeof visionChat>[0] => ({
  instructions: 'You are a camera on this screen.',
  input: [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'Task: report whether the Mac is locked or on the desktop.' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' },
    ],
  }],
  tools: [{ type: 'function', name: 'screenshot', description: 'Take a screenshot', parameters: { type: 'object' } }],
  reasoningEffort: 'low',
  maxTokens: 4096,
});

describe('ticket c4fa5417 — the prior true positive', () => {
  it('REPLAY: the reported error text is classified as a provider TIMEOUT, not a generic failure', () => {
    // The exact message the ticket quotes, produced by axios's client timeout.
    expect(isVisionTimeout(clientTimeout(90000))).toBe(true);
    expect(isVisionTimeout({ message: 'timeout of 90000ms exceeded' })).toBe(true);
    expect(isVisionTimeout({ code: 'ETIMEDOUT' })).toBe(true);
    // A provider that REJECTED the request is a different failure — never latched off.
    expect(isVisionTimeout({ response: { status: 400 }, message: 'Request failed with status code 400' })).toBe(false);
    expect(isVisionTimeout(new Error('getaddrinfo ENOTFOUND llm.cql.ca'))).toBe(false);
  });

  it('REPLAY: before the fix this hop had a 90s envelope — pinned so the total budget can never silently grow', () => {
    expect(COMPUTER_VISION_BUDGET_MS).toBe(90_000);
    // Each attempt is bounded well inside it, so a hung provider cannot eat the hop.
    expect(COMPUTER_VISION_ATTEMPT_TIMEOUT_MS).toBeLessThan(COMPUTER_VISION_BUDGET_MS);
  });
});

describe('ticket c4fa5417 — a hung seat model no longer stops the step', () => {
  it('FIX: the hung seat model times out, the seat\'s built-in default serves the SAME step', async () => {
    mockResolveRoleModel.mockResolvedValue(HUNG_SPEC);
    mockedPost.mockImplementation(async (url: string) => {
      if (url === HUNG_URL) throw clientTimeout(COMPUTER_VISION_ATTEMPT_TIMEOUT_MS);
      return ok({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] }, 'tool_calls');
    });

    const result = await visionChat(screenshotStep());

    // The step SUCCEEDED on a healthy capture — the session does not abort.
    expect(result.functionCalls).toHaveLength(1);
    expect(result.functionCalls[0].name).toBe('screenshot');
    expect(result.model).toBe(COMPUTER_VISION_DEFAULT_MODEL);

    // Both providers were tried, in chain order, and each attempt was BOUNDED.
    const urls = mockedPost.mock.calls.map(c => c[0]);
    expect(urls[0]).toBe(HUNG_URL);
    const hungCallOpts = mockedPost.mock.calls[0][2];
    expect(hungCallOpts.timeout).toBe(COMPUTER_VISION_ATTEMPT_TIMEOUT_MS);
    // The winning call was the built-in default's endpoint, not the hung one.
    expect(urls.filter(u => u === HUNG_URL)).toHaveLength(1);
    expect(urls.length).toBeGreaterThanOrEqual(2);
  });

  it('FIX: the hung provider is LATCHED and moved last on later steps — the loop does not re-pay 45s per step', async () => {
    mockResolveRoleModel.mockResolvedValue(HUNG_SPEC);
    mockedPost.mockImplementation(async (url: string) => {
      if (url === HUNG_URL) throw clientTimeout(COMPUTER_VISION_ATTEMPT_TIMEOUT_MS);
      return ok({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] }, 'tool_calls');
    });

    await visionChat(screenshotStep());
    mockedPost.mockClear();

    // Step 2: the healthy provider is tried FIRST — zero time paid to the hung one.
    const second = await visionChat(screenshotStep());
    expect(second.model).toBe(COMPUTER_VISION_DEFAULT_MODEL);
    expect(mockedPost.mock.calls.map(c => c[0])).not.toContain(HUNG_URL);
  });

  it('FIX: a provider that answers again is UN-latched (a recovered seat is never permanently demoted)', async () => {
    mockResolveRoleModel.mockResolvedValue(HUNG_SPEC);
    let hung = true;
    let builtInOk = true;
    mockedPost.mockImplementation(async (url: string) => {
      if (url === HUNG_URL) {
        if (hung) throw clientTimeout(COMPUTER_VISION_ATTEMPT_TIMEOUT_MS);
        return ok({ content: 'The Mac is on the desktop.', tool_calls: [] });
      }
      if (!builtInOk) throw Object.assign(new Error('Request failed with status code 503'), { response: { status: 503 } });
      return ok({ content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'screenshot', arguments: '{}' } }] }, 'tool_calls');
    });

    await visionChat(screenshotStep());   // the seat model hangs → latched; built-in serves
    hung = false;                         // the seat model recovers
    builtInOk = false;                    // ...and the built-in fails, so the chain REACHES the latched seat model

    // The latched provider is moved LAST, never DROPPED: the chain still tries
    // it, it answers, and the latch is cleared.
    const third = await visionChat(screenshotStep());
    expect(third.model).toBe('tt-qwen3.8-flash-next');
    expect(third.text).toBe('The Mac is on the desktop.');

    mockedPost.mockClear();
    builtInOk = true;
    // Un-latched → the admin's seat model leads the very next step again.
    await visionChat(screenshotStep());
    expect(mockedPost.mock.calls[0][0]).toBe(HUNG_URL);
  });

  it('FIX: a REJECTION (not a timeout) still fails over, but does NOT latch the provider off', async () => {
    mockResolveRoleModel.mockResolvedValue(HUNG_SPEC);
    mockedPost.mockImplementation(async (url: string) => {
      if (url === HUNG_URL) throw Object.assign(new Error('Request failed with status code 500'), { response: { status: 500 } });
      return ok({ content: 'desktop', tool_calls: [] });
    });

    const result = await visionChat(screenshotStep());
    expect(result.text).toBe('desktop');
    mockedPost.mockClear();

    // Not latched: the seat model leads the very next step again (a 500 is
    // transient and must not silently demote the admin's chosen model).
    await visionChat(screenshotStep());
    expect(mockedPost.mock.calls[0][0]).toBe(HUNG_URL);
  });

  it('FIX: every provider failing throws ONE honest error naming each attempt', async () => {
    mockResolveRoleModel.mockResolvedValue(HUNG_SPEC);
    mockedPost.mockImplementation(async () => { throw clientTimeout(COMPUTER_VISION_ATTEMPT_TIMEOUT_MS); });

    await expect(visionChat(screenshotStep())).rejects.toThrow(/no provider in the computer-use vision seat chain answered/);
    // The message names BOTH providers, so an operator sees the whole chain failed.
    await expect(visionChat(screenshotStep())).rejects.toThrow(new RegExp(COMPUTER_VISION_DEFAULT_MODEL));
  });
});

describe('ticket c4fa5417 — the chain never costs more than the call it replaced', () => {
  it('the per-attempt bound leaves room for the wrap-up call inside the loop deadline', () => {
    // computer-loop.ts deadlineMs defaults to 300 s; one hung attempt (45 s)
    // must not consume it, and the 90 s total envelope is unchanged.
    expect(COMPUTER_VISION_BUDGET_MS).toBe(90_000);
    expect(COMPUTER_VISION_ATTEMPT_TIMEOUT_MS * 2).toBeLessThanOrEqual(COMPUTER_VISION_BUDGET_MS);
  });

  it('the hop still translates the screenshot into the chat wire shape (unchanged contract)', () => {
    const msgs = toChatMessages('SYS', screenshotStep().input as VisionInputItem[]);
    expect(msgs[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(msgs[1]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: expect.stringContaining('locked or on the desktop') },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } },
      ],
    });
  });
});