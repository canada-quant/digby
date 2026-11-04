/**
 * Tests for shared pipeline utility functions.
 * 2026-06-15: Created alongside extraction into pipeline-utils.ts.
 */
import {
  rewriteFollowUp,
  splitCompoundFollowUp,
  parseFollowUps,
  parseCanvasTags,
  stripAnswerMarkup,
  detectCanvasPreambleWithoutContent,
  stripCanvasPreamble,
  retryOnModelNotFound,
  normalizeIp,
  sameIpSession,
  maskIp,
  isLeakedReasoningFollowUp,
  isPlanningStub,
} from './pipeline-utils';
import { isWebSearchMeaningful } from '../integrations/synthesis-prompts';

describe('rewriteFollowUp', () => {
  it('rewrites "Would you like me to X?" to "X"', () => {
    expect(rewriteFollowUp('Would you like me to check your schedule?'))
      .toBe('Check your schedule');
  });
  it('rewrites "Should I X?" to "X"', () => {
    expect(rewriteFollowUp('Should I draft a summary?'))
      .toBe('Draft a summary');
  });
  it('strips trailing "for you"', () => {
    expect(rewriteFollowUp('I can look that up for you'))
      .toBe('Look that up');
  });
  it('keeps question mark for question-word starts', () => {
    expect(rewriteFollowUp('What are the costs?')).toBe('What are the costs?');
  });
  it('capitalizes first letter after rewrite', () => {
    expect(rewriteFollowUp('shall i look into that')).toBe('Look into that');
  });
  it('passes through user-perspective text unchanged', () => {
    expect(rewriteFollowUp('Show me the latest data')).toBe('Show me the latest data');
  });
});

describe('splitCompoundFollowUp', () => {
  it('splits compound questions longer than 50 chars', () => {
    const r = splitCompoundFollowUp('What are the typical implementation costs and what is the expected timeline for completion?');
    expect(r).toHaveLength(2);
    expect(r[0]).toMatch(/costs/i);
    expect(r[1]).toMatch(/timeline/i);
  });
  it('does not split short text', () => {
    expect(splitCompoundFollowUp('Short text')).toEqual(['Short text']);
  });
  it('splits two complete questions joined by an internal question mark', () => {
    const r = splitCompoundFollowUp("What are the implementation costs? What is the expected timeline?");
    expect(r).toHaveLength(2);
    expect(r[0]).toBe('What are the implementation costs?');
    expect(r[1]).toBe('What is the expected timeline?');
  });
  it('strips a leading conjunction on the second question', () => {
    const r = splitCompoundFollowUp("What are the main risks? And how do we mitigate them?");
    expect(r).toHaveLength(2);
    expect(r[1]).toBe('How do we mitigate them?');
  });
  it('does not split a single trailing question mark', () => {
    expect(splitCompoundFollowUp('What is the projected revenue growth for next year?'))
      .toEqual(['What is the projected revenue growth for next year?']);
  });
  it('does not over-split on a short rhetorical fragment', () => {
    // "Why?" is < 12 chars → bail rather than produce a junk segment.
    expect(splitCompoundFollowUp('Why? Tell me more about the long-term outlook.'))
      .toEqual(['Why? Tell me more about the long-term outlook.']);
  });
});

describe('parseFollowUps', () => {
  it('extracts follow-ups from complete block', () => {
    const text = `Answer.\n\n[FOLLOWUPS]\n- What are the typical costs?\n- Draft a comparison\n- How long does it take?\n[/FOLLOWUPS]`;
    const { followUps, cleanText } = parseFollowUps(text);
    expect(followUps).toHaveLength(3);
    expect(followUps[0]).toBe('What are the typical costs?');
    expect(cleanText).toBe('Answer.');
  });
  it('extracts + strips case-variant blocks (ticket 0d344f95 — model wrote [Followups])', () => {
    const text = `Answer.\n\n[Followups]\n- What are the typical costs?\n- How long does it take?\n[/Followups]`;
    const { followUps, cleanText } = parseFollowUps(text);
    expect(followUps).toHaveLength(2);
    expect(followUps[0]).toBe('What are the typical costs?');
    expect(cleanText).toBe('Answer.');
    // …and the unclosed case-variant tail too.
    const open = parseFollowUps(`Answer.\n\n[followUPS]\n- What are the typical costs?`);
    expect(open.followUps).toHaveLength(1);
    expect(open.cleanText).toBe('Answer.');
  });
  it('handles partial block (no closing tag)', () => {
    const text = `Answer.\n\n[FOLLOWUPS]\n- First question here\n- Second question here`;
    const { followUps } = parseFollowUps(text);
    expect(followUps.length).toBeGreaterThanOrEqual(2);
  });
  it('returns empty followUps when no block present', () => {
    const { followUps } = parseFollowUps('Just a plain answer.');
    expect(followUps).toHaveLength(0);
  });
  it('filters leaked reasoning from a [FOLLOWUPS] block (2026-07-11)', () => {
    // A synthesis model leaked its own reasoning about the user into a suggestion.
    // parseFollowUps must drop it (same guard the utility follow-up path uses).
    const text =
      `Answer.\n\n[FOLLOWUPS]\n` +
      `- You're Paul Cozzolino — based on your Calendly handle (pcozz), you likely want the pro plan\n` +
      `- What are the typical costs?\n` +
      `- We need to generate a suggestion about the timeline\n` +
      `[/FOLLOWUPS]`;
    const { followUps } = parseFollowUps(text);
    expect(followUps).toEqual(['What are the typical costs?']);
  });
});

