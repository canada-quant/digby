/**
 * Ticket 9a027713 — placeholder-arg guard at the dispatch_platform_task
 * seam, end-to-end through executePlatformTool (ticket-dispatch + feedback +
 * goals services mocked at their dynamic-import boundaries; prisma at
 * config/database — the 03587322 / e580b601 scaffolding discipline).
 *
 * The 2026-09-26 23:42:13Z incident (crossmodel supervisor chat daee2916,
 * msg fb9734b8 owns the filing): a malformed dispatch_platform_task call —
 * title "test", description "description placeholder" — passed the seam's
 * non-empty check, the admin degrade (lane send failed) faithfully filed it
 * as a REAL triage ticket (9a027713, type enhancement, source agent), and
 * the owner-ordered burn-down drain then dispatched it to a full coding
 * session. 4th sighting of the 2026-09-20 placeholder-emission dispatch-loop
 * class (f839cede / aff1c189 / ec9d7424 — model-authored placeholder ids on
 * update_feedback), now on a sibling seam.
 *
 * Pinned behavior:
 *   (i)   the VERBATIM incident args (title "test", description
 *         "description placeholder") are REFUSED with ok:false prose — no
 *         lane dispatch, no ticket filed, no admin check consumed;
 *   (ii)  the guard fires on either field (placeholder title, real
 *         description — and vice versa), and on the admin lane path too
 *         (sent:true — the guard is upstream of the admin check);
 *   (iii) exact-normalized matching: a real title that CONTAINS the token
 *         passes ("test the STT pipeline", "Self-host whisper", "Dark mode
 *         please" — the fleet-suite fixtures must keep flowing through);
 *   (iv)  the ok:false shape parses as NOT-executed for the claim-evidence
 *         extractor (the "NOT dispatched" prefix), and the schema
 *         description now teaches the requirement;
 *   (v)   the truth table: bare tokens refuse; punctuation/case/whitespace
 *         variants of a placeholder refuse; substantive briefs pass.
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
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: ['chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run'] as const,
}));
jest.mock('./platform.service', () => ({
  __esModule: true,
  startCodingSession: jest.fn(),
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
// crossmodel.service pulls the model-integration/env chains — mock the boundary.
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn(async () => ({ access: 'owner', exists: true })) },
}));

// The feedback service under the degrade path — fully mocked (member-by-member,
// the fleet-suite idiom; FEEDBACK_TYPES mirrors the real constant).
const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// The platform-engineering lane dispatch — fully mocked (dynamic import).
const laneSvc = {
  dispatchTaskToLane: jest.fn(async (): Promise<any> => ({ sent: true })),
};
jest.mock('../feedback/ticket-dispatch.service', () => ({ __esModule: true, ...laneSvc }));

// The DB-persisted confirmation registry (pending-confirmations.ts).
const { createPendingConfirmationTable } = require('./pending-confirmations.testkit');
const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({ __esModule: true, default: { pendingConfirmation: mockConfirmations.api } }));

// autonomy.service under the consequential gate — fully mocked.
const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule', 'dispatch_platform_task'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async (): Promise<any> => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

import { executePlatformTool, PLATFORM_TOOL_SCHEMA, placeholderDispatchRefusal } from './platform-tools';
import { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return ctx;
}

/** The verbatim incident args (ticket 9a027713 context + chat daee2916's own disclosure). */
const INCIDENT_TITLE = 'test';
const INCIDENT_DESCRIPTION = 'description placeholder';

