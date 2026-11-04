/**
 * No permission card for REQUESTED WORK (cohesive chat experience).
 *
 * The rule (platform/work-tools.ts, applied in the consequential-tool gate):
 * a FRESH HUMAN ASK — a real user message anchors the run, the trigger is not
 * machine and the run is not a Dig-deeper rung — IS the authorization for the
 * work it asked for, so the tools that start / continue that work
 * (start_coding_session, configure_workspace, import_repo, create_feed, and
 * the schedule tools on THIS chat) execute directly: no staging, no card,
 * and the tool result tells the model where progress and the result land.
 * Cards stay for MACHINE turns (schedule / hook / agent / webhook — nothing
 * anchors authorization), for an ESCALATION rung, and for EXTERNAL-effect
 * tools on every turn.
 *
 * Pins:
 *   1. the table: every consequential tool is classified as work OR external,
 *      never both, never neither;
 *   2. human turn ⇒ a work tool executes, no pending row, the result carries
 *      the "not waiting on your click" note, a work_tool_direct metric row;
 *   3. machine turn (no anchor, or an executor-classified machine trigger)
 *      ⇒ the staged envelope exactly as today;
 *   4. external-effect tools ⇒ a card on BOTH turn kinds;
 *   5. the staging-time validation still runs first on the direct path;
 *   6. the own-chat scope for the schedule tools;
 *   7. WORK_TOOLS_NO_CARD_DISABLED=1 restores the card;
 *   8. (review fixer) the direct path stamps MODEL provenance on schedule
 *      rows (promptSetBy / initiator 'machine', no owner-subscription mark,
 *      the directive-conflict detector on) while the confirmed re-call keeps
 *      the owner stamps;
 *   9. (review fixer) the direct path is idempotent per ask — a repeat on the
 *      same anchor replays the first envelope, a failed first call releases
 *      the claim;
 *  10. (review fixer) a Dig-deeper rung (ctx.escalation) cards;
 *  11. (review fixer) import_repo / configure_workspace run directly only
 *      when the repo URL is in the user's own message (ctx.userTurnText);
 *  12. (review fixer) the note names the task card only when one renders
 *      (taskCardAvailable / TASK_CARD_DISABLED), else "posted in this chat".
 *
 * Mock stack mirrors platform-tools.b6acc1e3.test.ts (the service layer under
 * the tools is fully mocked — the gate's routing is what we pin).
 */

import { createPendingConfirmationTable } from './pending-confirmations.testkit';
import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockConfirmations = createPendingConfirmationTable();
const mockOwnerQuestions = createOwnerQuestionTable();

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    ownerQuestion: mockOwnerQuestions.api,
    crossModelMessage: mockOwnerQuestions.crossModelMessage,
    crossModelChat: mockOwnerQuestions.crossModelChat,
    telegramLink: { findUnique: async () => null },
  },
}));

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: async () => {},
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// In-memory context store: the dedupe claim (storeCreate is create-only).
const mockStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
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
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

const svc = {
  startCodingSession: jest.fn(),
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
  scheduleChatRun: jest.fn(async (input: any) => ({
    id: 'sched-1', sessionId: input.chatId, kind: input.kind, intervalSec: input.intervalSec, enabled: true,
    nextRunAt: new Date('2026-10-01T08:00:00Z'), runsCount: 0, maxRuns: input.maxRuns ?? null, prompt: input.prompt,
  })),
  listSchedules: jest.fn(async () => [
    { id: 'aaaaaaaa-1111-2222-3333-444455556666', sessionId: 'sess-1', enabled: true, promptSetBy: 'user', prompt: 'old prompt', kind: 'recurring', intervalSec: 3600 },
    { id: 'bbbbbbbb-1111-2222-3333-444455556666', sessionId: 'other-chat', enabled: true, promptSetBy: 'user', prompt: 'other', kind: 'recurring', intervalSec: 3600 },
  ]),
  cancelSchedule: jest.fn(async () => true),
  updateSchedule: jest.fn(async (input: any) => ({
    ok: true,
    schedule: {
      id: input.id, sessionId: 'sess-1', kind: 'recurring', intervalSec: input.intervalSec ?? 3600, enabled: true,
      nextRunAt: new Date('2026-10-01T08:00:00Z'), runsCount: 0, maxRuns: null, prompt: input.prompt ?? 'old prompt',
    },
  })),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const mockDirectiveConflict = jest.fn(async () => ({ conflict: false }));
jest.mock('./directive-conflict', () => ({
  __esModule: true,
  checkScheduleDirectiveConflict: (...a: any[]) => mockDirectiveConflict(...(a as [])),
}));

jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(),
}));
jest.mock('../fleet/fleet-telemetry', () => ({ __esModule: true, fleetTelemetry: jest.fn(async () => ({ ok: true })) }));
jest.mock('../feedback/closure-evidence', () => ({
  __esModule: true,
  verifyMachineCloseEvidence: jest.fn(async () => ({ ok: true, auditNote: '[machine-close evidence: test]', verified: ['commitSha'] })),
}));
const mockAudit = jest.fn(async () => {});
jest.mock('./autonomy.service', () => ({
  __esModule: true,
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async () => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: (...a: any[]) => mockAudit(...(a as [])),
}));
jest.mock('../upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(async () => null),
  combineAttachments: jest.fn((atts: any[]) => atts[0]),
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { WORK_TOOL_DIRECT: 'work_tool_direct', CONFIRMATION_STAGED: 'confirmation_staged', MACHINE_SCHEDULE_MUTATION: 'machine_schedule_mutation' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));
const mockCreateCodingProject = jest.fn(async (input: any) => ({ id: 'proj-new', name: input.name, repoUrl: input.repoUrl }));
jest.mock('../coding/coding-data.service', () => ({
  __esModule: true,
  resolveOneCodingPick: jest.fn(async (pick?: string) => (pick && ['glm-5.3', 'deepseek-flash', 'kimi-k3'].includes(pick) ? pick : null)),
  createCodingProject: (...a: any[]) => mockCreateCodingProject(...(a as [any])),
}));
jest.mock('../coding/project-workspace.service', () => ({
  __esModule: true,
  validateRepoUrl: jest.fn(() => null),
}));

