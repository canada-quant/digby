// BACKEND COPY of frontend/lib/claims-block.ts (minimal view, 2026-10-16): the server strips the same
// harness chrome the frontend peels, so a minimal viewer never receives it. Keep the two in step.
/**
 * Ticket 295068fa (long-running session UI polish) — the harness claim
 * manifest is MACHINE plumbing, not answer prose.
 *
 * Coding-session final reports carry a fenced ```claims … ``` block (the
 * journal-backed evidence guard's claim manifest: a JSON array of {type, ref}
 * receipt pointers the harness auto-verifies). It persists with the message,
 * and until now it rendered as a raw JSON code block under every
 * evidence-carrying final report — the single least professional-looking
 * artifact in long machine runs (owner screenshots 2026-09-13).
 *
 * This pure helper splits the manifest fence off the visible text so the
 * transcript can render it as a quiet, expandable chip instead (COLLAPSE,
 * never filter — the raw block stays one click away, byte-lossless). Display-
 * layer only — nothing here changes what is stored, persisted, or sent to any
 * model.
 *
 * Grammar (owner screenshot 2026-09-18 — a manifest STILL rendering as a raw
 * "CLAIMS" code block): the manifest is located the way the backend's
 * canonical parser locates it (backend/src/modules/crossmodel/coding/
 * claims-block.ts — every ```claims fence in the text, LAST one wins), not
 * only when it is the very last thing in the text. The 2026-09-13 split was
 * trailing-only, so two real shapes slipped through and rendered raw:
 *  - the closing fence GLUED to the next sentence — "```Step 8's verification
 *    is done…" — which markdown does not accept as a closer (a closing fence
 *    may carry no text), so the code block swallowed the rest of the message;
 *    here that line closes the fence and its text rejoins the prose;
 *  - a manifest the model emitted and then kept writing after (prose, tool
 *    calls, a correction) — a manifest followed by prose is still the
 *    manifest; only when there are SEVERAL fences do the earlier ones stay
 *    visible (the model quoting the format, then appending the real one —
 *    adversarial review B1: the intervening prose must never be hidden).
 * An unterminated fence runs to the end of the text (CommonMark), which also
 * covers a manifest still streaming in.
 */

export interface ClaimsSplit {
  /** The text with the manifest fence removed (trimEnd'd). */
  clean: string;
  /** Raw inner JSON of the manifest fence (null when there is no fence). */
  claimsJson: string | null;
  /** Parsed entry count for the chip label (0 when unparseable). */
  entryCount: number;
}

/** Opener: the ```claims tag alone on its line (≤3 spaces of indent, as CommonMark). */
const OPEN_LINE_RE = /^[ \t]{0,3}```claims[ \t]*$/;
/** Closer: a line starting with ``` — anything glued after the backticks is prose (group 1). */
const CLOSE_LINE_RE = /^[ \t]*```(.*)$/;
/**
 * TWO-LINE opener (owner screenshot 2026-09-25 — "i thought we fixed this"):
 * a bare ``` line followed by `claims` alone on the next line. Every recent
 * final wrote the manifest this way (the harness instruction said "a line of
 * three backticks followed by the word claims"); markdown sees a plain code
 * block, so it rendered as a raw "Text" box. Backend parity: coding/claims-
 * block.ts accepts the same shape.
 */
const BARE_FENCE_LINE_RE = /^[ \t]{0,3}```[ \t]*$/;
const CLAIMS_WORD_LINE_RE = /^[ \t]*claims[ \t]*$/;
function openerLinesAt(lines: string[], i: number): number {
  if (OPEN_LINE_RE.test(lines[i])) return 1;
  if (BARE_FENCE_LINE_RE.test(lines[i]) && i + 1 < lines.length && CLAIMS_WORD_LINE_RE.test(lines[i + 1])) return 2;
  return 0;
}

interface ClaimsFence {
  /** Index of the opener line. */
  open: number;
  /** Index of the closer line, or lines.length when unterminated. */
  close: number;
  /** Text glued after the closing backticks (already trimmed), '' when none. */
  glued: string;
  /** Raw body (lines between opener and closer, joined). */
  body: string;
}

function locateClaimsFences(lines: string[]): ClaimsFence[] {
  const out: ClaimsFence[] = [];
  let i = 0;
  while (i < lines.length) {
    const openerLines = openerLinesAt(lines, i);
    if (!openerLines) { i++; continue; }
    const open = i;
    let close = lines.length;
    let glued = '';
    for (let j = open + openerLines; j < lines.length; j++) {
      const m = CLOSE_LINE_RE.exec(lines[j]);
      if (m) { close = j; glued = (m[1] || '').trim(); break; }
    }
    out.push({ open, close, glued, body: lines.slice(open + openerLines, close).join('\n') });
    i = close + 1;
  }
  return out;
}

export function splitTrailingClaimsBlock(text: string): ClaimsSplit {
  const src = text || '';
  if (!src.includes('```claims') && !/```[ \t]*\n[ \t]*claims[ \t]*(?:\n|$)/.test(src)) return { clean: src, claimsJson: null, entryCount: 0 };
  const lines = src.split('\n');
  const fences = locateClaimsFences(lines);
  if (!fences.length) return { clean: src, claimsJson: null, entryCount: 0 };
  // LAST fence wins (backend parity): earlier fences are the model quoting the
  // format and stay visible with the prose between them.
  const fence = fences[fences.length - 1];
  const claimsJson = fence.body.trim();
  let entryCount = 0;
  try {
    const parsed = JSON.parse(claimsJson);
    if (Array.isArray(parsed)) entryCount = parsed.length;
  } catch {
    /* unparseable manifest — still collapse it; count stays 0 */
  }
  const before = lines.slice(0, fence.open).join('\n').replace(/\s+$/, '');
  const afterLines = lines.slice(fence.close + 1);
  const after = [fence.glued, afterLines.join('\n')].filter((s) => s.length > 0).join('\n').trim();
  const clean = [before, after].filter((s) => s.length > 0).join('\n\n');
  return { clean, claimsJson, entryCount };
}

/** One manifest entry as the footer lists it — {type, ref} receipt pointers. */
export interface ClaimEntry {
  type?: string;
  ref?: string;
}

/**
 * Parse the manifest JSON into display entries (owner ask 2026-09-14 — the
 * VerificationFooter lists "pr #134 · push abc123" chips instead of a raw
 * fence). Tolerant: a non-array or unparseable manifest yields []; entries
 * that are not objects are skipped; type/ref are coerced to strings only when
 * they are string/number. Never throws.
 */
export function parseClaimsEntries(claimsJson: string | null | undefined): ClaimEntry[] {
  if (!claimsJson) return [];
  try {
    const parsed = JSON.parse(claimsJson);
    if (!Array.isArray(parsed)) return [];
    const out: ClaimEntry[] = [];
    for (const e of parsed) {
      if (!e || typeof e !== 'object') continue;
      const type = typeof e.type === 'string' ? e.type : undefined;
      const ref = typeof e.ref === 'string' || typeof e.ref === 'number' ? String(e.ref) : undefined;
      out.push({ ...(type ? { type } : {}), ...(ref ? { ref } : {}) });
    }
    return out;
  } catch {
    return [];
  }
}
