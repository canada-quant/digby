/**
 * CI-WATCH (2026-10-20) — the no-LLM CI watch over lane-pushed shas.
 *
 * Pins the pure helpers (receipt → target mapping, observation folding,
 * supersede / escalation decisions, GitHub error classes, wake + note text)
 * and the pass with every side effect injected: lane FIRST (one direct wake
 * per red sha), THEN the project supervisor (one ci_failed per sha, only once
 * the lane is idle or past the hold), dedupe, the per-pass bound, the
 * rate-limit backoff, PR head resolution and the kill switch.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: { CI_WATCH: 'ci_watch' },
}));

import {
  CI_WATCH_ERROR_RETRY_MS, CI_WATCH_FAILURE_SETTLE_MS, CI_WATCH_LANE_GRACE_MS, CI_WATCH_LANE_LOOP_REDS, CI_WATCH_LANE_WAKE_MAX,
  CI_WATCH_LANE_WINDOW_MS, CI_WATCH_NONE_TERMINAL_MS, CI_WATCH_PS_MAX_HOLD_MS,
  afterRecheck, applyCiObservation, ciWatchScope, classifyGithubError, classifyRunOrigin, emptyLaneLedger, escalationStep,
  findSupersedingPush, isDue, isExplicitStop, laneLedgerKey, laneLoopVerdict, markLaneWoken, newRecord, noneDelayMs, noteLaneRed,
  orderDue, parseGithubRepo, parsePrUrl, pruneLaneLedger, receiptsToTargets, redHeldMs, renderEscalationNote, renderLaneWakePrompt,
  noteHarnessRedWake, runCiWatchOnce, sameSha, type CiWatchDeps, type CiWatchLane, type CiWatchLaneLedger, type CiWatchReceiptRow, type CiWatchRecord,
  type CiWatchTarget, type RunOriginFacts,
} from './ci-watch.service';
import type { CiStatus } from './ci-status';

const T0 = new Date('2026-10-20T12:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

// Receipts default to a MACHINE run ('run-m' — origin 'agent'); 'run-u' is a human's own turn.
const push = (id: string, sha: string, opts: { chatId?: string; at?: Date; branch?: string; runId?: string | null } = {}): CiWatchReceiptRow => ({
  id, chatId: opts.chatId ?? 'lane-1', runId: opts.runId === undefined ? 'run-m' : opts.runId, tool: 'git_push',
  ids: { sha, branch: opts.branch ?? 'digby/session-1' }, createdAt: opts.at ?? at(-30),
});
const prRow = (id: string, n: number, opts: { chatId?: string; at?: Date; runId?: string | null } = {}): CiWatchReceiptRow => ({
  id, chatId: opts.chatId ?? 'lane-1', runId: opts.runId === undefined ? 'run-m' : opts.runId, tool: 'open_pull_request',
  ids: { prNumber: n, url: `https://github.com/acme/app/pull/${n}` }, createdAt: opts.at ?? at(-20),
});
const ORIGINS: Record<string, RunOriginFacts> = {
  'run-m': { origin: 'agent', userTurnAt: null, ownerDispatch: null },
  'run-s': { origin: 'schedule', userTurnAt: null, ownerDispatch: null },
  'run-u': { origin: 'user', userTurnAt: '2026-10-20T11:00:00Z', ownerDispatch: null },
};

const RED: CiStatus = { state: 'failure', checks: [{ name: 'backend-tests', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }], failing: ['backend-tests'], total: 2 };
const RED_RUNNING: CiStatus = { state: 'failure', checks: [{ name: 'backend-tests', status: 'completed', conclusion: 'failure' }, { name: 'e2e', status: 'in_progress', conclusion: null }], failing: ['backend-tests'], total: 2 };
const GREEN: CiStatus = { state: 'success', checks: [{ name: 'backend-tests', status: 'completed', conclusion: 'success' }], failing: [], total: 1 };
const PENDING: CiStatus = { state: 'pending', checks: [{ name: 'backend-tests', status: 'queued', conclusion: null }], failing: [], total: 1 };
const NONE: CiStatus = { state: 'none', checks: [], failing: [], total: 0 };

// A machine lane: spawned by its supervisor, first run machine-authored, in a supervised project.
const LANE: CiWatchLane = {
  userId: 'u1', archived: false, repoUrl: 'https://github.com/acme/app.git', provider: 'github', githubLabel: null,
  parentChatId: 'ps-chat', machineStarted: true, projectSupervisorOn: true, lastRunStopped: false,
};
// A human's own top-level session: no parent, first run a user turn, no project supervisor.
const HUMAN_SESSION: CiWatchLane = { ...LANE, parentChatId: null, machineStarted: false, projectSupervisorOn: false };

function memStore(seed: Record<string, any> = {}) {
  const m = new Map<string, any>(Object.entries(seed));
  return {
    m,
    getMany: jest.fn(async (keys: string[]) => {
      const out = new Map<string, any>();
      for (const k of keys) if (m.has(k)) out.set(k, m.get(k));
      return out;
    }) as any,
    put: jest.fn(async (k: string, v: any) => { m.set(k, v); }),
    claim: jest.fn(async (k: string, v: any) => { if (m.has(k)) return false; m.set(k, v); return true; }) as jest.Mock,
    release: jest.fn(async (k: string) => { m.delete(k); }),
    prune: jest.fn(async () => 0),
  };
}

/** One harness for a pass: receipts, lane, CI answer, liveness — everything injected. */
function harness(opts: {
  rows: CiWatchReceiptRow[];
  ci?: CiStatus | ((sha: string) => CiStatus | Promise<CiStatus>);
  lane?: CiWatchLane | null;
  live?: boolean;
  store?: ReturnType<typeof memStore>;
  pull?: (n: number) => any;
  /** The live branch head (default: the newest git_push receipt's sha on that branch — nothing pushed outside git_push). */
  head?: (branch: string) => string | Promise<string>;
  wakeOk?: boolean;
  /** What the awaited ci_failed emission reports (default: one supervisor row written). */
  emitResult?: { written: number; error?: boolean };
  /** An open merge intent / await_condition 'ci' wake of the lane covers the sha (default: none). */
  covers?: boolean;
}) {
  const store = opts.store ?? memStore();
  const fetchCiStatus = jest.fn(async (_t: string, _o: string, _r: string, sha: string) => {
    const c = opts.ci ?? RED;
    return typeof c === 'function' ? c(sha) : c;
  });
  const enqueueDirectWake = jest.fn(async () => (opts.wakeOk === false ? { ok: false, error: 'boom' } : { ok: true, hookEventId: 'he-1' }));
  const emitCiFailed = jest.fn(async () => opts.emitResult ?? { written: 1 });
  const isLaneLive = jest.fn(async () => opts.live === true);
  const harnessWaitCovers = jest.fn(async () => opts.covers === true);
  const fetchPullHead = jest.fn(async (_t: string, _o: string, _r: string, n: number) => (opts.pull ? opts.pull(n) : { sha: SHA_C, ref: 'digby/session-1', state: 'open', merged: false }));
  const newestOn = (branch: string): string => {
    const hit = [...opts.rows]
      .filter((r) => r.tool === 'git_push' && (r.ids as any)?.branch === branch)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    return String((hit?.ids as any)?.sha ?? '');
  };
  const fetchBranchHead = jest.fn(async (_t: string, _o: string, _r: string, branch: string) => (opts.head ? opts.head(branch) : newestOn(branch)));
  const loadRunOrigins = jest.fn(async (ids: string[]) => new Map(ids.filter((id) => ORIGINS[id]).map((id) => [id, ORIGINS[id]] as const)));
  const deps = (now: Date, extra: Partial<CiWatchDeps> = {}): CiWatchDeps => ({
    now,
    store: store as any,
    loadReceipts: async () => opts.rows,
    loadRunOrigins,
    loadLane: async () => (opts.lane === undefined ? LANE : opts.lane),
    getToken: async () => 'tok',
    fetchCiStatus,
    fetchPullHead,
    fetchBranchHead,
    enqueueDirectWake,
    emitCiFailed,
    isLaneLive,
    harnessWaitCovers,
    ...extra,
  });
  return { store, fetchCiStatus, enqueueDirectWake, emitCiFailed, isLaneLive, harnessWaitCovers, fetchPullHead, fetchBranchHead, loadRunOrigins, deps };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CI_WATCH_DISABLED;
});

