/**
 * Pins the run-receipt extractor + claim matcher (run-receipts.ts) — the
 * harness-written evidence channel the guard/verifier resolve claims against.
 * Leaf module, no mocks needed.
 */
import { extractReceipt, receiptHeads, receiptMatchesClaim, RECEIPT_HEAD_CHARS, RECEIPT_TOOLS, sha256, CONTROL_COORD_RECEIPT_TOOLS } from './run-receipts';
import { answerKeyBlockedMessage } from './answer-key-guard';
import * as fs from 'fs';
import * as path from 'path';

describe('receiptHeads (E8, 2026-09-25) — scrubbed ≤200-char args/result heads for the self-audit gate', () => {
  it('collapses whitespace, caps at RECEIPT_HEAD_CHARS with an ellipsis, and tolerates non-JSON args', () => {
    const h = receiptHeads({ command: 'npm   test\n\n--silent' }, `line one\n   line two ${'x'.repeat(400)}`);
    // args are JSON (newlines are the two-char escape \n, kept); runs of real whitespace collapse
    expect(h.argsHead).toBe('{"command":"npm test\\n\\n--silent"}');
    expect(h.resultHead.length).toBe(RECEIPT_HEAD_CHARS);
    expect(h.resultHead.startsWith('line one line two xxx')).toBe(true);
    expect(h.resultHead.endsWith('…')).toBe(true);
    expect(receiptHeads('raw string args', null)).toEqual({ argsHead: 'raw string args', resultHead: '' });
    expect(receiptHeads(undefined, 42)).toEqual({ argsHead: '{}', resultHead: '42' });
  });

  it('never carries a credential shape to the decision backend', () => {
    const h = receiptHeads(
      { command: 'curl -H "Authorization: Bearer eyJabc.def.ghi" https://x', env: 'GITHUB_TOKEN=ghp_abcdefghijklmnop OPENAI_KEY=sk-proj-abcdefghijklmnop' },
      'ok: xoxp-1234567890-abc AKIAABCDEFGHIJKLMNOP done',
    );
    expect(h.argsHead).not.toContain('eyJabc');
    expect(h.argsHead).toContain('Bearer •••');
    expect(h.argsHead).not.toContain('ghp_abcdefghijklmnop');
    expect(h.argsHead).not.toContain('sk-proj-abcdefghijklmnop');
    expect(h.argsHead).toContain('GITHUB_TOKEN=•••');
    expect(h.resultHead).toBe('ok: ••• ••• done');
  });
});

const NOW = new Date('2026-08-24T12:00:00Z');

const env = (tool: string, ids: Record<string, string | number>) =>
  JSON.stringify({ ok: true, tool, ids, message: 'x' });

describe('RECEIPT_TOOLS', () => {
  it('covers the 19 consequential/mutation tools + the 17 read-only platform observation tools', () => {
    // 19 = 7 consequential + file_feedback + update_feedback (ticket 4243f38a)
    // + 5 coding-side + 5 follow-up mutations + goal_premise_set (premise register, 2026-09-16).
    // +17 = PLATFORM_OBSERVE_TOOLS, the read-only fleet/platform observation
    // reads (ticket 212b3aa0; + get_fleet_telemetry 2026-09-18; + test_model_role
    // 2026-09-25 WI-M — the live seat probe) — a fleet-state probe/benchmark
    // claim is proven by these reads, so they must leave receipts.
    // +12 = CONTROL_COORD_RECEIPT_TOOLS (peer verification 2026-09-25 P1-1):
    // stop_run / answer_chat_question / approve_request / pause_schedule /
    // resume_schedule / configure_workspace / import_repo / sync_workspace /
    // set_chat_instructions / cancel_confirmation / dismiss_owner_question /
    // create_chat_webhook — claimable actions that minted no receipt.
    // +1 = stage_upload (2026-09-25 live proof: the file hand-off had no receipt).
    // +1 = merge_pull_request (tt-rd audit 2026-09-27: 287 merges, zero receipts).
    // +1 = list_owner_questions (ticket a9846924, 2026-10-07: the action verifier's
    // board lane names this probe — verbatim — as a sanctioned owner-question
    // status source, yet it minted no receipt, so a claimed fresh probe was
    // receipt-invisible while goal_list / todo_list probes leave rows).
    // +2 = task_get / task_list (build 2026-10-11 DL-1: the delegation ledger's status
    // reads replace get_chat_status polls, so they evidence the same fleet-state claims).
    // +1 = answer_owner_question (follow-up 60bfeab1, 2026-10-16: the triage
    // answer minted no receipt, so a supervisor's "answered oq_…" claim was
    // unverifiable — specimen oq_05c1345d; joins SUPERVISOR_STATE_RECEIPT_TOOLS).
    // +1 = store_secret (audit 2026-10-16 todo 77c88942 item 1, LiteLLM specimen 8fae35a4:
    // "Seven keys banked" was unverifiable — a store mints ids {envKey} now; main's
    // concurrent +2 task ledger reads and this addition union to 59).
    // +1 = notify_user (todo 1e356736 item 1, Fleet specimens monitor lesson 5-f,
    // 2026-10-16: the Telegram push minted no receipt, so "I notified the owner"
    // was unverifiable — specimen: FS wake 2026-10-16 09:00Z send, delivered, no
    // row; joins NOTIFY_RECEIPT_TOOLS with ids {channel} only).
    expect(RECEIPT_TOOLS.size).toBe(61);
    expect(RECEIPT_TOOLS.has('merge_pull_request')).toBe(true);
    expect(RECEIPT_TOOLS.has('stage_upload')).toBe(true);
    expect(RECEIPT_TOOLS.has('store_secret')).toBe(true);
    expect(RECEIPT_TOOLS.has('test_model_role')).toBe(true);
    expect(RECEIPT_TOOLS.has('list_owner_questions')).toBe(true);
    expect(RECEIPT_TOOLS.has('answer_owner_question')).toBe(true);
    expect(RECEIPT_TOOLS.has('notify_user')).toBe(true);
    for (const t of CONTROL_COORD_RECEIPT_TOOLS) expect(RECEIPT_TOOLS.has(t)).toBe(true);
    for (const t of ['send_chat_message', 'file_feedback', 'update_feedback', 'git_commit', 'git_push', 'open_pull_request', 'verify', 'run_command',
      'set_chat_autonomy', 'goal_create', 'goal_update', 'goal_premise_set', 'todo_create', 'todo_update',
      'get_chat_status', 'todo_get', 'list_schedules', 'schedule_get', 'get_feedback']) {
      expect(RECEIPT_TOOLS.has(t)).toBe(true);
    }
  });
});

