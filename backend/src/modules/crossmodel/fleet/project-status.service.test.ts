/**
 * Project status service — unit tests with mocked Prisma (the fleet-service
 * test pattern: config/database boundary mocked, fixtures filtered like real
 * queries). Covers: renderer determinism + the SHARED CONTRACT shape, the
 * wording rules (no ids/SHAs/receipts/oq_ tokens, ≤ 900 chars, headline
 * sentence), the identifier stripper, the wake-note marker reader, the 60-min
 * gate, the no-change stub, the kill switch, per-project failure isolation,
 * the direct-insert contract (never sendChatMessage), and the read side.
 */

// The plain-language brief (owner 2026-09-22) rides the same row; its builder is a separate unit (project-brief.service.test.ts).
// computeAsksFingerprint (2026-09-24) is half of the card's "unchanged" test — it returns the fingerprint WITH the
// loaded ask context (review C21); null means "unprovable ⇒ the asks read as changed".
jest.mock('./project-brief.service', () => ({
  buildProjectBrief: jest.fn(async () => null),
  renderBriefMarkdown: jest.fn(() => ''),
  computeAsksFingerprint: jest.fn(async () => null),
}));
const briefMod = jest.requireMock('./project-brief.service') as { buildProjectBrief: jest.Mock; renderBriefMarkdown: jest.Mock; computeAsksFingerprint: jest.Mock };
/** The brief the mocked builder returns; its fingerprint matches the mocked fingerprint read, so a quiet ledger is a quiet card. */
const BRIEF_FIXTURE = { mission: 'CanLaw trains a legal model.', now: 'One lane is rebuilding the index.', changed: [], blocked: [], next: 'Publish the benchmark.', asks: [], generatedAt: '2026-09-14T15:00:00.000Z', source: 'model' as const, asksFingerprint: 'fp-1' };
const EMPTY_ASK_CONTEXT = { directives: [], asks: [] };
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelProject: { findUnique: jest.fn() },
  crossModelChat: { findMany: jest.fn(), update: jest.fn(async () => ({})) },
  // update: the in-place refresh of a quiet-hour stub (2026-09-24).
  crossModelMessage: { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn(async (args: any) => ({ id: args?.where?.id, ...args?.data })) },
  projectGoal: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  agentRun: { findMany: jest.fn() },
  chatSchedule: { findMany: jest.fn() },
  eventHook: { findFirst: jest.fn() },
  hookEvent: { findMany: jest.fn() },
  // count: open owner items on the project's chats; findMany: the CanLaw-2026-09-15
  // probe of the owner questions blocked rows CITE (gate id / inline oq_ id).
  ownerQuestion: { count: jest.fn(), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Adoption ladder (tt-rd audit 2026-09-27): the card reads it DYNAMICALLY for
// the KPI row's experiments-without-adoption counter — mocked at the boundary.
const mockLoadAdoptionLadders: jest.Mock = jest.fn(async () => new Map());
jest.mock('../platform/adoption-ladder', () => ({ __esModule: true, loadAdoptionLadders: (...a: any[]) => mockLoadAdoptionLadders(...a) }));

// loop-metrics boundary — constants stay real, the write is captured.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import fs from 'fs';
import path from 'path';
import {
  renderProjectStatus,
  emitProjectStatusUpdates,
  runProjectStatusOnce,
  getLatestProjectStatus,
  stripIdentifiers,
  supervisorCheckInLine,
  buildHeadline,
  buildStatusBody,
  hashProjectStatus,
  noChangeStatus,
  quietDurationPhrase,
  PROJECT_STATUS_ORIGIN,
  PROJECT_STATUS_INTERVAL_MS,
  PROJECT_STATUS_BODY_MAX_CHARS,
  PROJECT_STATUS_DISABLED_ENV,
  PROJECT_STATUS_EVENT_MIN_MS,
  requestProjectStatusCheck,
} from './project-status.service';
import type { ProjectStatus } from './project-status.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const P1 = 'proj-1';
const SUP = 'chat-sup';
const LANE_A = 'chat-lane-a';
const LANE_B = 'chat-lane-b';
const LANE_C = 'chat-lane-c'; // archived
const NOW = new Date('2026-09-14T15:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 60 * 60_000);

let project: any;
let chats: any[];
let goals: any[];
let todos: any[];
let runningRuns: any[];
let schedules: any[];
let hook: any;
let hookEvents: any[];
let openQuestions: number;
let wakeNotes: any[];
let prevStatusRow: any;
let latestForProject: any;
let lanes: any[];

function seed() {
  project = { id: P1, name: 'CanLaw', userId: OWNER };
  chats = [
    { id: SUP, isProjectSupervisor: true, archivedAt: null },
    { id: LANE_A, isProjectSupervisor: false, archivedAt: null },
    { id: LANE_B, isProjectSupervisor: false, archivedAt: null },
    { id: LANE_C, isProjectSupervisor: false, archivedAt: new Date('2026-09-01T00:00:00Z') },
  ];
  goals = [
    { id: 'g1', title: 'Train the Qwen legal model', status: 'active', progressNote: '3 of 5 shards trained (run 9f8e7d6c5b4a3210)', blockedReason: null, updatedAt: NOW },
    { id: 'g2', title: 'Publish the benchmark', status: 'active', progressNote: null, blockedReason: null, updatedAt: NOW },
    { id: 'g3', title: 'the SoR rebuild', status: 'blocked', progressNote: null, blockedReason: 'Awaiting owner decision [oq_7f3a2b1c-aaaa-bbbb-cccc-1234567890ab open]', updatedAt: NOW },
    { id: 'g4', title: 'Old archived goal', status: 'archived', progressNote: null, blockedReason: null, updatedAt: NOW },
  ];
  todos = [
    { id: 't1', title: 'Rebuild the SoR index', status: 'in_progress', progressNote: 'halfway, receipt 3c2d1e0f9a8b7c6d', blockedReason: null, updatedAt: NOW },
    { id: 't2', title: 'Write the benchmark report', status: 'pending', progressNote: null, blockedReason: null, updatedAt: NOW },
    { id: 't3', title: 'Upload the eval set', status: 'blocked', progressNote: null, blockedReason: '[deps] Waiting on 2 todos', updatedAt: NOW },
    { id: 't4', title: 'Ship dataset v2 (commit deadbeefcafe1234)', status: 'done', progressNote: null, blockedReason: null, updatedAt: new Date(NOW.getTime() - 10 * 60_000) },
    { id: 't5', title: 'Ancient done todo', status: 'done', progressNote: null, blockedReason: null, updatedAt: new Date(NOW.getTime() - 3 * 60 * 60_000) },
  ];
  runningRuns = [{ sessionId: LANE_A }];
  schedules = [{ sessionId: LANE_B }, { sessionId: LANE_B }];
  hook = { id: 'hook-1' };
  hookEvents = [{ eventType: 'run_completed', createdAt: new Date(NOW.getTime() - 20 * 60_000) }, { eventType: 'run_completed', createdAt: new Date(NOW.getTime() - 20 * 60_000) }, { eventType: 'run_failed', createdAt: new Date(NOW.getTime() - 20 * 60_000) }];
  openQuestions = 1;
  wakeNotes = [{ content: 'WAKE: no-op — nothing moved on CanLaw since 14:00 (msg 06c1030f)' }];
  prevStatusRow = null;
  latestForProject = null;
  lanes = [{ id: SUP, projectId: P1, userId: OWNER }];
}

function wireMocks() {
  mockPrisma.crossModelProject.findUnique.mockImplementation((args: any) =>
    Promise.resolve(args?.where?.id === project?.id ? project : null),
  );
  mockPrisma.crossModelChat.findMany.mockImplementation((args: any) => {
    if (args?.where?.isProjectSupervisor === true) return Promise.resolve(lanes);
    return Promise.resolve(chats.filter(() => args?.where?.projectId === P1));
  });
  mockPrisma.projectGoal.findMany.mockImplementation((args: any) =>
    Promise.resolve(goals.filter(() => args?.where?.projectId === P1)),
  );
  mockPrisma.projectTodo.findMany.mockImplementation((args: any) =>
    Promise.resolve(todos.filter(() => args?.where?.projectId === P1)),
  );
  mockPrisma.agentRun.findMany.mockImplementation((args: any) => {
    const ids: string[] = args?.where?.sessionId?.in ?? [];
    return Promise.resolve(runningRuns.filter((r) => ids.includes(r.sessionId)));
  });
  mockPrisma.chatSchedule.findMany.mockImplementation((args: any) => {
    const ids: string[] = args?.where?.sessionId?.in ?? [];
    return Promise.resolve(schedules.filter((s) => ids.includes(s.sessionId)));
  });
  mockPrisma.eventHook.findFirst.mockImplementation((args: any) =>
    Promise.resolve(args?.where?.targetChatId === SUP && args?.where?.projectId === P1 ? hook : null),
  );
  // Window-filtered like the real query (2026-09-29: the at-a-glance update's
  // "changes" reads the window's failed runs, so a mock that replayed the same
  // events every hour made every quiet hour a change). Undated events stay
  // unfiltered.
  mockPrisma.hookEvent.findMany.mockImplementation((args: any) => {
    if (args?.where?.hookId !== hook?.id) return Promise.resolve([]);
    const gte = args?.where?.createdAt?.gte ? new Date(args.where.createdAt.gte).getTime() : -Infinity;
    const lte = args?.where?.createdAt?.lte ? new Date(args.where.createdAt.lte).getTime() : Infinity;
    return Promise.resolve(hookEvents.filter((e) => !e.createdAt || (e.createdAt.getTime() >= gte && e.createdAt.getTime() <= lte)));
  });
  mockPrisma.ownerQuestion.count.mockImplementation(() => Promise.resolve(openQuestions));
  // The SoR goal's reason cites oq_7f3a2b1c… inline — that question is OPEN in the fixture.
  mockPrisma.ownerQuestion.findMany.mockImplementation(async () => [{ id: 'oq_7f3a2b1c-aaaa-bbbb-cccc-1234567890ab' }]);
  // Two findFirst callers: the read side (where.chat) and the 60-min gate's
  // previous status row. The wake-note read is a findMany (where.OR) since
  // ticket 68742517 — a batch scan that skips harness provider-error envelopes.
  mockPrisma.crossModelMessage.findFirst.mockImplementation((args: any) => {
    if (args?.where?.chat) return Promise.resolve(latestForProject);
    return Promise.resolve(prevStatusRow);
  });
  mockPrisma.crossModelMessage.findMany.mockImplementation((args: any) => {
    if (args?.where?.OR) return Promise.resolve(wakeNotes);
    return Promise.resolve([]);
  });
  mockPrisma.crossModelMessage.create.mockImplementation((args: any) => Promise.resolve({ id: 'msg-new', ...args?.data }));
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env[PROJECT_STATUS_DISABLED_ENV];
  seed();
  wireMocks();
  briefMod.buildProjectBrief.mockImplementation(async () => ({ ...BRIEF_FIXTURE }));
  briefMod.computeAsksFingerprint.mockImplementation(async () => ({ fingerprint: 'fp-1', context: EMPTY_ASK_CONTEXT }));
});

const created = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data);
const ID_RE = /\b[0-9a-f]{8,}\b/i;

// ── stripIdentifiers ──────────────────────────────────────────────────────────

describe('stripIdentifiers (wording rule: titles yes, ids no)', () => {
  it('a stripped id that led a parenthesised list leaves no orphan separator (first live card, 2026-09-14)', () => {
    expect(stripIdentifiers('SFT-2 DATASET REBUILD v2 — owner directive (oq_9a0e5a3a-1111-2222-3333-444444444444, answeredBy owner)'))
      .toBe('SFT-2 DATASET REBUILD v2 — owner directive (answeredBy owner)');
    expect(stripIdentifiers('gate cleared (cf_abc12) and merged [deadbeefcafe]')).toBe('gate cleared and merged');
  });

  it('removes harness clocks — ISO stamps and zoned wall clocks — but keeps unzoned times (owner 2026-09-14: local time only)', () => {
    const out = stripIdentifiers('Live snapshot as of 14:41Z (harness clock 13:44:05Z) at 2026-09-14T14:41:21Z, deploy 14:32 UTC; standup 09:30 daily');
    expect(out).not.toMatch(/\d{1,2}:\d{2}(?::\d{2})?\s?(?:Z|UTC)\b/);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(out).toContain('standup 09:30 daily');
    expect(out).toContain('Live snapshot as of');
  });

  it('removes uuids, hex runs of 8+, oq_/cf_ tokens, receipt tokens and hollow refs', () => {
    const out = stripIdentifiers(
      'Blocked on gate oq_7f3a2b1c-aaaa-bbbb-cccc-1234567890ab; see run 9f8e7d6c5b4a3210 (msg 06c1030f) receipt 3c2d1e0f cf_abc12 and commit deadbeefcafe1234 [oq_9 open]',
    );
    expect(out).not.toMatch(ID_RE);
    expect(out).not.toMatch(/oq_|cf_/);
    expect(out).not.toMatch(/receipt/i);
    expect(out).not.toMatch(/\(\s*msg\s*\)|\[\s*open\s*\]/);
    expect(out).toContain('Blocked on gate');
    expect(out).toContain('commit');
  });

  it('keeps plain words — including the word after "receipt" when it is not id-shaped', () => {
    expect(stripIdentifiers('see receipt for payment')).toBe('see for payment');
    expect(stripIdentifiers('Rebuild the SoR index')).toBe('Rebuild the SoR index');
    expect(stripIdentifiers('a facade decade cafe')).toBe('a facade decade cafe'); // short hex-only words survive
  });

  it('is total: null/undefined/numbers collapse to strings without throwing', () => {
    expect(stripIdentifiers(null)).toBe('');
    expect(stripIdentifiers(undefined)).toBe('');
    expect(stripIdentifiers(42)).toBe('42');
  });
});