import { executePlatformTool, CONSEQUENTIAL_PLATFORM_TOOLS } from './platform-tools';
import {
  WORK_TOOLS, EXTERNAL_EFFECT_TOOLS, CREDENTIAL_WORK_TOOLS, isHumanTurn, isFreshHumanAsk, isWorkTool, workToolInScope,
  appendWorkToolDirectNote, workToolDirectNote, taskCardAvailable, normalizeRepoUrl, repoUrlBoundToTurn,
  workToolDedupeKey, workToolClaimExpired, workToolReplayEnvelope, WORK_TOOL_DEDUPE_WINDOW_MS, WORK_TOOL_CLAIM_STALE_MS,
  spawnEnvelopeIsIdle,
} from './work-tools';
import type { ToolContext } from '../coding/tools';

const ANCHOR = new Date('2026-09-28T10:00:00Z');

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto', agentSurface: 'chat',
    emit: () => {}, alwaysAllow: new Set<string>(),
    userTurnAt: ANCHOR,
    requestApproval: async () => 'allow',
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}
const humanCtx = () => makeCtx();
const machineCtx = () => makeCtx({ userTurnAt: undefined });
/** An agent-origin send threads the sender's userTurnAt onto the target run — the executor flags it machine. */
const agentOriginCtx = () => makeCtx({ machineTriggered: true } as any);
/** A Dig-deeper rung: a human turn that re-runs the ORIGINAL ask with a new anchor. */
const escalationCtx = () => makeCtx({ escalation: true, userTurnAt: new Date() } as any);

const SPAWN = { id: 'sess-9', projectId: 'p1', title: 'Deck build', branch: 'digby/session-sess-9', baseBranch: 'main', model: 'glm-5.3', modelSource: null, permissionMode: 'auto' };

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  mockOwnerQuestions.reset();
  mockStore.clear();
  svc.startCodingSession.mockResolvedValue(SPAWN);
  delete process.env.WORK_TOOLS_NO_CARD_DISABLED;
  delete process.env.TASK_CARD_DISABLED;
});

const directMetric = () => mockRecordLoopMetric.mock.calls.filter((c) => c[0]?.kind === 'work_tool_direct' && !c[0]?.meta?.deduplicated);

