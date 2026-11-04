/**
 * TICKET efdb3d31 — severed-stream recovery (emission side).
 *
 * These pin the ONE decision that can now differ when a gateway severs the SSE
 * stream mid-tool-call. The rows that motivated it read
 * `gw "gateway recv=39 acc=39 drop=0 frag=6 buf=0"` with
 * `finishReason=tool_calls` — every byte appended, payload simply stopped.
 *
 * The critical assertion in this file is the NARROWNESS one: `undefined` (no
 * sentinel on this provider, or a synthesized turn) must NEVER fire. Widening
 * that gate would preempt the C-2 dispatch-reject-repair lane and break its two
 * pinned tests (agent-context.c.test.ts) — the exact regression this test
 * exists to make impossible to land silently.
 */
import {
  shouldReemitSeveredStream,
  severedStreamVerdict,
  severedStreamMeta,
  severedStreamRecoveryDisabled,
} from './severed-stream';
// The REAL read-surface contract: jsonb canonicalises keys by LENGTH then
// bytewise, so key order must be asserted through these, never through a
// JSON.stringify of the writer's own insertion order (post-merge review fix).
import { canonicalMetaJson, jsonbCanonicalKeys } from './tool-call-finalize-meta';

const COMPLETE = '{"goalId": "8f0dcd6f-9469-48a7-87a9-8bba1fc4237d", "progressNote": "N"}';
const CUT_39 = '{"goalId": "8f0dcd6f-9469-48a7-87a9-8bb';
const CUT_67 = '{"goalId": "8f0dcd6f-9469-48a7-87a9-8bba1fc4237d", "progressNote": ';
// The THIRD live signature (Fleet-measured 2026-10-30T00:50Z): a 1,961-byte
// save_supervisor_state body that ends UNTERMINATED with fr=null — a complete-
// looking payload whose stream gave no finish_reason at all. Length-faithful.
const CUT_1961 = `{"sessionId": "s", "state": "${'x'.repeat(1930)}`;

const turn = (over: Partial<{ streamCompleted: boolean; toolCalls: Array<{ name?: string; arguments?: string }> }> = {}) => ({
  streamCompleted: false as boolean | undefined,
  toolCalls: [{ name: 'goal_update', arguments: CUT_39 }],
  ...over,
});

beforeEach(() => {
  delete process.env.SEVERED_STREAM_RECOVERY_DISABLED;
});
afterEach(() => {
  delete process.env.SEVERED_STREAM_RECOVERY_DISABLED;
});

describe('efdb3d31 — a KNOWN-severed stream is re-emitted instead of dispatched', () => {
  it('fires on streamCompleted:false with a partial tool call', () => {
    expect(shouldReemitSeveredStream(turn(), false, false)).toBe(true);
  });

  it('fires for the 67-byte family too (header complete, VALUE absent)', () => {
    // The two families are distinct (39 stops inside the goalId uuid, 67 stops
    // exactly after the progressNote KEY) and BOTH must be caught — the
    // correction that they were ever one signature is why this is asserted.
    expect(CUT_67.endsWith('"progressNote": ')).toBe(true);
    expect(shouldReemitSeveredStream(turn({ toolCalls: [{ name: 'goal_update', arguments: CUT_67 }] }), false, false)).toBe(true);
  });
});

