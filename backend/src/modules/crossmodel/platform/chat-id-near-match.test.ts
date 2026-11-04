import { hammingDistance, isFullChatIdShape, nearMatchChatId, NEAR_MATCH_MAX_DISTANCE } from './chat-id-near-match';

const REAL = '615723ba-2bcc-4964-baa4-4759616e8fc5';
const TYPO = '615723ba-2bcd-4964-baa4-4759616e8fc5'; // the 2026-09-18 card: one hex char off
const OTHER = '615723ba-9999-4964-baa4-4759616e8fc5';

describe('near-miss chat ids (owner 2026-09-18: machine-to-machine sends must not card on a typo)', () => {
  it('recognises the full uuid shape only', () => {
    expect(isFullChatIdShape(REAL)).toBe(true);
    expect(isFullChatIdShape(REAL.toUpperCase())).toBe(true);
    expect(isFullChatIdShape('615723ba')).toBe(false);
    expect(isFullChatIdShape('615723ba-2bcc-4964-baa4-4759616e8fc5x')).toBe(false);
    expect(isFullChatIdShape(null)).toBe(false);
  });

  it('hamming distance counts differing positions; unequal lengths are -1', () => {
    expect(hammingDistance(REAL, REAL)).toBe(0);
    expect(hammingDistance(REAL, TYPO)).toBe(1);
    expect(hammingDistance(REAL, REAL.slice(0, 35))).toBe(-1);
    expect(NEAR_MATCH_MAX_DISTANCE).toBe(2);
  });

  it('resolves the one same-prefix candidate within two characters; exact wins outright', () => {
    const rows = [{ id: REAL, title: 'sup' }, { id: OTHER, title: 'other' }];
    expect(nearMatchChatId(rows, TYPO)).toEqual(rows[0]);
    expect(nearMatchChatId(rows, TYPO.toUpperCase())).toEqual(rows[0]);
    expect(nearMatchChatId(rows, REAL)).toEqual(rows[0]);
    // Two characters off still resolves; three does not.
    expect(nearMatchChatId(rows, '615723ba-2bdd-4964-baa4-4759616e8fc5')).toEqual(rows[0]);
    expect(nearMatchChatId(rows, '615723ba-2bdd-4964-baa4-4759616e8fc6')).toBeNull();
  });

  it('fails closed on ambiguity, on no candidates, and on an empty id', () => {
    const twins = [{ id: REAL }, { id: '615723ba-2bce-4964-baa4-4759616e8fc5' }];
    expect(nearMatchChatId(twins, TYPO)).toBeNull(); // both one char from the typo
    expect(nearMatchChatId([], TYPO)).toBeNull();
    expect(nearMatchChatId([{ id: REAL }], '')).toBeNull();
  });
});
