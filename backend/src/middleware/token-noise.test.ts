import { expiredTokenNoise, EXPIRED_TOKEN_WINDOW_MS, tokenFingerprint, __resetTokenNoiseForTest } from './token-noise';

describe('expiredTokenNoise (loop #19)', () => {
  beforeEach(() => __resetTokenNoiseForTest());
  it('first sighting logs; repeats inside the window do not and count up; a new window logs again carrying the previous count', () => {
    const t0 = 1_700_000_000_000;
    expect(expiredTokenNoise('tok', t0)).toMatchObject({ log: true, repeats: 0 });
    expect(expiredTokenNoise('tok', t0 + 1_000)).toMatchObject({ log: false, repeats: 1 });
    expect(expiredTokenNoise('tok', t0 + 2_000)).toMatchObject({ log: false, repeats: 2 });
    expect(expiredTokenNoise('tok', t0 + EXPIRED_TOKEN_WINDOW_MS + 1)).toMatchObject({ log: true, repeats: 3 });
    expect(expiredTokenNoise('other', t0)).toMatchObject({ log: true, repeats: 0 });
  });
  it('fingerprints never expose the token (16 hex chars of sha256)', () => {
    const fp = tokenFingerprint('eyJhbGciOi.secret.sig');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).not.toContain('secret');
  });
});
