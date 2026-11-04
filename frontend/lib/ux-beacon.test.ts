/**
 * lib/ux-beacon.ts — the client perceived-latency beacon (audit 2026-09-26
 * guest-persistence-4: the server route had no sender). Pins the body shape
 * the server's zod schema accepts, the sendBeacon → fetch(keepalive) fallback,
 * the guest session key and the build-time kill switch.
 */
import { describe, it, expect, vi } from 'vitest';
import { sendUxBeacon, uxBeaconBody, UX_BEACON_PATH } from './ux-beacon';

const CHAT = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';

describe('uxBeaconBody', () => {
  it('keeps only valid uuids, integer ms ≥ 0 (capped at 24 h), bounded mode / target', () => {
    expect(uxBeaconBody({ event: 'first_paint', chatId: CHAT, messageId: MSG, sessionId: SID, ms: 1234.6, mode: 'thinking' }))
      .toEqual({ event: 'first_paint', chatId: CHAT, messageId: MSG, sessionId: SID, ms: 1235, mode: 'thinking' });
    expect(uxBeaconBody({ event: 'tap', chatId: 'nope', messageId: 'tmp-1', ms: -5, target: 'escalate' })).toEqual({ event: 'tap', target: 'escalate' });
    expect(uxBeaconBody({ event: 'abandon', ms: 10 ** 12 }).ms).toBe(24 * 60 * 60 * 1000);
    expect(uxBeaconBody({ event: 'chip_seen', mode: 'x'.repeat(40) }).mode).toHaveLength(32);
  });
});

describe('sendUxBeacon', () => {
  it('prefers navigator.sendBeacon with a JSON blob at the beacon path; a guest carries its session uuid', () => {
    const sendBeacon = vi.fn(() => true);
    const fetch = vi.fn(async () => ({}));
    expect(sendUxBeacon({ event: 'tap', target: 'signin_deeper', sessionId: SID }, { sendBeacon, fetch })).toBe(true);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect((sendBeacon.mock.calls[0] as any[])[0]).toBe(UX_BEACON_PATH);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('falls back to fetch(keepalive) when sendBeacon is missing or refuses; never throws', async () => {
    const fetch = vi.fn(async () => ({}));
    expect(sendUxBeacon({ event: 'first_paint', chatId: CHAT, ms: 900 }, { sendBeacon: () => false, fetch })).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as any[];
    expect(url).toBe(UX_BEACON_PATH);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'include' });
    expect(JSON.parse(init.body)).toEqual({ event: 'first_paint', chatId: CHAT, ms: 900 });
    expect(sendUxBeacon({ event: 'abandon' }, { sendBeacon: () => { throw new Error('x'); }, fetch: () => { throw new Error('y'); } })).toBe(false);
    expect(sendUxBeacon({ event: 'abandon' }, { fetch: async () => { throw new Error('later'); } })).toBe(true);
  });
});

describe('stream drops (2026-10-20): stream_drop / stream_resume fields', () => {
  it('keeps integer attempts (capped), a lowercase-slug outcome and the guest flag; drops junk', () => {
    expect(uxBeaconBody({ event: 'stream_drop', sessionId: SID, ms: 4200, attempts: 3.7, outcome: 'retrying', guest: true }))
      .toEqual({ event: 'stream_drop', sessionId: SID, ms: 4200, attempts: 3, outcome: 'retrying', guest: true });
    expect(uxBeaconBody({ event: 'stream_resume', attempts: -1, outcome: 'Resumed!', guest: undefined }))
      .toEqual({ event: 'stream_resume' });
    expect(uxBeaconBody({ event: 'stream_resume', attempts: 10 ** 9 }).attempts).toBe(10_000);
    expect(uxBeaconBody({ event: 'stream_resume', outcome: 'x'.repeat(33) })).not.toHaveProperty('outcome');
  });
});
