import { markRetiring, isRetiring, retiringSinceIso, __resetRetiringForTests } from './retiring';

describe('retiring colour flag (deploy-replay tax, 2026-09-18)', () => {
  afterEach(() => __resetRetiringForTests());

  it('starts not retiring; markRetiring flips it and is idempotent (first time sticks)', () => {
    expect(isRetiring()).toBe(false);
    expect(retiringSinceIso()).toBeNull();
    const t1 = new Date('2026-09-18T18:16:27.000Z');
    expect(markRetiring(t1)).toBe(t1);
    expect(isRetiring()).toBe(true);
    expect(retiringSinceIso()).toBe('2026-09-18T18:16:27.000Z');
    expect(markRetiring(new Date('2026-09-18T18:20:00.000Z'))).toBe(t1);
    expect(retiringSinceIso()).toBe('2026-09-18T18:16:27.000Z');
  });
});
