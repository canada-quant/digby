/**
 * Replay/regression tests for feedback tickets 2ab33824 (mishap, fleet-integrity,
 * 2026-09-10, source agent): "Evidence guard: machine run asserted unproven
 * completions (session 8e2617ca)" — and 581449b0 (mishap, agent-harness, same
 * run): "3× tool-failure streak: final_answer on 'Open Feedback Tickets
 * Burn-Down' — framework or model?".
 *
 * THE MISHAP BEING REPLAYED: chat 8e2617ca-93f7-4b3e-9764-85df25cdaf07 ran the
 * cbaf3e08 full-prefix E2E Mac-typing probe loop (recurring schedule b0bdccf5,
 * 90m × 6). Firing 3/6 at 20:35:18Z (run 099f7d41-5afa-4105-b46d-f68f4850c508)
 * executed ONLY its step-1 computer_task lock check — the Mac answered
 * "Login/lock screen", the locked-branch halt engaged (no SSH, no type probe,
 * no xxd) — then the run wrote a final carrying TWO probe-kind claim lines.
 * The guard convicted "zero-evidence completion claims: probe" and withheld
 * the final pre-delivery (containedPreDelivery: true, filed
 * 2026-09-10T20:38:58.406Z); the final_answer retry loop then tripped the 3×
 * breaker (ticket 581449b0, failure text "guard findings: unproven_completion").
 *
 * ROOT-CAUSE SPLIT (581449b0's "framework or model?" verdict — BOTH halves):
 *   - MODEL variance: the prompt's locked branch already mandated "post 'Mac
 *     locked, probe deferred' and end the run" — firing 2/6 wrote exactly that
 *     claim-free deferral and was DELIVERED (transcript 20dae2bd, finalized
 *     19:08:59Z). Firing 3/6 wrote a fuller report whose probe lines claimed
 *     outcomes no journal entry evidenced. The steering fix is BEHAVIORAL: the
 *     schedule prompt now carries a DEFERRAL RULE (a no-probe firing answers
 *     ONLY the claim-free one-liner; never restate prompt-carried status or
 *     probe-outcome words as this-run observations).
 *   - FRAMEWORK gap (fixed in the guard, pinned here): the run's ONLY
 *     observation call — computer_task — satisfied NO evidence tier, while its
 *     sibling browser_task sat in WEB_READ_TOOLS. Any computer_task-ONLY probe
 *     run (the probe schedule's own documented fallback — "if the key file is
 *     missing, use computer_task-only verification") was therefore
 *     structurally unreportable: every honest probe result convicted
 *     zero-evidence no matter what the run actually saw. COMPUTER_USE_TOOLS
 *     now joins the probe/benchmark tier in claimHasEvidence AND in
 *     citedToolEvidencesKind (the content-bound exoneration lane).
 *
 * The withheld claim LINES are unreconstructable (struck drafts are not
 * delivered), so this replay pins the CONVICTED SHAPE the filing names: probe
 * subjects (box|probe) + observed-evidence nouns (healthy|active|lines) on
 * TWO lines, against a journal with zero probe-tier entries.
 *
 * Boundary-mocked like run-evidence-guard.4df4bb41.test.ts: logger + the
 * GitHub token manager are stubs, global.fetch is a mock; the REAL guard
 * module executes.
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
  applyCompletionClaimGuard, claimHasEvidence, citedReceiptProvesClaim,
  findUnprovenClaims, summarizeGuardVerdict, verdictHasFindings,
} from './run-evidence-guard';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };

/** The flagged run's withholding instant (fired 20:35:18Z; filed 20:38:58.406Z). */
const INCIDENT_NOW = new Date('2026-09-10T20:38:58.000Z');

const realFetch = global.fetch;
const mockFetch: jest.Mock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue('tok');
  mockFetch.mockReset();
  global.fetch = mockFetch as any;
});

afterEach(() => {
  global.fetch = realFetch;
});

/**
 * The convicted shape (run 099f7d41): a deferral report that still asserted
 * probe outcomes. "box probe" + "healthy"/"active" and "probe" + "lines" are
 * the probe pair (PROBE_RE × PROBE_EVIDENCE_RE) on TWO lines — the filing's
 * "2 CLAIM LINE(S) REMOVED". The text deliberately carries no PR number, no
 * bare-sha + push verb, no deploy verb / health-check / prod / digby.example.com, and
 * no ticket-id token, so the replay convicts probe ONLY — exactly the
 * filing's "zero-evidence completion claims: probe".
 */
const INCIDENT_FINAL = [
  'Probe lane status confirmed this firing: box probe healthy, mac agent active.',
  'The full-prefix probe delivered 38 clean lines and the v5 typing path remains verified.',
].join('\n');

/**
 * The flagged run's journal shape: the step-1 computer_task lock check was its
 * ONLY observation call (update_plan bookkeeping evidences nothing).
 */
