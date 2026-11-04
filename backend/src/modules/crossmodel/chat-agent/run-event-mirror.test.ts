/**
 * run-event-mirror — cross-instance SSE mirror for plain-chat runs. Pins:
 *   - producer wire shape: RPUSH JSON({type,data,seq}) → LTRIM to the newest
 *     MIRROR_MAX_EVENTS → EXPIRE MIRROR_TTL_SEC, refreshed per push;
 *   - reader: whole window in order, malformed entries skipped;
 *   - attachRemoteChatRun: immediate replay in order, seq-deduped live tail
 *     (the whole-window re-read must never double-send), terminal-marker stop,
 *     the honest interrupted when the run ends with NO terminal marker, the
 *     no-interrupted path when the terminal lands between the quiet read and
 *     the busy check, the generation-marker cursor reset for a drain-started
 *     follow-up run, and viewer disconnect cleanup.
 *
 * Redis is an in-memory list fake (real RPUSH/LTRIM/LRANGE index semantics —
 * the LTRIM shift is exactly why the tail is seq-filtered); chat-busy is a
 * mocked seam; live-runs is real (openSSEStream is under test too).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const redisLists = new Map<string, string[]>();
const norm = (list: string[], start: number, stop: number): [number, number] => {
  const n = list.length;
  const s = start < 0 ? Math.max(0, n + start) : start;
  const e = stop < 0 ? n + stop : Math.min(stop, n - 1);
  return [s, e];
};
const mockRedis = {
  rPush: jest.fn(async (k: string, v: string) => {
    const l = redisLists.get(k) ?? [];
    l.push(v);
    redisLists.set(k, l);
    return l.length;
  }),
  lTrim: jest.fn(async (k: string, start: number, stop: number) => {
    const l = redisLists.get(k);
    if (!l) return 'OK';
    const [s, e] = norm(l, start, stop);
    redisLists.set(k, l.slice(s, e + 1));
    return 'OK';
  }),
  lRange: jest.fn(async (k: string, start: number, stop: number) => {
    const l = redisLists.get(k) ?? [];
    const [s, e] = norm(l, start, stop);
    return l.slice(s, e + 1);
  }),
  expire: jest.fn(async () => 1),
  del: jest.fn(async (k: string) => (redisLists.delete(k) ? 1 : 0)),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockIsChatBusy = jest.fn(async (_chatId: string) => true);
jest.mock('./chat-busy', () => ({ isChatBusy: (...a: any[]) => mockIsChatBusy(...(a as [string])) }));

import {
  clearRunEventMirror, mirrorChatRunEvent, chatRunMirrorTap, readMirroredEvents, attachRemoteChatRun,
  createChunkCoalescer, guestMirrorId, mirrorMaxEvents,
  MIRROR_MAX_EVENTS, MIRROR_MAX_EVENTS_COALESCED, MIRROR_TTL_SEC, MIRROR_POLL_MS, MIRROR_COALESCE_MAX_MS,
  MIRROR_COALESCE_MAX_CHARS, MIRROR_TAIL_READ,
} from './run-event-mirror';

const KEY = 'cm:runevents:c1';

/** Flush the fire-and-forget rPush→lTrim/expire promise chain. */
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

const mkRes = () => {
  const res: any = {
    writableEnded: false,
    frames: [] as string[],
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
  };
  return res;
};
const mkReq = () => {
  const handlers: Record<string, () => void> = {};
  return {
    on: (ev: string, cb: () => void) => { handlers[ev] = cb; },
    close: () => handlers['close']?.(),
  };
};
/** Parse the SSE data frames a fake response received (heartbeat comments dropped). */
const sseEvents = (res: any): Array<{ type: string; data: any }> =>
  res.frames
    .filter((f: string) => f.startsWith('data: '))
    .map((f: string) => JSON.parse(f.slice('data: '.length)));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  redisLists.clear();
  mockIsChatBusy.mockResolvedValue(true);
  delete process.env.RUN_MIRROR_COALESCE_DISABLED;
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.RUN_MIRROR_COALESCE_DISABLED;
});

