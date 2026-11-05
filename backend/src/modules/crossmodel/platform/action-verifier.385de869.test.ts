/**
 * REPLAY PIN — ticket 385de869-e5ad-4ecb-95d9-8bde30266174 (mishap,
 * agent-filed 2026-10-21T16:54:04Z by the action-verifier): "Phantom action
 * claim: chat asserted action(s) never executed (chat b3dede3e)".
 *
 * THE INCIDENT (all evidence first-hand in this lane's investigation):
 * the user-facing chat b3dede3e (a Workspace-project chat helping the owner
 * with his freshly paired Windows box) had, one turn earlier, FILED ticket
 * 4424ebd6 itself (file_feedback receipt 149034f1, 16:52:08.082Z — "Windows
 * agent v0.9.0 … digby-win-helper.exe missing"). The ticket machinery
 * auto-dispatched that ticket to a fix lane (dispatchedTo 5a73dd5c…,
 * dispatchedAt 2026-10-21T16:52:08.100Z — eighteen milliseconds after
 * filing). The chat's NEXT turn (16:52:49Z user message, assistant note
 * 60d56315 at 16:54:03Z) read the ticket row back via get_feedback (receipt
 * 0131203c, 16:53:42Z) and updated it with the fresh-install reproduction
 * (update_feedback receipt 448ffa51, 16:53:53Z), then told the user the
 * truth:
 *
 *   "Ticket `4424ebd6` updated with the fresh-install reproduction — it's
 *    already dispatched to a fix lane (started 16:52 UTC), so a platform
 *    fix is in motion, not just a report sitting in a queue."
 *
 * The verifier's LLM extractor labeled the second half a this-run [dispatch]
 * claim; the tier chain found no dispatch execution (the run's receipts are
 * get_feedback + update_feedback only — correct, the DISPATCH was the ticket
 * machinery's action, not the chat's) and convicted the id-less claim on the
 * empty dispatch pool. The post-delivery lane filed THIS mishap ticket.
 *
 * THE ROOT CAUSE: the bbd8521e third-party-attribution register covers five
 * frames — attributive participle, agent-location (past verbs), status
 * copula (id-anchored), firing-status, progressive lane status — none of
 * which matches the PASSIVE VOICE. Frame (a) needs the participle directly
 * before the agent noun ("the dispatched lane X"), here it is "dispatched
 * TO a fix lane"; "dispatched" is absent from frame (b)'s verb list and
 * "to" from its prepositions; no id for (c); no progressive for (e). The
 * gap is empirically confirmed pre-fix: isThirdPartyAttributionDetail
 * returned false on the incident detail. A passive construction has NO
 * agent — the subject is the PATIENT ("it") — so a passive machinery
 * participle + routing preposition + agent noun is state narration of
 * machinery work, the same doctrine as (a)–(d).
 *
 * THE FIX: frame (f) PASSIVE MACHINERY DISPATCH — passive auxiliary
 * ('s/is/are/was/were/get(s)/got/has|have|had been) + (adverbs) +
 * machinery participle (dispatched/queued/routed/escalated/assigned/
 * relayed) + to/onto/into + determiner + ≤3 modifiers + agent noun. It
 * runs with the EARLY frames, BEFORE the (e) actor guards: the incident
 * detail ends "(started 16:52 UTC)" and ELIDED_ACTOR_COMPLETED_ACTION_RE
 * matches "started" in ANY voice, so a post-guard placement would veto the
 * drop. The passive auxiliary is the voice discriminator — every pinned
 * true-positive dispatch phantom is ACTIVE-voice and cannot match.
 *
 * Mock discipline mirrors action-verifier.bbd8521e.test.ts / 2580b092.test.ts.
 */
const CHAT = 'b3dede3e-20fb-4949-9ff2-21f9c6c90e73'; // the struck user-facing chat
const TICKET = '4424ebd6-9d37-4f0a-a1c5-f9049f954ea2'; // the ticket the chat itself filed

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

