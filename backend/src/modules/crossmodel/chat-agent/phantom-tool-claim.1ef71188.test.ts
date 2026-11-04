/**
 * REPLAY — ticket 1ef71188 (mishap, 2026-09-27): "Assistant claimed 'web
 * search came back garbage' without ever running a search".
 *
 * The incident, as the persisted telemetry actually reads (re-probed
 * 2026-09-28, review B1): the claim sentence sat in the guest-chat answer
 * finalized 21:24:48Z — a run that itself made 2 web_pipe calls. Guests
 * persist no per-part rows, so the INTRA-RUN ordering (claim text before or
 * after those calls) is NOT recoverable from any persisted source; the
 * follow-up turn (first paint 21:35:02Z) re-tested search healthy (3 calls,
 * finalized 21:37:38) and self-filed this ticket. What the incident PROVES:
 * the platform search was healthy, an answer narrated a search failure to
 * the user, and no persisted evidence can back the narration's ordering.
 * Whether it was a fabricated attempt or an exaggerated quality judgment on
 * its own 2 calls is unprovable — so the fixtures below replay the CLASS
 * (a web-failure claim positioned where the run's parts show no preceding
 * web call), not a proven incident replay.
 *
 * This file pins the detector (chat-agent/phantom-tool-claim.ts) against
 * that class and its precision contract: the unbacked claim fires; every
 * honest shape (a claim that FOLLOWS a real web call, an undated reference
 * to an earlier turn's search, guard-marked harness text, a NON-web tool's
 * backed failure narration with a recency anchor) stays silent. The
 * finalize-seam wiring (the 'chat_phantom_web_claim' loop metric) is pinned
 * in search-discipline.test.ts.
 */

import { findUnbackedWebFailureClaim } from './phantom-tool-claim';

/** The incident's claiming sentence, verbatim in substance. */
const INCIDENT_CLAIM = 'I tried to pull fresher 2026 web material just now and the search came back garbage.';

const text = (t: string) => ({ type: 'text', text: t });
const call = (name: string) => ({ type: 'tool_call', name, args: {} });
const result = (name: string, r: string) => ({ type: 'tool_result', name, result: r });

describe('findUnbackedWebFailureClaim — the ticket-1ef71188 claim class', () => {
  it('the class shape fires: the claim streams BEFORE any web call, a re-test comes after (selfCorrected)', () => {
    // NOTE: this ordering is the CLASS shape, not a proven replay — the real
    // incident's intra-run ordering is unrecoverable (guest runs persist no
    // per-part rows; its run made 2 web_pipe calls of its own).
    const finding = findUnbackedWebFailureClaim({
      parts: [
        text('Here are some couples costume ideas based on what you said…'), // pre-claim answer text
        text(INCIDENT_CLAIM),
        call('search_engine'), // a later in-turn search — the self-correction signal
        result('search_engine', 'primark.com 9 Sept 2026, brit.co 8 Sept 2026…'),
        call('web_pipe'),
        result('web_pipe', '{"ok":true}'),
      ],
      finalText: 'Here are fresher picks for 2026…',
    });
    expect(finding).toBeTruthy();
    expect(finding!.tier).toBe('midturn');
    expect(finding!.selfCorrected).toBe(true); // the web calls ran later in the SAME run
    expect(finding!.excerpt).toContain('came back garbage');
  });

  it('the class with NO later web call fires midturn, selfCorrected:false', () => {
    const finding = findUnbackedWebFailureClaim({
      parts: [text('Ideas first…'), text(INCIDENT_CLAIM)],
      finalText: 'Answering from memory instead.',
    });
    expect(finding).toMatchObject({ tier: 'midturn', selfCorrected: false });
  });

  it('the claim as the FINAL answer of a run with zero web calls fires tier:final', () => {
    const finding = findUnbackedWebFailureClaim({ parts: [], finalText: `Short version: ${INCIDENT_CLAIM}` });
    expect(finding).toMatchObject({ tier: 'final', selfCorrected: false });
  });
});

describe('findUnbackedWebFailureClaim — precision contract (honest text never fires)', () => {
  it('a claim that FOLLOWS a real web call this run is an honest report — never fires', () => {
    const finding = findUnbackedWebFailureClaim({
      parts: [
        call('search_engine'),
        result('search_engine', '{"error":"upstream 502"}'), // a REAL failed search
        text('I tried to pull fresher material just now and the search came back garbage, so here is what I know.'),
      ],
      finalText: 'Answer without fresh sources.',
    });
    expect(finding).toBeNull();
  });

  it('a final-text claim in a run that made web calls never fires (the calls are its evidence)', () => {
    const finding = findUnbackedWebFailureClaim({
      parts: [call('web_pipe'), result('web_pipe', '{"ok":true}')],
      finalText: `I tried just now and the search came back garbage, so treat these as memory-based.`,
    });
    expect(finding).toBeNull();
  });

  it('an UNDATED failure reference (an earlier turn\'s search) never fires — this run\'s parts can neither back nor refute it', () => {
    const finding = findUnbackedWebFailureClaim({
      parts: [text('The search earlier came back garbage, so I will work from what we had.')],
      finalText: 'Here you go.',
    });
    expect(finding).toBeNull();
  });

  it('a NON-web tool\'s backed failure narration with a recency anchor never fires (review FP finding)', () => {
    // The first cut's non-web control lacked a RECENCY anchor, so it proved
    // nothing: the reviewer showed an honest, fully parts-BACKED non-web
    // tool failure narrated with "right now" fired, because the signal
    // regexes matched any tool's failure prose while the positional gate
    // counted only web tools. The WEB-SCOPE signal closes that class.
    const finding = findUnbackedWebFailureClaim({
      parts: [
        call('list_chats'),
        result('list_chats', '{"error":"upstream unavailable"}'),
        text('Sorry — I just tried calling list_chats and it failed, so I cannot show your chats right now.'),
      ],
      finalText: 'Sorry about that.',
    });
    expect(finding).toBeNull();
  });

  it('a web call with a real failing result, narrated honestly AFTER the call, never fires', () => {
    const finding = findUnbackedWebFailureClaim({
      parts: [
        call('scrape_as_markdown'),
        result('scrape_as_markdown', 'error: target site returned 403'),
        text('That scrape failed — the site blocked us — so here is the fallback.'),
      ],
      finalText: 'Fallback answer.',
    });
    expect(finding).toBeNull();
  });

  it('guard-marked and struck harness text is never scanned', () => {
    const guard = { type: 'text', text: INCIDENT_CLAIM, marker: 'guard' };
    const struck = { type: 'text', text: INCIDENT_CLAIM, struck: true };
    expect(findUnbackedWebFailureClaim({ parts: [guard, struck], finalText: 'clean' })).toBeNull();
  });

  it('quality grumbling about GOOD results with no failure wording never fires', () => {
    const finding = findUnbackedWebFailureClaim({
      parts: [text('I ran a search just now and the results were not great for this question.')],
      finalText: 'Answer.',
    });
    expect(finding).toBeNull();
  });
});

describe('findUnbackedWebFailureClaim — totality (never throws)', () => {
  it.each([
    ['null input', null],
    ['undefined input', undefined],
    ['empty object', {}],
    ['non-array parts', { parts: 'nope', finalText: INCIDENT_CLAIM }],
    ['garbage parts entries', { parts: [null, 42, 'x', {}, { type: 'tool_call' }], finalText: '' }],
    ['non-string finalText', { parts: [], finalText: 12345 }],
  ])('%s returns a finding or null — never throws', (_label, input) => {
    expect(() => findUnbackedWebFailureClaim(input as any)).not.toThrow();
  });
});