describe('producer — mirrorChatRunEvent / clearRunEventMirror', () => {
  it('RPUSHes {type,data,seq,run} JSON, LTRIMs to the newest window, and refreshes the TTL', async () => {
    mirrorChatRunEvent('c1', 'runA', { type: 'chunk', data: { content: 'x' }, seq: 7 });
    await flush();
    expect(mockRedis.rPush).toHaveBeenCalledWith(KEY, JSON.stringify({ type: 'chunk', data: { content: 'x' }, seq: 7, run: 'runA' }));
    // Stream drops (2026-10-20): the window is MIRROR_MAX_EVENTS_COALESCED with
    // chunk coalescing on (the default); the legacy 500 under the switch.
    expect(mockRedis.lTrim).toHaveBeenCalledWith(KEY, -MIRROR_MAX_EVENTS_COALESCED, -1);
    expect(mockRedis.expire).toHaveBeenCalledWith(KEY, MIRROR_TTL_SEC);
    expect(redisLists.get(KEY)).toHaveLength(1);
  });

  it('a generated image event is mirrored url-only (the base64 is stripped — the bytes live in generated_files); screenshots keep their bytes (2026-09-24 review)', async () => {
    const url = '/api/crossmodel/generated-files/f1/inline';
    mirrorChatRunEvent('c1', 'runA', { type: 'image', data: { mediaType: 'image/png', data: 'AAAA', name: 'Generated · "fox"', source: 'generated', url, fileId: 'f1', prompt: 'a fox' }, seq: 1 });
    mirrorChatRunEvent('c1', 'runA', { type: 'image', data: { mediaType: 'image/png', data: 'BBBB', name: 'Final page', source: 'browser', pageUrl: 'https://x' }, seq: 2 });
    await flush();
    const [gen, shot] = await readMirroredEvents('c1');
    expect(gen.data).toEqual({ mediaType: 'image/png', name: 'Generated · "fox"', source: 'generated', url, fileId: 'f1', prompt: 'a fox' });
    expect(gen.data).not.toHaveProperty('data');
    expect(shot.data).toMatchObject({ data: 'BBBB', source: 'browser' });
  });

  it('RUN_MIRROR_COALESCE_DISABLED=1: caps the list at the legacy MIRROR_MAX_EVENTS, keeping the NEWEST events', async () => {
    process.env.RUN_MIRROR_COALESCE_DISABLED = '1';
    expect(mirrorMaxEvents()).toBe(MIRROR_MAX_EVENTS);
    for (let seq = 1; seq <= MIRROR_MAX_EVENTS + 5; seq++) {
      mirrorChatRunEvent('c1', 'runA', { type: 'chunk', data: { seq }, seq });
    }
    await flush();
    const list = redisLists.get(KEY)!;
    expect(list).toHaveLength(MIRROR_MAX_EVENTS);
    expect(JSON.parse(list[list.length - 1]).seq).toBe(MIRROR_MAX_EVENTS + 5);
    expect(JSON.parse(list[0]).seq).toBe(6); // the 5 oldest were trimmed away
  });

  it('never throws into the run event path on a Redis failure', async () => {
    mockRedis.rPush.mockRejectedValueOnce(new Error('redis down'));
    expect(() => mirrorChatRunEvent('c1', 'runA', { type: 'chunk', data: {}, seq: 1 })).not.toThrow();
    await flush(); // the rejected chain must be swallowed, not unhandled
  });

  it('chatRunMirrorTap stamps ONE fresh generation marker per run', async () => {
    const tapA = chatRunMirrorTap('c1');
    const tapB = chatRunMirrorTap('c1');
    tapA({ type: 'init', data: {}, seq: 1 });
    tapA({ type: 'chunk', data: {}, seq: 2 });
    tapB({ type: 'init', data: {}, seq: 1 });
    await flush();
    const runs = (redisLists.get(KEY) ?? []).map(e => JSON.parse(e).run);
    expect(runs[0]).toBe(runs[1]); // same run, same marker
    expect(runs[2]).not.toBe(runs[0]); // next run, fresh marker
  });

  it('clearRunEventMirror DELs the list (a new run never replays the old one)', async () => {
    mirrorChatRunEvent('c1', 'runA', { type: 'chunk', data: {}, seq: 1 });
    await flush();
    await clearRunEventMirror('c1');
    expect(mockRedis.del).toHaveBeenCalledWith(KEY);
    expect(redisLists.has(KEY)).toBe(false);
  });
});

describe('readMirroredEvents', () => {
  it('returns the window oldest-first and skips malformed entries', async () => {
    redisLists.set(KEY, [
      JSON.stringify({ type: 'init', data: {}, seq: 1, run: 'r1' }),
      'not-json{{',
      JSON.stringify({ type: 'nope-no-seq', data: {} }),
      JSON.stringify({ type: 'chunk', data: { content: 'a' }, seq: 2, run: 'r1' }),
    ]);
    const events = await readMirroredEvents('c1');
    expect(events.map(e => e.type)).toEqual(['init', 'chunk']);
    expect(events[1].seq).toBe(2);
  });
});

