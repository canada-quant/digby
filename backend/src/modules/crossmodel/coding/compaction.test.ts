/**
 * Tests for in-loop context compaction — the tricky invariant is that the
 * recent window never STARTS with an orphan tool result (providers reject a
 * tool message not preceded by its assistant tool_call).
 */

// utilityChat is mocked so we don't pull in providers/env.
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async () => 'RECAP: explored the repo, edited a.ts, ran tests (green).'),
}));
// storeFindings (compaction → session RAG offload) is mocked so we don't pull
// in prisma/env — the compaction tests exercise message-shape invariants only.
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { CONTEXT_COMPACTION: 'context_compaction' },
}));
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: jest.fn(async () => 1),
}));

import { messagesChars, compactMessages, clipOversizedMessages, shrinkLargestToolResults, TOOL_RESULT_SHRINK_FLOOR, KEEP_RECENT_MSGS, PER_MSG_CHAR_CAP, SYSTEM_MSG_CHAR_CAP, FIRST_USER_MSG_CHAR_CAP, modelErrorTerminalNote, isSyntheticHarnessMessage } from './compaction';
import { utilityChat } from '../../../utils/utility-llm';

// build 2026-10-08 C-3: the compaction embedding offload is OFF by default. These suites pin the offload path
// itself, so they run with the kill switch that restores it; 'C-3 offload stopped' below pins the new default.
beforeAll(() => { process.env.COMPACTION_OFFLOAD_STOP_DISABLED = '1'; });
afterAll(() => { delete process.env.COMPACTION_OFFLOAD_STOP_DISABLED; });

const sys = { role: 'system', content: 'SYSTEM PROMPT' };
const user = (t: string) => ({ role: 'user', content: t });
const asstCall = (name: string) => ({ role: 'assistant', content: '', tool_calls: [{ id: 't', type: 'function', function: { name } }] });
const toolRes = (t: string) => ({ role: 'tool', tool_call_id: 't', content: t });
const asstText = (t: string) => ({ role: 'assistant', content: t });

