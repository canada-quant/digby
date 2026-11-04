/**
 * build 2026-10-11 FA — finish_run: the supervisor "verify of something I read" gap (FA-1), the state tools
 * that mint no receipt (FA-2), and the stage-2 in-loop correction + FINISH_RUN_ACT (FA-3 / FA-4).
 *
 * Replay shapes: the 131 supervisor claims rejected 2026-10-10T01:57Z..2026-10-11 (loop_metrics finish_run,
 * kimi-k3 / glm-5.3 gateway seats). 83 of the 117 rejected `verify` claims named an id the supervisor HAD
 * read this run — an owner-question id from list_owner_questions (oq_1215f6f0, oq_4191ada7), an 8-hex chat /
 * message prefix from get_chat_messages / list_chats, a GitHub Actions run id from get_fleet_telemetry
 * (38107160690), a PR number from github_list_prs (#1425, "pr #56", bare "55"), a decision purpose from
 * get_decision_gate_status (wake_triage), a word a read was called with (collab). The other 34 were never seen
 * this run (25 rode only the wake prompt, 5 only the supervisor's own state-save args, 4 nowhere) — they stay
 * rejected. state_update after answer_owner_question (oq_524247ed) / ack_digest_item ("blocked_todo:<uuid>")
 * were rejected because neither tool mints a receipt.
 */

jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  FinishRunSession, FinishReadIndex, verifyFinishClaims, parseFinishRunArgs, finishRunCorrectionText,
  finishRunActMode, finishRunActDecision, isFinishReadTool, finishRunObservesTool, readResultTokens, readArgTokens,
  FINISH_RUN_ACK, FINISH_RUN_CORRECTION_HEAD, FINISH_RUN_CORRECTION_TAIL, FINISH_RUN_ACT_SEAT_BAR, FINISH_RUN_ACT_SEAT_MIN_RUNS,
  STATE_EXECUTED_TOOLS, FINISH_RUN_OBSERVED_TOOLS,
  type FinishClaim, type FinishActDecision,
} from './finish-run';
import { RECEIPT_TOOLS } from './run-receipts';
import { looksLikeToolFailure } from './learnings-index.service';

const CHAT = '4ed5ca2d-7c1e-4a8b-9f00-1234567890ab';
const MSG = '749bb6c0-1111-4222-8333-444455556666';
const OQ = 'oq_1215f6f0-aaaa-4bbb-8ccc-dddddddddddd';
const STATE_SAVE_ONLY = 'b701d9de';
const claim = (type: FinishClaim['type'], ref: string): FinishClaim => ({ type, ref });
const finalize = (s: FinishRunSession) => s.finalize({ receipts: [], nudge: { outcome: 'not_needed' }, finalText: 'the note' });
const ON: { actMode: 'on' } = { actMode: 'on' };

/** A supervisor wake's reads, as the loop hands them to the session (shapes of the 2026-10-10 runs). */
function supervisorReads(s: FinishRunSession): void {
  s.observeToolResult('list_owner_questions', {}, JSON.stringify({ count: 1, questions: [{ id: OQ, status: 'open' }] }), true);
  s.observeToolResult('get_chat_messages', { chatId: CHAT, limit: 20 }, JSON.stringify({ chatId: CHAT, messages: [{ id: MSG, role: 'assistant', content: 'merged; head 5d180129aa' }], hasMore: false }), true);
  s.observeToolResult('get_fleet_telemetry', { view: 'deploy', kind: 'collab' }, JSON.stringify({ deploys: [{ runId: 38107160690, sha: '5d180129aabbccdd', status: 'success' }] }), true);
  s.observeToolResult('github_list_prs', { owner: 'o', repo: 'r' }, JSON.stringify([{ number: 1425, title: 't' }, { number: 56, title: 'u' }, { number: 55, title: 'v' }]), true);
  s.observeToolResult('get_decision_gate_status', {}, JSON.stringify({ act: ['wake_triage', 'sweep_triage'], shadow: ['self_audit'] }), true);
}

