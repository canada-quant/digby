/**
 * REPLAY PIN — ticket a328c93e-bf68-4c39-a835-5838527961f1 (mishap,
 * agent-filed, av-mishap family, dispatched 2026-11-01): "Supervisor phantom
 * claim: narrated action(s) never executed (chat 5c48f492)" — five sightings,
 * one re-open, the recurrence class the detector kept re-filing.
 *
 * THE INCIDENT (sighting 5, the freshest shape — the ticket quotes the note
 * verbatim): a supervisor's machine-wake note reported ANOTHER lane's
 * progress in the simple past — "**It's building — not queued, actually
 * running.** … a build lane picked up the first three within ninety seconds
 * of being created … the lane started its first turn at 19:36Z (run
 * `44374562`) and is three steps into six" — state it had just READ via
 * goal_get (receipt 12c59b7f) and todo_list (receipt 50f03d3e). The LLM
 * extractor labelled the agent-subject past-tense sentence a this-run
 * [dispatch] claim; the tier chain correctly found no dispatch execution
 * (the run only READ state — the dispatch had happened when the GOAL was
 * created, by the supervisor's own prior turn, and the cross-wake tier
 * exonerated exactly one claim — the sibling narration) and the id-less
 * remainder was struck as a phantom on the empty dispatch pool. Sightings 1
 * and 4 are the same shape on the same chat ("[dispatch] (no id); executed
 * consequential actions this run: NONE").
 *
 * THE ROOT CAUSE: the third-party-attribution register (bbd8521e + 2580b092
 * + 385de869) covers six frames — attributive participle, agent-location,
 * status copula, firing-status, progressive lane status, passive machinery
 * dispatch — none of which matches an AGENT NOUN IN SUBJECT POSITION doing a
 * completed PAST-TENSE action: (a) needs the participle BEFORE the noun,
 * (b) needs the verb BEFORE the location phrase, (c) needs a copula verb,
 * (e1) needs a PROGRESSIVE participle ("the lane is building" — two words
 * away from "the lane built"/"the lane started" and uncovered), (f) is
 * PASSIVE (no agent subject). Empirically confirmed pre-fix in this lane:
 * isThirdPartyAttributionDetail returned false on "the lane started its
 * first turn at 19:36Z (run `44374542`)" and on "a build lane picked up the
 * first three within ninety seconds of being created".
 *
 * THE FIX: frame (g) AGENT-SUBJECT PAST-TENSE ACTION — determiner + ≤3
 * modifiers + agent noun + optional relative pronoun + (adverbs) + past-tense
 * completed verb — plus frame (g2), the id-anchored variant ("lane `8abd551a`
 * started its first turn"), and a LAUNDERING GUARD (TP_ELIDED_DISPATCH_ACT_RE)
 * so a verb-first dispatch act in the same breath ("dispatched a worker; the
 * lane started immediately") stays with the tier chain.
 *
 * DETECTOR-RECALL REPLAY obligations of this change (the register's PRIOR
 * true positives, replayed below): the 587e9d64 first-person dispatch, the
 * ee212347 elided-actor dispatch, the e413c084 verb-first dispatch, the
 * bbd8521e "I dispatched lane deadbeef" guard, the d78f477b emphatic
 * "did dispatch", and THIS TICKET's own sighting-3 true positive ("I
 * dispatched it to the spark-cluster supervisor" — the supervisor itself
 * admitted the steer was never sent: "the steer I described in my last
 * message was never actually sent; no tool call went out (the harness
 * flagged that correctly)"). None may stop firing.
 *
 * Mock discipline mirrors action-verifier.385de869.test.ts / 2580b092.test.ts.
 */
const CHAT = '5c48f492-2f71-4f0f-9499-2d3b7bae59dd'; // the struck supervisor chat (ticket's subject)

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));

const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a),
}));

