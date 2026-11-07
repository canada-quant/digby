/**
 * REPLAY TEST — ticket b73eae1b (2026-11-07, family lane 39ecd1b9): the
 * log-signal autofiler stamps an unattainable volume bar on the
 * suggested-questions DRAFT-YIELD class, so the post-deploy verifier would
 * reopen it forever.
 *
 * THE CLASS (measured in production, not a fixture).
 * `suggested-questions: draft yielded <n> candidates, <n> pass the mechanical
 * check (drops {}, source check skipped) for userId=<uuid> — skipping critic`
 * is emitted ONCE per generation attempt by suggested-questions.service.ts:947,
 * inside the explicit `checked.kept.length < MIN_QUESTIONS` branch: the run
 * skips the critic and takes defaults + a bounded backoff, then returns [].
 *
 * WHY ITS STAMPED BAR CANNOT CLEAR. The autofiler attached
 * `app_error_log_count <= 2 / 24h` over the derived fragment. Every one of the
 * ticket's own 11 rows reads `(drops {})` — mechanicalCheck dropped NOTHING, so
 * `kept === candidates < 3` and the DRAFT itself came back empty or tiny. The
 * driver is therefore the draft provider's yield (utilityChat returning '' when
 * every leg fails, or model prose carrying no JSON array) plus how thin a user's
 * context is. No fix in this repo bounds that across a provider blip, so the
 * bar would reopen a correct fix (the dc4f7ff5 failure mode documented in
 * acceptance-metric-defaults.ts).
 *
 * ── AND A MEASURED REFUTATION OF THE SIBLING TICKET'S PREMISE ───────────────
 * The sibling ticket d7a1ad46 reopened on sighting 2 with a RULE-2 claim:
 * "the message promises 'backing off' for 5 min yet 11 occurrences landed as
 * close as 1 min apart". The per-user rows refute it, and the arithmetic is
 * pinned below as a permanent guard so a future lane does not rebuild a
 * "backoff bypass" fix on the same misreading:
 *
 *   d1185fde   18:38:31.617Z → 18:43:37.969Z   = 5 min 06 s
 *   867c4f48   11:05:52.705Z → 11:11:00.115Z   = 5 min 07 s
 *
 * Every same-user pair in the 24 h window is >= the 5-minute window. The
 * sub-5-minute adjacencies the sweep counted are ACROSS DIFFERENT USERS
 * (22097a46 at 15:55:55.850Z vs 158ffa30 at 15:55:15.277Z — two separate
 * people 40 s apart). The backoff is PER USER, so a global rate is not the
 * promise it makes. The message is honest; the sighting's reading was not.
 */
import {
  AUTOFILER_DEFAULT_METRIC_SOURCE as AUTOFILER,
  designedAlarmOfMetric,
  designedObservabilityOfFingerprint,
  logSignalDefaultMetric,
} from './acceptance-metric-defaults';

/** The ticket's own newest live row. */
const LIVE_ROW =
  'suggested-questions: draft yielded 0 candidates, 0 pass the mechanical check '
  + '(drops {}, source check skipped) for userId=d1185fde-ab83-4fac-8bdd-f00362b03ec2 — skipping critic';

/** The ticket's stored fingerprint (the sweep's normalizer output, verbatim
 *  from the ticket title — ids digit-folded to <n>, which is why this class
 *  fragments into sibling filings). */
const FINGERPRINT =
  'suggested-questions: draft yielded <n> candidates, <n> pass the mechanical check '
  + '(drops {}, source check skipped) for us';

/** The autofiler's derived fragment for this class (what the volume bar counts). */
const DERIVED_FRAGMENT = 'pass the mechanical check (drops {}, source check skipped) for us';

/** The SIBLING class's fingerprint and fragment — a DIFFERENT emit site. */
const SIBLING_FINGERPRINT =
  'suggested-questions: <n> usable results for userid=<uuid> (min <n>) — backing off <n> min before retry';
const SIBLING_FRAGMENT = 'usable results for userid=';

