/**
 * Per-Project Supervisor agents (owner directives 2026-09-13 — OPT-IN,
 * pause-never-delete) — project-supervisor.service unit tests with mocked
 * Prisma. Pins: the gated scaffold (flag/isUserSpace/archived/owner/child),
 * first-creation shape (lane chat + full-autonomy grant at cap 480 + 60-min
 * sweep + ONE project-scope hook), idempotent self-heal (second ensure
 * creates nothing; drift heals; the toggle-on stock-hook re-enable), the
 * P2002 create-race convergence, pause (disable-only, ZERO deletes), the
 * watchdog heal (ensure missing / pause ineligible / stale-hook disable), the
 * detached-lane GC, and the NEVER-throws contract. Pattern follows
 * supervisor.service.test.ts (the fleet lane's suite).
 *
 * Hardening review 2026-09-14 pins: pause disables EVERY hook that wakes the
 * lane by exact id + records the ids (and is quiet when already paused);
 * toggle-ON resumes EXACTLY those ids (stock or customized) and reuses the
 * paused stock sweep row; the sweep ensure dedupes/heals only STOCK rows and
 * never deletes the lane's own re-arms; a NULL prompt heals to stock; the
 * prompt mandates both wake-close markers and describes only real
 * capabilities (no per-child hook, no cancel tool).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  user: { findUnique: jest.fn() },
  crossModelProject: { findUnique: jest.fn(), findMany: jest.fn() },
  crossModelChat: {
    findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(async () => null), create: jest.fn(), update: jest.fn(async () => ({})),
    // Pause-never-delete: these must NEVER be called by any lane lifecycle path.
    delete: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({ count: 0 })),
  },
  chatAutonomy: {
    findUnique: jest.fn(), upsert: jest.fn(async () => ({})), update: jest.fn(async () => ({})),
    deleteMany: jest.fn(async () => ({ count: 0 })),
  },
  codingSchedule: {
    findMany: jest.fn(), findFirst: jest.fn(async () => null), create: jest.fn(async () => ({})), update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 0 })), deleteMany: jest.fn(async () => ({ count: 0 })),
  },
  eventHook: {
    findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn(async () => ({})), update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 0 })), delete: jest.fn(async () => ({})), deleteMany: jest.fn(async () => ({ count: 0 })),
  },
  // Hardening review 2026-09-14: the pause audit row is the migration-free store
  // toggle-ON reads its exact hook/schedule ids from (resumeWhatPauseDisabled).
  activity: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  // Rollout watch 2026-09-14: stray coding-satellite strip (supervisor lanes are plain chats by design).
  chatCodingState: { findUnique: jest.fn(async () => null), delete: jest.fn(async () => ({})) },
  agentRun: { count: jest.fn(async () => 0), updateMany: jest.fn(async () => ({ count: 0 })) },
  // Supervisor OFF switch (owner 2026-09-26): null = no row = ON (every
  // pre-existing test untouched); the switch suite at the end sets '0'.
  systemSetting: { findUnique: jest.fn(async () => null) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
// config/redis is loaded LAZILY by supervisor-switch's skip counter on an OFF
// path only — the real module pulls config/env (process.exit without env vars).
const mockRedisIncr: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(async () => null), incr: (...a: any[]) => mockRedisIncr(...a), del: jest.fn(async () => 1) },
}));

// error-handler imports config/env, which calls process.exit(1) without env vars
// and kills the whole jest worker at import time — mock AppError (same shape).
// (Pulled in via autonomy.service, which supervisor.service imports for the
// grantable-tools constants + grant helpers.)
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// autonomy.service's static import of crossmodel.service drags the model
// integrations + DB/env chains — mock the boundary (supervisor.service only
// needs autonomy.service's constants + grant helpers, never the boundary).
jest.mock('../crossmodel.service', () => ({
  __esModule: true,
  default: { getChatAccess: jest.fn() },
}));

// coding/schedule.service is only reached via a DYNAMIC import inside the
// sweep-dedupe branch — mock just that export so the real module's
// hooks/redis import chain never loads in this suite.
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  emitScheduleDisabled: jest.fn(async () => undefined),
}));

// Goal-gate (ticket b1d435fd): the ensure/resume paths read this predicate.
// Default NOT dormant (every pre-existing test in this file runs on a live
// project); the b1d435fd describe below flips it per-case. The factory
// implementation survives jest.clearAllMocks.
const mockEvaluateProjectDormancy = jest.fn(async (..._a: any[]): Promise<any> => ({
  dormant: false, projectId: 'p1', reason: 'project "Apollo" has live work',
  signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
}));
jest.mock('../coding/dormancy-gate.service', () => ({
  __esModule: true,
  DORMANT_LAST_STATUS: 'parked:dormant',
  evaluateProjectDormancy: (...a: any[]) => mockEvaluateProjectDormancy(...a),
}));

import logger from '../../../utils/logger';
import {
  PROJECT_SUPERVISOR_PROMPT_OPENER,
  PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC,
  LEGACY_PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC,
  stripStrayCodingState,
  PROJECT_SUPERVISOR_SCHEDULE_CAP,
  PROJECT_SUPERVISOR_HOOK_EVENT_TYPES,
  stockProjectHookEventTypes,
  isStockProjectHookEventSet,
  PROJECT_SWEEP_PROMPT_OPENER,
  PROJECT_SWEEP_INTERVAL_SEC,
  projectSupervisorTitle,
  buildProjectSupervisorPrompt,
  buildProjectSupervisorSweepPrompt,
  ensureProjectSupervisor,
  pauseProjectSupervisor,
  healProjectSupervisors,
  gcDetachedProjectSupervisors } from './project-supervisor.service';
import { AUTONOMY_GRANTABLE_TOOLS } from './autonomy.service';
import { buildFleetSupervisorPrompt } from './supervisor.service';
// Layered prompts 2026-09-27: the composed prompts carry the GENERIC core
// (core-doctrine.ts). build 2026-10-08 S-2: the dated pre-layering constants
// (STANDING_OWNER_DIRECTIVE_HEADER / SUPERVISOR_PRECEDENCE_RULE /
// DIRECTIVE_SCOPE_RULE / AUDIT_CHURN_RULE) were deleted with the legacy
// builders — the content pins below read the layered text prod sends.
import { coreWakeCloseContract as wakeCloseContract, CORE_STANDING_DIRECTIVES, corePrecedenceRule, CORE_SCOPE_RULE } from './core-doctrine';
// sup/integration 2026-09-27: the composed prompts carry the GENERIC audit-churn rule (role-profiles.ts).
import { ROLE_AUDIT_CHURN_RULE } from './role-profiles';
import { emitScheduleDisabled } from '../coding/schedule.service';

const UID = 'u1';
const PID = 'p1';
const FLEET = { id: 'fleet1', title: 'Fleet Supervisor', userId: UID };
const PROJECT = {
  id: PID, userId: UID, name: 'Apollo', isUserSpace: false,
  archivedAt: null as any, projectSupervisorEnabled: true,
};
const LANE = { id: 'psup1', userId: UID, projectId: PID, title: 'Apollo Supervisor' };

const currentStockPrompt = () =>
  buildProjectSupervisorPrompt({ projectName: PROJECT.name, projectId: PID, fleetSupervisorChatId: FLEET.id });
const currentSweepPrompt = () =>
  buildProjectSupervisorSweepPrompt({ projectName: PROJECT.name, projectId: PID, fleetSupervisorChatId: FLEET.id });

/**
 * Happy-path mock state: eligible flag-on project, adult owner, the fleet
 * supervisor chat present, NO existing project lane, no hook, no sweep.
 * crossModelChat.findFirst routes by where-shape: the fleet lookup
 * (isSupervisor:true) vs the lane lookup (isProjectSupervisor:true).
 */
function mockFlagOnProject(lane: any = null) {
  mockPrisma.crossModelProject.findUnique.mockResolvedValue({ ...PROJECT });
  mockPrisma.user.findUnique.mockResolvedValue({ isChild: false });
  mockPrisma.crossModelChat.findFirst.mockImplementation(async ({ where }: any) =>
    where?.isSupervisor === true ? FLEET : where?.isProjectSupervisor === true ? lane : null);
  mockPrisma.crossModelChat.create.mockImplementation(async ({ data }: any) => ({
    id: 'psup1', userId: UID, projectId: PID, ...data,
  }));
  mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null);
  mockPrisma.eventHook.findFirst.mockResolvedValue(null);
  mockPrisma.eventHook.create.mockImplementation(async ({ data }: any) => ({ id: 'h-new', ...data }));
  mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  jest.clearAllMocks();
  // These two carry a null default that tests override with mockResolvedValue
  // (which clearAllMocks does NOT undo) — reset them so no test inherits a
  // paused-sweep row or a pause audit from an earlier test.
  mockPrisma.codingSchedule.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.activity.findFirst.mockReset().mockResolvedValue(null);
  // wake-cadence-3 owner guard (fixer 2026-09-27): the interval-attribution read — default: nothing attributed.
  mockPrisma.activity.findMany.mockReset().mockResolvedValue([]);
});

/* ====================================================================
 * Consts + prompt builders
 * ==================================================================== */
describe('project-supervisor consts', () => {
  it('the project-scope hook debounce is 0 — instant hooks (owner 2026-09-14); the old 600s stock value is the heal target', () => {
    expect(PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC).toBe(0);
    expect(LEGACY_PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC).toBe(600);
  });

  it('the schedule cap is 480 (below the fleet 1440, far above the 48 default)', () => {
    expect(PROJECT_SUPERVISOR_SCHEDULE_CAP).toBe(480);
  });

  it('the stock hook event set is the fleet seven PLUS todo_done (the project lane owns the todo ledger) PLUS ci_failed (CI-WATCH 2026-10-20)', () => {
    for (const t of ['run_completed', 'run_failed', 'attention_needed', 'goal_blocked', 'schedule_cap_skipped', 'schedule_disabled', 'schedule_near_cap']) {
      expect(PROJECT_SUPERVISOR_HOOK_EVENT_TYPES).toContain(t);
    }
    expect(PROJECT_SUPERVISOR_HOOK_EVENT_TYPES).toContain('todo_done');
    expect(PROJECT_SUPERVISOR_HOOK_EVENT_TYPES).toContain('ci_failed');
    expect(PROJECT_SUPERVISOR_HOOK_EVENT_TYPES).toHaveLength(9);
  });

  it('CI-WATCH: a new project hook is created without ci_failed while CI_WATCH_DISABLED=1', () => {
    expect(stockProjectHookEventTypes()).toEqual([...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES]);
    process.env.CI_WATCH_DISABLED = '1';
    try {
      expect(stockProjectHookEventTypes()).toEqual(PROJECT_SUPERVISOR_HOOK_EVENT_TYPES.filter((t) => t !== 'ci_failed'));
    } finally {
      delete process.env.CI_WATCH_DISABLED;
    }
  });

  it('CI-WATCH review fix: isStockProjectHookEventSet — the hooks the ci_failed lane-first gate covers (stock types only)', () => {
    expect(isStockProjectHookEventSet([...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES])).toBe(true);
    expect(isStockProjectHookEventSet(['run_completed', 'ci_failed'])).toBe(true);
    expect(isStockProjectHookEventSet(['ci_failed', 'merge_blocked'])).toBe(false); // a custom type: hand-made, never gated
    expect(isStockProjectHookEventSet([])).toBe(false);
  });
});

describe('projectSupervisorTitle', () => {
  it("is '<name> Supervisor', trimmed", () => {
    expect(projectSupervisorTitle('  Apollo  ')).toBe('Apollo Supervisor');
  });

  it('an empty/garbage name degrades to "Project Supervisor"', () => {
    expect(projectSupervisorTitle('')).toBe('Project Supervisor');
    expect(projectSupervisorTitle('   ')).toBe('Project Supervisor');
    expect(projectSupervisorTitle(null as any)).toBe('Project Supervisor');
  });

  it('truncates to 80 chars', () => {
    expect(projectSupervisorTitle('x'.repeat(200))).toHaveLength(80);
  });
});

