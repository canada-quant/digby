/**
 * Ticket dd4e20ad — project-digest "supervisor says" admitted provider-killed
 * harness envelopes (the 429 fallback rendered VERBATIM as the supervisor's
 * voice in the owner digest).
 *
 * THE MISHAP: the digest's supervisor-says preflight (project-digest.service.ts)
 * reads the project supervisor lane's newest assistant rows (90-min
 * SUPERVISOR_SAYS_WINDOW_MS, desc, take SUPERVISOR_SAYS_FETCH) and keeps the
 * first row passing isSupervisorOwnVoice — a gate that checks only
 * metadata.engine === 'agent' plus an origin/kind denylist. A provider-killed
 * wake's terminal envelope row CARRIES the finalize stamp (engine 'agent' is
 * unconditional in chat-agent's base metadata — chat-agent.service.ts), so it
 * passed the voice gate; and the 429 "Sorry — I couldn't get an answer out
 * this time…" fallback has no hex ids/links/Z-times for supervisorSaysLine to
 * scrub, so it rendered verbatim as `Its supervisor says: "Sorry — …"` until a
 * real note displaced it. Third surface of the class: the attention watchdog
 * (ticket 08e58e1d) and the project-status check-in (ticket 68742517) already
 * exclude these envelopes; the digest did not.
 *
 * THE FIX: the supervisorNotes loop now skips a row when
 * metadata.providerError is set (the deterministic marker stamped at persist
 * since ticket 08e58e1d) or isHarnessErrorNote(content) matches (rows
 * persisted before the marker existed, or persisted unmarked) — the same
 * two-lane exclusion as both sibling surfaces.
 *
 * The replay below drives the digest with the REAL envelope generator
 * (modelErrorTerminalNote from coding/compaction) — never a hand-typed copy
 * that could drift from the code under test. Mock harness mirrors
 * project-digest.service.test.ts (same module under test).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn() },
  crossModelProject: { findMany: jest.fn() },
  crossModelMessage: { findMany: jest.fn() },
  agentRun: { findMany: jest.fn(), count: jest.fn() },
  pendingChatMessage: { findMany: jest.fn() },
  chatSchedule: { findMany: jest.fn() },
  chatCodingState: { findMany: jest.fn() },
  projectGoal: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  pendingConfirmation: { findMany: jest.fn() },
  ownerQuestion: { findMany: jest.fn(async () => []) },
  projectDigest: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })) },
  digestItemAck: { deleteMany: jest.fn(async () => ({ count: 0 })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Defensive: the REAL envelope generator (coding/compaction) transitively
// imports coding-retrieval.service → folder-inheritance → memory/context-store;
// keep the Redis boundary inert so this suite imports env-less like CI.
const mockRedis: any = {
  get: jest.fn(), set: jest.fn(), del: jest.fn(),
  hGetAll: jest.fn(), hSet: jest.fn(), hDel: jest.fn(), expire: jest.fn(),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

const mockRepushOwnerQuestionReminder: jest.Mock = jest.fn(async () => true);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/owner-questions'),
  repushOwnerQuestionReminder: (...a: any[]) => mockRepushOwnerQuestionReminder(...a),
}));

const mockNoteUnbackedOwnerWaitClaim: jest.Mock = jest.fn(async () => ({ woken: [] }));
jest.mock('../platform/goals.service', () => ({
  __esModule: true,
  noteUnbackedOwnerWaitClaim: (...a: any[]) => mockNoteUnbackedOwnerWaitClaim(...a),
}));

// utility-llm boundary — forced empty so the digest renders via the
// deterministic LOCAL TEMPLATE (the path that appends the "supervisor says"
// sentence), never a live provider.
const mockUtilityChat: jest.Mock = jest.fn(async (): Promise<string> => '');
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));

const mockHidden: jest.Mock = jest.fn(async (): Promise<any> => ({ chatIds: [], projectIds: [] }));
jest.mock('./fleet.service', () => ({
  __esModule: true,
  getSidebarHiddenFleetArtifacts: (...a: any[]) => mockHidden(...a),
}));

const mockMaybeFileStoppedScheduleDecision: jest.Mock = jest.fn(async (): Promise<any> => ({ filed: true, questionId: 'oq_1' }));
jest.mock('../coding/stopped-schedule-alert', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/stopped-schedule-alert'),
  maybeFileStoppedScheduleDecision: (...a: any[]) => mockMaybeFileStoppedScheduleDecision(...a),
}));

const mockGetSessionAttention: jest.Mock = jest.fn(async (): Promise<any> => ({ approvals: [], questions: [] }));
jest.mock('../coding/session-run-lock', () => ({
  __esModule: true,
  getSessionAttention: (...a: any[]) => mockGetSessionAttention(...a),
}));

import { runProjectDigestOnce, supervisorSaysLine } from './project-digest.service';
import { isHarnessErrorNote, EMPTY_RUN_FALLBACK_NOTE } from '../coding/harness-error-notes';
import { modelErrorTerminalNote } from '../coding/compaction';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const P1 = 'proj-1';
const SUP_CHAT = 'psup-1';
const WORKER = 'c-worker';

/** The incident envelope, produced by the REAL generator (same invocation the
 *  ticket-08e58e1d replay pins as the user-audience 429 shape). */
