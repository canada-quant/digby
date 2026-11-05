/**
 * formatOrganizer — feedback 39c0cd3f.
 *
 * The Digby home-page calendar parser (backend calendar-events.parser.ts) keys
 * its cross-account dedup off an EMAIL found in the Organizer line. The old
 * rendering emitted `displayName || email` — when a Workspace organizer had a
 * Google display name set ("Felipe"), the email was LOST and the organizer-aware
 * dedup silently fell back to first-occurrence. The emitter must now keep the
 * email in the line: "Felipe <felipe@example.com>".
 */

import { describe, expect, it } from 'vitest';
import { formatOrganizer } from './calendar.js';

describe('formatOrganizer', () => {
  it('emits "Name <email>" when both displayName and email exist', () => {
    expect(formatOrganizer({ displayName: 'Felipe', email: 'example-user@example.com' }))
      .toBe('Felipe <example-user@example.com>');
  });

  it('keeps the email parseable by the backend extractEmail regex', () => {
    // Mirror of backend calendar-events.parser.ts extractEmail — the contract.
    const line = formatOrganizer({ displayName: 'Felipe', email: 'example-user@example.com' });
    const m = line.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    expect(m?.[0]).toBe('example-user@example.com');
  });

  it('falls back to the bare email when no displayName is set', () => {
    expect(formatOrganizer({ email: 'example-user@example.com' })).toBe('example-user@example.com');
  });

  it('falls back to the bare name when no email exists', () => {
    expect(formatOrganizer({ displayName: 'Felipe' })).toBe('Felipe');
  });

  it('does not duplicate the email when displayName IS the email', () => {
    expect(formatOrganizer({ displayName: 'example-user@example.com', email: 'example-user@example.com' }))
      .toBe('example-user@example.com');
  });

  it('returns an empty string for a missing/empty organizer', () => {
    expect(formatOrganizer(undefined)).toBe('');
    expect(formatOrganizer(null)).toBe('');
    expect(formatOrganizer({})).toBe('');
  });

  it('trims surrounding whitespace from name and email', () => {
    expect(formatOrganizer({ displayName: '  Felipe  ', email: ' example-user@example.com ' }))
      .toBe('Felipe <example-user@example.com>');
  });
});
