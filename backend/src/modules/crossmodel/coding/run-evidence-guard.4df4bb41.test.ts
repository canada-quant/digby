/**
 * Replay/regression tests for feedback ticket 4df4bb41 (mishap, fleet-integrity,
 * 2026-09-10): "Evidence guard: machine run asserted unproven completions
 * (session 7b82d49c)".
 *
 * THE MISHAP BEING REPLAYED: chat 7b82d49c-5417-4828-949a-c69f751439e5 ran the
 * ticket-9a9911bb STEER-KEEPER loop (recurring schedule e90a4b63, 75m ×6). On
 * firing 5/6 at 13:40:22Z (run ab52991a-77af-4ac5-a51e-5e1a995db37f) the run's
 * journal held ONLY fleet-platform reads/writes — get_feedback / list_schedules
 * / schedule_get / update_schedule / update_feedback (it VERIFIED-CLOSED its
 * goal ticket 9a9911bb at 13:45:31Z) — none of which satisfies the probe
 * evidence tier (external-action | local read | web read | delegate). Its final
 * then asserted a probe-kind completion — a fresh health/probe observation
 * restating the prompt-carried shipped context ("deploy run 34446442098
 * success, /api/health 200") as a this-firing observation. The guard convicted
 * "zero-evidence completion claims: probe" and withheld the final pre-delivery
 * (containedPreDelivery: true, filed 2026-09-10T13:53:14.065Z).
 *
 * The withheld claim LINE is unreconstructable (struck drafts are not
 * delivered), so this replay pins the CONVICTED SHAPE the filing names: a
 * probe subject (box|tailnet|probe) + an observed-evidence noun
 * (healthy|active|HTTP 200|…) on ONE line, against a journal with zero
 * probe-tier entries. (The prompt's "prod /api/health 200" wording would have
 * convicted DEPLOY via DEPLOY_ALT_RE; the filing says probe, so the withheld
 * line matched the probe pair — that is the shape pinned here.)
 *
 * The gap the steer had: the keeper's GUARD-RECURRENCE RULES covered the
 * RE-STAGE branches (rules 1–3) but NOT the goal-met close/STOP path — the one
 * branch whose journal is platform-writes-only by construction. The fix for
 * this ticket is BEHAVIORAL (retire the obsolete keeper loop — its goal ticket
 * 9a9911bb is done — and keep stop/close-path finals claim-free row
 * citations); the guard itself needed no change, and these tests keep it that
 * way.
 *
 * Boundary-mocked like run-evidence-guard.test.ts: logger + the GitHub token
 * manager are stubs, global.fetch is a mock; the REAL guard module executes.
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
  applyCompletionClaimGuard, findUnprovenClaims,
  summarizeGuardVerdict, verdictHasFindings,
} from './run-evidence-guard';

const OPTS = { userId: 'u1', repoUrl: 'https://github.com/o/r', provider: 'github' };

/** The flagged run's withholding instant (fired 13:40:22Z; filed 13:53:14.065Z). */
const INCIDENT_NOW = new Date('2026-09-10T13:53:14.000Z');

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
 * The convicted shape (run ab52991a): a keeper-styled close report whose last
 * line asserts fresh probes. "box probe" + "healthy"/"active" on ONE line is
 * the probe pair (PROBE_RE × PROBE_EVIDENCE_RE). The line deliberately avoids
 * every other kind's pattern (no PR number, no push verb + sha clause, no
 * deploy verb / health-check / prod / digby.ai) so the replay convicts probe
 * ONLY — exactly the filing's "zero-evidence completion claims: probe".
 */
const INCIDENT_FINAL = [
  'Ticket 9a9911bb closed done per update_feedback; steer stored per schedule_get b9aa24f3.',
  'Post-close probes came back green across the fleet: box probe healthy, tailnet probe active.',
].join('\n');

