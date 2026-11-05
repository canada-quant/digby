/**
 * LAPSED DISPATCH — the machine-mutation gate's "binding outlives its lane"
 * lockout (ticket e7e40322, 2026-11-03).
 *
 * THE DEFECT (measured in prod, not hypothesised): ticket 5f69fdc4 carries
 * `context.dispatchedTo = cc65072f` from its 08:41Z dispatch. The dispatcher
 * ARCHIVED that lane at 10:02Z; the work moved to lane ef2975d7, which landed
 * the fix (PR #2406) and then recorded (msg 310b1135): "Ticket 5f69fdc4 could
 * not be closed or annotated — its own mutation was refused (dispatchedTo =
 * another lane), so nothing was closed and no false claim was made."
 *
 * Two things were wrong with that refusal, and this suite pins both:
 *   (1) a stamp naming an ARCHIVED chat is not a claim on the row — that chat
 *       can never write again, and no tool re-points dispatchedTo, so the row
 *       froze while its fix shipped (close-hygiene rot);
 *   (2) the refusal's own advice ("leave it to the dispatched lane") was a
 *       DEAD END for exactly that case.
 *
 * THE FIX pinned here (narrow, fail-closed):
 *   - dispatchedTo names an ARCHIVED chat ⇒ the stamp is LAPSED. The FILER's
 *     binding is restored (dispatch_elsewhere is a LIVE lane's right), and a
 *     non-filer faces the ordinary artifact-evidence bar it would have faced
 *     before the dispatch. Nothing about the CLOSE bar changes: status=done
 *     still demands merged ∧ deployed fix evidence.
 *   - dispatchedTo names a LIVE (unarchived) chat ⇒ BYTE-IDENTICAL pre-fix
 *     lockout. This is the detector's prior true positive and it must still
 *     fire — that is the recall replay below.
 *   - the probe cannot be read (error / no row) ⇒ fail CLOSED, pre-fix.
 *
 * DETECTOR-RECALL REPLAY (ticket e7e40322): the relaxed branch is reached
 * only through the archived probe; the live-lane and unreadable-probe cases
 * below replay the gate's PRIOR convicting behaviour and assert it STILL
 * refuses, so the relaxation cannot silently widen into a free-for-all.
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockConfirmations = createPendingConfirmationTable();
const mockOwnerQuestions = createOwnerQuestionTable();

/**
 * The chat lookup the lapsed-dispatch probe rides (`crossModelChat.findUnique`
 * selecting `archivedAt`). Every OTHER chat read keeps the pre-existing "no
 * row" answer, so nothing but the probe is perturbed.
 */
const chatRow: { row: { archivedAt: Date | null } | null; throws?: boolean } = { row: null };

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
    crossModelChat: {
      update: mockOwnerQuestions.crossModelChat.update,
      findUnique: jest.fn(async (args: any) => {
        if (!args?.select?.archivedAt) return null;
        if (chatRow.throws) throw new Error('connection reset');
        return chatRow.row;
      }),
    },
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

jest.mock('./platform.service', () => ({
  __esModule: true,
  resolveCodingSessionTarget: jest.fn(async () => ({ ok: false })),
  suggestProjectsByIdPrefix: jest.fn(async () => []),
}));

jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  shortenFilingTitle: jest.fn((title: string) => ({ title: title.trim(), shortened: false, originalTitle: title.trim() })),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

jest.mock('../fleet/fleet-telemetry', () => ({ __esModule: true, fleetTelemetry: jest.fn(async () => ({ ok: true })) }));

jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  isSupervisorChat: jest.fn(async () => false),
  applyStateUpdate: jest.fn(),
}));

const closureEvidence = {
  verifyMachineCloseEvidence: jest.fn(async (): Promise<any> => ({ ok: true, auditNote: '[machine-close evidence: test]', verified: ['commitSha'] })),
};
jest.mock('../feedback/closure-evidence', () => ({ __esModule: true, ...closureEvidence }));

jest.mock('../feedback/fix-state', () => ({
  __esModule: true,
  parseClosureEvidenceNote: jest.fn(() => ({ commitSha: 'abc1234' })),
  resolveFixStateFromEvidence: jest.fn(async () => ({ fixLive: true, reason: 'commit abc1234 is an ancestor of origin/main ∧ deploy run 42 concluded success' })),
}));

