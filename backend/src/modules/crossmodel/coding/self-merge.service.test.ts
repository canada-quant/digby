/**
 * Self-merge (owner directive 2026-09-09) — policy resolution, ask-once loop,
 * gate engine, forced-reflection retry semantics, learnings ring.
 *
 * DEPLOY-RISK pins:
 *  - crossmodel itself is ALWAYS policy 'on' (framework) — no setting, no
 *    inference, no question can turn it off;
 *  - GATE FLIP 2026-09-11 (owner: full steam): every other project is ON BY
 *    DEFAULT — only a HUMAN-set stored OFF (owner / answered) turns it off;
 *    the inference judge + ask-once card are GONE (deleted 2026-09-28 after
 *    zero post-flip use) — the resolver has no 'ask' outcome at all;
 *  - an already-merged PR is reported as such (alreadyMerged pass shape) —
 *    the tool layer never re-merges or re-claims it;
 *  - G5 containment is GONE: the gate engine never consults the ladder;
 *  - G3 verify_chain is OBSERVE-ONLY: a red / UNVERIFIED session chain is
 *    noted + metered and the merge proceeds; VERIFY_CHAIN_GATE_ENFORCE=1
 *    re-arms a refusal for a same-head CODE-red only;
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockUserMemoryFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockOwnerQuestionFindMany = jest.fn(async (..._a: any[]): Promise<any> => []);
const mockOwnerQuestionFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockProjectFindMany = jest.fn(async (..._a: any[]): Promise<any> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: { findUnique: (...a: any[]) => mockUserMemoryFindUnique(...a) },
    ownerQuestion: {
      findMany: (...a: any[]) => mockOwnerQuestionFindMany(...a),
      findFirst: (...a: any[]) => mockOwnerQuestionFindFirst(...a),
    },
    crossModelProject: { findMany: (...a: any[]) => mockProjectFindMany(...a) },
    // WAIT-ONCE (2026-09-27): the repo CI p50 reads merge_gate_failure / merge_success rows.
    loopMetric: { findMany: (...a: any[]) => mockLoopMetricFindMany(...a) },
  },
}));
const mockLoopMetricFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);

const mockGetMergedProjectStoreState = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../platform/folder-inheritance', () => ({
  __esModule: true,
  getMergedProjectStoreState: (...a: any[]) => mockGetMergedProjectStoreState(...a),
}));

const store = new Map<string, any>();
const storeKey = (ns: string[], key: string) => `${ns.join('|')}::${key}`;
const mockStoreGet = jest.fn(async (ns: string[], key: string): Promise<any> => store.get(storeKey(ns, key)) ?? null);
const mockStorePut = jest.fn(async (ns: string[], key: string, val: any) => { store.set(storeKey(ns, key), val); });
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => (mockStoreGet as any)(...a),
  storePut: (...a: any[]) => (mockStorePut as any)(...a),
}));

const mockUtilityChat = jest.fn(async (..._a: any[]): Promise<any> => '{"policy":"unclear","confidence":0,"why":"no signal"}');
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { GUARD_MISS: 'guard_miss', GUARD_STRIKE: 'guard_strike', MERGE_GATE_FAILURE: 'merge_gate_failure', MERGE_SUCCESS: 'merge_success' },
}));

const mockGetVerifyState = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('./verify-state', () => ({
  __esModule: true,
  getVerifyState: (...a: any[]) => mockGetVerifyState(...a),
}));

const mockFlagOwnerQuestion = jest.fn(async (..._a: any[]): Promise<any> => ({ kind: 'created' }));
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  flagOwnerQuestion: (...a: any[]) => mockFlagOwnerQuestion(...a),
}));

import {
  resolveSelfMergePolicy, ownRepoSlug, selfMergeDisabled, selfMergeMaxCycles,
  verifyChainGateEnforced,
  evaluateMergeGates, nothingChanged,
  readAttempt, writeAttempt, clearAttempt, recordMergeLearning, readMergeLearnings,
  deleteMergedHeadBranch, selfMergeKeepHeadBranch,
  classifyMergeWait, mergeWaitOnceMs, repoCiP50FromRows, repoCiP50Ms, selfMergeWaitOnceMaxMs,
  tryAcquireMergeWaitSlot, releaseMergeWaitSlot, mergeWaitSlotsInUse, mergeWaitMaxConcurrent,
  SELF_MERGE_WAIT_ONCE_MIN_MS, SELF_MERGE_WAIT_ONCE_MAX_MS, SELF_MERGE_WAIT_ONCE_DEFAULT_CI_P50_MS, SELF_MERGE_WAIT_ONCE_API_MS, MERGE_WAIT_MAX_CONCURRENT_DEFAULT,
  type GithubApi, type GateFailure, type GatePass,
} from './self-merge.service';
import logger from '../../../utils/logger';

// ── T2c (todo 9c89ab21): the batch-train gate's dependency. The gate
//    dynamically imports batch-train.service (redis-cached discovery); mock
//    it so gate behavior is tested hermetically, controllable per-test via
//    mockBatchTrains (and a throw via mockBatchTrainThrow, for the fail-open
//    pin). ──
const mockBatchTrains: { trains: any[] } = { trains: [] };
const mockBatchTrainThrow: { err: Error | null } = { err: null };
jest.mock('./batch-train.service', () => ({
  __esModule: true,
  getLiveBatchTrain: jest.fn(async () => {
    if (mockBatchTrainThrow.err) throw mockBatchTrainThrow.err;
    return mockBatchTrains.trains.find((t: any) => t.activity === 'boarding') ?? null;
  }),
  getActiveBatchTrains: jest.fn(async () => ({ trains: mockBatchTrains.trains })),
  readCachedBatchTrains: jest.fn(async () => mockBatchTrains.trains),
  appendBatchTrainNotice: jest.fn(async (p: string) => p),
  invalidateBatchTrainCache: jest.fn(async () => undefined),
  discoveryApiFromGithub: jest.fn(() => ({ listBatchRefs: async () => ({ data: [] }), compareWithMain: async () => ({ data: {} }) })),
}));

const ENV_KEYS = [
  'SELF_MERGE_DISABLED', 'SELF_MERGE_MAX_CYCLES', 'SELF_REPO',
  'VERIFY_CHAIN_GATE_ENFORCE', 'UNVERIFIED_GATE_DISABLED',
  'RESULTS_LOG_GUARD_ENFORCE', 'RESULTS_LOG_MAX_DELETED_LINES', 'RESULTS_LOG_GLOB',
  'SELF_MERGE_KEEP_HEAD_BRANCH',
  'SELF_MERGE_WAIT_ONCE_MAX_MS', 'MERGE_WAIT_MAX_CONCURRENT',
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  // mockResolvedValue REPLACES implementations permanently — re-prime defaults
  // every test so one test's override never leaks into the next.
  mockUserMemoryFindUnique.mockResolvedValue(null);
  mockOwnerQuestionFindMany.mockResolvedValue([]);
  mockOwnerQuestionFindFirst.mockResolvedValue(null);
  mockProjectFindMany.mockResolvedValue([]);
  mockGetMergedProjectStoreState.mockResolvedValue(null);
  mockUtilityChat.mockResolvedValue('{"policy":"unclear","confidence":0,"why":"no signal"}');
  mockGetVerifyState.mockResolvedValue(null);
  mockFlagOwnerQuestion.mockResolvedValue({ kind: 'created' });
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── helpers ──────────────────────────────────────────────────────────────────

function apiFor(routes: Record<string, any>): GithubApi {
  return {
    async get(url: string, accept?: string) {
      const isDiff = accept === 'application/vnd.github.diff';
      for (const [pattern, data] of Object.entries(routes)) {
        // diff requests ONLY match diff routes (and vice versa) — a diff URL
        // still contains "pulls/9", which must not hit the JSON PR route.
        if (isDiff !== pattern.startsWith('diff:')) continue;
        if (isDiff || url.includes(pattern)) return { status: 200, data: typeof data === 'function' ? data() : data };
      }
      throw new Error(`unrouted GET ${isDiff ? 'diff:' : ''}${url}`);
    },
    async put(url: string, _body: any) {
      for (const [pattern, data] of Object.entries(routes)) {
        if (`PUT:${url}`.includes(pattern)) return { status: 200, data: typeof data === 'function' ? data() : data };
      }
      return { status: 405, data: { message: 'unrouted PUT' } };
    },
  };
}

const OPEN_PR = { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean', head: { sha: 'a'.repeat(40) } };
const GREEN = {
  [`pulls/9`]: OPEN_PR,
  [`check-runs`]: { check_runs: [{ name: 'Backend tests', status: 'completed', conclusion: 'success' }] },
  [`/status`]: { state: 'success', statuses: [{ state: 'success' }] },
  [`diff:`]: '+++ b/file\n+const x = 1;\n',
};

// ── policy ───────────────────────────────────────────────────────────────────

describe('self-merge policy', () => {
  test('crossmodel itself is ALWAYS on (framework) — no setting or inference consulted', async () => {
    mockGetMergedProjectStoreState.mockResolvedValue({ selfMerge: 'off' }); // even a stored OFF cannot apply
    const p = await resolveSelfMergePolicy({ repo: ownRepoSlug(), projectId: 'proj1', userId: 'u1' });
    expect(p).toMatchObject({ policy: 'on', source: 'framework' });
    expect(mockGetMergedProjectStoreState).not.toHaveBeenCalled();
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  test('SELF_REPO env override changes the always-on repo', async () => {
    process.env.SELF_REPO = 'acme/edge-digby';
    const p = await resolveSelfMergePolicy({ repo: 'ACME/Edge-Digby', projectId: null, userId: 'u1' });
    expect(p.policy).toBe('on');
    expect(p.source).toBe('framework');
  });

  test('explicit project setting wins (on and off), with its stored source', async () => {
    mockGetMergedProjectStoreState.mockResolvedValue({ selfMerge: 'off', selfMergeSource: 'owner', selfMergeWhy: 'client repo' });
    const off = await resolveSelfMergePolicy({ repo: 'x/y', projectId: 'p1', userId: 'u1' });
    expect(off).toMatchObject({ policy: 'off', source: 'owner', why: 'client repo' });
    mockGetMergedProjectStoreState.mockResolvedValue({ selfMerge: 'on', selfMergeSource: 'answered' });
    const on = await resolveSelfMergePolicy({ repo: 'x/y', projectId: 'p1', userId: 'u1' });
    expect(on).toMatchObject({ policy: 'on', source: 'answered' });
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  // ── GATE FLIP 2026-09-11 (owner: full steam): DEFAULT ON ──────────────────

  test('DEFAULT: a project with no stored setting is ON (source framework) — no inference call, no card, nothing persisted', async () => {
    mockUserMemoryFindUnique.mockResolvedValue({ facts: { note: 'the user wants to approve merges' } });
    const p = await resolveSelfMergePolicy({ repo: 'canada-quant/tt-rd', projectId: 'p2', userId: 'u1' });
    expect(p).toMatchObject({ policy: 'on', source: 'framework' });
    expect(p.why).toMatch(/default-on/);
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockUserMemoryFindUnique).not.toHaveBeenCalled(); // the evidence bundle is never even gathered
    expect(mockFlagOwnerQuestion).not.toHaveBeenCalled();
    expect(store.has(storeKey(['p2', 'settings'], 'state'))).toBe(false);
  });

  test('DEFAULT: no projectId (external repo, no project) is ON too', async () => {
    const p = await resolveSelfMergePolicy({ repo: 'x/y', projectId: null, userId: 'u1' });
    expect(p.policy).toBe('on');
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  test('DEFAULT: a stored INFERRED off is IGNORED — resolves ON (2026-09-09 inversion incident: coerced clicks read as preference locked three lanes out)', async () => {
    mockGetMergedProjectStoreState.mockResolvedValue({ selfMerge: 'off', selfMergeSource: 'inferred', selfMergeWhy: 'user clicked Approve repeatedly' });
    const p = await resolveSelfMergePolicy({ repo: 'canada-quant/tt-rd', projectId: 'p9', userId: 'u1' });
    expect(p.policy).toBe('on');
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  test('DEFAULT: a HUMAN-set stored OFF (owner / answered) is still honored — the only thing that turns self-merge off', async () => {
    mockGetMergedProjectStoreState.mockResolvedValue({ selfMerge: 'off', selfMergeSource: 'answered', selfMergeWhy: 'owner answered the self-merge question' });
    const p = await resolveSelfMergePolicy({ repo: 'x/y', projectId: 'p7', userId: 'u1' });
    expect(p).toMatchObject({ policy: 'off', source: 'answered' });
  });

  test("the policy never resolves to 'ask' — the union has no such member and no stored settings shape reaches a card", async () => {
    for (const settings of [null, {}, { selfMerge: 'off', selfMergeSource: 'inferred' }]) {
      mockGetMergedProjectStoreState.mockResolvedValue(settings);
      const p = await resolveSelfMergePolicy({ repo: 'x/y', projectId: 'p6', userId: 'u1' });
      expect(p.policy).not.toBe('ask');
    }
  });

});

// ── WAIT-ONCE helpers (agent-decisions prerequisite 4, 2026-09-27) ───────────

describe('self-merge WAIT-ONCE helpers (pure + the bounded p50 read)', () => {
  afterEach(() => { while (mergeWaitSlotsInUse() > 0) releaseMergeWaitSlot(); });

  test('classifyMergeWait: ci_pending from the failure; 405 "in progress" / "base branch was modified" and any 5xx from the API; everything else null', () => {
    expect(classifyMergeWait({ failure: { transient: 'ci_pending' } })).toBe('ci_pending');
    expect(classifyMergeWait({ failure: {} })).toBeNull();
    expect(classifyMergeWait({ failure: null, apiStatus: 405, apiMessage: 'Merge already in progress' })).toBe('merge_in_progress');
    expect(classifyMergeWait({ apiStatus: 405, apiMessage: 'Base branch was modified. Review and try the merge again.' })).toBe('merge_in_progress');
    expect(classifyMergeWait({ apiStatus: 405, apiMessage: 'Pull Request is not mergeable' })).toBeNull(); // a real work item
    expect(classifyMergeWait({ apiStatus: 502 })).toBe('server_5xx');
    expect(classifyMergeWait({ apiStatus: 500, apiMessage: 'Server Error' })).toBe('server_5xx');
    expect(classifyMergeWait({ apiStatus: 422 })).toBeNull();
    expect(classifyMergeWait({ apiStatus: 200 })).toBeNull();
    expect(classifyMergeWait({})).toBeNull();
  });

  test('mergeWaitOnceMs: ci_pending = clamp(2 × p50, 30 s, 10 min) with a 3-min default p50; the API classes take the fixed 45 s slice; SELF_MERGE_WAIT_ONCE_MAX_MS caps everything (≤ 10 min)', () => {
    expect(SELF_MERGE_WAIT_ONCE_MAX_MS).toBe(600_000);
    expect(SELF_MERGE_WAIT_ONCE_MIN_MS).toBe(30_000);
    expect(SELF_MERGE_WAIT_ONCE_DEFAULT_CI_P50_MS).toBe(180_000);
    expect(SELF_MERGE_WAIT_ONCE_API_MS).toBe(45_000);
    expect(mergeWaitOnceMs(null, 'ci_pending')).toBe(360_000);          // 2 × default
    expect(mergeWaitOnceMs(120_000, 'ci_pending')).toBe(240_000);       // 2 × p50
    expect(mergeWaitOnceMs(5_000, 'ci_pending')).toBe(30_000);          // floor
    expect(mergeWaitOnceMs(20 * 60_000, 'ci_pending')).toBe(600_000);   // cap
    expect(mergeWaitOnceMs(-1, 'ci_pending')).toBe(360_000);            // garbage p50 → default
    expect(mergeWaitOnceMs(120_000, 'merge_in_progress')).toBe(45_000);
    expect(mergeWaitOnceMs(null, 'server_5xx')).toBe(45_000);
    process.env.SELF_MERGE_WAIT_ONCE_MAX_MS = '5';
    expect(selfMergeWaitOnceMaxMs()).toBe(5);
    expect(mergeWaitOnceMs(120_000, 'ci_pending')).toBe(5);
    expect(mergeWaitOnceMs(null, 'server_5xx')).toBe(5);
    process.env.SELF_MERGE_WAIT_ONCE_MAX_MS = String(60 * 60_000); // never above the 10-min ceiling
    expect(selfMergeWaitOnceMaxMs()).toBe(600_000);
  });

  test('repoCiP50FromRows: the median of the (first ci failure → merge_success) delta per PR; PRs without both sides and non-ci gates are ignored; under 3 samples → null', () => {
    const t = (min: number) => new Date(Date.UTC(2026, 8, 27, 0, min));
    const rows = [
      { kind: 'merge_gate_failure', createdAt: t(0), meta: { gate: 'ci', pullNumber: 1 } },
      { kind: 'merge_gate_failure', createdAt: t(3), meta: { gate: 'ci', pullNumber: 1 } }, // a later cycle — the FIRST failure anchors
      { kind: 'merge_success', createdAt: t(6), meta: { pullNumber: 1 } },                    // 6 min
      { kind: 'merge_gate_failure', createdAt: t(10), meta: { gate: 'ci', pullNumber: 2 } },
      { kind: 'merge_success', createdAt: t(12), meta: { pullNumber: 2 } },                   // 2 min
      { kind: 'merge_gate_failure', createdAt: t(20), meta: { gate: 'ci', pullNumber: 3 } },
      { kind: 'merge_success', createdAt: t(40), meta: { pullNumber: 3 } },                   // 20 min
      { kind: 'merge_gate_failure', createdAt: t(50), meta: { gate: 'pr_state', pullNumber: 4 } }, // not a ci gate
      { kind: 'merge_success', createdAt: t(51), meta: { pullNumber: 4 } },
      { kind: 'merge_gate_failure', createdAt: t(60), meta: { gate: 'ci', pullNumber: 5 } },       // never merged
      { kind: 'merge_success', createdAt: t(61), meta: { pr: 6 } },                                 // no failure
    ];
    expect(repoCiP50FromRows(rows)).toBe(6 * 60_000);
    expect(repoCiP50FromRows(rows.slice(0, 5))).toBeNull(); // 2 samples < 3
    expect(repoCiP50FromRows(rows.slice(0, 5), 2)).toBe(4 * 60_000); // even count → mean of the middle two
    expect(repoCiP50FromRows([])).toBeNull();
  });

  test('repoCiP50Ms: a bounded 30-day read scoped to the repo; any read error → null (default applies)', async () => {
    const t = (min: number) => new Date(Date.UTC(2026, 8, 27, 0, min));
    mockLoopMetricFindMany.mockResolvedValueOnce([
      { kind: 'merge_gate_failure', createdAt: t(0), meta: { gate: 'ci', pullNumber: 1 } }, { kind: 'merge_success', createdAt: t(4), meta: { pullNumber: 1 } },
      { kind: 'merge_gate_failure', createdAt: t(0), meta: { gate: 'ci', pullNumber: 2 } }, { kind: 'merge_success', createdAt: t(5), meta: { pullNumber: 2 } },
      { kind: 'merge_gate_failure', createdAt: t(0), meta: { gate: 'ci', pullNumber: 3 } }, { kind: 'merge_success', createdAt: t(6), meta: { pullNumber: 3 } },
    ]);
    expect(await repoCiP50Ms('o/r')).toBe(5 * 60_000);
    const [arg] = mockLoopMetricFindMany.mock.calls[0];
    expect(arg.where.kind).toEqual({ in: ['merge_gate_failure', 'merge_success'] });
    expect(arg.where.meta).toEqual({ path: ['repo'], equals: 'o/r' });
    expect(arg.take).toBe(400);
    mockLoopMetricFindMany.mockRejectedValueOnce(new Error('db down'));
    expect(await repoCiP50Ms('o/r')).toBeNull();
  });

  test('the concurrent-wait slots cap at MERGE_WAIT_MAX_CONCURRENT (default 4) and release never goes negative', () => {
    expect(MERGE_WAIT_MAX_CONCURRENT_DEFAULT).toBe(4);
    expect(mergeWaitMaxConcurrent()).toBe(4);
    process.env.MERGE_WAIT_MAX_CONCURRENT = '2';
    expect(tryAcquireMergeWaitSlot()).toBe(true);
    expect(tryAcquireMergeWaitSlot()).toBe(true);
    expect(tryAcquireMergeWaitSlot()).toBe(false);
    expect(mergeWaitSlotsInUse()).toBe(2);
    releaseMergeWaitSlot(); releaseMergeWaitSlot(); releaseMergeWaitSlot();
    expect(mergeWaitSlotsInUse()).toBe(0);
    process.env.MERGE_WAIT_MAX_CONCURRENT = '0';
    expect(tryAcquireMergeWaitSlot()).toBe(false);
  });
});

// ── gate engine ──────────────────────────────────────────────────────────────

describe('evaluateMergeGates', () => {
  const base = { owner: 'o', repo: 'r', pullNumber: 9, sessionId: 's1' };

  test('all green passes with per-gate evidence notes', async () => {
    const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
    expect(v.ok).toBe(true);
    const pass = v as GatePass;
    expect(pass.headSha).toBe('a'.repeat(40));
    expect(pass.evidenceNotes.join('\n')).toMatch(/ci: green/);
    expect(pass.evidenceNotes.join('\n')).toMatch(/secret_scan: clean/);
  });

  test('WAIT-ONCE (2026-09-27): a PENDING ci verdict carries headSha + transient ci_pending; a RED one carries headSha and NO transient; a closed / dirty PR carries the head it read', async () => {
    const pending = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [{ name: 'Backend tests', status: 'in_progress', conclusion: null }] } }) }) as GateFailure;
    expect(pending.ok).toBe(false);
    expect(pending.gate).toBe('ci');
    expect(pending.cause).toMatch(/still running/);
    expect(pending).toMatchObject({ headSha: 'a'.repeat(40), transient: 'ci_pending' });
    const red = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [{ name: 'Backend tests', status: 'completed', conclusion: 'failure' }] } }) }) as GateFailure;
    expect(red.gate).toBe('ci');
    expect(red.headSha).toBe('a'.repeat(40));
    expect(red.transient).toBeUndefined();
    const closed = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, [`pulls/9`]: { ...OPEN_PR, state: 'closed' } }) }) as GateFailure;
    expect(closed).toMatchObject({ gate: 'pr_state', headSha: 'a'.repeat(40) });
    expect(closed.transient).toBeUndefined();
    const dirty = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, [`pulls/9`]: { ...OPEN_PR, mergeable: false, mergeable_state: 'dirty' } }) }) as GateFailure;
    expect(dirty).toMatchObject({ gate: 'pr_state', headSha: 'a'.repeat(40) });
    // An unreadable PR has no head to stamp.
    const unreadable = await evaluateMergeGates({ ...base, api: { get: async () => { throw new Error('boom'); }, put: async () => ({ status: 500, data: {} }) } }) as GateFailure;
    expect(unreadable.gate).toBe('pr_state');
    expect(unreadable.headSha).toBeUndefined();
  });

  // ── G1 'behind' → update-branch (MERGE-INTENT-AWAIT, 2026-10-20) ──────────
  // A mergeable PR merely BEHIND its base is no longer handed back as a manual
  // rebase: the harness asks GitHub to update the branch (pinned to the head it
  // read) and answers a TIMING failure the tool queues as a merge intent.
  describe('G1 behind → update-branch', () => {
    const BEHIND = { ...OPEN_PR, mergeable: true, mergeable_state: 'behind' };
    const UPDATE_URL = 'https://api.github.com/repos/o/r/pulls/9/update-branch';
    /** apiFor + a recorded PUT; `putAnswer` overrides the update-branch answer (apiFor's PUT matches any route substring). */
    const tracked = (routes: Record<string, any>, putAnswer?: { status: number; data: any }) => {
      const api = apiFor(routes);
      const puts: Array<{ url: string; body: any }> = [];
      const put = api.put.bind(api);
      api.put = async (url: string, body: any) => { puts.push({ url, body }); return putAnswer ?? put(url, body); };
      return { api, puts };
    };
    afterEach(() => { delete process.env.SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED; });

    test('a BEHIND, mergeable PR ⇒ update-branch pinned to the head, answered as transient ci_pending with branchUpdatedFrom', async () => {
      const { api, puts } = tracked({ ...GREEN, [`pulls/9`]: BEHIND, [`PUT:${UPDATE_URL}`]: { message: 'Updating pull request branch.' } });
      const v = await evaluateMergeGates({ ...base, api }) as GateFailure;
      expect(v.ok).toBe(false);
      expect(v).toMatchObject({ gate: 'pr_state', transient: 'ci_pending', headSha: 'a'.repeat(40), branchUpdatedFrom: 'a'.repeat(40) });
      expect(v.cause).toMatch(/BEHIND its base — the harness asked GitHub to merge the base into it/);
      expect(puts).toEqual([{ url: UPDATE_URL, body: { expected_head_sha: 'a'.repeat(40) } }]);
    });

    test('a refused update-branch falls through to the not-mergeable refusal with GitHub\'s answer (never transient)', async () => {
      const { api, puts } = tracked({ ...GREEN, [`pulls/9`]: BEHIND }, { status: 422, data: { message: 'merge conflict between base and head' } });
      const v = await evaluateMergeGates({ ...base, api }) as GateFailure;
      expect(v).toMatchObject({ gate: 'pr_state' });
      expect(v.transient).toBeUndefined();
      expect(v.branchUpdatedFrom).toBeUndefined();
      expect(v.cause).toContain("update-branch was refused (422: merge conflict between base and head)");
      expect(puts).toHaveLength(1);
    });

    test('r3 interactions fix: allowUpdateBranch:false (the merge-intents cron has not cleared the head) ⇒ NO update-branch write, a TIMING pr_state wait; the switch still restores the refusal', async () => {
      const { api, puts } = tracked({ ...GREEN, [`pulls/9`]: BEHIND, [`PUT:${UPDATE_URL}`]: { message: 'ok' } });
      const v = await evaluateMergeGates({ ...base, api, allowUpdateBranch: false }) as GateFailure;
      expect(v).toMatchObject({ gate: 'pr_state', transient: 'ci_pending', headSha: 'a'.repeat(40) });
      expect(v.branchUpdatedFrom).toBeUndefined();
      expect(v.cause).toMatch(/update-branch is held/);
      expect(puts).toHaveLength(0);
      process.env.SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED = '1';
      const off = await evaluateMergeGates({ ...base, api, allowUpdateBranch: false }) as GateFailure;
      expect(off).toMatchObject({ gate: 'pr_state', cause: 'PR not mergeable (mergeable=true, state=behind)' });
      expect(off.transient).toBeUndefined();
    });

    test('SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED=1 restores the refusal (no write); a dirty PR is never updated', async () => {
      process.env.SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED = '1';
      let t = tracked({ ...GREEN, [`pulls/9`]: BEHIND, [`PUT:${UPDATE_URL}`]: { message: 'ok' } });
      let v = await evaluateMergeGates({ ...base, api: t.api }) as GateFailure;
      expect(v).toMatchObject({ gate: 'pr_state', cause: 'PR not mergeable (mergeable=true, state=behind)' });
      expect(t.puts).toHaveLength(0);
      delete process.env.SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED;
      t = tracked({ ...GREEN, [`pulls/9`]: { ...OPEN_PR, mergeable: false, mergeable_state: 'dirty' }, [`PUT:${UPDATE_URL}`]: { message: 'ok' } });
      v = await evaluateMergeGates({ ...base, api: t.api }) as GateFailure;
      expect(v.gate).toBe('pr_state');
      expect(t.puts).toHaveLength(0);
    });
  });

  // ── G4.5 batch_train (T2c, todo 9c89ab21) ─────────────────────────────────
  // The pinned contract: while a train is BOARDING, a CODE PR into the default
  // branch is refused with a boarding suggestedFix; a docs-only/state-only PR
  // into the default branch PASSES (the carve-out); a code PR onto the BATCH
  // branch passes (base ≠ default); and BOTH flaky dependencies (discovery
  // error, unreadable diff) fail OPEN — the 2026-10-17 P0 class is a gate
  // that holds the whole fleet on a flaky dependency.
  const TRAIN = { branch: 'batch/20261017T020000Z', sha: 'cd'.repeat(20), activity: 'boarding', cutAt: '2026-10-17T02:00:00Z', determinedBy: 'compare:ahead', checkedAt: new Date().toISOString() };
  const CODE_DIFF = 'diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n+const y = 2;\n';
  const DOCS_DIFF = 'diff --git a/docs/a.md b/docs/a.md\n--- a/docs/a.md\n+++ b/docs/a.md\n+doc line\n';

  beforeEach(() => {
    mockBatchTrains.trains = [];
    mockBatchTrainThrow.err = null;
  });

  test('no live train: a code merge into main passes (gate notes the read)', async () => {
    mockBatchTrains.trains = [{ ...TRAIN, activity: 'landed' }];
    const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, 'diff:': CODE_DIFF }) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/batch_train: no live train/);
  });

  test('live train + code PR into main = REFUSED with boarding suggestedFix (the T2c pin)', async () => {
    mockBatchTrains.trains = [TRAIN];
    const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, 'diff:': CODE_DIFF }) }) as GateFailure;
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('batch_train');
    expect(v.cause).toContain('batch/20261017T020000Z');
    expect(v.cause).toContain('BOARDING');
    expect(v.suggestedFix).toContain('gh pr edit 9 --base batch/20261017T020000Z');
    expect(v.suggestedFix).toContain('docs-only PRs');
    expect(v.headSha).toBe('a'.repeat(40));
    expect(v.transient).toBeUndefined(); // never waited out — boarding is not timing
  });

  test('live train + DOCS-ONLY PR into main = PASSES (the carve-out, verbatim from the todo)', async () => {
    mockBatchTrains.trains = [TRAIN];
    const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, 'diff:': DOCS_DIFF }) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/carve-out applies/);
  });

  test('live train + PR based on the BATCH branch = passes (base ≠ default)', async () => {
    mockBatchTrains.trains = [TRAIN];
    const onBatch = { ...OPEN_PR, base: { ref: 'batch/20261017T020000Z', repo: { default_branch: 'main' } } };
    const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, 'pulls/9': onBatch, 'diff:': CODE_DIFF }) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/targets batch/);
  });

  test('discovery error = FAIL-OPEN (the 2026-10-17 P0 class: a flaky dependency never holds the fleet)', async () => {
    mockBatchTrainThrow.err = new Error('api down');
    const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, 'diff:': CODE_DIFF }) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/batch_train: discovery error \(fail-open\)/);
  });

  test('unreadable diff under a live train = FAIL-OPEN (the runbook re-boards; a held fleet is worse)', async () => {
    mockBatchTrains.trains = [TRAIN];
    const diffless = apiFor({ ...GREEN });
    (diffless as any).get = async (url: string, accept?: string) => {
      if (accept === 'application/vnd.github.diff') throw new Error('diff 502');
      return apiFor(GREEN).get(url, accept);
    };
    const v = await evaluateMergeGates({ ...base, api: diffless });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/fail-open/);
  });

  test('BATCH_TRAIN_GATE_DISABLED=1 turns the whole mechanism off', async () => {
    process.env.BATCH_TRAIN_GATE_DISABLED = '1';
    try {
      mockBatchTrains.trains = [TRAIN];
      const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, 'diff:': CODE_DIFF }) });
      expect(v.ok).toBe(true);
    } finally {
      delete process.env.BATCH_TRAIN_GATE_DISABLED;
    }
  });

  test('GATE FLIP 2026-09-11: G5 containment is GONE — the gate engine never consults the ladder and the receipt carries no containment line', async () => {
    const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
    expect(v.ok).toBe(true);
    const notes = (v as GatePass).evidenceNotes.join('\n');
    expect(notes).not.toMatch(/containment/i);
    // The gate name no longer exists on the failure union either (compile-time
    // pin via the runtime shape of every failure this suite produces).
    const closed = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, [`pulls/9`]: { ...OPEN_PR, state: 'closed' } }) });
    expect((closed as GateFailure).gate).not.toBe('containment');
  });

  test('a closed PR fails pr_state with a reopen fix', async () => {
    const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, [`pulls/9`]: { ...OPEN_PR, state: 'closed' } }) });
    expect((v as GateFailure).gate).toBe('pr_state');
    expect((v as GateFailure).cause).toMatch(/closed/);
  });

  test('a dirty/unmergeable PR fails pr_state with a rebase fix', async () => {
    const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, [`pulls/9`]: { ...OPEN_PR, mergeable: false, mergeable_state: 'dirty' } }) });
    expect((v as GateFailure).gate).toBe('pr_state');
    expect((v as GateFailure).suggestedFix).toMatch(/rebase|update/i);
  });

  test('an ALREADY-merged PR passes with alreadyMerged (never a failure, never a re-merge)', async () => {
    const v = await evaluateMergeGates({ ...base, api: apiFor({ ...GREEN, [`pulls/9`]: { ...OPEN_PR, merged: true, merge_commit_sha: 'b'.repeat(40) } }) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).alreadyMerged).toBe(true);
  });

  test('RED CI fails the ci gate naming the failing checks', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [{ name: 'Backend tests', status: 'completed', conclusion: 'failure', html_url: 'https://x/1' }] } }),
    });
    const f = v as GateFailure;
    expect(f.gate).toBe('ci');
    expect(f.cause).toMatch(/RED/);
    expect(f.evidence).toContain('Backend tests');
  });

  test('PENDING CI fails the ci gate with a wait fix (distinct cause from red)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [{ name: 'Backend tests', status: 'in_progress', conclusion: null }] } }),
    });
    const f = v as GateFailure;
    expect(f.gate).toBe('ci');
    expect(f.cause).toMatch(/still running/);
    expect(f.suggestedFix).toMatch(/wait/i);
  });

  test('NO CI at all (docs repo) passes the ci gate as no_ci — recorded, not blocked', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [] }, [`/status`]: { state: 'pending', statuses: [] }, [`contents/.github/workflows`]: [] }),
    });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/ci: no_ci/);
  });

  // fb707538 (2026-10-06): zero check-runs in a repo WITH workflows is a CI
  // DISPATCH GAP (Contents/PR REST lands create no push event → the
  // push-triggered CI never ran), not "no CI". The gate must refuse as
  // transient so the merge retries after the coverage watchdog backfills CI.
  // NOTE on route order: apiFor matches `url.includes(pattern)` in insertion
  // order, and the directory URL `…/workflows?ref=` is a PREFIX-substring of
  // the file URL `…/workflows/ci.yml?ref=` — the file-content routes must be
  // listed BEFORE the directory route or the directory pattern swallows them.
  test('fb707538: zero check-runs in a repo WITH CI workflows REFUSES as a dispatch gap (transient ci_pending), never no_ci', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [] }, [`/status`]: { state: 'pending', statuses: [] },
        [`contents/.github/workflows/ci.yml`]: 'on:\n  pull_request:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n',
        [`contents/.github/workflows`]: [{ path: '.github/workflows/ci.yml' }] }),
    });
    const f = v as GateFailure;
    expect(f.ok).toBe(false);
    expect(f.gate).toBe('ci');
    expect(f.cause).toMatch(/dispatch gap/);
    expect(f.transient).toBe('ci_pending');
    // MERGE-INTENT-AWAIT review fix: marked so a merge intent never QUEUES it
    // (WAIT-ONCE still waits it out once via `transient`).
    expect(f.dispatchGap).toBe(true);
    expect(f.suggestedFix).toMatch(/do not count on a 15-min rescue|BEST-EFFORT/i);
  });

  test('fb707538 (review N4): a repo whose only workflow is SCHEDULED-ONLY keeps the docs-repo no_ci pass — zero check-runs there is genuinely no CI', async () => {
    // A scheduled-only workflow never runs on a PR head, so zero check-runs
    // on the head is not a dispatch gap: refusing would wedge every merge in
    // such a repo behind a wait that can never resolve.
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [] }, [`/status`]: { state: 'pending', statuses: [] },
        [`contents/.github/workflows/nightly.yml`]: 'on:\n  schedule:\n    - cron: \'0 3 * * *\'\njobs:\n  nightly:\n    runs-on: ubuntu-latest\n',
        [`contents/.github/workflows`]: [{ path: '.github/workflows/nightly.yml' }] }),
    });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/ci: no_ci/);
  });

  test('fb707538 (review N4): an unreadable workflow BODY (raw-content GET throws) is skipped — a second workflow carrying the triggers still refuses', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [] }, [`/status`]: { state: 'pending', statuses: [] },
        [`contents/.github/workflows/ci.yml`]: 'on:\n  pull_request:\n',
        [`contents/.github/workflows`]: [{ path: '.github/workflows/broken.yml' }, { path: '.github/workflows/ci.yml' }] }),
    });
    const f = v as GateFailure;
    expect(f.ok).toBe(false);
    expect(f.cause).toMatch(/dispatch gap/);
  });

  test('fb707538: an UNREADABLE workflows dir keeps the docs-repo no_ci pass (fail-open only for the repo-shape probe, never the CI verdict)', async () => {
    // contents/.github/workflows unrouted → the workflows GET throws inside the gate → hasWorkflows=false → no_ci pass.
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN, [`check-runs`]: { check_runs: [] }, [`/status`]: { state: 'pending', statuses: [] } }),
    });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/ci: no_ci/);
  });

  // ── G3 verify_chain — OBSERVE-ONLY (gate flip 2026-09-11, owner: full steam) ──

  test('G3 DEFAULT: a RED session verify chain is NOTED + metered (guard_miss seam self_merge_verify_chain) and the merge PROCEEDS', async () => {
    expect(verifyChainGateEnforced()).toBe(false);
    mockGetVerifyState.mockResolvedValue({ passed: false, failedStage: 'jest', sha: 'a'.repeat(40) });
    const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
    expect(v.ok).toBe(true);
    const notes = (v as GatePass).evidenceNotes.join('\n');
    expect(notes).toMatch(/verify_chain: RED \(code failedStage=jest\)/);
    expect(notes).toMatch(/noted, not blocking/);
    expect(notes).toMatch(/VERIFY_CHAIN_GATE_ENFORCE=1/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'guard_miss',
      sessionId: 's1',
      meta: expect.objectContaining({ seam: 'self_merge_verify_chain', outcome: 'observed', passed: false, environmental: false, unverified: false, failedStage: 'jest', sameHead: true, enforced: false }),
    }));
  });

  test('G3 DEFAULT: an ENVIRONMENTAL red (OOM 137 — the #647 12.5h hold) is labelled environmental in the note and never blocks', async () => {
    mockGetVerifyState.mockResolvedValue({ passed: false, failedStage: 'typecheck', environmental: true });
    const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/verify_chain: RED \(environmental failedStage=typecheck\)/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ seam: 'self_merge_verify_chain', environmental: true }),
    }));
  });

  test('G3 DEFAULT: an UNVERIFIED pass (stages skipped — tool not installed) is a note, never a refusal; the legacy UNVERIFIED_GATE_DISABLED switch is irrelevant', async () => {
    mockGetVerifyState.mockResolvedValue({ passed: true, unverified: true });
    const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/verify_chain: passed UNVERIFIED \(stages skipped/);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ seam: 'self_merge_verify_chain', unverified: true, passed: true }),
    }));
  });

  test('G3: a clean pass records NO metric; an absent state is n/a', async () => {
    mockGetVerifyState.mockResolvedValue({ passed: true });
    const pass = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
    expect((pass as GatePass).evidenceNotes.join('\n')).toMatch(/verify_chain: passed$/m);
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    mockGetVerifyState.mockResolvedValue(null);
    const na = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
    expect(na.ok).toBe(true);
    expect((na as GatePass).evidenceNotes.join('\n')).toMatch(/verify_chain: n\/a/);
  });

  describe('G3 OPT-IN VERIFY_CHAIN_GATE_ENFORCE=1', () => {
    beforeEach(() => { process.env.VERIFY_CHAIN_GATE_ENFORCE = '1'; });

    test('a same-head CODE-red refuses with gate verify_chain (and the metric is stamped enforced:true)', async () => {
      expect(verifyChainGateEnforced()).toBe(true);
      mockGetVerifyState.mockResolvedValue({ passed: false, failedStage: 'jest', sha: 'a'.repeat(40) });
      const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
      expect(v.ok).toBe(false);
      expect((v as GateFailure).gate).toBe('verify_chain');
      expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
        meta: expect.objectContaining({ seam: 'self_merge_verify_chain', enforced: true }),
      }));
    });

    test('a red with NO recorded sha still refuses (legacy state shape — cannot prove it is another head)', async () => {
      mockGetVerifyState.mockResolvedValue({ passed: false, failedStage: 'lint' });
      const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
      expect((v as GateFailure).gate).toBe('verify_chain');
    });

    test('an ENVIRONMENTAL red never refuses even when enforced', async () => {
      mockGetVerifyState.mockResolvedValue({ passed: false, failedStage: 'typecheck', environmental: true, sha: 'a'.repeat(40) });
      const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
      expect(v.ok).toBe(true);
    });

    test('a red recorded on a DIFFERENT head (the lane’s other worktree) never refuses even when enforced', async () => {
      mockGetVerifyState.mockResolvedValue({ passed: false, failedStage: 'jest', sha: 'c'.repeat(40) });
      const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
      expect(v.ok).toBe(true);
      expect((v as GatePass).evidenceNotes.join('\n')).toMatch(/recorded on a different head/);
    });

    test('UNVERIFIED never refuses even when enforced — CI on the PR is the verification of record', async () => {
      mockGetVerifyState.mockResolvedValue({ passed: true, unverified: true });
      const v = await evaluateMergeGates({ ...base, api: apiFor(GREEN) });
      expect(v.ok).toBe(true);
    });
  });

  test('a credential-shaped ADDED line fails secret_scan (secrets cannot be retried through)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN, [`diff:`]: '+++ b/x\n+const k = "sk-proj-Abcdefghijklmnopqrstuvwxyz0123456789ABCDEFTt";\n' }),
    });
    const f = v as GateFailure;
    expect(f.gate).toBe('secret_scan');
    expect(f.suggestedFix).toMatch(/rotate|remove/i);
  });
});

