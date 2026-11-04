/**
 * REPLAY TEST — ticket b6ebb710 (mishap, 2026-09-21): "3× tool-failure streak:
 * update_feedback on 'Re-Send Path C Phase 2 Kickoff' — framework or model?"
 *
 * ADJUDICATION: MODEL-SIDE — the guard is correct; NO framework change.
 *
 * The incident (session cec340f2, run 8aa64839, auto-filed at breaker trip):
 * the model called update_feedback with the LITERAL string id="placeholder",
 * was refused ungrounded_id with a corrective naming exactly what to do, then
 * escalated with id="placeholder2". Both refusal envelopes are filed verbatim
 * in the ticket (newest first). The "3×" in the auto-title is the streak
 * breaker's WEIGHTED count (each preflight refusal weighs 1 and fast-trips +1),
 * not three calls — the same title-reading adjudicated in
 * agent-derail-break.aff1c189.test.ts ("two placeholder-id update_feedback
 * emissions read as a '3× streak'"), which also pins END-TO-END that nothing
 * reaches the executor and the investigation carries exactly the two texts.
 *
 * Evidence for the attribution:
 *  1. The preflight guard is deterministic (agent.ts:3105-3116 →
 *     tool-preflight.ts findUngroundedIdArgs / ungroundedIdRefusal): a value
 *     is grounded iff id-shaped OR occurring verbatim in the run's readable
 *     context (prior tool results, the brief, the user — assistant narration
 *     is EXCLUDED by groundingHaystack, so the model cannot self-ground).
 *     "placeholder"/"placeholder2" are neither — pinned below.
 *  2. No framework surface emits "placeholder" as an update_feedback id
 *     (grep platform-tools.ts / ticket-dispatch.service.ts: none).
 *  3. The refusal text told the model the exact recovery ("ids come from a
 *     prior tool result (list_* / get_*), the brief, or the user, never from
 *     narration… call the tool that advances the task instead"); retrying
 *     with "placeholder2" instead of list_feedback/get_feedback is the model
 *     behavior this guard exists to contain — and it contained it (zero
 *     executions, per the aff1c189 E2E pin).
 *  4. Prior same-class adjudications were all model-side with this guard
 *     correct: 0c0ce759, aff1c189, 9d5cee91, 54121353, 718a04a5, f95bd4c8
 *     (update_canvas id="noop-audit-placeholder").
 */

import { findUngroundedIdArgs, ungroundedIdRefusal, groundingHaystack } from './tool-preflight';

// The incident's exact emitted ids (the ticket files the envelopes newest
// first: "placeholder2" then "placeholder").
const CALL1_ID = 'placeholder';
const CALL2_ID = 'placeholder2';

// A realistic run haystack: brief text + a REAL ticket id from a prior
// list_feedback result. Neither placeholder string occurs in it.
const REAL_TICKET_ID = 'ae20da66-3731-4d77-9779-b5923ce9b9cc';
const HAYSTACK = groundingHaystack([
  { role: 'user', content: 'Close out the streak ticket per the run bookkeeping.' },
  { role: 'tool', content: `{"tickets":[{"id":"${REAL_TICKET_ID}","status":"in_progress"}]}` },
]);

describe('replay b6ebb710 — placeholder-id update_feedback streak (model-side attribution)', () => {
  it('both emitted ids are ungrounded against the run haystack (neither id-shaped; neither anywhere the model read)', () => {
    expect(findUngroundedIdArgs({ id: CALL1_ID }, HAYSTACK))
      .toEqual([{ key: 'id', value: CALL1_ID }]);
    expect(findUngroundedIdArgs({ id: CALL2_ID }, HAYSTACK))
      .toEqual([{ key: 'id', value: CALL2_ID }]);
  });

  it('replays the exact refusal envelopes from the filed texts (ungrounded_id, NOT EXECUTED, the rejected arg, the recovery line)', () => {
    for (const value of [CALL1_ID, CALL2_ID]) {
      const refusal = JSON.parse(
        ungroundedIdRefusal('update_feedback', [{ key: 'id', value }], null),
      );
      expect(refusal).toMatchObject({
        ok: false,
        tool: 'update_feedback',
        reason: 'ungrounded_id',
        rejected: [{ key: 'id', value }],
      });
      expect(refusal.message).toContain('NOT EXECUTED');
      expect(refusal.message).toContain('never from narration');
      expect(refusal.message).toContain('call the tool that advances the task instead');
    }
  });

  it('the model could not have self-grounded: assistant-role text is excluded from the haystack', () => {
    const withNarration = groundingHaystack([
      ...[
        { role: 'user', content: 'Close out the streak ticket per the run bookkeeping.' },
        { role: 'tool', content: `{"tickets":[{"id":"${REAL_TICKET_ID}","status":"in_progress"}]}` },
      ],
      { role: 'assistant', content: `I will now call update_feedback with id ${CALL1_ID}.` },
    ]);
    expect(findUngroundedIdArgs({ id: CALL1_ID }, withNarration))
      .toEqual([{ key: 'id', value: CALL1_ID }]);
  });

  it('the correct call WAS available: a real ticket id from a prior tool result is grounded (id-shape leg + verbatim leg)', () => {
    // Full uuid: id-shaped — grounded even against an EMPTY haystack.
    expect(findUngroundedIdArgs({ id: REAL_TICKET_ID }, '')).toEqual([]);
    // Verbatim occurrence in the haystack grounds a non-id-shaped value too.
    expect(findUngroundedIdArgs({ id: REAL_TICKET_ID }, HAYSTACK)).toEqual([]);
  });
});
