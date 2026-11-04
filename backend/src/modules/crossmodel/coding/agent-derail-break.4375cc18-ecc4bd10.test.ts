/**
 * REPLAY TEST — tickets 4375cc18 + ecc4bd10 (mishaps, 2026-09-22, SAME
 * incident run): "3× tool-failure streak: update_document / update_feedback
 * on 'GLM-5.3 Deployment on Dual Sparks' — framework or model?"
 *
 * ADJUDICATION: MODEL-SIDE for BOTH — every deterministic gate held; NO
 * framework change. Same session 28de72e5-46c5-4a90-811d-840184efc106, same
 * run db5ca3df-46d9-4ead-b2fd-0994e442fadc; both auto-filed at breaker trips
 * (ecc4bd10 at 00:04:53Z, 4375cc18 at 00:19:31Z — one lane decoder-locked on
 * the literal "placeholder-noop" while its own reasoning named grep / verify).
 * Adjudicating lane b92ef13f reached the same verdict at 01:03Z (both
 * adminNotes) and left the pair in_progress for ONE reason only: no committed
 * replay file cited their prefixes. This file closes that gap (supervisor
 * steer daee2916, 2026-09-22 ~03:20Z).
 *
 * The incidents (identical seams to the 8aa8d2ac+c79e4248 pair, pinned in
 * agent-derail-break.8aa8d2ac-c79e4248.test.ts):
 *   · ecc4bd10 (update_feedback): the model emitted id "placeholder-noop"
 *     ONCE. update_feedback IS platform-preflighted (agent.ts:3105-3116 →
 *     findUngroundedIdArgs). "placeholder-noop" is not id-shaped (ID_SHAPE_RE
 *     /^[0-9a-f]{8}/i, tool-preflight.ts:33) and occurred nowhere in the
 *     run's readable haystack, so the preflight REFUSED THE CALL WITHOUT
 *     EXECUTING: ungroundedIdRefusal (tool-preflight.ts:264-286) with
 *     intended='grep' from detectIntendedTool. NOTHING was mutated.
 *   · 4375cc18 (update_document): the model emitted fileId "placeholder-noop"
 *     TWICE. update_document is a DOCUMENT-SEAM tool (agent.ts
 *     DOC_SEAM_ID_TOOLS — document tools EXECUTE; they are not platform-
 *     preflighted), so both calls reached the executor and the ownership
 *     gate refused them byte-exact (tool-executor.ts:774-781):
 *     "No generated file with id placeholder-noop belongs to this user.
 *     Call list_files to see the current files." The gate is a read-only
 *     findFirst + early return — NOTHING was mutated.
 *
 * Streak arithmetic (agent.ts:3352-3411, WEIGHTED): each consecutive failure
 * +1, a preflight-ungrounded emission +1 (agent.ts:3364), the intent-mismatch
 * leg +1 when the lane's reasoning names a DIFFERENT offered tool
 * (agent.ts:3365-3366).
 *   · ecc4bd10: 1 (failure) + 1 (ungrounded) + 1 (intent: grep) = 3 on the
 *     FIRST emission → trip (hence the ticket's single filed text).
 *   · 4375cc18: 2 (two executor refusals) + 1 (intent: verify) = 3 on the
 *     SECOND emission → trip (the 099bd00a document-seam ladder).
 *
 * SUBSTRING ≠ GROUNDING (pinned below): findUngroundedIdArgs grounds on
 * verbatim occurrence of the whole VALUE (tool-preflight.ts:73). A haystack
 * containing "placeholder-noop" grounds the shorter "noop" (substring — the
 * 155488ff+cea13871 cross-tool echo family), but a haystack containing only
 * "noop" does NOT ground "placeholder-noop" — the ecc4bd10 preflight fired
 * because the full literal was absent from the run's context.
 *
 * CLASS RECURRENCE — the placeholder-emission class spans THREE sessions in
 * ~26 h (shortfall-hunt tally, todo d14e0d2d):
 *   1. 3e1cae6f run fcc13160 ("Hardening Bench for Public Release") →
 *      8aa8d2ac + c79e4248, literal "noop" — pin
 *      agent-derail-break.8aa8d2ac-c79e4248.test.ts (PR #959, squash
 *      c939ce01), adjudicating lane ca128f4b.
 *   2. 28de72e5 run db5ca3df ("GLM-5.3 Deployment on Dual Sparks") → THIS
 *      pair, literal "placeholder-noop".
 *   3. e083ff2e run c69466ec ("Post-CPT Coordination") → a9dfa8d7 +
 *      e24515a7, literal "noop" — pin
 *      agent-derail-break.e24515a7-a9dfa8d7.test.ts (PR #963, squash
 *      72a8057d), closed by adjudicating lane b92ef13f 2026-09-22T03:24Z.
 *      e083ff2e is a REPEAT lane: it also produced 2026-09-21's
 *      155488ff+cea13871 pair (cross-tool echo-grounding, run 559ca88e).
 * Same verdict everywhere: MODEL behavior; the preflight, the doc-seam
 * ownership gate, the weighted breaker, and the auto-file all AS DESIGNED.
 */

