/**
 * iMessage Agent Link — Redis-backed command broker.
 * Prod runs multiple backend processes (2 web + 1 worker), so dispatch, the
 * Mac's long-poll, and the result POST usually land on DIFFERENT processes —
 * the broker must round-trip entirely through Redis lists. Redis is mocked with
 * the in-memory stand-in (the confirm-pending test pattern) so config/env never
 * loads; the shared mock store IS the cross-process bus.
 */

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

import redisClient from '../../../config/redis';
import { AgentLinkBroker } from './agent-link';

const CMD_KEY = (agentId: string) => `imsg:cmd:${agentId}`;
const RES_KEY = (cmdId: string) => `imsg:res:${cmdId}`;

// Fast poll intervals so the real loops run in milliseconds.
const makeBroker = () => new AgentLinkBroker(10, 10);

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  lists.clear();
  ttls.clear();
  jest.clearAllMocks();
});

describe('dispatch → poll → result round-trip (cross-process via Redis)', () => {
  it('the dispatcher receives the result delivered by another process', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'get_messages', { chat: 'Alice', limit: 25 }, 2000);
    pending.catch(() => {}); // settled below — avoid an unhandled rejection window

    // "Another web instance" serves the Mac's poll.
    const cmd = await makeBroker().waitForCommand('agent-1', 500);
    expect(cmd).toEqual({
      cmdId: expect.any(String),
      method: 'get_messages',
      params: { chat: 'Alice', limit: 25 },
    });
    // Only the wire fields — no dispatch metadata leaks to the Mac.
    expect(Object.keys(cmd!).sort()).toEqual(['cmdId', 'method', 'params']);

    // "A third instance" receives the result POST.
    const delivered = await makeBroker().deliverResult(cmd!.cmdId, true, { messages: [1, 2] });
    expect(delivered).toBe(true);
    await expect(pending).resolves.toEqual({ messages: [1, 2] });
  });

  it('an ok=false result rejects the dispatch with the agent error', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'send_message', { to: 'x', text: 'hi' }, 2000);
    pending.catch(() => {});
    const cmd = await broker.waitForCommand('agent-1', 500);
    await broker.deliverResult(cmd!.cmdId, false, null, 'Messages.app not running');
    await expect(pending).rejects.toThrow('Messages.app not running');
  });

  it('dispatch times out with the canonical error and removes its queued command', async () => {
    const broker = makeBroker();
    await expect(broker.dispatch('agent-1', 'list_chats', { limit: 20 }, 50)).rejects.toThrow(
      'iMessage agent did not respond within 50ms',
    );
    // The un-polled command was removed from the agent's queue (lRem cleanup).
    expect(lists.get(CMD_KEY('agent-1')) ?? []).toHaveLength(0);
  });
});

describe('waitForCommand (agent long-poll)', () => {
  it('returns null after the budget when no command arrives', async () => {
    const start = Date.now();
    const cmd = await makeBroker().waitForCommand('agent-1', 60);
    expect(cmd).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });

  it('picks up a command dispatched AFTER the poll started parking', async () => {
    const broker = makeBroker();
    const polling = broker.waitForCommand('agent-1', 1000);
    const pending = broker.dispatch('agent-1', 'ping', {}, 2000);
    pending.catch(() => {});
    const cmd = await polling;
    expect(cmd?.method).toBe('ping');
    await broker.deliverResult(cmd!.cmdId, true, 'pong');
    await expect(pending).resolves.toBe('pong');
  });

  it('skips queued commands whose dispatch timeout already elapsed', async () => {
    lists.set(CMD_KEY('agent-1'), [
      JSON.stringify({ cmdId: 'stale', method: 'ping', params: {}, dispatchedAt: Date.now() - 60_000, timeoutMs: 1000 }),
      JSON.stringify({ cmdId: 'fresh', method: 'ping', params: {}, dispatchedAt: Date.now(), timeoutMs: 60_000 }),
    ]);
    const cmd = await makeBroker().waitForCommand('agent-1', 200);
    expect(cmd?.cmdId).toBe('fresh');
  });

  it('skips malformed queue entries instead of failing the poll', async () => {
    lists.set(CMD_KEY('agent-1'), ['{not json', JSON.stringify({ cmdId: 'ok-1', method: 'ping', params: {} })]);
    const cmd = await makeBroker().waitForCommand('agent-1', 200);
    expect(cmd?.cmdId).toBe('ok-1');
  });

  it('requeues a popped command when the poll was cancelled mid-flight', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'ping', {}, 2000);
    pending.catch(() => {});
    await tick();
    let calls = 0;
    const cmd = await broker.waitForCommand('agent-1', 500, () => calls++ > 0); // cancelled on the post-pop check
    expect(cmd).toBeNull();
    expect(lists.get(CMD_KEY('agent-1'))).toHaveLength(1); // back at the head for the next poll
    const retry = await broker.waitForCommand('agent-1', 200);
    expect(retry?.method).toBe('ping');
    await broker.deliverResult(retry!.cmdId, true, null);
    await pending;
  });
});

