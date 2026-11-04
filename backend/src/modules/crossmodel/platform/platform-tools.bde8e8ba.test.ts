/**
 * Replay/regression tests for feedback ticket bde8e8ba (bug_report, priority-1,
 * 2026-09-17): "schedule_get returns 'No such schedule' for a row list_schedules
 * shows as active (c61c68ff)".
 *
 * ADJUDICATION (2026-09-17, session d4ab649b): NOT a platform bug — a corrupted
 * near-miss id. The incident call passed
 *   'c61c68ff-ed4b-48fe-8c73-7fafe5a677a'   (35 chars — an 11-char final group)
 * while the row's real id is
 *   'c61c68ff-ed4b-48fe-8c73-f7fafe5a677a' (one 'f' dropped in transcription).
 * A mangled id is neither the exact id nor a PREFIX of it, so "No such
 * schedule" was the CORRECT answer. schedule_get reads the SAME
 * platform.listSchedules({ userId }) result that list_schedules renders
 * (platform-tools.ts schedule_get case) — a list-vs-get store split is
 * impossible by construction, so only an id mismatch can diverge. Verified
 * live during adjudication: the corrected full id AND the bare 8-char prefix
 * both resolve the row; the malformed id fails on this run and on the
 * incident run.
 *
 * Scoped hardening pinned here: the not-found error now tells the caller when
 * its OWN input is not the full 36-char id shape (computed from the caller's
 * input alone — it leaks nothing about which ids exist), so a future
 * transcription slip surfaces as "your id looks altered" instead of sending
 * the lane hunting a phantom row-level ownership bug.
 */

import { createHash } from 'crypto';
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

beforeEach(() => { mockConfirmations.reset(); mockOwnerQuestions.reset(); });

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

// Service layer under the tools — fully mocked; the read-path mapping is what
// these tests pin. Only listSchedules is exercised here, but the full key set
// is mirrored from platform-tools.test.ts so module-scope imports resolve.
const svc = {
  listChats: jest.fn(),
  createChat: jest.fn(),
  getChatStatus: jest.fn(),
  getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(),
  suggestChatsByIdPrefix: jest.fn(),
  getOwnChatDeletion: jest.fn(),
  renameChat: jest.fn(),
  archiveChat: jest.fn(),
  moveChat: jest.fn(),
  deleteChat: jest.fn(),
  convertChatToCoding: jest.fn(),
  createProject: jest.fn(),
  getProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  moveFolder: jest.fn(),
  startCodingSession: jest.fn(),
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
  scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(),
  getSchedule: jest.fn(async (): Promise<any> => null),
  cancelSchedule: jest.fn(),
  deafLaneWarning: jest.fn(async (): Promise<string | null> => null),
};
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read',
    'chats:write',
    'folders:read',
    'folders:write',
    'schedules:write',
    'code:run',
  ] as const,
}));

jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  getFeedbackTicketById: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

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
import type { CodingSessionTarget } from './platform.service';
import { ToolContext } from '../coding/tools';

function makeCtx(): ToolContext {
  return {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    userTurnAt: new Date(),
    requestApproval: async () => 'allow',
    execShell: async () => ({ stdout: '', stderr: '' }),
  } as unknown as ToolContext;
}

