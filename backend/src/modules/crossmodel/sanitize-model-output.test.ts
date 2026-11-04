/**
 * Tests for sanitize-model-output.ts — leaked tool-call markup stripping.
 * Includes the exact DSML leak observed in prod 2026-07-10 (DeepSeek V4 Pro
 * agentic loop, final turn with tools removed during a BrightData outage).
 */

import {
  containsToolCallLeak, stripToolCallMarkup, looksLikeAttemptedToolCall,
  stripAsciiXmlToolCalls, hasAsciiXmlToolCall, countAsciiXmlToolCalls, asciiXmlToolCallSignatures,
} from './sanitize-model-output';

// ── Ticket 7345b333 (2026-11-02) ─────────────────────────────────────────────
// The owner's chat UI showed ~50 near-identical copies of this, as ordinary
// message text, each followed by a "Used 1 tool" row:
//
//   <tool_call><function=todo_update><parameter=todoId>0946fc49</parameter>
//   <parameter=progressNote>Calendar-gated, NOT stalled: …</parameter></function></tool_call>
//
// Every detector was blind to it (no fullwidth bar, no `invoke name=`, and the
// block tag is `tool_call` SINGULAR where the old rule keyed on `tool_calls`
// PLURAL), and the stripper removed only the tags — stranding the argument
// payload as visible prose. Both halves are pinned below.
const XML_LEAK =
  '<tool_call><function=todo_update><parameter=todoId>0946fc49</parameter><parameter=progressNote>Calendar-gated, NOT stalled: close bar is Monday\'s measured school-day numbers</parameter></function></tool_call>';

