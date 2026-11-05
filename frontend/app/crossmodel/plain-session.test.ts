/**
 * makeLegacyNormalizer pins (C3, ticket 71b1fec6): the plain-chat event bridge
 * that CodeSessionView runs per stream connection. Added with the C3 kid flip,
 * which changed 'progress' from dropped to FORWARDED — the view's live.status
 * working line is the coding-vocabulary status surface, and Digby Kids'
 * dynamically generated status lines (design D5 rail) ride 'progress'. The
 * other cases pin the pre-existing contract the flip depends on.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPlainMeta, makeLegacyNormalizer, mapPlainMessages, pollPlainRevision, stripForStorage, stripLiveTags } from './plain-session';

describe('makeLegacyNormalizer — progress forwarding (C3 kid flip, D5 rail)', () => {
  it('forwards progress events with a message (kid status lines + adult parity)', () => {
    const normalize = makeLegacyNormalizer();
    expect(normalize('progress', { message: 'Sniffing out the answer… 🐾' })).toEqual({
      type: 'progress',
      data: { message: 'Sniffing out the answer… 🐾' },
    });
  });

  it('drops progress events with no usable message', () => {
    const normalize = makeLegacyNormalizer();
    expect(normalize('progress', {})).toBeNull();
    expect(normalize('progress', { message: '' })).toBeNull();
    expect(normalize('progress', { message: 42 })).toBeNull();
    expect(normalize('progress', undefined)).toBeNull();
  });
});

describe('makeLegacyNormalizer — pre-existing contract anchors', () => {
  it('chunk maps to a text delta and accumulates into complete.finalText', () => {
    const normalize = makeLegacyNormalizer();
    expect(normalize('chunk', { content: 'Hello ' })).toEqual({ type: 'text', data: { delta: 'Hello ' } });
    expect(normalize('chunk', { content: 'world' })).toEqual({ type: 'text', data: { delta: 'world' } });
    const complete = normalize('complete', {});
    expect(complete?.type).toBe('complete');
    expect(complete?.data.finalText).toBe('Hello world');
  });

  it('page-panel events stay dropped (init / model-response / routing / unknown)', () => {
    const normalize = makeLegacyNormalizer();
    expect(normalize('init', { mode: 'open_source' })).toBeNull();
    expect(normalize('model-response', { model: 'kimi' })).toBeNull();
    expect(normalize('routing', { level: 'thinking' })).toBeNull();
    expect(normalize('followups', { questions: ['a'] })).toBeNull();
  });

  it('chat-title maps to session_title', () => {
    const normalize = makeLegacyNormalizer();
    expect(normalize('chat-title', { title: 'My chat' })).toEqual({ type: 'session_title', data: { title: 'My chat' } });
  });
});

describe('makeLegacyNormalizer — reasoning delta accumulation (ticket 01c69ca9)', () => {
  // Thinking is hidden by default since 2026-10-04 (lib/reasoning-visibility.ts); these pin the visible mode
  // (NEXT_PUBLIC_HIDE_REASONING_DISABLED=1).
  beforeEach(() => { process.env.NEXT_PUBLIC_HIDE_REASONING_DISABLED = '1'; });
  afterEach(() => { delete process.env.NEXT_PUBLIC_HIDE_REASONING_DISABLED; });
  it('concatenates token-rate agent-activity reasoning deltas RAW — no per-event newline', () => {
    const normalize = makeLegacyNormalizer();
    // Token-rate fragments exactly as the plain pipeline emits them (a few
    // chars per event; whitespace carried by the model's own tokens):
    for (const d of ['The quick', ' brown', ' fox\njumps', ' over.']) {
      normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: d });
    }
    const complete = normalize('complete', {});
    const reasoning = (complete?.data.parts ?? []).filter((p: any) => p.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    // The smush bug appended '\n' to EVERY event ('The quick\n brown\n fox\n
    // …'), so the whitespace-pre-wrap expander rendered one tiny fragment per
    // line ("smushed to a few characters, word wrapped"). Only the model's own
    // newline survives.
    expect(reasoning[0].text).toBe('The quick brown fox\njumps over.');
  });

  it('keeps the per-item newline for discrete thinking-summary events', () => {
    const normalize = makeLegacyNormalizer();
    normalize('thinking-summary', { summary: 'Searched the web' });
    normalize('thinking-summary', { summary: 'Read the page' });
    const complete = normalize('complete', {});
    const reasoning = (complete?.data.parts ?? []).filter((p: any) => p.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    // Discrete one-line summaries stay newline-separated (unchanged behavior).
    expect(reasoning[0].text).toBe('Searched the web\nRead the page\n');
  });

  it('keys the reasoning merge on the stream LABEL — concurrent personas coalesce per persona, never zebra-fragment (review B2 + 2026-08-30 spam fix)', () => {
    const normalize = makeLegacyNormalizer();
    // Cross-check/council personas stream reasoning CONCURRENTLY under
    // different labels — fragments interleave arrival-order at token rate.
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: 'The quick' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Cross-check', delta: 'I disagree' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: ' brown fox' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Cross-check', delta: ' because…' });
    const complete = normalize('complete', {});
    const reasoning = (complete?.data.parts ?? []).filter((p: any) => p.type === 'reasoning');
    // A label-blind trailing merge would produce ONE part of word-salad
    // ('The quickI disagree brown fox because…'); the old trailing-only
    // label-keyed merge produced FOUR one-fragment parts (the 2026-08-30
    // "Thought process" row spam). Per-label coalescing keeps each persona's
    // stream contiguous in ONE part per persona.
    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((p: any) => `${p.label}:${p.text}`)).toEqual([
      'Digby:The quick brown fox', 'Cross-check:I disagree because…',
    ]);
  });

  it('same-label reasoning still merges after an unrelated part intervenes — only KIND+LABEL gate the merge', () => {
    const normalize = makeLegacyNormalizer();
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: 'one' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: ' two' });
    const complete = normalize('complete', {});
    const reasoning = (complete?.data.parts ?? []).filter((p: any) => p.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].text).toBe('one two');
    expect(reasoning[0].label).toBe('Digby');
  });
});

describe('makeLegacyNormalizer — unlabeled reasoning wildcard-merge (ticket 6201d579)', () => {
  // Thinking is hidden by default since 2026-10-04 (lib/reasoning-visibility.ts); these pin the visible mode
  // (NEXT_PUBLIC_HIDE_REASONING_DISABLED=1).
  beforeEach(() => { process.env.NEXT_PUBLIC_HIDE_REASONING_DISABLED = '1'; });
  afterEach(() => { delete process.env.NEXT_PUBLIC_HIDE_REASONING_DISABLED; });
  it('thinking-summary events do NOT split a labeled persona run — one contiguous part', () => {
    const normalize = makeLegacyNormalizer();
    // The ticket repro: sse-adapter.ts emits agent-activity{label:'Digby'} at
    // token rate AND a throttled (1.5s) thinking-summary from the SAME
    // reasoning stream; chat-agent.service.ts does the same per cross-checker
    // at 2.5s. Keying undefined as a distinct label split this into ~2
    // one-line parts per summary tick (~80 collapsed 'Thought process' rows
    // per minute of thinking). The summary's `Digby: ` persona prefix is
    // split off and routes the line into Digby's part (2026-08-30).
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: 'The quick' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: ' brown' });
    normalize('thinking-summary', { summary: 'Digby: The quick brown' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: ' fox' });
    normalize('thinking-summary', { summary: 'Digby: The quick brown fox' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: ' jumps.' });
    const complete = normalize('complete', {});
    const reasoning = (complete?.data.parts ?? []).filter((p: any) => p.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].label).toBe('Digby');
    expect(reasoning[0].text).toBe('The quick brownThe quick brown\n foxThe quick brown fox\n jumps.');
  });

  it('a summary-led run takes the persona label from the summary prefix', () => {
    const normalize = makeLegacyNormalizer();
    normalize('thinking-summary', { summary: 'Digby: warmup' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: 'The quick' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Cross-check', delta: 'I disagree' });
    const complete = normalize('complete', {});
    const reasoning = (complete?.data.parts ?? []).filter((p: any) => p.type === 'reasoning');
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0].label).toBe('Digby');
    expect(reasoning[0].text).toBe('warmup\nThe quick');
    expect(reasoning[1].label).toBe('Cross-check');
    expect(reasoning[1].text).toBe('I disagree');
  });

  it('persona-prefixed summaries route to THEIR persona in multi-persona streams (no misattribution)', () => {
    const normalize = makeLegacyNormalizer();
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: 'A1' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Cross-check', delta: 'B1' });
    normalize('thinking-summary', { summary: 'Digby: A1' });
    normalize('agent-activity', { kind: 'reasoning', label: 'Digby', delta: 'A2' });
    const complete = normalize('complete', {});
    const reasoning = (complete?.data.parts ?? []).filter((p: any) => p.type === 'reasoning');
    // Pre-2026-08-30 the unlabeled summary wildcard-merged into the TRAILING
    // run — attributing Digby's summary to Cross-check ('B1Digby: A1\n'). The
    // `Digby: ` prefix now routes it home; each persona stays contiguous.
    expect(reasoning.map((p: any) => `${p.label}:${p.text}`)).toEqual([
      'Digby:A1A1\nA2', 'Cross-check:B1',
    ]);
  });
});

describe('mapPlainMessages — persisted parts strip (ticket dc7fd17a)', () => {
  it('strips [FOLLOWUPS]/[CANVAS] markup from assistant text parts on load; non-text parts pass through; plainMeta intact', () => {
    // Rows persisted before the backend persist-side strip hold the RAW
    // model stream in text parts; AssistantParts renders them verbatim and
    // the view ignores content when parts exist — raw markup leaked into the
    // reloaded chat detail view.
    const full = {
      messages: [{
        id: 'm1', role: 'assistant', createdAt: '2026-08-30T15:42:40.491Z',
        content: 'Clean body.',
        metadata: { followUps: ['Next thing?'], mode: 'deep_research' },
        parts: [
          { type: 'text', text: 'Clean body.\n\n[FOLLOWUPS]\n- Next thing?\n[/FOLLOWUPS]' },
          { type: 'tool_call', name: 'web_search', args: { q: 'x' } },
        ],
      }],
    };
    const [msg] = mapPlainMessages(full);
    expect(msg.content).toBe('Clean body.');
    const textPart = (msg.parts ?? []).find((p: any) => p.type === 'text') as any;
    expect(textPart).toBeDefined();
    expect(textPart.text).toBe('Clean body.');
    expect(msg.parts!.find((p: any) => p.type === 'tool_call'))
      .toEqual({ type: 'tool_call', name: 'web_search', args: { q: 'x' } });
    // Chips still render — they ride metadata, not the stripped block.
    expect((msg.plainMeta as any)?.followUps).toEqual(['Next thing?']);
  });

  it('strips an UNTERMINATED [FOLLOWUPS] tail from a text part (truncated stream)', () => {
    const [msg] = mapPlainMessages({
      messages: [{ role: 'assistant', content: 'Body.', parts: [{ type: 'text', text: 'Body.\n\n[FOLLOWUPS]\n- partial' }] }],
    });
    expect(((msg.parts ?? [])[0] as any).text).toBe('Body.');
  });

  it('leaves part-less messages untouched and user content verbatim', () => {
    const [assistant, user] = mapPlainMessages({
      messages: [
        { role: 'assistant', content: 'Body [FOLLOWUPS]\n- q\n[/FOLLOWUPS]' },
        { role: 'user', content: 'my [FOLLOWUPS] literal text stays' },
      ],
    });
    expect(assistant.parts).toBeUndefined();
    expect(assistant.content).toBe('Body');
    expect(user.content).toBe('my [FOLLOWUPS] literal text stays');
  });
});

describe('makeLegacyNormalizer — browser-observation forwarding (UI Phase 6a)', () => {
  it('maps the legacy browser-observation event to coding-vocabulary browser_observation, payload verbatim', () => {
    const normalize = makeLegacyNormalizer();
    // Captured shape — browser-agent/glm-loop.ts sendEvent('browser-observation', …).
    const data = {
      action: 'navigate', ok: true, url: 'https://www.example.com/pricing',
      driver: 'cloud', preview: 'Example Domain — pricing tiers…', reasoning: 'Opening the pricing page',
    };
    expect(normalize('browser-observation', data)).toEqual({ type: 'browser_observation', data });
  });

  it('forwards the separate screenshot frame with its base64 payload intact', () => {
    const normalize = makeLegacyNormalizer();
    const data = { action: 'screenshot', ok: true, url: 'https://www.example.com', driver: 'local', screenshotBase64: 'iVBORw0KGgo=' };
    expect(normalize('browser-observation', data)).toEqual({ type: 'browser_observation', data });
  });

  it('drops malformed frames (no string action) instead of feeding the panel junk', () => {
    const normalize = makeLegacyNormalizer();
    expect(normalize('browser-observation', undefined)).toBeNull();
    expect(normalize('browser-observation', {})).toBeNull();
    expect(normalize('browser-observation', { action: 42 })).toBeNull();
  });

  it('never contaminates the answer accumulator (complete.finalText ignores observations)', () => {
    const normalize = makeLegacyNormalizer();
    normalize('chunk', { content: 'Hello' });
    normalize('browser-observation', { action: 'get_content', ok: true, preview: 'page text' });
    const complete = normalize('complete', {});
    expect(complete?.data.finalText).toBe('Hello');
  });
});

describe('makeLegacyNormalizer — computer-observation forwarding (computer use, 2026-09-09)', () => {
  it('maps computer-observation to browser_observation tagged driver:computer with a JPEG mime default', () => {
    const normalize = makeLegacyNormalizer();
    const data = { action: 'click', ok: true, preview: 'click done', reasoning: 'open Chrome' };
    expect(normalize('computer-observation', data)).toEqual({
      type: 'browser_observation',
      data: { ...data, driver: 'computer', mime: 'image/jpeg' },
    });
  });

  it('drops malformed computer frames', () => {
    const normalize = makeLegacyNormalizer();
    expect(normalize('computer-observation', {})).toBeNull();
    expect(normalize('computer-observation', undefined)).toBeNull();
  });
});

// Owner 2026-09-15 (Level 2 live feed): tool rows read "Searched the web" with
// no query, and the Double Checker's research looked like Digby's. The
// normalizer now shapes `detail` into the arg toolSummary reads and stamps
// the seat label on every tool part.
describe('agent-activity tool rows carry the query/url detail and the seat label', () => {
  it('toolArgsFromDetail maps search-like → query, read/browse → url, delegation → title, else detail', async () => {
    const { toolArgsFromDetail } = await import('./plain-session');
    expect(toolArgsFromDetail('search_engine', 'scale ai founders')).toEqual({ query: 'scale ai founders' });
    expect(toolArgsFromDetail('search_memory', 'CQL partnerships')).toEqual({ query: 'CQL partnerships' });
    expect(toolArgsFromDetail('web_pipe', 'scale ai history')).toEqual({ query: 'scale ai history' });
    expect(toolArgsFromDetail('gmail_search', 'from:cql')).toEqual({ query: 'from:cql' });
    expect(toolArgsFromDetail('scrape_as_markdown', 'https://scale.com/about')).toEqual({ url: 'https://scale.com/about' });
    expect(toolArgsFromDetail('browser_task', 'https://x.test')).toEqual({ url: 'https://x.test' });
    expect(toolArgsFromDetail('delegate', 'Find the PDF')).toEqual({ title: 'Find the PDF' });
    expect(toolArgsFromDetail('list_chats', 'anything')).toEqual({ detail: 'anything' });
    expect(toolArgsFromDetail('search_engine', '')).toEqual({});
    expect(toolArgsFromDetail(undefined, undefined)).toEqual({});
  });

  it('a tool event with a seat label yields a tool_call part stamped with that label and query args', async () => {
    const { makeLegacyNormalizer } = await import('./plain-session');
    const normalize = makeLegacyNormalizer();
    const liveCall = normalize('agent-activity', { kind: 'tool', label: 'Double Checker', name: 'search_engine', detail: 'scale ai founders' });
    const liveDone = normalize('agent-activity', { kind: 'tool_done', label: 'Double Checker', name: 'search_engine', size: 8070 });
    const done = normalize('complete', { finalText: 'answer', followUps: [], models: {} });
    const parts = (done as any).data.parts as any[];
    expect(parts.find(p => p.type === 'tool_call')).toMatchObject({ name: 'search_engine', label: 'Double Checker', args: { query: 'scale ai founders' } });
    expect(parts.find(p => p.type === 'tool_result')).toMatchObject({ name: 'search_engine', label: 'Double Checker', result: '8070 B' });
    // 53c0b979: the LIVE-view data carries the seat label too — the view's
    // pushPart stamps it on the live parts array, and mergeDeltaIntoParts'
    // text walk-back crosses only FOREIGN-seat tool parts (a checker result
    // without its label would stop the walk and re-split the word).
    expect((liveCall as any).data).toMatchObject({ name: 'search_engine', label: 'Double Checker' });
    expect((liveDone as any).data).toMatchObject({ name: 'search_engine', label: 'Double Checker' });
  });
});

describe('makeLegacyNormalizer — a wire finalText swap replaces the accumulated text parts (audit 2026-09-18)', () => {
  it('after a step-0 reconcile the just-answered bubble shows the RECONCILED text, not the streamed draft', async () => {
    const { makeLegacyNormalizer } = await import('./plain-session');
    const normalize = makeLegacyNormalizer();
    normalize('chunk', { content: 'DRAFT-ALPHA ' });
    normalize('chunk', { content: 'continues' });
    const done = normalize('complete', { finalText: 'RECONCILED-OMEGA\n\n[FOLLOWUPS]\n- next?\n[/FOLLOWUPS]', followUps: ['next?'], models: {} });
    const parts = (done as any).data.parts as any[];
    const texts = parts.filter(p => p.type === 'text').map(p => p.text);
    expect(texts).toEqual(['RECONCILED-OMEGA']); // one text part, stripped, no draft
    expect((done as any).data.finalText).toBe('RECONCILED-OMEGA');
  });

  it('without a wire finalText the streamed text parts are kept (the normal slim complete)', async () => {
    const { makeLegacyNormalizer } = await import('./plain-session');
    const normalize = makeLegacyNormalizer();
    normalize('chunk', { content: 'streamed answer' });
    const done = normalize('complete', { followUps: [], models: {} });
    const texts = ((done as any).data.parts as any[]).filter(p => p.type === 'text').map(p => p.text);
    expect(texts).toEqual(['streamed answer']);
  });

  // Ticket 318b3175: a swap complete also carries corrected:true (the backend
  // marker for "the streamed draft was replaced at finalize") — the view's
  // bubble renders a "corrected before delivery" note from it.
  it('a wire finalText swap complete forwards the 318b3175 corrected marker (318b3175)', async () => {
    const { makeLegacyNormalizer } = await import('./plain-session');
    const normalize = makeLegacyNormalizer();
    normalize('chunk', { content: 'DRAFT-ALPHA the long streamed answer' });
    const done = normalize('complete', { finalText: 'CORRECTED-FINAL', corrected: true, followUps: [], models: {} });
    expect((done as any).data.finalText).toBe('CORRECTED-FINAL');
    expect((done as any).data.corrected).toBe(true);
    // and a normal slim complete never carries it
    const slim = normalize('complete', { followUps: [], models: {} });
    expect((slim as any).data.corrected).toBeUndefined();
  });
});

describe('progressive cross-check (owner 2026-09-18): first answer now, updated when the Double Checker finishes', () => {
  it('buildPlainMeta carries pendingCrossCheck only when the complete payload says so', () => {
    expect(buildPlainMeta({ followUps: ['a'], pendingCrossCheck: true }, 'thinking')).toMatchObject({ mode: 'thinking', followUps: ['a'], pendingCrossCheck: true });
    expect(buildPlainMeta({ followUps: ['a'] }, 'thinking')?.pendingCrossCheck).toBeUndefined();
    expect(buildPlainMeta({ followUps: ['a'], pendingCrossCheck: false }, 'thinking')?.pendingCrossCheck).toBeUndefined();
  });

  // Ticket 318b3175: the complete event's finalText SWAP (cross-check
  // reconcile / guard strike / unbacked-claim rewrite) rides with corrected:true
  // so the live bubble can label the replaced text — the owner watched a long
  // streaming answer "shrink" at finalize with no explanation.
  it('buildPlainMeta carries the 318b3175 corrected marker only when the complete payload swaps the text', () => {
    expect(buildPlainMeta({ followUps: ['a'], corrected: true }, 'thinking')).toMatchObject({ mode: 'thinking', followUps: ['a'], corrected: true });
    expect(buildPlainMeta({ followUps: ['a'] }, 'thinking')?.corrected).toBeUndefined();
    expect(buildPlainMeta({ followUps: ['a'], corrected: false }, 'thinking')?.corrected).toBeUndefined();
  });

  it('pollPlainRevision resolves with the mapped row once pendingCrossCheck clears (revised row carries the note + the checker card)', async () => {
    let calls = 0;
    const fetchChat = async () => {
      calls++;
      const pending = calls < 3;
      return {
        messages: [
          { id: 'u1', role: 'user', content: 'why?' },
          {
            id: 'msg-1', role: 'assistant', content: pending ? 'first answer' : 'revised answer',
            metadata: pending
              ? { mode: 'thinking', pendingCrossCheck: true, models: { digby: {} } }
              : { mode: 'thinking', pendingCrossCheck: false, models: { digby: {}, double_checker: { modelUsed: 'x' } }, revision: { at: 't', reason: 'double_checker', checkerTimeMs: 212488 } },
          },
        ],
      };
    };
    const row = await pollPlainRevision('chat-1', 'msg-1', fetchChat, { intervalMs: 1, sleep: async () => {} });
    expect(calls).toBe(3);
    expect(row?.content).toBe('revised answer');
    expect(row?.plainMeta?.revision).toMatchObject({ reason: 'double_checker', checkerTimeMs: 212488 });
    expect(row?.plainMeta?.models?.double_checker).toBeTruthy();
  });

  it('pollPlainRevision stops when the caller leaves the chat and gives up at the bound', async () => {
    const fetchChat = async () => ({ messages: [{ id: 'msg-1', role: 'assistant', content: 'x', metadata: { pendingCrossCheck: true } }] });
    let ticks = 0;
    expect(await pollPlainRevision('c', 'msg-1', fetchChat, { intervalMs: 1, sleep: async () => {}, shouldContinue: () => ++ticks < 2 })).toBeNull();
    expect(await pollPlainRevision('c', 'msg-1', fetchChat, { intervalMs: 1, maxMs: 0, sleep: async () => {} })).toBeNull();
  });
});

describe('makeLegacyNormalizer — inline screenshot image parts (2026-09-23)', () => {
  it('maps the image event to an image part (source/pageUrl/app/caption preserved) and drops empty frames', () => {
    const normalize = makeLegacyNormalizer();
    const data = { mediaType: 'image/png', data: 'iVBORw0KGgo=', name: 'Final page · example.com', source: 'browser', pageUrl: 'https://example.com' };
    expect(normalize('image', data)).toEqual({ type: 'image', data: { type: 'image', ...data, app: undefined } });
    expect(normalize('image', { mediaType: 'image/png', data: '' })).toBeNull();
    expect(normalize('image', undefined)).toBeNull();
  });

  it('generated images (2026-09-24): keeps url / fileId / prompt alongside data so the live figure matches the reloaded part', () => {
    const normalize = makeLegacyNormalizer();
    const fileId = '11111111-2222-3333-4444-555555555555';
    const data = {
      mediaType: 'image/png',
      data: 'iVBORw0KGgo=',
      name: 'Generated · 1024×1024 · "a red fox"',
      source: 'generated',
      url: `/api/crossmodel/generated-files/${fileId}/inline`,
      fileId,
      prompt: 'a red fox in the snow',
    };
    const out = normalize('image', data);
    expect(out?.type).toBe('image');
    expect(out?.data).toMatchObject({ type: 'image', source: 'generated', url: data.url, fileId, prompt: data.prompt, data: data.data, mediaType: 'image/png' });
    // A REPLAYED frame is url-only (the durable log / cross-instance mirror
    // strip a generated image's base64) — it renders from the lazy url like
    // the persisted part (2026-09-24 review); a frame with neither is dropped.
    const replay = normalize('image', { mediaType: 'image/png', source: 'generated', url: data.url, fileId });
    expect(replay?.data).toMatchObject({ type: 'image', source: 'generated', url: data.url, fileId, mediaType: 'image/png' });
    expect(replay?.data).not.toHaveProperty('data');
    expect(normalize('image', { mediaType: 'image/png', source: 'generated' })).toBeNull();
    // Non-string url/fileId/prompt never leak onto the part.
    const junk = normalize('image', { mediaType: 'image/png', data: 'x', url: 42, fileId: null, prompt: {} });
    expect(junk?.data).not.toHaveProperty('url');
    expect(junk?.data).not.toHaveProperty('fileId');
    expect(junk?.data).not.toHaveProperty('prompt');
  });
});

describe('makeLegacyNormalizer — thinking stays hidden by default (owner 2026-10-04)', () => {
  it('drops thinking-summary and agent-activity reasoning frames — no reasoning part is ever built', () => {
    const n = makeLegacyNormalizer();
    expect(n('thinking-summary', { summary: 'Digby: the user wants X' })).toBeNull();
    expect(n('agent-activity', { kind: 'reasoning', label: 'Digby', delta: 'secret' })).toBeNull();
    const out = n('agent-activity', { kind: 'tool', label: 'Digby', name: 'search_engine', detail: 'x' });
    expect(out?.type).toBe('tool_call');
  });
});

/**
 * Ticket 7af42393 — ORPHAN FOLLOWUPS CLOSER.
 *
 * Specimen (chat 9430e12f, msg 6a8f46bc, 2026-11-03T03:37:28Z): the model
 * emitted a misspelled, spaced opener `[ FOLOWUPS ]` (ONE L) and then a
 * correctly spelled `[/FOLLOWUPS]`. Every strip rule here keys on the LITERAL
 * opener, so nothing matched, the closer rendered verbatim at the end of the
 * answer, and the framework sweep correctly filed it as a raw marker.
 *
 * The fix is renderer-side: a `[/FOLLOWUPS]` token is never prose a reader is
 * meant to see, so the bare token is deleted. The misspelled opener stays as
 * ordinary prose (it is not a marker any renderer consumes, and fuzzy-matching
 * openers would risk eating real prose).
 *
 * Scope is FOLLOWUPS only, deliberately: `[/CANVAS]` is the LAST canvas shape
 * that still reaches a reader, so stripping it would retire canvas detection
 * outright — a separate decision needing its own specimen.
 */
