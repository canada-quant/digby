/**
 * build 2026-10-08 Q-3 — OWNER-APPROVED future-clock package (supersedes the "replace" half of directive
 * cdd3fbfe). platform/future-clock-policy.ts + chat-agent/answer-clock.ts stampAheadHeadlineClock + the guard.
 *
 * REPLAY CORPUS: every first-pass future-clock strike since 2026-09-25 (33 strikes, 36 hits — loop_metrics
 * guard_strike seam machine_wake_reject_back, meta.clockHits; finish-run.md §1.2 hand adjudication: 1 real
 * fabricated clock — the projected "Fleet wake — 6:33 AM PDT" headline at 5:08 AM PDT; 2 time-zone slips;
 * 1 unclear; 29 legitimate). Each `line` is the stored excerpt VERBATIM; where the stored excerpt was cut
 * before its own token (six pre-2026-09-26 rows, before the token-anchored excerpt), the clause holding the
 * token is reconstructed and marked `// +rec`.
 *
 * Bars pinned here: (1) NONE of the 36 hits convicts under the observation-only rule; (2) the one real class
 * (the ahead headline) is CORRECTED by the restamp, and the wrong-zone headline gloss with it; (3) the true
 * fabrication shapes still convict (375c8618 "verified through", 1c2eb455 "done at", "Probe at … found",
 * "as of", "now"); (4) a convicted clock ANNOTATES (never replaces), files its ticket, and is never rejected
 * back alone; (5) FUTURE_CLOCK_REPLACE_ENABLED=1 restores the legacy lane.
 */

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  crossModelChat: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  chatCodingState: { findFirst: jest.fn(async () => null) },
  chatSchedule: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  userFeatureRequest: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockUtilityChat = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => (mockUtilityChat as any)(...a) }));
const mockFileFeedbackTicket = jest.fn(async (..._a: any[]) => ({ deduped: false, ticket: { id: 't-1' } }));
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  fileFeedbackTicket: (...a: any[]) => (mockFileFeedbackTicket as any)(...a),
}));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendVerifierRefutation: jest.fn(async () => {}),
  getSupervisorState: jest.fn(async () => ({ directives: [], dispatches: [], projects: [], notes: '', refutations: [] })),
}));
jest.mock('../coding/run-receipts.service', () => ({
  __esModule: true,
  getRecentChatReceipts: jest.fn(async () => []),
}));

import { guardMachineWakeFinalAnswer, ACTION_GUARD_BANNER, ACTION_GUARD_ANNOTATION_HEADER } from './action-verifier';
import { classifyFutureClockHit, partitionFutureClockHits, futureClockReplaceEnabled } from './future-clock-policy';
import { stampAheadHeadlineClock } from '../chat-agent/answer-clock';

const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.FUTURE_CLOCK_REPLACE_ENABLED;
});
afterAll(() => { delete process.env.FUTURE_CLOCK_REPLACE_ENABLED; });

