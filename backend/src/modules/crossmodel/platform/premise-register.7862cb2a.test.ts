/**
 * Ticket 7862cb2a (2026-11-01, lane 0037460b run 0da5029f — goal 8f0dcd6f).
 * Two HARD LIMITS in the premise register fought the register's own documented
 * KPI contract, and both were reproduced with real refusals:
 *
 *   (1) KEY LENGTH. The contract says a goal carries exactly ONE `kpi:`
 *       premise and that every other rate registers under its OWN key shaped
 *       `<kpi key>:diag`. `PREMISE_KEY_MAX` was 40 and
 *       `backlog:auto_decrypt_rate_clips_per_hr` is 38 chars, so the
 *       DOCTRINE-MANDATED spelling is 43 and REFUSED (receipts 6f52fbe6,
 *       de09f943). The lane had to park a hand-shortened key — the naming
 *       convention was unsatisfiable by the very key it is derived from.
 *       Worse, the refusal echoed a key CLIPPED to 41 chars, so the caller
 *       could not even see what it sent, and offered no landing key.
 *
 *   (2) TWELVE-KEY CAP, SILENT HALF. Registering the new rate + its diag
 *       pushed the goal to 12, so a still-live measured premise
 *       (`backlog:diar_silence_class = 532`) had to be retired. The number
 *       survived only as prose in the goal note — no longer drift-watched or
 *       machine-checked — and NOTHING on the answer said which premise the
 *       replace had evicted.
 *
 * The invariants this file pins:
 *   A. The `<key>:diag` shape the contract mandates is REGISTRABLE at a
 *      realistic KPI-key length (the exact key from the report).
 *   B. An over-cap key is refused WITH arithmetic and with a key that will
 *      actually land — and that suggested key is itself accepted (never a
 *      refusal pointing at another refusal, the af24badf rule this module
 *      already enforces for the premise cap).
 *   C. A `mode:'replace'` that retires registered keys NAMES them.
 *   D. Nothing changes on the paths that were already fine: a merge never
 *      drops, and an in-cap call's answer carries no eviction fields.
 */
const mockPrisma: any = {};
const mockRedis: any = {};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: jest.fn() }));

import {
  normalizePremise, normalizePremises, shortenPremiseKey, premiseEvictionNotice, KPI_RECEIPT_RULE,
  PREMISE_KEY_MAX, PREMISE_MAX_PER_GOAL,
} from './premise-register';

/** The exact key the report could not register: 38-char KPI key + ':diag' = 43. */
const REPORTED_KPI_KEY = 'backlog:auto_decrypt_rate_clips_per_hr';
const REPORTED_DIAG_KEY = `${REPORTED_KPI_KEY}:diag`;

describe('ticket 7862cb2a — a premise key long enough to carry the contract\'s own :diag suffix', () => {
  it('the shape is measurable: the reported KPI key is 38 chars, so its :diag form is 43 (over the OLD 40 cap)', () => {
    expect(REPORTED_KPI_KEY).toHaveLength(38);
    expect(REPORTED_DIAG_KEY).toHaveLength(43);
    // The cap must leave room for the suffix the KPI contract mandates.
    expect(PREMISE_KEY_MAX).toBeGreaterThan(43);
  });

  it('REPLAY: the exact diag key from the report registers (it was refused at 08:56Z and 09:11Z)', () => {
    const p = normalizePremise({
      key: REPORTED_DIAG_KEY, value: 7, unit: 'clips/hr',
      note: 'backfill leg 2, partial config — NOT the KPI',
    });
    expect(typeof p).not.toBe('string');
    expect(p).toMatchObject({ key: REPORTED_DIAG_KEY, value: 7, unit: 'clips/hr' });
  });

  it('the whole report call lands: kpi: premise + its :diag diagnostic together on one goal', () => {
    const res = normalizePremises([
      { key: 'kpi:backlog_auto_decrypt_rate', value: 11.2, unit: 'clips/hr', bar: 30, barDirection: 'up', receiptId: 'ad3e8d27' },
      { key: REPORTED_DIAG_KEY, value: 7, unit: 'clips/hr', note: 'partial-config window' },
    ], [], {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.premises.map((p) => p.key)).toEqual(['kpi:backlog_auto_decrypt_rate', REPORTED_DIAG_KEY]);
    // Exactly one KPI premise — the diagnostic is NOT a second one.
    expect(res.premises.filter((p) => p.kind === 'kpi')).toHaveLength(1);
  });

  it('a key at EXACTLY the cap still lands (the boundary is inclusive)', () => {
    const exact = 'a'.repeat(PREMISE_KEY_MAX);
    const p = normalizePremise({ key: exact, value: 1 });
    expect(typeof p).not.toBe('string');
    expect((p as any).key).toHaveLength(PREMISE_KEY_MAX);
  });

  it('a key ONE over the cap is refused, names the REAL length (not a clip), and offers a landing key that IS accepted', () => {
    const over = `${'b'.repeat(PREMISE_KEY_MAX)}c`; // cap + 1
    const refused = normalizePremise({ key: over, value: 1 });
    expect(typeof refused).toBe('string');
    const text = String(refused);
    // The real length and the exact overflow — the caller can do the arithmetic.
    expect(text).toContain(`${over.length} chars`);
    expect(text).toContain('1 over the');
    // It must echo what the caller SENT, not a 41-char prefix of it.
    expect(text).toContain(over);
    // INVARIANT (af24badf rule): the offered key must actually land.
    const offered = /e\.g\. "([^"]+)"/.exec(text)?.[1];
    expect(offered).toBeTruthy();
    expect(offered!.length).toBeLessThanOrEqual(PREMISE_KEY_MAX);
    expect(typeof normalizePremise({ key: offered, value: 1 })).not.toBe('string');
  });

  it('an over-long :diag key keeps its :diag suffix in the offer — a diagnostic never becomes a KPI candidate key', () => {
    const longDiag = `${'x'.repeat(PREMISE_KEY_MAX)}:diag`;
    const text = String(normalizePremise({ key: longDiag, value: 1 }));
    const offered = /e\.g\. "([^"]+)"/.exec(text)?.[1];
    expect(offered).toBeTruthy();
    expect(offered!.endsWith(':diag')).toBe(true);
    expect(offered!.length).toBeLessThanOrEqual(PREMISE_KEY_MAX);
    // and the offer is registrable, with the suffix intact
    const landed = normalizePremise({ key: offered, value: 1 });
    expect(typeof landed).not.toBe('string');
    expect((landed as any).key.endsWith(':diag')).toBe(true);
  });

  it('an empty key is refused with its own text, never the length message', () => {
    const text = String(normalizePremise({ key: '   ', value: 1 }));
    expect(text).toContain('empty');
    expect(text).not.toContain('over the');
  });

  it('a malformed (in-cap) key still gets the shape message — the length branch did not swallow it', () => {
    expect(String(normalizePremise({ key: 'has space', value: 1 }))).toMatch(/must be 1–\d+ chars/);
  });
});

