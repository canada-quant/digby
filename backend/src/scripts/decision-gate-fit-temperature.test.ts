/**
 * decision-gate:fit CLI (E1 ruler) — the entry must RESOLVE from the prod
 * image (2026-09-25 defect: the image had no scripts/ dir and no tsx). Pins:
 * the script lives under src/scripts/ (so `tsc` compiles it into dist/),
 * the npm script prefers the compiled dist entry and falls back to tsx over
 * src, the repo-root wrapper points at the new location, and the module's
 * pure builders match the worker job (same builder, every purpose stamped).
 */

jest.mock('../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import fs from 'fs';
import path from 'path';
import { ACT_POLICIES } from '../modules/crossmodel/platform/decision-gate-fit';
import { buildReadiness, buildReport, parseArgs } from './decision-gate-fit-temperature';

const backendRoot = path.resolve(__dirname, '..', '..');

describe('decision-gate:fit entry resolution', () => {
  it('the CLI source lives under src/scripts (inside tsconfig rootDir) so the build ships dist/scripts/decision-gate-fit-temperature.js', () => {
    expect(fs.existsSync(path.join(backendRoot, 'src', 'scripts', 'decision-gate-fit-temperature.ts'))).toBe(true);
    expect(fs.existsSync(path.join(backendRoot, 'scripts', 'decision-gate-fit-temperature.ts'))).toBe(false);
    const tsconfig = JSON.parse(fs.readFileSync(path.join(backendRoot, 'tsconfig.json'), 'utf8'));
    expect(tsconfig.compilerOptions.rootDir).toBe('./src');
    expect(tsconfig.include).toContain('src/**/*');
  });

  it('npm run decision-gate:fit runs the compiled entry when dist exists and tsx over src otherwise', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8'));
    const script: string = pkg.scripts['decision-gate:fit'];
    expect(script).toContain('dist/scripts/decision-gate-fit-temperature.js');
    expect(script).toContain('tsx src/scripts/decision-gate-fit-temperature.ts');
    expect(script).not.toContain('tsx scripts/');
    // `npm run … -- --days=14` appends the args after the sh -c "$0" placeholder, so "$@" carries them.
    expect(script).toMatch(/"\$@"/);
  });

  it('the repo-root wrapper and the Dockerfile point at the new location', () => {
    const wrapper = fs.readFileSync(path.join(backendRoot, '..', 'scripts', 'decision-gate-fit-temperature.ts'), 'utf8');
    expect(wrapper).toContain("resolve(backendDir, 'src', 'scripts', 'decision-gate-fit-temperature.ts')");
    const dockerfile = fs.readFileSync(path.join(backendRoot, 'Dockerfile'), 'utf8');
    // dist/ ships in the production stage (COPY --chown since deploy_speedups #2, 2026-09-26).
    expect(dockerfile).toMatch(/COPY --from=build(?: --chown=\S+)? \/app\/dist \.\/dist/);
    expect(dockerfile).toContain('dist/scripts/decision-gate-fit-temperature.js');
  });
});

describe('CLI pure builders', () => {
  it('parseArgs: defaults + every flag', () => {
    expect(parseArgs([])).toEqual({ days: 14, purpose: null, min: 50, json: false, stamp: false });
    expect(parseArgs(['--days=3', '--purpose=wake_triage', '--min=10', '--json', '--stamp'])).toEqual({ days: 3, purpose: 'wake_triage', min: 10, json: true, stamp: true });
    expect(parseArgs(['--days=0', '--purpose=', 'junk'])).toEqual({ days: 14, purpose: null, min: 50, json: false, stamp: false });
  });

  it('buildReadiness without --purpose stamps EVERY ACT_POLICIES purpose (unlabelled ones NOT READY, "no labelled outcomes" first) — the job\'s shape', () => {
    const { report, stamp } = buildReadiness([], { days: 14, now: new Date('2026-09-25T00:00:00Z') });
    expect(Object.keys(stamp).sort()).toEqual(Object.keys(ACT_POLICIES).sort());
    expect(report).toHaveLength(Object.keys(ACT_POLICIES).length);
    for (const e of Object.values(stamp)) {
      expect(e.ready).toBe(false);
      expect(e.reasons[0]).toBe('no labelled outcomes in the window');
      expect(e.at).toBe('2026-09-25T00:00:00.000Z');
      expect(e.windowDays).toBe(14);
    }
  });

  it('buildReadiness with --purpose narrows to that purpose and adds NO empty entries (a single-purpose stamp merges, never erases)', () => {
    const { report, stamp } = buildReadiness([], { days: 14, purpose: 'wake_triage' });
    expect(report).toEqual([]);
    expect(stamp).toEqual({});
  });

  it('buildReport: readout rows with logits fit a temperature; systemone rows fit from their answers (log p) since 2026-09-26 — the built-in jev reported, never autofitted', () => {
    const rows = [
      { meta: { phase: 'decision', id: 'a1', purpose: 'wake_triage', backend: 'DeepSeek logprob readout', logits: { needs_turn_now: { no: -0.01, yes: -4.6 } } } },
      { meta: { phase: 'outcome', id: 'a1', purpose: 'wake_triage', question: 'needs_turn_now', actual: false, acted: false } },
      { meta: { phase: 'decision', id: 'j1', purpose: 'wake_triage', backend: 'TypeSafe Jev', answers: { needs_turn_now: { noul: 0.1 } } } },
      { meta: { phase: 'outcome', id: 'j1', purpose: 'wake_triage', question: 'needs_turn_now', actual: false, acted: false } },
    ];
    const fits = buildReport(rows, { min: 1 });
    expect(fits.map(f => `${f.backend}:${f.n}:${f.ready}:${f.backendSpec}:${f.autofit}`)).toEqual(['DeepSeek logprob readout:1:true:deepseek-flash:true', 'TypeSafe Jev:1:true:jev:false']);
    expect(fits[0].envLine).toMatch(/^DECISION_GATE_TEMP_WAKE_TRIAGE=/);
    expect(fits[0].storeKey).toBe('deepseek-flash|wake_triage');
    expect(fits[1].storeKey).toBe('jev|wake_triage');
    expect(buildReport(rows, { min: 50 }).every(f => !f.ready && !f.autofit)).toBe(true);
  });
});