// The incident run's REAL receipts, verbatim from the mishap ticket's own
// "Executed consequential actions this run" list: get_feedback (0131203c)
// and update_feedback (448ffa51) — read + ticket-update, ZERO dispatch tools.
const READ_RECEIPTS: ToolReceipt[] = [
  {
    id: '0131203c-4311-4d7f-abc9-e6a7a75008d4', chatId: CHAT, runId: null,
    tool: 'get_feedback', ok: true,
    ids: { receiptId: '0131203c-4311-4d7f-abc9-e6a7a75008d4', ticketId: TICKET },
    inputHash: null, outputHash: null, createdAt: new Date('2026-10-21T16:53:42.157Z'),
  },
  {
    id: '448ffa51-0753-4739-873a-84a77fed0c9c', chatId: CHAT, runId: null,
    tool: 'update_feedback', ok: true,
    ids: { receiptId: '448ffa51-0753-4739-873a-84a77fed0c9c', ticketId: TICKET },
    inputHash: null, outputHash: null, createdAt: new Date('2026-10-21T16:53:53.270Z'),
  },
];

// THE INCIDENT NOTE — msg 60d56315's verbatim text (the 16:54:03Z note the
// verifier struck). The "Status" bullet narrates the ticket machinery's real
// dispatch in the passive voice; every other line is diagnosis + user advice.
const INCIDENT_NOTE = `Fresh install reproduces the exact same failure — so it's confirmed: the v0.9.0 Windows bundle ships without (or can't find) \`digby-win-helper.exe\`. Nothing you did wrong.

**Status:**

- Ticket \`4424ebd6\` updated with the fresh-install reproduction — it's already dispatched to a fix lane (started 16:52 UTC), so a platform fix is in motion, not just a report sitting in a queue.
- Once a fixed Windows build ships and you reinstall it, capture + input should work.

**If you want it working today:** on the MSI, check whether \`digby-win-helper.exe\` exists anywhere in the Digby install folder (likely under \`%LOCALAPPDATA%\\Programs\\Digby\` or \`C:\\Program Files\\Digby\`). If the file is there, set a \`DIGBY_WIN_HELPER\` environment variable pointing to its full path and restart the Digby agent — that overrides the broken lookup. If it's genuinely absent, the bundle is incomplete and only the fixed installer will solve it.

I'll re-run the Notepad smoke test the moment you've either set that variable or installed the patched build — just say "test again".`;

// The claim the LLM extractor emitted for the struck "Status" bullet (the
// ticket's Phantom-claims list names it [dispatch], id-less): the verbatim
// detail quote the tier chain convicted on slot absence.
const EXTRACTOR_DISPATCH_CLAIM: ExtractedClaim = {
  kind: 'dispatch',
  detail: "it's already dispatched to a fix lane (started 16:52 UTC)",
  id: '',
};

const BASE_INPUT = (note: string) => ({
  chatId: CHAT, userId: 'u-1', finalText: note, parts: [] as any[],
  receipts: READ_RECEIPTS, runStartedAt: new Date('2026-10-21T16:54:03.391Z'), machineTriggered: false,
});

// Production truth: the cited ticket row is REAL, fresh and SELF-FILED — the
// chat itself filed 4424ebd6 two minutes before the note (file_feedback
// receipt 149034f1, 16:52:08Z) and updated it THIS run (update_feedback
// receipt 448ffa51, 16:53:53Z, row updatedAt 11s before the audit). Served so
// every citation probe (citedArtifactExists' ≤1h recency gate,
// defaultTicketRowLookup's filer stamp) exonerates the note's truthful
// "Ticket `4424ebd6` updated" citation — exactly the incident environment,
// and exactly why the mishap ticket's Phantom-claims list names ONLY the
// [dispatch] claim. Any OTHER id (the guard tests' invented deadbeef etc.)
// keeps the null row and stays convicted.
mockPrisma.userFeatureRequest.findFirst.mockImplementation(async (args: any) => {
  const s = JSON.stringify(args);
  if (s.includes('4424ebd6')) {
    return { id: TICKET, updatedAt: new Date(), context: { filedBy: CHAT, filedAt: '2026-10-21T16:52:08.072Z', dispatchedTo: '5a73dd5c-6b9b-4c96-b426-168ac36e2920' } };
  }
  return null;
});

