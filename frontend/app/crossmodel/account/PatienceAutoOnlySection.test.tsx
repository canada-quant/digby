/**
 * Depth policy panel (audit 2026-09-26: patience_auto_only prod state vs the
 * documented contract) — source-level pins in the repo's idiom for effectful
 * components (SupervisorsSection.test.tsx). Pins: the toggle is bound to the
 * SystemSetting through adminApi.setPatienceAutoOnly and loads via
 * adminApi.getPatienceAutoOnly, turning OFF goes through the AlertDialog
 * confirm while ON is immediate, the since/by fact line is the shared
 * describeAutoOnlyState, the explainer copy names the requested-depth and
 * guest consequences, the panel is mounted in the Admin Settings section next
 * to the supervisor switches, and the API client exposes both calls. The
 * Advanced tab that used to read the user-facing depth policy was removed
 * outright (ticket c99b404a, 2026-10-27) — nothing here reads it any more.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { AUTO_ONLY_ON_FACTS, PATIENCE_AUTO_ONLY_KEY } from './PatienceAutoOnlySection';

const readSrc = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const SECTION = readSrc('./PatienceAutoOnlySection.tsx');
const ADMIN_TAB = readSrc('./AdminTab.tsx');
const API = readSrc('../../../lib/api/crossmodel.ts');

describe('PatienceAutoOnlySection — Admin → Settings → Depth policy (2026-09-26)', () => {
  it('binds the toggle to the SystemSetting via adminApi.setPatienceAutoOnly and loads via getPatienceAutoOnly', () => {
    expect(PATIENCE_AUTO_ONLY_KEY).toBe('patience_auto_only');
    expect(SECTION).toContain('adminApi.getPatienceAutoOnly()');
    expect(SECTION).toContain('adminApi.setPatienceAutoOnly(enabled)');
    expect(SECTION).toContain('onCheckedChange={(v) => onToggle(v)}');
    expect(SECTION).toContain('data-testid="patience-auto-only-switch"');
  });

  it('turning OFF confirms first (AlertDialog), turning ON is immediate', () => {
    expect(SECTION).toContain('if (next) void flip(true); // turning ON is immediate');
    expect(SECTION).toContain('else setConfirmOff(true); // turning OFF confirms first');
    expect(SECTION).toContain('<AlertDialog open={confirmOff}');
    expect(SECTION).toContain('Keep it on');
    expect(SECTION).toContain('void flip(false);');
  });

  it('renders the since / by fact line through the shared helper', () => {
    expect(SECTION).toContain("import { describeAutoOnlyState } from '@/lib/depth-ux';");
    expect(SECTION).toContain('data-testid="patience-auto-only-status">{describeAutoOnlyState(state)}');
  });

  it('explains what ON means: Advanced preset = requested depth only, guests routed, OFF restores, admin-only', () => {
    expect(SECTION).toContain('What ON means');
    expect(SECTION).toContain('AUTO_ONLY_ON_FACTS.map(');
    expect(AUTO_ONLY_ON_FACTS.some((f) => f.includes('requestedMode'))).toBe(true);
    expect(AUTO_ONLY_ON_FACTS.some((f) => f.includes('Guests are routed too'))).toBe(true);
    expect(AUTO_ONLY_ON_FACTS.some((f) => f.includes('Turning it OFF restores'))).toBe(true);
    expect(AUTO_ONLY_ON_FACTS.some((f) => f.includes('admin-only'))).toBe(true);
    expect(AUTO_ONLY_ON_FACTS.join(' ')).not.toMatch(/deepseek|glm|kimi|qwen/i);
  });

  it('is mounted in the Admin tab Settings section next to the supervisor switches; the API client exposes the calls', () => {
    expect(ADMIN_TAB).toContain("import { PatienceAutoOnlySection } from './PatienceAutoOnlySection';");
    expect(ADMIN_TAB).toContain('<PatienceAutoOnlySection />');
    expect(ADMIN_TAB.indexOf('<SupervisorsSection />')).toBeLessThan(ADMIN_TAB.indexOf('<PatienceAutoOnlySection />'));
    expect(API).toContain("apiClient.get('/crossmodel/admin/settings/patience-auto-only')");
    expect(API).toContain("apiClient.put('/crossmodel/admin/settings/patience_auto_only', { value: enabled ? '1' : '0' })");
    expect(API).toContain('export interface PatienceAutoOnlyState');
  });

  it('roster 2026-10-06 B-3 → c99b404a: the Advanced tab was removed outright; GET /depth/policy stays for REST / API readers', () => {
    expect(API).toContain("apiClient.get('/crossmodel/depth/policy')");
    expect(SECTION).not.toContain('Advanced tab says so');
  });
});
