/**
 * ANS-3 — PROCESS NARRATION MUST NOT BE THE DELIVERABLE (goal 9ecd595e / todo
 * 450ce0b4, WRP-1 defect D6).
 *
 * This EXTENDS the delivered-answer gate from ticket 4d161561 (commit 89fbdf3b,
 * chat-agent/answer-scaffolding.ts) — it does not add a second stripper. The
 * existing gate is shape-based (reason tags / tool markup / harness markers /
 * tool-call JSON), and process narration is ordinary prose, so on the reported
 * Polk County body it returned `removed: 0` and all five lines shipped.
 *
 * EVERY fixture below is quoted from the reported answer. The OLD behaviour
 * this file fails on: `stripAnswerScaffolding(REPORTED_BODY)` removed nothing,
 * so the narration assertions (`not.toContain`) fail without this change.
 *
 * THE MUST-NOT-REGRESS CONTRACT, pinned as hard as the stripping itself: the
 * run was RIGHT to refuse unverifiable specifics and to publish a verified /
 * unverified split. A stripping change that eats that refusal would be a worse
 * bug than the leak, so the body's verified/unverified content is asserted
 * present, the refusal fixture is asserted BYTE-IDENTICAL, and a line stating
 * verification status is never removed even when it mentions a search.
 */
import { stripAnswerScaffolding, stripProcessNarration, stripAnswerScaffoldingText } from './answer-scaffolding';

/** The narration lines from the reported run, verbatim. */
const NARRATION = {
  searchAgain: 'The search surfaced older Polk County stings (108/160/219 arrests in 2022–23) — none match the 281 figure from your headline. Searching for the actual current story now.',
  throttled: 'The aggregated fetch got throttled — going direct to the outlets instead.',
  serpStored: 'The SERP was stored to memory — retrieving the actual links from it.',
  memoryMiss: "Memory doesn't have it.",
  guessed404: "Polk County Sheriff's news page returned a 404 when I hit it directly",
};

/** The reported delivered body: five narration lines wrapped around the answer. */
const REPORTED_BODY = [
  NARRATION.searchAgain,
  '',
  NARRATION.throttled,
  '',
  NARRATION.serpStored,
  '',
  NARRATION.memoryMiss,
  '',
  NARRATION.guessed404,
  '',
  '## What is verified',
  '',
  '- The Polk County Sheriff\'s Office has publicized multi-agency operations in past years.',
  '- No source I could reach confirms a 281-arrest operation.',
  '',
  '## What is unverified',
  '',
  '- The operation\'s official name (unverified).',
  '- Named arrestees and victim/rescue counts (unverified).',
].join('\n');

describe('ANS-3 D6 — narration is stripped from the delivered body', () => {
  it('removes every reported narration line (the old gate removed ZERO of them)', () => {
    const out = stripAnswerScaffolding(REPORTED_BODY);
    // ← FAILS on the old behaviour: removed === 0 and every line survives.
    expect(out.removed).toBe(5);
    for (const line of Object.values(NARRATION)) expect(out.text).not.toContain(line);
    expect(out.stripped).toEqual([{ shape: 'process-narration', lines: 5 }]);
  });

  it('KEEPS the verified/unverified split intact — the refusal is the answer, not the plumbing', () => {
    const out = stripAnswerScaffolding(REPORTED_BODY);
    expect(out.text).toContain('## What is verified');
    expect(out.text).toContain('## What is unverified');
    expect(out.text).toContain('No source I could reach confirms a 281-arrest operation.');
    expect(out.text).toContain('The operation\'s official name (unverified).');
    expect(out.text).toContain('Named arrestees and victim/rescue counts (unverified).');
  });

  it('leaves a clean answer BYTE-IDENTICAL (a working answer is never rewritten)', () => {
    const clean = '## Answer\n\nPolk County is in Florida.\n\n- One finding.\n- Another finding.';
    expect(stripAnswerScaffolding(clean)).toEqual({ text: clean, stripped: [], removed: 0 });
  });

  it('is idempotent — a second pass finds nothing left to strip', () => {
    const once = stripAnswerScaffolding(REPORTED_BODY);
    const twice = stripAnswerScaffolding(once.text);
    expect(twice.removed).toBe(0);
    expect(twice.text).toBe(once.text);
  });

  it('holds the apology line the incident published around the answer', () => {
    const body = 'I apologize for the confusion — the aggregated fetch failed.\n\n## Verified\n\n- A fact.';
    const out = stripAnswerScaffolding(body);
    expect(out.text).not.toContain('I apologize');
    expect(out.text).toContain('- A fact.');
  });
});

/**
 * THE TOOL-PILL SHAPE — the gap the prose-cue pass did NOT close.
 *
 * Measured 2026-10-31 by the Fleet Supervisor and independently by ticket lane
 * 6763708c: after `stripProcessNarration` removed the five prose lines, these
 * three pill LABELS still shipped. They are the literal text the owner pasted
 * when he wrote "this is unnaccetable". A fix that only removes the prose is
 * not D6 closed.
 */
const PILLS = [
  'Researched online · Polk County 281 arrested human trafficking bust Di',
  'Researched online · "Polk County" 281 arrested human trafficking opera',
  'Searched project memory · 281 arrested Polk County human trafficking Disney',
];

/** The delivered shape: pills on top, then the real answer. */
const PILL_BODY = [
  PILLS[0],
  PILLS[1],
  PILLS[2],
  '',
  '## What is verified',
  '',
  '- The Polk County Sheriff\'s Office has publicized multi-agency operations in past years.',
  '',
  '## What is unverified',
  '',
  '- The operation\'s official name (unverified).',
].join('\n');

