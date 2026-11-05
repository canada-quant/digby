/**
 * evidence-ledger.coding.5036d072.test.ts — the CODING-LANE EvidenceLedger
 * variant (feedback 5036d072 — "EvidenceLedger fabrication-prevention skips
 * coding-profile machine runs — the lane class with the most guard strikes").
 *
 * The a84cc306 ledger was gated OFF for coding-profile machine runs: they got
 * DETECTION only (run-evidence-guard strikes + the claims-fence protocol) and
 * stayed the FM-2.6 recidivists (strike telemetry 2026-09-18: 061b4980 ×13,
 * 9a9911bb ×20, d0597e02 ×34). Built with lane:'coding', the ledger now
 * additionally harvests the receipt families coding finals cite — 'commit'
 * shas from git_commit/git_push/merge_pull_request/check_ci SUCCESS shapes
 * and 'pr' numbers from open_pull_request/merge_pull_request — and renders
 * with claims-block wording. Precision doctrine is unchanged: anchors key on
 * the exact success shapes run-receipts.ts uses to call those calls ok, so
 * failure shapes harvest NOTHING, and run_command stays excluded (sha-dense
 * prior-run laundering). Pure leaf: no mocks, no import graph.
 */

import { createEvidenceLedger, EVIDENCE_LEDGER_PREFIX } from './evidence-ledger';

const COMMIT_OK = '[digby/session-13df1406 e8d5fd417ab] fix(platform): lane-scoped ledger\n 1 file changed, 10 insertions(+), 2 deletions(-)';
const PUSH_OK = 'Pushed digby/session-13df1406 to GitHub (https://github.com/example-org/crossmodel) — sha e8d5fd417ab.';
const PUSH_IDEMPOTENT_SKIP = '[idempotent skip] already done in this run: Pushed digby/session-13df1406 to GitHub — sha 9ceb340ef12 (receipt rcpt-uuid-1). The remote branch already carries this exact commit; nothing new to push.';
const OPEN_PR_OK = 'Opened PR #842: https://github.com/example-org/crossmodel/pull/842';
const MERGE_OK = 'MERGED example-org/crossmodel#842 (squash sha 012d3aa2abcd) — confirmed merged:true by follow-up GET.\nGate evidence:\n- PR open + mergeable clean';
const CHECK_CI_OK = 'CI for 9ceb340ef123: SUCCESS (2 checks)\n- build: success\n- test: success';

describe('createEvidenceLedger lane:"coding" — receipt-family harvest (ticket 5036d072)', () => {
  it('git_commit success shape harvests the commit sha (first-8 normalized)', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('git_commit', COMMIT_OK);
    expect(ledger.render()).toContain('commit e8d5fd41');
  });

  it('git_push success shape harvests the pushed sha — fresh push AND idempotent-skip variants', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('git_push', PUSH_OK);
    expect(ledger.render()).toContain('commit e8d5fd41');
    const ledger2 = createEvidenceLedger({ lane: 'coding' });
    ledger2.ingest('git_push', PUSH_IDEMPOTENT_SKIP);
    expect(ledger2.render()).toContain('commit 9ceb340e');
  });

  it('open_pull_request harvests the PR number (bare number, never hex-normalized)', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('open_pull_request', OPEN_PR_OK);
    const note = ledger.render()!;
    expect(note).toContain('pr 842');
    expect(note).not.toContain('00000842');
  });

  it('merge_pull_request harvests BOTH the PR number and the merge sha', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('merge_pull_request', MERGE_OK);
    const note = ledger.render()!;
    expect(note).toContain('pr 842');
    expect(note).toContain('commit 012d3aa2');
  });

  it('check_ci harvests the API-confirmed head sha from the renderCiStatus shape', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('check_ci', CHECK_CI_OK);
    expect(ledger.render()).toContain('commit 9ceb340e');
  });

  it('platform-tool fleet ids still harvest in the coding lane (todo/ticket/sched/oq machinery is shared)', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('list_feedback', JSON.stringify({ tickets: [{ id: '5036d072-4eee-4f4c-8ad6-cf7e90744b1c', status: 'in_progress' }] }));
    ledger.ingest('todo_update', JSON.stringify({ id: 'd14e0d2d-0000-1111-2222-333344445555', status: 'done' }));
    const note = ledger.render()!;
    expect(note).toContain('ticket 5036d072');
    expect(note).toContain('todo d14e0d2d');
  });

  it('render orders the receipt families first and uses claims-block wording (no rule-6 reference)', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('list_feedback', JSON.stringify({ tickets: [{ id: '5036d072-4eee-4f4c-8ad6-cf7e90744b1c' }] }));
    ledger.ingest('open_pull_request', OPEN_PR_OK);
    ledger.ingest('git_commit', COMMIT_OK);
    const note = ledger.render()!;
    expect(note.startsWith(EVIDENCE_LEDGER_PREFIX)).toBe(true);
    expect(note.indexOf('commit e8d5fd41')).toBeLessThan(note.indexOf('ticket 5036d072'));
    expect(note.indexOf('pr 842')).toBeLessThan(note.indexOf('ticket 5036d072'));
    expect(note).toContain('claims block');
    expect(note).not.toContain('rule 6');
    expect(note).toContain('(id not captured)');
  });
});

