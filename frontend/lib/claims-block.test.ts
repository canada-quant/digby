/**
 * Ticket 295068fa — pins for the claims-manifest split (see claims-block.ts):
 * the ```claims fence is harness plumbing and collapses into a chip wherever
 * it sits (backend parity: LAST fence wins); with several fences the earlier
 * ones are the model quoting the format and stay visible.
 */

import { describe, expect, it } from 'vitest';
import { splitTrailingClaimsBlock, parseClaimsEntries } from './claims-block';

const CLAIMS = '```claims\n[{"type":"pr","ref":"3"},{"type":"push","ref":"abc"}]\n```';

describe('295068fa — splitTrailingClaimsBlock', () => {
  it('splits a trailing claims fence off the visible text', () => {
    const out = splitTrailingClaimsBlock(`Final report — all done.\n\nDetails.\n\n${CLAIMS}`);
    expect(out.clean).toBe('Final report — all done.\n\nDetails.');
    expect(out.claimsJson).toBe('[{"type":"pr","ref":"3"},{"type":"push","ref":"abc"}]');
    expect(out.entryCount).toBe(2);
  });

  it('tolerates trailing whitespace after the closing fence', () => {
    const out = splitTrailingClaimsBlock(`Report.\n${CLAIMS}\n  \n`);
    expect(out.clean).toBe('Report.');
    expect(out.entryCount).toBe(2);
  });

  it('a single mid-text manifest followed by prose collapses too (owner 2026-09-18 — it rendered raw); prose on both sides stays', () => {
    const text = `The contract looks like this:\n\n${CLAIMS}\n\nand that is how receipts are verified.`;
    const out = splitTrailingClaimsBlock(text);
    expect(out.clean).toBe('The contract looks like this:\n\nand that is how receipts are verified.');
    expect(out.claimsJson).toBe('[{"type":"pr","ref":"3"},{"type":"push","ref":"abc"}]');
    expect(out.entryCount).toBe(2);
  });

  it('owner screenshot 2026-09-18: the closing fence GLUED to the next sentence closes the fence and the sentence rejoins the prose', () => {
    // "```Step 8's verification is done — …" is not a markdown closer (a
    // closing fence may carry no text), so the raw code block swallowed the
    // rest of the message and rendered as a "CLAIMS" box with two lines.
    const text =
      'Progress so far.\n\n```claims\n[{"type":"file_change","ref":"1a4a218","note":"cuda-compat + pip-stall learnings"}]\n' +
      "```Step 8's verification is done — remaining: a quick throughput sanity check.";
    const out = splitTrailingClaimsBlock(text);
    expect(out.claimsJson).toBe('[{"type":"file_change","ref":"1a4a218","note":"cuda-compat + pip-stall learnings"}]');
    expect(out.entryCount).toBe(1);
    expect(out.clean).toBe("Progress so far.\n\nStep 8's verification is done — remaining: a quick throughput sanity check.");
  });

  it('an UNTERMINATED fence runs to the end of the text (CommonMark) — a manifest still streaming in collapses', () => {
    const out = splitTrailingClaimsBlock('Report.\n```claims\n[{"type":"pr","ref":"3"}');
    expect(out.clean).toBe('Report.');
    expect(out.claimsJson).toBe('[{"type":"pr","ref":"3"}');
    expect(out.entryCount).toBe(0);
  });

  it('a manifest followed by more prose AND a later footer-like paragraph keeps everything after it', () => {
    const text = `Report.\n\n${CLAIMS}\n\nNext: re-run the smoke.\n\nThen: ship.`;
    const out = splitTrailingClaimsBlock(text);
    expect(out.clean).toBe('Report.\n\nNext: re-run the smoke.\n\nThen: ship.');
  });

  it('an indented closer (≤ any indent) still closes; a fence tag with trailing spaces still opens', () => {
    const out = splitTrailingClaimsBlock('Report.\n```claims   \n[{"type":"pr","ref":"3"}]\n   ```\nAfter.');
    expect(out.claimsJson).toBe('[{"type":"pr","ref":"3"}]');
    expect(out.clean).toBe('Report.\n\nAfter.');
  });

  it('```claimsx or an inline mention of ```claims is NOT a fence', () => {
    const t1 = 'Report.\n```claimsx\n[]\n```';
    expect(splitTrailingClaimsBlock(t1).claimsJson).toBeNull();
    const t2 = 'Write a ```claims fence at the end.';
    expect(splitTrailingClaimsBlock(t2).claimsJson).toBeNull();
    expect(splitTrailingClaimsBlock(t2).clean).toBe(t2);
  });

  it('LAST fence wins (review B1): a quoted block mid-text + a trailing manifest keeps the intervening prose visible', () => {
    // The backend's canonical parser documents "LAST fenced block wins"
    // (backend/.../coding/claims-block.ts) — the UI split must agree, or a
    // leftmost match swallows the prose between the two fences into the chip.
    const text = `Report A.\n\`\`\`claims\n[{"type":"pr","ref":"1"}]\n\`\`\`\nWait, correction: not merged yet.\n\`\`\`claims\n[{"type":"pr","ref":"2"}]\n\`\`\``;
    const out = splitTrailingClaimsBlock(text);
    expect(out.clean).toContain('Wait, correction: not merged yet.');
    expect(out.clean).toContain('Report A.');
    expect(out.clean).toContain('```claims'); // the quoted mid-text block stays
    expect(out.claimsJson).toBe('[{"type":"pr","ref":"2"}]');
    expect(out.entryCount).toBe(1);
  });

  it('a trailing claims fence with unparseable JSON still collapses (count 0)', () => {
    const out = splitTrailingClaimsBlock('Report.\n```claims\nnot json\n```');
    expect(out.clean).toBe('Report.');
    expect(out.claimsJson).toBe('not json');
    expect(out.entryCount).toBe(0);
  });

  it('ordinary text and other fenced blocks pass through untouched', () => {
    expect(splitTrailingClaimsBlock('hello').claimsJson).toBeNull();
    const code = 'Here:\n```json\n{"a":1}\n```';
    expect(splitTrailingClaimsBlock(code).clean).toBe(code);
  });
});

