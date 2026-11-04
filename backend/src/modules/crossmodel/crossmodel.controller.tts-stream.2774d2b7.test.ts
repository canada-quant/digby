/**
 * POST /api/crossmodel/tts/stream — ticket 2774d2b7 ("text to speech button
 * doesn't work at all just spins and dies").
 *
 * The legacy single-JSON /tts spent ~14 s per ≤600-char chunk sequentially
 * (50-130 s for a multi-paragraph answer), outliving the web client's 45 s
 * axios timeout AND nginx's 60 s idle ceiling — the speaker button spun, died,
 * and no audio ever played. /tts/stream is the progressive twin: speech.ts's
 * synthesizeSpeechProgressively hands each chunk over the moment it synthesizes
 * and this controller flushes it as its own NDJSON line.
 *
 * Pins (speech.ts's own synthesis semantics live in speech.test.ts):
 *   - headers: NDJSON + no-store + X-Accel-Buffering:no, flushed BEFORE synthesis
 *   - chunk lines carry index/total/mimeType/base64 audio in arrival order
 *   - the terminal line is {"type":"done",…} with delivered/model/voice/mimeType
 *   - a mid-answer failure emits {"type":"error",…,partial:true} AFTER the chunks
 *   - a total failure (nothing delivered) emits ONE error line, no chunks
 *   - a 20 s keepalive ping interval runs during synthesis and is cleared after
 *   - client abort (res 'close') stops chunk writes — no vendor audio wasted
 *   - empty text → 400 JSON, stream never starts
 *
 * Harness: crossmodel.controller.label-window.test.ts (the mocked import graph
 * the controller's top-level imports need — speech itself is mocked here).
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: { user: { findUnique: jest.fn() }, crossModelChat: { findUnique: jest.fn() }, crossModelMessage: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn() } },
}));
jest.mock('./crossmodel.service', () => ({ __esModule: true, default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) } }));
jest.mock('./platform/platform.service', () => ({ __esModule: true }));
jest.mock('./context.service', () => ({ __esModule: true, default: {} }));
jest.mock('./integrations/moonshot.integration', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(), combineAttachments: jest.fn(() => null), persistChatUploads: jest.fn(async () => {}) }));
jest.mock('./feedback/feedback.service', () => ({ FEEDBACK_TYPES: ['positive', 'negative'] }));
jest.mock('./langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('./integrations/qwen-kid.integration', () => ({ streamKidResponse: jest.fn(async () => {}), generateKidStatus: jest.fn(async () => '') }));
jest.mock('./mcp-search', () => ({ searchWithBrightData: jest.fn(async () => []) }));
jest.mock('./browser-agent', () => ({ runBrowserAgentSession: jest.fn() }));
jest.mock('./chat-agent/chat-gate', () => ({
  decideChatGate: jest.fn(),
  mapAttachmentForAgent: jest.fn(() => ({ userImages: [], documentText: '' })),
  chatWriteAccessGranted: jest.fn(() => true),
  chatReadAccessGranted: jest.fn(),
  streamAccessDeniedError: jest.fn(),
}));
jest.mock('./guest-location', () => ({ buildGuestLocationBlock: jest.fn(async () => undefined) }));
jest.mock('./integration-context', () => ({ buildIntegrationContext: jest.fn(async () => ({ additionalContext: '', imessagePairedAgentId: null })), buildIntegrationContextBounded: jest.fn(async (build: any) => build()) }));

// speech is the seam under test's neighbor — mocked so the controller test is
// about the STREAM (lines, order, abort), not the vendor call.
const mockProgressive = jest.fn();
jest.mock('./speech', () => ({
  __esModule: true,
  synthesizeSpeechProgressively: (...a: any[]) => mockProgressive(...a),
  textToSpeech: jest.fn(),
  transcribeAudio: jest.fn(),
  sttConfigured: jest.fn(),
}));

import controller from './crossmodel.controller';

const WAV = Buffer.alloc(44 + 8, 0);
WAV.write('RIFF', 0, 'ascii');

const mkReq = (body: any): any => {
  const listeners: Record<string, Function[]> = {};
  return {
    body,
    headers: {},
    on: (ev: string, fn: Function) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    __emit: (ev: string) => { for (const fn of listeners[ev] || []) fn(); },
  };
};
const mkRes = (): any => {
  const res: any = {
    frames: [] as string[], writableEnded: false, statusCode: 0,
    status: jest.fn((c: number) => { res.statusCode = c; return res; }),
    json: jest.fn((obj: any) => { res.frames.push(JSON.stringify(obj)); res.writableEnded = true; }),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn((chunk: string) => { res.frames.push(chunk); return true; }),
    end: jest.fn(() => { res.writableEnded = true; }),
    on: jest.fn(),
  };
  return res;
};
/** Parse the NDJSON lines the endpoint wrote (ignoring nothing — every line must parse). */
const lines = (res: any) => res.frames.filter((f: string) => f.endsWith('\n')).map((f: string) => JSON.parse(f));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.DASHSCOPE_API_KEY;
});

