/**
 * Ticket d1120ffc (filed 2026-11-02 by the Fleet Supervisor) — REPLAY:
 * "goal_update payloads sever in transit; a single start_coding_session
 * triple-fires into duplicate lanes."
 *
 * THE TWO REPORTED DEFECTS, as the ticket states them:
 *
 *   S1 — MUTATION PAYLOADS SEVER IN TRANSIT. A goal_update carrying a full
 *        brief landed a row whose `description` was EMPTY and whose priority
 *        was unset, while the tool returned an ordinary success — the caller
 *        could not tell "sent and truncated" from "not sent". The ticket's
 *        acceptance bar: "two consecutive goal_create/goal_update calls with a
 *        >2000-char description land byte-identical (goal_get description
 *        length matches input)".
 *
 *   S2 — ONE SPAWN BECOMES THREE LANES. "a repeated start_coding_session within
 *        60s returns the SAME chat id rather than creating a second."
 *
 * WHAT IS PINNED HERE (all through the REAL tool dispatch):
 *
 *   1. REPLAY of S1: a 3,000-char description written twice (goal_create then
 *      goal_update) lands byte-identically both times, goal_get returns it in
 *      full, and BOTH results carry the `[payload ECHO]` receipt naming the
 *      sent length and sha8 — the digest a caller compares on a retry.
 *   2. The loud arm: when the row does NOT hold what was sent (the service
 *      reshaped or dropped it), the result says `[payload FIDELITY FAILURE]`
 *      and names the field — a stub row can never read as plain success again.
 *   3. ATOMIC-OR-FAILED on the input side: a description that is an OBJECT (the
 *      shape that used to be stringified into "[object Object]") is REFUSED
 *      before the write, and the service is never called.
 *   4. `description: null` is the explicit CLEAR it always meant — it stores ''
 *      rather than the literal text "null".
 *   5. REPLAY of S2: two IDENTICAL start_coding_session calls from one chat
 *      within the dedupe window open ONE lane — the second returns the FIRST
 *      session id (with `deduplicated: true`, which the tool-intent journal
 *      reads as a replay) and the service is called exactly once.
 *   6. A DIFFERENT identity (title or brief) is a DIFFERENT spawn — the dedupe
 *      must never starve legitimate follow-on work.
 *   7. DIGBY_SPAWN_DEDUPE_WINDOW_SEC=0 restores spawn-always byte-for-byte.
 *   8. Every Redis hiccup FAILS OPEN: a dedupe that cannot read its claim never
 *      blocks a legitimate spawn.
 *
 * Scaffolding mirrors platform-tools.subsessions.test.ts (goals.service and
 * platform.service mocked at their dynamic-import boundary; prisma + redis
 * mocked at config/, the dd3a19fa discipline).
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
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));

// ── services under the tools (dynamic-import boundary) ────────────────────────
const svc = {
  startCodingSession: jest.fn(),
  // present so the dispatch's static import of platform.service resolves
  listChats: jest.fn(), getChatStatus: jest.fn(), getChatMessages: jest.fn(),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const goalsSvc = {
  createGoal: jest.fn(),
  updateGoal: jest.fn(),
  getGoal: jest.fn(),
  // A passthrough by default (the prefix-canonicalization seam downstream).
  canonicalGoalIdForTool: jest.fn(async (id: unknown) => String(id)),
};
jest.mock('./goals.service', () => ({ __esModule: true, ...goalsSvc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(), listFeedbackTickets: jest.fn(), updateFeedbackTicket: jest.fn(), isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(async () => null),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
  implicitParentAutonomyAllows: jest.fn(async () => false),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

const mockEnsureChildResultHook: jest.Mock = jest.fn(async () => ({ id: 'hook-1' }));
jest.mock('./hooks.service', () => ({ __esModule: true, ensureChildResultHook: (...a: any[]) => mockEnsureChildResultHook(...a) }));
const mockBuildParentContextBlock: jest.Mock = jest.fn(async () => '');
jest.mock('../coding/run-journal.service', () => ({ __esModule: true, buildParentContextBlock: (...a: any[]) => mockBuildParentContextBlock(...a) }));

// ── prisma boundary ──────────────────────────────────────────────────────────
const mockChatFindUnique: jest.Mock = jest.fn();
const mockChatCount: jest.Mock = jest.fn(async () => 0);
const mockChatUpdate: jest.Mock = jest.fn(async () => ({}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      count: (...a: any[]) => mockChatCount(...a),
      update: (...a: any[]) => mockChatUpdate(...a),
    },
    projectTodo: { findFirst: jest.fn(async () => null), updateMany: jest.fn(async () => ({ count: 0 })), findUnique: jest.fn(async () => null) },
    projectGoal: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
  },
}));

// ── the claim store: the seam config/redis registers in production ───────────
// A FRESH in-process store per test (registerSpawnClaimStore), so claims never
// leak between cases and nothing ever imports the env chain (config/redis
// process.exit(1)s in a bare test env — platform/spawn-claim-store.ts).
import { createMemorySpawnClaimStore, registerSpawnClaimStore, resetSpawnClaimStoreForTests, spawnClaimStoreIsShared, activeSpawnClaimStore } from './spawn-claim-store';

import { executePlatformTool } from './platform-tools';
import { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  return {
    worktree: '/wt', sessionId: 'caller-1', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
}
/** Auto-mode coding orchestrator — a consequential spawn executes in ONE call. */
const autoCodingCtx = () => makeCtx({ agentSurface: 'coding' } as any);