describe('7345b333 — the inline ASCII-XML tool-call form', () => {
  test('the detector recognises the verbatim leaked block', () => {
    expect(hasAsciiXmlToolCall(XML_LEAK)).toBe(true);
    expect(containsToolCallLeak(XML_LEAK)).toBe(true);
    // The stricter gate matters most: it is what the coding loop's bounded
    // leak-retry keys on, so before this fix the loop never retried at all.
    expect(looksLikeAttemptedToolCall(XML_LEAK)).toBe(true);
  });

  test('stripping removes the ARGUMENT PAYLOAD too, not just the tags', () => {
    // The measured regression: tag-only stripping produced
    //   '0946fc49Calendar-gated, NOT stalled: close bar is …'
    // — an unreadable wall rather than an empty no-content turn.
    expect(stripToolCallMarkup(XML_LEAK)).toBe('');
    expect(stripAsciiXmlToolCalls(XML_LEAK)).toBe('');
    expect(stripToolCallMarkup(XML_LEAK)).not.toContain('0946fc49');
    expect(stripToolCallMarkup(XML_LEAK)).not.toContain('Calendar-gated');
  });

  test('a wall of ~50 copies collapses to nothing; surrounding prose survives', () => {
    const wall = Array.from({ length: 50 }, () => XML_LEAK).join('\n');
    expect(stripToolCallMarkup(wall)).toBe('');
    const mixed = `Here is the reconciled state.\n\n${wall}\n\nMonday's numbers close the row.`;
    const out = stripToolCallMarkup(mixed);
    expect(out).toContain('Here is the reconciled state.');
    expect(out).toContain("Monday's numbers close the row.");
    expect(out).not.toContain('tool_call');
    expect(out).not.toContain('0946fc49');
  });

  test('a SEVERED stream (opener, no closer) is removed to end-of-text', () => {
    const severed = 'Report.\n<tool_call><function=todo_update><parameter=todoId>0946fc49</parameter><parameter=progressNote>partial str';
    const out = stripToolCallMarkup(severed);
    expect(out).toBe('Report.');
    expect(out).not.toContain('0946fc49');
  });

  test('a bare <function=…> element without its tool_call wrapper is removed', () => {
    expect(stripToolCallMarkup('<function=todo_update>0946fc49</function>')).toBe('');
    expect(stripToolCallMarkup('<parameter=todoId>0946fc49</parameter>')).toBe('');
  });

  test('an answer that ILLUSTRATES the markup in a fenced block is never convicted', () => {
    const doc = `The leak looked like this:\n\`\`\`\n${XML_LEAK}\n\`\`\`\nThat is what reached the UI.`;
    expect(hasAsciiXmlToolCall(doc)).toBe(false);
    expect(countAsciiXmlToolCalls(doc)).toBe(0);
    expect(asciiXmlToolCallSignatures(doc)).toEqual([]);
  });

  test('counts and signatures drive the loop guard', () => {
    expect(countAsciiXmlToolCalls(XML_LEAK)).toBe(1);
    expect(countAsciiXmlToolCalls(`${XML_LEAK}${XML_LEAK}`)).toBe(2);
    expect(countAsciiXmlToolCalls('no markup here')).toBe(0);
    // Digit-collapsed: a renumbered copy shares the signature, so a slightly
    // reworded/renumbered echo still counts as the SAME call.
    const renumbered = XML_LEAK.replace('0946fc49', '11112222').replace("Monday's", "Tuesday's");
    expect(asciiXmlToolCallSignatures(renumbered)[0]).not.toContain('0946fc49');
    expect(asciiXmlToolCallSignatures(XML_LEAK)[0].startsWith('todo_update:')).toBe(true);
  });

  test('REGRESSION (adversarial review): a BARE mention never truncates the answer tail', () => {
    // The first cut had an unconditional `[\s\S]*$` dangling rule: one inline
    // mention of the tag silently deleted the entire rest of the answer.
    // (The bare TAG itself has always been removed by the pre-existing rule 3 —
    // that is cosmetic. What must survive is the PROSE AFTER it.)
    const mention = 'I saw <tool_call> in the log and it was bad. Everything after is still my answer.';
    const out = stripToolCallMarkup(mention);
    expect(out).toContain('Everything after is still my answer.');  // the regression
    expect(out).toContain('in the log and it was bad.');            // the sentence too
    expect(hasAsciiXmlToolCall(mention)).toBe(false);               // never convicted as a call
    expect(countAsciiXmlToolCalls(mention)).toBe(0);
    // …while a genuinely SEVERED call (opener + argument child, never closed)
    // is still cut, payload and all.
    expect(stripToolCallMarkup('Report.\n<tool_call><function=todo_update><parameter=todoId>0946fc49')).toBe('Report.');
  });

  test('REGRESSION (adversarial review): a fenced illustration is not eaten by the XML pass', () => {
    // The XML block rules are fence-aware; the fence is re-emitted verbatim.
    const fenced = `Config:\n\n\`\`\`\n${XML_LEAK}\n\`\`\`\n\nThat is how it works.`;
    const out = stripAsciiXmlToolCalls(fenced);
    expect(out).toContain(XML_LEAK);          // the ASCII-XML pass leaves it whole
    expect(out).toContain('That is how it works.');
    expect(hasAsciiXmlToolCall(fenced)).toBe(false);
    expect(countAsciiXmlToolCalls(fenced)).toBe(0);
  });

  test('REGRESSION (adversarial review): a docs answer mentioning the tag 8× never trips the volume leg', () => {
    // countAsciiXmlToolCalls counts CALLS, not mentions — 8 bare mentions of the
    // tag in one legitimate answer must count 0, or the loop guard would end a
    // real run for discussing the very markup this ticket is about.
    const docs = Array.from({ length: 8 }, () => 'The <tool_call> tag has no closer in this sentence.').join('\n');
    expect(countAsciiXmlToolCalls(docs)).toBe(0);
    expect(hasAsciiXmlToolCall(docs)).toBe(false);
    // A real wall still counts.
    expect(countAsciiXmlToolCalls(Array.from({ length: 8 }, () => XML_LEAK).join('\n'))).toBe(8);
  });

  test('ordinary prose and simple HTML are untouched', () => {
    for (const s of [
      'The answer is 42 and <b>bold</b> is fine.',
      'A tool_call element has no closing tag in this sentence.',
    ]) {
      expect(stripToolCallMarkup(s)).toBe(s.trim());
      expect(hasAsciiXmlToolCall(s)).toBe(false);
    }
    // A bare `<parameter>` tag was already stripped by the PRE-EXISTING tag rule
    // (rule 3 keys on tool_calls|tool_call|invoke|parameter) — unchanged here.
    // What matters for this ticket is that prose NAMING the form is never
    // convicted as a leak, so the retry/loop guards never misfire on it.
    const naming = 'Use <parameter> as the tag name in your template.';
    expect(hasAsciiXmlToolCall(naming)).toBe(false);
    expect(countAsciiXmlToolCalls(naming)).toBe(0);
  });
});

