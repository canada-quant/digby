/**
 * PINS — claims-block ORIGIN-VOUCH leg (Framework Operator firing 4, 2026-09-22).
 *
 * THE INCIDENT: the Framework Operator lane's 14:19Z firing-3 final carried a
 * typed claims block — push b2fe7900 / file_change b2fe7900 / file_change
 * b4b667f9 — for publishes made through RAW SHELL (`git push origin HEAD:main`,
 * the charter's own step-3 path). run_command receipts carry no sha, so the
 * typed lane struck all three as receiptless while every sha was real on
 * origin: the deterministic channel punished exactly the lane that followed
 * the typed contract. Prose GUARD 2b had the GitHub re-query exoneration all
 * along — the typed lane was strictly harsher than prose for the same work.
 *
 * THE FIX: applyClaimsBlockLane takes an injected originCheck (verifyPushClaims
 * at both coding seams — executor finalize + in-loop reject-back). An
 * unreceipted HEX-sha push/file_change entry whose commit the re-query confirms
 * PRESENT on origin verifies via 'origin'; a 404 STAYS a conviction (the sha
 * does not exist); 'unavailable' lands unverifiable (advisory, never a strike
 * — GUARD 2b's silence discipline). No originCheck injected ⇒ byte-for-byte
 * pre-fix behavior.
 *
 * Boundary-mocked exactly like run-evidence-guard.claims.test.ts: the token
 * manager is a stub and global.fetch is stubbed per case; the REAL guard +
 * claims-block modules execute.
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

import { applyClaimsBlockLane } from './run-evidence-guard';
import type { GuardVerdict } from './run-evidence-guard';
import type { ToolReceipt } from './run-receipts';

const fence = (body: string) => '```claims\n' + body + '\n```';
const REAL_SHA = 'b2fe7900c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6'; // 40 hex — a real sha shape
const OTHER_SHA = 'b4b667f96c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f'; // 40 hex — a real sha shape

const mkGuarded = (): { finalText: string; notes: string[]; verdict: GuardVerdict } => ({
  finalText: 'Did the work.',
  notes: [],
  verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] },
});

/** The INCIDENT shape: push + its file_change, same commit, no receipts (raw-shell publish). */
const INCIDENT_BLOCK = fence(
  `[{"type":"push","ref":"${REAL_SHA}","note":"main"},{"type":"file_change","ref":"${REAL_SHA}"},{"type":"file_change","ref":"${OTHER_SHA}"}]`,
);

const originCheck = async (shas: Array<{ sha: string; source: 'claim' | 'receipt' }>) =>
  shas.map(({ sha }) => ({ sha, state: 'present' as const, source: 'claim' as const }));

const originCheck404 = async (shas: Array<{ sha: string; source: 'claim' | 'receipt' }>) =>
  shas.map(({ sha }) => ({ sha, state: 'missing' as const, source: 'claim' as const, reason: 'GitHub 404' }));

const originCheckDown = async (shas: Array<{ sha: string; source: 'claim' | 'receipt' }>) =>
  shas.map(({ sha }) => ({ sha, state: 'unavailable' as const, source: 'claim' as const, reason: 'GitHub HTTP 500' }));

const receipts = (tool: string): ToolReceipt[] => [
  { id: 'r1-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', chatId: 'c1', runId: null, tool, ok: true, ids: {}, inputHash: null, outputHash: null, createdAt: new Date() },
];