describe('buildProjectSupervisorPrompt', () => {
  it('opens with the stock identity marker and names its ONE project', () => {
    const p = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    expect(p.startsWith(PROJECT_SUPERVISOR_PROMPT_OPENER)).toBe(true);
    expect(p).toContain('"Apollo"');
    expect(p).toContain(`projectId ${PID}`);
  });

  it('carries the OWNER-FACING NUMBERS + PRODUCTION STATE rules in the core Evidence rules (supervisor doctrine audit D1, 2026-09-27; generic — review fix: the live prompt is LAYERED, the bullets live in core-doctrine.ts)', () => {
    const p = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    const at = p.indexOf('## Evidence rules');
    expect(at).toBeGreaterThan(-1);
    const evidence = p.slice(at, p.indexOf('\n## ', at + 1));
    // The awaited verdict: NEWEST result by message id + clock AND the WORST leg since the owner's last message.
    expect(evidence).toContain('OWNER-FACING NUMBERS');
    expect(evidence).toContain('NEWEST board/lane result by its message id + clock');
    expect(evidence).toContain('WORST leg since the owner\'s last message');
    expect(evidence).toContain('a later better run never replaces the awaited verdict');
    // Production state: a this-wake read receipt or "not read this wake" in the same sentence.
    expect(evidence).toContain('PRODUCTION STATE');
    expect(evidence).toContain('THIS-WAKE read receipt');
    expect(evidence).toContain('"not read this wake" in the same sentence');
    expect(evidence).toContain('production_state_unread');
    // Observe-only: the sentence names the strike as telemetry, never a withhold.
    expect(evidence).toContain('the note still delivers');
    // The rules sit right after WORLD-FACTS vs FLEET-STATE, and the project role's Receipt discipline follows the core.
    expect(evidence.indexOf('WORLD-FACTS vs FLEET-STATE')).toBeLessThan(evidence.indexOf('OWNER-FACING NUMBERS'));
    expect(p.indexOf('OWNER-FACING NUMBERS')).toBeLessThan(p.indexOf('## Receipt discipline'));
    // Only tools this seat HAS: a supervisor chat cannot run_command (review fix) — the read is a lane's message / receipt.
    const production = evidence.slice(evidence.indexOf('- PRODUCTION STATE'), evidence.indexOf('\n', evidence.indexOf('- PRODUCTION STATE')));
    expect(production).not.toContain('run_command');
    expect(production).toContain('get_run_receipts');
    expect(production).toContain('get_chat_messages');
    expect(production).toContain('no shell of your own');
    // Generic: no incident ids, project names, dates or owner-quote markers ride the live prompt (prompt-hygiene lint is CI).
    for (const forbidden of ['s2v12r6', 'NVFP4', '(owner 2026', '2026-09-27', 'CanLaw', 'spark']) expect(evidence).not.toContain(forbidden);
  });

  it('references the fleet supervisor BY CHAT ID when known, by list_chats resolution when not', () => {
    const withId = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    expect(withId).toContain(`send_chat_message to chat id ${FLEET.id}`);
    const without = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: null });
    expect(without).toContain("resolve its chat id with list_chats (title 'Fleet Supervisor')");
  });

  it('carries the full-autonomy doctrine, the fan-out duty with THIS projectId, and the spawn-guard doctrine', () => {
    const p = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    expect(p).toContain('ALREADY GRANTED');
    expect(p).toContain('start_coding_session');
    expect(p).toContain(`always pass projectId '${PID}'`);
    expect(p).toContain('Spawn-guard doctrine');
    expect(p).toContain('may REFUSE a spawn');
    expect(p).toContain('NEVER retry-storm');
  });

  it('carries the Boundaries section (organization is the owner\'s call) + the no-op wake marker', () => {
    const p = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    expect(p).toContain('## Boundaries');
    expect(p).toContain('NEVER create, rename, move, or delete projects/folders');
    expect(p).toContain('NEVER move or rename chats');
    expect(p).toContain("'WAKE: no-op — nothing moved in Apollo since the previous wake'");
  });

  // Hardening review 2026-09-14: the system prompt (= every HOOK wake, the
  // majority wake class) mandated only the no-op marker; 'ACTIONS TAKEN' lived
  // solely in the sweep prompt, so acting hook wakes closed in prose and the
  // classifier filed them as plain notes. Both markers are now mandated by ONE
  // shared doctrine constant. Telemetry-only — no gate keys on it.
  it('mandates BOTH wake-close markers via the shared doctrine contract (WAKE: no-op / ACTIONS TAKEN) — never paraphrased', () => {
    const p = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    // fixer 2026-09-27 (finding upward-chatter-4): the PROJECT lane carries the
    // report-up variant of the contract — three shapes, the third for "a goal
    // moved, reported up, no lane action".
    expect(p).toContain(wakeCloseContract('in Apollo', { reportUp: true }));
    expect(p).toContain('ACTIONS TAKEN');
    expect(p).toContain("'WAKE: no-op — nothing moved in Apollo since the previous wake'");
    expect(p).toContain("'WAKE: reported — <what moved, with its artifact id> sent to the Fleet Supervisor; no lane action'");
    expect(p).toContain('exactly ONE of three literal shapes');
    // 2026-09-24 (owner): the line used to end in a model-filled '<time>' that
    // read "since 6:46 PM" when posted at 6:46 PM — the prompt carries no clock
    // placeholder anywhere, and the contract says so in words.
    expect(p).not.toContain('<time>');
    expect(p).toContain('NO clock appended');
    expect(p).toContain('never both, never paraphrased');
    // HARNESS-RECEIPTS-AND-CLAIMS (2026-10-20): the model writes what moved and why; the harness writes the
    // receipts — the model-typed "receipt id (8-char prefix)" contract returns under the kill switch.
    expect(p).toContain('the harness writes the receipts');
    expect(p).toContain("it appends 'ACTIONS TAKEN (harness):'");
    expect(p).not.toContain('receipt id (8-char prefix)');
    process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED = '1';
    try {
      expect(buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id })).toContain('receipt id (8-char prefix)');
    } finally {
      delete process.env.SUPERVISOR_HARNESS_RECEIPTS_DISABLED;
    }
    // The exact regex the harness classifier keys on matches the mandated token.
    expect(/\bACTIONS?\s+TAKEN\b/i.test(p)).toBe(true);
  });

  // Hardening review 2026-09-14: platform-tools deliberately wires NO per-child
  // result hook for a project-supervisor parent (the project-scope hook already
  // covers the child; a second hook would double every wake), and no cancel/
  // stop-run tool exists anywhere — the prompt used to promise both, steering
  // the lane into a hook_subscribe "repair" and phantom "cancelled" claims.
  it('describes ONLY capabilities that exist: no per-child hook (never hook_subscribe worker→self), no cancel tool (wind down via send_chat_message / cancel_schedule)', () => {
    const p = buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    expect(p).not.toContain('auto-wired child result hook');
    expect(p).not.toContain('child result hook');
    expect(p).toContain('There is NO per-child hook');
    expect(p).toContain('NEVER hook_subscribe a worker → yourself hook');
    expect(p).toContain('a second hook doubles every wake');
    // The event set the project-scope hook actually delivers, from the constant (no drift).
    for (const t of PROJECT_SUPERVISOR_HOOK_EVENT_TYPES) expect(p).toContain(t);
    expect(p).not.toContain('cancel them');
    expect(p).toContain('To HARD-STOP a run, stop_run'); // capability gap audit P0 (2026-09-24): the stop tool exists now
    expect(p).not.toContain('There is NO cancel/stop tool');
    expect(p).toContain('cancel_schedule');
    expect(p).toContain('tell it to wrap up and stand down');
    expect(p).toContain('answer_chat_question / approve_request');
    expect(p).toContain('archive_chat does not stop one');
  });
});

/* ====================================================================
 * Project-supervisor preflight 2026-09-14 (fix 3): standing-owner-directive
 * header, no cost-card class, precedence rule, deltas-only report-up —
 * pinned on BOTH prompt bodies (a sweep firing is a fresh turn).
 * ==================================================================== */
