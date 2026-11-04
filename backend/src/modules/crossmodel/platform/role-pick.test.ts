/** Role picks at run time — the Quick model, the checker, the council colleagues (roster 2026-10-06 C-3). */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockRecordLoopMetric = jest.fn();
jest.mock('./loop-metrics.service', () => ({ __esModule: true, recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a) }));

import { actingSpec, rankCallInCandidates, resolveRolePicks, resolveRolePicksBounded, roleCandidates, type RolePickDeps } from './role-pick';
import type { EvidenceSnapshot } from './model-evidence';
import type { ActDecision } from './roster-policy';

const card = (spec: string, family: string, o: Record<string, unknown> = {}) => ({ spec, name: spec, source: spec.includes(':') ? 'registry' : 'builtin', family, tier: 'fast', vision: true, contextChars: null, maxTools: null, priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false, ...o });
const CATALOG = [
  card('cql:glm-lead', 'glm'),
  card('cql:ds-checker', 'deepseek'),
  card('cql:kimi-triple', 'kimi'),
  card('cql:qwen-quick', 'qwen'),
  card('deepseek-flash', 'deepseek'),
  card('glm-5.3', 'glm'),
  card('qwen-max', 'qwen'),
] as any[];
const POOLS = {
  quick: { role: 'quick', models: ['cql:qwen-quick'], source: 'seats', dropped: [] },
  lead: { role: 'lead', models: ['cql:glm-lead'], source: 'seats', dropped: [] },
  checker: { role: 'checker', models: ['cql:ds-checker'], source: 'seats', dropped: [] },
  colleague: { role: 'colleague', models: ['cql:ds-checker', 'cql:kimi-triple'], source: 'seats', dropped: [] },
} as any;
const b = (q: number, ttftS: number) => ({ lanes: { all: { n: 12, ttftP50Ms: ttftS * 1000, ttftP90Ms: null, failRate: 0, quality: q, qualityN: 12 } } });
const SNAP: EvidenceSnapshot = { at: Date.now(), prod: null, bench: { models: {
  'cql:glm-lead': b(4.4, 40), 'cql:ds-checker': b(4.5, 30), 'cql:qwen-quick': b(4.1, 60), 'cql:kimi-triple': b(4.3, 50),
  'deepseek-flash': b(4.5, 15), 'glm-5.3': b(4.6, 11), 'qwen-max': b(4.6, 30),
} } };
const decision = (d: Partial<ActDecision> = {}): (() => Promise<ActDecision>) => async () => ({ mode: 'shadow', acts: false, canary: false, ...d });
const deps = (over: Partial<RolePickDeps> = {}): RolePickDeps => ({
  decision: decision({ mode: 'act', acts: true }), evidence: async () => SNAP, catalog: async () => CATALOG, pools: async () => POOLS,
  costPerUsd: async () => 0, familyOf: () => 'other', ...over,
});
const rows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m.kind === 'role_pick');

