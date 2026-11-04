/**
 * REPLAY PIN — mishap ticket 080365bf (2026-09-14T18:06:45Z, verifier:
 * action-verifier): "Supervisor fabricated evidence citation: cited id(s) do
 * not exist (chat 9e6e1712)" — ONE ticket, TWO contained sightings.
 *
 * SIGHTING 1 (the filing; chat 9e6e1712-8dc3-4e02-b70c-557bb5b41d2d, wake
 * ~18:05Z): the crossmodel PROJECT supervisor's wake note cited `msg
 * 6de2e40e` as the doc worker's latest message — that id exists in NO
 * crossmodel message row (the run never read it; the id was invented from
 * memory). The deterministic msg-citation lane (mineEvidenceCitations →
 * findPhantomEvidenceCitations → citedMessageRowExists) convicted it
 * PRE-DELIVERY; every conviction was id-bearing and note-locatable with ≤50%
 * of the note gutted, so strip+mark elided exactly the ONE convicted line and
 * delivered the surviving content unmodified (ticket context:
 * deliveredRedacted:true, containedPreDelivery:true). The note's REAL
 * co-citations — `msg fbcaa25e`, scheds b0456337 / 8082b51f / 92c59ba2 /
 * 2d67240e, chats b95e9df6 / 62671567 / 28de72e5 — all exonerated on row
 * existence; the phantom list carried ONLY 6de2e40e (the strike was surgical,
 * not a blanket firing on a citation-heavy note). Executed consequential
 * actions this run: NONE.
 *
 * SIGHTING 2 (the 20:43:30Z recurrence; chat c0e22e36-1c74-4295-8049-9b48335c6c37,
 * the FLEET supervisor's wake): a SINGLE-LINE "WAKE: no-op" note cited `(msg
 * 48d073b5)` — again an id that exists nowhere. Same conviction lane, but
 * strip+mark FAILED CLOSED: eliding the note's only non-empty line leaves
 * zero survivors (tryRedactNoteLines returns null), so the note was REPLACED
 * wholesale with the original blockquoted as audit-only (sighting context:
 * containedPreDelivery:true, NO deliveredRedacted — the 'replaced' delivery
 * shape). The line's REAL co-citation `schedule 8871d918` (a live row, 312
 * firings) exonerated on existence. Executed consequential actions: NONE.
 *
 * ADJUDICATION (2026-09-14 engineering lane b92ef13f, fresh primary-source
 * re-verification against the ticket rows + the guard source): CONTAINED-
 * SIGNAL class — same family as tickets 3892de13 and 16469005. The guard did
 * EXACTLY what it is designed to do on both sightings: the deterministic
 * citation-existence lane (the ticket b216475a enforced class — existence
 * arithmetic, never the LLM coin-flip) convicted the invented ids
 * PRE-DELIVERY, contained them (strip+mark / fail-closed replacement), and
 * auto-filed this telemetry ticket; the phantom lines never reached either
 * thread as fact and NEITHER run executed a consequential action. No false
 * conviction of a real id, no containment escape — NO runtime code change.
 * This file pins the containment so a regression that stops catching (or
 * starts over-catching) either sighting fails CI. The 16469005 pin covers the
 * MIXED action+citation strip+mark on the fleet seat; the shapes pinned HERE
 * are the ones it does not: (a) a citation-ONLY strike on the PROJECT
 * supervisor seat (citationOnly wording + supervisorScope 'project'
 * attribution) with a single elided line, and (b) the fail-closed FULL
 * REPLACEMENT of a citation-only note (zero survivors) on the fleet seat.
 *
 * These tests pin, against the REAL guard (boundary-mocked like the sibling
 * pins action-verifier.16469005.test.ts / action-verifier.b216475a.test.ts):
 *   1. SIGHTING 1 REPLAY: the incident note is STRUCK with exactly the one
 *      phantom (msg 6de2e40e, citation-class), strip+mark elides its line 1:1
 *      (survivors delivered unmodified), and the mishap filing carries the
 *      incident's exact attribution + flags (title chat 9e6e1712, area
 *      project-supervisor, supervisorScope 'project', deliveredRedacted,
 *      containedPreDelivery);
 *   2. SIGHTING 2 REPLAY: the single-line note is STRUCK with exactly msg
 *      48d073b5 and FULL-REPLACED (audit blockquote, no deliveredRedacted),
 *      the real `schedule 8871d918` co-citation convicting nothing;
 *   3. the reject-back pre-pass (deferConsequences) convicts the same id and
 *      names it in rejectBackNotice WITHOUT filing (the seam's
 *      one-bounded-retry contract);
 *   4. CONTROLS (no guard overreach): the SAME notes stay CLEAN when the
 *      cited id exists as a message row (sighting 1), when the cited id is
 *      visible verbatim in this run's tool output (sighting 2's provenance
 *      tier), and when the observation drops the id for the sanctioned
 *      "(id not captured)" honesty shape.
 *
 * The reconstructed notes keep each incident's convicted line(s) verbatim;
 * sighting 1's survivors are trimmed reconstructions (its excerpt was
 * note.slice(0,1500)) with every remaining clock token ≤ the injected `now`
 * or carrying an explicit future label, so the replay isolates the citation
 * lanes from the (a2) future-clock lane.
 */

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) }, // coding_sessions (ticket f1cb73ff lane)
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) }, // the ticket lane's existence + near-miss probes (b216475a)
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

