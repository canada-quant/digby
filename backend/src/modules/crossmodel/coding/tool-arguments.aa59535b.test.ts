/**
 * REPLAY — ticket aa59535b.
 *
 * Reported (project supervisor chat 5c3f302e, 'One Piece TCG', two machine wakes
 * on 2026-10-29): supervisor tool calls were losing their arguments in transit.
 * Two shapes were named, and they are the reason this test exists:
 *
 *   1. `schedule_message` with a ~2,100-char prompt: "Expected ',' or '}' after
 *      property value in JSON at position 1743" — i.e. the JSON arrived cut at
 *      byte 1743.
 *   2. `todo_update(progressNote)`: 'Unexpected end of JSON input' five times on
 *      the 18:06Z wake and again on the 18:31Z wake — "including payloads as
 *      short as ~180 chars".
 *
 * "...as short as ~180 chars" is the sentence that tempts a LENGTH fix, and a
 * length fix is wrong: the reporter's own receipts show the same tool dying at
 * 17 chars (18:17:58.346Z, 18:17:29.263Z), 39, 64 and 92 chars, while the SAME
 * seat landed a todo_update at 17:54:39.298Z (receipt a2e6545b, todo
 * 177d52a5-…-42d0befa5494) and a schedule_message at 18:35:11.271Z (receipt
 * e5b6b011, schedule 8e869991-…). So on this transport a re-emit often lands.
 * No threshold on argLen can separate "cut" from "complete", and none is added
 * here.
 *
 * WHAT WAS ACTUALLY WRONG (the defect this pins).
 *
 * The seam already REJECTED these payloads correctly — nothing truncated ever
 * executed, which is the 2026-08-30 audit invariant and is re-asserted below.
 * The defect was that it could not say WHICH failure it had, so it said the
 * wrong thing to the model:
 *
 *   • every rejection got the single efdb3d31 text, which asserts "the payload
 *     arrived CUT SHORT (truncated in transit)" and "RE-ISSUING THE IDENTICAL
 *     CALL USUALLY FAILS THE SAME WAY". For a COMPLETE-but-mistyped payload
 *     that is a false diagnosis: it sends the model hunting a transport fault
 *     that does not exist. (efdb3d31's own 5/5 byte-identical cut was ONE seat
 *     on ONE shape; the reporter here landed the same tool after cuts at
 *     17/39/64/92, so the "identical re-send re-cuts" law does not generalise.)
 *   • the telemetry row carried no class, so the fleet could not count transport
 *     cuts apart from formatting mistakes — the ticket itself had to be argued
 *     from parser strings.
 *
 * THE CLASSIFIER IS STRUCTURAL, NOT MESSAGE-PARSED.
 *
 * `endsMidJsonStructure` reads only the payload the model actually sent: does it
 * stop inside a string literal, or with a `{`/`[` still open? That is
 * engine-independent and survives `sanitizeJsonParseReason` (which must run
 * first so no payload text reaches a transcript, and which rewrites the V8
 * message the naive approach would have keyed on). The matrix below is the
 * measurement that chose it: each shape is asserted against its expected class,
 * and every truncation case carries the DISPATCHED length from the live
 * receipts so a regression that reintroduces a length threshold fails here.
 */
import { endsMidJsonStructure, parseToolArguments, toolArgumentRejection } from './tool-arguments';

/** A complete, valid payload of the reported shape — the control. */
const COMPLETE_TODO_ARGS = JSON.stringify({
  todoId: '177d52a5-63a2-4726-a976-42d0befa5494',
  progressNote: 'Read the discriminator output and report the named half',
});

describe('ticket aa59535b — the two reported shapes are classified TRUNCATED', () => {
  it('the ~2,100-char schedule_message prompt cut at byte 1743 (live shape)', () => {
    // The reporter's error names position 1743 on a prompt of ~2,100 chars, so
    // the payload as dispatched was 1743 chars, severed inside the prompt value.
    const dispatched = '{"chatId":"5c3f302e-0b8c-413a-b22d-60b60b84445f","prompt":"'
      + 'Supervisor note: '.padEnd(1710, 'x');
    expect(dispatched.length).toBeGreaterThan(1700);
    const parsed = parseToolArguments(dispatched);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('truncated');
    expect(parsed.argLen).toBe(dispatched.length);
  });

  it('the ~180-char todo_update progressNote cut mid-string (live shape)', () => {
    const dispatched = '{"todoId":"177d52a5-63a2-4726-a976-42d0befa5494","progressNote":"Drain triage parked until the disc';
    const parsed = parseToolArguments(dispatched);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('truncated');
  });

  it('a cut as SHORT as the live 17-char row is still TRUNCATED, not a size error', () => {
    // 18:17:29.263Z / 18:17:58.346Z dispatched argLen=17 with 'Unexpected end of
    // JSON input'. A payload this short cannot be an argument-COUNT limit and
    // must not be reported as "too large" — it is a severance.
    const dispatched = '{"todoId": "abc12';
    expect(dispatched.length).toBe(17);
    const parsed = parseToolArguments(dispatched);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('truncated');
    expect(parsed.argLen).toBe(17);
  });
});

