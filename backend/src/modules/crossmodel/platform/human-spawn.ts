/**
 * Human-spawned coding sessions (cohesive chat live fixes, 2026-09-28).
 *
 * A child session started by `start_coding_session` on a HUMAN turn of a
 * plain (non-supervisor) chat is the user's OWN ask: the live acceptance
 * (session 3d21b4d8, run c8bdbd01, 05:10Z) showed the child auto-denying its
 * very first tool call — "unattended machine-triggered run in ASK mode" — so
 * it built nothing. Two things made that happen:
 *   1. the spawn stamped the child's first run origin 'agent' (ticket
 *      2e9e5264: "the first prompt is AGENT-authored"), so run-executor
 *      classified it MACHINE (no userTurnAt, machineTriggered:true) and the
 *      permission gate (coding/tools.ts checkPermission) fail-fasted every
 *      mutating tool in ASK mode;
 *   2. the child's permissionMode came from the user's saved preference (a
 *      pre-2026-09-17 'ask' row — the default flip was DEFAULT-only, no
 *      backfill), never from the fact that a human asked for the work.
 *
 * The rule (owner decision: auto-mode = full autonomy for coding sessions):
 *   · permissionMode: an EXPLICIT `permissionMode` argument wins; else a
 *     saved preference the user set THEMSELVES (marked explicit at the
 *     settings PUT / set_preferences tool — see markPermissionModeExplicit)
 *     is honoured; else 'auto'. A stored 'ask' that was never deliberately
 *     chosen (the pre-flip default) does not cripple the user's own ask.
 *   · classification: the child's first run is USER-anchored — origin 'user'
 *     with the parent turn's userTurnAt threaded through the first-prompt
 *     stash — so run-executor classifies it 'user' (never auto-denied, never
 *     zero-tool-gated, never machine-floored).
 * Machine spawns (a supervisor's lanes, schedule / hook / agent turns) are
 * byte-identical to before: origin 'agent', preference default.
 *
 * Leaf module: node builtins only.
 */

import { isHumanTurn } from './work-tools';

export const PERMISSION_MODE_VALUES: ReadonlySet<string> = new Set(['auto', 'plan', 'ask']);

/** Context-store namespace + key that records a DELIBERATE permission-mode preference. */
export const CODING_PREFS_STORE_NS = (userId: string): string[] => ['user', userId, 'coding-prefs'];
export const PERMISSION_MODE_EXPLICIT_KEY = 'permissionModeExplicit';

export type PermissionSource = 'spawn-param' | 'user-pref' | 'human-spawn-default' | 'default';

export interface PermissionModeExplicitRecord {
  mode: string;
  at: string;
  via: string;
}

/**
 * TRUE when a spawn happens on a human turn of a NON-supervisor chat (the
 * user's own ask). A supervisor-class parent (Fleet / Project Supervisor)
 * keeps the machine-lane semantics for its children even when the owner
 * typed the turn — those children are fleet lanes, not the owner's
 * deliverable.
 */
export function isHumanSpawn(
  ctx: { userTurnAt?: Date | null; machineTriggered?: boolean },
  parent: { isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null } | null | undefined,
): boolean {
  if (!isHumanTurn(ctx)) return false;
  if (parent && (parent.isSupervisor === true || parent.isProjectSupervisor === true)) return false;
  return true;
}

/**
 * Resolve the permission mode for a spawn. Pure.
 *   explicit           — the caller's `permissionMode` argument (wins when valid)
 *   prefMode           — the user's saved codingPermissionMode
 *   prefExplicit       — the saved preference was set by the user themselves
 *   humanSpawn         — the spawn is the user's own ask (isHumanSpawn)
 * A machine spawn resolves exactly as before: explicit → pref → 'auto'.
 */
export function resolveSpawnPermissionMode(input: {
  explicit?: string | null;
  prefMode?: string | null;
  prefExplicit?: boolean;
  humanSpawn: boolean;
}): { mode: string; source: PermissionSource } {
  const explicit = typeof input.explicit === 'string' ? input.explicit.trim() : '';
  if (explicit && PERMISSION_MODE_VALUES.has(explicit)) return { mode: explicit, source: 'spawn-param' };
  const pref = typeof input.prefMode === 'string' ? input.prefMode.trim() : '';
  const prefValid = !!pref && PERMISSION_MODE_VALUES.has(pref);
  if (!input.humanSpawn) {
    return prefValid ? { mode: pref, source: 'user-pref' } : { mode: 'auto', source: 'default' };
  }
  if (prefValid && pref !== 'auto' && input.prefExplicit === true) return { mode: pref, source: 'user-pref' };
  return { mode: 'auto', source: 'human-spawn-default' };
}

/**
 * Record that the user set their codingPermissionMode THEMSELVES (settings
 * PUT / set_preferences on a live user turn). Best-effort, never throws.
 */
export async function markPermissionModeExplicit(userId: string, mode: string, via: string): Promise<void> {
  if (!userId || !PERMISSION_MODE_VALUES.has(String(mode))) return;
  try {
    const store = await import('../memory/context-store');
    const record: PermissionModeExplicitRecord = { mode: String(mode), at: new Date().toISOString(), via: String(via || 'settings') };
    await store.storePut(CODING_PREFS_STORE_NS(userId), PERMISSION_MODE_EXPLICIT_KEY, record as unknown as Record<string, unknown>);
  } catch { /* the marker is a courtesy — a store hiccup never fails a preference write */ }
}

/**
 * TRUE when the user's saved codingPermissionMode was set by them (the
 * explicit marker exists AND names the CURRENT stored mode). Fail-CLOSED
 * (false) on any read error: a mode we cannot prove deliberate does not
 * override the user's own ask.
 */
export async function isPermissionModeExplicit(userId: string, currentMode: string | null | undefined): Promise<boolean> {
  if (!userId || !currentMode) return false;
  try {
    const store = await import('../memory/context-store');
    const rec = await store.storeGet<PermissionModeExplicitRecord>(CODING_PREFS_STORE_NS(userId), PERMISSION_MODE_EXPLICIT_KEY);
    return !!rec && typeof rec === 'object' && rec.mode === currentMode;
  } catch {
    return false;
  }
}
