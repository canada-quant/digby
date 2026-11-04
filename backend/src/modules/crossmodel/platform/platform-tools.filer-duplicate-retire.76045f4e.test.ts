/**
 * FILER DUPLICATE-RETIRE RAIL (ticket 76045f4e, 2026-10-16) — the one lawful
 * self-service close for a session that filed a DUPLICATE.
 *
 * THE SPECIMEN (live, receipts c0e22e36 2026-10-16): the Fleet Supervisor
 * filed 93292353 (13:27:34Z, receipt 0bb1f832) and a same-class duplicate
 * 9c307167 (13:33:05Z, receipt 2a6a748f) — the owner-action-card payload
 * directive, two wordings, the title-fuzzy dedupe bar (Jaccard 0.6) not met.
 * Every retire attempt was refused FOUR times (receipts fb1b249c, 47e13553,
 * 306a5014, caf83213 — all update_feedback ok:false, none carrying
 * evidence): supervisor chats are never filer-bound, and status=done demands
 * fix-evidence a duplicate does not have. The owner closed BOTH rows by hand
 * at 13:50:44Z (no agent receipt anywhere) — the framework turned its own
 * bookkeeping into owner work, and the refusal streak itself tripped the
 * mishap breaker that auto-filed THIS ticket.
 *
 * THE FIX pinned here: update_feedback gains a duplicateOf argument — with
 * status=done, the FILING session (context.filedBy === sessionId, supervisor
 * class INCLUDED — file/cite/stand-down keeps its one lawful move) retires
 * its own ≤24h-old, never-dispatched ticket as a linked duplicate of a
 * canonical row it names. The evidence bar for a retire is the POINTER,
 * server-verified (the canonical row exists, is open, is not itself a
 * duplicate, is same-owner, is a different row) — a retire asserts "this row
 * is redundant", never "this work is fixed". The write is the same
 * {status:'done', context.duplicateOf, autoDispatch:false} linked-duplicate
 * shape the filing-dedupe passes write (feedback.service.ts:124), so the
 * dispatcher's autoDispatch:false reader keeps it out of every dispatch scan.
 *
 * Pinned behaviors (each a fail-closed bound):
 *   1. the exact specimen retires: a supervisor filer, duplicate ≤24h old,
 *      canonical open — done + linked, ONE filer_duplicate_retire metric row;
 *   2. the prefix form of duplicateOf resolves through the same id resolution;
 *   3. a non-filer session is refused (not_filer) — never a second machine
 *      writer on someone else's filing;
 *   4. a dispatched ticket is refused (already_dispatched) — the dispatched
 *      lane owns in-flight work;
 *   5. >24h since filing is refused (retire_window_expired);
 *   6. a harness-filed row (verifier stamp) is refused — the convicted
 *      session cannot launder its adjudication ticket into a duplicate;
 *   7. a self-pointer is refused (self_pointer), prefix form included;
 *   8. an unknown canonical prefix is refused (canonical_not_found);
 *   9. a CLOSED canonical is refused (canonical_closed);
 *  10. a canonical that is itself a duplicate is refused (canonical_is_duplicate);
 *  11. a user-sourced row never rides the rail (user_sourced);
 *  12. a close WITHOUT duplicateOf falls through to the normal verified-close
 *      gate unchanged (evidence_required) — the rail widens nothing else;
 *  13. the kill switch FEEDBACK_FILER_DUPLICATE_RETIRE_DISABLED=1 skips the
 *      rail entirely (the normal gates unchanged);
 *  14. the rail executes on a HUMAN-anchored turn? — NO: the rail lives
 *      inside the machine-run gate block (a human close never needed it).
 *
 * Harness: the same mock topology as
 * platform-tools.update-feedback-filer-binding.test.ts (the sibling that
 * pins filer binding itself).
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

/** The loop_metrics seam the rail's telemetry rides (dynamic import). */
const loopMetrics = {
  LOOP_METRIC_KINDS: { GUARD_STRIKE: 'guard_strike', FILER_DUPLICATE_RETIRE: 'filer_duplicate_retire' },
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

import { executePlatformTool } from './platform-tools';
import type { ToolContext } from '../coding/tools';
import type { CodingSessionTarget } from './platform.service';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    userTurnAt: undefined, // machine-triggered by default — the rail lives in the gate block
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return { ctx };
}

const flush = () => new Promise((r) => setImmediate(r));
const retires = () => loopMetrics.recordLoopMetric.mock.calls.map((c) => c[0]).filter((r) => r?.kind === 'filer_duplicate_retire');

const CANON_ID = '93292353-1953-4e2f-b3e1-d5d49bf10074';
const DUP_ID = '9c307167-e7b3-401e-9380-b434fe13b141'; // the exact specimen duplicate