describe('the table: work tools vs external-effect tools', () => {
  it('every consequential tool is classified as WORK or EXTERNAL — exactly one of the two', () => {
    for (const tool of CONSEQUENTIAL_PLATFORM_TOOLS) {
      const work = isWorkTool(tool);
      const external = EXTERNAL_EFFECT_TOOLS.has(tool);
      expect({ tool, work, external }).toEqual({ tool, work: !external, external: !work });
    }
    for (const tool of Object.keys(WORK_TOOLS)) expect(CONSEQUENTIAL_PLATFORM_TOOLS.has(tool)).toBe(true);
    for (const tool of EXTERNAL_EFFECT_TOOLS) expect(CONSEQUENTIAL_PLATFORM_TOOLS.has(tool)).toBe(true);
    for (const tool of CREDENTIAL_WORK_TOOLS) expect(isWorkTool(tool)).toBe(true);
  });

  it('the evidence tools are work; public exposure / cross-chat / authority tools are external', () => {
    expect(WORK_TOOLS.start_coding_session).toBe('any');
    expect(WORK_TOOLS.schedule_message).toBe('own_chat');
    expect(WORK_TOOLS.cancel_schedule).toBe('own_chat_schedule');
    for (const t of ['send_chat_message', 'create_share_link', 'set_chat_autonomy', 'share_project', 'add_project_member', 'create_chat_webhook', 'send_to_instance', 'dispatch_platform_task']) {
      expect(EXTERNAL_EFFECT_TOOLS.has(t)).toBe(true);
    }
  });

  it('isHumanTurn: an anchor AND not an executor-classified machine trigger; isFreshHumanAsk also excludes a Dig-deeper rung', () => {
    expect(isHumanTurn({ userTurnAt: new Date() })).toBe(true);
    expect(isHumanTurn({})).toBe(false);
    expect(isHumanTurn({ userTurnAt: undefined })).toBe(false);
    expect(isHumanTurn({ userTurnAt: new Date(), machineTriggered: true })).toBe(false);
    expect(isFreshHumanAsk({ userTurnAt: new Date() })).toBe(true);
    expect(isFreshHumanAsk({ userTurnAt: new Date(), escalation: true })).toBe(false);
    expect(isFreshHumanAsk({ userTurnAt: new Date(), machineTriggered: true })).toBe(false);
  });

  it('workToolInScope: any / own_chat / own_chat_schedule (exact id or unique ≥8-char prefix; a read failure is out of scope)', async () => {
    const rows = async () => [{ id: 'aaaaaaaa-1111-2222-3333-444455556666', sessionId: 'sess-1' }, { id: 'bbbbbbbb-1111-2222-3333-444455556666', sessionId: 'other' }];
    const ctx = { sessionId: 'sess-1' };
    expect(await workToolInScope('start_coding_session', { projectId: 'p1' }, ctx, rows)).toBe(true);
    expect(await workToolInScope('schedule_message', {}, ctx, rows)).toBe(true);
    expect(await workToolInScope('schedule_message', { chatId: 'sess-1' }, ctx, rows)).toBe(true);
    expect(await workToolInScope('schedule_message', { chatId: 'other' }, ctx, rows)).toBe(false);
    expect(await workToolInScope('cancel_schedule', { id: 'aaaaaaaa-1111-2222-3333-444455556666' }, ctx, rows)).toBe(true);
    expect(await workToolInScope('cancel_schedule', { id: 'aaaaaaaa' }, ctx, rows)).toBe(true);
    expect(await workToolInScope('cancel_schedule', { id: 'bbbbbbbb' }, ctx, rows)).toBe(false);
    expect(await workToolInScope('cancel_schedule', { id: 'aaaa' }, ctx, rows)).toBe(false);
    expect(await workToolInScope('cancel_schedule', {}, ctx, rows)).toBe(false);
    expect(await workToolInScope('cancel_schedule', { id: 'aaaaaaaa' }, ctx, async () => { throw new Error('db'); })).toBe(false);
    expect(await workToolInScope('send_chat_message', { chatId: 'sess-1' }, ctx, rows)).toBe(false);
  });

  it('appendWorkToolDirectNote rides the ok:true envelope message and leaves refusals / ok:false / plain strings untouched', () => {
    const out = JSON.parse(appendWorkToolDirectNote('start_coding_session', JSON.stringify({ ok: true, tool: 'start_coding_session', ids: { sessionId: 's' }, message: 'Started.' }), { taskCard: true }));
    expect(out.message).toContain('Started.');
    expect(out.message).toContain(workToolDirectNote('start_coding_session', { taskCard: true }));
    expect(out.message).toContain('task card');
    expect(out.message).toContain('never say it is waiting on their click');
    const refused = JSON.stringify({ ok: false, tool: 'cancel_schedule', reason: 'not_found', message: 'no such schedule' });
    expect(appendWorkToolDirectNote('cancel_schedule', refused)).toBe(refused);
    expect(appendWorkToolDirectNote('cancel_schedule', 'No such schedule "x".')).toBe('No such schedule "x".');
    expect(appendWorkToolDirectNote('cancel_schedule', '{not json')).toBe('{not json');
  });

  it('the note names the task card ONLY when one renders — otherwise "posted in this chat" (taskCardAvailable / TASK_CARD_DISABLED)', () => {
    expect(workToolDirectNote('start_coding_session', { taskCard: true })).toContain('progress shows on the task card in this chat');
    expect(workToolDirectNote('start_coding_session', { taskCard: false })).toContain('progress and the result are posted in this chat');
    expect(workToolDirectNote('start_coding_session', { taskCard: false })).not.toContain('task card');
    // schedule_message inherited the "each result is posted in this chat" note
    // from create_feed when the feeds subsystem was retired (43c24152).
    expect(workToolDirectNote('schedule_message', { taskCard: true })).toContain('under the same task card');
    expect(workToolDirectNote('schedule_message', { taskCard: false })).not.toContain('task card');
    expect(workToolDirectNote('import_repo', { taskCard: false })).not.toContain('task card');
    // the switch of the card module itself turns the sentence off regardless of the module's presence
    process.env.TASK_CARD_DISABLED = '1';
    expect(taskCardAvailable()).toBe(false);
    expect(workToolDirectNote('start_coding_session')).not.toContain('task card');
    delete process.env.TASK_CARD_DISABLED;
    // the default follows the module's presence in this build (a resolve probe, never an import)
    expect(typeof taskCardAvailable()).toBe('boolean');
    expect(workToolDirectNote('start_coding_session').includes('task card')).toBe(taskCardAvailable());
  });

  it('repoUrlBoundToTurn: the credential-spending tools bind their repo URL to the user\'s own message', () => {
    expect(normalizeRepoUrl('https://github.com/Acme/Widgets.git/')).toBe('github.com/acme/widgets');
    expect(normalizeRepoUrl('git@github.com:acme/widgets.git')).toBe('github.com/acme/widgets');
    expect(normalizeRepoUrl('https://www.gitlab.com/a/b')).toBe('gitlab.com/a/b');
    expect(repoUrlBoundToTurn({ repoUrl: 'https://github.com/acme/widgets' }, 'please import https://github.com/acme/widgets.git and build the deck')).toBe(true);
    expect(repoUrlBoundToTurn({ repoUrl: 'https://github.com/acme/widgets' }, 'import acme/widgets from github.com')).toBe(true);
    expect(repoUrlBoundToTurn({ repoUrl: 'https://github.com/acme/widgets' }, 'build me a deck')).toBe(false);
    expect(repoUrlBoundToTurn({ repoUrl: 'https://github.com/acme/widgets' }, undefined)).toBe(false);
    expect(repoUrlBoundToTurn({ repoUrl: 'https://github.com/acme/widgets' }, '')).toBe(false);
    // no URL (a Digby-owned local repo) binds trivially
    expect(repoUrlBoundToTurn({ projectId: 'p1' }, undefined)).toBe(true);
  });

  it('workToolDedupeKey: stable across key order / confirmationId / harness fields; distinct per anchor, tool, chat and args', () => {
    const base = { sessionId: 'sess-1', tool: 'start_coding_session', args: { projectId: 'p1', title: 'Deck build' }, userTurnAt: ANCHOR };
    const k = workToolDedupeKey(base);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(workToolDedupeKey({ ...base, args: { title: 'Deck build', projectId: 'p1', confirmationId: 'x', _substitutedFrom: 'y' } })).toBe(k);
    expect(workToolDedupeKey({ ...base, userTurnAt: new Date(ANCHOR.getTime() + 1000) })).not.toBe(k);
    expect(workToolDedupeKey({ ...base, tool: 'import_repo' })).not.toBe(k);
    expect(workToolDedupeKey({ ...base, sessionId: 'sess-2' })).not.toBe(k);
    expect(workToolDedupeKey({ ...base, args: { projectId: 'p1', title: 'Other' } })).not.toBe(k);
  });

  it('workToolClaimExpired: a recorded result holds for the window; a result-less claim is abandoned after the stale bound', () => {
    const now = Date.now();
    const at = new Date(now - 60_000).toISOString();
    expect(workToolClaimExpired({ at, result: '{"ok":true}' }, now)).toBe(false);
    expect(workToolClaimExpired({ at }, now)).toBe(false);
    expect(workToolClaimExpired({ at: new Date(now - WORK_TOOL_CLAIM_STALE_MS - 1).toISOString() }, now)).toBe(true);
    expect(workToolClaimExpired({ at: new Date(now - WORK_TOOL_DEDUPE_WINDOW_MS - 1).toISOString(), result: '{"ok":true}' }, now)).toBe(true);
    expect(workToolClaimExpired(null, now)).toBe(true);
    expect(workToolClaimExpired({ at: 'not-a-date', result: 'x' }, now)).toBe(true);
  });

  it('workToolReplayEnvelope keeps the first ok envelope and marks it deduplicated', () => {
    const out = JSON.parse(workToolReplayEnvelope('start_coding_session', JSON.stringify({ ok: true, tool: 'start_coding_session', ids: { sessionId: 'sess-9' }, message: 'Started' }), '2026-09-28T10:00:00.000Z'));
    expect(out).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' }, deduplicated: { firstAt: '2026-09-28T10:00:00.000Z' } });
    expect(out.message).toContain('Already started on this same ask');
    expect(out.message).toContain('sess-9');
    expect(out.message).toContain('executed NOTHING new');
  });
});

