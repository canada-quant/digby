import {
  noteProviderRejection, providerCooldownUntil, __resetProviderCooldownForTests,
  PROVIDER_COOLDOWN_THRESHOLD, PROVIDER_COOLDOWN_MS, PROVIDER_COOLDOWN_WINDOW_MS,
  PROVIDER_COOLDOWN_MAX_MS, PROVIDER_COOLDOWN_RESET_MS, providerCooldownDurationMs,
} from './provider-cooldown';

const T0 = 1_760_000_000_000;

beforeEach(() => { __resetProviderCooldownForTests(); });

describe('provider cooldown (autonomy loop #3 — the Z.AI 429 storm)', () => {
  it('trips after THRESHOLD rejections inside the window and holds for COOLDOWN_MS', () => {
    for (let i = 0; i < PROVIDER_COOLDOWN_THRESHOLD - 1; i += 1) {
      expect(noteProviderRejection('ZAI direct', T0 + i * 1000).tripped).toBe(false);
      expect(providerCooldownUntil('ZAI direct', T0 + i * 1000)).toBeNull();
    }
    const trip = noteProviderRejection('ZAI direct', T0 + 5000);
    expect(trip).toMatchObject({ tripped: true, strikes: PROVIDER_COOLDOWN_THRESHOLD, until: T0 + 5000 + PROVIDER_COOLDOWN_MS });
    expect(providerCooldownUntil('zai direct', T0 + 6000)).toBe(T0 + 5000 + PROVIDER_COOLDOWN_MS); // key is case-insensitive
    expect(providerCooldownUntil('ZAI direct', T0 + 5000 + PROVIDER_COOLDOWN_MS)).toBeNull(); // expired exactly at the end
  });

  it('adaptive ladder: a re-trip within RESET_MS of the previous cooldown ending doubles the hold (180 → 360 → 720 → 900 s cap); a quiet RESET_MS resets it', () => {
    const trip = (t: number) => { let r: any; for (let i = 0; i < PROVIDER_COOLDOWN_THRESHOLD; i += 1) r = noteProviderRejection('ZAI direct', t); return r; }; // all strikes at t → until = t + duration exactly
    expect(providerCooldownDurationMs(1)).toBe(PROVIDER_COOLDOWN_MS);
    expect(providerCooldownDurationMs(4)).toBe(PROVIDER_COOLDOWN_MAX_MS);
    let t = T0;
    const first = trip(t);
    expect(first).toMatchObject({ tripped: true, consecutive: 1, durationMs: 180_000, until: t + 180_000 });
    t = first.until + 30_000;                     // released 30 s ago, the storm resumes
    const second = trip(t);
    expect(second).toMatchObject({ consecutive: 2, durationMs: 360_000, until: t + 360_000 });
    t = second.until + 30_000;
    const third = trip(t);
    expect(third).toMatchObject({ consecutive: 3, durationMs: 720_000 });
    t = third.until + 30_000;
    expect(trip(t)).toMatchObject({ consecutive: 4, durationMs: PROVIDER_COOLDOWN_MAX_MS });
    // A quiet stretch longer than RESET_MS after the cooldown ended → back to the base hold.
    const quiet = providerCooldownUntil('ZAI direct', t)! + PROVIDER_COOLDOWN_RESET_MS + 1;
    expect(trip(quiet)).toMatchObject({ consecutive: 1, durationMs: PROVIDER_COOLDOWN_MS });
    // Another provider's ladder is its own.
    expect((() => { let r: any; for (let i = 0; i < PROVIDER_COOLDOWN_THRESHOLD; i += 1) r = noteProviderRejection('DeepSeek', quiet); return r; })()).toMatchObject({ consecutive: 1 });
  });

  it('strikes outside the window do not count; a second provider is independent', () => {
    noteProviderRejection('ZAI direct', T0);
    noteProviderRejection('ZAI direct', T0 + 1000);
    // The third strike lands after the window — the first two aged out.
    const r = noteProviderRejection('ZAI direct', T0 + PROVIDER_COOLDOWN_WINDOW_MS + 1000);
    expect(r.tripped).toBe(false);
    expect(r.strikes).toBe(1);
    noteProviderRejection('Moonshot direct', T0);
    expect(providerCooldownUntil('Moonshot direct', T0)).toBeNull();
  });

  it('while a cooldown holds, further rejections do not re-trip or extend it; the window restarts clean afterwards', () => {
    for (let i = 0; i < PROVIDER_COOLDOWN_THRESHOLD; i += 1) noteProviderRejection('ZAI direct', T0 + i);
    const until = providerCooldownUntil('ZAI direct', T0 + 10)!;
    const during = noteProviderRejection('ZAI direct', T0 + 20);
    expect(during).toMatchObject({ tripped: false, until });
    expect(providerCooldownUntil('ZAI direct', T0 + 30)).toBe(until);
    // After it lapses, one rejection is one strike again.
    expect(noteProviderRejection('ZAI direct', until + 1).tripped).toBe(false);
  });
});