// ── pure helpers ───────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  it('parses GitHub repo + PR URLs (null for anything else)', () => {
    expect(parseGithubRepo('https://github.com/acme/app.git')).toEqual({ owner: 'acme', repo: 'app' });
    expect(parseGithubRepo('git@github.com:acme/app')).toEqual({ owner: 'acme', repo: 'app' });
    expect(parseGithubRepo('https://gitlab.com/acme/app')).toBeNull();
    expect(parsePrUrl('https://github.com/acme/app/pull/42')).toEqual({ owner: 'acme', repo: 'app', prNumber: 42 });
    expect(parsePrUrl('https://github.com/acme/app/issues/42')).toBeNull();
  });

  it('receipts → targets: a sha per git_push (newest wins), a pr:<receiptId> per open_pull_request, malformed rows skipped', () => {
    const { shas, prs } = receiptsToTargets([
      push('r2', SHA_A.toUpperCase(), { at: at(-10) }),
      push('r1', SHA_A, { at: at(-40) }),
      push('r3', 'not-a-sha'),
      prRow('r4', 7),
      { id: 'r5', chatId: 'lane-1', tool: 'open_pull_request', ids: { url: 'nope' }, createdAt: at(-5) },
    ]);
    expect([...shas.keys()]).toEqual([SHA_A]);
    expect(shas.get(SHA_A)).toMatchObject({ kind: 'sha', receiptId: 'r2', branch: 'digby/session-1' });
    expect(prs).toEqual([expect.objectContaining({ key: 'pr:r4', kind: 'pr', owner: 'acme', repo: 'app', prNumber: 7, sha: null })]);
  });

  it('isDue: absent → due; terminal → never; else by nextCheckAt', () => {
    expect(isDue(null, T0)).toBe(true);
    expect(isDue({ terminal: true, nextCheckAt: at(-5).toISOString() }, T0)).toBe(false);
    expect(isDue({ terminal: false, nextCheckAt: at(5).toISOString() }, T0)).toBe(false);
    expect(isDue({ terminal: false, nextCheckAt: at(-1).toISOString() }, T0)).toBe(true);
  });

  it('orderDue: never-checked first (newest push first), then the oldest last check', () => {
    const t = (key: string, min: number): CiWatchTarget => ({ key, kind: 'sha', chatId: 'c', receiptId: key, receiptAt: at(min), runId: null, sha: key, branch: null, owner: null, repo: null, prNumber: null });
    const out = orderDue([
      { target: t('checked-late', -60), lastCheckedAt: at(-1).toISOString() },
      { target: t('new-old', -50), lastCheckedAt: null },
      { target: t('checked-early', -60), lastCheckedAt: at(-30).toISOString() },
      { target: t('new-fresh', -5), lastCheckedAt: null },
    ]);
    expect(out.map((i) => i.target.key)).toEqual(['new-fresh', 'new-old', 'checked-early', 'checked-late']);
  });

  it('applyCiObservation: success is terminal, pending re-checks, none backs off then parks after 6 h', () => {
    const t = receiptsToTargets([push('r1', SHA_A, { at: at(-30) })]).shas.get(SHA_A)!;
    const rec = newRecord(t, 'acme', 'app', T0);
    expect(applyCiObservation(rec, GREEN, T0)).toMatchObject({ route: false, rec: { terminal: true, outcome: 'success', checks: 1 } });
    const p = applyCiObservation(rec, PENDING, T0);
    expect(p.route).toBe(false);
    expect(new Date(p.rec.nextCheckAt).getTime()).toBe(at(5).getTime());
    const n = applyCiObservation(rec, NONE, T0);
    expect(n.rec.terminal).toBe(false);
    expect(new Date(n.rec.nextCheckAt).getTime()).toBe(T0.getTime() + noneDelayMs(1));
    const old = { ...rec, receiptAt: new Date(T0.getTime() - CI_WATCH_NONE_TERMINAL_MS).toISOString() };
    expect(applyCiObservation(old, NONE, T0).rec).toMatchObject({ terminal: true, outcome: 'none' });
    expect(noneDelayMs(1)).toBe(10 * 60_000);
    expect(noneDelayMs(3)).toBe(40 * 60_000);
    expect(noneDelayMs(20)).toBe(2 * 60 * 60_000);
  });

  it('applyCiObservation: a failure with checks still running waits (up to the settle window); a completed one routes', () => {
    const t = receiptsToTargets([push('r1', SHA_A)]).shas.get(SHA_A)!;
    const rec = newRecord(t, 'acme', 'app', T0);
    const early = applyCiObservation(rec, RED_RUNNING, T0);
    expect(early.route).toBe(false);
    expect(early.rec.failingSince).toBe(T0.toISOString());
    const later = applyCiObservation(early.rec, RED_RUNNING, new Date(T0.getTime() + CI_WATCH_FAILURE_SETTLE_MS));
    expect(later.route).toBe(true);
    expect(applyCiObservation(rec, RED, T0)).toMatchObject({ route: true, rec: { failing: ['backend-tests'], state: 'failure' } });
  });

  it('findSupersedingPush: a NEWER push of the same lane on the same branch with another sha', () => {
    const { shas } = receiptsToTargets([
      push('r2', SHA_B, { at: at(-5) }),
      push('r1', SHA_A, { at: at(-30) }),
      push('r3', SHA_C, { at: at(-1), chatId: 'other-lane' }),
    ]);
    const a = shas.get(SHA_A)!;
    expect(findSupersedingPush({ ...a, sha: SHA_A }, shas.values())?.sha).toBe(SHA_B);
    expect(findSupersedingPush({ ...shas.get(SHA_B)!, sha: SHA_B }, shas.values())).toBeNull();
    expect(findSupersedingPush({ ...a, sha: SHA_A, branch: null }, shas.values())).toBeNull();
  });

  it('redHeldMs: measured from the first red observation, else the lane wake', () => {
    expect(redHeldMs({ failingSince: at(-30).toISOString(), laneWokenAt: at(-10).toISOString() }, T0)).toBe(30 * 60_000);
    expect(redHeldMs({ failingSince: null, laneWokenAt: at(-10).toISOString() }, T0)).toBe(10 * 60_000);
    expect(redHeldMs({ failingSince: null, laneWokenAt: null }, T0)).toBe(0);
  });

  it('escalationStep / afterRecheck: lane live inside the hold waits; idle or past the hold re-checks; green resolves', () => {
    expect(escalationStep({ superseded: true, live: true, heldMs: 0 })).toBe('superseded');
    expect(escalationStep({ superseded: false, live: true, heldMs: 60_000 })).toBe('wait');
    expect(escalationStep({ superseded: false, live: true, heldMs: CI_WATCH_PS_MAX_HOLD_MS })).toBe('recheck');
    expect(escalationStep({ superseded: false, live: false, heldMs: 60_000 })).toBe('recheck');
    expect(afterRecheck({ state: 'success', live: false, heldMs: 0 })).toBe('resolved');
    expect(afterRecheck({ state: 'pending', live: false, heldMs: 0 })).toBe('wait');
    expect(afterRecheck({ state: 'pending', live: false, heldMs: CI_WATCH_PS_MAX_HOLD_MS })).toBe('escalate');
    expect(afterRecheck({ state: 'failure', live: false, heldMs: 0 })).toBe('escalate');
    expect(afterRecheck({ state: 'error', live: false, heldMs: 0 })).toBe('escalate'); // fail toward delivery
  });

  it('classifyGithubError: 429 and rate-limit 403s back off (Retry-After / reset, clamped); 404 / other 403 do not', () => {
    expect(classifyGithubError({ response: { status: 429, headers: { 'retry-after': '120' } } }, T0)).toMatchObject({ kind: 'rate_limited', retryAfterMs: 120_000 });
    expect(classifyGithubError({ response: { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(T0.getTime() / 1000 + 600) } } }, T0))
      .toMatchObject({ kind: 'rate_limited', retryAfterMs: 600_000 });
    expect(classifyGithubError({ response: { status: 403, headers: {}, data: { message: 'API rate limit exceeded for user' } } }, T0).kind).toBe('rate_limited');
    expect(classifyGithubError({ response: { status: 429, headers: { 'retry-after': '5' } } }, T0).retryAfterMs).toBe(60_000); // floor
    expect(classifyGithubError({ response: { status: 429, headers: { 'retry-after': '99999' } } }, T0).retryAfterMs).toBe(3_600_000); // ceiling
    expect(classifyGithubError({ response: { status: 403, headers: {}, data: { message: 'Resource not accessible' } } }, T0).kind).toBe('forbidden');
    expect(classifyGithubError({ response: { status: 404 } }, T0).kind).toBe('not_found');
    expect(classifyGithubError(new Error('socket hang up'), T0).kind).toBe('other');
  });

  it('renders the lane wake (failing checks, branch, PR, what happens next) and the three escalation notes', () => {
    const t = receiptsToTargets([push('r1-abcdef', SHA_A)]).shas.get(SHA_A)!;
    const rec: CiWatchRecord = { ...newRecord(t, 'acme', 'app', T0), prNumber: 12, failing: ['backend-tests', 'lint'], laneWokenAt: at(-60).toISOString() };
    const wake = renderLaneWakePrompt(rec);
    expect(wake).toMatch(/^\[CI FAILED — acme\/app@aaaaaaaaaaaa\]/);
    expect(wake).toContain('backend-tests, lint');
    expect(wake).toContain('branch digby/session-1 · PR #12 · receipt r1-abcde');
    expect(wake).toContain('escalated to whoever supervises this lane');
    expect(renderLaneWakePrompt(rec, { count: 2, max: 3 })).toContain('ci-watch wake 2 of at most 3 for this lane in 24 h');
    expect(renderEscalationNote(rec, 'lane_idle', T0)).toContain('ci-watch woke the lane at 11:00Z');
    expect(renderEscalationNote(rec, 'lane_idle', T0)).toContain('steer it (send_chat_message) or re-dispatch the fix');
    // Honest about what was read: a verified head vs an unreadable one; a stale verdict says so.
    expect(renderEscalationNote({ ...rec, headVerified: true }, 'lane_idle', T0)).toContain('the branch head is still this commit (read live)');
    expect(renderEscalationNote(rec, 'lane_idle', T0)).toContain('saw no newer push on this branch (its live head could not be read)');
    expect(renderEscalationNote(rec, 'lane_idle', T0, undefined, { errors: 3 })).toContain('could not re-read CI after the wake (3 failed reads)');
    expect(renderEscalationNote(rec, 'lane_stopped', T0)).toContain("last run was STOPPED, so ci-watch did not wake it");
    const ledger: CiWatchLaneLedger = { ...emptyLaneLedger('lane-1'), reds: [
      { sha: SHA_A, branch: 'b1', at: at(-90).toISOString(), woken: true },
      { sha: SHA_B, branch: 'b1', at: at(-40).toISOString(), woken: true },
      { sha: SHA_C, branch: 'b2', at: at(-5).toISOString(), woken: false },
    ] };
    const loop = renderEscalationNote(rec, 'lane_loop', T0, undefined, { ledger });
    expect(loop).toContain('pushed 3 red commits in 24 h (aaaaaaaaaaaa@b1, bbbbbbbbbbbb@b1, cccccccccccc@b2)');
    expect(loop).toContain('already woke it 2×');
    expect(loop).toContain('stops waking it for 24 h');
    expect(renderEscalationNote(rec, 'max_hold', T0)).toContain('red ~1 h');
    expect(renderEscalationNote({ ...rec, failingSince: at(-180).toISOString() }, 'max_hold', T0)).toContain('red ~3 h');
    expect(renderEscalationNote(rec, 'lane_unwakeable', T0, 'the lane chat is archived')).toContain('cannot be woken (the lane chat is archived)');
  });
});