describe('ANS-3 D6 — tool pills never reach the delivered body (measured gap, 2026-10-31)', () => {
  it('removes all three reported pill lines verbatim', () => {
    const out = stripAnswerScaffolding(PILL_BODY);
    for (const pill of PILLS) expect(out.text).not.toContain(pill);
    expect(out.removed).toBe(3);
    expect(out.stripped).toEqual([{ shape: 'process-narration', lines: 3 }]);
  });

  it('KEEPS the verified/unverified split that follows the pills', () => {
    const out = stripAnswerScaffolding(PILL_BODY);
    expect(out.text).toContain('## What is verified');
    expect(out.text).toContain('## What is unverified');
    expect(out.text).toContain('- The operation\'s official name (unverified).');
  });

  it('covers every retriever label this product renders a pill for', () => {
    const shapes = [
      'Researched online · how do I install it',
      'Retrieved online · how do I install it',
      'Searched the web · how do I install it',
      'Searched project memory · how do I install it',
      'Searched session memory · how do I install it',
      'Searched chat memory · how do I install it',
    ];
    for (const s of shapes) expect(stripProcessNarration(s).lines).toBe(1);
  });

  it('is CLOSED-SET on the retriever target — ordinary prose with a middot survives', () => {
    const prose = [
      'Searched the county registry · 3 matching parcels were found in 2022.',
      'The 281 figure · per the sheriff, unverified.',
      'Researched online sources broadly and found no match.',
    ];
    for (const p of prose) expect(stripProcessNarration(p).lines).toBe(0);
  });

  it('keeps a pill-shaped line that states verification status (the refusal always wins)', () => {
    expect(stripProcessNarration('Researched online · the 281 figure is unverified').lines).toBe(0);
  });
});

describe('ANS-3 — the conservatism contract (never delete real analysis)', () => {
  it('keeps a sourced paragraph that merely mentions a search', () => {
    const line = 'According to the WESH report, the operation ran for six months and involved 281 arrests across Polk County.';
    const out = stripAnswerScaffolding(line);
    expect(out.text).toBe(line);
    expect(out.removed).toBe(0);
  });

  it('keeps any line that states verification status, even with a plumbing word in it', () => {
    const lines = [
      'The search results were unverified — treat the 281 figure as unconfirmed.',
      'I could not verify the operation name; verified only that an operation was announced.',
      'The SERP returned results, but the figures remain unverified.',
    ];
    for (const line of lines) {
      expect(stripProcessNarration(line).lines).toBe(0);
    }
  });

  it('keeps bullets and numbered findings (a list item is a finding, not chatter)', () => {
    const text = [
      '- I searched the sheriff\'s site and found no press release.',
      '1. The aggregator returned older stings from 2022 and 2023.',
    ].join('\n');
    expect(stripProcessNarration(text).lines).toBe(0);
  });

  it('keeps a quoted or fenced line (an illustration is never deleted)', () => {
    expect(stripProcessNarration('> The SERP was stored to memory — retrieving the actual links from it.').lines).toBe(0);
    expect(stripProcessNarration('```\nThe SERP was stored to memory.\n```').lines).toBe(0);
  });

  it('keeps a LONG paragraph — narration is short, analysis is not', () => {
    const long = `The search surfaced older stings. ${'Detailed analysis of what each prior operation involved, with dates and figures, follows here. '.repeat(6)}`;
    expect(long.length).toBeGreaterThan(400);
    expect(stripProcessNarration(long).lines).toBe(0);
  });

  it('is conservative about weak cues: a first-person retrieval verb needs a RETRIEVAL OBJECT', () => {
    // No retrieval object → prose, untouched. "Let me check." is an existing
    // 89fbdf3b pin and must survive.
    expect(stripProcessNarration('I think the figure is inflated.').lines).toBe(0);
    expect(stripProcessNarration('We should note the discrepancy.').lines).toBe(0);
    expect(stripProcessNarration('Let me check.').lines).toBe(0);
    expect(stripProcessNarration('Let me pull the details now.').lines).toBe(0);
    // A first-person retrieval verb naming a RETRIEVAL OBJECT → narration.
    expect(stripProcessNarration('I searched the web for the current story.').lines).toBe(1);
    expect(stripProcessNarration('Let me pull the search results now.').lines).toBe(1);
    // The incident's own line, removed by its own idiom:
    expect(stripProcessNarration('Searching for the actual current story now.').lines).toBe(1);
  });
});

describe('ANS-3 — it is the SAME gate, not a second stripper', () => {
  it('composes with the existing shapes in one pass', () => {
    const body = [
      '<<redacted_reasoning>>hidden plan<</redacted_reasoning>>',
      'The SERP was stored to memory — retrieving the actual links from it.',
      '## Answer',
      '- A verified fact.',
    ].join('\n');
    const out = stripAnswerScaffolding(body);
    expect(out.stripped.map((s) => s.shape)).toEqual(expect.arrayContaining(['process-narration']));
    expect(out.text).not.toMatch(/<<redacted_reasoning>>|hidden plan/);
    expect(out.text).toContain('- A verified fact.');
  });

  it('exposes the text-only convenience form the finalize seam already uses', () => {
    expect(stripAnswerScaffoldingText(REPORTED_BODY)).not.toContain(NARRATION.throttled);
  });
});