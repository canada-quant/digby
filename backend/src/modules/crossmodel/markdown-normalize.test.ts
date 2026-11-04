/**
 * Tests for markdown-normalize.ts — the persist-time repair for degraded
 * model output (feedback fc841f58 / 5393e948: long conversations lose the
 * blank lines markdown needs, so ## / ** / - render as raw characters).
 *
 * Mirrors frontend/lib/markdown-normalize.test.ts — keep the two in sync.
 */

import { normalizeAssistantMarkdown } from './markdown-normalize';

describe('normalizeAssistantMarkdown', () => {
  it('passes well-formed markdown through unchanged', () => {
    const good = 'Intro paragraph.\n\n## Section\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    expect(normalizeAssistantMarkdown(good)).toBe(good);
  });

  it('inserts a blank line before a heading that follows text (single-newline degrade)', () => {
    expect(normalizeAssistantMarkdown('Some intro\n## Heading\nBody')).toBe(
      'Some intro\n\n## Heading\nBody'
    );
  });

  it('inserts a blank line before a list that follows a lead-in line (grocery-list case)', () => {
    const input = '**Cooler:**\n- 1 lb ground beef\n- 1.5 lb baby potatoes';
    expect(normalizeAssistantMarkdown(input)).toBe(
      '**Cooler:**\n\n- 1 lb ground beef\n- 1.5 lb baby potatoes'
    );
  });

  it('keeps consecutive list items tight (no blanks inserted between them)', () => {
    const input = 'List:\n- a\n- b\n  - nested\n- c';
    expect(normalizeAssistantMarkdown(input)).toBe('List:\n\n- a\n- b\n  - nested\n- c');
  });

  it('handles ordered lists that do not start at 1 (CommonMark cannot interrupt with 2.)', () => {
    const input = 'Steps:\n1. first\n2. second';
    expect(normalizeAssistantMarkdown(input)).toBe('Steps:\n\n1. first\n2. second');
  });

  it('converts accidental setext ("text\\n---") into paragraph + thematic break', () => {
    // Without the blank line, CommonMark renders "Some text" as a giant H2 —
    // the "big bold ugly" half of the formatting complaints.
    expect(normalizeAssistantMarkdown('Some text\n---\nNext section')).toBe(
      'Some text\n\n---\nNext section'
    );
  });

  it('inserts a blank line before a GFM table that follows text', () => {
    const input = 'Here is the table:\n| Method | Time |\n|---|---|\n| Grill | 30 min |';
    expect(normalizeAssistantMarkdown(input)).toBe(
      'Here is the table:\n\n| Method | Time |\n|---|---|\n| Grill | 30 min |'
    );
  });

  it('repairs the fully-collapsed single-line answer (mid-line ## splits)', () => {
    const input = 'Here is the ruleset: ## Setup 1. First thing 2. Second thing ### Details More prose';
    expect(normalizeAssistantMarkdown(input)).toBe(
      'Here is the ruleset:\n\n## Setup 1. First thing 2. Second thing\n\n### Details More prose'
    );
  });

  it('never splits a mid-line ## inside inline code', () => {
    const input = 'Use `echo hi ## comment` to run it';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never touches fenced code block content', () => {
    const input = 'Code:\n```python\n# comment\ndef f():\n  return "## not a heading"\n```\nAfter';
    expect(normalizeAssistantMarkdown(input)).toBe(
      'Code:\n\n```python\n# comment\ndef f():\n  return "## not a heading"\n```\nAfter'
    );
  });

  it('separates a fence opening that directly follows text', () => {
    const input = 'Try this:\n```\nls -la\n```';
    expect(normalizeAssistantMarkdown(input)).toBe('Try this:\n\n```\nls -la\n```');
  });

  it('leaves [CANVAS] regions byte-identical while normalizing around them', () => {
    const canvas = '[CANVAS:type=document,title=Plan]\n# Doc title\nline without blanks\n- item\n[/CANVAS]';
    const input = `Intro\n## Chat section\n${canvas}\nTrailing\n- tail item`;
    expect(normalizeAssistantMarkdown(input)).toBe(
      `Intro\n\n## Chat section\n${canvas}\nTrailing\n\n- tail item`
    );
  });

  it('leaves [SEND_EMAIL] bodies byte-identical', () => {
    const email = '[SEND_EMAIL to="a@b.c" subject="Hi"]\nDear X\n- not a list, prose dash\n[/SEND_EMAIL]';
    const input = `Here is the draft:\n${email}`;
    expect(normalizeAssistantMarkdown(input)).toBe(`Here is the draft:\n${email}`);
  });

  it('protects an unterminated [CANVAS] open tag to end of string', () => {
    const input = 'Text\n## Real heading\n[CANVAS:type=code,title=x]\n# python comment\n- not a list';
    expect(normalizeAssistantMarkdown(input)).toBe(
      'Text\n\n## Real heading\n[CANVAS:type=code,title=x]\n# python comment\n- not a list'
    );
  });

  it('collapses 3+ consecutive newlines', () => {
    expect(normalizeAssistantMarkdown('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('is idempotent', () => {
    const messy =
      'Intro text ## Heading One\n**Lead:**\n- item one\n- item two\nSome text\n---\n| a | b |\n|---|---|\n```js\nconst x = 1 ## nope\n```\nMore';
    const once = normalizeAssistantMarkdown(messy);
    expect(normalizeAssistantMarkdown(once)).toBe(once);
  });

  it('handles empty and whitespace-only input', () => {
    expect(normalizeAssistantMarkdown('')).toBe('');
    expect(normalizeAssistantMarkdown('plain single line')).toBe('plain single line');
  });

  // ── Adversarial-review regressions (PR #286 review: B1 / M1 / M2) ─────────
  it('B1: nested fences — a 3-backtick line inside a 4-backtick block stays code', () => {
    const input = 'Example:\n````\n```python\n# setup\nx = 1\n```\n````\nDone';
    expect(normalizeAssistantMarkdown(input)).toBe(
      'Example:\n\n````\n```python\n# setup\nx = 1\n```\n````\nDone'
    );
  });

  it('M1: valid setext H1 ("Title\\n===") is preserved, not turned into literal junk', () => {
    const input = 'My Document Title\n=================\n\nBody';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('M2: a lone " # " in prose is not a heading ("team is # 1")', () => {
    const input = 'Our team is # 1 in the league this year';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('M2: a lone mid-line " ## " is left alone (conservative — ambiguous with prose)', () => {
    const input = 'Perfect — here is the plan: ## Meal Plan (2 nights)';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('M2: never splits inside a bold span', () => {
    const input = 'This is **really ## important** stuff';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('M2: never de-indents a 4-space indented code block into a heading', () => {
    const input = 'Intro\n\n    ## not a heading\n\nMore';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('handles CRLF line endings', () => {
    expect(normalizeAssistantMarkdown('a\r\n## b')).toBe('a\n\n## b');
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
      const out = normalizeAssistantMarkdown(input);
      expect(out).toBe(expected);
      expect(out).not.toContain('##');
    });

    it('keeps a heading line of exactly 160 chars and demotes one of 161 (boundary)', () => {
      const at160 = headingLine(160);
      const at161 = headingLine(161);
      expect(at160.length).toBe(160);
      expect(at161.length).toBe(161);
      expect(normalizeAssistantMarkdown(at160)).toBe(at160);
      expect(normalizeAssistantMarkdown(at161)).toBe(at161.replace(/^## /, ''));
    });

    it('leaves a normal short heading unchanged', () => {
      const input = 'Intro paragraph.\n\n## Question 1 — Overview\n\nBody text.';
      expect(normalizeAssistantMarkdown(input)).toBe(input);
      expect(normalizeAssistantMarkdown('## Question 1 — Overview')).toBe(
        '## Question 1 — Overview'
      );
    });

    it('never demotes a run-on heading inside a fenced code block (byte-identical)', () => {
      const runOn = headingLine(400);
      const input = `Code:\n\n\`\`\`markdown\n${runOn}\n\`\`\``;
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    it('never demotes a run-on heading inside a [CANVAS] region (byte-identical)', () => {
      const runOn = headingLine(400);
      const input = `Intro\n\n[CANVAS:type=document,title=Plan]\n${runOn}\n[/CANVAS]`;
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    it('is idempotent on the reproduction input', () => {
      const once = normalizeAssistantMarkdown(`${SEC1}\n\n${SEC2}`);
      expect(normalizeAssistantMarkdown(once)).toBe(once);
    });

    it('F1: strips stacked ATX markers in ONE pass ("## ## " + run-on body)', () => {
      // The single-strip demotion peeled only the outer marker per pass, so
      // normalize(normalize(x)) !== normalize(x) and the backend persisted a
      // still-giant heading. The looping strip removes both markers at once.
      const input = `## ## ${'a'.repeat(200)}`;
      const expected = 'a'.repeat(200);
      expect(normalizeAssistantMarkdown(input)).toBe(expected);
      const once = normalizeAssistantMarkdown(input);
      expect(normalizeAssistantMarkdown(once)).toBe(once);
    });

    it('F2: a demoted run-on followed by "===" cannot form a setext H1', () => {
      // ATX headings are leaf blocks (never setext-underlined); the demoted
      // line is a paragraph and CAN be — without the blank, CommonMark would
      // render the whole 200-char blob as a giant H1.
      const input = `## ${'a'.repeat(200)}\n===`;
      expect(normalizeAssistantMarkdown(input)).toBe(`${'a'.repeat(200)}\n\n===`);
    });

    it('F2/M1: a genuine setext H1 ("My Title\\n===") stays byte-identical', () => {
      // No demotion happened, so no blank is manufactured — the M1 contract
      // (never blank-separate legitimate setext) still holds.
      const input = 'My Title\n===';
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    it('F2 sanity: a demoted run-on followed by "---" still uses the HR path', () => {
      const input = `## ${'a'.repeat(200)}\n---`;
      expect(normalizeAssistantMarkdown(input)).toBe(`${'a'.repeat(200)}\n\n---`);
    });
  });

  describe('c8664ff9 follow-ups (blockquote run-ons, closing ##, re-demote after split, fence interplay)', () => {
    it('demotes a run-on heading inside a blockquote, keeping the quote prefix', () => {
      const input = `> ## ${'q'.repeat(200)}`;
      const expected = `> ${'q'.repeat(200)}`;
      expect(normalizeAssistantMarkdown(input)).toBe(expected);
      expect(normalizeAssistantMarkdown(expected)).toBe(expected); // idempotent
    });

    it('demotes a multi-level blockquote run-on (>> ### …)', () => {
      const input = `>> ### ${'q'.repeat(200)}`;
      expect(normalizeAssistantMarkdown(input)).toBe(`>> ${'q'.repeat(200)}`);
    });

    it('leaves a SHORT blockquote heading untouched', () => {
      const input = 'Intro.\n\n> ## Quoted heading\n\nMore.';
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    it('strips an ATX closing sequence when demoting (CommonMark would have stripped it from a heading)', () => {
      const input = `## ${'c'.repeat(200)} ##`;
      expect(normalizeAssistantMarkdown(input)).toBe('c'.repeat(200));
      const once = normalizeAssistantMarkdown(input);
      expect(normalizeAssistantMarkdown(once)).toBe(once); // idempotent
    });

    it('does NOT strip trailing #-text that is not a closing sequence (no space before the hashes stays, e.g. "C#")', () => {
      const input = `## ${'c'.repeat(180)} C#`;
      expect(normalizeAssistantMarkdown(input)).toBe(`${'c'.repeat(180)} C#`);
    });

    it('re-demotes a run-on heading manufactured by a mid-line split', () => {
      // 'intro ## A<180> ## B' splits at the two markers; the '## A<180>' part
      // was not length-checked after the split and stayed a giant heading.
      const input = `intro ## ${'a'.repeat(180)} ## B`;
      expect(normalizeAssistantMarkdown(input)).toBe(`intro\n${'a'.repeat(180)}\n\n## B`);
      const once = normalizeAssistantMarkdown(input);
      expect(normalizeAssistantMarkdown(once)).toBe(once); // idempotent
    });

    it('a fence boundary disarms prevDemoted — no spurious blank before a later "==="', () => {
      // Demotion immediately before a fence kept the flag armed THROUGH the
      // block, so the trailing '===' got a blank line it should not have.
      const input = `## ${'a'.repeat(200)}\n\`\`\`js\ncode\n\`\`\`\n===`;
      const expected = `${'a'.repeat(200)}\n\n\`\`\`js\ncode\n\`\`\`\n===`;
      expect(normalizeAssistantMarkdown(input)).toBe(expected);
    });

    it('still blank-separates "===" DIRECTLY after a demotion (F2 contract intact)', () => {
      const input = `## ${'a'.repeat(200)}\n===`;
      expect(normalizeAssistantMarkdown(input)).toBe(`${'a'.repeat(200)}\n\n===`);
    });

    it('a demotion that exposes a fence opener is TRACKED — the code body is not split/blanked', () => {
      // '## ```js <long>' demotes to a fence opener; without tracking, the
      // normalizer treats the body as prose and manufactures headings in what
      // the renderer treats as code (normalizer/renderer desync).
      const body = 'const a = 1 ## not split inside code ## really';
      const input = `## \`\`\`js ${'f'.repeat(200)}\n${body}\n\`\`\``;
      const expected = `\`\`\`js ${'f'.repeat(200)}\n${body}\n\`\`\``;
      expect(normalizeAssistantMarkdown(input)).toBe(expected);
      const once = normalizeAssistantMarkdown(input);
      expect(normalizeAssistantMarkdown(once)).toBe(once); // idempotent
    });

    it('a split part that demotes to a fence opener tracks the REST of the collapsed line as code', () => {
      // Tilde fence: splitCollapsedHeadings never splits lines containing
      // BACKTICKS (inline-code guard), so the part-level fence exposure is
      // only reachable via ~ fences.
      const rest = 'more code ## with markers ## here';
      const input = `intro ## ~~~js ${'g'.repeat(200)} ## skipped ## parts\n${rest}`;
      const expected = `intro\n\n~~~js ${'g'.repeat(200)}\n## skipped\n## parts\n${rest}`;
      expect(normalizeAssistantMarkdown(input)).toBe(expected);
      const once = normalizeAssistantMarkdown(input);
      expect(normalizeAssistantMarkdown(once)).toBe(once); // idempotent
    });

    it('demotes a single-line NO-SPACE blockquote run-on (">## …") — the fast path must not skip it (reviewer N2)', () => {
      const input = `>## ${'q'.repeat(200)}`;
      expect(normalizeAssistantMarkdown(input)).toBe(`>${'q'.repeat(200)}`);
      const once = normalizeAssistantMarkdown(input);
      expect(normalizeAssistantMarkdown(once)).toBe(once); // idempotent
    });
  });

  describe('blockquote-prefixed fences (65a0b4d5)', () => {
    // The renderer opens fences inside blockquotes ('> ```js', '>> ~~~'),
    // but the old FENCE_RE only recognized column-0 fences — so fence content
    // lines containing ' ## ' were split into manufactured H2 headings while
    // the renderer treated them as code (normalizer/renderer desync).

    it('regression 1: demotion exposing a blockquote fence opener tracks the body as code', () => {
      const input = `> ## \`\`\`js ${'f'.repeat(200)}\nconst a = 1 ## x ## y\nrest`;
      const out = normalizeAssistantMarkdown(input);
      // The run-on '> ## …' demotes to '> ```js …' — a blockquote fence
      // opener — so the remaining lines are fence content, never split.
      expect(out).toBe(`> \`\`\`js ${'f'.repeat(200)}\nconst a = 1 ## x ## y\nrest`);
      expect(out).toContain(`> \`\`\`js ${'f'.repeat(200)}`); // fence opener survives
      expect(out).toContain('rest'); // trailing text preserved
      expect(out).not.toMatch(/(^|\n)## /); // no manufactured '## x'/'## y' headings
      expect(normalizeAssistantMarkdown(out)).toBe(out); // idempotent
    });

    it('regression 2: a split part exposing a blockquote TILDE fence tracks the rest as code', () => {
      const input = `intro ## > ~~~js ${'f'.repeat(200)} ## a ## b\ncode ## x ## y`;
      const out = normalizeAssistantMarkdown(input);
      // The mid-line split + re-demote (c8664ff9 follow-up 4, unchanged by
      // this fix) emits 'intro' + the demoted fence opener + the remainder
      // parts verbatim; the NEXT line is now tracked as fence content and is
      // NOT split into '## x'/'## y' headings (the ticket's desync).
      expect(out).toBe(`intro\n\n> ~~~js ${'f'.repeat(200)}\n## a\n## b\ncode ## x ## y`);
      expect(out).toContain(`> ~~~js ${'f'.repeat(200)}`); // fence opener survives
      expect(out).not.toContain('\n## x');
      expect(out).not.toContain('\n## y');
      expect(normalizeAssistantMarkdown(out)).toBe(out); // idempotent
    });

    it('regression 3: a REAL blockquote fence already in the source is tracked', () => {
      const input = '> ```js\nconst a = 1 ## x ## y\n> ```\nafter';
      // The content line is NEVER split (the ticket's manufactured H2s), and
      // the only edit is the standard fence-separation blank before the
      // second bq opener (origin/main idiom; renderer-harmless).
      const out = '> ```js\nconst a = 1 ## x ## y\n\n> ```\nafter';
      expect(normalizeAssistantMarkdown(input)).toBe(out);
      expect(out).toContain('> ```js'); // fence opener survives
      expect(out).toContain('\nafter'); // text after the fence preserved
      expect(out).not.toMatch(/(^|\n)## /); // no manufactured headings
      expect(normalizeAssistantMarkdown(out)).toBe(out); // idempotent
    });

    it('positive control: an all-prefixed blockquote fence keeps its content intact', () => {
      const input = '> ```js\n> code ## not-a-heading\n> ```';
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    it('positive control: an unprefixed fence line after a blockquote fence opens a NEW column-0 fence', () => {
      // micromark does not lazy-continue fences inside blockquotes: the bq
      // fence ends at 'code ## x ## y' (split suppressed there — safe), and
      // the unprefixed ``` opens a fresh column-0 fence, so 'after' is code
      // content to BOTH sides. The blank before the new opener is the
      // standard fence-separation rule (same as origin/main; renderer-harmless).
      const input = '> ```js\ncode ## x ## y\n```\nafter';
      const out = '> ```js\ncode ## x ## y\n\n```\nafter';
      expect(normalizeAssistantMarkdown(input)).toBe(out);
      expect(normalizeAssistantMarkdown(out)).toBe(out); // idempotent
    });

    it('review B1: setext --- protection still fires in the blockquote-fence window', () => {
      // The renderer ends the bq fence at 'foo', so 'foo\n---' is a live
      // setext H2 unless the normalizer blank-separates it (its first job).
      expect(normalizeAssistantMarkdown('> ```js\nfoo\n---\nbar')).toBe(
        '> ```js\nfoo\n\n---\nbar',
      );
      // At-EOF variant.
      expect(normalizeAssistantMarkdown('> ```js\ncode line\n---')).toBe(
        '> ```js\ncode line\n\n---',
      );
      // Tilde opener + closed-fence variants.
      expect(normalizeAssistantMarkdown('> ~~~js\nfoo\n---\nbar')).toBe(
        '> ~~~js\nfoo\n\n---\nbar',
      );
      expect(normalizeAssistantMarkdown('> ```js\nfoo\n---\n> ```\nbar')).toBe(
        '> ```js\nfoo\n\n---\n\n> ```\nbar', // + standard blank before the new opener
      );
    });

    it('review B2: run-on-heading demotion still fires in the blockquote-fence window', () => {
      const input = '> ```js\nfoo\n## ' + 'h'.repeat(200);
      // The renderer ends the bq fence at 'foo' — the 200-char ATX line is a
      // real run-on heading to it, so demotion must strip the marker (the
      // 814809bf all-bold symptom otherwise survives).
      expect(normalizeAssistantMarkdown(input)).toBe('> ```js\nfoo\n' + 'h'.repeat(200));
    });

    it('review B3: an unprefixed fence line is NOT a closer — code content stays intact', () => {
      // Variant A: the renderer opens a NEW column-0 fence at the unprefixed
      // ```, so 'b ## x ## y' is code content — never split, no blank lines
      // injected INTO the code. (The blank before the opener is the standard
      // fence-separation rule — exactly origin/main's output for this input.)
      expect(normalizeAssistantMarkdown('> ```js\na\n```\nb ## x ## y')).toBe(
        '> ```js\na\n\n```\nb ## x ## y',
      );
      // Variant B: a heading-looking line after the new opener stays literal
      // code content (demotion must not strip markers inside real code).
      expect(normalizeAssistantMarkdown('> ```js\na\n```\n## ' + 'h'.repeat(200))).toBe(
        '> ```js\na\n\n```\n## ' + 'h'.repeat(200),
      );
    });

    it('positive control: a plain fence is NOT closed by a "> ```" line (prefix family)', () => {
      // The closer may never carry MORE blockquote nesting than the opener —
      // '> ```' inside a column-0 fence is code content (micromark agrees).
      const input = '```js\ncode ## x ## y\n> ```\nafter';
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    it('positive control: a deeper-prefixed line is not a closer (toggle asymmetry)', () => {
      // '>> ```' inside a '> ```' fence is nested-quote code content, not a
      // closer — the fence stays open to end-of-input like the renderer's.
      const input = '> ```\n>> ```\nrest';
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    it('positive control: a nested blockquote fence (>> ```js) opens and closes', () => {
      const input = '>> ```js\n>> code ## not a heading\n>> ```\nafter';
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    it('positive control: blockquote lines without fences are unaffected', () => {
      const input = '> not a fence\n> still quoted prose';
      expect(normalizeAssistantMarkdown(input)).toBe(input);
    });

    // ── Adversarial review F1 (round 2): window idempotency ───────────────
    // Pass 1 blank-separates HR/table/list/setext INSIDE the window (B1 —
    // the renderer needs it). The window must SURVIVE those self-inserted
    // blanks, or pass 2 exits at them and re-splits protected lines into the
    // very H2s the window exists to suppress (the frontend port re-normalizes
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
          const p1 = normalizeAssistantMarkdown(input);
          expect(p1).toBe(expected); // blank inserted before structure; tail NOT split
          expect(p1).toContain('tail ## x ## y'); // no manufactured H2s
          expect(normalizeAssistantMarkdown(p1)).toBe(p1); // pass 2 fixpoint
          expect(normalizeAssistantMarkdown(normalizeAssistantMarkdown(p1))).toBe(p1);
        });
      }

      it('control: a REAL blank before plain prose still ends the window', () => {
        // The blank before 'plain ## x ## y' cannot be self-inserted (no
        // blank-separated structure follows it), so the core collapsed-heading
        // repair must still apply there.
        const p1 = normalizeAssistantMarkdown('> ```js\nfoo\n\nplain ## x ## y');
        expect(p1).not.toContain('plain ## x ## y'); // split DID happen
        expect(p1).toMatch(/(^|\n)## x/);
        expect(normalizeAssistantMarkdown(p1)).toBe(p1); // and is stable
      });

      it('control: an ATX heading inside the window is still NOT blank-separated', () => {
        // Renders identically with or without the blank; inserting it would
        // drift later passes. Locked so the F1 survive-list cannot regress it.
        const input = '> ```js\nfoo\n## Real Heading';
        expect(normalizeAssistantMarkdown(input)).toBe(input);
      });
    });
  });
});

describe('collapsed-table repair (feedback fdd85bb3)', () => {
  // The live incident line (c0e22e36, 2026-08-28T23:13:37Z): the supervisor
  // model emitted the whole status table on ONE line — pseudo-header words,
  // the literal delimiter, undelimited cells, AND backticked lane ids.
  const INCIDENT =
    '**Critic lane wake — Phase-6 merge hit CI failure, lane is actively debugging** ' +
    'Item Status Detail |---|---|--- Critic lane `596102ca` 🔴 CI FAIL ' +
    'Both Python jobs failed on Phase-6 merge — lane rebasing';

  it('splits the collapsed table at the delimiter and drops the pipe noise', () => {
    const out = normalizeAssistantMarkdown(INCIDENT);
    expect(out).not.toContain('|---|');
    expect(out).toBe(
      '**Critic lane wake — Phase-6 merge hit CI failure, lane is actively debugging** Item Status Detail\n\n' +
        'Critic lane `596102ca` 🔴 CI FAIL Both Python jobs failed on Phase-6 merge — lane rebasing',
    );
    // Idempotent: the repaired form is a fixpoint.
    expect(normalizeAssistantMarkdown(out)).toBe(out);
  });

  it('handles multiple collapsed tables on one line', () => {
    const out = normalizeAssistantMarkdown('alpha |---|---| beta |---|---|---| gamma');
    expect(out).toBe('alpha\n\nbeta\n\ngamma');
  });

  it('never touches a well-formed multi-line table', () => {
    const input = 'intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\noutro';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never splits a delimiter inside inline code', () => {
    const input = 'use `a|---|b|---|c` literally';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('repairs the delimiter even when the line carries backticked ids (the incident class)', () => {
    // NOT the blanket backtick skip: wake notes backtick lane ids on the very
    // lines that need repair. Backtick count before the delimiter is EVEN here.
    const out = normalizeAssistantMarkdown('lane `a1f994c7` status |---|---|--- flowing cells');
    expect(out).toBe('lane `a1f994c7` status\n\nflowing cells');
  });

  it('leaves single-cell pipe prose alone (≥2 delimiter cells required)', () => {
    const input = 'the range a |---| b stays prose';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never splits a leading-whitespace line (indented code)', () => {
    const input = 'para\n\n    indented |---|---|---| code';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never touches a delimiter inside a fenced code block', () => {
    const input = 'text\n\n```\nascii |---|---|---| diagram\n```';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('B1 (review): never deletes the delimiter row of a BLOCKQUOTED real table', () => {
    // TABLE_ROW_RE doesn't see the '> ' prefix — without the blockquote guard
    // the quoted delimiter looked mid-line and the table was destroyed.
    const input = '> | a | b |\n> |---|---|\n> | 1 | 2 |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('N4 (review): never splits blockquoted prose — the tail would escape the quote', () => {
    const input = '> quote says a |---|---|---| b';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('N2 (review): compound line still recovers headings AND drops the delimiter', () => {
    // Heading split first (its ≥2-marker rule needs the whole line), then the
    // table repair per piece.
    expect(normalizeAssistantMarkdown('intro ## H |---|---|---| cells ## J')).toBe('intro\n\n## H\n\ncells\n\n## J');
  });

  it('N1 (review): a table-split piece that opens a fence is fence-tracked', () => {
    // Without tracking, 'code body' was reclassified paragraph→code with a
    // blank injected inside the fence.
    const input = 'x |---|---|---| ```js\ncode body\n```';
    expect(normalizeAssistantMarkdown(input)).toBe('x\n\n```js\ncode body\n```');
  });
});

describe('collapsed-structure repairs round 2 (feedback 44204e09)', () => {
  it('rebuilds a delimiter-less collapsed table: glued header + inline-joined rows (incident replay, msg 48c3b148)', () => {
    const input = [
      '**Wake — 10:55 AM PDT (17:55Z): verify-herd dispatched.** | Item | Fresh state | Action |',
      '',
      '| Nightly (b92ef13f) | Digest received | ✅ complete | | C0 session (4f918389) | PR #491 MERGED | ✅ closed | | C1 Session UI (79464b3d) | RUNNING | ✅ live |',
    ].join('\n');
    expect(normalizeAssistantMarkdown(input)).toBe(
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
    expect(normalizeAssistantMarkdown(input)).toBe('intro\n\n| a | b |\n| c | d |\n| e | f |');
  });

  it('re-lines flattened bold-led bullets into a real list (incident replay)', () => {
    const input =
      '**Dispatches this wake (evidence):** - **6bf8ce36** platform fix dispatched → session **1ca12570** - **Nightly acknowledged** → message **c3607ab6** to b92ef13f';
    expect(normalizeAssistantMarkdown(input)).toBe(
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
    expect(normalizeAssistantMarkdown(input)).toBe(
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
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('does not split bold-led numbers without a colon intro', () => {
    const input = 'Summary line.\n\nThe 2 **models** and 3 **lanes** agree on this.';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('leaves a real table row with an empty cell untouched (single join signature)', () => {
    const input = '| a | | b |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('fails safe on ragged inline rows (inconsistent cell counts → no repair)', () => {
    const input = '| a | b | | c | | d | e | f |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('still drops a glued DELIMITER via the fdd85bb3 repair (dash-cell pipe-run is not a header)', () => {
    const input = 'intro text |---|---|---|';
    expect(normalizeAssistantMarkdown(input)).toBe('intro text');
  });

  it('never splits a pipe-run inside an open bold span', () => {
    const input = '**bold text | a | b |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never repairs inside a blockquote (BQ_LINE_PREFIX guard)', () => {
    const input = '> **Items:** 1 **a** first 2 **b** second';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never repairs inside a fenced code block', () => {
    const input = '```\n| a | b | | c | d | | e | f |\n```';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('is idempotent across the round-2 repairs', () => {
    const input = [
      '**Wake — 10:55 AM PDT (17:55Z): verify-herd dispatched.** | Item | Fresh state | Action |',
      '',
      '| Nightly (b92ef13f) | Digest received | ✅ complete | | C0 session (4f918389) | PR #491 MERGED | ✅ closed | | C1 Session UI (79464b3d) | RUNNING | ✅ live |',
      '',
      '**Owner — two items:** 1 **2d4ff22f** still holding — re-dispatch? 2 **louse rig** burning ~$21/hr — release?',
    ].join('\n');
    const once = normalizeAssistantMarkdown(input);
    expect(normalizeAssistantMarkdown(once)).toBe(once);
  });

  it('F1 (review): synthesizes a delimiter with the TRUE GFM cell count (empty interior header cell)', () => {
    // The filtered-non-empty count manufactured a 2-cell delimiter for a
    // 3-cell header — GFM-invalid, rendered worse than the un-repaired text.
    const input = 'prose intro | a | | b |';
    expect(normalizeAssistantMarkdown(input)).toBe('prose intro\n\n| a | | b |\n|---|---|---|');
  });

  it('F1 (review): a pipe-run with ≥2 row joins is collapsed multi-row content, not a header — untouched', () => {
    const input = 'prose intro | a | b | | c | d | | e | f |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('F1 (review): one-line variants stay idempotent', () => {
    for (const input of [
      'prose intro | a | | b |',
      'prose intro | a | b | | c | d | | e | f |',
      'prose intro | a | b |',
    ]) {
      const once = normalizeAssistantMarkdown(input);
      expect(normalizeAssistantMarkdown(once)).toBe(once);
    }
  });

  it('B1 (review): never list-splits plain-colon prose with bold-led numbers', () => {
    // The intro colon must be BOLD-ADJACENT ('…:**'); 'Lanes: 2 **x** and 1
    // **y**' is ordinary prose — the ':\*{0,2}' intro chopped it mid-clause.
    const input = 'Status line.\n\nLanes: 2 **healthy** and 1 **degraded**';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });
});

describe('collapsed-structure repairs round 3 (feedback 7b7480fc)', () => {
  it('reflows a one-line table that includes its delimiter row (incident signature, ticket proposal 1)', () => {
    const input =
      '| Lane | Status | Detail | |---|---|---| | GLM-5.3 HW Benchmarking (c9ccf88a) | ⚠️ Steered | Run completed, but owner sent a steer | | Kernel | ✅ Done | P1 negative closure pushed |';
    expect(normalizeAssistantMarkdown(input)).toBe(
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
    expect(normalizeAssistantMarkdown(input)).toBe(
      ['**Wake note — x**', '', '| Item | Status |', '|---|---|', '| a | b |', '| c | d |'].join(
        '\n',
      ),
    );
  });

  it('reflows a single-data-row one-line table', () => {
    const input = '| H1 | H2 | |---|---| | a | b |';
    expect(normalizeAssistantMarkdown(input)).toBe('| H1 | H2 |\n|---|---|\n| a | b |');
  });

  it('keeps alignment colons and normalizes a missing trailing delimiter pipe', () => {
    const input = '| H1 | H2 | |:---|---: | a | b |';
    expect(normalizeAssistantMarkdown(input)).toBe('| H1 | H2 |\n|:---|---:|\n| a | b |');
  });

  it('reflows a one-line table mid-message and blank-separates it from the prose', () => {
    const input = '**Wake — x** intro line\n| Lane | Status | |---|---| | a | b |\ntrailing prose';
    expect(normalizeAssistantMarkdown(input)).toBe(
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
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('fails safe when the header cell count differs from the delimiter count', () => {
    const input = '| H | H | |---|---|---| | a | b | c |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('fails safe on two tables glued on one line (delimiter fragment inside the tail)', () => {
    const input = '| H | H | |---|---| | a | b | |---|---|';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never reflows a blockquoted one-line table (BQ_LINE_PREFIX guard)', () => {
    const input = '> | H | H | |---|---| | a | b |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never reflows inside a fenced code block', () => {
    const input = '```\n| H | H | |---|---| | a | b |\n```';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('still drops the delimiter for the fdd85bb3 class (header pipes dropped — no rebuild possible)', () => {
    const input = 'Lane Status Detail |---|---|---| cells flowing as prose here';
    expect(normalizeAssistantMarkdown(input)).toBe('Lane Status Detail\n\ncells flowing as prose here');
  });

  it('R2 (review): rebuilds a table with an empty interior cell when GFM counts agree', () => {
    // '| a | | b |' is THREE GFM cells (empty interior) — a 3-cell delimiter
    // and 3-cell rows make a valid table; the empty cell survives the reflow.
    const input = '| a | | b | |---|---|---| | c | | d |';
    expect(normalizeAssistantMarkdown(input)).toBe('| a | | b |\n|---|---|---|\n| c | | d |');
  });

  it('R2 (review): fails safe when the non-empty count hides a GFM mismatch (empty interior header cell, 2-cell delimiter)', () => {
    // Header has 3 GFM cells but only 2 non-empty — the old count would pair
    // it with a 2-cell delimiter and EMIT a table GFM rejects. Untouched now.
    const input = '| a | | b | |---|---| | c | d |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('re-lines a flattened bold-label dash list with a plain-colon intro (incident replay, msg 4eed309e)', () => {
    const input =
      '**Wake note — 3:02 PM PDT (22:02Z)** — spark 12/12 complete, on standing-serve + fleet watch: - **Spark 28de72e5 (event):** plan **12/12 complete** — all deferred legs done - **Kernel b95e9df6:** running, plan 1/6 - **Bench c9ccf88a:** running, plan 1/5';
    expect(normalizeAssistantMarkdown(input)).toBe(
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
    expect(normalizeAssistantMarkdown(input)).toBe(
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
    expect(normalizeAssistantMarkdown(input)).toBe('- **Spark:** done\n- **Kernel:** running');
  });

  // 6ee7a779 (chat 03130da9, stored msg dd2bf278): the collapse dropped the
  // BOLD entirely — a colon intro followed by PLAIN dash items. No bold-label
  // mark survives, so neither the bold-adjacent-colon intro nor the
  // bold-labelled splitter fires; without the plain-dash repair the whole list
  // ships as one prose wall (the "one big block of text" owner report).
  it('re-lines a colon-intro PLAIN-dash list with no bold labels (incident replay, ticket 6ee7a779, msg dd2bf278)', () => {
    const input =
      'Hourly progress updates are now armed — recurring schedule c0ee29b5 on this chat, every 60 minutes, first firing ~2:33 PM PDT (21:33Z) Each one will pull the live ledger fresh and post: - Lane-by-lane status (P3 LégisQuébec queue, P4 Érudit, P5 EN commentary, P6 territorial/BC) with countable deltas since the last update - Storage progress (files/GB banked, S3 parity) and premises that moved - ET@ the moment a rate exists — real pages/hour numbers - Anything needing your decision, or \'nothing needs you\'';
    expect(normalizeAssistantMarkdown(input)).toBe(
      [
        'Hourly progress updates are now armed — recurring schedule c0ee29b5 on this chat, every 60 minutes, first firing ~2:33 PM PDT (21:33Z) Each one will pull the live ledger fresh and post:',
        '',
        '- Lane-by-lane status (P3 LégisQuébec queue, P4 Érudit, P5 EN commentary, P6 territorial/BC) with countable deltas since the last update',
        '- Storage progress (files/GB banked, S3 parity) and premises that moved',
        '- ET@ the moment a rate exists — real pages/hour numbers',
        '- Anything needing your decision, or \'nothing needs you\'',
      ].join('\n'),
    );
  });

  it('leaves prose with a single parenthetical dash after a colon untouched (6ee7a779 — one mark is not a list)', () => {
    const input = 'The plan is simple: first we land the fix - then we verify it overnight.';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('leaves dashes with NO colon intro untouched (6ee7a779 — the intro is the landmark)', () => {
    const input = 'We compared three options - cheap, mid, and premium - before choosing the mid one.';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never cuts a plain-dash mark inside inline code (6ee7a779)', () => {
    const input = 'Fix these: - Run `git log - oneline - graph` first - Then report back';
    expect(normalizeAssistantMarkdown(input)).toBe(
      ['Fix these:', '', '- Run `git log - oneline - graph` first', '- Then report back'].join('\n'),
    );
  });

  it('is idempotent on the 6ee7a779 repair (a second normalize pass is a no-op)', () => {
    const input =
      'Armed and posting: - First item with detail - Second item with detail - Third item with detail';
    const once = normalizeAssistantMarkdown(input);
    expect(once).not.toBe(input);
    expect(normalizeAssistantMarkdown(once)).toBe(once);
  });

  // ── Adversarial-review BLOCKING-1 hardening (ticket 6ee7a779) — the bare
  // colon-intro gate manufactured lists from prose. Each negative test below
  // is a class the reviewer broke the original gate with.
  it('never treats a colon inside inline code as the list intro (review BLOCKING-1)', () => {
    const input = 'Run `x: - y` - first detail here - second detail here';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never manufactures a list from digit ranges (review BLOCKING-1)', () => {
    const input = 'times: - 10 - 12 - 14 on the dial';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never cuts marks inside a parenthetical — paired-aside prose stays whole (review BLOCKING-1)', () => {
    const input = 'Watch these two: - the build (tagged rc1 - not rc2) - the deploy (wave 55 - latest)';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never re-lines lowercase-led dashes in dash-aside prose (review BLOCKING-1)', () => {
    const input = 'The lane - blocked since Tuesday: - queue drained - hooks stale - is now green';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('still re-lines real items that carry balanced parentheticals (6ee7a779 + review)', () => {
    const input = 'Deploy boxes: - Box A (web) - Box B (web) - Box C (worker)';
    expect(normalizeAssistantMarkdown(input)).toBe(
      ['Deploy boxes:', '', '- Box A (web)', '- Box B (web)', '- Box C (worker)'].join('\n'),
    );
  });


  it('leaves a lone bold-label dash mark on a prose line untouched (≥2 required)', () => {
    const input = 'Status: - **Bench:** running well today.';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('leaves dash-led bold spans without label colons untouched', () => {
    const input = 'range 5 - **6** items - **7** total';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never cuts a label mark inside inline code', () => {
    const input = '`code - **x:** y` tail - **z:** w';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never cuts a label mark inside an open bold span', () => {
    const input = '**intro - **A:** one - **B:** two';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('is idempotent across the round-3 repairs', () => {
    const input = [
      '**Wake note — 3:02 PM PDT (22:02Z)** — spark 12/12 complete: - **Spark 28de72e5 (event):** done - **Kernel b95e9df6:** running',
      '',
      '| Lane | Status | |---|---| | a | b | | c | d |',
    ].join('\n');
    const once = normalizeAssistantMarkdown(input);
    expect(normalizeAssistantMarkdown(once)).toBe(once);
  });
});

describe('detached-table-body repair (ticket 942db7aa)', () => {
  // INCIDENT REPLAY (ticket 942db7aa, 2026-10-15 22:58Z, Fleet Supervisor chat
  // c0e22e36): the note emitted '| Item | State |' + '|---|---|' + BLANK +
  // every data row joined on ONE line, with the note's prose glued after the
  // last row's closing pipe. GFM ended the table at the blank; the owner saw
  // raw pipes ("again your formattuinbg is all messed up").
  // splitJoinedPipeRows rejected the body on both gates: the prose tail ragged
  // the last piece's cell count ([2,2,2,3]) and the 4-row body line's own
  // uniform gate needed ≥2 joins per BODY — its 3 joins produced ragged counts.
  it('repairs the 942db7aa incident: joined body behind a blank, prose tail glued after the last row', () => {
    const input = [
      '**What is closed vs. what actually still needs you:**',
      '',
      '| Item | State |',
      '|---|---|',
      '',
      '| CQL Cloudflare token | ✅ Resolved — present in Coding secrets all along nothing to do | | Tailscale tagOwners paste | Still open — surfaces 4:58 PM PDT (23:58Z) one ACL paste for the three new boxes | | LiteLLM provider-key re-mint | Still open — surfaces 5:24 PM PDT (00:24Z) 34 legs dark | | Schooltime recovery-email pick | Still open — mail provider decision | I\'ve corrected the fleet record and updated the credential ticket to reflect your call — the mishap is now framed as the probe misread, not a missing secret',
    ].join('\n');
    expect(normalizeAssistantMarkdown(input)).toBe(
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
    expect(normalizeAssistantMarkdown(input)).toBe(
      ['| A | B |', '|---|---|', '| one | two |', '| three | four |'].join('\n'),
    );
  });

  it('degrades nothing when the body is uniformly ragged (fail-safe: no repair, never worse)', () => {
    // first piece 3 cells vs the 2-cell anchor — unrecoverable, left untouched
    const input = '| A | B |\n|---|---|\n\n| a | b | c | | d | e | | f | g |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('does not treat a NEW table header after a blank as a detached body (join-tell disambiguator)', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |\n\n| C | D |\n|---|---|\n| 3 | 4 |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('does not fire without the delimiter anchor (pipe prose after unrelated prose)', () => {
    const input = 'Some intro line.\n\n| a | b | | c | d |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('is idempotent on the repaired output', () => {
    const input =
      '| Item | State |\n|---|---|\n\n| a | b | | c | d | | e | f | tail prose here';
    const once = normalizeAssistantMarkdown(input);
    expect(normalizeAssistantMarkdown(once)).toBe(once);
  });

  it('never repairs a blockquoted joined body (blockquote guard)', () => {
    const input = '| A | B |\n|---|---|\n\n> | one | two | | three | four |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('never repairs inside a fenced code block (fence guard)', () => {
    const input = '| A | B |\n|---|---|\n\n```\n| one | two | | three | four |\n```';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('drops trailing empty cells / framing pipes on the last piece (no content lost)', () => {
    // the trailing '| |' is framing only — rest carries no content, so the
    // kept row is the whole piece
    const input = '| A | B |\n|---|---|\n\n| a | b | | c | d | |';
    expect(normalizeAssistantMarkdown(input)).toBe(
      ['| A | B |', '|---|---|', '| a | b |', '| c | d |'].join('\n'),
    );
  });

  it('never detaches a prose tail mid-bold', () => {
    const input = '| A | B |\n|---|---|\n\n| a | b | **bold tail';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('repairs a ragged FIRST piece is refused (anchor count mismatch fails safe)', () => {
    const input = '| A | B |\n|---|---|\n\n| a | | c | | d | e |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });
});

describe('ticket 90308cf4 — glued header with the model\'s OWN delimiter row next line', () => {
  it('keeps the model\'s own delimiter instead of synthesizing a second one (no junk dashes row)', () => {
    const input = 'Some prose before the table | A | B |\n|---|---|\n| 1 | 2 |';
    expect(normalizeAssistantMarkdown(input)).toBe(
      'Some prose before the table\n\n| A | B |\n|---|---|\n| 1 | 2 |'
    );
  });

  it('bold-intro fleet-note shape (the wake-note idiom) keeps its own delimiter', () => {
    const input =
      "**Fleet wake — 1:07 AM PDT: summary line.** | Project | What moved | What's next |\n|---|---|---|\n| Schooltime | decrypt broke | ETA shorter |";
    expect(normalizeAssistantMarkdown(input)).toBe(
      "**Fleet wake — 1:07 AM PDT: summary line.**\n\n| Project | What moved | What's next |\n|---|---|---|\n| Schooltime | decrypt broke | ETA shorter |"
    );
  });

  it('still synthesizes a delimiter when NONE follows (glued header, no next-line delimiter)', () => {
    const input = 'prose intro | a | b |';
    expect(normalizeAssistantMarkdown(input)).toBe('prose intro\n\n| a | b |\n|---|---|');
  });

  it('a next-line delimiter with a MISMATCHED cell count is not the model\'s delimiter — synthesize', () => {
    const input = 'prose intro | a | b | c |\n|---|---|\n| 1 | 2 | 3 |';
    expect(normalizeAssistantMarkdown(input)).toBe(
      'prose intro\n\n| a | b | c |\n|---|---|---|\n|---|---|\n| 1 | 2 | 3 |'
    );
  });

  it('a pipe-less next-line delimiter with matching cells is kept (GFM optional pipes)', () => {
    const input = 'prose intro | a | b |\n---|---\n| 1 | 2 |';
    expect(normalizeAssistantMarkdown(input)).toBe(
      'prose intro\n\n| a | b |\n---|---\n| 1 | 2 |'
    );
  });

  it('is idempotent on the repaired output', () => {
    const input = 'Some prose before the table | A | B |\n|---|---|\n| 1 | 2 |';
    const once = normalizeAssistantMarkdown(input);
    expect(normalizeAssistantMarkdown(once)).toBe(once);
  });
});

describe('ticket 90308cf4 — non-pipe (optional-pipes) GFM tables are not torn apart', () => {
  it('body row after a non-pipe delimiter row stays attached (no manufactured blank)', () => {
    // 'A | B' / '---|---' / '| 1 | 2 |' is VALID GFM (optional pipes) and
    // remark-gfm renders it as paragraph + table WITHOUT any blank. The old
    // blank-separation pass inserted a blank between the delimiter and the
    // body, tearing the table into paragraph junk; now the shape passes
    // through unchanged.
    const input = 'Here is the table:\nA | B\n---|---\n| 1 | 2 |';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('a table in fully non-pipe form is left intact', () => {
    const input = 'Here is the table:\nA | B\n---|---\n1 | 2';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('thematic-break "---" never counts as a delimiter row (list text after --- is blank-separated)', () => {
    const input = 'Intro\n---\n- item one';
    expect(normalizeAssistantMarkdown(input)).toBe('Intro\n\n---\n\n- item one');
  });

  it('"- | -" stays a list item (GFM precedence), never a delimiter', () => {
    const input = 'Intro:\n- | -';
    expect(normalizeAssistantMarkdown(input)).toBe('Intro:\n\n- | -');
  });

  it('is idempotent on the repaired output', () => {
    const input = 'Here is the table:\nA | B\n---|---\n| 1 | 2 |';
    const once = normalizeAssistantMarkdown(input);
    expect(normalizeAssistantMarkdown(once)).toBe(once);
  });
});
