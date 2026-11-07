/**
 * One-Digby Phase 2 — the C3 holdback streaming contract.
 * Narration must NEVER leak into the answer; real answers must stream.
 */

import { ChatAgentSSEAdapter, modelCardKey } from './sse-adapter';

function collect() {
  const events: Array<{ type: string; data: any }> = [];
  const adapter = new ChatAgentSSEAdapter((type, data) => events.push({ type, data }));
  return { events, adapter };
}

const LONG = 'This is the real answer. '.repeat(20); // ~500 chars

describe('ChatAgentSSEAdapter holdback (amendment C3)', () => {
  it('drops short pre-tool NARRATION on LATER rounds — never leaks into the answer; the tool line speaks in Digby\'s voice', () => {
    // FIRST-WORD OPENER (ticket 4f7263e4): the FIRST pre-tool segment is the doctrine's opener line — delivered, not dropped.
    // The narration-drop contract stays for everything AFTER the first tool call of the attempt.
    const { events, adapter } = collect();
    adapter.handle('text', { delta: 'The answer is 42 — let me verify the units.' });   // the opener: delivered
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'latest docs' } });
    adapter.handle('text', { delta: 'Let me check the latest docs on that…' });        // LATER pre-tool narration: dropped
    adapter.handle('tool_call', { name: 'scrape_as_markdown', args: { url: 'https://x.test' } });
    adapter.handle('text', { delta: LONG });

    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toContain('The answer is 42 — let me verify the units.');
    expect(chunks).not.toContain('Let me check');
    expect(chunks).toContain('This is the real answer.');
    // 2026-10-04 (status-voice.ts): the model's own narration is no longer a status line
    expect(events.some(e => e.type === 'progress' && String(e.data.message).includes('Let me check'))).toBe(false);
    expect(events.some(e => e.type === 'progress' && e.data.message === 'Digby is searching the web for “latest docs”…')).toBe(true);
  });

  it('CHAT_STATUS_FILTER_DISABLED=1 restores the narration demotion (for later rounds; the first opener still streams)', () => {
    process.env.CHAT_STATUS_FILTER_DISABLED = '1';
    try {
      const { events, adapter } = collect();
      adapter.handle('text', { delta: 'The answer is 42 — let me verify the units.' });
      adapter.handle('tool_call', { name: 'search_engine', args: { query: 'latest docs' } });
      adapter.handle('text', { delta: 'Let me check the latest docs on that…' });
      adapter.handle('tool_call', { name: 'scrape_as_markdown', args: { url: 'https://x.test' } });
      adapter.finish();
      expect(events.some(e => e.type === 'progress' && String(e.data.message).includes('Let me check'))).toBe(true);
      const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
      expect(chunks).toContain('The answer is 42 — let me verify the units.');
      expect(chunks).not.toContain('Let me check');
    } finally { delete process.env.CHAT_STATUS_FILTER_DISABLED; }
  });

  it('FIRST-WORD OPENER (ticket 4f7263e4): the first pre-tool segment streams as the answer\'s opening chunk before the tool result — the first word never waits for the tool loop', () => {
    const { events, adapter } = collect();
    const opener = 'Yes — since May the API has supported this; checking the current limits now.';
    adapter.handle('text', { delta: opener });
    adapter.handle('tool_call', { name: 'web_pipe', args: { query: 'api limits' } });
    // The opener landed BEFORE any tool_result — that is the whole fix (web_pipe alone ran 73–161 s).
    expect(events.some(e => e.type === 'chunk' && e.data.content === opener)).toBe(true);
    adapter.handle('tool_result', { name: 'web_pipe', result: 'x' });
    adapter.handle('text', { delta: LONG });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks.startsWith(opener)).toBe(true);
    expect(chunks).toContain('This is the real answer.');
    // The opener counts as answer text (the persisted row carries it — refresh-safe).
    expect(adapter.answerText.startsWith(opener)).toBe(true);
    // And the opener was the FIRST chunk of the whole stream (index 0 among chunks).
    expect(events.filter(e => e.type === 'chunk')[0].data.content).toBe(opener);
  });

  it('FIRST-WORD OPENER: exactly ONE segment — a second pre-tool segment before any tool result is still dropped (no rolling narration window)', () => {
    const { events, adapter } = collect();
    adapter.handle('text', { delta: 'Opening line the user reads.' });
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'q1' } });
    adapter.handle('text', { delta: 'Let me check more sources…' }); // second pre-tool segment: dropped
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'q2' } });
    adapter.handle('text', { delta: LONG });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toContain('Opening line the user reads.');
    expect(chunks).not.toContain('Let me check more sources');
    expect(chunks).toContain('This is the real answer.');
  });

  it('FIRST-WORD OPENER: deliverOpener:false (a MACHINE wake) keeps the byte-identical pre-2026-10-11 shape — the first segment is dropped too', () => {
    const events: Array<{ type: string; data: any }> = [];
    const adapter = new ChatAgentSSEAdapter((type, data) => events.push({ type, data }), { deliverOpener: false });
    adapter.handle('text', { delta: 'Let me check the latest docs on that…' });
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'latest docs' } });
    adapter.handle('text', { delta: LONG });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).not.toContain('Let me check');
    expect(chunks.replace(/\s+$/, '')).toBe('This is the real answer. '.repeat(20).trim());
    expect(adapter.answerText.replace(/\s+$/, '')).toBe('This is the real answer. '.repeat(20).trim());
  });

  it('FIRST-WORD OPENER: a suppressed segment delivers only the pre-marker prefix (the marker contract is untouched); resetForRetry re-arms the opener for the retry attempt', () => {
    const { events, adapter } = collect();
    // A segment carrying the FOLLOWUPS marker mid-stream: the pre-marker prefix streams
    // (the pre-existing marker-cut contract — onText line ~283), suppression latches, and
    // NO further chunk is delivered for the rest of the attempt.
    adapter.handle('text', { delta: 'Check this [Followups] junk' });
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'q' } });
    const chunks1 = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks1).toBe('Check this');
    adapter.handle('text', { delta: 'more suppressed text' });
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'q2' } });
    expect(events.filter(e => e.type === 'chunk').map(e => e.data.content).join('')).toBe('Check this');
    adapter.resetForRetry(); // clears suppression AND re-arms the opener
    const opener2 = 'Retry opener the user reads.';
    adapter.handle('text', { delta: opener2 });
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'q3' } });
    expect(events.some(e => e.type === 'chunk' && e.data.content === opener2)).toBe(true);
  });

  it('FIRST-WORD OPENER: no pre-tool text — nothing is invented (the opener only delivers what the model wrote)', () => {
    const { events, adapter } = collect();
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'q' } });
    adapter.handle('tool_result', { name: 'search_engine', result: 'x' });
    adapter.handle('text', { delta: LONG });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toContain('This is the real answer.');
    expect(events.filter(e => e.type === 'chunk').length).toBeGreaterThan(0);
  });

  it('REVIEW F1 (ticket 4f7263e4): a delivered opener does NOT mask an empty run — answerTextWithoutOpener reads empty while answerText carries the opener (the emptiness gates keep firing)', () => {
    const { events, adapter } = collect();
    // The F1 scenario: the model writes an opener, fires a tool, and finalizes with
    // NO real answer (the 5f22a689 / 871d203b empty-after-tool class). The adapter
    // delivered the opener (user-visible), but the run is empty for the gates.
    const opener = 'Yes — checking the current limits now.';
    adapter.handle('text', { delta: opener });
    adapter.handle('tool_call', { name: 'web_pipe', args: { query: 'api limits' } });
    adapter.handle('tool_result', { name: 'web_pipe', result: 'x' });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toContain(opener);                              // delivered to the user
    expect(adapter.answerText).toContain(opener);                  // persisted for refresh parity
    expect(adapter.answerTextWithoutOpener).toBe('');              // GATE VIEW: empty
    expect((adapter.answerTextWithoutOpener || '').trim()).toBe('');
    // And the real-answer shape still counts: content after the opener is content.
    const { adapter: a2 } = collect();
    a2.handle('text', { delta: opener });
    a2.handle('tool_call', { name: 'web_pipe', args: { query: 'q' } });
    a2.handle('tool_result', { name: 'web_pipe', result: 'x' });
    a2.handle('text', { delta: LONG });
    a2.finish();
    expect(a2.answerTextWithoutOpener).toContain('This is the real answer.');
    expect(a2.answerText.startsWith(opener)).toBe(true);
  });

  it('REVIEW F1 (ticket 4f7263e4): answerTextWithoutOpener is cross-attempt safe — after resetForRetry a still-opener-only retry still reads empty (recovered=false), and real retry content reads non-empty', () => {
    // Retry writes only another opener: the gate must NOT count it as content.
    const { events, adapter } = collect();
    adapter.handle('text', { delta: 'Attempt 1 opener.' });
    adapter.handle('tool_call', { name: 'web_pipe', args: { query: 'q' } });
    adapter.resetForRetry();
    adapter.handle('text', { delta: 'Attempt 2 opener only.' });
    adapter.handle('tool_call', { name: 'web_pipe', args: { query: 'q2' } });
    adapter.finish();
    expect(adapter.answerText).toContain('Attempt 1 opener.');
    expect(adapter.answerText).toContain('Attempt 2 opener only.');
    expect(adapter.answerTextWithoutOpener).toBe('');
    // Retry writes real content: reads non-empty.
    const { adapter: a2 } = collect();
    a2.handle('text', { delta: 'Attempt 1 opener.' });
    a2.handle('tool_call', { name: 'web_pipe', args: { query: 'q' } });
    a2.resetForRetry();
    a2.handle('text', { delta: 'Retry opener.' });
    a2.handle('tool_call', { name: 'web_pipe', args: { query: 'q2' } });
    a2.handle('tool_result', { name: 'web_result', result: 'x' });
    a2.handle('text', { delta: LONG });
    a2.finish();
    expect(a2.answerTextWithoutOpener).toContain('This is the real answer.');
  });

  it('REVIEW F3 (ticket 4f7263e4): a segment that crosses the holdback (≥300 chars) LATCHES the opener — a later short pre-tool segment is still dropped, never delivered as a second "opener"', () => {
    const { events, adapter } = collect();
    adapter.handle('text', { delta: LONG });                        // crosses holdback, streams live
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'q' } }); // resets streaming
    adapter.handle('text', { delta: 'Let me check more sources…' }); // a later short pre-tool segment
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'q2' } });
    adapter.handle('text', { delta: LONG });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toContain('This is the real answer.');
    expect(chunks).not.toContain('Let me check more sources');      // the ONE-segment contract holds
  });

  it('streams live once a segment crosses the holdback with no tool call', () => {
    const { events, adapter } = collect();
    adapter.handle('text', { delta: LONG.slice(0, 200) });
    expect(events.filter(e => e.type === 'chunk')).toHaveLength(0); // still buffered
    adapter.handle('text', { delta: LONG.slice(200, 400) });        // crosses 300
    expect(events.filter(e => e.type === 'chunk').length).toBeGreaterThan(0);
    adapter.handle('text', { delta: 'more' });                      // now live (minus lookahead tail)
    adapter.finish();                                               // flushes the withheld tail
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toBe(LONG.slice(0, 400) + 'more');
  });

  it('flushes a short final answer that never crossed the holdback', () => {
    const { events, adapter } = collect();
    adapter.handle('text', { delta: '42.' });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toBe('42.');
    expect(adapter.answerText).toBe('42.');
  });

  it('maps search tool calls to model-searching progress and collects source URLs', () => {
    const { events, adapter } = collect();
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'weather tokyo' } });
    adapter.handle('tool_result', { name: 'search_engine', result: '{"link":"https://example.com/a"} https://example.org/b' });
    expect(events.some(e => e.type === 'progress' && e.data.stage === 'model-searching' && e.data.message.includes('weather tokyo'))).toBe(true);
    expect(adapter.collectedSources).toEqual(expect.arrayContaining(['https://example.com/a', 'https://example.org/b']));
    expect(adapter.webSearchUsed).toBe(true);
  });

  it('unwraps Google redirect wrappers so Sources show the destination (feedback a2063c30)', () => {
    const { adapter } = collect();
    adapter.handle('tool_result', {
      name: 'search_engine',
      result: '{"link":"https://www.google.com/url?q=https://theregister.com/2026/08/12/kimi_k3/&sa=U&ved=2ah"} https://example.org/direct',
    });
    expect(adapter.collectedSources).toContain('https://theregister.com/2026/08/12/kimi_k3/');
    expect(adapter.collectedSources).toContain('https://example.org/direct');
    expect(adapter.collectedSources.some(u => u.includes('google.com/url'))).toBe(false);
  });

  it('junk-leading results do not starve the per-result slots — real citations later in the text survive (review 2026-08-16)', () => {
    const { adapter } = collect();
    // Six non-citation URLs lead (search hosts / consent pages), real ones follow.
    // Pre-fix, .slice(0, 5) on RAW matches let the junk consume every slot and the
    // downstream filter reduced the pills to zero.
    const junk = [
      'https://www.google.com/search?q=a',
      'https://www.google.com/search?q=b',
      'https://consent.google.com/m?continue=x',
      'https://www.bing.com/search?q=c',
      'https://duckduckgo.com/?q=d',
      'https://www.google.com/search?q=e',
    ].join(' ');
    adapter.handle('tool_result', {
      name: 'search_engine',
      result: `${junk} https://real-news.example.com/story https://another.example.org/report`,
    });
    expect(adapter.collectedSources).toEqual(
      expect.arrayContaining(['https://real-news.example.com/story', 'https://another.example.org/report'])
    );
  });

  it('surfaces cross-checker drafts as legacy model-response cards (errored when empty)', () => {
    const { events, adapter } = collect();
    adapter.handle('subagent_end', { model: 'deepseek-v4-pro', summary: 'draft text', time: 1234 });
    adapter.handle('subagent_end', { model: 'kimi-k2.6', summary: '', time: 240000 });
    const cards = events.filter(e => e.type === 'model-response').map(e => e.data);
    expect(cards[0]).toMatchObject({ model: 'deepseek', response: 'draft text', time: 1234 });
    expect(cards[1].model).toBe('kimi');
    expect(cards[1].error).toBeTruthy();
  });

  it('modelCardKey maps coding model ids to legacy card keys', () => {
    expect(modelCardKey('deepseek-v4-pro')).toBe('deepseek');
    expect(modelCardKey('kimi-k2.6')).toBe('kimi');
    expect(modelCardKey('glm-5.2')).toBe('glm');
  });
});