describe('start_coding_session on a HUMAN turn', () => {
  it('executes at once — no pending row, an ok:true envelope with the direct-execution note, a work_tool_direct metric', async () => {
    const out = await executePlatformTool(humanCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build', prompt: 'Build the deck' });
    const env = JSON.parse(out);
    expect(env).toMatchObject({ ok: true, tool: 'start_coding_session', ids: { sessionId: 'sess-9' } });
    expect(env.needsConfirmation).toBeUndefined();
    expect(env.message).toContain('Started coding session sess-9');
    expect(env.message).toMatch(/its progress (shows on the task card|and the result are posted) in this chat/);
    expect(env.message).toContain('NO confirmation card exists or is pending');
    expect(svc.startCodingSession).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', projectId: 'p1', title: 'Deck build' }));
    expect(mockConfirmations.rows).toHaveLength(0);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ tool: 'start_coding_session', chatId: 'sess-1', note: expect.stringContaining('work tool') }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct', sessionId: 'sess-1', meta: { tool: 'start_coding_session', origin: 'human', surface: 'chat' } }));
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirmation_staged' }));
  });

  it('the staging-time validation still runs first: an invalid model is refused, nothing spawned, nothing staged', async () => {
    const out = await executePlatformTool(humanCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build', model: 'gpt-4o' });
    expect(out).toContain('"gpt-4o"');
    expect(out).toContain('Nothing was staged');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockConfirmations.rows).toHaveLength(0);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct' }));
  });

  it('an ungrouped caller that omits projectId is still refused with the filing rule (no direct execution of a doomed spawn)', async () => {
    const out = await executePlatformTool(humanCtx(), 'start_coding_session', { title: 'Deck build' });
    expect(out).toMatch(/^start_coding_session REFUSED: this chat has no project/);
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });

  it('the coding surface executes too (the rule is about the turn, not the surface)', async () => {
    const out = await executePlatformTool(makeCtx({ agentSurface: 'coding', permissionMode: 'ask' } as any), 'start_coding_session', { projectId: 'p1', title: 'Deck build' });
    expect(JSON.parse(out)).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' } });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct', meta: expect.objectContaining({ surface: 'coding' }) }));
  });
});