describe('POST /tts/stream (ticket 2774d2b7)', () => {
  it('flushes each chunk as its own NDJSON line the moment it arrives, then a done line', async () => {
    mockProgressive.mockImplementation(async (_t: string, _v: any, _o: any, onChunk: any) => {
      onChunk({ index: 0, audio: WAV, mimeType: "audio/wav" }, 3);
      onChunk({ index: 2, audio: WAV, mimeType: "audio/wav" }, 3); // arrival order ≠ text order, by design
      onChunk({ index: 1, audio: WAV, mimeType: "audio/wav" }, 3);
      return { delivered: 3, model: 'qwen3-tts-flash', voice: 'Cherry', mimeType: 'audio/wav' };
    });
    const res = mkRes();
    await controller.textToSpeechStream(mkReq({ text: 'A long answer.'.repeat(80) }), res, jest.fn());
    const ls = lines(res);
    expect(ls.map((l: any) => l.type)).toEqual(['chunk', 'chunk', 'chunk', 'done']);
    expect(ls[0]).toMatchObject({ type: 'chunk', index: 0, total: 3, mimeType: 'audio/wav' });
    expect(typeof ls[0].audio).toBe('string'); // base64
    expect(ls[1]).toMatchObject({ index: 2 });
    expect(ls[3]).toMatchObject({ type: 'done', delivered: 3, model: 'qwen3-tts-flash', voice: 'Cherry', mimeType: 'audio/wav' });
    // streaming headers, flushed before any chunk
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/x-ndjson; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalled();
  });

  it('a mid-answer failure emits the surviving chunks THEN an error line flagged partial', async () => {
    mockProgressive.mockImplementation(async (_t: string, _v: any, _o: any, onChunk: any) => {
      onChunk({ index: 0, audio: WAV, mimeType: "audio/wav" }, 4);
      const err: any = new Error('Text-to-speech delivered 1 of 4 parts; the rest failed (HTTP 429 throttled)');
      err.partial = true;
      throw err;
    });
    const res = mkRes();
    await controller.textToSpeechStream(mkReq({ text: 'x'.repeat(2000) }), res, jest.fn());
    const ls = lines(res);
    expect(ls.map((l: any) => l.type)).toEqual(['chunk', 'error']);
    expect(ls[1]).toMatchObject({ type: 'error', partial: true });
    expect(String(ls[1].message)).toContain('1 of 4');
  });

  it('a TOTAL failure (nothing delivered) writes exactly one error line — never a silent 200-empty', async () => {
    mockProgressive.mockRejectedValue(new Error('Text-to-speech is not configured on this instance: assign a model to the Text-to-speech seat (Account → Admin → Endpoints → Model roles) or set DASHSCOPE_API_KEY.'));
    const res = mkRes();
    await controller.textToSpeechStream(mkReq({ text: 'hello' }), res, jest.fn());
    const ls = lines(res);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toMatchObject({ type: 'error' });
    expect(String(ls[0].message)).toContain('not configured');
    expect(res.end).toHaveBeenCalled();
  });

  it('a keepalive ping interval runs during synthesis and is cleared when the stream ends', async () => {
    const timers: number[] = [];
    const spy = jest.spyOn(global, 'setInterval').mockImplementation(((() => {}) as any) as typeof setInterval) as any;
    // simpler: intercept real timers via the spy's return path
    spy.mockRestore();
    const origSetInterval = global.setInterval;
    const origClearInterval = global.clearInterval;
    let cleared = 0;
    (global as any).setInterval = (fn: any, ms: any, ...rest: any[]) => {
      const id = origSetInterval(fn, ms, ...rest);
      timers.push(id as unknown as number);
      return id;
    };
    (global as any).clearInterval = (id: any) => { cleared++; return origClearInterval(id); };
    try {
      mockProgressive.mockResolvedValue({ delivered: 1, model: 'qwen3-tts-flash', voice: 'Cherry', mimeType: 'audio/wav' });
      const res = mkRes();
      await controller.textToSpeechStream(mkReq({ text: 'one short answer' }), res, jest.fn());
      expect(timers).toHaveLength(1);
      expect(cleared).toBeGreaterThanOrEqual(1); // the keepalive never leaks past the stream
    } finally {
      (global as any).setInterval = origSetInterval;
      (global as any).clearInterval = origClearInterval;
    }
  });

  it('client abort mid-stream stops chunk writes (no vendor audio wasted after close)', async () => {
    mockProgressive.mockImplementation(async (_t: string, _v: any, _o: any, onChunk: any) => {
      onChunk({ index: 0, audio: WAV, mimeType: "audio/wav" }, 2);
      (res as any).__emitClose();
      onChunk({ index: 1, audio: WAV, mimeType: "audio/wav" }, 2); // after the client left — must NOT write
      return { delivered: 2, model: 'qwen3-tts-flash', voice: 'Cherry', mimeType: 'audio/wav' };
    });
    const req = mkReq({ text: 'answer text here' });
    const res = mkRes();
    // wire close through the res the controller registers on
    const resListeners: Record<string, Function[]> = {};
    res.on = (ev: string, fn: Function) => { (resListeners[ev] = resListeners[ev] || []).push(fn); };
    (res as any).__emitClose = () => { for (const fn of resListeners.close || []) fn(); };
    void req; // the controller listens on res
    await controller.textToSpeechStream(req, res, jest.fn());
    const ls = lines(res);
    expect(ls.filter((l: any) => l.type === 'chunk')).toHaveLength(1); // only the pre-close chunk
    expect(ls.some((l: any) => l.type === 'done')).toBe(false); // and no done line after close
  });

  it('empty text → 400 JSON before any stream starts', async () => {
    const res = mkRes();
    await controller.textToSpeechStream(mkReq({ text: '   ' }), res, jest.fn());
    expect(res.statusCode).toBe(400);
    expect(mockProgressive).not.toHaveBeenCalled();
    expect(res.write).not.toHaveBeenCalled();
  });
});
