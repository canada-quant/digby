/**
 * REPLAY TEST — ticket 76459ece (mishap, 2026-09-22): "3× tool-failure
 * streak: update_document on 'Digby's Nightly Self-Improvement Enginee' —
 * framework or model?"
 *
 * ADJUDICATION: MODEL-SIDE — every deterministic gate held; NO framework
 * change. Incident session b92ef13f-c3f8-487e-8267-767e56543150, run
 * 182e6ef9-28d8-44bc-91fb-4abd9885b3e8; auto-filed at breaker trip
 * 2026-09-22T03:30:46Z.
 *
 * FIRST recurrence of the placeholder-emission family where the incident
 * lane IS the adjudicating lane itself: mid-recovery from a deploy-
 * interruption resume (replayed-snapshot hazard), the lane decoder-locked
 * on the literal "noop" and emitted update_document({fileId:"noop"}) THREE
 * times while its own reasoning named list_schedules. The containment stack
 * did exactly its job, in order:
 *   1. update_document is a DOCUMENT-SEAM tool (agent.ts DOC_SEAM_ID_TOOLS —
 *      document tools EXECUTE; they are not platform-preflighted by design),
 *      so all three emissions reached the executor and the ownership gate
 *      refused them BYTE-EXACT (tool-executor.ts update_document case):
 *      "No generated file with id noop belongs to this user. Call list_files
 *      to see the current files." NOTHING was mutated.
 *   2. The weighted streak counter (agent.ts:3352-3366) tripped and the
 *      loop-break notice temporarily WITHHELD update_document ("Your last 3
 *      calls of update_document ALL FAILED…").
 *   3. The re-anchor fired naming the reasoning's intended tool
 *      (list_schedules); the lane recovered on the next turn and completed
 *      its actual work (list_schedules + get_feedback batch).
 *   4. The breaker auto-filed this ticket — the automatic investigation the
 *      owner doctrine (2026-09-10) asks for. This replay pin is its record.
 *
 * Why three filed texts with an intent mismatch on the lane's reasoning:
 * the counter is WEIGHTED (+1 per consecutive failure-shaped result, +1 per
 * preflight-ungrounded emission, +1 per intent mismatch). With the intent
 * leg convicting list_schedules, two emissions already reach the trip
 * threshold (the 099bd00a document-seam ladder); three identical refusal
 * texts were captured into the filing (newest-first window) before the
 * withhold landed. That arithmetic is unchanged and as designed.
 *
 * Containment note (pinned below): the executor's refusal ECHO grounds the
 * literal — after the first refusal, "id noop" sits in the readable
 * haystack, so findUngroundedIdArgs can no longer flag it. For the document
 * seam this is moot BY DESIGN (doc tools are never preflighted); the
 * ownership gate is the designated backstop, and it held byte-exact ×3.
 * The preflight itself has no hole: a literal occurring NOWHERE is still
 * flagged.
 *
 * Prior same-class adjudications were ALL model-side: f839cede+aff1c189+
 * ec9d7424, b515ad74+688a01ce, 099bd00a, e70a830a, 155488ff+cea13871,
 * 9d5cee91, 54121353, 718a04a5, b6ebb710, 0c0ce759, 02bf673a,
 * 26430350+65eef459 (#955), f5d9eb32 (#956), 8aa8d2ac+c79e4248 (#959),
 * e24515a7+a9dfa8d7 (#963), 89ddfcfe+60f64ebb.
 */

import {
  detectIntendedTool,
  findUngroundedIdArgs,
  groundingHaystack,
} from './tool-preflight';

/** The incident's exact emitted placeholder (all three filed texts). */
const NOOP = 'noop';

/** tool-executor.ts update_document case — the byte-exact ownership-gate
 *  text the incident filed three times. */
const docGateText = (fileId: string) =>
  `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;

/** The offered-tool universe the intent detector convicts against. */
const OFFERED = ['list_schedules', 'get_feedback', 'update_feedback', 'update_document', 'cancel_schedule', 'list_files'];

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

describe('replay 76459ece — update_document "noop" ×3, adjudicating lane derailing on ITSELF (model-side attribution)', () => {
  it('all three filed failure texts are byte-exact the tool-executor ownership gate (nothing mutated)', () => {
    // Filed (newest first), all three identical:
    //   No generated file with id noop belongs to this user. Call list_files to see the current files.
    expect(docGateText(NOOP)).toBe('No generated file with id noop belongs to this user. Call list_files to see the current files.');
  });

  it('detectIntendedTool convicts list_schedules from the incident-shaped narration (the +1 intent weight)', () => {
    // The lane's own narration while emitting update_document({fileId:"noop"}):
    const narration = 'Retiring the now-redundant backstops — list_schedules to see what is armed, then cancel the close-watcher.';
    expect(detectIntendedTool(narration, 'update_document', OFFERED)).toBe('list_schedules');
    // Guard legs: naming the emitted tool acquits; a too-short text acquits.
    expect(detectIntendedTool('Calling update_document with the real fileId now.', 'update_document', OFFERED)).toBeNull();
    expect(detectIntendedTool('ok', 'update_document', OFFERED)).toBeNull();
  });

  it('weighted arithmetic: the loop-break trips by the THIRD consecutive refusal at the latest, as the "3×" filing records', () => {
    // Intent-weighted (reasoning named list_schedules): trip at the 2nd
    // emission — the 099bd00a document-seam ladder.
    expect(tripAtEmission([{ intended: 'list_schedules' }, { intended: 'list_schedules' }, { intended: 'list_schedules' }])).toBe(2);
    // Pure executor refusals with no intent leg: trip exactly at the 3rd.
    expect(tripAtEmission([{ intended: null }, { intended: null }, { intended: null }])).toBe(3);
    // …and a single refusal never trips alone.
    expect(tripAtEmission([{ intended: null }])).toBe(-1);
  });

  it('containment note: the executor refusal echo grounds "noop" — the doc-seam ownership gate is the designated backstop (held ×3)', () => {
    const haystackAfterFirstRefusal = groundingHaystack([
      { role: 'user', content: 'retire the redundant backstop and close out the plan' },
      { role: 'tool', content: docGateText(NOOP) },
    ]);
    // The literal now sits in the readable context — no longer flaggable.
    expect(findUngroundedIdArgs({ fileId: NOOP }, haystackAfterFirstRefusal)).toEqual([]);
    // The preflight itself has no hole: a literal occurring NOWHERE is flagged.
    expect(findUngroundedIdArgs({ fileId: 'zzq-never-grounded' }, haystackAfterFirstRefusal))
      .toEqual([{ key: 'fileId', value: 'zzq-never-grounded' }]);
  });
});