// ── the pass ───────────────────────────────────────────────────────────────────

describe('runCiWatchOnce — lane first, then the project supervisor', () => {
  it('kill switch CI_WATCH_DISABLED=1: nothing is read, checked, woken or emitted', async () => {
    process.env.CI_WATCH_DISABLED = '1';
    const h = harness({ rows: [push('r1', SHA_A)] });
    const loadReceipts = jest.fn(async () => [push('r1', SHA_A)]);
    expect(await runCiWatchOnce(h.deps(T0, { loadReceipts }))).toContain('disabled');
    expect(loadReceipts).not.toHaveBeenCalled();
    expect(h.fetchCiStatus).not.toHaveBeenCalled();
  });

  it('a completed red sha wakes the LANE once with the failing checks — no supervisor emission yet; the next pass inside the grace does nothing', async () => {
    const h = harness({ rows: [push('r1', SHA_A)] });
    const summary = await runCiWatchOnce(h.deps(T0));
    expect(summary).toContain('woken 1');
    expect(h.fetchCiStatus).toHaveBeenCalledWith('tok', 'acme', 'app', SHA_A);
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
    const w = (h.enqueueDirectWake.mock.calls[0] as any[])[0];
    expect(w.targetChatId).toBe('lane-1');
    expect(w.prompt).toContain('backend-tests');
    expect(w.meta).toMatchObject({ origin: 'ci-watch', sha: SHA_A, repo: 'acme/app' });
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    expect(h.store.m.get(SHA_A)).toMatchObject({ state: 'failure', terminal: false, laneWokenAt: T0.toISOString(), wakeEventId: 'he-1' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci_watch', meta: expect.objectContaining({ phase: 'lane_woken', sha: SHA_A }) }));

    await runCiWatchOnce(h.deps(at(5))); // inside the 10-min grace: not due
    expect(h.fetchCiStatus).toHaveBeenCalledTimes(1);
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('a LIVE lane is never woken onto: the red sha is re-checked each interval and the wake queues once the lane is idle', async () => {
    const store = memStore();
    const live = harness({ rows: [push('r1', SHA_A)], store, live: true });
    await runCiWatchOnce(live.deps(T0));
    expect(live.enqueueDirectWake).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ state: 'failure', laneWokenAt: null, failingSince: T0.toISOString(), terminal: false });
    await runCiWatchOnce(live.deps(at(2))); // not due yet (next interval)
    expect(live.fetchCiStatus).toHaveBeenCalledTimes(1);

    const idle = harness({ rows: [push('r1', SHA_A)], store, live: false });
    await runCiWatchOnce(idle.deps(at(6)));
    expect(idle.enqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(store.m.get(SHA_A)).toMatchObject({ laneWokenAt: at(6).toISOString(), failingSince: T0.toISOString() });
  });

  it('while the lane is LIVE inside the hold: no GitHub read, no emission; once idle and still red: ONE ci_failed escalation, then terminal', async () => {
    const store = memStore();
    await runCiWatchOnce(harness({ rows: [push('r1', SHA_A)], store, live: false }).deps(T0)); // lane woken
    const live = harness({ rows: [push('r1', SHA_A)], store, live: true });
    await runCiWatchOnce(live.deps(at(15)));
    expect(live.isLaneLive).toHaveBeenCalledWith('lane-1');
    expect(live.fetchCiStatus).not.toHaveBeenCalled(); // waiting on a live lane costs no GitHub read
    expect(live.emitCiFailed).not.toHaveBeenCalled();

    const idle = harness({ rows: [push('r1', SHA_A)], store, live: false });
    expect(await runCiWatchOnce(idle.deps(at(25)))).toContain('escalated 1');
    expect(idle.fetchCiStatus).toHaveBeenCalledTimes(1); // the re-check
    expect(idle.fetchBranchHead).toHaveBeenCalledWith('tok', 'acme', 'app', 'digby/session-1'); // the live head, before escalating
    expect(idle.emitCiFailed).toHaveBeenCalledTimes(1);
    const [chatId, sha, failing, o] = idle.emitCiFailed.mock.calls[0] as any[];
    expect([chatId, sha, failing]).toEqual(['lane-1', SHA_A, ['backend-tests']]);
    expect(o.extra).toMatchObject({ ciWatch: true, ciWatchEscalation: 'lane_idle', repo: 'acme/app', branch: 'digby/session-1', depth: 0 });
    expect(o.note).toContain('the lane is idle and the branch head is still this commit (read live)');
    expect(store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'escalated', escalation: 'lane_idle' });

    await runCiWatchOnce(idle.deps(at(60)));
    expect(idle.emitCiFailed).toHaveBeenCalledTimes(1); // once per sha
    expect(idle.fetchCiStatus).toHaveBeenCalledTimes(1);
  });

  it('a lane live for the whole 2 h hold is woken anyway, then the supervisor hears (max_hold — fail toward delivery)', async () => {
    const store = memStore();
    const h = harness({ rows: [push('r1', SHA_A)], store, live: true });
    await runCiWatchOnce(h.deps(T0)); // red, lane live → deferred
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    const past = new Date(T0.getTime() + CI_WATCH_PS_MAX_HOLD_MS + 60_000);
    await runCiWatchOnce(h.deps(past)); // red for the whole hold → the wake is queued (it parks until the run ends)
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    await runCiWatchOnce(h.deps(new Date(past.getTime() + CI_WATCH_LANE_GRACE_MS)));
    expect(h.emitCiFailed).toHaveBeenCalledTimes(1);
    const o = (h.emitCiFailed.mock.calls[0] as any[])[3];
    expect(o.extra.ciWatchEscalation).toBe('max_hold');
    expect(o.note).toContain('The commit has been red ~2 h');
  });

  it('a re-run that went green after the wake resolves the sha — the supervisor is never told', async () => {
    const store = memStore();
    await runCiWatchOnce(harness({ rows: [push('r1', SHA_A)], store }).deps(T0));
    const h = harness({ rows: [push('r1', SHA_A)], store, ci: GREEN });
    expect(await runCiWatchOnce(h.deps(at(20)))).toContain('resolved 1');
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'resolved' });
  });

  it('a newer push on the same branch supersedes a red sha: no wake (at route) and no escalation (after the wake)', async () => {
    const rows = [push('r2', SHA_B, { at: at(-5) }), push('r1', SHA_A, { at: at(-30) })];
    const h = harness({ rows, ci: (sha) => (sha === SHA_A ? RED : PENDING) });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(h.store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'superseded' });

    // Woken first, the newer push lands afterwards: the escalation step stops without a read.
    const store = memStore();
    await runCiWatchOnce(harness({ rows: [push('r1', SHA_A, { at: at(-30) })], store }).deps(T0));
    const later = harness({ rows: [push('r2', SHA_B, { at: at(5) }), push('r1', SHA_A, { at: at(-30) })], store, ci: PENDING });
    await runCiWatchOnce(later.deps(at(20)));
    expect(later.emitCiFailed).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'superseded' });
    expect(later.fetchCiStatus.mock.calls.map((c: any[]) => c[3])).toEqual([SHA_B]);
  });

  it('an archived lane cannot be woken: the supervisor hears at once (lane_unwakeable); a failed wake enqueue does the same', async () => {
    const h = harness({ rows: [push('r1', SHA_A)], lane: { ...LANE, archived: true } });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect((h.emitCiFailed.mock.calls[0] as any[])[3].extra.ciWatchEscalation).toBe('lane_unwakeable');

    const f = harness({ rows: [push('r1', SHA_A)], wakeOk: false });
    await runCiWatchOnce(f.deps(T0));
    expect(f.enqueueDirectWake).toHaveBeenCalledTimes(1);
    expect((f.emitCiFailed.mock.calls[0] as any[])[3].note).toContain('the wake could not be queued');
  });

  it('dedupe: an existing wake / emit claim for the sha is never re-fired (a re-created verdict row cannot double-wake)', async () => {
    const store = memStore({ [`wake:${SHA_A}`]: { at: 'x' } });
    const h = harness({ rows: [push('r1', SHA_A)], store });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ laneWokenAt: T0.toISOString() });

    const store2 = memStore({ [`emit:${SHA_A}`]: { at: 'x' } });
    const h2 = harness({ rows: [push('r1', SHA_A)], store: store2, lane: { ...LANE, archived: true } });
    await runCiWatchOnce(h2.deps(T0));
    expect(h2.emitCiFailed).not.toHaveBeenCalled();
    expect(store2.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'escalated' });
  });

  it('green / pending / no-checks shas wake nobody; pending is re-polled next interval, green is never polled again', async () => {
    const h = harness({ rows: [push('r1', SHA_A), push('r2', SHA_B, { branch: 'other' }), push('r3', SHA_C, { branch: 'third' })], ci: (sha) => (sha === SHA_A ? GREEN : sha === SHA_B ? PENDING : NONE) });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    await runCiWatchOnce(h.deps(at(6)));
    expect(h.fetchCiStatus.mock.calls.slice(3).map((c: any[]) => c[3])).toEqual([SHA_B]); // only the pending one re-polled
  });

  it('per-pass bound: at most maxPerPass GitHub reads, the rest stay due for the next pass', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => push(`r${i}`, i.toString(16).padStart(40, '0'), { branch: `b${i}`, at: at(-i) }));
    const h = harness({ rows, ci: PENDING });
    await runCiWatchOnce(h.deps(T0, { maxPerPass: 5 }));
    expect(h.fetchCiStatus).toHaveBeenCalledTimes(5);
    await runCiWatchOnce(h.deps(at(1), { maxPerPass: 5 }));
    expect(h.fetchCiStatus).toHaveBeenCalledTimes(10);
  });

  it('rate limits back the owner off (stored, honoured next pass) and two of them end the pass', async () => {
    const rows = [push('r1', SHA_A, { branch: 'x' }), push('r2', SHA_B, { branch: 'y' }), push('r3', SHA_C, { branch: 'z' })];
    const store = memStore();
    const err = Object.assign(new Error('rate'), { response: { status: 429, headers: { 'retry-after': '600' } } });
    // Two lanes of two owners, both rate limited → the pass stops before the third sha.
    const lanes: Record<string, CiWatchLane> = { 'lane-1': LANE, 'lane-2': { ...LANE, userId: 'u2' }, 'lane-3': { ...LANE, userId: 'u3' } };
    const h = harness({ rows: rows.map((r, i) => ({ ...r, chatId: `lane-${i + 1}` })), store, ci: () => { throw err; } });
    const summary = await runCiWatchOnce(h.deps(T0, { loadLane: async (id) => lanes[id] }));
    expect(summary).toContain('rate-limited 2');
    expect(h.fetchCiStatus).toHaveBeenCalledTimes(2);
    expect(store.m.get('backoff:u1')).toMatchObject({ until: at(10).toISOString(), reason: 'http_429' });

    const next = harness({ rows: rows.map((r, i) => ({ ...r, chatId: `lane-${i + 1}` })), store, ci: PENDING });
    await runCiWatchOnce(next.deps(at(5), { loadLane: async (id) => lanes[id] }));
    expect(next.fetchCiStatus).toHaveBeenCalledTimes(1); // only u3's sha — u1 / u2 are backed off
  });

  it('a 404 sha is retried a bounded number of times, then parked not_found', async () => {
    const store = memStore();
    const err = Object.assign(new Error('nf'), { response: { status: 404 } });
    const h = harness({ rows: [push('r1', SHA_A)], store, ci: () => { throw err; } });
    await runCiWatchOnce(h.deps(T0));
    await runCiWatchOnce(h.deps(at(16)));
    await runCiWatchOnce(h.deps(at(32)));
    expect(store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'not_found', errors: 3 });
    await runCiWatchOnce(h.deps(at(60)));
    expect(h.fetchCiStatus).toHaveBeenCalledTimes(3);
  });

  it('no GitHub token: the owner is backed off for an hour, nothing is read', async () => {
    const store = memStore();
    const h = harness({ rows: [push('r1', SHA_A)], store });
    await runCiWatchOnce(h.deps(T0, { getToken: async () => null }));
    expect(h.fetchCiStatus).not.toHaveBeenCalled();
    expect(store.m.get('backoff:u1')).toMatchObject({ reason: 'no_token' });
  });

  it('an open_pull_request receipt resolves the PR head sha (pointer stored) and checks it in the same pass; a closed PR is dropped', async () => {
    const h = harness({ rows: [prRow('rp', 7)] });
    await runCiWatchOnce(h.deps(T0));
    expect(h.fetchPullHead).toHaveBeenCalledWith('tok', 'acme', 'app', 7);
    expect(h.store.m.get('pr:rp')).toMatchObject({ sha: SHA_C, branch: 'digby/session-1', terminal: true });
    expect(h.fetchCiStatus).toHaveBeenCalledWith('tok', 'acme', 'app', SHA_C);
    expect((h.enqueueDirectWake.mock.calls[0] as any[])[0].prompt).toContain('PR #7');

    // Pass 1 read the PR twice: the resolve, then the live head before the wake.
    expect(h.fetchPullHead).toHaveBeenCalledTimes(2);
    // Next pass: the pointer stays resolved — the only PR read is the live head before the escalation.
    await runCiWatchOnce(h.deps(at(30)));
    expect(h.fetchPullHead).toHaveBeenCalledTimes(3);
    expect(h.store.m.get('pr:rp')).toMatchObject({ sha: SHA_C });

    const closed = harness({ rows: [prRow('rp', 8)], pull: () => ({ sha: SHA_C, ref: 'x', state: 'closed', merged: true }) });
    await runCiWatchOnce(closed.deps(T0));
    expect(closed.store.m.get('pr:rp')).toMatchObject({ terminal: true, outcome: 'closed' });
    expect(closed.fetchCiStatus).not.toHaveBeenCalled();
  });

  it('a sha parked "none" (branch push before any PR) is re-opened when its PR appears', async () => {
    const parked: CiWatchRecord = { ...newRecord(receiptsToTargets([push('r1', SHA_C)]).shas.get(SHA_C)!, 'acme', 'app', at(-400)), terminal: true, outcome: 'none', state: 'none' };
    const store = memStore({ [SHA_C]: parked });
    const h = harness({ rows: [push('r1', SHA_C, { at: at(-400) }), prRow('rp', 9)], store });
    await runCiWatchOnce(h.deps(T0));
    expect(h.fetchCiStatus).toHaveBeenCalledTimes(1);
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(store.m.get(SHA_C)).toMatchObject({ prNumber: 9, laneWokenAt: T0.toISOString() });
  });

  it('a lane chat that no longer exists parks the sha (no read, no wake)', async () => {
    const h = harness({ rows: [push('r1', SHA_A)], lane: null });
    await runCiWatchOnce(h.deps(T0));
    expect(h.fetchCiStatus).not.toHaveBeenCalled();
    expect(h.store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'no_lane' });
  });

  it('never throws: a receipt read failure degrades to an empty pass summary', async () => {
    const h = harness({ rows: [] });
    const out = await runCiWatchOnce(h.deps(T0, { loadReceipts: async () => { throw new Error('db down'); } }));
    expect(out).toMatch(/^ci-watch: candidates 0/);
  });

  it('the lane-woken row waits CI_WATCH_LANE_GRACE_MS before its first escalation check', async () => {
    const h = harness({ rows: [push('r1', SHA_A)] });
    await runCiWatchOnce(h.deps(T0));
    expect(new Date(h.store.m.get(SHA_A).nextCheckAt).getTime()).toBe(T0.getTime() + CI_WATCH_LANE_GRACE_MS);
  });
});

