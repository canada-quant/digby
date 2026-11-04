/**
 * localizeUtcTimes (owner 2026-09-14: supervisor updates in the viewer's local
 * time). Zone + locale + "now" are injected so the pins are deterministic on
 * any CI machine; Toronto (UTC-4 in September) is the owner's zone.
 */
import { describe, it, expect } from 'vitest';
import { localizeUtcTimes, hasUtcClock, formatLocalStamp } from './localize-utc-times';

const TORONTO = { locale: 'en-US', timeZone: 'America/Toronto', now: new Date('2026-09-14T15:30:00Z') };
const TOKYO = { locale: 'en-US', timeZone: 'Asia/Tokyo', now: new Date('2026-09-14T15:30:00Z') };

describe('localizeUtcTimes — zoned clocks inside supervisor text', () => {
  it('rewrites the wake-note clock to the viewer\'s zone (14:41Z → 10:41 AM in Toronto)', () => {
    expect(localizeUtcTimes('Live snapshot as of 14:41Z — nothing moved.', TORONTO)).toBe('Live snapshot as of 10:41 AM — nothing moved.');
    expect(localizeUtcTimes('WAKE — 03:43Z. No-op; chain still gated.', TORONTO)).toBe('WAKE — 11:43 PM. No-op; chain still gated.'.replace('11:43 PM', 'Sep 13, 11:43 PM'));
  });

  it('handles seconds and the UTC suffix; single-digit hours', () => {
    expect(localizeUtcTimes('(harness clock 13:44:05Z)', TORONTO)).toBe('(harness clock 9:44 AM)');
    expect(localizeUtcTimes('deploy landed at 14:32 UTC', TORONTO)).toBe('deploy landed at 10:32 AM');
    expect(localizeUtcTimes('sweep at 7:05Z', TORONTO)).toBe('sweep at 3:05 AM');
  });

  it('rewrites ISO stamps, adding the date only when it is not the viewer\'s today', () => {
    expect(localizeUtcTimes('[MACHINE-TRIGGERED RUN at 2026-09-14T14:41:21Z]', TORONTO)).toBe('[MACHINE-TRIGGERED RUN at 10:41 AM]');
    expect(localizeUtcTimes('verified-at 2026-09-13T20:14:25.705Z', TORONTO)).toBe('verified-at Sep 13, 4:14 PM');
    expect(localizeUtcTimes('due 2025-12-31T23:59:00Z', TORONTO)).toBe('due Dec 31, 2025, 6:59 PM');
    expect(localizeUtcTimes('offset form 2026-09-14T16:41:21+02:00', TORONTO)).toBe('offset form 10:41 AM');
  });

  it('a bare clock that lands on another local day than its anchor carries the date (Tokyo reads 23:30Z the next morning)', () => {
    // Anchor row at 10:00Z = 19:00 Tokyo on Sep 14; "23:30Z" that day is 08:30 Tokyo on Sep 15.
    const anchor = '2026-09-14T10:00:00Z';
    expect(localizeUtcTimes('closed at 23:30Z', { ...TOKYO, anchor })).toBe('closed at Sep 15, 8:30 AM');
    // Same local day → no date.
    expect(localizeUtcTimes('closed at 14:30Z', { ...TOKYO, anchor })).toBe('closed at 11:30 PM');
  });

  it('uses the anchor day for bare clocks (a yesterday row keeps yesterday\'s date on a day change)', () => {
    // Anchor Sep 13 (viewer\'s today is Sep 14): 03:43Z on Sep 13 is Sep 12 23:43 Toronto — a different local day than the anchor.
    expect(localizeUtcTimes('WAKE — 03:43Z', { ...TORONTO, anchor: '2026-09-13T04:00:00Z' })).toBe('WAKE — Sep 12, 11:43 PM');
  });

  it('leaves unzoned clocks, impossible clocks, words and code alone', () => {
    expect(localizeUtcTimes('meeting at 14:41 tomorrow', TORONTO)).toBe('meeting at 14:41 tomorrow');
    expect(localizeUtcTimes('bogus 25:00Z and 12:75Z', TORONTO)).toBe('bogus 25:00Z and 12:75Z');
    expect(localizeUtcTimes('Zoom link; UTC+2 offset; ZUTC', TORONTO)).toBe('Zoom link; UTC+2 offset; ZUTC');
    expect(localizeUtcTimes('run `date -u` → `14:41Z`', TORONTO)).toBe('run `date -u` → `14:41Z`');
    expect(localizeUtcTimes('```\nat 14:41Z\n```\nprose at 14:41Z', TORONTO)).toBe('```\nat 14:41Z\n```\nprose at 10:41 AM');
  });

  it('is total on empty input and never throws on garbage', () => {
    expect(localizeUtcTimes('', TORONTO)).toBe('');
    expect(localizeUtcTimes(undefined as unknown as string, TORONTO)).toBe('');
    expect(localizeUtcTimes('14:41Z', { ...TORONTO, anchor: 'not-a-date' })).toBe('10:41 AM');
  });

  it('hasUtcClock detects rewritable tokens outside code only', () => {
    expect(hasUtcClock('as of 14:41Z')).toBe(true);
    expect(hasUtcClock('at 2026-09-14T14:41:21Z')).toBe(true);
    expect(hasUtcClock('at 14:41 tomorrow')).toBe(false);
    expect(hasUtcClock('`14:41Z`')).toBe(false);
    expect(hasUtcClock('')).toBe(false);
  });

  it('formatLocalStamp mirrors formatMessageTime (time today, date otherwise)', () => {
    expect(formatLocalStamp(new Date('2026-09-14T14:41:00Z'), TORONTO)).toBe('10:41 AM');
    expect(formatLocalStamp(new Date('2026-09-10T14:41:00Z'), TORONTO)).toBe('Sep 10, 10:41 AM');
  });
});