const SPAWNED = {
  id: 'sess-new', title: 'Dedupe the spawn path', projectId: 'p1',
  branch: 'digby/session-new', baseBranch: 'main', model: 'glm-5.3', permissionMode: 'auto',
};

beforeEach(() => {
  jest.clearAllMocks();
  registerSpawnClaimStore(createMemorySpawnClaimStore());
  delete process.env.DIGBY_SPAWN_DEDUPE_WINDOW_SEC;
  autonomySvc.getChatAutonomy.mockResolvedValue(null);
  autonomySvc.implicitParentAutonomyAllows.mockResolvedValue(false);
  svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
  mockChatFindUnique.mockResolvedValue({ id: 'caller-1', userId: 'u1' });
  mockChatCount.mockResolvedValue(0);
  mockEnsureChildResultHook.mockResolvedValue({ id: 'hook-1' });
  mockBuildParentContextBlock.mockResolvedValue('');
});
afterAll(() => { delete process.env.DIGBY_SPAWN_DEDUPE_WINDOW_SEC; });

// ── S1: mutation payload fidelity ────────────────────────────────────────────
describe('d1120ffc S1 — a goal brief lands byte-identically and SAYS so', () => {
  /** A brief well past the ticket's 2,000-char acceptance length. */
  const BRIEF = `${'The supervisor lane must not lose this brief. '.repeat(60)}END-OF-BRIEF-MARKER`;
  const sha8 = (s: string) => require('crypto').createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

  it('BRIEF is longer than the ticket\'s 2,000-char acceptance bar', () => {
    expect(BRIEF.length).toBeGreaterThan(2000);
  });

  it('REPLAY S1: goal_create then goal_update with the same >2,000-char description both land VERBATIM, and each result carries the [payload ECHO] digest', async () => {
    goalsSvc.createGoal.mockImplementation(async (o: any) => ({
      id: 'goal-1', projectId: o.projectId, title: o.title, description: o.description,
      status: 'active', priority: null, priorityLabel: 'P2',
    }));
    const created = String(await executePlatformTool(makeCtx(), 'goal_create', { projectId: 'p1', title: 'Transport fidelity', description: BRIEF }));
    // the ROW holds every byte — the service was handed the full string
    expect(goalsSvc.createGoal.mock.calls[0][0].description).toBe(BRIEF);
    expect(created).toContain(`[payload ECHO]`);
    expect(created).toContain(`description ${BRIEF.length} chars, sha8 ${sha8(BRIEF)}`);

    goalsSvc.updateGoal.mockImplementation(async (o: any) => ({
      id: 'goal-1', projectId: 'p1', title: 'Transport fidelity', description: o.description,
      status: 'active', priority: null, priorityLabel: 'P2',
    }));
    const updated = String(await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'goal-1', description: BRIEF }));
    expect(goalsSvc.updateGoal.mock.calls[0][0].description).toBe(BRIEF);
    expect(updated).toContain(`description ${BRIEF.length} chars, sha8 ${sha8(BRIEF)}`);
    // The SAME digest both times is the retry check the ticket asked for.
    expect(updated).toContain(sha8(BRIEF));
  });

  it('the LOUD arm: a row that does NOT hold the sent description reads [payload FIDELITY FAILURE], never plain success', async () => {
    // The reported symptom exactly: the write "succeeded", the row is EMPTY.
    goalsSvc.updateGoal.mockResolvedValue({
      id: 'goal-1', projectId: 'p1', title: 'Transport fidelity', description: '',
      status: 'active', priority: null, priorityLabel: 'P2',
    });
    const out = String(await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'goal-1', description: BRIEF }));
    expect(out).toContain('[payload FIDELITY FAILURE]');
    expect(out).toContain(`description: ${BRIEF.length} chars sent`);
    expect(out).toContain('the row is EMPTY, the value did not arrive');
    expect(out).not.toContain('[payload ECHO]');
  });

  it('a DIFFERING stored value (the service reshaped it) also reads as a failure', async () => {
    goalsSvc.createGoal.mockResolvedValue({
      id: 'goal-1', projectId: 'p1', title: 'Transport fidelity', description: BRIEF.slice(0, 500),
      status: 'active', priority: null, priorityLabel: 'P2',
    });
    const out = String(await executePlatformTool(makeCtx(), 'goal_create', { projectId: 'p1', title: 'Transport fidelity', description: BRIEF }));
    expect(out).toContain('[payload FIDELITY FAILURE]');
    expect(out).toContain('the stored value differs from what you sent');
  });

  it('ATOMIC-OR-FAILED: a non-string description is REFUSED before any write (nothing half-applies)', async () => {
    const out = String(await executePlatformTool(makeCtx(), 'goal_update', {
      goalId: 'goal-1', description: { text: 'the brief' }, progressNote: 'a valid sibling field',
    }));
    expect(out).toMatch(/tool call rejected/);
    expect(out).toContain('description arrived as object, not text');
    // The sibling field was valid, and the call STILL wrote nothing: a refusal is atomic.
    expect(goalsSvc.updateGoal).not.toHaveBeenCalled();
  });

  it('the create path refuses a non-string description too', async () => {
    const out = String(await executePlatformTool(makeCtx(), 'goal_create', { projectId: 'p1', title: 'T', description: ['a', 'b'] }));
    expect(out).toContain('description arrived as an array, not text');
    expect(goalsSvc.createGoal).not.toHaveBeenCalled();
  });

  it('description: null is the explicit CLEAR it always meant (stores "", never the text "null")', async () => {
    goalsSvc.updateGoal.mockImplementation(async (o: any) => ({
      id: 'goal-1', projectId: 'p1', title: 'T', description: o.description,
      status: 'active', priority: null, priorityLabel: 'P2',
    }));
    await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'goal-1', description: null });
    expect(goalsSvc.updateGoal.mock.calls[0][0].description).toBe('');
  });

  it('an id-only call with no payload carries NO echo (a status flip needs no proof)', async () => {
    goalsSvc.updateGoal.mockResolvedValue({
      id: 'goal-1', projectId: 'p1', title: 'T', description: 'unchanged',
      status: 'done', priority: null, priorityLabel: 'P2',
    });
    const out = String(await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'goal-1', status: 'done' }));
    expect(out).not.toContain('[payload ECHO]');
    expect(out).not.toContain('[payload FIDELITY FAILURE]');
  });
});

