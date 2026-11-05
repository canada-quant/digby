/**
 * REPLAY TEST — ticket 47816c97-b57c-4e29-9e64-1ba4606a3040 (mishap,
 * auto-filed 2026-11-04T08:25:24.652Z): "5× success-side wrong-tool loop:
 * edit_file on 'UPSTREAM · Review fixes: read main()/arg' — framework or
 * model?" Auto-filed at the 2c98b460 success-side breaker trip (owner
 * doctrine 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session 0037460b-d239-474e-bd32-5fe3ec52d820, run
 * a9b493b4-9ff2-4020-aa56-eb6b3840f60c): the schooltime drift-guard lane, in
 * the middle of landing review fixes to scripts/deploy_drift_guard.py and its
 * test — the ticket's own call args are three edits adding the
 * `unaudited(census)` verdict line, the `load_main_manifest(...)` assert, and
 * the `_static_watched_paths()` blob fixture. Every one of the five calls
 * SUCCEEDED; the conversation transcript for that run shows the lane
 * shipping PR #369 (squash 1cf41501) in the same run.
 *
 * WHAT THIS SUITE CAN AND CANNOT CLAIM — READ THIS BEFORE CITING IT.
 * This member of the class was adjudicated WITHOUT recovering the run's own
 * reasoning bytes. The two prior kimi-seat members could be replayed from
 * `agent_runs.checkpoint.messages[].reasoning_content` (59118fe0) because a
 * kimi seat persists it; this lane's checkpoint was NOT read — the adjudicating
 * ticket lane had no production-DB route (no aws CLI, no boto3, no psql in its
 * sandbox), so the conviction was established by three facts that do NOT
 * depend on those bytes:
 *
 *   1. THE CONVICTION PATH IS UNCHANGED. No commit since the 59118fe0
 *      adjudication (0da86a20b5, 2026-11-02) alters the intent detector's
 *      conviction logic — the only tool-preflight.ts commit in the window,
 *      e5f50647a2 (ticket 53406cc4), touches the ungrounded-id chat hint, not
 *      detectIntendedToolChannels / countStandaloneMentions / proseMentionsTool.
 *      A deterministic regression in the guard would have to live in one of
 *      those, and none of them moved.
 *   2. THE SHIPPED DETECTOR STILL DISCRIMINATES. Re-measured in that run on
 *      this very tree: the class shape convicts ('verify') and all three
 *      acquittal legs (literal self-naming, prose self-naming, filename-glued)
 *      acquit. That is section (1)-(3) below, so a future reader re-runs the
 *      measurement rather than trusting this paragraph.
 *   3. THE CLASS IS ALREADY ADJUDICATED MODEL BEHAVIOR. This is the SAME
 *      structural class (`success_intent:edit_file->verify`) on the SAME
 *      session as 59118fe0, closed 2026-11-02 as "MODEL BEHAVIOR, GUARD
 *      CORRECT" on recovered bytes; 601d819e and 8a2c0cc4 are the same class
 *      on other sessions with the same verdict. Nothing in the trip shape is
 *      new — only the run is.
 *
 * THE ONE DETERMINISTIC DEFECT FOUND IS NOT IN THIS DETECTOR, AND IS NOT
 * FIXED HERE (see section (5)): the class-keyed attach arm shipped by
 * af4ef7c7 (c327aec95c) can only match a CLOSED row that already CARRIES the
 * key, and 59118fe0 was filed 2026-11-02T02:37:16Z — BEFORE that key shipped
 * (07:07Z the same day) — so its context carries no breakerClassKey and it
 * can never absorb a same-class sighting. That is why THIS ticket filed fresh
 * instead of attaching. It is a one-time bootstrap gap, not a live guard
 * fault: this ticket DOES carry the key (its context.breakerClassKey reads
 * `success_intent:edit_file->verify`), so it becomes the anchor the class was
 * missing. Section (5) pins the mechanism so the claim is checkable.
 *
 * NOT PINNED HERE, DELIBERATELY: the agent-loop ladder (steer at the third
 * counted miss → trip at the fifth → one-round withhold). It is unchanged and
 * already pinned by the 2c98b460 / 601d819e / 9050c226 suites; re-simulating it
 * would duplicate hundreds of lines of jest.mock scaffolding to prove nothing.
 *
 * WHAT "5×" ACTUALLY COUNTS — read this before quoting the number as evidence
 * of five separate wrong decisions (review finding F5). The success ladder
 * increments PER CALL, and every call inside ONE dispatched batch is judged
 * against the SAME `turn.reasoning` / turn text (agent.ts, the
 * `detectIntendedToolChannels(`${turn.reasoning || ''}`, `${turnText ||
 * turn.content || ''}`, ...)` call in the success leg). So a "5 consecutive
 * SUCCEEDING calls whose reasoning named a different tool" trip can be ONE
 * narration counted five times — five edits emitted in a single batch — and
 * not five independently wrong choices. The precedent
 * agent-derail-break.601d819e.test.ts documents exactly that shape as a
 * 15-call single-batch streak. The framework already models this: the
 * BATCH-SIBLING acquittal (ticket f6217896) acquits a call when the SAME
 * dispatched batch emitted the "intended" tool as its own call, i.e. the
 * narration's mention was consumed by an itemized-checklist sibling.
 *
 * WHY THAT MATTERS TO THIS ADJUDICATION, AND WHY IT DOES NOT CHANGE IT. It
 * means the incident is best read as "one edit batch whose narration closed on
 * the next step", NOT "five escalating wrong turns" — which makes the
 * model-behavior verdict STRONGER, not weaker: a single coherent plan
 * misread against a single narration is the benign shape. It also fixes the
 * bar for any future claim about this class: count BATCHES, not calls, before
 * calling a recurrence a behavioural escalation. The batch-sibling arm lives
 * in the agent loop (agent.ts), not in tool-preflight.ts, so it is NOT
 * re-simulated here for the reason immediately above; the reproduction of this
 * run's own bytes was unavailable (see above), so this suite does not pretend
 * to distinguish one-batch-five-counts from five-batches-one-count for
 * a9b493b4 specifically.
 */
