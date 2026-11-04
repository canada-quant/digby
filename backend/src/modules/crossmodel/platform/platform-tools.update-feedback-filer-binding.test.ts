/**
 * Filer binding for the update_feedback machine-mutation gate — project-lane
 * audit finding E1 (2026-09-27; canlaw / canlegal-bench / spark-cluster pass).
 *
 * THE DEFECT: the ticket-18086326 gate authorized a machine run's
 * in_progress / adminNote / priority mutations ONLY when the ticket was
 * stamped `context.dispatchedTo === ctx.sessionId` — and the fleet ticket
 * dispatcher (feedback/ticket-dispatch.service.ts markDispatched →
 * stampDispatchClock) is the ONLY stamp site. A ticket a project lane filed
 * ITSELF via file_feedback was therefore never bound, every non-close
 * mutation on it was refused for lack of evidence, and every "ticket closed
 * / moved to in_progress" a lane narrated was fiction. Prod run_tool_receipts
 * since 2026-09-21: 244 ok (dispatched lanes) vs 98 failed, top failers all
 * project lanes (e083ff2e 21, cec340f2 16, 596102ca 15, 10cb988f 14).
 *
 * THE FIX pinned here:
 *   - file_feedback stamps `context.filedBy = ctx.sessionId`;
 *   - the gate accepts `filedBy === ctx.sessionId` (and, for rows filed before
 *     the stamp shipped, the older `context.sessionId` stamp on an AGENT row)
 *     for in_progress / adminNote / priority — status=done keeps the evidence bar;
 *   - an unbound refusal mints ONE guard_strike row {seam:'update_feedback_unbound'}
 *     (telemetry only — the refusal text is unchanged in kind);
 *   - the dedup message names whether THIS session is the filer.
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockConfirmations = createPendingConfirmationTable();
const mockOwnerQuestions = createOwnerQuestionTable();

const mockShared: { todos: any[]; goals: any[]; projects: any[] } = { todos: [], goals: [], projects: [] };
const sharedTable = (rows: () => any[]) => ({
  findUnique: async () => null,
  findFirst: async () => null,
  findMany: async () => rows(),
});

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    ownerQuestion: mockOwnerQuestions.api,
    crossModelMessage: mockOwnerQuestions.crossModelMessage,
    crossModelChat: mockOwnerQuestions.crossModelChat,
    telegramLink: { findUnique: async () => null },
    projectTodo: sharedTable(() => mockShared.todos),
    projectGoal: sharedTable(() => mockShared.goals),
    crossModelProject: { findUnique: async () => null },
    projectMember: { findMany: async () => [] },
  },
}));

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: async () => {},
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) },
}));

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
  startBackgroundProcess: jest.fn(),
  waitForProcessOutput: jest.fn(),
  readProcessOutput: jest.fn(),
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

const svc = {
  resolveCodingSessionTarget: jest.fn(async (): Promise<CodingSessionTarget> => ({
    ok: true,
    project: {
      id: 'p1', userId: 'u1', name: 'Project P', repoUrl: 'https://github.com/a/b',
      defaultBranch: 'main', provider: 'github', githubLabel: null, folderId: null,
      createdAt: new Date(), updatedAt: new Date(),
    },
    projectId: 'p1',
    source: 'direct',
  })),
  suggestProjectsByIdPrefix: jest.fn(async () => [] as Array<{ id: string; name: string }>),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  shortenFilingTitle: jest.fn((title: string) => ({ title: title.trim(), shortened: title.trim().length > 140, originalTitle: title.trim() })),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

const mockFleetTelemetry: jest.Mock = jest.fn(async () => ({ ok: true }));
jest.mock('../fleet/fleet-telemetry', () => ({ __esModule: true, fleetTelemetry: (...a: any[]) => mockFleetTelemetry(...a) }));

const supState = { isSupervisorChat: jest.fn(async () => false), applyStateUpdate: jest.fn() };
jest.mock('./supervisor-state.service', () => ({ __esModule: true, ...supState }));

const closureEvidence = {
  verifyMachineCloseEvidence: jest.fn(async (): Promise<any> => ({ ok: true, auditNote: '[machine-close evidence: test]', verified: ['commitSha'] })),
};
jest.mock('../feedback/closure-evidence', () => ({ __esModule: true, ...closureEvidence }));

// fix-state — the merged ∧ deployed proof the done-bar gate runs (6665fff6).
const fixState = {
  parseClosureEvidenceNote: jest.fn(() => ({ commitSha: 'abc1234' })),
  resolveFixStateFromEvidence: jest.fn(async () => ({ fixLive: true, reason: 'commit abc1234 is an ancestor of origin/main ∧ deploy run 42 concluded success' })),
};
jest.mock('../feedback/fix-state', () => ({ __esModule: true, ...fixState }));

/** The loop_metrics seam the gate's refusal telemetry rides (dynamic import). */
const loopMetrics = {
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
  recordLoopMetric: jest.fn(),
};
jest.mock('./loop-metrics.service', () => ({ __esModule: true, ...loopMetrics }));

