/**
 * REPLAY TEST — tickets e24515a7 + a9dfa8d7 (mishaps, 2026-09-22, SAME
 * incident run): "3× tool-failure streak: update_feedback / update_document
 * on 'Post-CPT Coordination — SFT/GRPO/GSPO + ' — framework or model?"
 *
 * ADJUDICATION: MODEL-SIDE for BOTH — every deterministic gate held; NO
 * framework change. Same session e083ff2e-de98-412a-85df-86923572db1d, same
 * run c69466ec-c099-404b-919c-5cd760759ea2; both auto-filed at breaker trips
 * (e24515a7 at 02:41:01Z, a9dfa8d7 at 02:44:19Z — one lane decoder-locked on
 * the literal "noop" while its own reasoning named OTHER tools).
 *
 * The incidents:
 *   · e24515a7 (update_feedback): the model emitted id "noop" ONCE.
 *     update_feedback IS platform-preflighted (agent.ts:3217-3228 →
 *     findUngroundedIdArgs). "noop" is 4 chars — below ID_SHAPE_RE's 8-hex
 *     floor — and occurred NOWHERE in the run's readable haystack (assistant
 *     turns are EXCLUDED from groundingHaystack, so the model cannot
 *     self-ground its own narration), so the preflight REFUSED THE CALL
 *     WITHOUT EXECUTING: ungroundedIdRefusal with intended='list_schedules'
 *     from detectIntendedTool (the lane's reasoning named list_schedules).
 *     NOTHING was mutated — the call never reached the platform executor.
 *   · a9dfa8d7 (update_document): the model emitted fileId "noop" TWICE.
 *     update_document is a DOCUMENT-SEAM tool (agent.ts DOC_SEAM_ID_TOOLS —
 *     document tools EXECUTE; they are not platform-preflighted), so both
 *     calls reached the executor and the ownership gate refused them
 *     byte-exact (tool-executor.ts update_document case):
 *     "No generated file with id noop belongs to this user. Call list_files
 *     to see the current files." NOTHING was mutated. The lane's reasoning
 *     named get_chat_messages — the intent-mismatch leg added the weight.
 *
 * Why the "3×" titles on ONE and TWO filed texts: the streak breaker
 * arithmetic (agent.ts:3352-3411) is WEIGHTED — each consecutive failure +1,
 * a preflight-ungrounded emission +1, and the intent-mismatch leg +1 when the
 * lane's own reasoning names a DIFFERENT offered tool.
 *   · e24515a7: 1 (failure) + 1 (ungrounded) + 1 (intent=list_schedules) = 3
 *     on the FIRST emission → trip, withhold, auto-file (hence one filed
 *     failure text).
 *   · a9dfa8d7: (1 failure + 1 intent=get_chat_messages) × 2 emissions =
 *     cumulative 4 ≥ 3 on the SECOND emission → trip (the 099bd00a
 *     document-seam ladder — hence two filed failure texts).
 * That arithmetic is unchanged and as designed.
 *
 * Evidence for the attribution (re-verified against source bytes 2026-09-22):
 *  1. No framework surface EMITS "noop" as an entity id — the literal is a
 *     model emission; both refusal envelopes it produced match current
 *     source byte-for-byte (pinned below).
 *  2. Every containment layer held: preflight refused e24515a7's call
 *     pre-execution (no ticket mutation attempted), doc-seam ownership gate
 *     refused a9dfa8d7's calls (no file mutated), breaker tripped at the
 *     designed thresholds and auto-filed — these two tickets ARE the
 *     automatic investigation the owner doctrine asks for.
 *  3. Prior same-class adjudications were ALL model-side:
 *     f839cede+aff1c189+ec9d7424, b515ad74+688a01ce, 099bd00a, e70a830a,
 *     155488ff+cea13871, 9d5cee91, 54121353, 718a04a5, b6ebb710, 0c0ce759,
 *     02bf673a, 26430350+65eef459 (#955), f5d9eb32 (#956),
 *     8aa8d2ac+c79e4248 (#959).
 */

import {
  detectIntendedTool,
  findUngroundedIdArgs,
  groundingHaystack,
  ungroundedIdRefusal,
} from './tool-preflight';

// ── The incident's exact emitted id (both tickets filed "noop").
const NOOP = 'noop';

/** tool-executor.ts update_document case — the byte-exact ownership-gate
 *  text the incident filed twice. */
