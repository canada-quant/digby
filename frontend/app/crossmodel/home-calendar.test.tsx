/**
 * Home-screen Today (calendar) card — owner 2026-10-21: "where did the
 * calendar view go from the main homepage chat on a new chat?" It had not
 * been removed: the card rendered ONLY when the calendar was connected AND had
 * at least one event (or was loading). A connected calendar with nothing on
 * today's date, or a failed read that the backend reported as an empty list,
 * rendered nothing at all. These source pins hold the three connected states
 * (events / empty day / error + Retry) and the backend's honest error field.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGE = src('./page.tsx');

describe('home Today card never vanishes while the calendar is connected', () => {
  it('renders an empty-day line when connected with no events', () => {
    expect(PAGE).toContain('{calendarConnected && !calendarLoading && calendarEvents.length === 0 && (');
    expect(PAGE).toContain('Nothing on your calendar today.');
  });
  it('renders the failure + Retry when the read failed', () => {
    expect(PAGE).toContain("Couldn&apos;t load your calendar right now.");
    expect(PAGE).toContain('onClick={loadCalendar}');
    expect(PAGE).toContain('setCalendarError(data.error ?? null);');
    // the fetch failure path sets the flag instead of swallowing silently
    expect(PAGE).toContain(".catch(() => { setCalendarError('unavailable'); })");
  });
  it('a dead Google token (rotated OAuth client) reads RECONNECT with a link to Integrations, never an empty day', () => {
    expect(PAGE).toContain('Google needs to be reconnected to read your calendar.');
    expect(PAGE).toContain("router.push('/account?tab=integrations')");
    const ctrl = src('../../../backend/src/modules/crossmodel/crossmodel.controller.ts');
    expect(ctrl).toContain('googleMcp.resolveGoogleAccount(userId)');
    expect(ctrl).toContain("data: { connected: true, events: [], error: 'reconnect' }");
  });
  it('the connect row still renders when not connected', () => {
    expect(PAGE).toContain('{!calendarConnected && !calendarLoading && (');
    expect(PAGE).toContain('Connect your calendar');
  });
  it('the backend reports a failed read as error:unavailable on a connected calendar', () => {
    const ctrl = src('../../../backend/src/modules/crossmodel/crossmodel.controller.ts');
    expect(ctrl).toContain("data: { connected: true, events: [], error: 'unavailable' }");
    expect(ctrl).toContain("data: { connected, events: [], ...(connected ? { error: 'unavailable' } : {}) }");
    expect(src('../../lib/api/crossmodel.ts')).toContain("error?: 'unavailable' | 'reconnect';");
  });
});
