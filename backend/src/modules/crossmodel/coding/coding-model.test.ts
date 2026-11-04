/**
 * Degeneration guard: a model repetition loop (the same sentence emitted over and
 * over) must be detected so the stream can abort instead of poisoning the transcript.
 */

import { looksRepetitive, repeatedLineInContent, longLineRepeatCounts, normalizeCodingModel, createThinkRouter, resolveProvider, sanitizeMessages, EMPTY_ASSISTANT_PLACEHOLDER, modelSupportsVision, resolveProviderForRun, modelSupportsVisionForRun, sseRawTextPayload } from './coding-model';
jest.mock('../../../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../model-endpoints/model-endpoints.service', () => ({ resolveRegistryModel: jest.fn() }));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
const { resolveRegistryModel } = jest.requireMock('../model-endpoints/model-endpoints.service') as { resolveRegistryModel: jest.Mock };

/** Drive a think-router over chunks and collect answer/think output. */
function runRouter(model: string, chunks: string[]) {
  let answer = '', think = '';
  const r = createThinkRouter(model, { onAnswer: s => { answer += s; }, onThink: s => { think += s; } });
  for (const c of chunks) r.feed(c);
  r.flush();
  return { answer, think };
}

describe('coding-model degeneration guard', () => {
  test('normal short prose is not flagged', () => {
    expect(looksRepetitive('Here is a concise answer with a couple of sentences. Done.')).toBe(false);
    expect(looksRepetitive('')).toBe(false);
  });

  test('a repeated sentence trips the detector', () => {
    const loop = 'Let me read the formatters section and the fallback message. Let me add the formatter function and update the fallback message. '.repeat(30);
    expect(looksRepetitive(loop)).toBe(true);
  });

  test('long but varied prose under the cap is not flagged', () => {
    // 200 distinct sentences — long, but no repeating suffix.
    const varied = Array.from({ length: 200 }, (_, i) => `Point number ${i}: a distinct observation about item ${i * 7 + 3}.`).join(' ');
    expect(varied.length).toBeGreaterThan(4000);
    expect(looksRepetitive(varied)).toBe(false);
  });

  test('absurdly long prose is flagged by the hard cap', () => {
    expect(looksRepetitive('a'.repeat(40_001))).toBe(true);
  });
});

describe('line-level repetition probe (ticket 03587322)', () => {
  // The incident (lane 596102ca firing-256, 2026-09-21): ONE narration line
  // repeated dozens of times across a ~38-min streaming final with OTHER text
  // interleaved — the suffix probe (contiguous tail repeat) stayed blind.
  const LINE = 'Executing the two mandated transcript pulls — get_chat_messages on both lanes (independent, batched):';
  const filler = (i: number) => `Step ${i} ledger note: the volume cap broke the loop earlier. Now executing for real this time.`;

  test('an identical long line repeated across interleaved filler trips the detector (incident shape)', () => {
    const content = Array.from({ length: 5 }, (_, i) => `${LINE}\n${filler(i)}`).join('\n');
    expect(looksRepetitive(content)).toBe(true);
    const hit = repeatedLineInContent(content);
    expect(hit).not.toBeNull();
    expect(hit!.line).toBe(LINE);
    expect(hit!.count).toBeGreaterThanOrEqual(5);
  });

  test('four copies stay below the in-turn threshold', () => {
    const content = Array.from({ length: 4 }, (_, i) => `${LINE}\n${filler(i)}`).join('\n');
    expect(repeatedLineInContent(content)).toBeNull();
    expect(looksRepetitive(content)).toBe(false); // the suffix probe stays blind too (the filler varies the tail)
  });

  test('numbered copies of one loop line share a digit-collapsed form', () => {
    const content = Array.from({ length: 5 }, (_, i) => `Writing junk todo noop-f256-break${i + 2} into the foreign board right now:`).join('\n');
    expect(repeatedLineInContent(content)).not.toBeNull();
    expect(looksRepetitive(content)).toBe(true);
  });

  test('short repeated lines are exempt (they are the suffix probe\'s jurisdiction)', () => {
    const content = Array.from({ length: 10 }, (_, i) => `Working on it (${i}).`).join('\n');
    expect(repeatedLineInContent(content)).toBeNull();
  });

  test('repeated lines inside fenced code blocks do not count (log pastes are legitimate)', () => {
    const logLine = 'ERROR worker-3: connection reset by peer, retrying in 5s';
    const content = 'The box keeps failing; here is the log:\n```\n'
      + Array.from({ length: 8 }, () => logLine).join('\n')
      + '\n```\nMy diagnosis follows.';
    expect(repeatedLineInContent(content)).toBeNull();
    expect(looksRepetitive(content)).toBe(false);
  });

  test('longLineRepeatCounts normalizes whitespace, folds digit runs, and excludes lines under 40 chars', () => {
    const content = [
      'Executing  the mandated transcript pulls — batch 12 (independent):',
      'a short line',
      'Executing the mandated transcript pulls — batch 13 (independent):',
    ].join('\n');
    const counts = longLineRepeatCounts(content);
    expect(counts.size).toBe(1); // the short line is under the floor; both long lines share one digit-folded key
    const entry = [...counts.values()][0];
    expect(entry.count).toBe(2);
    expect(entry.line).toBe('Executing the mandated transcript pulls — batch 12 (independent):');
  });
});