describe('ticket 385de869 replay — passive machinery dispatch is not a this-run action claim', () => {
  afterEach(() => { delete process.env.ACTION_VERIFIER_THIRD_PARTY_GATE_DISABLED; });

  it('THE REGISTER (unit): the adjudicated incident detail matches frame (f)', () => {
    expect(isThirdPartyAttributionDetail(EXTRACTOR_DISPATCH_CLAIM.detail)).toBe(true);
  });

  it('THE REGISTER (unit): near passive variants match — every machinery participle and routing preposition', () => {
    expect(isThirdPartyAttributionDetail('the ticket is queued to a worker lane')).toBe(true);
    expect(isThirdPartyAttributionDetail('the report was routed to a dedicated session')).toBe(true);
    expect(isThirdPartyAttributionDetail('the mishap got escalated to the fleet supervisor')).toBe(true);
    expect(isThirdPartyAttributionDetail('the follow-up has been assigned to a reviewer')).toBe(true);
    expect(isThirdPartyAttributionDetail('the signal was relayed to the gateway lane')).toBe(true);
    // (review F2) Adverbs between has/have/had and "been", and the widened
    // adverb set between the auxiliary and the participle — without these the
    // ticket's own phrasing recurs on the most natural perfect passive.
    expect(isThirdPartyAttributionDetail('the ticket has now been dispatched to a fix lane')).toBe(true);
    expect(isThirdPartyAttributionDetail('the ticket has already been dispatched to a fix lane')).toBe(true);
    expect(isThirdPartyAttributionDetail('the report was just routed to a dedicated session')).toBe(true);
    expect(isThirdPartyAttributionDetail('the ticket was then escalated to the fleet supervisor')).toBe(true);
    expect(isThirdPartyAttributionDetail('the report was subsequently dispatched to a worker lane')).toBe(true);
    // Modifier words between the determiner and the agent noun (≤3, like (e1)).
    expect(isThirdPartyAttributionDetail("it's already dispatched to a fresh fix lane")).toBe(true);
    expect(isThirdPartyAttributionDetail('the ticket is queued to the dedicated platform session')).toBe(true);
    // Adverb between the auxiliary and the participle.
    expect(isThirdPartyAttributionDetail('the ticket is already queued to a worker lane')).toBe(true);
    // 's contraction form, as in the incident.
    expect(isThirdPartyAttributionDetail('it\'s routed to the decrypt lane')).toBe(true);
    // (review F5) FIRST-PERSON PASSIVE subjects — the machinery's action ON
    // the run, never the run's own action; tense-symmetric ('m/'re admitted).
    expect(isThirdPartyAttributionDetail('I was dispatched to a fix lane as the worker')).toBe(true);
    expect(isThirdPartyAttributionDetail('we were assigned to the reviewer lane')).toBe(true);
    expect(isThirdPartyAttributionDetail('I got routed to a dedicated session')).toBe(true);
    expect(isThirdPartyAttributionDetail("I'm assigned to the reviewer lane now")).toBe(true);
  });

  it('THE REGISTER (unit, review F1 guard order): (e) guards #1/#2 still run BEFORE frame (f) — an embedded first-person actor keeps the claim for the tier chain', () => {
    // Guard #2 (embedded first-person actor) anchors the narration to the
    // run's own completed action in any voice — it must keep winning over the
    // passive frame (the 2580b092 shapes stay kept).
    expect(isThirdPartyAttributionDetail('the wiring I just deployed is assigned to the app lane')).toBe(false);
    // Guard #1 (first-person progressive) likewise.
    expect(isThirdPartyAttributionDetail('I am building the decrypt lane and the report has been assigned to a reviewer')).toBe(false);
  });

  it('THE REGISTER (unit, review F3 word boundary): the "is" inside a noun is never a passive auxiliary — active voice stays kept', () => {
    expect(isThirdPartyAttributionDetail('the analysis routed to a dedicated session')).toBe(false);
    expect(isThirdPartyAttributionDetail('the report about this routed to a dedicated session')).toBe(false);
    expect(isThirdPartyAttributionDetail('the axis queued to a dedicated session')).toBe(false);
  });

  it('THE REGISTER (unit): active-voice action claims NEVER match frame (f) — the tier chain keeps them', () => {
    // First-person active (587e9d64 shape) — FIRST_PERSON_ACTOR_RE guard.
    expect(isThirdPartyAttributionDetail('I dispatched the nightly audit worker')).toBe(false);
    expect(isThirdPartyAttributionDetail('I queued the signal to the gateway lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('the browser task did dispatch to your Mac\'s local browser')).toBe(false); // d78f477b: emphatic did + BASE form
    // Elided-actor active (ee212347 case 5 / e413c084 shapes) — no auxiliary.
    expect(isThirdPartyAttributionDetail('dispatched session c3d4e5f6-a7b8-4901-abcd-f01234567890 and it is now running on the lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('dispatched a worker for the backlog and it is running now')).toBe(false);
    // Subject-dropped perfect-active — has/have/had are admitted ONLY in the
    // "has been <participle>" chain; "has dispatched" stays for the tier chain.
    expect(isThirdPartyAttributionDetail('has dispatched a worker to the backlog lane')).toBe(false);
    expect(isThirdPartyAttributionDetail('I have queued the steer to the gateway lane')).toBe(false);
    // No agent noun after the routing preposition.
    expect(isThirdPartyAttributionDetail('the fix is dispatched to main by CI')).toBe(false);
    expect(isThirdPartyAttributionDetail("it's already dispatched to the owner for review")).toBe(false);
    // Not a machinery participle.
    expect(isThirdPartyAttributionDetail('the note is sent to a lane by the harness')).toBe(false);
  });

  it('THE REGISTER (unit): dropThirdPartyAttributionClaims splits kept/dropped exactly', () => {
    const genuine: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'I dispatched a fix lane for the Windows bundle bug',
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

  it('THE MISHAP REPLAY (the 16:54:03Z note, chat b3dede3e): the extracted [dispatch] claim is DROPPED — phantoms empty', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DISPATCH_CLAIM] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(INCIDENT_NOTE));
    await flush();
    expect(comp.phantoms).toEqual([]); // THE FIX: passive machinery narration is not a this-run action claim
  });

  it('THE MISHAP REPLAY (end-to-end user-facing lane): nothing files, nothing retracts', async () => {
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DISPATCH_CLAIM] }) as never);
    await import('./action-verifier').then(({ verifyRunActionClaimsAsync }) =>
      verifyRunActionClaimsAsync({ chatId: CHAT, userId: 'u-1', finalText: INCIDENT_NOTE, parts: [] as any[], receipts: READ_RECEIPTS, machineTriggered: false }));
    await flush(); await flush(); await flush();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('GUARD (no false acquit, active voice): "I dispatched a fix lane for it" with an invented id still convicts', async () => {
    const noteWithPhantom = INCIDENT_NOTE + '\n\nI dispatched a fix lane for the Windows bundle bug — session deadbeef is on it.';
    const phantom: ExtractedClaim = {
      kind: 'dispatch',
      detail: 'I dispatched a fix lane for the Windows bundle bug — session deadbeef is on it',
      id: 'deadbeef',
    };
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [phantom] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(noteWithPhantom));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('deadbeef');
  });

  it("GUARD (no false acquit, passive fabrication): 'already dispatched' over a FABRICATED dispatch with no observation receipt — documents the doctrine residual", async () => {
    // The passive frame drops the CLAIM from the third-party register, but a
    // chat that fabricates a machinery dispatch it never observed has no
    // observation receipts either — this guard pins the honest path: the
    // incident chat DID hold a read receipt (get_feedback 0131203c) for the
    // dispatched ticket row. Here the receipts are stripped to reads of an
    // UNRELATED ticket; the note still narrates 4424ebd6's dispatch. This
    // documents the deliberate residual: frame (f) is a NOTE-SHAPE gate, not
    // an observation-provenance gate — the register's doctrine (fail toward
    // miss) accepts that a fabricated passive narration is dropped, exactly
    // as (a)–(e) accept their own fabrication residuals.
    const unrelatedRead: ToolReceipt[] = [{
      id: 'aaaa0000-0000-4000-8000-000000000000', chatId: CHAT, runId: null,
      tool: 'get_feedback', ok: true,
      ids: { receiptId: 'aaaa0000-0000-4000-8000-000000000000', ticketId: 'ffffffff-0000-4000-8000-000000000000' },
      inputHash: null, outputHash: null, createdAt: new Date('2026-10-21T16:53:42.157Z'),
    }];
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [EXTRACTOR_DISPATCH_CLAIM] }) as never);
    const comp = await computePhantomClaims({ ...BASE_INPUT(INCIDENT_NOTE), receipts: unrelatedRead });
    await flush();
    // Dropped by frame (f) — the residual the doctrine accepts.
    expect(comp.phantoms).toEqual([]);
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

  it('WIRING (args surface): a passive third-party claim mined from tool-call ARGS is dropped too', async () => {
    const parts: any[] = [
      { type: 'tool_call', name: 'send_chat_message', args: { chatId: '5a73dd5c-6b9b-4c96-b426-168ac36e2920', content: 'status: the ticket is queued to a worker lane already — report the measured fix sha when it lands' } },
      { type: 'tool_result', result: '{"ok":true,"receiptId":"bbbb1111-1111-4222-8222-222233334444"}' },
    ];
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ claims: [] }) as never)                                                                                        // note surface: no claims
      .mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail: 'the ticket is queued to a worker lane already — report the measured fix sha when it lands', id: '' }] }) as never); // args surface: the passive claim
    const comp = await computePhantomClaims({ ...BASE_INPUT(INCIDENT_NOTE), parts });
    await flush();
    expect(comp.phantoms).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR-RECALL REPLAY (ticket 385de869 detector change): frame (f) widens