// Supervisor state doc: getSupervisorState (the dispatches ledger — both
// incident runs' ledgers exonerated nothing) + appendVerifierRefutation.
const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

// Cross-wake exoneration: neither incident run had a prior receipt carrying
// the invented id (24h window empty).
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import { guardMachineWakeFinalAnswer, isCitationClassClaim, REDACTED_CLAIM_LINE } from './action-verifier';

/** The incident chats (ticket context sessionId + sightings[0].sessionId). */
const SUP_PROJECT = '9e6e1712-8dc3-4e02-b70c-557bb5b41d2d'; // sighting 1 — project supervisor seat
const SUP_FLEET = 'c0e22e36-1c74-4295-8049-9b48335c6c37'; // sighting 2 — fleet supervisor seat

/** The ticket's fabricated citations (each exists NOWHERE — the phantom cores). */
const PHANTOM_MSG_1 = '6de2e40e';
const PHANTOM_MSG_2 = '48d073b5';

/** The incidents' REAL co-citations (exonerated live — rows exist). */
const REAL_MSG = 'fbcaa25e';
const REAL_SCHED_1 = 'b0456337';
const REAL_SCHED_2 = '8871d918';

/** The incidents' owner (ticket userId). */
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

/* ----- Sighting 1 note (project supervisor, ~18:05Z) ----- */

const S1_HEAD = '**18:05Z wake — kernel-opt finished cleanly, no new action needed; doc worker still running.** **Fresh this run:**';
const S1_SURVIVOR_KERNEL = `- **Kernel-opt** \`chat b95e9df6\` — \`running:false\`, plan 6/6 done, latest \`msg ${REAL_MSG}\` @ 18:05:02Z: self-audit CLOSED, all criteria genuinely hold after fresh re-pulls. No new flag or steer — quiet until its own \`sched ${REAL_SCHED_1}\` cadence (next 20:38Z future)`;
/** The CONVICTED line — verbatim from the ticket's note excerpt. */
const S1_PHANTOM_LINE = `- **Doc worker** \`chat 62671567\` — still \`running:true\`, latest \`msg ${PHANTOM_MSG_1}\` @ 18:02:30Z: mid verify/finalize on steps #5–6 after the 429 continuation; my verified-table steer (receipt 00e8b606) is inside its run`;
const S1_SURVIVOR_R8 = '- **R8** `oq_c282dfe5` — probed fresh via list_owner_questions: still OPEN, triaged until 19:19Z future, owner-only, correctly not answered by me';
const S1_SURVIVOR_SPARK = '- **Spark lane** `chat 28de72e5` — mid monitor firing 30/500, normal; supervisor coverage intact (`sched 8082b51f` next 18:54Z future, `sched 92c59ba2` next 18:34Z future, one-shot `sched 2d67240e` 19:46Z future). SWEEP: no-op — nothing moved in spark-cluster since last sweep';

