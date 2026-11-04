/**
 * Roster config — dynamic roster phase 4 (roster 2026-10-06 D-1 / D-2; docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §5
 * "Session + mid-turn"). The store-backed switches for the two NEW act paths Team D ships:
 *
 *   sessionRoster  'off' | 'shadow' | 'act'   (absent ⇒ 'shadow')
 *     off    — no session roster is read or written (the turn plan's priorLane = the last answer's lane, as before);
 *     shadow — every human turn on a plain chat WRITES the roster (lane + models that ran, hysteresis) and records what
 *              the turn plan would have read; the Quick guard still reads the legacy priorLane — except for the
 *              canary users below, whose turns act;
 *     act    — the Quick guard reads the roster's session lane (up at once, down one lane per turn) and the per-turn
 *              model pick keeps the session's lead when it is (nearly) as good (prompt-cache stability).
 *   callIn         'off' | 'canary' | 'act'   (absent ⇒ 'canary')
 *     off    — the lead's call_in tool is never offered;
 *     canary — offered only on the canary users' eligible human turns;
 *     act    — offered on every eligible signed-in human turn (chat-agent/call-in.ts callInOffer).
 *   rosterCanaryUserIds  string[] — the per-feature canary (both paths act for these users while shadow / canary).
 *
 * ONE context-store row shared with the turn plan's own fields: ['instance','turn-plan'] / 'config' (actCanaryUserIds,
 * modelPick, … are left untouched — scripts/framework-audit/set-roster-mode.js writes only these three fields).
 * 30 s cache; a read failure serves the defaults (shadow / canary with NOBODY on the list ⇒ nothing acts). Pure parse.
 */

export type SessionRosterMode = 'off' | 'shadow' | 'act';
export type CallInMode = 'off' | 'canary' | 'act';

export interface RosterConfig {
  sessionRoster: SessionRosterMode;
  callIn: CallInMode;
  canary: ReadonlySet<string>;
}

export const ROSTER_CONFIG_NS = ['instance', 'turn-plan'];
export const ROSTER_CONFIG_KEY = 'config';
export const ROSTER_CONFIG_TTL_MS = 30_000;

export const DEFAULT_ROSTER_CONFIG: RosterConfig = Object.freeze({ sessionRoster: 'shadow', callIn: 'canary', canary: new Set<string>() }) as RosterConfig;

/** The stored row → the config (pure; unknown / missing values take the defaults). */
export function parseRosterConfig(row: unknown): RosterConfig {
  const r = row && typeof row === 'object' ? (row as Record<string, unknown>) : {};
  const sr = r.sessionRoster === 'off' || r.sessionRoster === 'act' || r.sessionRoster === 'shadow' ? r.sessionRoster : DEFAULT_ROSTER_CONFIG.sessionRoster;
  const ci = r.callIn === 'off' || r.callIn === 'act' || r.callIn === 'canary' ? r.callIn : DEFAULT_ROSTER_CONFIG.callIn;
  const ids = Array.isArray(r.rosterCanaryUserIds)
    ? (r.rosterCanaryUserIds as unknown[]).filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())
    : [];
  return { sessionRoster: sr, callIn: ci, canary: new Set(ids) };
}

let cache: { config: RosterConfig; expiresAt: number } | null = null;
export function __resetRosterConfigForTests(): void { cache = null; }

/** The live config (30 s cache; never throws). */
export async function rosterConfig(): Promise<RosterConfig> {
  if (cache && cache.expiresAt > Date.now()) return cache.config;
  let config: RosterConfig = DEFAULT_ROSTER_CONFIG;
  try {
    const { storeGet } = await import('../memory/context-store');
    config = parseRosterConfig(await storeGet<Record<string, unknown>>(ROSTER_CONFIG_NS, ROSTER_CONFIG_KEY));
  } catch {
    config = DEFAULT_ROSTER_CONFIG;
  }
  cache = { config, expiresAt: Date.now() + ROSTER_CONFIG_TTL_MS };
  return config;
}