describe('efdb3d31 — the gate is NARROW by construction (the C-2 protection)', () => {
  it('does NOT fire when the stream is severed but the payload arrived COMPLETE', () => {
    // The sentinel-less-provider guard. This reader documents that some
    // OpenAI-compatible gateways (a LiteLLM/vLLM proxy — llm.example.com) never send
    // `[DONE]` and just close the socket. On such a path EVERY turn reads
    // streamCompleted:false, so firing on the sentinel alone would re-emit
    // EVERY tool-calling turn forever — doubled spend on the very endpoint this
    // remedy exists to heal. A complete payload must never re-emit.
    expect(shouldReemitSeveredStream(turn({ streamCompleted: false, toolCalls: [{ name: 'goal_update', arguments: COMPLETE }] }), false, false)).toBe(false);
  });

  it('does NOT fire on a MALFORMED payload — every byte arrived, so that is the C-2 lane', () => {
    // 'malformed' vs 'truncated' is the shipped classifier's own distinction:
    // only 'truncated' means bytes went missing in transit.
    expect(shouldReemitSeveredStream(turn({ toolCalls: [{ name: 'goal_update', arguments: '{"a": 1,}' }] }), false, false)).toBe(false);
    expect(shouldReemitSeveredStream(turn({ toolCalls: [{ name: 'goal_update', arguments: '[1,2]' }] }), false, false)).toBe(false);
  });

  it('a multi-call turn with a complete sibling DISPATCHES instead of spending the one re-emit', () => {
    // efdb3d31 (2026-10-30) — THIS ASSERTION REVERSED, deliberately.
    //
    // It previously read "fires if ANY call in a multi-call turn is structurally
    // cut" and returned true. That is right for a turn that is NOTHING BUT a
    // severed head (there is no work to run, so re-asking is the only move), and
    // it stays right for that case — the very next assertion still pins it. It is
    // wrong when a SIBLING in the same turn arrived whole: the gate then throws
    // away finished work AND spends the run's single re-emit on it, which is a
    // one-shot budget the NEXT, genuinely all-cut turn needs.
    //
    // MEASURED (24 h to 2026-10-30T16:28Z, `severed_stream_recovery` = 24 rows):
    // six rows are mixed turns — len [2377,84] 16:14:04Z, [31,67] 14:59:34Z,
    // [1136,838,41] 11:32:37Z, [62,39] 08:07:58Z, [1693,641] 10:47:44Z,
    // [786,1052,1147,2172] 06:05:31Z — all with a large PARSING call beset by a
    // small opaque-id-headed twin (todo_update/goal_update). And the budget
    // starvation is visible in the same chat: the 16:14:04Z mixed turn consumed
    // the re-emit, after which the 16:14:31Z / 16:14:45Z / 16:14:57Z
    // `todo_update` cuts all carry `re:1` (budget already spent) and re-cut at
    // 84/84/41 bytes. Dispatching the mixed turn executes the intact call
    // immediately and leaves the re-emit for a turn that can actually use it.
    expect(shouldReemitSeveredStream(turn({
      toolCalls: [
        { name: 'goal_get', arguments: COMPLETE },
        { name: 'goal_update', arguments: CUT_39 },
      ],
    }), false, false)).toBe(false);
    // …and the decision names its own arm, so this is not silently "no gate".
    expect(severedStreamVerdict(turn({
      toolCalls: [
        { name: 'goal_get', arguments: COMPLETE },
        { name: 'goal_update', arguments: CUT_39 },
      ],
    }), false, false)).toBe('complete-sibling');
  });

  it('a multi-call turn with NO complete sibling still re-emits (the all-cut case is untouched)', () => {
    // The narrowness that keeps the reversal above safe: if every call in the
    // turn is cut, there is nothing to execute and re-asking is still the only
    // move. This is the defect's own normal form (the 39-byte goal_update).
    expect(shouldReemitSeveredStream(turn({
      streamCompleted: true,
      toolCalls: [
        { name: 'goal_update', arguments: CUT_39 },
        { name: 'todo_update', arguments: CUT_67 },
      ],
    }), false, false)).toBe(true);
    // An EMPTY-payload sibling is NOT a licence to dispatch: `parseToolArguments`
    // accepts '' as `{}`, so counting it as complete would let a zero-arg
    // MUTATING call fire off the back of a severed turn (the 2026-08-30 audit
    // invariant this module exists to keep shut).
    expect(shouldReemitSeveredStream(turn({
      streamCompleted: true,
      toolCalls: [
        { name: 'git_push', arguments: '' },
        { name: 'goal_update', arguments: CUT_39 },
      ],
    }), false, false)).toBe(true);
    expect(severedStreamVerdict(turn({
      streamCompleted: true,
      toolCalls: [
        { name: 'git_push', arguments: '   ' },
        { name: 'goal_update', arguments: CUT_39 },
      ],
    }), false, false)).toBe('reemit');
  });

  it('does NOT fire when streamCompleted is undefined (no sentinel on this provider, or a synthesized turn)', () => {
    // THE load-bearing assertion. agent-context.c.test.ts's MALFORMED_TURN
    // fixture carries no streamCompleted, so the C-2 lane keeps sole ownership
    // of the ambiguous "is this a cut or a model formatting fault" case.
    expect(shouldReemitSeveredStream(turn({ streamCompleted: undefined }), false, false)).toBe(false);
    expect(shouldReemitSeveredStream(turn({ streamCompleted: undefined }), false, false)).toBe(false);
  });

  it('DOES fire on a CLEAN transport whose payload still stops mid-structure — the live llm-cql shape', () => {
    // efdb3d31 CORRECTION (2026-10-30): this assertion used to read
    // "does NOT fire on a CLEAN stream" and it is the reason the guard never
    // fired. The live reproductions carry finish_reason:tool_calls while the
    // assembled payload stops inside the goalId uuid (39 bytes) or after the
    // progressNote key (67). Whether the [DONE] frame arrived is a SEPARATE
    // question from finish_reason (which rides inside the delta body) — and
    // either way a structurally unfinished payload means the harness was
    // about to dispatch half a call, so it must re-emit. This is the
    // delivered-shape proof, not a claim about the transport.
    expect(shouldReemitSeveredStream(turn({ streamCompleted: true }), false, false)).toBe(true);
    expect(shouldReemitSeveredStream(turn({ streamCompleted: true, toolCalls: [{ name: 'update_plan', arguments: CUT_67 }] }), false, false)).toBe(true);
  });

  it('still does NOT fire on a CLEAN stream carrying a COMPLETE or merely MALFORMED payload', () => {
    // The cost guard that survives the correction above: re-emitting is only
    // justified when bytes are MISSING. A complete payload, and a payload that
    // arrived whole but is invalid JSON (a model formatting fault), both stay
    // with the rejection text / C-2 repair lane — otherwise a model with a
    // formatting bug would pay a doubled round-trip on every single call.
    expect(shouldReemitSeveredStream(turn({ streamCompleted: true, toolCalls: [{ name: 'goal_update', arguments: COMPLETE }] }), false, false)).toBe(false);
    expect(shouldReemitSeveredStream(turn({ streamCompleted: true, toolCalls: [{ name: 'goal_update', arguments: '{"a": 1,}' }] }), false, false)).toBe(false);
  });

  it('does NOT fire on an answer-less turn — that is isEmptyTruncatedTurn lane', () => {
    expect(shouldReemitSeveredStream(turn({ toolCalls: [] }), false, false)).toBe(false);
  });

  it('fires ONCE per run: a gateway that severs every stream cannot loop us', () => {
    expect(shouldReemitSeveredStream(turn(), true, false)).toBe(false);
  });

  it('never fires after Stop', () => {
    expect(shouldReemitSeveredStream(turn(), false, true)).toBe(false);
  });
});