describe('FA-1 — a verify claim is backed by what this run READ (args or returned ids)', () => {
  it('the supervisor replay shapes verify via the read index: oq id, 8-hex chat / message prefixes, a CI run id, PR numbers, a decision purpose, a read-arg word', async () => {
    const s = new FinishRunSession('daee2916-fa75-4159-94a1-3d767abfd192', { actMode: 'off' });
    supervisorReads(s);
    s.onCall({ status: 'done', summary: 'Checked the fleet.', claims: [
      claim('verify', 'oq_1215f6f0'), claim('verify', '4ed5ca2d'), claim('verify', 'msg 749bb6c0'), claim('verify', '38107160690'),
      claim('verify', '#1425'), claim('verify', 'pr #56'), claim('verify', '55'), claim('verify', 'wake_triage'), claim('verify', 'collab'),
      claim('verify', '5d180129'), claim('verify', 'get_chat_messages lane read'),
    ] }, 0, 6);
    const rec = await finalize(s);
    expect(rec).toMatchObject({ valid: true, claims: 11, verified: 11, unverified: 0, byVia: { read: 11 }, readsIndexed: 5, rejectedOnFirst: false });
  });

  it('anything never seen this run STAYS rejected: an id only the wake prompt / the own state-save args carried, a forged full uuid, a PR no read returned', async () => {
    const s = new FinishRunSession('daee2916-fa75-4159-94a1-3d767abfd192', { actMode: 'off' });
    supervisorReads(s);
    // the state save MENTIONS an id in prose (the prod shape), but writing it into the state is not reading it
    // (an id-keyed field of the save — a directive / dispatch id — is the FR-3 state_update repair instead)
    s.observeToolResult('update_supervisor_state', { notes: `lane ${STATE_SAVE_ONLY} quiet, steer queued` }, JSON.stringify({ applied: ['notes'], errors: [] }), true);
    s.onCall({ status: 'done', summary: 's', claims: [
      claim('verify', STATE_SAVE_ONLY), claim('verify', '26fb95e3'), claim('verify', 'bbd02c06-f060-434e-8b8c-7a8720eb09a1'), claim('verify', '#1392'),
    ] }, 0, 7);
    const rec = await finalize(s);
    expect(rec).toMatchObject({ valid: false, verified: 0, unverified: 4, rejectedOnFirst: true });
    expect(rec.rejected.map((x) => `${x.ref}:${x.reason}`)).toEqual([
      `${STATE_SAVE_ONLY}:no_receipt`, '26fb95e3:no_receipt', 'bbd02c06-f060-434e-8b8c-7a8720eb09a1:unknown_receipt_id', '#1392:no_receipt',
    ]);
  });

  it('a mutation claim on an id the run only READ is observed_only (was no_receipt when the id rode a read result)', async () => {
    const s = new FinishRunSession(undefined, { actMode: 'off' });
    supervisorReads(s);
    s.onCall({ status: 'done', summary: 's', claims: [claim('ticket_update', '4ed5ca2d'), claim('pr_merged', '#1425')] }, 0, 6);
    const rec = await finalize(s);
    expect(rec.rejected.map((x) => `${x.type}:${x.reason}:${x.suggestType}`)).toEqual(['ticket_update:observed_only:verify', 'pr_merged:observed_only:verify']);
  });

  it('evidence counts as it stood AT the call (a read after finish_run does not back it); a FAILED read indexes nothing', async () => {
    const s = new FinishRunSession(undefined, { actMode: 'off' });
    s.observeToolResult('get_chat_status', { chatId: 'aaaa1111' }, '{"ok": false, "reason": "not_found"}', !looksLikeToolFailure('{"ok": false, "reason": "not_found"}'));
    s.onCall({ status: 'done', summary: 's', claims: [claim('verify', 'aaaa1111'), claim('verify', OQ)] }, 0, 2);
    s.observeToolResult('list_owner_questions', {}, JSON.stringify({ questions: [{ id: OQ }] }), true);
    expect((await finalize(s))).toMatchObject({ valid: false, unverified: 2, readsIndexed: 1 });
  });

  it('read tools = the platform read set, the observation set and connector reads (never a write, never mcp_ / file tools)', () => {
    for (const t of ['get_chat_messages', 'list_owner_questions', 'get_fleet_telemetry', 'get_run_receipts', 'goal_get', 'get_decision_gate_status', 'github_list_prs', 'gmail_search', 'slack_get_channel_history']) {
      expect(isFinishReadTool(t)).toBe(true);
      expect(finishRunObservesTool(t)).toBe(true);
    }
    for (const t of ['update_supervisor_state', 'send_chat_message', 'gmail_send_email', 'github_create_issue', 'mcp_foo_get', 'read_file', 'grep', 'run_command', 'finish_run']) {
      expect(isFinishReadTool(t)).toBe(false);
    }
  });

  it('the index extractors: result ids / PR numbers / run ids (purposes only from the decision-status read); arg words + ids', () => {
    const res = readResultTokens('get_fleet_telemetry', '{"runs":[{"runId":38107160690,"sha":"5d180129aabb"}],"pr":"#77","items":[{"number":12}],"purpose":"wake_triage"}');
    expect(res).toEqual(expect.arrayContaining(['id:38107160690', 'id:5d180129aabb', 'pr:77', 'pr:12']));
    expect(res).not.toContain('w:wake_triage');
    expect(readResultTokens('get_decision_gate_status', '{"act":["wake_triage"]}')).toContain('w:wake_triage');
    expect(readArgTokens({ chatId: CHAT, view: 'deploy', prNumber: 9, note: 'see PR #44 and 0a1b2c3d' })).toEqual(expect.arrayContaining([
      `w:${CHAT}`, `id:${CHAT}`, 'w:deploy', 'pr:9', 'pr:44', 'id:0a1b2c3d',
    ]));
  });

  it('the index is bounded and prefix-tolerant (8-hex on a full uuid, a 7-hex short sha on a full sha)', () => {
    const idx = new FinishReadIndex();
    idx.add('list_chats', {}, JSON.stringify({ chats: [{ id: CHAT }], head: '7148fc9eff39eebd5fc62cffac8a71a04612dacf' }));
    expect(idx.provesVerify('4ed5ca2d')).toBe(true);
    expect(idx.provesVerify('7148fc9')).toBe(true);
    expect(idx.provesVerify('4ed5ca2e')).toBe(false);
    expect(idx.provesVerify('4ed5ca2d', 0)).toBe(false); // before the read
    const big = new FinishReadIndex();
    big.add('list_chats', {}, Array.from({ length: 900 }, (_, i) => `${String(i).padStart(8, '0')}-1111-4222-8333-444455556666`).join(' '));
    for (let k = 0; k < 10; k++) big.add('list_chats', {}, Array.from({ length: 900 }, (_, i) => `${String(k)}${String(i).padStart(7, '0')}-1111-4222-8333-444455556666`).join(' '));
    expect(big.size).toBeLessThanOrEqual(5_000);
  });
});

