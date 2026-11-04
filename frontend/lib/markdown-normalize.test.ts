/**
 * Tests for lib/markdown-normalize.ts — the render-time repair for degraded
 * model output (feedback fc841f58 / 5393e948: long conversations lose the
 * blank lines markdown needs, so ## / ** / - render as raw characters).
 *
 * Mirrors backend/src/modules/crossmodel/markdown-normalize.test.ts — keep in sync.
 */

import { describe, it, expect } from 'vitest';
import { normalizeMarkdownForRender } from './markdown-normalize';

describe('normalizeMarkdownForRender', () => {
  it('passes well-formed markdown through unchanged', () => {
    const good = 'Intro paragraph.\n\n## Section\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(normalizeMarkdownForRender(good)).toBe(good);
  });

  it('inserts a blank line before a heading that follows text (single-newline degrade)', () => {
    expect(normalizeMarkdownForRender('Some intro\n## Heading\nBody')).toBe(
      'Some intro\n\n## Heading\nBody'
    );
  });

  it('inserts a blank line before a list that follows a lead-in line (grocery-list case)', () => {
    const input = '**Cooler:**\n- 1 lb ground beef\n- 1.5 lb baby potatoes';
    expect(normalizeMarkdownForRender(input)).toBe(
      '**Cooler:**\n\n- 1 lb ground beef\n- 1.5 lb baby potatoes'
    );
  });

  it('keeps consecutive list items tight (no blanks inserted between them)', () => {
    const input = 'List:\n- a\n- b\n  - nested\n- c';
    expect(normalizeMarkdownForRender(input)).toBe('List:\n\n- a\n- b\n  - nested\n- c');
  });

  it('handles ordered lists that do not start at 1 (CommonMark cannot interrupt with 2.)', () => {
    const input = 'Steps:\n1. first\n2. second';
    expect(normalizeMarkdownForRender(input)).toBe('Steps:\n\n1. first\n2. second');
  });

  it('converts accidental setext ("text\\n---") into paragraph + thematic break', () => {
    // Without the blank line, CommonMark renders "Some text" as a giant H2 —
    // the "big bold ugly" half of the formatting complaints (da7dc5ea).
    expect(normalizeMarkdownForRender('Some text\n---\nNext section')).toBe(
      'Some text\n\n---\nNext section'
    );
  });

  it('inserts a blank line before a GFM table that follows text', () => {
    const input = 'Here is the table:\n| Method | Time |\n|---|---|\n| Grill | 30 min |';
    expect(normalizeMarkdownForRender(input)).toBe(
      'Here is the table:\n\n| Method | Time |\n|---|---|\n| Grill | 30 min |'
    );
  });

  it('repairs the fully-collapsed single-line answer (mid-line ## splits)', () => {
    const input = 'Here is the ruleset: ## Setup 1. First thing 2. Second thing ### Details More prose';
    expect(normalizeMarkdownForRender(input)).toBe(
      'Here is the ruleset:\n\n## Setup 1. First thing 2. Second thing\n\n### Details More prose'
    );
  });

  it('never splits a mid-line ## inside inline code', () => {
    const input = 'Use `echo hi ## comment` to run it';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never touches fenced code block content', () => {
    const input = 'Code:\n```python\n# comment\ndef f():\n  return "## not a heading"\n```\nAfter';
    expect(normalizeMarkdownForRender(input)).toBe(
      'Code:\n\n```python\n# comment\ndef f():\n  return "## not a heading"\n```\nAfter'
    );
  });

  it('separates a fence opening that directly follows text', () => {
    const input = 'Try this:\n```\nls -la\n```';
    expect(normalizeMarkdownForRender(input)).toBe('Try this:\n\n```\nls -la\n```');
  });

  it('leaves [SEND_EMAIL] bodies byte-identical', () => {
    const email = '[SEND_EMAIL to="a@b.c" subject="Hi"]\nDear X\n- not a list, prose dash\n[/SEND_EMAIL]';
    const input = `Here is the draft:\n${email}`;
    expect(normalizeMarkdownForRender(input)).toBe(`Here is the draft:\n${email}`);
  });

  it('collapses 3+ consecutive newlines', () => {
    expect(normalizeMarkdownForRender('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('is idempotent', () => {
    const messy =
      'Intro text ## Heading One\n**Lead:**\n- item one\n- item two\nSome text\n---\n| a | b |\n|---|---|\n```js\nconst x = 1 ## nope\n```\nMore';
    const once = normalizeMarkdownForRender(messy);
    expect(normalizeMarkdownForRender(once)).toBe(once);
  });

  it('handles empty and single-line input', () => {
    expect(normalizeMarkdownForRender('')).toBe('');
    expect(normalizeMarkdownForRender('plain single line')).toBe('plain single line');
  });

  // ── Adversarial-review regressions (PR #286 review: B1 / M1 / M2) ─────────
  it('B1: nested fences — a 3-backtick line inside a 4-backtick block stays code', () => {
    const input = 'Example:\n````\n```python\n# setup\nx = 1\n```\n````\nDone';
    expect(normalizeMarkdownForRender(input)).toBe(
      'Example:\n\n````\n```python\n# setup\nx = 1\n```\n````\nDone'
    );
  });

  it('M1: valid setext H1 ("Title\\n===") is preserved, not turned into literal junk', () => {
    const input = 'My Document Title\n=================\n\nBody';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('M2: a lone " # " in prose is not a heading ("team is # 1")', () => {
    const input = 'Our team is # 1 in the league this year';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('M2: a lone mid-line " ## " is left alone (conservative — ambiguous with prose)', () => {
    const input = 'Perfect — here is the plan: ## Meal Plan (2 nights)';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('M2: never splits inside a bold span', () => {
    const input = 'This is **really ## important** stuff';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('M2: never de-indents a 4-space indented code block into a heading', () => {
    const input = 'Intro\n\n    ## not a heading\n\nMore';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('handles CRLF line endings', () => {
    expect(normalizeMarkdownForRender('a\r\n## b')).toBe('a\n\n## b');
  });

  // ── Run-on heading demotion (feedback 814809bf) ─────────────────────────
  // Newest long-conversation degrade: the model drops intra-section newlines
  // AND sentence-ending periods, fusing heading + whole paragraph onto ONE
  // giant "## …" line per section. splitCollapsedHeadings can't help (the
  // marker is at line start, alone), so the line renders as a giant bold H2 —
  // the user's "all bold" report.
  describe('run-on heading demotion (814809bf)', () => {
    // Builds a fused heading line of EXACTLY `total` chars — period-free, no
    // mid-line "##", no backticks, mirroring the degraded production shape.
    const headingLine = (total: number) => {
      const body = 'fused heading and paragraph text without periods ';
      return `## ${body.repeat(Math.ceil(total / body.length))}`.slice(0, total);
    };

    const SEC1 =
      '## Question 1 — Overview, origin story, impact (~2,400 chars) Canada Quant Labs is a BC corporation building sovereign open-weight AI infrastructure It did not start as a pitch deck it grew out of a research collective';
    const SEC2 =
      '## Question 2 — Funding, runway, and investors the company raised quietly over two years while keeping the cap table focused on aligned Canadian backers and sovereign compute partners';

    it('demotes fused heading+paragraph run-on lines (the 814809bf production shape)', () => {
      expect(SEC1.length).toBeGreaterThan(160);
      expect(SEC2.length).toBeGreaterThan(160);
      const input = `${SEC1}\n\n${SEC2}`;
      const expected = `${SEC1.replace(/^## /, '')}\n\n${SEC2.replace(/^## /, '')}`;
      const out = normalizeMarkdownForRender(input);
      expect(out).toBe(expected);
      expect(out).not.toContain('##');
    });

    it('keeps a heading line of exactly 160 chars and demotes one of 161 (boundary)', () => {
      const at160 = headingLine(160);
      const at161 = headingLine(161);
      expect(at160.length).toBe(160);
      expect(at161.length).toBe(161);
      expect(normalizeMarkdownForRender(at160)).toBe(at160);
      expect(normalizeMarkdownForRender(at161)).toBe(at161.replace(/^## /, ''));
    });

    it('leaves a normal short heading unchanged', () => {
      const input = 'Intro paragraph.\n\n## Question 1 — Overview\n\nBody text.';
      expect(normalizeMarkdownForRender(input)).toBe(input);
      expect(normalizeMarkdownForRender('## Question 1 — Overview')).toBe(
        '## Question 1 — Overview'
      );
    });

    it('never demotes a run-on heading inside a fenced code block (byte-identical)', () => {
      const runOn = headingLine(400);
      const input = `Code:\n\n\`\`\`markdown\n${runOn}\n\`\`\``;
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    it('never demotes a run-on heading inside a [CANVAS] region (byte-identical)', () => {
      const runOn = headingLine(400);
      const input = `Intro\n\n[CANVAS:type=document,title=Plan]\n${runOn}\n[/CANVAS]`;
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    it('is idempotent on the reproduction input', () => {
      const once = normalizeMarkdownForRender(`${SEC1}\n\n${SEC2}`);
      expect(normalizeMarkdownForRender(once)).toBe(once);
    });

    it('F1: strips stacked ATX markers in ONE pass ("## ## " + run-on body)', () => {
      // The single-strip demotion peeled only the outer marker per pass, so
      // normalize(normalize(x)) !== normalize(x) and the backend persisted a
      // still-giant heading. The looping strip removes both markers at once.
      const input = `## ## ${'a'.repeat(200)}`;
      const expected = 'a'.repeat(200);
      expect(normalizeMarkdownForRender(input)).toBe(expected);
      const once = normalizeMarkdownForRender(input);
      expect(normalizeMarkdownForRender(once)).toBe(once);
    });

    it('F2: a demoted run-on followed by "===" cannot form a setext H1', () => {
      // ATX headings are leaf blocks (never setext-underlined); the demoted
      // line is a paragraph and CAN be — without the blank, CommonMark would
      // render the whole 200-char blob as a giant H1.
      const input = `## ${'a'.repeat(200)}\n===`;
      expect(normalizeMarkdownForRender(input)).toBe(`${'a'.repeat(200)}\n\n===`);
    });

    it('F2/M1: a genuine setext H1 ("My Title\\n===") stays byte-identical', () => {
      // No demotion happened, so no blank is manufactured — the M1 contract
      // (never blank-separate legitimate setext) still holds.
      const input = 'My Title\n===';
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    it('F2 sanity: a demoted run-on followed by "---" still uses the HR path', () => {
      const input = `## ${'a'.repeat(200)}\n---`;
      expect(normalizeMarkdownForRender(input)).toBe(`${'a'.repeat(200)}\n\n---`);
    });
  });

  describe('c8664ff9 follow-ups (blockquote run-ons, closing ##, re-demote after split, fence interplay)', () => {
    it('demotes a run-on heading inside a blockquote, keeping the quote prefix', () => {
      const input = `> ## ${'q'.repeat(200)}`;
      const expected = `> ${'q'.repeat(200)}`;
      expect(normalizeMarkdownForRender(input)).toBe(expected);
      expect(normalizeMarkdownForRender(expected)).toBe(expected); // idempotent
    });

    it('demotes a multi-level blockquote run-on (>> ### …)', () => {
      const input = `>> ### ${'q'.repeat(200)}`;
      expect(normalizeMarkdownForRender(input)).toBe(`>> ${'q'.repeat(200)}`);
    });

    it('leaves a SHORT blockquote heading untouched', () => {
      const input = 'Intro.\n\n> ## Quoted heading\n\nMore.';
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    it('strips an ATX closing sequence when demoting (CommonMark would have stripped it from a heading)', () => {
      const input = `## ${'c'.repeat(200)} ##`;
      expect(normalizeMarkdownForRender(input)).toBe('c'.repeat(200));
      const once = normalizeMarkdownForRender(input);
      expect(normalizeMarkdownForRender(once)).toBe(once); // idempotent
    });

    it('does NOT strip trailing #-text that is not a closing sequence (no space before the hashes stays, e.g. "C#")', () => {
      const input = `## ${'c'.repeat(180)} C#`;
      expect(normalizeMarkdownForRender(input)).toBe(`${'c'.repeat(180)} C#`);
    });

    it('re-demotes a run-on heading manufactured by a mid-line split', () => {
      // 'intro ## A<180> ## B' splits at the two markers; the '## A<180>' part
      // was not length-checked after the split and stayed a giant heading.
      const input = `intro ## ${'a'.repeat(180)} ## B`;
      expect(normalizeMarkdownForRender(input)).toBe(`intro\n${'a'.repeat(180)}\n\n## B`);
      const once = normalizeMarkdownForRender(input);
      expect(normalizeMarkdownForRender(once)).toBe(once); // idempotent
    });

    it('a fence boundary disarms prevDemoted — no spurious blank before a later "==="', () => {
      // Demotion immediately before a fence kept the flag armed THROUGH the
      // block, so the trailing '===' got a blank line it should not have.
      const input = `## ${'a'.repeat(200)}\n\`\`\`js\ncode\n\`\`\`\n===`;
      const expected = `${'a'.repeat(200)}\n\n\`\`\`js\ncode\n\`\`\`\n===`;
      expect(normalizeMarkdownForRender(input)).toBe(expected);
    });

    it('still blank-separates "===" DIRECTLY after a demotion (F2 contract intact)', () => {
      const input = `## ${'a'.repeat(200)}\n===`;
      expect(normalizeMarkdownForRender(input)).toBe(`${'a'.repeat(200)}\n\n===`);
    });

    it('a demotion that exposes a fence opener is TRACKED — the code body is not split/blanked', () => {
      // '## ```js <long>' demotes to a fence opener; without tracking, the
      // normalizer treats the body as prose and manufactures headings in what
      // the renderer treats as code (normalizer/renderer desync).
      const body = 'const a = 1 ## not split inside code ## really';
      const input = `## \`\`\`js ${'f'.repeat(200)}\n${body}\n\`\`\``;
      const expected = `\`\`\`js ${'f'.repeat(200)}\n${body}\n\`\`\``;
      expect(normalizeMarkdownForRender(input)).toBe(expected);
      const once = normalizeMarkdownForRender(input);
      expect(normalizeMarkdownForRender(once)).toBe(once); // idempotent
    });

    it('a split part that demotes to a fence opener tracks the REST of the collapsed line as code', () => {
      // Tilde fence: splitCollapsedHeadings never splits lines containing
      // BACKTICKS (inline-code guard), so the part-level fence exposure is
      // only reachable via ~ fences.
      const rest = 'more code ## with markers ## here';
      const input = `intro ## ~~~js ${'g'.repeat(200)} ## skipped ## parts\n${rest}`;
      const expected = `intro\n\n~~~js ${'g'.repeat(200)}\n## skipped\n## parts\n${rest}`;
      expect(normalizeMarkdownForRender(input)).toBe(expected);
      const once = normalizeMarkdownForRender(input);
      expect(normalizeMarkdownForRender(once)).toBe(once); // idempotent
    });

    it('demotes a single-line NO-SPACE blockquote run-on (">## …") — the fast path must not skip it (reviewer N2)', () => {
      const input = `>## ${'q'.repeat(200)}`;
      expect(normalizeMarkdownForRender(input)).toBe(`>${'q'.repeat(200)}`);
      const once = normalizeMarkdownForRender(input);
      expect(normalizeMarkdownForRender(once)).toBe(once); // idempotent
    });
  });

  describe('blockquote-prefixed fences (65a0b4d5)', () => {
    // The renderer opens fences inside blockquotes ('> ```js', '>> ~~~'),
    // but the old FENCE_RE only recognized column-0 fences — so fence content
    // lines containing ' ## ' were split into manufactured H2 headings while
    // the renderer treated them as code (normalizer/renderer desync).

    it('regression 1: demotion exposing a blockquote fence opener tracks the body as code', () => {
      const input = `> ## \`\`\`js ${'f'.repeat(200)}\nconst a = 1 ## x ## y\nrest`;
      const out = normalizeMarkdownForRender(input);
      // The run-on '> ## …' demotes to '> ```js …' — a blockquote fence
      // opener — so the remaining lines are fence content, never split.
      expect(out).toBe(`> \`\`\`js ${'f'.repeat(200)}\nconst a = 1 ## x ## y\nrest`);
      expect(out).toContain(`> \`\`\`js ${'f'.repeat(200)}`); // fence opener survives
      expect(out).toContain('rest'); // trailing text preserved
      expect(out).not.toMatch(/(^|\n)## /); // no manufactured '## x'/'## y' headings
      expect(normalizeMarkdownForRender(out)).toBe(out); // idempotent
    });

    it('regression 2: a split part exposing a blockquote TILDE fence tracks the rest as code', () => {
      const input = `intro ## > ~~~js ${'f'.repeat(200)} ## a ## b\ncode ## x ## y`;
      const out = normalizeMarkdownForRender(input);
      // The mid-line split + re-demote (c8664ff9 follow-up 4, unchanged by
      // this fix) emits 'intro' + the demoted fence opener + the remainder
      // parts verbatim; the NEXT line is now tracked as fence content and is
      // NOT split into '## x'/'## y' headings (the ticket's desync).
      expect(out).toBe(`intro\n\n> ~~~js ${'f'.repeat(200)}\n## a\n## b\ncode ## x ## y`);
      expect(out).toContain(`> ~~~js ${'f'.repeat(200)}`); // fence opener survives
      expect(out).not.toContain('\n## x');
      expect(out).not.toContain('\n## y');
      expect(normalizeMarkdownForRender(out)).toBe(out); // idempotent
    });

    it('regression 3: a REAL blockquote fence already in the source is tracked', () => {
      const input = '> ```js\nconst a = 1 ## x ## y\n> ```\nafter';
      // The content line is NEVER split (the ticket's manufactured H2s), and
      // the only edit is the standard fence-separation blank before the
      // second bq opener (origin/main idiom; renderer-harmless).
      const out = '> ```js\nconst a = 1 ## x ## y\n\n> ```\nafter';
      expect(normalizeMarkdownForRender(input)).toBe(out);
      expect(out).toContain('> ```js'); // fence opener survives
      expect(out).toContain('\nafter'); // text after the fence preserved
      expect(out).not.toMatch(/(^|\n)## /); // no manufactured headings
      expect(normalizeMarkdownForRender(out)).toBe(out); // idempotent
    });

    it('positive control: an all-prefixed blockquote fence keeps its content intact', () => {
      const input = '> ```js\n> code ## not-a-heading\n> ```';
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    it('positive control: an unprefixed fence line after a blockquote fence opens a NEW column-0 fence', () => {
      // micromark does not lazy-continue fences inside blockquotes: the bq
      // fence ends at 'code ## x ## y' (split suppressed there — safe), and
      // the unprefixed ``` opens a fresh column-0 fence, so 'after' is code
      // content to BOTH sides. The blank before the new opener is the
      // standard fence-separation rule (same as origin/main; renderer-harmless).
      const input = '> ```js\ncode ## x ## y\n```\nafter';
      const out = '> ```js\ncode ## x ## y\n\n```\nafter';
      expect(normalizeMarkdownForRender(input)).toBe(out);
      expect(normalizeMarkdownForRender(out)).toBe(out); // idempotent
    });

    it('review B1: setext --- protection still fires in the blockquote-fence window', () => {
      // The renderer ends the bq fence at 'foo', so 'foo\n---' is a live
      // setext H2 unless the normalizer blank-separates it (its first job).
      expect(normalizeMarkdownForRender('> ```js\nfoo\n---\nbar')).toBe(
        '> ```js\nfoo\n\n---\nbar',
      );
      // At-EOF variant.
      expect(normalizeMarkdownForRender('> ```js\ncode line\n---')).toBe(
        '> ```js\ncode line\n\n---',
      );
      // Tilde opener + closed-fence variants.
      expect(normalizeMarkdownForRender('> ~~~js\nfoo\n---\nbar')).toBe(
        '> ~~~js\nfoo\n\n---\nbar',
      );
      expect(normalizeMarkdownForRender('> ```js\nfoo\n---\n> ```\nbar')).toBe(
        '> ```js\nfoo\n\n---\n\n> ```\nbar', // + standard blank before the new opener
      );
    });

    it('review B2: run-on-heading demotion still fires in the blockquote-fence window', () => {
      const input = '> ```js\nfoo\n## ' + 'h'.repeat(200);
      // The renderer ends the bq fence at 'foo' — the 200-char ATX line is a
      // real run-on heading to it, so demotion must strip the marker (the
      // 814809bf all-bold symptom otherwise survives).
      expect(normalizeMarkdownForRender(input)).toBe('> ```js\nfoo\n' + 'h'.repeat(200));
    });

    it('review B3: an unprefixed fence line is NOT a closer — code content stays intact', () => {
      // Variant A: the renderer opens a NEW column-0 fence at the unprefixed
      // ```, so 'b ## x ## y' is code content — never split, no blank lines
      // injected INTO the code. (The blank before the opener is the standard
      // fence-separation rule — exactly origin/main's output for this input.)
      expect(normalizeMarkdownForRender('> ```js\na\n```\nb ## x ## y')).toBe(
        '> ```js\na\n\n```\nb ## x ## y',
      );
      // Variant B: a heading-looking line after the new opener stays literal
      // code content (demotion must not strip markers inside real code).
      expect(normalizeMarkdownForRender('> ```js\na\n```\n## ' + 'h'.repeat(200))).toBe(
        '> ```js\na\n\n```\n## ' + 'h'.repeat(200),
      );
    });

    it('positive control: a plain fence is NOT closed by a "> ```" line (prefix family)', () => {
      // The closer may never carry MORE blockquote nesting than the opener —
      // '> ```' inside a column-0 fence is code content (micromark agrees).
      const input = '```js\ncode ## x ## y\n> ```\nafter';
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    it('positive control: a deeper-prefixed line is not a closer (toggle asymmetry)', () => {
      // '>> ```' inside a '> ```' fence is nested-quote code content, not a
      // closer — the fence stays open to end-of-input like the renderer's.
      const input = '> ```\n>> ```\nrest';
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    it('positive control: a nested blockquote fence (>> ```js) opens and closes', () => {
      const input = '>> ```js\n>> code ## not a heading\n>> ```\nafter';
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    it('positive control: blockquote lines without fences are unaffected', () => {
      const input = '> not a fence\n> still quoted prose';
      expect(normalizeMarkdownForRender(input)).toBe(input);
    });

    // ── Adversarial review F1 (round 2): window idempotency ───────────────
    // Pass 1 blank-separates HR/table/list/setext INSIDE the window (B1 —
    // the renderer needs it). The window must SURVIVE those self-inserted
    // blanks, or pass 2 exits at them and re-splits protected lines into the
    // very H2s the window exists to suppress (this port re-normalizes
    // persisted pass-1 text at render time).
    describe('review F1: the window survives its own inserted blanks', () => {
      const f1Cases: Array<[string, string, string]> = [
        // [name, input, pinned pass-1 output]
        ['HR dashes', '> ```js\nfoo\n---\ntail ## x ## y', '> ```js\nfoo\n\n---\ntail ## x ## y'],
        ['HR stars', '> ```js\nfoo\n***\ntail ## x ## y', '> ```js\nfoo\n\n***\ntail ## x ## y'],
        [
          'table',
          '> ```js\nfoo\n| a | b |\n| - | - |\ntail ## x ## y',
          '> ```js\nfoo\n\n| a | b |\n| - | - |\ntail ## x ## y',
        ],
        ['list', '> ```js\nfoo\n- a\ntail ## x ## y', '> ```js\nfoo\n\n- a\ntail ## x ## y'],
        [
          'demote + ===',
          `> \`\`\`js\n## ${'h'.repeat(200)}\n===\ntail ## x ## y`,
          `> \`\`\`js\n${'h'.repeat(200)}\n\n===\ntail ## x ## y`,
        ],
        [
          'multi-line window',
          '> ```js\na\nb\n---\ntail ## x ## y',
          '> ```js\na\nb\n\n---\ntail ## x ## y',
        ],
      ];
      for (const [name, input, expected] of f1Cases) {
        it(`${name}: the protected line stays intact through 3 passes`, () => {
          const p1 = normalizeMarkdownForRender(input);
          expect(p1).toBe(expected); // blank inserted before structure; tail NOT split
          expect(p1).toContain('tail ## x ## y'); // no manufactured H2s
          expect(normalizeMarkdownForRender(p1)).toBe(p1); // pass 2 fixpoint
          expect(normalizeMarkdownForRender(normalizeMarkdownForRender(p1))).toBe(p1);
        });
      }

      it('control: a REAL blank before plain prose still ends the window', () => {
        // The blank before 'plain ## x ## y' cannot be self-inserted (no
        // blank-separated structure follows it), so the core collapsed-heading
        // repair must still apply there.
        const p1 = normalizeMarkdownForRender('> ```js\nfoo\n\nplain ## x ## y');
        expect(p1).not.toContain('plain ## x ## y'); // split DID happen
        expect(p1).toMatch(/(^|\n)## x/);
        expect(normalizeMarkdownForRender(p1)).toBe(p1); // and is stable
      });

      it('control: an ATX heading inside the window is still NOT blank-separated', () => {
        // Renders identically with or without the blank; inserting it would
        // drift later passes. Locked so the F1 survive-list cannot regress it.
        const input = '> ```js\nfoo\n## Real Heading';
        expect(normalizeMarkdownForRender(input)).toBe(input);
      });
    });
  });

  // ── Snapshot: the real degraded shapes seen in production transcripts ──────
  it('snapshot: degraded long-conversation answer', () => {
    const degraded =
      'Perfect — here it is: ## Meal Plan (2 nights) ## Grocery List\n**Cooler:**\n- 1 lb ground beef\n- butter\n**Dry bin:**\n- foil\n- bread';
    expect(normalizeMarkdownForRender(degraded)).toMatchSnapshot();
  });
});

describe('collapsed-table repair (feedback fdd85bb3)', () => {
  // Mirrors backend/src/modules/crossmodel/markdown-normalize.test.ts — keep in sync.
  const INCIDENT =
    '**Critic lane wake — Phase-6 merge hit CI failure, lane is actively debugging** ' +
    'Item Status Detail |---|---|--- Critic lane `596102ca` 🔴 CI FAIL ' +
    'Both Python jobs failed on Phase-6 merge — lane rebasing';

  it('splits the collapsed table at the delimiter and drops the pipe noise', () => {
    const out = normalizeMarkdownForRender(INCIDENT);
    expect(out).not.toContain('|---|');
    expect(out).toBe(
      '**Critic lane wake — Phase-6 merge hit CI failure, lane is actively debugging** Item Status Detail\n\n' +
        'Critic lane `596102ca` 🔴 CI FAIL Both Python jobs failed on Phase-6 merge — lane rebasing',
    );
    expect(normalizeMarkdownForRender(out)).toBe(out); // fixpoint
  });

  it('handles multiple collapsed tables on one line', () => {
    expect(normalizeMarkdownForRender('alpha |---|---| beta |---|---|---| gamma')).toBe('alpha\n\nbeta\n\ngamma');
  });

  it('never touches a well-formed multi-line table', () => {
    const input = 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\noutro';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never splits a delimiter inside inline code', () => {
    const input = 'use `a|---|b|---|c` literally';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('repairs the delimiter even when the line carries backticked ids (the incident class)', () => {
    expect(normalizeMarkdownForRender('lane `a1f994c7` status |---|---|--- flowing cells')).toBe(
      'lane `a1f994c7` status\n\nflowing cells',
    );
  });

  it('leaves single-cell pipe prose alone (≥2 delimiter cells required)', () => {
    const input = 'the range a |---| b stays prose';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never splits a leading-whitespace line (indented code)', () => {
    const input = 'para\n\n    indented |---|---|---| code';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never touches a delimiter inside a fenced code block', () => {
    const input = 'text\n\n```\nascii |---|---|---| diagram\n```';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('B1 (review): never deletes the delimiter row of a BLOCKQUOTED real table', () => {
    const input = '> | a | b |\n> |---|---|\n> | 1 | 2 |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('N4 (review): never splits blockquoted prose — the tail would escape the quote', () => {
    const input = '> quote says a |---|---|---| b';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('N2 (review): compound line still recovers headings AND drops the delimiter', () => {
    expect(normalizeMarkdownForRender('intro ## H |---|---|---| cells ## J')).toBe('intro\n\n## H\n\ncells\n\n## J');
  });

  it('N1 (review): a table-split piece that opens a fence is fence-tracked', () => {
    const input = 'x |---|---|---| ```js\ncode body\n```';
    expect(normalizeMarkdownForRender(input)).toBe('x\n\n```js\ncode body\n```');
  });
});

describe('collapsed-structure repairs round 2 (feedback 44204e09)', () => {
  it('rebuilds a delimiter-less collapsed table: glued header + inline-joined rows (incident replay, msg 48c3b148)', () => {
    const input = [
      '**Wake — 10:55 AM PDT (17:55Z): verify-herd dispatched.** | Item | Fresh state | Action |',
      '',
      '| Nightly (b92ef13f) | Digest received | ✅ complete | | C0 session (4f918389) | PR #491 MERGED | ✅ closed | | C1 Session UI (79464b3d) | RUNNING | ✅ live |',
    ].join('\n');
    expect(normalizeMarkdownForRender(input)).toBe(
      [
        '**Wake — 10:55 AM PDT (17:55Z): verify-herd dispatched.**',
        '',
        '| Item | Fresh state | Action |',
        '|---|---|---|',
        '| Nightly (b92ef13f) | Digest received | ✅ complete |',
        '| C0 session (4f918389) | PR #491 MERGED | ✅ closed |',
        '| C1 Session UI (79464b3d) | RUNNING | ✅ live |',
      ].join('\n'),
    );
  });

  it('splits inline-joined rows even without a header (faithful re-line, no manufactured structure)', () => {
    const input = 'intro\n| a | b | | c | d | | e | f |';
    expect(normalizeMarkdownForRender(input)).toBe('intro\n\n| a | b |\n| c | d |\n| e | f |');
  });

  it('re-lines flattened bold-led bullets into a real list (incident replay)', () => {
    const input =
      '**Dispatches this wake (evidence):** - **6bf8ce36** platform fix dispatched → session **1ca12570** - **Nightly acknowledged** → message **c3607ab6** to b92ef13f';
    expect(normalizeMarkdownForRender(input)).toBe(
      [
        '**Dispatches this wake (evidence):**',
        '',
        '- **6bf8ce36** platform fix dispatched → session **1ca12570**',
        '- **Nightly acknowledged** → message **c3607ab6** to b92ef13f',
      ].join('\n'),
    );
  });

  it('re-lines flattened numbered items as blank-separated paragraphs — no manufactured list syntax (incident replay, msg 947b6ce4)', () => {
    const input =
      '**Owner — two items:** 1 **2d4ff22f** still holding 4550ee11 — re-dispatch? 2 **louse rig** burning ~$21/hr — release or reassign?';
    expect(normalizeMarkdownForRender(input)).toBe(
      [
        '**Owner — two items:**',
        '',
        '1 **2d4ff22f** still holding 4550ee11 — re-dispatch?',
        '',
        '2 **louse rig** burning ~$21/hr — release or reassign?',
      ].join('\n'),
    );
  });

  it('does not split plain prose dashes (ages 3 - 4 — no bold-led markers)', () => {
    const input = 'ages 3 - 4 and scores 5 - 6 are prose';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('does not split bold-led numbers without a colon intro', () => {
    const input = 'Summary line.\n\nThe 2 **models** and 3 **lanes** agree on this.';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('leaves a real table row with an empty cell untouched (single join signature)', () => {
    const input = '| a | | b |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('fails safe on ragged inline rows (inconsistent cell counts → no repair)', () => {
    const input = '| a | b | | c | | d | e | f |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('still drops a glued DELIMITER via the fdd85bb3 repair (dash-cell pipe-run is not a header)', () => {
    const input = 'intro text |---|---|---|';
    expect(normalizeMarkdownForRender(input)).toBe('intro text');
  });

  it('never splits a pipe-run inside an open bold span', () => {
    const input = '**bold text | a | b |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never repairs inside a blockquote (BQ_LINE_PREFIX guard)', () => {
    const input = '> **Items:** 1 **a** first 2 **b** second';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never repairs inside a fenced code block', () => {
    const input = '```\n| a | b | | c | d | | e | f |\n```';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('is idempotent across the round-2 repairs', () => {
    const input = [
      '**Wake — 10:55 AM PDT (17:55Z): verify-herd dispatched.** | Item | Fresh state | Action |',
      '',
      '| Nightly (b92ef13f) | Digest received | ✅ complete | | C0 session (4f918389) | PR #491 MERGED | ✅ closed | | C1 Session UI (79464b3d) | RUNNING | ✅ live |',
      '',
      '**Owner — two items:** 1 **2d4ff22f** still holding — re-dispatch? 2 **louse rig** burning ~$21/hr — release?',
    ].join('\n');
    const once = normalizeMarkdownForRender(input);
    expect(normalizeMarkdownForRender(once)).toBe(once);
  });

  it('F1 (review): synthesizes a delimiter with the TRUE GFM cell count (empty interior header cell)', () => {
    // The filtered-non-empty count manufactured a 2-cell delimiter for a
    // 3-cell header — GFM-invalid, rendered worse than the un-repaired text.
    const input = 'prose intro | a | | b |';
    expect(normalizeMarkdownForRender(input)).toBe('prose intro\n\n| a | | b |\n|---|---|---|');
  });

  it('F1 (review): a pipe-run with ≥2 row joins is collapsed multi-row content, not a header — untouched', () => {
    const input = 'prose intro | a | b | | c | d | | e | f |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('F1 (review): one-line variants stay idempotent', () => {
    for (const input of [
      'prose intro | a | | b |',
      'prose intro | a | b | | c | d | | e | f |',
      'prose intro | a | b |',
    ]) {
      const once = normalizeMarkdownForRender(input);
      expect(normalizeMarkdownForRender(once)).toBe(once);
    }
  });

  it('B1 (review): never list-splits plain-colon prose with bold-led numbers', () => {
    // The intro colon must be BOLD-ADJACENT ('…:**'); 'Lanes: 2 **x** and 1
    // **y**' is ordinary prose — the ':\*{0,2}' intro chopped it mid-clause.
    const input = 'Status line.\n\nLanes: 2 **healthy** and 1 **degraded**';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });
});

describe('collapsed-structure repairs round 3 (feedback 7b7480fc)', () => {
  it('reflows a one-line table that includes its delimiter row (incident signature, ticket proposal 1)', () => {
    const input =
      '| Lane | Status | Detail | |---|---|---| | GLM-5.3 HW Benchmarking (c9ccf88a) | ⚠️ Steered | Run completed, but owner sent a steer | | Kernel | ✅ Done | P1 negative closure pushed |';
    expect(normalizeMarkdownForRender(input)).toBe(
      [
        '| Lane | Status | Detail |',
        '|---|---|---|',
        '| GLM-5.3 HW Benchmarking (c9ccf88a) | ⚠️ Steered | Run completed, but owner sent a steer |',
        '| Kernel | ✅ Done | P1 negative closure pushed |',
      ].join('\n'),
    );
  });

  it('reflows a prose-glued header + inline delimiter + joined rows (mixed signature)', () => {
    const input = '**Wake note — x** | Item | Status | |---|---| | a | b | | c | d |';
    expect(normalizeMarkdownForRender(input)).toBe(
      ['**Wake note — x**', '', '| Item | Status |', '|---|---|', '| a | b |', '| c | d |'].join(
        '\n',
      ),
    );
  });

  it('reflows a single-data-row one-line table', () => {
    const input = '| H1 | H2 | |---|---| | a | b |';
    expect(normalizeMarkdownForRender(input)).toBe('| H1 | H2 |\n|---|---|\n| a | b |');
  });

  it('keeps alignment colons and normalizes a missing trailing delimiter pipe', () => {
    const input = '| H1 | H2 | |:---|---: | a | b |';
    expect(normalizeMarkdownForRender(input)).toBe('| H1 | H2 |\n|:---|---:|\n| a | b |');
  });

  it('reflows a one-line table mid-message and blank-separates it from the prose', () => {
    const input = '**Wake — x** intro line\n| Lane | Status | |---|---| | a | b |\ntrailing prose';
    expect(normalizeMarkdownForRender(input)).toBe(
      [
        '**Wake — x** intro line',
        '',
        '| Lane | Status |',
        '|---|---|',
        '| a | b |',
        'trailing prose',
      ].join('\n'),
    );
  });

  it('fails safe on ragged rows (a data row with a different cell count → untouched)', () => {
    const input = '| H | H | H | |---|---|---| | a | b | | c | d | e |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('fails safe when the header cell count differs from the delimiter count', () => {
    const input = '| H | H | |---|---|---| | a | b | c |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('fails safe on two tables glued on one line (delimiter fragment inside the tail)', () => {
    const input = '| H | H | |---|---| | a | b | |---|---|';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never reflows a blockquoted one-line table (BQ_LINE_PREFIX guard)', () => {
    const input = '> | H | H | |---|---| | a | b |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never reflows inside a fenced code block', () => {
    const input = '```\n| H | H | |---|---| | a | b |\n```';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('still drops the delimiter for the fdd85bb3 class (header pipes dropped — no rebuild possible)', () => {
    const input = 'Lane Status Detail |---|---|---| cells flowing as prose here';
    expect(normalizeMarkdownForRender(input)).toBe('Lane Status Detail\n\ncells flowing as prose here');
  });

  it('R2 (review): rebuilds a table with an empty interior cell when GFM counts agree', () => {
    // '| a | | b |' is THREE GFM cells (empty interior) — a 3-cell delimiter
    // and 3-cell rows make a valid table; the empty cell survives the reflow.
    const input = '| a | | b | |---|---|---| | c | | d |';
    expect(normalizeMarkdownForRender(input)).toBe('| a | | b |\n|---|---|---|\n| c | | d |');
  });

  it('R2 (review): fails safe when the non-empty count hides a GFM mismatch (empty interior header cell, 2-cell delimiter)', () => {
    // Header has 3 GFM cells but only 2 non-empty — the old count would pair
    // it with a 2-cell delimiter and EMIT a table GFM rejects. Untouched now.
    const input = '| a | | b | |---|---| | c | d |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('re-lines a flattened bold-label dash list with a plain-colon intro (incident replay, msg 4eed309e)', () => {
    const input =
      '**Wake note — 3:02 PM PDT (22:02Z)** — spark 12/12 complete, on standing-serve + fleet watch: - **Spark 28de72e5 (event):** plan **12/12 complete** — all deferred legs done - **Kernel b95e9df6:** running, plan 1/6 - **Bench c9ccf88a:** running, plan 1/5';
    expect(normalizeMarkdownForRender(input)).toBe(
      [
        '**Wake note — 3:02 PM PDT (22:02Z)** — spark 12/12 complete, on standing-serve + fleet watch:',
        '',
        '- **Spark 28de72e5 (event):** plan **12/12 complete** — all deferred legs done',
        '- **Kernel b95e9df6:** running, plan 1/6',
        '- **Bench c9ccf88a:** running, plan 1/5',
      ].join('\n'),
    );
  });

  it('re-lines a flattened bold-label dash list with NO colon intro (incident replay, msg a63a96f8)', () => {
    const input =
      'Re-running the full verify chain myself (no faith) `verify_site` - **Kernel b95e9df6:** running, plan 1/6 — closure in progress - **Bench c9ccf88a:** running, plan 1/5';
    expect(normalizeMarkdownForRender(input)).toBe(
      [
        'Re-running the full verify chain myself (no faith) `verify_site`',
        '',
        '- **Kernel b95e9df6:** running, plan 1/6 — closure in progress',
        '- **Bench c9ccf88a:** running, plan 1/5',
      ].join('\n'),
    );
  });

  it('splits one glued sibling off a line that already starts as a list item', () => {
    const input = '- **Spark:** done - **Kernel:** running';
    expect(normalizeMarkdownForRender(input)).toBe('- **Spark:** done\n- **Kernel:** running');
  });

  it('leaves a lone bold-label dash mark on a prose line untouched (≥2 required)', () => {
    const input = 'Status: - **Bench:** running well today.';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('leaves dash-led bold spans without label colons untouched', () => {
    const input = 'range 5 - **6** items - **7** total';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never cuts a label mark inside inline code', () => {
    const input = '`code - **x:** y` tail - **z:** w';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('never cuts a label mark inside an open bold span', () => {
    const input = '**intro - **A:** one - **B:** two';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('is idempotent across the round-3 repairs', () => {
    const input = [
      '**Wake note — 3:02 PM PDT (22:02Z)** — spark 12/12 complete: - **Spark 28de72e5 (event):** done - **Kernel b95e9df6:** running',
      '',
      '| Lane | Status | |---|---| | a | b | | c | d |',
    ].join('\n');
    const once = normalizeMarkdownForRender(input);
    expect(normalizeMarkdownForRender(once)).toBe(once);
  });
});

describe('detached-table-body repair (ticket 942db7aa) — backend parity', () => {
  // INCIDENT REPLAY (ticket 942db7aa, 2026-10-15 22:58Z, Fleet Supervisor chat
  // c0e22e36): joined table body behind a blank + prose tail glued after the
  // last row. Mirrors backend/src/modules/crossmodel/markdown-normalize.test.ts.
  it('repairs the 942db7aa incident: joined body behind a blank, prose tail glued after the last row', () => {
    const input = [
      '**What is closed vs. what actually still needs you:**',
      '',
      '| Item | State |',
      '|---|---|',
      '',
      '| CQL Cloudflare token | ✅ Resolved — present in Coding secrets all along nothing to do | | Tailscale tagOwners paste | Still open — surfaces 4:58 PM PDT (23:58Z) one ACL paste for the three new boxes | | LiteLLM provider-key re-mint | Still open — surfaces 5:24 PM PDT (00:24Z) 34 legs dark | | Schooltime recovery-email pick | Still open — mail provider decision | I\'ve corrected the fleet record and updated the credential ticket to reflect your call — the mishap is now framed as the probe misread, not a missing secret',
    ].join('\n');
    expect(normalizeMarkdownForRender(input)).toBe(
      [
        '**What is closed vs. what actually still needs you:**',
        '',
        '| Item | State |',
        '|---|---|',
        '| CQL Cloudflare token | ✅ Resolved — present in Coding secrets all along nothing to do |',
        '| Tailscale tagOwners paste | Still open — surfaces 4:58 PM PDT (23:58Z) one ACL paste for the three new boxes |',
        '| LiteLLM provider-key re-mint | Still open — surfaces 5:24 PM PDT (00:24Z) 34 legs dark |',
        '| Schooltime recovery-email pick | Still open — mail provider decision |',
        '',
        "I've corrected the fleet record and updated the credential ticket to reflect your call — the mishap is now framed as the probe misread, not a missing secret",
      ].join('\n'),
    );
  });

  it('reattaches a single joined two-row body with one join (the ≥2 gate miss)', () => {
    const input = '| A | B |\n|---|---|\n\n| one | two | | three | four |';
    expect(normalizeMarkdownForRender(input)).toBe(
      ['| A | B |', '|---|---|', '| one | two |', '| three | four |'].join('\n'),
    );
  });

  it('does not treat a NEW table header after a blank as a detached body (join-tell disambiguator)', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D |\n|---|---|\n| 3 | 4 |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('does not fire without the delimiter anchor (pipe prose after unrelated prose)', () => {
    const input = 'Some intro line.\n\n| a | b | | c | d |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('is idempotent on the repaired output', () => {
    const input = '| Item | State |\n|---|---|\n\n| a | b | | c | d | | e | f | tail prose here';
    const once = normalizeMarkdownForRender(input);
    expect(normalizeMarkdownForRender(once)).toBe(once);
  });
});

describe('ticket 90308cf4 — glued header with the model\'s OWN delimiter row next line', () => {
  it('keeps the model\'s own delimiter instead of synthesizing a second one (no junk dashes row)', () => {
    // The incident shape: prose + header glued on one line, the model emitted
    // its own delimiter row on the NEXT line. The old repair synthesized a
    // SECOND delimiter ('|---|---|' twice) — the all-dashes junk row the
    // owner saw on the phone between header and data.
    const input = 'Some prose before the table | A | B |\n|---|---|\n| 1 | 2 |';
    expect(normalizeMarkdownForRender(input)).toBe(
      'Some prose before the table\n\n| A | B |\n|---|---|\n| 1 | 2 |',
    );
  });

  it('bold-intro fleet-note shape (the wake-note idiom) keeps its own delimiter', () => {
    const input =
      "**Fleet wake — 1:07 AM PDT: summary line.** | Project | What moved | What's next |\n|---|---|---|\n| Schooltime | decrypt broke | ETA shorter |";
    expect(normalizeMarkdownForRender(input)).toBe(
      "**Fleet wake — 1:07 AM PDT: summary line.**\n\n| Project | What moved | What's next |\n|---|---|---|\n| Schooltime | decrypt broke | ETA shorter |",
    );
  });

  it('still synthesizes a delimiter when NONE follows (glued header, no next-line delimiter)', () => {
    const input = 'prose intro | a | b |';
    expect(normalizeMarkdownForRender(input)).toBe('prose intro\n\n| a | b |\n|---|---|');
  });

  it('a next-line delimiter with a MISMATCHED cell count is not the model\'s delimiter — synthesize', () => {
    // 3-cell glued header, 2-cell next-line delimiter: keeping it would render
    // paragraph junk (GFM rejects the table), so the repair must fall back to
    // synthesizing the matching delimiter.
    const input = 'prose intro | a | b | c |\n|---|---|\n| 1 | 2 | 3 |';
    expect(normalizeMarkdownForRender(input)).toBe(
      'prose intro\n\n| a | b | c |\n|---|---|---|\n|---|---|\n| 1 | 2 | 3 |',
    );
  });

  it('a pipe-less next-line delimiter with matching cells is kept (GFM optional pipes)', () => {
    const input = 'prose intro | a | b |\n---|---\n| 1 | 2 |';
    expect(normalizeMarkdownForRender(input)).toBe(
      'prose intro\n\n| a | b |\n---|---\n| 1 | 2 |',
    );
  });

  it('is idempotent on the repaired output', () => {
    const input = 'Some prose before the table | A | B |\n|---|---|\n| 1 | 2 |';
    const once = normalizeMarkdownForRender(input);
    expect(normalizeMarkdownForRender(once)).toBe(once);
  });
});

describe('ticket 90308cf4 — non-pipe (optional-pipes) GFM tables are not torn apart', () => {
  it('body row after a non-pipe delimiter row stays attached (no manufactured blank)', () => {
    // 'A | B' / '---|---' / '| 1 | 2 |' is VALID GFM (optional pipes) and
    // remark-gfm renders it as paragraph + table WITHOUT any blank (verified
    // against remark-parse/remark-gfm directly). The old blank-separation pass
    // inserted a blank between the delimiter and the body, tearing the table
    // into paragraph junk; now the whole shape passes through unchanged.
    const input = 'Here is the table:\nA | B\n---|---\n| 1 | 2 |';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('a table in fully non-pipe form is left intact', () => {
    const input = 'Here is the table:\nA | B\n---|---\n1 | 2';
    expect(normalizeMarkdownForRender(input)).toBe(input);
  });

  it('thematic-break "---" never counts as a delimiter row (list text after --- is blank-separated)', () => {
    const input = 'Intro\n---\n- item one';
    expect(normalizeMarkdownForRender(input)).toBe('Intro\n\n---\n\n- item one');
  });

  it('"- | -" stays a list item (GFM precedence), never a delimiter', () => {
    const input = 'Intro:\n- | -';
    expect(normalizeMarkdownForRender(input)).toBe('Intro:\n\n- | -');
  });

  it('is idempotent on the repaired output', () => {
    const input = 'Here is the table:\nA | B\n---|---\n| 1 | 2 |';
    const once = normalizeMarkdownForRender(input);
    expect(normalizeMarkdownForRender(once)).toBe(once);
  });
});
