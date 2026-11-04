/**
 * Attention watchdog — unit tests with mocked Prisma + Redis boundaries.
 * Covers: both attention legs (Redis ask_user/approval + durable staged
 * confirmations), the >30min blocked rule (incl. updatedAt seeding), per-item
 * dedupe, resolve→recurrence re-notify, quiet-hours hold + morning flush,
 * consolidation into ONE message, per-user isolation, and Redis-failure
 * best-effort. Pattern follows project-digest.service.test.ts.
 */

// The watchdog's server-side hook heal dynamically imports supervisor.service,
// whose static chain reaches config/env (process.exit without env vars) — mock it.
// classifySupervisorNote: a simplified mirror of the real classifier (its full
// semantics are pinned in supervisor.service.test.ts — here we test the WIRING).
jest.mock('../platform/supervisor.service', () => ({
  __esModule: true,
  healSupervisorWildcardHook: jest.fn(async () => undefined),
  // Rollout watch 2026-09-15 (tick 12): the fleet's stock prompt heals on the sweep too.
  healSupervisorStockPrompt: jest.fn(async () => false),
  disableOrphanWildcardHooks: jest.fn(async () => 0),
  classifySupervisorNote: jest.fn((c: unknown) => {
    const t = String(c ?? '');
    if (/no-op/i.test(t)) return 'supervisor_noop';
    if (/ACTIONS TAKEN/i.test(t)) return 'supervisor_action';
    return 'supervisor_note';
  }),
  // wake-cadence-5: the report-up classifier resolves the owner's Fleet
  // Supervisor chat; null = none (the classic classification, every legacy case).
  findFleetSupervisorChat: jest.fn(async () => null),
}));

// Harness-written telemetry boundary (the scan fires recordLoopMetric per
// newly classified note) — mock to assert calls without the real buffer/flush.
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
}));

// Containment ladder (remediation P8 S7): its own suite
// (containment-ladder.service.test.ts) covers thresholds + actions — here it
// is a wired boundary, mocked inert.
jest.mock('./containment-ladder.service', () => ({
  __esModule: true,
  sweepContainmentLadder: jest.fn(async () => 0),
}));

// CanLaw stall 2026-09-15: an owner-decision claim with no open owner question
// wakes the lane that wrote it — a dynamic import of ../platform/goals.service,
// mocked at the boundary (the real module pulls config/env → process.exit).
const mockNoteUnbackedOwnerWaitClaim: jest.Mock = jest.fn(async () => ({ woken: [] }));
jest.mock('../platform/goals.service', () => ({
  __esModule: true,
  noteUnbackedOwnerWaitClaim: (...a: any[]) => mockNoteUnbackedOwnerWaitClaim(...a),
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn() },
  // findUnique/updateMany: the expired-unresolved classification leg (f789d84e).
  pendingConfirmation: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
  projectGoal: { findMany: jest.fn() },
  projectTodo: { findMany: jest.fn() },
  crossModelProject: { findMany: jest.fn() }, // project-name lookup for todo grouping (45a570e0)
  // findMany: the N10 owner-wait verification probe (open oq_ rows backing "needs owner" claims).
  ownerQuestion: { findMany: jest.fn(async () => []) },
  // findMany: the supervisor note scan (stuck-loop backstop + value telemetry).
  crossModelMessage: { create: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
  // Supervisor OFF switch (owner 2026-09-26): null = no row = ON.
  systemSetting: { findUnique: jest.fn(async () => null) },
  // wake-cadence-5: a project lane's wake receipts (the report-up classifier).
  runToolReceipt: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// config/redis boundary — the real module pulls config/env → process.exit(1)
// at import without env vars (same hazard as config/database in digest tests).
// confirm-pending (REAL module under test here) reads via mGet; the watchdog's
// state hash rides hGetAll/hSet/hDel/expire against a LIVE per-test store so
// multi-sweep tests exercise real dedupe/prune semantics.
let hashStores: Record<string, Record<string, string>>;
const mockRedis: any = {
  mGet: jest.fn(),
  get: jest.fn(), // pending-durable record reads (the ask-leg expiry classification)
  set: jest.fn(), // note-scan cursor/fingerprint + cadence-vanished snapshot writes
  del: jest.fn(), // stuck-nudge fingerprint clear (streak broken)
  hGetAll: jest.fn(),
  hSet: jest.fn(),
  hDel: jest.fn(),
  expire: jest.fn(),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

// datetime-context boundary — control the tz per test (its real module pulls
// chat-context → heavy deps).
const mockLoadTz: jest.Mock = jest.fn(async (): Promise<string | undefined> => 'America/Vancouver');
jest.mock('../coding/datetime-context', () => ({
  __esModule: true,
  loadUserTimezone: (...a: any[]) => mockLoadTz(...a),
}));

import {
  runAttentionWatchdogOnce,
  formatAge,
  isQuietHour,
  noteSimilarity,
  detectStuckNotes,
  BLOCKED_MIN_AGE_MS,
  SUPERVISOR_STOP_CREDIT_SKEW_MS,
  STUCK_NOTE_COUNT,
  STUCK_NOTE_SIMILARITY,
  STUCK_NUDGE_TEXT,
  ZOMBIE_BUSY_SKIPS_MIN,
  ZOMBIE_SILENCE_MULTIPLIER,
  ZOMBIE_SILENCE_FALLBACK_MS,
  ZOMBIE_STOP_DEDUPE_SEC,
  PROJECT_NOTE_CURSOR_KEY,
  PROJECT_STUCK_KEY,
  STUCK_NOTE_STREAK_SEAM,
  MAX_PROJECT_SUPERVISORS_PER_USER,
} from './attention-watchdog.service';
import { healSupervisorWildcardHook, healSupervisorStockPrompt, disableOrphanWildcardHooks, classifySupervisorNote } from '../platform/supervisor.service';
import { receiptsAreReportUpOnly, SUPERVISOR_LANE_ACTION_TOOLS } from './attention-watchdog.service';
import { recordLoopMetric } from '../platform/loop-metrics.service';
import logger from '../../../utils/logger';

// ── Fixtures ──────────────────────────────────────────────────────────────────
const OWNER = 'u-owner';
const SUP = 'sup-chat';
const CHAT = 'c-chat';

/** 2026-08-22 12:00 PDT = 19:00Z — a plain non-quiet reference point. */
const T0 = new Date('2026-08-22T19:00:00Z');
/** 2026-08-22 23:30 PDT = 2026-08-23 06:30Z — inside quiet hours. */
const T_QUIET = new Date('2026-08-23T06:30:00Z');
/** 2026-08-23 07:05 PDT = 14:05Z — first sweep after quiet hours. */
const T_MORNING = new Date('2026-08-23T14:05:00Z');

function questionEntry(over: Partial<any> = {}): string {
  return JSON.stringify({
    kind: 'question', id: 'q-1', question: 'Which palette should I use?',
    options: ['A', 'B'], ts: T0.getTime() - 5 * 60000, ...over,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  hashStores = {};
  // Stateful hash-store implementations, re-assigned EVERY test (clearAllMocks
  // keeps implementations, so a per-test mockRejectedValue would leak without this).
  mockRedis.hGetAll.mockImplementation(async (key: string) => ({ ...(hashStores[key] ?? {}) }));
  mockRedis.hSet.mockImplementation(async (key: string, field: string, value: string) => {
    (hashStores[key] ??= {})[field] = value;
    return 1;
  });
  mockRedis.hDel.mockImplementation(async (key: string, fields: string[]) => {
    for (const f of fields) delete hashStores[key]?.[f];
    return fields.length;
  });
  mockRedis.expire.mockResolvedValue(true);
  mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
    if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
    return [{ id: CHAT, title: 'Design Brochure' }, { id: SUP, title: 'Fleet Supervisor' }];
  });
  mockPrisma.pendingConfirmation.findMany.mockResolvedValue([]);
  mockPrisma.pendingConfirmation.findUnique.mockResolvedValue(null);
  mockPrisma.pendingConfirmation.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.projectGoal.findMany.mockResolvedValue([]);
  mockPrisma.projectTodo.findMany.mockResolvedValue([]);
  mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]); // no supervisor notes/stop-credit match by default (7503189b)
  mockRedis.mGet.mockResolvedValue([]); // aligned to [CHAT, SUP]
  mockRedis.get.mockResolvedValue(null); // no durable pending record by default
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.del.mockResolvedValue(1);
  mockLoadTz.mockResolvedValue('America/Vancouver');
  // clearAllMocks keeps implementations — re-pin the supervisor-module defaults
  // so a per-test override can never leak into the next test.
  (healSupervisorWildcardHook as jest.Mock).mockResolvedValue(undefined);
  (disableOrphanWildcardHooks as jest.Mock).mockResolvedValue(0);
});

describe('attention legs', () => {
  it('posts ONE notice for a pending ask_user question, then dedupes the repeat', async () => {
    mockRedis.mGet.mockResolvedValue([questionEntry(), null]);

    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('_Design Brochure_'); // group heading (45a570e0)
    expect(content).toContain('needs your answer');
    expect(content).toContain('Which palette should I use?');
    expect(content).toContain('**Chats waiting on you** (1)');
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data).toMatchObject({
      chatId: SUP, role: 'assistant', metadata: { origin: 'attention-watchdog' },
    });
    // state persisted as notified
    const hSetCalls = mockRedis.hSet.mock.calls.filter((c: any[]) => c[1] === `ask:${CHAT}:q-1`);
    expect(hSetCalls.length).toBeGreaterThan(0);
    expect(hSetCalls[hSetCalls.length - 1][2]).toContain('"notified":1');

    // Second sweep, question still pending → NO duplicate.
    await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 15 * 60000) });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });

  it('prunes resolved items and re-notifies a recurrence', async () => {
    mockRedis.mGet.mockResolvedValue([questionEntry(), null]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);

    // Question answered → key gone → state pruned.
    mockRedis.mGet.mockResolvedValue([null, null]);
    await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 15 * 60000) });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockRedis.hDel).toHaveBeenCalledWith(`attn-watchdog:state:${OWNER}`, [`ask:${CHAT}:q-1`]);

    // A NEW question later → notifies again.
    mockRedis.mGet.mockResolvedValue([questionEntry({ id: 'q-2', question: 'And the font?' }), null]);
    await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 30 * 60000) });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.crossModelMessage.create.mock.calls[1][0].data.content).toContain('And the font?');
  });

  it('surfaces staged PendingConfirmation cards (durable leg)', async () => {
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([{
      id: 'cf-1', chatId: CHAT, tool: 'schedule_message', summary: 'Schedule: nightly digest',
      createdAt: new Date(T0.getTime() - 8 * 60000),
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('has a staged action to confirm');
    expect(content).toContain('Schedule: nightly digest');
  });

  it('lists both legs independently when their ids differ (matches the sidebar poll semantics)', async () => {
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([{
      id: 'cf-1', chatId: CHAT, tool: 'schedule_message', summary: 'Schedule: nightly digest',
      createdAt: new Date(T0.getTime() - 8 * 60000),
    }]);
    mockRedis.mGet.mockResolvedValue([
      JSON.stringify({ kind: 'approval', id: 'appr-1', question: 'Allow schedule_message?', options: [], tool: 'schedule_message', ts: T0.getTime() }),
      null,
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('has a staged action to confirm');
    expect(content).toContain('needs an approve/deny');
    expect(content).toContain('2 items');
    expect(content).toContain('1 approval · 1 staged action'); // counts-first line (45a570e0)
  });
});

describe('expired-unresolved traces (ticket f789d84e)', () => {
  const STAGED = {
    id: 'cf-1', chatId: CHAT, tool: 'schedule_message', summary: 'Schedule: nightly digest',
    createdAt: new Date(T0.getTime() - 8 * 60000),
  };
  const T1 = new Date(T0.getTime() + 15 * 60000);
  const T2 = new Date(T0.getTime() + 30 * 60000);

  it('a staged confirmation that lapses to expired posts ONE "expired unresolved" line, then never again', async () => {
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([STAGED]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);

    // Card gone from the pending set; the durable row says 'expired'.
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([]);
    mockPrisma.pendingConfirmation.findUnique.mockResolvedValue({
      status: 'expired', expiresAt: new Date(T1.getTime() - 60000),
    });
    await runAttentionWatchdogOnce({ now: T1 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(2);
    const content = mockPrisma.crossModelMessage.create.mock.calls[1][0].data.content;
    expect(content).toContain('expired unresolved');
    expect(content).toContain('Expired unresolved');
    expect(content).toContain('**Design Brochure**');
    expect(content).toContain('staged action EXPIRED unresolved');
    expect(content).toContain('Schedule: nightly digest');

    // Reported once → pruned; a later sweep stays silent.
    await runAttentionWatchdogOnce({ now: T2 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(2);
    expect(mockRedis.hDel).toHaveBeenCalledWith(`attn-watchdog:state:${OWNER}`, ['confirm:cf-1']);
  });

  it('a confirmation resolved cleanly (consumed) prunes silently — no expiry line', async () => {
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([STAGED]);
    await runAttentionWatchdogOnce({ now: T0 });
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([]);
    mockPrisma.pendingConfirmation.findUnique.mockResolvedValue({
      status: 'consumed', expiresAt: new Date(T0.getTime() + 86400000),
    });
    await runAttentionWatchdogOnce({ now: T1 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockRedis.hDel).toHaveBeenCalledWith(`attn-watchdog:state:${OWNER}`, ['confirm:cf-1']);
  });

  it('a row still "pending" — even past expiresAt — is NEVER flipped by the watchdog (ticket 7705fec2: a stale card stays live until answered)', async () => {
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([STAGED]);
    await runAttentionWatchdogOnce({ now: T0 });
    // Row vanished from the gather while still status 'pending' (can only mean
    // a racing resolve/deploy skew now that the gather has no time cutoff) —
    // fail-quiet: no lazy flip, no fabricated expiry line, silent prune.
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([]);
    mockPrisma.pendingConfirmation.findUnique.mockResolvedValue({
      status: 'pending', expiresAt: new Date(T1.getTime() - 60000), // stale, unflipped
    });
    await runAttentionWatchdogOnce({ now: T1 });
    expect(mockPrisma.pendingConfirmation.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1); // only the T0 pending notice
    expect(mockRedis.hDel).toHaveBeenCalledWith(`attn-watchdog:state:${OWNER}`, ['confirm:cf-1']);
  });

  it('a STALE pending card keeps riding the pending gather — tracked, deduped, never expiry-traced', async () => {
    // The gather has no expiresAt cutoff: a card past its freshness horizon is
    // still returned by findMany and stays a tracked live item.
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([STAGED]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    // Weeks later, still pending (owner hasn't answered): same item id → the
    // dedupe holds, nothing new posts, nothing flips.
    await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 14 * 86400000) });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.pendingConfirmation.updateMany).not.toHaveBeenCalled();
  });

  it('an ask_user question whose durable record says expired reports the trace; a missing record prunes silently', async () => {
    mockRedis.mGet.mockResolvedValue([questionEntry(), null]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);

    // Question vanished; the durable record (coding:pend:question:q-1) says 'expired'.
    mockRedis.mGet.mockResolvedValue([null, null]);
    mockRedis.get.mockImplementation(async (key: string) =>
      key === 'coding:pend:question:q-1'
        ? JSON.stringify({ id: 'q-1', kind: 'question', sessionId: CHAT, status: 'expired', detail: 'Which palette should I use?', createdAt: T0.getTime() })
        : null,
    );
    await runAttentionWatchdogOnce({ now: T1 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(2);
    const content = mockPrisma.crossModelMessage.create.mock.calls[1][0].data.content;
    expect(content).toContain('a question EXPIRED unresolved');
    expect(content).toContain('Which palette should I use?');

    // Missing durable record (fail-quiet: could have been answered) → NO expiry claim.
    mockRedis.get.mockResolvedValue(null);
    mockRedis.mGet.mockResolvedValue([questionEntry({ id: 'q-2', question: 'And the font?' }), null]);
    await runAttentionWatchdogOnce({ now: T2 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(3); // q-2's pending notice
    mockRedis.mGet.mockResolvedValue([null, null]); // q-2 gone, no record
    await runAttentionWatchdogOnce({ now: new Date(T2.getTime() + 15 * 60000) });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(3);
  });

  it('an expiry detected during quiet hours is held and flushed in the morning', async () => {
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([STAGED]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);

    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([]);
    mockPrisma.pendingConfirmation.findUnique.mockResolvedValue({
      status: 'expired', expiresAt: new Date(T_QUIET.getTime() - 60000),
    });
    await runAttentionWatchdogOnce({ now: T_QUIET });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1); // held

    await runAttentionWatchdogOnce({ now: T_MORNING });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(2);
    const content = mockPrisma.crossModelMessage.create.mock.calls[1][0].data.content;
    expect(content).toContain('1 pending item expired unresolved');
    expect(content).toContain('Schedule: nightly digest');
  });
});

describe('blocked >30min rule', () => {
  it('holds a freshly-blocked goal and notifies once it crosses 30min', async () => {
    const blockedAt = T0.getTime() - 10 * 60000; // 10 min ago at first sweep
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-1', title: 'Ship v2', blockedReason: 'Waiting on legal', updatedAt: new Date(blockedAt),
    }]);

    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled(); // 10m < 30m

    // 25 min later (35m blocked) → fires exactly once.
    await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 25 * 60000) });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('goal · **'); // compact blocked line (45a570e0)
    expect(content).toContain('Ship v2');
    expect(content).toContain('Waiting on legal');
    expect(content).toContain('_No project_'); // group fallback when the goal has no project name
    expect(content).toContain('**Blocked work** (1)');
    expect(content).toContain('Management dashboard');

    await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 40 * 60000) });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1); // dedupe
  });

  it('notifies immediately for a goal already blocked 2h at first observation (owner-wait backed by an open oq — N10)', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-2', title: 'Old blocked goal', blockedReason: 'Needs owner', gateQuestionId: 'oq_g2gate11-aaaa',
      updatedAt: new Date(T0.getTime() - 2 * 3600000),
    }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([{ id: 'oq_g2gate11-aaaa' }]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('oq_g2gate'); // the kept line carries its open oq id
  });

  // Remediation P2 N10: an "awaiting owner"/"needs owner" line with NO open
  // oq_ id behind it is DROPPED from the notice and counted — prose owner-waits
  // nobody can answer are the 21:17Z incident's fuel.
  it('DROPS an owner-wait blocked line with no open oq id (+ owner_wait_line_dropped metric) — and (CanLaw 2026-09-15) TELLS the lane that wrote it', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-2', title: 'Old blocked goal', blockedReason: 'Needs owner', updatedAt: new Date(T0.getTime() - 2 * 3600000),
      createdByChatId: 'c-coord', projectId: 'p-1',
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect((recordLoopMetric as jest.Mock).mock.calls.some((c) => c[0]?.kind === 'owner_wait_line_dropped')).toBe(true);
    await new Promise((r) => setImmediate(r)); // the corrective wake is fire-and-forget
    expect(mockNoteUnbackedOwnerWaitClaim).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'goal', id: 'g-2', title: 'Old blocked goal', laneChatId: 'c-coord', projectId: 'p-1', surface: 'attention_watchdog',
    }));
  });

  // CanLaw stall 2026-09-15: the "answer" on the cited gate was the owner asking
  // a question back — the notice must never read as "the owner ruled".
  it('a stale gate whose owner "answer" was itself a QUESTION is surfaced as "REPLIED WITH A QUESTION — no decision was made", never as ANSWERED', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-halt', title: 'Full SFT-2 training on GO',
      blockedReason: "stays BLOCKED pending the owner's HALT-band decision (owner fork oq_d3be6db5-009b)",
      gateQuestionId: null, updatedAt: new Date(T0.getTime() - 2 * 3600000),
    }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_d3be6db5-009b', status: 'answered', answer: "well didn't we change the benchmark a ton in between this?" },
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('REPLIED WITH A QUESTION');
    expect(content).toContain('no decision was made');
    expect(content).not.toContain('was ANSWERED');
    expect((recordLoopMetric as jest.Mock).mock.calls.some((c) => c[0]?.kind === 'stale_gate')).toBe(true);
  });

  it('a SUPERVISOR answer phrased as a question, or a typed-option pick with a "?", is still a ruling on the stale-gate line (provenance read from the row)', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-sup', title: 'Serving engine', blockedReason: 'Awaiting owner decision', gateQuestionId: 'oq_sup4444',
      updatedAt: new Date(T0.getTime() - 2 * 3600000),
    }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_sup4444', status: 'answered', answer: "shouldn't the lane just proceed under directive 6187239a?", chosenOption: null, answeredBy: 'supervisor' },
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('was ANSWERED');
    expect(content).not.toContain('REPLIED WITH A QUESTION');
  });

  it('the TODO drop path tells the assignee lane too (entity todo, assigneeChatId, projectId)', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-1', name: 'CanLaw', supervised: true }]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-halt', title: 'Full SFT-2 training on GO', blockKind: 'deps', gateQuestionId: null,
      blockedReason: "owner's HALT-band decision MADE — training stays stopped",
      updatedAt: new Date(T0.getTime() - 2 * 3600000), assigneeChatId: 'c-lane', projectId: 'p-1',
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled(); // still not a "needs you" line
    await new Promise((r) => setImmediate(r));
    expect(mockNoteUnbackedOwnerWaitClaim).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'todo', id: 't-halt', laneChatId: 'c-lane', projectId: 'p-1', surface: 'attention_watchdog',
    }));
  });

  it('a gate id that matches NO owner-question row (never existed / foreign) does not rescue the owner-wait line', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-2', title: 'Old blocked goal', blockedReason: 'Awaiting owner decision', gateQuestionId: 'oq_missing1',
      updatedAt: new Date(T0.getTime() - 2 * 3600000),
    }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([]); // no row at all — not open, not stale
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  // 2026-09-12 spark-stall hardening: a blocked goal/todo whose gate owner-question
  // is ANSWERED (or DISMISSED) is surfaced as its own stale_gate notice item —
  // never silently dropped. The incident: work stayed parked ~26h on cards the
  // owner had already answered because the unbacked-claim drop hid it entirely.
  it('SURFACES a stale gate (answered oq) as a stale_gate notice line + stale_gate metric', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-stale', title: 'Run dflash2 throughput comparison', blockedReason: 'Awaiting owner decision', gateQuestionId: 'oq_spark1',
      updatedAt: new Date(T0.getTime() - 26 * 3600000), projectId: null, assigneeChatId: null,
    }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_spark1', status: 'answered', answer: 'throughput numbers for the best dflash2 on the sparks only' },
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('stale gate');
    expect(content).toContain('ANSWERED');
    expect(content).toContain('Run dflash2 throughput comparison');
    expect(content).toContain('sparks only'); // the owner's verbatim answer rides the line
    expect((recordLoopMetric as jest.Mock).mock.calls.some((c) => c[0]?.kind === 'stale_gate')).toBe(true);
    expect((recordLoopMetric as jest.Mock).mock.calls.some((c) => c[0]?.kind === 'owner_wait_line_dropped')).toBe(false);
  });

  it('SURFACES a dismissed gate as stale_gate too (dismissed ≠ unblocked work)', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-dis', title: 'Parked goal', blockedReason: 'needs owner', gateQuestionId: 'oq_dismiss1',
      updatedAt: new Date(T0.getTime() - 3 * 3600000),
    }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_dismiss1', status: 'dismissed', answer: null },
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('stale gate');
    expect(content).toContain('DISMISSED');
    expect((recordLoopMetric as jest.Mock).mock.calls.some((c) => c[0]?.kind === 'stale_gate')).toBe(true);
  });

  it('an inline oq id in the blockedReason counts for stale-gate detection (same as gateQuestionId)', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-inline', title: 'Inline-gated todo', blockedReason: 'waiting on owner card oq_deadbeef-1234-5678-9abc-def012345678 for the go',
      updatedAt: new Date(T0.getTime() - 2 * 3600000), projectId: null, assigneeChatId: null,
    }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_deadbeef-1234-5678-9abc-def012345678', status: 'answered', answer: 'go' },
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('stale gate');
    expect(content).toContain('Inline-gated todo');
  });

  it('a non-owner-wait blocked reason is NOT stale-gate checked even when an oq row is answered (unchanged contract)', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-vendor', title: 'Vendor blocked', blockedReason: 'Waiting on vendor API keys', gateQuestionId: 'oq_other1',
      updatedAt: new Date(T0.getTime() - 2 * 3600000), projectId: null, assigneeChatId: null,
    }]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([
      { id: 'oq_other1', status: 'answered', answer: 'x' },
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('Vendor blocked'); // still a normal blocked line
    expect(content).not.toContain('stale gate');
  });

  it('a NON-owner-wait blocked reason needs no oq backing (unchanged contract)', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-3', title: 'Vendor blocked', blockedReason: 'Waiting on vendor API keys', updatedAt: new Date(T0.getTime() - 2 * 3600000),
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    // Nothing to probe: no gate-state read (the `id: { in: [...] }` shape).
    // Review 2026-09-13 issue 11: the sweep ALSO runs the owner-question
    // triage surfacing read (status/triage/triageUntil shape) every tick —
    // that is a different query and not a gate probe.
    const gateProbes = mockPrisma.ownerQuestion.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.id !== undefined);
    expect(gateProbes).toHaveLength(0);
  });

  it('tracks blocked todos the same way', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-1', title: 'Review PR', blockedReason: 'CI red', updatedAt: new Date(T0.getTime() - 90 * 60000),
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('todo · **'); // compact blocked line (45a570e0)
    expect(content).toContain('Review PR');
    expect(content).toContain('CI red');
  });
});

