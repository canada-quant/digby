/**
 * terminal-stop.ts — the machine-lane TERMINAL-STOP contract (feedback 065caccb).
 *
 * The failure (observed 2026-09-15 evening across the fleet): after a dispatched
 * ticket/batch was closed done WITH evidence, the lane kept re-verifying the
 * closed work on later scheduled firings — the firing's (machine-authored,
 * days-old) prompt still named the ticket, and nothing in the wake told the run
 * the work was TERMINAL. Lane b92ef13f produced two full re-audits of the closed
 * 6fac1460 batch (one inside a DMG-watch firing whose brief even said "stop
 * quietly"); lane e8b27fcd looped 4 echo continuations on closed 7503189b.
 *
 * The contract: at FIRE time (schedule.service fireScheduleTarget — the single
 * seam every schedule firing AND hook wake funnels through) scan the fully
 * decorated prompt for feedback-ticket references, resolve each against the
 * live ticket store, and append a [TERMINAL-STOP] block for every one that is
 * already status=done. Advisory by design — never a skip: a watch's own OPEN
 * criteria still run (the 20:18Z DMG-watch firing is the shape to preserve);
 * the block only forbids re-spending the firing on the closed items. The
 * fb8b609f continuation-staleness guard is the direct precedent (a stale wake
 * burning a run re-auditing a completed board); this generalizes it from
 * [HARNESS CONTINUATION] plan boards to ANY ticket ref in ANY machine wake.
 *
 * Pure leaf (no imports) so it is unit-testable without the prisma/graph —
 * the fire-time resolver is injected by the caller. Same discipline as
 * agent-send-header.ts / machine-wake.ts.
 */

/** Position-0 literal the injected block starts with. */
export const TERMINAL_STOP_PREFIX = '[TERMINAL-STOP';

/** Hard caps — a pathological prompt never fans the scan into N lookups. */
export const MAX_TICKET_REFS = 8;

/** Most tickets listed by name in one block (overflow is counted, not named). */
export const MAX_LISTED = 5;

const TITLE_MAX = 80;
const NOTE_SNIPPET_MAX = 140;

/** One CLOSED ticket the firing's prompt referenced (resolved live at fire time). */
export interface ClosedTicketRef {
  /** Full ticket id (the resolver's expansion of whatever prefix/uuid the prompt carried). */
  id: string;
  /** Ticket title, if any. */
  title?: string | null;
  /** Last write on the row — for a done ticket, usually the close. */
  updatedAt?: Date | string | null;
  /** Closing adminNote (the evidence trail), if any. */
  adminNote?: string | null;
}

/** Full UUID anywhere in the prompt (keyword-free — uuids are self-identifying). */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Keyword-gated hex refs: `ticket 6fac1460`, `ticket batch 6fac1460`,
 * `closed ticket 7503189b`, `feedback 065caccb-a3c5-…`. The ticket-ish keyword
 * is REQUIRED — a bare 8-hex in a prompt is far more often a commit sha or
 * schedule id than a ticket prefix, and the keyword gate is what keeps the
 * scan from decorating deploy-watch prompts (which name shas, never tickets).
 * The capture starts immediately after the keyword separator, so a 9+ hex run
 * fails the trailing lookahead and never yields a SHIFTED 8-char false prefix.
 */
const KEYWORD_REF_RE = /(?:\btickets?\b(?:\s+batch)?|\bbatch\b|\bfeedback\b)\s*(?:id\s*)?#?\s*\(?\s*([0-9a-f]{8}(?:-[0-9a-f]{4}){0,4})(?![0-9a-f-])/gi;

/**
 * Pull the candidate feedback-ticket refs out of a firing prompt: full UUIDs
 * (kept whole) and keyword-gated hex refs (normalised to their leading 8 — the
 * fleet's prefix idiom; the resolver prefix-matches ≥8). Deduped, capped at
 * MAX_TICKET_REFS. Resolution (does a row exist, is it done?) is the CALLER's
 * job — this is text extraction only, and it never throws.
 */
export function extractTicketRefs(prompt: string): string[] {
  if (typeof prompt !== 'string' || !prompt) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (normalized: string) => {
    if (out.length >= MAX_TICKET_REFS || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };
  for (const m of prompt.matchAll(UUID_RE)) push(m[0].toLowerCase());
  for (const m of prompt.matchAll(KEYWORD_REF_RE)) {
    const raw = (m[1] || '').toLowerCase();
    push(raw.length > 8 ? raw.replace(/-/g, '').slice(0, 8) : raw);
  }
  return out;
}

/** One-line, bracket-safe rendering (the block is ONE bracketed line — inner ']'/newlines from titles/notes would corrupt it). */
function safe(text: unknown, max: number): string {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[\r\n\]"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function isoOrUnknown(value: Date | string | null | undefined): string {
  if (!value) return 'unknown';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString();
}

/**
 * Render the [TERMINAL-STOP] block for the tickets a fire-time scan found
 * already CLOSED. Deterministic text — the standing "do not re-audit closed
 * work; a verified completion is terminal" clause (the ticket's recommendation
 * #2), attached only when it has something concrete to point at.
 */
export function buildTerminalStopNotice(closed: ClosedTicketRef[], now: Date): string {
  const listed = closed.slice(0, MAX_LISTED);
  const items = listed.map((t) => {
    const bits: string[] = [t.id.slice(0, 8)];
    const title = safe(t.title, TITLE_MAX);
    if (title) bits.push(`'${title}'`);
    bits.push(`last update ${isoOrUnknown(t.updatedAt)}`);
    const note = safe(t.adminNote, NOTE_SNIPPET_MAX);
    if (note) bits.push(`close note: '${note}'`);
    return bits.join(' · ');
  });
  const more = closed.length > listed.length ? ` (+${closed.length - listed.length} more — get_feedback by id for those)` : '';
  return (
    `${TERMINAL_STOP_PREFIX} — harness-verified at fire time ${now.toISOString()}] ` +
    `This firing's prompt references feedback ticket(s) that are already CLOSED (status=done): ${items.join(' | ')}${more}. ` +
    `A verified completion is TERMINAL — do NOT re-audit, re-probe, re-verify, re-merge, re-deploy-check, or re-close that work this firing, and do NOT re-narrate its old evidence as freshly re-verified (the claim guard reads a re-run of closed work as unevidenced narration). ` +
    `Cite this notice and spend the firing only on work that is still OPEN. ` +
    `Sole exceptions: this prompt EXPLICITLY orders a re-check of a listed ticket by id, or you hold NEW evidence the closure was wrong — then name that evidence and record a file_feedback sighting; never silently re-open old work.`
  );
}
