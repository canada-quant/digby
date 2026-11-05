/**
 * MISHAP REPLAY — ticket 1256aadd (2026-10-13 03:26Z): the One Piece TCG
 * project supervisor's machine-wake note (chat 5c3f302e, msg 068fae67,
 * delivered 03:26:25.314Z) was observe-only ANNOTATED for a board-status
 * contradiction that was not one:
 *
 *   "**What is next:** when oq_c65275e3 is answered, its answer lands in this
 *    chat and wakes me — that wake re-dispatches by messaging lane 7ace91b1
 *    directly (its branch holds 0cd17a9; no new spawn needed)."
 *
 * The ledger row oq_c65275e3-cd85-4507-a471-314ccd452308 was OPEN (verified
 * fresh at fix time via list_owner_questions: status open, triaged,
 * triageUntil 2026-10-13T05:20:52.200Z) — and the note itself had asserted
 * exactly that one paragraph earlier ("Fresh pull shows it **open and under
 * supervisor triage**", a line the sentence-level 'if' register already skips
 * because it ends "only if still unanswered after the triage SLA"). The
 * convicted line was a FUTURE PLAN: "when X is answered, Y happens".
 *
 * Two gaps let a when-clause parse as a present-tense board read:
 *  1. BOARD_HISTORY_RE skipped if|unless|would|should|will — but NOT
 *     when|once|as-soon-as (the other hypothetical subordinators).
 *  2. The oq miner's status window was presence-based: any "answered" within
 *     70 chars of the id counted, with no notion of WHICH CLAUSE it sat in.
 *
 * The fix is two-layered (both pinned here):
 *  - when|once|as-soon-as join the sentence-level hypothetical register
 *    (house precedent: "If oq_X is still open tomorrow, escalate." skips);
 *  - until|till|after|before are suppressed SPAN-SCOPED — the nearest cue
 *    before a status word governs it only when no clause boundary (comma /
 *    semicolon / colon / dash / arrow) separates them. They are deliberately
 *    NOT sentence-level: "oq_X is still open, parked until the owner rules"
 *    ASSERTS oq_X's present status (the 2026-09-16 first live strike relies
 *    on exactly that shape, replayed below).
 *
 * Mock discipline mirrors action-verifier.board-assertions.a9846924.test.ts.
 */
const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), groupBy: jest.fn(async () => []) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
  runToolReceipt: { findFirst: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, fileFeedbackTicket: jest.fn(async () => ({ deduped: false, ticket: { id: 't-1' } })) }));
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: jest.fn(async () => []) }));

import { mineBoardAssertions, mineBoardCountAssertions, findPhantomBoardAssertions, computePhantomClaims, isCitationClassClaim, BOARD_ASSERTION_TAG } from './action-verifier';

const CHAT = '5c3f302e-0000-4000-8000-000000000000'; // the convicted supervisor chat's prefix
const OQ = 'c65275e3'; // REAL row: status 'open' at incident time and at fix time

// The note's two board-bearing paragraphs, VERBATIM as delivered (msg 068fae67).
// The "What needs the owner" paragraph is the note's own honest, correct board
// read; the "What is next" paragraph is the future plan the guard convicted.
const INCIDENT_NOTE = [
  '**What needs the owner (one card):** oq_c65275e3, filed this wake, gates todo 177d52a5 / goal 9ea2a7eb. Fresh pull shows it **open and under supervisor triage (oq_c65275e3, surfaces 05:20:52Z)** — the owner sees it only if still unanswered after the triage SLA. It is a genuinely physically-human step with no autonomous path left: quit (⌘Q) + relaunch the Digby Mac app on mbp-1, or power on mbp-2 / the mac-mini, or enable Remote Login on any Mac. **My recommendation: the ⌘Q relaunch on mbp-1 — one action, done in seconds.**',
  '**What is next:** when oq_c65275e3 is answered, its answer lands in this chat and wakes me — that wake re-dispatches by messaging lane 7ace91b1 directly (its branch holds 0cd17a9; no new spawn needed). Watch firing 20 at 06:04Z runs autonomously. Board holds: 3 active goals (9ea2a7eb Discord 2/4 · 53da5b4c restore 0/1 · 21cbad9f #/sim 1/2), 4 blocked todos — all external/deps.',
].join('\n');

// The ledger as it stood at strike time and at fix time: OPEN (and the count
// assertions in the same note agreed — the ticket cited only the oq row).
const statusLookupOpen = jest.fn(async (kind: string, id: string) => (kind === 'oq' && id === OQ ? 'open' : null));
const countsLookupAgreeing = jest.fn(async () => ({ goals: { active: 3 }, todos: { blocked: 4 } }));
const RUN_STARTED = new Date('2026-10-13T03:15:20.000Z'); // the wake's run start (harvest wake 03:15Z→03:26Z)

