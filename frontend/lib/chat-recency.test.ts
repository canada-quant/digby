import { describe, expect, it } from 'vitest';
import { chatActivityStamp, groupRowsByRecency, recencyBucket } from './chat-recency';

const NOW = new Date(2026, 9, 6, 15, 0, 0); // Tue Oct 6 2026, 3pm local
const at = (daysAgo: number, hour = 10) => new Date(2026, 9, 6 - daysAgo, hour, 0, 0).toISOString();

describe('recencyBucket', () => {
  it('buckets by local calendar day', () => {
    expect(recencyBucket(at(0, 0), NOW)).toBe('today');
    expect(recencyBucket(at(1, 23), NOW)).toBe('yesterday');
    expect(recencyBucket(at(2), NOW)).toBe('week');
    expect(recencyBucket(at(7), NOW)).toBe('week');
    expect(recencyBucket(at(8), NOW)).toBe('month');
    expect(recencyBucket(at(30), NOW)).toBe('month');
    expect(recencyBucket(at(31), NOW)).toBe('older');
  });

  it('missing / unparseable stamps fall to older; future stamps are today', () => {
    expect(recencyBucket(null, NOW)).toBe('older');
    expect(recencyBucket('not a date', NOW)).toBe('older');
    expect(recencyBucket(new Date(2026, 9, 9).toISOString(), NOW)).toBe('today');
  });
});

describe('chatActivityStamp', () => {
  it('prefers the newest message, then updatedAt, then createdAt', () => {
    expect(chatActivityStamp({ lastMessageAt: 'a', updatedAt: 'b', createdAt: 'c' })).toBe('a');
    expect(chatActivityStamp({ lastMessageAt: null, updatedAt: 'b', createdAt: 'c' })).toBe('b');
    expect(chatActivityStamp({ createdAt: 'c' })).toBe('c');
    expect(chatActivityStamp({})).toBeNull();
  });
});

describe('groupRowsByRecency', () => {
  it('keeps children with their parent and returns sections in fixed order', () => {
    const rows = [
      { id: 'p1', chat: { lastMessageAt: at(0) }, isChild: false },
      // A child whose own stamp is old still rides with its (today) parent.
      { id: 'c1', chat: { lastMessageAt: at(40) }, isChild: true },
      { id: 'p2', chat: { lastMessageAt: at(3) }, isChild: false },
      { id: 'p3', chat: { lastMessageAt: at(0, 1) }, isChild: false },
      { id: 'p4', chat: { updatedAt: at(90) }, isChild: false },
    ];
    const sections = groupRowsByRecency(rows, NOW);
    expect(sections.map((s) => s.label)).toEqual(['Today', 'Previous 7 days', 'Older']);
    expect(sections[0].rows.map((r) => r.id)).toEqual(['p1', 'c1', 'p3']);
    expect(sections[1].rows.map((r) => r.id)).toEqual(['p2']);
    expect(sections[2].rows.map((r) => r.id)).toEqual(['p4']);
  });

  it('empty input → no sections', () => {
    expect(groupRowsByRecency([], NOW)).toEqual([]);
  });
});