/**
 * The flagged run's actual journal shape: fleet-platform reads + account
 * writes only. get_feedback/schedule_get/update_feedback are NOT in
 * NON_EVIDENCE_TOOLS, so they enter the names list — but the probe tier
 * (external-action | local read | web read | delegate) contains none of
 * them, so a probe claim still convicts. This is the point of the replay:
 * even a real, ticket-closing update_feedback write vouches NOTHING for a
 * probe claim.
 */
const PLATFORM_ONLY_PARTS: any[] = [
  { type: 'tool_call', name: 'get_feedback', args: {} },
  { type: 'tool_call', name: 'list_schedules', args: {} },
  { type: 'tool_call', name: 'schedule_get', args: {} },
  { type: 'tool_call', name: 'update_schedule', args: {} },
  { type: 'tool_call', name: 'update_feedback', args: {} },
];

describe('ticket 4df4bb41 replay — zero-evidence probe sighting (session 7b82d49c, run ab52991a)', () => {
  it("REPLAY: a probe claim whose journal holds only fleet-platform reads/writes flags probe unproven, with the ticket's exact verdict wording", async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL, parts: PLATFORM_ONLY_PARTS,
      triggerKind: 'schedule', resumed: false,
      now: INCIDENT_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual(['probe']);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(out.finalText).toContain('HARNESS EVIDENCE GUARD');
    // audit 2026-10-06 T7-6: the run DID make platform reads — the note counts them
    // instead of claiming zero (GUARD_DEFER_PR_PUSH_DISABLED=1 restores the old sentence).
    expect(out.finalText).toContain('NO FRESH EVIDENCE for these claims');
    expect(out.finalText).toMatch(/made \d+ evidence-bearing tool calls?, but none of them evidences the completions below/);
    expect(out.finalText).not.toContain('zero evidence-bearing tool calls');
    // …and the verdict renders the exact wording the ticket carries.
    expect(summarizeGuardVerdict(out.verdict)).toBe('zero-evidence completion claims: probe');
    // The probe lane re-queries NOTHING (no sha/PR to look up) — the
    // conviction is journal-backed alone, exactly as the filing states.
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('replay detail: findUnprovenClaims marks probe on the incident text with platform-only parts', () => {
    const unproven = findUnprovenClaims(INCIDENT_FINAL, PLATFORM_ONLY_PARTS);

    expect(unproven.map((c) => c.kind)).toEqual(['probe']);
  });

  it('CONTROL (no guard overreach): the SAME probe claim backed by a this-run run_command probe is CLEAN', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [...PLATFORM_ONLY_PARTS, { type: 'tool_call', name: 'run_command', args: {} }],
      triggerKind: 'schedule', resumed: false,
      now: INCIDENT_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).not.toContain('HARNESS EVIDENCE GUARD');
  });

  it('CONTROL (tier breadth): a local read (read_file) also evidences a probe claim — only the platform-only journal convicts', async () => {
    const out = await applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [...PLATFORM_ONLY_PARTS, { type: 'tool_call', name: 'read_file', args: {} }],
      triggerKind: 'schedule', resumed: false,
      now: INCIDENT_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false);
  });

  it("CONTROL (the steered stop-path shape): a goal-met firing's claim-free row-citing one-liner passes untouched", async () => {
    const oneLiner =
      'Ticket 9a9911bb is done per get_feedback row (status done, updatedAt 2026-09-10T13:45:31.493Z); steer stored per schedule_get b9aa24f3 (promptSha256 1115d1740383). Keeper loop ends by maxRuns — no further action.';

    const out = await applyCompletionClaimGuard({
      finalText: oneLiner, parts: PLATFORM_ONLY_PARTS,
      triggerKind: 'schedule', resumed: false,
      now: INCIDENT_NOW, ...OPTS,
    });

    expect(out.verdict.unprovenKinds).toEqual([]);
    expect(verdictHasFindings(out.verdict)).toBe(false);
    expect(out.finalText).toBe(oneLiner); // untouched — no guard note
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