describe('Project-supervisor preflight 2026-09-14 — standing owner directives + precedence', () => {
  const sys = () => buildProjectSupervisorPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
  const sweep = () => buildProjectSupervisorSweepPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });

  it('the header states full autonomy, pre-approved budgets, "clear gates on my behalf", and "stop asking me so much" — and adds NO gate of its own', () => {
    const h = CORE_STANDING_DIRECTIVES;
    expect(h).toContain('FULL AUTONOMY');
    expect(h).toContain('without owner cards, review gates, or refusals');
    expect(h).toContain('BUDGETS ARE PRE-APPROVED');
    expect(h).toContain('NEVER file a cost/spend/budget card');
    expect(h).toContain('hardware-bound, not harness-bound');
    expect(h).toContain('CLEAR GATES ALWAYS ON MY BEHALF');
    expect(h).toContain('answer_owner_question');
    expect(h).toContain('STOP ASKING ME SO MUCH, FIGURE IT OUT AUTONOMOUSLY');
    // The human-worthy class names NO cost dimension.
    expect(h).not.toMatch(/spend beyond|approved cap|pre-registered/i);
  });

  // CanLaw stall 2026-09-15: the coordinator lane's own "Sept-1 band table"
  // auto-halted training; the owner's replies were questions back; the lane
  // wrote "owner's HALT-band decision MADE"; the project supervisor copied it
  // into its ledger and told the owner "it's your gate — one word lifts it"
  // for a day. The doctrine now names that class explicitly.
  it('the header says a halt is the owner\'s ONLY in the owner\'s own words — lane-set rules and owner counter-questions are lane-authored gates the supervisor lifts', () => {
    const h = CORE_STANDING_DIRECTIVES;
    expect(h).toContain("A HALT, HOLD OR PAUSE IS THE OWNER'S ONLY IN THE OWNER'S OWN WORDS");
    expect(h).toContain('"band table"');
    expect(h).toContain('LANE-authored gate');
    expect(h).toContain('yours to lift');
    expect(h).toContain('never describe it to the owner as "your halt", "your rule" or "your gate"');
    expect(h).toContain('An owner reply that asks a question back is NOT a decision');
    expect(h).toContain('record no ruling, and keep the work moving');
  });

  it('the sweep STALE-GATE step treats an owner-decision reason with NO open owner question as a lane-authored gate to unblock, never an owner wait', () => {
    const body = sweep();
    expect(body).toContain('An owner reply that was itself a QUESTION is not a decision');
    expect(body).toContain('NO owner question behind it (none open, and none the owner answered with a decision) is a LANE-authored gate, not an owner wait');
    expect(body).toContain('never report it as "waiting on the owner"');
    // …and an answered "stop" is honoured, never left parked on the closed card.
    expect(body).toContain('an answer that says stop closes or drops the work with the oq_ id as evidence');
  });

  it('the SYSTEM prompt carries the header + precedence rule verbatim, AFTER its stock opener; the sweep body is now SLIM (doctrine dedup 2026-09-18 — the fire-time rebuild keeps every wake doctrine-laden)', () => {
    // The stale-prompt heal keys on startsWith(opener) for BOTH bodies.
    expect(sys().startsWith(PROJECT_SUPERVISOR_PROMPT_OPENER)).toBe(true);
    expect(sweep().startsWith(PROJECT_SWEEP_PROMPT_OPENER)).toBe(true);
    // The doctrine rides the system prompt (the cached prefix)… — layered
    // prompts 2026-09-27: the GENERIC core sections, verbatim, before the duties.
    expect(sys()).toContain(CORE_STANDING_DIRECTIVES);
    expect(sys()).toContain(corePrecedenceRule('project'));
    expect(sys()).toContain(CORE_SCOPE_RULE);
    expect(sys().indexOf(CORE_STANDING_DIRECTIVES)).toBeLessThan(sys().indexOf('1. '));
    // …and no longer duplicates into the stored sweep body (R&D stream 3
    // experiment #2): ~6243c/~1473 cl100k tokens reclaimed per firing. The
    // doctrine-never-absent invariant for the FIRING moved to the
    // trigger-keyed rebuild — pinned in sweep-doctrine-rebuild.test.ts
    // (cold/post-compaction/trigger-keyed wake classes).
    for (const block of [CORE_STANDING_DIRECTIVES, corePrecedenceRule('project'), CORE_SCOPE_RULE]) {
      expect(sweep()).not.toContain(block);
    }
  });

  it('the "spend beyond a pre-registered envelope" owner-flag class is GONE from both bodies (budgets are pre-approved; cost cards are forbidden)', () => {
    for (const body of [sys(), sweep()]) {
      expect(body).not.toContain('spend beyond a pre-registered envelope');
      expect(body).not.toMatch(/spend beyond/i);
      expect(body).toMatch(/NEVER (?:for|an owner card)[^\n]*(?:spend|budget)/i);
    }
    // The human-worthy class the system prompt keeps is the non-cost one.
    expect(sys()).toContain('irreversible/destructive actions, account/security posture, external sends, a real strategy fork');
  });

  it('the PRECEDENCE rule: owner > project supervisor (tactics/fan-out/goal+todo ownership) > fleet (cross-project, owner comms, framework); never narrows an owner grant; peer lanes message DIRECTLY', () => {
    const r = corePrecedenceRule('project');
    expect(r).toContain('OWNER DIRECTIVES win over everything');
    expect(r).toContain('NEVER narrowed by you');
    expect(r).toContain('execution tactics, fan-out');
    expect(r).toContain("ownership of this project's goals and todos");
    expect(r).toContain('does not restamp a goal or todo in your project');
    expect(r).toContain('cross-project priorities and dependencies, owner-facing communication, and framework/harness issues');
    expect(r).toContain('PEER LANES MESSAGE EACH OTHER DIRECTLY');
    expect(r).toContain('send_chat_message');
    expect(r).toContain('NEVER routed through you or the Fleet Supervisor');
  });

  it('report-up is DELTAS ONLY (what moved / stuck since when / needs fleet) — never a ledger restatement — in both bodies', () => {
    const s = sys();
    expect(s).toContain('DELTAS ONLY, never the ledger');
    expect(s).toContain('WHAT MOVED');
    expect(s).toContain('STUCK SINCE WHEN');
    expect(s).toContain('NEEDS FLEET');
    expect(s).toContain('send NO report-up this wake');
    const w = sweep();
    expect(w).toContain('ONLY THE DELTAS the Fleet Supervisor must know');
    expect(w).toContain('what is stuck and since when');
    expect(w).toContain('Never restate the ledger');
    expect(w).toContain('an empty diff sends NO report-up');
  });

  // tt-rd audit 2026-09-27 (findings upward-chatter-1 + -5): 259 of the tt-rd
  // supervisor's 310 sends went UP to the Fleet Supervisor and 30 to its main
  // lane; ten owner "progress?" asks stayed open while it swept and reported up.
  it('lanes are the DEFAULT audience — a Fleet Supervisor message needs a state change or an ask, is never the qualifying action, and the sweep splits act (6) from report-up (6b)', () => {
    const s = sys();
    expect(s).toContain('MESSAGE YOUR LANES BY DEFAULT');
    expect(s).toContain('send_chat_message to the lane id');
    expect(s).toContain('(a) a STATE CHANGE on a goal');
    expect(s).toContain('(b) an ASK the fleet must carry');
    expect(s).toContain('A report-up is NEVER the action that qualifies a wake as ACTIONS TAKEN');
    // fixer 2026-09-27 (finding upward-chatter-4): a report-up-only wake with a
    // moved goal closes with the THIRD shape — never 'nothing moved' (false),
    // never ACTIONS TAKEN (forbidden). The old "closes as WAKE: no-op" clause
    // contradicted both the truth and the harness labels.
    expect(s).not.toContain('closes as WAKE: no-op');
    expect(s).toContain("closes with the 'WAKE: reported — <what moved> sent to the Fleet Supervisor; no lane action' line, never as ACTIONS TAKEN and never as 'nothing moved'");
    // the wake-close contract (supervisor-doctrine.ts wakeCloseContract) carries the same rule
    expect(s).toContain('a report-up to the Fleet Supervisor is not an action for this contract');
    expect(s).toContain("is never a line under 'ACTIONS TAKEN'");
    // style line names the lane message, not "what needs the Fleet Supervisor"
    expect(s).toContain('what you told which lane (msg id)');
    expect(s).not.toContain('what needs the Fleet Supervisor (if anything)');
    const w = sweep();
    expect(w).not.toContain('and REPORT UP');
    expect(w).toContain('6. ACT on the diff — a short specific steer to the LANE that can act on it');
    expect(w).toContain('6b. ONLY IF a goal STATE CHANGE or an ASK exists, ONE message to the Fleet Supervisor');
    expect(w).toContain('a report-up is not an action for step 7');
    expect(w.indexOf('6. ACT on the diff')).toBeLessThan(w.indexOf('6b. ONLY IF'));
    expect(w.indexOf('6b. ONLY IF')).toBeLessThan(w.indexOf('7. CLOSE the note'));
  });

  it('duty 0 ANSWER THE OWNER FIRST outranks every other duty and names the [OPEN OWNER ASKS — ANSWER FIRST] block', () => {
    const s = sys();
    expect(s).toContain('0. ANSWER THE OWNER FIRST');
    expect(s).toContain('[OPEN OWNER ASKS — ANSWER FIRST] block at the top of a wake outranks every other duty this wake');
    expect(s).toContain('the harness marks the ask answered when your reply lands (only typed evidence closes it done)');
    expect(s.indexOf('0. ANSWER THE OWNER FIRST')).toBeLessThan(s.indexOf('1. WATCH this project'));
    // the doctrine header still precedes the duty list (the existing ordering pin keys on '1. ') —
    // layered prompts: the GENERIC core standing directives, not the legacy constant.
    expect(s.indexOf(CORE_STANDING_DIRECTIVES)).toBeGreaterThan(-1);
    expect(s.indexOf(CORE_STANDING_DIRECTIVES)).toBeLessThan(s.indexOf('0. ANSWER THE OWNER FIRST'));
  });

  it('spawn-guard: a refusal is routed/coalesced/deferred, NEVER converted into an owner card or a "paused pending approval" state', () => {
    expect(sys()).toContain('A refusal is NEVER converted into an owner card');
    expect(sweep()).toContain('A spawn refusal or any budget/spend/cost consideration is NEVER an owner card');
  });

  it('doctrine PARITY with the fleet prompt: the owner-directive phrases the fleet body carries appear in the project bodies too (one doctrine, not two)', () => {
    const fleet = buildFleetSupervisorPrompt();
    // Phrases quoted from the same owner directives — present in the fleet
    // SYSTEM prompt today; a drift in either SYSTEM prompt breaks this pin.
    // (Doctrine dedup 2026-09-18, R&D stream 3 experiment #2: the project
    // SWEEP body is intentionally slim — the doctrine reaches its firings via
    // this system prompt + the trigger-keyed rebuild pinned in
    // sweep-doctrine-rebuild.test.ts. Parity is pinned on the doctrine's
    // surviving channel: the two system prompts.)
    // Layered prompts 2026-09-27: 'pre-approved budgets' → the generic money rule (rule money.grant, "BUDGETS ARE PRE-APPROVED").
    for (const phrase of ['clear gates always on my behalf', 'stop asking me so much, figure it out autonomously', 'budgets are pre-approved', 'rule money.grant', 'answer_owner_question']) {
      expect(fleet.toLowerCase()).toContain(phrase.toLowerCase());
      expect(sys().toLowerCase()).toContain(phrase.toLowerCase());
      expect(sweep().toLowerCase()).not.toContain('standing owner directives');
    }
    // Hardening review 2026-09-14: the wake-close contract (both markers) is
    // ONE shared constant on BOTH system prompts — the fleet and project gate
    // metrics are measured with the same instrument.
    for (const phrase of ['ACTIONS TAKEN', 'WAKE: no-op', 'never both, never paraphrased', 'the no-op marker wins outright']) {
      expect(fleet).toContain(phrase);
      expect(sys()).toContain(phrase);
    }
    expect(fleet).toContain(wakeCloseContract('on any project'));
    // fixer 2026-09-27: same constant, project variant (reportUp adds the third
    // shape); the fleet prompt carries NO report-up clause — a "report-up to
    // the Fleet Supervisor" is meaningless on the Fleet Supervisor's own seat.
    expect(sys()).toContain(wakeCloseContract('in Apollo', { reportUp: true }));
    expect(fleet).not.toContain('report-up to the Fleet Supervisor');
    expect(fleet).toContain('exactly ONE of two literal shapes');
  });

  // tt-rd audit 2026-09-27 (self-audit-churn-3c): no doctrine row told either
  // supervisor tier to recognise audit-only firings — the project supervisor
  // reported them as movement and escalated 259/306 messages UP.
  it('AUDIT CHURN rule rides BOTH system prompts and the project sweep body (observe + steer the lane, never escalate, never gate)', () => {
    const fleet = buildFleetSupervisorPrompt();
    // Fixer 2026-09-27 (finding 1): the cadence clause is scoped to MACHINE-armed
    // rows — an owner-armed cadence (the tt-rd lane's 30-min owner directive)
    // is reported UP, never edited, so the rule does not contradict the
    // precedence rule ("never narrowed … by a schedule prompt").
    // Layered prompts (sup/integration 2026-09-27): the composed prompts carry the GENERIC statement of the
    // rule (role-profiles.ts ROLE_AUDIT_CHURN_RULE — no date, no incident); the dated pre-layering constant
    // was deleted in build 2026-10-08 S-2.
    for (const phrase of ['AUDIT CHURN', 'NO-OP firing, not progress', 'steer THE LANE with send_chat_message', 'do not escalate it up', 'ONLY when the schedule is machine-armed', 'An OWNER-ARMED cadence (armed by: user) is never edited by you', 'report the audit-only ticks UP as a delta']) {
      expect(ROLE_AUDIT_CHURN_RULE).toContain(phrase);
    }
    expect(ROLE_AUDIT_CHURN_RULE).not.toMatch(/refuse|owner card|gate the lane|20\d\d-\d\d-\d\d/i);
    expect(sys()).toContain(ROLE_AUDIT_CHURN_RULE);
    expect(fleet).toContain(ROLE_AUDIT_CHURN_RULE);
    expect(sys()).not.toContain('AUDIT CHURN (2026-09-27)'); // never the dated wording
    // The stock sweep prompt's DIFF step names the same rule in one clause.
    expect(sweep()).toContain('AUDIT CHURN: an audit-only firing with no changed artifact is a NO-OP, never movement');
    expect(sweep()).toContain('lengthen a MACHINE-armed cadence; an owner-armed cadence is reported UP, never edited');
    expect(sweep()).toContain('not escalated');
  });
});

describe('buildProjectSupervisorSweepPrompt', () => {
  it('opens with the stock sweep marker and is a GOAL LEDGER diff contract', () => {
    const p = buildProjectSupervisorSweepPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    expect(p.startsWith(PROJECT_SWEEP_PROMPT_OPENER)).toBe(true);
    expect(p).toContain('GOAL LEDGER');
    expect(p).toContain('goal_list');
    expect(p).toContain('todo_list');
    expect(p).toContain('ONLY DELTAS');
  });

  it('carries the stale-gate probe duty + the closing no-op/actions contract', () => {
    const p = buildProjectSupervisorSweepPrompt({ projectName: 'Apollo', projectId: PID, fleetSupervisorChatId: FLEET.id });
    expect(p).toContain('list_owner_questions');
    expect(p).toContain("'SWEEP: no-op — nothing moved in Apollo since last sweep'");
    expect(p).toContain('ACTIONS TAKEN');
    expect(p).toContain('receipt id');
    // fixer 2026-09-27 (finding upward-chatter-4): the THIRD close — a goal
    // moved, 6b was the only send, no lane action. Before it, that wake had no
    // truthful close ('nothing moved' false, ACTIONS TAKEN forbidden).
    expect(p).toContain("'SWEEP: reported — <what moved, artifact id> sent to the Fleet Supervisor; no lane action' when a goal moved and 6b was your only send");
    expect(p.indexOf('SWEEP: no-op')).toBeLessThan(p.indexOf('SWEEP: reported'));
    expect(p.indexOf('SWEEP: reported')).toBeLessThan(p.lastIndexOf('ACTIONS TAKEN'));
  });
});

/* ====================================================================
 * ensureProjectSupervisor — first creation
 * ==================================================================== */
describe('ensureProjectSupervisor — first creation (flag ON)', () => {
  it('creates the lane chat inside its project with the stock prompt, full autonomy (cap 480), the 60-min sweep, and ONE project-scope hook', async () => {
    mockFlagOnProject();
    const chat = await ensureProjectSupervisor(UID, PID);
    expect(chat.id).toBe('psup1');

    // The lane chat row: in-project, titled, pinned, stock-prompted.
    const createData = mockPrisma.crossModelChat.create.mock.calls[0][0].data;
    expect(createData.title).toBe('Apollo Supervisor');
    expect(createData.mode).toBe('auto'); // owner 2026-09-26: Auto by default (see supervisor.service.test)
    expect(createData.isProjectSupervisor).toBe(true);
    expect(createData.systemPrompt.startsWith(PROJECT_SUPERVISOR_PROMPT_OPENER)).toBe(true);
    expect(createData.systemPrompt).toBe(currentStockPrompt());
    expect(createData.user).toEqual({ connect: { id: UID } });
    expect(createData.project).toEqual({ connect: { id: PID } });

    // Full autonomy: EVERY grantable tool, scheduleCap 480, keyed on the chat PK.
    const up = mockPrisma.chatAutonomy.upsert.mock.calls[0][0];
    expect(up.where).toEqual({ chatId: 'psup1' });
    expect(up.create.allowedTools).toEqual([...AUTONOMY_GRANTABLE_TOOLS]);
    expect(up.create.scheduleCap).toBe(PROJECT_SUPERVISOR_SCHEDULE_CAP);
    expect(up.update.allowedTools).toEqual([...AUTONOMY_GRANTABLE_TOOLS]);

    // ONE recurring sweep schedule (2 h since wake-cadence-3, 2026-09-27 — was
    // 60 min; the project hook is the event path, the sweep is only the diff).
    const sched = mockPrisma.codingSchedule.create.mock.calls[0][0].data;
    expect(sched.sessionId).toBe('psup1');
    expect(sched.userId).toBe(UID);
    expect(sched.kind).toBe('recurring');
    expect(PROJECT_SWEEP_INTERVAL_SEC).toBe(2 * 60 * 60);
    expect(sched.intervalSec).toBe(PROJECT_SWEEP_INTERVAL_SEC);
    expect(sched.maxRuns).toBe(500);
    expect(sched.enabled).toBe(true);
    expect(sched.promptSetBy).toBe('system');
    expect(sched.prompt.startsWith(PROJECT_SWEEP_PROMPT_OPENER)).toBe(true);
    expect(sched.prompt).toBe(currentSweepPrompt());

    // ONE PROJECT-SCOPE hook: sourceChatId NULL + projectId SET, the stock
    // event set (incl todo_done), 600s debounce.
    const hook = mockPrisma.eventHook.create.mock.calls[0][0].data;
    expect(hook.userId).toBe(UID);
    expect(hook.sourceChatId).toBeNull();
    expect(hook.targetChatId).toBe('psup1');
    expect(hook.projectId).toBe(PID);
    expect(hook.eventTypes).toEqual([...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES]);
    expect(hook.eventTypes).toContain('todo_done');
    expect(hook.debounceSec).toBe(PROJECT_SUPERVISOR_HOOK_DEBOUNCE_SEC);

    // The scaffold is audited.
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID, action: 'project_supervisor.ensure', resource: 'platform',
        metadata: expect.objectContaining({ projectId: PID, chatId: 'psup1', created: true }),
      }),
    });
  });

  it('still scaffolds when the fleet supervisor chat does not exist yet (prompt resolves it by list_chats)', async () => {
    mockFlagOnProject();
    mockPrisma.crossModelChat.findFirst.mockImplementation(async ({ where }: any) =>
      where?.isSupervisor === true ? null : where?.isProjectSupervisor === true ? null : null);
    const chat = await ensureProjectSupervisor(UID, PID);
    expect(chat.id).toBe('psup1');
    const createData = mockPrisma.crossModelChat.create.mock.calls[0][0].data;
    expect(createData.systemPrompt).toContain("resolve its chat id with list_chats");
  });
});

