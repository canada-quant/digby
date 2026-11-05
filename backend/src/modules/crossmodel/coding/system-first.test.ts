/**
 * SYSTEM-FIRST message normalization — ticket 68167bbf, 2026-10-28.
 *
 * THE MISHAP REPLAYED HERE: coding-agent turns on `tt-qwen3.8-flash-next`
 * (vLLM on the Tenstorrent Quietbox, behind LiteLLM) failed deterministically
 * with
 *   litellm.BadRequestError: OpenAIException - messages[2].role is system; the
 *   system message must be first
 * and the platform's own fingerprint named the shape:
 *   [tt-qwen3.8-flash-next] tools=51: system:53440 user:2407 system:265
 * The 3rd message is the agent loop's per-turn `[HARNESS CLOCK]` note
 * (buildCodingClockNote is EXACTLY 265 chars), pushed after the user turn.
 * Because that 400 matched no deterministic fingerprint it took the
 * spurious-in-budget-400 lane: 3 backoffs of the byte-identical payload + 2
 * context shrinks, every turn, forever.
 *
 * These tests pin (a) the classifier, (b) the merge, (c) the learned latch.
 * The end-to-end request shape is pinned in coding-model.system-first.test.ts.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// datetime-context (the real clock-note builder) imports the DB/env config for
// its timezone loader — stub both so the leaf stays a leaf under test.
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) },
}));

import {
  SYSTEM_ORDER_REJECTION_RE,
  isSystemOrderRejection,
  hoistSystemMessages,
  latchSystemFirst,
  systemFirstLatched,
  systemFirstKey,
  systemFirstNormalizeDisabled,
  __resetSystemFirstLatchForTests,
} from './system-first';
import { buildCodingClockNote } from './datetime-context';

beforeEach(() => {
  __resetSystemFirstLatchForTests();
  delete process.env.SYSTEM_FIRST_NORMALIZE_DISABLED;
});

// ── The classifier ───────────────────────────────────────────────────────────
describe('isSystemOrderRejection — the real provider phrasings', () => {
  it.each([
    // VERBATIM incident body (the LiteLLM/OpenAI wrapper text).
    'litellm.BadRequestError: OpenAIException - messages[2].role is system; the system message must be first',
    'messages[2].role is system; the system message must be first',
    'Error code: 400 - {"error":{"message":"messages[3].role is system; the system message must be first"}}',
    'System message must be at the beginning of the conversation',
    'system prompt must be the first message',
    'The system message must be first before any user message',
    'Only one system message is allowed',
    'multiple system messages are not allowed',
  ])('convicts: %s', (body) => {
    expect(isSystemOrderRejection(body)).toBe(true);
    expect(SYSTEM_ORDER_REJECTION_RE.test(body)).toBe(true);
  });

  it.each([
    '',
    '   ',
    // The other deterministic classes must NOT be swallowed by this lane.
    'request exceeds the maximum context length allowed',
    'Request too large or malformed for the model',
    'This model does not support tools',
    'Unsupported parameter: tool_choice',
    "Unknown parameter: 'reasoning_effort'",
    'rate limit reached, please retry',
    'Insufficient balance for this account',
    'DataInspectionFailed: Input text data may contain inappropriate content',
    'messages[2].content must be a string',
    'the model must be specified first',
  ])('acquits: %s', (body) => {
    expect(isSystemOrderRejection(body)).toBe(false);
  });

  it('tolerates repeated whitespace and newlines in the provider body (drained JSON often wraps)', () => {
    expect(isSystemOrderRejection('messages[2].role is\n  system;\n  the system message must be first')).toBe(true);
  });
});

// ── The merge ────────────────────────────────────────────────────────────────
describe('hoistSystemMessages — every system message becomes ONE leading block', () => {
  it('THE MISHAP REPLAY: system:53440 user:2407 system:265 → ONE leading system, user preserved, in order', () => {
    const doctrine = 'D'.repeat(53_440);
    const clock = 'C'.repeat(265); // buildCodingClockNote is exactly 265 chars
    const user = 'U'.repeat(2_407);
    const out = hoistSystemMessages([
      { role: 'system', content: doctrine },
      { role: 'user', content: user },
      { role: 'system', content: clock },
    ]);

    expect(out.changed).toBe(true);
    expect(out.systemCount).toBe(2);
    // EXACTLY one system message, and it is FIRST — the whole point.
    expect(out.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    // Content is preserved verbatim, in document order: the per-turn clock note
    // ends the system block, so recency is kept as far as system-first allows.
    expect(out.messages[0].content).toBe(`${doctrine}\n\n${clock}`);
    expect(out.messages[1].content).toBe(user);
    // Byte-for-byte, nothing lost.
    expect(out.messages[0].content.length).toBe(53_440 + 2 + 265);
  });

  it('the real clock note rides the tail — and the merge preserves it verbatim', () => {
    // The note's LENGTH varies with the date (`day:'numeric'` renders "Oct 28"
    // = 6 chars but "Nov 5" = 5) and with the timezone, so it is asserted as a
    // RANGE — pinning an absolute 265 was a date-dependent CI time bomb (the
    // adversarial review caught it: it would have gone red on 2026-11-01).
    const note = buildCodingClockNote('America/Vancouver');
    expect(note.startsWith('[HARNESS CLOCK')).toBe(true);
    expect(note.length).toBeGreaterThan(240);
    expect(note.length).toBeLessThan(400);
    const out = hoistSystemMessages([
      { role: 'system', content: 'doctrine' },
      { role: 'user', content: 'go' },
      { role: 'system', content: note },
    ]);
    expect(out.messages).toHaveLength(2);
    // Byte-exact preservation is what matters, not the length.
    expect(String(out.messages[0].content).endsWith(note)).toBe(true);
  });

  it('an already-legal transcript is returned UNCHANGED (same reference — no churn, no cache break)', () => {
    const input = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' },
    ];
    const out = hoistSystemMessages(input);
    expect(out.changed).toBe(false);
    expect(out.messages).toBe(input); // identical reference: nothing rebuilt
  });

  it('no system message at all → unchanged (never invents one)', () => {
    const input = [{ role: 'user', content: 'u' }];
    const out = hoistSystemMessages(input);
    expect(out.changed).toBe(false);
    expect(out.messages).toBe(input);
  });

  it('the trailing transient notes the agent loop pushes all fold in, in push order', () => {
    const out = hoistSystemMessages([
      { role: 'system', content: 'doctrine' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'body' },
      { role: 'system', content: '[HARNESS CLOCK] clock' },
      { role: 'system', content: '<plan>reminder</plan>' },
      { role: 'system', content: '[EVIDENCE LEDGER] ledger' },
    ]);
    expect(out.messages.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(out.systemCount).toBe(4);
    expect(out.messages[0].content).toBe('doctrine\n\n[HARNESS CLOCK] clock\n\n<plan>reminder</plan>\n\n[EVIDENCE LEDGER] ledger');
    // Tool linkage survives untouched — the merge never reorders non-system messages.
    expect(out.messages[2].tool_calls[0].id).toBe('t1');
    expect(out.messages[3].tool_call_id).toBe('t1');
  });

  it('all-string traffic collapses to a plain STRING (ZAI/GLM reject array content, error 1214)', () => {
    const out = hoistSystemMessages([
      { role: 'user', content: 'u' },
      { role: 'system', content: 'tail' },
    ]);
    expect(typeof out.messages[0].content).toBe('string');
    expect(out.messages[0].content).toBe('tail');
    expect(out.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
  });

  it('a non-text part keeps the merged content as a parts array (never String()-flattened)', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const out = hoistSystemMessages([
      { role: 'system', content: [{ type: 'text', text: 'a' }, img] },
      { role: 'user', content: 'u' },
      { role: 'system', content: 'tail' },
    ]);
    expect(Array.isArray(out.messages[0].content)).toBe(true);
    expect(JSON.stringify(out.messages[0].content)).not.toContain('[object Object]');
    expect(out.messages[0].content).toContainEqual(img);
  });

  it('empties are dropped from the merged block; an all-empty block stays a legal empty system message', () => {
    const out = hoistSystemMessages([
      { role: 'system', content: '  ' },
      { role: 'user', content: 'u' },
      { role: 'system', content: 'real' },
    ]);
    expect(out.messages[0].content).toBe('real');
    const allEmpty = hoistSystemMessages([
      { role: 'user', content: 'u' },
      { role: 'system', content: '' },
    ]);
    expect(allEmpty.messages[0]).toEqual({ role: 'system', content: '' });
  });

  it('never mutates the caller\'s array or messages', () => {
    const messages = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'system', content: 'tail' },
    ];
    const snapshot = JSON.parse(JSON.stringify(messages));
    hoistSystemMessages(messages);
    expect(messages).toEqual(snapshot);
    expect(messages).toHaveLength(3); // the input keeps its trailing system message
  });

  it('a system message that LEADS but is not the only one still merges (system, user, system → system, user)', () => {
    const out = hoistSystemMessages([
      { role: 'system', content: 'head' },
      { role: 'user', content: 'u' },
      { role: 'system', content: 'tail' },
    ]);
    expect(out.changed).toBe(true);
    expect(out.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    expect(out.messages[0].content).toBe('head\n\ntail');
  });

  it('a system message that does not lead and is the only one is still hoisted', () => {
    const out = hoistSystemMessages([
      { role: 'user', content: 'u' },
      { role: 'system', content: 'late' },
    ]);
    expect(out.changed).toBe(true);
    expect(out.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
  });
});

// ── The learned latch ────────────────────────────────────────────────────────
describe('system-first latch — one rejection teaches the process, never paid twice', () => {
  const SEAT = { url: 'https://llm.cql.ca/v1/chat/completions', model: 'tt-qwen3.8-flash-next' };

  it('starts clean, latches on the first rejection, and is keyed per (endpoint, model)', () => {
    expect(systemFirstLatched(SEAT)).toBe(false);
    expect(latchSystemFirst(SEAT)).toBe(true); // first time: new
    expect(systemFirstLatched(SEAT)).toBe(true);
    // A different model on the same endpoint is a DIFFERENT seat.
    expect(systemFirstLatched({ ...SEAT, model: 'tt-qwen3.8-27b' })).toBe(false);
    // A different endpoint serving the same model id is also different.
    expect(systemFirstLatched({ ...SEAT, url: 'https://other.example/v1/chat/completions' })).toBe(false);
  });

  it('latching twice is idempotent (reports "already known" the second time)', () => {
    expect(latchSystemFirst(SEAT)).toBe(true);
    expect(latchSystemFirst(SEAT)).toBe(false);
  });

  it('an unusable seat key never latches everything', () => {
    expect(systemFirstKey(null)).toBe('');
    expect(systemFirstKey({})).toBe('');
    expect(latchSystemFirst(null)).toBe(false);
    expect(systemFirstLatched({})).toBe(false);
  });

  it('the kill switch is read per call (ops can flip it without a reload)', () => {
    expect(systemFirstNormalizeDisabled()).toBe(false);
    process.env.SYSTEM_FIRST_NORMALIZE_DISABLED = '1';
    expect(systemFirstNormalizeDisabled()).toBe(true);
    process.env.SYSTEM_FIRST_NORMALIZE_DISABLED = 'on';
    expect(systemFirstNormalizeDisabled()).toBe(true);
    process.env.SYSTEM_FIRST_NORMALIZE_DISABLED = '0';
    expect(systemFirstNormalizeDisabled()).toBe(false);
    delete process.env.SYSTEM_FIRST_NORMALIZE_DISABLED;
  });
});