describe('ChatAgentSSEAdapter [FOLLOWUPS] stream suppression', () => {
  const LONGTXT = 'The answer with plenty of substance. '.repeat(12); // ~440 chars

  it('cuts the trailing [FOLLOWUPS] block from the live stream (marker in one delta)', () => {
    const events: Array<{ type: string; data: any }> = [];
    const a = new (require('./sse-adapter').ChatAgentSSEAdapter)((t: string, d: any) => events.push({ type: t, data: d }));
    a.handle('text', { delta: LONGTXT });
    a.handle('text', { delta: '\n[FOLLOWUPS]\n- q1\n- q2\n[/FOLLOWUPS]' });
    a.finish();
    const out = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(out).not.toContain('[FOLLOWUPS');
    expect(out).not.toContain('q1');
    expect(out).toContain('plenty of substance');
  });

  it('catches the marker split across deltas via the lookahead tail', () => {
    const events: Array<{ type: string; data: any }> = [];
    const a = new (require('./sse-adapter').ChatAgentSSEAdapter)((t: string, d: any) => events.push({ type: t, data: d }));
    a.handle('text', { delta: LONGTXT + '\n[FOLLO' });
    a.handle('text', { delta: 'WUPS]\n- q1\n[/FOLLOWUPS]' });
    a.finish();
    const out = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(out).not.toContain('[FOLLOWUPS');
    expect(out).not.toContain('q1');
  });

  it('cuts the block even when the whole answer stayed under holdback', () => {
    const events: Array<{ type: string; data: any }> = [];
    const a = new (require('./sse-adapter').ChatAgentSSEAdapter)((t: string, d: any) => events.push({ type: t, data: d }));
    a.handle('text', { delta: 'Short answer.\n[FOLLOWUPS]\n- q\n[/FOLLOWUPS]' });
    a.finish();
    const out = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(out).toBe('Short answer.');
  });

  it('suppresses case-variant markers too (ticket 0d344f95 — [Followups] streamed as literal brackets)', () => {
    const events: Array<{ type: string; data: any }> = [];
    const a = new (require('./sse-adapter').ChatAgentSSEAdapter)((t: string, d: any) => events.push({ type: t, data: d }));
    a.handle('text', { delta: LONGTXT });
    a.handle('text', { delta: '\n[Followups]\n- q1\n- q2\n[/Followups]' });
    a.finish();
    const out = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(out).not.toContain('[Followups]');
    expect(out).not.toContain('q1');
    expect(out).toContain('plenty of substance');
  });
});