describe('two-line opener (owner screenshot 2026-09-25 — "i thought we fixed this")', () => {
  const TWO_LINE = 'Honest caveats: (e) PR #2 is open and unmerged — merge via the PR when ready.\n\n```\nclaims\n[{"type":"push","ref":"af08e94b1cc3e85961bf4da0532f301283d8d988"},{"type":"pr","ref":"2"}]\n```';
  it('a bare ``` line followed by `claims` on the next line is the manifest — split off, entries counted', () => {
    const out = splitTrailingClaimsBlock(TWO_LINE);
    expect(out.clean).toBe('Honest caveats: (e) PR #2 is open and unmerged — merge via the PR when ready.');
    expect(out.claimsJson).toBe('[{"type":"push","ref":"af08e94b1cc3e85961bf4da0532f301283d8d988"},{"type":"pr","ref":"2"}]');
    expect(out.entryCount).toBe(2);
  });
  it('a bare ``` block whose first line is not `claims` stays visible as an ordinary code block', () => {
    const code = 'Run this:\n```\nnpm test\n```';
    expect(splitTrailingClaimsBlock(code).claimsJson).toBeNull();
    expect(splitTrailingClaimsBlock(code).clean).toBe(code);
    const almost = 'x\n```\nclaims and more\n[]\n```';
    expect(splitTrailingClaimsBlock(almost).claimsJson).toBeNull();
  });
});

describe('parseClaimsEntries (VerificationFooter chips, 2026-09-14)', () => {
  it('lists {type, ref} entries; numeric refs are stringified', () => {
    expect(parseClaimsEntries('[{"type":"pr","ref":134},{"type":"push","ref":"abc"}]')).toEqual([
      { type: 'pr', ref: '134' }, { type: 'push', ref: 'abc' },
    ]);
  });

  it('is tolerant: non-arrays, non-objects and garbage yield [] / skipped entries — never throws', () => {
    expect(parseClaimsEntries('not json')).toEqual([]);
    expect(parseClaimsEntries('{"type":"pr"}')).toEqual([]);
    expect(parseClaimsEntries('[1, null, {"type":"deploy"}]')).toEqual([{ type: 'deploy' }]);
    expect(parseClaimsEntries(null)).toEqual([]);
  });
});
