/** Ticket e6b16c4e — the agent-link broker's dispatch timeout error must name
 *  the SURFACE that timed out, not "iMessage agent" for everything. The broker
 *  transports commands for every paired-agent surface (iMessage, the local
 *  browser, computer use); dispatchers tag commands with a capability
 *  ('browser' / 'computer' / 'imessage' or none) and the timeout error derives
 *  its noun from that tag. The incident: a browser_navigate to the Windows
 *  agent timed out inside a browser_task and surfaced as
 *  "iMessage agent did not respond within 45000ms". */

const lists = new Map<string, string[]>();
const ttls = new Map<string, number>();

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    rPush: jest.fn(async (k: string, v: string) => {
      const l = lists.get(k) ?? [];
      l.push(v);
      lists.set(k, l);
      return l.length;
    }),
    lPush: jest.fn(async (k: string, v: string) => {
      const l = lists.get(k) ?? [];
      l.unshift(v);
      lists.set(k, l);
      return l.length;
    }),
    lPop: jest.fn(async (k: string) => {
      const l = lists.get(k);
      if (!l || l.length === 0) return null;
      const v = l.shift()!;
      if (l.length === 0) lists.delete(k);
      return v;
    }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => {
      const l = lists.get(k);
      if (!l) return 'OK';
      const n = l.length;
      const s = start < 0 ? Math.max(n + start, 0) : start;
      const e = stop < 0 ? n + stop : stop;
      lists.set(k, l.slice(s, e + 1));
      return 'OK';
    }),
    lRem: jest.fn(async (k: string, _count: number, v: string) => {
      const l = lists.get(k);
      if (!l) return 0;
      const kept = l.filter((x) => x !== v);
      lists.set(k, kept);
      return l.length - kept.length;
    }),
    expire: jest.fn(async (k: string, sec: number) => {
      ttls.set(k, sec);
      return true;
    }),
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { AgentLinkBroker } from './agent-link';

// Fast poll intervals so the real timeout loops run in milliseconds.
const makeBroker = () => new AgentLinkBroker(5, 5);

beforeEach(() => {
  lists.clear();
  ttls.clear();
  jest.clearAllMocks();
});

describe('dispatch timeout error names the surface (e6b16c4e)', () => {
  it('browser-capability commands say "browser agent", not "iMessage agent"', async () => {
    await expect(
      makeBroker().dispatch('win-agent', 'browser_navigate', { url: 'https://example.com' }, 50, { capability: 'browser' }),
    ).rejects.toThrow('browser agent did not respond within 50ms');
  });

  it('computer-capability commands say "computer agent"', async () => {
    await expect(
      makeBroker().dispatch('win-agent', 'computer_screenshot', {}, 50, { capability: 'computer' }),
    ).rejects.toThrow('computer agent did not respond within 50ms');
  });

  it('imessage-tagged commands keep the exact historical wording', async () => {
    await expect(
      makeBroker().dispatch('mac-1', 'list_chats', { limit: 20 }, 50, { capability: 'imessage' }),
    ).rejects.toThrow('iMessage agent did not respond within 50ms');
  });

  it('untagged commands (legacy callers) keep the exact historical wording', async () => {
    await expect(
      makeBroker().dispatch('mac-1', 'list_chats', { limit: 20 }, 50),
    ).rejects.toThrow('iMessage agent did not respond within 50ms');
  });

  it('the redis-down enqueue path also names the surface', async () => {
    // Simulate a Redis outage on push: the first rPush rejects, dispatch must
    // throw the SAME surface-aware shape (not the raw redis error).
    const { default: redisClient } = await import('../../../config/redis');
    const rPush = redisClient.rPush as jest.Mock;
    rPush.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(
      makeBroker().dispatch('win-agent', 'browser_click', {}, 1000, { capability: 'browser' }),
    ).rejects.toThrow('browser agent did not respond within 1000ms');
  });
});