describe('extractReceipt — platform tools (envelope + prose)', () => {
  it('envelope ok:true → ok receipt carrying the envelope ids + hashes', () => {
    const result = env('send_chat_message', { chatId: 'chat-1' });
    const r = extractReceipt('send_chat_message', { chatId: 'chat-1', message: 'hi' }, result, NOW);
    expect(r).not.toBeNull();
    expect(r).toMatchObject({ tool: 'send_chat_message', ok: true, ids: { chatId: 'chat-1' }, createdAt: NOW });
    expect(r!.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r!.outputHash).toBe(sha256(result));
  });

  it('envelope ids include numbers verbatim (schedule positions etc.)', () => {
    const r = extractReceipt('schedule_message', {}, env('schedule_message', { scheduleId: 's-1', position: 3 }), NOW);
    expect(r).toMatchObject({ ok: true, ids: { scheduleId: 's-1', position: '3' } });
  });

  it('needsConfirmation:true (STAGED) → ok:false receipt carrying {staged:true, confirmationId} (WI-K, 2026-09-25)', () => {
    // Before WI-K a staged call left NO row, so get_run_receipts could not show
    // a lane parked on a card while its note claimed "ok=false rows were staged".
    // The row is visible but NEVER evidence: ok:false keeps it out of every
    // evidence lane (receiptMatchesClaim below pins that).
    const staged = JSON.stringify({ ok: false, needsConfirmation: true, confirmationId: 'cf_1' });
    for (const tool of ['send_chat_message', 'start_coding_session', 'pause_schedule', 'stop_run']) {
      expect(extractReceipt(tool, { id: 'x' }, staged, NOW)).toMatchObject({ tool, ok: false, ids: { staged: true, confirmationId: 'cf_1' } });
    }
    // No confirmationId in the envelope → the row still marks the parking.
    expect(extractReceipt('pause_schedule', {}, JSON.stringify({ ok: false, needsConfirmation: true }), NOW)).toMatchObject({ ok: false, ids: { staged: true } });
    expect(extractReceipt('pause_schedule', {}, JSON.stringify({ ok: false, needsConfirmation: true }), NOW)!.ids).not.toHaveProperty('confirmationId');
    // A staged row never proves a claim.
    const row = { id: 'r1', chatId: 'c', runId: null, ...extractReceipt('pause_schedule', {}, staged, NOW)! };
    expect(receiptMatchesClaim({ kind: 'deploy' }, [row])).toBe(false);
  });

  it('envelope/plain-prose errors → ok:false receipt', () => {
    const r = extractReceipt('send_chat_message', {}, 'Chat not found: "x" — no chat with that exact id is visible to you.', NOW);
    expect(r).toMatchObject({ ok: false, ids: {} });
  });

  it('file_feedback: BOTH prose success shapes carry ticketId (never adopted the envelope)', () => {
    const filed = extractReceipt('file_feedback', {}, 'Filed feedback ticket 3f09a1bc-aaaa-bbbb-cccc-dddddddddddd (bug_report, priority 3): "T". The triage queue handles it from here — do not follow up on it in this run.', NOW);
    expect(filed).toMatchObject({ ok: true, ids: { ticketId: '3f09a1bc-aaaa-bbbb-cccc-dddddddddddd' } });
    const dedup = extractReceipt('file_feedback', {}, 'Already tracked as ticket 9c8b7a6d-1111-2222-3333-444455556666 ("T", priority 2, seen 4 times) — bumped its priority/occurrence count instead of filing a duplicate.', NOW);
    expect(dedup).toMatchObject({ ok: true, ids: { ticketId: '9c8b7a6d-1111-2222-3333-444455556666' } });
    const refused = extractReceipt('file_feedback', {}, 'Feedback NOT filed (rate limit reached): cap.', NOW);
    expect(refused).toMatchObject({ ok: false });
  });
});

