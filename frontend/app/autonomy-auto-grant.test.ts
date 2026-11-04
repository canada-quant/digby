/**
 * Agent-mode auto-grant — UI truth pins (owner 2026-09-07).
 *
 * A coding chat set to Agent mode AUTO gets its per-chat Autonomy grant
 * materialized automatically server-side (all grantable tools, default cap 48,
 * source 'agent_mode_auto'); leaving Auto revokes it; a manual save converts it
 * to a manual grant that mode flips no longer touch. These SOURCE-LEVEL pins
 * (the phase0/p4 idiom — anchor on stable identifiers) keep the three surfaces
 * that must tell that story honest:
 *
 * 1. The Autonomy dialog recognizes an auto-granted row (source
 *    'agent_mode_auto') and says "Granted automatically — this chat's Agent
 *    mode is Auto"; the pre-2026-09-07 copy claiming Auto "never" grants
 *    platform actions must not return.
 * 2. The platform API client carries the grant's source so the dialog can
 *    render it.
 * 3. The Agent-mode menu copy tells the user Auto grants the chat's Autonomy
 *    automatically (and that leaving Auto revokes it).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const FRONTEND_ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(join(FRONTEND_ROOT, rel), 'utf8');

const DIALOG = 'app/crossmodel/components/AutonomyDialog.tsx';
const API = 'lib/api/platform.ts';
const CHROME = 'app/crossmodel/components/FloatingChrome.tsx';

describe('1 — AutonomyDialog reflects the auto-grant honestly', () => {
  const src = read(DIALOG);

  it("recognizes source 'agent_mode_auto' from the fetched grant", () => {
    expect(src).toContain("g.source === 'agent_mode_auto'");
  });

  it('renders the granted-automatically status line for an auto-granted chat', () => {
    expect(src).toContain('Granted automatically');
    expect(src).toMatch(/Agent mode is Auto/);
    // …and says a manual save converts it (so mode flips won't clobber the edit).
    expect(src).toMatch(/converts it to a manual grant/);
  });

  it('the stale "Auto … never these platform actions" copy is gone (Auto DOES grant them now)', () => {
    expect(src).not.toMatch(/never these platform actions/);
  });

  it('keeps the no-grant copy for chats without any grant', () => {
    expect(src).toContain('No grant yet — every consequential action stages a confirmation card.');
  });
});

describe('2 — platform API client carries the grant source', () => {
  const src = read(API);

  it('FleetAutonomySource models the two provenances', () => {
    expect(src).toMatch(/FleetAutonomySource = 'manual' \| 'agent_mode_auto'/);
  });

  it('FleetAutonomyGrant exposes source to the dialog', () => {
    const grant = src.slice(src.indexOf('interface FleetAutonomyGrant'), src.indexOf('interface FleetAutonomyPutResult'));
    expect(grant).toContain('source?: FleetAutonomySource');
  });
});

describe('3 — the Agent-mode control says Auto grants Autonomy automatically', () => {
  // Since 2026-10-06 the header has no menus: Agent mode lives ONLY in the
  // side panel's Settings tab (SessionSettingsSection).
  const src = read('app/crossmodel/components/SessionSettingsSection.tsx');

  it('the Auto explainer names the automatic grant + revoke-on-leave', () => {
    expect(src).toMatch(/grants this chat’s Autonomy automatically/);
    expect(src).toMatch(/leaving\s+Auto revokes it/);
    expect(read(CHROME)).not.toContain('DropdownMenuRadioGroup'); // the header has no Agent-mode radios
  });
});
