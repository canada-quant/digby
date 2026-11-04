/**
 * Session title halves (session titles + topology, 2026-09-27) — the client
 * twin of backend platform/session-titles.ts splitSessionTitle: the harness
 * renders lane titles as "<goal ≤6 words> · <step ≤6 words>"; the sidebar and
 * the Sessions tab show the goal half bold and the step half muted. The LAST
 * " · " wins (a goal half may itself contain a middle dot). Pure.
 */

export const SESSION_TITLE_SEP = ' · ';

export function splitSessionTitle(title: unknown): { goal: string; step: string | null } {
  const t = String(title ?? '').trim();
  const i = t.lastIndexOf(SESSION_TITLE_SEP);
  if (i <= 0) return { goal: t, step: null };
  return { goal: t.slice(0, i).trim(), step: t.slice(i + SESSION_TITLE_SEP.length).trim() || null };
}

/** "12 m" / "3 h" / "2 d" for a receipt age in seconds; null ⇒ '—'. Pure. */
export function receiptAgeLabel(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const min = Math.max(0, Math.round(sec / 60));
  if (min < 60) return `${min} m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}
