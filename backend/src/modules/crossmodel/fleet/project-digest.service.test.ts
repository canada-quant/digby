/**
 * Project digest service — unit tests with mocked Prisma + utility LLM.
 * Covers: bucketing (incl. the ungrouped null bucket), hidden fleet-artifact
 * exclusion, per-signal attention-item derivation (incl. stuck_message
 * suppression behind healthy long runs), signature canonicalization +
 * skip-unchanged (which still touches window bounds), ghost-row cleanup, the
 * local template fallback when the LLM is empty/down, and per-user /
 * per-bucket error isolation.
 * Pattern follows fleet.service.test.ts (mocked config/database boundary).
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
  // N10 owner-wait verification probe: open oq_ rows backing "awaiting owner" claims.
  ownerQuestion: { findMany: jest.fn(async () => []) },
  projectDigest: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn(async () => ({ count: 0 })) },
  digestItemAck: { deleteMany: jest.fn(async () => ({ count: 0 })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// loop-metrics boundary — the N10 drop path fire-and-forgets a metric via a
// dynamic import; mocked so no buffer/flush timer lives in this suite.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

// owner-questions boundary — the 72h owner-wait escalation dynamically imports
// repushOwnerQuestionReminder (whose real body pulls config/redis → config/env,
// process.exit in a keyless env). Regexes stay REAL (requireActual is safe:
// owner-questions' only static import is node:crypto).
const mockRepushOwnerQuestionReminder: jest.Mock = jest.fn(async () => true);
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/owner-questions'),
  repushOwnerQuestionReminder: (...a: any[]) => mockRepushOwnerQuestionReminder(...a),
}));

// utility-llm boundary (axios/provider env heavy) — record calls, control content.
const mockUtilityChat: jest.Mock = jest.fn(async (): Promise<string> => 'LLM summary.');
// CanLaw stall 2026-09-15: an owner-decision claim with no open owner question
// behind it now wakes the lane that wrote it — a dynamic import of
// ../platform/goals.service, mocked at the boundary (the real module statically
// pulls middleware/error-handler → config/env → process.exit at import).
const mockNoteUnbackedOwnerWaitClaim: jest.Mock = jest.fn(async () => ({ woken: [] }));
jest.mock('../platform/goals.service', () => ({
  __esModule: true,
  noteUnbackedOwnerWaitClaim: (...a: any[]) => mockNoteUnbackedOwnerWaitClaim(...a),
}));

jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));

// fleet.service boundary — the digest imports ONLY getSidebarHiddenFleetArtifacts;
// the real module pulls middleware/error-handler → config/env, which calls
// process.exit(1) at import without env vars (see .digby/notes/learnings.md).
const mockHidden: jest.Mock = jest.fn(async (): Promise<any> => ({ chatIds: [], projectIds: [] }));
jest.mock('./fleet.service', () => ({
  __esModule: true,
  getSidebarHiddenFleetArtifacts: (...a: any[]) => mockHidden(...a),
}));

// stopped-schedule-alert boundary (SA0906) — digestBucket DYNAMICALLY imports
// maybeFileStoppedScheduleDecision as the durable owner-decision filing
// backstop for genuinely-dead machine-stopped cadences; mocked so these tests
// pin exactly which rows are offered to the seam (and that healthy/cancelled
// ones never are).
const mockMaybeFileStoppedScheduleDecision: jest.Mock = jest.fn(async (): Promise<any> => ({ filed: true, questionId: 'oq_1' }));
jest.mock('../coding/stopped-schedule-alert', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/stopped-schedule-alert'), // constants stay real (parity pin below)
  maybeFileStoppedScheduleDecision: (...a: any[]) => mockMaybeFileStoppedScheduleDecision(...a),
}));

// session-run-lock boundary — digestBucket DYNAMICALLY imports it for the
// ephemeral awaiting_input leg (Redis pending approvals/questions of live
// runs). The real module pulls config/redis → config/env, which calls
// process.exit(1) at import without env vars (same hazard as fleet.service).
const mockGetSessionAttention: jest.Mock = jest.fn(async (): Promise<any> => ({ approvals: [], questions: [] }));
jest.mock('../coding/session-run-lock', () => ({
  __esModule: true,
  getSessionAttention: (...a: any[]) => mockGetSessionAttention(...a),
}));

import { Prisma } from '@prisma/client';
import logger from '../../../utils/logger';
import {
  runProjectDigestOnce,
  fallbackDigestSummary,
  summarizeDigest,
  recentWorkPhrase,
  bucketHadActivity,
  computeDigestSignature,
  computeGoalEta,
  computeGoalProgress,
  computeEtaSummary,
  goalEtaPhrase,
  completedGoalsPhrase,
  MAX_GOAL_PROGRESS_ITEMS,
  STUCK_MESSAGE_MS,
  STALLED_RUN_MS,
  STOPPED_LANE_ACTIVITY_WINDOW_MS,
  MAX_USERS_PER_SWEEP,
  SWEEP_TIME_BUDGET_MS,
  supervisorSaysLine,
  SUPERVISOR_SAYS_WINDOW_MS,
  SUPERVISOR_SAYS_MAX_CHARS,
  TEAM_PAUSE_DETAIL,
  STALE_GATE_DETAIL_PREFIX,
  isTeamPauseItem,
} from './project-digest.service';
import type { DigestStats, DigestAttentionItem, DigestGoalProgress } from './project-digest.service';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const P1 = 'proj-1';
const P2 = 'proj-2';

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
// SA0906: trailing-6h agent-run counts per session (the lane-liveness probe).
let laneRuns: Record<string, number>;
let discoveredUserIds: string[];
let existingDigest: any;
let digestRows: any[];

const inWindow = () => new Date(Date.now() - 10 * 60_000);            // 10 min ago
const old = () => new Date(Date.now() - 3 * 60 * 60_000);             // 3h ago
const stuckAt = () => new Date(Date.now() - STUCK_MESSAGE_MS - 60_000);
const staleBeat = () => new Date(Date.now() - STALLED_RUN_MS - 60_000);

/** Wire the prisma mock to the module-level fixtures (filtered like real queries). */
function wireMocks() {
  // discovery call has no userId (chatMessages.some); digestUser's does.
  mockPrisma.crossModelChat.findMany.mockImplementation((args: any) =>
    Promise.resolve(args?.where?.userId ? chats : discoveredUserIds.map((userId) => ({ userId }))),
  );
  mockPrisma.crossModelProject.findMany.mockImplementation(() => Promise.resolve(projects));
  mockPrisma.crossModelMessage.findMany.mockImplementation((args: any) =>
    Promise.resolve(messages.filter((m) => (args?.where?.chatId?.in ?? []).includes(m.chatId))),
  );
  mockPrisma.agentRun.findMany.mockImplementation((args: any) => {
    if (args?.select?.state) return Promise.resolve([]); // run-driven discovery: none by default
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
  // digestUser's durable-leg query: live rows are pre-filtered by the WHERE, so
  // the mock keeps only the userId/status filter (mirrors the other mocks).
  mockPrisma.pendingConfirmation.findMany.mockImplementation((args: any) =>
    Promise.resolve(
      pendingConfirmations.filter((c) => c.userId === args?.where?.userId && c.status === 'pending'),
    ),
  );
  mockPrisma.projectDigest.findFirst.mockImplementation(() => Promise.resolve(existingDigest));
  mockPrisma.projectDigest.create.mockImplementation((args: any) => Promise.resolve({ id: 'dg-new', ...args?.data }));
  mockPrisma.projectDigest.update.mockImplementation(() => Promise.resolve({}));
  // Mirror the ghost-cleanup where: { userId, NOT: [{ projectId }, …] } — keep a
  // row iff its projectId is one of the NOT entries (null-safe via ===).
  mockPrisma.projectDigest.deleteMany.mockImplementation((args: any) => {
    const keep: any[] = (args?.where?.NOT ?? []).map((n: any) => n.projectId);
    const before = digestRows.length;
    digestRows = digestRows.filter((r) => r.userId !== args?.where?.userId || keep.some((p) => p === r.projectId));
    return Promise.resolve({ count: before - digestRows.length });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  chats = [];
  projects = [];
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
  mockUtilityChat.mockResolvedValue('LLM summary.');
  mockGetSessionAttention.mockResolvedValue({ approvals: [], questions: [] });
  mockPrisma.ownerQuestion.findMany.mockReset().mockResolvedValue([]);
  mockRepushOwnerQuestionReminder.mockReset().mockResolvedValue(true);
  wireMocks();
});

/** The create payloads written for ONE project bucket (helper for assertions). */
function createdFor(projectId: string | null) {
  return mockPrisma.projectDigest.create.mock.calls
    .map((c: any[]) => c[0].data)
    .find((d: any) => d.projectId === projectId);
}

// ── Discovery / bucketing ─────────────────────────────────────────────────────

describe('runProjectDigestOnce — discovery + bucketing', () => {
  it('is a no-op when no user had window activity', async () => {
    discoveredUserIds = [];
    await runProjectDigestOnce();
    expect(mockPrisma.projectDigest.create).not.toHaveBeenCalled();
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  // Liveness-touch contract (digest-freshness.ts keys the dashboard's stale
  // badge off updatedAt moving EVERY sweep): quiet accounts never enter the
  // activity-discovered user list, so their rows must be touched explicitly —
  // otherwise every idle project cries "pipeline may be behind" after 2.5h.
  it('touches ALL buckets when no user had window activity (quiet-account liveness)', async () => {
    discoveredUserIds = [];
    await runProjectDigestOnce();
    expect(mockPrisma.projectDigest.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.projectDigest.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({});
    expect(arg.data.updatedAt).toBeInstanceOf(Date);
  });

  it('touches only the buckets this sweep will NOT process (active users get theirs via rewrite/signature-skip)', async () => {
    await runProjectDigestOnce();
    expect(mockPrisma.projectDigest.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.projectDigest.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ userId: { notIn: [OWNER] } });
  });

  it('a liveness-touch failure never kills the sweep', async () => {
    mockPrisma.projectDigest.updateMany.mockRejectedValueOnce(new Error('db hiccup'));
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    await expect(runProjectDigestOnce()).resolves.toBeUndefined();
    expect(mockPrisma.projectDigest.create).toHaveBeenCalled(); // sweep continued
  });

  it('buckets chats by projectId, including the ungrouped null bucket', async () => {
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c2', title: 'Two', projectId: P1 },
      { id: 'c3', title: 'Loose', projectId: null },
    ];
    projects = [{ id: P1, name: 'Alpha' }];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    expect(mockPrisma.projectDigest.create).toHaveBeenCalledTimes(2);
    const p1 = createdFor(P1);
    expect(p1).toBeDefined();
    expect(p1.userId).toBe(OWNER);
    expect(p1.status).toBe('on_track'); // window activity, no attention items
    expect(p1.stats.chatCount).toBe(2);
    expect(p1.stats.activeChats).toBe(1);
    expect(p1.stats.messages).toMatchObject({ total: 1, user: 1, assistant: 0 });
    expect(p1.stats.messages.byOrigin).toEqual({ user: 1 });
    // Review 2026-09-13 issue 16: on_track + 0 tracked goals + activity ships
    // the ONE neutral sentence deterministically (no LLM call for this bucket).
    expect(p1.summary).toBe('No goal is being tracked for Alpha; recent work: 1 message from you in the last hour.');

    const ungrouped = createdFor(null);
    expect(ungrouped).toBeDefined();
    expect(ungrouped.status).toBe('idle'); // no window activity in the null bucket
    expect(ungrouped.stats.chatCount).toBe(1);
    expect(ungrouped.windowStart).toBeInstanceOf(Date);
    expect(ungrouped.windowEnd).toBeInstanceOf(Date);
  });

  it('excludes hidden fleet artifacts (supervisor chats + the Fleet HQ folder)', async () => {
    chats = [
      { id: 'sup-1', title: 'Fleet Supervisor', projectId: null },
      { id: 'hq-c1', title: 'HQ chat', projectId: 'p-hq' },
      { id: 'c1', title: 'One', projectId: P1 },
    ];
    projects = [{ id: 'p-hq', name: 'Fleet HQ' }, { id: P1, name: 'Alpha' }];
    mockHidden.mockResolvedValue({ chatIds: ['sup-1'], projectIds: ['p-hq'] });
    // Activity ONLY in hidden chats — it must not leak into any digest bucket.
    messages = [
      { chatId: 'sup-1', role: 'user', content: 'sweep', metadata: { origin: 'schedule' }, createdAt: inWindow() },
      { chatId: 'hq-c1', role: 'assistant', content: 'reply', metadata: null, createdAt: inWindow() },
    ];

    await runProjectDigestOnce();

    expect(mockPrisma.projectDigest.create).toHaveBeenCalledTimes(1);
    const p1 = createdFor(P1);
    expect(p1.stats.chatCount).toBe(1);
    expect(p1.stats.messages.total).toBe(0); // hidden chats' messages excluded
    expect(p1.status).toBe('idle');
    expect(createdFor('p-hq')).toBeUndefined();
    expect(createdFor(null)).toBeUndefined(); // sup-1 hidden ⇒ no ungrouped bucket
  });

  it('excludes chats of UNSUPERVISED projects from bucketing; ghost cleanup retires its digest row (ticket c992d730)', async () => {
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c2', title: 'Two', projectId: P2 },
      { id: 'c3', title: 'Loose', projectId: null },
    ];
    projects = [
      { id: P1, name: 'Alpha', supervised: true },
      { id: P2, name: 'Retired', supervised: false },
    ];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];
    // A stale digest row for the now-unsupervised project: with no bucket
    // materializing for P2, the sweep's ghost cleanup retires it naturally.
    digestRows = [{ id: 'dg-old', userId: OWNER, projectId: P2, status: 'idle' }];

    await runProjectDigestOnce();

    expect(createdFor(P2)).toBeUndefined(); // unsupervised project — no digest row
    const p1 = createdFor(P1);
    expect(p1).toBeDefined(); // supervised projects still digest
    expect(p1.stats.chatCount).toBe(1);
    const ungrouped = createdFor(null);
    expect(ungrouped).toBeDefined(); // the ungrouped bucket is always supervised
    expect(ungrouped.stats.chatCount).toBe(1);
    expect(digestRows.some((r) => r.projectId === P2)).toBe(false); // ghost row retired
  });

  it('User Space (P3 §3): chats filed in the hidden user-space project digest as UNGROUPED — the space never gets its own bucket', async () => {
    const SPACE = 'proj-userspace';
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c2', title: 'Two', projectId: SPACE },
      { id: 'c3', title: 'Three', projectId: SPACE },
    ];
    projects = [
      { id: P1, name: 'Alpha', supervised: true, isUserSpace: false },
      // The space is deliberately supervised:false — the bucketing translation
      // must run BEFORE the unsupervised filter or every auto-filed chat would
      // silently drop out of the digest.
      { id: SPACE, name: 'Workspace', supervised: false, isUserSpace: true },
    ];
    messages = [{ chatId: 'c2', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    expect(createdFor(SPACE)).toBeUndefined(); // no "Workspace" digest card
    const ungrouped = createdFor(null);
    expect(ungrouped).toBeDefined();
    expect(ungrouped.projectId).toBeNull();
    expect(ungrouped.stats.chatCount).toBe(2); // both user-space chats land here
    expect(ungrouped.stats.activeChats).toBe(1);
    const p1 = createdFor(P1);
    expect(p1).toBeDefined(); // real projects still digest under their own id
    expect(p1.stats.chatCount).toBe(1);
  });
});

// ── Attention items + status ──────────────────────────────────────────────────

describe('attention-item derivation', () => {
  function setupSignalBucket() {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    goals = [{
      id: 'g1', projectId: P1, title: 'Ship v2', status: 'blocked',
      blockedReason: 'waiting on API keys', createdAt: old(), updatedAt: inWindow(),
    }];
    todos = [{
      id: 't1', projectId: P1, goalId: 'g1', title: 'Wire auth', status: 'blocked',
      blockedReason: null, createdAt: old(), updatedAt: inWindow(),
    }];
    windowRuns = [{ id: 'r1', sessionId: 'c1', status: 'failed', error: 'OOM killed', createdAt: old(), finishedAt: inWindow() }];
    runningRuns = [{ id: 'r2', sessionId: 'c1', heartbeatAt: staleBeat(), updatedAt: staleBeat(), startedAt: old() }];
    queued = [{ id: 'q1', chatId: 'c1', content: 'ping', createdAt: stuckAt(), source: 'agent' }];
    schedules = [{ id: 's1', sessionId: 'c1', lastFiredAt: inWindow(), lastStatus: 'error:boom', prompt: 'nightly sweep' }];
    codingStates = [{ id: 'c1', status: 'error', errorMessage: 'container died', updatedAt: inWindow() }];
  }

  it('ticket 911b6c45 replay: a STALE errorMessage beside a non-error status surfaces NO session_error item', async () => {
    // The mishap: a provisioning failure wrote errorMessage, the project was
    // reconfigured (github-backed) and the session healed to 'ready' — the old
    // text survived in the column and kept generating session_error attention
    // items on every digest, misleading supervisor lanes for hours.
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    codingStates = [{
      id: 'c1', status: 'ready',
      errorMessage: 'Workspace provisioning failed: project b33a1283 has no repoUrl and its local mirror is missing',
      updatedAt: inWindow(),
    }];

    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    const items = p1.attentionItems.filter((i: any) => i.kind === 'session_error');
    expect(items).toEqual([]);
  });

  it('derives one attention item per signal and classifies the bucket blocked', async () => {
    setupSignalBucket();
    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('blocked'); // blocked goal/todo + NO window activity = a genuine standstill
    const kinds = p1.attentionItems.map((i: any) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining([
      'blocked_goal', 'blocked_todo', 'failed_run', 'stalled_session',
      'schedule_error', 'stuck_message', 'session_error',
    ]));
    const by = (k: string) => p1.attentionItems.find((i: any) => i.kind === k);
    expect(by('blocked_goal')).toMatchObject({ goalId: 'g1', title: 'Ship v2', detail: 'waiting on API keys' });
    expect(by('blocked_todo')).toMatchObject({ todoId: 't1', goalId: 'g1', title: 'Wire auth', detail: null });
    expect(by('failed_run')).toMatchObject({ runId: 'r1', chatId: 'c1', detail: 'OOM killed' });
    expect(by('stalled_session')).toMatchObject({ runId: 'r2', chatId: 'c1' });
    expect(by('schedule_error')).toMatchObject({ scheduleId: 's1', chatId: 'c1', detail: 'error:boom' });
    expect(by('session_error')).toMatchObject({ chatId: 'c1', detail: 'container died' });
    expect(by('stuck_message').detail).toContain('queued since');
    for (const item of p1.attentionItems) expect(typeof item.at).toBe('string');

    expect(p1.stats.runs.failed).toBe(1);
    expect(p1.stats.todos).toMatchObject({ total: 1, blocked: 1 });
    expect(p1.stats.goals).toMatchObject({ total: 1, blocked: 1 });
    expect(p1.stats.schedules).toMatchObject({ firedInWindow: 1, errored: 1 });
    expect(p1.stats.queuedMessages).toBe(1);
  });

  it('blocked items in an ACTIVELY-WORKING bucket → needs_attention, NOT blocked (ticket 547df1ff)', async () => {
    // The owner's report: "it says tt-rd is blocked but the session is
    // grinding away" — ACTIONABLE blocked todos must not paint a live project
    // red. Blocked items stay listed as flags. (Reasons are manual/actionable
    // here: dep-waits + owner-parked items are filtered entirely, per the
    // ticket-821d944d pins below.)
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    goals = [{
      id: 'g1', projectId: P1, title: 'Ship v2', status: 'blocked',
      // N10: an owner-wait claim needs its open oq backing to render.
      blockedReason: 'Awaiting owner: pick the serving engine', gateQuestionId: 'oq_serving1-cccc',
      createdAt: old(), updatedAt: inWindow(),
    }];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([{ id: 'oq_serving1-cccc', createdAt: inWindow(), userId: OWNER }]);
    todos = [{
      id: 't1', projectId: P1, goalId: 'g1', title: 'Wire auth', status: 'blocked',
      blockedReason: 'Blocked manually', createdAt: old(), updatedAt: inWindow(),
    }];
    // Window activity: messages flowing right now (the "grinding away" leg).
    messages = [{ chatId: 'c1', role: 'user', content: 'keep going', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention');
    expect(p1.attentionItems.map((i: any) => i.kind)).toEqual(
      expect.arrayContaining(['blocked_goal', 'blocked_todo']),
    );
  });

  it('dep-waiting + owner-parked blocks in an ACTIVE bucket → on_track, no blocked items (ticket 821d944d)', async () => {
    // The verbatim tt-rd repro: the led attention item was a '[deps]' wait on
    // a project grinding away. Dep-waits auto-unblock (no action exists) and
    // parked items are decisions that already happened — state, not signal.
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    todos = [
      { id: 't1', projectId: P1, goalId: null, title: 'P3 Command-R bring-up', status: 'blocked', blockedReason: '[deps] Waiting on 1 todo', createdAt: old(), updatedAt: inWindow() },
      { id: 't2', projectId: P1, goalId: null, title: 'P2 3.6 matrix', status: 'blocked', blockedReason: 'DROPPED 2026-08-22 (owner directive): 3.6 matrix cancelled. Retained for history.', createdAt: old(), updatedAt: inWindow() },
      { id: 't3', projectId: P1, goalId: null, title: 'Qwen3.8 matrix', status: 'blocked', blockedReason: 'Owner pause directive 2026-08-27: cancel all Qwen benchmark runs, pause all Qwen-related work.', createdAt: old(), updatedAt: inWindow() },
    ];
    messages = [{ chatId: 'c1', role: 'user', content: 'keep going', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('on_track');
    expect(p1.attentionItems).toEqual([]);
    // …but the counts stay honest — the blocks still exist, they just aren't attention.
    expect(p1.stats.todos).toMatchObject({ total: 3, blocked: 3 });
  });

  it('dep-waiting + parked blocks in a QUIET bucket → idle, NOT blocked (ticket 821d944d)', async () => {
    // Nothing to act on and nothing happening: 'blocked' (red) is reserved
    // for actionable blockers on a silent project.
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    todos = [
      { id: 't1', projectId: P1, goalId: null, title: 'P4 matrix', status: 'blocked', blockedReason: '[deps] Waiting on 2 todos', createdAt: old(), updatedAt: old() },
      { id: 't2', projectId: P1, goalId: null, title: 'Lane', status: 'blocked', blockedReason: 'OWNER DIRECTIVE 10e372ed: lane retired — will never execute unless owner reverts.', createdAt: old(), updatedAt: old() },
    ];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('idle');
    expect(p1.attentionItems).toEqual([]);
  });

  it('unexplained manual block still drives needs_attention even when active (actionable by default)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    todos = [{ id: 't1', projectId: P1, goalId: null, title: 'Wire auth', status: 'blocked', blockedReason: null, createdAt: old(), updatedAt: inWindow() }];
    messages = [{ chatId: 'c1', role: 'user', content: 'keep going', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention');
    expect(p1.attentionItems.map((i: any) => i.kind)).toEqual(['blocked_todo']);
  });

  it('actionable lookalikes survive the parked filter (review B1): owner-decision asks + infra "dropped"', async () => {
    // The reviewer's refutation corpus: reasons that ASK for a decision or
    // report something dropping must NOT be mistaken for parked items.
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    todos = [
      // N10 composition: owner-decision reasons survive the parked filter AND
      // (since remediation P2) must carry an open oq backing to render.
      { id: 't1', projectId: P1, goalId: null, title: 'Serving engine', status: 'blocked', blockedReason: 'Needs owner decision on serving engine', gateQuestionId: 'oq_serve111-dddd', createdAt: old(), updatedAt: inWindow() },
      { id: 't2', projectId: P1, goalId: null, title: 'Scope', status: 'blocked', blockedReason: 'Owner decision needed: pick serving engine', gateQuestionId: 'oq_scope222-eeee', createdAt: old(), updatedAt: inWindow() },
      { id: 't3', projectId: P1, goalId: null, title: 'Infra', status: 'blocked', blockedReason: 'Provider connection dropped mid-run; needs restart', createdAt: old(), updatedAt: inWindow() },
      { id: 't4', projectId: P1, goalId: null, title: 'API', status: 'blocked', blockedReason: 'Upstream API dropped the session', createdAt: old(), updatedAt: inWindow() },
    ];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_serve111-dddd', createdAt: inWindow(), userId: OWNER },
      { id: 'oq_scope222-eeee', createdAt: inWindow(), userId: OWNER },
    ]);
    messages = [{ chatId: 'c1', role: 'user', content: 'keep going', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention');
    expect(p1.attentionItems).toHaveLength(4);
  });

  it('a CANCELLED schedule is not a schedule_error item; error/failed still are (ticket 821d944d)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    schedules = [
      { id: 's1', sessionId: 'c1', prompt: 'one-shot box-retry', lastStatus: 'cancelled', lastFiredAt: inWindow(), enabled: false, kind: 'once', runsCount: 1 },
      { id: 's2', sessionId: 'c1', prompt: 'hourly monitor', lastStatus: 'error: lease expired', lastFiredAt: inWindow(), enabled: true, kind: 'recurring', runsCount: 40 },
    ];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    const kinds = p1.attentionItems.map((i: any) => `${i.kind}:${i.scheduleId}`);
    expect(kinds).toEqual(['schedule_error:s2']);
  });

  it('blocked items + a heartbeating run (no messages) → needs_attention, NOT blocked', async () => {
    // Second activity leg: runs.active (a heartbeat inside the window) also
    // proves the project is working even when no message landed this hour.
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    todos = [{
      id: 't1', projectId: P1, goalId: null, title: 'Wire auth', status: 'blocked',
      blockedReason: null, createdAt: old(), updatedAt: inWindow(),
    }];
    windowRuns = [{ id: 'r1', sessionId: 'c1', status: 'running', createdAt: old(), heartbeatAt: inWindow() }];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention');
    expect(p1.attentionItems.map((i: any) => i.kind)).toEqual(['blocked_todo']);
  });

  it('blocked + run wedged in the 15–60 min band → needs_attention with the stall listed (accepted band, review NB3)', async () => {
    // Documents the designed behavior: STALLED_RUN_MS (15m) < DIGEST_WINDOW_MS
    // (1h), so a freshly-wedged run counts as activity AND as a stalled item —
    // the bucket self-heals to 'blocked' only once the heartbeat ages past 1h.
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    todos = [{
      id: 't1', projectId: P1, goalId: null, title: 'Wire auth', status: 'blocked',
      blockedReason: null, createdAt: old(), updatedAt: inWindow(),
    }];
    const wedged = { id: 'r1', sessionId: 'c1', status: 'running', createdAt: old(), startedAt: old(), heartbeatAt: staleBeat(), updatedAt: staleBeat() };
    windowRuns = [wedged];   // stats pool: heartbeat 16m ago < 1h window → runs.active
    runningRuns = [wedged];  // stalled pool: 16m > STALLED_RUN_MS → stalled_session item

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention');
    expect(p1.attentionItems.map((i: any) => i.kind)).toEqual(
      expect.arrayContaining(['blocked_todo', 'stalled_session']),
    );
  });

  it('classifies needs_attention when signals exist but nothing is blocked', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    windowRuns = [{ id: 'r1', sessionId: 'c1', status: 'failed', error: 'boom', createdAt: old(), finishedAt: inWindow() }];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention');
    expect(p1.attentionItems.map((i: any) => i.kind)).toEqual(['failed_run']);
  });

  it('a recurring cadence STOPPED in the last 24h is an attention item regardless of lastStatus (forensics fix 3a)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    schedules = [
      // The invisible class: run-cap disable leaves lastStatus 'started' — the
      // error regex never matched it, so the project read as idle, not stopped.
      { id: 's-stop', sessionId: 'c1', enabled: false, kind: 'recurring', runsCount: 5, lastFiredAt: inWindow(), lastStatus: 'started', prompt: 'tt-rd hourly watch' },
      // Guards: stopped >24h ago / too little history / one-shot — all quiet.
      { id: 's-old', sessionId: 'c1', enabled: false, kind: 'recurring', runsCount: 9, lastFiredAt: new Date(Date.now() - 25 * 3600_000), lastStatus: 'expired', prompt: 'ancient watch' },
      { id: 's-young', sessionId: 'c1', enabled: false, kind: 'recurring', runsCount: 2, lastFiredAt: inWindow(), lastStatus: 'started', prompt: 'no history yet' },
      { id: 's-once', sessionId: 'c1', enabled: false, kind: 'once', runsCount: 5, lastFiredAt: inWindow(), lastStatus: 'started', prompt: 'one-shot' },
    ];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention'); // idle ≠ stopped
    const scheduleItems = p1.attentionItems.filter((i: any) => i.kind === 'schedule_error');
    expect(scheduleItems).toHaveLength(1);
    expect(scheduleItems[0]).toMatchObject({ scheduleId: 's-stop', chatId: 'c1', title: 'tt-rd hourly watch' });
    expect(scheduleItems[0].detail).toContain('stopped after 5 runs');
    expect(scheduleItems[0].detail).toContain('will not resume on its own');
  });

  it('a fresh queue row (< threshold) is depth, NOT a stuck item; a fresh heartbeat is not stalled', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    queued = [{ id: 'q1', chatId: 'c1', content: 'ping', createdAt: inWindow(), source: 'user' }];
    // A long run that started before the window but heartbeats through it:
    // visible to BOTH run queries (window + running), counted as activity, not stalled.
    const liveRun = { id: 'r2', sessionId: 'c1', status: 'running', error: null, createdAt: old(), finishedAt: null, heartbeatAt: inWindow(), updatedAt: inWindow(), startedAt: old() };
    windowRuns = [liveRun];
    runningRuns = [liveRun];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('on_track'); // the heartbeating run counts as window activity
    expect(p1.attentionItems).toEqual([]);
    expect(p1.stats.queuedMessages).toBe(1);
    expect(p1.stats.runs).toMatchObject({ started: 0, active: 1 });
  });

  it('an OLD queue row behind a fresh-heartbeat run is NOT stuck (the drain is deferred, not failed)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    queued = [{ id: 'q1', chatId: 'c1', content: 'ping', createdAt: stuckAt(), source: 'user' }];
    const liveRun = { id: 'r2', sessionId: 'c1', status: 'running', error: null, createdAt: old(), finishedAt: null, heartbeatAt: inWindow(), updatedAt: inWindow(), startedAt: old() };
    windowRuns = [liveRun];
    runningRuns = [liveRun];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.attentionItems).toEqual([]);             // no stuck_message
    expect(p1.stats.queuedMessages).toBe(1);           // queue depth still reported
    expect(p1.status).toBe('on_track');
  });

  it('the SAME old queue row IS a stuck_message when the chat has no live run', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    queued = [{ id: 'q1', chatId: 'c1', content: 'ping', createdAt: stuckAt(), source: 'user' }];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.attentionItems.map((i: any) => i.kind)).toEqual(['stuck_message']);
    expect(p1.status).toBe('needs_attention');
  });

  it('a STALE-heartbeat run does not suppress stuck_message (and is itself stalled_session)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    queued = [{ id: 'q1', chatId: 'c1', content: 'ping', createdAt: stuckAt(), source: 'user' }];
    runningRuns = [{ id: 'r2', sessionId: 'c1', heartbeatAt: staleBeat(), updatedAt: staleBeat(), startedAt: old() }];

    await runProjectDigestOnce();

    const kinds = createdFor(P1).attentionItems.map((i: any) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['stuck_message', 'stalled_session']));
  });
});

