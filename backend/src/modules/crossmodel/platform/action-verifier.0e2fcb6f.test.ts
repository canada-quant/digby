/**
 * REPLAY PIN — mishap ticket 0e2fcb6f (2026-09-15T20:47:55Z + 20:54:17Z,
 * verifier: action-verifier): "Supervisor fabricated evidence citation: cited
 * id(s) do not exist (chat daee2916)". occurrences:2 — TWO project-supervisor
 * wakes, two different seats, same failure family deduped onto one ticket.
 *
 * SIGHTING 1 (crossmodel PROJECT supervisor chat daee2916-fa75-4159-94a1-3d767abfd192,
 * sweep wake 2026-09-15T20:47Z, filed 20:47:55.890Z): the "DELTAS vs 20:38Z"
 * block reported "**b92ef13f: RUNNING again** (list_chats: running:true, msg
 * 76a0349a, updated 20:47:15Z) — its 20:49Z DMG-watch firing started early".
 * `msg 76a0349a` names NO row anywhere — ground-truthed 2026-09-15T21:2xZ on
 * box A (SSM cmd 1ec543a7-93e9-4460-871d-737c976d38bf, the app's own Prisma
 * client running the lane's exact startsWith query): `PROBE 76a0349a message
 * => null` / `schedule => null` / `chat => null`. The message the note MEANT
 * is chat b92ef13f's real lastMessage at the wake minute,
 * d0d7a89c-c784-4a9e-a9a7-b61b0a7d0d8c (assistant, created 20:35:09.854Z —
 * `PROBE d0d7a89c => <row>`; the chat's updatedAt had advanced to 20:47:15Z
 * on the run-row touch, the lastMessage id had not). The SAME DELTAS block
 * carried a SECOND msg citation that is REAL — `msg b07e8280`
 * (b07e8280-cb58-4078-ab58-8d677b0ec989, chat 0b69e9b1, created 20:36:41.887Z;
 * SSM cmd f6ca78e4-5f2f-4a71-b012-d2db16cb9e04) — and the guard exonerated it:
 * exactly ONE id was struck. That per-id discrimination inside one bullet
 * block is the shape pinned HERE (the 6fac1460 pin covers a lone phantom in a
 * long prose paragraph; 080365bf the bullet-list shape on a lone phantom).
 *
 * SIGHTING 2 (CanLaw PROJECT supervisor chat f5c2c1f4-898f-467f-8aee-0ddd22f723d8,
 * wake 2026-09-15T20:53:31Z on coordinator e083ff2e run_completed, filed
 * 20:54:17.525Z): the note absorbed the coordinator's tick close "(msg
 * 021383a1, its harness clock 20:53:03.517Z)" and re-cited the SAME invented
 * id in the ACTIONS TAKEN ledger line ("coordinator tick absorbed via msg
 * 021383a1"). `021383a1` exists NOWHERE — same SSM cmd: `PROBE 021383a1
 * message => null` / `schedule => null` / `chat => null`. One ticket entry was
 * filed (dedupe by id); both carried lines are pinned below.
 *
 * GROUND TRUTH (all fresh this engineering run, read-only):
 *   phantoms null ×3 stores each; every OTHER id the notes cited resolves:
 *   b07e8280 (msg), 0b69e9b1/b92ef13f/e083ff2e/daee2916/f5c2c1f4 (chats),
 *   be217b59/c5228a3d/065caccb (tickets, in_progress), 733e1f5e (todo,
 *   in_progress — cited BARE, no `todo <id>` idiom, convicts nothing).
 *
 * ADJUDICATION (2026-09-15 engineering lane b92ef13f): CONTAINED-SIGNAL true
 * positive ×2 — the ticket b216475a enforced citation class (existence
 * arithmetic) caught REAL fabrications pre-delivery on two seats, strip+mark
 * elided exactly the phantom line(s), and the filings carried
 * deliveredRedacted:true / containedPreDelivery:true. No false conviction of
 * the co-cited REAL id b07e8280, no containment escape — NO runtime code
 * change. This file pins the containment so a regression that stops catching
 * (or starts over-catching — e.g. convicting the real co-citation or the
 * ACTIONS-ledger re-citation semantics changing silently) fails CI.
 *
 * Reconstructions keep the convicted lines verbatim from the ticket's note
 * excerpts; survivors are faithful reconstructions with every clock token ≤
 * the injected `now` or explicitly future-labeled, so the replay isolates the
 * citation lanes from the (a2) future-clock lane.
 */

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) }, // coding_sessions (ticket f1cb73ff lane)
  codingSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) }, // the ticket lane's existence + near-miss probes (b216475a)
  projectGoal: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
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

