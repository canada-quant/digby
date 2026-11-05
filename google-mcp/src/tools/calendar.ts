/**
 * Google Calendar tools for the Google Workspace MCP server.
 */

import { google } from 'googleapis';

function getAuth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/**
 * Format a dateTime or date value from the Google Calendar API.
 * @param dateTime        ISO 8601 datetime string (e.g. "2026-04-13T14:00:00-04:00")
 * @param date            Date-only string for all-day events (e.g. "2026-04-13")
 * @param eventTimeZone   IANA timezone from the event's start/end object (e.g. "America/New_York")
 * @param displayTimezone Optional IANA timezone to display times in (user's local timezone).
 *                        When provided, ALL events are shown in this timezone regardless of
 *                        which timezone they were created in — matching Google Calendar's behavior.
 */
function formatDateTime(
  dateTime?: string | null,
  date?: string | null,
  eventTimeZone?: string | null,
  displayTimezone?: string | null,
): string {
  if (dateTime) {
    try {
      const d = new Date(dateTime);
      const opts: Intl.DateTimeFormatOptions = {
        weekday: 'short', year: 'numeric', month: 'short',
        day: 'numeric', hour: '2-digit', minute: '2-digit',
        timeZoneName: 'short',
      };
      // Prefer the user's display timezone so all events show in their local time
      // (matches Google Calendar UI behavior). Fall back to event's own timezone.
      const tz = displayTimezone || eventTimeZone;
      if (tz) opts.timeZone = tz;
      return d.toLocaleString('en-US', opts);
    } catch { return dateTime; }
  }
  if (date) return date; // All-day event
  return 'Unknown';
}

// ── Tool implementations ──────────────────────────────────────────────────────

/**
 * List calendar events across ALL calendars the user has access to.
 * First fetches the full calendar list, then queries events from each.
 * Falls back to 'primary' only if the calendar list call fails.
 */
/**
 * Format an event organizer for the human-readable block the home-page parser
 * consumes. Emit BOTH the display name and the email ("Felipe <example-user@example.com>")
 * when both exist and differ: the parser's organizer-aware cross-account dedup
 * keys off an EMAIL in this line, so a display-name-only line silently defeats
 * the preference and the event keeps its first-occurrence mislabel (ticket
 * 39c0cd3f — the named-organizer half of feedback abeb36a2). Email-only and
 * name-only inputs pass through unchanged; identical name/email collapses to
 * the bare email.
 */
export function formatOrganizer(organizer?: { displayName?: string | null; email?: string | null } | null): string {
  const name  = (organizer?.displayName || '').trim();
  const email = (organizer?.email || '').trim();
  if (name && email && name.toLowerCase() !== email.toLowerCase()) return `${name} <${email}>`;
  return email || name;
}