// ── awaiting_input (durable Postgres leg + ephemeral Redis leg) ──────────────

describe('awaiting_input attention items', () => {
  /** A live (fresh-heartbeat) 'running' run on chatId — the ephemeral-leg probe pool. */
  const liveRunOn = (chatId: string) => ({
    id: `r-${chatId}`, sessionId: chatId, status: 'running', error: null,
    createdAt: old(), finishedAt: null, heartbeatAt: inWindow(), updatedAt: inWindow(), startedAt: old(),
  });
  /** A live staged confirmation row (what digestUser's pendingConfirmation query returns). */
  const pendingRow = (chatId: string, summary: string | null = 'Delete 3 files?') => ({
    chatId, userId: OWNER, summary, status: 'pending',
    createdAt: inWindow(), expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  /** Bucket P1 with one chat whose live run reports the given Redis attention. */
  function setupEphemeral(attention: { approvals: string[]; questions: string[] }) {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    const run = liveRunOn('c1');
    // A live run is visible to BOTH agentRun queries (window + running pool) —
    // its fresh heartbeat satisfies the window OR-clause (see the stale-
    // heartbeat tests above for the same pattern).
    windowRuns = [run];
    runningRuns = [run];
    mockGetSessionAttention.mockResolvedValue(attention);
  }
  /** Every attention item written across ALL buckets this sweep. */
  const allCreatedItems = (): any[] =>
    mockPrisma.projectDigest.create.mock.calls.flatMap((c: any[]) => c[0].data.attentionItems);

  it('durable leg: a pending confirmation lands ONLY in the bucket owning its chat', async () => {
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c2', title: 'Two', projectId: P2 },
    ];
    projects = [{ id: P1, name: 'Alpha' }, { id: P2, name: 'Beta' }];
    pendingConfirmations = [pendingRow('c1')];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention'); // awaiting input outranks on_track, isn't blocked
    expect(p1.attentionItems).toHaveLength(1);
    expect(p1.attentionItems[0]).toMatchObject({
      kind: 'awaiting_input', title: 'One', detail: 'Delete 3 files?', chatId: 'c1',
    });
    expect(typeof p1.attentionItems[0].at).toBe('string');
    expect(createdFor(P2).attentionItems).toEqual([]); // bucket B owns no pending chat
  });

  it('durable leg: the summary detail is sliced to 120 chars (empty summary → null)', async () => {
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c2', title: 'Two', projectId: P1 },
    ];
    projects = [{ id: P1, name: 'Alpha' }];
    const long = 'x'.repeat(200);
    pendingConfirmations = [pendingRow('c1', long), pendingRow('c2', '')];

    await runProjectDigestOnce();

    const items = createdFor(P1).attentionItems.filter((i: any) => i.kind === 'awaiting_input');
    expect(items).toHaveLength(2);
    expect(items.find((i: any) => i.chatId === 'c1').detail).toBe(long.slice(0, 120));
    expect(items.find((i: any) => i.chatId === 'c2').detail).toBeNull();
  });

  it("durable leg: a hidden fleet chat's confirmation lands in NO bucket", async () => {
    chats = [
      { id: 'sup-1', title: 'Fleet Supervisor', projectId: null },
      { id: 'c1', title: 'One', projectId: P1 },
    ];
    projects = [{ id: P1, name: 'Alpha' }];
    mockHidden.mockResolvedValue({ chatIds: ['sup-1'], projectIds: [] });
    pendingConfirmations = [pendingRow('sup-1')];

    await runProjectDigestOnce();

    expect(mockPrisma.projectDigest.create).toHaveBeenCalledTimes(1); // only the P1 bucket
    expect(createdFor(null)).toBeUndefined(); // sup-1 hidden ⇒ no ungrouped bucket
    expect(allCreatedItems().filter((i) => i.kind === 'awaiting_input')).toEqual([]);
  });

  it('ephemeral leg: a live run with pending questions yields a "Waiting on your answer" item', async () => {
    setupEphemeral({ approvals: [], questions: ['q1'] });

    await runProjectDigestOnce();

    expect(mockGetSessionAttention).toHaveBeenCalledWith('c1');
    const p1 = createdFor(P1);
    expect(p1.status).toBe('needs_attention');
    expect(p1.attentionItems).toHaveLength(1);
    expect(p1.attentionItems[0]).toMatchObject({
      kind: 'awaiting_input', title: 'One', detail: 'Waiting on your answer', chatId: 'c1',
    });
    expect(typeof p1.attentionItems[0].at).toBe('string');
  });

  it('ephemeral leg: approvals-only yields a "Waiting on a permission approval" item', async () => {
    setupEphemeral({ approvals: ['a1', 'a2'], questions: [] });

    await runProjectDigestOnce();

    expect(createdFor(P1).attentionItems[0]).toMatchObject({
      kind: 'awaiting_input', detail: 'Waiting on a permission approval', chatId: 'c1',
    });
  });

  it('ephemeral leg: approvals AND questions yield a "Waiting on your input" item', async () => {
    setupEphemeral({ approvals: ['a1'], questions: ['q1'] });

    await runProjectDigestOnce();

    expect(createdFor(P1).attentionItems[0]).toMatchObject({
      kind: 'awaiting_input', detail: 'Waiting on your input', chatId: 'c1',
    });
  });

  it('a chat already flagged by the durable leg is NOT double-flagged by the Redis probe', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    runningRuns = [liveRunOn('c1')];
    pendingConfirmations = [pendingRow('c1')];
    mockGetSessionAttention.mockResolvedValue({ approvals: [], questions: ['q1'] });

    await runProjectDigestOnce();

    const items = createdFor(P1).attentionItems.filter((i: any) => i.kind === 'awaiting_input');
    expect(items).toHaveLength(1);
    expect(items[0].detail).toBe('Delete 3 files?'); // the durable item, not 'Waiting on your answer'
    expect(mockGetSessionAttention).not.toHaveBeenCalled(); // no unflagged live-run chat left to probe
  });

  it('a rejected getSessionAttention degrades to "nothing pending" — sweep completes, no item', async () => {
    setupEphemeral({ approvals: [], questions: [] });
    mockGetSessionAttention.mockRejectedValue(new Error('redis down'));

    await expect(runProjectDigestOnce()).resolves.toBeUndefined();

    const p1 = createdFor(P1);
    expect(p1.attentionItems.filter((i: any) => i.kind === 'awaiting_input')).toEqual([]);
    expect(p1.status).toBe('on_track'); // the heartbeating run is still plain activity
  });

  it('a hard Redis-leg failure logs a warn and the rest of the sweep still lands', async () => {
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c2', title: 'Two', projectId: P2 },
    ];
    projects = [{ id: P1, name: 'Alpha' }, { id: P2, name: 'Beta' }];
    runningRuns = [liveRunOn('c1')];
    // A SYNC throw (e.g. the dynamic import itself blew up) escapes the per-chat
    // .catch and hits the leg-level try/catch — the path that logs the warn.
    mockGetSessionAttention.mockImplementation(() => { throw new Error('redis hard down'); });

    await expect(runProjectDigestOnce()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Redis attention leg failed'));
    expect(createdFor(P1).attentionItems).toEqual([]);
    expect(createdFor(P2)).toBeDefined(); // the other bucket still digested
  });

  it('no pendings anywhere ⇒ zero awaiting_input items (regression guard)', async () => {
    setupEphemeral({ approvals: [], questions: [] });
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    expect(mockGetSessionAttention).toHaveBeenCalledWith('c1'); // the probe ran and found nothing
    expect(allCreatedItems().filter((i) => i.kind === 'awaiting_input')).toEqual([]);
    expect(createdFor(P1).attentionItems).toEqual([]);
  });
});