describe('stripForStorage — orphan FOLLOWUPS closer (ticket 7af42393)', () => {
  it('deletes the specimen orphan closer under a misspelled spaced opener', () => {
    const stored = '[ FOLOWUPS ]\n\n- Go — copy my file into the lane\n- Show me the prompt\n[/FOLLOWUPS]';
    const out = stripForStorage(stored);
    expect(out).not.toContain('[/FOLLOWUPS]');
    // The prose and the (harmless, non-marker) misspelled opener survive.
    expect(out).toContain('- Go — copy my file into the lane');
    expect(out).toContain('[ FOLOWUPS ]');
  });

  it('deletes a bare orphan closer on its own', () => {
    expect(stripForStorage('[/FOLLOWUPS]')).toBe('');
  });

  it('leaves a stray [/CANVAS] closer alone — canvas scope is unchanged', () => {
    expect(stripForStorage('[/CANVAS]')).toBe('[/CANVAS]');
  });

  it('still strips well-formed blocks (recall unchanged)', () => {
    expect(stripForStorage('[FOLLOWUPS]\n- a\n- b\n[/FOLLOWUPS]')).toBe('');
    // A bare [CANVAS]…[/CANVAS] block keeps the surrounding prose.
    expect(stripForStorage('body [CANVAS]art[/CANVAS] tail')).toBe('body  tail');
    // An ATTRIBUTED opener has no closer contract: rule 3 deletes to the end
    // of the string (pre-existing behaviour, unchanged by this ticket).
    expect(stripForStorage('body [CANVAS title="t"]art[/CANVAS] tail')).toBe('body');
  });

  it('leaves ordinary prose and SEND_EMAIL blocks untouched', () => {
    const email = '[SEND_EMAIL to="a@b.c"]hi[/SEND_EMAIL]';
    expect(stripForStorage(email)).toBe(email);
    expect(stripForStorage('no markers here')).toBe('no markers here');
  });
});

describe('stripLiveTags — orphan FOLLOWUPS closer (ticket 7af42393)', () => {
  it('a live bubble never flashes an orphan closer', () => {
    const live = stripLiveTags('[ FOLOWUPS ]\n\n- Go — start it\n[/FOLLOWUPS]');
    expect(live).not.toContain('[/FOLLOWUPS]');
    expect(live).toContain('- Go — start it');
  });

  it('still strips SEND_EMAIL blocks live (unchanged contract)', () => {
    expect(stripLiveTags('[SEND_EMAIL to="a@b.c"]hi[/SEND_EMAIL]')).toBe('');
  });
});
