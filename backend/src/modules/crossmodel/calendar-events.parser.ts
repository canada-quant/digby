/**
 * Calendar event text parser — extracted from crossmodel.controller.ts
 * (feedback abeb36a2) so the parsing + cross-account dedup logic is unit-testable
 * without importing the controller monolith (and its prisma/redis/env graph).
 *
 * Input: the text blob produced by google-mcp.getCalendarEvents — one
 * `--- Label (email) ---` section per connected Google account, with events in
 * the MCP's human format (📅 Title / Start: / End: / 📍 / Organizer: / Note:).
 * Output: structured events for the home-page calendar card.
 */

// ── Calendar event parsing helpers ────────────────────────────────────────────

export interface CalendarEventParsed {
  title: string;
  startTime: string;
  endTime: string;
  startRaw: string;   // full date string from MCP (e.g. "Mon, Apr 13, 2026, 09:00 AM EDT") — frontend uses to determine past/future
  endRaw: string;     // full date string from MCP — frontend uses to determine past/future
  startEpoch: number; // milliseconds since epoch — reliable past/future comparison on frontend
  endEpoch: number;   // milliseconds since epoch — reliable past/future comparison on frontend
  location?: string;
  description?: string;
  account?: string;
  aiPrompts: string[];  // 2-3 unique contextual follow-up suggestions
}

/**
 * Compute the UTC offset (in ms) for a given IANA timezone at a specific UTC instant.
 * Returns the number of ms to ADD to a wall-clock Date.UTC() value to get the true UTC epoch.
 * E.g. for Europe/Rome (CEST, UTC+2): returns -7200000 (subtract 2h from wall-clock UTC to get real UTC).
 */
function getTimezoneOffsetMs(tz: string, atUtcMs: number): number {
  try {
    const d = new Date(atUtcMs);
    const utcStr = d.toLocaleString('en-US', { timeZone: 'UTC', hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const tzStr  = d.toLocaleString('en-US', { timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const parse = (s: string) => {
      const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s*(\d+):(\d+):(\d+)/);
      if (!m) return 0;
      return Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] === 24 ? 0 : +m[4], +m[5], +m[6]);
    };
    return parse(utcStr) - parse(tzStr);
  } catch {
    return 0;
  }
}

/**
 * Parse a raw MCP date string like "Mon, Apr 13, 2026, 09:00 AM EDT" into epoch milliseconds.
 * The times in these strings are displayed in the user's timezone (userTz), so we must
 * interpret them in that timezone — NOT in the server's local timezone (UTC in Docker).
 * Returns 0 if the string can't be parsed.
 */
function parseRawDateToEpoch(raw: string, userTz?: string): number {
  if (!raw) return 0;
  const trimmed = raw.trim();
  // All-day events: "2026-04-13" → treat as end-of-day UTC
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed + 'T23:59:59Z');
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }
  // Strip trailing timezone abbreviation (EDT, PST, CEST, AEST, etc.) — JS Date can't parse them
  const cleaned = trimmed.replace(/\s+[A-Z]{2,5}$/, '').trim();
  // Extract date/time components manually: "Mon, Apr 13, 2026, 09:00 AM"
  const m = cleaned.match(/(\w+),?\s+(\w+)\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m) {
    const months: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const mon = months[m[2].toLowerCase().substring(0, 3)];
    if (mon !== undefined) {
      let hour = parseInt(m[5], 10);
      const ampm = m[7].toUpperCase();
      if (ampm === 'PM' && hour !== 12) hour += 12;
      if (ampm === 'AM' && hour === 12) hour = 0;
      // Build the wall-clock time as if it were UTC, then adjust for the user's timezone
      const wallClockUtc = Date.UTC(parseInt(m[4], 10), mon, parseInt(m[3], 10), hour, parseInt(m[6], 10));
      if (!isNaN(wallClockUtc)) {
        if (userTz && userTz !== 'UTC') {
          // offsetMs is negative for timezones ahead of UTC (e.g. Europe/Rome CEST = -7200000)
          const offsetMs = getTimezoneOffsetMs(userTz, wallClockUtc);
          return wallClockUtc + offsetMs;
        }
        return wallClockUtc;
      }
    }
  }
  // Fallback: try direct parse (uses server timezone — less accurate but better than 0)
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d.getTime();
  return 0;
}