// ── Signature skip ────────────────────────────────────────────────────────────

describe('signature skip-unchanged', () => {
  /** First sweep lands a row; the stored signature becomes the existing row's. */
  async function primeExistingRow(): Promise<string> {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];
    await runProjectDigestOnce();
    expect(mockPrisma.projectDigest.create).toHaveBeenCalledTimes(1);
    const signature = mockPrisma.projectDigest.create.mock.calls[0][0].data.signature;
    expect(typeof signature).toBe('string');
    existingDigest = { id: 'dg1', signature };
    mockPrisma.projectDigest.create.mockClear();
    mockPrisma.projectDigest.update.mockClear();
    mockUtilityChat.mockClear();
    return signature;
  }

  it('a second sweep with identical inputs spends no LLM and writes no new row', async () => {
    await primeExistingRow();
    await runProjectDigestOnce();
    expect(mockPrisma.projectDigest.create).not.toHaveBeenCalled();
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('…but still touches the row (window bounds only) so updatedAt freshness survives quiet buckets', async () => {
    await primeExistingRow();
    await runProjectDigestOnce();
    expect(mockPrisma.projectDigest.update).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.projectDigest.update.mock.calls[0][0];
    expect(arg.where).toEqual({ id: 'dg1' });
    expect(arg.data.windowStart).toBeInstanceOf(Date);
    expect(arg.data.windowEnd).toBeInstanceOf(Date);
    // The cheap touch must NOT rewrite the LLM/content fields.
    expect(arg.data.summary).toBeUndefined();
    expect(arg.data.attentionItems).toBeUndefined();
    expect(arg.data.stats).toBeUndefined();
    expect(arg.data.signature).toBeUndefined();
  });

  it('is order-independent: same logical data in different findMany orders ⇒ same signature ⇒ no LLM', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    // Mixed origins (byOrigin insertion order varies with row order) …
    messages = [
      { chatId: 'c1', role: 'user', content: 'a', metadata: { origin: 'schedule' }, createdAt: inWindow() },
      { chatId: 'c1', role: 'user', content: 'b', metadata: null, createdAt: inWindow() },
      { chatId: 'c1', role: 'assistant', content: 'c', metadata: { origin: 'heartbeat' }, createdAt: inWindow() },
      { chatId: 'c1', role: 'assistant', content: 'd', metadata: null, createdAt: inWindow() },
    ];
    // … and multiple same-kind attention items (push order varies with row order).
    goals = [
      { id: 'g1', projectId: P1, title: 'Goal A', status: 'blocked', blockedReason: null, createdAt: old(), updatedAt: inWindow() },
      { id: 'g2', projectId: P1, title: 'Goal B', status: 'blocked', blockedReason: null, createdAt: old(), updatedAt: inWindow() },
    ];
    todos = [
      { id: 't1', projectId: P1, goalId: null, title: 'Todo A', status: 'blocked', blockedReason: null, createdAt: old(), updatedAt: inWindow() },
      { id: 't2', projectId: P1, goalId: null, title: 'Todo B', status: 'blocked', blockedReason: 'x', createdAt: old(), updatedAt: inWindow() },
    ];

    await runProjectDigestOnce();
    expect(mockUtilityChat).toHaveBeenCalled();
    const signature = mockPrisma.projectDigest.create.mock.calls[0][0].data.signature;
    existingDigest = { id: 'dg1', signature };
    mockPrisma.projectDigest.create.mockClear();
    mockUtilityChat.mockClear();

    // Second sweep: identical logical data, REVERSED query results.
    messages = [...messages].reverse();
    goals = [...goals].reverse();
    todos = [...todos].reverse();

    await runProjectDigestOnce();
    expect(mockUtilityChat).not.toHaveBeenCalled();      // signature matched
    expect(mockPrisma.projectDigest.create).not.toHaveBeenCalled();
    // … and the cheap touch still landed.
    expect(mockPrisma.projectDigest.update).toHaveBeenCalledWith({
      where: { id: 'dg1' },
      data: { windowStart: expect.any(Date), windowEnd: expect.any(Date) },
    });
  });

  it('changed inputs update the existing row in place (same id)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];
    existingDigest = { id: 'dg1', signature: 'stale-signature' };

    await runProjectDigestOnce();
    expect(mockPrisma.projectDigest.create).not.toHaveBeenCalled();
    expect(mockPrisma.projectDigest.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.projectDigest.update.mock.calls[0][0].where).toEqual({ id: 'dg1' });
    expect(mockPrisma.projectDigest.update.mock.calls[0][0].data.signature).not.toBe('stale-signature');
  });

  it('volatile attention-item timestamps (ephemeral awaiting_input stamps the sweep time) do NOT defeat the skip', async () => {
    // A run parked on an ask_user question: the Redis leg stamps `at: iso(now)`
    // — different every sweep — while the underlying state is identical. The
    // signature must ignore `at` or this bucket regenerates hourly forever.
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    const run = {
      id: 'r1', sessionId: 'c1', status: 'running', error: null,
      createdAt: old(), finishedAt: null, heartbeatAt: inWindow(), updatedAt: inWindow(), startedAt: old(),
    };
    windowRuns = [run];
    runningRuns = [run];
    mockGetSessionAttention.mockResolvedValue({ approvals: [], questions: ['q1'] });

    await runProjectDigestOnce();
    const first = createdFor(P1);
    expect(first.attentionItems[0]).toMatchObject({ kind: 'awaiting_input' });
    existingDigest = { id: 'dg1', signature: first.signature };
    mockPrisma.projectDigest.create.mockClear();
    mockPrisma.projectDigest.update.mockClear();
    mockUtilityChat.mockClear();

    await runProjectDigestOnce();
    expect(mockUtilityChat).not.toHaveBeenCalled(); // signature matched despite the fresh `at`
    expect(mockPrisma.projectDigest.create).not.toHaveBeenCalled();
    expect(mockPrisma.projectDigest.update).toHaveBeenCalledWith({
      where: { id: 'dg1' },
      data: { windowStart: expect.any(Date), windowEnd: expect.any(Date) },
    });
  });

  it('stamps stats.generatedAt on every content write (the honest generation time for the API)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(typeof p1.stats.generatedAt).toBe('string');
    expect(Number.isNaN(new Date(p1.stats.generatedAt).getTime())).toBe(false);
    // The stamp must not perturb the signature: recomputing WITHOUT it matches.
    const { generatedAt: _g, ...statsSansStamp } = p1.stats;
    expect(
      computeDigestSignature({ status: p1.status, stats: statsSansStamp, attentionItems: p1.attentionItems }),
    ).toBe(p1.signature);
  });

  it('computeDigestSignature ignores the window bounds', () => {
    const stats: DigestStats = {
      chatCount: 1, activeChats: 0,
      messages: { total: 0, user: 0, assistant: 0, byOrigin: {} },
      runs: { started: 0, completed: 0, failed: 0, active: 0 },
      todos: { total: 0, done: 0, blocked: 0, dropped: 0, createdInWindow: 0, completedInWindow: 0 },
      goals: { total: 0, done: 0, blocked: 0, createdInWindow: 0, completedInWindow: 0, archived: 0, lastFinishedAt: null },
      schedules: { firedInWindow: 0, errored: 0 },
      queuedMessages: 0,
    };
    const attentionItems: DigestAttentionItem[] = [];
    const a = computeDigestSignature({ status: 'idle', stats, attentionItems });
    const b = computeDigestSignature({ status: 'idle', stats: { ...stats }, attentionItems: [] });
    expect(a).toBe(b);
    expect(a).not.toBe(computeDigestSignature({ status: 'on_track', stats, attentionItems }));
  });
});

// ── Ghost-row cleanup ─────────────────────────────────────────────────────────

describe('ghost-row cleanup (digestUser)', () => {
  /** findFirst over the digestRows fixture (per-bucket existing-row lookup). */
  function findFirstFromRows() {
    mockPrisma.projectDigest.findFirst.mockImplementation((args: any) =>
      Promise.resolve(digestRows.find((r) => r.projectId === (args?.where?.projectId ?? null)) ?? null),
    );
  }

  it('deletes exactly the rows whose projectId has no bucket this run (null row kept with an ungrouped bucket)', async () => {
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c3', title: 'Loose', projectId: null },
    ];
    projects = [{ id: P1, name: 'Alpha' }];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];
    digestRows = [
      { id: 'dg-p1', userId: OWNER, projectId: P1, signature: 'old-sig' },
      { id: 'dg-ghost', userId: OWNER, projectId: 'proj-gone', signature: 'old-sig' },
      { id: 'dg-null', userId: OWNER, projectId: null, signature: 'old-sig' },
    ];
    findFirstFromRows();

    await runProjectDigestOnce();

    expect(mockPrisma.projectDigest.deleteMany).toHaveBeenCalledTimes(1);
    expect(digestRows.map((r) => r.id).sort()).toEqual(['dg-null', 'dg-p1']); // proj-gone row removed, both live buckets kept
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('1 ghost digest row(s)'));
  });

  it('also removes the null row when no ungrouped bucket exists this run', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    digestRows = [
      { id: 'dg-p1', userId: OWNER, projectId: P1, signature: 'old-sig' },
      { id: 'dg-null', userId: OWNER, projectId: null, signature: 'old-sig' },
    ];
    findFirstFromRows();

    await runProjectDigestOnce();

    expect(digestRows.map((r) => r.id)).toEqual(['dg-p1']);
  });

  it('no-op when every stored row still has a bucket', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    digestRows = [{ id: 'dg-p1', userId: OWNER, projectId: P1, signature: 'old-sig' }];
    findFirstFromRows();

    await runProjectDigestOnce();

    expect(digestRows).toHaveLength(1);
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('ghost'));
  });
});

