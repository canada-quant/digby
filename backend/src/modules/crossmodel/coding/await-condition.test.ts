/**
 * MERGE-INTENT-AWAIT (2026-10-20) — the await_condition tool and its condition
 * wakes (await-condition.ts). Pins:
 *   - a condition met inside the window returns the verdict at once (the wait
 *     is reported to ctx.onShieldedWait — deadline-shielded);
 *   - NOT met in time ⇒ a backstop one-shot is enqueued FIRST (notBefore = the
 *     horizon), the wake row stored, ctx.requestEndTurn called (the run ends);
 *   - a failed backstop stores nothing and never ends the run;
 *   - the cron pass wakes the lane once when met and suppresses the backstop;
 *     a stopped / archived lane drops the wait (backstop suppressed, no wake);
 *     past the horizon the row is dropped and the backstop delivers itself;
 *     a merge-intent wake covers a pr_merged wait;
 *   - the kill switch refuses the tool.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockHookFindUnique: jest.Mock = jest.fn();
const mockHookUpdateMany: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { hookEvent: { findUnique: (...a: any[]) => mockHookFindUnique(...a), updateMany: (...a: any[]) => mockHookUpdateMany(...a) } },
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { AWAIT_CONDITION: 'await_condition', CI_WATCH: 'ci_watch' },
}));

import {
  executeAwaitCondition, parseConditionArgs, evaluateCiProbe, evaluatePrProbe, evaluateDeployProbe, runConditionWakesPass, probeCondition,
  suppressBackstop, conditionWakeKey, resolveShaFull, AWAIT_CONDITION_NONE_GRACE_MS, CONDITION_WAKE_HORIZON_MS,
  type ConditionWakeStore, type ConditionWakeRecord, type LaneFacts,
} from './await-condition';
import type { CiStatus } from './ci-status';

const SHA = 'a'.repeat(40);
const render = (sha: string, ci: CiStatus) => `CI for ${sha.slice(0, 12)}: ${ci.state.toUpperCase()}`;
const ci = (state: CiStatus['state']): CiStatus => ({ state, checks: [], failing: state === 'failure' ? ['tests'] : [], total: state === 'none' ? 0 : 1 });

function memStore(): ConditionWakeStore & { rows: Map<string, ConditionWakeRecord> } {
  const rows = new Map<string, ConditionWakeRecord>();
  return {
    rows,
    get: async (k) => rows.get(k) ?? null,
    put: async (k, r) => { rows.set(k, JSON.parse(JSON.stringify(r))); },
    del: async (k) => { rows.delete(k); },
    list: async () => [...rows.values()],
  };
}

/** A fake clock: sleep advances it, never waits. */
function clock(t0 = 1_000_000) {
  let t = t0;
  return { now: () => t, sleep: jest.fn(async (ms: number) => { t += ms; }) };
}

const ctx = (over: Record<string, any> = {}) => ({
  sessionId: 'lane-1', userId: 'u1', runId: 'run-1', repoUrl: 'https://github.com/o/r', provider: 'github',
  getGithubToken: async () => 'tok', onShieldedWait: jest.fn(), requestEndTurn: jest.fn(), ...over,
});

beforeEach(() => {
  mockRecordLoopMetric.mockClear();
  mockHookFindUnique.mockReset();
  mockHookUpdateMany.mockReset();
  delete process.env.AWAIT_CONDITION_DISABLED;
});

