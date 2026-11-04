/**
 * Session titles (SESSION_TITLES_TOPOLOGY design §A, 2026-09-27) pins.
 * Pure: the renderer / splitter / clipper, the placeholder-shape detector,
 * the step derivations (plan → receipt → run state), the supervisor wake verb.
 * DB-facing (mocked prisma): refreshSessionTitle renders from the charter and
 * writes the chat + satellite rows once per rate window, returns early on a
 * pinned row and on a charter-less LLM-titled lane, never throws; bindCharter
 * fills only null fields; setSupervisorStep keeps the role label as the goal
 * half; the spawn-title contract is opt-in.
 */
const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), update: jest.fn(async () => ({})) },
  chatCodingState: { findUnique: jest.fn(async () => ({ titleSource: null })), update: jest.fn(async () => ({})) },
  projectGoal: { findUnique: jest.fn(async () => null) },
  projectTodo: { findUnique: jest.fn(async () => null) },
  agentRun: { findFirst: jest.fn(async () => null) },
};
const mockRecordLoopMetric = jest.fn();
const mockGetPlan = jest.fn((..._a: any[]): Promise<any> => Promise.resolve(null));
const mockReceipts = jest.fn((..._a: any[]): Promise<any> => Promise.resolve([]));
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a), LOOP_METRIC_KINDS: { TITLE_RENDER: 'title_render' } }));
jest.mock('../coding/plan.service', () => ({ __esModule: true, getPlan: (...a: any[]) => mockGetPlan(...a) }));
jest.mock('../coding/run-receipts.service', () => ({ __esModule: true, getRecentChatReceipts: (...a: any[]) => mockReceipts(...a) }));

import {
  clipWords, renderSessionTitle, splitSessionTitle, placeholderSpawnTitleReason, stepFromReceipt, stepFromPlan, stepFromRunState,
  supervisorStepFromWake, idleSinceStep, refreshSessionTitle, bindCharter, setSupervisorStep, isTitlePinned, spawnTitleRequired, spawnTitleAdvisoryEnabled,
  healSupervisorTitle, TITLE_MAX_CHARS, _resetTitleRateLimitForTests,
  resolveGoalHalf,
} from './session-titles';

const NOW = new Date('2026-09-27T15:00:00Z');
const laneRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'lane-1', title: 'Old LLM title', titlePinned: false, titleStep: null, charterGoalId: 'goal-1', charterTodoId: null,
  isSupervisor: false, isProjectSupervisor: false, archivedAt: null, projectId: 'proj-1', ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetTitleRateLimitForTests();
  delete process.env.HARNESS_TITLE_SPAWN_REQUIRED;
  mockPrisma.chatCodingState.findUnique.mockResolvedValue({ titleSource: null });
  mockPrisma.projectGoal.findUnique.mockResolvedValue({ title: 'H2H benchmark S3 and S5 shards on the Dell box' });
  mockPrisma.projectTodo.findUnique.mockResolvedValue(null);
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
  mockGetPlan.mockResolvedValue(null);
  mockReceipts.mockResolvedValue([]);
});

