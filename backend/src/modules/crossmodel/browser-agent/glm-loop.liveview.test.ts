/** Live view + computer handoff (2026-09-09 — owner: "why don't we have the
 * visual showing as well as the browser actions as they occur?" / "i wanted it
 * to be full computer use").
 *
 * Pins:
 *   1. After every executed action the loop calls the driver's optional
 *      liveView() and emits its frame as a `live: true` browser-observation
 *      carrying the mime — independent of the model's own screenshot tool.
 *   2. Drivers without liveView (cloud in tests, old shapes) are untouched; a
 *      liveView failure/null never fails the session or emits a frame.
 *   3. The model's explicit screenshot action still emits the classic frame
 *      (no live flag) and does NOT double-capture a live view.
 *   4. A router pick of kind 'computer' hands the whole task to the computer
 *      agent: no browser driver runs, driverUsed is 'computer', and the computer
 *      loop's own result/notice ride the BrowserAgentResult.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  stripThink: (s: string | null | undefined) => {
    const text = s || '';
    const m = text.match(/^\s*<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
    if (m) return m[2].trim();
    if (/^\s*<think>/.test(text)) return '';
    return text;
  },
}));
jest.mock('./router', () => ({
  __esModule: true,
  selectBrowserDriver: jest.fn(),
  selectLocalFallbackDriver: jest.fn(),
}));
const mockRunComputer = jest.fn();
jest.mock('../computer-agent/computer-loop', () => ({
  __esModule: true,
  runComputerAgentSession: (...a: any[]) => mockRunComputer(...a),
}));

import { glmChat } from './glm-client';
import { selectBrowserDriver } from './router';
import { runBrowserAgentSession } from './glm-loop';

const toolTurn = (id: string, name: string, args: any, content = '') => ({
  content,
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});

const mkDriver = (kind: 'cloud' | 'local', over: Record<string, unknown> = {}) => ({
  kind,
  isAvailable: jest.fn(async () => true),
  execute: jest.fn(async (action: any) => ({
    ok: true,
    driver: kind,
    action: action.name,
    url: action.url || 'https://example.com/pricing',
    content: 'Pricing — Starter $9, Team $29',
    ...(action.name === 'screenshot' ? { screenshotBase64: 'iVBORw0KGgo=' } : {}),
  })),
  close: jest.fn(async () => {}),
  ...over,
});

const run = (sendEvent: (t: string, d: any) => void = () => {}) =>
  runBrowserAgentSession({ userId: 'u1', chatId: null, message: 'read the pricing page', maxSteps: 6, deadlineMs: 120000, sendEvent });

beforeEach(() => jest.clearAllMocks());

describe('live view frames (browser panel)', () => {
  it('emits a live:true screenshot frame with the mime after each executed action', async () => {
    const liveView = jest.fn(async () => ({ screenshotBase64: '/9j/4AAQ', mime: 'image/jpeg', url: 'https://example.com/pricing' }));
    const driver = mkDriver('local', { liveView });
    (selectBrowserDriver as jest.Mock).mockResolvedValue({ driver, kind: 'local', reason: 'mac' });
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(toolTurn('c1', 'navigate', { url: 'https://example.com/pricing' }))
      .mockResolvedValueOnce(toolTurn('c2', 'get_content', { format: 'text' }))
      .mockResolvedValueOnce(toolTurn('c3', 'done', { message: 'Starter $9, Team $29.' }));

    const events: Array<{ t: string; d: any }> = [];
    const r = await run((t, d) => events.push({ t, d }));

    expect(r.finalResponse).toBe('Starter $9, Team $29.');
    expect(liveView).toHaveBeenCalledTimes(2); // navigate + get_content; done is terminal
    const live = events.filter((e) => e.t === 'browser-observation' && e.d.live === true);
    expect(live).toHaveLength(2);
    expect(live[0].d).toMatchObject({ action: 'screenshot', ok: true, driver: 'local', mime: 'image/jpeg', screenshotBase64: '/9j/4AAQ', url: 'https://example.com/pricing' });
    // The action frames themselves are unchanged (no live flag).
    const actions = events.filter((e) => e.t === 'browser-observation' && e.d.action === 'navigate');
    expect(actions).toHaveLength(1);
    expect(actions[0].d.live).toBeUndefined();
  });

  it('a driver without liveView (or a null/throwing liveView) emits no live frame and never fails the session', async () => {
    for (const over of [{}, { liveView: jest.fn(async () => null) }, { liveView: jest.fn(async () => { throw new Error('camera broke'); }) }]) {
      jest.clearAllMocks();
      const driver = mkDriver('cloud', over);
      (selectBrowserDriver as jest.Mock).mockResolvedValue({ driver, kind: 'cloud', reason: 'cloud' });
      (glmChat as jest.Mock)
        .mockResolvedValueOnce(toolTurn('c1', 'navigate', { url: 'https://example.com/pricing' }))
        .mockResolvedValueOnce(toolTurn('c2', 'done', { message: 'ok' }));
      const events: Array<{ t: string; d: any }> = [];
      const r = await run((t, d) => events.push({ t, d }));
      expect(r.finalResponse).toBe('ok');
      expect(events.some((e) => e.t === 'browser-observation' && e.d.live === true)).toBe(false);
    }
  });

  it("the model's explicit screenshot emits the classic frame (mime passthrough) and skips the live capture", async () => {
    const liveView = jest.fn(async () => ({ screenshotBase64: 'LIVE', mime: 'image/jpeg' }));
    const driver = mkDriver('local', { liveView });
    (selectBrowserDriver as jest.Mock).mockResolvedValue({ driver, kind: 'local', reason: 'mac' });
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(toolTurn('c1', 'screenshot', {}))
      .mockResolvedValueOnce(toolTurn('c2', 'done', { message: 'looked' }));
    const events: Array<{ t: string; d: any }> = [];
    await run((t, d) => events.push({ t, d }));
    const shots = events.filter((e) => e.t === 'browser-observation' && e.d.action === 'screenshot' && e.d.screenshotBase64);
    expect(shots).toHaveLength(1);
    expect(shots[0].d.screenshotBase64).toBe('iVBORw0KGgo=');
    expect(shots[0].d.live).toBeUndefined();
    expect(liveView).not.toHaveBeenCalled();
  });
});

describe("computer handoff (router kind 'computer')", () => {
  it('runs the computer agent instead of a browser driver and reports driverUsed computer', async () => {
    (selectBrowserDriver as jest.Mock).mockResolvedValue({
      driver: null, kind: 'computer', reason: 'Needs your real Chrome session.', localStatus: 'connected (Mac app v0.4.1)', computerStatus: 'connected (Mac app v0.4.1)',
    });
    mockRunComputer.mockResolvedValue({ finalResponse: 'You are signed in as paul@… in Chrome.', elapsed: 5000, steps: 4, localStatus: 'connected (Mac app v0.4.1)' });

    const events: Array<{ t: string; d: any }> = [];
    const r = await run((t, d) => events.push({ t, d }));

    expect(glmChat).not.toHaveBeenCalled(); // no browser loop ran
    expect(mockRunComputer).toHaveBeenCalledTimes(1);
    const arg = mockRunComputer.mock.calls[0][0];
    expect(arg.userId).toBe('u1');
    expect(arg.message).toBe('read the pricing page');
    expect(arg.maxSteps).toBeGreaterThanOrEqual(10);   // the bounded browser cap is a floor here
    expect(arg.deadlineMs).toBeGreaterThanOrEqual(240000);
    expect(typeof arg.sendEvent).toBe('function');     // frames ride the same emitter
    expect(r.driverUsed).toBe('computer');
    expect(r.finalResponse).toBe('You are signed in as paul@… in Chrome.');
    expect(r.steps).toBe(4);
    expect(r.driverReason).toBe('Needs your real Chrome session.');
    // The routing reason still surfaces as progress for the live UI.
    expect(events.some((e) => e.t === 'progress' && e.d.message === 'Needs your real Chrome session.')).toBe(true);
  });

  it("the computer agent's capabilityNotice is carried through (hard, cause-naming)", async () => {
    (selectBrowserDriver as jest.Mock).mockResolvedValue({ driver: null, kind: 'computer', reason: 'mac', computerStatus: 'x' });
    mockRunComputer.mockResolvedValue({ finalResponse: 'COMPUTER USE UNAVAILABLE — offline', elapsed: 1, steps: 0, capabilityNotice: 'COMPUTER USE UNAVAILABLE — offline' });
    const r = await run();
    expect(r.capabilityNotice).toContain('UNAVAILABLE');
    expect(r.steps).toBe(0);
  });
});