describe('ChatAgentSSEAdapter confirmation UX (ask_user)', () => {
  it('maps ask_user to a hyphenated ask-user event with questionId/question/options', () => {
    const { events, adapter } = collect();
    adapter.handle('ask_user', { questionId: 'q-abc', question: 'Which environment?', options: ['staging', 'prod'] });
    expect(events).toEqual([
      { type: 'ask-user', data: { questionId: 'q-abc', question: 'Which environment?', options: ['staging', 'prod'] } },
    ]);
  });

  it('maps ask_user_resolved to ask-user-resolved and tolerates a missing options array', () => {
    const { events, adapter } = collect();
    adapter.handle('ask_user', { questionId: 'q-abc', question: 'Free-form?' });
    adapter.handle('ask_user_resolved', { questionId: 'q-abc', answered: true });
    adapter.handle('ask_user_resolved', { questionId: 'q-def', answered: false });
    expect(events[0]).toEqual({ type: 'ask-user', data: { questionId: 'q-abc', question: 'Free-form?', options: [] } });
    expect(events[1]).toEqual({ type: 'ask-user-resolved', data: { questionId: 'q-abc', answered: true } });
    expect(events[2]).toEqual({ type: 'ask-user-resolved', data: { questionId: 'q-def', answered: false } });
  });

  it('forwards the expiresAt soft deadline when present, omits it when absent/invalid', () => {
    const { events, adapter } = collect();
    adapter.handle('ask_user', { questionId: 'q-t1', question: 'Timed?', options: [], expiresAt: 1_800_000_000_000 });
    adapter.handle('ask_user', { questionId: 'q-t2', question: 'Legacy?', options: [] });
    adapter.handle('ask_user', { questionId: 'q-t3', question: 'Bad?', options: [], expiresAt: 'not-a-number' });
    expect(events[0]).toEqual({ type: 'ask-user', data: { questionId: 'q-t1', question: 'Timed?', options: [], expiresAt: 1_800_000_000_000 } });
    expect(events[1]).toEqual({ type: 'ask-user', data: { questionId: 'q-t2', question: 'Legacy?', options: [] } });
    expect(events[2]).toEqual({ type: 'ask-user', data: { questionId: 'q-t3', question: 'Bad?', options: [] } });
  });

  it('forwards option descriptions and multiSelect only when the run sent them', () => {
    const { events, adapter } = collect();
    adapter.handle('ask_user', {
      questionId: 'q-c', question: 'Which style?', options: ['Playful', 'Minimal'], multiSelect: true,
      optionDetails: [{ label: 'Playful', description: 'cartoon pup' }, { label: 'Minimal' }],
    });
    expect(events[0]).toEqual({ type: 'ask-user', data: {
      questionId: 'q-c', question: 'Which style?', options: ['Playful', 'Minimal'], multiSelect: true,
      optionDetails: [{ label: 'Playful', description: 'cartoon pup' }, { label: 'Minimal' }],
    } });
  });

  it('a pending question does not disturb the holdback state machine', () => {
    const { events, adapter } = collect();
    adapter.handle('text', { delta: 'Before the question. ' + LONG });
    adapter.handle('ask_user', { questionId: 'q-1', question: 'Continue?', options: [] });
    adapter.handle('ask_user_resolved', { questionId: 'q-1', answered: true });
    adapter.handle('text', { delta: 'After the answer.' });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toContain('Before the question.');
    expect(chunks).toContain('After the answer.');
  });
});