/** [strike time, seat, token, minutesAhead, line, expected verdict] */
const CORPUS: Array<[string, string, string, number, string, string]> = [
  ['09-25 07:05', '2da8766f', '11:30Z', 267, "After TRAIN_DONE: comparator package → the coordinator's SFT-2 launch announcement, which is our drain trigger (hand back by 11:30Z, block end 12:08Z)", 'forward'], // +rec
  ['09-25 07:05', '2da8766f', '12:08Z', 305, "After TRAIN_DONE: comparator package → the coordinator's SFT-2 launch announcement, which is our drain trigger (hand back by 11:30Z, block end 12:08Z)", 'forward'], // +rec
  ['09-25 08:11', '2da8766f', '12:08Z', 240, '- todo 60867ac5: banked R6 72/72-steps-done + final-save-in-flight delta (TRAIN_DONE ~08:0xZ not landed @08:07Z, drain trigger 12:08Z)', 'not_observation'], // +rec
  ['09-25 10:26', 'f5c2c1f4', '12:08Z', 104, '- Acked the inference supervisor (receipt 76d210f7): both corrections landed, drain trigger armed on the SFT-2 launch announcement (capacity decision 12:08Z)', 'not_observation'], // +rec
  ['09-25 10:46', 'c0e22e36', '7:31 AM PDT', 229, '| canlegal-bench | Unchanged — harvest waits on your morning Mac paste | morning nudge 7:31 AM PDT |', 'not_observation'],
  ['09-25 10:53', 'c0e22e36', '5:08 AM PDT', 77, "- CanLaw's smoke test, the tt-rd speed fix, and the 5:08 AM PDT capacity check: unchanged since the 3:44 AM note.", 'not_observation'],
  ['09-25 18:19', '2da8766f', '19:40Z', 85, 'Nothing needs the owner: 0 open owner questions, serving GREEN through the block end 2026-09-26T11:30Z, and the shifted capacity check 19:40Z.', 'not_observation'], // +rec
  ['09-25 20:50', 'f5c2c1f4', '22:10Z', 83, '- Delta report-up sent to Fleet Supervisor (receipt 5f010ac6): capacity landed, cyan RUNNING, TRAIN_DONE re-anchored ≈21:40–22:10Z', 'not_observation'], // +rec
  ['09-25 21:44', 'c0e22e36', '2:45 PM PDT', 9, '| CanLaw | Final SFT round training, no 5th preemption | TRAIN_DONE ~2:30–2:45 PM PDT |', 'not_observation'],
  ['09-25 23:06', 'c0e22e36', '4:40 PM PDT', 41, '| CQL Gateway | ✅ Your 4 AGX routes + node-b rename merged · deploy grid-gated | endpoints live ~4:40 PM PDT |', 'forward'],
  ['09-26 00:19', 'c0e22e36', '5:45 PM PDT', 34, '| CQL Gateway | ✅ Your 4 AGX routes + engine rename + tag fix all merged · deploy executing with the known-bad node-b leg | endpoints live ~5:45 PM PDT |', 'forward'], // +rec
  ['09-26 10:52', 'c0e22e36', '9:00 AM PDT', 313, '| CanLaw | Smoke run: 1 of 6 rounds banked, round 2 underway, GPU 97–100% | Training done ~8:30–9:00 AM PDT, verdict ~10:30–11:30 AM PDT |', 'not_observation'],
  ['09-26 11:18', 'c0e22e36', '9:00 AM PDT', 285, '| CanLaw | Smoke training healthy into round 2 (reported 10:51Z) | training done ~8:30–9:00 AM PDT, verdict late morning |', 'not_observation'],
  ['09-26 12:14', 'c0e22e36', '10:05 AM PDT', 297, '| CanLaw | Smoke run survived preempt #13 with zero data loss, back training on round 2 | Done ~9:35–10:05 AM PDT, verdict ~11:35 AM–12:05 PM PDT |', 'not_observation'],
  ['09-26 12:14', 'c0e22e36', '12:05 PM PDT', 417, '| CanLaw | Smoke run survived preempt #13 with zero data loss, back training on round 2 | Done ~9:35–10:05 AM PDT, verdict ~11:35 AM–12:05 PM PDT |', 'not_observation'],
  ['09-26 18:44', 'c0e22e36', '2026-10-03T11:30Z', 9647, 'Receipts: chat 2da8766f (inference Supervisor) — comparator HOLD @16:57Z upstream (coord e083ff2e) · steer msg b49101ff executed, verified msg 2307d1b3 (as repo', 'dated'],
  ['09-26 22:34', 'f5c2c1f4', '07:33 PM PDT', 240, '**CanLaw supervisor sweep — 22:33Z (07:33 PM PDT)**', 'not_observation'],
  ['09-27 01:44', '2da8766f', '2026-10-03T11:30Z', 9228, '**Why it matters here:** that comparator verdict is the arm signal for our 16×H100 handback (todo `60867ac5`, progress note updated this wake) and the drain/rel', 'dated'],
  ['09-27 03:42', '2da8766f', '2026-10-03T11:30Z', 9109, '- Idle-cadence ruling recorded in state doc: ec29c9f6 is NOT retireable — it waits for a real external event (CanLaw SFT-2 launch → handback + drain, or block e', 'dated'],
  ['09-27 11:43', 'f5c2c1f4', '18:00Z', 379, '- Fleet report-up sent: S2V15 launched + first-loss evidence, coordinator 18:00Z checkpoint — receipt 510d5048', 'not_observation'],
  ['09-27 12:06', 'f5c2c1f4', '18:00Z', 355, '**Needs the owner:** Nothing — 0 open owner questions; the 18:00Z escalation checkpoint (priced non-preemptible fallback) is coordinator-owned and falls under p', 'not_observation'],
  ['09-27 12:10', 'c0e22e36', '6:33 AM PDT', 85, '**Fleet wake — 6:33 AM PDT: tt-rd bisect runner went idle → nudged; CanLaw V15 training past 70 min on spot (loss 2) — stable; index fix chain stays closed**', 'not_observation'],
  ['09-27 13:32', '615723ba', '18:00Z', 269, "No action needed this wake: both lanes armed with correct runbooks, cadence healthy, no deaf lane, no drift. Coordinator's 18:00Z escalation checkpoint and 09-2", 'not_observation'],
  ['09-27 14:27', 'f5c2c1f4', '18:00Z', 214, '**Needs the owner:** nothing — 0 open owner questions on the board; the 18:00Z checkpoint (cheapest non-preemptible capacity purchase under the 2026-09-10 grant', 'not_observation'],
  ['09-27 19:06', 'c0e22e36', '1:46 PM PDT', 101, '**Fleet wake — 12:04 PM PDT (19:04Z): your H2H benchmark is 82% done and on pace for ~1:46 PM PDT; the harness bug that skipped a few supervisor sweeps is ticke', 'forward'],
  ['09-28 05:18', '2da8766f', '2026-10-03T11:30Z', 7572, "- Directive `ca275b3f` (artifact backup + reservation watch) stays open with fresh evidence: the lane's monitor cadence is the reservation-end watch through 202", 'dated'],
  ['09-28 06:48', '2da8766f', '18:19Z', 691, "… objects), the p5 handback was communicated and completed 09-27 18:19Z, and the reservation-end watch lives on in the fleet's watched-resource registry (row 76d", 'dated'],
  ['09-30 00:15', 'edf5b3b3', '02:22Z', 138, '- 81e33ccd "let it finish then re run failures" — substantively in execution: v3b finished (interim premises registered 02:22Z), failure re-runs live (v3c parti', 'not_observation'],
  ['09-30 00:15', 'edf5b3b3', '02:22Z', 138, '…ers, register premises superseding the interim v3b set (scored_mean 0.2857 / 14 trials) and the stale spend register (106.66 USD @ 02:22Z vs lane-live $201.08).', 'not_observation'],
  ['10-02 03:24', 'c0e22e36', '14:41Z', 678, '- One decision unchanged in your inbox: crossmodel M1.5 store wave (oq_fee2d8eb, open since 7:41 AM PDT / 14:41Z).', 'not_observation'],
  ['10-06 23:42', 'c0e22e36', '4:52 PM PDT', 14, '- **Gateway reconciliation re-dispatched:** the CQL gateway supervisor acknowledged the stale Command-A+ route question ("routing now") at 4:52 PM PDT, but noth', 'not_observation'],
  ['10-07 07:14', '41bd202a', '9:00 AM PDT', 526, '- **Owner card oq_7e46e811 verified OPEN** via fresh pull — still the one live gate (AM physical camera check; school hours 9:00 AM PDT)', 'not_observation'],
  ['10-07 15:51', '41bd202a', '22:00Z', 369, '- **Rung-3 (mitm system-CA):** stays HELD for ≥22:00Z (off-school-hours) — only if rung-1 yields too few UUIDs.', 'forward'],
  ['10-07 15:53', '41bd202a', '22:00Z', 367, '- **Fleet ack (advisory, no-reply-needed):** the 3-rung re-scope is endorsed verbatim — rung-3 mitm dispatches ≥22:00Z under my off-school-hours guard, no owner', 'forward'],
  ['10-07 19:07', 'c0e22e36', '6:48 PM PDT', 403, "Verified fresh this run, not from the report: the fix's deploy wave completed successfully (run 37665840, finished 6:48 PM PDT) and **every production box is ru", 'not_observation'],
  ['10-08 12:16', '41bd202a', '16:00Z', 224, '…180 min, verified by the lane itself; hue-record.timer re-armed 16:00Z today; HUE_RECORD_FORCE leftover removed) — the cadence/watchdog fix is CLOSED at the roo', 'forward'],
];