describe('idempotency per ask (review fixer): a repeat on the SAME anchor replays the first envelope', () => {
  const args = { projectId: 'p1', title: 'Deck build', prompt: 'Build the deck' };

  it('a deploy requeue / orphan re-fire of the same human turn executes NOTHING new and returns the first result marked deduplicated', async () => {
    const first = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', args));
    expect(first).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' } });
    const again = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', { ...args, confirmationId: undefined }));
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    expect(again).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' }, deduplicated: { firstAt: expect.any(String) } });
    expect(again.message).toContain('Already started on this same ask');
    expect(again.message).not.toContain('NO confirmation card exists'); // the replay carries its own message, never a second "started"
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct', meta: expect.objectContaining({ deduplicated: true }) }));
    expect(directMetric()).toHaveLength(1);
  });

  it('a NEW user turn (different anchor) executes again; different args on the same anchor execute too', async () => {
    await executePlatformTool(humanCtx(), 'start_coding_session', args);
    await executePlatformTool(makeCtx({ userTurnAt: new Date(ANCHOR.getTime() + 60_000) }), 'start_coding_session', args);
    await executePlatformTool(humanCtx(), 'start_coding_session', { ...args, title: 'Other build' });
    expect(svc.startCodingSession).toHaveBeenCalledTimes(3);
  });

  it('a failed first execution releases the claim, so the retry executes', async () => {
    svc.startCodingSession.mockRejectedValueOnce(new Error('boom'));
    const first = await executePlatformTool(humanCtx(), 'start_coding_session', args).catch((e: any) => `threw: ${e?.message}`);
    expect(JSON.parse(first.startsWith('{') ? first : '{"ok":false}').ok).not.toBe(true);
    const second = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', args));
    expect(second).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' } });
    expect(second.deduplicated).toBeUndefined();
    expect(svc.startCodingSession).toHaveBeenCalledTimes(2);
  });

  it('a claim whose execution never recorded a result is abandoned after the stale bound (a process died mid-call) — the retry executes', async () => {
    const key = workToolDedupeKey({ sessionId: 'sess-1', tool: 'start_coding_session', args, userTurnAt: ANCHOR });
    mockStore.set(`chat/sess-1/work-tool-direct::${key}`, { at: new Date(Date.now() - WORK_TOOL_CLAIM_STALE_MS - 1000).toISOString(), tool: 'start_coding_session' });
    const out = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', args));
    expect(out).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' } });
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
  });

  it('a FRESH in-flight claim (a concurrent duplicate) executes nothing and says so', async () => {
    const key = workToolDedupeKey({ sessionId: 'sess-1', tool: 'start_coding_session', args, userTurnAt: ANCHOR });
    mockStore.set(`chat/sess-1/work-tool-direct::${key}`, { at: new Date().toISOString(), tool: 'start_coding_session' });
    const out = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', args));
    expect(out).toMatchObject({ ok: false, reason: 'duplicate_in_flight' });
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });

  it('a store failure is fail-open — the ask executes rather than wedging on the dedupe claim', async () => {
    const store = jest.requireMock('../memory/context-store');
    store.storeCreate.mockRejectedValueOnce(new Error('db down'));
    const out = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', args));
    expect(out).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' } });
    expect(svc.startCodingSession).toHaveBeenCalled();
  });
});