// ── review fixes (2026-10-20) ──────────────────────────────────────────────────

describe('review fixes — pure helpers', () => {
  it('classifyRunOrigin: the executor rule (explicit origin wins; else userTurnAt ⇒ user; an owner dispatch is a user run)', () => {
    expect(classifyRunOrigin({ origin: 'user', userTurnAt: null, ownerDispatch: null })).toBe('human');
    expect(classifyRunOrigin({ origin: null, userTurnAt: '2026-10-20T11:00:00Z', ownerDispatch: null })).toBe('human');
    expect(classifyRunOrigin({ origin: 'agent', userTurnAt: '2026-10-20T11:00:00Z', ownerDispatch: 'true' })).toBe('human');
    expect(classifyRunOrigin({ origin: 'agent', userTurnAt: '2026-10-20T11:00:00Z', ownerDispatch: null })).toBe('machine');
    expect(classifyRunOrigin({ origin: 'schedule', userTurnAt: null, ownerDispatch: null })).toBe('machine');
    expect(classifyRunOrigin({ origin: null, userTurnAt: null, ownerDispatch: null })).toBe('machine'); // legacy machine row
    expect(classifyRunOrigin({ origin: 'mystery', userTurnAt: null, ownerDispatch: null })).toBe('unknown');
    expect(classifyRunOrigin(null)).toBe('unknown');
  });

  it('ciWatchScope: a machine push in a machine lane only (parent, machine-started or PS-supervised project)', () => {
    const lane = { parentChatId: null, machineStarted: false, projectSupervisorOn: false };
    expect(ciWatchScope({ receipt: 'human', ...lane, parentChatId: 'p' })).toBe('human_run');
    expect(ciWatchScope({ receipt: 'unknown', ...lane, parentChatId: 'p' })).toBe('unknown_run');
    expect(ciWatchScope({ receipt: 'machine', ...lane })).toBe('not_machine_lane');
    expect(ciWatchScope({ receipt: 'machine', ...lane, parentChatId: 'p' })).toBe('lane');
    expect(ciWatchScope({ receipt: 'machine', ...lane, machineStarted: true })).toBe('lane');
    expect(ciWatchScope({ receipt: 'machine', ...lane, projectSupervisorOn: true })).toBe('lane');
    expect(ciWatchScope({ receipt: 'machine', ...lane, machineStarted: null })).toBeNull(); // unknown lineage: retry
  });

  it('isExplicitStop: a cancelled run is a stop unless it is a claim-time / superseded housekeeping cancel', () => {
    expect(isExplicitStop({ status: 'cancelled', error: null })).toBe(true);
    expect(isExplicitStop({ status: 'cancelled', error: 'continuation cancelled: the session was stopped' })).toBe(true);
    expect(isExplicitStop({ status: 'cancelled', error: 'continuation obsolete at claim time: the plan board has no unfinished step' })).toBe(false);
    expect(isExplicitStop({ status: 'cancelled', error: 'schedule cancelled before the run started' })).toBe(false);
    expect(isExplicitStop({ status: 'completed', error: null })).toBe(false);
    expect(isExplicitStop(null)).toBe(false);
  });

  it('sameSha tolerates abbreviated receipt shas', () => {
    expect(sameSha(SHA_A, 'aaaaaaa')).toBe(true);
    expect(sameSha(SHA_A, SHA_B)).toBe(false);
    expect(sameSha('', SHA_A)).toBe(false);
  });

  it('the lane ledger: idempotent per sha, rolling window, wake budget and red chain', () => {
    let l = emptyLaneLedger('lane-1');
    l = noteLaneRed(l, { sha: SHA_A, branch: 'b' }, at(-30));
    l = noteLaneRed(l, { sha: SHA_A, branch: 'b' }, at(-20));
    expect(l.reds).toHaveLength(1);
    l = markLaneWoken(l, { sha: SHA_A, branch: 'b' }, at(-20));
    expect(laneLoopVerdict(l)).toMatchObject({ wakes: 1, reds: 1, stop: false });
    let full = emptyLaneLedger('lane-1');
    for (let i = 0; i < CI_WATCH_LANE_WAKE_MAX; i++) full = markLaneWoken(full, { sha: i.toString(16).padStart(40, '0'), branch: 'b' }, at(-i));
    expect(laneLoopVerdict(full)).toMatchObject({ stop: true, why: 'wake_budget' });
    let chain = emptyLaneLedger('lane-1');
    for (let i = 0; i < CI_WATCH_LANE_LOOP_REDS; i++) chain = noteLaneRed(chain, { sha: i.toString(16).padStart(40, '0'), branch: 'b' }, at(-i));
    expect(laneLoopVerdict(chain)).toMatchObject({ wakes: 0, stop: true, why: 'red_chain' });
    const old = { ...full, loopEscalatedAt: at(-30).toISOString() };
    const later = new Date(T0.getTime() + CI_WATCH_LANE_WINDOW_MS);
    expect(pruneLaneLedger(old, 'lane-1', later)).toMatchObject({ reds: [], loopEscalatedAt: null });
    expect(pruneLaneLedger({ reds: 'junk' } as any, 'lane-1', T0).reds).toEqual([]);
  });

  it('orderDue: a known-red (urgent) row goes first, whatever its last check', () => {
    const t = (key: string, min: number): CiWatchTarget => ({ key, kind: 'sha', chatId: 'c', receiptId: key, receiptAt: at(min), runId: null, sha: key, branch: null, owner: null, repo: null, prNumber: null });
    const out = orderDue([
      { target: t('new', -1), lastCheckedAt: null },
      { target: t('red', -60), lastCheckedAt: at(-1).toISOString(), urgent: true },
    ]);
    expect(out.map((i) => i.target.key)).toEqual(['red', 'new']);
  });
});