describe('REPLAY — the 33 clock strikes since 2026-09-25 (36 hits): none convicts under the observation rule', () => {
  it.each(CORPUS)('%s %s "%s" (+%i min) → %#', (_t, _seat, token, _ahead, line, expected) => {
    expect(classifyFutureClockHit({ token, line })).toBe(expected);
  });
  it('partition: 0 convicted of 36 (was 36 struck, 33 notes re-run, 2 replaced)', () => {
    const hits = CORPUS.map(([, , token, minutesAhead, line]) => ({ token, line, minutesAhead }));
    const p = partitionFutureClockHits(hits);
    expect(hits).toHaveLength(36);
    expect(p.convicted).toHaveLength(0);
    expect(p.observed).toHaveLength(36);
  });
});

describe('the one REAL class is corrected, not flagged — stampAheadHeadlineClock', () => {
  it('REPLAY 09-27 12:10Z: "**Fleet wake — 6:33 AM PDT: …**" written at 5:08 AM PDT → restamped to 5:08 AM PDT', () => {
    const note = '**Fleet wake — 6:33 AM PDT: tt-rd bisect runner went idle → nudged; CanLaw V15 training past 70 min on spot (loss 2) — stable; index fix chain stays closed**\n\n- detail line';
    const r = stampAheadHeadlineClock(note, new Date('2026-09-27T12:08:00Z'));
    expect(r.text.startsWith('**Fleet wake — 5:08 AM PDT: tt-rd bisect runner')).toBe(true);
    expect(r.text.endsWith('\n\n- detail line')).toBe(true);
    expect(r.stamped).toEqual({ from: '6:33 AM PDT', to: '5:08 AM PDT', driftMin: -85, direction: 'ahead' });
  });
  it('REPLAY 09-26 22:34Z: a wrong-zone GLOSS beside a correct clock is corrected alone — "22:33Z (07:33 PM PDT)" → "22:33Z (03:33 PM PDT)"', () => {
    const r = stampAheadHeadlineClock('**CanLaw supervisor sweep — 22:33Z (07:33 PM PDT)**', new Date('2026-09-26T22:33:20Z'));
    expect(r.text).toBe('**CanLaw supervisor sweep — 22:33Z (03:33 PM PDT)**');
    expect(r.stamped).toMatchObject({ from: '22:33Z (07:33 PM PDT)', to: '22:33Z (03:33 PM PDT)', direction: 'ahead' });
  });
  it('seconds and padding are kept: "Sweep — 15:03:42Z" at 14:24:28Z → "Sweep — 14:24:28Z"', () => {
    expect(stampAheadHeadlineClock('Sweep — 15:03:42Z: all green', new Date('2026-08-27T14:24:28Z')).text).toBe('Sweep — 14:24:28Z: all green');
  });
  it.each([
    ['a forward ETA in the headline (09-27 19:06Z)', '**Fleet wake — 12:04 PM PDT (19:04Z): your H2H benchmark is 82% done and on pace for ~1:46 PM PDT**', '2026-09-27T19:05:00Z'],
    ['a forward-cued first clock', '**Next wake 18:00Z — nothing to report**', '2026-09-27T12:00:00Z'],
    ['a dated headline', '**Wake 2026-09-15T01:10:53Z — 05:00Z check**', '2026-09-15T01:14:00Z'],
    ['a stale (behind) clock — the human-turn stamp owns that', '**Fleet wake — 4:00 AM PDT: quiet**', '2026-09-27T12:08:00Z'],
    ['a clock outside a status stamp', '**The canary deploy finished cleanly and the 18:00Z checkpoint is coordinator-owned**', '2026-09-27T12:00:00Z'],
    ['within the 90 s tolerance', '**Fleet wake — 12:09Z: quiet**', '2026-09-27T12:08:00Z'],
    ['a backward-pointing clock (the chat-agent 5f22a689 note shape)', 'WAKE: no-op — nothing moved on any project since 05:40Z', '2026-09-27T22:30:00Z'],
  ])('never touched: %s', (_why, note, now) => {
    expect(stampAheadHeadlineClock(note, new Date(now))).toEqual({ text: note });
  });
});

