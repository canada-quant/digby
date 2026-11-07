/**
 * Mac agent release manifest (ticket 4e75cdea, 2026-10-08 — "the agent is not
 * getting updated automatically").
 *
 * The agent long-polls GET /agent/poll; that response now carries an additive
 * `update` block naming the CURRENT RELEASED agent version + its artifact URL +
 * sha256. An agent older than the release downloads, verifies and swaps itself
 * (imessage-agent/src/self-update.ts) — no extra channel, no server→client
 * connection (the transport stays outbound-only).
 *
 * SINGLE SOURCE OF TRUTH: this manifest is what `scripts/publish-agent-tarball.sh`
 * rewrites when it publishes a tarball, and what the agent believes on every poll.
 * The tarball at `url` must ALWAYS be the one this manifest names (version +
 * sha256): publishing a tarball without bumping the manifest ships a downgrade
 * to every self-managed Mac (the served tarball sat at v0.1.0 for weeks while
 * agents ran 0.7.x — the strict-newer gate + sha256 pin below make a stale or
 * mismatched artifact a NO-OP instead of a fleet rollback).
 */

import { agentVersionAtLeast } from './agent-link';
import { isProdInstance } from '../platform/instance-targets';
import { instancePublicUrl } from '../platform/instance-setup';

/**
 * The artifact URL a NON-production instance advertises (self-host setup
 * hardening 2026-10-20): the self-host frontend serves the same tarball at
 * <its public URL>/digby-imessage-agent.tar.gz (frontend/public/ ships in the
 * image), so a paired Mac updates from the instance it dialed — never from
 * production. The sha256 pin is unchanged (same bytes). Production, or an
 * instance with no public URL, keeps the manifest's own URL.
 */
export function advertisedAgentUrl(env: NodeJS.ProcessEnv = process.env): string {
  if (isProdInstance(env)) return AGENT_RELEASE.url;
  const base = instancePublicUrl(env);
  return base ? `${base}/digby-imessage-agent.tar.gz` : AGENT_RELEASE.url;
}

/** The released agent. url is digby.ai-served (same origin the installer uses). */
export interface AgentReleaseManifest {
  version: string;
  url: string;
  /** sha256 of the tar.gz — the agent refuses an artifact that does not match. */
  sha256: string;
  /** Human note shown in the agent log (what this release ships). */
  notes?: string;
  /** OLDEST agent version whose UPDATER may take this release. The poller's
   *  OWN code performs the swap, so a release can require a minimum updater:
   *  0.8.1+ is gated to 0.8.1 updaters because the 0.8.0 updater lands an
   *  adhoc-signed better_sqlite3.node that DigbyHelper (hardened runtime)
   *  refuses — the agent then runs DEGRADED but keeps polling, so the rollback
   *  watchdog stands down and the breakage is silent (ticket 0e4c9601). */
  minUpdaterVersion?: string;
}

/**
 * The current release. Updated BY scripts/publish-agent-tarball.sh (it rewrites
 * this object verbatim after staging the tarball) — hand-edits drift from the
 * artifact, which the sha256 pin then turns into a silent never-update.
 */
export const AGENT_RELEASE: AgentReleaseManifest = {
  version: '0.9.24',
  url: 'https://digby.ai/digby-imessage-agent.tar.gz',
  sha256: '140383742b2dd5cf1a8165383ce43e5c95720b968f7997fedb5ab29fa395e711',
  notes: "ticket calendar-context (0.9.24): the macOS Calendar consent request is now TRUTHFUL and actually works. 0.9.23 returned from on-run immediately after issuing the asynchronous EventKit request, so osascript exited before macOS could present the consent prompt \u2014 no dialog appeared and no Calendars TCC row was ever minted, while the backend told the owner a dialog had been triggered. The script now holds a bounded run loop until the completion handler fires, tries requestFullAccessToEventsWithCompletion first with the legacy entity-type call as a fallback, and prints a machine-readable observation (idiom, completed, waited, authorization tier). The outcome is classified from the STATUS API and persisted (granted/denied/dialog-open/dispatched/bridge-failed/request-failed) and rides the calendar read payload, so Digby stops guessing and never again announces a dialog it did not see.",
  minUpdaterVersion: '0.8.2',
};
/** Kill switch (agent-side twin: DIGBY_SELF_UPDATE=0) — stops advertising to everyone. */
export function agentReleaseAdvertDisabled(): boolean {
  return (process.env.AGENT_UPDATE_ADVERT_DISABLED || '').trim() === '1';
}

/**
 * The CURRENT released agent version, for UI surfaces (ticket 31fd8440: the
 * web card shows "agent vX — update available (latest vY)"). null = the
 * manifest is malformed (a half-finished publish must never reach the UI as
 * "the latest"). This is read-only display; the ADVERT decision above stays
 * the only thing that can send an artifact to a Mac.
 */
export function agentReleaseVersion(): string | null {
  const v = AGENT_RELEASE.version;
  return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) ? v : null;
}

/**
 * The `update` block for a poller at `agentVersion` (string, e.g. '0.6.3') on
 * `platform` ('mac' | 'windows' — undefined/null treated as mac: every legacy
 * poller is a Mac; a Windows agent updates through its own installer).
 *
 * Returns null when there is nothing to say — the response then omits `update`
 * entirely (old agents ignore unknown fields; newer agents keep polling):
 *   • the advert is disabled (kill switch)
 *   • the poller is already at / newer than the release (no downgrades — a
 *     stale manifest after a rollback must never walk a Mac backwards)
 *   • the release row is malformed (an unset sha256 placeholder from a
 *     half-finished publish must never reach a Mac)
 */
export function agentUpdateAdvert(
  agentVersion: string | null | undefined,
  platform?: string | null,
): { version: string; url: string; sha256: string; notes?: string } | null {
  if (agentReleaseAdvertDisabled()) return null;
  if (platform && String(platform).toLowerCase().startsWith('win')) return null;
  const v = AGENT_RELEASE.version;
  const sha = AGENT_RELEASE.sha256;
  // A publish that forgot the sha (placeholder or empty) is not a release.
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v) || !/^[0-9a-f]{64}$/.test(sha)) return null;
  // Strictly newer only. agentVersionAtLeast(x, release) === true means the
  // poller is at-or-newer → nothing to advertise.
  if (agentVersionAtLeast(agentVersion, v)) return null;
  // Updater floor (0e4c9601): the POLLER'S OWN CODE performs the swap. A
  // release may require a minimum updater version — 0.8.1+ releases do,
  // because the 0.8.0 updater stages an adhoc-signed better_sqlite3.node that
  // a hardened-runtime interpreter (DigbyHelper) refuses: the agent then boots
  // DEGRADED but keeps polling, so its rollback watchdog stands down and the
  // iMessage breakage is silent. Pollers below the floor keep running what
  // they run; the fleet brings them to the floor release manually (the same
  // last-manual-push bootstrap the 0.8.0 rollout used).
  const minUpdater = AGENT_RELEASE.minUpdaterVersion;
  if (minUpdater && /^[0-9]+\.[0-9]+\.[0-9]+$/.test(minUpdater) && !agentVersionAtLeast(agentVersion, minUpdater)) {
    return null;
  }
  return {
    version: v,
    url: advertisedAgentUrl(),
    sha256: sha,
    ...(AGENT_RELEASE.notes ? { notes: AGENT_RELEASE.notes } : {}),
  };
}
