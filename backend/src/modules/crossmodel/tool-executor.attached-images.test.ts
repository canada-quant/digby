/**
 * Screenshots IN THE CHAT (owner 2026-09-23: "are you sure it knows how to
 * embed images in chat… I haven't seen any images"). Pins:
 *   1. browser_task: the LAST screenshot frame of the sub-session is attached
 *      to the ToolCache as an image (caption from the page host); frames still
 *      forward to the panel sink unchanged; takeAttachedImages() drains FIFO.
 *   2. computer_task: same, tagged source 'computer' with the frontmost app.
 *   3. No screenshot in the session → nothing attached.
 *   4. screenshotCaption / screenshotFromFrame shapes.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tool-executor's import graph reaches prisma / upload / pipes — mock the same
// boundaries browser-agent.test.ts does so requiring it stays hermetic.
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./mcp-search', () => ({ __esModule: true, callMcpTool: jest.fn(), webToolsDegraded: () => false }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

const mockBrowser = jest.fn();
const mockComputer = jest.fn();
jest.mock('./browser-agent', () => ({ __esModule: true, runBrowserAgentSession: (...a: any[]) => mockBrowser(...a) }));
jest.mock('./computer-agent', () => ({ __esModule: true, runComputerAgentSession: (...a: any[]) => mockComputer(...a) }));

import { ToolCache, screenshotCaption, screenshotFromFrame } from './tool-executor';

beforeEach(() => { mockBrowser.mockReset(); mockComputer.mockReset(); });

describe('browser_task attaches its final screenshot', () => {
  it('keeps the LAST frame, captions it by host, forwards frames to the panel sink, drains FIFO', async () => {
    mockBrowser.mockImplementation(async (input: any) => {
      input.sendEvent('browser-observation', { action: 'navigate', ok: true, url: 'https://www.example.com/pricing', driver: 'cloud' });
      input.sendEvent('browser-observation', { action: 'screenshot', ok: true, live: true, url: 'https://www.example.com/pricing', driver: 'cloud', screenshotBase64: 'FIRST', mime: 'image/png' });
      input.sendEvent('browser-observation', { action: 'screenshot', ok: true, live: true, url: 'https://www.example.com/checkout', driver: 'cloud', screenshotBase64: 'LAST', mime: 'image/png' });
      input.sendEvent('progress', { message: 'private narration' });
      return { finalResponse: 'Starter $9', elapsed: 10, driverUsed: 'cloud', steps: 3 };
    });
    const sink = jest.fn();
    const tc = new ToolCache('u1', 'chat1', sink);
    const out = await tc.getOrExecute('browser_task', { task: 'read pricing' });
    expect(out).toContain('Starter $9');
    const imgs = tc.takeAttachedImages();
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toEqual({
      mediaType: 'image/png', data: 'LAST', source: 'browser', pageUrl: 'https://www.example.com/checkout', app: undefined,
      name: 'Final page · example.com',
    });
    expect(tc.takeAttachedImages()).toEqual([]); // drained
    // The panel sink still saw every observation frame (3), never the private progress.
    expect(sink.mock.calls.filter(c => c[0] === 'browser_observation')).toHaveLength(3);
    expect(sink.mock.calls.some(c => c[0] === 'progress')).toBe(false);
  });

  it('no screenshot frames → nothing attached', async () => {
    mockBrowser.mockImplementation(async (input: any) => {
      input.sendEvent('browser-observation', { action: 'navigate', ok: true, url: 'https://example.com', driver: 'cloud' });
      return { finalResponse: 'text only', elapsed: 1, driverUsed: 'cloud', steps: 1 };
    });
    const tc = new ToolCache('u1', 'chat1', () => {});
    await tc.getOrExecute('browser_task', { task: 'read' });
    expect(tc.takeAttachedImages()).toEqual([]);
  });
});

describe('computer_task attaches its final screen', () => {
  it("tags source 'computer' with the frontmost app and a Your Mac caption (JPEG default)", async () => {
    mockComputer.mockImplementation(async (input: any) => {
      input.sendEvent('computer-observation', { action: 'screenshot', ok: true, live: true, screenshotBase64: 'S1', app: 'Finder' });
      input.sendEvent('computer-observation', { action: 'click', ok: true, preview: 'click done' });
      input.sendEvent('computer-observation', { action: 'screenshot', ok: true, live: true, screenshotBase64: 'S2', app: 'Google Chrome' });
      return { finalResponse: 'Signed in as paul.', elapsed: 5, steps: 2, localStatus: 'connected (Mac app v0.4.1)' };
    });
    const tc = new ToolCache('u1', 'chat1', () => {});
    const out = await tc.getOrExecute('computer_task', { task: 'check chrome' });
    expect(out).toContain('Signed in as paul.');
    const imgs = tc.takeAttachedImages();
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({ mediaType: 'image/jpeg', data: 'S2', source: 'computer', app: 'Google Chrome', name: 'Final screen · Your Mac · Google Chrome' });
  });
});

/**
 * Ticket a544f308 (2026-11-06) — the SIBLING PATH of 2d461d80.
 *
 * 2d461d80 fixed `screenshotCaption` and wired `result.platform` into the
 * `computer_task` caption. The `browser_task` → COMPUTER handoff emits the very
 * same `computer-observation` frames, but it dropped the platform, so a Windows
 * capture through that door still captioned "Final screen · Your Mac · …" —
 * a platform label attached by the harness to the wrong OS, which is exactly
 * the mis-attribution the report cites.
 */