describe('true fabrication shapes still convict (written as observations)', () => {
  it.each([
    ['375c8618 Re-Send: "verified through"', '15:03:42Z', 'Audit complete — verified through 15:03:42Z, all green.'],
    ['1c2eb455 SWEEP-46: "done at"', '06:05:31Z', '- **g2b ADJUDICATED + BANKED** (todo d17821d0 done at 06:05:31Z; spark lane msg 235b827e @06:06:02Z): Amendment-1 within-boot repro'],
    ['"Probe at <clock> found …"', '22:00Z', 'Probe at 22:00Z found nothing.'],
    ['"as of <clock>"', '17:40Z', '- status as of 17:40Z: all lanes green'],
    ['"now <clock>"', '06:33Z', '- lanes idle — now 06:33Z, nothing queued'],
  ])('%s', (_why, token, line) => {
    expect(classifyFutureClockHit({ token, line })).toBe('convicted');
  });
  it('an observation cue with a forward marker AT the clock is an estimate', () => {
    expect(classifyFutureClockHit({ token: '06:33Z', line: '- status as of ~06:33Z (projected)' })).toBe('forward');
  });
  it('the 1c2eb455 "msg <id> @<clock>" stamp is observed only (a timestamp, not an observation clause)', () => {
    expect(classifyFutureClockHit({ token: '06:06:02Z', line: '(todo d17821d0 done at 06:05:31Z; spark lane msg 235b827e @06:06:02Z): Amendment-1' })).toBe('not_observation');
  });
});

