/** youtube_pipe — pure helper tests (no network): URL id extraction, SERP link
 *  extraction, caption-segment formatting, dataset-record transcript extraction —
 *  plus the BrightData LAST-fallback wiring (mocked MCP). The pipeline itself
 *  mirrors web_pipe. */
import axios from 'axios';
import { extractVideoId, youtubeLinksFromSerp, transcriptSegmentsToText, transcriptFromDatasetRecord, runYoutubePipe } from './youtube-pipe';
import { callMcpTool } from '../mcp-search';
import { clearSerpRedirectCache } from '../serp-redirects';

jest.mock('../mcp-search', () => ({ callMcpTool: jest.fn() }));
jest.mock('./coding-retrieval.service', () => ({ storeFindings: jest.fn() }));
// model-roles seam (qwenSummarize resolves the coding_helper seat): unset →
// built-in SUMMARY_MODEL, behavior identical. The real module pulls config/env.
jest.mock('../model-endpoints/model-roles.service', () => ({ __esModule: true, resolveRoleModel: jest.fn(async () => '') }));
// Helper-seat health fallback (owner 2026-09-14): a custom coding_helper seat
// resolves through the registry; the fallback records seat_fallback telemetry.
const CQL_REG = {
  url: 'https://llm.cql.ca/v1/chat/completions', baseUrl: 'https://llm.cql.ca/v1', apiKey: 'sk-cql',
  model: 'qwen3-4b', label: 'cql', supportsVision: false, coding: true, thinkingOff: false,
};
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  __esModule: true,
  resolveRegistryModel: jest.fn(async (spec: string) => (spec === 'cql:qwen3-4b' ? CQL_REG : null)),
}));
const mockNoteSeatFallback = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, noteSeatFallback: (...a: any[]) => mockNoteSeatFallback(...a) }));
jest.mock('../speech', () => ({ __esModule: true, transcribeAudio: jest.fn(), textToSpeech: jest.fn(), sttConfigured: jest.fn() }));
jest.mock('axios');
jest.mock('../../../utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }));

import { storeFindings } from './coding-retrieval.service';
import { resolveRoleModel } from '../model-endpoints/model-roles.service';
import { __resetThinkingOffLatchForTests } from './helper-completion';

const ID = 'dQw4w9WgXcQ';

describe('extractVideoId', () => {
  test.each([
    ['watch URL', `https://www.youtube.com/watch?v=${ID}`],
    ['watch URL no www', `https://youtube.com/watch?v=${ID}`],
    ['watch URL with extra params', `https://www.youtube.com/watch?v=${ID}&t=42s&list=PLx`],
    ['mobile watch', `https://m.youtube.com/watch?v=${ID}`],
    ['music subdomain', `https://music.youtube.com/watch?v=${ID}`],
    ['youtu.be short', `https://youtu.be/${ID}`],
    ['youtu.be with tracking param', `https://youtu.be/${ID}?si=abc123`],
    ['shorts', `https://www.youtube.com/shorts/${ID}`],
    ['embed', `https://www.youtube.com/embed/${ID}`],
    ['live', `https://www.youtube.com/live/${ID}`],
    ['nocookie embed', `https://www.youtube-nocookie.com/embed/${ID}`],
    ['http scheme', `http://www.youtube.com/watch?v=${ID}`],
  ])('%s → id', (_desc, url) => {
    expect(extractVideoId(url)).toBe(ID);
  });

  test.each([
    ['non-YouTube domain', `https://example.com/watch?v=${ID}`],
    ['YouTube-ish lookalike domain', `https://notyoutube.com/watch?v=${ID}`],
    ['id too short', 'https://www.youtube.com/watch?v=abc'],
    ['id too long', `https://www.youtube.com/watch?v=${ID}extra`],
    ['no id at all', 'https://www.youtube.com/watch'],
    ['channel page', 'https://www.youtube.com/@somechannel'],
    ['feed page', 'https://www.youtube.com/feed/subscriptions'],
    ['non-http scheme', `ftp://youtu.be/${ID}`],
    ['not a URL', 'not a url at all'],
    ['empty string', ''],
    ['plain text containing a URL is not parsed', `check this video youtube.com/watch?v=${ID}`],
  ])('%s → null', (_desc, url) => {
    expect(extractVideoId(url)).toBeNull();
  });
});

describe('youtubeLinksFromSerp', () => {
  const SERP = JSON.stringify({
    organic: [
      { link: `https://www.youtube.com/watch?v=${ID}`, title: 'Never Gonna' },
      { link: 'https://blog.example/review', title: 'A blog review' },           // not YouTube
      { link: `https://youtu.be/${ID}?si=xyz`, title: 'Same video, short URL' },  // dup id
      { link: 'https://www.youtube.com/shorts/abc123def45', title: 'A Short' },
      { link: 'not-a-url' },
    ],
  });

  test('pulls only YouTube video links, deduped by id, with titles', () => {
    const r = youtubeLinksFromSerp(SERP, 4);
    expect(r).toEqual([
      { url: `https://www.youtube.com/watch?v=${ID}`, videoId: ID, title: 'Never Gonna' },
      { url: 'https://www.youtube.com/shorts/abc123def45', videoId: 'abc123def45', title: 'A Short' },
    ]);
  });

  test('caps at n', () => {
    expect(youtubeLinksFromSerp(SERP, 1)).toHaveLength(1);
  });

  test('non-JSON SERP falls back to raw URL extraction', () => {
    const r = youtubeLinksFromSerp(`Results: https://www.youtube.com/watch?v=${ID} and https://example.com/x`, 4);
    expect(r).toEqual([{ url: `https://www.youtube.com/watch?v=${ID}`, videoId: ID, title: undefined }]);
  });

  test('SERP with no YouTube videos → empty', () => {
    expect(youtubeLinksFromSerp(JSON.stringify({ organic: [{ link: 'https://example.com/a' }] }), 4)).toEqual([]);
    expect(youtubeLinksFromSerp('no urls here', 4)).toEqual([]);
  });
});

describe('transcriptSegmentsToText', () => {
  test('joins segment snippets, skipping headers and empties', () => {
    const segments = [
      { start_ms: '0', end_ms: '1200', snippet: { text: 'Hello  everyone' } },
      { type: 'TranscriptSectionHeader', snippet: undefined },               // section header — no snippet
      { start_ms: '1200', end_ms: '2400', snippet: { text: 'welcome to\nthe show' } },
      { start_ms: '2400', end_ms: '3000', snippet: { text: '   ' } },        // whitespace-only — dropped
    ];
    expect(transcriptSegmentsToText(segments)).toBe('Hello everyone welcome to the show');
  });

  test('snippet without .text falls back to toString (youtubei.js Text objects)', () => {
    const snippet = { toString: () => 'plain text here' };
    expect(transcriptSegmentsToText([{ snippet }])).toBe('plain text here');
  });

  test('non-array / empty input → empty string', () => {
    expect(transcriptSegmentsToText([])).toBe('');
    expect(transcriptSegmentsToText(undefined as any)).toBe('');
    expect(transcriptSegmentsToText(null as any)).toBe('');
  });
});

describe('transcriptFromDatasetRecord (BrightData web_data_youtube_videos)', () => {
  test('plain string transcript field, whitespace-normalized', () => {
    expect(transcriptFromDatasetRecord({ transcript: '  hello\n  world  ' })).toBe('hello world');
  });

  test('formatted_transcript segment array of {text}', () => {
    const rec = { formatted_transcript: [{ text: 'never gonna', start_time: 0 }, { text: 'give you up' }, { text: '   ' }] };
    expect(transcriptFromDatasetRecord(rec)).toBe('never gonna give you up');
  });

  test('subtitles as plain string array', () => {
    expect(transcriptFromDatasetRecord({ subtitles: ['line one', 'line  two'] })).toBe('line one line two');
  });

  test('field priority: transcript wins over subtitles', () => {
    expect(transcriptFromDatasetRecord({ transcript: 'primary', subtitles: ['secondary'] })).toBe('primary');
  });

  test('absent/empty/degenerate records → empty string (honest absence)', () => {
    expect(transcriptFromDatasetRecord({})).toBe('');
    expect(transcriptFromDatasetRecord({ transcript: '' })).toBe('');
    expect(transcriptFromDatasetRecord({ transcript: null, subtitles: [] })).toBe('');
    expect(transcriptFromDatasetRecord(null)).toBe('');
    expect(transcriptFromDatasetRecord('not an object')).toBe('');
  });
});

// ── BrightData dataset LAST fallback (ticket dbe1d975) ─────────────────────────
// Captions (Innertube ESM import fails under jest's CJS vm) and STT (env unset)
// both fail here, exactly like prod's bot-blocked datacenter egress — proving
// the pipe falls through to the proxied web_data_youtube_videos dataset.
describe('runYoutubePipe — BrightData dataset fallback', () => {
  const mockMcp = callMcpTool as jest.Mock;
  const WATCH_URL = `https://www.youtube.com/watch?v=${ID}`;
  const LONG_TRANSCRIPT = 'we are no strangers to love, you know the rules and so do I. '.repeat(20);

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.STT_BASE_URL;
    delete process.env.OPENAI_API_KEY; // sttConfigured() false → slow path skipped
    delete process.env.DASHSCOPE_API_KEY; // qwenSummarize throws → index-fallback summary (no model call)
  });

  test('captions+STT unavailable → transcript comes from web_data_youtube_videos', async () => {
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'web_data_youtube_videos') {
        return JSON.stringify([{ title: 'Never Gonna Give You Up', transcript: LONG_TRANSCRIPT }]);
      }
      return null;
    });
    const r = await runYoutubePipe(null, { urls: [WATCH_URL] });
    expect(mockMcp).toHaveBeenCalledWith('web_data_youtube_videos', { url: WATCH_URL }, expect.any(Number));
    expect(r.ok).toBe(true);
    expect(r.videos[0]).toMatchObject({ videoId: ID, method: 'brightdata', stored: true });
    expect(r.videos[0].chars).toBeGreaterThan(50);
    expect(r.summary).toContain('brightdata'); // index fallback names the method
  }, 20_000);

  test('dataset result without a transcript → video stays honestly failed', async () => {
    mockMcp.mockImplementation(async (tool: string) =>
      tool === 'web_data_youtube_videos' ? JSON.stringify([{ title: 'No captions here', views: 12 }]) : null);
    const r = await runYoutubePipe(null, { urls: [WATCH_URL] });
    expect(r.ok).toBe(false);
    expect(r.videos[0].method).toBe('failed');
    expect(r.summary).toContain('BrightData dataset fallback returned no transcript');
  }, 20_000);

  test('dataset unavailable (null) → honest failure, no throw', async () => {
    mockMcp.mockResolvedValue(null);
    const r = await runYoutubePipe(null, { urls: [WATCH_URL] });
    expect(r.ok).toBe(false);
    expect(r.videos[0]).toMatchObject({ method: 'failed', chars: 0, stored: false });
  }, 20_000);
});