describe('attachRemoteChatRun — cross-instance SSE tail', () => {
  const seed = async (events: Array<{ type: string; data: any; seq: number }>, run = 'runA') => {
    for (const e of events) mirrorChatRunEvent('c1', run, e);
    await flush();
  };

  it('replays the mirrored events immediately, in order, as SSE frames', async () => {
    await seed([
      { type: 'init', data: { mode: 'open_source' }, seq: 1 },
      { type: 'progress', data: { message: 'working' }, seq: 2 },
      { type: 'chunk', data: { content: 'hello' }, seq: 3 },
    ]);
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(sseEvents(res).map(e => e.type)).toEqual(['init', 'progress', 'chunk']);
    expect(res.writableEnded).toBe(false); // no terminal yet — keep tailing
  });

  it('live-tails new events without re-sending replayed ones (seq dedupe over the whole-window read)', async () => {
    await seed([
      { type: 'init', data: {}, seq: 1 },
      { type: 'chunk', data: { content: 'a' }, seq: 2 },
    ]);
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    // A quiet poll re-reads the same window — nothing may be double-sent.
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS);
    expect(sseEvents(res)).toHaveLength(2);
    // A new event arrives on the producer instance…
    await seed([{ type: 'chunk', data: { content: 'b' }, seq: 3 }]);
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS);
    const events = sseEvents(res);
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual({ type: 'chunk', data: { content: 'b' } });
  });

  it('frames carry the event\'s server ts when the mirrored event has one (2026-09-08 — post-deploy verification found this path stamping at client ingest)', async () => {
    mirrorChatRunEvent('c1', 'runA', { type: 'init', data: { mode: 'open_source' }, seq: 1, ts: '2026-09-08T13:26:59.979Z' });
    mirrorChatRunEvent('c1', 'runA', { type: 'chunk', data: { content: 'a' }, seq: 2, ts: '2026-09-08T13:27:00.333Z' });
    await flush();
    expect(mockRedis.rPush).toHaveBeenCalledWith(KEY, JSON.stringify({ type: 'init', data: { mode: 'open_source' }, seq: 1, run: 'runA', ts: '2026-09-08T13:26:59.979Z' }));
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    expect(sseEvents(res)).toEqual([
      { type: 'init', data: { mode: 'open_source' }, ts: '2026-09-08T13:26:59.979Z' },
      { type: 'chunk', data: { content: 'a' }, ts: '2026-09-08T13:27:00.333Z' },
    ]);
  });

  it('stops on the terminal marker and ends the response', async () => {
    await seed([
      { type: 'init', data: {}, seq: 1 },
      { type: 'chunk', data: { content: 'a' }, seq: 2 },
      { type: 'complete', data: { totalTime: 9 }, seq: 3 },
      { type: 'chunk', data: { content: 'never' }, seq: 4 }, // past-terminal garbage must not stream
    ]);
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    const events = sseEvents(res);
    expect(events.map(e => e.type)).toEqual(['init', 'chunk', 'complete']);
    expect(res.writableEnded).toBe(true);
    // …and the poll loop is gone: nothing further is written.
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS * 4);
    expect(sseEvents(res)).toHaveLength(3);
  });

  it("emits the honest interrupted complete when the run ends WITHOUT a terminal marker", async () => {
    await seed([{ type: 'init', data: {}, seq: 1 }]);
    mockIsChatBusy.mockResolvedValue(false); // the run is gone (crash / pre-mirror instance)
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    // Quiet polls until the throttled busy recheck fires (~2s).
    await jest.advanceTimersByTimeAsync(2_500);
    const events = sseEvents(res);
    expect(events[events.length - 1]).toEqual({ type: 'complete', data: { interrupted: true } });
    expect(res.writableEnded).toBe(true);
  });

  it('does NOT fabricate interrupted when the terminal lands between the quiet read and the busy check', async () => {
    await seed([{ type: 'init', data: {}, seq: 1 }]);
    mockIsChatBusy.mockImplementation(async () => {
      // The run finished RIGHT NOW: its terminal was mirrored just before the
      // liveness key dropped — the final sweep must deliver it instead of lying.
      redisLists.get(KEY)!.push(JSON.stringify({ type: 'complete', data: { totalTime: 3 }, seq: 2, run: 'runA' }));
      return false;
    });
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    await jest.advanceTimersByTimeAsync(2_500);
    const events = sseEvents(res);
    expect(events.map(e => e.type)).toEqual(['init', 'complete']);
    expect(events[1].data).toEqual({ totalTime: 3 });
    expect(res.writableEnded).toBe(true);
  });

  it('a NEW generation marker mid-tail finalizes with a synthesized complete and ends the attach (run A terminal eaten by run B DEL — review 2026-08-16)', async () => {
    await seed([
      { type: 'init', data: {}, seq: 1 },
      { type: 'chunk', data: { content: 'run A' }, seq: 2 },
    ]);
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    // Run A ends and the queue drain starts run B within ~100ms: DEL + fresh
    // seqs from 1 under a new marker — run A's mirrored terminal is gone.
    await clearRunEventMirror('c1');
    await seed([
      { type: 'init', data: { generation: 'B' }, seq: 1 },
      { type: 'chunk', data: { content: 'run B' }, seq: 2 },
    ], 'runB');
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS);
    const events = sseEvents(res);
    // Run A's message is persisted server-side; the viewer gets an honest
    // finalize + stream end, and the client's busy logic re-attaches to run B.
    expect(events.map(e => e.type)).toEqual(['init', 'chunk', 'complete']);
    expect(events[2].data).toEqual({ handedOff: true });
    expect(res.writableEnded).toBe(true);
  });

  it('viewer disconnect stops the tail (and never touches the run)', async () => {
    await seed([{ type: 'init', data: {}, seq: 1 }]);
    const res = mkRes();
    const req = mkReq();
    attachRemoteChatRun({ req, res, chatId: 'c1' });
    await flush();
    req.close();
    expect(res.writableEnded).toBe(true);
    await seed([{ type: 'chunk', data: { content: 'late' }, seq: 2 }]);
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS * 4);
    expect(sseEvents(res)).toHaveLength(1); // nothing after the disconnect
  });
});

