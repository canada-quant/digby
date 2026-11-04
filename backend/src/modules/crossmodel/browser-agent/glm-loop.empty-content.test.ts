/** feedback fcc28eba — browser_task local-driver runs returned only the FIRST
 * internal step of the agent's reasoning trace ("get_tabs…, get_content snapshot
 * on swapfile.com…") with none of the page data or the final report.
 *
 * Root cause: when GLM ended a turn with EMPTY content (think-only payload,
 * provider truncation, or a null content on the forced no-tools final step), the
 * loop fell back to `reasoning_content` — the model's chain-of-thought — as the
 * final answer. The fix: an empty-content turn routes to the wrap-up, which
 * re-asks over the accumulated observation history (the REAL page content from
 * every executed step) and writes the report from that; reasoning_content is
 * never surfaced. */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./glm-client', () => ({
  __esModule: true,
  glmChat: jest.fn(),
  // Faithful mirror of the real stripThink (it has its own unit tests in
  // glm-client.stripthink.test.ts) so think-only / unterminated payloads strip
  // to empty exactly like production.
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

const mkLocalDriver = () => ({
  kind: 'local' as const,
  isAvailable: jest.fn(async () => true),
  execute: jest.fn(async (action: any) => ({
    ok: true,
    driver: 'local',
    action: action.name,
    url: action.url || 'https://swapfile.com/people',
    content: PAGE_CONTENT,
  })),
  close: jest.fn(async () => {}),
});

const turn = (id: string, name: string, args: any) => ({
  content: '',
  tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});
const navigateTurn = turn('t1', 'navigate', { url: 'https://swapfile.com/people' });
const readTurn = turn('t2', 'get_content', { format: 'text' });

/** The failure signature: no tool calls, empty content, reasoning narrating the
 *  FIRST tool calls it planned — the "trace head" the chat agent received. */
const TRACE_HEAD =
  'I need to see the open tabs first. I will call get_tabs, then get_content ' +
  'with format snapshot on swapfile.com to load the people list…';

const emptyContentTurn = { content: null, reasoning_content: TRACE_HEAD };
const thinkOnlyTurn = { content: `<think>${TRACE_HEAD}</think>`, reasoning_content: null };
const unterminatedThinkTurn = { content: `<think>${TRACE_HEAD}`, reasoning_content: null };

const REPORT = 'The people list shows Alice Martin (Acme Corp), Bob Zhou (Globex), and Carol Imbert (Initech).';

const localSelected = (driver: any) =>
  (selectBrowserDriver as jest.Mock).mockResolvedValue({ driver, kind: 'local', reason: 'driving your paired Mac browser' });

const runSession = () =>
  runBrowserAgentSession({
    userId: 'u1',
    message: 'scroll to people and list the first names you see',
    maxSteps: 6,
    deadlineMs: 120000,
    sendEvent: () => {},
  } as any);

beforeEach(() => jest.clearAllMocks());

describe('empty-content turns never surface the reasoning trace (fcc28eba)', () => {
  it('null-content turn with reasoning_content → wrap-up reports the observed page data, not the trace head', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    const wrapMessages: any[] = [];
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce(readTurn)
      .mockResolvedValueOnce(emptyContentTurn)
      .mockImplementationOnce((input: any) => {
        wrapMessages.push(...input.messages);
        return Promise.resolve({ content: REPORT });
      });

    const r = await runSession();

    expect(glmChat).toHaveBeenCalledTimes(4); // 2 steps + empty turn + wrap-up
    expect(r.finalResponse).toBe(REPORT);
    expect(r.finalResponse).not.toContain('get_tabs');
    // The wrap-up re-asked over the FULL observation history — the real page
    // content retrieved by the executed steps rides the tool messages.
    const toolBodies = wrapMessages.filter((m) => m.role === 'tool').map((m) => String(m.content));
    expect(toolBodies.some((c) => c.includes('Alice Martin'))).toBe(true);
  });

  it('think-only content (strips to empty) → wrap-up, not the trace', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce(thinkOnlyTurn)
      .mockResolvedValueOnce({ content: REPORT });

    const r = await runSession();

    expect(glmChat).toHaveBeenCalledTimes(3);
    expect(r.finalResponse).toBe(REPORT);
    expect(r.finalResponse).not.toContain('get_tabs');
  });

  it('unterminated think block (provider cut mid-reasoning) → wrap-up, not the trace', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce(unterminatedThinkTurn)
      .mockResolvedValueOnce({ content: REPORT });

    const r = await runSession();

    expect(r.finalResponse).toBe(REPORT);
    expect(r.finalResponse).not.toContain('get_tabs');
  });

  it('empty content AND an empty wrap-up → honest failure message, never the reasoning trace', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce(emptyContentTurn)
      .mockResolvedValueOnce({ content: null, reasoning_content: TRACE_HEAD }); // wrap-up comes back empty too

    const r = await runSession();

    expect(r.finalResponse).toContain('could not complete the task');
    expect(r.finalResponse).not.toContain('get_tabs');
  });

  it('whitespace-only content is answer-less too → wrap-up (review N2)', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce({ content: '   \n  ', reasoning_content: TRACE_HEAD })
      .mockResolvedValueOnce({ content: REPORT });

    const r = await runSession();

    expect(glmChat).toHaveBeenCalledTimes(3);
    expect(r.finalResponse).toBe(REPORT);
    expect(r.finalResponse.trim().length).toBeGreaterThan(0);
  });

  it('a normal content answer still wins immediately (no wrap-up round-trip)', async () => {
    const driver = mkLocalDriver();
    localSelected(driver);
    (glmChat as jest.Mock)
      .mockResolvedValueOnce(navigateTurn)
      .mockResolvedValueOnce({ content: REPORT, reasoning_content: 'some hidden chain-of-thought' });

    const r = await runSession();

    expect(glmChat).toHaveBeenCalledTimes(2); // no wrap-up needed
    expect(r.finalResponse).toBe(REPORT);
  });
});
