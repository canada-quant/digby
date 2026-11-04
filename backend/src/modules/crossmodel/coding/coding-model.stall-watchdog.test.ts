/**
 * runModelTurn token-idle STALL watchdog (2026-10-20 — deep research has no wall clock, owner: "deep research
 * shouldn't have any limit"; chat-agent/council-dispatch.ts researchNoWallClock).
 *
 * The council profiles dropped every final-turn deadline; the termination guarantee for a model turn that stops
 * producing is this watchdog. Pins:
 *   - a stream that sends only SSE keep-alive comments / empty `data:` lines / role-only or empty deltas is cut once
 *     NO token has arrived for `stallMs` — rejected with an ESTALL error (the agent loop's transient lane retries
 *     it: its regex matches /ESTALL/; never ETIMEDOUT, which the lead-seat-unreachable lane reads as a dead host),
 *     the stream destroyed;
 *   - every token kind resets it (content, reasoning_content, a `reasoning` field, tool_calls, usage, a raw-text
 *     payload) — a model still streaming is NEVER cut, however long it runs;
 *   - with `stallMs` the pre-header wait is max(timeoutMs, stallMs) and the post-header socket idle timer
 *     (follow-redirects' `socket.setTimeout` → `socket.destroy`) is switched off, so idle == stall only;
 *   - no `stallMs` ⇒ no watchdog, no socket change, today's axios timeout (byte-for-byte);
 *   - the interval never leaks (cleared on finish and on error).
 */
import { EventEmitter } from 'events';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import axios from 'axios';
import { runModelTurn, streamStallPollMs, looksReasoningLoop, REASONING_REPEAT_WINDOW_CHARS, type ProviderConfig, type StreamCallbacks } from './coding-model';

const mockPost = (axios as any).post as jest.Mock;
const PROVIDER: ProviderConfig = { url: 'https://api.example.test/v1/chat/completions', apiKey: 'k', model: 'glm-5.3', label: 'ZAI direct', extra: {} };

/** A synchronous fake SSE body: write() emits 'data' at once; destroy(err) emits 'error' then 'close' like a Readable. */
class FakeStream extends EventEmitter {
  destroyed = false;
  destroyedWith: unknown = undefined;
  write(s: string) { this.emit('data', Buffer.from(s)); }
  end() { this.emit('end'); this.emit('close'); }
  destroy(err?: Error) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.destroyedWith = err;
    if (err) this.emit('error', err);
    this.emit('close');
  }
}

const tok = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const SEC = 1_000;

let stream: FakeStream;
let socket: { setTimeout: jest.Mock };

beforeEach(() => {
  jest.useFakeTimers({ now: Date.parse('2026-10-20T12:00:00.000Z') });
  mockPost.mockReset();
  stream = new FakeStream();
  socket = { setTimeout: jest.fn() };
  mockPost.mockResolvedValue({ data: stream, request: { socket } });
});
afterEach(() => {
  jest.useRealTimers();
});

/** Start a turn and let the awaited axios.post settle so the stream listeners are attached. */
async function start(opts?: { stallMs?: number }, timeoutMs = 290_000, callbacks: StreamCallbacks = {}) {
  const settled: { value?: any; error?: any; done: boolean } = { done: false };
  const p = runModelTurn(PROVIDER, [{ role: 'user', content: 'research this' }], undefined, callbacks, timeoutMs, undefined, opts)
    .then((v) => { settled.value = v; settled.done = true; }, (e) => { settled.error = e; settled.done = true; });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return { p, settled };
}

