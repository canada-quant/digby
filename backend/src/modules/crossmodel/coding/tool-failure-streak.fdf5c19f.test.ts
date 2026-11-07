/**
 * Replay pin — `tool-failure-streak` family dispatched 2026-11-07 (lead
 * fdf5c19f, members 99b06f9e + 189fd078). ONE lane, THREE members, THREE
 * distinct tools — and, verified member by member, TWO distinct verdicts.
 * The family batching heuristic says same-filer/same-signal-class, NOT
 * same-defect; this file records what each member actually was.
 *
 *  · fdf5c19f — `verify`, 3× (session c9868b86 run 7ac48055). NOT A FRAMEWORK
 *    DEFECT: the recorded failure texts are the LANE'S OWN PROJECT pytest
 *    output (`tests/unit/test_store_events.py:259`, `test_dispatch_invalid_on_date_is_invalid_arguments`).
 *    That path does not exist in this repo (asserted below), so no Digby deploy
 *    can have authored the red — under the 251e9329 attribution rule a failure
 *    text naming a `file:line` in the lane's own project is not framework.
 *    verify correctly reported a genuinely red suite; the `^Verify FAILED at`
 *    marker counting it is DELIBERATE and stays unrelaxed (see the pins this
 *    test invokes: agent-derail-break.6a950136 "no platform code change", and
 *    02bf673a "a genuine 'Verify FAILED at typecheck' still counts").
 *
 *  · 189fd078 — `edit_file`, 3× (session df6b926f run c00e725c). MODEL
 *    BEHAVIOR, guard correct: three genuine authored refusals on
 *    backend/src/modules/users/users.service.ts, and the THIRD refusal's hint
 *    named the exact defect ("matches at DIFFERENT INDENTATION — the file's
 *    block starts at line 130 indented 12 char(s)") — the hint WORKED. The
 *    streak is the d2e6b0fb design doing its job; markers below must keep
 *    firing on all three shapes.
 *
 *  · 99b06f9e — `goal_premise_set`, 3× (session c9868b86 run fad39f29). THE ONE
 *    REAL DEFECT THIS FILE FIXES, and the af24badf class in its purest form: the
 *    DEAD END was authored by the framework's own CONTRACT. Both teaching sites
 *    prescribed `<kpi key>:diag` (platform-tools.ts key schema, role-profiles.ts
 *    Mission KPI contract), but `isKpiPremise` classifies ANY `kpi:` prefix as
 *    the KPI of record, so the taught spelling was refused as a SECOND KPI —
 *    and the refusal named no landing key. The caller repeated it and tripped
 *    the breaker.
 *
 * WHAT THIS FILE ASSERTS: the guards stay EXACTLY as strict (one KPI per goal,
 * all three edit_file shapes still failure-shaped), the two guidance sites no
 * longer teach the refused spelling, and the second-KPI refusal now NAMES the
 * landing key so the taught mistake costs ONE round-trip instead of a streak.
 *
 * Boundary mocks mirror premise-register.kpi.test.ts (the module imports
 * prisma/redis) plus logger/loop-metrics for learnings-index.service.
 */
const mockPrisma: any = {
  projectGoal: { findMany: jest.fn(async () => []), findUnique: jest.fn(async () => null), update: jest.fn(async () => ({})) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) } }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: [],
  isLoopMetricKind: jest.fn(() => false),
}));
jest.mock('../memory/context-store', () => ({ __esModule: true, storeGet: jest.fn(async () => null), storePut: jest.fn(async () => {}) }));
jest.mock('../memory/unified-memory.service', () => ({
  __esModule: true,
  memReplaceRef: jest.fn(async () => {}),
  memSearch: jest.fn(async () => []),
}));

import * as fs from 'fs';
import * as path from 'path';
import { looksLikeToolFailure } from './learnings-index.service';
import { normalizePremises, kpiDiagLandingAdvice, type GoalPremise } from '../platform/premise-register';

const RID_A = 'aaaa1111-2222-4000-8000-000000000000';
const T1 = new Date('2026-11-06T14:59:00.614Z');

