/**
 * Replay for ticket 9b2b3798 — the TRUNCATED rejection must not assert a cause
 * the seam cannot observe.
 *
 * THE INCIDENT (Schooltime supervisor chat 41bd202a, 2026-10-30 ~11:32–11:48Z,
 * run chat-fa7a4283). Five `todo_update` calls were rejected as TRUNCATED IN
 * TRANSIT at 499 / 80 / 41 / 19 chars; the writes for todo 9933e675 never
 * landed and the supervisor had to route the same content as chat steers. The
 * ticket's diagnosis was "a stream-level severance in the tool-call transport,
 * not payload size" — and it quoted this text as its evidence, which read:
 *
 *   "so bytes were lost between the gateway and this harness … the transport
 *    is severing the stream mid-payload"
 *
 * WHY THAT CAUSE CLAIM WAS WRONG. The ticket's own rows read `recv == acc`,
 * `drop=0`, `buf=0`, `sc=1` (11:36:38Z argLen=499; 11:39:09Z argLen=80;
 * 11:45:41Z argLen=41; 11:47:23Z argLen=19 — `tool_call_finalize`, read
 * 2026-10-30T16:41Z). Those counters do NOT prove the wire was clean, which is
 * the trap: `coding-model.ts` documents three shapes (an unparseable `data:`
 * frame, a line without the `data:` prefix, and argument bytes in a shape the
 * accumulator cannot read) where real fragments are lost while `recv == acc`
 * still reads perfectly and `drop=0` "blames the gateway". So the honest
 * statement is neither "bytes were lost in transit" (the retired claim) NOR
 * "every byte reached us" (the equally unproven replacement this file's first
 * draft carried). THIS seam — `toolArgumentRejection(toolName, failure)` — sees
 * only `reason` / `shape` / `argLen`. It cannot see ANY of those counters, so it
 * must state the ambiguity and point at the diagnostics instead of picking a
 * side. That is the defect this file pins.
 *
 * WHAT MUST STAY TRUE (guards NOT relaxed here): nothing truncated ever
 * executes; the truncated class stays distinguishable from MALFORMED /
 * NOT-OBJECT; the reshape hint still reaches prefix-resolved id tools; and the
 * text still refuses the shrink ladder that walked a seat 89 → 39 → 17.
 */
import { parseToolArguments, toolArgumentRejection, truncatedIdReshapeHint } from './tool-arguments';
import { hasStructurallyTruncatedCall } from './severed-stream';

const TODO_ID = '9933e675-1111-4222-8333-944455556666';

/**
 * A payload long enough that ALL FOUR of this ticket's live cut points land
 * mid-structure (600 chars — verified, not assumed: the first draft of this
 * file used a 129-char body, so `slice(0, 499)` was complete JSON and the
 * suite went red). The shape is the real one: the id first, then the title,
 * then the prose progressNote where the 499-char cut lands.
 */
const FULL = JSON.stringify({
  todoId: TODO_ID,
  title: 'expand the fix to 4 files',
  progressNote:
    'Re-pointed the assignee to lane 60dfc8a8 and expanded this todo from one file to four: the streaming seam in tool-arguments.ts, the two per-ticket replay suites that already pin the older wording, and a new 9b2b3798 regression file whose whole job is to keep this rejection message honest about what it can and cannot observe from inside a parse failure. The supervisor had to route all of this content through chat-message steers instead, which is the fallback this ticket exists to stop needing.',
});

/** This ticket's live cut lengths (19 / 41 / 80 / 499), all inside FULL. */
const LIVE_CUTS = [19, 41, 80, 499] as const;

const rejectionOf = (raw: string) => {
  const parsed = parseToolArguments(raw);
  if (parsed.ok) throw new Error(`expected a rejection at len ${raw.length}`);
  expect(parsed.shape).toBe('truncated');
  return { text: toolArgumentRejection('todo_update', parsed), argLen: parsed.argLen };
};

describe('replay 9b2b3798 — every live cut is rejected, nothing executes', () => {
  it('the fixture is long enough that 499 is a genuine CUT, not the whole payload', () => {
    // The guard on the fixture itself: a body shorter than the largest cut
    // silently turns that case into a valid parse and the suite stops testing it.
    expect(FULL.length).toBeGreaterThan(500);
    expect(parseToolArguments(FULL).ok).toBe(true); // the complete form DOES parse
  });

  it.each(LIVE_CUTS)('todo_update at %i chars is TRUNCATED and refused', (len) => {
    const { text, argLen } = rejectionOf(FULL.slice(0, len));
    expect(argLen).toBe(len);
    expect(text).toContain('TRUNCATED IN TRANSIT');
    // The 2026-08-30 invariant: a severed payload NEVER executes.
    expect(text).toContain('NOTHING was executed');
    expect(parseToolArguments(FULL.slice(0, len)).ok).toBe(false);
  });

  it('the emission-side gate still sees these shapes as structurally unfinished', () => {
    // The one-shot re-emit must keep firing on this class; this ticket changed
    // the CAUSE SENTENCE only, never the detector.
    for (const len of LIVE_CUTS) {
      expect(hasStructurallyTruncatedCall({
        streamCompleted: true,
        toolCalls: [{ name: 'todo_update', arguments: FULL.slice(0, len) }],
      })).toBe(true);
    }
    // And a COMPLETE payload must never be re-emitted off this classifier.
    expect(hasStructurallyTruncatedCall({
      streamCompleted: true,
      toolCalls: [{ name: 'todo_update', arguments: FULL }],
    })).toBe(false);
  });
});

