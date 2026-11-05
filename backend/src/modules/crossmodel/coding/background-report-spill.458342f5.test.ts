/**
 * Ticket 458342f5 — REPLAY: a completed background-worker report must survive a
 * mid-run container replacement.
 *
 * THE MISHAP (prod 2026-11-04, coding lane 19dd22bc run 1cc81223 — a run that
 * outlived TWO container replacements): a background worker that had already
 * FINISHED was indistinguishable, on resume, from one that was still running.
 * Its report lived only in the dead process's `BackgroundWorker` object, so the
 * resume path declared it lost ("did NOT survive the restart — their reports
 * will never arrive") and the lead had to buy a whole second adversarial-review
 * delegation — ~30 min of critical path on a prod-gated pass — for output it had
 * already paid for.
 *
 * WHAT THIS FILE PINS (the regression, exactly, without a database):
 *   1. the pure split — a finished worker's spilled report is RECOVERED and only
 *      workers with no completed report are announced as lost (the pre-fix
 *      behaviour: everything started-and-undelivered was "lost");
 *   2. the recovered frame tells the lead NOT to re-delegate, and a truncated
 *      spill says so;
 *   3. the pool spills a report the instant the worker settles as done, and
 *      NEVER for a cancelled worker (it produced no report);
 *   4. the pool keeps a spill whose late post FAILED ('unposted' — the exact
 *      lost-work case) and drops it once the report is durable elsewhere;
 *   5. the spill is written BEFORE the spend hand-off, so the window in which a
 *      finished report exists only in this process is as small as it can be.
 *
 * The end-to-end resume path (spilled report injected into the resumed lead's
 * transcript instead of the lost notice) is pinned in
 * agent-background-delegation.test.ts (describe 'resume').
 */

import {
  BACKGROUND_SPILL_REPORT_MAX_CHARS,
  BACKGROUND_SPILL_TTL_MS,
  BackgroundWorkerPool,
  backgroundSpillNamespace,
  backgroundSpillValue,
  formatRecoveredReport,
  finalizeSpillClearIds,
  formatInjectedReport,
  lostBackgroundWorkerIds,
  recoverBackgroundReportsOnResume,
  spillBackgroundReport,
  splitRecoveredWorkers,
  type BackgroundPoolDeps,
  type SpilledBackgroundReport,
} from './background-delegation';

// The store seam, stubbed — the spill's READ shape is what two review findings
// were about, so it is pinned here rather than left to an integration suite.
const _mockStore = new Map<string, any>();
const mockStoreGet = jest.fn(async (ns: string[], key: string) => _mockStore.get(ns.join('/') + '::' + key) ?? null);
const mockStoreGetMany = jest.fn(async (ns: string[], keys: string[]) => {
  const out = new Map<string, any>();
  for (const k of keys) {
    const v = _mockStore.get(ns.join('/') + '::' + k);
    if (v !== undefined) out.set(k, v);
  }
  return out;
});
const mockStorePut = jest.fn(async (ns: string[], key: string, value: any) => { _mockStore.set(ns.join('/') + '::' + key, value); });
const mockStoreDelete = jest.fn(async (ns: string[], key: string) => { _mockStore.delete(ns.join('/') + '::' + key); });
const mockStoreListNamespace = jest.fn(async () => {
  throw new Error('a resume must never enumerate the spill namespace — the ASC-ordered list cap would drop the newest rows');
});
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => (mockStoreGet as any)(...a),
  storeGetMany: (...a: any[]) => (mockStoreGetMany as any)(...a),
  storePut: (...a: any[]) => (mockStorePut as any)(...a),
  storeDelete: (...a: any[]) => (mockStoreDelete as any)(...a),
  storeListNamespace: (...a: any[]) => (mockStoreListNamespace as any)(...a),
}));

const noopMetric = () => {};

function pool(over: Partial<BackgroundPoolDeps> = {}, cap = 4) {
  const deps = {
    metric: noopMetric,
    postLate: jest.fn(async () => true),
    latePostGraceMs: 0,
    ...over,
  } as unknown as BackgroundPoolDeps;
  return { pool: new BackgroundWorkerPool(deps, cap), deps };
}

const settleWorker = async (p: BackgroundWorkerPool, report: string, run?: (w: any) => Promise<string>) => {
  const w = p.start({ role: 'reviewer', title: 'Adversarial review' }, run ?? (async () => report));
  await w.settled;
  return w;
};