describe('project supervision opt-out (ticket c992d730)', () => {
  it('excludes a blocked goal whose project is UNSUPERVISED (supervised ones still alert)', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([
      {
        id: 'g-un', title: 'Retired goal', blockedReason: 'stale',
        updatedAt: new Date(T0.getTime() - 2 * 3600000),
        project: { name: 'Retired', supervised: false },
      },
      {
        id: 'g-sup', title: 'Live goal', blockedReason: 'needs owner', gateQuestionId: 'oq_supgate1-bbbb',
        updatedAt: new Date(T0.getTime() - 2 * 3600000),
        project: { name: 'Live', supervised: true },
      },
    ]);
    mockPrisma.ownerQuestion.findMany.mockResolvedValue([{ id: 'oq_supgate1-bbbb' }]); // N10: the owner-wait is backed
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('Live goal');
    expect(content).not.toContain('Retired goal');
  });

  it('excludes a blocked todo whose project is UNSUPERVISED', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-un', title: 'Retired todo', blockedReason: 'stale',
      updatedAt: new Date(T0.getTime() - 2 * 3600000), projectId: 'p-ret',
    }]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p-ret', name: 'Retired', supervised: false }]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('KEEPS a staged confirmation from a chat in an UNSUPERVISED project (user decisions are never hidden)', async () => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
      return [
        { id: CHAT, title: 'Design Brochure', projectId: 'p-ret', project: { supervised: false } },
        { id: SUP, title: 'Fleet Supervisor', projectId: null, project: null },
      ];
    });
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([{
      id: 'cf-1', chatId: CHAT, tool: 'delete_project', summary: 'Delete the folder?',
      createdAt: new Date(T0.getTime() - 10 * 60000),
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('Delete the folder?');
  });

  it('a stopped cadence on a chat in an UNSUPERVISED project does not alert', async () => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ id: 'sch1', sessionId: 'chat1', runsCount: 73, lastFiredAt: new Date(Date.now() - 3600_000) }])
        .mockResolvedValueOnce([]), // no enabled rows left on chat1
    };
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
      return [{ id: 'chat1', title: 'Tenstorrent R&D', projectId: 'p-ret', project: { supervised: false } }];
    });
    await runAttentionWatchdogOnce({ now: T0 });
    const sent = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
    expect(sent).not.toMatch(/cadence stopped/i);
  });
});

describe('quiet hours', () => {
  it('holds a 23:30 detection and flushes ONE consolidated notice at 07:05', async () => {
    mockRedis.mGet.mockResolvedValue([questionEntry(), null]);

    await runAttentionWatchdogOnce({ now: T_QUIET });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    // State recorded but NOT notified (the morning sweep must re-qualify it).
    const held = mockRedis.hSet.mock.calls.find((c: any[]) => c[1] === `ask:${CHAT}:q-1`);
    expect(held[2]).toContain('"notified":0');

    mockRedis.mGet.mockResolvedValue([questionEntry(), null]); // still pending
    await runAttentionWatchdogOnce({ now: T_MORNING });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content).toContain('_Design Brochure_'); // group heading (45a570e0)
  });

  it('silently drops an item that resolves during quiet hours', async () => {
    mockRedis.mGet.mockResolvedValue([questionEntry(), null]);
    await runAttentionWatchdogOnce({ now: T_QUIET });
    mockRedis.mGet.mockResolvedValue([null, null]); // answered overnight
    await runAttentionWatchdogOnce({ now: T_MORNING });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });
});

describe('consolidation + isolation + resilience', () => {
  it('consolidates multiple items into ONE message', async () => {
    mockRedis.mGet.mockResolvedValue([questionEntry(), null]);
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-1', title: 'Ship v2', blockedReason: 'legal', updatedAt: new Date(T0.getTime() - 2 * 3600000),
    }]);
    mockPrisma.pendingConfirmation.findMany.mockResolvedValue([{
      id: 'cf-9', chatId: CHAT, tool: 'send_chat_message', summary: 'Send fleet update',
      createdAt: new Date(T0.getTime() - 20 * 60000),
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('3 items');
    expect(content).toContain('1 question · 1 staged action · 1 blocked goal'); // counts-first line (45a570e0)
    expect(content).toContain('_Design Brochure_'); // chat group heading
    expect(content).toContain('_No project_'); // blocked group fallback
    expect(content).toContain('goal · **2h** — Ship v2');
    expect(content).toContain('Send fleet update');
  });

  it('no supervisor chats → no work, no error', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    await expect(runAttentionWatchdogOnce({ now: T0 })).resolves.toBeUndefined();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });

  it('a Redis state-read failure degrades to empty state (notice still posts; write failure swallowed)', async () => {
    mockRedis.hGetAll.mockRejectedValue(new Error('redis down'));
    mockRedis.hSet.mockRejectedValue(new Error('redis down'));
    mockRedis.hDel.mockRejectedValue(new Error('redis down'));
    mockRedis.expire.mockRejectedValue(new Error('redis down'));
    mockRedis.mGet.mockResolvedValue([questionEntry(), null]);
    await expect(runAttentionWatchdogOnce({ now: T0 })).resolves.toBeUndefined();
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });

  it('one user\'s failure does not kill the sweep (per-user isolation)', async () => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isSupervisor === true) return [{ id: 'sup-1', userId: 'u-1' }, { id: 'sup-2', userId: 'u-2' }];
      return [{ id: `chat-of-${args.where.userId}`, title: 'Their chat' }];
    });
    mockPrisma.pendingConfirmation.findMany.mockImplementation(async (args: any) => {
      if (args.where.userId === 'u-1') throw new Error('boom');
      return [];
    });
    mockRedis.mGet.mockResolvedValue([questionEntry()]); // u-2's chat is pending
    await expect(runAttentionWatchdogOnce({ now: T0 })).resolves.toBeUndefined();
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create.mock.calls[0][0].data.chatId).toBe('sup-2');
  });
});

