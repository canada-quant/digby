/**
 * Finding A1 (receipts / evidence guard, 2026-09-27 — the canlaw / canlegalbench /
 * spark-cluster audit): a local git_commit was a first-class change receipt
 * that exonerated push-shaped claims, and "banked/committed <sha>" was not a
 * claim kind at all — so commit-only work (canlaw: 710 commits / 1 push; spark:
 * "fully banked a65e79f4" relayed 3x with the sha 422 on origin) passed every
 * guard.
 *
 * Pins, against the REAL guard + receipt matcher:
 *   1. receipt classes are SPLIT — a git_commit receipt (LOCAL) never satisfies
 *      a commit_pushed claim (sha-match or coarse tier); git_push / run_command /
 *      github_* still do;
 *   2. the commit_local claim kind — "banked | committed | saved | checkpointed
 *      <sha>" — is mined (push verbs win the clause; honest "not pushed yet"
 *      lines and content-hash labels mine nothing);
 *   3. commit_local requires a git_push receipt or an origin resolve; a
 *      commits-API 404 lands the OBSERVE-ONLY verdict.localOnlyShas strike
 *      ("commit not on origin — local only, not pushed"), never fabricatedShas;
 *   4. a relayed "banked <sha>" gets NO relay exemption (the spark case);
 *   5. git_commit receipt shas no longer enter the origin re-query as
 *      "harness receipt confirmed";
 *   6. the kill switch is GONE (RSW-1 delete-with-ledger 2026-11-03): the
 *      split is unconditional, so nothing restores the pre-split behaviour.
 *
 * Boundary-mocked like run-evidence-guard.test.ts: logger + GitHub token
 * manager are stubs, global.fetch is a mock; the real modules execute.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetValidToken: jest.Mock = jest.fn(async () => 'tok');
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: (...a: any[]) => mockGetValidToken(...a),
}));

import {
  applyCompletionClaimGuard, extractCompletionClaims, claimHasEvidence, citedReceiptProvesClaim,
  relayBindsClaimContent, renderPushVerificationFooter, renderEvidenceGuardNote, renderLineLevelRemovedFinal,
  verdictHasFindings, guardFindingKinds, enforceableVerdict, evaluateFinalCandidateForRejectBack,
  observedRunReceiptEvidence, MAX_VERIFY_SHAS, type CompletionClaim, type GuardVerdict,
} from './run-evidence-guard';
import {
  receiptMatchesClaim, LOCAL_RECEIPT_TOOLS, isLocalReceiptTool, type ToolReceipt,
} from './run-receipts';
import type { MessagePart } from './agent';

const NOW = new Date('2026-09-27T12:00:00Z');
const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };
const SHA = 'a65e79f4c0ffee01';
const SHA2 = '3f2a1b9c7d6e5f40';

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();
const ghResponse = (status: number, body?: any): any => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const rc = (tool: string, ids: Record<string, unknown> = {}, ok = true, id = `r-${tool}-${Math.random().toString(16).slice(2, 10)}`): ToolReceipt =>
  ({ id, chatId: 'c1', runId: 'run1', tool, ok, ids, inputHash: null, outputHash: null, createdAt: NOW });

const call = (name: string): MessagePart => ({ type: 'tool_call', name, args: {} } as any);
const result = (name: string, text: string): MessagePart => ({ type: 'tool_result', name, result: text } as any);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue('tok');
  mockFetch.mockReset();
  global.fetch = mockFetch as any;
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('receipt classes — git_commit is LOCAL (run-receipts)', () => {
  const pushed: CompletionClaim = { kind: 'commit_pushed', sha: SHA, text: `pushed ${SHA} to origin` };
  const local: CompletionClaim = { kind: 'commit_local', sha: SHA, text: `fully banked ${SHA}` };

  it('names the local class', () => {
    expect([...LOCAL_RECEIPT_TOOLS]).toEqual(['git_commit']);
    expect(isLocalReceiptTool('git_commit')).toBe(true);
    expect(isLocalReceiptTool('git_push')).toBe(false);
  });

  it('THE A1 HOLE: an ok git_commit receipt carrying the claimed sha no longer exonerates a commit_pushed claim', () => {
    expect(receiptMatchesClaim(pushed, [rc('git_commit', { sha: SHA })])).toBe(false);
    // …while the git_push receipt with that sha does (the receipt that reached origin).
    expect(receiptMatchesClaim(pushed, [rc('git_push', { branch: 'b', sha: SHA })])).toBe(true);
  });

  it('coarse tier: git_commit is excluded for push-shaped claims; run_command / git_push / github_* still vouch', () => {
    const other: CompletionClaim = { kind: 'commit_pushed', sha: SHA2, text: `pushed ${SHA2}` };
    expect(receiptMatchesClaim(other, [rc('git_commit', { sha: SHA })])).toBe(false);
    expect(receiptMatchesClaim(other, [rc('run_command')])).toBe(true);
    expect(receiptMatchesClaim(other, [rc('git_push', { branch: 'b', sha: SHA })])).toBe(true);
  });

  it('commit_local requires a git_push receipt (sha match or coarse) — a git_commit receipt proves only the worktree', () => {
    expect(receiptMatchesClaim(local, [rc('git_commit', { sha: SHA })])).toBe(false);
    expect(receiptMatchesClaim(local, [])).toBe(false);
    expect(receiptMatchesClaim(local, [rc('git_push', { branch: 'b', sha: SHA })])).toBe(true);
    expect(receiptMatchesClaim(local, [rc('git_push', { branch: 'b', sha: SHA2 })])).toBe(true); // coarse: a push ran this run; origin adjudicates the sha
    expect(receiptMatchesClaim(local, [rc('git_push', { branch: 'b', sha: SHA }, false)])).toBe(false); // failed push proves nothing
  });

  it('other kinds keep their pre-split semantics (a pr_merged coarse fallthrough still accepts any external-action receipt)', () => {
    const pr: CompletionClaim = { kind: 'pr_merged', prNumber: 224, text: 'merged PR #224' };
    expect(receiptMatchesClaim(pr, [rc('git_commit', { sha: SHA })])).toBe(true);
  });

});

describe('commit_local claim extraction', () => {
  it('mines "fully banked <sha>" (the spark relay shape) as commit_local', () => {
    const claims = extractCompletionClaims(`Spark lane: fully banked ${SHA} on lane/spark-b11.`);
    expect(claims).toEqual([{ kind: 'commit_local', sha: SHA, text: `Spark lane: fully banked ${SHA} on lane/spark-b11.` }]);
  });

  it('mines committed <sha>; one claim per sha per line; "saved" / "checkpointed" are NOT git verbs (review fix — ML vocabulary)', () => {
    expect(extractCompletionClaims(`Committed ${SHA}.`).map((c) => c.kind)).toEqual(['commit_local']);
    expect(extractCompletionClaims(`Banked ${SHA} and committed ${SHA}.`)).toHaveLength(1);
    expect(extractCompletionClaims(`Checkpointed ${SHA} and saved ${SHA}.`)).toEqual([]);
    expect(extractCompletionClaims(`Work saved as ${SHA2}; committed ${SHA}.`).map((c) => c.sha)).toEqual([SHA]);
  });

  it('review fix: training / run artefact tokens are never commit shas (the spark-cluster probe phrasings)', () => {
    expect(extractCompletionClaims('Saved checkpoint ckpt-1a2b3c4d to s3://spark/quant/')).toEqual([]);
    expect(extractCompletionClaims('Checkpointed step 2f4e6a8c (loss 0.42)')).toEqual([]);
    expect(extractCompletionClaims('Committed 3 GPUs to job 7b9d1e3f and saved results')).toEqual([]);
    expect(extractCompletionClaims('saved run-4c6e8a0b outputs under results/')).toEqual([]);
    // …and a labelled token stays out of the PUSH miner too (a false fabrication conviction otherwise).
    expect(extractCompletionClaims('pushed ckpt-1a2b3c4d to s3://spark/quant/')).toEqual([]);
    // The git-shaped clause still mines.
    expect(extractCompletionClaims(`committed ${SHA} to lane/spark-b11`).map((c) => c.kind)).toEqual(['commit_local']);
  });

  it('review fix (pre-existing trap): a cited receipt uuid — or a receipt-id prefix — on a push/banked line is never mined as a second sha', () => {
    const uuid = '9c8b7a6d-1111-2222-3333-444455556666';
    expect(extractCompletionClaims(`pushed ${SHA} to origin (receipt ${uuid}).`).map((c) => c.sha)).toEqual([SHA]);
    expect(extractCompletionClaims(`banked ${SHA} (receipt ${uuid}: git_push ok).`).map((c) => c.sha)).toEqual([SHA]);
    expect(extractCompletionClaims(`pushed ${SHA} (receipt 9c8b7a6d…).`).map((c) => c.sha)).toEqual([SHA]);
    expect(extractCompletionClaims(`pushed ${SHA} (receipt id: 9c8b7a6d).`).map((c) => c.sha)).toEqual([SHA]);
    // A bare uuid with a push verb and no sha claims nothing at all.
    expect(extractCompletionClaims(`pushed the branch (receipt ${uuid}).`)).toEqual([]);
  });

  it('a clause that also carries a push verb is ONE commit_pushed claim (push wins)', () => {
    const claims = extractCompletionClaims(`Committed and pushed ${SHA} to origin/main.`);
    expect(claims).toEqual([{ kind: 'commit_pushed', sha: SHA, text: `Committed and pushed ${SHA} to origin/main.` }]);
  });

  it('an HONEST local marker on the line mines nothing ("not pushed yet", "local only")', () => {
    expect(extractCompletionClaims(`Committed ${SHA} — not pushed yet.`)).toEqual([]);
    expect(extractCompletionClaims(`Checkpointed ${SHA} (local only, push after CI).`)).toEqual([]);
    expect(extractCompletionClaims(`Banked ${SHA} locally; pending push.`)).toEqual([]);
  });

  it('no sha, a content-hash label, or a windowed negation → no claim', () => {
    expect(extractCompletionClaims('Banked the results in the worksheet.')).toEqual([]);
    expect(extractCompletionClaims(`Doc md5 ${SHA} saved to the manifest.`)).toEqual([]);
    expect(extractCompletionClaims(`Could not commit; nothing committed for ${SHA}.`)).toEqual([]);
  });

});

describe('evidence tiers for the origin-bearing sha kinds', () => {
  const local: CompletionClaim = { kind: 'commit_local', sha: SHA, text: `banked ${SHA}` };
  const pushed: CompletionClaim = { kind: 'commit_pushed', sha: SHA, text: `pushed ${SHA}` };

  it('parts tier: a git_commit call is not origin evidence; git_push / run_command / github_* are', () => {
    expect(claimHasEvidence(local, [call('git_commit')])).toBe(false);
    expect(claimHasEvidence(pushed, [call('git_commit')])).toBe(false);
    expect(claimHasEvidence(local, [call('git_push')])).toBe(true);
    expect(claimHasEvidence(local, [call('run_command')])).toBe(true);
    expect(claimHasEvidence(local, [call('github_get_commit')])).toBe(true);
  });

  it('citation lane: a cited git_commit receipt with the sha cannot prove a push/banked line', () => {
    const commit = rc('git_commit', { sha: SHA }, true, 'aaaaaaaa-1111');
    const push = rc('git_push', { branch: 'b', sha: SHA }, true, 'bbbbbbbb-2222');
    expect(citedReceiptProvesClaim(pushed, [commit], [])).toBe(false);
    expect(citedReceiptProvesClaim(local, [commit], [])).toBe(false);
    expect(citedReceiptProvesClaim(local, [push], [])).toBe(true);
  });

  it('relay content binding covers commit_local like commit_pushed (the sha must be in the observed output)', () => {
    expect(relayBindsClaimContent(local, [`… "sha":"${SHA}" …`])).toBe(true);
    expect(relayBindsClaimContent(local, ['nothing here'])).toBe(false);
  });

  it('line-level REPLACE: a git_commit-backed push line is not a "receipted survivor"; a git_push-backed one is', () => {
    const verdict: GuardVerdict = {
      unprovenKinds: ['probe'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [],
      unprovenClaims: [{ kind: 'probe', text: 'box probe healthy md5 deadbeef00' }],
    };
    const originalText = `pushed ${SHA} to origin\nbox probe healthy md5 deadbeef00`;
    const withCommit = renderLineLevelRemovedFinal({ originalText, verdict, receipts: [rc('git_commit', { sha: SHA })], triggerKind: 'schedule' });
    expect(withCommit).toBeNull();
    const withPush = renderLineLevelRemovedFinal({ originalText, verdict, receipts: [rc('git_push', { branch: 'b', sha: SHA })], triggerKind: 'schedule' });
    expect(withPush?.finalText).toContain(`pushed ${SHA} to origin`);
    expect(withPush?.removedLines).toEqual(['box probe healthy md5 deadbeef00']);
  });
});

describe('rendering', () => {
  it('push footer: a local-sourced 404 renders LOCAL ONLY — not pushed (never "fabricated")', () => {
    const text = renderPushVerificationFooter([
      { sha: SHA, state: 'missing', source: 'local' },
      { sha: SHA2, state: 'missing', source: 'claim' },
      { sha: 'c0ffee1234567', state: 'present', source: 'local' },
    ]);
    expect(text).toContain(`${SHA.slice(0, 12)}… — ⚠︎ LOCAL ONLY — commit not on origin (404)`);
    expect(text).toContain('treat it as NOT PUSHED');
    expect(text).toContain(`${SHA2.slice(0, 12)}… — ❌ UNVERIFIED`);
    expect(text).toContain('c0ffee123456… — ✅ EXISTS on origin');
  });

  it('guard-1 note names the commit_local gap with the sha', () => {
    const note = renderEvidenceGuardNote([{ kind: 'commit_local', sha: SHA, text: 'x' }], { triggerKind: 'schedule', resumed: false });
    expect(note).toContain(`commit_local (${SHA.slice(0, 12)})`);
    expect(note).toContain('LOCAL ONLY — not pushed');
    expect(renderEvidenceGuardNote([{ kind: 'probe', text: 'x' }], { triggerKind: 'schedule', resumed: false })).not.toContain('commit_local');
  });

  it('verdict plumbing: localOnlyShas is a finding + kind local_only_commit', () => {
    const v: GuardVerdict = { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], localOnlyShas: [SHA] };
    expect(verdictHasFindings(v)).toBe(true);
    expect(guardFindingKinds(v)).toEqual(['local_only_commit']);
  });
});

describe('applyCompletionClaimGuard end-to-end (machine trigger, receipts provided)', () => {
  it('THE SPARK CASE: "fully banked <sha>" with only a git_commit receipt and a 404 on origin → unproven commit_local + localOnlyShas (observe-only), NOT fabricatedShas', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: `Spark B11: fully banked ${SHA} on lane/spark-b11.`,
      parts: [call('git_commit')], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('git_commit', { sha: SHA })],
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_local']);
    expect(out.verdict.localOnlyShas).toEqual([SHA]);
    expect(out.verdict.fabricatedShas).toBeUndefined();
    expect(guardFindingKinds(out.verdict)).toEqual(['unproven_completion', 'local_only_commit']);
    expect(out.finalText).toContain('LOCAL ONLY — commit not on origin (404)');
    expect(out.finalText).toContain('a local git_commit is not a push');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe(`https://api.github.com/repos/o/r/commits/${SHA}`);
  });

  it('the same line backed by a git_push receipt carrying the sha, present on origin → clean', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { sha: SHA }));
    const out = await applyCompletionClaimGuard({
      finalText: `Spark B11: fully banked ${SHA} on lane/spark-b11.`,
      parts: [call('git_commit'), call('git_push')], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('git_commit', { sha: SHA }), rc('git_push', { branch: 'lane/spark-b11', sha: SHA })],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.localOnlyShas).toBeUndefined();
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toContain('EXISTS on origin');
  });

  it('a msg-labelled hex id in the clause is a relay citation, never a sha', () => {
    expect(extractCompletionClaims(`Lane relayed (msg 1a2b3c4d5e6f7a8b): fully banked ${SHA}.`).map((c) => c.sha)).toEqual([SHA]);
    expect(extractCompletionClaims(`message: 1a2b3c4d5e6f7a8b — pushed ${SHA}.`).map((c) => c.sha)).toEqual([SHA]);
  });

  it('a relayed "banked <sha>" (grounded msg citation, sha in the observed lane message) gets NO relay exemption and still faces origin', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const msgId = '1a2b3c4d5e6f7a8b';
    const laneMsg = JSON.stringify([{ id: msgId, text: `fully banked ${SHA}` }]);
    const out = await applyCompletionClaimGuard({
      finalText: `Lane relayed (msg ${msgId}): fully banked ${SHA}.`,
      parts: [call('get_chat_messages'), result('get_chat_messages', laneMsg)],
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('get_chat_messages')],
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_local']);
    expect(out.verdict.localOnlyShas).toEqual([SHA]);
    // Control: the SAME relay shape with a push verb keeps the pre-existing relay exemption + 2b skip.
    mockFetch.mockClear();
    const ctl = await applyCompletionClaimGuard({
      finalText: `Lane relayed (msg ${msgId}): pushed ${SHA}.`,
      parts: [call('get_chat_messages'), result('get_chat_messages', JSON.stringify([{ id: msgId, text: `pushed ${SHA}` }]))],
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('get_chat_messages')],
    });
    expect(ctl.verdict.unprovenKinds).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('git_commit receipt shas no longer enter the origin re-query as "harness receipt confirmed"; git_push shas still do', async () => {
    // The claims gate returns early on a claim-free final, so the receipt-
    // sourced re-query rides beside ONE claim line (a pushed sha).
    mockFetch.mockResolvedValue(ghResponse(200, {}));
    const out = await applyCompletionClaimGuard({
      finalText: `pushed ${SHA} to origin/main.`,
      parts: [call('git_commit'), call('git_push')], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('git_push', { branch: 'b', sha: SHA }), rc('git_commit', { sha: SHA2 })],
    });
    expect(mockFetch).toHaveBeenCalledTimes(1); // SHA (claim) only — the git_commit sha SHA2 never enters
    expect(String(mockFetch.mock.calls[0][0])).toContain(SHA);
    expect(out.finalText).not.toContain('harness receipt confirmed');
    mockFetch.mockClear();
    const withPush = await applyCompletionClaimGuard({
      finalText: `pushed ${SHA} to origin/main.`,
      parts: [call('git_push')], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('git_push', { branch: 'b', sha: SHA }), rc('git_push', { branch: 'b2', sha: SHA2 })],
    });
    expect(mockFetch).toHaveBeenCalledTimes(2); // SHA (claim) + SHA2 (git_push receipt)
    expect(withPush.finalText).toContain('harness receipt confirmed');
  });

  it('infra silence: origin unavailable (no token) → no localOnlyShas, only the guard-1 note', async () => {
    mockGetValidToken.mockResolvedValue(null);
    const out = await applyCompletionClaimGuard({
      finalText: `fully banked ${SHA}.`,
      parts: [call('git_commit')], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('git_commit', { sha: SHA })],
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_local']);
    expect(out.verdict.localOnlyShas).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('user-watched turns: GUARD 1 stays out (posture unchanged); the origin lane still renders the local-only caution', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: `fully banked ${SHA}.`,
      parts: [call('git_commit')], triggerKind: 'user', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('git_commit', { sha: SHA })],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.localOnlyShas).toEqual([SHA]);
  });

});

// ── Review fixes (2026-09-27, same branch) ──────────────────────────────────
//
//  F1  commit_local is ANNOTATE-ONLY under enforcement: enforceableVerdict()
//      strips the class for hardFindings / redactableOnly / the in-loop
//      reject-back; the full verdict still reaches telemetry + the journal.
//  F2  GUARD 1 no longer strikes a commit_local claim BEFORE GUARD 2b: the
//      conviction is deferred, a sha origin finds PRESENT is confirmed (no
//      "EXISTS on origin" + "treat as LOCAL ONLY" in one final), and the
//      doctrine's "cite a git_push receipt" is satisfiable CROSS-CHAT — an ok
//      git_push row read via get_run_receipts (the lane's receipt) proves the
//      sha and a uuid printed there is never a forged citation.
//  F3  (above) "saved" / "checkpointed" + artefact labels mine nothing.
//  F4  GUARD 2b verifies claim-sourced push shas FIRST — five "banked" shas
//      can no longer push a "pushed <sha>" past the MAX_VERIFY_SHAS cap.
describe('review fixes — F1 annotate-only under enforcement', () => {
  it('enforceableVerdict strips commit_local + localOnlyShas and nothing else; pure', () => {
    const v: GuardVerdict = {
      unprovenKinds: ['commit_local', 'probe'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [],
      unprovenClaims: [{ kind: 'commit_local', sha: SHA, text: `banked ${SHA}` }, { kind: 'probe', text: 'probe ok' }],
      localOnlyShas: [SHA],
    };
    const e = enforceableVerdict(v);
    expect(e.unprovenKinds).toEqual(['probe']);
    expect(e.unprovenClaims).toEqual([{ kind: 'probe', text: 'probe ok' }]);
    expect(e.localOnlyShas).toBeUndefined();
    expect(v.unprovenKinds).toEqual(['commit_local', 'probe']); // input untouched
    expect(v.localOnlyShas).toEqual([SHA]);
    // commit_local-only → no enforceable finding at all (object parity kept: no empty unprovenClaims).
    const only: GuardVerdict = { unprovenKinds: ['commit_local'], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], unprovenClaims: [{ kind: 'commit_local', sha: SHA, text: 'x' }], localOnlyShas: [SHA] };
    const eo = enforceableVerdict(only);
    expect(verdictHasFindings(eo)).toBe(false);
    expect(eo).not.toHaveProperty('unprovenClaims');
    // Other classes pass through untouched.
    const other: GuardVerdict = { unprovenKinds: ['pr_merged'], fabricatedPrs: [7], refutedMergePrs: [], futureDated: [], unprovenClaims: [{ kind: 'pr_merged', prNumber: 7, text: 'y' }] };
    expect(enforceableVerdict(other)).toEqual(other);
  });

  it('in-loop reject-back: THE SPARK CASE (banked, 404 on origin) never bounces a draft', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await evaluateFinalCandidateForRejectBack({
      finalText: `Spark B11: fully banked ${SHA} on lane/spark-b11.`,
      parts: [call('git_commit')], triggerKind: 'schedule', resumed: false, ...OPTS,
      receipts: [rc('git_commit', { sha: SHA })],
    });
    expect(out.rejected).toBe(false);
    // Control: a fabricated PUSH claim on the same shape still rejects.
    const ctl = await evaluateFinalCandidateForRejectBack({
      finalText: `pushed ${SHA} to origin/main.`,
      parts: [call('git_commit')], triggerKind: 'schedule', resumed: false, ...OPTS,
      receipts: [rc('git_commit', { sha: SHA })],
    });
    expect(ctl.rejected).toBe(true);
    expect(ctl.kinds).toContain('fabricated_sha');
  });
});

describe('review fixes — F2 origin reconcile + cross-chat git_push receipts', () => {
  const msgId = '1a2b3c4d5e6f7a8b';

  it('a relayed "banked <sha>" whose sha IS on origin is CONFIRMED — no unproven commit_local, no contradictory notes', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, { sha: SHA }));
    const laneMsg = JSON.stringify([{ id: msgId, text: `fully banked ${SHA}` }]);
    const out = await applyCompletionClaimGuard({
      finalText: `Lane relayed (msg ${msgId}): fully banked ${SHA}.`,
      parts: [call('get_chat_messages'), result('get_chat_messages', laneMsg)],
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('get_chat_messages')],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.unprovenClaims).toBeUndefined();
    expect(out.verdict.localOnlyShas).toBeUndefined();
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toContain('EXISTS on origin');
    expect(out.finalText).not.toContain('LOCAL ONLY');
    expect(out.finalText).not.toContain('[HARNESS EVIDENCE GUARD]');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a 404 still convicts — and the deferred guard-1 note renders AFTER the origin footer (never before it)', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: `Spark B11: fully banked ${SHA} on lane/spark-b11.`,
      parts: [call('git_commit')], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('git_commit', { sha: SHA })],
    });
    expect(out.verdict.unprovenKinds).toEqual(['commit_local']);
    expect(out.verdict.unprovenClaims?.map((c) => c.sha)).toEqual([SHA]);
    expect(out.verdict.localOnlyShas).toEqual([SHA]);
    const footerIdx = out.finalText.indexOf('Harness push-claim verification');
    const noteIdx = out.finalText.indexOf('[HARNESS EVIDENCE GUARD]');
    expect(footerIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeGreaterThan(footerIdx);
    expect(out.notes[out.notes.length - 1]).toContain('a local git_commit is not a push');
  });

  it('mixed kinds: the other kinds render at GUARD 1 as before; the commit_local survivor joins the verdict after 2b', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const out = await applyCompletionClaimGuard({
      finalText: `Box probe: healthy.\nfully banked ${SHA}.`,
      parts: [], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [],
    });
    expect(out.verdict.unprovenKinds).toEqual(['probe', 'commit_local']);
    expect(out.verdict.unprovenClaims?.map((c) => c.kind)).toEqual(['probe', 'commit_local']);
    const guardNotes = out.notes.filter((n) => n.startsWith('[HARNESS EVIDENCE GUARD]\n'));
    expect(guardNotes).toHaveLength(2);
    expect(guardNotes[0]).toContain('probe: 1');
    expect(guardNotes[0]).not.toContain('commit_local');
    expect(guardNotes[1]).toContain('commit_local: 1');
  });

  const receiptsPayload = (rows: any[]) => JSON.stringify({
    ok: true, tool: 'get_run_receipts', ids: { chatId: 'lane1' },
    runs: [{ id: 'r-lane', status: 'completed', receipts: rows, contextFill: [] }],
    chatTurns: [],
    note: 'ids envelopes are the durable evidence',
  }, null, 1);
  const LANE_RECEIPT_ID = '9c8b7a6d-1111-2222-3333-444455556666';

  it('observedRunReceiptEvidence reads git_push shas + receipt uuids from get_run_receipts output (JSON, and the truncated display slice); git_commit rows never count', () => {
    const payload = receiptsPayload([
      { id: LANE_RECEIPT_ID, tool: 'git_push', ok: true, ids: { branch: 'b', sha: SHA }, at: NOW },
      { id: 'aaaaaaaa-1111-2222-3333-444455556666', tool: 'git_commit', ok: true, ids: { sha: SHA2 }, at: NOW },
      { id: 'bbbbbbbb-1111-2222-3333-444455556666', tool: 'git_push', ok: false, ids: { sha: 'c0ffee1234567' }, at: NOW },
    ]);
    const full = observedRunReceiptEvidence([result('get_run_receipts', payload)]);
    expect(full.pushShas).toEqual([SHA]);
    expect(full.receiptIds).toEqual([LANE_RECEIPT_ID, 'aaaaaaaa-1111-2222-3333-444455556666', 'bbbbbbbb-1111-2222-3333-444455556666']);
    // Truncated (the 8000-char display slice cuts the JSON): the row walk still finds the ok git_push sha.
    const cut = observedRunReceiptEvidence([result('get_run_receipts', payload.slice(0, payload.length - 40))]);
    expect(cut.pushShas).toEqual([SHA]);
    expect(cut.receiptIds).toContain(LANE_RECEIPT_ID);
    // Other tools' outputs are never receipt evidence.
    expect(observedRunReceiptEvidence([result('get_chat_messages', payload)])).toEqual({ pushShas: [], receiptIds: [] });
  });

  it('THE DOCTRINE PATH: "Lane banked <sha> (receipt <uuid>: git_push ok)" with the lane\'s ok git_push row in get_run_receipts output → clean, no forged citation, no origin query', async () => {
    mockFetch.mockResolvedValue(ghResponse(404)); // would be a false "local only" if queried
    const payload = receiptsPayload([{ id: LANE_RECEIPT_ID, tool: 'git_push', ok: true, ids: { branch: 'lane/spark-b11', sha: SHA }, at: NOW }]);
    const out = await applyCompletionClaimGuard({
      finalText: `Lane banked ${SHA} (receipt ${LANE_RECEIPT_ID}: git_push ok).`,
      parts: [call('get_run_receipts'), result('get_run_receipts', payload)],
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [], // the supervisor's OWN run wrote no receipt for the lane's push
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.forgedFooter).toBeUndefined();
    expect(out.verdict.localOnlyShas).toBeUndefined();
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    // The same lane receipt proves a relayed PUSH line too (and keeps it off THIS repo's commits API).
    const pushed = await applyCompletionClaimGuard({
      finalText: `Lane pushed ${SHA} to origin.`,
      parts: [call('get_run_receipts'), result('get_run_receipts', payload)],
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS, receipts: [],
    });
    expect(pushed.verdict.unprovenKinds).toEqual([]);
    expect(pushed.verdict.fabricatedShas).toBeUndefined();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a lane git_commit row proves nothing cross-chat either; an observed uuid is not forged but exonerates nothing', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const payload = receiptsPayload([{ id: LANE_RECEIPT_ID, tool: 'git_commit', ok: true, ids: { sha: SHA }, at: NOW }]);
    const out = await applyCompletionClaimGuard({
      finalText: `Lane banked ${SHA} (receipt ${LANE_RECEIPT_ID}).`,
      parts: [call('get_run_receipts'), result('get_run_receipts', payload)],
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS, receipts: [],
    });
    expect(out.verdict.forgedFooter).toBeUndefined(); // observed, not invented
    expect(out.verdict.unprovenKinds).toEqual(['commit_local']); // …but a git_commit row is LOCAL
    expect(out.verdict.localOnlyShas).toEqual([SHA]);
    // An id NOT in any receipt output stays a forgery.
    const forged = await applyCompletionClaimGuard({
      finalText: `Lane banked ${SHA} (receipt aaaaaaaa-1111-2222-3333-444455556666).`,
      parts: [call('get_run_receipts'), result('get_run_receipts', payload)],
      triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS, receipts: [],
    });
    expect(forged.verdict.forgedFooter).toBe(true);
  });

});

describe('review fixes — F4 GUARD 2b verifies push claims before local shas', () => {
  it('a "pushed <sha>" AFTER ≥5 banked shas is still fetched and convicted; the cap drops a LOCAL sha instead', async () => {
    mockFetch.mockResolvedValue(ghResponse(404));
    const banked = ['1a1a1a1a1', '2b2b2b2b2', '3c3c3c3c3', '4d4d4d4d4', '5e5e5e5e5'];
    const out = await applyCompletionClaimGuard({
      finalText: `Commits banked: ${banked.join(', ')}. Pushed deadbeef77 to origin/main.`,
      parts: [call('git_commit')], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [],
    });
    expect(mockFetch).toHaveBeenCalledTimes(MAX_VERIFY_SHAS);
    const fetched = mockFetch.mock.calls.map((c) => String(c[0]).split('/commits/')[1]);
    expect(fetched[0]).toBe('deadbeef77'); // the claim-sourced push sha goes first
    expect(out.verdict.fabricatedShas).toEqual(['deadbeef77']);
    expect(out.verdict.localOnlyShas).toEqual(banked.slice(0, MAX_VERIFY_SHAS - 1)); // text order within the local rank
    expect(fetched).not.toContain(banked[banked.length - 1]); // the LAST banked sha is what the cap drops
  });

  it('receipt-sourced (git_push) shas rank between claims and locals', async () => {
    mockFetch.mockResolvedValue(ghResponse(200, {}));
    await applyCompletionClaimGuard({
      finalText: `banked ${SHA2}; pushed ${SHA}.`,
      parts: [call('git_push')], triggerKind: 'schedule', resumed: false, now: NOW, ...OPTS,
      receipts: [rc('git_push', { branch: 'b', sha: 'c0ffee1234567' })],
    });
    const fetched = mockFetch.mock.calls.map((c) => String(c[0]).split('/commits/')[1]);
    expect(fetched).toEqual([SHA, 'c0ffee1234567', SHA2]);
  });
});
