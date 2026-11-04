/**
 * Session title halves (session titles + topology, 2026-09-27): the client
 * twin of the backend splitter — the LAST " · " separates goal and step; a
 * title without one is all goal. receiptAgeLabel renders m / h / d.
 */
import { describe, it, expect } from 'vitest';
import { splitSessionTitle, receiptAgeLabel, SESSION_TITLE_SEP } from './session-title';

describe('splitSessionTitle', () => {
  it('splits on the last " · " and trims; no separator ⇒ goal only', () => {
    expect(SESSION_TITLE_SEP).toBe(' · ');
    expect(splitSessionTitle('H2H bench S3+S5 · PR #712 opened')).toEqual({ goal: 'H2H bench S3+S5', step: 'PR #712 opened' });
    expect(splitSessionTitle('CanLaw · SFT · steering SFT-2 smoke')).toEqual({ goal: 'CanLaw · SFT', step: 'steering SFT-2 smoke' });
    expect(splitSessionTitle('Only goal')).toEqual({ goal: 'Only goal', step: null });
    expect(splitSessionTitle(' · orphan')).toEqual({ goal: '· orphan', step: null });
    expect(splitSessionTitle(null)).toEqual({ goal: '', step: null });
  });
});

describe('receiptAgeLabel', () => {
  it('m under an hour, h under two days, d after; null ⇒ —', () => {
    expect(receiptAgeLabel(null)).toBe('—');
    expect(receiptAgeLabel(90)).toBe('2 m');
    expect(receiptAgeLabel(3 * 3600)).toBe('3 h');
    expect(receiptAgeLabel(5 * 86400)).toBe('5 d');
  });
});