describe('pure renderers', () => {
  it('clipWords caps at 6 words, strips markdown chrome and trailing punctuation, no ellipsis', () => {
    // audit 2026-10-06 T8-13: a clipped half drops a dangling connector ("… type on" → "… type").
    expect(clipWords('**Fix** the `upload` MIME type on lane images, please.')).toBe('Fix the upload MIME type');
    expect(clipWords('   short  ')).toBe('short');
    expect(clipWords('a b c d e f g h', 3)).toBe('a b c');
  });

  it('renderSessionTitle joins "<goal> · <step>" ≤ 80 chars and keeps the whole step when over budget; splitSessionTitle inverts it on the LAST separator', () => {
    const t = renderSessionTitle({ goal: 'H2H bench S3+S5', step: 'PR #712 opened' });
    expect(t).toBe('H2H bench S3+S5 · PR #712 opened');
    expect(splitSessionTitle(t)).toEqual({ goal: 'H2H bench S3+S5', step: 'PR #712 opened' });
    expect(renderSessionTitle({ goal: 'Only goal' })).toBe('Only goal');
    expect(splitSessionTitle('Only goal')).toEqual({ goal: 'Only goal', step: null });
    expect(splitSessionTitle('CanLaw · SFT · steering SFT-2 smoke')).toEqual({ goal: 'CanLaw · SFT', step: 'steering SFT-2 smoke' });
    const long = renderSessionTitle({ goal: 'x'.repeat(70), step: 'idle 3 h' });
    expect(long.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(long.endsWith(' · idle 3 h')).toBe(true);
  });

  it('fixer 2026-09-27: rawGoal keeps a supervisor LABEL verbatim — no word clip, no `_` / `*` stripping; lane goals stay clipped', () => {
    expect(renderSessionTitle({ goal: 'my_project Supervisor', step: 'sweep', rawGoal: true })).toBe('my_project Supervisor · sweep');
    expect(renderSessionTitle({ goal: 'my_project Supervisor', step: 'sweep' })).toBe('my project Supervisor · sweep');
    const sevenWords = 'Alpha Beta Gamma Delta Epsilon Zeta Supervisor';
    expect(renderSessionTitle({ goal: sevenWords, step: 'sweep', rawGoal: true })).toBe(`${sevenWords} · sweep`);
    expect(renderSessionTitle({ goal: sevenWords, step: 'sweep' })).toBe('Alpha Beta Gamma Delta Epsilon Zeta · sweep');
  });

  it('fixer 2026-09-27: healSupervisorTitle — keeps the step when the goal half IS the label, heals drift to the bare label, honours the pin, and heals whole under the step switch', () => {
    expect(healSupervisorTitle({ title: 'Apollo Supervisor · sweep' }, 'Apollo Supervisor')).toBeNull();
    expect(healSupervisorTitle({ title: 'Apollo Supervisor' }, 'Apollo Supervisor')).toBeNull();
    expect(healSupervisorTitle({ title: 'Old Name Supervisor · sweep' }, 'Apollo Supervisor')).toBe('Apollo Supervisor');
    expect(healSupervisorTitle({ title: 'Unanswered Test Question' }, 'Fleet Supervisor')).toBe('Fleet Supervisor');
    expect(healSupervisorTitle({ title: 'my_project Supervisor · idle since 14:02Z' }, 'my_project Supervisor')).toBeNull();
    expect(healSupervisorTitle({ title: 'Alpha Beta Gamma Delta Epsilon Zeta Supervisor · sweep' }, 'Alpha Beta Gamma Delta Epsilon Zeta Supervisor')).toBeNull();
    // the pin
    expect(healSupervisorTitle({ title: 'My Fleet Boss', titlePinned: true }, 'Fleet Supervisor')).toBeNull();
  });

  it('placeholderSpawnTitleReason names the rule: empty / stock / acknowledgement / verdict / machine header; a deliverable passes', () => {
    expect(placeholderSpawnTitleReason('')).toBe('empty');
    expect(placeholderSpawnTitleReason('Untitled session')).toBe('stock placeholder');
    expect(placeholderSpawnTitleReason('Kickoff received')).toMatch(/request or its acknowledgement/);
    expect(placeholderSpawnTitleReason('Bounty Submission Status Inquiry')).toMatch(/acknowledgement/);
    expect(placeholderSpawnTitleReason('Self-Audit Passes 7 of 8 Criteria')).toMatch(/verdict/);
    expect(placeholderSpawnTitleReason('Agent message received from supervisor')).toMatch(/acknowledgement|machine header/);
    expect(placeholderSpawnTitleReason('H2H bench S3+S5')).toBeNull();
    expect(placeholderSpawnTitleReason('Fix upload MIME on lane images')).toBeNull();
  });

  it('stepFromReceipt: verb + object for mutating tools, null for reads / unknown', () => {
    expect(stepFromReceipt({ tool: 'open_pull_request', ids: { prNumber: 712 } })).toBe('PR #712 opened');
    expect(stepFromReceipt({ tool: 'merge_pull_request', ids: { prNumber: 3 } })).toBe('PR #3 merged');
    expect(stepFromReceipt({ tool: 'send_chat_message', ids: { chatId: 'abcdef0123456789' } })).toBe('messaged abcdef01');
    expect(stepFromReceipt({ tool: 'file_feedback', ids: { ticketId: '3405e332aaaa' } })).toBe('ticket 3405e332 filed');
    expect(stepFromReceipt({ tool: 'read_file', ids: {} })).toBeNull();
    expect(stepFromReceipt(null)).toBeNull();
  });

  it('stepFromPlan takes the NEWEST in-progress step (highest id), clipped; none ⇒ null', () => {
    expect(stepFromPlan({ steps: [{ id: 1, text: 'Write the bench harness for shards', status: 'completed' }, { id: 2, text: 'Run S3 and S5 shards on the Dell and compare', status: 'in_progress' }, { id: 3, text: 'Open PR', status: 'pending' }] })).toBe('Run S3 and S5 shards') /* audit 2026-10-06 T8-13: no dangling connector */;
    expect(stepFromPlan({ steps: [{ id: 4, text: 'later', status: 'in_progress' }, { id: 2, text: 'earlier', status: 'in_progress' }] })).toBe('later');
    expect(stepFromPlan({ steps: [{ id: 1, text: 'x', status: 'completed' }] })).toBeNull();
    expect(stepFromPlan(null)).toBeNull();
  });

  it('stepFromRunState: archived / running / last run failed / idle N m|h|d', () => {
    expect(stepFromRunState({ archived: true }, NOW)).toBe('archived');
    expect(stepFromRunState({ running: true }, NOW)).toBe('running');
    expect(stepFromRunState({ lastRunStatus: 'failed' }, NOW)).toBe('last run failed');
    expect(stepFromRunState({ lastActivityAt: new Date(NOW.getTime() - 12 * 60_000) }, NOW)).toBe('idle 12 m');
    expect(stepFromRunState({ lastActivityAt: new Date(NOW.getTime() - 3 * 3600_000) }, NOW)).toBe('idle 3 h');
    expect(stepFromRunState({ lastActivityAt: new Date(NOW.getTime() - 5 * 86400_000) }, NOW)).toBe('idle 5 d');
    expect(stepFromRunState({}, NOW)).toBe('idle');
  });

  it('supervisorStepFromWake reads the wake header / origin; idleSinceStep stamps HH:MMZ', () => {
    expect(supervisorStepFromWake({ message: 'Project Supervisor sweep — …', origin: 'schedule' })).toBe('sweep');
    expect(supervisorStepFromWake({ message: 'Fleet Supervisor sweep', origin: 'schedule' })).toBe('sweep');
    expect(supervisorStepFromWake({ message: '[NO-ADOPTION] goal x', origin: 'hook' })).toBe('no-adoption review');
    expect(supervisorStepFromWake({ message: 'run_completed on chat 0f3c2a1b-…', origin: 'hook' })).toBe('hook: lane 0f3c2a1b');
    expect(supervisorStepFromWake({ message: 'something', origin: 'hook' })).toBe('hook wake');
    expect(supervisorStepFromWake({ message: 'report', origin: 'agent' })).toBe('report-up');
    expect(supervisorStepFromWake({ message: 'how is it going', origin: 'user' })).toBe('answering owner');
    expect(idleSinceStep(NOW)).toBe('idle since 15:00Z');
  });

  it('spawn title refusal is OPT-IN (advisory by default; =0 silences the advisory)', () => {
    expect(spawnTitleRequired()).toBe(false);
    expect(spawnTitleAdvisoryEnabled()).toBe(true);
    process.env.HARNESS_TITLE_SPAWN_REQUIRED = '1';
    expect(spawnTitleRequired()).toBe(true);
    process.env.HARNESS_TITLE_SPAWN_REQUIRED = '0';
    expect(spawnTitleAdvisoryEnabled()).toBe(false);
    expect(spawnTitleRequired()).toBe(false);
  });
});

describe('refreshSessionTitle (charter lanes)', () => {
  it('renders "<goal> · <step>" from the charter goal + the in-progress plan step, writes the chat + satellite rows, emits session_title, records title_render', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow());
    mockGetPlan.mockResolvedValue({ steps: [{ id: 2, text: 'Run S3 and S5 shards', status: 'in_progress' }] });
    const emit = jest.fn();
    const r = await refreshSessionTitle('lane-1', 'plan', { emit, now: NOW });
    expect(r).toEqual({ changed: true, title: 'H2H benchmark S3 and S5 shards · Run S3 and S5 shards' });
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: 'lane-1' }, data: { title: 'H2H benchmark S3 and S5 shards · Run S3 and S5 shards', titleStep: 'Run S3 and S5 shards' } });
    expect(mockPrisma.chatCodingState.update).toHaveBeenCalledWith({ where: { id: 'lane-1' }, data: { title: 'H2H benchmark S3 and S5 shards · Run S3 and S5 shards', titleSource: 'harness' } });
    expect(emit).toHaveBeenCalledWith('session_title', expect.objectContaining({ chatId: 'lane-1', goal: 'H2H benchmark S3 and S5 shards', step: 'Run S3 and S5 shards', pinned: false }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'title_render', meta: expect.objectContaining({ source: 'harness', reason: 'plan', changed: true }) }));
  });

  it('step fallback order: no in-progress step ⇒ the newest mutating receipt ⇒ the run state', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow());
    mockReceipts.mockResolvedValue([{ tool: 'read_file', ids: {} }, { tool: 'open_pull_request', ids: { prNumber: 712 } }, { tool: 'run_command', ids: {} }]);
    expect((await refreshSessionTitle('lane-1', 'finalize', { now: NOW })).title).toBe('H2H benchmark S3 and S5 shards · command run');
    _resetTitleRateLimitForTests();
    mockReceipts.mockResolvedValue([]);
    mockPrisma.agentRun.findFirst.mockResolvedValue({ status: 'completed', finishedAt: new Date(NOW.getTime() - 3 * 3600_000), startedAt: null, createdAt: NOW });
    expect((await refreshSessionTitle('lane-1', 'finalize', { now: NOW })).title).toBe('H2H benchmark S3 and S5 shards · idle 3 h');
  });

  it('a pinned row is never written (pinnedSkip + a title_render row with pinnedSkip:true)', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ titlePinned: true, title: 'My own name' }));
    const r = await refreshSessionTitle('lane-1', 'plan', { now: NOW });
    expect(r).toEqual({ changed: false, title: 'My own name', pinnedSkip: true });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ pinnedSkip: true, source: 'user' }) }));
  });

  it('a charter-less lane with an LLM title is left alone (no_charter); a spawn-param title keeps its goal half and gains the step half', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ charterGoalId: null }));
    expect((await refreshSessionTitle('lane-1', 'finalize', { now: NOW })).skipped).toBe('no_charter');
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ titleSource: 'spawn-param' });
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ charterGoalId: null, title: 'H2H bench S3+S5' }));
    mockReceipts.mockResolvedValue([{ tool: 'open_pull_request', ids: { prNumber: 9 } }]);
    const r = await refreshSessionTitle('lane-1', 'finalize', { now: NOW });
    expect(r.title).toBe('H2H bench S3+S5 · PR #9 opened');
    expect(mockPrisma.chatCodingState.update).toHaveBeenCalledWith({ where: { id: 'lane-1' }, data: { title: 'H2H bench S3+S5 · PR #9 opened', titleSource: 'spawn-param' } });
  });

  it('rate limit: ≤ 1 write per 10 min per chat (force bypasses); an unchanged render writes nothing but records changed:false', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow());
    mockGetPlan.mockResolvedValue({ steps: [{ id: 1, text: 'step one', status: 'in_progress' }] });
    const first = await refreshSessionTitle('lane-1', 'plan', { now: NOW });
    expect(first.changed).toBe(true);
    // the row now carries the written title (the mock is static — reflect the write)
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ title: first.title, titleStep: 'step one' }));
    expect((await refreshSessionTitle('lane-1', 'plan', { now: new Date(NOW.getTime() + 60_000) })).skipped).toBe('rate_limited');
    expect((await refreshSessionTitle('lane-1', 'plan', { now: new Date(NOW.getTime() + 60_000), force: true })).changed).toBe(false);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledTimes(1);
    expect((await refreshSessionTitle('lane-1', 'plan', { now: new Date(NOW.getTime() + 11 * 60_000) })).changed).toBe(false);
    expect(mockRecordLoopMetric).toHaveBeenLastCalledWith(expect.objectContaining({ meta: expect.objectContaining({ changed: false }) }));
  });

  it('supervisor rows are never rendered by the lane renderer; a read error fails open', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ isProjectSupervisor: true }));
    expect((await refreshSessionTitle('lane-1', 'plan', { now: NOW })).skipped).toBe('no_charter');
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('db down'));
    expect((await refreshSessionTitle('lane-1', 'plan', { now: NOW })).skipped).toBe('not_found');
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });
});

