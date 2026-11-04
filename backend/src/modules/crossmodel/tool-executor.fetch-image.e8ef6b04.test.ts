/**
 * fetch_image (ticket e8ef6b04, dispatched 2026-09-30): the owner asked
 * "when i ask for an image from somewhere there should be code to embed" —
 * the chat agent had no way to pull an external image URL into the reply as
 * a real image part. This replay pins the tool that fixes it:
 *   1. happy path: a public PNG URL -> AttachedImage {source:'fetched', ...}
 *      pushed through the attachedImages path takeAttachedImages() drains,
 *      with magic-byte sniffed mediaType and the URL remembered as pageUrl.
 *   2. SSRF: private/loopback/link-local hosts are refused before any fetch.
 *   3. size cap: >5MB payloads are refused, nothing attached.
 *   4. schema: fetch_image is declared in TOOL_DEFINITIONS (model-facing) and
 *      in the chat orchestrator roster CHAT_ORCH_TOOLS (coding/agent.ts) so
 *      chat profiles actually receive it.
 *   5. no double-fire: the executor does NOT emit a live 'image' event — the
 *      shared drain persists + emits for BOTH lanes (the browser-screenshot
 *      idiom); an executor emit would duplicate.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Same mock boundaries as tool-executor.attached-images.test.ts so requiring
// tool-executor stays hermetic (no prisma / mcp / upload / pipe side effects).
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./mcp-search', () => ({ __esModule: true, callMcpTool: jest.fn(), webToolsDegraded: () => false }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));
jest.mock('./browser-agent', () => ({ __esModule: true, runBrowserAgentSession: jest.fn() }), { virtual: true });
jest.mock('./computer-agent', () => ({ __esModule: true, runComputerAgentSession: jest.fn() }));

// tool-executor's import graph reaches prisma / upload / pipes — same mock
// boundaries as tool-executor.attached-images.test.ts (hermetic require).
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./mcp-search', () => ({ __esModule: true, callMcpTool: jest.fn(), webToolsDegraded: () => false }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));
jest.mock('./browser-agent', () => ({ __esModule: true, runBrowserAgentSession: jest.fn() }));
jest.mock('./computer-agent', () => ({ __esModule: true, runComputerAgentSession: jest.fn() }));
jest.mock('../../config/redis', () => ({ __esModule: true, default: { connect: jest.fn(), isAlive: () => true }, getRedis: jest.fn(() => ({})) }));

import { ToolCache, TOOL_DEFINITIONS, sniffImageMedia } from './tool-executor';
// CHAT_LEAK_TOOL_NAMES is the LEAF mirror of coding/agent.ts's CHAT_ORCH_TOOLS
// (importing coding/agent directly drags config/env's process.exit into jest).
import { CHAT_LEAK_TOOL_NAMES } from './chat-agent/tool-call-leak';

// A real PNG magic header + body so the sniffer sees a genuine image.
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
]);
const JPEG_BYTES = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.alloc(32, 3),
]);

function mockFetchOnce(body: Buffer | string | null, status = 200, contentType?: string) {
  const headers = new Headers();
  if (contentType) headers.set('content-type', contentType);
  const resp = new Response(body, { status, headers });
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(resp as any);
}

async function runFetchImage(args: Record<string, unknown>) {
  const sink = jest.fn();
  const tc = new ToolCache('u1', 'chat1', sink);
  const out = await tc.getOrExecute('fetch_image', args);
  return { tc, out, imgs: tc.takeAttachedImages(), sink };
}

afterEach(() => { jest.restoreAllMocks(); });

describe('fetch_image — happy path', () => {
  it('fetches a public PNG, sniffs mediaType, attaches source "fetched", names it, remembers pageUrl', async () => {
    mockFetchOnce(PNG_BYTES, 200, 'image/png');
    const { out, imgs, sink } = await runFetchImage({ url: 'https://cdn.example.com/pic.png', name: 'chart' });
    expect(out).toContain('chart');
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({
      source: 'fetched',
      mediaType: 'image/png',
      name: 'chart',
      pageUrl: 'https://cdn.example.com/pic.png',
    });
    // base64 decodes back to the exact bytes fetched (sniffed, not header-trusted)
    expect(Buffer.from(imgs[0].data, 'base64').equals(PNG_BYTES)).toBe(true);
    // NO live event from the executor — the shared drain persists + emits for
    // both lanes; an executor emit would double-fire the live view.
    expect(sink).not.toHaveBeenCalled();
  });

  it('defaults the name to the URL filename when name is omitted', async () => {
    mockFetchOnce(PNG_BYTES, 200, 'image/png');
    const { imgs } = await runFetchImage({ url: 'https://example.com/a/b/chart.png' });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].name).toBe('chart.png');
  });

  it('sniffs JPEG even when the server mis-declares content-type', async () => {
    mockFetchOnce(JPEG_BYTES, 200, 'application/octet-stream');
    const { imgs } = await runFetchImage({ url: 'https://example.com/photo' });
    expect(imgs).toHaveLength(1);
    expect(imgs[0].mediaType).toBe('image/jpeg');
  });

  it('rejects a non-image payload (SVG/text) instead of attaching garbage', async () => {
    mockFetchOnce('<svg onload=alert(1)></svg>', 200, 'image/svg+xml');
    const { out, imgs } = await runFetchImage({ url: 'https://evil.example.com/x.svg' });
    expect(out).toMatch(/did not return a recognized image/i);
    expect(imgs).toHaveLength(0);
  });

  it('surfaces HTTP failures without attaching anything', async () => {
    mockFetchOnce('nope', 404);
    const { out, imgs } = await runFetchImage({ url: 'https://example.com/missing.png' });
    expect(out).toMatch(/HTTP 404/);
    expect(imgs).toHaveLength(0);
  });
});

describe('fetch_image — SSRF guard', () => {
  it('refuses loopback before any network call', async () => {
    const { out, imgs } = await runFetchImage({ url: 'http://127.0.4.1:3000/secret.png' });
    expect(out).toMatch(/Refusing to fetch/i);
    expect(imgs).toHaveLength(0);
  });

  it('refuses private-range and link-local hosts (169.254, 10.x, 192.168.x)', async () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/x.png',
      'http://192.168.1.4/x.png',
    ]) {
      const { out, imgs } = await runFetchImage({ url });
      expect(out).toMatch(/Refusing to fetch/i);
      expect(imgs).toHaveLength(0);
    }
  });

  it('refuses non-http(s) schemes', async () => {
    const { out, imgs } = await runFetchImage({ url: 'file:///etc/passwd' });
    expect(out).toMatch(/only supports http\(s\)/i);
    expect(imgs).toHaveLength(0);
  });
});

describe('fetch_image — size cap', () => {
  it('refuses payloads over 5MB', async () => {
    const huge = Buffer.concat([PNG_BYTES, Buffer.alloc(5 * 1024 * 1024 + 100, 1)]);
    mockFetchOnce(huge, 200, 'image/png');
    const { out, imgs } = await runFetchImage({ url: 'https://example.com/huge.png' });
    expect(out).toMatch(/5MB cap/i);
    expect(imgs).toHaveLength(0);
  });
});

describe('fetch_image — schema registration', () => {
  it('is declared in TOOL_DEFINITIONS with url required', () => {
    const def = TOOL_DEFINITIONS.find(t => t.function.name === 'fetch_image');
    expect(def).toBeDefined();
    expect(def!.function.parameters).toMatchObject({ type: 'object', required: ['url'] });
  });

  it("is in the chat orchestrator roster (CHAT_LEAK_TOOL_NAMES mirrors coding/agent.ts's CHAT_ORCH_TOOLS)", () => {
    expect(CHAT_LEAK_TOOL_NAMES.has('fetch_image')).toBe(true);
  });
});

describe('sniffImageMedia — magic bytes', () => {
  it('recognizes png, jpeg, gif, webp and rejects text', () => {
    expect(sniffImageMedia(PNG_BYTES)).toBe('image/png');
    expect(sniffImageMedia(JPEG_BYTES)).toBe('image/jpeg');
    expect(sniffImageMedia(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageMedia(Buffer.from('RIFF____WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMedia(Buffer.from('<html>'))).toBeNull();
  });
});
