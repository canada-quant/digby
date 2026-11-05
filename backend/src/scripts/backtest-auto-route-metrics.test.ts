/**
 * Pure metric functions of the patience-plan replay probe
 * (scripts/framework-audit/backtest-auto-route.js — §4.5 / §4.6 of
 * docs/PATIENCE_AUTO_ONLY_DEPRECATION_PLAN_2026-09-25.md): Wilson bounds, the
 * confusion matrix, top-label ECE (bins from 1/3), per-option Brier, the
 * McNemar-style paired bound, the user-clustered bootstrap, the label rule,
 * the mergeable aggregate, the verdict table, the dry-run plumbing and the
 * telemetry stub. The probe is plain CommonJS (it runs from /app inside the
 * backend container), so it is required by path here.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const probe: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'backtest-auto-route.js'));

const L1 = 'single_thinking', L2 = 'thinking', L3 = 'deep_research';

describe('wilson', () => {
  it('matches the closed form for 5/10 at z=1.96', () => {
    const w = probe.wilson(5, 10);
    expect(w.p).toBeCloseTo(0.5, 6);
    expect(w.lo).toBeCloseTo(0.2366, 3);
    expect(w.hi).toBeCloseTo(0.7634, 3);
  });
  it('is null on n=0 and bounded on the edges', () => {
    expect(probe.wilson(0, 0)).toEqual({ k: 0, n: 0, p: null, lo: null, hi: null });
    const zero = probe.wilson(0, 34);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeCloseTo(0.1017, 3);
    const all = probe.wilson(300, 300);
    expect(all.hi).toBeCloseTo(1, 9);
    expect(all.lo).toBeGreaterThan(0.98);
  });
});

describe('confusionMatrix', () => {
  it('counts pairs, agreement and routes unknown labels to none', () => {
    const m = probe.confusionMatrix([[L1, L1], [L1, L2], [L3, L3], [null, L2], [L2, 'weird']]);
    expect(m.counts[L1][L1]).toBe(1);
    expect(m.counts[L1][L2]).toBe(1);
    expect(m.counts[L3][L3]).toBe(1);
    expect(m.counts.none[L2]).toBe(1);
    expect(m.counts[L2].none).toBe(1);
    expect(m.n).toBe(3);
    expect(m.agree).toBe(2);
    expect(m.agreeRate).toBeCloseTo(2 / 3, 6);
  });
  it('merges by summing cells', () => {
    const a = probe.confusionMatrix([[L1, L1]]);
    const b = probe.confusionMatrix([[L1, L1], [L2, L3]]);
    const m = probe.mergeConfusion(a, b);
    expect(m.counts[L1][L1]).toBe(2);
    expect(m.counts[L2][L3]).toBe(1);
    expect(m.n).toBe(3);
    expect(m.agreeRate).toBeCloseTo(2 / 3, 6);
  });
});

describe('top-label ECE (bins from 1/3)', () => {
  it('bins like width_bucket over [1/3, 1] and clamps the edges', () => {
    expect(probe.eceBinIndex(1 / 3)).toBe(0);
    expect(probe.eceBinIndex(0.1)).toBe(0);
    expect(probe.eceBinIndex(1)).toBe(probe.ECE_BINS - 1);
    expect(probe.eceBinIndex(0.95)).toBe(probe.ECE_BINS - 1);
    expect(probe.eceBinIndex(0.5)).toBe(1);
    expect(probe.eceBinIndex(NaN)).toBeNull();
  });
  it('is |mean conf − empirical agreement| weighted by bin mass', () => {
    const perfect = probe.eceTopLabel([{ conf: 0.9, agree: true }, { conf: 0.9, agree: true }]);
    expect(perfect.ece).toBeCloseTo(0.1, 6);
    const half = probe.eceTopLabel([{ conf: 0.9, agree: true }, { conf: 0.9, agree: false }]);
    expect(half.ece).toBeCloseTo(0.4, 6);
    // two bins with different masses: 3 rows at 0.95/agree (top) and 1 row at 0.5/disagree (bin 1)
    const mixed = probe.eceTopLabel([{ conf: 0.95, agree: true }, { conf: 0.95, agree: true }, { conf: 0.95, agree: true }, { conf: 0.5, agree: false }]);
    expect(mixed.ece).toBeCloseTo((3 / 4) * 0.05 + (1 / 4) * 0.5, 6);
    expect(mixed.topBucket).toEqual({ n: 3, empAgree: 1 });
    expect(mixed.n).toBe(4);
  });
  it('merges bins by sums', () => {
    const a = probe.newEceBins(); probe.addEceSample(a, 0.9, true);
    const b = probe.newEceBins(); probe.addEceSample(b, 0.9, false);
    const m = probe.eceFromBins(probe.mergeEceBins(a, b));
    expect(m.n).toBe(2);
    expect(m.ece).toBeCloseTo(0.4, 6);
  });
});

describe('Brier', () => {
  it('is 0 for a perfect vector and 2/3 for the uniform vector', () => {
    const acc = probe.newBrier();
    probe.addBrierSample(acc, { [L1]: 1, [L2]: 0, [L3]: 0 }, L1);
    expect(probe.brierFromSums(acc).multiclass).toBeCloseTo(0, 9);
    const uni = probe.newBrier();
    probe.addBrierSample(uni, { [L1]: 1 / 3, [L2]: 1 / 3, [L3]: 1 / 3 }, L2);
    const b = probe.brierFromSums(uni);
    expect(b.multiclass).toBeCloseTo(6 / 9, 9);
    expect(b.perOption[L2]).toBeCloseTo(4 / 9, 9);
    expect(b.perOption[L1]).toBeCloseTo(1 / 9, 9);
  });
  it('ignores partial vectors and unknown actuals', () => {
    const acc = probe.newBrier();
    probe.addBrierSample(acc, { [L1]: 1 }, L1);
    probe.addBrierSample(acc, { [L1]: 1, [L2]: 0, [L3]: 0 }, 'fast');
    expect(probe.brierFromSums(acc).n).toBe(0);
  });
});

describe('pairedDiffCI (McNemar-style)', () => {
  it('centres on (b − c)/n with the paired Wald SE', () => {
    const r = probe.pairedDiffCI(10, 0, 100);
    expect(r.diff).toBeCloseTo(0.1, 9);
    // var = b + c − (b−c)²/n = 10 − 1 = 9 → se = 3/100
    expect(r.lo).toBeCloseTo(0.1 - 1.96 * 0.03, 9);
    expect(r.hi).toBeCloseTo(0.1 + 1.96 * 0.03, 9);
    expect(r.discordance).toBeCloseTo(0.1, 9);
  });
  it('is symmetric around 0 when b = c and null on n = 0', () => {
    const r = probe.pairedDiffCI(5, 5, 200);
    expect(r.diff).toBe(0);
    expect(r.lo).toBeCloseTo(-1.96 * Math.sqrt(10) / 200, 9);
    expect(probe.pairedDiffCI(0, 0, 0).diff).toBeNull();
  });
});

describe('quantile + cluster bootstrap', () => {
  it('interpolates linearly', () => {
    expect(probe.quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(probe.quantile([1, 2, 3, 4, 5], 0.95)).toBeCloseTo(4.8, 9);
    expect(probe.quantile([], 0.5)).toBeNull();
  });
  it('is deterministic under a seed and collapses when every cluster is identical', () => {
    const users: Record<string, any> = {};
    for (let i = 0; i < 10; i++) users[`u${i}`] = { uL3: 10, uL3gL3: 8 };
    const stat = (t: any) => (t.uL3 ? t.uL3gL3 / t.uL3 : null);
    const a = probe.clusterBootstrap(users, stat, 200, 3);
    const b = probe.clusterBootstrap(users, stat, 200, 3);
    expect(a).toEqual(b);
    expect(a.point).toBeCloseTo(0.8, 9);
    expect(a.lo).toBeCloseTo(0.8, 9);
    expect(a.hi).toBeCloseTo(0.8, 9);
    expect(a.users).toBe(10);
  });
  it('widens when clusters disagree', () => {
    const users = { a: { uL3: 10, uL3gL3: 10 }, b: { uL3: 10, uL3gL3: 0 }, c: { uL3: 10, uL3gL3: 5 } };
    const r = probe.clusterBootstrap(users, (t: any) => (t.uL3 ? t.uL3gL3 / t.uL3 : null), 300, 5);
    expect(r.point).toBeCloseTo(0.5, 9);
    expect(r.lo).toBeLessThan(0.5);
    expect(r.hi).toBeGreaterThan(0.5);
  });
});

describe('labels', () => {
  it('aliases legacy ids and rejects the rest', () => {
    expect(probe.normalizeLevel('fast')).toBe(L1);
    expect(probe.normalizeLevel('single')).toBe(L1);
    expect(probe.normalizeLevel('deep_research_all')).toBe(L3);
    expect(probe.normalizeLevel('thinking')).toBe(L2);
    expect(probe.normalizeLevel('auto')).toBeNull();
    expect(probe.normalizeLevel('browser_agent')).toBeNull();
  });
  it('H when routing is present, U (contaminated unless user_picked) otherwise', () => {
    const h = probe.labelOf({ mode: L2, routing: { level: L3, source: 'decision', confidence: 0.91 } });
    expect(h.kind).toBe('H'); expect(h.hStored).toBe(L3); expect(h.liveSource).toBe('decision'); expect(h.liveConfidence).toBeCloseTo(0.91, 9);
    const u = probe.labelOf({ mode: 'fast' });
    expect(u.kind).toBe('U'); expect(u.U).toBe(L1); expect(u.contaminated).toBe(true);
    const picked = probe.labelOf({ mode: L3, routingSource: 'user_picked' });
    expect(picked.contaminated).toBe(false);
    expect(probe.labelOf({ mode: 'auto' }).kind).toBe('none');
    expect(probe.labelOf(null).kind).toBe('none');
  });
  it('T prefers the Digby card time over synthesisTime', () => {
    expect(probe.tValueMs({ models: { digby: { time: 1234 } }, synthesisTime: 99 })).toBe(1234);
    expect(probe.tValueMs({ synthesisTime: 99 })).toBe(99);
    expect(probe.tValueMs({})).toBeNull();
  });
  it('hashes user ids with the salt and never echoes them', () => {
    const h = probe.hashUser('salt', 'user-1');
    expect(h).toHaveLength(12);
    expect(h).not.toContain('user');
    expect(probe.hashUser('other', 'user-1')).not.toBe(h);
    expect(probe.hashUser('salt', null)).toBeNull();
  });
});

/** A scored row as runBatch hands it to addRow. */
function row(o: { U?: string | null; H?: string | null; heur: string; choice?: string; conf?: number; user?: string; t?: number; usd?: number; down?: boolean; web?: number; ri?: boolean; so?: boolean }) {
  const label = o.H ? probe.labelOf({ mode: o.H, routing: { level: o.H, source: 'heuristic' } }) : o.U ? probe.labelOf({ mode: o.U }) : probe.labelOf({});
  const gate = o.choice
    ? (() => {
      const thr = probe.DEFAULT_THRESHOLDS[o.choice as string];
      const conf = o.conf ?? 0.95;
      const probabilities: Record<string, number> = {}; for (const k of probe.LEVELS) probabilities[k] = k === o.choice ? conf : (1 - conf) / 2;
      const covered = conf >= thr;
      return { ok: true, choice: o.choice, confidence: conf, probabilities, threshold: thr, covered, atThreshold: covered ? o.choice : o.heur, ms: 150, backend: 'jev', mode: 'act', calibrated: true, cached: false };
    })()
    : null;
  return {
    createdAtIso: '2026-09-10T00:00:00.000Z', segment: 'user', userHash: probe.hashUser('s', o.user || 'u1'),
    label, heuristic: o.heur, heuristicReasonKey: 'default_ensemble', gate,
    tMs: o.t ?? null, spend: o.usd !== undefined ? { usd: o.usd, estimated: false } : null, search: o.web !== undefined ? { webToolCalls: o.web } : null,
    feedback: o.down ? { thumbs_down: 1 } : null, thumbsDown: !!o.down, shift: { researchIntent: !!o.ri, simpleOpener: !!o.so },
  };
}