// ── Stream drops (2026-10-20, owner "why does connection drop?") ─────────────
// A cross-box reattach replayed only the tail of a long answer: the producer
// mirrors one entry per text delta and the window held 500. The tap now merges
// consecutive deltas (identical text) and the window holds 2 000; guest runs
// mirror under `session:<sid>`; the attach reports drops / replays.

const chunkText = (res: any): string =>
  sseEvents(res).filter((e: any) => e.type === 'chunk').map((e: any) => e.data.content).join('');

describe('chunk coalescing — chatRunMirrorTap / createChunkCoalescer', () => {
  it('consecutive deltas become ONE entry (text identical, seq = last, seqFrom = first, ts = first); any other event flushes first so the order holds', async () => {
    const tap = chatRunMirrorTap('c1');
    tap({ type: 'init', data: {}, seq: 1 });
    tap({ type: 'chunk', data: { content: 'Hel' }, seq: 2, ts: '2026-10-20T10:00:00.000Z' });
    tap({ type: 'chunk', data: { content: 'lo' }, seq: 3, ts: '2026-10-20T10:00:00.400Z' });
    tap({ type: 'agent-activity', data: { kind: 'tool', name: 'web_search' }, seq: 4 });
    tap({ type: 'chunk', data: { content: ' world' }, seq: 5 });
    tap({ type: 'complete', data: {}, seq: 6 });
    await flush();
    const events = await readMirroredEvents('c1');
    expect(events.map(e => e.type)).toEqual(['init', 'chunk', 'agent-activity', 'chunk', 'complete']);
    expect(events[1]).toMatchObject({ data: { content: 'Hello' }, seq: 3, seqFrom: 2, ts: '2026-10-20T10:00:00.000Z' });
    expect(events[3]).toMatchObject({ data: { content: ' world' }, seq: 5, seqFrom: 5 });
    expect(events.map(e => e.seq)).toEqual([1, 3, 4, 5, 6]); // monotonic — the consumers' seq dedupe still holds
  });

  it('a quiet tail flushes on the timer (≤ MIRROR_COALESCE_MAX_MS) — a cross-box viewer never waits for the next event', async () => {
    const tap = chatRunMirrorTap('c1');
    tap({ type: 'chunk', data: { content: 'tail' }, seq: 1 });
    await flush();
    expect(redisLists.get(KEY)).toBeUndefined();
    await jest.advanceTimersByTimeAsync(MIRROR_COALESCE_MAX_MS);
    await flush();
    expect((await readMirroredEvents('c1')).map(e => e.data.content)).toEqual(['tail']);
  });

  it('an entry is written once its text reaches MIRROR_COALESCE_MAX_CHARS (bounded Redis entries)', async () => {
    const tap = chatRunMirrorTap('c1');
    tap({ type: 'chunk', data: { content: 'x'.repeat(MIRROR_COALESCE_MAX_CHARS - 1) }, seq: 1 });
    tap({ type: 'chunk', data: { content: 'y' }, seq: 2 });
    tap({ type: 'chunk', data: { content: 'z' }, seq: 3 });
    await flush();
    const events = await readMirroredEvents('c1');
    expect(events).toHaveLength(1); // the full entry flushed at once; 'z' is still pending
    expect(events[0].data.content).toHaveLength(MIRROR_COALESCE_MAX_CHARS);
  });

  it('only plain { content } deltas merge — any other chunk shape passes through untouched', () => {
    const written: any[] = [];
    const tap = createChunkCoalescer((e) => written.push(e));
    tap({ type: 'chunk', data: { content: 'a' }, seq: 1 });
    tap({ type: 'chunk', data: { content: 'b', replace: true }, seq: 2 });
    tap({ type: 'chunk', data: {}, seq: 3 });
    expect(written.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(written[1].data).toEqual({ content: 'b', replace: true });
  });

  it('a LONG answer fits the window and a cross-box reattach replays the IDENTICAL text — no truncation notice', async () => {
    const tap = chatRunMirrorTap('c1');
    let seq = 0;
    let text = '';
    tap({ type: 'init', data: {}, seq: ++seq });
    for (let i = 0; i < 3_000; i++) {
      const d = `w${i} `;
      text += d;
      tap({ type: 'chunk', data: { content: d }, seq: ++seq });
      if (i % 10 === 9) tap({ type: 'agent-activity', data: { kind: 'tool', name: 'web_search' }, seq: ++seq });
    }
    tap({ type: 'complete', data: {}, seq: ++seq });
    await flush();
    expect(redisLists.get(KEY)!.length).toBeLessThan(MIRROR_MAX_EVENTS_COALESCED);
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    expect(sseEvents(res).some((e: any) => e.data?.stage === 'truncated')).toBe(false);
    expect(chunkText(res)).toBe(text);
    expect(res.writableEnded).toBe(true);
  });

  it('RUN_MIRROR_COALESCE_DISABLED=1: one entry per delta and the 500 window — the same kind of answer replays only its tail (the pre-fix behaviour)', async () => {
    process.env.RUN_MIRROR_COALESCE_DISABLED = '1';
    const tap = chatRunMirrorTap('c1');
    let seq = 0;
    let text = '';
    for (let i = 0; i < 1_000; i++) {
      const d = `w${i} `;
      text += d;
      tap({ type: 'chunk', data: { content: d }, seq: ++seq });
    }
    await flush();
    const list = redisLists.get(KEY)!;
    expect(list).toHaveLength(MIRROR_MAX_EVENTS);
    expect(JSON.parse(list[0])).not.toHaveProperty('seqFrom');
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    expect(sseEvents(res)[0]).toMatchObject({ type: 'progress', data: { stage: 'truncated' } });
    expect(chunkText(res)).not.toBe(text);
    expect(text.endsWith(chunkText(res))).toBe(true);
  });

  it('guest runs mirror under cm:runevents:session:<sid> (never a chat key)', async () => {
    const sid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    expect(guestMirrorId(sid)).toBe(`session:${sid}`);
    chatRunMirrorTap(guestMirrorId(sid))({ type: 'init', data: {}, seq: 1 });
    await flush();
    expect(redisLists.has(`cm:runevents:session:${sid}`)).toBe(true);
    expect(redisLists.has(`cm:runevents:${sid}`)).toBe(false);
  });
});

describe('attachRemoteChatRun — stream-drop hooks, the guest busy probe, the tail read', () => {
  const seedRun = async (events: Array<{ type: string; data: any; seq: number }>, run = 'runA') => {
    for (const e of events) mirrorChatRunEvent('c1', run, e);
    await flush();
  };

  it('onReplay reports the first batch once; onDrop fires when the VIEWER leaves mid-tail', async () => {
    await seedRun([{ type: 'init', data: {}, seq: 1 }, { type: 'chunk', data: { content: 'a' }, seq: 2 }]);
    const onReplay = jest.fn();
    const onDrop = jest.fn();
    const req = mkReq();
    const res = mkRes();
    attachRemoteChatRun({ req, res, chatId: 'c1', onReplay, onDrop });
    await flush();
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS * 2);
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(onReplay).toHaveBeenCalledWith({ events: 2, truncated: false });
    req.close();
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][0]).toMatchObject({ eventsWritten: 2, elapsedMs: expect.any(Number) });
  });

  it('a close AFTER the terminal (our own end) is never a drop', async () => {
    await seedRun([{ type: 'init', data: {}, seq: 1 }, { type: 'complete', data: {}, seq: 2 }]);
    const onDrop = jest.fn();
    const req = mkReq();
    const res = mkRes();
    attachRemoteChatRun({ req, res, chatId: 'c1', onDrop });
    await flush();
    expect(res.writableEnded).toBe(true);
    req.close();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("isBusy replaces chat-busy (a guest session's liveness) — the honest interrupted still lands at run end", async () => {
    await seedRun([{ type: 'init', data: {}, seq: 1 }]);
    const isBusy = jest.fn(async () => false);
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1', isBusy });
    await flush();
    await jest.advanceTimersByTimeAsync(2_500);
    expect(isBusy).toHaveBeenCalled();
    expect(mockIsChatBusy).not.toHaveBeenCalled();
    expect(sseEvents(res).pop()).toEqual({ type: 'complete', data: { interrupted: true } });
  });

  it('after the first replay a poll reads only the newest MIRROR_TAIL_READ entries; a burst bigger than that falls back to the whole window — nothing is missed', async () => {
    await seedRun([{ type: 'init', data: {}, seq: 1 }]);
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1' });
    await flush();
    expect(mockRedis.lRange).toHaveBeenLastCalledWith(KEY, 0, -1); // the first replay reads everything
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS);
    expect(mockRedis.lRange).toHaveBeenLastCalledWith(KEY, -MIRROR_TAIL_READ, -1);
    // A burst of MIRROR_TAIL_READ + 44 entries lands between two polls.
    const burst = Array.from({ length: MIRROR_TAIL_READ + 44 }, (_, i) => ({ type: 'agent-activity', data: { kind: 'tool', i }, seq: i + 2 }));
    await seedRun(burst);
    mockRedis.lRange.mockClear();
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS);
    expect(mockRedis.lRange.mock.calls.map((c: any[]) => [c[1], c[2]])).toEqual([[-MIRROR_TAIL_READ, -1], [0, -1]]);
    expect(sseEvents(res)).toHaveLength(1 + burst.length);
    expect(sseEvents(res).slice(1).map((e: any) => e.data.i)).toEqual(burst.map(b => b.data.i));
  });

  it('RUN_MIRROR_COALESCE_DISABLED=1: every poll re-reads the whole window (the pre-fix read)', async () => {
    process.env.RUN_MIRROR_COALESCE_DISABLED = '1';
    await seedRun([{ type: 'init', data: {}, seq: 1 }]);
    attachRemoteChatRun({ req: mkReq(), res: mkRes(), chatId: 'c1' });
    await flush();
    await jest.advanceTimersByTimeAsync(MIRROR_POLL_MS * 3);
    expect(mockRedis.lRange.mock.calls.every((c: any[]) => c[1] === 0 && c[2] === -1)).toBe(true);
  });

  it('a coalesced first entry that starts at seq 1 in a saturated window is NOT reported truncated (seqFrom, not seq)', async () => {
    const window = Array.from({ length: MIRROR_MAX_EVENTS_COALESCED }, (_, i) => (i === 0
      ? { type: 'chunk', data: { content: 'start' }, seq: 5, seqFrom: 1 }
      : { type: 'agent-activity', data: { i }, seq: i + 5 }));
    redisLists.set(KEY, window.map(e => JSON.stringify({ ...e, run: 'runA' })));
    const onReplay = jest.fn();
    const res = mkRes();
    attachRemoteChatRun({ req: mkReq(), res, chatId: 'c1', onReplay });
    await flush();
    expect(onReplay).toHaveBeenCalledWith({ events: MIRROR_MAX_EVENTS_COALESCED, truncated: false });
    expect(sseEvents(res).some((e: any) => e.data?.stage === 'truncated')).toBe(false);
  });
});
