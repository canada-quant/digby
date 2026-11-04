import { describe, it, expect } from 'vitest';
import {
  buildNewsAskContext,
  displayPublishedLabel,
  publishedLabelAgeDays,
  publishedLabelIsDated,
} from './news-ask-context';

// 2026-10-27 12:00 local — relative labels resolve against the passed `now`.
const NOW = new Date(2026, 9, 27, 12, 0, 0);
const DAY_MS = 86_400_000;

describe('displayPublishedLabel (ticket 94b93132)', () => {
  it('keeps a real label verbatim', () => {
    expect(displayPublishedLabel('3 hours ago')).toBe('3 hours ago');
    expect(displayPublishedLabel(' Oct 28, 2021 ')).toBe('Oct 28, 2021');
  });

  it('collapses useless non-dates and missing fields to ""', () => {
    for (const junk of ['unknown', 'n/a', '', '   ', 'no date']) {
      expect(displayPublishedLabel(junk)).toBe('');
    }
    expect(displayPublishedLabel(undefined)).toBe('');
  });
});

describe('publishedLabelAgeDays (ticket 94b93132)', () => {
  it('resolves relative ages against now', () => {
    expect(publishedLabelAgeDays('3 hours ago', NOW)).toBeCloseTo(0.125, 6);
    expect(publishedLabelAgeDays('2 days ago', NOW)).toBe(2);
    expect(publishedLabelAgeDays('3 weeks ago', NOW)).toBe(21);
  });

  it('resolves freshness words', () => {
    expect(publishedLabelAgeDays('today', NOW)).toBe(0);
    expect(publishedLabelAgeDays('yesterday', NOW)).toBe(1);
  });

  it('resolves the ticket\u2019s US date ("Oct 28, 2021" read on 2026-10-27) to ~5 years old', () => {
    const age = publishedLabelAgeDays('Oct 28, 2021', NOW) as number;
    expect(age).toBeGreaterThan(1800);
  });

  it('resolves day-first and ISO dates', () => {
    // Calendar-day age (the label parses to midnight, so the age is whole days)
    const expected = Math.floor((NOW.getTime() - new Date(2021, 9, 28).getTime()) / DAY_MS);
    expect(publishedLabelAgeDays('28 Oct 2021', NOW)).toBeCloseTo(expected, 6);
    expect(publishedLabelAgeDays('2021-10-28', NOW)).toBeCloseTo(expected, 6);
  });

  it('returns null on ambiguous numeric labels — they display, they cannot age', () => {
    expect(publishedLabelAgeDays('10/28', NOW)).toBeNull();
  });
});

describe('publishedLabelIsDated (ticket 94b93132)', () => {
  it('true for a real date/age label, false for undated items', () => {
    expect(publishedLabelIsDated('3 hours ago')).toBe(true);
    expect(publishedLabelIsDated('Oct 28, 2021')).toBe(true);
    expect(publishedLabelIsDated('')).toBe(false);
    expect(publishedLabelIsDated('unknown')).toBe(false);
  });
});

describe('buildNewsAskContext — the injected block (ticket 94b93132)', () => {
  const headline = 'Wind and Waste Water Hazards at Shorelines in Oak Bay';
  const summary = 'Heavy rains have caused contamination in runoff affecting Oak Bay and Esquimalt.';

  it('attaches the publication date to the item — the ticket\u2019s acceptance', () => {
    const got = buildNewsAskContext('Tell me more about this story', {
      headline, summary, published: 'Oct 28, 2021',
    });
    expect(got).toContain('(published Oct 28, 2021)');
    // The old dishonest "today's news" header is gone
    expect(got).not.toContain("today's news");
    expect(got).toContain('Context from the news (publication dates shown):');
    expect(got).toContain(`"${headline}"`);
  });

  it('keeps relative labels verbatim ("3 hours ago")', () => {
    const got = buildNewsAskContext('What happened?', { headline, summary, published: '3 hours ago' });
    expect(got).toContain('(published 3 hours ago)');
  });

  it('undated item: honest header, NO fabricated date anywhere', () => {
    const got = buildNewsAskContext('What happened?', { headline, summary, published: '' });
    expect(got).toContain('Context from the news (dates not shown by the sources):');
    expect(got).not.toContain('(published');
    expect(got).not.toContain("today's news");
    expect(got).toContain(`"${headline}" — ${summary}`);
  });

  it('legacy briefing (published field missing entirely) renders undated, not "today"', () => {
    const got = buildNewsAskContext('What happened?', { headline, summary });
    expect(got).toContain('dates not shown by the sources');
    expect(got).not.toContain("today's news");
  });

  it('keeps the question first so the user\u2019s ask stays the message head', () => {
    const got = buildNewsAskContext('Tell me more about this story', { headline, summary, published: '2 days ago' });
    expect(got.startsWith('Tell me more about this story\n\n')).toBe(true);
  });
});
