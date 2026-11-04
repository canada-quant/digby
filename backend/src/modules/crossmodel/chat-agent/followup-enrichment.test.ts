/**
 * Tests for follow-up reference enrichment.
 * 2026-07-02: Created alongside extraction into followup-enrichment.ts. This is the
 * code path that keeps the prior-turn topic attached to short follow-up messages —
 * previously untestable because it lived in the env/integration-heavy query-pipeline.
 */
import {
  enrichFollowUpReference,
  type ConversationMessage,
} from './followup-enrichment';

const ASSISTANT_LONG =
  'Teranet is a colocation and data-center provider we recommended for hosting. ' +
  'It offers Victoria and Toronto facilities with competitive pricing and low latency. ' +
  'Their Victoria site is well suited for BC-based workloads and disaster recovery.';

const history = (assistant: string): ConversationMessage[] => [
  { role: 'user', content: 'Where should we host?' },
  { role: 'assistant', content: assistant },
];

describe('enrichFollowUpReference — pass-through cases', () => {
  it('returns the message unchanged when there is no history', () => {
    expect(enrichFollowUpReference("what's Teranet?", [])).toBe("what's Teranet?");
  });

  it('returns the message unchanged when it is too long to be a follow-up', () => {
    const long = 'x'.repeat(300);
    expect(enrichFollowUpReference(long, history(ASSISTANT_LONG))).toBe(long);
  });

  it('does not enrich when the last assistant message is too short', () => {
    const msg = "what's Teranet?";
    expect(enrichFollowUpReference(msg, history('Teranet.'))).toBe(msg);
  });

  it('does not enrich an explicit reference to a term not present in the prior turn', () => {
    const msg = "what's Colossus?";
    expect(enrichFollowUpReference(msg, history(ASSISTANT_LONG))).toBe(msg);
  });
});

describe('enrichFollowUpReference — explicit term references', () => {
  it('injects surrounding context for "what\'s X?" when X appeared in the prior turn', () => {
    const out = enrichFollowUpReference("what's Teranet?", history(ASSISTANT_LONG));
    expect(out).not.toBe("what's Teranet?");
    expect(out).toContain('CONVERSATION CONTEXT');
    expect(out).toContain('Teranet');
    // The original message is preserved at the start.
    expect(out.startsWith("what's Teranet?")).toBe(true);
  });

  it('fires the onEnrich callback with kind="explicit" and the term', () => {
    const calls: any[] = [];
    enrichFollowUpReference('tell me more about Teranet', history(ASSISTANT_LONG), (i) => calls.push(i));
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('explicit');
    expect(calls[0].term.toLowerCase()).toContain('teranet');
  });
});

