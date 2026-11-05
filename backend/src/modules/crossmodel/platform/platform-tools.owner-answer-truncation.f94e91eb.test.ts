/**
 * Ticket f94e91eb (2026-11-02) — DETECTOR-RECALL / DEFECT REPLAY:
 * `list_owner_questions` silently truncated a long owner ANSWER.
 *
 * THE MISHAP THIS FILE REPLAYS. The supervisor-facing listing rendered an
 * ANSWERED row as `String(q.answer).slice(0, 500)` with no marker, no length
 * field and no pointer to the rest. The owner answered oq_d07d9c44 (Azure
 * Trusted Signing setup) with a multi-screen paste carrying Tenant ID,
 * Subscription ID, Application (client) ID and a client-secret value; the
 * listing showed it cut mid-string at "…Display name\n:\ndigby-ci\nCMD+C to".
 * A supervisor read that as "the card carries no client ID or secret",
 * published that to a peer, and a coding lane filed a NEW owner card asking
 * the owner to re-paste values they had already supplied — a duplicate
 * decision card the owner had to dismiss.
 *
 * WHY THIS SHAPE OF TEST. The defect was not a wrong value, it was an ABSENT
 * signal: "the answer does not contain X" and "X is past the cut" rendered
 * identically. So the pins below assert the SIGNAL, both ways:
 *   - a clipped preview must declare itself (answerTruncated:true, answerChars
 *     = the FULL length, a trailing marker naming the omitted count), and
 *   - an answer that fits must declare itself COMPLETE (answerTruncated:false)
 *     — an absent flag is exactly what the supervisor misread as complete.
 * The replay tests below DO fail against the pre-fix code: they assert on
 * `answerTruncated` / `answerChars` / the sentinel, none of which the old
 * rendering emitted at all, and the first one additionally asserts the shown
 * text is no longer the bare `slice(0, 500)` value.
 *
 * Scaffolding mirrors platform-tools.answer-owner-question.test.ts (same DB /
 * env mocks — platform-tools transitively imports plan.service →
 * context-store → DB/env which process.exit()s in a bare test env).
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
// reaches it via DYNAMIC import). The PURE helpers are the real module's.
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

import { executePlatformTool, PLATFORM_TOOL_SCHEMA } from './platform-tools';
import type { ToolContext } from '../coding/tools';
import {
  OWNER_ANSWER_PREVIEW_MAX, OWNER_ANSWER_TRUNCATED_MARK,
  ownerAnswerFields, ownerAnswerPreview, ownerAnswerTruncatedMarker,
} from './owner-answer-preview';

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
 * The REAL incident payload (ticket f94e91eb): the owner's Azure Trusted
 * Signing answer, reproducing the live row's head — it carried Tenant ID,
 * Subscription ID, Application (client) ID and the secret BELOW the cut. The
 * supervisor's false-negative ("no client ID") came from everything past
 * char 500 being invisible with no marker.
 */
const AZURE_HEAD = [
  'i submitted indetit verification application..below are all the codes you requested ',
  'Name', 'Sunday Market Media Inc', 'Tenant ID', '1803f98d-638d-4eb4-bf37-bbfba5d211d8',
  'Primary domain', 'SundayMarketMedia.onmicrosoft.com', 'License', 'Microsoft Entra ID Free',
  'Subscription name', 'Subscription ID', 'My role', 'Current cost', 'Secure Score',
  'Parent management group', 'Status', 'Azure subscription 1',
  '178b6442-8968-4fbe-90a1-c1cc25ef1322', 'Owner', '0.00', '-', 'Tenant Root Group', 'Active',
  'Press [Command - C] to copy', 'Display name', ':', 'digby-ci', 'CMD+C to copy the application id',
].join('\n');
// The values BELOW the pre-fix 500-char cut — the ones the supervisor declared absent.
const AZURE_WITH_IDS = `${AZURE_HEAD}\nApplication (client) ID\n9f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b\n`
  + `Client secret\n${'s'.repeat(40)}\n`;