const LOCK_CHECK_PARTS: any[] = [
  { type: 'tool_call', name: 'update_plan', args: {} },
  { type: 'tool_call', name: 'computer_task', args: {} },
];

/** A journal with zero observation calls at all. */
const PLAN_ONLY_PARTS: any[] = [{ type: 'tool_call', name: 'update_plan', args: {} }];

const PROBE_CLAIM = { kind: 'probe' as const, text: INCIDENT_FINAL.split('\n')[0] };
const BENCH_CLAIM = { kind: 'benchmark' as const, text: 'GPQA tallies: 363 PASS' };

const makeReceipt = (tool: string): any => ({
  id: 'r1', chatId: 'c1', runId: 'run1', tool, ok: true,
  ids: {}, inputHash: null, outputHash: null, createdAt: INCIDENT_NOW,
});

describe('ticket 2ab33824/581449b0 replay — zero-evidence probe claims on a computer_task-only deferral (session 8e2617ca, run 099f7d41)', () => {
  it("REPLAY: probe claims with zero observation tools in the journal convict probe, with the ticket's exact verdict wording — through the executor's receipts:[] seam (review B1)", async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL, parts: PLAN_ONLY_PARTS,
      triggerKind: 'schedule', resumed: false,
      // The executor ALWAYS passes a receipts array (run-executor.ts) — empty
      // here because the run's only tools (update_plan + computer_task) leave
      // NO receipts. This receipts-lane shape is the production seam the
      // parts-path fix alone never reached.
      receipts: [],
      now: INCIDENT_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual(['probe']);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD');
    // …and the verdict renders the exact wording the ticket carries.
    expect(summarizeGuardVerdict(out.verdict)).toBe('zero-evidence completion claims: probe');
    // The probe lane re-queries NOTHING (no sha/PR to look up) — the
    // conviction is journal-backed alone, exactly as the filing states.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('REPLAY detail: two probe claims extract from the incident text (the "2 CLAIM LINE(S) REMOVED" shape)', () => {
    const unproven = findUnprovenClaims(INCIDENT_FINAL, PLAN_ONLY_PARTS);

    expect(unproven).toHaveLength(2);
    expect(unproven.map((c) => c.kind)).toEqual(['probe', 'probe']);
  });

  it('FIX: computer_task now evidences probe AND benchmark claims (sibling parity with browser_task)', () => {
    // Pre-fix BOTH were false: computer_task matched no tier, so the flagged
    // run's only observation could not exonerate even an honest probe report
    // (and the schedule's documented computer_task-only fallback could never
    // report at all). Post-fix the lock-check journal evidences both kinds.
    expect(claimHasEvidence(PROBE_CLAIM, LOCK_CHECK_PARTS)).toBe(true);
    expect(claimHasEvidence(BENCH_CLAIM, LOCK_CHECK_PARTS)).toBe(true);
  });

  it("FIX at guard level: the SAME final backed by the computer_task lock-check journal is no longer convicted — through the executor's receipts:[] seam (review B1)", async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL, parts: LOCK_CHECK_PARTS,
      triggerKind: 'schedule', resumed: false,
      // Same production seam as the replay: with no receipt matching the
      // observation claims, GUARD 1 falls back to the parts tier for
      // probe/benchmark — and computer_task now evidences them.
      receipts: [],
      now: INCIDENT_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).not.toContain('HARNESS EVIDENCE GUARD');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('FIX in the content-bound lane: a cited ok computer_task receipt proves a (token-less) probe claim', () => {
    // Pins tier-vocabulary PARITY between the receipts-lane citation path and
    // claimHasEvidence (production-reachable for computer_task the day it
    // leaves receipts — review B1 follow-up).
    expect(citedReceiptProvesClaim(PROBE_CLAIM, [makeReceipt('computer_task')], [])).toBe(true);
    // …while a cited receipt outside the probe evidence class still proves nothing.
    expect(citedReceiptProvesClaim(PROBE_CLAIM, [makeReceipt('update_feedback')], [])).toBe(false);
  });

  it('CONTROL (the steered deferral shape): the mandated claim-free one-liner passes untouched even with zero observation tools — receipts:[] seam', async () => {
    const oneLiner = 'Mac locked, probe deferred';

    const out = await applyCompletionClaimGuard({
      finalText: oneLiner, parts: LOCK_CHECK_PARTS,
      triggerKind: 'schedule', resumed: false,
      receipts: [],
      now: INCIDENT_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toBe(oneLiner); // untouched — no guard note
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('ANTI-HOLE: the observation fallback never leaks into consequential kinds — a bare "deploy green" claim still convicts at the receipts:[] seam', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'The deploy is green and healthy.',
      parts: LOCK_CHECK_PARTS,
      triggerKind: 'schedule', resumed: false,
      receipts: [],
      now: INCIDENT_NOW, ...OPTS,
    });

    // deploy keeps receipts-only semantics (no run-id → no GitHub re-query):
    // a computer_task observation must NOT launder it.
    expect(out.verdict.unprovenKinds).toEqual(['deploy']);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
