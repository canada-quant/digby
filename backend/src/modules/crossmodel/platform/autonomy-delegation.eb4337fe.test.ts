/**
 * Ticket eb4337fe — scoped supervisor autonomy delegation + preference-covered
 * digest schedules (ruling oq_2674964f: the Fleet Supervisor answered the
 * owner-question under the standing directives 2026-09-13 "APPROVE BOTH, STOP
 * ASKING ME SO MUCH…" / 2026-09-12 "CLEAR GATES ALWAYS ON MY BEHALF").
 *
 * The ticket: 5 owner confirmation cards in 24h were all redundant
 * re-confirmations — 3 supervisor-initiated set_chat_autonomy grants to lanes
 * they supervise (one left an AWS monitor unable to message peers ~110 min),
 * 2 first-use schedule_message cards for recurring digests the owner asked
 * for by name. This suite pins the fix AND every scope guard:
 *
 * LIMB A (set_chat_autonomy cross-chat delegation, card-free ONLY under the
 * scope guards — numbered from 2, guard 1 (a kill switch) is retired):
 *   2. target ≠ caller, non-empty, resolvable (unresolvable → stages);
 *   3. granter is supervisor-class (isSupervisorChat) — a plain lane stages;
 *   4. same owner only — a cross-owner target stages;
 *   5. project supervisors delegate within their OWN project only (a
 *      different project's lane stages; the FLEET supervisor reaches any
 *      same-owner lane);
 *   6. requested tools ⊆ AUTONOMY_GRANTABLE_TOOLS AND ⊆ the granter's
 *      effective set (modeAuthority ? the full template : the stored row) —
 *      a tool the granter does NOT hold stages; a scheduleCap above the
 *      granter's effective cap stages; a prisma read failure stages
 *      (fail-closed).
 * A passing delegation executes via delegateChatAutonomy, writes the row with
 * source 'machine_delegated', audits, records the autonomy_delegation loop
 * metric, and stages NO confirmation.
 *
 * LIMB B (preference-covered recurring digests, first-use schedule_message):
 * a recurring schedule_message whose prompt matches a stored owner digest
 * preference arms directly — no card — with an audit naming the preference key
 * and a preference_digest_armed metric. The match is the reviewer-D2 conjunct
 * (adversarial review of 21ab2e33c, five live probes P1–P5): the preference
 * row carries cadence+delivery signals AND the prompt satisfies a three-rule
 * conjunct — a delivery-family keyword, ≥2 shared MEANINGFUL keywords
 * (stopword- and digit-initial-excluded), intervalMinutes ≥ 60. kind 'once',
 * a single shared generic word, an incidental shared fact/time, a sub-hourly
 * cadence, a missing interval, no facts → stage as before. A lane
 * whose GRANT already covers schedule_message bypasses via the grant path
 * (no double-write).
 *
 * REVIEWER D4/D1/D5 pins (same review): a delegation onto a target whose
 * existing row is owner-curated (source 'manual') REFUSES card-free and
 * stages the owner card; an agent_mode_auto target row IS overwritten — with
 * the machine_delegated audit row; the machine-delegated grant summary no
 * longer claims the false empty-array self-revoke and names the owner-card
 * revocation path.
 *
 * Scaffolding mirrors platform-tools.autonomy.test.ts (same transitive mocks)
 * + a mocked prisma boundary for the delegation reads + a mocked
 * supervisor-state.service for isSupervisorChat.
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
// agent-auth pulls config/database + utils/jwt → config/env (process.exit).
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

// The service layer under the tools — fully mocked; the gate behavior is what we pin.
const svc = {
  listChats: jest.fn(),
  createChat: jest.fn(),
  getChatStatus: jest.fn(),
  getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(),
  renameChat: jest.fn(),
  archiveChat: jest.fn(),
  moveChat: jest.fn(),
  deleteChat: jest.fn(),
  createProject: jest.fn(),
  getProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  moveFolder: jest.fn(),
  startCodingSession: jest.fn(),
  scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(),
  cancelSchedule: jest.fn(),
  updateSchedule: jest.fn(),
  suggestChatsByIdPrefix: jest.fn(async () => [] as Array<{ id: string; title: string }>),
  getOwnChatDeletion: jest.fn(async () => null),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

// The testkit import must precede its const usage (ts-jest isolatedModules
// emits the require in place — see platform-tools.autonomy.test.ts).
import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// ── The prisma boundary for the REAL autonomy.service (limb A reads
// crossModelChat + chatAutonomy here; limb B reads userMemoryFact) and the
// DB-persisted confirmation registry. Same shape as autonomy.service.test.ts. ──
const mockPrisma: any = {
  chatAutonomy: { findUnique: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn(async () => ({ count: 1 })) },
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn(async () => []) },
  userMemoryFact: { findMany: jest.fn(async () => []) },
  activity: { create: jest.fn(async () => ({})) },
};
const mockConfirmations = createPendingConfirmationTable();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { ...mockPrisma, pendingConfirmation: mockConfirmations.api },
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

// crossmodel.service.getChatAccess — the setChatAutonomy owner check boundary.
const mockGetChatAccess = jest.fn(async (..._a: any[]) => ({ access: 'owner' as const, exists: true }));
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: (...a: any[]) => mockGetChatAccess(...a) },
}));

// supervisor-state.service — the isSupervisorChat seam the delegation verdict
// consults via dynamic import (fail-closed when absent/false).
const mockIsSupervisorChat = jest.fn(async (..._a: any[]) => false);
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  isSupervisorChat: (...a: any[]) => mockIsSupervisorChat(...a),
}));

// Loop metrics — the gate records autonomy_delegation / preference_digest_armed
// (and confirmation_staged on every staging) via DYNAMIC import; spied recorder.
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

// REAL autonomy.service over the mocked prisma (mirrors the g19 suite's
// integration pattern) + the platform tools under test.
import { executePlatformTool } from './platform-tools';
import {
  supervisorDelegationVerdict,
  delegateChatAutonomy,
  ownerDigestPreferenceCoversDigest,
  syncAutonomyWithAgentMode,
  AUTONOMY_GRANTABLE_TOOLS,
  AUTONOMY_SOURCE_MACHINE_DELEGATED,
} from './autonomy.service';
import { pendingConfirmationCount } from './pending-confirmations';
import type { ToolContext } from '../coding/tools';

// ── Fixture world ─────────────────────────────────────────────────────────────

const U = 'u1';
const OTHER = 'u2';
const FLEET = 'fleet-sup'; // the owner's Fleet Supervisor (isSupervisor: true)
const PROJ = 'proj-sup';   // a project supervisor (isProjectSupervisor: true, project P1)
const LANE_P1 = 'lane-p1'; // a lane in project P1 (same owner)
const LANE_P2 = 'lane-p2'; // a lane in project P2 (same owner — cross-project for PROJ)
const FOREIGN_LANE = 'foreign-lane'; // another owner's lane
const PLAIN_LANE = 'plain-lane';     // same owner, no supervisor flags

/** The crossModelChat rows the delegation verdict reads (findUnique by PK). */
const chatRows: Record<string, any> = {
  [FLEET]: { id: FLEET, userId: U, projectId: null, isSupervisor: true, isProjectSupervisor: false },
  [PROJ]: { id: PROJ, userId: U, projectId: 'p1', isSupervisor: false, isProjectSupervisor: true },
  [LANE_P1]: { id: LANE_P1, userId: U, projectId: 'p1', isSupervisor: false, isProjectSupervisor: false },
  [LANE_P2]: { id: LANE_P2, userId: U, projectId: 'p2', isSupervisor: false, isProjectSupervisor: false },
  [FOREIGN_LANE]: { id: FOREIGN_LANE, userId: OTHER, projectId: 'p9', isSupervisor: false, isProjectSupervisor: false },
  [PLAIN_LANE]: { id: PLAIN_LANE, userId: U, projectId: 'p1', isSupervisor: false, isProjectSupervisor: false },
};

