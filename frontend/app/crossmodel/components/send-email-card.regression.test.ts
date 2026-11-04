import { describe, it, expect } from 'vitest';
import { parseEmailDraft, extractEmailFromParts } from './code-transcript';

// Exact marker from prod chat 9daaa10b (2026-10-16): cc=, em dash in subject.
const MARKER = '[SEND_EMAIL to="zachary.seddon@hyperstack.cloud" cc="billing@nexgencloud.com" subject="Re: Hyperstack Cloud - CQL — billing terms (credit vs daily prepay)"]\nHi Zac,\n\nQuick billing ask.\n\nThanks,\nPaul\n[/SEND_EMAIL]';
const TEXT = `He's your guy. Draft for you:\n\n${MARKER}\n\nHere's the draft — tap Send to deliver it, or Edit to make changes.`;

describe('SEND_EMAIL card regression (2026-10-16)', () => {
  it('parseEmailDraft handles cc + em dash subject', () => {
    const { cleanText, emailDraft } = parseEmailDraft(TEXT);
    expect(emailDraft).toEqual({
      to: 'zachary.seddon@hyperstack.cloud',
      cc: 'billing@nexgencloud.com',
      subject: 'Re: Hyperstack Cloud - CQL — billing terms (credit vs daily prepay)',
      body: 'Hi Zac,\n\nQuick billing ask.\n\nThanks,\nPaul',
    });
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/);
    expect(cleanText).toContain("He's your guy");
    expect(cleanText).toContain('tap Send');
  });

  it('parts-bearing answers: strips the block from text parts and returns the draft', () => {
    const parts = [{ type: 'tool_call', name: 'gmail_search' }, { type: 'text', text: TEXT }];
    const out = extractEmailFromParts(parts, TEXT);
    expect(out.emailDraft?.cc).toBe('billing@nexgencloud.com');
    expect(out.parts).toHaveLength(2);
    expect(JSON.stringify(out.parts)).not.toMatch(/\[\/?SEND_EMAIL/);
    expect(out.parts[0]).toEqual(parts[0]);
  });

  it('block split across text parts still yields a card and no leftover marker text', () => {
    const [a, b] = [TEXT.slice(0, 60), TEXT.slice(60)];
    const out = extractEmailFromParts([{ type: 'text', text: a }, { type: 'text', text: b }], TEXT);
    expect(out.emailDraft?.to).toBe('zachary.seddon@hyperstack.cloud');
    const shown = JSON.stringify(out.parts);
    expect(shown).not.toMatch(/\[\/?SEND_EMAIL/);
    expect(shown).toContain("He's your guy");
    expect(shown).toContain('tap Send');
  });

  it('no marker → parts untouched, no card', () => {
    const parts = [{ type: 'text', text: 'hello' }];
    expect(extractEmailFromParts(parts, 'hello').parts).toBe(parts);
    expect(extractEmailFromParts(parts, 'hello').emailDraft).toBeNull();
  });

  // ── Ticket 8d7d07b0 (raw-marker:SEND_EMAIL, reason 'unclosed') ──────────
  // Live specimen (message 13e821e0, chat 77f8bacb, 2026-10-19T17:37Z): a
  // CLOSED block whose to= value is a bracketed placeholder —
  //   [SEND_EMAIL to="[recipient — see my note below]" subject="…"]body[/SEND_EMAIL]
  // The quote-blind attrs scan truncated at the placeholder's `]`, no usable
  // `to` survived, and the no-draft paths returned the RAW text/parts — so
  // the raw marker rendered on reload although stripLiveTags had hidden the
  // same block live. The tag scan is now quote-aware and the cleanText
  // contract (markup removed on EVERY path) holds.
  const PLACEHOLDER_TO = '[SEND_EMAIL to="[recipient — see my note below]" subject="Quick note"]\nHi — quick ask.\n\nThanks,\nRenata\n[/SEND_EMAIL]';

  it('8d7d07b0: the placeholder-to specimen yields an EDITABLE card (quote-aware attrs) and no raw markup', () => {
    const text = `Here's the revised, sendable draft:\n\n${PLACEHOLDER_TO}\n\nTap Send to deliver it.`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).not.toBeNull();
    expect(emailDraft?.to).toBe('[recipient — see my note below]'); // editable, not lost
    expect(emailDraft?.subject).toBe('Quick note');
    expect(emailDraft?.body).toContain('Hi — quick ask.');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i); // no raw markup anywhere
    expect(cleanText).toContain('Here\'s the revised, sendable draft');
    expect(cleanText).toContain('Tap Send to deliver it');
  });

  it('8d7d07b0 review N2: a bracketed subject no longer loses a valid draft — the card renders', () => {
    const text = 'Draft:\n\n[SEND_EMAIL subject="Re: [Action required]" to="a@b.c"]Hi Zac[/SEND_EMAIL]\n\nTap Send.';
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft?.to).toBe('a@b.c');
    expect(emailDraft?.subject).toBe('Re: [Action required]');
    expect(emailDraft?.body).toBe('Hi Zac');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('Tap Send.');
  });

  it('8d7d07b0: an unclosed opener strips from cleanText (no card, no raw marker)', () => {
    const { cleanText, emailDraft } = parseEmailDraft('Preamble.\n\n[SEND_EMAIL to="a@b.c"\nmore tail');
    expect(emailDraft).toBeNull();
    expect(cleanText).toBe('Preamble.');
  });

  it('8d7d07b0: a stray closer next to real prose strips ONLY the token — prose stays (review N1)', () => {
    const { cleanText, emailDraft } = parseEmailDraft('Body text.\n\n[/SEND_EMAIL]');
    expect(emailDraft).toBeNull();
    expect(cleanText).toBe('Body text.');
  });

  it('8d7d07b0 review N1: a parts message with only a stray closer keeps its prose — no part is erased', () => {
    const parts = [{ type: 'text', text: 'Body text.\n\n[/SEND_EMAIL]' }];
    const out = extractEmailFromParts(parts, undefined);
    expect(out.emailDraft).toBeNull();
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0].text).toBe('Body text.');
  });

  it('8d7d07b0 review N1 (multi-part): a trailing-part closer deletes only the token, not the prose', () => {
    const parts = [
      { type: 'text', text: 'Answer part one.' },
      { type: 'text', text: 'Answer part two.\n[/SEND_EMAIL]' },
    ];
    const out = extractEmailFromParts(parts, undefined);
    expect(out.emailDraft).toBeNull();
    expect(out.parts.map((p: any) => p.text)).toEqual(['Answer part one.', 'Answer part two.']);
  });

  it('8d7d07b0: parts path — a no-card block keeps its BODY as prose; only the tags are cut', () => {
    // No usable to= anywhere → no card; the body is real content and survives.
    const parts = [{ type: 'tool_call', name: 'gmail_search' }, { type: 'text', text: `Intro line.\n\n[SEND_EMAIL subject="no recipient"]Dear team, here is the ask.[/SEND_EMAIL]\n\nOutro line.` }];
    const out = extractEmailFromParts(parts, undefined);
    expect(out.emailDraft).toBeNull();
    const shown = JSON.stringify(out.parts);
    expect(shown).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(shown).toContain('Intro line.');
    expect(shown).toContain('Dear team, here is the ask.'); // body survives as prose
    expect(shown).toContain('Outro line.');
    expect(out.parts[0]).toEqual(parts[0]);
  });

  it('8d7d07b0 review N4: a marker elsewhere does not normalize a marker-free part', () => {
    const parts = [
      { type: 'text', text: '[SEND_EMAIL subject="x"]body[/SEND_EMAIL]' },
      { type: 'text', text: 'A\n\n\n\nB' },
    ];
    const out = extractEmailFromParts(parts, undefined);
    const untouched = out.parts.find((p: any) => p.text === 'A\n\n\n\nB');
    expect(untouched).toBeDefined(); // whitespace NOT collapsed — bytes kept
  });

  it('8d7d07b0: a no-marker parts array keeps the same array reference (even when content alone has a draft)', () => {
    const parts: Array<{ type: string; text?: string }> = [{ type: 'text', text: 'plain' }];
    const out = extractEmailFromParts(parts, 'plain');
    expect(out.parts).toBe(parts);
    expect(out.emailDraft).toBeNull();
    const withContentDraft = extractEmailFromParts(parts, 'text [SEND_EMAIL to="a@b.c"]x[/SEND_EMAIL]');
    expect(withContentDraft.parts).toBe(parts); // parts render from parts
    expect(withContentDraft.emailDraft?.to).toBe('a@b.c'); // card still shows
  });

  it('8d7d07b0 review N3: a marker MENTION keeps its surrounding sentence (only the tag is cut)', () => {
    const { cleanText } = parseEmailDraft('What does [send_email] do?\n\nIt sends mail.');
    expect(cleanText).toBe('What does  do?\n\nIt sends mail.');
  });

  it('8d7d07b0 review N3: a fenced demo block keeps its fence shape (tags cut, fence intact)', () => {
    const { cleanText } = parseEmailDraft('Example:\n```\n[SEND_EMAIL to="[x]"]Hi[/SEND_EMAIL]\n```\nDone.');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('```');
    expect(cleanText).toContain('Example:');
  });

  it('8d7d07b0: marker-free text is byte-identical (no whitespace normalization)', () => {
    expect(parseEmailDraft('line1\n\n\n\nline2   ').cleanText).toBe('line1\n\n\n\nline2   ');
  });

  // ── Round-2 review (D1/D2/D3): prose-deletion and mention-mangling shapes ──

  it('8d7d07b0 review D1a: an earlier no-card block survives when the content draft anchors the cut', () => {
    const partsText = 'No recipient version: [SEND_EMAIL subject="x"]Dear team[/SEND_EMAIL]\n\nFinal:\n\n[SEND_EMAIL to="a@b.c"]Hi Zac';
    const content = `${partsText}[/SEND_EMAIL]`;
    const out = extractEmailFromParts([{ type: 'text', text: partsText }], content);
    expect(out.emailDraft?.to).toBe('a@b.c'); // card from content
    const shown = JSON.stringify(out.parts);
    expect(shown).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(shown).toContain('No recipient version:');
    expect(shown).toContain('Dear team'); // the earlier block's BODY stays
    expect(shown).toContain('Final:'); // prose between blocks stays
  });

  it('8d7d07b0 review D1b: a fenced demo before the content draft survives (no dangling fence)', () => {
    const partsText = 'Example:\n```\n[SEND_EMAIL subject="x"]demo[/SEND_EMAIL]\n```\n\nDraft:\n\n[SEND_EMAIL to="a@b.c"]Hi Zac';
    const content = `${partsText}[/SEND_EMAIL]`;
    const out = extractEmailFromParts([{ type: 'text', text: partsText }], content);
    expect(out.emailDraft?.to).toBe('a@b.c');
    const text = out.parts.map((p: any) => p.text || '').join('');
    expect((text.match(/```/g) || []).length).toBe(2); // both fences intact
    expect(text).toContain('demo'); // fenced body stays
    expect(text).toContain('Draft:');
  });

  it('8d7d07b0 review D2: a markdown link whose label is send_email keeps its label', () => {
    const { cleanText } = parseEmailDraft('See [send_email docs](https://x/send_email).\n\n\n\nEnd.');
    expect(cleanText).toContain('[send_email docs](https://x/send_email)');
    // and is NOT whitespace-normalized (no cuts → byte-identical)
    expect(cleanText).toBe('See [send_email docs](https://x/send_email).\n\n\n\nEnd.');
  });

  it('8d7d07b0 review D2: prose/code mentioning send_email is byte-identical', () => {
    const text = 'Run:\n\n```\nconst x = 1;\n\n\n\nsend_email(x)\n```\n\nDone.';
    expect(parseEmailDraft(text).cleanText).toBe(text);
  });

  it('8d7d07b0 review D3: an opener with a bare [ inside does not swallow prose to a later ]', () => {
    const { cleanText, emailDraft } = parseEmailDraft('Preamble.\n\n[SEND_EMAIL to="a@b.c"\nLook at [this] note.\n\nOutro.');
    expect(emailDraft).toBeNull();
    // The opener is a truncated streaming block (neither bounded scan closes
    // the tag): cut to end-of-text — exactly what stripLiveTags hides live.
    // The load-bearing assertion: no raw [SEND_EMAIL shows.
    expect(cleanText).not.toMatch(/\[send_email/i);
    expect(cleanText).toContain('Preamble.');
  });

  // ── Round-3 review (N1 / D1-r1 / D2 residual): final-engine shapes ──

  it('8d7d07b0 round-3 N1: a REAL tag followed by ( is still cut — no raw-markup leak', () => {
    const { cleanText, emailDraft } = parseEmailDraft('[SEND_EMAIL to="a@b.c"](confirm first) body prose here');
    expect(emailDraft).toBeNull();
    expect(cleanText).not.toMatch(/\[send_email/i); // the tag is gone
    expect(cleanText).toContain('(confirm first) body prose here'); // body stays
  });

  it('8d7d07b0 round-3 D2 residual: a link label before a real draft does not eat the draft', () => {
    const text = 'See [send_email docs](https://x/send_email) for how.\n\n[SEND_EMAIL to="x@y.z"]Dear team[/SEND_EMAIL]';
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft?.to).toBe('x@y.z'); // the card still parses
    expect(emailDraft?.body).toBe('Dear team');
    expect(cleanText).toContain('[send_email docs](https://x/send_email)'); // label intact
    expect(cleanText).not.toContain('[SEND_EMAIL to='); // the real tag is cut
    expect(cleanText).not.toContain('[/SEND_EMAIL]'); // the closer is cut
    expect(cleanText).not.toContain('Dear team'); // body lives in the card, not duplicated
  });

  it('8d7d07b0 round-3 D1-r1: two unclosed openers — the card body is not shown twice', () => {
    const partsText = 'Hi [SEND_EMAIL to="a@b.c"]draft body\n\nExample: [SEND_EMAIL subject="x"]demo';
    const content = `${partsText}[/SEND_EMAIL]`;
    const out = extractEmailFromParts([{ type: 'text', text: partsText }], content);
    expect(out.emailDraft?.to).toBe('a@b.c');
    const shown = JSON.stringify(out.parts);
    expect(shown).not.toMatch(/\[send_email/i.test(shown) ? /\[send_email/i : /\[send_email/i); // no raw marker
    expect(shown).not.toContain('draft body'); // not duplicated as prose
    expect(shown).toContain('Hi');
  });

  it('8d7d07b0 round-3 D1-r2: all-complete blocks in parts → no truncation cut, bodies kept', () => {
    const partsText = 'Note: [SEND_EMAIL subject="x"]keep me[/SEND_EMAIL]\n\nOutro prose.';
    const content = 'Draft:\n[SEND_EMAIL to="a@b.c"]Hi[/SEND_EMAIL]\n\n' + partsText;
    const out = extractEmailFromParts([{ type: 'text', text: partsText }], content);
    expect(out.emailDraft?.to).toBe('a@b.c'); // card from content
    const shown = JSON.stringify(out.parts);
    expect(shown).toContain('keep me'); // the parts' complete block body stays
    expect(shown).toContain('Outro prose.');
    expect(shown).not.toMatch(/\[\/?SEND_EMAIL/i); // but no raw markup
  });

  // ── Round-4 review (B1/B2): case parity and link labels in the anchor ──

  it('8d7d07b0 round-4 B1: a lowercase closer still pairs — the card is not silently dropped', () => {
    const text = 'Draft:\n\n[SEND_EMAIL to="zachary@x.com" subject="Hi"]Dear team[/send_email]\n\nTap Send to deliver it.';
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft?.to).toBe('zachary@x.com'); // round-3 regression: card was null
    expect(emailDraft?.subject).toBe('Hi');
    expect(emailDraft?.body).toBe('Dear team');
    expect(cleanText).not.toMatch(/\[\/?send_email/i);
    expect(cleanText).toContain('Tap Send to deliver it');
    expect(cleanText).not.toContain('Dear team'); // body lives in the card
  });

  it('8d7d07b0 round-4 B1 (parts): lowercase closer — parts cut, card returned', () => {
    const partsText = 'Intro [SEND_EMAIL to="a@b.c"]body[/send_email] tail';
    const out = extractEmailFromParts([{ type: 'text', text: partsText }], partsText);
    expect(out.emailDraft?.to).toBe('a@b.c');
    expect(out.parts.map((p: any) => p.text).join('')).toBe('Intro  tail');
  });

  it('8d7d07b0 round-4 B2: a link label before the unclosed fragment does not anchor the cut', () => {
    const partsText = 'See [send_email docs](https://x/send_email).\n\nHi [SEND_EMAIL to="a@b.c"]draft body';
    const content = `${partsText}[/SEND_EMAIL]`;
    const out = extractEmailFromParts([{ type: 'text', text: partsText }], content);
    expect(out.emailDraft?.to).toBe('a@b.c');
    const shown = JSON.stringify(out.parts);
    expect(shown).toContain('See [send_email docs](https://x/send_email)'); // label kept
    expect(shown).not.toContain('draft body'); // fragment not duplicated
    expect(shown).not.toContain('[SEND_EMAIL to='); // no raw opener tag
  });

  it('8d7d07b0 round-4 B2 (complete-block tail): link label after the last block keeps its prose', () => {
    const partsText = '[SEND_EMAIL subject="x"]keep[/SEND_EMAIL] see [send_email docs](url)';
    const content = 'Draft:\n[SEND_EMAIL to="a@b.c"]Hi[/SEND_EMAIL]\n\n' + partsText;
    const out = extractEmailFromParts([{ type: 'text', text: partsText }], content);
    expect(out.emailDraft?.to).toBe('a@b.c');
    const shown = JSON.stringify(out.parts);
    expect(shown).toContain('keep'); // complete-block body stays
    expect(shown).toContain('see [send_email docs](url)'); // link label + prose stay
  });

  it('8d7d07b0: card-bearing path unchanged — a well-formed draft still yields the card and clean text', () => {
    const { cleanText, emailDraft } = parseEmailDraft(TEXT);
    expect(emailDraft?.to).toBe('zachary.seddon@hyperstack.cloud');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/);
  });
});


// ── Ticket 0febb5f1 (post-8d7d07b0): oversized-opener and unquoted-apostrophe shapes ──
// F1: a well-formed block whose opener tag exceeds emailDisplayCuts' 1024-char
// SCAN_WINDOW. completeEmailBlocks (unbounded) parsed it fine, but BOTH bounded
// leftover scans failed on the same opener and the BROKEN-opener rule then cut
// [opener, end-of-text) — merging over the block's own cut and deleting every
// byte of prose after it. Fix: the leftover scan skips complete-block starts
// (the block's own cuts already own the tag).
// F2: TAG_ATTRS' quoted-span alternatives were not anchored to an
// `=`-assignment, so the apostrophe of an UNQUOTED value (subject=Bob's note)
// paired with a later apostrophe in the prose and the quote-aware scan consumed
// the real `]`, the body, and the closer — no card, body deleted. Fix: a quote
// opens a value span only after `=`; any other quote stops the scan, the shape
// falls to the quote-blind bounded cut (tag only), and the body survives as
// prose under the documented no-card contract.
describe('SEND_EMAIL card regression — ticket 0febb5f1 (F1/F2)', () => {
  const OVERSIZED_SUBJECT = 's'.repeat(1200); // > SCAN_WINDOW (1024)
  const F1_TEXT = `Intro.\n\n[SEND_EMAIL to="a@b.c" subject="${OVERSIZED_SUBJECT}"]Card body.[/SEND_EMAIL]\n\nTrailing prose that must survive.`;
  const F2_TEXT = `Preamble.\n\n[SEND_EMAIL subject=Bob's note]Real body must survive.[/SEND_EMAIL] Don't panic] tail`;

  it('0febb5f1 F1: an opener tag longer than SCAN_WINDOW keeps the card AND all trailing prose', () => {
    const { cleanText, emailDraft } = parseEmailDraft(F1_TEXT);
    expect(emailDraft?.to).toBe('a@b.c'); // the oversized tag still parses
    expect(emailDraft?.subject).toBe(OVERSIZED_SUBJECT);
    expect(emailDraft?.body).toBe('Card body.');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i); // no raw markup
    expect(cleanText).toContain('Intro.'); // prose before survives
    expect(cleanText).toContain('Trailing prose that must survive.'); // prose after survives
    expect(cleanText).not.toContain('Card body.'); // body lives in the card, not duplicated
  });

  it('0febb5f1 F1 (no-card block): an oversized opener on a non-card block keeps body + prose', () => {
    const text = `Before.\n\n[SEND_EMAIL subject="${OVERSIZED_SUBJECT}"]Dear team, the ask.[/SEND_EMAIL]\n\nAfter.`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).toBeNull(); // no to= anywhere
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('Before.');
    expect(cleanText).toContain('Dear team, the ask.'); // the block's BODY is content, kept
    expect(cleanText).toContain('After.'); // the pre-fix bug deleted this
  });

  it('0febb5f1 F1 (parts path): the oversized block is excised from text parts, prose intact', () => {
    const out = extractEmailFromParts([{ type: 'text', text: F1_TEXT }], F1_TEXT);
    expect(out.emailDraft?.to).toBe('a@b.c');
    const shown = JSON.stringify(out.parts);
    expect(shown).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(shown).toContain('Trailing prose that must survive.');
  });

  it('0febb5f1 F2: an apostrophe in an UNQUOTED value no longer eats the body (no card, prose kept)', () => {
    const { cleanText, emailDraft } = parseEmailDraft(F2_TEXT);
    expect(emailDraft).toBeNull(); // strict parse: the malformed tag yields no card
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i); // both tags cut (blind bounded cut)
    expect(cleanText).toContain('Real body must survive.'); // the body is content, kept
    expect(cleanText).toContain(`Don't panic] tail`); // later prose kept, bracket included
  });

  it('0febb5f1 F2 (parts path): the unquoted-apostrophe block keeps its body in text parts', () => {
    const out = extractEmailFromParts([{ type: 'text', text: F2_TEXT }], F2_TEXT);
    expect(out.emailDraft).toBeNull();
    const shown = JSON.stringify(out.parts);
    expect(shown).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(shown).toContain('Real body must survive.');
    expect(shown).toContain(`Don't panic] tail`);
  });

  it('0febb5f1 F2 (mixed): a valid quoted to= cannot rescue an unquoted-apostrophe subject — no card, body kept', () => {
    const text = `Draft: [SEND_EMAIL to="a@b.c" subject=Bob's note]body here[/SEND_EMAIL] Don't panic] tail`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).toBeNull(); // one bad attr fails the whole tag (strict)
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('body here'); // kept as prose
    expect(cleanText).toContain(`Don't panic] tail`);
  });

  it('0febb5f1 F2 (battery catch): an embedded dquote without = also fails the quote-aware scan and keeps the body', () => {
    // The first TAG_ATTRS draft of this fix let unit D consume a bare `"` —
    // to=say"hi] matched and the scan could run past the tag end. Pinned here
    // so the plain-char class can never silently re-admit a quote.
    const text = `Note [SEND_EMAIL to=say"hi]Real body[/SEND_EMAIL] end`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).toBeNull();
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('Real body');
    expect(cleanText).toContain('end');
  });

  it('0febb5f1 parity: `to= "x"` (space after =) still parses as a quoted value', () => {
    const { cleanText, emailDraft } = parseEmailDraft('Draft [SEND_EMAIL to= "a@b.c" subject="Hi"]Body[/SEND_EMAIL] tail');
    expect(emailDraft?.to).toBe('a@b.c');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('tail');
  });

  it('0febb5f1 ReDoS pin: a crafted `=\'x\'=` chain opener stays linear (no exponential backtracking)', () => {
    // 5000 atomic units with NO closing bracket — the worst case for the scan.
    // The =-anchored alternation gives every position exactly one parse, so
    // this fails in ~1 ms; a re-splittable alternation would go exponential
    // (2^5000) and never return. 2000 ms of slack makes the bound stall-proof
    // on a loaded CI runner while still catching any blowup.
    const text = `Preamble.\n\n[SEND_EMAIL to=${`'x'=`.repeat(5000)}`;
    const t0 = Date.now();
    const { cleanText, emailDraft } = parseEmailDraft(text);
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(2000);
    expect(emailDraft).toBeNull();
    expect(cleanText).not.toMatch(/\[send_email/i); // BROKEN opener: cut to end, nothing raw
    expect(cleanText).toContain('Preamble.');
  });
});


