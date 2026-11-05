/**
 * sched-sweep-doctrine-rebuild.test.ts — fire-time WIRING pins for the
 * trigger-keyed sweep-doctrine rebuild (R&D stream 3 experiment #2,
 * 2026-09-18) at its call site in fireScheduleTarget.
 *
 * The unit modes are pinned in platform/sweep-doctrine-rebuild.test.ts; this
 * file pins that a REAL firing through fireScheduleTarget:
 *   - probes the target lane's systemPrompt ONLY for stock sweep prompts
 *     (opener-keyed — non-sweep firings pay zero extra reads);
 *   - fires the SLIM body unchanged when the lane's system prompt carries the
 *     doctrine (the dedup win);
 *   - rebuilds the doctrine into the firing message when the lane's system
 *     prompt lacks it (NO wake runs doctrine-less) — including a probe READ
 *     ERROR, which resolves TOWARD doctrine;
 *   - passes a legacy pre-heal stored body through un-double-injected;
 *   - honours SWEEP_DOCTRINE_FORCE_INLINE=1.
 * Sweep prompts are synthetic stock-shaped strings built from the doctrine
 * leaf's opener constants — the trigger key is the opener prefix, so the
 * wiring is exercised identically without importing the service builders.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

// ── Prisma: the fire-path reads (chat lookup + stale-firing schedule re-read)
//    + the sweep-doctrine probe (a second crossModelChat.findUnique selecting
//    systemPrompt). ──
const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({
        enabled: true, kind: 'recurring', runsCount: 0, maxRuns: null, expiresAt: null, lastFiredAt: null,
      })),
      count: jest.fn(async () => 0),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    schedulePromptHistory: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
    agentRun: { findFirst: jest.fn(async () => null), create: jest.fn(async () => ({ id: 'run-1' })), count: jest.fn(async () => 0) },
  },
}));

// ── Redis stand-in: string store (cap state / probe notices) + hash store
//    (the infra-blocker registry — empty here). ──
const mockStore = new Map<string, string>();
const mockHash = new Map<string, Record<string, string>>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(async (k: string) => {
      const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
      mockStore.set(k, String(n));
      return n;
    }),
    expire: jest.fn(async () => true),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    getDel: jest.fn(async () => null),
    pTTL: jest.fn(async () => -2),
    publish: jest.fn(async () => 1),
    hGetAll: jest.fn(async (k: string) => ({ ...(mockHash.get(k) ?? {}) })),
    hSet: jest.fn(async () => 1),
    hDel: jest.fn(async () => 1),
  },
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]): Promise<any> => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEvent(...a),
}));

// The coding fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget) — the sweep
// lanes are plain chats, so every sweep firing lands here.
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
}));

// The terminal-stop resolver seam — no closed-ticket refs in these prompts.
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  getFeedbackTicketById: jest.fn(async () => null),
}));

jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  getPlanStrict: jest.fn(async () => ({ steps: [{ status: 'in_progress' }] })),
  applyPlan: jest.fn(),
  planToUpdate: jest.fn(),
  renderPlanReminder: jest.fn(() => ''),
}));

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { fireScheduleTarget } from './schedule.service';
// Layered prompts 2026-09-27: the doctrine set in force is sweepDoctrineBlocks
// (the generic core sections) — the pins below key on it.
import { sweepDoctrineBlock, sweepDoctrineBlocks } from '../platform/sweep-doctrine-rebuild';
import { SWEEP_PROMPT_OPENER, PROJECT_SWEEP_PROMPT_OPENER, DOCTRINE_PROBE_MARKER } from '../platform/supervisor-doctrine';

// A stored body written by the pre-layering builders (deleted in build 2026-10-08 S-2)
// still opens its doctrine with the probe marker — frozen fixture of that shape.
const LEGACY_INLINE_DOCTRINE = `${DOCTRINE_PROBE_MARKER} (bind every wake — read before acting)\n- legacy standing directives (frozen fixture)\n## Precedence (who decides what)\n- legacy fleet precedence rule (frozen fixture)`;

const CHAT = { userId: 'u1', mode: 'auto', codingState: null };
const DOCTRINE_SYS = `You are the Fleet Supervisor.\n\n${sweepDoctrineBlocks('fleet')[0]}\n\n…rest…`;
const SLIM_FLEET = `${SWEEP_PROMPT_OPENER} — a GOAL LEDGER diff, not a status bulletin.\n1. PULL the ledger: goal_list…`;
const SLIM_PROJECT = `${PROJECT_SWEEP_PROMPT_OPENER} for "crossmodel" (projectId p1) — a GOAL LEDGER diff.\n\n1. PULL the ledger: goal_list…`;

/** The lane lookup: the initial chat read (userId/mode/codingState) vs the
 *  doctrine probe (select systemPrompt) — answered per the given lane system
 *  prompt; 'throw' simulates a probe read error. */
function mockLane(systemPrompt: string | null | 'throw') {
  mockChatFindUnique.mockImplementation(async (args: any) => {
    if (args?.select?.systemPrompt) {
      if (systemPrompt === 'throw') throw new Error('db hiccup');
      return { systemPrompt };
    }
    return CHAT;
  });
}

function firedMessage(): string {
  expect(mockStartDetachedChatRun).toHaveBeenCalledTimes(1);
  return mockStartDetachedChatRun.mock.calls[0][0].message;
}

