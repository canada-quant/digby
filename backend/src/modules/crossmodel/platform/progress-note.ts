/**
 * Goal / todo progressNote — storage cap vs display clamp (ticket a8d6e514,
 * filed by the R&D shortfall-hunt lane 2026-10-06 20:47Z).
 *
 * The note used to be clamped to 200 chars at the TOOL layer (goals.service
 * PROGRESS_NOTE_MAX = 200) although the DB column is unbounded Text. Standing
 * loops ("each sweep continues the last") stamp their continuation ledger into
 * the note, so everything past char 200 — the ticket ids the NEXT firing
 * needs — was amputated mid-word (todo d14e0d2d ended "…(hook-retirement
 * shortfall, my fi").
 *
 * Now the WRITE keeps up to PROGRESS_NOTE_MAX (2,000) chars, and every DISPLAY
 * that puts a note into a prompt / card / Pulse / brief stays bounded through
 * progressNoteForDisplay (PROGRESS_NOTE_DISPLAY_MAX = 200, word boundary + "…"),
 * so no prompt or card grows. The full note comes back only from the reads a
 * lane uses to resume (todo_get / goal_get / the project-scoped goal_list).
 * The HOLD-marker detectors and the progress-fraction parser read the LEAD
 * (progressNoteLead — the first 200 chars, exactly what they always saw), so a
 * ledger tail can never flip a goal to "held" or feed the Pulse a stale count.
 *
 * Kill switch: PROGRESS_NOTE_LONG_DISABLED=1 stores 200 chars again (every
 * display clamp is then a no-op — a stored note is never longer than it).
 * Pure leaf — no imports (safe for platform-tools' static import graph).
 */

/** Storage cap for a progressNote write (tool layer + REST + harness notes). */
export const PROGRESS_NOTE_MAX = 2000;
/** The pre-a8d6e514 storage cap — restored by PROGRESS_NOTE_LONG_DISABLED=1. */
export const PROGRESS_NOTE_LEGACY_MAX = 200;
/** What any prompt / card / Pulse / brief / listing shows of a note. */
export const PROGRESS_NOTE_DISPLAY_MAX = 200;

/** PROGRESS_NOTE_LONG_DISABLED=1 ⇒ notes are stored at the legacy 200 chars. */
export function progressNoteLongDisabled(): boolean {
  return process.env.PROGRESS_NOTE_LONG_DISABLED === '1';
}

/** The storage cap in force (2,000; 200 under the kill switch). */
export function progressNoteMax(): number {
  return progressNoteLongDisabled() ? PROGRESS_NOTE_LEGACY_MAX : PROGRESS_NOTE_MAX;
}

/**
 * A note as a display surface shows it: unchanged when it fits `max` (so
 * every note written under the old 200 cap renders byte-identically), else
 * cut on the last word boundary before `max` and closed with "…" (code-point
 * safe; never longer than `max`). null / non-string → null. Pure.
 */
export function progressNoteForDisplay(note: unknown, max: number = PROGRESS_NOTE_DISPLAY_MAX): string | null {
  if (typeof note !== 'string') return null;
  const units = Array.from(note);
  if (units.length <= max) return note;
  const limit = Math.max(1, max - 1);
  const head = units.slice(0, limit).join('');
  // Cut at the last whitespace when it keeps most of the budget; a single
  // giant token (a URL, a hash run) is cut mid-token rather than emptied.
  const ws = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'), head.lastIndexOf('\t'));
  const cut = ws >= Math.floor(limit * 0.6) ? head.slice(0, ws) : head;
  const trimmed = cut.replace(/[\s,;:—–-]+$/u, '');
  return `${trimmed || cut}…`;
}