const loopMetrics = {
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike' },
  recordLoopMetric: jest.fn(),
};
jest.mock('./loop-metrics.service', () => ({ __esModule: true, ...loopMetrics }));

jest.mock('./autonomy.service', () => ({
  __esModule: true,
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async () => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
}));

jest.mock('../upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(async (): Promise<any> => null),
  combineAttachments: jest.fn((atts: any[]) => atts[0]),
}));

import { executePlatformTool, dispatchedLaneRetired } from './platform-tools';
import type { ToolContext } from '../coding/tools';

/** The prod specimen ids (ticket e7e40322): the archived lane the stale stamp
 *  names, and the lane that actually did the work. */
const RETIRED_LANE = 'cc65072f-5589-489f-bb68-0f5dc00808f3';
const WORKING_LANE = 'ef2975d7-d885-448d-aae1-7448e3bbf831';
const FILER_SESSION = 'daee2916-fa75-4159-94a1-3d767abfd192';
const LIVE_LANE = '093b747e-0000-4000-8000-0000000000aa';

function makeCtx(sessionId: string) {
  return {
    worktree: '/wt', sessionId, userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    userTurnAt: undefined, // machine-triggered — the gate binds only there
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
  } as unknown as ToolContext;
}

const strikes = () => loopMetrics.recordLoopMetric.mock.calls.map((c) => c[0]).filter((r: any) => r?.kind === 'guard_strike');
const flush = () => new Promise((r) => setImmediate(r));

/** The specimen row: dispatched to the (now archived) lane, filed by the
 *  supervisor chat that has the measured state. */
const ticketRow = (context: Record<string, unknown>) => ({ ok: true, ticket: { id: '5f69fdc4-f5fc-4ca6-ba4b-6f406f176427', source: 'agent', type: 'bug_report', context } });

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  mockOwnerQuestions.reset();
  chatRow.row = null;
  chatRow.throws = false;
  fb.isAdminUser.mockResolvedValue(true);
  fb.updateFeedbackTicket.mockResolvedValue({ id: '5f69fdc4', status: 'in_progress', priority: 2, adminNote: 'note' });
  closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: true, auditNote: '[machine-close evidence: test]', verified: ['commitSha'] });
});

describe('dispatchedLaneRetired (pure leaf)', () => {
  it('only a positive retired probe reads as lapsed — unknown and false fail CLOSED', () => {
    expect(dispatchedLaneRetired({ retired: true })).toBe(true);
    expect(dispatchedLaneRetired({ retired: false })).toBe(false);
    expect(dispatchedLaneRetired(null)).toBe(false);
    expect(dispatchedLaneRetired(undefined)).toBe(false);
    expect(dispatchedLaneRetired({} as any)).toBe(false);
  });
});