const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async () => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

const uploadCtl = {
  loadAttachment: jest.fn(async (): Promise<any> => null),
  combineAttachments: jest.fn((atts: any[]) => atts[0]),
};
jest.mock('../upload.controller', () => ({ __esModule: true, ...uploadCtl }));

import { executePlatformTool, filerBoundToSession, filerBindingVerdict } from './platform-tools';
import type { ToolContext } from '../coding/tools';
import type { CodingSessionTarget } from './platform.service';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    userTurnAt: undefined, // machine-triggered by default — the gate binds only there
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return { ctx };
}

const strikes = () => loopMetrics.recordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'guard_strike');
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  mockOwnerQuestions.reset();
  fb.isAdminUser.mockResolvedValue(true);
  fb.updateFeedbackTicket.mockResolvedValue({ id: 't9', status: 'in_progress', priority: 3, adminNote: 'note' });
});

describe('filerBoundToSession (pure leaf)', () => {
  it('binds on context.filedBy === sessionId (agent-sourced or source-unknown rows)', () => {
    expect(filerBoundToSession({ filedBy: 'lane-A' }, 'agent', 'lane-A')).toBe(true);
    expect(filerBoundToSession({ filedBy: 'lane-A' }, undefined, 'lane-A')).toBe(true); // source not selected ⇒ not a refusal
    expect(filerBoundToSession({ filedBy: 'lane-A' }, 'agent', 'lane-B')).toBe(false);
  });
  it('REVIEW FIX 1: a USER-sourced row never binds a lane, filedBy or not (a UI filing is not a lane claim)', () => {
    expect(filerBoundToSession({ filedBy: 'lane-A' }, 'user', 'lane-A')).toBe(false);
    expect(filerBindingVerdict({ filedBy: 'lane-A' }, 'user', 'lane-A')).toEqual({ bound: false, reason: 'user_sourced' });
  });
  it('REVIEW FIX 1: the legacy context.sessionId branch is GONE — a row with only sessionId binds nobody, whatever its source', () => {
    expect(filerBoundToSession({ sessionId: 'lane-A' }, 'agent', 'lane-A')).toBe(false);
    expect(filerBoundToSession({ sessionId: 'lane-A' }, 'user', 'lane-A')).toBe(false);
    expect(filerBoundToSession({ sessionId: 'lane-A' }, undefined, 'lane-A')).toBe(false);
    expect(filerBindingVerdict({ sessionId: 'lane-A', surface: 'coding' }, 'agent', 'lane-A')).toEqual({ bound: false, reason: 'not_filer' });
  });
  it('REVIEW FIX 1: a HARNESS-filed row (verifier / class stamp) never binds — even when it names this session, even with a forged filedBy', () => {
    // The exact shapes the harness filers write (action-verifier.ts:3168 / 4732, run-executor.ts:1908, agent.ts:2591 / 2701).
    const actionVerifier = { sessionId: 'sup-chat', surface: 'chat', verifier: 'action-verifier', filedAt: '2026-09-27T00:00:00Z' };
    const evidenceGuard = { sessionId: 'lane-A', surface: 'coding', verifier: 'evidence-guard', runId: 'run-1', filedAt: '2026-09-27T00:00:00Z', containedPreDelivery: true };
    const providerBilling = { sessionId: 'lane-A', class: 'provider_billing', filedAt: '2026-09-27T00:00:00Z' };
    const seatMisconfigured = { sessionId: 'lane-A', class: 'seat_capability_rejection', model: 'm', filedAt: '2026-09-27T00:00:00Z' };
    expect(filerBindingVerdict(actionVerifier, 'agent', 'sup-chat')).toEqual({ bound: false, reason: 'harness_filed' });
    expect(filerBindingVerdict(evidenceGuard, 'agent', 'lane-A')).toEqual({ bound: false, reason: 'harness_filed' });
    expect(filerBindingVerdict(providerBilling, 'agent', 'lane-A')).toEqual({ bound: false, reason: 'harness_filed' });
    expect(filerBindingVerdict(seatMisconfigured, 'agent', 'lane-A')).toEqual({ bound: false, reason: 'harness_filed' });
    // A verifier stamp outranks filedBy: a row carrying both is never the lane's own filing.
    expect(filerBindingVerdict({ ...evidenceGuard, filedBy: 'lane-A' }, 'agent', 'lane-A')).toEqual({ bound: false, reason: 'harness_filed' });
  });
  it('REVIEW FIX 2: filer binding lapses while the ticket is DISPATCHED to another session; a self-dispatch or an empty stamp keeps it', () => {
    expect(filerBindingVerdict({ filedBy: 'lane-A', dispatchedTo: 'batch-7' }, 'agent', 'lane-A')).toEqual({ bound: false, reason: 'dispatched_elsewhere' });
    expect(filerBindingVerdict({ filedBy: 'lane-A', dispatchedTo: 'lane-A' }, 'agent', 'lane-A')).toEqual({ bound: true });
    expect(filerBindingVerdict({ filedBy: 'lane-A', dispatchedTo: '' }, 'agent', 'lane-A')).toEqual({ bound: true });
    expect(filerBindingVerdict({ filedBy: 'lane-A', dispatchedTo: '   ' }, 'agent', 'lane-A')).toEqual({ bound: true });
    expect(filerBindingVerdict({ filedBy: 'lane-A' }, 'agent', 'lane-A')).toEqual({ bound: true });
  });
  it('fails CLOSED on a missing/malformed context or session id', () => {
    expect(filerBoundToSession(null, 'agent', 'lane-A')).toBe(false);
    expect(filerBoundToSession(undefined, 'agent', 'lane-A')).toBe(false);
    expect(filerBoundToSession({ filedBy: 42 as any }, 'agent', 'lane-A')).toBe(false);
    expect(filerBoundToSession({ filedBy: 'lane-A' }, 'agent', undefined)).toBe(false);
    expect(filerBoundToSession({ filedBy: '' }, 'agent', '')).toBe(false);
    expect(filerBindingVerdict(null, 'agent', 'lane-A')).toEqual({ bound: false, reason: 'no_context' });
  });
});