describe('runModelTurn — token-idle stall watchdog', () => {
  it('keep-alive comments, empty data lines and token-less JSON never reset it: the stream is cut with ESTALL after stallMs', async () => {
    const { p, settled } = await start({ stallMs: 60 * SEC });
    expect(socket.setTimeout).toHaveBeenCalledWith(0); // the byte-idle socket kill is off — the watchdog owns idleness
    for (let t = 0; t < 4; t++) {
      jest.advanceTimersByTime(14 * SEC);
      stream.write(': keep-alive\n\n');
      stream.write('data:\n\n');
      stream.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`);
      stream.write('data: {}\n\n');
    }
    expect(settled.done).toBe(false); // 56 s of heartbeats: not yet past the 60 s window
    jest.advanceTimersByTime(20 * SEC);
    await p;
    expect(settled.done).toBe(true);
    expect(settled.error).toBeInstanceOf(Error);
    expect(settled.error.code).toBe('ESTALL');
    expect(settled.error.message).toMatch(/^ESTALL: model stream stalled — no tokens for 60s/);
    // the agent loop's transient lane (coding/agent.ts) classifies it as transport, never a size rejection…
    expect(/ECONNRESET|ETIMEDOUT|ESTALL|socket hang up/i.test(settled.error.message)).toBe(true);
    // …and it carries no connection code, so helper-seat's lead-seat-unreachable lane never re-seats on it
    expect(/\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH)\b|socket hang up/i.test(settled.error.message)).toBe(false);
    expect(stream.destroyed).toBe(true);
    expect(jest.getTimerCount()).toBe(0); // the watchdog interval is gone
  });

  it('a model that keeps streaming tokens is NEVER cut, however long it runs (30 min at one token per 50 s, stall 60 s)', async () => {
    const { p, settled } = await start({ stallMs: 60 * SEC });
    for (let i = 0; i < 36; i++) {
      jest.advanceTimersByTime(50 * SEC);
      stream.write(': ping\n\n');
      stream.write(tok(`w${i} `));
    }
    expect(settled.done).toBe(false);
    stream.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    stream.write('data: [DONE]\n\n');
    stream.end();
    await p;
    expect(settled.error).toBeUndefined();
    expect(settled.value.content).toBe(Array.from({ length: 36 }, (_, i) => `w${i} `).join(''));
    expect(settled.value.finishReason).toBe('stop');
    expect(jest.getTimerCount()).toBe(0); // cleared on finish
  });

  it.each([
    ['reasoning_content', `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] })}\n\n`],
    ['a `reasoning` field', `data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'hmm' } }] })}\n\n`],
    ['tool_calls', `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_pipe', arguments: '{' } }] } }] })}\n\n`],
    ['usage', `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`],
    ['a raw-text payload (gateway that streams plain tokens)', 'data: plain token\n\n'],
  ])('%s resets the watchdog', async (_label, line) => {
    const { p, settled } = await start({ stallMs: 60 * SEC });
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(45 * SEC);
      stream.write(line);
    }
    expect(settled.done).toBe(false); // 225 s, never 60 s without a token
    jest.advanceTimersByTime(80 * SEC);
    await p;
    expect(settled.error?.code).toBe('ESTALL'); // …and silence after the last token still trips it
  });

  it('a stream that dies on its own (provider error) clears the watchdog and rejects with that error', async () => {
    const { p, settled } = await start({ stallMs: 60 * SEC });
    stream.write(tok('partial'));
    stream.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
    await p;
    expect(settled.error?.message).toBe('aborted');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stallMs widens the pre-header wait to max(timeoutMs, stallMs) — never shorter than today', async () => {
    await start({ stallMs: 600 * SEC }, 290_000);
    expect(mockPost.mock.calls[0][2].timeout).toBe(600_000);
    mockPost.mockClear();
    stream = new FakeStream();
    mockPost.mockResolvedValue({ data: stream, request: { socket } });
    await start({ stallMs: 120 * SEC }, 290_000);
    expect(mockPost.mock.calls[0][2].timeout).toBe(290_000);
  });

  it('NO stallMs ⇒ today byte-for-byte: no watchdog timer, the socket idle timer untouched, the plain axios timeout', async () => {
    const { p, settled } = await start(undefined, 290_000);
    expect(mockPost.mock.calls[0][2].timeout).toBe(290_000);
    expect(socket.setTimeout).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(60 * 60 * SEC); // an hour of silence: nothing in this function cuts it
    stream.write(': keep-alive\n\n');
    expect(settled.done).toBe(false);
    stream.write(tok('late'));
    stream.end();
    await p;
    expect(settled.value.content).toBe('late');
  });

  it('a non-positive or non-finite stallMs is no watchdog', async () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      mockPost.mockClear();
      stream = new FakeStream();
      mockPost.mockResolvedValue({ data: stream, request: { socket } });
      const { p, settled } = await start({ stallMs: bad });
      expect(jest.getTimerCount()).toBe(0);
      expect(mockPost.mock.calls[0][2].timeout).toBe(290_000);
      expect(socket.setTimeout).not.toHaveBeenCalled();
      stream.end();
      await p;
      expect(settled.done).toBe(true);
    }
  });

  it('the poll cadence is ≤ 15 s and fine enough for a short bound', () => {
    expect(streamStallPollMs(10 * 60 * SEC)).toBe(15_000);
    expect(streamStallPollMs(40 * SEC)).toBe(10_000);
    expect(streamStallPollMs(100)).toBe(250);
  });
});

/**
 * Review 2026-10-20 — reasoning is liveness in stall mode, so it must be (a) BOUNDED: a looping reasoning stream used to
 * keep the watchdog quiet until the output budget (nothing probed reasoning for repetition), and (b) VISIBLE: a
 * gateway's `delta.reasoning` reset the watchdog but never reached onReasoning, so the council dispatch wait and the
 * deploy drain (both fed by run events) saw a reasoning colleague as idle and cut it.
 */
