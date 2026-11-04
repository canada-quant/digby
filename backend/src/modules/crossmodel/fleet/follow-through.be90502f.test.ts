/**
 * Replay for ticket be90502f — "Auto-file creates owner questions from stale
 * or no-decision supervisor notes".
 *
 * THE DEFECT (three sightings, all in this instance's owner_questions history):
 *  1. oq_47ec4300, filed 2026-09-18 23:58Z from the canlegal-bench
 *     Supervisor's 22:15Z note ("one owner decision pending (scale-out)").
 *     That decision was ANSWERED at 23:44Z (oq_5c7a97d8, Option 1 — scale-out
 *     approved) — 14 minutes BEFORE the card was filed. The ledger check only
 *     counts OPEN questions (an answered row is not open), and the N8
 *     answered-scan is a Jaccard topic match the differently-phrased
 *     auto-filed text fails — so the sweep re-filed an answered decision.
 *  2. oq_06b64479, filed 2026-09-18 07:22Z from "Zero open owner questions;
 *     nothing waits on the owner." — absence read as a claim. (Already fixed
 *     by #851 f7e9df4c + #854 bdd71948; replayed here as a regression pin.)
 *  3. oq_9f5995bf, filed 2026-09-17 10:56Z from "nothing else in this project
 *     waits on the owner". (Already fixed by #854 bdd71948; replayed here.)
 *
 * THE FIX (this change): a TEMPORAL staleness guard in the unfiled-decision
 * path — recentlyResolvedOwnerQuestion(sup, noteAt) mirrors
 * openOwnerQuestionExists' scope and asks for a question RESOLVED
 * (answered|dismissed, resolvedAt > note.createdAt) in scope. A hit means the
 * board already moved past the decision the note describes: the sweep skips
 * the filing, posts the already-answered notice naming the prior, and records
 * decision_autofiled meta.outcome 'stale_answered'. Resolutions PREDATING the
 * note never suppress (the supervisor wrote the claim with the answer already
 * available — a genuinely new decision, or a supervisor error the N8
 * preflight still judges).
 *
 * These tests replay the sightings through the REAL miner and the REAL sweep
 * (prisma + redis + flagOwnerQuestion stubbed at the module seams; mock
 * discipline mirrors follow-through.bdd71948.test.ts).
 */

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  crossModelProject: { findMany: jest.fn(async () => []) },
  crossModelMessage: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})) },
  runToolReceipt: { findMany: jest.fn(async () => []) },
  projectTodo: { findFirst: jest.fn(async () => null) },
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

import { mineUnfiledDecisionClaims, sweepFollowThrough } from './follow-through.service';
import { recordLoopMetric } from '../platform/loop-metrics.service';

const mockMetric = recordLoopMetric as jest.Mock;

/** Sighting 1's clock: note 22:15Z, answer 23:44Z, duplicate filed 23:58Z. */
const NOW = new Date('2026-09-18T23:58:00Z');
const NOTE_AT = new Date('2026-09-18T22:15:00Z');
const SUP = 'c0e22e36-0000-4000-8000-000000000000'; // the canlegal-bench Supervisor chat shape
const PROJ = 'proj-canlegal-bench';
const SIGHTING_1 = 'Scale-out read: one owner decision pending (scale-out).';
/** The exact sentences that auto-filed sightings 2 and 3. */
const SIGHTING_2 = 'Zero open owner questions; nothing waits on the owner.';
const SIGHTING_3 = 'Not re-filed from CanLaw — no duplicate card, and nothing else in this project waits on the owner (board: 0 open owner questions here).';

const PROJECT_SUP_ROW: any = { id: SUP, userId: 'u1', title: 'canlegal-bench Supervisor', projectId: PROJ, isSupervisor: false, isProjectSupervisor: true };
const FLEET_SUP_ROW: any = { id: SUP, userId: 'u1', title: 'Fleet Supervisor', projectId: null, isSupervisor: true, isProjectSupervisor: false };

let supRow: any = PROJECT_SUP_ROW;
const noteRow = (content: string, at: Date = NOTE_AT): any => ({ id: `note-${content.length}`, content, createdAt: at, metadata: { origin: 'schedule' } });
const flag = jest.fn(async () => ({ kind: 'created', question: { id: 'oq_newabc123-def' } }));
const wake = jest.fn(async () => ({}));

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
  supRow = PROJECT_SUP_ROW;
  mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.OR) return [supRow]; // the supervisor listing
    if (args?.where?.projectId) return [{ id: 'lane-chat-1' }]; // the supervisor's project chats
    return [];
  });
  mockPrisma.crossModelProject.findMany.mockImplementation(async () => [{ id: PROJ, projectSupervisorEnabled: true, archivedAt: null }]);
  mockPrisma.crossModelMessage.findMany.mockImplementation(async () => [noteRow(SIGHTING_1)]);
  mockPrisma.ownerQuestion.findFirst.mockImplementation(async () => null);
  // Seed the sweep cursor 15 minutes before the note so the note is DUE (and past the 90-min grace).
  store.set(`follow-through:cursor:${SUP}`, String(new Date('2026-09-18T22:00:00Z').getTime()));
});

