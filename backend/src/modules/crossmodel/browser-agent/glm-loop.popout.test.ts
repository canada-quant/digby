/** UI Phase 6b — headed pop-out on ask_user (local driver).
 *
 * The Mac agent's browser runs HEADLESS by default since v0.4.0 (the side panel
 * already streams a screenshot of every step). The one moment the user genuinely
 * needs the real window is when the model asks THEM to act on the page (login /
 * 2FA) — ask_user is handled entirely backend-side (it never reaches the Mac),
 * so the glm-loop is the seam: on ask_user with a LOCAL driver it calls the
 * driver's optional popOutHeaded() (→ `browser_pop_out` on the agent), which
 * relaunches the browser headed on the same profile. Pins:
 *   1. ask_user + local driver → popOutHeaded is called, the user is told the
 *      window opened, and the session still ends with the question.
 *   2. The pop-out is strictly best-effort: a false resolution or a THROWN
 *      rejection never fails the session (and no "opened" line is emitted).
 *   3. Cloud sessions and drivers without popOutHeaded are untouched.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  // Faithful mirror of the real stripThink (see glm-loop.empty-content.test.ts).
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

import { glmChat } from './glm-client';
import { selectBrowserDriver } from './router';
import { runBrowserAgentSession } from './glm-loop';

const ASK = 'Please complete the 2FA prompt in the browser, then ask me to continue.';

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
    url: action.url || 'https://portal.example.com/login',
    content: 'Sign in — a verification code was sent to your phone.',
  })),
  close: jest.fn(async () => {}),
  ...over,
});

const select = (driver: any, kind: 'cloud' | 'local') =>
  (selectBrowserDriver as jest.Mock).mockResolvedValue({ driver, kind, reason: 'r', localStatus: 's' });

const runSession = (sendEvent: (t: string, d: any) => void = () => {}) =>
  runBrowserAgentSession({
    userId: 'u1',
    message: 'log into the portal and download my invoice',
    maxSteps: 6,
    deadlineMs: 120000,
    sendEvent,
  } as any);

/** navigate turn, then ask_user — the incident shape: the model hits a login wall. */
const navThenAsk = () =>
  (glmChat as jest.Mock)
    .mockResolvedValueOnce(toolTurn('t1', 'navigate', { url: 'https://portal.example.com/login' }))
    .mockResolvedValueOnce(toolTurn('t2', 'ask_user', { message: ASK }));

beforeEach(() => jest.clearAllMocks());

describe('ask_user pop-out on the local driver (UI Phase 6b)', () => {
  it('calls popOutHeaded once, tells the user the window opened, and ends with the question', async () => {
    const popOutHeaded = jest.fn(async () => true);
    const driver = mkDriver('local', { popOutHeaded });
    select(driver, 'local');
    navThenAsk();

    const events: Array<{ t: string; d: any }> = [];
    const r = await runSession((t, d) => events.push({ t, d }));

    expect(popOutHeaded).toHaveBeenCalledTimes(1);
    expect(r.finalResponse).toBe(ASK);
    expect(events.some((e) => e.t === 'ask_user' && e.d?.message === ASK)).toBe(true);
    expect(events.some((e) => e.t === 'progress'
      && String(e.d?.message).includes('Opened the browser window on your Mac'))).toBe(true);
    // The session still cleans up — the agent-side close leaves the popped-out
    // window open for the user (poppedOut is agent-side state).
    expect(driver.close).toHaveBeenCalled();
  });

  it('a false resolution (old agent / env-forced headless / no live page) is silent and non-fatal', async () => {
    const popOutHeaded = jest.fn(async () => false);
    select(mkDriver('local', { popOutHeaded }), 'local');
    navThenAsk();

    const events: Array<{ t: string; d: any }> = [];
    const r = await runSession((t, d) => events.push({ t, d }));

    expect(popOutHeaded).toHaveBeenCalledTimes(1);
    expect(r.finalResponse).toBe(ASK);
    expect(events.some((e) => e.t === 'progress'
      && String(e.d?.message).includes('Opened the browser window'))).toBe(false);
  });

  it('a THROWN pop-out never fails the session (belt-and-suspenders over the never-throws contract)', async () => {
    const popOutHeaded = jest.fn(async () => { throw new Error('agent went offline mid-dispatch'); });
    select(mkDriver('local', { popOutHeaded }), 'local');
    navThenAsk();

    const events: Array<{ t: string; d: any }> = [];
    const r = await runSession((t, d) => events.push({ t, d }));

    expect(popOutHeaded).toHaveBeenCalledTimes(1);
    expect(r.finalResponse).toBe(ASK);
    expect(events.some((e) => e.t === 'ask_user')).toBe(true);
  });

  it('a local driver WITHOUT popOutHeaded (pre-6b driver shape) is a clean no-op', async () => {
    select(mkDriver('local'), 'local'); // no popOutHeaded at all
    navThenAsk();

    const r = await runSession();

    expect(r.finalResponse).toBe(ASK);
  });

  it('cloud sessions never pop out, even if the driver object carries the method', async () => {
    const popOutHeaded = jest.fn(async () => true);
    select(mkDriver('cloud', { popOutHeaded }), 'cloud');
    navThenAsk();

    const r = await runSession();

    expect(popOutHeaded).not.toHaveBeenCalled();
    expect(r.finalResponse).toBe(ASK);
  });

  it('a session that finishes with done never pops out', async () => {
    const popOutHeaded = jest.fn(async () => true);
    select(mkDriver('local', { popOutHeaded }), 'local');
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(toolTurn('t1', 'navigate', { url: 'https://portal.example.com/invoices' }))
      .mockResolvedValueOnce(toolTurn('t2', 'done', { message: 'Invoice INV-204 downloaded: total $118.40.' }));

    const r = await runSession();

    expect(popOutHeaded).not.toHaveBeenCalled();
    expect(r.finalResponse).toBe('Invoice INV-204 downloaded: total $118.40.');
  });
});
