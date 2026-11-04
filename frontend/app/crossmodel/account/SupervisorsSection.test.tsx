/**
 * Supervisors panel (owner 2026-09-26) — source-level pins in the repo's idiom
 * for effectful components (ModelRolesSection.test.tsx: the section fetches in
 * an effect, so a full render only shows the spinner). Pins: the two toggles
 * are bound to the SystemSetting keys through adminApi.setSupervisorSwitch,
 * turning OFF goes through the AlertDialog confirm while ON is immediate, the
 * skipped-wake counter + status line render, the explainer copy is the shared
 * SUPERVISOR_OFF_FACTS, the panel is mounted in the Admin Settings section, the
 * Status card renders the backend line, and the API client exposes both calls.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SECTION = readSrc('./SupervisorsSection.tsx');
const ADMIN_TAB = readSrc('./AdminTab.tsx');
const OVERVIEW = readSrc('../management/SupervisorOverviewPanel.tsx');
const API = readSrc('../../../lib/api/crossmodel.ts');
const FLEET_API = readSrc('../../../lib/api/fleet.ts');

describe('SupervisorsSection — Admin → Settings → Supervisors (2026-09-26)', () => {
  it('binds the two toggles to the SystemSetting keys via adminApi.setSupervisorSwitch and loads via getSupervisorSwitches', () => {
    expect(SECTION).toContain("fleet: FLEET_SUPERVISOR_ENABLED_KEY,");
    expect(SECTION).toContain("project: PROJECT_SUPERVISORS_ENABLED_KEY,");
    expect(SECTION).toContain('adminApi.getSupervisorSwitches()');
    expect(SECTION).toContain('adminApi.setSupervisorSwitch(KEY_OF[target], enabled)');
    expect(SECTION).toContain('{row(state.fleet)}');
    expect(SECTION).toContain('{row(state.project)}');
    expect(SECTION).toContain('onCheckedChange={(v) => onToggle(t.target, v)}');
  });

  it('turning OFF confirms first (AlertDialog), turning ON is immediate; the confirm copy is the shared helper', () => {
    expect(SECTION).toContain("if (next) void flip(target, true); // turning ON is immediate");
    expect(SECTION).toContain("else setConfirmOff(target); // turning OFF confirms first");
    expect(SECTION).toContain('<AlertDialog open={confirmOff !== null}');
    expect(SECTION).toContain('confirmOffCopy(confirmOff)');
    expect(SECTION).toContain('Keep it on');
    expect(SECTION).toContain('if (t) void flip(t, false);');
  });

  it('renders the skipped-wake counter, the per-target status facts and the backend status line', () => {
    expect(SECTION).toContain('data-testid="supervisor-switch-skipped">wakes skipped: {skipped}');
    expect(SECTION).toContain('{describeSwitchTarget(t)}');
    expect(SECTION).toContain('data-testid="supervisor-switch-line">{state.line}');
    expect(SECTION).toContain('totalSkipped(state)');
  });

  it('explains what OFF means with the shared facts (no replay, in-flight finishes, lanes unaffected, turn on to resume)', () => {
    expect(SECTION).toContain('What OFF means');
    expect(SECTION).toContain('SUPERVISOR_OFF_FACTS.map(');
    expect(SECTION).toContain('live within 60 s on every box — no deploy');
  });

  it('is mounted in the Admin tab Settings section and the API client exposes both calls', () => {
    expect(ADMIN_TAB).toContain("import { SupervisorsSection } from './SupervisorsSection';");
    expect(ADMIN_TAB).toContain('<SupervisorsSection />');
    expect(API).toContain("apiClient.get('/crossmodel/admin/settings/supervisors')");
    expect(API).toContain("{ value: enabled ? '1' : '0' }");
    expect(FLEET_API).toContain('export interface SupervisorSwitchState');
    expect(FLEET_API).toContain('supervisorSwitch?: SupervisorSwitchState | null;');
  });

  it('the Management Status card renders the backend-composed line + an OFF badge (never model prose)', () => {
    expect(OVERVIEW).toContain("import { anySwitchOff } from '@/lib/supervisor-switch';");
    expect(OVERVIEW).toContain('const switchState = overview?.supervisorSwitch ?? null;');
    expect(OVERVIEW).toContain('data-testid="supervisor-switch-off-badge">Switched OFF');
    expect(OVERVIEW).toContain('{switchState.line}');
  });
});