// ── Member 99b06f9e — the real defect ───────────────────────────────────────
describe('99b06f9e — a taught `kpi:<name>:diag` key is no longer a dead end', () => {
  // The ticket's own goal: a plain rate already registered as the KPI.
  const GOAL: GoalPremise[] = [
    { key: 'kpi:games_flowing_to_sim', value: 8, unit: 'games', kind: 'kpi', receiptId: RID_A } as GoalPremise,
  ];

  it('REPLAY of the filed call: the taught `kpi:<name>:diag` spelling is still REFUSED (the guard is correct)', () => {
    // The filed call carried a receiptId (ticket call args: "receiptId": "548ba20f"),
    // so it reaches the one-per-goal branch, not the receipt rule.
    const r = normalizePremises(
      [{ key: 'kpi:games_flowing_to_sim:diag', value: 8, unit: 'games', receiptId: RID_A, note: 'diagnostic window' } as any],
      GOAL, { mode: 'merge', now: T1 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The guard is unchanged: a `kpi:`-prefixed diagnostic is a SECOND KPI, and
    // it would really have become the of-record number. Never relaxed.
    expect(r.error).toContain('at most ONE kpi: premise');
    expect(r.error).toContain('kpi:games_flowing_to_sim:diag');
    expect((r as any).kpiRefusal).toEqual({ reason: 'second_kpi', key: expect.stringContaining('games_flowing_to_sim:diag') });
  });

  it('THE FIX: that refusal now NAMES the landing key, so the taught mistake costs ONE round-trip', () => {
    const r = normalizePremises(
      [{ key: 'kpi:games_flowing_to_sim:diag', value: 8, unit: 'games', receiptId: RID_A, note: 'diagnostic window' } as any],
      GOAL, { mode: 'merge', now: T1 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // The bare landing key is spelled out — drop the prefix, keep the reading.
    expect(r.error).toContain('"games_flowing_to_sim:diag"');
    expect(r.error).toContain('Drop the `kpi:` prefix');
    // …and it warns off the bar fields that are dead on a non-KPI key, so the
    // follow-up call does not trip the barDirection refusal instead.
    expect(r.error).toContain('dead on a non-KPI key');
  });

  it('the OTHER leg of the same call — the receipt rule — no longer offers a doubled `:diag:diag`', () => {
    // A receipt-less `kpi:<name>:diag` is refused by the receipt rule first.
    const r = normalizePremises(
      [{ key: 'kpi:games_flowing_to_sim:diag', value: 8, unit: 'games', note: 'diagnostic window' } as any],
      GOAL, { mode: 'merge', now: T1 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('set ONLY from a this-wake run_command receipt id');
    // It used to name `games_flowing_to_sim:diag:diag` — legal, but nonsense.
    expect(r.error).not.toContain(':diag:diag');
    expect(r.error).toContain('"games_flowing_to_sim:diag"');
    // And that offered key really does land (af24badf: never advise a refusal).
    const landed = normalizePremises(
      [{ key: 'games_flowing_to_sim:diag', value: 8, unit: 'games', note: 'diagnostic window' } as any],
      GOAL, { mode: 'merge', now: T1 },
    );
    expect(landed.ok).toBe(true);
  });

  it('the named landing key ACTUALLY LANDS on that goal — the advice never dead-ends (af24badf rule)', () => {
    const landed = normalizePremises(
      [{ key: 'games_flowing_to_sim:diag', value: 8, unit: 'games', note: 'diagnostic window; ceiling 12 games' } as any],
      GOAL, { mode: 'merge', now: T1 },
    );
    expect(landed.ok).toBe(true);
    if (!landed.ok) return;
    const diag = landed.premises.find((p) => p.key === 'games_flowing_to_sim:diag');
    expect(diag).toBeDefined();
    // It is a plain reading, NOT a second of-record number.
    expect(diag?.kind).toBeUndefined();
    // And the goal still holds exactly ONE kpi: premise.
    expect(landed.premises.filter((p) => String(p.key).toLowerCase().startsWith('kpi:'))).toHaveLength(1);
  });

  it('a plain second rate (no `:diag` shape) still gets the generic rule, with no invented key', () => {
    const advice = kpiDiagLandingAdvice([{ key: 'kpi:a' }, { key: 'some_other_rate' }]);
    expect(advice).toContain('NO `kpi:` prefix');
    expect(advice).not.toContain('Drop the `kpi:` prefix from');
  });

  it('several `kpi:…:diag` keys name every landing key, pluralised', () => {
    const advice = kpiDiagLandingAdvice([{ key: 'kpi:a:diag' }, { key: 'kpi:b:diag' }]);
    expect(advice).toContain('"a:diag", "b:diag"');
    expect(advice).toContain('are the same reading');
  });

  it('FUZZ (adversarial review): every landing key the advice names ACTUALLY LANDS', () => {
    // The af24badf rule as an executable invariant: the advice must never name
    // a write this register would refuse again. Covers the degenerate key
    // shapes that broke the first cut of this fix — a doubled prefix, and a
    // bare that starts with a separator (KEY_RE requires ^[a-z0-9]).
    const DEGENERATE = [
      'kpi:games_flowing_to_sim:diag',
      'kpi:kpi:games_flowing_to_sim:diag', // doubled prefix → strip EVERY one
      'kpi::diag',                          // empty bare → no legal key at all
      'kpi:_x:diag',                        // separator-led bare
      'kpi:-x:diag',
      'kpi:.x:diag',
      `kpi:${'z'.repeat(80)}:diag`,         // over PREMISE_KEY_MAX, must shorten
    ];
    for (const key of DEGENERATE) {
      const advice = kpiDiagLandingAdvice([{ key }]);
      const named = [...advice.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      for (const candidate of named) {
        const landed = normalizePremises([{ key: candidate, value: 1 } as any], GOAL, { mode: 'merge', now: T1 });
        expect({ key, candidate, ok: landed.ok }).toEqual({ key, candidate, ok: true });
        // …and the landed name is never itself a second KPI.
        expect(candidate.toLowerCase().startsWith('kpi:')).toBe(false);
      }
    }
  });

  it('the advice names ONLY keys from THIS call, never the goal\'s existing KPI (adversarial review)', () => {
    // A goal whose existing of-record KPI happens to carry the `:diag` shape —
    // legal, and natural for anyone who followed the OLD contract text. The
    // refusal must not tell the caller to rename a key it never sent.
    const goalWithDiagShapedKpi: GoalPremise[] = [
      { key: 'kpi:games_flowing_to_sim:diag', value: 8, unit: 'games', kind: 'kpi', receiptId: RID_A } as GoalPremise,
    ];
    const r = normalizePremises(
      [{ key: 'kpi:throughput_rate', value: 3, receiptId: RID_A } as any],
      goalWithDiagShapedKpi, { mode: 'merge', now: T1 },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('at most ONE kpi: premise');
    // The caller's own key is named…
    expect(r.error).toContain('kpi:throughput_rate');
    // …and the pre-existing KPI is NOT offered as a landing key to rename.
    expect(r.error).not.toContain('Drop the `kpi:` prefix from the diagnostic key(s): "games_flowing_to_sim:diag"');
  });

  it('neither teaching site prescribes the refused spelling any more (fresh-bytes pin)', () => {
    const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
    const schema = read('../platform/platform-tools.ts');
    const contract = read('../platform/role-profiles.ts');
    // The exact dead-end the lane followed, in both places it was taught.
    expect(schema).not.toContain("Long enough for '<kpi key>:diag'");
    expect(contract).not.toContain('\\`<kpi key>:diag\\`');
    // …replaced by the shape that lands.
    expect(schema).toContain("A diagnostic reading goes under '<name>:diag' with NO `kpi:` prefix");
    expect(contract).toContain('with NO \\`kpi:\\` prefix');
    // The tool's TOP-LEVEL description taught it too (adversarial review: the
    // first cut of this fix missed it — the freshness pin only grepped the
    // property fragment, so it survived).
    expect(schema).not.toContain("diagnostics go under '<key>:diag'");
    expect(schema).toContain("diagnostics go under '<name>:diag' with NO `kpi:` prefix");
  });
});

// ── Member fdf5c19f — verify, model/project side ────────────────────────────
describe('fdf5c19f — a genuinely red suite is verify doing its job, not a framework defect', () => {
  // The ticket's recorded text, as the verify tool renders it (tools.ts: the
  // `Verify FAILED at "<stage>"` envelope + the failing stage's output tail).
  const VERIFY_RED = [
    'Verify FAILED at "test": 2 failing',
    '--- test output tail ---',
    '        out = dispatch("get_store_events", {"on_date": "2026-10-28"})',
    '>       assert out["ok"] is True',
    'E       assert False is True',
    '',
    'tests/unit/test_store_events.py:259: AssertionError',
    '______________ test_dispatch_invalid_on_date_is_invalid_arguments ______________',
    '    def test_dispatch_invalid_on_date_is_invalid_arguments():',
    '        out = dispatch("get_store_events", {"on_date": "not-a-date"})',
    '>       assert out["ok"] is False and out["error"]["code"] == "invalid_arguments"',
  ].join('\n');

  it('still counts toward the breaker — the pin that stops a future "fix" blinding it', () => {
    expect(looksLikeToolFailure(VERIFY_RED)).toBe(true);
  });

  it('the cited test file is NOT in this repo — proof the red was the LANE\'S OWN project', () => {
    // If this ever starts existing, the attribution below must be re-derived.
    expect(fs.existsSync(path.join(__dirname, '../../../../../tests/unit/test_store_events.py'))).toBe(false);
  });
});

// ── Member 189fd078 — edit_file, model behavior ─────────────────────────────
describe('189fd078 — all three edit_file refusal shapes stay failure-shaped', () => {
  const P = 'backend/src/modules/users/users.service.ts';
  const SHAPES = [
    `old_string appears 3× in ${P} — it must be unique. Add surrounding context. [edit_file hint: occurrences start at lines: 102, 145, 194 — widen old_string with surrounding context unique to your target]`,
    `old_string appears 2× in ${P} — it must be unique. Add surrounding context. [edit_file hint: occurrences start at lines: 139, 188 — widen old_string with surrounding context unique to your target]`,
    `old_string not found in ${P}. Read the file and match exactly. [edit_file hint: old_string matches at DIFFERENT INDENTATION — the file's block starts at line 130 indented 12 char(s); re-read and copy the leading whitespace byte-exactly]`,
  ];

  it('every filed refusal is still counted (guard unchanged — this member needed no fix)', () => {
    for (const s of SHAPES) expect(looksLikeToolFailure(s)).toBe(true);
  });

  it('the third hint NAMED the defect (line + indent + remedy) — evidence the hint worked', () => {
    expect(SHAPES[2]).toContain('line 130');
    expect(SHAPES[2]).toContain('12 char(s)');
    expect(SHAPES[2]).toContain('copy the leading whitespace byte-exactly');
  });
});