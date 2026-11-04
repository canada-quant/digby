/**
 * Replay for ticket c5cf2858 — the TRUNCATED-payload rejection contract.
 *
 * WHY THIS FILE EXISTS. This defect class has now recurred three times
 * (aa59535b → efdb3d31 → c5cf2858) and each round rewrote the SAME advice
 * string with NO test pinning it — so the harmful prescription kept coming
 * back. The production fix for this instance landed in PR #2098 (commit
 * 200d9d0b2): it records the SSE `[DONE]` sentinel, adds a bounded one-shot
 * re-emit for a severed turn (severed-stream.ts, pinned by
 * severed-stream.test.ts) and rewrote this text. What #2098 did NOT add is a
 * pin on the TEXT ITSELF or on the shape classifier for this ticket's live
 * payloads. That is the gap this file closes — it is the regression guard that
 * makes the recurrence stop recurring.
 *
 * THE INCIDENT (supervisor chat 5c3f302e, 2026-10-29 22:21:09–22:23:25Z, run
 * chat-d370926c). Three `todo_update` calls and one `update_supervisor_state`
 * call were rejected as TRUNCATED IN TRANSIT; the writes did not land. The
 * rejection was CORRECT and loud — nothing truncated ever executed, the
 * 2026-08-30 invariant held — so the defect was never "silent execution". The
 * harm was the ADVICE: the pre-#2098 text told the model to "re-emit the call
 * with DIFFERENT bytes — shorter values, fewer fields, or split the work across
 * several smaller calls", and a seat obeyed it, walking one write down a size
 * ladder (89 → 39 → 17 bytes) and failing at every size.
 *
 * WHY THAT ADVICE IS WRONG, MEASURED. Every transport row for this family
 * (fleet telemetry, kind `tool_call_finalize`) reads `drop=0 acc==recv buf=0`.
 * SUPERSEDED (2026-10-30, ticket 9b2b3798): this header used to conclude "so
 * the cut is the transport severing the stream". That inference is NOT sound —
 * `coding-model.ts` documents three shapes (an unparseable `data:` frame, a
 * line without the `data:` prefix, argument bytes in a shape the accumulator
 * cannot read) that lose real fragments while `recv == acc` still reads clean
 * and `drop=0` "blames the gateway". Keep the part the rows DO support — no
 * size threshold exists, so a shorter payload does not land past the cut — and
 * do not revive the transport verdict on `acc==recv` alone.
 * Dispatched argLens span 12 → 3,983 chars (12, 17, 20, 39, 41, 64, 67, 84,
 * 116, 164, 312, 321, 406, 468, 840, 869, 1111, 1346, 1743, 1810, 2190, 2217,
 * 2224, 2943, 3983) and finish_reason is `tool_calls` or null, never `length`.
 * No size threshold exists, so a smaller payload does not land past the cut.
 */
import { parseToolArguments, toolArgumentRejection, endsMidJsonStructure } from './tool-arguments';
import { hasStructurallyTruncatedCall } from './severed-stream';

/**
 * This ticket's live dispatched lengths, from its own `dispatch_reject` rows
 * (2026-10-29T22:21:09Z / 22:22:20Z / 22:23:10Z / 22:23:25Z). The payloads are
 * sliced from realistic complete bodies to those exact lengths, so the fixtures
 * are the measured cuts rather than invented ones.
 */
const LIVE_CUTS: Array<{ tool: string; argLen: number; body: string }> = [
  // {"todoId": "…", "progressNote": "…"} — 39 chars dies INSIDE the todoId uuid.
  { tool: 'todo_update', argLen: 39, body: '{"todoId": "177d52a5-63a2-4726-a976-42d0befa5494", "progressNote": "lane finished"}' },
  // 17 chars is barely past the opening brace — the severest observed cut.
  { tool: 'todo_update', argLen: 17, body: '{"todoId": "177d52a5-63a2-4726-a976-42d0befa5494", "progressNote": "lane finished"}' },
  // The long-payload shape: a supervisor state document cut at 2,224 chars.
  {
    tool: 'update_supervisor_state',
    argLen: 2224,
    body: `{"state": "## Framework Operator - current state\\n${'x'.repeat(3000)}", "applied": 6}`,
  },
];

