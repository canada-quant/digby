/**
 * FOLLOW-THROUGH pins (owner 2026-09-16, framework item 3; hardened after the
 * 2026-09-16 adversarial review). The miners (lane-stall FRAMES with an id
 * directly after a lane noun; present-tense WAITING frames with no oq id —
 * both with the action / reason / resolution / conditional / completed
 * registers excluded, pinned against the review's false-positive prose), and
 * the sweep: a diagnosis with no action toward the lane since the run that
 * wrote the note (15-min slack before the row) wakes the supervisor ONCE per
 * lane per day with [FOLLOW-THROUGH]; a receipt naming the lane, a todo write
 * on a todo assigned to it, or an AGENT message posted into it silences it
 * (the owner typing does not; another user's same-prefix chat is never read);
 * an owner-gated claim with no open owner question for the chat/project files
 * one (machine-triggered) and posts the oq id back with the triage caveat; the
 * Fleet Supervisor counts ANY open question of the owner; an already-ANSWERED
 * prior posts the spark-class "cite it as answered" notice; a refusal posts
 * why. Paused project supervisors are skipped. Cursor discipline: first sight
 * seeds and judges nothing; notes inside the grace window wait.
 */
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  // Supervisor OFF switch (owner 2026-09-26): null = no row = ON.
  systemSetting: { findUnique: jest.fn(async () => null) },
};
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
const mockRecordLoopMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

import * as fs from 'fs';
import * as path from 'path';
import {
  mineStallDiagnoses, mineUnfiledDecisionClaims, sweepFollowThrough, renderFollowThroughWake,
  FOLLOW_THROUGH_GRACE_MS, FOLLOW_THROUGH_RUN_SLACK_MS, NUDGE_DEDUPE_SEC, AUTOFILE_DEDUPE_SEC,
  renderOwnerAskNudge, renderOwnerAskEscalation,
} from './follow-through.service';

const NOW = new Date('2026-09-16T21:00:00Z');
const SUP = 'c0e22e36-0000-4000-8000-000000000000';
const FLEET = 'f1ee7000-0000-4000-8000-000000000000';
const LANE = '3f1c2a9b';
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60000);

describe('mineStallDiagnoses', () => {
  it('reads a lane-stall diagnosis in its several idioms, one per lane', () => {
    const note = [
      `Lane ${LANE} looks stalled: no receipts in 6h and the last final was empty.`,
      'chat 7a7a7a7a is idle since 14:00Z.',
      `Session 9b9b9b9b keeps failing at the verify stage; ${LANE} again zero-tool.`,
      'The bounty lane (deadbeef) went quiet — nothing delivered since yesterday.',
      'worker `0c0ffee1` has been silent for two wakes.',
    ].join('\n');
    expect(mineStallDiagnoses(note).map((d) => d.laneId8)).toEqual([LANE, '7a7a7a7a', '9b9b9b9b', 'deadbeef', '0c0ffee1']);
  });

  it('skips sentences that already carry the action, a stated reason, a resolution, history or a conditional', () => {
    expect(mineStallDiagnoses(`Lane ${LANE} was stalled; I nudged it (msg 1234abcd).`)).toEqual([]);
    expect(mineStallDiagnoses(`Lane ${LANE} stalled earlier and has recovered.`)).toEqual([]);
    expect(mineStallDiagnoses(`If lane ${LANE} is still idle next wake, restart it.`)).toEqual([]);
    expect(mineStallDiagnoses(`Restarted lane ${LANE} (start_coding_session receipt a1b2c3d4) after it hung.`)).toEqual([]);
    expect(mineStallDiagnoses(`Lane ${LANE} is idle by design between its 06:00 and 18:00 scheduled runs.`)).toEqual([]);
    expect(mineStallDiagnoses(`Lane ${LANE} is idle — no action needed until the dataset lands.`)).toEqual([]);
    expect(mineStallDiagnoses('No lanes are stalled; all four delivered.')).toEqual([]);
    expect(mineStallDiagnoses(`> quoted: lane ${LANE} is stalled`)).toEqual([]);
  });

  it('does not fire on healthy-lane prose, ticket ids, commit shas or dates (the review\'s false-positive set)', () => {
    expect(mineStallDiagnoses(`Worker ${LANE} is spinning up a fresh container for the shard-3 retrain.`)).toEqual([]);
    expect(mineStallDiagnoses(`Lane ${LANE} finished the regression suite; all 42 tests green.`)).toEqual([]);
    expect(mineStallDiagnoses(`Session ${LANE} removed the dead code path in the parser.`)).toEqual([]);
    expect(mineStallDiagnoses('Fleet note: ticket 9341e862 keeps failing CI on the same assertion.')).toEqual([]);
    expect(mineStallDiagnoses(`Commit a3f9c2e1 landed on lane ${LANE}; the lane is looping over the fixture set as designed.`)).toEqual([]);
    expect(mineStallDiagnoses('Lane 20260916 is stalled.')).toEqual([]); // digits only — a date, not a chat id
  });
});

