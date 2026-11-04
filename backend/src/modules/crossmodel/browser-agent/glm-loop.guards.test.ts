/** ticket 58cad87c — browser-agent mid-loop guards: degeneration + CAPTCHA.
 *
 * The prod incident (local driver, Mac app v0.3.2, swapcard): the model hit a
 * CAPTCHA, then its turn CONTENT collapsed into a repetitive mixed-language
 * monologue ("Let me try… 前进! / Proceeding… / I can't stop generating…")
 * spanning thousands of tokens. Two defects pinned here:
 *   1. No degeneration guard MID-LOOP — the final-answer isDegenerate check only
 *      fires after the loop, and feeding the garbage back as the assistant turn
 *      compounds the collapse (the 7be7440a lesson). Now: degenerate turn content
 *      is sanitized out of history (tool calls still execute), and two consecutive
 *      degenerate turns hand off to the observation-history wrap-up.
 *   2. No graceful CAPTCHA path — the model retried the challenge instead of
 *      reporting it. Now: a deterministic sniff marks the observation, the tool
 *      result tells the model to call done with a blocked report, and a second
 *      consecutive detection force-stops into the wrap-up. */

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

const PAGE_CONTENT = 'People directory — Alice Martin · Acme Corp; Bob Zhou · Globex; Carol Imbert · Initech';
const CAPTCHA_PAGE =
  'Verify you are human by completing the action below.\n' +
  'Checking if the site connection is secure.\n' +
  'app.swapcard.com needs to review the security of your connection before proceeding.';

/** The incident signature: a repetitive mixed-language monologue > 400 chars —
 *  degenerate per isDegenerate (the "let me try…" sentence repeats ≥3×). */
const DEGENERATE_MONOLOGUE =
  'Let me try... 前进! Proceeding with the next attempt now. '.repeat(12);

const mkLocalDriver = (content: string) => ({
  kind: 'local' as const,
  isAvailable: jest.fn(async () => true),
  execute: jest.fn(async (action: any) => ({
    ok: true,
    driver: 'local',
    action: action.name,
    url: action.url || 'https://app.swapcard.com/event/all-in-2026/people',
    content,
  })),
  close: jest.fn(async () => {}),
});

const toolTurn = (id: string, name: string, args: any, content = '') => ({
  content,
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});

const localSelected = (driver: any) =>
  (selectBrowserDriver as jest.Mock).mockResolvedValue({ driver, kind: 'local', reason: 'driving your paired Mac browser' });

const runSession = (sendEvent: (t: string, d: any) => void = () => {}) =>
  runBrowserAgentSession({
    userId: 'u1',
    message: 'go to the people page and list attendee names',
    maxSteps: 8,
    deadlineMs: 120000,
    sendEvent,
  } as any);

beforeEach(() => jest.clearAllMocks());

describe('mid-loop degeneration guard (58cad87c)', () => {
  it('sanitizes degenerate turn content out of history and hands off to the wrap-up after two consecutive strikes', async () => {
    const driver = mkLocalDriver(PAGE_CONTENT);
    localSelected(driver);
    const wrapMessages: any[] = [];
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(toolTurn('t1', 'navigate', { url: 'https://app.swapcard.com/event/all-in-2026/people' }))
      .mockResolvedValueOnce(toolTurn('t2', 'get_content', { format: 'text' }, DEGENERATE_MONOLOGUE)) // strike 1 — executes
      .mockResolvedValueOnce(toolTurn('t3', 'scroll', { direction: 'down' }, DEGENERATE_MONOLOGUE))    // strike 2 — executes, then break
      .mockImplementationOnce((input: any) => {                                                        // wrap-up
        wrapMessages.push(...input.messages);
        return Promise.resolve({ content: 'The people page shows Alice Martin, Bob Zhou, and Carol Imbert.' });
      });

    const r = await runSession();

    expect(glmChat).toHaveBeenCalledTimes(4); // 3 turns + wrap-up
    expect(r.finalResponse).toContain('Alice Martin');
    // The garbage never rode the context: every assistant turn in the wrap-up
    // history carries sanitized (empty) content, and no message body holds the
    // monologue's CJK fragment.
    const bodies = wrapMessages.map((m) => String(m.content || ''));
    expect(bodies.some((c) => c.includes('前进'))).toBe(false);
    const assistantWithTools = wrapMessages.filter((m) => m.role === 'assistant' && m.tool_calls);
    expect(assistantWithTools.length).toBe(3);
    expect(assistantWithTools.every((m) => m.content === '' || !m.content.includes('Let me try'))).toBe(true);
  });

  it('a single degenerate turn does NOT stop the session — a clean next turn resets the strike', async () => {
    const driver = mkLocalDriver(PAGE_CONTENT);
    localSelected(driver);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(toolTurn('t1', 'navigate', { url: 'https://app.swapcard.com/event/all-in-2026/people' }))
      .mockResolvedValueOnce(toolTurn('t2', 'get_content', { format: 'text' }, DEGENERATE_MONOLOGUE)) // strike 1
      .mockResolvedValueOnce(toolTurn('t3', 'done', { message: 'Found: Alice Martin, Bob Zhou, Carol Imbert.' }));

    const r = await runSession();

    expect(glmChat).toHaveBeenCalledTimes(3); // no wrap-up
    expect(r.finalResponse).toBe('Found: Alice Martin, Bob Zhou, Carol Imbert.');
    expect(r.steps).toBe(3);
  });
});

