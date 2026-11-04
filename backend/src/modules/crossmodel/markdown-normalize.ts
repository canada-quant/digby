/**
 * markdown-normalize — repair degraded model markdown at PERSIST time so every
 * surface (chat, shared-chat page, profile history, exports) stores clean
 * CommonMark even when a model emitted collapsed whitespace.
 *
 * Why (feedback fc841f58 / 5393e948, 2026-08): in long conversations the
 * answering models progressively stop emitting the blank lines markdown
 * requires — first collapsing `\n\n` to `\n` before headings/lists, and in the
 * worst turns emitting the whole structured answer on ONE line ("intro ##
 * Heading - item"). CommonMark then renders `##` / `-` / `|` as literal
 * characters. The frontend renderer tolerates this too (its own normalizer),
 * but persisting clean text fixes every non-MarkdownContent surface and keeps
 * conversation history well-formed for the NEXT turn's context (models mimic
 * the history's formatting — degraded history breeds more degradation).
 *
 * KEEP IN SYNC with the renderer-side port:
 *   frontend/lib/markdown-normalize.ts  (behavior + test expectations)
 *
 * Deliberately conservative + idempotent:
 *   - blank line inserted before an ATX heading / thematic break / table that
 *     directly follows a non-blank line (also converts accidental setext —
 *     "text\n---" would otherwise render the text as a giant H2);
 *   - blank line inserted before a list item following a non-list, non-blank
 *     line; consecutive list items stay tight;
 *   - mid-line " ## " splits repair fully-collapsed single-line answers
 *     (skipped on lines containing backticks — never split inline code);
 *   - run-on headings are DEMOTED to plain prose (feedback 814809bf): a
 *     >160-char ATX line is a heading + whole paragraph fused on one
 *     period-free line, which CommonMark renders as one giant bold H2 — the
 *     "all bold" symptom. Only the marker is stripped (demotion REMOVES a
 *     structural claim; no safe mechanical heading/body boundary exists to
 *     split at, and a wrong split would manufacture structure);
 *   - 3+ newlines collapse to 2;
 *   - fenced code blocks and [CANVAS]/[SEND_EMAIL]/[FOLLOWUPS] regions are
 *     NEVER touched (code + user-bound email content stay byte-identical);
 *   - mid-line "- " / "2. " are NOT split (too many false positives in prose)
 *     — EXCEPT the 44204e09 flattened-list repair, gated to the incident's
 *     exact signature (bold-led markers, colon-introduced, ≥2 per line);
 *   - 44204e09 round 2: delimiter-less collapsed tables are REBUILT — rows
 *     joined by 'end-pipe SPACE start-pipe' are split one per line (gated on
 *     consistent cell counts, so a bogus split fails safe), and a header
 *     glued onto a prose line gets its missing '|---|---|' delimiter
 *     SYNTHESIZED from its own cell count (unlike fdd85bb3's delimiter-drop:
 *     here the cells are pipe-delimited, so the column boundaries are real
 *     and the delimiter claims nothing the pipes don't);
 *   - 7b7480fc round 3: one-line tables that INCLUDE their delimiter row
 *     ('| H | H | |---|---| | a | b | …' — the 2026-08-29 wake-note
 *     regression) are REFLOWED whole — header, delimiter, one data row per
 *     line — gated on uniform pipe cell counts across header/delimiter/every
 *     row, falling back to the fdd85bb3 delimiter-drop when the gate fails.
 *     Round 3 also re-lines flattened DASH-LED BOLD-LABEL lists whose intro
 *     lost its colon ('…watch: - **Lane:** … - **Lane:** …'): the
 *     '- **Label:**' marker is the model's own list-item claim, so ≥2 of
 *     them (≥1 when the line already starts as a list item) re-line as real
 *     bullets. Numbered markers stay gated on the bold-adjacent intro colon
 *     (B1: '2 **x** and 1 **y**' is ordinary prose).
 */

import { repairWallOfText, WALL_MIN_CHARS } from './wall-of-text';

// Regions whose content must stay byte-identical: canvas artifacts (may hold
// code), email drafts (user-bound text), follow-up blocks. An unterminated
// open tag protects to end-of-string.
const PROTECTED_REGION_RE =
  /\[(?:CANVAS(?::[^\]\n]*)?|SEND_EMAIL(?:[^\]\n]*)?|FOLLOWUPS)\][\s\S]*?(?:\[\/(?:CANVAS|SEND_EMAIL|FOLLOWUPS)\]|$)/gi;

// Fence detection is blockquote-aware (ticket 65a0b4d5): the renderer opens
// fences inside blockquotes ('> ```js' — up to 3 leading spaces, then any run
// of '>'/' >' markers, then the fence), so the normalizer must track them too
// or it manufactures '## ' headings out of fence content lines.
//   group 1 = the blockquote prefix (possibly empty),
//   group 2 = the fence characters (char + length drive closer matching).
const FENCE_RE = /^ {0,3}((?:> ?)*)(`{3,}|~{3,})/;
// 65a0b4d5: leading blockquote prefix of any line (for fence-content tests).
const BQ_LINE_PREFIX_RE = /^ {0,3}((?:> ?)+)/;
const ATX_RE = /^ {0,3}#{1,6}(?:\s|$)/;
// Thematic breaks: -, *, _ runs. '=' is deliberately NOT here — '===' is never
// an HR in CommonMark, it's a setext H1 underline, and blank-separating it
// turns valid output into literal junk (adversarial review M1).
const HR_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
// Setext H1 underline — deliberately NOT in HR_RE (see above). It is only
// blank-separated when the PREVIOUS line was demoted in this pass
// (adversarial review F2): a demoted run-on becomes a paragraph, and a
// directly-following '===' would manufacture a giant setext H1 out of it.
const SETEXT_UNDERLINE_RE = /^ {0,3}=+\s*$/;
const ULIST_RE = /^ {0,3}[-*+](?:\s|$)/;
const OLIST_RE = /^ {0,3}\d{1,9}[.)](?:\s|$)/;
const TABLE_ROW_RE = /^ {0,3}\|/;
const LIST_CONT_RE = /^ {2,}\S/; // indented continuation of a list item
const MIDLINE_HEADING_RE = / +(?=#{2,6} \S)/g;
// Run-on-heading demotion (feedback 814809bf): real model headings are
// essentially always <100 chars; the degraded run-ons (heading + entire
// paragraph fused on one period-free line) run 400–2400 chars. 160 splits
// them with a wide margin. UTF-16 .length is fine for a heuristic.
const MAX_HEADING_LINE_LEN = 160;
const ATX_STRIP_RE = /^ {0,3}#{1,6}(?:\s+|$)/;
// Blockquote-prefixed ATX (ticket c8664ff9 follow-up 1): a run-on '> ## …'
// line renders as a giant heading INSIDE the blockquote — ATX_RE doesn't
// match '>'-prefixed lines. Demotion strips the marker but keeps the quote
// prefix so the prose stays inside the blockquote.
const BQ_ATX_RE = /^ {0,3}(?:> ?)+#{1,6}(?:\s|$)/;
const BQ_ATX_STRIP_RE = /^ {0,3}((?:> ?)+)#{1,6}(?:\s+|$)/;
// ATX closing sequence (follow-up 3): CommonMark strips a trailing ' ##'
// from a real heading; when the marker is demoted to prose the literal tail
// would survive, so strip it in the same pass.
const ATX_CLOSING_RE = /\s+#+\s*$/;

/**
 * Run-on-heading demotion (814809bf + c8664ff9 follow-ups): strips the ATX
 * marker from an over-long heading line so it renders as plain prose. Loops
 * for stacked markers (F1: '## ## …' would keep a marker after one pass),
 * handles blockquote-prefixed markers (follow-up 1, keeping the '> ' prefix),
 * and strips a trailing ATX closing sequence (follow-up 3). Demotion REMOVES
 * a structural claim — no safe mechanical heading/body boundary exists.
 */
function demoteRunOnHeading(line: string): { text: string; demoted: boolean } {
  let text = line;
  let demoted = false;
  while (text.length > MAX_HEADING_LINE_LEN && (ATX_RE.test(text) || BQ_ATX_RE.test(text))) {
    text = text.replace(ATX_STRIP_RE, '').replace(BQ_ATX_STRIP_RE, '$1');
    demoted = true;
  }
  if (demoted) text = text.replace(ATX_CLOSING_RE, '');
  return { text, demoted };
}

type Segment = { text: string; protect: boolean };

function splitProtected(src: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  PROTECTED_REGION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROTECTED_REGION_RE.exec(src))) {
    if (m.index > last) segments.push({ text: src.slice(last, m.index), protect: false });
    segments.push({ text: m[0], protect: true });
    last = m.index + m[0].length;
  }
  if (last < src.length) segments.push({ text: src.slice(last), protect: false });
  return segments;
}

const isBlank = (line: string) => line.trim() === '';
const isListItem = (line: string) => ULIST_RE.test(line) || OLIST_RE.test(line);

/** Count the '>' blockquote markers in a matched FENCE_RE prefix (group 1). */
function bqMarkerCount(prefix: string): number {
  let n = 0;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] === '>') n++;
  return n;
}

/**
 * Repair fully-collapsed single-line answers ("ruleset: ## Setup … ### Details
 * …") by splitting mid-line heading markers onto their own lines. Conservative
 * guards after adversarial review (M2) — a wrong split manufactures a giant
 * heading out of prose, which is the exact symptom this module exists to fix:
 *   - 2–6 hashes only ('team is # 1' is prose, not a heading);
 *   - at least TWO markers on the line (a lone ' ## ' is ambiguous; collapsed
 *     structures always carry several);
 *   - never inside a bold span (odd count of '**' before the marker);
 *   - never on lines with leading whitespace (4-space indented code blocks);
 *   - never on lines containing backticks (inline code).
 */
function splitCollapsedHeadings(line: string): string[] {
  if (line.includes('`') || /^\s/.test(line)) return [line];
  MIDLINE_HEADING_RE.lastIndex = 0;
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = MIDLINE_HEADING_RE.exec(line))) {
    const boldMarks = line.slice(0, m.index).split('**').length - 1;
    if (boldMarks % 2 === 0) indices.push(m.index);
  }
  if (indices.length < 2) return [line];
  const parts: string[] = [];
  let prev = 0;
  for (const i of indices) {
    parts.push(line.slice(prev, i).replace(/\s+$/, ''));
    prev = i;
  }
  parts.push(line.slice(prev));
  return parts.map((p) => p.replace(/^\s+/, '')).filter((p) => p.length > 0);
}

