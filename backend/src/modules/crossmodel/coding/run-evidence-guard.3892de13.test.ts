/**
 * Replay/regression tests for feedback ticket 3892de13 (mishap, fleet-integrity,
 * filed 2026-08-23T12:07:28Z): "Evidence guard: machine run asserted unproven
 * completions (session cec340f2)".
 *
 * THE MISHAP BEING REPLAYED: a 30-min-scheduled CanLaw monitor lane
 * (session cec340f2-f605-4370-b87a-d85b59cb243f, run
 * 53cba52e-9c0a-4a66-8021-250eda179a78) delivered a final whose observation
 * lines cited clocks AHEAD of the run's wall clock (~12:07Z):
 *   - "12:17Z" (+10m ahead)
 *   - "12:20Z" (+13m ahead)
 *   - "12:55Z" (+48m ahead)
 * composed clocks instead of this-run tool prints — the exact failure mode the
 * guard's future-dated layer exists to convict (a completed observation cannot
 * be dated in the future).
 *
 * ADJUDICATION (closure-manifest entry, 2026-08-23 wave): CONTAINED guard
 * signal — the guard caught + neutralized the confabulated final; the
 * root-cause fix (honest-partial FINAL TURN notice) shipped in PR #325. The
 * steering the ticket prescribed landed afterwards and was re-verified FRESH
 * by the 2026-09-14 dispatch lane (schedule_get, this run): the session's
 * active 60-min monitor schedule 39346220 (prompt sha256 a469fb9284d6…)
 * carries the EVIDENCE DISCIPLINE block explicitly headed "fleet-mandated
 * ticket 3892de13" — rule 2 = "Timestamps only from tool-printed clocks …
 * NEVER clock arithmetic" (the targeted future-dated rule, not the generic
 * no-op re-steer), rule 6 = the FINAL_CLOCK gate — and the short-lived
 * REPLICA-3 schedule 10b3c2cd (sha256 e39af63e9101…) carries the condensed
 * form ("FINAL_CLOCK date -u last; every claim cites a this-run tool
 * receipt").
 *
 * These tests pin, against the REAL guard:
 *   1. the three sighting clocks ARE flagged with the exact ahead-minutes the
 *      ticket records (a regression that stops catching them fails CI);
 *   2. the verdict renders the ticket's EXACT wording
 *      ("future-dated observation claims: 12:17Z (+10m ahead); …");
 *   3. same-shape lines with honest clocks (≤ the run wall clock) stay CLEAN —
 *      the sightings were genuine future-dated claims, not guard overreach;
 *   4. intent-cued forward times ("next firing at …") and receipt-sourced
 *      stamps (verbatim in a this-run tool result) stay unflagged.
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

/** The run's wall clock at flag time (ticket filed 2026-08-23T12:07:28Z). */
const RUN_NOW = new Date('2026-08-23T12:07:00.000Z');

/**
 * The sighting shape (run 53cba52e): monitor-lane observation lines, each
 * carrying a composed clock ahead of 12:07Z. Same grammatical shape the
 * 680dd00a replay proves convicts ("<subject> — probe clock <stamp>, <state>").
 */
const SIGHTING_LINES = [
  'w3 aqua healthy — probe clock 12:17Z, watcher alive',
  'S3 baseline probe 12:20Z — 63/169/477 objects exact',
  'staging sweep 12:55Z — 84× OK lines logged',
].join('\n');

describe('ticket 3892de13 replay — future-dated observation sightings (run 53cba52e)', () => {
  it('REPLAY: the three sighting clocks flag with the ticket\'s exact ahead-minutes (+10m/+13m/+48m)', () => {
    const findings = findFutureDatedClaims(SIGHTING_LINES, RUN_NOW);

    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.stamp)).toEqual(['12:17Z', '12:20Z', '12:55Z']);
    expect(findings.map((f) => f.aheadMs)).toEqual([10 * 60_000, 13 * 60_000, 48 * 60_000]);
  });

  it('GUARD LEVEL: the sighting final is convicted and the verdict renders the ticket\'s exact wording', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: SIGHTING_LINES,
      // Evidence-bearing tool call present: the ticket records ONLY the
      // future-dated kind (no zero-evidence kinds), so the replay keeps
      // unprovenKinds empty and isolates the clock conviction.
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'schedule', resumed: false,
      now: RUN_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(out.verdict.futureDated).toEqual([
      '12:17Z (+10m ahead)', '12:20Z (+13m ahead)', '12:55Z (+48m ahead)',
    ]);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    // The exact wording the integrity ticket carries.
    expect(summarizeGuardVerdict(out.verdict)).toBe(
      'future-dated observation claims: 12:17Z (+10m ahead); 12:20Z (+13m ahead); 12:55Z (+48m ahead)',
    );
    // Containment: the guard neutralized the confabulated final (honest
    // notice on top; the lines carrying the phantom clocks did not ship
    // as-is). This is the "guard caught it" property the closure cites.
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD');
    expect(out.finalText).not.toBe(SIGHTING_LINES);
  });

  it('CONTROL (no guard overreach): the SAME lines with honest clocks (≤ the run wall clock) are CLEAN', async () => {
    const honest = [
      'w3 aqua healthy — probe clock 11:57Z, watcher alive',
      'S3 baseline probe 12:02Z — 63/169/477 objects exact',
      'staging sweep 12:05Z — 84× OK lines logged',
    ].join('\n');
    const out = await applyCompletionClaimGuard({
      finalText: honest,
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'schedule', resumed: false,
      now: RUN_NOW, ...OPTS,
    });

    expect(out.verdict).toEqual({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] });
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toBe(honest); // untouched — no guard note
  });

  it('CONTROL: an intent-cued forward clock ("next firing at 12:47Z") stays unflagged', () => {
    const findings = findFutureDatedClaims('Next firing at 12:47Z — holding until then.', RUN_NOW);
    expect(findings).toEqual([]);
  });

  it('CONTROL: a receipt-sourced stamp (verbatim in a this-run tool result) stays unflagged', () => {
    const findings = findFutureDatedClaims(
      'w3 aqua healthy — probe clock 12:17Z, watcher alive',
      RUN_NOW,
      { evidenceHaystacks: ['SSM invocation output … status logged 12:17Z …'] },
    );
    expect(findings).toEqual([]);
  });
});