describe('a Dig-deeper rung (ctx.escalation) keeps the card (review fixer)', () => {
  it('the rung re-runs the ORIGINAL ask as a human turn — a work tool the first run executed must not run twice', async () => {
    const out = JSON.parse(await executePlatformTool(escalationCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build' }));
    expect(out).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockConfirmations.rows).toHaveLength(1);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct' }));
  });
});

describe('credential-spending work tools bind the repo URL to the user\'s own message (review fixer)', () => {
  const REPO = 'https://github.com/acme/widgets';

  it('import_repo executes directly when the URL is in ctx.userTurnText', async () => {
    const out = JSON.parse(await executePlatformTool(makeCtx({ userTurnText: `please import ${REPO} and set it up` } as any), 'import_repo', { repoUrl: REPO }));
    expect(out).toMatchObject({ ok: true, tool: 'import_repo', ids: { projectId: 'proj-new' } });
    expect(out.message).toContain('NO confirmation card exists');
    expect(mockCreateCodingProject).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', repoUrl: REPO }));
    expect(mockConfirmations.rows).toHaveLength(0);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct', meta: expect.objectContaining({ tool: 'import_repo' }) }));
  });

  it('… but STAGES the card when the user\'s message does not name that URL (a scraped page / document asked for it), and when no turn text is threaded', async () => {
    const injected = JSON.parse(await executePlatformTool(makeCtx({ userTurnText: 'summarize this page for me' } as any), 'import_repo', { repoUrl: REPO }));
    expect(injected).toMatchObject({ ok: false, needsConfirmation: true });
    const noText = JSON.parse(await executePlatformTool(humanCtx(), 'import_repo', { repoUrl: REPO }));
    expect(noText).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockCreateCodingProject).not.toHaveBeenCalled();
    expect(mockConfirmations.rows).toHaveLength(2);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct' }));
  });

  it('start_coding_session is not URL-bound (its project was already configured by the user)', async () => {
    const out = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build' }));
    expect(out).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' } });
  });
});

describe('MACHINE turns keep the card', () => {
  it('no anchor (schedule / hook firing) ⇒ the staged envelope exactly as today', async () => {
    const out = await executePlatformTool(machineCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build' });
    const reg = JSON.parse(out);
    expect(reg).toMatchObject({ ok: false, needsConfirmation: true });
    expect(typeof reg.confirmationId).toBe('string');
    expect(reg.instructions).toContain('needs THEIR explicit confirmation');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockConfirmations.rows).toHaveLength(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'confirmation_staged', meta: expect.objectContaining({ tool: 'start_coding_session', machine: true }) }));
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct' }));
  });

  it('an agent-origin run that carries the sender\'s anchor but is executor-classified machine ⇒ card', async () => {
    const out = await executePlatformTool(agentOriginCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build' });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.startCodingSession).not.toHaveBeenCalled();
  });

  it('the confirmed re-call from a NEW user turn still executes the STAGED args (WYSIWYG unchanged)', async () => {
    const first = JSON.parse(await executePlatformTool(machineCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build' }));
    const out = await executePlatformTool(makeCtx({ userTurnAt: new Date(Date.now() + 60_000) }), 'start_coding_session', { confirmationId: first.confirmationId, projectId: 'HACKED' });
    expect(JSON.parse(out)).toMatchObject({ ok: true, ids: { sessionId: 'sess-9' } });
    expect(svc.startCodingSession).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', title: 'Deck build' }));
    // a confirmed call is not the direct path — no direct note, no work_tool_direct row
    expect(JSON.parse(out).message).not.toContain('NO confirmation card exists');
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct' }));
  });
});

describe('EXTERNAL-effect tools card on both turn kinds', () => {
  it('set_chat_autonomy (authority) and send_chat_message to ANOTHER chat stage on a human turn', async () => {
    const grant = JSON.parse(await executePlatformTool(humanCtx(), 'set_chat_autonomy', { chatId: 'other-chat', allowedTools: ['send_chat_message'] }));
    expect(grant).toMatchObject({ ok: false, needsConfirmation: true });
    const send = JSON.parse(await executePlatformTool(humanCtx(), 'send_chat_message', { chatId: 'other-chat', content: 'hi' }));
    expect(send).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockConfirmations.rows).toHaveLength(2);
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct' }));
  });

  it('… and on a machine turn', async () => {
    const send = JSON.parse(await executePlatformTool(machineCtx(), 'send_chat_message', { chatId: 'other-chat', content: 'hi' }));
    expect(send).toMatchObject({ ok: false, needsConfirmation: true });
  });
});

