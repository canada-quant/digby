/**
 * MERGE-INTENT-AWAIT (2026-10-20) — registration + the merge-intents cron pass
 * (merge-intent.service.ts). Every side effect is injected: an in-memory
 * intent store, a routed fake GitHub API, the gate engine, the wake, the
 * receipt minter. Pins:
 *   - CI still running on the head ⇒ the intent WAITS (no gate run, no wake);
 *   - green on the EXACT head ⇒ the merge PUT is pinned to that head, merged:true
 *     is confirmed, the receipt is minted on the lane chat, merge_success is
 *     recorded via merge_intent, the lane is woken ONCE and the row is gone;
 *   - a real gate failure ⇒ ONE [MERGE INTENT — BLOCKED] wake with gate / cause
 *     / fix, merge_gate_failure via merge_intent;
 *   - a push that moved the head ⇒ superseded; the update-branch merge commit
 *     the harness asked for ⇒ adopted;
 *   - a stopped / archived / gone lane ⇒ dropped with NO wake (stop means stop);
 *   - a wake that cannot be queued keeps the row (pendingWake) and is retried;
 *   - the kill switch leaves every intent alone.
 * Review fixes (2026-10-20): a backstop one-shot at registration (suppressed by
 * every outcome); another chat's intent is never cleared / replaced silently;
 * a CI dispatch gap closes BLOCKED after one pass of grace; repeated full-gate
 * timing verdicts back off; a pending wake to a gone lane drops and abandons
 * after its TTL on its own budget; only the QUEUING run's stop drops; a merge
 * of another head is never claimed as ours; an update-branch on a head the
 * intent does not own supersedes; a merge commit older than the request is
 * never adopted; a failed wake covers nothing.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    MERGE_INTENT: 'merge_intent', AWAIT_CONDITION: 'await_condition', MERGE_GATE_FAILURE: 'merge_gate_failure',
    MERGE_SUCCESS: 'merge_success', GUARD_MISS: 'guard_miss', GUARD_STRIKE: 'guard_strike', CI_WATCH: 'ci_watch',
  },
}));

import { registerMergeIntent, clearMergeIntent, runHarnessWaitsOnce, renderHarnessWaitsSummary, harnessWaitCoversSha, type MergeIntentStore, type StoredMergeIntent } from './merge-intent.service';
import { newIntent, MERGE_INTENT_TTL_MS, MERGE_INTENT_MAX_ERRORS, MERGE_INTENT_BACKSTOP_MS, MERGE_INTENT_PENDING_WAKE_TTL_MS, MERGE_INTENT_INTERVAL_SEC, MERGE_INTENT_GATE_BACKOFF_MAX_MS } from './merge-intent';
import type { GithubApi } from './self-merge.service';
import type { LaneFacts, ConditionWakeStore, ConditionWakeRecord } from './await-condition';

const HEAD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const T0 = new Date('2026-10-20T12:00:00Z');
const LATER = new Date(T0.getTime() + 5 * 60_000);

function memStore(): MergeIntentStore & { rows: Map<string, StoredMergeIntent> } {
  const rows = new Map<string, StoredMergeIntent>();
  return {
    rows,
    get: async (k) => rows.get(k) ?? null,
    put: async (k, r) => { rows.set(k, JSON.parse(JSON.stringify(r))); },
    del: async (k) => { rows.delete(k); },
    list: async () => [...rows.values()],
  };
}

function api(routes: Record<string, any>, putAnswer: { status: number; data: any } = { status: 200, data: { merged: true, sha: MERGE } }): GithubApi & { puts: Array<{ url: string; body: any }> } {
  const puts: Array<{ url: string; body: any }> = [];
  return {
    puts,
    async get(url: string) {
      for (const [pattern, data] of Object.entries(routes)) {
        if (url.includes(pattern)) {
          const d = typeof data === 'function' ? data() : data;
          if (d instanceof Error) throw d;
          return { status: 200, data: d };
        }
      }
      throw new Error(`unrouted GET ${url}`);
    },
    async put(url: string, body: any) { puts.push({ url, body }); return putAnswer; },
  };
}

const OPEN = { state: 'open', merged: false, head: { sha: HEAD, ref: 'lane/x' } };
const DONE_RUNS = { check_runs: [{ name: 'tests', status: 'completed', conclusion: 'success' }] };
const lane = (over: Partial<LaneFacts> = {}): LaneFacts => ({ userId: 'u1', archived: false, githubLabel: null, lastRun: { status: 'completed', error: null, at: T0 }, ...over });

function seed(store: ReturnType<typeof memStore>, over: Partial<StoredMergeIntent> = {}): StoredMergeIntent {
  const rec: StoredMergeIntent = { ...newIntent({ owner: 'o', repo: 'r', pullNumber: 9, headSha: HEAD, chatId: 'lane-1', userId: 'u1', projectId: 'p1', waitKind: 'ci_pending', gate: 'ci', cause: 'CI still running' }, T0), ...over };
  store.rows.set(rec.key, rec);
  return rec;
}

function deps(store: MergeIntentStore, gh: GithubApi, over: Record<string, any> = {}) {
  const wake = jest.fn(async () => ({ ok: true, hookEventId: 'hk1' }));
  const suppress = jest.fn(async () => true);
  const evaluateGates = jest.fn(async () => ({ ok: true, headSha: HEAD, evidenceNotes: ['green'] }));
  const mintReceipt = jest.fn(async () => 'rcpt-1234abcd');
  const afterMerge = jest.fn(async () => {});
  const recordLearning = jest.fn(async () => {});
  const conditionPass = jest.fn(async () => ({ open: 0, checked: 0, met: 0, waiting: 0, dropped: 0, errors: 0, rateLimited: 0 }));
  const noteRedWake = jest.fn(async () => 'deliver');
  const d = {
    now: LATER, store, wake, suppress, evaluateGates, mintReceipt, afterMerge, recordLearning, conditionPass, noteRedWake,
    loadLane: jest.fn(async () => lane()),
    getToken: jest.fn(async () => 'tok'),
    makeApi: () => gh,
    resolvePolicy: jest.fn(async () => ({ policy: 'on', source: 'framework' })),
    selfMergeDisabled: () => false,
    ...over,
  };
  return d as any; // jest mocks stand in for the typed seams
}

const rows = (kind: string) => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((r: any) => r?.kind === kind);
const phases = () => rows('merge_intent').map((r: any) => r.meta.phase);

beforeEach(() => {
  mockRecordLoopMetric.mockClear();
  delete process.env.MERGE_INTENT_QUEUE_DISABLED;
});

describe('registerMergeIntent / clearMergeIntent', () => {
  const regDeps = (store: MergeIntentStore, over: Record<string, any> = {}) => {
    let n = 0;
    const wake = jest.fn(async (_o: any) => ({ ok: true, hookEventId: `hk${++n}` }));
    const suppress = jest.fn(async (_id: string | null | undefined, _r: string) => true);
    return { store, wake, suppress, ...over } as any;
  };

  it('queues a new intent (backstop FIRST), refreshes the same head, lets the first chat keep a same-head intent and HANDS OVER a stale head with a superseded wake to the old holder', async () => {
    const store = memStore();
    const base = { owner: 'o', repo: 'r', pullNumber: 9, headSha: HEAD, chatId: 'lane-1', userId: 'u1', waitKind: 'ci_pending' as const, gate: 'ci' as const, cause: 'CI still running' };
    const d1 = regDeps(store, { now: T0 });
    const a = await registerMergeIntent(base, d1);
    expect(a).toMatchObject({ ok: true, refreshed: false, heldByOtherChat: null });
    expect(store.rows.get('o/r#9')).toMatchObject({ headSha: HEAD, chatId: 'lane-1', waitKind: 'ci_pending', backstopHookEventId: 'hk1' });
    // the backstop one-shot: on the lane, held to TTL + slack
    const bs = d1.wake.mock.calls[0][0];
    expect(bs).toMatchObject({ targetChatId: 'lane-1', meta: { wakeKind: 'merge_intent_backstop' } });
    expect(bs.prompt).toMatch(/^\[MERGE INTENT — BACKSTOP o\/r#9\]/);
    expect(bs.notBefore.getTime()).toBe(T0.getTime() + MERGE_INTENT_BACKSTOP_MS);

    const b = await registerMergeIntent({ ...base, waitKind: 'server_5xx' }, regDeps(store, { now: LATER }));
    expect(b).toMatchObject({ ok: true, refreshed: true, heldByOtherChat: null });
    expect(store.rows.get('o/r#9')).toMatchObject({ waitKind: 'server_5xx', createdAt: T0.toISOString(), backstopHookEventId: 'hk1' }); // a refresh never extends the TTL

    const c = await registerMergeIntent({ ...base, chatId: 'lane-2' }, regDeps(store, { now: LATER }));
    expect(c).toMatchObject({ ok: true, refreshed: true, heldByOtherChat: 'lane-1' });
    expect(store.rows.get('o/r#9')!.chatId).toBe('lane-1');

    const d4 = regDeps(store, { now: LATER });
    const d = await registerMergeIntent({ ...base, chatId: 'lane-2', headSha: NEW }, d4);
    expect(d).toMatchObject({ ok: true, refreshed: false });
    expect(store.rows.get('o/r#9')).toMatchObject({ headSha: NEW, chatId: 'lane-2', createdAt: LATER.toISOString(), backstopHookEventId: 'hk1' });
    // review fix: the old holder (lane-1) is told before its row is replaced, and its backstop stands down
    const handover = d4.wake.mock.calls.map((cl: any[]) => cl[0]).find((w: any) => w.targetChatId === 'lane-1');
    expect(handover.prompt).toMatch(/^\[MERGE INTENT — BLOCKED o\/r#9\]/);
    expect(handover.prompt).toContain('session lane-2 queued the merge on that new head');
    expect(d4.suppress).toHaveBeenCalledWith('hk1', 'merge_intent_replaced');
    expect(phases()).toEqual(['queued', 'refreshed', 'refreshed', 'superseded', 'queued']);

    const dc = regDeps(store);
    expect(await clearMergeIntent('O', 'R', 9, 'lane-2', 'merged_by_tool', dc)).toBe(true);
    expect(store.rows.size).toBe(0);
    expect(dc.suppress).toHaveBeenCalledWith('hk1', 'merge_intent_cleared:merged_by_tool');
    expect(phases().at(-1)).toBe('cleared');
  });

  it('review fix: clearMergeIntent never deletes ANOTHER chat’s intent — it pulls the holder’s next check forward so the cron wakes it with the outcome', async () => {
    const store = memStore();
    const rec = seed(store, { nextCheckAt: new Date(LATER.getTime() + 30 * 60_000).toISOString() });
    const dc = regDeps(store, { now: LATER });
    expect(await clearMergeIntent('o', 'r', 9, 'lane-B', 'merged_by_tool', dc)).toBe(false);
    expect(store.rows.get(rec.key)).toMatchObject({ chatId: 'lane-1', nextCheckAt: LATER.toISOString() });
    expect(dc.suppress).not.toHaveBeenCalled();
    expect(phases()).toEqual(['clear_deferred']);
    // …and the next pass reads it merged and wakes lane-1 (already_merged).
    const d = deps(store, api({ 'pulls/9': { ...OPEN, merged: true, merge_commit_sha: MERGE } }));
    await runHarnessWaitsOnce(d);
    expect((d.wake.mock.calls[0] as any[])[0]).toMatchObject({ targetChatId: 'lane-1', prompt: expect.stringContaining('merged by someone else') });
  });

  it('review fix: a failed backstop stores nothing; an owed outcome wake is delivered BEFORE a new head replaces the row', async () => {
    const store = memStore();
    const base = { owner: 'o', repo: 'r', pullNumber: 9, headSha: HEAD, chatId: 'lane-1', userId: 'u1', waitKind: 'ci_pending' as const };
    expect(await registerMergeIntent(base, regDeps(store, { wake: jest.fn(async () => ({ ok: false, error: 'db down' })) }))).toMatchObject({ ok: false, reason: 'backstop_failed' });
    expect(store.rows.size).toBe(0);

    seed(store, { pendingWake: { prompt: '[MERGE INTENT — MERGED o/r#9] owed', outcome: 'merged' }, backstopHookEventId: 'old-bs' });
    const d = regDeps(store, { now: LATER });
    const r = await registerMergeIntent({ ...base, chatId: 'lane-2', headSha: NEW }, d);
    expect(r).toMatchObject({ ok: true, refreshed: false });
    expect(d.wake.mock.calls[0][0]).toMatchObject({ targetChatId: 'lane-1', prompt: '[MERGE INTENT — MERGED o/r#9] owed' });
    expect(d.suppress).toHaveBeenCalledWith('old-bs', 'merge_intent_merged');
    expect(store.rows.get('o/r#9')).toMatchObject({ chatId: 'lane-2', headSha: NEW });
    expect(store.rows.get('o/r#9')!.pendingWake).toBeUndefined();

    // the owed wake still failing ⇒ the caller bounces; the owed row is untouched
    const store2 = memStore();
    seed(store2, { pendingWake: { prompt: 'owed', outcome: 'closed' } });
    expect(await registerMergeIntent({ ...base, chatId: 'lane-2', headSha: NEW }, regDeps(store2, { wake: jest.fn(async () => ({ ok: false })) }))).toMatchObject({ ok: false, reason: 'pending_wake' });
    expect(store2.rows.get('o/r#9')!.pendingWake).toMatchObject({ outcome: 'closed' });
  });

  it('refuses the 7th open intent of one chat (cap), a non-hex head, and everything under the kill switch', async () => {
    const store = memStore();
    for (let n = 1; n <= 6; n++) {
      expect((await registerMergeIntent({ owner: 'o', repo: 'r', pullNumber: n, headSha: HEAD, chatId: 'lane-1', userId: 'u1', waitKind: 'ci_pending' }, regDeps(store, { now: T0 }))).ok).toBe(true);
    }
    expect(await registerMergeIntent({ owner: 'o', repo: 'r', pullNumber: 7, headSha: HEAD, chatId: 'lane-1', userId: 'u1', waitKind: 'ci_pending' }, regDeps(store, { now: T0 }))).toEqual({ ok: false, reason: 'cap' });
    expect(await registerMergeIntent({ owner: 'o', repo: 'r', pullNumber: 8, headSha: 'nothex', chatId: 'lane-1', userId: 'u1', waitKind: 'ci_pending' }, regDeps(store, { now: T0 }))).toEqual({ ok: false, reason: 'invalid' });
    process.env.MERGE_INTENT_QUEUE_DISABLED = '1';
    expect(await registerMergeIntent({ owner: 'o', repo: 'r', pullNumber: 9, headSha: HEAD, chatId: 'lane-9', userId: 'u1', waitKind: 'ci_pending' }, regDeps(store, { now: T0 }))).toEqual({ ok: false, reason: 'disabled' });
    expect(await clearMergeIntent('o', 'r', 1, 'lane-1', 'x', regDeps(store))).toBe(false);
  });
});

describe('runHarnessWaitsOnce — the merge-intent pass', () => {
  it('CI still running on the head ⇒ WAIT: no gate run, no merge, no wake; the next check is scheduled', async () => {
    const store = memStore();
    seed(store);
    const gh = api({ 'pulls/9': OPEN, 'check-runs': { check_runs: [{ name: 'tests', status: 'in_progress', conclusion: null }] } });
    const d = deps(store, gh);
    const summary = await runHarnessWaitsOnce(d);
    expect(d.evaluateGates).not.toHaveBeenCalled();
    expect(gh.puts).toHaveLength(0);
    expect(d.wake).not.toHaveBeenCalled();
    const row = store.rows.get('o/r#9')!;
    expect(row.checks).toBe(1);
    expect(Date.parse(row.nextCheckAt)).toBeGreaterThan(LATER.getTime());
    expect(summary).toMatch(/intents 1 open, 1 checked, 0 merged, 0 blocked, 1 waiting/);
  });

  it('green on the EXACT head ⇒ merge pinned to it, confirmed, receipt minted on the lane, merge_success via merge_intent, ONE MERGED wake, row gone', async () => {
    const store = memStore();
    seed(store, { backstopHookEventId: 'bs-1' });
    let merged = false;
    const gh = api({ 'pulls/9': () => (merged ? { ...OPEN, merged: true, merge_commit_sha: MERGE } : OPEN), 'check-runs': DONE_RUNS });
    const origPut = gh.put.bind(gh);
    gh.put = async (url: string, body: any) => { const r = await origPut(url, body); merged = true; return r; };
    const d = deps(store, gh);
    await runHarnessWaitsOnce(d);
    expect(d.evaluateGates).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', pullNumber: 9, sessionId: 'lane-1' }));
    expect(gh.puts).toEqual([{ url: 'https://api.github.com/repos/o/r/pulls/9/merge', body: { merge_method: 'squash', sha: HEAD } }]);
    expect(d.mintReceipt).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'lane-1', headSha: HEAD }), expect.stringMatching(/^MERGED o\/r#9 \(squash sha dddddddddddd\) — confirmed merged:true/));
    expect(d.afterMerge).toHaveBeenCalledTimes(1);
    expect(d.wake).toHaveBeenCalledTimes(1);
    const w = (d.wake.mock.calls[0] as any[])[0];
    expect(w.targetChatId).toBe('lane-1');
    expect(w.prompt).toMatch(/^\[MERGE INTENT — MERGED o\/r#9\]/);
    expect(w.prompt).toContain('receipt rcpt-123');
    expect(w.meta).toMatchObject({ origin: 'merge-intent', wakeKind: 'merge_intent', mergeIntent: { outcome: 'merged', pullNumber: 9 } });
    expect(store.rows.size).toBe(0);
    expect(d.suppress).toHaveBeenCalledWith('bs-1', 'merge_intent_merged'); // the backstop stands down once the outcome wake is queued
    expect(rows('merge_success')[0]).toMatchObject({ sessionId: 'lane-1', meta: { repo: 'o/r', pullNumber: 9, mergeSha: MERGE, via: 'merge_intent' } });
    expect(phases()).toContain('merged');
    // the merged PR's pr_merged condition wakes are covered (no second wake)
    const covered = (d.conditionPass.mock.calls[0] as any[])[0].covered as Set<string>;
    expect([...covered]).toEqual(['lane-1:pr_merged:o/r#9']);
  });

  it('a REAL gate failure on the head ⇒ ONE BLOCKED wake with gate / cause / fix; merge_gate_failure via merge_intent; a learning', async () => {
    const store = memStore();
    seed(store);
    const gh = api({ 'pulls/9': OPEN, 'check-runs': DONE_RUNS });
    const d = deps(store, gh, {
      evaluateGates: jest.fn(async () => ({ ok: false, gate: 'ci', cause: 'CI is RED on the head sha', evidence: 'tests: completed/failure', suggestedFix: 'fix it', evidenceHash: 'h', headSha: HEAD })),
    });
    await runHarnessWaitsOnce(d);
    expect(gh.puts).toHaveLength(0);
    const w = (d.wake.mock.calls[0] as any[])[0];
    expect(w.prompt).toMatch(/^\[MERGE INTENT — BLOCKED o\/r#9\]/);
    expect(w.prompt).toContain('gate ci failed on that exact head — CI is RED');
    expect(w.prompt).toContain('fix: fix it');
    expect(rows('merge_gate_failure')[0]).toMatchObject({ meta: { gate: 'ci', via: 'merge_intent', headSha: HEAD } });
    expect(d.recordLearning).toHaveBeenCalledWith('p1', expect.stringContaining('merge intent BLOCKED at gate ci'));
    expect(store.rows.size).toBe(0);
  });

  it('a push moved the head ⇒ superseded (BLOCKED wake); the update-branch merge commit the harness asked for ⇒ ADOPTED and gated', async () => {
    const store = memStore();
    seed(store);
    const gh = api({ 'pulls/9': { ...OPEN, head: { sha: NEW } } });
    const d = deps(store, gh);
    await runHarnessWaitsOnce(d);
    expect((d.wake.mock.calls[0] as any[])[0].prompt).toContain('moved to bbbbbbbbbbbb by a push the harness did not make');
    expect(phases()).toContain('superseded');

    const store2 = memStore();
    seed(store2, { updateBranchFrom: HEAD, updateBranchAt: T0.toISOString() });
    const gh2 = api({ 'pulls/9': { ...OPEN, head: { sha: NEW } }, [`commits/${NEW}/check-runs`]: { check_runs: [{ status: 'queued' }] }, [`commits/${NEW}`]: { parents: [{ sha: HEAD }, { sha: BASE }], commit: { committer: { date: new Date(T0.getTime() + 60_000).toISOString() } } } });
    const d2 = deps(store2, gh2);
    await runHarnessWaitsOnce(d2);
    expect(d2.wake).not.toHaveBeenCalled();
    expect(store2.rows.get('o/r#9')).toMatchObject({ headSha: NEW, updateBranchFrom: null, waitKind: 'ci_pending' });
    expect(phases()).toContain('adopted');
  });

  it('review fix: a two-parent commit on the intent head written BEFORE the update request (the lane’s own merge) is a push ⇒ superseded, never adopted', async () => {
    const store = memStore();
    seed(store, { updateBranchFrom: HEAD, updateBranchAt: T0.toISOString() });
    const gh = api({ 'pulls/9': { ...OPEN, head: { sha: NEW } }, [`commits/${NEW}`]: { parents: [{ sha: HEAD }, { sha: BASE }], commit: { committer: { date: new Date(T0.getTime() - 30 * 60_000).toISOString() } } } });
    const d = deps(store, gh);
    await runHarnessWaitsOnce(d);
    expect((d.wake.mock.calls[0] as any[])[0].prompt).toContain('moved to bbbbbbbbbbbb by a push');
    expect(d.evaluateGates).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
  });

  it('review fix: the gates asked GitHub to update a head the intent does NOT own (a push between the PR read and the gates) ⇒ superseded, the update never recorded', async () => {
    const store = memStore();
    seed(store);
    const gh = api({ 'pulls/9': OPEN, 'check-runs': DONE_RUNS });
    const d = deps(store, gh, {
      evaluateGates: jest.fn(async () => ({ ok: false, gate: 'pr_state', cause: 'PR branch was BEHIND its base', evidence: 'behind', suggestedFix: 'wait', evidenceHash: 'h', headSha: NEW, transient: 'ci_pending', branchUpdatedFrom: NEW })),
    });
    await runHarnessWaitsOnce(d);
    const w = (d.wake.mock.calls[0] as any[])[0].prompt;
    expect(w).toMatch(/^\[MERGE INTENT — BLOCKED o\/r#9\]/);
    expect(w).toContain('moved to bbbbbbbbbbbb');
    expect(w).toContain('pull the PR branch');
    expect(store.rows.size).toBe(0);
    expect(phases()).not.toContain('update_branch');
  });

  it('a BEHIND branch updated by the gates ⇒ waits with updateBranchFrom recorded (update_branch row)', async () => {
    const store = memStore();
    seed(store);
    const gh = api({ 'pulls/9': OPEN, 'check-runs': DONE_RUNS });
    const d = deps(store, gh, {
      evaluateGates: jest.fn(async () => ({ ok: false, gate: 'pr_state', cause: 'PR branch was BEHIND its base', evidence: 'behind', suggestedFix: 'wait', evidenceHash: 'h', headSha: HEAD, transient: 'ci_pending', branchUpdatedFrom: HEAD })),
    });
    await runHarnessWaitsOnce(d);
    expect(d.wake).not.toHaveBeenCalled();
    expect(store.rows.get('o/r#9')).toMatchObject({ updateBranchFrom: HEAD, lastGate: 'pr_state', waitKind: 'ci_pending' });
    expect(phases()).toContain('update_branch');
  });

  it('an update-branch GitHub has not written yet ⇒ wait without re-gating (no second request) for the settle window, then the gates run again', async () => {
    const store = memStore();
    seed(store, { updateBranchFrom: HEAD, updateBranchAt: T0.toISOString() });
    const gh = api({ 'pulls/9': { ...OPEN, mergeable_state: 'behind' }, 'check-runs': DONE_RUNS });
    const d = deps(store, gh);
    await runHarnessWaitsOnce(d);
    expect(d.evaluateGates).not.toHaveBeenCalled();
    expect(store.rows.get('o/r#9')).toMatchObject({ lastGate: 'pr_state', checks: 1 });
    const d2 = deps(store, gh, { now: new Date(T0.getTime() + 11 * 60_000) });
    await runHarnessWaitsOnce(d2);
    expect(d2.evaluateGates).toHaveBeenCalledTimes(1);
  });

  it('expired ⇒ BLOCKED (expired); a human-set OFF ⇒ BLOCKED (policy_off)', async () => {
    const store = memStore();
    seed(store);
    const gh = api({});
    const d = deps(store, gh, { now: new Date(T0.getTime() + MERGE_INTENT_TTL_MS + 60_000) });
    await runHarnessWaitsOnce(d);
    expect((d.wake.mock.calls[0] as any[])[0].prompt).toContain('did NOT land within 6 h');

    const store2 = memStore();
    seed(store2);
    const d2 = deps(store2, gh, { resolvePolicy: jest.fn(async () => ({ policy: 'off', source: 'owner' })) });
    await runHarnessWaitsOnce(d2);
    expect((d2.wake.mock.calls[0] as any[])[0].prompt).toContain('self-merge is now OFF');
  });

  it('a lane STOPPED after the queue, archived or gone ⇒ dropped with NO wake (stop means stop); a stop BEFORE the queue does not count', async () => {
    for (const l of [lane({ lastRun: { status: 'cancelled', error: 'stopped by owner', at: LATER } }), lane({ archived: true }), null]) {
      const store = memStore();
      seed(store);
      const d = deps(store, api({}), { loadLane: jest.fn(async () => l) });
      await runHarnessWaitsOnce(d);
      expect(d.wake).not.toHaveBeenCalled();
      expect(store.rows.size).toBe(0);
    }
    expect(rows('merge_intent').filter((r: any) => r.meta.phase === 'cancelled').map((r: any) => r.meta.why)).toEqual(['lane_stopped', 'lane_archived', 'lane_gone']);
    const store = memStore();
    seed(store);
    const d = deps(store, api({ 'pulls/9': OPEN, 'check-runs': { check_runs: [{ status: 'in_progress' }] } }), { loadLane: jest.fn(async () => lane({ lastRun: { status: 'cancelled', error: 'stopped', at: new Date(T0.getTime() - 60_000) } })) });
    await runHarnessWaitsOnce(d);
    expect(store.rows.size).toBe(1); // still waiting
  });

  it('review fix: only a stop of the run that QUEUED the intent drops it — a later, unrelated run stopped by a supervisor never abandons the merge', async () => {
    const stopped = (id: string) => lane({ lastRun: { id, status: 'cancelled', error: 'stopped by supervisor', at: LATER } });
    const store = memStore();
    seed(store, { runId: 'run-q' });
    const d = deps(store, api({ 'pulls/9': OPEN, 'check-runs': { check_runs: [{ status: 'in_progress' }] } }), { loadLane: jest.fn(async () => stopped('run-later')) });
    await runHarnessWaitsOnce(d);
    expect(store.rows.size).toBe(1); // still waiting on CI — the merge is not abandoned
    expect(phases()).not.toContain('cancelled');

    const store2 = memStore();
    seed(store2, { runId: 'run-q', backstopHookEventId: 'bs-q' });
    const d2 = deps(store2, api({}), { loadLane: jest.fn(async () => stopped('run-q')) });
    await runHarnessWaitsOnce(d2);
    expect(store2.rows.size).toBe(0);
    expect(d2.wake).not.toHaveBeenCalled();
    expect(d2.suppress).toHaveBeenCalledWith('bs-q', 'merge_intent_cancelled:lane_stopped'); // stop means stop: the backstop stands down too
  });

  it('merged by someone else ⇒ MERGED (already) wake; merged after OUR put (confirmation lost) ⇒ finished as our merge with the receipt', async () => {
    const store = memStore();
    seed(store);
    const d = deps(store, api({ 'pulls/9': { ...OPEN, merged: true, merge_commit_sha: MERGE } }));
    await runHarnessWaitsOnce(d);
    expect((d.wake.mock.calls[0] as any[])[0].prompt).toContain('merged by someone else');
    expect(d.mintReceipt).not.toHaveBeenCalled();

    const store2 = memStore();
    seed(store2, { mergePutAt: T0.toISOString() });
    const d2 = deps(store2, api({ 'pulls/9': { ...OPEN, merged: true, merge_commit_sha: MERGE } }));
    await runHarnessWaitsOnce(d2);
    expect(d2.mintReceipt).toHaveBeenCalledTimes(1);
    expect((d2.wake.mock.calls[0] as any[])[0].prompt).toMatch(/^\[MERGE INTENT — MERGED o\/r#9\] The harness merged/);

    // review fix: after our PUT timed out, a HUMAN merged a NEWER head — never claimed as ours (no receipt, no merge_success)
    mockRecordLoopMetric.mockClear();
    const store3 = memStore();
    seed(store3, { mergePutAt: T0.toISOString() });
    const d3 = deps(store3, api({ 'pulls/9': { ...OPEN, head: { sha: NEW }, merged: true, merge_commit_sha: MERGE } }));
    await runHarnessWaitsOnce(d3);
    expect(d3.mintReceipt).not.toHaveBeenCalled();
    expect(rows('merge_success')).toHaveLength(0);
    expect((d3.wake.mock.calls[0] as any[])[0].prompt).toContain('merged by someone else');
  });

  it('a wake that cannot be queued keeps the row (pendingWake) and the next pass delivers it — the merge result is never lost', async () => {
    const store = memStore();
    seed(store);
    const gh = api({ 'pulls/9': { ...OPEN, state: 'closed' } });
    const failing = jest.fn(async () => ({ ok: false, error: 'db down' }));
    await runHarnessWaitsOnce(deps(store, gh, { wake: failing }));
    const kept = store.rows.get('o/r#9')!;
    expect(kept.pendingWake).toMatchObject({ outcome: 'closed' });
    const ok = jest.fn(async () => ({ ok: true, hookEventId: 'h2' }));
    await runHarnessWaitsOnce(deps(store, gh, { wake: ok, now: new Date(LATER.getTime() + 10 * 60_000) }));
    expect(ok).toHaveBeenCalledTimes(1);
    expect((ok.mock.calls[0] as any[])[0].prompt).toContain('closed without merging');
    expect(store.rows.size).toBe(0);
  });

  it('review fix: a failed outcome wake covers NOTHING (the lane’s pr_merged wait keeps its own backstop); a pending wake to a GONE lane drops, one past its TTL is abandoned', async () => {
    const store = memStore();
    seed(store, { backstopHookEventId: 'bs-1' });
    const failing = jest.fn(async () => ({ ok: false, error: 'db down' }));
    const d = deps(store, api({ 'pulls/9': { ...OPEN, state: 'closed' } }), { wake: failing });
    await runHarnessWaitsOnce(d);
    expect([...((d.conditionPass.mock.calls[0] as any[])[0].covered as Set<string>)]).toEqual([]);
    expect(d.suppress).not.toHaveBeenCalled(); // the backstop stays armed while the outcome is owed
    expect(store.rows.get('o/r#9')!.pendingWake).toMatchObject({ outcome: 'closed', since: LATER.toISOString() });

    const later = new Date(LATER.getTime() + 10 * 60_000);
    const gone = deps(store, api({}), { now: later, loadLane: jest.fn(async () => null) });
    await runHarnessWaitsOnce(gone);
    expect(gone.wake).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
    expect(rows('merge_intent').at(-1)).toMatchObject({ meta: { phase: 'cancelled', why: 'pending_wake_lane_gone' } });

    seed(store, { pendingWake: { prompt: 'owed', outcome: 'closed', since: T0.toISOString() } });
    const old = deps(store, api({}), { now: new Date(T0.getTime() + MERGE_INTENT_PENDING_WAKE_TTL_MS + 60_000) });
    await runHarnessWaitsOnce(old);
    expect(old.wake).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
    expect(rows('merge_intent').at(-1)).toMatchObject({ meta: { phase: 'wake_abandoned', outcome: 'closed' } });
  });

  it('review fix: owed wakes run on their OWN budget — they never crowd a fresh intent out of the pass', async () => {
    const store = memStore();
    for (let n = 1; n <= 3; n++) {
      const r = newIntent({ owner: 'o', repo: 'r', pullNumber: 100 + n, headSha: HEAD, chatId: `lane-${n}`, userId: 'u1', waitKind: 'ci_pending' }, new Date(T0.getTime() - 60_000));
      store.rows.set(r.key, { ...r, pendingWake: { prompt: 'owed', outcome: 'closed' } });
    }
    seed(store);
    const d = deps(store, api({ 'pulls/9': OPEN, 'check-runs': { check_runs: [{ status: 'in_progress' }] } }), { maxPerPass: 1, wake: jest.fn(async () => ({ ok: false })) });
    await runHarnessWaitsOnce(d);
    expect(store.rows.get('o/r#9')).toMatchObject({ checks: 1 }); // the fresh intent was still worked
  });

  it('review fix: a CI DISPATCH GAP gets two passes of grace, then closes BLOCKED with the gate fix (never spins to the TTL)', async () => {
    const store = memStore();
    seed(store);
    const gap = { ok: false, gate: 'ci', cause: 'zero check-runs on the head sha in a repo WITH workflows that run on PR heads — a CI dispatch gap', evidence: 'check-runs=0', suggestedFix: 'push a commit to the PR branch', evidenceHash: 'g', headSha: HEAD, transient: 'ci_pending', dispatchGap: true };
    const gh = api({ 'pulls/9': OPEN, 'check-runs': { check_runs: [] } });
    for (const [i, at] of [[1, LATER], [2, new Date(LATER.getTime() + 3 * 60_000)]] as const) {
      const d = deps(store, gh, { now: at, evaluateGates: jest.fn(async () => gap) });
      await runHarnessWaitsOnce(d);
      expect(d.wake).not.toHaveBeenCalled();
      expect(store.rows.get('o/r#9')).toMatchObject({ dispatchGapPasses: i });
    }
    const d2 = deps(store, gh, { now: new Date(LATER.getTime() + 6 * 60_000), evaluateGates: jest.fn(async () => gap) });
    await runHarnessWaitsOnce(d2);
    const w = (d2.wake.mock.calls[0] as any[])[0].prompt;
    expect(w).toMatch(/^\[MERGE INTENT — BLOCKED o\/r#9\]/);
    expect(w).toContain('dispatch gap');
    expect(w).toContain('fix: push a commit to the PR branch');
    expect(store.rows.size).toBe(0);
  });

  it('review fix: a timing verdict the FULL gates keep returning backs off exponentially (capped) instead of re-gating every 2 min; CI movement resets it', async () => {
    const store = memStore();
    seed(store);
    const pending = { ok: false, gate: 'ci', cause: 'CI still running on the head sha', evidence: 'combined status: pending', suggestedFix: 'wait', evidenceHash: 'p', headSha: HEAD, transient: 'ci_pending' };
    const gh = api({ 'pulls/9': OPEN, 'check-runs': DONE_RUNS });
    let now = LATER;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      await runHarnessWaitsOnce(deps(store, gh, { now, evaluateGates: jest.fn(async () => pending) }));
      const row = store.rows.get('o/r#9')!;
      delays.push(Date.parse(row.nextCheckAt) - now.getTime());
      now = new Date(Date.parse(row.nextCheckAt));
    }
    const base = MERGE_INTENT_INTERVAL_SEC * 1000;
    expect(delays.slice(0, 5)).toEqual([base, 2 * base, 4 * base, 8 * base, MERGE_INTENT_GATE_BACKOFF_MAX_MS]);
    expect(store.rows.get('o/r#9')!.gateTransients).toBe(7);
    // CI starts moving again ⇒ the cheap wait resets the backoff
    await runHarnessWaitsOnce(deps(store, api({ 'pulls/9': OPEN, 'check-runs': { check_runs: [{ status: 'in_progress' }] } }), { now }));
    expect(store.rows.get('o/r#9')!.gateTransients).toBe(0);
  });

  it('a backed-off intent still closes on time: the next check never lands past its expiry', async () => {
    const store = memStore();
    const created = new Date(LATER.getTime() - MERGE_INTENT_TTL_MS + 5 * 60_000); // 5 min left
    seed(store, { createdAt: created.toISOString(), gateTransients: 9 });
    const pending = { ok: false, gate: 'ci', cause: 'CI still running', evidence: 'pending', suggestedFix: 'wait', evidenceHash: 'p', headSha: HEAD, transient: 'ci_pending' };
    await runHarnessWaitsOnce(deps(store, api({ 'pulls/9': OPEN, 'check-runs': DONE_RUNS }), { evaluateGates: jest.fn(async () => pending) }));
    expect(Date.parse(store.rows.get('o/r#9')!.nextCheckAt)).toBeLessThanOrEqual(created.getTime() + MERGE_INTENT_TTL_MS + 1000);
  });

  it('a transient merge-API answer waits; repeated read errors close it unobservable after the max', async () => {
    const store = memStore();
    seed(store);
    const gh = api({ 'pulls/9': OPEN, 'check-runs': DONE_RUNS }, { status: 405, data: { message: 'Merge already in progress' } });
    const d = deps(store, gh);
    await runHarnessWaitsOnce(d);
    expect(d.wake).not.toHaveBeenCalled();
    expect(store.rows.get('o/r#9')).toMatchObject({ waitKind: 'merge_in_progress', lastGate: 'merge_api', mergePutAt: null });

    const store2 = memStore();
    seed(store2, { errors: MERGE_INTENT_MAX_ERRORS - 1 });
    const d2 = deps(store2, api({ 'pulls/9': new Error('socket hang up') }));
    await runHarnessWaitsOnce(d2);
    expect((d2.wake.mock.calls[0] as any[])[0].prompt).toContain('could not read the PR');
  });

  it('the kill switch and SELF_MERGE_DISABLED leave every intent alone (the condition pass still runs)', async () => {
    const store = memStore();
    seed(store);
    process.env.MERGE_INTENT_QUEUE_DISABLED = '1';
    const d = deps(store, api({}));
    expect(await runHarnessWaitsOnce(d)).toMatch(/^intents: disabled; waits 0 open/);
    expect(d.loadLane).not.toHaveBeenCalled();
    expect(d.conditionPass).toHaveBeenCalledTimes(1);
    delete process.env.MERGE_INTENT_QUEUE_DISABLED;
    const d2 = deps(store, api({}), { selfMergeDisabled: () => true });
    expect(await runHarnessWaitsOnce(d2)).toMatch(/^intents: self-merge disabled/);
    expect(store.rows.size).toBe(1);
  });

  it('the pass summary stays ≤ 200 chars', () => {
    const s = renderHarnessWaitsSummary({ open: 999, checked: 999, merged: 999, blocked: 999, waiting: 999, dropped: 999, errors: 999, updateBranch: 999, adopted: 999, rateLimited: 999, skipped: null }, { open: 999, checked: 999, met: 999, waiting: 999, dropped: 999, errors: 999, rateLimited: 0 });
    expect(s.length).toBeLessThanOrEqual(200);
  });
});

// ── r3 interactions fixes (2026-10-20) ─────────────────────────────────────────
// [4] The cron never asks GitHub to update a BEHIND branch whose head is RED
// (or while the lane has a run in flight): a harness merge commit on a red
// head wasted a CI cycle, deferred ci-watch's red wake (the head "moved") and
// got the lane's next plain push rejected non-fast-forward.
// [5] A red-CI outcome wake is booked with ci-watch — ONE wake per red sha per
// lane, and the merge-intent red-fix loop counts toward ci-watch's budget.
describe('r3 interactions — no update-branch on a red head or under a live lane; red outcomes are ONE loop with ci-watch', () => {
  const BEHIND = { ...OPEN, mergeable_state: 'behind' };
  const RED_RUN = { name: 'tests', status: 'completed', conclusion: 'failure', html_url: 'https://ci/1' };

  it('a COMPLETED red check ⇒ BLOCKED gate ci at once (even with another check still running), before the gate engine — no update-branch on a red head; booked with ci-watch', async () => {
    for (const checkRuns of [[RED_RUN, { name: 'e2e', status: 'in_progress', conclusion: null }], [RED_RUN]]) {
      const store = memStore();
      seed(store);
      const gh = api({ 'pulls/9': BEHIND, 'check-runs': { check_runs: checkRuns } });
      const d = deps(store, gh);
      await runHarnessWaitsOnce(d);
      expect(d.evaluateGates).not.toHaveBeenCalled();
      expect(gh.puts).toHaveLength(0);
      const w = (d.wake.mock.calls[0] as any[])[0].prompt;
      expect(w).toContain('gate ci failed on that exact head — CI is RED on the head sha');
      expect(w).toContain('tests: completed/failure https://ci/1');
      expect(d.noteRedWake).toHaveBeenCalledWith({ chatId: 'lane-1', sha: HEAD, branch: 'lane/x', via: 'merge_intent' });
      expect(store.rows.size).toBe(0);
    }
  });

  it('BEHIND with a lane run queued / running ⇒ WAIT: the gates (and their update-branch) never run; once the lane is idle they run with allowUpdateBranch', async () => {
    const store = memStore();
    seed(store);
    const gh = api({ 'pulls/9': BEHIND, 'check-runs': DONE_RUNS, '/status': { state: 'success', statuses: [{ state: 'success' }] } });
    for (const status of ['running', 'queued']) {
      const d = deps(store, gh, { loadLane: jest.fn(async () => lane({ lastRun: { id: 'run-2', status, error: null, at: LATER } })) });
      await runHarnessWaitsOnce(d);
      expect(d.evaluateGates).not.toHaveBeenCalled();
      expect(d.wake).not.toHaveBeenCalled();
      expect(store.rows.get('o/r#9')).toMatchObject({ lastGate: 'pr_state', lastCause: expect.stringContaining('held while the lane has a run') });
      store.rows.set('o/r#9', { ...store.rows.get('o/r#9')!, nextCheckAt: LATER.toISOString() });
    }
    const idle = deps(store, gh);
    await runHarnessWaitsOnce(idle);
    expect(idle.evaluateGates).toHaveBeenCalledWith(expect.objectContaining({ allowUpdateBranch: true }));
  });

  it('BEHIND with a RED legacy status ⇒ BLOCKED gate ci, no gate run; an unreadable status, or a PR this read did not see behind, holds the update (allowUpdateBranch false)', async () => {
    const store = memStore();
    seed(store);
    const d = deps(store, api({ 'pulls/9': BEHIND, 'check-runs': DONE_RUNS, '/status': { state: 'failure', statuses: [{ state: 'failure', context: 'vercel' }] } }));
    await runHarnessWaitsOnce(d);
    expect(d.evaluateGates).not.toHaveBeenCalled();
    expect((d.wake.mock.calls[0] as any[])[0].prompt).toContain('evidence: combined status: failure');
    expect(d.noteRedWake).toHaveBeenCalledTimes(1);

    for (const routes of [{ 'pulls/9': BEHIND, 'check-runs': DONE_RUNS, '/status': new Error('boom') }, { 'pulls/9': OPEN, 'check-runs': DONE_RUNS }]) {
      const s2 = memStore();
      seed(s2);
      const d2 = deps(s2, api(routes as any));
      await runHarnessWaitsOnce(d2);
      expect(d2.evaluateGates).toHaveBeenCalledWith(expect.objectContaining({ allowUpdateBranch: false }));
    }
  });

  it('SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED=1: no BEHIND pre-checks (the gates refuse BEHIND as before) — a live lane does not hold the gate run', async () => {
    process.env.SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED = '1';
    try {
      const store = memStore();
      seed(store);
      const d = deps(store, api({ 'pulls/9': BEHIND, 'check-runs': DONE_RUNS }), { loadLane: jest.fn(async () => lane({ lastRun: { id: 'run-2', status: 'running', error: null, at: LATER } })) });
      await runHarnessWaitsOnce(d);
      expect(d.evaluateGates).toHaveBeenCalledWith(expect.objectContaining({ allowUpdateBranch: false }));
    } finally {
      delete process.env.SELF_MERGE_AUTO_UPDATE_BRANCH_DISABLED;
    }
  });

  // r3 lane-merge review fix: the backstop stands down too — left armed, its
  // "[MERGE INTENT — BACKSTOP …] merge_pull_request again" wake fired on the
  // lane at the horizon and re-entered the loop ci-watch had handed to the
  // supervisor ('loop' needs a sha ci-watch still watches, so it escalates).
  it('the lane’s ci-watch red-fix loop budget spent ("loop") ⇒ NO lane wake: the intent closes, its backstop is suppressed, loop_handoff; nothing is covered', async () => {
    const store = memStore();
    seed(store, { backstopHookEventId: 'bs-1' });
    const d = deps(store, api({ 'pulls/9': OPEN, 'check-runs': { check_runs: [RED_RUN] } }), { noteRedWake: jest.fn(async () => 'loop') });
    await runHarnessWaitsOnce(d);
    expect(d.wake).not.toHaveBeenCalled();
    expect(d.suppress).toHaveBeenCalledTimes(1);
    expect(d.suppress).toHaveBeenCalledWith('bs-1', 'merge_intent_loop_handoff');
    expect(store.rows.size).toBe(0);
    expect(phases()).toContain('loop_handoff');
    expect(rows('merge_gate_failure')[0]).toMatchObject({ meta: { gate: 'ci', via: 'merge_intent' } });
    expect([...((d.conditionPass.mock.calls[0] as any[])[0].covered as Set<string>)]).toEqual([]);
    expect((d.conditionPass.mock.calls[0] as any[])[0].noteRedWake).toBe(d.noteRedWake);
  });

  it('only a RED verdict is booked: the gates’ CI-is-RED verdict is; a conflict is not', async () => {
    const store = memStore();
    seed(store);
    const red = deps(store, api({ 'pulls/9': OPEN, 'check-runs': DONE_RUNS }), {
      evaluateGates: jest.fn(async () => ({ ok: false, gate: 'ci', cause: 'CI is RED on the head sha', evidence: 'combined status: failure', suggestedFix: 'fix', evidenceHash: 'h', headSha: HEAD })),
    });
    await runHarnessWaitsOnce(red);
    expect(red.noteRedWake).toHaveBeenCalledTimes(1);

    const s2 = memStore();
    seed(s2);
    const conflict = deps(s2, api({ 'pulls/9': OPEN, 'check-runs': DONE_RUNS }), {
      evaluateGates: jest.fn(async () => ({ ok: false, gate: 'pr_state', cause: 'PR not mergeable (mergeable=false, state=dirty)', evidence: 'dirty', suggestedFix: 'rebase', evidenceHash: 'h', headSha: HEAD })),
    });
    await runHarnessWaitsOnce(conflict);
    expect(conflict.noteRedWake).not.toHaveBeenCalled();
    expect(conflict.wake).toHaveBeenCalledTimes(1);
  });
});

describe('harnessWaitCoversSha — what ci-watch defers to', () => {
  const condStore = (rows: Array<Partial<ConditionWakeRecord>>): ConditionWakeStore => ({
    get: async () => null, put: async () => {}, del: async () => {}, list: async () => rows as ConditionWakeRecord[],
  });

  it('an open intent of the lane on the sha (abbreviated too) or a registered ci wait covers it; another lane / sha / a pr_merged wait does not; each switch uncovers its half; a read error ⇒ false', async () => {
    const store = memStore();
    seed(store);
    const conditionStore = condStore([
      { chatId: 'lane-2', spec: { kind: 'ci', owner: 'o', repo: 'r', sha: NEW.slice(0, 10) } },
      { chatId: 'lane-3', spec: { kind: 'pr_merged', owner: 'o', repo: 'r', pullNumber: 9 } },
    ]);
    const d = { store, conditionStore, selfMergeDisabled: () => false };
    expect(await harnessWaitCoversSha('lane-1', HEAD, d)).toBe(true);
    expect(await harnessWaitCoversSha('lane-1', HEAD.slice(0, 12), d)).toBe(true);
    expect(await harnessWaitCoversSha('lane-9', HEAD, d)).toBe(false);
    expect(await harnessWaitCoversSha('lane-1', NEW, d)).toBe(false);
    expect(await harnessWaitCoversSha('lane-2', NEW, d)).toBe(true);
    expect(await harnessWaitCoversSha('lane-3', HEAD, d)).toBe(false);
    expect(await harnessWaitCoversSha('lane-1', HEAD, { ...d, selfMergeDisabled: () => true })).toBe(false);
    process.env.MERGE_INTENT_QUEUE_DISABLED = '1';
    expect(await harnessWaitCoversSha('lane-1', HEAD, d)).toBe(false);
    expect(await harnessWaitCoversSha('lane-2', NEW, d)).toBe(true);
    delete process.env.MERGE_INTENT_QUEUE_DISABLED;
    process.env.AWAIT_CONDITION_DISABLED = '1';
    expect(await harnessWaitCoversSha('lane-2', NEW, d)).toBe(false);
    delete process.env.AWAIT_CONDITION_DISABLED;
    expect(await harnessWaitCoversSha('lane-1', HEAD, { ...d, store: { ...store, list: async () => { throw new Error('db down'); } } })).toBe(false);
  });
});