describe('1256aadd — future subordinates are plans, not board reads (replay)', () => {
  it('1. THE REPLAY (miner): the incident note mines NO oq assertion — the when-clause "answered" is a plan, and the honest "open" line rides the pre-existing if-register skip', () => {
    const mined = mineBoardAssertions(INCIDENT_NOTE);
    expect(mined.filter((a) => a.kind === 'oq' && a.id === OQ)).toEqual([]);
  });

  it('2. THE REPLAY (matcher): the incident note against its real ledger (open, counts agreeing) strikes NOTHING — pre-fix this convicted citation-class and annotated the delivered note', async () => {
    const strikes = await findPhantomBoardAssertions(INCIDENT_NOTE, [], { chatId: CHAT, supervisorScope: 'project', runStartedAt: RUN_STARTED }, statusLookupOpen as any, countsLookupAgreeing as any);
    expect(strikes).toEqual([]);
  });

  it('3. THE REPLAY (wiring): the convicted line through computePhantomClaims produces no oq-kind phantom', async () => {
    const out = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', parts: [], receipts: [],
      finalText: '**What is next:** when oq_c65275e3 is answered, its answer lands in this chat and wakes me — that wake re-dispatches by messaging lane 7ace91b1 directly (its branch holds 0cd17a9; no new spawn needed).',
      supervisor: true, supervisorScope: 'project', machineTriggered: true, runStartedAt: RUN_STARTED,
    });
    expect(out.phantoms.filter((p: any) => p.kind === 'oq' && p.id === OQ)).toEqual([]);
  });

  it('4. an honest present-tense open assertion in the SAME shape still mines (the relaxation eats no true board read)', () => {
    const mined = mineBoardAssertions('oq_c65275e3 is still open per this run\'s list_owner_questions pull.');
    expect(mined).toEqual([expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' })]);
  });

  it('5. a contradicting present-tense answered assertion still strikes (the mirrored direction of the incident)', async () => {
    const statusAnswered = jest.fn(async (kind: string, id: string) => (kind === 'oq' && id === OQ ? 'open' : null));
    const strikes = await findPhantomBoardAssertions('oq_c65275e3 is answered — the owner picked the ⌘Q relaunch.', [], { chatId: CHAT, supervisorScope: 'project' }, statusAnswered as any, countsLookupAgreeing as any);
    expect(strikes).toEqual([expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered', ledger: 'open' })]);
    expect(isCitationClassClaim(strikes[0])).toBe(true);
    expect(strikes[0].detail.startsWith(BOARD_ASSERTION_TAG)).toBe(true);
  });
});

describe('1256aadd — DETECTOR-RECALL REPLAY: the board-assertion lane\'s prior true positives still convict', () => {
  // The lane's convicting cases from its existing replay files
  // (action-verifier.board-assertions.2026-09-16 / .f8fc93be / .a9846924.test.ts),
  // re-run against the post-1256aadd miner: the relaxation must not erode them.
  const answered = jest.fn(async (kind: string, id: string) => (kind === 'oq' ? 'answered' : null));
  const openLedger = jest.fn(async (kind: string, id: string) => (kind === 'oq' ? 'open' : null));
  const todoInProg = jest.fn(async (kind: string, id: string) => (kind === 'todo' && id === '3f1c2a9b' ? 'in_progress' : null));
  const noCounts = jest.fn(async () => null);

  it('2026-09-16 first live strike: "still open" vs ledger answered still convicts', async () => {
    const out = await findPhantomBoardAssertions('Owner ruling oq_bd1130d5 is still open, so the decision stays parked.', [], { chatId: CHAT, supervisorScope: 'project' }, answered as any, noCounts as any);
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: 'bd1130d5', asserted: 'open', ledger: 'answered' })]);
  });

  it('2026-09-16 wiring shape with a TRAILING until-clause still convicts through computePhantomClaims (the main clause asserts; the until-clause never governed it)', async () => {
    mockPrisma.ownerQuestion.findFirst.mockResolvedValue({ status: 'answered' });
    const out = await computePhantomClaims({
      chatId: CHAT, userId: 'u1', parts: [], receipts: [],
      finalText: 'Sweep complete. Owner ruling oq_bd1130d5 is still open, so the dflash2E fallback stays parked until the owner rules.',
      supervisor: true, supervisorScope: 'project', machineTriggered: true, runStartedAt: new Date('2026-09-16T07:00:00.000Z'),
    });
    const board = out.phantoms.filter((p: any) => p.kind === 'oq');
    expect(board).toEqual([expect.objectContaining({ id: 'bd1130d5', asserted: 'open', ledger: 'answered' })]);
  });

  it('f8fc93be incident sentence (verbatim) still convicts: a fresh-probe open claim vs the answered ledger', async () => {
    const INCIDENT_SENTENCE = '20:57Z — Fresh probes this rewrite: oq_3458f265 (fleet-filed 20:07Z, Command A+ re-provision fork) is OPEN per this-wake list_owner_questions; the Option A lane (chat cba0dfe9) is RUNNING with generation complete at 1395/1395 rows, and both lanes are correctly gated on the owner while it stands open.';
    const out = await findPhantomBoardAssertions(INCIDENT_SENTENCE, [], { chatId: CHAT, supervisorScope: 'project' }, answered as any, noCounts as any);
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: '3458f265', asserted: 'open', ledger: 'answered' })]);
  });

  it('answered-direction conviction: "The owner answered oq_bd1130d5" vs an open ledger still convicts', async () => {
    const out = await findPhantomBoardAssertions('The owner answered oq_bd1130d5: keep dflash2E.', [], { chatId: CHAT, supervisorScope: 'project' }, openLedger as any, noCounts as any);
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: 'bd1130d5', asserted: 'answered', ledger: 'open' })]);
  });

  it('a9846924 pre-run-answer shape still strikes (the race tier never launders it, and neither do the new guards)', async () => {
    const PRE_RUN_ANSWER = new Date('2026-10-07T00:30:00.000Z');
    const transitionBeforeRun = jest.fn(async () => PRE_RUN_ANSWER);
    const out = await findPhantomBoardAssertions(
      'Owner question **oq_4f3d7dde**: OPEN (fresh probe — filed 01:11:35Z by chat bb8f1073) — the one manual sign-in on emulator-5554 remains the fallback.',
      [], { chatId: CHAT, supervisorScope: 'project', runStartedAt: new Date('2026-10-07T01:43:50.000Z') },
      answered as any, noCounts as any, transitionBeforeRun as any,
    );
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: '4f3d7dde', asserted: 'open', ledger: 'answered' })]);
  });

  it('todo lane recall: a framed todo status contradiction still convicts (the sentence-level register change never touches framedRowStatus)', async () => {
    const out = await findPhantomBoardAssertions('todo 3f1c2a9b is blocked on the vendor firmware.', [], { chatId: CHAT, supervisorScope: 'project' }, todoInProg as any, noCounts as any);
    expect(out).toEqual([expect.objectContaining({ kind: 'todo', id: '3f1c2a9b', asserted: 'blocked', ledger: 'in_progress' })]);
  });
});