// Internal shape while parsing: carries the dedup signals (event organizer +
// the account email from the section header) that are stripped before return so
// the public API shape stays byte-identical.
type ParsedInternal = CalendarEventParsed & { organizer?: string; accountEmail?: string };

export function parseCalendarEventsText(rawEvents: string, userTz?: string): CalendarEventParsed[] {
  const events: ParsedInternal[] = [];
  let currentAccount = '';
  let currentAccountEmail = '';
  const lines = rawEvents.split('\n');

  // The MCP returns multi-line blocks like:
  //   --- Account Name (email) ---
  //   Found N event(s):
  //
  //   📅 **Event Title**
  //      Start: Mon, Apr 13, 2026, 09:00 AM EDT
  //      End:   Mon, Apr 13, 2026, 10:00 AM EDT
  //      📍 Conference Room A
  //      Organizer: john@example.com
  //      Attendees: person1, person2
  //      Note: Some description text

  let currentTitle = '';
  let currentStart = '';
  let currentEnd = '';
  let currentLocation = '';
  let currentDescription = '';
  let currentOrganizer = '';

  const flushEvent = () => {
    if (!currentTitle) return;
    // Extract a short time string from the full date string (e.g. "Mon, Apr 13, 2026, 09:00 AM EDT" → "9:00 AM")
    const shortStart = extractShortTime(currentStart);
    const shortEnd = extractShortTime(currentEnd);
    const startEpoch = parseRawDateToEpoch(currentStart, userTz);
    const endEpoch = parseRawDateToEpoch(currentEnd, userTz);
    const isPast = (endEpoch || startEpoch) ? (endEpoch || startEpoch) < Date.now() : false;
    events.push({
      title: currentTitle,
      startTime: shortStart,
      endTime: shortEnd,
      startRaw: currentStart,
      endRaw: currentEnd,
      startEpoch,
      endEpoch,
      location: currentLocation || undefined,
      description: currentDescription || undefined,
      account: currentAccount || undefined,
      organizer: currentOrganizer || undefined,
      accountEmail: currentAccountEmail || undefined,
      aiPrompts: generateCalendarPrompts(currentTitle, shortStart, currentLocation, currentDescription || undefined, isPast),
    });
    currentTitle = '';
    currentStart = '';
    currentEnd = '';
    currentLocation = '';
    currentDescription = '';
    currentOrganizer = '';
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Account header: --- Account Name (email) ---
    const accountMatch = trimmed.match(/^---\s*(.+?)\s*---$/);
    if (accountMatch) {
      // Flush the pending event BEFORE switching accounts — otherwise the last
      // event of a section is attributed to the NEXT account (a pre-existing
      // off-by-one-section bug: with one event per account, EVERY event was
      // labeled with the following section's account).
      flushEvent();
      currentAccount = accountMatch[1];
      // Bare account email from the trailing "(email)" — the dedup signal that
      // ties an event to the account section it was listed under.
      const em = currentAccount.match(/\(([^()\s]+@[^()\s]+)\)\s*$/);
      currentAccountEmail = em ? em[1] : '';
      continue;
    }

    // Event title line: 📅 **Title** or 📅 Title
    const titleMatch = trimmed.match(/^📅\s*\*{0,2}(.+?)\*{0,2}$/);
    if (titleMatch) {
      flushEvent(); // flush any previous event
      currentTitle = titleMatch[1].trim();
      continue;
    }

    // Only parse detail lines when we're inside an event block
    if (currentTitle) {
      // Start time: "Start: Mon, Apr 13, 2026, 09:00 AM EDT"
      const startMatch = trimmed.match(/^Start:\s*(.+)$/i);
      if (startMatch) { currentStart = startMatch[1].trim(); continue; }

      // End time: "End: Mon, Apr 13, 2026, 10:00 AM EDT" (may have extra spaces)
      const endMatch = trimmed.match(/^End:\s*(.+)$/i);
      if (endMatch) { currentEnd = endMatch[1].trim(); continue; }

      // Location: "📍 Conference Room A" or "Location: ..."
      const locMatch = trimmed.match(/^(?:📍\s*|Location:\s*)(.+)$/i);
      if (locMatch) { currentLocation = locMatch[1].trim(); continue; }

      // Description/Note: "Note: ..."
      const noteMatch = trimmed.match(/^Note:\s*(.+)$/i);
      if (noteMatch) { currentDescription = noteMatch[1].trim(); continue; }

      // Organizer: captured (not skipped) — it is the strongest signal for WHICH
      // connected account actually owns an event when the same event is listed
      // under several accounts (shared/subscribed calendars), which the
      // cross-account dedup below uses to pick the right label. (feedback abeb36a2)
      const orgMatch = trimmed.match(/^Organizer:\s*(.+)$/i);
      if (orgMatch) { currentOrganizer = orgMatch[1].trim(); continue; }

      // Skip Attendees/other metadata lines silently
      if (trimmed.match(/^(Attendees|Link):/i)) continue;
    }

    // Skip non-event lines (headers, blank lines, "Found N event(s):", etc.)
  }

  // Flush the last event
  flushEvent();

  // Deduplicate across accounts: the same event can appear in several connected
  // Google accounts (e.g., a meeting invitation sent to both personal and work
  // email, or a shared/subscribed calendar — like a teammate's vacation calendar —
  // that is visible to every workspace account even though it "belongs" to one).
  // Group by title+start; when duplicates collide, prefer the occurrence whose
  // ACCOUNT matches the event organizer (exact email match first, then domain
  // match) — the organizer is the strongest ownership signal, so the home-page
  // tag shows the account that actually owns the event instead of whichever
  // account section happened to be queried first. (feedback abeb36a2: a
  // Work-calendar vacation event was tagged "CQL" purely because CQL's section
  // came first and the old dedup kept the first occurrence.) With no organizer
  // signal, keep the first occurrence — unchanged legacy behavior.
  const extractEmail = (s?: string): string | undefined => {
    if (!s) return undefined;
    const m = s.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
    return m ? m[0].toLowerCase() : undefined;
  };
  const groups = new Map<string, ParsedInternal[]>();
  for (const e of events) {
    const key = `${e.title.toLowerCase().trim()}|${e.startTime}`;
    const g = groups.get(key);
    if (g) g.push(e); else groups.set(key, [e]);
  }
  const unique: CalendarEventParsed[] = [...groups.values()].map((group) => {
    let chosen = group[0];
    if (group.length > 1) {
      const exact = group.find((e) => {
        const org = extractEmail(e.organizer);
        return !!org && !!e.accountEmail && org === e.accountEmail.toLowerCase();
      });
      if (exact) {
        chosen = exact;
      } else {
        const domain = group.find((e) => {
          const org = extractEmail(e.organizer);
          const acct = e.accountEmail?.toLowerCase();
          return !!org && !!acct && org.split('@')[1] === acct.split('@')[1];
        });
        if (domain) chosen = domain;
      }
    }
    // Strip the internal dedup fields — public API shape stays byte-identical.
    return {
      title: chosen.title,
      startTime: chosen.startTime,
      endTime: chosen.endTime,
      startRaw: chosen.startRaw,
      endRaw: chosen.endRaw,
      startEpoch: chosen.startEpoch,
      endEpoch: chosen.endEpoch,
      location: chosen.location,
      description: chosen.description,
      account: chosen.account,
      aiPrompts: chosen.aiPrompts,
    };
  });

  return unique;
}