describe('458342f5 — the pure resume split (a FINISHED worker is not a lost worker)', () => {
  test('a spilled report is RECOVERED; only workers with no completed report stay lost', () => {
    const spill = backgroundSpillValue({
      id: 'bg1-abcd', role: 'reviewer', title: 'Adversarial review',
      startedAt: 1_000, finishedAt: 61_000, report: 'RULING: merge-safe, two nits.',
    });

    // The mishap's exact shape: bg1 finished before the restart, bg2 was still
    // running when the process died (nothing to recover for it).
    const { recovered, stillLost } = splitRecoveredWorkers(['bg1-abcd', 'bg2-abcd'], [spill]);

    expect(recovered.map(r => r.id)).toEqual(['bg1-abcd']);
    expect(recovered[0].report).toContain('RULING: merge-safe');
    expect(stillLost).toEqual(['bg2-abcd']);
  });

  test('PRE-FIX BEHAVIOUR (the regression): with no spill, every handle is lost — which is why a completed report vanished', () => {
    const { recovered, stillLost } = splitRecoveredWorkers(['bg1-abcd'], []);
    expect(recovered).toEqual([]);
    expect(stillLost).toEqual(['bg1-abcd']);
  });

  /**
   * REVIEW FINDING 8 (2026-11-04): the first cut of this case called
   * `splitRecoveredWorkers([], [spill])` — with an EMPTY lostIds list that is
   * true of ANY implementation, including a broken one, so it asserted the
   * claim without pinning it. The real double-delivery gate is
   * `lostBackgroundWorkerIds`' transcript regexes, so drive THAT: a transcript
   * that already carries the INJECTED report must not hand the handle back as
   * lost, and therefore no spill row can ever be injected for it.
   */
  test('a spill for a handle whose report was already DELIVERED is never re-injected (double-delivery gate)', () => {
    const spill = backgroundSpillValue({ id: 'bg9-abcd', role: 'reviewer', title: 'done', startedAt: 0, finishedAt: 1, report: 'already delivered' });
    // The exact transcript an in-run injection leaves behind.
    const injected = formatInjectedReport({ id: 'bg9-abcd', role: 'reviewer', title: 'done', startedAt: 0, finishedAt: 1, report: 'already delivered' });
    const transcript = [
      { role: 'tool', content: '[BACKGROUND WORKER STARTED — reviewer "done" · handle bg9-abcd]\nIt is running in the background…' },
      { role: 'user', content: injected },
    ];
    // The gate excludes it → recovery is never even attempted for this handle.
    expect(lostBackgroundWorkerIds(transcript)).toEqual([]);
    const { recovered, stillLost } = splitRecoveredWorkers(lostBackgroundWorkerIds(transcript), [spill]);
    expect(recovered).toEqual([]);
    expect(stillLost).toEqual([]);
    // …and the positive control: WITHOUT the injected row the same handle IS
    // eligible (so the assertion above is not vacuous).
    expect(lostBackgroundWorkerIds([transcript[0]])).toEqual(['bg9-abcd']);
  });

  /**
   * THE TICKET'S OWN SCENARIO, end to end: that run survived TWO container
   * replacements. After the FIRST restart the lead was handed the recovered
   * frame; after the SECOND, that frame is in the checkpoint transcript — so
   * the production `lostBackgroundWorkerIds` must treat the handle as DELIVERED
   * and the (still present) spill row must never be injected again.
   */
  test('a SECOND restart does not re-inject: the recovered frame in the transcript counts as delivery', () => {
    const spill = backgroundSpillValue({
      id: 'bg1-finished', role: 'reviewer', title: 'Adversarial review',
      startedAt: 1_000, finishedAt: 61_000, report: 'VERDICT: merge-safe.',
    });
    // The exact transcript a first resume leaves behind: the STARTED handle line
    // from the tool result, then the RECOVERED report as a user message.
    const transcript = [
      { role: 'tool', tool_call_id: 't1', content: '[BACKGROUND WORKER STARTED — reviewer "Adversarial review" · handle bg1-finished]\nIt is running in the background…' },
      { role: 'user', content: formatRecoveredReport(spill) },
    ];
    expect(lostBackgroundWorkerIds(transcript)).toEqual([]);
    // …and therefore the resume path never even consults the spill for it.
    const { recovered, stillLost } = splitRecoveredWorkers(lostBackgroundWorkerIds(transcript), [spill]);
    expect(recovered).toEqual([]);
    expect(stillLost).toEqual([]);
  });

  test('order follows the transcript handles, and duplicates in the spill list do not duplicate injection', () => {
    const a = backgroundSpillValue({ id: 'bg1', role: 'reviewer', title: 'a', startedAt: 0, finishedAt: 5, report: 'A' });
    const b = backgroundSpillValue({ id: 'bg2', role: 'explorer', title: 'b', startedAt: 0, finishedAt: 5, report: 'B' });
    const { recovered } = splitRecoveredWorkers(['bg2', 'bg1'], [a, b, a, b]);
    expect(recovered.map(r => r.report)).toEqual(['B', 'A']);
  });

  test('a malformed spill row is ignored rather than injected as an empty report', () => {
    const junk = [{ nope: true } as any, null as any, { id: 'bg1', report: undefined } as any];
    const { recovered, stillLost } = splitRecoveredWorkers(['bg1'], junk as any);
    expect(recovered).toEqual([]);
    expect(stillLost).toEqual(['bg1']);
  });
});

