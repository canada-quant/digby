/**
 * audit 2026-10-06 T1-3 + T1-5 — compaction keeps live STEERS verbatim and never
 * re-offloads MEMORY READS.
 *
 * T1-3: a mid-run owner / supervisor message reaches a coding run as
 * "[HARNESS INJECTION — not typed by the user …] The user sent this WHILE you
 * are working — treat it as a live steering instruction …". The v2 cut treated
 * that as synthetic harness chrome and STRIPPED it (not even summarized): the
 * litellm lane run 8abce324 lost the PS's 21:02 "write the 2 routes + push + PR
 * now" steer and compacted 84 more times before its first edit. The newest
 * steers now ride after the recap, verbatim, marked once; older ones are
 * summarized; a steer is never "the question" (the task keeps the pin).
 *
 * T1-5: a search_memory / list_memory result in the compacted middle is
 * already in memory — the offload skips it (summarized as usual).
 */
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async (msgs: any[]) => `RECAP of ${String(msgs?.[0]?.content ?? '').length} chars`),
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { CONTEXT_COMPACTION: 'context_compaction' },
}));
const mockStoreFindings: jest.Mock = jest.fn(async () => 1);
jest.mock('./coding-retrieval.service', () => ({
  __esModule: true,
  storeFindings: (...a: any[]) => mockStoreFindings(...a),
}));

import { compactMessages, isSteerMessage, STEER_PIN_PREFIX, STEER_PIN_MAX, MEMORY_READ_TOOLS } from './compaction';
import { utilityChat } from '../../../utils/utility-llm';

const sys = { role: 'system', content: 'SYSTEM PROMPT' };
const task = { role: 'user', content: 'TASK: add the two Xiaomi MiMo routes to config.yaml, push, open a PR' };
let n = 0;
const call = (name: string, id = `c${++n}`) => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] });
const res = (id: string, t: string) => ({ role: 'tool', tool_call_id: id, content: t });
const steer = (t: string) => ({
  role: 'user',
  content: `[HARNESS INJECTION — not typed by the user; treat as system instructions]\nThe user sent this WHILE you are working — treat it as a live steering instruction with high priority. Adjust your plan/approach to honor it, then continue:\n\n${t}`,
});
/** n call→result groups of ~size chars each. */
const groups = (count: number, size = 3_000, name = 'run_command') => {
  const out: any[] = [];
  for (let i = 0; i < count; i++) { const c = call(name); out.push(c, res(c.tool_calls[0].id, `${name} output ${i} ${'x'.repeat(size)}`)); }
  return out;
};
const texts = (msgs: any[]) => msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.COMPACTION_STEER_PIN_DISABLED;
  delete process.env.MEMORY_READ_REOFFLOAD_SKIP_DISABLED;
  delete process.env.COMPACTION_V2_DISABLED;
});

