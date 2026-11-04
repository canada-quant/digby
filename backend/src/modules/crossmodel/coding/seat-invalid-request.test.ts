import {
  classifyInvalidRequest, latchSeatInvalidRequest, seatInvalidRequestLatch, listSeatInvalidRequestLatches,
  clearSeatInvalidRequestLatch, __resetSeatInvalidRequestLatchesForTests, seatInvalidRequestLatchMs,
  seatLatchLine, SEAT_INVALID_REQUEST_LATCH_MIN_DEFAULT,
} from './seat-invalid-request';

const T0 = 1_790_000_000_000;

/** The two prod bodies (2026-09-27 18:26–18:45Z, llm.example.com). */
const TOOLS_TOO_LONG = "litellm.BadRequestError: OpenAIException - Invalid 'tools': array too long. Expected an array with maximum length 128, but got an array with length 195.";
const EFFORT_UNSUPPORTED = "litellm.BadRequestError: OpenAIException - Function tools with reasoning_effort are not supported for gpt-6-astra in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";

beforeEach(() => {
  __resetSeatInvalidRequestLatchesForTests();
  delete process.env.SEAT_INVALID_REQUEST_LATCH_MIN;
});

describe('classifyInvalidRequest — the fingerprint classifier', () => {
  it('reads the incident 400s', () => {
    expect(classifyInvalidRequest({ errorStatus: 400, providerError: TOOLS_TOO_LONG })).toMatchObject({ kind: 'tools_too_long', status: 400, cap: 128 });
    expect(classifyInvalidRequest({ errorStatus: 400, providerError: EFFORT_UNSUPPORTED })).toMatchObject({ kind: 'reasoning_effort_unsupported', status: 400 });
  });
  it('falls back to errorMessage when providerError is absent', () => {
    expect(classifyInvalidRequest({ errorStatus: 400, errorMessage: `Request failed with status code 400 — provider: ${TOOLS_TOO_LONG}` })?.kind).toBe('tools_too_long');
  });
  it('classifies the other deterministic classes', () => {
    expect(classifyInvalidRequest({ errorStatus: 400, providerError: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser' })?.kind).toBe('tools_unsupported');
    expect(classifyInvalidRequest({ errorStatus: 400, providerError: 'Unsupported parameter: stream_options' })?.kind).toBe('unsupported_param');
    expect(classifyInvalidRequest({ errorStatus: 404, providerError: 'The model `gpt-7` does not exist' })?.kind).toBe('model_not_found');
    expect(classifyInvalidRequest({ errorStatus: 404, providerError: '' })?.kind).toBe('model_not_found');
    expect(classifyInvalidRequest({ errorStatus: 400, providerError: 'Received Model Group=gpt-7 Available Model Group Fallbacks=None. Model group not found' })?.kind).toBe('model_not_found');
    expect(classifyInvalidRequest({ errorStatus: 413, providerError: '' })?.kind).toBe('context_too_long');
    expect(classifyInvalidRequest({ errorStatus: 400, providerError: "This model's maximum context length is 128000 tokens" })?.kind).toBe('context_too_long');
    expect(classifyInvalidRequest({ errorStatus: 422, providerError: 'extra fields not permitted: reasoning' })?.kind).toBe('unsupported_param');
  });
  it('never classifies non-deterministic statuses, billing, or an unrecognised 400', () => {
    expect(classifyInvalidRequest({ errorStatus: 429, providerError: TOOLS_TOO_LONG })).toBeNull();
    expect(classifyInvalidRequest({ errorStatus: 500, providerError: TOOLS_TOO_LONG })).toBeNull();
    expect(classifyInvalidRequest({ errorStatus: 401, providerError: 'model not found' })).toBeNull();
    expect(classifyInvalidRequest({ errorStatus: 400, providerError: 'account suspended due to insufficient balance' })).toBeNull();
    expect(classifyInvalidRequest({ errorStatus: 400, providerError: 'messages parameter is illegal (1214)' })).toBeNull(); // the spurious-400 incident class stays on its lane
    expect(classifyInvalidRequest({ errorStatus: undefined, providerError: TOOLS_TOO_LONG })).toBeNull();
    expect(classifyInvalidRequest({})).toBeNull();
  });
  it('bounds and collapses the detail', () => {
    const c = classifyInvalidRequest({ errorStatus: 400, providerError: `tools   array too long\n\n${'x'.repeat(500)}` })!;
    expect(c.detail.length).toBeLessThanOrEqual(301);
    expect(c.detail).not.toMatch(/\n/);
  });
});

describe('the latch', () => {
  it('latches (spec, fingerprint) for the window, lists it, expires it', () => {
    const cls = classifyInvalidRequest({ errorStatus: 400, providerError: TOOLS_TOO_LONG })!;
    const e = latchSeatInvalidRequest('cql-litellm:api-openai-gpt-6-astra', cls, T0)!;
    expect(e).toMatchObject({ spec: 'cql-litellm:api-openai-gpt-6-astra', kind: 'tools_too_long', status: 400, since: T0, until: T0 + SEAT_INVALID_REQUEST_LATCH_MIN_DEFAULT * 60_000, strikes: 1 });
    expect(e.reason).toContain("tool list over the model's limit");
    expect(seatInvalidRequestLatch('cql-litellm:api-openai-gpt-6-astra', T0 + 1000)).toBe(e);
    expect(seatInvalidRequestLatch('cql-litellm:other', T0 + 1000)).toBeNull();
    expect(listSeatInvalidRequestLatches(T0 + 1000)).toEqual([e]);
    expect(seatInvalidRequestLatch('cql-litellm:api-openai-gpt-6-astra', e.until)).toBeNull(); // expired exactly at the end
    expect(listSeatInvalidRequestLatches(e.until)).toEqual([]);
  });
  it('re-latching inside the window extends it and counts the strike; after expiry it starts fresh', () => {
    const cls = classifyInvalidRequest({ errorStatus: 400, providerError: EFFORT_UNSUPPORTED })!;
    const a = latchSeatInvalidRequest('s:m', cls, T0)!;
    const b = latchSeatInvalidRequest('s:m', cls, T0 + 60_000)!;
    expect(b.since).toBe(a.since);
    expect(b.strikes).toBe(2);
    expect(b.until).toBe(T0 + 60_000 + SEAT_INVALID_REQUEST_LATCH_MIN_DEFAULT * 60_000);
    const c = latchSeatInvalidRequest('s:m', cls, b.until + 1)!;
    expect(c.strikes).toBe(1);
    expect(c.since).toBe(b.until + 1);
  });
  it('honours SEAT_INVALID_REQUEST_LATCH_MIN (0 = no latch) and the kill switch', () => {
    process.env.SEAT_INVALID_REQUEST_LATCH_MIN = '5';
    expect(seatInvalidRequestLatchMs()).toBe(5 * 60_000);
    const cls = classifyInvalidRequest({ errorStatus: 400, providerError: TOOLS_TOO_LONG })!;
    expect(latchSeatInvalidRequest('s:m', cls, T0)!.until).toBe(T0 + 5 * 60_000);
    process.env.SEAT_INVALID_REQUEST_LATCH_MIN = '0';
    expect(latchSeatInvalidRequest('s:m2', cls, T0)).toBeNull();
    process.env.SEAT_INVALID_REQUEST_LATCH_MIN = 'garbage';
    expect(seatInvalidRequestLatchMs()).toBe(SEAT_INVALID_REQUEST_LATCH_MIN_DEFAULT * 60_000);
    delete process.env.SEAT_INVALID_REQUEST_LATCH_MIN;
  });
  it('clearSeatInvalidRequestLatch drops one seat', () => {
    const cls = classifyInvalidRequest({ errorStatus: 400, providerError: TOOLS_TOO_LONG })!;
    latchSeatInvalidRequest('s:a', cls, T0);
    latchSeatInvalidRequest('s:b', cls, T0);
    clearSeatInvalidRequestLatch('s:a');
    expect(listSeatInvalidRequestLatches(T0 + 1).map((e) => e.spec)).toEqual(['s:b']);
  });
});

describe('seatLatchLine — the owner-facing sentence', () => {
  it('renders one sentence per latched seat, null when none', () => {
    expect(seatLatchLine([])).toBeNull();
    const line = seatLatchLine([{
      role: 'supervisor', from: 'cql-litellm:api-openai-gpt-6-astra', to: 'glm-5.3',
      reason: "tool list over the model's limit — Invalid 'tools': array too long",
      since: '2026-09-27T18:26:00.000Z', until: T0,
    }])!;
    expect(line).toContain('supervisor seat cql-litellm:api-openai-gpt-6-astra unusable:');
    expect(line).toContain('running on glm-5.3 since 2026-09-27 18:26Z');
    expect(line).toContain('(retried after ');
    const noFb = seatLatchLine([{ from: 's:m', reason: 'x', since: T0 }])!;
    expect(noFb).toContain('(no fallback available)');
  });
});