describe('orphan wildcard-hook GC wiring (ticket a507e650)', () => {
  it('(f) the sweep invokes the GC with the userId (after the heal) and logs the disabled count when > 0', async () => {
    (disableOrphanWildcardHooks as jest.Mock).mockResolvedValueOnce(2);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(healSupervisorWildcardHook).toHaveBeenCalledWith(SUP, OWNER);
    // Rollout watch 2026-09-15 (tick 12): the fleet's stock prompt heals on the same sweep.
    expect(healSupervisorStockPrompt).toHaveBeenCalledWith(SUP);
    expect(disableOrphanWildcardHooks).toHaveBeenCalledTimes(1);
    expect(disableOrphanWildcardHooks).toHaveBeenCalledWith(OWNER);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('orphan wildcard-hook GC disabled 2 hook(s)'),
      expect.objectContaining({ userId: OWNER }),
    );
  });

  it('(f) a zero-disable sweep stays quiet (no count log)', async () => {
    await runAttentionWatchdogOnce({ now: T0 });
    expect(disableOrphanWildcardHooks).toHaveBeenCalledWith(OWNER);
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('orphan wildcard-hook GC'),
      expect.anything(),
    );
  });

  it('(f) a throw inside the GC is swallowed (best-effort) — the rest of the sweep still runs', async () => {
    (disableOrphanWildcardHooks as jest.Mock).mockRejectedValueOnce(new Error('boom'));
    mockRedis.mGet.mockResolvedValue([questionEntry(), null]); // a pending question downstream
    await expect(runAttentionWatchdogOnce({ now: T0 })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('orphan wildcard-hook GC failed (non-fatal)'),
    );
    // Proof the GC failure did not abort sweepUser: the attention leg still posted.
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
  });
});

describe('helpers', () => {
  it('formatAge renders m/h/d', () => {
    expect(formatAge(45 * 1000)).toBe('1m');
    expect(formatAge(12 * 60000)).toBe('12m');
    expect(formatAge(95 * 60000)).toBe('2h');
    expect(formatAge(50 * 3600000)).toBe('2d');
  });

  it('isQuietHour covers 23:00–07:00', () => {
    expect(isQuietHour(23)).toBe(true);
    expect(isQuietHour(2)).toBe(true);
    expect(isQuietHour(7)).toBe(false);
    expect(isQuietHour(12)).toBe(false);
  });

  it('BLOCKED_MIN_AGE_MS is 30 minutes', () => {
    expect(BLOCKED_MIN_AGE_MS).toBe(30 * 60 * 1000);
  });
});

describe('digest readability reformat (ticket 45a570e0)', () => {
  it('truncates long todo titles at ~80 chars with an ellipsis', async () => {
    const longTitle = 'Fix the flaky integration test that keeps timing out on the CI runner when the cache is cold and workers race past each other';
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-long', title: longTitle, blockedReason: 'CI red', updatedAt: new Date(T0.getTime() - 90 * 60000), projectId: 'p1',
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('…');
    expect(content).not.toContain(longTitle);
    expect(content).toContain('full text + drill-down'); // footer carries the drill-down pointer
  });

  it('collapses boilerplate "[deps]" blocked reasons into a small tag', async () => {
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-deps', title: 'Ship the release', blockedReason: '[deps] Waiting on 3 todos', updatedAt: new Date(T0.getTime() - 90 * 60000), projectId: 'p1',
    }]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('`[deps]`');
    expect(content).not.toContain('Waiting on 3 todos');
  });

  it('groups blocked work under project headings and shows the todo assignee', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValue([{
      id: 'g-1', title: 'Goal title', blockedReason: 'vendor', updatedAt: new Date(T0.getTime() - 2 * 3600000),
      project: { name: 'Digby Platform' },
    }]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([{
      id: 't-1', title: 'Todo title', blockedReason: 'CI red', updatedAt: new Date(T0.getTime() - 90 * 60000),
      projectId: 'p2', assigneeChatId: CHAT,
    }]);
    mockPrisma.crossModelProject.findMany.mockResolvedValue([{ id: 'p2', name: 'Ops' }]);
    await runAttentionWatchdogOnce({ now: T0 });
    const content = mockPrisma.crossModelMessage.create.mock.calls[0][0].data.content;
    expect(content).toContain('_Digby Platform_'); // goal group via relation
    expect(content).toContain('_Ops_'); // todo group via batched projectId lookup
    expect(content).toContain('@Design Brochure'); // assignee chat title
    expect(content).toContain('2 projects affected'); // counts-line suffix
  });
});

// ── cadence_stopped (owner report 2026-08-24: TT-RD went dormant overnight) ──
describe('cadence-stopped detection', () => {
  it('a recently-disabled recurring schedule with history on a chat with no enabled rows surfaces as cadence_stopped', async () => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ id: 'sch1', sessionId: 'chat1', runsCount: 73, lastFiredAt: new Date(Date.now() - 3600_000) }])
        .mockResolvedValueOnce([]), // no enabled rows left on chat1
    };
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'chat1', title: 'Tenstorrent R&D' }]);
    await runAttentionWatchdogOnce({ now: T0 }); // fixed non-quiet time — new Date() is quiet-hours-flaky
    const sent = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
    expect(sent).toMatch(/cadence stopped/i);
    expect(sent).toMatch(/73 runs/);
  });

  it('suppressed when ANOTHER enabled schedule still runs the chat', async () => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ id: 'sch1', sessionId: 'chat1', runsCount: 73, lastFiredAt: new Date(Date.now() - 3600_000) }])
        .mockResolvedValueOnce([{ sessionId: 'chat1' }]), // still one enabled
    };
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'chat1', title: 'Tenstorrent R&D' }]);
    await runAttentionWatchdogOnce({ now: T0 });
    const sent = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
    expect(sent).not.toMatch(/cadence stopped/i);
  });
});

// ── cadence-stopped SUPERVISOR CREDIT (replay ticket 7503189b, mishap
//    2026-09-15: the watchdog's "cadence stopped — confirm it was intentional"
//    owner card fired at 16:12Z, ~10 min AFTER the Fleet Supervisor's own note
//    had already reported that same intentional cancel with receipts —
//    "851410b7 (scaffold, cancelled 12/48)". The owner got an ask the system
//    had already answered.) ────────────────────────────────────────────────
describe('cadence-stopped supervisor credit (ticket 7503189b)', () => {
  const LANE = 'chat-lane';
  // Realistic UUID — the credit check matches the fleet's ≥8-char citation idiom.
  const SCH = '851410b7-0000-4000-8000-000000000000';
  const stubStoppedLane = () => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([{ id: SCH, sessionId: LANE, runsCount: 12, lastFiredAt: new Date(T0.getTime() - 40 * 60000) }])
        .mockResolvedValueOnce([]), // no enabled rows left on the lane
    };
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: LANE, title: 'Scaffold Inference Container for Nebiu' }]);
  };
  const sentText = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
  // The sweep also runs the supervisor-note scans against crossModelMessage.findMany
  // (no content filter) — pick OUR credit query by its schedule-prefix content
  // match, never by call index.
  const creditQuery = () =>
    mockPrisma.crossModelMessage.findMany.mock.calls
      .map((c: any[]) => c[0])
      .find((q: any) => q?.where?.content?.contains === SCH.slice(0, 8));

  it('replay 7503189b: a supervisor assistant note citing the schedule prefix + a cancel keyword AFTER the stop suppresses the card', async () => {
    stubStoppedLane();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { content: '**Fleet watch** … receipts: 851410b7 (scaffold, cancelled 12/48) — dead monitor shows cancelled as intended.' },
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).not.toMatch(/cadence stopped/i);
    // The credit lookup reads the SUPERVISOR thread, assistant notes only
    // (machine wake prompts carry the same payload but are not owner-facing),
    // matching the 8-char citation prefix.
    const q = creditQuery();
    expect(q.where.chatId).toBe(LANE); // the mock's only chat doubles as the supervisor thread here
    expect(q.where.role).toBe('assistant');
    expect(q.where.content).toEqual({ contains: '851410b7' });
  });

  it('no credit when the note cites the id with NO cancel-class keyword', async () => {
    stubStoppedLane();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { content: 'sched 851410b7 firing 12/48, healthy watch on cadence' },
    ]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
  });

  it('the credit window opens at lastFiredAt minus the skew slack (stale notes cannot credit a fresh stop)', async () => {
    stubStoppedLane();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([]); // a stale note is already excluded by the createdAt-gte
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
    const q = creditQuery();
    expect(+q.where.createdAt.gte).toBe(T0.getTime() - 40 * 60000 - SUPERVISOR_STOP_CREDIT_SKEW_MS);
  });

  it('a credit-check failure fails OPEN — the card fires exactly as before the fix', async () => {
    stubStoppedLane();
    mockPrisma.crossModelMessage.findMany.mockRejectedValue(new Error('db down'));
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
  });
});

// ── cadence-stopped PLATFORM-INITIATED PARK suppression (replay ticket
//    b101ad89, 2026-09-24: the dormancy auto-park — owner directive
//    2026-09-18, ticket b1d435fd lineage — parked two canlegal-bench chats
//    as dormant (0 active goals / 0 open todos / 0 open owner questions),
//    and each park surfaced an owner card "… ⏸️ 4h — cadence stopped after
//    284 runs — intentional?" — re-asking a decision the owner had already
//    made, with a "re-arm" action that would violate dormancy while the
//    project stays dormant. The park IS the standing directive executing:
//    a lastStatus 'parked:dormant' row is platform-initiated and must not
//    card the owner. Fail-open: a NULL/unknown lastStatus keeps the card.) ──
describe('cadence-stopped dormancy-park suppression (ticket b101ad89)', () => {
  const LANE = 'chat-dormant';
  const PARKED = 'sched-parked-0000-4000-8000-000000000001';
  const parkedRow = (over: any = {}) => ({
    id: PARKED, sessionId: LANE, runsCount: 284,
    lastFiredAt: new Date(Date.now() - 3600_000),
    lastStatus: 'parked:dormant', ...over,
  });
  const sentText = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
  // The sweep's chat reads serve TWO callers: the supervisor-chat lookup
  // (where.isSupervisor === true → the OWNER's user context) and the chat
  // list (titleByChat). A blanket mockResolvedValue would clobber the first,
  // leaving userId undefined and the state hash keyed to
  // 'attn-watchdog:state:undefined' — the beforeEach conditional idiom keeps
  // the user context intact while putting LANE on the map.
  const stubLane = () => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
      return [{ id: LANE, title: 'CanLaw Project Checkpoint Coordination Plan' }, { id: SUP, title: 'Fleet Supervisor' }];
    });
  };

  it('replay b101ad89: a goal-gate auto-parked row (parked:dormant, 284 runs) surfaces NO "intentional?" card', async () => {
    stubLane();
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([parkedRow()])
        .mockResolvedValueOnce([]), // no enabled rows left on the lane
    };
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).not.toMatch(/cadence stopped/i);
    expect(sentText()).not.toMatch(/intentional/i);
    expect(sentText()).not.toMatch(/284 runs/);
  });

  it('a pre-deploy card for a now-suppressed park AUTO-RESOLVES: its state entry is pruned with no "expired unresolved" line', async () => {
    // The 01:57Z card already posted pre-fix — its state entry lingers in the
    // Redis hash with notified:1. Post-fix the item never enters the pending
    // set, vanishedUnresolved has no cadence branch (a park is a RESOLUTION,
    // not an expiry), so the entry is pruned silently — the card stops
    // recurring and never reports as expired-unresolved.
    stubLane();
    hashStores[`attn-watchdog:state:${OWNER}`] = {
      [`cadence:${PARKED}`]: JSON.stringify({
        firstSeenMs: T0.getTime() - 45 * 60000, notified: 1,
        kind: 'cadence_stopped', title: 'CanLaw Project Checkpoint Coordination Plan',
        detail: 'recurring schedule stopped after 284 runs — intentional?',
      }),
    };
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([parkedRow()])
        .mockResolvedValueOnce([]),
    };
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockRedis.hDel).toHaveBeenCalledWith(`attn-watchdog:state:${OWNER}`, [`cadence:${PARKED}`]);
    expect(sentText()).not.toMatch(/cadence stopped|intentional|expired/i);
  });

  it('a GENUINE stop on a chat that also carries a park still surfaces — the non-parked row wins the per-chat pick', async () => {
    stubLane();
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        // parked row first — first-wins would have masked the real stop
        .mockResolvedValueOnce([parkedRow({ id: PARKED, runsCount: 284 }), parkedRow({ id: 'sched-real-stop', runsCount: 123, lastStatus: 'cancelled' })])
        .mockResolvedValueOnce([]),
    };
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
    expect(sentText()).toMatch(/123 runs/);
    expect(sentText()).not.toMatch(/284 runs/);
  });

  it('a legacy NULL lastStatus keeps the card (fail-open — the SQL {not:} three-valued-logic trap this fix avoids)', async () => {
    stubLane();
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([parkedRow({ lastStatus: undefined })])
        .mockResolvedValueOnce([]),
    };
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
  });
});