// the third-party-attribution register, so this file replays the detector's
// PRIOR TRUE POSITIVES — the genuine-phantom dispatch convictions that
// adjudicated tickets 587e9d64, ee212347 (case 5), e413c084, bbd8521e
// (false-acquit guard) and d78f477b pinned, ALL of them active-voice shapes
// frame (f) could plausibly have swallowed (each carries "dispatched") — and
// asserts they STILL convict end-to-end through computePhantomClaims.
// ─────────────────────────────────────────────────────────────────────────────
describe('DETECTOR-RECALL REPLAY — prior true positives still fire (385de869 detector change)', () => {
  it('587e9d64 conviction: "I dispatched the nightly audit worker … — it is running now" (id-bearing, no row) still convicts', async () => {
    const note = 'Run closed. I dispatched the nightly audit worker (session deadbeef-1234-5678-9abc-def012345678) — it is running now.';
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({
      claims: [{ kind: 'dispatch', detail: 'dispatched the nightly audit worker', id: 'deadbeef-1234-5678-9abc-def012345678' }],
    }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('deadbeef-1234-5678-9abc-def012345678');
  });

  it('ee212347 case-5 conviction, hardened with a LOCATION phrase: "dispatched session <id> and it is now running on the lane" still convicts', async () => {
    const id = 'c3d4e5f6-a7b8-4901-abcd-f01234567890';
    const detail = `dispatched session ${id} and it is now running on the lane`;
    const note = `Status: ${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail, id }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe(id);
  });

  it('e413c084 id-less conviction: "dispatched a worker for the backlog and it is running now" (elided actor) still convicts', async () => {
    const detail = 'dispatched a worker for the backlog and it is running now';
    const note = `Board sweep closed. Status: ${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(detail);
  });

  it('bbd8521e false-acquit guard: "I dispatched lane deadbeef … and it is running now" still convicts', async () => {
    const detail = 'I dispatched lane deadbeef to own the follow-up and it is running now';
    const note = `**crossmodel 09:08Z — duplicate resolved.**\n\n${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail, id: 'deadbeef' }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(String(comp.phantoms[0].id)).toBe('deadbeef');
  });

  it('d78f477b conviction: "the browser task did dispatch to your Mac\'s local browser" (emphatic did, BASE form) still convicts', async () => {
    const detail = "the browser task did dispatch to your Mac's local browser with instructions to go to optcgsim.com, find the newest macOS build, and download it";
    const note = `**What I actually did:**\n\n- ${detail}.`;
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ claims: [{ kind: 'dispatch', detail }] }) as never);
    const comp = await computePhantomClaims(BASE_INPUT(note));
    await flush();
    expect(comp.phantoms).toHaveLength(1);
    expect(comp.phantoms[0].detail).toBe(detail);
  });
});