describe('b73eae1b — the suggested-questions draft-yield warn is designed observability', () => {
  it('the live row matches the signature on BOTH surfaces the sweep uses', () => {
    // FINGERPRINT surface — what `designedObservabilityOfFingerprint` is
    // consulted with (log-signal-sweep.service.ts:213). This is the decision
    // that actually stops the unsound bar being stamped.
    expect(designedObservabilityOfFingerprint(FINGERPRINT)?.id).toBe('suggested-questions-draft-yield');
    // METRIC surface — the verifier's re-ruling path. It sees only the DERIVED
    // fragment, which begins mid-message; if the predicate did not accept that
    // arm the adjudication would be invisible one level down.
    const metric = logSignalDefaultMetric({ fingerprint: FINGERPRINT, levels: ['warn'], exampleMessage: LIVE_ROW });
    expect(metric).not.toBeNull();
    const ruling = designedAlarmOfMetric(metric!, AUTOFILER);
    expect(ruling?.id).toBe('suggested-questions-draft-yield');
    // Both surfaces agree on the class they name — the inconsistency that made
    // utility-override-failover stamp "measurable" while the verifier said
    // "unsound".
    expect(ruling?.class).toBe('designed-observability');
  });

  it('the derived fragment really does start mid-message (the surface asymmetry)', () => {
    // Measured, not assumed: this is WHY the predicate needs two arms.
    const metric = logSignalDefaultMetric({ fingerprint: FINGERPRINT, levels: ['warn'], exampleMessage: LIVE_ROW });
    const pattern = String(metric?.params?.messagePattern ?? '');
    expect(pattern).toBe('pass the mechanical check (drops {}, source check skipped) for us');
    expect(pattern).not.toContain('draft yielded');
    // The fingerprint, by contrast, does carry it.
    expect(FINGERPRINT).toContain('draft yielded');
  });

  it('the sibling :590 class has its OWN signature — neither swallows the other', () => {
    // Different emit site, different ticket, co-firing for ONE user event. Each
    // must resolve to its own id: if this predicate had widened to swallow the
    // sibling, the sibling's ruling would silently vanish into this one while
    // still looking "adjudicated".
    expect(designedObservabilityOfFingerprint(SIBLING_FINGERPRINT)?.id).toBe('suggested-questions-low-yield');
    expect(designedObservabilityOfFingerprint(FINGERPRINT)?.id).toBe('suggested-questions-draft-yield');
    // The sibling's derived fragment belongs to the sibling, not to this class.
    expect(designedObservabilityOfFingerprint(SIBLING_FRAGMENT)?.id).toBe('suggested-questions-low-yield');
  });

  it('the two classes are distinguishable by their own words', () => {
    // The predicate keys on `draft yielded … candidates`; the sibling message
    // contains neither word. This is the property that keeps them apart even
    // after the normalizer's digit-folding, which is what glued sibling
    // filings together in the first place.
    expect(/draft yielded\b.*\bcandidates/i.test(FINGERPRINT)).toBe(true);
    expect(/draft yielded\b.*\bcandidates/i.test(SIBLING_FINGERPRINT)).toBe(false);
  });

  it('a class it must NOT cover: the generic draft-failure error is untouched', () => {
    // `suggested-questions: failed for userId=…` is the exception path (a throw
    // out of generateQuestions). It is a real failure and keeps whatever bar it
    // was given — do not let this signature bleed onto it.
    expect(designedObservabilityOfFingerprint('suggested-questions: failed for userid=<uuid>: boom')).toBeNull();
  });

  it('the autofiler WOULD stamp a volume bar on this class without the signature', () => {
    // Proves the fix is load-bearing rather than decorative. The autofiler's
    // default metric for this signal is a real `app_error_log_count <= 0/2`
    // bar, and it is exactly what reopened the class forever. The signature
    // above is the only thing standing between the class and that loop.
    const metric = logSignalDefaultMetric({ fingerprint: FINGERPRINT, levels: ['warn'], exampleMessage: LIVE_ROW });
    expect(metric).not.toBeNull();
    expect(metric?.probe).toBe('app_error_log_count');
    // And the per-target fragment it would count is the mid-message one, i.e.
    // the bar would count *someone else's* rows too (any draft-yield row with
    // empty drops), never a property this class's fix controls.
    expect(String(metric?.params?.messagePattern)).toBe(
      'pass the mechanical check (drops {}, source check skipped) for us',
    );
  });
});