describe('REPLAY (ticket e7e40322): the live worker can annotate a ticket whose dispatchedTo names an ARCHIVED lane', () => {
  it('the WORKING lane (not the filer) annotates with artifact evidence — the exact refusal msg 310b1135 recorded', async () => {
    chatRow.row = { archivedAt: new Date('2026-11-03T10:02:51.585Z') }; // cc65072f, read live this run
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: RETIRED_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    const out = await executePlatformTool(makeCtx(WORKING_LANE), 'update_feedback', {
      id: '5f69fdc4', adminNote: 'criterion (4) blocked: ALB stickiness', evidence: { commitSha: 'a8a41e0f24' },
    });
    // The evidence bar still applied (it is unbound to this session) and the
    // write LANDED — pre-fix this returned an ok:false refusal.
    expect(closureEvidence.verifyMachineCloseEvidence).toHaveBeenCalledWith(expect.objectContaining({ forClose: false }));
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ id: '5f69fdc4', adminNote: expect.stringContaining('criterion (4) blocked') }));
    expect(out).toContain('Updated feedback ticket 5f69fdc4');
    await flush();
    // Observed as a lapsed-dispatch mutation, never as a plain unbound strike.
    expect(strikes().map((r: any) => r.meta.seam)).toContain('update_feedback_lapsed_dispatch');
    expect(strikes().map((r: any) => r.meta.seam)).not.toContain('update_feedback_unbound');
  });

  it('the FILER regains binding (a lapsed stamp is not a live lane\'s claim) and mutates WITHOUT the artifact bar', async () => {
    chatRow.row = { archivedAt: new Date('2026-11-03T10:02:51.585Z') };
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: RETIRED_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    const out = await executePlatformTool(makeCtx(FILER_SESSION), 'update_feedback', { id: '5f69fdc4', status: 'in_progress', adminNote: 'measured state' });
    expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith(expect.objectContaining({ id: '5f69fdc4', status: 'in_progress', adminNote: 'measured state' }));
    expect(out).toContain('filer-bound');
    await flush();
    expect(strikes().map((r: any) => r.meta.seam)).toContain('update_feedback_lapsed_dispatch');
  });

  it('the refusal narrates the LAPSED truth and the one live route — never "leave it to the dispatched lane"', async () => {
    chatRow.row = { archivedAt: new Date('2026-11-03T10:02:51.585Z') };
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: RETIRED_LANE, dispatchMode: 'ticket_lane' }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(WORKING_LANE), 'update_feedback', { id: '5f69fdc4', status: 'in_progress' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(parsed.message).toContain('LAPSED');
    expect(parsed.message).toContain(RETIRED_LANE.slice(0, 8));
    expect(parsed.message).toContain('ARCHIVED');
    // The remedy the dead end omitted: supply artifact evidence.
    expect(parsed.message).toMatch(/re-call with evidence/);
    expect(parsed.message).not.toContain('Leave it to the dispatched lane');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('a NON-FILER\'s refusal names the lapsed stamp and the live route instead of a dead end', async () => {
    chatRow.row = { archivedAt: new Date('2026-11-03T10:02:51.585Z') };
    // No filedBy: this session filed nothing, so filer binding cannot apply and
    // the row falls to the artifact bar — the exact state the live worker hit.
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: RETIRED_LANE, dispatchMode: 'ticket_lane' }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(FILER_SESSION), 'update_feedback', { id: '5f69fdc4', adminNote: 'note' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(parsed.message).toContain('LAPSED');
    expect(parsed.message).toMatch(/re-call with evidence/);
    expect(parsed.message).not.toContain('Leave it to the dispatched lane');
    // Review P1-1/P1-2: the lapsed path strips the stamp before judging, so
    // the `dispatched_elsewhere` reason is unreachable here — assert the real one.
    expect(parsed.message).not.toContain('that lane owns its triage');
  });
});

