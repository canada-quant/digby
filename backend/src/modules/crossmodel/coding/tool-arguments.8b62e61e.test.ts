/**
 * REPLAY — ticket 8b62e61e. THE SEVERED-IN-TRANSIT CLASS AT THE ACCEPTANCE SEAM.
 *
 * THE ROW THIS PINS (copied verbatim from the live emit site, still firing at
 * 2026-11-01T21:30Z — 45 such rows in the preceding 48 h):
 *
 *   tool-call stream [api-optimize-xiaomi-mimo-v2.6-pro]: GATEWAY-OR-OURS gateway
 *   recv=134 acc=134 drop=0 frag=25 buf=0 fr=tool_calls sc=1
 *   verdict=no_complete_payload — receivedBytes=134 accumulatedBytes=134
 *   droppedBytes=0 fragments=25 undrainedBufferBytes=0 finishReason=tool_calls
 *   slots=1 named=1 unnamed=0 broken=0:goal_update:len134:Unexpected end of JSON
 *   input discardedComplete=[] claims=none
 *
 * Every fact needed to name the half is already on that row: `recv == acc`
 * (134 == 134 — every byte the gateway sent we appended), `drop=0`, `buf=0`,
 * `fr=tool_calls` (the provider declared the turn COMPLETE), `sc=1` (the done
 * sentinel arrived). The payload still stopped mid-structure at 134 chars.
 *
 * THE DEFECT THIS FIXES. `toolArgumentRejection` was handed only
 * `(toolName, failure)`, so it could not see ANY of that. Every structurally
 * unfinished payload therefore got the same hedged text — "it may have been
 * emitted short, or its bytes may have been lost above this harness" — even on
 * rows where the turn's own arithmetic had already settled it. And because the
 * re-emit budget is per-RUN (`rr`), the hedge is the ONLY remedy left for every
 * cut after the first: chat daee2916 took three cuts in 2.5 minutes
 * (21:19:35Z / 21:20:37Z / 21:21:57Z, all `goal_update`), each carrying
 * `sv:"already-recovered" rr:1 re:0`, and attempts 2 and 3 arrived as a generic
 * "did not parse as a JSON object" — indistinguishable from a model that had
 * mangled its own JSON. `discardedComplete=[]` then read as "nothing was lost".
 *
 * WHAT IS ASSERTED HERE:
 *   1. the fixture classifies as `severed-in-transit` (the loud class);
 *   2. the model-facing text states the half DECISIVELY and does NOT hedge, and
 *      still prescribes the field-validated reshape-not-shrink repair;
 *   3. every ours-side counter and every missing measurement DEGRADES to the
 *      hedge (`cut-shape-unclassified`) — the classifier only asserts what the
 *      turn proves, per the aa59535b / 9b2b3798 misdiagnosis rule;
 *   4. a complete-but-invalid payload is NOT swept into the transport class;
 *   5. the class reaches the durable row as a 2-char `ec` key (source-pinned,
 *      because that is the row the fleet counts).
 *
 * NOT A RETRY TEST. Retries are measured-and-refuted for this class (the
 * re-request re-cuts at the same byte) and PR #2125's gate-widening was refuted
 * and reverted; neither is re-litigated here.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  classifyToolCallLoss,
  toolArgumentRejection,
  type ToolArgumentsFailure,
} from './tool-arguments';

/**
 * The live row's turn, field for field. `receivedBytes === accumulatedBytes`,
 * every ours-side counter zero, the provider declaring completion.
 */
const LIVE_ROW_EVIDENCE = {
  finishReason: 'tool_calls',
  receivedBytes: 134,
  accumulatedBytes: 134,
  droppedBytes: 0,
  undrainedBufferBytes: 0,
  unreadArgBytes: 0,
  skippedRawLines: 0,
  multilineDataEvents: 0,
  parseFailLines: 0,
  parseFailToolCalls: 0,
} as const;

/** The parser verdict the live row carried: `goal_update:len134:Unexpected end of JSON input`. */
const LIVE_ROW_FAILURE: ToolArgumentsFailure = {
  ok: false,
  reason: 'Unexpected end of JSON input',
  shape: 'truncated',
  argLen: 134,
};