describe('T1-3 — live steers survive compaction verbatim', () => {
  it('isSteerMessage recognizes the run-executor steer framing (string + parts), never plain harness notices', () => {
    expect(isSteerMessage(steer('write the routes now'))).toBe(true);
    expect(isSteerMessage({ role: 'user', content: [{ type: 'text', text: steer('x').content }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] })).toBe(true);
    expect(isSteerMessage({ role: 'user', content: '[HARNESS NOTICE — not typed by the user] FINAL TURN …' })).toBe(false);
    expect(isSteerMessage({ role: 'assistant', content: steer('x').content })).toBe(false);
  });

  it('REPLAY 8abce324: a steer in the compacted span is carried after the recap, verbatim and marked; the TASK keeps the question pin', async () => {
    const msgs = [sys, task, ...groups(6), steer('write 2 routes + push + PR now, no more audits'), ...groups(14)];
    const out = (await compactMessages(msgs, 'sess-steer'))!;
    expect(out).not.toBeNull();
    expect(out[0]).toBe(sys);
    expect(out[1]).toBe(task);                       // the task, not the steer, is the pinned question
    expect(String(out[2].content)).toContain('[EARLIER IN THIS RUN');
    const pinned = out[3];
    expect(pinned.role).toBe('user');
    expect(String(pinned.content).startsWith(STEER_PIN_PREFIX)).toBe(true);
    expect(String(pinned.content)).toContain('write 2 routes + push + PR now, no more audits');
    // exactly one copy, and it is NOT inside the offloaded/summarized middle as a stripped message
    expect(texts(out).filter((t) => t.includes('no more audits'))).toHaveLength(1);
    expect(out[4].role).not.toBe('tool');           // no orphaned tool result after the pin
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ pinnedSteers: 1 });
  });

  it('the pin is idempotent across compactions (prefixed once) and keeps only the newest STEER_PIN_MAX', async () => {
    const steers = Array.from({ length: STEER_PIN_MAX + 2 }, (_, i) => steer(`steer #${i}`));
    let msgs: any[] = [sys, task];
    for (const s of steers) msgs.push(...groups(2), s);
    msgs.push(...groups(20));
    let out = (await compactMessages(msgs, 'sess-steer', { mode: 'full' }))!;
    const pinnedTexts = texts(out).filter((t) => t.startsWith(STEER_PIN_PREFIX));
    expect(pinnedTexts).toHaveLength(STEER_PIN_MAX);
    expect(pinnedTexts.map((t) => t.match(/steer #(\d+)/)![1])).toEqual(['2', '3', '4']); // newest, in order
    // the two older steers were SUMMARIZED (in the summarizer input), never silently dropped
    const summarizerInput = String((utilityChat as jest.Mock).mock.calls[0][0][0].content);
    expect(summarizerInput).toContain('steer #0');
    // compact again: still one prefix per pinned steer
    out = (await compactMessages([...out, ...groups(20)], 'sess-steer', { mode: 'full' }))!;
    for (const t of texts(out).filter((x) => x.includes('steer #'))) expect(t.split(STEER_PIN_PREFIX).length).toBe(2);
  });

  it('kill switch COMPACTION_STEER_PIN_DISABLED=1: the steer is stripped as before (byte-identical shape)', async () => {
    process.env.COMPACTION_STEER_PIN_DISABLED = '1';
    const msgs = [sys, task, ...groups(6), steer('write 2 routes now'), ...groups(14)];
    const out = (await compactMessages(msgs, 'sess-steer'))!;
    expect(texts(out).some((t) => t.includes('write 2 routes now'))).toBe(false);
    expect(mockRecordLoopMetric.mock.calls[0][0].meta.pinnedSteers).toBeUndefined();
  });
});

describe('T1-5 — memory-read results are never re-offloaded by compaction', () => {
  // build 2026-10-08 C-3: the compaction offload is OFF by default; this suite pins the offload path itself.
  beforeEach(() => { process.env.COMPACTION_OFFLOAD_STOP_DISABLED = '1'; });
  afterEach(() => { delete process.env.COMPACTION_OFFLOAD_STOP_DISABLED; });
  it('search_memory / list_memory results in the middle are summarized but not stored; other results are', async () => {
    expect([...MEMORY_READ_TOOLS]).toEqual(['search_memory', 'list_memory']);
    const mem = call('search_memory');
    const msgs = [sys, task, mem, res(mem.tool_calls[0].id, `MEMHIT ${'m'.repeat(6000)}`), ...groups(4, 3000, 'read_file'), ...groups(12)];
    await compactMessages(msgs, 'sess-mem', { mode: 'full' });
    const stored = mockStoreFindings.mock.calls.filter((c) => c[1] === 'compaction').flatMap((c) => c[2].map((it: any) => String(it.content)));
    expect(stored.some((s) => s.includes('read_file output'))).toBe(true);
    expect(stored.some((s) => s.includes('MEMHIT'))).toBe(false);
    expect(String((utilityChat as jest.Mock).mock.calls[0][0][0].content)).toContain('MEMHIT'); // still summarized
    expect(mockRecordLoopMetric.mock.calls[0][0].meta).toMatchObject({ skippedMemoryReads: 1 });
  });

  it('kill switch MEMORY_READ_REOFFLOAD_SKIP_DISABLED=1 stores it again (old behaviour)', async () => {
    process.env.MEMORY_READ_REOFFLOAD_SKIP_DISABLED = '1';
    const mem = call('search_memory');
    const msgs = [sys, task, mem, res(mem.tool_calls[0].id, `MEMHIT ${'m'.repeat(6000)}`), ...groups(14)];
    await compactMessages(msgs, 'sess-mem', { mode: 'full' });
    const stored = mockStoreFindings.mock.calls.flatMap((c) => c[2].map((it: any) => String(it.content)));
    expect(stored.some((s) => s.includes('MEMHIT'))).toBe(true);
  });
});
