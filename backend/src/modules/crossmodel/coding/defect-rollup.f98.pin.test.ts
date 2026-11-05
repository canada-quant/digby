/**
 * PIN (FO firing 98, 2026-10-08) — defect_rollup must compute the whole
 * must-be-zero checklist verdict NATIVELY, so no firing ever re-eyeballs
 * ~13 "empty = ok" sections again.
 *
 * THE GAP THIS PINS: the checklist's terminal move was a manual sweep —
 * every firing read runs_failed_4h, runs_interrupted_24h, zero_tool_4h,
 * deploy_interrupt_24h, hook_backlog/hook_oldest_pending_now, hook_failed_4h,
 * crosscheck_failed_detail, alerts_24h, schedules_trouble, auth ESL, the
 * journal fanout bar, parse-error shares and the retention ladder one by
 * one, confirming each was empty/at-bar BY EYE before writing "audit clean".
 * Each of those reads is a by-eye verdict the f64 doctrine exists to retire
 * (the f96 fanout rollup generalized to the entire checklist).
 *
 * THE FIX (firing 98, 29th f64 bake): defect_rollup — ONE section, per-
 * condition {cond, n, verdict} rows each carrying the SAME bar its detail
 * section already bakes (no new thresholds invented here), plus a single
 * OVERALL verdict computed from the rows. defect_rollup_graded repeats the
 * ESCALATE rung of the two graded ladders (retention, compaction) so the
 * whole terminal sweep is three native reads.
 *
 * DELIBERATE SCOPING: watch-only classes stay watch-only in their detail
 * sections and are NOT escalated here — journal 'live:agent_behavior'
 * recurrence (f94/f96 vocabulary), compaction 'degraded' <= 5 %, citation-
 * waste concentration, hook dead_source/dead_target terminal rows, deploy-
 * alert 'flake_ci_green'/'no_ci_verdict' rows. The rollup escalates only
 * what the charter escalates. journal_fanout_4h carries the f101-corrected
 * bar (>= 2 ADJUDICATED dead-end chats, the detail rung verbatim — the raw
 * >= 8 distinct-chats bar fired 4x/7d on guard-note storms with zero
 * adjudicated chats) — the top_recurrence rung stays in the detail section.
 *
 * This pin is TEXTUAL + BEHAVIORAL (same shape as the f92–f97 pins): the
 * shipped audit declares the rollup and every condition; a JS model of the
 * ladder reproduces the live clean window plus synthetic defect regimes.
 */

const fs = require('fs');
const path = require('path');

export {}; // module scope: keeps these requires out of the global script scope
           // (sibling f92–f97 pin tests declare top-level fs/path the same way)

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

/** The section body, extracted from the shipped audit verbatim. */
function sectionBody(name: string): string {
  // two shapes ship in the audit: `async () => ({...})` (plain object return)
  // and `async () => {...}` (block with local consts, e.g. defect_rollup).
  const m =
    src.match(new RegExp(`sec\\('${name}', async \\(\\) => \\(\\{([\\s\\S]*?)\\n  \\}\\)\\);`)) ||
    src.match(new RegExp(`sec\\('${name}', async \\(\\) => \\{([\\s\\S]*?)\\n  \\}\\);`));
  if (!m) throw new Error(`${name} section not found in audit-live-state.js`);
  return m[1];
}

const rollupBody = sectionBody('defect_rollup');
const gradedBody = sectionBody('defect_rollup_graded');