// Verbatim shape from the 2026-07-10 prod screenshot (fullwidth ｜ delimiters)
const PROD_DSML_LEAK =
  '<｜DSML｜tool_calls> <｜DSML｜invoke name="search_engine"> <｜DSML｜parameter name="query" string="true">AI news July 10 2026 OpenAI Google Anthropic</｜DSML｜parameter> </｜DSML｜invoke> <｜DSML｜invoke name="search_engine"> <｜DSML｜parameter name="query" string="true">"July 10, 2026" AI news today</｜DSML｜parameter> </｜DSML｜invoke> </｜DSML｜tool_calls>';

describe('containsToolCallLeak', () => {
  test('detects the prod DSML leak', () => {
    expect(containsToolCallLeak(PROD_DSML_LEAK)).toBe(true);
  });
  test('detects native begin/end token form', () => {
    expect(containsToolCallLeak('<｜tool▁calls▁begin｜>x<｜tool▁calls▁end｜>')).toBe(true);
  });
  test('clean prose passes', () => {
    expect(containsToolCallLeak('Here are the top AI headlines for July 10, 2026.')).toBe(false);
  });
});

describe('stripToolCallMarkup', () => {
  test('pure-markup response strips to empty (graceful no-content path)', () => {
    expect(stripToolCallMarkup(PROD_DSML_LEAK)).toBe('');
  });

  test('markup embedded in prose leaves the prose', () => {
    const mixed = `Here is what I found.\n\n${PROD_DSML_LEAK}\n\nOpenAI shipped GPT-5.6 today.`;
    const out = stripToolCallMarkup(mixed);
    expect(out).toContain('Here is what I found.');
    expect(out).toContain('OpenAI shipped GPT-5.6 today.');
    expect(out).not.toContain('DSML');
    expect(out).not.toContain('｜');
  });

  test('unclosed/partial stream leak is still removed', () => {
    const partial = '<｜DSML｜tool_calls> <｜DSML｜invoke name="search_engine"> <｜DSML｜parameter name="query"';
    const out = stripToolCallMarkup(partial);
    expect(out).not.toContain('DSML');
    expect(out).not.toContain('tool_calls');
  });

  test('GLM <think> blocks are untouched', () => {
    const think = '<think>reasoning here</think>\nThe answer is 42.';
    expect(stripToolCallMarkup(think)).toBe(think.trim());
  });

  test('clean prose is returned unchanged', () => {
    const prose = 'Top stories: OpenAI debuts GPT-5.6; Meta ships its AI chip in September.';
    expect(stripToolCallMarkup(prose)).toBe(prose);
  });
});

describe('looksLikeAttemptedToolCall (strict — gates the coding leak-retry)', () => {
  test('fires on an invoke element emitted as plain text', () => {
    expect(looksLikeAttemptedToolCall('<｜｜DSML｜｜invoke name="edit_file">…</invoke>')).toBe(true);
    expect(looksLikeAttemptedToolCall('<invoke name="write_file">')).toBe(true);
  });

  test('fires on a native begin-token block', () => {
    expect(looksLikeAttemptedToolCall('<｜tool▁calls▁begin｜>read_file<｜tool▁calls▁end｜>')).toBe(true);
  });

  test('does NOT fire on an honest answer that quotes tool-call markup', () => {
    // The adversarial-review regression: answering questions about the sanitizer.
    expect(looksLikeAttemptedToolCall('The parser strips a leaked </tool_calls> tag from the stream.')).toBe(false);
    expect(looksLikeAttemptedToolCall('Use the fullwidth bar ｜ as the delimiter between fields.')).toBe(false);
    expect(looksLikeAttemptedToolCall('All three download figures were updated in the README.')).toBe(false);
    expect(looksLikeAttemptedToolCall('')).toBe(false);
  });
});
