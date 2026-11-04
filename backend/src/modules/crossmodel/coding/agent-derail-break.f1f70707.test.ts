/**
 * REPLAY TEST — ticket f1f70707 (mishap, 2026-09-22): "3× tool-failure
 * streak: update_document on 'Re-Send Path C Phase 2 Kickoff' — framework or
 * model?"
 *
 * ADJUDICATION: MODEL-SIDE — every deterministic gate held; NO framework
 * change. Session cec340f2-f605-4370-b87a-d85b59cb243f (Path C integrator
 * lane), run 3252c6a5-ff08-459f-95eb-4946c80a06e5, auto-filed at the breaker
 * trip 2026-09-22T03:32:55Z. The lane decoder-locked on the literal
 * "noop-skip" while its own reasoning named run_command.
 *
 * The incident (identical seam to the 4375cc18 half of the pair pinned in
 * agent-derail-break.4375cc18-ecc4bd10.test.ts): the model emitted
 * update_document({fileId:"noop-skip"}) repeatedly. update_document is a
 * DOCUMENT-SEAM tool (agent.ts DOC_SEAM_ID_TOOLS — document tools EXECUTE;
 * they are deliberately NOT platform-preflighted, 099bd00a/b515ad74), so the
 * calls reached the executor and the ownership gate refused them byte-exact
 * (tool-executor.ts:774-781):
 *   "No generated file with id noop-skip belongs to this user.
 *    Call list_files to see the current files."
 * The gate is a read-only findFirst + early return — NOTHING was mutated.
 *
 * Streak arithmetic (agent.ts:3352-3411, WEIGHTED): each consecutive failure
 * +1, a preflight-ungrounded emission +1 (agent.ts:3364), the intent-mismatch
 * leg +1 when the lane's reasoning names a DIFFERENT offered tool
 * (agent.ts:3365-3366). The filed texts (two listed, newest first, identical)
 * plus the "reasoning named run_command" intent leg give 2 + 1 = 3 on the
 * SECOND emission → trip (the 099bd00a document-seam ladder); three bare
 * refusals would trip at the third on their own.
 *
 * SUBSTRING ≠ GROUNDING (pinned below): findUngroundedIdArgs grounds on
 * verbatim occurrence of the whole VALUE (tool-preflight.ts:73). A haystack
 * carrying "noop-skip" grounds the shorter "noop" (substring — the echo
 * family), but a haystack carrying only "noop" does NOT ground "noop-skip".
 *
 * CLASS RECURRENCE — the placeholder-emission class now spans FIVE sessions
 * in ~28 h:
 *   1. 3e1cae6f run fcc13160 ("Hardening Bench for Public Release") →
 *      8aa8d2ac + c79e4248, literal "noop" — pin
 *      agent-derail-break.8aa8d2ac-c79e4248.test.ts (PR #959, squash
 *      c939ce01), adjudicating lane ca128f4b.
 *   2. 28de72e5 run db5ca3df ("GLM-5.3 Deployment on Dual Sparks") →
 *      4375cc18 + ecc4bd10, literal "placeholder-noop" — pin
 *      agent-derail-break.4375cc18-ecc4bd10.test.ts (PR #964, squash
 *      8b5cbbcb), closed by adjudicating lane b92ef13f 2026-09-22T04:0xZ.
 *   3. e083ff2e run c69466ec ("Post-CPT Coordination") → a9dfa8d7 +
 *      e24515a7, literal "noop" — pin
 *      agent-derail-break.e24515a7-a9dfa8d7.test.ts (PR #963, squash
 *      72a8057d), closed 2026-09-22T03:24Z. e083ff2e is a REPEAT lane.
 *   4. b92ef13f run 182e6ef9 (adjudicating lane's OWN recovery derail) →
 *      76459ece, literal "noop" ×3 — pin
 *      agent-derail-break.76459ece.test.ts (PR #965, squash 4bf205a4),
 *      closed 2026-09-22T04:0xZ.
 *   5. cec340f2 run 3252c6a5 ("Re-Send Path C Phase 2 Kickoff") → THIS
 *      ticket, literal "noop-skip" — a SEMANTIC placeholder variant (the
 *      lane named its skip literal), same doc-seam, intended run_command.
 * Same verdict everywhere: MODEL behavior; the preflight, the doc-seam
 * ownership gate, the weighted breaker, and the auto-file all AS DESIGNED.
 * The standing enhancement idea (existence-preflight against the live id set
 * with a repair affordance, 718a04a5) remains the follow-up for the class.
 */