describe('b73eae1b — the "backing off" promise is honest (d7a1ad46 sighting-2 refutation)', () => {
  /** The d7a1ad46 rows, as returned by get_fleet_telemetry this run. */
  const ROWS: Array<{ user: string; at: number }> = [
    { user: '867c4f48', at: Date.parse('2026-11-06T11:05:52.705Z') },
    { user: '867c4f48', at: Date.parse('2026-11-06T11:11:00.115Z') },
    { user: '867c4f48', at: Date.parse('2026-11-06T13:34:14.721Z') },
    { user: '867c4f48', at: Date.parse('2026-11-06T16:12:45.205Z') },
    { user: '867c4f48', at: Date.parse('2026-11-06T17:05:22.427Z') },
    { user: '867c4f48', at: Date.parse('2026-11-06T18:12:51.736Z') },
    { user: '867c4f48', at: Date.parse('2026-11-07T00:36:33.240Z') },
    { user: 'd1185fde', at: Date.parse('2026-11-06T18:38:31.617Z') },
    { user: 'd1185fde', at: Date.parse('2026-11-06T18:43:37.969Z') },
    { user: '158ffa30', at: Date.parse('2026-11-06T15:55:15.277Z') },
    { user: '22097a46', at: Date.parse('2026-11-06T15:55:55.850Z') },
    { user: 'c0f95646', at: Date.parse('2026-11-06T08:00:46.432Z') },
  ];
  const BACKOFF_MS = 5 * 60 * 1000;

  it('no user is retried faster than the advertised 5-minute backoff', () => {
    const byUser = new Map<string, number[]>();
    for (const r of ROWS) byUser.set(r.user, [...(byUser.get(r.user) ?? []), r.at]);
    const violations: string[] = [];
    for (const [user, times] of byUser) {
      const sorted = [...times].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        const gap = sorted[i] - sorted[i - 1];
        if (gap < BACKOFF_MS) violations.push(`${user}: ${gap}ms`);
      }
    }
    // A non-empty list here would mean the RULE-2 claim is TRUE and a real
    // suppression bug exists. It is empty: the rows say the backoff holds.
    expect(violations).toEqual([]);
  });

  it('the tightest pair the SWEEP saw is two different users, 40 s apart', () => {
    // This is the whole misreading in one assertion: 22097a46 → 158ffa30 are
    // 40.573 s apart, but they are DIFFERENT people, so the per-user promise
    // is not implicated.
    const a = ROWS.find((r) => r.user === '22097a46')!;
    const b = ROWS.find((r) => r.user === '158ffa30')!;
    expect(a.user).not.toBe(b.user);
    expect(Math.abs(a.at - b.at)).toBeLessThan(BACKOFF_MS);
  });

  it('and the sibling backoff MULTIPLIER is large enough to be honored', () => {
    // The promise is only kept if the marker lives at least as long as the
    // message claims. 0 usable results ⇒ 5 min (the transient miss path).
    const d1185 = ROWS.filter((r) => r.user === 'd1185fde').sort((x, y) => x.at - y.at);
    expect(d1185[1].at - d1185[0].at).toBeGreaterThanOrEqual(BACKOFF_MS);
  });
});

describe('d7a1ad46 — the LEAD member is adjudicated designed (30dfad06 reasoning, re-measured)', () => {
  it('the :590 class now carries its own signature on both surfaces', () => {
    // Why a signature and not a service fix: one warn per attempt, then a
    // per-user backoff the controller reads, so the class cannot storm and its
    // rate tracks how many users hit a yield miss.
    expect(designedObservabilityOfFingerprint(SIBLING_FINGERPRINT)?.id).toBe('suggested-questions-low-yield');
    const metric = logSignalDefaultMetric({ fingerprint: SIBLING_FINGERPRINT, levels: ['warn'] });
    expect(metric).not.toBeNull();
    expect(designedAlarmOfMetric(metric!, AUTOFILER)?.id).toBe('suggested-questions-low-yield');
  });

  it('the two suggested-questions signatures stay DISJOINT in both directions', () => {
    // The lead (:590, `usable results`) and the draft-yield (:947, `draft
    // yielded … pass the mechanical check`) co-fire for ONE user event, so a
    // predicate that leaked would silently delete the other class's ruling.
    expect(designedObservabilityOfFingerprint(FINGERPRINT)?.id).toBe('suggested-questions-draft-yield');
    expect(designedObservabilityOfFingerprint(SIBLING_FINGERPRINT)?.id).toBe('suggested-questions-low-yield');
    // Neither message carries the other's distinguishing words.
    expect(SIBLING_FINGERPRINT).not.toContain('draft yielded');
    expect(FINGERPRINT).not.toContain('usable results');
  });

  it('the generic failure path keeps whatever bar it was given', () => {
    // `suggested-questions: failed for userId=…` is a THROW out of generation —
    // a real failure, not a designed yield miss. It must not be waived.
    expect(designedObservabilityOfFingerprint('suggested-questions: failed for userid=<uuid>: boom')).toBeNull();
  });
});