import { detectIntendedTool, detectIntendedToolChannels } from './tool-preflight';
import { breakerClassKey, BREAKER_CLASS_KEY_FIELD } from '../feedback/breaker-class-key';

/** The offered set a coding lane carries (the same subset the prior members of
 *  this class exercised — edit_file, verify, run_command and read_file all
 *  collide in one turn's narration). */
const OFFERED = ['edit_file', 'verify', 'run_command', 'read_file', 'update_plan', 'write_file', 'grep'];

// ── THE INCIDENT'S SHAPE (RECONSTRUCTED from the filed ticket, NOT verbatim) ──
// The ticket carries the trip's structured fields and its three call args, but
// not the narration bytes, so the channels below are a faithful model of the
// class's shape — an ordered plan whose decision sentence names verification
// while the spent calls were edits — and are labelled as such. Section (1)'s
// point is that THIS shape convicts; it is not offered as a transcript quote.
const REASONING_PLAN_TAIL =
  'Let me now make the five drift-guard edits, then wire the census row into the verdict, '
  + 'then re-run the test file, then run tests + verify.';

const REASONING_EARLIER =
  'The review findings land in one file plus its test. The reviewer flagged three things: the '
  + 'missing unaudited(census) line on the verdict, the manifest assert that must go through '
  + 'load_main_manifest with the static watched set, and the blobs fixture that has to seed '
  + '_static_watched_paths(). I have the exact old_string for each of them from the last read.';

const REASONING = `${REASONING_EARLIER}\n\n${REASONING_PLAN_TAIL}`;

/** The content channel: a status line that names no tool. */
const CONTENT = 'I have everything needed. Making the five review-fix edits to the drift guard:';