describe('ticket aa59535b — a COMPLETE payload is never called truncated', () => {
  // The opposite error, and the one the flat efdb3d31 text actually committed:
  // telling the model bytes were lost when every byte arrived.
  const malformed: Array<[string, string]> = [
    ['trailing comma', '{"a": 1,}'],
    ['single quotes', "{'a': 1}"],
    ['unquoted key', '{a: 1}'],
    ['missing colon', '{"a" 1}'],
    ['balanced prefix then garbage', '{"a":1} xyz'],
    ['two complete objects concatenated', '{"a":1}{"b":2}'],
    ['stray interior quote', '{"a": "he said "hi""}'],
  ];

  it.each(malformed)('classifies %s as MALFORMED (all bytes arrived)', (_label, text) => {
    const parsed = parseToolArguments(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('malformed');
    expect(endsMidJsonStructure(text)).toBe(false);
  });

  it('a literal newline in a string value is REPAIRED, so it never reaches a rejection', () => {
    // 5bdbb126's lossless control-char repair (escapeUnescapedControlChars) runs
    // BEFORE the classification is computed, so this shape parses and executes
    // correctly — it must NOT be reclassified as 'truncated' by the new scan.
    const parsed = parseToolArguments('{"note": "line1\nline2"}');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.args.note).toBe('line1\nline2');
    expect(parsed.repaired).toBe('control-chars');
  });

  it('classifies a bare array as NOT-OBJECT (valid JSON, wrong container)', () => {
    const parsed = parseToolArguments('[1,2]');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.shape).toBe('not-object');
  });

  it('a complete valid payload still parses (no over-eager rejection)', () => {
    const parsed = parseToolArguments(COMPLETE_TODO_ARGS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('unreachable');
    expect(parsed.args.todoId).toBe('177d52a5-63a2-4726-a976-42d0befa5494');
  });
});

describe('ticket aa59535b — endsMidJsonStructure matrix (the measurement behind the rule)', () => {
  // Truncation shapes, including fixtures modelled on every live dispatch length
  // from the reporter's receipts. Each label states the length the fixture
  // ACTUALLY has (asserted below), so no claim is made that the fixture is
  // byte-identical to a receipt row: the lived lengths were 17/39/64/92/94,
  // 1743 and 2190 — these reproduce their SHAPE, not their exact bytes.
  const truncated: Array<[string, string]> = [
    ['live todo_update shape, 19 chars', '{"todoId": "abc1234'],
    ['live todo_update shape, 44 chars', '{"todoId": "86911a13-aaaa-bbbb-cccc-ddddeeee'],
    ['live schedule_message shape, 1734 chars', '{"chatId":"x","prompt":"' + 'y'.repeat(1710)],
    ['live get_chat_status shape, 60 chars', '{"chatId":"5c3f302e-0b8c-413a-b22d-60b60b84445f","extra":"ab'],
    ['live save_supervisor_state shape, 2190 chars', '{"key":"a","value":"' + 'z'.repeat(2170)],
    ['cut after a comma', '{"a":1,'],
    ['cut after a colon', '{"a":'],
    ['cut at the opening brace', '{'],
    ['value complete, closing brace missing', '{"a": "hello"'],
    ['nested cut inside an array', '{"a":{"b":[1,2'],
    ['cut inside a key', '{"todo'],
    ['cut inside a literal (tru…)', '{"a": tru'],
    ['cut then trailing newline', '{"a":1\n'],
    ['cut then trailing spaces', '{"a": "hi"   '],
    ['nested container left open', '{"a":{"b":1}'],
    ['nested string unterminated', '{"a":{"b":"xx'],
    ['cut after an escaped quote', '{"a": "he \\"said\\" and th'],
  ];

  it.each(truncated)('TRUNCATED: %s', (_label, text) => {
    // The label must state this fixture's real length (review finding N3).
    const claimed = Number(_label.match(/(\d+) chars$/)?.[1]);
    if (!Number.isNaN(claimed)) expect(text.length).toBe(claimed);
    expect(endsMidJsonStructure(text)).toBe(true);
  });

  it('reports a COMPLETE payload with a mismatched closer as malformed, not truncated', () => {
    // Review finding N1: every byte arrived, the closers are simply mismatched.
    // A depth COUNTER calls these truncated and would tell the model that bytes
    // were lost; the type-aware stack must not.
    for (const text of ['{"a":[1,2}', '{"a":{"b":1]', '[{"a":1]', '{"a":[1,2}}']) {
      expect(endsMidJsonStructure(text)).toBe(false);
      const parsed = parseToolArguments(text);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error('unreachable');
      expect(parsed.shape).toBe('malformed');
    }
  });

  it('never reports truncation for a non-string or empty payload', () => {
    expect(endsMidJsonStructure('')).toBe(false);
    expect(endsMidJsonStructure(undefined)).toBe(false);
    expect(endsMidJsonStructure({ a: 1 })).toBe(false);
    expect(endsMidJsonStructure(null)).toBe(false);
  });

  it('the classifier is LENGTH-INDEPENDENT: same class at 1 char and 20k chars', () => {
    // Guards against a future "if (argLen < N) …" shortcut creeping in.
    expect(endsMidJsonStructure('{')).toBe(true);
    expect(endsMidJsonStructure('{"a":"' + 'x'.repeat(20_000))).toBe(true);
    expect(endsMidJsonStructure('{"a":1}')).toBe(false);
    expect(endsMidJsonStructure('{"a":"' + 'x'.repeat(20_000) + '"}')).toBe(false);
  });
});