// Comfortably past both the old 500-char slice AND 2,000 chars (the bar the
// ticket's acceptance names).
const LONG_ANSWER = `${AZURE_WITH_IDS}${'additional portal detail padding line\n'.repeat(90)}`;

describe('owner-answer-preview (pure leaf)', () => {
  it('a FITTING answer is returned verbatim and declared COMPLETE (answerTruncated:false, never absent)', () => {
    const p = ownerAnswerPreview('yes, ship it')!;
    expect(p.text).toBe('yes, ship it');
    expect(p.truncated).toBe(false);
    expect(p.chars).toBe(12);
    expect(p.omitted).toBe(0);
    // The signal must EXIST on a complete row — an absent flag is what the
    // supervisor misread as "complete", and also what it cannot branch on.
    expect(ownerAnswerFields(p)).toEqual({ answerChars: 12, answerTruncated: false });
  });

  it('a LONG answer carries a marker naming the omitted count + answerChars = the FULL stored length', () => {
    const p = ownerAnswerPreview(LONG_ANSWER)!;
    expect(p.truncated).toBe(true);
    expect(p.chars).toBe(LONG_ANSWER.length);
    expect(p.omitted).toBe(LONG_ANSWER.length - OWNER_ANSWER_PREVIEW_MAX);
    // The shown text is a PREFIX of the stored answer — never a rebuilt string.
    expect(LONG_ANSWER.startsWith(p.text)).toBe(false); // it carries the sentinel
    expect(p.text.startsWith(LONG_ANSWER.slice(0, OWNER_ANSWER_PREVIEW_MAX))).toBe(true);
    expect(p.text).toContain(OWNER_ANSWER_TRUNCATED_MARK);
    expect(p.text).toContain(`${p.omitted} chars omitted`);
    // …and it names the ONE call that returns the rest.
    expect(p.text).toContain('fullAnswer: true');
    expect(ownerAnswerFields(p)).toEqual({ answerChars: LONG_ANSWER.length, answerTruncated: true, answerOmitted: p.omitted });
  });

  it('full:true returns the stored answer UNCUT (the escape hatch the marker advertises)', () => {
    const p = ownerAnswerPreview(LONG_ANSWER, { full: true })!;
    expect(p.text).toBe(LONG_ANSWER);
    expect(p.truncated).toBe(false);
    expect(p.chars).toBe(LONG_ANSWER.length); // the length still rides, honestly
  });

  it('counts CODE POINTS, so an emoji answer is neither halved nor surrogate-split', () => {
    const emoji = '🚀'.repeat(OWNER_ANSWER_PREVIEW_MAX + 10);
    const p = ownerAnswerPreview(emoji)!;
    expect(p.chars).toBe(OWNER_ANSWER_PREVIEW_MAX + 10); // not 2× that in UTF-16 units
    expect(p.omitted).toBe(10);
    expect(p.text).not.toContain('\uFFFD'); // no lone surrogate
  });

  it('a missing / empty answer yields null — never a fake empty preview reading as "the owner said nothing"', () => {
    expect(ownerAnswerPreview(null)).toBeNull();
    expect(ownerAnswerPreview(undefined)).toBeNull();
    expect(ownerAnswerPreview('')).toBeNull();
    // N1 (review finding): the fields helper still declares the row COMPLETE
    // rather than contributing nothing — an absent answerTruncated is exactly
    // the signal the supervisor misread. A row with no answer text has nothing
    // to hide, so "0 chars, not truncated" is the honest answer.
    expect(ownerAnswerFields(null)).toEqual({ answerChars: 0, answerTruncated: false });
  });

  it('the marker is self-describing (count + both read paths)', () => {
    const m = ownerAnswerTruncatedMarker(123);
    expect(m).toContain('123 chars omitted');
    expect(m).toContain('NOT the whole answer');
    expect(m).toContain('fullAnswer: true');
    expect(m).toContain('get_chat_messages');
  });
});