// ── adversarial-review regressions (B1 / B2) ─────────────────────────────────
// The review found the loud arm firing on CORRECT writes, which is worse than no
// receipt: it tells a caller to re-issue a write that already landed. Each case
// below is one of those false positives, verified against goals.service's real
// store semantics.
describe('d1120ffc review B1/B2 — the loud arm never fires on a CORRECT write', () => {
  beforeEach(() => {
    goalsSvc.updateGoal.mockImplementation(async (o: any) => ({
      id: 'goal-1', projectId: 'p1',
      // goals.service stores `String(title).trim()`
      title: (o.title !== undefined ? String(o.title) : 'T').trim(),
      description: o.description !== undefined ? String(o.description) : 'unchanged',
      status: o.status ?? 'active',
      blockedReason: null, priority: null, priorityLabel: 'P2',
    }));
  });

  it('B2: a title with surrounding whitespace/newlines is NOT a failure (the service trims it)', async () => {
    const out = String(await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'goal-1', title: '  Fix the spawn dedupe  \n' }));
    expect(out).not.toContain('[payload FIDELITY FAILURE]');
    // The success receipt names the field and its digest (it rides INSIDE the
    // JSON body, so a JSON.parse of this result still works).
    const parsed = JSON.parse(out);
    expect(parsed.payloadFidelity).toContain('title 20 chars');
  });

  it('B2: an OBJECT title is REFUSED before any write, so it can never become "[object Object]"', async () => {
    const out = String(await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'goal-1', title: { text: 'real title' } }));
    expect(out).toContain('title arrived as object, not text');
    expect(goalsSvc.updateGoal).not.toHaveBeenCalled();
  });

  it('B1: blockedReason is NOT compared across a status transition (the service clears it by contract)', async () => {
    // goals.service sets blockedReason = null on any non-blocked status — the
    // documented clear-on-unblock. Reporting that as data loss told the caller to
    // re-issue a write that had already landed correctly.
    const out = String(await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'goal-1', status: 'done', blockedReason: 'was blocked before' }));
    expect(out).not.toContain('[payload FIDELITY FAILURE]');
    const parsed = JSON.parse(out);
    expect(String(parsed.payloadFidelity ?? '')).not.toContain('blockedReason');
  });

  it('B1: a status-less blockedReason refresh IS compared, in the trimmed unit the service stores', async () => {
    goalsSvc.updateGoal.mockResolvedValue({
      id: 'goal-1', projectId: 'p1', title: 'T', description: 'd', status: 'blocked',
      blockedReason: 'waiting on owner', priority: null, priorityLabel: 'P2',
    });
    const out = String(await executePlatformTool(makeCtx(), 'goal_update', { goalId: 'goal-1', blockedReason: 'waiting on owner   ' }));
    expect(out).not.toContain('[payload FIDELITY FAILURE]');
    const parsed = JSON.parse(out);
    expect(parsed.payloadFidelity).toContain('blockedReason 16 chars');
  });
});

