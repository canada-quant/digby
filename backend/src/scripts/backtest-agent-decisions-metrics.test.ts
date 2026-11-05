/**
 * Pure functions of the agent-decisions replay probe
 * (scripts/framework-audit/backtest-agent-decisions.js — the AD0927 replay of the
 * `supervisor_turn_noop` and `audit_round_skip` candidates through decide()):
 * the act bands, the code-labelled has_new_input feature, the per-target 7-day
 * features, the drain-row splitter, the board / lane facts, the reopen label,
 * the deterministic step → receipt pre-join, the agent_events rebuild, the
 * mergeable aggregate, the report verdicts, the dry-run plumbing and the
 * telemetry stub. The probe is plain CommonJS (it runs from /app inside the
 * backend container), so it is required by path here.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const probe: any = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'framework-audit', 'backtest-agent-decisions.js'));

describe('wilson', () => {
  it('matches the closed form for 5/10 and is bounded on the edges', () => {
    const w = probe.wilson(5, 10);
    expect(w.p).toBeCloseTo(0.5, 6);
    expect(w.lo).toBeCloseTo(0.2366, 3);
    expect(w.hi).toBeCloseTo(0.7634, 3);
    expect(probe.wilson(0, 0)).toEqual({ k: 0, n: 0, p: null, lo: null, hi: null });
    expect(probe.wilson(0, 34).lo).toBe(0);
    expect(probe.wilson(300, 300).hi).toBeCloseTo(1, 9);
  });
});

describe('sampleKeep', () => {
  it('is deterministic per (salt, id), keeps everything at rate ≥ 1 and nothing at rate ≤ 0', () => {
    expect(probe.sampleKeep('s', 'a', 1)).toBe(true);
    expect(probe.sampleKeep('s', 'a', 0)).toBe(false);
    const a = probe.sampleKeep('s', 'row-1', 0.5), b = probe.sampleKeep('s', 'row-1', 0.5);
    expect(a).toBe(b);
    let kept = 0;
    for (let i = 0; i < 4000; i++) if (probe.sampleKeep('salt', `id-${i}`, 0.25)) kept += 1;
    expect(kept).toBeGreaterThan(4000 * 0.2);
    expect(kept).toBeLessThan(4000 * 0.3);
  });
});

describe('classifySupervisorNoteFallback', () => {
  it('mirrors supervisor.service precedence: no-op marker, then ACTIONS TAKEN, then length', () => {
    expect(probe.classifySupervisorNoteFallback('SWEEP: no-op — nothing moved')).toBe('supervisor_noop');
    expect(probe.classifySupervisorNoteFallback('WAKE: no-op\nACTIONS TAKEN (2)')).toBe('supervisor_noop');
    expect(probe.classifySupervisorNoteFallback('ACTIONS TAKEN (1): steered lane')).toBe('supervisor_action');
    expect(probe.classifySupervisorNoteFallback('**Actions (2, with receipts):** sent')).toBe('supervisor_action');
    expect(probe.classifySupervisorNoteFallback('short line')).toBe('supervisor_noop');
    expect(probe.classifySupervisorNoteFallback('x'.repeat(201))).toBe('supervisor_note');
    expect(probe.classifySupervisorNoteFallback('')).toBe('supervisor_noop');
  });
});

describe('newInputShare (the code-labelled has_new_input feature)', () => {
  it('is all-new with no notes, not-new when the notes already say it, and false with nothing pending', () => {
    expect(probe.newInputShare([], ['anything']).hasNewInput).toBe(false);
    const fresh = probe.newInputShare(['lane 7 FAILED with exit code 2, needs the supervisor'], []);
    expect(fresh.share).toBe(1);
    expect(fresh.hasNewInput).toBe(true);
    const known = probe.newInputShare(['lane 7 finished the routine tick'], ['SWEEP: no-op — lane 7 finished the routine tick, nothing to do', 'earlier note']);
    expect(known.share).toBeLessThan(probe.NEW_INPUT_SHARE_MIN);
    expect(known.hasNewInput).toBe(false);
    const mixed = probe.newInputShare(['lane 7 finished the routine tick', 'benchmark harness crashed at epoch 40 with OOM on node17'], ['lane 7 finished the routine tick']);
    expect(mixed.hasNewInput).toBe(true);
  });
});

describe('targetHistory', () => {
  it('quantises the 7-day rates, counts the consecutive-no-op streak newest-first and buckets the last action age', () => {
    const now = Date.parse('2026-09-27T00:00:00Z');
    const h = 3600e3;
    const rows = [
      { kind: 'supervisor_noop', t: now - 1 * h }, { kind: 'supervisor_noop', t: now - 2 * h }, { kind: 'supervisor_action', t: now - 5 * h },
      { kind: 'supervisor_note', t: now - 20 * h }, { kind: 'supervisor_noop', t: now - 8 * 24 * h }, // outside the 7-day window
      { kind: 'supervisor_action', t: now + h }, // the future never counts
    ];
    const f = probe.targetHistory(rows, now);
    expect(f.turns_7d).toBe(4);
    expect(f.noop_rate_7d).toBe(0.5);
    expect(f.action_rate_7d).toBe(0.25);
    expect(f.consecutive_noops).toBe(2);
    expect(f.last_action_ago).toBe('1-6h');
    expect(probe.targetHistory([], now)).toEqual({ turns_7d: 0, noop_rate_7d: null, action_rate_7d: null, consecutive_noops: 0, last_action_ago: 'never' });
  });
});

describe('splitDrainBodies', () => {
  it('splits the coalesced drain row into bodies with their source chat ids and strips the headers', () => {
    const content = '[2 agent messages arrived while this chat was busy — coalesced into ONE turn. Answer each in order.]\n\n'
      + '[AGENT-SENT MESSAGE — from chat "CanLaw Supervisor" (daee2916) in project "x", another Digby agent, NOT the owner.] sweep deltas — nothing moved'
      + '\n\n— — —\n\n'
      + '[queued agent message from chat abcdef02 — another Digby agent, NOT the owner]\nrun FAILED exit code 2';
    const parts = probe.splitDrainBodies(content);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ source: 'daee2916', title: 'CanLaw Supervisor', body: 'sweep deltas — nothing moved' });
    expect(parts[1]).toMatchObject({ source: 'abcdef02', body: 'run FAILED exit code 2' });
    const single = probe.splitDrainBodies('[AGENT-SENT MESSAGE — from chat "Lane" (0123abcd) in project "p", another Digby agent, NOT the owner.] hello');
    expect(single).toEqual([{ source: '0123abcd', title: 'Lane', body: 'hello' }]);
  });
});

describe('pendingInputRows + pendingPins', () => {
  it('caps the rows, hashes the source, clips the summary, buckets the age, and pins alarm / owner-card / child-result rows', () => {
    const now = Date.parse('2026-09-27T00:00:00Z');
    const rows = Array.from({ length: 10 }, (_, i) => ({ eventType: 'run_completed', sourceChatId: `lane-${i}`, summary: 'x'.repeat(400), depth: 1, createdAt: new Date(now - i * 10 * 60e3) }));
    const out = probe.pendingInputRows(rows, 'salt', now);
    expect(out).toHaveLength(8);
    expect(out[0].summary).toHaveLength(300);
    expect(out[0].source_lane).toHaveLength(8);
    expect(out[0].age_bucket).toBe('0-5m');
    expect(out[3].age_bucket).toBe('15-60m');
    expect(probe.pendingPins([{ eventType: 'run_completed', summary: 'fine' }]).pinned).toBe(false);
    expect(probe.pendingPins([{ eventType: 'run_failed', summary: 'x' }]).any_alarm).toBe(true);
    expect(probe.pendingPins([{ eventType: 'schedule_disabled', summary: 'x', payload: { successorId: 's' } }]).any_alarm).toBe(false);
    expect(probe.pendingPins([{ eventType: 'run_completed', summary: 'needs the owner to approve spend' }]).any_owner_card).toBe(true);
    expect(probe.pendingPins([{ eventType: 'run_completed', summary: '[INFRA ALERT] box C disk 97%' }]).any_owner_card).toBe(true);
    expect(probe.pendingPins([{ eventType: 'child_result', summary: 'x' }]).any_child_result).toBe(true);
  });
});

describe('boardCounts + laneFacts', () => {
  const t0 = Date.parse('2026-09-27T12:00:00Z');
  const since = t0 - 3600e3;
  const runs = [
    { sessionId: 'a', status: 'completed', startedAt: new Date(since - 100e3), finishedAt: new Date(t0 - 60e3), error: null },
    { sessionId: 'b', status: 'failed', startedAt: new Date(since + 10e3), finishedAt: new Date(t0 - 30e3), error: 'boom  boom' },
    { sessionId: 'c', status: 'completed', startedAt: new Date(since + 20e3), finishedAt: new Date(t0 + 600e3) }, // still running at t0
    { sessionId: 'd', status: 'completed', startedAt: new Date(t0 + 10e3), finishedAt: new Date(t0 + 20e3) }, // the future
  ];
  it('counts the window as of t0 (terminal statuses exact, running = started and not finished by t0)', () => {
    expect(probe.boardCounts(runs, since, t0)).toEqual({ lanes_running_now: 1, runs_started_since: 2, runs_finished_since: 1, runs_failed_since: 1, runs_cancelled_since: 0 });
  });
  it('reads the newest run of a lane as of t0', () => {
    expect(probe.laneFacts(runs.filter(r => r.sessionId === 'b'), t0)).toEqual({ status: 'failed', ended_ago: '0-5m', error_head: 'boom boom' });
    expect(probe.laneFacts(runs.filter(r => r.sessionId === 'c'), t0).status).toBe('running');
    expect(probe.laneFacts(runs.filter(r => r.sessionId === 'd'), t0)).toBeNull();
  });
});

describe('turnNoopBand', () => {
  it('acts only on a confident no-op with no new input and no pin', () => {
    expect(probe.turnNoopBand({ willAct: 0.1, hasNewInput: false, pinned: false })).toEqual({ quiet: true, jevOnly: true, act: true });
    expect(probe.turnNoopBand({ willAct: 0.15, hasNewInput: false, pinned: false }).act).toBe(true);
    expect(probe.turnNoopBand({ willAct: 0.16, hasNewInput: false, pinned: false }).act).toBe(false);
    expect(probe.turnNoopBand({ willAct: 0.05, hasNewInput: true, pinned: false }).act).toBe(false);
    expect(probe.turnNoopBand({ willAct: 0.05, hasNewInput: false, pinned: true }).act).toBe(false);
    expect(probe.turnNoopBand({ willAct: NaN, hasNewInput: false, pinned: false }).act).toBe(false);
  });
});

describe('auditSkipBand', () => {
  it('skips only when reopen is confidently low AND every per-step noul is confidently high', () => {
    expect(probe.auditSkipBand({ any_reopen: 0.05, step_1_receipted: 0.9, step_2_receipted: 0.86 })).toMatchObject({ act: true, minStep: 0.86 });
    expect(probe.auditSkipBand({ any_reopen: 0.11, step_1_receipted: 0.9 }).act).toBe(false);
    expect(probe.auditSkipBand({ any_reopen: 0.05, step_1_receipted: 0.9, step_2_receipted: 0.5 }).act).toBe(false);
    expect(probe.auditSkipBand({ any_reopen: 0.05 }).act).toBe(false); // no per-step answers = no skip
    expect(probe.auditSkipBand(null).act).toBe(false);
  });
});

describe('reopenedSteps + receiptJoin', () => {
  it('flags a completed step that is no longer completed (or is gone) after the round', () => {
    const before = ['1', '2', '3'];
    expect(probe.reopenedSteps(before, [{ id: 1, status: 'completed' }, { id: 2, status: 'in_progress' }, { id: 3, status: 'completed' }])).toEqual(['2']);
    expect(probe.reopenedSteps(before, [{ id: 1, status: 'completed' }, { id: 3, status: 'completed' }])).toEqual(['2']);
    expect(probe.reopenedSteps([], [])).toEqual([]);
  });
  it('joins a completed step to an ok:true receipt by noun (path / PR / sha) or by action kind, never to an ok:false one', () => {
    const steps = [
      { id: 1, text: 'commit the fix to src/thing.ts and push' },
      { id: 2, text: 'open PR #123 for the change' },
      { id: 3, text: 'verify the deploy' },
      { id: 4, text: 'write the design memo' },
    ];
    const receipts = [
      { id: 'r1', tool: 'run_command', ok: true, ids: {}, argsHead: 'git add src/thing.ts && git commit', resultHead: '[branch abc1234] fix' },
      { id: 'r2', tool: 'open_pull_request', ok: true, ids: { prNumber: 123 }, argsHead: '', resultHead: '{"ok":true}' },
      { id: 'r3', tool: 'verify', ok: false, ids: { passed: false }, argsHead: '', resultHead: 'failed' },
    ];
    const j = probe.receiptJoin(steps, receipts);
    expect(j.map((x: any) => x.receipted)).toEqual([true, true, false, false]);
    expect(j[0].receipt_ids).toEqual(['r1']);
    expect(j[1].receipt_ids).toEqual(['r2']);
  });
});

describe('rebuildAuditPoint + buildAuditRequest', () => {
  const rt = {
    extractReceipt: (tool: string, _args: unknown, result: string) => (tool === 'git_commit' || tool === 'run_command' ? { tool, ok: !/failed/.test(result), ids: {} } : null),
    receiptHeads: (args: unknown, result: unknown) => ({ argsHead: String(JSON.stringify(args)).slice(0, 200), resultHead: String(result).slice(0, 200) }),
    isEvidenceToolName: (n: string) => n !== 'update_plan',
  };
  const events = [
    { seq: 1, type: 'plan_update', plan: { steps: [{ id: 1, status: 'completed', text: 'commit fix to a.ts' }, { id: 2, status: 'completed', text: 'run the suite' }, { id: 3, status: 'blocked', text: 'wait' }] } },
    { seq: 2, type: 'tool_call', name: 'git_commit', args: '{"message":"fix a.ts"}' },
    { seq: 3, type: 'tool_result', name: 'git_commit', result: '[main 1234567] fix a.ts' },
    { seq: 4, type: 'tool_call', name: 'update_plan', args: '{}' },
    { seq: 5, type: 'tool_result', name: 'update_plan', result: 'Plan updated' },
    { seq: 6, type: 'text', delta: 'All done: ' },
    { seq: 7, type: 'text', delta: 'committed a.ts.' },
    { seq: 8, type: 'progress', message: 'Auto-audit: double-checking the work really meets the goal…', createdAt: '2026-09-27T00:00:00Z' },
    { seq: 9, type: 'text', delta: 'Re-checking…' },
    { seq: 10, type: 'plan_update', plan: { steps: [{ id: 1, status: 'completed', text: 'commit fix to a.ts' }, { id: 2, status: 'pending', text: 'run the suite' }, { id: 3, status: 'blocked', text: 'wait' }] } },
    { seq: 11, type: 'guard_marker' },
    { seq: 12, type: 'complete', createdAt: '2026-09-27T00:06:00Z' },
  ];
  it('rebuilds the grant-time plan, receipts, final text and the post-round reopen label', () => {
    const pt = probe.rebuildAuditPoint(events, rt);
    expect(pt.ok).toBe(true);
    expect(pt.grantSeq).toBe(8);
    expect(pt.completedBefore).toEqual(['1', '2']);
    expect(pt.reopened).toEqual(['2']);
    expect(pt.receipts).toHaveLength(1);
    expect(pt.receipts[0]).toMatchObject({ tool: 'git_commit', ok: true });
    expect(pt.evidenceCalls).toBe(1);
    expect(pt.toolCalls).toBe(2);
    expect(pt.finalText).toBe('All done: committed a.ts.');
    expect(pt.guardAfter).toBe(1);
    const req = probe.buildAuditRequest(pt, { turnsBefore: 7, costUsdBefore: 0.4 });
    expect(Object.keys(req.questions)).toEqual(['any_reopen', 'step_1_receipted', 'step_2_receipted']);
    expect(req.state.completed_steps_under_review).toHaveLength(2);
    expect(req.state.completed_steps_under_review[0].receipt_prejoin.receipted).toBe(true);
    expect(req.state.completed_steps_under_review[1].receipt_prejoin.receipted).toBe(false);
    expect(req.allReceipted).toBe(false);
    expect(req.ectSkip).toBe(false);
    expect(req.state.turns_bucket).toBe('5-14');
    expect(req.state.cost_bucket_usd).toBe('0.25-1');
  });
  it('fails honestly without a grant marker or a plan, and falls back to a prior plan', () => {
    expect(probe.rebuildAuditPoint(events.filter((e) => e.type !== 'progress'), rt)).toEqual({ ok: false, reason: 'no_grant_marker' });
    const noPlan = events.filter((e) => e.type !== 'plan_update');
    expect(probe.rebuildAuditPoint(noPlan, rt)).toEqual({ ok: false, reason: 'no_plan_before_grant' });
    const fb = probe.rebuildAuditPoint(noPlan, { ...rt, fallbackPlan: { steps: [{ id: 9, status: 'completed', text: 'x' }] } });
    expect(fb.ok).toBe(true);
    expect(fb.completedBefore).toEqual(['9']);
    expect(fb.reopened).toEqual([]);
  });
});

describe('aggregate merge + reports', () => {
  it('merges batches additively and the report verdicts follow the rules', () => {
    const mk = (rows: any[], batchIndex: number) => ({ ...probe.newAgg({ runId: 'r', spec: 'jev', candidate: 'supervisor_turn_noop', batchIndex, window: { days: 14 } }), rows, rowsScored: rows.length, rowsScanned: rows.length, totals: { eligible: 4000 }, gate: { calls: rows.length, ok: rows.length, nullResults: 0, errors: 0, calibrated: rows.length, byBackend: { jev: rows.length }, byMode: { act: rows.length }, latencies: rows.map(() => 150) }, telemetryStubbedRows: rows.length });
    const noop = (i: number) => ({ g: 1, o: 'schedule_sweep', t: 'fleet', a: 0, pw: 0.05, ph: 0.1, hn: 0, pin: 0, al: 0, np: 2, usd: 0.2, min: 120000, win: 60, h7: 20, cn: i % 3 });
    const act = () => ({ g: 1, o: 'agent_drain', t: 'project', a: 1, pw: 0.9, ph: 0.9, hn: 1, pin: 0, al: 0, np: 3, usd: 0.3, min: 300000, win: 30, h7: 20, cn: 0 });
    const a = mk(Array.from({ length: 120 }, (_, i) => noop(i)), 0);
    const b = mk(Array.from({ length: 80 }, () => act()), 1);
    const m = probe.mergeAgg(a, b);
    expect(m.rowsScored).toBe(200);
    expect(m.batches).toBe(2);
    expect(m.gate.calls).toBe(200);
    expect(m.telemetryStubbedRows).toBe(200);
    const rep = probe.reportTurnNoop(m);
    expect(rep.n).toBe(200);
    expect(rep.bands[0].n_in_band).toBe(120);
    expect(rep.bands[0].agreement).toBe(100);
    expect(rep.bands[0].confusion).toEqual({ skip_correct: 120, skip_wrong: 0, run_negative: 0, run_positive: 80 });
    expect(rep.verdict).toBe('build-and-act-candidate');
    expect(rep.projected.savingsUsdPerDay).toBeGreaterThan(0);
    // scaled to the population: 120 in-band of 200 scored, 4000 eligible over 14 d ⇒ 2400/14 correct skips/day × $0.2
    expect(rep.projected.correct_skips_per_day).toBeCloseTo((120 / 14) * (4000 / 200), 3);
    expect(rep.result).toMatchObject({ key: 'supervisor_turn_noop', n: 200, verdict: 'build-and-act-candidate' });
  });
  it('audit report: no lift over the base rate ⇒ drop; a clean band ⇒ shadow until 300 rows', () => {
    const mk = (rows: any[]) => ({ ...probe.newAgg({ runId: 'r', spec: 'jev', candidate: 'audit_round_skip', batchIndex: 0, window: { days: 14 } }), rows, rowsScored: rows.length, totals: { eligible: 4900 }, gate: { calls: rows.length, ok: rows.length, nullResults: 0, errors: 0, calibrated: rows.length, byBackend: {}, byMode: {}, latencies: [] } });
    const row = (re: number, ect: number, reopenP: number) => ({ g: 1, re, nr: re, gs: 0, pa: 1, k: 3, kj: ect ? 3 : 1, allj: ect, ect, v: 1, nrc: 4, ev: 5, ans: { any_reopen: reopenP, step_1_receipted: 0.9, step_2_receipted: 0.9, step_3_receipted: 0.9 }, hl: re, shed: 0.7, rmin: 8, st: 1 });
    const clean = probe.reportAudit(mk([...Array.from({ length: 60 }, () => row(0, 1, 0.05)), ...Array.from({ length: 10 }, () => row(1, 0, 0.6))]));
    expect(clean.bands[2].n_in_band).toBe(60);
    expect(clean.bands[2].reopenRateInBand).toBe(0);
    expect(clean.verdict).toBe('build-shadow');
    expect(clean.harnessLabelCrossCheck.agreement).toBe(100);
    const flat = probe.reportAudit(mk([...Array.from({ length: 30 }, () => row(0, 1, 0.05)), ...Array.from({ length: 30 }, () => row(1, 1, 0.05))]));
    expect(flat.verdict).toBe('drop');
    expect(probe.reportAudit(mk([])).verdict).toBe('drop');
  });
  it('buildReport reports a missing candidate as n=0 / drop', () => {
    const r = probe.buildReport({});
    expect(r.results).toHaveLength(2);
    expect(r.results.every((x: any) => x.n === 0 && x.verdict === 'drop')).toBe(true);
  });
});

describe('telemetry stub', () => {
  it('overwrites both exports and counts rows; refuses a non-writable namespace', () => {
    const lm: any = { recordLoopMetric: () => { throw new Error('must not reach the DB'); }, recordLoopMetrics: () => {} };
    const counter = probe.stubTelemetry(lm);
    lm.recordLoopMetric({ kind: 'decision_gate' });
    lm.recordLoopMetrics([{}, {}]);
    expect(counter.rows).toBe(3);
    const frozen: any = {};
    Object.defineProperty(frozen, 'recordLoopMetric', { value: () => {}, writable: false });
    Object.defineProperty(frozen, 'recordLoopMetrics', { value: () => {}, writable: false });
    expect(() => probe.stubTelemetry(frozen)).toThrow(/did not take/);
  });
});

describe('parseArgs', () => {
  it('parses the positional + flag shape and rejects bad values', () => {
    expect(probe.parseArgs(['14', 'jev', '200', '--cap', '400', '--candidate', 'audit_round_skip'])).toMatchObject({ days: 14, spec: 'jev', batch: 200, cap: 400, candidate: 'audit_round_skip', dryRun: false });
    expect(probe.parseArgs(['--merge'])).toMatchObject({ merge: true, days: 14, spec: 'jev' });
    expect(probe.parseArgs(['--merge', 'ad-1'])).toMatchObject({ merge: 'ad-1' });
    expect(() => probe.parseArgs(['0'])).toThrow(/days/);
    expect(() => probe.parseArgs(['--candidate', 'nope'])).toThrow(/candidate/);
    expect(() => probe.parseArgs(['--bogus'])).toThrow(/unknown flag/);
  });
});

describe('dry run end to end', () => {
  it('scores the synthetic corpus in batches, honours the cap, merges and reports both candidates', async () => {
    const rt = probe.buildDryRuntime(3);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-backtest-test-'));
    try {
      const args = { days: 14, spec: 'jev', batch: 50, cap: 120, candidate: 'all', outDir, runId: 'test-run' };
      let last: any = null;
      for (let i = 0; i < 20; i++) { last = await probe.runOnce(rt, args, { floorMs: 0, now: rt.now }); if (last.done) break; }
      expect(last.done).toBe(true);
      const by = probe.mergeLines(path.join(outDir, 'test-run.jsonl'));
      expect(by.supervisor_turn_noop.rowsScored).toBeLessThanOrEqual(120);
      expect(by.supervisor_turn_noop.rowsScored).toBeGreaterThan(60);
      expect(by.audit_round_skip.rowsScored).toBeLessThanOrEqual(120);
      // no ids, no text in the tuples
      for (const r of by.supervisor_turn_noop.rows) expect(Object.keys(r).sort()).toEqual(['a', 'al', 'cn', 'g', 'h7', 'hn', 'k', 'min', 'np', 'ns', 'o', 'ph', 'pin', 'pw', 't', 'usd', 'win']);
      const report = probe.buildReport(by);
      expect(report.results.map((r: any) => r.key)).toEqual(['supervisor_turn_noop', 'audit_round_skip']);
      expect(report.candidates.supervisor_turn_noop.segments['schedule_sweep|fleet'] || report.candidates.supervisor_turn_noop.segments['agent_drain|fleet']).toBeDefined();
      expect(report.candidates.audit_round_skip.harnessLabelCrossCheck.n).toBeGreaterThan(0);
      // a second call after done is a no-op that names the merge
      const again = await probe.runOnce(rt, args, { floorMs: 0, now: rt.now });
      expect(again.done).toBe(true);
      expect(String(again.message)).toMatch(/--merge test-run/);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
