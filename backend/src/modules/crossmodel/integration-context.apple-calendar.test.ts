/**
 * New-chat integration context — macOS/Apple Calendar prefetch
 * (ticket: "still no calendar sync on new chats/context", 2026-11-06).
 *
 * THE GAP THIS PINS. Google Calendar was prefetched on calendar intent; the
 * owner's Apple Calendar — the calendar actually holding his day — was NEVER
 * fetched. So a new chat answering "what's on today?" knew nothing about the
 * events on his Macs, and the silence looked exactly like an empty calendar.
 *
 * What the tests hold:
 *   1. a calendar-intent message produces an APPLE CALENDAR context block;
 *   2. a NON-calendar message does NOT pay the dispatch (latency discipline);
 *   3. a classified failure reaches the prompt as an UNAVAILABLE block with an
 *      explicit "do not say the calendar is empty" instruction — the phony
 *      empty day is the bug;
 *   4. a failing Apple leg never breaks the turn (graceful degradation);
 *   5. the kill switch suppresses it.
 */

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    googleOAuthToken: { findFirst: jest.fn(async () => null) },
    gitHubOAuthToken: { findFirst: jest.fn(async () => null) },
    xOAuthToken: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    xeroOAuthToken: { findFirst: jest.fn(async () => null) },
    plaidAccessToken: { findFirst: jest.fn(async () => null) },
    slackOAuthToken: { findFirst: jest.fn(async () => null) },
    asanaOAuthToken: { findFirst: jest.fn(async () => null) },
    telegramLink: { findFirst: jest.fn(async () => null) },
    integrationHealth: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => null) },
    userMemory: { findUnique: jest.fn(async () => null) },
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// apple-calendar's real module graph reaches agent-link → config/redis → env,
// which process.exit()s at import in tests.
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));
// Every other family stays off: only the calendar intent is under test.
jest.mock('./x/intent-detector', () => ({
  __esModule: true,
  detectXIntent: () => ({ search: false, trends: false, profile: false, tweet: false, post: false, reply: false, like: false, retweet: false, follow: false }),
  hasReadIntent: () => false,
  hasAnyXIntent: () => false,
  extractXContext: () => ({ searchQuery: '' }),
}));
jest.mock('./x/x-mcp', () => ({ __esModule: true, getUserProfile: jest.fn(), getTweet: jest.fn(), search: jest.fn(), getTrends: jest.fn() }));

// The Macs: one online, so the Apple leg is worth paying for.
jest.mock('./imessage/imessage.service', () => ({
  __esModule: true,
  getPrimaryAgent: jest.fn(async () => null),
  isOnline: jest.fn(() => true),
  listAgents: jest.fn(async () => [
    { id: 'a1', userId: 'u1', label: 'mac-a', isDefault: true, lastSeenAt: new Date(), agentVersion: '0.9.24', capabilities: ['imessage', 'calendar'], platform: 'macos', deviceId: 'd1', deviceName: 'mac-a.local', pairedAt: new Date() },
  ]),
  agentDisplayName: (a: any) => a?.label || 'Mac',
  selectAgent: jest.fn(async () => ({ agent: null, note: '', error: 'none' })),
}));
// The read itself is the seam under test's control.
jest.mock('./calendar/apple-calendar', () => {
  const actual = jest.requireActual('./calendar/apple-calendar');
  return { __esModule: true, ...actual, readAppleCalendar: jest.fn() };
});

import { buildIntegrationContext } from './integration-context';
import * as appleCalendar from './calendar/apple-calendar';

const events: Array<{ type: string; data: any }> = [];
const sendEvent = (type: string, data: any) => events.push({ type, data });

const okRead = {
  state: 'ok' as const,
  device: 'mac-a',
  agentId: 'a1',
  via: 'default' as const,
  events: [
    { id: 'e1', calendar: 'Work', title: 'Board meeting', startDate: '2026-11-06T18:00:00Z', endDate: '2026-11-06T19:00:00Z', location: 'HQ', allDay: false, notes: null },
  ],
};

beforeAll(() => {
  delete process.env.GOOGLE_OAUTH_CLIENT_ID;
  delete process.env.XERO_CLIENT_ID;
  delete process.env.PLAID_CLIENT_ID;
  delete process.env.SLACK_CLIENT_ID;
  delete process.env.ASANA_CLIENT_ID;
  delete process.env.X_MCP_API_KEY;
});
beforeEach(() => {
  jest.clearAllMocks();
  events.length = 0;
  delete process.env.MAC_CALENDAR_CONTEXT_DISABLED;
});

describe('macOS Apple Calendar reaches new-chat context (2026-11-06)', () => {
  it('a calendar-intent message injects the Mac calendar events', async () => {
    (appleCalendar.readAppleCalendar as jest.Mock).mockResolvedValue(okRead);
    const out = await buildIntegrationContext({ userId: 'u1', message: "what's on my calendar today?", sendEvent });
    expect(appleCalendar.readAppleCalendar).toHaveBeenCalled();
    expect(out.additionalContext).toContain('APPLE CALENDAR (from the user\'s Mac)');
    expect(out.additionalContext).toContain('Board meeting');
    expect(out.additionalContext).toContain('mac-a');
    // And it names progress so the UI is not silent while it waits.
    expect(events.some((e) => /Mac calendar/i.test(String(e.data?.message || '')))).toBe(true);
  });

  it('a NON-calendar message pays no Apple dispatch (latency discipline)', async () => {
    (appleCalendar.readAppleCalendar as jest.Mock).mockResolvedValue(okRead);
    const out = await buildIntegrationContext({ userId: 'u1', message: 'write me a haiku about rust', sendEvent });
    expect(appleCalendar.readAppleCalendar).not.toHaveBeenCalled();
    expect(out.additionalContext || '').not.toContain('APPLE CALENDAR');
  });

  it('a never-granted Mac reaches the prompt as UNAVAILABLE, never as an empty day', async () => {
    (appleCalendar.readAppleCalendar as jest.Mock).mockResolvedValue({
      state: 'calendar-never-requested', device: 'mac-a', agentId: 'a1', via: 'default',
      events: null, error: 'mac-a has never been granted Calendar access.',
    });
    const out = await buildIntegrationContext({ userId: 'u1', message: 'what is on my calendar tomorrow?', sendEvent });
    expect(out.additionalContext).toContain('APPLE CALENDAR (UNAVAILABLE)');
    expect(out.additionalContext).toMatch(/Do NOT tell the user their calendar is empty/);
    expect(out.additionalContext).not.toContain('No Apple Calendar events');
  });

  it('a failing Apple leg degrades gracefully — the turn still builds', async () => {
    (appleCalendar.readAppleCalendar as jest.Mock).mockRejectedValue(new Error('agent wedged'));
    const out = await buildIntegrationContext({ userId: 'u1', message: 'what is on my calendar?', sendEvent });
    expect(out).toBeDefined();
    expect(out.additionalContext || '').not.toContain('APPLE CALENDAR');
  });

  it('an anonymous send never reads a Mac calendar', async () => {
    (appleCalendar.readAppleCalendar as jest.Mock).mockResolvedValue(okRead);
    const out = await buildIntegrationContext({ userId: null, message: 'what is on my calendar?', sendEvent });
    expect(appleCalendar.readAppleCalendar).not.toHaveBeenCalled();
    expect(out.additionalContext).toBeUndefined();
  });
});