/**
 * Tests for platform/markdown-lint.ts — the deterministic structural lint for
 * machine notes (ticket 942db7aa, 2026-10-15): the Fleet Supervisor's
 * owner-facing reply emitted a malformed table (all data rows joined on one
 * line behind a blank, prose glued after the last row) and the owner saw raw
 * pipes. The lint measures the emitted classes; the degrade backstop
 * bulletizes any pipe-led line outside a valid table so raw pipes never ship.
 */

import { lintMarkdownNote, degradeMachineNotePipes, markdownLintDisabled } from './markdown-lint';

const classesOf = (text: string): string[] => [
  ...new Set(lintMarkdownNote(text).strikes.map((s) => s.cls)),
];

describe('lintMarkdownNote (ticket 942db7aa)', () => {
  it('reports zero strikes on a well-formed note with a valid table', () => {
    const good = [
      '**Fleet wake — 5:26 PM PDT:**',
      '',
      '| Project | What moved | Next |',
      '|---|---|---|',
      '| Digby framework | Both fix PRs merged | Deploy wave rolling |',
      '| LiteLLM | Key re-mint card in inbox | Your call |',
      '',
      '- bullet one',
      '- bullet two',
    ].join('\n');
    expect(lintMarkdownNote(good).strikes).toEqual([]);
  });

  it('strikes the 942db7aa incident shape: joined body behind a blank = table_detached_body', () => {
    // the incident body line AFTER the normalizer's repair failed (ragged) —
    // this is what the lint must see when the note is emitted malformed
    const incident = [
      '| Item | State |',
      '|---|---|',
      '',
      '| CQL Cloudflare token | ✅ Resolved — nothing to do | | Tailscale tagOwners paste | Still open — one ACL paste | | LiteLLM provider-key re-mint | Still open — 34 legs dark | | Schooltime recovery-email pick | Still open — mail provider decision | I\'ve corrected the fleet record and updated the credential ticket to reflect your call',
    ].join('\n');
    const res = lintMarkdownNote(incident);
    expect(classesOf(incident)).toContain('table_detached_body');
    expect(res.strikes[0].line).toBe(4); // 1-based line number of the body
    expect(res.strikes[0].excerpt).toContain('CQL Cloudflare token');
  });

  it('strikes joined rows with no delimiter above as table_joined_rows', () => {
    const text = 'Intro line.\n\n| a | b | | c | d | | e | f |';
    expect(classesOf(text)).toContain('table_joined_rows');
  });

  it('strikes a mid-line delimiter as table_midline_delimiter', () => {
    const text = 'Item Status Detail |---|---|--- cells flowing as prose';
    expect(classesOf(text)).toContain('table_midline_delimiter');
  });

  it('strikes a glued header (pipe run ending a prose line)', () => {
    const text = '**Wake note — x** | Item | Status |';
    expect(classesOf(text)).toContain('table_glued_header');
  });

  it('strikes an orphan pipe row with no table above it', () => {
    const text = 'Some prose.\n\n| a | b |';
    expect(classesOf(text)).toContain('table_pseudo_row');
  });

  it('strikes a run-on flattened bold-led list', () => {
    const text = 'Status:** - **Lane A:** running - **Lane B:** done - **Lane C:** idle';
    expect(classesOf(text)).toContain('flat_list');
  });

  it('does NOT strike prose that merely contains pipes', () => {
    const prose = 'Choose a | b or c — the pipes here are just typography.';
    expect(lintMarkdownNote(prose).strikes).toEqual([]);
  });

  it('does NOT strike valid table rows, fences, blockquotes or indented code', () => {
    const text = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```',
      '| joined | inside | | code | block |',
      '```',
      '',
      '> | quoted | table |',
      '',
      '    | indented | code | | row |',
    ].join('\n');
    expect(lintMarkdownNote(text).strikes).toEqual([]);
  });

  it('survives garbage input without throwing (fail-open)', () => {
    expect(lintMarkdownNote('').strikes).toEqual([]);
    // @ts-expect-error deliberate garbage
    expect(lintMarkdownNote(null).strikes).toEqual([]);
    // @ts-expect-error deliberate garbage
    expect(lintMarkdownNote(undefined).strikes).toEqual([]);
    expect(lintMarkdownNote('| a | | b | | c |').strikes.length).toBeGreaterThan(0);
  });
});