// ── cadence-stopped HEALTHY-LANE suppression (replay ticket 2dc398fe, mishap
//    2026-10-16: the watchdog posted "⏸️ stopped cadence — recurring schedule
//    stopped after 4 runs — confirm it was intentional or re-arm" for the
//    Schooltime Hue-backlog lane (chat 0037460b) at 03:11Z and AGAIN at 04:11Z
//    while the chat was literally RUNNING at both firings — list_chats
//    running:true, one-shot probes actively completing. The stopped rows
//    (ff53cbf4, 05aeb8c0) were at runs 4/4: a machine-cancelled maxRuns bound
//    is a DESIGNED lifecycle end, and the lane then deliberately replaced the
//    cadence with one-shots. The card re-asked a decision the healthy
//    self-managing lane had already made, twice, for a full 26h-lookback
//    day.) ────────────────────────────────────────────────────────────────
describe('cadence-stopped healthy-lane suppression (ticket 2dc398fe)', () => {
  const LANE = 'chat-hue';
  // Realistic UUID shapes — the stop-credit path prefix-matches ≥8 chars.
  const SCH_A = 'ff53cbf4-0000-4000-8000-000000000001';
  const SCH_B = '05aeb8c0-0000-4000-8000-000000000002';
  // The specimen: both stopped rows at runs === maxRuns, cancelled by the
  // machine (cancel_schedule from a run / the sweeper's cap disable), the
  // lane alive on one-shot probes.
  const atCapRow = (id: string, over: any = {}) => ({
    id, sessionId: LANE, runsCount: 4, maxRuns: 4,
    lastStatus: 'cancelled', cancelledBy: 'machine',
    lastFiredAt: new Date(T0.getTime() - 9 * 3600_000), // 18:00Z stop, inside the 26h lookback
    ...over,
  });
  const sentText = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
  const stubLane = () => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
      return [{ id: LANE, title: 'Schooltime Hue-backlog' }, { id: SUP, title: 'Fleet Supervisor' }];
    });
  };
  /** Query-routing mock: the sweep issues THREE codingSchedule.findMany calls
   *  (per-user stopped rows / per-chat enabled rows / per-chat stopped history)
   *  plus the deaf-scan interval probe — route on the WHERE shape, never on
   *  call order. */
  const stubSchedules = (stopped: any[], enabled: any[], allStoppedBySession: Record<string, any[]> = {}) => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        if (w.userId && w.kind === 'recurring' && w.enabled === false) return stopped; // (c) stopped-cadence scan
        if (w.sessionId?.in && w.enabled === true && !w.intervalSec) return enabled; // (c) enabled-rows probe
        if (w.sessionId?.in && w.kind === 'recurring' && w.enabled === false && w.runsCount?.gte === 1) {
          // (c) designed-exhaustion probe — rows per session
          return Object.entries(allStoppedBySession).flatMap(([sid, rows]) => rows.map((r: any) => ({ ...r, sessionId: sid })));
        }
        if (w.sessionId?.in && w.intervalSec) return []; // deaf-scan cadence history
        return [];
      }),
    };
  };
  const stubAgentRun = (busy: any = {}) => {
    mockPrisma.agentRun = {
      groupBy: jest.fn(async () => []), // deaf scan: no run history for the lane
      findMany: jest.fn(async (args: any) => {
        if (args?.where?.status?.in) return busy.sessions ?? []; // cadence-stop liveness probe
        return []; // deaf-scan busy probe (no assignees here anyway)
      }),
    };
  };

  it('REPLAY 2dc398fe: two rows at runs 4/4 machine-cancelled on a lane with a RUNNING run surface NO card', async () => {
    stubLane();
    stubSchedules([atCapRow(SCH_A), atCapRow(SCH_B)], [], { [LANE]: [atCapRow(SCH_A), atCapRow(SCH_B)] });
    stubAgentRun({ sessions: [{ sessionId: LANE }] }); // the chat was RUNNING at both firings
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).not.toMatch(/cadence stopped/i);
    expect(sentText()).not.toMatch(/intentional/i);
    // The liveness probe actually ran against the lane (clause (a) evidence).
    const probe = mockPrisma.agentRun.findMany.mock.calls
      .map((c: any[]) => c[0])
      .find((q: any) => q?.where?.sessionId?.in?.includes(LANE) && q?.where?.status?.in);
    expect(probe).toBeTruthy();
  });

  it('clause (a) alone suppresses: an IDLE at-cap lane whose run is queued/running now also stays quiet', async () => {
    stubLane();
    // A lane that is mid-work (a long probe run) with a stopped cadence behind it.
    stubSchedules([atCapRow(SCH_A)], [], { [LANE]: [atCapRow(SCH_A)] });
    stubAgentRun({ sessions: [{ sessionId: LANE }] });
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).not.toMatch(/cadence stopped/i);
  });

  it('clause (b) alone suppresses: runs === maxRuns on every stopped row (sweeper cap disable, lastStatus expired, cancelledBy NULL) — designed exhaustion', async () => {
    stubLane();
    const sweeperRow = { ...atCapRow(SCH_A), lastStatus: 'expired', cancelledBy: undefined }; // the run-cap disable path shape
    stubSchedules([sweeperRow], [], { [LANE]: [sweeperRow] });
    stubAgentRun({ sessions: [] }); // lane idle — only the exhaustion rule can save it
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).not.toMatch(/cadence stopped/i);
  });

  it('clause (b) is per-CHAT: a lane with one at-cap row AND one NOT-at-cap stopped row still cards (a real stop hides among designed ends)', async () => {
    stubLane();
    const realStop = { ...atCapRow(SCH_B), runsCount: 12, maxRuns: 48, cancelledBy: undefined, lastStatus: 'cancelled' }; // 12/48 — disabled early, a REAL stop
    stubSchedules([atCapRow(SCH_A), realStop], [], { [LANE]: [atCapRow(SCH_A), realStop] });
    stubAgentRun({ sessions: [] });
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
  });

  it('clause (c): a newer ENABLED row on the same chat suppresses (pre-existing activeSet check — pinned here as part of the ticket contract)', async () => {
    stubLane();
    // The lane replaced its recurring cadence with an ENABLED one-shot probe.
    stubSchedules([atCapRow(SCH_A)], [{ sessionId: LANE }], { [LANE]: [atCapRow(SCH_A)] });
    stubAgentRun({ sessions: [] });
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).not.toMatch(/cadence stopped/i);
  });

  it('TRUE POSITIVE KEEPS FIRING: a genuinely-dead lane (stopped early at 12/48, not at cap, no machine cancel, idle) still cards', async () => {
    stubLane();
    const deadRow = {
      id: 'deadbeef-0000-4000-8000-000000000003', sessionId: LANE, runsCount: 12, maxRuns: 48,
      lastStatus: 'cancelled', cancelledBy: undefined, // not a machine cancel — owner-unknown stop
      lastFiredAt: new Date(T0.getTime() - 9 * 3600_000),
    };
    stubSchedules([deadRow], [], { [LANE]: [deadRow] });
    stubAgentRun({ sessions: [] }); // idle — genuinely deaf
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
    expect(sentText()).toMatch(/12 runs/);
  });

  it('NULL maxRuns (legacy unbounded row) is NOT provably at-cap — the card fires (fail-open, the b101ad89 three-valued trap)', async () => {
    stubLane();
    const legacyRow = { ...atCapRow(SCH_A), maxRuns: undefined, cancelledBy: undefined, lastStatus: 'expired' };
    stubSchedules([legacyRow], [], { [LANE]: [legacyRow] });
    stubAgentRun({ sessions: [] });
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
  });

  it('fail-open: a liveness-probe DB error keeps the card (a duplicate card beats a silenced real stop)', async () => {
    stubLane();
    const deadRow = {
      id: 'deadbeef-0000-4000-8000-000000000004', sessionId: LANE, runsCount: 12, maxRuns: 48,
      lastStatus: 'cancelled', cancelledBy: undefined,
      lastFiredAt: new Date(T0.getTime() - 9 * 3600_000),
    };
    stubSchedules([deadRow], [], { [LANE]: [deadRow] });
    mockPrisma.agentRun = {
      groupBy: jest.fn(async () => []),
      findMany: jest.fn().mockRejectedValue(new Error('db down')),
    };
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
  });

  it('fail-open (review F2): an EXHAUSTION-probe DB error also keeps the card — the catch cannot silently mute a real stop', async () => {
    stubLane();
    const deadRow = {
      id: 'deadbeef-0000-4000-8000-000000000005', sessionId: LANE, runsCount: 12, maxRuns: 48,
      lastStatus: 'cancelled', cancelledBy: undefined,
      lastFiredAt: new Date(T0.getTime() - 9 * 3600_000),
    };
    // The liveness probe stays healthy (idle lane); ONLY the exhaustion read fails.
    stubAgentRun({ sessions: [] });
    mockPrisma.codingSchedule = {
      findMany: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        if (w.userId && w.kind === 'recurring' && w.enabled === false) return [deadRow]; // (c) scan
        if (w.sessionId?.in && w.runsCount?.gte === 1) throw new Error('db down'); // exhaustion probe
        if (w.sessionId?.in && w.enabled === true) return []; // no enabled rows
        return [];
      }),
    };
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentText()).toMatch(/cadence stopped/i);
    expect(sentText()).toMatch(/12 runs/);
  });

  it('a pre-fix card for a now-suppressed lane AUTO-RESOLVES (review N3): its state entry is pruned with no "expired unresolved" line', async () => {
    // The 03:11Z card already posted pre-fix — its state entry lingers in the
    // Redis hash with notified:1. Post-fix the item never enters the pending
    // set (vanishedUnresolved has no cadence suppression branch — a healthy
    // lane is a RESOLUTION, not an expiry), so the entry is pruned silently:
    // the card stops recurring and never reports as expired-unresolved.
    // Mirrors the b101ad89 park pin (:968–988) for the busy/exhausted class.
    stubLane();
    const CARD = 'ff53cbf4-0000-4000-8000-000000000001';
    hashStores[`attn-watchdog:state:${OWNER}`] = {
      [`cadence:${CARD}`]: JSON.stringify({
        firstSeenMs: T0.getTime() - 45 * 60000, notified: 1,
        kind: 'cadence_stopped', title: 'Schooltime Hue-backlog',
        detail: 'recurring schedule stopped after 4 runs — intentional?',
      }),
    };
    stubSchedules([atCapRow(CARD), atCapRow(SCH_B)], [], { [LANE]: [atCapRow(CARD), atCapRow(SCH_B)] });
    stubAgentRun({ sessions: [{ sessionId: LANE }] }); // running — the suppression that post-dates the card
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockRedis.hDel).toHaveBeenCalledWith(`attn-watchdog:state:${OWNER}`, [`cadence:${CARD}`]);
    expect(sentText()).not.toMatch(/cadence stopped|intentional|expired/i);
  });

  it('kill switch WATCHDOG_CADENCE_STOP_FIX_DISABLED=1 restores the pre-fix flagging (the specimen cards again)', async () => {
    process.env.WATCHDOG_CADENCE_STOP_FIX_DISABLED = '1';
    try {
      stubLane();
      stubSchedules([atCapRow(SCH_A), atCapRow(SCH_B)], [], { [LANE]: [atCapRow(SCH_A), atCapRow(SCH_B)] });
      stubAgentRun({ sessions: [{ sessionId: LANE }] }); // even while RUNNING
      await runAttentionWatchdogOnce({ now: T0 });
      expect(sentText()).toMatch(/cadence stopped/i);
    } finally {
      delete process.env.WATCHDOG_CADENCE_STOP_FIX_DISABLED;
    }
  });
});


// ── deaf_assignee (2026-08-30 Post-CPT incident: a cancelled monitor + a
//    compacted-away re-arm note left an assigned todo's lane deaf through the
//    very trigger it was watching for) ─────────────────────────────────────
describe('deaf-assignee detection', () => {
  const DEAF_CHAT = 'c-deaf';
  const liveTodo = (over: any = {}) => ({
    id: 't-deaf', title: 'P0 — re-bench with the finished CPT checkpoint', status: 'pending',
    assigneeChatId: DEAF_CHAT, updatedAt: new Date(T0.getTime() - 30 * 3600_000),
    goal: { status: 'active' }, ...over,
  });
  // Sections (c)/(d)/(e) share codingSchedule.findMany with the (f) enabled-rows
  // probe — only (f) filters by sessionId-in + enabled.
  const stubScheduleScans = (assigneeEnabledRows: any[]) => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn().mockImplementation(async (args: any) =>
        args?.where?.sessionId?.in ? assigneeEnabledRows : []),
    };
  };
  const stubChats = (updatedAt: Date) =>
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
      return [{ id: DEAF_CHAT, title: 'Post-CPT Coordination', updatedAt }];
    });
  const sentContent = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');

  it('a pending todo whose assignee has no enabled schedule and 24h+ silence surfaces as deaf_assignee', async () => {
    stubChats(new Date(T0.getTime() - 30 * 3600_000));
    mockPrisma.projectTodo.findMany.mockResolvedValue([liveTodo()]);
    stubScheduleScans([]);
    await runAttentionWatchdogOnce({ now: T0 });
    const sent = sentContent();
    expect(sent).toMatch(/DEAF/);
    expect(sent).toContain('Post-CPT Coordination');
    expect(sent).toContain('re-bench with the finished CPT checkpoint');
  });

  it('suppressed when the assignee still has an enabled schedule', async () => {
    stubChats(new Date(T0.getTime() - 30 * 3600_000));
    mockPrisma.projectTodo.findMany.mockResolvedValue([liveTodo()]);
    stubScheduleScans([{ sessionId: DEAF_CHAT }]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentContent()).not.toMatch(/DEAF/);
  });

  it('suppressed when the assignee was active within the last 24h', async () => {
    stubChats(new Date(T0.getTime() - 3600_000));
    mockPrisma.projectTodo.findMany.mockResolvedValue([liveTodo()]);
    stubScheduleScans([]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentContent()).not.toMatch(/DEAF/);
  });

  it('suppressed for todos under a done/archived goal and for blocked todos', async () => {
    stubChats(new Date(T0.getTime() - 30 * 3600_000));
    mockPrisma.projectTodo.findMany.mockResolvedValue([
      liveTodo({ id: 't-done', goal: { status: 'done' } }),
      liveTodo({ id: 't-blocked', status: 'blocked' }),
    ]);
    stubScheduleScans([]);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentContent()).not.toMatch(/DEAF/);
  });
});

// ── cadence_vanished (ticket bd954d27: schedule hard-deleted, no audit trail) ──
describe('cadence-vanished detection', () => {
  const SNAP_PREFIX = 'attn-watchdog:schedsnap:';
  const baseline = (rows: Array<[string, number, string, boolean]>) =>
    JSON.stringify(Object.fromEntries(rows.map(([id, r, s, e]) => [id, { r, s, e }])));
  const stubScans = (currentRows: any[]) => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([]) // cadence-stopped scan: nothing recently disabled
        .mockResolvedValueOnce([]) // overdue scan: nothing overdue
        .mockResolvedValue(currentRows), // snapshot scan: what exists now
    };
  };
  const sentContent = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');

  beforeEach(() => {
    mockRedis.set = jest.fn(async () => 'OK');
    // Keep the runner's supervisor lookup shape ({id, userId}) intact — a
    // blanket mockResolvedValue starves sweepUser of userId.
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) =>
      args?.where?.isSupervisor === true ? [{ id: SUP, userId: OWNER }] : [{ id: 'chat1', title: 'TT-RD' }]);
  });

  it('first sweep with no baseline only writes the snapshot — never alerts', async () => {
    stubScans([{ id: 'sch1', sessionId: 'chat1', enabled: true, runsCount: 5 }]);
    mockRedis.get.mockResolvedValue(null); // no baseline
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining(SNAP_PREFIX), expect.any(String), { EX: 604800 },
    );
    expect(sentContent()).not.toMatch(/VANISHED without a cancel/i);
  });

  it('an enabled recurring schedule with history now ABSENT from the DB alerts VANISHED without a cancel', async () => {
    stubScans([]); // sch1 is gone entirely
    mockRedis.get.mockImplementation(async (key: string) =>
      String(key).startsWith(SNAP_PREFIX) ? baseline([['sch1', 73, 'chat1', true]]) : null);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentContent()).toMatch(/VANISHED without a cancel/i);
    expect(sentContent()).toMatch(/73 runs/);
  });

  it('a row last seen DISABLED (later reaped by the 30d terminal GC) does NOT alert', async () => {
    stubScans([]);
    mockRedis.get.mockImplementation(async (key: string) =>
      String(key).startsWith(SNAP_PREFIX) ? baseline([['sch1', 200, 'chat1', false]]) : null);
    await runAttentionWatchdogOnce({ now: T0 });
    expect(sentContent()).not.toMatch(/VANISHED without a cancel/i);
  });

  it('a schedule still present does not alert; an enabled row with NO history does not alert', async () => {
    stubScans([
      { id: 'sch1', sessionId: 'chat1', enabled: true, runsCount: 74 },
      { id: 'sch2', sessionId: 'chat1', enabled: true, runsCount: 0 },
    ]);
    mockRedis.get.mockImplementation(async (key: string) =>
      String(key).startsWith(SNAP_PREFIX)
        ? baseline([['sch1', 73, 'chat1', true], ['sch2', 0, 'chat1', true], ['sch3', 0, 'chat1', true]])
        : null);
    await runAttentionWatchdogOnce({ now: T0 });
    // sch1 still present; sch3 vanished but had 0 runs (never fired — not the ticket's class)
    expect(sentContent()).not.toMatch(/VANISHED/i);
  });

  it('quiet-hours hold: a vanish detected at night still posts in the morning (review Finding 1)', async () => {
    // Stateful plain-key store for the snapshot — persists across sweeps,
    // alongside the existing hash-store state (hGetAll/hSet).
    const plain: Record<string, string> = {
      [`${SNAP_PREFIX}${OWNER}`]: baseline([['sch1', 73, 'chat1', true]]),
    };
    mockRedis.get.mockImplementation(async (key: string) => plain[String(key)] ?? null);
    mockRedis.set.mockImplementation(async (key: string, value: string) => {
      plain[String(key)] = value;
      return 'OK';
    });
    // sch1 absent from the DB on every scan of every sweep below.
    mockPrisma.codingSchedule = { findMany: jest.fn().mockResolvedValue([]) };

    // 1. Night sweep (23:30 PDT — quiet): detects the vanish but HOLDS it…
    await runAttentionWatchdogOnce({ now: T_QUIET });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    // …and the snapshot KEEPS the vanished row (carry-forward), instead of
    // rewriting it away (the bug that silently dropped the overnight class).
    expect(JSON.parse(plain[`${SNAP_PREFIX}${OWNER}`])).toHaveProperty('sch1');

    // 2. Morning sweep (07:05 PDT): re-detects from the carried row → posts.
    await runAttentionWatchdogOnce({ now: T_MORNING });
    expect(sentContent()).toMatch(/VANISHED without a cancel/i);
    expect(sentContent()).toMatch(/73 runs/);

    // 3. Next sweep after delivery: carry stops (notified=1) — no re-post,
    // and the row drops out of the snapshot so the state can prune.
    await runAttentionWatchdogOnce({ now: new Date(T_MORNING.getTime() + 15 * 60000) });
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(plain[`${SNAP_PREFIX}${OWNER}`])).not.toHaveProperty('sch1');
  });
});

