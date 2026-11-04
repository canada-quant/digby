'use client';

/**
 * Feedback-row timestamps (ticket 1ab949bc): the tracker previously showed only
 * a bare toLocaleDateString() for the filed date — no time, and nothing at all
 * for updates/replies. The API has always returned both createdAt and updatedAt
 * (the user-facing list spreads the full row), so this is a pure rendering
 * change: "Filed <date time>" everywhere, plus "Updated <date time>" once the
 * row has moved past its creation minute (status flips, admin replies, sighting
 * bumps all bump updatedAt — "Updated" is the honest label for that).
 *
 * Kept as pure exported helpers + a presentational component so the node-env
 * vitest suite can pin locale/timeZone and assert exact output.
 */

/** Minimum gap before a row counts as "updated" — creation writes can lag a second or two. */
export const UPDATED_STAMP_MIN_DELTA_MS = 60_000;

/**
 * Localized "Sep 1, 2026, 10:38 AM". Returns '' for unparseable input so callers
 * can render nothing instead of "Invalid Date". locale/timeZone are injectable
 * for deterministic tests; production callers omit both (browser defaults).
 */
export function formatFeedbackStamp(iso: string, locale?: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
}

/** True when updatedAt exists, parses, and is meaningfully after createdAt. */
export function shouldShowUpdatedStamp(createdAt: string, updatedAt?: string | null): boolean {
  if (!updatedAt) return false;
  const created = Date.parse(createdAt);
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(created) || Number.isNaN(updated)) return false;
  return updated - created > UPDATED_STAMP_MIN_DELTA_MS;
}

/**
 * Two-line right-aligned stamp block for a feedback row header:
 *   Filed Sep 1, 2026, 10:38 AM
 *   Updated Sep 1, 2026, 2:15 PM   (only once the row has actually moved)
 * Full ISO strings ride the title attribute for exact-copy debugging.
 */
export function RequestTimestamps({
  createdAt,
  updatedAt,
  className,
  locale,
  timeZone,
}: {
  createdAt: string;
  updatedAt?: string | null;
  className?: string;
  locale?: string;
  timeZone?: string;
}) {
  const filed = formatFeedbackStamp(createdAt, locale, timeZone);
  const showUpdated = shouldShowUpdatedStamp(createdAt, updatedAt);
  const updated = showUpdated ? formatFeedbackStamp(updatedAt as string, locale, timeZone) : '';
  return (
    <span className={className}>
      <span className="block" title={createdAt ? `Filed ${createdAt}` : undefined}>
        Filed {filed}
      </span>
      {showUpdated && (
        <span className="block" title={`Updated ${updatedAt}`}>
          Updated {updated}
        </span>
      )}
    </span>
  );
}