describe('FA-2 — answer_owner_question / ack_digest_item are state updates (no receipt — the executed tier)', () => {
  it('state_update oq_524247ed after answer_owner_question verifies; a ticket_update typed for it is repaired; a scope refusal proves nothing', async () => {
    const answered = JSON.stringify({ ok: true, tool: 'answer_owner_question', ids: { questionId: 'oq_524247ed-0000-4000-8000-000000000001', answeredBy: 'supervisor' }, message: 'Answered owner question.' });
    const s = new FinishRunSession(undefined, { actMode: 'off' });
    s.observeToolResult('answer_owner_question', { questionId: 'oq_524247ed', answer: 'go' }, answered, true);
    s.onCall({ status: 'done', summary: 's', claims: [claim('state_update', 'oq_524247ed'), claim('ticket_update', 'oq_524247ed')] }, 0, 2);
    expect(await finalize(s)).toMatchObject({ valid: true, verified: 1, repaired: 1, byVia: { tool_result: 1 } });

    const refused = new FinishRunSession(undefined, { actMode: 'off' });
    refused.observeToolResult('answer_owner_question', { questionId: 'oq_524247ed', answer: 'go' }, 'answer_owner_question is scoped to the Fleet Supervisor chat (and to user-present turns).', true);
    refused.onCall({ status: 'done', summary: 's', claims: [claim('state_update', 'oq_524247ed')] }, 0, 2);
    expect((await finalize(refused)).valid).toBe(false);
  });

  it('ack_digest_item: the key ("blocked_todo:<uuid>") and the uuid inside it verify; an ok:false envelope proves nothing', async () => {
    const key = 'blocked_todo:5cae138c-07e2-4bf2-8c22-0f4c820a0190';
    const s = new FinishRunSession(undefined, { actMode: 'off' });
    s.observeToolResult('ack_digest_item', { key }, JSON.stringify({ ok: true, tool: 'ack_digest_item', key, snoozeUntil: null, message: 'Acknowledged.' }, null, 1), true);
    s.onCall({ status: 'done', summary: 's', claims: [claim('state_update', key), claim('state_update', '5cae138c-07e2-4bf2-8c22-0f4c820a0190')] }, 0, 2);
    expect(await finalize(s)).toMatchObject({ valid: true, verified: 2 });
    const bad = new FinishRunSession(undefined, { actMode: 'off' });
    bad.observeToolResult('ack_digest_item', { key }, JSON.stringify({ ok: false, tool: 'ack_digest_item', key, reason: 'invalid' }, null, 1), true);
    bad.onCall({ status: 'done', summary: 's', claims: [claim('state_update', key)] }, 0, 2);
    expect((await finalize(bad)).valid).toBe(false);
  });

  it('the new state tools are observed; answer_owner_question is a receipt tool since follow-up 60bfeab1 (the executed tier is its fallback), the digest acks stay executed-only', () => {
    for (const t of ['answer_owner_question', 'ack_digest_item', 'unack_digest_item']) {
      expect(STATE_EXECUTED_TOOLS).toContain(t);
      expect(FINISH_RUN_OBSERVED_TOOLS.has(t)).toBe(true);
    }
    // 60bfeab1 (2026-10-16): answer_owner_question moved to the RECEIPT tier
    // (SUPERVISOR_STATE_RECEIPT_TOOLS — the FS's 05:24Z triage answer
    // oq_05c1345d specimen); the executed tier keeps it as the anon-session /
    // receipt-write-failure fallback. The digest acks still mint no receipt.
    expect(RECEIPT_TOOLS.has('answer_owner_question')).toBe(true);
    for (const t of ['ack_digest_item', 'unack_digest_item']) {
      expect(RECEIPT_TOOLS.has(t)).toBe(false);
    }
  });
});