describe('ticket 7862cb2a — shortenPremiseKey never proposes a key the module would refuse', () => {
  it('is a no-op at or under the cap', () => {
    expect(shortenPremiseKey('ok_key')).toBe('ok_key');
    expect(shortenPremiseKey('a'.repeat(PREMISE_KEY_MAX))).toBe('a'.repeat(PREMISE_KEY_MAX));
  });

  it('preserves a :diag suffix and clips the HEAD, not the suffix', () => {
    const out = shortenPremiseKey(`${'k'.repeat(80)}:diag`);
    expect(out.endsWith(':diag')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(PREMISE_KEY_MAX);
  });

  it('clips a plain over-long key from the end', () => {
    const out = shortenPremiseKey('z'.repeat(90));
    expect(out).toBe('z'.repeat(PREMISE_KEY_MAX));
  });

  it('never leaves a trailing separator behind (a clipped key must stay well-formed)', () => {
    const out = shortenPremiseKey(`${'a'.repeat(PREMISE_KEY_MAX - 1)}.tail`);
    expect(out.endsWith('.')).toBe(false);
    expect(typeof normalizePremise({ key: out, value: 1 })).not.toBe('string');
  });

  it('PROPERTY: for any over-long input the offer either registers or is absent — never a dead-end suggestion', () => {
    // Adversarial review 2026-11-01 (blocking finding B): the first cut of this
    // property swept five CURATED shapes and asserted a universal "the offer
    // registers" — which was FALSE for separator-only, space-bearing and
    // non-ASCII keys, precisely because they were not sampled. This set is the
    // reviewer's falsifying inputs; the invariant is now honest: an offer is
    // either absent ('') or it registers.
    const shapes = [
      `${'a'.repeat(PREMISE_KEY_MAX)}:diag`,
      `${'a'.repeat(200)}`,
      `kpi:${'b'.repeat(90)}`,
      `${'c'.repeat(PREMISE_KEY_MAX)}___`,
      `${'d'.repeat(PREMISE_KEY_MAX - 2)}:DIAG`,
      '-'.repeat(70),                     // separator-only → empty
      '_'.repeat(70),
      ':'.repeat(70),
      '.'.repeat(70),
      'has space ' + 'z'.repeat(70),      // illegal char mid-key
      'é'.repeat(70),                     // non-ASCII run
      ':' + 'e'.repeat(70),               // leading separator
      `${'f'.repeat(80)}:diag`,
    ];
    for (const s of shapes) {
      const out = shortenPremiseKey(s);
      expect(out.length).toBeLessThanOrEqual(PREMISE_KEY_MAX);
      if (!out) continue; // no legal shortening — the caller must OMIT the offer
      // A key derived from a `kpi:` shape is still a KPI premise and owes its
      // receipt (orthogonal to the LENGTH fix this pins); give one so the
      // assertion grades the KEY SHAPE and nothing else.
      expect(typeof normalizePremise({ key: out, value: 1, receiptId: 'ad3e8d27' })).not.toBe('string');
    }
  });

  it('a key with NO legal shortening says so — the message never prints e.g. ""', () => {
    for (const s of ['-'.repeat(70), '_'.repeat(70), ':'.repeat(70), 'é'.repeat(70)]) {
      const text = String(normalizePremise({ key: s, value: 1 }));
      expect(text).not.toContain('e.g. ""');
      expect(text).toMatch(/No shortened form|e\.g\. "/);
      if (!/e\.g\. "/.test(text)) expect(text).toContain('No shortened form');
    }
  });
});

describe('ticket 7862cb2a — a replace that retires a measured premise NAMES it (the silent 12-cap half)', () => {
  /** The live goal 8f0dcd6f register at the trip: at the cap, no kpi: key. */
  const atCap = Array.from({ length: PREMISE_MAX_PER_GOAL }, (_, i) => ({ key: `reg_${i}`, value: i, unit: 'clips' })) as any;
  const SILENCE = { key: 'backlog:diar_silence_class', value: 532, unit: 'clips' };
  const withSilence = [...atCap.slice(0, PREMISE_MAX_PER_GOAL - 1), SILENCE] as any;

  it('REPLAY: a replace that swaps the 532-clip premise for a new one reports what it dropped', () => {
    const res = normalizePremises(
      [{ key: 'backlog:auto_decrypt_rate:diag', value: 7, unit: 'clips/hr' }, ...atCap.slice(0, PREMISE_MAX_PER_GOAL - 1).map((p: any) => ({ key: p.key, value: p.value, unit: p.unit }))],
      withSilence,
      { mode: 'replace' },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // DEFECT FIX: the evicted measured fact is NAMED, not silently gone.
    expect(res.dropped).toEqual(['backlog:diar_silence_class']);
    const notice = premiseEvictionNotice(res.dropped, 'replace', res.premises.length);
    expect(notice).toContain('backlog:diar_silence_class');
    expect(notice).toContain('DROPPED 1');
  });

  it('a merge NEVER drops — it can only overflow the cap, which has its own arithmetic', () => {
    const res = normalizePremises([{ key: 'brand_new', value: 1 }], withSilence.slice(0, 2), {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dropped).toEqual([]);
  });

  it('a replace that keeps every registered key reports no eviction and yields a NULL notice (answer unchanged)', () => {
    const res = normalizePremises(atCap.map((p: any) => ({ key: p.key, value: p.value, unit: p.unit })), atCap, { mode: 'replace' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.dropped).toEqual([]);
    expect(premiseEvictionNotice(res.dropped, 'replace', res.premises.length)).toBeNull();
  });

  it('the notice states the cap and the remedy (re-send it in the SAME array) so the fact is never lost to prose', () => {
    const notice = premiseEvictionNotice(['backlog:diar_silence_class'], 'replace', PREMISE_MAX_PER_GOAL)!;
    expect(notice).toContain(String(PREMISE_MAX_PER_GOAL));
    expect(notice).toContain('SAME array');
    expect(notice).toContain('no longer drift-watched');
  });

  it('plural wording is honest for several evictions', () => {
    const notice = premiseEvictionNotice(['a_one', 'b_two'], 'replace', 10)!;
    expect(notice).toContain('a_one, b_two');
    expect(notice).toContain('DROPPED 2');
  });

  it('the CAP refusal NAMES the registered keys, so eviction is chosen against facts not memory', () => {
    // The report's goal 8f0dcd6f: full at the cap, and the lane had to pick a
    // premise to retire with nothing telling it what was there.
    const res = normalizePremises([{ key: 'brand_new_rate', value: 9 }], withSilence, {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    for (const p of withSilence) expect(res.error).toContain(p.key);
    // and it warns that an omitted key in a replace is RETIRED, not kept
    expect(res.error).toContain('RETIRED');
    expect(res.error).toContain('Already registered:');
  });
});

describe('ticket 7862cb2a — the KPI contract\'s own advice must be followable', () => {
  it('REPLAY: KPI_RECEIPT_RULE names a :diag key that is registrable, for a LONG kpi: key too', () => {
    // A short key: the advice is the plain doctored shape.
    const short = KPI_RECEIPT_RULE('kpi:auto_decrypt_rate');
    expect(short).toContain('auto_decrypt_rate:diag');

    // A long key used to spawn an over-cap `:diag` — a refusal naming a retry
    // THIS module refuses again (the af24badf dead-end class).
    const longKey = `kpi:${'x'.repeat(PREMISE_KEY_MAX)}`;
    const text = KPI_RECEIPT_RULE(longKey);
    const offered = /e\.g\. "([^"]+)"/.exec(text)?.[1];
    expect(offered).toBeTruthy();
    expect(offered!.length).toBeLessThanOrEqual(PREMISE_KEY_MAX);
    expect(offered!.endsWith(':diag')).toBe(true);
    // INVARIANT: the advised key actually registers.
    expect(typeof normalizePremise({ key: offered!, value: 1 })).not.toBe('string');
  });
});