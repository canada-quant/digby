/**
 * MIND-HYGIENE (2026-10-20) — the wake block's refutation TTL.
 *
 * Prod: the Fleet Supervisor's doc held six refutations from 2026-09-01 (49
 * days old) that took 1,919 of its 5,834 state chars on every wake. Pins:
 *  - refutationAtMs / refutationClass parse what appendVerifierRefutation writes;
 *  - only refutations from the last 7 days render, plus ONE 30-day class tally
 *    line naming how many lines are hidden and where to read them;
 *  - nothing hidden ⇒ no tally line; nothing in 30 d ⇒ a one-line pointer;
 *  - on overflow, refutations older than 24 h are trimmed BEFORE notes, a
 *    fresher one is not (notes truncate first, as before);
 *  - SUPERVISOR_REFUTATION_TTL_DISABLED=1 restores every line and the old order.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { supervisorState: { findUnique: jest.fn(), upsert: jest.fn() }, crossModelChat: { findUnique: jest.fn() } },
}));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import {
  formatStateForWake,
  refutationAtMs,
  refutationClass,
  refutationTallyLine,
  refutationTtlDisabled,
  REFUTATION_RENDER_TTL_MS,
  VERIFIER_REFUTATION_PREFIX,
  type SupervisorStateDoc,
} from './supervisor-state.service';

const NOW = new Date('2026-10-20T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ref = (ageMs: number, detail: string) =>
  `${VERIFIER_REFUTATION_PREFIX} (${new Date(NOW.getTime() - ageMs).toISOString()}) ${detail} — it did NOT execute (no matching tool result in that run's log).`;
const doc = (over: Partial<SupervisorStateDoc> = {}): SupervisorStateDoc =>
  ({ directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: '', ...over });

afterEach(() => { delete process.env.SUPERVISOR_REFUTATION_TTL_DISABLED; });

describe('refutation line parsing', () => {
  it('refutationAtMs reads the ISO stamp appendVerifierRefutation writes; null on a malformed line', () => {
    expect(refutationAtMs(ref(2 * HOUR, 'x'))).toBe(NOW.getTime() - 2 * HOUR);
    expect(refutationAtMs('VERIFIER REFUTED (not a date) x')).toBeNull();
    expect(refutationAtMs('a plain line')).toBeNull();
  });

  it('refutationClass is the leading [tag] (lowercased; tool args folded), else "action claim"', () => {
    expect(refutationClass(ref(1, '[evidence citation] msg 1234abcd cited'))).toBe('evidence citation');
    expect(refutationClass(ref(1, '[in send_chat_message args] [evidence citation] x'))).toBe('in tool args');
    expect(refutationClass(ref(1, 'claimed a schedule that does not exist'))).toBe('action claim');
  });

  it('the kill switch reads 1 / true / on', () => {
    expect(refutationTtlDisabled({})).toBe(false);
    expect(refutationTtlDisabled({ SUPERVISOR_REFUTATION_TTL_DISABLED: '1' })).toBe(true);
    expect(refutationTtlDisabled({ SUPERVISOR_REFUTATION_TTL_DISABLED: 'on' })).toBe(true);
  });
});

describe('formatStateForWake — refutation TTL + tally', () => {
  it('49-day-old refutations collapse to ONE pointer line (the prod shape: 1,919 chars → one line)', () => {
    const old = Array.from({ length: 6 }, (_, i) => ref(49 * DAY + i * HOUR, `[evidence citation] ${'old conviction detail '.repeat(12)} #${i}`));
    const on = formatStateForWake(doc({ refutations: old }), NOW);
    expect(on).toContain('VERIFIER REFUTATIONS');
    expect(on).not.toContain('old conviction detail');
    expect(on).toMatch(/6 refutation line\(s\) older than 30 d not shown — get_supervisor_state\(\{section:'refutations'\}\)/);
    process.env.SUPERVISOR_REFUTATION_TTL_DISABLED = '1';
    const off = formatStateForWake(doc({ refutations: old }), NOW);
    expect(off).toContain('old conviction detail');
    expect(off.length - on.length).toBeGreaterThan(1500);
  });

  it('renders the last 7 days; older lines inside 30 d become the class tally (counts by class + hidden count)', () => {
    const lines = [
      ref(2 * HOUR, '[evidence citation] fresh one'),
      ref(3 * DAY, 'claimed a send that never ran'),
      ref(10 * DAY, '[evidence citation] ten days old'),
      ref(20 * DAY, '[vanished artifact] twenty days old'),
      ref(45 * DAY, '[evidence citation] forty-five days old'),
    ];
    const block = formatStateForWake(doc({ refutations: lines }), NOW);
    expect(block).toContain('fresh one');
    expect(block).toContain('claimed a send that never ran');
    expect(block).not.toContain('ten days old');
    expect(block).not.toContain('twenty days old');
    expect(block).not.toContain('forty-five days old');
    expect(block).toMatch(/refutations in the last 30 d: 4 — evidence citation ×2, action claim ×1, vanished artifact ×1; 3 line\(s\) older than 7 d or trimmed for space not shown/);
  });

  it('nothing hidden ⇒ no tally line; an all-recent list at the doc cap reads "N+"', () => {
    const recent = [ref(HOUR, 'a'), ref(2 * HOUR, 'b')];
    expect(formatStateForWake(doc({ refutations: recent }), NOW)).not.toContain('refutations in the last');
    const ten = Array.from({ length: 10 }, (_, i) => ref((8 + i) * DAY, `[evidence citation] r${i}`));
    expect(refutationTallyLine(ten, NOW, 10)).toContain('refutations in the last 30 d: 10+');
  });

  it('overflow: refutations older than 24 h are trimmed BEFORE notes (the notes stay whole)', () => {
    const notes = 'N'.repeat(3000);
    const refs = Array.from({ length: 5 }, (_, i) => ref((2 + i) * DAY, `[evidence citation] #${i} ${'r'.repeat(250)}`));
    const directives = Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, text: 'x'.repeat(300), at: new Date(NOW.getTime() - HOUR).toISOString(), status: 'open' as const }));
    const block = formatStateForWake(doc({ notes, refutations: refs, directives }), NOW);
    expect(block.length).toBeLessThanOrEqual(6000);
    expect(block).toContain(notes); // not truncated
    expect(block).not.toContain('…[truncated]');
    expect(block).toMatch(/line\(s\) older than 7 d or trimmed for space not shown/);
    // the old order (switch on) truncates the notes instead
    process.env.SUPERVISOR_REFUTATION_TTL_DISABLED = '1';
    const legacy = formatStateForWake(doc({ notes, refutations: refs, directives }), NOW);
    expect(legacy).toContain('…[truncated]');
  });

  it('a refutation from the last 24 h is NOT trimmed before notes (notes truncate first, as before)', () => {
    const notes = 'N'.repeat(3000);
    const refs = Array.from({ length: 5 }, (_, i) => ref((i + 1) * HOUR, `[evidence citation] #${i} ${'r'.repeat(250)}`));
    const directives = Array.from({ length: 4 }, (_, i) => ({ id: `d${i}`, text: 'x'.repeat(300), at: new Date(NOW.getTime() - HOUR).toISOString(), status: 'open' as const }));
    const block = formatStateForWake(doc({ notes, refutations: refs, directives }), NOW);
    expect(block.length).toBeLessThanOrEqual(6000);
    for (let i = 0; i < 5; i++) expect(block).toContain(`#${i}`);
    expect(block).toContain('…[truncated]');
  });

  it('the TTL window is 7 days', () => {
    expect(REFUTATION_RENDER_TTL_MS).toBe(7 * DAY);
  });
});