describe('extractReceipt — coding-side tools', () => {
  it('git_commit: git stdout "[branch sha] msg" → ok + ids.sha', () => {
    const r = extractReceipt('git_commit', { message: 'fix it' }, '[fix/branch 84fe3ae0] fix it\n 1 file changed, 1 insertion(+)', NOW);
    expect(r).toMatchObject({ ok: true, ids: { sha: '84fe3ae0' } });
  });

  it('git_commit also mints ids.branch — e64fd118: a branch-citing recap must match the df5ea136 receipt-cited exemption', () => {
    // The e64fd118 shape: a productive run re-states its commit-summary heading
    // citing the SESSION branch ("### Committed artifacts (branch
    // `digby/session-…`)") ×6 across 6 turns. The exemption's
    // RECEIPT_CITABLE_ID_KEYS includes 'branch', but git_commit parsed the
    // branch and discarded it (ids.sha only) — the line could never match.
    const r = extractReceipt('git_commit', { message: 'fix it' }, '[digby/session-e64fd118 84fe3ae0] fix it\n 1 file changed, 1 insertion(+)', NOW);
    expect(r).toMatchObject({ ok: true, ids: { sha: '84fe3ae0', branch: 'digby/session-e64fd118' } });
    // ok/false semantics unchanged for non-matching text.
    expect(extractReceipt('git_commit', {}, 'git commit failed: nothing to commit, working tree clean', NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('git_commit: COMMIT BLOCKED and "git commit failed" → ok:false', () => {
    const blocked = extractReceipt('git_commit', {}, 'COMMIT BLOCKED — the staged changes appear to contain secrets: AWS key. Remove them …', NOW);
    expect(blocked).toMatchObject({ ok: false, ids: {} });
    const failed = extractReceipt('git_commit', {}, 'git commit failed: nothing to commit, working tree clean', NOW);
    expect(failed).toMatchObject({ ok: false, ids: {} });
  });

  it('git_push: "Pushed <branch> to GitHub (<url>)." → ok + ids.branch; failure strings are not', () => {
    const ok = extractReceipt('git_push', {}, 'Pushed fix/worker-liveness-rds to GitHub (https://github.com/x/y).', NOW);
    expect(ok).toMatchObject({ ok: true, ids: { branch: 'fix/worker-liveness-rds' } });
    expect(extractReceipt('git_push', {}, 'git push failed: permission denied', NOW)).toMatchObject({ ok: false, ids: {} });
    expect(extractReceipt('git_push', {}, 'No connected GitHub account/token — connect GitHub in Settings → Integrations to push.', NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('git_push: the appended "— sha <sha>" (citable-ids follow-up) lands in ids.sha, branch intact', () => {
    const r = extractReceipt('git_push', {}, 'Pushed fix/x to GitHub (https://github.com/x/y) — sha 84fe3ae0cafebabe1234567890abcdef12.', NOW);
    expect(r).toMatchObject({ ok: true, ids: { branch: 'fix/x', sha: '84fe3ae0cafebabe1234567890abcdef12' } });
  });

  it('open_pull_request: "Opened PR #<n>: <url>" → ok + ids.prNumber/url; failures are not', () => {
    const ok = extractReceipt('open_pull_request', {}, 'Opened PR #300: https://github.com/x/y/pull/300', NOW);
    expect(ok).toMatchObject({ ok: true, ids: { prNumber: 300, url: 'https://github.com/x/y/pull/300' } });
    expect(extractReceipt('open_pull_request', {}, 'Opening the PR failed: Validation Failed', NOW)).toMatchObject({ ok: false, ids: {} });
    expect(extractReceipt('open_pull_request', {}, 'PR blocked: the verify chain (typecheck → lint) has not passed this session. Run verify …', NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('verify: always ok:true; the VERDICT rides in ids.passed / ids.failedStage', () => {
    const pass = extractReceipt('verify', {}, 'Verify PASSED: ✓ typecheck (exit 0)  ✓ lint (exit 0)', NOW);
    expect(pass).toMatchObject({ ok: true, ids: { passed: true, failedStage: null } });
    const fail = extractReceipt('verify', {}, 'Verify FAILED at "lint": ⊘ typecheck (skipped — tool not installed)  ✗ lint (exit 1)\n--- lint output tail ---\nboom', NOW);
    expect(fail).toMatchObject({ ok: true, ids: { passed: false, failedStage: 'lint' } });
    const noChain = extractReceipt('verify', {}, 'No verify chain configured (.digby/config.json has no runnable typecheck/lint/test commands). Add them, then verify.', NOW);
    expect(noChain).toMatchObject({ ok: true, ids: { passed: false, failedStage: null } });
  });

  it('run_command: every NON-success shape tools.ts emits is ok:false (2026-09-08 audit — only the uppercase FAILED banner used to count)', () => {
    expect(extractReceipt('run_command', {}, '[command failed] process vanished before the wait completed', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('run_command', {}, '[command FAILED — exit 1]\nnpm ERR!', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('run_command', {}, 'Tool run_command failed: spawn ENOENT', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('run_command', {}, '[SELF-STARTED MONITOR] The command is still running after 300s. It was started on the background rail…', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('run_command', {}, '[command OK]\ntotal 0', NOW)).toMatchObject({ ok: true });
  });

  it('CT-5 (todo 76fd0cce): run_command carries the verdict into ids — exitCode + commandHash — so a TYPED probe/benchmark claim can name its command', () => {
    // the OK banner and the appended exit tail, both shapes tools.ts emits
    expect(extractReceipt('run_command', { command: 'git rev-parse HEAD' }, '[command OK]\n7d38730f6c', NOW)).toMatchObject({ ok: true, ids: { commandHash: expect.any(String) } });
    expect(extractReceipt('run_command', { command: 'x' }, 'out\n[exit: 0]', NOW)).toMatchObject({ ok: true, ids: { exitCode: 0 } });
    expect(extractReceipt('run_command', { command: 'x' }, '[command FAILED — exit 3]\nboom', NOW)).toMatchObject({ ok: false, ids: { exitCode: 3 } });
    // the same command text hashes the same — the ref a lane cites is stable
    const a = extractReceipt('run_command', { command: 'git rev-parse HEAD' }, '[command OK]', NOW)!;
    const b = extractReceipt('run_command', { command: 'git rev-parse HEAD' }, '[command OK]', NOW)!;
    expect((a.ids as any).commandHash).toBe((b.ids as any).commandHash);
    const c = extractReceipt('run_command', { command: 'git status' }, '[command OK]', NOW)!;
    expect((a.ids as any).commandHash).not.toBe((c.ids as any).commandHash);
    // no command args ⇒ no hash invented
    expect((extractReceipt('run_command', {}, '[command OK]', NOW)!.ids as any).commandHash).toBeUndefined();
  });

  it('run_command: normal return → ok:true (even a non-zero exit EXECUTED); the hard-timeout abort → ok:false', () => {
    expect(extractReceipt('run_command', { command: 'ls' }, 'total 0\n', NOW)).toMatchObject({ ok: true, ids: {} });
    const abort = extractReceipt('run_command', {}, 'Tool "run_command" exceeded 900s and was aborted. Do not retry it; proceed with what you have.', NOW);
    expect(abort).toMatchObject({ ok: false, ids: {} });
  });

  it('non-receipt tools → null', () => {
    expect(extractReceipt('read_file', {}, 'x', NOW)).toBeNull();
    expect(extractReceipt('delegate', {}, 'x', NOW)).toBeNull();
  });

  it('inputHash is canonical (key-sorted): arg order does not change the hash', () => {
    const a = extractReceipt('git_commit', { message: 'm', allow: 1 }, 'x', NOW);
    const b = extractReceipt('git_commit', { allow: 1, message: 'm' }, 'x', NOW);
    expect(a!.inputHash).toBe(b!.inputHash);
  });
});

describe('extractReceipt — follow-up platform mutations (set_chat_autonomy + goal/todo)', () => {
  it('set_chat_autonomy: both prose success shapes → ok + chatId + granted flag', () => {
    const granted = extractReceipt('set_chat_autonomy', {}, 'Autonomy granted for chat c1c2c3d4-1111-2222-3333-444455556666: it may now execute [verify] WITHOUT per-call confirmation (machine-triggered AND user-anchored runs), with a schedule cap of 12/day. The grant is re-checked on every call — revoke any time by re-calling with an empty allowedTools array.', NOW);
    expect(granted).toMatchObject({ ok: true, ids: { chatId: 'c1c2c3d4-1111-2222-3333-444455556666', granted: true } });
    const revoked = extractReceipt('set_chat_autonomy', {}, 'Autonomy revoked for chat c1c2c3d4-1111-2222-3333-444455556666 — machine-triggered runs there can no longer execute consequential tools (the user-turn confirmation gate applies again).', NOW);
    expect(revoked).toMatchObject({ ok: true, ids: { chatId: 'c1c2c3d4-1111-2222-3333-444455556666', granted: false } });
    expect(extractReceipt('set_chat_autonomy', {}, 'set_chat_autonomy requires chatId.', NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('set_chat_autonomy: a confirmation-STAGED call mints the ok:false {staged, confirmationId} row (consequential gate; WI-K)', () => {
    const staged = JSON.stringify({ ok: false, needsConfirmation: true, confirmationId: 'cf_9' });
    expect(extractReceipt('set_chat_autonomy', {}, staged, NOW)).toMatchObject({ ok: false, ids: { staged: true, confirmationId: 'cf_9' } });
    expect(extractReceipt('goal_create', {}, staged, NOW)).toMatchObject({ ok: false, ids: { staged: true, confirmationId: 'cf_9' } });
    expect(extractReceipt('todo_update', {}, staged, NOW)).toMatchObject({ ok: false, ids: { staged: true, confirmationId: 'cf_9' } });
  });

  it('goal_create / todo_create: prose success carries the new id; validation prose is not executed', () => {
    const g = extractReceipt('goal_create', {}, 'Created goal a1b2c3d4-1111-2222-3333-444455556666 "Ship it" (status: on_track). Decompose it with todo_create(...).\n{"id":"a1b2c3d4-1111-2222-3333-444455556666"}', NOW);
    expect(g).toMatchObject({ ok: true, ids: { goalId: 'a1b2c3d4-1111-2222-3333-444455556666' } });
    const t = extractReceipt('todo_create', {}, 'Created todo b2c3d4e5-1111-2222-3333-444455556666 "Do it" (status: blocked). It STARTS BLOCKED on unfinished dependency todos — it auto-unblocks when they finish.\n{"id":"b2c3d4e5-1111-2222-3333-444455556666"}', NOW);
    expect(t).toMatchObject({ ok: true, ids: { todoId: 'b2c3d4e5-1111-2222-3333-444455556666' } });
    expect(extractReceipt('goal_create', {}, 'goal_create requires a non-empty title.', NOW)).toMatchObject({ ok: false, ids: {} });
    expect(extractReceipt('todo_create', {}, 'todo_create requires goalId.', NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('goal_update / todo_update: bare entity JSON → ok + id; thrown-error prose → ok:false', () => {
    const g = extractReceipt('goal_update', {}, JSON.stringify({ id: 'a1b2c3d4-1111-2222-3333-444455556666', title: 'Ship it', status: 'done' }, null, 1), NOW);
    expect(g).toMatchObject({ ok: true, ids: { goalId: 'a1b2c3d4-1111-2222-3333-444455556666' } });
    const t = extractReceipt('todo_update', {}, JSON.stringify({ id: 'b2c3d4e5-1111-2222-3333-444455556666', status: 'done' }, null, 1), NOW);
    expect(t).toMatchObject({ ok: true, ids: { todoId: 'b2c3d4e5-1111-2222-3333-444455556666' } });
    expect(extractReceipt('goal_update', {}, 'Tool goal_update failed: Goal not found', NOW)).toMatchObject({ ok: false, ids: {} });
    // A JSON body WITHOUT an id is not a success either (defensive).
    expect(extractReceipt('todo_update', {}, '{"error":"nope"}', NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('goal_update whose only field was a REFUSED ranking write (rankingApplied:false + changed:false) → ok:false, goal id kept (interaction fix 2026-10-20)', () => {
    const id = 'a1b2c3d4-1111-2222-3333-444455556666';
    const noop = { id, title: 'Ship it', priority: 1, prioritySource: 'owner', priorityNote: "priority/dueAt NOT changed: … The owner's P1 stands.", rankingApplied: false, changed: false };
    expect(extractReceipt('goal_update', { goalId: id, priority: 4 }, JSON.stringify(noop, null, 1), NOW)).toMatchObject({ ok: false, ids: { goalId: id, rankingRefused: true } });
    // A refusal beside a real write (no changed:false) still executed.
    const { changed: _c, ...applied } = noop;
    expect(extractReceipt('goal_update', { goalId: id, title: 'x', priority: 4 }, JSON.stringify(applied, null, 1), NOW)).toMatchObject({ ok: true, ids: { goalId: id } });
    // The flags are goal_update's own shape — never read on todo_update / goal_premise_set.
    expect(extractReceipt('goal_premise_set', {}, JSON.stringify(noop), NOW)).toMatchObject({ ok: true, ids: { goalId: id } });
  });
});

describe('receiptMatchesClaim', () => {
  const prReceipt = (prNumber: number, ok = true) => ({
    id: 'r1', chatId: 'c1', runId: 'run1', tool: 'open_pull_request', ok,
    ids: { prNumber, url: 'u' }, inputHash: null, outputHash: null, createdAt: NOW,
  });
  const pushReceipt = (ok = true) => ({
    id: 'r2', chatId: 'c1', runId: 'run1', tool: 'git_push', ok,
    ids: { branch: 'main' }, inputHash: null, outputHash: null, createdAt: NOW,
  });
  const commitReceipt = (sha: string, ok = true) => ({
    id: 'r3', chatId: 'c1', runId: 'run1', tool: 'git_commit', ok,
    ids: { sha }, inputHash: null, outputHash: null, createdAt: NOW,
  });
  const runCmdReceipt = (ok = true) => ({
    id: 'r4', chatId: 'c1', runId: 'run1', tool: 'run_command', ok,
    ids: {}, inputHash: null, outputHash: null, createdAt: NOW,
  });

  it('prNumber claims id-match the receipt carrying that number', () => {
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 300, text: '' }, [prReceipt(300)])).toBe(true);
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 301, text: '' }, [prReceipt(300)])).toBe(false);
  });

  it('pr_created is id-ONLY: an ok run_command in the set does not exonerate it (layer 3 re-query is that lane)', () => {
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 300, text: '' }, [runCmdReceipt()])).toBe(false);
  });

  it('id prefix-match with the ≥8-char guard BOTH sides (isolated via pr_created — the id-ONLY kind)', () => {
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 12345678, text: '' }, [prReceipt(123456789)])).toBe(true); // cited prefix of actual, both ≥8
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 1234567, text: '' }, [prReceipt(12345670)])).toBe(false); // 7-char cited: no prefix match
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 1234567, text: '' }, [prReceipt(1234567)])).toBe(true); // exact equality ungated
  });

  it('commit_pushed sha id-match: a matching git_push sha exonerates; a git_commit sha (LOCAL, finding A1) and failed/mismatched receipts do not', () => {
    const claim = { kind: 'commit_pushed', sha: '84fe3ae0cafe', text: '' };
    const pushWithSha = (sha: string, ok = true) => ({ ...pushReceipt(ok), ids: { branch: 'b', sha } });
    expect(receiptMatchesClaim(claim, [pushWithSha('84fe3ae0cafebabe')])).toBe(true); // cited prefix of actual, both ≥8
    // Finding A1 (2026-09-27): a git_commit receipt proves the WORKTREE has the
    // sha, never origin — it no longer id-matches a push claim (canlaw 710
    // commits / 1 push passed this line). RSW-1 2026-11-03: the kill switch is
    // gone — the split is unconditional.
    expect(receiptMatchesClaim(claim, [commitReceipt('84fe3ae0cafebabe')])).toBe(false);
    expect(receiptMatchesClaim(claim, [pushWithSha('84fe3ae0cafebabe', false)])).toBe(false); // failed push: no id-match, no ok external
    expect(receiptMatchesClaim({ kind: 'commit_pushed', sha: 'deadbeef99', text: '' }, [commitReceipt('84fe3ae0', false)])).toBe(false);
  });

  it('a FAILED commit carrying the sha does not id-match — but its ok push still evidences coarsely', () => {
    const claim = { kind: 'commit_pushed', sha: '84fe3ae0', text: '' };
    expect(receiptMatchesClaim(claim, [commitReceipt('84fe3ae0', false)])).toBe(false);
    expect(receiptMatchesClaim(claim, [commitReceipt('84fe3ae0', false), pushReceipt()])).toBe(true);
  });

  it('coarse deploy/probe/benchmark accept any ok receipt in the external class', () => {
    for (const kind of ['deploy', 'probe', 'benchmark']) {
      expect(receiptMatchesClaim({ kind, text: '' }, [runCmdReceipt()])).toBe(true);
    }
  });

  it('the hole-fix pin: an ok:false push does NOT evidence a push claim', () => {
    expect(receiptMatchesClaim({ kind: 'commit_pushed', sha: '84fe3ae0', text: '' }, [pushReceipt(false)])).toBe(false);
    expect(receiptMatchesClaim({ kind: 'deploy', text: '' }, [runCmdReceipt(false)])).toBe(false);
  });

  it('unmatched pr_merged/pr_closed fall back to the coarse external class', () => {
    expect(receiptMatchesClaim({ kind: 'pr_merged', prNumber: 5, text: '' }, [runCmdReceipt()])).toBe(true);
    expect(receiptMatchesClaim({ kind: 'pr_closed', prNumber: 5, text: '' }, [pushReceipt(false)])).toBe(false);
  });

  it('no matching receipt → false', () => {
    expect(receiptMatchesClaim({ kind: 'deploy', text: '' }, [])).toBe(false);
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 1, text: '' }, [])).toBe(false);
  });
});

describe('open_pull_request receipt carries the [PR DIFF] shape (tt-rd audit 2026-09-27)', () => {
  const LOG = 'results/2026-08-29-flash-next-device-legs.md';
  it('legacy result (no diff line) → {prNumber, url} exactly as before', () => {
    const r = extractReceipt('open_pull_request', { title: 't' }, 'Opened PR #841: https://github.com/o/r/pull/841', NOW);
    expect(r).toMatchObject({ ok: true, ids: { prNumber: 841, url: 'https://github.com/o/r/pull/841' } });
    expect(Object.keys(r!.ids)).toEqual(['prNumber', 'url']);
  });
  it('with the diff line → filesOnlyMd / files / counts / diffHash ride in ids (CI + notes may sit between)', () => {
    const text = `Opened PR #841: https://github.com/o/r/pull/841\nCI: none (no checks on this sha)\n[PR DIFF] 1 file · +18/−0 · docs-only · hash 0123456789abcdef · ${LOG}\n[DOCS-ONLY PR NOTICE] this PR only appends to ${LOG} (+18/−0), the 4th such PR in 24h — …\nNOTE: the last verify was UNVERIFIED`;
    const r = extractReceipt('open_pull_request', { title: 't' }, text, NOW);
    expect(r).toMatchObject({ ok: true, ids: { prNumber: 841, url: 'https://github.com/o/r/pull/841', filesOnlyMd: true, files: [LOG], fileCount: 1, additions: 18, deletions: 0, diffHash: '0123456789abcdef' } });
    const code = extractReceipt('open_pull_request', {}, 'Opened PR #9: u\n[PR DIFF] 3 files · +40/−12 · code · hash fedcba9876543210 · a.py, b.py, docs/c.md', NOW);
    expect(code!.ids).toMatchObject({ filesOnlyMd: false, filesOnlyState: false, files: ['a.py', 'b.py', 'docs/c.md'], fileCount: 3 });
    // state-only (fixer 2026-09-27): .digby/** only — neither docs-only nor code on the receipt
    const state = extractReceipt('open_pull_request', {}, 'Opened PR #10: u\n[PR DIFF] 1 file · +12/−9 · state-only · hash 0123456789abcdef · .digby/rules/00-current-state.md', NOW);
    expect(state!.ids).toMatchObject({ prNumber: 10, filesOnlyMd: false, filesOnlyState: true, files: ['.digby/rules/00-current-state.md'], additions: 12, deletions: 9 });
  });
  it('a refused / failed open is not a receipt of a PR', () => {
    expect(extractReceipt('open_pull_request', {}, 'PR REFUSED (DOCS_ONLY_PR_ENFORCE=1, machine run): …', NOW)).toMatchObject({ ok: false, ids: {} });
    expect(extractReceipt('open_pull_request', {}, 'Opening the PR failed: A pull request already exists', NOW)).toMatchObject({ ok: false, ids: {} });
  });
});

describe('merge_pull_request receipt (tt-rd audit 2026-09-27, finding docs-churn-log-3)', () => {
  const OK = 'MERGED canada-quant/tt-rd#740 (squash sha 1a2b3c4d5e6f) — confirmed merged:true by follow-up GET · head branch digby/x deleted.\nGate evidence:\n- pr_state: open';
  it('the confirmed-merge line → ok receipt {repo, prNumber, mergeSha}', () => {
    const r = extractReceipt('merge_pull_request', { repo: 'canada-quant/tt-rd', pullNumber: 740 }, OK, NOW);
    expect(r).toMatchObject({ tool: 'merge_pull_request', ok: true, ids: { repo: 'canada-quant/tt-rd', prNumber: 740, mergeSha: '1a2b3c4d5e6f' } });
    expect(r!.outputHash).toBe(sha256(OK));
  });
  it('ALREADY merged is an honest no-op (ok:false, alreadyMerged) — never a fresh merge; blocked / failed / unconfirmed / off are ok:false with no ids', () => {
    expect(extractReceipt('merge_pull_request', {}, 'PR o/r#5 is ALREADY merged (merge sha bbbbbbbbbbbb) — nothing to do. Never re-claim this as a fresh merge.', NOW))
      .toMatchObject({ ok: false, ids: { repo: 'o/r', prNumber: 5, alreadyMerged: true } });
    for (const text of [
      'MERGE BLOCKED at gate "ci": CI is RED on the head sha',
      'MERGE FAILED at the API step (gates were green): merge API answered 405',
      'MERGE UNCONFIRMED: the merge API answered 200 but a follow-up GET does not show merged:true yet',
      'Self-merge is OFF for this project (source: setting).',
      'merge_pull_request is disabled (SELF_MERGE_DISABLED=1)',
      'Tool "merge_pull_request" exceeded 900s and was aborted.',
    ]) {
      expect(extractReceipt('merge_pull_request', {}, text, NOW)).toMatchObject({ ok: false, ids: {} });
    }
  });
  it('proves a pr_merged claim by number and evidences coarse external-action claims', () => {
    const r = extractReceipt('merge_pull_request', {}, OK, NOW)!;
    const receipt = { ...r, id: 'rcp-m', chatId: 'c', runId: 'r' };
    expect(receiptMatchesClaim({ kind: 'pr_merged', prNumber: 740 }, [receipt])).toBe(true);
    expect(receiptMatchesClaim({ kind: 'pr_merged', prNumber: 741 }, [receipt])).toBe(true); // coarse tier: an external action ran
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 740 }, [receipt])).toBe(true); // number match
    expect(receiptMatchesClaim({ kind: 'pr_created', prNumber: 741 }, [receipt])).toBe(false); // pr_created is id-ONLY
  });

  // ── audit 2026-10-16 todo 77c88942 (LiteLLM specimen 8fae35a4) ─────────────
  // "Seven keys banked … store_secret ×7" was an UNVERIFIABLE action claim: a
  // successful store minted no receipt. Now a store mints a receipt with ids
  // {envKey} — the env var NAME only, NEVER the value — so 'banked/stored
  // <KEY>' verifies like any send/dispatch claim.
  describe('store_secret receipts (todo 77c88942)', () => {
    it('a successful store mints ok:true with ids {envKey} — the NAME only, never the value', () => {
      const result = JSON.stringify({
        ok: true, tool: 'store_secret', envKey: 'JWT_PRIVATE_KEY', injectedKey: 'JWT_PRIVATE_KEY',
        label: null, replaced: false, ids: { envKey: 'JWT_PRIVATE_KEY' }, message: 'Stored as $JWT_PRIVATE_KEY',
      });
      const r = extractReceipt('store_secret', { envKey: 'JWT_PRIVATE_KEY' }, result, NOW)!;
      expect(r).not.toBeNull();
      expect(r.ok).toBe(true);
      expect(r.ids).toEqual({ envKey: 'JWT_PRIVATE_KEY' });
      // the receipt row never carries key material: the digests are sha256 of
      // args/result, and the ids envelope holds the NAME only
      expect(JSON.stringify(r.ids)).not.toMatch(/-----BEGIN/);
    });

    it('a refusal envelope mints ok:false (the call ran — proof it did NOT store, never proof it did)', () => {
      const result = JSON.stringify({ ok: false, tool: 'store_secret', reason: 'no_secret_found', message: 'No credential-shaped value found.' });
      const r = extractReceipt('store_secret', { envKey: 'HUE_PASSWORD' }, result, NOW)!;
      expect(r).not.toBeNull();
      expect(r.ok).toBe(false);
      expect(r.ids).toEqual({});
    });

    it('store_secret is in RECEIPT_TOOLS (the unbacked-claim guard can verify a banked claim)', () => {
      expect(RECEIPT_TOOLS.has('store_secret')).toBe(true);
    });
  });
});

// ── Web-probe receipt class (ticket 66007a6e, 2026-10-20) ─────────────────────
// The incident: a project-supervisor chat running hourly uptime probes with
// scrape_as_markdown could NEVER satisfy observe_resource's machine no_receipt
// gate — web tools minted no receipt (not in RECEIPT_TOOLS), so a probe-only
// seat was structurally un-stampable and the watchdog alarmed about a resource
// that WAS probed hourly. The class mints COLLECTOR-ONLY receipts (the agent
// seam skips recordRunReceiptAsync for this set — gate evidence, never claim
// evidence; no run_tool_receipts row, no DB-pool displacement).
//
// EDIT-5 FINDING (parts-lane parity): extractExecutedActions does NOT parse
// web-tool parts at all — its loop admits only TRACKED_SET members
// (TRACKED_CONSEQUENTIAL_TOOLS, executed-actions.ts:20-58: the 8 platform
// mutations + notify_user + the two email tools; no web tool is listed), so
// there is no parts-lane ok-classification to mirror and no pool-verdict
// divergence is possible. buildExecutedPool's receiptCovered filter is
// likewise inert for this class (no row is ever written).
describe('extractReceipt — web-probe tools (ticket 66007a6e)', () => {
  it('the class is admitted by extractReceipt but is NOT RECEIPT_TOOLS membership', () => {
    for (const t of ['scrape_as_markdown', 'scrape_batch', 'search_engine', 'web_pipe', 'youtube_pipe']) {
      expect(extractReceipt(t, {}, 'some content', NOW)).not.toBeNull();
      // Membership there derives behavior beyond minting (intent
      // classification, near-break watch, claim matching) — web reads stay out.
      expect(RECEIPT_TOOLS.has(t)).toBe(false);
    }
  });

  it('ok:true — real scraped content (the incident control scrape of a known-good URL)', () => {
    const r = extractReceipt('scrape_as_markdown', { url: 'https://example.com/' }, '# Example Domain\n\nThis domain is for use in illustrative examples…', NOW);
    expect(r).toMatchObject({ tool: 'scrape_as_markdown', ok: true, ids: { url: 'https://example.com/' } });
  });

  it('ok:true — the DOWN shape "Failed to fetch <url> — the page may be unavailable…" (the fetch was really attempted; the DOWN observation is what an uptime watchdog must stamp)', () => {
    const down = extractReceipt(
      'scrape_as_markdown',
      { url: 'https://cql.ca/api/health' },
      'Failed to fetch https://cql.ca/api/health — the page may be unavailable, blocked, or rate-limited (a transient 403/429 often clears after a cooldown). A retry after a short wait, or trying a different official source for the same content, is fine — just don\'t hammer the same URL repeatedly. If it keeps failing, answer from the search results you already have.',
      NOW,
    );
    expect(down).toMatchObject({ tool: 'scrape_as_markdown', ok: true, ids: { url: 'https://cql.ca/api/health' } });
  });

  it('ok:true — "No search results found. Try a different query." (executed, empty)', () => {
    const r = extractReceipt('search_engine', { query: 'site:example.com nonexistent' }, 'No search results found. Try a different query.', NOW);
    expect(r).toMatchObject({ ok: true, ids: { query: 'site:example.com nonexistent' } });
  });

  it('ok:true — web_pipe SOURCES output (summary + the SOURCES: block)', () => {
    const r = extractReceipt(
      'web_pipe',
      { query: 'uptime monitoring' },
      'Key facts: the endpoint answered 200 on every probe.\n\nSOURCES:\n- Example (https://example.com/health) — via scrape',
      NOW,
    );
    expect(r).toMatchObject({ tool: 'web_pipe', ok: true, ids: { query: 'uptime monitoring' } });
  });

  it('ok:true — the BARE web_pipe zero-source head "(no urls given and search returned nothing)" executes its resolution path', () => {
    const r = extractReceipt('web_pipe', {}, 'web_pipe found no sources (no urls given and search returned nothing).', NOW);
    expect(r).toMatchObject({ ok: true, ids: {} });
  });

  it('ok:false — "Web search failed — the search provider answered with an error…" (SERP provider error)', () => {
    const r = extractReceipt('search_engine', { query: 'x' }, 'Web search failed — the search provider answered with an error instead of results (SERP error, x-brd-error-code=unexpected_q). This is a provider-side failure, NOT an indication that no results exist. Do not treat this as an empty topic: use other tools, your own knowledge, or retry web search shortly.', NOW);
    expect(r).toMatchObject({ ok: false, ids: {} });
  });

  it('ok:false — WEB_DEGRADED_MSG verbatim (degraded gateway observed nothing)', () => {
    const degraded = 'Web search is temporarily unavailable (the search gateway is recovering) — this is a transient infrastructure issue, NOT an indication that no results exist. Do not give up on the topic: use other tools (e.g. GitHub/connector tools) or your own knowledge, note that live web results were unavailable, and you may retry web search shortly.';
    expect(extractReceipt('search_engine', { query: 'x' }, degraded, NOW)).toMatchObject({ ok: false, ids: {} });
    expect(extractReceipt('scrape_as_markdown', { url: 'https://x/' }, degraded, NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('ok:false — "Web tools unavailable." (no toolCache: nothing executed)', () => {
    expect(extractReceipt('scrape_as_markdown', { url: 'https://x/' }, 'Web tools unavailable.', NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('ok:false — "Tool call failed: …" (the thrown catch-all)', () => {
    expect(extractReceipt('scrape_as_markdown', { url: 'https://x/' }, 'Tool call failed: socket hang up. DO NOT retry this tool. Use the information you already have to answer the user\'s question directly.', NOW)).toMatchObject({ ok: false, ids: {} });
  });

  it('ok:false — the hard-timeout abort + scrape_batch plural head + the web_pipe failure notes', () => {
    expect(extractReceipt('scrape_batch', { urls: ['https://a/', 'https://b/'] }, 'Tool "scrape_batch" exceeded 300s and was aborted. Do not retry it; proceed with what you have.', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('scrape_batch', { urls: ['https://a/', 'https://b/'] }, 'Failed to fetch the URLs — pages may be unavailable, blocked, or rate-limited (a transient 403/429 often clears after a cooldown).', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('web_pipe', { query: 'x' }, 'web_pipe search backend failed (SERP error) — the search provider answered with an error page instead of results, so no sources were ingested (the provider\'s own docs/error text was not scraped or stored).', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('web_pipe', { query: 'x' }, 'web_pipe found no sources: the search call failed or was skipped (web-search gateway unreachable / circuit open / rate-limited) — the search provider may be degraded; retry shortly or use search_engine directly.', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('web_pipe', { query: 'x' }, 'web_pipe found no sources: search responded but returned no parseable organic links (likely rate-limit/throttle notice page or SERP shape change) — retrying later or rephrasing the query may help.', NOW)).toMatchObject({ ok: false });
    expect(extractReceipt('web_pipe', { urls: ['https://x/'] }, 'web_pipe could not read any of the 2 source(s).\n- https://x/: HTTP 403', NOW)).toMatchObject({ ok: false });
  });

  it('ids: {url} for a scrape, {query} for a search, both for web_pipe, capped at 200 — and NEVER page content', () => {
    const long = `https://example.com/${'a'.repeat(300)}`;
    const r = extractReceipt('scrape_as_markdown', { url: long }, 'page body', NOW);
    expect((r!.ids.url as string).length).toBe(200);
    // query idem
    const q = extractReceipt('search_engine', { query: 'q'.repeat(300) }, 'results', NOW);
    expect((q!.ids.query as string).length).toBe(200);
    // both ride for web_pipe; neither when args carry neither.
    const both = extractReceipt('web_pipe', { query: 'q1', urls: ['https://a/'] }, 'digest\n\nSOURCES:\n- a (https://a/)', NOW);
    expect(both!.ids).toMatchObject({ query: 'q1' });
    expect(Object.keys(both!.ids).sort()).toEqual(['query']); // urls are NOT an id
    expect(extractReceipt('scrape_as_markdown', {}, 'body text', NOW)!.ids).toEqual({});
    // Privacy contract: ids never carry the page CONTENT.
    expect(JSON.stringify(extractReceipt('scrape_as_markdown', { url: 'https://x/' }, 'SECRET PAGE BODY', NOW)!.ids)).not.toContain('SECRET');
  });

  it('RECEIPT_TOOLS non-membership unchanged — a non-receipt, non-web tool still returns null', () => {
    expect(extractReceipt('fetch_image', {}, 'image data', NOW)).toBeNull();
    expect(extractReceipt('read_file', {}, 'x', NOW)).toBeNull();
  });

  // ── WP-1 (backlog 2026-11-03, todo 52050bfb; review 66007a6e advisory A1) ──
  // youtube_pipe's infrastructure-failure heads used to ride the ok:true
  // default, so a youtube-only probe lane whose search backend was down could
  // stamp observe_resource on a call that retrieved nothing.
  it('WP-1 ok:false — youtube_pipe search-backend heads (both) + the no-transcript head', () => {
    // verbatim heads from youtube-pipe.ts:431 / :438 / :458
    const errBody = 'youtube_pipe found no videos: the search backend answered with an error/debug body instead of results (x-brd-error-code=unexpected_q, HTTP 502) — the search provider is failing; retry shortly, use search_engine to confirm, or pass known video urls directly.';
    const serpErr = 'youtube_pipe found no videos: the search backend failed (SERP error, x-brd-error-code=rate_limited) — the search provider answered with an error instead of results; retry shortly, use search_engine to confirm, or pass known video urls directly.';
    const noTranscript = 'youtube_pipe could not get a transcript for any of the 3 video(s) (no captions, the STT fallback was unavailable or failed, and the BrightData dataset fallback returned no transcript).';
    for (const text of [errBody, serpErr, noTranscript]) {
      const r = extractReceipt('youtube_pipe', { query: 'polk county fla' }, text, NOW);
      expect(r).toMatchObject({ tool: 'youtube_pipe', ok: false, ids: {} });
    }
    // A REAL transcript reshape still mints ok:true (the marker must not over-reach).
    expect(extractReceipt('youtube_pipe', { query: 'q' }, 'Transcript: hello world\n\nSOURCES:\n- a (https://youtu.be/x)', NOW))
      .toMatchObject({ ok: true });
  });

  it('WP-1 ok:true — the BARE youtube_pipe zero-target head (resolution path ran, nothing asked)', () => {
    const r = extractReceipt('youtube_pipe', {}, 'youtube_pipe found no videos (no YouTube urls given and search returned none).', NOW);
    expect(r).toMatchObject({ ok: true, ids: {} });
  });

  it('WP-1 anchor discipline — every marker matches text its producing site can actually emit', () => {
    // The heads are read from the PRODUCING SOURCE, not retyped: a marker that
    // drifts from youtube-pipe.ts fails here rather than silently in prod.
    const src = fs.readFileSync(path.join(__dirname, 'youtube-pipe.ts'), 'utf8');
    expect(src).toContain('youtube_pipe found no videos: the search backend answered with an error/debug body instead of results');
    expect(src).toContain('youtube_pipe found no videos: the search backend failed (SERP error');
    expect(src).toContain('youtube_pipe could not get a transcript for any of the ${targets.length} video(s)');
    expect(src).toContain('youtube_pipe found no videos (no YouTube urls given and search returned none).');
  });

  // ── WP-2 (advisory A2) — the answer-key guard's PRE-phase refusal ──────────
  it('WP-2 answer-key guard: pre-phase refusal mints ok:false, post-phase withhold stays ok:true', () => {
    // Built by the REAL producer (answer-key-guard is a dependency-free leaf).
    const pre = answerKeyBlockedMessage({ tool: 'scrape_as_markdown', label: 'terminal-bench', phase: 'pre', target: 'https://raw.githubusercontent.com/harbor-framework/x' } as any);
    const post = answerKeyBlockedMessage({ tool: 'scrape_as_markdown', label: 'terminal-bench', phase: 'post', target: 'https://raw.githubusercontent.com/harbor-framework/x' } as any);
    expect(pre).toMatch(/^\[ANSWER-KEY GUARD\] scrape_as_markdown refused before any network access/);
    expect(post).toMatch(/^\[ANSWER-KEY GUARD\] scrape_as_markdown output withheld/);
    // pre = refused ⇒ nothing fetched ⇒ ok:false (never a stampable observation)
    expect(extractReceipt('scrape_as_markdown', { url: 'https://raw.githubusercontent.com/harbor-framework/x' }, pre, NOW)).toMatchObject({ ok: false, ids: {} });
    // post = the fetch DID run; only its output is withheld ⇒ ok:true
    expect(extractReceipt('scrape_as_markdown', { url: 'https://raw.githubusercontent.com/harbor-framework/x' }, post, NOW)).toMatchObject({ ok: true });
  });

  it('WP-2 anchor discipline — the refusal head is the one answerKeyBlockedMessage emits', () => {
    const src = fs.readFileSync(path.join(__dirname, 'answer-key-guard.ts'), 'utf8');
    expect(src).toContain('refused before any network access — nothing was fetched.');
    expect(src).toContain('output withheld');
  });
});