describe('bindCharter / setSupervisorStep / isTitlePinned', () => {
  it('bindCharter fills only NULL charter fields (first bind wins), derives the goal from a todo, and triggers a forced refresh', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ charterGoalId: null, charterTodoId: null }));
    mockPrisma.projectTodo.findUnique.mockResolvedValue({ goalId: 'goal-9' });
    expect(await bindCharter('lane-1', { todoId: 'todo-1' })).toEqual({ bound: true });
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: 'lane-1' }, data: { charterTodoId: 'todo-1', charterGoalId: 'goal-9' } });
    jest.clearAllMocks();
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ charterGoalId: 'goal-1', charterTodoId: 'todo-0' }));
    expect(await bindCharter('lane-1', { goalId: 'goal-2', todoId: 'todo-2' })).toEqual({ bound: false });
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ isSupervisor: true, charterGoalId: null }));
    expect(await bindCharter('lane-1', { goalId: 'goal-2' })).toEqual({ bound: false });
  });

  it('setSupervisorStep keeps the role label as the goal half and writes only the step; pinned / non-supervisor / disabled are no-ops', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ isProjectSupervisor: true, title: 'CanLaw Supervisor · idle since 14:02Z' }));
    const emit = jest.fn();
    const r = await setSupervisorStep('lane-1', 'sweep', { emit, now: NOW });
    expect(r).toEqual({ changed: true, title: 'CanLaw Supervisor · sweep' });
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({ where: { id: 'lane-1' }, data: { title: 'CanLaw Supervisor · sweep', titleStep: 'sweep' } });
    expect(emit).toHaveBeenCalledWith('session_title', expect.objectContaining({ title: 'CanLaw Supervisor · sweep' }));
    _resetTitleRateLimitForTests();
    // fixer 2026-09-27: the label is never word-clipped or stripped
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ isProjectSupervisor: true, title: 'my_long project name here too Supervisor' }));
    expect((await setSupervisorStep('lane-1', 'sweep', { now: NOW })).title).toBe('my_long project name here too Supervisor · sweep');
    _resetTitleRateLimitForTests();
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow({ isProjectSupervisor: true, title: 'CanLaw Supervisor', titlePinned: true }));
    expect((await setSupervisorStep('lane-1', 'sweep', { now: NOW })).pinnedSkip).toBe(true);
    mockPrisma.crossModelChat.findUnique.mockResolvedValue(laneRow());
    expect((await setSupervisorStep('lane-1', 'sweep', { now: NOW })).skipped).toBe('no_charter');
  });

  it('isTitlePinned reads the flag, false on error', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValue({ titlePinned: true });
    expect(await isTitlePinned('lane-1')).toBe(true);
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('x'));
    expect(await isTitlePinned('lane-1')).toBe(false);
  });
});