describe('file_feedback stamps the filer session (context.filedBy)', () => {
  it('a lane filing from a coding session stamps filedBy = its session id', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-canlaw', userId: 'u1', agentSurface: 'coding' });
    fb.fileFeedbackTicket.mockResolvedValue({ deduped: false, ticket: { id: 't1', type: 'bug_report', title: 'T', priority: 2 } });
    // A coding-surface run is project-scoped: the subject guard needs the classification.
    const out = await executePlatformTool(ctx, 'file_feedback', {
      type: 'bug_report', title: 'T', description: 'D',
      about: 'digby_platform', digbyEvidence: "This session's project is the Digby platform repo.",
    });
    expect(out).toContain('Filed feedback ticket t1');
    const call = fb.fileFeedbackTicket.mock.calls[0][0];
    expect(call.context).toMatchObject({ sessionId: 'lane-canlaw', filedBy: 'lane-canlaw', codingSessionId: 'lane-canlaw' });
  });

  it('REVIEW FIX 3: the filed-success line carries ONE posture — filer may move it while undispatched, the dispatched lane owns it after, monitor/audit/supervisor lanes never mutate — and names load_tool_group (fix 4)', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-canlaw', agentSurface: 'coding' });
    fb.fileFeedbackTicket.mockResolvedValue({ deduped: false, ticket: { id: 't1', type: 'bug_report', title: 'T', priority: 2 } });
    const out = await executePlatformTool(ctx, 'file_feedback', {
      type: 'bug_report', title: 'T', description: 'D', about: 'digby_platform', digbyEvidence: 'Digby platform repo.',
    });
    // The receipt/extractor prefix is byte-identical (executed-actions.ts + run-receipts catalogue key on it).
    expect(out).toMatch(/^Filed feedback ticket t1 \(bug_report, priority 2\): "T"\./);
    expect(out).toContain('Filer binding: this session may move it with triage_ticket (in_progress / adminNote / priority; status=done needs evidence) only while no other lane is dispatched to it');
    expect(out).toContain('the dispatched lane owns it from then on');
    expect(out).toContain('monitor/audit/supervisor lanes never mutate triage state, not even on tickets they filed');
    expect(out).toContain('load_tool_group({group:"triage"})');
    // The contradicted order is gone.
    expect(out).not.toContain('do not follow up on it in this run');
  });

  it('the dedup message tells a lane that it IS the filer (may triage) — and names load_tool_group for coding sessions (fix 4)', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-canlaw' });
    fb.fileFeedbackTicket.mockResolvedValue({ deduped: true, ticket: { id: 't1', title: 'T', priority: 2, context: { occurrences: 3, filedBy: 'lane-canlaw' } } });
    const out = await executePlatformTool(ctx, 'file_feedback', { type: 'bug_report', title: 'T', description: 'D' });
    expect(out).toContain('Already tracked as ticket t1');
    expect(out).toContain('This session filed it — you may triage it with update_feedback');
    expect(out).toContain('unless the dispatcher hands it to another lane first');
    expect(out).toContain('load_tool_group({group:"triage"})');
  });

  it('REVIEW FIX 2: the dedup message tells the FILER that its ticket is now dispatched to another lane — do not update_feedback it', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-canlaw' });
    fb.fileFeedbackTicket.mockResolvedValue({ deduped: true, ticket: { id: 't1', title: 'T', priority: 2, context: { occurrences: 3, filedBy: 'lane-canlaw', dispatchedTo: 'batch-7777-aaaa' } } });
    const out = await executePlatformTool(ctx, 'file_feedback', { type: 'bug_report', title: 'T', description: 'D' });
    expect(out).toContain('This session filed it, but it is now dispatched to another lane (batch-77) which owns its triage — do not update_feedback it');
    expect(out).not.toContain('you may triage it');
  });

  it('… or that ANOTHER session filed it (sighting recorded, do not update_feedback)', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-spark' });
    fb.fileFeedbackTicket.mockResolvedValue({ deduped: true, ticket: { id: 't1', title: 'T', priority: 2, context: { occurrences: 3, filedBy: 'lane-canlaw' } } });
    const out = await executePlatformTool(ctx, 'file_feedback', { type: 'bug_report', title: 'T', description: 'D' });
    expect(out).toContain('Another session filed it');
    expect(out).toContain('do not update_feedback it');
  });
});