/**
 * Apply the STORAGE cap to a note — counting CODE POINTS, never splitting a
 * surrogate pair (ticket f3e56567 follow-up, 2026-10-30).
 *
 * `goals.service` used to do `String(note).trim().slice(0, progressNoteMax())`.
 * `.slice` counts UTF-16 UNITS, which broke the cap two ways on any astral-plane
 * text (emoji, rare CJK, mathematical alphanumerics), both measured live:
 *
 *   1. A note of 2,000 emoji is 4,000 UTF-16 units, so `.slice(0, 2000)` stored
 *      only 1,000 code points — HALF the note, silently.
 *   2. `progressNoteClipNotice` counts code points (per its pinned contract), so
 *      on that same write it saw 2,000 <= 2,000 and returned NULL: the guard
 *      that exists to make a vanished tail LOUD went silent precisely on the
 *      payload shape most likely to lose one.
 *   3. Off-by-one surrogates: `'b'.repeat(1999) + '🚀…'` cut at unit 2,000 left
 *      a LONE HIGH SURROGATE, which serializes to U+FFFD — a corrupted glyph
 *      written into the row instead of a clean truncation.
 *
 * So the writer caps on the SAME unit the guard and every display count. A note
 * that fits is returned byte-identically; a longer one is the clean prefix of
 * `max` code points with no split pair. '' for null / non-string (an explicit
 * clear). Pure.
 */
export function clipProgressNote(note: unknown, max: number = progressNoteMax()): string {
  if (typeof note !== 'string') return '';
  const units = Array.from(note.trim());
  return units.length <= max ? units.join('') : units.slice(0, max).join('');
}

/**
 * A LOUD notice when a write was clipped to the storage cap, else null
 * (ticket f3e56567, 2026-10-30).
 *
 * The cap itself is a8d6e514's intended contract: a standing loop stamps its
 * continuation ledger and only the first `progressNoteMax()` chars are kept,
 * which the a8d6e514 replay pins ("a note past 2,000 chars is stored at
 * exactly 2,000"). Raising it to a hard refusal would break that contract and
 * every standing loop that relies on it.
 *
 * What is NOT acceptable is the SILENCE. The reference ticket's acceptance bar
 * is "land byte-intact … or fail loudly with a length error", and a call whose
 * tail vanishes while the tool reports plain success satisfies neither arm —
 * the caller walks away believing the whole note landed. Observed live
 * 2026-10-30 on a deployed build: a 2,604-char glyph-rich note came back as
 * exactly 2,000 chars, ending mid-line, with no error anywhere.
 *
 * So the write still succeeds and still stores the prefix (contract intact),
 * but the RESULT now says so, names the cap and the lost tail length, and
 * tells the caller where the overflow can actually live. Counts only — a note
 * is user prose and must never be echoed back.
 *
 * `requested` is what the caller sent; `stored` is what the row ended up with
 * (the ground truth: `''`/null-stored clears are not clips). Pure.
 */
export function progressNoteClipNotice(requested: unknown, stored: unknown): string | null {
  if (typeof requested !== 'string') return null;
  const units = Array.from(requested.trim());
  const max = progressNoteMax();
  if (units.length <= max) return null;
  const kept = typeof stored === 'string' ? Array.from(stored).length : 0;
  const lost = units.length - kept;
  return `[progressNote CLIPPED] ${units.length} chars sent, ${kept} stored (cap ${max}) — the last ${lost} chars did NOT land. `
    + 'The write succeeded, but do NOT treat this note as complete: keep the next note under '
    + `${max} chars, or carry the overflow in the supervisor-state doc (update_supervisor_state) `
    + 'or a follow-up note.';
}

/**
 * The part of a note the deterministic readers parse — the HOLD / HELD /
 * BLOCKED lead-marker detectors and the progress-fraction parser: the first
 * PROGRESS_NOTE_DISPLAY_MAX chars, raw (exactly what they read when the
 * storage cap was 200). '' for a missing note. Pure.
 */
export function progressNoteLead(note: unknown): string {
  if (typeof note !== 'string') return '';
  return note.length <= PROGRESS_NOTE_DISPLAY_MAX ? note : note.slice(0, PROGRESS_NOTE_DISPLAY_MAX);
}
