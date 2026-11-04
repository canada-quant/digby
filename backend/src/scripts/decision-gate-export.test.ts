/**
 * decision-gate:export + decision-gate:cascade CLIs (Laya follow-up,
 * 2026-09-26): the entries live under src/scripts (shipped in dist/ like the
 * fit CLI), the npm scripts prefer the compiled entry, and the pure builders
 * produce the laya-evals JSONL shape / the cascade curve from loop_metrics rows.
 */

import fs from 'fs';
import path from 'path';
import type { DecisionGateRow } from '../modules/crossmodel/platform/decision-gate-fit';
import { buildExportRecords, parseArgs as parseExportArgs, toJsonl } from './decision-gate-export';
import { buildCascade, parseArgs as parseCascadeArgs, tempsOfRow } from './decision-gate-cascade';

const backendRoot = path.resolve(__dirname, '..', '..');

describe('entry resolution', () => {
  it('both CLIs live under src/scripts and their npm scripts prefer dist/ with a tsx fallback', () => {
    expect(fs.existsSync(path.join(backendRoot, 'src', 'scripts', 'decision-gate-export.ts'))).toBe(true);
    expect(fs.existsSync(path.join(backendRoot, 'src', 'scripts', 'decision-gate-cascade.ts'))).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'));
    for (const [name, file] of [['decision-gate:export', 'decision-gate-export'], ['decision-gate:cascade', 'decision-gate-cascade']]) {
      const script: string = pkg.scripts[name];
      expect(script).toContain(`dist/scripts/${file}.js`);
      expect(script).toContain(`tsx src/scripts/${file}.ts`);
      expect(script).toMatch(/"\$@"/);
    }
  });
});

const stateRow = (id: string, purpose: string, state: string, extra: any = {}): DecisionGateRow =>
  ({ meta: { id, purpose, questionsHash: 'q1', stateChars: state.length, state, questions: { needs_turn_now: { type: 'noul', instructions: 'Needs a turn now?' } }, backendSpec: 'jev', ...extra }, createdAt: new Date('2026-09-26T10:00:00Z') });
const outcome = (id: string, question: string, actual: any, extra: any = {}): DecisionGateRow =>
  ({ meta: { phase: 'outcome', id, purpose: 'wake_triage', question, actual, acted: false, ...extra }, createdAt: new Date('2026-09-26T10:05:00Z') });

describe('decision-gate:export — buildExportRecords', () => {
  it('parseArgs defaults + flags', () => {
    expect(parseExportArgs([])).toEqual({ days: 28, purpose: null, limit: 0, unlabelled: false });
    expect(parseExportArgs(['--purpose=wake_triage', '--days=7', '--limit=10', '--unlabelled'])).toEqual({ days: 7, purpose: 'wake_triage', limit: 10, unlabelled: true });
  });

  it('pairs a sampled state with the PRIMARY labelled outcome rows of the same decision id (one expected key per question); challenger / acted / unlabelled outcomes never label; unlabelled states are skipped unless asked for; purpose filter + limit', () => {
    const states = [
      stateRow('a', 'wake_triage', 'STATE A'),
      stateRow('b', 'wake_triage', 'STATE B', { stateSampleTruncated: true, stateSampledChars: 7 }),
      stateRow('c', 'auto_route', 'STATE C', { questions: { level: { type: 'choice', instructions: 'Level?', criteria: { single_thinking: 'x', thinking: 'y' } } } }),
      stateRow('d', 'wake_triage', 'STATE D'),
    ];
    const outcomes = [
      outcome('a', 'needs_turn_now', false),
      outcome('a', 'code_flag', true),
      outcome('a', 'needs_turn_now', true, { challenger: true, primaryId: 'a', id: 'a~c0' }), // a challenger's own row never labels
      outcome('b', 'needs_turn_now', null),                                                   // unlabelled
      outcome('c', 'level', 'thinking', { purpose: 'auto_route' }),
      outcome('d', 'needs_turn_now', true, { acted: true }),                                  // acted → biased, excluded
    ];
    const all = buildExportRecords(states, outcomes);
    expect(all.map(r => r.id)).toEqual(['a', 'c']);
    expect(all[0]).toEqual({
      state: 'STATE A', questions: { needs_turn_now: { type: 'noul', instructions: 'Needs a turn now?' } },
      expected: { needs_turn_now: 'no', code_flag: 'yes' }, tags: ['wake_triage', 'jev'], id: 'a', stateChars: 7, questionsHash: 'q1', sampledAt: '2026-09-26T10:00:00.000Z',
    });
    expect(all[1].expected).toEqual({ level: 'thinking' });
    expect(all[1].tags).toEqual(['auto_route', 'jev']);
    const wt = buildExportRecords(states, outcomes, { purpose: 'wake_triage', unlabelled: true });
    expect(wt.map(r => r.id)).toEqual(['a', 'b', 'd']);
    expect(wt[1]).toMatchObject({ expected: {}, stateTruncated: true });
    expect(buildExportRecords(states, outcomes, { unlabelled: true, limit: 2 }).map(r => r.id)).toEqual(['a', 'b']);
    // JSONL: one line per record, each a JSON object with the laya-evals keys.
    const lines = toJsonl(all).split('\n');
    expect(lines).toHaveLength(2);
    expect(Object.keys(JSON.parse(lines[0]))).toEqual(expect.arrayContaining(['state', 'questions', 'expected', 'tags']));
  });
});