describe('parseCanvasTags', () => {
  it('parses attributed canvas blocks', () => {
    const text = `Intro.\n\n[CANVAS:type=document,title=My Report]\n# Content\nFull report.\n[/CANVAS]`;
    const { canvases, cleanText } = parseCanvasTags(text);
    expect(canvases).toHaveLength(1);
    expect(canvases[0].type).toBe('document');
    expect(canvases[0].title).toBe('My Report');
    expect(cleanText).toBe('Intro.');
  });
  it('handles bare [CANVAS] tags', () => {
    const text = `[CANVAS]\n# My Document\nContent here is longer than minimum.\n[/CANVAS]`;
    const { canvases } = parseCanvasTags(text);
    expect(canvases).toHaveLength(1);
    expect(canvases[0].title).toBe('My Document');
  });
  it('returns empty for text without canvas', () => {
    const { canvases } = parseCanvasTags('Regular text.');
    expect(canvases).toHaveLength(0);
  });
});

describe('detectCanvasPreambleWithoutContent', () => {
  it('detects preamble without canvas block', () => {
    expect(detectCanvasPreambleWithoutContent(
      "Here's your structure — open the canvas below to view it."
    )).toBe(true);
  });
  it('returns false when canvas block IS present', () => {
    const text = `Open the canvas below.\n[CANVAS:type=document,title=T]\nContent.\n[/CANVAS]`;
    expect(detectCanvasPreambleWithoutContent(text)).toBe(false);
  });
  it('returns false for text without canvas references', () => {
    expect(detectCanvasPreambleWithoutContent('Normal answer.')).toBe(false);
  });
});

