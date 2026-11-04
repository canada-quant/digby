/**
 * Post-deploy done-bar gate (ticket 6665fff6 — b4824553's lifecycle half).
 *
 * Pins the three tool-path behaviors:
 *   1. A machine close to 'done' on a ticket carrying an acceptance metric is
 *      REDIRECTED to 'awaiting_verification' — done is never hand-settable for
 *      metric-carrying rows; the verifier owns the terminal transition.
 *   2. A machine close to 'done' citing a commitSha that is NOT deployed is
 *      REFUSED (fix_not_live) with the reason — "no ticket can be closed DONE
 *      at merge time".
 *   3. 'deployed_verified' / 'reopened' / 'awaiting_verification' can NEVER be
 *      hand-set through the tool (verifier-owned statuses).
 *
 * Mock discipline mirrors platform-tools.update-feedback-gate.abc76ebc.test.ts
 * (the same seams: feedback service boundary, closure-evidence boundary,
 * machine-triggered ToolContext).
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

/** In-memory pendingConfirmation table — the DB-backed confirmation registry. */
const mockConfirmations = createPendingConfirmationTable();
/** In-memory ownerQuestion table — the "Needs owner" inbox store. */
const mockOwnerQuestions = createOwnerQuestionTable();

const mockShared: { todos: any[]; goals: any[]; projects: any[] } = { todos: [], goals: [], projects: [] };
const sharedTable = (rows: () => any[]) => ({
  findUnique: async () => null,
  findFirst: async () => null,
  findMany: async () => rows(),
});

// ACCEPTANCE-METRIC-BASELINE (2026-10-20): the close-time baseline count.
const mockAppErrorCount = jest.fn(async (_a?: unknown) => 0);

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    appErrorLog: { count: (a: unknown) => mockAppErrorCount(a) },
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
  listProcesses: jest.fn(),
  processSnapshot: jest.fn(() => []),
}));

jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));

const svc = {
  resolveCodingSessionTarget: jest.fn(async (): Promise<any> => ({ ok: true, project: null, projectId: 'p1', source: 'direct' })),
  suggestProjectsByIdPrefix: jest.fn(async () => [] as Array<{ id: string; name: string }>),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write'] as const,
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

jest.mock('../fleet/fleet-telemetry', () => ({ __esModule: true, fleetTelemetry: jest.fn(async () => ({ ok: true })) }));

const supState = { isSupervisorChat: jest.fn(async () => false), applyStateUpdate: jest.fn() };
jest.mock('./supervisor-state.service', () => ({ __esModule: true, ...supState }));

const closureEvidence = {
  verifyMachineCloseEvidence: jest.fn(async (): Promise<any> => ({ ok: true, auditNote: '[machine-close evidence: commit abc123def4567890abc123def4567890abcd1234]', verified: ['commitSha'] })),
};
jest.mock('../feedback/closure-evidence', () => ({ __esModule: true, ...closureEvidence }));

// fix-state — the merged ∧ deployed proof seam (dynamically imported by the gate).
const fixState = {
  parseClosureEvidenceNote: jest.fn(() => ({ commitSha: 'abc123def4567890abc123def4567890abcd1234' })),
  resolveFixStateFromEvidence: jest.fn(),
};
jest.mock('../feedback/fix-state', () => ({ __esModule: true, ...fixState }));

const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message'] as const,
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

import { executePlatformTool } from './platform-tools';
import type { ToolContext } from '../coding/tools';

const TICKET = '6665fff6-a032-496d-b716-b07857f56aab';
const METRIC = {
  probe: 'app_error_log_count',
  params: { level: 'error', messagePattern: 'P2025' },
  operator: '<=',
  target: 0,
  windowHours: 24,
};

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'lane-02d02f81', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    userTurnAt: undefined, // machine-triggered by default
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  fb.isAdminUser.mockResolvedValue(true);
  fb.updateFeedbackTicket.mockResolvedValue({ id: TICKET, status: 'done', priority: 3, adminNote: 'note' });
  closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({
    ok: true, auditNote: '[machine-close evidence: commit abc123def4567890abc123def4567890abcd1234]', verified: ['commitSha'],
  });
  fixState.parseClosureEvidenceNote.mockReturnValue({ commitSha: 'abc123def4567890abc123def4567890abcd1234' });
});

