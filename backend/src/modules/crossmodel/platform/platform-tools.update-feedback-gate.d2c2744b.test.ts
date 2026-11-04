/**
 * Replay pin — ticket d2c2744b (mishap, breaker trip 2026-09-20T02:29:20Z,
 * session ddd26be0-723d-4745-8bb5-be3ff4752d52 "QB2 Qwen3.8 Speed Mission
 * Successor", run 1415eb30-dc35-4b06-90e9-b6d2ed347ba4, auto-filed).
 *
 * THE INCIDENT: a machine-triggered tt-rd lane with NO dispatched feedback
 * tickets called update_feedback three times with canary ids —
 * "nonexistent" ×2, then "00000000-nonexistent-probe". The ticket-18086326
 * machine-mutation gate refused all three WITHOUT mutating (correct), but
 * its refusal message narrated "the ticket is not dispatched to this
 * session (its context.dispatchedTo names another session)" — a fabricated
 * dispatch state for rows that do not exist — while the envelope's own
 * reason code said the truth: ticket_not_found. The breaker's 1200-char
 * streak-text slice then captured the fabrication as the evidence head.
 *
 * ADJUDICATION (dispatch lane, 2026-09-20): the STREAK is MODEL behavior —
 * canary/placeholder ids, no real ticket ever targeted, nothing mutated;
 * gate + breaker + auto-filer all behaved as designed (same class as
 * ea69c94e, adjudicated 2026-09-19). The MESSAGE was a deterministic
 * framework defect: platform-tools.ts built the same dispatch-binding
 * narration for EVERY non-close refusal, whether or not the ticket row
 * existed — and closure-evidence.ts's ticket_not_found verdict also covers
 * a transient LOAD failure, where the row may well exist.
 *
 * THE FIX pinned here: when the verdict's reason is ticket_not_found the
 * refusal leads with the verdict's own truth (genuinely absent vs load
 * error — closure-evidence distinguishes both) and drops the fabricated
 * "(its context.dispatchedTo names another session)" claim; the truthful
 * dispatch narration is preserved for tickets that DO exist and are bound
 * elsewhere, and the dispatch-bound + verified-evidence paths are
 * untouched.
 *
 * Sister ticket 89e66d93 (same batch — the ungrounded-update_feedback
 * fast-trip on a fumbled call) is pinned end-to-end by
 * coding/agent-derail-break.89e66d93.test.ts.
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

/** In-memory pendingConfirmation table — the DB-backed confirmation registry. */
const mockConfirmations = createPendingConfirmationTable();
/** In-memory ownerQuestion table — the "Needs owner" inbox store. */
const mockOwnerQuestions = createOwnerQuestionTable();

/** Minimal project/todo/goal stores backing the list_owner_questions second
 *  chance (mirrors platform-tools.test.ts — left empty here). */
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

// agent-auth pulls config/database + utils/jwt → config/env (process.exit in workers).
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

// The feedback service under the feedback tools — fully mocked (the real one
// pulls config/database → config/env → process.exit at import). FEEDBACK_TYPES
// is read at MODULE SCOPE by the tool schema, so mirror the real constant.
const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
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

// The verified-close evidence gate — mocked at the module boundary (reached
// via DYNAMIC import from the update_feedback handler).
const closureEvidence = {
  verifyMachineCloseEvidence: jest.fn(async (): Promise<any> => ({ ok: true, auditNote: '[machine-close evidence: test]', verified: ['commitSha'] })),
};
jest.mock('../feedback/closure-evidence', () => ({ __esModule: true, ...closureEvidence }));

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

import { executePlatformTool } from './platform-tools';
import type { ToolContext } from '../coding/tools';
import type { CodingSessionTarget } from './platform.service';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    // Machine-triggered by DEFAULT in this suite (the gate only binds there) —
    // pass userTurnAt: new Date() in overrides for a human-anchored run.
    userTurnAt: undefined,
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return { ctx };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  mockOwnerQuestions.reset();
  fb.isAdminUser.mockResolvedValue(true);
  fb.updateFeedbackTicket.mockResolvedValue({ id: 't9', status: 'in_progress', priority: 3, adminNote: 'note' });
});

