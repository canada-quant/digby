/**
 * Cohesive chat — END-TO-END replay on the merged tree (cohesive/integration,
 * 2026-09-28; owner: "when someone asks for a task or a subsession or long
 * running session is needed it does it automatically and returns results").
 *
 * The two owner transcripts replayed through the REAL merged modules:
 *
 *   1. THE DECK — a human asks for a deck. The consequential gate (branch A,
 *      platform-tools + work-tools) executes start_coding_session AT ONCE on
 *      the human turn: no confirmation row, no "confirm the card"; the direct
 *      path emits the running SESSION card on the parent's live stream and the
 *      finalize persists it on the answer row (task-events, branch B's module
 *      + branch D's parser). The child run completes with
 *      deck/cql-dgx-b300-deck.pdf and the deliverable hand-off (branch C)
 *      posts ONE result message on the parent with the download link and
 *      flips the SAME card to done (preferCarrier — one card, running → done,
 *      "Open result" → the result row). The parent's hook wake is told the
 *      deliverables already landed. The model's own closing for that turn is
 *      not a hand-back (branch E's detector + branch B's classifier agree).
 *
 *   2. THE iMESSAGE THREADS — the per-turn deadline ended the run mid-task and
 *      the model handed the rest back ("say the word and I will search her
 *      thread next"). The lint detects the hand-back (E, observe-only), the
 *      classifier continues (B), a continuation round is armed on the SAME
 *      chat, the closing is rewritten (no question back), the card runs, the
 *      round's result is posted and the card settles done — nothing the user
 *      ever reads says "say the word".
 *
 * Hermetic: the service layer under the tools and the DB are in-memory (the
 * mock stack mirrors platform/work-tools.test.ts); live-runs is REAL, so the
 * `task` frames are the ones a viewer's SSE stream would carry.
 */

import { createPendingConfirmationTable } from './platform/pending-confirmations.testkit';
import { createOwnerQuestionTable } from './platform/owner-questions.testkit';

const mockConfirmations = createPendingConfirmationTable();
const mockOwnerQuestions = createOwnerQuestionTable();

// ── In-memory crossmodel_messages (the task card rows) ──────────────────────
const messageRows = new Map<string, any>();
let messageSeq = 0;
const messageStore = {
  create: jest.fn(async ({ data }: any) => {
    const row = { id: data.id ?? `row-${++messageSeq}`, createdAt: new Date(Date.now() + messageSeq), parts: null, metadata: null, ...data };
    messageRows.set(row.id, row);
    return row;
  }),
  findUnique: jest.fn(async ({ where }: any) => messageRows.get(where.id) ?? null),
  findFirst: jest.fn(async ({ where }: any) => {
    if (where?.id) {
      const r = messageRows.get(where.id);
      return r && (!where.chatId || r.chatId === where.chatId) && (!where.role || r.role === where.role) ? r : null;
    }
    const list = [...messageRows.values()].filter((r) => (!where?.chatId || r.chatId === where.chatId) && (!where?.role || r.role === where.role));
    return list.sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  }),
  findMany: jest.fn(async ({ where }: any) => {
    const list = [...messageRows.values()].filter((r) => (!where?.chatId || r.chatId === where.chatId) && (!where?.role || r.role === where.role));
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }),
  update: jest.fn(async ({ where, data }: any) => { const r = messageRows.get(where.id); Object.assign(r, data); return r; }),
  count: jest.fn(async () => 0),
};