/**
 * Sighting 1's note: 5 non-empty lines, exactly 1 convicted → strip+mark's
 * >50%-gutted fail-closed guard does NOT trip (1×2 ≤ 5) and 4 survivors
 * remain — the incident's deliveredRedacted shape.
 */
const S1_NOTE = [S1_HEAD, '', S1_SURVIVOR_KERNEL, S1_PHANTOM_LINE, S1_SURVIVOR_R8, S1_SURVIVOR_SPARK].join('\n');

/** Sighting 1's real clock ~40s after the 18:05Z headline (ticket filed 18:06:45Z) — every remaining clock token is past or future-labeled. */
const S1_NOW = new Date('2026-09-14T18:05:40.000Z');

/* ----- Sighting 2 note (fleet supervisor, ~20:43Z) ----- */

/**
 * Sighting 2's note — the ticket's full excerpt: ONE non-empty line carrying
 * the phantom. Eliding it leaves ZERO survivors → tryRedactNoteLines fails
 * closed → the full-replacement delivery shape (no deliveredRedacted flag).
 */
const S2_NOTE = `WAKE: no-op — nothing moved on any project since 1:36 PM PDT; the LiteLLM Gateway health watch completed another clean self-audit firing (msg ${PHANTOM_MSG_2}), its watch schedule ${REAL_SCHED_2} (312 firings) stays enabled, and your one open decision — the R8 drafter ruling (oq_526aa88d, surfacing to your inbox ~2:27 PM PDT future) — is unchanged.`;

/** Sighting 2's real clock (sighting filed 20:43:30Z) — "1:36 PM PDT" is past, "~2:27 PM PDT future" is future-labeled. */
const S2_NOW = new Date('2026-09-14T20:43:00.000Z');

const S1_INPUT = {
  chatId: SUP_PROJECT,
  userId: OWNER,
  parts: [] as any[],
  receipts: [] as any[],
  machineTriggered: true,
  supervisor: true,
  supervisorScope: 'project' as const,
  runStartedAt: new Date('2026-09-14T18:04:30.000Z'),
  now: S1_NOW,
};

const S2_INPUT = {
  chatId: SUP_FLEET,
  userId: OWNER,
  parts: [] as any[],
  receipts: [] as any[],
  machineTriggered: true,
  supervisor: true,
  supervisorScope: 'fleet' as const,
  runStartedAt: new Date('2026-09-14T20:42:00.000Z'),
  now: S2_NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  // The LLM action extractor found NO action claims in either incident (the
  // ticket's own framing: "fabricated EVIDENCE, not an action"; consequential
  // actions NONE) — the convictions arrived via the deterministic citation
  // lane, which the mocks below drive.
  mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);
  // The msg-citation existence probe (citedMessageRowExists): the two phantom
  // ids exist NOWHERE (null); every other probed msg id (the real fbcaa25e)
  // exonerates on its row. The mock splits on the probed id, not a blanket
  // value — exactly like the incident.
  mockPrisma.crossModelMessage.findFirst.mockImplementation(async (args: any) =>
    JSON.stringify(args).includes(PHANTOM_MSG_1) || JSON.stringify(args).includes(PHANTOM_MSG_2)
      ? null
      : { id: `${REAL_MSG}-0c06-44ba-af85-6356c31968ac` });
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]); // no same-prefix near-miss hints
  // The cited chats b95e9df6 / 62671567 / 28de72e5 (and both supervisor
  // chats) are REAL rows — exonerated live on existence.
  mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: '62671567-0000-4000-8000-000000000000' });
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  // The cited schedules b0456337 / 8082b51f / 92c59ba2 / 2d67240e / 8871d918
  // are REAL rows (8871d918: 312 firings) — exonerated live on existence.
  mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: `${REAL_SCHED_2}-0000-4000-8000-000000000000` });
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  mockPrisma.userFeatureRequest.findFirst.mockResolvedValue(null);
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
});