// ── SERP redirect wrappers (owner 2026-09-14: "is our web_pipe broken??") ─────
// A https://www.google.com/goto?url=<opaque> wrapper around a YouTube link has
// NO extractable video id — without the unwrap the pipe silently found zero
// videos. The wrapper's ONE redirect hop (302 + Location) yields the real URL.
describe('runYoutubePipe — SERP redirect wrappers are unwrapped (2026-09-14)', () => {
  const mockMcp = callMcpTool as jest.Mock;
  const mockGet = axios.get as jest.Mock;
  const GOTO = 'https://www.google.com/goto?url=CAESQ0FVX3lxTE1nVzNtV2hZWDNqZk5oV0dJc3RJM1hLbVo1RDNZ';
  const WATCH_URL = `https://www.youtube.com/watch?v=${ID}`;
  const LONG_TRANSCRIPT = 'we are no strangers to love, you know the rules and so do I. '.repeat(20);

  beforeEach(() => {
    jest.clearAllMocks();
    clearSerpRedirectCache();
    delete process.env.STT_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    mockGet.mockImplementation(async (url: string) =>
      url === GOTO ? { status: 302, headers: { location: WATCH_URL }, data: '' } : Promise.reject(new Error(`unexpected GET ${url}`)));
  });

  test('query mode: a wrapped SERP link resolves to the watch URL and the video is found', async () => {
    mockMcp.mockImplementation(async (tool: string) => {
      if (tool === 'search_engine') return JSON.stringify({ organic: [{ link: GOTO, display_link: 'youtube.com', title: 'Never Gonna' }] });
      if (tool === 'web_data_youtube_videos') return JSON.stringify([{ title: 'Never Gonna Give You Up', transcript: LONG_TRANSCRIPT }]);
      return null;
    });
    const r = await runYoutubePipe(null, { query: 'rick astley' });
    expect(r.ok).toBe(true);
    expect(r.videos[0]).toMatchObject({ url: WATCH_URL, videoId: ID, title: 'Never Gonna', method: 'brightdata' });
    expect(mockGet).toHaveBeenCalledWith(GOTO, expect.objectContaining({ maxRedirects: 0 }));
  }, 20_000);

  test('urls mode: a wrapper the model hands back is unwrapped before id extraction', async () => {
    mockMcp.mockImplementation(async (tool: string) =>
      tool === 'web_data_youtube_videos' ? JSON.stringify([{ title: 'x', transcript: LONG_TRANSCRIPT }]) : null);
    const r = await runYoutubePipe(null, { urls: [GOTO] });
    expect(r.ok).toBe(true);
    expect(r.videos[0]).toMatchObject({ url: WATCH_URL, videoId: ID });
  }, 20_000);
});