describe('mineUnfiledDecisionClaims', () => {
  it('reads present-tense waiting claims that cite no owner-question id', () => {
    const note = [
      'Publishing v0.8.2 is owner-gated on Gates 1–3 (sol leg still at +1/hr).',
      "Step 6 waits on Paul's decision about the Gemini leg budget.",
      'The seat swap remains blocked on the owner.',
      'Nothing else is waiting on the owner.',
    ].join('\n');
    expect(mineUnfiledDecisionClaims(note)).toEqual([
      'Publishing v0.8.2 is owner-gated on Gates 1–3 (sol leg still at +1/hr).',
      "Step 6 waits on Paul's decision about the Gemini leg budget.",
      'The seat swap remains blocked on the owner.',
    ]);
  });

  it('skips claims that cite an oq id, report an answer, say the question was filed, or merely MENTION the owner\'s decision (the review\'s false-positive set)', () => {
    expect(mineUnfiledDecisionClaims('Publishing v0.8.2 is owner-gated (oq_bd1130d5 open since 09-14).')).toEqual([]);
    expect(mineUnfiledDecisionClaims('The owner answered the publish question: proceed.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Filed an owner question for the publish gate this wake.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('This would be owner-gated if the sol leg regressed.')).toEqual([]);
    expect(mineUnfiledDecisionClaims("Acting on the owner's decision to hold crossmodel, I paused lane 3f1c2a9b.")).toEqual([]);
    expect(mineUnfiledDecisionClaims("Thanks for Paul's answer on the seat question; proceeding with glm-5.3.")).toEqual([]);
    expect(mineUnfiledDecisionClaims('Per the owner ruling we merged the PR; nothing else needs owner input this wake.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('This needs owner input eventually but not this week.')).toEqual([]);
  });

  it('never mines a NEGATIVE owner-wait report (replay pin, feedback f7e9df4c — the CanLaw Supervisor\'s 2026-09-18 "zero open owner questions" status line auto-filed oq_06b64479)', () => {
    // the exact misfire sentence from the ticket's evidence (msg f9487d00 / oq_06b64479)
    expect(mineUnfiledDecisionClaims('BOARD 07:30Z — CanLaw steady. Zero open owner questions; nothing waits on the owner.')).toEqual([]);
    // every gating frame under a same-clause negation is a steady-state report, never a claim
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing else waits on Paul.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('No lane waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Zero items wait on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing is owner-gated.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('No lane is owner-gated.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Zero lanes are blocked on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('No owner decision is pending.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing is waiting on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing is blocked on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('The publish call is not owner-gated.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('The seat swap never waits on the owner.')).toEqual([]);
  });

  it('keeps the live claim in a MIXED sentence — a negation never reaches across a clause boundary (f7e9df4c dual: the detector\'s core "waits on the owner with no question filed" case must not be vetoed by an honest no-question report)', () => {
    expect(mineUnfiledDecisionClaims('No owner question is open; the publish call waits on Paul.')).toEqual([
      'No owner question is open; the publish call waits on Paul.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner; the publish call is owner-gated.')).toEqual([
      'Nothing waits on the owner; the publish call is owner-gated.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing landed this week; the seat swap remains blocked on the owner.')).toEqual([
      'Nothing landed this week; the seat swap remains blocked on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Zero owner questions filed this wake; the Gemini leg budget is still awaiting the owner.')).toEqual([
      'Zero owner questions filed this wake; the Gemini leg budget is still awaiting the owner.',
    ]);
  });

  it('never lets a negation token INSIDE a real noun veto a live claim (F1 boundary pin, feedback f7e9df4c — the adversarial reviewer\'s casino/volcano/domino class: NEGATED_FRAME_RE is word-bounded on BOTH sides)', () => {
    // words merely ENDING in a negation token are not negations — main mined every one of these
    expect(mineUnfiledDecisionClaims('The casino payout waits on the owner.')).toEqual([
      'The casino payout waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('The volcano response is blocked on the owner.')).toEqual([
      'The volcano response is blocked on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('The domino rollout still waits on Paul.')).toEqual([
      'The domino rollout still waits on Paul.',
    ]);
    expect(mineUnfiledDecisionClaims('Whenever the deploy waits on the owner.')).toEqual([
      'Whenever the deploy waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('A subzero deploy window waits on the owner.')).toEqual([
      'A subzero deploy window waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('The casino payout is owner-gated.')).toEqual([
      'The casino payout is owner-gated.',
    ]);
    // a negated first clause must not hide a live claim whose noun merely ENDS in a negation token
    expect(mineUnfiledDecisionClaims('No lane is blocked on the owner; the volcano lane is owner-gated.')).toEqual([
      'No lane is blocked on the owner; the volcano lane is owner-gated.',
    ]);
  });

  it('skips nothing-class negation / zero-count no-op phrasings (the bdd71948 misfire class) without suppressing an affirmative claim in the same note', () => {
    // The two exact sentences that auto-filed oq_06b64479 and oq_9f5995bf.
    expect(mineUnfiledDecisionClaims('Zero open owner questions; nothing waits on the owner.')).toEqual([]);
    // I2 — the 4-word "else in this project" span that kept auto-filing after #851
    // (NEGATED_FRAME_RE's {0,3} cannot reach it; NOTHING_CLASS_FRAME_RE's {0,5} can).
    expect(mineUnfiledDecisionClaims('Not re-filed from CanLaw — no duplicate card, and nothing else in this project waits on the owner (board: 0 open owner questions here).')).toEqual([]);
    // The negation class, wider: other gating idioms as the negated object.
    expect(mineUnfiledDecisionClaims('Nothing in this project waits on the owner right now.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing remains blocked on the owner this wake.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nobody waits on the owner for this gate.')).toEqual([]);
    // …but an affirmative claim later in the same sentence/note still mines.
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner; the publish gate waits on the owner.')).toEqual([
      'Nothing waits on the owner; the publish gate waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner. The seat swap remains blocked on the owner.')).toEqual([
      'The seat swap remains blocked on the owner.',
    ]);
  });

  it('skips DECLINE/DEFER-to-file sentences (ticket f26f12ab) — the note says it is NOT filing; the auto-filer must not file for it', () => {
    // Each of these carries an un-negated gating frame AND an explicit decline —
    // every one auto-filed before DECLINE_RE (the oq_9f5995bf class).
    expect(mineUnfiledDecisionClaims('Not re-filing — the publish gate still waits on the owner (no duplicate card).')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Declining to file — the seat swap remains blocked on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims("Won't file a duplicate; the gate waits on Paul.")).toEqual([]);
    expect(mineUnfiledDecisionClaims('Deferring the card; the alias gate waits on Paul.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('No owner question needed — the publish gate still waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing to file: the v0.8.2 publish still waits on Paul.')).toEqual([]);
    // The veto is per SENTENCE, not per note.
    expect(mineUnfiledDecisionClaims('Not re-filing — no duplicate card. The seat swap remains blocked on the owner.')).toEqual([
      'The seat swap remains blocked on the owner.',
    ]);
    // Decline VOCABULARY without the negated intent still mines.
    expect(mineUnfiledDecisionClaims('A duplicate card is not the issue here — the publish gate waits on the owner.')).toEqual([
      'A duplicate card is not the issue here — the publish gate waits on the owner.',
    ]);
  });

  it('REGRESSION pins (adversarial review 875216b0, findings B1/B2): a nothing-class word must not bleed across a comma contrast into an affirmative claim', () => {
    // B1 — comma-bleed: every one of these MINES on origin/main and must keep mining.
    expect(mineUnfiledDecisionClaims('Nothing is queued, but the publish gate waits on the owner.')).toEqual([
      'Nothing is queued, but the publish gate waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner, the publish gate waits on the owner.')).toEqual([
      'Nothing waits on the owner, the publish gate waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner, the gate waits on the owner.')).toEqual([
      'Nothing waits on the owner, the gate waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims("Review says 'nothing waits on the owner' but the seat swap remains blocked on the owner.")).toEqual([
      "Review says 'nothing waits on the owner' but the seat swap remains blocked on the owner.",
    ]);
    // B2 — the gratuitous 'pending' sentence-level veto is reverted: main mines this.
    expect(mineUnfiledDecisionClaims('The deploy is not pending; the seat swap remains blocked on the owner.')).toEqual([
      'The deploy is not pending; the seat swap remains blocked on the owner.',
    ]);
  });

  it('REGRESSION pins (adversarial review 875216b0, finding F1): the post-verb "nothing … but X" exception idiom re-arms the claim — every one of these MINES on origin/main', () => {
    // F1 — "nothing VERB but X" reads as "ONLY X VERBs": an affirmative owner-wait claim.
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner but the publish gate.')).toEqual([
      'Nothing waits on the owner but the publish gate.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner but the merge decision.')).toEqual([
      'Nothing waits on the owner but the merge decision.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing remains blocked on the owner but the seat swap.')).toEqual([
      'Nothing remains blocked on the owner but the seat swap.',
    ]);
    // Incident-shaped: a no-op note carrying a real exception.
    expect(mineUnfiledDecisionClaims('Zero open owner questions; nothing waits on the owner but the publish gate.')).toEqual([
      'Zero open owner questions; nothing waits on the owner but the publish gate.',
    ]);
    // Comma variant — the elliptical contrast "does" asserts the gate waits.
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner, but the publish gate does.')).toEqual([
      'Nothing waits on the owner, but the publish gate does.',
    ]);
  });

  it('REGRESSION pins (adversarial review 875216b0, finding G1): the exception-idiom family with connectors other than "but" — every pre-verb shape MINES on origin/main and must keep mining on the tip', () => {
    // G1 — "nothing EXCEPTION-PHRASE X VERB" reads as "ONLY X VERBs" (the
    // exception phrase names the thing that DOES wait): an affirmative
    // owner-wait claim — the same idiom class as F1 with the exception phrase
    // PRE-verb and a connector other than "but". The widened nothing-class
    // window's guard must cover exception prepositions, not only contrastive
    // connectives, or the 4–5-gap band suppresses claims main mines.
    for (const s of [
      'Nothing except the publish gate waits on the owner.',
      'Nothing other than the publish gate waits on the owner.',
      'Nothing more than the publish gate waits on the owner.',
      'Nothing apart from the publish gate waits on the owner.',
      'Nothing aside from the publish gate waits on the owner.',
      'Nothing save the publish gate waits on the owner.',
      'None except the publish gate waits on the owner.',
      'No one except the publish gate waits on the owner.',
      'Nothing except the publish gate is up to the owner to decide.',
      'Nothing besides the publish gate waits on the owner.',
      'Nothing beyond the publish gate waits on the owner.',
      'Nothing bar the publish gate waits on the owner.',
      'Nothing excluding the publish gate waits on the owner.',
      // Comma-wrapped aside variant of the same idiom (PARENTHETICAL_FRAME_RE's
      // guard covers the exception class too): main's comma-excluding frames die
      // at the first comma, so main mines — the tip must not suppress it.
      'Nothing, except the publish gate, waits on the owner.',
    ]) {
      expect(mineUnfiledDecisionClaims(s)).toEqual([s]);
    }
    // G1 suffix variant — the pre-existing F1-class hole on MAIN (main-parity []
    // before this fix): a post-verb exception with a connector other than "but"
    // re-arms the negated frame. Tip MINES / main [] — an intentional
    // divergence under the same over-approximation doctrine as F1 (a
    // mis-classification in this direction is a false NEGATIVE, the review's
    // blocking direction, so re-arming is the safe side).
    for (const s of [
      'Nothing waits on the owner except the publish gate.',
      'Nothing waits on the owner other than the publish gate.',
      'Nothing remains blocked on the owner except the seat swap.',
    ]) {
      expect(mineUnfiledDecisionClaims(s)).toEqual([s]);
    }
    // Boundary (main-parity []): the ≤3-gap except-shapes were NEVER the
    // regression — main's guard-less generic {0,3} frame suppresses them on
    // both sides (review 875216b0: "pre-existing parity").
    expect(mineUnfiledDecisionClaims('Nothing except the gate waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nobody except Paul waits on the owner.')).toEqual([]);
    // Boundary (mines both): a multi-word connector whose FIRST word is guarded
    // dies at gap word 1 — "but for" was never broken.
    expect(mineUnfiledDecisionClaims('Nothing but for the publish gate waits on the owner.')).toEqual([
      'Nothing but for the publish gate waits on the owner.',
    ]);
  });

  it('REGRESSION pins (adversarial review 875216b0, finding G2): the exception/intensifier connector class batch-enumerated in ONE pass — the guard covers every connector for which "Nothing CONN X VERBs" entails "X VERBs"', () => {
    // G2 — rounds 2→4 each found ONE more connector slice of the same family
    // (but → G1's ten exception prepositions → barring / excepting / saving /
    // minus / plus / less than / short of): enumerate-and-guard wins each
    // round and loses the general case, so this respin batch-enumerates the
    // WHOLE class in one pass (supervisor daee2916 steer): every
    // grammaticalized exception preposition + the emphatic-intensifier idioms,
    // swept tip-vs-main-replay through the REAL miner (66 connectors/phrases:
    // the 25 in-class candidates below + 51 boundary probes + exotic frame
    // variants; container has no /usr/share/dict, so the sweep used the
    // standard closed English preposition inventory + derived -ing forms).
    //
    // THE STANDING CLASS RULE (reviewer 875216b0 META option b, made
    // mechanical — the connector-class boundary): a connector belongs in the
    // guard IFF "Nothing CONN X VERBs" entails "X VERBs" — the exception
    // reading ("nothing barring the gate waits" = "ONLY the gate waits") or
    // the emphatic-intensifier reading ("nothing less/short than-of the gate
    // waits" = emphatically "the gate waits"). Every other 4–5-gap connector
    // stays suppressed — an INTENTIONAL tip/main divergence: main's guard-less
    // {0,3} frame cannot see a 4–5-word gap and over-mines, while the tip's
    // suppression is semantically correct ("Nothing without / including /
    // after the publish gate waits on the owner" does NOT assert the gate
    // waits). In the 4–5 band mining is main-parity by construction, so the
    // guard can never create a false positive vs main; at ≤3 gaps the
    // guard-less generic frame governs both sides. Future connector
    // discoveries route by the entailment test: in-class ⇒ blocking (add to
    // the guard); out-of-class ⇒ already documented here.
    // Round-5 reviewer nit (c), documented: the {0,5} window makes
    // "first-word guarding" effectively ANY-word-in-window guarding — the
    // guard fires on the connector word at ANY gap position ≤5 ("Nothing
    // much less the gate waits" fires on gap-2 "less"). The parity
    // over-suppressions this creates ("much less", "more or less", suffix
    // instances "plus or minus a day", "exclusive of weekends", "minus the
    // drama", "bar none", "barring a miracle") are safe-direction: main
    // over-mines identically or worse in every disclosed divergence class.
    for (const s of [
      // The reviewer's 9 demonstrated G2 sentences…
      'Nothing barring the publish gate waits on the owner.',
      'Nothing, barring the publish gate, waits on the owner.',
      'None barring the publish gate waits on the owner.',
      'Nothing excepting the publish gate waits on the owner.',
      'Nothing minus the publish gate waits on the owner.',
      'Nothing saving the publish gate waits on the owner.',
      'Nothing less than the publish gate waits on the owner.',
      'Nothing short of the publish gate waits on the owner.',
      'Nothing plus the publish gate waits on the owner.',
      // …plus the batch-enumerated remainder of the class (this respin's
      // sweep: each demonstrated tip-[] / main-mines BEFORE the fix):
      'Nothing outside the publish gate waits on the owner.',
      'Nothing outside of the publish gate waits on the owner.',
      'Nothing past the publish gate waits on the owner.',
      'Nothing exclusive of the publish gate waits on the owner.',
      'Nothing outwith the publish gate waits on the owner.',
      'Nothing otherwise than the publish gate waits on the owner.',
      // Comma-wrapped + subject/frame variants of the new connectors:
      'Nothing, excepting the publish gate, waits on the owner.',
      'Nothing, saving the publish gate, waits on the owner.',
      'Nothing, less than the publish gate, waits on the owner.',
      'Nothing, outside the publish gate, waits on the owner.',
      'Nothing, past the publish gate, waits on the owner.',
      'Nothing, outwith the publish gate, waits on the owner.',
      'None less than the publish gate waits on the owner.',
      'No one barring the publish gate waits on the owner.',
      'Nothing barring the publish gate is owner-gated.',
    ]) {
      expect(mineUnfiledDecisionClaims(s)).toEqual([s]);
    }
    // G2 suffix variant — same asymmetry doctrine as G1, but ONLY for
    // connectors UNAMBIGUOUS in post-verb position (barring / excepting /
    // minus / plus / exclusive of): "Nothing waits on the owner, barring the
    // publish gate." asserts ONLY the gate waits. Tip MINES / main [] — an
    // intentional divergence in the safe direction (main has no suffix
    // re-arm at all; the review's blocking direction is tip-[] vs
    // main-mines, which this can never create).
    for (const s of [
      'Nothing waits on the owner, barring the publish gate.',
      'Nothing waits on the owner, excepting the publish gate.',
      'Nothing waits on the owner, minus the publish gate.',
      'Nothing waits on the owner, plus the publish gate.',
      'Nothing waits on the owner, exclusive of the publish gate.',
      'Nothing waits on the owner barring the publish gate.',
    ]) {
      expect(mineUnfiledDecisionClaims(s)).toEqual([s]);
    }
    // Suffix PARITY [] (tip [] / main [], pinned): the remaining in-class
    // connectors are AMBIGUOUS in post-verb position and stay out of the
    // suffix re-arm by design — "saving" (causal participle: "Nothing waits
    // on the owner, saving 3 GPU-hours."), "less than"/"short of"
    // (comparative), "outside"/"past"/"outwith" (locative/temporal:
    // "Nothing waits on the owner past Friday." / "…outside business
    // hours."), "otherwise" (adverbial). Their PRE-verb band has no such
    // reading, so the asymmetry cannot leak a false negative there.
    for (const s of [
      'Nothing waits on the owner, saving the publish gate.',
      'Nothing waits on the owner, less than the publish gate.',
      'Nothing waits on the owner, short of the publish gate.',
      'Nothing waits on the owner, outside the publish gate.',
      'Nothing waits on the owner, past the publish gate.',
      'Nothing waits on the owner, outwith the publish gate.',
      'Nothing waits on the owner, otherwise than the publish gate.',
    ]) {
      expect(mineUnfiledDecisionClaims(s)).toEqual([]);
    }
    // THE CLASS BOUNDARY (documented residuals, tip [] / main mines — the
    // intentional divergence defined by the standing rule above): the full
    // swept inventory of non-exception connectors. These sentences do NOT
    // assert the gate waits ("Nothing including the publish gate waits on
    // the owner" asserts the OPPOSITE); main mines them only because its
    // reach stops at 3 gap words. Pinned [] so a future regression that
    // starts mining them is caught.
    for (const s of [
      'Nothing without the publish gate waits on the owner.',
      'Nothing including the publish gate waits on the owner.',
      'Nothing omitting the publish gate waits on the owner.',
      'Nothing despite the publish gate waits on the owner.',
      'Nothing unlike the publish gate waits on the owner.',
      'Nothing after the publish gate waits on the owner.',
      'Nothing before the publish gate waits on the owner.',
      'Nothing during the publish gate waits on the owner.',
      'Nothing through the publish gate waits on the owner.',
      'Nothing throughout the publish gate waits on the owner.',
      'Nothing toward the publish gate waits on the owner.',
      'Nothing towards the publish gate waits on the owner.',
      'Nothing against the publish gate waits on the owner.',
      'Nothing under the publish gate waits on the owner.',
      'Nothing over the publish gate waits on the owner.',
      'Nothing inside the publish gate waits on the owner.',
      'Nothing inside of the publish gate waits on the owner.',
      'Nothing near the publish gate waits on the owner.',
      'Nothing around the publish gate waits on the owner.',
      'Nothing within the publish gate waits on the owner.',
      'Nothing among the publish gate waits on the owner.',
      'Nothing amongst the publish gate waits on the owner.',
      'Nothing versus the publish gate waits on the owner.',
      // Round-5 reviewer nits (a)/(b) folded in as TEST-ONLY boundary pins
      // (verdict carry-forward explicitly authorized; no miner change):
      // (b) 'vs' — the abbreviated versus-class connector; rule-covered
      //     (no entailment) but previously absent from this inventory —
      //     pinned for mechanical completeness.
      'Nothing vs the publish gate waits on the owner.',
      // (a) 'rather than' — the standing rule adjudicates it OUT-OF-CLASS:
      //     the modern parse of "Nothing rather than X VERBs" is contrast/
      //     preference, not exception, so the entailment does not robustly
      //     hold; suppression is semantically correct and main's mining is
      //     the documented over-mine direction (tip [] / main mines,
      //     reviewer-demonstrated pre-verb AND comma-wrapped). If the
      //     archaic "nothing but X" reading ever shows up in a real report,
      //     the entailment test routes it INTO the guard instead.
      'Nothing rather than the publish gate waits on the owner.',
      'Nothing, rather than the publish gate, waits on the owner.',
      'Nothing via the publish gate waits on the owner.',
      'Nothing per the publish gate waits on the owner.',
      'Nothing for the publish gate waits on the owner.',
      'Nothing with the publish gate waits on the owner.',
      'Nothing from the publish gate waits on the owner.',
      'Nothing about the publish gate waits on the owner.',
      'Nothing above the publish gate waits on the owner.',
      'Nothing below the publish gate waits on the owner.',
      'Nothing between the publish gate waits on the owner.',
      'Nothing behind the publish gate waits on the owner.',
      'Nothing beneath the publish gate waits on the owner.',
      'Nothing onto the publish gate waits on the owner.',
      'Nothing upon the publish gate waits on the owner.',
      'Nothing across the publish gate waits on the owner.',
      'Nothing amid the publish gate waits on the owner.',
      'Nothing amidst the publish gate waits on the owner.',
      'Nothing considering the publish gate waits on the owner.',
      'Nothing following the publish gate waits on the owner.',
      'Nothing regarding the publish gate waits on the owner.',
      'Nothing respecting the publish gate waits on the owner.',
      'Nothing concerning the publish gate waits on the owner.',
      'Nothing ignoring the publish gate waits on the owner.',
      'Nothing discounting the publish gate waits on the owner.',
      'Nothing pending the publish gate waits on the owner.',
      'Nothing of the publish gate waits on the owner.',
    ]) {
      expect(mineUnfiledDecisionClaims(s)).toEqual([]);
    }
  });

  it('pins the reconciled residual families after the f7e9df4c merge (review 875216b0 observations; expectations re-based on NEGATED_FRAME_RE)', () => {
    // D1 re-based: "nothing but the usual VERB" asserts the usual verbs, but the
    // guard-less generic frame's {0,3} window catches "but the usual" — suppressed,
    // matching new main (review: "semantically defensible either way"). The
    // NOTHING_CLASS_FRAME_RE connective guard only preserves the >3-gap variants.
    expect(mineUnfiledDecisionClaims('Nothing but the usual waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing but the usual four gates wait on the owner.')).toEqual([
      'Nothing but the usual four gates wait on the owner.',
    ]);
    // Deliberate over-approximation: a trailing "but" after a negated frame re-arms
    // even when it opens an independent clause — telling an exception phrase from a
    // clause needs a verb lexicon, and every mis-classification in that direction is
    // a false NEGATIVE vs main (the review's blocking direction).
    expect(mineUnfiledDecisionClaims('Nothing waits on the owner, but the gate is broken.')).toEqual([
      'Nothing waits on the owner, but the gate is broken.',
    ]);
    // Family-(a) comma siblings DISSOLVE to main-parity mining: the comma-excluding
    // gap-word class (kept from NEGATED_FRAME_RE) kills the frame at the first comma,
    // so these unmarked short contrasts are live claims again.
    for (const s of [
      'Nothing happened, the gate waits on the owner.',
      'Nothing happened, and the gate waits on the owner.',
      'Nothing happened, so the gate waits on the owner.',
      'Nothing, the gate waits on the owner.',
      'Nothing else, the seat swap remains blocked on the owner.',
      'Nothing to report, the gate waits on the owner.',
      'Nothing happened, but the gate waits on the owner.',
    ]) {
      expect(mineUnfiledDecisionClaims(s)).toEqual([s]);
    }
    // Family-(a) residual core: a comma-less, connective-less short contrast inside
    // the widened nothing-class window still suppresses (main mines) — the documented
    // cost of covering I2's 4-word span, tracked for follow-up.
    expect(mineUnfiledDecisionClaims('Nothing happened and the gate waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing is gated and the seat waits on the owner.')).toEqual([]);
    // "Nothing yet waits on the owner." is suppressed by the generic frame's 1-word
    // gap (main-parity); the parenthesized-connective FP shapes keep mining on both
    // (the PARENTHETICAL_FRAME_RE connective guard) — pre-existing class tracked
    // for the follow-up ticket.
    expect(mineUnfiledDecisionClaims('Nothing yet waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('Nothing, though, waits on the owner.')).toEqual([
      'Nothing, though, waits on the owner.',
    ]);
    expect(mineUnfiledDecisionClaims('Nothing, however, waits on the owner.')).toEqual([
      'Nothing, however, waits on the owner.',
    ]);
  });

  it('still suppresses the parenthetical and hyphenated negation shapes — the win #851 alone could not keep', () => {
    // PARENTHETICAL_FRAME_RE: the comma pair directly after a nothing-class marker
    // still negates the frame after the closing comma (new main MINES this — the
    // divergence review 875216b0 called "a genuine win worth preserving").
    expect(mineUnfiledDecisionClaims('Nothing, as of this sweep, waits on the owner.')).toEqual([]);
    expect(mineUnfiledDecisionClaims('No-one waits on the owner.')).toEqual([]);
    // …and a post-verb "but X" exception re-arms even a parenthetical-negated frame.
    expect(mineUnfiledDecisionClaims('Nothing, as of this sweep, waits on the owner but the publish gate.')).toEqual([
      'Nothing, as of this sweep, waits on the owner but the publish gate.',
    ]);
  });
});

describe('sweepFollowThrough', () => {
  const wake = jest.fn(async () => ({ ok: true }));
  const flag = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_11111111-2222-4000-8000-000000000000' } }));
  const supRow = { id: SUP, userId: 'u1', title: 'canlegal-bench supervisor', projectId: 'p-bench', isSupervisor: false, isProjectSupervisor: true };
  const fleetRow = { id: FLEET, userId: 'u1', title: 'Fleet Supervisor', projectId: null, isSupervisor: true, isProjectSupervisor: false };
  const note = (content: string, at: Date, id = 'note-1') => ({ id, content, createdAt: at, metadata: { origin: 'hook' } });
  const seedCursor = (msAgo: number, chatId = SUP) => store.set(`follow-through:cursor:${chatId}`, String(NOW.getTime() - msAgo));
  const run = () => sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });

  beforeEach(() => {
    store.clear(); wake.mockClear(); flag.mockClear(); mockRecordLoopMetric.mockClear(); mockRedis.set.mockClear();
    for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) { fn.mockReset(); }
    mockPrisma.crossModelChat.findMany.mockResolvedValue([supRow]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-bench', projectSupervisorEnabled: true, archivedAt: null }]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
    mockPrisma.crossModelMessage.create.mockResolvedValue({});
    mockPrisma.runToolReceipt.findMany.mockResolvedValue([]);
    mockPrisma.projectTodo.findFirst.mockResolvedValue(null);
    mockPrisma.ownerQuestion.findFirst.mockResolvedValue(null);
    delete process.env.FOLLOW_THROUGH_DISABLED;
  });

  it('first sight of a supervisor seeds the cursor and judges nothing', async () => {
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(`Lane ${LANE} looks stalled.`, minutesAgo(120))]);
    const out = await run();
    expect(out).toEqual({ supervisors: 1, nudges: 0, autofiled: 0, askNudges: 0, askEscalations: 0 });
    expect(wake).not.toHaveBeenCalled();
    expect(store.get(`follow-through:cursor:${SUP}`)).toBe(String(NOW.getTime() - FOLLOW_THROUGH_GRACE_MS));
  });

  it('a PAUSED project supervisor is skipped entirely (no reads, no wakes)', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-bench', projectSupervisorEnabled: false, archivedAt: null }]);
    const out = await run();
    expect(out.supervisors).toBe(0);
    expect(mockPrisma.crossModelMessage.findMany).not.toHaveBeenCalled();
  });

  it('a stall diagnosis with no action after the grace window wakes the supervisor once per lane per day; a fresh note waits; receipts are read from 15 min BEFORE the row', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note(`Lane ${LANE} looks stalled: no receipts in 6h.`, minutesAgo(30), 'fresh'), // inside grace → not judged yet
      note(`Lane ${LANE} looks stalled: no receipts in 6h.`, minutesAgo(120), 'due'),
    ]);
    const out = await run();
    expect(out.nudges).toBe(1);
    const call = (wake.mock.calls[0] as any)[0];
    expect(call.targetChatId).toBe(SUP);
    expect(call.prompt).toContain(`[FOLLOW-THROUGH] At 09-16 19:00Z you diagnosed lane ${LANE} as stalled`);
    expect(call.prompt).toContain('120 minutes later no action toward that lane is on record');
    expect(call.prompt).toContain('IN THE DIAGNOSIS SENTENCE ITSELF');
    expect(call.meta).toMatchObject({ origin: 'follow-through', kind: 'diagnosis_without_action', laneId8: LANE, noteId: 'due' });
    expect(mockRedis.set).toHaveBeenCalledWith(`follow-through:nudge:${SUP}:${LANE}`, 'due', { EX: NUDGE_DEDUPE_SEC });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'follow_through_nudge', sessionId: SUP, meta: expect.objectContaining({ laneId8: LANE, projectId: 'p-bench' }) }));
    expect(store.get(`follow-through:cursor:${SUP}`)).toBe(String(minutesAgo(120).getTime()));
    expect(mockPrisma.runToolReceipt.findMany.mock.calls[0][0].where).toMatchObject({ chatId: SUP, ok: true, createdAt: { gte: new Date(minutesAgo(120).getTime() - FOLLOW_THROUGH_RUN_SLACK_MS) } });

    // same lane again within the day → deduped
    seedCursor(3 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(`Lane ${LANE} is still stalled.`, minutesAgo(100), 'due2')]);
    const again = await run();
    expect(again.nudges).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a receipt naming the lane, a todo write on a todo assigned to the lane, or an AGENT message posted into the lane silences the nudge', async () => {
    const stalled = () => { seedCursor(6 * 3600_000); mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(`Lane ${LANE} looks stalled.`, minutesAgo(120))]); };
    stalled();
    mockPrisma.runToolReceipt.findMany.mockResolvedValueOnce([{ tool: 'send_chat_message', ids: { chatId: `${LANE}-0000-4000-8000-000000000000` } }]);
    expect((await run()).nudges).toBe(0);

    stalled();
    mockPrisma.runToolReceipt.findMany.mockResolvedValueOnce([{ tool: 'todo_update', ids: { todoId: 'todo-1' } }]);
    mockPrisma.projectTodo.findFirst.mockResolvedValueOnce({ id: 'todo-1' });
    expect((await run()).nudges).toBe(0);
    expect(mockPrisma.projectTodo.findFirst.mock.calls[0][0].where).toMatchObject({ id: { in: ['todo-1'] }, userId: 'u1', assigneeChatId: { startsWith: LANE } });

    stalled();
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: `${LANE}-0000-4000-8000-000000000000` });
    mockPrisma.crossModelMessage.findFirst.mockResolvedValueOnce({ id: 'posted' });
    expect((await run()).nudges).toBe(0);
    expect(mockPrisma.crossModelChat.findFirst.mock.calls[0][0].where).toMatchObject({ id: { startsWith: LANE }, userId: 'u1' }); // same-owner lanes only
    expect(mockPrisma.crossModelMessage.findFirst.mock.calls[0][0].where).toMatchObject({ role: 'user', metadata: { path: ['origin'], equals: 'agent' } });
    expect(wake).not.toHaveBeenCalled();
  });

  it('an unrelated blanket action (a file_feedback on something else) no longer exonerates the lane', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note(`Lane ${LANE} looks stalled.`, minutesAgo(120))]);
    mockPrisma.runToolReceipt.findMany.mockResolvedValueOnce([{ tool: 'file_feedback', ids: { ticketId: 'x' } }]);
    expect((await run()).nudges).toBe(1);
  });

  it('an owner-gated claim with NO open owner question files one (machine-triggered) and posts the oq id back with the triage caveat; dedupes for 72h', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note('Publishing v0.8.2 is owner-gated on Gates 1–3.', minutesAgo(120))]);
    mockPrisma.crossModelChat.findMany.mockResolvedValueOnce([supRow]).mockResolvedValueOnce([{ id: SUP }, { id: 'lane-1' }]);
    const out = await run();
    expect(out.autofiled).toBe(1);
    expect(mockPrisma.ownerQuestion.findFirst.mock.calls[0][0].where).toMatchObject({ userId: 'u1', status: 'open', OR: [{ chatId: { in: [SUP, 'lane-1'] } }, { forChatId: { in: [SUP, 'lane-1'] } }] });
    expect(flag).toHaveBeenCalledWith(expect.objectContaining({
      chatId: SUP, userId: 'u1', machineTriggered: true,
      question: expect.stringContaining('Decision needed — auto-filed from the canlegal-bench supervisor note at 09-16 19:00Z: "Publishing v0.8.2 is owner-gated on Gates 1–3."'),
    }));
    const row = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(row).toMatchObject({ chatId: SUP, role: 'assistant', metadata: { origin: 'follow-through', kind: 'decision-autofiled', outcome: 'created' } });
    expect(row.content).toContain('Filed oq_11111111 for you — it goes to the Fleet Supervisor\'s triage first');
    expect(row.content).toContain('flag_owner_question');
    expect(mockRedis.set).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^follow-through:autofile:${SUP}:`)), 'note-1', { EX: AUTOFILE_DEDUPE_SEC });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'decision_autofiled', meta: expect.objectContaining({ outcome: 'created', oqId: 'oq_11111111-2222-4000-8000-000000000000' }) }));

    // same sentence again → deduped, no second filing
    seedCursor(3 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note('Publishing v0.8.2 is owner-gated on Gates 1–3.', minutesAgo(100), 'note-2')]);
    await run();
    expect(flag).toHaveBeenCalledTimes(1);
  });

  it('a note whose only gating frame is NEGATED files nothing and posts no notice (replay pin, feedback f7e9df4c: the "zero open owner questions" status line became owner card oq_06b64479)', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      note('BOARD 07:30Z — CanLaw steady. Zero open owner questions; nothing waits on the owner.', minutesAgo(120)),
    ]);
    const out = await run();
    expect(out.autofiled).toBe(0);
    expect(flag).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'decision_autofiled' }));
  });

  it('the Fleet Supervisor counts ANY open owner question of the owner (its digest restates project state a project supervisor already filed); its own filing is owner-direct', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([fleetRow]);
    seedCursor(6 * 3600_000, FLEET);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note('canlegal-bench: publishing v0.8.2 remains owner-gated on Gates 1–3.', minutesAgo(120))]);
    mockPrisma.ownerQuestion.findFirst.mockResolvedValueOnce({ id: 'oq_on_a_project_lane' });
    expect((await run()).autofiled).toBe(0);
    expect(mockPrisma.ownerQuestion.findFirst.mock.calls[0][0].where).toEqual({ userId: 'u1', status: 'open' });
    expect(flag).not.toHaveBeenCalled();

    seedCursor(6 * 3600_000, FLEET);
    expect((await run()).autofiled).toBe(1);
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content).toContain('Filed oq_11111111 for you (the owner sees it in the Inbox and on Telegram).');
  });

  it('an open owner question for the chat/project means nothing to file; an already-answered prior posts the "cite it as answered" notice; a refusal posts why', async () => {
    seedCursor(6 * 3600_000);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([note('Publishing v0.8.2 is owner-gated on Gates 1–3.', minutesAgo(120))]);
    mockPrisma.ownerQuestion.findFirst.mockResolvedValueOnce({ id: 'oq_open' });
    expect((await run()).autofiled).toBe(0);
    expect(flag).not.toHaveBeenCalled();

    seedCursor(6 * 3600_000);
    const answered = jest.fn(async () => ({ kind: 'refused', refused: 'previously_answered', prior: { id: 'oq_bd1130d5-aaaa-4000-8000-000000000000', status: 'answered', answer: 'Keep dflash2E; do not fall back.' } }));
    const out = await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: answered as any });
    expect(out.autofiled).toBe(1);
    let row = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(row.metadata).toMatchObject({ outcome: 'previously_answered' });
    expect(row.content).toContain('the owner already answered this in oq_bd1130d5: "Keep dflash2E; do not fall back."');
    expect(row.content).toContain('Cite oq_bd1130d5 as ANSWERED');

    store.clear(); seedCursor(6 * 3600_000); mockPrisma.crossModelMessage.create.mockClear();
    const refused = jest.fn(async () => ({ kind: 'refused', refused: 'multi_decision' }));
    await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: refused as any });
    row = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(row.metadata).toMatchObject({ outcome: 'refused:multi_decision' });
    expect(row.content).toContain('split it into one flag_owner_question per decision');
  });

  it('the kill switch short-circuits before any read', async () => {
    process.env.FOLLOW_THROUGH_DISABLED = '1';
    expect(await sweepFollowThrough({ now: NOW })).toEqual({ supervisors: 0, nudges: 0, autofiled: 0, askNudges: 0, askEscalations: 0 });
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
  });

  it('renderFollowThroughWake names the lane, the quoted diagnosis, the elapsed minutes and the tools', () => {
    const txt = renderFollowThroughWake({ laneId8: LANE, sentence: 'Lane 3f1c2a9b looks stalled.' }, minutesAgo(95), NOW);
    expect(txt).toContain(`lane ${LANE} as stalled — "Lane 3f1c2a9b looks stalled."`);
    expect(txt).toContain('95 minutes later');
    expect(txt).toContain('save_supervisor_state'); // model-facing spelling (tool-scope.ts)
  });
});

describe('wiring pins (source-level)', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  it('the attention watchdog runs the follow-through sweep before its per-user pass', () => {
    const src = read('./attention-watchdog.service.ts');
    expect(src).toContain("const { sweepFollowThrough } = await import('./follow-through.service');");
    expect(src.indexOf('sweepFollowThrough')).toBeLessThan(src.indexOf('await sweepUser(sup.userId, sup.id, now);'));
  });
  it('the worker runs the premise re-check on its OWN hourly cron slot, not inside the project digest', () => {
    const src = read('../../../worker.ts');
    expect(src).toContain("{ id: 'premise-check', intervalSec: 3600 }");
    expect(src).toContain("const { runPremiseCheckOnce } = await import('./modules/crossmodel/platform/premise-register');");
    const digest = src.slice(src.indexOf("'project-digest': async () => {"), src.indexOf("'premise-check': async () => {"));
    expect(digest).not.toContain('runPremiseCheckOnce');
  });
  it('both supervisor prompts carry the premise + follow-through doctrine', () => {
    // build 2026-10-08 S-2: the doctrine rides the layered role profiles (role-profiles.ts) — the
    // dated pre-layering builders in the supervisor services were deleted.
    const roles = read('../platform/role-profiles.ts');
    expect(roles).toContain('- PREMISES: a NUMBER a goal rests on');
    expect(roles).toContain('- FOLLOW-THROUGH: a diagnosis is not an action');
    expect(roles).toContain('IN THE SAME SENTENCE');
    expect(roles).toContain('PREMISES + FOLLOW-THROUGH');
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// A switched-off tier is dropped from the sweep like a paused project lane:
// no note reads, no nudge, no auto-filing — one supervisor_switch skip row per
// dropped lane (source 'follow-through'). The other tier is unaffected.
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests } from '../platform/supervisor-switch';

describe('supervisor OFF switch × sweepFollowThrough', () => {
  const wake = jest.fn(async () => ({ ok: true }));
  const flag = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_11111111-2222-4000-8000-000000000000' } }));
  const supRow = { id: SUP, userId: 'u1', title: 'canlegal-bench supervisor', projectId: 'p-bench', isSupervisor: false, isProjectSupervisor: true };
  const fleetRow = { id: FLEET, userId: 'u1', title: 'Fleet Supervisor', projectId: null, isSupervisor: true, isProjectSupervisor: false };
  const switchRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'supervisor_switch');
  const offRow = (key: string) => async ({ where }: any) => (where?.key === key ? { key, value: '0', updatedAt: NOW } : null);

  beforeEach(() => {
    store.clear(); wake.mockClear(); flag.mockClear(); mockRecordLoopMetric.mockClear();
    for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) { fn.mockReset(); }
    mockPrisma.crossModelChat.findMany.mockResolvedValue([supRow, fleetRow]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-bench', projectSupervisorEnabled: true, archivedAt: null }]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
    invalidateSupervisorSwitchCache();
    resetSupervisorSwitchMetricWindowForTests();
    delete process.env.FOLLOW_THROUGH_DISABLED;
  });

  it('fleet OFF: the Fleet Supervisor is dropped (no note reads) and counted; the project lane still sweeps', async () => {
    mockPrisma.systemSetting.findUnique.mockImplementation(offRow('fleet_supervisor_enabled'));
    invalidateSupervisorSwitchCache();
    const out = await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });
    expect(out.supervisors).toBe(1);
    const readChats = mockPrisma.crossModelMessage.findMany.mock.calls.map((c: any[]) => c[0]?.where?.chatId);
    expect(readChats).toContain(SUP);
    expect(readChats).not.toContain(FLEET);
    expect(wake).not.toHaveBeenCalled();
    expect(switchRows()).toEqual([expect.objectContaining({ sessionId: FLEET, meta: expect.objectContaining({ target: 'fleet', action: 'skipped', source: 'follow-through', chatId: FLEET }) })]);
  });

  it('project OFF: the project lane is dropped and counted; the Fleet Supervisor still sweeps', async () => {
    mockPrisma.systemSetting.findUnique.mockImplementation(offRow('project_supervisors_enabled'));
    invalidateSupervisorSwitchCache();
    const out = await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });
    expect(out.supervisors).toBe(1);
    const readChats = mockPrisma.crossModelMessage.findMany.mock.calls.map((c: any[]) => c[0]?.where?.chatId);
    expect(readChats).toContain(FLEET);
    expect(readChats).not.toContain(SUP);
    expect(switchRows()[0].meta).toMatchObject({ target: 'project', source: 'follow-through', chatId: SUP });
  });

  it('both ON: both lanes sweep, no switch rows', async () => {
    const out = await sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });
    expect(out.supervisors).toBe(2);
    expect(switchRows()).toHaveLength(0);
  });
});

// ── Detector 3 — UNANSWERED OWNER ASK (tt-rd audit 2026-09-27, finding 5) ────
// The 09-25 19:16Z "what is going on…" ask stayed open across ~140 wakes with
// no nudge: follow-through had only two detectors and neither read the ledger.
describe('detector 3 — unanswered owner asks', () => {
  const wake: jest.Mock = jest.fn(async (..._a: any[]) => ({ ok: true }));
  const flag = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_x' } }));
  const supRow = { id: SUP, userId: 'u1', title: 'tt-rd Supervisor', projectId: 'p-ttrd', isSupervisor: false, isProjectSupervisor: true };
  const fleetRow = { id: FLEET, userId: 'u1', title: 'Fleet Supervisor', projectId: null, isSupervisor: true, isProjectSupervisor: false };
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
  const askRow = (id: string, h: number, text = 'what is going on with the speed mission') => ({ id, text, at: hoursAgo(h).toISOString(), messageId: `msg-${id}-aaaaaaaa` });
  const asks = jest.fn(async (): Promise<any[]> => []);
  const replied: jest.Mock = jest.fn(async (..._a: any[]): Promise<boolean> => false);
  const run = () => sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any, listOpenOwnerAsks: asks as any, hasSupervisorReplyAfter: replied as any });
  const askMetrics = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r.kind === 'owner_ask_nudge');

  beforeEach(() => {
    store.clear(); wake.mockClear(); flag.mockClear(); mockRecordLoopMetric.mockClear(); asks.mockReset().mockResolvedValue([]); replied.mockReset().mockResolvedValue(false);
    for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) { fn.mockReset(); }
    mockPrisma.crossModelChat.findMany.mockResolvedValue([supRow]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(fleetRow); // the Fleet Supervisor lookup for escalation
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-ttrd', projectSupervisorEnabled: true, archivedAt: null }]);
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]); // no notes — the detector must not depend on the note cursor
    mockPrisma.systemSetting.findUnique.mockResolvedValue(null);
  });

  it('an ask older than 2 h with no reply wakes the supervisor ONCE with [FOLLOW-THROUGH]; a younger one and an answered one do not', async () => {
    asks.mockResolvedValue([askRow('d-old', 3), askRow('d-young', 1, 'any progress ?'), askRow('d-answered', 4, 'where are we at')]);
    replied.mockImplementation(async (_chat: string, at: Date) => at.getTime() === hoursAgo(4).getTime());
    const out = await run();
    expect(out.askNudges).toBe(1);
    expect(out.askEscalations).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
    const w = wake.mock.calls[0][0] as any;
    expect(w.targetChatId).toBe(SUP);
    expect(w.prompt).toContain('[FOLLOW-THROUGH] The owner asked "what is going on with the speed mission" at');
    expect(w.prompt).toContain(`(msg ${'msg-d-old-aaaaaaaa'.slice(0, 8)})`);
    expect(w.prompt).toContain('180 minutes later has no reply');
    expect(w.meta).toMatchObject({ origin: 'follow-through', kind: 'owner_ask_unanswered', directiveId: 'd-old' });
    expect(askMetrics()).toEqual([expect.objectContaining({ kind: 'owner_ask_nudge', sessionId: SUP, meta: expect.objectContaining({ stage: 'nudge', directiveId: 'd-old', projectId: 'p-ttrd' }) })]);
    // dedupe: the same ask is not nudged again inside the window
    wake.mockClear();
    await run();
    expect(wake).not.toHaveBeenCalled();
  });

  it('an ask older than 8 h escalates ONE line into the Fleet Supervisor chat (after the nudge), once; the Fleet Supervisor\'s own asks are never escalated', async () => {
    asks.mockResolvedValue([askRow('d-stale', 9)]);
    const out = await run();
    expect(out.askNudges).toBe(1);
    expect(out.askEscalations).toBe(1);
    expect(wake).toHaveBeenCalledTimes(2);
    const esc = wake.mock.calls[1][0] as any;
    expect(esc.targetChatId).toBe(FLEET);
    expect(esc.prompt).toContain('[OWNER ASK UNANSWERED 9h] tt-rd: the owner asked "what is going on with the speed mission"');
    expect(esc.prompt).toContain('answer it yourself from the ledger');
    expect(esc.prompt).toContain('or steer the project supervisor');
    expect(esc.meta).toMatchObject({ kind: 'owner_ask_escalated', supervisorChatId: SUP, directiveId: 'd-stale' });
    expect(askMetrics().map((r) => r.meta.stage)).toEqual(['nudge', 'escalate']);
    wake.mockClear();
    await run();
    expect(wake).not.toHaveBeenCalled(); // both keys deduped
    // the Fleet Supervisor's own stale ask: nudge only
    store.clear(); wake.mockClear();
    mockPrisma.crossModelChat.findMany.mockResolvedValue([fleetRow]);
    const fleetOut = await run();
    expect(fleetOut.askNudges).toBe(1);
    expect(fleetOut.askEscalations).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
    expect((wake.mock.calls[0][0] as any).targetChatId).toBe(FLEET);
  });

  it('a ledger read error is swallowed', async () => {
    asks.mockRejectedValue(new Error('boom'));
    await expect(run()).resolves.toMatchObject({ askNudges: 0, askEscalations: 0 });
  });

  it('the renders are pure and name the msg id, the clock and the remedy', () => {
    const a = askRow('d-1', 3);
    expect(renderOwnerAskNudge(a, hoursAgo(3), NOW)).toContain('citing msg msg-d-1-');
    expect(renderOwnerAskNudge(a, hoursAgo(3), NOW)).toContain('An owner question outranks every sweep and report-up');
    expect(renderOwnerAskEscalation('tt-rd', a, hoursAgo(9), NOW)).toContain('[OWNER ASK UNANSWERED 9h] tt-rd:');
    expect(renderOwnerAskEscalation('tt-rd', a, hoursAgo(9), NOW)).toContain('cite msg msg-d-1-');
  });
});