jest.mock('../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    ownerQuestion: mockOwnerQuestions.api,
    crossModelMessage: messageStore,
    crossModelChat: mockOwnerQuestions.crossModelChat,
    telegramLink: { findUnique: async () => null },
  },
}));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('./telegram/telegram.service', () => ({ __esModule: true, isConfigured: () => true, sendMessage: async () => {} }));
const mockStore = new Map<string, any>();
jest.mock('./memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => mockStore.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { mockStore.set(`${ns.join('/')}::${key}`, value); }),
  storeCreate: jest.fn(async (ns: string[], key: string, value: any) => {
    const k = `${ns.join('/')}::${key}`;
    if (mockStore.has(k)) return false;
    mockStore.set(k, value);
    return true;
  }),
  storeDelete: jest.fn(async (ns: string[], key: string) => { mockStore.delete(`${ns.join('/')}::${key}`); }),
}));
jest.mock('./coding/coding-retrieval.service', () => ({
  __esModule: true, searchMemory: jest.fn(async () => []), storeFindings: jest.fn(async () => 0), clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('./coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(), stopProcess: jest.fn(async () => ''), listProcesses: jest.fn(async () => ''), processSnapshot: jest.fn(() => []),
}));
jest.mock('./coding/code-index.service', () => ({
  __esModule: true, searchCodeSemantic: jest.fn(async () => []), syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })), kickCodeIndexSync: jest.fn(),
}));
jest.mock('../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));

const CHILD = 'sess-9dfade89-aaaa-bbbb-cccc-000000000001';
const PARENT = 'chat-parent-0000-bbbb-cccc-000000000002';
const USER = 'u1';
const SPAWN = { id: CHILD, projectId: 'p1', title: 'CQL DGX B300 deck', branch: `digby/session-${CHILD.slice(0, 13)}`, baseBranch: 'main', model: 'glm-5.3', modelSource: null, permissionMode: 'auto' };

const svc = {
  startCodingSession: jest.fn(async () => SPAWN),
  resolveCodingSessionTarget: jest.fn(async (): Promise<any> => ({
    ok: true,
    project: { id: 'p1', userId: USER, name: 'CQL', repoUrl: 'https://github.com/a/b', defaultBranch: 'main', provider: 'github', githubLabel: null, folderId: null, createdAt: new Date(), updatedAt: new Date() },
    projectId: 'p1', source: 'direct',
  })),
  suggestProjectsByIdPrefix: jest.fn(async () => []),
  scheduleChatRun: jest.fn(), listSchedules: jest.fn(async () => []), cancelSchedule: jest.fn(async () => true), updateSchedule: jest.fn(),
};
jest.mock('./platform/platform.service', () => ({ __esModule: true, ...svc }));
jest.mock('./platform/directive-conflict', () => ({ __esModule: true, checkScheduleDirectiveConflict: jest.fn(async () => ({ conflict: false })) }));
jest.mock('./feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(), listFeedbackTickets: jest.fn(), updateFeedbackTicket: jest.fn(), getFeedbackTicketById: jest.fn(), isAdminUser: jest.fn(),
}));
jest.mock('./fleet/fleet-telemetry', () => ({ __esModule: true, fleetTelemetry: jest.fn(async () => ({ ok: true })) }));
jest.mock('./feedback/closure-evidence', () => ({ __esModule: true, verifyMachineCloseEvidence: jest.fn(async () => ({ ok: true, auditNote: '', verified: [] })) }));
const mockAudit = jest.fn(async () => {});
jest.mock('./platform/autonomy.service', () => ({
  __esModule: true,
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48, MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async () => null), setChatAutonomy: jest.fn(),
  auditAutonomousExecution: (...a: any[]) => mockAudit(...(a as [])),
}));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null), combineAttachments: jest.fn((atts: any[]) => atts[0]) }));
const mockRecordLoopMetric = jest.fn();
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { WORK_TOOL_DIRECT: 'work_tool_direct', CONFIRMATION_STAGED: 'confirmation_staged', MACHINE_SCHEDULE_MUTATION: 'machine_schedule_mutation' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));
jest.mock('./coding/coding-data.service', () => ({
  __esModule: true,
  resolveOneCodingPick: jest.fn(async (pick?: string) => (pick && ['glm-5.3', 'deepseek-flash', 'kimi-k3'].includes(pick) ? pick : null)),
  createCodingProject: jest.fn(),
}));
jest.mock('./coding/project-workspace.service', () => ({ __esModule: true, validateRepoUrl: jest.fn(() => null) }));

import { executePlatformTool } from './platform/platform-tools';
import {
  TASK_EVENT_TYPE, buildSessionTaskEvent, buildTaskEvent, emitTaskEvent, parseTaskEvent, persistTaskCard, spawnedSessionsInParts, taskIdForSession,
  spawnCardStillOwed,
} from './chat-agent/task-events';
import { isTaskPart } from './coding/transcript-parts';
import { startLiveRun, endLiveRun, subscribeRun } from './coding/live-runs';
import {
  runDeliverableHandoff, handoffHookNote, HANDOFF_MESSAGE_KIND, HANDOFF_MESSAGE_ORIGIN,
  type HandoffChat, type HandoffDeps, type HandoffInput, type WorktreeFileEntry,
} from './coding/deliverable-handoff';
import { findHandback } from './chat-agent/handback-detector';
import {
  classifyRunEnd, armTurnContinuation, rewriteClosingText, nextContinuationRound, isContinuationPrompt, parseContinuationRound,
  CONTINUATION_LINE, CONTINUATION_TASK_TITLE,
} from './chat-agent/turn-continuation';
import type { ToolContext } from './coding/tools';
import type { ToolReceipt } from './coding/run-receipts';

