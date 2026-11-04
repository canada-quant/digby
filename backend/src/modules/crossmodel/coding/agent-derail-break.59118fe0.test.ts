/**
 * REPLAY TEST — ticket 59118fe0 (mishap, auto-filed 2026-11-02T02:37:16.698Z):
 * "5× success-side wrong-tool loop: edit_file on 'Panel-loss mid-scan kills
 * legs: '<cam · 0f8d608f day-level pin fix in worktree'" — framework or
 * model?" Auto-filed at the 2c98b460 success-side breaker trip (owner
 * doctrine 2026-09-10: self-heal + attribute, never just escalate).
 *
 * THE WILD INSTANCE (session 0037460b-d239-474e-bd32-5fe3ec52d820 — the
 * walker panel-loss lane, run 3a05a046-d4a7-43c6-88e4-ddca57a8cf36,
 * llm-cql:api-optimize-moonshot-kimi-k3, coding profile,
 * machine-triggered, created 01:06:40.501Z, still RUNNING at adjudication):
 * the lane was landing the 0f8d608f per-day pin detection in
 * scratch/m4-cutover/bundle/batch_walk4.py (the scratch walker bundle), so it
 * could then write tests/test_batch_walk4_day_pinned.py and wire that test
 * into .digby/config.json + AGENTS.md. It shipped its PR (open_pull_request
 * ×2, verify ×4, branch_pushed ×2 in the same run) DESPITE the trip.
 *
 * THE STREAK IS ONE MESSAGE OF FIVE edit_file CALLS — message idx 28, turn-key
 * boundary seq 517, calls seq 518, 521, 524, 527, 530
 * (02:37:16.7Z→02:37:20.0Z), EVERY ONE SUCCEEDED (ten `Edited …`
 * tool_results in the run, e.g. seq 520 "Edited
 * scratch/m4-cutover/bundle/batch_walk4.py"). The ticket's ×5 is the COUNT AT
 * THE FIFTH CALL; the re-anchor armed at the third (guard_strike
 * seam=tool_derail_reanchor, reason=intent_mismatch_success, intended=verify,
 * churned=false, 02:37:16.673Z; guard_marker seq 533) and the trip landed at
 * the fifth (seam=tool_derail_break, shape=success_intent, intended=verify,
 * churned=false, perma=false, 02:37:20.063Z).
 *
 * WHY THIS MEMBER IS DIFFERENT FROM EVERY PRIOR ONE — THE CONVICTING INPUT WAS
 * RECOVERED VERBATIM. Every earlier adjudication in this class (2547b652,
 * 267ea7b6, 4ac955aa, 304ff1bb, 601d819e, 9050c226) ran on zai/qwen seats
 * whose reasoning is cut at the wire (owner 2026-10-04 hide-thinking
 * directive; replaysReasoning() is kimi-family-only), so the CONVICTION could
 * only be INFERRED from the strike meta plus the (empty or tool-less) content
 * channel. This lane is a kimi-family seat, so coding-model.ts
 * replaysReasoning() persists it: agent_runs.checkpoint.messages[] carries
 * `reasoning_content` on all 26 assistant messages, and the convicted
 * message's channel is 24,807 chars. The run's 651 agent_events carry ZERO
 * type='reasoning' rows (that cut is real), so the checkpoint is the one
 * surviving copy — and it is the identical string the loop passed to
 * detectIntendedToolChannels (agent.ts:6292, `${turn.reasoning || ''}` +
 * `${turnText || turn.content || ''}`). probe-59118fe0.js replays the
 * deployed detector on those recovered bytes.
 *
 * THE RECOVERED CHANNELS (verbatim from checkpoint message idx 28):
 *   content (97 chars, the WHOLE channel):
 *     "I have everything needed. Making the five surgical edits to the
 *      walker (BATCH-8f, todo 0f8d608f):"
 *   reasoning (24,807 chars) — the FINAL SENTENCE, i.e. the decision segment
 *   that the d2cceee3 scoping convicts on:
 *     "Let me now make the 5 edits, then write the test file, then update
 *      config/AGENTS if needed, then run tests + verify."
 *
 * ADJUDICATION (this lane, 2026-11-02, evidence-led, read-only prod-DB probes
 * scripts/framework-audit/probe-59118fe0.js via prodq.sh on box A):
 * MODEL BEHAVIOR, GUARD CORRECT — no deterministic framework/schema/
 * preflight/guard defect caused the streak. This is a late member of a long
 * pinned class (the roster in 601d819e/9050c226/304ff1bb lists eight earlier
 * tickets — 8da24785, 267ea7b6, 2547b652, 4ac955aa, 304ff1bb, 2201d3d6,
 * 601d819e, 9050c226 — and later members including 8a2c0cc4, 738295c3 and
 * f6217896 exist too, so no ordinal is claimed here: two earlier members are
 * ALSO kimi-k3 — 8da24785 (kimi-k3/moonshot, edit_file, 2026-09-23) and
 * d2cceee3 (kimi-k3, write_file) — so this is NOT the first kimi member and
 * NOT the first on this seat with this tool).
 *
 * WHAT IS GENUINELY NEW, AND THE ONLY NOVELTY CLAIMED: this is the first
 * member whose CONVICTING CHANNEL could be replayed instead of inferred. The
 * earlier kimi-seat pins still could not read it — 4ac955aa's header records
 * the checkpoint storing `reasoning_content:""` for its run, and the zai/qwen
 * pins are cut at the wire (replaysReasoning() is kimi-family-only). For THIS
 * run the channel survives in full (24,807 chars), so the adjudication below
 * is a replay on recovered bytes rather than an elimination argument. The
 * novelty is about the EVIDENCE, not the class.
 *
 * 1. THE DETECTOR IS UNCHANGED FOR THIS CONVICTION PATH. One commit touched
 *    tool-preflight.ts since the 601d819e adjudication (3a40afb66/#1785):
 *    1ef49f7dd9 (ticket 738295c3, #1975) widened countStandaloneMentions'
 *    glue separator set with '/'. That fix ACQUITS slash-glued enumerations;
 *    the convicted sentence here contains no '/' beside `verify` at all, so
 *    the widening cannot have manufactured this trip (and block (3) below
 *    pins that the widened rule is not in play). The success-side intent
 *    counter itself is untouched since: `git log --since=2026-10-11 -S
 *    intentMissCount -- agent.ts` is EMPTY (the DATE SCOPE matters — the
 *    unscoped form returns the three commits that BUILT this guard:
 *    777d9f1324 #968, 28d8920e43 #974, 8376c062a2 #1020, all predating it).
 * 2. ELIMINATION ON THE RECOVERED INPUT — the replay, not an inference:
 *      · reasoning alone → 'verify' (4 broad, 4 standalone mentions; ZERO
 *        `edit_file` mentions in all 24,807 chars, so the broad
 *        prose/literal acquittal legs correctly never fire);
 *      · content alone → null (no tool named; ACQUIT);
 *      · the joined input the loop actually builds → 'verify'.
 *    The conviction therefore rode the LIVE reasoning channel and nothing
 *    else — exactly the narration-word-slip the class is, and the first time
 *    the class can say so from recovered bytes instead of by elimination.
 * 3. THE CONVICTING SENTENCE IS AN ORDERED PLAN, AND THAT IS THE DESIGNED
 *    CONVICTION SHAPE, not a glue/looksLikeToolFailure artifact: the model
 *    stated one plan and emitted its step 1 ("make the 5 edits"). The
 *    detector's whole-word, final-sentence, standalone-mention rule names the
 *    single offered tool this lane's plan mentions and never the called one.
 *    The 022eb482/738295c3 acquittal pin — a mention GLUED into a filename or
 *    a slash enumeration — is pinned below as a NEGATIVE so a future widening
 *    cannot silently turn this class off.
 * 4. THE GUARD STACK BEHAVED PER DESIGN at every rung: steer armed at the
 *    third counted miss with the TRUTHFUL success-side wording (guard_marker
 *    seq 533: "wrong-tool signature on edit_file (reasoning named verify) —
 *    the live run was re-anchored to its real toolset (one per run)"), the
 *    fifth tripped the ONE-ROUND withhold (perma:false — no perma, no
 *    run-end), the 0625bf62 platform-tool discount correctly never applied
 *    (edit_file is a coding tool), the f6217896 batch-sibling acquittal
 *    correctly never applied (the batch emitted no verify call), and all five
 *    calls of the in-flight batch executed (the withhold applies to the next
 *    round's schema, not to a dispatch already in flight).
 * 5. CONTAINMENT WAS EFFECTIVE AND — NEW TO THIS CLASS — THE STEER WAS
 *    CONSUMED AND THE MODEL CORRECTED IN THE VERY NEXT TURN. The next
 *    assistant message (idx 36) called `verify`, and its recovered reasoning
 *    reads "The harness wants exactly one verify call now. Per its
 *    instruction, I'll call verify once…" — the truthful steer (it says the
 *    call SUCCEEDED, never the false "and it failed") landed, the streak
 *    reset, and edit_file returned on the following turn ("Verify PASSED on
 *    the intermediate state… edit_file should be back"). The one-round
 *    withhold cost one verify call; the run went on to ship its PR. This is
 *    the class's cleanest steer-recovery record and the reason the pin
 *    asserts the steer's wording stays truthful.
 *
 * WHAT THIS SUITE PINS (the detector layer, on the incident's REAL bytes):
 *   (1) the recovered reasoning + content convict 'verify' — the incident's
 *       exact shape;
 *   (2) the content channel alone acquits — proof the conviction is the
 *       reasoning channel's, so a future reasoning-wire change is caught here;
 *   (3) the glue/enumeration negatives still acquit (738295c3 + 022eb482 not
 *       regressed into silence) while a bare intent mention still convicts;
 *   (4) the called-tool-named and prose-self-naming acquittal legs still fire;
 *   (5) the prior TRUE POSITIVES of the conviction leg still fire (recall
 *       guard — this PR changes NO detector code, and these pin that a later
 *       detector edit must come with its own DETECTOR-RECALL REPLAY).
 *
 * NOT PINNED HERE, DELIBERATELY: the full agent-loop ladder (steer at 3 →
 * trip at 5 → withhold) is already pinned by the 2c98b460 / 601d819e /
 * 9050c226 suites and its code is unchanged by this PR; re-simulating it
 * would duplicate ~500 lines of jest.mock scaffolding to prove nothing new.
 * This suite pins the layer the adjudication actually turned on: whether the
 * recovered input SHOULD convict under the class's documented rule.
 */
