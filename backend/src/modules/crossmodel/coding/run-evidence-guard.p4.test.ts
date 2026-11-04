/**
 * P4 evidence-integrity remediation tests (ids → content):
 *   - v1#24 / spark B11 / CanLaw B5 — CONTENT-BOUND exoneration: a cited ok
 *     receipt id (or anchored relay msg id) on a line no longer clears an
 *     UNRELATED claim sharing that line; the claim's own key tokens must be
 *     provable by the cited receipt / present in observed tool output.
 *   - CanLaw L5 — renderLineLevelRemovedFinal: the REPLACE lane's line-level
 *     mode (convicted lines elided, receipted survivors delivered).
 *   - v1#23 — claims-block 'unverifiable' tier composition through
 *     applyClaimsBlockLane (an ok `ls` receipt no longer stamps a deploy
 *     entry VERIFIED).
 *
 * Boundary-mocked like run-evidence-guard.test.ts: token manager stubbed;
 * provider 'git' keeps every GitHub network lane silent so GUARD 1 semantics
 * are isolated.
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
  applyCompletionClaimGuard, applyClaimsBlockLane, claimsBlockLane,
  renderLineLevelRemovedFinal, REDACTED_FINDING_LINE,
  extractCompletionClaims, findFutureDatedClaims, citedReceiptProvesClaim,
} from './run-evidence-guard';
import type { GuardVerdict } from './run-evidence-guard';
import type { ToolReceipt } from './run-receipts';

const NOW = new Date('2026-09-09T12:00:00.000Z');
const RID = 'aaaabbbb-cccc-4ddd-8eee-ffff00001111';

const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = RID): ToolReceipt => ({
  id, chatId: 'c1', runId: 'run1', tool, ok, ids,
  inputHash: null, outputHash: null, createdAt: NOW,
});

/** provider 'git' → every GitHub lane silently 'unavailable'. */
const OPTS = { userId: 'u1', repoUrl: null, provider: 'git', triggerKind: 'schedule' as const, now: NOW };

afterEach(() => {
  delete process.env.QUOTE_GUARD_ENFORCE; // gate flip 2026-09-11 opt-in — never leaks across cases
});

