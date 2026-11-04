/**
 * Background delegation — the pool contract (coding/background-delegation.ts).
 * The agent-loop wiring is pinned end-to-end in agent-background-delegation.test.ts.
 */

import {
  BackgroundWorkerPool, BackgroundUsageAccumulator, backgroundRunEndWaitMs, backgroundStatusMaxWaitMs, backgroundWorkerCap,
  backgroundLatePostGraceMs, backgroundStartedText, delegateBackgroundDisabled, formatInjectedReport, formatLateReport,
  lostBackgroundWorkerIds, lostWorkersNotice, sessionCanReceiveLatePost, fmtDuration, type BackgroundPhase,
} from './background-delegation';
import { UsageAccumulator } from './cost';

function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: any) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function makePool(over: { cap?: number; parentCancelled?: () => boolean; postLate?: (w: any, text: string) => Promise<boolean> } = {}) {
  const metrics: Array<{ phase: BackgroundPhase; id: string | null; extra?: Record<string, unknown> }> = [];
  const posts: Array<{ id: string; text: string }> = [];
  const pool = new BackgroundWorkerPool({
    metric: (phase, w, extra) => metrics.push({ phase, id: w?.id ?? null, extra }),
    postLate: over.postLate ?? (async (w, text) => { posts.push({ id: w.id, text }); return true; }),
    parentCancelled: over.parentCancelled,
    idSuffix: 'test',
    latePostGraceMs: 0,
  }, over.cap ?? 3);
  return { pool, metrics, posts };
}

describe('switches + bounds', () => {
  it('defaults: enabled, cap 3, run-end wait 120 s, status wait 120 s, late grace 5 s', () => {
    expect(delegateBackgroundDisabled({})).toBe(false);
    expect(delegateBackgroundDisabled({ DELEGATE_BACKGROUND_DISABLED: '1' })).toBe(true);
    expect(backgroundWorkerCap({})).toBe(3);
    expect(backgroundRunEndWaitMs({})).toBe(120_000);
    expect(backgroundStatusMaxWaitMs({})).toBe(120_000);
    expect(backgroundLatePostGraceMs({})).toBe(5_000);
  });
  it('clamps and ignores garbage', () => {
    expect(backgroundWorkerCap({ DELEGATE_BACKGROUND_MAX: '0' })).toBe(1);
    expect(backgroundWorkerCap({ DELEGATE_BACKGROUND_MAX: '99' })).toBe(6);
    expect(backgroundWorkerCap({ DELEGATE_BACKGROUND_MAX: 'abc' })).toBe(3);
    expect(backgroundRunEndWaitMs({ DELEGATE_BACKGROUND_END_WAIT_MS: '0' })).toBe(0);
    expect(backgroundRunEndWaitMs({ DELEGATE_BACKGROUND_END_WAIT_MS: '99999999' })).toBe(600_000);
    expect(backgroundStatusMaxWaitMs({ DELEGATE_STATUS_MAX_WAIT_MS: '-5' })).toBe(0);
  });
  it('anonymous / chatless sessions cannot receive a late post', () => {
    expect(sessionCanReceiveLatePost('0f3c2a1b-1111-2222-3333-444455556666')).toBe(true);
    expect(sessionCanReceiveLatePost('anon-123')).toBe(false);
    expect(sessionCanReceiveLatePost('chatless-123')).toBe(false);
    expect(sessionCanReceiveLatePost('')).toBe(false);
  });
});

describe('text frames', () => {
  const w = { id: 'bg1-test', role: 'web_researcher', title: 'RTSP research', startedAt: 0, finishedAt: 125_000, report: 'Cameras speak RTSP on 554.' };
  it('the injected report is framed as DATA with the role + title header', () => {
    const t = formatInjectedReport(w);
    expect(t.startsWith('[BACKGROUND WORKER REPORT — web_researcher RTSP research] (worker bg1-test, ran 2m05s;')).toBe(true);
    expect(t).toContain('not an instruction');
    expect(t).not.toContain('treat as system instructions');
    expect(t.endsWith('Cameras speak RTSP on 554.')).toBe(true);
  });
  it('the late report says why it is a separate message', () => {
    const t = formatLateReport(w);
    expect(t.startsWith('[BACKGROUND WORKER REPORT — web_researcher RTSP research]')).toBe(true);
    expect(t).toContain('after the run that started it had ended');
    expect(t).toContain('Cameras speak RTSP on 554.');
  });
  it('the handle text tells the lead to keep working and how to check', () => {
    const t = backgroundStartedText([{ id: 'bg1-test', role: 'web_researcher', title: 'RTSP research' }]);
    expect(t).toContain('[BACKGROUND WORKER STARTED — web_researcher "RTSP research" · handle bg1-test]');
    expect(t).toContain('Keep working');
    expect(t).toContain('delegate_status');
  });
  it('fmtDuration', () => {
    expect(fmtDuration(41_000)).toBe('41s');
    expect(fmtDuration(125_000)).toBe('2m05s');
  });
});