describe('GLM <think> stream router', () => {
  test('routes a leading think block to reasoning, rest to answer (one chunk)', () => {
    const { answer, think } = runRouter('glm-5.3', ['<think>reasoning here</think>The answer.']);
    expect(think).toBe('reasoning here');
    expect(answer).toBe('The answer.');
  });

  test('handles tags split across chunk boundaries', () => {
    const { answer, think } = runRouter('glm-5.3', ['<thi', 'nk>plan', 'ning</thi', 'nk>Final ', 'answer']);
    expect(think).toBe('planning');
    expect(answer).toBe('Final answer');
  });

  test('tolerates leading whitespace before the think tag', () => {
    const { answer, think } = runRouter('glm-5.3', ['\n\n', '<think>x</think>', 'y']);
    expect(think).toBe('x');
    expect(answer).toBe('y');
  });

  test('content with no think block is all answer', () => {
    const { answer, think } = runRouter('glm-5.3', ['Just ', 'the answer, no tags.']);
    expect(answer).toBe('Just the answer, no tags.');
    expect(think).toBe('');
  });

  test('an unclosed think block flushes as reasoning (never leaks as answer)', () => {
    const { answer, think } = runRouter('glm-5.3', ['<think>still thinking when the stream ended']);
    expect(think).toBe('still thinking when the stream ended');
    expect(answer).toBe('');
  });

  test('the router is UNIVERSAL (2026-09-08): a leading <think> block is reasoning for ANY model name', () => {
    // A custom Qwen served without a reasoning parser (or via a raw-text SSE
    // gateway) streams its chain-of-thought inside content — that used to leak
    // into worker reports for every non-glm model name.
    const { answer, think } = runRouter('cql-litellm:qwen3-4b', ['<think>plan</think>body']);
    expect(think).toBe('plan');
    expect(answer).toBe('body');
    // …and is a byte-identical no-op for models that never emit the tag.
    const plain = runRouter('deepseek-flash', ['Just ', 'the answer.']);
    expect(plain.answer).toBe('Just the answer.');
    expect(plain.think).toBe('');
    // Answers that merely START with '<' are not swallowed waiting for a tag.
    const html = runRouter('kimi-k3', ['<b>bold</b> rest']);
    expect(html.answer).toBe('<b>bold</b> rest');
  });
});

describe('normalizeCodingModel', () => {
  test('defaults unknown models to glm-5.3', () => {
    expect(normalizeCodingModel(undefined)).toBe('glm-5.3');
    expect(normalizeCodingModel('something-else')).toBe('glm-5.3');
    expect(normalizeCodingModel('kimi-k3')).toBe('kimi-k3');
    // Legacy: chat-agent council + pre-switch coding sessions still resolve K2.6.
    expect(normalizeCodingModel('kimi-k2.6')).toBe('kimi-k2.6');
  });
  test('auto-migrates stored glm-5.2 rows to glm-5.3 (owner 2026-09-03 cutover)', () => {
    expect(normalizeCodingModel('glm-5.2')).toBe('glm-5.3');
  });
});

describe('glm-5.3 provider config (owner 2026-09-03 cutover)', () => {
  test('reasoning always on: thinking enabled + reasoning_effort max, temperature 0.6', () => {
    const p = resolveProvider('glm-5.3');
    expect(p.model).toBe('glm-5.3');
    expect(p.url).toContain('api.z.ai');
    // GLM-5.3 hard-fails on thinking:{type:'disabled'} — must be enabled.
    expect((p.extra as any).thinking).toEqual({ type: 'enabled' });
    expect((p.extra as any).reasoning_effort).toBe('max');
    expect((p.extra as any).temperature).toBe(0.6);
    // GLM-5.3's thinking counts against max_tokens: the 16k default let the
    // supervisor's final note come back EMPTY (2026-09-11). 2026-09-29 (owner:
    // max output everywhere): the vendor range [1,131072], live-probed.
    expect((p.extra as any).max_tokens).toBe(131072);
  });
});

describe('deepseek-flash provider config (DeepSeek V4.1 Flash cutover 2026-09-10)', () => {
  test('reasoning_effort max with thinking enabled (owner 2026-09-03 directive carried forward)', () => {
    const p = resolveProvider('deepseek-flash');
    expect(p.model).toBe('deepseek-flash');
    expect(p.url).toContain('api.deepseek.com');
    expect(p.envKey).toBe('DEEPSEEK_API_KEY');
    expect((p.extra as any).reasoning_effort).toBe('max');
    expect((p.extra as any).thinking).toEqual({ type: 'enabled' });
    // Reasoning counts against max_tokens on thinking models — the 16k
    // runModelTurn default starved a 'max'-effort final turn (2026-09-11).
    // 2026-09-29 (owner: max output everywhere): vendor range [1, 393216].
    expect((p.extra as any).max_tokens).toBe(393216);
  });
  test('the retired vendor ids alias FORWARD (stored sessions/prefs/seat overrides keep running)', () => {
    // deepseek-v4-flash: retired 2026-09-10 (vendor routes it to V4.1 Flash);
    // deepseek-v4-pro: routed to V4.1 Flash from 2026-09-14 12:00 Beijing.
    expect(normalizeCodingModel('deepseek-v4-pro')).toBe('deepseek-flash');
    expect(normalizeCodingModel('deepseek-v4-flash')).toBe('deepseek-flash');
    expect(normalizeCodingModel('deepseek-flash')).toBe('deepseek-flash');
    // The other aliases are untouched.
    expect(normalizeCodingModel('glm-5.2')).toBe('glm-5.3');
    expect(normalizeCodingModel('kimi-k2.6')).toBe('kimi-k2.6');
    expect(normalizeCodingModel('not-a-model')).toBe('glm-5.3');
  });
});