describe('efdb3d31 — kill switch restores the pre-fix behaviour exactly', () => {
  it('SEVERED_STREAM_RECOVERY_DISABLED=1 is total', () => {
    process.env.SEVERED_STREAM_RECOVERY_DISABLED = '1';
    expect(severedStreamRecoveryDisabled()).toBe(true);
    expect(shouldReemitSeveredStream(turn(), false, false)).toBe(false);
  });

  it('any other value (or unset) leaves the lane armed', () => {
    for (const v of [undefined, '', '0', 'true']) {
      if (v === undefined) delete process.env.SEVERED_STREAM_RECOVERY_DISABLED;
      else process.env.SEVERED_STREAM_RECOVERY_DISABLED = v;
      expect(shouldReemitSeveredStream(turn(), false, false)).toBe(true);
    }
  });
});

describe('efdb3d31 — the guard\'s decision table (2026-10-30 correction)', () => {
  /**
   * WHY A TABLE. The guard's unreachability was invisible for a day because no
   * stored field named WHICH condition rejected a turn; the `sc`/`fr`/`re` keys
   * now ride on every dispatch_reject row, and this table is the contract those
   * keys are read against. Every arm here maps to a live row shape.
   */
  it('names its own reason for every live shape', () => {
    // The defect's normal form: CLEAN transport (sc=1, the sentinel arrived),
    // provider declared the turn complete (fr=tool_calls), payload stops inside
    // the goalId uuid at 39 bytes. The OLD guard returned false on this — 100%
    // of the 41bd202a rows — which is what "dead by construction" meant.
    expect(severedStreamVerdict(turn({ streamCompleted: true }), false, false)).toBe('reemit');
    // Third signature (Fleet-measured 00:50Z): fr=null, body ends unterminated.
    expect(severedStreamVerdict(turn({ streamCompleted: true, toolCalls: [{ name: 'save_supervisor_state', arguments: CUT_1961 }] }), false, false)).toBe('reemit');
    // Genuinely severed transport (no sentinel) — the original lane, preserved.
    expect(severedStreamVerdict(turn({ streamCompleted: false }), false, false)).toBe('reemit');
    // A COMPLETE payload is never re-emitted, clean transport or not: the cost
    // bound. A model that emits valid JSON must not pay a doubled round-trip.
    expect(severedStreamVerdict(turn({ streamCompleted: true, toolCalls: [{ name: 'goal_update', arguments: COMPLETE }] }), false, false)).toBe('complete-payload');
    // No transport information at all = the C-2 lane's ambiguous case, never ours.
    expect(severedStreamVerdict(turn({ streamCompleted: undefined }), false, false)).toBe('no-transport-signal');
    // Bounded at one per run; Stop wins.
    expect(severedStreamVerdict(turn({ streamCompleted: true }), true, false)).toBe('already-recovered');
    expect(severedStreamVerdict(turn({ streamCompleted: true }), false, true)).toBe('cancelled');
    // Answer-less turns belong to isEmptyTruncatedTurn (turn-recovery.ts).
    expect(severedStreamVerdict(turn({ streamCompleted: true, toolCalls: [] }), false, false)).toBe('no-tool-calls');
  });

  it('the boolean entry point AGREES with the table on every arm', () => {
    const cases: Array<[any, boolean, boolean]> = [
      [turn({ streamCompleted: true }), false, false],
      [turn({ streamCompleted: true, toolCalls: [{ name: 'save_supervisor_state', arguments: CUT_1961 }] }), false, false],
      [turn({ streamCompleted: false }), false, false],
      [turn({ streamCompleted: true, toolCalls: [{ name: 'goal_update', arguments: COMPLETE }] }), false, false],
      [turn({ streamCompleted: undefined }), false, false],
      [turn({ streamCompleted: true }), true, false],
      [turn({ streamCompleted: true }), false, true],
      [turn({ streamCompleted: true, toolCalls: [] }), false, false],
    ];
    for (const [t, rec, cancel] of cases) {
      // Two functions, ONE rule — a drift between them is how the branch and the
      // telemetry start telling different stories (the region's worst bug).
      expect(shouldReemitSeveredStream(t, rec, cancel)).toBe(severedStreamVerdict(t, rec, cancel) === 'reemit');
    }
  });
});

