/**
 * PREMISE REGISTER pins (owner 2026-09-16, framework item 2; hardened after
 * the 2026-09-16 adversarial review). Validation (https-only sources,
 * jsonPath|pattern readers, nested-quantifier ban, ≤8 per goal, merge keeps
 * an unchanged premise's check stamps), the SSRF guard (private/loopback/
 * link-local/v4-mapped/unique-local addresses and *.internal hosts refused;
 * DNS lookups timed), the readers (jsonPath; first-capture-group pattern
 * under a hard vm timeout, retried ONCE on a timeout so a CPU-deschedule
 * false positive is absorbed — ticket 640c3bb5), tolerance compare, and the sweep: a NEW drift
 * stamps the premise (merged by key onto the row's CURRENT premises, never a
 * blind overwrite) and wakes the PROJECT supervisor
 * once (24h Redis dedupe on the observed value; a probe error never resets the
 * confirmed state); paused project supervisors fall back to the fleet; a
 * same-key cross-project disagreement wakes the FLEET supervisor ONCE per key
 * listing every goal, deduped 7 days only after the wake succeeded; a premise
 * checked in the last 50 min is skipped; the wall-clock budget stops the sweep.
 */
const mockPrisma: any = {
  projectGoal: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
  crossModelChat: { findFirst: jest.fn(async () => null) },
  crossModelProject: { findFirst: jest.fn(async () => null) },
};
const store = new Map<string, string>();
const mockRedis: any = {
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  set: jest.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
};
const mockRecordLoopMetric = jest.fn();
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));
jest.mock('dns', () => ({ promises: { lookup: jest.fn(async (host: string) => (host === 'private.example' ? [{ address: '10.0.0.5', family: 4 }] : host === 'slow.example' ? new Promise(() => {}) : [{ address: '93.184.216.34', family: 4 }])) } }));

import {
  normalizePremise, normalizePremises, readPremises, isBlockedAddress, isBlockedHostname, isUnsafePattern, fetchPremiseSource,
  readJsonPath, extractObserved, safeMatch, comparePremise, mergeStamps, runPremiseCheckOnce, renderDriftWake, renderConflictWake,
  PREMISE_MAX_PER_GOAL, PREMISE_DRIFT_DEDUPE_SEC, PREMISE_CONFLICT_DEDUPE_SEC,
} from './premise-register';

const NOW = new Date('2026-09-16T21:00:00Z');
const LATER = new Date('2026-09-16T22:05:00Z');
const GOAL_A = 'aaaaaaaa-0000-4000-8000-000000000000';
const GOAL_B = 'bbbbbbbb-0000-4000-8000-000000000000';
const GOAL_C = 'cccccccc-0000-4000-8000-000000000000';
const okResponse = (body: string, contentType = 'application/json', status = 200, headers: Record<string, string> = {}) => ({
  status, ok: status >= 200 && status < 300,
  headers: { get: (k: string) => ({ 'content-type': contentType, ...headers })[k.toLowerCase()] ?? null },
  body: null,
  text: async () => body,
}) as any;

