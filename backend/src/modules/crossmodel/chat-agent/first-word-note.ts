/**
 * First-word note — appended to the chat doctrine on every HUMAN turn of a
 * plain chat (ticket 4f7263e4, class fix for the sighting-4 recurrence).
 *
 * Why: the ttft audit's tail is the LEAD'S OWN TOOL LOOP, not the model. The
 * 2026-10-11 prod read (8 turns, p50 114.9 s / p90 235.8 s over the 60 s p50
 * bar) showed every over-bar turn opened with web calls at t=0 — web_pipe
 * alone consumed 73 s / 125 s / 161 s of first-word time — while the turns
 * with NO web call landed at 11.9 s / 18.8 s. The plain-chat doctrine's
 * "Research FIRST … Do not narrate" line read as "write nothing before the
 * tools", so the first word structurally waited for the whole loop; the
 * sse-adapter then dropped what pre-tool prose the model did write. The A1
 * owner-answer-first split (canary since 2026-10-10) covers owner turns on
 * supervisor chats only — this note covers the class: EVERY human turn gets
 * one honest first line before the first tool, and the adapter delivers it.
 *
 * Quick-lane turns are EXCLUDED from this note: their own brief already caps
 * the loop at one search (quick-lane-note.ts) — a second, conflicting opener
 * rule would only blur both. Machine wakes are excluded by the caller (no
 * human is waiting).
 * Kill switch FIRST_WORD_OPENER_DISABLED=1 (the note is not appended; the
 * adapter's opener delivery still works for a model that opens on its own).
 *
 * Ticket afc10e95 (nightly suite 2026-10-15, run 38756194630, seed 20261015):
 * the Quick lane's first-chunk p50 hit 53.4 s against the 45 s bar. All five
 * quick-ran turns ran the correct fast seat (qwen3.6-27b) — the time went to
 * the PRE-WORD WEB LOOP: 1 search ≈ 30.7 s, 2 calls ≈ 39.9 s, 3 calls
 * ≈ 53.4–61.8 s (run.jsonl). The brief's cap is ADVICE the model drifted
 * from before (the 2026-10-06 readout measured the same 3–5-call chains), and
 * the harness cap built for exactly this (web-tool-cap.ts, 1 search + 1
 * fetch) is a store canary that still defaults to shadow — count-only, never
 * refuse. Until the cap is enforced in act, the Quick lane needs the SAME
 * opener the plain-chat doctrine has: one honest first line BEFORE the first
 * search, so the user's first word does not wait on the whole web loop. Same
 * kill switch; the quick variant names the one-search budget the lane runs
 * under, so the two notes agree instead of conflicting.
 */
export const FIRST_WORD_OPENER_DISABLED_ENV = 'FIRST_WORD_OPENER_DISABLED';

export function firstWordNoteEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[FIRST_WORD_OPENER_DISABLED_ENV] !== '1';
}

/** The doctrine row (empty when the kill switch is on). */
export function firstWordNote(env: Record<string, string | undefined> = process.env): string {
  if (!firstWordNoteEnabled(env)) return '';
  return [
    '## First word (this turn)',
    'The user is staring at an empty reply until your first word lands. OPEN WITH ONE USEFUL LINE before your first tool call — then research, then deliver the complete answer as your final message:',
    '- Already certain? Open with the direct answer, then verify and expand it.',
    '- Not certain? Open with your best current take and how confident you are, then verify.',
    '- Genuinely unknowable without looking? Open with what you are about to check and why it decides the answer — never "let me check…" alone.',
    '- ONE line, then your first tool call in the SAME turn. Never open with a question back at the user; never re-open later rounds (mid-turn prose after a tool call is dropped).',
  ].join('\n');
}

/**
 * Quick-lane variant (ticket afc10e95): same opener right, phrased for a
 * lookup turn — the first line must not wait on the web loop. Returns '' when
 * the kill switch is on.
 */
export function quickFirstWordNote(env: Record<string, string | undefined> = process.env): string {
  if (!firstWordNoteEnabled(env)) return '';
  return [
    '## First word (this turn — Quick lane)',
    'The user is staring at an empty reply until your first word lands, and a lookup turn has something useful to say RIGHT NOW. OPEN WITH ONE LINE before your first search — then search, then deliver the complete answer as your final message:',
    '- Already know the answer off-hand? Open with it, then verify with your one search.',
    '- Do not know it? Open with your best current take ("Lisbon is usually mild this time of year — checking the live forecast") — never "let me check…" alone.',
    '- You are on a web budget: one search, one page at most (your lane brief). ONE opening line, then the search in the SAME turn. Never open with a question back at the user; never re-open later rounds (mid-turn prose after a tool call is dropped).',
  ].join('\n');
}
