/**
 * build 2026-10-08 C — deterministic context edits (context-clearing.ts):
 * restorable tool-result clearing + the malformed tool-call history repair
 * (REPLAY of run 99b4f357's gateway 400).
 */

import {
  clearOldToolResults,
  clearableToolResults,
  clearedResultStub,
  isClearedResult,
  recentRoundsStart,
  classifyMalformedToolHistory,
  repairMalformedToolCallArguments,
  isValidToolArguments,
  repairedToolArguments,
  CLEARED_RESULT_PREFIX,
  type ContextMessage,
} from './context-clearing';

const sys: ContextMessage = { role: 'system', content: 'SYSTEM' };
const user = (t: string): ContextMessage => ({ role: 'user', content: t });
const call = (id: string, name: string, args = '{"q":"x"}'): ContextMessage => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: args } }] });
const result = (id: string, text: string): ContextMessage => ({ role: 'tool', tool_call_id: id, content: text });
const chars = (ms: ContextMessage[]) => ms.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);

/** A chat turn: task, then N search/scrape rounds with big results. */
function chatTurn(rounds: number, size = 6_000): ContextMessage[] {
  const ms: ContextMessage[] = [sys, user('What changed in the 2026 Ontario budget?')];
  for (let i = 0; i < rounds; i++) {
    ms.push(call(`c${i}`, i % 2 ? 'scrape_as_markdown' : 'search_engine', `{"query":"ontario budget ${i}"}`));
    ms.push(result(`c${i}`, `RESULT-${i} ` + 'x'.repeat(size)));
  }
  return ms;
}

describe('clearing candidates', () => {
  it('keeps the newest K tool rounds raw; oldest first; never system / user / exempt / small / already-cleared', () => {
    const ms = chatTurn(5);
    ms.splice(4, 0, call('plan', 'update_plan'), result('plan', 'P'.repeat(5_000))); // exempt tool
    ms.push(call('tiny', 'search_engine'), result('tiny', 'short'));
    expect(recentRoundsStart(ms, 2)).toBe(ms.length - 4); // the last two rounds start there
    const c = clearableToolResults(ms, { keepRecentRounds: 2, minResultChars: 1_200 });
    expect(c.map((x) => x.toolCallId)).toEqual(['c0', 'c1', 'c2', 'c3']); // c4 + tiny are the two newest rounds
    expect(c.every((x, i, a) => i === 0 || a[i - 1].index < x.index)).toBe(true);
    expect(c.find((x) => x.toolCallId === 'plan')).toBeUndefined();
    expect(clearableToolResults(chatTurn(1), { keepRecentRounds: 2, minResultChars: 1 })).toEqual([]); // fewer rounds than K
  });

  it('clears oldest-first down to the target in ONE batch; pairing, roles and order intact; stub is restorable and never re-cleared', () => {
    const ms = chatTurn(6);
    const before = chars(ms);
    const r = clearOldToolResults(ms, { beforeChars: before, targetChars: before - 15_000, keepRecentRounds: 2, minResultChars: 1_200, headChars: 400 })!;
    expect(r).not.toBeNull();
    expect(r.cleared).toBe(3); // ~5.5k freed each → 3 to free 15k
    expect(r.afterChars).toBe(chars(r.messages)); // the delta is exact
    expect(r.afterChars).toBeLessThanOrEqual(before - 15_000);
    expect(r.messages.map((m) => m.role)).toEqual(ms.map((m) => m.role));
    expect(r.messages.map((m) => m.tool_call_id)).toEqual(ms.map((m) => m.tool_call_id));
    const stub = String(r.messages[3].content);
    expect(stub.startsWith(CLEARED_RESULT_PREFIX)).toBe(true);
    expect(stub).toContain('search_engine({"query":"ontario budget 0"})');
    expect(stub).toContain('Re-run the call');
    expect(stub).toContain('RESULT-0 '); // the 400-char head the summariser used to see
    expect(stub).not.toMatch(/search_memory/);
    expect(isClearedResult(stub)).toBe(true);
    expect(r.firstClearedIndex).toBe(3);
    expect(r.tools).toEqual({ search_engine: 2, scrape_as_markdown: 1 });
    // a second pass skips the stubs
    const again = clearableToolResults(r.messages, { keepRecentRounds: 2, minResultChars: 1_200 });
    expect(again.map((x) => x.toolCallId)).toEqual(['c3']);
  });

  it('returns null when nothing is clearable; the stub without a head is the tier-1 shape', () => {
    expect(clearOldToolResults(chatTurn(2), { beforeChars: 1e6, targetChars: 0, keepRecentRounds: 2, minResultChars: 1_200, headChars: 400 })).toBeNull();
    const s = clearedResultStub({ tool: 'read_file', args: '{"path":"src/x.ts"}', originalChars: 12_345 });
    expect(s).toBe('[cleared to save context: read_file({"path":"src/x.ts"}) returned 12,345 chars. Re-run the call if you need the full result.]');
  });
});

