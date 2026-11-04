/**
 * Replay/regression tests for feedback ticket 680dd00a (mishap, fleet-integrity,
 * 4 occurrences / 3 reopens): "Evidence guard: machine run asserted unproven
 * completions (session c9ccf88a)".
 *
 * THE MISHAP BEING REPLAYED: an hourly-scheduled hardware-benchmark monitor
 * session produced, across four schedule runs, two failure shapes the guard
 * correctly caught (all four finals were withheld/replaced):
 *   - sightings 3–4 (runs 68b4eff0, b81578cc): ZERO-EVIDENCE probe/deploy-class
 *     claims — the run restated the stored prompt's banked status lines
 *     ("prod … healthy", "probes … md5/lines") with ZERO evidence-bearing tool
 *     calls in the run's journal;
 *   - sightings 1–2 (runs d2e0b69e, b44d4bd6): FUTURE-DATED observation clocks
 *     on claim lines ("22:45Z" +22m ahead; "22:09Z" +4m ahead) — estimated
 *     clocks instead of this-run tool prints.
 *
 * These tests pin, against the REAL guard:
 *   1. both sighting shapes ARE flagged (the guard is the working control —
 *      a regression that stops catching them fails CI);
 *   2. the SAME claim text backed by an evidence-bearing tool call is CLEAN —
 *      the sightings were genuine zero-evidence runs, not guard overreach;
 *   3. intent-cued forward times ("next probe at …") stay unflagged, so the
 *      session's legitimate schedule citations don't false-positive;
 *   4. the verdict renders the exact wording the integrity ticket carries.
 *
 * The fix shipped with this file is BEHAVIORAL (failure-mode-specific rules
 * steered into the session's stored prompt) plus the dispatch-prescription
 * repair in run-executor.ts — the guard itself needed no weakening, and these
 * tests keep it that way.
 *
 * Boundary-mocked like run-evidence-guard.test.ts: logger + the GitHub token
 * manager are stubs; the REAL guard module executes.
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
  applyCompletionClaimGuard, findFutureDatedClaims, findUnprovenClaims,
  summarizeGuardVerdict, verdictHasFindings,
} from './run-evidence-guard';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };

/**
 * Sighting 3/4 shape (runs 68b4eff0 / b81578cc): a quick no-op firing's final
 * restating the stored prompt's banked status — "prod … healthy" is a deploy
 * claim (DEPLOY_ALT_RE), "probes … lines/md5" is a probe claim (PROBE pair).
 */
const ZERO_EVIDENCE_STATUS = [
  'Self-audit passed — acceptance criteria re-verified with fresh 13:02:39Z receipts.',
  'prod cql-w4a16 healthy, glm53-sword-w4-tp4-overlay Up 6 days (13:02:43Z)',
  'Fresh probes 13:02:42Z: DF2W25 driver 3383894 alive, STATUS lines 1-2, on-box mgr md5 8d5335f9 parity',
].join('\n');

describe('ticket 680dd00a replay — zero-evidence probe/deploy sightings (runs 68b4eff0, b81578cc)', () => {
  it('REPLAY: the sighting-shaped status summary with ZERO tool calls flags deploy + probe unproven', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: ZERO_EVIDENCE_STATUS, parts: [], triggerKind: 'schedule', resumed: false,
      now: new Date('2026-09-04T13:03:30.000Z'), ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual(['deploy', 'probe']);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD');
    expect(out.finalText).toContain('NO FRESH EVIDENCE this turn');
    // …and the verdict renders the exact wording the ticket carries.
    expect(summarizeGuardVerdict(out.verdict)).toBe('zero-evidence completion claims: deploy, probe');
  });

  it('replay detail: findUnprovenClaims marks both claim kinds on the sighting text, zero parts', () => {
    const unproven = findUnprovenClaims(ZERO_EVIDENCE_STATUS, []);
    expect(unproven.map((c) => c.kind).sort()).toEqual(['deploy', 'probe']);
  });

  it('CONTROL (no guard overreach): the SAME text backed by a run_command probe is CLEAN', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: ZERO_EVIDENCE_STATUS,
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'schedule', resumed: false,
      now: new Date('2026-09-04T13:03:30.000Z'), ...OPTS,
    });

    expect(out.verdict).toEqual({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] });
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toBe(ZERO_EVIDENCE_STATUS); // untouched — no guard note
  });
});