const FALLBACK_429 = modelErrorTerminalNote({
  errorStatus: 429,
  transcriptChars: 12_000,
  contextBudget: 4_000_000,
  attempts: 3,
  recoveryLabel: 'backoff-and-retry',
  audience: 'user',
});

/** A provider-error wording NO known prefix matches — only the deterministic
 *  metadata.providerError marker can catch it (the marker lane's reason to
 *  exist; mirrors the FUTURE_ENVELOPE leg of the 08e58e1d replay). */
const FUTURE_ENVELOPE =
  'UPSTREAM PROVIDER MELTDOWN: the model gateway rejected all 4 attempts (HTTP 529, a wording no prefix list knows yet) — giving up for this wake.';

/** A real lane-authored note: plain prose, no ids/times, so supervisorSaysLine
 *  renders it unchanged — any drift here is the scrubber's doing, not the
 *  fixture's. */
const REAL_NOTE = 'Bench sweep — shards five of eight done; GPU two re-dispatched after a stall';

let chats: any[];
let projects: any[];
let messages: any[];
let windowRuns: any[];
let runningRuns: any[];
let queued: any[];
let schedules: any[];
let codingStates: any[];
let goals: any[];
let todos: any[];
let pendingConfirmations: any[];
let laneRuns: Record<string, number>;
let discoveredUserIds: string[];
let existingDigest: any;
let digestRows: any[];

const inWindow = () => new Date(Date.now() - 10 * 60_000); // 10 min ago

/** An assistant row in the supervisor lane, `minutesAgo` old. Default metadata
 *  is the chat-agent finalize stamp (engine 'agent') inheriting a schedule-wake
 *  origin — EXACTLY the shape that made the envelope quotable pre-fix. */
const supNote = (content: string, minutesAgo: number, metadata: any = { origin: 'schedule', engine: 'agent' }) => ({
  chatId: SUP_CHAT, role: 'assistant', content, metadata, createdAt: new Date(Date.now() - minutesAgo * 60_000),
});

const workerActivity = () => ({ chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() });

/** Wire the prisma mock to the module-level fixtures (filtered like real
 *  queries). The message mock routes BOTH shapes: the bucket's `chatId.in`
 *  scan AND the supervisor-says `chatId: <string>` + 90-min window read
 *  (desc, take N). */