describe('createEvidenceLedger lane:"coding" — precision doctrine (failure shapes and sha-dense text harvest NOTHING)', () => {
  it('git_commit refusal shapes (COMMIT BLOCKED / shrink-guard JSON) harvest nothing', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('git_commit', 'COMMIT BLOCKED — the staged changes appear to contain secrets: aws key. Remove them…');
    ledger.ingest('git_commit', JSON.stringify({ ok: false, reason: 'shrink_guard', message: 'COMMIT REFUSED — the staged changes destructively shrink tracked files', files: [{ file: 'a.ts' }] }));
    expect(ledger.render()).toBeNull();
    expect(ledger.size()).toBe(0);
  });

  it('git_push result without a sha harvests nothing (no id was returned)', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('git_push', 'Pushed digby/session-x to GitHub (https://github.com/o/r).');
    expect(ledger.render()).toBeNull();
  });

  it('open_pull_request gate refusals (PR blocked: …) harvest nothing', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('open_pull_request', 'PR blocked: the verify chain (typecheck → test) has not passed this session (last failure: test). Run verify…');
    expect(ledger.render()).toBeNull();
  });

  it('MERGE UNCONFIRMED harvests nothing — the merge did not confirm (the /^MERGED / anchor discipline)', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('merge_pull_request', 'MERGE UNCONFIRMED: the merge API answered 200 but a follow-up GET does not show merged:true yet — do NOT claim this merged. Re-check with a fresh GET before any claim.');
    expect(ledger.render()).toBeNull();
    expect(ledger.size()).toBe(0);
  });

  it('check_ci failure text ("check_ci failed: … 404 …") harvests nothing — the sha was never confirmed on the remote', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('check_ci', 'check_ci failed: GitHub answered 404 for sha 9ceb340ef123 — the commit may not be on the remote yet (push first), or the token lacks repo access.');
    expect(ledger.render()).toBeNull();
  });

  it('run_command stays EXCLUDED in the coding lane — sha-dense free text never launders prior-run ids', () => {
    const ledger = createEvidenceLedger({ lane: 'coding' });
    ledger.ingest('run_command', '[command OK]\ne8d5fd417ab fix x\n012d3aa2abcd merge PR #842\n"sha": "deadbeefcafe"');
    expect(ledger.render()).toBeNull();
    expect(ledger.size()).toBe(0);
  });
});

describe('createEvidenceLedger default (chat) lane — unchanged by the coding variant', () => {
  it('chat-lane ledgers NEVER harvest coding receipt tools, even on success shapes', () => {
    const ledger = createEvidenceLedger(); // default lane: 'chat'
    ledger.ingest('git_commit', COMMIT_OK);
    ledger.ingest('git_push', PUSH_OK);
    ledger.ingest('open_pull_request', OPEN_PR_OK);
    ledger.ingest('merge_pull_request', MERGE_OK);
    ledger.ingest('check_ci', CHECK_CI_OK);
    expect(ledger.render()).toBeNull();
    expect(ledger.size()).toBe(0);
  });

  it('chat-lane render keeps the rule-6 wake-note wording verbatim (the a84cc306 contract)', () => {
    const ledger = createEvidenceLedger();
    ledger.ingest('list_feedback', JSON.stringify({ tickets: [{ id: '5036d072-4eee-4f4c-8ad6-cf7e90744b1c' }] }));
    const note = ledger.render()!;
    expect(note).toContain('rule 6');
    expect(note).toContain('EVIDENCE LIST');
    expect(note).toContain('ticket 5036d072');
  });
});