// ── Ticket 0febb5f1 review round 2 (finding 1: the windowed regex pair fell to
// the BROKEN rule on a malformed tag that a closer still follows — deleting the
// body AND every byte of trailing prose; fixed by the linear scanEmailTagEnd
// tokenizer in emailDisplayCuts. The CARD parser stays strict: a malformed tag
// yields NO card, and its body stays as prose) ──
describe('SEND_EMAIL card regression — 0febb5f1 review round 2', () => {
  it('round-2 R1: bracketed quoted to= + apostrophe subject — body AND trailing prose survive (was: all deleted)', () => {
    // The live 8d7d07b0 specimen shape (to="[recipient]") combined with the F2
    // apostrophe: the quote-BLIND scan fails on the `]` inside the quoted
    // value, the strict scan fails on the apostrophe — pre-tokenizer both
    // failed and the BROKEN rule cut to end-of-text.
    const text = `Intro.\n\n[SEND_EMAIL to="[recipient]" subject=Bob's note from O'Brien]Body text that must survive.[/SEND_EMAIL]\n\nTrailing prose that must survive.`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).toBeNull(); // strict card parse: malformed tag → no card
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i); // the tag + closer are cut
    expect(cleanText).toContain('Body text that must survive.'); // body kept as prose
    expect(cleanText).toContain('Trailing prose that must survive.'); // prose after kept
  });

  it('round-2 R2: oversized (>SCAN_WINDOW) AND apostrophe-bearing tag — body AND prose survive', () => {
    const text = `Intro.\n\n[SEND_EMAIL to="a@b.c" subject=Bob's ${'n'.repeat(1150)} O'Brien notes]Body.[/SEND_EMAIL]\n\nTrailing prose that must survive.`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).toBeNull();
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('Body.');
    expect(cleanText).toContain('Trailing prose that must survive.');
  });

  it('round-2 R1 (parts path): the same shape keeps body and prose in text parts', () => {
    const text = `Intro.\n\n[SEND_EMAIL to="[recipient]" subject=Bob's note]Body text.[/SEND_EMAIL]\n\nTrailing prose.`;
    const out = extractEmailFromParts([{ type: 'text', text }], text);
    expect(out.emailDraft).toBeNull();
    const shown = JSON.stringify(out.parts);
    expect(shown).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(shown).toContain('Body text.');
    expect(shown).toContain('Trailing prose.');
  });

  it('round-2 finding 2 (intended narrowing): a quote inside an unquoted value yields NO card — body kept as prose', () => {
    // Pre-fix (main) this RENDERED A CARD with subject "Re:" — the old
    // alternation paired the two dquotes across `Q3 report`. The =-anchored
    // scan now stops there: strict parse, no card, body as prose. Pinned as
    // INTENDED behavior (the ticket's F2 class), not a regression.
    const text = `X [SEND_EMAIL to="a@b.c" subject=Re: "Q3 report"]Body[/SEND_EMAIL] tail`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).toBeNull();
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('Body');
    expect(cleanText).toContain('tail');
  });

  it('round-2 finding 2b (intended narrowing): to== (double =) yields no card — body kept', () => {
    const text = `X [SEND_EMAIL to=="a@b.c" subject="Hi"]Body[/SEND_EMAIL] tail`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).toBeNull();
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('Body');
    expect(cleanText).toContain('tail');
  });

  it('round-2 bonus parity: a smart-quoted value containing brackets parses as a card (old scan truncated it)', () => {
    // Review round-1 attack-surface A found the OLD TAG_ATTRS truncated
    // subject=“Re: [Q3]” at the inner `]` (its plain-char class beat the
    // smart-quote alternative). The =-anchored scan reads the value whole.
    const LDQ = '\u201C', RDQ = '\u201D';
    const text = `X [SEND_EMAIL to="a@b.c" subject=${LDQ}Re: [Q3]${RDQ}]Body[/SEND_EMAIL] tail`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft?.to).toBe('a@b.c');
    expect(emailDraft?.subject).toBe('Re: [Q3]');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
    expect(cleanText).toContain('tail');
  });
});