describe('ticket 680dd00a replay — future-dated observation sightings (runs d2e0b69e, b44d4bd6)', () => {
  it('REPLAY sighting 1: a claim line citing "22:45Z" at 22:23Z flags +22m ahead', () => {
    const text = 'prod cql-w4a16 healthy — probe clock 22:45Z, overlay active';
    const findings = findFutureDatedClaims(text, new Date('2026-08-28T22:23:00.000Z'));

    expect(findings).toHaveLength(1);
    expect(findings[0].stamp).toBe('22:45Z');
    expect(findings[0].aheadMs).toBe(22 * 60 * 1000);
  });

  it('REPLAY sighting 2: a claim line citing "22:09Z" at 22:05Z flags +4m ahead', () => {
    const text = 'prod cql-w4a16 healthy — probe clock 22:09Z, overlay active';
    const findings = findFutureDatedClaims(text, new Date('2026-09-01T22:05:00.000Z'));

    expect(findings).toHaveLength(1);
    expect(findings[0].stamp).toBe('22:09Z');
    expect(findings[0].aheadMs).toBe(4 * 60 * 1000);
  });

  it('future-dated flags even WITH evidence-bearing tools — it is a clock claim, not an evidence gap', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: 'prod cql-w4a16 healthy — probe clock 22:45Z, overlay active',
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'schedule', resumed: false,
      now: new Date('2026-08-28T22:23:00.000Z'), ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual([]); // evidence present
    expect(out.verdict.futureDated).toHaveLength(1);
    expect(out.verdict.futureDated[0]).toContain('22:45Z');
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(summarizeGuardVerdict(out.verdict)).toContain('future-dated observation claims: 22:45Z (+22m ahead)');
  });

  it('CONTROL: the same future clock INTENT-cued ("next probe at …") is a legitimate forward reference', () => {
    const text = 'prod cql-w4a16 healthy — next probe at 22:45Z (projection)';
    const findings = findFutureDatedClaims(text, new Date('2026-08-28T22:23:00.000Z'));

    expect(findings).toEqual([]);
  });

  it('CONTROL: the same clock cited as a PAST observation (now after it) is clean', () => {
    const text = 'prod cql-w4a16 healthy — probe clock 22:45Z, overlay active';
    const findings = findFutureDatedClaims(text, new Date('2026-08-28T22:46:30.000Z'));

    expect(findings).toEqual([]);
  });
});

describe('ticket 680dd00a — the session\'s disciplined receipts-backed answers stay clean', () => {
  it('a normal receipts-table final with fresh-probe parts produces NO findings', async () => {
    const disciplined = [
      'Self-audit passed — all five acceptance criteria re-verified with fresh 13:02:39Z-13:02:44Z receipts.',
      'prod cql-w4a16 healthy, glm53-sword-w4-tp4-overlay Up 6 days (13:02:43Z)',
      'Fresh probes 13:02:42Z: DF2W25 driver 3383894 alive, STATUS lines 1-2, on-box mgr md5 8d5335f9 parity',
      'Monitor read-back: sha 697d16c8, active 60m, next firing 13:35:40.301Z',
    ].join('\n');
    const out = await applyCompletionClaimGuard({
      finalText: disciplined,
      parts: [{ type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'schedule', resumed: false,
      now: new Date('2026-09-04T13:03:30.000Z'), ...OPTS,
    });

    expect(out.verdict).toEqual({ unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], futureDated: [] });
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toBe(disciplined);
  });
});
