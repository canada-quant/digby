/**
 * BRIEFING-UNVERIFIED-FILTER (supervisor SOTA round 3, 2026-10-20) — the pure leaf behind the action-class
 * footnote on supervisor machine wakes and the owner briefing's mark / drop filter. Pins: which verifier
 * convictions are annotatable (action-class, LLM lane, id-less — an id-bearing one is id-exonerated), the
 * zero-tool construction, the locator (tightest clause → sentence → line; quotes / code never match), the
 * marker / drop rewrites, the footnote's one-paragraph W1-4 shape and its round trip through
 * extractAnnotationClaims, and fail-toward-delivery on every probe error.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  UNVERIFIED_BRIEFING_SENTENCE,
  UNVERIFIED_FOOTNOTE_HEADER,
  UNVERIFIED_MARKER,
  actionClassAnnotateDisabled,
  annotatableVerifierClaim,
  briefingUnverifiedFilterDisabled,
  claimIdRefs,
  claimQuoteFromDetail,
  collectUnverifiedClaims,
  dedupeUnverifiedClaims,
  dropClaimSegments,
  extractAnnotationClaims,
  locateClaimSegment,
  markClaimSegments,
  parseAnnotationClaimLine,
  placeUnverifiedFootnote,
  planUnverifiedBriefing,
  renderUnverifiedClaimsFootnote,
  runMadeNoToolCall,
  stripUnverifiedFootnote,
  zeroToolDispatchQuotes,
  type UnverifiedClaim,
} from './unverified-claims';

const NOTE = [
  '**CanLaw** — dispatched the bench rerun to the GPU lane → results tonight',
  '**Tenstorrent** — speed check passed → next comparison queued → no ETA yet',
  'Needs you: approve the H100 move (yes / no)',
].join('\n');

afterEach(() => {
  delete process.env.ACTION_CLASS_ANNOTATE_DISABLED;
  delete process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED;
});

describe('kill switches', () => {
  it('default ON; =1 disables each independently', () => {
    expect(actionClassAnnotateDisabled()).toBe(false);
    expect(briefingUnverifiedFilterDisabled()).toBe(false);
    process.env.ACTION_CLASS_ANNOTATE_DISABLED = '1';
    expect(actionClassAnnotateDisabled()).toBe(true);
    expect(briefingUnverifiedFilterDisabled()).toBe(false);
    process.env.BRIEFING_UNVERIFIED_FILTER_DISABLED = '1';
    expect(briefingUnverifiedFilterDisabled()).toBe(true);
  });
});

describe('the footnote header is the W1-4 annotation header (guard-chrome-redact strips it from later wakes)', () => {
  it('matches action-verifier ACTION_GUARD_ANNOTATION_HEADER and is listed in guard-chrome-redact TRAILING_NOTE_HEADERS', () => {
    const av = fs.readFileSync(path.join(__dirname, 'action-verifier.ts'), 'utf8');
    expect(av).toContain(`export const ACTION_GUARD_ANNOTATION_HEADER = '${UNVERIFIED_FOOTNOTE_HEADER}';`);
    const redact = fs.readFileSync(path.join(__dirname, '..', 'guard-chrome-redact.ts'), 'utf8');
    expect(redact).toContain(`'${UNVERIFIED_FOOTNOTE_HEADER}',`);
  });
});

describe('annotatableVerifierClaim', () => {
  it('an id-less LLM-lane action claim of each action kind is annotatable', () => {
    for (const kind of ['dispatch', 'message', 'schedule', 'ticket']) {
      expect(annotatableVerifierClaim({ kind, detail: 'steered the lane onto the gap matrix' })).toBe(true);
    }
  });
  it('an id-bearing conviction is id-exonerated (the mis-typed-but-real class) and never annotated', () => {
    expect(annotatableVerifierClaim({ kind: 'message', detail: 'lane audit msg 4ac92734', id: '4ac92734' })).toBe(false);
  });
  it('citation-class (fabricated / miscopied ids, tagged lanes), board, args-surface and non-action kinds are not this lane', () => {
    expect(annotatableVerifierClaim({ kind: 'dispatch', detail: 'x', fabricatedId: true })).toBe(false);
    expect(annotatableVerifierClaim({ kind: 'ticket', detail: 'x', miscopiedFrom: '59a4407b' })).toBe(false);
    expect(annotatableVerifierClaim({ kind: 'message', detail: '[evidence citation] lane msg 1a2b3c4d' })).toBe(false);
    expect(annotatableVerifierClaim({ kind: 'dispatch', detail: '[dispatch receipt] dispatched 1a2b3c4d' })).toBe(false);
    expect(annotatableVerifierClaim({ kind: 'board', detail: '[board count] 3 goals active' })).toBe(false);
    expect(annotatableVerifierClaim({ kind: 'dispatch', detail: '[in send_chat_message args] dispatched the bench' })).toBe(false);
    expect(annotatableVerifierClaim({ kind: 'goal', detail: 'goal done' })).toBe(false);
    expect(annotatableVerifierClaim({ kind: 'dispatch', detail: '   ' })).toBe(false);
    expect(annotatableVerifierClaim(null)).toBe(false);
  });
});

describe('zero-tool construction', () => {
  it('runMadeNoToolCall reads tool_call parts only', () => {
    expect(runMadeNoToolCall([])).toBe(true);
    expect(runMadeNoToolCall(undefined)).toBe(true);
    expect(runMadeNoToolCall([{ type: 'text' }, { type: 'reasoning' }])).toBe(true);
    expect(runMadeNoToolCall([{ type: 'text' }, { type: 'tool_call' }])).toBe(false);
  });
  it('zeroToolDispatchQuotes keeps SEND-class spans only, as quotes of the text', () => {
    const t = 'Wake. I dispatched the summary draft to the writing lane. I re-read the board.';
    const sendAt = t.indexOf('I dispatched');
    const sendEnd = t.indexOf('lane.') + 'lane.'.length;
    const readAt = t.indexOf('I re-read');
    expect(zeroToolDispatchQuotes(t, [
      { cls: 'send', start: sendAt, end: sendEnd },
      { cls: 'read', start: readAt, end: t.length },
      { cls: 'send', start: 5, end: 2 }, // invalid span
      { cls: 'send', start: 0, end: t.length + 10 }, // out of range
    ])).toEqual([{ quote: 'I dispatched the summary draft to the writing lane.' }]);
    expect(zeroToolDispatchQuotes(t, null)).toEqual([]);
  });
});

describe('locateClaimSegment', () => {
  it('finds the TIGHTEST clause holding a verbatim quote (a bold project line splits at its dash and arrows)', () => {
    const seg = locateClaimSegment(NOTE, 'dispatched the bench rerun to the GPU lane')!;
    expect(NOTE.slice(seg.start, seg.end)).toBe('dispatched the bench rerun to the GPU lane');
  });
  it('finds a paraphrased quote by content-token coverage (the verifier grounding rule)', () => {
    const seg = locateClaimSegment(NOTE, 'dispatched bench rerun on GPU lane')!;
    expect(NOTE.slice(seg.start, seg.end)).toBe('dispatched the bench rerun to the GPU lane');
  });
  it('falls back to the sentence when the claim spans clauses', () => {
    const t = 'Status — I dispatched the rerun; results land tonight. Other news.';
    const seg = locateClaimSegment(t, 'I dispatched the rerun; results land tonight.')!;
    expect(t.slice(seg.start, seg.end)).toBe('Status — I dispatched the rerun; results land tonight.');
  });
  it('a table cell is a clause', () => {
    const t = '| CanLaw | dispatched the bench rerun | tonight |';
    const seg = locateClaimSegment(t, 'dispatched the bench rerun')!;
    expect(t.slice(seg.start, seg.end)).toBe('dispatched the bench rerun');
  });
  it('blockquotes and fenced code never match; an absent claim or a claim with no content tokens is null', () => {
    expect(locateClaimSegment('> I dispatched the bench rerun', 'dispatched the bench rerun')).toBeNull();
    expect(locateClaimSegment('```\nI dispatched the bench rerun\n```', 'dispatched the bench rerun')).toBeNull();
    expect(locateClaimSegment(NOTE, 'merged the release branch into main')).toBeNull();
    expect(locateClaimSegment(NOTE, 'the of and')).toBeNull();
    expect(locateClaimSegment('', 'dispatched')).toBeNull();
  });
});

describe('markClaimSegments / dropClaimSegments', () => {
  const seg = () => locateClaimSegment(NOTE, 'dispatched the bench rerun to the GPU lane')!;
  it('marks before the closing punctuation, keeps every other byte, and is idempotent', () => {
    const marked = markClaimSegments(NOTE, [seg()]);
    expect(marked.split('\n')[0]).toBe(`**CanLaw** — dispatched the bench rerun to the GPU lane ${UNVERIFIED_MARKER} → results tonight`);
    expect(marked.split('\n').slice(1)).toEqual(NOTE.split('\n').slice(1));
    const t = 'I dispatched the summary draft.';
    const once = markClaimSegments(t, [locateClaimSegment(t, 'dispatched the summary draft')!]);
    expect(once).toBe(`I dispatched the summary draft ${UNVERIFIED_MARKER}.`);
    expect(markClaimSegments(once, [locateClaimSegment(once, 'dispatched the summary draft')!])).toBe(once);
  });
  it('marks inside a bold run rather than after its closer', () => {
    const t = '**Dispatched the rerun.**';
    expect(markClaimSegments(t, [locateClaimSegment(t, 'Dispatched the rerun')!])).toBe(`**Dispatched the rerun ${UNVERIFIED_MARKER}.**`);
  });
  it('drops the claim clause and tidies the separators; other lines are untouched', () => {
    const dropped = dropClaimSegments(NOTE, [seg()]);
    expect(dropped.split('\n')[0]).toBe('**CanLaw** — results tonight'); // the doubled separator collapses to the first
    expect(dropped.split('\n').slice(1)).toEqual(NOTE.split('\n').slice(1));
  });
  it('a line left with only its bullet / bold label goes entirely; line indices survive multiple drops', () => {
    const t = ['- I dispatched the bench rerun.', 'Keep this line.', '**Proj** — I armed the nightly watch.', 'And this one.'].join('\n');
    const segs = [locateClaimSegment(t, 'I dispatched the bench rerun.')!, locateClaimSegment(t, 'I armed the nightly watch.')!];
    expect(dropClaimSegments(t, segs)).toBe('Keep this line.\nAnd this one.');
  });
});

describe('the embedded annotation (round trip)', () => {
  it('parseAnnotationClaimLine reads claimDetailLines lines; strips a lane tag and a board tail', () => {
    expect(parseAnnotationClaimLine('- [dispatch] "Steered the lane onto the gap matrix" (cites 1a2b3c4d)')).toEqual({ kind: 'dispatch', quote: 'Steered the lane onto the gap matrix', source: 'annotation' });
    expect(parseAnnotationClaimLine('- [message] "[evidence citation] lane msg 1a2b3c4d done"')?.quote).toBe('lane msg 1a2b3c4d done');
    expect(parseAnnotationClaimLine('- [goal] "[board assertion] goal X still open — asserted goal abc is "active"; the ledger says "done""')?.quote).toBe('goal X still open');
    expect(parseAnnotationClaimLine('- … and 2 more')).toBeNull();
    expect(parseAnnotationClaimLine('plain prose')).toBeNull();
    expect(claimQuoteFromDetail('[dispatch receipt] dispatched lane')).toBe('dispatched lane');
  });
  it('extractAnnotationClaims strips every annotation paragraph and returns its claims; the rest of the note is kept', () => {
    const w14 = [
      UNVERIFIED_FOOTNOTE_HEADER,
      'This note was delivered as written. The integrity check could not verify 1 claim(s) in it — id(s) the integrity check could not find:',
      '- [message] "[evidence citation] Steered lane (msg abc12345)" (cites abc12345)',
      'Treat those lines as unverified until a fresh tool result confirms them; nothing above was removed or changed.',
    ].join('\n');
    const text = `${NOTE}\n\n${w14}\n\nTrailing harness footer.`;
    const out = extractAnnotationClaims(text);
    expect(out.text).toBe(`${NOTE}\n\nTrailing harness footer.`);
    expect(out.claims).toEqual([{ kind: 'message', quote: 'Steered lane (msg abc12345)', source: 'annotation' }]);
    expect(extractAnnotationClaims(NOTE)).toEqual({ text: NOTE, claims: [] });
  });
  it('the footnote is ONE paragraph under the header, quotes are sanitized, and it reads back to the same claims', () => {
    const claims: UnverifiedClaim[] = [
      { kind: 'dispatch', quote: 'dispatched the "bench" | rerun', source: 'action_verifier' },
      { kind: 'dispatch', quote: 'I dispatched the summary\ndraft', source: 'zero_tool_dispatch' },
    ];
    const f = renderUnverifiedClaimsFootnote(claims, { zeroTool: true, briefingFiltered: true });
    expect(f.split('\n')[0]).toBe(UNVERIFIED_FOOTNOTE_HEADER);
    expect(f).not.toMatch(/\n\s*\n/);
    expect(f).toContain('could not verify 2 action claim(s)');
    expect(f).toContain('this run made no tool call at all');
    expect(f).toContain(`- [dispatch] "dispatched the 'bench' / rerun"`);
    expect(f).toContain(UNVERIFIED_BRIEFING_SENTENCE);
    expect(extractAnnotationClaims(`${NOTE}\n\n${f}`).claims.map((c) => c.quote)).toEqual(["dispatched the 'bench' / rerun", 'I dispatched the summary draft']);
    const g = renderUnverifiedClaimsFootnote(claims, { zeroTool: false, briefingFiltered: false });
    expect(g).toContain('no matching tool call in this run');
    expect(g).not.toContain('owner briefing');
  });
  it('REVIEW FIX: the briefing sentence needs an explicit briefingFiltered:true (no promise by default) and is conditional on the note', () => {
    const claims: UnverifiedClaim[] = [{ kind: 'dispatch', quote: 'dispatched the rerun', source: 'action_verifier' }];
    expect(renderUnverifiedClaimsFootnote(claims, { zeroTool: false })).not.toContain('owner briefing');
    expect(UNVERIFIED_BRIEFING_SENTENCE).toBe('An owner briefing written from this note marks them as unverified or leaves them out.');
  });
  it('lists at most 6 claim lines with a count line for the rest', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ kind: 'dispatch', quote: `dispatched task number ${i}`, source: 'action_verifier' as const }));
    const f = renderUnverifiedClaimsFootnote(many, { zeroTool: false });
    expect(f.split('\n').filter((l) => l.startsWith('- [dispatch]'))).toHaveLength(6);
    expect(f).toContain('- … and 2 more');
    expect(f).toContain('could not verify 8 action claim(s)');
  });
  it('stripUnverifiedFootnote removes exactly the appended footnote', () => {
    const f = renderUnverifiedClaimsFootnote([{ kind: 'dispatch', quote: 'x y z dispatched', source: 'action_verifier' }], { zeroTool: false });
    expect(stripUnverifiedFootnote(`${NOTE}\n\n${f}`, f)).toBe(NOTE);
    expect(stripUnverifiedFootnote(NOTE, f)).toBe(NOTE);
    expect(stripUnverifiedFootnote(NOTE, '')).toBe(NOTE);
  });
  // Review fix (2026-10-20): the supervisor harness stripped the note's own ACTIONS TAKEN list — the footnote
  // must not say "delivered as written … nothing above was removed or changed" (f16cc02a).
  it('REVIEW FIX: harnessReplacedBlock words the footnote truthfully; without it the wording is unchanged', () => {
    const claims: UnverifiedClaim[] = [{ kind: 'dispatch', quote: 'dispatched the rerun', source: 'zero_tool_dispatch' }];
    const f = renderUnverifiedClaimsFootnote(claims, { zeroTool: true, harnessReplacedBlock: true });
    expect(f).not.toContain('nothing above was removed');
    expect(f).toContain('minus its own ACTIONS TAKEN list');
    expect(f).toContain('no other line was removed or changed.');
    expect(f).not.toMatch(/\n\s*\n/);
    expect(extractAnnotationClaims(`${NOTE}\n\n${f}`).claims.map((c) => c.quote)).toEqual(['dispatched the rerun']);
    expect(renderUnverifiedClaimsFootnote(claims, { zeroTool: true })).toContain('This note was delivered as written. The integrity check');
    expect(renderUnverifiedClaimsFootnote(claims, { zeroTool: true })).toContain('nothing above was removed or changed.');
  });
  it('REVIEW FIX: harnessStrippedCopies names the stripped copies of harness lines, never an ACTIONS TAKEN list the note did not have', () => {
    const claims: UnverifiedClaim[] = [{ kind: 'dispatch', quote: 'dispatched the rerun', source: 'zero_tool_dispatch' }];
    const copies = renderUnverifiedClaimsFootnote(claims, { zeroTool: true, harnessStrippedCopies: true });
    expect(copies).toContain('minus its copies of harness-record lines');
    expect(copies).not.toContain('ACTIONS TAKEN list');
    expect(copies).toContain('no other line was removed or changed.');
    const both = renderUnverifiedClaimsFootnote(claims, { zeroTool: true, harnessReplacedBlock: true, harnessStrippedCopies: true });
    expect(both).toContain('minus its own ACTIONS TAKEN list and its copies of harness-record lines');
    expect(extractAnnotationClaims(`${NOTE}\n\n${copies}`).claims.map((c) => c.quote)).toEqual(['dispatched the rerun']);
  });
  // Review fix (2026-10-20): guard-chrome-redact treats a TRAILING harness appendix as transparent and the
  // footnote as chrome — the appendix must stay last or it shields every trailer before it.
  it('REVIEW FIX: placeUnverifiedFootnote puts the footnote in front of the harness appendix; on the tail without one', () => {
    const f = renderUnverifiedClaimsFootnote([{ kind: 'dispatch', quote: 'x y z dispatched', source: 'action_verifier' }], { zeroTool: false });
    const appendix = 'WAKE: no-op (harness: 0 lane actions)';
    expect(placeUnverifiedFootnote(`${NOTE}\n\n${appendix}`, f, appendix)).toBe(`${NOTE}\n\n${f}\n\n${appendix}`);
    expect(placeUnverifiedFootnote(`${NOTE}\n`, f)).toBe(`${NOTE}\n\n${f}`);
    expect(placeUnverifiedFootnote(`${NOTE}\n`, f, '')).toBe(`${NOTE}\n\n${f}`);
    // An appendix the note does not end with (never appended / rewritten after) — the old tail append.
    expect(placeUnverifiedFootnote(NOTE, f, appendix)).toBe(`${NOTE}\n\n${f}`);
    expect(placeUnverifiedFootnote(appendix, f, appendix)).toBe(`${f}\n\n${appendix}`);
    // The briefing still gets the model's note back exactly.
    expect(stripUnverifiedFootnote(placeUnverifiedFootnote(`${NOTE}\n\n${appendix}`, f, appendix), f)).toBe(`${NOTE}\n\n${appendix}`);
  });
});

describe('collectUnverifiedClaims', () => {
  const vc = { kind: 'dispatch', detail: 'dispatched the bench rerun to the GPU lane' };
  it('keeps a located id-less verifier claim; drops an unlocated one and an id-bearing one', async () => {
    const out = await collectUnverifiedClaims({
      text: NOTE,
      verifierClaims: [vc, { kind: 'dispatch', detail: 'merged the release branch into main' }, { kind: 'message', detail: 'sent the lane a note', id: 'abcd1234' }],
    });
    expect(out).toEqual([{ kind: 'dispatch', quote: 'dispatched the bench rerun to the GPU lane', source: 'action_verifier' }]);
  });
  it('REVIEW FIX (2026-10-20): a ZERO-TOOL dispatch naming a REAL lane by id is convicted by construction — never id-probed, never exonerated by its target existing', async () => {
    // The reproduced failure: "I messaged lane 7fbd168c to rerun the eval", zero tool calls, lane 7fbd168c a real
    // chat. The first cut's anywhere-probe found the lane and dropped the claim — the owner briefing then read
    // "Bench: I messaged lane to rerun the eval → ETA 2h" as fact.
    const text = '**Bench** — I messaged lane 7fbd168c to rerun the eval → ETA 2h';
    const actEvidence = jest.fn(async () => true); // even an "everything exists" probe changes nothing for zero-tool claims
    const out = await collectUnverifiedClaims({ text, zeroToolClaims: [{ quote: 'I messaged lane 7fbd168c to rerun the eval' }], actEvidence });
    expect(out).toEqual([{ kind: 'dispatch', quote: 'I messaged lane 7fbd168c to rerun the eval', source: 'zero_tool_dispatch' }]);
    expect(actEvidence).not.toHaveBeenCalled();
    const plan = planUnverifiedBriefing(text, out);
    expect(plan.markedNote).toBe(`**Bench** — I messaged lane 7fbd168c to rerun the eval ${UNVERIFIED_MARKER} → ETA 2h`);
  });
  it('REVIEW FIX: a verifier claim is exonerated only by ACT evidence — the target lane id (no act evidence) keeps it; a receipt id of this chat drops it', async () => {
    const text = '**Bench** — messaged the lane 7fbd168c to rerun the eval → ETA 2h';
    const vClaim = { kind: 'message', detail: 'messaged the lane to rerun the eval' };
    // The lane id resolves to a CHAT — not evidence that anything was sent.
    const noAct = jest.fn(async () => false);
    expect(await collectUnverifiedClaims({ text, verifierClaims: [vClaim], actEvidence: noAct })).toEqual([{ kind: 'message', quote: 'messaged the lane to rerun the eval', source: 'action_verifier' }]);
    expect(noAct).toHaveBeenCalledWith({ id: '7fbd168c', exact: false });
    // The sentence cites an executed action receipt of this chat → an honest reference to an earlier send.
    const withReceipt = '**Bench** — messaged the lane to rerun the eval (receipt 1a2b3c4d) → ETA 2h';
    const act = jest.fn(async (ref: { id: string }) => ref.id === '1a2b3c4d');
    expect(await collectUnverifiedClaims({ text: withReceipt, verifierClaims: [vClaim], actEvidence: act })).toEqual([]);
  });
  it('fails toward NOT annotating for verifier claims: a throwing probe, no probe, or a probe past the time budget counts the id as evidence', async () => {
    const vClaim = { kind: 'message', detail: 'messaged the writing lane the brief' };
    const text = 'I messaged the writing lane 9f8e7d6c the brief.';
    expect(await collectUnverifiedClaims({ text, verifierClaims: [vClaim], actEvidence: async () => { throw new Error('db down'); } })).toEqual([]);
    expect(await collectUnverifiedClaims({ text, verifierClaims: [vClaim] })).toEqual([]);
    const slow = () => new Promise<boolean>((r) => setTimeout(() => r(false), 200));
    expect(await collectUnverifiedClaims({ text, verifierClaims: [vClaim], actEvidence: slow, probeBudgetMs: 20 })).toEqual([]);
    expect(await collectUnverifiedClaims({ text, verifierClaims: [vClaim], actEvidence: async () => false, probeBudgetMs: 0 })).toEqual([]);
    // an id-less claim needs no probe
    expect(await collectUnverifiedClaims({ text: 'I messaged the writing lane the brief.', verifierClaims: [vClaim] })).toHaveLength(1);
  });
  it('never lists a claim twice: the same clause from both sources, or a clause the guard annotation already names', async () => {
    const dup = await collectUnverifiedClaims({
      text: NOTE,
      verifierClaims: [vc],
      zeroToolClaims: [{ quote: 'dispatched the bench rerun to the GPU lane' }],
    });
    expect(dup).toHaveLength(1);
    const already = await collectUnverifiedClaims({
      text: NOTE,
      verifierClaims: [vc],
      alreadyAnnotated: ['[evidence citation] dispatched the bench rerun to the GPU lane'],
    });
    expect(already).toEqual([]);
  });
  it('ignores annotation paragraphs when locating (a claim only quoted by harness text is not in the note)', async () => {
    const f = renderUnverifiedClaimsFootnote([{ kind: 'dispatch', quote: 'merged the release branch into main', source: 'action_verifier' }], { zeroTool: false });
    const out = await collectUnverifiedClaims({ text: `${NOTE}\n\n${f}`, verifierClaims: [{ kind: 'dispatch', detail: 'merged the release branch into main' }] });
    expect(out).toEqual([]);
  });
  it('caps the collected claims at 8 and returns [] for empty input', async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `I dispatched worker batch ${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)} to the queue.`);
    const out = await collectUnverifiedClaims({ text: lines.join('\n'), zeroToolClaims: lines.map((quote) => ({ quote })) });
    expect(out).toHaveLength(8);
    expect(await collectUnverifiedClaims({ text: NOTE })).toEqual([]);
    expect(await collectUnverifiedClaims({ text: '', verifierClaims: [vc] })).toEqual([]);
  });
});

describe('claimIdRefs (review fix 2026-10-20 — what an id probe may look up)', () => {
  it('a full uuid is an EXACT ref; an 8-hex token or a dashed uuid prefix is a prefix; shas, 7-hex and odd shapes are skipped', () => {
    expect(claimIdRefs('receipt 3bd727f6-1234-4abc-9def-0123456789AB done')).toEqual([{ id: '3bd727f6-1234-4abc-9def-0123456789ab', exact: true }]);
    expect(claimIdRefs('lane 7fbd168c and msg abcd1234-ab12')).toEqual([{ id: '7fbd168c', exact: false }, { id: 'abcd1234-ab12', exact: false }]);
    expect(claimIdRefs('commit a65e79f4b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7, short a65e79f, 1a2b3c4d5e6f, abc12345-ef')).toEqual([]);
    expect(claimIdRefs('deadbeef on 2026-10-20')).toEqual([]);
    expect(claimIdRefs('7fbd168c twice 7FBD168C')).toEqual([{ id: '7fbd168c', exact: false }]);
  });
});

describe('planUnverifiedBriefing / dedupeUnverifiedClaims', () => {
  it('marks for the rendering, drops for the LLM input, counts located claims; unlocated claims change nothing', () => {
    const claims: UnverifiedClaim[] = [
      { kind: 'dispatch', quote: 'dispatched the bench rerun to the GPU lane', source: 'action_verifier' },
      { kind: 'dispatch', quote: 'merged the release branch into main', source: 'annotation' },
    ];
    const plan = planUnverifiedBriefing(NOTE, claims);
    expect(plan.located).toBe(1);
    expect(plan.markedNote).toContain(`GPU lane ${UNVERIFIED_MARKER}`);
    expect(plan.droppedNote).not.toContain('dispatched the bench rerun');
    expect(plan.droppedNote).toContain('Tenstorrent');
    expect(planUnverifiedBriefing(NOTE, [claims[1]])).toEqual({ markedNote: NOTE, droppedNote: NOTE, located: 0 });
  });
  it('dedupes by normalized quote, first wins', () => {
    expect(dedupeUnverifiedClaims([
      { kind: 'dispatch', quote: 'Dispatched the rerun.', source: 'action_verifier' },
      { kind: 'message', quote: 'dispatched   the rerun', source: 'annotation' },
      { kind: 'dispatch', quote: '', source: 'annotation' },
    ])).toEqual([{ kind: 'dispatch', quote: 'Dispatched the rerun.', source: 'action_verifier' }]);
  });
});