describe('DETECTOR-RECALL REPLAY — the gate\'s PRIOR true positives must still fire', () => {
  it('dispatchedTo names a LIVE (unarchived) lane: the lockout is byte-identical pre-fix', async () => {
    chatRow.row = { archivedAt: null }; // 093b747e — the sibling ticket's live lane
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: LIVE_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(WORKING_LANE), 'update_feedback', { id: '5f69fdc4', status: 'in_progress', adminNote: 'sneaking in' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    expect(parsed.message).toContain('not dispatched to this session');
    expect(parsed.message).not.toContain('LAPSED');
    await flush();
    const rows = strikes();
    expect(rows.map((r: any) => r.meta.seam)).toContain('update_feedback_unbound');
    expect(rows.map((r: any) => r.meta.seam)).not.toContain('update_feedback_lapsed_dispatch');
    expect(rows[0]).toMatchObject({ kind: 'guard_strike', meta: { dispatchedTo: LIVE_LANE.slice(0, 8) } });
  });

  it('a LIVE lane still beats the filer (filer binding lapses on a live dispatch)', async () => {
    chatRow.row = { archivedAt: null };
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: LIVE_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(FILER_SESSION), 'update_feedback', { id: '5f69fdc4', status: 'in_progress' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('an UNREADABLE probe fails CLOSED — a DB blip never frees another lane\'s ticket', async () => {
    chatRow.throws = true;
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: LIVE_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(FILER_SESSION), 'update_feedback', { id: '5f69fdc4', status: 'in_progress' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    await flush();
    expect(strikes().map((r: any) => r.meta.seam)).toContain('update_feedback_unbound');
    expect(strikes().map((r: any) => r.meta.seam)).not.toContain('update_feedback_lapsed_dispatch');
  });

  it('a MISSING chat row is NOT treated as retired (no proof of death ⇒ pre-fix lockout)', async () => {
    chatRow.row = null;
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: LIVE_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(FILER_SESSION), 'update_feedback', { id: '5f69fdc4', status: 'in_progress' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('a task card / never-dispatched row keeps its own narration (no lapsed wording)', async () => {
    chatRow.row = null;
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: 'abc12345-full', source: 'agent', type: 'bug_report', context: null } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(WORKING_LANE), 'update_feedback', { id: 'abc12345-full', status: 'in_progress' });
    const parsed = JSON.parse(out);
    expect(parsed.message).toContain('never been dispatched to any session');
    expect(parsed.message).not.toContain('LAPSED');
  });
});

describe('DETECTOR-RECALL REPLAY — the relaxed path must NOT widen (peer review CONFIRM A)', () => {
  it('a SUPERVISOR filer is STILL refused on a lapsed stamp — supervisors file and stand down', async () => {
    const { isSupervisorChat } = require('./supervisor-state.service');
    isSupervisorChat.mockResolvedValueOnce(true);
    chatRow.row = { archivedAt: new Date('2026-11-03T10:02:51.585Z') };
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: RETIRED_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    // The supervisor IS the filer: without the rail, stripping the stamp would
    // hand a supervisor binding it must never have.
    const out = await executePlatformTool(makeCtx(FILER_SESSION), 'update_feedback', { id: '5f69fdc4', status: 'in_progress' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    await flush();
    expect(strikes().map((r: any) => r.meta.seam)).toContain('update_feedback_lapsed_dispatch');
  });

  it('a HARNESS-filed row is STILL refused on a lapsed stamp — a convicted session never rewrites its own adjudication', async () => {
    chatRow.row = { archivedAt: new Date('2026-11-03T10:02:51.585Z') };
    // verifier stamp ⇒ harness_filed, which returns BEFORE the dispatchedTo
    // check in the leaf — so the lapsed path can never bind it, even with a
    // matching filedBy.
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({
      dispatchedTo: RETIRED_LANE, dispatchMode: 'ticket_lane',
      filedBy: WORKING_LANE, verifier: 'action-verifier', sessionId: WORKING_LANE,
    }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(WORKING_LANE), 'update_feedback', { id: '5f69fdc4', status: 'in_progress', adminNote: 'not a phantom' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(parsed.message).toContain('filed BY THE HARNESS about this session');
    expect(parsed.message).not.toContain('filer-bound');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('the CLOSE bar is untouched by the lapsed-dispatch relaxation (ticket 6665fff6)', () => {
  it('status=done still runs the closure-evidence gate and still refuses without fix evidence', async () => {
    chatRow.row = { archivedAt: new Date('2026-11-03T10:02:51.585Z') };
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: RETIRED_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(makeCtx(FILER_SESSION), 'update_feedback', { id: '5f69fdc4', status: 'done', adminNote: 'closing' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    // The CLOSE path asks the evidence gate in close mode, whatever the binding.
    expect(closureEvidence.verifyMachineCloseEvidence).toHaveBeenCalledWith({ ticketId: '5f69fdc4', evidence: undefined });
  });

  it('status=done WITH fix evidence closes, exactly as an unbound machine run always could', async () => {
    chatRow.row = { archivedAt: new Date('2026-11-03T10:02:51.585Z') };
    fb.getFeedbackTicketById.mockResolvedValue(ticketRow({ dispatchedTo: RETIRED_LANE, dispatchMode: 'ticket_lane', filedBy: FILER_SESSION }));
    const out = await executePlatformTool(makeCtx(WORKING_LANE), 'update_feedback', {
      id: '5f69fdc4', status: 'done', evidence: { commitSha: 'a8a41e0f24', prUrl: 'https://github.com/example-org/crossmodel/pull/2406' },
    });
    expect(closureEvidence.verifyMachineCloseEvidence).toHaveBeenCalledWith(expect.objectContaining({ evidence: expect.objectContaining({ commitSha: 'a8a41e0f24' }) }));
    expect(fb.updateFeedbackTicket).toHaveBeenCalled();
    expect(out).toContain('Updated feedback ticket');
  });
});