// ── supervisorCheckInLine ─────────────────────────────────────────────────────

describe('supervisorCheckInLine (first line, marker-gated)', () => {
  it('reads a WAKE/SWEEP no-op marker as a quiet check-in', () => {
    expect(supervisorCheckInLine('WAKE: no-op — nothing moved since 14:00')).toMatch(/nothing that needed a hand/);
    expect(supervisorCheckInLine('**SWEEP: no-op** — all quiet')).toMatch(/nothing that needed a hand/);
  });

  it('reads ACTIONS TAKEN (and the receipt-count header shape) with the action lines sanitized', () => {
    const line = supervisorCheckInLine('ACTIONS TAKEN\n1. Steered lane-a to finish the SoR index (receipt sm_9f8e7d6c5b4a3210)\n2. Re-armed the eval schedule (sched 06c1030fabcdef)\n3. hidden third');
    expect(line).toMatch(/^The project supervisor stepped in: /);
    expect(line).toContain('Steered lane-a to finish the SoR index');
    expect(line).toContain('Re-armed the eval schedule');
    expect(line).not.toContain('hidden third');
    expect(line).not.toMatch(ID_RE);
    expect(line).not.toMatch(/receipt/i);
    expect(supervisorCheckInLine('Actions (2, with receipts):')).toBe('The project supervisor took action on its last check.');
  });

  // HARNESS-RECEIPTS review fix (2026-10-20): a note that was only the model's block now OPENS with the harness
  // record — tool names and 8-char ids never reach the owner's card; the executed calls are counted instead.
  it('a note opening with the HARNESS block is counted, never paraphrased', () => {
    const line = supervisorCheckInLine('ACTIONS TAKEN (harness):\n- send_chat_message → chat 9e39ec5c · receipt d24c4c9b\n- todo_update → todo 7c1e5b9f · receipt 5e6f7a8b');
    expect(line).toBe('The project supervisor took 2 actions on its last check.');
    expect(supervisorCheckInLine('ACTIONS TAKEN (harness):\n- send_chat_message → chat 9e39ec5c · receipt d24c4c9b')).toBe('The project supervisor took 1 action on its last check.');
    expect(supervisorCheckInLine('ACTIONS TAKEN (harness):')).toBe('The project supervisor took action on its last check.');
    expect(supervisorCheckInLine('WAKE: no-op (harness: 0 lane actions)')).toMatch(/nothing that needed a hand/);
  });

  it('ignores markerless narration entirely (never paraphrased)', () => {
    expect(supervisorCheckInLine('## Status\nlots of narration…\nACTIONS TAKEN\n- late marker')).toBeNull();
    expect(supervisorCheckInLine('')).toBeNull();
    expect(supervisorCheckInLine(null)).toBeNull();
  });
});

// ── Ticket 68742517 replay: harness provider-error envelopes never surface as
//    the project-pulse "supervisor check-in" line ─────────────────────────────

describe('check-in read excludes harness provider-error envelopes (ticket 68742517)', () => {
  // The exact mishap text: the harness's terminal fallback a provider-429 wake
  // persists UNDER THE WAKE'S MACHINE ORIGIN (harness-error-notes.ts shape).
  const FALLBACK_429 =
    "Sorry — I couldn't get an answer out this time: the AI provider rate-limited the request (HTTP 429). Try again in a few minutes.";

  it('skips a providerError-stamped newest note and reads the newest REAL note instead (marker lane)', async () => {
    wakeNotes = [
      { content: 'WAKE: no-op — dead wake', metadata: { origin: 'schedule', providerError: 'http_429' } },
      { content: 'ACTIONS TAKEN\n- Steered lane-a to finish the SoR index', metadata: { origin: 'hook' } },
    ];
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.doneSince).toContain('The project supervisor stepped in: Steered lane-a to finish the SoR index.');
    expect(r!.status.doneSince.some((l) => /dead wake/.test(l))).toBe(false);
  });

  it('replays the mishap: an UNMARKED 429 fallback envelope (shape-only) never surfaces as the check-in', async () => {
    // Rows persisted before the providerError marker existed (or by an
    // unmarked path) carry no marker — only the envelope shape catches them.
    wakeNotes = [
      { content: FALLBACK_429, metadata: { origin: 'schedule' } },
      { content: 'WAKE: no-op — nothing moved since 14:00', metadata: { origin: 'schedule' } },
    ];
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.doneSince).toContain('The project supervisor checked in and found nothing that needed a hand.');
    expect(r!.body).not.toContain("Sorry — I couldn't get an answer");
  });

  it('ALL candidates envelopes → no check-in line at all (platform error text is never the supervisor\'s voice)', async () => {
    wakeNotes = [
      { content: FALLBACK_429, metadata: { origin: 'schedule' } },
      { content: 'WAKE: no-op — dead wake', metadata: { origin: 'hook', providerError: 'http_429' } },
    ];
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.doneSince.some((l) => /supervisor (checked in|stepped in|took action)/.test(l))).toBe(false);
    expect(r!.body).not.toContain("Sorry — I couldn't get an answer");
  });

  it('the batch read keeps the origin + window filter, newest-first, bounded', async () => {
    await renderProjectStatus(P1, SINCE, { now: NOW });
    const call = mockPrisma.crossModelMessage.findMany.mock.calls.find((c: any[]) => c[0]?.where?.OR)?.[0];
    expect(call.where.chatId).toBe(SUP);
    expect(call.where.role).toBe('assistant');
    expect(call.where.createdAt.gte).toEqual(SINCE);
    expect(call.where.createdAt.lte).toEqual(NOW);
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
    expect(call.take).toBeGreaterThan(1);
  });
});

// ── renderProjectStatus ───────────────────────────────────────────────────────

