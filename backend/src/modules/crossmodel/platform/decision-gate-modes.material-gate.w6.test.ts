/**
 * audit 2026-10-08 W6-2 — while the deterministic material-change gate ACTS,
 * the four Jev "should this supervisor take a turn" purposes are capped at
 * SHADOW (they keep asking beside it for the agreement rows): a stored / env
 * 'act' resolves to shadow (source registry_cap), purposeActCap names the
 * gate + its lift env, the registry row shows the dynamic cap. The cap lifts
 * with SUPERVISOR_MATERIAL_GATE_DISABLED=1 or _SHADOW=1; every other purpose
 * and the static caps are untouched.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { MATERIAL_GATE_ACT_CAP, capDecisionMode, purposeActCap } from './decision-gate-modes';
import { decisionRegistryRow } from './decision-gate-registry';

const KEYS = ['SUPERVISOR_WAKE_LEDGER_IN_TEST', 'SUPERVISOR_MATERIAL_GATE_DISABLED', 'SUPERVISOR_MATERIAL_GATE_SHADOW'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('W6-2 dynamic act cap', () => {
  it('under jest the gate is off ⇒ no dynamic cap (the existing suites see today\'s modes)', () => {
    expect(purposeActCap('wake_triage')).toBeNull();
    expect(capDecisionMode('sweep_triage', { mode: 'act', source: 'store' })).toEqual({ mode: 'act', source: 'store' });
  });

  it('gate ACTING: the four wake purposes resolve act → shadow (registry_cap) with the gate named; others untouched', () => {
    process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST = '1';
    for (const p of ['wake_triage', 'sweep_triage', 'drain_triage', 'supervisor_turn_noop'] as const) {
      expect(purposeActCap(p)).toEqual({ ...MATERIAL_GATE_ACT_CAP, liftEnv: 'SUPERVISOR_MATERIAL_GATE_DISABLED' });
      expect(capDecisionMode(p, { mode: 'act', source: 'store' })).toEqual({ mode: 'shadow', source: 'registry_cap' });
      expect(capDecisionMode(p, { mode: 'shadow', source: 'store' })).toEqual({ mode: 'shadow', source: 'store' });
    }
    expect(MATERIAL_GATE_ACT_CAP.why).toContain('material-change wake gate');
    expect(purposeActCap('auto_route')).toBeNull();
    expect(capDecisionMode('imessage_send', { mode: 'act', source: 'store' })).toEqual({ mode: 'act', source: 'store' });
    // A static cap keeps its own reason (self_audit is in PURPOSE_ACT_CAPS).
    expect(purposeActCap('self_audit')?.liftEnv).toBe('DECISION_GATE_SELF_AUDIT_ACT_CAP_DISABLED');
    expect(decisionRegistryRow('wake_triage').actCap).toEqual({ since: '2026-10-08', why: MATERIAL_GATE_ACT_CAP.why, liftEnv: 'SUPERVISOR_MATERIAL_GATE_DISABLED', active: true });
  });

  it('the kill switch and the observe switch lift the cap (the stored modes govern again)', () => {
    process.env.SUPERVISOR_WAKE_LEDGER_IN_TEST = '1';
    process.env.SUPERVISOR_MATERIAL_GATE_SHADOW = '1';
    expect(purposeActCap('wake_triage')).toBeNull();
    delete process.env.SUPERVISOR_MATERIAL_GATE_SHADOW;
    process.env.SUPERVISOR_MATERIAL_GATE_DISABLED = '1';
    expect(capDecisionMode('wake_triage', { mode: 'act', source: 'store' })).toEqual({ mode: 'act', source: 'store' });
    expect(decisionRegistryRow('wake_triage').actCap).toBeNull();
  });
});