// ── forced reflection (attempt records) ──────────────────────────────────────

describe('nothingChanged + attempt records', () => {
  test('first attempt is never "nothing changed"', () => {
    expect(nothingChanged({}, 'a'.repeat(40), { gate: 'ci', evidenceHash: 'h1' })).toBe(false);
  });

  test('same gate + same evidence + same head = nothing changed', () => {
    const prev = { lastGate: 'ci' as const, lastEvidenceHash: 'h1', lastHeadSha: 'a'.repeat(40) };
    expect(nothingChanged(prev, 'a'.repeat(40), { gate: 'ci', evidenceHash: 'h1' })).toBe(true);
    expect(nothingChanged(prev, null, { gate: 'ci', evidenceHash: 'h1' })).toBe(true);
  });

  test('a new head sha OR changed evidence admits the retry', () => {
    const prev = { lastGate: 'ci' as const, lastEvidenceHash: 'h1', lastHeadSha: 'a'.repeat(40) };
    expect(nothingChanged(prev, 'b'.repeat(40), { gate: 'ci', evidenceHash: 'h1' })).toBe(false);
    expect(nothingChanged(prev, 'a'.repeat(40), { gate: 'ci', evidenceHash: 'h2' })).toBe(false);
    expect(nothingChanged(prev, 'a'.repeat(40), { gate: 'pr_state', evidenceHash: 'h1' })).toBe(false);
  });

  test('attempt records round-trip through the context store and clear', async () => {
    await writeAttempt('c1', 'o/r', 9, { lastGate: 'ci', lastEvidenceHash: 'h1', cycles: 2 });
    expect(await readAttempt('c1', 'o/r', 9)).toMatchObject({ lastGate: 'ci', cycles: 2 });
    await clearAttempt('c1', 'o/r', 9);
    expect(await readAttempt('c1', 'o/r', 9)).toEqual({});
  });

  test('selfMergeMaxCycles defaults to 5 and honors the env override', () => {
    expect(selfMergeMaxCycles()).toBe(5);
    process.env.SELF_MERGE_MAX_CYCLES = '3';
    expect(selfMergeMaxCycles()).toBe(3);
  });
});