const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import {
  computePhantomClaims, isThirdPartyAttributionDetail, dropThirdPartyAttributionClaims,
  ExtractedClaim,
} from './action-verifier';
import type { ToolReceipt } from '../coding/run-receipts';

const flush = () => new Promise((r) => setImmediate(r));

// The incident run's REAL receipts, verbatim from the ticket's sighting-5
// "Executed consequential actions this run" list: goal_get (12c59b7f) and
// todo_list (50f03d3e) — pure state READS, zero dispatch tools.
const READ_RECEIPTS: ToolReceipt[] = [
  {
    id: '12c59b7f-c441-494a-8ca1-fd00a22b934c', chatId: CHAT, runId: null,
    tool: 'goal_get', ok: true,
    ids: { receiptId: '12c59b7f-c441-494a-8ca1-fd00a22b934c', goalId: '252a1d17' },
    inputHash: null, outputHash: null, createdAt: new Date('2026-10-29T19:30:00.000Z'),
  },
  {
    id: '50f03d3e-df98-4b7d-8945-d21253985f34', chatId: CHAT, runId: null,
    tool: 'todo_list', ok: true,
    ids: { receiptId: '50f03d3e-df98-4b7d-8945-d21253985f34' },
    inputHash: null, outputHash: null, createdAt: new Date('2026-10-29T19:30:05.000Z'),
  },
];

// THE INCIDENT NOTE — the sighting-5 shape, verbatim quote from the ticket:
// an honest read-back of another lane's progress, narrated in the past tense.
// (Only the state-report sentences are reproduced: the original note's
// goal/lane id citations are exercised by the citation lanes in other suites
// and would need mock rows this replay does not own.)
const INCIDENT_NOTE = `**It's building — not queued, actually running.** The deep SEO job now exists as a real work item with six steps attached to it, and a build lane picked up the first three within ninety seconds of being created.

**What is honestly not done yet:** nothing has been written to disk, committed or deployed in this cycle — the lane started its first turn at 19:36Z (run \`44374562\`) and is three steps into six.`;

// The claim the LLM extractor emitted for the struck sentence (the ticket's
// Phantom-claims list names it [dispatch], id-less): the verbatim detail
// quote the tier chain convicted on slot absence.
const EXTRACTOR_DISPATCH_CLAIM: ExtractedClaim = {
  kind: 'dispatch',
  detail: 'the lane started its first turn at 19:36Z (run `44374562`)',
  id: '',
};

const BASE_INPUT = (note: string) => ({
  chatId: CHAT, userId: 'u-1', finalText: note, parts: [] as any[],
  receipts: READ_RECEIPTS, runStartedAt: new Date('2026-10-29T19:37:47.000Z'), machineTriggered: true,
});

