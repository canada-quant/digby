/**
 * IMessageCard — macOS permission checklist pins (ticket 2f646c10, agent
 * v0.6.0, 2026-09-25).
 *
 * An owner spent ~24h with a dead computer-use input path: Accessibility was
 * granted to a STALE helper binary after an app update while System Settings
 * still showed the switch ON — and the agent had no way to report its own
 * broken state. Since v0.6.0 the helper advertises its TCC state
 * {ax, sr, fda, relaunch} on every poll, and this card renders it as a live
 * checklist with Open System Settings / Reveal DigbyHelper / Relaunch helper
 * buttons.
 *
 * Two idioms per the repo's node-environment vitest constraints (no jsdom, no
 * effects — see ModelRolesSection.test.tsx / c1-convergence-smoke.test.tsx):
 *   1. SSR render of the PURE MacPermissionsSection (FeedbackTab's
 *      FeedbackRequestRow idiom) for every display state;
 *   2. SOURCE-LEVEL pins on IMessageCard.tsx + the api client for the
 *      effectful wiring (dispatch calls, gating, live poll).
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { MacPermissionsSection } from '../IMessageCard';
import type { IMessageAgentInfo } from '@/lib/api/crossmodel';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CARD = readSrc('../IMessageCard.tsx');
const API = readSrc('../../../../lib/api/crossmodel.ts');

const noop = () => {};
const baseAgent = (over: Partial<IMessageAgentInfo> = {}): IMessageAgentInfo => ({
  id: 'agent-1',
  label: 'MacBook Pro',
  online: true,
  ...over,
});

/** Render the section with the given permissions payload. */
const render = (permissions: IMessageAgentInfo['permissions'], over: Partial<IMessageAgentInfo> = {}) =>
  renderToStaticMarkup(
    createElement(MacPermissionsSection, {
      agent: baseAgent({ ...over, permissions }),
      busy: false,
      error: null,
      onAction: noop,
    }),
  );