describe('runYoutubePipe — helper-seat HEALTH fallback (owner 2026-09-14)', () => {
  const mockMcp = callMcpTool as jest.Mock;
  const mockPost = (axios.post as jest.Mock);
  const mockResolveRoleModel = resolveRoleModel as jest.Mock;
  const WATCH_URL = `https://www.youtube.com/watch?v=${ID}`;
  const LONG_TRANSCRIPT = 'we are no strangers to love, you know the rules and so do I. '.repeat(20);
  const http400 = () => Object.assign(new Error('Request failed with status code 400'), { response: { status: 400 } });

  beforeEach(() => {
    jest.clearAllMocks();
    __resetThinkingOffLatchForTests();
    delete process.env.STT_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    delete process.env.HELPER_SEAT_FALLBACK_DISABLED;
    process.env.DASHSCOPE_API_KEY = 'test-key'; // the built-in helper is servable
    (storeFindings as jest.Mock).mockResolvedValue(3); // a real sessionId flows into the seat_fallback row
    mockResolveRoleModel.mockResolvedValue('cql:qwen3-4b'); // the owner's custom Helper seat
    mockMcp.mockImplementation(async (tool: string) =>
      tool === 'web_data_youtube_videos' ? JSON.stringify([{ title: 'Never Gonna Give You Up', transcript: LONG_TRANSCRIPT }]) : null);
  });

  test('the custom seat 400s → the built-in writes the digest, the summary carries the attribution, model names the built-in', async () => {
    mockPost
      .mockRejectedValueOnce(http400())
      .mockRejectedValueOnce(http400()) // directive try + latched retry (helper-completion contract)
      .mockResolvedValueOnce({ data: { choices: [{ message: { content: 'VIDEO DIGEST from the built-in' } }] } });
    const r = await runYoutubePipe('sess-yt-seat', { urls: [WATCH_URL] });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('VIDEO DIGEST from the built-in');
    expect(r.summary).toContain('[digest via qwen3.6-27b — custom helper seat cql (custom endpoint) (cql:qwen3-4b) failed: HTTP 400');
    expect(r.model).toBe('qwen3.6-27b');
    expect(mockPost.mock.calls.map((c: any[]) => c[1]?.model)).toEqual(['qwen3-4b', 'qwen3-4b', 'qwen3.6-27b']);
    expect(mockNoteSeatFallback).toHaveBeenCalledWith(expect.objectContaining({
      role: 'coding_helper', from: 'cql:qwen3-4b', to: 'qwen3.6-27b', status: 'recovered', caller: 'youtube_pipe', sessionId: 'sess-yt-seat',
    }));
  }, 20_000);

  test('a healthy custom seat writes the digest itself — no attribution, no metric', async () => {
    mockPost.mockResolvedValue({ data: { choices: [{ message: { content: 'VIDEO DIGEST from the seat' } }] } });
    const r = await runYoutubePipe('sess-yt-ok', { urls: [WATCH_URL] });
    expect(r.summary).toBe('VIDEO DIGEST from the seat');
    expect(r.model).toBe('cql:qwen3-4b');
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  }, 20_000);

  test('kill switch HELPER_SEAT_FALLBACK_DISABLED=1 → the old index-only degradation, no built-in call', async () => {
    process.env.HELPER_SEAT_FALLBACK_DISABLED = '1';
    mockPost.mockRejectedValue(http400());
    const r = await runYoutubePipe('sess-yt-off', { urls: [WATCH_URL] });
    expect(r.ok).toBe(true);
    expect(r.summary).toContain('brightdata'); // index fallback names the method
    expect(r.model).toBeUndefined();
    expect(mockPost.mock.calls.map((c: any[]) => c[1]?.model)).not.toContain('qwen3.6-27b');
    expect(mockNoteSeatFallback).not.toHaveBeenCalled();
  }, 20_000);
});