describe('ticket 080365bf replay — fabricated msg evidence citations, two contained sightings', () => {
  it('SIGHTING 1 REPLAY (project supervisor 9e6e1712, ~18:05Z): struck with exactly msg 6de2e40e, strip+mark elides its line 1:1, filing carries deliveredRedacted + containedPreDelivery + project-seat attribution', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...S1_INPUT, finalText: S1_NOTE });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(true);

    // Exactly the ticket's phantom — no more (msg fbcaa25e, the four scheds,
    // the three chats, oq_c282dfe5, receipt 00e8b606 all convict NOTHING),
    // no less. The surgical-strike assertion.
    expect(res.phantoms.map((p) => p.id)).toEqual([PHANTOM_MSG_1]);
    expect(res.phantoms[0].kind).toBe('message');
    expect(isCitationClassClaim(res.phantoms[0])).toBe(true); // the [evidence citation] class

    // Strip+mark (the incident's delivery): the one convicted line elided,
    // the survivors delivered UNMODIFIED — not a wholesale replacement.
    expect(res.finalText.split('\n').filter((l) => l === REDACTED_CLAIM_LINE)).toHaveLength(1);
    expect(res.finalText).toContain(S1_SURVIVOR_KERNEL);
    expect(res.finalText).toContain(S1_SURVIVOR_R8);
    expect(res.finalText).toContain(S1_SURVIVOR_SPARK);
    // The convicted NOTE ROW is gone (newline-anchored so the notice's own
    // struck-claims QUOTE of the same text can't false-trip the assertion).
    expect(res.finalText).not.toContain(`\n${S1_PHANTOM_LINE}`);
    expect(res.finalText).not.toContain('BEGIN STRUCK NOTE'); // redaction lane, not full replacement

    // The citation-only strike names the true failure class (fabricated
    // EVIDENCE ids, not unexecuted actions).
    expect(res.notice).toContain('cited evidence id(s) that DO NOT EXIST');
    expect(res.notice).toContain('REMOVED before delivery');
    expect(res.correction).toContain('DELIVERED with its unproven claim line(s) REMOVED (strip+mark)');

    // The mishap filing carries the incident ticket's exact attribution +
    // context flags (its title IS the live ticket's title).
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const filing = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(filing.type).toBe('mishap');
    expect(filing.title).toBe('Supervisor fabricated evidence citation: cited id(s) do not exist (chat 9e6e1712)');
    expect(filing.area).toBe('project-supervisor');
    expect(filing.context).toMatchObject({
      sessionId: SUP_PROJECT,
      verifier: 'action-verifier',
      supervisorScope: 'project',
      deliveredRedacted: true,
      containedPreDelivery: true,
    });
    expect(filing.description).toContain("A project supervisor's machine-wake note cited evidence id(s) that DO NOT EXIST");
    expect(filing.description).toContain('Fabricated citation(s)');
    expect(filing.description).toContain(PHANTOM_MSG_1);
    expect(filing.description).toContain('Executed consequential actions this run: NONE');
    expect(filing.description).toContain('DELIVERED with the phantom-claim line(s) removed and marked');

    // The durable state-doc refutation fires for the supervisor.
    expect(mockAppendVerifierRefutation).toHaveBeenCalled();
  });

  it('SIGHTING 2 REPLAY (fleet supervisor c0e22e36, ~20:43Z): single-line note struck with exactly msg 48d073b5 and FULL-REPLACED (zero survivors — no deliveredRedacted), the real schedule 8871d918 co-citation convicting nothing', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...S2_INPUT, finalText: S2_NOTE });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(true);

    // Exactly the sighting's phantom — the REAL `schedule 8871d918` row
    // exonerates on existence; oq_526aa88d rides no citation lane.
    expect(res.phantoms.map((p) => p.id)).toEqual([PHANTOM_MSG_2]);
    expect(res.phantoms[0].kind).toBe('message');
    expect(isCitationClassClaim(res.phantoms[0])).toBe(true);

    // FAIL-CLOSED full replacement (the incident's delivery): eliding the
    // note's ONLY non-empty line leaves zero survivors, so strip+mark is
    // refused and the original rides blockquoted as audit-only.
    expect(res.finalText).not.toContain(REDACTED_CLAIM_LINE);
    expect(res.finalText).toContain('BEGIN STRUCK NOTE');
    expect(res.finalText).toContain(`> ${S2_NOTE}`); // the original survives as the quoted audit block
    expect(res.notice).toContain('cited evidence id(s) that DO NOT EXIST');
    expect(res.notice).not.toContain('REMOVED before delivery'); // replacement wording, not strip+mark
    expect(res.correction).toContain('WITHHELD before delivery');

    // The filing: fleet-seat attribution, containedPreDelivery, and NO
    // deliveredRedacted (the 'replaced' delivery shape — the live sighting's
    // exact context).
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const filing = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(filing.type).toBe('mishap');
    expect(filing.title).toBe('Supervisor fabricated evidence citation: cited id(s) do not exist (chat c0e22e36)');
    expect(filing.area).toBe('fleet-supervisor');
    expect(filing.context).toMatchObject({
      sessionId: SUP_FLEET,
      verifier: 'action-verifier',
      supervisorScope: 'fleet',
      containedPreDelivery: true,
    });
    expect(filing.context.deliveredRedacted).toBeUndefined();
    expect(filing.description).toContain("The fleet supervisor's machine-wake note cited evidence id(s) that DO NOT EXIST");
    expect(filing.description).toContain(PHANTOM_MSG_2);
    expect(filing.description).toContain('Executed consequential actions this run: NONE');
    expect(filing.description).toContain('REPLACED before it reached the thread');

    expect(mockAppendVerifierRefutation).toHaveBeenCalled();
  });

  it('REJECT-BACK pre-pass (deferConsequences): the same conviction, named in rejectBackNotice, with NO filing — the seam\'s one-bounded-retry contract', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...S1_INPUT, finalText: S1_NOTE, deferConsequences: true });

    expect(res.struck).toBe(true);
    expect(res.phantoms.map((p) => p.id)).toEqual([PHANTOM_MSG_1]);
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).toContain(PHANTOM_MSG_1);
    expect(res.rejectBackNotice).toContain('(id not captured)'); // the F1 escape hatch, taught at the moment of failure
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled(); // deferred — fires on a still-convicted retry
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('CONTROL (no overreach — EXISTING id): the SAME sighting-1 note is CLEAN when the cited msg id exists as a message row (an existing row exonerates)', async () => {
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: `${PHANTOM_MSG_1}-16cc-47a9-8ce4-993abc65b38d` });

    const res = await guardMachineWakeFinalAnswer({ ...S1_INPUT, finalText: S1_NOTE });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toEqual([]);
    expect(res.finalText).toBe(S1_NOTE); // delivered untouched
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('CONTROL (no overreach — this-run provenance): the SAME sighting-2 note is CLEAN when the cited msg id is visible verbatim in this run\'s get_chat_messages tool output', async () => {
    const res = await guardMachineWakeFinalAnswer({
      ...S2_INPUT,
      finalText: S2_NOTE,
      parts: [{
        type: 'tool_result',
        name: 'get_chat_messages',
        result: `{"messages":[{"id":"${PHANTOM_MSG_2}-0c06-44ba-af85-6356c31968ac","role":"assistant"}]}`,
      } as any],
    });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toEqual([]);
    expect(res.finalText).toBe(S2_NOTE);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('CONTROL (the sanctioned honest shape): the sighting-2 observation with the id dropped for "(msg id not captured)" convicts NOTHING', async () => {
    const honest = 'WAKE: no-op — nothing moved on any project since 1:36 PM PDT; the LiteLLM Gateway health watch completed another clean self-audit firing (msg id not captured), its watch schedule 8871d918 (312 firings) stays enabled, and your one open decision — the R8 drafter ruling (oq_526aa88d, surfacing to your inbox ~2:27 PM PDT future) — is unchanged.';

    const res = await guardMachineWakeFinalAnswer({ ...S2_INPUT, finalText: honest });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toEqual([]);
    expect(res.finalText).toBe(honest);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });
});


// audit 2026-10-08 W1-4: this suite pins the strip+mark / full-replacement delivery — now the
// OWNER_NOTE_NO_EDIT_DISABLED=1 kill-switch path (the default delivers the note as written + an
// observe-only annotation; action-verifier.owner-note-no-edit.test.ts pins that).
beforeAll(() => { process.env.OWNER_NOTE_NO_EDIT_DISABLED = '1'; });
afterAll(() => { delete process.env.OWNER_NOTE_NO_EDIT_DISABLED; });
