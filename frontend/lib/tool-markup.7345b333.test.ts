/**
 * Ticket 7345b333 — render-time removal of leaked tool-call markup.
 *
 * The owner's Fleet Supervisor chat displayed ~50 near-identical copies of the
 * verbatim block below as ordinary message text, each followed by a
 * "Used 1 tool" row: "why am i seeing all of this horrible looking text in the
 * chat ui ?". Rows persisted before the source-side fix shipped still hold it,
 * so the transcript renderer strips it on the way out (display transform only —
 * stored content is never modified).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { hasRenderableToolMarkup, stripToolMarkupForRender } from './tool-markup';
import { CodeTranscriptMarkdown } from '@/app/crossmodel/components/code-transcript';

/** The verbatim shape from the owner's transcript (ticket 7345b333). */
const LEAK =
  '<tool_call><function=todo_update><parameter=todoId>0946fc49</parameter>'
  + "<parameter=progressNote>Calendar-gated, NOT stalled: close bar is Monday's measured school-day numbers</parameter>"
  + '</function></tool_call>';

describe('7345b333 — stripToolMarkupForRender', () => {
  it('removes the element AND its argument payload, not just the tags', () => {
    // The pre-fix behaviour stranded the payload as prose:
    //   '0946fc49Calendar-gated, NOT stalled: close bar is …'
    const out = stripToolMarkupForRender(LEAK);
    expect(out).toBe('');
    expect(out).not.toContain('0946fc49');
    expect(out).not.toContain('Calendar-gated');
  });

  it('collapses a wall of ~50 copies to nothing and keeps surrounding prose', () => {
    const wall = Array.from({ length: 50 }, () => LEAK).join('\n');
    const row = `Here is the reconciled state.\n\n${wall}\n\nMonday's numbers close the row.`;
    const out = stripToolMarkupForRender(row);
    expect(out).toContain('Here is the reconciled state.');
    expect(out).toContain("Monday's numbers close the row.");
    expect(out).not.toContain('tool_call');
    expect(out).not.toContain('<parameter=');
    // No blank-line ridge where the wall used to be.
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('preserves a FENCED illustration byte-identically (a run that quotes the markup)', () => {
    const doc = `The leak looked like this:\n\`\`\`\n${LEAK}\n\`\`\`\nThat is what reached the UI.`;
    const out = stripToolMarkupForRender(doc);
    expect(out).toContain(LEAK);
    expect(out).toContain('That is what reached the UI.');
  });

  it('is idempotent and leaves clean rows byte-identical', () => {
    const clean = 'Nothing needs your attention today.';
    expect(stripToolMarkupForRender(clean)).toBe(clean);
    const once = stripToolMarkupForRender(`${LEAK}\nDone.`);
    expect(stripToolMarkupForRender(once)).toBe(once);
  });

  it('does not touch ordinary prose or simple HTML', () => {
    for (const s of ['The answer is 42 and <b>bold</b> is fine.', 'A <div> block is not a tool call.']) {
      expect(stripToolMarkupForRender(s)).toBe(s);
      expect(hasRenderableToolMarkup(s)).toBe(false);
    }
  });

  it('REGRESSION (adversarial review): a BARE mention never truncates the answer tail', () => {
    // The first cut of this leaf had an unconditional `[\s\S]*$` dangling rule:
    // one inline mention silently deleted the entire rest of the answer.
    const mention = 'I saw <tool_call> in the log and it was bad. Everything after is still my answer.';
    expect(stripToolMarkupForRender(mention)).toBe(mention);
    expect(hasRenderableToolMarkup(mention)).toBe(false);
    const withTail = 'The marker <tool_call> appeared.\n\nEverything after is still my answer, with detail.';
    expect(stripToolMarkupForRender(withTail)).toContain('Everything after is still my answer');
  });

  it('REGRESSION (adversarial review): a fenced illustration survives intact, even with blank lines', () => {
    // The first cut collapsed whitespace AFTER unmasking, so a fence's own
    // blank lines were rewritten and a spanning block regex could delete it.
    const body = 'a = 1\n\n\n\nb = 2   \n';
    const doc = `Here is the config:\n\n\`\`\`\n${body}\`\`\`\n\n${LEAK}\n\nThat is how it works.`;
    const out = stripToolMarkupForRender(doc);
    expect(out).toContain(`\`\`\`\n${body}\`\`\``); // fence body byte-identical
    expect(out).not.toContain('0946fc49');            // the real wall is gone
    expect(out).toContain('That is how it works.');
  });

  it('REGRESSION (adversarial review): an UNTERMINATED fence is preserved', () => {
    const doc = `Text\n\`\`\`\nPRECIOUS CODE\n\n\n  y  `;
    expect(stripToolMarkupForRender(doc)).toBe(doc);
  });

  it('handles a severed stream (opener, no closer)', () => {
    expect(stripToolMarkupForRender('Report.\n<tool_call><function=todo_update><parameter=todoId>0946fc49')).toBe('Report.');
  });
});

describe('7345b333 — the transcript renderer shows no raw markup', () => {
  it('an assistant row carrying the wall renders without angle-bracket noise', () => {
    const wall = Array.from({ length: 10 }, () => LEAK).join('\n');
    const html = renderToStaticMarkup(
      createElement(CodeTranscriptMarkdown, { text: `Reconciled the row.\n\n${wall}` }),
    );
    expect(html).toContain('Reconciled the row.');
    expect(html).not.toContain('&lt;tool_call&gt;');
    expect(html).not.toContain('<parameter=');
    expect(html).not.toContain('0946fc49');
  });
});