describe('schedule tools: own-chat scope + MODEL provenance on the direct path (review fixer)', () => {
  it('schedule_message on THIS chat (chatId omitted) executes on a human turn — stamped promptSetBy \'machine\' and SUBSCRIBED (an accepted offer delivers, 2026-10-16); a foreign target stages', async () => {
    const own = JSON.parse(await executePlatformTool(humanCtx(), 'schedule_message', { prompt: 'check the deck build', kind: 'recurring', intervalMinutes: 60 }));
    expect(own).toMatchObject({ ok: true, tool: 'schedule_message', ids: { scheduleId: 'sched-1', chatId: 'sess-1' } });
    expect(own.message).toContain('posted in this chat as a message');
    expect(svc.scheduleChatRun).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'sess-1', promptSetBy: 'machine' }));
    // The person on this turn accepted the watch — its findings are delivered to them (provenance stays 'machine').
    expect(svc.scheduleChatRun.mock.calls[0][0].ownerSubscribed).toBe(true);
    const foreign = JSON.parse(await executePlatformTool(humanCtx(), 'schedule_message', { chatId: 'other-chat', prompt: 'x', kind: 'once', intervalMinutes: 60 }));
    expect(foreign).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.scheduleChatRun).toHaveBeenCalledTimes(1);
  });

  it('the accepted-offer subscription honours an explicit false and the kill switch (2026-10-16)', async () => {
    await executePlatformTool(humanCtx(), 'schedule_message', { prompt: 'quiet one', kind: 'recurring', intervalMinutes: 60, ownerSubscribed: false });
    expect(svc.scheduleChatRun.mock.calls[0][0].ownerSubscribed).toBe(false);
    process.env.WORK_TOOL_SCHEDULE_SUBSCRIBED_DISABLED = '1';
    try {
      await executePlatformTool(humanCtx(), 'schedule_message', { prompt: 'again', kind: 'recurring', intervalMinutes: 60 });
      expect(svc.scheduleChatRun.mock.calls[1][0].ownerSubscribed).toBeUndefined();
    } finally {
      delete process.env.WORK_TOOL_SCHEDULE_SUBSCRIBED_DISABLED;
    }
  });

  it('the CONFIRMED re-call keeps the owner stamps (promptSetBy \'user\', ownerSubscribed honoured) — the owner saw the card', async () => {
    const staged = JSON.parse(await executePlatformTool(machineCtx(), 'schedule_message', { prompt: 'daily digest', kind: 'recurring', intervalMinutes: 1440 }));
    expect(staged).toMatchObject({ ok: false, needsConfirmation: true });
    const out = JSON.parse(await executePlatformTool(makeCtx({ userTurnAt: new Date(Date.now() + 60_000) }), 'schedule_message', { confirmationId: staged.confirmationId }));
    expect(out).toMatchObject({ ok: true, ids: { scheduleId: 'sched-1' } });
    expect(svc.scheduleChatRun).toHaveBeenCalledWith(expect.objectContaining({ promptSetBy: 'user', ownerSubscribed: true }));
  });

  it('cancel_schedule of a row that belongs to THIS chat executes on a human turn with initiator \'machine\'; another chat\'s row stages; a machine turn stages', async () => {
    const own = JSON.parse(await executePlatformTool(humanCtx(), 'cancel_schedule', { id: 'aaaaaaaa-1111-2222-3333-444455556666' }));
    expect(own).toMatchObject({ ok: true, tool: 'cancel_schedule' });
    expect(svc.cancelSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'aaaaaaaa-1111-2222-3333-444455556666', initiator: 'machine' }));
    const other = JSON.parse(await executePlatformTool(humanCtx(), 'cancel_schedule', { id: 'bbbbbbbb-1111-2222-3333-444455556666' }));
    expect(other).toMatchObject({ ok: false, needsConfirmation: true });
    // machine turn on the own row: the machine self-cancel exception needs
    // promptSetBy 'machine' — this row is owner-armed, so it stages as today.
    const machine = JSON.parse(await executePlatformTool(machineCtx(), 'cancel_schedule', { id: 'aaaaaaaa-1111-2222-3333-444455556666' }));
    expect(machine).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.cancelSchedule).toHaveBeenCalledTimes(1);
  });

  it('update_schedule of an own-chat row executes on a human turn as a MODEL rewrite — promptSetBy \'machine\', the directive-conflict detector runs, the self-declared ownerSubscribed flag is ignored', async () => {
    const out = JSON.parse(await executePlatformTool(humanCtx(), 'update_schedule', { id: 'aaaaaaaa-1111-2222-3333-444455556666', prompt: 'new prompt', ownerSubscribed: true }));
    expect(out).toMatchObject({ ok: true, tool: 'update_schedule' });
    expect(svc.updateSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'aaaaaaaa-1111-2222-3333-444455556666', prompt: 'new prompt', promptSetBy: 'machine' }));
    expect(svc.updateSchedule.mock.calls[0][0].ownerSubscribed).toBeUndefined();
    expect(mockDirectiveConflict).toHaveBeenCalledWith(expect.objectContaining({ scheduleId: 'aaaaaaaa-1111-2222-3333-444455556666', oldPrompt: 'old prompt', newPrompt: 'new prompt' }));
    expect(mockConfirmations.rows).toHaveLength(0);
  });
});