describe('FA-3 — the in-loop correction (stage 2, soft)', () => {
  it('names failing claims by index + type + reason + fix, never echoes a ref, carries no tool-failure marker', async () => {
    const parsed = parseFinishRunArgs({ status: 'done', summary: 's', claims: [
      { type: 'nonsense', ref: 'x' }, { type: 'verify', ref: 'deadbeef12' }, { type: 'push', ref: 'abc1234def' }, { type: 'verify', ref: OQ },
    ] });
    const verdicts = await verifyFinishClaims(parsed.claims, {
      thisRun: [{ id: 'c0ffee00-1111-4222-8333-444455556666', tool: 'git_commit', ok: true, ids: { sha: 'abc1234def0' } }], relayed: [], executed: [],
      readProves: (ref) => ref === OQ,
    });
    const text = finishRunCorrectionText(parsed, verdicts);
    expect(text.startsWith(FINISH_RUN_CORRECTION_HEAD)).toBe(true);
    expect(text.endsWith(FINISH_RUN_CORRECTION_TAIL)).toBe(true);
    expect(text).toContain('- claims[0]: has an unknown type');
    expect(text).toContain('- claims[1] (verify): nothing this run executed or read carries this ref');
    expect(text).toContain('- claims[2] (push): the ref is real, but only as a weaker claim. Fix: claim it as commit');
    expect(text).not.toContain('claims[3]'); // backed by a read
    expect(text).not.toContain('deadbeef12');
    expect(looksLikeToolFailure(text)).toBe(false);
  });

  it('act on: a failing in-loop call gets the correction; the corrected second call gets the ACK — inLoopError / rejectedOnFirst / correctedOnSecond / extraTurnMs', async () => {
    const s = new FinishRunSession(undefined, ON);
    const ctx = { receipts: [] };
    const first = await s.onCallChecked({ status: 'done', summary: 's', claims: [{ type: 'verify', ref: 'oq_4191ada7' }] }, 0, 3, ctx);
    expect(first.startsWith(FINISH_RUN_CORRECTION_HEAD)).toBe(true);
    s.observeToolResult('list_owner_questions', {}, JSON.stringify({ questions: [{ id: 'oq_4191ada7-0000-4000-8000-000000000002' }] }), true);
    const second = await s.onCallChecked({ status: 'done', summary: 's', claims: [{ type: 'verify', ref: 'oq_4191ada7' }] }, 0, 5, ctx);
    expect(second).toBe(FINISH_RUN_ACK);
    expect(await finalize(s)).toMatchObject({
      valid: true, calls: 2, actMode: 'on', actApplied: true, inLoopError: true, rejectedOnFirst: true, correctedOnSecond: true, extraTurnMs: expect.any(Number),
    });
  });

  it('a second INVALID call ends it: ACK (no second correction), the record stays invalid; no second call at all ⇒ correctedOnSecond false', async () => {
    const s = new FinishRunSession(undefined, ON);
    const bad = { status: 'done', summary: 's', claims: [{ type: 'verify', ref: '26fb95e3' }] };
    expect((await s.onCallChecked(bad, 0, 1, { receipts: [] })).startsWith(FINISH_RUN_CORRECTION_HEAD)).toBe(true);
    expect(await s.onCallChecked(bad, 0, 2, { receipts: [] })).toBe(FINISH_RUN_ACK);
    expect(await s.onCallChecked(bad, 0, 3, { receipts: [] })).toBe(FINISH_RUN_ACK);
    expect(await finalize(s)).toMatchObject({ valid: false, calls: 3, inLoopError: true, rejectedOnFirst: true, correctedOnSecond: false });

    const none = new FinishRunSession(undefined, ON);
    await none.onCallChecked(bad, 0, 1, { receipts: [] });
    expect(await finalize(none)).toMatchObject({ valid: false, calls: 1, inLoopError: true, correctedOnSecond: false, extraTurnMs: expect.any(Number) });
  });

  it('a valid first call gets the ACK (no correction, nothing to correct)', async () => {
    const s = new FinishRunSession(undefined, ON);
    expect(await s.onCallChecked({ status: 'no_op', summary: 'nothing needed doing' }, 0, 1, { receipts: [] })).toBe(FINISH_RUN_ACK);
    expect(await finalize(s)).toMatchObject({ valid: true, inLoopError: false, rejectedOnFirst: false, correctedOnSecond: null, actApplied: true });
  });

  it('switch off: the shadow stage exactly — ACK, no correction — but rejectedOnFirst is still measured (the baseline)', async () => {
    const s = new FinishRunSession(undefined, { actMode: 'off' });
    expect(await s.onCallChecked({ status: 'done', summary: 's', claims: [{ type: 'verify', ref: '26fb95e3' }] }, 0, 1, { receipts: [] })).toBe(FINISH_RUN_ACK);
    expect(await finalize(s)).toMatchObject({ valid: false, actMode: 'off', actApplied: false, actReason: 'off', inLoopError: false, rejectedOnFirst: true, correctedOnSecond: null });
  });

  it('switch seats: acts only when the resolver says the seat meets the bar; a failed resolver is shadow (fail-safe)', async () => {
    const bad = { status: 'done', summary: 's', claims: [{ type: 'verify', ref: '26fb95e3' }] };
    const meets: FinishActDecision = finishRunActDecision('seats', { runs: 40, valid: 39 });
    const below: FinishActDecision = finishRunActDecision('seats', { runs: 40, valid: 30 });
    const a = new FinishRunSession(undefined, { actMode: 'seats' });
    expect((await a.onCallChecked(bad, 0, 1, { receipts: [], resolveAct: async () => meets })).startsWith(FINISH_RUN_CORRECTION_HEAD)).toBe(true);
    expect(await finalize(a)).toMatchObject({ actMode: 'seats', actApplied: true, actReason: 'seat_meets_bar', actSeatRate: 0.975, actSeatRuns: 40 });
    const b = new FinishRunSession(undefined, { actMode: 'seats' });
    expect(await b.onCallChecked(bad, 0, 1, { receipts: [], resolveAct: async () => below })).toBe(FINISH_RUN_ACK);
    expect(await finalize(b)).toMatchObject({ actApplied: false, actReason: 'seat_below_bar', inLoopError: false });
    const c = new FinishRunSession(undefined, { actMode: 'seats' });
    expect(await c.onCallChecked(bad, 0, 1, { receipts: [], resolveAct: async () => { throw new Error('db down'); } })).toBe(FINISH_RUN_ACK);
    expect(await finalize(c)).toMatchObject({ actApplied: false, actReason: 'seat_stats_unavailable' });
  });

  it('the session-scope read happens ONCE per run (in-loop check + finalize share it)', async () => {
    const load = jest.fn(async () => []);
    const s = new FinishRunSession(undefined, ON);
    await s.onCallChecked({ status: 'done', summary: 's', claims: [{ type: 'push', ref: 'abc1234' }] }, 0, 1, { receipts: [], loadSessionReceipts: load });
    await s.finalize({ receipts: [], loadSessionReceipts: load, nudge: { outcome: 'not_needed' }, finalText: 'f' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a nudged call is never corrected (the nudge is that run\'s one extra turn) and no in-loop decision is recorded', async () => {
    const s = new FinishRunSession(undefined, ON);
    expect(s.onCall({ status: 'done', summary: 's', claims: [{ type: 'verify', ref: '26fb95e3' }] }, 0, 1, 'nudged')).toBe(FINISH_RUN_ACK);
    expect(await finalize(s)).toMatchObject({ source: 'nudged', valid: false, actMode: 'on', actApplied: null, inLoopError: false, rejectedOnFirst: true, correctedOnSecond: null });
  });
});

describe('FA-4 — FINISH_RUN_ACT parsing and the seat bar', () => {
  it('unset ⇒ on (owner 2026-10-11); off spellings ⇒ off; seats; anything else ⇒ on', () => {
    expect(finishRunActMode({})).toBe('on');
    for (const v of ['off', '0', 'false', 'no', 'shadow', 'OFF']) expect(finishRunActMode({ FINISH_RUN_ACT: v })).toBe('off');
    for (const v of ['seats', 'Seat']) expect(finishRunActMode({ FINISH_RUN_ACT: v })).toBe('seats');
    for (const v of ['on', '1', 'true', 'yes']) expect(finishRunActMode({ FINISH_RUN_ACT: v })).toBe('on');
  });

  it(`the seat bar: ≥ ${FINISH_RUN_ACT_SEAT_BAR} over ≥ ${FINISH_RUN_ACT_SEAT_MIN_RUNS} rows acts; a small / missing sample or unavailable stats stay shadow`, () => {
    expect(finishRunActDecision('seats', { runs: 100, valid: 95 })).toMatchObject({ act: true, reason: 'seat_meets_bar', seatRate: 0.95 });
    expect(finishRunActDecision('seats', { runs: 100, valid: 94 })).toMatchObject({ act: false, reason: 'seat_below_bar' });
    expect(finishRunActDecision('seats', { runs: 10, valid: 10 })).toMatchObject({ act: false, reason: 'seat_sample_small' });
    expect(finishRunActDecision('seats', null)).toMatchObject({ act: false, reason: 'seat_unmeasured' });
    expect(finishRunActDecision('seats', { runs: 100, valid: 100 }, false)).toMatchObject({ act: false, reason: 'seat_stats_unavailable' });
    expect(finishRunActDecision('on')).toMatchObject({ act: true, reason: 'on' });
    expect(finishRunActDecision('off')).toMatchObject({ act: false, reason: 'off' });
  });
});