describe('8b62e61e — classifyToolCallLoss names a severed-in-transit call', () => {
  it('classifies the exact live row as severed-in-transit', () => {
    expect(classifyToolCallLoss(LIVE_ROW_FAILURE, LIVE_ROW_EVIDENCE))
      .toBe('severed-in-transit');
  });

  it('does not depend on the model name, the byte length, or the tool', () => {
    // PROVIDER-INDEPENDENT and length-independent: the same class fires on
    // kimi-k3 and deepseek-flash, and observed cut points span 17 → 6,246 bytes
    // on this ticket alone. Nothing here keys on any of those.
    for (const argLen of [17, 39, 134, 199, 1303, 1591, 1791, 1956, 6246]) {
      const failure = { ...LIVE_ROW_FAILURE, argLen };
      const evidence = {
        ...LIVE_ROW_EVIDENCE,
        receivedBytes: argLen,
        accumulatedBytes: argLen,
      };
      expect(classifyToolCallLoss(failure, evidence)).toBe('severed-in-transit');
    }
  });

  it('every ours-side counter VOIDS the class (the cut becomes unclassified, not the gateway\'s)', () => {
    // Each of these means BYTES WE RECEIVED were dropped, unparsed, unread or
    // skipped — so "the gateway sent it short" is no longer provable. This is
    // the same voiding list `gatewayOrOurs` uses; drift between the two would
    // put blame on the wrong side of the seam.
    const voiding: Array<[string, Record<string, number>]> = [
      ['droppedBytes', { droppedBytes: 7 }],
      ['undrainedBufferBytes', { undrainedBufferBytes: 12 }],
      ['unreadArgBytes', { unreadArgBytes: 5 }],
      ['skippedRawLines', { skippedRawLines: 1 }],
      ['multilineDataEvents', { multilineDataEvents: 2 }],
      ['parseFailLines', { parseFailLines: 3 }],
      ['parseFailToolCalls', { parseFailToolCalls: 1 }],
    ];
    for (const [counter, override] of voiding) {
      expect([counter, classifyToolCallLoss(LIVE_ROW_FAILURE, {
        ...LIVE_ROW_EVIDENCE,
        ...override,
      })]).toEqual([counter, 'cut-shape-unclassified']);
    }
  });

  it('a NONZERO recv-acc gap is unclassified — the arithmetic must actually agree', () => {
    expect(classifyToolCallLoss(LIVE_ROW_FAILURE, {
      ...LIVE_ROW_EVIDENCE,
      accumulatedBytes: 120,
    })).toBe('cut-shape-unclassified');
  });

  it('an output-cap finish_reason is NOT this class (a different, handled cut)', () => {
    for (const finishReason of ['length', null, undefined, 'stop', '']) {
      expect([finishReason, classifyToolCallLoss(LIVE_ROW_FAILURE, {
        ...LIVE_ROW_EVIDENCE,
        finishReason,
      })]).toEqual([finishReason, 'cut-shape-unclassified']);
    }
  });

  it('no evidence at all keeps the hedge (an unmeasured cut is never named)', () => {
    expect(classifyToolCallLoss(LIVE_ROW_FAILURE)).toBe('cut-shape-unclassified');
    // Measured bytes are required: defaults must not stand in for a measurement.
    expect(classifyToolCallLoss(LIVE_ROW_FAILURE, {
      finishReason: 'tool_calls',
      droppedBytes: 0,
      undrainedBufferBytes: 0,
    })).toBe('cut-shape-unclassified');
  });

  it('complete-but-invalid payloads are NOT swept into the transport class', () => {
    // The live evidence is loud, but these failures are complete on their own
    // terms — the model CAN fix them, so they must keep their own text.
    const malformed: ToolArgumentsFailure = {
      ok: false, reason: 'x', shape: 'malformed', argLen: 40,
    };
    const notObject: ToolArgumentsFailure = {
      ok: false, reason: 'x', shape: 'not-object', argLen: 40,
    };
    expect(classifyToolCallLoss(malformed, LIVE_ROW_EVIDENCE)).toBe('malformed');
    expect(classifyToolCallLoss(notObject, LIVE_ROW_EVIDENCE)).toBe('not-object');
  });
});