describe('isPlanningStub', () => {
  it('detects a bare "Let me search..." planning stub (chat b7f99171)', () => {
    expect(isPlanningStub(
      'Let me search more specifically for the current One Piece English volume release info.'
    )).toBe(true);
  });
  it('detects other information-retrieval planning openers', () => {
    expect(isPlanningStub("I'll look up the latest figures for you.")).toBe(true);
    expect(isPlanningStub('Let me look that up for you.')).toBe(true);
    expect(isPlanningStub('One moment while I search for that.')).toBe(true);
    expect(isPlanningStub('Searching for the latest data...')).toBe(true);
    expect(isPlanningStub("Let me research the current release timeline.")).toBe(true);
  });
  it('detects a multi-sentence planning stub between 220 and 320 chars (chat 496b69b8)', () => {
    // Re-ask class: a 2-3 sentence stub that is entirely a plan to look something up.
    // Runs past the old 220-char cap but is still nothing but a promise to search.
    const stub =
      "Let me search for the specifics on BC driving records for you right now. " +
      "DUIs and 24-hour roadside suspensions can each affect what shows up on your record, " +
      "and the provincial rules changed fairly recently. " +
      "I'll pull up the current official ICBC guidance to make sure I give you the accurate answer.";
    expect(stub.length).toBeGreaterThan(220);
    expect(stub.length).toBeLessThan(320);
    expect(isPlanningStub(stub)).toBe(true);
  });
  it('detects a 4-sentence planning stub that exceeds 320 chars (2026-07-11)', () => {
    // Pure-deferral stub in the 320–600 band: every sentence is a plan/promise with no
    // answer content. Previously slipped through because it ran past the 320 cap.
    const stub =
      "Let me look into the current British Columbia driving-record rules for you right now. " +
      "I'll search the official ICBC guidance carefully to make sure that the details are fully accurate. " +
      "This will help me give you the exact suspension periods that would apply in your situation. " +
      "One moment while I gather all the information so that I can answer this properly for you here.";
    expect(stub.length).toBeGreaterThan(320);
    expect(stub.length).toBeLessThan(600);
    expect(isPlanningStub(stub)).toBe(true);
  });
  it('does NOT flag a >320 answer that opens with a plan then delivers facts', () => {
    // Opens with a lookup plan but the following sentences carry concrete data (digits),
    // so it is a real answer, not a stub — must be preserved.
    const real =
      "Let me look up the exact figures for you across the last couple of reporting years. " +
      "BC issued 4,200 immediate roadside prohibitions in 2025, which was up 12% from 2024. " +
      "A first 90-day suspension typically stays on your driving record for a full 5 years. " +
      "DUIs remain visible far longer, often 10 years, under the current provincial rules.";
    expect(real.length).toBeGreaterThan(320);
    expect(isPlanningStub(real)).toBe(false);
  });
  it('does NOT flag a real answer that merely opens with "Let me walk through"', () => {
    const real = 'Let me walk through the peptides with the strongest evidence. ' +
      'BPC-157 has shown tissue-repair effects in rodent models, while TB-500 promotes ' +
      'angiogenesis. Semaglutide is FDA-approved for weight loss and has robust trial data. ' +
      'GHK-Cu is used topically for skin repair with some clinical support. Each of these ' +
      'has a distinct mechanism and evidence base worth comparing in detail.';
    expect(real.length).toBeGreaterThan(320);
    expect(isPlanningStub(real)).toBe(false);
  });
  it('does NOT flag a normal factual answer', () => {
    expect(isPlanningStub('The newest English One Piece volume is Volume 108, released March 2026.')).toBe(false);
  });
  it('does NOT flag a real answer that opens with "Let me check that for you"', () => {
    // "check"/"find" are excluded because they appear in genuine answers.
    expect(isPlanningStub('Let me check that for you — the answer is 42, based on the calculation.')).toBe(false);
    expect(isPlanningStub("Let me find the right word: the term you want is \"serendipity\".")).toBe(false);
  });
  it('returns false for empty input', () => {
    expect(isPlanningStub('')).toBe(false);
    expect(isPlanningStub('   ')).toBe(false);
  });
});

describe('normalizeIp', () => {
  it('strips ::ffff: prefix', () => {
    expect(normalizeIp('::ffff:192.168.1.1')).toBe('192.168.1.1');
  });
  it('leaves regular IPv4 unchanged', () => {
    expect(normalizeIp('192.168.1.1')).toBe('192.168.1.1');
  });
  it('handles "unknown"', () => {
    expect(normalizeIp('unknown')).toBe('unknown');
  });
});


describe('sameIpSession', () => {
  it('matches identical IPv4', () => {
    expect(sameIpSession('192.168.1.10', '192.168.1.10')).toBe(true);
  });
  it('matches IPv4 within the same /24 (mobile last-octet rotation)', () => {
    expect(sameIpSession('192.168.1.10', '192.168.1.250')).toBe(true);
  });
  it('rejects IPv4 on a different /24', () => {
    expect(sameIpSession('192.168.1.10', '192.168.2.10')).toBe(false);
  });
  it('normalizes ::ffff: prefixes before comparing', () => {
    expect(sameIpSession('::ffff:192.168.1.10', '192.168.1.99')).toBe(true);
  });
  it('matches IPv6 within the same /64', () => {
    expect(sameIpSession('2001:db8:abcd:1::1', '2001:db8:abcd:1::ffff')).toBe(true);
  });
  it('rejects IPv6 on a different /64', () => {
    expect(sameIpSession('2001:db8:abcd:1::1', '2001:db8:abcd:2::1')).toBe(false);
  });
  it('rejects mismatched address families', () => {
    expect(sameIpSession('192.168.1.10', '2001:db8::1')).toBe(false);
  });
});

describe('maskIp', () => {
  it('masks the IPv4 host octet (keeps the /24 the check compares)', () => {
    expect(maskIp('203.0.113.42')).toBe('203.0.113.x');
  });
  it('normalizes ::ffff: prefixes before masking', () => {
    expect(maskIp('::ffff:198.51.100.7')).toBe('198.51.100.x');
  });
  it('masks the IPv6 host (keeps the first four hextets / the /64)', () => {
    expect(maskIp('2001:db8:abcd:1::1')).toBe('2001:db8:abcd:1:x');
  });
  it('returns "unknown" for empty/unparseable input', () => {
    expect(maskIp('')).toBe('unknown');
    expect(maskIp('garbage')).toBe('unknown');
  });
});

