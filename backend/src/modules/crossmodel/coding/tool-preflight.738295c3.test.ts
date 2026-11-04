/**
 * REPLAY TEST — ticket 738295c3 (mishap, 2026-10-25): "5× success-side
 * wrong-tool loop: edit_file … — framework or model?"
 *
 * THE INCIDENT (session 19dd22bc, run ae086c49, a scheduled curriculum-data
 * lane on llm-cql:api-optimize-moonshot-kimi-k3): mid-batch, the lane
 * narrated its next action —
 *
 *   "Fixing the last stale constants (16→24 courses, 28 excluded,
 *    730→1,210 labels in build/extract/verify), then running the pipeline."
 *
 * — and emitted SEVEN edit_file calls in ONE batch, each an edit to one of
 * exactly the three pipeline files that enumeration names:
 * scratch/curriculum/caon/caon-verify.py, caon_build.py, caon_extract.py
 * (stale "730 objectives" → "1,210 objectives" count labels, 16→28 excluded
 * supports, 16→24 courses). Every call SUCCEEDED. The success-side wrong-tool
 * tracker (ticket 2c98b460, agent.ts :5818) counted each edit_file call as an
 * intent miss — detectIntendedToolChannels returned 'verify' — so the 3rd call
 * armed the one-per-run re-anchor (guard_strike tool_derail_reanchor
 * reason=intent_mismatch_success 19:20:54.919Z) and the 5th tripped the
 * breaker (guard_strike tool_derail_break shape=success_intent
 * 19:20:57.787Z), auto-filing this mishap ticket.
 *
 * THE CAUSE was DETERMINISTIC, not model behavior: the 022eb482 glue test in
 * countStandaloneMentions binds a mention into a filename/compound when the
 * separator beside it is '-' or '.', but NOT '/'. A slash-separated pipeline
 * enumeration — "build/extract/verify" — therefore read as a standalone
 * whole-word `verify` mention in the decision sentence, with the far side of
 * the '/' (an identifier char) never tested. The lane was faithfully editing
 * the very files it listed; the conviction was a detector gap one character
 * wide.
 *
 * THE FIX extends the glue separator set to '/' (tool-preflight.ts
 * countStandaloneMentions) — the mention must have an identifier char on the
 * FAR side of ANY of '-', '.', '/' to count, so sentence-final "Now verify."
 * and a leading "- verify" bullet still count, a bare CLI "--verify" still
 * counts, and "build/extract/verify" does not.
 *
 * This suite pins: (1) the incident's exact narration acquits; (2) the
 * boundary — the '/' glue holds on BOTH sides and needs its far-side
 * identifier char; (3) the PRIOR true positives of the conviction leg still
 * fire (DETECTOR-RECALL REPLAY — the self-merge gate's requirement for a
 * detector change).
 */
import { detectIntendedTool, detectIntendedToolChannels } from './tool-preflight';

const OFFERED = [
  'edit_file', 'write_file', 'read_file', 'run_command', 'verify', 'grep',
  'ast_search', 'glob', 'update_plan', 'todo_update', 'git_commit',
  'verify_durable', 'finish_run',
];