/** The doctrine-probe calls among ALL crossModelChat.findUnique reads (other
 *  fire-path stages read the chat too — the wiring pin is specifically the
 *  systemPrompt select, not the total). */
function probeCalls(): any[] {
  return mockChatFindUnique.mock.calls.filter((c) => c[0]?.select?.systemPrompt);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockHash.clear();
  delete process.env.SWEEP_DOCTRINE_FORCE_INLINE;
  mockLane(DOCTRINE_SYS);
});

describe('fireScheduleTarget — trigger-keyed sweep-doctrine rebuild', () => {
  it('slim fleet sweep + doctrine-carrying lane system prompt → the SLIM body fires unchanged (the dedup win), probed once', async () => {
    const res = await fireScheduleTarget({ id: 'sch_f1', sessionId: 'lane_fleet', prompt: SLIM_FLEET });
    expect(res.started).toBe(true);
    // The fired message = the rebuild's output (unchanged slim body) + the
    // fire path's own [SCHEDULE STATE] suffix — assert the rebuild left the
    // body untouched (prefix) and doctrine-free.
    expect(firedMessage().startsWith(SLIM_FLEET)).toBe(true);
    expect(firedMessage()).not.toContain(DOCTRINE_PROBE_MARKER);
    // Exactly one doctrine probe — the systemPrompt select on THIS lane.
    expect(probeCalls()).toHaveLength(1);
    expect(probeCalls()[0][0]).toEqual({ where: { id: 'lane_fleet' }, select: { systemPrompt: true } });
  });

  it('slim project sweep + doctrine-LESS lane system prompt → the doctrine is REBUILT into the firing (never doctrine-less)', async () => {
    mockLane('a fully customized system prompt with no standing doctrine');
    const res = await fireScheduleTarget({ id: 'sch_p1', sessionId: 'lane_proj', prompt: SLIM_PROJECT });
    expect(res.started).toBe(true);
    const msg = firedMessage();
    expect(msg.startsWith(PROJECT_SWEEP_PROMPT_OPENER)).toBe(true);
    for (const b of sweepDoctrineBlocks('project')) expect(msg).toContain(b);
    expect(msg).not.toContain(sweepDoctrineBlocks('fleet')[1]); // the fleet-voice precedence rule never rides a project firing
    // C6 placement (test-bench #3): the doctrine is the firing's absolute
    // SUFFIX — after the duties AND the [SCHEDULE STATE] appends — so the
    // user-role clip's retained 7,000c tail keeps it whole (the exp #2
    // after-opener placement let the clip elide it mid-block).
    expect(msg.indexOf(DOCTRINE_PROBE_MARKER)).toBeGreaterThan(msg.indexOf('1. PULL'));
    expect(msg.endsWith(sweepDoctrineBlock('project'))).toBe(true);
  });

  it('probe READ ERROR resolves TOWARD doctrine — the firing goes out with the doctrine inlined, never skipped', async () => {
    mockLane('throw');
    const res = await fireScheduleTarget({ id: 'sch_f2', sessionId: 'lane_fleet', prompt: SLIM_FLEET });
    expect(res.started).toBe(true);
    const msg = firedMessage();
    for (const b of sweepDoctrineBlocks('fleet')) expect(msg).toContain(b);
  });

  it('legacy pre-heal stored body (doctrine still inline) passes through un-double-injected', async () => {
    const legacy = `${SWEEP_PROMPT_OPENER} — a GOAL LEDGER diff.\n${LEGACY_INLINE_DOCTRINE}\n1. PULL the ledger…`;
    mockLane(null);
    await fireScheduleTarget({ id: 'sch_f3', sessionId: 'lane_fleet', prompt: legacy });
    const msg = firedMessage();
    // The rebuild left the body untouched (prefix — the [SCHEDULE STATE]
    // suffix is the fire path's own append) and injected NO second copy.
    expect(msg.startsWith(legacy)).toBe(true);
    expect(msg.split(DOCTRINE_PROBE_MARKER).length - 1).toBe(1);
  });

  it('SWEEP_DOCTRINE_FORCE_INLINE=1 rebuilds the doctrine into the firing even when the system prompt carries it', async () => {
    process.env.SWEEP_DOCTRINE_FORCE_INLINE = '1';
    await fireScheduleTarget({ id: 'sch_f4', sessionId: 'lane_fleet', prompt: SLIM_FLEET });
    const msg = firedMessage();
    for (const b of sweepDoctrineBlocks('fleet')) expect(msg).toContain(b);
    expect(msg.startsWith(SWEEP_PROMPT_OPENER)).toBe(true);
  });

  it('a NON-sweep firing is never probed — the lane systemPrompt select never happens', async () => {
    await fireScheduleTarget({ id: 'sch_n1', sessionId: 'lane_plain', prompt: 'check back on the outage' });
    expect(firedMessage().startsWith('check back on the outage')).toBe(true);
    expect(probeCalls()).toHaveLength(0);
  });

  it('a CUSTOMIZED sweep prompt (no stock opener) is never probed or touched', async () => {
    const custom = 'My own fleet sweep — pull the ledger and diff, my way';
    await fireScheduleTarget({ id: 'sch_n2', sessionId: 'lane_plain', prompt: custom });
    expect(firedMessage().startsWith(custom)).toBe(true);
    expect(probeCalls()).toHaveLength(0);
  });
});