describe('browser_task → COMPUTER handoff captions the machine it actually drove (a544f308)', () => {
  it("captions a WINDOWS handoff capture 'Your PC', never 'Your Mac'", async () => {
    mockBrowser.mockImplementation(async (input: any) => {
      // The handoff runs the computer agent under the browser session, so the
      // frames arrive as computer-observation and the result is a
      // BrowserAgentResult carrying computerPlatform.
      input.sendEvent('computer-observation', { action: 'screenshot', ok: true, live: true, screenshotBase64: 'WIN', app: 'Discord' });
      return { finalResponse: 'Reached #announcements.', elapsed: 9, steps: 3, driverUsed: 'computer', computerPlatform: 'windows' };
    });
    const tc = new ToolCache('u1', 'chat1', () => {});
    const out = await tc.getOrExecute('browser_task', { task: 'read the Discord channel' });
    expect(out).toContain('Reached #announcements.');
    const imgs = tc.takeAttachedImages();
    expect(imgs).toHaveLength(1);
    expect(imgs[0]).toMatchObject({ source: 'computer', app: 'Discord', name: 'Final screen · Your PC · Discord' });
    // The historical caption must not survive this path — that IS the defect.
    expect(imgs[0].name).not.toContain('Your Mac');
  });

  it('a macOS/absent handoff platform keeps the historical "Your Mac" bytes', async () => {
    mockBrowser.mockImplementation(async (input: any) => {
      input.sendEvent('computer-observation', { action: 'screenshot', ok: true, live: true, screenshotBase64: 'MAC', app: 'Finder' });
      return { finalResponse: 'Done.', elapsed: 2, steps: 1, driverUsed: 'computer', computerPlatform: 'macos' };
    });
    const tc = new ToolCache('u1', 'chat1', () => {});
    await tc.getOrExecute('browser_task', { task: 'open Finder' });
    expect(tc.takeAttachedImages()[0]).toMatchObject({ name: 'Final screen · Your Mac · Finder' });
  });

  it('a plain browser run is unaffected by the platform field', async () => {
    mockBrowser.mockImplementation(async (input: any) => {
      input.sendEvent('browser-observation', { action: 'screenshot', ok: true, live: true, url: 'https://www.example.com/x', driver: 'cloud', screenshotBase64: 'W', mime: 'image/png' });
      return { finalResponse: 'Read it.', elapsed: 3, steps: 1, driverUsed: 'cloud' };
    });
    const tc = new ToolCache('u1', 'chat1', () => {});
    await tc.getOrExecute('browser_task', { task: 'read' });
    expect(tc.takeAttachedImages()[0]).toMatchObject({ source: 'browser', name: 'Final page · example.com' });
  });
});

describe('helpers', () => {
  it('screenshotCaption', () => {
    expect(screenshotCaption('browser', { pageUrl: 'https://www.example.com/x' })).toBe('Final page · example.com');
    expect(screenshotCaption('browser', { pageUrl: 'not a url' })).toBe('Final page');
    expect(screenshotCaption('computer', {})).toBe('Final screen · Your Mac');
    expect(screenshotCaption('computer', { app: 'Mail' })).toBe('Final screen · Your Mac · Mail');
    // a544f308: the platform branch 2d461d80 added, pinned at the helper too.
    expect(screenshotCaption('computer', { platform: 'windows' })).toBe('Final screen · Your PC');
    expect(screenshotCaption('computer', { app: 'Discord', platform: 'windows' })).toBe('Final screen · Your PC · Discord');
  });
  it('screenshotFromFrame', () => {
    expect(screenshotFromFrame(null)).toBeNull();
    expect(screenshotFromFrame({ action: 'navigate' })).toBeNull();
    expect(screenshotFromFrame({ screenshotBase64: 'x' })).toEqual({ data: 'x', mediaType: 'image/png' });
    expect(screenshotFromFrame({ screenshotBase64: 'x', mime: 'image/jpeg' })).toEqual({ data: 'x', mediaType: 'image/jpeg' });
    expect(screenshotFromFrame({ screenshotBase64: 'x', mime: 'text/html' })).toEqual({ data: 'x', mediaType: 'image/png' });
  });
});
