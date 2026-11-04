/**
 * Replay/regression tests for feedback ticket b646f6b8 (mishap, fleet-integrity,
 * 2026-09-08): "Evidence guard: machine run asserted unproven completions
 * (session b95e9df6)".
 *
 * THE MISHAP BEING REPLAYED: a 90-minute kernel-opt monitor session
 * (b95e9df6) fired a harness-continuation run at 03:14:04Z whose final answer
 * cited "11:54 PM EDT" as an observation clock — the session's OWN schedule
 * nextRunAt (2026-09-08T03:54:50Z = 11:54 PM EDT) conflated with "now",
 * +38m ahead of the run's wall clock (~03:16Z). The guard convicted
 * "future-dated observation claims: 11:54 PM EDT (+38m ahead)" and the final
 * was withheld pre-delivery (containedPreDelivery: true on the filing).
 *
 * The same string had appeared in the session's PRIOR delivered answer
 * ("armed for 11:54 PM EDT") WITHOUT conviction — that run's journal held a
 * list_schedules receipt carrying the same instant (nextRunAt
 * 2026-09-08T03:54:50.007Z), so the P9 provenance lane (ticket 9ed46ffe,
 * stampHasToolProvenance → haystackHasInstant) exonerated it as an honest
 * receipt citation in a different clock format. The convicted continuation
 * run had NO such receipt in its journal.
 *
 * These tests pin, against the REAL guard:
 *   1. the incident string — 12h clock, no seconds, named US zone — IS
 *      flagged at +38m (the parsing/conviction path regression-locked);
 *   2. the verdict rides the exact wording the ticket carries, and the claim
 *      objects reach verdict.futureDatedClaims (the executor's strip+mark
 *      containment contract, ticket 45edaf25);
 *   3. CONTROL (no guard overreach): the SAME stamp anchored by a same-run
 *      schedule receipt with the matching nextRunAt instant is CLEAN — the
 *      earlier delivered citation was legitimate, the unanchored one was not.
 *
 * The fix shipped with this ticket is BEHAVIORAL (a failure-mode-specific
 * clock rule steered into the session's stored prompt — "never
 * elapsed-additions or nextRunAt-conflation (b646f6b8)"); the guard itself
 * needed no change, and these tests keep it that way.
 *
 * Boundary-mocked like run-evidence-guard.680dd00a.test.ts: logger + the
 * GitHub token manager are stubs; the REAL guard module executes.
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
  applyCompletionClaimGuard, findFutureDatedClaims,
  summarizeGuardVerdict, verdictHasFindings,
} from './run-evidence-guard';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };

/** The withheld continuation run's wall clock (withheld 03:16:21Z; fired 03:14:04Z). */
const INCIDENT_NOW = new Date('2026-09-08T03:16:00.000Z');

/** The convicted line shape: a harness-clock-style observation citation. */
const INCIDENT_LINE = 'Self-audit complete (11:54 PM EDT): all criteria verified.';

describe('ticket b646f6b8 replay — nextRunAt-conflated observation clock (run 7cc18d66)', () => {
  it('REPLAY: "11:54 PM EDT" cited as now at 03:16Z flags +38m ahead', () => {
    const findings = findFutureDatedClaims(INCIDENT_LINE, INCIDENT_NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0].stamp).toBe('11:54 PM EDT');
    expect(findings[0].aheadMs).toBe(38 * 60 * 1000);
  });

  it('REPLAY at guard level: the verdict carries the ticket wording + the strip-lane claim objects', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_LINE,
      // The run DID call tools — but none printed the cited instant (bare
      // parts carry no receipt content, so the P9 lane cannot anchor).
      parts: [{ type: 'tool_call', name: 'list_schedules', args: {} }],
      triggerKind: 'schedule', resumed: false,
      now: INCIDENT_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual([]); // evidence present — clock claim, not an evidence gap
    expect(out.verdict.futureDated).toEqual(['11:54 PM EDT (+38m ahead)']);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(summarizeGuardVerdict(out.verdict)).toContain('future-dated observation claims: 11:54 PM EDT (+38m ahead)');
    // Containment contract (ticket 45edaf25): the claim objects ride the
    // verdict so the executor's strip+mark lane can elide the struck line —
    // this filing's containedPreDelivery: true shape.
    expect(out.verdict.futureDatedClaims).toHaveLength(1);
    expect(out.verdict.futureDatedClaims![0].stamp).toBe('11:54 PM EDT');
  });

  it('CONTROL (P9 provenance, ticket 9ed46ffe): the SAME stamp anchored by a same-run nextRunAt receipt is CLEAN', () => {
    // The prior DELIVERED answer's journal: list_schedules printed nextRunAt
    // 2026-09-08T03:54:50.007Z — the same minute-floored instant as
    // "11:54 PM EDT" (03:54Z), in a different clock format.
    const haystacks = [
      '- bde98003-a670-439d-8853-cf9b775968a1 [active] recurring every 90m · chat b95e9df6 · next 2026-09-08T03:54:50.007Z · runs 3/8 · last started',
    ];
    const findings = findFutureDatedClaims(INCIDENT_LINE, INCIDENT_NOW, { evidenceHaystacks: haystacks });

    expect(findings).toHaveLength(0);
  });

  it('CONTROL (honest forward citation): citing the nextRunAt AS a future event stays clean even without a receipt', () => {
    const findings = findFutureDatedClaims(
      'The wake loop bde98003 fires next at 11:54 PM EDT (03:54Z).',
      INCIDENT_NOW,
    );

    expect(findings).toHaveLength(0);
  });
});
