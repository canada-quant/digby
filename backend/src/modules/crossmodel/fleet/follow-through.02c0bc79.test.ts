/**
 * Replay for ticket 02c0bc79 — "[FOLLOW-THROUGH] strikes doctrine-correct
 * lane retirements".
 *
 * THE DEFECT (live incident, 2026-09-24): the canlegal-bench project
 * supervisor (chat 615723ba) diagnosed lane 66c9fb5c at 01:53Z, then retired
 * it per the owner's 2026-09-20 retire doctrine — cancel_schedule on its
 * recurring cadence, then archive_chat at 02:27Z ("Archived chat
 * 66c9fb5c-cf72-4ced-a298-1951b7d610da", supervisor transcript msg f0a00157).
 * At 03:27Z the detector fired on the 01:53Z diagnosis demanding a nudge /
 * todo rewrite / session restart / file_feedback — every remedy noise or an
 * active UNDO of the retirement.
 *
 * Root cause: actedTowardLane's accepted-action set could not see a
 * retirement. archive_chat mints NO run_tool_receipt at all (it is not in
 * RECEIPT_TOOLS — coding/run-receipts.ts), so its only durable trace is
 * crossmodel_chats.archivedAt; cancel_schedule DOES mint a receipt, but its
 * envelope ids carry the SCHEDULE id only (platform-tools.ts), and the
 * generic receipt arm matches on the LANE id — so neither retirement leg
 * could ever credit.
 *
 * THE FIX: two target-id-bound retirement legs in actedTowardLane —
 *  (a) CANCEL leg: a cancel_schedule receipt resolves through the surviving
 *      coding_schedules row (cancel PERSISTS the row — enabled:false — with
 *      sessionId == the lane chat id) and credits only when that row belongs
 *      to the diagnosed lane, same owner;
 *  (b) ARCHIVE leg: the lane lookup now selects archivedAt, and a stamp on
 *      the diagnosed lane within the run-slack window (15 min before the
 *      note row — a same-wake retirement stamps a few seconds/minutes before
 *      the lazily-persisted note) credits.
 * Target-id binding is the guard property: an archive or cancel naming a
 * DIFFERENT chat never satisfies the diagnosis; an archive PREDATING the
 * note window is a pre-existing retirement, not an action toward a fresh
 * diagnosis. A diagnosis with NO accepted action still strikes, and the
 * strike message now names retirement in both its "no action on record"
 * enumeration and its remedy list.
 *
 * Mock discipline mirrors follow-through.be90502f.test.ts. The
 * crossModelChat.findFirst / chatSchedule.findFirst mocks are
 * implementation-faithful — each enforces the query's OWN startsWith/userId
 * bindings against an in-memory table — so the wrong-target pins bind
 * BEHAVIORALLY, not by a hardcoded null.
 */

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null) },
  ownerQuestion: { findFirst: jest.fn(async () => null) },
};
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import { sweepFollowThrough, FOLLOW_THROUGH_RUN_SLACK_MS } from './follow-through.service';

/** The incident's clock: diagnosis 01:53Z, archive 02:27Z, sweep 03:27Z (the note is 94 min old — past the 90-min grace, due). */
const NOW = new Date('2026-09-24T03:27:00Z');
const NOTE_AT = new Date('2026-09-24T01:53:00Z');
const ARCHIVE_AT = new Date('2026-09-24T02:27:00Z');
const SUP = '615723ba-0000-4000-8000-000000000000'; // the canlegal-bench project supervisor chat shape
const LANE = '66c9fb5c';
const LANE_FULL = '66c9fb5c-cf72-4ced-a298-1951b7d610da'; // the incident's archived lane id
const OTHER_LANE_FULL = 'aaaaaaaa-bbbb-4000-8000-000000000000';
const PROJ = 'proj-canlegal-bench';
const SUP_ROW: any = { id: SUP, userId: 'u1', title: 'canlegal-bench Supervisor', projectId: PROJ, isSupervisor: false, isProjectSupervisor: true };