/** A fresh (≤24h), never-dispatched, agent-sourced filing by `filer`. */
function dupRow(filer: string, over: Record<string, unknown> = {}) {
  return {
    id: DUP_ID,
    source: 'agent',
    status: 'open',
    userId: 'u-owner',
    createdAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago — inside the window
    context: { filedBy: filer, filedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), surface: 'chat' },
    ...over,
  };
}

function canonRow(over: Record<string, unknown> = {}) {
  return {
    id: CANON_ID,
    source: 'agent',
    status: 'open',
    userId: 'u-owner',
    createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
    context: { filedBy: 'lane-first', filedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FEEDBACK_FILER_DUPLICATE_RETIRE_DISABLED;
  mockConfirmations.reset();
  mockOwnerQuestions.reset();
  fb.isAdminUser.mockResolvedValue(true);
  fb.updateFeedbackTicket.mockResolvedValue({ id: DUP_ID, status: 'done', priority: 3, adminNote: 'x' });
  supState.isSupervisorChat.mockResolvedValue(false);
});

afterAll(() => { delete process.env.FEEDBACK_FILER_DUPLICATE_RETIRE_DISABLED; });

describe('1. THE 76045f4e SPECIMEN — a supervisor filer retires its own fresh duplicate (the previously-impossible close)', () => {
  it('retires: done + linked (duplicateOf + autoDispatch:false), ONE metric row, no evidence bar, supervisor naming', async () => {
    supState.isSupervisorChat.mockResolvedValue(true);
    const { ctx } = makeCtx({ sessionId: 'fleet-sup' });
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === DUP_ID || id === '9c307167') return { ok: true, ticket: dupRow('fleet-sup') };
      if (id === CANON_ID || id === '93292353') return { ok: true, ticket: canonRow() };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: '9c307167', status: 'done', adminNote: 'DUPLICATE of 93292353 — same owner directive (oq_ea52c6ae), one canonical row.', duplicateOf: '93292353' });
    expect(out).toContain(`Retired feedback ticket ${DUP_ID} as a duplicate of ${CANON_ID}`);
    expect(out).toContain('server-verified');
    expect(out).toContain('File, cite, stand down');
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
    const write = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(write).toMatchObject({ id: DUP_ID, status: 'done' });
    expect(write.context).toMatchObject({ duplicateOf: CANON_ID, duplicateMatch: 'filer-retire', autoDispatch: false, filedBy: 'fleet-sup' });
    expect(write.adminNote).toContain('DUPLICATE of 93292353');
    expect(write.adminNote).toContain('76045f4e');
    // No fix-evidence was demanded — the rail ran BEFORE the verified-close gate.
    expect(closureEvidence.verifyMachineCloseEvidence).not.toHaveBeenCalled();
    await flush();
    expect(retires()).toHaveLength(1);
    expect(retires()[0]).toMatchObject({ meta: { ticketId: '9c307167', duplicateOf: '93292353', filerClass: 'supervisor' } });
  });

  it('a LANE filer retires its own duplicate too (filerClass lane — the rail is not supervisor-only)', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === DUP_ID) return { ok: true, ticket: dupRow('lane-A') };
      if (id === CANON_ID) return { ok: true, ticket: canonRow() };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID });
    expect(out).toContain(`Retired feedback ticket ${DUP_ID} as a duplicate of ${CANON_ID}`);
    expect(out).not.toContain('File, cite, stand down');
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
    await flush();
    expect(retires()[0]).toMatchObject({ meta: { filerClass: 'lane' } });
  });
});

describe('2. prefix duplicateOf resolves through the same id resolution', () => {
  it('an 8-char prefix retires against the full canonical id', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === DUP_ID) return { ok: true, ticket: dupRow('lane-A') };
      if (id === '93292353') return { ok: true, ticket: canonRow() };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: '93292353' });
    expect(out).toContain(`as a duplicate of ${CANON_ID}`);
    expect(fb.updateFeedbackTicket.mock.calls[0][0].context).toMatchObject({ duplicateOf: CANON_ID });
  });
});

