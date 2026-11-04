/**
 * REPLAY TEST — ticket f5d9eb32-bd0a-4a7d-8674-70975c75ac0d (mishap,
 * 2026-09-21): "3× tool-failure streak: update_document on 'Repository
 * Duplicates and Documentation' — framework or model?"
 *
 * ADJUDICATION: MODEL-SIDE — every deterministic gate held; NO framework
 * change. Incident session 10cb988f-6e80-4d3a-9e59-9e8fc83c93ae (CanLaw
 * docs-keeper lane), run 6eb0947d-792a-4122-b6d8-b2167358ed3f, firing 105,
 * model kimi-k3 (moonshot, coding profile, schedule trigger).
 *
 * The incident: TWO update_document({fileId:"noop"}) emissions, each
 * EXECUTING into the byte-exact ownership-gate refusal (tool-executor.ts
 * update_document case): "No generated file with id noop belongs to this
 * user. Call list_files to see the current files." update_document is a
 * DOCUMENT-SEAM tool (agent.ts DOC_SEAM_ID_TOOLS) — document tools EXECUTE;
 * they are NOT platform-preflighted (the ungrounded-id preflight is gated on
 * platformToolNames). NOTHING was mutated (the gate is a read-only findFirst
 * followed by an early return).
 *
 * The run's guard timeline (loop_metrics guard_strike, meta verbatim):
 *   23:03:32.646Z tool_repeat_break   update_plan      trips:1
 *   23:03:48.524Z tool_preflight      update_feedback  ungrounded_id, intended run_command
 *   23:03:50.823Z tool_derail_reanchor update_feedback intent_mismatch, intended run_command
 *   23:04:13.926Z tool_derail_break   update_feedback  perma:false, intended grep
 *   23:04:53.753Z tool_derail_break   update_feedback  perma:true,  intended verify
 *   23:05:37.406Z tool_derail_break   update_document  perma:false, state ended_run,
 *                                                    trips:3, tools [update_feedback, update_document],
 *                                                    intended run_command
 *   23:05:37.453Z tool_derail_rescue  update_document  continuation_enqueued, count 2/2
 * The rescue continuation closed the plan 8/8 at 23:10:35Z (nothing-to-do
 * path) — the self-heal chain held end to end.
 *
 * Why "noop" was never refused PRE-execution on the doc seam:
 *   1. ID_SHAPE_RE (/^[0-9a-f]{8}/i) never matches it ('n' is not hex) — the
 *      shape leg is out; grounding is VERBATIM OCCURRENCE, not semantics
 *      (tool-preflight.ts findUngroundedIdArgs).
 *   2. There is NO doc-seam pre-execution preflight to trip — by design
 *      (adjudicated 099bd00a / b515ad74): the executor ownership gate is the
 *      backstop, and it held.
 *   3. The run's OWN 23:03:48Z ungrounded-id refusal (update_feedback, a
 *      platform tool) JSON-embeds the rejected id verbatim
 *      (ungroundedIdRefusal: `rejected: bad`, plus `id="noop"` in the
 *      message), and tool results ARE haystack members (groundingHaystack
 *      excludes only assistant turns). A later emission of the SAME literal
 *      is then grounded by occurrence — the b515ad74 corpus-saturation
 *      mechanism, self-inflicted within one run. (The metric meta does not
 *      record which id the 23:03:48 refusal rejected; the lane's literal
 *      lock this run was "noop".)
 *   4. Moot either way: the doc-seam detection leg (agent.ts, off the failure
 *      result) is DETECTION-ONLY — it feeds the one-per-run re-anchor, which
 *      was already spent at 23:03:50Z, and its !intended gate was closed
 *      anyway (intended = run_command on both failures). No guard output
 *      depended on the grounding answer.
 *
 * Why the "3×" title on TWO filed texts: the streak breaker arithmetic is
 * WEIGHTED — failure +1, intent-mismatch +1 when the turn's own reasoning
 * names a DIFFERENT offered tool (this lane's named run_command; it never
 * named update_document — the wrong-tool derail signature). Two weighted
 * emissions = 4 ≥ 3 → trip, one-round withhold, auto-file; the filing's
 * newest-first window (cap 3) carries the two identical envelopes. Same
 * shape as b515ad74. Run-end: ≥2 derailed tools OR ≥3 total trips — BOTH
 * held here (tools [update_feedback, update_document], trips 3) — ended_run
 * plus the ff1fa1b5 rescue, exactly as observed.
 *
 * Lineage (ALL adjudicated model-side, no framework change): this same
 * lane's firing-95 (0aecbe92) and firing-101 (10c8dd60) derails; b515ad74 +
 * 688a01ce (#954), 26430350 + 65eef459 (#955), 89ddfcfe + 60f64ebb (#934),
 * 099bd00a, 1867d6d5, 718a04a5, 0c0ce759, aff1c189, 9d5cee91, 02bf673a,
 * f95bd4c8, b6ebb710 (#948).
 */

import { detectIntendedTool, findUngroundedIdArgs, groundingHaystack, ungroundedIdRefusal } from './tool-preflight';

/** The incident's literal — both update_document emissions passed it. */
const NOOP = 'noop';