/* ====================================================================
 * ensureProjectSupervisor — gates (ZERO creates)
 * ==================================================================== */
describe('ensureProjectSupervisor — gates', () => {
  const expectZeroCreates = () => {
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled();
  };

  it.each([
    ['flag false', { projectSupervisorEnabled: false }],
    ['user-space folder', { isUserSpace: true }],
    ['archived project', { archivedAt: new Date('2026-09-01T00:00:00Z') }],
  ])('returns null and creates NOTHING when the project is ineligible (%s)', async (_label, over) => {
    mockFlagOnProject();
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ ...PROJECT, ...over });
    await expect(ensureProjectSupervisor(UID, PID)).resolves.toBeNull();
    expectZeroCreates();
  });

  it('returns null when the project does not exist (or the read failed)', async () => {
    mockFlagOnProject();
    mockPrisma.crossModelProject.findUnique.mockResolvedValue(null);
    await expect(ensureProjectSupervisor(UID, PID)).resolves.toBeNull();
    expectZeroCreates();
    // A read failure is caught to null — same gate, never a throw.
    mockPrisma.crossModelProject.findUnique.mockRejectedValue(new Error('db down'));
    await expect(ensureProjectSupervisor(UID, PID)).resolves.toBeNull();
    expectZeroCreates();
  });

  it('returns null when the project belongs to a DIFFERENT user', async () => {
    mockFlagOnProject();
    mockPrisma.crossModelProject.findUnique.mockResolvedValue({ ...PROJECT, userId: 'someone-else' });
    await expect(ensureProjectSupervisor(UID, PID)).resolves.toBeNull();
    expectZeroCreates();
  });

  it('returns null for a CHILD account (kid guard — no autonomous agents)', async () => {
    mockFlagOnProject();
    mockPrisma.user.findUnique.mockResolvedValue({ isChild: true });
    await expect(ensureProjectSupervisor(UID, PID)).resolves.toBeNull();
    expectZeroCreates();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('child account'));
  });

  it('empty args are a no-op (no queries at all)', async () => {
    await expect(ensureProjectSupervisor('', PID)).resolves.toBeNull();
    await expect(ensureProjectSupervisor(UID, '')).resolves.toBeNull();
    expect(mockPrisma.crossModelProject.findUnique).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * ensureProjectSupervisor — idempotent self-heal
 * ==================================================================== */
describe('ensureProjectSupervisor — idempotent self-heal', () => {
  it('a second ensure with every piece in place creates NOTHING and returns the existing lane', async () => {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([
      { id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring', runsCount: 3 },
    ]);

    const chat = await ensureProjectSupervisor(UID, PID);

    expect(chat.id).toBe('psup1');
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled(); // title + stock prompt both current
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled(); // a present grant is NEVER clobbered
    expect(mockPrisma.chatAutonomy.update).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled(); // stock + enabled → untouched
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled(); // current sweep prompt → no heal
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled(); // single sweep → no dedupe
  });

  it('heals title drift on an existing lane (rename re-interpolates)', async () => {
    mockFlagOnProject({ ...LANE, title: 'Old Name Supervisor', systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);

    const chat = await ensureProjectSupervisor(UID, PID);

    expect(chat.id).toBe('psup1');
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'psup1' },
      data: { title: 'Apollo Supervisor' },
    });
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
  });

  it('fixer 2026-09-27: the heal keeps the harness step half ("Apollo Supervisor · sweep") and never overwrites a human-pinned title', async () => {
    const wire = () => {
      mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
      mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '' });
      mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring', runsCount: 3 }]);
    };
    mockFlagOnProject({ ...LANE, title: 'Apollo Supervisor · sweep', systemPrompt: currentStockPrompt() });
    wire();
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockFlagOnProject({ ...LANE, title: 'Apollo (owner name)', titlePinned: true, systemPrompt: currentStockPrompt() });
    wire();
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('rewrites an OLD STOCK prompt (opener match) but NEVER touches a customized prompt', async () => {
    // Old stock: opener + stale body → rewritten to the current build.
    mockFlagOnProject({ ...LANE, systemPrompt: `${PROJECT_SUPERVISOR_PROMPT_OPENER} for the project "Apollo" (projectId ${PID}) — OLD VERSION` });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'psup1' },
      data: { systemPrompt: currentStockPrompt() },
    });
    // The heal is audited like the admin re-scaffold (review fix 2026-09-27): attributable, cadence observable.
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID, action: 'chat.update',
        metadata: expect.objectContaining({ chatId: 'psup1', projectId: PID, reason: expect.stringContaining('healed'), wasLayered: false }),
      }),
    });

    // Customized: no stock opener → untouched.
    jest.clearAllMocks();
    mockFlagOnProject({ ...LANE, systemPrompt: 'My custom supervisor instructions — do not clobber' });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  // Hardening review 2026-09-14: a NULL/empty systemPrompt is not a
  // customization — it is a lane stripped of every duty, boundary and receipt
  // rule while keeping full autonomy. The heal used to `return` on !systemPrompt
  // (permanently prompt-less, no signal); now it counts as stock-missing.
  it.each([['null', null], ['empty string', '']])('heals a %s systemPrompt back to the CURRENT stock prompt (a prompt-less lane is damage, never a customization)', async (_label, prompt) => {
    mockFlagOnProject({ ...LANE, systemPrompt: prompt as any });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'psup1' },
      data: { systemPrompt: currentStockPrompt() },
    });
  });

  it('CI-WATCH (2026-10-20): a pre-ci_failed stock project hook gets ci_failed unioned in (audited); never while CI_WATCH_DISABLED=1', async () => {
    const legacy = PROJECT_SUPERVISOR_HOOK_EVENT_TYPES.filter((t) => t !== 'ci_failed');
    const wire = () => {
      mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
      mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
      mockPrisma.eventHook.findFirst.mockResolvedValue({ id: 'h1', eventTypes: [...legacy], enabled: true, promptTemplate: '' });
      mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring', runsCount: 3 }]);
    };
    wire();
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { eventTypes: [...legacy, 'ci_failed'] } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'hook.update', metadata: expect.objectContaining({ hookId: 'h1', reason: expect.stringContaining('ci_failed') }) }),
    });

    jest.clearAllMocks();
    process.env.CI_WATCH_DISABLED = '1';
    try {
      wire();
      await ensureProjectSupervisor(UID, PID);
      expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    } finally {
      delete process.env.CI_WATCH_DISABLED;
    }
  });

  it('self-heals a MISSING autonomy grant / project hook / sweep on an existing lane', async () => {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue(null); // grant missing → re-granted
    mockPrisma.eventHook.findFirst.mockResolvedValue(null); // hook missing → recreated
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]); // sweep dead → recreated

    const chat = await ensureProjectSupervisor(UID, PID);

    expect(chat.id).toBe('psup1');
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.chatAutonomy.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.chatAutonomy.upsert.mock.calls[0][0].create.scheduleCap).toBe(PROJECT_SUPERVISOR_SCHEDULE_CAP);
    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingSchedule.create).toHaveBeenCalledTimes(1);
  });

  it('toggle-ON restore: a DISABLED stock project hook is re-enabled; a customized hook is never clobbered', async () => {
    // Stock (empty template, stock-universe event types) + disabled → re-enabled.
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { enabled: true } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.update',
        metadata: expect.objectContaining({ hookId: 'h1', projectId: PID }),
      }),
    });

    // Customized (custom template) + disabled with NO pause audit naming it →
    // left alone: the lane disabled it itself (hook_update enabled:false is a
    // supported self-pause) and this ensure runs every 15 min from the heal.
    jest.clearAllMocks();
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: 'custom {{summary}}',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
    mockPrisma.activity.findFirst.mockResolvedValue(null); // no pause audit for this lane
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
  });
});

/* ====================================================================
 * Hardening review 2026-09-14 — toggle-ON resumes EXACTLY what pause disabled
 * (hook + schedule ids recorded in the pause audit), stock or customized.
 * ==================================================================== */