describe('done-bar: metric-carrying close redirected to awaiting_verification', () => {
  it('a machine done close on a metric-carrying ticket lands in awaiting_verification, never done', async () => {
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: { acceptanceMetric: METRIC }, userId: null, adminNote: null } });
    fb.updateFeedbackTicket.mockResolvedValue({ id: TICKET, status: 'awaiting_verification', priority: 3, adminNote: 'note' });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'Fix landed', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } });
    // The lane's close SUCCEEDS — into limbo.
    expect(out).toContain('status=awaiting_verification');
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.status).toBe('awaiting_verification');
    expect(call.context.verification.queuedAt).toBeDefined();
    expect(call.context.verification.commitSha).toBe('abc123def4567890abc123def4567890abcd1234');
    expect(call.adminNote).toContain('done-bar redirect');
  });

  it('a ticket with NO metric closes to done only on a POSITIVE merged ∧ deployed proof', async () => {
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: {}, userId: null, adminNote: null } });
    fixState.resolveFixStateFromEvidence.mockResolvedValue({ fixLive: true, reason: 'commit abc1234 is an ancestor of origin/main (compare status ahead) ∧ deploy run 123 concluded success' });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } });
    expect(out).toContain('status=done');
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.status).toBe('done');
    expect(call.adminNote).toContain('done-bar proof');
  });
});

describe('done-bar: fix_not_live refusal', () => {
  it('a machine done close whose fix is not deployed is REFUSED with the reason', async () => {
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: {}, userId: null, adminNote: null } });
    fixState.resolveFixStateFromEvidence.mockResolvedValue({ fixLive: false, reason: 'deploy run 123 is in_progress/unconcluded — not a concluded success' });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'merged', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } }));
    expect(parsed).toMatchObject({ ok: false, reason: 'fix_not_live', ticketId: TICKET });
    expect(parsed.message).toContain('MERGED and DEPLOYED');
    expect(parsed.message).toContain('deploy run 123 is in_progress/unconcluded');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('an unprovable fix state (no token / stale telemetry) is ALSO a refusal — never a silent pass', async () => {
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: {}, userId: null, adminNote: null } });
    fixState.resolveFixStateFromEvidence.mockResolvedValue({ fixLive: false, reason: 'no box_health telemetry with a deploy sha in the last 24h' });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } }));
    expect(parsed.reason).toBe('fix_not_live');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('verifier-owned statuses are never hand-settable', () => {
  for (const bad of ['deployed_verified', 'reopened', 'awaiting_verification']) {
    it(`status=${bad} is refused before any gate runs`, async () => {
      const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: bad }));
      expect(parsed).toMatchObject({ ok: false, reason: 'verifier_owned_status' });
      expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    });
  }

  it('a HUMAN-anchored close is untouched (the admin UI path)', async () => {
    // userTurnAt set → the machine gates do not run at all.
    const out = await executePlatformTool(makeCtx({ userTurnAt: new Date() }), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'owner closed' });
    expect(out).toContain('status=done');
    expect(fb.getFeedbackTicketById).not.toHaveBeenCalled();
  });
});