import { detectIntendedTool, detectIntendedToolChannels } from './tool-preflight';

/** The offered set a coding lane carries (the wild run's own schema subset —
 *  it exercised every one of these naming collisions: edit_file, verify,
 *  run_command, read_file in the same turn). */
const OFFERED = ['edit_file', 'verify', 'run_command', 'read_file', 'update_plan', 'write_file', 'grep'];

// ── THE RECOVERED CHANNELS (verbatim, checkpoint message idx 28) ──────────
/** The content channel, in full (97 chars). Names no tool. */
const CONTENT =
  'I have everything needed. Making the five surgical edits to the walker (BATCH-8f, todo 0f8d608f):';

/** The reasoning channel's TAIL, verbatim: the last ~900 chars of the 24,807
 *  char body. The detector slices the last 6000 chars, so this is the
 *  region it reads; the block ends on the decision sentence. The full body
 *  was checked to contain ZERO `edit_file` mentions (broad count 0), which
 *  the whole-text acquittal legs depend on. */
const REASONING_TAIL = [
  'Also `pidof_hue` — FakePin.run handles "pidof" → "4242\\n". Good.',
  '',
  "Writing the test file now. I'll model the class on FakeHue closely (copy its structure with the parameterization).",
  '',
  "Also need to check: does the verify chain's typecheck stage include the new test file? AGENTS.md's typecheck line lists specific files — including tests/test_batch_walk4_empty_skip.py. The .digby/config.json verify chain — let me check whether it globs or lists files. I'll read .digby/config.json and add the new test file to both typecheck list and test chain if they're explicit lists. AGENTS.md documents the commands — \"Docs move with the code\": if I add a test file, AGENTS.md's Typecheck/Test lines need updating too. Let me check config.json first.",
  '',
  'Let me now make the 5 edits, then write the test file, then update config/AGENTS if needed, then run tests + verify.',
].join('\n');