const ANCHOR = new Date('2026-09-28T10:00:00Z');
const humanCtx = (chatId = PARENT): ToolContext => ({
  worktree: '/wt', sessionId: chatId, userId: USER, permissionMode: 'auto', agentSurface: 'chat',
  emit: () => {}, alwaysAllow: new Set<string>(), userTurnAt: ANCHOR,
  userTurnText: 'Build me a CQL DGX B300 pitch deck as a PDF',
  requestApproval: async () => 'allow', execShell: async () => ({ stdout: '', stderr: '' }),
} as unknown as ToolContext);

const T0 = Date.parse('2026-09-28T10:00:30.000Z');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1200, 0x41)]);
const DECK_LISTING: WorktreeFileEntry[] = [
  { rel: 'deck/cql-dgx-b300-deck.pdf', bytes: PDF.length, mtimeMs: T0 + 60_000 },
  { rel: 'package.json', bytes: 400, mtimeMs: T0 + 63_000 },
  { rel: 'README.md', bytes: 900, mtimeMs: T0 + 63_000 },
];

/** The hand-off's deps: the REAL task-events on the in-memory rows + the real live run; chat/file stores in memory. */
function handoffWorld(): { deps: HandoffDeps; persisted: any[]; claims: Set<string>; metrics: any[]; records: Map<string, any> } {
  const chats = new Map<string, HandoffChat>([
    [CHILD, { id: CHILD, userId: USER, parentChatId: PARENT, title: SPAWN.title }],
    [PARENT, { id: PARENT, userId: USER, parentChatId: null, title: 'Paul' }],
  ]);
  const w = { persisted: [] as any[], claims: new Set<string>(), metrics: [] as any[], records: new Map<string, any>() };
  const deps: HandoffDeps = {
    findChat: async (id) => chats.get(id) ?? null,
    countCompletedRuns: async () => 1,
    getRunReceipts: async () => [] as ToolReceipt[],
    listWorktree: async () => DECK_LISTING.map((e) => ({ ...e, mtimeMs: Date.now() })), // every run "rewrites" the deck (fresh mtime) — the dedupe must catch it by CONTENT
    gitClasses: async () => null,
    readFile: async (_root, rel) => (rel === 'deck/cql-dgx-b300-deck.pdf' ? PDF : null),
    listCanvases: async () => [],
    copyCanvas: async () => null,
    persistFiles: async (chatId, userId, loaded) => { for (const l of loaded) w.persisted.push({ chatId, userId, uploadId: l.id, filename: l.attachment.filename, bytes: Buffer.from(l.attachment.base64 ?? '', 'base64').length }); },
    findChatFiles: async (chatId, ids) => w.persisted.filter((p) => p.chatId === chatId && ids.includes(p.uploadId)).map((p) => ({ id: `file-${p.uploadId.slice(3, 9)}`, uploadId: p.uploadId, sizeBytes: p.bytes })),
    // The result row is a real assistant row of the parent (the merged persist finds it by id).
    appendMessage: async (chatId, content, metadata) => messageStore.create({ data: { chatId, role: 'assistant', content, metadata } }),
    claim: async (sessionId, runId) => { const k = `${sessionId}/${runId}`; if (w.claims.has(k)) return false; w.claims.add(k); return true; },
    releaseClaim: async () => {},
    saveRecord: async (sessionId, record) => { w.records.set(sessionId, record); },
    emitTask: (chatId, payload) => { emitTaskEvent(chatId, payload); },
    persistTaskCard: (chatId, payload, opts) => persistTaskCard(chatId, payload, opts),
    recordMetric: (m) => { w.metrics.push(m); },
  };
  return { deps, ...w };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  mockOwnerQuestions.reset();
  mockStore.clear();
  messageRows.clear();
  messageSeq = 0;
  for (const k of ['TURN_CONTINUATION_DISABLED', 'CONTINUATION_MAX_ROUNDS']) delete process.env[k];
});

