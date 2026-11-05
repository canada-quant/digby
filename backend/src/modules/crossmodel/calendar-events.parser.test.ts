/**
 * Calendar event text parser — home-page calendar card (feedback abeb36a2).
 *
 * The bug: the same event can be listed under SEVERAL connected Google accounts
 * (a shared/subscribed calendar — e.g. a teammate's vacation calendar — is
 * visible to every workspace account), and the cross-account dedup kept the
 * FIRST occurrence's account label. A Work-calendar event surfaced tagged "CQL"
 * purely because CQL's section was queried first. The dedup now prefers the
 * occurrence whose account matches the event ORGANIZER (exact email, then
 * domain), falling back to first-occurrence when there is no organizer signal.
 */

import { parseCalendarEventsText } from './calendar-events.parser';

const twoAccountsSharedEvent = (organizer: string) => `[Google Calendar Events]
--- CQL (paul@cql.example.com) ---
Found 1 event(s):

📅 **Felipe Vacation**
   Start: Fri, Aug 28, 2026, 09:00 AM PDT
   End:   Fri, Aug 28, 2026, 05:00 PM PDT
   Organizer: ${organizer}

--- Work (example-user@example.com) ---
Found 1 event(s):

📅 **Felipe Vacation**
   Start: Fri, Aug 28, 2026, 09:00 AM PDT
   End:   Fri, Aug 28, 2026, 05:00 PM PDT
   Organizer: ${organizer}
`;

describe('parseCalendarEventsText — cross-account dedup label preference', () => {
  it('prefers the account whose email EXACTLY matches the organizer', () => {
    const events = parseCalendarEventsText(twoAccountsSharedEvent('example-user@example.com'));
    expect(events).toHaveLength(1);
    expect(events[0].account).toBe('Work (example-user@example.com)');
  });

  it('prefers the account whose email DOMAIN matches the organizer domain', () => {
    // Organizer example-user@example.com is not either account's email, but the
    // Work account shares the domain — CQL does not.
    const events = parseCalendarEventsText(twoAccountsSharedEvent('example-user@example.com'));
    expect(events).toHaveLength(1);
    expect(events[0].account).toBe('Work (example-user@example.com)');
  });

  it('extracts the email from a "Name <email>" organizer line (google-mcp format, ticket 39c0cd3f)', () => {
    // The MCP now emits Organizer as "Felipe <example-user@example.com>" (display
    // name + email) instead of letting the display name WIN and drop the email.
    // The dedup preference must still key off the email inside that format —
    // before the MCP fix, a named-organizer line had no email and silently fell
    // back to first-occurrence (the original mislabel).
    const events = parseCalendarEventsText(twoAccountsSharedEvent('Felipe <example-user@example.com>'));
    expect(events).toHaveLength(1);
    expect(events[0].account).toBe('Work (example-user@example.com)');
  });

  it('EXACT-matches the account email from a "Name <email>" organizer line (ticket 39c0cd3f)', () => {
    // Strongest path in the preference chain: the organizer email IS one of the
    // connected accounts' emails (not merely a shared domain).
    const events = parseCalendarEventsText(twoAccountsSharedEvent('Paul Sunday <example-user@example.com>'));
    expect(events).toHaveLength(1);
    expect(events[0].account).toBe('Work (example-user@example.com)');
  });

  it('falls back to the first occurrence when the organizer matches nothing', () => {
    const events = parseCalendarEventsText(twoAccountsSharedEvent('someone@unrelated.org'));
    expect(events).toHaveLength(1);
    expect(events[0].account).toBe('CQL (paul@cql.example.com)');
  });

  it('falls back to the first occurrence when no Organizer line is present', () => {
    const text = twoAccountsSharedEvent('x@y.z').replace(/^\s*Organizer:.*$/gm, '');
    const events = parseCalendarEventsText(text);
    expect(events).toHaveLength(1);
    expect(events[0].account).toBe('CQL (paul@cql.example.com)');
  });

  it('strips the internal dedup fields from the public shape', () => {
    const events = parseCalendarEventsText(twoAccountsSharedEvent('example-user@example.com'));
    expect(events[0]).not.toHaveProperty('organizer');
    expect(events[0]).not.toHaveProperty('accountEmail');
  });

  it('matches duplicate keys case-insensitively on title', () => {
    const text = twoAccountsSharedEvent('example-user@example.com').replace(
      '--- Work (example-user@example.com) ---\nFound 1 event(s):\n\n📅 **Felipe Vacation**',
      '--- Work (example-user@example.com) ---\nFound 1 event(s):\n\n📅 **FELIPE VACATION**',
    );
    const events = parseCalendarEventsText(text);
    expect(events).toHaveLength(1);
    expect(events[0].account).toBe('Work (example-user@example.com)');
  });
});

describe('parseCalendarEventsText — baseline parsing (unchanged behavior)', () => {
  it('parses a single event with times, account label, and AI prompts', () => {
    const text = `[Google Calendar Events]
--- Personal (me@example.com) ---
Found 1 event(s):

📅 **Dentist Appointment**
   Start: Fri, Aug 28, 2026, 02:00 PM PDT
   End:   Fri, Aug 28, 2026, 03:00 PM PDT
   📍 123 Main St
   Note: Bring insurance card
`;
    const events = parseCalendarEventsText(text, 'America/Vancouver');
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.title).toBe('Dentist Appointment');
    expect(e.startTime).toBe('02:00 PM');
    expect(e.endTime).toBe('03:00 PM');
    expect(e.account).toBe('Personal (me@example.com)');
    expect(e.location).toBe('123 Main St');
    expect(e.description).toBe('Bring insurance card');
    expect(e.startEpoch).toBeGreaterThan(0);
    expect(Array.isArray(e.aiPrompts)).toBe(true);
  });

  it('keeps distinct events from different accounts (no false dedup)', () => {
    const text = `[Google Calendar Events]
--- CQL (paul@cql.example.com) ---
Found 1 event(s):

📅 **Standup**
   Start: Fri, Aug 28, 2026, 09:00 AM PDT
   End:   Fri, Aug 28, 2026, 09:15 AM PDT

--- Work (example-user@example.com) ---
Found 1 event(s):

📅 **Dentist**
   Start: Fri, Aug 28, 2026, 02:00 PM PDT
   End:   Fri, Aug 28, 2026, 03:00 PM PDT
`;
    const events = parseCalendarEventsText(text);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.account)).toEqual([
      'CQL (paul@cql.example.com)',
      'Work (example-user@example.com)',
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(parseCalendarEventsText('')).toEqual([]);
  });
});
