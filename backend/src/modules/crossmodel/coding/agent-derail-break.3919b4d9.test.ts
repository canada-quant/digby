/**
 * Replay pin — ticket 3919b4d9 (mishap, breaker trip 2026-09-20 01:53:41Z,
 * session e083ff2e-de98-412a-85df-86923572db1d "Post-CPT Coordination —
 * SFT/GRPO/GSPO + RL loops (re-dispatched)", run
 * 3dfc546d-f945-4b9a-936d-387f689c2068; first streak this run).
 *
 * THE INCIDENT: the breaker auto-filed '3× tool-failure streak:
 * update_feedback' with TWO failure texts (newest first):
 *   1. `{ "ok": false, "tool": "update_feedback", "reason": "ungrounded_id",
 *        "rejected": [{ "key": "id", "value": "retracted" }], "message":
 *        "NOT EXECUTED: update_feedback was called with id=\"retracted\" …" }`
 *   2. `{ … "rejected": [{ "key": "id", "value": "noop" }] … }`
 * Both ids are NARRATION words — the model's own bookkeeping vocabulary
 * ("retracted", "noop"), never an id returned by any tool result, the brief,
 * or the user this run.
 *
 * VERDICT (the ticket's mandated investigation): MODEL BEHAVIOR — the same
 * decoder-lock class as aff1c189 ("placeholder-noop"/"noop-wrong-tool"),
 * ec9d7424, and d0b9c6a6; tool-preflight.ts's own header documents the class
 * with `update_feedback({id:"noop"})` as its literal example. Every
 * deterministic seam behaved as designed: the referential-grounding
 * pre-flight refused both invented ids WITHOUT executing and returned an
 * actionable recovery line ("call the tool that advances the task instead").
 * NO platform code change.
 *
 * These tests pin, unit-level (tool-preflight is a pure leaf — no mocks):
 *   · 'retracted' and 'noop' are ungrounded against the run's haystack
 *     (neither is id-shaped; neither appears in anything the model read);
 *   · the refusal envelope is field-faithful to the two filed texts
 *     (ungrounded_id / NOT EXECUTED / the rejected arg / the no-intended
 *     recovery line — the filed texts carry no `intended` annotation, so the
 *     replay passes intended:null exactly as the real pre-flight did);
 *   · the ticket's own 8-hex prefix ('3919b4d9') IS grounded — the guard
 *     refuses narration, never a real citation.
 */

import { findUngroundedIdArgs, ungroundedIdRefusal } from './tool-preflight';

const CALL_NEWER = 'retracted'; // filed text #1 (texts are filed newest first)
const CALL_OLDER = 'noop'; // filed text #2

/** The incident run's readable haystack — deliberately free of both
 *  narration tokens, so both call ids are UNGROUNDED here exactly as they
 *  were in the real run. */
const HAYSTACK = [
  'Post-CPT Coordination — SFT/GRPO/GSPO + RL loops',
  'Relay the wave verdict; update the board with the receipts you pulled.',
  'Every claim cites a this-run receipt; never mutate fleet state.',
].join('\n');

describe('replay 3919b4d9 — narration-shaped update_feedback ids refused ungrounded_id', () => {
  it.each([[CALL_NEWER], [CALL_OLDER]])(
    'id %j is ungrounded against the run haystack (not id-shaped, never read)',
    (value) => {
      expect(findUngroundedIdArgs({ id: value }, HAYSTACK)).toEqual([{ key: 'id', value }]);
    },
  );

  it.each([[CALL_NEWER], [CALL_OLDER]])(
    'the refusal envelope for id %j is field-faithful to the filed failure text',
    (value) => {
      const env = JSON.parse(ungroundedIdRefusal('update_feedback', [{ key: 'id', value }], null));
      expect(env.ok).toBe(false);
      expect(env.tool).toBe('update_feedback');
      expect(env.reason).toBe('ungrounded_id');
      expect(env.rejected).toEqual([{ key: 'id', value }]);
      // Byte-exact against the ticket's filed message for this id (no
      // `intended` annotation — the filed texts show none).
      expect(env.message).toBe(
        `NOT EXECUTED: update_feedback was called with id=${JSON.stringify(value)}, which is not an id you obtained this run — ` +
          'ids come from a prior tool result (list_*/get_*), the brief, or the user, never from narration. ' +
          'If you have no such id, you do not need update_feedback right now — call the tool that advances the task instead.',
      );
    },
  );

  it("the ticket's own 8-hex prefix '3919b4d9' IS grounded (citation shape) — narration is refused, real ids pass", () => {
    expect(findUngroundedIdArgs({ id: '3919b4d9' }, HAYSTACK)).toEqual([]);
  });
});