// ── overdue_cadence (overnight forensics 2026-08-24, fix 1): the sweeper-missed
//    class — ENABLED recurring rows whose nextRunAt is stuck far in the past. ──
describe('overdue-cadence detection', () => {
  it('an ENABLED recurring schedule overdue past 2× its interval surfaces as overdue_cadence', async () => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([]) // (c) cadence-stopped scan: nothing recently disabled
        .mockResolvedValueOnce([{ // (d) overdue scan: 3h past due on a 1h cadence (grace = 2h)
          id: 'sch-ov', sessionId: 'chat1', intervalSec: 3600,
          nextRunAt: new Date(T0.getTime() - 3 * 3600_000), runsCount: 12,
        }]),
    };
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'chat1', title: 'Tenstorrent R&D' }]);
    await runAttentionWatchdogOnce({ now: T0 });
    const sent = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
    expect(sent).toMatch(/schedule overdue — sweeper may be stuck/);
    expect(sent).toContain('⏰');
    expect(sent).toContain('12 runs so far');
  });

  it('stays quiet while the overdue-ness is within the grace window (max(2×interval, 30min))', async () => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn()
        .mockResolvedValueOnce([]) // (c) scan
        .mockResolvedValueOnce([{ // 90min past due on a 1h cadence — under the 2h grace
          id: 'sch-ov', sessionId: 'chat1', intervalSec: 3600,
          nextRunAt: new Date(T0.getTime() - 90 * 60_000), runsCount: 12,
        }]),
    };
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'chat1', title: 'Tenstorrent R&D' }]);
    await runAttentionWatchdogOnce({ now: T0 });
    const sent = mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
    expect(sent).not.toMatch(/schedule overdue/i);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
  });
});

// ── Supervisor note scan (2026-09-02 value upgrade): stuck-loop backstop +
//    harness-written telemetry over the supervisor chat's machine-wake notes ──
describe('supervisor note scan', () => {
  const CURSOR_KEY = `attn-watchdog:notecursor:${OWNER}`;
  const NUDGE_KEY = `attn-watchdog:stucknudge:${OWNER}`;

  /** A machine-wake note row (newest-first arrays match the DB's desc order). */
  const note = (id: string, content: string, minutesAgo: number, origin = 'schedule') => ({
    id, content, createdAt: new Date(T0.getTime() - minutesAgo * 60_000), metadata: { origin },
  });
  /** Re-narrated sweep note: same words, only ids/timestamps differ (n) —
   *  exactly the loop the backstop exists to break. */
  const repeatNote = (n: number) =>
    `**Fleet sweep — ${n}:04 PM PDT: all lanes green**\n\n| Lane | Status | Detail |\n|---|---|---|\n| Benchmarks c9ccf88${n} | ✅ healthy | firing 23:1${n}Z |\n\nNo owner items this sweep. Next sweep in 2h.`;

  const nudgePosts = () =>
    mockPrisma.crossModelMessage.create.mock.calls.filter((c: any[]) => c[0].data.metadata?.kind === 'stuck-note-nudge');

  /** Stateful plain-key store (get/set/del) so fingerprints/cursors survive
   *  across sweeps within a test — the hash-store pattern, plain keys. */
  let plainStore: Record<string, string>;
  beforeEach(() => {
    plainStore = {};
    mockRedis.get.mockImplementation(async (k: string) => plainStore[String(k)] ?? null);
    mockRedis.set.mockImplementation(async (k: string, v: string) => { plainStore[String(k)] = String(v); return 'OK'; });
    mockRedis.del.mockImplementation(async (k: string) => { delete plainStore[String(k)]; return 1; });
  });

  describe('stuck-loop backstop', () => {
    it('3 near-identical machine notes → ONE [WATCHDOG] nudge on the watchdog channel; the same streak never re-nudges', async () => {
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m3-33333333', repeatNote(3), 10),
        note('m2-22222222', repeatNote(2), 130, 'hook'),
        note('m1-11111111', repeatNote(1), 250),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });

      const posts = nudgePosts();
      expect(posts).toHaveLength(1);
      expect(posts[0][0].data).toMatchObject({
        chatId: SUP,
        role: 'assistant',
        content: STUCK_NUDGE_TEXT,
        metadata: { origin: 'attention-watchdog', kind: 'stuck-note-nudge' },
      });
      expect(posts[0][0].data.content).toContain('[WATCHDOG]');
      expect(posts[0][0].data.content).toContain('act or stand down');
      expect(plainStore[NUDGE_KEY]).toBeTruthy(); // streak fingerprint stored

      // Second sweep, notes unchanged (the supervisor hasn't woken yet) —
      // the fingerprint dedupes: still exactly ONE nudge.
      await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 15 * 60_000) });
      expect(nudgePosts()).toHaveLength(1);
    });

    it('a broken streak clears the fingerprint, so a later re-stick nudges again', async () => {
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m3-33333333', repeatNote(3), 10),
        note('m2-22222222', repeatNote(2), 130),
        note('m1-11111111', repeatNote(1), 250),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(nudgePosts()).toHaveLength(1);

      // The supervisor posts a genuinely different note → streak broken.
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m4-44444444', 'ACTIONS TAKEN\n- steered the Benchmarks lane back to the perf goal — msg ab12cd34', 5),
        note('m3-33333333', repeatNote(3), 10),
        note('m2-22222222', repeatNote(2), 130),
      ]);
      await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 15 * 60_000) });
      expect(nudgePosts()).toHaveLength(1); // no new nudge
      expect(plainStore[NUDGE_KEY]).toBeUndefined(); // fingerprint cleared

      // …and a NEW identical-note streak later re-nudges.
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m7-77777777', repeatNote(7), 1),
        note('m6-66666666', repeatNote(6), 2),
        note('m5-55555555', repeatNote(5), 3),
      ]);
      await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 30 * 60_000) });
      expect(nudgePosts()).toHaveLength(2);
    });

    it('3 identical compliant no-op one-liners never nudge — quiet is the contract, not a loop', async () => {
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m3-33333333', 'SWEEP: no-op (nothing changed)', 10),
        note('m2-22222222', 'SWEEP: no-op (nothing changed)', 130),
        note('m1-11111111', 'SWEEP: no-op (nothing changed)', 250),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(nudgePosts()).toHaveLength(0);
    });

    it('varied notes never nudge', async () => {
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m3-33333333', 'ACTIONS TAKEN\n- dispatched a fix session for the flaky deploy gate — session 1a2b3c4d', 10),
        note('m2-22222222', repeatNote(2), 130),
        note('m1-11111111', 'WAKE: no-op (run 9f8e7d6c, nothing changed)', 250),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(nudgePosts()).toHaveLength(0);
    });

    it('non-machine rows (watchdog notices, user-turn replies) never count toward the streak', async () => {
      // Three identical CONTENTS, but only two are machine-wake notes — the
      // third is a watchdog notice: below the 3-note bar, no nudge.
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('w1-99999999', repeatNote(1), 5, 'attention-watchdog'),
        note('m2-22222222', repeatNote(2), 130),
        note('m1-11111111', repeatNote(1), 250),
        { id: 'u1-88888888', content: repeatNote(1), createdAt: new Date(T0.getTime() - 300 * 60_000), metadata: {} },
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(nudgePosts()).toHaveLength(0);
    });

    it('the nudge posts even during quiet hours (machine-directed — overnight is when a stuck loop burns unattended)', async () => {
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m3-33333333', repeatNote(3), 10),
        note('m2-22222222', repeatNote(2), 130),
        note('m1-11111111', repeatNote(1), 250),
      ]);
      await runAttentionWatchdogOnce({ now: T_QUIET });
      expect(nudgePosts()).toHaveLength(1);
    });
  });

  describe('harness-written note telemetry (classification wiring)', () => {
    it('a missing cursor only SEEDS — it never backfills history (the snapshot-baseline pattern)', async () => {
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m2-22222222', 'ACTIONS TAKEN\n- steered — msg ab12cd34', 10),
        note('m1-11111111', repeatNote(1), 130),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(recordLoopMetric).not.toHaveBeenCalled();
      expect(plainStore[CURSOR_KEY]).toBe(String(T0.getTime() - 10 * 60_000)); // newest note's ts
    });

    it('classifies each note newer than the cursor (oldest first) and advances the cursor', async () => {
      plainStore[CURSOR_KEY] = String(T0.getTime() - 200 * 60_000); // between m1 and m2
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('m3-33333333', 'WAKE: no-op (run 9f8e7d6c, nothing changed)', 10),
        note('m2-22222222', 'ACTIONS TAKEN\n- re-armed the Post-CPT monitor — sched 5e6f7a8b', 130, 'hook'),
        note('m1-11111111', repeatNote(1), 250), // older than the cursor — already counted
      ]);
      await runAttentionWatchdogOnce({ now: T0 });

      expect(recordLoopMetric).toHaveBeenCalledTimes(2);
      // oldest fresh note first (m2), newest last (m3)
      expect((recordLoopMetric as jest.Mock).mock.calls[0][0]).toMatchObject({
        kind: 'supervisor_action', sessionId: SUP, meta: { messageId: 'm2-22222', origin: 'hook' },
      });
      expect((recordLoopMetric as jest.Mock).mock.calls[1][0]).toMatchObject({
        kind: 'supervisor_noop', sessionId: SUP, meta: { messageId: 'm3-33333', origin: 'schedule' },
      });
      // classification is delegated to supervisor.service's pure classifier
      // (2 telemetry calls here + 1 more by the stuck-backstop's no-op exemption check)
      expect(classifySupervisorNote).toHaveBeenCalledWith('ACTIONS TAKEN\n- re-armed the Post-CPT monitor — sched 5e6f7a8b');
      expect(classifySupervisorNote).toHaveBeenCalledWith('WAKE: no-op (run 9f8e7d6c, nothing changed)');
      // cursor advanced to the newest note
      expect(plainStore[CURSOR_KEY]).toBe(String(T0.getTime() - 10 * 60_000));

      // Next sweep with nothing new → nothing re-recorded.
      await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 15 * 60_000) });
      expect(recordLoopMetric).toHaveBeenCalledTimes(2);
    });

    it('non-machine rows are never classified', async () => {
      plainStore[CURSOR_KEY] = String(T0.getTime() - 200 * 60_000);
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        note('w1-99999999', 'watchdog notice content', 5, 'attention-watchdog'),
        note('m2-22222222', 'a substantive machine note about goal movement toward the release', 10),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(recordLoopMetric).toHaveBeenCalledTimes(1);
      expect((recordLoopMetric as jest.Mock).mock.calls[0][0]).toMatchObject({ meta: { messageId: 'm2-22222' } });
    });

    it('a note-scan DB failure is isolated — the rest of the sweep still runs', async () => {
      mockPrisma.crossModelMessage.findMany.mockRejectedValue(new Error('db down'));
      mockRedis.mGet.mockResolvedValue([questionEntry(), null]); // a pending question downstream
      await expect(runAttentionWatchdogOnce({ now: T0 })).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('supervisor note scan failed'));
      expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1); // the attention notice
    });
  });

  // HARNESS-RECEIPTS-AND-CLAIMS (supervisor SOTA round 3, 2026-10-20): a note stamped with
  // the harness count is classified from the harness record; the stuck backstop judges the
  // model's OWN words (a zero-call narration carries the harness no-op line, which must not
  // exempt the repeated narration the backstop exists to break).
  describe('harness record (metadata.harnessActions)', () => {
    const stamped = (id: string, content: string, minutesAgo: number, harnessActions: number, mode = 'actions') => ({
      ...note(id, content, minutesAgo, 'hook'), metadata: { origin: 'hook', harnessActions, harnessReceipts: { v: 1, mode, reportUps: 0, notExecuted: 0, modelBlockLines: 2 } },
    });

    it('the harness count wins over the markers (classifiedBy harness); an unstamped row keeps the regex', async () => {
      plainStore[CURSOR_KEY] = String(T0.getTime() - 200 * 60_000);
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        stamped('m3-33333333', 'WAKE: no-op — nothing moved\n\nACTIONS TAKEN (harness):\n- send_chat_message → chat 1a2b3c4d · receipt 5e6f7a8b', 10, 1),
        stamped('m2-22222222', 'Long narration of the fleet state.\n\nWAKE: no-op (harness: 0 lane actions)', 60, 0, 'noop'),
        note('m1-11111111', 'ACTIONS TAKEN\n- steered — msg ab12cd34', 130, 'hook'),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      const rows = (recordLoopMetric as jest.Mock).mock.calls.map((c: any[]) => c[0]).filter((r: any) => /^supervisor_/.test(r.kind));
      expect(rows.map((r: any) => [r.kind, r.meta.classifiedBy ?? null])).toEqual([
        ['supervisor_action', null],
        ['supervisor_noop', 'harness'],
        ['supervisor_action', 'harness'],
      ]);
    });

    it('3 near-identical zero-call narrations still get the ONE nudge — the harness no-op line does not exempt them', async () => {
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        stamped('m3-33333333', `${repeatNote(3)}\n\nWAKE: no-op (harness: 0 lane actions)`, 10, 0, 'noop'),
        stamped('m2-22222222', `${repeatNote(2)}\n\nWAKE: no-op (harness: 0 lane actions)`, 130, 0, 'noop'),
        stamped('m1-11111111', `${repeatNote(1)}\n\nWAKE: no-op (harness: 0 lane actions)`, 250, 0, 'noop'),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(nudgePosts()).toHaveLength(1);
    });

    // Review fix (2026-10-20): the harness action lines (tool names + 8-char ids the tokenizer drops) can no
    // longer keep three ACTING wakes apart the way the model's own differing action lines did — a wake the
    // harness recorded as acting breaks the streak; zero-action narration is still the streak above.
    it('3 near-identical notes from wakes that really ACTED (harnessActions > 0) get no stuck nudge', async () => {
      const acted = (lane: string) => `ACTIONS TAKEN (harness):\n- send_chat_message → chat ${lane} · receipt d24c4c9b`;
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        stamped('m3-33333333', `${repeatNote(3)}\n\n${acted('1a2b3c4d')}`, 10, 1),
        stamped('m2-22222222', `${repeatNote(2)}\n\n${acted('5e6f7a8b')}`, 130, 1),
        stamped('m1-11111111', `${repeatNote(1)}\n\n${acted('9c8d7e6f')}`, 250, 1),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(nudgePosts()).toHaveLength(0);
      // ONE acting wake in the window is enough to break the streak.
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([
        stamped('m3-33333333', `${repeatNote(3)}\n\nWAKE: no-op (harness: 0 lane actions)`, 10, 0, 'noop'),
        stamped('m2-22222222', `${repeatNote(2)}\n\n${acted('5e6f7a8b')}`, 130, 1),
        stamped('m1-11111111', `${repeatNote(1)}\n\nWAKE: no-op (harness: 0 lane actions)`, 250, 0, 'noop'),
      ]);
      await runAttentionWatchdogOnce({ now: T0 });
      expect(nudgePosts()).toHaveLength(0);
    });

    it('kill switch SUPERVISOR_HARNESS_RECEIPTS_DISABLED=1: markers only (the harness no-op line then exempts, as any no-op marker did)', async () => {
      process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
      try {
        plainStore[CURSOR_KEY] = String(T0.getTime() - 200 * 60_000);
        mockPrisma.crossModelMessage.findMany.mockResolvedValue([
          stamped('m3-33333333', `${repeatNote(3)}\n\nWAKE: no-op (harness: 0 lane actions)`, 10, 0, 'noop'),
          stamped('m2-22222222', 'Steered.\n\nACTIONS TAKEN (harness):\n- todo_update → todo 1 · receipt 2', 130, 1),
          stamped('m1-11111111', repeatNote(1), 250, 0, 'noop'),
        ]);
        await runAttentionWatchdogOnce({ now: T0 });
        const rows = (recordLoopMetric as jest.Mock).mock.calls.map((c: any[]) => c[0]).filter((r: any) => /^supervisor_/.test(r.kind));
        expect(rows.every((r: any) => r.meta.classifiedBy === undefined)).toBe(true);
        expect(nudgePosts()).toHaveLength(0);
      } finally {
        delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
      }
    });
  });

  describe('similarity helpers (pure)', () => {
    it('re-narrations differing only in ids/timestamps/table chrome are near-identical', () => {
      expect(noteSimilarity(repeatNote(1), repeatNote(2))).toBeGreaterThanOrEqual(STUCK_NOTE_SIMILARITY);
      expect(noteSimilarity(repeatNote(1), repeatNote(1))).toBe(1);
    });

    it('genuinely different notes are dissimilar', () => {
      expect(
        noteSimilarity(repeatNote(1), 'ACTIONS TAKEN\n- dispatched a coding session to fix the deploy gate flake — session 1a2b3c4d'),
      ).toBeLessThan(STUCK_NOTE_SIMILARITY);
    });

    it('detectStuckNotes needs STUCK_NOTE_COUNT consecutive near-identical notes', () => {
      expect(STUCK_NOTE_COUNT).toBe(3);
      expect(detectStuckNotes([repeatNote(1), repeatNote(2), repeatNote(3)])).toBe(true);
      expect(detectStuckNotes([repeatNote(1), repeatNote(2)])).toBe(false);
      expect(detectStuckNotes([repeatNote(1), 'completely different content about a new deploy incident', repeatNote(3)])).toBe(false);
      expect(detectStuckNotes([])).toBe(false);
    });
  });
});