/** Extract a short time like "9:00 AM" from a full date string like "Mon, Apr 13, 2026, 09:00 AM EDT" */
function extractShortTime(fullDateStr: string): string {
  if (!fullDateStr) return '';
  // All-day events come through as just a date like "2026-04-13"
  if (/^\d{4}-\d{2}-\d{2}$/.test(fullDateStr.trim())) return '';
  // Try to extract "HH:MM AM/PM" pattern
  const timeMatch = fullDateStr.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (timeMatch) return timeMatch[1];
  // Fallback: return the original string trimmed
  return fullDateStr;
}

/**
 * Generate 2-3 unique, contextually relevant follow-up prompts for a calendar event.
 * Each prompt is specific to the event's title, time, location, and description.
 * For past events (isPast=true), generates recap/follow-up oriented prompts instead of prep prompts.
 */
function generateCalendarPrompts(title: string, startTime: string, location?: string, description?: string, isPast?: boolean): string[] {
  const clean = title.replace(/\s+/g, ' ').trim();
  const t = startTime ? ` at ${startTime}` : '';
  const l = clean.toLowerCase();
  const loc = location ? ` at ${location}` : '';
  const desc = description ? description.substring(0, 80) : '';

  // ── Standup / Daily ──
  if (l.includes('standup') || l.includes('stand-up') || l.includes('daily')) return isPast ? [
    `Summarize what I accomplished today after standup`,
    `Draft an end-of-day update based on my standup commitments`,
  ] : [
    `Prepare talking points for my standup${t} — yesterday, today, blockers`,
    `Help me write a concise 30-second standup update`,
  ];

  // ── Interview ──
  if (l.includes('interview')) return isPast ? [
    `Help me write a thank-you email after my interview "${clean}"`,
    `What should I reflect on after "${clean}"?`,
  ] : [
    `Help me prepare for "${clean}"${t} — common questions and strong answers`,
    `Research the company and role for "${clean}"`,
    `Give me a confident 2-minute elevator pitch for "${clean}"`,
  ];

  // ── 1:1 / Review / Performance ──
  if (l.includes('review') || l.includes('1:1') || l.includes('one-on-one') || l.includes('performance')) return isPast ? [
    `Document key takeaways from my ${clean}`,
    `Draft action items from my ${clean} discussion`,
  ] : [
    `Prepare discussion points for ${clean}${t} — wins, challenges, goals`,
    `What thoughtful questions should I bring to ${clean}?`,
    `Draft a self-assessment highlighting recent contributions for ${clean}`,
  ];

  // ── Presentation / Demo / Pitch ──
  if (l.includes('presentation') || l.includes('demo') || l.includes('pitch')) return isPast ? [
    `Summarize feedback from my "${clean}" presentation`,
    `What follow-up actions should I take after "${clean}"?`,
  ] : [
    `Outline the key points and flow for "${clean}"${t}`,
    `What's a compelling opening hook for "${clean}"?`,
    `Prepare me for tough Q&A questions about "${clean}"`,
  ];

  // ── Meeting (generic) ──
  if (l.includes('meeting') || l.includes('sync') || l.includes('call') || l.includes('huddle')) return isPast ? [
    `Write meeting notes and action items from "${clean}"`,
    `Draft a follow-up email summarizing "${clean}" decisions`,
  ] : [
    `Prepare an agenda for "${clean}"${t}${desc ? ` — context: ${desc}` : ''}`,
    `What insightful questions should I ask during "${clean}"?`,
    `Summarize what I should know before "${clean}"${loc}`,
  ];

  // ── Lunch / Dinner / Coffee / Social ──
  if (l.includes('lunch') || l.includes('dinner') || l.includes('coffee') || l.includes('happy hour') || l.includes('drinks')) return isPast ? [
    `Send a nice follow-up message after "${clean}"`,
    loc ? `Write a review of my experience${loc}` : `What's a good way to follow up after "${clean}"?`,
  ] : [
    `Suggest interesting conversation topics for "${clean}"${t}`,
    loc ? `What's good to order${loc}?` : `Recommend a great spot for "${clean}" nearby`,
    `What are some fun icebreakers for "${clean}"?`,
  ];

  // ── Doctor / Dentist / Medical ──
  if (l.includes('doctor') || l.includes('dentist') || l.includes('appointment') || l.includes('medical') || l.includes('therapy')) return [
    `Help me prepare questions for my ${clean}${t}`,
    `What should I bring to my ${clean}?`,
    `Create a symptom/concern checklist for my ${clean}`,
  ];

  // ── Workout / Gym / Fitness ──
  if (l.includes('workout') || l.includes('gym') || l.includes('yoga') || l.includes('run') || l.includes('fitness') || l.includes('training')) return [
    `Suggest a ${clean.toLowerCase()} routine for today`,
    `What should I eat before my ${clean.toLowerCase()}?`,
    `Create a warm-up plan for my ${clean.toLowerCase()}`,
  ];

  // ── Deadline / Due date ──
  if (l.includes('deadline') || l.includes('due') || l.includes('submit')) return [
    `Help me create a checklist to finish "${clean}" on time`,
    `What should I prioritize to meet the "${clean}" deadline?`,
    `Draft a status update for "${clean}"`,
  ];

  // ── Class / Lecture / Workshop / Training ──
  if (l.includes('class') || l.includes('lecture') || l.includes('workshop') || l.includes('seminar') || l.includes('webinar')) return [
    `What should I know before "${clean}"${t}?`,
    `Help me prepare notes for "${clean}"`,
    `What questions should I ask during "${clean}"?`,
  ];

  // ── Travel / Flight / Trip ──
  if (l.includes('flight') || l.includes('travel') || l.includes('trip') || l.includes('airport')) return [
    `Create a packing checklist for "${clean}"`,
    `What do I need to prepare before "${clean}"${t}?`,
    `Help me plan my travel day for "${clean}"`,
  ];

  // ── Birthday / Celebration / Party ──
  if (l.includes('birthday') || l.includes('party') || l.includes('celebration') || l.includes('anniversary')) return isPast ? [
    `Help me write a thank-you message after "${clean}"`,
    `Share photos or memories from "${clean}" — help me caption them`,
  ] : [
    `Suggest a thoughtful and unique gift idea for "${clean}"`,
    `Help me write a heartfelt message for "${clean}"`,
    `What should I bring to "${clean}"${loc}?`,
  ];

  // ── Sprint / Planning / Retro / Agile ──
  if (l.includes('sprint') || l.includes('planning') || l.includes('retro') || l.includes('retrospective') || l.includes('backlog')) return isPast ? [
    `Document outcomes from "${clean}"`,
    `Draft action items from the "${clean}" session`,
  ] : [
    `Prepare for "${clean}"${t} — what went well, what to improve`,
    `What metrics should I bring to "${clean}"?`,
  ];

  // ── Brainstorm / Strategy / Offsite ──
  if (l.includes('brainstorm') || l.includes('strategy') || l.includes('offsite') || l.includes('ideation')) return isPast ? [
    `Organize ideas from the "${clean}" session`,
    `Prioritize the ideas we discussed in "${clean}"`,
  ] : [
    `Come prepared with 3 creative ideas for "${clean}"${t}`,
    `What frameworks work well for a "${clean}" session?`,
  ];

  // ── Networking / Conference / Event ──
  if (l.includes('networking') || l.includes('conference') || l.includes('meetup') || l.includes('expo') || l.includes('summit')) return isPast ? [
    `Follow up with contacts from "${clean}"`,
    `Summarize key insights from "${clean}"`,
  ] : [
    `Prepare an elevator pitch for "${clean}"${t}${loc}`,
    `What should I know about "${clean}" before attending?`,
    `Create a networking strategy for "${clean}"`,
  ];

  // ── Generic fallback — use description and location context for unique prompts ──
  if (isPast) {
    const pastPrompts: string[] = [`Summarize what happened at "${clean}" and any follow-ups`];
    if (desc) {
      pastPrompts.push(`Document notes from "${clean}" — context: ${desc}`);
    } else {
      pastPrompts.push(`What should I do next after "${clean}"?`);
    }
    return pastPrompts;
  }

  const prompts: string[] = [`Help me prepare for "${clean}"${t}${desc ? ` — ${desc}` : ''}`];
  if (description && description.length > 10) {
    prompts.push(`What should I know about "${clean}"? Context: ${desc}`);
  } else {
    prompts.push(`What should I expect at "${clean}"${t}?`);
  }
  if (loc) {
    prompts.push(`Tell me about${loc} where "${clean}" is happening`);
  } else {
    prompts.push(`Create a quick prep checklist for "${clean}"`);
  }
  return prompts;
}