describe('458342f5 — the recovered frame', () => {
  test('says the worker FINISHED and must NOT be re-delegated (the ~30 min second cycle the mishap cost)', () => {
    const text = formatRecoveredReport(backgroundSpillValue({
      id: 'bg1-abcd', role: 'reviewer', title: 'Adversarial review',
      startedAt: 1_000, finishedAt: 121_000, report: 'RULING: ship it.',
    }));
    expect(text).toContain('BACKGROUND WORKER REPORT');
    expect(text).toContain('bg1-abcd');
    expect(text).toContain('RECOVERED');
    expect(text).toContain('do not re-delegate');
    expect(text).toContain('not typed by the user');
    expect(text).toContain('RULING: ship it.');
    expect(text).not.toContain('TRUNCATED');
  });

  test('an over-cap report is bounded AND flagged, so the lead knows a tail exists', () => {
    const huge = 'x'.repeat(BACKGROUND_SPILL_REPORT_MAX_CHARS + 500);
    const value = backgroundSpillValue({ id: 'bg1', role: 'reviewer', title: 'big', startedAt: 0, finishedAt: 1, report: huge });
    expect(value.report).toHaveLength(BACKGROUND_SPILL_REPORT_MAX_CHARS);
    expect(value.truncated).toBe(true);
    expect(formatRecoveredReport(value)).toContain('TRUNCATED');
  });

  test('the spill value carries the attribution a resumed lead needs', () => {
    const v = backgroundSpillValue({ id: 'bg1', role: 'reviewer', title: 'Adversarial review', startedAt: 10, finishedAt: 90, report: 'ok' }, 'run-1');
    expect(v).toEqual(expect.objectContaining({ id: 'bg1', role: 'reviewer', title: 'Adversarial review', startedAt: 10, finishedAt: 90, report: 'ok', runId: 'run-1' }));
    expect(typeof v.at).toBe('number');
  });

  test('the namespace is chat-scoped under the purge-covered kind', () => {
    expect(backgroundSpillNamespace('chat-1')).toEqual(['chat-1', 'background-report']);
  });
});

describe('458342f5 — the spill row itself (two review findings, 2026-11-04)', () => {
  test('a spill is written WITH a TTL — an unrecovered row must not accumulate forever', async () => {
    const { spillBackgroundReport } = require('./background-delegation');
    mockStorePut.mockClear();
    const ok = await spillBackgroundReport('chat-ttl', { id: 'bg1', role: 'reviewer', title: 't', startedAt: 0, finishedAt: 5, report: 'r' }, 'run-1');
    expect(ok).toBe(true);
    expect(mockStorePut).toHaveBeenCalledTimes(1);
    const [, key, , opts] = mockStorePut.mock.calls[0] as any[];
    expect(key).toBe('bg1');
    expect(opts).toEqual({ ttlMs: BACKGROUND_SPILL_TTL_MS });
    // and the namespace is the chat-scoped one
    expect((mockStorePut.mock.calls[0] as any[])[0]).toEqual(['chat-ttl', 'background-report']);
  });

  /**
   * REVIEW FINDING (2026-11-04): the first cut read the whole namespace with a
   * bounded `limit 24`. `storeListNamespace` orders by createdAt ASC, so on a
   * chat that had spilled more than that it returned the OLDEST rows and
   * silently dropped the report the resume needed — a recall hole inside the
   * fix for a lost-report defect. Reads must be by EXACT handle key.
   */
  test('a resume reads ONLY the handles it needs, by exact key — never a bounded namespace scan', async () => {
    _mockStore.clear();
    // 30 spills, the wanted one LAST (the row an ASC list would drop).
    for (let i = 0; i < 30; i++) {
      _mockStore.set(`chat-many/background-report::bg${i}`, backgroundSpillValue({ id: `bg${i}`, role: 'reviewer', title: `t${i}`, startedAt: 0, finishedAt: 1, report: `report ${i}` }));
    }
    mockStoreGetMany.mockClear();
    const { recovered, stillLost } = await recoverBackgroundReportsOnResume('chat-many', ['bg29']);
    expect(recovered.map(r => r.id)).toEqual(['bg29']);
    expect(recovered[0].report).toBe('report 29');
    expect(stillLost).toEqual([]);
    // the read was keyed, not a scan
    expect(mockStoreListNamespace).not.toHaveBeenCalled();
    expect(mockStoreGetMany.mock.calls[0][1]).toEqual(['bg29']);
  });
});