// Mid-line collapsed-table tell (feedback fdd85bb3): a table DELIMITER row that
// does not start its own line — '|' followed by ≥2 dash-cells. Alignment
// colons and inner spacing allowed. A well-formed table's delimiter is always
// at line start (TABLE_ROW_RE territory), so a mid-line match is never a real
// table — it is the collapsed form's only recoverable landmark.
const MIDLINE_TABLE_DELIM_SOURCE = String.raw`\|(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?`;
const MIDLINE_TABLE_DELIM_RE = new RegExp(MIDLINE_TABLE_DELIM_SOURCE, 'g');
// Non-global twin for .test() — a shared /g regex carries lastIndex across calls.
const MIDLINE_TABLE_DELIM_TEST_RE = new RegExp(MIDLINE_TABLE_DELIM_SOURCE);

/**
 * Repair collapsed one-line tables (feedback fdd85bb3 — supervisor wake notes
 * rendering as 'Item Status Detail |---|---|--- cells flowing as prose…'):
 * the model emitted a whole table on ONE line — pseudo-header words with the
 * pipes dropped, the literal delimiter, and every cell undelimited. The cell
 * boundaries are unrecoverable, so the table can NOT be reconstructed; the
 * faithful repair is to DROP the delimiter (pure markdown noise in this
 * position — demotion doctrine: removing a false structural claim, never
 * manufacturing one) and break the line there so the pieces render as
 * separate paragraphs instead of one pipe-littered wall.
 * Guards (mirroring splitCollapsedHeadings):
 *   - a delimiter at line start is a REAL table — never touched;
 *   - never on lines with leading whitespace (4-space indented code);
 *   - never inside inline code (odd backtick count before the delimiter).
 *     Deliberately NOT the blanket backtick skip the heading split uses: the
 *     incident class (wake notes) carries backticked lane ids on the very
 *     lines that need repair, and '\|---\|' inside inline code is vanishingly
 *     rare next to '## ' inside it;
 *   - ≥2 delimiter cells required, so prose like 'a |---| b' stays prose.
 * Returns the parts with blank-line separators embedded as '' elements (the
 * caller's line loop passes those through as paragraph breaks).
 */
function splitCollapsedTables(line: string): string[] {
  // 7b7480fc round 3 (tried FIRST — these collapsed lines START with a pipe,
  // so the TABLE_ROW_RE early return below would otherwise skip them): a
  // pipe-delimited one-line table that includes its delimiter row is reflowed
  // whole; null falls through to the fdd85bb3 delimiter-drop untouched.
  const rebuilt = rebuildOneLineTable(line);
  if (rebuilt) return rebuilt;
  // Never touch blockquoted lines (adversarial review B1+N4): TABLE_ROW_RE
  // doesn't see the quote prefix, so a quoted REAL table ('> |---|---|')
  // would look mid-line and lose its delimiter row, and splitting quoted
  // prose would manufacture an UNQUOTED tail line (content escaping the
  // blockquote). Quoted literal pipes stay as-is — no damage, no repair.
  if (/^\s/.test(line) || TABLE_ROW_RE.test(line) || BQ_LINE_PREFIX_RE.test(line)) return [line];
  MIDLINE_TABLE_DELIM_RE.lastIndex = 0;
  const cuts: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = MIDLINE_TABLE_DELIM_RE.exec(line))) {
    const before = line.slice(0, m.index);
    if (!before.trim()) continue; // effectively line-start — a real table
    if ((before.split('`').length - 1) % 2 === 1) continue; // inside inline code
    cuts.push({ start: m.index, end: m.index + m[0].length });
  }
  if (cuts.length === 0) return [line];
  const parts: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    const piece = line.slice(prev, c.start).trim();
    if (piece) parts.push(piece, '');
    prev = c.end;
  }
  const tail = line.slice(prev).trim();
  if (tail) parts.push(tail);
  while (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length > 0 ? parts : [line];
}

// ── Collapsed-structure repairs, round 2 (feedback 44204e09) ─────────────────
// fdd85bb3's repair keys on a mid-line DELIMITER row; the 44204e09 incident
// class drops the delimiter entirely, so nothing fired. Two shapes, both from
// live supervisor wake notes:
//   (a) rows joined inline — '| a | b | c | | d | e | f | | g | …' (the model
//       kept the pipes but dropped the row newlines);
//   (b) header glued to prose — '**Wake — …** | Item | Status | Detail |'.