// Supervisor state doc: getSupervisorState (the dispatches ledger — neither
// incident run's ledger exonerated the invented ids) + appendVerifierRefutation.
const mockAppendVerifierRefutation = jest.fn(async () => {});
const mockGetSupervisorState = jest.fn(async (): Promise<any> => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] }));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: (...a: any[]) => (mockAppendVerifierRefutation as any)(...a),
  getSupervisorState: (...a: any[]) => (mockGetSupervisorState as any)(...a),
}));

// Cross-wake exoneration: no prior receipt (24h window) carried either invented id.
const mockGetRecentChatReceipts: jest.Mock = jest.fn(async () => [] as any[]);
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: (...a: any[]) => (mockGetRecentChatReceipts as any)(...a),
}));

import { guardMachineWakeFinalAnswer, isCitationClassClaim, mineEvidenceCitations, REDACTED_CLAIM_LINE } from './action-verifier';

/** The two incident seats (ticket context sessionId + sighting sessionId). */
const SUP_CROSSMODEL = 'daee2916-fa75-4159-94a1-3d767abfd192';
const SUP_CANLAW = 'f5c2c1f4-898f-467f-8aee-0ddd22f723d8';

/** The fabricated citations (exist NOWHERE — prod-ground-truthed null ×3 stores each). */
const PHANTOM1 = '76a0349a';
const PHANTOM2 = '021383a1';

/** Ground-truthed REAL ids the notes cited (exonerate on their rows). */
const REAL_MSG_COCITED = 'b07e8280'; // sighting 1's second msg citation — EXISTS
const REAL_MSG_MEANT1 = 'd0d7a89c'; // chat b92ef13f's actual lastMessage at the 20:47Z wake
const REAL_TICKETS = ['be217b59', 'c5228a3d', '065caccb'];
const REAL_CHATS = ['b92ef13f', '0b69e9b1', 'e083ff2e', 'daee2916', 'f5c2c1f4'];

/** The incident's owner (ticket userId). */
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

/* ----- Sighting 1 note (crossmodel supervisor daee2916, sweep 2026-09-15T20:47Z) ----- */

const S1_HEAD = '**crossmodel: 2 of 13 goals active, 11 done; 1 lane working**';
const S1_WORKING = '**Working on**';
const S1_GOAL1 = '- Fleet Autonomy Program — phased framework hardening (from 2026-08-10 gap analysis)';
const S1_GOAL2 = '- Post-audit completion program (owner directive 2026-08-19)';
const S1_DONE_H = '**Done in the last hour**';
const S1_DONE = '- 22 work sessions finished';
const S1_NEXT_H = '**Next**';
const S1_NEXT1 = '- P0 (owner): set default coding permission mode to AUTO';
const S1_NEXT2 = `- [OWNER ACTIONS] ticket ${REAL_TICKETS[0]} (P5 seat misconfig, 9 occurrences) + ticket ${REAL_TICKETS[1]} (DMG 0.1.9 rebuild/publish) — both owner-physical`;
const S1_NEXT3 = `- [PLATFORM] ticket ${REAL_TICKETS[2]} terminal-stop contract — engineering lane live`;
const S1_SWEEP = '**SWEEP 2026-09-15T20:47Z** (wake-line 20:47:02Z; freshest tool clock list_chats b92ef13f updatedAt 20:47:15Z; firing 32/500).';
const S1_DELTAS = '**DELTAS vs 20:38Z:**';
/**
 * Sighting 1's CONVICTED line — verbatim from the ticket's note excerpt: a
 * DELTAS bullet whose parenthetical telemetry cluster carries the invented
 * msg id. The "20:49Z" token is the watch's nominal schedule time (a
 * referenced schedule fact, past-labeled by "started early"), not a future
 * observation claim.
 */