describe('schedule_get id resolution — ticket bde8e8ba replay (corrupted near-miss id)', () => {
  const ctx = makeCtx();
  /** The row's REAL id (from the live list_schedules row, chat cec340f2). */
  const REAL_ID = 'c61c68ff-ed4b-48fe-8c73-f7fafe5a677a';
  /** The id the incident call actually passed: 35 chars, 11-char final group — one 'f' dropped. */
  const CORRUPTED_ID = 'c61c68ff-ed4b-48fe-8c73-7fafe5a677a';
  const row = {
    id: REAL_ID, sessionId: 'cec340f2-f605-4370-b87a-d85b59cb243f',
    kind: 'recurring', intervalSec: 3600, enabled: true, nextRunAt: '2026-09-17T06:07:36.000Z',
    runsCount: 8, maxRuns: 48, lastStatus: 'started', prompt: 'D2 build monitor prompt body',
  };

  beforeEach(() => {
    svc.listSchedules.mockReset();
    svc.listSchedules.mockResolvedValue([row]);
  });

  it('REPLAY: list_schedules shows the row while schedule_get on the corrupted incident id finds nothing — the reported combination, explained by the id alone', async () => {
    const list = await executePlatformTool(ctx, 'list_schedules', {});
    expect(list).toContain(`- ${REAL_ID} [active] recurring every 60m · chat cec340f2-f605-4370-b87a-d85b59cb243f`);

    const get = await executePlatformTool(ctx, 'schedule_get', { id: CORRUPTED_ID });
    expect(get).toMatch(/No such schedule/);
    // Nothing about the real row leaks through the failed lookup.
    expect(get).not.toContain('STORED PROMPT');
    expect(get).not.toContain('D2 build monitor');
  });

  it('the corrupted id is not the 8-4-4-4-12 shape — the error says the id itself looks altered instead of implying an ownership denial', async () => {
    expect(CORRUPTED_ID.length).toBe(35); // the incident artifact: one char short of a full id
    const get = await executePlatformTool(ctx, 'schedule_get', { id: CORRUPTED_ID });
    expect(get).toContain('not the full 36-character id');
    expect(get).toContain('re-copy the id verbatim');
    expect(get).toMatch(/owner-scoped/);
  });

  it('the CORRECT full id resolves the same row the list shows (the live adjudication probe)', async () => {
    const get = await executePlatformTool(ctx, 'schedule_get', { id: REAL_ID });
    expect(get).toContain(`Schedule ${REAL_ID} [active] recurring every 60m · chat cec340f2-f605-4370-b87a-d85b59cb243f`);
    expect(get).toContain(`promptSha256: ${createHash('sha256').update(row.prompt, 'utf8').digest('hex')}`);
    expect(get).toContain('--- STORED PROMPT (verbatim) ---\n' + row.prompt);
  });

  it('the bare 8-char prefix resolves the same row (the citation style the drift checks use)', async () => {
    const get = await executePlatformTool(ctx, 'schedule_get', { id: 'c61c68ff' });
    expect(get).toContain(`Schedule ${REAL_ID} [active]`);
    expect(get).toContain(row.prompt);
  });

  it('a well-formed but UNKNOWN full id keeps the plain owner-scoped message — no shape hint, no existence-leak distinction', async () => {
    const get = await executePlatformTool(ctx, 'schedule_get', { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(get).toMatch(/No such schedule/);
    expect(get).toMatch(/owner-scoped/);
    expect(get).not.toContain('not the full 36-character id');
    expect(get).not.toContain('STORED PROMPT');
  });

  it('a sub-8-char fragment stays exact-only and also earns the shape hint (MIN_SCHEDULE_ID_PREFIX_LEN contract)', async () => {
    const get = await executePlatformTool(ctx, 'schedule_get', { id: 'c61c' });
    expect(get).toMatch(/No such schedule/);
    expect(get).toContain('not the full 36-character id');
  });
});

describe('schedule_get direct lookup — ticket 03aef0da (a [FLEET ATTENTION] id past the listing window)', () => {
  const ctx = makeCtx();
  // The incident row: enabled when the Fleet Supervisor's 22:50Z wake computed
  // the block, owner-cancelled at 23:08Z, created 2026-09-28 — older than the
  // listing's newest-100 terminal rows, so schedule_get("c461c912") dead-ended.
  const STOPPED = {
    id: 'c461c912-8a2d-441e-a52a-ff2f9a9d9d69', sessionId: '810c924d-1d31-428c-bc6a-8120c132fcc4',
    kind: 'recurring', intervalSec: 2700, enabled: false, nextRunAt: '2026-10-06T00:09:17.128Z',
    runsCount: 57, maxRuns: 500, lastStatus: 'cancelled', cancelledBy: 'owner', disabledAt: '2026-10-05T23:08:30.218Z',
    promptSetBy: 'machine', prompt: '[tt-rd Supervisor] sweep prompt body',
  };

  beforeEach(() => {
    svc.listSchedules.mockReset().mockResolvedValue([]); // aged out of the listing
    svc.getSchedule.mockReset().mockResolvedValue(null);
    delete process.env.SCHEDULE_GET_DIRECT_LOOKUP_DISABLED;
  });

  it('REPLAY: the 8-char prefix AND the full id resolve the stopped row directly — [stopped], cancelled by owner', async () => {
    svc.getSchedule.mockResolvedValue(STOPPED);
    for (const id of ['c461c912', STOPPED.id]) {
      const get = await executePlatformTool(ctx, 'schedule_get', { id });
      expect(get).toContain(`Schedule ${STOPPED.id} [stopped] recurring every 45m · chat ${STOPPED.sessionId}`);
      expect(get).toContain('cancelled by owner at 2026-10-05T23:08:30.218Z');
      expect(get).toContain('armed by: machine');
      expect(get).not.toMatch(/No such schedule/);
    }
    expect(svc.getSchedule).toHaveBeenCalledWith({ userId: 'u1', id: STOPPED.id });
  });

  it('an ambiguous prefix surfaces the candidates (never a guess)', async () => {
    svc.getSchedule.mockRejectedValue(new Error('Ambiguous schedule id prefix "c461c912" — matches 2 of your schedules: a, b. Pass the full id.'));
    const get = await executePlatformTool(ctx, 'schedule_get', { id: 'c461c912' });
    expect(get).toMatch(/^Ambiguous schedule id prefix "c461c912"/);
  });

  it('nothing found anywhere keeps the owner-scoped not-found message', async () => {
    const get = await executePlatformTool(ctx, 'schedule_get', { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
    expect(get).toMatch(/No such schedule/);
  });

  it('SCHEDULE_GET_DIRECT_LOOKUP_DISABLED=1 restores listing-only', async () => {
    process.env.SCHEDULE_GET_DIRECT_LOOKUP_DISABLED = '1';
    svc.getSchedule.mockResolvedValue(STOPPED);
    const get = await executePlatformTool(ctx, 'schedule_get', { id: STOPPED.id });
    expect(get).toMatch(/No such schedule/);
    expect(svc.getSchedule).not.toHaveBeenCalled();
    delete process.env.SCHEDULE_GET_DIRECT_LOOKUP_DISABLED;
  });
});