/** tool-executor.ts update_document case — the byte-exact ownership-gate text. */
const docGateText = (fileId: string) =>
  `No generated file with id ${fileId} belongs to this user. Call list_files to see the current files.`;

/** A run haystack with no trace of the literal: the firing brief + a git probe. */
const CLEAN_HAYSTACK = groundingHaystack([
  { role: 'user', content: 'DOCS-KEEPER: sweep remote digby/session-* branches; merge docs/progress only.' },
  { role: 'tool', content: '48f28f3ab5c1a9eb76be013c48e7b6dae6627d32\trefs/heads/main' },
]);

/** The tools the lane was offered (the derail signature needs run_command offered). */
const OFFERED = new Set(['run_command', 'update_document', 'update_feedback', 'update_plan', 'list_files', 'get_feedback']);

describe('replay f5d9eb32 — update_document "noop" streak (model-side attribution)', () => {
  it('replays the filed failure envelopes byte-exact against the current doc-seam ownership gate (nothing mutated)', () => {
    // The ticket files TWO texts, newest first, both this exact envelope —
    // the "3×" title is the WEIGHTED count, not the text count.
    const filedTexts = [
      'No generated file with id noop belongs to this user. Call list_files to see the current files.',
      'No generated file with id noop belongs to this user. Call list_files to see the current files.',
    ];
    expect(filedTexts).toHaveLength(2);
    for (const filed of filedTexts) expect(docGateText(NOOP)).toBe(filed);
    // Drift coverage for the REAL executor path lives in document-tools.test.ts
    // (ToolCache.getOrExecute update_document) — this pin ties the INCIDENT's
    // filed text to the gate's template.
  });

  it('"noop" can never be shape-grounded: the preflight\'s own grounding rule flags it against a clean haystack', () => {
    // Not id-shaped (/^[0-9a-f]{8}/i — 'n' is not hex), absent from the
    // readable context ⇒ ungrounded. A real hex citation prefix sails through
    // the SAME rule by shape — the discriminator is occurrence/shape, never
    // semantics.
    expect(findUngroundedIdArgs({ fileId: NOOP }, CLEAN_HAYSTACK))
      .toEqual([{ key: 'fileId', value: NOOP }]);
    expect(findUngroundedIdArgs({ fileId: '48f28f3a' }, CLEAN_HAYSTACK)).toEqual([]);
  });

  it('same-run refusal echo grounds the literal: the update_feedback ungrounded-id refusal embeds the rejected id verbatim into a tool result', () => {
    // The 23:03:48Z preflight refusal on update_feedback (a platform tool) is
    // a tool-role message ⇒ haystack member. Its envelope carries the
    // rejected id twice (`rejected` + the `id="noop"` prose) and the intent
    // redirect naming run_command — both observed in the run's metric meta.
    const refusal = ungroundedIdRefusal('update_feedback', [{ key: 'id', value: NOOP }], 'run_command');
    const envelope = JSON.parse(refusal);
    // The rejected id rides the envelope TWICE: the structured `rejected`
    // field AND the prose message (`id="noop"`) — assert on the PARSED
    // envelope (the serialized bytes escape the prose quotes).
    expect(envelope.rejected).toEqual([{ key: 'id', value: NOOP }]);
    expect(envelope.message).toContain('id="noop"');
    expect(envelope.message).toContain('run_command');
    // And the serialized bytes — what the grounding haystack actually scans —
    // carry the literal verbatim (via the rejected block).
    expect(refusal).toContain('"noop"');
    const echoedHaystack = groundingHaystack([
      { role: 'user', content: 'DOCS-KEEPER: sweep remote digby/session-* branches.' },
      { role: 'tool', content: refusal },
    ]);
    // Grounding is occurrence, not semantics: a later doc-seam emission of
    // the SAME literal passes the verbatim leg — the designed mechanism.
    expect(findUngroundedIdArgs({ fileId: NOOP }, echoedHaystack)).toEqual([]);
  });

  it('assistant-role narration NEVER grounds — the model cannot self-ground its own invention', () => {
    const withNarration = groundingHaystack([
      { role: 'user', content: 'Update the progress document.' },
      { role: 'assistant', content: `I will now call update_document with fileId ${NOOP}.` },
    ]);
    expect(findUngroundedIdArgs({ fileId: NOOP }, withNarration))
      .toEqual([{ key: 'fileId', value: NOOP }]);
  });

  it('the intent-mismatch leg convicts exactly as filed: reasoning names run_command, never update_document', () => {
    // The weighted trip (+1 failure, +1 intent) needs this conviction on BOTH
    // emissions — the ticket's "lane's reasoning named run_command" line.
    const narration = 'Next I run the branch sweep with run_command: git for-each-ref over the remote refs, then classify each diff.';
    expect(detectIntendedTool(narration, 'update_document', OFFERED)).toBe('run_command');
    // Controls: naming the called tool acquits; a too-short tail convicts no one.
    expect(detectIntendedTool('I will call update_document now, then run_command.', 'update_document', OFFERED)).toBeNull();
    expect(detectIntendedTool('ok', 'update_document', OFFERED)).toBeNull();
  });
});