describe('replay 9b2b3798 — the message states what the seam can SEE, and no more', () => {
  // The retired claim, quoted back by the ticket as its evidence.
  const RETIRED_CAUSE = [
    /bytes were lost between the gateway/i,
    /transport is severing the stream/i,
    /severed stream mid-payload/i,
  ];

  it.each(LIVE_CUTS)('a cut at %i chars does not blame the wire', (len) => {
    const { text } = rejectionOf(FULL.slice(0, len));
    for (const re of RETIRED_CAUSE) expect(text).not.toMatch(re);
  });

  it('does not swap in the OPPOSITE unproven cause ("every byte reached us")', () => {
    // The trap this file's first draft fell into: `recv == acc` / `drop = 0`
    // does NOT prove the wire was clean (see the header — three documented
    // shapes lose real bytes while those counters read clean), and this seam
    // cannot see `ur` / `pf` / `sk` / `pc` anyway. So it must not assert either
    // direction.
    const { text } = rejectionOf(FULL.slice(0, 41));
    expect(text).not.toMatch(/every byte the gateway emitted reached this harness/i);
    expect(text).not.toMatch(/already this short when it left the gateway/i);
    expect(text).not.toMatch(/no harness-side reader, accumulator or decoder can mend it/i);
  });

  it('names the ambiguity and points at the counters that would settle it', () => {
    const { text } = rejectionOf(FULL.slice(0, 41));
    expect(text).toMatch(/what this seam KNOWS is that the argument arrived incomplete/i);
    expect(text).toMatch(/CANNOT see is why, and it will not guess/i);
    // Both surviving branches are named, so neither is smuggled in as THE cause.
    expect(text).toMatch(/emitted short/i);
    expect(text).toMatch(/bytes may have been lost above this harness/i);
    expect(text).toMatch(/stream diagnostics/i);
  });

  it('sends the model AWAY from filing a transport ticket off this rejection', () => {
    // The concrete cost of the old wording: a seat filed an escalation ticket
    // commissioning a transport fix instead of reshaping its call.
    const { text } = rejectionOf(FULL.slice(0, 19));
    expect(text).toMatch(/do not spend a turn on a transport theory and do not file one/i);
  });

  it('does not over-claim that the one-shot re-emit was necessarily spent', () => {
    // Verified paths where it was NOT: the non-streaming seam (tool-executor.ts
    // never re-emits), `streamCompleted === undefined`, a cancelled turn, and
    // SEVERED_STREAM_RECOVERY_DISABLED. So the text must not assert it ran.
    const { text } = rejectionOf(FULL.slice(0, 80));
    expect(text).not.toMatch(/already spent by itself/i);
    expect(text).toMatch(/where that path is available/i);
    expect(text).toMatch(/either already been spent or does not apply here/i);
  });
});

describe('replay 9b2b3798 — the classes stay distinct', () => {
  it('TRUNCATED says the argument arrived incomplete; MALFORMED says every byte arrived', () => {
    // aa59535b's contract is that the classes carry OPPOSITE cause claims. The
    // truncated class must not drift into claiming completeness, or the two
    // collapse into one message and the advice inverts for one of them.
    const truncated = rejectionOf(FULL.slice(0, 19)).text;
    expect(truncated).toMatch(/stops mid-structure/i);
    expect(truncated).not.toMatch(/every byte arrived/i);

    const malformed = parseToolArguments('{"todoId": "abc",}');
    if (malformed.ok) throw new Error('expected a rejection');
    const malformedText = toolArgumentRejection('todo_update', malformed);
    expect(malformedText).toContain('MALFORMED');
    expect(malformedText).toMatch(/every byte arrived/i);
    expect(malformedText).not.toContain('TRUNCATED IN TRANSIT');
  });

  it('NOT-OBJECT still says nothing was lost in transit', () => {
    const notObject = parseToolArguments('[1,2]');
    if (notObject.ok) throw new Error('expected a rejection');
    const text = toolArgumentRejection('todo_update', notObject);
    expect(text).toContain('NOT AN OBJECT');
    expect(text).toMatch(/nothing was lost in transit/i);
  });
});

describe('replay 9b2b3798 — the refuted levers stay refuted', () => {
  it('still refuses the shrink ladder the old text provoked', () => {
    const { text } = rejectionOf(FULL.slice(0, 41));
    // The phrasings that walked a seat 89 → 39 → 17 with no success.
    for (const re of [/shorter values/i, /smaller calls/i]) expect(text).not.toMatch(re);
    expect(text).toMatch(/not a signal that your payload was too long/i);
    expect(text).toMatch(/shrinking your values only loses information/i);
    // The lever that IS field-validated: change the shape.
    expect(text).toMatch(/change the SHAPE of the work rather than the SIZE/i);
  });

  it('still carries the information-preserving reshape for this ticket\'s tool', () => {
    // todo_update is prefix-resolved, so the 28-byte id reshape applies to
    // exactly the cuts that landed inside the id (19 and 41 here).
    expect(truncatedIdReshapeHint('todo_update')).toContain('unique 8-char PREFIX');
    expect(rejectionOf(FULL.slice(0, 41)).text).toContain('unique 8-char PREFIX');
    // The hint must not reintroduce a transport claim of its own.
    expect(truncatedIdReshapeHint('todo_update')).not.toMatch(/severing|bytes were lost/i);
  });

  it('never claims a deterministic re-cut point', () => {
    // This ticket's own cuts at 19/41/80/499 refute any fixed cut point.
    const { text } = rejectionOf(FULL.slice(0, 499));
    expect(text).not.toMatch(/ALWAYS FAILS THE SAME/i);
    expect(text).not.toMatch(/usually fails the same/i);
  });
});