describe('review fixes — scope: only a MACHINE push in a MACHINE lane is ever woken', () => {
  it('a user-turn push in a human session is observed but never woken (no GitHub read, no wake, no emission)', async () => {
    const h = harness({ rows: [push('r1', SHA_A, { runId: 'run-u' })], lane: HUMAN_SESSION });
    expect(await runCiWatchOnce(h.deps(T0))).toContain('out-of-scope 1');
    expect(h.fetchCiStatus).not.toHaveBeenCalled();
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    expect(h.store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'out_of_scope', scope: 'human_run' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ phase: 'out_of_scope', scope: 'human_run', sha: SHA_A }) }));
    await runCiWatchOnce(h.deps(at(30)));
    expect(h.fetchCiStatus).not.toHaveBeenCalled(); // parked for good
  });

  it('a user-turn push is never woken even in a machine lane; an owner-card push (no run) neither', async () => {
    const h = harness({ rows: [push('r1', SHA_A, { runId: 'run-u' }), push('r2', SHA_B, { runId: null, branch: 'other' })] });
    await runCiWatchOnce(h.deps(T0));
    expect(h.fetchCiStatus).not.toHaveBeenCalled();
    expect(h.store.m.get(SHA_A)).toMatchObject({ outcome: 'out_of_scope', scope: 'human_run' });
    expect(h.store.m.get(SHA_B)).toMatchObject({ outcome: 'out_of_scope', scope: 'human_run' });
  });

  it('a machine push in a session with no machine lineage is observed only; a machine-started (ticket) lane is woken', async () => {
    const plain = harness({ rows: [push('r1', SHA_A, { runId: 'run-s' })], lane: HUMAN_SESSION });
    await runCiWatchOnce(plain.deps(T0));
    expect(plain.enqueueDirectWake).not.toHaveBeenCalled();
    expect(plain.store.m.get(SHA_A)).toMatchObject({ outcome: 'out_of_scope', scope: 'not_machine_lane' });

    const ticket = harness({ rows: [push('r1', SHA_A, { runId: 'run-s' })], lane: { ...HUMAN_SESSION, machineStarted: true } });
    await runCiWatchOnce(ticket.deps(T0));
    expect(ticket.enqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('an open_pull_request from a human turn is never resolved or woken', async () => {
    const h = harness({ rows: [prRow('rp', 7, { runId: 'run-u' })] });
    await runCiWatchOnce(h.deps(T0));
    expect(h.fetchPullHead).not.toHaveBeenCalled();
    expect(h.store.m.get('pr:rp')).toMatchObject({ terminal: true, outcome: 'out_of_scope', scope: 'human_run', sha: null });
  });

  it('a failed run-origin read classifies nothing this pass (no row written) — the next pass does', async () => {
    const h = harness({ rows: [push('r1', SHA_A)] });
    await runCiWatchOnce(h.deps(T0, { loadRunOrigins: async () => { throw new Error('db down'); } }));
    expect(h.fetchCiStatus).not.toHaveBeenCalled();
    expect(h.store.m.has(SHA_A)).toBe(false);
    await runCiWatchOnce(h.deps(at(5)));
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('a lane read failure skips the lane this pass — it never parks the sha no_lane on a hiccup', async () => {
    const h = harness({ rows: [push('r1', SHA_A)] });
    await runCiWatchOnce(h.deps(T0, { loadLane: async () => { throw new Error('db down'); } }));
    expect(h.store.m.has(SHA_A)).toBe(false);
    await runCiWatchOnce(h.deps(at(5)));
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('a lane whose last run was explicitly STOPPED is never woken — its supervisor hears (lane_stopped)', async () => {
    const h = harness({ rows: [push('r1', SHA_A)], lane: { ...LANE, lastRunStopped: true } });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    const o = (h.emitCiFailed.mock.calls[0] as any[])[3];
    expect(o.extra.ciWatchEscalation).toBe('lane_stopped');
    expect(o.note).toContain('a stop means stop');
    expect(h.store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'escalated', escalation: 'lane_stopped' });
  });
});

describe('review fixes — the LIVE head decides supersession (pushes outside git_push)', () => {
  it('route: the branch head moved (a run_command push) — the red sha is superseded, nobody is woken', async () => {
    const h = harness({ rows: [push('r1', SHA_A)], head: () => SHA_B });
    await runCiWatchOnce(h.deps(T0));
    expect(h.fetchBranchHead).toHaveBeenCalledWith('tok', 'acme', 'app', 'digby/session-1');
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    expect(h.store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'superseded' });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ phase: 'superseded', via: 'branch_head', by: SHA_B }) }));
  });

  it('escalation: the lane fixed the red sha with a raw push and went idle — superseded, the supervisor is NOT told', async () => {
    const store = memStore();
    await runCiWatchOnce(harness({ rows: [push('r1', SHA_A)], store }).deps(T0)); // woken
    const later = harness({ rows: [push('r1', SHA_A)], store, head: () => SHA_B }); // fix pushed with run_command `git push`
    await runCiWatchOnce(later.deps(at(25)));
    expect(later.emitCiFailed).not.toHaveBeenCalled();
    expect(later.fetchCiStatus).not.toHaveBeenCalled(); // no stale re-read of the old sha
    expect(store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'superseded' });
  });

  it('a moved PR head is ADOPTED: the PR pointer is re-pointed and the next pass watches the new head', async () => {
    let head = SHA_C;
    const h = harness({ rows: [prRow('rp', 7)], pull: () => ({ sha: head, ref: 'digby/session-1', state: 'open', merged: false }), ci: (sha) => (sha === SHA_C ? RED : PENDING) });
    await runCiWatchOnce(h.deps(T0)); // resolve → SHA_C red → woken
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
    head = SHA_B; // the lane pushed its fix onto the PR with gh / run_command
    await runCiWatchOnce(h.deps(at(25)));
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    expect(h.store.m.get(SHA_C)).toMatchObject({ terminal: true, outcome: 'superseded' });
    expect(h.store.m.get('pr:rp')).toMatchObject({ sha: SHA_B });
    await runCiWatchOnce(h.deps(at(31)));
    expect(h.fetchCiStatus.mock.calls.map((c: any[]) => c[3])).toContain(SHA_B);
    expect(h.store.m.get(SHA_B)).toMatchObject({ prNumber: 7, state: 'pending' });
  });

  it('a merged PR / a deleted branch closes the red sha with no wake and no escalation', async () => {
    let n = 0;
    const merged = harness({ rows: [prRow('rp', 7)], pull: () => (n++ === 0 ? { sha: SHA_C, ref: 'x', state: 'open', merged: false } : { sha: SHA_C, ref: 'x', state: 'closed', merged: true }) });
    await runCiWatchOnce(merged.deps(T0));
    expect(merged.enqueueDirectWake).not.toHaveBeenCalled();
    expect(merged.store.m.get(SHA_C)).toMatchObject({ terminal: true, outcome: 'closed' });

    const gone = harness({ rows: [push('r1', SHA_A)], head: () => { throw Object.assign(new Error('nf'), { response: { status: 404 } }); } });
    await runCiWatchOnce(gone.deps(T0));
    expect(gone.enqueueDirectWake).not.toHaveBeenCalled();
    expect(gone.store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'closed' });
  });

  it('an unreadable head falls back to the receipts (fail toward delivery) and the note says the head was not read', async () => {
    const store = memStore();
    const h = harness({ rows: [push('r1', SHA_A)], store, head: () => { throw Object.assign(new Error('bad gateway'), { response: { status: 502 } }); } });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
    expect(store.m.get(SHA_A)).toMatchObject({ headVerified: false });
    await runCiWatchOnce(h.deps(at(25)));
    expect((h.emitCiFailed.mock.calls[0] as any[])[3].note).toContain('its live head could not be read');
  });

  it('out of budget before the head read: the route waits (row urgent next pass), never a blind wake', async () => {
    const h = harness({ rows: [push('r1', SHA_A)] });
    await runCiWatchOnce(h.deps(T0, { maxPerPass: 1 }));
    expect(h.fetchCiStatus).toHaveBeenCalledTimes(1);
    expect(h.fetchBranchHead).not.toHaveBeenCalled();
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(h.store.m.get(SHA_A)).toMatchObject({ state: 'failure', terminal: false, laneWokenAt: null });
    await runCiWatchOnce(h.deps(at(1), { maxPerPass: 2 }));
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);
  });
});