describe('normalizePremise / normalizePremises', () => {
  it('accepts a bare number premise and a sourced one; stamps setBy/setAt', () => {
    const p = normalizePremise({ key: 'untrained_base_suite_mean', value: '60.07', unit: '%', note: 'CanLegalBench v0.8.0 run 2026-08-21' }, { setByChatId: 'c1', now: NOW });
    expect(p).toMatchObject({ key: 'untrained_base_suite_mean', value: 60.07, unit: '%', setByChatId: 'c1', setAt: NOW.toISOString() });
    const s = normalizePremise({ key: 'bench.mean', value: 60.07, source: 'https://bench.example/v0.8.0/summary.json', jsonPath: 'results.suite_mean', tolerance: 0.5 }, { now: NOW });
    expect(s).toMatchObject({ source: 'https://bench.example/v0.8.0/summary.json', jsonPath: 'results.suite_mean', tolerance: 0.5 });
    const t = normalizePremise({ key: 'rate', value: 28, source: 'https://bench.example/a.txt', pattern: 'Suite mean:\\s*([\\d.]+)%' }, { now: NOW });
    expect(t).toMatchObject({ pattern: 'Suite mean:\\s*([\\d.]+)%' });
  });

  it('refuses bad keys, non-numeric values, http sources, credentials, missing readers, both readers, bad paths/patterns, negative tolerance', () => {
    expect(normalizePremise({ key: '', value: 1 })).toMatch(/key must be/);
    expect(normalizePremise({ key: 'has space', value: 1 })).toMatch(/key must be/);
    expect(normalizePremise({ key: 'k', value: 'abc' })).toMatch(/finite number/);
    expect(normalizePremise({ key: 'k', value: 1, source: 'http://x.example/a.json', jsonPath: 'a' })).toMatch(/https URL/);
    expect(normalizePremise({ key: 'k', value: 1, source: 'https://user:pw@x.example/a.json', jsonPath: 'a' })).toMatch(/credentials/);
    expect(normalizePremise({ key: 'k', value: 1, source: 'https://x.example/a.json' })).toMatch(/needs jsonPath/);
    expect(normalizePremise({ key: 'k', value: 1, source: 'https://x.example/a.json', jsonPath: 'a', pattern: '(\\d+)' })).toMatch(/OR pattern/);
    expect(normalizePremise({ key: 'k', value: 1, source: 'https://x.example/a.json', jsonPath: 'a..b' })).toMatch(/jsonPath must be/);
    expect(normalizePremise({ key: 'k', value: 1, source: 'https://x.example/a.txt', pattern: '(' })).toMatch(/valid regex/);
    expect(normalizePremise({ key: 'k', value: 1, source: 'https://x.example/a.txt', pattern: 'mean \\d+' })).toMatch(/capture group/);
    expect(normalizePremise({ key: 'k', value: 1, tolerance: -1 })).toMatch(/tolerance/);
  });

  it('refuses ReDoS-shaped patterns at registration (nested / stacked quantifiers, alternation in a quantified group)', () => {
    for (const bad of ['(a+)+$', '(\\d*)*x', '(a|aa)*b', 'a++', '(x+){2,}', '(.*a.*)+', 'x{99999}']) expect(isUnsafePattern(bad)).toBe(true);
    for (const ok of ['Suite mean:\\s*([\\d.]+)%', 'rate=(\\d+)', '"suite_mean":\\s*([0-9.]+)', '(\\d+(?:\\.\\d+)?) tok/s']) expect(isUnsafePattern(ok)).toBe(false);
    expect(normalizePremise({ key: 'k', value: 1, source: 'https://x.example/a.txt', pattern: '(a+)+$' })).toMatch(/nested or stacked quantifiers/);
  });

  it('merge upserts by key and KEEPS the check stamps of an unchanged premise; replace rewrites; duplicates and >8 refused', () => {
    const existing = [{ key: 'a', value: 1, source: 'https://x.example/a.json', jsonPath: 'v', checkedAt: '2026-09-16T20:00:00Z', observed: 1, drift: 'ok' as const, setAt: '2026-09-15T00:00:00Z' }, { key: 'b', value: 2 }];
    const merged = normalizePremises([{ key: 'a', value: 1, source: 'https://x.example/a.json', jsonPath: 'v' }, { key: 'c', value: 3 }], existing, { now: NOW });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.premises.map((p) => p.key)).toEqual(['a', 'b', 'c']);
      expect(merged.premises[0]).toMatchObject({ checkedAt: '2026-09-16T20:00:00Z', observed: 1, drift: 'ok' });
    }
    const changed = normalizePremises([{ key: 'a', value: 5, source: 'https://x.example/a.json', jsonPath: 'v' }], existing, { now: NOW });
    if (changed.ok) expect(changed.premises[0].checkedAt).toBeUndefined();
    const replaced = normalizePremises([{ key: 'z', value: 9 }], existing, { mode: 'replace', now: NOW });
    if (replaced.ok) expect(replaced.premises.map((p) => p.key)).toEqual(['z']);
    expect(normalizePremises([{ key: 'a', value: 1 }, { key: 'A', value: 2 }], [], {})).toEqual({ ok: false, error: expect.stringContaining('twice') });
    const many = Array.from({ length: PREMISE_MAX_PER_GOAL + 1 }, (_, i) => ({ key: `k${i}`, value: i }));
    expect(normalizePremises(many, [], {})).toEqual({ ok: false, error: expect.stringContaining(`at most ${PREMISE_MAX_PER_GOAL}`) });
    expect(normalizePremises('nope', [], {})).toEqual({ ok: false, error: expect.stringContaining('must be an array') });
  });

  it('readPremises tolerates garbage rows', () => {
    expect(readPremises(null)).toEqual([]);
    expect(readPremises([{ key: 'a', value: '1.5' }, { nope: true }, 'x'])).toEqual([{ key: 'a', value: 1.5 }]);
  });
});