const S1_PHANTOM_LINE = `- **b92ef13f: RUNNING again** (list_chats: running:true, msg ${PHANTOM1}, updated 20:47:15Z) — its 20:49Z DMG-watch firing started early; in-progress, no completion yet. Not a re-audit echo: the firing is on its own watch schedule.`;
/**
 * The SURVIVOR bullet carrying the REAL co-citation (msg b07e8280 exists —
 * exonerates): the surgical-strike discriminator, verbatim from the excerpt.
 */
const S1_REAL_LINE = `- **0b69e9b1 (ticket 065caccb): no message activity** — its latest message is unchanged since 20:35:24Z (msg ${REAL_MSG_COCITED}, first seen 20:38Z) and it has NO enabled schedules, so it is now silent and deaf. Watch through one more sweep; if still silent, it goes STUCK.`;
const S1_QUEUE = `- **Queue (fresh list_feedback):** open=ZERO / in_progress=3 — unchanged: ${REAL_TICKETS[0]} (P5 seat, owner-action, 9 occurrences), ${REAL_TICKETS[1]} (DMG rebuild, owner-action), ${REAL_TICKETS[2]} (terminal-stop contract, in_progress since 20:34Z).`;
const S1_LEDGER = '- **Ledger (fresh goal_list):** 2 active / 11 done; goal "Fleet Autonomy Program" unchanged.';

/**
 * Sighting 1's note: 16 non-empty lines, exactly 1 convicted → strip+mark's
 * >50%-gutted fail-closed guard does NOT trip (1×2 ≤ 16) — the incident's
 * deliveredRedacted shape.
 */
const NOTE1 = [
  S1_HEAD, '', S1_WORKING, S1_GOAL1, S1_GOAL2, '', S1_DONE_H, S1_DONE, '',
  S1_NEXT_H, S1_NEXT1, S1_NEXT2, S1_NEXT3, '', S1_SWEEP, '', S1_DELTAS,
  S1_PHANTOM_LINE, S1_REAL_LINE, S1_QUEUE, S1_LEDGER,
].join('\n');

/** Sighting 1's real clock (ticket filed 20:47:55.890Z) — every remaining clock token is past or a referenced schedule nominal. */
const NOW1 = new Date('2026-09-15T20:47:50.000Z');

const INPUT1 = {
  chatId: SUP_CROSSMODEL,
  userId: OWNER,
  parts: [] as any[],
  receipts: [] as any[],
  machineTriggered: true,
  supervisor: true,
  supervisorScope: 'project' as const,
  runStartedAt: new Date('2026-09-15T20:47:03.000Z'),
  now: NOW1,
};

/* ----- Sighting 2 note (CanLaw supervisor f5c2c1f4, wake 2026-09-15T20:53:31Z) ----- */

const S2_WAKE = '**WAKE 2026-09-15T20:53:31Z** — hook on coordinator e083ff2e run_completed (tick self-audit PASS).';
/**
 * Sighting 2's CONVICTED line — verbatim from the ticket's note excerpt. The
 * bare board ids (733e1f5e / dc507413 / ed5ad2d8 — no `todo <id>` idiom)
 * convict NOTHING; "ETA 01:07–03:25Z vs 06:00Z target" is a labeled
 * projection, not a future observation claim.
 */