const docGateText = (fileId: string) =>
  `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;

/** The incident run's haystack was CLEAN: no prior tool result had rendered
 *  the literal "noop" into the readable context (system + user + tool roles)
 *  — proven by the preflight having fired at all. */
const CLEAN_HAYSTACK = groundingHaystack([
  { role: 'user', content: 'Post-CPT coordination: update the SFT/GRPO/GSPO board and close the streak tickets.' },
  { role: 'tool', content: '{"tickets":[{"id":"e24515a7-d99b-4723-8775-65d841b243cb","status":"open"}]}' },
]);

/** The e24515a7 ticket's filed refusal, verbatim (the breaker's 1200-char
 *  capture — the full envelope fits). */
const FILED_UF_REFUSAL = JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'ungrounded_id',
  rejected: [{ key: 'id', value: 'noop' }],
  message:
    'NOT EXECUTED: update_feedback was called with id="noop", which is not an id you obtained this run — ids come from a prior tool result (list_*/get_*), the brief, or the user, never from narration. ' +
    'Your reasoning named list_schedules — you evidently meant to call list_schedules; call it now with its real parameters.',
}, null, 1);

/** The offered-tool universe the intent detector convicts against. */
const OFFERED = ['list_schedules', 'get_chat_messages', 'update_feedback', 'update_document', 'list_files', 'run_command'];

/**
 * Local replica of the breaker's weighted streak counter (agent.ts:3352-3366):
 * consecutive failure-shaped results from ONE tool +1 each, a preflight-
 * ungrounded emission +1, an intent mismatch +1. Returns the emission ordinal
 * (1-based) at which the count first reaches the trip threshold 3, or -1.
 */
function tripAtEmission(failures: Array<{ preflightUngrounded?: boolean; intended?: string | null }>): number {
  let count = 0;
  for (let i = 0; i < failures.length; i += 1) {
    count += 1; // the failure itself
    if (failures[i].preflightUngrounded) count += 1;
    if (failures[i].intended) count += 1;
    if (count >= 3) return i + 1;
  }
  return -1;
}

describe('replay e24515a7 — update_feedback "noop" ungrounded_id preflight (model-side attribution)', () => {
  it('"noop" fails the id shape and is flagged against the incident\'s clean haystack — the preflight fires', () => {
    // 4 chars < ID_SHAPE_RE's 8-hex floor and no verbatim occurrence ⇒
    // ungrounded. The preflight REFUSED this call before any execution.
    expect(findUngroundedIdArgs({ id: NOOP }, CLEAN_HAYSTACK)).toEqual([{ key: 'id', value: NOOP }]);
    // A real citation prefix from the lane's own brief is id-shaped and passes.
    expect(findUngroundedIdArgs({ id: 'e24515a7' }, CLEAN_HAYSTACK)).toEqual([]);
    // A literal occurring nowhere is flagged even in a saturated haystack —
    // the containment has no hole.
    expect(findUngroundedIdArgs({ id: 'zzq-never-grounded' }, CLEAN_HAYSTACK))
      .toEqual([{ key: 'id', value: 'zzq-never-grounded' }]);
  });

  it('the filed refusal envelope is byte-exact the current ungroundedIdRefusal output (preflight → NOT EXECUTED, intended=list_schedules)', () => {
    const out = ungroundedIdRefusal('update_feedback', [{ key: 'id', value: NOOP }], 'list_schedules');
    expect(out).toBe(FILED_UF_REFUSAL);
    // Failure-shaped JSON (feeds the streak counter); refused BEFORE any
    // execution — no ticket mutation was attempted.
    expect(JSON.parse(out)).toMatchObject({ ok: false, tool: 'update_feedback', reason: 'ungrounded_id' });
  });

  it('detectIntendedTool convicts list_schedules from the incident-shaped narration (the +1 intent weight)', () => {
    const narration = 'Now list_schedules to confirm the backstop state before I close the streak ticket.';
    expect(detectIntendedTool(narration, 'update_feedback', OFFERED)).toBe('list_schedules');
    // Guard legs: naming the emitted tool acquits; a too-short text acquits.
    expect(detectIntendedTool('Calling update_feedback with the real id now.', 'update_feedback', OFFERED)).toBeNull();
    expect(detectIntendedTool('ok', 'update_feedback', OFFERED)).toBeNull();
  });

  it('weighted arithmetic: one preflight-ungrounded + intent-mismatched emission trips the breaker at the FIRST call', () => {
    expect(tripAtEmission([{ preflightUngrounded: true, intended: 'list_schedules' }])).toBe(1);
  });
});

describe('replay a9dfa8d7 — update_document "noop" document-seam ladder (model-side attribution)', () => {
  it('the two filed failure texts are byte-exact the tool-executor ownership gate', () => {
    // Filed (newest first), both identical:
    //   No generated file with id noop belongs to this user. Call list_files to see the current files.
    expect(docGateText(NOOP)).toBe('No generated file with id noop belongs to this user. Call list_files to see the current files.');
  });

  it('detectIntendedTool convicts get_chat_messages from the incident-shaped narration (the ladder\'s +1 per emission)', () => {
    const narration = 'Reading both lane transcripts now — get_chat_messages on 615723ba and e083ff2e to ground the ids.';
    expect(detectIntendedTool(narration, 'update_document', OFFERED)).toBe('get_chat_messages');
  });

  it('weighted arithmetic: two intent-mismatched executor refusals trip the breaker at the SECOND emission (the 099bd00a ladder)', () => {
    expect(tripAtEmission([{ intended: 'get_chat_messages' }, { intended: 'get_chat_messages' }])).toBe(2);
    // …while a single executor refusal with no intent mismatch never trips alone.
    expect(tripAtEmission([{ intended: null }, { intended: null }])).toBe(-1);
  });
});