// (a) join tell: 'end-pipe SPACE start-pipe' between rows. One ' | | ' mid-row
// is an empty cell — ≥2 joins (≥3 rows on one line) is the collapse signature.
const PIPE_ROW_JOIN_RE = /\| \| (?=\S)/g;
// Non-global twin for .test() — a shared /g regex carries lastIndex across calls.
const PIPE_ROW_JOIN_TEST_RE = /\| \| (?=\S)/;
// Delimiter row at line start (for the interstitial-blank pop below): only
// pipes, dashes, colons, spaces, and at least one dash.
const TABLE_DELIM_LINE_RE = /^ {0,3}\|[\s:|-]*-[\s:|-]*\|\s*$/;
// Ticket 90308cf4: a GFM delimiter row WITHOUT leading pipes ('---|---',
// '- | -', ':---|---:'). GFM does not require the pipes — TABLE_ROW_RE and
// the strict TABLE_DELIM_LINE_RE above only see pipe-led lines, so a table
// written with optional pipes ('A | B' / '---|---' / '| 1 | 2 |') is VALID
// GFM that the blank-separation pass would otherwise break apart. Requires
// a pipe (a pipe-less '---' is a thematic break, never a delimiter) and at
// least one dash. '- | -' stays a LIST ITEM (GFM precedence).
const TABLE_DELIM_ROW_LOOSE_RE = /^ {0,3}[:\s|-]*\|[:\s|-]*$/;
const isLooseDelimRow = (line: string): boolean =>
  TABLE_DELIM_ROW_LOOSE_RE.test(line) &&
  line.includes('-') &&
  !ULIST_RE.test(line) &&
  !OLIST_RE.test(line);
// (b) glued-header tell: a ≥2-cell pipe-run ending the line, with prose
// before it.
const GLUED_TABLE_HEADER_RE = /(\|[^\n|]+)+\|\s*$/;

function pipeCellCount(piece: string): number {
  return piece
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * GFM-accurate cell count: EVERY interior cell counts, empties included (the
 * F1 doctrine from splitGluedTableHeader) — leading/trailing pipes frame the
 * row and contribute no cell of their own. pipeCellCount counts only
 * non-empty cells, which is fine for splitJoinedPipeRows' raggedness gate but
 * would let rebuildOneLineTable pair a 3-GFM-cell header ('| a | | b |') with
 * a 2-cell delimiter ('|---|---|') — EMITTING a table GFM rejects
 * (adversarial review R2, ticket 7b7480fc). The rebuild gate below counts
 * with this function so an empty-interior-cell mismatch fails safe instead.
 */
function gfmTableCellCount(row: string): number {
  return gfmInteriorCells(row).length;
}

/**
 * Ticket 90308cf4: the interior cells of a GFM table line, empties included,
 * with optional framing pipes dropped ('| a | b |' → ['a','b']; 'a | b' →
 * ['a','b']; '---|---' → ['---','---']). Shared by the cell-count gate and
 * the own-delimiter lookahead below so both count the way GFM does.
 */
function gfmInteriorCells(row: string): string[] {
  const segs = row.trim().split('|');
  if (segs.length > 0 && segs[0].trim() === '') segs.shift();
  if (segs.length > 0 && segs[segs.length - 1].trim() === '') segs.pop();
  return segs.map((s) => s.trim());
}

/**
 * Ticket 90308cf4: is `next` the model's OWN well-formed delimiter row for
 * this glued header? The incident shape glues ONLY the header onto prose and
 * emits the delimiter as the next line ('…intro.** | A | B |' + '|---|---|').
 * Accepts the pipe-led form and the pipe-less GFM form ('---|---'), requires
 * every cell to be a valid dash/colon run and the cell COUNT to match the
 * header's (GFM: a mismatch is not a table at all — a kept mismatched
 * delimiter would render the whole thing as paragraph junk).
 */
function modelDelimiterRowAfter(header: string, next: string | undefined): boolean {
  if (next === undefined) return false;
  if (!TABLE_DELIM_LINE_RE.test(next) && !isLooseDelimRow(next)) return false;
  const cells = gfmInteriorCells(next);
  if (cells.length === 0 || !cells.every((c) => /^:?-+:?$/.test(c) && c.length > 0)) return false;
  return cells.length === gfmTableCellCount(header);
}

/**
 * Repair (a): split an inline-joined pipe-table body one row per line.
 * Consistency gate (the fail-safe): every split row must have the SAME cell
 * count — a bogus split (e.g. a row with several empty cells) produces
 * ragged counts and the line is returned untouched, never made worse.
 * Returns { parts, rowSplit } so the caller can pop an interstitial blank
 * that would detach the rows from their header+delimiter (see call site).
 */
function splitJoinedPipeRows(line: string): { parts: string[]; rowSplit: boolean } {
  if (/^\s/.test(line) || BQ_LINE_PREFIX_RE.test(line)) return { parts: [line], rowSplit: false };
  PIPE_ROW_JOIN_RE.lastIndex = 0;
  const cuts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = PIPE_ROW_JOIN_RE.exec(line))) {
    // m spans 'end-pipe SPACE start-pipe SPACE' — the row boundary sits
    // between the two pipes: row ends after m.index+1, next starts at m.index+2.
    const before = line.slice(0, m.index);
    if ((before.split('`').length - 1) % 2 === 1) continue; // inside inline code
    cuts.push(m.index);
  }
  if (cuts.length < 2) return { parts: [line], rowSplit: false };
  const rows: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    rows.push(line.slice(prev, c + 1).trim());
    prev = c + 2; // resume at the START-pipe — the next row keeps its leading '|'
  }
  rows.push(line.slice(prev).trim());
  const cells = rows.map(pipeCellCount);
  if (cells.some((n) => n < 2) || new Set(cells).size !== 1) {
    return { parts: [line], rowSplit: false };
  }
  return { parts: rows, rowSplit: true };
}

/**
 * Ticket 942db7aa (2026-10-15 Fleet Supervisor incident): the model emitted a
 * table as header + delimiter + BLANK + every data row joined on ONE line —
 * and the note's prose was glued after the last row's closing pipe
 * ('… | decision | I've corrected the fleet record…'). GFM ends the table at
 * the blank, so the joined body rendered to the owner as a wall of raw pipes
 * ("again your formattuinbg is all messed up"). splitJoinedPipeRows REJECTED
 * exactly this line on both of its gates: the glued prose tail makes the last
 * piece's cell count ragged ([2,2,2,3]), and a two-row body carries a single
 * ' | | ' join (the gate wants ≥2).
 * This repair re-anchors on what the run has ALREADY emitted: when the last
 * non-blank output line is the table's delimiter row, the current pipe-led
 * line is that table's detached body — split it one row per line, let the
 * LAST piece carry a prose tail after its final cells (the tail becomes its
 * own paragraph; content is never dropped), and tell the caller to pop the
 * interstitial blank so the rows reattach to their header+delimiter.
 * Fail-safe gates (the file doctrine — a bogus repair is worse than the pipes):
 *   - pipe-led, non-blockquoted, non-indented, not itself a delimiter row,
 *     and carrying ≥1 ' | | ' join. The join requirement is the disambiguator
 *     against a NEW table's header row: a real header ('| C | D |') never
 *     contains ' | | ' (that would be an empty cell), while a collapsed body
 *     always does;
 *   - the anchor delimiter must carry ≥2 GFM cells;
 *   - EVERY piece except the last must carry EXACTLY the delimiter's GFM cell
 *     count (a ragged first/middle piece fails safe — unrecoverable);
 *   - the last piece must carry ≥ the anchor's cells; its first anchor-count
 *     cells become its row and the remainder detaches as a prose paragraph —
 *     unless the remainder starts with an empty cell (more table than prose:
 *     fail safe) or the kept row would end mid-bold;
 *   - no piece may itself be a delimiter row (a second table glued behind the
 *     body — a different pathology, not repaired here).
 * Returns { parts, rowSplit } — rowSplit true means the caller must pop the
 * blank that detaches the body from its delimiter (the established
 * splitJoinedPipeRows pop at the call site).
 */
