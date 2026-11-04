/**
 * self-audit-receipt-rule.ts — the deterministic half of the coding loop's
 * self-audit decision (tt-rd audit 2026-09-27, findings self-audit-churn-1/2/6).
 * Pure functions + env readers; the store-backed demotion flag is exercised
 * through its evaluator (the reader is hermetic under NODE_ENV=test).
 */

import type { ToolReceipt } from './run-receipts';
import {
  selfAuditPlanSig, laneAuditedThisRun, SELF_AUDIT_STEP_RE, stepNouns, receiptJoin, receiptRuleWouldSkip,
  selfAuditControlSample, evaluateReceiptRuleDemotion, selfAuditReceiptRuleEnvMode, selfAuditReceiptRuleMode,
  receiptRuleAutoDemoted,
  RECEIPT_RULE_BASE_REOPEN, RECEIPT_RULE_DEMOTE_MARGIN, RECEIPT_RULE_DEMOTE_MIN_ROWS,
  evaluateReceiptRulePromotion, checkReceiptRulePromotion, RECEIPT_RULE_PROMOTE_MIN_ROWS,
} from './self-audit-receipt-rule';

const receipt = (over: Partial<ToolReceipt>): ToolReceipt => ({
  id: 'r1', chatId: 'c1', runId: 'run1', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date('2026-09-27T12:00:00Z'), ...over,
});

