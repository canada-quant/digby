/**
 * PIN (FO f144, 2026-10-15) — the supervisor_send_timing_4h p90 bar measures
 * the SEND PATH net of queue-wait, never the raw wall clock.
 *
 * THE FALSE-POSITIVE CLASS THIS PINS: f143 (2026-10-15, errors-view 22:46Z)
 * found the DW-5 p90 bar tripping WITHOUT a send-path defect: five
 * outcome='queued' rows in the 4h window carried value ≈ preemptMs ≈
 * 5017–5089 ms — the DESIGNED ~5 s busy-queue budget (chat-agent.service
 * PREEMPT_WAIT_MS) — while every send leg (auth/busy/mode/deliver) stayed
 * ≤ 56 ms. Raw-p90 ≈ 5081 > the 5000 ms bar ⇒ ESCALATE, wrongly.
 *
 * THE FIX (FS ruling on the f143 trigger-fire): the verdict arm reads
 * p90 over (value − preemptMs, floored at 0) — the send-path legs are the
 * measured surface; queue-wait is budgeted by design. The raw p90 still
 * prints as p90_ms for visibility; p90_path_ms is the verdict's measure.
 * A genuinely slow send path (auth-leg regression à la pre-f110, a deliver
 * stall) still ESCALATEs whether the send queued or not.
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92–f111 pins): the
 * shipped audit declares the recalibrated arm, and a JS model of the
 * percentile + verdict reproduces the f143 regime and the defect regimes.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope (sibling f92–f111 pin tests declare top-level fs/path the same way)

function repoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, 'scripts/framework-audit/audit-live-state.js'))) return d;
    d = path.dirname(d);
  }
  throw new Error('repo root not found from ' + start);
}

const AUDIT = path.join(repoRoot(__dirname), 'scripts/framework-audit/audit-live-state.js');
const src = fs.readFileSync(AUDIT, 'utf8');

/** The 4h section's SQL, extracted from the shipped audit verbatim. */
function sectionSql(): string {
  const m = src.match(/sec\('supervisor_send_timing_4h', \(\) => q\(`([^`]+)`\)\)/);
  if (!m) throw new Error('supervisor_send_timing_4h section not found in audit-live-state.js');
  return m[1];
}

const sql = sectionSql();

/** The net-of-queue-wait expression the recalibrated arm orders by. */
const NET_EXPR = 'GREATEST(0, COALESCE(value, (meta->>\'totalMs\')::numeric) - COALESCE((meta->>\'preemptMs\')::numeric, 0))';

describe('PIN f144: supervisor_send_timing_4h queue-wait recalibration', () => {
  test('the verdict arm orders by value − preemptMs (floored at 0), never the raw total', () => {
    const m = sql.match(/CASE WHEN percentile_cont\(0\.9\) WITHIN GROUP \(ORDER BY (.+?)\) > 5000 THEN 'ESCALATE' ELSE 'ok' END AS verdict/);
    expect(m).toBeTruthy();
    expect(m![1]).toBe(NET_EXPR);
    // the raw-total ordering must NOT survive anywhere in the verdict arm
    expect(m![1]).not.toContain('preemptMs\')::numeric, 0)))::int'); // sanity: the arm is the expression, not a column alias
    expect(sql).toContain("THEN 'ESCALATE' ELSE 'ok' END AS verdict");
  });

  test('p90_path_ms prints the recalibrated measure; raw p90_ms and the leg averages stay', () => {
    expect(sql).toContain(`WITHIN GROUP (ORDER BY ${NET_EXPR})::int AS p90_path_ms`);
    expect(sql).toContain('AS p90_ms');
    expect(sql).toContain('AS p50_ms');
    expect(sql).toContain('AS avg_auth_ms');
    expect(sql).toContain('AS avg_preempt_ms');
    expect(sql).toContain('AS avg_deliver_ms');
    expect(sql).toContain(`interval '4 hours'`);
    expect(sql).toContain("kind='supervisor_send_timing'");
  });

  test('the f68/f111 invariants hold: window filter, group-by-outcome, 5000 bound', () => {
    expect(sql).toMatch(/GROUP BY 1 ORDER BY 2 DESC/);
    expect(sql).toContain('> 5000');
    // the section comment documents the recalibration (the f111 comment-pin shape)
    const iSec = src.indexOf("sec('supervisor_send_timing_4h'");
    const iComment = src.lastIndexOf('// DW-5 (FO firing 68', iSec);
    expect(iComment).toBeGreaterThan(-1);
    const comment = src.slice(iComment, iSec);
    expect(comment).toContain('f144 RECALIBRATION');
    expect(comment).toContain('net of queue-wait');
    expect(comment).toContain('p90_path_ms');
  });
});

/**
 * JS model of the shipped verdict: per-row path duration = max(0, total −
 * preemptMs), percentile_cont(0.9) (continuous interpolation, Postgres
 * semantics) per outcome group, ESCALATE iff p90 > 5000.
 */
function percentileCont(p: number, values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = p * (s.length - 1);
  const lo = Math.floor(rank);
  const frac = rank - lo;
  return s[lo] + frac * ((s[Math.min(lo + 1, s.length - 1)]) - s[lo]);
}

function verdictFor(rows: Array<{ total: number; preemptMs?: number }>): 'ok' | 'ESCALATE' {
  const paths = rows.map((r) => Math.max(0, r.total - (r.preemptMs ?? 0)));
  return percentileCont(0.9, paths) > 5000 ? 'ESCALATE' : 'ok';
}

describe('PIN f144 behavioral: the recalibrated bar across regimes', () => {
  test('the f143 regime — five queued sends at the designed ~5 s busy-queue budget, legs ≤ 56 ms — reads ok', () => {
    // f143 errors-view rows: value ≈ preemptMs ≈ 5017–5089, legs ≤ 56 ms.
    const rows = [
      { total: 5089, preemptMs: 5056 },
      { total: 5081, preemptMs: 5033 },
      { total: 5064, preemptMs: 5017 },
      { total: 5042, preemptMs: 5021 },
      { total: 5022, preemptMs: 5089 }, // preempt ≥ total floors at 0, never negative
    ];
    expect(verdictFor(rows)).toBe('ok');
  });

  test('healthy started sends (21–433 ms, no preempt) read ok', () => {
    const rows = [{ total: 21 }, { total: 433 }, { total: 128 }, { total: 56 }];
    expect(verdictFor(rows)).toBe('ok');
  });

  test('a genuine send-path regression ESCALATEs — started outcome (the pre-f110 auth class)', () => {
    // percentile_cont interpolates: with few rows a single 6 s straggler lands
    // under the bar (rank 1.8 → 433 + 0.8·(6000−433) = 4886.6) — the p90 needs
    // the slow class to dominate the top decile, exactly as the SQL behaves.
    const rows = [{ total: 21 }, { total: 433 }, { total: 6000 }, { total: 6100 }];
    expect(verdictFor(rows)).toBe('ESCALATE');
  });

  test('a genuine send-path regression ESCALATEs — queued outcome with pathological legs', () => {
    // queue-wait is budgeted (5 s) but the legs around it burned 6 s: net 6 s.
    const rows = [
      { total: 5081, preemptMs: 5033 },
      { total: 11000, preemptMs: 5000 },
    ];
    expect(verdictFor(rows)).toBe('ESCALATE');
  });

  test('a queued send whose whole cost IS the budgeted wait never trips the bar even at exactly 5000+', () => {
    const rows = [{ total: 5001, preemptMs: 5001 }, { total: 4999, preemptMs: 4999 }];
    expect(verdictFor(rows)).toBe('ok');
  });
});
