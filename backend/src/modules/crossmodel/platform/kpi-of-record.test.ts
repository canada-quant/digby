/**
 * KPI OF RECORD pins (tt-rd audit 2026-09-27, kpi-honesty-loops findings 1/2/4/5).
 * The leaf module's pure helpers: the `kpi:` convention, the board rendering
 * with receipt / age / bar / last change, the typed-rate miner that catches a
 * "6.56 tok/s" the register does not hold, the reply footer, the state-doc
 * annotation and the status-card row. No mocks — the module imports nothing.
 */
import {
  isKpiPremise, kpiPremiseOf, kpiBareKey, normalizeReceiptId, formatAge, renderKpiInline, renderPremiseReceiptSuffix,
  mineKpiRateMentions, sameKpiValue, mentionsKpiKey, typedRatesDisagreeingWithKpi, kpiReplyFooter, annotateStateLineWithKpi,
  renderKpiCardLine, kpiValueText, kpiBarText, readPremisesLoose, type KpiView,
  kpiBarDirection, kpiBarMet, kpiRegisterValues, adoptionLadderK, adoptionLadderHours, ADOPTION_LADDER_K_ENV, ADOPTION_LADDER_HOURS_ENV,
  isThresholdMention, kpiThresholdMentionExemptDisabled,
} from './kpi-of-record';

const NOW = new Date('2026-09-27T15:22:15Z');
const KPI: KpiView = {
  goalId: '226be7b7-0000-4000-8000-000000000000', projectId: 'p1', goalTitle: 'Qwen3.8-Flash-Next serving on node-a',
  key: 'kpi:client_visible_e2e_tok_s', value: 5.08, unit: 'tok/s', kind: 'kpi', bar: 10,
  receiptId: 'f5b42fe6-1111-4000-8000-000000000000', setAt: '2026-09-27T13:22:15Z',
  prev: { value: 2.464, setAt: '2026-09-27T03:34:40Z', receiptId: 'aaaa1111-2222-4000-8000-000000000000' },
};

describe('kpi-of-record — the kpi: convention', () => {
  it('a kpi: key or kind:"kpi" marks the of-record premise; kpiPremiseOf picks it out of a mixed register', () => {
    expect(isKpiPremise({ key: 'kpi:e2e', value: 1 })).toBe(true);
    expect(isKpiPremise({ key: 'KPI:e2e', value: 1 })).toBe(true);
    expect(isKpiPremise({ key: 'e2e', value: 1, kind: 'kpi' })).toBe(true);
    expect(isKpiPremise({ key: 'read_wait_ms', value: 138 })).toBe(false);
    expect(isKpiPremise(null)).toBe(false);
    const p = kpiPremiseOf([{ key: 'host_tail_eng_gap_ms_tok', value: 12 }, { key: 'kpi:e2e', value: '5.08', unit: 'tok/s' }]);
    expect(p).toEqual(expect.objectContaining({ key: 'kpi:e2e', value: 5.08 }));
    expect(kpiPremiseOf([{ key: 'x', value: 1 }])).toBeNull();
    expect(kpiPremiseOf('nope')).toBeNull();
    expect(kpiBareKey('kpi:client_visible_e2e_tok_s')).toBe('client_visible_e2e_tok_s');
    expect(kpiBareKey('plain')).toBe('plain');
    expect(readPremisesLoose([{ key: 'a', value: '1.5' }, { key: 'b' }, null])).toEqual([{ key: 'a', value: 1.5 }]);
  });

  it('receipt ids are ≥8 hex chars (a uuid or its prefix, as get_run_receipts prints them)', () => {
    expect(normalizeReceiptId('F5B42FE6')).toBe('f5b42fe6');
    expect(normalizeReceiptId('f5b42fe6-1111-4000-8000-000000000000')).toBe('f5b42fe6-1111-4000-8000-000000000000');
    expect(normalizeReceiptId('abc')).toBeNull();
    expect(normalizeReceiptId('msg 08ae015c')).toBeNull();
    expect(normalizeReceiptId('')).toBeNull();
  });
});