describe('graceful CAPTCHA stop (58cad87c)', () => {
  it('first detection annotates the tool result and lets the model stop with a blocked report', async () => {
    const driver = mkLocalDriver(CAPTCHA_PAGE);
    localSelected(driver);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(toolTurn('t1', 'navigate', { url: 'https://app.swapcard.com/event/all-in-2026/people' }))
      .mockResolvedValueOnce(toolTurn('t2', 'done', {
        message: 'Blocked: the people page shows a CAPTCHA (human verification) before any attendee data loads. No names could be gathered.',
      }));

    const events: Array<{ t: string; d: any }> = [];
    const r = await runSession((t, d) => events.push({ t, d }));

    expect(glmChat).toHaveBeenCalledTimes(2); // no wrap-up needed — model stopped cleanly
    expect(r.finalResponse).toContain('CAPTCHA');
    // The tool result carried the stop-and-report instruction.
    const secondCallMessages = (glmChat as jest.Mock).mock.calls[1][0].messages;
    const toolBodies = secondCallMessages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
    expect(toolBodies.some((c: string) => c.includes('CAPTCHA / human-verification challenge is blocking this page'))).toBe(true);
    // …and the user saw the warning as it happened.
    expect(events.some((e) => e.t === 'progress' && String(e.d?.message || '').includes('CAPTCHA'))).toBe(true);
  });

  it('a retried CAPTCHA (second consecutive detection) force-stops into the wrap-up', async () => {
    const driver = mkLocalDriver(CAPTCHA_PAGE);
    localSelected(driver);
    const wrapMessages: any[] = [];
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(toolTurn('t1', 'navigate', { url: 'https://app.swapcard.com/event/all-in-2026/people' })) // strike 1
      .mockResolvedValueOnce(toolTurn('t2', 'navigate', { url: 'https://app.swapcard.com/event/all-in-2026/people' })) // retry → strike 2 → force-stop
      .mockImplementationOnce((input: any) => {
        wrapMessages.push(...input.messages);
        return Promise.resolve({ content: 'Blocked by a CAPTCHA on the people page; no attendee data was retrievable.' });
      });

    const r = await runSession();

    expect(glmChat).toHaveBeenCalledTimes(3); // 2 turns + wrap-up — NOT 8 steps of retries
    expect(r.finalResponse).toContain('CAPTCHA');
    const toolBodies = wrapMessages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(toolBodies.filter((c) => c.includes('CAPTCHA / human-verification challenge is blocking this page')).length).toBe(2);
  });

  it('a clean page after one detection resets the strike counter', async () => {
    const captchaThenClean = mkLocalDriver(CAPTCHA_PAGE);
    localSelected(captchaThenClean);
    (captchaThenClean.execute as jest.Mock)
      .mockImplementationOnce(async (action: any) => ({ ok: true, driver: 'local', action: action.name, url: action.url, content: CAPTCHA_PAGE }))
      .mockImplementation(async (action: any) => ({ ok: true, driver: 'local', action: action.name, url: action.url, content: PAGE_CONTENT }));
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(toolTurn('t1', 'navigate', { url: 'https://app.swapcard.com/event/all-in-2026/people' })) // strike 1
      .mockResolvedValueOnce(toolTurn('t2', 'get_content', { format: 'text' }))                                        // clean page → reset
      .mockResolvedValueOnce(toolTurn('t3', 'navigate', { url: 'https://app.swapcard.com/event/all-in-2026/agenda' })) // clean
      .mockResolvedValueOnce(toolTurn('t4', 'done', { message: 'Alice Martin and Bob Zhou are listed.' }));

    const r = await runSession();

    expect(glmChat).toHaveBeenCalledTimes(4); // no force-stop, no wrap-up
    expect(r.finalResponse).toBe('Alice Martin and Bob Zhou are listed.');
  });
});