/** The 01:53Z diagnosis sentence — a stall FRAME + the lane id, carrying NO resolution token (an "archived" mention would suppress the mine). */
const DIAGNOSIS = `Lane ${LANE} looks stalled: no receipts in 6h.`;
const noteRow = (at: Date = NOTE_AT): any => ({ id: 'note-dx-66c9', content: DIAGNOSIS, createdAt: at, metadata: { origin: 'schedule' } });

const wake = jest.fn(async () => ({}));
const flag = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_newabc123-def' } }));
const run = () => sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });

/** Chats the lane lookup can see — the mock enforces the query's own id-prefix + userId binding. */
let CHATS: any[];
/** Schedules the cancel-leg lookup can see — same faithful binding (id prefix AND sessionId prefix AND userId). */
let SCHEDULES: any[];

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  CHATS = [];
  SCHEDULES = [];
  mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.OR) return [SUP_ROW]; // the supervisor listing
    return [];
  });
  mockPrisma.crossModelProject.findMany.mockImplementation(async () => [{ id: PROJ, projectSupervisorEnabled: true, archivedAt: null }]);
  mockPrisma.crossModelMessage.findMany.mockImplementation(async () => [noteRow()]);
  mockPrisma.crossModelMessage.findFirst.mockImplementation(async () => null); // no agent message posted into the lane
  mockPrisma.runToolReceipt.findMany.mockImplementation(async () => []);      // no receipts at all by default
  mockPrisma.crossModelChat.findFirst.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    const idP = w.id?.startsWith ?? '';
    return CHATS.find((c) => c.id.startsWith(idP) && c.userId === w.userId) ?? null;
  });
  mockPrisma.chatSchedule.findFirst.mockImplementation(async (args: any) => {
    const w = args?.where ?? {};
    const idP = w.id?.startsWith ?? '';
    const sessP = w.sessionId?.startsWith ?? '';
    return SCHEDULES.find((s) => s.id.startsWith(idP) && s.sessionId.startsWith(sessP) && s.userId === w.userId) ?? null;
  });
  // Seed the sweep cursor 23 min before the note so the note is DUE (and past the 90-min grace: it is 94 min old at NOW).
  store.set(`follow-through:cursor:${SUP}`, String(new Date('2026-09-24T01:30:00Z').getTime()));
});