// ── LLM fallback ──────────────────────────────────────────────────────────────

describe('summary fallback (generateTitle pattern)', () => {
  beforeEach(() => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    goals = [{
      id: 'g1', projectId: P1, title: 'Ship v2', status: 'blocked',
      blockedReason: 'waiting on API keys', createdAt: old(), updatedAt: inWindow(),
    }];
  });

  it('uses the local template when the LLM returns empty', async () => {
    mockUtilityChat.mockResolvedValue('');
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.summary).toContain('Alpha is blocked');
    expect(p1.summary).toContain('Ship v2');
    expect(p1.summary).toContain('waiting on API keys');
  });

  it('uses the local template when the LLM throws', async () => {
    mockUtilityChat.mockRejectedValue(new Error('provider down'));
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.summary).toContain('Alpha is blocked');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('utility LLM unavailable'));
  });

  it('fallbackDigestSummary pins the per-status template shapes', () => {
    const stats = createdStats();
    const items: DigestAttentionItem[] = [
      { kind: 'blocked_todo', title: 'Wire auth', detail: 'no creds', todoId: 't1', at: '2026-08-13T00:00:00.000Z' },
    ];
    expect(fallbackDigestSummary('Alpha', 'blocked', stats, items)).toContain('Alpha is blocked — 1 blocked item(s)');
    expect(fallbackDigestSummary('Alpha', 'needs_attention', stats, items)).toContain('Alpha needs attention — 1 item(s)');
    // Review 2026-09-13 issue 16: a goal-less on-track project that did work
    // gets the ONE neutral sentence, not the old activity boilerplate.
    expect(fallbackDigestSummary('Alpha', 'on_track', stats, [])).toBe('No goal is being tracked for Alpha; recent work: 1 run finished, 2 assistant updates, 1 message from you in the last hour.');
    // The UNGROUPED bucket (goals cannot exist there) keeps the plain voice.
    expect(fallbackDigestSummary('Ungrouped', 'on_track', stats, [], [], null, false)).toContain('Ungrouped is active and on track');
    expect(fallbackDigestSummary('Alpha', 'idle', stats, [])).toContain('Alpha was idle in the last hour');
  });
});

// ── Review 2026-09-13 issue 16 (PULSE part): no-goal buckets speak neutrally ──

describe('review 2026-09-13 issue 16 — goal-less buckets get ONE neutral sentence', () => {
  const busyNoGoalStats = (): DigestStats => ({
    ...createdStats(),
    messages: { total: 12, user: 0, assistant: 12, byOrigin: { assistant: 12 } },
    runs: { started: 4, completed: 3, failed: 0, active: 1 },
    todos: { total: 0, done: 0, blocked: 0, dropped: 0, createdInWindow: 0, completedInWindow: 0 },
    goals: { total: 6, done: 4, blocked: 0, createdInWindow: 0, completedInWindow: 0, archived: 2, lastFinishedAt: null }, // 4 done + 2 archived = 0 tracked (spark-cluster)
  });

  it('recentWorkPhrase names only the non-zero facts in plain English', () => {
    expect(recentWorkPhrase(busyNoGoalStats())).toBe('3 runs finished, 1 still running, 12 assistant updates in the last hour');
    expect(recentWorkPhrase({ ...createdStats(), messages: { total: 0, user: 0, assistant: 0, byOrigin: {} }, runs: { started: 2, completed: 0, failed: 0, active: 0 } }))
      .toBe('2 runs started in the last hour');
    expect(recentWorkPhrase({ ...createdStats(), messages: { total: 0, user: 0, assistant: 0, byOrigin: {} }, runs: { started: 0, completed: 0, failed: 0, active: 0 } }))
      .toBe('nothing recorded in the last hour');
    expect(bucketHadActivity(busyNoGoalStats())).toBe(true);
    expect(bucketHadActivity({ ...createdStats(), messages: { total: 0, user: 0, assistant: 0, byOrigin: {} }, runs: { started: 0, completed: 0, failed: 0, active: 0 } })).toBe(false);
  });

  it('REPLAYS spark-cluster: on_track + 0 tracked goals + 86-run activity → ONE neutral sentence, no LLM call', async () => {
    mockUtilityChat.mockClear();
    const summary = await summarizeDigest('spark-cluster', 'on_track', busyNoGoalStats(), []);
    // Merged with ticket 7ee38c8e: the completion context rides inside the ONE sentence.
    expect(summary).toBe('No goal is being tracked for spark-cluster (6 goal(s) already completed); recent work: 3 runs finished, 1 still running, 12 assistant updates in the last hour.');
    expect(summary.split(/(?<=[.!?])\s+/)).toHaveLength(1);
    expect(summary).not.toMatch(/no progress|toward any goal|no active goals|no action needed/i);
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('a goal-less bucket WITH attention items still uses the LLM, but with the neutral instruction (never the negative fact)', async () => {
    mockUtilityChat.mockClear();
    mockUtilityChat.mockResolvedValueOnce('One run failed on the export step; nothing else is waiting on you. No goal is being tracked for Alpha yet.');
    const items: DigestAttentionItem[] = [{ kind: 'failed_run', title: 'Export', detail: 'boom', runId: 'r1', chatId: 'c1', at: '2026-09-13T00:00:00.000Z' }];
    const summary = await summarizeDigest('Alpha', 'needs_attention', busyNoGoalStats(), items);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const prompt = String(mockUtilityChat.mock.calls[0][0][1].content);
    expect(prompt).toContain('No goal is being tracked for this project right now (6 goal(s) already completed). Mention that in AT MOST one neutral clause');
    expect(prompt).toContain('NEVER write that no progress was made');
    expect(prompt).not.toContain('no active goals tracked');
    expect(summary).toContain('One run failed on the export step');
  });

  it('a negative no-goal verdict from the LLM ("No progress reported toward any goal") is REPLACED by the local template', async () => {
    mockUtilityChat.mockClear();
    mockUtilityChat.mockResolvedValueOnce('Alpha has no active goals tracked. No progress reported toward any goal names. No action needed.');
    const items: DigestAttentionItem[] = [{ kind: 'failed_run', title: 'Export', detail: 'boom', runId: 'r1', chatId: 'c1', at: '2026-09-13T00:00:00.000Z' }];
    const summary = await summarizeDigest('Alpha', 'needs_attention', busyNoGoalStats(), items);
    expect(summary).not.toMatch(/no progress|toward any goal|no active goals|no action needed/i);
    expect(summary).toContain('Alpha needs attention — 1 item(s), led by "Export"');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('negative no-goal verdict'));
  });

  it('the UNGROUPED bucket (goals cannot exist) is exempt from the neutral sentence and the verdict filter', async () => {
    mockUtilityChat.mockClear();
    mockUtilityChat.mockResolvedValueOnce('Two chats moved today.');
    const summary = await summarizeDigest('Ungrouped', 'on_track', busyNoGoalStats(), [], [], null, null, false);
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    expect(summary).toBe('Two chats moved today.');
    const prompt = String(mockUtilityChat.mock.calls[0][0][1].content);
    expect(prompt).toContain('goals are project-scoped; this bucket has none to report on');
    expect(prompt).not.toContain('No goal is being tracked for this project');
  });

  it('a tracked goal keeps the goal-progress voice untouched (no regression)', () => {
    const gp: DigestGoalProgress = {
      goalId: 'g1', title: 'Ship v2', status: 'active', todosDone: 3, todosTotal: 6,
      blockedCount: 0, depsBlockedCount: 0, droppedCount: 0, progressNote: null, completed24h: 1, completed7d: 3,
      eta: { remaining: 3, pacePerDay: 0.43, etaDays: 7, class: 'on_pace' },
    };
    const summary = fallbackDigestSummary('Alpha', 'on_track', busyNoGoalStats(), [], [gp], null);
    expect(summary).toContain('Alpha is active and on track');
    expect(summary).toContain('3 of 6 tasks done toward "Ship v2"');
    expect(summary).not.toContain('No goal is being tracked');
  });
});

function createdStats(): DigestStats {
  return {
    chatCount: 2, activeChats: 1,
    messages: { total: 3, user: 1, assistant: 2, byOrigin: { user: 1, assistant: 2 } },
    runs: { started: 1, completed: 1, failed: 0, active: 0 },
    todos: { total: 1, done: 0, blocked: 1, dropped: 0, createdInWindow: 0, completedInWindow: 0 },
    goals: { total: 1, done: 0, blocked: 0, createdInWindow: 0, completedInWindow: 0, archived: 0, lastFinishedAt: null },
    schedules: { firedInWindow: 0, errored: 0 },
    queuedMessages: 0,
  };
}

// ── Project Pulse: goal progress + honest ETA (owner 2026-09-04) ─────────────

describe('ETA math (computeGoalEta — pure pins)', () => {
  it('on_pace: pace = completed7d / 7, etaDays = remaining / pace (1 decimal)', () => {
    const eta = computeGoalEta({ remaining: 11, blockedGate: false, completed24h: 2, completed7d: 7 });
    expect(eta).toEqual({ remaining: 11, pacePerDay: 1, etaDays: 11, class: 'on_pace' });
    const eta2 = computeGoalEta({ remaining: 5, blockedGate: false, completed24h: 0, completed7d: 3 });
    expect(eta2.pacePerDay).toBeCloseTo(0.43, 2);
    expect(eta2.etaDays).toBeCloseTo(11.6, 1);
    expect(eta2.class).toBe('on_pace');
  });

  it('24h fallback: an empty 7d window falls back to the trailing-24h count as the daily rate', () => {
    // Defensive branch: with the updatedAt proxy 7d ⊇ 24h, so this fires only
    // if the two counts are ever sourced differently — pinned regardless.
    const eta = computeGoalEta({ remaining: 6, blockedGate: false, completed24h: 2, completed7d: 0 });
    expect(eta.pacePerDay).toBe(2);
    expect(eta.etaDays).toBe(3);
    expect(eta.class).toBe('on_pace');
  });

  it('no_movement: remaining > 0 and zero pace ⇒ no estimate, never a fabricated one', () => {
    const eta = computeGoalEta({ remaining: 4, blockedGate: false, completed24h: 0, completed7d: 0 });
    expect(eta).toEqual({ remaining: 4, pacePerDay: 0, etaDays: null, class: 'no_movement' });
  });

  it('blocked outranks a finite pace (the gate makes the pace untrustworthy) but etaDays stays computed', () => {
    const eta = computeGoalEta({ remaining: 10, blockedGate: true, completed24h: 1, completed7d: 7 });
    expect(eta.class).toBe('blocked');
    expect(eta.etaDays).toBe(10); // both facts stay honest — the UI can show them
  });

  it('done: nothing remaining wins over everything', () => {
    const eta = computeGoalEta({ remaining: 0, blockedGate: true, completed24h: 0, completed7d: 5 });
    expect(eta.class).toBe('done');
    expect(eta.etaDays).toBeNull();
  });
});

describe('goalEtaPhrase — the honest phrases the prompt and template must use', () => {
  const eta = (over: Partial<ReturnType<typeof computeGoalEta>>) =>
    ({ remaining: 1, pacePerDay: 0, etaDays: null, class: 'no_movement', ...over }) as any;

  it('never fabricates a calendar date — every phrase is relative or a plain fact', () => {
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'on_pace', etaDays: 3.2 }) }))
      .toBe('at the current pace roughly 3 more days');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'on_pace', etaDays: 0.4 }) }))
      .toBe('at the current pace roughly a day to go');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'no_movement' }) }))
      .toBe('no movement in the last week, so no reliable estimate');
    expect(goalEtaPhrase({ blockedCount: 1, eta: eta({ class: 'blocked' }) }))
      .toBe('one blocked task is gating progress');
    expect(goalEtaPhrase({ blockedCount: 3, eta: eta({ class: 'blocked' }) }))
      .toBe('3 blocked tasks are gating progress');
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'blocked' }) }))
      .toBe('the goal is blocked, gating progress'); // the goal row itself is blocked
    expect(goalEtaPhrase({ blockedCount: 0, eta: eta({ class: 'done', remaining: 0 }) }))
      .toBe('all tasks done');
  });
});