describe('ticket d2c2744b replay — machine-mutation gate refusal text for a NOT-FOUND ticket id', () => {
  it('REPLAY: a canary id ("nonexistent") is refused with the ticket_not_found TRUTH leading — no fabricated dispatch state, no mutation', async () => {
    const { ctx } = makeCtx({ sessionId: 'ddd26be0-replay' });
    // The row does not exist: the gate's own binding probe finds nothing…
    fb.getFeedbackTicketById.mockResolvedValue({ ok: false, reason: 'not_found' });
    // …and the evidence verifier returns the incident's verbatim not-found verdict.
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({
      ok: false,
      reason: 'ticket_not_found',
      message: 'Feedback ticket "nonexistent" not found — nothing was closed. Copy the exact id from list_feedback.',
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 'nonexistent', status: 'in_progress', adminNote: 'auditing the gate' });
    const parsed = JSON.parse(out);

    // Same envelope family as the incident: ok:false + the truthful reason code.
    expect(parsed).toMatchObject({ ok: false, tool: 'triage_ticket', reason: 'ticket_not_found', ticketId: 'nonexistent' });
    // THE FIX: the message leads with the verdict's own not-found truth…
    expect(parsed.message).toContain('may NOT mutate feedback ticket nonexist: Feedback ticket "nonexistent" not found');
    // …and NO LONGER fabricates a dispatch state for a row that does not exist.
    expect(parsed.message).not.toContain('names another session');
    expect(parsed.message).not.toContain('not dispatched to this session');
    // The lane is steered at re-deriving a real id, and nothing was mutated.
    expect(parsed.message).toContain('list_feedback');
    expect(parsed.message).toContain('nothing was mutated');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('the LOAD-ERROR sub-case (same ticket_not_found reason): the refusal leads with the load-error truth, never the dispatch fabrication', async () => {
    const { ctx } = makeCtx({ sessionId: 'ddd26be0-replay' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: false, reason: 'load_error' });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({
      ok: false,
      reason: 'ticket_not_found',
      message: 'Could not load feedback ticket "db-wobble" to verify closure evidence — the close was NOT applied. Retry once; if it persists, leave the ticket alone and report the error.',
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 'db-wobble', status: 'in_progress' });
    const parsed = JSON.parse(out);
    expect(parsed.reason).toBe('ticket_not_found');
    expect(parsed.message).toContain('Could not load feedback ticket "db-wobble"');
    expect(parsed.message).not.toContain('names another session');
    expect(parsed.message).not.toContain('not dispatched to this session');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('NO REGRESSION: a ticket that EXISTS and is bound to another session keeps the truthful dispatch-binding narration', async () => {
    const { ctx } = makeCtx({ sessionId: 'sess-monitor' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', context: { dispatchedTo: 'sess-other-lane' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied. Re-call with evidence: {…}.' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress', adminNote: 'auditing' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, tool: 'triage_ticket', reason: 'evidence_required', ticketId: 't9' });
    expect(parsed.message).toContain('not dispatched to this session');
    expect(parsed.message).toContain('names another session');
    expect(parsed.message).toContain('Dispatch binding is the sanctioned path');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('NO REGRESSION: a ticket DISPATCH-BOUND to this session mutates without consulting the evidence gate', async () => {
    const { ctx } = makeCtx({ sessionId: 'sess-lane' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', context: { dispatchedTo: 'sess-lane' } } });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: 't9', status: 'in_progress', adminNote: 'working it', priority: 3 });
    expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith({ id: 't9', status: 'in_progress', adminNote: 'working it', priority: 3 });
    expect(out).toContain('Updated feedback ticket t9');
  });

  it('NO REGRESSION: an unbound machine mutation with VERIFIED evidence still executes, appending the audit note', async () => {
    const { ctx } = makeCtx({ sessionId: 'sess-auditor' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 't9', context: { dispatchedTo: 'sess-other-lane' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({
      ok: true, auditNote: '[machine-mutation evidence: commit abc1234]', verified: ['commitSha'],
    });
    const out = await executePlatformTool(ctx, 'update_feedback', {
      id: 't9', status: 'in_progress', adminNote: 'noting the fix', evidence: { commitSha: 'abc1234' },
    });
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith({
      id: 't9', status: 'in_progress', adminNote: 'noting the fix\n[machine-mutation evidence: commit abc1234]',
    });
    expect(out).toContain('Machine-mutation evidence verified (commitSha)');
  });
});