describe('SSRF guard + fetch', () => {
  it('blocks private, loopback, link-local, CGNAT, multicast, v4-mapped, unique-local and *.internal targets', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
    for (const ip of ['93.184.216.34', '172.32.0.1', '8.8.8.8', '2606:4700::1111']) expect(isBlockedAddress(ip)).toBe(false);
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('metadata.google.internal')).toBe(true);
    expect(isBlockedHostname('bench.example')).toBe(false);
  });

  it('refuses http, a host resolving to a private address, a literal private IP, a hanging DNS lookup, and follows at most 2 re-checked redirects', async () => {
    await expect(fetchPremiseSource('http://x.example/a')).rejects.toThrow(/https/);
    await expect(fetchPremiseSource('https://private.example/a.json')).rejects.toThrow(/private/);
    await expect(fetchPremiseSource('https://10.0.0.7/a.json')).rejects.toThrow(/private/);
    jest.useFakeTimers();
    const hang = fetchPremiseSource('https://slow.example/a.json');
    const hangAssert = expect(hang).rejects.toThrow(/lookup timed out/);
    await jest.advanceTimersByTimeAsync(3_500);
    await hangAssert;
    jest.useRealTimers();
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(okResponse('', 'text/plain', 302, { location: 'https://bench.example/b.json' }))
      .mockResolvedValueOnce(okResponse('{"v":1}'));
    const got = await fetchPremiseSource('https://bench.example/a.json', fetchImpl as any);
    expect(got.body).toBe('{"v":1}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const loopy = jest.fn().mockResolvedValue(okResponse('', 'text/plain', 301, { location: 'https://bench.example/again' }));
    await expect(fetchPremiseSource('https://bench.example/a.json', loopy as any)).rejects.toThrow(/too many redirects/);
    const big = jest.fn().mockResolvedValue(okResponse('x', 'text/plain', 200, { 'content-length': '5000000' }));
    await expect(fetchPremiseSource('https://bench.example/big', big as any)).rejects.toThrow(/1 MB/);
    const nope = jest.fn().mockResolvedValue(okResponse('', 'text/plain', 404));
    await expect(fetchPremiseSource('https://bench.example/missing', nope as any)).rejects.toThrow(/HTTP 404/);
  });
});

describe('readers + compare', () => {
  it('jsonPath reads dot/bracket paths; pattern reads the first capture group; tolerance is absolute', () => {
    const doc = { results: { suite_mean: 60.07, runs: [{ score: 52.97 }, { score: 60.07 }] } };
    expect(readJsonPath(doc, 'results.suite_mean')).toBe(60.07);
    expect(readJsonPath(doc, 'results.runs[1].score')).toBe(60.07);
    expect(readJsonPath(doc, 'results.nope.deeper')).toBeUndefined();
    expect(extractObserved({ body: JSON.stringify(doc), contentType: 'application/json' }, { key: 'k', value: 60, jsonPath: 'results.suite_mean' })).toEqual({ observed: 60.07 });
    expect(extractObserved({ body: 'not json', contentType: 'text/plain' }, { key: 'k', value: 60, jsonPath: 'a' })).toEqual({ error: expect.stringContaining('not JSON') });
    expect(extractObserved({ body: 'Suite mean: 60.07% (n=30)', contentType: 'text/plain' }, { key: 'k', value: 60, pattern: 'Suite mean:\\s*([\\d.]+)%' })).toEqual({ observed: 60.07 });
    expect(extractObserved({ body: 'nothing here', contentType: 'text/plain' }, { key: 'k', value: 60, pattern: 'mean:\\s*([\\d.]+)' })).toEqual({ error: expect.stringContaining('did not match') });
    expect(comparePremise({ key: 'k', value: 60.07 }, 60.07)).toBe('ok');
    expect(comparePremise({ key: 'k', value: 60.07, tolerance: 0.5 }, 60.5)).toBe('ok');
    expect(comparePremise({ key: 'k', value: 60.07, tolerance: 0.5 }, 61)).toBe('drift');
    expect(comparePremise({ key: 'k', value: 60.07 }, 60.08)).toBe('drift');
  });

  it('a catastrophic pattern that slipped past registration is terminated by the vm timeout and reads as an error, not a hang', () => {
    const started = Date.now();
    const r = safeMatch('(a+)+$', 'a'.repeat(40) + '!', 120);
    expect(r).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(extractObserved({ body: 'a'.repeat(40) + '!', contentType: 'text/plain' }, { key: 'k', value: 1, pattern: '(a+)+$' })).toEqual({ error: expect.stringContaining('timed out') });
  });

  it('retries a vm timeout ONCE before reporting (ticket 640c3bb5): a CPU-deschedule false positive is absorbed, a truly wedged pattern still errors', () => {
    const fetched = { body: 'Suite mean: 60.07% (n=30)', contentType: 'text/plain' };
    const premise = { key: 'k', value: 60, pattern: 'Suite mean:\\s*([\\d.]+)%' };
    // one deschedule: the first attempt times out, the retry matches — no error surfaces
    const flaky = jest.fn((pat: string, s: string) => safeMatch(pat, s)).mockReturnValueOnce('timeout' as const);
    expect(extractObserved(fetched, premise, flaky as any)).toEqual({ observed: 60.07 });
    expect(flaky).toHaveBeenCalledTimes(2);
    // a clean match is exactly ONE attempt (no needless second run)
    const clean = jest.fn((pat: string, s: string) => safeMatch(pat, s));
    expect(extractObserved(fetched, premise, clean as any)).toEqual({ observed: 60.07 });
    expect(clean).toHaveBeenCalledTimes(1);
    // both attempts time out (a genuinely catastrophic pattern): still the timeout error, bounded at 2×250 ms
    const wedged = jest.fn(() => 'timeout' as const);
    expect(extractObserved(fetched, premise, wedged as any)).toEqual({ error: expect.stringContaining('timed out') });
    expect(wedged).toHaveBeenCalledTimes(2);
    // a throw (invalid regex) is NOT retried — only the 'timeout' sentinel is
    const bad = jest.fn(() => { throw new Error('Invalid regular expression'); });
    expect(extractObserved(fetched, premise, bad as any)).toEqual({ error: 'pattern is not a valid regex' });
    expect(bad).toHaveBeenCalledTimes(1);
  });
});