describe('kimi-k3 provider config', () => {
  test('omits fixed sampling params and uses max_completion_tokens', () => {
    const p = resolveProvider('kimi-k3');
    expect(p.model).toBe('kimi-k3');
    expect(p.url).toContain('api.moonshot.ai');
    // K3 fixes sampling server-side — temperature must NOT be sent.
    expect((p.extra as any).temperature).toBeUndefined();
    expect((p.extra as any).thinking).toBeUndefined(); // K2.x param, invalid on K3
    expect((p.extra as any).max_completion_tokens).toBe(262144); // 2026-09-29: max output that always fits K3's window
    expect(p.omitParams).toContain('max_tokens'); // K2.x output cap, stripped from the payload
  });

  test('kimi-k2.6 keeps its legacy required temperature=1', () => {
    const p = resolveProvider('kimi-k2.6');
    expect((p.extra as any).temperature).toBe(1);
    expect(p.omitParams).toBeUndefined();
  });
});

describe('per-model context budgets (compaction trigger sized to the window)', () => {
  it('gives each model a budget scaled to its real context window', () => {
    expect(resolveProvider('kimi-k3').contextChars).toBe(800_000);        // 1M window
    expect(resolveProvider('glm-5.3').contextChars).toBe(4_000_000);      // 1M window (docs.z.ai; live-verified 2026-09-10: a 1.15M-token request answered 200)
    expect(resolveProvider('deepseek-flash').contextChars).toBe(4_000_000); // 1M window (api-docs.deepseek.com; live-verified 2026-09-10: a 916k-token needle request answered correctly)
    expect(resolveProvider('kimi-k2.6').contextChars).toBe(400_000);       // 256k window
  });
  it('helper tiers stay lean', () => {
    expect(resolveProvider('qwen3.6-27b').contextChars).toBe(120_000);
  });
});

describe('modelSupportsVision (the attach-images gate)', () => {
  it('is true for kimi-k3, kimi-k2.6, qwen3.6-27b and deepseek-flash (V4.1 Flash is natively multimodal — live-verified 2026-09-10)', () => {
    expect(modelSupportsVision('kimi-k3')).toBe(true);
    expect(modelSupportsVision('kimi-k2.6')).toBe(true);
    expect(modelSupportsVision('qwen3.6-27b')).toBe(true);
    expect(modelSupportsVision('deepseek-flash')).toBe(true);
  });
  it('is false for the text-only models (images must be 400-rejected, never stripped)', () => {
    expect(modelSupportsVision('glm-5.3')).toBe(false); // GLM-5.3 flagship is text-only (vision = glm-5.3-flash utility)
  });
});

describe('sanitizeMessages — array-aware same-role merge (vision turns)', () => {
  const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAAN' } };

  test('array content passes through verbatim when nothing merges', () => {
    const content = [{ type: 'text', text: 'what is in this screenshot?' }, img];
    const out = sanitizeMessages([{ role: 'user', content }]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe(content); // same array — not rebuilt, not stringified
  });

  test('consecutive same-role strings merge exactly as before (plain string, \\n\\n join)', () => {
    const out = sanitizeMessages([
      { role: 'system', content: 's' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].content).toBe('a\n\nb\n\nc');
    expect(typeof out[1].content).toBe('string'); // all-string traffic stays byte-identical
  });

  test('string + parts-array merge yields combined parts (never "[object Object]")', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'before' },
      { role: 'user', content: [{ type: 'text', text: 'after' }, img] },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([{ type: 'text', text: 'before\n\nafter' }, img]);
    expect(JSON.stringify(out[0].content)).not.toContain('[object Object]');
  });

  test('array-then-string merge joins the adjacent text parts in place', () => {
    const out = sanitizeMessages([
      { role: 'user', content: [img, { type: 'text', text: 'x' }] },
      { role: 'user', content: 'y' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([img, { type: 'text', text: 'x\n\ny' }]);
  });

  test('a merged lone text part collapses back to a plain string', () => {
    const out = sanitizeMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'user', content: 'b' },
    ]);
    expect(out[0].content).toBe('a\n\nb'); // a string, not a 1-element array
  });

  test('the merge never crosses a different role in between', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'r' },
      { role: 'user', content: 'b' },
    ]);
    expect(out.map(m => `${m.role}:${m.content}`)).toEqual(['user:a', 'assistant:r', 'user:b']);
  });

  test('orphan tool results are dropped; linked tool results are kept', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'ghost', content: 'orphan' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'file body' },
    ]);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(out.some(m => m.content === 'orphan')).toBe(false);
    expect(out[2].tool_call_id).toBe('t1');
  });

  test('safety net: a first non-system message that is not a user turn gets a synthetic user turn', () => {
    const out = sanitizeMessages([
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'a' },
    ]);
    expect(out[1].role).toBe('user');
    expect(out[1].content).toContain('[HARNESS]');
    expect(out[2]).toMatchObject({ role: 'assistant', content: 'a' });
  });
});