const ENV_KEYS = ['SELF_AUDIT_RECEIPT_RULE_MODE'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('selfAuditPlanSig — text-insensitive dedupe signature (finding 1: the id:status:text sig re-armed on every firing-number edit)', () => {
  const plan = (text7: string) => ({
    goal: 'ship the async patch', acceptanceCriteria: ['probe_speed.py ≥ 5.0 tok/s'],
    steps: [{ id: 1, status: 'completed', text: 'bisect L-HT1' }, { id: 7, status: 'completed', text: text7 }],
  });

  it('REPLAY ddd26be0: "Self-audit fresh re-probes F186" → "F187" keeps the SAME signature; a status change / a new step / a new goal / new criteria re-arm', () => {
    const a = selfAuditPlanSig(plan('Self-audit fresh re-probes; final answer (F186, L-HT1zd)'));
    const b = selfAuditPlanSig(plan('Self-audit fresh re-probes; final answer (F187, L-HT1ze)'));
    expect(a).toBe(b);
    expect(a).toContain('1:completed|7:completed');
    expect(a).not.toContain('F186');
    const status = plan('x'); status.steps[1] = { id: 7, status: 'pending', text: 'x' };
    expect(selfAuditPlanSig(status)).not.toBe(a);
    const more = plan('x'); more.steps.push({ id: 8, status: 'completed', text: 'y' });
    expect(selfAuditPlanSig(more)).not.toBe(a);
    expect(selfAuditPlanSig({ ...plan('x'), goal: 'a different item' })).not.toBe(a);
    expect(selfAuditPlanSig({ ...plan('x'), acceptanceCriteria: ['another bar'] })).not.toBe(a);
  });
});

describe('laneAuditedThisRun — the lane-authored audit step (finding 1: the harness round was a SECOND pass)', () => {
  const steps = (last: string, status = 'completed') => ({ steps: [{ id: 1, status: 'completed', text: 'implement' }, { id: 2, status, text: last }] });

  it('a COMPLETED self-audit / re-verify / SA2 step + ≥1 ok evidence-bearing receipt ⇒ duplicate', () => {
    for (const text of ['Self-audit fresh re-probes; final answer', 'SA2 self-audit: re-verify every criterion', 'Re-verify acceptance criteria with fresh tool calls', 'Audit pass on the prior run', 'self audit']) {
      expect(SELF_AUDIT_STEP_RE.test(text)).toBe(true);
      const v = laneAuditedThisRun(steps(text), [receipt({ tool: 'run_command' })]);
      expect(v).toEqual({ duplicate: true, stepId: '2', evidenceReceipts: 1 });
    }
  });

  it('a receipt-less "audit" step is narration, not an audit — no skip; non-evidence tools (update_plan) and ok:false receipts do not count', () => {
    expect(laneAuditedThisRun(steps('Self-audit pass'), []).duplicate).toBe(false);
    expect(laneAuditedThisRun(steps('Self-audit pass'), [receipt({ tool: 'update_plan' })])).toMatchObject({ duplicate: false, stepId: '2', evidenceReceipts: 0 });
    expect(laneAuditedThisRun(steps('Self-audit pass'), [receipt({ ok: false })]).duplicate).toBe(false);
  });

  it('a pending / in_progress audit step, or no audit-shaped step, never counts; a null plan is safe', () => {
    expect(laneAuditedThisRun(steps('Self-audit pass', 'in_progress'), [receipt({})])).toMatchObject({ duplicate: false, stepId: null });
    expect(laneAuditedThisRun(steps('write the tests'), [receipt({})])).toMatchObject({ duplicate: false, stepId: null });
    expect(laneAuditedThisRun(null, [receipt({})])).toMatchObject({ duplicate: false, stepId: null, evidenceReceipts: 1 });
  });
});

describe('receiptJoin / stepNouns — the backtest ECT step 0, ported verbatim', () => {
  it('joins by NOUN (a path / PR number / sha / identifier in the receipt heads or ids) and by KIND (a non-run_command tool the step verb implies)', () => {
    expect(stepNouns('Open PR #706 for src/speed/probe_speed.py at 84fe3ae0')).toEqual(expect.arrayContaining(['src/speed/probe_speed.py', '#706', '84fe3ae0']));
    expect(stepNouns('the and with commit push')).toEqual([]); // stop words only
    const steps = [
      { id: 1, text: 'Edit src/speed/probe_speed.py' },
      { id: 2, text: 'Push the branch' },
      { id: 3, text: 'Message the supervisor with the result' },
      { id: 4, text: 'Nothing here matches' },
    ];
    const receipts = [
      receipt({ id: 'aaaaaaaa-1', tool: 'write_file', argsHead: '{"path":"src/speed/probe_speed.py"}' }),
      receipt({ id: 'bbbbbbbb-2', tool: 'git_push', resultHead: 'pushed' }),
      receipt({ id: 'cccccccc-3', tool: 'send_chat_message', ids: { messageId: 'm1' } }),
      receipt({ id: 'dddddddd-4', tool: 'run_command', argsHead: 'ls' }), // run_command never joins by kind
    ];
    const join = receiptJoin(steps, receipts);
    expect(join).toEqual([
      { id: '1', receipted: true, receiptIds: ['aaaaaaaa'] },
      { id: '2', receipted: true, receiptIds: ['bbbbbbbb'] },
      { id: '3', receipted: true, receiptIds: ['cccccccc'] },
      { id: '4', receipted: false, receiptIds: [] },
    ]);
  });

  it('ok:false receipts never join; empty inputs are safe', () => {
    expect(receiptJoin([{ id: 1, text: 'Push the branch' }], [receipt({ tool: 'git_push', ok: false })])[0].receipted).toBe(false);
    expect(receiptJoin([], null)).toEqual([]);
  });
});

describe('receiptRuleWouldSkip — every completed step receipted ∧ last verify ok ∧ no reject-back ∧ no blocked step', () => {
  const plan = { steps: [{ id: 1, status: 'completed', text: 'Edit src/a.ts' }, { id: 2, status: 'completed', text: 'Push the branch' }] };
  // Fixer 2026-09-27 (finding 3): the first cut's fixture carried a blocked
  // step AND asserted skip:true — the exact board the round exists for.
  const blockedPlan = { steps: [...plan.steps, { id: 3, status: 'blocked', text: 'wait on the drain' }] };
  const receipts = [receipt({ id: 'r-edit', tool: 'write_file', argsHead: 'src/a.ts' }), receipt({ id: 'r-push', tool: 'git_push' })];

  it('skips with NO verify recorded (the backtest counts absence as OK) and with a passing verify on the same tree', () => {
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: null, guardRejectBacks: 0 })).toMatchObject({ skip: true, steps: 2, blockedSteps: 0, receipted: 2, unreceiptedStepIds: [], verifyOk: true, treeCompared: false, reasons: [] });
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: true, tree: 't1' }, currentTree: 't1', guardRejectBacks: 0 })).toMatchObject({ skip: true, treeCompared: true });
    // A recorded tree with an UNKNOWN current tree is not compared (fail toward the recorded verdict) — shadow's shape.
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: true, tree: 't1' }, currentTree: null, guardRejectBacks: 0 })).toMatchObject({ skip: true, treeCompared: false });
  });

  it('fixer finding 3: a board with ANY blocked step never skips (reason blocked_steps, blockedSteps counted) — the blocker re-probe is the round\'s other job', () => {
    expect(receiptRuleWouldSkip({ plan: blockedPlan, receipts, lastVerify: null, guardRejectBacks: 0 })).toMatchObject({ skip: false, steps: 2, blockedSteps: 1, receipted: 2, reasons: ['blocked_steps'] });
    expect(receiptRuleWouldSkip({ plan: blockedPlan, receipts: [receipts[0]], lastVerify: null, guardRejectBacks: 0 }).reasons).toEqual(['unreceipted_steps', 'blocked_steps']);
  });

  it('fixer finding 4: requireTreeMatch (act) turns an UNKNOWN current tree into a non-skip (verify_tree_unknown); without it (shadow) the tree is simply not compared', () => {
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: true, tree: 't1' }, currentTree: null, requireTreeMatch: true, guardRejectBacks: 0 })).toMatchObject({ skip: false, treeCompared: false, reasons: ['verify_tree_unknown'] });
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: true, tree: 't1' }, currentTree: 't1', requireTreeMatch: true, guardRejectBacks: 0 })).toMatchObject({ skip: true, treeCompared: true });
    // No recorded tree ⇒ nothing to require.
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: true }, currentTree: null, requireTreeMatch: true, guardRejectBacks: 0 }).skip).toBe(true);
  });

  it('does NOT skip on an unreceipted step, a failed / hollow / environmental verify, a stale verify tree, a reject-back, or an empty completed set — each reason named', () => {
    expect(receiptRuleWouldSkip({ plan, receipts: [receipts[0]], lastVerify: null, guardRejectBacks: 0 })).toMatchObject({ skip: false, unreceiptedStepIds: ['2'], reasons: ['unreceipted_steps'] });
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: false }, guardRejectBacks: 0 }).reasons).toEqual(['last_verify_failed']);
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: true, unverified: true }, guardRejectBacks: 0 }).reasons).toEqual(['last_verify_hollow']);
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: true, environmental: true }, guardRejectBacks: 0 }).reasons).toEqual(['last_verify_hollow']);
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: { passed: true, tree: 't1' }, currentTree: 't2', guardRejectBacks: 0 }).reasons).toEqual(['verify_tree_stale']);
    expect(receiptRuleWouldSkip({ plan, receipts, lastVerify: null, guardRejectBacks: 1 }).reasons).toEqual(['guard_reject_back']);
    expect(receiptRuleWouldSkip({ plan: { steps: [{ id: 1, status: 'pending', text: 'x' }] }, receipts, lastVerify: null, guardRejectBacks: 0 }).reasons).toEqual(['no_completed_steps']);
    expect(receiptRuleWouldSkip({ plan: null, receipts: null, lastVerify: undefined, guardRejectBacks: 0 }).skip).toBe(false);
  });
});

