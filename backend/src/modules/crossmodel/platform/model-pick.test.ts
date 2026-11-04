/**
 * Per-turn model pick (owner 2026-10-04: "shouldn't the decision model decide any model it wants for the specific task").
 */
import {
  candidateFits, costPrice, expectedWaitMs, pickForRole, pickModel, rankForRole, pickAvoidingFamily, quickThinkingOffCapable, turnCostUsd, utilityOf, waitPrice,
  PICK_TURN_TOKENS_IN, PICK_TURN_TOKENS_OUT, SWITCH_MARGIN, UNKNOWN_FRONTIER_PRICE, UNKNOWN_OPEN_PRICE, type ModelEvidence, type PickCandidate,
  kindSwitchMargin, KIND_MARGIN_Z, RANK_QUALITY_SD,
} from './model-pick';

const card = (spec: string, o: Partial<PickCandidate> = {}): PickCandidate => ({ spec, servable: true, autoEligible: true, vision: true, thinkingOff: false, ...o });
const ev = (quality: number | null, ttftS: number | null, o: Partial<ModelEvidence> = {}): ModelEvidence => ({
  n: 12, ttftP50Ms: ttftS === null ? null : ttftS * 1000, ttftP90Ms: null, failRate: 0, quality, qualityN: 12, source: 'test', ...o,
});

describe('candidateFits', () => {
  it('only open, servable chat models that fit the turn', () => {
    expect(candidateFits(card('glm'), 'standard', { images: false })).toBe(true);
    expect(candidateFits(card('x', { autoEligible: false }), 'standard', { images: false })).toBe(false); // frontier
    expect(candidateFits(card('x', { frontier: true }), 'standard', { images: false })).toBe(false); // frontier, whatever autoEligible says
    expect(candidateFits(card('x', { servable: false }), 'standard', { images: false })).toBe(false);
    expect(candidateFits(card('cql-litellm:agx-embed'), 'standard', { images: false })).toBe(false);
    expect(candidateFits(card('cql-litellm:agx-rerank'), 'standard', { images: false })).toBe(false);
    expect(candidateFits(card('txt', { vision: false }), 'standard', { images: true })).toBe(false);
    expect(candidateFits(card('nothink', { thinkingOff: true }), 'standard', { images: false })).toBe(false);
    expect(candidateFits(card('nothink', { thinkingOff: true }), 'quick', { images: false })).toBe(true);
  });
});

describe('utility', () => {
  it('waiting costs more on a quick question than on research; high stakes halves the price', () => {
    expect(waitPrice('quick', 0)).toBeGreaterThan(waitPrice('standard', 0));
    expect(waitPrice('research', 0)).toBeLessThan(waitPrice('checked', 0));
    expect(waitPrice('standard', 0.8)).toBeCloseTo(waitPrice('standard', 0) / 2);
  });
  it('quality minus the waiting price minus failures; unscorable without quality or latency', () => {
    expect(utilityOf(ev(4, 60), 'standard', 0)).toBeCloseTo(4 - 0.6);
    expect(utilityOf(ev(4, 60, { failRate: 0.1 }), 'standard', 0)).toBeCloseTo(4 - 0.6 - 0.2);
    expect(utilityOf(ev(null, 60), 'standard', 0)).toBeNull();
    expect(utilityOf(ev(4, null), 'standard', 0)).toBeNull();
  });
});