const S2_PHANTOM_LINE = `Pulled fresh: the coordinator's close (msg ${PHANTOM2}, its harness clock 20:53:03.517Z) — PASS, all five criteria; it caught a two-minute delta on Path C (a new report row 20:51:06Z landed 2 min after the coordinator's 20:49Z probe) and restamped the fix-leg board: 733e1f5e now reads **T369: Leg-B 1,090/2,000 (54.5%)** fr_en566/en_fr405/en_en64/fr_fr55, rejects 41.7% quota-safe, stage-6 projected ~1,220 accepted, ETA 01:07–03:25Z vs 06:00Z target. The todo pull confirms: 733e1f5e updatedAt **20:51:27.891Z** carrying exactly that T369 note — advanced from the T368 stamp (19:52Z, 1,009/2,000). dc507413 blocked/agent (09:02:12.950Z) and ed5ad2d8 blocked/deps (07:15:10.465Z) unchanged sequencing holds, no owner question behind either; everything else done/dropped.`;
const S2_DELTA = '**Delta vs 20:15Z wake:** Leg-B 1,009→1,090 board-stamped (+81). Nothing stuck, no lane deaf (coordinator 21:50Z future, Path C 21:01Z future, watch 21:09Z future, my sweep 21:10Z future). Nothing needs the owner; no fleet report-up — incremental progress, no transition.';
const S2_ACTIONS_H = 'ACTIONS TAKEN';
/**
 * The ACTIONS-TAKEN ledger line re-citing the SAME invented id (verbatim from
 * the excerpt) — the incident's second carried line of the one phantom.
 */
const S2_ACTIONS = `- update_supervisor_state — board restamped T369 1,090/2,000 at 20:51:27Z (updatedAt pulled fresh); coordinator tick absorbed via msg ${PHANTOM2}; no other changes (acknowledged).`;

/** Sighting 2's note: 5 non-empty lines; the phantom id is cited on 2 of them. */
const NOTE2 = [S2_WAKE, '', S2_PHANTOM_LINE, '', S2_DELTA, '', S2_ACTIONS_H, S2_ACTIONS].join('\n');

/** Sighting 2's real clock (ticket sighting filed 20:54:17.525Z). */
const NOW2 = new Date('2026-09-15T20:54:00.000Z');

const INPUT2 = {
  chatId: SUP_CANLAW,
  userId: OWNER,
  parts: [] as any[],
  receipts: [] as any[],
  machineTriggered: true,
  supervisor: true,
  supervisorScope: 'project' as const,
  runStartedAt: new Date('2026-09-15T20:53:32.000Z'),
  now: NOW2,
};

const containsAny = (args: any, ids: string[]) => ids.some((id) => JSON.stringify(args).includes(id));

beforeEach(() => {
  jest.clearAllMocks();
  mockGetRecentChatReceipts.mockResolvedValue([]);
  // The LLM action extractor found NO phantom action claims in either incident
  // (both filings: "fabricated EVIDENCE, not an action"; consequential actions
  // NONE) — the convictions arrived via the deterministic citation lanes.
  mockUtilityChat.mockResolvedValue(JSON.stringify({ claims: [] }) as never);
  // The msg-citation existence probe (citedMessageRowExists): the two phantom
  // ids exist NOWHERE (null — the prod-ground-truthed answer); every other
  // probed msg id (b07e8280, d0d7a89c) exonerates on its row. The mock splits
  // on the probed id, not a blanket value — exactly like the incident.
  mockPrisma.crossModelMessage.findFirst.mockImplementation(async (args: any) =>
    containsAny(args, [PHANTOM1, PHANTOM2])
      ? null
      : { id: 'b07e8280-cb58-4078-ab58-8d677b0ec989' });
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]); // no same-prefix near-miss hints
  // The cited chat rows are REAL (b92ef13f / 0b69e9b1 / e083ff2e / both seats).
  mockPrisma.crossModelChat.findFirst.mockImplementation(async (args: any) =>
    containsAny(args, REAL_CHATS) ? { id: '0b69e9b1-8ed6-4ed0-bf0c-108d06c1ff8c' } : null);
  mockPrisma.chatCodingState.findFirst.mockResolvedValue(null);
  mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: '65ab9436-0000-4000-8000-000000000000' });
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
  // The three cited tickets are REAL in_progress rows (same-tenant scope).
  mockPrisma.userFeatureRequest.findFirst.mockImplementation(async (args: any) =>
    containsAny(args, REAL_TICKETS) ? { id: 'c5228a3d-2f4a-4551-921c-b046cbf7ddc1' } : null);
  mockPrisma.userFeatureRequest.findMany.mockResolvedValue([]);
  // The bare board ids are REAL rows — and are never probed (no `todo <id>` /
  // `goal <id>` idiom rides them); rows returned defensively if a lane probes.
  mockPrisma.projectGoal.findFirst.mockResolvedValue({ id: '733e1f5e-d140-48ac-88ba-ae07b78a4da7' });
  mockPrisma.projectTodo.findFirst.mockResolvedValue({ id: '733e1f5e-d140-48ac-88ba-ae07b78a4da7' });
});

