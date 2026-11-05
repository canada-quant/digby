/**
 * Ticket 9dff565f (2026-11-02) — DEFECT REPLAY: the `question` field of the
 * `list_owner_questions` brief was the LAST silent clip on that surface.
 *
 * THE RELATIONSHIP TO ticket f94e91eb (already in main, PR #2361). That lane
 * fixed the SAME incident (owner card oq_d07d9c44, the Azure Trusted Signing
 * paste) and covered the ANSWER-side clips: `answer`, the raw `recordedReply`
 * fallback and `ownerRecordedReply.text` all now run through
 * ownerAnswerPreview and carry answerChars / answerTruncated plus a trailing
 * sentinel. My ticket names three fields, and the third — `question:
 * String(q.question).slice(0, 300)` — was left as the same unmarked head
 * slice. So this file pins THAT residual and nothing f94e91eb already pins;
 * the machinery is deliberately f94e91eb's own (ownerAnswerPreview), not a
 * second preview helper.
 *
 * WHY THE QUESTION CLIP MATTERED. The column holds QUESTION_MAX (2000), and a
 * consoleAction card reaches CONSOLE_ACTION_QUESTION_MAX (9000) — the
 * paste-ready payload and the click-by-click steps the owner is asked to
 * follow live in the text, so a head-clipped question drops exactly the part
 * a reader needs. And a clipped question that says nothing about being
 * clipped renders "this card never asked for X" identically to "X is past the
 * cut" — the same absence-by-truncation class the answer fix exists for.
 *
 * SECOND DEFECT PINNED HERE (the one-call-over trap). The answer's marker
 * advertises `list_owner_questions { fullAnswer: true }` as the way to read
 * the rest. If `question` clipped unconditionally, that advertised route
 * would NOT exist for it — a marker naming a dead escape hatch, which is the
 * original defect wearing a different hat. So `fullAnswer` lifts the question
 * clip too, and both directions are asserted below.
 *
 * Scaffolding mirrors platform-tools.owner-answer-truncation.f94e91eb.test.ts
 * (platform-tools transitively imports plan.service → context-store → DB/env,
 * which process.exit()s in a bare test env).
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

const supStateSvc = {
  isSupervisorChat: jest.fn(async () => false),
  applyStateUpdate: jest.fn(async () => ({ applied: [] as string[], errors: [] as string[] })),
};
jest.mock('./supervisor-state.service', () => ({ __esModule: true, ...supStateSvc }));

// The owner-questions store under the tools, mocked at the boundary (dispatch
// reaches it via DYNAMIC import). The PURE helpers are the real module's, so
// the rendering under test is the real one.
const oq = {
  ...jest.requireActual('./owner-questions'),
  answerOwnerQuestion: jest.fn(async (): Promise<'ok'> => 'ok'),
  listOwnerQuestionsForUser: jest.fn(async (): Promise<{ rows: any[]; unmatchedIds: string[] }> => ({ rows: [], unmatchedIds: [] })),
  flagOwnerQuestion: jest.fn(async (): Promise<any> => ({ kind: 'created', question: { id: 'oq_plain' } })),
};
jest.mock('./owner-questions', () => ({ __esModule: true, ...oq }));

const metrics = {
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: {
    MACHINE_SCHEDULE_MUTATION: 'machine_schedule_mutation',
    CONFIRMATION_STAGED: 'confirmation_staged',
    OWNER_QUESTION_SUPERVISOR_ANSWERED: 'owner_question_supervisor_answered',
  },
};
jest.mock('./loop-metrics.service', () => ({ __esModule: true, ...metrics }));

import { executePlatformTool } from './platform-tools';
import type { ToolContext } from '../coding/tools';
import { OWNER_ANSWER_TRUNCATED_MARK, OWNER_QUESTION_TRUNCATED_MARK } from './owner-answer-preview';

/** The pre-fix clip budget for `question`, kept as a literal so the test
 *  fails loudly if someone silently changes the budget instead of the
 *  behaviour. */
const QUESTION_BRIEF_CAP = 300;

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
  oq.listOwnerQuestionsForUser.mockResolvedValue({ rows: [], unmatchedIds: [] });
});

/**
 * A consoleAction-shaped card question: the flagger's instruction FIRST, then
 * the paste-ready payload and the click-by-click steps — all of which sit past
 * the 300-char brief budget, i.e. exactly what the pre-fix head slice threw
 * away with no signal.
 */
const CONSOLE_ACTION_QUESTION = [
  'Apply this read-only policy in the Tailscale admin console, then paste back the resulting JSON.',
  '',
  'Payload to paste:',
  '{"acls":[{"action":"accept","src":["autogroup:member"],"dst":["tag:server:22"]}],"tagOwners":{}}',
  '',
  'Click-by-click steps:',
  '1. Click the Access Controls tab.',
  '2. Replace the whole file with the payload above.',
  '3. Click Save, then Copy the JSON back into this card.',
].join('\n');