describe('ticket aa59535b — the rejection text must match the class', () => {
  const failureOf = (payload: string) => {
    const p = parseToolArguments(payload);
    if (p.ok) throw new Error('expected a rejection');
    return p;
  };

  it('a TRUNCATED payload states only what the seam can see, and quotes the argLen', () => {
    const failure = failureOf('{"todoId": "abc1');
    const text = toolArgumentRejection('todo_update', failure);
    expect(text).toContain('TRUNCATED IN TRANSIT');
    expect(text).toContain(String(failure.argLen));
    // The ticket's own ask: an explicit statement of what happened, not a bare
    // JSON.parse message. What happened is that the argument arrived incomplete.
    expect(text).toMatch(/the argument arrived incomplete/i);
    // 9b2b3798: it must assert NEITHER cause — not transport byte-loss (the
    // retired claim) and not its unproven opposite ("every byte reached us").
    expect(text).not.toMatch(/bytes were lost/i);
    expect(text).not.toMatch(/severing the stream/i);
    expect(text).not.toMatch(/every byte the gateway emitted reached this harness/i);
    // It must still gate on NOTHING executed.
    expect(text).toContain('NOTHING was executed');
  });

  it('a TRUNCATED payload NEVER claims the cut point is deterministic', () => {
    // efdb3d31's 5/5 byte-identical cut is one seat/one shape; the reporter here
    // landed the same tool after cuts at 17/39/64/92. A blanket "re-sending
    // fails the same way" law is therefore wrong and must not be asserted.
    const text = toolArgumentRejection('todo_update', failureOf('{"todoId": "abc1'));
    expect(text).not.toMatch(/ALWAYS FAILS THE SAME/i);
    expect(text).not.toMatch(/usually fails the same/i);
  });

  it('a MALFORMED payload says every byte arrived and that retrying is safe', () => {
    const text = toolArgumentRejection('todo_update', failureOf('{"a": 1,}'));
    expect(text).toContain('MALFORMED');
    expect(text).toMatch(/every byte arrived/i);
    // The false diagnosis the flat text used to make:
    expect(text).not.toContain('TRUNCATED IN TRANSIT');
    // And it must name the usual repair causes.
    expect(text).toMatch(/newline/i);
  });

  it('a NOT-OBJECT payload explains the container requirement', () => {
    const text = toolArgumentRejection('todo_update', failureOf('[1,2]'));
    expect(text).toContain('NOT AN OBJECT');
    expect(text).toMatch(/nothing was lost in transit/i);
  });

  it('every class still names the tool and says nothing executed', () => {
    for (const payload of ['{"todoId": "abc1', '{"a": 1,}', '[1,2]']) {
      const text = toolArgumentRejection('schedule_message', failureOf(payload));
      expect(text).toContain('schedule_message');
      expect(text).toContain('NOTHING was executed');
    }
  });
});

describe('ticket aa59535b — the 2026-08-30 invariant holds: a cut never executes', () => {
  // Classification is advice + telemetry. It must never soften the rejection.
  it.each([
    '{"todoId": "abc1',
    '{"chatId":"x","prompt":"' + 'y'.repeat(400),
    '{"goalId": "86911a13-aaaa',
    '{"a":',
    '{',
  ])('still rejects %s', (payload) => {
    const parsed = parseToolArguments(payload);
    expect(parsed.ok).toBe(false);
  });
});