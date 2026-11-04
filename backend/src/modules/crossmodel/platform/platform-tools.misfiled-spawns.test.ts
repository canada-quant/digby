/**
 * misfiled-spawns (tt-rd audit 2026-09-27) — ticket→lane spawn attribution.
 *
 * Prod: the Nightly Self-Improvement Engineer (b92ef13f, project crossmodel)
 * spawned two adversarial-review children for CROSSMODEL PRs (#838 / #841)
 * with projectId = 47f9de59 (tt-rd) — the REPORTER's project copied out of
 * ticket c7bf1e66's context. The framework gave it every reason to: the
 * schema made projectId `required` (the executor already defaulted a missing
 * id to home, so `required` only forced a guess), get_feedback rendered the
 * reporter's projectId raw and unlabelled, and the 2026-09-22 guard (a) let a
 * DONE todo authorize a cross-project spawn forever and (b) struck a caller
 * that named its OWN project by name / short id ('crossmodel', 'e5734bd2').
 *
 * Pins:
 *   (1) schema: projectId is OPTIONAL; SPAWN_PROJECT_REQUIRED=1 is documented
 *       as the restore lever (the schema is built at module load — pinned by
 *       the exported predicate, not by re-importing the module);
 *   (2) a caller naming its OWN project by name resolves to home: no strike,
 *       no NOTE, no re-home telemetry;
 *   (3) a foreign reference resolved through the resolver is probed by its
 *       RESOLVED id with the LIVE-status predicate; the strike carries both
 *       the requested reference and the resolved target;
 *   (4) a DONE todo no longer authorizes (the probe predicate excludes it);
 *       CROSS_PROJECT_DONE_TODO_AUTHORIZES=1 restores `{ not: 'dropped' }`;
 *   (5) an UNGROUPED caller whose prompt names the framework repo and whose
 *       target project is not the crossmodel repo gets an observe-only
 *       guard_strike (seam framework_spawn_in_user_project) + NOTE — the
 *       spawn still lands where asked; a crossmodel-repo target records nothing;
 *   (6) get_feedback renders the reporter fields under a labelled `reporter`
 *       key with the note and keeps the rest of `context`;
 *   (7) review of this fix (2026-09-27): an UNGROUPED caller that OMITS
 *       projectId is refused with the filing rule at the executor (and at
 *       staging — pinned in platform-tools.b6acc1e3.test.ts) instead of
 *       routing "" into the service's generic 404; a grouped caller still
 *       defaults to home; the envelope's projectCorrectedFrom is present ONLY
 *       when the pin actually re-homed the spawn (never on the observe-only
 *       backstop).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
const mockStartCodingSession = jest.fn(async (opts: any) => ({ id: 'child-1', projectId: opts.projectId, title: opts.title ?? 'child', branch: 'digby/session-child-1', baseBranch: 'main', model: 'glm-5.3', modelSource: null }));
const mockCanonicalize = jest.fn(async (_userId: string, _raw: string): Promise<{ id: string; via: string } | null> => null);
jest.mock('./platform.service', () => ({
  __esModule: true,
  startCodingSession: (opts: any) => mockStartCodingSession(opts),
  canonicalizeProjectReference: (u: string, r: string) => mockCanonicalize(u, r),
}));
const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(async () => true),
  getFeedbackTicketById: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) },
}));

const mockDb = {
  activity: { create: jest.fn(async () => ({})) },
  crossModelChat: { findUnique: jest.fn(async (_a?: any): Promise<any> => null), update: jest.fn(async () => ({})) },
  crossModelProject: { findUnique: jest.fn(async (_a?: any): Promise<any> => null) },
  projectGoal: { findUnique: jest.fn(async (_args?: any): Promise<any> => null) },
  projectTodo: { findFirst: jest.fn(async (_args?: any): Promise<any> => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockDb }));

const mockGoals = { createTodo: jest.fn(), createGoal: jest.fn(), canonicalGoalIdForTool: jest.fn(async (id: string) => id) };
jest.mock('./goals.service', () => ({ __esModule: true, ...mockGoals }));

const mockLoopMetrics = { recordLoopMetric: jest.fn() };
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
  recordLoopMetric: mockLoopMetrics.recordLoopMetric,
}));

jest.mock('./hooks.service', () => ({
  __esModule: true,
  subscribeHook: jest.fn(),
  findCoveringHooks: jest.fn(async () => []),
  updateHook: jest.fn(),
  unsubscribeHook: jest.fn(),
  listHooks: jest.fn(async () => []),
  ensureChildResultHook: jest.fn(async () => null),
}));

import {
  executePlatformTool, PLATFORM_TOOL_SCHEMA, spawnProjectRequired, crossProjectAuthorizingTodoStatus,
  splitReporterContext, REPORTER_CONTEXT_NOTE, FRAMEWORK_WORK_PROMPT_RE, CROSSMODEL_REPO_RE,
} from './platform-tools';
import { ToolContext } from '../coding/tools';

const LANE = 'lane-b92ef13f';
const USER = 'u1';
const HOME = 'e5734bd2-7c44-4895-8204-84e456918f18'; // crossmodel
const TTRD = '47f9de59-0000-4000-8000-000000000000'; // tt-rd (the reporter's project)
const LIVE_STATUS = { in: ['pending', 'in_progress', 'blocked'] };

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: LANE, userId: USER, permissionMode: 'auto',
    agentSurface: 'coding', projectId: HOME,
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const strikes = () => mockLoopMetrics.recordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'guard_strike');

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ['CROSS_PROJECT_DONE_TODO_AUTHORIZES', 'SPAWN_PROJECT_REQUIRED']) delete process.env[k];
  mockCanonicalize.mockResolvedValue(null);
  mockDb.projectTodo.findFirst.mockResolvedValue(null);
  mockDb.crossModelProject.findUnique.mockResolvedValue(null);
  (mockDb.crossModelChat.findUnique as jest.Mock).mockImplementation(async ({ where }: any) =>
    where?.id === LANE ? { id: LANE, userId: USER, isProjectSupervisor: false, projectId: HOME } : null);
});

describe('misfiled-spawns-1 — start_coding_session schema: projectId optional', () => {
  it('(1) projectId is not required and its description says to OMIT it + never copy a ticket reporter field', () => {
    const tool = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'start_coding_session')!;
    const params: any = tool.function.parameters;
    expect(params.required).toBeUndefined();
    expect(params.properties.projectId.description).toMatch(/^OMIT this when this chat is in a project/);
    expect(params.properties.projectId.description).toContain("where the REPORTER was");
    // Review fix: the OMIT advice is scoped to GROUPED callers — an ungrouped
    // one (the Fleet Supervisor) can never satisfy the 'todo assigned'
    // condition and MUST name a project (framework work → "crossmodel").
    expect(params.properties.projectId.description).toContain('An UNGROUPED chat (the Fleet Supervisor, a No-folder chat) has no home project and MUST name one');
    expect(params.properties.projectId.description).toContain('Digby framework / harness work → the project named "crossmodel"');
    expect(spawnProjectRequired()).toBe(false);
    process.env.SPAWN_PROJECT_REQUIRED = '1';
    expect(spawnProjectRequired()).toBe(true); // the restore lever the schema builder reads at module load
  });
});

describe('misfiled-spawns-2 — resolver-aware home pin + live-todo authorization', () => {
  it('(2) a caller naming its OWN project by name resolves to home — no strike, no NOTE, no probe', async () => {
    mockCanonicalize.mockResolvedValue({ id: HOME, via: 'name' });
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: 'crossmodel', title: 'Adversarial review' });
    expect(mockCanonicalize).toHaveBeenCalledWith(USER, 'crossmodel');
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(HOME);
    expect(String(out)).not.toContain('NOTE: you asked for project');
    expect(mockDb.projectTodo.findFirst).not.toHaveBeenCalled();
    await flush();
    expect(strikes()).toEqual([]);
  });

  it('(3) a FOREIGN reference is probed by its RESOLVED id with the LIVE predicate; the strike names both the request and the resolved target', async () => {
    mockCanonicalize.mockResolvedValue({ id: TTRD, via: 'prefix' });
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: '47f9de59', title: 'Adversarial Review of Proposed Fix' });
    expect(mockDb.projectTodo.findFirst).toHaveBeenCalledWith({
      where: { assigneeChatId: LANE, projectId: TTRD, status: LIVE_STATUS },
      select: { id: true },
    });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(HOME);
    expect(String(out)).toContain('NOTE: you asked for project 47f9de59');
    expect(String(out)).toContain("the REPORTER's location");
    // The envelope's structured fields agree with the note: a REAL re-home
    // carries the reference the pin replaced.
    const env = JSON.parse(String(out));
    expect(env.ids).toMatchObject({ projectId: HOME, projectCorrectedFrom: '47f9de59' });
    await flush();
    expect(strikes()).toEqual([expect.objectContaining({
      kind: 'guard_strike',
      meta: expect.objectContaining({ seam: 'cross_project_spawn_corrected', homeProjectId: HOME, targetProjectId: TTRD, requestedProjectId: '47f9de59' }),
    })]);
  });

  it('(3b) a LIVE assignment in the resolved target authorizes the spawn there — the resolved id is what the session is created in', async () => {
    mockCanonicalize.mockResolvedValue({ id: TTRD, via: 'name' });
    mockDb.projectTodo.findFirst.mockResolvedValueOnce({ id: 't-live' });
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: 'tt-rd', title: 'Authorized audit' });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(TTRD);
    expect(String(out)).not.toContain('NOTE: you asked for project');
  });

  it('(4) the authorization predicate is LIVE-only by default; CROSS_PROJECT_DONE_TODO_AUTHORIZES=1 restores { not: dropped }', () => {
    expect(crossProjectAuthorizingTodoStatus()).toEqual(LIVE_STATUS);
    process.env.CROSS_PROJECT_DONE_TODO_AUTHORIZES = '1';
    expect(crossProjectAuthorizingTodoStatus()).toEqual({ not: 'dropped' });
  });

  it('(4b) with the restore lever set, the spawn probe uses the old predicate', async () => {
    process.env.CROSS_PROJECT_DONE_TODO_AUTHORIZES = '1';
    await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: TTRD, title: 'x' });
    expect(mockDb.projectTodo.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { not: 'dropped' } }),
    }));
  });

  it('a resolver that throws is fail-open: the raw reference is compared as before (re-homed with a strike)', async () => {
    mockCanonicalize.mockRejectedValue(new Error('db down'));
    await executePlatformTool(makeCtx(), 'start_coding_session', { projectId: TTRD, title: 'x' });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(HOME);
    await flush();
    expect(strikes()).toHaveLength(1);
    expect(strikes()[0].meta.requestedProjectId).toBeUndefined(); // raw === resolved: no extra key
  });
});

describe('misfiled-spawns-4 — ungrouped (fleet) caller: observe-only framework-repo check', () => {
  const FLEET = 'chat-c0e22e36';
  const ungrouped = () => {
    (mockDb.crossModelChat.findUnique as jest.Mock).mockResolvedValue({ id: FLEET, userId: USER, isSupervisor: true, isProjectSupervisor: false, projectId: null });
    return makeCtx({ sessionId: FLEET, projectId: 'chat' } as any);
  };

  it('the prompt regex names the framework repo and the backend tree; the repo regex matches the crossmodel repoUrl', () => {
    expect(FRAMEWORK_WORK_PROMPT_RE.test('Fix backend/src/modules/crossmodel/platform/platform-tools.ts')).toBe(true);
    expect(FRAMEWORK_WORK_PROMPT_RE.test('Review PR #838 on canada-quant/digby')).toBe(true);
    expect(FRAMEWORK_WORK_PROMPT_RE.test('Rebase onto tt-metal v0.78 and re-measure tok/s')).toBe(false);
    expect(CROSSMODEL_REPO_RE.test('https://github.com/canada-quant/digby')).toBe(true);
    expect(CROSSMODEL_REPO_RE.test('https://github.com/canada-quant/tt-rd')).toBe(false);
  });

  it('(5) framework prompt + user-project target → guard_strike framework_spawn_in_user_project (observed) + NOTE; the spawn still lands where asked', async () => {
    mockDb.crossModelProject.findUnique.mockResolvedValue({ id: TTRD, name: 'tt-rd', repoUrl: 'https://github.com/canada-quant/tt-rd' });
    const out = await executePlatformTool(ungrouped(), 'start_coding_session', {
      projectId: TTRD, title: 'Framework fix', prompt: 'Fix the spawn guard in backend/src/modules/crossmodel/platform/platform-tools.ts',
    });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(TTRD); // never corrected — observe-only
    expect(String(out)).toContain('NOTE (observe-only)');
    expect(String(out)).toContain('framework work belongs in the crossmodel project');
    // Review fix: the envelope must not CLAIM a correction that never
    // happened — the backstop's note rides a separate variable, so
    // projectCorrectedFrom is absent and projectId is where it landed.
    const env = JSON.parse(String(out));
    expect(env.ids.projectId).toBe(TTRD);
    expect(env.ids.projectCorrectedFrom).toBeUndefined();
    expect(env.message).toMatch(/^NOTE \(observe-only\)/);
    await flush();
    expect(strikes()).toEqual([expect.objectContaining({
      meta: expect.objectContaining({ seam: 'framework_spawn_in_user_project', targetProjectId: TTRD, targetRepoUrl: 'https://github.com/canada-quant/tt-rd', outcome: 'observed' }),
    })]);
  });

  it('(5b) a crossmodel-repo target records nothing; a non-framework prompt records nothing', async () => {
    mockDb.crossModelProject.findUnique.mockResolvedValue({ id: HOME, name: 'crossmodel', repoUrl: 'https://github.com/canada-quant/digby' });
    let out = await executePlatformTool(ungrouped(), 'start_coding_session', { projectId: HOME, title: 'ok', prompt: 'Fix backend/src/x.ts' });
    expect(String(out)).not.toContain('NOTE (observe-only)');

    mockDb.crossModelProject.findUnique.mockResolvedValue({ id: TTRD, name: 'tt-rd', repoUrl: 'https://github.com/canada-quant/tt-rd' });
    out = await executePlatformTool(ungrouped(), 'start_coding_session', { projectId: TTRD, title: 'audit', prompt: 'Audit the tt-rd lane: rebase and re-measure tok/s' });
    expect(String(out)).not.toContain('NOTE (observe-only)');
  });
});

describe('misfiled-spawns-5 — ungrouped caller that OMITS projectId (review of the fix, 2026-09-27)', () => {
  const FLEET = 'chat-c0e22e36';
  const ungrouped = () => {
    (mockDb.crossModelChat.findUnique as jest.Mock).mockResolvedValue({ id: FLEET, userId: USER, isSupervisor: true, isProjectSupervisor: false, projectId: null });
    return makeCtx({ sessionId: FLEET, projectId: 'chat' } as any);
  };

  it('(7) the executor refuses with the filing rule — nothing created, no strike, the message names the rule and the reporter trap', async () => {
    const out = await executePlatformTool(ungrouped(), 'start_coding_session', { title: 'Framework fix', prompt: 'Fix backend/src/modules/crossmodel/platform/platform-tools.ts' });
    expect(String(out)).toMatch(/^start_coding_session REFUSED: this chat has no project/);
    expect(String(out)).toContain('Pass projectId');
    expect(String(out)).toContain('Digby framework / harness work → the project named "crossmodel"');
    expect(String(out)).toContain('an audit of, or work on, a user project → that project');
    expect(String(out)).toContain("the REPORTER's location");
    expect(String(out)).toContain('Nothing was staged or created');
    expect(mockStartCodingSession).not.toHaveBeenCalled();
    expect(mockCanonicalize).not.toHaveBeenCalled();
    await flush();
    expect(strikes()).toEqual([]);
  });

  it('(7c) a GROUPED caller that omits projectId still defaults to its home project — the refusal is ungrouped-only', async () => {
    const out = await executePlatformTool(makeCtx(), 'start_coding_session', { title: 'child' });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(HOME);
    expect(String(out)).not.toContain('REFUSED');
    const env = JSON.parse(String(out));
    expect(env.ids.projectId).toBe(HOME);
    expect(env.ids.projectCorrectedFrom).toBeUndefined();
  });

  it('(7d) an ungrouped caller that NAMES a project is untouched by the refusal (spawns where it says)', async () => {
    mockDb.crossModelProject.findUnique.mockResolvedValue({ id: HOME, name: 'crossmodel', repoUrl: 'https://github.com/canada-quant/digby' });
    const out = await executePlatformTool(ungrouped(), 'start_coding_session', { projectId: HOME, title: 'Framework fix', prompt: 'Fix backend/src/x.ts' });
    expect(mockStartCodingSession.mock.calls[0][0].projectId).toBe(HOME);
    expect(String(out)).not.toContain('REFUSED');
  });
});

describe('misfiled-spawns-1 — get_feedback labels the reporter fields', () => {
  const CTX = { about: 'digby_platform', projectId: TTRD, sessionId: 'a8976e11', codingSessionId: 'a8976e11', surface: 'coding', dispatchedTo: 'b92ef13f', occurrences: 2 };

  it('(6) splitReporterContext moves the run-plane keys under reporter (+ note) and keeps the rest in context', () => {
    const r = splitReporterContext(CTX);
    expect(r.context).toEqual({ about: 'digby_platform', dispatchedTo: 'b92ef13f', occurrences: 2 });
    expect(r.reporter).toEqual({ projectId: TTRD, sessionId: 'a8976e11', codingSessionId: 'a8976e11', surface: 'coding', note: REPORTER_CONTEXT_NOTE });
    expect(REPORTER_CONTEXT_NOTE).toContain('NOT the project or repo of the fix');
    // No reporter keys → untouched; null / non-object → null-shaped context, no reporter key.
    expect(splitReporterContext({ occurrences: 5 })).toEqual({ context: { occurrences: 5 } });
    expect(splitReporterContext(null)).toEqual({ context: null });
    expect(splitReporterContext('x')).toEqual({ context: 'x' });
  });

  it('(6b) get_feedback renders ticket.reporter with the note and ticket.context without the reporter keys', async () => {
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: {
      id: 'c7bf1e66-0000-4000-8000-000000000000', type: 'mishap', title: 'PR head guard', description: 'd', status: 'in_progress', priority: 2, source: 'agent',
      adminNote: null, context: CTX, userId: USER, createdAt: '2026-09-17', updatedAt: '2026-09-17',
    } });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'get_feedback', { id: 'c7bf1e66' }));
    expect(out.ticket.reporter).toMatchObject({ projectId: TTRD, sessionId: 'a8976e11', note: expect.stringContaining('Never pass reporter.projectId') });
    expect(out.ticket.context).toEqual({ about: 'digby_platform', dispatchedTo: 'b92ef13f', occurrences: 2 });
    expect(out.ticket.context.projectId).toBeUndefined();
  });
});