describe('guardMachineWakeFinalAnswer under the clock policy', () => {
  // The 1c2eb455 incident note (action-verifier.1c2eb455.test.ts), run clock 2026-09-16T06:03:46.513Z.
  const NOW = new Date('2026-09-16T06:03:46.513Z');
  const G2B = '- **g2b ADJUDICATED + BANKED** (todo d17821d0 done at 06:05:31Z; spark lane msg 235b827e @06:06:02Z): Amendment-1 within-boot repro CID 6cd1d875 — c16 Δ−0.2762 **reproduced** ⇒ tok/s FROZEN.';
  const NOTE = ['**06:02Z SWEEP 46 — ADOPT-3b: g2b FROZEN, g3 in flight, restore armed**', '', G2B, '', 'SWEEP: no-op — lanes are executing on their own armed cadence.'].join('\n');
  const guard = (extra: Record<string, unknown> = {}) => guardMachineWakeFinalAnswer({
    chatId: '9e6e1712-8dc3-4e02-b70c-557bb5b41d2d', userId: OWNER, finalText: NOTE, parts: [], receipts: [],
    runStartedAt: new Date('2026-09-16T06:02:00.000Z'), supervisor: false, now: NOW, machineTriggered: true, ...extra,
  } as any);

  it('a convicted clock ANNOTATES: the note is delivered as written + one trailing annotation; the ticket fires; no reject-back even when deferred', async () => {
    const res = await guard({ deferConsequences: true });
    expect(res.struck).toBe(true);
    expect(res.delivery).toBe('annotated');
    expect(res.finalText.startsWith(NOTE)).toBe(true);
    expect(res.finalText).not.toContain(ACTION_GUARD_BANNER);
    expect(res.finalText).not.toContain('--- BEGIN STRUCK NOTE');
    expect(res.notice.startsWith(ACTION_GUARD_ANNOTATION_HEADER)).toBe(true);
    expect(res.notice).toContain('"06:05:31Z"');
    expect(res.notice).not.toContain('"06:06:02Z"'); // observed only — never named as a conviction
    expect(res.notice.match(/min ahead — in:/g)).toHaveLength(1);
    expect(res.rejectBackNotice).toBeUndefined(); // a clock-only strike is never re-run
    expect(res.correction).toContain('DELIVERED AS WRITTEN');
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect((mockFileFeedbackTicket.mock.calls[0][0] as any).context).toMatchObject({ containedPreDelivery: true, deliveredAnnotated: true });
    expect(res.clockVerdict).toMatchObject({ outcome: 'annotated', legacy: false });
    expect(res.clockVerdict!.hits).toEqual(expect.arrayContaining([
      expect.objectContaining({ token: '06:05:31Z', verdict: 'convicted' }),
      expect.objectContaining({ token: '06:06:02Z', verdict: 'not_observation' }),
    ]));
  });

  // Tickets 4c7aebf7 + 9a976d83, round-2 finding 4: when the seam has decided to reject the note back as a
  // struck-note REPEAT, pass 1 must not file the clock ticket saying the note was "DELIVERED AS WRITTEN" — that
  // draft is discarded. deferClockTicket defers it the way every other lane defers; the pass-2 guard (no defer)
  // files it on the text actually delivered. No rejectBackNotice is rendered for it (the seam's notice carries the retry).
  it('deferClockTicket (with deferConsequences): the annotated verdict is unchanged but the ticket waits for the pass-2 verdict', async () => {
    const pass1 = await guard({ deferConsequences: true, deferClockTicket: true });
    expect(pass1.struck).toBe(true);
    expect(pass1.delivery).toBe('annotated');
    expect(pass1.finalText.startsWith(NOTE)).toBe(true);
    expect(pass1.rejectBackNotice).toBeUndefined();
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    // pass 2 on the text that is actually delivered (here: the same text — a failed retry) files it, annotated
    const pass2 = await guard({});
    expect(pass2.struck).toBe(true);
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
    expect((mockFileFeedbackTicket.mock.calls[0][0] as any).context).toMatchObject({ containedPreDelivery: true, deliveredAnnotated: true });
  });

  it('deferClockTicket alone (no deferConsequences — a pass-2 shape) is ignored: the ticket files as before', async () => {
    await guard({ deferClockTicket: true });
    expect(mockFileFeedbackTicket).toHaveBeenCalledTimes(1);
  });

  it('only non-observation clocks: NOT struck by the clock lane, the note continues unchanged, the verdict says observed', async () => {
    const note = '- The one live gate stays the AM physical camera check (school hours 9:00 AM PDT)';
    const res = await guardMachineWakeFinalAnswer({ chatId: '41bd202a-0000-4000-8000-000000000000', userId: OWNER, finalText: note, parts: [], receipts: [], runStartedAt: new Date('2026-10-07T07:10:00Z'), supervisor: false, now: new Date('2026-10-07T07:14:00Z'), machineTriggered: true } as any);
    expect(res.struck).toBe(false);
    expect(res.finalText).toBe(note);
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled();
    expect(res.clockVerdict).toMatchObject({ outcome: 'observed', hits: [expect.objectContaining({ token: '9:00 AM PDT', verdict: 'not_observation' })] });
  });

  it('kill switch FUTURE_CLOCK_REPLACE_ENABLED=1: the legacy lane (every hit convicts, the note is REPLACED, the reject-back is armed)', async () => {
    process.env.FUTURE_CLOCK_REPLACE_ENABLED = '1';
    expect(futureClockReplaceEnabled()).toBe(true);
    const res = await guard({ deferConsequences: true });
    expect(res.struck).toBe(true);
    expect(res.delivery).toBeUndefined();
    expect(res.finalText).toContain('--- BEGIN STRUCK NOTE');
    expect(res.rejectBackNotice).toContain('06:06:02Z');
    expect(mockFileFeedbackTicket).not.toHaveBeenCalled(); // deferred to the second pass, as before
    expect(res.clockVerdict).toMatchObject({ outcome: 'replaced', legacy: true });
  });
});