describe('MacPermissionsSection — display states', () => {
  it('partial grants → checklist renders 3 rows with per-row ✓/✗ chips', () => {
    const html = render({ ax: false, sr: true, fda: false, relaunch: false });
    expect(html).toContain('data-testid="mac-permissions-checklist"');
    expect(html).toContain('Accessibility');
    expect(html).toContain('Screen Recording');
    expect(html).toContain('Full Disk Access');
    // ax and fda are MISSING (✗ chips), sr is GRANTED (✓ chip).
    expect(html.match(/✗ missing/g)).toHaveLength(2);
    expect(html.match(/✓ granted/g)).toHaveLength(1);
    // The guidance line names the helper binary + where to add it (51d8dbe0:
    // it is install-dependent — DigbyHelper in the .app, DigbyAgent on a
    // Terminal one-line install — so the card names both, not a fixed one).
    expect(html).toContain('Grants attach to the helper binary Finder reveals');
    expect(html).toContain('DigbyHelper in the');
    expect(html).toContain('DigbyAgent on a Terminal');
    expect(html).toContain('System Settings');
  });

  it('c44b19e9: an advertised DENIED calendar read renders the Calendars row (✗); an unadvertised one renders nothing', () => {
    // cal: false — the grant WAS there and is now denied: the row renders.
    const denied = render({ ax: true, sr: true, fda: true, relaunch: false, cal: false });
    expect(denied).toContain('data-testid="mac-permission-cal"');
    expect(denied).toContain('Calendars');
    expect(denied.match(/✗ missing/g)).toHaveLength(1);
    // cal absent — the agent never read a calendar: NO row (never renders
    // "missing" for a permission it simply has not exercised).
    const unread = render({ ax: true, sr: true, fda: true, relaunch: false });
    expect(unread).not.toContain('data-testid="mac-permission-cal"');
    expect(unread).not.toContain('Calendars');
    expect(unread).toContain('data-testid="mac-permissions-ok"');
    // cal: true — granted: the row renders with the ✓ chip when the
    // checklist is shown (another grant missing).
    const granted = render({ ax: true, sr: false, fda: true, relaunch: false, cal: true });
    expect(granted).toContain('data-testid="mac-permission-cal"');
    expect(granted.match(/✓ granted/g)).toHaveLength(3); // cal + ax + fda (sr missing)
    // And with EVERYTHING granted (cal included) the single green line stands.
    const all = render({ ax: true, sr: true, fda: true, relaunch: false, cal: true });
    expect(all).toContain('data-testid="mac-permissions-ok"');
    expect(all).not.toContain('✗ missing');
  });

  it('partial grants → both action buttons render', () => {
    const html = render({ ax: false, sr: true, fda: false, relaunch: false });
    expect(html).toContain('Open System Settings');
    // 51d8dbe0: the button no longer hardcodes the .app binary's name.
    expect(html).toContain('Reveal helper in Finder');
  });

  it('all granted (no relaunch) → single green line, no checklist, no buttons', () => {
    const html = render({ ax: true, sr: true, fda: true, relaunch: false });
    expect(html).toContain('Permissions: all granted ✓');
    expect(html).not.toContain('data-testid="mac-permissions-checklist"');
    expect(html).not.toContain('Open System Settings');
    expect(html).not.toContain('Reveal DigbyHelper');
  });

  it('relaunch: true → amber banner + Relaunch helper button ABOVE the checklist', () => {
    const html = render({ ax: true, sr: true, fda: true, relaunch: true });
    expect(html).toContain('data-testid="mac-permissions-relaunch-banner"');
    expect(html).toContain('a relaunch is needed');
    expect(html).toContain('Relaunch helper');
    // allGranted but relaunch → the banner alone; the checklist (3 ✗ rows)
    // renders only when a grant is actually missing.
    expect(html).not.toContain('data-testid="mac-permissions-checklist"');
  });

  it('missing grants PLUS relaunch → banner and checklist together', () => {
    const html = render({ ax: false, sr: true, fda: true, relaunch: true });
    expect(html).toContain('data-testid="mac-permissions-relaunch-banner"');
    expect(html).toContain('data-testid="mac-permissions-checklist"');
  });

  it('permissions null (legacy agent) → the update hint, never a checklist', () => {
    const html = render(null);
    expect(html).toContain('data-testid="mac-permissions-legacy"');
    expect(html).toContain('update the Mac agent to see permission status');
    expect(html).not.toContain('data-testid="mac-permissions-checklist"');
    expect(html).not.toContain('Open System Settings');
  });

  it('a dispatch error renders inline under the checklist', () => {
    const html = renderToStaticMarkup(
      createElement(MacPermissionsSection, {
        agent: baseAgent({ permissions: { ax: false, sr: true, fda: false, relaunch: false } }),
        busy: false,
        error: 'iMessage agent did not respond within 20000ms',
        onAction: noop,
      }),
    );
    expect(html).toContain('data-testid="mac-permissions-error"');
    expect(html).toContain('iMessage agent did not respond within 20000ms');
  });

  it('an OFFLINE agent renders its action buttons disabled', () => {
    const html = renderToStaticMarkup(
      createElement(MacPermissionsSection, {
        agent: baseAgent({ online: false, permissions: { ax: false, sr: false, fda: false, relaunch: false } }),
        busy: false,
        error: null,
        onAction: noop,
      }),
    );
    // Both buttons carry the disabled attribute (a dead helper can't act).
    expect((html.match(/disabled=""/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('IMessageCard wiring — the section only exists for macOS agents', () => {
  it('the card renders MacPermissionsSection inside the per-device block, gated off Windows', () => {
    expect(CARD).toContain("<MacPermissionsSection");
    expect(CARD).toContain("{a.platform !== 'windows' && (");
    // The gate wraps the section (source order): platform check first.
    expect(CARD.indexOf("{a.platform !== 'windows' && (")).toBeLessThan(CARD.indexOf('<MacPermissionsSection'));
  });

  it('the buttons dispatch through imessageApi.permissionAction with the right shapes', () => {
    expect(CARD).toContain("const handlePermissionAction = async (");
    expect(CARD).toContain("await imessageApi.permissionAction(id, action, pane);");
    // The relaunch button triggers a status refresh after the bounce.
    expect(CARD).toContain("toast.success('Relaunching the helper");
    // open-pane targets the FIRST missing permission (accessibility when all true).
    // c44b19e9: firstMissing iterates `rows` (cal renders only once advertised).
    expect(CARD).toContain("const firstMissing = rows.find((row) => !p[row.key])?.pane ?? 'accessibility';");
    expect(CARD).toContain("onAction('open-pane', firstMissing)");
  });

  it('the live poll runs only while a Mac needs attention (derived boolean, 3s cadence)', () => {
    // permAttention is the derived gate: any missing grant OR a relaunch.
    expect(CARD).toContain('const permAttention = permAgents.some(');
    // c44b19e9: cal joins the attention set (cal === false — an advertised
    // DENIED calendar read; undefined = never read, stays quiet).
    expect(CARD).toContain('!a.permissions.ax || !a.permissions.sr || !a.permissions.fda ||');
    expect(CARD).toContain('a.permissions.cal === false || a.permissions.relaunch');
    // …and the second usePolling rides it — healthy cards cost nothing.
    const pollIdx = CARD.indexOf('enabled: permAttention');
    expect(pollIdx).toBeGreaterThan(0);
    expect(CARD.lastIndexOf('intervalMs: 3000', pollIdx)).toBeGreaterThan(0);
  });
});

describe('api client contract — permissionAction + the permissions payload', () => {
  it('IMessageAgentInfo carries platform + the permissions advertisement (c44b19e9: cal rides the advert)', () => {
    expect(API).toContain('platform?: string | null;');
    expect(API).toContain('permissions?: { ax: boolean; sr: boolean; fda: boolean; relaunch: boolean; cal?: boolean } | null;');
  });

  it('imessageApi.permissionAction POSTs { action, pane } to the agent route', () => {
    expect(API).toContain("permissionAction: async (");
    expect(API).toContain("action: 'relaunch' | 'open-pane' | 'reveal',");
    expect(API).toContain("pane?: 'accessibility' | 'screen-recording' | 'full-disk-access' | 'calendars',");
    expect(API).toContain("`/crossmodel/imessage/agents/${encodeURIComponent(agentId)}/permission-action`");
    expect(API).toContain('...(pane ? { pane } : {})');
  });
});