describe('ensureProjectSupervisor — toggle-ON exact-ids resume (hardening review 2026-09-14)', () => {
  const PAUSE_AT = new Date('2026-09-14T10:00:00Z');
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000);
  const PAST = new Date(Date.now() - 60 * 60 * 1000);

  /** Existing lane, flag ON, project-scope hook DISABLED (the pause signature). */
  function mockPausedLane(hook: any) {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue(hook);
  }
  /** Route activity.findFirst by action: the newest pause row vs. a newer resume row. */
  function mockPauseAudit(meta: any, resumedAfter: boolean = false) {
    mockPrisma.activity.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.action === 'project_supervisor.pause') return { id: 'act-pause', createdAt: PAUSE_AT, metadata: { chatId: 'psup1', projectId: PID, ...meta } };
      if (where?.action === 'project_supervisor.resume') return resumedAfter ? { id: 'act-resume' } : null;
      return null;
    });
  }

  it('re-enables EXACTLY the hook ids the pause recorded — including a CUSTOMIZED project hook and a DIRECT worker→lane hook — and audits the resume', async () => {
    // CI-WATCH (2026-10-20): ci_failed is a STOCK type now — the customization is the template.
    mockPausedLane({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: 'custom {{summary}}' });
    mockPauseAudit({ hookIds: ['h1', 'h-direct'], scheduleIds: [] });
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);

    await ensureProjectSupervisor(UID, PID);

    // Exact ids, still targeting the lane, still disabled — template/eventTypes are NEVER written.
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['h1', 'h-direct'] }, targetChatId: 'psup1', enabled: false },
      data: { enabled: true },
    });
    // The customized hook is NOT run through the stock-only fallback (no per-row update either).
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID, action: 'project_supervisor.resume', resource: 'platform',
        metadata: expect.objectContaining({
          projectId: PID, chatId: 'psup1', pauseActivityId: 'act-pause',
          hookIds: ['h1', 'h-direct'], hooksResumed: 2, scheduleIds: [], schedulesResumed: 0,
        }),
      }),
    });
  });

  // audit 2026-10-06 T5-1: a paused supervisor's spawns got direct child-result
  // hooks; once the project hook is live again they would double-wake.
  it('audit 2026-10-06 T5-1: resume disables the in-project child-result hooks wired while paused (never deleted; out-of-project ones kept)', async () => {
    mockPausedLane({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '' });
    mockPauseAudit({ hookIds: ['h1'], scheduleIds: [] });
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.eventHook.findMany.mockImplementation(async ({ where }: any) =>
      where?.createdVia === 'system:child-result-hook' ? [{ id: 'ch-in', sourceChatId: 'lane-in' }, { id: 'ch-out', sourceChatId: 'lane-out' }] : []);
    mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) =>
      Array.isArray(where?.id?.in) && where?.projectId === PID ? [{ id: 'lane-in' }] : []);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);

    await ensureProjectSupervisor(UID, PID);

    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { targetChatId: 'psup1', userId: UID, createdVia: 'system:child-result-hook', enabled: true },
    }));
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['ch-in'] }, enabled: true }, data: { enabled: false } });
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'project_supervisor.resume', metadata: expect.objectContaining({ pausedChildHooksDisabled: 1 }) }),
    });
  });

  it('audit 2026-10-06 T5-1: kill switch PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED=1 leaves child hooks alone on resume', async () => {
    process.env.PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED = '1';
    try {
      mockPausedLane({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '' });
      mockPauseAudit({ hookIds: ['h1'], scheduleIds: [] });
      mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
      await ensureProjectSupervisor(UID, PID);
      expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ createdVia: 'system:child-result-hook' }) }));
      expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED;
    }
  });

  it('resumes the paused schedules by id with the schedule.service resume shape — recurring rows resume (stale nextRunAt recomputed), a PAST-DUE once row and an EXHAUSTED row stay paused and are named in the audit — and the stock sweep is NOT re-created', async () => {
    mockPausedLane({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '' });
    mockPauseAudit({ hookIds: ['h1'], scheduleIds: ['sweep1', 'once-fresh', 'once-stale', 'spent'] });
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 1 });
    // Route codingSchedule.findMany: the by-id resume read (disabled rows) vs the
    // enabled-sweep read that follows (the resumed stock sweep is enabled again).
    mockPrisma.codingSchedule.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.id?.in) return [
        { id: 'sweep1', kind: 'recurring', nextRunAt: PAST, intervalSec: 3600, maxRuns: 500, runsCount: 12, expiresAt: FUTURE },
        { id: 'once-fresh', kind: 'once', nextRunAt: FUTURE, intervalSec: null, maxRuns: null, runsCount: 0, expiresAt: null },
        { id: 'once-stale', kind: 'once', nextRunAt: PAST, intervalSec: null, maxRuns: null, runsCount: 0, expiresAt: null },
        { id: 'spent', kind: 'recurring', nextRunAt: FUTURE, intervalSec: 1800, maxRuns: 10, runsCount: 10, expiresAt: FUTURE },
      ];
      return [{ id: 'sweep1', prompt: currentSweepPrompt(), kind: 'recurring', runsCount: 12, promptSetBy: 'system' }];
    });

    await ensureProjectSupervisor(UID, PID);

    expect(mockPrisma.codingSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['sweep1', 'once-fresh', 'once-stale', 'spent'] }, sessionId: 'psup1', enabled: false },
    }));
    // Recurring stock sweep: resumed, stale nextRunAt recomputed one interval out.
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sweep1' },
      data: { enabled: true, lastStatus: 'resumed', cancelledBy: null, disabledAt: null, busySkips: 0, nextRunAt: expect.any(Date) },
    });
    // Fresh once row: resumed as-is (its fire time is still ahead).
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({
      where: { id: 'once-fresh' },
      data: { enabled: true, lastStatus: 'resumed', cancelledBy: null, disabledAt: null, busySkips: 0 },
    });
    // Stale once + exhausted: NOT resumed.
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'once-stale' } }));
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'spent' } }));
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledTimes(2);
    // The sweep ensure sees the resumed stock row → no new sweep row (no dead-row pile-up).
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'project_supervisor.resume',
        metadata: expect.objectContaining({
          schedulesResumed: 2, skippedStaleOnce: ['once-stale'], skippedExhausted: ['spent'], hooksResumed: 1,
        }),
      }),
    });
  });

  it('is a no-op when a resume audit is already NEWER than the latest pause (later heals do not re-resume)', async () => {
    mockPausedLane({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: 'custom {{summary}}' });
    mockPauseAudit({ hookIds: ['h1'], scheduleIds: ['sweep1'] }, /* resumedAfter */ true);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);

    await ensureProjectSupervisor(UID, PID);

    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'project_supervisor.resume' }) });
    // The newer-resume probe is scoped to rows AFTER the pause.
    expect(mockPrisma.activity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ action: 'project_supervisor.resume', createdAt: { gt: PAUSE_AT } }),
    }));
  });

  it('cheap gate: an ENABLED project-scope hook means nothing is pending — the Activity table is never queried on the common 15-min heal', async () => {
    mockPausedLane({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '' });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.activity.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
  });

  it('a LEGACY pause audit (no ids recorded) resumes nothing by id, writes an honest resume audit, and the stock-only fallback still re-enables the stock hook', async () => {
    mockPausedLane({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '' });
    mockPauseAudit({ hooksDisabled: 1, schedulesDisabled: 1 }); // pre-2026-09-14 shape
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);

    await ensureProjectSupervisor(UID, PID);

    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'project_supervisor.resume',
        metadata: expect.objectContaining({ hookIds: [], scheduleIds: [], note: expect.stringContaining('predates id recording') }),
      }),
    });
    // Legacy fallback (stock hook) still fires — exactly `{ enabled: true }`, nothing else written.
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h1' }, data: { enabled: true } });
  });

  it('a resume failure is a warn, never a throw — the ensure still returns the lane', async () => {
    mockPausedLane({ id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '' });
    mockPrisma.activity.findFirst.mockRejectedValue(new Error('db down'));
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
    const chat = await ensureProjectSupervisor(UID, PID);
    expect(chat.id).toBe('psup1');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('resume failed'));
  });
});

/* ====================================================================
 * Hardening review 2026-09-14 — the sweep ensure dedupes/heals ONLY stock
 * rows (opener match); the lane's own recurring re-arms are never deleted,
 * never rewritten, and never mask a dead stock sweep. A paused stock row is
 * RESUMED instead of a new one being created.
 * ==================================================================== */
describe('ensureProjectSweepSchedule — stock-partitioned dedupe + paused-row reuse (hardening review 2026-09-14)', () => {
  /** Existing healthy lane; only the sweep rows vary per test. */
  function mockLaneWithSweeps(rows: any[]) {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue(rows);
  }
  const STOCK = (id: string, over: any = {}) => ({ id, prompt: currentSweepPrompt(), kind: 'recurring', runsCount: 3, promptSetBy: 'system', ...over });
  const MACHINE = (id: string, over: any = {}) => ({ id, prompt: 'poll worker X every 30 min and steer if idle', kind: 'recurring', runsCount: 5, promptSetBy: 'machine', ...over });

  it('THE BUG: the stock sweep + a machine-authored recurring self-arm → nothing deleted, nothing emitted, nothing created (the lane\'s own cadence survives every heal)', async () => {
    mockLaneWithSweeps([STOCK('sweep1'), MACHINE('poll1')]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled();
    expect(emitScheduleDisabled).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled(); // machine prompt never rewritten; stock current
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'schedule_hard_deleted' }) });
  });

  it('a machine-authored recurring row ALONE does not mask a dead stock sweep → the stock sweep is created; the machine row is untouched', async () => {
    mockLaneWithSweeps([MACHINE('poll1')]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingSchedule.create.mock.calls[0][0].data.prompt).toBe(currentSweepPrompt());
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
  });

  it('an OWNER-customized recurring row (promptSetBy user, no opener) ALONE is the lane\'s cadence → no create, no update, no delete (the non-clobber / c0e22e36 shape)', async () => {
    mockLaneWithSweeps([{ id: 'custom1', prompt: 'Check on the Apollo migration hourly and report.', kind: 'recurring', runsCount: 383, promptSetBy: 'user' }]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.findFirst).not.toHaveBeenCalled(); // no paused-row lookup either
  });

  it('two stock rows + a machine row → ONLY the newer stock duplicate is emitted/audited/deleted; the machine row is not in the doomed set', async () => {
    mockLaneWithSweeps([STOCK('sweep1', { runsCount: 10 }), MACHINE('poll1'), STOCK('sweep2', { runsCount: 0 })]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.deleteMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingSchedule.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['sweep2'] } } });
    expect(emitScheduleDisabled).toHaveBeenCalledTimes(1);
    expect(emitScheduleDisabled).toHaveBeenCalledWith({ id: 'sweep2', sessionId: 'psup1', kind: 'recurring' }, 'obsolete', 0);
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'schedule_hard_deleted',
        metadata: expect.objectContaining({ scheduleId: 'sweep2', source: 'project-sweep-dedupe' }),
      }),
    });
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ metadata: expect.objectContaining({ scheduleId: 'poll1' }) }),
    });
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
  });

  it('a renewOnExhaustion successor (opener, promptSetBy system) NEWER than an older machine row is the keeper — the machine row is not deleted and no sweep is created', async () => {
    // The old predicate kept the OLDEST row (the machine monitor) and deleted the
    // successor sweep, then returned without creating — the lane lost its sweep.
    mockLaneWithSweeps([MACHINE('poll1'), STOCK('successor', { runsCount: 0 })]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
  });

  it('the stale-prompt heal rewrites ONLY the stock keeper; a machine row with a stale-looking prompt is never rewritten', async () => {
    mockLaneWithSweeps([STOCK('sweep1', { prompt: `${PROJECT_SWEEP_PROMPT_OPENER} for "Apollo" — OLD VERSION` }), MACHINE('poll1')]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sweep1' },
      data: { prompt: currentSweepPrompt(), promptSetBy: 'system' },
    });
  });

  // wake-cadence-3 (2026-09-27 tt-rd audit): the tt-rd supervisor cut its own
  // stock sweep to 30 min (receipt f089cbf4) and the heal never restored it.
  it('CADENCE FLOOR heal: a stock keeper BELOW the default is restored to it (audited, source project-sweep-cadence-floor); rows at/above it — incl. a backed-off 4 h row — are untouched', async () => {
    mockLaneWithSweeps([STOCK('sweep1', { intervalSec: 1800 }), MACHINE('poll1', { intervalSec: 1800 })]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({ where: { id: 'sweep1' }, data: { intervalSec: PROJECT_SWEEP_INTERVAL_SEC } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'schedule.update', metadata: expect.objectContaining({ scheduleId: 'sweep1', source: 'project-sweep-cadence-floor', from: 1800, to: PROJECT_SWEEP_INTERVAL_SEC }) }),
    });
    jest.clearAllMocks();
    mockLaneWithSweeps([STOCK('sweep1', { intervalSec: 4 * 3600 })]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
  });

  // fixer 2026-09-27: the floor refusal promises "An owner turn may still set it lower" — the heal must not undo it.
  it('CADENCE FLOOR heal, OWNER guard: a stock keeper the OWNER lowered (newest attributed schedule.update row = owner-interval) is left alone; a machine-attributed row heals; a read error skips the pass; PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS=1 heals owner rows too', async () => {
    const ownerRow = { metadata: { scheduleId: 'sweep1', chatId: 'psup1', fields: ['intervalSec'], source: 'owner-interval', from: 7200, to: 1800 } };
    const toolAudit = { metadata: { scheduleId: 'sweep1', fields: ['intervalSec'] } }; // platform.service's unattributed audit row lands AFTER the attributed one
    mockLaneWithSweeps([STOCK('sweep1', { intervalSec: 1800 })]);
    mockPrisma.activity.findMany.mockResolvedValue([toolAudit, ownerRow]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.activity.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: UID, resource: 'platform', action: 'schedule.update', metadata: { path: ['scheduleId'], equals: 'sweep1' } },
      orderBy: { createdAt: 'desc' },
    }));
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ metadata: expect.objectContaining({ source: 'project-sweep-cadence-floor' }) }) });
    // a machine turn cut it (attributed machine-interval, newer than an older owner edit) → healed as before
    jest.clearAllMocks();
    mockLaneWithSweeps([STOCK('sweep1', { intervalSec: 1800 })]);
    mockPrisma.activity.findMany.mockResolvedValue([{ metadata: { scheduleId: 'sweep1', fields: ['intervalSec'], source: 'machine-interval', from: 7200, to: 1800 } }, ownerRow]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({ where: { id: 'sweep1' }, data: { intervalSec: PROJECT_SWEEP_INTERVAL_SEC } });
    // a read error: skipped THIS pass (never a silent override on a DB blip), retried next pass
    jest.clearAllMocks();
    mockLaneWithSweeps([STOCK('sweep1', { intervalSec: 1800 })]);
    mockPrisma.activity.findMany.mockRejectedValue(new Error('db blip'));
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/interval attribution read failed .* heal skipped this pass/));
    // the opt-in restores the unconditional heal (no attribution read at all)
    jest.clearAllMocks();
    process.env.PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS = '1';
    try {
      mockLaneWithSweeps([STOCK('sweep1', { intervalSec: 1800 })]);
      mockPrisma.activity.findMany.mockResolvedValue([ownerRow]);
      await ensureProjectSupervisor(UID, PID);
      expect(mockPrisma.activity.findMany).not.toHaveBeenCalled();
      expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({ where: { id: 'sweep1' }, data: { intervalSec: PROJECT_SWEEP_INTERVAL_SEC } });
    } finally {
      delete process.env.PROJECT_SWEEP_FLOOR_HEAL_OWNER_ROWS;
    }
  });

  it('toggle-ON: with no enabled sweep, the newest PAUSED stock row is RESUMED (schedule.service resume shape + current prompt) instead of a new row being created — and audited', async () => {
    mockLaneWithSweeps([]);
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: 'paused1', runsCount: 40, maxRuns: 500, expiresAt: new Date(Date.now() + 86400_000), lastStatus: 'paused', cancelledBy: 'owner' });
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 'psup1', kind: 'recurring', enabled: false, prompt: { startsWith: PROJECT_SWEEP_PROMPT_OPENER } },
      orderBy: { createdAt: 'desc' },
    }));
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({
      where: { id: 'paused1' },
      data: {
        // ff0f6ad9: the ensure's auto-resume stamps its ACTOR, never a bare 'resumed'.
        enabled: true, lastStatus: 'resumed:project_sweep_ensure', cancelledBy: null, disabledAt: null, busySkips: 0,
        nextRunAt: expect.any(Date), prompt: currentSweepPrompt(), promptSetBy: 'system',
      },
    });
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'schedule.resume',
        metadata: expect.objectContaining({ scheduleId: 'paused1', chatId: 'psup1', projectId: PID, source: 'project-sweep-ensure' }),
      }),
    });
  });

  it('toggle-ON: a paused stock row whose expiry LAPSED is resumed with its expiry slid forward', async () => {
    mockLaneWithSweeps([]);
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: 'paused1', runsCount: 40, maxRuns: 500, expiresAt: new Date(Date.now() - 1000), lastStatus: 'paused', cancelledBy: 'owner' });
    await ensureProjectSupervisor(UID, PID);
    const data = mockPrisma.codingSchedule.update.mock.calls[0][0].data;
    expect(data.enabled).toBe(true);
    expect(data.expiresAt).toEqual(expect.any(Date));
    expect(data.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
  });

  it('toggle-ON: an EXHAUSTED paused stock row (runsCount ≥ maxRuns) is left alone and a fresh sweep is created', async () => {
    mockLaneWithSweeps([]);
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({ id: 'spent', runsCount: 500, maxRuns: 500, expiresAt: null });
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).toHaveBeenCalledTimes(1);
  });

  it('no paused stock row at all → the stock sweep is created (unchanged first-scaffold path)', async () => {
    mockLaneWithSweeps([]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).toHaveBeenCalledTimes(1);
  });
});

