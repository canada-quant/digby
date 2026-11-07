/**
 * REPLAY TEST — log-signal family d7a1ad46, members 9ffb9f8c + 9289d163, and
 * the VERIFY-ONLY member 67558dd0 (2026-11-07, family lane 39ecd1b9).
 *
 * Three members, three different dispositions, ONE concern: the autofiler was
 * stamping volume bars on classes whose rate no code change can bound.
 *
 *   9ffb9f8c  action-verifier PRE-DELIVERY strike  → designed, guard working
 *   9289d163  cloud browser CDP unavailable        → designed, owner-side fix
 *   67558dd0  web-search PDF fetch/extract failed   → ALREADY adjudicated on
 *             origin/main as `websearch-pdf-fetch-target`; this member is a
 *             VERIFY-ONLY close (no new signature, do not duplicate it).
 *
 * ── 9ffb9f8c ────────────────────────────────────────────────────────────────
 * The warn is the fabrication guard CONVICTING a phantom claim in a supervisor
 * note before delivery, observe-only by design: nothing is removed, the note is
 * delivered as written, and prior lanes already ruled it designed twice —
 * 82029969 (citation class) and 91fb1905 (the same site under
 * BRIEFING-UNVERIFIED-FILTER); log-signal-family.30dfad06.pin.test.ts:55-61
 * re-asserts member 18d83feb for this exact emit site. Every residual row is the
 * detector doing its job, so a bar on it would punish the guard for working.
 *
 * ITS DERIVED FRAGMENT IS ALSO FRAGILE, MEASURED: `stableLiteralFragment`
 * returns the 32-char string `'s note; the note was delivered as writ'`, which
 * starts MID-WORD — the digit-folded supervisor id (<n>) split the preceding
 * literal run, so the fragment is a slice of prose, not a class identifier.
 * That is recorded here because it is the sharpest argument that this class must
 * carry no volume bar: the bar would count a meaningless substring.
 *
 * ── 9289d163 ────────────────────────────────────────────────────────────────
 * cloud-driver.ts:14-21 states the posture and the remedy in the source itself:
 * the zone returns 407 ip_forbidden because the prod server's IP is not on the
 * BrightData allowlist, the driver drops to read-only scrape mode, and "The
 * instant the zone is allowlisted, navigate connects and the real browser is
 * used — no code change." The emit sits under `mode === 'unknown'` where `mode`
 * is only ever assigned 'cdp' or 'scrape', so it fires AT MOST ONCE per driver
 * instance — 10 rows / 6 hours is ~10 browser sessions, never a retry storm.
 *
 * ── 67558dd0 (verify only) ─────────────────────────────────────────────────
 * The `websearch-pdf-fetch-target` signature shipped on origin/main via
 * #2614/#2619/#2624 and is proven by
 * feedback/log-signal-pdf-fetch.68200428.test.ts:115-121 (SPECIMEN: the ticket's
 * newest 403 row no longer stamps a volume default). This file only re-asserts
 * that the signature still fires so a future edit to the registry cannot quietly
 * drop it — it adds NO second signature for the PDF class.
 */
import {
  AUTOFILER_DEFAULT_METRIC_SOURCE as AUTOFILER,
  designedAlarmOfMetric,
  designedObservabilityOfFingerprint,
  logSignalDefaultMetric,
} from './acceptance-metric-defaults';

// ── 9ffb9f8c ────────────────────────────────────────────────────────────────

const PRE_FINGERPRINT =
  "action-verifier: pre-delivery strike — <n> phantom claim(s) in supervisor daee<n>'s note; "
  + 'the note was delivered as writ';

const PRE_LIVE_ROW =
  "action-verifier: PRE-DELIVERY strike — 1 phantom claim(s) in supervisor daee2916's note; "
  + 'the note was delivered AS WRITTEN (observe-only — the seam will not enforce this verdict; '
  + 'nothing is removed, and its id-less action claims that locate in the note and cite no action '
  + 'receipt of this chat may get a trailing footnote at finalize — BRIEFING-UNVERIFIED-FILTER)';

/** The measured fragment — starts mid-word, on purpose (see header). Note there
 *  is NO leading apostrophe: the literal run begins after the `'` that followed
 *  the digit-folded supervisor id. */
const PRE_DERIVED_FRAGMENT = 's note; the note was delivered as writ';

/** The DROP-GUARD sibling (ticket e35f9985): a DIFFERENT emit site. Its own
 *  predicate requires `llm-extracted … claim(s)` AND `narrating third-party
 *  lane status`, so the fixture carries both arms. */
const DROP_GUARD_FINGERPRINT =
  'action-verifier: dropped <n> llm-extracted note claim(s) narrating third-party lane status';
const DROP_GUARD_FRAGMENT = 'llm-extracted note claim(s) narrating third-party';

// ── 9289d163 ────────────────────────────────────────────────────────────────

const CDP_FINGERPRINT =
  'cloudbrowserdriver: brightdata scraping browser cdp unavailable (ip_forbidden?) → read-only scrape mode';

// ── 67558dd0 (already adjudicated on main — verify, do not rebuild) ────────

const PDF_FINGERPRINT =
  'digby web search: pdf fetch/extract failed for "https://www.asbca.mil/portals/<n>/decisions/<n>/<n>-v<n>-<n>": request f';
const PDF_LIVE_ROW =
  'Digby Web Search: PDF fetch/extract failed for "https://www.asbca.mil/Portals/143/Decisions/2010/89836-v1-56": '
  + 'Request failed with status code 403';