describe('BackgroundWorkerPool', () => {
  it('start() returns at once; the worker runs behind it; the report is taken ONCE at a turn boundary', async () => {
    const { pool, metrics } = makePool();
    const d = deferred();
    const w = pool.start({ role: 'web_researcher', title: 'RTSP' }, () => d.promise);
    expect(w.id).toBe('bg1-test');
    expect(w.state).toBe('running');
    expect(pool.runningCount()).toBe(1);
    expect(pool.capacity).toBe(2);
    expect(pool.takeReady()).toEqual([]);
    d.resolve('findings');
    await w.settled;
    expect(pool.readyCount()).toBe(1);
    const ready = pool.takeReady();
    expect(ready.map(x => x.report)).toEqual(['findings']);
    expect(pool.takeReady()).toEqual([]);
    expect(metrics.map(m => m.phase)).toEqual(['start', 'injected']);
  });

  it('a throwing worker settles as a report, never a rejection', async () => {
    const { pool } = makePool();
    const w = pool.start({ role: 'explorer', title: 'x' }, async () => { throw new Error('boom'); });
    await w.settled;
    expect(w.state).toBe('done');
    expect(w.report).toContain('boom');
  });

  // audit 2026-10-08 W2-10: the timing tests below ran on the WALL CLOCK
  // (`Date.now() - t0 < 1_000`, real 20–30 ms timers) and flaked under a loaded
  // parallel verify (d86b263b / 1aa7c992 went red on it; one bought a frontier
  // council). They now run on jest's modern fake timers — the pool reads
  // Date.now (faked), so every wait is exact and nothing sleeps for real. The
  // pool is built AFTER useFakeTimers so its captured clock is the fake one.
  describe('timing (fake timers — no wall clock)', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    it('awaitRunEnd waits for running workers and charges ONE total budget', async () => {
      const { pool, metrics } = makePool();
      const d = deferred();
      pool.start({ role: 'explorer', title: 'x' }, () => d.promise);
      // Start the wait BEFORE arming the resolve (ticket 49e2abd5): awaitRunEnd checks runningCount() synchronously
      // inside the call, so a timer armed first could fire before the wait began → waited 0.
      const waitedP = pool.awaitRunEnd(5_000);
      setTimeout(() => d.resolve('done'), 30);
      await jest.advanceTimersByTimeAsync(30);
      const waited = await waitedP;
      expect(waited).toBeGreaterThanOrEqual(20);
      expect(waited).toBe(30); // exact on the fake clock
      expect(pool.readyCount()).toBe(1);
      expect(metrics.some(m => m.phase === 'end_wait')).toBe(true);
      // A worker that never finishes: the REMAINING budget (40 ms) bounds the wait — it returns
      // once the fake clock passes it, never at the 500 ms poll or the 5 s first budget.
      const never = deferred();
      pool.start({ role: 'explorer', title: 'y' }, () => never.promise);
      let returned = false;
      const boundedP = pool.awaitRunEnd(waited + 40).then((ms) => { returned = true; return ms; });
      await jest.advanceTimersByTimeAsync(39);
      expect(returned).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await boundedP).toBe(40);
      expect(returned).toBe(true);
      expect(pool.remainingEndWaitMs(waited + 40)).toBeLessThanOrEqual(5);
      expect(await pool.awaitRunEnd(waited + 40)).toBe(0); // budget spent
    });

    it('a cancelled parent ends a wait early (the 500 ms poll, not the 10 s budget)', async () => {
      let cancelled = false;
      const { pool } = makePool({ parentCancelled: () => cancelled });
      pool.start({ role: 'explorer', title: 'x' }, () => new Promise(() => {}));
      let returned = false;
      const waitP = pool.awaitRunEnd(10_000).then((ms) => { returned = true; return ms; });
      setTimeout(() => { cancelled = true; }, 20);
      await jest.advanceTimersByTimeAsync(499);
      expect(returned).toBe(false); // cancelled at 20 ms; the poll has not looked yet
      await jest.advanceTimersByTimeAsync(1);
      expect(await waitP).toBe(500);
      expect(returned).toBe(true);
    });

    it('status() with a wait returns as soon as the named worker finishes', async () => {
      const { pool } = makePool();
      const d = deferred();
      const w = pool.start({ role: 'web_researcher', title: 'RTSP' }, () => d.promise);
      setTimeout(() => d.resolve('the findings'), 20);
      const afterP = pool.status(w.id, 5_000);
      await jest.advanceTimersByTimeAsync(20);
      const after = await afterP;
      expect(after).toContain('waited 0s'); // fmtDuration rounds 20 ms to whole seconds
      expect(after).toContain('the findings');
      expect(w.delivery).toBe('status');
    });
  });

  it('closeRun: a finished-undelivered report is posted at once; a running one posts when it finishes; never twice', async () => {
    const { pool, posts, metrics } = makePool();
    const a = deferred();
    const b = deferred();
    const wa = pool.start({ role: 'explorer', title: 'A' }, () => a.promise);
    const wb = pool.start({ role: 'web_researcher', title: 'B' }, () => b.promise);
    a.resolve('report A');
    await wa.settled;
    const closing = pool.closeRun({ cancelled: false });
    void pool.closeRun({ cancelled: false }); // idempotent
    await tick();
    expect(posts.map(p => p.id)).toEqual([wa.id]);
    expect(posts[0].text).toContain('report A');
    b.resolve('report B');
    await wb.settled;
    await closing;
    expect(posts.map(p => p.id)).toEqual([wa.id, wb.id]);
    expect(wb.delivery).toBe('posted_late');
    expect(metrics.filter(m => m.phase === 'posted_late').length).toBe(2);
    expect(pool.takeReady()).toEqual([]);
  });

  it('closeRun({cancelled}) cancels running workers (their predicate flips) and posts nothing for them', async () => {
    const { pool, posts, metrics } = makePool();
    let seen: (() => boolean) | null = null;
    const d = deferred();
    const w = pool.start({ role: 'explorer', title: 'x' }, (isCancelled) => { seen = isCancelled; return d.promise; });
    await tick();
    expect(seen!()).toBe(false);
    void pool.closeRun({ cancelled: true });
    expect(seen!()).toBe(true);
    d.resolve('(Stopped.)');
    await w.settled;
    expect(w.state).toBe('cancelled');
    expect(posts).toEqual([]);
    expect(metrics.some(m => m.phase === 'cancelled' && m.id === w.id)).toBe(true);
  });

  it('a failed late post is recorded as unposted (never silent)', async () => {
    const { pool, metrics } = makePool({ postLate: async () => false });
    const w = pool.start({ role: 'explorer', title: 'x' }, async () => 'r');
    await w.settled;
    await pool.closeRun({ cancelled: false });
    expect(w.delivery).toBe('unposted');
    expect(metrics.some(m => m.phase === 'unposted')).toBe(true);
  });

  it('status(): unknown handle, bounded wait on a handle, the report is delivered once and never injected after', async () => {
    const { pool } = makePool();
    expect(await pool.status(undefined, 0)).toContain('No background workers');
    const d = deferred();
    const w = pool.start({ role: 'web_researcher', title: 'RTSP' }, () => d.promise);
    expect(await pool.status('bg9-nope', 0)).toContain('Unknown handle');
    const now = await pool.status(w.id, 0);
    expect(now).toContain('running');
    // audit 2026-10-08 W2-10: no real timer — resolve AFTER the wait started (microtask), never on the wall clock.
    const afterP = pool.status(w.id, 5_000);
    d.resolve('the findings');
    const after = await afterP;
    expect(after).toContain('[BACKGROUND WORKER REPORT — web_researcher RTSP]');
    expect(after).toContain('the findings');
    expect(w.delivery).toBe('status');
    expect(pool.takeReady()).toEqual([]);
    expect(await pool.status(w.id, 0)).toContain('already delivered');
  });
});