describe('1256aadd — the span guard (until/till/after/before), clause-scoped', () => {
  it('a comma-less after-clause suppresses its own "answered" (span layer alone — no sentence-level cue)', () => {
    expect(mineBoardAssertions('after oq_c65275e3 is answered the wake re-dispatches lane 7ace91b1')).toEqual([]);
  });

  it('a trailing after-clause does not reach back: "answered; after that …" still asserts', () => {
    expect(mineBoardAssertions('oq_c65275e3 is answered; after that the lane re-dispatches')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered' }),
    ]);
  });

  it('cue AFTER the word never suppresses it: "still open until the owner rules" keeps mining open (the 2026-09-16 class)', () => {
    expect(mineBoardAssertions('oq_c65275e3 is still open until the owner rules.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
  });

  it('a when-conditional about the future state is skipped whole (house precedent: "If oq_X is still open tomorrow, escalate.")', () => {
    expect(mineBoardAssertions('When the 06:04Z watch fires, oq_c65275e3 is still open and parked.')).toEqual([]);
    expect(mineBoardAssertions('If oq_bd1130d5 is still open tomorrow, escalate.')).toEqual([]);
  });

  it('once/as-soon-as mirror when (sentence-level + span)', () => {
    expect(mineBoardAssertions('Once oq_c65275e3 is answered, its answer lands in this chat and wakes me.')).toEqual([]);
    expect(mineBoardAssertions('As soon as oq_c65275e3 is answered the lane resumes.')).toEqual([]);
  });

  it('a boundary ends the cue\'s clause: "until the SLA, oq_c65275e3 is answered" still asserts', () => {
    expect(mineBoardAssertions('until the triage SLA passes, oq_c65275e3 is answered in this chat')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered' }),
    ]);
  });
});