export async function calendarListEvents(
  accessToken: string,
  timeMin?: string,
  timeMax?: string,
  maxResults = 10,
  displayTimezone?: string,
): Promise<string> {
  const auth     = getAuth(accessToken);
  const calendar = google.calendar({ version: 'v3', auth });

  const now            = new Date();
  const effectiveMin   = timeMin || now.toISOString();
  const effectiveMax   = timeMax || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const perCalMax      = Math.min(maxResults, 50);

  // Step 1: list all calendars (read access or better)
  let calendarIds: string[] = ['primary'];
  try {
    const calListRes = await calendar.calendarList.list({ minAccessRole: 'reader' });
    const items = calListRes.data.items || [];
    const ids = items.map((c: any) => c.id as string).filter(Boolean);
    if (ids.length > 0) calendarIds = ids;
  } catch {
    // Non-fatal — fall back to primary
  }

  // Step 2: fetch events from all calendars in parallel
  const allEvents: Array<any & { _calLabel?: string }> = [];

  await Promise.allSettled(
    calendarIds.map(async (calId) => {
      try {
        const res = await calendar.events.list({
          calendarId:   calId,
          timeMin:      effectiveMin,
          timeMax:      effectiveMax,
          maxResults:   perCalMax,
          singleEvents: true,
          orderBy:      'startTime',
        });
        const items = res.data.items || [];
        for (const item of items) {
          (item as any)._calId = calId;
        }
        allEvents.push(...items);
      } catch {
        // Calendar may not be accessible — skip silently
      }
    })
  );

  // Step 3: deduplicate by summary + normalized UTC start time (NOT by event ID,
  // because the same event appears with different IDs across different calendars
  // and accounts, and may have different timezone representations of the same moment,
  // e.g. "2026-04-13T09:00:00-04:00" vs "2026-04-13T13:00:00Z")
  const seen  = new Set<string>();
  const unique = allEvents.filter(e => {
    const summary = (e.summary || '').trim().toLowerCase();
    // Normalize start time to UTC milliseconds so different timezone representations
    // of the same moment produce the same dedup key
    const rawStart = e.start?.dateTime || e.start?.date || '';
    const startMs = rawStart ? new Date(rawStart).getTime() : 0;
    const key = `${summary}|${isNaN(startMs) ? rawStart : startMs}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Step 4: sort by start time (using UTC milliseconds for correct ordering)
  unique.sort((a, b) => {
    const aRaw = a.start?.dateTime || a.start?.date || '';
    const bRaw = b.start?.dateTime || b.start?.date || '';
    const aMs = aRaw ? new Date(aRaw).getTime() : 0;
    const bMs = bRaw ? new Date(bRaw).getTime() : 0;
    return aMs - bMs;
  });

  if (unique.length === 0) {
    return 'No calendar events found in the specified time range.';
  }

  const lines: string[] = [`Found ${unique.length} event(s):\n`];

  for (const event of unique) {
    const startTz   = event.start?.timeZone || null;
    const endTz     = event.end?.timeZone || startTz;
    const start     = formatDateTime(event.start?.dateTime, event.start?.date, startTz, displayTimezone);
    const end       = formatDateTime(event.end?.dateTime,   event.end?.date, endTz, displayTimezone);
    const attendees = (event.attendees || [])
      .map((a: any) => a.displayName || a.email)
      .slice(0, 5)
      .join(', ');
    const organizer = formatOrganizer(event.organizer);
    const location  = event.location || '';

    lines.push(
      `📅 **${event.summary || '(no title)'}**\n` +
      `   Start: ${start}\n` +
      `   End:   ${end}\n` +
      (location  ? `   📍 ${location}\n`   : '') +
      (organizer ? `   Organizer: ${organizer}\n` : '') +
      (attendees ? `   Attendees: ${attendees}\n` : '') +
      (event.description ? `   Note: ${event.description.substring(0, 100)}` : '')
    );
  }

  return lines.join('\n');
}

/**
 * Create a new calendar event.
 * start/end should be ISO 8601 strings (e.g. "2026-03-24T14:00:00-07:00")
 * or date strings for all-day events (e.g. "2026-03-24").
 */
export async function calendarCreateEvent(
  accessToken: string,
  summary: string,
  start: string,
  end: string,
  description?: string,
  attendees?: string[],
  location?: string,
): Promise<string> {
  const auth     = getAuth(accessToken);
  const calendar = google.calendar({ version: 'v3', auth });

  // Detect all-day event (no time component)
  const isAllDay = /^\d{4}-\d{2}-\d{2}$/.test(start);

  const event: any = {
    summary,
    description: description || undefined,
    location:    location    || undefined,
    start: isAllDay ? { date: start }     : { dateTime: start },
    end:   isAllDay ? { date: end }       : { dateTime: end   },
  };

  if (attendees && attendees.length > 0) {
    event.attendees = attendees.map(email => ({ email }));
  }

  const res = await calendar.events.insert({
    calendarId:  'primary',
    requestBody: event,
    sendUpdates: 'all',
  });

  const created = res.data;
  return (
    `✅ Event created: **${created.summary}**\n` +
    `   Start: ${formatDateTime(created.start?.dateTime, created.start?.date, created.start?.timeZone)}\n` +
    `   End:   ${formatDateTime(created.end?.dateTime,   created.end?.date, created.end?.timeZone)}\n` +
    `   Link:  ${created.htmlLink || 'N/A'}`
  );
}
