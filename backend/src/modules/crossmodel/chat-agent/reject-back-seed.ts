/**
 * Reject-back retry SEED (autonomy loop #11, 2026-09-20) — make the bounded
 * re-orchestration a REWRITE, not a re-run.
 *
 * THE COST: when the machine-wake integrity guard strikes a supervisor's note
 * pre-delivery (deterministic future-clock / fabricated-citation lanes — owner
 * directive cdd3fbfe: fail-closed at commit), the seam re-orchestrates ONCE
 * with the rejection notice appended to the SAME wake message. The model saw
 * only the notice — not its own draft, not the tool results it had already
 * gathered — so it redid the whole wake: every read, every probe. Live
 * 2026-09-20: 38 such retries in 24 h across the supervisors (retries clean
 * 38/39); one on the crossmodel Supervisor ran 11:35Z → 11:51Z, sixteen
 * minutes during which its hook backlog kept starving.
 *
 * THE SEED: the retry's user turn additionally carries (a) the rejected draft,
 * quoted line-by-line so the guard's quoted-void exemption covers any struck
 * clock the model echoes while reading it, and (b) this run's tool RESULT
 * texts, compact and capped — the same texts the seam already hands the
 * second-pass guard as cross-attempt provenance (extraEvidenceHaystacks), so
 * an honest re-citation of them passes. The instructions ask for a rewrite
 * plus ONE fresh evidence read (a fresh clock and the zero-tool gate's
 * evidence-bearing call), never a repeat of the whole wake. Pure.
 */

export const SEED_MAX_DRAFT_CHARS = 6_000;
export const SEED_MAX_TOOL_CHARS = 12_000;
export const SEED_MAX_PER_RESULT_CHARS = 1_500;
export const SEED_MAX_RESULTS = 24;

export const REJECT_BACK_SEED_HEADER = '[HARNESS — YOUR REJECTED ATTEMPT, FOR REWRITING — not typed by the user]';
/**
 * The struck-note REPEAT mode's header (tickets 4c7aebf7 + 9a976d83, round-2 nit): that retry is NOT a rewrite —
 * the draft is a re-post of a struck note and the repeat notice asks for fresh tool calls on every flagged claim —
 * so it carries no draft and its tool results are reference, never "still valid — do not re-fetch".
 */
export const REPEAT_SEED_HEADER = '[HARNESS — THIS RUN\'S TOOL RESULTS, FOR REFERENCE — not typed by the user]';

interface PartLike { type?: string; name?: string; result?: unknown; args?: unknown; [extra: string]: unknown }

/** tool_result parts paired with the nearest preceding tool_call's name when the result carries none. */
export function collectToolResults(parts: PartLike[] | null | undefined): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  let lastCallName = '';
  for (const p of Array.isArray(parts) ? parts : []) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'tool_call') { lastCallName = String(p.name ?? '') || lastCallName; continue; }
    if (p.type === 'tool_result' && typeof p.result === 'string' && p.result.trim()) {
      out.push({ name: String(p.name ?? '') || lastCallName || 'tool', text: p.result });
    }
  }
  return out;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\r/g, '');
  return t.length <= max ? t : `${t.slice(0, max)}\n…[${t.length - max} more chars not shown]`;
}

/**
 * Build the seed block, or '' when there is nothing worth seeding (no draft
 * and no tool results). Deterministic; never throws.
 */
export function buildRejectBackRetrySeed(
  parts: PartLike[] | null | undefined,
  draft: string | null | undefined,
  opts: { maxDraftChars?: number; maxToolChars?: number; maxPerResult?: number; maxResults?: number; mode?: 'rewrite' | 'repeat' } = {},
): string {
  const repeatMode = opts.mode === 'repeat';
  // Repeat mode never carries the draft (it IS the re-posted struck note — "rewrite it" invites the same copy).
  const draftText = repeatMode ? '' : String(draft ?? '').trim();
  const results = collectToolResults(parts);
  if (!draftText && !results.length) return '';
  const maxDraft = opts.maxDraftChars ?? SEED_MAX_DRAFT_CHARS;
  const maxTool = opts.maxToolChars ?? SEED_MAX_TOOL_CHARS;
  const maxPer = opts.maxPerResult ?? SEED_MAX_PER_RESULT_CHARS;
  const maxResults = opts.maxResults ?? SEED_MAX_RESULTS;

  const lines: string[] = repeatMode
    ? [
        REPEAT_SEED_HEADER,
        'Your previous answer to THIS wake was NOT delivered (the notice above says why). The tool results below were produced by THIS run: use them as reference for what you already looked at, never as proof of a flagged claim — re-run every step the notice flags with a fresh tool call and cite that fresh result, or write the claim as "attempted, unverified". Every clock and id in your new note must come from the wake line, the [HARNESS CLOCK] note, or a tool result.',
      ]
    : [
    REJECT_BACK_SEED_HEADER,
    'Your previous answer to THIS wake was rejected (the notice above says why) and was NOT delivered. Do not redo the whole wake: the tool results below were produced by THIS run and remain valid evidence — reuse them and REWRITE the note with the struck items fixed. Make ONE fresh evidence-bearing tool call (it gives you the real clock and the observation the notice asks you to re-run); re-run other tools only where the notice requires a fresh observation. Quote nothing from the rejected draft verbatim as fact — every clock and id in your rewrite must come from the wake line, the [HARNESS CLOCK] note, or a tool result.',
  ];
  if (draftText) {
    lines.push('--- REJECTED DRAFT (quoted for rewriting — UNVERIFIED; struck items are NOT DONE) ---');
    lines.push(clip(draftText, maxDraft).split('\n').map((l) => `> ${l}`).join('\n'));
    lines.push('--- END REJECTED DRAFT ---');
  }
  if (results.length) {
    let budget = maxTool;
    const shown: string[] = [];
    for (const r of results.slice(0, maxResults)) {
      if (budget <= 0) break;
      const text = clip(r.text, Math.min(maxPer, budget));
      budget -= text.length;
      shown.push(`[${shown.length + 1}] ${r.name}:\n${text}`);
    }
    lines.push(repeatMode
      ? `--- TOOL RESULTS FROM THIS RUN (${shown.length} of ${results.length} shown; reference only — re-run every step the notice flags) ---`
      : `--- TOOL RESULTS FROM THIS RUN (${shown.length} of ${results.length} shown; still valid — cite them, do not re-fetch them) ---`);
    lines.push(shown.join('\n\n'));
    lines.push('--- END TOOL RESULTS ---');
  }
  return lines.join('\n');
}