describe('parse + evaluate (pure)', () => {
  it('parses the three conditions, defaults the repo and clamps timeoutSec to 0..600', () => {
    expect(parseConditionArgs({ condition: 'ci', sha: SHA }, { owner: 'o', repo: 'r' })).toEqual({ ok: true, spec: { kind: 'ci', owner: 'o', repo: 'r', sha: SHA }, timeoutSec: 600 });
    expect(parseConditionArgs({ condition: 'pr_merged', pullNumber: 4, repo: 'x/y', timeoutSec: 9999 }, null)).toEqual({ ok: true, spec: { kind: 'pr_merged', owner: 'x', repo: 'y', pullNumber: 4 }, timeoutSec: 600 });
    expect(parseConditionArgs({ condition: 'deploy', sha: SHA, timeoutSec: -3 }, { owner: 'o', repo: 'r' })).toMatchObject({ ok: true, timeoutSec: 0 });
    expect(parseConditionArgs({ condition: 'sleep' }, null)).toMatchObject({ ok: false });
    expect(parseConditionArgs({ condition: 'ci' }, { owner: 'o', repo: 'r' })).toMatchObject({ ok: false, error: expect.stringContaining('needs sha') });
    expect(parseConditionArgs({ condition: 'pr_merged' }, { owner: 'o', repo: 'r' })).toMatchObject({ ok: false, error: expect.stringContaining('pullNumber') });
    expect(parseConditionArgs({ condition: 'ci', sha: SHA }, null)).toMatchObject({ ok: false, error: expect.stringContaining('No GitHub repo') });
  });

  it('ci: success / failure meet it; pending never; no checks only after the grace', () => {
    expect(evaluateCiProbe(ci('success'), 0, render, SHA).met).toBe(true);
    expect(evaluateCiProbe(ci('failure'), 0, render, SHA).met).toBe(true);
    expect(evaluateCiProbe(ci('pending'), 10 * 60_000, render, SHA).met).toBe(false);
    expect(evaluateCiProbe(ci('none'), AWAIT_CONDITION_NONE_GRACE_MS - 1, render, SHA).met).toBe(false);
    expect(evaluateCiProbe(ci('none'), AWAIT_CONDITION_NONE_GRACE_MS, render, SHA).met).toBe(true);
  });

  it('pr_merged: merged or closed meet it; open does not', () => {
    const spec = { kind: 'pr_merged' as const, owner: 'o', repo: 'r', pullNumber: 4 };
    expect(evaluatePrProbe({ merged: true, merge_commit_sha: SHA }, spec)).toMatchObject({ met: true, summary: expect.stringContaining('MERGED') });
    expect(evaluatePrProbe({ state: 'closed', merged: false }, spec)).toMatchObject({ met: true, summary: expect.stringContaining('CLOSED') });
    expect(evaluatePrProbe({ state: 'open', head: { sha: SHA }, mergeable_state: 'blocked' }, spec).met).toBe(false);
  });

  it('deploy: no deploy run yet / one still running ⇒ not met; concluded ⇒ met with THAT run’s conclusion (a re-dispatch of the same workflow replaces it)', () => {
    const spec = { kind: 'deploy' as const, owner: 'o', repo: 'r', sha: SHA };
    expect(evaluateDeployProbe([{ path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success' }], spec).met).toBe(false);
    expect(evaluateDeployProbe([{ id: 1, path: '.github/workflows/deploy.yml', event: 'push', status: 'in_progress' }], spec)).toMatchObject({ met: false, summary: expect.stringContaining('in_progress') });
    const done = evaluateDeployProbe([
      { id: 1, workflow_id: 7, path: '.github/workflows/deploy.yml', event: 'push', status: 'completed', conclusion: 'failure', created_at: '2026-10-20T10:00:00Z' },
      { id: 2, workflow_id: 7, path: '.github/workflows/deploy.yml', event: 'workflow_dispatch', status: 'completed', conclusion: 'success', created_at: '2026-10-20T11:00:00Z', html_url: 'https://x/2' },
    ], spec);
    expect(done).toMatchObject({ met: true });
    expect(done.summary).toContain('CONCLUDED SUCCESS (run 2 https://x/2)');
  });

  it('deploy (review fix): a FAILED deploy.yml followed by a successful "Deployment Health Check" / "Deploy Watchdog" on the same sha reads FAILURE — scheduled / workflow_run runs are never the deploy', () => {
    const spec = { kind: 'deploy' as const, owner: 'canada-quant', repo: 'digby', sha: SHA };
    const runs = [
      // newest first, as the API lists them
      { id: 30, workflow_id: 9, name: 'Deploy Watchdog', path: '.github/workflows/deploy-watchdog.yml', event: 'schedule', status: 'completed', conclusion: 'success', created_at: '2026-10-20T11:20:00Z' },
      { id: 20, workflow_id: 8, name: 'Deployment Health Check', path: '.github/workflows/deploy-healthcheck.yml', event: 'workflow_run', status: 'completed', conclusion: 'success', created_at: '2026-10-20T11:10:00Z' },
      { id: 10, workflow_id: 7, name: 'Deploy to AWS EC2', path: '.github/workflows/deploy.yml', event: 'push', status: 'completed', conclusion: 'failure', created_at: '2026-10-20T10:40:00Z', html_url: 'https://x/10' },
    ];
    for (const own of ['canada-quant/digby', null]) {
      const v = evaluateDeployProbe(runs, spec, { ownRepoSlug: own });
      expect(v.met).toBe(true);
      expect(v.summary).toContain('CONCLUDED FAILURE (run 10 https://x/10)');
      expect(v.summary).toContain('NOT live');
      expect(v.summary).not.toContain('SUCCESS');
    }
    // A health check still running AFTER the deploy concluded never holds the verdict either.
    expect(evaluateDeployProbe([{ ...runs[1], status: 'in_progress', conclusion: null }, runs[2]], spec, { ownRepoSlug: 'canada-quant/digby' }).met).toBe(true);
    // Own repo: only deploy.yml counts — a push-triggered "deploy-docs.yml" is not THE deploy.
    expect(evaluateDeployProbe([{ id: 5, path: '.github/workflows/deploy-docs.yml', event: 'push', status: 'completed', conclusion: 'success' }], spec, { ownRepoSlug: 'canada-quant/digby' }).met).toBe(false);
  });

  it('deploy (review fix): a CANCELLED (superseded) deploy is named as NOT a deploy of the sha, never "concluded"; two deploy workflows ⇒ the worst one', () => {
    const spec = { kind: 'deploy' as const, owner: 'o', repo: 'r', sha: SHA };
    const cancelled = evaluateDeployProbe([{ id: 4, path: '.github/workflows/deploy.yml', event: 'push', status: 'completed', conclusion: 'cancelled' }], spec);
    expect(cancelled.met).toBe(true);
    expect(cancelled.summary).toMatch(/was CANCELLED — NOT a completed deploy of this sha/);
    expect(cancelled.summary).not.toContain('CONCLUDED');
    const two = evaluateDeployProbe([
      { id: 1, workflow_id: 1, name: 'Deploy app', path: '.github/workflows/deploy-app.yml', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-10-20T11:00:00Z' },
      { id: 2, workflow_id: 2, name: 'Deploy docs', path: '.github/workflows/deploy-docs.yml', event: 'push', status: 'completed', conclusion: 'failure', created_at: '2026-10-20T10:00:00Z' },
    ], spec);
    expect(two.summary).toContain('CONCLUDED FAILURE (run 2; per workflow: Deploy app success, Deploy docs failure)');
  });

  it('deploy probe: the instance’s own repo reads deploy.yml’s own runs; another repo the repo-wide listing', async () => {
    const urls: string[] = [];
    const ghGet = async (_t: string, url: string) => { urls.push(url); return { workflow_runs: [] }; };
    await probeCondition({ kind: 'deploy', owner: 'canada-quant', repo: 'digby', sha: SHA }, 'tok', 0, { ghGet, ownRepoSlug: () => 'canada-quant/digby' });
    await probeCondition({ kind: 'deploy', owner: 'o', repo: 'r', sha: SHA }, 'tok', 0, { ghGet, ownRepoSlug: () => 'canada-quant/digby' });
    expect(urls[0]).toBe(`https://api.github.com/repos/canada-quant/digby/actions/workflows/deploy.yml/runs?head_sha=${SHA}&per_page=30`);
    expect(urls[1]).toBe(`https://api.github.com/repos/o/r/actions/runs?head_sha=${SHA}&per_page=100`);
  });

  // ── ticket 0bc39100: a SHORT sha must resolve before head_sha (exact-40 filter) ──

  it('resolveShaFull: a 40-hex sha passes through with NO GET; a short sha resolves via /commits/{sha} and memoizes (one GET ever)', async () => {
    const urls: string[] = [];
    const ghGet = jest.fn(async (_t: string, url: string) => {
      urls.push(url);
      if (url.includes('/commits/')) return { sha: SHA }; // the resolution GET
      return { workflow_runs: [] };
    });
    // full sha: no network at all
    expect(await resolveShaFull('tok', 'o', 'r', SHA, { ghGet, cache: { map: new Map() } })).toBe(SHA);
    expect(ghGet).not.toHaveBeenCalled();
    // short sha: resolved once, then served from the cache
    const cache = { map: new Map<string, string>() };
    expect(await resolveShaFull('tok', 'o', 'r', 'aaaaaaaaaa', { ghGet, cache })).toBe(SHA);
    expect(await resolveShaFull('tok', 'O', 'R', 'AAAAAAAAAA', { ghGet, cache })).toBe(SHA); // case+slug-insensitive hit
    expect(urls).toEqual(['https://api.github.com/repos/o/r/commits/aaaaaaaaaa']);
    // a resolution that answers no sha is an error (not a silent pass-through)
    await expect(resolveShaFull('tok', 'o', 'r', 'bbbbbbbbbb', { ghGet: async () => ({}), cache })).rejects.toThrow(/did not resolve/);
    await expect(resolveShaFull('tok', 'o', 'r', 'zzz', { ghGet, cache })).rejects.toThrow(/invalid sha/);
  });

  it('resolveShaFull: the cache is bounded (oldest entry evicted at 500)', async () => {
    // The mock echoes a FULL sha that starts with the requested short one
    // (resolveShaFull rejects a resolution that changes the prefix).
    const ghGet = jest.fn(async (_t: string, _url: string) => {
      const short = decodeURIComponent(_url.split('/commits/')[1] ?? '');
      return { sha: short + 'c'.repeat(40 - short.length) };
    });
    const cache = { map: new Map<string, string>() };
    for (let i = 0; i < 500; i++) await resolveShaFull('tok', 'o', 'r', i.toString(16).padStart(10, '0'), { ghGet, cache });
    expect(cache.map.size).toBe(500);
    await resolveShaFull('tok', 'o', 'r', 'abcabcdef', { ghGet, cache });
    expect(cache.map.size).toBe(500); // evicted the oldest, still capped
    expect(cache.map.has('o/r@abcabcdef')).toBe(true);
  });

  it('resolveShaFull: a resolution that does NOT start with the requested prefix is rejected (a hex-named ref must not shadow the sha)', async () => {
    const cache = { map: new Map<string, string>() };
    await expect(resolveShaFull('tok', 'o', 'r', 'abcabcdef', { ghGet: async () => ({ sha: 'f'.repeat(40) }), cache })).rejects.toThrow(/does not start with/);
    expect(cache.map.size).toBe(0); // never cached a bad resolution
  });

  it('0bc39100 replay: a SHORT deploy sha resolves to full before head_sha — both the own-repo and repo-wide listings (the miss that froze 4/4 lanes)', async () => {
    const urls: string[] = [];
    const ghGet = async (_t: string, url: string) => {
      urls.push(url);
      if (url.endsWith('/commits/adb0875d')) return { sha: 'adb0875d637ab119a625f02421e287ab10bdf172' };
      return { workflow_runs: [{ id: 39530651845, name: 'Deploy to AWS EC2', path: '.github/workflows/deploy.yml', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-10-21T02:01:19Z' }] };
    };
    const p = await probeCondition({ kind: 'deploy', owner: 'canada-quant', repo: 'digby', sha: 'adb0875d' }, 'tok', 0, { ghGet, ownRepoSlug: () => 'canada-quant/digby' });
    expect(p.met).toBe(true);
    expect(p.summary).toContain('CONCLUDED SUCCESS (run 39530651845)');
    // resolution GET first, then the deploy.yml listing with the FULL sha
    expect(urls[0]).toBe('https://api.github.com/repos/canada-quant/digby/commits/adb0875d');
    expect(urls[1]).toBe('https://api.github.com/repos/canada-quant/digby/actions/workflows/deploy.yml/runs?head_sha=adb0875d637ab119a625f02421e287ab10bdf172&per_page=30');
    // a short sha that resolves to NOTHING is an honest not_found, never an empty-run not-met
    const gone = await probeCondition({ kind: 'deploy', owner: 'o', repo: 'r', sha: 'deadbeef' }, 'tok', 0, {
      ghGet: async (_t, url) => { if (url.includes('/commits/')) { throw Object.assign(new Error('404'), { response: { status: 404 } }); } return { workflow_runs: [] }; },
    }).catch((e: any) => e);
    expect(gone).toBeInstanceOf(Error);
    expect(String((gone as any)?.response?.status ?? '')).toBe('404');
  });
});

describe('executeAwaitCondition — the tool', () => {
  it('met inside the window ⇒ the verdict at once; the slept time is reported deadline-shielded; nothing registered', async () => {
    const c = clock();
    const fetchCiStatus = jest.fn().mockResolvedValueOnce(ci('pending')).mockResolvedValueOnce(ci('success'));
    const store = memStore();
    const wake = jest.fn();
    const cx = ctx();
    const out = await executeAwaitCondition(cx, { condition: 'ci', sha: SHA }, { ...c, fetchCiStatus, renderCiStatus: render, store, wake });
    expect(out).toMatch(/^CONDITION MET \(CI on o\/r@aaaaaaaaaaaa finished; waited 20s/);
    expect(out).toContain('CI for aaaaaaaaaaaa: SUCCESS');
    expect(cx.onShieldedWait).toHaveBeenCalledWith(20_000);
    expect(cx.requestEndTurn).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
    expect(store.rows.size).toBe(0);
    expect(mockRecordLoopMetric.mock.calls[0][0]).toMatchObject({ kind: 'await_condition', meta: { phase: 'met_in_tool', condition: 'ci', polls: 2 } });
  });

  it('NOT met in time ⇒ backstop one-shot FIRST (notBefore = horizon), the wake stored, the run asked to END', async () => {
    const c = clock();
    const fetchCiStatus = jest.fn(async () => ci('pending'));
    const store = memStore();
    const wake = jest.fn(async () => ({ ok: true, hookEventId: 'backstop-1' }));
    const cx = ctx();
    const out = await executeAwaitCondition(cx, { condition: 'ci', sha: SHA, timeoutSec: 60 }, { ...c, fetchCiStatus, renderCiStatus: render, store, wake });
    expect(out).toMatch(/^CONDITION NOT MET after 60s/);
    expect(out).toContain('Registered a CONDITION WAKE');
    expect(fetchCiStatus).toHaveBeenCalledTimes(4); // t=0, 20, 40, 60
    expect(wake).toHaveBeenCalledTimes(1);
    const b = (wake.mock.calls[0] as any[])[0];
    expect(b.targetChatId).toBe('lane-1');
    expect(b.prompt).toMatch(/^\[CONDITION WAIT — BACKSTOP\]/);
    expect(b.meta).toMatchObject({ origin: 'await-condition', wakeKind: 'condition_backstop' });
    expect(b.notBefore).toBeInstanceOf(Date);
    const key = conditionWakeKey('lane-1', { kind: 'ci', owner: 'o', repo: 'r', sha: SHA });
    expect(store.rows.get(key)).toMatchObject({ chatId: 'lane-1', backstopHookEventId: 'backstop-1', spec: { kind: 'ci', sha: SHA } });
    expect(Date.parse(store.rows.get(key)!.horizonAt) - Date.parse(store.rows.get(key)!.createdAt)).toBe(CONDITION_WAKE_HORIZON_MS.ci);
    expect(cx.requestEndTurn).toHaveBeenCalledTimes(1);
    expect((cx.requestEndTurn as jest.Mock).mock.calls[0][0]).toMatch(/^\[HARNESS — WAITING ON A CONDITION\]/);
  });

  it('a backstop that cannot be queued stores nothing and never ends the run (fail toward delivery)', async () => {
    const c = clock();
    const store = memStore();
    const cx = ctx();
    const out = await executeAwaitCondition(cx, { condition: 'ci', sha: SHA, timeoutSec: 0 }, { ...c, fetchCiStatus: async () => ci('pending'), renderCiStatus: render, store, wake: async () => ({ ok: false, error: 'db' }) });
    expect(out).toContain('could not register a wake');
    expect(store.rows.size).toBe(0);
    expect(cx.requestEndTurn).not.toHaveBeenCalled();
  });

  it('a 404 ends the wait honestly (nothing registered); no token / the kill switch refuse', async () => {
    const c = clock();
    const err = Object.assign(new Error('nope'), { response: { status: 404, headers: {} } });
    const cx = ctx();
    const out = await executeAwaitCondition(cx, { condition: 'pr_merged', pullNumber: 3 }, { ...c, ghGet: async () => { throw err; }, store: memStore(), wake: jest.fn() });
    expect(out).toContain('GitHub answered 404');
    expect(cx.requestEndTurn).not.toHaveBeenCalled();
    expect(await executeAwaitCondition(ctx({ getGithubToken: async () => null }), { condition: 'ci', sha: SHA })).toContain('No connected GitHub account');
    process.env.AWAIT_CONDITION_DISABLED = '1';
    expect(await executeAwaitCondition(ctx(), { condition: 'ci', sha: SHA })).toMatch(/^await_condition is disabled/);
  });
});

describe('runConditionWakesPass — the cron half', () => {
  const T0 = new Date('2026-10-20T12:00:00Z');
  const lane = (over: Partial<LaneFacts> = {}): LaneFacts => ({ userId: 'u1', archived: false, githubLabel: null, lastRun: { status: 'completed', error: null, at: T0 }, ...over });
  const seed = (store: ReturnType<typeof memStore>, over: Partial<ConditionWakeRecord> = {}) => {
    const spec = { kind: 'ci' as const, owner: 'o', repo: 'r', sha: SHA };
    const rec: ConditionWakeRecord = {
      v: 1, key: conditionWakeKey('lane-1', spec), chatId: 'lane-1', userId: 'u1', runId: 'run-1', spec,
      createdAt: T0.toISOString(), horizonAt: new Date(T0.getTime() + CONDITION_WAKE_HORIZON_MS.ci).toISOString(),
      nextCheckAt: T0.toISOString(), checks: 0, errors: 0, backstopHookEventId: 'backstop-1', lastSummary: null, ...over,
    };
    store.rows.set(rec.key, rec);
    return rec;
  };
  const NOW = new Date(T0.getTime() + 5 * 60_000);

  it('met ⇒ ONE wake on the lane, the backstop suppressed, the row gone; not met ⇒ re-scheduled', async () => {
    const store = memStore();
    seed(store);
    const wake = jest.fn(async () => ({ ok: true, hookEventId: 'met-1' }));
    const suppress = jest.fn(async () => true);
    const c = await runConditionWakesPass({ now: NOW, store, wake, suppress, loadLane: async () => lane(), getToken: async () => 'tok', fetchCiStatus: async () => ci('success'), renderCiStatus: render });
    expect(c).toMatchObject({ open: 1, checked: 1, met: 1, dropped: 0 });
    expect((wake.mock.calls[0] as any[])[0].prompt).toMatch(/^\[CONDITION MET — CI on o\/r@aaaaaaaaaaaa finished\] CI for aaaaaaaaaaaa: SUCCESS/);
    expect(suppress).toHaveBeenCalledWith('backstop-1', 'condition_met');
    expect(store.rows.size).toBe(0);

    const store2 = memStore();
    seed(store2);
    const c2 = await runConditionWakesPass({ now: NOW, store: store2, wake, suppress, loadLane: async () => lane(), getToken: async () => 'tok', fetchCiStatus: async () => ci('pending'), renderCiStatus: render });
    expect(c2).toMatchObject({ waiting: 1, met: 0 });
    expect(store2.rows.values().next().value!.checks).toBe(1);
  });

  // ── ticket 0bc39100: the deployed miss, replayed end-to-end (lane 46ecec8d parked on deploy@adb0875d — a 12-hex sha — and probed not-met 87 times until the 3h backstop) ──
  it('0bc39100 replay: a registered deploy wait on a SHORT sha MEETS once the deploy run concluded — ONE wake, backstop suppressed, row gone; a resolution failure keeps the row (errors+1), never drops it', async () => {
    const store = memStore();
    const spec = { kind: 'deploy' as const, owner: 'canada-quant', repo: 'digby', sha: 'adb0875d' };
    const rec: ConditionWakeRecord = {
      v: 1, key: conditionWakeKey('lane-1', spec), chatId: 'lane-1', userId: 'u1', runId: 'run-1', spec,
      createdAt: T0.toISOString(), horizonAt: new Date(T0.getTime() + CONDITION_WAKE_HORIZON_MS.deploy).toISOString(),
      nextCheckAt: T0.toISOString(), checks: 87, errors: 0, backstopHookEventId: 'backstop-1', lastSummary: 'No deploy workflow run exists for adb0875d yet.',
    };
    store.rows.set(rec.key, rec);
    const wake = jest.fn(async () => ({ ok: true, hookEventId: 'met-1' }));
    const suppress = jest.fn(async () => true);
    const ghGet = async (_t: string, url: string) => {
      if (url.endsWith('/commits/adb0875d')) return { sha: 'adb0875d637ab119a625f02421e287ab10bdf172' };
      return { workflow_runs: [{ id: 39530651845, workflow_id: 7, name: 'Deploy to AWS EC2', path: '.github/workflows/deploy.yml', event: 'push', status: 'completed', conclusion: 'success', created_at: '2026-10-21T02:01:19Z' }] };
    };
    const c = await runConditionWakesPass({ now: NOW, store, wake, suppress, loadLane: async () => lane(), getToken: async () => 'tok', ghGet, ownRepoSlug: () => 'canada-quant/digby' });
    expect(c).toMatchObject({ open: 1, checked: 1, met: 1, dropped: 0, errors: 0 });
    expect(wake).toHaveBeenCalledTimes(1);
    expect((wake.mock.calls[0] as any[])[0].prompt).toMatch(/^\[CONDITION MET — deploy of canada-quant\/digby@adb0875d concluded\] Deploy for adb0875d CONCLUDED SUCCESS \(run 39530651845/);
    expect(suppress).toHaveBeenCalledWith('backstop-1', 'condition_met');
    expect(store.rows.size).toBe(0);

    // the resolution GET itself failing (network / 5xx) is a RETRY (row kept,
    // errors+1, backstop intact) — never a drop, never a false not-met. A FRESH
    // short sha (not yet cached) so the failing GET is the resolution itself.
    const spec2 = { ...spec, sha: '534c2f58' };
    const rec2: ConditionWakeRecord = { ...rec, key: conditionWakeKey('lane-2', spec2), chatId: 'lane-2', spec: spec2, checks: 0, lastSummary: null };
    const store2 = memStore();
    store2.rows.set(rec2.key, rec2);
    const failing = async () => { throw Object.assign(new Error('socket hang up'), { response: { status: 502 } }); };
    const c2 = await runConditionWakesPass({ now: NOW, store: store2, wake, suppress, loadLane: async () => lane(), getToken: async () => 'tok', ghGet: failing, ownRepoSlug: () => 'canada-quant/digby' });
    expect(c2).toMatchObject({ open: 1, checked: 1, met: 0, errors: 1 });
    expect(store2.rows.size).toBe(1);
    expect(store2.rows.values().next().value!.errors).toBe(1);
    expect(wake).toHaveBeenCalledTimes(1); // no second wake
  });

  it('a lane stopped after the wait / archived ⇒ dropped, backstop suppressed, NO wake; past the horizon ⇒ dropped, backstop left to deliver; a merge-intent wake covers it', async () => {
    for (const [l, why] of [[lane({ lastRun: { status: 'cancelled', error: 'stopped by owner', at: NOW } }), 'lane_stopped'], [lane({ archived: true }), 'lane_archived']] as const) {
      const store = memStore();
      seed(store);
      const wake = jest.fn();
      const suppress = jest.fn(async () => true);
      await runConditionWakesPass({ now: NOW, store, wake: wake as any, suppress, loadLane: async () => l, getToken: async () => 'tok', fetchCiStatus: async () => ci('success'), renderCiStatus: render });
      expect(wake).not.toHaveBeenCalled();
      expect(suppress).toHaveBeenCalledWith('backstop-1', why);
      expect(store.rows.size).toBe(0);
    }
    const store = memStore();
    seed(store);
    const suppress = jest.fn(async () => true);
    await runConditionWakesPass({ now: new Date(T0.getTime() + CONDITION_WAKE_HORIZON_MS.ci + 1), store, suppress, wake: jest.fn() as any, loadLane: async () => lane(), getToken: async () => 'tok' });
    expect(suppress).not.toHaveBeenCalled(); // the backstop is the delivery now
    expect(store.rows.size).toBe(0);

    const store3 = memStore();
    const rec = seed(store3, { nextCheckAt: new Date(NOW.getTime() + 60_000).toISOString() }); // not even due
    const suppress3 = jest.fn(async () => true);
    await runConditionWakesPass({ now: NOW, store: store3, suppress: suppress3, wake: jest.fn() as any, loadLane: async () => lane(), getToken: async () => 'tok', covered: new Set([rec.key]) });
    expect(suppress3).toHaveBeenCalledWith('backstop-1', 'covered_by_merge_intent');
    expect(store3.rows.size).toBe(0);
  });

  it('the kill switch leaves registered waits alone (their backstops still deliver)', async () => {
    const store = memStore();
    seed(store);
    process.env.AWAIT_CONDITION_DISABLED = '1';
    const c = await runConditionWakesPass({ now: NOW, store, loadLane: async () => lane(), getToken: async () => 'tok' });
    expect(c.open).toBe(0);
    expect(store.rows.size).toBe(1);
  });
});

describe('suppressBackstop', () => {
  it('suppresses only a still-PENDING row (status delivered + suppressedAtDelivery), never throws', async () => {
    mockHookFindUnique.mockResolvedValueOnce({ status: 'pending', payload: { summary: 's' } });
    mockHookUpdateMany.mockResolvedValueOnce({ count: 1 });
    expect(await suppressBackstop('h1', 'condition_met')).toBe(true);
    expect(mockHookUpdateMany).toHaveBeenCalledWith({ where: { id: 'h1', status: 'pending' }, data: { status: 'delivered', payload: { summary: 's', suppressedAtDelivery: 'condition_met' } } });
    mockHookFindUnique.mockResolvedValueOnce({ status: 'delivering', payload: {} });
    expect(await suppressBackstop('h2', 'x')).toBe(false);
    mockHookFindUnique.mockRejectedValueOnce(new Error('db'));
    expect(await suppressBackstop('h3', 'x')).toBe(false);
    expect(await suppressBackstop(null, 'x')).toBe(false);
  });
});

// ── r3 interactions fix (2026-10-20): a ci wait met RED is the lane's ONE wake
// about that sha — booked with ci-watch (which then adds none); once the lane's
// red-fix loop budget is spent, ci-watch escalates the loop instead.
describe('runConditionWakesPass — a ci wait met RED and ci-watch are one loop', () => {
  const T0 = new Date('2026-10-20T12:00:00Z');
  const NOW = new Date(T0.getTime() + 5 * 60_000);
  const lane = (): LaneFacts => ({ userId: 'u1', archived: false, githubLabel: null, lastRun: { status: 'completed', error: null, at: T0 } });
  const seedCi = (store: ReturnType<typeof memStore>) => {
    const spec = { kind: 'ci' as const, owner: 'o', repo: 'r', sha: SHA };
    const rec: ConditionWakeRecord = {
      v: 1, key: conditionWakeKey('lane-1', spec), chatId: 'lane-1', userId: 'u1', runId: 'run-1', spec,
      createdAt: T0.toISOString(), horizonAt: new Date(T0.getTime() + CONDITION_WAKE_HORIZON_MS.ci).toISOString(),
      nextCheckAt: T0.toISOString(), checks: 0, errors: 0, backstopHookEventId: 'backstop-1', lastSummary: null,
    };
    store.rows.set(rec.key, rec);
    return rec;
  };
  const pass = (store: ReturnType<typeof memStore>, state: CiStatus['state'], noteRedWake: jest.Mock) => {
    const wake = jest.fn(async () => ({ ok: true, hookEventId: 'met-1' }));
    const suppress = jest.fn(async () => true);
    return { wake, suppress, run: () => runConditionWakesPass({ now: NOW, store, wake, suppress, noteRedWake: noteRedWake as any, loadLane: async () => lane(), getToken: async () => 'tok', fetchCiStatus: async () => ci(state), renderCiStatus: render }) };
  };

  it('met RED ⇒ booked with ci-watch, then the ONE met wake; met GREEN is never booked', async () => {
    const store = memStore();
    seedCi(store);
    const book = jest.fn(async () => 'deliver');
    const p = pass(store, 'failure', book);
    await p.run();
    expect(book).toHaveBeenCalledWith({ chatId: 'lane-1', sha: SHA, via: 'await_condition' });
    expect(p.wake).toHaveBeenCalledTimes(1);
    expect(p.suppress).toHaveBeenCalledWith('backstop-1', 'condition_met');

    const store2 = memStore();
    seedCi(store2);
    const book2 = jest.fn(async () => 'deliver');
    await pass(store2, 'success', book2).run();
    expect(book2).not.toHaveBeenCalled();
  });

  // r3 lane-merge review fix: the backstop stands down too — left armed, its
  // "decide: continue, fix" wake fired at the horizon and re-entered the loop
  // ci-watch had handed to the supervisor.
  it('the lane’s red-fix loop budget spent ("loop") ⇒ NO lane wake: the wait is dropped and its backstop suppressed (ci-watch escalates the loop)', async () => {
    const store = memStore();
    seedCi(store);
    const p = pass(store, 'failure', jest.fn(async () => 'loop'));
    const c = await p.run();
    expect(p.wake).not.toHaveBeenCalled();
    expect(p.suppress).toHaveBeenCalledTimes(1);
    expect(p.suppress).toHaveBeenCalledWith('backstop-1', 'condition_loop_handoff');
    expect(store.rows.size).toBe(0);
    expect(c).toMatchObject({ met: 0, dropped: 1 });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'await_condition', meta: expect.objectContaining({ phase: 'loop_handoff' }) }));
  });
});