describe('kpi-of-record — rendering (finding 2b: receipt · age · bar · last change)', () => {
  it('renders the board line with receipt id8, age, bar and the last change', () => {
    expect(renderKpiInline(KPI, NOW)).toBe('KPI client_visible_e2e_tok_s=5.08 tok/s (receipt f5b42fe6 · 2h ago · bar ≥10) · last change 2.464→5.08 @13:22Z');
    expect(renderKpiInline({ key: 'kpi:rate', value: 28, unit: '%', bar: 20 }, NOW)).toBe('KPI rate=28% (bar ≤20)');
    expect(renderKpiInline({ key: 'kpi:rate', value: 3 }, NOW)).toBe('KPI rate=3');
  });

  it('a non-KPI premise with a receipt shows "(receipt id8 · age)"; without one, nothing', () => {
    expect(renderPremiseReceiptSuffix({ receiptId: 'deadbeef-0000-4000-8000-000000000000', setAt: '2026-09-27T14:52:15Z' }, NOW)).toBe(' (receipt deadbeef · 30m ago)');
    expect(renderPremiseReceiptSuffix({ receiptId: 'deadbeef' }, NOW)).toBe(' (receipt deadbeef)');
    expect(renderPremiseReceiptSuffix({}, NOW)).toBe('');
  });

  it('formatAge / kpiValueText / kpiBarText are stable', () => {
    expect(formatAge(5 * 60_000)).toBe('5m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(72 * 3_600_000)).toBe('3d');
    expect(formatAge(-1)).toBe('0m');
    expect(kpiValueText({ value: 5.08, unit: 'tok/s' })).toBe('5.08 tok/s');
    expect(kpiValueText({ value: 60.07, unit: '%' })).toBe('60.07%');
    expect(kpiValueText({ value: 12, unit: ' USD' })).toBe('12 USD');
    expect(kpiBarText({ value: 5, bar: 10 })).toBe('bar ≥10');
    expect(kpiBarText({ value: 5 })).toBe('');
  });

  it('the owner card row carries value, receipt, age, bar and the experiments-without-adoption counter', () => {
    expect(renderKpiCardLine({ ...KPI, experimentsSinceMove: 27, hoursSinceMove: 108 }, NOW))
      .toBe('KPI of record — client visible e2e tok s: 5.08 tok/s — receipt f5b42fe6, 2h ago — bar ≥10 · unchanged for 4d (27 work sessions since the last move)');
    expect(renderKpiCardLine({ key: 'kpi:x', value: 1, unit: 'tok/s' }, NOW)).toBe('KPI of record — x: 1 tok/s');
  });
});

describe('kpi-of-record — the typed-rate miner (findings 4/5)', () => {
  it('finds every "<number> <unit>" mention in the KPI unit, tolerant of spacing and ≈', () => {
    expect(mineKpiRateMentions('you are serving ~7.3 tok/s now; the probe said 5.08 tok/s and 6.56tok/s decode-phase', 'tok/s')).toEqual([7.3, 5.08, 6.56]);
    expect(mineKpiRateMentions('2 tok / s', 'tok/s')).toEqual([2]);
    expect(mineKpiRateMentions('138 ms read_wait', 'tok/s')).toEqual([]);
    expect(mineKpiRateMentions('60.07% suite mean', '%')).toEqual([60.07]);
    expect(mineKpiRateMentions('anything', undefined)).toEqual([]);
  });

  it('sameKpiValue compares at the register precision; disagreeing rates exclude the register value', () => {
    expect(sameKpiValue(5.08, 5.080)).toBe(true);
    expect(sameKpiValue(5.1, 5.08)).toBe(false);
    expect(typedRatesDisagreeingWithKpi('5.08 tok/s of record vs 6.56 tok/s decode and 7.3 tok/s read_wait', KPI)).toEqual([6.56, 7.3]);
    expect(typedRatesDisagreeingWithKpi('5.08 tok/s', KPI)).toEqual([]);
  });

  it('mentionsKpiKey matches the bare key with or without the prefix, as a whole token', () => {
    expect(mentionsKpiKey('see kpi:client_visible_e2e_tok_s on the card', KPI.key)).toBe(true);
    expect(mentionsKpiKey('client_visible_e2e_tok_s = 5.08', KPI.key)).toBe(true);
    expect(mentionsKpiKey('client_visible_e2e_tok_s_diag = 2.4', KPI.key)).toBe(false);
    expect(mentionsKpiKey('no key here', KPI.key)).toBe(false);
  });
});

describe('kpi-of-record — reply footer (finding 5) and state annotation (finding 2d)', () => {
  it('appends the register line when a reply types a rate the register does not hold and never cites the key (the 6.56 "of record" shape)', () => {
    const hit = kpiReplyFooter('Current: 6.56 tok/s client-visible (of record); M1 unmet.', [KPI], NOW);
    expect(hit).not.toBeNull();
    expect(hit!.quoted).toEqual([6.56]);
    expect(hit!.footer).toBe('(KPI of record — client_visible_e2e_tok_s: 5.08 tok/s — receipt f5b42fe6, 2h ago; bar ≥10)');
  });

  it('no footer when the reply quotes the register value, cites the key, has no rate, or there is no KPI', () => {
    expect(kpiReplyFooter('e2e 5.08 tok/s @15:41Z (M1 unmet)', [KPI], NOW)).toBeNull();
    expect(kpiReplyFooter('read_wait implies 7.3 tok/s but kpi:client_visible_e2e_tok_s is the number of record', [KPI], NOW)).toBeNull();
    expect(kpiReplyFooter('nothing moved since the previous wake', [KPI], NOW)).toBeNull();
    expect(kpiReplyFooter('7.3 tok/s', [], NOW)).toBeNull();
    expect(kpiReplyFooter('7.3 tok/s', [{ ...KPI, unit: undefined }], NOW)).toBeNull();
  });

  it('annotates a [SUPERVISOR STATE] project line that types a rate or names the key with the live register value; leaves others verbatim', () => {
    const line = '- tt-rd: speed lane mid-firing; e2e premise 2.464 tok/s F-301 03:24Z';
    expect(annotateStateLineWithKpi(line, [KPI], NOW)).toBe(`${line} [register now: client_visible_e2e_tok_s=5.08 tok/s @13:22Z receipt f5b42fe6]`);
    expect(annotateStateLineWithKpi('- tt-rd: kpi:client_visible_e2e_tok_s flat since 09-21', [KPI], NOW)).toContain('[register now: client_visible_e2e_tok_s=5.08 tok/s');
    expect(annotateStateLineWithKpi('- CanLaw: SFT-2 chain running', [KPI], NOW)).toBe('- CanLaw: SFT-2 chain running');
    // idempotent — an already-annotated line is not annotated twice
    const once = annotateStateLineWithKpi(line, [KPI], NOW);
    expect(annotateStateLineWithKpi(once, [KPI], NOW)).toBe(once);
    expect(annotateStateLineWithKpi(line, [], NOW)).toBe(line);
  });
});

// ── Fixer follow-up 2026-09-27 (findings 2 / 3c / 4 of the branch review) ────
describe('kpi-of-record — fixer follow-up: bar direction, register-held values, annotation idempotence, ladder thresholds', () => {
  afterEach(() => { delete process.env[ADOPTION_LADDER_K_ENV]; delete process.env[ADOPTION_LADDER_HOURS_ENV]; });

  it('the bar direction comes from the FIRST registered value: a counts-up KPI that passed its bar keeps "≥" and is bar-met; a counts-down one is met at or below', () => {
    const up = { key: 'kpi:e2e', value: 12, bar: 10, history: [{ value: 3.44 }, { value: 5.08 }] };
    expect(kpiBarDirection(up)).toBe('up');
    expect(kpiBarText(up)).toBe('bar ≥10'); // used to render "bar ≤10" once the value passed the bar
    expect(kpiBarMet(up)).toBe(true);
    expect(kpiBarMet({ ...up, value: 9.9 })).toBe(false);
    const down = { key: 'kpi:p95_ms', value: 180, bar: 200, history: [{ value: 340 }] };
    expect(kpiBarDirection(down)).toBe('down');
    expect(kpiBarText(down)).toBe('bar ≤200');
    expect(kpiBarMet(down)).toBe(true);
    expect(kpiBarMet({ ...down, value: 250 })).toBe(false);
    // no history: the current value decides (the pre-fix behaviour for a fresh registration); no bar: never met
    expect(kpiBarText({ value: 28, bar: 20 })).toBe('bar ≤20');
    expect(kpiBarMet({ value: 5 })).toBe(false);
  });

  it('the register HOLDS its value, bar, prev and history: quoting any of them is not a mis-report (the three probes the review ran)', () => {
    const kpi = { ...KPI, history: [{ value: 3.44 }, { value: 5.364 }] };
    expect(kpiRegisterValues(kpi)).toEqual([5.08, 10, 2.464, 3.44, 5.364]);
    expect(typedRatesDisagreeingWithKpi('Next: reach the bar of 10 tok/s.', kpi)).toEqual([]);
    expect(typedRatesDisagreeingWithKpi('Prev reading was 2.464 tok/s (diagnostic window); of record is 5.08 tok/s.', kpi)).toEqual([]);
    expect(typedRatesDisagreeingWithKpi('Serving 5.08 tok/s; M1 bar 10 tok/s unmet.', kpi)).toEqual([]);
    expect(typedRatesDisagreeingWithKpi('was 3.44 tok/s, then 5.364 tok/s, now 5.08 tok/s', kpi)).toEqual([]);
    // a rate the register never held still disagrees
    expect(typedRatesDisagreeingWithKpi('serving 6.56 tok/s vs the bar of 10 tok/s', kpi)).toEqual([6.56]);
    // …and so no footer on the correct replies, a footer on the wrong one
    expect(kpiReplyFooter('Next: reach the bar of 10 tok/s.', [kpi], NOW)).toBeNull();
    expect(kpiReplyFooter('Prev reading was 2.464 tok/s (diagnostic window); of record is 5.08 tok/s.', [kpi], NOW)).toBeNull();
    expect(kpiReplyFooter('Serving 5.08 tok/s; M1 bar 10 tok/s unmet.', [kpi], NOW)).toBeNull();
    expect(kpiReplyFooter('Current: 6.56 tok/s (of record); bar 10 tok/s.', [kpi], NOW)?.quoted).toEqual([6.56]);
  });

  it('a [SUPERVISOR STATE] line that already carries the register value verbatim is left alone', () => {
    const current = '- tt-rd: e2e 5.08 tok/s of record, M1 unmet';
    expect(annotateStateLineWithKpi(current, [KPI], NOW)).toBe(current);
    // a stale rate without the register value is still annotated
    expect(annotateStateLineWithKpi('- tt-rd: e2e 6.56 tok/s of record', [KPI], NOW)).toContain('[register now: client_visible_e2e_tok_s=5.08 tok/s');
  });

  it('the ladder thresholds are read here (8 experiments / 48 h, env-tunable) so the doctrine budget and the harness wake agree', () => {
    expect(adoptionLadderK()).toBe(8);
    expect(adoptionLadderHours()).toBe(48);
    process.env[ADOPTION_LADDER_K_ENV] = '6';
    process.env[ADOPTION_LADDER_HOURS_ENV] = '24';
    expect(adoptionLadderK()).toBe(6);
    expect(adoptionLadderHours()).toBe(24);
    process.env[ADOPTION_LADDER_K_ENV] = 'nope';
    expect(adoptionLadderK()).toBe(8);
  });
});

// audit 2026-10-06 T8-12 (others F17): "the adoption bar ≥5.23 tok/s" is a threshold, not a quoted KPI value.
describe('kpi_reply_mismatch — threshold mentions are bars, not claims (audit 2026-10-06 T8-12)', () => {
  afterEach(() => { delete process.env.KPI_THRESHOLD_MENTION_EXEMPT_DISABLED; });

  it('comparator / threshold-word mentions are skipped; a plain current-value claim is still caught', () => {
    expect(kpiReplyFooter('Adoption bar ≥5.23 tok/s for the next candidate; nothing else moved.', [KPI], NOW)).toBeNull();
    expect(kpiReplyFooter('A candidate must beat 6.1 tok/s to be adopted.', [KPI], NOW)).toBeNull();
    expect(kpiReplyFooter('Target of 7.5 tok/s by Friday; >= 6 tok/s gates the merge.', [KPI], NOW)).toBeNull();
    expect(typedRatesDisagreeingWithKpi('Serving at 6.56 tok/s; adoption bar ≥5.23 tok/s.', KPI)).toEqual([6.56]);
    expect(kpiReplyFooter('Serving at 6.56 tok/s now.', [KPI], NOW)).not.toBeNull();
  });

  it('an arrow is not a comparator ("4.9 -> 5.23 tok/s" claims the new value)', () => {
    expect(isThresholdMention('went 4.9 -> 5.23 tok/s', 'went 4.9 -> '.length)).toBe(false);
    expect(isThresholdMention('bar ≥5.23 tok/s', 'bar ≥'.length)).toBe(true);
    expect(typedRatesDisagreeingWithKpi('went 4.9 -> 5.23 tok/s', KPI)).toEqual([5.23]);
  });

  it('KPI_THRESHOLD_MENTION_EXEMPT_DISABLED=1 judges every mention (previous behaviour)', () => {
    process.env.KPI_THRESHOLD_MENTION_EXEMPT_DISABLED = '1';
    expect(kpiThresholdMentionExemptDisabled()).toBe(true);
    const hit = kpiReplyFooter('Adoption bar ≥5.23 tok/s for the next candidate.', [KPI], NOW);
    expect(hit?.quoted).toEqual([5.23]);
  });
});
