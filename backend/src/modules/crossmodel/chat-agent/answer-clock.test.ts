/**
 * audit 2026-10-08 W1-6 (supervisors F9) — the owner-answer clock header (answer-clock.ts).
 * REPLAY: Schooltime answer b13ea82b written at 18:09:20Z opened "**10:31 AM PDT (17:31Z) — capturing
 * right now**" (copied from a lane message 38 min older).
 */
import { stampAnswerClockHeader, answerClockStampDisabled } from './answer-clock';

const NOW = new Date('2026-10-08T18:09:20Z');
const B13EA82B = '**10:31 AM PDT (17:31Z) — capturing right now**\n\nThe recorder guard unlocks "either camera" starting ~10:25 AM PDT.';

afterEach(() => { delete process.env.OWNER_ANSWER_CLOCK_STAMP_DISABLED; });

describe('stampAnswerClockHeader', () => {
  it('REPLAY b13ea82b: the stale 10:31 AM PDT (17:31Z) header becomes the answer\'s own 11:09 AM PDT (18:09Z); the body is untouched', () => {
    const r = stampAnswerClockHeader(B13EA82B, NOW);
    expect(r.text).toBe('**11:09 AM PDT (18:09Z) — capturing right now**\n\nThe recorder guard unlocks "either camera" starting ~10:25 AM PDT.');
    expect(r.stamped).toEqual({ from: '10:31 AM PDT (17:31Z)', to: '11:09 AM PDT (18:09Z)', driftMin: 38 });
  });
  it('a zone-only header with a status cue is restamped from the zone table', () => {
    expect(stampAnswerClockHeader('**Status as of 9:40 AM PDT** — all lanes idle', NOW).text).toBe('**Status as of 11:09 AM PDT** — all lanes idle');
  });
  it('fresh, future, dated, cue-less, zone-less and mid-body clocks are left alone', () => {
    for (const text of [
      '**11:05 AM PDT (18:05Z) — capturing right now**', // 4 min — fresh
      '**11:55 AM PDT (18:55Z) — next firing**', // ahead of now
      '**Schooltime sweep — 11:06 AM PDT Oct 7 (18:06Z).** Download leg is self-driving', // dated header
      '**9:30 AM PDT:** sign-in check misfired', // no status cue, no Z pair
      '**10:31 AM** — capturing right now', // no zone, no Z: cannot know the clock
      'Summary first.\n**10:31 AM PDT (17:31Z) — capturing right now**', // not the first line
    ]) {
      expect(stampAnswerClockHeader(text, NOW)).toEqual({ text });
    }
  });
  it('crosses midnight in the right direction (23:58Z header at 00:30Z next day is 32 min stale)', () => {
    const r = stampAnswerClockHeader('**4:58 PM PDT (23:58Z) — update**', new Date('2026-10-09T00:30:00Z'));
    expect(r.text).toBe('**5:30 PM PDT (00:30Z) — update**');
    expect(r.stamped?.driftMin).toBe(32);
  });
  it('kill switch OWNER_ANSWER_CLOCK_STAMP_DISABLED=1 leaves the header as written', () => {
    expect(answerClockStampDisabled()).toBe(false);
    process.env.OWNER_ANSWER_CLOCK_STAMP_DISABLED = '1';
    expect(stampAnswerClockHeader(B13EA82B, NOW)).toEqual({ text: B13EA82B });
  });
});