describe('claims-block origin-vouch leg (FO firing 4 — raw-shell publish exoneration)', () => {

  it('INCIDENT PIN: unreceipted hex push/file_change entries whose shas are PRESENT on origin verify via origin — no conviction', async () => {
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${INCIDENT_BLOCK}`, guarded: mkGuarded(),
      receipts: receipts('run_command'), triggerKind: 'schedule',
      originCheck,
    });
    expect(out.lane.unverified).toEqual([]);
    expect(out.lane.verified).toHaveLength(3);
    expect(out.lane.verified.every((v) => v.via === 'origin')).toBe(true);
    expect(out.verdict.unverifiedBlockClaims).toBeUndefined(); // no conviction — the finding never fires
    expect(out.verdict.claimsBlockVerified).toBe(true);
  });

  it('a 404 STAYS a conviction — an invented sha never launders through origin', async () => {
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${INCIDENT_BLOCK}`, guarded: mkGuarded(),
      receipts: receipts('run_command'), triggerKind: 'schedule',
      originCheck: originCheck404,
    });
    expect(out.lane.unverified).toHaveLength(3);
    expect(out.lane.verified).toEqual([]);
    expect(out.verdict.unverifiedBlockClaims).toHaveLength(3);
    expect(out.verdict.claimsBlockVerified).toBeUndefined();
  });

  it('API unavailable → unverifiable (advisory), NEVER a strike, and blocks the positive verdict', async () => {
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${INCIDENT_BLOCK}`, guarded: mkGuarded(),
      receipts: receipts('run_command'), triggerKind: 'schedule',
      originCheck: originCheckDown,
    });
    expect(out.lane.unverified).toEqual([]);
    expect(out.lane.unverifiable).toHaveLength(3);
    expect(out.verdict.unverifiedBlockClaims).toBeUndefined(); // advisory, not a finding
    expect(out.verdict.claimsBlockVerified).toBeUndefined(); // unverifiable blocks the positive verdict
  });

  it('NO originCheck injected → receipt-only behavior, byte-for-byte pre-fix (the strike stands)', async () => {
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${INCIDENT_BLOCK}`, guarded: mkGuarded(),
      receipts: receipts('run_command'), triggerKind: 'schedule',
    });
    expect(out.lane.unverified).toHaveLength(3); // the 14:19Z incident behavior
    expect(out.verdict.unverifiedBlockClaims).toHaveLength(3);
  });

  it('non-hex refs (branch names, paths) never reach the origin leg — the commits API answers shas only', async () => {
    const seen: string[] = [];
    const text = fence('[{"type":"push","ref":"digby/session-x"},{"type":"file_change","ref":"src/a.ts"}]');
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${text}`, guarded: mkGuarded(),
      receipts: receipts('run_command'), triggerKind: 'schedule',
      originCheck: async (shas) => { seen.push(...shas.map((s) => s.sha)); return []; },
    });
    expect(seen).toEqual([]); // nothing re-queried — non-hex refs stay receipt-lane-only
    expect(out.lane.unverified).toHaveLength(2);
  });

  it('receipt-verified entries never re-query origin (the receipt channel stays primary)', async () => {
    const seen: string[] = [];
    const text = fence(`[{"type":"push","ref":"${REAL_SHA}"}]`);
    const gitPushReceipt: ToolReceipt = {
      id: 'rp-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', chatId: 'c1', runId: null,
      tool: 'git_push', ok: true, ids: { branch: 'main', sha: REAL_SHA },
      inputHash: null, outputHash: null, createdAt: new Date(),
    };
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${text}`, guarded: mkGuarded(),
      receipts: [gitPushReceipt], triggerKind: 'schedule',
      originCheck: async (shas) => { seen.push(...shas.map((s) => s.sha)); return []; },
    });
    expect(seen).toEqual([]); // verified by receipt — no API call
    expect(out.lane.verified).toHaveLength(1);
    expect(out.lane.verified[0].via).toBeUndefined(); // receipt-vouched, not origin-vouched
  });

  it('duplicate shas across entries dedupe into ONE commits-API lookup (push + its file_change)', async () => {
    const seen: string[] = [];
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${INCIDENT_BLOCK}`, guarded: mkGuarded(),
      receipts: receipts('run_command'), triggerKind: 'schedule',
      originCheck: async (shas) => {
        seen.push(...shas.map((s) => s.sha));
        return shas.map(({ sha }) => ({ sha, state: 'present' as const, source: 'claim' as const }));
      },
    });
    expect(seen.sort()).toEqual([OTHER_SHA, REAL_SHA].sort()); // 3 entries → 2 lookups
    expect(out.lane.verified).toHaveLength(3);
  });

  it('a throwing originCheck never breaks the lane — the receipt-only verdict stands', async () => {
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${INCIDENT_BLOCK}`, guarded: mkGuarded(),
      receipts: receipts('run_command'), triggerKind: 'schedule',
      originCheck: async () => { throw new Error('boom'); },
    });
    expect(out.lane.unverified).toHaveLength(3);
    expect(out.verdict.unverifiedBlockClaims).toHaveLength(3);
  });

  it('origin vouches earn prose-downgrade coverage exactly like receipt matches', async () => {
    const guarded = mkGuarded();
    guarded.verdict.unprovenKinds = ['commit_pushed'];
    guarded.verdict.unprovenClaims = [{ kind: 'commit_pushed', sha: REAL_SHA.slice(0, 8), text: `pushed ${REAL_SHA.slice(0, 8)}` }];
    const out = await applyClaimsBlockLane({
      originalText: `Shipped.\n\n${fence(`[{"type":"push","ref":"${REAL_SHA}"}]`)}`, guarded,
      receipts: receipts('run_command'), triggerKind: 'schedule',
      originCheck,
    });
    expect(out.verdict.unprovenKinds).toEqual([]); // the prose push claim was downgraded by the origin-vouched entry
    expect(out.lane.coveredKinds).toContain('commit_pushed');
    expect(verdictless(out)).toBe(true); // helper kept for the kill-switch pin below
  });
});

/** verdictHasFindings-free local check: an unverifiedBlockClaims finding exists. */
function verdictless(out: { verdict: GuardVerdict }): boolean {
  return (out.verdict.unverifiedBlockClaims?.length ?? 0) === 0;
}