describe('computeGoalProgress / computeEtaSummary (pure pins)', () => {
  const NOW = new Date('2026-09-04T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const goalRow = (id: string, title: string, status = 'active') => ({ id, title, status });
  const todoRow = (goalId: string, status: string, updatedAt: Date) => ({ goalId, status, updatedAt });

  it('tracks ONLY active + blocked goals; done/archived are history', () => {
    const gp = computeGoalProgress(
      [goalRow('g1', 'Live'), goalRow('g2', 'Shipped', 'done'), goalRow('g3', 'Old', 'archived'), goalRow('g4', 'Stuck', 'blocked')],
      [],
      NOW,
    );
    expect(gp.map((g) => g.goalId).sort()).toEqual(['g1', 'g4']);
  });

  it('counts done/blocked todos + trailing 24h/7d completions via the updatedAt proxy', () => {
    const gp = computeGoalProgress(
      [goalRow('g1', 'Optimal multi-model routing')],
      [
        todoRow('g1', 'done', hoursAgo(2)),        // in 24h AND 7d
        todoRow('g1', 'done', hoursAgo(3 * 24)),   // 7d only
        todoRow('g1', 'done', hoursAgo(9 * 24)),   // outside both — still counts as done
        todoRow('g1', 'blocked', hoursAgo(1)),
        todoRow('g1', 'pending', hoursAgo(1)),
        todoRow('other-goal', 'done', hoursAgo(1)), // another goal's todo — excluded
      ],
      NOW,
    );
    expect(gp).toHaveLength(1);
    expect(gp[0]).toMatchObject({
      goalId: 'g1', title: 'Optimal multi-model routing', status: 'active',
      todosDone: 3, todosTotal: 5, blockedCount: 1, depsBlockedCount: 0, droppedCount: 0, progressNote: null, completed24h: 1, completed7d: 2,
    });
    // The blocked todo gates the class; the pace facts stay computed.
    expect(gp[0].eta.class).toBe('blocked');
    expect(gp[0].eta.remaining).toBe(2);
    expect(gp[0].eta.pacePerDay).toBeCloseTo(2 / 7, 2);
  });

  it('sorts blocked-status goals first (the cap can never hide a gate) and caps the list', () => {
    const goals = [
      ...Array.from({ length: MAX_GOAL_PROGRESS_ITEMS + 2 }, (_, i) => goalRow(`g${i}`, `A goal ${String(i).padStart(2, '0')}`)),
      goalRow('g-stuck', 'Zz last alphabetically', 'blocked'),
    ];
    const gp = computeGoalProgress(goals, [], NOW);
    expect(gp).toHaveLength(MAX_GOAL_PROGRESS_ITEMS);
    expect(gp[0].goalId).toBe('g-stuck'); // blocked first despite sorting last by title
  });

  it('etaSummary: null without goals; aggregates counts; blocked ONLY when every unfinished goal is gated', () => {
    expect(computeEtaSummary([])).toBeNull();
    const paced: DigestGoalProgress = {
      goalId: 'g1', title: 'Paced', status: 'active', todosDone: 7, todosTotal: 18,
      blockedCount: 0, depsBlockedCount: 0, droppedCount: 0, progressNote: null, completed24h: 2, completed7d: 7,
      eta: { remaining: 11, pacePerDay: 1, etaDays: 11, class: 'on_pace' },
    };
    const gated: DigestGoalProgress = {
      goalId: 'g2', title: 'Gated', status: 'blocked', todosDone: 1, todosTotal: 3,
      blockedCount: 1, depsBlockedCount: 0, droppedCount: 0, progressNote: null, completed24h: 0, completed7d: 0,
      eta: { remaining: 2, pacePerDay: 0, etaDays: null, class: 'blocked' },
    };
    // One gate on a project that is still completing work ⇒ NOT blocked at the
    // project level (the 547df1ff / 821d944d cry-wolf class) — the gate stays
    // visible via goalsBlocked/blockedCount and the per-goal row.
    const mixed = computeEtaSummary([paced, gated])!;
    expect(mixed).toMatchObject({
      goalsTracked: 2, goalsBlocked: 1, todosDone: 8, todosTotal: 21,
      todosRemaining: 13, blockedCount: 1, pacePerDay: 1, etaDays: 13, class: 'on_pace',
    });
    // Every unfinished goal gated ⇒ the path is gated ⇒ blocked rollup.
    const allGated = computeEtaSummary([gated])!;
    expect(allGated.class).toBe('blocked');
    // All goals done ⇒ done.
    const done: DigestGoalProgress = {
      ...paced, goalId: 'g3', title: 'Done', todosDone: 4, todosTotal: 4,
      eta: { remaining: 0, pacePerDay: 0.57, etaDays: null, class: 'done' },
    };
    expect(computeEtaSummary([done])!.class).toBe('done');
  });
});

describe('digest sweep — goal progress + ETA on the stored row', () => {
  /** One project bucket with the canonical paced fixture: 18 todos, 7 done in
   *  the trailing week ⇒ pace 1/day, 11 remaining ⇒ "roughly 11 more days". */
  function setupPacedGoal() {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    goals = [{
      id: 'g1', projectId: P1, title: 'Optimal multi-model routing', status: 'active',
      blockedReason: null, createdAt: old(), updatedAt: old(),
    }];
    const daysAgo = (d: number) => new Date(Date.now() - d * 864e5);
    todos = [
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `t-done-${i}`, projectId: P1, goalId: 'g1', title: `done ${i}`, status: 'done',
        blockedReason: null, createdAt: old(), updatedAt: daysAgo(i * 0.9 + 0.05), // spread inside 7d — the +0.05 (was +0.1) keeps i=1 at 0.95d, CLEAR of the exact 24h completed24h boundary: at 1.0d the count flipped 2→1 on sub-second drift between the two sweeps (deploy-gate flake 2026-09-04, run 33909053508 — signature moved, skip failed ~15% of runs)
      })),
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `t-open-${i}`, projectId: P1, goalId: 'g1', title: `open ${i}`, status: 'pending',
        blockedReason: null, createdAt: old(), updatedAt: old(),
      })),
    ];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];
  }

  it('stores structured goalProgress + etaSummary on the row (paced case)', async () => {
    setupPacedGoal();
    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.goalProgress).toHaveLength(1);
    expect(p1.goalProgress[0]).toMatchObject({
      goalId: 'g1', title: 'Optimal multi-model routing', status: 'active',
      todosDone: 7, todosTotal: 18, blockedCount: 0, completed7d: 7,
      eta: { remaining: 11, pacePerDay: 1, etaDays: 11, class: 'on_pace' },
    });
    expect(p1.etaSummary).toMatchObject({
      goalsTracked: 1, goalsBlocked: 0, todosDone: 7, todosTotal: 18,
      todosRemaining: 11, pacePerDay: 1, etaDays: 11, class: 'on_pace',
    });
  });

  it('ticket C1: the goal query selects `premises`; a deadline premise due tomorrow flips the paced row to behind_deadline on the stored row AND the summary prompt', async () => {
    setupPacedGoal();
    goals[0].premises = [
      { key: 'untrained_base_suite_mean', value: 0.42 },
      { key: 'sft2_start_by_unixts', value: Math.floor((Date.now() + 864e5) / 1000), setAt: old().toISOString() },
    ];
    await runProjectDigestOnce();

    const goalSelect = mockPrisma.projectGoal.findMany.mock.calls[0][0].select;
    expect(goalSelect.premises).toBe(true);
    const p1 = createdFor(P1);
    expect(p1.goalProgress[0].eta).toMatchObject({
      remaining: 11, etaDays: 11, class: 'behind_deadline',
      deadline: { key: 'sft2_start_by_unixts', daysLeft: 1 },
    });
    expect(p1.goalProgress[0]).toMatchObject({ staleDepsBlockedCount: 0, held: false });
    expect(p1.etaSummary).toMatchObject({ class: 'behind_deadline', deadline: { key: 'sft2_start_by_unixts' } });
    // The honest phrase reaches the LLM verbatim (the prompt copies it; never a date).
    expect(JSON.stringify(mockUtilityChat.mock.calls[0])).toContain('behind the sft2 start deadline (due in a day)');
  });

  it('review fix 2026-09-27: both queries select `blockedAt`; a deps-blocked todo STAMPED 18 days ago but touched 1 h ago gates the stored row (updatedAt no longer restarts the clock)', async () => {
    setupPacedGoal();
    todos.push({
      id: 't-deps', projectId: P1, goalId: 'g1', title: 'dep-blocked', status: 'blocked',
      blockKind: 'deps', blockedReason: '[deps] Waiting on 1 todo',
      blockedAt: new Date(Date.now() - 18 * 864e5), createdAt: old(), updatedAt: new Date(Date.now() - 3_600_000),
    });
    await runProjectDigestOnce();

    expect(mockPrisma.projectTodo.findMany.mock.calls[0][0].select.blockedAt).toBe(true);
    expect(mockPrisma.projectGoal.findMany.mock.calls[0][0].select.blockedAt).toBe(true);
    const p1 = createdFor(P1);
    expect(p1.goalProgress[0]).toMatchObject({ blockedCount: 1, depsBlockedCount: 1, staleDepsBlockedCount: 1, eta: { class: 'blocked' } });
    expect(JSON.stringify(mockUtilityChat.mock.calls[0])).toContain('one dependency-blocked task has waited over 3 days, gating progress');
  });

  it('review fix 2026-09-27: an out-of-range deadline premise (1e20 ms) is not a deadline and does NOT throw the bucket — the row is still written', async () => {
    setupPacedGoal();
    goals[0].premises = [{ key: 'x_deadline', value: 1e20, unit: 'ms' }, { key: 'y_by_unixts', value: 1e16 }];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.goalProgress[0].eta).toMatchObject({ class: 'on_pace', etaDays: 11 });
    expect('deadline' in p1.goalProgress[0].eta).toBe(false);
  });

  it('a project with NO goals stores [] + SQL-null etaSummary (and the ungrouped bucket always does)', async () => {
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c2', title: 'Loose', projectId: null },
    ];
    projects = [{ id: P1, name: 'Alpha' }];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];

    await runProjectDigestOnce();

    expect(createdFor(P1).goalProgress).toEqual([]);
    expect(createdFor(P1).etaSummary).toBe(Prisma.DbNull); // nullable-Json contract
    expect(createdFor(null).goalProgress).toEqual([]);
    expect(createdFor(null).etaSummary).toBe(Prisma.DbNull);
  });

  it('a blocked todo classifies the goal blocked; zero completions classify no_movement', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    goals = [
      { id: 'g1', projectId: P1, title: 'Gated goal', status: 'active', blockedReason: null, createdAt: old(), updatedAt: old() },
      { id: 'g2', projectId: P1, title: 'Sleepy goal', status: 'active', blockedReason: null, createdAt: old(), updatedAt: old() },
    ];
    const eightDaysAgo = new Date(Date.now() - 8 * 864e5);
    todos = [
      { id: 't1', projectId: P1, goalId: 'g1', title: 'stuck', status: 'blocked', blockedReason: '[deps] Waiting on 1 todo', createdAt: old(), updatedAt: old() },
      { id: 't2', projectId: P1, goalId: 'g1', title: 'open', status: 'pending', blockedReason: null, createdAt: old(), updatedAt: old() },
      { id: 't3', projectId: P1, goalId: 'g2', title: 'done long ago', status: 'done', blockedReason: null, createdAt: old(), updatedAt: eightDaysAgo },
      { id: 't4', projectId: P1, goalId: 'g2', title: 'open', status: 'pending', blockedReason: null, createdAt: old(), updatedAt: old() },
    ];

    await runProjectDigestOnce();

    const byId = new Map(createdFor(P1).goalProgress.map((g: any) => [g.goalId, g]));
    expect((byId.get('g1') as any).eta.class).toBe('blocked');   // dep-waits still gate the ETA path (honest)
    expect((byId.get('g2') as any)).toMatchObject({ todosDone: 1, completed7d: 0 });
    expect((byId.get('g2') as any).eta).toMatchObject({ class: 'no_movement', etaDays: null });
  });

  it('goal progress feeds the SIGNATURE: a pace-only change (same stats) regenerates the summary', async () => {
    // t-done ages from the 24h window to outside it: stats are IDENTICAL
    // (todos.done unchanged, nothing in the 1h window) but goalProgress
    // .completed24h drops 1 → 0 — the signature must move so the summary
    // regenerates on real progress-fact changes, not just stat changes.
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    goals = [{ id: 'g1', projectId: P1, title: 'Goal', status: 'active', blockedReason: null, createdAt: old(), updatedAt: old() }];
    const mkTodos = (doneAgeHours: number) => [
      { id: 't1', projectId: P1, goalId: 'g1', title: 'done', status: 'done', blockedReason: null, createdAt: old(), updatedAt: new Date(Date.now() - doneAgeHours * 3_600_000) },
      { id: 't2', projectId: P1, goalId: 'g1', title: 'open', status: 'pending', blockedReason: null, createdAt: old(), updatedAt: old() },
    ];
    todos = mkTodos(2); // completed24h = 1

    await runProjectDigestOnce();
    const first = createdFor(P1);
    expect(first.goalProgress[0].completed24h).toBe(1);
    existingDigest = { id: 'dg1', signature: first.signature };
    mockPrisma.projectDigest.create.mockClear();
    mockPrisma.projectDigest.update.mockClear();
    mockUtilityChat.mockClear();

    todos = mkTodos(25); // completed24h = 0, stats identical
    await runProjectDigestOnce();

    expect(mockUtilityChat).toHaveBeenCalledTimes(1); // regenerated
    const update = mockPrisma.projectDigest.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'dg1' });
    expect(update.data.signature).not.toBe(first.signature);
    expect(update.data.goalProgress[0].completed24h).toBe(0);
    const { generatedAt: _g1, ...statsA } = first.stats;
    const { generatedAt: _g2, ...statsB } = update.data.stats;
    expect(statsB).toEqual(statsA); // proves the regen came from goalProgress alone
  });

  it('…and an unchanged paced bucket still SKIPS (goal facts hold no wall-clock values)', async () => {
    setupPacedGoal();
    await runProjectDigestOnce();
    const first = createdFor(P1);
    existingDigest = { id: 'dg1', signature: first.signature };
    mockPrisma.projectDigest.create.mockClear();
    mockUtilityChat.mockClear();

    await runProjectDigestOnce();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockPrisma.projectDigest.create).not.toHaveBeenCalled();
  });

  it('computeDigestSignature: goalProgress/etaSummary are hashed (defaults [] / null keep legacy call shapes)', () => {
    const stats = createdStats();
    const base = computeDigestSignature({ status: 'on_track', stats, attentionItems: [] });
    expect(computeDigestSignature({ status: 'on_track', stats, attentionItems: [], goalProgress: [], etaSummary: null })).toBe(base);
    const gp: DigestGoalProgress[] = [{
      goalId: 'g1', title: 'Goal', status: 'active', todosDone: 1, todosTotal: 2,
      blockedCount: 0, depsBlockedCount: 0, droppedCount: 0, progressNote: null, completed24h: 1, completed7d: 1,
      eta: { remaining: 1, pacePerDay: 0.14, etaDays: 7.1, class: 'on_pace' },
    }];
    expect(computeDigestSignature({ status: 'on_track', stats, attentionItems: [], goalProgress: gp, etaSummary: null })).not.toBe(base);
  });

  it('the utility prompt receives the computed goal facts verbatim (names, numbers, ETA phrasing)', async () => {
    setupPacedGoal();
    await runProjectDigestOnce();

    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const messagesArg = mockUtilityChat.mock.calls[0][0];
    const userPrompt: string = messagesArg[1].content;
    expect(userPrompt).toContain('7 of 18 tasks done toward "Optimal multi-model routing"');
    expect(userPrompt).toContain('at the current pace roughly 11 more days');
    expect(userPrompt).toContain('Overall: 7 of 18 tasks done across 1 goal(s)');
    expect(userPrompt).toContain('never invent a date');
  });

  it('the LOCAL TEMPLATE fallback carries the goal counts + eta class too', async () => {
    setupPacedGoal();
    mockUtilityChat.mockResolvedValue(''); // LLM outage → template

    await runProjectDigestOnce();

    const summary = createdFor(P1).summary;
    expect(summary).toContain('Alpha is active and on track');
    expect(summary).toContain('7 of 18 tasks done toward "Optimal multi-model routing"');
    expect(summary).toContain('at the current pace roughly 11 more days');
  });

  it('fallbackDigestSummary phrases no_movement + blocked classes deterministically', () => {
    const stats = createdStats();
    const sleepy: DigestGoalProgress = {
      goalId: 'g1', title: 'Sleepy goal', status: 'active', todosDone: 2, todosTotal: 6,
      blockedCount: 0, depsBlockedCount: 0, droppedCount: 0, progressNote: null, completed24h: 0, completed7d: 0,
      eta: { remaining: 4, pacePerDay: 0, etaDays: null, class: 'no_movement' },
    };
    const gated: DigestGoalProgress = {
      goalId: 'g2', title: 'Gated goal', status: 'active', todosDone: 1, todosTotal: 3,
      blockedCount: 1, depsBlockedCount: 0, droppedCount: 0, progressNote: null, completed24h: 0, completed7d: 0,
      eta: { remaining: 2, pacePerDay: 0, etaDays: null, class: 'blocked' },
    };
    const summary = fallbackDigestSummary('Alpha', 'on_track', stats, [], [sleepy, gated], computeEtaSummary([sleepy, gated]));
    expect(summary).toContain('2 of 6 tasks done toward "Sleepy goal" — no movement in the last week, so no reliable estimate');
    expect(summary).toContain('1 of 3 tasks done toward "Gated goal", 1 blocked — one blocked task is gating progress');
    expect(summary).toContain('Overall: 3 of 9 tasks done across 2 goals');
  });
});