/** The granter's stored ChatAutonomy row (null = no stored grant). */
let storedGrant: { allowedTools: string[]; scheduleCap: number; source: string } | null = null;

/**
 * Per-chat ChatAutonomy rows (reviewer D4: the delegation write now reads the
 * TARGET's row before overwriting it, so granter and target can hold
 * DIFFERENT rows). A chat NOT in the map falls back to the legacy blanket
 * `storedGrant` — the pre-D4 world, where only the caller's row was ever
 * read. Key present with value null = that chat has NO row.
 */
const grantRows: Record<string, any> = {};

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: FLEET, userId: U, permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return ctx;
}

/** Default delegation context: the FLEET supervisor on a machine wake. */
function fleetCtx(overrides: Partial<ToolContext> = {}) {
  return makeCtx({ agentSurface: 'chat' as any, ...overrides });
}

const DELEGATE_ARGS = (target: string, allowedTools: string[], scheduleCap?: number) => ({
  chatId: target, allowedTools, ...(scheduleCap != null ? { scheduleCap } : {}),
});

/** Mock the grant-write upsert the way prisma would (create-or-update shape). */
function grantUpsertResult(create: any) {
  return { allowedTools: create.allowedTools, scheduleCap: create.scheduleCap ?? 48 };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  storedGrant = null;
  for (const k of Object.keys(grantRows)) delete grantRows[k];
  // crossModelChat.findUnique serves the fixture rows (source of truth for
  // owner/project/supervisor flags — exactly the reads the verdict makes).
  mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ where }: any) => chatRows[where.id] ?? null);
  // chatAutonomy.findUnique serves the per-chat map (D4) with a blanket
  // storedGrant fallback for chats the test did not pin, mirroring the
  // pre-D4 world where only the caller's row was ever read.
  mockPrisma.chatAutonomy.findUnique.mockImplementation(async ({ where }: any) => {
    if (Object.prototype.hasOwnProperty.call(grantRows, where.chatId)) return grantRows[where.chatId];
    return storedGrant;
  });
  mockPrisma.chatAutonomy.upsert.mockImplementation(async ({ create }: any) => grantUpsertResult(create));
  mockPrisma.userMemoryFact.findMany.mockResolvedValue([]);
  mockIsSupervisorChat.mockImplementation(async (chatId: string) => {
    const r = chatRows[chatId];
    return r?.isSupervisor === true || r?.isProjectSupervisor === true;
  });
  mockGetChatAccess.mockResolvedValue({ access: 'owner', exists: true });
  svc.scheduleChatRun.mockResolvedValue({
    id: 'sch-1', sessionId: LANE_P1, kind: 'recurring', intervalSec: 1440,
    nextRunAt: 'tomorrow', expiresAt: 'in-30-days',
  });
});

