/**
 * Replay/regression tests for feedback ticket cae70bfa (bug_report, fleet-integrity,
 * 2026-09-16): "schedule_self success receipt but row never persisted — DMG-watch
 * chain silently died (chat b92ef13f)".
 *
 * THE INCIDENT BEING REPLAYED: chat b92ef13f's 05:30Z DMG-watch firing (run
 * 0cb266e1) published a final reporting "creating successor
 * `d3b3ba07-4585-49c2-bef1-b5b80193224b` (claimed next 06:01:03.270Z, claimed
 * schedule_get verification)". Prod forensics (SSM probe 2026-09-16): the run's
 * run_tool_receipts contain NO schedule_self execution at all, no
 * coding_schedules row EVER held the id (no tombstone either), and no receipt
 * anywhere references it — the claimed creation was MODEL PHANTOM NARRATION,
 * not a lost write and not a false success envelope from the scheduling path
 * (createSchedule only returns ok:true after the resolved prisma insert).
 * The phantom citation sailed through the evidence guard with ZERO telemetry:
 * GUARD 6 covers feedback-ticket ids, GUARD 7 board ids — schedule ids (the
 * watch-chain family these lanes cite every firing) had no existence lane.
 * Only the lane's own self-audit habit caught it (same message reported
 * "No such schedule"); a lane without one lands the class silently and the
 * chain dies with no error surfaced anywhere — exactly what the ticket hit.
 *
 * THE FIX (this PR — GUARD 8, run-evidence-guard.ts): a schedule-id existence
 * lane mirroring the GUARD 6/7 two-lane discipline. Lane A: an id this run's
 * own evidence carries (a schedule_self/schedule_message/update_schedule
 * receipt's ids.scheduleId prefix-match, or the id present in the run's
 * tool-output haystacks) is observed-real and never reaches the resolver.
 * Lane B: the executor's injected prisma resolver (scheduleIdsExist — global,
 * state-agnostic: a cancelled/paused coding_schedules row is still a real
 * citation); absent or throwing → SILENT. Extraction is CUE-GOVERNED only
 * (GUARD 7 review F1 parity — schedule ids are uuids, family-ambiguous with
 * run/chat/session ids, so no uuid-anywhere path), scans a quote/bold-
 * normalized copy (F2 parity), and scopes intent/negation at the CUE (the cue
 * word "schedule" is itself an INTENT_BEFORE_VERB_RE token — a token-level
 * intent check would suppress every honest cue-governed citation).
 *
 * Boundary-mocked like run-evidence-guard.938dac2e.test.ts: logger + the
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
  applyCompletionClaimGuard,
  extractScheduleIdCitations,
  guardFindingKinds,
  renderGuardRejectBackNotice,
  summarizeGuardVerdict,
  verdictHasFindings,
} from './run-evidence-guard';

const OPTS = { userId: 'u1', repoUrl: null, provider: null, githubLabel: null };

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

// ── extraction ────────────────────────────────────────────────────────────────

describe('extractScheduleIdCitations (ticket cae70bfa)', () => {
  it('REPLAY: lifts the incident shape — a first-person successor-uuid assertion on a schedule line', () => {
    const text = 'Re-chain armed: schedule_self created successor `d3b3ba07-4585-49c2-bef1-b5b80193224b`, verified via schedule_get';
    expect(extractScheduleIdCitations(text).map((c) => c.id)).toEqual(['d3b3ba07-4585-49c2-bef1-b5b80193224b']);
  });

  it('a hedged THIRD-PERSON report of the claim is an audit line (refutation context), not a new assertion', () => {
    // The actual msg 4d2c637a phrasing — "reported creating … claimed …" — is
    // the same shape fleet adjudication lanes write honestly about a peer's
    // claim, so REFUTATION_CONTEXT_RE (claimed|reported|stated|…) spares it.
    // Conviction lands on the unhedged assertion (the REPLAY above), which is
    // the shape a lane writes when it believes its own phantom.
    const text = 'the 05:30 firing reported creating successor `d3b3ba07-4585-49c2-bef1-b5b80193224b` (claimed schedule_get verification)';
    expect(extractScheduleIdCitations(text)).toEqual([]);
  });

  it('lifts 8-hex prefixes after a schedule cue, deduped', () => {
    const text = 'Re-chain armed: schedule d3b3ba07 next; schedule d3b3ba07 again.';
    expect(extractScheduleIdCitations(text).map((c) => c.id)).toEqual(['d3b3ba07']);
  });

  it('walks comma chains ("schedules d3b3ba07, 1622231d verified")', () => {
    expect(extractScheduleIdCitations('schedules d3b3ba07, 1622231d verified').map((c) => c.id)).toEqual(['d3b3ba07', '1622231d']);
  });

  it('the fleet chain/link idioms lift on a schedule-gated line', () => {
    expect(extractScheduleIdCitations('watch chain `73650cc9-ef78-437d-8867-5b4e8a86d484` [active] per schedule_get').map((c) => c.id))
      .toEqual(['73650cc9-ef78-437d-8867-5b4e8a86d484']);
    expect(extractScheduleIdCitations('watch link f2aed619 confirmed [active] via schedule_get').map((c) => c.id)).toEqual(['f2aed619']);
  });

  it('the generic chain/link cues NEVER fire without a schedule word on the line', () => {
    expect(extractScheduleIdCitations('chain d3b3ba07 landed and link 1622231d followed')).toEqual([]);
  });

  it('a bare uuid of ANOTHER id family on a schedule-word line is never a schedule citation (F1 parity)', () => {
    expect(extractScheduleIdCitations('schedule note: the audit ran in run 5e61266b-49ad-47a3-8241-c5fd8a303b90')).toEqual([]);
    expect(extractScheduleIdCitations('schedule follow-up with chat 810c924d-1c74-4295-8049-9b48335c6c37 about the gate.')).toEqual([]);
  });

  it('skips absence reports — the self-audit phrasings, convicting them strikes the messenger', () => {
    expect(extractScheduleIdCitations('This turn, `schedule_get d3b3ba07…` returned **"No such schedule"**')).toEqual([]);
    expect(extractScheduleIdCitations('schedule d3b3ba07 → 404 on a fresh pull')).toEqual([]);
    expect(extractScheduleIdCitations('schedule d3b3ba07 — no such row in coding_schedules')).toEqual([]);
  });

  it('skips refutation/audit lines', () => {
    expect(extractScheduleIdCitations('the lane fabricated schedule d3b3ba07 — the id exists nowhere')).toEqual([]);
  });

  it('an intent-scoped cue never lifts ("will schedule X" claims nothing yet)', () => {
    expect(extractScheduleIdCitations('next firing will schedule d3b3ba07 for the watch')).toEqual([]);
  });

  it('a date-shaped 8-digit token is never a schedule id', () => {
    expect(extractScheduleIdCitations('schedule 20260916 review the watch')).toEqual([]);
  });

  it('backticked/quoted/bold ids after the cue still extract (fleet markdown cannot evade)', () => {
    expect(extractScheduleIdCitations('successor `d3b3ba07` armed for the schedule').map((c) => c.id)).toEqual(['d3b3ba07']);
    expect(extractScheduleIdCitations('schedule **d3b3ba07** armed').map((c) => c.id)).toEqual(['d3b3ba07']);
    expect(extractScheduleIdCitations("schedule 'd3b3ba07' armed").map((c) => c.id)).toEqual(['d3b3ba07']);
  });
});

// ── the lane (conviction + exoneration) ───────────────────────────────────────

describe('GUARD 8 lane — schedule-citation existence via the injected resolver', () => {
  const INCIDENT_FINAL = [
    'DMG-watch firing complete.',
    '- Gate still walled (NC_EXIT=1); no artifacts commit on origin/main.',
    '- **Re-chain armed:** schedule_self created successor `d3b3ba07-4585-49c2-bef1-b5b80193224b`, verified via schedule_get.',
  ].join('\n');

  const guard = (extra: Record<string, unknown>) =>
    applyCompletionClaimGuard({
      finalText: INCIDENT_FINAL,
      parts: [],
      triggerKind: 'schedule',
      resumed: false,
      ...OPTS,
      ...extra,
    } as any);

  it('REPLAY: the incident shape convicts with a strip+mark note (resolver knows nothing)', async () => {
    const out = await guard({ scheduleIdsExist: async () => new Set<string>() });
    expect(out.verdict.fabricatedScheduleIds).toEqual(['d3b3ba07-4585-49c2-bef1-b5b80193224b']);
    expect(verdictHasFindings(out.verdict)).toBe(true);
    expect(guardFindingKinds(out.verdict)).toEqual(expect.arrayContaining(['fabricated_schedule_id']));
    expect(out.finalText).toContain('[HARNESS EVIDENCE GUARD — FABRICATED SCHEDULE IDS]');
    expect(out.finalText).toContain('cae70bfa');
    expect(summarizeGuardVerdict(out.verdict)).toContain(
      'fabricated schedule ids (no such coding_schedules row): d3b3ba07-4585-49c2-bef1-b5b80193224b',
    );
  });

  it('a final carrying BOTH the phantom assertion and its self-audit denial still strikes the assertion line', async () => {
    const out = await guard({
      finalText: [
        '- **Re-chain armed:** successor `d3b3ba07-4585-49c2-bef1-b5b80193224b`, verified via schedule_get.',
        '- Self-audit: `schedule_get d3b3ba07…` returned "No such schedule" — chain is DOWN.',
      ].join('\n'),
      scheduleIdsExist: async () => new Set<string>(),
    });
    expect(out.verdict.fabricatedScheduleIds).toEqual(['d3b3ba07-4585-49c2-bef1-b5b80193224b']);
  });

  it('honest citation: the resolver vouching for the id keeps the lane silent', async () => {
    const out = await guard({ scheduleIdsExist: async (ids: string[]) => new Set(ids) });
    expect(out.verdict.fabricatedScheduleIds ?? []).toEqual([]);
    expect(out.finalText).not.toContain('FABRICATED SCHEDULE IDS');
  });

  it('no resolver injected → silent (never a conviction on unavailable verification)', async () => {
    const out = await guard({});
    expect(out.verdict.fabricatedScheduleIds ?? []).toEqual([]);
  });

  it('a THROWING resolver → silent (a DB hiccup never convicts)', async () => {
    const out = await guard({ scheduleIdsExist: async () => { throw new Error('db down'); } });
    expect(out.verdict.fabricatedScheduleIds ?? []).toEqual([]);
  });

  it("an id this run's own tool output carries is observed-real (never reaches the resolver)", async () => {
    const resolver: jest.Mock = jest.fn(async () => new Set<string>());
    const out = await guard({
      scheduleIdsExist: resolver,
      toolTexts: ['schedule_get → d3b3ba07-4585-49c2-bef1-b5b80193224b [active] once · next 06:01Z'],
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(out.verdict.fabricatedScheduleIds ?? []).toEqual([]);
  });

  it("a schedule receipt's ids.scheduleId prefix-exonerates the citation", async () => {
    const resolver: jest.Mock = jest.fn(async () => new Set<string>());
    const out = await guard({
      finalText: '- Re-chain armed: successor schedule `d3b3ba07` (verified).',
      scheduleIdsExist: resolver,
      receipts: [{ id: 'rcpt1', tool: 'schedule_self', ok: true, stamp: 'x', ids: { scheduleId: 'd3b3ba07-4585-49c2-bef1-b5b80193224b' } }],
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(out.verdict.fabricatedScheduleIds ?? []).toEqual([]);
  });

  it('review W1: the reject-back notice names the fabricated schedule ids (EVIDENCE_GUARD_ENFORCE=1 parity)', async () => {
    const out = await guard({ scheduleIdsExist: async () => new Set<string>() });
    const notice = renderGuardRejectBackNotice(out.verdict);
    expect(notice).toContain('fabricated schedule ids (no such coding_schedules row exists): d3b3ba07-4585-49c2-bef1-b5b80193224b');
  });

  it('an honest chain-status final carrying prior-run uuids convicts nothing (F1 lane pin)', async () => {
    const resolver: jest.Mock = jest.fn(async () => new Set<string>());
    const out = await guard({
      finalText: 'Chain status: schedule_get this turn shows `1622231d-14ff-45eb-8834-1a0c3f771057 [active]`; last run 0cb266e1-aa59-4227-bc83-1f0ef310bb29 completed.',
      scheduleIdsExist: resolver,
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(out.verdict.fabricatedScheduleIds ?? []).toEqual([]);
  });
});