describe('update_feedback machine-mutation gate — filer binding (audit E1)', () => {
  it('REPLAY: a project lane moving ITS OWN filed ticket to in_progress mutates without the evidence gate (was refused before)', async () => {
    const { ctx } = makeCtx({ sessionId: 'e083ff2e-lane' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { filedBy: 'e083ff2e-lane', sessionId: 'e083ff2e-lane' } } });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress', adminNote: 'working it', priority: 3 });
    expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith({ id: 't9', status: 'in_progress', adminNote: 'working it', priority: 3 });
    expect(out).toContain('Updated feedback ticket t9');
    expect(out).toContain('filer-bound');
    await flush();
    expect(strikes()).toEqual([]);
  });

  it('adminNote-only and priority-only mutations on a self-filed ticket are filer-bound too', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { filedBy: 'lane-A' } } });
    await executePlatformTool(ctx, 'update_feedback', { id: 't9', adminNote: 'root cause found' });
    await executePlatformTool(ctx, 'update_feedback', { id: 't9', priority: 4 });
    expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(2);
  });

  it('REVIEW FIX 1: a LEGACY agent row (context.sessionId only, no filedBy) NO LONGER binds — the legacy branch is gone (strike binding:not_filer)', async () => {
    const { ctx } = makeCtx({ sessionId: 'cec340f2-lane' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { sessionId: 'cec340f2-lane', surface: 'coding' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    await flush();
    expect(strikes()[0]).toMatchObject({ meta: { seam: 'update_feedback_unbound', reason: 'evidence_required', evidenceReason: 'evidence_required', binding: 'not_filer', filedBy: null } });
  });

  describe('REVIEW FIX 1 — REPLAY: harness-filed mishap rows name the convicted session; that session must never move its own adjudication ticket', () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      // action-verifier.ts:3168 — phantom-claim mishap filed against a supervisor chat (ctx.sessionId = the chat id on its next wake).
      ['action-verifier phantom-claim row (chat surface)', { sessionId: 'sup-chat-1', surface: 'chat', verifier: 'action-verifier', filedAt: '2026-09-27T10:00:00Z', seat: 'fleet-supervisor' }, 'sup-chat-1'],
      // action-verifier.ts:4732 — future-clock mishap, containedPreDelivery.
      ['action-verifier future-clock row', { sessionId: 'sup-chat-1', surface: 'chat', verifier: 'action-verifier', filedAt: '2026-09-27T10:00:00Z', containedPreDelivery: true }, 'sup-chat-1'],
      // run-executor.ts:1908 — evidence-guard mishap filed against a coding session.
      ['evidence-guard row (coding surface)', { sessionId: 'lane-e083', surface: 'coding', verifier: 'evidence-guard', runId: 'run-9', filedAt: '2026-09-27T10:00:00Z', containedPreDelivery: true }, 'lane-e083'],
      // agent.ts:2591 / 2701 — owner-action rows stamped with the lane's own session id.
      ['provider-billing owner-action row', { sessionId: 'lane-e083', class: 'provider_billing', filedAt: '2026-09-27T10:00:00Z' }, 'lane-e083'],
      ['seat-misconfigured owner-action row', { sessionId: 'lane-e083', class: 'seat_capability_rejection', model: 'glm-5.3', filedAt: '2026-09-27T10:00:00Z' }, 'lane-e083'],
    ];
    for (const [label, context, sessionId] of cases) {
      it(`${label}: in_progress / adminNote / priority from the named session are REFUSED — strike reason harness_filed, the note names the harness`, async () => {
        const { ctx } = makeCtx({ sessionId });
        fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 'm1234567-full', source: 'agent', context } });
        closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
        const out = await executePlatformTool(ctx, 'update_feedback', { id: 'm1234567-full', status: 'in_progress', adminNote: 'adjudicated: not a phantom', priority: 1 });
        const parsed = JSON.parse(out);
        expect(parsed).toMatchObject({ ok: false, tool: 'triage_ticket', reason: 'evidence_required' });
        expect(parsed.message).toContain('filed BY THE HARNESS about this session');
        expect(parsed.message).toContain('not dispatched to this session');
        expect(parsed.message).not.toContain('filer-bound');
        expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
        await flush();
        const rows = strikes();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: 'guard_strike', sessionId,
          meta: { seam: 'update_feedback_unbound', ticketId: 'm1234567', status: 'in_progress', reason: 'harness_filed', evidenceReason: 'evidence_required', binding: 'harness_filed', filedBy: null },
        });
      });
    }

    it('a harness row that names ANOTHER session reads as harness-filed too (never "filed BY THE HARNESS about this session")', async () => {
      const { ctx } = makeCtx({ sessionId: 'lane-other' });
      fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 'm1', source: 'agent', context: { sessionId: 'lane-e083', surface: 'coding', verifier: 'evidence-guard' } } });
      closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
      const parsed = JSON.parse(await executePlatformTool(ctx, 'update_feedback', { id: 'm1', adminNote: 'auditing' }));
      expect(parsed.message).toContain('filed BY THE HARNESS (a verifier / guard / billing filing');
      expect(parsed.message).not.toContain('about this session');
      expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    });

    it('a harness row still closes/moves with VERIFIED evidence (the evidence path is untouched — the rail only removes the free binding)', async () => {
      const { ctx } = makeCtx({ sessionId: 'lane-e083' });
      fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 'm1', source: 'agent', context: { sessionId: 'lane-e083', surface: 'coding', verifier: 'evidence-guard' } } });
      closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: true, auditNote: '[machine-mutation evidence: replay test]', verified: ['replayTestPath'] });
      const out = await executePlatformTool(ctx, 'update_feedback', { id: 'm1', status: 'in_progress', adminNote: 'replay committed', evidence: { replayTestPath: 'x.test.ts' } });
      expect(fb.updateFeedbackTicket).toHaveBeenCalledWith({ id: 'm1', status: 'in_progress', adminNote: 'replay committed\n[machine-mutation evidence: replay test]' });
      expect(out).toContain('Machine-mutation evidence verified (replayTestPath)');
      await flush();
      expect(strikes()).toEqual([]);
    });
  });

  describe('REVIEW FIX 2 — a filer is NOT a second machine writer on a ticket dispatched to another lane', () => {
    it('filedBy === this session, dispatchedTo === another session → REFUSED (strike reason dispatched_elsewhere; the note names the dispatched lane as owner)', async () => {
      const { ctx } = makeCtx({ sessionId: 'sup-project-1' });
      fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 'd9abcdef-full', source: 'agent', context: { filedBy: 'sup-project-1', sessionId: 'sup-project-1', dispatchedTo: 'batch-4242-aaaa', dispatchedAt: '2026-09-27T10:00:00Z' } } });
      closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
      // The re-dispatch-storm shape: the filer flipping the in-flight ticket back to open + replacing the lane's adminNote.
      const out = await executePlatformTool(ctx, 'update_feedback', { id: 'd9abcdef-full', status: 'open', adminNote: 'still broken, re-queue' });
      const parsed = JSON.parse(out);
      expect(parsed).toMatchObject({ ok: false, tool: 'triage_ticket', reason: 'evidence_required', ticketId: 'd9abcdef-full' });
      expect(parsed.message).toContain('this session FILED the ticket (context.filedBy), but it is now dispatched to another session');
      expect(parsed.message).toContain('a live dispatch supersedes filer binding');
      expect(parsed.message).toContain('not dispatched to this session');
      expect(parsed.message).toContain('do not flip its status or replace its adminNote');
      expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
      await flush();
      const rows = strikes();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        meta: { seam: 'update_feedback_unbound', ticketId: 'd9abcdef', status: 'open', reason: 'dispatched_elsewhere', evidenceReason: 'evidence_required', binding: 'dispatched_elsewhere', dispatchedTo: 'batch-42', filedBy: 'sup-proj' },
      });
    });

    it('filedBy === this session AND dispatchedTo === this session → mutates (dispatch binding wins the label)', async () => {
      const { ctx } = makeCtx({ sessionId: 'lane-A' });
      fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { filedBy: 'lane-A', dispatchedTo: 'lane-A' } } });
      const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress' });
      expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
      expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
      expect(out).toContain('Updated feedback ticket t9');
      expect(out).not.toContain('filer-bound');
    });

    it('filedBy === this session with NO dispatch stamp (or an empty one) → filer-bound, as before', async () => {
      const { ctx } = makeCtx({ sessionId: 'lane-A' });
      fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { filedBy: 'lane-A', dispatchedTo: '' } } });
      const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', adminNote: 'root cause' });
      expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
      expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
      expect(out).toContain('filer-bound');
      await flush();
      expect(strikes()).toEqual([]);
    });
  });

  describe('REVIEW FIX 3 — supervisor-class chats are never filer-bound (file, cite, stand down)', () => {
    it('a supervisor chat moving a ticket it filed is REFUSED (strike reason supervisor_filer); the description and the leaf agree', async () => {
      supState.isSupervisorChat.mockResolvedValueOnce(true);
      const { ctx } = makeCtx({ sessionId: 'fleet-supervisor-chat' });
      fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 's1abcdef-full', source: 'agent', context: { filedBy: 'fleet-supervisor-chat', sessionId: 'fleet-supervisor-chat', surface: 'chat' } } });
      closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
      const out = await executePlatformTool(ctx, 'update_feedback', { id: 's1abcdef-full', status: 'in_progress', adminNote: 'working it myself' });
      const parsed = JSON.parse(out);
      expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
      expect(parsed.message).toContain('supervisor chats are never filer-bound');
      expect(parsed.message).toContain('stands down');
      expect(supState.isSupervisorChat).toHaveBeenCalledWith('fleet-supervisor-chat');
      expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
      await flush();
      expect(strikes()[0]).toMatchObject({ meta: { seam: 'update_feedback_unbound', reason: 'supervisor_filer', binding: 'supervisor_filer', filedBy: 'fleet-su' } });
    });

    it('the supervisor read runs ONLY when the leaf would bind (a foreign ticket never costs the extra read) and a read error keeps the lane binding', async () => {
      const { ctx } = makeCtx({ sessionId: 'lane-A' });
      fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { filedBy: 'lane-B' } } });
      closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
      await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress' });
      expect(supState.isSupervisorChat).not.toHaveBeenCalled();

      supState.isSupervisorChat.mockRejectedValueOnce(new Error('db wobble'));
      fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { filedBy: 'lane-A' } } });
      const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress' });
      expect(out).toContain('filer-bound');
      expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
    });
  });

  it('a USER-filed row whose context.sessionId matches does NOT bind (a UI filing is not a lane claim)', async () => {
    const { ctx } = makeCtx({ sessionId: 'chat-7' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'user', context: { sessionId: 'chat-7' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('status=done from the FILER still requires the evidence bar (filer binding never exempts a close)', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { filedBy: 'lane-A' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied. Re-call with evidence: {…}.' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'done', adminNote: 'fixed' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, tool: 'triage_ticket', reason: 'evidence_required', ticketId: 't9' });
    expect(closureEvidence.verifyMachineCloseEvidence).toHaveBeenCalledWith({ ticketId: 't9', evidence: undefined });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    await flush();
    // A close refusal is the verified-close gate, not an "unbound" strike.
    expect(strikes()).toEqual([]);
  });

  it('status=done from the FILER with VERIFIED evidence closes (audit note + done-bar proof appended)', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { filedBy: 'lane-A' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: true, auditNote: '[machine-close evidence: commit abc1234]', verified: ['commitSha'] });
    fb.updateFeedbackTicket.mockResolvedValue({ id: 't9', status: 'done', priority: 3, adminNote: 'x' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'done', adminNote: 'fixed', evidence: { commitSha: 'abc1234' } });
    // 6665fff6: a plain (no-metric) done close still lands in done, now with
    // the merged ∧ deployed proof recorded in the adminNote.
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith({
      id: 't9', status: 'done',
      adminNote: 'fixed\n[machine-close evidence: commit abc1234]\n[done-bar proof (6665fff6)]: fix verified live at close — commit abc1234 is an ancestor of origin/main ∧ deploy run 42 concluded success',
    });
    expect(out).toContain('Machine-close evidence verified (commitSha)');
  });

  it("ANOTHER lane's ticket (filed and dispatched elsewhere) is still refused — and mints ONE guard_strike {seam:update_feedback_unbound}", async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-spark' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9abcdef-full', source: 'agent', context: { filedBy: 'lane-canlaw', dispatchedTo: 'lane-canlaw' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9abcdef-full', status: 'in_progress', adminNote: 'auditing' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, tool: 'triage_ticket', reason: 'evidence_required' });
    // The refusal names BOTH sanctioned bindings.
    expect(parsed.message).toContain('not dispatched to this session');
    expect(parsed.message).toContain('was not filed by this session (context.filedBy)');
    expect(parsed.message).toContain('so does the lane that FILED a ticket');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    await flush();
    const rows = strikes();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'guard_strike', sessionId: 'lane-spark',
      meta: {
        seam: 'update_feedback_unbound', tool: 'update_feedback', ticketId: 't9abcdef', status: 'in_progress',
        reason: 'evidence_required', dispatchedTo: 'lane-can', filedBy: 'lane-can', filerBindingEnabled: true,
      },
    });
  });

  it('an unbound refusal on a ticket with NO stamps at all records null stamps (the row still tells the audit the ticket was never bound to anyone)', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-spark' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'user', context: {} } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    await executePlatformTool(ctx, 'update_feedback', { id: 't9', adminNote: 'auditing' });
    await flush();
    expect(strikes()[0]).toMatchObject({ meta: { seam: 'update_feedback_unbound', status: 'note_only', dispatchedTo: null, filedBy: null } });
  });

  it('a NOT-FOUND id mints no unbound strike (ticket d2c2744b: a phantom row has no binding state to strike on)', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-spark' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: false, reason: 'not_found' });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'ticket_not_found', message: 'Feedback ticket "nonexistent" not found — nothing was closed.' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 'nonexistent', status: 'in_progress' });
    expect(JSON.parse(out).reason).toBe('ticket_not_found');
    await flush();
    expect(strikes()).toEqual([]);
  });

  it('NO REGRESSION: a DISPATCH-bound ticket still mutates without the gate (and is not labelled filer-bound)', async () => {
    const { ctx } = makeCtx({ sessionId: 'sess-lane' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', source: 'agent', context: { dispatchedTo: 'sess-lane', filedBy: 'sess-other' } } });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress' });
    expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(out).not.toContain('filer-bound');
  });

  it('NO REGRESSION: a HUMAN-anchored run never consults binding at all', async () => {
    const { ctx } = makeCtx({ sessionId: 'chat-human', userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress', adminNote: 'triaged by hand' });
    expect(fb.getFeedbackTicketById).not.toHaveBeenCalled();
    expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
    expect(out).toContain('Updated feedback ticket t9');
  });
});