describe('resolveRolePicks', () => {
  beforeEach(() => mockRecordLoopMetric.mockReset());

  it('checker: a glm lead never gets a glm checker; the deepseek seat stands unless an other-family model clearly beats it', async () => {
    const r = await resolveRolePicks({ userId: 'u', lead: 'glm-5.3', stakes: 0.1, images: false, checker: { seat: 'cql:ds-checker' }, sessionId: 's1', lane: 'checked' }, deps());
    expect(r!.checker!.spec).not.toMatch(/glm/);
    expect(['cql:ds-checker', 'deepseek-flash', 'qwen-max']).toContain(r!.checker!.spec);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ kind: 'role_pick', sessionId: 's1', meta: { role: 'checker', seat: 'cql:ds-checker', lead: 'glm-5.3', lane: 'checked', mode: 'act' } });
  });

  it('checker: a deepseek lead + the deepseek checker seat ⇒ the slot moves to the best other-family model (independence)', async () => {
    const r = await resolveRolePicks({ userId: 'u', lead: 'deepseek-flash', stakes: 0.1, images: false, checker: { seat: 'cql:ds-checker' } }, deps());
    expect(r!.checker).toMatchObject({ changed: true, familyForced: true });
    expect(['glm-5.3', 'qwen-max', 'cql:glm-lead', 'cql:kimi-triple']).toContain(r!.checker!.spec);
    expect(actingSpec(r, r!.checker)).toBe(r!.checker!.spec);
  });

  it('colleagues: two slots, distinct specs and families, none of the lead\'s family', async () => {
    const r = await resolveRolePicks({ userId: 'u', lead: 'glm-5.3', stakes: 0, images: false, colleagues: [{ slot: 'double_checker', seat: 'cql:ds-checker' }, { slot: 'triple_checker', seat: 'cql:kimi-triple' }] }, deps());
    const specs = r!.colleagues.map((c) => c.pick.spec);
    expect(new Set(specs).size).toBe(2);
    const fam = (s: string) => CATALOG.find((c) => c.spec === s)?.family;
    expect(specs.map(fam)).not.toContain('glm');
    expect(fam(specs[0])).not.toBe(fam(specs[1]));
    expect(rows().map((m) => m.meta.slot)).toEqual(['double_checker', 'triple_checker']);
  });

  it('quick: the slow seat route loses to a faster measured thinking-off model (a DeepSeek built-in); glm cannot take the Quick lane', async () => {
    const r = await resolveRolePicks({ userId: 'u', lead: 'cql:qwen-quick', stakes: 0, images: false, quick: { seat: 'cql:qwen-quick' } }, deps());
    expect(r!.quick).toMatchObject({ spec: 'deepseek-flash', changed: true });
  });

  it('shadow (a non-canary user): computed and recorded, never acting', async () => {
    const r = await resolveRolePicks({ userId: 'u', lead: 'deepseek-flash', stakes: 0, images: false, checker: { seat: 'cql:ds-checker' } }, deps({ decision: decision() }));
    expect(r!.decision.acts).toBe(false);
    expect(r!.checker!.changed).toBe(true);
    expect(actingSpec(r, r!.checker)).toBeNull();
    expect(rows()[0].meta).toMatchObject({ act: false, mode: 'shadow' });
  });

  it('off (ROLE_PICK_DISABLED=1 or the store): nothing computed, nothing recorded', async () => {
    expect(await resolveRolePicks({ userId: 'u', lead: 'x', stakes: 0, images: false, checker: { seat: 'cql:ds-checker' } }, deps({ decision: decision({ mode: 'off' }) }))).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('fails OPEN: a throwing dependency ⇒ seats (null or unchanged), never an exception', async () => {
    const r = await resolveRolePicks({ userId: 'u', lead: 'glm-5.3', stakes: 0, images: false, checker: { seat: 'cql:ds-checker' } }, deps({ catalog: async () => { throw new Error('db'); }, evidence: async () => { throw new Error('x'); } }));
    expect(r === null || r.checker?.changed === false).toBe(true);
  });

  it('the bounded variant gives up after the wait (the seats run)', async () => {
    const slow = deps({ evidence: () => new Promise((res) => setTimeout(() => res(SNAP), 200)) });
    expect(await resolveRolePicksBounded({ userId: 'u', lead: 'glm-5.3', stakes: 0, images: false, checker: { seat: 'cql:ds-checker' } }, 20, slow)).toBeNull();
  });

  it('frontier hard rule (owner 2026-10-06 late): a frontier model with by far the best evidence — even an auto-eligible card from an old all store — never takes the Quick, checker or colleague slot', async () => {
    const frontier = [
      card('cql:api-anthropic-claude-fable-5-1', 'claude', { frontier: true, thinkingOff: true }),
      card('cql:api-openai-gpt-6-astra', 'gpt', { frontier: true, thinkingOff: true }),
    ];
    const snap: EvidenceSnapshot = { ...SNAP, bench: { models: { ...SNAP.bench!.models, 'cql:api-anthropic-claude-fable-5-1': b(5, 2), 'cql:api-openai-gpt-6-astra': b(5, 2) } } };
    const r = await resolveRolePicks({
      userId: 'u', lead: 'deepseek-flash', stakes: 0.9, images: false, quick: { seat: 'cql:qwen-quick' }, checker: { seat: 'cql:ds-checker' },
      colleagues: [{ slot: 'double_checker', seat: 'cql:ds-checker' }, { slot: 'triple_checker', seat: 'cql:kimi-triple' }],
    }, deps({ catalog: async () => [...CATALOG, ...frontier], evidence: async () => snap, familyOf: (s) => [...CATALOG, ...frontier].find((c) => c.spec === s)?.family ?? 'other' }));
    const chosen = [r!.quick!.spec, r!.checker!.spec, ...r!.colleagues.map((c) => c.pick.spec)];
    for (const s of chosen) expect(s).not.toMatch(/claude|gpt-6/);
    for (const p of [r!.quick!, r!.checker!, ...r!.colleagues.map((c) => c.pick)]) expect(p.ranked.map((x) => x.spec).join(' ')).not.toMatch(/claude|gpt-6/);
  });

  it('roleCandidates: the admin pool when configured, else every catalog card', () => {
    expect(roleCandidates('checker', POOLS, CATALOG).length).toBe(CATALOG.length);
    const pools = { ...POOLS, checker: { role: 'checker', models: ['qwen-max', 'gone'], source: 'pool', dropped: [] } };
    expect(roleCandidates('checker', pools, CATALOG).map((c) => c.spec)).toEqual(['qwen-max']);
  });
});

describe('rankCallInCandidates — the call_in plug-in (Team D pickCallInModels → C-3 utility order)', () => {
  beforeEach(() => mockRecordLoopMetric.mockReset());
  const picks = [{ spec: 'cql:kimi-triple', family: 'kimi' }, { spec: 'qwen-max', family: 'qwen' }, { spec: 'cql:unbenched', family: 'mimo' }];
  it('ACT: re-ordered by utility (measured first), D\'s objects kept; one role_pick row with callIn', async () => {
    const out = await rankCallInCandidates('checker', picks, { userId: 'u', lead: 'glm-5.3', sessionId: 's1' }, deps());
    expect(out.map((p) => p.spec)).toEqual(['qwen-max', 'cql:kimi-triple', 'cql:unbenched']);
    expect(out[0]).toBe(picks[1]);
    expect(rows()[0]).toMatchObject({ sessionId: 's1', meta: { role: 'checker', callIn: true, seat: 'cql:kimi-triple', spec: 'qwen-max', changed: true, act: true } });
  });
  it('SHADOW: D\'s order stands, the would-be order is recorded; OFF: nothing recorded; a failure returns the input', async () => {
    expect((await rankCallInCandidates('checker', picks, { userId: 'u' }, deps({ decision: decision() }))).map((p) => p.spec)).toEqual(picks.map((p) => p.spec));
    expect(rows()[0].meta).toMatchObject({ act: false, changed: true, mode: 'shadow' });
    mockRecordLoopMetric.mockReset();
    expect(await rankCallInCandidates('checker', picks, { userId: 'u' }, deps({ decision: decision({ mode: 'off' }) }))).toEqual(picks);
    expect(rows()).toHaveLength(0);
    expect(await rankCallInCandidates('checker', picks, { userId: 'u' }, deps({ decision: async () => { throw new Error('x'); } }))).toEqual(picks);
  });
});