describe('list_owner_questions — the QUESTION clip is honest (ticket 9dff565f)', () => {
  it('the fixture is longer than the brief cap and its payload sits past it (the replay would pass vacuously otherwise)', () => {
    expect(CONSOLE_ACTION_QUESTION.length).toBeGreaterThan(QUESTION_BRIEF_CAP);
    // The LAST step is what the pre-fix slice dropped — assert on that, not on
    // a line that happens to sit just inside the kept prefix.
    expect(CONSOLE_ACTION_QUESTION.slice(QUESTION_BRIEF_CAP)).toContain('Click Save');
    expect(CONSOLE_ACTION_QUESTION.indexOf('Click Save')).toBeGreaterThan(QUESTION_BRIEF_CAP);
  });

  it('a >300-char question is MARKED, not silently cut — questionTruncated + questionChars = the full length', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({
      unmatchedIds: [],
      rows: [{
        id: 'oq_d07d9c44-0000-0000-0000-000000000000', status: 'open',
        question: CONSOLE_ACTION_QUESTION, chatId: 'lane-1', createdAt: new Date(),
      }],
    });
    const row = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {})).questions[0];

    // Pre-fix this was String(q.question).slice(0, 300): no marker, no fields —
    // so "the card never gave the payload" and "the payload is past the cut"
    // rendered identically. Both signals must now be present.
    expect(row.questionChars).toBe(CONSOLE_ACTION_QUESTION.length);
    expect(row.questionTruncated).toBe(true);
    expect(row.question.startsWith(CONSOLE_ACTION_QUESTION.slice(0, QUESTION_BRIEF_CAP))).toBe(true);
    // Review finding D1: the sentinel must name the QUESTION, not the answer.
    // A clipped question labelled "not the whole answer" is the same class of
    // ambiguity this ticket exists to kill, one field over.
    expect(row.question).toContain(OWNER_QUESTION_TRUNCATED_MARK);
    expect(row.question).toContain('chars omitted; this preview is NOT the whole question');
    expect(row.question).not.toContain(OWNER_ANSWER_TRUNCATED_MARK);
    // The marker names the call that returns the rest.
    expect(row.question).toContain('fullAnswer: true');
    // The dropped tail is genuinely dropped from the preview — the test is not
    // passing because the whole thing fit. ("Click Save" is past the cut; the
    // earlier steps sit inside the kept prefix.)
    expect(row.question).not.toContain('Click Save');
  });

  it('a SHORT question is returned whole AND declared complete (questionTruncated === false, never undefined)', async () => {
    const short = 'Hold the release until the signing fix lands?';
    oq.listOwnerQuestionsForUser.mockResolvedValue({
      unmatchedIds: [],
      rows: [{ id: 'oq_short', status: 'open', question: short, chatId: 'lane-1', createdAt: new Date() }],
    });
    const row = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {})).questions[0];
    expect(row.question).toBe(short);
    expect(row.questionChars).toBe(short.length);
    // An ABSENT flag is what a reader misreads as "complete" — it must EXIST
    // and be false, so `if (row.questionTruncated === false)` means something.
    expect(row.questionTruncated).toBe(false);
  });

  it('fullAnswer:true lifts the question clip too — the route the marker advertises actually exists', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({
      unmatchedIds: [],
      rows: [{
        id: 'oq_d07d9c44-0000-0000-0000-000000000000', status: 'open',
        question: CONSOLE_ACTION_QUESTION, chatId: 'lane-1', createdAt: new Date(),
      }],
    });
    const row = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', { fullAnswer: true })).questions[0];
    expect(row.question).toBe(CONSOLE_ACTION_QUESTION);
    expect(row.questionChars).toBe(CONSOLE_ACTION_QUESTION.length);
    expect(row.questionTruncated).toBe(false);
    // The payload and the steps — the reason the question exists — survive.
    expect(row.question).toContain('Payload to paste');
    expect(row.question).toContain('Click the Access Controls tab');
  });

  it('a question right at the boundary is not marked (the boundary lies in neither direction)', async () => {
    const exact = 'q'.repeat(QUESTION_BRIEF_CAP);
    oq.listOwnerQuestionsForUser.mockResolvedValue({
      unmatchedIds: [],
      rows: [{ id: 'oq_edge', status: 'open', question: exact, chatId: 'lane-1', createdAt: new Date() }],
    });
    const row = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {})).questions[0];
    expect(row.question).toBe(exact);
    expect(row.questionTruncated).toBe(false);
  });

  // Review finding D2 (ticket 9dff565f): the envelope note used to be computed
  // from the ANSWER flags only, so a listing whose ONLY clipped column was a
  // question emitted no note at all. agent.ts head-slices a persisted display
  // result at DISPLAY_RESULT_CAP, so the note is precisely what survives a big
  // listing — i.e. the case the note exists for lost its warning.
  it('a question-only clip still raises the envelope note (the case the note exists for)', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({
      unmatchedIds: [],
      rows: [{
        id: 'oq_d07d9c44-1111-1111-1111-111111111111', status: 'open',
        question: CONSOLE_ACTION_QUESTION, chatId: 'lane-1', createdAt: new Date(),
      }],
    });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));

    // No answer truncation flag on this row at all (it is OPEN, no answer →
    // the answer fields never ride), so the answer branch of the note
    // contributes nothing — the note below can only come from the question.
    expect(out.questions[0].answerTruncated).toBeUndefined();
    expect(out.answerPreviewNote).toBeDefined();
    expect(out.answerPreviewNote).toContain('TRUNCATED question preview');
    expect(out.answerPreviewNote).not.toContain('TRUNCATED answer preview');
    expect(out.answerPreviewNote).toContain('questionTruncated:true');
    expect(out.answerPreviewNote).toContain('questionChars');
    // It still names the one call that reads the tail whole.
    expect(out.answerPreviewNote).toContain('fullAnswer: true');
    expect(out.answerPreviewNote).toContain('oq_d07d9c44'.slice(0, 11));
  });

  it('an unclipped listing still emits NO note (the note means something)', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({
      unmatchedIds: [],
      rows: [{ id: 'oq_tiny', status: 'open', question: 'Ship it?', chatId: 'lane-1', createdAt: new Date() }],
    });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    expect(out.questions[0].questionTruncated).toBe(false);
    expect(out.answerPreviewNote).toBeUndefined();
  });
});