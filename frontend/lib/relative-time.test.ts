/**
 * lib/relative-time — the ONE relative-time module (UI overhaul Phase 4).
 * Compact ages are pinned exactly (injectable now); long-form goes through
 * date-fns so we assert shape against real offsets from Date.now().
 */
import { describe, it, expect } from 'vitest';
import { absoluteDate, relativeTime, relativeTimeLong } from './relative-time';

const NOW = Date.parse('2026-09-07T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeTime (compact)', () => {
  it('em-dashes missing/invalid input', () => {
    expect(relativeTime(null, NOW)).toBe('—');
    expect(relativeTime(undefined, NOW)).toBe('—');
    expect(relativeTime('', NOW)).toBe('—');
    expect(relativeTime('not-a-date', NOW)).toBe('—');
  });

  it('keeps sub-minute direction (a schedule firing in 30s is NOT "just now")', () => {
    expect(relativeTime(at(30_000), NOW)).toBe('in <1 min');
    expect(relativeTime(at(-30_000), NOW)).toBe('just now');
  });

  it('renders compact past ages: minutes / hours / days', () => {
    expect(relativeTime(at(-3 * MIN), NOW)).toBe('3m ago');
    expect(relativeTime(at(-2 * HOUR), NOW)).toBe('2h ago');
    expect(relativeTime(at(-5 * DAY), NOW)).toBe('5d ago');
  });

  it('renders compact future times for schedule nextRunAt', () => {
    expect(relativeTime(at(5 * MIN), NOW)).toBe('in 5m');
    expect(relativeTime(at(3 * HOUR), NOW)).toBe('in 3h');
    expect(relativeTime(at(2 * DAY), NOW)).toBe('in 2d');
  });

  it('falls back to an absolute locale date at ≥30 days', () => {
    const old = at(-31 * DAY);
    expect(relativeTime(old, NOW)).toBe(new Date(old).toLocaleDateString());
    expect(relativeTime(at(-29 * DAY), NOW)).toBe('29d ago');
  });
});

describe('relativeTimeLong (date-fns long form)', () => {
  it('returns empty string for missing/invalid input (callers render directly)', () => {
    expect(relativeTimeLong(null)).toBe('');
    expect(relativeTimeLong(undefined)).toBe('');
    expect(relativeTimeLong('')).toBe('');
    expect(relativeTimeLong('not-a-date')).toBe('');
  });

  it('renders suffixed long-form ages (real now — offsets, not pinned strings)', () => {
    expect(relativeTimeLong(new Date(Date.now() - 3 * MIN))).toBe('3 minutes ago');
    expect(relativeTimeLong(new Date(Date.now() - 2 * DAY).toISOString())).toBe('2 days ago');
    // Future dates keep date-fns's "in …" phrasing.
    expect(relativeTimeLong(new Date(Date.now() + 10 * MIN))).toMatch(/^in /);
  });

  it('accepts both Date and ISO string', () => {
    const d = new Date(Date.now() - 5 * MIN);
    expect(relativeTimeLong(d)).toBe(relativeTimeLong(d.toISOString()));
  });
});

describe('absoluteDate', () => {
  const ISO = '2026-03-05T10:30:00.000Z';

  it('returns empty string for missing/invalid input (never "Invalid Date")', () => {
    expect(absoluteDate(null)).toBe('');
    expect(absoluteDate(undefined)).toBe('');
    expect(absoluteDate('')).toBe('');
    expect(absoluteDate('not-a-date')).toBe('');
  });

  it('numeric (default) matches the plain toLocaleDateString() it replaced', () => {
    expect(absoluteDate(ISO)).toBe(new Date(ISO).toLocaleDateString());
  });

  it('medium matches the CanvasPanel file-date format it replaced', () => {
    expect(absoluteDate(ISO, 'medium')).toBe(
      new Date(ISO).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    );
  });

  it('monthDay matches the admin ticket-date format it replaced', () => {
    expect(absoluteDate(ISO, 'monthDay')).toBe(
      new Date(ISO).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
  });
});
