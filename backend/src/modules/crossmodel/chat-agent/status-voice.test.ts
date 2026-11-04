/**
 * Digby's status voice (owner 2026-10-04): the copy rules are pinned, and the agent loop's operator lines are
 * mapped or dropped on a chat run.
 */
import { STATUS, chatStatusForAgentProgress, resultPhrase } from './status-voice';
import { PROGRESS_LINES } from './compute-policy-wiring';
import { ChatAgentSSEAdapter } from './sse-adapter';

/** Every string the voice module can produce, with sample arguments. */
function allLines(): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') {
      for (const args of [[], ['the Double Checker'], ['the Double Checker', 'eu gdp 2025'], ['the Double Checker', true, 12_000], [3, 'the Double Checker', 'map the market'], ['search_engine'], ['the Double Checker', 'scrape_as_markdown']]) {
        try { const r = (v as (...a: unknown[]) => unknown)(...args); if (typeof r === 'string') out.push(r); } catch { /* arity mismatch */ }
      }
    } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(STATUS);
  return [...out, ...Object.values(PROGRESS_LINES)];
}

describe('status voice — the rules', () => {
  it('no jargon, vendor or model names, HTTP codes or admin paths in any status line', () => {
    for (const line of allLines()) {
      expect(line).not.toMatch(/\b(HTTP|model|seat|harness|synthesi[sz]|reconcil|council|context|token|endpoint|provider|draft)\b/i);
      expect(line).not.toMatch(/Admin|→|kimi|glm|deepseek|qwen|gpt|gemini|grok|BrightData/i);
      expect(line).not.toMatch(/\.\.\.$/); // the ellipsis character, never three dots
    }
  });

  it('keeps the fixed part short enough for a phone', () => {
    for (const line of Object.values(STATUS.lane)) expect(line.length).toBeLessThanOrEqual(80);
    expect(STATUS.thinking.length).toBeLessThanOrEqual(40);
  });

  it('says the real target in quotes', () => {
    expect(STATUS.tool.search('best ramen in Chicago')).toBe('Digby is searching the web for “best ramen in Chicago”…');
    expect(STATUS.tool.read('example.com')).toBe('Digby is reading example.com…');
    expect(STATUS.checker.search('The Double Checker', '')).toBe('The Double Checker is searching the web…');
  });

  it('result phrases are plain', () => {
    expect(resultPhrase('search_engine')).toBe('is going through the results');
    expect(resultPhrase('anything_else')).toBe('is looking over what came back');
    // the call line already said "Digby is reading <site>…" — the result line must not repeat "reading"
    expect(resultPhrase('scrape_as_markdown')).toBe('is going through the page');
  });

  it('the pulse names what Digby is doing — thinking, digging or writing', () => {
    expect(STATUS.heartbeat.thinking('0:24')).toBe('Still thinking it through — 0:24 so far…');
    expect(STATUS.heartbeat.research('0:24')).toBe('Still digging — 0:24 so far…');
    expect(STATUS.heartbeat.writing('0:24')).toBe('Still writing — 0:24 so far…');
  });
});

describe('chatStatusForAgentProgress — the agent loop on a chat run', () => {
  it('maps the stages a user should hear about', () => {
    expect(chatStatusForAgentProgress('seat-fallback', 'Coding seat x returned 429 — this turn runs on y')).toBe(STATUS.recover.backup);
    expect(chatStatusForAgentProgress('deadline', 'Time budget reached — answering now')).toBe(STATUS.recover.wrapUp);
    expect(chatStatusForAgentProgress('evidence-guard', 'x')).toBe(STATUS.recover.recheck);
  });

  it('drops operator-only beats', () => {
    expect(chatStatusForAgentProgress('tool-groups', 'Tool groups: core + account (83/128 tools)')).toBeNull();
    expect(chatStatusForAgentProgress('compact', 'Compacted earlier context to stay within limits')).toBeNull();
    expect(chatStatusForAgentProgress('derail-reanchor', 'Wrong-tool signature on x')).toBeNull();
  });

  it('rewrites the pipes in Digby\'s voice', () => {
    expect(chatStatusForAgentProgress('web_pipe', 'Searching — eu gdp')).toBe('Digby is searching the web for “eu gdp”…');
    expect(chatStatusForAgentProgress('web_pipe', 'Reading 4 sources…')).toBe('Digby is reading 4 sources…');
    expect(chatStatusForAgentProgress('youtube_pipe', 'Trying BrightData transcript — abc')).toBe('Digby is fetching the video transcript…');
    expect(chatStatusForAgentProgress('youtube_pipe', 'Searching YouTube — lofi')).toBe('Digby is searching YouTube for “lofi”…');
  });

  it('an unknown stage passes only when it reads as plain language', () => {
    expect(chatStatusForAgentProgress('mystery', 'Opening the calendar…')).toBe('Opening the calendar…');
    expect(chatStatusForAgentProgress('mystery', 'Model rejected the request (HTTP 400)')).toBeNull();
    expect(chatStatusForAgentProgress('mystery', '')).toBeNull();
  });
});

describe('the chat adapter with thinking hidden', () => {
  const collect = () => {
    const events: Array<{ type: string; data: any }> = [];
    return { events, adapter: new ChatAgentSSEAdapter((type, data) => events.push({ type, data })) };
  };

  it('sends no reasoning, one "thinking" line, and a plain line after each result', () => {
    const { events, adapter } = collect();
    adapter.handle('reasoning', { delta: 'The user wants X. I should search for Y.' });
    adapter.handle('reasoning', { delta: 'More thoughts.' });
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'Y' } });
    adapter.handle('tool_result', { name: 'search_engine', result: 'https://example.com result' });
    adapter.handle('reasoning', { delta: 'Now I know.' });
    adapter.handle('progress', { message: 'Tool groups: core + account', stage: 'tool-groups' });
    const wire = JSON.stringify(events);
    expect(wire).not.toMatch(/The user wants|More thoughts|Now I know/);
    expect(events.some((e) => e.type === 'thinking-summary')).toBe(false);
    expect(events.some((e) => e.type === 'agent-activity' && e.data.kind === 'reasoning')).toBe(false);
    expect(events.filter((e) => e.type === 'progress').map((e) => e.data.message)).toEqual([
      STATUS.thinking,
      'Digby is searching the web for “Y”…',
      'Digby is going through the results…',
    ]);
  });

  it('HIDE_REASONING_DISABLED=1 restores the live thinking mirror', () => {
    process.env.HIDE_REASONING_DISABLED = '1';
    try {
      const { events, adapter } = collect();
      adapter.handle('reasoning', { delta: 'The user wants X.' });
      expect(events.some((e) => e.type === 'agent-activity' && e.data.kind === 'reasoning')).toBe(true);
      expect(events.some((e) => e.type === 'thinking-summary')).toBe(true);
    } finally { delete process.env.HIDE_REASONING_DISABLED; }
  });
});