/** Every must-be-zero condition the rollup must carry, with its window. */
const CONDITIONS: Array<[string, string]> = [
  ['failed_runs_4h', "agent_runs r WHERE r.status='failed'"], // f101: adjudicated population (dead-end failures only)
  ['interrupted_runs_24h', "agent_runs WHERE status='interrupted'"],
  ['zero_tool_finals_4h', "'zero_tool_final','zero_tool_gate'"],
  ['deploy_interrupts_24h', "kind='chat_run_interrupted'"], // f99: loop_metrics seam (requeue paths write no notice row)
  ['hook_pending_stale_15m_now', "'pending','delivering'"],
  ['hook_failed_4h', "LIKE 'failed%'"],
  ['crosscheck_failed_24h', "'reconcile_failed','timeout'"],
  ['infra_alert_ci_red_24h', "meta->>'kind'='deploy'"], // f102: adjudicated population (no deploy_wave_success after the alert, older than 6h)
  ['schedules_trouble_now', '"busySkips" >= 10'], // f103: the framework's own warn rung (ZOMBIE_BUSY_SKIPS_MIN; alarm first crossing is 3 = info watch)
  ['auth_escalate_4h', 'auth_login_failed'],
  ['journal_fanout_4h', 'COUNT(DISTINCT j."chatId")'], // f101: adjudicated population (detail rung verbatim)
  ['memory_parse_error_4h', "'parse_error'"],
  ['merge_gate_failure_dangling_24h', "kind='merge_gate_failure'"], // f100: dangling rung (no merge_success for same repo+PR after 6h)
];

/** The graded companions must repeat the detail sections' ESCALATE rungs. */
const GRADED = ['agent_events_retention', 'context_compaction'];