// ── Ticket 0febb5f1 review round 3 (round-2 findings 1+2: the tokenizer's
// quoted-value search was an UNBOUNDED indexOf — an unterminated quote in
// opener #1 swallowed a LATER block's opener and the merged cut deleted block
// #1's body; and the unbounded search made a many-opener message super-linear.
// Fix: a bounded manual scan that stops at the next `[SEND_EMAIL` opener, and
// a 4096-char cap per quoted span in the strict TAG_ATTRS) ──
describe('SEND_EMAIL card regression — 0febb5f1 review round 3', () => {
  it('round-3 F1: an unterminated quote must NOT swallow a later block (main parity restored)', () => {
    // Opener #1's to= quote never closes; the value used to run to block #2's
    // opening quote, welding the two blocks' cuts into one range that deleted
    // FIRST DRAFT BODY. Main (pre-0febb5f1) kept it.
    const text = `Here are two drafts.\n\n[SEND_EMAIL to="alice@example.com] FIRST DRAFT BODY. [/SEND_EMAIL]\n\n[SEND_EMAIL to="bob@example.com" subject="Hi"]Second body.[/SEND_EMAIL]\n\nLet me know.`;
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft?.to).toBe('bob@example.com'); // block #2 still the card
    expect(cleanText).toContain('FIRST DRAFT BODY.'); // block #1's body kept (was deleted)
    expect(cleanText).toContain('Let me know.');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
  });

  it('round-3 F1b: an unterminated quote before a later card keeps the prose between', () => {
    const text = 'Intro. [SEND_EMAIL to="oops] IMPORTANT PROSE THAT MUST SURVIVE. [SEND_EMAIL to="a@b.c" subject="Hi"]Card body.[/SEND_EMAIL] tail';
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft?.to).toBe('a@b.c');
    expect(cleanText).toContain('IMPORTANT PROSE THAT MUST SURVIVE.');
    expect(cleanText).toContain('tail');
    expect(cleanText).not.toMatch(/\[\/?SEND_EMAIL/i);
  });

  it('round-3 F2: 16k unclosed-quote openers stay bounded (no unbounded scan per opener)', () => {
    // Pre-cap the strict TAG_ATTRS regex alone burned 3.6 s on this input
    // (unterminated quote scanned to end-of-text once per opener position);
    // with the 4096-char span cap the whole parse is O(openers x 4096) —
    // ~0.6 s measured at 16k. 2500 ms catches any quadratic regression
    // (the uncapped build measured 3.6-6.9 s) with headroom for a slow runner.
    const text = `[SEND_EMAIL a=\u201C`.repeat(16000) + 'x';
    const t0 = Date.now();
    const { cleanText } = parseEmailDraft(text);
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(2500);
    expect(cleanText).not.toMatch(/\[send_email/i);
  });
});


