/**
 * RemoteControlSection — the owner-visible health line (ticket c468f922).
 *
 * WHAT THIS PINS. The owner's security contract for this ticket asks for a
 * per-device health line in the agent status, the three real states
 * (off / on / unavailable) kept distinct, and no credential anywhere near the
 * surface. The backend now serves `prelogin`, `remoteAccess` and
 * `unattendedReady` on `/status` + `/agents` (devicePayload parity, pinned by
 * device-payload-prelogin.c468f922.test.ts); this is the rendering half.
 *
 * WHY A READ-ONLY SECTION AND NOT A TOGGLE. Enabling the channel drives root
 * tooling on the device (macOS `kickstart` + a PF anchor + `pfctl`; Windows
 * TermService + a firewall rule). The paired agent runs as the logged-in user
 * and has no dispatchable command for it — its broker vocabulary is
 * `permission_relaunch` / `permission_open_pane` only. A button whose action
 * cannot execute is the exact defect class this ticket exists to end (#2144 had
 * to correct a notice that sent lanes down a path no shipped client could
 * drive), so the section prints the ONE working command instead. The pins below
 * assert that command is present AND that the section renders no enable button.
 *
 * Two idioms per the repo's node-environment vitest constraints (no jsdom, no
 * effects — see IMessageCard.permissions.2f646c10.test.tsx):
 *   1. SSR render of the PURE section for every state;
 *   2. SOURCE-LEVEL pins on IMessageCard.tsx for the effectful wiring.
 */

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { RemoteControlSection } from '../IMessageCard';
import type { IMessageAgentInfo } from '@/lib/api/crossmodel';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const CARD = readSrc('../IMessageCard.tsx');
const API = readSrc('../../../../lib/api/crossmodel.ts');

const baseAgent = (over: Partial<IMessageAgentInfo> = {}): IMessageAgentInfo => ({
  id: 'agent-1',
  label: 'MacBook Pro',
  online: true,
  ...over,
});

const render = (over: Partial<IMessageAgentInfo> = {}) =>
  renderToStaticMarkup(createElement(RemoteControlSection, { agent: baseAgent(over) }));

describe('RemoteControlSection — the three distinct states', () => {
  it('off is the HEALTHY default and is never framed as a failure', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'off', enabled: false, tunnelOnly: false, ready: false, reason: 'off — the default' },
    });
    expect(html).toContain('data-testid="remote-control"');
    expect(html).toContain('off (healthy default)');
    // The nag this state exists to end: never tell an owner to enable a
    // listener as the remedy for a device that is healthy because it is off.
    expect(html).not.toMatch(/not configured — update the agent/i);
  });

  it('on renders as on', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'on', enabled: true, tunnelOnly: true, ready: true, reason: '' },
    });
    expect(html).toContain('on');
    expect(html).not.toContain('off (healthy default)');
  });

  it('unavailable is an honest unknown, distinct from off', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'never reported' },
      remoteAccess: { state: 'unavailable', enabled: false, tunnelOnly: false, ready: false, reason: 'nothing reported' },
    });
    expect(html).toContain('not reported');
    expect(html).not.toContain('off (healthy default)');
  });

  it('blocked shows the blocker reason so it is actionable', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: {
        state: 'blocked', enabled: true, tunnelOnly: true, ready: false,
        reason: 'the remote-access port is reachable from beyond the tunnel',
      },
    });
    expect(html).toContain('blocked');
    expect(html).toContain('data-testid="remote-control-reason"');
    expect(html).toContain('reachable from beyond the tunnel');
  });
});

describe('RemoteControlSection — prelogin is reported separately', () => {
  it('a locked device gets an explicit warning, never a silent retry', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: true, reason: 'at a lock screen right now' },
      remoteAccess: { state: 'off', enabled: false, tunnelOnly: false, ready: false, reason: 'off — the default' },
    });
    expect(html).toContain('data-testid="remote-control-blocked-now"');
    expect(html).toMatch(/refused rather than retried/);
  });

  it('an unlocked device shows no lock warning', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'off', enabled: false, tunnelOnly: false, ready: false, reason: 'off — the default' },
    });
    expect(html).not.toContain('data-testid="remote-control-blocked-now"');
  });

  it('pre-login input reads unavailable — a channel does NOT make it available', () => {
    // The separation the ticket exists to preserve: remoteAccess on does not
    // mean computer_task can type at a login window (no RFB/RDP client ships).
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'on', enabled: true, tunnelOnly: true, ready: true, reason: '' },
    });
    expect(html).toContain('data-testid="remote-control-prelogin"');
    expect(html).toContain('unavailable');
  });

  it('a legacy backend (no fields at all) says so instead of inventing a state', () => {
    const html = render({ platform: 'macos' });
    expect(html).toContain('data-testid="remote-control-legacy"');
    expect(html).not.toContain('data-testid="remote-control"');
  });
});