describe('ticket 738295c3 — slash-glue false conviction on a pipeline-file enumeration (countStandaloneMentions)', () => {
  it('THE INCIDENT: "labels in build/extract/verify, then running the pipeline" does NOT convict edit_file→verify', () => {
    // Verbatim narration (content channel; the reasoning channel was empty
    // this turn — agentEvent census for the run carries no reasoning rows).
    const content = 'Fixing the last stale constants (16\u219224 courses, 28 excluded, 730\u21921,210 labels in build/extract/verify), then running the pipeline.';
    expect(detectIntendedToolChannels(
      '', content, 'edit_file', OFFERED,
      { path: 'scratch/curriculum/caon/caon-verify.py', old_string: 'x', new_string: 'y' },
    )).toBeNull();
  });

  it('a slash enumeration at the END of the decision sentence is glue too ("…edits across build/extract/verify.")', () => {
    // nextCh '/' with an identifier on the far side — glueR leg.
    expect(detectIntendedTool(
      'Applying the count-label edits across build/extract/verify.',
      'edit_file', ['edit_file', 'verify', 'run_command'],
    )).toBeNull();
  });

  it('leading-side slash glue: "the verify/x batch" is not a bare verify mention', () => {
    // prevCh '/' with an identifier on the far side — glueL leg.
    expect(detectIntendedTool(
      'Running the extract/verify handoff now, then committing.',
      'edit_file', ['edit_file', 'verify', 'run_command'],
    )).toBeNull();
  });

  it('the glue needs its far-side identifier char: "… /verify." (slash then terminator) still counts', () => {
    // A REAL bare mention after a slash with nothing glued on the far side
    // ("/verify." — the '.' is sentence punctuation, not a compound) must
    // still convict: the fix is the separator set, not a blanket strip.
    expect(detectIntendedTool(
      'The edits are staged. Now /verify.',
      'edit_file', ['edit_file', 'verify', 'run_command'],
    )).toBe('verify');
  });

  it('a bare whole-word verify in a plain decision sentence still convicts edit_file (the signal survives)', () => {
    expect(detectIntendedTool(
      'The constants are fixed. Now verify the pipeline.',
      'edit_file', ['edit_file', 'verify', 'run_command'],
    )).toBe('verify');
  });
});

// ── DETECTOR-RECALL REPLAY (ticket 738295c3 detector change) ────────────────
describe('DETECTOR-RECALL REPLAY — prior true positives still fire (738295c3 detector change)', () => {
  // This PR widens countStandaloneMentions' glue separator set with '/'.
  // The replay below re-runs the conviction leg's PRIOR true positives —
  // the adjudicated incidents its exists-for set — and asserts they STILL
  // convict under the widened glue.
  it('CanLaw cec340f2 shape — reasoning names run_command, emission is update_feedback', () => {
    const reasoning = 'The parts check is done on the box. I need to call run_command with aws ssm get-command-invocation to read it. Calling run_command now.';
    expect(detectIntendedTool(reasoning, 'update_feedback', ['run_command', 'update_feedback', 'read_file', 'verify'])).toBe('run_command');
  });
  it('9cce6b5b shape (e2521a81 pin) — bare verify in the final sentence convicts read_file', () => {
    expect(detectIntendedTool(
      'The deck builds and the receipts are in. Now I verify the rendered page count via the chain.',
      'read_file', ['run_command', 'read_file', 'verify'],
    )).toBe('verify');
  });
  it('022eb482 glue boundary still holds — verify-wave.sh is NOT a verify mention', () => {
    expect(detectIntendedTool(
      'applying the remaining `verify-wave.sh` edits now.',
      'edit_file', ['edit_file', 'verify', 'run_command'],
    )).toBeNull();
  });
  it('the success-side incident class still trips when the narration genuinely names another tool (2c98b460 pin)', () => {
    // The 2c98b460 founding shape: reasoning names the OTHER offered tool as
    // the action in the decision sentence while edit_file is what is emitted.
    expect(detectIntendedToolChannels(
      'The edits are in. Time to verify everything end to end.',
      '', 'edit_file', ['edit_file', 'verify', 'run_command'],
    )).toBe('verify');
  });
  it('most-mentioned / tie-to-last resolution still holds', () => {
    expect(detectIntendedTool('read_file first, then read_file again, then verify.', 'update_feedback', ['update_feedback', 'read_file', 'verify'])).toBe('read_file');
    expect(detectIntendedTool('maybe read_file, or rather verify the thing.', 'update_feedback', ['update_feedback', 'read_file', 'verify'])).toBe('verify');
  });
});
// ── end DETECTOR-RECALL REPLAY ──────────────────────────────────────────────