function splitDetachedTableBody(
  line: string,
  emitted: string[],
): { parts: string[]; rowSplit: boolean } {
  if (/^\s/.test(line) || BQ_LINE_PREFIX_RE.test(line)) return { parts: [line], rowSplit: false };
  if (!TABLE_ROW_RE.test(line) || TABLE_DELIM_LINE_RE.test(line)) {
    return { parts: [line], rowSplit: false };
  }
  // Anchor: the last non-blank emitted line must be the table's delimiter row
  // (a blank between delimiter and body is what detached it — GFM ends a table
  // at a blank line; without the anchor this line is someone else's content).
  let bi = emitted.length - 1;
  while (bi >= 0 && isBlank(emitted[bi])) bi--;
  if (bi < 0 || !TABLE_DELIM_LINE_RE.test(emitted[bi])) {
    return { parts: [line], rowSplit: false };
  }
  const anchorCells = gfmTableCellCount(emitted[bi]);
  if (anchorCells < 2) return { parts: [line], rowSplit: false };
  // Split one row per ' | | ' join (same landmark + inline-code guard as
  // splitJoinedPipeRows) — but ≥1 join suffices here: a detached two-row body
  // has a single join, which is exactly what splitJoinedPipeRows' ≥2 gate
  // missed, and a genuine new-table header never carries one at all.
  PIPE_ROW_JOIN_RE.lastIndex = 0;
  const cuts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = PIPE_ROW_JOIN_RE.exec(line))) {
    const before = line.slice(0, m.index);
    if ((before.split('`').length - 1) % 2 === 1) continue; // inside inline code
    cuts.push(m.index);
  }
  if (cuts.length < 1) return { parts: [line], rowSplit: false };
  const pieces: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    pieces.push(line.slice(prev, c + 1).trim());
    prev = c + 2; // resume at the start-pipe — the next row keeps its leading '|'
  }
  pieces.push(line.slice(prev).trim());
  if (pieces.some((p) => !p)) return { parts: [line], rowSplit: false };
  if (pieces.some((p) => TABLE_DELIM_LINE_RE.test(p))) {
    return { parts: [line], rowSplit: false }; // a second table glued behind the body
  }
  // Every piece except the LAST must match the delimiter's cell count exactly.
  const heads = pieces.slice(0, -1);
  if (heads.some((p) => gfmTableCellCount(p) !== anchorCells)) {
    return { parts: [line], rowSplit: false };
  }
  // The LAST piece may carry the note's prose glued after its final cell —
  // keep the first anchor-count cells as its row, detach the rest as prose.
  // (adversarial review N1: cells are counted with GFM framing semantics —
  // the piece's leading AND trailing framing pipes contribute no cell, so a
  // 1-cell piece against a 2-cell anchor fails the length gate instead of
  // manufacturing an empty '| c ||' cell.)
  const last = pieces[pieces.length - 1];
  const segs = last.split('|');
  let lo = 0;
  let hi = segs.length - 1;
  if (segs[lo].trim() === '') lo++; // leading framing pipe
  if (hi > lo && segs[hi].trim() === '') hi--; // trailing framing pipe
  const cells = segs.slice(lo, hi + 1);
  if (cells.length < anchorCells) return { parts: [line], rowSplit: false };
  const keptRow = `|${cells.slice(0, anchorCells).join('|')}|`;
  const rest = cells.slice(anchorCells);
  const restHasContent = rest.some((s) => s.trim().length > 0);
  let tail: string | null = null;
  if (restHasContent) {
    if (rest[0].trim() === '') return { parts: [line], rowSplit: false }; // empty cell first — more table than prose
    tail = rest.join('|').trim();
    if ((keptRow.split('**').length - 1) % 2 === 1) {
      return { parts: [line], rowSplit: false }; // would split mid-bold
    }
  }
  // (rest without content = trailing empty cells / framing pipes only —
  // dropping them loses no content; the kept row is the whole piece.)
  const parts = [...heads, keptRow];
  if (tail) parts.push('', tail);
  return { parts, rowSplit: true };
}

/**
 * Repair (b): un-glue a table header from the prose line it was appended to
 * and SYNTHESIZE the missing delimiter from the header's own cell count.
 * Unlike fdd85bb3 (cells undelimited → boundaries unrecoverable → drop), the
 * cells here are pipe-delimited, so the column structure is real — the
 * delimiter adds nothing the pipes don't already claim.
 * Emits [prose, '', header, delimiter] ('' passes through as a blank).
 */
function splitGluedTableHeader(line: string, nextRawLine?: string): string[] {
  if (/^\s/.test(line) || BQ_LINE_PREFIX_RE.test(line) || TABLE_ROW_RE.test(line)) return [line];
  const m = GLUED_TABLE_HEADER_RE.exec(line);
  if (!m || m.index === 0) return [line];
  const prose = line.slice(0, m.index).trim();
  if (!prose) return [line];
  if ((prose.split('`').length - 1) % 2 === 1) return [line]; // inside inline code
  if ((prose.split('**').length - 1) % 2 === 1) return [line]; // split mid-bold
  const header = m[0].trim();
  // ≥2 ' | | ' joins inside the run mean this is collapsed MULTI-ROW content,
  // not a single header (adversarial review F1) — manufacturing a mega-header
  // here is worse than leaving the prose, and the row-split path owns that case.
  // ONE join is a single empty header cell — repaired below with the true count.
  const joins = header.match(PIPE_ROW_JOIN_RE)?.length ?? 0;
  if (joins >= 2) return [line];
  // GFM counts EVERY interior cell, empties included — the synthesized
  // delimiter must carry the header's TRUE cell count or header/delimiter
  // mismatch makes the table invalid and renders worse than the un-repaired
  // text (adversarial review F1: the filtered-non-empty count did exactly that).
  const interior = header.split('|').slice(1, -1);
  const nonEmpty = interior.map((s) => s.trim()).filter((s) => s.length > 0);
  if (nonEmpty.length < 2) return [line];
  // All-dash cells = a glued DELIMITER — splitCollapsedTables' case, not this one.
  if (nonEmpty.every((c) => /^:?-{2,}:?$/.test(c))) return [line];
  // Ticket 90308cf4: the model often glues ONLY the header onto prose and
  // emits its own delimiter row on the NEXT line ('…intro.** | A | B |\n|---|---|\n| 1 | 2 |').
  // Synthesizing a second delimiter here produces a junk all-dashes row between
  // header and body (header, |---|---|, |---|---|, data — the "raw pipes-and-dashes
  // junk" symptom, proven by a remark-parse/gfm probe of the prior behavior).
  // When the next RAW line is the model's own delimiter row with a MATCHING cell
  // count, keep it and only blank-separate the header from the prose.
  if (modelDelimiterRowAfter(header, nextRawLine)) {
    return [prose, '', header];
  }
  const delimiter = `|${interior.map(() => '---').join('|')}|`;
  return [prose, '', header, delimiter];
}

/**
 * Flattened-list repair (44204e09 — the top-of-file doctrine bars generic
 * mid-line '- '/'2. ' splits for prose false positives; this is gated to the
 * incident's exact signature):
 *   - markers are BOLD-LED (immediately followed by '**');
 *   - the FIRST marker is introduced by a colon (the '…:** - **x**' /
 *     '…two items:** 1 **x**' list-introduction idiom);
 *   - ≥2 markers on the line.
 * Bullets re-line as REAL '- ' items; numbered markers re-line as plain
 * paragraph lines (no '.' is manufactured — demotion doctrine).
 */