// Review 2026-09-13 issue 9: Moonshot 400 "message at position N with role
// assistant must not be empty" — pin the request-build repair.
describe('sanitizeMessages — empty assistant turns (Moonshot 400 repair)', () => {
  // 2026-10-24 (ticket 6d4cebff, family 5ae52ca3): the repair warn moved to
  // logHandled (info + logClass:'handled') — the taxonomy seam the sweep honors.
  const info = (jest.requireMock('../../../utils/logger') as { info: jest.Mock }).info;
  beforeEach(() => info.mockClear());

  test('an empty-content assistant with no tool_calls is dropped (Moonshot shape: user → assistant "" → tool-less next step)', () => {
    const out = sanitizeMessages([
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'draft', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'body' },
      { role: 'assistant', content: '' },            // reasoning-only / truncated turn
      { role: 'user', content: '[HARNESS] continue' },
    ]);
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(out.every(m => m.role !== 'assistant' || m.content !== '' || m.tool_calls?.length)).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('dropped=1');
  });

  test('whitespace-only and null content count as empty; a trailing empty assistant is dropped', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '   \n' },
      { role: 'user', content: 'r' },
      { role: 'assistant', content: null },
    ]);
    // The middle one sits between two user turns → placeholder; the trailing one → dropped.
    expect(out.map(m => `${m.role}:${m.content}`)).toEqual(['user:q', `assistant:${EMPTY_ASSISTANT_PLACEHOLDER}`, 'user:r']);
    expect(info).toHaveBeenCalledTimes(1); // once per turn, not once per message
    expect(String(info.mock.calls[0][0])).toContain('dropped=1');
    expect(String(info.mock.calls[0][0])).toContain('placeholder=1');
  });

  test('an empty assistant WITH tool_calls is kept verbatim (tool linkage preserved)', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'file body' },
      { role: 'assistant', content: 'done' },
    ]);
    expect(out.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(out[1].content).toBe('');
    expect(out[1].tool_calls).toHaveLength(1);
    expect(out[2].tool_call_id).toBe('t1');
    expect(info).not.toHaveBeenCalled();
  });

  test('an empty tool_calls array does not count as tool calls — the empty assistant is still repaired', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '', tool_calls: [] },
    ]);
    expect(out.map(m => m.role)).toEqual(['user']);
    expect(info).toHaveBeenCalledTimes(1);
  });

  test('placeholder path: when dropping would leave two adjacent user turns the content becomes "[no content]"', () => {
    const out = sanitizeMessages([
      { role: 'system', content: 's' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'second' },
    ]);
    expect(out.map(m => `${m.role}:${m.content}`)).toEqual(['system:s', 'user:first', 'assistant:[no content]', 'user:second']);
    expect(EMPTY_ASSISTANT_PLACEHOLDER).toBe('[no content]');
    // The two user turns were NOT merged — the turn shape survives.
    expect(out.filter(m => m.role === 'user')).toHaveLength(2);
    expect(String(info.mock.calls[0][0])).toContain('placeholder=1');
  });

  test('placeholder keeps the rest of the message (reasoning_content etc.) and never touches non-empty assistants', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', reasoning_content: 'thought…' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: 'real answer' },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', content: EMPTY_ASSISTANT_PLACEHOLDER, reasoning_content: 'thought…' });
    expect(out[3]).toEqual({ role: 'assistant', content: 'real answer' });
  });

  test('an assistant array content with only image parts is NOT treated as empty', () => {
    const img = { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } };
    const out = sanitizeMessages([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [img] },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].content).toEqual([img]);
    expect(info).not.toHaveBeenCalled();
  });

  test('tool results that followed a dropped empty assistant are orphans and are dropped with it', () => {
    const out = sanitizeMessages([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: '' },
      { role: 'tool', tool_call_id: 'ghost', content: 'orphan' },
      { role: 'assistant', content: 'final' },
    ]);
    expect(out.map(m => `${m.role}:${m.content}`)).toEqual(['user:q', 'assistant:final']);
  });

  test('ZAI first-message safety net still fires after an empty first assistant is dropped', () => {
    const out = sanitizeMessages([
      { role: 'system', content: 's' },
      { role: 'assistant', content: '' },
      { role: 'assistant', content: 'a' },
    ]);
    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out[1].content).toContain('[HARNESS]');
    expect(out[2].content).toBe('a');
  });

  test('no info row when nothing needed repair', () => {
    sanitizeMessages([{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }]);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('runModelTurn cancellation (Stop during thinking)', () => {
  const { runModelTurn, resolveProvider } = jest.requireActual('./coding-model');
  it('returns a cancelled turn immediately when isCancelled() is already true — no network call', async () => {
    const provider = resolveProvider('glm-5.3');
    const t0 = Date.now();
    const turn = await runModelTurn(provider, [{ role: 'user', content: 'hi' }], undefined, {}, 290_000, () => true);
    expect(turn.finishReason).toBe('cancelled');
    expect(turn.content).toBe('');
    expect(turn.toolCalls).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000); // never hit the network
  });
});

// ── resolveProviderForRun: Edge custom-endpoint registry (09f6e89a) ──────────
// The agent run path wires its provider through this resolver (agent.ts). A
// built-in id must NEVER touch the registry; '<label>:<modelId>' specs resolve
// against model_endpoints and fall back to glm-5.3 on any miss so the run
// stays alive. Before this wiring, custom endpoints silently ran as GLM/ZAI
// and 401'd on Edge where ZAI_API_KEY is absent.
const GLM_URL = 'https://api.z.ai/api/paas/v4/chat/completions';

describe('resolveProviderForRun (Edge custom-endpoint registry wiring)', () => {
  beforeEach(() => { resolveRegistryModel.mockReset(); });

  it('built-in model id never consults the registry', async () => {
    const p = await resolveProviderForRun('kimi-k3', 'u1');
    expect(p.model).toBe('kimi-k3');
    expect(resolveRegistryModel).not.toHaveBeenCalled();
  });

  it('undefined model → glm-5.3, registry untouched', async () => {
    const p = await resolveProviderForRun(undefined, 'u1');
    expect(p.model).toBe('glm-5.3');
    expect(p.url).toBe(GLM_URL);
    expect(resolveRegistryModel).not.toHaveBeenCalled();
  });

  it('enabled coding-capable registry spec yields the custom endpoint provider', async () => {
    resolveRegistryModel.mockResolvedValue({
      url: 'http://10.0.0.4:11434/v1/chat/completions',
      apiKey: 'sk-edge-secret',
      model: 'llama-3-70b',
      label: 'mybox',
      supportsVision: true,
      coding: true,
    });
    const p = await resolveProviderForRun('mybox:llama-3-70b', 'u1');
    expect(resolveRegistryModel).toHaveBeenCalledWith('mybox:llama-3-70b', 'u1');
    expect(p.url).toBe('http://10.0.0.4:11434/v1/chat/completions');
    expect(p.apiKey).toBe('sk-edge-secret');
    expect(p.model).toBe('llama-3-70b');
    expect(p.label).toBe('mybox (custom endpoint)');
    expect(p.contextChars).toBe(160_000);
    expect(p.supportsVision).toBe(true);
    // 2026-09-29 (owner: max reasoning + max output everywhere): max effort +
    // the model's max output (unknown family → 131,072 until a 400 names the cap).
    expect(p.extra).toEqual({ max_tokens: 131072, reasoning_effort: 'max' });
  });

  it('keyless custom endpoint (Ollama/llama.cpp) → apiKey undefined so no Bearer is ever built', async () => {
    resolveRegistryModel.mockResolvedValue({
      url: 'http://edge:11434/v1/chat/completions',
      apiKey: undefined,
      model: 'qwen2.5-coder',
      label: 'edge',
      supportsVision: false,
      coding: true,
    });
    const p = await resolveProviderForRun('edge:qwen2.5-coder');
    expect(p.apiKey).toBeUndefined();
    expect(p.model).toBe('qwen2.5-coder');
  });

  it('registry row not coding-capable → built-in glm-5.3 fallback (and SAYS so — the silent fallback hid 68b1aba3)', async () => {
    resolveRegistryModel.mockResolvedValue({
      url: 'http://x/chat/completions', apiKey: 'k', model: 'm', label: 'x',
      supportsVision: false, coding: false,
    });
    const warn = (jest.requireMock('../../../utils/logger') as { warn: jest.Mock }).warn;
    warn.mockClear();
    const p = await resolveProviderForRun('x:m', 'u1');
    expect(p.model).toBe('glm-5.3');
    expect(p.url).toBe(GLM_URL);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to built-in glm-5.3'), expect.anything());
  });

  it('spec unresolvable (null) → glm-5.3 fallback', async () => {
    resolveRegistryModel.mockResolvedValue(null);
    const p = await resolveProviderForRun('ghost:model');
    expect(p.model).toBe('glm-5.3');
  });

  it('registry throws → glm-5.3 fallback (run path stays alive)', async () => {
    resolveRegistryModel.mockRejectedValue(new Error('db down'));
    const p = await resolveProviderForRun('mybox:llama-3');
    expect(p.model).toBe('glm-5.3');
  });
});

describe('modelSupportsVisionForRun (registry-aware vision gate)', () => {
  beforeEach(() => { resolveRegistryModel.mockReset(); });

  it('registry spec honors the entry vision flag', async () => {
    resolveRegistryModel.mockResolvedValue({ url: 'u', model: 'm', label: 'l', supportsVision: true, coding: true });
    await expect(modelSupportsVisionForRun('l:m')).resolves.toBe(true);
    resolveRegistryModel.mockResolvedValue({ url: 'u', model: 'm', label: 'l', supportsVision: false, coding: true });
    await expect(modelSupportsVisionForRun('l:m')).resolves.toBe(false);
  });

  it('built-in ids answer built-in without the registry', async () => {
    await expect(modelSupportsVisionForRun('kimi-k3')).resolves.toBe(true);
    await expect(modelSupportsVisionForRun('glm-5.3')).resolves.toBe(false);
    // Legacy stored rows: glm-5.2 normalizes to glm-5.3 → still text-only.
    await expect(modelSupportsVisionForRun('glm-5.2')).resolves.toBe(false);
    expect(resolveRegistryModel).not.toHaveBeenCalled();
  });

  it('registry throw falls back to the built-in answer', async () => {
    resolveRegistryModel.mockRejectedValue(new Error('down'));
    await expect(modelSupportsVisionForRun('l:m')).resolves.toBe(false); // 'l:m' normalizes to glm-5.3 → no vision
  });
});

// ── Moonshot context caching (audit #4) ──────────────────────────────────────
// Mechanism (platform.kimi.ai/docs/guide/use-context-caching-feature-of-kimi-api):
// server-side prefix caching is AUTOMATIC; the request gains only the documented
// `prompt_cache_key` routing hint (+ restored stream_options on K3 so
// usage.cached_tokens is observable). Contract pinned here:
//   flag off        → payload byte-identical to the legacy request
//   flag on         → exactly the two documented params added, nothing else
//   param rejection → single warn, retry byte-identical legacy payload, latch
//   other errors    → escape unchanged (no fallback, no latch)
import axios from 'axios';
import { EventEmitter } from 'events';
import { runModelTurn } from './coding-model';
import {
  applyMoonshotCache,
  deriveCacheKey,
  moonshotCacheEnabled,
  isCacheParamRejection,
  cacheParamsLatchedOff,
  resetMoonshotCacheLatchForTests,
} from './moonshot-cache';

const mockPost = (axios as any).post as jest.Mock;
const mockedLogger = jest.requireMock('../../../utils/logger') as { warn: jest.Mock; debug: jest.Mock };

/** Fake SSE stream: emits the given events as `data:` lines, then [DONE] + end.
 *  Emission is deferred (setImmediate) so runModelTurn attaches listeners first. */
function sseStream(events: any[]) {
  const s: any = new EventEmitter();
  s.destroy = jest.fn(() => s.emit('close'));
  setImmediate(() => {
    for (const e of events) s.emit('data', Buffer.from(`data: ${JSON.stringify(e)}\n`));
    s.emit('data', Buffer.from('data: [DONE]\n'));
    s.emit('end');
  });
  return s;
}
const okStream = (events: any[]) => Promise.resolve({ data: sseStream(events) });
const contentChunk = (text: string) => ({ choices: [{ delta: { content: text } }] });
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

const MSGS = [{ role: 'system', content: 'SYS PROMPT' }, { role: 'user', content: 'hi' }];
const TOOLS = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }];
/** Today's exact K3 payload (construction order matters for the byte-identity check). */
const legacyK3Payload = () => ({
  model: 'kimi-k3',
  messages: [{ role: 'system', content: 'SYS PROMPT' }, { role: 'user', content: 'hi' }],
  stream: true,
  max_completion_tokens: 262144, // 16,384 → 65,536 (ticket 22c309f4, 2026-09-20) → 262,144 (owner 2026-09-29: max output everywhere)
  tools: TOOLS,
  tool_choice: 'auto',
});