const rejectionFor = (tool: string, raw: string): { text: string; argLen: number } => {
  const parsed = parseToolArguments(raw);
  if (parsed.ok) throw new Error(`expected ${tool} to be rejected at len ${raw.length}`);
  expect(parsed.shape).toBe('truncated');
  return { text: toolArgumentRejection(tool, parsed), argLen: parsed.argLen };
};

describe('replay c5cf2858 — every live cut is classified TRUNCATED', () => {
  it.each(LIVE_CUTS)('$tool at $argLen chars', ({ tool, argLen, body }) => {
    const raw = body.slice(0, argLen);
    expect(raw.length).toBe(argLen);
    // The classifier must agree with the gateway's own verdict on these shapes:
    // a payload that stops inside a string literal is a transport cut.
    expect(endsMidJsonStructure(raw)).toBe(true);
    const { text, argLen: reported } = rejectionFor(tool, raw);
    expect(reported).toBe(argLen);
    expect(text).toContain('TRUNCATED IN TRANSIT');
    // The safety statement the reporter needed: nothing executed, nothing to undo.
    expect(text).toContain('NOTHING was executed');
    expect(text).toContain(tool);
    // And the measured length travels, so the next occurrence is diagnosable.
    expect(text).toContain(String(argLen));
  });

  it('a payload 17 chars long and one 2,224 chars long are the SAME class', () => {
    // Size independence is the analytic point of this ticket: a length
    // threshold cannot stand in for the test.
    const short = rejectionFor('todo_update', LIVE_CUTS[0].body.slice(0, 17)).text;
    const long = rejectionFor('update_supervisor_state', LIVE_CUTS[2].body.slice(0, 2224)).text;
    for (const t of [short, long]) {
      expect(t).toContain('TRUNCATED IN TRANSIT');
      expect(t).toContain('NOTHING was executed');
    }
  });
});