describe('pickModel', () => {
  const base = { lane: 'standard' as const, stakes: 0.1, images: false, seat: 'seat' };
  const cands = [card('seat'), card('fast'), card('slowgood'), card('unmeasured')];

  it('a measured faster model of similar quality beats a slow seat', () => {
    const evidence = (s: string) => ({ seat: ev(4.0, 180), fast: ev(3.9, 20), slowgood: ev(4.3, 300) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickModel({ ...base, candidates: cands, evidence });
    expect(p).toMatchObject({ spec: 'fast', changed: true, seat: 'seat', expectedTtftMs: 20_000 });
    expect(p.reason).toMatch(/fast .* over seat seat/);
    expect(p.ranked.map((r) => r.spec)).not.toContain('unmeasured'); // no live exploration: unmeasured never ranks
  });

  it('never trades a materially worse answer for speed (quality slack)', () => {
    const evidence = (s: string) => ({ seat: ev(4.4, 120), fast: ev(3.6, 10) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickModel({ ...base, candidates: cands, evidence });
    expect(p.changed).toBe(false);
    expect(p.reason).toMatch(/quality/);
  });

  it('a high-stakes turn is willing to wait for the better model', () => {
    const evidence = (s: string) => ({ seat: ev(3.6, 20), slowgood: ev(4.4, 90) } as Record<string, ModelEvidence>)[s] ?? null;
    expect(pickModel({ ...base, lane: 'quick', stakes: 0, candidates: cands, evidence }).spec).toBe('seat');
    expect(pickModel({ ...base, lane: 'checked', stakes: 0.9, candidates: cands, evidence }).spec).toBe('slowgood');
  });

  it('stays on the seat when it is unmeasured, nothing else is measured, or the gain is under the margin', () => {
    expect(pickModel({ ...base, candidates: cands, evidence: (s) => (s === 'fast' ? ev(4, 10) : null) }).reason).toMatch(/unmeasured/);
    expect(pickModel({ ...base, candidates: cands, evidence: (s) => (s === 'seat' ? ev(4, 60) : null) }).reason).toMatch(/no measured alternative/);
    const close = (s: string) => ({ seat: ev(4.0, 60), fast: ev(4.0, 60 - (SWITCH_MARGIN / 0.6) * 60 * 0.5) } as Record<string, ModelEvidence>)[s] ?? null;
    expect(pickModel({ ...base, candidates: cands, evidence: close }).changed).toBe(false);
  });

  it('images restrict the field to vision models; thin evidence never counts', () => {
    const c2 = [card('seat'), card('txt', { vision: false }), card('thin')];
    const evidence = (s: string) => ({ seat: ev(4, 120), txt: ev(4.2, 10), thin: ev(4.5, 5, { n: 2 }) } as Record<string, ModelEvidence>)[s] ?? null;
    expect(pickModel({ ...base, images: true, candidates: c2, evidence }).changed).toBe(false);
  });
});

describe('pickAvoidingFamily — the second opinion stays independent', () => {
  const fam = (s: string) => (s.includes('deepseek') ? 'deepseek' : s.includes('glm') ? 'glm' : s.includes('kimi') ? 'kimi' : 'other');
  const base = { lane: 'standard' as const, stakes: 0.1, images: false, seat: 'glm-gateway' };
  const evidence = (s: string) => ({ 'glm-gateway': ev(4.8, 34), 'deepseek-flash': ev(5, 8), 'glm-5.3': ev(5, 11), 'kimi-k3': ev(5, 18) } as Record<string, ModelEvidence>)[s] ?? null;
  const pick = pickModel({ ...base, candidates: [card('glm-gateway'), card('deepseek-flash'), card('glm-5.3'), card('kimi-k3')], evidence });

  it('a pick sharing the checker family moves to the best other-family candidate that still beats the seat', () => {
    expect(pick.spec).toBe('deepseek-flash');
    const g = pickAvoidingFamily(pick, 'deepseek', fam);
    expect(g).toMatchObject({ spec: 'glm-5.3', changed: true, expectedTtftMs: 11_000 });
    expect(g.reason).toMatch(/shares the Double Checker's deepseek family/);
  });

  it('no checker, a different family, or the guard finds nothing better ⇒ unchanged / seat', () => {
    expect(pickAvoidingFamily(pick, null, fam)).toBe(pick);
    expect(pickAvoidingFamily(pick, 'kimi', fam)).toBe(pick);
    const onlyDs = pickModel({ ...base, candidates: [card('glm-gateway'), card('deepseek-flash')], evidence });
    expect(pickAvoidingFamily(onlyDs, 'deepseek', fam)).toMatchObject({ spec: 'glm-gateway', changed: false });
  });
});

describe('the Quick lane never halves its wait price (relaxed lookups reach Quick at stakes 0.6–0.75)', () => {
  it('waitPrice(quick) is the full rate at any stakes; other lanes still halve at HIGH_STAKES', () => {
    expect(waitPrice('quick', 0.62)).toBe(waitPrice('quick', 0.1));
    expect(waitPrice('standard', 0.62)).toBe(waitPrice('standard', 0.1) / 2);
  });
});

describe('tail-aware waiting cost', () => {
  it('the expected wait is the mean of p50 and p90 when the p90 is known', () => {
    expect(expectedWaitMs({ ttftP50Ms: 60_000, ttftP90Ms: 260_000 })).toBe(160_000);
    expect(expectedWaitMs({ ttftP50Ms: 60_000, ttftP90Ms: null })).toBe(60_000);
    expect(expectedWaitMs({ ttftP50Ms: 60_000, ttftP90Ms: 40_000 })).toBe(60_000);
  });

  it('an erratic seat loses a high-stakes checked turn to a steady model of equal quality', () => {
    const evidence = (s: string) => ({ seat: ev(5, 60, { ttftP90Ms: 260_000 }), steady: ev(5, 11, { ttftP90Ms: 25_000 }) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickModel({ lane: 'checked', stakes: 0.9, images: false, seat: 'seat', candidates: [card('seat'), card('steady')], evidence });
    expect(p).toMatchObject({ spec: 'steady', changed: true });
    // median-only, the same pair stayed on the seat (gain under the margin)
    const medianOnly = (s: string) => ({ seat: ev(5, 60), steady: ev(5, 11) } as Record<string, ModelEvidence>)[s] ?? null;
    expect(pickModel({ lane: 'checked', stakes: 0.9, images: false, seat: 'seat', candidates: [card('seat'), card('steady')], evidence: medianOnly }).changed).toBe(false);
  });
});

// ── roster 2026-10-06 C-1: the COST term — "access to any and all models", but price matters ────────────────────
describe('the price of a turn', () => {
  it('a nominal turn priced from the card; an unknown open price takes the meter default, an unknown frontier price the conservative top', () => {
    expect(turnCostUsd({ priceIn: 0.15, priceOut: 0.6 })).toEqual({ usd: Number(((0.15 * PICK_TURN_TOKENS_IN + 0.6 * PICK_TURN_TOKENS_OUT) / 1e6).toFixed(4)), priced: true });
    expect(turnCostUsd({}).usd).toBeCloseTo((UNKNOWN_OPEN_PRICE.in * PICK_TURN_TOKENS_IN + UNKNOWN_OPEN_PRICE.out * PICK_TURN_TOKENS_OUT) / 1e6, 4);
    expect(turnCostUsd({ frontier: true })).toEqual({ usd: Number(((UNKNOWN_FRONTIER_PRICE.in * PICK_TURN_TOKENS_IN + UNKNOWN_FRONTIER_PRICE.out * PICK_TURN_TOKENS_OUT) / 1e6).toFixed(4)), priced: false });
    expect(turnCostUsd({ frontier: true }).usd).toBeGreaterThan(1); // an unpriced frontier model costs > 1 quality point at κ 1
    expect(turnCostUsd(null).priced).toBe(false);
  });
  it('κ is halved on a high-stakes turn; 0 / negative / NaN = no cost', () => {
    expect(costPrice(1, 0.1)).toBe(1);
    expect(costPrice(1, 0.9)).toBe(0.5);
    expect(costPrice(0, 0.1)).toBe(0);
    expect(costPrice(NaN, 0.1)).toBe(0);
  });
  it('utilityOf subtracts κ · USD only when both are given (the pre-cost call shape is unchanged)', () => {
    expect(utilityOf(ev(4, 60), 'standard', 0, 0.25, 1)).toBeCloseTo(4 - 0.6 - 0.25);
    expect(utilityOf(ev(4, 60), 'standard', 0.9, 0.25, 1)).toBeCloseTo(4 - 0.3 - 0.125);
    expect(utilityOf(ev(4, 60), 'standard', 0)).toBeCloseTo(4 - 0.6);
  });
});

// ── The frontier HARD RULE (owner 2026-10-06 late: "pickers should never choose frontier anyway") ─────────────
describe('the frontier hard rule — no automatic pick ever chooses a frontier-class model', () => {
  const prev = process.env.AUTO_PICK_FRONTIER_ENABLED;
  beforeEach(() => { delete process.env.AUTO_PICK_FRONTIER_ENABLED; });
  afterAll(() => { if (prev === undefined) delete process.env.AUTO_PICK_FRONTIER_ENABLED; else process.env.AUTO_PICK_FRONTIER_ENABLED = prev; });
  const base = { lane: 'standard' as const, stakes: 0.1, images: false, seat: 'seat' };
  // The frontier model carries the BEST evidence by far and an auto-eligible card (a store that still says 'all').
  const evidence = (s: string) => ({ seat: ev(3.0, 120), 'cql-litellm:api-anthropic-claude-fable-5-1': ev(5, 5), 'frontier-flag': ev(5, 5), open: ev(3.6, 40) } as Record<string, ModelEvidence>)[s] ?? null;
  it('the lead pick: a frontier card with the best evidence is never ranked, cost term or not; the open runner-up wins', () => {
    const cands = [card('seat'), card('frontier-flag', { frontier: true, autoEligible: true }), card('cql-litellm:api-anthropic-claude-fable-5-1', { autoEligible: true }), card('open')];
    for (const cost of [undefined, { perUsd: 1, priceOf: () => null }]) {
      const p = pickModel({ ...base, candidates: cands, evidence, ...(cost ? { cost } : {}) });
      expect(p.ranked.map((r) => r.spec)).not.toContain('frontier-flag');
      expect(p.ranked.map((r) => r.spec)).not.toContain('cql-litellm:api-anthropic-claude-fable-5-1'); // spec-only classification (no card flag)
      expect(p.spec).toBe('open');
    }
    expect(candidateFits(card('cql:api-openai-gpt-6-astra'), 'standard', { images: false })).toBe(false);
    expect(candidateFits(card('cql:gpt-oss-120b'), 'standard', { images: false })).toBe(true); // open weights stay pickable
  });
  it('the role picks (Quick / checker / colleague) never take a frontier model, even to break a family conflict', () => {
    const fam = (s: string) => (s.includes('claude') || s === 'frontier-flag' ? 'claude' : s.includes('deepseek') ? 'deepseek' : 'glm');
    for (const role of ['quick', 'checker', 'colleague'] as const) {
      const p = pickForRole({
        role, stakes: 0.9, images: false, seat: 'deepseek-seat', familyOf: fam, avoidFamilies: ['deepseek'], exclude: ['deepseek-seat'],
        candidates: [card('frontier-flag', { frontier: true, thinkingOff: true, family: 'claude' }), card('cql:api-anthropic-claude-x', { thinkingOff: true, family: 'claude' })],
        evidence: (s) => (s === 'deepseek-seat' ? ev(4, 30) : ev(5, 5)),
      });
      expect(p.spec).toBe('deepseek-seat');
      expect(p.ranked).toEqual([]);
    }
  });
  it('AUTO_PICK_FRONTIER_ENABLED=1 (env only) restores the C-1 admission', () => {
    process.env.AUTO_PICK_FRONTIER_ENABLED = '1';
    const p = pickModel({ ...base, candidates: [card('seat'), card('frontier-flag', { frontier: true })], evidence });
    expect(p.spec).toBe('frontier-flag');
  });
});

describe('pickModel with cost — under the env opt-in a frontier model wins only when its quality / speed justifies its price', () => {
  // C-1 behaviour, reachable only through AUTO_PICK_FRONTIER_ENABLED=1 since the 2026-10-06 (late) hard rule.
  const prev = process.env.AUTO_PICK_FRONTIER_ENABLED;
  beforeAll(() => { process.env.AUTO_PICK_FRONTIER_ENABLED = '1'; });
  afterAll(() => { if (prev === undefined) delete process.env.AUTO_PICK_FRONTIER_ENABLED; else process.env.AUTO_PICK_FRONTIER_ENABLED = prev; });
  const base = { lane: 'standard' as const, stakes: 0.1, images: false, seat: 'seat' };
  const cards: PickCandidate[] = [card('seat', { priceIn: 0.6, priceOut: 2.2 }), card('frontier-a', { frontier: true }), card('frontier-priced', { frontier: true, priceIn: 1.25, priceOut: 10 }), card('cheap', { priceIn: 0.15, priceOut: 0.6 })];
  const priceOf = (s: string) => cards.find((c) => c.spec === s) ?? null;
  it('an unpriced frontier model of slightly better quality loses to the open seat once priced; without the cost term it would have won', () => {
    const evidence = (s: string) => ({ seat: ev(4.2, 30), 'frontier-a': ev(4.6, 25) } as Record<string, ModelEvidence>)[s] ?? null;
    expect(pickModel({ ...base, candidates: cards, evidence }).spec).toBe('frontier-a');
    const priced = pickModel({ ...base, candidates: cards, evidence, cost: { perUsd: 1, priceOf } });
    expect(priced.spec).toBe('seat');
    expect(priced.ranked.find((r) => r.spec === 'frontier-a')?.usd).toBeGreaterThan(1);
  });
  it('a frontier model whose quality clearly justifies its (admin-set) price still wins', () => {
    const evidence = (s: string) => ({ seat: ev(3.6, 30), 'frontier-priced': ev(4.8, 20) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickModel({ ...base, candidates: cards, evidence, cost: { perUsd: 1, priceOf } });
    expect(p).toMatchObject({ spec: 'frontier-priced', changed: true });
    expect(p.reason).toMatch(/\$0\.\d{3}\/turn/);
  });
  it('price breaks a quality tie toward the cheaper model', () => {
    const evidence = (s: string) => ({ seat: ev(4.4, 30), cheap: ev(4.4, 30) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickModel({ ...base, candidates: cards, evidence, cost: { perUsd: 5, priceOf } });
    expect(p.ranked[0].spec).toBe('cheap');
  });
  it('a model with no bench evidence is never picked, frontier or not (no live exploration)', () => {
    const evidence = (s: string) => (s === 'seat' ? ev(3, 120) : null);
    expect(pickModel({ ...base, candidates: cards, evidence, cost: { perUsd: 1, priceOf } }).changed).toBe(false);
  });
  it('an auto-ineligible card (policy open_only) never ranks', () => {
    const evidence = (s: string) => ({ seat: ev(3, 120), 'frontier-a': ev(5, 5) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickModel({ ...base, candidates: [card('seat'), card('frontier-a', { frontier: true, autoEligible: false })], evidence });
    expect(p.changed).toBe(false);
  });
});

// ── roster 2026-10-06 C-3: ROLE picks (Quick model, checker, colleagues) ─────────────────────────────────────
describe('pickForRole', () => {
  const fam = (s: string) => (s.includes('deepseek') ? 'deepseek' : s.includes('glm') ? 'glm' : s.includes('kimi') ? 'kimi' : s.includes('qwen') ? 'qwen' : 'other');
  const fcard = (spec: string, o: Partial<PickCandidate> = {}): PickCandidate => card(spec, { family: fam(spec), ...o });

  it('checker: never the lead family — a seat that shares it is replaced by the best measured other-family model without the margin', () => {
    const evidence = (s: string) => ({ 'ds-seat-deepseek': ev(4.6, 20), 'glm-5.3': ev(4.6, 25), 'kimi-k3': ev(4.7, 40) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickForRole({ role: 'checker', stakes: 0.1, images: false, seat: 'ds-seat-deepseek', candidates: [fcard('deepseek-flash'), fcard('glm-5.3'), fcard('kimi-k3')], evidence, familyOf: fam, avoidFamilies: ['deepseek'], exclude: ['deepseek-flash'] });
    expect(p).toMatchObject({ role: 'checker', changed: true, familyForced: true });
    expect(['glm-5.3', 'kimi-k3']).toContain(p.spec);
    expect(p.reason).toMatch(/shares the lead's deepseek family/);
  });

  it('checker: the forced switch never takes a model materially worse than the seat; nothing measured ⇒ the seat stands', () => {
    const evidence = (s: string) => ({ 'ds-seat-deepseek': ev(4.8, 20), 'glm-5.3': ev(4.0, 10) } as Record<string, ModelEvidence>)[s] ?? null;
    expect(pickForRole({ role: 'checker', stakes: 0, images: false, seat: 'ds-seat-deepseek', candidates: [fcard('glm-5.3')], evidence, familyOf: fam, avoidFamilies: ['deepseek'] }))
      .toMatchObject({ spec: 'ds-seat-deepseek', changed: false, familyForced: false });
    expect(pickForRole({ role: 'checker', stakes: 0, images: false, seat: 'ds-seat-deepseek', candidates: [fcard('kimi-k3')], evidence: () => null, familyOf: fam, avoidFamilies: ['deepseek'] }).reason)
      .toMatch(/no measured other-family candidate — seat stands/);
  });

  it('checker of another family than the lead: the ordinary margin rule (an unmeasured seat ⇒ no switch)', () => {
    const evidence = (s: string) => ({ 'glm-5.3': ev(4.6, 25) } as Record<string, ModelEvidence>)[s] ?? null;
    expect(pickForRole({ role: 'checker', stakes: 0, images: false, seat: 'kimi-seat', candidates: [fcard('glm-5.3')], evidence, familyOf: fam, avoidFamilies: ['deepseek'] }))
      .toMatchObject({ spec: 'kimi-seat', changed: false });
  });

  it('colleagues: the second slot avoids the first slot\'s family and spec as well as the lead\'s', () => {
    const evidence = (s: string) => ({ 'kimi-seat': ev(4.0, 60), 'glm-5.3': ev(4.6, 25), 'glm-other': ev(4.7, 20), 'qwen-max': ev(4.5, 30) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickForRole({ role: 'colleague', stakes: 0, images: false, seat: 'kimi-seat', candidates: [fcard('glm-5.3'), fcard('glm-other'), fcard('qwen-max')], evidence, familyOf: fam, avoidFamilies: ['deepseek', 'glm'], exclude: ['deepseek-flash', 'glm-5.3'] });
    expect(p.spec).toBe('qwen-max');
  });

  it('quick: only a model whose thinking the lane can switch off (no-think registry, DeepSeek built-in) — or the seat', () => {
    expect(quickThinkingOffCapable(fcard('cql:glm-thinker', { source: 'registry' }), 'seat', fam)).toBe(false);
    expect(quickThinkingOffCapable(fcard('cql:fast-nothink', { source: 'registry', thinkingOff: true }), 'seat', fam)).toBe(true);
    expect(quickThinkingOffCapable(fcard('deepseek-flash', { source: 'builtin' }), 'seat', fam)).toBe(true);
    expect(quickThinkingOffCapable(fcard('glm-5.3', { source: 'builtin' }), 'seat', fam)).toBe(false);
    expect(quickThinkingOffCapable(fcard('seat'), 'seat', fam)).toBe(true);
    // the fastest measured thinking-off route wins the Quick slot (the slow gateway seat loses)
    const evidence = (s: string) => ({ 'qwen-gw-seat': ev(4.2, 68, { ttftP90Ms: 156_000 }), 'deepseek-flash': ev(4.3, 20), 'glm-5.3': ev(4.6, 9) } as Record<string, ModelEvidence>)[s] ?? null;
    const p = pickForRole({ role: 'quick', stakes: 0, images: false, seat: 'qwen-gw-seat', candidates: [fcard('qwen-gw-seat'), fcard('deepseek-flash', { source: 'builtin' }), fcard('glm-5.3', { source: 'builtin' })], evidence, familyOf: fam });
    expect(p).toMatchObject({ spec: 'deepseek-flash', changed: true, role: 'quick' });
  });
});

describe('rankForRole — the call_in candidate order (roster 2026-10-06 C-3)', () => {
  const items = [{ spec: 'pool-first', family: 'qwen' }, { spec: 'unmeasured', family: 'kimi' }, { spec: 'best', family: 'deepseek' }, { spec: 'pricey', family: 'claude' }];
  const evidence = (s: string) => ({ 'pool-first': ev(4.0, 60), best: ev(4.6, 20), pricey: ev(4.7, 20) } as Record<string, ModelEvidence>)[s] ?? null;
  it('measured candidates first, best utility first; unmeasured keep the caller\'s order after them; nothing dropped; extra fields kept', () => {
    const r = rankForRole('checker', items, { stakes: 0, evidence });
    expect(r.map((x) => x.spec)).toEqual(['pricey', 'best', 'pool-first', 'unmeasured']);
    expect(r[0].family).toBe('claude');
    expect(r[3].utility).toBeNull();
  });
  it('with a cost weight an unpriced frontier model falls behind a cheap model of nearly equal quality', () => {
    const cards: Record<string, PickCandidate> = { pricey: card('pricey', { frontier: true }), best: card('best', { priceIn: 0.15, priceOut: 0.6 }) };
    const r = rankForRole('checker', items, { stakes: 0, evidence, cost: { perUsd: 1, priceOf: (s) => cards[s] ?? null } });
    expect(r.map((x) => x.spec).slice(0, 2)).toEqual(['best', 'pool-first']);
    expect(r.find((x) => x.spec === 'pricey')!.usd).toBeGreaterThan(1);
  });
});

// ── 2026-10-20 task-aware pick: quality compared on the turn's KIND buckets ─────────────────────────────────────
describe('pickModel — kind-keyed (task-aware pick)', () => {
  const base = { lane: 'standard' as const, stakes: 0.1, images: false, seat: 'seat' };
  const cands = [card('seat'), card('writer'), card('coder'), card('nokind')];
  const lane = (q: number, o: Partial<ModelEvidence> = {}) => ev(q, 30, { qualityKey: 'all', ...o });
  const kindQ = (q: number, qualityN = 20, o: Partial<ModelEvidence> = {}) => ev(q, 30, { qualityKey: 'kind', qualityN, ...o });
  /** Mirrors model-evidence.ts evidenceFrom: a model without a bucket for the kind answers its lane evidence. */
  const mkEvidence = (laneEv: Record<string, ModelEvidence>, kindEv: Record<string, Record<string, ModelEvidence>>) =>
    (s: string, _l: string, kind?: string | null) => (kind ? kindEv[kind]?.[s] ?? laneEv[s] ?? null : laneEv[s] ?? null);
  // Every model looks the same on the LANE (the audit's byte-identical ranking); the writing bench separates them.
  const LANE = { seat: lane(4.0), writer: lane(4.0), coder: lane(4.0), nokind: lane(4.05) };
  const KIND = { writing: { seat: kindQ(3.3), writer: kindQ(4.7), coder: kindQ(3.5) } };

  it('kind precedence: the lane pick keeps the seat; the kind-keyed pick leads with the model that writes best', () => {
    const evidence = mkEvidence(LANE, KIND);
    const lanePick = pickModel({ ...base, candidates: cands, evidence });
    expect(lanePick).toMatchObject({ spec: 'seat', changed: false });
    expect(lanePick.kind).toBeUndefined();
    const p = pickModel({ ...base, candidates: cands, evidence, kind: 'writing' });
    expect(p).toMatchObject({ spec: 'writer', changed: true, kind: 'writing', seat: 'seat' });
    expect(p.reason).toMatch(/^writer .* over seat seat .* on standard; kind writing \(margin 0\.51\)$/);
    expect(p.ranked.every((r) => r.qk === 'kind')).toBe(true);
    expect(p.ranked.find((r) => r.spec === 'writer')!.margin).toBeCloseTo(kindSwitchMargin(20, 20), 3);
    expect(p.ranked.find((r) => r.spec === 'seat')!.margin).toBeUndefined();
  });

  it('candidates WITHOUT a bucket for the kind sit the turn out (ranks from different bench fields are not one scale)', () => {
    const evidence = mkEvidence(LANE, KIND);
    const p = pickModel({ ...base, candidates: cands, evidence, kind: 'writing' });
    expect(p.ranked.map((r) => r.spec)).not.toContain('nokind');
    // only a kind-less alternative is measured ⇒ the seat stands, and the reason says why
    const only = pickModel({ ...base, candidates: [card('seat'), card('nokind')], evidence, kind: 'writing' });
    expect(only).toMatchObject({ spec: 'seat', changed: false, kind: 'writing' });
    expect(only.reason).toBe('no measured alternative with a writing bucket on standard (1 measured without one); kind writing');
  });

  it('an unjudged kind bucket (infinite margin) sits the turn out instead of being ranked at the lane margin', () => {
    const evidence = mkEvidence(LANE, { writing: { seat: kindQ(3.3), writer: kindQ(4.7, 0) } });
    const p = pickModel({ ...base, candidates: cands, evidence, kind: 'writing' });
    expect(p.ranked.map((r) => r.spec)).not.toContain('writer');
    expect(p.spec).toBe('seat');
  });

  it('the chosen candidate is always in the returned ranking, even below the top 5', () => {
    const thin = Object.fromEntries(['t1', 't2', 't3', 't4', 't5'].map((s) => [s, kindQ(4.55, 8)]));
    const evidence = mkEvidence({ ...LANE, ...Object.fromEntries(Object.keys(thin).map((s) => [s, lane(4.0)])), deep: lane(4.0) },
      { writing: { seat: kindQ(3.3, 400), ...thin, deep: kindQ(4.1, 400) } });
    const p = pickModel({ ...base, candidates: [card('seat'), ...Object.keys(thin).map((s) => card(s)), card('deep')], evidence, kind: 'writing' });
    expect(p.changed).toBe(true);
    expect(p.ranked.map((r) => r.spec)).toContain(p.spec);
  });

  it('a kind bucket ranked in ANOTHER bench run than the seat\'s sits the turn out (comparative ranks are field-relative)', () => {
    const evidence = mkEvidence(LANE, { writing: { seat: kindQ(3.3, 20, { qualityRunId: 'mbk-a' }), writer: kindQ(4.7, 20, { qualityRunId: 'mbk-b' }), coder: kindQ(3.5, 20, { qualityRunId: 'mbk-a' }) } });
    const p = pickModel({ ...base, candidates: cands, evidence, kind: 'writing' });
    expect(p.ranked.map((r) => r.spec)).not.toContain('writer');
    expect(p.spec).not.toBe('writer');
    // same run ⇒ compared as before
    const same = mkEvidence(LANE, { writing: { seat: kindQ(3.3, 20, { qualityRunId: 'mbk-a' }), writer: kindQ(4.7, 20, { qualityRunId: 'mbk-a' }) } });
    expect(pickModel({ ...base, candidates: cands, evidence: same, kind: 'writing' }).spec).toBe('writer');
  });

  it('a seat with NO bucket for the kind ⇒ the lane comparison, exactly as without a kind (the reason names the kind)', () => {
    const evidence = mkEvidence({ ...LANE, nokind: lane(4.5) }, { writing: { writer: kindQ(4.9), coder: kindQ(3.5) } });
    const without = pickModel({ ...base, candidates: cands, evidence });
    const withKind = pickModel({ ...base, candidates: cands, evidence, kind: 'writing' });
    expect(withKind.spec).toBe(without.spec);
    expect(withKind.spec).toBe('nokind'); // the lane evidence's own winner — the writer's kind bucket is never weighed against lane numbers
    expect(withKind.ranked.map((r) => [r.spec, r.utility])).toEqual(without.ranked.map((r) => [r.spec, r.utility]));
    expect(withKind.kind).toBeUndefined();
    expect(withKind.reason).toBe(`${without.reason}; kind writing: seat has no writing bench bucket — lane evidence`);
  });

  it('the SE-scaled margin: thin kind buckets cannot flip the lead on a gap a deep pair clears', () => {
    expect(kindSwitchMargin(8, 8)).toBeCloseTo(RANK_QUALITY_SD * KIND_MARGIN_Z * 0.5, 9); // 0.80
    expect(kindSwitchMargin(30, 30)).toBeCloseTo(1.6 * Math.sqrt(2 / 30), 9); // ≈ 0.41
    expect(kindSwitchMargin(100_000, 100_000)).toBe(SWITCH_MARGIN); // never below the lane margin
    expect(kindSwitchMargin(0, 20)).toBe(Number.POSITIVE_INFINITY);
    const gap = (n: number) => mkEvidence(LANE, { writing: { seat: kindQ(3.8, n), writer: kindQ(4.5, n) } });
    expect(pickModel({ ...base, candidates: cands, evidence: gap(8), kind: 'writing' })).toMatchObject({ spec: 'seat', changed: false });
    expect(pickModel({ ...base, candidates: cands, evidence: gap(8), kind: 'writing' }).reason).toMatch(/− margin 0\.80; kind writing$/);
    expect(pickModel({ ...base, candidates: cands, evidence: gap(40), kind: 'writing' })).toMatchObject({ spec: 'writer', changed: true });
  });

  it('the best-ranked candidate that clears ITS margin leads: a deeply measured runner-up beats a thinly measured top', () => {
    const evidence = mkEvidence(LANE, { writing: { seat: kindQ(3.5, 200), writer: kindQ(4.0, 8), coder: kindQ(3.9, 200) } });
    const p = pickModel({ ...base, candidates: cands, evidence, kind: 'writing' });
    expect(p.ranked[0].spec).toBe('writer'); // top by utility (+0.5) but its margin is 0.58
    expect(p).toMatchObject({ spec: 'coder', changed: true }); // +0.4 over a 0.16 margin
  });

  it('QUALITY_SLACK still guards a kind-keyed switch (never a faster, materially worse writer)', () => {
    const evidence = mkEvidence(LANE, { writing: { seat: ev(4.5, 300, { qualityKey: 'kind', qualityN: 100 }), writer: ev(4.0, 10, { qualityKey: 'kind', qualityN: 100 }) } });
    const p = pickModel({ ...base, candidates: cands, evidence, kind: 'writing' });
    expect(p).toMatchObject({ spec: 'seat', changed: false });
    expect(p.reason).toMatch(/quality 4\.00 < seat 4\.50/);
  });

  it("the family guard honours a kind-keyed candidate's own margin", () => {
    const evidence = mkEvidence(LANE, { writing: { seat: kindQ(3.0, 20), writer: kindQ(4.8, 20), coder: kindQ(3.4, 20) } });
    const p = pickModel({ ...base, candidates: cands, evidence, kind: 'writing' });
    expect(p.spec).toBe('writer');
    const fam = (s: string) => (s === 'writer' ? 'deepseek' : 'glm');
    // coder beats the seat by 0.4 utility — over SWITCH_MARGIN, under its 0.51 kind margin ⇒ the seat stands
    expect(pickAvoidingFamily(p, 'deepseek', fam)).toMatchObject({ spec: 'seat', changed: false });
  });
});