describe('ticket 02c0bc79 — doctrine-correct retirement counts as follow-through', () => {
  it('REPLAY (archive leg): the incident — a 01:53Z diagnosis, then a 02:27Z archive_chat of that lane → NO strike', async () => {
    CHATS = [{ id: LANE_FULL, userId: 'u1', archivedAt: ARCHIVE_AT }];
    const out = await run();
    expect(out).toEqual({ supervisors: 1, nudges: 0, autofiled: 0, askNudges: 0, askEscalations: 0 });
    expect(wake).not.toHaveBeenCalled();
    // The lane lookup read the archive stamp — since audit 94f608c1 (2026-10-16) archive_chat
    // DOES mint a run_tool_receipt (SUPERVISOR_STATE_RECEIPT_TOOLS), but this belt reads
    // archivedAt anyway: the receipt proves the CALL, the stamp proves the row STATE, and a
    // follow-through credit must survive a receipt write failure (fire-and-forget).
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { startsWith: LANE }, userId: 'u1' },
      select: { id: true, archivedAt: true },
    }));
  });

  it('REPLAY (cancel leg): cancel_schedule on the lane\'s cadence → NO strike (receipt resolved through the surviving coding_schedules row)', async () => {
    // The lane is still unarchived (doctrine retires the cadence FIRST; the archive lands later) — only the cancel credit applies.
    CHATS = [{ id: LANE_FULL, userId: 'u1', archivedAt: null }];
    SCHEDULES = [{ id: 'sch4f2b91aa-0000-4000-8000-000000000000', sessionId: LANE_FULL, userId: 'u1' }];
    mockPrisma.runToolReceipt.findMany.mockImplementation(async () => [
      { tool: 'cancel_schedule', ids: { scheduleId: 'sch4f2b91aa' } }, // the tool's ≥8-char prefix idiom
    ]);
    const out = await run();
    expect(out.nudges).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    // The receipt resolved through the surviving schedule row, bound to the diagnosed lane + same owner.
    expect(mockPrisma.chatSchedule.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { startsWith: 'sch4f2b91aa' }, sessionId: { startsWith: LANE }, userId: 'u1' },
      select: { id: true },
    }));
  });

  it('GUARD STRENGTH: a diagnosis with NO action at all still strikes — and the wake names retirement in its vocabulary', async () => {
    CHATS = [{ id: LANE_FULL, userId: 'u1', archivedAt: null }]; // the lane exists, nothing was done to it
    const out = await run();
    expect(out.nudges).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
    const call = (wake.mock.calls[0] as any)[0];
    expect(call.targetChatId).toBe(SUP);
    expect(call.meta).toMatchObject({ origin: 'follow-through', kind: 'diagnosis_without_action', laneId8: LANE });
    expect(call.prompt).toContain(`At 09-24 01:53Z you diagnosed lane ${LANE} as stalled`);
    // The remedy vocabulary names retirement as a valid action — a future supervisor knows archiving satisfies follow-through.
    expect(call.prompt).toContain('no retirement (cancel_schedule on its cadence + archive_chat) of it');
    expect(call.prompt).toContain("retire it per the owner's retire doctrine (cancel_schedule on its recurring cadence, then archive_chat)");
    expect(call.prompt).toContain('Narration alone is not an acceptable reply');
  });

  it('TARGET-ID BINDING (archive leg): an archive_chat of a DIFFERENT chat does not satisfy the diagnosis → strike fires', async () => {
    // The archive stamp lives on ANOTHER chat's row; the diagnosed lane's own row is untouched.
    CHATS = [
      { id: LANE_FULL, userId: 'u1', archivedAt: null },
      { id: OTHER_LANE_FULL, userId: 'u1', archivedAt: ARCHIVE_AT },
    ];
    const out = await run();
    expect(out.nudges).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('TARGET-ID BINDING (cancel leg): a cancel_schedule for a cadence on a DIFFERENT chat does not satisfy the diagnosis → strike fires', async () => {
    CHATS = [{ id: LANE_FULL, userId: 'u1', archivedAt: null }];
    // The cancelled cadence belongs to the OTHER chat — the mock enforces the query's own sessionId binding, so the lookup misses.
    SCHEDULES = [{ id: 'sch4f2b91aa-0000-4000-8000-000000000000', sessionId: OTHER_LANE_FULL, userId: 'u1' }];
    mockPrisma.runToolReceipt.findMany.mockImplementation(async () => [
      { tool: 'cancel_schedule', ids: { scheduleId: 'sch4f2b91aa' } },
    ]);
    const out = await run();
    expect(out.nudges).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatSchedule.findFirst).toHaveBeenCalled(); // the cancel WAS resolved — and bound away from this lane
  });

  it('TEMPORAL BINDING (archive leg): a pre-existing archive PREDATING the note window is no action toward a fresh diagnosis → strike fires', async () => {
    // Archived four days before the diagnosis — the run-slack window (15 min before the note row) excludes it.
    CHATS = [{ id: LANE_FULL, userId: 'u1', archivedAt: new Date('2026-09-20T00:00:00Z') }];
    const out = await run();
    expect(out.nudges).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1);
    // Pin the window arithmetic the credit uses: since = NOTE_AT − FOLLOW_THROUGH_RUN_SLACK_MS = 01:38Z.
    expect(new Date(NOTE_AT.getTime() - FOLLOW_THROUGH_RUN_SLACK_MS).getTime()).toBe(new Date('2026-09-24T01:38:00Z').getTime());
  });
});