// ── Ticket 7ee38c8e: an all-completed project must never read as goal-less ───
// Owner repro (2026-09-13 11:54 AM EDT): spark-cluster had 6 goals ALL done/
// archived (last finished ~3.5h before the Pulse snapshot) yet rendered as
// "on track with no active goals tracked" — identical to a project that never
// had goals. The digest must surface WHAT finished, in both the LLM prompt
// facts and the local template fallback.
describe('ticket 7ee38c8e — completed-goal context when no active goals remain', () => {
  /** The spark-cluster repro shape: 6 goals, 4 done + 2 archived, zero
   *  active/blocked — the newest finished ~3.5h before the sweep. The archived
   *  rows are stamped a day OLDER than the done rows so `lastFinishedAt` is
   *  unambiguously the done goals' date — the assertions derive their expected
   *  value from the SAME Date object, so the test can never flake across a UTC
   *  midnight (reviewer BLOCKING finding on the first draft, which used old()
   *  ~3h ago for the archived rows: 3h < 3.5h made THEM the newest terminal
   *  rows, and a 03:00–03:30Z daily window flipped the expected day). */
  function setupAllCompleted() {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'spark-cluster' }];
    const finished = new Date(Date.now() - 3.5 * 3_600_000); // ~3.5h ago
    const archivedAt = new Date(finished.getTime() - 864e5);  // a day older
    goals = [
      ...Array.from({ length: 4 }, (_, i) => ({
        id: `g-done-${i}`, projectId: P1, title: `Done goal ${i}`, status: 'done',
        blockedReason: null, createdAt: old(), updatedAt: finished,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        id: `g-arch-${i}`, projectId: P1, title: `Archived goal ${i}`, status: 'archived',
        blockedReason: null, createdAt: old(), updatedAt: archivedAt,
      })),
    ];
    todos = [
      { id: 't1', projectId: P1, goalId: 'g-done-0', title: 'shipped', status: 'done', blockedReason: null, createdAt: old(), updatedAt: finished },
    ];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];
    return finished;
  }

  it('stats carry archived + lastFinishedAt (the deterministic completion facts)', async () => {
    const finished = setupAllCompleted();
    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1.goalProgress).toEqual([]);            // done/archived are history — nothing tracked
    expect(p1.etaSummary).toBe(Prisma.DbNull);      // no tracked goals ⇒ no rollup (unchanged contract)
    expect(p1.stats.goals).toMatchObject({
      total: 6, done: 4, archived: 2,
      lastFinishedAt: finished.toISOString().slice(0, 10),
    });
  });

  it('an all-completed on-track project ships ONE deterministic sentence that says what finished (merged with review 2026-09-13 issue 16 — no LLM call)', async () => {
    const finished = setupAllCompleted();
    await runProjectDigestOnce();

    // The goal-less on_track bucket with activity never reaches the LLM: the
    // neutral sentence carries the completion context deterministically.
    expect(mockUtilityChat).not.toHaveBeenCalled();
    const summary = createdFor(P1).summary;
    expect(summary).toContain(`No goal is being tracked for spark-cluster (6 goal(s) already completed, last finished ${finished.toISOString().slice(0, 10)}); recent work:`);
    expect(summary).not.toMatch(/no progress|toward any goal|no action needed/i);
  });

  it('the LOCAL TEMPLATE fallback carries the completion context too (LLM outage path)', async () => {
    const finished = setupAllCompleted();
    mockUtilityChat.mockResolvedValue(''); // LLM down → template

    await runProjectDigestOnce();

    const summary = createdFor(P1).summary;
    expect(summary).toContain(`(6 goal(s) already completed, last finished ${finished.toISOString().slice(0, 10)})`);
    // and it must NOT read as a project that never had goals
    expect(summary).not.toBe('spark-cluster is active and on track: 1 user message(s), 0 assistant repl(ies), 0 completed run(s) in the last hour. No blockers or failures detected.');
    expect(summary).not.toBe('No goal is being tracked for spark-cluster; recent work: 1 message from you in the last hour.');
  });

  it('a project that NEVER had goals still reads as no-goals (no fabricated completions)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Fresh' }];
    messages = [{ chatId: 'c1', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];
    mockUtilityChat.mockResolvedValue(''); // template path — the loudest assertion surface

    await runProjectDigestOnce();

    const summary = createdFor(P1).summary;
    expect(summary).not.toContain('already completed');
    // Review 2026-09-13 issue 16: a goal-less on-track bucket that did work is
    // ONE neutral deterministic sentence — no fabricated completions, no LLM.
    expect(summary).toBe('No goal is being tracked for Fresh; recent work: 1 message from you in the last hour.');
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('completedGoalsPhrase pure pin: empty without terminal goals; counts done+archived', () => {
    expect(completedGoalsPhrase({ total: 0, done: 0, blocked: 0, createdInWindow: 0, completedInWindow: 0, archived: 0, lastFinishedAt: null })).toBe('');
    expect(completedGoalsPhrase({ total: 1, done: 0, blocked: 1, createdInWindow: 0, completedInWindow: 0, archived: 0, lastFinishedAt: null })).toBe('');
    expect(completedGoalsPhrase({ total: 6, done: 4, blocked: 0, createdInWindow: 0, completedInWindow: 0, archived: 2, lastFinishedAt: '2026-09-13' }))
      .toBe('6 goal(s) already completed, last finished 2026-09-13');
    // lastFinishedAt missing (defensive): the count still surfaces
    expect(completedGoalsPhrase({ total: 6, done: 4, blocked: 0, createdInWindow: 0, completedInWindow: 0, archived: 2, lastFinishedAt: null }))
      .toBe('6 goal(s) already completed');
  });

  it('signature stability: same terminal goals ⇒ same stats block (the date is day-granular, not wall-clock)', () => {
    // The two new stats fields ride DigestStats, which computeDigestSignature
    // already hashes — a terminal goal flipping done on day D regenerates the
    // summary once (lastFinishedAt moves), then stays stable within the day.
    const base = computeDigestSignature({ status: 'on_track', stats: createdStats(), attentionItems: [] });
    const withTerminal = computeDigestSignature({
      status: 'on_track',
      stats: { ...createdStats(), goals: { ...createdStats().goals, done: 6, archived: 2, lastFinishedAt: '2026-09-13' } },
      attentionItems: [],
    });
    expect(withTerminal).not.toBe(base); // the completion fact is part of the digest identity
  });
});

// ── Sweep guardrails (user cap + time budget) ─────────────────────────────────

describe('sweep guardrails', () => {
  it('logs when the user cap truncates and digests at most MAX_USERS_PER_SWEEP users', async () => {
    discoveredUserIds = Array.from({ length: MAX_USERS_PER_SWEEP + 1 }, (_, i) => `u-${i}`);

    await runProjectDigestOnce();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`exceed the ${MAX_USERS_PER_SWEEP}-user cap`),
    );
    expect(mockHidden).toHaveBeenCalledTimes(MAX_USERS_PER_SWEEP);
  });

  it('stops cleanly at the time budget (before the cron lease could expire) and logs the deferral', async () => {
    discoveredUserIds = ['u-a', 'u-b'];
    const base = 1_000_000;
    let calls = 0;
    // Date.now inside the sweep: 1 = sweepStartMs, 2 = the first per-user
    // budget check (under budget) — every later check is past the budget.
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => {
      calls += 1;
      return calls <= 2 ? base : base + SWEEP_TIME_BUDGET_MS + 1;
    });
    try {
      await expect(runProjectDigestOnce()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(mockHidden).toHaveBeenCalledTimes(1); // only the first user ran
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('time budget'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('1 deferred (time budget)'));
  });
});

// ── Error isolation + create-race convergence ─────────────────────────────────

describe('ack-silence prune', () => {
  it('prunes only acks whose snooze LAPSED >30 days ago — never active or indefinite silences', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    mockPrisma.digestItemAck.deleteMany.mockResolvedValue({ count: 3 });

    await expect(runProjectDigestOnce()).resolves.toBeUndefined();

    // The where filters on snoozeUntil (NOT createdAt — pruning on age deleted
    // active re-acked silences and expired 'indefinite' NULL acks every 30 days,
    // review 2026-08-16). A NULL snoozeUntil never satisfies lt, so indefinite
    // acks survive by construction.
    const where = mockPrisma.digestItemAck.deleteMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeUndefined();
    const cutoff = where.snoozeUntil.lt as Date;
    expect(Math.abs(Date.now() - 30 * 864e5 - cutoff.getTime())).toBeLessThan(5_000);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('pruned 3 digest-item ack(s)'));
  });

  it('a prune failure never kills the sweep (try/catch-isolated)', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    mockPrisma.digestItemAck.deleteMany.mockRejectedValue(new Error('db exploded'));

    await expect(runProjectDigestOnce()).resolves.toBeUndefined();
    expect(createdFor(P1)).toBeDefined(); // the digest still lands
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ack prune failed'));
  });
});

describe('error isolation', () => {
  it('a failing bucket never kills the sweep — the other bucket still lands', async () => {
    chats = [
      { id: 'c1', title: 'One', projectId: P1 },
      { id: 'c2', title: 'Two', projectId: P2 },
    ];
    projects = [{ id: P1, name: 'Alpha' }, { id: P2, name: 'Beta' }];
    messages = [{ chatId: 'c2', role: 'user', content: 'hi', metadata: null, createdAt: inWindow() }];
    mockPrisma.projectGoal.findMany.mockImplementation((args: any) =>
      args?.where?.projectId === P1 ? Promise.reject(new Error('db exploded')) : Promise.resolve([]),
    );

    await expect(runProjectDigestOnce()).resolves.toBeUndefined();
    expect(createdFor(P1)).toBeUndefined();
    expect(createdFor(P2)).toBeDefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`bucket ${OWNER}/${P1} failed`));
  });

  it('a failing user never kills the sweep — the next user still lands', async () => {
    discoveredUserIds = ['u-bad', OWNER];
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    mockHidden.mockImplementation((userId: string) =>
      userId === 'u-bad' ? Promise.reject(new Error('hidden lookup down')) : Promise.resolve({ chatIds: [], projectIds: [] }),
    );

    await expect(runProjectDigestOnce()).resolves.toBeUndefined();
    expect(createdFor(P1)).toBeDefined(); // OWNER's bucket still digested
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('user u-bad failed'));
  });

  it('a P2002 on create converges to an update of the winner row', async () => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    let lookups = 0;
    mockPrisma.projectDigest.findFirst.mockImplementation(() =>
      Promise.resolve(lookups++ === 0 ? null : { id: 'dg-winner', signature: 'other' }),
    );
    mockPrisma.projectDigest.create.mockRejectedValue({ code: 'P2002', message: 'unique' });

    await expect(runProjectDigestOnce()).resolves.toBeUndefined();
    expect(mockPrisma.projectDigest.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.projectDigest.update.mock.calls[0][0].where).toEqual({ id: 'dg-winner' });
  });
});

// ── Stopped-cadence successor-awareness + owner-decision backstop (SA0906) ────
// Prod replay b95e9df6: self-renewing schedule_self chains retire a spent link
// per run budget and arm a fresh successor — an exhausted row is NOT a dead
// lane. Only a lane with no enabled schedule AND no trailing-6h runs surfaces
// as schedule_error, and only machine-stopped ones ('expired'/'started') are
// offered to the owner-decision filing seam.

describe('stopped-cadence successor-awareness + owner-decision backstop (SA0906)', () => {
  const spentLink = (over: any = {}) => ({
    id: 'sch-spent', sessionId: 'c1', enabled: false, kind: 'recurring', runsCount: 8,
    lastFiredAt: inWindow(), lastStatus: 'started', prompt: 'hourly W4A16 kernel sweep',
    ...over,
  });

  beforeEach(() => {
    chats = [{ id: 'c1', title: 'Spark lane', projectId: P1 }];
    projects = [{ id: P1, name: 'Spark' }];
  });

  it('an exhausted link with an ENABLED successor is NOT an attention item and files nothing', async () => {
    schedules = [
      spentLink(),
      { id: 'sch-next', sessionId: 'c1', enabled: true, kind: 'recurring', runsCount: 0, lastFiredAt: null, lastStatus: null, prompt: 'hourly W4A16 kernel sweep (renewed)' },
    ];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.attentionItems.filter((i: any) => i.kind === 'schedule_error')).toEqual([]);
    expect(mockMaybeFileStoppedScheduleDecision).not.toHaveBeenCalled();
    // The successor short-circuits the run probe entirely (no per-session count).
    expect(mockPrisma.agentRun.count).not.toHaveBeenCalled();
  });

  it('an exhausted link with runs in the trailing 6h is suppressed (the lane is still working)', async () => {
    schedules = [spentLink()];
    laneRuns = { c1: 15 };
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.attentionItems.filter((i: any) => i.kind === 'schedule_error')).toEqual([]);
    expect(mockMaybeFileStoppedScheduleDecision).not.toHaveBeenCalled();
    // The probe window is the shared 6h liveness definition.
    const where = mockPrisma.agentRun.count.mock.calls[0][0].where;
    expect(where.sessionId).toBe('c1');
    expect(Math.abs(where.createdAt.gte.getTime() - (Date.now() - STOPPED_LANE_ACTIVITY_WINDOW_MS))).toBeLessThan(60_000);
  });

  it('a genuinely dead lane surfaces AND is offered to the owner-decision filing seam exactly once', async () => {
    schedules = [spentLink()];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    const items = p1.attentionItems.filter((i: any) => i.kind === 'schedule_error');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ scheduleId: 'sch-spent', chatId: 'c1' });
    expect(items[0].detail).toContain('stopped after 8 runs');
    expect(mockMaybeFileStoppedScheduleDecision).toHaveBeenCalledTimes(1);
    expect(mockMaybeFileStoppedScheduleDecision).toHaveBeenCalledWith('sch-spent', 'expired');
  });

  it('prod replay b95e9df6: 10 spent links + 1 enabled successor + live runs → ZERO alerts', async () => {
    schedules = [
      ...Array.from({ length: 10 }, (_, i) => spentLink({ id: `sch-spent-${i}`, lastStatus: i % 2 ? 'expired' : 'started' })),
      { id: 'sch-896e43d7', sessionId: 'c1', enabled: true, kind: 'recurring', runsCount: 3, lastFiredAt: inWindow(), lastStatus: 'started', prompt: 'W4A16 kernel optimization sweep' },
    ];
    laneRuns = { c1: 15 }; // 15 completed runs in 48h — the healthy chain
    const liveRun = { id: 'r-live', sessionId: 'c1', status: 'running', error: null, createdAt: old(), finishedAt: null, heartbeatAt: inWindow(), updatedAt: inWindow(), startedAt: old() };
    windowRuns = [liveRun];
    runningRuns = [liveRun];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.attentionItems.filter((i: any) => i.kind === 'schedule_error')).toEqual([]);
    expect(mockMaybeFileStoppedScheduleDecision).not.toHaveBeenCalled();
    expect(p1.status).toBe('on_track'); // the chain reads as a healthy working lane
  });

  it('an owner-cancelled dead cadence still surfaces but NEVER files from the digest (human-attributed)', async () => {
    schedules = [spentLink({ lastStatus: 'cancelled' })];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.attentionItems.filter((i: any) => i.kind === 'schedule_error')).toHaveLength(1);
    expect(mockMaybeFileStoppedScheduleDecision).not.toHaveBeenCalled();
  });

  it('a liveness-probe error keeps the item (a passive surface fails loud) but skips the filing (a card fails closed)', async () => {
    schedules = [spentLink()];
    mockPrisma.agentRun.count.mockRejectedValue(new Error('db down'));
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.attentionItems.filter((i: any) => i.kind === 'schedule_error')).toHaveLength(1);
    expect(mockMaybeFileStoppedScheduleDecision).not.toHaveBeenCalled();
  });

  it('live-ERROR schedules are never suppressed by a sibling (a successor does not fix a failing row)', async () => {
    schedules = [
      { id: 'sch-err', sessionId: 'c1', enabled: true, kind: 'recurring', runsCount: 40, lastFiredAt: inWindow(), lastStatus: 'error:provider_429', prompt: 'hourly monitor' },
      { id: 'sch-ok', sessionId: 'c1', enabled: true, kind: 'recurring', runsCount: 2, lastFiredAt: inWindow(), lastStatus: 'started', prompt: 'other monitor' },
    ];
    laneRuns = { c1: 4 };
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    const items = p1.attentionItems.filter((i: any) => i.kind === 'schedule_error');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ scheduleId: 'sch-err', detail: 'error:provider_429' });
    expect(mockMaybeFileStoppedScheduleDecision).not.toHaveBeenCalled(); // still enabled — not a stop
  });

  it('v1#13 — a MACHINE-cancelled dead cadence files from the digest (cancelledBy stamped at stop time)', async () => {
    schedules = [spentLink({ lastStatus: 'cancelled', cancelledBy: 'machine' })];
    await runProjectDigestOnce();
    expect(createdFor(P1).attentionItems.filter((i: any) => i.kind === 'schedule_error')).toHaveLength(1);
    // The durable backstop now covers the 12-min in-process recheck's death:
    // it keys off the DB row (cancelledBy), not the lost timer.
    expect(mockMaybeFileStoppedScheduleDecision).toHaveBeenCalledWith('sch-spent', 'cancelled');
  });

  it('v1#13 — an OWNER-cancelled row still never files (cancelledBy owner)', async () => {
    schedules = [spentLink({ lastStatus: 'cancelled', cancelledBy: 'owner' })];
    await runProjectDigestOnce();
    expect(mockMaybeFileStoppedScheduleDecision).not.toHaveBeenCalled();
  });

  it('v1#13 — disabledAt is the recency signal: a machine cancel of a long-quiet lane still reaches the backstop', async () => {
    schedules = [spentLink({
      lastStatus: 'cancelled', cancelledBy: 'machine',
      lastFiredAt: new Date(Date.now() - 3 * 24 * 3600_000), // fired days ago — outside the old window
      disabledAt: inWindow(),                                 // …but cancelled MOMENTS ago
    })];
    await runProjectDigestOnce();
    expect(mockMaybeFileStoppedScheduleDecision).toHaveBeenCalledWith('sch-spent', 'cancelled');
  });

  it('a filing-seam failure never breaks the sweep (best-effort backstop)', async () => {
    schedules = [spentLink()];
    mockMaybeFileStoppedScheduleDecision.mockRejectedValue(new Error('inbox down'));
    await runProjectDigestOnce();
    expect(createdFor(P1).attentionItems.filter((i: any) => i.kind === 'schedule_error')).toHaveLength(1);
  });

  it('the digest probe window matches the filing module (one liveness definition)', () => {
    const { LANE_ACTIVITY_WINDOW_MS } = jest.requireActual('../coding/stopped-schedule-alert');
    expect(STOPPED_LANE_ACTIVITY_WINDOW_MS).toBe(LANE_ACTIVITY_WINDOW_MS);
  });
});