describe('ticket 9a027713 — placeholder-arg guard on dispatch_platform_task', () => {
  beforeEach(() => {
    laneSvc.dispatchTaskToLane.mockReset().mockResolvedValue({ sent: true });
    fb.isAdminUser.mockReset().mockResolvedValue(true); // the incident caller was ADMIN
    fb.fileFeedbackTicket.mockReset().mockResolvedValue({
      deduped: false,
      ticket: { id: 'fb-1', type: 'enhancement', title: 't', priority: 0 },
    });
    autonomySvc.getChatAutonomy.mockReset().mockResolvedValue({ allowedTools: ['dispatch_platform_task'], scheduleCap: 48 });
  });

  it('(i) the VERBATIM incident replay: title "test" + description "description placeholder" is refused — no lane call, no ticket, no admin check', async () => {
    // The incident shape: admin caller, surface 'chat', machine run with grant
    // (the crossmodel supervisor at 23:42Z). The guard must fire BEFORE the
    // admin check — junk must not consume the admin lookup or file anything.
    const ctx = makeCtx({ agentSurface: 'chat', projectId: 'e5734bd2' } as any);
    const out = await executePlatformTool(ctx, 'dispatch_platform_task', {
      title: INCIDENT_TITLE,
      description: INCIDENT_DESCRIPTION,
    });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: false, tool: 'dispatch_platform_task' });
    expect(parsed.message).toContain('NOT dispatched');
    expect(parsed.message).toContain('placeholder');
    // never claims anything was filed or dispatched (the incident's junk ticket shape)
    expect(parsed.message).not.toMatch(/fb-\d|is in the triage queue|Dispatched to the platform-engineering lane/);
    // NOTHING executed:
    expect(laneSvc.dispatchTaskToLane).not.toHaveBeenCalled();
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
    expect(fb.isAdminUser).not.toHaveBeenCalled(); // upstream of the admin check
  });

  it('(i-b) the admin lane path is guarded too: sent:true never receives junk args', async () => {
    const out = await executePlatformTool(makeCtx(), 'dispatch_platform_task', {
      title: 'Fix STT',
      description: 'placeholder',
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('description "placeholder"');
    expect(laneSvc.dispatchTaskToLane).not.toHaveBeenCalled();
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('(ii) the guard fires on either field, with the field named in the refusal', async () => {
    const titleSide = await executePlatformTool(makeCtx(), 'dispatch_platform_task', {
      title: 'TBD',
      description: 'Self-host whisper for the ASR seat',
    });
    expect(JSON.parse(titleSide).message).toContain('title "TBD"');

    const descSide = await executePlatformTool(makeCtx(), 'dispatch_platform_task', {
      title: 'Fix the ASR seat routing',
      description: 'lorem ipsum',
    });
    expect(JSON.parse(descSide).message).toContain('description "lorem ipsum"');
    expect(laneSvc.dispatchTaskToLane).not.toHaveBeenCalled();
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();
  });

  it('(iii) exact-match only: real briefs CONTAINING the tokens flow through to the lane unchanged (fixtures from platform-tools.fleet.test.ts)', async () => {
    const out = await executePlatformTool(makeCtx(), 'dispatch_platform_task', {
      title: 'Fix STT',
      description: 'Self-host whisper',
    });
    const parsed = JSON.parse(out);
    expect(parsed).toMatchObject({ ok: true, tool: 'dispatch_platform_task' });
    expect(laneSvc.dispatchTaskToLane).toHaveBeenCalledWith({
      sourceLabel: 'dispatch_platform_task',
      title: 'Fix STT',
      body: 'Self-host whisper',
    });
    expect(fb.fileFeedbackTicket).not.toHaveBeenCalled();

    const contains = await executePlatformTool(makeCtx(), 'dispatch_platform_task', {
      title: 'Test the STT pipeline end to end',
      description: 'Regression: the placeholder text in the transcription card renders raw',
    });
    expect(JSON.parse(contains).ok).toBe(true);

    const theme = await executePlatformTool(makeCtx(), 'dispatch_platform_task', {
      title: 'Please add themes',
      description: 'Dark mode please',
    });
    expect(JSON.parse(theme).ok).toBe(true);
  });

  it('(iv) the refusal shape parses as NOT-executed (claim-evidence discipline) and the schema teaches the requirement', async () => {
    const out = await executePlatformTool(makeCtx(), 'dispatch_platform_task', {
      title: 'test',
      description: 'description placeholder',
    });
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false); // never an ok-receipt for a refused call
    expect(parsed.message).toMatch(/^NOT dispatched/);

    const entry = PLATFORM_TOOL_SCHEMA.find((t) => t.function.name === 'dispatch_platform_task');
    expect(entry).toBeDefined();
    expect(entry!.function.description).toMatch(/placeholder/i);
    // Layered prompts 2026-09-27: the ticket id left the model-facing text (a
    // `// provenance:` comment on the schema line carries it).
    expect(entry!.function.description).not.toMatch(/9a027713/);
  });

  it('(v) truth table: normalization (case/punctuation/whitespace) and the observed placeholder vocabulary', () => {
    // Verbatim incident + composed phrases from the 2026-09-20 sightings
    expect(placeholderDispatchRefusal(INCIDENT_TITLE, 'A real brief with acceptance criteria')).toContain('title "test"');
    expect(placeholderDispatchRefusal('Fix STT', INCIDENT_DESCRIPTION)).toContain('description "description placeholder"');
    expect(placeholderDispatchRefusal('Fix STT', 'placeholder-check')).toContain('placeholder-check'); // normalization strips punctuation
    expect(placeholderDispatchRefusal('Fix STT', 'PLACEHOLDER')).toContain('description "PLACEHOLDER"'); // case
    expect(placeholderDispatchRefusal('Fix STT', '  Test  ')).toContain('"Test"'); // whitespace + case
    // Bare tokens refuse
    expect(placeholderDispatchRefusal('Fix STT', 'todo')).toContain('placeholder');
    expect(placeholderDispatchRefusal('Fix STT', 'xyz')).toBeNull(); // 'xyz' NOT in the denylist — an id fragment is not a placeholder token
    expect(placeholderDispatchRefusal('ASDF', 'Real brief')).toContain('placeholder');
    // Substantive briefs pass
    expect(placeholderDispatchRefusal('Fix the ASR seat routing under load', 'Whisper self-host, 30s wav probe, p95 under 2s')).toBeNull();
    expect(placeholderDispatchRefusal('Test the STT pipeline', 'placeholder text renders raw — regression 1234')).toBeNull();
  });
});
