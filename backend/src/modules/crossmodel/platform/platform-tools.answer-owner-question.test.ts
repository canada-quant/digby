/**
 * Review 2026-09-13 issue 11: supervisor-first triage — the platform-tool
 * half (platform-tools.ts): the new answer_owner_question tool and the
 * triage-aware list_owner_questions / flag_owner_question envelopes.
 *
 * Pins:
 *   - name-set membership: answer_owner_question is a MUTATING platform tool
 *     (in coding MUTATING_TOOLS, in CHAT_PROFILE_PLATFORM_TOOLS), NOT read,
 *     NOT ask-only, NOT consequential (no confirmation staged, autonomy never
 *     consulted) — the supervisor's unattended wakes must run it;
 *   - scope: a SUPERVISOR chat (isSupervisorChat) answers as 'supervisor' and
 *     records owner_question_supervisor_answered; a machine lane (not
 *     supervisor, no user turn) gets a plain refusal and the service is never
 *     called; a user-present turn on any chat answers as 'owner';
 *   - result envelopes: ok / not_found / not_open / invalid;
 *   - list_owner_questions passes includeTriaged:true and renders the
 *     triaged marker + triageNote; flag_owner_question echoes triage.
 *
 * Scaffolding mirrors platform-tools.fleet.test.ts (do not modify that file).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tools.ts transitively imports plan.service → context-store → DB/env (process.exit).
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

const svc = {
  listChats: jest.fn(), createChat: jest.fn(), getChatStatus: jest.fn(), getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(), renameChat: jest.fn(), archiveChat: jest.fn(), moveChat: jest.fn(),
  deleteChat: jest.fn(), createProject: jest.fn(), getProject: jest.fn(), updateProject: jest.fn(),
  deleteProject: jest.fn(), moveFolder: jest.fn(), startCodingSession: jest.fn(), scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(), cancelSchedule: jest.fn(),
};
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { pendingConfirmation: mockConfirmations.api } }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(), listFeedbackTickets: jest.fn(), updateFeedbackTicket: jest.fn(), isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async (): Promise<any> => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// The supervisor-scope probe (dynamic import, like update_supervisor_state).
const supStateSvc = {
  isSupervisorChat: jest.fn(async () => false),
  applyStateUpdate: jest.fn(async () => ({ applied: [] as string[], errors: [] as string[] })),
};
jest.mock('./supervisor-state.service', () => ({ __esModule: true, ...supStateSvc }));

// The owner-questions store under the tools — mocked at the boundary (dispatch
// reaches it via DYNAMIC import); the arg passthrough is what we pin. The
// PURE helpers are the real module's (f3a69ed3: list_owner_questions renders
// the recorded reply / fold through them — the real parser, not a stub).
const oq = {
  ...jest.requireActual('./owner-questions'),
  answerOwnerQuestion: jest.fn(async (): Promise<'ok' | 'not_found' | 'not_open' | 'owner_engaged'> => 'ok'),
  listOwnerQuestionsForUser: jest.fn(async (): Promise<{ rows: any[]; unmatchedIds: string[] }> => ({ rows: [], unmatchedIds: [] })),
  flagOwnerQuestion: jest.fn(async (): Promise<any> => ({ kind: 'created', question: { id: 'oq_plain' } })),
};
jest.mock('./owner-questions', () => ({ __esModule: true, ...oq }));

// Loop metrics — the supervisor-answered receipt (dynamic import).
const metrics = {
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    MACHINE_SCHEDULE_MUTATION: 'machine_schedule_mutation',
    CONFIRMATION_STAGED: 'confirmation_staged',
    OWNER_QUESTION_SUPERVISOR_ANSWERED: 'owner_question_supervisor_answered',
  },
};
jest.mock('./loop-metrics.service', () => ({ __esModule: true, ...metrics }));

import {
  PLATFORM_TOOL_SCHEMA, PLATFORM_READ_TOOLS, PLATFORM_MUTATING_TOOLS, PLATFORM_ASK_ONLY_TOOLS, executePlatformTool,
} from './platform-tools';
import { MUTATING_TOOLS, ToolContext } from '../coding/tools';
import { CHAT_PROFILE_PLATFORM_TOOLS } from '../coding/agent-profiles';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  supStateSvc.isSupervisorChat.mockResolvedValue(false);
  oq.answerOwnerQuestion.mockResolvedValue('ok');
  oq.listOwnerQuestionsForUser.mockResolvedValue({ rows: [], unmatchedIds: [] });
  oq.flagOwnerQuestion.mockResolvedValue({ kind: 'created', question: { id: 'oq_plain' } });
});

describe('answer_owner_question — registration', () => {
  it('is a MUTATING platform tool: in PLATFORM_MUTATING_TOOLS + coding MUTATING_TOOLS + CHAT_PROFILE_PLATFORM_TOOLS; not read, not ask-only', () => {
    expect(PLATFORM_MUTATING_TOOLS).toContain('answer_owner_question');
    expect(MUTATING_TOOLS.has('answer_owner_question')).toBe(true);
    expect(CHAT_PROFILE_PLATFORM_TOOLS).toContain('answer_owner_question');
    expect(PLATFORM_READ_TOOLS as readonly string[]).not.toContain('answer_owner_question');
    expect(PLATFORM_ASK_ONLY_TOOLS as readonly string[]).not.toContain('answer_owner_question');
  });

  it('has a schema requiring questionId + answer, scoped to the supervisor, naming the standing directives', () => {
    const entry = PLATFORM_TOOL_SCHEMA.find((t: any) => t.function.name === 'answer_owner_question') as any;
    expect(entry).toBeDefined();
    expect(entry.function.parameters.required).toEqual(['questionId', 'answer']);
    expect(entry.function.description).toContain('FLEET SUPERVISOR ONLY');
    expect(entry.function.description).toContain('STANDING DIRECTIVES');
    expect(entry.function.description).toContain('[OWNER-QUESTION TRIAGE');
    expect(entry.function.description).toContain('list_owner_questions');
  });
});

describe('answer_owner_question — scope + dispatch', () => {
  it('SUPERVISOR chat, machine wake: answers as supervisor, records the metric, stages no confirmation, never consults autonomy', async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    const ctx = makeCtx({ sessionId: 'sup-1' }); // no userTurnAt = machine-triggered
    const out = JSON.parse(await executePlatformTool(ctx, 'answer_owner_question', {
      questionId: 'oq_abcdef12-0000-0000-0000-000000000000',
      answer: 'Approved under the CanLaw budget grant — proceed.',
    }));
    expect(supStateSvc.isSupervisorChat).toHaveBeenCalledWith('sup-1');
    expect(oq.answerOwnerQuestion).toHaveBeenCalledWith(
      'oq_abcdef12-0000-0000-0000-000000000000', 'u1', 'Approved under the CanLaw budget grant — proceed.', { answeredBy: 'supervisor', acknowledgeNewerOwnerPosts: false, userDirected: false, actorChatId: 'sup-1' },
    );
    expect(out.ok).toBe(true);
    expect(out.tool).toBe('answer_owner_question');
    expect(out.ids).toEqual({ questionId: 'oq_abcdef12-0000-0000-0000-000000000000', answeredBy: 'supervisor' });
    expect(out.message).toContain('as supervisor');
    expect(out.message).toContain('state ledger');
    expect(metrics.recordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'owner_question_supervisor_answered', sessionId: 'sup-1',
      meta: { questionId: 'oq_abcdef12-0000-0000-0000-000000000000', chatId: 'sup-1' },
    }));
    expect(mockConfirmations.rows).toHaveLength(0); // NOT consequential
    expect(autonomySvc.getChatAutonomy).not.toHaveBeenCalled();
  });

  it('a MACHINE LANE (not supervisor, no user turn) gets a plain refusal — the service is never called (scope, not a gate on its work)', async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(false);
    const out = await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'answer_owner_question', { questionId: 'oq_x', answer: 'yes' });
    expect(out).toMatch(/scoped to the Fleet Supervisor chat/);
    expect(out).toMatch(/not a gate on your work/);
    expect(oq.answerOwnerQuestion).not.toHaveBeenCalled();
    expect(metrics.recordLoopMetric).not.toHaveBeenCalled();
  });

  it("a USER-PRESENT turn on a non-supervisor chat may answer — stamped 'owner', no supervisor metric", async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(false);
    const out = JSON.parse(await executePlatformTool(makeCtx({ sessionId: 'chat-9', userTurnAt: new Date() }), 'answer_owner_question', { questionId: 'oq_y', answer: '2' }));
    expect(oq.answerOwnerQuestion).toHaveBeenCalledWith('oq_y', 'u1', '2', { answeredBy: 'owner', acknowledgeNewerOwnerPosts: false, userDirected: true, actorChatId: 'chat-9' });
    expect(out.ok).toBe(true);
    expect(out.ids.answeredBy).toBe('owner');
    expect(metrics.recordLoopMetric).not.toHaveBeenCalled();
  });

  it('passes acknowledgeNewerOwnerPosts through to the service (ticket 91ec252a race-guard override)', async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    const out = JSON.parse(await executePlatformTool(makeCtx({ sessionId: 'sup-1' }), 'answer_owner_question', {
      questionId: 'oq_ack', answer: 'go', acknowledgeNewerOwnerPosts: true,
    }));
    expect(oq.answerOwnerQuestion).toHaveBeenCalledWith('oq_ack', 'u1', 'go', { answeredBy: 'supervisor', acknowledgeNewerOwnerPosts: true, userDirected: false, actorChatId: 'sup-1' });
    expect(out.ok).toBe(true);
    expect(out.message).toContain('visibly stamped');
  });

  it("maps the ticket-91ec252a owner_engaged refusal: ok:false, the race-guard message, no metric", async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    oq.answerOwnerQuestion.mockResolvedValue('owner_engaged');
    const engaged = JSON.parse(await executePlatformTool(makeCtx({ sessionId: 'sup-1' }), 'answer_owner_question', { questionId: 'oq_race', answer: 'go' }));
    expect(engaged).toMatchObject({ ok: false, reason: 'owner_engaged', questionId: 'oq_race' });
    expect(engaged.message).toContain('triage race guard');
    expect(engaged.message).toContain('get_chat_messages');
    expect(engaged.message).toContain('acknowledgeNewerOwnerPosts:true');
    expect(metrics.recordLoopMetric).not.toHaveBeenCalled();
  });

  it('maps service outcomes: not_found / not_open → ok:false with the reason; missing args → invalid', async () => {
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    const ctx = makeCtx({ sessionId: 'sup-1' });
    oq.answerOwnerQuestion.mockResolvedValue('not_found');
    expect(JSON.parse(await executePlatformTool(ctx, 'answer_owner_question', { questionId: 'oq_nope', answer: 'go' })))
      .toMatchObject({ ok: false, reason: 'not_found', questionId: 'oq_nope' });
    oq.answerOwnerQuestion.mockResolvedValue('not_open');
    const notOpen = JSON.parse(await executePlatformTool(ctx, 'answer_owner_question', { questionId: 'oq_done', answer: 'go' }));
    expect(notOpen).toMatchObject({ ok: false, reason: 'not_open' });
    expect(notOpen.message).toContain('list_owner_questions');
    expect(metrics.recordLoopMetric).not.toHaveBeenCalled(); // only a real flip records
    expect(JSON.parse(await executePlatformTool(ctx, 'answer_owner_question', { questionId: '', answer: 'go' }))).toMatchObject({ ok: false, reason: 'invalid' });
    expect(JSON.parse(await executePlatformTool(ctx, 'answer_owner_question', { questionId: 'oq_z' }))).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('maps the credential_pending refusal (ticket 238c9e2a): ALL three lift channels named, never store_secret-only', async () => {
    // The pre-fix refusal said the gate opens "ONLY when the credential is
    // stored via store_secret" while credentialLifted() also lifts on the
    // CodingCredential row (the Account UI / a pre-channel stored key) and
    // the card key-field paste vaults under the declared key — the same
    // accuracy class ccc2e7ad (PR #1851) fixed on the owner-question
    // surfaces. A lane reading it could tell the owner their already-stored
    // key "won't work".
    supStateSvc.isSupervisorChat.mockResolvedValue(true);
    oq.answerOwnerQuestion.mockResolvedValue('credential_pending' as any);
    const out = JSON.parse(await executePlatformTool(makeCtx({ sessionId: 'sup-1' }), 'answer_owner_question', { questionId: 'oq_cred', answer: 'yes public' }));
    expect(out).toMatchObject({ ok: false, reason: 'credential_pending', questionId: 'oq_cred' });
    expect(out.message).toContain('credential gate still shut');
    // The accurate channel list — all three, mirroring ccc2e7ad's wording.
    expect(out.message).toContain("the key is stored for the declared envKey — store_secret, the card's key field or the Account UI");
    // The store_secret-only inaccuracy is gone.
    expect(out.message).not.toContain('stored via store_secret');
    expect(metrics.recordLoopMetric).not.toHaveBeenCalled();
  });
});

describe('list_owner_questions — the supervisor must SEE triaged rows', () => {
  it('passes includeTriaged:true to the service and renders triaged:true + triageUntil + a triageNote', async () => {
    const until = new Date(Date.now() + 3_600_000);
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      { id: 'oq_t1', status: 'open', question: 'Approve the staging window?', chatId: 'lane-1', createdAt: new Date(), triage: 'supervisor', triageUntil: until, triaged: true },
      { id: 'oq_s1', status: 'open', question: 'Third replica?', chatId: 'lane-2', createdAt: new Date(), triage: 'surfaced', triageUntil: new Date(0), triaged: false },
      { id: 'oq_a1', status: 'answered', answer: 'go', answeredBy: 'supervisor', question: 'Gold policy?', chatId: 'lane-3', createdAt: new Date(), triaged: false },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', { chatId: 'lane-1' }));
    expect(oq.listOwnerQuestionsForUser).toHaveBeenCalledWith('u1', expect.objectContaining({ chatId: 'lane-1', includeTriaged: true }));
    expect(out.count).toBe(3);
    const t1 = out.questions.find((q: any) => q.id === 'oq_t1');
    expect(t1.triaged).toBe(true);
    expect(t1.triageUntil).toBe(until.toISOString());
    const s1 = out.questions.find((q: any) => q.id === 'oq_s1');
    expect(s1.triaged).toBeUndefined();
    expect(s1.triage).toBe('surfaced');
    const a1 = out.questions.find((q: any) => q.id === 'oq_a1');
    expect(a1.answeredBy).toBe('supervisor');
    expect(out.triageNote).toContain('1 of these are TRIAGED to the Fleet Supervisor');
    expect(out.triageNote).toContain('answer_owner_question');
    expect(out.staleGateNote).toContain('1 of these are NOT open');
  });

  it('no triaged rows → no triageNote (envelope unchanged for legacy readers)', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      { id: 'oq_c1', status: 'open', question: 'Which region?', chatId: 'lane-1', createdAt: new Date(), triaged: false },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    expect(out.triageNote).toBeUndefined();
    expect(out.questions[0].triaged).toBeUndefined();
  });

  it('ticket 238c9e2a: a DECLARED-envKey credential gate renders the gate note naming ALL three lift channels', async () => {
    // The pre-fix note said the gate opens "ONLY when the declared envKey is
    // stored via store_secret" — wrong on two of the three channels
    // credentialLifted() + the paste path actually lift on (the card key-field
    // paste, the CodingCredential row / the Account UI). Mirrors ccc2e7ad's
    // canonical channel list (PR #1851).
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      {
        id: 'oq_k1', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false,
        question: 'SCHOOLTIME API KEY: please provide the SCHOOLTIME_API_KEY so the sweep can call the API.',
        expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
        answer: '[owner replied, gate still shut — …]',
      },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const k1 = out.questions.find((q: any) => q.id === 'oq_k1');
    expect(k1.credentialGateOpen).toBe(true);
    // All three channels, with the declared key named.
    expect(k1.credentialGateNote).toContain('the SCHOOLTIME_API_KEY key is stored');
    expect(k1.credentialGateNote).toContain("store_secret, the card's key field or the Account UI");
    // The store_secret-only inaccuracy is gone; the recorded reply still rides.
    expect(k1.credentialGateNote).not.toContain('stored via store_secret');
    expect(k1.recordedReply).toContain('gate still shut');
  });

  it('ticket 238c9e2a: a BARE credential gate (no envKey) names the key-field paste as its ONLY lift', async () => {
    // No declared key ⇒ credentialLifted() has nothing to look up and
    // store_secret / the Account UI have no declared key to store under —
    // only the key-field paste (the ad4fae90 lift path) can lift it.
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      {
        id: 'oq_b1', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false,
        question: 'Can you send the keys?',
        expectedAnswerType: 'credential:',
        answer: '[owner replied, gate still shut — …]',
      },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const b1 = out.questions.find((q: any) => q.id === 'oq_b1');
    expect(b1.credentialGateOpen).toBe(true);
    expect(b1.credentialGateNote).toContain("only a paste through the card's key field can lift it");
    // Never claims store_secret / the Account UI lift a bare gate.
    expect(b1.credentialGateNote).not.toContain('store_secret, the card\'s key field or the Account UI');
    expect(b1.recordedReply).toContain('gate still shut');
  });

  it('ticket 238c9e2a: an envKey inferable from the question text still gets the three-channel note (same parse as the answer path)', async () => {
    // parseExpectedAnswerType re-infers the key from the question when the
    // stored slot is bare — the list note must match the answer path's view
    // of the same row, never a different gate.
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      {
        id: 'oq_i1', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false,
        question: 'Please paste your SCHOOLTIME_API_KEY here.',
        expectedAnswerType: 'credential:',
        answer: '[owner replied, gate still shut — …]',
      },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const i1 = out.questions.find((q: any) => q.id === 'oq_i1');
    expect(i1.credentialGateOpen).toBe(true);
    expect(i1.credentialGateNote).toContain('the SCHOOLTIME_API_KEY key is stored');
    expect(i1.credentialGateNote).toContain("store_secret, the card's key field or the Account UI");
  });

  it('ticket 238c9e2a: non-credential and non-open rows render NO gate note (unchanged shape)', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      { id: 'oq_f1', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false, question: 'Which region?', expectedAnswerType: 'choice' },
      { id: 'oq_f2', status: 'answered', chatId: 'lane-1', createdAt: new Date(), triaged: false, question: 'Old credential ask?', expectedAnswerType: 'credential:SCHOOLTIME_API_KEY', answer: 'stored' },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    expect(out.questions.find((q: any) => q.id === 'oq_f1').credentialGateOpen).toBeUndefined();
    expect(out.questions.find((q: any) => q.id === 'oq_f2').credentialGateOpen).toBeUndefined();
    expect(out.staleGateNote).toContain('1 of these are NOT open');
  });

  // ── Ticket 913339d7 — review obs 5 + obs 6 on the PR #1873 surface ─────────
  it('913339d7 obs 5: a PARSEABLE recorded reply renders ONLY the structured field — the raw string no longer duplicates it on credential gates', async () => {
    // A current-format owner-facing block (f3a69ed3): the parser recognizes
    // it, so `ownerRecordedReply` is the canonical rendering. The legacy raw
    // `recordedReply` string is the FALLBACK for unparseable answers only —
    // before this ticket BOTH rode the same row (two fields, same answer,
    // one 500-char duplicate).
    const recorded = '↩ YOUR REPLY (received 2026-10-21T16:50:00.000Z): "try to remote use mbp-1 now i stopped othger screenshare" — recorded, not yet an answer: this card opens only when the key itself is stored — paste it in the key field on the card (or store it via store_secret / Account → Coding credentials), words alone cannot open it; your reply was sent into the asking chat and the agent was woken with it.';
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      {
        id: 'oq_s1', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false,
        question: 'SCHOOLTIME API KEY: please provide the SCHOOLTIME_API_KEY so the sweep can call the API.',
        expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
        answer: recorded,
      },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const s1 = out.questions.find((q: any) => q.id === 'oq_s1');
    expect(s1.credentialGateOpen).toBe(true);
    // The structured field is present and canonical…
    expect(s1.ownerRecordedReply.text).toContain('try to remote use mbp-1');
    expect(s1.ownerRecordedReply.delivered).toContain('woken');
    // …and the raw duplicate is GONE (obs 5).
    expect(s1.recordedReply).toBeUndefined();
  });

  it('913339d7 obs 5 fallback: an UNPARSEABLE answer on an open credential gate still rides the raw recordedReply slice (never invisible)', async () => {
    // The fallback path: an answer column the f3a69ed3 parser does not
    // recognize (a future format, an unknown stamp) must remain visible to a
    // lane re-listing the gate — the raw 500-char slice stays.
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      {
        id: 'oq_s2', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false,
        question: 'SCHOOLTIME API KEY: please provide the SCHOOLTIME_API_KEY so the sweep can call the API.',
        expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
        answer: '[some future unparseable stamp 2027-01-01] words that no parser knows',
      },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const s2 = out.questions.find((q: any) => q.id === 'oq_s2');
    expect(s2.credentialGateOpen).toBe(true);
    expect(s2.recordedReply).toContain('some future unparseable stamp');
    expect(s2.ownerRecordedReply).toBeUndefined();
  });

  it('913339d7 obs 6: a folded replacement card carries carriesPriorReply even with NO recorded reply on the row itself', async () => {
    // The fold rides the QUESTION (the predecessor's reply, folded at flag
    // time — f3a69ed3 defect 2), not the answer column. Before this ticket
    // the fold parse was gated behind the recorded-reply parse, so a fresh
    // replacement card (no reply on IT yet) never surfaced carriesPriorReply
    // — its fold stayed visible only through the 300-char question head, which
    // a long question clips away. The hoisted parse surfaces the fold on
    // every open row that carries one.
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      {
        id: 'oq_s3', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false,
        question: `Should the lane re-ask the tailscale question now?\n\n↩ FROM YOUR EARLIER REPLY — (card oq_510a512a-1a2b-3c4d-5e6f-7a8b9c0d1e2f): "use my mbp-1 to fix the tailscale json"`,
        expectedAnswerType: 'choice',
        options: [{ label: 'yes' }, { label: 'no' }],
      },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const s3 = out.questions.find((q: any) => q.id === 'oq_s3');
    expect(s3.carriesPriorReply).toBe('oq_510a512a-1a2b-3c4d-5e6f-7a8b9c0d1e2f');
    // No recorded reply on THIS card yet — the structured field is absent.
    expect(s3.ownerRecordedReply).toBeUndefined();
  });
});

describe('flag_owner_question — the lane learns where its question went', () => {
  it('a triaged create echoes triage:"supervisor" + a do-not-report-as-owner-wait message', async () => {
    oq.flagOwnerQuestion.mockResolvedValue({ kind: 'created', question: { id: 'oq_tri', triage: 'supervisor' } });
    const out = JSON.parse(await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'flag_owner_question', { question: 'Approve the staging window?' }));
    expect(out).toMatchObject({ ok: true, questionId: 'oq_tri', triage: 'supervisor' });
    expect(out.message).toContain('Fleet Supervisor first');
    expect(out.message).toContain('waiting on the owner');
    // machineTriggered rides through from the absent user turn.
    expect(oq.flagOwnerQuestion).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'lane-1', machineTriggered: true }));
  });

  it('a non-triaged create keeps the byte-identical legacy envelope', async () => {
    const out = JSON.parse(await executePlatformTool(makeCtx({ sessionId: 'lane-1' }), 'flag_owner_question', { question: 'Which region?' }));
    expect(out).toEqual({ ok: true, questionId: 'oq_plain' });
  });
});