describe('compaction', () => {
  test('messagesChars counts content + tool_calls', () => {
    expect(messagesChars([user('hello')])).toBe(5);
    expect(messagesChars([asstCall('grep')])).toBeGreaterThan(0);
  });

  test('short transcripts are not compacted', async () => {
    const msgs = [sys, user('do a thing'), asstText('done')];
    expect(await compactMessages(msgs)).toBeNull();
  });

  test("mode 'full' compacts to system + recap + recent, and never orphans a tool result", async () => {
    // Build a long transcript of call→result groups.
    const msgs: any[] = [sys];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i}`)); }
    const out = await compactMessages(msgs, undefined, { mode: 'full' });
    expect(out).not.toBeNull();
    expect(utilityChat).toHaveBeenCalled();
    // head + recap + recent
    expect(out![0]).toBe(sys);
    expect(out![1].role).toBe('system');
    expect(String(out![1].content)).toContain('RECAP');
    // The first message AFTER the recap must not be an orphan tool result.
    expect(out![2].role).not.toBe('tool');
    // Recent window is bounded.
    expect(out!.length).toBeLessThanOrEqual(2 + KEEP_RECENT_MSGS + 1);
  });

  test("default 'early' mode compacts only the oldest third (by chars) and keeps the newer two-thirds verbatim", async () => {
    const msgs: any[] = [sys];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i} `.repeat(20))); }
    const out = await compactMessages(msgs);
    expect(out).not.toBeNull();
    expect(out![0]).toBe(sys);
    expect(out![1].role).toBe('system');
    expect(String(out![1].content)).toContain('EARLIER IN THIS RUN');
    // Early mode keeps MORE than the recent window (the middle two-thirds
    // survive verbatim) — strictly larger than the full-cut shape.
    expect(out!.length).toBeGreaterThan(2 + KEEP_RECENT_MSGS + 1);
    // …but strictly smaller than the input (something was compacted away).
    expect(out!.length).toBeLessThan(msgs.length);
    // No orphan tool result after the recap.
    expect(out![2].role).not.toBe('tool');
  });

  test('with a sessionId, the compacted middle is offloaded to session RAG and the recap carries a search_memory guide', async () => {
    const { storeFindings } = require('./coding-retrieval.service');
    (storeFindings as jest.Mock).mockClear();
    const msgs: any[] = [sys, user('build the feature')];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i} in src/file${i}.ts`)); }
    const out = await compactMessages(msgs, 'sess-123');
    expect(out).not.toBeNull();
    expect(storeFindings).toHaveBeenCalledWith('sess-123', 'compaction', expect.arrayContaining([
      expect.objectContaining({ ref: expect.stringContaining('compacted') }),
    ]));
    const recap = out!.find(m => m.role === 'system' && String(m.content).includes('EARLIER IN THIS RUN'));
    expect(recap).toBeDefined();
    expect(String(recap!.content)).toContain('search_memory');
  });

  test('without a sessionId the recap carries NO retrieval guide (nothing was stored)', async () => {
    const msgs: any[] = [sys, user('build the feature')];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i}`)); }
    const out = await compactMessages(msgs);
    const recap = out!.find(m => m.role === 'system' && String(m.content).includes('EARLIER IN THIS RUN'));
    expect(String(recap!.content)).not.toContain('search_memory');
  });

  test('clipOversizedMessages clips a huge content, preserving role + tool pairing', () => {
    const big = 'x'.repeat(PER_MSG_CHAR_CAP + 50_000);
    const msgs: any[] = [asstCall('read_file'), { role: 'tool', tool_call_id: 't', content: big }, user('short')];
    const out = clipOversizedMessages(msgs) as any[];
    // roles and pairing untouched
    expect(out[0].role).toBe('assistant');
    expect(out[0].tool_calls[0].id).toBe('t');
    expect(out[1].role).toBe('tool');
    expect(out[1].tool_call_id).toBe('t');
    // the fat tool result was clipped below the cap and marked
    expect(out[1].content.length).toBeLessThanOrEqual(PER_MSG_CHAR_CAP + 200);
    expect(out[1].content).toMatch(/clipped .* chars/);
    // small messages pass through byte-for-byte
    expect(out[2].content).toBe('short');
  });

  test('clipOversizedMessages is a no-op when nothing exceeds the cap', () => {
    const msgs: any[] = [sys, user('hello'), asstText('done')];
    expect(clipOversizedMessages(msgs)).toEqual(msgs);
  });

  // ── Role-aware clip (R&D stream 3, test-bench #3, 2026-09-18): a system
  // prompt is NOT a tool result — it is the run's doctrine/identity, kept
  // verbatim by compactMessages at messages[0] and recoverable from nowhere
  // once sliced. It rides SYSTEM_MSG_CHAR_CAP; every other role keeps the 14k
  // recovery cap. ────────────────────────────────────────────────────────────

  test('clipOversizedMessages leaves an oversize SYSTEM message byte-identical below the valve', () => {
    const bigSys = { role: 'system', content: `HEAD-${'doctrine '.repeat(4000)}-TAIL` }; // ~32k > 14k cap
    expect(bigSys.content.length).toBeGreaterThan(PER_MSG_CHAR_CAP);
    const out = clipOversizedMessages([bigSys, user('hello')]) as any[];
    expect(out[0].content).toBe(bigSys.content); // byte-identical, no marker
    expect(out[1].content).toBe('hello');
  });

  test('clipOversizedMessages still clips non-system roles past 14k while system survives', () => {
    const bigSys = { role: 'system', content: 's'.repeat(30_000) };
    // The FIRST user message is the run's task and rides its own valve since
    // iteration 10 (2026-09-24) — a later user message keeps the flat cap.
    const firstUser = user('task');
    const bigUser = user('u'.repeat(20_000));
    const bigAsst = asstText('a'.repeat(20_000));
    const bigTool = toolRes('t'.repeat(20_000));
    const out = clipOversizedMessages([bigSys, firstUser, bigUser, bigAsst, bigTool]) as any[];
    expect(out[0].content.length).toBe(30_000); // system untouched
    expect(out[1].content).toBe('task');
    for (const i of [2, 3, 4]) {
      expect(out[i].content.length).toBeLessThanOrEqual(PER_MSG_CHAR_CAP + 200);
      expect(out[i].content).toMatch(/clipped .* chars/);
    }
  });

  test('clipOversizedMessages still clips a pathological SYSTEM message above the valve', () => {
    const monster = { role: 'system', content: `HEAD${'m'.repeat(SYSTEM_MSG_CHAR_CAP + 10_000)}TAIL` };
    const out = clipOversizedMessages([monster]) as any[];
    expect(out[0].content.length).toBeLessThanOrEqual(SYSTEM_MSG_CHAR_CAP + 200);
    expect(out[0].content).toMatch(/clipped .* chars/);
    expect(out[0].content.startsWith('HEAD')).toBe(true);
    expect(out[0].content.endsWith('TAIL')).toBe(true);
  });

  test('clipOversizedMessages leaves an oversize SYSTEM vision (array) message intact below the valve', () => {
    const arrSys = { role: 'system', content: [{ type: 'text', text: 'v'.repeat(20_000) }] };
    const out = clipOversizedMessages([arrSys]) as any[];
    expect(out[0].content[0].text.length).toBe(20_000);
  });

  test('compactMessages keeps an oversize system prompt byte-identical at messages[0]', async () => {
    const realSizeSys = { role: 'system', content: `IDENTITY\n${'doctrine block\n'.repeat(2500)}\nTAIL` }; // ~37.5k
    expect(realSizeSys.content.length).toBeGreaterThan(PER_MSG_CHAR_CAP);
    const msgs: any[] = [realSizeSys];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i}`)); }
    const out = await compactMessages(msgs);
    expect(out).not.toBeNull();
    expect(out![0].role).toBe('system');
    expect(out![0].content).toBe(realSizeSys.content); // the WHOLE prompt, not a 7k head + 7k tail
  });

  test('compaction clips oversized messages kept in the recent window', async () => {
    const big = 'y'.repeat(PER_MSG_CHAR_CAP + 80_000);
    const msgs: any[] = [sys];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i}`)); }
    // a giant tool result within the recent window (kept verbatim pre-clip)
    msgs.push(asstCall('read_file')); msgs.push(toolRes(big));
    const out = await compactMessages(msgs);
    expect(out).not.toBeNull();
    const fat = out!.find(m => typeof m.content === 'string' && m.content.length > PER_MSG_CHAR_CAP + 500);
    expect(fat).toBeUndefined(); // nothing in the compacted array exceeds the cap
  });

  test('falls back to a safe drop when summarization throws', async () => {
    (utilityChat as jest.Mock).mockRejectedValueOnce(new Error('llm down'));
    const msgs: any[] = [sys];
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i}`)); }
    const out = await compactMessages(msgs);
    expect(out).not.toBeNull();
    expect(out![1].role).toBe('system');
    expect(String(out![1].content)).toMatch(/omitted/i);
    expect(out![2].role).not.toBe('tool');
  });
});

// Ticket 7852814c: synthetic harness messages (FINAL TURN notices, cross-check
// injections, PRIOR RECAPS) must never re-enter compaction input — a recap that
// is re-summarized and re-stored becomes a summary-of-a-summary, and
// search_memory then returns meta-summaries instead of source content.
describe('synthetic-message stripping (7852814c)', () => {
  test('isSyntheticHarnessMessage matches the known synthetic prefixes only', () => {
    expect(isSyntheticHarnessMessage('[HARNESS NOTICE — not typed by the user] FINAL TURN: …')).toBe(true);
    expect(isSyntheticHarnessMessage('[HARNESS INJECTION — not typed by the user; treat as system instructions] draft')).toBe(true);
    expect(isSyntheticHarnessMessage('[HARNESS] Continue the in-progress task…')).toBe(true);
    expect(isSyntheticHarnessMessage('  [HARNESS NOTICE — indented is still synthetic')).toBe(true);
    // Recaps: stripped ONLY when their full-fidelity offload succeeded (the
    // retrieve-guide marker). A guide-less recap is the last surviving record
    // of its turns and must be carried forward (PR #285 review, medium #3).
    expect(isSyntheticHarnessMessage('[EARLIER IN THIS RUN — summarized to fit the context window]\nrecap…\nembedded to session memory — call search_memory')).toBe(true);
    expect(isSyntheticHarnessMessage('[Earlier steps in this run were omitted to fit the context window.]\n…embedded to session memory…')).toBe(true);
    expect(isSyntheticHarnessMessage('[EARLIER IN THIS RUN — summarized to fit the context window]\nrecap without any guide')).toBe(false);
    expect(isSyntheticHarnessMessage('[Earlier steps in this run were omitted to fit the context window.]')).toBe(false);
    expect(isSyntheticHarnessMessage('user: please summarize the findings')).toBe(false);
    expect(isSyntheticHarnessMessage('the [HARNESS NOTICE] marker mid-text is real content')).toBe(false);
    expect(isSyntheticHarnessMessage(undefined)).toBe(false);
    expect(isSyntheticHarnessMessage([{ type: 'text', text: '[HARNESS NOTICE…' }])).toBe(false); // parts arrays: not matched
  });

  test('strips synthetic messages from the summarizer input AND the memory offload; real work + guide-less recaps survive', async () => {
    const { storeFindings } = require('./coding-retrieval.service');
    (storeFindings as jest.Mock).mockClear();
    (utilityChat as jest.Mock).mockClear();
    const msgs: any[] = [sys, user('build the feature')];
    // offload-BACKED prior recap (guide marker) → stripped as pure scaffolding
    msgs.push({ role: 'system', content: '[EARLIER IN THIS RUN — summarized to fit the context window]\nBacked recap of phase zero.\nThe FULL detail of these turns was embedded to session memory — call search_memory with specific keywords to retrieve any of it verbatim.' });
    // GUIDE-LESS prior recap (its offload failed) → the last surviving record → carried forward
    msgs.push({ role: 'system', content: '[EARLIER IN THIS RUN — summarized to fit the context window]\nUnguided recap of phase one — its offload failed.' });
    msgs.push(user('[HARNESS NOTICE — not typed by the user] FINAL TURN: tool calls are no longer available.'));
    msgs.push(user('[HARNESS INJECTION — not typed by the user; treat as system instructions] cross-check draft'));
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i} in src/file${i}.ts`)); }

    const out = await compactMessages(msgs, 'sess-785');
    expect(out).not.toBeNull();

    // Summarizer input: real work + the guide-less recap in; backed scaffolding out.
    const prompt = String((utilityChat as jest.Mock).mock.calls.at(-1)![0][0].content);
    expect(prompt).toContain('src/file');
    expect(prompt).toContain('Unguided recap of phase one');
    expect(prompt).not.toContain('Backed recap of phase zero');
    expect(prompt).not.toContain('FINAL TURN');
    expect(prompt).not.toContain('HARNESS INJECTION');

    // Full-fidelity memory offload: same contract. (v2 refs are per-part:
    // 'compacted earlier-run transcript (part i/N)'.)
    const offload = (storeFindings as jest.Mock).mock.calls.find((c: any[]) => String(c[2]?.[0]?.ref || '').startsWith('compacted earlier-run transcript'));
    expect(offload).toBeDefined();
    expect(String(offload![2][0].content)).toContain('src/file');
    expect(String(offload![2][0].content)).toContain('Unguided recap of phase one');
    expect(String(offload![2][0].content)).not.toContain('Backed recap of phase zero');
    expect(String(offload![2][0].content)).not.toContain('FINAL TURN');
  });

  test('the pointer to earlier compacted phases survives the strip (owner 2026-09-04): a new recap carries it forward', async () => {
    const { storeFindings } = require('./coding-retrieval.service');
    (storeFindings as jest.Mock).mockClear();
    (storeFindings as jest.Mock).mockResolvedValue(1); // this compaction's offload succeeds
    const msgs: any[] = [sys, user('build the feature')];
    msgs.push({ role: 'system', content: '[EARLIER IN THIS RUN — summarized to fit the context window]\nBacked recap of phase zero.\nThe FULL detail of these turns was embedded to session memory — call search_memory with specific keywords to retrieve any of it verbatim.' });
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i} in src/file${i}.ts`)); }
    const out = await compactMessages(msgs, 'sess-carry');
    const recap = String(out!.find((m: any) => typeof m.content === 'string' && m.content.startsWith('[EARLIER IN THIS RUN'))!.content);
    // Strict marker (this recap's own turns ARE offloaded → strippable next time)
    // AND the earlier-phases mention ride together.
    expect(recap).toContain('embedded to session memory');
    expect(recap).toContain('earlier compacted phases');
  });

  test('a failed offload with earlier phases in memory gets the WEAK pointer only (recap must survive the next strip)', async () => {
    const { storeFindings } = require('./coding-retrieval.service');
    (storeFindings as jest.Mock).mockClear();
    (storeFindings as jest.Mock).mockResolvedValue(0); // this compaction's offload FAILS
    const msgs: any[] = [sys, user('build the feature')];
    msgs.push({ role: 'system', content: '[EARLIER IN THIS RUN — summarized to fit the context window]\nBacked recap of phase zero.\nThe FULL detail of these turns was embedded to session memory — call search_memory with specific keywords to retrieve any of it verbatim.' });
    for (let i = 0; i < 12; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`result ${i} in src/file${i}.ts`)); }
    const out = await compactMessages(msgs, 'sess-carry2');
    const recap = String(out!.find((m: any) => typeof m.content === 'string' && m.content.startsWith('[EARLIER IN THIS RUN'))!.content);
    // Weak marker points at earlier phases; the STRICT marker must be absent —
    // this recap is the sole record of ITS OWN turns and must not be stripped.
    expect(recap).toContain('is in session memory');
    expect(recap).not.toContain('embedded to session memory');
    expect(isSyntheticHarnessMessage(recap)).toBe(false);
    (storeFindings as jest.Mock).mockResolvedValue(1); // restore for later tests
  });

  test('returns null when the compactable middle is entirely synthetic (nothing real to summarize)', async () => {
    const msgs: any[] = [sys, user('q'),
      { role: 'system', content: '[EARLIER IN THIS RUN — summarized to fit the context window]\nold recap…\nembedded to session memory' },
      user('[HARNESS NOTICE — not typed by the user] FINAL TURN: …')];
    for (let i = 0; i < KEEP_RECENT_MSGS; i++) msgs.push(asstText(`recent ${i}`));
    expect(await compactMessages(msgs, 'sess-785')).toBeNull();
  });
});

describe('shrinkLargestToolResults (remediation P1 — oversize shrink-retry)', () => {
  const toolMsg = (id: string, size: number) => ({ role: 'tool', tool_call_id: id, content: `head-${id} ` + 'x'.repeat(size) });

  test('shrinks LARGEST tool results first, only until under target, preserving order + tool_call_id + every non-tool message', () => {
    const msgs = [
      sys,
      user('question'),
      { role: 'assistant', content: 'reasoned answer '.repeat(200) }, // ~3.2k — never touched
      toolMsg('a', 30_000),
      toolMsg('b', 5_000),
      toolMsg('c', 60_000),
    ];
    const before = messagesChars(msgs);
    const target = before - 55_000; // one clip of the largest suffices
    const out = shrinkLargestToolResults(msgs, target)!;
    expect(out).not.toBeNull();
    expect(messagesChars(out)).toBeLessThanOrEqual(target);
    expect(out).toHaveLength(msgs.length); // nothing removed
    // Largest (c) clipped; a and b untouched (target already met).
    expect(String(out[5].content)).toContain('…[clipped');
    expect(String(out[5].content).startsWith('head-c')).toBe(true); // head kept
    expect(out[5].tool_call_id).toBe('c'); // pairing intact
    expect(out[3].content).toBe(msgs[3].content);
    expect(out[4].content).toBe(msgs[4].content);
    expect(out[2]).toBe(msgs[2]); // non-tool messages are the same references
    expect(msgs[5].content).toHaveLength((msgs[5].content as string).length); // input never mutated
  });

  test(`never shrinks a result below the ${TOOL_RESULT_SHRINK_FLOOR}-char floor and returns null when nothing can shrink`, () => {
    const small = [sys, toolMsg('a', TOOL_RESULT_SHRINK_FLOOR - 100)];
    expect(shrinkLargestToolResults(small, 10)).toBeNull(); // under floor — no candidate
    const already = [sys, user('q'.repeat(5_000))]; // bulk is NOT a tool result
    expect(shrinkLargestToolResults(already, 100)).toBeNull();
    // Already under target → no-op null.
    expect(shrinkLargestToolResults([sys, toolMsg('a', 30_000)], 100_000)).toBeNull();
  });

  test('each successive shrink round is strictly smaller (the retry-convergence contract)', () => {
    const msgs = [sys, toolMsg('a', 40_000), toolMsg('b', 40_000), toolMsg('c', 40_000)];
    const first = shrinkLargestToolResults(msgs, Math.floor(messagesChars(msgs) / 2))!;
    expect(messagesChars(first)).toBeLessThan(messagesChars(msgs));
    const second = shrinkLargestToolResults(first, Math.floor(messagesChars(first) / 2));
    if (second) expect(messagesChars(second)).toBeLessThan(messagesChars(first));
  });
});

// ── P6 remediation — honest compaction (v1#18 a-d, v1#34, sparks B1/G2) ──────
describe('compaction v2 honesty (P6 — v1#18/v1#34)', () => {
  const { storeFindings } = require('./coding-retrieval.service');

  beforeEach(() => {
    (storeFindings as jest.Mock).mockClear();
    (storeFindings as jest.Mock).mockResolvedValue(1);
    (utilityChat as jest.Mock).mockClear();
    (utilityChat as jest.Mock).mockResolvedValue('RECAP: explored the repo, edited a.ts, ran tests (green).');
    delete process.env.COMPACTION_V2_DISABLED;
  });
  afterEach(() => { delete process.env.COMPACTION_V2_DISABLED; });

  test('v1#18d: constants pinned; trigger at 70% of budget, kill switch restores the 100% cliff', () => {
    const {
      COMPACTION_TRIGGER_RATIO, COMPACT_OLDEST_FRACTION, MAX_OFFLOAD_ITEMS_PER_COMPACTION,
      OFFLOAD_ITEM_TARGET_CHARS, SUMMARIZER_TAIL_CHARS, SUMMARIZER_HEAD_SAMPLE_CHARS,
      STRIP_RECAP_MIN_STORED_RATIO, compactionTriggerChars,
    } = require('./compaction');
    expect(COMPACTION_TRIGGER_RATIO).toBe(0.7);
    expect(COMPACT_OLDEST_FRACTION).toBeCloseTo(1 / 3);
    expect(MAX_OFFLOAD_ITEMS_PER_COMPACTION).toBe(40);
    expect(OFFLOAD_ITEM_TARGET_CHARS).toBe(8000);
    expect(SUMMARIZER_TAIL_CHARS).toBe(14000);
    expect(SUMMARIZER_HEAD_SAMPLE_CHARS).toBe(2000);
    expect(STRIP_RECAP_MIN_STORED_RATIO).toBe(0.8);
    expect(compactionTriggerChars(100_000)).toBe(70_000);
    process.env.COMPACTION_V2_DISABLED = '1';
    expect(compactionTriggerChars(100_000)).toBe(100_000);
  });

  test('v1#18a: a huge middle offloads as MULTIPLE head+tail items (not one head-only 40k cut), bounded per compaction', async () => {
    const msgs: any[] = [sys, user('build the feature')];
    // 6 × 30k tool results ≈ 180k middle — v1 stored ONE item that memStore cut
    // to the first 40k; v2 must store several ≤~8k head+tail parts.
    for (let i = 0; i < 6; i++) {
      msgs.push(asstCall(`tool${i}`));
      msgs.push(toolRes(`START-${i} ${'x'.repeat(30_000)} END-${i}`));
    }
    for (let i = 0; i < KEEP_RECENT_MSGS; i++) msgs.push(asstText(`recent ${i}`));
    const out = await compactMessages(msgs, 'sess-p6a', { mode: 'full' });
    expect(out).not.toBeNull();
    const offload = (storeFindings as jest.Mock).mock.calls.find(
      (c: any[]) => String(c[2]?.[0]?.ref || '').startsWith('compacted earlier-run transcript'));
    expect(offload).toBeDefined();
    const items: Array<{ ref: string; content: string }> = offload![2];
    expect(items.length).toBeGreaterThan(1);
    expect(items.length).toBeLessThanOrEqual(40);
    // Head+tail per long message: BOTH ends of a 30k result survive in some item.
    const all = items.map(i => i.content).join('\n');
    expect(all).toContain('START-5');
    expect(all).toContain('END-5');
    // No item wildly exceeds the per-item target (target + clip marker slack).
    for (const it of items) expect(it.content.length).toBeLessThanOrEqual(8000 + 200);
    // The widened chunk budget rides the call (memStore's default 40 would drop items).
    expect(offload![3]).toEqual({ maxChunks: 120 });
  });

  test('v1#18c: PARTIAL store → honest "stored N of M chars" recap with the WEAK marker (survives the next strip); ~full store → strict marker', async () => {
    // Partial: 6 × 30k results → head+tail slices store well under 80%.
    const partialMsgs: any[] = [sys, user('q')];
    for (let i = 0; i < 6; i++) { partialMsgs.push(asstCall(`t${i}`)); partialMsgs.push(toolRes('y'.repeat(30_000))); }
    for (let i = 0; i < KEEP_RECENT_MSGS; i++) partialMsgs.push(asstText(`recent ${i}`));
    const partialOut = await compactMessages(partialMsgs, 'sess-p6c', { mode: 'full' });
    const partialRecap = String(partialOut!.find(m => typeof m.content === 'string' && m.content.startsWith('[EARLIER IN THIS RUN'))!.content);
    expect(partialRecap).toMatch(/stored [\d,]+ of [\d,]+ chars, \d+ items/);
    expect(partialRecap).toContain('is in session memory');
    expect(partialRecap).not.toContain('embedded to session memory'); // weak marker only
    expect(isSyntheticHarnessMessage(partialRecap)).toBe(false);      // NOT strippable next time

    // Full: small results → everything stores → strict (strippable) marker + counts.
    const fullMsgs: any[] = [sys, user('q')];
    for (let i = 0; i < 12; i++) { fullMsgs.push(asstCall(`t${i}`)); fullMsgs.push(toolRes(`result ${i}`)); }
    const fullOut = await compactMessages(fullMsgs, 'sess-p6c2', { mode: 'full' });
    const fullRecap = String(fullOut!.find(m => typeof m.content === 'string' && m.content.startsWith('[EARLIER IN THIS RUN'))!.content);
    expect(fullRecap).toContain('embedded to session memory');
    expect(fullRecap).toMatch(/stored [\d,]+ of [\d,]+ chars/);
    expect(isSyntheticHarnessMessage(fullRecap)).toBe(true);          // strippable — detail is really stored
  });

  test('v1#18b: summarizer input is TAIL-weighted (newest work reaches the recap) and carries every tool-call name', async () => {
    const msgs: any[] = [sys, user('q')];
    // Old content first, newest content last; enough 400-char-brief messages
    // that the rendered brief exceeds head(2k)+tail(14k) and must be sampled.
    for (let i = 0; i < 25; i++) { msgs.push(asstCall(`oldtool${i}`)); msgs.push(toolRes(`OLD-${i} ${'o'.repeat(2_000)}`)); }
    for (let i = 0; i < 25; i++) { msgs.push(asstCall(`newtool${i}`)); msgs.push(toolRes(`NEW-${i} ${'n'.repeat(2_000)}`)); }
    for (let i = 0; i < KEEP_RECENT_MSGS; i++) msgs.push(asstText(`recent ${i}`));
    await compactMessages(msgs, 'sess-p6b', { mode: 'full' });
    const prompt = String((utilityChat as jest.Mock).mock.calls.at(-1)![0][0].content);
    // v1 sliced the HEAD 14k — 'NEW-9' (the newest turn) never made it in.
    expect(prompt).toContain('NEW-9');
    expect(prompt).toContain('chars of the middle omitted');
    // The verbatim tool-call roster: EVERY name, oldest and newest alike.
    expect(prompt).toContain('All tool calls in the compacted span');
    expect(prompt).toContain('oldtool0');
    expect(prompt).toContain('newtool9');
  });

  test('v1#34: pins the LAST non-harness user message before the cut, not the oldest wake prompt', async () => {
    const msgs: any[] = [sys, user('OLD WAKE PROMPT from three days ago')];
    for (let i = 0; i < 6; i++) { msgs.push(asstCall(`t${i}`)); msgs.push(toolRes(`result ${i}`)); }
    msgs.push(user('NEWEST REAL QUESTION: fix the reaper race'));
    msgs.push(user('[HARNESS NOTICE — not typed by the user] FINAL TURN: tool calls are no longer available.'));
    for (let i = 0; i < 6; i++) { msgs.push(asstCall(`u${i}`)); msgs.push(toolRes(`later result ${i}`)); }
    const out = await compactMessages(msgs, undefined, { mode: 'full' });
    expect(out).not.toBeNull();
    // [system, pinned question, recap, ...recent]
    expect(out![1].role).toBe('user');
    expect(String(out![1].content)).toContain('NEWEST REAL QUESTION');
    expect(String(out![1].content)).not.toContain('OLD WAKE PROMPT');
    expect(String(out![1].content)).not.toContain('HARNESS NOTICE');
  });

  test('kill switch COMPACTION_V2_DISABLED=1 restores the v1 shape byte-for-byte: single offload item, oldest-user pin', async () => {
    process.env.COMPACTION_V2_DISABLED = '1';
    const msgs: any[] = [sys, user('the first user message')];
    for (let i = 0; i < 6; i++) { msgs.push(asstCall(`t${i}`)); msgs.push(toolRes(`result ${i}`)); }
    msgs.push(user('a newer user message'));
    for (let i = 0; i < 6; i++) { msgs.push(asstCall(`u${i}`)); msgs.push(toolRes(`later result ${i}`)); }
    const out = await compactMessages(msgs, 'sess-v1');
    expect(out).not.toBeNull();
    // v1 pinned messages[1] — the FIRST user message.
    expect(String(out![1].content)).toBe('the first user message');
    // v1 offload: exactly ONE item with the legacy ref, no opts.
    const offload = (storeFindings as jest.Mock).mock.calls.find(
      (c: any[]) => c[2]?.[0]?.ref === 'compacted earlier-run transcript');
    expect(offload).toBeDefined();
    expect(offload![2]).toHaveLength(1);
    expect(offload![3]).toBeUndefined();
    // v1 recap phrasing (no stored-counts note).
    const recap = String(out!.find(m => typeof m.content === 'string' && String(m.content).startsWith('[EARLIER IN THIS RUN'))!.content);
    expect(recap).not.toMatch(/stored [\d,]+ of/);
    expect(recap).toContain('embedded to session memory');
  });
});

describe('modelErrorTerminalNote', () => {
  const base = { transcriptChars: 5000, contextBudget: 400000, attempts: 2 };

  test('cites the failure reason, transcript evidence, and attempt count', () => {
    const note = modelErrorTerminalNote({ ...base, errorStatus: 400 });
    expect(note).toContain('too large or malformed');
    expect(note).toContain('~5k chars vs ~400k context budget');
    expect(note).toContain('2 compact-and-retry attempts exhausted');
    expect(note).toContain('false success');
  });

  test('within-budget failure is called transient — context size is NOT blamed', () => {
    const note = modelErrorTerminalNote({ ...base, errorStatus: 400 });
    expect(note).toContain('transient provider issue');
    expect(note).not.toContain('may have outgrown');
  });

  test('over-budget failure is the only one advised to narrow/reset', () => {
    const note = modelErrorTerminalNote({ ...base, transcriptChars: 450000, errorStatus: 400 });
    expect(note).toContain('~450k chars vs ~400k');
    expect(note).toContain('may have outgrown the model');
    expect(note).not.toContain('transient');
  });

  test('non-400 statuses and status-less errors are reported honestly', () => {
    expect(modelErrorTerminalNote({ ...base, errorStatus: 503 })).toContain('HTTP 503');
    expect(modelErrorTerminalNote({ ...base, errorMessage: 'socket hang up' })).toContain('socket hang up');
    expect(modelErrorTerminalNote({ ...base })).toContain('a model request error');
  });

  test('context-neutral wording (the loop also serves non-coding surfaces)', () => {
    expect(modelErrorTerminalNote({ ...base, errorStatus: 400 })).not.toContain('coding model');
  });

  test('singular attempt grammar', () => {
    expect(modelErrorTerminalNote({ ...base, attempts: 1 })).toContain('1 compact-and-retry attempt exhausted');
  });

  // Tickets 039dceb8 / 1e465443: the transient class (429/5xx/network) recovers
  // by backoff-and-retry, NOT compaction — the note must name the real recovery
  // and the real cause instead of claiming compactions that never happened.
  test('429 names the rate limit and rides no false compaction claim', () => {
    const note = modelErrorTerminalNote({ ...base, errorStatus: 429, attempts: 3, recoveryLabel: 'backoff-and-retry' });
    expect(note).toContain('rate-limited the request (HTTP 429)');
    expect(note).toContain('3 backoff-and-retry attempts exhausted');
    expect(note).not.toContain('compact-and-retry');
    expect(note).toContain('rate-limiting'); // the advice is wait-and-resend, not "narrow the task"
  });

  test('recoveryLabel defaults to compact-and-retry (size/malformed class unchanged)', () => {
    expect(modelErrorTerminalNote({ ...base, errorStatus: 400, attempts: 2 })).toContain('2 compact-and-retry attempts exhausted');
  });

  // Ticket 6d633649: on chat-profile runs the note lands in an END-USER chat
  // bubble — the operator jargon ("~48k chars vs ~100k context budget, 3
  // backoff-and-retry attempts exhausted") is incomprehensible there ("what is
  // failing here??"). audience:'user' speaks plainly; the engineering detail
  // stays in the provider_rejected metric meta + progress events.
  describe('audience:"user" (chat-profile terminal notes)', () => {
    test('429: plain language, no operator jargon, no raw provider body', () => {
      const note = modelErrorTerminalNote({
        ...base, errorStatus: 429, attempts: 3, recoveryLabel: 'backoff-and-retry',
        providerError: 'Rate limit reached for requests', audience: 'user',
      });
      expect(note).toContain('rate-limiting');
      expect(note).toContain('3 retries');
      expect(note).toContain('Nothing is wrong with your message');
      expect(note).toContain('resending in a minute or two');
      expect(note).not.toContain('context budget');
      expect(note).not.toContain('backoff-and-retry');
      expect(note).not.toContain('kept rejecting the request');
      expect(note).not.toContain('false success');
      expect(note).not.toContain('provider said');
    });

    test('over-budget 400: advises a fresh chat, not "narrow the task"', () => {
      const note = modelErrorTerminalNote({ ...base, transcriptChars: 450000, errorStatus: 400, audience: 'user' });
      expect(note).toContain('too large for the AI model');
      expect(note).toContain('fresh chat');
      expect(note).not.toContain('context budget');
    });

    test('other statuses are honest and capped (no giant provider dumps)', () => {
      const n503 = modelErrorTerminalNote({ ...base, errorStatus: 503, audience: 'user' });
      expect(n503).toContain('HTTP 503');
      expect(n503).toContain('provider-side problem');
      const nNoStatus = modelErrorTerminalNote({ ...base, errorMessage: `socket hang up ${'x'.repeat(500)}`, audience: 'user' });
      expect(nNoStatus).toContain('socket hang up');
      expect(nNoStatus.length).toBeLessThan(500);
    });

    test('singular retry grammar', () => {
      expect(modelErrorTerminalNote({ ...base, attempts: 1, errorStatus: 429, audience: 'user' })).toContain('1 retry');
    });

    test('default audience stays operator (byte-identical to the pre-option note)', () => {
      expect(modelErrorTerminalNote({ ...base, errorStatus: 429, attempts: 3, recoveryLabel: 'backoff-and-retry' }))
        .toBe(modelErrorTerminalNote({ ...base, errorStatus: 429, attempts: 3, recoveryLabel: 'backoff-and-retry', audience: 'operator' }));
    });
  });
});


describe('clipOversizedMessages — first user message = the run task (hardening loop iteration 10, 2026-09-24)', () => {
  test('the FIRST user message rides FIRST_USER_MSG_CHAR_CAP; later user messages keep the flat cap', () => {
    const wake = 'w'.repeat(26_000); // every prod supervisor wake measured 20–27k chars
    const later = 'l'.repeat(26_000);
    const msgs: any[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: wake },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: later },
    ];
    const out = clipOversizedMessages(msgs) as any[];
    expect(out[1].content).toBe(wake); // intact — under the 60k valve
    expect(out[3].content.length).toBeLessThanOrEqual(PER_MSG_CHAR_CAP + 200);
    expect(out[3].content).toContain('clipped');
    expect(FIRST_USER_MSG_CHAR_CAP).toBeGreaterThan(PER_MSG_CHAR_CAP);
  });
  test('the valve still bites on a pathological first user message', () => {
    const huge = 'h'.repeat(FIRST_USER_MSG_CHAR_CAP + 20_000);
    const out = clipOversizedMessages([{ role: 'system', content: 's' }, { role: 'user', content: huge }] as any) as any[];
    expect(out[1].content.length).toBeLessThanOrEqual(FIRST_USER_MSG_CHAR_CAP + 200);
  });
  test('a NON-first user message still rides the flat cap — the pre-fix outcome the exemption replaced', () => {
    // Before iteration 10 EVERY user message rode PER_MSG_CHAR_CAP, so a
    // later-position message reproduces that formula exactly (the exemption
    // is keyed on being the run's FIRST user message).
    const out = clipOversizedMessages([{ role: 'system', content: 's' }, { role: 'user', content: 'prior' }, { role: 'user', content: 'w'.repeat(26_000) }] as any) as any[];
    expect(out[2].content.length).toBeLessThanOrEqual(PER_MSG_CHAR_CAP + 200);
    expect(out[2].content).toContain('clipped');
  });
});

// ── build 2026-10-08 C-3: the compaction embedding offload is STOPPED by default ──
// context.md §1.5: ≤4.5 % of the compaction rows written since 10-01 were ever returned by a search
// (digby_memory 10 GB). The compacted turns are no longer embedded; the ONE distilled-recap row stays;
// the recap says how to restore detail (re-run the call), never "embedded to session memory".
describe('C-3 offload stopped (default)', () => {
  const { storeFindings } = require('./coding-retrieval.service');
  const { OFFLOAD_STOPPED_RECAP_LINE } = require('./compaction');
  beforeEach(() => {
    delete process.env.COMPACTION_OFFLOAD_STOP_DISABLED;
    (storeFindings as jest.Mock).mockClear();
    (storeFindings as jest.Mock).mockResolvedValue(1);
    (utilityChat as jest.Mock).mockClear();
    (utilityChat as jest.Mock).mockResolvedValue('RECAP: explored the repo, edited a.ts, ran tests (green).');
    mockRecordLoopMetric.mockClear();
  });
  afterEach(() => { process.env.COMPACTION_OFFLOAD_STOP_DISABLED = '1'; });

  const longRun = (): any[] => {
    const msgs: any[] = [sys, user('build the feature')];
    for (let i = 0; i < 6; i++) { msgs.push(asstCall(`tool${i}`)); msgs.push(toolRes(`START-${i} ${'x'.repeat(30_000)} END-${i}`)); }
    for (let i = 0; i < KEEP_RECENT_MSGS; i++) msgs.push(asstText(`recent ${i}`));
    return msgs;
  };

  test('no transcript offload; the one distilled recap row stays; the recap points at re-running calls, never search_memory', async () => {
    const out = await compactMessages(longRun(), 'sess-c3', { mode: 'full' });
    expect(out).not.toBeNull();
    const calls = (storeFindings as jest.Mock).mock.calls;
    expect(calls.find((c: any[]) => String(c[2]?.[0]?.ref || '').startsWith('compacted earlier-run transcript'))).toBeUndefined();
    expect(calls.filter((c: any[]) => c[2]?.[0]?.ref === 'compacted recap (distilled)')).toHaveLength(1);
    const recap = String(out!.find((m) => typeof m.content === 'string' && m.content.startsWith('[EARLIER IN THIS RUN'))!.content);
    expect(recap).toContain('RECAP: explored the repo');
    expect(recap.endsWith(OFFLOAD_STOPPED_RECAP_LINE)).toBe(true);
    expect(recap).not.toContain('search_memory');
    expect(isSyntheticHarnessMessage(recap)).toBe(false); // the only record of its turns — carried, never stripped
    const row = mockRecordLoopMetric.mock.calls.map((c) => c[0]).find((r) => r.kind === 'context_compaction');
    expect(row.meta).toMatchObject({ storedItems: 0, storedChars: 0, storedFully: false, offloadStopped: true });
  });

  test('a recap from an earlier (offloaded) phase keeps its pointer — existing rows are still there', async () => {
    const msgs = longRun();
    msgs.splice(2, 0, { role: 'system', content: '[EARLIER IN THIS RUN — summarized to fit the context window]\nolder phase.\nPARTIAL detail of these turns (stored 1 of 2 chars, 1 item) — head+tail — is in session memory: call search_memory …' });
    const out = await compactMessages(msgs, 'sess-c3b', { mode: 'full' });
    const recap = String(out!.find((m) => typeof m.content === 'string' && m.content.startsWith('[EARLIER IN THIS RUN — summarized'))!.content);
    expect(recap).toContain('Detail from earlier compacted phases of this run is in session memory');
  });

  test('COMPACTION_OFFLOAD_STOP_DISABLED=1 restores the offload', async () => {
    process.env.COMPACTION_OFFLOAD_STOP_DISABLED = '1';
    await compactMessages(longRun(), 'sess-c3c', { mode: 'full' });
    expect((storeFindings as jest.Mock).mock.calls.find((c: any[]) => String(c[2]?.[0]?.ref || '').startsWith('compacted earlier-run transcript'))).toBeDefined();
  });
});
