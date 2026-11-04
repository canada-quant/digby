/**
 * Credential-name near-miss guard — ticket aa6b6da2 replay tests.
 *
 * The incident (2026-10-18, coding lane 1c2b28d6 / run 17dd4dc0): a lane
 * probing its injected AWS credentials read AWS_ACCESS_KEY_ID_DIGIBOPERATOR
 * and AWS_ACCESS_KEY_ID_DIGIBYOPERATOR — two different misspellings of the
 * stored label DIGBYOPERATOR — across ~70 shell invocations, concluded the
 * platform's credential injection was flaky ("empty"), parked an
 * owner-visible workstream blocked-external and filed a platform bug. The
 * injection had never failed: a misspelled env-var name reads as empty and is
 * byte-indistinguishable from a credential that was never injected. These
 * tests replay the EXACT names from the incident transcript (agent_events
 * seqs 26/43/55/71/85/108/118 of run 17dd4dc0) and pin that the guard now
 * flags each one with the correct suggestion.
 */

import {
  editDistanceWithin,
  credentialNearMisses,
  credentialNearMissNotice,
} from './credential-name-guard';

/** The owner's real injected AWS credential names (label DIGBYOPERATOR). */
const CREDS = [
  'AWS_ACCESS_KEY_ID_DIGBYOPERATOR',
  'AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR',
  'CLOUDFLARE_API_TOKEN_CQL',
  'HYPERSTACK_SSH_PRIVATE_KEY',
];

describe('editDistanceWithin (bounded levenshtein)', () => {
  it('distance 0 and 1 within max 2', () => {
    expect(editDistanceWithin('ABC', 'ABC', 2)).toBe(true);
    expect(editDistanceWithin('ABC', 'ABD', 2)).toBe(true);
    expect(editDistanceWithin('ABCD', 'AB', 2)).toBe(true);
  });
  it('distance beyond max rejected, including length gaps', () => {
    expect(editDistanceWithin('ABC', 'XYZ', 2)).toBe(false);
    expect(editDistanceWithin('A', 'ABCDEFG', 2)).toBe(false);
  });
});