// The intro colon must be BOLD-ADJACENT ('…:**' — the incident idiom, where
// the introduction is a bold ledge). A plain 'word: 2 **x** and 1 **y**' is
// ordinary prose (adversarial review B1: 'Lanes: 2 **healthy** and 1
// **degraded**' was chopped mid-clause into paragraph fragments).
const COLLAPSED_LIST_INTRO_RE = /:\*{2} (?=(?:- |\d{1,2} )\*\*)/;
const COLLAPSED_LIST_MARK_RE = / (?:- |\d{1,2} )(?=\*\*)/g;
// 7b7480fc round 3: the current wake-note collapse idiom drops the intro
// colon too ('…fleet watch: - **Spark 28de72e5 (event):** …' or even
// '…`verify_site` - **Kernel b95e9df6:** …'), so the bold-adjacent-colon
// gate above never fires and the whole lane list renders as one prose wall.
// The recoverable landmark is the marker itself: a dash-led BOLD LABEL WITH
// ITS COLON ('- **Lane:**') is a list-item claim the model made explicitly —
// re-lining it manufactures nothing the marker doesn't already claim.
// NUMBERED markers stay gated on the intro colon above (B1: '2 **x** and 1
// **y**' is ordinary prose). Label capped at 80 chars so a pathological run
// can't span a paragraph.
const COLLAPSED_LIST_LABEL_RE = / - \*\*[^\n*]{1,80}:\*\*/g;
// Non-global twin for .test() — a shared /g regex carries lastIndex across calls.
const COLLAPSED_LIST_LABEL_TEST_RE = / - \*\*[^\n*]{1,80}:\*\*/;

/**
 * Re-line a flattened dash-led bold-label list with no usable intro colon
 * (7b7480fc). Cut points are the ' - **Label:**' markers; each is skipped
 * inside inline code (odd backtick count) or inside a bold span (odd '**'
 * count). ≥2 markers required on a prose line; a line that ALREADY starts
 * as a list item needs only one glued sibling (the first item is real, the
 * flattened tail is the signature). Dash pieces re-line as REAL '- ' items
 * and stay tight — the blank-line pass inserts the single break before the
 * first item.
 */
function splitLabelledDashList(line: string): string[] {
  COLLAPSED_LIST_LABEL_RE.lastIndex = 0;
  const cuts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = COLLAPSED_LIST_LABEL_RE.exec(line))) {
    const before = line.slice(0, m.index);
    if ((before.split('`').length - 1) % 2 === 1) continue; // inside inline code
    if ((before.split('**').length - 1) % 2 === 1) continue; // inside a bold span
    cuts.push(m.index);
  }
  const minCuts = ULIST_RE.test(line) ? 1 : 2;
  if (cuts.length < minCuts) return [line];
  const pieces: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    const piece = line.slice(prev, c).trim();
    if (piece) pieces.push(piece);
    prev = c + 1; // skip the mark's leading space — '- ' starts the new line
  }
  const tail = line.slice(prev).trim();
  if (tail) pieces.push(tail);
  return pieces.length > 1 ? pieces : [line];
}

// 6ee7a779 (chat 03130da9, stored msg dd2bf278): the collapse can drop the
// BOLD entirely — a colon intro followed by PLAIN dash items ('…pull the
// live ledger fresh and post: - Lane-by-lane status (…) with countable
// deltas … - Storage progress … - ETA … - Anything needing your decision…')
// renders as one prose wall: no bold label survives, so neither the
// bold-adjacent-colon intro above nor the bold-label marks in
// splitLabelledDashList fire. The recoverable landmark is the same one the
// bold path uses, minus the bold: a COLON immediately before the first
// ' - ' item.
// Adversarial review (ticket 6ee7a779, BLOCKING-1) hardened the gate — a
// bare colon-intro MANUFACTURED lists from prose, three classes:
//   - a colon inside INLINE CODE ('Run `x: - y` - first detail here …') is
//     not a landmark: the intro now gets the same inline-code skip the
//     marks get;
//   - DIGIT ranges ('times: - 10 - 12 - 14 on the dial'): a digit-led item
//     only counts when the previous non-space char is NOT a digit;
//   - parenthetical/prose dashes: marks inside an unclosed parenthetical
//     ('(tagged rc1 - not rc2)') are skipped via paren depth, and a mark
//     must start a plausible ITEM — the same item-start class wall-of-text
//     uses (capital / '`' / '[' / '*' / '(' / non-range digit). Lowercase-
//     led ' - ' is paired-aside prose ('the builder - which we own -'),
//     never the incident shape (dd2bf278's items are all capital-led).
// Stacking with wall-of-text (d89d38c4c): the ≥400-char lost-newline WALL
// is wall-of-text's case (it applies this same item-start doctrine); this
// narrow repair owns collapsed LINES and short shapes, under the same
// doctrine — so a shape the two passes disagree on does not exist.
const PLAIN_DASH_INTRO_RE = /:(?= - )/;
const PLAIN_DASH_INTRO_SCAN_RE = /:(?= - )/g;
const PLAIN_DASH_MARK_RE = / - /g;

/** Paren depth at `at`, counting only outside inline-code spans. */
function plainDashParenDepth(line: string, at: number): number {
  let depth = 0;
  let inCode = false;
  for (let i = 0; i < at; i++) {
    const ch = line[i];
    if (ch === '`') inCode = !inCode;
    else if (!inCode && ch === '(') depth++;
    else if (!inCode && ch === ')') depth--;
  }
  return depth;
}

/** True when the ' - ' mark at `at` begins a plausible flattened ITEM. */
function plainDashItemStarts(line: string, at: number): boolean {
  const next = line[at + 3]; // first char after ' - '
  if (next === undefined) return false;
  let prev = '';
  for (let k = at - 1; k >= 0; k--) {
    if (line[k] !== ' ') {
      prev = line[k];
      break;
    }
  }
  // Mirror wall-of-text's bullet class: capital / code / bracket / bold /
  // paren start, or a digit NOT following a digit (kills '10 - 12' ranges).
  return /[A-Z`*[(]/.test(next) || (/\d/.test(next) && !/\d/.test(prev));
}

function splitPlainDashList(line: string): string[] {
  // The intro colon must itself be REAL PROSE: outside inline code (a
  // '`x: - y`' code span is not a list introduction) and outside an open
  // parenthetical — take the FIRST such colon, not just the first colon.
  PLAIN_DASH_INTRO_SCAN_RE.lastIndex = 0;
  let intro: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = PLAIN_DASH_INTRO_SCAN_RE.exec(line))) {
    if ((line.slice(0, m.index).split('`').length - 1) % 2 === 1) continue; // colon in inline code
    if (plainDashParenDepth(line, m.index) > 0) continue; // colon inside a parenthetical
    intro = m;
    break;
  }
  if (!intro) return [line];
  PLAIN_DASH_MARK_RE.lastIndex = 0;
  const cuts: number[] = [];
  while ((m = PLAIN_DASH_MARK_RE.exec(line))) {
    if (m.index < intro.index) continue; // marks must follow the intro colon
    const before = line.slice(0, m.index);
    if ((before.split('`').length - 1) % 2 === 1) continue; // inside inline code
    if ((before.split('**').length - 1) % 2 === 1) continue; // inside a bold span
    if (plainDashParenDepth(line, m.index) > 0) continue; // inside a parenthetical
    if (!plainDashItemStarts(line, m.index)) continue; // prose dash / range / lowercase aside
    cuts.push(m.index);
  }
  if (cuts.length < 2) return [line];
  const pieces: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    const piece = line.slice(prev, c).trim();
    if (piece) pieces.push(piece);
    prev = c + 1; // skip the mark's leading space — '- ' starts the new line
  }
  const tail = line.slice(prev).trim();
  if (tail) pieces.push(tail);
  return pieces.length > 1 ? pieces : [line];
}