describe('ticket 0e2fcb6f replay — fabricated msg citations, two supervisor seats (crossmodel daee2916 + CanLaw f5c2c1f4)', () => {
  it('SIGHTING 1 INCIDENT REPLAY (daee2916 sweep 20:47Z): struck with exactly msg 76a0349a — the REAL co-citation b07e8280 exonerates — strip+mark elides its bullet 1:1, filing carries deliveredRedacted + containedPreDelivery + project-seat attribution', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...INPUT1, finalText: NOTE1 });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(true);

    // Exactly the ticket's phantom — no more (the real co-cited msg b07e8280,
    // the bare chat/ticket/goal ids all convict NOTHING), no less. The
    // per-id-discrimination assertion this pin exists for.
    expect(res.phantoms.map((p) => p.id)).toEqual([PHANTOM1]);
    expect(res.phantoms[0].kind).toBe('message');
    expect(isCitationClassClaim(res.phantoms[0])).toBe(true); // the [evidence citation] class

    // Strip+mark (the incident's delivery): the one convicted bullet elided,
    // the survivors delivered UNMODIFIED — including the REAL-citation bullet.
    expect(res.finalText.split('\n').filter((l) => l === REDACTED_CLAIM_LINE)).toHaveLength(1);
    expect(res.finalText).toContain(S1_HEAD);
    expect(res.finalText).toContain(S1_SWEEP);
    expect(res.finalText).toContain(S1_REAL_LINE); // the real co-citation survives untouched
    expect(res.finalText).toContain(S1_QUEUE);
    expect(res.finalText).toContain(S1_LEDGER);
    // The convicted bullet is gone (newline-anchored so the notice's own
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
    expect(filing.title).toBe('Supervisor fabricated evidence citation: cited id(s) do not exist (chat daee2916)');
    expect(filing.area).toBe('project-supervisor');
    expect(filing.context).toMatchObject({
      sessionId: SUP_CROSSMODEL,
      verifier: 'action-verifier',
      supervisorScope: 'project',
      deliveredRedacted: true,
      containedPreDelivery: true,
    });
    expect(filing.description).toContain("A project supervisor's machine-wake note cited evidence id(s) that DO NOT EXIST");
    expect(filing.description).toContain('Fabricated citation(s)');
    expect(filing.description).toContain(PHANTOM1);
    expect(filing.description).toContain('Executed consequential actions this run: NONE');
    expect(filing.description).toContain('DELIVERED with the phantom-claim line(s) removed and marked');

    // The durable state-doc refutation fires for the supervisor.
    expect(mockAppendVerifierRefutation).toHaveBeenCalled();
  });

  it('SIGHTING 1 MINER UNIT: mineEvidenceCitations lifts BOTH msg citations (phantom 76a0349a + real b07e8280) — existence, not the miner, is the discriminator; bare chat/ticket ids lift nothing on the msg lane', () => {
    const mined = mineEvidenceCitations(NOTE1);

    expect(mined.map((m) => m.id)).toEqual([PHANTOM1, REAL_MSG_COCITED]);
    expect(mined.every((m) => m.kind === 'message')).toBe(true);
    expect(mined[0].detail).toContain('[evidence citation]');
    // b92ef13f / 0b69e9b1 / be217b59 / c5228a3d / 065caccb ride no `msg <id>`
    // idiom — a regression that bare-mines them shows up here as extra claims.
    expect(mined.some((m) => m.id === 'b92ef13f' || m.id === '0b69e9b1' || m.id === REAL_TICKETS[0] || m.id === REAL_TICKETS[1] || m.id === REAL_TICKETS[2])).toBe(false);
  });

  it('SIGHTING 1 REJECT-BACK pre-pass (deferConsequences): the same conviction, named in rejectBackNotice with the "(id not captured)" escape, with NO filing — the seam\'s one-bounded-retry contract', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...INPUT1, finalText: NOTE1, deferConsequences: true });

    expect(res.struck).toBe(true);
    expect(res.phantoms.map((p) => p.id)).toEqual([PHANTOM1]);
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).toContain(PHANTOM1);
    expect(res.rejectBackNotice).toContain('(id not captured)'); // the escape hatch, taught at the moment of failure
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled(); // deferred — fires on a still-convicted retry
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('SIGHTING 1 CONTROL (no overreach — EXISTING id): the SAME note is CLEAN when the cited msg id exists as a message row (an existing row exonerates)', async () => {
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: `${PHANTOM1}-16cc-47a9-8ce4-993abc65b38d` });

    const res = await guardMachineWakeFinalAnswer({ ...INPUT1, finalText: NOTE1 });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toEqual([]);
    expect(res.finalText).toBe(NOTE1); // delivered untouched
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('SIGHTING 1 CONTROL (no overreach — the id it MEANT): the SAME note citing the REAL msg d0d7a89c (b92ef13f\u2019s actual lastMessage at the wake minute) convicts NOTHING', async () => {
    const honest = NOTE1.replace(`msg ${PHANTOM1}`, `msg ${REAL_MSG_MEANT1}`);

    const res = await guardMachineWakeFinalAnswer({ ...INPUT1, finalText: honest });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toEqual([]);
    expect(res.finalText).toBe(honest);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('SIGHTING 1 CONTROL (no overreach — this-run provenance): the SAME note is CLEAN when the cited msg id is visible verbatim in this run\u2019s list_chats tool output', async () => {
    const res = await guardMachineWakeFinalAnswer({
      ...INPUT1,
      finalText: NOTE1,
      parts: [{
        type: 'tool_result',
        name: 'list_chats',
        result: `{"chats":[{"id":"b92ef13f-c3f8-487e-8267-767e56543150","running":true,"lastMessage":"${PHANTOM1}-0c06-44ba-af85-6356c31968ac"}]}`,
      } as any],
    });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toEqual([]);
    expect(res.finalText).toBe(NOTE1);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('SIGHTING 1 CONTROL (the sanctioned honest shape): the observation with the id dropped for "(msg id not captured)" convicts NOTHING', async () => {
    const honest = NOTE1.replace(`(list_chats: running:true, msg ${PHANTOM1}, updated 20:47:15Z)`, '(list_chats: running:true, msg id not captured, updated 20:47:15Z)');

    const res = await guardMachineWakeFinalAnswer({ ...INPUT1, finalText: honest });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toEqual([]);
    expect(res.finalText).toBe(honest);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('SIGHTING 2 INCIDENT REPLAY (f5c2c1f4 wake 20:53:31Z): struck with exactly msg 021383a1 — cited on BOTH the observation paragraph and the ACTIONS ledger line — filing dedupes by id with CanLaw-seat attribution', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...INPUT2, finalText: NOTE2 });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(true);

    // Every convicted claim is the one phantom id — the bare board ids
    // (733e1f5e / dc507413 / ed5ad2d8) and the coordinator chat e083ff2e
    // convict NOTHING.
    expect(new Set(res.phantoms.map((p) => p.id))).toEqual(new Set([PHANTOM2]));
    for (const p of res.phantoms) {
      expect(p.kind).toBe('message');
      expect(isCitationClassClaim(p)).toBe(true);
    }

    // Strip+mark: the phantom-carrying line(s) elided, survivors unmodified —
    // not a wholesale replacement.
    expect(res.finalText).not.toContain(`\n${S2_PHANTOM_LINE}`);
    expect(res.finalText).not.toContain('BEGIN STRUCK NOTE');
    expect(res.finalText).toContain(S2_WAKE);
    expect(res.finalText).toContain(S2_DELTA);
    expect(res.finalText.split('\n').filter((l) => l === REDACTED_CLAIM_LINE).length).toBeGreaterThanOrEqual(1);

    // The filing: ONE fabricated-citation entry for the one distinct id, with
    // the CanLaw seat's attribution + containment flags (the live ticket's
    // sighting-2 shape).
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    const filing = mockFileFeedbackTicket.mock.calls[0][0] as any;
    expect(filing.type).toBe('mishap');
    expect(filing.title).toBe('Supervisor fabricated evidence citation: cited id(s) do not exist (chat f5c2c1f4)');
    expect(filing.area).toBe('project-supervisor');
    expect(filing.context).toMatchObject({
      sessionId: SUP_CANLAW,
      verifier: 'action-verifier',
      supervisorScope: 'project',
      deliveredRedacted: true,
      containedPreDelivery: true,
    });
    expect(filing.description).toContain('Fabricated citation(s)');
    expect(filing.description).toContain(PHANTOM2);
    expect(filing.description).toContain('Executed consequential actions this run: NONE');

    expect(mockAppendVerifierRefutation).toHaveBeenCalled();
  });

  it('SIGHTING 2 MINER UNIT: mineEvidenceCitations lifts the phantom from BOTH carried lines — the observation paragraph AND the ACTIONS ledger re-citation', () => {
    const mined = mineEvidenceCitations(NOTE2);

    expect(mined.length).toBeGreaterThanOrEqual(1);
    expect(new Set(mined.map((m) => m.id))).toEqual(new Set([PHANTOM2]));
    expect(mined.every((m) => m.kind === 'message')).toBe(true);
    // The bare board ids lift nothing on the msg lane.
    expect(mined.some((m) => m.id === '733e1f5e' || m.id === 'dc507413' || m.id === 'ed5ad2d8' || m.id === 'e083ff2e')).toBe(false);
  });

  it('SIGHTING 2 REJECT-BACK pre-pass (deferConsequences): the conviction named in rejectBackNotice with the "(id not captured)" escape, NO filing', async () => {
    const res = await guardMachineWakeFinalAnswer({ ...INPUT2, finalText: NOTE2, deferConsequences: true });

    expect(res.struck).toBe(true);
    expect(new Set(res.phantoms.map((p) => p.id))).toEqual(new Set([PHANTOM2]));
    expect(res.rejectBackNotice).toBeDefined();
    expect(res.rejectBackNotice).toContain(PHANTOM2);
    expect(res.rejectBackNotice).toContain('(id not captured)');
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(mockAppendVerifierRefutation).not.toHaveBeenCalled();
  });

  it('SIGHTING 2 CONTROL (no overreach — EXISTING id): the SAME note is CLEAN when the cited msg id exists as a message row', async () => {
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue({ id: `${PHANTOM2}-32fc-4214-8cf7-78d6bcb958fd` });

    const res = await guardMachineWakeFinalAnswer({ ...INPUT2, finalText: NOTE2 });

    expect(res.audited).toBe(true);
    expect(res.struck).toBe(false);
    expect(res.phantoms).toEqual([]);
    expect(res.finalText).toBe(NOTE2);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('SIGHTING 2 CONTROL (the sanctioned honest shape): BOTH carried lines with the id dropped for "(msg id not captured)" convict NOTHING', async () => {
    const honest = NOTE2
      .replace(`(msg ${PHANTOM2}, its harness clock 20:53:03.517Z)`, '(msg id not captured, its harness clock 20:53:03.517Z)')
      .replace(`coordinator tick absorbed via msg ${PHANTOM2}`, 'coordinator tick absorbed (msg id not captured)');

    const res = await guardMachineWakeFinalAnswer({ ...INPUT2, finalText: honest });

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