function wireMocks() {
  mockPrisma.crossModelChat.findMany.mockImplementation((args: any) =>
    Promise.resolve(args?.where?.userId ? chats : discoveredUserIds.map((userId) => ({ userId }))),
  );
  mockPrisma.crossModelProject.findMany.mockImplementation(() => Promise.resolve(projects));
  mockPrisma.crossModelMessage.findMany.mockImplementation((args: any) => {
    const where = args?.where ?? {};
    if (typeof where.chatId === 'string') {
      const gte: Date | undefined = where.createdAt?.gte;
      const rows = messages
        .filter((m) => m.chatId === where.chatId && m.role === 'assistant' && (!gte || m.createdAt >= gte))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, args?.take ?? 5);
      return Promise.resolve(rows);
    }
    const gte: Date | undefined = where.createdAt?.gte;
    return Promise.resolve(messages.filter((m) => (where.chatId?.in ?? []).includes(m.chatId) && (!gte || m.createdAt >= gte)));
  });
  mockPrisma.agentRun.findMany.mockImplementation((args: any) => {
    if (args?.select?.state) return Promise.resolve([]);
    const ids: string[] = args?.where?.sessionId?.in ?? [];
    if (args?.where?.status === 'running') return Promise.resolve(runningRuns.filter((r) => ids.includes(r.sessionId)));
    return Promise.resolve(windowRuns.filter((r) => ids.includes(r.sessionId)));
  });
  mockPrisma.agentRun.count.mockImplementation((args: any) =>
    Promise.resolve(laneRuns[args?.where?.sessionId] ?? 0),
  );
  mockPrisma.pendingChatMessage.findMany.mockImplementation((args: any) =>
    Promise.resolve(queued.filter((q) => (args?.where?.chatId?.in ?? []).includes(q.chatId))),
  );
  mockPrisma.chatSchedule.findMany.mockImplementation((args: any) =>
    Promise.resolve(schedules.filter((s) => (args?.where?.sessionId?.in ?? []).includes(s.sessionId))),
  );
  mockPrisma.chatCodingState.findMany.mockImplementation((args: any) =>
    Promise.resolve(codingStates.filter((s) => (args?.where?.id?.in ?? []).includes(s.id))),
  );
  mockPrisma.projectGoal.findMany.mockImplementation((args: any) =>
    Promise.resolve(goals.filter((g) => g.projectId === args?.where?.projectId)),
  );
  mockPrisma.projectTodo.findMany.mockImplementation((args: any) =>
    Promise.resolve(todos.filter((t) => t.projectId === args?.where?.projectId)),
  );
  mockPrisma.pendingConfirmation.findMany.mockImplementation((args: any) =>
    Promise.resolve(pendingConfirmations.filter((c) => c.userId === args?.where?.userId && c.status === 'pending')),
  );
  mockPrisma.projectDigest.findFirst.mockImplementation(() => Promise.resolve(existingDigest));
  mockPrisma.projectDigest.create.mockImplementation((args: any) => Promise.resolve({ id: 'dg-new', ...args?.data }));
  mockPrisma.projectDigest.update.mockImplementation(() => Promise.resolve({}));
  mockPrisma.projectDigest.deleteMany.mockImplementation((args: any) => {
    const keep: any[] = (args?.where?.NOT ?? []).map((n: any) => n.projectId);
    const before = digestRows.length;
    digestRows = digestRows.filter((r) => r.userId !== args?.where?.userId || keep.some((p) => p === r.projectId));
    return Promise.resolve({ count: before - digestRows.length });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  chats = [
    { id: WORKER, title: 'Kernel worker', projectId: P1 },
    { id: SUP_CHAT, title: 'Alpha Supervisor', projectId: P1, isProjectSupervisor: true },
  ];
  projects = [{ id: P1, name: 'Alpha', supervised: true }];
  messages = [];
  windowRuns = [];
  runningRuns = [];
  queued = [];
  schedules = [];
  codingStates = [];
  goals = [];
  todos = [];
  pendingConfirmations = [];
  laneRuns = {};
  discoveredUserIds = [OWNER];
  existingDigest = null;
  digestRows = [];
  mockHidden.mockResolvedValue({ chatIds: [], projectIds: [] });
  mockUtilityChat.mockResolvedValue(''); // force the deterministic local template
  mockGetSessionAttention.mockResolvedValue({ approvals: [], questions: [] });
  mockPrisma.ownerQuestion.findMany.mockReset().mockResolvedValue([]);
  mockRepushOwnerQuestionReminder.mockReset().mockResolvedValue(true);
  wireMocks();
});

