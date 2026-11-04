/**
 * Ticket 1ab949bc — feedback-row timestamps. Node-env vitest idiom (no jsdom):
 * pure helpers asserted directly; the presentational component via
 * renderToStaticMarkup with locale/timeZone pinned for determinism.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  formatFeedbackStamp,
  shouldShowUpdatedStamp,
  RequestTimestamps,
  UPDATED_STAMP_MIN_DELTA_MS,
} from './feedback-timestamps';

const FILED = '2026-09-01T14:38:45.154Z';

describe('formatFeedbackStamp', () => {
  it('renders date AND time (the pre-ticket UI showed a bare date)', () => {
    const s = formatFeedbackStamp(FILED, 'en-US', 'UTC');
    expect(s).toBe('Sep 1, 2026, 2:38 PM');
  });

  it('returns empty string for unparseable input (never "Invalid Date")', () => {
    expect(formatFeedbackStamp('not-a-date', 'en-US', 'UTC')).toBe('');
    expect(formatFeedbackStamp('', 'en-US', 'UTC')).toBe('');
  });
});

describe('shouldShowUpdatedStamp', () => {
  it('is false when updatedAt is missing', () => {
    expect(shouldShowUpdatedStamp(FILED, undefined)).toBe(false);
    expect(shouldShowUpdatedStamp(FILED, null)).toBe(false);
  });

  it('is false when updatedAt equals createdAt (never updated)', () => {
    expect(shouldShowUpdatedStamp(FILED, FILED)).toBe(false);
  });

  it('is false within the creation-lag window and true beyond it', () => {
    const justAfter = new Date(Date.parse(FILED) + 30_000).toISOString();
    const later = new Date(Date.parse(FILED) + UPDATED_STAMP_MIN_DELTA_MS + 1_000).toISOString();
    expect(shouldShowUpdatedStamp(FILED, justAfter)).toBe(false);
    expect(shouldShowUpdatedStamp(FILED, later)).toBe(true);
  });

  it('is false on unparseable timestamps', () => {
    expect(shouldShowUpdatedStamp('garbage', FILED)).toBe(false);
    expect(shouldShowUpdatedStamp(FILED, 'garbage')).toBe(false);
  });
});

describe('RequestTimestamps', () => {
  it('always shows the filed stamp with date + time', () => {
    const html = renderToStaticMarkup(
      createElement(RequestTimestamps, { createdAt: FILED, locale: 'en-US', timeZone: 'UTC' }),
    );
    expect(html).toContain('Filed Sep 1, 2026, 2:38 PM');
    expect(html).toContain(`title="Filed ${FILED}"`);
    expect(html).not.toContain('Updated');
  });

  it('adds the updated stamp once the row has moved (status flip / reply / sighting)', () => {
    const updated = '2026-09-01T16:15:00.000Z';
    const html = renderToStaticMarkup(
      createElement(RequestTimestamps, { createdAt: FILED, updatedAt: updated, locale: 'en-US', timeZone: 'UTC' }),
    );
    expect(html).toContain('Filed Sep 1, 2026, 2:38 PM');
    expect(html).toContain('Updated Sep 1, 2026, 4:15 PM');
    expect(html).toContain(`title="Updated ${updated}"`);
  });
});