// ── LIMB A: the delegation verdict truth table ────────────────────────────────

// No-card-for-requested-work (platform/work-tools.ts): on a HUMAN turn the
// requested-work tools (start_coding_session, create_feed, own-chat schedule
// tools, …) now execute WITHOUT a card. This suite pins the STAGING contract
// itself (staging-time validation, WYSIWYG confirm, the card envelope), which
// still governs machine turns and the kill switch — so it runs with the switch
// set; the direct path is pinned by work-tools.test.ts.
beforeAll(() => { process.env.WORK_TOOLS_NO_CARD_DISABLED = '1'; });
afterAll(() => { delete process.env.WORK_TOOLS_NO_CARD_DISABLED; });

describe('supervisorDelegationVerdict (eb4337fe limb A)', () => {
  it('a PROJECT supervisor delegating a held tool to a same-project lane → delegate', async () => {
    storedGrant = { allowedTools: ['schedule_message', 'cancel_schedule'], scheduleCap: 48, source: 'manual' };
    const v = await supervisorDelegationVerdict({
      callerChatId: PROJ, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['schedule_message'] }, modeAuthority: false,
    });
    expect(v).toEqual({ kind: 'delegate' });
  });

  it('the FLEET supervisor reaches a same-owner lane in ANOTHER project → delegate', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: LANE_P2, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v).toEqual({ kind: 'delegate' });
  });

  it('mode-authority granter (no stored row) may delegate the FULL grantable set', async () => {
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: 1440 }, modeAuthority: true,
    });
    expect(v).toEqual({ kind: 'delegate' });
  });

  it('guard: a tool the granter does NOT hold → beyond', async () => {
    storedGrant = { allowedTools: ['schedule_message', 'cancel_schedule'], scheduleCap: 48, source: 'manual' };
    const v = await supervisorDelegationVerdict({
      callerChatId: PROJ, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: a tool outside the grantable set → beyond', async () => {
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['set_chat_autonomy'] }, modeAuthority: true,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: cross-owner target → beyond', async () => {
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: FOREIGN_LANE, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: a NON-supervisor granter (plain lane) → beyond', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const v = await supervisorDelegationVerdict({
      callerChatId: PLAIN_LANE, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: a project supervisor targeting a DIFFERENT project\'s lane → beyond', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const v = await supervisorDelegationVerdict({
      callerChatId: PROJ, targetChatId: LANE_P2, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: a scheduleCap above the granter\'s effective cap → beyond (a raise is widening)', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['send_chat_message'], scheduleCap: 96 }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: a scheduleCap ≤ the granter\'s cap is fine', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 96, source: 'manual' };
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['send_chat_message'], scheduleCap: 96 }, modeAuthority: false,
    });
    expect(v).toEqual({ kind: 'delegate' });
  });

  it('guard: an unresolvable target → beyond', async () => {
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: 'no-such-chat', userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: a prisma read failure → beyond (fail-closed)', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('db down'));
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: a grant-row read failure → beyond (fail-closed)', async () => {
    mockPrisma.chatAutonomy.findUnique.mockRejectedValue(new Error('db down'));
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: isSupervisorChat false → beyond (the seam is authoritative, not the row alone)', async () => {
    mockIsSupervisorChat.mockResolvedValue(false);
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: LANE_P1, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: SELF target (the 9341e862 path) → beyond here', async () => {
    const v = await supervisorDelegationVerdict({
      callerChatId: FLEET, targetChatId: FLEET, userId: U,
      args: { allowedTools: ['send_chat_message'] }, modeAuthority: false,
    });
    expect(v.kind).toBe('beyond');
  });

  it('guard: malformed / empty allowedTools → beyond', async () => {
    for (const bad of [undefined, [], 'schedule_message', { not: 'an array' }]) {
      const v = await supervisorDelegationVerdict({
        callerChatId: FLEET, targetChatId: LANE_P1, userId: U,
        args: { allowedTools: bad as any }, modeAuthority: false,
      });
      expect(v.kind).toBe('beyond');
    }
  });
});