describe('Moonshot context caching (MOONSHOT_CONTEXT_CACHE)', () => {
  const envBefore = process.env.MOONSHOT_CONTEXT_CACHE;
  const k3 = resolveProvider('kimi-k3');

  beforeEach(() => {
    mockPost.mockReset();
    mockedLogger.warn.mockClear();
    mockedLogger.debug.mockClear();
    resetMoonshotCacheLatchForTests();
    delete process.env.MOONSHOT_CONTEXT_CACHE;
  });
  afterAll(() => {
    if (envBefore === undefined) delete process.env.MOONSHOT_CONTEXT_CACHE;
    else process.env.MOONSHOT_CONTEXT_CACHE = envBefore;
  });

  describe('flag semantics', () => {
    it('defaults ON when unset; "0"/"false"/"off" disable; other values enable', () => {
      expect(moonshotCacheEnabled()).toBe(true);
      for (const v of ['0', 'false', 'off', ' FALSE ', 'Off']) {
        process.env.MOONSHOT_CONTEXT_CACHE = v;
        expect(moonshotCacheEnabled()).toBe(false);
      }
      process.env.MOONSHOT_CONTEXT_CACHE = '1';
      expect(moonshotCacheEnabled()).toBe(true);
    });
  });

  describe('flag off ⇒ byte-identical legacy request', () => {
    it('K3 payload matches today\'s request exactly — no cache keys, stream_options still stripped', async () => {
      process.env.MOONSHOT_CONTEXT_CACHE = '0';
      mockPost.mockImplementationOnce(() => okStream([contentChunk('ok')]));
      const turn = await runModelTurn(k3, MSGS, TOOLS, {});
      expect(turn.content).toBe('ok');
      expect(mockPost).toHaveBeenCalledTimes(1);
      const sent = mockPost.mock.calls[0][1];
      // Snapshot of the exact legacy wire shape (serialized — pins key order too).
      expect(JSON.stringify(sent)).toBe(JSON.stringify(legacyK3Payload()));
      expect('prompt_cache_key' in sent).toBe(false);
      expect('stream_options' in sent).toBe(false);
    });
  });

  describe('flag on ⇒ researched params added (and nothing else)', () => {
    it('K3 gains prompt_cache_key + stream_options {include_usage:true}', async () => {
      mockPost.mockImplementationOnce(() => okStream([contentChunk('ok')]));
      await runModelTurn(k3, MSGS, TOOLS, {});
      const sent = mockPost.mock.calls[0][1];
      expect(sent.prompt_cache_key).toBe(deriveCacheKey('kimi-k3', MSGS));
      expect(sent.stream_options).toEqual({ include_usage: true });
      // Everything else is exactly the legacy payload.
      const { prompt_cache_key: _k, stream_options: _s, ...rest } = sent;
      expect(rest).toEqual(legacyK3Payload());
    });

    it('kimi-k2.6 keeps its base stream_options and gains ONLY prompt_cache_key', () => {
      const k26 = resolveProvider('kimi-k2.6');
      const base = { model: 'kimi-k2.6', messages: MSGS, stream: true, stream_options: { include_usage: true }, temperature: 1 };
      const app = applyMoonshotCache(k26, base, MSGS);
      expect(app).not.toBeNull();
      expect(app!.addedKeys).toEqual(['prompt_cache_key']);
      expect(app!.payload.stream_options).toBe(base.stream_options); // untouched base value
      expect('prompt_cache_key' in base).toBe(false);                // base payload never mutated
    });

    it('non-Moonshot providers are untouched even with the flag on', async () => {
      expect(applyMoonshotCache(resolveProvider('glm-5.3'), { model: 'glm-5.3' }, MSGS)).toBeNull();
      expect(applyMoonshotCache(resolveProvider('deepseek-flash'), { model: 'deepseek-flash' }, MSGS)).toBeNull();
      mockPost.mockImplementationOnce(() => okStream([contentChunk('ok')]));
      await runModelTurn(resolveProvider('glm-5.3'), MSGS, undefined, {});
      expect('prompt_cache_key' in mockPost.mock.calls[0][1]).toBe(false);
    });
  });

  describe('fallback: every cache-param rejection retries the exact legacy request', () => {
    it.each([400, 413, 422])('HTTP %i → single warn + byte-identical uncached retry + latch', async (status) => {
      // Reference capture: what the request looks like with caching disabled.
      process.env.MOONSHOT_CONTEXT_CACHE = '0';
      mockPost.mockImplementationOnce(() => okStream([contentChunk('ref')]));
      await runModelTurn(k3, MSGS, TOOLS, {});
      const legacyWire = JSON.stringify(mockPost.mock.calls[0][1]);
      mockPost.mockReset();
      delete process.env.MOONSHOT_CONTEXT_CACHE;

      mockPost
        .mockImplementationOnce(() => Promise.reject(httpError(status)))
        .mockImplementationOnce(() => okStream([contentChunk('recovered')]));
      const turn = await runModelTurn(k3, MSGS, TOOLS, {});

      expect(turn.content).toBe('recovered');           // the loop never saw the failure
      expect(turn.finishReason).toBeNull();             // not an error turn
      expect(mockPost).toHaveBeenCalledTimes(2);
      expect('prompt_cache_key' in mockPost.mock.calls[0][1]).toBe(true);
      expect(JSON.stringify(mockPost.mock.calls[1][1])).toBe(legacyWire); // byte-identical fallback
      expect(mockedLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockedLogger.warn.mock.calls[0][0]).toContain('moonshot context-cache params rejected');

      // Latched: the next turn skips cache params entirely (no second failed probe).
      expect(cacheParamsLatchedOff('kimi-k3')).toBe(true);
      mockPost.mockImplementationOnce(() => okStream([contentChunk('later')]));
      await runModelTurn(k3, MSGS, TOOLS, {});
      expect(JSON.stringify(mockPost.mock.calls[2][1])).toBe(legacyWire);
      expect(mockedLogger.warn).toHaveBeenCalledTimes(1); // still exactly one warn
    });

    it('non-param errors (429 rate limit) escape unchanged — no fallback, no latch', async () => {
      mockPost.mockImplementationOnce(() => Promise.reject(httpError(429)));
      await expect(runModelTurn(k3, MSGS, TOOLS, {})).rejects.toThrow('HTTP 429');
      expect(mockPost).toHaveBeenCalledTimes(1);
      expect(cacheParamsLatchedOff('kimi-k3')).toBe(false);
      expect(mockedLogger.warn).not.toHaveBeenCalledWith(expect.stringContaining('moonshot context-cache'), expect.anything());
    });

    it('isCacheParamRejection scopes to payload-shape 4xx only', () => {
      expect(isCacheParamRejection(httpError(400))).toBe(true);
      expect(isCacheParamRejection(httpError(413))).toBe(true);
      expect(isCacheParamRejection(httpError(422))).toBe(true);
      for (const s of [401, 403, 404, 429, 500, 502]) expect(isCacheParamRejection(httpError(s))).toBe(false);
      expect(isCacheParamRejection(new Error('ETIMEDOUT'))).toBe(false); // network/timeout: no response
    });
  });

  describe('usage parse: cached_tokens flows into turn.usage', () => {
    it('reports cachedTokens from the final usage chunk + emits the debug line', async () => {
      mockPost.mockImplementationOnce(() => okStream([
        contentChunk('done'),
        { choices: [], usage: { prompt_tokens: 120_000, completion_tokens: 800, cached_tokens: 110_000 } },
      ]));
      const turn = await runModelTurn(k3, MSGS, TOOLS, {});
      expect(turn.usage).toEqual({ promptTokens: 120_000, completionTokens: 800, cachedTokens: 110_000 });
      expect(mockedLogger.debug).toHaveBeenCalledWith(expect.stringContaining('110000/120000 prompt tokens served from cache'));
    });

    it('providers that report no cached_tokens keep the legacy usage shape', async () => {
      mockPost.mockImplementationOnce(() => okStream([
        contentChunk('done'),
        { choices: [], usage: { prompt_tokens: 500, completion_tokens: 20 } },
      ]));
      const turn = await runModelTurn(resolveProvider('glm-5.3'), MSGS, undefined, {});
      expect(turn.usage).toEqual({ promptTokens: 500, completionTokens: 20 });
      expect(turn.usage && 'cachedTokens' in turn.usage).toBe(false);
      expect(mockedLogger.debug).not.toHaveBeenCalled();
    });
  });

  describe('deriveCacheKey (per-run identity)', () => {
    it('is deterministic and keyed off the stable system prefix — tail turns do not change it', () => {
      const k1 = deriveCacheKey('kimi-k3', MSGS);
      expect(k1).toBe(deriveCacheKey('kimi-k3', MSGS));
      expect(k1).toMatch(/^digby-coding-[0-9a-f]{32}$/);
      const laterTurn = [...MSGS, { role: 'assistant', content: 'step 4' }, { role: 'user', content: 'next' }];
      expect(deriveCacheKey('kimi-k3', laterTurn)).toBe(k1); // same run → same key every turn
    });

    it('parallel runs (different system blocks) and different models never share a key', () => {
      const otherRun = [{ role: 'system', content: 'SYS PROMPT for another session' }, { role: 'user', content: 'hi' }];
      expect(deriveCacheKey('kimi-k3', otherRun)).not.toBe(deriveCacheKey('kimi-k3', MSGS));
      expect(deriveCacheKey('kimi-k2.6', MSGS)).not.toBe(deriveCacheKey('kimi-k3', MSGS));
    });

    it('survives degenerate inputs (no system message, empty transcript)', () => {
      expect(deriveCacheKey('kimi-k3', [{ role: 'user', content: 'q' }])).toMatch(/^digby-coding-[0-9a-f]{32}$/);
      expect(deriveCacheKey('kimi-k3', [])).toMatch(/^digby-coding-[0-9a-f]{32}$/);
    });
  });
});