describe('kill switch', () => {
  it('WORK_TOOLS_NO_CARD_DISABLED=1 restores the card for a work tool on a human turn', async () => {
    process.env.WORK_TOOLS_NO_CARD_DISABLED = '1';
    const out = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build' }));
    expect(out).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'work_tool_direct' }));
  });
});

// audit 2026-10-06 T5-2 (ticket 2bae9728, stanne #2): a prompt-less, charter-
// less spawn has no run — the direct note must never say the work started.
describe('audit 2026-10-06 T5-2 — an IDLE spawn is never narrated as started', () => {
  afterEach(() => { delete process.env.SPAWN_CHARTER_FIRST_PROMPT_DISABLED; });

  it('no prompt + no charter on a human turn: ids.firstPrompt none, the envelope says IDLE, the note forbids "the work has started"', async () => {
    const env = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build' }));
    expect(env).toMatchObject({ ok: true, ids: { sessionId: 'sess-9', firstPrompt: 'none' } });
    expect(env.message).toContain('the session was created IDLE');
    expect(env.message).toContain('never say the work has started');
    expect(env.message).not.toContain('Tell the user in one line that the work has started');
    expect(svc.startCodingSession).toHaveBeenCalledWith(expect.not.objectContaining({ prompt: expect.anything() }));
  });

  it('with a prompt: firstPrompt given and the started note as before', async () => {
    const env = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build', prompt: 'Build the deck' }));
    expect(env.ids.firstPrompt).toBe('given');
    expect(env.message).toContain('Tell the user in one line that the work has started');
  });

  it('kill switch SPAWN_CHARTER_FIRST_PROMPT_DISABLED=1: no firstPrompt id, no IDLE line, the old started note', async () => {
    process.env.SPAWN_CHARTER_FIRST_PROMPT_DISABLED = '1';
    const env = JSON.parse(await executePlatformTool(humanCtx(), 'start_coding_session', { projectId: 'p1', title: 'Deck build' }));
    expect(env.ids.firstPrompt).toBeUndefined();
    expect(env.message).not.toContain('IDLE');
    expect(env.message).toContain('Tell the user in one line that the work has started');
  });

  it('spawnEnvelopeIsIdle reads the parsed, the string and a clipped envelope; workToolDirectNote(idle) never claims a start', () => {
    expect(spawnEnvelopeIsIdle({ ok: true, ids: { firstPrompt: 'none' } })).toBe(true);
    expect(spawnEnvelopeIsIdle(JSON.stringify({ ok: true, ids: { firstPrompt: 'charter' } }))).toBe(false);
    expect(spawnEnvelopeIsIdle('{"ok":true,"ids":{"sessionId":"s","firstPrompt":"none"},"message":"Started cod')).toBe(true);
    expect(spawnEnvelopeIsIdle({ ok: false, ids: { firstPrompt: 'none' } })).toBe(false);
    const note = workToolDirectNote('start_coding_session', { taskCard: true, idle: true });
    expect(note).toContain('created IDLE');
    expect(note).not.toContain('Tell the user in one line that the work has started');
  });
});
