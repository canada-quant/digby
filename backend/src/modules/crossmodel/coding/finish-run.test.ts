/**
 * build 2026-10-08 F-1 — typed finish_run, SHADOW stage (coding/finish-run.ts).
 *
 * Replays the REAL fence shapes the 2026-10-08 finish-run deep dive hand-checked
 * (coding_messages 10-02..10-08, "CLAIMS BLOCK UNVERIFIED" / "MALFORMED"): every
 * unverified fence entry it read was a TRUE claim the fence ontology rejected —
 *   - a PR the run only MERGED, typed `pr` (af1340f8 #10/#12, 4d9661a7 #14/#16/#19,
 *     3532d1ad #66, 7bd45d57 #62, 0fb177d5 #1276),
 *   - a PR opened in the PREVIOUS run of the session (5ebc6180 #67, eeee03db #1300),
 *   - an email typed message_sent (dddbf9ba "…@digby.example.com"), a schedule typed
 *     "schedule" (bb8f1073), a commit typed "commit" (3d99cc0c),
 *   - one-object-per-line JSON (13 of 16 malformed: "Unexpected non-whitespace
 *     character after JSON"),
 *   - a verify ref that is a PR number (5f90c628 "verify 1225") or run_command
 *     output text (b92ef13f / 29dd7893).
 * The finish_run ontology must verify the true ones and still refuse a forged id.
 */

jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  parseFinishRunArgs, verifyFinishClaims, autoFinishClaims, undeclaredSummaryTokens, parseRelayedReceiptRows,
  FinishRunSession, finishRunEligible, finishRunDisabled, finishRunNudgeSkipReason, finishRunAgreementMeta,
  didYouMeanClaimType, receiptProves, isTypeRepair, refIdTokens, refPrNumbers, gitShellShas, executedCallIds,
  FINISH_RUN_OBSERVED_TOOLS, STATE_EXECUTED_TOOLS,
  FINISH_RUN_ACK, FINISH_RUN_NUDGE, FINISH_RUN_SCHEMA, FINISH_CLAIM_TYPES, FINISH_RUN_STATUSES, FINISH_SCOPES,
  FINISH_RUN_METRIC, FINISH_RUN_AGREEMENT_METRIC, FINISH_RUN_TOOL,
  type ReceiptLike, type FinishClaim,
} from './finish-run';
import { NON_EVIDENCE_TOOLS, isEvidenceToolName } from './evidence-tools';
import { RECEIPT_TOOLS } from './run-receipts';
import { looksLikeToolFailure } from './learnings-index.service';
import { LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

const r = (id: string, tool: string, ids: Record<string, unknown> = {}, ok = true): ReceiptLike => ({ id, tool, ok, ids });
const U = (n: number) => `${String(n).padStart(8, '0')}-1111-4222-8333-444455556666`;
const claim = (type: FinishClaim['type'], ref: string, scope?: FinishClaim['scope']): FinishClaim => ({ type, ref, ...(scope ? { scope } : {}) });
const verify1 = async (c: FinishClaim, ev: Partial<Parameters<typeof verifyFinishClaims>[1]> = {}) =>
  (await verifyFinishClaims([c], { thisRun: [], relayed: [], executed: [], ...ev }))[0];

describe('finish_run parsing — forgiving, never throws', () => {
  it('a clean call parses: status, summary, typed claims, open items', () => {
    const p = parseFinishRunArgs(JSON.stringify({
      status: 'done', summary: 'Merged PR #10 after verify.',
      claims: [{ type: 'pr_merged', ref: '10' }, { type: 'push', ref: 'db90360', scope: 'this_run', note: 'PR head' }],
      open_items: [{ text: 'Rebase PR #12', kind: 'next_step', ref: '12' }],
    }));
    expect(p.errors).toEqual([]);
    expect(p.status).toBe('done');
    expect(p.claims).toEqual([{ type: 'pr_merged', ref: '10' }, { type: 'push', ref: 'db90360', scope: 'this_run', note: 'PR head' }]);
    expect(p.openItems).toEqual([{ text: 'Rebase PR #12', kind: 'next_step', ref: '12' }]);
  });

  it('aliases the names models actually wrote in the fence (pr / merge / commit / schedule / email), case-insensitive', () => {
    const p = parseFinishRunArgs({ status: 'Done', summary: 's', claims: [
      { type: 'PR', ref: '67' }, { type: 'merge', ref: '9' }, { type: 'commit', ref: '4e1adb7' },
      { type: 'schedule', ref: 'abcd1234' }, { type: 'Email', ref: 'paul@example.com' },
    ] });
    expect(p.errors).toEqual([]);
    expect(p.claims.map((c) => c.type)).toEqual(['pr_opened', 'pr_merged', 'commit', 'schedule_armed', 'email_sent']);
    expect(p.claims.filter((c) => c.rawType).length).toBe(4); // 'commit' is canonical
  });

  it('an unknown type is an error WITH a did-you-mean, and never drops the sibling claims', () => {
    const p = parseFinishRunArgs({ status: 'done', summary: 's', claims: [{ type: 'mergd', ref: '1' }, { type: 'push', ref: 'abc1234' }] });
    expect(p.errors).toEqual([expect.objectContaining({ kind: 'unknown_type', index: 0, didYouMean: 'pr_merged' })]);
    expect(p.claims).toEqual([{ type: 'push', ref: 'abc1234' }]);
    expect(didYouMeanClaimType('pushd')).toBe('push');
    expect(didYouMeanClaimType('zzzzzzzzzz')).toBeNull();
  });

  it('repairs the fence malformation class: one object per line, trailing commas, a stringified claims array', () => {
    const jsonl = '{"status":"done","summary":"s","claims":[{"type":"push","ref":"abc1234"},]}';
    expect(parseFinishRunArgs(jsonl).repairs).toContain('trailing_commas');
    const stringified = parseFinishRunArgs({ status: 'done', summary: 's', claims: '[{"type":"pr","ref":"5"},{"type":"merge","ref":"5"}]' });
    expect(stringified.claims.map((c) => c.type)).toEqual(['pr_opened', 'pr_merged']);
    expect(stringified.repairs).toContain('claims_stringified');
    const lines = parseFinishRunArgs({ status: 'done', summary: 's', claims: '{"type":"pr","ref":"5"}\n{"type":"merge","ref":"5"}' });
    expect(lines.claims.map((c) => c.type)).toEqual(['pr_opened', 'pr_merged']);
    expect(lines.repairs).toEqual(expect.arrayContaining(['jsonl_objects']));
    const single = parseFinishRunArgs({ status: 'done', summary: 's', claims: { type: 'push', ref: 'abc1234' } });
    expect(single.claims).toHaveLength(1);
    expect(single.repairs).toContain('claims_single_object');
  });

  it('malformed arguments, a bad status and a missing summary are recorded errors — never a throw', () => {
    expect(parseFinishRunArgs('not json at all').errors[0].kind).toBe('malformed_args');
    expect(parseFinishRunArgs(null).errors[0].kind).toBe('malformed_args');
    const p = parseFinishRunArgs({ status: 'kinda', claims: [] });
    expect(p.errors.map((e) => e.kind)).toEqual(['bad_status', 'missing_summary']);
  });

  it('a DOWNGRADE is never an error: blocked with no claims and only open items parses clean', () => {
    const p = parseFinishRunArgs({ status: 'blocked', summary: 'Waiting on the owner for the GPU budget.', open_items: [{ text: 'GPU budget', kind: 'needs_owner' }, 'retry the bench'] });
    expect(p.errors).toEqual([]);
    expect(p.openItems).toEqual([{ text: 'GPU budget', kind: 'needs_owner' }, { text: 'retry the bench', kind: null }]);
  });
});

describe('finish_run ontology — typed for the real receipt shapes (the 2026-10-08 replays)', () => {
  it('af1340f8 #10/#12: a PR the run only MERGED, typed pr_opened, verifies via the merge receipt', async () => {
    const thisRun = [r(U(1), 'merge_pull_request', { repo: 'o/hue', prNumber: 10, mergeSha: '710afc2aa' })];
    const v = await verify1(claim('pr_opened', '10'), { thisRun });
    expect(v).toMatchObject({ outcome: 'verified', via: 'this_run', receiptId: U(1) });
    // …and the merge itself by PR number OR merge sha prefix
    expect((await verify1(claim('pr_merged', '#10'), { thisRun })).outcome).toBe('verified');
    expect((await verify1(claim('pr_merged', '710afc2'), { thisRun })).outcome).toBe('verified');
  });

  it('5ebc6180 #67: a PR opened in the PREVIOUS run verifies as session scope (carried), loaded only when needed', async () => {
    const loadSession = jest.fn(async () => [r(U(2), 'open_pull_request', { prNumber: 67, url: 'https://github.com/o/r/pull/67' })]);
    const v = await verify1(claim('pr_opened', '67'), { thisRun: [r(U(3), 'merge_pull_request', { prNumber: 66 })], loadSession });
    expect(v).toMatchObject({ outcome: 'verified', via: 'session', receiptId: U(2) });
    expect(v.scopeMismatch).toBeUndefined(); // no scope declared ⇒ nothing to mismatch
    expect(loadSession).toHaveBeenCalledTimes(1);
    // a claim found in this run never touches the session read
    const lazy = jest.fn(async () => []);
    await verify1(claim('pr_merged', '66'), { thisRun: [r(U(3), 'merge_pull_request', { prNumber: 66 })], loadSession: lazy });
    expect(lazy).not.toHaveBeenCalled();
  });

  it('a declared scope that is wrong never invalidates a real receipt — verified and FLAGGED', async () => {
    const v = await verify1(claim('pr_opened', '67', 'this_run'), { loadSession: async () => [r(U(2), 'open_pull_request', { prNumber: 67 })] });
    expect(v).toMatchObject({ outcome: 'verified', via: 'session', scopeMismatch: true });
  });

  it('relayed: a lane receipt printed by get_run_receipts this run vouches a supervisor\'s relayed claim', async () => {
    const out = JSON.stringify({ ok: true, tool: 'get_run_receipts', ids: { chatId: 'c' }, runs: [{ id: 'run1', receipts: [{ id: 'aa11bb22', tool: 'merge_pull_request', ok: true, ids: { prNumber: 62, mergeSha: 'c320e711ff' } }] }], chatTurns: [{ runId: null, receipts: [{ id: 'cc33dd44', tool: 'git_push', ok: true, ids: { sha: '5aae8ad8aa', branch: 'digby/s' } }] }] });
    const relayed = parseRelayedReceiptRows(out);
    expect(relayed.map((x) => x.id)).toEqual(['aa11bb22', 'cc33dd44']);
    expect((await verify1(claim('pr_merged', '62', 'relayed'), { relayed })).via).toBe('relayed');
    expect((await verify1(claim('push', '5aae8ad8', 'relayed'), { relayed })).via).toBe('relayed');
    expect(parseRelayedReceiptRows('{truncated')).toEqual([]);
  });

  it('bb8f1073 / 3d99cc0c: a schedule arm and a local commit have their own types', async () => {
    const thisRun = [r(U(4), 'schedule_message', { scheduleId: 'abcd1234-5678-4abc-8def-000000000001', chatId: 'x' }), r(U(5), 'git_commit', { sha: '4e1adb7c0ffee', branch: 'digby/s' })];
    expect((await verify1(claim('schedule_armed', 'abcd1234'), { thisRun })).outcome).toBe('verified');
    expect((await verify1(claim('commit', '4e1adb7'), { thisRun })).outcome).toBe('verified');
    // a commit is LOCAL — it never proves a push, and a push claim resting on it is an OVERCLAIM, never a type
    // repair (build 2026-10-09 FR-1: reason 'downgrade', still rejected)
    expect((await verify1(claim('push', '4e1adb7'), { thisRun }))).toMatchObject({ outcome: 'unverified', reason: 'downgrade', suggestType: 'commit', originCheckable: true });
  });

  it('dddbf9ba: an email typed message_sent is wrong_type → email_sent (the send ran this run); email_sent verifies on the executed tier', async () => {
    const executed = [{ tool: 'send_email_as_digby', ok: true }];
    const wrong = await verify1(claim('message_sent', 'b38cc4f0-a976-5fae-e085-c58f62a13a3b@digby.example.com'), { executed });
    expect(wrong).toMatchObject({ outcome: 'unverified', reason: 'wrong_type', suggestType: 'email_sent' });
    expect(await verify1(claim('email_sent', 'paul@example.com'), { executed })).toMatchObject({ outcome: 'verified', via: 'tool_result' });
    // a FAILED send proves nothing
    expect((await verify1(claim('email_sent', 'paul@example.com'), { executed: [{ tool: 'send_email_as_digby', ok: false }] })).outcome).toBe('unverified');
  });

  it('5f90c628 "verify 1225": a verify ref naming the PR whose gate ran green verifies; a run_command output text is unverifiable, not a conviction', async () => {
    const pr = [r(U(6), 'open_pull_request', { prNumber: 1225, url: 'https://github.com/o/r/pull/1225' })];
    expect((await verify1(claim('verify', '1225'), { thisRun: pr })).outcome).toBe('verified');
    const shell = [r(U(7), 'run_command', {})];
    expect(await verify1(claim('verify', 'Verify PASSED: typecheck exit 0, lint exit 0'), { thisRun: shell })).toMatchObject({ outcome: 'unverifiable', reason: 'run_command_output' });
    // a run_command receipt id is a valid verify ref
    expect((await verify1(claim('verify', U(7).slice(0, 8)), { thisRun: shell })).outcome).toBe('verified');
    // a FAILED verify-tool receipt never vouches
    expect((await verify1(claim('verify', 'chain'), { thisRun: [r(U(8), 'verify', { passed: false, failedStage: 'test' })] })).outcome).toBe('unverified');
    expect((await verify1(claim('verify', 'chain'), { thisRun: [r(U(8), 'verify', { passed: true })] })).outcome).toBe('verified');
  });

  it('ddd26be0: a file_change path verifies on the executed write tier; with only a commit receipt it is unverifiable (receipts carry no paths)', async () => {
    const executed = [{ tool: 'write_file', ok: true, path: '.scratch-f359/f359_w1_tgroup.py' }];
    expect(await verify1(claim('file_change', '.scratch-f359/f359_w1_tgroup.py'), { executed })).toMatchObject({ outcome: 'verified', via: 'tool_result' });
    expect(await verify1(claim('file_change', './scratch/fold_section.md'), { thisRun: [r(U(9), 'git_commit', { sha: 'deadbee1' })] })).toMatchObject({ outcome: 'unverifiable', reason: 'path_not_in_receipts' });
    expect((await verify1(claim('file_change', 'deadbee1'), { thisRun: [r(U(9), 'git_commit', { sha: 'deadbee1' })] })).outcome).toBe('verified');
  });

  it('a deploy ref the receipts cannot adjudicate is unverifiable (GUARD 5 owns it), never verified by an unrelated receipt', async () => {
    expect(await verify1(claim('deploy', '37423813241'), { thisRun: [r(U(10), 'run_command', {})] })).toMatchObject({ outcome: 'unverifiable', reason: 'deploy_not_receipted' });
  });

  it('ANTI-FORGERY: a full-uuid ref matching no receipt is unknown_receipt_id; a failed receipt proves nothing', async () => {
    expect(await verify1(claim('message_sent', U(99)), { thisRun: [r(U(11), 'send_chat_message', { messageId: 'm1' })] })).toMatchObject({ outcome: 'unverified', reason: 'unknown_receipt_id' });
    expect((await verify1(claim('push', 'abc1234'), { thisRun: [r(U(12), 'git_push', { sha: 'abc1234ff' }, false)] })).outcome).toBe('unverified');
    expect(receiptProves('push', 'abc1234', r(U(12), 'git_push', { sha: 'abc1234ff' }, false))).toBe(false);
  });

  it('the precision-sample context: an unverified claim carries the nearest receipts of its class', async () => {
    const v = await verify1(claim('pr_opened', '1300'), { thisRun: [r(U(13), 'open_pull_request', { prNumber: 1302 })] });
    expect(v.outcome).toBe('unverified');
    expect(v.nearest).toEqual([`${U(13).slice(0, 8)} open_pull_request prNumber=1302`]);
  });
});

describe('FinishRunSession — the LAST call is the finish; it is judged against the receipts that existed WHEN it was made', () => {
  it('a claim resting on work done AFTER the call is unverified (a claim cannot rest on later receipts)', async () => {
    const s = new FinishRunSession();
    const receipts: ReceiptLike[] = [];
    expect(s.onCall({ status: 'done', summary: 'pushed', claims: [{ type: 'push', ref: 'abc1234' }] }, receipts.length, 3)).toBe(FINISH_RUN_ACK);
    receipts.push(r(U(20), 'git_push', { sha: 'abc1234ff', branch: 'b' }));
    const rec = await s.finalize({ receipts, nudge: { outcome: 'not_needed' }, finalText: 'final' });
    expect(rec).toMatchObject({ source: 'model', valid: false, unverified: 1, receiptsAtCall: 0 });
  });

  it('a re-finish after more work supersedes the first call', async () => {
    const s = new FinishRunSession();
    const receipts: ReceiptLike[] = [];
    s.onCall({ status: 'partial', summary: 'a', claims: [] }, 0, 1);
    receipts.push(r(U(21), 'git_push', { sha: 'abc1234ff', branch: 'b' }));
    s.onCall({ status: 'done', summary: 'b', claims: [{ type: 'push', ref: 'abc1234' }] }, receipts.length, 4);
    const rec = await s.finalize({ receipts, nudge: { outcome: 'not_needed' }, finalText: 'final' });
    expect(rec).toMatchObject({ source: 'model', calls: 2, status: 'done', valid: true, verified: 1, byVia: { this_run: 1 }, step: 4 });
  });

  it('no call ⇒ AUTO-FINISH from receipts only (never prose): one claim per distinct ref, ok receipts only, pushed commits folded', async () => {
    const s = new FinishRunSession();
    const receipts = [
      r(U(30), 'git_commit', { sha: 'aaa1111', branch: 'b' }), r(U(31), 'git_push', { sha: 'aaa1111', branch: 'b' }),
      r(U(32), 'open_pull_request', { prNumber: 7 }), r(U(33), 'merge_pull_request', { prNumber: 7, mergeSha: 'bbb2222' }),
      r(U(34), 'send_chat_message', { messageId: 'm' }), r(U(35), 'run_command', {}), r(U(36), 'git_push', { sha: 'ccc3333' }, false),
      r(U(37), 'todo_update', { todoId: 'td-1234567' }), r(U(38), 'verify', { passed: true }),
    ];
    const rec = await s.finalize({ receipts, nudge: { outcome: 'prose', ms: 10 }, finalText: 'Merged PR #7.' });
    expect(rec).toMatchObject({ source: 'auto', valid: false, status: null, calls: 0, nudge: { outcome: 'prose', ms: 10 } });
    expect(rec.autoClaimTypes).toEqual({ push: 1, pr_opened: 1, pr_merged: 1, message_sent: 1, ticket_update: 1, verify: 1 });
    expect(autoFinishClaims(receipts).find((c) => c.type === 'commit')).toBeUndefined();
  });

  it('observeToolResult: relayed rows from get_run_receipts; executed sends / writes; other tools ignored', async () => {
    const s = new FinishRunSession();
    s.observeToolResult('get_run_receipts', {}, JSON.stringify({ runs: [{ receipts: [{ id: 'aa11bb22', tool: 'open_pull_request', ok: true, ids: { prNumber: 5 } }] }], chatTurns: [] }), true);
    s.observeToolResult('write_file', { path: 'a/b.ts' }, 'Wrote a/b.ts (10 bytes, 1 lines).', true);
    // an edit that wrote NOTHING is not executed — the file tools are judged by their own success line
    // (an edit_file refusal is failure-shaped since d2e6b0fb; the ^Edited line is the executed proof either way)
    s.observeToolResult('edit_file', { path: 'c/d.ts' }, 'old_string not found in c/d.ts. Read the file and match exactly.', true);
    s.observeToolResult('read_file', { path: 'x' }, 'ok', true);
    s.onCall({ status: 'done', summary: 's', claims: [{ type: 'pr_opened', ref: '5', scope: 'relayed' }, { type: 'file_change', ref: 'a/b.ts' }, { type: 'file_change', ref: 'c/d.ts' }] }, 0, 1);
    const rec = await s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(rec).toMatchObject({ valid: false, verified: 2, unverified: 1, byVia: { relayed: 1, tool_result: 1 }, rejected: [expect.objectContaining({ type: 'file_change', ref: 'c/d.ts' })] });
  });

  it('a session-receipt read failure degrades to "not found", never a throw', async () => {
    const s = new FinishRunSession();
    s.onCall({ status: 'done', summary: 's', claims: [{ type: 'pr_opened', ref: '67' }] }, 0, 1);
    const rec = await s.finalize({ receipts: [], loadSessionReceipts: async () => { throw new Error('db down'); }, nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(rec).toMatchObject({ valid: false, unverified: 1, rejected: [expect.objectContaining({ type: 'pr_opened', ref: '67', reason: 'no_receipt' })] });
  });
});

describe('undeclared ids in the summary (the stage-2 backstop — measured only)', () => {
  it('flags shas / uuids / PR numbers the claims and open items do not name', () => {
    const claims = [claim('pr_merged', '10'), claim('push', 'db90360')];
    const toks = undeclaredSummaryTokens(`Merged PR #10 (push db90360ab) and opened PR #12; steered lane ${U(40)}; build deadbeef ok.`, claims, [{ text: 'follow up', kind: null }]);
    expect(toks).toEqual([U(40), '#12']); // deadbeef has no digit → not a sha; db90360ab prefix-matches the push ref
  });
  it('an open item naming the token covers it', () => {
    expect(undeclaredSummaryTokens('PR #12 still open', [], [{ text: 'rebase PR #12', kind: 'next_step', ref: '12' }])).toEqual([]);
  });
});

describe('agreement rows + nudge skip reasons + eligibility', () => {
  const base = async (valid: boolean) => {
    const s = new FinishRunSession();
    s.onCall({ status: 'done', summary: 's', claims: valid ? [] : [{ type: 'push', ref: 'abc1234' }] }, 0, 1);
    return s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' });
  };
  it('cells: both_clean / detector_only / finish_only / both_flagged / no_finish_*', async () => {
    expect(finishRunAgreementMeta(await base(true), { detector: 'evidence_guard', convicted: false })).toMatchObject({ cell: 'both_clean', agree: true });
    expect(finishRunAgreementMeta(await base(true), { detector: 'evidence_guard', convicted: true, kinds: ['future_dated'] })).toMatchObject({ cell: 'detector_only', agree: false, detectorKinds: ['future_dated'] });
    expect(finishRunAgreementMeta(await base(false), { detector: 'action_verifier', convicted: false })).toMatchObject({ cell: 'finish_only', agree: false, finishRejectedTypes: ['push'] });
    expect(finishRunAgreementMeta(await base(false), { detector: 'action_verifier', convicted: true })).toMatchObject({ cell: 'both_flagged', agree: true });
    const auto = await new FinishRunSession().finalize({ receipts: [], nudge: { outcome: 'prose' }, finalText: 'f' });
    expect(finishRunAgreementMeta(auto, { detector: 'evidence_guard', convicted: true })).toMatchObject({ cell: 'no_finish_flagged', agree: null });
  });

  it('nudge skip reasons, in precedence order', () => {
    const ok = { called: false, finalText: 'answer', cancelled: false, modelErrored: false, deadlineHit: false, terminalBreak: false, retiring: false };
    expect(finishRunNudgeSkipReason(ok)).toBeNull();
    expect(finishRunNudgeSkipReason({ ...ok, called: true, cancelled: true })).toBe('not_needed');
    expect(finishRunNudgeSkipReason({ ...ok, cancelled: true })).toBe('cancelled');
    expect(finishRunNudgeSkipReason({ ...ok, retiring: true, deadlineHit: true })).toBe('retiring');
    expect(finishRunNudgeSkipReason({ ...ok, deadlineHit: true })).toBe('deadline');
    expect(finishRunNudgeSkipReason({ ...ok, terminalBreak: true })).toBe('terminal_break');
    expect(finishRunNudgeSkipReason({ ...ok, finalText: '  ' })).toBe('no_final');
  });

  it('eligible: top-level machine (or owner-dispatched) coding lanes and supervisors only; FINISH_RUN_DISABLED=1 kills it', () => {
    const lane = { topLevel: true, sessionId: 's1', machineTriggered: true, profileKind: 'coding' };
    expect(finishRunEligible(lane, {})).toBe(true);
    expect(finishRunEligible({ ...lane, machineTriggered: false, ownerDispatch: true }, {})).toBe(true);
    expect(finishRunEligible({ ...lane, profileKind: 'chat', supervisorTools: true }, {})).toBe(true);
    expect(finishRunEligible({ ...lane, machineTriggered: false }, {})).toBe(false); // human turn
    expect(finishRunEligible({ ...lane, profileKind: 'chat' }, {})).toBe(false); // plain chat wake
    expect(finishRunEligible({ ...lane, role: 'explorer' }, {})).toBe(false); // delegate worker
    expect(finishRunEligible({ ...lane, topLevel: false }, {})).toBe(false);
    expect(finishRunEligible({ ...lane, fastSeat: true }, {})).toBe(false);
    expect(finishRunEligible({ ...lane, sessionId: 'anon-1' }, {})).toBe(false);
    expect(finishRunEligible(lane, { FINISH_RUN_DISABLED: '1' })).toBe(false);
    expect(finishRunDisabled({ FINISH_RUN_DISABLED: 'on' })).toBe(true);
    expect(finishRunDisabled({})).toBe(false);
  });
});

describe('pins — the harness texts, the schema, the vocabularies', () => {
  it('the ACK echoes nothing the model wrote, states no verdict, and is not failure-shaped', () => {
    expect(FINISH_RUN_ACK).toBe('finish_run recorded. The harness checks it against this run\'s tool receipts; it is not delivered to anyone and changes nothing you write. Now write your complete final answer exactly as you normally would — that text is what gets delivered. Do not call finish_run again unless your status changes.');
    expect(looksLikeToolFailure(FINISH_RUN_ACK)).toBe(false);
    expect(FINISH_RUN_NUDGE.startsWith('[HARNESS NOTICE — not typed by the user]')).toBe(true);
  });

  it('the schema enums are the contract vocabularies', () => {
    const p: any = FINISH_RUN_SCHEMA.function.parameters;
    expect(FINISH_RUN_SCHEMA.function.name).toBe(FINISH_RUN_TOOL);
    expect(p.properties.status.enum).toEqual([...FINISH_RUN_STATUSES]);
    expect(p.properties.claims.items.properties.type.enum).toEqual([...FINISH_CLAIM_TYPES]);
    expect(p.properties.claims.items.properties.scope.enum).toEqual([...FINISH_SCOPES]);
    expect(p.required).toEqual(['status', 'summary']);
  });

  it('finish_run is a NON-evidence tool and never a receipt tool (it observes / changes nothing)', () => {
    expect(NON_EVIDENCE_TOOLS.has('finish_run')).toBe(true);
    expect(isEvidenceToolName('finish_run')).toBe(false);
    expect(RECEIPT_TOOLS.has('finish_run')).toBe(false);
  });

  it('the metric kinds match LOOP_METRIC_KINDS', () => {
    expect(LOOP_METRIC_KINDS.FINISH_RUN).toBe(FINISH_RUN_METRIC);
    expect(LOOP_METRIC_KINDS.FINISH_RUN_AGREEMENT).toBe(FINISH_RUN_AGREEMENT_METRIC);
  });
});

/**
 * build 2026-10-09 FR — the claim-checker gaps, replayed from the REAL 2026-10-09 rejected claims (loop_metrics
 * finish_run meta.rejected — 179 claims on 114 of 362 finishes; ids below are the prod ids / shapes). Every fixed
 * gap verifies (or is a recorded type repair); a genuinely unbacked claim STAYS rejected.
 */
describe('FR — wrong_type is a TYPE REPAIR (valid), suggestions are ref-bound, overclaims stay rejected', () => {
  it('82613275 / 043d049f / ee5fd1223: a real receipt of another type ⇒ repaired, the finish is valid, repairs[] records from → to', async () => {
    const thisRun = [
      r(U(50), 'send_chat_message', { chatId: '82613275-92e3-430f-bd22-88fca1474c97', receiptId: U(50) }),
      r(U(51), 'todo_update', { todoId: '043d049f-94a2-4458-8f37-f8607b7c505d' }),
      r(U(52), 'merge_pull_request', { repo: 'o/r', prNumber: 41, mergeSha: 'ee5fd1223896a' }),
    ];
    expect(await verify1(claim('ticket_update', '82613275'), { thisRun })).toMatchObject({ outcome: 'unverified', reason: 'wrong_type', suggestType: 'message_sent' });
    const s = new FinishRunSession();
    s.onCall({ status: 'done', summary: 'Steered the lane, closed the todo, merged.', claims: [
      { type: 'ticket_update', ref: '82613275' }, { type: 'verify', ref: '043d049f' }, { type: 'push', ref: 'ee5fd1223' },
    ] }, thisRun.length, 2);
    const rec = await s.finalize({ receipts: thisRun, nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(rec).toMatchObject({ valid: true, claims: 3, verified: 0, unverified: 0, repaired: 3, rejected: [] });
    expect(rec.repairs).toEqual([
      { from: 'ticket_update', to: 'message_sent', ref: '82613275', reason: 'wrong_type' },
      { from: 'verify', to: 'ticket_update', ref: '043d049f', reason: 'wrong_type' },
      { from: 'push', to: 'pr_merged', ref: 'ee5fd1223', reason: 'wrong_type' },
    ]);
    const agree = finishRunAgreementMeta(rec, { detector: 'action_verifier', convicted: false });
    expect(agree).toMatchObject({ cell: 'both_clean', finishValid: true, finishRepaired: 3, finishUnverified: 0 });
    expect(isTypeRepair({ claim: claim('push', 'x'), outcome: 'unverified', reason: 'downgrade', suggestType: 'commit' })).toBe(false);
  });

  it('chat-fb1eac7a: "message_sent @codoublez" with NO notify_user this run is NOT suggested as a verify because some relayed verify passed — it stays no_receipt', async () => {
    const relayed = [r('aa11bb22', 'verify', { passed: true, failedStage: null })];
    const v = await verify1(claim('message_sent', '@codoublez'), { relayed });
    expect(v).toMatchObject({ outcome: 'unverified', reason: 'no_receipt' });
    expect(v.suggestType).toBeUndefined();
    // 74d7bfce: a sha claimed as a push with only a passed verify + a FAILED git_push this run — no loophole suggestion
    const thisRun = [r(U(53), 'verify', { passed: true, failedStage: null }), r(U(54), 'git_push', {}, false)];
    expect(await verify1(claim('push', '39746f7'), { thisRun })).toMatchObject({ outcome: 'unverified', reason: 'no_receipt', originCheckable: true });
    // the claim's OWN descriptive verify is unchanged
    expect((await verify1(claim('verify', 'chain green'), { thisRun })).outcome).toBe('verified');
  });

  it('chat-08cf0881 / chat-92b32493: a MUTATION claim on an id this run only READ is observed_only — still rejected; the read itself verifies as verify', async () => {
    const thisRun = [
      { ...r(U(55), 'schedule_get', {}), argsHead: '{"scheduleId":"06eb2bf9-1111-4222-8333-444455556666"}' },
      { ...r(U(56), 'get_feedback', {}), argsHead: '{"id":"7fbc34cd-07f6-4abd-bc33-63b5ba0a5797"}' },
    ];
    expect(await verify1(claim('schedule_armed', '06eb2bf9'), { thisRun })).toMatchObject({ outcome: 'unverified', reason: 'observed_only', suggestType: 'verify' });
    expect(await verify1(claim('ticket_update', '7fbc34cd'), { thisRun })).toMatchObject({ outcome: 'unverified', reason: 'observed_only' });
    expect(await verify1(claim('verify', '06eb2bf9'), { thisRun })).toMatchObject({ outcome: 'verified', via: 'this_run', receiptId: U(55) });
    const s = new FinishRunSession();
    s.onCall({ status: 'done', summary: 's', claims: [{ type: 'schedule_armed', ref: '06eb2bf9' }] }, thisRun.length, 1);
    const rec = await s.finalize({ receipts: thisRun, nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(rec).toMatchObject({ valid: false, repaired: 0, unverified: 1, rejected: [expect.objectContaining({ reason: 'observed_only' })] });
  });

  it('a push only a LOCAL commit carries, a merge only an opened PR carries: reason downgrade, never repaired', async () => {
    const thisRun = [r(U(57), 'git_commit', { sha: '4e1adb7c0ffee', branch: 'b' }), r(U(58), 'open_pull_request', { prNumber: 12 })];
    expect(await verify1(claim('push', '4e1adb7'), { thisRun })).toMatchObject({ reason: 'downgrade', suggestType: 'commit' });
    expect(await verify1(claim('pr_merged', '12'), { thisRun })).toMatchObject({ reason: 'downgrade', suggestType: 'pr_opened' });
  });
});

describe('FR-2 — decorated refs are matched on the id tokens inside them', () => {
  it('f85d739c / 3e64a2b5: "<sha> (words)", "branch@sha", "<sha> (PR #N …)", "PR #19 o/r" verify; an unbacked decorated ref stays rejected', async () => {
    const thisRun = [
      r(U(60), 'git_commit', { sha: 'ec533e982', branch: 'fo/f107-state' }),
      r(U(61), 'git_push', { sha: '5e3f3e90ef0f', branch: 'fo/f107-state' }),
      r(U(62), 'merge_pull_request', { repo: 'o/r', prNumber: 1387, mergeSha: '783cdbae699a' }),
      r(U(63), 'git_push', { sha: '7148fc9eff39', branch: 'digby/session-6eee904c' }),
      r(U(64), 'open_pull_request', { prNumber: 19, url: 'https://github.com/o/schooltime/pull/19' }),
    ];
    for (const c of [
      claim('commit', 'ec533e98 (f108 state amendment on fo/f107-state)'),
      claim('push', '5e3f3e90 (fo/f107-state merge of moved origin/main, push ancestry-verified)'),
      claim('pr_merged', '783cdbae (PR #1387 squash, merged:true confirmed, CI 6/6 green)'),
      claim('push', 'digby/session-6eee904c@7148fc9eff39eebd5fc62cffac8a71a04612dacf'),
      claim('verify', 'PR #19 canada-quant/schooltime'),
    ]) expect((await verify1(c, { thisRun })).outcome).toBe('verified');
    expect(await verify1(claim('ticket_update', 'a9cc9ecf (lane report)'), { thisRun })).toMatchObject({ outcome: 'unverified', reason: 'no_receipt' });
  });

  it('refIdTokens / refPrNumbers: uuids, prefixed ids, digit-bearing hex; words and digitless hex are not ids', () => {
    expect(refIdTokens('ec533e98 (f108 state amendment on fo/f107-state)')).toEqual(['ec533e98']);
    expect(refIdTokens('goal 8f0dcd6f-9469-48a7-87a9-8bba1fc4237d')).toEqual(['8f0dcd6f-9469-48a7-87a9-8bba1fc4237d']);
    expect(refIdTokens('oq_af086e16-9ccd-495b-9517-85a3a1ad1372')).toEqual(['oq_af086e16-9ccd-495b-9517-85a3a1ad1372']);
    expect(refIdTokens('d9e277ec-state')).toEqual(['d9e277ec']);
    expect(refIdTokens('deadbeef save_supervisor_state')).toEqual([]);
    expect(refPrNumbers('PR #19 canada-quant/schooltime')).toEqual([19]);
  });
});

describe('FR-3 — state_update: supervisor state saves, archives, owner questions, cards, stopped runs', () => {
  const FLEET = 'daee2916-fa75-4159-94a1-3d767abfd192';
  const saveArgs = {
    directives: [{ id: '63eaf63f-eba0-4c1e-9d6a-0000000000a1', status: 'done', evidence: 'pr 41 merged' }],
    dispatches: [{ kind: 'session', id: '65e10199-1ddd-40fd-9b90-b46e1470fb56', note: 'archived — done' }],
    notes: 'lane 119df67e mentioned in prose only',
  };
  const applied = JSON.stringify({ applied: ['directives', 'dispatches', 'notes'], errors: [] }, null, 1);

  it('the Fleet Supervisor shapes: "save_supervisor_state", its own chat id, a directive id, an archived lane uuid ⇒ repaired to state_update; an id the save never named stays rejected', async () => {
    const s = new FinishRunSession(FLEET);
    s.observeToolResult('update_supervisor_state', saveArgs, applied, true);
    s.observeToolResult('archive_chat', { chatId: 'c7419649' }, 'Archived chat c7419649-cd02-4718-86b8-ae54f7a17ef9.', true);
    s.onCall({ status: 'done', summary: 'Archived the finished lane and saved state.', claims: [
      { type: 'ticket_update', ref: 'save_supervisor_state' },
      { type: 'ticket_update', ref: 'daee2916' },
      { type: 'ticket_update', ref: '63eaf63f' },
      { type: 'ticket_update', ref: 'c7419649-cd02-4718-86b8-ae54f7a17ef9' },
      { type: 'dispatch', ref: '65e10199' },
      { type: 'state_update', ref: 'StAnne-CtrlPlaneUI + tt-rd project status rows, notes replaced' },
      { type: 'ticket_update', ref: '119df67e' },
    ] }, 0, 3);
    const rec = await s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(rec).toMatchObject({ valid: false, claims: 7, verified: 1, repaired: 5, unverified: 1, byVia: { tool_result: 1 } });
    expect(rec.rejected).toEqual([expect.objectContaining({ type: 'ticket_update', ref: '119df67e', reason: 'no_receipt' })]);
    expect(rec.repairs.filter((x) => typeof x === 'object').map((x: any) => `${x.from}->${x.to}`)).toEqual([
      'ticket_update->state_update', 'ticket_update->state_update', 'ticket_update->state_update', 'ticket_update->state_update', 'dispatch->state_update',
    ]);
  });

  it('a state save that APPLIED nothing proves nothing; without the chat id the own-id claim is not bound', async () => {
    const s = new FinishRunSession();
    s.observeToolResult('update_supervisor_state', { notes: 'x' }, JSON.stringify({ applied: [], errors: ['notes: unchanged'] }), true);
    s.onCall({ status: 'done', summary: 's', claims: [{ type: 'state_update', ref: 'supervisor_state' }] }, 0, 1);
    expect((await s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' })).rejected).toEqual([expect.objectContaining({ reason: 'no_receipt' })]);
    const s2 = new FinishRunSession();
    s2.observeToolResult('update_supervisor_state', saveArgs, applied, true);
    s2.onCall({ status: 'done', summary: 's', claims: [{ type: 'ticket_update', ref: 'daee2916' }] }, 0, 1);
    expect((await s2.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' })).valid).toBe(false);
  });

  it('chat-c9cb1cdb / chat-1fd4b8e9 / chat-b803c162 / chat-7bd4166d: stop_run runId, dismiss_owner_question / cancel_confirmation (empty ids — the args head names them), flag_owner_question', async () => {
    const thisRun = [
      r(U(65), 'stop_run', { chatId: '9a45071e-b29c-4ce7-bdcd-327fa3263883', runId: 'ad58a2d9-0000-4000-8000-0000000000b1' }),
      { ...r(U(66), 'dismiss_owner_question', {}), argsHead: '{"questionId":"oq_af086e16-9ccd-495b-9517-85a3a1ad1372","reason":"answered"}' },
      { ...r(U(67), 'cancel_confirmation', {}), argsHead: '{"confirmationId":"cf_c86cb869"}' },
    ];
    for (const [type, ref] of [['ticket_update', 'ad58a2d9'], ['message_sent', 'ad58a2d9'], ['ticket_update', 'oq_af086e16-9ccd-495b-9517-85a3a1ad1372'], ['ticket_update', 'cf_c86cb869']] as const) {
      expect(await verify1(claim(type, ref), { thisRun })).toMatchObject({ reason: 'wrong_type', suggestType: 'state_update' });
    }
    expect((await verify1(claim('state_update', 'cf_c86cb869'), { thisRun })).outcome).toBe('verified');
    const executed = [{ tool: 'flag_owner_question', ok: true, ids: executedCallIds({ question: 'q?' }, JSON.stringify({ ok: true, questionId: 'oq_1e800549-0000-4000-8000-0000000000c1' })) }];
    expect(await verify1(claim('state_update', 'oq_1e800549'), { executed })).toMatchObject({ outcome: 'verified', via: 'tool_result' });
  });

  it('the state tools are observed; since audit 94f608c1 the three supervisor-state MUTATIONS are receipt tools too, and follow-up 60bfeab1 folds in answer_owner_question', () => {
    // 94f608c1: archive_chat / flag_owner_question / update_supervisor_state
    // moved to the RECEIPT tier (SUPERVISOR_STATE_RECEIPT_TOOLS) — a supervisor
    // claim of an archive / oq_ id / state save is verifiable from its
    // receipts. They stay observed AND stay in STATE_EXECUTED_TOOLS: the
    // executed tier is the anon-session / receipt-write-failure fallback.
    // 60bfeab1 (2026-10-16 follow-up): answer_owner_question joins the same
    // receipted class (specimen: the Fleet Supervisor's 05:24Z triage answer
    // oq_05c1345d) — it stays in STATE_EXECUTED_TOOLS as the fallback tier
    // (and ENVELOPE_OK_TOOLS still reads its success shape on that tier).
    // The remaining state tools (resource/blocker/digest housekeeping) are
    // still executed-only.
    for (const t of STATE_EXECUTED_TOOLS) { expect(FINISH_RUN_OBSERVED_TOOLS.has(t)).toBe(true); }
    for (const t of ['archive_chat', 'flag_owner_question', 'update_supervisor_state', 'answer_owner_question']) {
      expect(RECEIPT_TOOLS.has(t)).toBe(true);
      expect(FINISH_RUN_OBSERVED_TOOLS.has(t)).toBe(true);
    }
    for (const t of ['register_watched_resource', 'release_watched_resource', 'observe_resource', 'register_infra_blocker', 'clear_infra_blocker', 'ack_digest_item', 'unack_digest_item']) {
      expect(RECEIPT_TOOLS.has(t)).toBe(false);
    }
  });
});

describe('FR-4..8 — notify_user, observation reads, shell git, schedule_self, todo heads', () => {
  const notifyOk = JSON.stringify({ ok: true, tool: 'notify_user', channel: 'telegram', deliveredTo: '@codoublez', chars: 120 });

  it('FR-4 notify_user: the handle / channel ref verifies, an email typed for it is repaired, an id-shaped ref is not proven, a failed push proves nothing', async () => {
    const s = new FinishRunSession();
    s.observeToolResult('notify_user', { message: 'x' }, notifyOk, true);
    s.onCall({ status: 'done', summary: 's', claims: [
      { type: 'message_sent', ref: '@codoublez' }, { type: 'message_sent', ref: 'no-id-returned' },
      { type: 'email_sent', ref: 'telegram:@codoublez' }, { type: 'message_sent', ref: 'msg 76502520' },
    ] }, 0, 1);
    const rec = await s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(rec).toMatchObject({ verified: 2, repaired: 1, unverified: 1, rejected: [expect.objectContaining({ ref: 'msg 76502520', reason: 'no_receipt' })] });
    expect(rec.repairs).toContainEqual({ from: 'email_sent', to: 'message_sent', ref: 'telegram:@codoublez', reason: 'wrong_type' });
    expect((await verify1(claim('message_sent', '@codoublez'), { executed: [{ tool: 'notify_user', ok: false }] })).outcome).toBe('unverified');
  });

  it('FR-5 observation reads: verify of the id a read was called with / the read named by tool; a URL nothing fetched stays rejected', async () => {
    const thisRun = [
      { ...r(U(70), 'get_chat_status', {}), argsHead: '{"chatId":"bcd9855c"}' },
      r(U(71), 'list_owner_questions', {}),
      { ...r(U(72), 'goal_get', {}), argsHead: '{"goalId":"8f0dcd6f-9469-48a7-87a9-8bba1fc4237d"}' },
      r(U(73), 'goal_list', {}),
    ];
    expect(await verify1(claim('verify', 'bcd9855c'), { thisRun })).toMatchObject({ outcome: 'verified', receiptId: U(70) });
    expect(await verify1(claim('verify', 'list_owner_questions(open)=0'), { thisRun })).toMatchObject({ outcome: 'verified', receiptId: U(71) });
    expect(await verify1(claim('verify', 'goal 8f0dcd6f-9469-48a7-87a9-8bba1fc4237d'), { thisRun })).toMatchObject({ outcome: 'verified', receiptId: U(72) });
    expect(await verify1(claim('verify', 'https://www.deckpose.com/v1/news (HTTP 200, total 163)'), { thisRun })).toMatchObject({ outcome: 'unverified', reason: 'no_receipt' });
    // a DB row (no heads) never binds an args id
    expect((await verify1(claim('verify', 'bcd9855c'), { loadSession: async () => [r(U(74), 'get_chat_status', {})] })).outcome).toBe('unverified');
  });

  it('FR-6 shell git (27c76183 / 74d7bfce shapes): the push range proves the pushed sha, a commit line the commit; the OLD side proves only a commit', async () => {
    const notice = '[publish-intent notice] this command looks like "git push" via raw shell, which bypasses Digby\'s git_push / open_pull_request.';
    const pushOut = `[command OK]\n${notice}\nTo https://github.com/canada-quant/digby.git\n   cb5da7733..902d54c71  artifact-publish -> main`;
    expect(gitShellShas({ command: 'git push origin artifact-publish:main 2>&1 | tail -2' }, pushOut)).toEqual({ committed: [], pushed: ['902d54c71'], pushedFrom: ['cb5da7733'] });
    const s = new FinishRunSession();
    s.observeToolResult('run_command', { command: 'git push origin artifact-publish:main 2>&1 | tail -2' }, pushOut, true);
    s.observeToolResult('run_command', { command: 'git add .digby/notes/learnings.md && git commit -m "learnings" && git push' },
      `[command OK]\n${notice}\n[digby/session-35b970cc 39746f7] learnings: pgrep\n 1 file changed, 3 insertions(+)\nTo https://github.com/o/r.git\n   0d1e2f3..39746f7  digby/session-35b970cc -> digby/session-35b970cc`, true);
    s.observeToolResult('run_command', { command: 'git commit -am "wip"' }, '[command OK]\n[main 9ab7155] wip\n 2 files changed', true);
    s.observeToolResult('run_command', { command: 'ls -la' }, '[command OK]\n[x 1234567] not git', true);
    s.onCall({ status: 'done', summary: 's', claims: [
      { type: 'push', ref: '902d54c71' }, { type: 'push', ref: '39746f7' }, { type: 'file_change', ref: '39746f7' },
      { type: 'commit', ref: '9ab7155' }, { type: 'commit', ref: 'cb5da7733' }, { type: 'push', ref: 'cb5da7733' }, { type: 'push', ref: '9ab7155' },
      { type: 'commit', ref: '1234567' },
    ] }, 0, 4);
    const rec = await s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(rec).toMatchObject({ verified: 5, repaired: 0, unverified: 3, byVia: { tool_result: 5 } });
    expect(rec.rejected.map((x) => `${x.type}:${x.ref}:${x.reason}`)).toEqual(['push:cb5da7733:downgrade', 'push:9ab7155:downgrade', 'commit:1234567:no_receipt']);
    // a refused / aborted command executed nothing
    expect(gitShellShas({ command: 'git push' }, '[command REFUSED — publish guard] use git_push\n   aaaa111..bbbb222  x -> y')).toBeNull();
  });

  it('FR-7 schedule_self (4ad4715c): the id in "Scheduled (once, id <uuid>)" proves schedule_armed', async () => {
    const s = new FinishRunSession();
    s.observeToolResult('schedule_self', { delayMinutes: 43, prompt: 'continue' }, 'Scheduled (once, id 90e4822e-e161-4ef3-9924-d4492142cb42). Next run at 2026-10-09T08:47:19Z.', true);
    s.onCall({ status: 'partial', summary: 's', claims: [{ type: 'schedule_armed', ref: '90e4822e' }, { type: 'schedule_armed', ref: '06eb2bf9' }] }, 0, 1);
    const rec = await s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(rec).toMatchObject({ verified: 1, unverified: 1, rejected: [expect.objectContaining({ ref: '06eb2bf9', reason: 'no_receipt' })] });
  });

  it('FR-8 812c1e1c: a goal id named by a todo receipt\'s result head is a ticket_update of that goal (this run only — DB rows carry no heads)', async () => {
    const todo = { ...r(U(75), 'todo_update', { todoId: '9a1bee08-6050-4000-8000-0000000000d1' }), resultHead: '{ "id": "9a1bee08-6050-4000-8000-0000000000d1", "goalId": "516c26c7-f9b1-4497-8359-8cd965ecbd0e", "projectId": "p" …' };
    expect(await verify1(claim('ticket_update', '516c26c7'), { thisRun: [todo] })).toMatchObject({ outcome: 'verified', via: 'this_run' });
    expect((await verify1(claim('ticket_update', '516c26c7'), { loadSession: async () => [r(U(75), 'todo_update', { todoId: '9a1bee08-6050-4000-8000-0000000000d1' })] })).outcome).toBe('unverified');
  });

  it('executed evidence is judged as it stood WHEN the call was made (a notify sent after finish_run does not back it)', async () => {
    const s = new FinishRunSession();
    s.onCall({ status: 'done', summary: 's', claims: [{ type: 'message_sent', ref: '@codoublez' }] }, 0, 1);
    s.observeToolResult('notify_user', { message: 'x' }, notifyOk, true);
    expect((await s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'f' })).valid).toBe(false);
  });
});