describe('review fixes — the lane loop budget', () => {
  const seedLedger = (reds: Array<{ sha: string; woken: boolean; min: number }>, extra: Partial<CiWatchLaneLedger> = {}) => ({
    [laneLedgerKey('lane-1')]: { ...emptyLaneLedger('lane-1'), reds: reds.map((r) => ({ sha: r.sha, branch: 'digby/session-1', at: at(r.min).toISOString(), woken: r.woken })), ...extra },
  });
  const sha = (i: number) => (i + 0x10).toString(16).padStart(40, '0');

  it('the wake budget spent: the next red sha is NOT woken — ONE lane_loop escalation names the chain; later reds are suppressed', async () => {
    const store = memStore(seedLedger(Array.from({ length: CI_WATCH_LANE_WAKE_MAX }, (_, i) => ({ sha: sha(i), woken: true, min: -200 + i * 30 }))));
    const h = harness({ rows: [push('r1', SHA_A)], store });
    expect(await runCiWatchOnce(h.deps(T0))).toContain('loop 1');
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(h.emitCiFailed).toHaveBeenCalledTimes(1);
    const o = (h.emitCiFailed.mock.calls[0] as any[])[3];
    expect(o.extra.ciWatchEscalation).toBe('lane_loop');
    expect(o.extra.redChain).toContain(SHA_A);
    expect(o.note).toContain(`already woke it ${CI_WATCH_LANE_WAKE_MAX}×`);
    expect(store.m.get(laneLedgerKey('lane-1')).loopEscalatedAt).toBe(T0.toISOString());

    const next = harness({ rows: [push('r2', SHA_B, { at: at(10), branch: 'other' }), push('r1', SHA_A)], store });
    await runCiWatchOnce(next.deps(at(20)));
    expect(next.enqueueDirectWake).not.toHaveBeenCalled();
    expect(next.emitCiFailed).not.toHaveBeenCalled();
    expect(store.m.get(SHA_B)).toMatchObject({ terminal: true, outcome: 'loop_suppressed' });
  });

  it('a branch that stays red across N pushes (each superseded) escalates as a loop even though no sha was ever woken', async () => {
    const store = memStore(seedLedger(Array.from({ length: CI_WATCH_LANE_LOOP_REDS - 1 }, (_, i) => ({ sha: sha(i), woken: false, min: -120 + i * 10 }))));
    const h = harness({ rows: [push('r1', SHA_A)], store });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect((h.emitCiFailed.mock.calls[0] as any[])[3].extra.ciWatchEscalation).toBe('lane_loop');
  });

  it('every woken and every superseded red counts: the ledger records the chain as it happens', async () => {
    const store = memStore();
    const rows = [push('r2', SHA_B, { at: at(-5) }), push('r1', SHA_A, { at: at(-30) })];
    await runCiWatchOnce(harness({ rows, store }).deps(T0)); // A superseded at route (red), B woken
    const l = store.m.get(laneLedgerKey('lane-1'));
    expect(l.reds.map((r: any) => [r.sha, r.woken])).toEqual(expect.arrayContaining([[SHA_A, false], [SHA_B, true]]));
  });

  it('the wake prompt names its place in the budget', async () => {
    const h = harness({ rows: [push('r1', SHA_A)] });
    await runCiWatchOnce(h.deps(T0));
    expect((h.enqueueDirectWake.mock.calls[0] as any[])[0].prompt).toContain(`ci-watch wake 1 of at most ${CI_WATCH_LANE_WAKE_MAX}`);
  });
});