describe('aggregate + merge', () => {
  it('two batches merged equal one batch with all rows', () => {
    const rows = [row({ U: L1, heur: L1, choice: L1, user: 'a', t: 60000, usd: 0.08, web: 0, so: true }), row({ U: L2, heur: L2, choice: L3, conf: 0.6, user: 'b', t: 240000, usd: 0.2, down: true }), row({ H: L3, heur: L3, choice: L3, conf: 0.9, user: 'c', t: 900000, ri: true }), row({ U: L3, heur: L2, choice: L1, conf: 0.8, user: 'a', t: 800000 })];
    const all = probe.newAgg({ runId: 'r', spec: 'jev' });
    for (const r of rows) probe.addRow(all, r);
    const a = probe.newAgg({ runId: 'r', spec: 'jev' }), b = probe.newAgg({ runId: 'r', spec: 'jev' });
    probe.addRow(a, rows[0]); probe.addRow(a, rows[1]); probe.addRow(b, rows[2]); probe.addRow(b, rows[3]);
    const m = probe.mergeAgg(a, b);
    expect(m.rowsScored).toBe(4);
    expect(m.labels.U.n).toBe(3); expect(m.labels.H.n).toBe(1);
    expect(m.labels.U.byLevel).toEqual(all.labels.U.byLevel);
    expect(m.confusion.U_x_gateAt.counts).toEqual(all.confusion.U_x_gateAt.counts);
    expect(m.escalation).toEqual(all.escalation);
    expect(m.nonInf).toEqual(all.nonInf);
    expect(m.gate.coverage).toEqual(all.gate.coverage);
    expect(m.calibration.eceBinsU).toEqual(all.calibration.eceBinsU);
    expect(m.users.all.sort()).toEqual(all.users.all.sort());
    expect(m.perUser).toEqual(all.perUser);
    expect(m.spend.joined).toBe(2);
    expect(m.feedback.rowsWithDown).toBe(1);
    // gate@τ: row 2's L3 at 0.6 < 0.85 falls back to the heuristic (L2) → agrees with U
    expect(all.confusion.U_x_gateAt.counts[L2][L2]).toBe(1);
    expect(all.confusion.U_x_gateRaw.counts[L2][L3]).toBe(1);
    // row 4: U=L3, gate L1 at 0.8 ≥ 0.7 → under-escalation; heuristic said L2 (wrong too) → c stays 0, b stays 0
    expect(all.escalation.uL3).toBe(1); expect(all.escalation.uL3gL1).toBe(1);
    expect(all.nonInf).toEqual({ n: 3, gateAgree: 2, heurAgree: 2, b: 0, c: 0 });
  });
});