describe('v1#24 — content-bound receipt-citation exoneration', () => {
  const LINE = `Sent the fleet digest (receipt ${RID}) and merged PR #999.`;

  it('a cited ok receipt UNRELATED to the claim no longer clears it (the laundering hole)', async () => {
    const out = await applyCompletionClaimGuard({
      ...OPTS,
      finalText: LINE,
      parts: [],
      receipts: [receipt('send_chat_message', true, { chatId: 'c9' })],
    });
    expect(out.verdict.unprovenKinds).toContain('pr_merged');
  });

  it('a cited ok receipt whose ids PROVE the claim still exonerates (id-narrow binding)', async () => {
    const out = await applyCompletionClaimGuard({
      ...OPTS,
      finalText: LINE,
      parts: [],
      receipts: [receipt('open_pull_request', true, { prNumber: 999 })],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
  });

  it('citedReceiptProvesClaim: token-less kinds bind to the receipt TOOL CLASS', () => {
    const probe = extractCompletionClaims('Box probe healthy, md5 verified.')[0];
    expect(probe?.kind).toBe('probe');
    expect(citedReceiptProvesClaim(probe, [receipt('run_command', true)], [])).toBe(true);
    expect(citedReceiptProvesClaim(probe, [receipt('send_chat_message', true)], [])).toBe(false);
  });

  it('citedReceiptProvesClaim: an id-bearing claim citing a CLASS receipt binds through the tool OUTPUT (the honest gh-CLI shape)', () => {
    const created = extractCompletionClaims('Opened PR #300 with the fix.')[0];
    expect(created?.kind).toBe('pr_created');
    // The run_command receipt's ids are empty — but the CLI output printed #300.
    expect(citedReceiptProvesClaim(created, [receipt('run_command', true)], ['https://github.com/o/r/pull/300'])).toBe(true);
    // Nothing anywhere printed 300 → no exoneration.
    expect(citedReceiptProvesClaim(created, [receipt('run_command', true)], ['unrelated output'])).toBe(false);
  });
});

describe('v1#24 — content-bound relay exoneration', () => {
  const MSG_ID = '16ad4828deadbeef';
  const SHA = '1a2b3c4d5e6f7788';
  const LINE = `Path C reports commit ${SHA} pushed to origin/main (msg ${MSG_ID}).`;
  const relayParts = (extra = ''): any[] => [
    { type: 'tool_result', name: 'get_chat_messages', result: `[{"id":"${MSG_ID}","content":"lane update ${extra}"}]` },
  ];

  it('an anchored msg citation no longer exonerates a sha ABSENT from observed output', async () => {
    const out = await applyCompletionClaimGuard({
      ...OPTS,
      finalText: LINE,
      parts: relayParts(),
      receipts: [],
    });
    expect(out.verdict.unprovenKinds).toContain('commit_pushed');
  });

  it('the same relay exonerates when the sha IS in the observed output (grounded relay)', async () => {
    const out = await applyCompletionClaimGuard({
      ...OPTS,
      finalText: LINE,
      parts: relayParts(`commit ${SHA} pushed`),
      receipts: [],
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
  });
});

describe('CanLaw L5 — renderLineLevelRemovedFinal', () => {
  const verdictWith = (over: Partial<GuardVerdict>): GuardVerdict => ({
    unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [], ...over,
  });

  const ORIGINAL = [
    `Opened PR #300 (receipt ${RID}) with the fix — verified green.`,
    'Also merged PR #999 and flipped prod.',
    'Next: watch the canary.',
  ].join('\n');
  const RECEIPTS = [receipt('open_pull_request', true, { prNumber: 300 })];

  it('elides only the convicted line and keeps the receipted survivor (fabricated PR)', () => {
    const out = renderLineLevelRemovedFinal({
      originalText: ORIGINAL,
      verdict: verdictWith({ fabricatedPrs: [999] }),
      receipts: RECEIPTS,
      triggerKind: 'schedule',
    });
    expect(out).not.toBeNull();
    expect(out!.finalText).toContain('LINE(S) REMOVED');
    expect(out!.finalText).toContain(`Opened PR #300 (receipt ${RID})`);
    expect(out!.finalText).not.toContain('merged PR #999');
    expect(out!.finalText).toContain(REDACTED_FINDING_LINE);
    expect(out!.removedLines).toEqual(['Also merged PR #999 and flipped prod.']);
  });

  it('returns null on forged chrome (whole REPLACE stays)', () => {
    expect(renderLineLevelRemovedFinal({
      originalText: ORIGINAL,
      verdict: verdictWith({ fabricatedPrs: [999], forgedFooter: true }),
      receipts: RECEIPTS,
      triggerKind: 'schedule',
    })).toBeNull();
  });

  it('gate flip 2026-09-11: a fabricated_quote note no longer forces the whole-final REPLACE — the lane elides the other class and the notice still names the quote', () => {
    // Was: null on fabricatedQuotes (fail-closed whole REPLACE). 26/28 quote
    // exhibits were the run's own harness-mandated ```claims fence.
    const out = renderLineLevelRemovedFinal({
      originalText: ORIGINAL,
      verdict: verdictWith({ fabricatedPrs: [999], fabricatedQuotes: ['[34/55] gpqa-100 r0 TRUNC'] }),
      receipts: RECEIPTS,
      triggerKind: 'schedule',
    });
    expect(out).not.toBeNull();
    expect(out!.removedLines).toEqual(['Also merged PR #999 and flipped prod.']);
    expect(out!.finalText).toContain(`Opened PR #300 (receipt ${RID})`);
    expect(out!.notice).toContain('gpqa-100'); // named as unverified, not removed
  });

  it('QUOTE_GUARD_ENFORCE=1 restores the fail-closed null on fabricated quotes', () => {
    process.env.QUOTE_GUARD_ENFORCE = '1';
    expect(renderLineLevelRemovedFinal({
      originalText: ORIGINAL,
      verdict: verdictWith({ fabricatedPrs: [999], fabricatedQuotes: ['[34/55] gpqa-100 r0 TRUNC'] }),
      receipts: RECEIPTS,
      triggerKind: 'schedule',
    })).toBeNull();
  });

  it('returns null when NO receipted line survives', () => {
    const out = renderLineLevelRemovedFinal({
      originalText: 'Merged PR #999.\nSome prose with no receipts.',
      verdict: verdictWith({ fabricatedPrs: [999] }),
      receipts: [],
      triggerKind: 'schedule',
    });
    expect(out).toBeNull();
  });

  it('returns null when a populated class locates NO line (fail-closed)', () => {
    const out = renderLineLevelRemovedFinal({
      originalText: ORIGINAL,
      verdict: verdictWith({ fabricatedShas: ['deadbeef99'] }), // sha appears nowhere
      receipts: RECEIPTS,
      triggerKind: 'schedule',
    });
    expect(out).toBeNull();
  });

  it('elides the whole ```claims fence for unverifiedBlockClaims', () => {
    const text = [
      `Pushed the branch (receipt ${RID}).`,
      '```claims',
      '[{"type":"push","ref":"deadbeef11"}]',
      '```',
    ].join('\n');
    const out = renderLineLevelRemovedFinal({
      originalText: text,
      verdict: verdictWith({ unverifiedBlockClaims: ['push deadbeef11'] }),
      receipts: [receipt('git_push', true, { branch: 'b', sha: '1234abcd99' })],
      triggerKind: 'schedule',
    });
    expect(out).not.toBeNull();
    // The fence body (all 3 fence lines) is elided from the DELIVERED body —
    // the notice may still NAME the convicted entry (it is labeled unverified).
    const body = out!.finalText.slice(out!.notice.length);
    expect(body).not.toContain('deadbeef11');
    expect(out!.removedLines).toContain('[{"type":"push","ref":"deadbeef11"}]');
    expect(out!.finalText).toContain(`Pushed the branch (receipt ${RID}).`);
  });

  it('REDACTED_FINDING_LINE extracts zero claims and zero clocks (no re-conviction)', () => {
    expect(extractCompletionClaims(REDACTED_FINDING_LINE)).toEqual([]);
    expect(findFutureDatedClaims(REDACTED_FINDING_LINE, NOW)).toEqual([]);
  });
});

describe('v1#23 — claims-block unverifiable tier (an ok `ls` receipt must not stamp VERIFIED)', () => {
  const TEXT = 'Deploy flipped.\n```claims\n[{"type":"deploy","ref":"prod blue-green flip"}]\n```';

  it('a descriptive deploy ref with only a generic ok run_command receipt is UNVERIFIABLE (not verified, not convicted)', () => {
    const lane = claimsBlockLane(TEXT, [receipt('run_command', true)]);
    expect(lane.verified).toEqual([]);
    expect(lane.unverified).toEqual([]);
    expect(lane.unverifiable.map((e) => e.ref)).toEqual(['prod blue-green flip']);
  });

  it('applyClaimsBlockLane: unverifiable → advisory note, NO positive verdict, NO conviction', async () => {
    const guarded = { finalText: TEXT, notes: [] as string[], verdict: { unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] } as GuardVerdict };
    const out = await applyClaimsBlockLane({
      originalText: TEXT, guarded, receipts: [receipt('run_command', true)],
      triggerKind: 'schedule',
    });
    expect(out.verdict.claimsBlockVerified).toBeUndefined();
    expect(out.verdict.unverifiedBlockClaims).toBeUndefined();
    expect(out.finalText).not.toContain('CLAIMS BLOCK UNVERIFIABLE'); // gate flip 2026-09-11: guard_miss metric, no note on the final
  });

  it('a deploy ref naming the receipted push sha still VERIFIES', () => {
    const lane = claimsBlockLane(
      'Deployed.\n```claims\n[{"type":"deploy","ref":"1234abcd99"}]\n```',
      [receipt('git_push', true, { branch: 'main', sha: '1234abcd99' })],
    );
    expect(lane.verified).toHaveLength(1);
    expect(lane.unverifiable).toEqual([]);
  });

  it('a forged full-uuid deploy ref stays a CONVICTION (anti-forgery unchanged)', () => {
    const lane = claimsBlockLane(
      'Deployed.\n```claims\n[{"type":"deploy","ref":"99998888-7777-4666-8555-444433332222"}]\n```',
      [receipt('run_command', true)],
    );
    expect(lane.unverified).toHaveLength(1);
    expect(lane.unverifiable).toEqual([]);
  });

  it('kill-switch restores the strict tier', () => {
    const lane = claimsBlockLane(TEXT, [receipt('run_command', true)]);
    expect(lane.verified).toHaveLength(0);
    expect(lane.unverifiable).toHaveLength(1);
  });
});