describe('list_owner_questions — ticket f94e91eb replay: a long owner answer is never silently cut', () => {
  const OQ = 'oq_d07d9c44-ce4b-4797-95e2-60a34e1c9e8a';

  function answeredRow(answer: string) {
    return { id: OQ, status: 'answered', answer, answeredBy: 'owner', chatId: 'chat-azure', question: 'Azure signing — three steps', createdAt: new Date('2026-11-01T19:37:48.176Z'), triaged: false };
  }

  it('REPLAY: a >2000-char answer comes back flagged, with a marker and the full length — not a silent 500-char prefix', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [answeredRow(LONG_ANSWER)] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', { ids: [OQ] }));
    const row = out.questions[0];

    // THE DEFECT, asserted closed: the old rendering was exactly
    // String(answer).slice(0, 500) — a bare prefix, 500 chars, no marker, no
    // fields. The preview is still a PREFIX (that part was always right); what
    // must be gone is the SILENCE, so the shown text must now be strictly
    // longer than the old cut and end with the declaring sentinel.
    const silentCut = LONG_ANSWER.slice(0, 500);
    expect(row.answer).not.toBe(silentCut);          // pre-fix value
    expect(row.answer.startsWith(silentCut)).toBe(true); // still an honest prefix…
    expect(row.answer.length).toBeGreaterThan(silentCut.length); // …but not silently truncated
    expect(row.answer).toContain('chars omitted');

    // What rides instead: a declared preview + the machine-readable fields.
    expect(row.answerTruncated).toBe(true);
    expect(row.answerChars).toBe(LONG_ANSWER.length); // the FULL stored length
    expect(typeof row.answerOmitted).toBe('number');
    expect(row.answer.endsWith(']')).toBe(true); // the sentinel closes the preview
    expect(row.answer).toContain(OWNER_ANSWER_TRUNCATED_MARK);
    expect(row.answer).toContain('chars omitted');

    // Envelope-level signal: a caller skimming questions[] still sees it.
    expect(out.answerPreviewNote).toContain('TRUNCATED answer preview');
    expect(out.answerPreviewNote).toContain('fullAnswer: true');
    expect(out.answerPreviewNote).toContain(OQ.slice(0, 11));
  });

  it('REPLAY: fullAnswer:true returns the values the supervisor declared ABSENT (Tenant ID / client ID / secret)', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [answeredRow(LONG_ANSWER)] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', { ids: [OQ], fullAnswer: true }));
    const row = out.questions[0];

    // This is the false-negative the incident cost the owner: all three were
    // BEYOND the preview, so the preview could not answer "is it there?" —
    // the full read must.
    expect(row.answer).toBe(LONG_ANSWER);
    expect(row.answerTruncated).toBe(false);
    expect(row.answerChars).toBe(LONG_ANSWER.length);
    expect(row.answer).toContain('1803f98d-638d-4eb4-bf37-bbfba5d211d8'); // Tenant ID
    expect(row.answer).toContain('9f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'); // client ID
    expect(row.answer).toContain('Client secret');
    // No truncation note when nothing is truncated.
    expect(out.answerPreviewNote).toBeUndefined();
  });

  it('a SHORT answer is returned whole AND declared complete (answerTruncated:false) — never an absent flag', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [answeredRow('yes, ship it')] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const row = out.questions[0];
    expect(row.answer).toBe('yes, ship it');
    expect(row.answerTruncated).toBe(false); // present, not undefined
    expect(row.answerChars).toBe(12);
    expect(out.answerPreviewNote).toBeUndefined();
  });

  it('an OPEN row with a long recorded reply is flagged the same way (ownerRecordedReply.truncated)', async () => {
    const longReply = `↩ YOUR REPLY (received 2026-10-21T16:50:00.000Z): "${'x'.repeat(4000)}" — recorded, not yet an answer: this card opens only when the key itself is stored - paste it in the key field; your reply was sent into the asking chat and the agent was woken with it.`;
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      { id: 'oq_r1', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false, question: 'Paste the key', answer: longReply },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const r1 = out.questions.find((q: any) => q.id === 'oq_r1');
    expect(r1.ownerRecordedReply.truncated).toBe(true);
    expect(r1.ownerRecordedReply.chars).toBeGreaterThan(OWNER_ANSWER_PREVIEW_MAX);
    expect(r1.ownerRecordedReply.text).toContain(OWNER_ANSWER_TRUNCATED_MARK);
    expect(out.answerPreviewNote).toContain('TRUNCATED answer preview');
  });

  it('an UNPARSEABLE long answer on an open credential gate is flagged too (the raw fallback never reads as complete)', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      {
        id: 'oq_u1', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false,
        question: 'SCHOOLTIME API KEY: please provide the SCHOOLTIME_API_KEY so the sweep can call the API.',
        expectedAnswerType: 'credential:SCHOOLTIME_API_KEY',
        answer: `[some future unparseable stamp 2027-01-01] ${'y'.repeat(3000)}`,
      },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const u1 = out.questions.find((q: any) => q.id === 'oq_u1');
    expect(u1.recordedReplyTruncated).toBe(true);
    expect(u1.recordedReplyChars).toBeGreaterThan(OWNER_ANSWER_PREVIEW_MAX);
    expect(u1.recordedReply).toContain(OWNER_ANSWER_TRUNCATED_MARK);
  });

  it('the schema advertises answerTruncated/answerChars and the fullAnswer escape hatch', () => {
    const entry = PLATFORM_TOOL_SCHEMA.find((t: any) => t.function.name === 'list_owner_questions') as any;
    expect(entry.function.parameters.properties.fullAnswer).toBeDefined();
    const desc = entry.function.parameters.properties.fullAnswer.description;
    expect(desc).toContain('answerTruncated');
    expect(desc).toContain('answerChars');
    expect(desc).toContain('Never conclude an answer lacks something from a truncated preview');
  });
});