import {
  detectIntendedTool,
  findUngroundedIdArgs,
  groundingHaystack,
  ungroundedIdRefusal,
} from './tool-preflight';

// ── The incident's exact emitted literal (both tickets filed "placeholder-noop").
const PLACEHOLDER_NOOP = 'placeholder-noop';

/** tool-executor.ts:774-781 update_document case — the byte-exact
 *  ownership-gate text the 4375cc18 incident filed twice. */
const docGateText = (fileId: string) =>
  `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;

/** A clean haystack: no occurrence of the incident literal anywhere the lane
 *  legitimately read (system + user + tool roles; assistant turns excluded). */
const CLEAN_HAYSTACK = groundingHaystack([
  { role: 'user', content: 'Deploy GLM-5.3 on the dual sparks and keep the board current.' },
  { role: 'tool', content: '{"tickets":[{"id":"4375cc18-d02f-483d-a9ed-83ded02a2fb1","status":"open"}]}' },
]);

/** The ecc4bd10 ticket's filed refusal, verbatim (the breaker's 1200-char
 *  capture — the full envelope fits). */
const FILED_UF_REFUSAL = JSON.stringify({
  ok: false,
  tool: 'update_feedback',
  reason: 'ungrounded_id',
  rejected: [{ key: 'id', value: 'placeholder-noop' }],
  message:
    'NOT EXECUTED: update_feedback was called with id="placeholder-noop", which is not an id you obtained this run — ids come from a prior tool result (list_*/get_*), the brief, or the user, never from narration. ' +
    'Your reasoning named grep — you evidently meant to call grep; call it now with its real parameters.',
}, null, 1);

/**
 * Local replica of the breaker's weighted streak counter (agent.ts:3352-3366):
 * consecutive failure-shaped results from ONE tool +1 each, a preflight-
 * ungrounded emission +1 (agent.ts:3364), an intent mismatch +1
 * (agent.ts:3365-3366). Returns the emission ordinal (1-based) at which the
 * count first reaches the trip threshold 3, or -1.
 */
function tripAtEmission(failures: Array<{ preflightUngrounded?: boolean; intended?: string | null }>): number {
  let count = 0;
  for (let i = 0; i < failures.length; i += 1) {
    count += 1; // the failure itself (agent.ts:3354)
    if (failures[i].preflightUngrounded) count += 1; // agent.ts:3364
    if (failures[i].intended) count += 1; // agent.ts:3365-3366
    if (count >= 3) return i + 1;
  }
  return -1;
}

describe('replay ecc4bd10 — update_feedback "placeholder-noop" ungrounded_id preflight (model-side attribution)', () => {
  it('"placeholder-noop" fails the id shape and is flagged against the incident\'s clean haystack — the preflight fires', () => {
    expect(findUngroundedIdArgs({ id: PLACEHOLDER_NOOP }, CLEAN_HAYSTACK))
      .toEqual([{ key: 'id', value: PLACEHOLDER_NOOP }]);
    // A real citation prefix from the lane's own brief is id-shaped and passes.
    expect(findUngroundedIdArgs({ id: '4375cc18' }, CLEAN_HAYSTACK)).toEqual([]);
  });

  it('substring is NOT grounding: a haystack carrying only "noop" still flags "placeholder-noop" (grounding is verbatim occurrence of the whole value)', () => {
    const noopOnly = groundingHaystack([
      { role: 'tool', content: 'prior filing: the model emitted id noop then test' },
    ]);
    expect(findUngroundedIdArgs({ id: PLACEHOLDER_NOOP }, noopOnly))
      .toEqual([{ key: 'id', value: PLACEHOLDER_NOOP }]);
    // …while the REVERSE is the 155488ff+cea13871 echo family: a haystack
    // carrying "placeholder-noop" DOES ground the shorter "noop" substring.
    const withPlaceholder = groundingHaystack([
      { role: 'tool', content: 'prior filing: the model emitted id placeholder-noop twice' },
    ]);
    expect(findUngroundedIdArgs({ id: 'noop' }, withPlaceholder)).toEqual([]);
  });

  it('the filed refusal envelope is byte-exact the current ungroundedIdRefusal output (preflight → NOT EXECUTED, intended=grep)', () => {
    const out = ungroundedIdRefusal('update_feedback', [{ key: 'id', value: PLACEHOLDER_NOOP }], 'grep');
    expect(out).toBe(FILED_UF_REFUSAL);
    expect(JSON.parse(out)).toMatchObject({ ok: false, tool: 'update_feedback', reason: 'ungrounded_id' });
  });

  it('detectIntendedTool convicts grep from the incident-shaped narration (the +1 intent weight)', () => {
    const offered = ['run_command', 'update_feedback', 'grep', 'verify', 'read_file'];
    expect(detectIntendedTool('Now grep the deploy config for the model flag.', 'update_feedback', offered)).toBe('grep');
    // Guard legs: naming the emitted tool acquits; a too-short text acquits.
    expect(detectIntendedTool('Calling update_feedback with the real id now.', 'update_feedback', offered)).toBeNull();
    expect(detectIntendedTool('ok', 'update_feedback', offered)).toBeNull();
  });

  it('weighted arithmetic: one preflight-ungrounded + intent-mismatched emission trips the breaker at the FIRST call', () => {
    expect(tripAtEmission([{ preflightUngrounded: true, intended: 'grep' }])).toBe(1);
  });
});

describe('replay 4375cc18 — update_document "placeholder-noop" document-seam ladder (model-side attribution)', () => {
  it('the two filed failure texts are byte-exact the tool-executor ownership gate on "placeholder-noop"', () => {
    // Filed (newest first), both identical:
    //   No generated file with id placeholder-noop belongs to this user. Call list_files to see the current files.
    expect(docGateText(PLACEHOLDER_NOOP))
      .toBe('No generated file with id placeholder-noop belongs to this user. Call list_files to see the current files.');
  });

  it('the doc-seam detection leg flags "placeholder-noop" off the failure result — and the refusal echo would ground it if included', () => {
    // agent.ts:3381-3394 (leg (c) source 2): detection-only grounding check on
    // document-seam tools, haystack = messages WITHOUT the just-pushed result
    // (messages.slice(0, -1)) — the refusal envelope ECHOES the invented id.
    const withoutEcho = groundingHaystack([{ role: 'user', content: 'Update the deployment doc.' }]);
    expect(findUngroundedIdArgs({ fileId: PLACEHOLDER_NOOP }, withoutEcho))
      .toEqual([{ key: 'fileId', value: PLACEHOLDER_NOOP }]);
    const withEcho = groundingHaystack([
      { role: 'user', content: 'Update the deployment doc.' },
      { role: 'tool', content: docGateText(PLACEHOLDER_NOOP) },
    ]);
    expect(findUngroundedIdArgs({ fileId: PLACEHOLDER_NOOP }, withEcho)).toEqual([]);
  });

  it('detectIntendedTool convicts verify from the incident-shaped narration (the ladder\'s intent weight)', () => {
    const offered = ['run_command', 'update_document', 'verify', 'list_files'];
    expect(detectIntendedTool('Now verify the deployment health on both sparks.', 'update_document', offered)).toBe('verify');
  });

  it('weighted arithmetic: two executor refusals + the intent weight trip the breaker at the SECOND emission (the 099bd00a ladder)', () => {
    expect(tripAtEmission([{ intended: 'verify' }, { intended: 'verify' }])).toBe(2);
    // Two bare refusals alone do NOT trip — the filed two-text trip proves the
    // intent leg fired, matching the ticket's "reasoning named verify".
    expect(tripAtEmission([{}, {}])).toBe(-1);
  });
});