describe('renderProjectStatus — deterministic, contract-shaped, plain language', () => {
  // Ticket a8d6e514: a todo note may now be a 2,000-char continuation ledger — the card's "Working on" line stays
  // bounded (title ≤60 + note ≤60), never the ledger.
  it('a8d6e514: a 2,000-char in-progress note renders clamped in "Working on"', async () => {
    todos = todos.map((t) => (t.id === 't1' ? { ...t, progressNote: `halfway through the index rebuild; ${'next firing carries the shard ledger forward; '.repeat(45)}`.slice(0, 2000) } : t));
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.workingOn).toHaveLength(1);
    const line = r!.status.workingOn[0];
    expect(line.startsWith('Rebuild the SoR index — halfway through the index rebuild')).toBe(true);
    expect(line.length).toBeLessThanOrEqual('Rebuild the SoR index — '.length + 60);
    expect(line.endsWith('…')).toBe(true);
  });

  it('derives the structured status from the ledger (goals, todos, lanes, hook events, owner items)', async () => {
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r).not.toBeNull();
    const { status } = r!;
    expect(status.projectName).toBe('CanLaw');
    expect(status.goals).toEqual({ active: 2, done: 0, blocked: 1 }); // archived goal ignored
    expect(status.todos).toEqual({ inProgress: 1, pending: 1, blocked: 1, doneSince: 1 }); // the 3h-old done todo is outside the window
    // 2026-09-24 split: lane-a RUNNING counts as working; lane-b (enabled schedule, no run) is scheduled; lane-c archived; supervisor excluded.
    expect(status.lanesRunning).toBe(1);
    expect(status.lanesScheduled).toBe(1);
    expect(status.ownerItems).toBe(1);
    expect(status.workingOn).toEqual(['Rebuild the SoR index — halfway']);
    expect(status.doneSince).toEqual([
      'Finished: Ship dataset v2', // "(commit deadbeef…)" stripped whole
      '2 work sessions finished',
      'The project supervisor checked in and found nothing that needed a hand.',
    ]);
    expect(status.blocked).toEqual([
      'Goal blocked: the SoR rebuild — waiting on your answer to an open question',
      'Todo blocked: Upload the eval set — waiting on other work to finish first',
      '1 question is waiting for your answer',
      '1 work session hit an error',
    ]);
    expect(status.next).toEqual(['Write the benchmark report']);
    // Exactly the SHARED CONTRACT keys — nothing extra rides into the frontend card
    // (timing joined the contract 2026-09-17: harness-measured, additive;
    // lanesScheduled 2026-09-24: running/scheduled split, additive).
    expect(Object.keys(status).sort()).toEqual(
      ['blocked', 'doneSince', 'goals', 'headline', 'lanesRunning', 'lanesScheduled', 'next', 'ownerItems', 'projectName', 'timing', 'todos', 'workingOn'],
    );
    expect(status.timing!.lanes[0]).toMatchObject({ chatId: LANE_A, state: 'running' });
    expect(typeof status.timing!.nextStatusAt).toBe('string');
  });

  // CanLaw stall 2026-09-15: both CanLaw HALT todos were blocked with reasons
  // CLAIMING an owner decision ("owner's HALT-band decision MADE") while ZERO
  // owner questions were open for them — the owner's replies on the cited cards
  // had been questions back. The card now renders such a row by what backs it.
  it('an owner-decision claim with NO open owner question renders as "paused by the team\'s own rule"; with an open gate it is "waiting on your answer"; the card never repeats the phantom ruling', async () => {
    goals = [];
    todos = [
      { id: 't1', title: 'Full SFT-2 training on GO', status: 'blocked', progressNote: null, blockKind: 'deps', gateQuestionId: null, blockedReason: "2026-09-14T05:04Z supervisor refresh: owner's HALT-band decision MADE — training stays stopped", updatedAt: NOW },
      { id: 't2', title: 'RL-1 matched-budget A/B', status: 'blocked', progressNote: null, blockKind: 'deps', gateQuestionId: null, blockedReason: "stays BLOCKED pending the owner's HALT-band decision (owner fork oq_d3be6db5-009b-4f6c-9b25-5831e6d3059d)", updatedAt: NOW },
      { id: 't3', title: 'Pick the serving engine', status: 'blocked', progressNote: null, blockKind: 'owner', gateQuestionId: 'oq_open1111-aaaa', blockedReason: 'Awaiting owner decision', updatedAt: NOW },
      { id: 't4', title: 'Rebuild the index', status: 'blocked', progressNote: null, blockKind: 'external', gateQuestionId: null, blockedReason: 'Provider connection dropped mid-run; needs restart', updatedAt: NOW },
      { id: 't5', title: 'Send the investor update', status: 'blocked', progressNote: null, blockKind: 'owner', gateQuestionId: 'oq_stop2222-bbbb', blockedReason: 'Awaiting owner decision', updatedAt: NOW },
    ];
    // oq_d3be6db5 is ANSWERED with a counter-question → no decision; oq_open1111 is open;
    // oq_stop2222 the owner answered with a real decision ("no, hold it").
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_open1111-aaaa', status: 'open', answer: null, chosenOption: null, answeredBy: null },
      { id: 'oq_d3be6db5-009b-4f6c-9b25-5831e6d3059d', status: 'answered', answer: "well didn't we change the benchmark a ton in between this?", chosenOption: null, answeredBy: 'owner' },
      { id: 'oq_stop2222-bbbb', status: 'answered', answer: 'no, hold it until the audit is done', chosenOption: null, answeredBy: 'owner' },
    ]);
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.blocked.slice(0, 5)).toEqual([
      "Todo blocked: Full SFT-2 training on GO — paused by the team's own rule (no owner decision is pending)",
      "Todo blocked: RL-1 matched-budget A/B — paused by the team's own rule (no owner decision is pending)",
      'Todo blocked: Pick the serving engine — waiting on your answer to an open question',
      'Todo blocked: Rebuild the index — blocked: Provider connection dropped mid-run; needs restart',
      'Todo blocked: Send the investor update — you already answered the question it cites; the team has to act on that answer',
    ]);
    expect(r!.body).not.toMatch(/HALT-band decision/);
    // The probe asked for exactly the ids the rows cite (gate ids + inline oq_ id), at ANY status.
    const call = mockPrisma.ownerQuestion.findMany.mock.calls.at(-1)[0];
    expect([...call.where.id.in].sort()).toEqual(['oq_d3be6db5-009b-4f6c-9b25-5831e6d3059d', 'oq_open1111-aaaa', 'oq_stop2222-bbbb']);
    expect(call.where.status).toBeUndefined();
  });

  it('headline is ONE sentence on where the project stands vs its goals', async () => {
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.headline).toBe('CanLaw: 2 of 3 goals active, 1 blocked on the SoR rebuild; 1 lane working, 1 scheduled; 1 item waiting on you');
    expect(r!.status.headline.split('\n')).toHaveLength(1);
  });

  // Owner 2026-09-24 ("Three work sessions are still running … but no active
  // work item" / "Lanes 3 running" while nothing ran): the card's timing.lanes
  // were all state:'scheduled' with zero running agent_runs, yet lanesRunning
  // counted every enabled schedule.
  it('scheduled-only lanes: lanesRunning 0 / lanesScheduled N, the headline says "N lanes scheduled, none running", and timing names the next wake instead of "no lane has reported a countable step"', async () => {
    runningRuns = [];
    schedules = [
      { sessionId: LANE_A, nextRunAt: new Date(NOW.getTime() + 40 * 60_000) },
      { sessionId: LANE_B, nextRunAt: new Date(NOW.getTime() + 25 * 60_000) },
      { sessionId: LANE_B, nextRunAt: new Date(NOW.getTime() + 90 * 60_000) },
      { sessionId: LANE_C, nextRunAt: new Date(NOW.getTime() + 5 * 60_000) }, // archived lane — never counted
    ];
    todos = todos.filter((t) => t.status !== 'in_progress');
    goals = goals.map((g) => ({ ...g, status: g.status === 'archived' ? g.status : 'done' }));
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.lanesRunning).toBe(0);
    expect(r!.status.lanesScheduled).toBe(2);
    expect(r!.status.headline).toBe('CanLaw: all 3 goals done; 2 lanes scheduled, none running; 1 item waiting on you');
    expect(r!.status.workingOn).toEqual([]); // nothing in flight — and the card does not pretend otherwise
    expect(r!.status.timing!.lanes.map((l) => l.state)).toEqual(['scheduled', 'scheduled']);
    expect(r!.status.timing!.noEstimateReason).toBe('Nothing is running right now — next wake 15:25Z.');
    expect(r!.body).not.toMatch(/countable step/);
  });

  it('a running lane with no board item shows up in "Working on" as "Running: <lane> (<age>m)" so the counters and the section never contradict; neither the age nor the run itself changes the no-change hash', async () => {
    chats = chats.map((c) => (c.id === LANE_A ? { ...c, title: 'Citator re-scrape (run 9f8e7d6c5b4a3210)' } : c));
    runningRuns = [{ sessionId: LANE_A, startedAt: new Date(NOW.getTime() - 42 * 60_000), heartbeatAt: new Date(NOW.getTime() - 60_000) }];
    schedules = [];
    todos = todos.filter((t) => t.status !== 'in_progress');
    goals = goals.map((g) => ({ ...g, status: g.status === 'archived' ? g.status : 'done' }));
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.lanesRunning).toBe(1);
    expect(r!.status.workingOn).toEqual(['Running: Citator re-scrape (42m)']);
    expect(r!.status.headline).toBe('CanLaw: all 3 goals done; 1 lane working; 1 item waiting on you');
    expect(r!.body).toContain('- Running: Citator re-scrape (42m)');
    expect(r!.status.timing!.noEstimateReason).toBe('No estimate yet — no lane has reported a countable step.');
    const later = await renderProjectStatus(P1, SINCE, { now: new Date(NOW.getTime() + 60 * 60_000) });
    expect(later!.status.workingOn).toEqual(['Running: Citator re-scrape (102m)']);
    expect(later!.hash).toBe(r!.hash); // the measured age is not a ledger change
    // Reviews C3/C4 (2026-09-24): the hash is the BOARD-derived "Working on" —
    // the synthesized entry never enters it (no regex on titles), and the run
    // finishing (lanesRunning 1 → 0, the headline moving with it) is not a
    // ledger change either.
    expect(hashProjectStatus({ ...r!.status, workingOn: [] })).toBe(r!.hash);
    expect(hashProjectStatus({ ...r!.status, workingOn: [], lanesRunning: 0, headline: 'CanLaw: all 3 goals done; no lanes working right now; 1 item waiting on you' })).toBe(r!.hash);
    runningRuns = [];
    const stopped = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(stopped!.status.lanesRunning).toBe(0);
    expect(stopped!.status.workingOn).toEqual([]);
    expect(stopped!.hash).toBe(r!.hash);
  });

  // Review C18 (2026-09-24): timing.lanes is capped at TIMING_MAX_LANES, but
  // the "Working on" fallback and the counter read the UNCAPPED running set —
  // eight running lanes list six and say "…and 2 more running".
  it('review C18: eight running lanes with no board item list six "Running:" entries plus "…and 2 more running" — the section and lanesRunning agree', async () => {
    const extra = Array.from({ length: 6 }, (_, i) => ({ id: `chat-lane-x${i}`, title: `Extra lane ${i + 1}`, isProjectSupervisor: false, archivedAt: null }));
    chats = [...chats.map((c) => (c.id === LANE_A ? { ...c, title: 'Citator re-scrape' } : c.id === LANE_B ? { ...c, title: 'Nightly eval' } : c)), ...extra];
    runningRuns = [
      { sessionId: LANE_A, startedAt: new Date(NOW.getTime() - 90 * 60_000) },
      { sessionId: LANE_B, startedAt: new Date(NOW.getTime() - 80 * 60_000) },
      ...extra.map((c, i) => ({ sessionId: c.id, startedAt: new Date(NOW.getTime() - (70 - i * 10) * 60_000) })),
    ];
    schedules = [];
    todos = todos.filter((t) => t.status !== 'in_progress');
    goals = goals.map((g) => ({ ...g, status: g.status === 'archived' ? g.status : 'done' }));
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.lanesRunning).toBe(8);
    expect(r!.status.timing!.lanes).toHaveLength(6);
    expect(r!.status.workingOn).toEqual([
      'Running: Citator re-scrape (90m)', 'Running: Nightly eval (80m)', 'Running: Extra lane 1 (70m)', 'Running: Extra lane 2 (60m)', 'Running: Extra lane 3 (50m)', 'Running: Extra lane 4 (40m)',
      '…and 2 more running',
    ]);
    expect(r!.status.headline).toBe('CanLaw: all 3 goals done; 8 lanes working; 1 item waiting on you');
    expect(hashProjectStatus({ ...r!.status, workingOn: [] })).toBe(r!.hash);
  });

  it('wording rules: no ids/SHAs/receipts/oq_ tokens anywhere in the body, ≤ 900 chars, the four sections present', async () => {
    const r = await renderProjectStatus(P1, SINCE, { now: NOW });
    const { body, status } = r!;
    expect(body).not.toMatch(ID_RE);
    expect(body).not.toMatch(/oq_|cf_/);
    expect(body).not.toMatch(/receipt/i);
    expect(body).not.toMatch(/\(msg\b/);
    expect(Array.from(body).length).toBeLessThanOrEqual(PROJECT_STATUS_BODY_MAX_CHARS);
    expect(body.startsWith(`**${status.headline}**`)).toBe(true);
    for (const h of ['**Working on**', '**Done in the last hour**', '**Blocked or needs you**', '**Next**']) expect(body).toContain(h);
    for (const list of [status.workingOn, status.doneSince, status.blocked, status.next]) {
      for (const item of list) {
        expect(item).not.toMatch(ID_RE);
        expect(item).not.toMatch(/oq_|receipt/i);
      }
    }
  });

  it('is deterministic: the same ledger renders the same body and hash (no LLM, no clock in the status)', async () => {
    const a = await renderProjectStatus(P1, SINCE, { now: NOW });
    const b = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(a!.body).toBe(b!.body);
    expect(a!.hash).toBe(b!.hash);
    expect(a!.status).toEqual(b!.status);
    // Hash is key-order independent (a reordered object hashes the same).
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(a!.status).reverse()))) as ProjectStatus;
    expect(hashProjectStatus(reordered)).toBe(a!.hash);
    // …and sensitive to real state change (ledger state — not the run counters, reviews C3/C4).
    expect(hashProjectStatus({ ...a!.status, ownerItems: 5 })).not.toBe(a!.hash);
    expect(hashProjectStatus({ ...a!.status, lanesRunning: 5, lanesScheduled: 0 })).toBe(a!.hash);
  });

  it('falls back to active goals for "Working on" when no todo is in flight; quiet projects say so', async () => {
    todos = todos.filter((t) => t.status !== 'in_progress');
    let r = await renderProjectStatus(P1, SINCE, { now: NOW });
    // "(run 9f8e…)" is stripped whole — the progress note reads plainly.
    expect(r!.status.workingOn).toEqual(['Train the Qwen legal model — 3 of 5 shards trained', 'Publish the benchmark']);

    goals = [];
    todos = [];
    runningRuns = [];
    schedules = [];
    hookEvents = [];
    openQuestions = 0;
    wakeNotes = [];
    r = await renderProjectStatus(P1, SINCE, { now: NOW });
    expect(r!.status.headline).toBe('CanLaw: no goals set yet; no lanes working right now');
    expect(r!.body).toContain('Nothing is in motion right now.');
  });

  it('headline variants: all goals done; multiple blocked goals count instead of naming; scheduled lanes are named apart from working ones', () => {
    expect(buildHeadline({ projectName: 'Spark', goals: { active: 0, done: 2, blocked: 0 }, lanesRunning: 1, ownerItems: 0 }))
      .toBe('Spark: all 2 goals done; 1 lane working');
    expect(buildHeadline({ projectName: 'Spark', goals: { active: 1, done: 1, blocked: 2 }, blockedGoalTitle: 'x', lanesRunning: 0, ownerItems: 2 }))
      .toBe('Spark: 1 of 4 goals active, 2 blocked, 1 done; no lanes working right now; 2 items waiting on you');
    // 2026-09-24: "working" is RUNNING only; scheduled-but-idle lanes are said so.
    expect(buildHeadline({ projectName: 'canlegal-bench', goals: { active: 0, done: 8, blocked: 0 }, lanesRunning: 0, lanesScheduled: 3, ownerItems: 0 }))
      .toBe('canlegal-bench: all 8 goals done; 3 lanes scheduled, none running');
    expect(buildHeadline({ projectName: 'Spark', goals: { active: 1, done: 0, blocked: 0 }, lanesRunning: 2, lanesScheduled: 1, ownerItems: 0 }))
      .toBe('Spark: 1 of 1 goal active; 2 lanes working, 1 scheduled');
    expect(buildHeadline({ projectName: 'Spark', goals: { active: 1, done: 0, blocked: 0 }, lanesRunning: 0, lanesScheduled: 0, ownerItems: 0 }))
      .toBe('Spark: 1 of 1 goal active; no lanes working right now');
  });

  // Ticket 4ab8c6e8 (mishap, 2026-09-15): the dashboard showed CanLaw "halted
  // waiting on owner" while ZERO owner questions were open — the blocked todo
  // below is the incident shape (the deliberate HALT-band training-spend stop,
  // a machine/program-rule block, not an owner ask). This test replays it.
  it('a machine block is never phrased as waiting on the owner: ownerItems 0 → "Blocked" section, no "needs you" / "waiting on you" anywhere (ticket 4ab8c6e8; owner confusion 2026-09-15)', () => {
    const status: ProjectStatus = {
      projectName: 'CanLaw',
      headline: buildHeadline({ projectName: 'CanLaw', goals: { active: 2, done: 3, blocked: 0 }, lanesRunning: 5, ownerItems: 0 }),
      workingOn: ['SFT-2 dataset rebuild — shards landing'],
      doneSince: [],
      blocked: ['Todo blocked: Full SFT-2 training on GO — blocked: owner HALT-band decision made, training stays stopped'],
      next: [],
      goals: { active: 2, done: 3, blocked: 0 }, todos: { inProgress: 1, pending: 0, blocked: 2, doneSince: 0 },
      lanesRunning: 5, ownerItems: 0,
    };
    const body = buildStatusBody(status);
    expect(body).toContain('**Blocked**');
    expect(body).not.toContain('needs you');
    expect(body).not.toMatch(/waiting on you|waiting on:/i);
    // …and with an open owner question the section owns the "needs you" title again.
    const withQuestion = { ...status, ownerItems: 1, blocked: [...status.blocked, '1 question is waiting for your answer'] };
    expect(buildStatusBody(withQuestion)).toContain('**Blocked or needs you**');
  });

  it('body shrinks items-per-section deterministically to stay within the 900-char budget', () => {
    const many = Array.from({ length: 12 }, (_, i) => `A fairly long todo title number ${i} that explains what it is about in detail`);
    const status: ProjectStatus = {
      projectName: 'Big', headline: 'Big: 12 of 12 goals active; 3 lanes working',
      workingOn: many, doneSince: many, blocked: many, next: many,
      goals: { active: 12, done: 0, blocked: 0 }, todos: { inProgress: 12, pending: 12, blocked: 12, doneSince: 12 },
      lanesRunning: 3, ownerItems: 0,
    };
    const body = buildStatusBody(status);
    expect(Array.from(body).length).toBeLessThanOrEqual(PROJECT_STATUS_BODY_MAX_CHARS);
    expect(body).toMatch(/…and \d+ more items/);
    expect(buildStatusBody(status)).toBe(body); // deterministic
  });

  it('returns null for an unknown project', async () => {
    expect(await renderProjectStatus('nope', SINCE, { now: NOW })).toBeNull();
  });
});

// ── emitProjectStatusUpdates ──────────────────────────────────────────────────

