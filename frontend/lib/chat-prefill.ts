/**
 * `?q=` composer prefill for the chat home (2026-10-16, public-site redesign):
 * the site's sticky ask bar and "Try asking Digby" prompts link to `/?q=<text>`.
 * The chat page reads it ONCE, puts the text in the composer WITHOUT sending
 * (the visitor reviews it and presses send), and strips `q` from the address
 * bar so a reload or a shared link never re-fills it. Pure + DOM-free.
 */

export const PREFILL_PARAM = 'q';
/** Generous for a typed question; anything longer is clipped, never rejected. */
export const PREFILL_MAX_CHARS = 2000;

/** The prefill text from a location.search string, or null when absent / blank. */
export function readPrefill(search: string | null | undefined): string | null {
  if (!search) return null;
  let raw: string | null;
  try {
    raw = new URLSearchParams(search).get(PREFILL_PARAM);
  } catch {
    return null;
  }
  if (raw == null) return null;
  // Control characters (except tab / newline) never reach the composer.
  const clean = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!clean) return null;
  return clean.length > PREFILL_MAX_CHARS ? clean.slice(0, PREFILL_MAX_CHARS) : clean;
}

/** The same URL path + query with ONLY `q` removed (other params — chatId, utm_* — survive). */
export function withoutPrefill(pathname: string, search: string, hash = ''): string {
  const params = new URLSearchParams(search);
  params.delete(PREFILL_PARAM);
  const qs = params.toString();
  return `${pathname}${qs ? `?${qs}` : ''}${hash}`;
}

/** The chat link a site page uses for a suggested prompt. */
export function chatPrefillHref(text: string, base = '/'): string {
  return `${base}?${new URLSearchParams({ [PREFILL_PARAM]: text }).toString()}`;
}