describe('unwrapRedirectUrl (audit p10 — wider redirector coverage)', () => {
  const { unwrapRedirectUrl } = require('./sse-adapter');
  const DEST = 'https://theregister.com/2026/08/12/kimi_k3/';

  it('unwraps google.com and www.google.com /url (both ?q= and ?url=)', () => {
    expect(unwrapRedirectUrl(`https://www.google.com/url?q=${DEST}&sa=U`)).toBe(DEST);
    expect(unwrapRedirectUrl(`https://google.com/url?url=${DEST}`)).toBe(DEST);
  });

  it('unwraps regional Google domains (google.co.uk, google.de, google.com.au)', () => {
    expect(unwrapRedirectUrl(`https://www.google.co.uk/url?q=${DEST}&ved=2ah`)).toBe(DEST);
    expect(unwrapRedirectUrl(`https://google.de/url?q=${DEST}`)).toBe(DEST);
    expect(unwrapRedirectUrl(`https://www.google.com.au/url?url=${DEST}`)).toBe(DEST);
  });

  it('does NOT unwrap a lookalike host (notgoogle.com) or a non-/url Google path', () => {
    const lookalike = `https://notgoogle.com/url?q=${DEST}`;
    expect(unwrapRedirectUrl(lookalike)).toBe(lookalike);
    const searchPage = 'https://www.google.com/search?q=kimi+k3';
    expect(unwrapRedirectUrl(searchPage)).toBe(searchPage);
  });

  it("unwraps Bing click-tracking with the 'a1'-prefixed base64url u= param", () => {
    const enc = 'a1' + Buffer.from(DEST).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    expect(unwrapRedirectUrl(`https://www.bing.com/ck/a?!&&p=abc123&u=${encodeURIComponent(enc)}&ntb=1`)).toBe(DEST);
  });

  it('unwraps a Bing u= param that is already a plain URL', () => {
    expect(unwrapRedirectUrl(`https://bing.com/ck/a?u=${encodeURIComponent(DEST)}`)).toBe(DEST);
  });

  it('leaves a Bing URL alone when u= is missing or not confidently decodable', () => {
    const noParam = 'https://www.bing.com/ck/a?!&&p=abc123';
    expect(unwrapRedirectUrl(noParam)).toBe(noParam);
    const junk = 'https://www.bing.com/ck/a?u=%21%21not-base64%21%21';
    expect(unwrapRedirectUrl(junk)).toBe(junk);
    // 'a1'-shaped but decodes to garbage (not http…) → original preserved
    const garbage = 'a1' + Buffer.from('not a url at all').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    const wrapped = `https://www.bing.com/ck/a?u=${encodeURIComponent(garbage)}`;
    expect(unwrapRedirectUrl(wrapped)).toBe(wrapped);
  });

  it('unwraps DuckDuckGo /l/?uddg= (percent-encoded destination)', () => {
    expect(unwrapRedirectUrl(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(DEST)}&rut=abc`)).toBe(DEST);
    // no uddg → untouched
    const bare = 'https://duckduckgo.com/l/?rut=abc';
    expect(unwrapRedirectUrl(bare)).toBe(bare);
  });

  it('passes opaque Vertex grounding redirects through, unwraps only an explicit dest param', () => {
    const opaque = 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQFvB4Xyzzy123';
    expect(unwrapRedirectUrl(opaque)).toBe(opaque); // no local destination to extract
    expect(unwrapRedirectUrl(`https://vertexaisearch.cloud.google.com/grounding-api-redirect/x?url=${encodeURIComponent(DEST)}`)).toBe(DEST);
  });

  it('never mangles ordinary or unparseable URLs', () => {
    expect(unwrapRedirectUrl(DEST)).toBe(DEST);
    expect(unwrapRedirectUrl('not a url')).toBe('not a url');
  });
});

describe('isNonCitationHost (owner report 2026-08-15 — junk source pills)', () => {
  const { isNonCitationHost } = require('./sse-adapter');

  it('drops bare search-engine hosts on any regional google TLD', () => {
    expect(isNonCitationHost('https://www.google.com/search?q=x')).toBe(true);
    expect(isNonCitationHost('https://google.co.uk/url?q=...')).toBe(true);
    expect(isNonCitationHost('https://www.google.com.au/')).toBe(true);
    expect(isNonCitationHost('https://www.bing.com/search?q=x')).toBe(true);
    expect(isNonCitationHost('https://duckduckgo.com/?q=x')).toBe(true);
    expect(isNonCitationHost('https://search.yahoo.com/search?p=x')).toBe(true);
    expect(isNonCitationHost('https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc')).toBe(true);
  });

  it('drops the search vendor doc host that leaks from tool error text', () => {
    expect(isNonCitationHost('https://docs.brightdata.com/api-reference/errors')).toBe(true);
    expect(isNonCitationHost('https://brightdata.com/')).toBe(false); // marketing site stays
  });

  it('keeps real content, including google-operated subdomains', () => {
    expect(isNonCitationHost('https://cerebras.net/press')).toBe(false);
    expect(isNonCitationHost('https://support.google.com/chrome/answer/95669')).toBe(false);
    expect(isNonCitationHost('https://developers.google.com/learn')).toBe(false);
    expect(isNonCitationHost('https://blog.google/technology/ai/')).toBe(false);
    expect(isNonCitationHost('not a url')).toBe(false);
  });
});

describe('Sources harvest — listing-shaped results are not citations (ticket 659b5074)', () => {
  // The occurrence (chat 83dac781, msg 5ca55539, 2026-10-23): the lead's FIRST
  // tool call was a throwaway github_search_code {"query":"test"} probe; the
  // auto-scope expanded it to the owner's orgs and the tt-metal listing's blob
  // URLs were harvested into metadata.sources — tt-metal chips under a
  // Reed-Smith invoice answer. The model even said "That was a stray call —
  // disregarding it" in its own text part; the chips disagreed.
  const LISTING = '[GitHub Code Search — scoped to the connected GitHub account(s); GitHub\'s code-search index covers each repo\'s default branch only; forks match only with fork:true, and some private repos are not indexed (for a known path, use github_get_file_contents)]\n--- pastapaul_canadaquant (@example-org) | effective query: test user:example-org org:sundaymarketmedia org:canada-quant fork:true ---\n# Code Search Results for "test user:example-org org:sundaymarketmedia org:canada-quant fork:true"\n\nTotal matches: 9,728\n\n## canada-quant/tt-metal\n  File: tt_metal/hostdevcommon/api/hostdevcommon/flags.hpp\n  https://github.com/canada-quant/tt-metal/blob/2af458338fd88430598a4d0414adf72066b92406/tt_metal/hostdevcommon/api/hostdevcommon/flags.hpp';

  it('a github_search_code LISTING never harvests its blob URLs as Sources chips (ticket 659b5074 occurrence replay)', () => {
    const { adapter } = collect();
    adapter.handle('tool_call', { name: 'github_search_code', args: { query: 'test' } });
    adapter.handle('tool_result', { name: 'github_search_code', result: LISTING });
    expect(adapter.collectedSources).toEqual([]);
  });

  it('an EXPLICIT-SCOPE listing (repo:/org: query) is gated the same way — scoping does not make a listing a document', () => {
    const { adapter } = collect();
    adapter.handle('tool_result', { name: 'github_search_code', result: '[GitHub Code Search — explicit scope; results from the GitHub code-search index only]\n## some/repo\n  File: src/a.ts\n  https://github.com/some/repo/blob/abc/src/a.ts' });
    expect(adapter.collectedSources).toEqual([]);
  });

  it('a DOCUMENT-shaped GitHub read (github_get_file_contents) still harvests its URLs — the gate is shape, not host', () => {
    const { adapter } = collect();
    adapter.handle('tool_result', { name: 'github_get_file_contents', result: '[GitHub File: canada-quant/tt-metal/README.md]\n# tt-metal\nSee https://github.com/canada-quant/tt-metal/wiki for docs.' });
    expect(adapter.collectedSources).toContain('https://github.com/canada-quant/tt-metal/wiki');
  });

  it('the marker must LEAD the result — a doc that merely MENTIONS the marker text later still harvests', () => {
    const { adapter } = collect();
    adapter.handle('tool_result', { name: 'github_get_file_contents', result: 'Intro text about a search.\n[GitHub Code Search — mentioned mid-document]\nhttps://example.com/real-doc' });
    expect(adapter.collectedSources).toContain('https://example.com/real-doc');
  });

  it('GITHUB_LISTING_SOURCES_DISABLED=1 restores the pre-fix harvest (kill switch)', () => {
    process.env.GITHUB_LISTING_SOURCES_DISABLED = '1';
    try {
      const { adapter } = collect();
      adapter.handle('tool_result', { name: 'github_search_code', result: LISTING });
      expect(adapter.collectedSources.some(u => u.includes('canada-quant/tt-metal'))).toBe(true);
    } finally { delete process.env.GITHUB_LISTING_SOURCES_DISABLED; }
  });
});

describe('Sources harvest — stored material is not a citation (ticket 23e80d1e)', () => {
  // The occurrence (chat 85d32cf9, 2026-11-06): the owner asked a question,
  // the run called search_memory, and the answer's Sources row carried a
  // YouTube video for "some random game". The video was never fetched by that
  // run — it was the provenance URL inside a STORED `youtube_pipe` finding a
  // PRIOR run had ingested, surfaced verbatim by search_memory.
  const RECALL = [
    '[1] (web_pipe · youtube:How to beat level 3)',
    '[YouTube transcript: Speedrun tricks for a random game (https://www.youtube.com/watch?v=dQw4w9WgXcQ)]',
    'the video walks through the level 3 skip …',
    '',
    '[2] (learning · learnings.md)',
    'Some durable convention the run needed — see https://github.com/canada-quant/tt-metal/blob/abc/notes.md',
  ].join('\n');

  it('a search_memory recall never promotes a STORED video URL to a Sources chip (ticket 23e80d1e occurrence replay)', () => {
    const { adapter } = collect();
    adapter.handle('tool_call', { name: 'search_memory', args: { query: 'what do I know about this' } });
    adapter.handle('tool_result', { name: 'search_memory', result: RECALL });
    expect(adapter.collectedSources).toEqual([]);
  });

  it('the recalled video URL is not harvested even when it is the ONLY URL — the recall body is what gates it', () => {
    const { adapter } = collect();
    adapter.handle('tool_result', { name: 'search_memory', result: 'hit: (web_pipe) https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(adapter.collectedSources).toEqual([]);
  });

  // The class, not one door (adversarial review F1 of ticket 23e80d1e): the
  // SAME harvest fired through every stored-object read, all of them on the
  // chat profile (CHAT_ORCH_TOOLS unions PLATFORM_TOOL_NAMES) — a URL inside
  // prior chat text / a canvas / a knowledge doc is provenance of the stored
  // object, not a page this answer read.
  it.each([
    'list_memory', 'search_chats', 'get_chat_messages', 'get_supervisor_state',
    'get_feedback', 'get_canvas', 'list_canvases', 'read_document',
    'list_knowledge_documents', 'read_session_file', 'list_session_files',
  ])('%s returns stored content — its URLs never become citations', (tool) => {
    const { adapter } = collect();
    adapter.handle('tool_result', { name: tool, result: RECALL });
    expect(adapter.collectedSources).toEqual([]);
  });

  it('a WEB tool in the same run still harvests its URLs — the gate is provenance, not the answer', () => {
    const { adapter } = collect();
    adapter.handle('tool_result', { name: 'search_memory', result: RECALL });
    adapter.handle('tool_result', { name: 'web_pipe', result: 'digest\n\nSOURCES:\n- story (https://real-news.example.com/story)' });
    expect(adapter.collectedSources).toEqual(['https://real-news.example.com/story']);
  });

  it('a web FETCH of a document still harvests — github_get_file_contents FETCHES for this run, so it is a real citation', () => {
    const { adapter } = collect();
    adapter.handle('tool_result', { name: 'github_get_file_contents', result: '[GitHub File: a/b.md]\nsee https://example.com/fetched-doc' });
    expect(adapter.collectedSources).toContain('https://example.com/fetched-doc');
  });

  it('search_code_semantic and other non-stored tools keep harvesting (no blanket gate)', () => {
    const { adapter } = collect();
    adapter.handle('tool_result', { name: 'search_code_semantic', result: 'chunk at backend/src/a.ts\nsee https://example.com/design-doc' });
    expect(adapter.collectedSources).toContain('https://example.com/design-doc');
  });

  it('STORED_MATERIAL_SOURCES_DISABLED=1 restores the pre-fix harvest (kill switch)', () => {
    process.env.STORED_MATERIAL_SOURCES_DISABLED = '1';
    try {
      const { adapter } = collect();
      adapter.handle('tool_result', { name: 'search_memory', result: RECALL });
      expect(adapter.collectedSources).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    } finally { delete process.env.STORED_MATERIAL_SOURCES_DISABLED; }
  });
});

describe('browser_observation forwarding (UI Phase 6a — the browser program)', () => {
  it('forwards browser_observation verbatim as the legacy browser-observation event', () => {
    const { events, adapter } = collect();
    const data = { action: 'navigate', ok: true, url: 'https://example.com/pricing', driver: 'cloud', preview: 'Example…', reasoning: 'Opening pricing' };
    adapter.handle('browser_observation', data);
    expect(events).toEqual([{ type: 'browser-observation', data }]);
  });

  it('screenshot frames pass through untouched (base64 payload intact)', () => {
    const { events, adapter } = collect();
    const data = { action: 'screenshot', ok: true, url: 'https://example.com', driver: 'local', screenshotBase64: 'iVBORw0KGgo=' };
    adapter.handle('browser_observation', data);
    expect(events).toEqual([{ type: 'browser-observation', data }]);
  });

  it('never disturbs the text pipeline: an observation mid-holdback leaves the buffered answer intact', () => {
    const { events, adapter } = collect();
    adapter.handle('text', { delta: 'Short buffered answer.' });
    adapter.handle('browser_observation', { action: 'get_content', ok: true, url: 'https://example.com', driver: 'cloud' });
    adapter.finish();
    const chunks = events.filter(e => e.type === 'chunk').map(e => e.data.content).join('');
    expect(chunks).toBe('Short buffered answer.');
  });
});

describe('ChatAgentSSEAdapter tool rows — seat label + human status (owner 2026-09-15)', () => {
  it('tool_result → tool_done carries the lead seat label so the client pairs call↔result per seat', () => {
    const { events, adapter } = collect();
    adapter.handle('tool_call', { name: 'search_engine', args: { query: 'x' } });
    adapter.handle('tool_result', { name: 'search_engine', result: 'abc' });
    const done = events.find(e => e.type === 'agent-activity' && e.data.kind === 'tool_done');
    expect(done?.data).toEqual({ kind: 'tool_done', label: 'Digby', name: 'search_engine', size: 3 });
  });

  it('the tool_call status line names no raw tool id (owner directive 2026-07-24)', () => {
    const { events, adapter } = collect();
    adapter.handle('tool_call', { name: 'scrape_as_markdown', args: { url: 'https://example.com/page' } });
    adapter.handle('tool_call', { name: 'weird_custom_tool', args: { thing: 'x' } });
    const lines = events.filter(e => e.type === 'progress').map(e => String(e.data.message));
    expect(lines.join('\n')).not.toMatch(/scrape|markdown|weird|_/);
    expect(lines[0]).toContain('Digby is reading example.com');
    // Unknown tools fall to the generic sentence (was "Digby is using weird custom tool").
    expect(lines[1]).toContain('Digby is working on it');
  });
});

describe('image passthrough (screenshots in the chat, 2026-09-23)', () => {
  it("forwards the coding-lane 'image' event under the same legacy name, payload verbatim", () => {
    const sent: Array<[string, any]> = [];
    const a = new ChatAgentSSEAdapter((t, d) => sent.push([t, d]));
    const data = { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'Final page · example.com', source: 'browser', pageUrl: 'https://example.com' };
    a.handle('image', data);
    expect(sent).toEqual([['image', data]]);
  });
});
