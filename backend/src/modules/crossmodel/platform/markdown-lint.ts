/**
 * markdown-lint — deterministic STRUCTURAL lint for machine notes (ticket
 * 942db7aa, 2026-10-15): the Fleet Supervisor's owner-facing reply emitted a
 * table whose data rows were all joined on one line behind a blank, with the
 * note's prose glued after the last row — GFM ended the table at the blank and
 * the owner saw a wall of raw pipes ("again your formattuinbg is all messed
 * up"). The harness already validates machine notes deterministically (claims
 * fence, wake markers, evidence citations); markdown STRUCTURE was not
 * validated. This module is the missing structural layer:
 *
 *   lintMarkdownNote(text)      — detect the malformed-markdown strike classes
 *                                 (telemetry: the regression RATE the ticket
 *                                 asks to measure, via loop metric
 *                                 markdown_lint_strike);
 *   degradeMachineNotePipes(text) — the never-ship-raw-pipes backstop: any
 *                                 pipe-led line that is NOT part of a
 *                                 structurally valid GFM table (header row +
 *                                 |---| delimiter row + contiguous rows) is
 *                                 degraded to plain bullets — cells joined with
 *                                 ' — ', one bullet per collapsed row. Content
 *                                 is never dropped (an all-dash orphan
 *                                 delimiter row carries no content and is the
 *                                 one exception — pure markdown noise).
 *
 * The FIRST line of defense is the repair pass (markdown-normalize.ts — it
 * reflows collapsed tables back into real tables, including this ticket's
 * detached-body class); this lint measures what was emitted and degrades only
 * what the fail-safe repairs deliberately left alone (a bogus repair is worse
 * than the pipes — the normalizer's doctrine). Model-free and pure: no LLM, no
 * I/O, safe on any input. Kill switch: MARKDOWN_NOTE_LINT_DISABLED=1 (both the
 * metric rows and the degrade).
 *
 * Fence-aware (fenced code is never linted, never degraded), blockquote-aware
 * (quoted lines are deliberately untouched — same guard as the normalizer),
 * indented-code-aware (leading whitespace = code, untouched).
 */

export type MarkdownLintClass =
  | 'table_joined_rows' // ≥2 ' | | ' joins on one line — a multi-row body collapsed onto one line
  | 'table_detached_body' // a joined pipe body whose table's delimiter row sits above a blank — GFM already ended the table
  | 'table_midline_delimiter' // a |---| delimiter glued mid-line (collapsed whole-table-on-one-line)
  | 'table_glued_header' // a ≥2-cell pipe run glued onto the end of a prose line
  | 'table_pseudo_row' // any other pipe-led line with no valid table above it — renders as raw pipes
  | 'flat_list'; // a run-on flattened list ('- a - b - c' class) on one line

export interface MarkdownLintStrike {
  cls: MarkdownLintClass;
  /** 1-based line number */
  line: number;
  /** first 120 chars of the offending line (telemetry excerpt only) */
  excerpt: string;
}

export interface MarkdownLintResult {
  strikes: MarkdownLintStrike[];
}

export interface DegradeMachineNoteResult {
  text: string;
  /** the ORIGINAL lines that were degraded (telemetry excerpts) */
  degradedLines: string[];
}

export function markdownLintDisabled(): boolean {
  return process.env.MARKDOWN_NOTE_LINT_DISABLED === '1';
}