// ── LIMB A: the write + the gate end-to-end ───────────────────────────────────

describe('delegateChatAutonomy (the write)', () => {
  it('upserts with source machine_delegated and audits the granter', async () => {
    const r = await delegateChatAutonomy({
      granterChatId: FLEET, targetChatId: LANE_P1, userId: U,
      allowedTools: ['send_chat_message'], scheduleCap: 48,
    });
    expect(r).toMatchObject({ granted: true, chatId: LANE_P1, source: AUTONOMY_SOURCE_MACHINE_DELEGATED });
    const data = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(data.create).toMatchObject({ chatId: LANE_P1, source: AUTONOMY_SOURCE_MACHINE_DELEGATED, allowedTools: ['send_chat_message'] });
    expect(data.update).toMatchObject({ source: AUTONOMY_SOURCE_MACHINE_DELEGATED });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: U, resource: 'platform',
        action: 'autonomy.grant.machine_delegated',
        metadata: expect.objectContaining({ granterChatId: FLEET, targetChatId: LANE_P1 }),
      }),
    });
  });
});

describe('gate: set_chat_autonomy cross-chat delegation (eb4337fe limb A)', () => {
  it('a PROJECT supervisor delegating a held tool to a same-project lane EXECUTES — row written machine_delegated, audited, metric, NO card', async () => {
    storedGrant = { allowedTools: ['schedule_message', 'cancel_schedule'], scheduleCap: 48, source: 'manual' };
    grantRows[LANE_P1] = null; // target holds NO row (D4: granter/target rows are read separately)
    const ctx = makeCtx({ sessionId: PROJ, agentSurface: 'chat' as any });
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['schedule_message']));
    expect(out).not.toMatch(/needsConfirmation/);
    expect(out).toMatch(new RegExp(`Autonomy granted for chat ${LANE_P1}`));
    expect(out).toMatch(/MACHINE-DELEGATED/);
    expect(out).toMatch(new RegExp(PROJ));
    // The row: written via the delegation path with the machine_delegated source.
    const data = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(data.create).toMatchObject({ chatId: LANE_P1, source: AUTONOMY_SOURCE_MACHINE_DELEGATED, allowedTools: ['schedule_message'] });
    // Audited (autonomous execution + the machine_delegated grant audit row).
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'autonomy.grant.machine_delegated', resource: 'platform' }),
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'autonomy.execute',
        metadata: expect.objectContaining({ tool: 'set_chat_autonomy', note: expect.stringContaining('machine-delegated grant to a supervised lane') }),
      }),
    });
    // Telemetry: ONE autonomy_delegation metric.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'autonomy_delegation', sessionId: PROJ,
      meta: expect.objectContaining({ granterChatId: PROJ, targetChatId: LANE_P1, allowedTools: ['schedule_message'] }),
    }));
    expect(await pendingConfirmationCount()).toBe(0); // NO confirmation staged
  });

  it('the FLEET supervisor reaches a same-owner lane in ANOTHER project — EXECUTES', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    grantRows[LANE_P2] = null; // target holds NO row (D4)
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P2, ['send_chat_message']));
    expect(out).not.toMatch(/needsConfirmation/);
    expect(out).toMatch(/Autonomy granted for chat lane-p2/);
    expect(mockPrisma.chatAutonomy.upsert.mock.calls[0][0].create).toMatchObject({ source: AUTONOMY_SOURCE_MACHINE_DELEGATED });
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('an AGENT-MODE-AUTO supervisor orchestrator (modeAuthority, no stored row) delegates the full set — EXECUTES', async () => {
    storedGrant = null;
    grantRows[LANE_P1] = null; // target holds NO row (D4)
    const ctx = makeCtx({ sessionId: FLEET, agentSurface: 'coding' as any, permissionMode: 'auto' });
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, [...AUTONOMY_GRANTABLE_TOOLS]));
    expect(out).not.toMatch(/needsConfirmation/);
    expect(out).toMatch(/Autonomy granted for chat lane-p1/);
    expect(mockPrisma.chatAutonomy.upsert.mock.calls[0][0].create).toMatchObject({ source: AUTONOMY_SOURCE_MACHINE_DELEGATED });
    expect(await pendingConfirmationCount()).toBe(0);
  });

  // ── the guard pins (each stages exactly as before) ──

  it('guard: a tool the granter does NOT hold (send_chat_message) → STAGES', async () => {
    storedGrant = { allowedTools: ['schedule_message', 'cancel_schedule'], scheduleCap: 48, source: 'manual' };
    const ctx = makeCtx({ sessionId: PROJ, agentSurface: 'chat' as any });
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['send_chat_message']));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'autonomy_delegation' }));
    expect(await pendingConfirmationCount()).toBe(1);
  });

  it('guard: a cross-owner target → STAGES', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(FOREIGN_LANE, ['send_chat_message']));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('guard: a NON-supervisor granter (plain lane) → STAGES', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const ctx = makeCtx({ sessionId: PLAIN_LANE, agentSurface: 'chat' as any });
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['send_chat_message']));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('guard: a project supervisor targeting a DIFFERENT project\'s lane → STAGES', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const ctx = makeCtx({ sessionId: PROJ, agentSurface: 'chat' as any });
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P2, ['send_chat_message']));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('guard: a scheduleCap above the granter\'s effective cap → STAGES', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['send_chat_message'], 96));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('guard: a prisma read failure → STAGES (fail-closed)', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValue(new Error('db down'));
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['send_chat_message']));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('regression: a SELF request never reaches the delegation branch (the 9341e862 verdict owns self)', async () => {
    // Self + no stored grant + chat surface → 'beyond' from the SELF verdict;
    // the delegation branch requires target ≠ caller, so this still stages.
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(FLEET, ['send_chat_message']));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('regression: a non-supervisor machine set_chat_autonomy staging (fleet-supervisor.e2e stage-1 class) still STAGES', async () => {
    // The e2e suite's SUP chat is a PLAIN chat (no supervisor flags) — its
    // machine-stage pin must keep holding under the new gate.
    const ctx = makeCtx({ sessionId: PLAIN_LANE, userId: U, agentSurface: 'chat' as any });
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', { chatId: PLAIN_LANE, allowedTools: ['send_chat_message'] });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });
});

// ── REVIEWER D4/D1 (adversarial review of 21ab2e33c): the delegation write vs
// the TARGET's existing row, and the grant summary's revocation guidance ──────

describe('reviewer D4: the delegation write vs the TARGET\'s existing row', () => {
  it('a delegation onto an owner-curated MANUAL row REFUSES card-free — nothing written, owner card staged', async () => {
    // The granter (FLEET) legitimately holds the tool; the TARGET's row is one
    // the owner curated by hand — silently replacing it was the reviewer's D4
    // (authority-neutral but unaudited narrowing). Fail-closed: stage a card.
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    grantRows[LANE_P1] = { allowedTools: ['start_coding_session'], scheduleCap: 48, source: 'manual' };
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['send_chat_message']));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.chatAutonomy.deleteMany).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'autonomy_delegation' }));
    expect(await pendingConfirmationCount()).toBe(1);
  });

  it('delegateChatAutonomy itself returns null on a manual target (the not-delegated shape)', async () => {
    grantRows[LANE_P1] = { allowedTools: ['start_coding_session'], scheduleCap: 48, source: 'manual' };
    const r = await delegateChatAutonomy({
      granterChatId: FLEET, targetChatId: LANE_P1, userId: U,
      allowedTools: ['send_chat_message'], scheduleCap: 48,
    });
    expect(r).toBeNull();
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ action: 'autonomy.grant.machine_delegated' }) }),
    );
  });

  it('a delegation onto an AGENT-MODE-AUTO row overwrites it (mode-managed) — WITH both audit rows', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    grantRows[LANE_P1] = { allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: 48, source: 'agent_mode_auto' };
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['send_chat_message']));
    expect(out).not.toMatch(/needsConfirmation/);
    expect(out).toMatch(new RegExp(`Autonomy granted for chat ${LANE_P1}`));
    const data = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(data.create).toMatchObject({ chatId: LANE_P1, source: AUTONOMY_SOURCE_MACHINE_DELEGATED, allowedTools: ['send_chat_message'] });
    expect(data.update).toMatchObject({ source: AUTONOMY_SOURCE_MACHINE_DELEGATED });
    // D4: the overwrite is never silent — the machine_delegated grant Activity
    // AND the gate's autonomous-execution Activity are both written.
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: U, resource: 'platform',
        action: 'autonomy.grant.machine_delegated',
        metadata: expect.objectContaining({ granterChatId: FLEET, targetChatId: LANE_P1 }),
      }),
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'autonomy.execute',
        metadata: expect.objectContaining({ tool: 'set_chat_autonomy', note: expect.stringContaining('machine-delegated grant to a supervised lane') }),
      }),
    });
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('a TARGET-row read failure also refuses card-free (fail-closed → staging)', async () => {
    // The granter's verdict read succeeds; the delegate write's OWN read of the
    // target row throws — the write must fail closed into the owner card.
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    mockPrisma.chatAutonomy.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.chatId === LANE_P1) throw new Error('db down');
      return storedGrant;
    });
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['send_chat_message']));
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });
});