describe('file_feedback acceptanceMetric (validation + flag)', () => {
  it('an INVALID metric is refused at filing — nothing filed', async () => {
    const out = await executePlatformTool(makeCtx(), 'file_feedback', {
      type: 'bug_report', title: 'x', description: 'y', about: 'digby_platform',
      digbyEvidence: 'this session is the platform repo',
      acceptanceMetric: { probe: 'exec_shell', params: { cmd: 'rm -rf /' }, operator: '==', target: 0, windowHours: 24 },
    });
    expect(out).toContain('Feedback NOT filed');
    expect(out).toContain('acceptanceMetric.probe must be one of');
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('a VALID metric is stored in context', async () => {
    fb.fileFeedbackTicket.mockResolvedValue({ ok: true, ticket: { id: 'new-1' } });
    await executePlatformTool(makeCtx(), 'file_feedback', {
      type: 'bug_report', title: 'x', description: 'y', about: 'digby_platform',
      digbyEvidence: 'this session is the platform repo',
      acceptanceMetric: METRIC,
    });
    const call = fb.fileFeedbackTicket.mock.calls[0][0];
    expect(call.context.acceptanceMetric).toEqual(METRIC);
  });

  it('a fix-class filing WITHOUT a metric is FLAGGED, not rejected', async () => {
    fb.fileFeedbackTicket.mockResolvedValue({ ok: true, ticket: { id: 'new-2' } });
    await executePlatformTool(makeCtx(), 'file_feedback', {
      type: 'bug_report', title: 'x', description: 'y', about: 'digby_platform',
      digbyEvidence: 'this session is the platform repo',
    });
    const call = fb.fileFeedbackTicket.mock.calls[0][0];
    expect(call.context.acceptanceMetricMissing).toBe(true);
  });

  it('a non-fix filing (feature_request / research_idea) is NOT flagged', async () => {
    fb.fileFeedbackTicket.mockResolvedValue({ ok: true, ticket: { id: 'new-3' } });
    await executePlatformTool(makeCtx(), 'file_feedback', {
      type: 'research_idea', title: 'x', description: 'y', about: 'digby_platform',
      digbyEvidence: 'this session is the platform repo',
    });
    const call = fb.fileFeedbackTicket.mock.calls[0][0];
    expect(call.context.acceptanceMetricMissing).toBeUndefined();
  });

  // ACCEPTANCE-METRIC-BASELINE + TICKET-FAMILY-ROUTING (2026-10-20): the result
  // line tells the filer what the filing gates did (the prefix stays parseable).
  it('says so when the baseline gate dropped a vacuous metric, and when a family member was filed queued', async () => {
    fb.fileFeedbackTicket.mockResolvedValueOnce({ deduped: false, ticket: { id: 'new-4', type: 'bug_report', priority: 2, title: 'x', status: 'open', context: { acceptanceMetricVacuous: { baseline: 0, metric: METRIC } } } });
    const out = await executePlatformTool(makeCtx(), 'file_feedback', { type: 'bug_report', title: 'x', description: 'y', about: 'digby_platform', digbyEvidence: 'platform repo', acceptanceMetric: METRIC });
    expect(out).toMatch(/^Filed feedback ticket new-4 /);
    expect(out).toContain('NOTE: your acceptanceMetric was NOT stored');
    expect(out).toContain('baseline 0 vs <= 0');
    fb.fileFeedbackTicket.mockResolvedValueOnce({ deduped: false, ticket: { id: 'new-5', type: 'bug_report', priority: 2, title: 'Missed bug: owner frustration in chat 1a2b3c4d', status: 'queued', context: { familyQueued: true } } });
    const out2 = await executePlatformTool(makeCtx(), 'file_feedback', { type: 'bug_report', title: 'Missed bug: owner frustration in chat 1a2b3c4d', description: 'y', about: 'digby_platform', digbyEvidence: 'platform repo' });
    expect(out2).toMatch(/^Filed feedback ticket new-5 /);
    expect(out2).toContain('filed QUEUED for its auto-filer family');
  });
});

describe('done-bar redirect: the close-time baseline gate (ACCEPTANCE-METRIC-BASELINE)', () => {
  // Relative to the clock: a pre-fix window older than the probes' retention
  // is UNMEASURABLE by design (review 2026-10-20), so a fixed date would rot.
  const FILED = new Date(Date.now() - 26 * 3600_000).toISOString();

  it('a metric that already passes on its pre-fix window is stamped vacuous — the close still SUCCEEDS into awaiting_verification', async () => {
    mockAppErrorCount.mockResolvedValueOnce(0);
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: { acceptanceMetric: METRIC }, userId: null, adminNote: null, createdAt: FILED } });
    fb.updateFeedbackTicket.mockResolvedValue({ id: TICKET, status: 'awaiting_verification', priority: 3, adminNote: 'note' });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'Fix landed', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } });
    expect(out).toContain('status=awaiting_verification');
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.verification.baseline).toMatchObject({ baseline: 0, measurable: true, vacuous: true, windowEnd: FILED });
    expect(call.adminNote).toContain('BASELINE (pre-fix window)');
  });

  it('a failing baseline is stamped non-vacuous with no extra note', async () => {
    mockAppErrorCount.mockResolvedValueOnce(7);
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: { acceptanceMetric: METRIC }, userId: null, adminNote: null, createdAt: FILED } });
    fb.updateFeedbackTicket.mockResolvedValue({ id: TICKET, status: 'awaiting_verification', priority: 3, adminNote: 'note' });
    await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'Fix landed', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } });
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.verification.baseline).toMatchObject({ baseline: 7, vacuous: false });
    expect(call.adminNote).not.toContain('BASELINE (pre-fix window)');
  });

  it('an AUTO-FILER default metric on a STRUCTURED no-defect close (the adjudicated stamp) is waived (no metric verdict; never reopened on it)', async () => {
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: { acceptanceMetric: METRIC, acceptanceMetricSource: 'autofiler-default', adjudicatedClass: true }, userId: null, adminNote: null, createdAt: FILED } });
    fb.updateFeedbackTicket.mockResolvedValue({ id: TICKET, status: 'awaiting_verification', priority: 3, adminNote: 'note' });
    await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'Model behavior, guard correct.', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } });
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.verification.metricWaived).toMatchObject({ reason: 'auto-filer default metric on a false-positive close' });
    expect(call.context.verification.baseline).toBeUndefined();
    expect(call.adminNote).toContain('attached by the AUTO-FILER');
    expect(mockAppErrorCount).not.toHaveBeenCalled();
  });

  it('r2: a waived close with NO fix commit says the verifier closes it on its next pass — never "once the fix is live"', async () => {
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValueOnce({ ok: true, auditNote: '[machine-close evidence: replay test backend/src/x.test.ts (verified: exists + cites 6665fff6)]', verified: ['replayTestPath'] });
    fixState.parseClosureEvidenceNote.mockReturnValue({} as any);
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: { acceptanceMetric: METRIC, acceptanceMetricSource: 'autofiler-default' }, userId: null, adminNote: null, createdAt: FILED } });
    fb.updateFeedbackTicket.mockResolvedValue({ id: TICKET, status: 'awaiting_verification', priority: 3, adminNote: 'note' });
    await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'False positive — the detector misread a literal bracket.', evidence: { replayTestPath: 'backend/src/x.test.ts' } });
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.verification.metricWaived).toBeDefined();
    expect(call.context.verification.commitSha).toBeUndefined();
    expect(call.adminNote).toContain('closes the ticket as done on its next pass');
    expect(call.adminNote).not.toContain('done once the fix is live');
  });

  it('review 2026-10-20: a free-text "guard was correct" close that SHIPPED A COMMIT is never waived — the metric still proves the fix', async () => {
    mockAppErrorCount.mockResolvedValueOnce(4);
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: { acceptanceMetric: METRIC, acceptanceMetricSource: 'autofiler-default' }, userId: null, adminNote: null, createdAt: FILED } });
    fb.updateFeedbackTicket.mockResolvedValue({ id: TICKET, status: 'awaiting_verification', priority: 3, adminNote: 'note' });
    await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'Root cause: renderer dropped the closing tag; the guard was correct to flag it.', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } });
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.verification.metricWaived).toBeUndefined();
    expect(call.context.verification.baseline).toMatchObject({ baseline: 4, vacuous: false });
  });

  it('review 2026-10-20: a MEASURED filing stamp is trusted — the close does not recount the pre-fix window', async () => {
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: TICKET, context: { acceptanceMetric: METRIC, acceptanceMetricBaseline: { baseline: 9, measurable: true, vacuous: false } }, userId: null, adminNote: null, createdAt: FILED } });
    fb.updateFeedbackTicket.mockResolvedValue({ id: TICKET, status: 'awaiting_verification', priority: 3, adminNote: 'note' });
    await executePlatformTool(makeCtx(), 'update_feedback', { id: TICKET, status: 'done', adminNote: 'Fix landed', evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' } });
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.verification.baseline).toBeUndefined();
    expect(call.context.acceptanceMetricBaseline).toMatchObject({ baseline: 9 });
    expect(mockAppErrorCount).not.toHaveBeenCalled();
  });
});
