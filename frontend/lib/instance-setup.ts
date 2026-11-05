/**
 * instance-setup — pure helpers over GET /api/crossmodel/instance/setup
 * (self-host setup hardening, 2026-10-20). React-free so the Admin → Setup
 * checklist, the Integrations / Feeds tabs and their source-pin tests share
 * one vocabulary: which feature is dark on THIS instance, what to tell a user
 * vs an admin, and where the help lives.
 */

import type { InstanceSetup, InstanceSetupFeature, InstanceSetupGroup, InstanceSetupState } from '@/lib/api/crossmodel';

export const SELF_HOST_HELP = '/help/self-host';

export const GROUP_LABELS: Record<InstanceSetupGroup, string> = {
  instance: 'This instance',
  models: 'Models',
  web: 'Web search & browsing',
  integrations: 'Integrations',
  messaging: 'Messaging & devices',
  media: 'Voice, images & documents',
  coding: 'Coding sessions',
};

export const GROUP_ORDER: InstanceSetupGroup[] = ['instance', 'models', 'web', 'integrations', 'messaging', 'media', 'coding'];

export const STATE_LABELS: Record<InstanceSetupState, string> = {
  ready: 'Ready',
  partial: 'Partly set up',
  missing: 'Not set up',
  off: 'Off (optional)',
};

/** Tone for the status pill (maps onto the Frontier token palette, never raw Tailwind colours). */
export type StateTone = 'ok' | 'warn' | 'bad' | 'muted';
export function stateTone(state: InstanceSetupState, required: boolean): StateTone {
  if (state === 'ready') return 'ok';
  if (state === 'off') return 'muted';
  if (state === 'missing') return required ? 'bad' : 'warn';
  return 'warn';
}

/** Features grouped in display order (empty groups dropped). */
export function groupFeatures(features: InstanceSetupFeature[]): Array<{ group: InstanceSetupGroup; label: string; features: InstanceSetupFeature[] }> {
  return GROUP_ORDER
    .map((group) => ({ group, label: GROUP_LABELS[group], features: features.filter((f) => f.group === group) }))
    .filter((g) => g.features.length > 0);
}

/** One feature by key, or null. */
export function featureByKey(setup: InstanceSetup | null | undefined, key: string): InstanceSetupFeature | null {
  return setup?.features.find((f) => f.key === key) ?? null;
}

/**
 * True when an integration card must render its "not set up on this instance"
 * state instead of a Connect button: the setup endpoint says the Connect path
 * cannot work here. Unknown (endpoint not loaded / failed) ⇒ false — never hide
 * a working button on a fetch hiccup.
 */
export function integrationUnavailable(setup: InstanceSetup | null | undefined, key: string): boolean {
  const f = featureByKey(setup, key);
  return !!f && f.configured === false;
}

/** True when web search is known to be unconfigured on this instance (news, transparency copy). */
export function webSearchUnavailable(setup: InstanceSetup | null | undefined): boolean {
  return integrationUnavailable(setup, 'web_search');
}

/** The one-line headline for the Setup section header. */
export function setupHeadline(setup: InstanceSetup): string {
  const { ready, total, missingRequired } = setup.summary;
  const host = setup.instance.publicUrl ? ` at ${setup.instance.publicUrl.replace(/^https?:\/\//, '')}` : '';
  const kind = setup.instance.selfHosted ? 'Self-hosted instance' : 'Production instance';
  const req = missingRequired.length ? ` · ${missingRequired.length} required item${missingRequired.length === 1 ? '' : 's'} missing` : '';
  return `${kind}${host} · ${ready} of ${total} ready${req}`;
}

/**
 * The copy a NON-admin sees on a dark integration card. Admins see the
 * feature's own hint (env names + callback) instead.
 */
export function notSetUpCopy(label: string): string {
  return `${label} is not set up on this Digby instance yet. An administrator configures it under Account → Admin → Setup.`;
}

/** The redirect-param → toast copy for a provider that bounced back with not_configured. */
export function notConfiguredToast(label: string, reason?: string | null): string {
  if (reason === 'encryption_key') return `${label} connected, but this instance cannot store the token: its token-encryption key is not set. An administrator fixes that under Account → Admin → Setup.`;
  return `${label} is not set up on this instance yet — an administrator configures it under Account → Admin → Setup.`;
}

/** Deep link to the self-host help anchor the feature names (the endpoint already carries it). */
export function helpHref(feature: InstanceSetupFeature | null | undefined): string {
  return feature?.help || SELF_HOST_HELP;
}

/**
 * The Mac-agent install one-liner for THIS instance: the script and the
 * tarball come from the page's own origin, and the pairing API is this
 * instance's /api — never production digby.ai (which the installer's own
 * defaults point at).
 */
export function macAgentInstallCommand(origin: string, pairingCode: string): string {
  const base = origin.replace(/\/+$/, '');
  return `curl -fsSL ${base}/install-digby-agent.sh | DIGBY_INSTALL_HOST=${base} bash -s -- ${pairingCode} ${base}/api`;
}

/** The Mac-agent update one-liner for THIS instance (no pairing code). */
export function macAgentUpdateCommand(origin: string): string {
  const base = origin.replace(/\/+$/, '');
  return `curl -fsSL ${base}/install-digby-agent.sh | DIGBY_INSTALL_HOST=${base} bash -s -- --update-only`;
}