describe('queue cap + TTLs', () => {
  it('caps the per-agent queue at 50, dropping the oldest', async () => {
    const broker = makeBroker();
    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 55; i++) {
      promises.push(broker.dispatch('agent-1', `m${i}`, {}, 300).catch(() => 'timeout'));
    }
    // Let every enqueue (rPush + lTrim) run before the dispatch timeouts fire.
    for (let i = 0; i < 10; i++) await tick();
    const q = lists.get(CMD_KEY('agent-1'))!;
    expect(q).toHaveLength(50);
    expect(JSON.parse(q[0]).method).toBe('m5'); // oldest 5 trimmed away
    await Promise.all(promises);
  });

  it('refreshes the queue backstop TTL on each push and TTLs results (~60s)', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'ping', {}, 500);
    pending.catch(() => {});
    await tick();
    expect(ttls.get(CMD_KEY('agent-1'))).toBe(120);

    // A result delivered with no dispatcher waiting self-expires — never lingers.
    await broker.deliverResult('orphan-cmd', true, 'late');
    expect(lists.get(RES_KEY('orphan-cmd'))).toHaveLength(1);
    expect(ttls.get(RES_KEY('orphan-cmd'))).toBe(60);
    await pending.catch(() => {});
  });
});

describe('cancelWaiter + Redis-down posture', () => {
  it('cancelWaiter is a no-op (no parked in-process waiter on the Redis transport)', () => {
    const broker = makeBroker();
    expect(() => broker.cancelWaiter('agent-1')).not.toThrow();
    expect(redisClient.rPush).not.toHaveBeenCalled();
    expect(redisClient.lPop).not.toHaveBeenCalled();
  });

  it('dispatch fails with the existing "did not respond" shape when Redis is down', async () => {
    (redisClient.rPush as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(makeBroker().dispatch('agent-1', 'ping', {}, 1000)).rejects.toThrow(
      'iMessage agent did not respond within 1000ms',
    );
  });

  it('the poll returns empty when Redis is down (the Mac just re-polls)', async () => {
    (redisClient.lPop as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(makeBroker().waitForCommand('agent-1', 200)).resolves.toBeNull();
  });

  it('deliverResult degrades to delivered=false when Redis is down', async () => {
    (redisClient.rPush as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(makeBroker().deliverResult('cmd-1', true, {})).resolves.toBe(false);
  });
});

describe('version-gated dispatch (multi-device clone protection, 2026-08-31)', () => {
  it('an under-version poller cannot claim a gated command; it stays queued for a capable agent', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'computer_screenshot', {}, 2000, { minAgentVersion: '0.3.2' });
    pending.catch(() => {});

    // The old clone polls first — it must NOT get the gated command.
    const oldPoller = await makeBroker().waitForCommand('agent-1', 60, undefined, '0.3.0');
    expect(oldPoller).toBeNull();
    // …and the command is still queued (requeued at the head, not eaten).
    expect(lists.get(CMD_KEY('agent-1')) ?? []).toHaveLength(1);

    // The capable agent polls next — it claims and answers; dispatch resolves.
    const cmd = await makeBroker().waitForCommand('agent-1', 500, undefined, '0.3.2');
    expect(cmd?.method).toBe('computer_screenshot');
    expect(cmd?.minAgentVersion).toBe('0.3.2'); // wire field is visible to the agent (ignored there)
    await makeBroker().deliverResult(cmd!.cmdId, true, { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('ungated commands remain claimable by any agent version (back-compat)', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'list_chats', { limit: 5 }, 2000);
    pending.catch(() => {});
    const cmd = await makeBroker().waitForCommand('agent-1', 500, undefined, '0.1.0');
    expect(cmd?.method).toBe('list_chats');
    expect(cmd?.minAgentVersion).toBeUndefined();
    expect(Object.keys(cmd!).sort()).toEqual(['cmdId', 'method', 'params']);
    await broker.deliverResult(cmd!.cmdId, true, { chats: [] });
    await expect(pending).resolves.toEqual({ chats: [] });
  });

  it('a gated command times out cleanly when ONLY under-version agents poll', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'computer_screenshot', {}, 300, { minAgentVersion: '0.3.2' });
    pending.catch(() => {});
    // Old clone polls repeatedly for the whole dispatch window — never claims it.
    await makeBroker().waitForCommand('agent-1', 120, undefined, '0.3.1');
    await makeBroker().waitForCommand('agent-1', 120, undefined, undefined); // versionless poller = also gated out
    await expect(pending).rejects.toThrow('iMessage agent did not respond within 300ms');
  });

  it('agentVersionAtLeast compares semver-ish strings', async () => {
    const { agentVersionAtLeast } = await import('./agent-link');
    expect(agentVersionAtLeast('0.3.2', '0.3.2')).toBe(true);
    expect(agentVersionAtLeast('0.3.10', '0.3.2')).toBe(true);
    expect(agentVersionAtLeast('0.3.1', '0.3.2')).toBe(false);
    expect(agentVersionAtLeast(undefined, '0.3.2')).toBe(false);
    expect(agentVersionAtLeast('garbage', '0.3.2')).toBe(false);
  });
});

describe('capability-gated claiming (W1 multi-device — a Windows box and a Mac coexist)', () => {
  it('a capability-tagged command is skipped by a poller lacking it and left queued', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'computer_screenshot', {}, 2000, { capability: 'computer' });
    pending.catch(() => {});

    // A browser-only agent polls — must NOT get the computer command.
    const browserOnly = await makeBroker().waitForCommand('agent-1', 60, undefined, undefined, ['browser']);
    expect(browserOnly).toBeNull();
    // …and the command is still queued (requeued at the head, not eaten).
    expect(lists.get(CMD_KEY('agent-1')) ?? []).toHaveLength(1);

    // The capable agent polls next — it claims and answers; dispatch resolves.
    const cmd = await makeBroker().waitForCommand('agent-1', 500, undefined, undefined, ['browser', 'computer']);
    expect(cmd?.method).toBe('computer_screenshot');
    expect((cmd as any).capability).toBe('computer'); // wire field visible to the agent (ignored there)
    await broker.deliverResult(cmd!.cmdId, true, { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('a poller with NO advertisement claims capability-tagged commands (legacy Mac back-compat)', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'browser_navigate', {}, 2000, { capability: 'browser' });
    pending.catch(() => {});
    // Every pre-W0 Mac polls with no version and no capabilities — it claims.
    const cmd = await makeBroker().waitForCommand('agent-1', 500);
    expect(cmd?.method).toBe('browser_navigate');
    await broker.deliverResult(cmd!.cmdId, true, { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it('an EMPTY advertisement also claims everything (an empty set is not an advertisement)', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'list_chats', {}, 2000, { capability: 'imessage' });
    pending.catch(() => {});
    const cmd = await makeBroker().waitForCommand('agent-1', 500, undefined, undefined, []);
    expect(cmd?.method).toBe('list_chats');
    await broker.deliverResult(cmd!.cmdId, true, { chats: [] });
    await expect(pending).resolves.toEqual({ chats: [] });
  });

  it('untagged commands are always claimable regardless of the advertisement', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'ping', {}, 2000);
    pending.catch(() => {});
    const cmd = await makeBroker().waitForCommand('agent-1', 500, undefined, undefined, ['computer']);
    expect(cmd?.method).toBe('ping');
    await broker.deliverResult(cmd!.cmdId, true, { pong: true });
    await expect(pending).resolves.toEqual({ pong: true });
  });

  it('a capability-tagged command times out cleanly when ONLY incapable pollers poll', async () => {
    const broker = makeBroker();
    const pending = broker.dispatch('agent-1', 'send_message', {}, 300, { capability: 'imessage' });
    pending.catch(() => {});
    // A Windows agent (browser+computer, no iMessage) polls the whole window — never claims.
    await makeBroker().waitForCommand('agent-1', 120, undefined, undefined, ['browser', 'computer']);
    await expect(pending).rejects.toThrow('iMessage agent did not respond within 300ms');
  });
});
