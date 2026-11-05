/**
 * G2.5 red-window MERGE-TIME gate (feedback ticket 2bccefe0, 2026-10-18).
 *
 * THE GAP THIS PINS (PR #1754, 2026-10-18 15:11–15:37Z window): the guard
 * check mints its verdict on the PR head at PUSH time; the merge gate read
 * only the check-run CONCLUSION — so #1754 merged 15:16:54Z riding a guard
 * SUCCESS minted 15:07:18Z (run 39139038689) while main's deploy run
 * 39139333344 had concluded FAILURE at 15:16:04Z, 50 s before the merge.
 *
 * Two layers, same shape as the f101 pin discipline:
 *  1. CONTRACT (hermetic apiFor shim): the gate re-derives the window FRESH
 *     at merge time and REFUSES on red; the deploy-fix label overrides; an
 *     in-flight deploy is UNPROVEN/fail-open; cancelled waves and green
 *     windows pass; user-project repos / non-default bases / repos without
 *     the deploy workflow are out of scope (fail-open notes); the snapshot
 *     being unreadable fails OPEN; kill switch off.
 *  2. PARITY (reads the SHIPPED scripts/deploy/red-window-guard.sh): the
 *     leaf's selection rule mirrors the script's jq decision arms verbatim —
 *     any-active → unproven; newest completed by updated_at; failure → red.
 *     If the script's jq changes without this leaf, the pin fails (the f159
 *     two-suite lesson, applied at design time).
 */

jest.mock('./batch-train.service', () => ({
  __esModule: true,
  getLiveBatchTrain: jest.fn(async () => null),
  getActiveBatchTrains: jest.fn(async () => ({ trains: [] })),
  readCachedBatchTrains: jest.fn(async () => ({ trains: [] })),
  appendBatchTrainNotice: jest.fn(async (p: string) => p),
  invalidateBatchTrainCache: jest.fn(async () => undefined),
  discoveryApiFromGithub: jest.fn(() => ({ listBatchRefs: async () => ({ data: [] }), compareWithMain: async () => ({ data: {} }) })),
}));

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

import fs from 'fs';
import path from 'path';
import { evaluateMergeGates, type GithubApi, type GateFailure, type GatePass } from './self-merge.service';
import { classifyRedWindow, redWindowMergeGateDisabled, DEPLOY_FIX_LABEL, DEPLOY_WORKFLOW_PATH, type RedWindowRun } from './red-window-merge-gate';

// ── helpers ──────────────────────────────────────────────────────────────────