describe('report + verdicts', () => {
  it('prints n/a with the sample rule when the counts are small, and pass when the bars are met', () => {
    const small = probe.newAgg({ runId: 'r', spec: 'jev', window: { from: 'a', to: 'b', days: 30 } });
    probe.addRow(small, row({ U: L1, heur: L1, choice: L1 }));
    const rep = probe.buildReport(small);
    const byMetric: Record<string, any> = Object.fromEntries(rep.verdicts.map((v: any) => [v.metric, v]));
    expect(byMetric['Coverage at threshold'].verdict).toBe('n/a');
    expect(byMetric['Coverage at threshold'].reason).toMatch(/needs ≥ 2,000/);
    expect(byMetric['Telemetry coverage'].verdict).toBe('n/a');
    expect(byMetric['Agreement with heuristic'].verdict).toBe('diagnostic');
    expect(byMetric['Guest segment'].verdict).toBe('n/a');
    // a large, well-behaved corpus: gate == U == heuristic, confident, fast, cheap.
    // 6,000 rows, L3 = every 20th (300 rows = 5 % — under the 8 % absolute promotion bar AND at the
    // ≥ 300 picked-L3 sample rule), L1 ≈ 1,900, L2 the rest. Confidences straddle the two TOP ECE
    // buckets (bins from 1/3, width 1/9: 0.85 → bucket 5 of 6, 0.97 → bucket 6) so the calibration
    // sample rule (≥ 100 in each) is met; ECE = ½·0.03 + ½·0.15 = 0.09.
    const big = probe.newAgg({ runId: 'r', spec: 'jev', window: { from: 'a', to: 'b', days: 30 } });
    const users = Array.from({ length: 30 }, (_, i) => `u${i}`);
    for (let i = 0; i < 6000; i++) {
      const lvl = i % 20 === 0 ? L3 : i % 3 === 0 ? L1 : L2;
      const conf = i % 2 === 0 ? 0.97 : 0.85;
      // users spread with floor(i/7) so every class (incl. the every-20th L3 rows) touches all 30 users
      probe.addRow(big, row({ U: lvl, heur: lvl, choice: lvl, conf, user: users[Math.floor(i / 7) % users.length], t: lvl === L1 ? 60000 : lvl === L2 ? 240000 : 900000, usd: lvl === L1 ? 0.08 : lvl === L2 ? 0.18 : 0.5, web: 1 }));
    }
    const r2 = probe.buildReport(big);
    const v2: Record<string, any> = Object.fromEntries(r2.verdicts.map((v: any) => [v.metric, v]));
    expect(v2['Decision error rate'].verdict).toBe('pass');
    expect(v2['Decision latency p95'].verdict).toBe('pass');
    expect(v2['Coverage at threshold'].verdict).toBe('pass');
    expect(v2['Non-inferiority vs heuristic on U'].verdict).toBe('pass');
    expect(v2['L3 recall'].verdict).toBe('pass');
    expect(v2['Over-escalation (gate L3 where U = L1)'].verdict).toBe('pass');
    expect(v2['Under-escalation (gate L1 where U = L3)'].verdict).toBe('pass');
    expect(v2['Calibration'].verdict).toBe('pass');
    expect(v2['L3 promotion under act'].verdict).toBe('pass');
    expect(v2['Cost (measured)'].verdict).toBe('pass');
    expect(v2['Former-L1 cohort latency'].verdict).toBe('pass');
    expect(r2.users.distinctAll).toBe(30);
    expect(r2.users.classesBelow20Users).toEqual([]);
    expect(r2.escalation.l3Recall.wilson95[0]).toBeGreaterThan(98);
    expect(r2.nonInferiority.lower95Pp).toBe(0);
    expect(r2.calibration.vsU.eceTopLabel).toBeLessThan(0.1);
    // the report never carries a user id or a message
    const text = JSON.stringify(r2);
    expect(text).not.toMatch(/"u\d+"/);
    expect(text).not.toContain('content');
  });
});

