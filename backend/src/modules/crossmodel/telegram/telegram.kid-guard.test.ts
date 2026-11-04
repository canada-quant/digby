/**
 * Telegram Digby Kids guard (patience plan 1a §3.5, 2026-09-25): a linked
 * CHILD account never runs the adult single-model agent over Telegram — it
 * gets the kid-mode reply; an adult link runs the agent as before; a missing
 * user row and an unreadable one each fail CLOSED with their OWN neutral copy
 * (review 2026-09-25: an adult mid-outage is never told they are on a kids
 * account).
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockLinkFind: jest.Mock = jest.fn();
const mockUserFind: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    telegramLink: { findUnique: (...a: any[]) => mockLinkFind(...a) },
    user: { findUnique: (...a: any[]) => mockUserFind(...a) },
  },
}));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../langgraph/integration-status-cache', () => ({ __esModule: true, invalidateIntegrationStatusCache: jest.fn(async () => {}) }));

const mockSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('./telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  getBotUsername: () => 'DigbyBot',
  sendMessage: (...a: any[]) => mockSendMessage(...a),
  sendTyping: jest.fn(async () => {}),
  mintLinkToken: jest.fn(async () => 't'),
  consumeLinkToken: jest.fn(async () => null),
  buildConnectUrl: jest.fn(() => 'https://t.me/DigbyBot?start=t'),
}));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  listOpenOwnerQuestionsForUser: jest.fn(async () => []),
  answerOwnerQuestion: jest.fn(async () => 'ok'),
  shortQuestionRef: (id: string) => id.slice(3, 11),
}));
const mockRunTurn: jest.Mock = jest.fn(async (args: any) => { args.send('chunk', { content: 'adult answer' }); });
jest.mock('../chat-agent/chat-agent.service', () => ({ __esModule: true, runChatAgentTurn: (...a: any[]) => mockRunTurn(...a) }));
jest.mock('../langgraph/pipeline-utils', () => ({
  __esModule: true,
  parseCanvasTags: (t: string) => ({ canvases: [], cleanText: t }),
  parseFollowUps: (t: string) => ({ followUps: [], cleanText: t }),
}));

import { handleUpdate, isChildLinkedUser, linkedUserKind, linkedUserRefusal, KID_TELEGRAM_MESSAGE, UNLINKED_TELEGRAM_MESSAGE, UNAVAILABLE_TELEGRAM_MESSAGE } from './telegram.controller';

const update = (text: string) => ({ message: { chat: { id: 555 }, text, from: { id: 9 } } });

beforeEach(() => {
  jest.clearAllMocks();
  mockLinkFind.mockResolvedValue({ userId: 'u-1', chatId: '555' });
});

describe('Telegram × Digby Kids', () => {
  it('a linked CHILD account gets the kid-mode reply and never runs the adult agent', async () => {
    mockUserFind.mockResolvedValue({ isChild: true });
    await handleUpdate(update('what is 7 times 8?'));
    expect(mockRunTurn).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith('555', KID_TELEGRAM_MESSAGE);
    expect(mockUserFind).toHaveBeenCalledWith({ where: { id: 'u-1' }, select: { isChild: true } });
  });

  it("an adult link runs the agent through THE send-mode resolver (audit 2026-09-26 routing-unify-6): routed like a web send, channel 'telegram', never Level 3 (chatless), sessionId telegram:<chatId>", async () => {
    mockUserFind.mockResolvedValue({ isChild: false });
    await handleUpdate(update('what is 7 times 8?'));
    expect(mockRunTurn).toHaveBeenCalledTimes(1);
    expect(mockRunTurn.mock.calls[0][0]).toMatchObject({ userId: 'u-1', chatId: null, sessionId: 'telegram:555', mode: 'single_thinking', channel: 'telegram', routingSource: 'auto_heuristic' });
    expect(mockRunTurn.mock.calls[0][0].routing).toMatchObject({ level: 'single_thinking' });
    expect(mockSendMessage).toHaveBeenCalledWith('555', 'adult answer');
    // Research intent routes Level 2 — the chatless floor keeps the council off a channel with no row to post to.
    await handleUpdate(update('Please do deep research into the root cause of the outage across all our services and vendors.'));
    expect(mockRunTurn.mock.calls[1][0]).toMatchObject({ mode: 'thinking', channel: 'telegram' });
    expect(mockRunTurn.mock.calls[1][0].routing).toMatchObject({ level: 'thinking', reasonKey: 'chatless_no_research' });
  });

  it('TELEGRAM_AUTO_ROUTE_DISABLED=1 keeps the fixed Level 1 (the pre-audit behaviour)', async () => {
    process.env.TELEGRAM_AUTO_ROUTE_DISABLED = '1';
    try {
      mockUserFind.mockResolvedValue({ isChild: false });
      await handleUpdate(update('Please do deep research into everything.'));
      expect(mockRunTurn.mock.calls[0][0]).toMatchObject({ mode: 'single_thinking', channel: 'telegram' });
      expect(mockRunTurn.mock.calls[0][0].routing).toBeUndefined();
    } finally { delete process.env.TELEGRAM_AUTO_ROUTE_DISABLED; }
  });

  it('fails CLOSED: an unreadable or missing user row never runs the agent — but the copy branches (kids text only for a real child)', async () => {
    mockUserFind.mockRejectedValueOnce(new Error('db down'));
    expect(await linkedUserKind('u-1')).toBe('unreadable');
    mockUserFind.mockResolvedValueOnce(null);
    expect(await linkedUserKind('u-1')).toBe('missing');
    mockUserFind.mockResolvedValueOnce({ isChild: false });
    expect(await linkedUserKind('u-1')).toBe('adult');
    mockUserFind.mockResolvedValueOnce({ isChild: true });
    expect(await linkedUserKind('u-1')).toBe('child');
    expect(linkedUserRefusal('adult')).toBeNull();
    expect(linkedUserRefusal('child')).toBe(KID_TELEGRAM_MESSAGE);
    expect(linkedUserRefusal('missing')).toBe(UNLINKED_TELEGRAM_MESSAGE);
    expect(linkedUserRefusal('unreadable')).toBe(UNAVAILABLE_TELEGRAM_MESSAGE);
    expect(UNAVAILABLE_TELEGRAM_MESSAGE).not.toMatch(/kids/i);
    expect(UNLINKED_TELEGRAM_MESSAGE).not.toMatch(/kids/i);
    // The boolean view keeps its fail-closed contract.
    mockUserFind.mockRejectedValueOnce(new Error('db down'));
    expect(await isChildLinkedUser('u-1')).toBe(true);
    mockUserFind.mockResolvedValueOnce({ isChild: false });
    expect(await isChildLinkedUser('u-1')).toBe(false);
  });

  it('a transient DB error replies with the neutral unavailable line, a deleted user with the unlinked line — never the kids copy, never the agent', async () => {
    mockUserFind.mockRejectedValueOnce(new Error('db down'));
    await handleUpdate(update('hello?'));
    expect(mockRunTurn).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith('555', UNAVAILABLE_TELEGRAM_MESSAGE);
    mockSendMessage.mockClear();
    mockUserFind.mockResolvedValueOnce(null);
    await handleUpdate(update('hello?'));
    expect(mockRunTurn).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith('555', UNLINKED_TELEGRAM_MESSAGE);
  });

  it('an unlinked chat is asked to connect first (no user lookup at all)', async () => {
    mockLinkFind.mockResolvedValue(null);
    await handleUpdate(update('hi'));
    expect(mockUserFind).not.toHaveBeenCalled();
    expect(mockRunTurn).not.toHaveBeenCalled();
    expect(String(mockSendMessage.mock.calls[0][1])).toContain('connect first');
  });
});
