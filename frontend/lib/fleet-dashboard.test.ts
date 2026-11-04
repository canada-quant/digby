/**
 * Tests for lib/fleet-dashboard.ts — the pure helpers behind the Management
 * Dashboard's Goals board and lane enrichment (Fleet Supervisor UX goal
 * 49dd1b20).
 *
 * The load-bearing pieces: extractWorkRefs must surface PR/ticket badges
 * without false-positiving on ordinary prose (lowercase-hex-exactly-8 only),
 * and goalBoardBuckets must sort BLOCKED goals above active ones — the board
 * is an attention surface, same doctrine as the Fleet panel's chat ordering.
 */

import { describe, it, expect } from 'vitest';
import {
  assigneeLabel,
  extractWorkRefs,
  goalBoardBuckets,
  todoProgress,
} from './fleet-dashboard';

describe('extractWorkRefs', () => {
  it('extracts PR refs and ticket id prefixes from a mixed title', () => {
    expect(extractWorkRefs('Fix login #523, ticket 85f8d318 follow-up')).toEqual({
      prs: ['#523'],
      tickets: ['85f8d318'],
    });
  });

  it('collects multiple refs of each kind in first-seen order', () => {
    expect(extractWorkRefs('#12 then #9 — lanes 1ca12570 and c0e22e36')).toEqual({
      prs: ['#12', '#9'],
      tickets: ['1ca12570', 'c0e22e36'],
    });
  });

  it('dedupes repeated refs', () => {
    expect(extractWorkRefs('#523 reopened — see #523 again (85f8d318, was 85f8d318)')).toEqual({
      prs: ['#523'],
      tickets: ['85f8d318'],
    });
  });

  it('caps each kind at 3', () => {
    const { prs, tickets } = extractWorkRefs(
      '#1 #2 #3 #4 #5 — aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee',
    );
    expect(prs).toEqual(['#1', '#2', '#3']);
    expect(tickets).toEqual(['aaaaaaaa', 'bbbbbbbb', 'cccccccc']);
  });

  it('returns empty arrays when the title has no refs', () => {
    expect(extractWorkRefs('Weekly digest rollup')).toEqual({ prs: [], tickets: [] });
  });

  it('does NOT false-positive on non-hex words', () => {
    // 'decision'/'deadbeefed' hold non-hex letters; 'deadbeef' alone WOULD be
    // a valid hex prefix, so these must stay clear of exactly-8 hex runs.
    expect(extractWorkRefs('decision making, not a ticket')).toEqual({ prs: [], tickets: [] });
  });

  it('rejects uppercase hex, short runs, and longer hex runs', () => {
    expect(extractWorkRefs('DEADBEEF deadbee deadbeef9')).toEqual({ prs: [], tickets: [] });
  });

  it('matches an 8-hex prefix inside a UUID-shaped fragment', () => {
    expect(extractWorkRefs('session 1ca12570-0921-4a94 done')).toEqual({
      prs: [],
      tickets: ['1ca12570'],
    });
  });
});

describe('goalBoardBuckets', () => {
  const goal = (status: string, updatedAt: string, title = status) => ({ status, updatedAt, title });

  it('puts blocked goals FIRST, then active, each by updatedAt desc', () => {
    const { live } = goalBoardBuckets([
      goal('active', '2026-08-30T02:00:00Z', 'active-new'),
      goal('blocked', '2026-08-30T01:00:00Z', 'blocked-old'),
      goal('active', '2026-08-30T03:00:00Z', 'active-newer'),
      goal('blocked', '2026-08-30T04:00:00Z', 'blocked-new'),
    ]);
    expect(live.map((g) => g.title)).toEqual([
      'blocked-new', 'blocked-old', 'active-newer', 'active-new',
    ]);
  });

  it('buckets done + archived as finished, updatedAt desc', () => {
    const { finished } = goalBoardBuckets([
      goal('done', '2026-08-29T01:00:00Z', 'done-old'),
      goal('active', '2026-08-30T01:00:00Z'),
      goal('archived', '2026-08-29T02:00:00Z', 'arch-new'),
    ]);
    expect(finished.map((g) => g.title)).toEqual(['arch-new', 'done-old']);
  });

  it('sorts absent/garbage updatedAt oldest within a group', () => {
    const { live } = goalBoardBuckets([
      { status: 'active', title: 'no-date' },
      { status: 'active', updatedAt: 'not-a-date', title: 'garbage' },
      { status: 'active', updatedAt: '2026-08-30T01:00:00Z', title: 'dated' },
    ]);
    expect(live[0].title).toBe('dated');
  });

  it('does NOT mutate the input array', () => {
    const input = [
      goal('active', '2026-08-30T01:00:00Z'),
      goal('blocked', '2026-08-29T01:00:00Z'),
    ];
    const snapshot = [...input];
    goalBoardBuckets(input);
    expect(input).toEqual(snapshot);
  });
});

describe('todoProgress', () => {
  it('returns 0/0 for a goal with no todos (never NaN)', () => {
    expect(todoProgress({ todos: [] })).toEqual({ done: 0, total: 0 });
    expect(todoProgress({})).toEqual({ done: 0, total: 0 });
  });

  it('counts only done todos', () => {
    expect(
      todoProgress({
        todos: [
          { status: 'done' },
          { status: 'done' },
          { status: 'in_progress' },
          { status: 'blocked' },
          { status: 'pending' },
        ],
      }),
    ).toEqual({ done: 2, total: 5 });
  });
});

describe('assigneeLabel', () => {
  const titles = new Map([['c9-chat-id-0001', 'Worker lane']]);

  it('is an em dash when the todo is unassigned', () => {
    expect(assigneeLabel({ assigneeChatId: null }, titles)).toBe('—');
    expect(assigneeLabel({}, titles)).toBe('—');
  });

  it('resolves the chat title when the map knows the id', () => {
    expect(assigneeLabel({ assigneeChatId: 'c9-chat-id-0001' }, titles)).toBe('Worker lane');
  });

  it('falls back to a short "chat <prefix>" label for unknown ids', () => {
    expect(assigneeLabel({ assigneeChatId: '85f8d318-dead-beef' }, titles)).toBe('chat 85f8d318');
  });
});
