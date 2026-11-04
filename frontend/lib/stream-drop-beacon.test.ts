/**
 * lib/stream-drop-beacon.ts — one drop → recovery episode = at most ONE
 * `stream_drop` + ONE `stream_resume` beacon (stream drops, 2026-10-20). Pins
 * the episode rule (retries of the same drop send nothing), the page cap, the
 * payload (attempts / ms since send / guest / outcome — never text), reset on a
 * new send, and the build-time kill switch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStreamDropTracker, streamDropBeaconDisabled, STREAM_BEACON_PAGE_CAP } from './stream-drop-beacon';

const SID = '33333333-3333-4333-8333-333333333333';
const ctx = (over: Record<string, unknown> = {}) => ({ chatId: null, sessionId: SID, guest: true, mode: 'auto', attempts: 0, msSinceSend: 12_000, ...over });

afterEach(() => { delete process.env.NEXT_PUBLIC_STREAM_DROP_BEACON_DISABLED; });

describe('createStreamDropTracker', () => {
  it('sends ONE stream_drop per episode however many retries it takes, then ONE stream_resume', () => {
    const send = vi.fn(() => true);
    const t = createStreamDropTracker({ send });
    expect(t.drop(ctx(), 'retrying')).toBe(true);
    expect(t.drop(ctx({ attempts: 1 }), 'retrying')).toBe(false);
    expect(t.drop(ctx({ attempts: 2 }), 'retrying')).toBe(false);
    expect(t.episodeOpen).toBe(true);
    expect(t.resume(ctx({ attempts: 3 }), 'resumed')).toBe(true);
    expect(t.resume(ctx(), 'resumed')).toBe(false); // nothing open any more
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0] as any[])[0]).toEqual({ event: 'stream_drop', sessionId: SID, mode: 'auto', ms: 12_000, attempts: 0, guest: true, outcome: 'retrying' });
    expect((send.mock.calls[1] as any[])[0]).toMatchObject({ event: 'stream_resume', attempts: 3, outcome: 'resumed' });
  });

  it('a resume with no open episode (a plain focus resync) sends nothing', () => {
    const send = vi.fn(() => true);
    expect(createStreamDropTracker({ send }).resume(ctx(), 'ended')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('reset() (a new send) forgets an open episode without a beacon — the next drop is a new episode', () => {
    const send = vi.fn(() => true);
    const t = createStreamDropTracker({ send });
    t.drop(ctx(), 'resend');
    t.reset();
    expect(t.episodeOpen).toBe(false);
    expect(t.drop(ctx(), 'retrying')).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a flapping page is capped at STREAM_BEACON_PAGE_CAP beacons', () => {
    const send = vi.fn(() => true);
    const t = createStreamDropTracker({ send });
    for (let i = 0; i < STREAM_BEACON_PAGE_CAP * 2; i++) { t.drop(ctx(), 'retrying'); t.resume(ctx(), 'resumed'); }
    expect(send).toHaveBeenCalledTimes(STREAM_BEACON_PAGE_CAP);
  });

  it('signed-in chats carry the chat id and guest:false; a missing send time sends no ms', () => {
    const send = vi.fn(() => true);
    createStreamDropTracker({ send }).drop({ chatId: 'c1', guest: false, attempts: 1 }, 'retrying');
    expect((send.mock.calls[0] as any[])[0]).toEqual({ event: 'stream_drop', chatId: 'c1', attempts: 1, guest: false, outcome: 'retrying' });
  });

  it('a throwing transport never throws into the view', () => {
    const t = createStreamDropTracker({ send: () => { throw new Error('x'); } });
    expect(t.drop(ctx(), 'retrying')).toBe(false);
  });

  it('NEXT_PUBLIC_STREAM_DROP_BEACON_DISABLED=1 sends nothing (the episode bookkeeping still runs)', () => {
    process.env.NEXT_PUBLIC_STREAM_DROP_BEACON_DISABLED = '1';
    expect(streamDropBeaconDisabled()).toBe(true);
    const send = vi.fn(() => true);
    const t = createStreamDropTracker({ send });
    expect(t.drop(ctx(), 'retrying')).toBe(false);
    expect(t.resume(ctx(), 'resumed')).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