describe('decision-gate:cascade — CLI builders', () => {
  it('parseArgs defaults + flags (quoted --first is unquoted; out-of-range α / δ / margin fall back)', () => {
    expect(parseCascadeArgs([])).toEqual({ days: 14, purpose: null, first: null, margin: 0.03, alpha: 0.1, delta: 0.05, json: false, temps: true });
    expect(parseCascadeArgs(['--days=14', '--purpose=wake_triage', "--first='cql:agx-laya'", '--margin=0.03', '--alpha=0.2', '--delta=0.1', '--json', '--no-temps']))
      .toEqual({ days: 14, purpose: 'wake_triage', first: 'cql:agx-laya', margin: 0.03, alpha: 0.2, delta: 0.1, json: true, temps: true && false });
    expect(parseCascadeArgs(['--margin=9', '--alpha=0', '--delta=-1'])).toMatchObject({ margin: 0.03, alpha: 0.1, delta: 0.05 });
  });

  it('tempsOfRow keeps only finite positive "<spec>|<purpose>" temps', () => {
    expect(tempsOfRow({ temps: { 'cql:agx-laya|wake_triage': 1.4, 'jev|x': 0, bad: 2, 'a|b': 'x' } })).toEqual({ 'cql:agx-laya|wake_triage': 1.4 });
    expect(tempsOfRow(null)).toEqual({});
  });

  it('buildCascade runs the pairing + curve over loop_metrics rows and carries the pairing stats', () => {
    const rows: DecisionGateRow[] = [];
    for (let i = 0; i < 40; i++) {
      rows.push({ meta: { phase: 'decision', id: `p${i}`, purpose: 'wake_triage', backend: 'TypeSafe Jev', backendSpec: 'jev', ok: true, answers: { needs_turn_now: { noul: 0.05 } }, stateHash: `h${i}` }, createdAt: new Date(`2026-09-2${i % 2}T00:00:00Z`) });
      rows.push({ meta: { phase: 'decision', id: `p${i}~c0`, purpose: 'wake_triage', backend: 'cql (systemone via chat)', backendSpec: 'cql:agx-laya', challenger: true, primaryId: `p${i}`, ok: true, answers: { needs_turn_now: { noul: 0.03 } } }, createdAt: new Date() });
      rows.push({ meta: { phase: 'outcome', id: `p${i}`, purpose: 'wake_triage', question: 'needs_turn_now', actual: false, acted: false }, createdAt: new Date() });
    }
    const curve = buildCascade(rows, { purpose: 'wake_triage', first: 'cql:agx-laya', margin: 0.03 });
    expect(curve.n).toBe(40);
    expect(curve.stats).toEqual({ primaryRows: 40, firstRows: 40, labelled: 40, paired: 40, deduped: 0, degenerate: 0 });
    // 40 rows, 0 errors: LTT allows 0 errors at n=40 → passes for every τ where the band holds all 40 (noul 0.03 ≤ 1 − τ ⇔ τ ≤ 0.97); 0.98 / 0.99 empty → the sequence never starts.
    expect(curve.certifiedTau).toBeNull();
    const curve2 = buildCascade(rows, { purpose: 'wake_triage', first: 'cql:agx-laya', margin: 0.03 });
    expect(curve2.points.find(p => p.tau === 0.97)).toMatchObject({ nBand: 40, errors: 0, errorsAllowed: 0, pass: true });
  });
});