describe('RemoteControlSection — honest action surface (no unusable path)', () => {
  it('offers the real macOS enable command', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'off', enabled: false, tunnelOnly: false, ready: false, reason: 'off — the default' },
    });
    expect(html).toContain('data-testid="remote-control-enable-cmd"');
    expect(html).toContain('sudo digby-agent remote-access enable');
  });

  it('offers the Windows variant on a PC', () => {
    const html = render({
      platform: 'windows',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'off', enabled: false, tunnelOnly: false, ready: false, reason: 'off — the default' },
    });
    expect(html).toContain('digby-win-agent remote-access enable');
  });

  it('does NOT offer the enable command while BLOCKED — it is already enabled', () => {
    // Defect caught in review. `blocked` means the channel IS enabled and some
    // blocker fired; the remedy is the named blocker (or a revoke). Printing
    // "run remote-access enable" tells an owner to re-run the thing already
    // running, and buries the one actionable line.
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: {
        state: 'blocked', enabled: true, tunnelOnly: true, ready: false,
        reason: 'the remote-access port is reachable from beyond the tunnel',
      },
    });
    expect(html).not.toContain('data-testid="remote-control-enable-cmd"');
    expect(html).not.toContain('remote-access enable');
    // The blocker reason is what the owner must act on, so it must be present.
    expect(html).toContain('reachable from beyond the tunnel');
  });

  it('does NOT offer the enable command while UNAVAILABLE — that agent predates the command', () => {
    // The #2144 defect class, in the owner UI: `remote-access` shipped in agent
    // 0.9.12, so on a 0.9.11 device the printed command does not exist. Point
    // at the update instead of at a command the device cannot have.
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'never reported' },
      remoteAccess: {
        state: 'unavailable', enabled: false, tunnelOnly: false, ready: false,
        reason: 'unavailable — never reported a remote channel; update the agent',
      },
    });
    expect(html).not.toContain('data-testid="remote-control-enable-cmd"');
    expect(html).not.toContain('remote-access enable');
    expect(html).toContain('data-testid="remote-control-update-agent"');
  });

  it('does NOT offer the enable command while ON — there is nothing to enable', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'on', enabled: true, tunnelOnly: true, ready: true, reason: '' },
    });
    expect(html).not.toContain('data-testid="remote-control-enable-cmd"');
  });

  it('renders NO enable/disable button — the paired agent cannot perform it', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'off', enabled: false, tunnelOnly: false, ready: false, reason: 'off — the default' },
    });
    // No <button> at all in this section: it is a status surface, not a control.
    expect(html).not.toContain('<button');
    expect(html).not.toMatch(/onClick/);
  });

  it('the section never renders a credential-shaped string', () => {
    const html = render({
      platform: 'macos',
      prelogin: { status: 'unavailable', blockedNow: false, reason: 'no helper' },
      remoteAccess: { state: 'on', enabled: true, tunnelOnly: true, ready: true, reason: '' },
    });
    // Criterion 5 — a VNC/RDP credential has nowhere to go on this surface.
    expect(html).not.toMatch(/vncpw|password=|hunter2|BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

describe('wiring — the card actually renders the section, and the api types carry it', () => {
  it('IMessageCard mounts RemoteControlSection per device', () => {
    expect(CARD).toMatch(/<RemoteControlSection agent=\{a\} \/>/);
    expect(CARD).toMatch(/export function RemoteControlSection\(/);
  });

  it('the api client declares all three additive fields', () => {
    // Ticket 11b6974f: unattendedReady gained the typed `state` (ready |
    // blocked | off | unavailable) so a consumer can tell a deliberately
    // disabled preset (`off`) from an agent build that cannot report it
    // (`unavailable`). `enabled:false` alone conflated the two — that
    // conflation was the ticket. Anchored on shape (optional `state`, then
    // the unchanged required triple) so future growth does not re-break it.
    // Whitespace-tolerant: the interface is now MULTI-LINE (one field per
    // line), so the old single-line literal cannot match it.
    expect(API).toMatch(/unattendedReady\?: \{[\s\S]{0,200}?enabled: boolean;[\s\S]{0,40}?ready: boolean;[\s\S]{0,40}?reason: string;/);
    expect(API).toMatch(/state\?: 'ready' \| 'blocked' \| 'off' \| 'unavailable'/);
    expect(API).toMatch(/prelogin\?: \{ status: 'available' \| 'unavailable'; blockedNow: boolean; reason: string \}/);
    expect(API).toMatch(/state: 'off' \| 'on' \| 'blocked' \| 'unavailable'/);
  });
});