describe('PIN f98: defect_rollup bake (29th f64 bake)', () => {
  describe('textual: the shipped audit declares the rollup', () => {
    it('declares the 29th f64 bake marker and the by-eye gap it retires', () => {
      expect(src).toMatch(/defect_rollup \(firing 98, 2026-10-08 — 29th f64 bake; bars corrected/);
      expect(src).toMatch(/must-be-zero conditions/);
    });

    it.each(CONDITIONS)(`carries condition %s`, (cond, probe) => {
      expect(rollupBody).toContain(`'${cond}'`);
      expect(rollupBody).toContain(probe);
    });

    it('carries exactly the 12 must-be-zero conditions', () => {
      const declared = rollupBody.match(/UNION ALL SELECT '[a-z_0-9]+',/g) || [];
      expect(declared).toHaveLength(CONDITIONS.length - 1); // first row has no UNION ALL
      const first = rollupBody.match(/SELECT '([a-z_0-9]+)' AS cond/);
      expect(first?.[1]).toBe(CONDITIONS[0][0]);
    });

    it('keeps the f101-corrected journal-fanout bar (>= 2 ADJUDICATED chats — the detail rung verbatim; the raw >= 8 bar fired 4x/7d on guard-note storms with zero adjudicated chats)', () => {
      expect(rollupBody).toMatch(/cond = 'journal_fanout_4h' AND n >= 2 THEN 'ESCALATE'/);
      expect(rollupBody).toMatch(/cond = 'journal_fanout_4h' THEN 'ok'/);
    });

    it('failed_runs_4h counts the ADJUDICATED population: a dead run with a live sibling (concurrent OR newer — the c919294b class) stays out of n', () => {
      expect(rollupBody).toMatch(/FROM agent_runs r WHERE r\.status='failed'/);
      expect(rollupBody).toMatch(/r2\."sessionId" = r\."sessionId"/);
      expect(rollupBody).toMatch(/r2\."createdAt" > r\."createdAt" AND r2\.status IN \('running','queued','completed'\)/);
      expect(rollupBody).toMatch(/r2\."createdAt" <= r\."createdAt" AND \(r2\.status IN \('running','queued'\) OR \(r2\."finishedAt" IS NOT NULL AND r2\."finishedAt" > r\."createdAt"\)\)/);
    });

    it('excludes terminal hook classes from hook_failed_4h (dead_source/dead_target are reported, not defects)', () => {
      expect(rollupBody).toMatch(/status NOT IN \('failed:source_gone','failed:target_gone'\)/);
    });

    it('hook_pending_stale_15m_now counts only UNEXPLAINED stale pendings (f172 park-verdict axis, 34th bake): a designed park (parked:triage / busy:park / busy:target / debounce) contributes 0 — f172 live escalated FS c0e22e36 pending 2 / oldest 18 min while BOTH detail sections read busy:park', () => {
      expect(rollupBody).toContain(`g.verdict = 'ESCALATE'`);
      // the arms mirror hook_oldest_pending_now EXACTLY (the f81 lesson: drift
      // between the two surfaces silently re-arms the false positive)
      const oldestBody = sectionBody('hook_oldest_pending_now');
      for (const arm of [
        `wp.kind='wake_parked' AND wp.meta->>'reason'='triage'`,
        `MAX(e."updatedAt") > now() - interval '5 minutes'`,
        `r.status = 'running' AND r."heartbeatAt" > now() - interval '5 minutes'`,
        `BOOL_OR(EXTRACT(EPOCH FROM (now() - h."lastFiredAt")) < h."debounceSec")`,
      ]) {
        expect(rollupBody).toContain(arm);
        expect(oldestBody).toContain(arm);
      }
      // arm order: parked:triage → busy:park → busy:target → debounce → ESCALATE
      const order = [`'parked:triage'`, `'busy:park'`, `'busy:target'`, `'debounce'`, `ELSE 'ESCALATE' END AS verdict`];
      const idx = order.map((s) => rollupBody.indexOf(s));
      expect(idx.every((i) => i >= 0)).toBe(true);
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    });

    it('excludes e2e-ephemeral and dead chats from crosscheck_failed_24h (the firing-74 bar)', () => {
      expect(rollupBody).toMatch(/c\.title NOT LIKE 'e2e suite%'/);
      expect(rollupBody).toMatch(/c\.id IS NOT NULL/);
    });

    it('escalates only ciVerdict=failure deploy alerts (flake_ci_green stays watch-only)', () => {
      expect(rollupBody).toMatch(/meta->>'ciVerdict' = 'failure'/);
    });

    it('carries the single OVERALL verdict computed from the rows', () => {
      expect(rollupBody).toMatch(/overall.*verdict.*escalates\.length \? 'ESCALATE' : 'ok'/s);
      expect(rollupBody).toMatch(/escalate_n/);
      expect(rollupBody).toMatch(/escalated/);
    });

    it.each(GRADED)(`graded companion repeats the %s ESCALATE rung`, (kind) => {
      expect(gradedBody).toContain(`kind='${kind}'`);
      expect(gradedBody).toMatch(/'ESCALATE'/);
    });

    it('never reuses a > 0 verdict outside the two graded ladders and the fanout bar', () => {
      // the must-be-zero ladder: exactly one n > 0 ESCALATE rung, guarded by
      // the journal_fanout_4h exception checked BEFORE it (branch order, the
      // f95 queued_behind trap — an unguarded n > 0 would escalate the
      // fanout at 1-7 chats, contradicting the f96 calibration).
      const rung = rollupBody.match(/WHEN cond = 'journal_fanout_4h' THEN 'ok' WHEN n > 0 THEN 'ESCALATE' ELSE 'ok' END/);
      expect(rung).not.toBeNull();
    });
  });

  describe('behavioral: the ladder reproduces live + synthetic regimes', () => {
    /** The shipped verdict ladder, lifted verbatim from the section. */
    const ladder = (cond: string, n: number): 'ok' | 'ESCALATE' => {
      if (cond === 'journal_fanout_4h') return n >= 2 ? 'ESCALATE' : 'ok';
      return n > 0 ? 'ESCALATE' : 'ok';
    };
    const overall = (rows: Array<{ cond: string; n: number }>) => {
      const escalated = rows.filter((r) => ladder(r.cond, r.n) === 'ESCALATE');
      return { verdict: escalated.length ? 'ESCALATE' : 'ok', escalate_n: escalated.length, escalated: escalated.map((r) => r.cond) };
    };

    it('live f98 window: all 12 conditions at their observed values → overall ok', () => {
      // Observed this firing (audit 2026-10-08T06:37Z): 0 failed, 0
      // interrupted, 0 zero-tool, 0 deploy-interrupt REPEAT chats (one
      // singleton re-fire existed, n stays 0 at the f99 repeat bar), 0
      // backlog, 0 hook failures, 0 crosscheck failures above the f99
      // recurrence rung, 0 ci-red alerts, 0 schedule trouble, 0 auth ESL
      // (5 fails / 2 ips < bars), journal fanout 2 raw chats / 0 ADJUDICATED
      // dead-end chats (all watch-only guard notes — the f101-corrected
      // population), 0 parse-error sources.
      const rows = CONDITIONS.map(([cond]) => ({ cond, n: 0 }));
      const o = overall(rows);
      expect(o.verdict).toBe('ok');
      expect(o.escalate_n).toBe(0);
      expect(o.escalated).toEqual([]);
    });

    it('one failed run escalates the rollup overall', () => {
      const rows = CONDITIONS.map(([cond]) => ({ cond, n: cond === 'failed_runs_4h' ? 1 : 0 }));
      const o = overall(rows);
      expect(o.verdict).toBe('ESCALATE');
      expect(o.escalated).toEqual(['failed_runs_4h']);
    });

    it('journal fanout stays ok below the f101 bar (1 adjudicated chat = the detail row the firing probes; 2 = fleet-wide)', () => {
      expect(ladder('journal_fanout_4h', 1)).toBe('ok');
      expect(ladder('journal_fanout_4h', 2)).toBe('ESCALATE');
    });

    it('f172 park axis: the busy:park false positive reads ok; a genuinely stuck pending still escalates (JS model of the arm CASE + SUM)', () => {
      type ParkGroup = { stale: number; hasStale: boolean; parkedTriage?: boolean; retryFuture?: boolean; touchedLately?: boolean; targetRunning?: boolean; inDebounce?: boolean };
      const groupVerdict = (g: ParkGroup) =>
        !g.hasStale ? 'ok'
        : g.parkedTriage && g.retryFuture ? 'parked:triage'
        : g.touchedLately ? 'busy:park'
        : g.targetRunning ? 'busy:target'
        : g.inDebounce ? 'debounce'
        : 'ESCALATE';
      const rollupStale = (groups: ParkGroup[]) => groups.reduce((s, g) => s + (groupVerdict(g) === 'ESCALATE' ? g.stale : 0), 0);
      // f172 live window: FS c0e22e36 pending 2, oldest 18 min, park loop cycling updatedAt — ESCALATE on the raw count, ok on the axis
      expect(rollupStale([{ stale: 2, hasStale: true, touchedLately: true }])).toBe(0);
      // genuinely stuck: no park arm holds — counted at full staleness
      expect(rollupStale([{ stale: 1, hasStale: true }])).toBe(1);
      // mixed fleet: the parked group is invisible, the stuck group is counted
      expect(rollupStale([{ stale: 3, hasStale: true, touchedLately: true }, { stale: 1, hasStale: true }])).toBe(1);
      // arm order (the f81 lesson): parked:triage outranks busy:park; a triage park WITHOUT a future retryAt falls through the AND
      expect(groupVerdict({ stale: 1, hasStale: true, parkedTriage: true, retryFuture: true, touchedLately: true })).toBe('parked:triage');
      expect(groupVerdict({ stale: 1, hasStale: true, parkedTriage: true, retryFuture: false, touchedLately: true })).toBe('busy:park');
      expect(groupVerdict({ stale: 1, hasStale: true, parkedTriage: true, retryFuture: false })).toBe('ESCALATE');
      // busy:target and debounce are park verdicts too
      expect(rollupStale([{ stale: 2, hasStale: true, targetRunning: true }])).toBe(0);
      expect(rollupStale([{ stale: 2, hasStale: true, inDebounce: true }])).toBe(0);
      // a fresh group reads ok and contributes 0
      expect(rollupStale([{ stale: 0, hasStale: false }])).toBe(0);
      // the ladder mapping is unchanged: n > 0 ESCALATEs
      expect(ladder('hook_pending_stale_15m_now', 0)).toBe('ok');
      expect(ladder('hook_pending_stale_15m_now', 1)).toBe('ESCALATE');
    });

    it('every must-be-zero condition escalates at n=1', () => {
      for (const [cond] of CONDITIONS) {
        if (cond === 'journal_fanout_4h') continue;
        expect(ladder(cond, 1)).toBe('ESCALATE');
        expect(ladder(cond, 0)).toBe('ok');
      }
    });

    it('multiple defects are all named, not just the first', () => {
      const rows = CONDITIONS.map(([cond]) => ({
        cond,
        n: cond === 'failed_runs_4h' || cond === 'zero_tool_finals_4h' ? 1 : 0,
      }));
      const o = overall(rows);
      expect(o.escalate_n).toBe(2);
      expect(o.escalated).toEqual(['failed_runs_4h', 'zero_tool_finals_4h']);
    });
  });
});