describe('reviewer D1: the machine-delegated grant summary names the real revocation path', () => {
  it('no false empty-array self-revoke claim; the owner-card path is named', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: 'manual' };
    grantRows[LANE_P1] = null;
    const ctx = fleetCtx();
    const out = await executePlatformTool(ctx, 'set_chat_autonomy', DELEGATE_ARGS(LANE_P1, ['send_chat_message']));
    expect(out).not.toMatch(/needsConfirmation/);
    expect(out).toMatch(/MACHINE-DELEGATED/);
    // D1: the OLD text claimed "revoke any time by re-calling with an empty
    // allowedTools array (that still asks the owner when it would widen
    // nothing you hold)" — FALSE on this path: a cross-chat empty-array
    // set_chat_autonomy always stages an owner card, and the delegation
    // verdict refuses empty arrays outright (a machine grant never revokes).
    expect(out).not.toMatch(/revoke any time by re-calling with an empty allowedTools array/);
    expect(out).not.toMatch(/widen nothing you hold/);
    expect(out).toMatch(/To revoke: ask the owner/);
    expect(out).toMatch(/stages an owner card/);
    expect(out).toMatch(/superseded by any owner manual save/);
  });
});

// ── syncAutonomyWithAgentMode interaction (a delegated grant survives flips) ──