// ── line classification (kept in sync with markdown-normalize.ts's guards) ──
const FENCE_RE = /^ {0,3}((?:> ?)*)(`{3,}|~{3,})/;
const BQ_PREFIX_RE = /^ {0,3}>/;
const INDENT_RE = /^\s/;
const PIPE_LED_RE = /^ {0,3}\|/;
// A GFM delimiter row at line start: pipes, dashes, colons, spaces, ≥1 dash.
const DELIM_ROW_RE = /^ {0,3}\|[\s:|-]*-[\s:|-]*\|\s*$/;
// Block starts that END a GFM table body (adversarial review B1: the model
// must match the renderer — a table body continues through ANY non-blank line
// that does not start another block, including pipe-less rows and prose).
const ATX_RE = /^ {0,3}#{1,6}(?:\s|$)/;
const HR_RE = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const ULIST_RE = /^ {0,3}[-*+](?:\s|$)/;
const OLIST_RE = /^ {0,3}\d{1,9}[.)](?:\s|$)/;
// 'end-pipe SPACE start-pipe' — the collapsed-row join tell.
const ROW_JOIN_TEST_RE = /\| \| (?=\S)/;
const ROW_JOIN_COUNT_RE = /\| \| (?=\S)/g;
// A |---| delimiter sitting mid-line (before-text non-blank = not a real row).
const MIDLINE_DELIM_RE = /\|(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?/;
// A ≥2-cell pipe run ENDING a prose line (glued-header tell — the normalizer's
// GLUED_TABLE_HEADER_RE shape). The prose-before requirement is checked by the
// caller (first pipe not at index 0).
const GLUED_HEADER_TEST_RE = /(\|[^\n|]+)+\|\s*$/;
// Flattened bold-led list markers ('…:** - **x** - **y**' / '- **x** - **y**').
const FLAT_BOLD_MARKER_RE = /(?:^|\s)- \*\*/g;
const FLAT_BOLD_INTRO_RE = /:\*{2} (?=(?:- |\d{1,2} )\*\*)/;
// Flattened plain-dash list with a colon intro ('…and next: - a - b - c').
const FLAT_PLAIN_DASH_INTRO_RE = /:(?= - )/;
const FLAT_PLAIN_DASH_MARKER_RE = /(?:^|\s)- (?=\S)/g;
// Protected regions (canvas/email/follow-up) — their interiors are
// byte-identical by contract (markdown-normalize.ts's PROTECTED_REGION_RE);
// the degrade never rewrites inside them (adversarial review N2).
const PROTECTED_REGION_RE =
  /\[(?:CANVAS(?::[^\]\n]*)?|SEND_EMAIL(?:[^\]\n]*)?|FOLLOWUPS)\][\s\S]*?(?:\[\/(?:CANVAS|SEND_EMAIL|FOLLOWUPS)\]|$)/gi;

const isBlank = (line: string): boolean => line.trim() === '';

/**
 * Split a table line on UNESCAPED pipes only (adversarial review B2: the
 * renderer treats '\|' inside a cell as literal content — a naive split('|')
 * over-counts 'A \| B' as two cells, fails the header/delimiter match and the
 * degrade destroys a renderer-VALID table). Escape semantics left-to-right:
 * a backslash escapes the NEXT character whatever it is, so '\\|' is an
 * escaped backslash followed by a REAL delimiter pipe.
 */
function splitUnescapedPipes(line: string): string[] {
  const parts: string[] = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[i + 1];
      i++;
      continue;
    }
    if (ch === '|') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * GFM-accurate cell split of a table line: interior cells, empties included,
 * with the optional leading/trailing framing pipes dropped. 'A | B' and
 * '| A | B |' both count 2 cells (adversarial review B1: GFM does not require
 * the pipes; B2: escaped pipes are cell content, not delimiters).
 */
function tableLineCells(line: string): string[] {
  const parts = splitUnescapedPipes(line.trim());
  let i = 0;
  let j = parts.length - 1;
  if (parts[i].trim() === '') i++;
  if (j > i && parts[j].trim() === '') j--;
  return parts.slice(i, j + 1).map((s) => s.trim());
}

/** A GFM delimiter row: every cell is dashes/colons only (≥1 dash), pipes
 * optional at the edges ('|---|---|', '---|---', '- | -'). Null when not one. */
function delimiterCells(line: string): string[] | null {
  if (isBlank(line) || BQ_PREFIX_RE.test(line) || INDENT_RE.test(line)) return null;
  if (!line.includes('|')) return null;
  const cells = tableLineCells(line);
  if (cells.length < 1) return null;
  if (!cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells;
}

/** A GFM table header candidate: a non-blank, unquoted, unfenced line that
 * CONTAINS a pipe (the pipes themselves are optional — B1). */
function headerCells(line: string): string[] | null {
  if (isBlank(line) || BQ_PREFIX_RE.test(line) || INDENT_RE.test(line)) return null;
  if (FENCE_RE.test(line)) return null;
  if (!line.includes('|')) return null;
  const cells = tableLineCells(line);
  if (cells.length < 1) return null;
  return cells;
}

/** Does this line END a GFM table body? (blank, fence, blockquote, indented
 * code, or a new block start: heading / thematic break / list item.) */
function endsTableBody(line: string): boolean {
  if (isBlank(line)) return true;
  if (FENCE_RE.test(line)) return true;
  if (BQ_PREFIX_RE.test(line)) return true;
  if (/^ {4,}/.test(line)) return true; // indented code
  if (ATX_RE.test(line) || HR_RE.test(line) || ULIST_RE.test(line) || OLIST_RE.test(line)) return true;
  return false;
}

/** One fence-tracking pass shared by lint + degrade: returns the set of line
 * indexes that live INSIDE a fenced code block (never linted, never touched). */
function fencedLineIndexes(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let inFence = false;
  let fenceChar = '`';
  let fenceLen = 0;
  let fenceMarkers = 0;
  const bqMarkerCount = (prefix: string): number => (prefix.match(/>/g) || []).length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = FENCE_RE.exec(line);
    if (m) {
      const ch = m[2][0];
      const len = m[2].length;
      const markers = bqMarkerCount(m[1]);
      if (!inFence) {
        inFence = true;
        fenceChar = ch;
        fenceLen = len;
        fenceMarkers = markers;
      } else if (markers < fenceMarkers) {
        // shallower quote depth opens a NEW fence (renderer parity with
        // markdown-normalize's 65a0b4d5 fence tracking)
        fenceChar = ch;
        fenceLen = len;
        fenceMarkers = markers;
      } else if (markers === fenceMarkers && ch === fenceChar && len >= fenceLen) {
        inFence = false;
        continue; // the closer line itself is fence chrome, not content
      }
      fenced.add(i);
      continue;
    }
    if (inFence) {
      if (fenceMarkers === 0) {
        fenced.add(i);
        continue;
      }
      // blockquote-prefixed fence: only prefixed lines are content
      const bq = BQ_PREFIX_RE.test(line);
      if (bq) {
        fenced.add(i);
        continue;
      }
      if (isBlank(line)) {
        fenced.add(i);
        continue;
      }
      inFence = false; // renderer ended the fence here — fall through
    }
  }
  return fenced;
}

