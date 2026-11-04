/**
 * profile-guard.test.ts — unit pins for the 2026-10-20 profile-extraction guard (bounds + per-user
 * throttle). The end-to-end regression (the real pipeline, a budget-cut model) is
 * langgraph/profile-extraction-guard.test.ts.
 */
import {
  PROFILE_FIELD_CAPS,
  PROFILE_EXTRACT_COOLDOWN_MS,
  PROFILE_EXTRACT_FAILURE_BACKOFF_MS,
  PROFILE_EXTRACT_IN_FLIGHT_MAX_MS,
  clampProfileText,
  clampUserContextState,
  boundedProfileFieldsInstruction,
  claimProfileExtraction,
  settleProfileExtraction,
  resetProfileExtractionThrottle,
  profileFieldCapsEnabled,
} from './profile-guard';

let clock = 1_000_000;
beforeEach(() => {
  resetProfileExtractionThrottle();
  delete process.env.PROFILE_EXTRACT_THROTTLE_DISABLED;
  delete process.env.PROFILE_FIELD_CAPS_DISABLED;
  jest.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => jest.restoreAllMocks());

describe('clampProfileText', () => {
  it('returns text within the cap untouched (no whitespace normalisation — an unchanged field must not read as a change)', () => {
    expect(clampProfileText('  short\n value ', 50)).toBe('  short\n value ');
  });

  it('non-strings become empty', () => {
    expect(clampProfileText(undefined, 10)).toBe('');
    expect(clampProfileText(42, 10)).toBe('');
  });

  it('cuts at the last sentence end in the final 40 % (no ellipsis — the cut is clean)', () => {
    const text = `${'a'.repeat(70)}. ${'b'.repeat(60)}`;
    const out = clampProfileText(text, 100);
    expect(out).toBe(`${'a'.repeat(70)}.`);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('otherwise cuts at the last word boundary and marks it with …', () => {
    const out = clampProfileText('word '.repeat(40), 50);
    expect(out.endsWith('word…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  it('a single unbroken token is hard-cut within the cap', () => {
    const out = clampProfileText('x'.repeat(500), 50);
    expect(out).toBe(`${'x'.repeat(49)}…`);
  });
});

describe('clampUserContextState', () => {
  const big = {
    summary: 'User is a researcher in Calgary. '.repeat(40),
    preferences: 'p '.repeat(400),
    currentFocus: 'f '.repeat(200),
    recentTopics: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 't'.repeat(200)],
    communicationStyle: 's '.repeat(300),
  };

  it('bounds every field and names the ones it cut', () => {
    const { profile, clampedFields } = clampUserContextState(big);
    expect(profile.summary.length).toBeLessThanOrEqual(PROFILE_FIELD_CAPS.summary);
    expect(profile.preferences.length).toBeLessThanOrEqual(PROFILE_FIELD_CAPS.preferences);
    expect(profile.currentFocus.length).toBeLessThanOrEqual(PROFILE_FIELD_CAPS.currentFocus);
    expect(profile.communicationStyle.length).toBeLessThanOrEqual(PROFILE_FIELD_CAPS.communicationStyle);
    expect(profile.recentTopics).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(clampedFields.sort()).toEqual(['communicationStyle', 'currentFocus', 'preferences', 'recentTopics', 'summary']);
  });

  it('the bounded profile echoed as pretty JSON fits well inside the 1800-token budget', () => {
    const { profile } = clampUserContextState(big);
    // ≤ 4 chars per token of English: the whole echo is a fraction of 1800 × 4 chars.
    expect(JSON.stringify(profile, null, 2).length).toBeLessThan(1800 * 4 * 0.4);
  });

  it('a profile within the caps comes back equal, with nothing clamped', () => {
    const small = { summary: 's', preferences: 'p', currentFocus: '', recentTopics: ['x'], communicationStyle: 'c' };
    expect(clampUserContextState(small)).toEqual({ profile: small, clampedFields: [] });
  });

  it('drops keys outside the five rendered fields (an invented key would be echoed every call) and tolerates junk', () => {
    const { profile } = clampUserContextState({ summary: 's', notes: 'x'.repeat(9000), recentTopics: 'nope' } as any);
    expect(profile).toEqual({ summary: 's', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '' });
  });

  it('the prompt instruction carries the same numbers as the caps', () => {
    const line = boundedProfileFieldsInstruction();
    expect(line).toContain(`at most ${PROFILE_FIELD_CAPS.summary} characters`);
    expect(line).toContain(`at most ${PROFILE_FIELD_CAPS.preferences} characters`);
    expect(line).toContain(`at most ${PROFILE_FIELD_CAPS.topics} short phrases`);
  });

  it('PROFILE_FIELD_CAPS_DISABLED=1 turns the bounds off', () => {
    expect(profileFieldCapsEnabled()).toBe(true);
    process.env.PROFILE_FIELD_CAPS_DISABLED = '1';
    expect(profileFieldCapsEnabled()).toBe(false);
  });
});

describe('per-user profile throttle', () => {
  it('one claim in flight per user; other users are independent', () => {
    expect(claimProfileExtraction('u1')).toEqual({ run: true, skippedSinceLast: 0 });
    expect(claimProfileExtraction('u1')).toEqual({ run: false, retryInMs: PROFILE_EXTRACT_IN_FLIGHT_MAX_MS });
    expect(claimProfileExtraction('u2').run).toBe(true);
  });

  it('a parsed answer starts the cooldown; the next run reports the skips', () => {
    claimProfileExtraction('u1');
    claimProfileExtraction('u1'); // skipped while in flight
    settleProfileExtraction('u1', 'changed');
    clock += PROFILE_EXTRACT_COOLDOWN_MS - 1;
    expect(claimProfileExtraction('u1').run).toBe(false); // skipped in the cooldown
    clock += 1;
    expect(claimProfileExtraction('u1')).toEqual({ run: true, skippedSinceLast: 2 });
  });

  it('a failure backs off for the longer window', () => {
    claimProfileExtraction('u1');
    settleProfileExtraction('u1', 'parse_error');
    clock += PROFILE_EXTRACT_COOLDOWN_MS;
    expect(claimProfileExtraction('u1').run).toBe(false);
    clock += PROFILE_EXTRACT_FAILURE_BACKOFF_MS;
    expect(claimProfileExtraction('u1').run).toBe(true);
  });

  it('an unsettled claim (a crash mid-call) frees itself', () => {
    claimProfileExtraction('u1');
    clock += PROFILE_EXTRACT_IN_FLIGHT_MAX_MS;
    expect(claimProfileExtraction('u1').run).toBe(true);
  });

  it('bypass (an explicit rejection) runs through a held claim', () => {
    claimProfileExtraction('u1');
    expect(claimProfileExtraction('u1', { bypass: true }).run).toBe(true);
  });

  it('PROFILE_EXTRACT_THROTTLE_DISABLED=1: every claim runs and nothing is recorded', () => {
    process.env.PROFILE_EXTRACT_THROTTLE_DISABLED = '1';
    claimProfileExtraction('u1');
    settleProfileExtraction('u1', 'parse_error');
    expect(claimProfileExtraction('u1')).toEqual({ run: true, skippedSinceLast: 0 });
    delete process.env.PROFILE_EXTRACT_THROTTLE_DISABLED;
    expect(claimProfileExtraction('u1').run).toBe(true); // nothing was held while it was off
  });

  it('the table stays bounded: a full table of live claims drops the oldest, never refuses a new user', () => {
    for (let i = 0; i < 10_000; i++) claimProfileExtraction(`u${i}`);
    expect(claimProfileExtraction('newcomer').run).toBe(true);
    expect(claimProfileExtraction('u0').run).toBe(true); // the oldest live claim was evicted
  });
});