describe('control sample + demotion + mode readers', () => {
  it('selfAuditControlSample: 1-in-10 by the hex tail of the run id (falls back to the session id)', () => {
    expect(selfAuditControlSample('run-…-0000', 's')).toBe(true);   // 0x00 % 10 === 0
    expect(selfAuditControlSample('run-…-000a', 's')).toBe(true);   // 0x0a = 10
    expect(selfAuditControlSample('run-…-0001', 's')).toBe(false);
    expect(selfAuditControlSample(null, 'sess-0014')).toBe(true);   // 0x14 = 20
    expect(selfAuditControlSample(null, 'sess-0015')).toBe(false);
    expect(selfAuditControlSample(null, '')).toBe(false);
    // ~10 % of a uniform hex tail
    let hits = 0; for (let i = 0; i < 256; i++) if (selfAuditControlSample(`x-${i.toString(16).padStart(2, '0')}`, 's')) hits += 1;
    expect(hits).toBe(26);
  });

  it('fixer finding 5 — evaluateReceiptRulePromotion: ready only at ≥ 200 labelled wouldSkip:true shadow rows with reopen rate ≤ base + margin; wouldSkip:false and unlabelled rows never count', () => {
    const bar = RECEIPT_RULE_BASE_REOPEN + RECEIPT_RULE_DEMOTE_MARGIN;
    expect(evaluateReceiptRulePromotion([])).toMatchObject({ ready: false, n: 0, reopened: 0, reopenRate: 0, bar });
    const rows = (n: number, reopened: number, wouldSkip = true) => [...Array(n)].map((_, i) => ({ wouldSkip, reopened: i < reopened }));
    expect(evaluateReceiptRulePromotion(rows(RECEIPT_RULE_PROMOTE_MIN_ROWS - 1, 0)).ready).toBe(false); // too few
    expect(evaluateReceiptRulePromotion(rows(RECEIPT_RULE_PROMOTE_MIN_ROWS, 7))).toMatchObject({ ready: true, n: 200, reopened: 7 }); // 3.5 % ≤ 3.8 %
    expect(evaluateReceiptRulePromotion(rows(RECEIPT_RULE_PROMOTE_MIN_ROWS, 8))).toMatchObject({ ready: false, n: 200, reopenRate: 0.04 }); // 4.0 % > 3.8 %
    expect(evaluateReceiptRulePromotion(rows(RECEIPT_RULE_PROMOTE_MIN_ROWS, 8).map((r) => ({ ...r, reopened: null }))).n).toBe(0);
    expect(evaluateReceiptRulePromotion(rows(RECEIPT_RULE_PROMOTE_MIN_ROWS, 0, false)).n).toBe(0);
    expect(evaluateReceiptRulePromotion(rows(RECEIPT_RULE_PROMOTE_MIN_ROWS, 8)).reasons[0]).toMatch(/reopen rate 4\.0 % > bar 3\.8 %/);
  });

  it('fixer finding 5 — checkReceiptRulePromotion is hermetic under NODE_ENV=test (no DB, no store, null)', async () => {
    expect(await checkReceiptRulePromotion()).toBeNull();
  });

  it('evaluateReceiptRuleDemotion: demote only at ≥ 30 labelled control rows with reopen rate > base + margin (unlabelled rows ignored)', () => {
    const bar = RECEIPT_RULE_BASE_REOPEN + RECEIPT_RULE_DEMOTE_MARGIN;
    expect(evaluateReceiptRuleDemotion([])).toEqual({ demote: false, n: 0, reopenRate: 0, bar });
    const rows = (n: number, reopened: number) => [...Array(n)].map((_, i) => ({ reopened: i < reopened }));
    expect(evaluateReceiptRuleDemotion(rows(29, 29)).demote).toBe(false); // too few
    expect(evaluateReceiptRuleDemotion(rows(RECEIPT_RULE_DEMOTE_MIN_ROWS, 1))).toMatchObject({ demote: false, n: 30 }); // 3.3 % ≤ 3.8 %
    expect(evaluateReceiptRuleDemotion(rows(RECEIPT_RULE_DEMOTE_MIN_ROWS, 2))).toMatchObject({ demote: true, n: 30, reopenRate: 2 / 30 });
    expect(evaluateReceiptRuleDemotion([...rows(30, 0), ...[...Array(50)].map(() => ({ reopened: null }))])).toMatchObject({ demote: false, n: 30 });
  });

  it('env readers: mode defaults to shadow (invalid → shadow); the kill switches read 1/true/on; the effective mode never reads the store under NODE_ENV=test', async () => {
    expect(selfAuditReceiptRuleEnvMode()).toBe('shadow');
    process.env.SELF_AUDIT_RECEIPT_RULE_MODE = 'ACT';
    expect(selfAuditReceiptRuleEnvMode()).toBe('act');
    process.env.SELF_AUDIT_RECEIPT_RULE_MODE = 'bogus';
    expect(selfAuditReceiptRuleEnvMode()).toBe('shadow');
    expect(await selfAuditReceiptRuleMode()).toEqual({ mode: 'shadow', source: 'env' });
    process.env.SELF_AUDIT_RECEIPT_RULE_MODE = 'act';
    expect(await receiptRuleAutoDemoted()).toEqual({ demoted: false });
    expect(await selfAuditReceiptRuleMode()).toEqual({ mode: 'act', source: 'env' });
  });
});