const run = () => sweepFollowThrough({ now: NOW, enqueueDirectWake: wake as any, flagOwnerQuestion: flag as any });

describe('ticket be90502f — stale-note guard (sighting oq_47ec4300)', () => {
  it('REPLAY: a decision ANSWERED after the note was written files NOTHING — the already-answered notice names the prior', async () => {
    mockPrisma.ownerQuestion.findFirst
      .mockImplementationOnce(async () => null) // open-question ledger check
      .mockImplementationOnce(async () => ({ id: 'oq_5c7a97d8-aaaa-bbbb-cccc', status: 'answered', answer: 'Option 1 — scale-out approved' })); // resolved-after-note
    const out = await run();
    expect(flag).not.toHaveBeenCalled();
    const notices = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data);
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toContain('oq_5c7a97d');
    expect(notices[0].content).toContain('already answered');
    expect(notices[0].content).toContain('Option 1 — scale-out approved');
    expect(notices[0].metadata).toMatchObject({ origin: 'follow-through', kind: 'decision-autofiled', outcome: 'stale_answered' });
    expect(mockMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'decision_autofiled', meta: expect.objectContaining({ outcome: 'stale_answered', oqId: 'oq_5c7a97d8-aaaa-bbbb-cccc' }) }));
    expect(out).toEqual({ supervisors: 1, nudges: 0, autofiled: 0, askNudges: 0, askEscalations: 0 }); // a skip is not a filing
  });

  it('pins the guard WHERE clause: resolvedAt > note.createdAt, status in (answered, dismissed), project scope', async () => {
    await run();
    expect(mockPrisma.ownerQuestion.findFirst).toHaveBeenCalledTimes(2);
    const resolvedWhere = mockPrisma.ownerQuestion.findFirst.mock.calls[1][0].where;
    expect(resolvedWhere.status).toEqual({ in: ['answered', 'dismissed'] });
    expect(resolvedWhere.resolvedAt).toEqual({ gt: NOTE_AT });
    expect(resolvedWhere.OR).toEqual([{ chatId: { in: [SUP, 'lane-chat-1'] } }, { forChatId: { in: [SUP, 'lane-chat-1'] } }]);
  });

  it('a resolution PREDATING the note never suppresses — the live claim still files', async () => {
    // The resolved-check returns null: no question resolved AFTER the note.
    const out = await run();
    expect(flag).toHaveBeenCalledTimes(1);
    expect(flag).toHaveBeenCalledWith(expect.objectContaining({ chatId: SUP, userId: 'u1', machineTriggered: true, question: expect.stringContaining('one owner decision pending (scale-out)') }));
    const notices = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data);
    expect(notices[0].content).toContain('Filed oq_newabc12');
    expect(out.autofiled).toBe(1);
  });

  it('a question DISMISSED after the note also suppresses (the owner saw the topic and declined)', async () => {
    mockPrisma.ownerQuestion.findFirst
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ id: 'oq_d9999999-aaaa-bbbb-cccc', status: 'dismissed', answer: null }));
    const out = await run();
    expect(flag).not.toHaveBeenCalled();
    const notices = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data);
    expect(notices[0].content).toContain('already dismissed');
    expect(notices[0].metadata.outcome).toBe('stale_answered');
    expect(out.autofiled).toBe(0);
  });

  it('Fleet Supervisor scope: the resolved check is account-wide (no chatId OR clause)', async () => {
    supRow = FLEET_SUP_ROW;
    mockPrisma.ownerQuestion.findFirst
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ id: 'oq_5c7a97d8-aaaa-bbbb-cccc', status: 'answered', answer: 'Option 1 — scale-out approved' }));
    const out = await run();
    expect(flag).not.toHaveBeenCalled();
    const resolvedWhere = mockPrisma.ownerQuestion.findFirst.mock.calls[1][0].where;
    expect(resolvedWhere).toEqual({ userId: 'u1', status: { in: ['answered', 'dismissed'] }, resolvedAt: { gt: NOTE_AT } });
    expect(resolvedWhere.OR).toBeUndefined();
    expect(out.autofiled).toBe(0);
  });

  it('the affirmative canlegal-bench claim the detector exists for still mines AND files', async () => {
    mockPrisma.crossModelMessage.findMany.mockImplementation(async () => [noteRow('publishing v0.8.2 is owner-gated on Gates 1–3.')]);
    const out = await run();
    expect(flag).toHaveBeenCalledTimes(1);
    expect(flag).toHaveBeenCalledWith(expect.objectContaining({ question: expect.stringContaining('is owner-gated on Gates 1–3') }));
    expect(out.autofiled).toBe(1);
  });
});

describe('ticket be90502f — no-decision polarity replays (pinned by #851/#854, replayed under this ticket)', () => {
  it('REPLAY oq_06b64479: "Zero open owner questions; nothing waits on the owner." mines NO claim', () => {
    expect(mineUnfiledDecisionClaims(SIGHTING_2)).toEqual([]);
  });

  it('REPLAY oq_9f5995bf: "nothing else in this project waits on the owner" mines NO claim', () => {
    expect(mineUnfiledDecisionClaims(SIGHTING_3)).toEqual([]);
  });
});