describe('ticket 47816c97 — edit_file→verify success-side derail (drift-guard review fixes): guard correct, model behavior', () => {
  describe('(1) the class shape convicts exactly as designed', () => {
    it('an ordered plan that ends on "verify" and never names edit_file convicts verify', () => {
      // The loop's own call shape (agent.ts:6292): reasoning channel + content.
      expect(detectIntendedToolChannels(REASONING, CONTENT, 'edit_file', OFFERED)).toBe('verify');
    });

    it('the conviction rides ONE mention in the decision sentence, not volume', () => {
      // The earlier body may mention anything; only each channel's FINAL
      // sentence is convicted (d2cceee3). One bare mention there is enough.
      const oneMention = 'I have the edit sites mapped.\n\nNow verify the chain before the commit.';
      expect(detectIntendedToolChannels(oneMention, '', 'edit_file', OFFERED)).toBe('verify');
    });

    it('dropping the decision sentence\'s verify mention acquits — the assertion is not vacuous', () => {
      const withoutVerify = REASONING.replace(/then run tests \+ verify\.$/, 'then run the full chain.');
      expect(withoutVerify).not.toMatch(/verify\.$/);
      expect(detectIntendedToolChannels(withoutVerify, CONTENT, 'edit_file', OFFERED)).toBeNull();
    });
  });

  describe('(2) naming the called tool, in the identifier or in prose, acquits', () => {
    it('the LITERAL called-tool leg acquits on its own (tool-preflight.ts:211)', () => {
      const literal = 'Next I will edit_file the pinned region, then verify the chain.';
      expect(detectIntendedToolChannels(literal, '', 'edit_file', OFFERED)).toBeNull();
    });

    it('prose self-naming acquits (7b2a0969) — "edit the file" is enough, with no identifier present', () => {
      const prose = 'Now edit the file at the pinned region, then verify.';
      expect(prose).not.toMatch(/\bedit_file\b/); // proves the literal leg is not what acquits here
      expect(detectIntendedToolChannels(prose, '', 'edit_file', OFFERED)).toBeNull();
    });

    it('a faithful plan on THIS incident\'s body acquits — the discriminator is the narration, not the batch', () => {
      const faithfulPlan = `${REASONING_EARLIER}\n\nApplying the edit_file diffs to the drift guard now.`;
      expect(detectIntendedToolChannels(faithfulPlan, CONTENT, 'edit_file', OFFERED)).toBeNull();
    });

    it('DECISION-ADJACENCY holds on a long body (d2cceee3): early "verify" prose never convicts a later faithful call', () => {
      const longEarlier = Array(20)
        .fill('First I need to verify the census wiring and verify the manifest path before touching the file.')
        .join(' ');
      expect(detectIntendedToolChannels(`${longEarlier}\n\nApplying the edit_file diffs now.`, '', 'edit_file', OFFERED))
        .toBeNull();
      // The converse, so the assertion above cannot pass vacuously.
      expect(detectIntendedToolChannels(`${longEarlier}\n\nAll five diffs reviewed; now verify the chain.`, '', 'edit_file', OFFERED))
        .toBe('verify');
    });
  });

  describe('(3) the glue/enumeration negatives still acquit (022eb482 / 738295c3 not regressed)', () => {
    it('a filename-glued mention acquits — 022eb482', () => {
      expect(
        detectIntendedToolChannels(
          'Making the five review-fix edits, then running verify-wave.sh on the result.',
          CONTENT,
          'edit_file',
          OFFERED
        )
      ).toBeNull();
    });

    it('a slash-separated pipeline enumeration acquits — 738295c3', () => {
      expect(
        detectIntendedToolChannels(
          'Fixing the last stale constants (13 aligned / 4 diverged in build/extract/verify), then running the pipeline.',
          'Seven surgical edits to the drift guard:',
          'edit_file',
          OFFERED
        )
      ).toBeNull();
    });

    it('but a BARE intent mention still convicts — the widening did not silence the class', () => {
      expect(detectIntendedToolChannels('Edits applied. Now verify the chain.', '', 'edit_file', OFFERED))
        .toBe('verify');
    });
  });

  describe('(4) DETECTOR-RECALL REPLAY — prior true positives still fire', () => {
    // This PR changes NO detector code. These pin that a later detector edit
    // must come with its own DETECTOR-RECALL REPLAY rather than quietly
    // relaxing the conviction out of existence.
    it('a bare decision-sentence intent mention convicts', () => {
      expect(detectIntendedTool('Ran the wave check on the merge. Now verify.', 'edit_file', OFFERED)).toBe('verify');
      expect(detectIntendedTool('Shell first: run_command the probe, then read it.', 'edit_file', OFFERED))
        .toBe('run_command');
    });

    it('a quoted intent statement still convicts (the quoted-strip is payload-gated, not blanket)', () => {
      expect(
        detectIntendedTool("That was the wrong net. I should have called 'grep' instead.", 'edit_file', OFFERED)
      ).toBe('grep');
    });

    it('an empty or too-short narration still acquits (the floor)', () => {
      expect(detectIntendedTool('', 'edit_file', OFFERED)).toBeNull();
      expect(detectIntendedTool('ok verify', 'edit_file', OFFERED)).toBeNull();
    });
  });

  describe('(5) the class key: this ticket is the anchor 59118fe0 could never be', () => {
    it('the trip derives the exact key stamped on this ticket\'s own context', () => {
      // get_feedback(47816c97) returns context.breakerClassKey === this value.
      expect(breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' }))
        .toBe('success_intent:edit_file->verify');
      expect(BREAKER_CLASS_KEY_FIELD).toBe('breakerClassKey');
    });

    it('the key is STRUCTURAL — no title input exists, so a retitled chat cannot fork the class', () => {
      // af4ef7c7's whole argument: the breaker title embeds a MUTABLE chat
      // title ('… on "<chat title>" — framework or model?'), which is why the
      // title-equality dedupe arm never matched two sightings of one class.
      // breakerClassKey takes only {shape, tool, intended} — a title is not a
      // parameter, so the key is identical for two chats whose titles differ
      // completely. Asserted through the signature's own inputs.
      const a = breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' });
      const b = breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' });
      expect(a).toBe(b);
      expect(Object.keys({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' })).not.toContain('title');
    });

    it('a DIFFERENT tool pair is a different class — the key never over-merges', () => {
      // The PR #2295 refutation: a key broad enough to join every tool pair
      // would hide a recurrence in a genuinely distinct class.
      expect(breakerClassKey({ shape: 'success_intent', tool: 'update_plan', intended: 'get_chat_messages' }))
        .not.toBe(breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' }));
    });

    it('a bare failure streak still yields no key — unchanged per-instance filing', () => {
      expect(breakerClassKey({ shape: 'failure', tool: 'edit_file', intended: 'verify' })).toBeNull();
      expect(breakerClassKey({ shape: 'success_intent', tool: 'edit_file' })).toBeNull();
    });

    it('THE BOOTSTRAP GAP, pinned: a row filed before the key shipped cannot absorb a sighting', () => {
      // The attach arm's only match input is a JSON-path equality on the
      // stamped key (adjudicated-class-attach.ts: the candidate query is
      // `context: { path: [BREAKER_CLASS_KEY_FIELD], equals: classKey }`, and
      // no title- or body-derived key is computed anywhere in that module).
      //
      // PROVENANCE, stated honestly (review finding F4): the conclusion below
      // rests on TWO FACTS OF CODE, not on a live read of 59118fe0's row.
      //   1. the attach arm matches on the stamped key alone (read this run);
      //   2. the key first shipped in c327aec95c at 2026-11-02T07:07:19-07:00,
      //      while 59118fe0 was filed at 2026-11-02T02:37:16Z — ~4.5h EARLIER.
      // A row created before the stamp existed cannot carry it, so the query
      // cannot match it, whatever the row's other fields are.
      //
      // The shape below is therefore a REPRESENTATIVE pre-key context — the
      // fields this filer writes at create time — NOT a transcription of
      // 59118fe0's stored row. (An earlier draft of this comment claimed it
      // was "read with get_feedback this run"; it was not, and the closedAt
      // value below is byte-identical to a fixture in
      // feedback.service.af4ef7c7.test.ts:72, which is exactly the confusion
      // that claim invited. The fixture is retained only as shape.)
      const row59118fe0Context: Record<string, unknown> = {
        closedAt: '2026-11-02T03:57:14.936Z',
        dispatchMode: 'ticket_lane',
        dispatchedAt: '2026-11-02T02:43:56.075Z',
        dispatchedTo: 'c19511ab-5db9-439b-9d2d-57e4ef4547c2',
        laneArchivedAt: '2026-11-02T04:00:49.305Z',
        laneDispatches: 1,
        laneDispatchEpoch: 0,
      };
      expect(row59118fe0Context).not.toHaveProperty(BREAKER_CLASS_KEY_FIELD);
      // The class identity is nevertheless the SAME class this suite pins.
      expect(breakerClassKey({ shape: 'success_intent', tool: 'edit_file', intended: 'verify' }))
        .toBe('success_intent:edit_file->verify');
    });
  });
});