describe('mergeStamps', () => {
  it('applies stamps only to premises whose key + value + source still match, and reports no change when nothing differs inside the heartbeat window', () => {
    const current = [
      { key: 'a', value: 1, source: 'https://x.example/a.json', jsonPath: 'v', checkedAt: NOW.toISOString(), observed: 1, drift: 'ok' as const },
      { key: 'b', value: 9, source: 'https://x.example/b.json', jsonPath: 'v' }, // refreshed mid-sweep: value differs from the snapshot the stamp was computed against
    ];
    const stamps = [
      { key: 'a', checkedAt: LATER.toISOString(), observed: 1, drift: 'ok' as const, reader: current[0] },
      { key: 'b', checkedAt: LATER.toISOString(), observed: 3, drift: 'drift' as const, driftNote: 'x', reader: { key: 'b', value: 2, source: 'https://x.example/b.json', jsonPath: 'v' } },
    ];
    expect(mergeStamps(current, stamps, LATER)).toBeNull(); // a: unchanged + heartbeat not due; b: snapshot stale → untouched
    const drifted = mergeStamps(current, [{ key: 'a', checkedAt: LATER.toISOString(), observed: 2, drift: 'drift', driftNote: 'moved', reader: current[0] }], LATER);
    expect(drifted?.[0]).toMatchObject({ observed: 2, drift: 'drift', driftNote: 'moved', checkedAt: LATER.toISOString() });
    expect(drifted?.[1]).toEqual(current[1]);
  });
});