/** Line offsets of PROTECTED regions ([CANVAS]…[/CANVAS], [SEND_EMAIL],
 * [FOLLOWUPS]) — their interiors are byte-identical by contract and are never
 * linted or degraded (adversarial review N2). */
function protectedCharRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  PROTECTED_REGION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROTECTED_REGION_RE.exec(text))) {
    ranges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) PROTECTED_REGION_RE.lastIndex++;
  }
  return ranges;
}

/** Line indexes whose start offset falls inside a protected region. */
function protectedLineIndexes(lines: string[], ranges: Array<[number, number]>): Set<number> {
  const out = new Set<number>();
  if (ranges.length === 0) return out;
  let offset = 0;
  let ri = 0;
  for (let i = 0; i < lines.length; i++) {
    while (ri < ranges.length && offset >= ranges[ri][1]) ri++;
    if (ri < ranges.length && offset >= ranges[ri][0] && offset < ranges[ri][1]) out.add(i);
    offset += lines[i].length + 1; // +1 for the '\n'
  }
  return out;
}

/**
 * Line indexes the renderer shows as part of a STRUCTURALLY VALID GFM table
 * (adversarial review B1 — the model must match the renderer, verified against
 * the repo's GFM renderer):
 *   - the header's pipes are OPTIONAL ('A | B' is as valid as '| A | B |');
 *   - the delimiter row's pipes are optional too ('---|---', '- | -'), and its
 *     CELL COUNT MUST MATCH the header's (a mismatch is not a table at all);
 *   - the body continues through ANY line that does not start another block —
 *     including pipe-less rows ('1 | 2') and plain prose — and ends only at a
 *     blank line, a fence, a blockquote, indented code, a heading, a thematic
 *     break or a list item.
 * These lines render as a real table — never struck, never degraded.
 */
function tableRegionLineIndexes(
  lines: string[],
  fenced: Set<number>,
  protectedLines: Set<number>,
): Set<number> {
  const valid = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i) || protectedLines.has(i)) continue;
    const header = headerCells(lines[i]);
    if (!header) continue;
    if (i + 1 >= lines.length || fenced.has(i + 1) || protectedLines.has(i + 1)) continue;
    const delim = delimiterCells(lines[i + 1]);
    if (!delim || delim.length !== header.length) continue; // GFM: cell counts must match
    valid.add(i);
    valid.add(i + 1);
    let j = i + 2;
    while (j < lines.length && !fenced.has(j) && !protectedLines.has(j) && !endsTableBody(lines[j])) {
      valid.add(j);
      j++;
    }
    i = j - 1; // resume scanning at the line that ended the body
  }
  return valid;
}