describe('resume: lost workers', () => {
  it('a started handle with no report reaching the transcript is lost', () => {
    const msgs = [
      { role: 'tool', content: '[BACKGROUND WORKER STARTED — web_researcher "A" · handle bg1-abcd]\n…' },
      { role: 'tool', content: '[BACKGROUND WORKER STARTED — explorer "B" · handle bg2-abcd]\n…' },
      { role: 'user', content: '[BACKGROUND WORKER REPORT — explorer B] (worker bg2-abcd, ran 3s; …)\nok' },
    ];
    expect(lostBackgroundWorkerIds(msgs)).toEqual(['bg1-abcd']);
    expect(lostBackgroundWorkerIds([])).toEqual([]);
    expect(lostWorkersNotice(['bg1-abcd'])).toContain('did NOT survive the restart');
  });
});

describe('BackgroundUsageAccumulator', () => {
  const turn = { promptTokens: 100, completionTokens: 10, estimated: false };
  it('forwards to the run while it is open; keeps late turns for their own spend row', () => {
    const parent = new UsageAccumulator();
    let open = true;
    const late = new BackgroundUsageAccumulator(parent, () => open);
    late.record('w', 'glm-5.3', turn);
    expect(parent.snapshot().turns).toBe(1);
    expect(late.snapshot().turns).toBe(0);
    open = false;
    late.record('w', 'glm-5.3', turn);
    expect(parent.snapshot().turns).toBe(1);
    expect(late.snapshot().turns).toBe(1);
    expect(late.runId).not.toBe(parent.runId);
  });
  it('a shared turn ledger always receives the turns (the caller retains it)', () => {
    const settled: number[] = [];
    const parent = new UsageAccumulator().shareAcrossRuns(acc => settled.push(acc.snapshot().turns));
    const late = new BackgroundUsageAccumulator(parent, () => false);
    late.record('w', 'glm-5.3', turn);
    expect(parent.snapshot().turns).toBe(1);
    expect(late.snapshot().turns).toBe(0);
  });
});