/* ====================================================================
 * P3 remediation — v1#15 / spark G9 / CanLaw B13: the OUTAGE class
 * (overdue_cadence = sweeper-stall) bypasses quiet hours and pushes to the
 * owner's Telegram; P3 pin 14d + the per-lane deaf floor.
 * ==================================================================== */
const mockTgIsConfigured = jest.fn((..._a: any[]) => true);
const mockTgSend = jest.fn(async (..._a: any[]) => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: (...a: any[]) => mockTgIsConfigured(...a),
  sendMessage: (...a: any[]) => mockTgSend(...a),
}));

describe('v1#15 — outage class bypasses quiet hours + owner Telegram push', () => {
  const QUIET_NOW = new Date('2026-08-23T09:00:00Z'); // 2am PDT — deep quiet hours
  const overdueRow = {
    id: 'sch-stall', sessionId: 'chat1', intervalSec: 900,
    nextRunAt: new Date(QUIET_NOW.getTime() - 2 * 3600_000), runsCount: 40,
  };
  const stubScans = () => {
    mockPrisma.codingSchedule = {
      findMany: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        if (w.enabled === true && w.nextRunAt?.lte) return [overdueRow]; // (d) overdue scan
        return [];
      }),
    };
  };
  const sentSupervisor = () =>
    mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');

  beforeEach(() => {
    mockTgIsConfigured.mockReturnValue(true);
    mockTgSend.mockResolvedValue(true);
    mockPrisma.telegramLink = { findUnique: jest.fn(async () => ({ chatId: 'tg-1' })) };
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) =>
      args?.where?.isSupervisor === true ? [{ id: SUP, userId: OWNER }] : [{ id: 'chat1', title: 'Stalled Lane' }]);
    stubScans();
  });

  it('a sweeper-stall detection POSTS during quiet hours AND pushes to the owner Telegram', async () => {
    await runAttentionWatchdogOnce({ now: QUIET_NOW });
    // The supervisor notice posted despite quiet hours…
    const sent = sentSupervisor();
    expect(sent).toMatch(/schedule overdue — sweeper may be stuck/);
    expect(sent).toContain('pushed to your Telegram');
    // …and the Telegram push named the stalled lane.
    expect(mockTgSend).toHaveBeenCalledTimes(1);
    const [tgChat, tgText] = mockTgSend.mock.calls[0];
    expect(tgChat).toBe('tg-1');
    expect(tgText).toContain('STALLED');
    expect(tgText).toContain('Stalled Lane');
  });

  it('Telegram unlinked: the supervisor note is the only delivery and SAYS so', async () => {
    mockPrisma.telegramLink.findUnique.mockResolvedValue(null);
    await runAttentionWatchdogOnce({ now: QUIET_NOW });
    expect(mockTgSend).not.toHaveBeenCalled();
    expect(sentSupervisor()).toContain('could NOT be pushed to Telegram');
  });

  it('non-outage items alone still hold during quiet hours (the bypass is outage-scoped)', async () => {
    mockPrisma.codingSchedule = { findMany: jest.fn(async () => []) }; // nothing overdue
    mockPrisma.projectGoal.findMany.mockResolvedValue([
      { id: 'g1', title: 'Blocked goal', blockedReason: 'x', updatedAt: new Date(QUIET_NOW.getTime() - 2 * 3600_000), project: null },
    ]);
    await runAttentionWatchdogOnce({ now: QUIET_NOW });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockTgSend).not.toHaveBeenCalled();
  });
});

describe('v1#15 + pin 14d — per-lane deaf floor on MACHINE activity', () => {
  const NOW = new Date('2026-08-22T19:00:00Z'); // non-quiet
  const DEAF = 'c-deaf2';
  const todo = {
    id: 't-x', title: 'Watch the trigger', status: 'pending', assigneeChatId: DEAF,
    updatedAt: new Date(NOW.getTime() - 3600_000), goal: { status: 'active' },
  };
  const stub = (opts: { intervalSec?: number; lastRunAgoMs?: number; chatUpdatedAgoMs: number }) => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) =>
      args?.where?.isSupervisor === true
        ? [{ id: SUP, userId: OWNER }]
        : [{ id: DEAF, title: 'Deaf Lane', updatedAt: new Date(NOW.getTime() - opts.chatUpdatedAgoMs) }]);
    mockPrisma.projectTodo.findMany.mockResolvedValue([todo]);
    mockPrisma.codingSchedule = {
      findMany: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        if (w.sessionId?.in && w.intervalSec) {
          return opts.intervalSec ? [{ sessionId: DEAF, intervalSec: opts.intervalSec }] : [];
        }
        return []; // no enabled rows anywhere; other scans quiet
      }),
    };
    mockPrisma.agentRun = {
      groupBy: jest.fn(async () =>
        opts.lastRunAgoMs != null ? [{ sessionId: DEAF, _max: { createdAt: new Date(NOW.getTime() - opts.lastRunAgoMs) } }] : []),
    };
  };
  const sent = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');

  it('deaf floor = 2× the lane\'s last interval: a 30-min lane is deaf after ~65 min of machine silence — not 24h', async () => {
    stub({ intervalSec: 1800, lastRunAgoMs: 65 * 60_000, chatUpdatedAgoMs: 5 * 60_000 });
    await runAttentionWatchdogOnce({ now: NOW });
    // chat.updatedAt was FRESH (a notice bump) — the machine clock governs (pin 14d).
    expect(sent()).toMatch(/DEAF/);
  });

  it('inside the floor (45 min < 60 min) the lane is NOT deaf yet', async () => {
    stub({ intervalSec: 1800, lastRunAgoMs: 45 * 60_000, chatUpdatedAgoMs: 45 * 60_000 });
    await runAttentionWatchdogOnce({ now: NOW });
    expect(sent()).not.toMatch(/DEAF/);
  });

  it('no interval history keeps the conservative 24h default (a 2h-silent lane stays quiet)', async () => {
    stub({ lastRunAgoMs: 2 * 3600_000, chatUpdatedAgoMs: 2 * 3600_000 });
    await runAttentionWatchdogOnce({ now: NOW });
    expect(sent()).not.toMatch(/DEAF/);
  });

  // audit 2026-10-06 T4-1 (fleet.md F3/F6): a one-shot's 900 s interval set a
  // 30-min deaf floor; only RECURRING history defines the lane's cadence.
  const stubOnceOnly = () => {
    stub({ lastRunAgoMs: 2 * 3600_000, chatUpdatedAgoMs: 2 * 3600_000 });
    mockPrisma.codingSchedule.findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (w.sessionId?.in && w.intervalSec) {
        const rows = [{ sessionId: DEAF, intervalSec: 900, kind: 'once' }];
        return w.kind ? rows.filter((r) => r.kind === w.kind) : rows;
      }
      return [];
    });
  };
  it('T4-1: a one-shot\'s intervalSec is not the lane cadence — only-once history keeps the 24h default floor', async () => {
    stubOnceOnly();
    await runAttentionWatchdogOnce({ now: NOW });
    expect(sent()).not.toMatch(/DEAF/);
  });
  it('T4-1 kill switch WATCHDOG_RECURRING_CADENCE_DISABLED=1: the one-shot interval sets the floor again (2h silence ⇒ DEAF)', async () => {
    process.env.WATCHDOG_RECURRING_CADENCE_DISABLED = '1';
    try {
      stubOnceOnly();
      await runAttentionWatchdogOnce({ now: NOW });
      expect(sent()).toMatch(/DEAF/);
    } finally {
      delete process.env.WATCHDOG_RECURRING_CADENCE_DISABLED;
    }
  });
});

/* audit 2026-10-06 T3-9 (fleet F6): the StAnne lane f150100b was flagged DEAF six
 * times — once per todo — while its runs were executing. A lane with a QUEUED or
 * RUNNING agent run is working, not deaf; and a deaf lane is ONE item naming its
 * waiting todos. Kill switch WATCHDOG_DEAF_LANE_FIX_DISABLED=1 restores both. */
describe('audit 2026-10-06 T3-9 — deaf lanes: running check + one item per lane', () => {
  const NOW = new Date('2026-08-22T19:00:00Z'); // non-quiet
  const LANE = 'c-stanne';
  const todos = [1, 2, 3].map((i) => ({
    id: `t-${i}`, title: `Build step ${i}`, status: 'pending', assigneeChatId: LANE,
    updatedAt: new Date(NOW.getTime() - 3600_000), goal: { status: 'active' },
  }));
  const stub = (running: boolean) => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) =>
      args?.where?.isSupervisor === true ? [{ id: SUP, userId: OWNER }] : [{ id: LANE, title: 'StAnne Lane', updatedAt: new Date(NOW.getTime() - 5 * 60_000) }]);
    mockPrisma.projectTodo.findMany.mockResolvedValue(todos);
    mockPrisma.codingSchedule = {
      findMany: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        if (w.sessionId?.in && w.intervalSec) return [{ sessionId: LANE, intervalSec: 900 }];
        return [];
      }),
    };
    mockPrisma.agentRun = {
      // the lane's LAST run STARTED 4 h ago (a long build) …
      groupBy: jest.fn(async () => [{ sessionId: LANE, _max: { createdAt: new Date(NOW.getTime() - 4 * 3600_000) } }]),
      // … and it is still running (or not).
      findMany: jest.fn(async () => (running ? [{ sessionId: LANE }] : [])),
    };
  };
  const sent = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
  afterEach(() => { delete process.env.WATCHDOG_DEAF_LANE_FIX_DISABLED; });

  it('a lane whose run is still executing is NOT deaf', async () => {
    stub(true);
    await runAttentionWatchdogOnce({ now: NOW });
    expect(sent()).not.toMatch(/DEAF/);
    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: { in: [LANE] }, status: { in: ['queued', 'running'] } } }));
  });

  it('an idle deaf lane with three waiting todos is ONE item ("1 deaf lane", "3 todos wait here")', async () => {
    stub(false);
    await runAttentionWatchdogOnce({ now: NOW });
    const out = sent();
    expect(out).toMatch(/1 deaf lane\b/);
    expect(out).toContain('3 todos wait here');
    expect(out.match(/DEAF/g)?.length).toBe(1);
  });

  it('kill switch: the running lane is flagged again, once per todo', async () => {
    process.env.WATCHDOG_DEAF_LANE_FIX_DISABLED = '1';
    stub(true);
    await runAttentionWatchdogOnce({ now: NOW });
    expect(sent()).toMatch(/3 deaf lanes/);
  });
});

/* ARCHIVED-TARGET-RETIRE (e, 2026-10-20): a live todo assigned to an ARCHIVED
 * lane (archivedAt stamped — absent from the visible chat list — or its coding
 * satellite parked 'archived') is ORPHANED, not deaf and not skipped as a
 * "deleted assignee": it will never run. ONE item per lane. Kill switch
 * ARCHIVED_TARGET_RETIRE_DISABLED=1 restores the skip. */