function splitCollapsedLists(line: string): string[] {
  if (!line || /^\s/.test(line) || BQ_LINE_PREFIX_RE.test(line)) return [line];
  const intro = COLLAPSED_LIST_INTRO_RE.exec(line);
  if (!intro) {
    // 6ee7a779: with no bold-adjacent colon, the bold-labelled path is the
    // stronger claim — try it first; only when it declines does the plain
    // colon-intro dash repair engage.
    const labelled = splitLabelledDashList(line);
    if (labelled.length > 1) return labelled;
    return splitPlainDashList(line);
  }
  COLLAPSED_LIST_MARK_RE.lastIndex = 0;
  const cuts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = COLLAPSED_LIST_MARK_RE.exec(line))) {
    if (m.index < intro.index) continue;
    const before = line.slice(0, m.index);
    if ((before.split('`').length - 1) % 2 === 1) continue; // inside inline code
    cuts.push(m.index);
  }
  if (cuts.length < 2) return [line];
  const pieces: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    const piece = line.slice(prev, c).trim();
    if (piece) pieces.push(piece);
    prev = c + 1; // skip the mark's leading space — '- '/'1 ' starts the new line
  }
  const tail = line.slice(prev).trim();
  if (tail) pieces.push(tail);
  if (pieces.length < 2) return [line];
  // Numbered re-lines ('1 **x**') are paragraph lines, not list items — the
  // app renderer has no soft-break rendering, so consecutive ones would
  // reflow into a single paragraph. Blank-separate them ('' passes through
  // the caller's line loop as a paragraph break); '- ' bullets stay tight.
  const parts: string[] = [];
  for (const piece of pieces) {
    if (parts.length > 0 && /^\d{1,2} /.test(piece) && parts[parts.length - 1] !== '') {
      parts.push('');
    }
    parts.push(piece);
  }
  return parts;
}

// ── Collapsed-structure repairs, round 3 (feedback 7b7480fc) ───────────────
// The 2026-08-29 wake-note regression: the model emits a whole pipe-DELIMITED
// table, delimiter row included, on ONE line ('| Lane | Status | |---|---| |
// a | b | | c | d |', optionally with prose glued before the header). Round
// 2's inline-join repair never fires — the delimiter-adjacent join is '| |-',
// not '| | ', and the delimiter glued onto the header row makes the cell
// counts ragged, so the fail-safe returns the line untouched; splitGluedTable
// Header then synthesizes a delimiter for a header whose REAL delimiter sits
// mid-line, leaving the data rows glued behind a blank (half-broken table).

/**
 * Reflow a one-line table that includes its delimiter row into a proper
 * newline-separated GFM table. Unlike fdd85bb3 (cells undelimited →
 * boundaries unrecoverable → drop the delimiter), the cells here ARE
 * pipe-delimited, so the column boundaries are real and the reflow
 * manufactures nothing the pipes don't already claim.
 * Fail-safe gates (mirror splitJoinedPipeRows' doctrine — a bogus rebuild is
 * worse than the prose wall):
 *   - no leading whitespace (indented code), no blockquote prefix, never a
 *     line that IS a whole delimiter row (a real table);
 *   - the delimiter fragment must sit mid-line outside inline code;
 *   - the header is the pipe-run ENDING the before-text (prose before it is
 *     lifted out as its own paragraph); no pipe-run → the fdd85bb3 class,
 *     null (the drop repair owns it);
 *   - header, delimiter, and EVERY data row carry the SAME pipe cell count;
 *   - no data piece may itself be delimiter-only (two tables glued on one
 *     line — the drop repair owns that pathology);
 *   - prose split off the header must not end mid-bold.
 * Returns the reflowed parts ('' elements pass through the caller's line
 * loop as paragraph breaks) or null when the line is not this signature.
 */
function rebuildOneLineTable(line: string): string[] | null {
  if (/^\s/.test(line) || BQ_LINE_PREFIX_RE.test(line)) return null;
  if (TABLE_DELIM_LINE_RE.test(line)) return null; // a real delimiter row
  MIDLINE_TABLE_DELIM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  let delim: { start: number; end: number; text: string } | null = null;
  while ((m = MIDLINE_TABLE_DELIM_RE.exec(line))) {
    const before = line.slice(0, m.index);
    if (!before.trim()) continue; // delimiter at line start — a real table
    if ((before.split('`').length - 1) % 2 === 1) continue; // inside inline code
    delim = { start: m.index, end: m.index + m[0].length, text: m[0] };
    break;
  }
  if (!delim) return null;
  const beforeText = line.slice(0, delim.start);
  const glued = GLUED_TABLE_HEADER_RE.exec(beforeText);
  if (!glued) return null; // header pipes dropped too — fdd85bb3's class
  const prose = beforeText.slice(0, glued.index).trim();
  if (prose && (prose.split('**').length - 1) % 2 === 1) return null; // split mid-bold
  const header = glued[0].trim();
  const headerCells = gfmTableCellCount(header);
  const delimText = delim.text.trim();
  const delimCells = gfmTableCellCount(delimText);
  if (headerCells < 2 || headerCells !== delimCells) return null;
  // Data rows: the tail after the delimiter, split one row per ' | | ' join
  // (same landmark + inline-code guard as splitJoinedPipeRows).
  const tail = line.slice(delim.end);
  if (!tail.trim()) return null;
  PIPE_ROW_JOIN_RE.lastIndex = 0;
  const cuts: number[] = [];
  while ((m = PIPE_ROW_JOIN_RE.exec(tail))) {
    const beforeCut = tail.slice(0, m.index);
    if ((beforeCut.split('`').length - 1) % 2 === 1) continue; // inline code
    cuts.push(m.index);
  }
  const splitRows: string[] = [];
  let prev = 0;
  for (const c of cuts) {
    splitRows.push(tail.slice(prev, c + 1).trim());
    prev = c + 2; // resume at the start-pipe — the next row keeps its leading '|'
  }
  splitRows.push(tail.slice(prev).trim());
  let rows = splitRows;
  if (splitRows.some((r) => gfmTableCellCount(r) !== headerCells)) {
    // A ' | | ' inside a row is indistinguishable from a row join — the split
    // may have shattered a row's EMPTY interior cell. Retry the whole tail as
    // ONE row (the delimiter's own count disambiguates); genuinely ragged
    // input fails safe here (multi-row tails containing empty cells stay
    // unrepaired — a conservative miss, never a corruption).
    const whole = tail.trim();
    if (gfmTableCellCount(whole) !== headerCells) return null;
    rows = [whole];
  }
  if (rows.some((r) => !r)) return null;
  if (rows.some((r) => TABLE_DELIM_LINE_RE.test(r))) return null; // glued 2nd table
  // Normalize the emitted rows: the delimiter's optional trailing pipe can
  // CONSUME a data row's leading pipe (regex greed) — restore it so every
  // row starts with '|' like the header; and tidy the delimiter's own
  // trailing spacing before its final pipe (cosmetic only — the dashes and
  // alignment colons, the model's actual structural claim, are preserved).
  const delimiter = `${delimText.replace(/[ \t]+\|?$/, '').replace(/\|$/, '')}|`;
  const normRows = rows.map((r) => (r.startsWith('|') ? r : `| ${r}`));
  const parts: string[] = [];
  if (prose) parts.push(prose, '');
  parts.push(header, delimiter, ...normRows);
  return parts;
}