describe('degradeMachineNotePipes (the never-ship-raw-pipes backstop)', () => {
  it('bulletizes the 942db7aa residual class: a ragged joined body the repair deliberately left alone', () => {
    // the first piece carries 3 cells vs the 2-cell anchor — the repair's
    // fail-safe leaves this untouched; the backstop must not ship it as pipes
    const input = '| A | B |\n|---|---|\n\n| a | b | c | | d | e | | f | g |';
    const res = degradeMachineNotePipes(input);
    expect(res.text).toBe(
      ['| A | B |', '|---|---|', '', '- a — b — c', '- d — e', '- f — g'].join('\n'),
    );
    expect(res.degradedLines.length).toBe(1);
  });

  it('bulletizes the second incident note shape where a pipe-LED row renders as pipes (prose pipes stay prose)', () => {
    // msg 9fd806f8 (23:06Z): a one-line table with no delimiter; the
    // pipe-LED fragment degrades to a bullet. Prose lines carrying single
    // pipes are DELIBERATELY untouched — bullets there would mangle ordinary
    // sentences ('a | b' is typography, not a table row).
    const input = 'Instead of me relying on memory:\n\n| CQL Cloudflare token ✅ Present in Coding secrets all along nothing needed | Tailscale paste Surfaces 4:58 PM PDT one ACL paste for the three new boxes';
    const res = degradeMachineNotePipes(input);
    // ONE row, two cells → ONE bullet, cells joined by ' — ' (the em-dash
    // join reads as prose; no pipe-led line survives)
    expect(res.text).toBe(
      'Instead of me relying on memory:\n\n- CQL Cloudflare token ✅ Present in Coding secrets all along nothing needed — Tailscale paste Surfaces 4:58 PM PDT one ACL paste for the three new boxes',
    );
    expect(res.text).not.toMatch(/^\s*\|/m); // no pipe-led line survives
    expect(lintMarkdownNote(input).strikes.map((s) => s.cls)).toContain('table_pseudo_row');
  });

  it('leaves a structurally valid table completely untouched', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |';
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('drops a pure-noise orphan delimiter row (no content) and keeps paragraph separation', () => {
    const input = 'Para one.\n\n|---|---|\n\nPara two.';
    const res = degradeMachineNotePipes(input);
    expect(res.text).toBe('Para one.\n\n\n\nPara two.'.replace(/\n{3,}/g, '\n\n'));
    expect(res.degradedLines.length).toBe(1);
  });

  it('is idempotent: bullets carry no pipes, a second pass is a no-op', () => {
    const input = '| A | B |\n|---|---|\n\n| a | b | c | | d | e |';
    const once = degradeMachineNotePipes(input);
    const twice = degradeMachineNotePipes(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.degradedLines).toEqual([]);
  });

  it('never touches fenced code, blockquotes or indented code', () => {
    const input = [
      '```',
      '| code | pipes | | live | here |',
      '```',
      '',
      '> | quoted | row | | joined |',
      '',
      '    | indented | row |',
    ].join('\n');
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('never splits a join inside inline code (backtick guard)', () => {
    const input = 'cmd output `a | | b` tail';
    // no pipe-led line at all — nothing to degrade
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
    const input2 = '| leading `a | | b` c | | d | e |';
    const res = degradeMachineNotePipes(input2);
    // the inline-code join is protected; the whole line degrades as rows at
    // the OUTSIDE joins only — the backticked pipes stay inside one cell
    expect(res.text).toContain('`a | | b`');
    expect(res.text).not.toMatch(/^- .*`a \| \| b` c \| d/);
  });

  it('survives garbage input without throwing (fail-open)', () => {
    expect(degradeMachineNotePipes('')).toEqual({ text: '', degradedLines: [] });
    // @ts-expect-error deliberate garbage
    expect(degradeMachineNotePipes(null)).toEqual({ text: null, degradedLines: [] });
    expect(degradeMachineNotePipes('no pipes at all')).toEqual({
      text: 'no pipes at all',
      degradedLines: [],
    });
  });
});

describe('markdownLintDisabled (kill switch)', () => {
  const ORIGINAL = process.env.MARKDOWN_NOTE_LINT_DISABLED;
  afterAll(() => {
    if (ORIGINAL === undefined) delete process.env.MARKDOWN_NOTE_LINT_DISABLED;
    else process.env.MARKDOWN_NOTE_LINT_DISABLED = ORIGINAL;
  });

  it('is off by default and on when MARKDOWN_NOTE_LINT_DISABLED=1', () => {
    delete process.env.MARKDOWN_NOTE_LINT_DISABLED;
    expect(markdownLintDisabled()).toBe(false);
    process.env.MARKDOWN_NOTE_LINT_DISABLED = '1';
    expect(markdownLintDisabled()).toBe(true);
  });
});

describe('adversarial review 5c89ad52 — B1: GFM-valid tables are never struck or degraded', () => {
  // The reviewer proved with the repo's own GFM renderer that these shapes
  // render as VALID tables. The lint's table model must match the renderer:
  // optional pipes, body continuation through non-block lines.
  it('S9: a table body continues through a pipe-less body row — no strike, no degrade', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |\n1 | 2\n| 3 | 4 |';
    expect(lintMarkdownNote(input).strikes).toEqual([]);
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('S9b: pipe-less header + pipe-less delimiter is a valid GFM table — untouched', () => {
    const input = 'A | B\n---|---\n| 1 | 2 |';
    expect(lintMarkdownNote(input).strikes).toEqual([]);
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('a body continues through plain prose rows (no pipes) until a real block ends it', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |\nplain text no pipes\n| 3 | 4 |';
    expect(lintMarkdownNote(input).strikes).toEqual([]);
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('a table ends at a heading/list/HR — rows after the block ARE struck again', () => {
    const headingBreaks = '| A | B |\n|---|---|\n| 1 | 2 |\n## Heading\n| 3 | 4 |';
    expect(lintMarkdownNote(headingBreaks).strikes.map((s) => s.cls)).toContain('table_pseudo_row');
    const listBreaks = '| A | B |\n|---|---|\n| 1 | 2 |\n- item\n| 3 | 4 |';
    expect(lintMarkdownNote(listBreaks).strikes.map((s) => s.cls)).toContain('table_pseudo_row');
    const hrBreaks = '| A | B |\n|---|---|\n| 1 | 2 |\n---\n| 3 | 4 |';
    expect(lintMarkdownNote(hrBreaks).strikes.map((s) => s.cls)).toContain('table_pseudo_row');
  });

  it('a delimiter whose cell count mismatches the header is NOT a table (GFM rejects it)', () => {
    // 2-cell header, 3-cell delimiter — renders as prose: both lines strike
    const input = '| a | b |\n|---|---|---|\n| 1 | 2 |';
    const cls = lintMarkdownNote(input).strikes.map((s) => s.cls);
    expect(cls).toContain('table_pseudo_row'); // the delimiter row is orphaned
  });

  it('single-dash delimiter cells are valid (GFM allows - | -)', () => {
    const input = '| a | b |\n- | -\n| 1 | 2 |';
    expect(lintMarkdownNote(input).strikes).toEqual([]);
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('N2: canvas-region interiors are never linted or degraded', () => {
    const input = 'Intro.\n\n[CANVAS]\n| broken | table | | rows |\n|---|---|\n[/CANVAS]\n\nTail.';
    expect(lintMarkdownNote(input).strikes).toEqual([]);
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });
});

describe('adversarial review 5c89ad52 — N1: no manufactured empty cells in the repair', () => {
  // (the repair itself is in markdown-normalize; its oracle lives here so the
  // lint module's tests carry the review's break-attempt record)
  it('N1 shape: a 1-cell last piece against a 2-cell anchor is NOT repaired (no "| c ||")', () => {
    const { normalizeAssistantMarkdown } = require('../markdown-normalize');
    // 2-cell anchor; pieces: ['| a |', '| c |'] — the second carries 1 cell,
    // NOT 2: with framing-pipe semantics the length gate must fail
    const input = '| A | B |\n|---|---|\n\n| a | b | | c |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });
});

describe('adversarial review 5c89ad52 — B2: escaped pipes in headers (renderer-valid tables)', () => {
  // The renderer splits table lines on UNESCAPED pipes only: '\|' inside a
  // cell is literal content. A naive split('|') over-counts the header, the
  // delimiter match fails, and the degrade would destroy a VALID table.
  it('X1: escaped pipe in a 2-col header — valid table, untouched', () => {
    const input = '| A \\| B | C |\n|---|---|\n| 1 | 2 |';
    expect(lintMarkdownNote(input).strikes).toEqual([]);
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('X1 single-column variant: "| a \\| b |" + "|---|" — valid, untouched', () => {
    const input = '| a \\| b |\n|---|\n| 1 |';
    expect(lintMarkdownNote(input).strikes).toEqual([]);
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('realistic CLI-flag header "| Option \\|--verbose\\| | Effect |" — valid, untouched', () => {
    const input = '| Option \\|--verbose\\| | Effect |\n|---|---|\n| --verbose | logs |';
    expect(lintMarkdownNote(input).strikes).toEqual([]);
    expect(degradeMachineNotePipes(input)).toEqual({ text: input, degradedLines: [] });
  });

  it('an escaped backslash before a pipe (\\\\|) is an escaped backslash + a REAL delimiter', () => {
    // 'a\\|b' = escaped-backslash then real pipe: THREE cells ('a\', 'b', 'C')
    // — valid ONLY against a 3-cell delimiter (oracle: 2-cell delimiter = NO TABLE)
    const valid = '| a\\\\|b | C |\n|---|---|---|\n| 1 | 2 | 3 |';
    expect(lintMarkdownNote(valid).strikes).toEqual([]);
    expect(degradeMachineNotePipes(valid)).toEqual({ text: valid, degradedLines: [] });
    const invalid = '| a\\\\|b | C |\n|---|---|\n| 1 | 2 |';
    expect(lintMarkdownNote(invalid).strikes.map((s) => s.cls)).toContain('table_pseudo_row');
  });

  it('a pipe-less header whose only pipe is escaped is NOT a table (oracle: renders as prose)', () => {
    // 'A \| B' has no UNESCAPED pipe — not a header candidate at all
    const input = 'A \\| B\n---|---\n| 1 | 2 |';
    const cls = lintMarkdownNote(input).strikes.map((s) => s.cls);
    expect(cls).toContain('table_pseudo_row'); // the body rows strike; the renderer shows prose
  });
});
