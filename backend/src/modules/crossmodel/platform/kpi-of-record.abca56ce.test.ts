/**
 * Ticket abca56ce — pure KPI re-announcement helpers (platform/kpi-of-record.ts).
 *
 * The specimen replay: Schooltime announced "MET" at 103.9 (02:00), 162.9
 * (05:18, Telegram) and 113.4 (08:56) — three pushes, ONE of-record state.
 * These pins fix the pure half: what counts as ANNOUNCING a KPI (anchored on
 * the register, never the typed number) and what counts as a REPEAT (state
 * flip or >threshold move is news).
 */

import {
  kpiAnnouncedBy, kpiAnnouncementIsRepeat, kpiAnnounceStateOf, kpiNameWords,
} from './kpi-of-record';

const SCHOOLTIME = {
  key: 'kpi:schooltime_verified_clips_per_hour',
  value: 103.9,
  unit: ' clips/hr',
  bar: 100,
  history: [{ value: 90 }],
};

describe('kpiNameWords — distinctive identity words of a KPI key', () => {
  it('drops structural rate words, short tokens and the UNIT\'s own tokens; keeps the identity', () => {
    expect(kpiNameWords('kpi:schooltime_verified_clips_per_hour', ' clips/hr')).toEqual(['schooltime', 'verified']); // "clips" is the unit — structural
    expect(kpiNameWords('kpi:schooltime_verified_clips_per_hour')).toEqual(['schooltime', 'verified', 'clips']); // without the unit, clips is identity
    // Every token is a stopword → no identity words (unit-alone pushes are
    // then never announcements — see kpiAnnouncedBy).
    expect(kpiNameWords('kpi:rate_per_hour', ' clips/hr')).toEqual([]);
    expect(kpiNameWords('kpi:serving_rate_tok_s', ' tok/s')).toEqual(['serving']);
  });
});

describe('kpiAnnouncedBy — does a push ANNOUNCE this KPI?', () => {
  it('the three specimen pushes all announce (key word + unit rate), whatever number was typed', () => {
    expect(kpiAnnouncedBy('Schooltime verified clips MET at 103.9 clips/hr.', SCHOOLTIME)).toBe(true); // 02:00
    expect(kpiAnnouncedBy('The schooltime rate is up: 162.9 clips/hr, MET.', SCHOOLTIME)).toBe(true); // 05:18 Telegram
    expect(kpiAnnouncedBy('schooltime clips/hr holding at 113.4 — bar met.', SCHOOLTIME)).toBe(true); // 08:56
  });

  it('a key cite announces with no name word; the bare register figure WITHOUT identity does NOT (review F2: "CPU saturated at 100%" is not a KPI announcement)', () => {
    expect(kpiAnnouncedBy('KPI kpi:schooltime_verified_clips_per_hour moved.', SCHOOLTIME)).toBe(true);
    expect(kpiAnnouncedBy('kpi:schooltime_verified_clips_per_hour is at 103.9.', SCHOOLTIME)).toBe(true);
    // The register figure alone, no identity word — a neighbour's sentence can
    // quote the same number in the same unit ("saturated at 100%"): NOT ours.
    expect(kpiAnnouncedBy('Rate holding at 103.9 clips/hr.', SCHOOLTIME)).toBe(false);
    // Identity word + the register figure → announces.
    expect(kpiAnnouncedBy('Schooltime holding at 103.9 clips/hr.', SCHOOLTIME)).toBe(true);
  });

  it('a rate in the same UNIT from a different KPI does NOT announce (unit alone is not identity)', () => {
    expect(kpiAnnouncedBy('Spark bench hit 101.2 clips/hr today.', SCHOOLTIME)).toBe(false);
    expect(kpiAnnouncedBy('QB2 reached 42.7 tok/s — new best.', SCHOOLTIME)).toBe(false);
    expect(kpiAnnouncedBy('All lanes green; nothing to report.', SCHOOLTIME)).toBe(false);
  });
});

describe('kpiAnnouncementIsRepeat — one push per KPI state change', () => {
  it('unchanged state, value within threshold → repeat (refused)', () => {
    const last = kpiAnnounceStateOf(SCHOOLTIME, 1_000);
    // Specimen: typed 162.9 and 113.4, register still 103.9 MET — repeats.
    expect(kpiAnnouncementIsRepeat(last, { value: 103.9, met: true })).toBe(true);
    expect(kpiAnnouncementIsRepeat(last, { value: 104.5, met: true })).toBe(true); // +0.6%
  });

  it('state flip or >threshold move → news (re-push allowed)', () => {
    const last = kpiAnnounceStateOf(SCHOOLTIME, 1_000);
    expect(kpiAnnouncementIsRepeat(last, { value: 103.9, met: false })).toBe(false); // bar flip
    expect(kpiAnnouncementIsRepeat(last, { value: 120, met: true })).toBe(false);   // +15.5%
    // Exactly-at-threshold counts as a repeat (no news at the boundary).
    expect(kpiAnnouncementIsRepeat(last, { value: 103.9 + 10.39, met: true })).toBe(true);
    // Non-finite inputs fail OPEN (never refuse on garbage).
    expect(kpiAnnouncementIsRepeat({ value: NaN, met: true, at: 1 }, { value: 100, met: true })).toBe(false);
  });

  it('the threshold is caller-tunable', () => {
    const last = kpiAnnounceStateOf(SCHOOLTIME, 1_000);
    expect(kpiAnnouncementIsRepeat(last, { value: 115, met: true }, 0.10)).toBe(false); // +10.7% > 10%
    expect(kpiAnnouncementIsRepeat(last, { value: 115, met: true }, 0.20)).toBe(true);  // inside 20%
  });
});