/** Normalize one unprotected segment (fence-aware, line-based). */
function normalizeSegment(segment: string): string {
  // Normalize CRLF → LF per line (protected segments are never touched).
  const rawLines = segment.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const out: string[] = [];
  let inFence = false;
  let fenceChar = '`';
  let fenceLen = 0;
  // 65a0b4d5: how many '>' markers the OPENING fence line carried. The closer
  // must stay at the SAME depth — a '>> ```' line inside a '> ```' fence is
  // nested-quote code content, and a '> ```' line inside a column-0 fence is
  // content too. A SHALLOWER fence line does NOT close the fence: micromark
  // (the app's renderer) does not lazy-continue fences across a blockquote
  // boundary, so the old fence ends implicitly there and the line opens a NEW
  // fence at the shallower depth (adversarial review B3).
  let fenceMarkers = 0;
  // 65a0b4d5: the disagreement WINDOW after a blockquote fence ends (the
  // renderer is out; the normalizer kept state). Persists across consecutive
  // unprefixed lines until a blank line, a fence-looking line, or a
  // blockquote-prefixed line. Inside it, mid-line splits and ATX/table/list
  // blank-insertion are suppressed (both can only MANUFACTURE structure the
  // original text didn't have — a mid-line '##' never renders, and an ATX
  // heading renders with or without a preceding blank), while demotion and
  // HR/setext blank-insertion still run (the renderer applies those rules to
  // window lines — adversarial review B1/B2).
  let bqWindow = false;
  // F2: whether the PREVIOUS rawLine was demoted from a run-on ATX heading in
  // this pass — gates the setext-underline separation below.
  let prevDemoted = false;

  for (let li = 0; li < rawLines.length; li++) {
    const rawLine = rawLines[li];
    const fenceMatch = FENCE_RE.exec(rawLine);
    if (fenceMatch) {
      // A fence boundary breaks demotion adjacency (follow-up 5): without this
      // reset, a demotion immediately before the fence kept prevDemoted armed
      // THROUGH the block and a following '===' got a spurious blank line.
      prevDemoted = false;
      bqWindow = false; // fence state supersedes the disagreement window
      const ch = fenceMatch[2][0];
      const len = fenceMatch[2].length;
      const markers = bqMarkerCount(fenceMatch[1]);
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
        fenceMarkers = markers;
        // A fence opening directly after text also needs separation, or the
        // opening fence line is swallowed into the paragraph.
        if (out.length > 0 && !isBlank(out[out.length - 1])) out.push('');
      } else if (markers < fenceMarkers) {
        // A fence line SHALLOWER than the open fence's quote prefix (e.g. an
        // unprefixed ``` after '> ```js') is NOT a closer — micromark opens a
        // NEW fence at the shallower depth there (adversarial review B3:
        // treating it as a closer corrupted code content with split lines and
        // injected blanks the renderer never sees). Transition state to the
        // new fence so subsequent lines stay in sync with the renderer.
        fenceChar = ch;
        fenceLen = len;
        fenceMarkers = markers;
      } else if (markers === fenceMarkers && ch === fenceChar && len >= fenceLen) {
        // CommonMark: a closing fence must use the same char AND be at least
        // as long as the opener — a 3-backtick line inside a 4-backtick block
        // is CODE, not a closer (adversarial review B1: without the length
        // check we desynced and injected blank lines into code content).
        // 65a0b4d5: the closer must also sit at the SAME blockquote depth as
        // the opener (handled above: shallower = new fence, deeper = content).
        inFence = false;
      }
      out.push(rawLine);
      continue;
    }
    if (inFence) {
      if (fenceMarkers === 0) {
        // Column-0 fence: the renderer agrees on the content — never touch code.
        out.push(rawLine);
        continue;
      }
      // Blockquote-prefixed fence. micromark (the app's renderer) does NOT
      // lazy-continue fenced code inside blockquotes: only lines carrying the
      // quote prefix are fence content; a blank line or an unprefixed line
      // ENDS the fence there (adversarial review B1/B2: suppressing ALL rules
      // in that disagreement window regressed setext '---' protection and
      // run-on-heading demotion, because the renderer applies full structure
      // to lines it sees outside the fence).
      const bqPrefix = BQ_LINE_PREFIX_RE.exec(rawLine);
      if (bqPrefix && bqMarkerCount(bqPrefix[1]) >= fenceMarkers) {
        // Quoted content line — fence content to BOTH sides: full suppression.
        out.push(rawLine);
        continue;
      }
      inFence = false;
      if (isBlank(rawLine)) {
        out.push(rawLine); // a blank line ends the blockquote and its fence
        continue;
      }
      // Unprefixed non-blank line: the renderer ended the fence HERE. Enter
      // the disagreement window and fall through to the normal rules below.
      bqWindow = true;
    }
    if (bqWindow && isBlank(rawLine)) {
      // A blank normally ends the window as surely as the fence — but NOT
      // when the next line is one this pass blank-separates anyway (HR,
      // setext '=', first table row, first list item). Those blank-inserts
      // RUN inside the window (adversarial review B1: the renderer applies
      // HR/setext structure to window lines), so a blank before such a line
      // may have been INSERTED by a previous pass; exiting here would
      // re-expose the following lines to splitCollapsedHeadings on the next
      // pass — manufacturing the very headings the window exists to suppress
      // and breaking idempotency (adversarial review F1; the frontend port
      // re-normalizes persisted pass-1 text at render time).
      const next = li + 1 < rawLines.length ? rawLines[li + 1] : '';
      const couldBeSelfInserted =
        HR_RE.test(next) ||
        SETEXT_UNDERLINE_RE.test(next) ||
        TABLE_ROW_RE.test(next) ||
        isListItem(next);
      if (!couldBeSelfInserted) bqWindow = false;
    }

    // F2: a line demoted below is now a PARAGRAPH, so a directly-following
    // '===' would render it as a giant setext H1 — worse than the run-on
    // heading the demotion removed. Blank-separate ONLY here (targeted):
    // blank-separating every '===' would break genuine setext H1s like
    // 'Title\n===' (adversarial review M1 — HR_RE exclusion). prevDemoted is
    // read first, then reset for THIS rawLine; the demotion loop re-sets it.
    if (
      prevDemoted &&
      SETEXT_UNDERLINE_RE.test(rawLine) &&
      out.length > 0 &&
      !isBlank(out[out.length - 1])
    ) {
      out.push('');
    }
    prevDemoted = false;

    // Run-on-heading demotion (feedback 814809bf): an over-long ATX line is a
    // fused heading+paragraph, not a heading — strip the marker so it renders
    // as plain prose. Done BEFORE splitCollapsedHeadings so the demoted line
    // still gets any legitimate mid-line splits, then flows through the
    // blank-line logic as normal prose. The strip LOOPS (adversarial review
    // F1) and handles blockquote-prefixed markers + closing sequences inside
    // demoteRunOnHeading (c8664ff9 follow-ups 1/3).
    const demoted = demoteRunOnHeading(rawLine);
    const preSplit = demoted.text;
    if (demoted.demoted) {
      prevDemoted = true;
      // Follow-up 2: a stripped marker can EXPOSE a fence opener ('## ```js
      // …' → '```js …'). Track it like a real fence line so the normalizer's
      // fence state stays in sync with the renderer — otherwise blank lines
      // could be injected into what CommonMark treats as code.
      const exposedFence = FENCE_RE.exec(preSplit);
      if (exposedFence) {
        inFence = true;
        fenceChar = exposedFence[2][0];
        fenceLen = exposedFence[2].length;
        fenceMarkers = bqMarkerCount(exposedFence[1]);
        if (out.length > 0 && !isBlank(out[out.length - 1])) out.push('');
        out.push(preSplit);
        continue;
      }
    }

    // Mid-line heading repair (fully-collapsed single-line answers), guarded
    // by splitCollapsedHeadings — prose like 'team is # 1' is left alone.
    // bqWindow: inside the blockquote-fence disagreement window the split is
    // suppressed — a mid-line '##' never renders as a heading there, so
    // splitting could only MANUFACTURE one.
    // Heading split runs FIRST (adversarial review N2: table-first broke the
    // heading split's ≥2-marker rule on compound lines like 'intro ## H
    // |---|---|---| cells ## J', regressing heading recovery vs main); the
    // collapsed-table repair (fdd85bb3) then applies per piece — it drops the
    // delimiter and paragraph-breaks the pieces ('' elements pass through the
    // line loop as blanks). Backticked lines skip the heading split by its own
    // guard but still get the table repair here (the incident class).
    const headingParts = bqWindow ? [preSplit] : splitCollapsedHeadings(preSplit);
    // 44204e09 round 2 (after the fdd85bb3 delimiter-drop repair): rebuild
    // delimiter-less collapsed pipe tables — inline-joined rows split one per
    // line, a prose-glued header gets its delimiter synthesized — and re-line
    // flattened bold-led lists. Same bqWindow suppression doctrine as the
    // heading split (structure is only manufactured where the renderer would
    // also apply structure).
    let lines: string[];
    if (bqWindow) {
      lines = headingParts;
    } else {
      lines = [];
      // Ticket 90308cf4: collect this raw line's pieces first — only the LAST
      // piece is the raw line's true tail, and only a line-ending glued header
      // can be followed by the model's own delimiter row on the NEXT raw line.
      const pieceList: string[] = [];
      for (const part of headingParts.flatMap((p) => splitCollapsedTables(p))) {
        const joined = splitJoinedPipeRows(part);
        let rowParts = joined.parts;
        let reattach = joined.rowSplit;
        // (ticket 942db7aa) the strict uniform gate rejected the incident's
        // body — a prose tail glued after the last row ragged the counts and a
        // two-row body carries one join, not two. Re-anchor on the delimiter
        // row this pass already emitted above the blank.
        if (!joined.rowSplit) {
          const detached = splitDetachedTableBody(part, out);
          if (detached.rowSplit) {
            rowParts = detached.parts;
            reattach = true;
          }
        }
        if (reattach) {
          // The model's own paragraph break between the glued header and its
          // collapsed body would DETACH the rows from the table (a blank ends
          // a GFM table) — drop trailing blanks when the last structure pushed
          // is a delimiter row, keeping header/delimiter/rows contiguous.
          let bi = out.length - 1;
          while (bi >= 0 && isBlank(out[bi])) bi--;
          if (bi >= 0 && TABLE_DELIM_LINE_RE.test(out[bi])) out.length = bi + 1;
        }
        pieceList.push(...rowParts);
      }
      for (let pci = 0; pci < pieceList.length; pci++) {
        const nextRaw = pci === pieceList.length - 1 ? rawLines[li + 1] : undefined;
        for (const q of splitGluedTableHeader(pieceList[pci], nextRaw)) {
          lines.push(...splitCollapsedLists(q));
        }
      }
    }

    for (let pi = 0; pi < lines.length; pi++) {
      let line = lines[pi];
      // Follow-up 4: a split part can itself be a run-on heading ('intro ##
      // A<180 chars> ## B…' → part '## A<180 chars>') — re-demote each part.
      if (line.length > MAX_HEADING_LINE_LEN) {
        const part = demoteRunOnHeading(line);
        if (part.demoted) {
          line = part.text;
          prevDemoted = true;
          // Same exposed-fence hazard as the rawLine level, one split later:
          // the rest of this collapsed line is code content to the renderer.
          const partFence = FENCE_RE.exec(line);
          if (partFence) {
            inFence = true;
            fenceChar = partFence[2][0];
            fenceLen = partFence[2].length;
            fenceMarkers = bqMarkerCount(partFence[1]);
            if (out.length > 0 && !isBlank(out[out.length - 1])) out.push('');
            out.push(line);
            for (let pj = pi + 1; pj < lines.length; pj++) out.push(lines[pj]);
            break;
          }
        }
      }
      // Adversarial review N1 (fdd85bb3): a collapsed-TABLE split piece can
      // itself be a fence opener ('… |---|---|---| ```js' → piece '```js') —
      // heading-split pieces always start with '##', but table pieces are
      // arbitrary text. Track it like a rawLine fence boundary so the
      // following lines stay code to the normalizer AND the renderer; the
      // rest of this line's pieces came from the fence opener's own line and
      // are pushed verbatim.
      if (!inFence) {
        const openedFence = FENCE_RE.exec(line);
        if (openedFence) {
          inFence = true;
          fenceChar = openedFence[2][0];
          fenceLen = openedFence[2].length;
          fenceMarkers = bqMarkerCount(openedFence[1]);
          if (out.length > 0 && !isBlank(out[out.length - 1])) out.push('');
          out.push(line);
          for (let pj = pi + 1; pj < lines.length; pj++) out.push(lines[pj]);
          break;
        }
      }
      if (out.length > 0 && !isBlank(line)) {
        const prev = out[out.length - 1];
        if (!isBlank(prev)) {
          const needBlank =
            // 65a0b4d5: inside the disagreement window, ATX headings are NOT
            // blank-separated — an ATX heading renders identically with or
            // without the blank, and inserting it would make later normalize
            // passes drift (the window ends at blanks, so a pass-2 blank
            // would re-expose the line to the split rule → non-idempotent).
            (ATX_RE.test(line) && !bqWindow) ||
            HR_RE.test(line) ||
            // Ticket 90308cf4: a body row after a NON-PIPE delimiter row
            // ('A | B' / '---|---' / '| 1 | 2 |') must NOT be blank-separated —
            // GFM allows optional pipes and micromark renders that as a table;
            // the blank was tearing the body off into a raw-pipes paragraph
            // (probe: raw parse paragraph+table, old normalized parse
            // paragraph+table+paragraph — the repair manufactured the junk).
            (TABLE_ROW_RE.test(line) &&
              !TABLE_ROW_RE.test(prev) &&
              !isLooseDelimRow(prev)) ||
            (isListItem(line) &&
              !isListItem(prev) &&
              !LIST_CONT_RE.test(prev) &&
              !ATX_RE.test(prev) &&
              !FENCE_RE.test(prev));
          if (needBlank) out.push('');
        }
      }
      out.push(line);
    }
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Repair degraded assistant markdown before persistence. Idempotent:
 * normalize(normalize(x)) === normalize(x).
 */
export function normalizeAssistantMarkdown(raw: string): string {
  if (!raw) return raw;
  // Ticket 6ee7a779: an answer whose line breaks ALL arrived as spaces (a
  // 400+-char structured answer on one line) is re-lined first — gated, pure
  // and idempotent (wall-of-text.ts). Protected regions never reach it.
  // MARKDOWN_WALL_REPAIR_DISABLED=1 restores the pre-6ee7a779 output.
  if (raw.length >= WALL_MIN_CHARS && process.env.MARKDOWN_WALL_REPAIR_DISABLED !== '1') {
    raw = splitProtected(raw)
      .map((seg) => (seg.protect ? seg.text : repairWallOfText(seg.text)))
      .join('');
  }
  // Fast path: single-line input with no mid-line heading marker, no mid-line
  // table delimiter (fdd85bb3 — a collapsed one-line table; also the landmark
  // for the 7b7480fc delimiter-INCLUDED reflow), no 44204e09 round-2 signature
  // (joined pipe rows / glued header / flattened list), no 7b7480fc
  // flattened bold-label list, and no run-on heading (814809bf; BQ_ATX_RE
  // added for no-space '>## …' blockquote run-ons — reviewer N2, ticket
  // c8664ff9) can't degrade further.
  if (
    !raw.includes('\n') &&
    !/ #{1,6} /.test(raw) &&
    !MIDLINE_TABLE_DELIM_TEST_RE.test(raw) &&
    !PIPE_ROW_JOIN_TEST_RE.test(raw) &&
    !GLUED_TABLE_HEADER_RE.test(raw) &&
    !COLLAPSED_LIST_INTRO_RE.test(raw) &&
    !COLLAPSED_LIST_LABEL_TEST_RE.test(raw) &&
    // 6ee7a779: a single-line colon-intro plain-dash list ('…and post: - a …
    // - b - c') has no bold/heading/table signature — without this arm the
    // fast path would hide exactly the shape splitPlainDashList repairs.
    !PLAIN_DASH_INTRO_RE.test(raw) &&
    !(raw.length > MAX_HEADING_LINE_LEN && (ATX_RE.test(raw) || BQ_ATX_RE.test(raw)))
  ) {
    return raw;
  }
  return splitProtected(raw)
    .map((seg) => (seg.protect ? seg.text : normalizeSegment(seg.text)))
    .join('');
}