describe('8b62e61e — the model-facing text states the half instead of hedging', () => {
  const text = toolArgumentRejection('goal_update', LIVE_ROW_FAILURE, LIVE_ROW_EVIDENCE);

  it('names the class and the deciding measurements', () => {
    expect(text).toContain('SEVERED IN TRANSIT');
    expect(text).toContain('finish_reason=tool_calls');
    expect(text).toContain('received=134');
    // The invariant every rejection shared and must keep.
    expect(text).toContain('NOTHING was executed');
  });

  it('does NOT hedge about the half it just proved', () => {
    // The old text's exact hedge — the sentence that let a gateway cut read as
    // a model formatting fault. It must survive ONLY on the unclassified arm.
    expect(text).not.toContain('may have been emitted short, or its bytes may have been lost');
    expect(text).not.toContain('TRUNCATED IN TRANSIT');
  });

  it('keeps the field-validated repair: reshape, never shrink', () => {
    expect(text).toMatch(/RESHAPE|change the SHAPE/i);
    expect(text).toMatch(/not the SIZE of its values/);
    expect(text).toMatch(/prefix/i);
  });

  it('tells the model this is not its fault, so it stops diagnosing transport', () => {
    expect(text).toMatch(/not a claim about you/i);
    expect(text).toMatch(/HARNESS-CLASSIFIED/);
  });

  it('the unclassified arm KEEPS the hedge (no over-claim where we cannot see)', () => {
    const hedged = toolArgumentRejection('goal_update', LIVE_ROW_FAILURE, {
      ...LIVE_ROW_EVIDENCE,
      // A counter that voids the reading, as a real row can.
      undrainedBufferBytes: 9,
    });
    expect(hedged).toContain('TRUNCATED IN TRANSIT');
    expect(hedged).toContain('will not guess');
    expect(hedged).not.toContain('SEVERED IN TRANSIT');
    // And with NO evidence passed at all — every legacy caller.
    const legacy = toolArgumentRejection('goal_update', LIVE_ROW_FAILURE);
    expect(legacy).toContain('TRUNCATED IN TRANSIT');
    expect(legacy).not.toContain('SEVERED IN TRANSIT');
  });
});

describe('8b62e61e — the class reaches the durable row (the one the fleet counts)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, 'agent.ts'),
    'utf8',
  );

  it('runTool writes a 2-char `ec` class key on the rejection row', () => {
    // loop_metrics.meta is JSONB (keys re-sorted shortest-first) and the fleet
    // read truncates around 240 chars, so the class key MUST be 2 chars or it
    // is read-cut away — the same rule `sc`/`fr`/`re`/`rr`/`sv` already obey.
    expect(src).toContain('ec: lossClass === ');
  });

  it('the class and the model text come from ONE shared evidence object', () => {
    // Two writers over one fact is how the reject row and the text could
    // disagree; both are fed the same `turnEvidence`.
    // TICKET cffd0d0a (2026-11-03): the inline literal moved into a named
    // builder (`turnEvidenceOf`) so the repeat breakers can ask the same
    // "did this call ever execute?" question from the SAME fields. The rule
    // this test owns is unchanged and now covers a third consumer: ONE
    // builder, every reader.
    expect(src).toContain('function turnEvidenceOf(ctx: ToolContext): ToolCallTurnEvidence');
    expect(src).toContain('const turnEvidence = turnEvidenceOf(ctx)');
    expect(src).toContain('classifyToolCallLoss(parsedArgs, turnEvidence)');
    expect(src).toContain('toolArgumentRejection(tc.name, parsedArgs, turnEvidence)');
    // …and the inline copy must not come back: a second literal is exactly the
    // drift this pin exists to prevent.
    expect(src).not.toMatch(/const turnEvidence = \{\s*finishReason:/);
  });

  it('feeds the seam the turn\'s arithmetic, not a re-derivation', () => {
    expect(src).toContain('receivedBytes: ctx.turnStreamTrace?.receivedBytes');
    expect(src).toContain('accumulatedBytes: ctx.turnStreamTrace?.accumulatedBytes');
    expect(src).toContain('finishReason: ctx.turnFinishReason');
  });
});