describe('review fixes — honest, retried escalations', () => {
  it('a failed re-read after the wake is retried like a poll; only the error budget escalates, flagged stale', async () => {
    const store = memStore();
    await runCiWatchOnce(harness({ rows: [push('r1', SHA_A)], store }).deps(T0)); // woken
    const err = Object.assign(new Error('bad gateway'), { response: { status: 502 } });
    const h = harness({ rows: [push('r1', SHA_A)], store, ci: () => { throw err; } });
    await runCiWatchOnce(h.deps(at(25)));
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ errors: 1, terminal: false });
    expect(new Date(store.m.get(SHA_A).nextCheckAt).getTime()).toBe(at(25).getTime() + CI_WATCH_ERROR_RETRY_MS);
    await runCiWatchOnce(h.deps(at(41)));
    expect(h.emitCiFailed).not.toHaveBeenCalled();
    await runCiWatchOnce(h.deps(at(57)));
    expect(h.emitCiFailed).toHaveBeenCalledTimes(1);
    const o = (h.emitCiFailed.mock.calls[0] as any[])[3];
    expect(o.extra.verdictStale).toBe(true);
    expect(o.note).toContain('could not re-read CI after the wake (3 failed reads)');
  });

  it('a failed emission releases its claim and leaves the row due — the next pass escalates', async () => {
    const store = memStore();
    const f = harness({ rows: [push('r1', SHA_A)], store, lane: { ...LANE, archived: true }, emitResult: { written: 0, error: true } });
    await runCiWatchOnce(f.deps(T0));
    expect(f.emitCiFailed).toHaveBeenCalledTimes(1);
    expect(store.m.has(`emit:${SHA_A}`)).toBe(false);
    expect(store.m.get(SHA_A)).toMatchObject({ terminal: false });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ phase: 'escalation_failed' }) }));

    const ok = harness({ rows: [push('r1', SHA_A)], store, lane: { ...LANE, archived: true } });
    await runCiWatchOnce(ok.deps(at(6)));
    expect(ok.emitCiFailed).toHaveBeenCalledTimes(1);
    expect(store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'escalated' });
  });

  it('an emission no hook heard is recorded no_supervisor — never counted escalated', async () => {
    const h = harness({ rows: [push('r1', SHA_A)], lane: { ...LANE, archived: true }, emitResult: { written: 0 } });
    const summary = await runCiWatchOnce(h.deps(T0));
    expect(summary).toContain('escalated 0');
    expect(summary).toContain('no-supervisor 1');
    expect(h.store.m.get(SHA_A)).toMatchObject({ terminal: true, outcome: 'no_supervisor' });
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ phase: 'escalated' }) }));
  });

  it('store claims fail CLOSED: a claim error never wakes or emits; the next pass does, once', async () => {
    const store = memStore();
    store.claim.mockRejectedValueOnce(new Error('db down'));
    const h = harness({ rows: [push('r1', SHA_A)], store });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ terminal: false, laneWokenAt: null });
    await runCiWatchOnce(h.deps(at(6)));
    await runCiWatchOnce(h.deps(at(7)));
    expect(h.enqueueDirectWake).toHaveBeenCalledTimes(1);

    const s2 = memStore();
    s2.claim.mockRejectedValueOnce(new Error('db down'));
    const a = harness({ rows: [push('r1', SHA_A)], store: s2, lane: { ...LANE, archived: true } });
    await runCiWatchOnce(a.deps(T0));
    expect(a.emitCiFailed).not.toHaveBeenCalled();
    expect(s2.m.get(SHA_A)).toMatchObject({ terminal: false });
  });

  it('a failed wake enqueue releases the wake claim (a later pass may still wake the lane)', async () => {
    const h = harness({ rows: [push('r1', SHA_A)], wakeOk: false });
    await runCiWatchOnce(h.deps(T0));
    expect(h.store.m.has(`wake:${SHA_A}`)).toBe(false);
    expect(h.store.release).toHaveBeenCalledWith(`wake:${SHA_A}`);
  });
});