describe('efdb3d31 — the re-emit row answers the Fleet probe that had no data', () => {
  it('carries reasoningChars (rz) and per-call argLen (len) on the SAME row', () => {
    // No stored finalize/dispatch_reject row has EVER carried reasoningChars,
    // which is why "reasoningChars vs argLen" was unanswerable. This row
    // computes both for one turn.
    const meta = severedStreamMeta(
      turn({ toolCalls: [{ name: 'goal_update', arguments: CUT_39 }, { name: 'goal_get', arguments: CUT_67 }] }),
      12345,
      'api-optimize-xiaomi-mimo-v2.6-pro',
      'llm-cql (custom endpoint)',
      'tool_calls',
    );
    expect(meta.rz).toBe(12345);
    expect(meta.len).toEqual([CUT_39.length, CUT_67.length]);
    expect(meta.calls).toBe(2);
    expect(meta.finishReason).toBe('tool_calls');
    expect(meta.label).toBe('llm-cql (custom endpoint)');
  });

  it('is BYTE-FREE — never carries payload content', () => {
    const meta = severedStreamMeta(turn(), 1, 'm', 'l', 'tool_calls');
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain('goalId');
    expect(serialized).not.toContain('progressNote');
  });

  it('leads with the short keys so both survive the 240-char meta read cut', () => {
    // TELEMETRY_META_CHARS = 240 (fleet-telemetry.ts truncMeta) and jsonb orders
    // keys by LENGTH first, so `rz`/`len` cannot be cut away by long neighbours.
    //
    // POST-MERGE REVIEW FIX (2026-10-29): this assertion used to JSON.stringify
    // the object in INSERTION order, which tests the writer's own literal — it
    // would have passed even if `severedStreamMeta` emitted the long keys first.
    // jsonb canonicalises by key length then bytewise, so the contract must be
    // asserted against the CANONICAL order the database actually returns.
    const meta = severedStreamMeta(
      turn({ toolCalls: [{ name: 'goal_update', arguments: 'x'.repeat(9) }] }),
      999,
      'a-really-long-model-id-that-would-otherwise-eat-the-cut',
      'llm-cql (custom endpoint)',
      'tool_calls',
    );
    // What a reader actually receives.
    const canonical = canonicalMetaJson(meta);
    expect(canonical.indexOf('"rz"')).toBeGreaterThanOrEqual(0);
    expect(canonical.indexOf('"len"')).toBeGreaterThanOrEqual(0);
    expect(canonical.indexOf('"rz"')).toBeLessThan(240);
    expect(canonical.indexOf('"len"')).toBeLessThan(240);
    // rz (2 chars) must precede every longer key in the canonical order — the
    // reason the key was chosen short in the first place.
    expect(jsonbCanonicalKeys(meta)[0]).toBe('rz');
    // And the order must NOT be merely the insertion order (guards against the
    // tautology this test previously contained).
    expect(jsonbCanonicalKeys(meta)).not.toEqual(Object.keys(meta));
  });
});
describe('efdb3d31 — the 2026-10-30 05:41:03Z row is DECIDABLE, and refutes "the gate cannot fire"', () => {
  /**
   * WHY THIS BLOCK EXISTS. A Fleet read of the live row
   *
   *   05:41:03.354Z chat 41bd202a run chat-bb7
   *   {ab:39, rb:39, db:0, ub:0, fr:"tool_calls", re:1, sc:1, argLen:39}
   *
   * concluded that the re-emit gate "structurally cannot fire" because the turn
   * finished cleanly (sc=1) and proposed widening it to fire on ANY unparseable
   * payload regardless of finish reason. Both halves of that reading are wrong,
   * and this block pins the correction so the proposal cannot be re-derived
   * from the same row:
   *
   *  1. `sc=1` does NOT reject the turn. The shipped gate only rejects
   *     `undefined`; a clean transport carrying a mid-structure cut returns
   *     'reemit'. (Asserted in the CLEAN-transport block above.)
   *  2. `re=1` means a re-emit was ALREADY SPENT in that very run — so the gate
   *     fired and this row is its OUTCOME, not its absence. A row carrying
   *     re=1 can never be evidence that the gate failed to fire.
   */
  it('reports already-recovered (not "cannot fire") for the exact live row shape', () => {
    const liveRow = turn({ streamCompleted: true, toolCalls: [{ name: 'goal_update', arguments: CUT_39 }] });
    // The gate FIRED earlier in this run — that is what re:1 encodes.
    expect(severedStreamVerdict(liveRow, true, false)).toBe('already-recovered');
    // And with the re-emit NOT yet spent, the identical turn re-emits.
    expect(severedStreamVerdict(liveRow, false, false)).toBe('reemit');
    // The branch and the telemetry agree on both arms (one rule, not two).
    expect(shouldReemitSeveredStream(liveRow, true, false)).toBe(false);
    expect(shouldReemitSeveredStream(liveRow, false, false)).toBe(true);
  });

  it('re=1 is a SPENT-BUDGET fact, never a rejection reason', () => {
    // The four row shapes that reach a dispatch_reject with re:1 all mean "the
    // re-request ran and its payload was rejected too" — the verdict for the
    // ALREADY-spent state is 'already-recovered' regardless of cut shape, which
    // is precisely why reading re:1 as "the guard is too narrow" inverts it.
    for (const cut of [CUT_39, CUT_67, CUT_1961]) {
      const t = turn({ streamCompleted: true, toolCalls: [{ name: 'goal_update', arguments: cut }] });
      expect(severedStreamVerdict(t, true, false)).toBe('already-recovered');
    }
  });

  it('no COMPLETE twin can hide in that turn: 39 bytes < the 49-byte minimum goal_update', () => {
    // The "paired truncated twin" theory needs a complete payload to have
    // arrived alongside the cut one. It cannot: the gateway row reports
    // recv=39 TOTAL bytes for the whole turn, and the shortest legal
    // goal_update — goalId alone, no progressNote — is 49 bytes:
    //   {"goalId": "   = 12
    //   <36-char uuid> = 36
    //   "              = 1   → 49 before any second key opens
    // So at 39 bytes the uuid is cut at character 27 of 36 and NO complete
    // payload exists anywhere in the turn to be dropped. This is arithmetic on
    // the row, not an inference from an absent field.
    const MIN_VALID_GOAL_UPDATE = '{"goalId": "' + '0'.repeat(36) + '"}';
    expect(MIN_VALID_GOAL_UPDATE.length).toBe(50); // one-key form WITH the closing brace
    expect('{"goalId": "'.length).toBe(12);
    // A 39-byte payload stops 10 bytes short of even the brace-less 49.
    expect(CUT_39.length).toBe(39);
    expect(CUT_39.length).toBeLessThan('{"goalId": "'.length + 36 + 1);
    // It stops INSIDE the uuid, 27 chars in — so the progressNote key has not
    // opened yet and any "shorter note / shorter payload" advice cannot help.
    expect(CUT_39.length - 12).toBe(27);
    expect(CUT_39).not.toContain('progressNote');
  });
});