describe('isLeakedReasoningFollowUp', () => {
  // Regression coverage for the most-recurring production bug: chain-of-thought /
  // prompt-echo leaking into a follow-up suggestion button. Each rejected case is a
  // real or realistic leak observed in thumbs-down feedback.
  it('rejects the reported "We need to generate N follow-up suggestions" prompt echo', () => {
    expect(isLeakedReasoningFollowUp(
      'We need to generate 4 follow-up suggestions for the user.')).toBe(true);
  });
  it('rejects "The user is Rome based on context" reasoning', () => {
    expect(isLeakedReasoningFollowUp('The user is Rome based on context')).toBe(true);
  });
  it('rejects lines opening with a reasoning hedge', () => {
    expect(isLeakedReasoningFollowUp("Possibly the user's name is Rome?")).toBe(true);
    expect(isLeakedReasoningFollowUp('Or the answer is separate from this')).toBe(true);
    expect(isLeakedReasoningFollowUp('Alternatively, the context suggests X')).toBe(true);
  });
  it('rejects CoT keyword markers (I\'ll follow the context, based on context)', () => {
    expect(isLeakedReasoningFollowUp("I'll follow the context and suggest topics")).toBe(true);
    expect(isLeakedReasoningFollowUp('Based on the context, personalize suggestions')).toBe(true);
  });
  it('rejects a multi-sentence reasoning dump even if it dodges the keyword regex', () => {
    expect(isLeakedReasoningFollowUp(
      'Show me the best campgrounds. Then I can connect them to their goals.')).toBe(true);
  });
  it('rejects lines longer than 140 chars (paragraph dumps, not clickable suggestions)', () => {
    expect(isLeakedReasoningFollowUp('What are the best things to do in Parksville '.repeat(4)))
      .toBe(true);
  });
  it('rejects the reported second-person "You\'re Paul Cozzolino — based on your Calendly handle" leak (2026-07-08)', () => {
    expect(isLeakedReasoningFollowUp(
      "You're Paul Cozzolino — based on your Calendly handle (pcozz)")).toBe(true);
    expect(isLeakedReasoningFollowUp('You are interested in hiking')).toBe(true);
    expect(isLeakedReasoningFollowUp('Your profile suggests these topics')).toBe(true);
  });
  it('rejects the curly-apostrophe "You’re Paul Cozzolino" leak (2026-07-12)', () => {
    // The leading-meta regex matches `you'?re` with a STRAIGHT apostrophe only; the
    // reported leak used a curly ’ (U+2019) and slipped through to a live button.
    expect(isLeakedReasoningFollowUp(
      'You’re Paul Cozzolino — based on your Calendly handle (pcozz)')).toBe(true);
    expect(isLeakedReasoningFollowUp('I’ll follow the context and suggest topics')).toBe(true);
  });
  it('KEEPS genuine short user-perspective suggestions', () => {
    expect(isLeakedReasoningFollowUp('Show me the latest campgrounds near Comox')).toBe(false);
    expect(isLeakedReasoningFollowUp('What are the best things to do in Parksville?')).toBe(false);
    expect(isLeakedReasoningFollowUp('Compare the two options')).toBe(false);
  });
});

describe('isWebSearchMeaningful', () => {
  it('rejects content shorter than 200 chars', () => {
    expect(isWebSearchMeaningful('Short content')).toBe(false);
  });
  it('rejects boilerplate error pages', () => {
    const boilerplate = 'x'.repeat(250) + ' access denied cloudflare enable javascript unusual traffic something went wrong';
    expect(isWebSearchMeaningful(boilerplate)).toBe(false);
  });
  it('accepts real search results with diverse sentences', () => {
    const real = 'Search results for query. ' +
      'The first result shows that Tesla stock price rose 5% today after earnings beat estimates. ' +
      'Analysts predict continued growth through Q3. ' +
      'The market cap now exceeds $1 trillion for the first time in 2026. ' +
      'Investors are optimistic about the new Model 3 refresh launch.';
    expect(isWebSearchMeaningful(real)).toBe(true);
  });
});


// ── 2026-06-16: Tests for new pipeline-utils functions ──────────────────────────

