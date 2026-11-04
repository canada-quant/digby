/**
 * Shared helpers for the Management tabs.
 * (Compact relative time moved to lib/relative-time.ts — the one shared
 * module for age formatting; import `relativeTime` from there.)
 */

/** "every 24h" / "every 90m" / "every 45s" from a recurring schedule's intervalSec. */
export function formatInterval(intervalSec: number | null | undefined): string {
  if (!intervalSec || intervalSec <= 0) return '';
  if (intervalSec % 86400 === 0) return `every ${intervalSec / 86400}d`;
  if (intervalSec % 3600 === 0) return `every ${intervalSec / 3600}h`;
  if (intervalSec % 60 === 0) return `every ${intervalSec / 60}m`;
  return `every ${intervalSec}s`;
}

/** Short clock time for thread bubbles / log rows (HH:MM, with date when not today). */
export function shortTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return '';
  const isToday = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return isToday ? time : `${d.toLocaleDateString()} ${time}`;
}

/**
 * Kind pill for one /fleet/log row — shared by the Logs tab and the
 * supervisor chat's overview panel. Uses the shared ui/badge variants
 * (dark-safe); violet has no variant, so it keeps a className override WITH a
 * dark border (the old per-file maps were light-only). Keyed by
 * FleetLogRow['kind']; typed loosely here to keep utils.ts free of api-client
 * imports.
 */
export const LOG_KIND_BADGE: Record<string, { label: string; variant: 'info' | 'warning' | 'success' | 'outline'; className?: string }> = {
  user_message:     { label: 'You',        variant: 'info' },
  machine_wake:     { label: 'Wake',       variant: 'warning' },
  agent_message:    { label: 'Agent',      variant: 'outline', className: 'bg-brand-muted text-brand-hover dark:bg-brand-dim/30 dark:text-brand-ring border-brand-pale dark:border-brand-border' },
  supervisor_reply: { label: 'Supervisor', variant: 'success' },
};