/**
 * Raw-text SSE tolerance (owner report 2026-09-05, endpoint llm.example.com): a
 * LiteLLM/vLLM gateway that streams PLAIN TEXT tokens in each `data:` line
 * instead of OpenAI JSON delta chunks. The parser used to JSON.parse every
 * line and discard the failures as keepalives → the endpoint answered blank.
 */
describe('sseRawTextPayload (raw-text SSE token extraction)', () => {
  it('strips the field name and exactly one leading space, preserving the rest', () => {
    expect(sseRawTextPayload('data: OK')).toBe('OK');
    expect(sseRawTextPayload('data:  OK')).toBe(' OK');   // one of two spaces kept (SSE strips one)
    expect(sseRawTextPayload('data: world')).toBe('world');
    expect(sseRawTextPayload('data:')).toBe('');           // empty keepalive
    expect(sseRawTextPayload('data: ')).toBe('');
  });
  it('tolerates a trailing CR (CRLF streams) and does not touch internal spaces', () => {
    expect(sseRawTextPayload('data: a b\r')).toBe('a b');
  });
});

describe('runModelTurn raw-text SSE fallback', () => {
  const mockPostRaw = (axios as any).post as jest.Mock;
  /** Fake stream that emits each token as a RAW-TEXT `data:` line (no JSON). */
  function rawTextStream(tokens: string[]) {
    const s: any = new EventEmitter();
    s.destroy = jest.fn(() => s.emit('close'));
    setImmediate(() => {
      for (const tok of tokens) s.emit('data', Buffer.from(`data: ${tok}\n\n`));
      s.emit('data', Buffer.from('data: [DONE]\n\n'));
      s.emit('end');
    });
    return s;
  }
  beforeEach(() => mockPostRaw.mockReset());

  it('assembles raw-text tokens into content instead of dropping them (llm.example.com shape)', async () => {
    // The exact wire shape observed: empty keepalive lines interleaved with tokens.
    mockPostRaw.mockImplementationOnce(() => Promise.resolve({ data: rawTextStream(['', 'Hello', ' world', '']) }));
    const seen: string[] = [];
    const turn = await runModelTurn(resolveProvider('glm-5.3'), MSGS, undefined, { onContent: s => seen.push(s) });
    expect(turn.content).toBe('Hello world');
    expect(seen.join('')).toBe('Hello world');
    expect(turn.toolCalls).toEqual([]);
  });

  it('still parses a normal JSON stream (the fallback never fires for JSON gateways)', async () => {
    mockPostRaw.mockImplementationOnce(() => okStream([contentChunk('Hi'), contentChunk(' there')]));
    const turn = await runModelTurn(resolveProvider('glm-5.3'), MSGS, undefined, {});
    expect(turn.content).toBe('Hi there');
  });
});
