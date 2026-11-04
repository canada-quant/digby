// Clock-of-day message stamps (the CANONICAL copy — the page.tsx local it once
// mirrored was deleted in the C3 pass; CodeSessionView + code-transcript import
// from here). Relative "N ago" ages live in lib/relative-time.ts instead.

/** Locale time label for a message row — hours:minutes, with the date prefixed
 *  when the message is from a previous day (ticket d808e5aa). */
export function formatMessageTime(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${date}, ${time}`;
}