/**
 * Lint one machine note's markdown structure. Pure, model-free, never throws
 * on well-formed input; every strike names its class and a short excerpt.
 * Lines inside fenced code, blockquotes and indented code are deliberately
 * skipped (the normalizer's guards skip them too — they are prose-by-design).
 */
export function lintMarkdownNote(text: string): MarkdownLintResult {
  const strikes: MarkdownLintStrike[] = [];
  if (!text || typeof text !== 'string') return { strikes };
  try {
    const lines = text.split('\n');
    const fenced = fencedLineIndexes(lines);
    const protectedLines = protectedLineIndexes(lines, protectedCharRanges(text));
    const validTable = tableRegionLineIndexes(lines, fenced, protectedLines);
    // Classify: a strike is only emitted for lines the renderer will actually
    // show as raw pipes / broken structure — never for a line inside a
    // VALID table region (adversarial review B1: the region continues through
    // pipe-less body rows), never for prose that merely CONTAINS pipes.
    let prevNonBlankKind: 'delim' | 'other' | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (fenced.has(i) || protectedLines.has(i)) continue;
      if (isBlank(line)) continue;
      if (BQ_PREFIX_RE.test(line) || INDENT_RE.test(line)) {
        prevNonBlankKind = 'other';
        continue;
      }
      const pipeLed = PIPE_LED_RE.test(line);
      if (pipeLed && !validTable.has(i)) {
        let cls: MarkdownLintClass | null = null;
        if (DELIM_ROW_RE.test(line)) {
          // a delimiter row NOT under a pipe-led header — orphaned (its
          // header was glued to prose or dropped); renders as raw pipes
          cls = 'table_pseudo_row';
        } else if (MIDLINE_DELIM_RE.test(line)) {
          cls = 'table_midline_delimiter';
        } else if (ROW_JOIN_TEST_RE.test(line)) {
          cls =
            prevNonBlankKind === 'delim'
              ? 'table_detached_body' // the table's delimiter sits above (across a blank) — GFM ended the table there
              : (line.match(ROW_JOIN_COUNT_RE) || []).length >= 2
                ? 'table_joined_rows'
                : 'table_pseudo_row';
        } else {
          cls = 'table_pseudo_row'; // lone pipe row with no valid table above it
        }
        strikes.push({ cls, line: i + 1, excerpt: line.slice(0, 120) });
      } else if (!pipeLed) {
        // glued header: a ≥2-cell pipe run ENDING a prose line — the run's
        // first pipe must not be the line's first character (a pipe-led line
        // took the branch above).
        const firstPipe = line.indexOf('|');
        if (firstPipe > 0 && GLUED_HEADER_TEST_RE.test(line)) {
          strikes.push({ cls: 'table_glued_header', line: i + 1, excerpt: line.slice(0, 120) });
        } else if (MIDLINE_DELIM_RE.test(line) && line.slice(0, line.indexOf('|')).trim()) {
          // fdd85bb3 class: a |---| delimiter glued mid-PROSE (not at line
          // start — the delimiter row's own branch above owns pipe-led ones).
          // Renders as one pipe-littered wall.
          strikes.push({ cls: 'table_midline_delimiter', line: i + 1, excerpt: line.slice(0, 120) });
        } else {
          // flattened run-on lists (telemetry class — the normalizer's gated
          // repairs own the actual splitting)
          const boldMarkers = (line.match(FLAT_BOLD_MARKER_RE) || []).length;
          const plainIntro = FLAT_PLAIN_DASH_INTRO_RE.test(line);
          const plainMarkers = plainIntro ? (line.match(FLAT_PLAIN_DASH_MARKER_RE) || []).length : 0;
          if ((boldMarkers >= 2 && (FLAT_BOLD_INTRO_RE.test(line) || /^\s*-\s/.test(line))) || (plainIntro && plainMarkers >= 3)) {
            strikes.push({ cls: 'flat_list', line: i + 1, excerpt: line.slice(0, 120) });
          }
        }
      }
      prevNonBlankKind = DELIM_ROW_RE.test(line) ? 'delim' : 'other';
    }
  } catch {
    return { strikes: [] as MarkdownLintStrike[] }; // fail-open: lint never blocks delivery
  }
  return { strikes };
}