describe('replay c5cf2858 — the text must NEVER again prescribe a shrinking ladder', () => {
  // The three exact phrasings that produced the 89 → 39 → 17 spiral. This is
  // the recurrence guard: they must not come back in ANY class's text.
  const BANNED = [/shorter values/i, /smaller calls/i, /re-emit the call with DIFFERENT bytes/i];

  it('the truncated text carries none of the harmful prescriptions', () => {
    const { text } = rejectionFor('todo_update', LIVE_CUTS[0].body.slice(0, 39));
    for (const re of BANNED) expect(text).not.toMatch(re);
  });

  it('no class at all reintroduces the shrink prescription', () => {
    for (const payload of ['{"todoId": "abc1', '{"a": 1,}', '[1,2]']) {
      const parsed = parseToolArguments(payload);
      if (parsed.ok) throw new Error('expected rejection');
      const text = toolArgumentRejection('save_supervisor_state', parsed);
      for (const re of BANNED) expect(text).not.toMatch(re);
    }
  });

  it('says in plain words that shrinking is not the repair', () => {
    const { text } = rejectionFor('todo_update', LIVE_CUTS[0].body.slice(0, 39));
    // The shipped framing: too-long is explicitly NOT the signal.
    expect(text).toMatch(/not a signal that your payload was too long/i);
    expect(text).toMatch(/shrinking your values only loses information/i);
  });

  it('refuses to blame the wire — and refuses the OPPOSITE unproven cause (ticket 9b2b3798)', () => {
    const { text } = rejectionFor('todo_update', LIVE_CUTS[0].body.slice(0, 39));
    // 9b2b3798: the old text asserted "bytes were lost between the gateway and
    // this harness" / "the transport is severing the stream mid-payload". Agents
    // read it back and escalated into transport-fix tickets. It must not return.
    expect(text).not.toMatch(/bytes were lost between the gateway/i);
    expect(text).not.toMatch(/transport is severing the stream/i);
    // The trap: `recv == acc` / `drop = 0` does NOT prove the wire was clean
    // (coding-model.ts documents three shapes that lose real bytes while those
    // counters read clean), and this seam cannot see ur/pf/sk/pc anyway. So the
    // answer is neither direction — it names the ambiguity.
    expect(text).not.toMatch(/every byte the gateway emitted reached this harness/i);
    expect(text).not.toMatch(/no harness-side reader, accumulator or decoder can mend it/i);
    expect(text).toMatch(/what this seam KNOWS is that the argument arrived incomplete/i);
    expect(text).toMatch(/CANNOT see is why, and it will not guess/i);
    // And it keeps clearing the model of a formatting fault (MALFORMED owns that).
    expect(text).toMatch(/not a formatting fault on your side/i);
  });

  it('does not spend the model on a transport theory (ticket 9b2b3798)', () => {
    const { text } = rejectionFor('todo_update', LIVE_CUTS[0].body.slice(0, 39));
    // The concrete cost of the old wording: a seat filed an escalation ticket
    // commissioning a transport fix instead of reshaping its call.
    expect(text).toMatch(/do not spend a turn on a transport theory and do not file one/i);
    // It must NOT assert the one-shot re-emit was necessarily spent: the
    // non-streaming seam never re-emits, and undefined / cancelled / kill-switch
    // all dispatch a truncated rejection with the remedy unspent.
    expect(text).toMatch(/where that path is available/i);
    expect(text).toMatch(/either already been spent or does not apply here/i);
  });

  it('bounds the retry and requires the loss to be reported', () => {
    const { text } = rejectionFor('todo_update', LIVE_CUTS[0].body.slice(0, 39));
    expect(text).toMatch(/do NOT keep retrying the identical call/i);
    // The load-bearing consequence for a supervisor: the next wake must be told
    // the write did not land rather than inheriting a silent gap.
    expect(text).toMatch(/say so plainly in your note if a cut repeats/i);
    // It must not claim the cut point is deterministic (it is not — see header).
    expect(text).not.toMatch(/ALWAYS FAILS THE SAME/i);
    expect(text).not.toMatch(/usually fails the same/i);
  });

  it('never claims a truncated call partly executed', () => {
    const { text } = rejectionFor('save_supervisor_state', LIVE_CUTS[2].body.slice(0, 2224));
    expect(text).toContain('NOTHING was executed');
  });
});

describe('replay c5cf2858 — the emission-side gate recognises this ticket\'s shapes', () => {
  // The re-emit lane (PR #2098) must see these exact cuts as transport-severed,
  // because that is what turns "rejected and lost" into "retried once".
  it.each(LIVE_CUTS)('$tool at $argLen chars is structurally truncated', ({ tool, argLen, body }) => {
    expect(hasStructurallyTruncatedCall({
      streamCompleted: false,
      toolCalls: [{ name: tool, arguments: body.slice(0, argLen) }],
    })).toBe(true);
  });
});

describe('replay c5cf2858 — the other two classes keep their distinct advice', () => {
  it('MALFORMED still says every byte arrived and retrying is safe', () => {
    const parsed = parseToolArguments('{"a": 1,}');
    if (parsed.ok) throw new Error('expected rejection');
    const text = toolArgumentRejection('todo_update', parsed);
    expect(text).toContain('MALFORMED');
    expect(text).toMatch(/every byte arrived/i);
    expect(text).not.toContain('TRUNCATED IN TRANSIT');
  });

  it('NOT-OBJECT still explains the container requirement', () => {
    const parsed = parseToolArguments('[1,2]');
    if (parsed.ok) throw new Error('expected rejection');
    const text = toolArgumentRejection('todo_update', parsed);
    expect(text).toContain('NOT AN OBJECT');
    expect(text).toMatch(/nothing was lost in transit/i);
    expect(text).not.toMatch(/severing the stream/i);
  });
});