/* ====================================================================
 * Ticket ff0f6ad9 (2026-09-17) — replay: the spark-cluster supervisor
 * cancel_schedule'd its stock sweep at 21:44Z under the owner's stop order;
 * the 15-min watchdog heal (healProjectSupervisors → ensureProjectSupervisor
 * → ensureProjectSweepSchedule) treated the cancelled row as toggle-OFF
 * damage and silently RESUMED it within minutes (cancelledBy wiped, an
 * unattributed "last resumed" all the lane could see). Pins: an explicitly
 * cancelled stock sweep is a DURABLE stop — never resumed, never re-created,
 * no per-heal audit spam — while a genuinely PAUSED row still resumes WITH
 * the actor stamped.
 * ==================================================================== */
describe('ff0f6ad9 — an explicitly CANCELLED stock sweep is a DURABLE stop', () => {
  const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

  /** Existing healthy lane (project-scope hook enabled) with NO enabled
   *  recurring rows and ONE disabled stock row stamped lastStatus 'cancelled'
   *  — the exact post-cancel_schedule shape from the ticket. */
  function mockLaneWithCancelledSweep() {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]); // no ENABLED recurring rows
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({
      id: 'sweep1', runsCount: 77, maxRuns: 500, expiresAt: FUTURE,
      lastStatus: 'cancelled', cancelledBy: 'machine', // the lane's own 21:44Z cancel_schedule
    });
  }

  it('THE BUG: the cancelled sweep is NOT resumed and NOT re-created — across repeated watchdog heals', async () => {
    mockLaneWithCancelledSweep();
    await ensureProjectSupervisor(UID, PID);
    await ensureProjectSupervisor(UID, PID); // the next 15-min heal — the stop must survive it too
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    // Quiet suppression: no resume-audit spam per heal (the cancelled row
    // itself — lastStatus/cancelledBy/disabledAt, now surfaced in
    // list_schedules — IS the attribution record).
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'schedule.resume' }),
    });
    // …but the suppression IS logged once per heal for backend forensics.
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('respecting the deliberate stop'));
  });

  it('toggle-ON: a pause-audit row CANCELLED after the pause was recorded is NOT resumed by id either — named skippedCancelled in the resume audit', async () => {
    // Paused lane (project-scope hook disabled — the pause signature), whose
    // stock sweep was explicitly cancelled WHILE the flag was off.
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '',
    });
    mockPrisma.activity.findFirst.mockImplementation(async ({ where }: any) => {
      if (where?.action === 'project_supervisor.pause') {
        return {
          id: 'act-pause', createdAt: new Date('2026-09-17T10:00:00Z'),
          metadata: { chatId: 'psup1', projectId: PID, hookIds: ['h1'], scheduleIds: ['sweep1'] },
        };
      }
      return null; // no resume after the pause
    });
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.codingSchedule.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.id?.in) {
        // The by-id resume read: cancelled after the pause recorded it.
        return [{ id: 'sweep1', kind: 'recurring', nextRunAt: FUTURE, intervalSec: 3600, maxRuns: 500, runsCount: 12, expiresAt: FUTURE, lastStatus: 'cancelled' }];
      }
      return []; // no enabled sweep afterwards either
    });
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({
      id: 'sweep1', runsCount: 12, maxRuns: 500, expiresAt: FUTURE, lastStatus: 'cancelled', cancelledBy: 'owner',
    });

    await ensureProjectSupervisor(UID, PID);

    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'project_supervisor.resume',
        metadata: expect.objectContaining({ schedulesResumed: 0, skippedCancelled: ['sweep1'] }),
      }),
    });
  });

  it('a genuinely PAUSED stock row (lastStatus paused, e.g. toggle-OFF) still resumes — WITH the scaffolding actor stamped (attributable in list_schedules)', async () => {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({
      id: 'paused1', runsCount: 40, maxRuns: 500, expiresAt: FUTURE, lastStatus: 'paused', cancelledBy: 'owner',
    });
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({
      where: { id: 'paused1' },
      data: expect.objectContaining({ enabled: true, lastStatus: 'resumed:project_sweep_ensure', cancelledBy: null, disabledAt: null }),
    });
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'schedule.resume',
        metadata: expect.objectContaining({ scheduleId: 'paused1', source: 'project-sweep-ensure' }),
      }),
    });
  });
});

describe('ensureProjectSupervisor — create race + never-throws', () => {
  it('converges on the winner when the create race loses with P2002 (partial unique index)', async () => {
    mockFlagOnProject();
    mockPrisma.crossModelChat.create.mockRejectedValue({ code: 'P2002' });
    const WINNER = { id: 'psup-win', userId: UID, projectId: PID, title: 'Apollo Supervisor' };
    mockPrisma.crossModelChat.findFirst.mockImplementation(async ({ where }: any) =>
      where?.isSupervisor === true ? FLEET
        : where?.isProjectSupervisor === true && where?.userId ? null // pre-create lane lookup
          : where?.isProjectSupervisor === true ? WINNER // post-P2002 winner lookup
            : null);
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup-win', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);

    const chat = await ensureProjectSupervisor(UID, PID);
    expect(chat.id).toBe('psup-win');
    expect(mockPrisma.chatAutonomy.upsert).not.toHaveBeenCalled(); // winner already granted
  });

  it('NEVER throws — a create failure degrades to a warn + null', async () => {
    mockFlagOnProject();
    mockPrisma.crossModelChat.create.mockRejectedValue(new Error('db down'));
    await expect(ensureProjectSupervisor(UID, PID)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ensure failed'));
  });
});

/* ====================================================================
 * pauseProjectSupervisor — disable, NEVER delete
 * ==================================================================== */
describe('pauseProjectSupervisor', () => {
  // Pin updated 2026-09-14 (hardening review): pause now disables EVERY enabled
  // hook that wakes the lane (project-scope AND direct — the old filter left a
  // directly-subscribed run_failed waking a "paused" full-autonomy lane) by
  // exact id, stamps schedules like every other disable path, and records the
  // ids in the audit so toggle-ON can resume precisely those.
  it('disables EVERY enabled hook targeting the lane (project-scope + direct) and ALL enabled schedules by exact id, records the ids in the audit — and deletes NOTHING', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'psup1' });
    mockPrisma.eventHook.findMany.mockResolvedValue([
      { id: 'h1', sourceChatId: null, projectId: PID },          // the project-scope hook
      { id: 'h-direct', sourceChatId: 'worker1', projectId: null }, // a direct worker→lane hook
    ]);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 's1', kind: 'recurring' }, { id: 's2', kind: 'once' }]);
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.codingSchedule.updateMany.mockResolvedValue({ count: 2 });

    await pauseProjectSupervisor(UID, PID);

    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledWith({
      where: { userId: UID, projectId: PID, isProjectSupervisor: true },
      select: { id: true },
    });
    expect(mockPrisma.eventHook.findMany).toHaveBeenCalledWith({
      where: { targetChatId: 'psup1', enabled: true },
      select: { id: true, sourceChatId: true, projectId: true, createdVia: true },
    });
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['h1', 'h-direct'] }, enabled: true },
      data: { enabled: false },
    });
    expect(mockPrisma.codingSchedule.findMany).toHaveBeenCalledWith({
      where: { sessionId: 'psup1', enabled: true },
      select: { id: true, kind: true },
    });
    expect(mockPrisma.codingSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1', 's2'] }, enabled: true },
      data: { enabled: false, lastStatus: 'paused', cancelledBy: 'owner', disabledAt: expect.any(Date) },
    });
    // Pause-never-delete: no delete of ANY kind (chat, hooks, schedules, grant).
    expect(mockPrisma.crossModelChat.delete).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.chatAutonomy.deleteMany).not.toHaveBeenCalled();
    // The pause is audited with the disable counts AND the exact ids (toggle-ON reads these).
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID, action: 'project_supervisor.pause', resource: 'platform',
        metadata: expect.objectContaining({
          projectId: PID, chatId: 'psup1', hooksDisabled: 2, schedulesDisabled: 2,
          hookIds: ['h1', 'h-direct'], scheduleIds: ['s1', 's2'], directHookIds: ['h-direct'],
        }),
      }),
    });
  });

  // Hardening review 2026-09-14: the watchdog heal re-pauses every ineligible
  // lane every 15 min; the old unconditional updateMany + audit wrote ~96
  // phantom "pause" Activity rows per day per paused lane, forever.
  it('an ALREADY-PAUSED lane (nothing enabled) is quiet: no updateMany, no audit row, no info log', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'psup1' });
    mockPrisma.eventHook.findMany.mockResolvedValue([]);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]);

    await pauseProjectSupervisor(UID, PID);

    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('a pause that RACED another pause (rows flipped between read and write → counts 0) does not double-audit', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'psup1' });
    mockPrisma.eventHook.findMany.mockResolvedValue([{ id: 'h1', sourceChatId: null, projectId: PID }]);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 0 });

    await pauseProjectSupervisor(UID, PID);

    expect(mockPrisma.codingSchedule.updateMany).not.toHaveBeenCalled(); // no schedule ids → no write at all
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('no lane → zero writes (idempotent)', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    await pauseProjectSupervisor(UID, PID);
    expect(mockPrisma.eventHook.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('empty args are a no-op; a DB failure is a warn, never a throw', async () => {
    await pauseProjectSupervisor('', PID);
    expect(mockPrisma.crossModelChat.findFirst).not.toHaveBeenCalled();
    mockPrisma.crossModelChat.findFirst.mockRejectedValue(new Error('db down'));
    await expect(pauseProjectSupervisor(UID, PID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pause failed'));
  });
});

/* ====================================================================
 * audit 2026-10-08 W1-1 — the pause / heal never disables spawn-wired hooks
 * (REPLAY of the One Piece incident: supervisor 5c3f302e on a project with
 * projectSupervisorEnabled=false spawned lane 7bd45d57; the spawn wired child
 * result hook 7ad7880d at 21:55:36 and the 21:58:48 heal tick disabled it —
 * the lane's 6 completions woke nobody).
 * ==================================================================== */
describe('audit 2026-10-08 W1-1 — pause keeps spawn-wired hooks', () => {
  const PS = '5c3f302e-aaaa-4bbb-8ccc-000000000001';
  const CHILD_HOOK = { id: '7ad7880d-aaaa-4bbb-8ccc-000000000002', sourceChatId: '7bd45d57-aaaa-4bbb-8ccc-000000000003', projectId: null, createdVia: 'system:child-result-hook' };
  const SELF_WAKE = { id: 'fda79d56-aaaa-4bbb-8ccc-000000000004', sourceChatId: PS, projectId: null, createdVia: 'system:direct-wake' };
  const PROJECT_HOOK = { id: 'h-proj', sourceChatId: null, projectId: PID, createdVia: null };
  const PEER_HOOK = { id: 'h-peer', sourceChatId: 'peer1', projectId: null, createdVia: 'tool' };
  afterEach(() => { delete process.env.PAUSE_KEEPS_SPAWN_HOOKS_DISABLED; });

  it('a toggle-OFF pause disables the project-scope + subscribed hooks but leaves the child-result and direct-wake hooks enabled (audited as keptSpawnHookIds)', async () => {
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: PS });
    mockPrisma.eventHook.findMany.mockResolvedValue([PROJECT_HOOK, PEER_HOOK, CHILD_HOOK, SELF_WAKE]);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 's1', kind: 'recurring' }]);
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.codingSchedule.updateMany.mockResolvedValue({ count: 1 });

    await pauseProjectSupervisor(UID, PID);

    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['h-proj', 'h-peer'] }, enabled: true }, data: { enabled: false } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'project_supervisor.pause',
        metadata: expect.objectContaining({ hookIds: ['h-proj', 'h-peer'], keptSpawnHookIds: [CHILD_HOOK.id, SELF_WAKE.id] }),
      }),
    });
  });

  it('REPLAY: the 15-min heal on a paused One Piece supervisor whose ONLY enabled hooks are spawn-wired is a no-op — no write, no audit, every tick', async () => {
    mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.projectSupervisorEnabled === true) return [];
      if (where?.id?.in) return [{ id: PID, userId: UID, isUserSpace: false, archivedAt: null, projectSupervisorEnabled: false }];
      return [];
    });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: PS, projectId: PID }]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: PS });
    mockPrisma.eventHook.findMany.mockImplementation(async ({ where }: any) => (where?.targetChatId ? [CHILD_HOOK, SELF_WAKE] : []));
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]); // the toggle-OFF pause already parked the sweep

    await healProjectSupervisors(UID); // 21:58:48 tick
    await healProjectSupervisors(UID); // 22:13:48 tick

    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalled();
  });

  it('kill switch PAUSE_KEEPS_SPAWN_HOOKS_DISABLED=1 restores the disable-every-hook pause', async () => {
    process.env.PAUSE_KEEPS_SPAWN_HOOKS_DISABLED = '1';
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: PS });
    mockPrisma.eventHook.findMany.mockResolvedValue([PROJECT_HOOK, CHILD_HOOK, SELF_WAKE]);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]);
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 3 });

    await pauseProjectSupervisor(UID, PID);

    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({ where: { id: { in: ['h-proj', CHILD_HOOK.id, SELF_WAKE.id] }, enabled: true }, data: { enabled: false } });
    const meta = mockPrisma.activity.create.mock.calls[0][0].data.metadata;
    expect(meta.keptSpawnHookIds).toBeUndefined();
  });
});