// ── REPLAY: run 99b4f357 (2026-10-07 08:30Z, cql-litellm:api-optimize-zai-glm-5.3, 204 steps) ──
const INCIDENT_400 = "litellm.BadRequestError: OpenAIException - Invalid tool call in messages: tool_calls[].function.arguments for function 'computer_task' must be a JSON object string (or an object), got invalid JSON";

describe('malformed tool-call history (run 99b4f357)', () => {
  it('classifies the incident body on a 400 / 422 — never a size, content-filter, auth or 5xx rejection', () => {
    expect(classifyMalformedToolHistory({ errorStatus: 400, providerError: INCIDENT_400 })).toMatchObject({ status: 400 });
    expect(classifyMalformedToolHistory({ errorStatus: 422, providerError: 'Failed to parse tool call arguments as JSON' })).not.toBeNull();
    expect(classifyMalformedToolHistory({ errorStatus: 400, providerError: "messages[4].tool_calls[0].function.arguments is not valid JSON" })).not.toBeNull();
    expect(classifyMalformedToolHistory({ errorStatus: 500, providerError: INCIDENT_400 })).toBeNull();
    expect(classifyMalformedToolHistory({ errorStatus: 400, providerError: 'context length exceeded: maximum context 131072 tokens' })).toBeNull();
    expect(classifyMalformedToolHistory({ errorStatus: 400, providerError: 'InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content' })).toBeNull();
    expect(classifyMalformedToolHistory({ errorStatus: 400, providerError: "Invalid 'tools': array too long" })).toBeNull();
  });

  it('re-serialises ONLY the unparseable arguments as a JSON object; ids, names, order and valid calls untouched', () => {
    const truncated = '{"task": "open Safari and go to the bank login page, then';
    const ms: ContextMessage[] = [
      sys, user('pay the hydro bill'),
      call('ok1', 'read_file', '{"path":"a.ts"}'), result('ok1', 'file a'),
      { role: 'assistant', content: '', tool_calls: [
        { id: 'bad', function: { name: 'computer_task', arguments: truncated } },
        { id: 'ok2', function: { name: 'list_dir', arguments: '{"path":"."}' } },
      ] },
      result('bad', '[tool call rejected] The arguments for computer_task arrived truncated or malformed — NOTHING was executed.'),
      result('ok2', 'a.ts'),
    ];
    const r = repairMalformedToolCallArguments(ms)!;
    expect(r.repaired).toBe(1);
    expect(r.tools).toEqual(['computer_task']);
    const fixedCall = r.messages[4].tool_calls![0]!;
    expect(fixedCall.id).toBe('bad');
    expect(fixedCall.function!.name).toBe('computer_task');
    expect(isValidToolArguments(fixedCall.function!.arguments)).toBe(true);
    expect(JSON.parse(String(fixedCall.function!.arguments)).raw_head).toBe(truncated);
    expect(r.messages[4].tool_calls![1]).toBe(ms[4].tool_calls![1]); // the valid sibling is the same object
    expect(r.messages[2]).toBe(ms[2]); // an untouched turn keeps its reference
    expect(r.messages.length).toBe(ms.length);
    expect(repairMalformedToolCallArguments(r.messages)).toBeNull(); // idempotent
  });

  it('non-object JSON and empty arguments are malformed too; objects pass; nothing to repair ⇒ null', () => {
    expect(isValidToolArguments('{"a":1}')).toBe(true);
    expect(isValidToolArguments({ a: 1 })).toBe(true);
    expect(isValidToolArguments('[1,2]')).toBe(false);
    expect(isValidToolArguments('"str"')).toBe(false);
    expect(isValidToolArguments('')).toBe(false);
    expect(repairedToolArguments('')).toBe('{}');
    expect(repairMalformedToolCallArguments([sys, user('q'), call('a', 'x', '{}'), result('a', 'r')])).toBeNull();
  });
});