describe('9ffb9f8c — the action-verifier PRE-DELIVERY strike is the guard working', () => {
  it('matches on the fingerprint surface (what stops the bar being stamped)', () => {
    expect(designedObservabilityOfFingerprint(PRE_FINGERPRINT)?.id).toBe('action-verifier-predelivery-strike');
  });

  it('matches on the METRIC surface too, whose fragment starts mid-word', () => {
    const metric = logSignalDefaultMetric({
      fingerprint: PRE_FINGERPRINT,
      levels: ['warn'],
      sources: ['action-verifier'],
      exampleMessage: PRE_LIVE_ROW,
    });
    expect(metric).not.toBeNull();
    // The measured fragment — pinning it is the point: it is not a class id at
    // all, it is a slice of prose that happens to survive the literal-run cut.
    expect(String(metric?.params?.messagePattern)).toBe(PRE_DERIVED_FRAGMENT);
    const ruling = designedAlarmOfMetric(metric!, AUTOFILER);
    expect(ruling?.id).toBe('action-verifier-predelivery-strike');
    expect(ruling?.class).toBe('designed-observability');
  });

  it('does NOT swallow the drop-guard sibling (e35f9985)', () => {
    // The sibling keeps its OWN signature, and — because the registry resolves
    // first-match and the drop guard is registered before this one — its
    // message must resolve to its own id, never to this class. If this
    // signature had widened to cover it, the sibling's adjudicated bar would
    // silently disappear with it.
    expect(designedObservabilityOfFingerprint(DROP_GUARD_FINGERPRINT)?.id).toBe('action-verifier-drop-guard');
    // And this class's own message must not be claimed by the drop guard.
    expect(designedObservabilityOfFingerprint(PRE_FINGERPRINT)?.id).toBe('action-verifier-predelivery-strike');
  });

  it('the two action-verifier classes are distinguishable by their own words', () => {
    expect(/phantom claim\(s\) in supervisor/i.test(PRE_FINGERPRINT)).toBe(true);
    expect(/phantom claim\(s\) in supervisor/i.test(DROP_GUARD_FRAGMENT)).toBe(false);
    expect(/note was delivered as writ/i.test(DROP_GUARD_FRAGMENT)).toBe(false);
  });
});

describe('9289d163 — the CDP-unavailable warn is a designed read-only degrade', () => {
  it('matches on both surfaces (this message IS all literal, so they agree)', () => {
    expect(designedObservabilityOfFingerprint(CDP_FINGERPRINT)?.id).toBe('cloud-browser-cdp-unavailable');
    // No varying tokens anywhere in the message ⇒ the derived fragment is the
    // whole message. The only family member where the two surfaces coincide.
    const metric = logSignalDefaultMetric({ fingerprint: CDP_FINGERPRINT, levels: ['warn'], exampleMessage: CDP_FINGERPRINT });
    expect(String(metric?.params?.messagePattern)).toBe(CDP_FINGERPRINT);
    expect(designedAlarmOfMetric(metric!, AUTOFILER)?.id).toBe('cloud-browser-cdp-unavailable');
  });

  it('does not bleed onto the OTHER browser-driver colours', () => {
    // The zone-blocked state and the CDP-disabled-by-config state are different
    // diagnoses with different remedies; neither may be silenced by this one.
    expect(designedObservabilityOfFingerprint(
      'cloudbrowserdriver: brightdata zone blocked this server\'s egress ip',
    )).toBeNull();
    expect(designedObservabilityOfFingerprint(
      'cloudbrowserdriver: cloud_browser_cdp disabled by config — local chrome path',
    )).toBeNull();
  });
});

describe('67558dd0 — VERIFY ONLY: the PDF class was already adjudicated on main', () => {
  it('the shipped websearch-pdf-fetch-target signature still fires for this row', () => {
    // Shipped via #2614/#2619/#2624, proven by
    // log-signal-pdf-fetch.68200428.test.ts:115-121. No second signature added.
    expect(designedObservabilityOfFingerprint(PDF_FINGERPRINT, PDF_LIVE_ROW)?.id).toBe('websearch-pdf-fetch-target');
    const metric = logSignalDefaultMetric({ fingerprint: PDF_FINGERPRINT, levels: ['warn'], exampleMessage: PDF_LIVE_ROW });
    expect(metric).not.toBeNull();
    expect(designedAlarmOfMetric(metric!, AUTOFILER)?.id).toBe('websearch-pdf-fetch-target');
  });

  it('the URI-malformed OURS arm still keeps its bar (our bug, not a third party\'s)', () => {
    // The recall guard: a fix for our own decoding must remain measurable.
    expect(designedObservabilityOfFingerprint(
      'digby web search: pdf fetch/extract failed for "https://x.test/a%zz": uri malformed',
    )).toBeNull();
  });
});

describe('registry integrity — every signature is distinct and reachable', () => {
  it('no two signatures claim the same fingerprint, and the family leaves no class unowned', () => {
    const all: Array<[string, string]> = [
      [PRE_FINGERPRINT, 'action-verifier-predelivery-strike'],
      [DROP_GUARD_FINGERPRINT, 'action-verifier-drop-guard'],
      [CDP_FINGERPRINT, 'cloud-browser-cdp-unavailable'],
      [PDF_FINGERPRINT, 'websearch-pdf-fetch-target'],
      [
        'suggested-questions: draft yielded <n> candidates, <n> pass the mechanical check (drops {}, source check skipped) for us',
        'suggested-questions-draft-yield',
      ],
    ];
    for (const [fp, expected] of all) {
      // Each maps to exactly its own id — a widened predicate would show up
      // here as a class resolving to somebody else's signature.
      expect(designedObservabilityOfFingerprint(fp)?.id).toBe(expected);
    }
  });
});