describe('enrichFollowUpReference — implicit continuations', () => {
  it('enriches a bare implicit "how much..." follow-up with the prior topic', () => {
    // No nameable term, but a clear continuation → implicit topic-summary path.
    const out = enrichFollowUpReference('how much for the Victoria site', history(ASSISTANT_LONG));
    expect(out).toContain('topic from my previous response');
    expect(out.startsWith('how much for the Victoria site')).toBe(true);
  });

  it('enriches an additive "and ..." continuation (2026-07-01 pattern)', () => {
    const out = enrichFollowUpReference('and og duece clarkson', history(ASSISTANT_LONG));
    expect(out).toContain('CONVERSATION CONTEXT');
  });

  it('enriches anaphoric "been to all these" reactions', () => {
    const out = enrichFollowUpReference('been to all these', history(ASSISTANT_LONG));
    expect(out).toContain('CONVERSATION CONTEXT');
  });

  it('enriches a "doesn\'t have to be ..." constraint relaxation (2026-07-07 pattern)', () => {
    // Re-ask analysis (chat 680e45b7): "Doesn't have to be comox valley just on the
    // island" relaxes a geographic constraint on the prior answer.
    const out = enrichFollowUpReference("Doesn't have to be comox valley just on the island", history(ASSISTANT_LONG));
    expect(out).toContain('topic from my previous response');
  });

  it('enriches a bare-number "why not 200" reference as an implicit continuation (2026-07-08)', () => {
    // Re-ask analysis (chat 38a4e008): after a Cirque du Soleil seating answer the
    // user asked "why not 200" (200 = a seat section). The "why …" pattern captured
    // "not 200", which never appears verbatim, so no context attached. Bare numbers
    // now route to the implicit topic-summary path.
    const out = enrichFollowUpReference('why not 200', history(ASSISTANT_LONG));
    expect(out).toContain('topic from my previous response');
    expect(out.startsWith('why not 200')).toBe(true);
  });

  it('enriches a bare-price "what about 200" reference (2026-07-08)', () => {
    const out = enrichFollowUpReference('what about 200', history(ASSISTANT_LONG));
    expect(out).toContain('CONVERSATION CONTEXT');
  });

  it('enriches "Can you separate comox and courtenay" (2026-07-12 pattern)', () => {
    // Re-ask analysis (chat 45e30e99, 5 re-ask clusters in 3.5 min): reformat/transform
    // commands opening with "Can you …" fell through with no context, so the model
    // re-answered the whole Vancouver Island list instead of just reformatting it.
    const out = enrichFollowUpReference('Can you separate comox and courtenay', history(ASSISTANT_LONG));
    expect(out).toContain('topic from my previous response');
    expect(out.startsWith('Can you separate comox and courtenay')).toBe(true);
  });

  it('enriches "Can you put this list in bullet form" (2026-07-12 pattern)', () => {
    const out = enrichFollowUpReference('Can you put this list in bullet form. No details just names', history(ASSISTANT_LONG));
    expect(out).toContain('CONVERSATION CONTEXT');
  });

  it('enriches a bare prepositional qualifier "with kids" (2026-07-13 pattern)', () => {
    // Re-ask analysis (chat d2cb18b9, 2.9 min gap): "best things to do on sunshine
    // coast" → "with kids". A constraint added to the prior question that opens with a
    // preposition, so it matched none of the opener patterns and fell through blind.
    const out = enrichFollowUpReference('with kids', history(ASSISTANT_LONG));
    expect(out).toContain('topic from my previous response');
    expect(out.startsWith('with kids')).toBe(true);
  });

  it('enriches other bare qualifier fragments ("for beginners", "under $500", "in winter")', () => {
    for (const frag of ['for beginners', 'under $500', 'in winter', 'without a car']) {
      const out = enrichFollowUpReference(frag, history(ASSISTANT_LONG));
      expect(out).toContain('CONVERSATION CONTEXT');
    }
  });

  it('does NOT treat a self-contained prepositional question as a qualifier fragment', () => {
    // "In what year …" opens with a preposition but carries its own interrogative +
    // is a complete question — must NOT be rewritten as a continuation of the prior turn.
    const msg = 'In what year did the Berlin Wall fall?';
    expect(enrichFollowUpReference(msg, history(ASSISTANT_LONG))).toBe(msg);
  });

  it('does NOT treat a long prepositional sentence as a qualifier fragment', () => {
    // >40 chars → not a bare qualifier, so the qualifier path stays out of the way.
    const msg = 'For the record I already booked the entire trip last week';
    expect(enrichFollowUpReference(msg, history(ASSISTANT_LONG))).toBe(msg);
  });

  it('fires onEnrich with kind="implicit" for continuations', () => {
    const calls: any[] = [];
    enrichFollowUpReference('how much would that cost', history(ASSISTANT_LONG), (i) => calls.push(i));
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('implicit');
  });

  it('does NOT fire onEnrich when nothing is enriched', () => {
    const calls: any[] = [];
    enrichFollowUpReference('The quarterly revenue figures look strong overall', history(ASSISTANT_LONG), (i) => calls.push(i));
    expect(calls).toHaveLength(0);
  });
});

describe('enrichFollowUpReference — retry requests (2026-07-09)', () => {
  // Re-ask analysis (chat b7f99171): a bare "try again" after a failed short answer
  // ("Let me search more specifically...") must re-attach the ORIGINAL question, not
  // the failed assistant stub, so the models re-answer the real question.
  const retryHistory: ConversationMessage[] = [
    { role: 'user', content: 'what is the newest english One Piece volume out now and the release timeline' },
    { role: 'assistant', content: 'Let me search more specifically for the current One Piece English volume release info.' },
  ];

  it('re-attaches the prior user question for a bare "try again"', () => {
    const out = enrichFollowUpReference('try again', retryHistory);
    expect(out).not.toBe('try again');
    expect(out).toContain('the question to retry');
    expect(out).toContain('newest english One Piece volume');
    expect(out.startsWith('try again')).toBe(true);
  });

  it('handles "retry", "redo that", "one more time"', () => {
    for (const msg of ['retry', 'redo that', 'one more time', 'Please try again.']) {
      const out = enrichFollowUpReference(msg, retryHistory);
      expect(out).toContain('the question to retry');
    }
  });

  it('fires onEnrich with kind="implicit" for a retry', () => {
    const calls: any[] = [];
    enrichFollowUpReference('try again', retryHistory, (i) => calls.push(i));
    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe('implicit');
  });

  it('skips chained retry turns to find the real question', () => {
    const chained: ConversationMessage[] = [
      { role: 'user', content: 'what is the capital of Australia' },
      { role: 'assistant', content: 'Let me look that up.' },
      { role: 'user', content: 'try again' },
      { role: 'assistant', content: 'One moment.' },
    ];
    const out = enrichFollowUpReference('again', chained);
    expect(out).toContain('capital of Australia');
  });

  it('returns unchanged when there is no prior user question', () => {
    expect(enrichFollowUpReference('try again', [])).toBe('try again');
  });
});
