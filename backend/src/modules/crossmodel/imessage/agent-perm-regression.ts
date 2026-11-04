/**
 * Agent TCC permission-regression detection (ticket e2915963, 2026-10-24).
 *
 * THE MISHAP: the Mac agent's self-update / runtime heal swaps the DigbyAgent
 * binary at its stable path (~/…/Digby/bin/DigbyAgent) — a rename, a new
 * inode. macOS TCC grants (Accessibility / Screen Recording / Full Disk
 * Access) attach to the exact file, so the swap silently ORPHANS them:
 * System Settings still shows the switch ON while the running helper is a
 * ghost, and the next computer_task dispatch returns
 * "Missing macOS permission(s): Accessibility" at steps 0. On the incident
 * Mac (2026-10-24 14:48Z) a 0.9.4→0.9.6 self-update did exactly this and a
 * scheduled AWS-console drive stood down at zero steps until the owner
 * physically re-granted — nobody was told.
 *
 * THE BACKEND HALF of the fix: the agent advertises {ax, sr, fda, relaunch}
 * on EVERY poll (ticket 2f646c10) and touchAgent persists it. This module
 * detects the REGRESSION at the poll seam — a stored-true key flipping to
 * false on a version transition — so the owner can be pushed (ONE deduped
 * Telegram message per regression episode) the MOMENT it happens instead of
 * discovering it at task time. The agent-side half (imessage-agent 0.9.7)
 * additionally guards the swap itself (byte-identical ⇒ no swap) and
 * surfaces the regression on the Mac.
 *
 * Pure decision core only — no Prisma/Redis imports (the same constraint as
 * computer-agent/availability.ts), so every rule is unit-testable on Linux
 * CI and every caller shares ONE seam.
 */

import { AgentPermissions, agentPermissions } from './agent-capabilities';

/** The TCC keys whose true→false flip is a regression of this class. */
export const TCC_REGRESSION_KEYS = ['ax', 'sr', 'fda'] as const;

export type TccRegressionKey = (typeof TCC_REGRESSION_KEYS)[number];

const LABELS: Record<TccRegressionKey, string> = {
  ax: 'Accessibility',
  sr: 'Screen Recording',
  fda: 'Full Disk Access',
};

/**
 * Pure: which of ax/sr/fda were granted in the STORED advertisement and are
 * EXPLICITLY not granted in the NEW one (true → false). The inverse
 * direction (false→true) is a grant landing, not a regression. A null/partial
 * FRESH side yields [] — an absent or partial advertisement is UNKNOWN, not
 * "revoked", and unknown never fabricates a regression (the same
 * absent-never-clobbers contract as mergeAgentPermissions; the live path
 * only ever passes complete objects — normalizeAgentPermissions is
 * all-or-nothing — so this is pure defensiveness for future callers). A null
 * STORED side (legacy agent, garbage JSON) also yields []: without a
 * baseline there is no before→after flip to observe.
 */
export function whichTccPermissionsRegressed(
  stored: { ax?: boolean; sr?: boolean; fda?: boolean } | null | undefined,
  fresh: { ax?: boolean; sr?: boolean; fda?: boolean } | null | undefined,
): TccRegressionKey[] {
  const out: TccRegressionKey[] = [];
  if (!fresh) return out;
  for (const k of TCC_REGRESSION_KEYS) {
    if (stored?.[k] === true && fresh[k] === false) out.push(k);
  }
  return out;
}

/**
 * The owner-facing push text (pure — the tests pin it). Names the Mac (the
 * label), what was lost, and the fix, in the same voice as the watchdog's
 * outage push. `cause` (optional) is the version transition the poll
 * observed — "0.9.4 → 0.9.6" — which is exactly the observable the agent
 * side cannot know (the backend sees both versions).
 */
export function tccRegressionPushText(device: string, keys: TccRegressionKey[], cause: string | null): string {
  const names = keys.map((k) => LABELS[k]).join(', ');
  const why = cause ? ` (agent ${cause})` : '';
  return (
    `🔐 Digby Mac permission alert — ${device}${why}: ${names} ${keys.length === 1 ? 'was' : 'were'} just lost for the DigbyAgent helper. ` +
    'Remote control and screenshots of this Mac will fail until it is re-granted. ' +
    'Fix: open System Settings → Privacy & Security on that Mac, find DigbyAgent, and toggle the switch off then on. ' +
    'This usually happens when the agent updates itself — a one-time re-grant restores it.'
  );
}

/**
 * Pure: should a regression push fire for this transition?
 *   - No regressed keys → never.
 *   - First observation of this key-set (no stored `pushedKeySets` entry) → yes.
 *   - Same key-set already pushed (an episode in flight) → no — ONE message
 *     per regression episode, not one per poll (the agent polls every 25 s;
 *     the owner-absent incident window would otherwise be a 144-message/hour
 *     spam flood — the exact anti-pattern the watchdog dedupes against).
 * A DIFFERENT key-set (more grants lost) is a NEW episode and pushes again.
 */
export function shouldPushTccRegression(
  regressed: TccRegressionKey[],
  pushedKeySet: string | null | undefined,
): boolean {
  if (regressed.length === 0) return false;
  return joinedKeySet(regressed) !== pushedKeySet;
}

/** The dedupe token for a regression episode: the sorted joined key-set. */
export function joinedKeySet(regressed: TccRegressionKey[]): string {
  return [...regressed].sort().join(',');
}

/**
 * Extract the version-transition cause line ("0.9.4 → 0.9.6") from a stored
 * row's agentVersion and the poll's advertised version. Pure; returns null
 * when either side is unreadable or the versions are identical (no
 * transition to attribute).
 */
export function versionTransitionCause(
  storedVersion: string | null | undefined,
  pollVersion: string | null | undefined,
): string | null {
  if (!storedVersion || !pollVersion) return null;
  if (storedVersion === pollVersion) return null;
  if (!/^\d+\.\d+\.\d+$/.test(storedVersion) || !/^\d+\.\d+\.\d+$/.test(pollVersion)) return null;
  return `${storedVersion} → ${pollVersion}`;
}

/**
 * The Redis dedupe key for a device's regression episode. Stable per device
 * per key-set so a repeating poll storm with the SAME set stays deduped
 * while a new episode (different set) fires fresh.
 */
export function tccRegressionDedupeKey(agentId: string): string {
  return `tcc_regression:${agentId}`;
}

/**
 * Read the stored advertisement of a row (the same normalization the
 * controller's merge path uses). Exported for the controller + tests.
 */
export function storedPermissionsOf(agent: { permissions?: unknown } | null | undefined): AgentPermissions | null {
  return agentPermissions(agent);
}