describe('ARCHIVED-TARGET-RETIRE (e) — archived assignees are reported as orphaned', () => {
  const NOW = new Date('2026-08-22T19:00:00Z'); // non-quiet
  const ARCH = 'c-archived';
  const VIS = 'c-satellite';
  const todos = (assignee: string) => [1, 2].map((i) => ({
    id: `t-${assignee}-${i}`, title: `Bank result ${i}`, status: 'pending', assigneeChatId: assignee,
    updatedAt: new Date(NOW.getTime() - 3 * 3600_000), goal: { status: 'active' },
  }));
  const stub = (opts: { assignee: string; stamped?: any[]; visible?: any[]; parked?: any[] }) => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (w.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
      if (w.archivedAt && w.archivedAt.not === null) return opts.stamped ?? [];
      return opts.visible ?? [];
    });
    mockPrisma.projectTodo.findMany.mockResolvedValue(todos(opts.assignee));
    mockPrisma.codingSchedule = { findMany: jest.fn(async () => []) };
    mockPrisma.agentRun = { groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []) };
    mockPrisma.chatCodingState = { findMany: jest.fn(async () => opts.parked ?? []) };
  };
  const sent = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0].data.content).join('\n');
  afterEach(() => {
    delete process.env.ARCHIVED_TARGET_RETIRE_DISABLED;
    delete mockPrisma.chatCodingState;
  });

  it('an archivedAt-stamped assignee (not in the visible list) is ONE orphaned item naming its todos — never deaf, never silently skipped', async () => {
    stub({ assignee: ARCH, stamped: [{ id: ARCH, title: 'Retired spark lane', archivedAt: new Date(NOW.getTime() - 26 * 3600_000), project: { supervised: true } }] });
    await runAttentionWatchdogOnce({ now: NOW });
    const out = sent();
    expect(out).toMatch(/1 orphaned lane\b/);
    expect(out).toContain('Retired spark lane');
    expect(out).toContain('ARCHIVED (orphaned');
    expect(out).toContain('2 todos are assigned here');
    expect(out).not.toMatch(/DEAF/);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: OWNER, id: { in: [ARCH] }, archivedAt: { not: null } } }));
  });

  it('a SATELLITE-archived assignee (still visible) is orphaned too, not deaf; an unsupervised project is opted out', async () => {
    stub({ assignee: VIS, visible: [{ id: VIS, title: 'Parked session', updatedAt: new Date(NOW.getTime() - 30 * 3600_000) }], parked: [{ id: VIS, status: 'archived', updatedAt: new Date(NOW.getTime() - 2 * 3600_000) }] });
    await runAttentionWatchdogOnce({ now: NOW });
    expect(sent()).toMatch(/1 orphaned lane\b/);
    expect(sent()).not.toMatch(/DEAF/);

    mockPrisma.crossModelMessage.create.mockClear();
    hashStores = {};
    stub({ assignee: ARCH, stamped: [{ id: ARCH, title: 'Opted out', archivedAt: new Date(NOW.getTime() - 26 * 3600_000), project: { supervised: false } }] });
    await runAttentionWatchdogOnce({ now: NOW });
    expect(sent()).not.toMatch(/orphaned/);
  });

  it('kill switch ARCHIVED_TARGET_RETIRE_DISABLED=1: the archived assignee is skipped as before (no orphaned item, no query)', async () => {
    process.env.ARCHIVED_TARGET_RETIRE_DISABLED = '1';
    stub({ assignee: ARCH, stamped: [{ id: ARCH, title: 'Retired spark lane', archivedAt: new Date(NOW.getTime() - 26 * 3600_000), project: { supervised: true } }] });
    await runAttentionWatchdogOnce({ now: NOW });
    expect(sent()).not.toMatch(/orphaned/);
    expect(mockPrisma.chatCodingState.findMany).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * Zombie machine-run stop (live incident 2026-09-10): the Fleet Supervisor
 * chat sat silent ~10h behind a machine run stuck inside one step — its
 * heartbeat-refreshed cm:liverun lock busy-skipped every schedule firing and
 * nothing alarmed. Pins: the zombie shape triggers stop + GUARD_STRIKE once;
 * fresh notes/journal keep the lane untouched; a user-value lock is NEVER
 * stopped; the NX dedupe prevents a repeat inside its window and is released
 * when the stop flag fails to land. chat-busy is REAL here (config/redis is
 * the mocked boundary), so the lock-value discrimination is the real code.
 * ==================================================================== */
describe('zombie machine-run stop (live incident 2026-09-10)', () => {
  const NOW = new Date('2026-08-22T19:00:00Z'); // non-quiet (the stop is machine-directed and ignores quiet hours anyway)
  const NX_KEY = `attn-watchdog:zombiestop:${SUP}`;

  /** Plain-key store with REAL SET NX semantics (the dedupe under test). */
  let plain: Record<string, string>;
  /** cm:liverun values by full key — what getMachineLockedChatIds reads. */
  let liveValues: Record<string, string>;

  const machineNote = (chatId: string, minutesAgo: number) => ({
    id: `mn-${chatId}`, content: `Fleet sweep over ${chatId} — lanes reviewed.`,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000), metadata: { origin: 'schedule' },
  });
  const stopFlagSets = () =>
    mockRedis.set.mock.calls.filter((c: any[]) => String(c[0]).startsWith('cm:liverun:stop:'));
  const zombieStrikes = () =>
    (recordLoopMetric as jest.Mock).mock.calls.filter(
      (c: any[]) => c[0]?.kind === 'guard_strike' && c[0]?.meta?.seam === 'zombie_run_stop');

  beforeEach(() => {
    plain = {};
    liveValues = {};
    mockRedis.get.mockImplementation(async (k: string) => plain[String(k)] ?? null);
    mockRedis.set.mockImplementation(async (k: string, v: string, opts?: any) => {
      if (opts?.NX && plain[String(k)] !== undefined) return null; // real SET NX contract
      plain[String(k)] = String(v);
      return 'OK';
    });
    mockRedis.del.mockImplementation(async (k: string) => { delete plain[String(k)]; return 1; });
    mockRedis.mGet.mockImplementation(async (keys: string[]) => keys.map((k) => liveValues[String(k)] ?? null));
    mockPrisma.runJournalEntry = { findFirst: jest.fn(async () => null) };
    mockPrisma.codingSchedule = { findMany: jest.fn(async () => []) }; // no cadences → the 3h fallback governs
    // The zombie chat IS the supervisor chat — the incident's exact shape.
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) =>
      args?.where?.isSupervisor === true ? [{ id: SUP, userId: OWNER }] : [{ id: SUP, title: 'Fleet Supervisor' }]);
    // One machine note, 10h old — far past the 3h no-cadence fallback.
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([machineNote(SUP, 10 * 60)]);
  });

  it('the incident shape — machine lock + 10h machine silence → stop flag + ONE guard_strike (seam zombie_run_stop) + honest warn', async () => {
    liveValues[`cm:liverun:${SUP}`] = '4242:machine';
    await runAttentionWatchdogOnce({ now: NOW });

    // (1) the stop flag the run's heartbeat polls — the manual incident fix, automated.
    expect(stopFlagSets()).toEqual([[`cm:liverun:stop:${SUP}`, '1', { EX: 120 }]]);
    // (NX dedupe armed for the window)
    const nxCall = mockRedis.set.mock.calls.find((c: any[]) => c[0] === NX_KEY);
    expect(nxCall[2]).toEqual({ NX: true, EX: ZOMBIE_STOP_DEDUPE_SEC });
    // (2) the chartable strike.
    const strikes = zombieStrikes();
    expect(strikes).toHaveLength(1);
    expect(strikes[0][0]).toMatchObject({
      kind: 'guard_strike', sessionId: SUP,
      meta: { seam: 'zombie_run_stop', chatId: SUP, silentMinutes: 600 },
    });
    // (3) the honest log.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ZOMBIE machine run stopped'));
  });

  it('fresh machine notes keep the lane untouched (a live run inside its pulse is not a zombie)', async () => {
    liveValues[`cm:liverun:${SUP}`] = '4242:machine';
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([machineNote(SUP, 30)]);
    await runAttentionWatchdogOnce({ now: NOW });
    expect(stopFlagSets()).toHaveLength(0);
    expect(zombieStrikes()).toHaveLength(0);
    expect(plain[NX_KEY]).toBeUndefined();
  });

  it('fresh JOURNAL activity alone also keeps the lane untouched (either activity source counts)', async () => {
    liveValues[`cm:liverun:${SUP}`] = '4242:machine';
    mockPrisma.runJournalEntry.findFirst.mockResolvedValue({ createdAt: new Date(NOW.getTime() - 20 * 60_000) });
    await runAttentionWatchdogOnce({ now: NOW });
    expect(stopFlagSets()).toHaveLength(0);
    expect(zombieStrikes()).toHaveLength(0);
  });

  it('a user-value lock is NEVER stopped — bare pid and explicit non-machine labels alike, however silent', async () => {
    for (const userValue of ['4242', '1:user']) {
      liveValues[`cm:liverun:${SUP}`] = userValue;
      await runAttentionWatchdogOnce({ now: NOW });
    }
    expect(stopFlagSets()).toHaveLength(0);
    expect(zombieStrikes()).toHaveLength(0);
  });

  it('no machine note and no journal entry → skip (the watchdog never fabricates a silence claim from absent evidence)', async () => {
    liveValues[`cm:liverun:${SUP}`] = '4242:machine';
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      { id: 'w1', content: 'watchdog notice', createdAt: new Date(NOW.getTime() - 600 * 60_000), metadata: { origin: 'attention-watchdog' } },
    ]);
    await runAttentionWatchdogOnce({ now: NOW });
    expect(stopFlagSets()).toHaveLength(0);
    expect(zombieStrikes()).toHaveLength(0);
  });

  it('NX dedupe: the SAME zombie is stopped once per window — a second sweep neither re-stops nor re-strikes', async () => {
    liveValues[`cm:liverun:${SUP}`] = '4242:machine';
    await runAttentionWatchdogOnce({ now: NOW });
    await runAttentionWatchdogOnce({ now: new Date(NOW.getTime() + 15 * 60_000) });
    expect(stopFlagSets()).toHaveLength(1);
    expect(zombieStrikes()).toHaveLength(1);
  });

  it('a stop flag that fails to land releases the NX dedupe (no fabricated strike) and the next sweep retries', async () => {
    liveValues[`cm:liverun:${SUP}`] = '4242:machine';
    let failStop = true;
    mockRedis.set.mockImplementation(async (k: string, v: string, opts?: any) => {
      if (String(k).startsWith('cm:liverun:stop:') && failStop) throw new Error('redis blip');
      if (opts?.NX && plain[String(k)] !== undefined) return null;
      plain[String(k)] = String(v);
      return 'OK';
    });

    await runAttentionWatchdogOnce({ now: NOW });
    expect(zombieStrikes()).toHaveLength(0); // the stop never landed — no strike claimed
    expect(plain[NX_KEY]).toBeUndefined(); // dedupe released for the retry
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('stop flag failed to land'));

    failStop = false;
    await runAttentionWatchdogOnce({ now: new Date(NOW.getTime() + 15 * 60_000) });
    expect(zombieStrikes()).toHaveLength(1); // retried and landed
    expect(plain[`cm:liverun:stop:${SUP}`]).toBe('1');
  });

  it('the silence floor is 3× the lane\'s SHORTEST enabled cadence: a 2h-cadence lane is a zombie past 6h, not before', async () => {
    liveValues[`cm:liverun:${SUP}`] = '4242:machine';
    mockPrisma.codingSchedule.findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (w.sessionId?.in && w.enabled === true) {
        return [{ sessionId: SUP, intervalSec: 14400 }, { sessionId: SUP, intervalSec: 7200 }]; // shortest = 2h → floor 6h
      }
      return [];
    });

    mockPrisma.crossModelMessage.findMany.mockResolvedValue([machineNote(SUP, 4 * 60)]); // 4h < 6h
    await runAttentionWatchdogOnce({ now: NOW });
    expect(zombieStrikes()).toHaveLength(0);

    mockPrisma.crossModelMessage.findMany.mockResolvedValue([machineNote(SUP, 7 * 60)]); // 7h > 6h
    await runAttentionWatchdogOnce({ now: NOW });
    expect(zombieStrikes()).toHaveLength(1);
    expect(zombieStrikes()[0][0].meta.silentMinutes).toBe(420);
  });

  // audit 2026-10-06 T4-1 (fleet.md F3): the owner-answer retry is kind:'once'
  // with intervalSec 180 — it shrank the Fleet's floor to 9 min and an 18-min
  // live run was stopped. Only RECURRING rows define the cadence now.
  it('T4-1: a ONE-SHOT row\'s intervalSec is not a cadence — a 180 s once retry beside a 2h recurring sweep keeps the 6h floor', async () => {
    liveValues[`cm:liverun:${SUP}`] = '4242:machine';
    const whereSeen: any[] = [];
    mockPrisma.codingSchedule.findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (w.sessionId?.in && w.enabled === true) {
        whereSeen.push(w);
        return [{ sessionId: SUP, intervalSec: 180, kind: 'once' }, { sessionId: SUP, intervalSec: 7200, kind: 'recurring' }];
      }
      return [];
    });
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([machineNote(SUP, 18)]); // the incident: 18 min silent
    await runAttentionWatchdogOnce({ now: NOW });
    expect(zombieStrikes()).toHaveLength(0);
    expect(stopFlagSets()).toHaveLength(0);
    expect(whereSeen[0]).toMatchObject({ kind: 'recurring' });

    mockPrisma.crossModelMessage.findMany.mockResolvedValue([machineNote(SUP, 7 * 60)]); // past 3×2h
    await runAttentionWatchdogOnce({ now: NOW });
    expect(zombieStrikes()).toHaveLength(1);
    expect(zombieStrikes()[0][0].meta).toMatchObject({ silentMinutes: 420, floorMinutes: 360 });
  });

  it('T4-1 kill switch WATCHDOG_RECURRING_CADENCE_DISABLED=1 restores the any-kind cadence read (the incident shape stops again)', async () => {
    process.env.WATCHDOG_RECURRING_CADENCE_DISABLED = '1';
    try {
      liveValues[`cm:liverun:${SUP}`] = '4242:machine';
      mockPrisma.codingSchedule.findMany.mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        if (w.sessionId?.in && w.enabled === true) {
          expect(w.kind).toBeUndefined();
          return [{ sessionId: SUP, intervalSec: 180 }, { sessionId: SUP, intervalSec: 7200 }];
        }
        return [];
      });
      mockPrisma.crossModelMessage.findMany.mockResolvedValue([machineNote(SUP, 18)]);
      await runAttentionWatchdogOnce({ now: NOW });
      expect(zombieStrikes()).toHaveLength(1);
    } finally {
      delete process.env.WATCHDOG_RECURRING_CADENCE_DISABLED;
    }
  });

  it('busy-skip candidacy: a NON-supervisor machine-locked lane with busySkips ≥ 10 on an enabled schedule is checked and stopped', async () => {
    const LANE = 'c-lane';
    mockPrisma.codingSchedule.findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (w.busySkips?.gte === ZOMBIE_BUSY_SKIPS_MIN) return [{ sessionId: LANE }]; // candidate scan
      if (w.sessionId?.in && w.enabled === true) return [{ sessionId: LANE, intervalSec: 900 }]; // 15m → floor 45m
      return [];
    });
    liveValues[`cm:liverun:${LANE}`] = '77:machine'; // the SUPERVISOR holds no lock here
    mockPrisma.crossModelMessage.findMany.mockImplementation(async (args: any) =>
      args?.where?.chatId === LANE ? [machineNote(LANE, 120)] : [machineNote(SUP, 5)]);

    await runAttentionWatchdogOnce({ now: NOW });
    expect(stopFlagSets()).toEqual([[`cm:liverun:stop:${LANE}`, '1', { EX: 120 }]]);
    expect(zombieStrikes()).toHaveLength(1);
    expect(zombieStrikes()[0][0]).toMatchObject({ sessionId: LANE, meta: { chatId: LANE, silentMinutes: 120 } });
  });

  it('tunables pinned: skips ≥10, floor 3×cadence, fallback 3h, dedupe 2h', () => {
    expect(ZOMBIE_BUSY_SKIPS_MIN).toBe(10);
    expect(ZOMBIE_SILENCE_MULTIPLIER).toBe(3);
    expect(ZOMBIE_SILENCE_FALLBACK_MS).toBe(3 * 60 * 60 * 1000);
    expect(ZOMBIE_STOP_DEDUPE_SEC).toBe(2 * 60 * 60);
  });
});