describe('ticket a328c93e replay — agent-subject past-tense lane status is not a this-run action claim', () => {
  afterEach(() => { delete process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED; });

  it('THE REGISTER (unit): the adjudicated incident detail matches frame (g)', () => {
    expect(isThirdPartyAttributionDetail(EXTRACTOR_DISPATCH_CLAIM.detail)).toBe(true);
  });

  it('THE REGISTER (unit): the sibling incident sentence and near variants match — every agent noun and past verb', () => {
    // The sighting-5 sibling sentence, verbatim.
    expect(isThirdPartyAttributionDetail('a build lane picked up the first three within ninety seconds of being created')).toBe(true);
    // Determiner + modifier + agent noun + adverb + past verb.
    expect(isThirdPartyAttributionDetail('the build lane picked up the first three')).toBe(true);
    expect(isThirdPartyAttributionDetail('the spawned reviewer ran three steps')).toBe(true);
    expect(isThirdPartyAttributionDetail('the other two threads finished their sweep')).toBe(true);
    expect(isThirdPartyAttributionDetail('that lane started its first turn')).toBe(true);
    expect(isThirdPartyAttributionDetail('their session picked up the last three')).toBe(true);
    // Adverb between noun and verb.
    expect(isThirdPartyAttributionDetail('the lane already started its first turn')).toBe(true);
    expect(isThirdPartyAttributionDetail('the worker immediately replied')).toBe(true);
    // Relative pronoun.
    expect(isThirdPartyAttributionDetail('the lane that started the build is three steps in')).toBe(true);
    // Emphasis glyphs, as supervisors actually write them.
    expect(isThirdPartyAttributionDetail('the **build lane** started its first turn')).toBe(true);
    // Different machinery nouns from TP_AGENT_NOUNS.
    expect(isThirdPartyAttributionDetail('the fleet supervisor answered the question')).toBe(true);
    expect(isThirdPartyAttributionDetail('the subagent verified the diff')).toBe(true);
    // Frame (g2): id-anchored subject, no determiner.
    expect(isThirdPartyAttributionDetail('lane `8abd551a` started its first turn at 19:36Z')).toBe(true);
    expect(isThirdPartyAttributionDetail('worker 41fd09ed ran three steps')).toBe(true);
    expect(isThirdPartyAttributionDetail('session 3f87efe1 replied to the steer')).toBe(true);
  });

  it('DETECTOR-RECALL REPLAY (the register\'s PRIOR true positives): first-person and actor-elided dispatch phantoms stay KEPT for the tier chain', () => {
    // 587e9d64 — first-person active. Guarded by FIRST_PERSON_ACTOR_RE,
    // which runs before every frame.
    expect(isThirdPartyAttributionDetail('I dispatched the nightly audit worker')).toBe(false);
    expect(isThirdPartyAttributionDetail('I dispatched lane deadbeef')).toBe(false); // bbd8521e guard
    // ee212347 case 5 — subject-dropped active with the object AFTER the verb.
    expect(isThirdPartyAttributionDetail('dispatched session 41fd09ed and it is now running on the lane')).toBe(false);
    // e413c084 — verb-first elided actor.
    expect(isThirdPartyAttributionDetail('dispatched a worker for the backlog')).toBe(false);
    // d78f477b — emphatic "did" + BASE form; frame (g) needs the finite
    // PAST form directly after the noun, so "did" cannot bridge it.
    expect(isThirdPartyAttributionDetail("the browser task did dispatch to your Mac's local browser")).toBe(false);
  });

  it('DETECTOR-RECALL REPLAY (ticket a328c93e\'s OWN sighting-3 true positive): "I dispatched it to the spark-cluster supervisor" stays KEPT', () => {
    // The supervisor itself confirmed this one was never executed ("the
    // steer I described in my last message was never actually sent; no tool
    // call went out") — the detector was RIGHT. The register must keep it
    // for the tier chain (first-person actor), and the end-to-end replay
    // below proves it still CONVICTS.
    expect(isThirdPartyAttributionDetail('I dispatched it to the spark-cluster supervisor')).toBe(false);
  });

  it('THE REGISTER (unit, anti-laundering): a verb-first dispatch ACT in the same breath is never dropped', () => {
    // The ee212347 doctrine — a compound detail whose other clause claims
    // the run's own dispatch must stay for the tier chain.
    expect(isThirdPartyAttributionDetail('dispatched a worker; the lane started immediately')).toBe(false);
    expect(isThirdPartyAttributionDetail('spawned two lanes and the lane started')).toBe(false);
    // Embedded first-person actor (2580b092 guard #2) still wins.
    expect(isThirdPartyAttributionDetail('the lane I dispatched started its first turn')).toBe(false);
  });

  it('THE REGISTER (unit, near misses): non-agent subjects and non-past shapes stay KEPT', () => {
    // No agent noun subject — ordinary state prose, not this frame's class.
    expect(isThirdPartyAttributionDetail('the PR is open on GitHub')).toBe(false);
    expect(isThirdPartyAttributionDetail('the goal is active in the crossmodel project')).toBe(false);
    expect(isThirdPartyAttributionDetail('the notes are stored on disk')).toBe(false);
    // Agent noun + progressive is frame (e1)'s class, pinned by 2580b092.
    expect(isThirdPartyAttributionDetail('the lane is building the proposal')).toBe(true);
    // First-person progressive (guard #1) stays kept.
    expect(isThirdPartyAttributionDetail('I am building the batch-decrypt proposal now')).toBe(false);
  });

  it('THE REGISTER (unit): dropThirdPartyAttributionClaims splits kept/dropped exactly', () => {
    const genuine: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'I dispatched a build lane for the SEO job',
      id: '',
    };
    const out = dropThirdPartyAttributionClaims([EXTRACTOR_DISPATCH_CLAIM, genuine]);
    expect(out.dropped).toEqual([EXTRACTOR_DISPATCH_CLAIM]);
    expect(out.kept).toEqual([genuine]);
  });

  it('THE REGISTER (unit): kill switch ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED=1 keeps everything', () => {
    process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED = '1';
    const out = dropThirdPartyAttributionClaims([EXTRACTOR_DISPATCH_CLAIM]);
    expect(out.kept).toEqual([EXTRACTOR_DISPATCH_CLAIM]);
    expect(out.dropped).toEqual([]);
  });

  it('THE MISHAP REPLAY (the sighting-5 note, chat 5c48f492): the extracted [dispatch] claim is DROPPED — phantoms empty', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DISPATCH_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT_NOTE));
    await flush();
    expect(comp.phantoms).toEqual([]); // THE FIX: agent-subject lane status is not a this-run action claim
  });

  it('THE MISHAP REPLAY (end-to-end supervisor lane): nothing files, nothing retracts', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DISPATCH_CLAIM] }) as never);
    await import('./action-verifier').then(({ verifyRunActionClaimsAsync }) =>
      verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [] as any[], receipts: READ_RECEIPTS, machineTriggered: true }));
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('DETECTOR-RECALL REPLAY (end-to-end, ticket a328c93e sighting 3): the first-person dispatch that never ran STILL CONVICTS', async () => {
    // The ticket's own prior true positive — "I dispatched it to the
    // spark-cluster supervisor" over the same read-only receipts must keep
    // striking: first-person narration, zero dispatch tools, no exoneration.
    const phantomNote = INCIDENT_NOTE + '\n\nI dispatched it to the spark-cluster supervisor.';
    const phantom: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'I dispatched it to the spark-cluster supervisor',
      id: '',
    };
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [phantom] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(phantomNote));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(phantom.detail);
  });

  it('DETECTOR-RECALL REPLAY (end-to-end, elided-actor true positive): "dispatched a worker for the backlog" STILL CONVICTS', async () => {
    // e413c084's pinned shape — verb-first, no actor. The anti-laundering
    // guard TP_ELIDED_DISPATCH_ACT_RE plus guard #3 must keep it striking.
    const phantomNote = INCIDENT_NOTE + '\n\nDispatched a worker for the backlog just now.';
    const phantom: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'Dispatched a worker for the backlog just now',
      id: '',
    };
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [phantom] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(phantomNote));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(phantom.detail);
  });

  it('GUARD (no false acquit, first-person fabrication): "I dispatched a build lane" with no execution still convicts', async () => {
    const noteWithPhantom = INCIDENT_NOTE + '\n\nI dispatched a build lane for the SEO job — it is on the keyword map now.';
    const phantom: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'I dispatched a build lane for the SEO job — it is on the keyword map now',
      id: '',
    };
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [phantom] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(noteWithPhantom));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(phantom.detail);
  });

  it('GUARD (kill switch restores the pre-fix strike — the exact regression this ticket pins)', async () => {
    process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED = '1';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DISPATCH_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT_NOTE));
    await flush();
    // Pre-fix behavior restored: the id-less [dispatch] claim convicts on the
    // empty execution pool (step-4 slot accounting).
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(EXTRACTOR_DISPATCH_CLAIM.detail);
  });
});