describe('dry-run plumbing (stubbed Prisma + stubbed decide)', () => {
  it('advances the cursor across invocations, appends one line per batch, merges to the same totals', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-backtest-test-'));
    try {
      const rt = probe.buildDryRuntime(7);
      const args = probe.parseArgs(['30', 'stub', '100']);
      const a = await probe.runOnce(rt, { ...args, outDir: dir, runId: 'dry-run' }, { floorMs: 0, now: rt.now });
      const b = await probe.runOnce(rt, { ...args, outDir: dir, runId: 'dry-run' }, { floorMs: 0, now: rt.now });
      expect(a.batchIndex).toBe(1); expect(b.batchIndex).toBe(2);
      expect(a.rowsScored).toBe(100); expect(b.rowsScored).toBe(100);
      expect(a.done).toBe(false);
      const lines = fs.readFileSync(path.join(dir, 'dry-run.jsonl'), 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const cursor = JSON.parse(fs.readFileSync(path.join(dir, 'dry-run.cursor.json'), 'utf8'));
      expect(cursor.batchIndex).toBe(2);
      expect(cursor.cursor.chatId).toMatch(/^chat-/);
      expect(cursor.salt).toHaveLength(32);
      let c = b; let guard = 0;
      while (!c.done && guard++ < 10) c = await probe.runOnce(rt, { ...args, outDir: dir, runId: 'dry-run' }, { floorMs: 0, now: rt.now });
      expect(c.done).toBe(true);
      const merged = probe.mergeLines(path.join(dir, 'dry-run.jsonl'));
      expect(merged.rowsScanned).toBe(rt.corpusSize);
      expect(merged.rowsScored + Object.values(merged.skipped).reduce((s: number, v: any) => s + v, 0)).toBe(rt.corpusSize);
      const again = await probe.runOnce(rt, { ...args, outDir: dir, runId: 'dry-run' }, { floorMs: 0, now: rt.now });
      expect(again.done).toBe(true);
      expect(again.message).toMatch(/--merge/);
      const text = JSON.stringify(probe.buildReport(merged));
      expect(text).not.toContain('SYNTHETIC-PRIVATE-MARKER');
      expect(text).not.toContain('"user-');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('telemetry stub', () => {
  it('overwrites both recorders on a writable namespace and counts the intercepted rows', () => {
    const ns: any = { recordLoopMetric: () => { throw new Error('real write'); }, recordLoopMetrics: () => { throw new Error('real write'); } };
    const counter = probe.stubTelemetry(ns);
    ns.recordLoopMetric({ kind: 'decision_gate' });
    ns.recordLoopMetrics([{ kind: 'a' }, { kind: 'b' }]);
    expect(counter.rows).toBe(3);
  });
  it('refuses a non-writable namespace instead of letting decide() write rows', () => {
    const ns: any = {};
    Object.defineProperty(ns, 'recordLoopMetric', { value: () => undefined, writable: false, configurable: false });
    Object.defineProperty(ns, 'recordLoopMetrics', { value: () => undefined, writable: false, configurable: false });
    expect(() => probe.stubTelemetry(ns)).toThrow(/stub did not take/);
  });
});

describe('CLI parsing', () => {
  it('reads the positional contract prodq.sh forwards and the flags', () => {
    expect(probe.parseArgs(['30', 'jev', '300', '/var/tmp/ar-backtest/x.cursor.json'])).toMatchObject({ days: 30, spec: 'jev', batch: 300, cursorFile: '/var/tmp/ar-backtest/x.cursor.json', dryRun: false, merge: null });
    expect(probe.parseArgs([])).toMatchObject({ days: 30, spec: 'deepseek-flash', batch: 300 });
    expect(probe.parseArgs(['--merge', 'ar-20260926-jev-30d'])).toMatchObject({ merge: 'ar-20260926-jev-30d' });
    expect(probe.parseArgs(['--merge'])).toMatchObject({ merge: true });
    expect(() => probe.parseArgs(['0'])).toThrow(/days/);
    expect(() => probe.parseArgs(['30', 'jev', '--bogus'])).toThrow(/unknown flag/);
  });
});
