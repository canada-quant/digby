/**
 * lib/instance-setup — the pure helpers the Admin → Setup checklist, the
 * Integrations / Feeds tabs and the news card share (self-host setup
 * hardening, 2026-10-20). Unknown setup (endpoint not loaded / failed) must
 * never hide a working control; production reads every feature configured.
 */
import { describe, it, expect } from 'vitest';
import type { InstanceSetup, InstanceSetupFeature } from '@/lib/api/crossmodel';
import {
  featureByKey, groupFeatures, helpHref, integrationUnavailable, macAgentInstallCommand, macAgentUpdateCommand,
  notConfiguredToast, notSetUpCopy, setupHeadline, stateTone, webSearchUnavailable, SELF_HOST_HELP, GROUP_ORDER,
} from './instance-setup';

const f = (key: string, over: Partial<InstanceSetupFeature> = {}): InstanceSetupFeature => ({
  key, label: key, group: 'integrations', state: 'ready', configured: true, required: false, summary: '', help: `${SELF_HOST_HELP}#integrations`, ...over,
});
const setup = (features: InstanceSetupFeature[], selfHosted = true): InstanceSetup => ({
  instance: { kind: selfHosted ? 'selfhost' : 'prod', selfHosted, publicUrl: 'https://digby.example.com', cookieSecure: true, nodeEnv: 'production' },
  summary: { ready: features.filter((x) => x.state === 'ready').length, total: features.length, missingRequired: features.filter((x) => x.required && x.state !== 'ready').map((x) => x.key) },
  features,
  viewer: { admin: true },
});

describe('integrationUnavailable / webSearchUnavailable', () => {
  it('is false when the setup is unknown — a fetch hiccup never hides a Connect button', () => {
    expect(integrationUnavailable(null, 'google')).toBe(false);
    expect(integrationUnavailable(undefined, 'google')).toBe(false);
    expect(webSearchUnavailable(null)).toBe(false);
  });
  it('is true only when the endpoint says the feature is not configured', () => {
    const s = setup([f('google', { configured: false, state: 'missing' }), f('github'), f('web_search', { group: 'web', configured: false, state: 'missing', required: false })]);
    expect(integrationUnavailable(s, 'google')).toBe(true);
    expect(integrationUnavailable(s, 'github')).toBe(false);
    expect(integrationUnavailable(s, 'nope')).toBe(false);
    expect(webSearchUnavailable(s)).toBe(true);
  });
});

describe('copy', () => {
  it('tells a user who fixes it and tells an admin the missing key on an encryption_key bounce', () => {
    expect(notSetUpCopy('Slack')).toMatch(/Account → Admin → Setup/);
    expect(notConfiguredToast('Xero')).toMatch(/not set up on this instance/);
    expect(notConfiguredToast('Xero', 'encryption_key')).toMatch(/token-encryption key/);
  });
  it('headline names the instance kind, host and the required gaps', () => {
    const s = setup([f('model_providers', { group: 'models', required: true, configured: false, state: 'missing' }), f('github')]);
    expect(setupHeadline(s)).toBe('Self-hosted instance at digby.example.com · 1 of 2 ready · 1 required item missing');
    expect(setupHeadline(setup([f('github')], false))).toContain('Production instance');
  });
  it('helpHref falls back to the self-host guide', () => {
    expect(helpHref(null)).toBe(SELF_HOST_HELP);
    expect(helpHref(f('x', { help: '/help/self-host#web-search-optional' }))).toBe('/help/self-host#web-search-optional');
  });
});

describe('grouping + tones', () => {
  it('groups in display order and drops empty groups', () => {
    const g = groupFeatures([f('b', { group: 'coding' }), f('a', { group: 'instance' })]);
    expect(g.map((x) => x.group)).toEqual(['instance', 'coding']);
    expect(GROUP_ORDER[0]).toBe('instance');
    expect(featureByKey(setup([f('a')]), 'a')?.key).toBe('a');
  });
  it('a missing REQUIRED feature is bad, a missing optional one is a warning, off is muted', () => {
    expect(stateTone('missing', true)).toBe('bad');
    expect(stateTone('missing', false)).toBe('warn');
    expect(stateTone('partial', false)).toBe('warn');
    expect(stateTone('off', false)).toBe('muted');
    expect(stateTone('ready', true)).toBe('ok');
  });
});

describe('Mac agent one-liners', () => {
  it('fetch the script and tarball from THIS origin and pair against THIS api — never digby.example.com', () => {
    // The input origin MUST differ from the production host the negative
    // assertion forbids (2026-11-03: a production-token sweep rewrote both
    // sides to `digby.example.com`, collapsing the discriminator into
    // `expect(x).not.toContain(x)` — the assertion could never fail again).
    const cmd = macAgentInstallCommand('https://selfhost.example.org/', 'ABCD-1234');
    expect(cmd).toBe('curl -fsSL https://selfhost.example.org/install-digby-agent.sh | DIGBY_INSTALL_HOST=https://selfhost.example.org bash -s -- ABCD-1234 https://selfhost.example.org/api');
    expect(cmd).not.toContain('digby.example.com');
    expect(macAgentUpdateCommand('http://lan:8080')).toBe('curl -fsSL http://lan:8080/install-digby-agent.sh | DIGBY_INSTALL_HOST=http://lan:8080 bash -s -- --update-only');
  });
});