describe('runPremiseCheckOnce', () => {
  const wake = jest.fn(async () => ({ ok: true }));
  const goalRow = (id: string, projectId: string, name: string, premises: any[]) => ({ id, userId: 'u1', projectId, title: `Goal ${id.slice(0, 8)}`, status: 'active', premises, updatedAt: new Date('2026-09-16T12:00:00Z'), project: { name } });
  const enabledProject = { projectSupervisorEnabled: true, archivedAt: null };
  beforeEach(() => {
    store.clear(); wake.mockClear(); mockRecordLoopMetric.mockClear(); mockRedis.set.mockClear(); mockRedis.get.mockClear();
    for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) fn.mockReset();
    mockPrisma.projectGoal.findMany.mockResolvedValue([]);
    mockPrisma.projectGoal.update.mockResolvedValue({});
    mockPrisma.crossModelProject.findFirst.mockResolvedValue(enabledProject);
    mockPrisma.crossModelChat.findFirst.mockResolvedValue(null);
    delete process.env.PREMISE_CHECK_DISABLED;
  });
  // the re-read before stamping returns the same row the sweep started from unless a test overrides it
  const rereadSame = (row: any) => mockPrisma.projectGoal.findUnique.mockResolvedValue({ premises: row.premises, updatedAt: row.updatedAt });

  it('a NEW drift stamps the premise (merged onto the re-read row, updatedAt preserved) and wakes the ENABLED project supervisor with [PREMISE DRIFT]; the next hour is silent', async () => {
    const premise = { key: 'untrained_base_suite_mean', value: 60.07, unit: '%', source: 'https://bench.example/summary.json', jsonPath: 'results.suite_mean', tolerance: 0.25, setAt: '2026-09-16T00:00:00Z', setByChatId: 'lane0001-0000' };
    const row = goalRow(GOAL_A, 'p-canlaw', 'CanLaw', [premise]);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([row]); rereadSame(row);
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'sup-canlaw' });
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(JSON.stringify({ results: { suite_mean: 62.4 } })));
    const out = await runPremiseCheckOnce({ fetchImpl: fetchImpl as any, enqueueDirectWake: wake as any, now: NOW });
    expect(out).toMatchObject({ goals: 1, checked: 1, drifted: 1, conflicts: 0, skippedBudget: 0 });
    const upd = mockPrisma.projectGoal.update.mock.calls[0][0];
    expect(upd.data.premises[0]).toMatchObject({ drift: 'drift', observed: 62.4, checkedAt: NOW.toISOString() });
    expect(upd.data.premises[0].driftNote).toContain('62.4%');
    expect(upd.data.updatedAt).toEqual(row.updatedAt); // a framework stamp is not goal activity
    expect(mockPrisma.crossModelProject.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p-canlaw', userId: 'u1' });
    expect(mockPrisma.crossModelChat.findFirst.mock.calls[0][0].where).toMatchObject({ projectId: 'p-canlaw', userId: 'u1', isProjectSupervisor: true });
    expect(wake).toHaveBeenCalledTimes(1);
    const call = (wake.mock.calls[0] as any)[0];
    expect(call.targetChatId).toBe('sup-canlaw');
    expect(call.prompt).toContain('[PREMISE DRIFT] goal aaaaaaaa');
    expect(call.prompt).toContain('untrained_base_suite_mean = 60.07%');
    expect(call.prompt).toContain('now reads 62.4%');
    expect(call.prompt).toContain('goal_premise_set');
    expect(mockRedis.set).toHaveBeenCalledWith(`premise:drift:${GOAL_A}:untrained_base_suite_mean`, '62.4', { EX: PREMISE_DRIFT_DEDUPE_SEC });

    // an hour later: still drifted → stamped, but no second wake (confirmed state + 24h dedupe)
    const stamped = { ...premise, ...upd.data.premises[0] };
    const row2 = goalRow(GOAL_A, 'p-canlaw', 'CanLaw', [stamped]);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([row2]); rereadSame(row2);
    const again = await runPremiseCheckOnce({ fetchImpl: fetchImpl as any, enqueueDirectWake: wake as any, now: LATER });
    expect(again).toMatchObject({ checked: 1, drifted: 0 });
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('a premise checked in the last 50 minutes is skipped; a value inside tolerance reads ok; a fetch failure sets lastError and never overwrites a confirmed state or wakes', async () => {
    const fresh = { key: 'z', value: 1, source: 'https://bench.example/z.json', jsonPath: 'v', checkedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), drift: 'ok' };
    const p1 = { key: 'a', value: 60.07, source: 'https://bench.example/a.json', jsonPath: 'v', tolerance: 0.5 };
    const p2 = { key: 'b', value: 28, source: 'https://bench.example/b.txt', pattern: 'rate=(\\d+)', drift: 'drift', observed: 22, driftNote: 'old drift', checkedAt: '2026-09-16T19:00:00Z' };
    const row = goalRow(GOAL_A, 'p1', 'spark', [fresh, p1, p2]);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([row]); rereadSame(row);
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(okResponse(JSON.stringify({ v: 60.3 })))
      .mockRejectedValueOnce(new Error('ECONNRESET'));
    const out = await runPremiseCheckOnce({ fetchImpl: fetchImpl as any, enqueueDirectWake: wake as any, now: NOW });
    expect(out).toMatchObject({ checked: 2, drifted: 0 });
    const stamped = mockPrisma.projectGoal.update.mock.calls[0][0].data.premises;
    expect(stamped[0]).toEqual(fresh);
    expect(stamped[1]).toMatchObject({ drift: 'ok', observed: 60.3 });
    expect(stamped[2]).toMatchObject({ drift: 'drift', observed: 22, lastError: 'ECONNRESET', lastErrorAt: NOW.toISOString() });
    expect(wake).not.toHaveBeenCalled();
  });

  it('a PAUSED project supervisor is never woken — the drift falls back to the fleet supervisor', async () => {
    const row = goalRow(GOAL_A, 'p-paused', 'Paused', [{ key: 'k', value: 1, source: 'https://bench.example/k.json', jsonPath: 'v' }]);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([row]); rereadSame(row);
    mockPrisma.crossModelProject.findFirst.mockResolvedValueOnce({ projectSupervisorEnabled: false, archivedAt: null });
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'fleet-sup' });
    await runPremiseCheckOnce({ fetchImpl: jest.fn().mockResolvedValue(okResponse('{"v":5}')) as any, enqueueDirectWake: wake as any, now: NOW });
    expect(mockPrisma.crossModelChat.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelChat.findFirst.mock.calls[0][0].where).toMatchObject({ userId: 'u1', isSupervisor: true });
    expect((wake.mock.calls[0] as any)[0].targetChatId).toBe('fleet-sup');
  });

  it('a goal_premise_set that landed mid-sweep is not clobbered: stamps merge onto the re-read row by key + value', async () => {
    const snapshot = { key: 'k', value: 1, source: 'https://bench.example/k.json', jsonPath: 'v' };
    const row = goalRow(GOAL_A, 'p1', 'A', [snapshot]);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([row]);
    // the supervisor refreshed the premise (new value) and added another while we were fetching
    mockPrisma.projectGoal.findUnique.mockResolvedValue({ premises: [{ key: 'k', value: 5, source: 'https://bench.example/k.json', jsonPath: 'v' }, { key: 'new', value: 2 }], updatedAt: LATER });
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'sup' });
    await runPremiseCheckOnce({ fetchImpl: jest.fn().mockResolvedValue(okResponse('{"v":5}')) as any, enqueueDirectWake: wake as any, now: NOW });
    expect(mockPrisma.projectGoal.update).not.toHaveBeenCalled(); // the stale stamp did not match the refreshed value → nothing written
  });

  it('the same key with different values across projects of one owner wakes the FLEET supervisor ONCE per key listing every goal; the 7-day dedupe is stamped only after the wake succeeds', async () => {
    const rows = [
      goalRow(GOAL_A, 'p-canlaw', 'CanLaw', [{ key: 'untrained_base_suite_mean', value: 52.97, unit: '%', setAt: '2026-09-10T00:00:00Z' }]),
      goalRow(GOAL_B, 'p-bench', 'canlegal-bench', [{ key: 'untrained_base_suite_mean', value: 60.07, unit: '%', setAt: '2026-09-16T00:00:00Z' }]),
      goalRow(GOAL_C, 'p-spark', 'spark-cluster', [{ key: 'untrained_base_suite_mean', value: 65, unit: '%' }]),
    ];
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(rows);
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'fleet-sup' });
    const out = await runPremiseCheckOnce({ enqueueDirectWake: wake as any, now: NOW });
    expect(out).toMatchObject({ goals: 3, checked: 0, conflicts: 1 });
    expect(wake).toHaveBeenCalledTimes(1);
    const call = (wake.mock.calls[0] as any)[0];
    expect(call.targetChatId).toBe('fleet-sup');
    expect(call.prompt).toContain('[PREMISE CONFLICT] 3 projects hold different values for the same premise "untrained_base_suite_mean"');
    expect(call.prompt).toContain('CanLaw goal aaaaaaaa');
    expect(call.prompt).toContain('canlegal-bench goal bbbbbbbb');
    expect(call.prompt).toContain('spark-cluster goal cccccccc');
    expect(mockRedis.set).toHaveBeenCalledWith(expect.stringMatching(/^premise:conflict:u1:/), '1', { EX: PREMISE_CONFLICT_DEDUPE_SEC });

    // reversed listing order → same hash → deduped
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([...rows].reverse());
    const again = await runPremiseCheckOnce({ enqueueDirectWake: wake as any, now: LATER });
    expect(again.conflicts).toBe(0);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('with no fleet supervisor the conflict is NOT stamped as handled; a failed wake is not stamped either', async () => {
    const rows = [goalRow(GOAL_A, 'p1', 'A', [{ key: 'k', value: 1 }]), goalRow(GOAL_B, 'p2', 'B', [{ key: 'k', value: 2 }])];
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(rows);
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce(null);
    expect((await runPremiseCheckOnce({ enqueueDirectWake: wake as any, now: NOW })).conflicts).toBe(0);
    expect(mockRedis.set).not.toHaveBeenCalled();
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(rows);
    mockPrisma.crossModelChat.findFirst.mockResolvedValueOnce({ id: 'fleet-sup' });
    const failing = jest.fn(async () => { throw new Error('queue down'); });
    await runPremiseCheckOnce({ enqueueDirectWake: failing as any, now: NOW });
    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  it('same project, different owners, or values within tolerance never conflict; the kill switch short-circuits', async () => {
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([
      goalRow(GOAL_A, 'p1', 'A', [{ key: 'k', value: 1 }]),
      goalRow(GOAL_B, 'p1', 'A', [{ key: 'k', value: 2 }]), // same project
      { ...goalRow(GOAL_C, 'p2', 'B', [{ key: 'k', value: 2 }]), userId: 'u2' }, // other owner
      goalRow('dddddddd-0000-4000-8000-000000000000', 'p3', 'C', [{ key: 'k', value: 1.2, tolerance: 1 }]), // within tolerance of both p1 values
    ]);
    const out = await runPremiseCheckOnce({ enqueueDirectWake: wake as any, now: NOW });
    expect(out.conflicts).toBe(0);
    expect(wake).not.toHaveBeenCalled();
    process.env.PREMISE_CHECK_DISABLED = '1';
    expect(await runPremiseCheckOnce({ enqueueDirectWake: wake as any, now: NOW })).toEqual({ goals: 0, checked: 0, drifted: 0, conflicts: 0, skippedBudget: 0 });
    expect(mockPrisma.projectGoal.findMany).toHaveBeenCalledTimes(1);
  });

  it('the wall-clock budget stops the sweep and counts what it skipped', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => goalRow(`${String(i).repeat(8)}-0000-4000-8000-000000000000`, `p${i}`, `P${i}`, [{ key: 'k', value: 1, source: `https://bench.example/${i}.json`, jsonPath: 'v' }]));
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce(rows);
    mockPrisma.projectGoal.findUnique.mockResolvedValue({ premises: [], updatedAt: NOW });
    const out = await runPremiseCheckOnce({ fetchImpl: jest.fn().mockResolvedValue(okResponse('{"v":1}')) as any, enqueueDirectWake: wake as any, now: NOW, budgetMs: -1 });
    expect(out).toMatchObject({ goals: 6, checked: 0, skippedBudget: 6 });
  });

  it('renderers name ids, values, units and the tools to use', () => {
    const drift = renderDriftWake({ id: GOAL_A, title: 'T', projectName: 'P' }, { key: 'k', value: 1, unit: 'x', observed: 2, source: 'https://s.example/a', tolerance: 0 }, NOW);
    expect(drift).toContain('goal aaaaaaaa "T" (P) rests on premise k = 1x');
    expect(drift).toContain('goal_premise_set');
    const conflict = renderConflictWake('k', [{ id: GOAL_B, title: 'B', projectName: 'PB', p: { key: 'k', value: 2 } }, { id: GOAL_A, title: 'A', projectName: 'PA', p: { key: 'k', value: 1 } }]);
    expect(conflict).toContain('2 projects hold different values for the same premise "k": PA goal aaaaaaaa "A" says 1; PB goal bbbbbbbb "B" says 2');
  });
});

