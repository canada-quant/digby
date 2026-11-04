/**
 * Replay for ticket abc76ebc — DEFECT B: the machine-mutation gate's default
 * refusal narrated a dispatch state the ticket never had.
 * (mishap, breaker trip 2026-10-15T18:37:05Z, session b92ef13f…, run 9232e15b…;
 * refusals #3/#4 at 18:37:00/18:37:02 on tickets afc10e95 / 6fd4663a.)
 *
 * THE INCIDENT: after the deploy-window close refusals, the lane called
 * update_feedback(status:'in_progress', adminNote) on the two nightly-suite
 * tickets — rows that were NEVER dispatched to any session (context:null;
 * held for owner review since 15:32:57Z; the oq_e4869c75 approval was
 * answered by a supervisor but never stamped through the admin-UI
 * approve-for-lane path, so the dispatcher never bound a lane). The gate
 * CORRECTLY refused both (unbound machine mutation, no evidence) — but the
 * default-branch message fabricated "(its context.dispatchedTo names
 * another session)" while the gate's own guard_strike telemetry for those
 * very calls stamped binding:'no_context', dispatchedTo:null, filedBy:null.
 *
 * THE FIX PINNED HERE: when the loaded ticket row exists but carries NO
 * dispatchedTo stamp, the refusal narrates the row's REAL state ("it has
 * never been dispatched to any session — no context.dispatchedTo stamp") —
 * the same truthfulness bar d2c2744b set for the ticket_not_found shape.
 * The genuine dispatched-elsewhere narration (a real dispatch to another
 * lane) is preserved as the NO-REGRESSION case, and dispatch-bound /
 * verified-evidence paths are untouched.
 *
 * Scaffold mirrors platform-tools.update-feedback-gate.d2c2744b.test.ts
 * (same mock set — the REAL gate runs; only the feedback service and the
 * closure-evidence verifier are mocked at their seams).
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
    isOperational = true;
    constructor(public statusCode: number, public message: string) {
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
  resolveCodingSessionTarget: jest.fn(async (): Promise<any> => ({
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

// The incident's REAL ids (verbatim from ticket abc76ebc's body).
const NIGHTLY_TICKET = 'afc10e95-cf22-4c45-ad22-e7b1e81a439e';
const SIBLING_TICKET = '6fd4663a-db0d-4c42-a0d2-9b66c12f096c';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'b92ef13f-replay', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    // Machine-triggered by DEFAULT (the gate only binds there).
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
  fb.updateFeedbackTicket.mockResolvedValue({ id: NIGHTLY_TICKET, status: 'in_progress', priority: 3, adminNote: 'note' });
});

describe('ticket abc76ebc DEFECT B — machine-mutation gate refusal text for an EXISTS-but-NEVER-DISPATCHED ticket', () => {
  it('REPLAY (refusals #3/#4, 18:37:00Z + 18:37:02Z): a held, undispatched ticket (context:null) is refused with its REAL state — never the fabricated "names another session"', async () => {
    const { ctx } = makeCtx();
    // The nightly-suite rows as the gate saw them: EXISTS, context NULL —
    // held for owner review since 15:32:57Z, approval never stamped.
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: NIGHTLY_TICKET, context: null } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({
      ok: false, reason: 'evidence_required',
      message: 'No evidence supplied. Re-call with evidence: { … }.',
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: NIGHTLY_TICKET, status: 'in_progress', adminNote: 'Fix MERGED — close retry pending deploy sync.' });
    const parsed = JSON.parse(out);

    // Same envelope family as the incident: ok:false + the truthful reason code.
    expect(parsed).toMatchObject({ ok: false, tool: 'triage_ticket', reason: 'evidence_required', ticketId: NIGHTLY_TICKET });
    // THE FIX: the message narrates the row's REAL state…
    expect(parsed.message).toContain('not dispatched to this session');
    expect(parsed.message).toContain('it has never been dispatched to any session — no context.dispatchedTo stamp');
    // …and NO LONGER fabricates a dispatch that never existed.
    expect(parsed.message).not.toContain('names another session');
    // The sanctioned paths keep their guidance (identical to the incident's message otherwise).
    expect(parsed.message).toContain('Dispatch binding is the sanctioned path');
    expect(parsed.message).toContain('file_feedback sighting');
    // Nothing was mutated.
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('the sibling ticket (6fd4663a) same shape — same truthful narration', async () => {
    const { ctx } = makeCtx();
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: SIBLING_TICKET, context: null } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({
      ok: false, reason: 'evidence_required', message: 'No evidence supplied.',
    });
    const parsed = JSON.parse(await executePlatformTool(ctx, 'update_feedback', { id: SIBLING_TICKET, status: 'in_progress' }));
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(parsed.message).toContain('it has never been dispatched to any session');
    expect(parsed.message).not.toContain('names another session');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('an agent-filed row with context but NO dispatchedTo (filer-bound rules evaluated, still unbound) also reads the truthful shape', async () => {
    const { ctx } = makeCtx();
    // filedBy names ANOTHER session (not this one) and no dispatch exists.
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: SIBLING_TICKET, source: 'agent', context: { filedBy: 'some-other-lane', surface: 'coding' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const parsed = JSON.parse(await executePlatformTool(ctx, 'update_feedback', { id: SIBLING_TICKET, status: 'in_progress' }));
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(parsed.message).toContain('it has never been dispatched to any session');
    expect(parsed.message).not.toContain('names another session');
  });

  it('NO REGRESSION: a ticket genuinely DISPATCHED ELSEWHERE keeps the truthful dispatch-binding narration (d2c2744b case)', async () => {
    const { ctx } = makeCtx();
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: NIGHTLY_TICKET, context: { dispatchedTo: 'lane-0be614ce' } } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const parsed = JSON.parse(await executePlatformTool(ctx, 'update_feedback', { id: NIGHTLY_TICKET, status: 'in_progress', adminNote: 'auditing' }));
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(parsed.message).toContain('names another session');
    expect(parsed.message).toContain('Dispatch binding is the sanctioned path');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('NO REGRESSION: a ticket DISPATCH-BOUND to this session mutates without consulting the evidence gate', async () => {
    const { ctx } = makeCtx();
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: NIGHTLY_TICKET, context: { dispatchedTo: 'b92ef13f-replay' } } });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: NIGHTLY_TICKET, status: 'in_progress', adminNote: 'working it', priority: 3 });
    expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith({ id: NIGHTLY_TICKET, status: 'in_progress', adminNote: 'working it', priority: 3 });
    expect(out).toContain('Updated feedback ticket');
  });

  it('NO REGRESSION: an unbound machine mutation with VERIFIED evidence still executes, appending the audit note', async () => {
    const { ctx } = makeCtx();
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: NIGHTLY_TICKET, context: null } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({
      ok: true, auditNote: '[machine-mutation evidence: commit 3c5ef643]', verified: ['commitSha'],
    });
    const out = await executePlatformTool(ctx, 'update_feedback', {
      id: NIGHTLY_TICKET, status: 'in_progress', adminNote: 'noting the fix', evidence: { commitSha: '3c5ef643' },
    });
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith({
      id: NIGHTLY_TICKET, status: 'in_progress', adminNote: 'noting the fix\n[machine-mutation evidence: commit 3c5ef643]',
    });
    expect(out).toContain('Machine-mutation evidence verified (commitSha)');
  });

  it('NO REGRESSION: a human-anchored run (userTurnAt set) is never gated', async () => {
    const { ctx } = makeCtx({ userTurnAt: new Date() });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: NIGHTLY_TICKET, context: null } });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: NIGHTLY_TICKET, status: 'in_progress', adminNote: 'owner note' });
    expect(out).toContain('Updated feedback ticket');
    expect(fb.updateFeedbackTicket).toHaveBeenCalled();
  });
});