import {
  detectIntendedTool,
  findUngroundedIdArgs,
  groundingHaystack,
} from './tool-preflight';

// ── The incident's exact emitted literal (ticket f1f70707 filed "noop-skip").
const NOOP_SKIP = 'noop-skip';

/** tool-executor.ts:774-781 update_document case — the byte-exact
 *  ownership-gate text the f1f70707 incident filed. */
const docGateText = (fileId: string) =>
  `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;

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

describe('replay f1f70707 — update_document "noop-skip" document-seam ladder (model-side attribution)', () => {
  it('the filed failure texts are byte-exact the tool-executor ownership gate on "noop-skip"', () => {
    // Filed (newest first), both identical:
    //   No generated file with id noop-skip belongs to this user. Call list_files to see the current files.
    expect(docGateText(NOOP_SKIP))
      .toBe('No generated file with id noop-skip belongs to this user. Call list_files to see the current files.');
  });

  it('the doc-seam detection leg flags "noop-skip" off a clean haystack — and the refusal echo would ground it if included', () => {
    // agent.ts:3381-3394 (leg (c) source 2): detection-only grounding check on
    // document-seam tools, haystack = messages WITHOUT the just-pushed result
    // (messages.slice(0, -1)) — the refusal envelope ECHOES the invented id.
    const withoutEcho = groundingHaystack([{ role: 'user', content: 'Re-send the Path C phase-2 kickoff document.' }]);
    expect(findUngroundedIdArgs({ fileId: NOOP_SKIP }, withoutEcho))
      .toEqual([{ key: 'fileId', value: NOOP_SKIP }]);
    const withEcho = groundingHaystack([
      { role: 'user', content: 'Re-send the Path C phase-2 kickoff document.' },
      { role: 'tool', content: docGateText(NOOP_SKIP) },
    ]);
    expect(findUngroundedIdArgs({ fileId: NOOP_SKIP }, withEcho)).toEqual([]);
  });

  it('substring is NOT grounding: a haystack carrying only "noop" still flags "noop-skip" (grounding is verbatim occurrence of the whole value)', () => {
    const noopOnly = groundingHaystack([
      { role: 'tool', content: 'prior filing: the model emitted id noop then test' },
    ]);
    expect(findUngroundedIdArgs({ fileId: NOOP_SKIP }, noopOnly))
      .toEqual([{ key: 'fileId', value: NOOP_SKIP }]);
    // …while the REVERSE is the echo family: a haystack carrying "noop-skip"
    // DOES ground the shorter "noop" substring.
    const withNoopSkip = groundingHaystack([
      { role: 'tool', content: 'prior filing: the model emitted id noop-skip twice' },
    ]);
    expect(findUngroundedIdArgs({ fileId: 'noop' }, withNoopSkip)).toEqual([]);
  });

  it('detectIntendedTool convicts run_command from the incident-shaped narration (the +1 intent weight)', () => {
    const offered = ['run_command', 'update_document', 'list_files', 'verify'];
    expect(detectIntendedTool('Now run_command the Path C phase-2 probe script.', 'update_document', offered)).toBe('run_command');
    // Guard legs: naming the emitted tool acquits; a too-short text acquits.
    expect(detectIntendedTool('Calling update_document with the real fileId now.', 'update_document', offered)).toBeNull();
    expect(detectIntendedTool('ok', 'update_document', offered)).toBeNull();
  });

  it('weighted arithmetic: two executor refusals + the intent weight trip the breaker at the SECOND emission (the 099bd00a ladder)', () => {
    expect(tripAtEmission([{ intended: 'run_command' }, { intended: 'run_command' }])).toBe(2);
    // Two bare refusals alone do NOT trip — the filed trip proves the intent
    // leg fired, matching the ticket's "reasoning named run_command".
    expect(tripAtEmission([{}, {}])).toBe(-1);
    // …and three bare refusals trip at the third on their own (the 3× title).
    expect(tripAtEmission([{}, {}, {}])).toBe(3);
  });
});