/** A long earlier body (the class's narration is an agentic monologue; the
 *  acquittal legs scan ALL of it, the conviction only its final sentence).
 *  Kept short here but present, because the d2cceee3 scoping is only
 *  meaningful when there IS earlier text. */
const REASONING_EARLIER =
  'I have everything I need. The FakeHue harness: `run()` handles "pidof"/"logcat"/"input tap x y"; '
  + '`_tap` drives the state machine; a row tap on a populated timeline → "player" state; '
  + '`press_back` from player → timeline. The walker\'s play_row opens the player and checks logcat evidence. '
  + 'In FakeHue, `self.logcat` is returned for any logcat command — for a no-evidence day, the logcat must lack '
  + 'the evidence markers.';

const REASONING = `${REASONING_EARLIER}\n\n${REASONING_TAIL}`;

describe('ticket 59118fe0 — edit_file→verify success-side derail on kimi-k3 (recovered reasoning): guard correct, containment effective, model behavior', () => {
  describe('(1) the recovered channels convict exactly as designed', () => {
    it('the incident input — recovered reasoning + content — names verify and never edit_file', () => {
      // The loop's own call shape (agent.ts:6292): reasoning channel + content.
      expect(detectIntendedToolChannels(REASONING, CONTENT, 'edit_file', OFFERED)).toBe('verify');
    });

    it('the two-channel call shape is REQUIRED: joined into one string, the same bytes ACQUIT', () => {
      // d2cceee3 channel scoping, measured on this incident's own bytes: the
      // single-string form treats the joined text as ONE channel, so its
      // "final sentence" is the CONTENT channel's ("Making the five surgical
      // edits…") and the reasoning's decision sentence is never reached. The
      // convicting call is the reasoning+content PAIR — a regression guard for
      // any future caller that collapses the two into one string.
      expect(detectIntendedTool(`${REASONING}\n${CONTENT}`, 'edit_file', OFFERED)).toBeNull();
      expect(detectIntendedToolChannels(REASONING, CONTENT, 'edit_file', OFFERED)).toBe('verify');
    });

    it('the decision segment is the ordered plan sentence, and dropping its verify mention acquits', () => {
      // The conviction rides ONE plan sentence: "…then run tests + verify."
      const withoutVerify = REASONING.replace(/then run tests \+ verify\.$/, 'then run the full chain.');
      expect(withoutVerify).not.toMatch(/verify\.$/);
      expect(detectIntendedToolChannels(withoutVerify, CONTENT, 'edit_file', OFFERED)).toBeNull();
    });

    it('a SINGLE verify mention is enough — the class is not a volume heuristic', () => {
      // 4 broad/standalone mentions exist in the 24.8k body, but only the
      // final sentence is counted; one mention there convicts.
      const oneMention = 'I have the edit sites mapped.\n\nNow verify the chain before the commit.';
      expect(detectIntendedToolChannels(oneMention, '', 'edit_file', OFFERED)).toBe('verify');
    });
  });

  describe('(2) the content channel alone acquits — the conviction is the reasoning channel', () => {
    it('the recovered content names no tool at all (so an empty/other reasoning acquits)', () => {
      expect(detectIntendedToolChannels('', CONTENT, 'edit_file', OFFERED)).toBeNull();
      // And it truly names nothing — not merely "nothing that convicts".
      expect(CONTENT).not.toMatch(/\b(?:verify|run_command|read_file|write_file|grep|update_plan)\b/);
    });

    it('this is the regression guard for the reasoning-wire cut: if reasoning stopped being persisted, the same run would have ACQUITTED', () => {
      // Documents WHY every earlier member of this class could only INFER the
      // conviction: without the reasoning channel this input is a clean
      // acquittal. Kept as an assertion so the two facts cannot drift apart.
      expect(detectIntendedToolChannels('', CONTENT, 'edit_file', OFFERED)).toBeNull();
      expect(detectIntendedToolChannels(REASONING, CONTENT, 'edit_file', OFFERED)).toBe('verify');
    });
  });

  describe('(3) the glue/ordering negatives still acquit (022eb482 / 738295c3 not regressed)', () => {
    it('a filename-glued mention in the same plan shape acquits — 022eb482', () => {
      expect(
        detectIntendedToolChannels(
          'Making the five surgical edits, then running verify-wave.sh on the result.',
          CONTENT,
          'edit_file',
          OFFERED
        )
      ).toBeNull();
    });

    it('a slash-separated pipeline enumeration in a plan sentence acquits — 738295c3', () => {
      expect(
        detectIntendedToolChannels(
          'Fixing the last stale constants (16→24 courses, 730→1,210 labels in build/extract/verify), then running the pipeline.',
          'Seven surgical edits to the three pipeline files:',
          'edit_file',
          OFFERED
        )
      ).toBeNull();
    });

    it('but a BARE intent mention still convicts — the widening did not silence the class', () => {
      expect(
        detectIntendedToolChannels('Edits applied. Now verify the chain.', '', 'edit_file', OFFERED)
      ).toBe('verify');
    });
  });

  describe('(4) the other acquittal legs still fire on this incident\'s shape', () => {
    it('naming the CALLED tool acquits, even with verify elsewhere in the decision sentence', () => {
      expect(
        detectIntendedToolChannels(
          'Applying the five edit_file calls, then run tests + verify.',
          CONTENT,
          'edit_file',
          OFFERED
        )
      ).toBeNull();
    });

    it('prose self-naming acquits (7b2a0969) — the PROSE sequence "edit the file" acquits, though the literal id is absent', () => {
      // This exercises proseMentionsTool (tool-preflight.ts:434), NOT the
      // literal check — the text carries no `edit_file` identifier at all.
      // Both legs must acquit independently, so the literal leg is pinned
      // separately in the next test.
      const prose = 'Now edit the file at the pinned region, then verify.';
      expect(prose).not.toMatch(/\bedit_file\b/); // the literal leg cannot be what acquits here
      expect(detectIntendedToolChannels(prose, '', 'edit_file', OFFERED)).toBeNull();
    });

    it('the LITERAL called-tool leg acquits on its own (tool-preflight.ts:211)', () => {
      // No prose sequence is needed: a whole-word `edit_file` mention acquits
      // through the broad literal test before any conviction leg runs.
      const literal = 'Next I will edit_file the pinned region, then verify the chain.';
      expect(detectIntendedToolChannels(literal, '', 'edit_file', OFFERED)).toBeNull();
    });

    it('DECISION-ADJACENCY holds on a long body: an early "verify" sentence never convicts a later faithful call (d2cceee3)', () => {
      // The scoping property the whole class rests on: acquittal is broad
      // (whole text), conviction is narrow (final sentence per channel). A
      // long earlier body that mentions verify, ending on a faithful
      // announcement, MUST acquit — this is what separates this class's
      // conviction from a false positive on ordinary planning prose.
      const longEarlier = Array(20)
        .fill('First I need to verify the counter wiring and verify the pin detection path before touching the file.')
        .join(' ');
      const faithfulTail = '\n\nApplying the edit_file diffs to the walker now.';
      expect(detectIntendedToolChannels(`${longEarlier}${faithfulTail}`, '', 'edit_file', OFFERED)).toBeNull();
      // The converse, so the assertion above is not vacuous: swap the tail for
      // a plan that names verify in its FINAL sentence and the same body convicts.
      expect(
        detectIntendedToolChannels(`${longEarlier}\n\nAll five diffs reviewed; now verify the chain.`, '', 'edit_file', OFFERED)
      ).toBe('verify');
    });

    it('the wild instance would ALSO acquit if its plan had named the called tool — the discriminator is the narration, not the batch', () => {
      const faithfulPlan = REASONING.replace(
        'Let me now make the 5 edits, then write the test file, then update config/AGENTS if needed, then run tests + verify.',
        'Let me edit_file the 5 pinned regions now, then write the test file.'
      );
      expect(detectIntendedToolChannels(faithfulPlan, CONTENT, 'edit_file', OFFERED)).toBeNull();
    });
  });

  describe('(5) prior true positives still fire — recall guard (this PR changes NO detector code)', () => {
    it('a bare decision-sentence intent mention convicts (022eb482 boundary)', () => {
      expect(detectIntendedTool('Ran the wave check on the merge. Now verify.', 'edit_file', OFFERED)).toBe('verify');
      expect(detectIntendedTool('Shell first: run_command the probe, then read it.', 'edit_file', OFFERED)).toBe(
        'run_command'
      );
    });

    it('a quoted intent statement still convicts (the quoted-strip is payload-gated, not blanket)', () => {
      expect(
        detectIntendedTool("That was the wrong net. I should have called 'grep' instead.", 'edit_file', OFFERED)
      ).toBe('grep');
    });

    it('an empty or too-short narration still acquits (the d2cceee3 floor)', () => {
      expect(detectIntendedTool('', 'edit_file', OFFERED)).toBeNull();
      expect(detectIntendedTool('ok verify', 'edit_file', OFFERED)).toBeNull();
    });
  });
});