describe('3. a NON-filer is refused — never a second machine writer on someone else\'s filing', () => {
  it('another session is refused with not_filer and nothing is written', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-other' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: dupRow('lane-A') });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'not_filer' });
    expect(parsed.message).toContain('Only the session that FILED');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('4. a DISPATCHED ticket is refused — the dispatched lane owns in-flight work', () => {
  it('context.dispatchedTo present → already_dispatched, nothing written', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === DUP_ID) return { ok: true, ticket: dupRow('lane-A', { context: { filedBy: 'lane-A', dispatchedTo: 'lane-batch-7' } }) };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'already_dispatched' });
    expect(parsed.message).toContain('dispatched to another session');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('5. the file-then-retire window is 24h', () => {
  it('an old filing is refused with retire_window_expired', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: dupRow('lane-A', { createdAt: new Date(old), context: { filedBy: 'lane-A', filedAt: old } }) });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'retire_window_expired' });
    expect(parsed.message).toContain('24h');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('6. a HARNESS-filed row never rides the rail — the convicted session cannot launder its adjudication', () => {
  it('a verifier-stamped context is refused with harness_filed', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: dupRow('lane-A', { context: { filedBy: 'lane-A', verifier: 'action-verifier', sessionId: 'lane-A' } }) });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'harness_filed' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('7. a self-pointer is refused (prefix form included)', () => {
  it('duplicateOf === the ticket\'s own id (or 8-char prefix) → self_pointer', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: dupRow('lane-A') });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: '9c307167' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'self_pointer' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('8. an unresolvable canonical is refused (the pointer is the evidence — it must resolve)', () => {
  it('unknown canonical prefix → canonical_not_found, nothing written', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === DUP_ID) return { ok: true, ticket: dupRow('lane-A') };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: 'deadbeef' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'canonical_not_found' });
    expect(parsed.message).toContain('does not resolve');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('9. a CLOSED canonical is refused — a duplicate of closed work is not this rail\'s call', () => {
  it('canonical status done → canonical_closed', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === DUP_ID) return { ok: true, ticket: dupRow('lane-A') };
      if (id === CANON_ID) return { ok: true, ticket: canonRow({ status: 'done' }) };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'canonical_closed' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('10. a canonical that is ITSELF a duplicate is refused — point at the root', () => {
  it('canonical context.duplicateOf set → canonical_is_duplicate', async () => {
    const { ctx } = makeCtx({ sessionId: 'lane-A' });
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === DUP_ID) return { ok: true, ticket: dupRow('lane-A') };
      if (id === CANON_ID) return { ok: true, ticket: canonRow({ context: { duplicateOf: 'aaaaaaaa-0000-0000-0000-000000000000' } }) };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'canonical_is_duplicate' });
    expect(parsed.message).toContain('root canonical');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('11. a USER-sourced row never rides the rail (the owner\'s row is the owner\'s)', () => {
  it('source user → user_sourced', async () => {
    const { ctx } = makeCtx({ sessionId: 'sess-1' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: dupRow('sess-1', { source: 'user' }) });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'user_sourced' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('12. a close WITHOUT duplicateOf falls through to the normal verified-close gate — the rail widens nothing else', () => {
  it('no duplicateOf → evidence_required from the unchanged close gate', async () => {
    const { ctx } = makeCtx({ sessionId: 'fleet-sup' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: dupRow('fleet-sup') });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied. Re-call with evidence: {…}.' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', adminNote: 'fixed' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(closureEvidence.verifyMachineCloseEvidence).toHaveBeenCalled();
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('13. the kill switch skips the rail entirely (normal gates unchanged)', () => {
  it('FEEDBACK_FILER_DUPLICATE_RETIRE_DISABLED=1 → the retire shape hits the normal close gate instead', async () => {
    process.env.FEEDBACK_FILER_DUPLICATE_RETIRE_DISABLED = '1';
    supState.isSupervisorChat.mockResolvedValue(true);
    const { ctx } = makeCtx({ sessionId: 'fleet-sup' });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: dupRow('fleet-sup') });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'evidence_required', message: 'No evidence supplied.' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID, adminNote: 'dup' });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, reason: 'evidence_required' });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
    await flush();
    expect(retires()).toHaveLength(0);
  });
});

describe('14. the rail is machine-run only — a human turn never reaches it (a human close never needed it)', () => {
  it('userTurnAt set → the gate block (rail included) is skipped entirely', async () => {
    const { ctx } = makeCtx({ sessionId: 'sess-1', userTurnAt: new Date() });
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: dupRow('sess-1') });
    fb.updateFeedbackTicket.mockResolvedValue({ id: DUP_ID, status: 'done', priority: 3, adminNote: 'human note' });
    const out = await executePlatformTool(ctx, 'update_feedback', { id: DUP_ID, status: 'done', duplicateOf: CANON_ID, adminNote: 'human note' });
    expect(out).toContain('Updated feedback ticket');
    // The human write carried the plain adminNote — no rail suffix, no context write, no metric.
    expect(fb.updateFeedbackTicket).toHaveBeenCalledWith({ id: DUP_ID, status: 'done', adminNote: 'human note' });
    await flush();
    expect(retires()).toHaveLength(0);
  });
});
