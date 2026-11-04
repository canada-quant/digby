/**
 * Fleet-summary parsing (platform task 2026-09-03 — the dashboard card):
 * derive the card's collapsed-state rendering from a supervisor wake note's
 * RAW durable-transcript content — pure extraction, never a rewrite or a
 * second summarizer pass (the card must show exactly what the chat shows).
 *
 *   headline — the first meaningful line, markdown emphasis/heading markers
 *              stripped ("**Fleet wake — 2 lanes green**" → "Fleet wake — 2
 *              lanes green"), capped. Mirrors machine-turn-grouping.ts's
 *              buildHeadline so the card and the accordion label agree.
 *   chips    — up to MAX_CHIPS subsequent status-looking lines (bullet/emoji/
 *              digit-led), whitespace-collapsed, each capped — the per-lane
 *              status icons/chips of the collapsed card.
 */

const MAX_HEADLINE = 90;
const MAX_CHIPS = 4;
const MAX_CHIP = 64;

function clean(line: string): string {
  return line.trim().replace(/^[#>\s\-*•]+/, '').replace(/\*+$/, '').trim();
}

function cap(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** A line worth chipping: bullet, numbered, or emoji-led status. */
function isStatusLine(raw: string): boolean {
  const t = raw.trim();
  return /^[-*•]/.test(t) || /^\d+[.)]/.test(t) || /^[^\w\s[\]('#"]/u.test(t);
}

/** A markdown table row: starts with a pipe (after trim). */
function isTableRow(raw: string): boolean {
  return /^\s*\|/.test(raw);
}

/** A markdown table SEPARATOR row: pipes/dashes/colons/spaces only (e.g. "|---|:---|"). */
function isTableSeparatorRow(raw: string): boolean {
  const t = raw.trim();
  return t.length > 0 && /^\|?[\s:|-]+\|?$/.test(t) && t.includes('-');
}

/** Split a markdown table row into trimmed, non-empty cell texts. */
function tableCells(raw: string): string[] {
  return raw.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter((c) => c.length > 0);
}

/**
 * Action-verifier / evidence-guard chrome inside a struck note (owner bug
 * 2026-09-04): conviction explanations, struck-citation blocks, ⛔ removed-line
 * markers, and the quoted audit copy must never become headlines or chips.
 * The board-STATUS strike class (ticket e4138a3d, reviewer F1) renders its own
 * prose — "Struck board assertion(s):" detail blocks and the "The struck
 * assertion(s) mis-stated board state …" advice line — masked identically.
 */
function isGuardChromeLine(raw: string): boolean {
  const t = raw.trim();
  return t.startsWith('⛔')
    || t.startsWith('> ')
    || t.startsWith('--- BEGIN STRUCK NOTE')
    || t.startsWith('--- END STRUCK NOTE')
    || /^this machine-triggered run's final note/i.test(t)
    || /^struck (fabricated citation|miscited citation|phantom claim|board assertion)/i.test(t)
    || /^the struck (citation|claim|assertion)\(s\)/i.test(t)
    || /\[line removed by the action verifier/i.test(t);
}

/**
 * Chrome-mask over a struck note's lines: single-line chrome (above) plus the
 * struck-citation DETAIL BLOCK — every non-blank line following a
 * "Struck fabricated citation(s):" / "Struck phantom claim(s):" /
 * "Struck board assertion(s):" line (ticket e4138a3d) until the next blank
 * line (those rows are the verifier's evidence citations, e.g.
 * "WAKE 02:14:22Z (wake-line clock): …" — never headlines/chips).
 */
function guardChromeMask(lines: string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let inStruckBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.length === 0) { inStruckBlock = false; continue; }
    if (isGuardChromeLine(lines[i])) {
      mask[i] = true;
      if (/struck (fabricated citation|miscited citation|phantom claim|board assertion)/i.test(t)) inStruckBlock = true;
      continue;
    }
    if (inStruckBlock) mask[i] = true;
  }
  return mask;
}

export interface FleetWakeSummary {
  headline: string;
  chips: string[];
  /** The remaining body below the headline (for the expanded state). */
  body: string;
}

export function parseSupervisorWakeNote(content: string): FleetWakeSummary {
  const lines = (content || '').split('\n');
  let headIdx = -1;
  let headline = '';
  // Guard-chrome lines never headline or chip (owner bug 2026-09-04: a
  // verifier-struck note's conviction explanation + citation details became
  // the card headline and chips). The expanded body stays verbatim.
  const chrome = guardChromeMask(lines);
  for (let i = 0; i < lines.length; i++) {
    if (chrome[i]) continue;
    const c = clean(lines[i]);
    if (c.length > 0 && !c.startsWith('[')) {
      headIdx = i;
      headline = cap(c, MAX_HEADLINE);
      break;
    }
  }
  const chips: string[] = [];
  if (headIdx >= 0) {
    for (let i = headIdx + 1; i < lines.length && chips.length < MAX_CHIPS; i++) {
      const raw = lines[i];
      // Markdown tables (the supervisor's wake notes are full of them — live
      // prod showed "| Item | Status | Detail |" and "|---|---|---|" rendered
      // as chips, owner polish 2026-09-03): skip separator rows outright, skip
      // the header row (the row a separator immediately follows), and turn
      // DATA rows into a compact "first two cells" chip — that pair is the
      // label + status ("Fleet ✅ 61 chats"); the detail cell belongs to the
      // expanded body, not a chip.
      if (chrome[i]) continue;
      if (isTableSeparatorRow(raw)) continue;
      if (isTableRow(raw)) {
        if (isTableSeparatorRow(lines[i + 1] ?? '')) continue; // header row
        const cells = tableCells(raw);
        const c = cells.slice(0, 2).join(' ').replace(/\*\*/g, '').trim();
        if (c.length > 0) chips.push(cap(c, MAX_CHIP));
        continue;
      }
      if (!isStatusLine(raw)) continue;
      const c = clean(raw).replace(/^\d+[.)]\s*/, '').replace(/\*\*/g, '').trim();
      if (c.length > 0 && !c.startsWith('[')) chips.push(cap(c, MAX_CHIP));
    }
  }
  return {
    headline,
    chips,
    body: headIdx >= 0 ? lines.slice(headIdx + 1).join('\n').trim() : (content || '').trim(),
  };
}

/* ── Wake-headline classification + collapsed-label cleanup (owner polish
 * pass 2026-09-03) — SHARED by the dashboard FleetSummaryCard and the
 * machine-turn accordion (MachineTurnGroup) so the two surfaces can never
 * drift (the card previously carried its own local `failed` regex). Pure
 * render-time functions — nothing here changes what is stored or sent. ── */

/** Semantic tone of a parsed wake headline:
 *  'quiet'     — the sweep found nothing (dim it),
 *  'attention' — something failed/blocked/stalled (warm accent),
 *  'action'    — the supervisor DID something (indigo accent). */
export type WakeTone = 'quiet' | 'attention' | 'action';

/** Nothing-happened phrasings — checked FIRST, so a headline whose verdict is
 *  "no owner action" stays quiet even when it mentions a recovered failure. */
// 2026-09-29: + the project supervisors' own quiet phrasings seen in the
// benchmarks recording ("healthy, no action needed", "nothing needs the owner").
const QUIET_RE = /no owner action|all lanes idle|sweep healthy|no.?op|nothing (new|changed)|no action needed|nothing needs (?:you|the owner)/i;
/** Trouble words, matched at word START (no trailing \b) so inflections —
 *  "failed", "errors", "stalled", "interrupted", "blocked", "strikes" —
 *  classify too (the production interrupted-turn row is past-tense). */
const ATTENTION_RE = /\b(fail|error|block|stall|interrupt|attention|phantom|strike)/i;

/**
 * Classify a wake-note headline for render-time tinting. Ordered: quiet →
 * attention → action ('action' is the everything-else default — an empty
 * headline classifies 'action' too; callers with no headline at all should
 * keep neutral styling rather than calling this with '').
 */
export function classifyWakeHeadline(headline: string): WakeTone {
  const h = (headline || '').trim();
  if (QUIET_RE.test(h)) return 'quiet';
  if (ATTENTION_RE.test(h)) return 'attention';
  return 'action';
}

/**
 * Embedded-timestamp prefix: "Fleet sweep — Sep 3, 05:12Z: …" (the row chrome
 * already renders its own time, so the label drops the date portion). The
 * date part must contain a DIGIT — "Fleet sweep — all lanes idle: details"
 * is prose, not a stamp, and must survive untouched.
 */
const EMBEDDED_STAMP_RE = /^(fleet (?:sweep|wake))\s*[—–-]\s*(?=[^:]{0,29}\d)[^:]{1,30}(?::\d{2}){0,2}\s*Z?:\s*/i;

/**
 * Collapsed-label cleanup (display only — expanded notes stay verbatim):
 *  - strips markdown emphasis tokens (**, __, backticks) so "⚠ **This turn
 *    was interrupted**" renders plain (the ⚠ emoji survives);
 *  - de-duplicates the embedded timestamp: "Fleet sweep — Sep 3, 05:12Z: rest"
 *    → "Fleet sweep · rest" (the row renders its own time already).
 */
export function cleanWakeLabel(label: string): string {
  let s = (label || '').replace(/\*\*|__|`/g, '').trim();
  const m = s.match(EMBEDDED_STAMP_RE);
  if (m) s = `${m[1]} · ${s.slice(m[0].length)}`.trim();
  return s;
}