// ── Remediation P2 N10 + S2a — owner-wait line integrity + escalation ─────────
describe('N10/S2a — owner-wait lines require an open oq; 24h/72h escalation', () => {
  const blockedOwnerTodo = (over: any = {}) => ({
    id: 't-own', projectId: P1, goalId: 'g1', title: 'Pick the engine', status: 'blocked',
    blockedReason: 'Awaiting owner decision on the serving engine', blockKind: 'owner',
    createdAt: old(), updatedAt: inWindow(), ...over,
  });

  beforeEach(() => {
    chats = [{ id: 'c1', title: 'One', projectId: P1 }];
    projects = [{ id: P1, name: 'Alpha' }];
    messages = [{ chatId: 'c1', role: 'user', content: 'go', metadata: null, createdAt: inWindow() }];
  });

  // CanLaw stall 2026-09-15: the unbacked claim is no longer dropped — it is
  // rendered as the team's own pause (a plain blocked_todo, never awaiting_input)
  // and the lane that wrote it is told. The N10 metric still counts the class.
  it('an owner-wait item with NO open oq id renders as "Paused by the team\'s own rule", wakes the claiming lane, and still counts owner_wait_line_dropped', async () => {
    todos = [blockedOwnerTodo({ gateQuestionId: null, assigneeChatId: 'c-lane' })];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.attentionItems).toHaveLength(1);
    expect(p1.attentionItems[0].kind).toBe('blocked_todo');
    expect(p1.attentionItems[0].detail).toBe(TEAM_PAUSE_DETAIL);
    // The lane-written claim is NOT echoed to the owner (it is the laundered phrase itself).
    expect(p1.attentionItems[0].detail).not.toContain('Awaiting owner decision');
    expect(p1.attentionItems.some((i: any) => i.kind === 'awaiting_input')).toBe(false);
    expect(isTeamPauseItem(p1.attentionItems[0])).toBe(true);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_wait_line_dropped' }));
    expect(mockNoteUnbackedOwnerWaitClaim).toHaveBeenCalledWith(expect.objectContaining({
      userId: OWNER, entity: 'todo', id: 't-own', title: 'Pick the engine', laneChatId: 'c-lane', projectId: P1, surface: 'project_digest',
    }));
  });

  it("a blocked GOAL claiming an owner decision with no open oq wakes its creator chat (entity 'goal')", async () => {
    todos = [];
    goals = [{
      id: 'g-halt', projectId: P1, title: 'Ship the model', status: 'blocked', blockKind: 'deps', gateQuestionId: null,
      blockedReason: "owner's HALT-band decision MADE — training stays stopped", createdByChatId: 'c-coord',
      createdAt: old(), updatedAt: inWindow(),
    }];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    const item = p1.attentionItems.find((i: any) => i.kind === 'blocked_goal');
    expect(item?.detail).toMatch(/^Paused by the team's own rule/);
    expect(mockNoteUnbackedOwnerWaitClaim).toHaveBeenCalledWith(expect.objectContaining({ entity: 'goal', id: 'g-halt', laneChatId: 'c-coord' }));
  });

  // The owner DID answer the cited card with a decision (not a question back):
  // the row is a STALE GATE the team must act on — never "team's own rule",
  // never an owner wait, and no corrective wake (the sweeper releases it).
  it('a row citing an ANSWERED card (real decision) renders as "you already answered…", counts stale_gate, and does NOT wake the lane', async () => {
    todos = [blockedOwnerTodo({ gateQuestionId: 'oq_stop2222-bbbb', assigneeChatId: 'c-lane' })];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_stop2222-bbbb', status: 'answered', answer: 'no, hold it until the audit is done', chosenOption: null, answeredBy: 'owner', createdAt: inWindow(), userId: OWNER },
    ]);
    await runProjectDigestOnce();
    const item = createdFor(P1).attentionItems.find((i: any) => i.kind === 'blocked_todo');
    expect(item.detail.startsWith(STALE_GATE_DETAIL_PREFIX)).toBe(true);
    expect(item.detail).toContain('no, hold it until the audit is done');
    expect(isTeamPauseItem(item)).toBe(false);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stale_gate', meta: expect.objectContaining({ surface: 'project_digest', oqId: 'oq_stop2222' }) }));
    expect(mockNoteUnbackedOwnerWaitClaim).not.toHaveBeenCalled();
  });

  it('a row citing a card the owner answered WITH A QUESTION is unbacked — team pause + lane told (an owner question back is not a decision)', async () => {
    todos = [blockedOwnerTodo({ gateQuestionId: 'oq_ask3333-cccc', assigneeChatId: 'c-lane' })];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_ask3333-cccc', status: 'answered', answer: "well didn't we change the benchmark a ton in between this?", chosenOption: null, answeredBy: 'owner', createdAt: inWindow(), userId: OWNER },
    ]);
    await runProjectDigestOnce();
    const item = createdFor(P1).attentionItems.find((i: any) => i.kind === 'blocked_todo');
    expect(item.detail).toBe(TEAM_PAUSE_DETAIL);
    expect(mockNoteUnbackedOwnerWaitClaim).toHaveBeenCalledWith(expect.objectContaining({ entity: 'todo', id: 't-own' }));
  });

  it('an open gateQuestionId keeps the line, annotated with the oq id', async () => {
    todos = [blockedOwnerTodo({ gateQuestionId: 'oq_engine11-aaaa' })];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([{ id: 'oq_engine11-aaaa', createdAt: inWindow(), userId: OWNER }]);
    await runProjectDigestOnce();
    const item = createdFor(P1).attentionItems.find((i: any) => i.kind === 'blocked_todo');
    expect(item.detail).toContain('oq_engine11');
    expect(item.detail).toContain('open');
    expect(item.detail).not.toContain('awaiting you'); // < 24h — no age line yet
    expect(mockRepushOwnerQuestionReminder).not.toHaveBeenCalled();
  });

  it('an inline oq_ id in the blocked reason also backs the wait (no gateQuestionId needed)', async () => {
    todos = [blockedOwnerTodo({ blockKind: null, blockedReason: 'Awaiting owner — oq_ab12cd34-ef56 filed for the decision', gateQuestionId: null })];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([{ id: 'oq_ab12cd34-ef56', createdAt: inWindow(), userId: OWNER }]);
    await runProjectDigestOnce();
    const item = createdFor(P1).attentionItems.find((i: any) => i.kind === 'blocked_todo');
    expect(item).toBeDefined();
    expect(item.detail).toContain('oq_ab12cd34');
  });

  it("PAST 24h the digest line says 'awaiting you N day(s)'", async () => {
    todos = [blockedOwnerTodo({ gateQuestionId: 'oq_engine11-aaaa' })];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_engine11-aaaa', createdAt: new Date(Date.now() - 30 * 3600e3), userId: OWNER },
    ]);
    await runProjectDigestOnce();
    const item = createdFor(P1).attentionItems.find((i: any) => i.kind === 'blocked_todo');
    expect(item.detail).toContain('awaiting you 1 day');
    expect(mockRepushOwnerQuestionReminder).not.toHaveBeenCalled(); // 72h not reached
  });

  it('PAST 72h the Telegram DM is re-pushed once (deduped inside the helper by question+day)', async () => {
    const oqRow = { id: 'oq_engine11-aaaa', createdAt: new Date(Date.now() - 80 * 3600e3), userId: OWNER };
    todos = [blockedOwnerTodo({ gateQuestionId: 'oq_engine11-aaaa' })];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([oqRow]);
    await runProjectDigestOnce();
    const item = createdFor(P1).attentionItems.find((i: any) => i.kind === 'blocked_todo');
    expect(item.detail).toContain('awaiting you 3 days');
    expect(mockRepushOwnerQuestionReminder).toHaveBeenCalledTimes(1);
    expect(mockRepushOwnerQuestionReminder).toHaveBeenCalledWith(oqRow, 3);
  });

  it('a STALE gateQuestionId (answered/dismissed) does not rescue the line as an owner wait — it renders as the team\'s own pause', async () => {
    todos = [blockedOwnerTodo({ gateQuestionId: 'oq_answered1' })];
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([]); // not open
    await runProjectDigestOnce();
    const items = createdFor(P1).attentionItems;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('blocked_todo');
    expect(items[0].detail).toMatch(/^Paused by the team's own rule/);
    expect(items[0].detail).not.toContain('oq_answered1 open');
  });

  it('goals get the same treatment (team-imposed pause line + owner_wait_line_dropped count + the creator lane told)', async () => {
    goals = [{
      id: 'g-own', projectId: P1, title: 'Ship v2', status: 'blocked',
      blockedReason: 'needs owner approval', blockKind: 'owner', gateQuestionId: null, createdByChatId: 'c-coord',
      createdAt: old(), updatedAt: inWindow(),
    }];
    await runProjectDigestOnce();
    const goalItems = createdFor(P1).attentionItems.filter((i: any) => i.kind === 'blocked_goal');
    expect(goalItems).toHaveLength(1);
    expect(goalItems[0].detail).toMatch(/^Paused by the team's own rule — no owner decision is pending/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_wait_line_dropped' }));
    expect(mockNoteUnbackedOwnerWaitClaim).toHaveBeenCalledWith(expect.objectContaining({ entity: 'goal', id: 'g-own', laneChatId: 'c-coord' }));
  });

  it('non-owner-wait blocked reasons are untouched by the filter', async () => {
    todos = [blockedOwnerTodo({ blockKind: 'external', blockedReason: 'Waiting on vendor API keys', gateQuestionId: null })];
    await runProjectDigestOnce();
    const item = createdFor(P1).attentionItems.find((i: any) => i.kind === 'blocked_todo');
    expect(item).toBeDefined();
    expect(item.detail).toBe('Waiting on vendor API keys');
  });
});

// ── Remediation P7: dropped exclusion + deps/gate split + progressNote ────────

describe('P7 — computeGoalProgress: dropped todos + the deps/gate blocked split', () => {
  const NOW = new Date('2026-09-09T12:00:00.000Z');
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
  const goalRow = (id: string, title: string, status = 'active', extra: Record<string, any> = {}) => ({ id, title, status, ...extra });
  const todoRow = (goalId: string, status: string, updatedAt: Date, extra: Record<string, any> = {}) => ({ goalId, status, updatedAt, ...extra });

  it('DROPPED todos leave todosTotal/remaining (cancelled work stops pushing the ETA out) but stay counted', () => {
    const gp = computeGoalProgress(
      [goalRow('g1', 'Goal')],
      [
        todoRow('g1', 'done', hoursAgo(2)),
        todoRow('g1', 'pending', hoursAgo(2)),
        todoRow('g1', 'dropped', hoursAgo(1)),
        todoRow('g1', 'dropped', hoursAgo(1)),
      ],
      NOW,
    );
    expect(gp[0]).toMatchObject({ todosDone: 1, todosTotal: 2, droppedCount: 2 });
    expect(gp[0].eta.remaining).toBe(1);
  });

  it('deps-blocked rows do NOT gate the ETA class; any gate-blocked (or untyped) row does', () => {
    const depsOnly = computeGoalProgress(
      [goalRow('g1', 'Ordered work')],
      [
        todoRow('g1', 'done', hoursAgo(2)),
        todoRow('g1', 'blocked', hoursAgo(2), { blockKind: 'deps' }),
        todoRow('g1', 'pending', hoursAgo(2)),
      ],
      NOW,
    )[0];
    expect(depsOnly).toMatchObject({ blockedCount: 1, depsBlockedCount: 1 });
    expect(depsOnly.eta.class).toBe('on_pace'); // ordering, not a stall

    const gated = computeGoalProgress(
      [goalRow('g2', 'Stalled work')],
      [todoRow('g2', 'blocked', hoursAgo(2), { blockKind: 'owner' }), todoRow('g2', 'blocked', hoursAgo(2))],
      NOW,
    )[0];
    expect(gated).toMatchObject({ blockedCount: 2, depsBlockedCount: 0 });
    expect(gated.eta.class).toBe('blocked'); // untyped blocks still gate (conservative)
  });

  it("a goal's OWN deps-typed block does not gate; any other goal block does", () => {
    const deps = computeGoalProgress([goalRow('g1', 'G', 'blocked', { blockKind: 'deps' })], [todoRow('g1', 'pending', hoursAgo(1))], NOW)[0];
    expect(deps.eta.class).toBe('no_movement');
    const owner = computeGoalProgress([goalRow('g1', 'G', 'blocked', { blockKind: 'owner' })], [todoRow('g1', 'pending', hoursAgo(1))], NOW)[0];
    expect(owner.eta.class).toBe('blocked');
  });

  it("progressNote: the goal's own note wins; else the freshest todo note; the fact line renders it", () => {
    const fromGoal = computeGoalProgress(
      [goalRow('g1', 'G', 'active', { progressNote: 'phase 2 of 3' })],
      [todoRow('g1', 'in_progress', hoursAgo(1), { progressNote: 'older todo note' })],
      NOW,
    )[0];
    expect(fromGoal.progressNote).toBe('phase 2 of 3');
    const fromTodo = computeGoalProgress(
      [goalRow('g1', 'G')],
      [
        todoRow('g1', 'in_progress', hoursAgo(5), { progressNote: 'stale note' }),
        todoRow('g1', 'in_progress', hoursAgo(1), { progressNote: '3/5 shards trained' }),
      ],
      NOW,
    )[0];
    expect(fromTodo.progressNote).toBe('3/5 shards trained');
    const summary = fallbackDigestSummary('Alpha', 'on_track', createdStats(), [], [fromTodo], null);
    expect(summary).toContain('latest: "3/5 shards trained"');
  });

  // Ticket a8d6e514: a note may now be a 2,000-char continuation ledger — the Pulse carries the bounded display
  // form (≤200, word boundary + "…"), the fact line ≤90, and the HOLD reader keeps reading the LEAD only.
  it('a8d6e514: a 2,000-char note reaches the Pulse clamped; the fact line clamps to 90 on a word boundary', () => {
    const ledger = `3/5 shards trained, loss 2.1. ${'carry ticket a1b2c3d4 then sweep its class for siblings; '.repeat(40)}`.slice(0, 2000);
    const [gp] = computeGoalProgress([goalRow('g1', 'G', 'active', { progressNote: ledger })], [todoRow('g1', 'in_progress', hoursAgo(1))], NOW);
    expect(gp.progressNote!.length).toBeLessThanOrEqual(200);
    expect(gp.progressNote!.endsWith('…')).toBe(true);
    expect(ledger.startsWith(gp.progressNote!.slice(0, -1))).toBe(true);
    const summary = fallbackDigestSummary('Alpha', 'on_track', createdStats(), [], [gp], null);
    const latest = /latest: "([^"]*)"/.exec(summary)![1];
    expect(latest.length).toBeLessThanOrEqual(90);
    expect(latest.endsWith('…')).toBe(true);
    expect(ledger.slice(latest.length - 1, latest.length)).toMatch(/[\s,;.]/); // cut at a word boundary
    // a note within 200 chars is carried byte-identically (no signature churn for every pre-a8d6e514 note)
    const [short] = computeGoalProgress([goalRow('g1', 'G', 'active', { progressNote: 'phase 2 of 3' })], [], NOW);
    expect(short.progressNote).toBe('phase 2 of 3');
  });

  it('a8d6e514: `held` reads only the note LEAD — a lifted/resumed word deep in the ledger tail never un-holds it', () => {
    const tail = ' ledger: '.concat('older cycle resumed after the cap reset; '.repeat(20));
    const [held] = computeGoalProgress([goalRow('g1', 'G', 'active', { progressNote: `HOLD per owner — no new runs until the budget call.${' '.repeat(160)}${tail}` })], [todoRow('g1', 'pending', hoursAgo(1))], NOW);
    expect(held.held).toBe(true);
    expect(held.eta.class).toBe('held');
  });

  it('a deps-only blocked goal phrases "waiting on dependencies" instead of "blocked" in the fact line', () => {
    const depsOnly = computeGoalProgress(
      [goalRow('g1', 'Ordered work')],
      [todoRow('g1', 'blocked', hoursAgo(2), { blockKind: 'deps' }), todoRow('g1', 'done', hoursAgo(2))],
      NOW,
    )[0];
    const summary = fallbackDigestSummary('Alpha', 'on_track', createdStats(), [], [depsOnly], null);
    expect(summary).toContain('1 waiting on dependencies');
    expect(summary).not.toContain('1 blocked —');
  });
});