// ── S2: spawn dedupe ─────────────────────────────────────────────────────────
describe('d1120ffc S2 — one dispatch is ONE lane', () => {
  const SPAWN_ARGS = {
    projectId: 'p1',
    title: 'Dedupe the spawn path',
    prompt: 'Fix the spawn dedupe; acceptance is the same chat id on a retry.',
  };

  it('REPLAY S2: an identical spawn within the window returns the SAME chat id (the service runs ONCE)', async () => {
    const first = await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    const firstJson = JSON.parse(first);
    expect(firstJson.ids.sessionId).toBe('sess-new');
    expect(firstJson.deduplicated).toBeUndefined();

    const second = await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    // NOT a second lane: the service is never called again...
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    const secondJson = JSON.parse(second);
    // ...and the caller is handed the FIRST lane, flagged as a replay.
    expect(secondJson.ids.sessionId).toBe('sess-new');
    expect(secondJson.deduplicated).toBe(true);
    expect(secondJson.message).toContain('No new session was created');
    expect(secondJson.message).toContain('sess-new');
  });

  it('a DIFFERENT title is a different spawn (dedupe never starves legitimate follow-on work)', async () => {
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, id: 'sess-two', title: 'Second, different deliverable' });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { ...SPAWN_ARGS, title: 'Second, different deliverable' });
    expect(svc.startCodingSession).toHaveBeenCalledTimes(2);
    expect(JSON.parse(out).ids.sessionId).toBe('sess-two');
  });

  it('a DIFFERENT brief is a different spawn too', async () => {
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, id: 'sess-three' });
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', { ...SPAWN_ARGS, prompt: 'A completely different brief.' });
    expect(svc.startCodingSession).toHaveBeenCalledTimes(2);
  });

  it('a DIFFERENT calling chat never shares a claim', async () => {
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    mockChatFindUnique.mockResolvedValue({ id: 'caller-2', userId: 'u1' });
    const ctx2 = makeCtx({ agentSurface: 'coding', sessionId: 'caller-2' } as any);
    mockChatFindUnique.mockResolvedValue({ id: 'caller-2', userId: 'u1' });
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, id: 'sess-other-caller' });
    const out = await executePlatformTool(ctx2, 'start_coding_session', SPAWN_ARGS);
    expect(svc.startCodingSession).toHaveBeenCalledTimes(2);
    expect(JSON.parse(out).ids.sessionId).toBe('sess-other-caller');
  });

  it('DIGBY_SPAWN_DEDUPE_WINDOW_SEC=0 restores spawn-always', async () => {
    process.env.DIGBY_SPAWN_DEDUPE_WINDOW_SEC = '0';
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, id: 'sess-second' });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    expect(svc.startCodingSession).toHaveBeenCalledTimes(2);
    expect(JSON.parse(out).ids.sessionId).toBe('sess-second');
  });

  it('FAIL-OPEN: a claim-store error never blocks a legitimate spawn', async () => {
    // A store whose claim throws is exactly what a Redis outage looks like.
    registerSpawnClaimStore({
      ...createMemorySpawnClaimStore(),
      claim: async () => { throw new Error('redis down'); },
    });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    expect(JSON.parse(out).ids.sessionId).toBe('sess-new');
  });

  it('a spawn that FAILS releases its claim, so the caller\'s retry is not told "already in flight"', async () => {
    svc.startCodingSession.mockRejectedValueOnce(new Error('provisioning blew up'));
    await expect(executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS)).rejects.toThrow('provisioning blew up');
    // The claim is gone — a retry SPAWNS instead of being deduped against a dead attempt.
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, id: 'sess-retry' });
    const retry = JSON.parse(await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS));
    expect(retry.ids.sessionId).toBe('sess-retry');
    expect(retry.deduplicated).toBeUndefined();
  });

  it('an IN-FLIGHT identical claim (NX lost, lane id not minted yet) refuses to mint a second lane', async () => {
    // Simulate the concurrent twin: another process claimed the identity and has
    // not written its lane id yet. A second lane here IS the reported triple-fire.
    const { spawnDedupeKey, pendingClaimValue } = require('./spawn-dedupe');
    const key = spawnDedupeKey({
      callerChatId: 'caller-1', projectId: 'p1', goalId: null, todoId: null,
      title: SPAWN_ARGS.title, prompt: SPAWN_ARGS.prompt,
    });
    const store = createMemorySpawnClaimStore();
    await store.claim(key, pendingClaimValue(), 60);
    registerSpawnClaimStore(store);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS);
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(out).toContain('ALREADY IN FLIGHT');
    expect(out).toContain('Do NOT re-issue it');
  }, 20000);

  // ── adversarial review B3: a dead caller must not lock the chat out ─────────
  it('B3: an ABANDONED pending claim (past the grace window) is reclaimed and the spawn proceeds', async () => {
    const { spawnDedupeKey, SPAWN_DEDUPE_STALE_GRACE_MS } = require('./spawn-dedupe');
    const key = spawnDedupeKey({
      callerChatId: 'caller-1', projectId: 'p1', goalId: null, todoId: null,
      title: SPAWN_ARGS.title, prompt: SPAWN_ARGS.prompt,
    });
    const store = createMemorySpawnClaimStore();
    // A caller that claimed and then DIED (never wrote a lane id).
    await store.claim(key, `pending:${Date.now() - SPAWN_DEDUPE_STALE_GRACE_MS - 1000}`, 60);
    registerSpawnClaimStore(store);
    const out = JSON.parse(await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS));
    // Not locked out, and not a bogus "you already have a lane".
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    expect(out.ids.sessionId).toBe('sess-new');
    expect(out.deduplicated).toBeUndefined();
  }, 20000);

  // ── adversarial review B4: the fallback is real, and the mode is telemeted ──
  it('B4: with NO registered store, dedupe is honestly OFF (spawn-always, and the telemetry says so)', async () => {
    resetSpawnClaimStoreForTests(); // no shared store registered — the honest "off" state
    const first = JSON.parse(await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS));
    expect(first.ids.sessionId).toBe('sess-new');
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, id: 'sess-second' });
    const second = JSON.parse(await executePlatformTool(autoCodingCtx(), 'start_coding_session', SPAWN_ARGS));
    // No process-local stand-in pretends to dedupe: the spawn proceeds, exactly
    // as it always has. A local claim cannot see the cross-box twins the ticket
    // reports, so shipping one would only manufacture false confidence.
    expect(svc.startCodingSession).toHaveBeenCalledTimes(2);
    expect(second.deduplicated).toBeUndefined();
    expect(second.ids.sessionId).toBe('sess-second');
  }, 20000);

  it('B4: the registered store is what ARMS dedupe — the seam proves the real wiring, not a default', async () => {
    // Registering a store is the ONE thing that turns the guard on; the suite's
    // beforeEach does exactly that, so every other case above is the wiring
    // proof. Here we pin the seam itself: no store ⇒ off, store ⇒ on.
    expect(spawnClaimStoreIsShared()).toBe(true);
    resetSpawnClaimStoreForTests();
    expect(spawnClaimStoreIsShared()).toBe(false);
    expect(activeSpawnClaimStore()).toBeNull();
  });
});