const ENV_KEYS = ['SELF_REPO', 'RED_WINDOW_MERGE_GATE_DISABLED'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  // The gate answers ONLY for the instance's own repo (prod default):
  process.env.SELF_REPO = 'example-org/crossmodel';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function apiFor(routes: Record<string, any>): GithubApi {
  return {
    async get(url: string, accept?: string) {
      const isDiff = accept === 'application/vnd.github.diff';
      for (const [pattern, data] of Object.entries(routes)) {
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

const HEAD = 'a'.repeat(40);
const OPEN_PR = {
  state: 'open', merged: false, mergeable: true, mergeable_state: 'clean',
  head: { sha: HEAD }, labels: [],
  base: { ref: 'main', repo: { default_branch: 'main' } },
};
const GREEN_CI = {
  [`pulls/9`]: OPEN_PR,
  [`check-runs`]: { check_runs: [{ name: 'Red window guard', status: 'completed', conclusion: 'success' }] },
  [`/status`]: { state: 'success', statuses: [{ state: 'success' }] },
  [`diff:`]: '+++ b/file\n+const x = 1;\n',
};

/** The #1754 incident shape: a guard-check SUCCESS on the PR head (minted
 *  BEFORE the window opened) while main's deploy has since concluded
 *  FAILURE — the exact case the merge-time verdict must catch. */
const PR1754_GUARD_GREEN = { name: 'Red window guard', status: 'completed', conclusion: 'success' };

function deployRun(id: number, sha: string, status: string, conclusion: string | null, updatedAt: string, branch = 'main'): any {
  return { id, status, conclusion, head_sha: sha, head_branch: branch, path: DEPLOY_WORKFLOW_PATH, updated_at: updatedAt };
}

const T_GREEN = '2026-10-18T15:07:18Z';   // #1754's guard verdict minted (pre-window)
const T_RED = '2026-10-18T15:16:04Z';     // main deploy run 39139333344 concluded failure
const T_MERGE = '2026-10-18T15:16:54Z';   // #1754 merged

// ── CONTRACT: the merge-time gate (evaluateMergeGates) ──────────────────────

describe('G2.5 red_window merge-time gate (ticket 2bccefe0)', () => {
  const base = { owner: 'example-org', repo: 'crossmodel', pullNumber: 9, sessionId: 's1' };

  test('THE INCIDENT: a pre-window guard GREEN on the PR head + a red main deploy at merge time → REFUSED (fresh verdict wins)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({
        ...GREEN_CI,
        [`check-runs`]: { check_runs: [PR1754_GUARD_GREEN] },   // the stale green #1754 rode
        [`actions/runs`]: { workflow_runs: [deployRun(39139333344, 'd3d29e73'.padEnd(40, '0'), 'completed', 'failure', T_RED)] },
      }),
    }) as GateFailure;
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('red_window');
    expect(v.cause).toContain('39139333344');
    expect(v.cause).toContain('RED');
    expect(v.suggestedFix).toContain(DEPLOY_FIX_LABEL);
    expect(v.headSha).toBe(HEAD);
    expect(v.transient).toBeUndefined(); // a red window is not a timing artifact — never waited out
    expect(v.evidence).toContain('FRESH at merge time');
  });

  test('same shape, deeper staleness: newest completed red run CONCLUDED AFTER a newer red run (newest-by-conclusion wins)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({
        ...GREEN_CI,
        [`actions/runs`]: { workflow_runs: [
          deployRun(39139304116, 'ff6bc4e8'.padEnd(40, '0'), 'completed', 'failure', '2026-10-18T15:13:19Z'),
          deployRun(39139333344, 'd3d29e73'.padEnd(40, '0'), 'completed', 'failure', T_RED),
        ] },
      }),
    }) as GateFailure;
    expect(v.gate).toBe('red_window');
    expect(v.cause).toContain('39139333344'); // newest by conclusion time
  });

  test('CLEAN: newest completed deploy on main succeeded → merge allowed, note records the fresh read', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [deployRun(39141111914, '549cef00'.padEnd(40, '0'), 'completed', 'success', '2026-10-18T16:01:23Z')] } }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toMatch(/red_window: no red window .*39141111914/);
  });

  test('CLEAN: a cancelled coalesced wave is not red (the newer run carries the commit)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [deployRun(39147865829, 'fa1ef96f'.padEnd(40, '0'), 'completed', 'cancelled', '2026-10-18T17:12:25Z')] } }),
    }) as GatePass;
    expect(v.ok).toBe(true);
  });

  // ── ticket 5e3453bb (2026-11-04): an IN-FLIGHT deploy must not launder a RED
  // window. Before this pin, a bare 'unproven' was handed back for ANY active
  // run, so the SAME main state REFUSED when the queue was quiet and was
  // ADMITTED the moment a deploy became active — the fail-open class the ticket
  // named (PR #2452 / #2458 both merged on "red_window UNPROVEN").
  test('5e3453bb REPLAY: a deploy run in flight over an older completed FAILURE → REFUSED (an active run never clears a red window)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [
        deployRun(39139333344, 'd3d29e73'.padEnd(40, '0'), 'completed', 'failure', T_RED),
        deployRun(39148497465, 'f44a0105'.padEnd(40, '0'), 'in_progress', null, '2026-10-18T17:16:52Z'),
      ] } }),
    }) as GateFailure;
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('red_window');
    expect(v.cause).toContain('39139333344');            // names the shadowed red run
    expect(v.cause).toContain('RED');
    expect(v.evidence).toContain('state=unproven');
    expect(v.evidence).toContain('FRESH at merge time');
    expect(v.suggestedFix).toContain(DEPLOY_FIX_LABEL);
    // A TIMING class, not a work item: the gates wait it out briefly and then
    // the harness HOLDS it as a merge intent, re-running the gates — so the
    // merge lands by itself once the wave concludes CLEAN (bounded defer).
    expect(v.transient).toBe('red_window_in_flight');
  });

  test('5e3453bb REPLAY: a concurrency-blocked PENDING run over a completed FAILURE → REFUSED too (pending is active)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [
        deployRun(1, 'b'.repeat(40), 'completed', 'failure', T_RED),
        deployRun(2, 'c'.repeat(40), 'pending', null, T_MERGE),
      ] } }),
    }) as GateFailure;
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('red_window');
    expect(v.transient).toBe('red_window_in_flight');
  });

  test('5e3453bb: an in-flight wave over a CLEAN shadow is the ordinary coalescing wave — still admitted (holding it would freeze the fleet)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [
        deployRun(41769611454, 'a7202c0d'.padEnd(40, '0'), 'completed', 'success', '2026-11-04T04:27:13Z'),
        deployRun(41771863349, '25277bda'.padEnd(40, '0'), 'in_progress', null, '2026-11-04T04:13:17Z'),
      ] } }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    const notes = v.evidenceNotes.join('\n');
    expect(notes).toMatch(/UNPROVEN/);
    expect(notes).toMatch(/no red window is being laundered/);
    expect(notes).toContain('41769611454');              // the shadow it rests on
  });

  test('5e3453bb: UNPROVEN with NO completed run at all (fresh repo) stays admissible — nothing is shadowed', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [
        deployRun(3, 'e'.repeat(40), 'in_progress', null, T_MERGE),
      ] } }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toMatch(/no red window is being laundered/);
  });

  test('OVERRIDE: the deploy-fix label short-circuits a red window (PR #1752 shape) — the window is not even evaluated', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({
        ...GREEN_CI,
        [`pulls/9`]: { ...OPEN_PR, labels: [{ name: DEPLOY_FIX_LABEL }] },
        [`actions/runs`]: { workflow_runs: [deployRun(39139333344, 'd3d29e73'.padEnd(40, '0'), 'completed', 'failure', T_RED)] },
      }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toMatch(/red_window: OVERRIDE label 'deploy-fix' present/);
  });

  test('SCOPE: a USER-PROJECT repo (not the instance own repo) is out of the gate — no snapshot read, fail-open note', async () => {
    const v = await evaluateMergeGates({
      ...base, owner: 'acme', repo: 'unrelated-app',
      api: apiFor({ ...GREEN_CI, [`pulls/9`]: { ...OPEN_PR, base: { ref: 'main', repo: { default_branch: 'main' } } } }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toMatch(/red_window: acme\/unrelated-app is not this instance's own repo/);
  });

  test('SCOPE: a PR into a NON-DEFAULT base (batch branch) has no window to guard', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({
        ...GREEN_CI,
        [`pulls/9`]: { ...OPEN_PR, base: { ref: 'batch/20261018T170000Z', repo: { default_branch: 'main' } } },
        [`actions/runs`]: { workflow_runs: [deployRun(1, 'd'.repeat(40), 'completed', 'failure', T_RED)] },
      }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toMatch(/red_window: PR targets batch\//);
  });

  test('SCOPE: a repo whose snapshot carries NO deploy workflow runs → no window to guard (fail-open)', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [{ id: 7, status: 'completed', conclusion: 'success', head_sha: 'e'.repeat(40), head_branch: 'main', path: '.github/workflows/ci.yml', updated_at: T_MERGE }] } }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toMatch(/red_window: no deploy workflow on this repo/);
  });

  test('FAIL-OPEN: an unreadable Actions snapshot never wedges the merge (2026-10-17 P0 class)', async () => {
    const api: GithubApi = {
      async get(url: string) {
        if (url.includes('actions/runs')) throw new Error('API down');
        const inner = apiFor(GREEN_CI);
        return inner.get(url);
      },
      async put(url: string, body: any) { return apiFor(GREEN_CI).put(url, body); },
    };
    const v = await evaluateMergeGates({ ...base, api }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toMatch(/red_window: window unreadable \(fail-open\)/);
  });

  test('KILL SWITCH: RED_WINDOW_MERGE_GATE_DISABLED=1 turns the gate off with a note', async () => {
    process.env.RED_WINDOW_MERGE_GATE_DISABLED = '1';
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [deployRun(39139333344, 'd3d29e73'.padEnd(40, '0'), 'completed', 'failure', T_RED)] } }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    expect(v.evidenceNotes.join('\n')).toMatch(/red_window: kill switch RED_WINDOW_MERGE_GATE_DISABLED=1/);
  });

  test('OFF-Main deploy runs are invisible: failures on other branches/workflows never block', async () => {
    const v = await evaluateMergeGates({
      ...base,
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [
        deployRun(1, 'f'.repeat(40), 'completed', 'failure', T_RED, 'feature/x'),
        { ...deployRun(2, '0'.repeat(40), 'completed', 'failure', T_RED), path: '.github/workflows/ci.yml' },
      ] } }),
    }) as GatePass;
    expect(v.ok).toBe(true);
    // no completed deploy on main at all → clean (fresh-repo shape)
    expect(v.evidenceNotes.join('\n')).toMatch(/red_window: no red window \(last completed deploy on main: undefined/);
  });

  test('SELF_HOSTED scope: a non-prod instance guards its OWN repo (SELF_REPO), not production', async () => {
    process.env.SELF_REPO = 'acme/edge-digby';
    // acme/edge-digby IS the own repo → the window IS evaluated (red → refused)
    const v = await evaluateMergeGates({
      ...base, owner: 'acme', repo: 'edge-digby',
      api: apiFor({ ...GREEN_CI, [`actions/runs`]: { workflow_runs: [deployRun(1, '1'.repeat(40), 'completed', 'failure', T_RED)] } }),
    }) as GateFailure;
    expect(v.ok).toBe(false);
    expect(v.gate).toBe('red_window');
  });
});