describe('stripCanvasPreamble', () => {
  it('strips sentences that reference canvas below', () => {
    const text = "Here's the full corporate structure map. Open the canvas below for a complete view. The data includes all entities.";
    const result = stripCanvasPreamble(text);
    expect(result).not.toContain('canvas below');
    expect(result).toContain('corporate structure map');
    expect(result).toContain('data includes all entities');
  });
  it('strips "see the canvas" references', () => {
    const text = "I've prepared your report. See the canvas for the full document. It covers all sections.";
    const result = stripCanvasPreamble(text);
    expect(result).not.toContain('See the canvas');
    expect(result).toContain('prepared your report');
  });
  it('returns text unchanged when no canvas references present', () => {
    const text = "This is a normal response with no canvas mentions. It has multiple sentences. And more content here.";
    expect(stripCanvasPreamble(text)).toBe(text);
  });
  it('returns a neutral fallback when all sentences reference canvas (avoids broken promise)', () => {
    // 2026-06-29: when stripping every sentence would leave an empty string, the text
    // was ONLY a canvas promise with no canvas behind it. Returning it verbatim re-shows
    // the broken "open the canvas below" promise, so swap in a neutral, self-consistent
    // line instead of a blank bubble or a dangling pointer.
    const text = "Open the canvas below. Check the canvas for details.";
    const result = stripCanvasPreamble(text);
    expect(result).not.toMatch(/canvas/i);
    expect(result.length).toBeGreaterThan(0);
  });
  it('keeps the non-canvas lead-in sentence and drops only the canvas promise', () => {
    // The common real case: a useful sentence followed by a broken canvas promise.
    // The lead-in must survive; the promise must be stripped.
    const text = "Here is your document. Open the canvas below.";
    const result = stripCanvasPreamble(text);
    expect(result).toBe('Here is your document.');
    expect(result).not.toMatch(/canvas/i);
  });
});


describe('retryOnModelNotFound', () => {
  it('returns immediately on success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await retryOnModelNotFound(fn, 'test');
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws non-404 errors immediately without retry', async () => {
    const fn = jest.fn().mockRejectedValue({ message: 'rate limit exceeded', response: { status: 429 } });
    await expect(retryOnModelNotFound(fn, 'test', 2, 10)).rejects.toMatchObject({ message: 'rate limit exceeded' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 404 "model not found" errors', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ message: 'Model not found', response: { status: 404 } })
      .mockResolvedValueOnce('success after retry');
    const result = await retryOnModelNotFound(fn, 'test', 1, 50); // short delay for test
    expect(result).toBe('success after retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on "not deployed" errors', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce({ message: 'model inaccessible and/or not deployed' })
      .mockResolvedValueOnce('deployed now');
    const result = await retryOnModelNotFound(fn, 'test', 1, 50);
    expect(result).toBe('deployed now');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max retries exhausted', async () => {
    const fn = jest.fn().mockRejectedValue({ message: 'Model not found', response: { status: 404 } });
    await expect(retryOnModelNotFound(fn, 'test', 1, 50)).rejects.toMatchObject({ message: 'Model not found' });
    expect(fn).toHaveBeenCalledTimes(2); // initial + 1 retry
  });
});

describe('stripAnswerMarkup (ticket dc7fd17a — persisted transcript parts)', () => {
  it('removes a terminated [FOLLOWUPS] block and keeps the prose body', () => {
    expect(stripAnswerMarkup('Body text.\n\n[FOLLOWUPS]\n- Q one\n- Q two\n[/FOLLOWUPS]')).toBe('Body text.');
  });

  it('removes an unterminated [FOLLOWUPS] tail (truncated stream)', () => {
    expect(stripAnswerMarkup('Body text.\n\n[FOLLOWUPS]\n- Q one')).toBe('Body text.');
  });

  it('removes [CANVAS] regions — attributed and bare', () => {
    expect(stripAnswerMarkup('Intro.\n\n[CANVAS:type=document,title=Doc]\n# Hello\n[/CANVAS]\n\nOutro.')).toBe('Intro.\n\nOutro.');
    expect(stripAnswerMarkup('Intro.\n\n[CANVAS]\n# Hello\n[/CANVAS]\n\nOutro.')).toBe('Intro.\n\nOutro.');
  });

  it('preserves [SEND_EMAIL] drafts and ordinary prose byte-identical', () => {
    const t = 'Body.\n\n[SEND_EMAIL to="a@b.c"]\nHi there\n[/SEND_EMAIL]';
    expect(stripAnswerMarkup(t)).toBe(t);
  });

  it('handles the combined canvas+followups shape exactly like content-finalize', () => {
    const raw = 'Answer.\n\n[CANVAS:type=code,lang=ts]\nconst x = 1;\n[/CANVAS]\n\n[FOLLOWUPS]\n- Next?\n[/FOLLOWUPS]';
    expect(stripAnswerMarkup(raw)).toBe('Answer.');
  });

  it('passes markup-free text through unchanged', () => {
    const t = 'Plain prose with [brackets] and **markdown** — nothing structured.';
    expect(stripAnswerMarkup(t)).toBe(t);
  });
});