// ── Ticket 0febb5f1 review round 4 (round-3 findings 1+2+3+5: the marker-stop
// heuristic was case-SENSITIVE (a lowercase later opener dodged it — the
// round-2 swallow returned) and over-fired (marker text inside a legitimate
// quoted value took the BROKEN cut); the 4096 span cap left the whole tail
// exposed to the to-end-of-text BROKEN cut. Fix: the heuristic is GONE — a
// tokenized tag is rejected only when it would swallow a real later complete
// block (the block list is case-insensitive and \b-correct, binary-searched),
// and the BROKEN cut is bounded at the next closer token when one exists) ──
describe('SEND_EMAIL card regression — 0febb5f1 review round 4', () => {
  it('round-4 F1: a LOWERCASE later opener cannot dodge the swallow check (round-3 finding 1)', () => {
    const text = 'Here are two drafts.\n\n[SEND_EMAIL to="alice@example.com] FIRST DRAFT BODY. [/SEND_EMAIL]\n\n[send_email to="bob@example.com" subject="Hi"]Second body.[/send_email]\n\nLet me know.';
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft?.to).toBe('bob@example.com'); // lowercase block still the card
    expect(cleanText).toContain('FIRST DRAFT BODY.'); // block #1's body kept
    expect(cleanText).toContain('Let me know.');
    expect(cleanText).not.toMatch(/\[\/?send_email/i);
  });

  it('round-4 F2: marker TEXT inside a quoted value is value text — no BROKEN over-fire (round-3 finding 2)', () => {
    const text = 'Intro. [SEND_EMAIL to="a@b.c" subject="see [SEND_EMAIL] here"]Body text here. trailing prose.';
    const { cleanText } = parseEmailDraft(text);
    expect(cleanText).toBe('Intro. Body text here. trailing prose.'); // exact main parity
    expect(cleanText).not.toMatch(/\[send_email/i);
  });

  it('round-4 F2b: a non-word-boundary marker lookalike inside a value is value text', () => {
    const { cleanText } = parseEmailDraft('Intro. [SEND_EMAIL to="a@b.c" subject="see [SEND_EMAILS] here"]Body text. tail');
    expect(cleanText).toBe('Intro. Body text. tail');
    expect(cleanText).not.toMatch(/\[send_email to=/i);
  });

  it('round-4 F3: a >4096 quoted value in a CLOSED block — the tail survives (bounded BROKEN cut)', () => {
    // Documented cliff (docs/MIGRATION_DISPLAY_AUDIT.md): a quoted value past
    // the 4096-char span cap yields no card; the opener takes the broken-opener
    // cut BOUNDED at the next closer, so everything after the block survives
    // (pre-round-4 the whole tail to end-of-text was deleted).
    const text = 'Intro. [SEND_EMAIL to="a@b.c" subject="' + 'x'.repeat(4097) + '"]Body inside.[/SEND_EMAIL] tail must survive.';
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft).toBeNull(); // the capped strict parse yields no card
    expect(cleanText).toContain('tail must survive.'); // the tail survives
    expect(cleanText).not.toMatch(/\[\/?send_email/i);
  });

  it('round-4 F3b: a >4096 quoted value with NO closer still cuts to end (streaming-truncate parity)', () => {
    const { cleanText, emailDraft } = parseEmailDraft('Intro. [SEND_EMAIL to="a@b.c" subject="' + 'x'.repeat(4097) + '"]Body tail');
    expect(emailDraft).toBeNull();
    expect(cleanText).toBe('Intro.');
  });

  it('round-4 F5: a partial quoted fragment leaves no leaked fragment text (round-3 finding 5)', () => {
    const text = 'Intro. [SEND_EMAIL to="a@b.c" subject="x] y [SEND_EMAIL notes"]Body here. tail';
    const { cleanText } = parseEmailDraft(text);
    expect(cleanText).toBe('Intro. Body here. tail'); // main parity — no ' y ' fragment
    expect(cleanText).not.toMatch(/\[send_email/i);
  });
});


// ── Ticket 0febb5f1 review round 5 (round-4 findings 1+2: the swallow check
// consulted only COMPLETE blocks, so a later opener that never closes (a
// model's second draft attempt) was still swallowed — prose deleted that main
// kept; and the closer-bounded BROKEN cut produced K disjoint cuts that made
// applyCuts' right-to-left slice loop quadratic. Fix: a RUNAWAY check inside
// the tokenizer — a quoted span whose closing quote directly follows a
// `=`-assignment (`…[SEND_EMAIL to="`) is a later tag's value-opener, so the
// span is rejected (escape hatch: `…to="]` closes the tag immediately and is
// template text inside a legit value); and applyCuts is now ONE forward walk,
// O(N + cuts)) ──
describe('SEND_EMAIL card regression — 0febb5f1 review round 5', () => {
  it('round-5 R1: an unclosed LATER opener is not swallowed (P3 kept, main parity)', () => {
    // The later opener never closes, so it is in no complete block — the
    // block-start check alone missed it (round-4 finding 1).
    const { cleanText } = parseEmailDraft('[SEND_EMAIL to="oops] P3 [SEND_EMAIL to="a@b.c"]');
    expect(cleanText).toContain('P3');
    expect(cleanText).not.toMatch(/\[send_email/i);
  });

  it('round-5 R1b: a consumed/nested block inside the swallowed span is not lost either', () => {
    const { cleanText } = parseEmailDraft('[SEND_EMAIL note][SEND_EMAIL to="oops][/SEND_EMAIL] P3 [SEND_EMAIL to="q"]');
    expect(cleanText).toContain('P3');
    expect(cleanText).not.toMatch(/\[send_email/i);
  });

  it('round-5 R1c (parts): the truncated-parts path keeps IMPORTANT PROSE with the card', () => {
    const content = 'Intro. [SEND_EMAIL to="oops] IMPORTANT PROSE [SEND_EMAIL to="a@b.c"]CARD BODY[/SEND_EMAIL] tail';
    const partsText = 'Intro. [SEND_EMAIL to="oops] IMPORTANT PROSE [SEND_EMAIL to="a@b.c"]CARD';
    const out = extractEmailFromParts([{ type: 'text', text: partsText }], content);
    expect(out.emailDraft?.to).toBe('a@b.c');
    const shown = JSON.stringify(out.parts);
    expect(shown).toContain('IMPORTANT PROSE'); // was deleted pre-round-5
    expect(shown).not.toMatch(/\[\/?send_email/i);
  });

  it('round-5 escape hatch: a value ENDING in template text still parses as a card', () => {
    // The runaway tail regex matches (`…[SEND_EMAIL to=`), but the tag
    // CLOSES immediately after the quote — template text inside a legit
    // value, not a swallowed later tag.
    const text = 'Intro. [SEND_EMAIL to="a@b.c" subject="note: [SEND_EMAIL to="]Body here.[/SEND_EMAIL] tail';
    const { cleanText, emailDraft } = parseEmailDraft(text);
    expect(emailDraft?.to).toBe('a@b.c');
    expect(emailDraft?.subject).toBe('note: [SEND_EMAIL to=');
    expect(cleanText).toContain('tail');
    expect(cleanText).not.toContain('Body here.'); // body lives in the card
    expect(cleanText).not.toMatch(/\[send_email to=/i);
  });

  it('round-5 R2: 32k disjoint closer-bounded cuts stay linear (single-pass applyCuts)', () => {
    // Pre-round-5 the right-to-left slice loop rebuilt the string once per
    // cut: 1.9 s at 16k, 7.9 s at 32k. One forward walk: ~90 ms at 32k.
    const text = '[SEND_EMAIL to="x [/SEND_EMAIL] '.repeat(32000);
    const t0 = Date.now();
    const { cleanText } = parseEmailDraft(text);
    const dt = Date.now() - t0;
    expect(dt).toBeLessThan(2500);
    expect(cleanText).not.toMatch(/\[send_email/i);
  });
});