// ── PARITY: the leaf mirrors the SHIPPED guard script's jq decision arms ─────

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/deploy/red-window-guard.sh'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

describe('script parity — red-window-merge-gate.ts mirrors red-window-guard.sh (2bccefe0)', () => {
  const scriptPath = path.join(repoRoot(__dirname), 'scripts/deploy/red-window-guard.sh');
  const script = fs.readFileSync(scriptPath, 'utf8');

  test('the shipped script exists and keeps its sentinel/decision arms (the surface this leaf mirrors)', () => {
    expect(script).toContain('RWGDECISION=red');
    expect(script).toContain('sort_by(.updated_at)');
    expect(script).toContain('if any(.status != "completed") then');
    expect(script).toContain('"unproven none none none none"');
  });

  test('leaf constants match the script (deploy path, label token, default branch selection)', () => {
    expect(script).toContain(`DPATH="${DEPLOY_WORKFLOW_PATH}"`);
    expect(script).toContain(`LABEL_TOKEN="${DEPLOY_FIX_LABEL}"`);
  });

  test('classifyRedWindow reproduces the script jq arms on the #1754 snapshot', () => {
    // newest completed failure on main → red, named by id
    expect(classifyRedWindow([deployRun(39139333344, 'd3d29e73'.padEnd(40, '0'), 'completed', 'failure', T_RED)], 'main')).toMatchObject({ state: 'red', runId: '39139333344', conclusion: 'failure' });
    // in-flight shadows → unproven
    expect(classifyRedWindow([
      deployRun(39139333344, 'd3d29e73'.padEnd(40, '0'), 'completed', 'failure', T_RED),
      deployRun(39148497465, 'f44a0105'.padEnd(40, '0'), 'in_progress', null, T_MERGE),
    ], 'main')).toMatchObject({ state: 'unproven' });
    // newest completed success → clean
    expect(classifyRedWindow([deployRun(39141111914, '549cef00'.padEnd(40, '0'), 'completed', 'success', '2026-10-18T16:01:23Z')], 'main')).toMatchObject({ state: 'clean', conclusion: 'success' });
    // cancelled (coalesced) → clean
    expect(classifyRedWindow([deployRun(1, '2'.repeat(40), 'completed', 'cancelled', T_MERGE)], 'main')).toMatchObject({ state: 'clean' });
    // fresh repo (no completed deploy runs) → clean
    expect(classifyRedWindow([deployRun(1, '3'.repeat(40), 'queued', null, T_MERGE)], 'main')).toMatchObject({ state: 'unproven' });
    expect(classifyRedWindow([], 'main')).toMatchObject({ state: 'clean' });
    // other branch / other workflow invisible
    expect(classifyRedWindow([deployRun(1, '4'.repeat(40), 'completed', 'failure', T_RED, 'feature/x')], 'main')).toMatchObject({ state: 'clean' });
  });

  test('kill-switch helper parses the documented shapes', () => {
    expect(redWindowMergeGateDisabled({ RED_WINDOW_MERGE_GATE_DISABLED: '1' } as any)).toBe(true);
    expect(redWindowMergeGateDisabled({ RED_WINDOW_MERGE_GATE_DISABLED: 'true' } as any)).toBe(true);
    expect(redWindowMergeGateDisabled({} as any)).toBe(false);
  });
});