// ── Review fixes (sup3 fixer pass, 2026-09-27 — finding 1): a lane can RECORD
// the measured value of a target premise, and DONE goals inside the suspect
// window are still re-read so a '⚠ suspect' close clears itself. ─────────────
describe('observed / observedNote (finding 1) + done-goal re-check', () => {
  const { PREMISE_CHECK_DONE_WINDOW_MS } = require('./premise-register');
  const wake = jest.fn(async () => ({ ok: true }));
  const goalRow = (id: string, projectId: string, name: string, premises: any[], over: any = {}) => ({ id, userId: 'u1', projectId, title: `Goal ${id.slice(0, 8)}`, status: 'active', premises, updatedAt: new Date('2026-09-16T12:00:00Z'), project: { name }, ...over });
  beforeEach(() => {
    store.clear(); wake.mockClear(); mockRecordLoopMetric.mockClear(); mockRedis.set.mockClear(); mockRedis.get.mockClear();
    for (const m of Object.values(mockPrisma) as any[]) for (const fn of Object.values(m) as any[]) fn.mockReset();
    mockPrisma.projectGoal.findMany.mockResolvedValue([]);
    mockPrisma.projectGoal.update.mockResolvedValue({});
    mockPrisma.crossModelProject.findFirst.mockResolvedValue({ projectSupervisorEnabled: true, archivedAt: null });
    mockPrisma.crossModelChat.findFirst.mockResolvedValue({ id: 'sup' });
    delete process.env.PREMISE_CHECK_DISABLED;
  });

  it('normalizePremise accepts observed (+ observedNote) and stamps observedAt; observedNote without observed and a non-numeric observed are refused', () => {
    const p = normalizePremise({ key: 'target_tok_per_s', value: 20, unit: 'tok/s', observed: '24.1', observedNote: 'run r-9, vllm bench 2026-09-27' }, { now: NOW });
    expect(p).toMatchObject({ key: 'target_tok_per_s', value: 20, observed: 24.1, observedAt: NOW.toISOString(), observedNote: 'run r-9, vllm bench 2026-09-27' });
    expect(normalizePremise({ key: 'k', value: 1, observed: 'n/a' })).toMatch(/observed must be a finite number/);
    expect(normalizePremise({ key: 'k', value: 1, observedNote: 'orphan' })).toMatch(/observedNote needs observed/);
    expect(normalizePremise({ key: 'k', value: 1 }, { now: NOW })).not.toHaveProperty('observed');
    expect(normalizePremise({ key: 'k', value: 1, observed: 3 }, { now: NOW })).not.toHaveProperty('observedNote');
  });

  it('merge: a manual observed in THIS call wins over the old stamp (the rest of the stamp carries over); a re-register WITHOUT observed keeps the old observed / observedAt / observedNote', () => {
    const existing = [{ key: 'target_tok_per_s', value: 20, checkedAt: NOW.toISOString(), observed: 5.33, observedAt: NOW.toISOString(), observedNote: 'old run', drift: 'drift' as const, driftNote: 'x' }];
    const r1 = normalizePremises([{ key: 'target_tok_per_s', value: 20, observed: 24.1, observedNote: 'run r-9' }], existing as any, { mode: 'merge', now: LATER });
    expect(r1.ok).toBe(true);
    expect(r1.ok && r1.premises[0]).toMatchObject({ observed: 24.1, observedAt: LATER.toISOString(), observedNote: 'run r-9', checkedAt: NOW.toISOString(), drift: 'drift', driftNote: 'x' });
    const r2 = normalizePremises([{ key: 'target_tok_per_s', value: 20, note: 'refreshed' }], existing as any, { mode: 'merge', now: LATER });
    expect(r2.ok && r2.premises[0]).toMatchObject({ observed: 5.33, observedAt: NOW.toISOString(), observedNote: 'old run', note: 'refreshed' });
  });

  it('mergeStamps: a source reading supersedes the manual record — observedAt = the check, observedNote dropped', () => {
    const current = [{ key: 'target_tok_per_s', value: 20, source: 'https://x.example/a.json', jsonPath: 'v', observed: 24.1, observedAt: NOW.toISOString(), observedNote: 'run r-9' }];
    const merged = mergeStamps(current as any, [{ key: 'target_tok_per_s', checkedAt: LATER.toISOString(), observed: 21.5, drift: 'drift', driftNote: 'moved', reader: current[0] as any }], LATER);
    expect(merged?.[0]).toMatchObject({ observed: 21.5, observedAt: LATER.toISOString(), checkedAt: LATER.toISOString(), drift: 'drift' });
    expect(merged?.[0]).not.toHaveProperty('observedNote');
    // The same reading again: nothing differs (the manual fields are already gone) and the heartbeat is not due.
    expect(mergeStamps(merged as any, [{ key: 'target_tok_per_s', checkedAt: LATER.toISOString(), observed: 21.5, drift: 'drift', driftNote: 'moved', reader: current[0] as any }], LATER)).toBeNull();
  });

  it('sweep: a DONE goal closed inside the window is re-read and STAMPED (updatedAt preserved) but never woken for drift and never joins a cross-project conflict; the where clause carries the done branch', async () => {
    const premise = { key: 'target_tok_per_s', value: 20, unit: 'tok/s', source: 'https://bench.example/tps.json', jsonPath: 'tps', observed: 5.33, observedAt: '2026-09-15T00:00:00Z', observedNote: 'run r-1' };
    const done = goalRow(GOAL_A, 'p-spark', 'spark-cluster', [premise], { status: 'done', updatedAt: new Date(NOW.getTime() - 2 * 86400_000) });
    // Same key, different value, another project of the same owner — a CONFLICT only if the done goal counted.
    const live = goalRow(GOAL_B, 'p-canlaw', 'CanLaw', [{ key: 'target_tok_per_s', value: 99 }]);
    mockPrisma.projectGoal.findMany.mockResolvedValueOnce([done, live]);
    mockPrisma.projectGoal.findUnique.mockResolvedValue({ premises: done.premises, updatedAt: done.updatedAt });
    const fetchImpl = jest.fn().mockResolvedValue(okResponse(JSON.stringify({ tps: 24.1 })));
    const out = await runPremiseCheckOnce({ fetchImpl: fetchImpl as any, enqueueDirectWake: wake as any, now: NOW });
    expect(mockPrisma.projectGoal.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ status: { in: ['active', 'blocked'] } }, { status: 'done', updatedAt: { gte: new Date(NOW.getTime() - PREMISE_CHECK_DONE_WINDOW_MS) } }],
      NOT: { premises: { equals: [] } },
    });
    expect(out).toMatchObject({ goals: 2, checked: 1, drifted: 0, conflicts: 0 });
    expect(wake).not.toHaveBeenCalled();
    const upd = mockPrisma.projectGoal.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: GOAL_A });
    expect(upd.data.premises[0]).toMatchObject({ observed: 24.1, observedAt: NOW.toISOString(), checkedAt: NOW.toISOString() });
    expect(upd.data.premises[0]).not.toHaveProperty('observedNote');
    expect(upd.data.updatedAt).toEqual(done.updatedAt); // a framework stamp never re-dates the close
  });
});