describe('syncAutonomyWithAgentMode × machine_delegated (eb4337fe)', () => {
  it('a mode flip TO auto does NOT clobber a machine_delegated row', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: AUTONOMY_SOURCE_MACHINE_DELEGATED };
    mockPrisma.chatAutonomy.upsert.mockClear();
    const r = await syncAutonomyWithAgentMode({ chatId: LANE_P1, permissionMode: 'auto' });
    expect(r).toBe('unchanged');
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  });

  it('a mode flip AWAY from auto does NOT delete a machine_delegated row', async () => {
    storedGrant = { allowedTools: ['send_chat_message'], scheduleCap: 48, source: AUTONOMY_SOURCE_MACHINE_DELEGATED };
    mockPrisma.chatAutonomy.deleteMany.mockClear();
    const r = await syncAutonomyWithAgentMode({ chatId: LANE_P1, permissionMode: 'ask' });
    expect(r).toBe('unchanged');
    expect(mockPrisma.chatAutonomy.deleteMany).not.toHaveBeenCalled();
  });

  it('sanity: an agent_mode_auto row IS still managed by flips (the control case)', async () => {
    storedGrant = { allowedTools: [...AUTONOMY_GRANTABLE_TOOLS], scheduleCap: 48, source: 'agent_mode_auto' };
    const r = await syncAutonomyWithAgentMode({ chatId: LANE_P1, permissionMode: 'ask' });
    expect(r).toBe('revoked');
    expect(mockPrisma.chatAutonomy.deleteMany).toHaveBeenCalledWith({
      where: { chatId: LANE_P1, source: 'agent_mode_auto' },
    });
  });
});

// ── LIMB B: preference-covered recurring digests ──────────────────────────────

