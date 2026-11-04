/**
 * Replay/adjudication test — F32 shortfall (2026-10-22, R&D stream-1 cycle):
 * "deploy-observation claims are only provable by action tools" — the
 * evidence-guard deploy tier vs the deploy doctrine's own mandated reads.
 *
 * THE SHORTFALL (found by the verifier-strike surface probe, explorer
 * bg1-378g; verified first-hand on origin/main 6f1da1ee):
 *   - DEPLOY_ALT_RE (run-evidence-guard.ts) extracts a `deploy` claim from
 *     pure OBSERVATION lines — "health check 200", "prod green",
 *     "digby.example.com healthy" — lines that assert NOTHING about the run having
 *     performed a deploy.
 *   - Every deploy evidence tier bound ONLY to the external-action class:
 *     claimHasEvidence's parts tier, citedToolEvidencesKind's citation tier,
 *     and receiptMatchesClaim's receipts lane — while the guard's own
 *     machine-run doctrine mandates verifying deploy health with
 *     get_fleet_telemetry (platform-tools.ts:6559: "Wait for the deploy wave
 *     to go green and the boxes to report the new main head (get_fleet_telemetry
 *     view deploy)") and the chat lane ALREADY grounds "on main head" by a
 *     get_fleet_telemetry deploy-view read (action-verifier.ts
 *     PRODUCTION-STATE lane, 2026-09-27). GUARD 5 Lane A holds the same
 *     doctrine for run ids: a deploy-run id this run OBSERVED "was OBSERVED".
 *   - So an honest lane that ran the mandated read and wrote the observation
 *     sentence was struck zero-evidence — and the reject-back notice named
 *     the evidence class ONLY for probe/benchmark, giving the lane no
 *     actionable escape (the exact repeat-strike trap 212b3aa0 fixed for
 *     probes).
 *
 * THE FIX pinned here (both directions, every widened site):
 *   - evidence-tools.ts: DEPLOY_HEALTH_SURFACE_RE / DEPLOY_ACTION_VERB_RE /
 *     isDeployObservationClaimText / DEPLOY_HEALTH_OBSERVATION_TOOLS
 *     (get_fleet_telemetry + scrape_as_markdown/scrape_batch/browser_task)
 *     and the EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED kill switch.
 *   - claimHasEvidence + citedToolEvidencesKind + the receipts-lane parts
 *     fallback + receiptMatchesClaim: the OBSERVATION shape (health surface
 *     + OK signal, NO deploy verb) is additionally evidenced by the
 *     deploy-health observation tools. A deploy-verb line stays
 *     action-only FOREVER — it asserts the run PERFORMED the deploy.
 *   - renderGuardRejectBackNotice names the deploy evidence class.
 *   - EXTERNAL_ACTION_TOOL_RE twins (guard + run-receipts) both carry
 *     merge_pull_request and can never drift again.
 *
 * Boundary-mocked exactly like run-evidence-guard.212b3aa0.test.ts.
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
  applyCompletionClaimGuard,
  claimHasEvidence,
  extractCompletionClaims,
  renderGuardRejectBackNotice,
  citedReceiptProvesClaim,
} from './run-evidence-guard';
import type { GuardVerdict } from './run-evidence-guard';
import { receiptMatchesClaim } from './run-receipts';
import type { ToolReceipt } from './run-receipts';
import {
  DEPLOY_HEALTH_OBSERVATION_TOOLS,
  DEPLOY_HEALTH_SURFACE_RE,
  DEPLOY_ACTION_VERB_RE,
  DEPLOY_OBSERVATION_TIER_DISABLED_ENV,
  isDeployObservationClaimText,
} from './evidence-tools';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' } as const;
const receipt = (tool: string, ok: boolean, ids: Record<string, unknown> = {}, id = 'aaaaaaaa-0000-4000-8000-000000000001'): ToolReceipt => ({
  id, chatId: 'chat-1', runId: 'run-1', tool, ok, ids, inputHash: null, outputHash: null,
  createdAt: new Date('2026-10-22T16:00:00.000Z'),
});
const part = (name: string): any => ({ type: 'tool_call', name, args: {} });

// ── the boundary predicate (single shared home) ─────────────────────────────

describe('F32 deploy-observation boundary predicate (evidence-tools.ts)', () => {
  it('the OBSERVATION shape: health surface + OK signal, no deploy verb', () => {
    expect(isDeployObservationClaimText('health check 200, digby.example.com healthy')).toBe(true);
    expect(isDeployObservationClaimText('prod green')).toBe(true);
    expect(isDeployObservationClaimText('Deploy verified: health check 200')).toBe(false);
    expect(isDeployObservationClaimText('the deploy flipped green')).toBe(false);
    expect(isDeployObservationClaimText('deployed to prod, boxes healthy')).toBe(false);
    expect(isDeployObservationClaimText(undefined)).toBe(false);
    expect(isDeployObservationClaimText('')).toBe(false);
  });

  it('the shared regexes mirror the guard\'s extraction vocabulary', () => {
    // DEPLOY_ALT_RE's exact surface, verbatim.
    expect(DEPLOY_HEALTH_SURFACE_RE.test('health check 200')).toBe(true);
    expect(DEPLOY_HEALTH_SURFACE_RE.test('digby.example.com healthy')).toBe(true);
    expect(DEPLOY_HEALTH_SURFACE_RE.test('prod green')).toBe(true);
    expect(DEPLOY_HEALTH_SURFACE_RE.test('boxes report the new main head')).toBe(false);
    // The verb guard: extraction fires on DEPLOY_ALT even when a verb is
    // present ("Deploy verified: health check 200" IS a deploy claim), so the
    // OBSERVATION shape demands the verb be absent.
    expect(DEPLOY_ACTION_VERB_RE.test('Deploy verified: health check 200')).toBe(true);
    expect(DEPLOY_ACTION_VERB_RE.test('health check 200')).toBe(false);
  });
});

// ── the parts tier (claimHasEvidence) ───────────────────────────────────────

describe('F32 parts tier: deploy observation vs deploy verb (claimHasEvidence)', () => {
  const obsClaim = (text: string) => {
    const claims = extractCompletionClaims(text);
    expect(claims.some((c) => c.kind === 'deploy')).toBe(true);
    return claims.find((c) => c.kind === 'deploy')!;
  };

  it('CLEAN (the fix): "health check 200, digby.example.com healthy" evidenced by a this-run get_fleet_telemetry read', () => {
    expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [part('get_fleet_telemetry')])).toBe(true);
  });

  it('CLEAN (the fix): the same observation evidenced by a web health read (scrape_as_markdown)', () => {
    expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [part('scrape_as_markdown')])).toBe(true);
    expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [part('browser_task')])).toBe(true);
  });

  it('STILL CONVICTS: the same observation line with a ZERO journal (honest lane must have run the read)', () => {
    expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [])).toBe(false);
  });

  it('STILL CONVICTS (anti-laundering): a GENERIC fleet read (get_chat_status) never vouches a deploy observation', () => {
    expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [part('get_chat_status')])).toBe(false);
    expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [part('todo_get')])).toBe(false);
  });

  it('STILL CONVICTS (the verb boundary): a deploy-verb line is action-only even with the observation tools in the journal', () => {
    expect(claimHasEvidence(obsClaim('Deployed: the deploy flipped green, health check 200'), [part('get_fleet_telemetry')])).toBe(false);
    expect(claimHasEvidence(obsClaim('Deployed: the deploy flipped green, health check 200'), [part('scrape_as_markdown'), part('get_chat_status')])).toBe(false);
    // …and the action class still evidences it.
    expect(claimHasEvidence(obsClaim('Deployed: the deploy flipped green, health check 200'), [part('run_command')])).toBe(true);
  });

  it('KILL SWITCH: EVIDENCE_GUARD_DEPLOY_OBSERVATION_DISABLED=1 restores the action-only tier', () => {
    process.env[DEPLOY_OBSERVATION_TIER_DISABLED_ENV] = '1';
    try {
      expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [part('get_fleet_telemetry')])).toBe(false);
      expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [part('scrape_as_markdown')])).toBe(false);
      // The action class is untouched.
      expect(claimHasEvidence(obsClaim('Verified: health check 200, digby.example.com healthy'), [part('run_command')])).toBe(true);
    } finally {
      delete process.env[DEPLOY_OBSERVATION_TIER_DISABLED_ENV];
    }
  });
});

// ── the receipts lane (receiptMatchesClaim) ─────────────────────────────────

describe('F32 receipts lane: deploy observation vs deploy verb (receiptMatchesClaim)', () => {
  it('CLEAN (the fix): the observation claim is proven by a web health-read receipt', () => {
    const claims = extractCompletionClaims('Verified: health check 200, digby.example.com healthy');
    const c = claims.find((x) => x.kind === 'deploy')!;
    expect(receiptMatchesClaim(c, [receipt('scrape_as_markdown', true)])).toBe(true);
    expect(receiptMatchesClaim(c, [receipt('browser_task', true)])).toBe(true);
  });

  it('STILL CONVICTS: the observation claim against receipts that prove nothing (a generic platform read)', () => {
    const claims = extractCompletionClaims('Verified: health check 200, digby.example.com healthy');
    const c = claims.find((x) => x.kind === 'deploy')!;
    expect(receiptMatchesClaim(c, [receipt('get_chat_status', true)])).toBe(false);
    expect(receiptMatchesClaim(c, [receipt('todo_get', true)])).toBe(false);
    expect(receiptMatchesClaim(c, [])).toBe(false);
  });

  it('CLEAN: a get_fleet_telemetry receipt proves the observation claim (deploy-health observation class)', () => {
    const claims = extractCompletionClaims('Verified: health check 200, digby.example.com healthy');
    const c = claims.find((x) => x.kind === 'deploy')!;
    expect(receiptMatchesClaim(c, [receipt('get_fleet_telemetry', true)])).toBe(true);
  });

  it('STILL CONVICTS (the verb boundary): a deploy-verb claim needs the action class even with web reads in the journal', () => {
    const claims = extractCompletionClaims('Deployed: the deploy flipped green, health check 200');
    const c = claims.find((x) => x.kind === 'deploy')!;
    expect(receiptMatchesClaim(c, [receipt('scrape_as_markdown', true), receipt('get_fleet_telemetry', true)])).toBe(false);
    expect(receiptMatchesClaim(c, [receipt('run_command', true)])).toBe(true);
  });

  it('KILL SWITCH: =1 restores the action-only receipts lane for the observation shape', () => {
    process.env[DEPLOY_OBSERVATION_TIER_DISABLED_ENV] = '1';
    try {
      const claims = extractCompletionClaims('Verified: health check 200, digby.example.com healthy');
      const c = claims.find((x) => x.kind === 'deploy')!;
      expect(receiptMatchesClaim(c, [receipt('scrape_as_markdown', true)])).toBe(false);
      expect(receiptMatchesClaim(c, [receipt('run_command', true)])).toBe(true);
    } finally {
      delete process.env[DEPLOY_OBSERVATION_TIER_DISABLED_ENV];
    }
  });
});

// ── the live guard composition (receipts-first, parts fallback) ─────────────

describe('F32 live path: applyCompletionClaimGuard with a get_fleet_telemetry-only journal', () => {
  const OBS_FINAL = [
    'Verified this cycle:',
    'health check 200, digby.example.com healthy',
  ].join('\n');

  it('CLEAN (the fix): the honest telemetry-verified health line passes with zero deploy findings', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: OBS_FINAL,
      parts: [part('get_fleet_telemetry'), part('git_log')],
      receipts: [receipt('git_log', true), receipt('get_fleet_telemetry', true)],
      triggerKind: 'schedule', resumed: false,
      now: new Date('2026-10-22T16:00:00.000Z'), ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
  });

  it('STILL CONVICTS (the zero-tool incident class): the same line with NO tools flags deploy unproven', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: OBS_FINAL,
      parts: [],
      triggerKind: 'schedule', resumed: false,
      now: new Date('2026-10-22T16:00:00.000Z'), ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toContain('deploy');
  });

  it('STILL CONVICTS (anti-laundering): the same line against a generic platform-reads-only journal', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: OBS_FINAL,
      parts: [part('get_chat_status'), part('todo_get'), part('list_schedules')],
      receipts: [receipt('get_chat_status', true), receipt('todo_get', true)],
      triggerKind: 'schedule', resumed: false,
      now: new Date('2026-10-22T16:00:00.000Z'), ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toContain('deploy');
  });

  it('STILL CONVICTS (680dd00a replay, verb shape): a deploy-verb status line against a platform-reads-only journal stays unproven', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'deployed and green in prod, health check 200',
      parts: [part('get_fleet_telemetry'), part('get_chat_status')],
      receipts: [receipt('get_fleet_telemetry', true)],
      triggerKind: 'schedule', resumed: false,
      now: new Date('2026-10-22T16:00:00.000Z'), ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toContain('deploy');
  });
});

// ── the reject-back notice (the actionable-escape fix) ──────────────────────

describe('F32 reject-back notice: the deploy evidence class is named', () => {
  const v = (unprovenKinds: string[]): GuardVerdict => ({
    unprovenKinds,
    unprovenClaims: [],
    fabricatedPrs: [],
    refutedMergePrs: [],
    futureDated: [],
    forgedFooter: false,
    fabricatedShas: [],
    fabricatedQuotes: [],
    fabricatedDeployRuns: [],
    refutedDeployRuns: [],
    fabricatedTicketIds: [],
    fabricatedTodoIds: [],
    fabricatedOwnerQuestionIds: [],
    fabricatedScheduleIds: [],
    unverifiedBlockClaims: [],
  }) as unknown as GuardVerdict;

  it('a deploy-struck lane is told WHICH tool class satisfies the claim', () => {
    const notice = renderGuardRejectBackNotice(v(['deploy']));
    expect(notice).toContain('deploy evidence =');
    expect(notice).toContain('get_fleet_telemetry');
    expect(notice).toContain('deploy verb');
  });

  it('no deploy kind → no deploy line (probe line unchanged)', () => {
    const notice = renderGuardRejectBackNotice(v(['probe']));
    expect(notice).not.toContain('deploy evidence =');
    expect(notice).toContain('probe/benchmark evidence =');
  });
});

// ── the twin regex sync (finding B of the surface probe) ────────────────────

// ── the citation tier (citedReceiptProvesClaim — the live F1 surface) ───────

describe('F32 citation tier: pr_* NEVER rides the deploy-observation tier (review F1)', () => {
  // citedReceiptProvesClaim(claim, citedOkReceipts, haystacksLower) — the
  // LIVE lane for "Merged PR #1866 (52dc7c8dc); prod green" house style: the
  // pr number appears in tool output, a cited scrape receipt sits on the line.
  const probe = (text: string, receipts: ToolReceipt[], haystack: string[] = []) => {
    const claims = extractCompletionClaims(text);
    const out: Record<string, boolean> = {};
    for (const c of claims) out[`${c.kind}`] = citedReceiptProvesClaim(c, receipts, haystack.map((h) => h.toLowerCase()));
    return out;
  };

  it('STILL CONVICTS (F1 pin): a pr_merged claim with a health clause NEVER rides a web health read', () => {
    // The reviewer's executed scenario, verbatim shape: house-style merge line
    // + a cited ok scrape receipt + the PR number in the run's tool output.
    const out = probe(
      'Merged PR #1900 (deadbeef) — prod green, health check 200',
      [receipt('scrape_as_markdown', true, { })],
      ['PR #1900 deadbeef merged'],
    );
    expect(out.pr_merged).toBe(false);
    // The deploy claim on the same line (observation shape) DOES ride it —
    // deploy-only by kind is the F1 contract.
    expect(out.deploy).toBe(true);
  });

  it('STILL CONVICTS (F1 pin): pr_created with a health clause never rides the observation tools', () => {
    const out = probe(
      'Opened PR #1901 — prod green, health check 200',
      [receipt('get_fleet_telemetry', true, { })],
      ['PR #1901 opened'],
    );
    expect(out.pr_created).toBe(false);
  });

  it('the action class still proves pr_merged (no regression from the F1 guard)', () => {
    const out = probe(
      'Merged PR #1900 (deadbeef)',
      [receipt('merge_pull_request', true, { prNumber: 1900 })],
      [],
    );
    expect(out.pr_merged).toBe(true);
  });
});

// ── the parts tier F1/F2 pins ───────────────────────────────────────────────

describe('F32 review fixes: verb vocabulary (F2) and pr_* isolation (F1) at the parts tier', () => {
  const deployClaim = (text: string) => extractCompletionClaims(text).find((c) => c.kind === 'deploy')!;

  it('F2: the full deploy word-family and paraphrases stay action-only', () => {
    for (const line of [
      'Redeployed prod — health check 200',
      'Deploying now; prod green',
      'deployments healthy, prod green',
      'Shipped to prod; health check 200',
      'Rolled out to prod — digby.example.com healthy',
      'pushed to prod, health check 200',
    ]) {
      const c = deployClaim(line);
      expect([line, claimHasEvidence(c, [part('get_fleet_telemetry')])]).toEqual([line, false]);
      expect([line, claimHasEvidence(c, [part('scrape_as_markdown')])]).toEqual([line, false]);
      // …and the action class still evidences each.
      expect([line, claimHasEvidence(c, [part('run_command')])]).toEqual([line, true]);
    }
  });

  it('F1 pin: a pr_merged parts claim never rides the observation tools', () => {
    const claims = extractCompletionClaims('Merged PR #1900 — prod green, health check 200');
    const pr = claims.find((c) => c.kind === 'pr_merged')!;
    expect(claimHasEvidence(pr, [part('get_fleet_telemetry'), part('scrape_as_markdown')])).toBe(false);
    expect(claimHasEvidence(pr, [part('run_command')])).toBe(true);
  });
});

// ── the parts fallback positive pin (review finding: the live CLEAN test passed via receiptMatchesClaim) ──

describe('F32 parts fallback positive: the deploy observation survives a receipts-lane miss (review pin)', () => {
  it('CLEAN via the FALLBACK (not the receipts lane): an observation claim whose journal holds only parts (no receipts passed)', async () => {
    // No `receipts` argument: the seam that passes parts-only. The deploy
    // claim must resolve CLEAN through claimHasEvidence's widened tier —
    // delete the parts fallback and the receipts-lane branch, and this still
    // passes ONLY through claimHasEvidence (findUnprovenClaims path).
    const out = await applyCompletionClaimGuard({
      finalText: 'Verified: health check 200, digby.example.com healthy',
      parts: [part('get_fleet_telemetry')],
      triggerKind: 'schedule', resumed: false,
      now: new Date('2026-10-22T16:00:00.000Z'), ...OPTS,
    });
    expect(out.verdict.unprovenKinds).toEqual([]);
  });

  it('CONVICTS via the same parts-only seam when the switch is off (the fallback is the only path that can save it)', async () => {
    process.env[DEPLOY_OBSERVATION_TIER_DISABLED_ENV] = '1';
    try {
      const out = await applyCompletionClaimGuard({
        finalText: 'Verified: health check 200, digby.example.com healthy',
        parts: [part('get_fleet_telemetry')],
        triggerKind: 'schedule', resumed: false,
        now: new Date('2026-10-22T16:00:00.000Z'), ...OPTS,
      });
      expect(out.verdict.unprovenKinds).toContain('deploy');
    } finally {
      delete process.env[DEPLOY_OBSERVATION_TIER_DISABLED_ENV];
    }
  });
});

describe('F32 twin-regex sync: merge_pull_request is an external-action tool on BOTH paths', () => {
  it('the parts tier accepts a merge_pull_request tool call for a deploy claim', () => {
    const claims = extractCompletionClaims('the deploy landed green');
    const c = claims.find((x) => x.kind === 'deploy')!;
    expect(claimHasEvidence(c, [part('merge_pull_request')])).toBe(true);
  });

  it('the receipts lane accepts a merge_pull_request receipt for a deploy claim', () => {
    const claims = extractCompletionClaims('the deploy landed green');
    const c = claims.find((x) => x.kind === 'deploy')!;
    expect(receiptMatchesClaim(c, [receipt('merge_pull_request', true, { prNumber: 1891 })])).toBe(true);
  });
});
