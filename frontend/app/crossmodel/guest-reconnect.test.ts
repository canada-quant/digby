/**
 * guest-reconnect.ts — the pure half of the guest stream reconnect (stream
 * drops, 2026-10-20). Pins who may reconnect (a chatless GUEST with a uuid
 * session id only), the attach URL (the uuid is the key — no token), the shared
 * backoff (the exact signed-in schedule) and the two build-time switches.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { buildGuestAttachUrl, guestReconnectSessionId, guestStreamReconnectDisabled, onlineResyncDisabled, reconnectBackoff } from './guest-reconnect';

const SID = '33333333-3333-4333-8333-333333333333';

afterEach(() => {
  delete process.env.NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED;
  delete process.env.NEXT_PUBLIC_ONLINE_RESYNC_DISABLED;
});

describe('guestReconnectSessionId', () => {
  it('a chatless guest with a uuid session id may reconnect', () => {
    expect(guestReconnectSessionId({ guest: true, guestSessionId: SID }, null)).toBe(SID);
  });
  it('never for a signed-in chat, the signed-in chatless fallback, a junk id, or no plain config', () => {
    expect(guestReconnectSessionId({ guest: true, guestSessionId: SID }, 'chat-1')).toBeNull(); // has its own attach
    expect(guestReconnectSessionId({ guest: false, guestSessionId: SID }, null)).toBeNull();
    expect(guestReconnectSessionId({ guest: true }, null)).toBeNull();
    expect(guestReconnectSessionId({ guest: true, guestSessionId: '../x' }, null)).toBeNull();
    expect(guestReconnectSessionId(null, null)).toBeNull();
  });
  it('NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED=1 ⇒ null (the old "send again" dead end)', () => {
    process.env.NEXT_PUBLIC_GUEST_STREAM_RECONNECT_DISABLED = '1';
    expect(guestStreamReconnectDisabled()).toBe(true);
    expect(guestReconnectSessionId({ guest: true, guestSessionId: SID }, null)).toBeNull();
  });
});

describe('buildGuestAttachUrl', () => {
  it('targets /crossmodel/session/:id/stream with a cache-buster and NO token', () => {
    const url = buildGuestAttachUrl(SID, 1234);
    expect(url).toMatch(new RegExp(`/crossmodel/session/${SID}/stream\\?_t=1234$`));
    expect(url).not.toContain('token');
  });
});

describe('reconnectBackoff', () => {
  it('1, 2, 4, 8, 15, 15 s fast retries, then the slow phase every 15 s (the signed-in schedule)', () => {
    expect([0, 1, 2, 3, 4, 5].map(a => reconnectBackoff(a))).toEqual([
      { slow: false, delay: 1000 }, { slow: false, delay: 2000 }, { slow: false, delay: 4000 },
      { slow: false, delay: 8000 }, { slow: false, delay: 15000 }, { slow: false, delay: 15000 },
    ]);
    expect(reconnectBackoff(6)).toEqual({ slow: true, delay: 15000 });
    expect(reconnectBackoff(60)).toEqual({ slow: true, delay: 15000 });
  });
});

describe('onlineResyncDisabled', () => {
  it('reads exactly "1"', () => {
    expect(onlineResyncDisabled()).toBe(false);
    process.env.NEXT_PUBLIC_ONLINE_RESYNC_DISABLED = '1';
    expect(onlineResyncDisabled()).toBe(true);
  });
});