// ── Project-supervisor preflight 2026-09-14: the project supervisor's own note
//    reaches the owner through the Pulse without the fleet chat relaying it ──
describe('project supervisor "supervisor says" fact (preflight 2026-09-14)', () => {
  const SUP_CHAT = 'psup-1';
  const WORKER = 'c-worker';
  /** An assistant row in the supervisor lane, `minutesAgo` old. Default
   *  metadata is the chat-agent finalize stamp (engine 'agent' — hardening
   *  review 2026-09-14: the ONLY positive signal that a row is the lane's own
   *  reply) inheriting a schedule-wake origin. */
  const supNote = (content: string, minutesAgo: number, metadata: any = { origin: 'schedule', engine: 'agent' }) => ({
    chatId: SUP_CHAT, role: 'assistant', content, metadata, createdAt: new Date(Date.now() - minutesAgo * 60_000),
  });
  /** Route BOTH message queries: the bucket's `chatId.in` scan and the new
   *  supervisor `chatId: <id>` + createdAt-window read (desc, take 5). */
  const wireMessageQueries = () => {
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
      // Mirror the real bucket scan's createdAt >= windowStart filter (the
      // suite's default mock ignores it) so a stale supervisor note behaves as
      // it does in prod: outside the window on BOTH reads.
      const gte: Date | undefined = where.createdAt?.gte;
      return Promise.resolve(messages.filter((m) => (where.chatId?.in ?? []).includes(m.chatId) && (!gte || m.createdAt >= gte)));
    });
  };

  beforeEach(() => {
    chats = [
      { id: WORKER, title: 'Kernel worker', projectId: P1 },
      { id: SUP_CHAT, title: 'Alpha Supervisor', projectId: P1, isProjectSupervisor: true },
    ];
    projects = [{ id: P1, name: 'Alpha', supervised: true }];
    mockUtilityChat.mockResolvedValue(''); // force the deterministic local template
    wireMessageQueries();
  });

  describe('supervisorSaysLine (pure)', () => {
    it('picks the first substantive line and scrubs ids, Z-times, links and emphasis', () => {
      const note = [
        '## WAKE — 03:43Z',
        '| Lane | Status |',
        '|---|---|',
        '**ACTIONS TAKEN** — steered the bench lane back to shard 3 (msg 1a2b3c4d5e6f) at 03:50Z; see [ticket](https://x/y) sched 5e6f7a8b9c0d',
      ].join('\n');
      const line = supervisorSaysLine(note)!;
      expect(line).toBe('ACTIONS TAKEN — steered the bench lane back to shard 3; see ticket');
      expect(line).not.toMatch(/[0-9a-f]{8,}/);
      expect(line).not.toMatch(/\d{1,2}:\d{2}Z/);
      expect(line).not.toContain('**');
    });

    it('skips header-only / table / rule lines and returns null when nothing renderable survives', () => {
      expect(supervisorSaysLine('# Sweep\n|a|b|\n---\nWAKE')).toBeNull();
      expect(supervisorSaysLine('')).toBeNull();
      expect(supervisorSaysLine(null)).toBeNull();
    });

    it('bounds the line to SUPERVISOR_SAYS_MAX_CHARS with an ellipsis', () => {
      const long = 'x'.repeat(SUPERVISOR_SAYS_MAX_CHARS + 50);
      const line = supervisorSaysLine(long)!;
      expect(line.length).toBe(SUPERVISOR_SAYS_MAX_CHARS);
      expect(line.endsWith('…')).toBe(true);
    });

    it('pins the window: 90 minutes', () => {
      expect(SUPERVISOR_SAYS_WINDOW_MS).toBe(90 * 60 * 1000);
    });
  });

  it('a project with a supervisor lane carries the lane\'s latest note as ONE scrubbed "Its supervisor says" sentence + attributes its runs/notes in stats', async () => {
    messages = [
      { chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() },
      supNote('**Alpha sweep** — bench shards 3/8 done (run 9f8e7d6c5b4a); GPU 5 idle, re-dispatched — sched 1122aabbccdd', 20),
      supNote('older note that must NOT win', 40),
    ];
    windowRuns = [
      { id: 'r-sup', sessionId: SUP_CHAT, status: 'completed', error: null, createdAt: inWindow(), finishedAt: inWindow(), heartbeatAt: null },
      { id: 'r-w', sessionId: WORKER, status: 'completed', error: null, createdAt: inWindow(), finishedAt: inWindow(), heartbeatAt: null },
    ];

    await runProjectDigestOnce();

    const p1 = createdFor(P1);
    expect(p1).toBeDefined();
    // The supervisor read is the string-chatId + 90-min window shape (desc, take 5).
    const supQuery = mockPrisma.crossModelMessage.findMany.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.where?.chatId === SUP_CHAT);
    expect(supQuery).toBeDefined();
    expect(supQuery.where.role).toBe('assistant');
    expect(supQuery.where.createdAt.gte).toBeInstanceOf(Date);
    expect(supQuery.orderBy).toEqual({ createdAt: 'desc' });
    // Summary: one trailing sentence, scrubbed (no ids), the NEWEST note.
    expect(p1.summary).toContain('Its supervisor says: "Alpha sweep — bench shards 3/8 done; GPU 5 idle, re-dispatched"');
    expect(p1.summary).not.toContain('older note');
    expect(p1.summary).not.toMatch(/9f8e7d6c|1122aabb/);
    // Stats: the lane's own slice is attributed; both runs still count overall.
    expect(p1.stats.runs.completed).toBe(2);
    expect(p1.stats.projectSupervisor).toEqual({ runsInWindow: 1, notesInWindow: 2 });
  });

  it('the fact rides the LLM prompt as a quoted FACT when the LLM path runs', async () => {
    mockUtilityChat.mockResolvedValue('Alpha is moving; its supervisor reports the shards are half done.');
    messages = [supNote('Shards 4/8 done, nothing blocked', 5)];
    // An attention item forces the LLM path (a goal-less on_track bucket would short-circuit).
    windowRuns = [{ id: 'r-f', sessionId: WORKER, status: 'failed', error: 'boom', createdAt: inWindow(), finishedAt: inWindow(), heartbeatAt: null }];

    await runProjectDigestOnce();

    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const prompt: string = mockUtilityChat.mock.calls[0][0][1].content;
    expect(prompt).toContain('The project\'s own supervisor said this in its latest note');
    expect(prompt).toContain('"Shards 4/8 done, nothing blocked"');
  });

  it('a note older than the 90-min window, or only watchdog/briefing rows, yields NO supervisor sentence (never fabricated)', async () => {
    messages = [
      supNote('stale note from two hours ago', 120),
      // Watchdog rows ride the finalize stamp too (engine 'agent') — the kind/origin denylist is the belt that still drops them.
      supNote('[WATCHDOG] Your last 3 notes are near-identical', 3, { origin: 'attention-watchdog', kind: 'stuck-note-nudge', engine: 'agent' }),
      { chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() },
    ];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.summary).not.toContain('Its supervisor says');
    expect(p1.stats.projectSupervisor).toEqual({ runsInWindow: 0, notesInWindow: 1 }); // the watchdog row is still an assistant row in the window
  });

  // Hardening review 2026-09-14: the denylist quoted HARNESS rows as the lane's
  // voice — the deploy-interrupt row, orphan-recovery / shutdown re-queue
  // escalations, the verifier's retraction, and metadata-less dead-letter /
  // schedule-cap notices. Real replies carry chat-agent's finalize stamp
  // (metadata.engine 'agent'); nothing else does.
  describe('harness-authored rows are never quoted as the supervisor (hardening review 2026-09-14)', () => {
    const harnessRows = () => [
      supNote('⚠️ **This turn was interrupted by a deploy** — the server answering your message was replaced mid-run. Re-running your message on the new server now…', 2, { origin: 'deploy-interrupt' }),
      supNote('⚠️ This turn was re-queued because the server shut down mid-run; it will re-run on the new server.', 3, { origin: 'shutdown_requeue', requeuedAt: new Date().toISOString() }),
      supNote('🛑 Orphan recovery: the previous run of this chat died without a final note; re-firing the wake now.', 4, { origin: 'orphan-recovery' }),
      supNote('[ACTION VERIFIER — automated integrity check] Correction: my previous message cited reference id(s) that DO NOT EXIST.', 5, { origin: 'machine', verifier: 'action-verifier' }),
      supNote('Hook delivery to this chat was dead-lettered after 5 attempts — the target stayed busy for the whole horizon.', 6, null),
      supNote('This recurring schedule reached its run cap and was disabled; re-arm it to continue.', 7, {}),
    ];

    it('a window holding ONLY harness rows (deploy-interrupt, shutdown re-queue, orphan-recovery, verifier retraction, metadata-less dead-letter / schedule notices) yields NO "Its supervisor says" sentence', async () => {
      messages = [...harnessRows(), { chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() }];
      await runProjectDigestOnce();
      const p1 = createdFor(P1);
      expect(p1).toBeDefined();
      expect(p1.summary).not.toContain('Its supervisor says');
      expect(p1.summary).not.toContain('interrupted by a deploy');
      expect(p1.summary).not.toContain('Orphan recovery');
      expect(p1.summary).not.toContain('dead-lettered');
      // They are still assistant rows in the lane — the stats count is untouched by the voice filter.
      expect(p1.stats.projectSupervisor).toEqual({ runsInWindow: 0, notesInWindow: 6 });
    });

    it('newer harness rows are skipped and the OLDER real note (finalize-stamped) wins', async () => {
      // Three harness rows (not all six): the supervisor read fetches the
      // newest SUPERVISOR_SAYS_FETCH (5) rows — a pre-existing cap, not this
      // fix's concern — so the real note must sit inside that window.
      const [deployInterrupt, , orphanRecovery, , deadLetter] = harnessRows();
      messages = [
        deployInterrupt, orphanRecovery, deadLetter,
        supNote('Bench shards 5/8 done; GPU 2 re-dispatched after a stall', 30),
        { chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() },
      ];
      await runProjectDigestOnce();
      const p1 = createdFor(P1);
      expect(p1.summary).toContain('Its supervisor says: "Bench shards 5/8 done; GPU 2 re-dispatched after a stall"');
      expect(p1.summary).not.toContain('interrupted by a deploy');
    });

    it('an OWNER-typed turn\'s reply (finalize stamp, NO origin) IS the lane speaking and stays quotable', async () => {
      messages = [
        supNote('Yes — the bench lane is healthy, nothing is blocked right now', 5, { engine: 'agent', models: {}, mode: 'thinking' }),
        { chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() },
      ];
      await runProjectDigestOnce();
      const p1 = createdFor(P1);
      expect(p1.summary).toContain('Its supervisor says: "Yes — the bench lane is healthy, nothing is blocked right now"');
    });

    it('a finalize-stamped row whose origin is a wake origin (hook / agent / webhook) is quotable like the schedule wake', async () => {
      for (const origin of ['hook', 'agent', 'webhook']) {
        mockPrisma.projectDigest.create.mockClear();
        messages = [
          supNote(`Wake via ${origin}: kernel lane finished shard 7, next shard queued`, 5, { origin, engine: 'agent' }),
          { chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() },
        ];
        await runProjectDigestOnce();
        const p1 = createdFor(P1);
        expect(p1.summary).toContain(`Its supervisor says: "Wake via ${origin}: kernel lane finished shard 7, next shard queued"`);
      }
    });
  });

  it('a project WITHOUT a supervisor lane makes no supervisor read, has no projectSupervisor key, and keeps its signature byte-identical (no fleet-wide regen)', async () => {
    chats = [{ id: WORKER, title: 'Kernel worker', projectId: P1 }];
    messages = [{ chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() }];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1.stats.projectSupervisor).toBeUndefined();
    expect(mockPrisma.crossModelMessage.findMany.mock.calls.some((c: any[]) => typeof c[0]?.where?.chatId === 'string')).toBe(false);
    // Signature contract: the supervisorSays key is ABSENT (not null) when unset.
    const base = { status: 'idle' as const, stats: p1.stats, attentionItems: [] };
    expect(computeDigestSignature(base)).toBe(computeDigestSignature({ ...base, supervisorSays: null }));
    expect(computeDigestSignature(base)).not.toBe(computeDigestSignature({ ...base, supervisorSays: 'a new note' }));
  });

  it('a supervisor-note read failure only drops the fact — the bucket still digests', async () => {
    mockPrisma.crossModelMessage.findMany.mockImplementation((args: any) => {
      if (typeof args?.where?.chatId === 'string') return Promise.reject(new Error('db hiccup'));
      return Promise.resolve(messages.filter((m) => (args?.where?.chatId?.in ?? []).includes(m.chatId)));
    });
    messages = [{ chatId: WORKER, role: 'user', content: 'go', metadata: null, createdAt: inWindow() }];
    await runProjectDigestOnce();
    const p1 = createdFor(P1);
    expect(p1).toBeDefined();
    expect(p1.summary).not.toContain('Its supervisor says');
    expect((logger.warn as jest.Mock).mock.calls.some((c: any[]) => /project-supervisor note read failed/.test(String(c[0])))).toBe(true);
  });

  it('fallbackDigestSummary: the supervisor sentence trails EVERY status branch and the default (null) leaves templates unchanged', () => {
    const stats: DigestStats = {
      chatCount: 2, activeChats: 1,
      messages: { total: 1, user: 1, assistant: 0, byOrigin: { user: 1 } },
      runs: { started: 0, completed: 0, failed: 0, active: 0 },
      todos: { total: 0, done: 0, blocked: 0, dropped: 0, createdInWindow: 0, completedInWindow: 0 },
      goals: { total: 0, done: 0, blocked: 0, createdInWindow: 0, completedInWindow: 0, archived: 0, lastFinishedAt: null },
      schedules: { firedInWindow: 0, errored: 0 }, queuedMessages: 0,
    };
    const item: DigestAttentionItem = { kind: 'blocked_goal', title: 'G', detail: null, goalId: 'g1', at: new Date().toISOString() };
    for (const status of ['blocked', 'needs_attention', 'idle'] as const) {
      const withNote = fallbackDigestSummary('Alpha', status, stats, [item], [], null, true, 'shards 3/8 done');
      expect(withNote.endsWith(' Its supervisor says: "shards 3/8 done".')).toBe(true);
      expect(fallbackDigestSummary('Alpha', status, stats, [item], [], null, true, null)).toBe(withNote.replace(' Its supervisor says: "shards 3/8 done".', ''));
    }
    // The neutral no-goal sentence (issue 16) keeps its exact body + the tail.
    expect(fallbackDigestSummary('Alpha', 'on_track', stats, [], [], null, true, 'shards 3/8 done'))
      .toBe(`${fallbackDigestSummary('Alpha', 'on_track', stats, [])} Its supervisor says: "shards 3/8 done".`);
  });
});