// ── learnings ring ───────────────────────────────────────────────────────────

describe('merge learnings ring', () => {
  test('appends stamped lines, caps at 40, survives reads; null project is a no-op', async () => {
    await recordMergeLearning(null, 'ignored');
    for (let i = 0; i < 45; i++) await recordMergeLearning('p1', `line ${i}`);
    const lines = await readMergeLearnings('p1');
    expect(lines.length).toBe(40);
    expect(lines[39]).toContain('line 44');
    expect(lines[0]).toContain('line 5');
  });
});

// ── kill switch ──────────────────────────────────────────────────────────────

describe('kill switch', () => {
  test('SELF_MERGE_DISABLED flips selfMergeDisabled()', () => {
    expect(selfMergeDisabled()).toBe(false);
    process.env.SELF_MERGE_DISABLED = '1';
    expect(selfMergeDisabled()).toBe(true);
  });
});

// ── post-merge head-branch cleanup (owner 2026-09-14) ────────────────────────

describe('deleteMergedHeadBranch', () => {
  /** A same-repo PR whose head is a lane branch — the deletable shape. */
  const MERGED_PR = {
    merged: true,
    head: { ref: 'digby/session-abc', repo: { full_name: 'o/r' } },
    base: { ref: 'main', repo: { full_name: 'o/r', default_branch: 'main' } },
  };
  const deleteApi = (status = 204) => {
    const calls: string[] = [];
    const api: GithubApi = {
      async get() { throw new Error('unused'); },
      async put() { throw new Error('unused'); },
      async delete(url: string) { calls.push(url); return { status, data: status >= 400 ? { message: 'nope' } : {} }; },
    };
    return { api, calls };
  };

  test('deletes refs/heads/<head.ref> (segment-encoded) for a same-repo, non-default head → outcome deleted', async () => {
    const { api, calls } = deleteApi(204);
    const r = await deleteMergedHeadBranch({ api, owner: 'o', repo: 'r', pr: MERGED_PR });
    expect(r).toEqual({ outcome: 'deleted', branch: 'digby/session-abc' });
    expect(calls).toEqual(['https://api.github.com/repos/o/r/git/refs/heads/digby/session-abc']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('404 / 422 = the repo already deleted it (delete_branch_on_merge) → already_gone, no warn', async () => {
    for (const status of [404, 422]) {
      const { api } = deleteApi(status);
      const r = await deleteMergedHeadBranch({ api, owner: 'o', repo: 'r', pr: MERGED_PR });
      expect(r).toEqual({ outcome: 'already_gone', branch: 'digby/session-abc' });
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('any other status, or a thrown request, is ONE warn + outcome failed — never a throw', async () => {
    const { api } = deleteApi(500);
    const r = await deleteMergedHeadBranch({ api, owner: 'o', repo: 'r', pr: MERGED_PR });
    expect(r.outcome).toBe('failed');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const throwing: GithubApi = {
      async get() { throw new Error('unused'); },
      async put() { throw new Error('unused'); },
      async delete() { throw new Error('ECONNRESET'); },
    };
    const r2 = await deleteMergedHeadBranch({ api: throwing, owner: 'o', repo: 'r', pr: MERGED_PR });
    expect(r2).toEqual({ outcome: 'failed', branch: 'digby/session-abc', why: 'ECONNRESET' });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  test('NEVER deletes: the default branch, the base branch, main/master, a fork head, an unknown default, a PR without a head ref', async () => {
    const cases: Array<[any, string]> = [
      [{ ...MERGED_PR, head: { ...MERGED_PR.head, ref: 'main' } }, 'head is the default/base branch'],
      [{ ...MERGED_PR, base: { ...MERGED_PR.base, ref: 'digby/session-abc' } }, 'head is the default/base branch'],
      [{ ...MERGED_PR, head: { ...MERGED_PR.head, ref: 'master' }, base: { ref: 'dev', repo: { full_name: 'o/r', default_branch: 'dev' } } }, 'head is the default/base branch'],
      [{ ...MERGED_PR, head: { ref: 'digby/session-abc', repo: { full_name: 'someone/fork' } } }, 'head lives in a fork'],
      [{ ...MERGED_PR, head: { ref: 'digby/session-abc' } }, 'head lives in a fork'],
      [{ ...MERGED_PR, base: { ref: 'main', repo: { full_name: 'o/r' } } }, 'default branch unknown'],
      [{ merged: true }, 'no head ref on the PR'],
    ];
    for (const [pr, why] of cases) {
      const { api, calls } = deleteApi(204);
      const r = await deleteMergedHeadBranch({ api, owner: 'o', repo: 'r', pr });
      expect(r.outcome).toBe('kept');
      expect(r.why).toBe(why);
      expect(calls).toEqual([]);
    }
  });

  test('SELF_MERGE_KEEP_HEAD_BRANCH=1 keeps the head (kill switch, read per call)', async () => {
    expect(selfMergeKeepHeadBranch()).toBe(false);
    process.env.SELF_MERGE_KEEP_HEAD_BRANCH = '1';
    expect(selfMergeKeepHeadBranch()).toBe(true);
    const { api, calls } = deleteApi(204);
    const r = await deleteMergedHeadBranch({ api, owner: 'o', repo: 'r', pr: MERGED_PR });
    expect(r).toEqual({ outcome: 'kept', branch: 'digby/session-abc', why: 'SELF_MERGE_KEEP_HEAD_BRANCH=1' });
    expect(calls).toEqual([]);
  });

  test('an api double without delete() keeps the branch (the gate-engine doubles stay valid)', async () => {
    const r = await deleteMergedHeadBranch({ api: apiFor({}), owner: 'o', repo: 'r', pr: MERGED_PR });
    expect(r).toEqual({ outcome: 'kept', branch: 'digby/session-abc', why: 'api has no delete' });
  });
});

// ── G6 results-log truncation (tt-rd audit 2026-09-27, finding docs-churn-log-2) ──

describe('evaluateMergeGates — G6 results_log (observe-only by default)', () => {
  const base = { owner: 'o', repo: 'r', pullNumber: 9, sessionId: 's1' };
  const LOG = 'results/2026-08-29-flash-next-device-legs.md';
  /** PR #809 shape: the log rewritten from 4,238 lines to a 20-line stub, no archive added. */
  const stubDiff = (extra = '') => {
    const old = Array.from({ length: 4238 }, (_, i) => (i % 25 === 0 ? `-## F${i} — rung result` : `-| row ${i} | 5.08 tok/s | wall=12.6s |`)).join('\n');
    const fresh = Array.from({ length: 20 }, (_, i) => `+stub ${i}`).join('\n');
    return `diff --git a/${LOG} b/${LOG}\n--- a/${LOG}\n+++ b/${LOG}\n@@ -1,4238 +1,20 @@\n${old}\n${fresh}\n${extra}`;
  };
  const PR_WITH_BASE = { ...OPEN_PR, base: { sha: 'b'.repeat(40), ref: 'main' } };
  const routes = (diff: string, size: number | null = 1_515_127) => ({
    ...GREEN,
    [`pulls/9`]: PR_WITH_BASE,
    [`diff:`]: diff,
    ...(size === null ? {} : { [`contents/results/2026-08-29-flash-next-device-legs.md`]: { size, name: 'x' } }),
  });
  const strikes = () => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === 'guard_strike' && r?.meta?.seam === 'results_log_truncate');

  beforeEach(() => { mockGetVerifyState.mockResolvedValue(null); });

  test('DEFAULT: a stub rewrite of a results log (−4,232 lines, 170 sections, ~100 % of its pre-PR bytes, no archive) is NOTED + metered and the merge PROCEEDS', async () => {
    const v = await evaluateMergeGates({ ...base, api: apiFor(routes(stubDiff(), 240_000)) });
    expect(v.ok).toBe(true);
    const notes = (v as GatePass).evidenceNotes.join('\n');
    expect(notes).toMatch(/results_log: results\/2026-08-29-flash-next-device-legs\.md −4238 lines \(170 sections, \+20\) = \d+% of its 240000 pre-PR bytes with NO archive file added/);
    expect(notes).toMatch(/noted, not blocking \(RESULTS_LOG_GUARD_ENFORCE=1 re-arms a refusal\)/);
    expect(strikes()).toHaveLength(1);
    expect(strikes()[0]).toMatchObject({ sessionId: 's1', meta: { seam: 'results_log_truncate', state: 'observed', path: LOG, deleted: 4238, added: 20, sections: 170, hunkEstimated: false, archiveMissing: true, repo: 'o/r', pullNumber: 9 } });
  });

  test('the pre-PR size is read at the BASE sha; an unreadable size falls back to the hunk span (still a truncation for a stub rewrite)', async () => {
    const urls: string[] = [];
    const api = apiFor(routes(stubDiff(), null));
    const wrapped: GithubApi = { ...api, get: async (url, accept) => { urls.push(url); return api.get(url, accept); } };
    const v = await evaluateMergeGates({ ...base, api: wrapped });
    expect(v.ok).toBe(true);
    expect(urls.some((u) => u.includes(`/contents/results/2026-08-29-flash-next-device-legs.md?ref=${'b'.repeat(40)}`))).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toContain('of the lines the diff touches (pre-PR size unreadable)');
    expect(strikes()[0].meta).toMatchObject({ hunkEstimated: true });
  });

  test('an archive/ file added in the same diff, a small trim, or a code file: no note, no strike', async () => {
    const withArchive = stubDiff(`diff --git a/results/archive/legs-2026-09-25.md b/results/archive/legs-2026-09-25.md\n--- /dev/null\n+++ b/results/archive/legs-2026-09-25.md\n@@ -0,0 +1,1 @@\n+moved\n`);
    let v = await evaluateMergeGates({ ...base, api: apiFor(routes(withArchive, 240_000)) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).toContain('(an archive/ file is added in the same diff)');
    expect(strikes()[0].meta).toMatchObject({ archiveMissing: false });
    mockRecordLoopMetric.mockClear();
    // ENFORCED but archived → still passes (the archive exonerates)
    process.env.RESULTS_LOG_GUARD_ENFORCE = '1';
    v = await evaluateMergeGates({ ...base, api: apiFor(routes(withArchive, 240_000)) });
    expect(v.ok).toBe(true);
    delete process.env.RESULTS_LOG_GUARD_ENFORCE;
    mockRecordLoopMetric.mockClear();
    const trim = `diff --git a/${LOG} b/${LOG}\n--- a/${LOG}\n+++ b/${LOG}\n@@ -1,205 +1,5 @@\n${Array.from({ length: 200 }, () => '-old row').join('\n')}\n+new\n`;
    v = await evaluateMergeGates({ ...base, api: apiFor(routes(trim, 1_500_000)) });
    expect(v.ok).toBe(true);
    expect((v as GatePass).evidenceNotes.join('\n')).not.toContain('results_log:');
    expect(strikes()).toHaveLength(0);
    const code = `diff --git a/src/big.py b/src/big.py\n--- a/src/big.py\n+++ b/src/big.py\n@@ -1,5000 +1,10 @@\n${Array.from({ length: 5000 }, () => '-x').join('\n')}\n`;
    v = await evaluateMergeGates({ ...base, api: apiFor(routes(code)) });
    expect(v.ok).toBe(true);
    expect(strikes()).toHaveLength(0);
  });

  test('RESULTS_LOG_GUARD_ENFORCE=1 promotes the observation to merge gate results_log with the archive suggestedFix', async () => {
    process.env.RESULTS_LOG_GUARD_ENFORCE = '1';
    const v = await evaluateMergeGates({ ...base, api: apiFor(routes(stubDiff(), 240_000)) }) as GateFailure;
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('results_log');
    expect(v.cause).toContain('loses 4238 lines (170 sections) with no archive file added');
    expect(v.suggestedFix).toContain('results/archive/<name>-<YYYY-MM-DD>.md');
    expect(v.headSha).toBe('a'.repeat(40));
    expect(strikes()[0].meta).toMatchObject({ state: 'enforced' });
  });

  test('a guard error never fails the merge: the contents route throws per candidate → hunk fallback, merge still ok', async () => {
    // contents route absent → the apiFor helper throws → caught per candidate → hunk fallback, merge still ok
    const v2 = await evaluateMergeGates({ ...base, api: apiFor(routes(stubDiff(), null)) });
    expect(v2.ok).toBe(true);
  });
});