/* ====================================================================
 * healProjectSupervisors — watchdog reconcile
 * ==================================================================== */
describe('stripStrayCodingState — supervisor lanes are plain chats by design (rollout watch 2026-09-14)', () => {
  beforeEach(() => {
    mockPrisma.chatCodingState.findUnique.mockReset().mockResolvedValue(null);
    mockPrisma.chatCodingState.delete.mockReset().mockResolvedValue({});
    mockPrisma.agentRun.count.mockReset().mockResolvedValue(0);
  });

  it('no satellite → no-op, nothing deleted, no audit', async () => {
    expect(await stripStrayCodingState(UID, 'psup1')).toBe(false);
    expect(mockPrisma.chatCodingState.delete).not.toHaveBeenCalled();
  });

  it('THE INCIDENT: a lazily attached satellite on an IDLE lane is deleted with an audit row (the worktree dir is left to the on-disk reaper)', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'psup1', worktreePath: '/app/coding-workspaces/worktrees/psup1', branch: 'digby/session-psup1' });
    expect(await stripStrayCodingState(UID, 'psup1')).toBe(true);
    expect(mockPrisma.chatCodingState.delete).toHaveBeenCalledWith({ where: { id: 'psup1' } });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'project_supervisor.strip_coding_state',
        metadata: expect.objectContaining({ chatId: 'psup1', branch: 'digby/session-psup1' }),
      }),
    });
  });

  it('a lane with a coding run IN FLIGHT keeps its satellite this pass (the run finalizes against the row) — strip defers to the next heal', async () => {
    mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'psup1', worktreePath: null, branch: 'digby/session-psup1' });
    mockPrisma.agentRun.count.mockResolvedValue(1);
    expect(await stripStrayCodingState(UID, 'psup1')).toBe(false);
    expect(mockPrisma.chatCodingState.delete).not.toHaveBeenCalled();
  });

  it('a DB error never throws (returns false)', async () => {
    mockPrisma.chatCodingState.findUnique.mockRejectedValue(new Error('down'));
    expect(await stripStrayCodingState(UID, 'psup1')).toBe(false);
  });

  describe('queued coding wakes (the back-to-back lane — bench 615723ba ran 6 consecutive coding runs)', () => {
    beforeEach(() => {
      mockPrisma.chatCodingState.findUnique.mockResolvedValue({ id: 'psup1', worktreePath: null, branch: 'digby/session-psup1' });
      mockPrisma.agentRun.count.mockReset().mockImplementation(async ({ where }: any) => (where?.status === 'running' ? 0 : 2));
      mockPrisma.agentRun.updateMany.mockReset().mockResolvedValue({ count: 2 });
    });

    it('the 15-min heal path DEFERS when queued wakes exist (no cancelQueued)', async () => {
      expect(await stripStrayCodingState(UID, 'psup1')).toBe(false);
      expect(mockPrisma.chatCodingState.delete).not.toHaveBeenCalled();
      expect(mockPrisma.agentRun.updateMany).not.toHaveBeenCalled();
    });

    it('the run-finalize path (cancelQueued) cancels the queued wakes, strips, and audits the count', async () => {
      expect(await stripStrayCodingState(UID, 'psup1', { cancelQueued: true })).toBe(true);
      expect(mockPrisma.agentRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { sessionId: 'psup1', status: 'queued' },
        data: expect.objectContaining({ status: 'cancelled' }),
      }));
      expect(mockPrisma.chatCodingState.delete).toHaveBeenCalledWith({ where: { id: 'psup1' } });
      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ metadata: expect.objectContaining({ cancelledQueuedRuns: 2 }) }),
      });
    });

    it('a RUNNING wake still defers even with cancelQueued (the run finalizes against the row)', async () => {
      mockPrisma.agentRun.count.mockImplementation(async ({ where }: any) => (where?.status === 'running' ? 1 : 0));
      expect(await stripStrayCodingState(UID, 'psup1', { cancelQueued: true })).toBe(false);
      expect(mockPrisma.chatCodingState.delete).not.toHaveBeenCalled();
    });
  });
});

describe('healProjectSupervisors', () => {
  it('ensures a lane for every OWNED flag-on project (scaffolds the missing one)', async () => {
    mockFlagOnProject(); // the ensure flow for p1 (no existing lane → full scaffold)
    mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where }: any) =>
      where?.projectSupervisorEnabled === true ? [{ id: PID }] : []);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]); // step 2: no lanes yet
    mockPrisma.eventHook.findMany.mockResolvedValue([]); // step 3: no project hooks

    await healProjectSupervisors(UID);

    expect(mockPrisma.crossModelChat.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.create.mock.calls[0][0].data.project).toEqual({ connect: { id: PID } });
    expect(mockPrisma.eventHook.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.codingSchedule.create).toHaveBeenCalledTimes(1);
  });

  /** Route eventHook.findMany: the pause's "enabled hooks on this lane" read vs the heal's step-3 project-hook scan. */
  function mockPauseReads(hookRows: any[], scheduleRows: any[]) {
    mockPrisma.eventHook.findMany.mockImplementation(async ({ where }: any) => (where?.targetChatId ? hookRows : []));
    mockPrisma.codingSchedule.findMany.mockResolvedValue(scheduleRows);
  }

  // Pin updated 2026-09-14 (hardening review): pause disables by exact id
  // (every enabled hook targeting the lane + every enabled schedule) — see the
  // pauseProjectSupervisor suite for the full shape.
  it('pauses a lane whose project flag flipped OFF (disable-only, nothing deleted)', async () => {
    mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.projectSupervisorEnabled === true) return []; // eligible scan: nothing flag-on
      if (where?.id?.in) return [{ id: 'p2', userId: UID, isUserSpace: false, archivedAt: null, projectSupervisorEnabled: false }];
      return [];
    });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'psup1', projectId: 'p2' }]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'psup1' }); // pause's lane lookup
    mockPauseReads([{ id: 'h1', sourceChatId: null, projectId: 'p2' }], [{ id: 's1', kind: 'recurring' }]);
    mockPrisma.eventHook.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.codingSchedule.updateMany.mockResolvedValue({ count: 1 });

    await healProjectSupervisors(UID);

    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['h1'] }, enabled: true },
      data: { enabled: false },
    });
    expect(mockPrisma.codingSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] }, enabled: true },
      data: { enabled: false, lastStatus: 'paused', cancelledBy: 'owner', disabledAt: expect.any(Date) },
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'project_supervisor.pause', metadata: expect.objectContaining({ hookIds: ['h1'], scheduleIds: ['s1'] }) }),
    });
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled();
  });

  // Hardening review 2026-09-14: the heal runs every 15 min — an already-paused
  // ineligible lane must not produce a fresh "pause" audit row + info log each time.
  it('an ALREADY-PAUSED ineligible lane is left quiet on every subsequent sweep (no writes, no audit, no log)', async () => {
    mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.projectSupervisorEnabled === true) return [];
      if (where?.id?.in) return [{ id: 'p2', userId: UID, isUserSpace: false, archivedAt: null, projectSupervisorEnabled: false }];
      return [];
    });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'psup1', projectId: 'p2' }]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'psup1' });
    mockPauseReads([], []); // everything already disabled

    await healProjectSupervisors(UID);

    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).not.toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'project_supervisor.pause' }) });
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('paused lane'));
  });

  it('pauses a lane whose project row VANISHED (defensive — the FK should have detached it first)', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]); // eligible: none; laneProjects: none
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'psup1', projectId: 'p-gone' }]);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'psup1' });
    mockPauseReads([], [{ id: 's1', kind: 'recurring' }]);
    mockPrisma.codingSchedule.updateMany.mockResolvedValue({ count: 1 });

    await healProjectSupervisors(UID);

    expect(mockPrisma.codingSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['s1'] }, enabled: true },
      data: { enabled: false, lastStatus: 'paused', cancelledBy: 'owner', disabledAt: expect.any(Date) },
    });
  });

  it('leaves a HEALTHY lane alone (flag still on: no pause writes, no scaffold writes)', async () => {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() }); // ensure heals in place
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{ id: 'sch1', prompt: currentSweepPrompt(), kind: 'recurring' }]);
    mockPrisma.crossModelProject.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.projectSupervisorEnabled === true) return [{ id: PID }];
      if (where?.id?.in) return [{ ...PROJECT }];
      return [];
    });
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'psup1', projectId: PID }]);
    mockPrisma.eventHook.findMany.mockResolvedValue([]);

    await healProjectSupervisors(UID);

    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
  });

  it('disables a STALE project-scope hook whose lane chat moved to a different project (never deletes)', async () => {
    mockPrisma.crossModelProject.findMany.mockResolvedValue([]);
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]); // no supervisor lanes
    mockPrisma.eventHook.findMany.mockResolvedValue([
      { id: 'h-stale', targetChatId: 'psup1', projectId: 'p1' },
      { id: 'h-ok', targetChatId: 'psup2', projectId: 'p2' },
      { id: 'h-gone', targetChatId: 'psup-deleted', projectId: 'p3' },
    ]);
    mockPrisma.crossModelChat.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.isProjectSupervisor === true) return [];
      if (where?.id?.in) return [{ id: 'psup1', projectId: 'p9' }, { id: 'psup2', projectId: 'p2' }]; // psup1 drifted; psup-deleted vanished
      return [];
    });

    await healProjectSupervisors(UID);

    // h-stale (drifted) + h-gone (target vanished) disabled; h-ok (still matched) untouched.
    expect(mockPrisma.eventHook.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h-stale' }, data: { enabled: false } });
    expect(mockPrisma.eventHook.update).toHaveBeenCalledWith({ where: { id: 'h-gone' }, data: { enabled: false } });
    expect(mockPrisma.eventHook.update).not.toHaveBeenCalledWith({ where: { id: 'h-ok' }, data: expect.anything() });
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'hook.update',
        metadata: expect.objectContaining({ hookId: 'h-stale', reason: expect.stringContaining('moved out') }),
      }),
    });
  });

  it('empty userId is a no-op; a DB failure is a warn, never a throw', async () => {
    await healProjectSupervisors('');
    expect(mockPrisma.crossModelProject.findMany).not.toHaveBeenCalled();
    mockPrisma.crossModelProject.findMany.mockRejectedValue(new Error('db down'));
    await expect(healProjectSupervisors(UID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('heal failed'));
  });
});

/* ====================================================================
 * gcDetachedProjectSupervisors — project deleted → lane detached
 * ==================================================================== */
describe('gcDetachedProjectSupervisors', () => {
  it('detaches every projectId-null lane: hooks + schedules disabled, flag flipped false, count returned — nothing deleted', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'psup1' }, { id: 'psup2' }]);

    const count = await gcDetachedProjectSupervisors(UID);

    expect(count).toBe(2);
    expect(mockPrisma.crossModelChat.findMany).toHaveBeenCalledWith({
      where: { userId: UID, isProjectSupervisor: true, projectId: null },
      select: { id: true },
    });
    for (const id of ['psup1', 'psup2']) {
      // Pin updated 2026-09-14 (hardening review): every hook that wakes a
      // detached lane is disabled (direct hooks too), same widening as pause.
      expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({
        where: { targetChatId: id },
        data: { enabled: false },
      });
      expect(mockPrisma.codingSchedule.updateMany).toHaveBeenCalledWith({
        where: { sessionId: id },
        data: { enabled: false },
      });
      expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
        where: { id },
        data: { isProjectSupervisor: false },
      });
    }
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: UID, action: 'project_supervisor.gc_detach', resource: 'platform',
        metadata: expect.objectContaining({ chatId: 'psup1' }),
      }),
    });
    // The chat (the owner's transcript) is NEVER deleted.
    expect(mockPrisma.crossModelChat.delete).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.delete).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.deleteMany).not.toHaveBeenCalled();
  });

  it('no detached lanes → 0 and no writes', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([]);
    await expect(gcDetachedProjectSupervisors(UID)).resolves.toBe(0);
    expect(mockPrisma.eventHook.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
  });

  it('a per-lane failure is isolated — the other lane still detaches (count of SUCCESSES)', async () => {
    mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'psup1' }, { id: 'psup2' }]);
    mockPrisma.eventHook.updateMany
      .mockRejectedValueOnce(new Error('db down')) // psup1's first write fails
      .mockResolvedValue({ count: 1 });

    await expect(gcDetachedProjectSupervisors(UID)).resolves.toBe(1);
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledTimes(1); // only psup2 flipped
    expect(mockPrisma.crossModelChat.update).toHaveBeenCalledWith({
      where: { id: 'psup2' },
      data: { isProjectSupervisor: false },
    });
  });

  it('empty userId → 0 without querying; an outer failure → 0, never a throw', async () => {
    await expect(gcDetachedProjectSupervisors('')).resolves.toBe(0);
    expect(mockPrisma.crossModelChat.findMany).not.toHaveBeenCalled();
    mockPrisma.crossModelChat.findMany.mockRejectedValue(new Error('db down'));
    await expect(gcDetachedProjectSupervisors(UID)).resolves.toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GC failed'));
  });
});

