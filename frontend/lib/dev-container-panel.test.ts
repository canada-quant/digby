/**
 * Dev container (tailnet) panel states (2026-10-13). The coding server not
 * answering reads "state unknown" (never "not running"); with a saved key the
 * remedy is Reconnect and the login link is hidden; an expiring or untagged
 * node gets a plain warning; actions show progress, then their result note.
 */

import { describe, it, expect } from 'vitest';
import { devContainerPanelView, formatExpiryDate, ACTION_RESULT_VISIBLE_MS } from './dev-container-panel';
import type { DevContainerStatus } from './api/coding';

const NOW = Date.parse('2026-10-13T21:00:00Z');
const base = (over: Partial<DevContainerStatus> = {}): DevContainerStatus => ({
  enabled: true, running: true, container: 'digby-dev-83e4fbf9-e18', image: 'img', keyConfigured: true,
  tailscale: { state: 'Running', ip4: '100.64.0.9', online: true, tags: ['tag:digby-dev'], keyExpiry: null },
  egress: { mode: 'legacy', shim: null, policyRules: null }, reach: 'remote', action: null,
  ...over,
});

describe('devContainerPanelView', () => {
  it('healthy tagged node: running, tailnet line, no warnings, Reconnect available but not pushed', () => {
    const v = devContainerPanelView(base(), NOW);
    expect(v.containerState).toBe('running');
    expect(v.tailnetLine).toBe('tailnet: Running · 100.64.0.9');
    expect(v.messages).toEqual([]);
    expect(v.reconnectEnabled).toBe(true);
    expect(v.reconnectRecommended).toBe(false);
    expect(v.showLoginLink).toBe(false);
  });

  it('coding server silent → "state unknown", no tailnet line, buttons off, the honest note', () => {
    const v = devContainerPanelView(base({ reach: 'unreachable', running: false, tailscale: null, note: "The coding server didn't answer, so the container's live state is unknown right now. Try again in a minute." }), NOW);
    expect(v.containerState).toBe('state unknown');
    expect(v.tailnetLine).toBeNull();
    expect(v.reconnectEnabled).toBe(false);
    expect(v.restartEnabled).toBe(false);
    expect(v.messages[0].text).toMatch(/didn't answer/);
    expect(v.messages.some(m => /not running/.test(m.text))).toBe(false);
  });

  it('saved key + NeedsLogin (the expired-node case) → Reconnect recommended, login link hidden even if a URL exists', () => {
    const v = devContainerPanelView(base({ tailscale: { state: 'NeedsLogin', loginPending: true, loginUrl: 'https://login.tailscale.com/a/x' } }), NOW);
    expect(v.reconnectRecommended).toBe(true);
    expect(v.reconnectEnabled).toBe(true);
    expect(v.showLoginLink).toBe(false);
    expect(v.messages[0]).toEqual({ tone: 'warn', text: "The container isn't connected to your tailnet. Press Reconnect to join with your saved key." });
  });

  it('expiring node → "expires on <date>" warning recommending a tagged key + Reconnect', () => {
    const v = devContainerPanelView(base({ tailscale: { state: 'Running', tags: [], keyExpiry: '2026-11-27T10:00:00Z' } }), NOW);
    expect(v.reconnectRecommended).toBe(true);
    expect(v.messages[0].text).toBe("This tailnet node expires on Nov 27, 2026 — save a tagged auth key and press Reconnect; tagged nodes don't expire.");
  });

  it('expiry in the past → "expired on"', () => {
    const v = devContainerPanelView(base({ tailscale: { state: 'Running', tags: [], keyExpiry: '2026-10-13T20:04:00Z' } }), NOW);
    expect(v.messages[0].text).toMatch(/^This tailnet node's key expired on Oct 13, 2026/);
  });

  it('untagged node without an expiry → personal-permissions warning', () => {
    const v = devContainerPanelView(base({ tailscale: { state: 'Running', tags: [], keyExpiry: null } }), NOW);
    expect(v.messages[0].text).toMatch(/isn't tagged, so it runs with your personal tailnet permissions/);
    expect(v.reconnectRecommended).toBe(true);
  });

  it('no key saved → save-a-key warning; the login link is offered (keyless path) and Reconnect is off', () => {
    const v = devContainerPanelView(base({ keyConfigured: false, tailscale: { state: 'NeedsLogin', loginUrl: 'https://login.tailscale.com/a/x' } }), NOW);
    expect(v.messages[0].text).toMatch(/No Tailscale auth key is saved/);
    expect(v.showLoginLink).toBe(true);
    expect(v.reconnectEnabled).toBe(false);
  });

  it('container stopped with a key → points at Restart / the next session, Reconnect off', () => {
    const v = devContainerPanelView(base({ running: false, tailscale: null }), NOW);
    expect(v.containerState).toBe('not running');
    expect(v.messages[0].text).toMatch(/press Restart to rebuild it now/);
    expect(v.reconnectEnabled).toBe(false);
    expect(v.restartEnabled).toBe(true);
  });

  it('an action in progress → progress line, both buttons off, no duplicate recommendation', () => {
    const v = devContainerPanelView(base({
      tailscale: { state: 'NeedsLogin' },
      action: { action: 'tailnet_reconnect', state: 'running', startedAt: '2026-10-13T20:58:00Z', note: 'Reconnecting…' },
    }), NOW);
    expect(v.actionRunning).toBe(true);
    expect(v.actionMessage).toEqual({ tone: 'muted', text: 'Reconnecting the tailnet… (started 20:58 UTC)' });
    expect(v.reconnectEnabled).toBe(false);
    expect(v.restartEnabled).toBe(false);
    expect(v.reconnectRecommended).toBe(false);
  });

  it('a finished action shows its note (success / warn) for a while, then drops off', () => {
    const done = devContainerPanelView(base({ action: { action: 'tailnet_reconnect', state: 'done', startedAt: '2026-10-13T20:50:00Z', finishedAt: '2026-10-13T20:51:00Z', note: 'Reconnected — the container rejoined your tailnet with the saved key.' } }), NOW);
    expect(done.actionMessage).toEqual({ tone: 'success', text: 'Reconnected — the container rejoined your tailnet with the saved key.' });
    const failed = devContainerPanelView(base({ action: { action: 'restart', state: 'failed', startedAt: '2026-10-13T20:50:00Z', finishedAt: '2026-10-13T20:52:00Z', note: 'Tailscale rejected the saved key.' } }), NOW);
    expect(failed.actionMessage?.tone).toBe('warn');
    const old = devContainerPanelView(base({ action: { action: 'restart', state: 'done', startedAt: 't', finishedAt: new Date(NOW - ACTION_RESULT_VISIBLE_MS - 1).toISOString(), note: 'x' } }), NOW);
    expect(old.actionMessage).toBeNull();
  });

  it('formatExpiryDate is UTC and falls back to the raw string', () => {
    expect(formatExpiryDate('2026-11-27T23:30:00Z')).toBe('Nov 27, 2026');
    expect(formatExpiryDate('garbage')).toBe('garbage');
  });
});