describe('458342f5 — what a FINALIZING run may clear (review blocking finding 1)', () => {
  const w = (id: string, delivery: any, state: any = 'done') => ({ id, delivery, state });

  test('an INJECTED or STATUS-delivered report is cleared (it is in the transcript)', () => {
    expect(finalizeSpillClearIds([w('a', 'injected'), w('b', 'status')])).toEqual(['a', 'b']);
  });

  /**
   * THE BLOCKING FINDING: `postLate` claims 'posted_late' SYNCHRONOUSLY, before
   * its first await, so at finalize the post may not have landed — and may yet
   * fail into 'unposted'. Clearing here destroyed the only durable copy of
   * exactly the report the feature exists to save.
   */
  test("a 'posted_late' report is NOT cleared at finalize — the pool clears it after the post actually LANDS", () => {
    expect(finalizeSpillClearIds([w('a', 'posted_late')])).toEqual([]);
  });

  test("an 'unposted' report is NOT cleared — that is the lost-work case the spill exists for", () => {
    expect(finalizeSpillClearIds([w('a', 'unposted')])).toEqual([]);
  });

  test('a not-yet-delivered report is NOT cleared (a resume may still need it)', () => {
    expect(finalizeSpillClearIds([w('a', 'none')])).toEqual([]);
  });

  test('a cancelled worker contributes nothing (it produced no report)', () => {
    expect(finalizeSpillClearIds([w('a', 'cancelled', 'cancelled')])).toEqual([]);
  });

  test('recovered ids are cleared and deduped against worker deliveries', () => {
    expect(finalizeSpillClearIds([w('a', 'injected')], ['a', 'r1', 'r1', ''])).toEqual(['a', 'r1']);
  });
});

describe('458342f5 — pool spill lifecycle', () => {
  test('a worker that settles as done is spilled, and BEFORE the spend hand-off', async () => {
    const order: string[] = [];
    const { pool: p } = pool({
      spillReport: jest.fn(async (w: any) => { order.push(`spill:${w.report}`); return true; }),
      onSettled: () => { order.push('onSettled'); },
    });
    const w = await settleWorker(p, 'RULING: merge-safe');
    expect(w.state).toBe('done');
    expect(order).toEqual(['spill:RULING: merge-safe', 'onSettled']);
  });

  test('a CANCELLED worker is not spilled — it produced no report', async () => {
    const spill = jest.fn(async () => true);
    const { pool: p } = pool({ spillReport: spill, parentCancelled: () => true });
    const w = await settleWorker(p, 'never used');
    expect(w.state).toBe('cancelled');
    expect(spill).not.toHaveBeenCalled();
  });

  test('a FAILED worker still spills — its failure text is a report a resumed lead must see', async () => {
    const spill = jest.fn(async () => true);
    const { pool: p } = pool({ spillReport: spill });
    const w = p.start({ role: 'reviewer', title: 'Review' }, async () => { throw new Error('provider died'); });
    await w.settled;
    expect(w.state).toBe('done');
    expect(spill).toHaveBeenCalledTimes(1);
    expect((spill.mock.calls[0] as any[])[0].report).toContain('provider died');
  });

  test('a THROWING spill backend never breaks the run or the pool', async () => {
    const { pool: p } = pool({ spillReport: async () => { throw new Error('db down'); } });
    const w = await settleWorker(p, 'still delivered in-process');
    expect(w.state).toBe('done');
    expect(w.delivery).toBe('none');
    expect(p.takeReady().map(x => x.id)).toEqual([w.id]);
  });

  test('the spill is dropped once a LATE POST lands (the message row is the durable copy)', async () => {
    const clear = jest.fn(async () => 1);
    const { pool: p } = pool({ spillReport: async () => true, clearSpills: clear });
    const w = await settleWorker(p, 'late report');
    await p.closeRun({ cancelled: false });
    expect(clear).toHaveBeenCalledWith([w.id]);
  });

  test('the spill is KEPT when the late post FAILED — the exact lost-work case it exists for', async () => {
    const clear = jest.fn(async () => 0);
    const { pool: p } = pool({ spillReport: async () => true, clearSpills: clear, postLate: async () => false });
    const w = await settleWorker(p, 'late report');
    await p.closeRun({ cancelled: false });
    expect(w.delivery).toBe('unposted');
    expect(clear).not.toHaveBeenCalled();
  });

  test('a report DELIVERED in-run is not cleared by the pool (the run finalize owns that call)', async () => {
    const clear = jest.fn(async () => 0);
    const { pool: p } = pool({ spillReport: async () => true, clearSpills: clear });
    const w = await settleWorker(p, 'in-run report');
    expect(p.takeReady().map(x => x.id)).toEqual([w.id]);
    await p.closeRun({ cancelled: false });
    // delivery === 'injected' — closeRun has nothing to post, and the pool never
    // clears an injected report: its checkpoint transcript may not be written yet.
    expect(clear).not.toHaveBeenCalled();
  });
});