/* ====================================================================
 * Ticket b1d435fd (owner directive 2026-09-18) — GOAL-GATE: a project with
 * NO live work (no active goals, open todos, live runs, or live watched
 * resources) is DORMANT and gets ZERO wakes. Replay of the spark-cluster
 * resurrection loop: the stopped project's sweep kept being re-armed/resumed
 * by the ensure machinery (8th occurrence, 96/480 daily firings burned on a
 * 0-goal project). Pins: the sweep ensure PARKS an enabled stock sweep on a
 * dormant project (never resumes, never creates) and toggle-ON leaves the
 * pause's schedule ids parked while STILL restoring the hooks (the zero-
 * token wake path for new work). The predicate itself is unit-tested in
 * coding/dormancy-gate.service.test.ts; the fire-time park in
 * coding/dormancy-gate.b1d435fd.test.ts.
 * ==================================================================== */
describe('b1d435fd — goal-gate: dormant projects get ZERO wakes from the ensure/resume paths', () => {
  const DORMANT = {
    dormant: true, projectId: PID,
    reason: 'project "Apollo" is dormant — no active goals, open todos, live/queued runs, or live watched resources (owner directive 2026-09-18)',
    signals: { activeGoals: 0, openTodos: 0, liveRuns: 0, watchedResources: 0 },
  };
  const sweepPrompt = () => buildProjectSupervisorSweepPrompt({ projectName: PROJECT.name, projectId: PID, fleetSupervisorChatId: FLEET.id });

  beforeEach(() => {
    mockEvaluateProjectDormancy.mockResolvedValue({ ...DORMANT });
  });

  it('an ENABLED stock sweep on a dormant project is PARKED (parked:dormant) — not run, not healed, not recreated — and repeats heal quiet once parked', async () => {
    // Stateful schedule rows so the second heal sees the park it wrote.
    const rows: any[] = [{ id: 'sweep1', prompt: sweepPrompt(), kind: 'recurring', enabled: true, runsCount: 96, promptSetBy: 'system' }];
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockImplementation(async ({ where }: any) =>
      rows.filter((r) => r.kind === 'recurring' && (where?.enabled === undefined || r.enabled === where.enabled)));
    mockPrisma.codingSchedule.update.mockImplementation(async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where?.id);
      if (r) Object.assign(r, data);
      return {};
    });

    await ensureProjectSupervisor(UID, PID);
    // THE FIX: the 96-firing sweep is parked with the goal-gate stamp…
    expect(rows[0]).toEqual(expect.objectContaining({ enabled: false, lastStatus: 'parked:dormant', cancelledBy: 'machine' }));
    expect(rows[0].disabledAt).toEqual(expect.any(Date));
    // …the schedule_disabled event carries the one-line dormancy reason…
    expect(emitScheduleDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sweep1' }), 'parked_dormant', 96,
      expect.objectContaining({ detail: expect.stringContaining('dormant') }),
    );
    // …and NOTHING is created beside it.
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();

    // The next 15-min heal: the row is already parked → no further writes at all (idempotent + quiet).
    mockPrisma.codingSchedule.update.mockClear();
    (emitScheduleDisabled as jest.Mock).mockClear();
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(emitScheduleDisabled).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
  });

  it('a PAUSED (disabled, non-cancelled) stock row on a dormant project is NOT resumed and NOT replaced — the resurrection loop is closed', async () => {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockResolvedValue([]); // no ENABLED recurring rows
    mockPrisma.codingSchedule.findFirst.mockResolvedValue({
      id: 'sweep1', runsCount: 8, maxRuns: 500, expiresAt: new Date(Date.now() + 86_400_000),
      lastStatus: 'paused', cancelledBy: null,
    });
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(emitScheduleDisabled).not.toHaveBeenCalled(); // nothing enabled → nothing to park → quiet
  });

  it('37fa747d: a dormancy park whose WRITE FAILS emits NO schedule_disabled — never announce "It stays parked" over a row that never parked', async () => {
    const rows: any[] = [{ id: 'sweep1', prompt: sweepPrompt(), kind: 'recurring', enabled: true, runsCount: 210, promptSetBy: 'system' }];
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: true, promptTemplate: '',
    });
    mockPrisma.codingSchedule.findMany.mockImplementation(async ({ where }: any) =>
      rows.filter((r) => r.kind === 'recurring' && (where?.enabled === undefined || r.enabled === where.enabled)));
    // The park write fails (transient DB error) — the row NEVER parks…
    mockPrisma.codingSchedule.update.mockRejectedValueOnce(new Error('db down'));
    await ensureProjectSupervisor(UID, PID);
    // …so the ALARM-class "It stays parked" event must NOT be emitted (37fa747d).
    expect(emitScheduleDisabled).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('dormancy park failed'));
    // …and nothing is created beside it (a failed park is not a resume path).
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
  });

  it('toggle-ON on a dormant project: hooks STILL resume (the wake path) but the pause’s schedule ids STAY parked — named skippedDormant in the audit', async () => {
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    // The pause signature: the project-scope hook is disabled…
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '',
    });
    // …and the pause audit recorded BOTH a hook id and a schedule id.
    mockPrisma.activity.findFirst.mockImplementation(async ({ where }: any) =>
      where?.action === 'project_supervisor.pause'
        ? { id: 'pause1', createdAt: new Date(Date.now() - 3_600_000), metadata: { hookIds: ['h1'], scheduleIds: ['sched-2ee243ad'] } }
        : null);
    await ensureProjectSupervisor(UID, PID);
    // Hook resumed — the zero-token wake path for new work is restored…
    expect(mockPrisma.eventHook.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['h1'] }, targetChatId: 'psup1', enabled: false },
      data: { enabled: true },
    });
    // …but the zero-work heartbeat was NOT re-armed…
    expect(mockPrisma.codingSchedule.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sched-2ee243ad' }, data: expect.objectContaining({ enabled: true }) }),
    );
    // …and the resume audit NAMES the dormancy skip.
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'project_supervisor.resume',
        metadata: expect.objectContaining({ skippedDormant: ['sched-2ee243ad'], schedulesResumed: 0 }),
      }),
    });
  });

  it('control: the same toggle-ON on a LIVE project resumes the schedule by id (the gate changes nothing when work exists)', async () => {
    mockEvaluateProjectDormancy.mockResolvedValue({
      dormant: false, projectId: PID, reason: 'live work',
      signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
    });
    mockFlagOnProject({ ...LANE, systemPrompt: currentStockPrompt() });
    mockPrisma.chatAutonomy.findUnique.mockResolvedValue({ chatId: 'psup1', allowedTools: [...AUTONOMY_GRANTABLE_TOOLS] });
    mockPrisma.eventHook.findFirst.mockResolvedValue({
      id: 'h1', eventTypes: [...PROJECT_SUPERVISOR_HOOK_EVENT_TYPES], enabled: false, promptTemplate: '',
    });
    mockPrisma.activity.findFirst.mockImplementation(async ({ where }: any) =>
      where?.action === 'project_supervisor.pause'
        ? { id: 'pause1', createdAt: new Date(Date.now() - 3_600_000), metadata: { hookIds: ['h1'], scheduleIds: ['sweep-live'] } }
        : null);
    mockPrisma.codingSchedule.findMany.mockResolvedValue([{
      id: 'sweep-live', kind: 'recurring', nextRunAt: new Date(Date.now() + 3_600_000),
      intervalSec: 3600, maxRuns: 500, runsCount: 3, expiresAt: new Date(Date.now() + 86_400_000), lastStatus: 'paused',
    }]);
    await ensureProjectSupervisor(UID, PID);
    expect(mockPrisma.codingSchedule.update).toHaveBeenCalledWith({
      where: { id: 'sweep-live' },
      data: expect.objectContaining({ enabled: true, lastStatus: 'resumed' }),
    });
    expect(mockPrisma.activity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'project_supervisor.resume',
        metadata: expect.objectContaining({ skippedDormant: [], schedulesResumed: 1 }),
      }),
    });
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// While project supervisors are switched off, ensure is READ-ONLY: an existing
// lane comes back untouched (no heal, no pause-resume, no hook/sweep arm) and
// no lane is scaffolded for an eligible flag-on project.
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests } from './supervisor-switch';

describe('supervisor OFF switch × ensureProjectSupervisor', () => {
  beforeEach(() => {
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) => (where?.key === 'project_supervisors_enabled' ? { key: where.key, value: '0', updatedAt: new Date() } : null));
    invalidateSupervisorSwitchCache();
    resetSupervisorSwitchMetricWindowForTests();
  });
  afterAll(() => { mockPrisma.systemSetting.findUnique.mockImplementation(async () => null); invalidateSupervisorSwitchCache(); });

  it('an EXISTING lane is returned untouched — no heal, no resume, no arm', async () => {
    mockFlagOnProject({ ...LANE, systemPrompt: 'legacy prompt' });
    const chat = await ensureProjectSupervisor(UID, PID);
    expect(chat).toMatchObject({ id: 'psup1' });
    expect(mockPrisma.chatAutonomy.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.codingSchedule.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelChat.update).not.toHaveBeenCalled();
    expect(mockPrisma.activity.findFirst).not.toHaveBeenCalled(); // no pause-resume lookup
    expect(mockRedisIncr).not.toHaveBeenCalled();
  });

  it('an eligible flag-on project with NO lane gets none scaffolded (null) and one counted skip (source ensure)', async () => {
    mockFlagOnProject(null);
    expect(await ensureProjectSupervisor(UID, PID)).toBeNull();
    expect(mockPrisma.crossModelChat.create).not.toHaveBeenCalled();
    expect(mockPrisma.eventHook.create).not.toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(mockRedisIncr).toHaveBeenCalledWith('supervisor_switch:skipped:project');
  });

  it('the FLEET switch alone does not gate project lanes; back ON the lane scaffolds as before', async () => {
    mockPrisma.systemSetting.findUnique.mockImplementation(async ({ where }: any) => (where?.key === 'fleet_supervisor_enabled' ? { key: where.key, value: '0', updatedAt: new Date() } : null));
    invalidateSupervisorSwitchCache();
    mockFlagOnProject(null);
    const chat = await ensureProjectSupervisor(UID, PID);
    expect(chat).toMatchObject({ id: 'psup1', isProjectSupervisor: true });
    expect(mockPrisma.crossModelChat.create).toHaveBeenCalledTimes(1);
  });
});


// ── KPI contract + time-boxing ride the SYSTEM prompt (tt-rd audit 2026-09-27) ─
describe('project supervisor system prompt — mission KPI contract + time-boxing (kpi-honesty-loops)', () => {
  const build = () => buildProjectSupervisorPrompt({ projectName: PROJECT.name, projectId: PID, fleetSupervisorChatId: FLEET.id });

  it('both blocks sit between Receipt discipline and the Spawn-guard doctrine; the sweep body stays slim', () => {
    const p = build();
    const kpiAt = p.indexOf('## Mission KPI contract');
    const tbAt = p.indexOf('## Time-boxing');
    expect(kpiAt).toBeGreaterThan(p.indexOf('## Receipt discipline'));
    expect(tbAt).toBeGreaterThan(kpiAt);
    expect(p.indexOf('## Spawn-guard doctrine')).toBeGreaterThan(tbAt);
    expect(p).toContain('goal_premise_set refuses a kpi: premise without an existing ok:true receipt');
    expect(p).toContain('SCHEDULE-PROMPT HYGIENE');
    const sweepBody = buildProjectSupervisorSweepPrompt({ projectName: PROJECT.name, projectId: PID, fleetSupervisorChatId: FLEET.id });
    expect(sweepBody).not.toContain('## Mission KPI contract');
    expect(sweepBody).not.toContain('## Time-boxing');
  });

  it('both blocks always render — neither the KPI contract nor time-boxing has a switch since build 2026-10-08 S-2', () => {
    const p = build();
    expect(p).toContain('## Mission KPI contract');
    expect(p).toContain('## Time-boxing');
    expect(p).toContain('## Spawn-guard doctrine');
  });
});