describe('ownerDigestPreferenceCoversDigest (eb4337fe limb B)', () => {
  const DIGEST_FACT = {
    key: 'digest:slack-morning',
    content: 'digest: wants a daily 8am Slack digest of AI news and X trends',
  };

  it('a recurring prompt matching the stored preference → covered, with the key', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring',
      prompt: 'Send the owner their daily 8am Slack digest of AI news and X trends',
      intervalMinutes: 1440,
    });
    expect(r).toEqual({ covered: true, preferenceKey: 'digest:slack-morning' });
  });

  it('kind "once" is NEVER covered (one-off work, not a standing preference)', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'once',
      prompt: 'Send the owner their daily 8am Slack digest of AI news and X trends',
      intervalMinutes: 60,
    });
    expect(r.covered).toBe(false);
  });

  it('a prompt with NO keyword overlap with the preference → not covered', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring',
      prompt: 'Re-verify the acceptance criteria every hour and report drift',
      intervalMinutes: 60,
    });
    expect(r.covered).toBe(false);
  });

  it('no facts at all → not covered', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([]);
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring', prompt: 'daily 8am Slack digest', intervalMinutes: 1440,
    });
    expect(r.covered).toBe(false);
  });

  it('a fact WITHOUT cadence/time signal does not count (conservative conjunctive match)', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([
      { key: 'likes-slack', content: 'prefers updates via Slack' },
    ]);
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring', prompt: 'Slack update every morning', intervalMinutes: 1440,
    });
    expect(r.covered).toBe(false);
  });

  it('a fact WITHOUT a delivery/content signal does not count', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([
      { key: 'early-riser', content: 'starts work at 8am every morning' },
    ]);
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring', prompt: 'daily 8am Slack digest', intervalMinutes: 1440,
    });
    expect(r.covered).toBe(false);
  });

  it('a read failure → not covered (fail-closed)', async () => {
    mockPrisma.userMemoryFact.findMany.mockRejectedValue(new Error('db down'));
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring', prompt: 'daily 8am Slack digest', intervalMinutes: 1440,
    });
    expect(r.covered).toBe(false);
  });

  it('a matching preference with different wording still needs the SHARED salient keyword (twitter/trends family)', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([
      { key: 'x-digest', content: 'wants a morning twitter trends update' },
    ]);
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring', prompt: 'Post the morning X trends update', intervalMinutes: 1440,
    });
    expect(r).toEqual({ covered: true, preferenceKey: 'x-digest' });
  });

  // ── Reviewer D2 live probes (adversarial review of 21ab2e33c): five probe
  // runs proved P1/P2/P4/P5 were WRONGLY covered by the old ≥1-salient-keyword
  // matcher (P3, the control, was correct). These pins reproduce the probe
  // classes against the three-rule conjunct. ──

  it('P1 probe: a SINGLE shared generic word never covers (the old matcher covered on one salient keyword)', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    // Prompt names a delivery word (rule 1 ✓) and shares exactly ONE content
    // keyword ('news') with the preference — the old matcher called this
    // covered; rule 2 requires ≥2.
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring',
      prompt: 'Send a daily tech news roundup',
      intervalMinutes: 1440,
    });
    expect(r.covered).toBe(false);
  });

  it('P2 probe: incidental facts/dates in common never cover (digit-leading tokens are not content)', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([
      { key: 'x-digest', content: 'wants a daily 8am X trends update' },
    ]);
    // The prompt shares the incidental time '8am' (and would share nothing
    // else but the generic delivery word 'update') — dates/times/quantities
    // are excluded from the overlap, so the shared count stays at 1.
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring',
      prompt: 'Post the 8am q3 update and 2026 roadmap',
      intervalMinutes: 1440,
    });
    expect(r.covered).toBe(false);
  });

  it('P4 probe: a FAST cadence (< 60 min) never covers, even with perfect keyword overlap', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    // Identical prompt/preference to the covered control — only the cadence
    // differs (30 min). The old matcher had no interval bound at all.
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring',
      prompt: 'Send the owner their daily 8am Slack digest of AI news and X trends',
      intervalMinutes: 30,
    });
    expect(r.covered).toBe(false);
  });

  it('P5 probe: a MISSING intervalMinutes never covers (fail-closed)', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring',
      prompt: 'Send the owner their daily 8am Slack digest of AI news and X trends',
    });
    expect(r.covered).toBe(false);
  });

  it('P3 probe (the control): the real daily-8AM-Slack-digest preference + a matching hourly-or-slower prompt → covered', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    // intervalMinutes 60 is the rule-3 BOUNDARY (hourly) — covered.
    const r = await ownerDigestPreferenceCoversDigest({
      userId: U, kind: 'recurring',
      prompt: 'Send the owner their daily 8am Slack digest of AI news and X trends',
      intervalMinutes: 60,
    });
    expect(r).toEqual({ covered: true, preferenceKey: 'digest:slack-morning' });
  });
});