/**
 * Findings from the INDEPENDENT ADVERSARIAL REVIEW of this diff (reviewer
 * sub-session, report 2026-11-02T22:34Z). Each test below pins a finding that
 * was real: B1 and M1 were BLOCKING, M2 was the same defect on a surface one
 * tool call earlier.
 */
describe('list_owner_questions — review findings pinned (f94e91eb)', () => {
  it('B1: a legacy recorded reply with an EMPTY parsed text does not take down the whole listing', async () => {
    // parseOwnerRecordedReply's legacy branches return text:'' when the quoted
    // pair is absent (owner-questions.ts:690/706 — an unquoted 'reply was:'
    // record, or a lost closing quote). ownerAnswerPreview('') is null, so a
    // non-null assertion here threw a TypeError that executeCodingTool turned
    // into ONE error string — every row lost, including the gate being checked.
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      {
        id: 'oq_legacy', status: 'open', chatId: 'lane-1', createdAt: new Date(), triaged: false,
        question: 'Paste the key',
        // matches the legacy credential branch ('[owner replied' + 'reply was:')
        // but carries NO quoted pair → parsed text is ''.
        answer: '[owner replied (conversation, not the key), gate still shut — needs the SCHOOLTIME_API_KEY credential stored; reply was: hunter2]',
      },
      { id: 'oq_ok', status: 'answered', chatId: 'lane-2', createdAt: new Date(), triaged: false, question: 'Ship it?', answer: 'yes', answeredBy: 'owner' },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    // The listing must SURVIVE and still carry the answered gate the caller came for.
    expect(out.questions.map((q: any) => q.id)).toEqual(['oq_legacy', 'oq_ok']);
    expect(out.questions[1].answer).toBe('yes');
    // The legacy row declares its (empty) recorded reply honestly, never throws.
    const legacy = out.questions[0];
    expect(legacy.ownerRecordedReply.chars).toBe(0);
    expect(legacy.ownerRecordedReply.truncated).toBe(false);
  });

  it('M1: the envelope truncation note is emitted BEFORE questions[] so a head-clip cannot drop it', async () => {
    // agent.ts clips a persisted display result with a HEAD slice
    // (DISPLAY_RESULT_CAP). Anything serialized after questions[] is exactly
    // what a large listing loses — and a large listing is the only case the
    // note exists for. Assert on the RAW JSON key ORDER, not the parsed object.
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      { id: 'oq_big', status: 'answered', chatId: 'c', createdAt: new Date(), triaged: false, question: 'Azure', answer: LONG_ANSWER, answeredBy: 'owner' },
    ] });
    const raw = await executePlatformTool(makeCtx(), 'list_owner_questions', {});
    expect(raw.indexOf('"answerPreviewNote"')).toBeGreaterThan(-1);
    expect(raw.indexOf('"answerPreviewNote"')).toBeLessThan(raw.indexOf('"questions"'));
    // …and it fits inside the display cap on its own, so a 8000-char head slice
    // still carries the whole warning.
    const note = JSON.parse(raw).answerPreviewNote as string;
    expect(note.length).toBeLessThan(1000);
  });

  it('M2: flag_owner_question\'s prior-answer refusal declares truncation too (the surface hit just BEFORE a re-ask)', async () => {
    // The incident chain ran THROUGH this surface: the supervisor was about to
    // re-ask, and a bare 300-char prefix with no marker is the same confident
    // false-negative one tool call earlier.
    oq.flagOwnerQuestion.mockResolvedValue({
      kind: 'refused', refused: 'previously_answered',
      prior: { id: 'oq_prior01', question: 'Azure signing', answer: LONG_ANSWER },
    });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'flag_owner_question', { question: 'Paste Azure client id', chatId: 'c1' }));
    expect(out.ok).toBe(false);
    expect(out.answerTruncated).toBe(true);
    expect(out.answerChars).toBe(LONG_ANSWER.length);
    expect(out.priorAnswer).toContain(OWNER_ANSWER_TRUNCATED_MARK);
    expect(out.priorAnswerNote).toContain('fullAnswer: true');
  });

  it('N2: fullAnswer accepts the STRING "true" models actually emit', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      { id: 'oq_s1', status: 'answered', chatId: 'c', createdAt: new Date(), triaged: false, question: 'Q', answer: LONG_ANSWER, answeredBy: 'owner' },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', { ids: ['oq_s1'], fullAnswer: 'true' }));
    expect(out.questions[0].answer).toBe(LONG_ANSWER);
    expect(out.questions[0].answerTruncated).toBe(false);
  });

  it('N1/N3: an answered row with no answer text still carries answerTruncated:false; cap:null is not a zero-length preview', async () => {
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      { id: 'oq_empty', status: 'answered', chatId: 'c', createdAt: new Date(), triaged: false, question: 'Q', answer: null, answeredBy: 'owner' },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    // The invariant the tool description advertises: always true OR false.
    expect(out.questions[0].answerTruncated).toBe(false);
    expect(out.questions[0].answerChars).toBe(0);
    // cap:null must mean "default", never 0 (Number(null) === 0).
    const p = ownerAnswerPreview('hello world', { cap: null as any })!;
    expect(p.truncated).toBe(false);
    expect(p.text).toBe('hello world');
  });

  it('N4: the integration surface counts CODE POINTS too (answerChars vs a UTF-16 .length would diverge)', async () => {
    const emoji = `🚀${'x'.repeat(OWNER_ANSWER_PREVIEW_MAX + 5)}`;
    oq.listOwnerQuestionsForUser.mockResolvedValue({ unmatchedIds: [], rows: [
      { id: 'oq_emoji', status: 'answered', chatId: 'c', createdAt: new Date(), triaged: false, question: 'Q', answer: emoji, answeredBy: 'owner' },
    ] });
    const out = JSON.parse(await executePlatformTool(makeCtx(), 'list_owner_questions', {}));
    const row = out.questions[0];
    expect(row.answerChars).toBe(OWNER_ANSWER_PREVIEW_MAX + 6); // code points
    expect(row.answerChars).not.toBe(emoji.length);              // not UTF-16 units
    expect(row.answer).not.toContain('\uFFFD');                  // no split surrogate
  });
});