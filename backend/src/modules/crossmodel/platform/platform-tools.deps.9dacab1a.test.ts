/**
 * update_feedback dependsOnTicketIds — the TOOL writer (9dacab1a round-1
 * review F4/F7/F8), pinned directly on executePlatformTool.
 *
 * Zero tests existed for this branch before (the dispatch suite covers the
 * READ side — the drain's blocker index; ticket-priority.test.ts covers the
 * pure leaf). These pin the WRITE side's own gates:
 *
 *  - SUPERVISOR-FILER refusal (F4): a machine run on a ticket this session
 *    filed is filer-bound — EXCEPT when the chat is supervisor-class. The
 *    rail is an isSupervisorChat probe fired exactly when the leaf binds,
 *    mirroring the mutation path's rail at ~:5999.
 *  - DISPATCHED-ELSEWHERE refusal (F9): deps gate UNdispatched rows only —
 *    a row already on a lane is its lane's.
 *  - COMBINED PAYLOAD (F7): deps + status/adminNote/priority apply BOTH in
 *    ONE updateFeedbackTicket call (the old code early-returned on the dep
 *    write and silently dropped the sibling fields).
 *  - PREFIX CANONICALIZATION end-to-end: a prefix dep id in the tool input
 *    resolves through getFeedbackTicketById and lands in the stored context
 *    as the CANONICAL full id (the drain's blocker index keys on full ids).
 *  - UNBOUND machine run without evidence refused (the artifact bar).
 *  - CONTEXT-CONFLICT (F8): expectContext-guarded write; ONE fresh-read
 *    retry, then a clean context_conflict refusal.
 *
 * Mock discipline mirrors platform-tools.done-bar.6665fff6.test.ts (the same
 * seams: feedback service boundary, closure-evidence boundary, fix-state,
 * supervisor-state, machine-triggered ToolContext).
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

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    ownerQuestion: mockOwnerQuestions.api,
    crossModelMessage: mockOwnerQuestions.crossModelMessage,
    crossModelChat: mockOwnerQuestions.crossModelMessage ? mockOwnerQuestions.crossModelChat : { findMany: async () => [] },
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

const LANE = 'lane-9dacab1a-0000-0000-000000000001';
const SELF = '9dacab1a-0000-4000-8000-000000000001'; // the ticket being gated
const DEP = 'bbbbbbbb-0000-4000-8000-000000000002'; // the blocker

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: LANE, userId: 'u1', permissionMode: 'auto',
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
  fb.updateFeedbackTicket.mockResolvedValue({ id: SELF, status: 'open', priority: 0, adminNote: null });
  closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({
    ok: true, auditNote: '[machine-close evidence: commit abc123def4567890abc123def4567890abcd1234]', verified: ['commitSha'],
  });
  fixState.parseClosureEvidenceNote.mockReturnValue({ commitSha: 'abc123def4567890abc123def4567890abcd1234' });
  supState.isSupervisorChat.mockResolvedValue(false);
});

describe('update_feedback dependsOnTicketIds — binding gates (machine runs)', () => {
  it('a row dispatched to THIS session is also refused — deps gate UNdispatched rows only (the lane holds by not closing)', async () => {
    // The dispatch-binding branch binds (dispatchedTo === sessionId), but the
    // dep gate still refuses: a dispatched row is being worked, and the gate
    // runs BEFORE the in_progress reclaim in the drain — gating a live row
    // would strand it behind its own blockers forever. The lane that wants
    // its ticket held simply does not close it.
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: SELF, context: { dispatchedTo: LANE, dispatchMode: 'ticket_lane' }, source: 'agent', userId: 'u1' } });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] }));
    expect(parsed).toMatchObject({ ok: false, reason: 'dispatched_elsewhere', ticketId: SELF });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('the FILER-bound path sets deps on its own UNdispatched ticket: guarded write lands, canonical ids stored', async () => {
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] });
    expect(out).toContain(`Set feedback ticket ${SELF} dependencies`);
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    // F8: the context write is compare-and-swap guarded on the base context.
    expect(call.expectContext).toEqual({ filedBy: LANE });
    // Canonical full id stored (never the raw input).
    expect(call.context.dependsOnTicketIds).toEqual([DEP]);
  });

  it('SUPERVISOR-FILER refusal (F4): the filer session binds, a supervisor chat that filed it never does', async () => {
    // This session FILED the ticket (context.filedBy === LANE) and no lane is
    // dispatched — filerBindingVerdict binds — but the chat is supervisor
    // class: the F4 probe fires and refuses with reason supervisor_filer.
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } });
    supState.isSupervisorChat.mockResolvedValue(true);
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] }));
    expect(parsed).toMatchObject({ ok: false, reason: 'supervisor_filer', ticketId: SELF });
    expect(supState.isSupervisorChat).toHaveBeenCalledWith(LANE);
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('the same filer shape on a NON-supervisor chat binds (the contrast pin: the probe is the only difference)', async () => {
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    supState.isSupervisorChat.mockResolvedValue(false);
    const out = await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] });
    expect(out).toContain(`Set feedback ticket ${SELF} dependencies`);
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
    expect(fb.updateFeedbackTicket.mock.calls[0][0].context.dependsOnTicketIds).toEqual([DEP]);
  });

  it('DISPATCHED-ELSEWHERE refusal (F9): deps gate tickets that are NOT on a lane', async () => {
    const otherLane = 'lane-ffffffff-0000-0000-0000000000ff';
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: SELF, context: { dispatchedTo: otherLane, dispatchMode: 'ticket_lane' }, source: 'agent', userId: 'u1' } });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] }));
    expect(parsed).toMatchObject({ ok: false, reason: 'dispatched_elsewhere', ticketId: SELF });
    expect(parsed.message).toContain('dependencies gate tickets that are NOT on a lane');
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('an UNBOUND machine run without evidence is refused (the artifact bar)', async () => {
    // Not dispatched to this session, not filed by it, no evidence supplied.
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: SELF, context: {}, source: 'user', userId: 'u1' } });
    closureEvidence.verifyMachineCloseEvidence.mockResolvedValue({ ok: false, reason: 'no_evidence', message: 'A verifiable artifact is required.' });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] }));
    expect(parsed).toMatchObject({ ok: false, reason: 'no_evidence', ticketId: SELF });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });
});

describe('update_feedback dependsOnTicketIds — combined payload + canonicalization (F7/F2)', () => {
  it('deps + status + adminNote + priority apply BOTH in ONE updateFeedbackTicket call', async () => {
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    fb.updateFeedbackTicket.mockResolvedValue({ id: SELF, status: 'in_progress', priority: 2, adminNote: 'noted' });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', {
      id: SELF, dependsOnTicketIds: [DEP], status: 'in_progress', adminNote: 'noted', priority: 2,
    });
    // ONE write, both parts: the dep line AND the status line in the reply.
    expect(out).toContain(`Set feedback ticket ${SELF} dependencies`);
    expect(out).toContain('status=in_progress');
    expect(out).toContain('priority=2');
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.dependsOnTicketIds).toEqual([DEP]);
    expect(call.status).toBe('in_progress');
    expect(call.adminNote).toBe('noted');
    expect(call.priority).toBe(2);
  });

  it('PREFIX canonicalization end-to-end: an 8-char prefix input lands as the canonical FULL id in context', async () => {
    // The tool advertises "full or ≥8-char prefix": getFeedbackTicketById
    // resolves the prefix tier, and setTicketDependencies stores the
    // CANONICAL id the tier resolved to (F2 — the drain's blocker index keys
    // on full ids; a stored prefix would never gate).
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      // The prefix tier: a unique ≥8-char prefix resolves to the row.
      if (id === DEP.slice(0, 8)) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP.slice(0, 8)] });
    expect(out).toContain(`Set feedback ticket ${SELF} dependencies`);
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    // CANONICAL, not the raw prefix.
    expect(call.context.dependsOnTicketIds).toEqual([DEP]);
    expect(call.context.dependsOnTicketIds).not.toContain(DEP.slice(0, 8));
  });

  it('a cycle through the deps is refused with reason dependency_cycle (409 from the leaf)', async () => {
    // DEP already waits on SELF (stored canonical); setting SELF → DEP closes a loop.
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: { dependsOnTicketIds: [SELF] }, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] }));
    expect(parsed).toMatchObject({ ok: false, reason: 'dependency_cycle', ticketId: SELF });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('an unknown dep id is refused with reason dependency_not_found (404 from the leaf)', async () => {
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: ['ghost-0000-0000-00000000dead'] }));
    expect(parsed).toMatchObject({ ok: false, reason: 'dependency_not_found', ticketId: SELF });
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('clearing deps (null) writes a context WITHOUT the key, in the same guarded one-write shape', async () => {
    fb.getFeedbackTicketById.mockResolvedValue({ ok: true, ticket: { id: SELF, context: { filedBy: LANE, dependsOnTicketIds: [DEP] }, source: 'agent', userId: 'u1' } });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: null });
    expect(out).toContain('(cleared)');
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.dependsOnTicketIds).toBeUndefined();
    expect(call.context.filedBy).toBe(LANE); // the sibling context keys survive
  });
});

describe('update_feedback dependsOnTicketIds — context conflict (F8 optimistic concurrency)', () => {
  it('ONE fresh-read retry on a guard miss, then a clean context_conflict refusal on the second miss', async () => {
    // Drain 1: the row's context is {filedBy}. The dep branch reads it and
    // guards the write on exactly that. The FIRST updateFeedbackTicket
    // answers context_conflict (another writer moved the row), the fresh
    // re-read sees the NEW context, and the RETRY write guards on that.
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    let updateCalls = 0;
    fb.updateFeedbackTicket.mockImplementation(async (_opts: any) => {
      updateCalls++;
      if (updateCalls === 1) {
        // The race: another writer lands between the read and the write —
        // the fresh read below must see THEIR context.
        fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
          if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE, lastTouch: 'winner' }, source: 'agent', userId: 'u1' } };
          if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
          return { ok: false, reason: 'not_found' };
        });
        return { ok: false, reason: 'context_conflict' };
      }
      if (updateCalls === 2) return { ok: false, reason: 'context_conflict' }; // second miss = real race
      return { id: SELF };
    });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] }));
    expect(parsed).toMatchObject({ ok: false, reason: 'context_conflict', ticketId: SELF });
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(2); // one retry, no more
    // The retry guarded on the FRESH context (the winner's), not the stale one.
    expect(fb.updateFeedbackTicket.mock.calls[1][0].expectContext).toEqual({ filedBy: LANE, lastTouch: 'winner' });
    expect(fb.updateFeedbackTicket.mock.calls[1][0].context).toMatchObject({ filedBy: LANE, lastTouch: 'winner', dependsOnTicketIds: [DEP] });
  });

  it('the retry path SUCCEEDS when the fresh read and the guarded retry agree (the race resolves)', async () => {
    let updateCalls = 0;
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    fb.updateFeedbackTicket.mockImplementation(async () => {
      updateCalls++;
      if (updateCalls === 1) {
        fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
          if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE, lastTouch: 'winner' }, source: 'agent', userId: 'u1' } };
          if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
          return { ok: false, reason: 'not_found' };
        });
        return { ok: false, reason: 'context_conflict' };
      }
      return { id: SELF, status: 'open', priority: 0, adminNote: null };
    });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] });
    expect(out).toContain(`Set feedback ticket ${SELF} dependencies`);
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(2);
    expect(fb.updateFeedbackTicket.mock.calls[1][0].context).toMatchObject({ filedBy: LANE, lastTouch: 'winner', dependsOnTicketIds: [DEP] });
  });
});

describe('update_feedback dependsOnTicketIds — round-2 blockers (ticket 19e0c050)', () => {
  const METRIC = {
    probe: 'app_error_log_count',
    params: { level: 'error', messagePattern: 'P2025' },
    operator: '<=',
    target: 0,
    windowHours: 24,
  };

  it('B1: deps + status=done on a metric-carrying UNdispatched row is REFUSED (dep_status_conflict) — the verifier handoff is never clobbered', async () => {
    // The exact pre-fix defect: an UNdispatched, metric-carrying row passed
    // the dep branch (undispatched → deps validated), the done-bar gate set
    // redirectContext (status=done + a readable metric — NO dispatched
    // requirement), and the one-write fold spread the dep context LAST,
    // silently dropping context.verification {queuedAt, queuedBy, commitSha}
    // from the written context. Now the combo is refused whole.
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE, acceptanceMetric: METRIC }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', {
      id: SELF, dependsOnTicketIds: [DEP], status: 'done', adminNote: 'close',
      evidence: { commitSha: 'abc123def4567890abc123def4567890abcd1234' },
    }));
    expect(parsed).toMatchObject({ ok: false, reason: 'dep_status_conflict', ticketId: SELF });
    expect(parsed.message).toContain('Nothing was mutated');
    // NOTHING was written — the dep validation was read-only and the fold
    // never ran, so no context (with or without `verification`) landed.
    expect(fb.updateFeedbackTicket).not.toHaveBeenCalled();
  });

  it('B1 contrast: deps + a NON-done status still apply BOTH in ONE write (F7 preserved — the refusal is scoped to the done-bar redirect)', async () => {
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE, acceptanceMetric: METRIC }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    fb.updateFeedbackTicket.mockResolvedValue({ id: SELF, status: 'in_progress', priority: 0, adminNote: 'noted' });
    const out = await executePlatformTool(makeCtx(), 'update_feedback', {
      id: SELF, dependsOnTicketIds: [DEP], status: 'in_progress', adminNote: 'noted',
    });
    expect(out).toContain(`Set feedback ticket ${SELF} dependencies`);
    expect(out).toContain('status=in_progress');
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
    const call = fb.updateFeedbackTicket.mock.calls[0][0];
    expect(call.context.dependsOnTicketIds).toEqual([DEP]);
    expect(call.context.acceptanceMetric).toEqual(METRIC); // the rest of the context survives the merge
    expect(call.status).toBe('in_progress');
  });

  it('B2: the conflict retry REFUSES when the fresh read shows the row was dispatched mid-race (dispatched_elsewhere, no second write)', async () => {
    // The pre-fix retry re-applied the FULL original payload against the
    // fresh row unconditionally: between the first read and the fresh read
    // the dispatcher stamps dispatchedTo, and the retry would write deps
    // onto a row a lane now owns (and re-write status onto it). The re-check
    // refuses instead — nothing mutated by the retry.
    const otherLane = 'lane-eeeeeeee-0000-0000-0000000000ee';
    let updateCalls = 0;
    fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
      if (id === SELF) return { ok: true, ticket: { id: SELF, context: { filedBy: LANE }, source: 'agent', userId: 'u1' } };
      if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
      return { ok: false, reason: 'not_found' };
    });
    fb.updateFeedbackTicket.mockImplementation(async () => {
      updateCalls++;
      if (updateCalls === 1) {
        // The guard misses AND the dispatcher stamps the row in the same
        // window — the fresh read below must see dispatchedTo.
        fb.getFeedbackTicketById.mockImplementation(async (id: string) => {
          if (id === SELF) return { ok: true, ticket: { id: SELF, context: { dispatchedTo: otherLane, dispatchMode: 'ticket_lane' }, source: 'agent', userId: 'u1' } };
          if (id === DEP) return { ok: true, ticket: { id: DEP, context: {}, source: 'agent', userId: 'u1' } };
          return { ok: false, reason: 'not_found' };
        });
        return { ok: false, reason: 'context_conflict' };
      }
      return { id: SELF };
    });
    const parsed = JSON.parse(await executePlatformTool(makeCtx(), 'update_feedback', { id: SELF, dependsOnTicketIds: [DEP] }));
    expect(parsed).toMatchObject({ ok: false, reason: 'dispatched_elsewhere', ticketId: SELF });
    expect(parsed.message).toContain('dispatched to a lane');
    // The retry write NEVER ran.
    expect(fb.updateFeedbackTicket).toHaveBeenCalledTimes(1);
  });
});