describe('gate: preference-covered digest schedule_message (eb4337fe limb B)', () => {
  const DIGEST_FACT = {
    key: 'digest:slack-morning',
    content: 'digest: wants a daily 8am Slack digest of AI news and X trends',
  };
  const DIGEST_ARGS = {
    chatId: LANE_P1, kind: 'recurring', intervalMinutes: 1440,
    prompt: 'Send the owner their daily 8am Slack digest of AI news and X trends',
  };

  it('a matching recurring digest arms DIRECTLY — no card, audit names the key, metric recorded', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    // USER-anchored chat run — the observed cards staged on user-anchored runs.
    const ctx = makeCtx({ sessionId: LANE_P1, userId: U, agentSurface: 'chat' as any, userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'schedule_message', DIGEST_ARGS);
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.scheduleChatRun).toHaveBeenCalledWith(expect.objectContaining({ chatId: LANE_P1, kind: 'recurring' }));
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'autonomy.execute',
        metadata: expect.objectContaining({
          tool: 'schedule_message',
          note: expect.stringContaining('preference-covered digest schedule (eb4337fe)'),
        }),
      }),
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'autonomy.execute',
        metadata: expect.objectContaining({ note: expect.stringContaining('digest:slack-morning') }),
      }),
    });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'preference_digest_armed', sessionId: LANE_P1,
      meta: expect.objectContaining({ preferenceKey: 'digest:slack-morning' }),
    }));
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('kind "once" with the SAME matching prompt still STAGES', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    const ctx = makeCtx({ sessionId: LANE_P1, userId: U, agentSurface: 'chat' as any, userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'schedule_message', { ...DIGEST_ARGS, kind: 'once', intervalMinutes: 60 });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.scheduleChatRun).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'preference_digest_armed' }));
  });

  it('a recurring prompt with NO keyword overlap still STAGES', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    const ctx = makeCtx({ sessionId: LANE_P1, userId: U, agentSurface: 'chat' as any, userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'schedule_message', {
      ...DIGEST_ARGS, prompt: 'Re-verify the acceptance criteria and report drift',
    });
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
    expect(svc.scheduleChatRun).not.toHaveBeenCalled();
  });

  it('no stored facts → STAGES', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([]);
    const ctx = makeCtx({ sessionId: LANE_P1, userId: U, agentSurface: 'chat' as any, userTurnAt: new Date() });
    const out = await executePlatformTool(ctx, 'schedule_message', DIGEST_ARGS);
    expect(JSON.parse(out)).toMatchObject({ ok: false, needsConfirmation: true });
  });

  it('a MACHINE run with a matching digest also arms directly (applies in BOTH run types)', async () => {
    mockPrisma.userMemoryFact.findMany.mockResolvedValue([DIGEST_FACT]);
    const ctx = makeCtx({ sessionId: LANE_P1, userId: U, agentSurface: 'chat' as any }); // no userTurnAt
    const out = await executePlatformTool(ctx, 'schedule_message', DIGEST_ARGS);
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.scheduleChatRun).toHaveBeenCalled();
    expect(await pendingConfirmationCount()).toBe(0);
  });

  it('regression: a lane whose GRANT already covers schedule_message bypasses via the GRANT path (no double-write, no preference read)', async () => {
    // The lane's OWN grant names schedule_message — the grant bypass above the
    // preference check returns FIRST, so ownerDigestPreferenceCoversDigest is
    // never even consulted (no double-write / no preference dependency).
    storedGrant = { allowedTools: ['schedule_message'], scheduleCap: 48, source: 'manual' };
    mockPrisma.userMemoryFact.findMany.mockClear();
    const ctx = makeCtx({ sessionId: LANE_P1, userId: U, agentSurface: 'chat' as any }); // machine run
    const out = await executePlatformTool(ctx, 'schedule_message', { ...DIGEST_ARGS, prompt: 'anything at all' });
    expect(out).not.toMatch(/needsConfirmation/);
    expect(svc.scheduleChatRun).toHaveBeenCalled();
    expect(mockPrisma.userMemoryFact.findMany).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'preference_digest_armed' }));
  });
});