/**
 * Degrade every pipe-led line that is not part of a structurally valid GFM
 * table into plain bullets — the ticket's "never ship raw pipes" backstop for
 * exactly the lines the normalizer's fail-safe repairs deliberately left
 * alone (ragged bodies, prose-glued tails that failed a gate, orphan rows).
 * Collapsed rows ('| a | b | | c | d |') become one bullet per row with cells
 * joined by ' — '. An all-dash orphan delimiter row is dropped (no content).
 * Fenced code, blockquotes and indented code are never touched. Idempotent:
 * bullets carry no pipes, so a second pass is a no-op.
 */
export function degradeMachineNotePipes(text: string): DegradeMachineNoteResult {
  if (!text || typeof text !== 'string' || !text.includes('|')) {
    return { text, degradedLines: [] };
  }
  try {
    const lines = text.split('\n');
    const fenced = fencedLineIndexes(lines);
    const protectedLines = protectedLineIndexes(lines, protectedCharRanges(text));
    const validTable = tableRegionLineIndexes(lines, fenced, protectedLines);
    const out: string[] = [];
    const degradedLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (
        fenced.has(i) ||
        protectedLines.has(i) ||
        validTable.has(i) ||
        isBlank(line) ||
        BQ_PREFIX_RE.test(line) ||
        INDENT_RE.test(line) ||
        !PIPE_LED_RE.test(line)
      ) {
        out.push(line);
        continue;
      }
      // ── a pseudo-row: degrade to bullets ──
      // split collapsed rows on the ' | | ' join tell first (guarding inline
      // code: an odd backtick count before a join means the pipes are inside
      // backticks — leave the whole line alone)
      ROW_JOIN_COUNT_RE.lastIndex = 0;
      const cuts: number[] = [];
      let m: RegExpExecArray | null;
      while ((m = ROW_JOIN_COUNT_RE.exec(line))) {
        const before = line.slice(0, m.index);
        if ((before.split('`').length - 1) % 2 === 1) continue; // inside inline code
        cuts.push(m.index);
      }
      const rowTexts: string[] = [];
      let prev = 0;
      for (const c of cuts) {
        rowTexts.push(line.slice(prev, c + 1));
        prev = c + 2;
      }
      rowTexts.push(line.slice(prev));
      let emittedAny = false;
      let droppedPureNoise = false;
      for (const rowText of rowTexts) {
        // Backtick-safe cells: a row carrying backticks may hold INLINE CODE
        // with its own pipes ('`a | | b`') — splitting cells on '|' there
        // shatters the code span (data corruption). Such a row degrades as
        // ONE bullet with its internal text preserved verbatim (internal
        // pipes inside a bullet are harmless literals — only pipe-LED lines
        // look like broken tables).
        if (rowText.includes('`')) {
          const stripped = rowText.trim().replace(/^\|/, '').replace(/\|\s*$/, '').trim();
          if (!stripped) {
            droppedPureNoise = true;
            continue;
          }
          const strippedCells = stripped.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
          if (strippedCells.length === 0 || strippedCells.every((c) => /^:?-{2,}:?$/.test(c))) {
            droppedPureNoise = true;
            continue;
          }
          out.push(`- ${stripped}`);
          emittedAny = true;
          continue;
        }
        const cells = rowText
          .split('|')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (cells.length === 0) {
          droppedPureNoise = true; // framing pipes only — no content to keep
          continue;
        }
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) {
          droppedPureNoise = true; // orphan delimiter content — no information
          continue;
        }
        out.push(`- ${cells.join(' — ')}`);
        emittedAny = true;
      }
      if (emittedAny || droppedPureNoise) degradedLines.push(line.slice(0, 120));
      if (!emittedAny && droppedPureNoise) {
        // the line carried only framing pipes / delimiter noise: DROP it, but
        // keep a blank line so the surrounding paragraphs don't merge into one
        out.push('');
      }
    }
    if (degradedLines.length === 0) return { text, degradedLines: [] };
    return { text: out.join('\n').replace(/\n{3,}/g, '\n\n'), degradedLines };
  } catch {
    return { text, degradedLines: [] }; // fail-open: degrade never blocks delivery
  }
}
