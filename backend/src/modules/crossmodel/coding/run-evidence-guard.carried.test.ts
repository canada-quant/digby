/**
 * CARRIED-EVIDENCE tier (tt-rd audit 2026-09-27, finding self-audit-churn-4).
 *
 * THE GAP: the evidence guard resolved a machine run's claims only against
 * receipts of THIS run (run-executor getRunReceipts(claimed.id)); a lane that
 * restated a previously-verified artifact without re-probing was struck
 * UNVERIFIED (observe-only, but the strike shaped behaviour — lanes re-probed
 * every closed artifact each firing: ddd26be0 61 final_verdict + 58
 * numeric_provenance strikes / 14 d, journals stamping "SA2-MAIN-TIP" probe
 * lines every firing).
 *
 * THE FIX: applyCompletionClaimGuard takes `carriedReceipts` (earlier runs of
 * the same chat, ≤ 7 d). A claim naming a STABLE artifact (PR number / pushed
 * sha), NOT phrased as fresh, that an ok carried receipt id-matches renders
 * '[CARRIED from run <id8> <ts>]' and leaves unprovenKinds. Fresh-phrased
 * claims and observation kinds still need a fresh receipt. (RSW-1 cl30,
 * 2026-11-02: the release switch expired 2026-11-12 and was deleted.)
 *
 * Boundary-mocked like run-evidence-guard.test.ts: logger + token manager are
 * stubs (no token → the GitHub lanes stay 'unavailable'); the REAL guard runs.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../github/token-manager', () => ({
  __esModule: true,
  getValidToken: jest.fn(async () => null),
}));

import { applyCompletionClaimGuard, carriedReceiptFor, claimNamesStableArtifact, FRESH_CLAIM_CUE_RE, renderCarriedEvidenceNote, extractCompletionClaims } from './run-evidence-guard';
import type { ToolReceipt } from './run-receipts';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' as const };
const AT = new Date('2026-09-21T10:00:00.000Z');
const carriedMerge: ToolReceipt = { id: 'rc-merge-0001', chatId: 'c1', runId: 'run-earlier-9f2a', tool: 'github_merge_pull_request', ok: true, ids: { prNumber: 706 }, inputHash: null, outputHash: null, createdAt: AT };
const carriedPush: ToolReceipt = { id: 'rc-push-0002', chatId: 'c1', runId: 'run-earlier-9f2a', tool: 'git_push', ok: true, ids: { sha: '84fe3ae0c0ffee1234' }, inputHash: null, outputHash: null, createdAt: AT };



describe('carried tier — pure helpers', () => {
  it('FRESH_CLAIM_CUE_RE: this run / just now / fresh / re-probed / a clock stamp read as fresh; a plain restatement does not', () => {
    for (const s of ['PR #706 merged this run', 'just now merged', 'fresh probe confirms', 'Re-probed the tip', 'merged at 12:05:13Z', 'merged 2026-09-21T10:00 per the log']) expect(FRESH_CLAIM_CUE_RE.test(s)).toBe(true);
    for (const s of ['PR #706 (merged 09-21) is the adopted lever', 'the branch was pushed as 84fe3ae0c0ffee1234']) expect(FRESH_CLAIM_CUE_RE.test(s)).toBe(false);
  });

  it('only PR-number / pushed-sha claims name a stable artifact; probe / benchmark / deploy never carry', () => {
    const claims = extractCompletionClaims('Merged PR #706 (squash). Box probe healthy. Deployed to prod.');
    const merge = claims.find((c) => c.kind === 'pr_merged')!;
    expect(claimNamesStableArtifact(merge)).toBe(true);
    for (const c of claims.filter((c) => c.kind !== 'pr_merged')) expect(claimNamesStableArtifact(c)).toBe(false);
  });

  it('carriedReceiptFor: id-matched ok receipt → the receipt; ok:false, a different PR, or a fresh-phrased line → null', () => {
    const [merge] = extractCompletionClaims('Merged PR #706 (squash).');
    expect(carriedReceiptFor(merge, [carriedMerge])).toBe(carriedMerge);
    expect(carriedReceiptFor(merge, [{ ...carriedMerge, ok: false }])).toBeNull();
    expect(carriedReceiptFor(merge, [{ ...carriedMerge, ids: { prNumber: 707 } }])).toBeNull();
    const [fresh] = extractCompletionClaims('Re-verified this run: merged PR #706 (squash).');
    expect(carriedReceiptFor(fresh, [carriedMerge])).toBeNull();
  });

  it('renderCarriedEvidenceNote names the earlier run (8-char prefix) + time per claim, bounded to 8 lines', () => {
    const note = renderCarriedEvidenceNote([{ kind: 'pr_merged', text: 'Merged PR #706 (squash).', runId: 'run-earlier-9f2a', at: AT.toISOString() }]);
    expect(note.startsWith('[HARNESS EVIDENCE GUARD — CARRIED EVIDENCE]')).toBe(true);
    expect(note).toContain('[CARRIED from run run-earl 2026-09-21T10:00:00.000Z] pr_merged: Merged PR #706 (squash).');
    expect(note).toContain('A claim phrased as observed THIS run still needs a fresh receipt.');
  });
});

describe('carried tier — applyCompletionClaimGuard (machine run, this-run receipts empty)', () => {
  it('REPLAY: a plain restatement of an earlier-run merge + push is CARRIED — not UNVERIFIED, no unprovenKinds, no NO FRESH EVIDENCE note', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'Status: PR #706 (merged) remains the adopted lever; the branch was pushed as 84fe3ae0c0ffee1234. No new experiment this tick.',
      parts: [], triggerKind: 'schedule', receipts: [], carriedReceipts: [carriedMerge, carriedPush], ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.carriedClaims?.map((c) => c.kind).sort()).toEqual(['commit_pushed', 'pr_merged']);
    expect(out.verdict.carriedClaims?.every((c) => c.runId === 'run-earlier-9f2a' && c.at === AT.toISOString())).toBe(true);
    expect(out.finalText).toContain('[CARRIED from run run-earl 2026-09-21T10:00:00.000Z]');
    expect(out.finalText).not.toContain('NO FRESH EVIDENCE this turn');
  });

  it('a claim phrased as FRESH ("re-verified this run") with no fresh receipt is still UNVERIFIED even though a carried receipt matches its PR', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'Re-verified this run: merged PR #706 (squash).',
      parts: [], triggerKind: 'schedule', receipts: [], carriedReceipts: [carriedMerge], ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual(['pr_merged']);
    expect(out.verdict.carriedClaims).toBeUndefined();
    expect(out.finalText).toContain('NO FRESH EVIDENCE this turn');
  });

  it('a DIFFERENT PR than the carried receipts evidence, and an observation kind, stay UNVERIFIED; a THIS-run receipt still wins first', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'Merged PR #999 (squash). Box probe healthy.',
      parts: [], triggerKind: 'schedule', receipts: [], carriedReceipts: [carriedMerge], ...OPTS,
    });
    expect(out.verdict.unprovenKinds.sort()).toEqual(['pr_merged', 'probe']);
    expect(out.verdict.carriedClaims).toBeUndefined();
    const thisRun: ToolReceipt = { ...carriedMerge, id: 'rt-this-0003', runId: 'run-this', ids: { prNumber: 999 } };
    const out2 = await applyCompletionClaimGuard({
      finalText: 'Merged PR #999 (squash).',
      parts: [], triggerKind: 'schedule', receipts: [thisRun], carriedReceipts: [carriedMerge], ...OPTS,
    });
    expect(out2.verdict.unprovenKinds).toEqual([]);
    expect(out2.verdict.carriedClaims).toBeUndefined(); // proven fresh — nothing to carry
  });

  it('an absent / empty carried pool cannot carry anything; user turns never enter GUARD 1', async () => {
    const none = await applyCompletionClaimGuard({ finalText: 'Merged PR #706 (squash).', parts: [], triggerKind: 'schedule', receipts: [], carriedReceipts: [], ...OPTS });
    expect(none.verdict.unprovenKinds).toEqual(['pr_merged']);
    const user = await applyCompletionClaimGuard({ finalText: 'Merged PR #706 (squash).', parts: [], triggerKind: 'user', receipts: [], carriedReceipts: [carriedMerge], ...OPTS });
    expect(user.verdict.unprovenKinds).toEqual([]);
    expect(user.verdict.carriedClaims).toBeUndefined();
  });

  // ── fb64368a REVIEW ROUND 1 (finding 1 / MINOR 7) — the REAL guard's prose
  // citation lane (GUARD 0b) is carried-aware. These cases pin the fix at the
  // guard itself, not through the executor's mock: pre-fix, a zero-receipt
  // run citing a REAL carried id in prose set forgedFooter=true (the
  // carried-blind knownIds), which the zero-receipt gate counted as a
  // conviction — a full REPLACE of an honest relay.
  it('REVIEW R1 — a PROSE citation of a REAL carried-pool receipt id is NOT a forged citation: forgedFooter stays unset, no FORGED RECEIPT CITATION note (the guard unions carried into knownIds)', async () => {
    const CITED = '7f5781a5-aaaa-bbbb-cccc-ddddeeeeffff';
    const carriedUuid: ToolReceipt = { id: CITED, chatId: 'c1', runId: 'run-earlier-9f2a', tool: 'send_chat_message', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: AT };
    const out = await applyCompletionClaimGuard({
      finalText: `Acked to FS earlier this cycle — receipt ${CITED} (per the prior firing's record). No new work this tick.`,
      parts: [], triggerKind: 'schedule', receipts: [], carriedReceipts: [carriedUuid], ...OPTS,
    });
    expect(out.verdict.forgedFooter).toBeUndefined();
    expect(out.verdict.forgedCitationIds).toBeUndefined();
    expect(out.finalText).not.toContain('FORGED RECEIPT CITATION');
    // A carried id exonerates the CITATION only — it evidences nothing else:
    // no claims were made here, so unprovenKinds stays empty either way.
    expect(out.verdict.unprovenKinds).toEqual([]);
  });

  it('REVIEW R1 — an invented uuid cited in prose with an EMPTY (confirmed) pool still convicts: forgedFooter + forgedCitationIds carry the id', async () => {
    const CITED = '7f5781a5-aaaa-bbbb-cccc-ddddeeeeffff';
    const out = await applyCompletionClaimGuard({
      finalText: `Acked to FS earlier this cycle — receipt ${CITED} (per the prior firing's record). No new work this tick.`,
      parts: [], triggerKind: 'schedule', receipts: [], carriedReceipts: [], ...OPTS,
    });
    expect(out.verdict.forgedFooter).toBe(true);
    expect(out.verdict.forgedCitationIds).toEqual([CITED]);
    expect(out.finalText).toContain('FORGED RECEIPT CITATION');
  });

  it('REVIEW R1 — a prose citation of a receipt id from THIS run (own set) was never a forgery and still is not (regression pin); an ok:false known id is KNOWN, not forged — it just evidences nothing', async () => {
    const CITED = '7f5781a5-aaaa-bbbb-cccc-ddddeeeeffff';
    const thisRun: ToolReceipt = { id: CITED, chatId: 'c1', runId: 'run-this', tool: 'run_command', ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: AT };
    const ok = await applyCompletionClaimGuard({
      finalText: `Probed this run — receipt ${CITED}.`,
      parts: [], triggerKind: 'schedule', receipts: [thisRun], carriedReceipts: [], ...OPTS,
    });
    expect(ok.verdict.forgedFooter).toBeUndefined();
    const failed = await applyCompletionClaimGuard({
      finalText: `Probed this run — receipt ${CITED}.`,
      parts: [], triggerKind: 'schedule', receipts: [{ ...thisRun, ok: false }], carriedReceipts: [], ...OPTS,
    });
    expect(failed.verdict.forgedFooter).toBeUndefined();
  });
});
