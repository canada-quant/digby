/**
 * Harness-authored error/fallback note envelopes (ticket 08e58e1d).
 *
 * When a run dies on the model provider (429 budget exhausted, HTTP errors,
 * billing) or comes back empty, the HARNESS — never the lane — writes the
 * final assistant text:
 *
 *   - `modelErrorTerminalNote` (coding/compaction.ts) builds the terminal
 *     error note, in 'user' (chat lanes) or 'operator' (coding lanes) shape;
 *   - chat-agent finalize falls back to EMPTY_RUN_FALLBACK_NOTE when a run
 *     produced no text at all.
 *
 * Those rows persist under the wake's machine origin (schedule/hook/…), so
 * machine readers that scan a lane's "notes" cannot tell them apart from
 * lane-authored output. The concrete mishap: two consecutive Fleet
 * Supervisor machine wakes (2026-09-17 ~14:27Z / ~14:36Z) died on provider
 * 429 and persisted the byte-identical "Sorry — I couldn't get an answer out
 * this time…" fallback; the attention watchdog's stuck-note backstop scored
 * its own platform error text as 3 near-identical SUPERVISOR notes and
 * posted "[WATCHDOG] … act or stand down" against text the supervisor never
 * wrote.
 *
 * This module is the single source of truth for the envelope shapes. It is a
 * LEAF (no imports) so light consumers (the fleet watchdog) never pull the
 * generator's dependency chain (compaction.ts → utility-llm/env). The
 * generator↔detector contract is pinned by test: every shape
 * modelErrorTerminalNote can emit must satisfy isHarnessErrorNote, so a
 * wording change that breaks the prefixes fails loudly instead of silently
 * re-admitting error text into the watchdog's note-similarity input.
 */

/** chat-agent finalize's generic note when a run produced no text at all. */
export const EMPTY_RUN_FALLBACK_NOTE =
  'I wasn\'t able to generate a response for this message. Please try again.';

/** Openings of every harness-authored terminal-note shape. Keep aligned with
 *  modelErrorTerminalNote (coding/compaction.ts) — the contract test pins it. */
const HARNESS_ERROR_NOTE_PREFIXES = [
  // modelErrorTerminalNote, audience 'user' — the 429 shape AND the generic
  // "the AI provider returned an error (HTTP N)" shape share this opening…
  "Sorry — I couldn't get an answer out this time:",
  // …and the over-budget 'user' shape opens like this.
  'Sorry — this conversation has grown too large for the AI model to handle',
  // modelErrorTerminalNote, audience 'operator' (coding lanes).
  'The model kept rejecting the request (',
  // chat-agent finalize's empty-run fallback.
  EMPTY_RUN_FALLBACK_NOTE,
] as const;

/**
 * True when a persisted assistant content IS a harness-authored error/fallback
 * envelope rather than lane-authored text. Deterministic shape-match on the
 * generator's own openings — the companion to the metadata.providerError
 * marker chat-agent stamps on provider-killed rows (this shape-match covers
 * rows persisted BEFORE the marker existed and any path that persists an
 * envelope unmarked). Pure.
 */
export function isHarnessErrorNote(content: unknown): boolean {
  if (typeof content !== 'string' || content.length === 0) return false;
  const s = content.trimStart();
  return HARNESS_ERROR_NOTE_PREFIXES.some((p) => s.startsWith(p));
}
