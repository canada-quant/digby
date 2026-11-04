/**
 * [CURRENT DATE & TIME] block builder — dependency-free on purpose.
 *
 * Extracted from chat-context.ts (2026-09-08) so background services that
 * must NOT import the chat-context module (prisma/redis/rag/memory graph, and
 * an import cycle via user-facts.service → suggested-questions.service) can
 * still hand a model the exact same date block every chat query receives.
 * chat-context.ts re-exports both symbols, so existing importers are unchanged.
 */

/**
 * Owner convention (ticket 63698528 — "aren't you always supposed to show time
 * as both z and user?"): every timestamp REPORTED TO THE USER renders both
 * clocks — local first, the UTC instant in parentheses. Passed as
 * buildDateTimeBlock's extraNote whenever the user's timezone is known (the
 * chat injection below; the coding surface derives its own rule with the
 * user-vs-machine split in coding/datetime-context.ts).
 */
export const dualTimestampRule = (tz: string) =>
  `Timestamp rule: when reporting any time to the user, render BOTH clocks — the user's local time (${tz}) first, with the UTC instant in parentheses, e.g. "10:30 PM PDT (05:30Z)". Never a bare Zulu-only or local-only timestamp.`;

export function buildDateTimeBlock(userTimezone?: string, extraNote?: string): string {
  const now = new Date();
  const weekday   = now.toLocaleDateString('en-US', { weekday: 'long',  timeZone: 'UTC' });
  const monthName = now.toLocaleDateString('en-US', { month: 'long',   timeZone: 'UTC' });
  const day       = now.getUTCDate();
  const year      = now.getUTCFullYear();
  const timeStr   = now.toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZone: 'UTC', hour12: false,
  });
  const startOfYear = new Date(Date.UTC(year, 0, 1));
  const dayOfYear   = Math.ceil((now.getTime() - startOfYear.getTime()) / 86400000);
  const quarter     = Math.ceil((now.getUTCMonth() + 1) / 3);

  // Build user's local time block if timezone is available.
  // This is CRITICAL for calendar queries — without it, the AI miscalculates
  // "today" vs "tomorrow" when the user's local date differs from UTC date.
  let localTimeBlock = '';
  if (userTimezone) {
    try {
      const localWeekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: userTimezone });
      const localMonth   = now.toLocaleDateString('en-US', { month: 'long', timeZone: userTimezone });
      const localDay     = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: userTimezone });
      const localYear    = now.toLocaleDateString('en-US', { year: 'numeric', timeZone: userTimezone });
      const localTime    = now.toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: userTimezone, hour12: true, timeZoneName: 'short',
      });
      localTimeBlock = `\nUser local: ${localWeekday}, ${localMonth} ${localDay}, ${localYear} at ${localTime} (${userTimezone})`;
      localTimeBlock += `\nIMPORTANT : When the user says "today", "tomorrow", "this week", etc., use the USER LOCAL date above — NOT the UTC date. Calendar events should be described relative to the user's local date.`;
    } catch {
      // Invalid timezone string — skip local time block
    }
  }

  return `[CURRENT DATE & TIME — USE THIS DIRECTLY, NO WEB SEARCH NEEDED]
Date      : ${weekday}, ${monthName} ${day}, ${year}
Time      : ${timeStr} UTC
ISO 8601  : ${now.toISOString()}
Unix ts   : ${Math.floor(now.getTime() / 1000)}
Quarter   : Q${quarter} of ${year}   (Day ${dayOfYear} of the year)${localTimeBlock}
Note      : If the user asks what time/date/day/year it is, answer from the above — no web search required.${extraNote?.trim() ? `\n${extraNote.trim()}` : ''}
[/CURRENT DATE & TIME]`;
}