// ── audit 2026-10-06 T8-13 (schooltime P3, others F19): word-boundary clips + the distinguishing todo half ──
describe('titles clip at word boundaries and todo-bound lanes stay distinguishable (audit 2026-10-06 T8-13)', () => {
  afterEach(() => {
    delete process.env.HARNESS_TITLE_WORD_CLIP_DISABLED;
    delete process.env.HARNESS_TITLE_TODO_HALF_DISABLED;
    delete mockPrisma.projectTodo.findFirst;
  });

  it('a clipped half never ends inside an open parenthetical, on trailing punctuation or a dangling connector', () => {
    expect(clipWords('Push hardened recorder to box (base64 encoded tarball over SSM)')).toBe('Push hardened recorder to box');
    expect(clipWords('Gap-fill: bijural terminology, FR point-in-time, FR/EN pairs for the corpus')).toBe('Gap-fill: bijural terminology, FR point-in-time, FR/EN');
    expect(clipWords('Fix lane titles, sidebar, board, cards, digests and more')).toBe('Fix lane titles, sidebar, board, cards');
    expect(clipWords('Benchmark the S3 and S5 shards on the Dell box')).toBe('Benchmark the S3 and S5 shards');
    expect(clipWords('short (unclosed')).toBe('short (unclosed'); // not clipped ⇒ untouched
  });

  it('the over-budget hard cut lands on a word boundary', () => {
    const goal = 'Supervise the CanLaw bilingual statute corpus harvest and verification across every province';
    const t = renderSessionTitle({ goal, rawGoal: true });
    expect(t.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(goal.startsWith(t)).toBe(true);
    expect(goal.charAt(t.length)).toBe(' '); // the next char of the source is a space — no word was split
  });

  it('a todo-bound lane takes its goal half from the todo it is working, then its charter todo, then the goal', async () => {
    mockPrisma.projectTodo.findFirst = jest.fn(async () => ({ title: 'FR point-in-time for the Civil Code' }));
    const row = { id: 'lane-1', title: 'x', charterGoalId: 'goal-1', charterTodoId: 'todo-1' };
    expect(await resolveGoalHalf(row, null)).toBe('FR point-in-time for the Civil Code');
    expect(mockPrisma.projectTodo.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { assigneeChatId: 'lane-1', status: 'in_progress' } }));
    mockPrisma.projectTodo.findFirst = jest.fn(async () => null);
    mockPrisma.projectTodo.findUnique.mockResolvedValueOnce({ title: 'Bijural terminology pairs' });
    expect(await resolveGoalHalf(row, null)).toBe('Bijural terminology pairs');
    mockPrisma.projectTodo.findFirst = jest.fn(async () => null);
    expect(await resolveGoalHalf({ ...row, charterTodoId: null }, null)).toBe('H2H benchmark S3 and S5 shards');
  });

  it('kill switches restore the plain clip, the plain hard cut and the goal-first half', async () => {
    process.env.HARNESS_TITLE_WORD_CLIP_DISABLED = '1';
    expect(clipWords('Push hardened recorder to box (base64 encoded tarball over SSM)')).toBe('Push hardened recorder to box (base64');
    const goal = 'Supervise the CanLaw bilingual statute corpus harvest and verification across every province';
    expect(renderSessionTitle({ goal, rawGoal: true })).toBe(goal.slice(0, TITLE_MAX_CHARS).trim());
    process.env.HARNESS_TITLE_TODO_HALF_DISABLED = '1';
    mockPrisma.projectTodo.findFirst = jest.fn(async () => ({ title: 'FR point-in-time for the Civil Code' }));
    expect(await resolveGoalHalf({ id: 'lane-1', title: 'x', charterGoalId: 'goal-1', charterTodoId: 'todo-1' }, null)).toBe('H2H benchmark S3 and S5 shards');
    expect(mockPrisma.projectTodo.findFirst).not.toHaveBeenCalled();
  });
});