describe('E2E 1 — "build me a deck": no card, one task card running → done, the PDF handed back to the chat that asked', () => {
  it('replays the deck ask through the merged gate, task-events and hand-off', async () => {
    const parentKey = `chat:${PARENT}`;
    startLiveRun(parentKey);
    const stream: Array<{ type: string; data: any }> = [];
    subscribeRun(parentKey, (e) => stream.push(e));
    try {
      // ── 1. The human turn's tool call: start_coding_session executes AT ONCE ──
      const out = await executePlatformTool(humanCtx(), 'start_coding_session', { projectId: 'p1', title: SPAWN.title, prompt: 'Build the CQL DGX B300 deck as a PDF' });
      const env = JSON.parse(out);
      expect(env).toMatchObject({ ok: true, tool: 'start_coding_session', ids: { sessionId: CHILD } });
      expect(env.needsConfirmation).toBeUndefined();
      expect(mockConfirmations.rows).toHaveLength(0); // NO confirmation row — nothing "staged and waiting on your one click"
      expect(env.message).toContain('NO confirmation card exists or is pending');
      expect(env.message).toMatch(/its progress shows on the task card in this chat/); // task-events is present in this build
      expect(env.message).not.toMatch(/waiting on your (one )?click|confirm the card|staged/i);
      expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct', meta: expect.objectContaining({ tool: 'start_coding_session', origin: 'human' }) }));
      expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirmation_staged' }));
      // The running SESSION card rode the parent's live stream at spawn time.
      const liveSpawn = stream.find((e) => e.type === TASK_EVENT_TYPE);
      expect(liveSpawn?.data).toMatchObject({ taskId: taskIdForSession(CHILD), chatId: PARENT, childChatId: CHILD, kind: 'session', status: 'running', title: SPAWN.title });

      // ── 2. The finalize: the answer row is persisted and the spawn card lands on it ──
      const answerText = `The deck build has started ("${SPAWN.title}") — its progress shows on the task card in this chat and the result is posted here when it lands.`;
      const parts = [{ type: 'tool_call', name: 'start_coding_session' }, { type: 'tool_result', name: 'start_coding_session', result: out }, { type: 'text', text: answerText }];
      const answer = await messageStore.create({ data: { chatId: PARENT, role: 'assistant', content: answerText, parts, metadata: { mode: 'thinking' } } });
      const spawned = spawnedSessionsInParts(parts); // what chat-agent finalize reads from the run
      expect(spawned).toEqual([{ sessionId: CHILD, title: SPAWN.title }]);
      const running = buildSessionTaskEvent({ chatId: PARENT, sessionId: CHILD, title: spawned[0].title, startedAt: new Date(T0).toISOString() });
      expect(await persistTaskCard(PARENT, running, { messageId: answer.id })).toBe(answer.id);
      const answerRow = messageRows.get(answer.id);
      expect(answerRow.parts.filter(isTaskPart)).toHaveLength(1);
      expect(answerRow.parts.find(isTaskPart).task).toMatchObject({ taskId: taskIdForSession(CHILD), status: 'running', kind: 'session' });
      expect(answerRow.metadata.task).toMatchObject({ taskId: taskIdForSession(CHILD), status: 'running', childChatId: CHILD });
      // That turn's closing is NOT a hand-back — nothing to continue, no "confirm the card".
      expect(findHandback({ finalText: answerText, parts, deadlineHit: false, stepsUsed: 2, maxSteps: 8 })).toBeNull();
      expect(classifyRunEnd({ finalText: answerText })).toEqual({ kind: 'done' });

      // ── 3. The child run completes with the PDF: the hand-off posts ONE result on the parent ──
      const world = handoffWorld();
      const input: HandoffInput = {
        runId: 'run-deck-1', sessionId: CHILD, userId: USER, worktreeRoot: `/work/${CHILD}`, baseBranch: 'main',
        runStartedAt: new Date(T0),
        // The live-acceptance shape (12636e14, 06:46:32Z): the child LEADS with a heading and the container path.
        finalText: `Built the CQL DGX B300 deck: 14 slides.\n\n## Result\n\n**PDF (absolute path):** \`/work/${CHILD}/deck/cql-dgx-b300-deck.pdf\` (${PDF.length} bytes, 14 pages verified with pdfinfo).`,
        sessionTitle: SPAWN.title, triggerKind: 'user', now: new Date(T0 + 5 * 60_000),
      };
      const result = await runDeliverableHandoff(input, world.deps);
      expect(result).toMatchObject({ posted: true, targetChatId: PARENT, parentChatId: PARENT, files: 1, prs: 0, canvases: 0 });
      expect(result.artifacts).toEqual([{ name: 'deck/cql-dgx-b300-deck.pdf', bytes: PDF.length, url: expect.stringMatching(/^\/api\/crossmodel\/files\/file-[a-z0-9]+\/download$/), kind: 'file' }]);
      const parentRows = [...messageRows.values()].filter((r) => r.chatId === PARENT && r.role === 'assistant');
      expect(parentRows).toHaveLength(2); // the answer + ONE result message — never a second card row, never a narration
      const resultRow = parentRows.find((r) => r.id === result.resultMessageId)!;
      expect(resultRow.metadata).toMatchObject({ kind: HANDOFF_MESSAGE_KIND, origin: HANDOFF_MESSAGE_ORIGIN, harness: true, childChatId: CHILD });
      expect(resultRow.content).toContain(`**Result: ${SPAWN.title}**`);
      expect(resultRow.content).toContain(`[deck/cql-dgx-b300-deck.pdf](${result.artifacts[0].url})`);
      expect(resultRow.content).not.toMatch(/Files tab/i);
      // Hand-off polish (CT-3 / E17): the row LEADS with the artifacts list, then ONE paragraph with the path reduced to the file name.
      expect(resultRow.content.split('\n').slice(0, 4)).toEqual([`**Result: ${SPAWN.title}**`, '', '**Deliverables**', `- [deck/cql-dgx-b300-deck.pdf](${result.artifacts[0].url}) (${(PDF.length / 1024).toFixed(1)} KB)`]);
      expect(resultRow.content).not.toMatch(/\/work\/|absolute path|## Result/);
      expect(resultRow.content).toContain('Built the CQL DGX B300 deck: 14 slides. **PDF:** `cql-dgx-b300-deck.pdf`');
      expect(resultRow.content.indexOf('**Deliverables**')).toBeLessThan(resultRow.content.indexOf('Built the CQL DGX B300 deck'));
      // ONE card: the ANSWER row's running card flipped to done (preferCarrier), "Open result" → the result row.
      const doneCard = messageRows.get(answer.id).parts.filter(isTaskPart);
      expect(doneCard).toHaveLength(1);
      expect(doneCard[0].task).toMatchObject({ taskId: taskIdForSession(CHILD), status: 'done', kind: 'session', childChatId: CHILD, resultMessageId: result.resultMessageId, artifacts: [expect.objectContaining({ name: 'deck/cql-dgx-b300-deck.pdf', kind: 'file' })] });
      expect(messageRows.get(answer.id).metadata.task).toMatchObject({ status: 'done', resultMessageId: result.resultMessageId });
      expect(resultRow.parts ?? null).toBeNull(); // the result row carries no second card part
      expect(resultRow.metadata.task).toMatchObject({ taskId: taskIdForSession(CHILD), status: 'done' }); // the hand-off's seat (findSessionResult reads it)
      // The parent's live stream carried the done frame with the same taskId (running → done in place on the client).
      const taskFrames = stream.filter((e) => e.type === TASK_EVENT_TYPE).map((e) => parseTaskEvent(e.data)!);
      expect(taskFrames.map((t) => `${t.taskId}:${t.status}`)).toEqual([`${taskIdForSession(CHILD)}:running`, `${taskIdForSession(CHILD)}:done`]);
      expect(taskFrames[1].artifacts[0]).toMatchObject({ name: 'deck/cql-dgx-b300-deck.pdf', kind: 'file' });
      // The parent's hook wake is told the deliverables ALREADY landed (no re-post, no Files tab).
      expect(handoffHookNote(result)).toMatch(/\[DELIVERABLES ALREADY POSTED on chat .* deck\/cql-dgx-b300-deck\.pdf/);
      expect(handoffHookNote(result)).toMatch(/never send the user to the session's Files tab/);
      // Idempotent: a second finalize of the same run posts nothing.
      const again = await runDeliverableHandoff(input, world.deps);
      expect(again).toMatchObject({ skipped: 'already', posted: false });
      expect([...messageRows.values()].filter((r) => r.chatId === PARENT && r.role === 'assistant')).toHaveLength(2);

      // ── 4. Hand-off polish (CT-2 b / E17): the spawn turn's finalize, arriving AFTER the hand-off, sees the record and owes NO running card ──
      const record = world.records.get(CHILD)!;
      expect(record).toMatchObject({ runId: 'run-deck-1', targetChatId: PARENT, resultMessageId: result.resultMessageId, deduped: 0 });
      expect(spawnCardStillOwed(record, PARENT)).toBe(false); // the hand-off row IS the result — the card stays done
      expect(spawnCardStillOwed(null, PARENT)).toBe(true);    // before the hand-off: the running card as before
      expect(messageRows.get(answer.id).parts.filter(isTaskPart)[0].task.status).toBe('done'); // never regressed

      // ── 5. Hand-off polish (CT-1): the child's NEXT run re-writes the SAME bytes — nothing re-copied, the file is linked ──
      const rerun = await runDeliverableHandoff({ ...input, runId: 'run-deck-2', runStartedAt: new Date(T0 + 10 * 60_000), now: new Date(T0 + 15 * 60_000), triggerKind: 'schedule' }, world.deps);
      expect(rerun).toMatchObject({ posted: true, files: 1, deduped: 1, pruned: 0 });
      expect(world.persisted).toHaveLength(1); // ONE ChatFile row on the parent after two runs
      expect(rerun.artifacts[0].url).toBe(result.artifacts[0].url); // the SAME file id
      const rerunRow = messageRows.get(rerun.resultMessageId!);
      expect(rerunRow.content).toContain(`- [deck/cql-dgx-b300-deck.pdf](${result.artifacts[0].url}) (${(PDF.length / 1024).toFixed(1)} KB) — unchanged since the last hand-off`);
    } finally {
      endLiveRun(parentKey);
    }
  });

  it('the same ask on a MACHINE turn (no user anchor) still stages the card — the no-card rule is the human turn\'s', async () => {
    const out = await executePlatformTool({ ...humanCtx(), userTurnAt: undefined } as unknown as ToolContext, 'start_coding_session', { projectId: 'p1', title: SPAWN.title });
    const env = JSON.parse(out);
    expect(env.ok).toBe(false);
    expect(env.needsConfirmation).toBe(true);
    expect(mockConfirmations.rows).toHaveLength(1);
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(spawnedSessionsInParts([{ type: 'tool_result', name: 'start_coding_session', result: out }])).toEqual([]); // a staged envelope is never a spawn card
  });
});

describe('E2E 2 — the iMessage threads: hand-back detected → continuation armed → result posted, no "say the word"', () => {
  const OWNER_IMESSAGE = `I pulled the threads before tools cut off this run. Here is what I found in the three most recent conversations:

- Mum (yesterday): asked whether Sunday still works; you have not replied.
- Dave: sent the invoice PDF and a "thanks" — nothing pending.
- The school group: two reminders about the Friday form.

I did not get to her thread — say the word and I will search her thread next.`;
  const ASK = 'find the thread from Anna about the trip form';
  const CHAT = 'chat-imessage-0000-bbbb-cccc-000000000003';

  it('replays the transcript through the detector, the classifier, the arm, the rewrite, the card and the round result', async () => {
    const key = `chat:${CHAT}`;
    startLiveRun(key);
    const stream: Array<{ type: string; data: any }> = [];
    subscribeRun(key, (e) => stream.push(e));
    try {
      // ── The lint (E, observe-only) sees the hand-back; the classifier (B, the acting verdict) continues ──
      const finding = findHandback({ finalText: OWNER_IMESSAGE, parts: [{ type: 'text', text: OWNER_IMESSAGE }], deadlineHit: true, stepsUsed: 6, maxSteps: 6 });
      expect(finding).not.toBeNull();
      expect(finding!.phrase).toMatch(/say the word/i);
      expect(finding!.stoppedShort).toMatchObject({ deadlineHit: true, stagedCard: false });
      expect(finding!.externalCard).toBe(false);
      const verdict = classifyRunEnd({ finalText: OWNER_IMESSAGE, deadlineHit: true });
      expect(verdict).toMatchObject({ kind: 'continue', reason: 'deadline_mid_task' });

      // ── The finalize: the answer row, the rewrite, the arm on the SAME chat, the running card ──
      const enqueued: any[] = [];
      const answer = await messageStore.create({ data: { chatId: CHAT, role: 'assistant', content: OWNER_IMESSAGE, parts: [{ type: 'text', text: OWNER_IMESSAGE }], metadata: {} } });
      const stash = await armTurnContinuation(
        { chatId: CHAT, userId: USER, mode: 'thinking', reason: 'deadline_mid_task', askText: ASK, previousAnswer: OWNER_IMESSAGE, ofMessageId: answer.id },
        { enqueue: async (a) => { enqueued.push(a); return { id: `pend-${enqueued.length}` }; } },
      );
      expect(stash).toMatchObject({ round: 1, maxRounds: 3, reason: 'deadline_mid_task', ofMessageId: answer.id, askText: ASK });
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toMatchObject({ chatId: CHAT, userId: USER, mode: 'thinking', source: 'schedule', origin: { kind: 'schedule', continuation: stash } });
      expect(isContinuationPrompt(enqueued[0].content)).toBe(true);
      expect(parseContinuationRound(enqueued[0].content)).toMatchObject({ round: 1, taskId: stash!.taskId, ofMessageId: answer.id });
      expect(enqueued[0].content).toContain(`Original ask: "${ASK}"`);
      const rewritten = rewriteClosingText(OWNER_IMESSAGE);
      expect(rewritten.endsWith(CONTINUATION_LINE)).toBe(true);
      expect(rewritten).not.toMatch(/say the word/i);
      expect(rewritten).not.toMatch(/\?\s*$/);
      expect(rewritten).toContain('Mum (yesterday): asked whether Sunday still works'); // the partial result stays
      await messageStore.update({ where: { id: answer.id }, data: { content: rewritten, parts: [{ type: 'text', text: rewritten }] } });
      const runningCard = buildTaskEvent({ taskId: stash!.taskId, chatId: CHAT, kind: 'continuation', status: 'running', title: CONTINUATION_TASK_TITLE, startedAt: stash!.startedAt, note: 'Round 1 of 3 is running in the background.' });
      expect(await persistTaskCard(CHAT, runningCard, { messageId: answer.id })).toBe(answer.id);
      expect(emitTaskEvent(CHAT, runningCard)).toBe(true);
      expect(messageRows.get(answer.id).parts.find(isTaskPart).task).toMatchObject({ taskId: stash!.taskId, status: 'running', kind: 'continuation' });

      // ── The round: a machine run of the SAME chat posts the result and the card settles ──
      const RESULT = "Found it: Anna's thread has the trip form due Friday — she asked for the signed copy back by Thursday.";
      expect(classifyRunEnd({ finalText: RESULT })).toEqual({ kind: 'done' });
      expect(nextContinuationRound(stash!, classifyRunEnd({ finalText: RESULT }))).toEqual({ stop: 'done' });
      const resultRow = await messageStore.create({ data: { chatId: CHAT, role: 'assistant', content: RESULT, parts: [{ type: 'text', text: RESULT }], metadata: { kind: 'continuation_result', continuation: { taskId: stash!.taskId, round: 1, ofMessageId: answer.id } } } });
      const doneCard = buildTaskEvent({ ...runningCard, status: 'done', resultMessageId: resultRow.id, note: 'Finished in 1 background round.' });
      expect(await persistTaskCard(CHAT, doneCard, { messageId: stash!.ofMessageId })).toBe(answer.id);
      expect(emitTaskEvent(CHAT, doneCard)).toBe(true);
      const cards = messageRows.get(answer.id).parts.filter(isTaskPart);
      expect(cards).toHaveLength(1); // ONE card, running → done in place
      expect(cards[0].task).toMatchObject({ taskId: stash!.taskId, status: 'done', resultMessageId: resultRow.id });
      expect(stream.filter((e) => e.type === TASK_EVENT_TYPE).map((e) => e.data.status)).toEqual(['running', 'done']);
      // Nothing the user reads hands the work back.
      for (const r of [...messageRows.values()].filter((x) => x.chatId === CHAT)) expect(r.content).not.toMatch(/say the word|shall I|let me know if you want/i);
      expect(resultRow.metadata.origin).toBeUndefined(); // a visible assistant row, not machine noise
    } finally {
      endLiveRun(key);
    }
  });

  it('a genuine question (credentials) is left to the user: the classifier waits, the detector stays silent', () => {
    const q = 'I need the login credentials for the Xero account before I can pull the invoices — can you share them?';
    expect(classifyRunEnd({ finalText: q, deadlineHit: true })).toMatchObject({ kind: 'waiting_user', reason: 'credentials' });
    expect(findHandback({ finalText: q, parts: [], deadlineHit: true })).toBeNull();
  });
});