/** The create payload written for ONE project bucket (helper for assertions). */
function createdFor(projectId: string | null) {
  return mockPrisma.projectDigest.create.mock.calls
    .map((c: any[]) => c[0].data)
    .find((d: any) => d.projectId === projectId);
}

// ── The replay ────────────────────────────────────────────────────────────────
describe('ticket dd4e20ad — "supervisor says" excludes provider-killed envelopes', () => {
  it('0. replay preconditions: the real 429 envelope IS a harness error note AND would scrub to a renderable line (why it rendered verbatim pre-fix)', () => {
    expect(isHarnessErrorNote(FALLBACK_429)).toBe(true);
    expect(FALLBACK_429).toContain("couldn't get an answer out this time"); // the prefix contract
    expect(supervisorSaysLine(FALLBACK_429)).not.toBeNull(); // survives the scrubber ≥12 chars
    expect(supervisorSaysLine(FUTURE_ENVELOPE)).not.toBeNull(); // would render too, if reached
    expect(isHarnessErrorNote(FUTURE_ENVELOPE)).toBe(false); // …yet no prefix knows it
    expect(isHarnessErrorNote(REAL_NOTE)).toBe(false);
  });

  it('1. THE MISHAP: a providerError-marked 429 envelope is the newest supervisor row — the digest renders the older REAL note, never the fallback', async () => {
    messages = [
      workerActivity(),
      supNote(FALLBACK_429, 5, { origin: 'schedule', engine: 'agent', providerError: { status: 429, kind: 'transient' } }),
      supNote(REAL_NOTE, 40),
    ];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1).toBeDefined();
    expect(p1.summary).toContain(`Its supervisor says: "${REAL_NOTE}"`);
    // The exact scrubbed line the pre-fix code rendered verbatim must be gone.
    expect(p1.summary).not.toContain(supervisorSaysLine(FALLBACK_429)!);
    expect(p1.summary).not.toContain("couldn't get an answer out this time");
    expect(p1.summary).not.toContain('rate-limiting');
  });

  it('2. shape lane: an UNMARKED 429 envelope (persisted before the providerError marker existed) is skipped the same way', async () => {
    messages = [
      workerActivity(),
      supNote(FALLBACK_429, 5), // default metadata: the finalize stamp, NO providerError
      supNote(REAL_NOTE, 40),
    ];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.summary).toContain(`Its supervisor says: "${REAL_NOTE}"`);
    expect(p1.summary).not.toContain(supervisorSaysLine(FALLBACK_429)!);
    expect(p1.summary).not.toContain("couldn't get an answer out this time");
    expect(p1.summary).not.toContain('rate-limiting');
  });

  it('3. marker lane: a providerError-marked row with FUTURE wording no prefix knows is skipped', async () => {
    messages = [
      workerActivity(),
      supNote(FUTURE_ENVELOPE, 5, { origin: 'hook', engine: 'agent', providerError: { status: 529, kind: 'unknown' } }),
      supNote(REAL_NOTE, 30),
    ];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.summary).toContain(`Its supervisor says: "${REAL_NOTE}"`);
    expect(p1.summary).not.toContain('MELTDOWN');
    expect(p1.summary).not.toContain('HTTP 529');
  });

  it('4. a window holding ONLY envelope rows yields NO "Its supervisor says" sentence — fail-open omission, the bucket still digests', async () => {
    messages = [
      workerActivity(),
      supNote(FALLBACK_429, 5, { origin: 'schedule', engine: 'agent', providerError: { status: 429, kind: 'transient' } }),
      supNote(EMPTY_RUN_FALLBACK_NOTE, 20), // unmarked empty-run fallback (shape lane)
    ];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1).toBeDefined();
    expect(p1.summary).not.toContain('Its supervisor says');
    expect(p1.summary).not.toContain("couldn't get an answer out this time");
    expect(p1.summary).not.toContain("wasn't able to generate");
  });

  it('5. positive control: a real lane-authored note still renders (the filter does not over-exclude)', async () => {
    messages = [workerActivity(), supNote(REAL_NOTE, 20)];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.summary).toContain(`Its supervisor says: "${REAL_NOTE}"`);
  });
});