describe('runModelTurn — stall mode: reasoning is bounded and visible', () => {
  const rc = (reasoning_content: string) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content } }] })}\n\n`;
  const rf = (reasoning: string) => `data: ${JSON.stringify({ choices: [{ delta: { reasoning } }] })}\n\n`;
  const LOOP = 'Wait — I should re-check the second source before I conclude anything, because the figure it gives for 2026 does not match the first one. Let me re-read it carefully once more. ';
  const distinct = (i: number) => `Source ${i} (published ${2000 + (i % 26)}) reports ${(i * 7919) % 10007} units for region ${i % 13}; cross-checking it against source ${i + 1}. `;

  it('a LOOPING reasoning stream ends the turn as repetition (stream destroyed, no timer left) — never runs to the output budget', async () => {
    const onReasoning = jest.fn();
    const { p, settled } = await start({ stallMs: 60 * SEC }, 290_000, { onReasoning });
    for (let i = 0; i < 200 && !settled.done; i++) { stream.write(rc(LOOP)); await Promise.resolve(); }
    await p;
    expect(settled.error).toBeUndefined();
    expect(settled.value.finishReason).toBe('repetition');
    expect(settled.value.reasoning).toMatch(/\[Reasoning truncated — the model began repeating itself\.\]$/);
    expect(stream.destroyed).toBe(true);
    expect(onReasoning.mock.calls.length).toBeLessThan(40); // cut within a few thousand chars, not 200 loops later
    expect(jest.getTimerCount()).toBe(0);
  });

  it('long DISTINCT reasoning (~40k chars) is never cut — only a loop is', async () => {
    const { p, settled } = await start({ stallMs: 60 * SEC });
    for (let i = 0; i < 400; i++) stream.write(rc(distinct(i)));
    expect(settled.done).toBe(false);
    stream.write(tok('answer'));
    stream.end();
    await p;
    expect(settled.value.finishReason).not.toBe('repetition');
    expect(settled.value.reasoning.length).toBeGreaterThan(30_000);
    expect(settled.value.content).toBe('answer');
  });

  it('NO stallMs ⇒ today byte-for-byte: a looping reasoning stream is not probed', async () => {
    const { p, settled } = await start(undefined);
    for (let i = 0; i < 200; i++) stream.write(rc(LOOP));
    expect(settled.done).toBe(false);
    stream.end();
    await p;
    expect(settled.value.finishReason).toBeNull();
    expect(settled.value.reasoning).toBe(LOOP.repeat(200));
  });

  it('a gateway `reasoning` field reaches onReasoning + TurnResult.reasoning in stall mode (one liveness for every consumer)', async () => {
    const onReasoning = jest.fn();
    const { p, settled } = await start({ stallMs: 60 * SEC }, 290_000, { onReasoning });
    stream.write(rf('thinking hard'));
    stream.write(rf(' about it'));
    stream.write(tok('done'));
    stream.end();
    await p;
    expect(onReasoning.mock.calls.map((c) => c[0])).toEqual(['thinking hard', ' about it']);
    expect(settled.value.reasoning).toBe('thinking hard about it');
  });

  it('a delta carrying BOTH reasoning_content and reasoning (transitional vLLM) is counted once', async () => {
    const onReasoning = jest.fn();
    const { p, settled } = await start({ stallMs: 60 * SEC }, 290_000, { onReasoning });
    stream.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'once', reasoning: 'once' } }] })}\n\n`);
    stream.end();
    await p;
    expect(onReasoning).toHaveBeenCalledTimes(1);
    expect(settled.value.reasoning).toBe('once');
  });

  it('NO stallMs ⇒ a `reasoning` field is ignored exactly as before', async () => {
    const onReasoning = jest.fn();
    const { p, settled } = await start(undefined, 290_000, { onReasoning });
    stream.write(rf('thinking hard'));
    stream.end();
    await p;
    expect(onReasoning).not.toHaveBeenCalled();
    expect(settled.value.reasoning).toBe('');
  });
});

describe('looksReasoningLoop (pure)', () => {
  const para = (n: number) => `Let me re-examine the claim from the regulator's 2026 bulletin and compare it with the court filing, since the two disagree on the effective date by exactly one quarter — paragraph ${n}. `;
  it('a paragraph re-emitted six times (period ≤ 4,000 chars) is a loop', () => {
    const unit = 'Re-checking the second source because its 2026 figure disagrees with the first source and I must reconcile them before writing the answer. ';
    expect(looksReasoningLoop(unit.repeat(5))).toBe(false);
    expect(looksReasoningLoop(unit.repeat(12))).toBe(true);
    const long = Array.from({ length: 20 }, (_, i) => para(i)).join(''); // ~4k chars of distinct text
    expect(looksReasoningLoop(long)).toBe(false);
    expect(looksReasoningLoop(long.slice(0, 3_800).repeat(7))).toBe(true);
  });
  it('distinct reasoning, short reasoning and whitespace never trip it', () => {
    expect(looksReasoningLoop(Array.from({ length: 600 }, (_, i) => para(i)).join(''))).toBe(false);
    expect(looksReasoningLoop('short')).toBe(false);
    expect(looksReasoningLoop(' '.repeat(10_000))).toBe(false);
    expect(REASONING_REPEAT_WINDOW_CHARS).toBe(24_000);
  });
});