// ── Project-supervisor preflight 2026-09-14: the note scan also covers every
//    isProjectSupervisor lane — per-chat keys, meta.projectId, streaks OBSERVED
//    (guard_strike row) never nudged. The fleet chat's scan is untouched. ──────
describe('project supervisor note scan (preflight 2026-09-14)', () => {
  const PSUP = 'psup-chat';
  const PROJ = 'proj-alpha';
  const FLEET_CURSOR = `attn-watchdog:notecursor:${OWNER}`;
  const note = (id: string, content: string, minutesAgo: number, origin = 'schedule') => ({
    id, content, createdAt: new Date(T0.getTime() - minutesAgo * 60_000), metadata: { origin },
  });
  const repeatNote = (n: number) =>
    `**Alpha sweep — ${n}:04 PM PDT: shards grinding**\n\n| Lane | Status |\n|---|---|\n| bench c9ccf88${n} | ✅ | firing 23:1${n}Z |\n\nNothing to steer. Next sweep in 1h.`;
  const metricCalls = () => (recordLoopMetric as jest.Mock).mock.calls.map((c: any[]) => c[0]);
  const nudgePosts = () => mockPrisma.crossModelMessage.create.mock.calls.filter((c: any[]) => c[0].data.metadata?.kind === 'stuck-note-nudge');

  let plainStore: Record<string, string>;
  let notesByChat: Record<string, any[]>;
  beforeEach(() => {
    plainStore = {};
    notesByChat = {};
    mockRedis.get.mockImplementation(async (k: string) => plainStore[String(k)] ?? null);
    mockRedis.set.mockImplementation(async (k: string, v: string) => { plainStore[String(k)] = String(v); return 'OK'; });
    mockRedis.del.mockImplementation(async (k: string) => { delete plainStore[String(k)]; return 1; });
    // The user's chats now carry a project supervisor lane beside the fleet chat.
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
      return [
        { id: CHAT, title: 'Design Brochure', projectId: null },
        { id: SUP, title: 'Fleet Supervisor', projectId: null },
        { id: PSUP, title: 'Alpha Supervisor', projectId: PROJ, isProjectSupervisor: true },
      ];
    });
    mockPrisma.crossModelMessage.findMany.mockImplementation(async (args: any) => notesByChat[String(args?.where?.chatId)] ?? []);
  });

  it('classifies the project lane\'s fresh notes under its OWN cursor key with meta.projectId; the fleet chat keeps its legacy key', async () => {
    plainStore[PROJECT_NOTE_CURSOR_KEY(OWNER, PSUP)] = String(T0.getTime() - 200 * 60_000);
    plainStore[FLEET_CURSOR] = String(T0.getTime() - 200 * 60_000);
    notesByChat[PSUP] = [
      note('p3-33333333', 'WAKE: no-op (nothing changed)', 10),
      note('p2-22222222', 'ACTIONS TAKEN\n- re-dispatched shard 5 to a fresh worker — msg ab12cd34', 130, 'hook'),
      note('p1-11111111', repeatNote(1), 250), // older than the cursor
    ];
    notesByChat[SUP] = [note('f1-11111111', 'ACTIONS TAKEN\n- nudged Alpha Supervisor — msg 9988aabb', 5)];

    await runAttentionWatchdogOnce({ now: T0 });

    const project = metricCalls().filter((m) => m.sessionId === PSUP);
    expect(project.map((m) => m.kind)).toEqual(['supervisor_action', 'supervisor_noop']); // oldest fresh first
    for (const m of project) expect(m.meta).toMatchObject({ projectId: PROJ });
    expect(project[0].meta).toMatchObject({ messageId: 'p2-22222', origin: 'hook' });
    // Fleet row: unchanged shape, NO projectId stamp.
    const fleet = metricCalls().filter((m) => m.sessionId === SUP);
    expect(fleet).toHaveLength(1);
    expect(fleet[0].meta.projectId).toBeUndefined();
    // Cursors advanced independently.
    expect(plainStore[PROJECT_NOTE_CURSOR_KEY(OWNER, PSUP)]).toBe(String(T0.getTime() - 10 * 60_000));
    expect(plainStore[FLEET_CURSOR]).toBe(String(T0.getTime() - 5 * 60_000));
  });

  // ── wake-cadence-5 (2026-09-27 tt-rd audit): a project-lane wake whose ONLY
  //    ok:true lane-facing receipt is a send_chat_message to the Fleet
  //    Supervisor is classified supervisor_report_up, not supervisor_action
  //    (259 of 306 tt-rd supervisor messages went UP and every one counted
  //    as work). Deterministic receipt window = previous note → this note. ──
  describe('report-up classification (wake-cadence-5)', () => {
    const { findFleetSupervisorChat } = jest.requireMock('../platform/supervisor.service');
    let receiptsByWindow: Array<{ tool: string; ok: boolean; ids: any; createdAt: Date }>;
    beforeEach(() => {
      delete process.env.SUPERVISOR_REPORT_UP_IS_ACTION;
      (findFleetSupervisorChat as jest.Mock).mockResolvedValue({ id: SUP, title: 'Fleet Supervisor', userId: OWNER });
      receiptsByWindow = [];
      mockPrisma.runToolReceipt.findMany.mockImplementation(async (args: any) => {
        const gt: Date | undefined = args?.where?.createdAt?.gt;
        const lte: Date = args?.where?.createdAt?.lte;
        return receiptsByWindow.filter((r) => r.createdAt.getTime() <= lte.getTime() && (!gt || r.createdAt.getTime() > gt.getTime()));
      });
      plainStore[PROJECT_NOTE_CURSOR_KEY(OWNER, PSUP)] = String(T0.getTime() - 200 * 60_000);
      plainStore[FLEET_CURSOR] = String(T0.getTime() - 200 * 60_000);
    });
    afterEach(() => { delete process.env.SUPERVISOR_REPORT_UP_IS_ACTION; (findFleetSupervisorChat as jest.Mock).mockResolvedValue(null); });
    const at = (minutesAgo: number) => new Date(T0.getTime() - minutesAgo * 60_000);

    it('pure: receiptsAreReportUpOnly — only Fleet-Supervisor sends ⇒ true; any lane-facing action ⇒ false; reads alone ⇒ false', () => {
      expect(receiptsAreReportUpOnly([{ tool: 'send_chat_message', ok: true, ids: { chatId: SUP } }], SUP)).toBe(true);
      expect(receiptsAreReportUpOnly([{ tool: 'send_chat_message', ok: true, ids: { chatId: SUP } }, { tool: 'get_chat_status', ok: true, ids: { chatId: 'lane' } }, { tool: 'update_supervisor_state', ok: true, ids: {} }], SUP)).toBe(true);
      expect(receiptsAreReportUpOnly([{ tool: 'send_chat_message', ok: true, ids: { chatId: SUP } }, { tool: 'send_chat_message', ok: true, ids: { chatId: 'lane-1' } }], SUP)).toBe(false);
      expect(receiptsAreReportUpOnly([{ tool: 'send_chat_message', ok: true, ids: { chatId: SUP } }, { tool: 'todo_update', ok: true, ids: { todoId: 't1' } }], SUP)).toBe(false);
      expect(receiptsAreReportUpOnly([{ tool: 'send_chat_message', ok: false, ids: { chatId: SUP } }], SUP)).toBe(false); // staged/failed sends are not report-ups
      expect(receiptsAreReportUpOnly([{ tool: 'get_chat_status', ok: true, ids: {} }], SUP)).toBe(false);
      expect(receiptsAreReportUpOnly([], SUP)).toBe(false);
      expect(SUPERVISOR_LANE_ACTION_TOOLS.has('start_coding_session')).toBe(true);
      expect(SUPERVISOR_LANE_ACTION_TOOLS.has('update_supervisor_state')).toBe(false);
    });

    it('THE tt-rd shape: an ACTIONS TAKEN note whose window holds only a send to the Fleet Supervisor ⇒ supervisor_report_up (meta.reportUp); a wake with a lane steer stays supervisor_action', async () => {
      notesByChat[PSUP] = [
        note('p3-33333333', 'ACTIONS TAKEN\n- reported deltas to the Fleet Supervisor — msg 1234abcd', 10),
        note('p2-22222222', 'ACTIONS TAKEN\n- steered lane ddd26be0 to time-box the ladder — msg ab12cd34', 70, 'hook'),
        note('p1-11111111', 'WAKE: no-op', 130),
      ];
      receiptsByWindow = [
        { tool: 'send_chat_message', ok: true, ids: { chatId: 'ddd26be0' }, createdAt: at(72) }, // p2's wake: a lane steer
        { tool: 'send_chat_message', ok: true, ids: { chatId: SUP }, createdAt: at(71) },
        { tool: 'send_chat_message', ok: true, ids: { chatId: SUP }, createdAt: at(12) }, // p3's wake: report-up only
        { tool: 'get_chat_status', ok: true, ids: { chatId: 'ddd26be0' }, createdAt: at(11) },
      ];
      await runAttentionWatchdogOnce({ now: T0 });
      const project = metricCalls().filter((m) => m.sessionId === PSUP);
      expect(project.map((m) => m.kind)).toEqual(['supervisor_noop', 'supervisor_action', 'supervisor_report_up']);
      expect(project[2].meta).toMatchObject({ messageId: 'p3-33333', reportUp: true, projectId: PROJ });
      expect(project[1].meta.reportUp).toBeUndefined();
      // The receipt window is the previous note → this note.
      const p3Query = mockPrisma.runToolReceipt.findMany.mock.calls.find((c: any[]) => c[0].where.createdAt.lte.getTime() === at(10).getTime())![0];
      expect(p3Query.where).toMatchObject({ chatId: PSUP, ok: true, createdAt: { gt: at(70), lte: at(10) } });
    });

    it('SUPERVISOR_REPORT_UP_IS_ACTION=1 restores the old classification; the fleet chat itself is never re-keyed; a receipt read error falls back to supervisor_action', async () => {
      notesByChat[PSUP] = [note('p3-33333333', 'ACTIONS TAKEN\n- reported up — msg 1234abcd', 10)];
      notesByChat[SUP] = [note('f1-11111111', 'ACTIONS TAKEN\n- nudged Alpha Supervisor — msg 9988aabb', 5)];
      receiptsByWindow = [{ tool: 'send_chat_message', ok: true, ids: { chatId: SUP }, createdAt: at(12) }];
      process.env.SUPERVISOR_REPORT_UP_IS_ACTION = '1';
      await runAttentionWatchdogOnce({ now: T0 });
      expect(metricCalls().filter((m) => m.sessionId === PSUP).map((m) => m.kind)).toEqual(['supervisor_action']);
      expect(metricCalls().filter((m) => m.sessionId === SUP).map((m) => m.kind)).toEqual(['supervisor_action']);
      expect(mockPrisma.runToolReceipt.findMany).not.toHaveBeenCalled();
      delete process.env.SUPERVISOR_REPORT_UP_IS_ACTION;
      (recordLoopMetric as jest.Mock).mockClear();
      plainStore[PROJECT_NOTE_CURSOR_KEY(OWNER, PSUP)] = String(T0.getTime() - 200 * 60_000);
      mockPrisma.runToolReceipt.findMany.mockRejectedValue(new Error('db down'));
      await runAttentionWatchdogOnce({ now: T0 });
      expect(metricCalls().filter((m) => m.sessionId === PSUP).map((m) => m.kind)).toEqual(['supervisor_action']);
    });
  });

  it('a missing project-lane cursor only SEEDS (never backfills) — same baseline discipline as the fleet chat', async () => {
    notesByChat[PSUP] = [note('p2-22222222', 'ACTIONS TAKEN\n- steered — msg ab12cd34', 10), note('p1-11111111', repeatNote(1), 130)];
    await runAttentionWatchdogOnce({ now: T0 });
    expect(metricCalls().filter((m) => m.sessionId === PSUP)).toHaveLength(0);
    expect(plainStore[PROJECT_NOTE_CURSOR_KEY(OWNER, PSUP)]).toBe(String(T0.getTime() - 10 * 60_000));
  });

  it('3 near-identical project-lane notes → ONE observed guard_strike (seam stuck_note_streak, outcome observed, projectId), NO nudge posted; the streak dedupes by fingerprint', async () => {
    notesByChat[PSUP] = [note('p3-33333333', repeatNote(3), 10), note('p2-22222222', repeatNote(2), 70, 'hook'), note('p1-11111111', repeatNote(1), 130)];

    await runAttentionWatchdogOnce({ now: T0 });

    expect(nudgePosts()).toHaveLength(0); // observe-only on project lanes
    const strikes = metricCalls().filter((m) => m.kind === 'guard_strike' && m.meta?.seam === STUCK_NOTE_STREAK_SEAM);
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ sessionId: PSUP, meta: { seam: 'stuck_note_streak', outcome: 'observed', chatId: PSUP, projectId: PROJ } });
    expect(plainStore[PROJECT_STUCK_KEY(OWNER, PSUP)]).toBeTruthy();

    // Same streak next sweep → no second row.
    await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 15 * 60_000) });
    expect(metricCalls().filter((m) => m.kind === 'guard_strike' && m.meta?.seam === STUCK_NOTE_STREAK_SEAM)).toHaveLength(1);

    // Streak broken → fingerprint cleared (a later re-stick observes again).
    notesByChat[PSUP] = [note('p4-44444444', 'ACTIONS TAKEN\n- re-dispatched shard 5 — msg ab12cd34', 1), ...notesByChat[PSUP]];
    await runAttentionWatchdogOnce({ now: new Date(T0.getTime() + 30 * 60_000) });
    expect(plainStore[PROJECT_STUCK_KEY(OWNER, PSUP)]).toBeUndefined();
  });

  it('the fleet chat still gets its [WATCHDOG] nudge on a streak while the project lane in the same sweep does not (no regression)', async () => {
    notesByChat[SUP] = [note('f3-33333333', repeatNote(3), 10), note('f2-22222222', repeatNote(2), 70), note('f1-11111111', repeatNote(1), 130)];
    notesByChat[PSUP] = [note('p3-33333333', repeatNote(3), 10), note('p2-22222222', repeatNote(2), 70), note('p1-11111111', repeatNote(1), 130)];
    await runAttentionWatchdogOnce({ now: T0 });
    const posts = nudgePosts();
    expect(posts).toHaveLength(1);
    expect(posts[0][0].data.chatId).toBe(SUP);
  });

  it('a project-lane scan failure is isolated — the fleet scan and the notice sweep still run', async () => {
    mockPrisma.crossModelMessage.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.chatId === PSUP) throw new Error('db hiccup');
      return notesByChat[String(args?.where?.chatId)] ?? [];
    });
    plainStore[FLEET_CURSOR] = String(T0.getTime() - 200 * 60_000);
    notesByChat[SUP] = [note('f1-11111111', 'ACTIONS TAKEN\n- nudged — msg 9988aabb', 5)];
    await runAttentionWatchdogOnce({ now: T0 });
    expect(metricCalls().filter((m) => m.sessionId === SUP)).toHaveLength(1);
    expect((logger.warn as jest.Mock).mock.calls.some((c: any[]) => /project-supervisor note scan failed/.test(String(c[0])))).toBe(true);
  });

  it('a project-supervisor chat with no projectId (detached lane) is skipped; bound pinned', () => {
    expect(MAX_PROJECT_SUPERVISORS_PER_USER).toBe(50);
  });

  it('detached lanes (projectId null) are never scanned', async () => {
    mockPrisma.crossModelChat.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.isSupervisor === true) return [{ id: SUP, userId: OWNER }];
      return [{ id: SUP, title: 'Fleet Supervisor', projectId: null }, { id: PSUP, title: 'Orphan Supervisor', projectId: null, isProjectSupervisor: true }];
    });
    notesByChat[PSUP] = [note('p3-33333333', repeatNote(3), 10), note('p2-22222222', repeatNote(2), 70), note('p1-11111111', repeatNote(1), 130)];
    await runAttentionWatchdogOnce({ now: T0 });
    expect(mockPrisma.crossModelMessage.findMany.mock.calls.some((c: any[]) => c[0]?.where?.chatId === PSUP)).toBe(false);
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// The stuck-note NUDGE asks the supervisor to act — pointless while its switch
// is off: the streak is still detected and fingerprinted (no replay on
// re-enable) but no nudge row is posted; one supervisor_switch skip (source
// watchdog) records it.
import { recordLoopMetric as mockedRecordLoopMetric } from '../platform/loop-metrics.service';
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests } from '../platform/supervisor-switch';

describe('supervisor OFF switch × watchdog stuck-note nudge', () => {
  const swNote = (id: string, content: string, minutesAgo: number, origin = 'schedule') => ({
    id, content, createdAt: new Date(T0.getTime() - minutesAgo * 60_000), metadata: { origin },
  });
  const swRepeat = (n: number) =>
    `**Fleet sweep — ${n}:04 PM PDT: all lanes green**\n\n| Lane | Status | Detail |\n|---|---|---|\n| Benchmarks c9ccf88${n} | ✅ healthy | firing 23:1${n}Z |\n\nNo owner items this sweep. Next sweep in 2h.`;
  const nudgePosts = () => mockPrisma.crossModelMessage.create.mock.calls.filter((c: any[]) => c[0].data.metadata?.kind === 'stuck-note-nudge');
  let plainStore: Record<string, string>;
  beforeEach(() => {
    plainStore = {};
    mockRedis.get.mockImplementation(async (k: string) => plainStore[String(k)] ?? null);
    mockRedis.set.mockImplementation(async (k: string, v: string) => { plainStore[String(k)] = String(v); return 'OK'; });
    mockRedis.del.mockImplementation(async (k: string) => { delete plainStore[String(k)]; return 1; });
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) => (where?.key === 'fleet_supervisor_enabled' ? { key: where.key, value: '0', updatedAt: T0 } : null));
    invalidateSupervisorSwitchCache();
    resetSupervisorSwitchMetricWindowForTests();
    mockPrisma.crossModelMessage.findMany.mockResolvedValue([
      swNote('m3-33333333', swRepeat(3), 10),
      swNote('m2-22222222', swRepeat(2), 130, 'hook'),
      swNote('m1-11111111', swRepeat(1), 250),
    ]);
  });
  afterAll(() => { mockPrisma.systemSetting.findUnique.mockImplementation(async () => null); invalidateSupervisorSwitchCache(); });

  it('fleet OFF: 3 near-identical notes post NO nudge; the fingerprint is stored; one skip row (source watchdog)', async () => {
    await runAttentionWatchdogOnce({ now: T0 });
    expect(nudgePosts()).toHaveLength(0);
    expect(plainStore[`attn-watchdog:stucknudge:${OWNER}`]).toBeTruthy();
    expect(mockedRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'supervisor_switch', sessionId: SUP,
      meta: expect.objectContaining({ target: 'fleet', action: 'skipped', source: 'watchdog', chatId: SUP }),
    }));
  });

  it('back ON (cache invalidated): the same streak nudges exactly once', async () => {
    mockPrisma.systemSetting.findUnique.mockImplementation(async () => null);
    invalidateSupervisorSwitchCache();
    await runAttentionWatchdogOnce({ now: T0 });
    expect(nudgePosts()).toHaveLength(1);
    expect(nudgePosts()[0][0].data.content).toContain('[WATCHDOG]');
  });
});