describe('emitProjectStatusUpdates — hourly, direct insert, gated, kill-switched', () => {
  // 2026-09-29: the hourly card + quiet stub are the OPT-IN mode now
  // (PROJECT_STATUS_HOURLY_ENABLED=1); the default change-only mode is pinned
  // in the describe at the end of this file.
  beforeEach(() => { process.env.PROJECT_STATUS_HOURLY_ENABLED = '1'; });
  afterEach(() => { delete process.env.PROJECT_STATUS_HOURLY_ENABLED; });
  // Review C2 (2026-09-24): every lane stamps its OWN read clock (`new Date()`
  // right before its ledger read) while the 60-min gate compares against the
  // sweep's `now`. Only Date is faked here — the mocked Prisma promises must
  // keep resolving on the real microtask queue.
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      now: NOW,
    });
  });
  afterEach(() => { jest.useRealTimers(); });
  /** A sweep at `t` with the wall clock reading `t` too (the ordinary case — the cron passes new Date()). */
  const sweepAt = (t: Date) => { jest.setSystemTime(t); return emitProjectStatusUpdates(t); };
  const updated = () => mockPrisma.crossModelMessage.update.mock.calls.map((c: any[]) => c[0]);
  const min = (n: number) => n * 60_000;

  it('discovers only ENABLED + scaffolded project supervisors', async () => {
    await sweepAt(NOW);
    const discovery = mockPrisma.crossModelChat.findMany.mock.calls.find((c: any[]) => c[0]?.where?.isProjectSupervisor === true)?.[0];
    expect(discovery.where).toMatchObject({ isProjectSupervisor: true, archivedAt: null, project: { projectSupervisorEnabled: true, archivedAt: null } });
  });

  it('first emission (no previous card): inserts the contract row directly with a freshly built brief, bumps the chat, records the metric', async () => {
    const res = await sweepAt(NOW);
    expect(res).toMatchObject({ scanned: 1, emitted: 1, unchanged: 0, gated: 0, failed: 0, disabled: false });

    const rows = created();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.chatId).toBe(SUP);
    expect(row.role).toBe('assistant');
    expect(row.metadata.origin).toBe(PROJECT_STATUS_ORIGIN);
    expect(row.metadata.kind).toBe(PROJECT_STATUS_ORIGIN);
    expect(row.metadata.generatedAt).toBe(NOW.toISOString());
    expect(row.metadata.since).toBe(new Date(NOW.getTime() - PROJECT_STATUS_INTERVAL_MS).toISOString());
    expect(row.metadata.unchanged).toBe(false);
    expect(typeof row.metadata.statusHash).toBe('string');
    expect(row.metadata.status.headline).toMatch(/^CanLaw: 2 of 3 goals active/);
    expect(row.content.startsWith(`**${row.metadata.status.headline}**`)).toBe(true);
    expect(row.content).not.toMatch(ID_RE);
    // The brief is built from the ask context the fingerprint read already loaded (review C21) — never read twice.
    expect(row.metadata.brief).toEqual(BRIEF_FIXTURE);
    expect(briefMod.computeAsksFingerprint).toHaveBeenCalledWith(SUP, NOW);
    expect(briefMod.buildProjectBrief).toHaveBeenCalledTimes(1);
    expect(briefMod.buildProjectBrief).toHaveBeenCalledWith(P1, expect.objectContaining({ projectName: 'CanLaw' }), { now: NOW, supervisorChatId: SUP, askContext: EMPTY_ASK_CONTEXT });

    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: SUP }, data: { updatedAt: NOW } });
  });

  it("review C2: each lane stamps its OWN read clock — generatedAt, since, timing, the chat bump and the fingerprint read follow it; only the 60-min gate reads the sweep's now", async () => {
    // The wall clock is 90 s past the sweep's `now` when this lane is read.
    const t = new Date(NOW.getTime() + 90_000);
    jest.setSystemTime(t);
    await emitProjectStatusUpdates(NOW);
    const row = created()[0];
    expect(row.metadata.generatedAt).toBe(t.toISOString());
    expect(row.metadata.since).toBe(new Date(t.getTime() - PROJECT_STATUS_INTERVAL_MS).toISOString());
    expect(row.metadata.status.timing.nextStatusAt).toBe(new Date(t.getTime() + PROJECT_STATUS_INTERVAL_MS).toISOString());
    expect(mockPrisma.hookEvent.findMany.mock.calls.at(-1)[0].where.createdAt.lte).toEqual(t);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: SUP }, data: { updatedAt: t } });
    expect(briefMod.computeAsksFingerprint).toHaveBeenCalledWith(SUP, t);
    expect(briefMod.buildProjectBrief.mock.calls[0][2]).toMatchObject({ now: t });

    // Two lanes: the clock moves 30 s during each render, so the second lane's
    // card is stamped 30 s after the first's — not with the sweep's start time.
    mockPrisma.crossModelMessage.create.mockClear();
    lanes = [{ id: SUP, projectId: P1, userId: OWNER }, { id: 'chat-sup-2', projectId: P1, userId: OWNER }];
    mockPrisma.crossModelProject.findUnique.mockImplementation(async (args: any) => {
      jest.setSystemTime(Date.now() + 30_000);
      return args?.where?.id === project?.id ? project : null;
    });
    await emitProjectStatusUpdates(NOW);
    const two = created();
    expect(two).toHaveLength(2);
    expect(Date.parse(two[1].metadata.generatedAt) - Date.parse(two[0].metadata.generatedAt)).toBe(30_000);

    // The gate: the previous check was 59 min before the sweep's `now` — gated,
    // even though the wall clock has since moved past the hour. (A quiet
    // ledger: a milestone change would post inside the hour — 2026-09-29.)
    hookEvents = [];
    todos = todos.filter((t) => t.status !== 'done');
    lanes = [{ id: SUP, projectId: P1, userId: OWNER }];
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { createdAt: new Date(NOW.getTime() - min(59)), metadata: { origin: PROJECT_STATUS_ORIGIN, statusHash: 'old', generatedAt: new Date(NOW.getTime() - min(59)).toISOString() } };
    jest.setSystemTime(new Date(NOW.getTime() + min(5)));
    expect(await emitProjectStatusUpdates(NOW)).toMatchObject({ gated: 1, emitted: 0 });
    expect(created()).toHaveLength(0);
    expect(await emitProjectStatusUpdates(new Date(NOW.getTime() + min(5)))).toMatchObject({ gated: 0, emitted: 1 });
  });

  it('60-min gate: a card younger than an hour suppresses the emission; an hour-old one lets it through with since = its createdAt', async () => {
    // Quiet ledger inside the hour (a milestone would post early — see the 2026-09-29 tests below).
    const savedEvents = hookEvents; const savedTodos = todos;
    hookEvents = [];
    todos = todos.filter((t) => t.status !== 'done');
    prevStatusRow = { createdAt: new Date(NOW.getTime() - 30 * 60_000), metadata: { origin: PROJECT_STATUS_ORIGIN, statusHash: 'old' } };
    let res = await sweepAt(NOW);
    expect(res).toMatchObject({ scanned: 1, emitted: 0, gated: 1 });
    expect(created()).toHaveLength(0);

    // A stub refreshed in place keeps its original createdAt — the gate reads
    // the last CHECK (metadata.generatedAt), not the row's age (2026-09-24).
    prevStatusRow = { id: 'msg-stub', createdAt: new Date(NOW.getTime() - 5 * 60 * 60_000), metadata: { origin: PROJECT_STATUS_ORIGIN, statusHash: 'old', unchanged: true, generatedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString() } };
    res = await sweepAt(NOW);
    expect(res).toMatchObject({ scanned: 1, emitted: 0, updatedInPlace: 0, gated: 1 });
    expect(created()).toHaveLength(0);
    hookEvents = savedEvents; todos = savedTodos;

    const prevAt = new Date(NOW.getTime() - 61 * 60_000);
    prevStatusRow = { createdAt: prevAt, metadata: { origin: PROJECT_STATUS_ORIGIN, statusHash: 'old' } };
    res = await sweepAt(NOW);
    expect(res).toMatchObject({ scanned: 1, emitted: 1, gated: 0, unchanged: 0 });
    expect(created()[0].metadata.since).toBe(prevAt.toISOString());
    expect(created()[0].metadata.unchanged).toBe(false);
    // The window is what the ledger scans use.
    const eventsWhere = mockPrisma.hookEvent.findMany.mock.calls.at(-1)[0].where;
    expect(eventsWhere.createdAt.gte).toEqual(prevAt);
  });

  it('caps the window at 24h when the previous card is very old (worker outage)', async () => {
    const prevAt = new Date(NOW.getTime() - 3 * 24 * 60 * 60_000);
    prevStatusRow = { createdAt: prevAt, metadata: { origin: PROJECT_STATUS_ORIGIN, statusHash: 'old' } };
    await sweepAt(NOW);
    expect(created()[0].metadata.since).toBe(new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString());
  });

  // Owner 2026-09-24: eight near-identical "no change in the last hour" cards
  // overnight (23 project_status rows in 24 h; six unchanged stubs 09:25Z→14:35Z
  // all carrying the identical 08:21Z brief). Now: ONE stub per quiet streak,
  // anchored at the last real card, refreshed in place every further quiet
  // hour without bumping the chat; the brief is COPIED forward, never rebuilt.
  it('no-change path: the FIRST quiet hour inserts ONE stub — "<project>: no change since <HH:MMZ>; N item(s) waiting on you" (quietSince = the last real card, quietChecks 1), empty sections, the UNDERLYING hash kept, the brief copied forward, chat bumped', async () => {
    // A todo finished 10 min before the previous card legitimately ages OUT of
    // the next window (Done in the last hour) — that IS a change. Drop the done
    // todos so the two renders see an identical ledger; the wake note + hook
    // events are window-filtered by the DB (the mock returns them regardless).
    todos = todos.filter((t) => t.status !== 'done');
    await sweepAt(NOW);
    const first = created()[0];
    const hash = first.metadata.statusHash;
    expect(first.metadata.status.todos.doneSince).toBe(0);
    expect(first.metadata.quietSince).toBeUndefined();
    expect(first.metadata.brief).toEqual(BRIEF_FIXTURE);

    mockPrisma.crossModelMessage.create.mockClear();
    mockPrisma.crossModelChat.update.mockClear();
    mockRecordLoopMetric.mockClear();
    briefMod.buildProjectBrief.mockClear();
    const later = new Date(NOW.getTime() + 61 * 60_000);
    prevStatusRow = { id: 'msg-real', createdAt: NOW, metadata: first.metadata };
    const res = await sweepAt(later);
    expect(res).toMatchObject({ scanned: 1, emitted: 1, unchanged: 1, updatedInPlace: 0 });

    const row = created()[0];
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    expect(row.metadata.unchanged).toBe(true);
    expect(row.metadata.statusHash).toBe(hash); // NOT the hash of the stub
    expect(row.metadata.quietSince).toBe(NOW.toISOString());
    expect(row.metadata.quietChecks).toBe(1);
    // The owner-question signal survives the stub (review C12): the compact
    // card renders no sections, so the headline keeps the "waiting on you" clause.
    expect(row.metadata.status.headline).toBe('CanLaw: no change since 15:00Z; 1 item waiting on you');
    expect(row.metadata.status.headline).toContain('no change'); // load-bearing phrase for downstream classifiers
    expect(row.metadata.status.ownerItems).toBe(1);
    expect(row.metadata.status.workingOn).toEqual([]);
    expect(row.metadata.status.doneSince).toEqual([]);
    expect(row.metadata.status.blocked).toEqual([]);
    expect(row.metadata.status.next).toEqual([]);
    // Counts survive so the card can still show the numbers.
    expect(row.metadata.status.goals).toEqual(first.metadata.status.goals);
    expect(row.metadata.status.lanesRunning).toBe(1);
    expect(row.metadata.status.lanesScheduled).toBe(1);
    expect(row.content).toBe('**CanLaw: no change since 15:00Z; 1 item waiting on you**');
    // A quiet stub COPIES the previous brief forward and never rebuilds it.
    expect(row.metadata.brief).toEqual(BRIEF_FIXTURE);
    expect(briefMod.buildProjectBrief).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: SUP }, data: { updatedAt: later } });

    // A real change afterwards breaks the no-change streak (a fresh row, no quiet fields, a rebuilt brief).
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-stub', createdAt: later, metadata: row.metadata };
    openQuestions = 3;
    await sweepAt(new Date(later.getTime() + 61 * 60_000));
    expect(created()[0].metadata.unchanged).toBe(false);
    expect(created()[0].metadata.quietSince).toBeUndefined();
    expect(created()[0].metadata.status.headline).toMatch(/3 items waiting on you$/);
    expect(briefMod.buildProjectBrief).toHaveBeenCalledTimes(1);
  });

  it('the SECOND quiet hour refreshes the stub IN PLACE: crossModelMessage.update on the stub id, NO create, chat.updatedAt NOT bumped, quietChecks 2, generatedAt/since/createdAt fresh (review C13), quietSince kept, brief copied', async () => {
    todos = todos.filter((t) => t.status !== 'done');
    await sweepAt(NOW);
    const real = created()[0];
    const t1 = new Date(NOW.getTime() + 61 * 60_000);
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-real', createdAt: NOW, metadata: real.metadata };
    await sweepAt(t1);
    const stub = created()[0];
    expect(stub.metadata.quietChecks).toBe(1);

    mockPrisma.crossModelMessage.create.mockClear();
    mockPrisma.crossModelMessage.update.mockClear();
    mockPrisma.crossModelChat.update.mockClear();
    mockRecordLoopMetric.mockClear();
    briefMod.buildProjectBrief.mockClear();
    const t2 = new Date(t1.getTime() + 62 * 60_000);
    prevStatusRow = { id: 'msg-stub', createdAt: t1, metadata: stub.metadata };
    const res = await sweepAt(t2);
    expect(res).toMatchObject({ scanned: 1, emitted: 0, unchanged: 1, updatedInPlace: 1, gated: 0, failed: 0 });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(briefMod.buildProjectBrief).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.update).toHaveBeenCalledTimes(1);
    const upd = updated()[0];
    expect(upd.where).toEqual({ id: 'msg-stub' });
    expect(upd.data.content).toBe('**CanLaw: no change since 15:00Z; 1 item waiting on you**');
    expect(upd.data.createdAt).toEqual(t2); // review C13: the stub moves to the chat tail
    expect(upd.data.metadata).toMatchObject({
      origin: PROJECT_STATUS_ORIGIN, kind: PROJECT_STATUS_ORIGIN, unchanged: true,
      statusHash: real.metadata.statusHash, quietSince: NOW.toISOString(), quietChecks: 2,
      generatedAt: t2.toISOString(), since: t1.toISOString(),
    });
    expect(upd.data.metadata.brief).toEqual(BRIEF_FIXTURE);
    expect(upd.data.metadata.status.headline).toBe('CanLaw: no change since 15:00Z; 1 item waiting on you');
    expect(upd.data.metadata.status.timing.nextStatusAt).toBe(new Date(t2.getTime() + PROJECT_STATUS_INTERVAL_MS).toISOString());

    // Third quiet hour: still the same row, quietChecks 3, quietSince unchanged, createdAt moved again.
    mockPrisma.crossModelMessage.update.mockClear();
    prevStatusRow = { id: 'msg-stub', createdAt: t2, metadata: upd.data.metadata };
    const t3 = new Date(t2.getTime() + 61 * 60_000);
    await sweepAt(t3);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(updated()[0].data.createdAt).toEqual(t3);
    expect(updated()[0].data.metadata).toMatchObject({ quietSince: NOW.toISOString(), quietChecks: 3, generatedAt: t3.toISOString() });
  });

  it('review C13: a refreshed stub sorts AFTER a message the owner typed between two refreshes — the (createdAt, id) order stays truthful', async () => {
    todos = todos.filter((t) => t.status !== 'done');
    await sweepAt(NOW);
    const real = created()[0];
    const t1 = new Date(NOW.getTime() + 61 * 60_000);
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-real', createdAt: NOW, metadata: real.metadata };
    await sweepAt(t1);
    const stub = created()[0];
    // The owner types 30 min after the stub landed; the next refresh comes an hour later.
    const ownerMsg = { id: 'msg-owner', createdAt: new Date(t1.getTime() + 30 * 60_000) };
    const t2 = new Date(t1.getTime() + 62 * 60_000);
    prevStatusRow = { id: 'msg-stub', createdAt: t1, metadata: stub.metadata };
    await sweepAt(t2);
    const upd = updated()[0];
    expect(upd.data.createdAt).toEqual(t2);
    const byCreatedAtThenId = (a: { id: string; createdAt: Date }, b: { id: string; createdAt: Date }) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1);
    expect([{ id: 'msg-stub', createdAt: upd.data.createdAt }, ownerMsg].sort(byCreatedAtThenId).map((r) => r.id)).toEqual(['msg-owner', 'msg-stub']);
    // …whereas the un-moved createdAt would have buried the refreshed stub behind the owner's newer message.
    expect([{ id: 'msg-stub', createdAt: t1 }, ownerMsg].sort(byCreatedAtThenId).map((r) => r.id)).toEqual(['msg-stub', 'msg-owner']);
  });

  it('review C5: a quiet streak of 20 h or more reads as a duration — "no change for 22 hours" / "for 3 days"; under 20 h the clock stays', async () => {
    todos = todos.filter((t) => t.status !== 'done');
    await sweepAt(NOW);
    const real = created()[0];
    const stubAt = (quietSince: Date, checked: Date, quietChecks: number) => ({
      id: 'msg-stub', createdAt: checked,
      metadata: { ...real.metadata, unchanged: true, quietSince: quietSince.toISOString(), quietChecks, generatedAt: checked.toISOString() },
    });
    // 19 h in — still "since 15:00Z".
    let t = new Date(NOW.getTime() + 19 * 60 * 60_000);
    prevStatusRow = stubAt(NOW, new Date(t.getTime() - 61 * 60_000), 18);
    await sweepAt(t);
    expect(updated().at(-1).data.content).toBe('**CanLaw: no change since 15:00Z; 1 item waiting on you**');
    // 22 h in.
    t = new Date(NOW.getTime() + 22 * 60 * 60_000 + 10 * 60_000);
    prevStatusRow = stubAt(NOW, new Date(t.getTime() - 61 * 60_000), 21);
    await sweepAt(t);
    expect(updated().at(-1).data.content).toBe('**CanLaw: no change for 22 hours; 1 item waiting on you**');
    expect(updated().at(-1).data.metadata.status.headline).toBe('CanLaw: no change for 22 hours; 1 item waiting on you');
    expect(updated().at(-1).data.metadata).toMatchObject({ unchanged: true, quietSince: NOW.toISOString(), quietChecks: 22 });
    // Three days in.
    t = new Date(NOW.getTime() + 3 * 24 * 60 * 60_000 + 5 * 60 * 60_000);
    prevStatusRow = stubAt(NOW, new Date(t.getTime() - 61 * 60_000), 76);
    await sweepAt(t);
    expect(updated().at(-1).data.content).toBe('**CanLaw: no change for 3 days; 1 item waiting on you**');
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1); // only the first real card was ever inserted
  });

  it('DESIGN DECISION: a changed set of asks is a real change — status unchanged + fingerprint moved ⇒ a REAL card with a rebuilt brief (from the already-loaded context); fingerprint equal ⇒ a stub that copies the brief forward; null or missing fingerprint ⇒ changed once', async () => {
    todos = todos.filter((t) => t.status !== 'done');
    await sweepAt(NOW);
    const real = created()[0];
    expect(real.metadata.brief.asksFingerprint).toBe('fp-1');
    const later = new Date(NOW.getTime() + 61 * 60_000);
    const later2 = new Date(later.getTime() + 61 * 60_000);

    // (a) The supervisor answered / the ledger closed: the fingerprint moved on an unchanged status.
    const movedCtx = { directives: [], asks: [{ id: 'm1', at: later, text: 'ship it', directive: null, reply: { id: 'r1', at: later, text: 'Shipped.' } }] };
    briefMod.computeAsksFingerprint.mockResolvedValue({ fingerprint: 'fp-2', context: movedCtx });
    briefMod.buildProjectBrief.mockResolvedValue({ ...BRIEF_FIXTURE, now: 'rebuilt', asksFingerprint: 'fp-2' });
    mockPrisma.crossModelMessage.create.mockClear();
    mockPrisma.crossModelChat.update.mockClear();
    briefMod.buildProjectBrief.mockClear();
    prevStatusRow = { id: 'msg-real', createdAt: NOW, metadata: real.metadata };
    let res = await sweepAt(later);
    expect(res).toMatchObject({ emitted: 1, unchanged: 0, updatedInPlace: 0 });
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    const card = created()[0];
    expect(card.metadata.unchanged).toBe(false);
    expect(card.metadata.quietSince).toBeUndefined();
    expect(card.metadata.statusHash).toBe(real.metadata.statusHash); // the status did not move — the asks did
    expect(card.metadata.status.headline).toMatch(/^CanLaw: 2 of 3 goals active/);
    expect(card.content).toContain('**Working on**'); // a FULL body, exactly like a status change
    expect(card.metadata.brief).toMatchObject({ now: 'rebuilt', asksFingerprint: 'fp-2' });
    expect(briefMod.buildProjectBrief).toHaveBeenCalledTimes(1);
    expect(briefMod.buildProjectBrief).toHaveBeenCalledWith(P1, expect.anything(), { now: later, supervisorChatId: SUP, askContext: movedCtx });
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: SUP }, data: { updatedAt: later } });

    // (b) Fingerprint equal on a quiet status → a stub; the brief rides along untouched; no build.
    briefMod.buildProjectBrief.mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-card', createdAt: later, metadata: card.metadata };
    res = await sweepAt(later2);
    expect(res).toMatchObject({ emitted: 1, unchanged: 1 });
    expect(created()[0].metadata.unchanged).toBe(true);
    expect(created()[0].metadata.brief).toEqual(card.metadata.brief);
    expect(briefMod.buildProjectBrief).not.toHaveBeenCalled();

    // (c) Unprovable (null) fingerprint → the asks read as changed → a real card, built without a preloaded context.
    briefMod.computeAsksFingerprint.mockResolvedValue(null);
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-card', createdAt: later, metadata: card.metadata };
    await sweepAt(later2);
    expect(created()[0].metadata.unchanged).toBe(false);
    expect(briefMod.buildProjectBrief).toHaveBeenCalledTimes(1);
    expect(briefMod.buildProjectBrief.mock.calls[0][2]).toEqual({ now: later2, supervisorChatId: SUP, askContext: undefined });

    // (d) A legacy previous brief without a fingerprint → changed ONCE: a real card that stores it, then stubs again.
    briefMod.computeAsksFingerprint.mockResolvedValue({ fingerprint: 'fp-2', context: movedCtx });
    briefMod.buildProjectBrief.mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-card', createdAt: later, metadata: { ...card.metadata, brief: { ...card.metadata.brief, asksFingerprint: undefined } } };
    await sweepAt(later2);
    const card2 = created()[0];
    expect(card2.metadata.unchanged).toBe(false);
    expect(briefMod.buildProjectBrief).toHaveBeenCalledTimes(1);
    briefMod.buildProjectBrief.mockClear();
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-card-2', createdAt: later2, metadata: card2.metadata };
    await sweepAt(new Date(later2.getTime() + 61 * 60_000));
    expect(created()[0].metadata.unchanged).toBe(true);
    expect(briefMod.buildProjectBrief).not.toHaveBeenCalled();
  });

  it('review C8: a brief that cannot be built (rejects or returns null) keeps the PREVIOUS brief on the real card; with no previous brief the card ships without one — never a brief from empty ledger inputs', async () => {
    todos = todos.filter((t) => t.status !== 'done');
    await sweepAt(NOW);
    const real = created()[0];
    const later = new Date(NOW.getTime() + 61 * 60_000);
    // The asks moved (a real card), but the brief's inputs are unreadable.
    briefMod.computeAsksFingerprint.mockResolvedValue(null);
    briefMod.buildProjectBrief.mockRejectedValueOnce(new Error('supervisor_states down'));
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-real', createdAt: NOW, metadata: real.metadata };
    expect(await sweepAt(later)).toMatchObject({ emitted: 1, failed: 0 });
    expect(created()[0].metadata.unchanged).toBe(false);
    expect(created()[0].metadata.brief).toEqual(BRIEF_FIXTURE); // the previous brief rides this card
    // A null build (inputs unreadable, per the brief service's contract) — the same.
    briefMod.buildProjectBrief.mockResolvedValueOnce(null);
    mockPrisma.crossModelMessage.create.mockClear();
    await sweepAt(later);
    expect(created()[0].metadata.brief).toEqual(BRIEF_FIXTURE);
    // No previous brief at all → the card ships without one.
    briefMod.buildProjectBrief.mockResolvedValueOnce(null);
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-real', createdAt: NOW, metadata: { ...real.metadata, brief: undefined } };
    await sweepAt(later);
    expect(created()[0].metadata.brief).toBeUndefined();
    expect(created()[0].content).not.toContain('In plain words');
  });

  it('review C3: a run finishing or a schedule firing between two quiet hours is NOT a change — the stub lands and its counters are fresh', async () => {
    todos = todos.filter((t) => t.status !== 'done');
    await sweepAt(NOW);
    const real = created()[0];
    expect(real.metadata.status.lanesRunning).toBe(1);
    expect(real.metadata.status.lanesScheduled).toBe(1);
    // lane-a's run finished; lane-b is still merely scheduled.
    runningRuns = [];
    const later = new Date(NOW.getTime() + 61 * 60_000);
    mockPrisma.crossModelMessage.create.mockClear();
    prevStatusRow = { id: 'msg-real', createdAt: NOW, metadata: real.metadata };
    await sweepAt(later);
    const stub = created()[0];
    expect(stub.metadata.unchanged).toBe(true);
    expect(stub.metadata.statusHash).toBe(real.metadata.statusHash);
    expect(stub.metadata.status.lanesRunning).toBe(0);
    expect(stub.metadata.status.lanesScheduled).toBe(1);
    expect(stub.metadata.status.headline).toBe('CanLaw: no change since 15:00Z; 1 item waiting on you');
  });

  it('noChangeStatus keeps counts and empties the sections; the owner clause survives; with quietSince the headline names the streak start, as a duration from 20 h (review C5), and without it the legacy wording', () => {
    const s: ProjectStatus = {
      projectName: 'CanLaw', headline: 'x', workingOn: ['a'], doneSince: ['b'], blocked: ['c'], next: ['d'],
      goals: { active: 1, done: 2, blocked: 3 }, todos: { inProgress: 1, pending: 2, blocked: 3, doneSince: 4 }, lanesRunning: 5, ownerItems: 6,
    };
    expect(noChangeStatus(s)).toEqual({
      ...s, headline: 'CanLaw: no change in the last hour; 6 items waiting on you', workingOn: [], doneSince: [], blocked: [], next: [],
    });
    expect(noChangeStatus({ ...s, ownerItems: 0 }).headline).toBe('CanLaw: no change in the last hour');
    expect(noChangeStatus(s, '2026-09-24T08:21:17.000Z').headline).toBe('CanLaw: no change since 08:21Z; 6 items waiting on you');
    expect(noChangeStatus({ ...s, ownerItems: 1 }, '2026-09-24T08:21:17.000Z', new Date('2026-09-25T04:20:00Z')).headline).toBe('CanLaw: no change since 08:21Z; 1 item waiting on you'); // 19 h 59 m — still a clock
    expect(noChangeStatus({ ...s, ownerItems: 0 }, '2026-09-24T08:21:17.000Z', new Date('2026-09-25T04:21:17Z')).headline).toBe('CanLaw: no change for 20 hours');
    expect(noChangeStatus({ ...s, ownerItems: 0 }, '2026-09-24T08:21:17.000Z', new Date('2026-09-25T06:40:00Z')).headline).toBe('CanLaw: no change for 22 hours');
    expect(noChangeStatus({ ...s, ownerItems: 0 }, '2026-09-24T08:21:17.000Z', new Date('2026-09-27T09:00:00Z')).headline).toBe('CanLaw: no change for 3 days');
    expect(quietDurationPhrase(47 * 3_600_000)).toBe('47 hours');
    expect(quietDurationPhrase(48 * 3_600_000)).toBe('2 days');
    expect(quietDurationPhrase(25 * 3_600_000)).toBe('25 hours');
    expect(noChangeStatus(s, 'garbage').headline).toBe('CanLaw: no change in the last hour; 6 items waiting on you');
  });

  it(`kill switch ${PROJECT_STATUS_DISABLED_ENV}=1: no reads, no writes`, async () => {
    process.env[PROJECT_STATUS_DISABLED_ENV] = '1';
    const res = await sweepAt(NOW);
    expect(res.disabled).toBe(true);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    expect(created()).toHaveLength(0);
    await runProjectStatusOnce();
    expect(created()).toHaveLength(0);
  });

  it('per-project isolation: one failing project never blocks the others', async () => {
    lanes = [{ id: 'chat-sup-broken', projectId: 'proj-broken', userId: OWNER }, { id: SUP, projectId: P1, userId: OWNER }];
    mockPrisma.crossModelProject.findUnique.mockImplementation((args: any) => {
      if (args?.where?.id === 'proj-broken') return Promise.reject(new Error('db hiccup'));
      return Promise.resolve(args?.where?.id === P1 ? project : null);
    });
    const res = await sweepAt(NOW);
    expect(res).toMatchObject({ scanned: 2, emitted: 1, failed: 1 });
    expect(created()).toHaveLength(1);
    expect(created()[0].chatId).toBe(SUP);
  });

  it('lane discovery failure is a quiet no-op (never throws into the cron loop)', async () => {
    mockPrisma.crossModelChat.findMany.mockImplementation((args: any) =>
      args?.where?.isProjectSupervisor === true ? Promise.reject(new Error('down')) : Promise.resolve([]),
    );
    await expect(runProjectStatusOnce()).resolves.toBeUndefined();
    expect(created()).toHaveLength(0);
  });

  it('writes ONLY via prisma.crossModelMessage.create — the service never touches sendChatMessage (no run, no hook wake)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'project-status.service.ts'), 'utf8');
    // Call sites / imports only — the header comment NAMES sendChatMessage to forbid it.
    expect(src).not.toMatch(/sendChatMessage\s*\(|startDetachedChatRun\s*\(|emitHookEvent\s*\(|from\s+['"][^'"]*(?:chat-agent|hooks\.service|platform-tools)/);
    expect(src).toMatch(/crossModelMessage\.create\(/);
  });
});

// ── getLatestProjectStatus (GET /projects/:id) ────────────────────────────────

describe('getLatestProjectStatus', () => {
  it('returns the newest card metadata scoped to the project supervisor chat', async () => {
    const status = { projectName: 'CanLaw', headline: 'CanLaw: h', workingOn: [], doneSince: [], blocked: [], next: [], goals: { active: 1, done: 0, blocked: 0 }, todos: { inProgress: 0, pending: 0, blocked: 0, doneSince: 0 }, lanesRunning: 0, ownerItems: 0 };
    latestForProject = {
      createdAt: NOW,
      metadata: { origin: PROJECT_STATUS_ORIGIN, kind: PROJECT_STATUS_ORIGIN, generatedAt: NOW.toISOString(), since: SINCE.toISOString(), status, statusHash: 'abc', unchanged: false },
    };
    const out = await getLatestProjectStatus(P1);
    expect(out).toEqual({ origin: PROJECT_STATUS_ORIGIN, kind: PROJECT_STATUS_ORIGIN, generatedAt: NOW.toISOString(), since: SINCE.toISOString(), status, statusHash: 'abc', unchanged: false });
    const where = mockPrisma.crossModelMessage.findFirst.mock.calls.at(-1)[0].where;
    expect(where).toMatchObject({ role: 'assistant', metadata: { path: ['origin'], equals: PROJECT_STATUS_ORIGIN }, chat: { projectId: P1, isProjectSupervisor: true } });
  });

  it('returns null when there is no card (or a malformed one)', async () => {
    latestForProject = null;
    expect(await getLatestProjectStatus(P1)).toBeNull();
    latestForProject = { createdAt: NOW, metadata: { origin: PROJECT_STATUS_ORIGIN } };
    expect(await getLatestProjectStatus(P1)).toBeNull();
  });

  it('passes the quiet-streak fields of a stub through (additive, 2026-09-24)', async () => {
    const status = { projectName: 'CanLaw', headline: 'CanLaw: no change since 08:21Z', workingOn: [], doneSince: [], blocked: [], next: [], goals: { active: 1, done: 0, blocked: 0 }, todos: { inProgress: 0, pending: 0, blocked: 0, doneSince: 0 }, lanesRunning: 0, lanesScheduled: 2, ownerItems: 0 };
    latestForProject = { createdAt: NOW, metadata: { origin: PROJECT_STATUS_ORIGIN, kind: PROJECT_STATUS_ORIGIN, generatedAt: NOW.toISOString(), since: SINCE.toISOString(), status, statusHash: 'abc', unchanged: true, quietSince: '2026-09-14T08:21:00.000Z', quietChecks: 4 } };
    expect(await getLatestProjectStatus(P1)).toMatchObject({ unchanged: true, quietSince: '2026-09-14T08:21:00.000Z', quietChecks: 4, status: { lanesScheduled: 2 } });
  });
});

// ── Timing (owner 2026-09-17: "what is going on / how much longer") ──────────
import {
  parseProgressFraction,
  estimateLaneEta,
  deriveProjectTiming,
  renderTimingLines,
  ETA_MIN_ELAPSED_MS,
  STALL_MIN_ELAPSED_MS,
  ETA_MAX_MINUTES,
} from './project-status.service';
import type { ProjectTiming } from './project-status.service';

describe('parseProgressFraction — the countable step a lane reported', () => {
  it('picks the most informative fraction, tolerates thousands separators, "N of M" and percentages', () => {
    expect(parseProgressFraction('1668/1687,191/219 DONE,28 py alive')).toEqual({ done: 1668, total: 1687 });
    expect(parseProgressFraction('sweep — 1,668 / 1,687 rows done')).toEqual({ done: 1668, total: 1687 });
    expect(parseProgressFraction('Step 5 of 12 steps complete')).toEqual({ done: 5, total: 12 });
    expect(parseProgressFraction('about 63% through the corpus')).toEqual({ done: 63, total: 100 });
  });

  it('does not read dates, versions, paths or over-full fractions as progress', () => {
    expect(parseProgressFraction('Monitor fire 3 on 9/17 at 19:0xZ')).toBeNull();
    expect(parseProgressFraction('bump to v1.2/3')).toBeNull();
    expect(parseProgressFraction('mix ratio 2/4 by volume')).toBeNull(); // small slash fraction with no progress word nearby
    expect(parseProgressFraction('finished 5/3 (over)')).toBeNull();
    expect(parseProgressFraction('')).toBeNull();
    expect(parseProgressFraction(null)).toBeNull();
  });

  it('a small slash fraction counts only with a progress word nearby', () => {
    expect(parseProgressFraction('3/4 steps done')).toEqual({ done: 3, total: 4 });
    expect(parseProgressFraction('meeting 3/4')).toBeNull();
  });

  it('a percentage counts only as progress, never as a threshold or a quality bar (first live card 2026-09-17)', () => {
    expect(parseProgressFraction('63% through the corpus')).toEqual({ done: 63, total: 100 });
    expect(parseProgressFraction('scrape 42% complete')).toEqual({ done: 42, total: 100 });
    expect(parseProgressFraction('S4.5 SPEED (owner bar 09-03 03:47Z; acceptable speed w/o significant quality loss <3%); read_wait 147.40@n192 <200')).toBeNull();
    expect(parseProgressFraction('quality loss ≤ 2% on the held-out set')).toBeNull();
    expect(parseProgressFraction('CI 95% interval 0.40–0.47')).toBeNull();
    expect(parseProgressFraction('a 12% lift in recall')).toBeNull(); // no progress word — a metric, not a count
    expect(parseProgressFraction('3 of 5 shards trained')).toEqual({ done: 3, total: 5 });
  });
});

describe('estimateLaneEta — two cards, one interval, a plain rate', () => {
  const cur = { done: 1668, total: 1687 };
  it('needs a previous fraction with the same total at least ETA_MIN_ELAPSED_MS ago', () => {
    expect(estimateLaneEta(cur, null, 3_600_000)).toEqual({});
    expect(estimateLaneEta(cur, { done: 1600, total: 1700 }, 3_600_000)).toEqual({});
    expect(estimateLaneEta(cur, { done: 1600, total: 1687 }, ETA_MIN_ELAPSED_MS - 1)).toEqual({});
  });
  it('extrapolates the remaining count at the observed pace, low confidence', () => {
    // 68 rows in 60 min → 19 remaining ≈ 17 min
    expect(estimateLaneEta(cur, { done: 1600, total: 1687 }, 3_600_000)).toEqual({ eta: { minutes: 17, basis: 'rate', confidence: 'low' } });
    expect(estimateLaneEta({ done: 1687, total: 1687 }, { done: 1600, total: 1687 }, 3_600_000)).toEqual({ eta: { minutes: 0, basis: 'rate', confidence: 'low' } });
  });
  it('a count that did not move for ≥ STALL_MIN_ELAPSED_MS reads as stalled; a glacial pace yields no estimate', () => {
    expect(estimateLaneEta(cur, cur, STALL_MIN_ELAPSED_MS)).toEqual({ stalled: true });
    expect(estimateLaneEta(cur, cur, ETA_MIN_ELAPSED_MS)).toEqual({});
    expect(estimateLaneEta({ done: 2, total: 100_000 }, { done: 1, total: 100_000 }, 3_600_000)).toEqual({}); // > ETA_MAX_MINUTES
    expect(ETA_MAX_MINUTES).toBe(7 * 24 * 60);
  });
});

describe('deriveProjectTiming — measured from ledger rows, never authored', () => {
  const now = new Date('2026-09-17T20:00:00.000Z');
  const since = new Date(now.getTime() - 3_600_000);
  const base = {
    now, since,
    laneChats: [{ id: 'lane-run', title: 'Citator re-scrape' }, { id: 'lane-sched', title: 'Nightly eval' }, { id: 'lane-idle', title: 'Idle' }],
    runningRuns: [{ sessionId: 'lane-run', startedAt: new Date(now.getTime() - 42 * 60_000), heartbeatAt: new Date(now.getTime() - 2 * 60_000) }],
    schedules: [{ sessionId: 'lane-sched', nextRunAt: new Date(now.getTime() + 25 * 60_000) }],
    supervisorSchedules: [{ nextRunAt: new Date(now.getTime() + 13 * 60_000) }],
    goals: [{ id: 'g1', title: 'Step 9 program', status: 'active' }, { id: 'g2', title: 'Done goal', status: 'done' }, { id: 'g3', title: 'No todos', status: 'active' }],
    todos: [
      { id: 't1', goalId: 'g1', title: 'Sweep sol citation_holding', status: 'in_progress', progressNote: '1668/1687,191/219 DONE', assigneeChatId: 'lane-run', updatedAt: now },
      { id: 't2', goalId: 'g1', title: 'Write report', status: 'done', progressNote: null, assigneeChatId: 'lane-run', updatedAt: new Date(now.getTime() - 10 * 60_000) },
      { id: 't3', goalId: 'g1', title: 'Old done', status: 'done', progressNote: null, assigneeChatId: null, updatedAt: new Date(now.getTime() - 5 * 3_600_000) },
      { id: 't4', goalId: 'g1', title: 'Dropped', status: 'dropped', progressNote: null, assigneeChatId: null, updatedAt: now },
    ],
    runCompletedAt: [new Date(now.getTime() - 30 * 60_000)],
  };

  // Ticket a8d6e514: a lane's progress is parsed from its note's LEAD (the first 200 chars) — a 2,000-char ledger tail
  // never feeds the card a stale count.
  it('a8d6e514: the lane fraction comes from the note lead; a fraction only in the ledger tail is ignored', () => {
    const lead = '191/219 DONE this cycle';
    const longNote = `${lead}${' '.repeat(200 - lead.length)} ledger: f12 1668/1687 rows done (old cycle).`;
    const withLong = { ...base, todos: [{ ...base.todos[0], progressNote: longNote }] };
    expect(deriveProjectTiming({ ...withLong, prev: null }).lanes[0].progress).toEqual({ done: 191, total: 219, label: 'Sweep sol citation_holding' });
    const tailOnly = { ...base, todos: [{ ...base.todos[0], progressNote: `${'x '.repeat(110)}1668/1687 rows done` }] };
    expect(deriveProjectTiming({ ...tailOnly, prev: null }).lanes[0].progress).toBeUndefined();
  });

  it('lists running lanes first with run age + last heartbeat, then scheduled lanes with their next wake; idle lanes are absent', () => {
    const t = deriveProjectTiming({ ...base, prev: null });
    expect(t.lanes.map((l) => l.chatId)).toEqual(['lane-run', 'lane-sched']);
    expect(t.lanes[0]).toMatchObject({ state: 'running', runningForMin: 42, lastActivityMin: 2, title: 'Citator re-scrape' });
    expect(t.lanes[0].progress).toEqual({ done: 1668, total: 1687, label: 'Sweep sol citation_holding' });
    expect(t.lanes[0].eta).toBeUndefined(); // first card — nothing to rate against
    expect(t.lanes[1]).toMatchObject({ state: 'scheduled', nextWakeAt: new Date(now.getTime() + 25 * 60_000).toISOString() });
    expect(t.goals).toEqual([{ id: 'g1', title: 'Step 9 program', status: 'active', done: 2, total: 3 }]); // dropped excluded, done goal + todo-less goal absent
    expect(t.closures).toEqual([new Date(now.getTime() - 30 * 60_000).toISOString(), new Date(now.getTime() - 10 * 60_000).toISOString()]); // window only, oldest first
    expect(t.nextCheckAt).toBe(new Date(now.getTime() + 13 * 60_000).toISOString());
    expect(t.nextStatusAt).toBe(new Date(now.getTime() + 3_600_000).toISOString());
    expect(t.noEstimateReason).toBe('Estimates appear once a lane has reported progress on two consecutive updates.');
  });

  it('with the previous card an hour back, the moved fraction yields a rate-based ETA and the reason line disappears', () => {
    const prev: ProjectTiming = { lanes: [{ chatId: 'lane-run', title: 'x', state: 'running', progress: { done: 1600, total: 1687, label: 'x' } }], goals: [], closures: [], nextStatusAt: now.toISOString() };
    const t = deriveProjectTiming({ ...base, prev: { generatedAt: since.toISOString(), timing: prev } });
    expect(t.lanes[0].eta).toEqual({ minutes: 17, basis: 'rate', confidence: 'low' });
    expect(t.noEstimateReason).toBeUndefined();
  });

  it('an unmoved fraction over 30+ minutes is flagged stalled with the matching reason; no lanes at all says nothing is running', () => {
    const prev: ProjectTiming = { lanes: [{ chatId: 'lane-run', title: 'x', state: 'running', progress: { done: 1668, total: 1687, label: 'x' } }], goals: [], closures: [], nextStatusAt: now.toISOString() };
    const t = deriveProjectTiming({ ...base, prev: { generatedAt: since.toISOString(), timing: prev } });
    expect(t.lanes[0].progress?.stalled).toBe(true);
    expect(t.noEstimateReason).toMatch(/have not moved/);
    const quiet = deriveProjectTiming({ ...base, runningRuns: [], schedules: [], prev: null });
    expect(quiet.lanes).toEqual([]);
    expect(quiet.noEstimateReason).toBe('No estimate — nothing is running right now.');
  });

  it('"no lane has reported a countable step" is claimed only while a lane is RUNNING; scheduled-only names the earliest next wake (owner 2026-09-24)', () => {
    const scheduledOnly = deriveProjectTiming({
      ...base, runningRuns: [], todos: [],
      schedules: [{ sessionId: 'lane-sched', nextRunAt: new Date(now.getTime() + 25 * 60_000) }, { sessionId: 'lane-idle', nextRunAt: new Date(now.getTime() + 12 * 60_000) }],
      prev: null,
    });
    expect(scheduledOnly.lanes.map((l) => l.state)).toEqual(['scheduled', 'scheduled']);
    expect(scheduledOnly.noEstimateReason).toBe('Nothing is running right now — next wake 20:12Z.');
    const runningNoCount = deriveProjectTiming({ ...base, todos: [], prev: null });
    expect(runningNoCount.lanes[0].state).toBe('running');
    expect(runningNoCount.noEstimateReason).toBe('No estimate yet — no lane has reported a countable step.');
  });

  it('the timing block never changes the no-change hash', () => {
    const a: ProjectStatus = {
      projectName: 'P', headline: 'h', workingOn: [], doneSince: [], blocked: [], next: [],
      goals: { active: 1, done: 0, blocked: 0 }, todos: { inProgress: 1, pending: 0, blocked: 0, doneSince: 0 }, lanesRunning: 1, ownerItems: 0,
      timing: deriveProjectTiming({ ...base, prev: null }),
    };
    const b: ProjectStatus = { ...a, timing: deriveProjectTiming({ ...base, now: new Date(now.getTime() + 3_600_000), prev: null }) };
    expect(hashProjectStatus(a)).toBe(hashProjectStatus(b));
    const { timing: _t, ...bare } = a;
    expect(hashProjectStatus(bare as ProjectStatus)).toBe(hashProjectStatus(a));
  });

  it('per-lane PRs 24h (docs-only / code) ride the timing line from the open_pull_request receipts (tt-rd audit 2026-09-27)', () => {
    const t = deriveProjectTiming({
      ...base,
      prReceipts: [
        { sessionId: 'lane-run', filesOnlyMd: true }, { sessionId: 'lane-run', filesOnlyMd: true }, { sessionId: 'lane-run', filesOnlyMd: false },
        { sessionId: 'lane-sched', filesOnlyMd: true },
        { sessionId: 'not-a-lane', filesOnlyMd: true },
      ],
    });
    expect(t.lanes.find((l) => l.chatId === 'lane-run')?.prs24h).toEqual({ docsOnly: 2, code: 1 });
    expect(t.lanes.find((l) => l.chatId === 'lane-sched')?.prs24h).toEqual({ docsOnly: 1, code: 0 });
    const lines = renderTimingLines(t, now);
    expect(lines[0]).toContain('· PRs 24h: 2 docs-only / 1 code');
    expect(lines[1]).toContain('· PRs 24h: 1 docs-only / 0 code');
    // no receipts → no PR bit (unchanged line shape)
    expect(renderTimingLines(deriveProjectTiming(base), now)[0]).not.toContain('PRs 24h');
  });

  it('state-only PRs (.digby/** only) are neither docs-only nor code on the timing line (fixer 2026-09-27, finding 2)', () => {
    const t = deriveProjectTiming({
      ...base,
      prReceipts: [
        { sessionId: 'lane-run', filesOnlyMd: false, filesOnlyState: true },
        { sessionId: 'lane-run', filesOnlyMd: true },
        { sessionId: 'lane-sched', filesOnlyMd: false, filesOnlyState: true },
      ],
    });
    expect(t.lanes.find((l) => l.chatId === 'lane-run')?.prs24h).toEqual({ docsOnly: 1, code: 0 });
    expect(t.lanes.find((l) => l.chatId === 'lane-sched')?.prs24h).toBeUndefined();
  });

  it('RECORD-KEEPER is keyed on the ledger: ≥2 docs-only PRs, no code PR AND no premise registered in 24h — a premise the lane set, or one set on a goal whose todo it owns, clears it (fixer 2026-09-27, finding 3)', () => {
    const docsOnly = [{ sessionId: 'lane-run', filesOnlyMd: true }, { sessionId: 'lane-run', filesOnlyMd: true }];
    const flagged = deriveProjectTiming({ ...base, prReceipts: docsOnly });
    expect(flagged.lanes[0]).toMatchObject({ chatId: 'lane-run', recordKeeper: true });
    expect(flagged.lanes[0].premises24h).toBeUndefined();
    const line = renderTimingLines(flagged, now)[0];
    expect(line).toContain('· PRs 24h: 2 docs-only / 0 code · RECORD-KEEPER: docs-only PRs only and no premise registered in 24h');
    expect(line).toContain('goal_premise_set');

    // a premise the lane itself registered inside the window (on any goal) → premises24h, no flag
    const setByLane = { key: 'client_tok_s', value: 5.08, unit: ' tok/s', setByChatId: 'lane-run', setAt: new Date(now.getTime() - 3_600_000).toISOString() };
    const byLane = deriveProjectTiming({ ...base, prReceipts: docsOnly, goals: [...base.goals.slice(0, 2), { id: 'g3', title: 'No todos', status: 'active', premises: [setByLane] }] });
    expect(byLane.lanes[0]).toMatchObject({ premises24h: 1 });
    expect(byLane.lanes[0].recordKeeper).toBeUndefined();
    expect(renderTimingLines(byLane, now)[0]).toContain('· premises registered 24h: 1');
    expect(renderTimingLines(byLane, now)[0]).not.toContain('RECORD-KEEPER');

    // a premise the SUPERVISOR registered on the goal whose todo the lane owns (g1 ← t1) → credited to the lane
    const bySupervisor = { key: 'k', value: 1, setByChatId: 'sup-1', setAt: new Date(now.getTime() - 60_000).toISOString() };
    const viaGoal = deriveProjectTiming({ ...base, prReceipts: docsOnly, goals: [{ id: 'g1', title: 'Step 9 program', status: 'active', premises: [bySupervisor] }, ...base.goals.slice(1)] });
    expect(viaGoal.lanes[0]).toMatchObject({ premises24h: 1 });
    expect(viaGoal.lanes[0].recordKeeper).toBeUndefined();
    // …but the same premise on a goal with no todo of the lane's, set by someone else, credits nothing
    const unrelated = deriveProjectTiming({ ...base, prReceipts: docsOnly, goals: [...base.goals.slice(0, 2), { id: 'g3', title: 'No todos', status: 'active', premises: [bySupervisor] }] });
    expect(unrelated.lanes[0]).toMatchObject({ recordKeeper: true });

    // a premise older than the window, a future-dated one, or a junk row does not count
    const stale = { ...setByLane, setAt: new Date(now.getTime() - 30 * 3_600_000).toISOString() };
    const future = { ...setByLane, setAt: new Date(now.getTime() + 3_600_000).toISOString() };
    const junk = deriveProjectTiming({ ...base, prReceipts: docsOnly, goals: [{ id: 'g1', title: 'Step 9 program', status: 'active', premises: [stale, future, null, 'x', { key: 'no-setAt', value: 2 }] }] });
    expect(junk.lanes[0]).toMatchObject({ recordKeeper: true });
    expect(junk.lanes[0].premises24h).toBeUndefined();

    // one docs-only PR alone is not a record-keeper; a code PR clears it
    expect(deriveProjectTiming({ ...base, prReceipts: [{ sessionId: 'lane-run', filesOnlyMd: true }] }).lanes[0].recordKeeper).toBeUndefined();
    expect(deriveProjectTiming({ ...base, prReceipts: [...docsOnly, { sessionId: 'lane-run', filesOnlyMd: false }] }).lanes[0].recordKeeper).toBeUndefined();
  });

  it('renderTimingLines speaks in measured facts with id8 handles and the harness caveat on estimates', () => {
    const prev: ProjectTiming = { lanes: [{ chatId: 'lane-run', title: 'x', state: 'running', progress: { done: 1600, total: 1687, label: 'x' } }], goals: [], closures: [], nextStatusAt: now.toISOString() };
    const lines = renderTimingLines(deriveProjectTiming({ ...base, prev: { generatedAt: since.toISOString(), timing: prev } }), now);
    expect(lines[0]).toContain('lane lane-run "Citator re-scrape": running 42m · last activity 2m ago · progress 1668/1687 (99%) on "Sweep sol citation_holding" · ≈17 min at this pace (low confidence, harness-measured)');
    expect(lines[1]).toContain('next wake 20:25Z (in 25m)');
    expect(lines[2]).toBe('- goal g1 "Step 9 program": 2/3 todos done');
    expect(lines[3]).toBe('- supervisor next check 20:13Z (in 13m) · next status card ~21:00Z · 2 closures in the window');
  });
});


// ── KPI of record on the owner card (tt-rd audit 2026-09-27, finding 4) ──────
describe('status card — KPI of record row (kpi-honesty-loops finding 4)', () => {
  const KPI_PREMISE = { key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', kind: 'kpi', bar: 10, receiptId: 'f5b42fe6-1111-4000-8000-000000000000', setAt: '2026-09-14T13:00:00.000Z' };

  it('renderProjectStatus composes the KPI row from the register (never a progress note) with receipt, age, bar and the ladder counter; the hash ignores the clocks', async () => {
    goals[0].premises = [{ key: 'host_tail', value: 12 }, KPI_PREMISE];
    mockLoadAdoptionLadders.mockResolvedValueOnce(new Map([['g1', { experiments: 27, hours: 150.4 }]]));
    const r = (await renderProjectStatus(P1, SINCE, { now: NOW }))!;
    expect(r.status.kpi).toEqual(expect.objectContaining({ goalId: 'g1', key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', bar: 10, receiptId: 'f5b42fe6-1111-4000-8000-000000000000', ageMin: 120, experimentsSinceMove: 27, hoursSinceMove: 150.4 }));
    expect(r.body).toContain('**KPI of record**\n- KPI of record — client visible e2e tok s: 5.08 tok/s — receipt f5b42fe6, 2h ago — bar ≥10 · unchanged for 6d (27 work sessions since the last move)');
    // the hash: value/receipt are ledger state, age + counters are clocks
    const h1 = hashProjectStatus(r.status);
    expect(hashProjectStatus({ ...r.status, kpi: { ...r.status.kpi!, ageMin: 500, experimentsSinceMove: 40, hoursSinceMove: 200 } })).toBe(h1);
    expect(hashProjectStatus({ ...r.status, kpi: { ...r.status.kpi!, value: 6.02 } })).not.toBe(h1);
    expect(hashProjectStatus({ ...r.status, kpi: undefined })).not.toBe(h1);
  });

  it('no kpi: premise ⇒ no row', async () => {
    const r0 = (await renderProjectStatus(P1, SINCE, { now: NOW }))!;
    expect(r0.status.kpi).toBeUndefined();
    expect(r0.body).not.toContain('KPI of record');
  });

  it('buildStatusBody renders the row from a status object alone (frontend contract: additive field)', () => {
    const status: ProjectStatus = {
      projectName: 'tt-rd', headline: 'tt-rd: 1 goal active', workingOn: [], doneSince: [], blocked: [], next: [],
      goals: { active: 1, done: 0, blocked: 0 }, todos: { inProgress: 0, pending: 0, blocked: 0, doneSince: 0 }, lanesRunning: 0, ownerItems: 0,
      kpi: { goalId: 'g1', key: 'kpi:e2e', value: 5.08, unit: 'tok/s', bar: 10, receiptId: 'f5b42fe6', setAt: '2026-09-27T13:22:15Z', ageMin: 120 },
    };
    const body = buildStatusBody(status);
    expect(body).toContain('**KPI of record**\n- KPI of record — e2e: 5.08 tok/s — receipt f5b42fe6, 2h ago — bar ≥10');
  });

  // ── Ticket c4ee677f (review finding 1): the projection must carry the
  // declared barDirection + history through to the card — kpiBarText reads
  // them, so a ceiling KPI (latency ≤500 ms) otherwise printed "bar ≥500".
  it('declared ceiling KPI projects barDirection + history; the card prints the ≤ symbol; direction + first history value are hashed as ledger state', async () => {
    goals[0].premises = [{
      key: 'kpi:live_advice_latency_ms', value: 83.6, unit: 'ms', kind: 'kpi', bar: 500,
      barDirection: 'down', receiptId: '5136aeff-1234-4000-8000-000000000000', setAt: '2026-09-14T13:00:00.000Z',
      history: [{ value: 18, setAt: '2026-09-14T12:00:00.000Z' }, { value: 83.6, setAt: '2026-09-14T13:00:00.000Z' }],
    }];
    const r = (await renderProjectStatus(P1, SINCE, { now: NOW }))!;
    expect(r.status.kpi).toEqual(expect.objectContaining({
      key: 'kpi:live_advice_latency_ms', value: 83.6, bar: 500, barDirection: 'down',
      history: [{ value: 18, setAt: '2026-09-14T12:00:00.000Z' }, { value: 83.6, setAt: '2026-09-14T13:00:00.000Z' }],
    }));
    expect(r.body).toContain('bar ≤500');
    expect(r.body).not.toContain('bar ≥500');
    // ledger state: flipping the direction or the first (inference) history value re-renders;
    // a later stamp's timestamp is a clock and does not.
    const h1 = hashProjectStatus(r.status);
    expect(hashProjectStatus({ ...r.status, kpi: { ...r.status.kpi!, barDirection: 'up' } })).not.toBe(h1);
    expect(hashProjectStatus({ ...r.status, kpi: { ...r.status.kpi!, history: [{ value: 520, setAt: '2026-09-14T12:00:00.000Z' }, { value: 83.6, setAt: '2026-09-14T13:00:00.000Z' }] } })).not.toBe(h1);
    expect(hashProjectStatus({ ...r.status, kpi: { ...r.status.kpi!, history: [{ value: 18 }, { value: 83.6, setAt: '2026-09-14T14:00:00.000Z' }] } })).toBe(h1);
  });

  it('undeclared direction infers from the first history value on the card (started above its ceiling ⇒ ≤); barDirection itself is not projected', async () => {
    // Inference rule (kpiBarDirection): bar >= firstValue ⇒ 'up' (counts up to
    // the bar), else 'down' — so a latency KPI whose FIRST reading was above
    // its ceiling correctly renders ≤; one that started healthy (below the
    // bar) still mis-infers ⇒ declare barDirection at registration.
    goals[0].premises = [{ key: 'kpi:p95_ms', value: 83.6, unit: 'ms', kind: 'kpi', bar: 500, setAt: '2026-09-14T13:00:00.000Z', history: [{ value: 900, setAt: '2026-09-14T12:00:00.000Z' }] }];
    const r = (await renderProjectStatus(P1, SINCE, { now: NOW }))!;
    expect(r.status.kpi).not.toHaveProperty('barDirection');
    expect(r.status.kpi).toEqual(expect.objectContaining({ history: [{ value: 900, setAt: '2026-09-14T12:00:00.000Z' }] }));
    expect(r.body).toContain('bar ≤500');
  });

  it('counts-up KPI (first registered value below the bar) keeps the floor symbol — inference regression pin', async () => {
    goals[0].premises = [{ key: 'kpi:tok_s', value: 5.08, unit: 'tok/s', kind: 'kpi', bar: 10, setAt: '2026-09-14T13:00:00.000Z', history: [{ value: 5, setAt: '2026-09-14T12:00:00.000Z' }] }];
    const r = (await renderProjectStatus(P1, SINCE, { now: NOW }))!;
    expect(r.body).toContain('bar ≥10');
  });
});


// ── Owner 2026-09-29: change-only cards ("the project supervisor should
// always update the user with a message when something changes or progress is
// made or a new session related or subsession finishes"; "doesnt the sweep
// just cause too much noise? … operate off hooks") ──────────────────────────
describe('emitProjectStatusUpdates — change-only (default): a card only on a milestone', () => {
  const min = (n: number) => n * 60_000;
  // The lane stamps its own wall clock (review C2) — pin it to the fixture's NOW.
  beforeEach(() => {
    jest.useFakeTimers({
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      now: NOW,
    });
  });
  afterEach(() => { jest.useRealTimers(); });
  const sweepAt = (t: Date) => { jest.setSystemTime(t); return emitProjectStatusUpdates(t); };
  const quiet = () => { hookEvents = []; todos = todos.filter((t) => t.status !== 'done'); };
  const prevAt = (ago: number, extra: Record<string, unknown> = {}) => ({
    id: 'msg-prev', createdAt: new Date(NOW.getTime() - min(ago)),
    metadata: { origin: PROJECT_STATUS_ORIGIN, statusHash: 'old', generatedAt: new Date(NOW.getTime() - min(ago)).toISOString(), ...extra },
  });

  it('a quiet project gets NOTHING — no hourly card, no "no change" stub, not even after 5 hours', async () => {
    quiet();
    for (const ago of [20, 61, 300]) {
      prevStatusRow = prevAt(ago);
      const res = await sweepAt(NOW);
      expect(res).toMatchObject({ emitted: 0, updatedInPlace: 0, gated: 1 });
    }
    expect(created()).toHaveLength(0);
    expect(mockPrisma.crossModelMessage.update).not.toHaveBeenCalled();
    expect(briefMod.buildProjectBrief).not.toHaveBeenCalled();
  });

  it('the first card of a project always lands', async () => {
    quiet();
    prevStatusRow = null;
    expect(await sweepAt(NOW)).toMatchObject({ emitted: 1 });
  });

  const finishedChildFixture = () => {
    quiet();
    runningRuns = [];
    schedules = [];
    chats = [...chats, { id: 'chat-child', title: 'Bank v3 results', isProjectSupervisor: false, archivedAt: null, createdAt: new Date(NOW.getTime() - min(90)) }];
    const finishedAt = new Date(NOW.getTime() - min(5));
    mockPrisma.agentRun.findMany.mockImplementation((args: any) => {
      if (args?.where?.status === 'completed') return Promise.resolve([{ sessionId: 'chat-child', status: 'completed', finishedAt }]);
      return Promise.resolve([]);
    });
    mockPrisma.crossModelMessage.findMany.mockImplementation((args: any) => {
      if (args?.where?.OR) return Promise.resolve(wakeNotes);
      if (args?.where?.chatId?.in?.includes('chat-child')) return Promise.resolve([{ chatId: 'chat-child', content: '**Banked 66 of 89 results under results/v3.** Details follow.\n[claims]' }]);
      return Promise.resolve([]);
    });
    prevStatusRow = prevAt(20, { brief: { ...BRIEF_FIXTURE, generatedAt: new Date(NOW.getTime() - min(20)).toISOString() } });
  };

  // audit 2026-10-06 T8-2 (stanne #11): the milestone post never reuses the pre-milestone brief.
  it('a sub-session that FINISHED for good (completed run, nothing running, no schedule) posts a card naming it with its gist; the 20-minute-old brief predates the milestone and is REBUILT', async () => {
    finishedChildFixture();
    const res = await sweepAt(NOW);
    expect(res).toMatchObject({ emitted: 1, changePosts: 1, gated: 0 });
    const row = created()[0];
    expect(row.metadata.update.milestone).toBe(true);
    expect(row.metadata.update.changes).toContain('Session finished: Bank v3 results — Banked 66 of 89 results under results/v3.');
    expect(briefMod.buildProjectBrief).toHaveBeenCalledTimes(1);
  });

  it('PROJECT_STATUS_MILESTONE_BRIEF_REBUILD_DISABLED=1: the fresh brief rides the milestone card with no model call (previous behaviour)', async () => {
    process.env.PROJECT_STATUS_MILESTONE_BRIEF_REBUILD_DISABLED = '1';
    try {
      finishedChildFixture();
      const res = await sweepAt(NOW);
      expect(res).toMatchObject({ emitted: 1, changePosts: 1, gated: 0 });
      const row = created()[0];
      expect(row.metadata.brief.mission).toBe(BRIEF_FIXTURE.mission);
      expect(briefMod.buildProjectBrief).not.toHaveBeenCalled();
    } finally {
      delete process.env.PROJECT_STATUS_MILESTONE_BRIEF_REBUILD_DISABLED;
    }
  });

  it('a brief older than an hour is rebuilt on the milestone card', async () => {
    quiet();
    hookEvents = [{ eventType: 'run_failed', createdAt: new Date(NOW.getTime() - min(2)) }];
    prevStatusRow = prevAt(90, { brief: { ...BRIEF_FIXTURE, generatedAt: new Date(NOW.getTime() - min(90)).toISOString() } });
    expect(await sweepAt(NOW)).toMatchObject({ emitted: 1, changePosts: 1 });
    expect(briefMod.buildProjectBrief).toHaveBeenCalledTimes(1);
  });

  it('a scheduled lane\'s routine firing is NOT a finish, and a new session is a change', async () => {
    quiet();
    runningRuns = [];
    schedules = [{ sessionId: LANE_B, nextRunAt: new Date(NOW.getTime() + min(30)) }];
    chats = [...chats, { id: 'chat-new', title: 'Rerun the failures', isProjectSupervisor: false, archivedAt: null, createdAt: new Date(NOW.getTime() - min(3)) }];
    mockPrisma.agentRun.findMany.mockImplementation((args: any) => (args?.where?.status === 'completed'
      ? Promise.resolve([{ sessionId: LANE_B, status: 'completed', finishedAt: new Date(NOW.getTime() - min(4)) }])
      : Promise.resolve([])));
    prevStatusRow = prevAt(15);
    await sweepAt(NOW);
    const changes: string[] = created()[0].metadata.update.changes;
    expect(changes).toContain('New session started: Rerun the failures');
    expect(changes.join(' ')).not.toMatch(/Session finished/);
  });

  it('a count ticking up writes nothing; crossing a quarter mark posts; spacing gates; the event path allows 1 min', async () => {
    quiet();
    goals = goals.map((g) => (g.id === 'g1' ? { ...g, progressNote: '63 of 100 shards trained' } : g));
    prevStatusRow = prevAt(20, { update: { progress: { done: 61, total: 100 } } });
    expect(await sweepAt(NOW)).toMatchObject({ emitted: 0, gated: 1 });
    goals = goals.map((g) => (g.id === 'g1' ? { ...g, progressNote: '76 of 100 shards trained' } : g));
    expect(await sweepAt(NOW)).toMatchObject({ emitted: 1, changePosts: 1 });

    hookEvents = [{ eventType: 'run_failed', createdAt: new Date(NOW.getTime() - min(1)) }];
    prevStatusRow = prevAt(3);
    expect(await sweepAt(NOW)).toMatchObject({ emitted: 0, gated: 1 });
    expect(await emitProjectStatusUpdates(NOW, { chatIds: [SUP], minChangeSpacingMs: PROJECT_STATUS_EVENT_MIN_MS })).toMatchObject({ emitted: 1 });
  });

  it('the event trigger: only milestone-carrying event types, debounced per chat', () => {
    jest.useFakeTimers({ now: NOW });
    try {
      requestProjectStatusCheck(SUP, 'run_completed');
      requestProjectStatusCheck(SUP, 'run_completed');
      requestProjectStatusCheck('chat-other', 'message_sent');
      expect(jest.getTimerCount()).toBe(1);
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('PROJECT_STATUS_HOURLY_ENABLED=1 restores the hourly card for a quiet project', async () => {
    quiet();
    prevStatusRow = prevAt(61);
    process.env.PROJECT_STATUS_HOURLY_ENABLED = '1';
    try {
      expect(await sweepAt(NOW)).toMatchObject({ emitted: 1 });
    } finally {
      delete process.env.PROJECT_STATUS_HOURLY_ENABLED;
    }
  });
});