// ── r3 interactions fix (2026-10-20): ONE wake per red sha per lane ───────────
// A merge intent BLOCKED on red CI and an await_condition 'ci' wake met red
// are harness OUTCOME wakes about a red sha. They and ci-watch's own lane wake
// used to be two independent loops on the same lane (two wakes per red sha,
// the merge-intent loop outside ci-watch's loop budget).
describe('r3 interactions — harness red-CI outcome wakes and ci-watch are ONE loop', () => {
  const sha = (i: number) => (i + 0x10).toString(16).padStart(40, '0');
  const spentBudget = () => memStore({
    [laneLedgerKey('lane-1')]: { ...emptyLaneLedger('lane-1'), reds: Array.from({ length: CI_WATCH_LANE_WAKE_MAX }, (_, i) => ({ sha: sha(i), branch: 'digby/session-1', at: at(-200 + i * 30).toISOString(), woken: true })) },
  });

  it('an open merge intent / await_condition ci wait of the lane on the sha owes it the wake: ci-watch adds none inside the hold, and wakes after it (fail toward delivery)', async () => {
    const store = memStore();
    const h = harness({ rows: [push('r1', SHA_A)], store, covers: true });
    await runCiWatchOnce(h.deps(T0));
    expect(h.harnessWaitCovers).toHaveBeenCalledWith('lane-1', SHA_A);
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ state: 'failure', laneWokenAt: null, terminal: false });

    const late = harness({ rows: [push('r1', SHA_A)], store, covers: true });
    await runCiWatchOnce(late.deps(new Date(T0.getTime() + CI_WATCH_PS_MAX_HOLD_MS + 60_000)));
    expect(late.enqueueDirectWake).toHaveBeenCalledTimes(1);
  });

  it('a harness wake booked with noteHarnessRedWake is the sha’s ONE lane wake: ci-watch never wakes again, and the supervisor still hears once the lane idles on red', async () => {
    const store = memStore();
    expect(await noteHarnessRedWake({ chatId: 'lane-1', sha: SHA_A, branch: 'digby/session-1', via: 'merge_intent' }, { now: T0, store: store as any })).toBe('deliver');
    expect(store.m.has(`wake:${SHA_A}`)).toBe(true);
    expect(store.m.get(laneLedgerKey('lane-1')).reds).toEqual([expect.objectContaining({ sha: SHA_A, woken: true })]);

    const h = harness({ rows: [push('r1', SHA_A)], store });
    await runCiWatchOnce(h.deps(at(1)));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ laneWokenAt: at(1).toISOString(), terminal: false });

    const later = harness({ rows: [push('r1', SHA_A)], store });
    await runCiWatchOnce(later.deps(at(12)));
    expect(later.enqueueDirectWake).not.toHaveBeenCalled();
    expect(later.emitCiFailed).toHaveBeenCalledTimes(1);
  });

  it('a booking under an ABBREVIATED sha (an await_condition sha) still dedupes — the ledger matches by prefix: no second wake', async () => {
    const store = memStore({ [laneLedgerKey('lane-1')]: { ...emptyLaneLedger('lane-1'), reds: [{ sha: SHA_A.slice(0, 12), branch: null, at: at(-1).toISOString(), woken: true }] } });
    const h = harness({ rows: [push('r1', SHA_A)], store });
    await runCiWatchOnce(h.deps(T0));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(store.m.get(SHA_A)).toMatchObject({ laneWokenAt: T0.toISOString(), terminal: false });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ci_watch', meta: expect.objectContaining({ phase: 'harness_woken', sha: SHA_A }) }));
  });

  it('harness wakes count toward the lane budget: past it, a watched sha answers "loop" (no lane wake, no claim) and ci-watch makes the ONE lane_loop escalation on it', async () => {
    const store = spentBudget();
    const watch = harness({ rows: [push('r1', SHA_A)], store, ci: PENDING });
    await runCiWatchOnce(watch.deps(T0));
    expect(store.m.get(SHA_A)).toMatchObject({ state: 'pending', terminal: false });

    expect(await noteHarnessRedWake({ chatId: 'lane-1', sha: SHA_A, via: 'merge_intent' }, { now: at(2), store: store as any })).toBe('loop');
    expect(store.m.has(`wake:${SHA_A}`)).toBe(false);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ phase: 'harness_wake', verdict: 'loop', via: 'merge_intent' }) }));

    const h = harness({ rows: [push('r1', SHA_A)], store });
    await runCiWatchOnce(h.deps(at(6)));
    expect(h.enqueueDirectWake).not.toHaveBeenCalled();
    expect(h.emitCiFailed).toHaveBeenCalledTimes(1);
    expect((h.emitCiFailed.mock.calls[0] as any[])[3].extra.ciWatchEscalation).toBe('lane_loop');
  });

  it('fail toward delivery: a sha ci-watch does not watch, CI_WATCH_DISABLED=1 and a store error all answer "deliver"', async () => {
    const store = spentBudget();
    expect(await noteHarnessRedWake({ chatId: 'lane-1', sha: SHA_B, via: 'merge_intent' }, { now: T0, store: store as any })).toBe('deliver');
    expect(store.m.has(`wake:${SHA_B}`)).toBe(true);

    process.env.CI_WATCH_DISABLED = '1';
    const off = memStore();
    expect(await noteHarnessRedWake({ chatId: 'lane-1', sha: SHA_C, via: 'await_condition' }, { now: T0, store: off as any })).toBe('deliver');
    expect(off.getMany).not.toHaveBeenCalled();
    delete process.env.CI_WATCH_DISABLED;

    const broken = memStore();
    broken.getMany = jest.fn(async () => { throw new Error('db down'); }) as any;
    expect(await noteHarnessRedWake({ chatId: 'lane-1', sha: SHA_C, via: 'await_condition' }, { now: T0, store: broken as any })).toBe('deliver');
  });
});