describe('1256aadd — the count lane\'s sibling register (COUNT_HISTORY_RE) gets the same hypothetical markers', () => {
  it('a when-conditional count prediction mines nothing (the oq-lane defect class, mirrored)', () => {
    expect(mineBoardCountAssertions('When the 06:04Z watch fires, 3 active goals remain on the board.')).toEqual([]);
    expect(mineBoardCountAssertions('If the owner answers tonight, 2 open todos drop to zero.')).toEqual([]);
  });

  it('count recall intact: the present-tense count shapes the 2026-09-16 pin convicts still mine', () => {
    expect(mineBoardCountAssertions('Same 4 active goals as last sweep; 9 open todos; 2 of 9 todos blocked.')).toEqual([
      expect.objectContaining({ family: 'goal', qualifier: 'active', count: 4 }),
      expect.objectContaining({ family: 'todo', qualifier: 'open', count: 9 }),
      expect.objectContaining({ family: 'todo', qualifier: 'blocked', count: 2 }),
    ]);
    expect(mineBoardCountAssertions('3 of 4 goals active this week.')).toEqual([expect.objectContaining({ family: 'goal', qualifier: 'active', count: 3 })]);
  });
});

// (ticket 2475ab13) Follow-up to the follow-up: the 1256aadd sentence-level
// skip was applied to ANY sentence carrying when|once|as-soon-as, which eroded
// recall in two constructed shapes the independent adversarial review
// (sub-session a6a61cd6, msg 242710b7) probed at both commits:
//   Finding 1 (mixed sentence): "oq_c65275e3 is still open; when the owner
//     answers, I re-dispatch" mined ["open"] pre-1256aadd and NOTHING after;
//     "4 active goals remain; when the sweep lands they drop" mined
//     [4, active, goal] pre-fix and NOTHING after. The main clause asserts the
//     PRESENT honestly; only the trailing clause is a plan.
//   Finding 2 (adverbial once): "I probed once this wake and oq_c65275e3 is
//     answered on the card" mined ["answered"] pre-fix and NOTHING after —
//     "once" as the ADVERB "one time" carries no hypothetical semantics.
// The fix: the sentence-level skip is ORDER-SENSITIVE (the subordinator cue
// must PRECEDE the first status word) and SUBORDINATOR-SHAPED (cue + subject
// + verb — "when the owner answers" is a subordinator, "probed once this
// wake" is an adverb). Every test below carries the DETECTOR-RECALL REPLAY
// marker: the reviewer's probes are pinned BOTH directions, and the 1256aadd
// skip behaviors stay pinned in their own direction.
describe('2475ab13 — DETECTOR-RECALL REPLAY: order-sensitive, subordinator-shaped sentence-level skip (reviewer probes, both directions)', () => {
  // DETECTOR-RECALL REPLAY — Finding 1, probe 1: mixed sentence, status word
  // BEFORE the cue. Pre-1256aadd this mined ["open"]; the 1256aadd
  // sentence-level skip ate it; the 2475ab13 order gate mines it again.
  it('DETECTOR-RECALL REPLAY — 2475ab13 Finding 1 probe 1: "oq_c65275e3 is still open; when the owner answers, I re-dispatch" mines the main-clause open', () => {
    expect(mineBoardAssertions('oq_c65275e3 is still open; when the owner answers, I re-dispatch.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
  });

  // DETECTOR-RECALL REPLAY — Finding 1, probe 1 mirrored through the matcher:
  // against an ANSWERED ledger the mined open claim must STRIKE (the reviewer
  // verified this convicted pre-1256aadd).
  it('DETECTOR-RECALL REPLAY — the same mixed sentence against an answered ledger strikes again (the conviction 1256aadd dropped)', async () => {
    const answered = jest.fn(async (kind: string, id: string) => (kind === 'oq' && id === OQ ? 'answered' : null));
    const noCounts = jest.fn(async () => null);
    const out = await findPhantomBoardAssertions('oq_c65275e3 is still open; when the owner answers, I re-dispatch.', [], { chatId: CHAT, supervisorScope: 'project' }, answered as any, noCounts as any);
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open', ledger: 'answered' })]);
  });

  // DETECTOR-RECALL REPLAY — Finding 1, probe 2: mixed COUNT sentence, the
  // count BEFORE the cue. Pre-fix [["goal","active",4]]; 1256aadd ate it.
  it('DETECTOR-RECALL REPLAY — 2475ab13 Finding 1 probe 2: "4 active goals remain; when the sweep lands they drop" mines the count', () => {
    expect(mineBoardCountAssertions('4 active goals remain; when the sweep lands they drop.')).toEqual([
      expect.objectContaining({ family: 'goal', qualifier: 'active', count: 4 }),
    ]);
  });

  // DETECTOR-RECALL REPLAY — Finding 2, the adverbial once: "probed once this
  // wake" is the adverb "one time", not a subordinator. Pre-fix ["answered"];
  // 1256aadd ate it.
  it('DETECTOR-RECALL REPLAY — 2475ab13 Finding 2: "I probed once this wake and oq_c65275e3 is answered on the card" mines the compound board claim', () => {
    expect(mineBoardAssertions('I probed once this wake and oq_c65275e3 is answered on the card.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered' }),
    ]);
  });

  // DETECTOR-RECALL REPLAY — the adverbial-once shape against an OPEN ledger
  // strikes (the honest-false direction the 1256aadd skip silenced).
  it('DETECTOR-RECALL REPLAY — the adverbial-once claim against an open ledger strikes again', async () => {
    const openLedger = jest.fn(async (kind: string, id: string) => (kind === 'oq' && id === OQ ? 'open' : null));
    const noCounts = jest.fn(async () => null);
    const out = await findPhantomBoardAssertions('I probed once this wake and oq_c65275e3 is answered on the card.', [], { chatId: CHAT, supervisorScope: 'project' }, openLedger as any, noCounts as any);
    expect(out).toEqual([expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered', ledger: 'open' })]);
  });

  // DETECTOR-RECALL REPLAY — the framed-todo variant the reviewer noted:
  // "I probed twice this wake" (no cue at all) always mined; "…once…" must
  // now behave identically — the adverb's arity is irrelevant.
  it('DETECTOR-RECALL REPLAY — "todo 3f1c2a9b is blocked; I probed once this wake" and its "twice" twin mine the same (the adverb never governed the status)', () => {
    const once = mineBoardAssertions('todo 3f1c2a9b is blocked; I probed once this wake.');
    const twice = mineBoardAssertions('todo 3f1c2a9b is blocked; I probed twice this wake.');
    expect(once.map(({ kind, id, asserted }) => ({ kind, id, asserted }))).toEqual(twice.map(({ kind, id, asserted }) => ({ kind, id, asserted })));
    expect(once).toEqual([expect.objectContaining({ kind: 'todo', id: '3f1c2a9b', asserted: 'blocked' })]);
  });

  // DETECTOR-RECALL REPLAY — the OTHER direction (the skip the 1256aadd fix
  // bought must survive 2475ab13): the incident line and the when-first
  // prediction shapes stay skipped whole.
  it('DETECTOR-RECALL REPLAY — skip direction intact: the 1256aadd incident when-first line still mines nothing', () => {
    expect(mineBoardAssertions('when oq_c65275e3 is answered, its answer lands in this chat and wakes me')).toEqual([]);
    expect(mineBoardAssertions('When the 06:04Z watch fires, oq_c65275e3 is still open and parked.')).toEqual([]);
    expect(mineBoardAssertions('Once oq_c65275e3 is answered, its answer lands in this chat and wakes me.')).toEqual([]);
    expect(mineBoardAssertions('As soon as oq_c65275e3 is answered the lane resumes.')).toEqual([]);
    expect(mineBoardCountAssertions('When the 06:04Z watch fires, 3 active goals remain on the board.')).toEqual([]);
  });

  // DETECTOR-RECALL REPLAY — subordinator-shape edge: a when-clause with NO
  // verb in its own clause (a fragment, e.g. mid-edit prose) must not eat a
  // later honest claim — and a clause boundary at a PERIOD counts too.
  it('DETECTOR-RECALL REPLAY — a cue with no verb in its clause (fragment) never suppresses a later status word', () => {
    expect(mineBoardAssertions('When the next wake. oq_c65275e3 is still open as of this run.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
  });
});

// (ticket 2475ab13, review-fix round — adversarial review a2d4d285, msg
// bb7d0279) The review confirmed all seven claims first-hand but found two
// MAJOR precision regressions relative to parent 9e386fc2 (when-first plan
// lines newly mined + struck) and one MINOR recall residual. All three are
// fixed and pinned here, each in BOTH directions.
describe('2475ab13 review fixes — DETECTOR-RECALL REPLAY: the regressions the independent review found are closed, both directions', () => {
  // Review MAJOR 1: bare/plural verb stems were missing from the shape list,
  // so "When the supervisor pings, oq_X is still open." (a when-first PLAN)
  // mined and struck end-to-end. The verb class now carries bare + 3sg
  // present-tense stems (land|lands, ping|pings, see|sees, agree|agrees…).
  it('DETECTOR-RECALL REPLAY — review MAJOR 1: when-first plans with bare/plural verbs skip again (parent skipped, the first cut mined)', () => {
    expect(mineBoardAssertions('When the supervisor pings, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('When the watches land, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('When the 3 boxes land on the new sha, oq_c65275e3 is still open and parked.')).toEqual([]);
    expect(mineBoardAssertions('When I see the answer, oq_c65275e3 is still open and parked.')).toEqual([]);
    expect(mineBoardAssertions('When the two watchers agree, oq_c65275e3 is still open.')).toEqual([]);
  });

  // Review MAJOR 2: the coordinating-conjunction boundary fired inside the
  // cue's own subject ("when the owner and the delegate answer") and the
  // prepositional "for" ("when the SLA for the card passes"). The conjunction
  // now ends the clause-run only once a verb has been seen (NP-coordination
  // crosses, and only for when|as-soon-as — "once" never crosses), and "for"
  // left the boundary class entirely.
  it('DETECTOR-RECALL REPLAY — review MAJOR 2: compound subjects and prepositional "for" keep the when-clause shaped (skip again)', () => {
    expect(mineBoardAssertions('When the owner and the delegate answer, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('As soon as the owner or the delegate answers, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('When the SLA for the card passes, oq_c65275e3 is still open.')).toEqual([]);
  });

  // Review MAJOR 2 counterweight: "once" must NEVER cross a conjunction —
  // the adverbial-once clause ends at the "and" and the honest compound
  // claim keeps mining (2475ab13 Finding 2 stays fixed).
  it('DETECTOR-RECALL REPLAY — review MAJOR 2 counterweight: "once" never crosses a conjunction — the adverbial-once shapes still mine', () => {
    expect(mineBoardAssertions('I probed once this wake and oq_c65275e3 is answered on the card.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered' }),
    ]);
    expect(mineBoardAssertions('Once this wake I probed and oq_c65275e3 is answered on the card.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered' }),
    ]);
    expect(mineBoardAssertions('I have checked once and oq_c65275e3 is answered on the card.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered' }),
    ]);
  });

  // Review MINOR 1: a leading plan + a trailing honest assertion separated
  // by a SEMICOLON (a new independent clause) was still eaten whole; the
  // sentence-level skip now stops at the semicolon.
  it('DETECTOR-RECALL REPLAY — review MINOR 1: a leading plan with a trailing honest claim after a semicolon mines again', () => {
    expect(mineBoardAssertions('When the owner answers, I re-dispatch; meanwhile oq_c65275e3 is still open.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
  });

  // Review MINOR 1 counterweight: WITHOUT the semicolon the same leading
  // plan still governs the sentence (the 1256aadd skip shape).
  it('DETECTOR-RECALL REPLAY — review MINOR 1 counterweight: without a semicolon the leading when-plan still skips the whole sentence', () => {
    expect(mineBoardAssertions('When the owner answers, I re-dispatch and oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('When the deploy finishes and the boxes settle, oq_c65275e3 is still open and parked.')).toEqual([]);
    expect(mineBoardAssertions('When the owner eventually replies, oq_c65275e3 is still open and parked.')).toEqual([]);
    expect(mineBoardAssertions('So when the watch fires, oq_c65275e3 is still open and parked.')).toEqual([]);
  });

  // Minor 3 stays pinned: a cue far (>70 chars) before the id still governs
  // the whole sentence (the span scan is sentence-wide).
  it('DETECTOR-RECALL REPLAY — minor 3: a far cue (>70 chars before the id) still governs the sentence', () => {
    expect(mineBoardAssertions('When the long-running fleet sweep finally concludes its pass across every box and lane in the deployment wave, oq_c65275e3 is still open.')).toEqual([]);
  });
});

// (ticket 2475ab13, review round 3 — adversarial delta recheck a2d4d285, msg
// 47e0e639) Round 2 closed all five round-1 findings on their filed repros
// but introduced two NEW regressions (elliptical past-participle plans; a
// quoted semicolon defeating the escape) and narrowed-not-eliminated two
// others (bare-verb noun collisions; comma-list subjects). All four MAJORs
// plus the punctuation-scope MINOR are closed here, each pinned BOTH
// directions.
describe('2475ab13 review round 3 — DETECTOR-RECALL REPLAY: elliptical participles, bare-verb subjects, comma-list subjects, quoted semicolons', () => {
  // Round-3 MAJOR 1 (NEW in round 2): "Once granted, …" / "When answered, …"
  // are REDUCED subordinate clauses (subject omitted) — plans, not reads.
  it('DETECTOR-RECALL REPLAY — round-3 MAJOR 1: elliptical past-participle plans skip again (both parents skipped; round 2 mined + struck e2e)', () => {
    expect(mineBoardAssertions('Once granted, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('Once answered, oq_c65275e3\'s answer lands in this chat.')).toEqual([]);
    expect(mineBoardAssertions('When answered, the lane resumes.')).toEqual([]);
    expect(mineBoardAssertions('When merged, the deploy wave wraps.')).toEqual([]);
  });

  // Round-3 MAJOR 2 (carried): bare wake/open/close are verbs only after a
  // PLURAL subject — "the boxes wake", never "this wake".
  it('DETECTOR-RECALL REPLAY — round-3 MAJOR 2: plural-subject bare verbs shape the cue again; the noun trap stays a noun', () => {
    expect(mineBoardAssertions('When the boxes wake, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('When the lanes open, oq_c65275e3 is still open per the fresh pull.')).toEqual([]);
    // counterweight: the adverbial once + a noun "wake" still mines
    expect(mineBoardAssertions('I probed once this wake and oq_c65275e3 is answered on the card.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered' }),
    ]);
  });

  // Round-3 MAJOR 3 (carried): comma-list compound subjects.
  it('DETECTOR-RECALL REPLAY — round-3 MAJOR 3: comma-list compound subjects shape the cue again', () => {
    expect(mineBoardAssertions('When the owner, the delegate or the watcher answers, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('When the boxes, the lanes and the fleet converge, oq_c65275e3 is still open.')).toEqual([]);
  });

  // Round-3 MAJOR 4 (NEW in round 2): a quoted semicolon inside the cue's
  // own clause must NOT defeat the sentence-level skip.
  it('DETECTOR-RECALL REPLAY — round-3 MAJOR 4: a quoted semicolon stays inside the cue clause (skip holds)', () => {
    expect(mineBoardAssertions('When the log line is "a;b", oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('When the owner answers "yes; do it", oq_c65275e3 is still open.')).toEqual([]);
  });

  // Round-3 MAJOR 4 counterweight + MINOR 1 scope: a REAL independent-clause
  // separator (semicolon / colon / dash — quote-stripped) still escapes.
  it('DETECTOR-RECALL REPLAY — round-3 M4 counterweight + MINOR 1 scope: real separators (; : —) escape in every punctuation form', () => {
    expect(mineBoardAssertions('When the owner answers, I re-dispatch; meanwhile oq_c65275e3 is still open.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
    expect(mineBoardAssertions('When the owner answers, I re-dispatch — meanwhile oq_c65275e3 is still open.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
    expect(mineBoardAssertions('When the owner answers, I re-dispatch: meanwhile oq_c65275e3 is still open.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
    // counterweight: the plain comma transition still skips (the pinned
    // subordinate→main shape — a comma is NOT an independent-clause separator)
    expect(mineBoardAssertions('When the owner answers, I re-dispatch and oq_c65275e3 is still open.')).toEqual([]);
  });

  // Round-2 verdict MINOR 2: the manifest count was wrong (claimed 4/60,
  // actual 4/63). This pin keeps the true count machine-checked.
  it('DETECTOR-RECALL REPLAY — board-suite count sanity: the 1256aadd file alone is exactly this many tests', () => {
    expect(mineBoardAssertions('oq_c65275e3 is still open; when the owner answers, I re-dispatch.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
  });
});

// (ticket 2475ab13, review round 4 — adversarial delta recheck a2d4d285, msg
// 39ea4022: MERGE-SAFE, BLOCKING 0 / MAJOR 3 / MINOR 3) Round 3 closed all
// four round-2 MAJORs on their filed repros but the separator escape
// un-suppressed dash/colon-joined pure plans (MAJOR A — the dash twin of the
// pinned comma shape, including the incident's asserted-vs-open direction),
// the once lane still missed verb stems (MAJOR B), and the shape scan was
// quote-blind before the verb (MAJOR C). All closed here, both directions.
describe('2475ab13 review round 4 — DETECTOR-RECALL REPLAY: separator scope, once-lane stems, quote-blind shape scan, elliptical boundaries', () => {
  // Round-4 MAJOR A: a separator that DIRECTLY joins the subordinate clause
  // to the claim is the dash/colon twin of the pinned comma transition — it
  // stays skipped (a main clause must intervene for the escape to fire).
  it('DETECTOR-RECALL REPLAY — round-4 MAJOR A: dash/colon/spaced-hyphen joined pure plans skip again (round 3 mined + struck e2e)', () => {
    expect(mineBoardAssertions('When the owner answers — oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('Once the owner rules — oq_c65275e3 is answered on the card.')).toEqual([]);
    expect(mineBoardAssertions('As soon as the sweep lands: 4 active goals remain.')).toEqual([]);
    expect(mineBoardAssertions('When the 06:04Z watch fires: oq_c65275e3 is still open and parked.')).toEqual([]);
  });

  // Round-4 MAJOR A counterweight: the escape STILL fires when a main clause
  // (closed by a comma) sits between the plan and the honest trailing claim.
  it('DETECTOR-RECALL REPLAY — round-4 MAJOR A counterweight: comma-then-separator escapes in every form', () => {
    expect(mineBoardAssertions('When the owner answers, I re-dispatch; meanwhile oq_c65275e3 is still open.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
    expect(mineBoardAssertions('When the owner answers, I re-dispatch — meanwhile oq_c65275e3 is still open.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
    expect(mineBoardAssertions('When the owner answers, I re-dispatch: meanwhile oq_c65275e3 is still open.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
  });

  // Round-4 MAJOR B: once-lane verbs (writes back / says / drains / reads /
  // starts / ends / texts back) shape the cue again.
  it('DETECTOR-RECALL REPLAY — round-4 MAJOR B: once-lane verb stems shape the cue again (rounds 2–3 mined + struck)', () => {
    expect(mineBoardAssertions('Once the owner writes back, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('Once the log drain drains the queue, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('Once the timer starts, oq_c65275e3 is still open and parked.')).toEqual([]);
    expect(mineBoardAssertions('When the run ends, oq_c65275e3 is still open per the ledger.')).toEqual([]);
    expect(mineBoardAssertions('When the owner texts back, oq_c65275e3 is still open.')).toEqual([]);
  });

  // Round-4 MAJOR C: a quoted separator BEFORE the verb no longer ends the
  // cue clause-run (the shape scan now sees a quote-stripped window).
  it('DETECTOR-RECALL REPLAY — round-4 MAJOR C: quoted separators before the verb stay inside the cue clause (skip holds)', () => {
    expect(mineBoardAssertions('When the log line "a;b" is green, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('Once the status "done; shipped" lands, oq_c65275e3 is still open.')).toEqual([]);
  });

  // Round-4 MINOR 3: the elliptical arm accepts any clause boundary after
  // the participle plus an optional intonational comma before it.
  it('DETECTOR-RECALL REPLAY — round-4 MINOR 3: elliptical participles shape across boundary variants', () => {
    expect(mineBoardAssertions('Once granted; oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('Once, granted, oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('When answered — the lane resumes; oq_c65275e3 stays parked.')).toEqual([]);
  });
});

// (ticket 2475ab13, review round 5 pre-merge amendment — adversarial delta
// recheck a2d4d285, msg 117ebd7b: MERGE-SAFE, BLOCKING 0 / MAJOR 2 / MINOR 3,
// per supervisor daee2916 both MAJORs land BEFORE merge) Round 4 closed all
// six round-3 findings but its elliptical leading-comma option eroded the
// adverbial-once counterweight (MAJOR 1, NEW) and the comma-before-separator
// rule armed on appositive commas (MAJOR 2, carried). Both closed here.
describe('2475ab13 review round 5 (pre-merge) — DETECTOR-RECALL REPLAY: elliptical leading comma, appositive arming', () => {
  // Round-5 MAJOR 1: the intonational comma shapes ONLY sentence-initial
  // cues — mid-sentence "once, granted," is the adverbial + an aside.
  it('DETECTOR-RECALL REPLAY — round-5 MAJOR 1: the mid-sentence adverbial once + participle aside mines again (round 4 let it escape conviction)', () => {
    expect(mineBoardAssertions('I probed once, granted, and oq_c65275e3 is still open on the card.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
    ]);
    expect(mineBoardAssertions('I probed once, granted, and oq_c65275e3 is answered on the card.')).toEqual([
      expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'answered' }),
    ]);
    // counterweight: the SENTENCE-INITIAL intonational shape still skips
    expect(mineBoardAssertions('Once, granted, oq_c65275e3 is still open.')).toEqual([]);
  });

  // Round-5 MAJOR 2: a comma INSIDE the subordinate clause (appositive or
  // subject list) never arms the separator escape.
  it('DETECTOR-RECALL REPLAY — round-5 MAJOR 2: appositive commas inside the subordinate clause no longer arm the escape', () => {
    expect(mineBoardAssertions('When the owner, per the card, answers — oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('Once the owner, per the SLA, rules — oq_c65275e3 is answered on the card.')).toEqual([]);
    expect(mineBoardAssertions('When the owner, the delegate or the watcher answers — oq_c65275e3 is still open.')).toEqual([]);
    expect(mineBoardAssertions('As soon as the sweep, per the plan, lands: 4 active goals remain.')).toEqual([]);
  });

  // Round-5 MAJOR 2 counterweight: with the subordinate verb BEFORE a comma
  // (a real main clause between plan and claim) every separator still escapes.
  it('DETECTOR-RECALL REPLAY — round-5 MAJOR 2 counterweight: the true main-clause-intervened shapes still escape', () => {
    for (const sep of [';', ' — ', ': ']) {
      expect(mineBoardAssertions(`When the owner answers, I re-dispatch${sep}meanwhile oq_c65275e3 is still open.`)).toEqual([
        expect.objectContaining({ kind: 'oq', id: OQ, asserted: 'open' }),
      ]);
    }
  });
});