describe('credentialNearMisses — incident replay (run 17dd4dc0 names)', () => {
  it('flags DIGIBOPERATOR (d=2 typo, seqs 26/43/55) with the correct suggestion', () => {
    const misses = credentialNearMisses(
      'export AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID_DIGIBOPERATOR" AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY_DIGIBOPERATOR"',
      CREDS,
    );
    const used = misses.map((m) => m.used).sort();
    expect(used).toContain('AWS_ACCESS_KEY_ID_DIGIBOPERATOR');
    expect(used).toContain('AWS_SECRET_ACCESS_KEY_DIGIBOPERATOR');
    const ak = misses.find((m) => m.used === 'AWS_ACCESS_KEY_ID_DIGIBOPERATOR')!;
    expect(ak.suggestions).toContain('AWS_ACCESS_KEY_ID_DIGBYOPERATOR');
  });

  it('flags DIGIBYOPERATOR (d=1 typo, seqs 65–118 + aws-oneshot.py) with the correct suggestion', () => {
    const misses = credentialNearMisses(
      "ak = os.environ.get('AWS_ACCESS_KEY_ID_DIGIBYOPERATOR', '')\nsk = os.environ.get('AWS_SECRET_ACCESS_KEY_DIGIBYOPERATOR', '')",
      CREDS,
    );
    const ak = misses.find((m) => m.used === 'AWS_ACCESS_KEY_ID_DIGIBYOPERATOR');
    const sk = misses.find((m) => m.used === 'AWS_SECRET_ACCESS_KEY_DIGIBYOPERATOR');
    expect(ak?.suggestions).toContain('AWS_ACCESS_KEY_ID_DIGBYOPERATOR');
    expect(sk?.suggestions).toContain('AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR');
  });

  it('the seq-118 mixed command: correct-name SK is NOT flagged, the typo AK IS', () => {
    // Byte-exact shape of agent_events seq 118 (06:12:57Z): AK read via the
    // typo'd name, SK read via the correct name — ak=0 sk=40 was the result.
    const cmd = 'AK="${AWS_ACCESS_KEY_ID_DIGIBOPERATOR:-}"; SK="${AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR:-}"; echo "ak=${#AK} sk=${#SK}"';
    const misses = credentialNearMisses(cmd, CREDS);
    const used = misses.map((m) => m.used);
    expect(used).toContain('AWS_ACCESS_KEY_ID_DIGIBOPERATOR'); // the typo flagged
    expect(used).not.toContain('AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR'); // correct name: not flagged
  });

  it('the UNSUFFIXED base name (AWS_ACCESS_KEY_ID) is flagged as a prefix of the injected name', () => {
    // The other incident shape: exporting the unsuffixed var from a suffixed
    // credential silently exports empty.
    const misses = credentialNearMisses('export AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"', CREDS);
    const m = misses.find((x) => x.used === 'AWS_ACCESS_KEY_ID');
    expect(m?.suggestions).toContain('AWS_ACCESS_KEY_ID_DIGBYOPERATOR');
  });

  it('REVIEWER F3 — the documented REMEDIATION shape (base name wired FROM the suffixed name) is NOT flagged', () => {
    // The learnings-bullet shape before run-on-box.sh — referencing BOTH the
    // standard CLI name and the suffixed injected name is deliberate wiring:
    //   export AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID_DIGBYOPERATOR" …
    // The prefix arm must suppress when the command also references the
    // suffixed name it wires FROM (a false positive here would flag the
    // project's own documented remediation as a miss).
    const cmd = 'export AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID_DIGBYOPERATOR" AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY_DIGBYOPERATOR" AWS_REGION=ca-central-1';
    expect(credentialNearMisses(cmd, CREDS)).toHaveLength(0);
  });

  it('REVIEWER F3b — inline standard CLI names WITHOUT the suffixed reference still flag (the original incident shape)', () => {
    // aws_access_key_id=x set inline, never wired from the injected name —
    // this IS the miss (exports a stale/empty value and hides it).
    const misses = credentialNearMisses('AWS_ACCESS_KEY_ID=AKIAFAKE AWS_SECRET_ACCESS_KEY=fake aws sts get-caller-identity', CREDS);
    const used = misses.map((m) => m.used);
    expect(used).toContain('AWS_ACCESS_KEY_ID');
    expect(used).toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('exact injected names produce NO misses (no false positives on correct usage)', () => {
    const cmd = 'printf "%s" "${AWS_ACCESS_KEY_ID_DIGBYOPERATOR:+set}" | wc -c; aws sts get-caller-identity';
    expect(credentialNearMisses(cmd, CREDS)).toHaveLength(0);
  });

  it('unrelated UPPER_SNAKE tokens are not flagged', () => {
    const cmd = 'DATABASE_URL=x NODE_ENV=test AWS_REGION=us-west-2 PATH=/usr/bin printenv SOME_LONG_NAME';
    expect(credentialNearMisses(cmd, CREDS)).toHaveLength(0);
  });

  it('empty / no credentials ⇒ inert', () => {
    expect(credentialNearMisses('AWS_ACCESS_KEY_ID_DIGIBOPERATOR', [])).toHaveLength(0);
    expect(credentialNearMisses('', CREDS)).toHaveLength(0);
  });

  it('dedupes a name repeated many times in one command (bounded work)', () => {
    const cmd = Array.from({ length: 50 }, () => 'echo $AWS_ACCESS_KEY_ID_DIGIBYOPERATOR').join(' && ');
    const misses = credentialNearMisses(cmd, CREDS);
    expect(misses.filter((m) => m.used === 'AWS_ACCESS_KEY_ID_DIGIBYOPERATOR')).toHaveLength(1);
  });
});

describe('credentialNearMissNotice', () => {
  it('renders the used name, the suggestion, and never a value', () => {
    const misses = credentialNearMisses('echo ${AWS_ACCESS_KEY_ID_DIGIBYOPERATOR:-}', CREDS);
    const notice = credentialNearMissNotice(misses);
    expect(notice).toContain('[credential name notice]');
    expect(notice).toContain('"AWS_ACCESS_KEY_ID_DIGIBYOPERATOR"');
    expect(notice).toContain('"AWS_ACCESS_KEY_ID_DIGBYOPERATOR"');
    expect(notice).toMatch(/reads as EMPTY|reads as empty/i);
    expect(notice).not.toMatch(/AKIA|h1WB/); // never a value fragment
  });
  it('empty input renders nothing', () => {
    expect(credentialNearMissNotice([])).toBe('');
  });
});
