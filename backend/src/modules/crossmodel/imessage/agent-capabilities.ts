/**
 * Agent platform + capability model (Windows client W0, roadmap §2.7 — 2026-09-25).
 *
 * Until now the backend inferred "what can this agent do" from `agentVersion`
 * alone (browser ≥ 0.2.0, computer ≥ 0.3.0) — single-axis gates that assume
 * every agent is a Mac with iMessage + browser + computer. A Windows agent
 * ships browser + computer but NEVER iMessage, and its version history is its
 * own, so version numbers can't carry the answer.
 *
 * The model: agents ADVERTISE a platform + capability set at pair time and on
 * every poll (`capabilities: ['browser','computer']`). The gates below prefer
 * the advertisement and fall back to the legacy Mac version gates only when a
 * row advertises nothing (every pre-2026-09-25 Mac row) — so existing fleets
 * see zero behavior change.
 *
 * Pure leaf: no Redis/Prisma imports, so every surface (browser router,
 * computer availability, iMessage controller, /status payload) answers
 * "can this device do X?" from ONE definition.
 *
 * Also hosts the macOS TCC permission advertisement normalizer (ticket
 * 2f646c10): normalizeAgentPermissions / agentPermissions share this file's
 * absent-never-clobbers contract (see the block comment below for semantics).
 */

export type AgentPlatform = 'macos' | 'windows';
export type AgentCapability = 'imessage' | 'browser' | 'computer' | 'calendar';

// 'calendar' (ticket 1ea9a120, agent 0.7.0): macOS EventKit reads served by the
// Mac agent (calendar_list_events → mac_calendar_list_events). Macs only — the
// Windows agent never advertises it (windows-agent/src/advertisement.ts keeps
// its CAPABILITIES browser/computer-only). normalizeCapabilities is
// platform-agnostic, so a Windows pair body carrying 'calendar' would be kept
// — the serve-time gate in the calendar dispatch path (agentPlatform ===
// 'macos' + hasCapability(agent, 'calendar')) is what rejects it (belt and
// braces).
export const KNOWN_CAPABILITIES: readonly AgentCapability[] = ['imessage', 'browser', 'computer', 'calendar'];

/** Shape every gate needs — optional so legacy callers/tests keep compiling. */
export interface CapabilityAgentLike {
  platform?: string | null;
  capabilities?: readonly string[] | null;
  agentVersion?: string | null;
  lastSeenAt?: Date | null;
}

/** Legacy rows predate the platform column — they are all Macs. */
export function agentPlatform(agent: { platform?: string | null } | null | undefined): AgentPlatform {
  return agent?.platform === 'windows' ? 'windows' : 'macos';
}

/** True when the agent row carries an explicit capability advertisement.
 *  Empty array / null / undefined = legacy row → version-gate fallback. */
export function advertisesCapabilities(agent: { capabilities?: readonly string[] | null } | null | undefined): boolean {
  return Array.isArray(agent?.capabilities) && (agent.capabilities as readonly string[]).length > 0;
}

/** Semver-ish compare: '0.3.2' >= [0,3,2]. Missing/unparseable → false. */
export function capabilityVersionAtLeast(version: string | null | undefined, min: number[]): boolean {
  if (!version) return false;
  const parts = String(version).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0;
    if (a > min[i]) return true;
    if (a < min[i]) return false;
  }
  return true; // equal
}

/** Legacy Mac version-gate minimums — MUST match browser-agent/router.ts
 *  MIN_LOCAL_BROWSER_VERSION and computer-agent/availability.ts
 *  MIN_COMPUTER_VERSION (they stay exported there for their messages/tests). */
export const LEGACY_MAC_BROWSER_MIN = [0, 2, 0];
export const LEGACY_MAC_COMPUTER_MIN = [0, 3, 0];
/** Calendar reads shipped in agent 0.7.0 (ticket 1ea9a120) — a legacy row
 *  below that version must NOT advertise calendar (resolvedCapabilities
 *  renders the gate, so /status and the tool gates stay honest). */
export const LEGACY_MAC_CALENDAR_MIN = [0, 7, 0];

/**
 * Can this device do `cap` right now (online-agnostic — pair availability
 * separately, e.g. isOnline(lastSeenAt))?
 *
 *   1. Agent advertises capabilities → the advertisement IS the answer.
 *   2. Legacy Mac row (no advertisement) → the historical version gates
 *      (imessage: always; browser ≥ 0.2.0; computer ≥ 0.3.0; calendar ≥ 0.7.0).
 *   3. A Windows row that advertises nothing can do nothing (it must speak
 *      the handshake — the W0+ scaffold always does).
 */
export function hasCapability(agent: CapabilityAgentLike | null | undefined, cap: AgentCapability): boolean {
  if (!agent) return false;
  if (advertisesCapabilities(agent)) {
    return (agent.capabilities as readonly string[]).includes(cap);
  }
  if (agentPlatform(agent) === 'macos') {
    if (cap === 'imessage') return true;
    const min =
      cap === 'browser' ? LEGACY_MAC_BROWSER_MIN
      : cap === 'calendar' ? LEGACY_MAC_CALENDAR_MIN
      : LEGACY_MAC_COMPUTER_MIN;
    return capabilityVersionAtLeast(agent.agentVersion, min);
  }
  return false;
}

/** The resolved capability set for display (/status payload): the explicit
 *  advertisement, else what the legacy gates say for a Mac row. */
export function resolvedCapabilities(agent: CapabilityAgentLike | null | undefined): AgentCapability[] {
  if (!agent) return [];
  if (advertisesCapabilities(agent)) {
    return KNOWN_CAPABILITIES.filter((c) => (agent.capabilities as readonly string[]).includes(c));
  }
  if (agentPlatform(agent) === 'macos') {
    return KNOWN_CAPABILITIES.filter((c) => hasCapability(agent, c));
  }
  return [];
}

/** Normalize an agent-supplied platform string (pair body / poll query). */
export function normalizePlatform(raw: unknown): AgentPlatform | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return v === 'windows' ? 'windows' : v === 'macos' || v === 'mac' ? 'macos' : undefined;
}

/** Normalize an agent-supplied capability list (pair body array / poll query
 *  comma list): keep known values only, dedupe, stable order. Returns
 *  undefined for "nothing advertised" so callers never clobber a stored
 *  advertisement with an empty one. */
export function normalizeCapabilities(raw: unknown): AgentCapability[] | undefined {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string' && raw.trim()
      ? raw.split(',')
      : [];
  if (list.length === 0) return undefined;
  const out = KNOWN_CAPABILITIES.filter((c) =>
    list.some((v) => typeof v === 'string' && v.trim().toLowerCase() === c),
  );
  return out.length > 0 ? out : undefined;
}

// ── macOS TCC permission advertisement (ticket 2f646c10, 2026-09-25) ─────────
//
// An owner spent ~24h with a dead computer-use input path: Accessibility was
// granted to a STALE helper binary after an app update while System Settings
// still showed the switch ON — and the agent had no way to report its own
// broken state ("shouldn't this all be handled when you install digby mac os
// app?"). Since agent v0.6.0 the Mac helper advertises its TCC state on EVERY
// poll (ax/sr/fda/relaunch query params, each '1' or '0') and at pair time
// (a `permissions` body object), so the Account → Integrations card can show
// a live checklist with Open System Settings / Reveal DigbyHelper buttons and
// a Relaunch helper button for the ghost-grant self-heal.
//
//   relaunch = true only when bouncing the helper IS the fix: the .app bundle
//   was swapped under the running DigbyHelper, or Accessibility LOOKS granted
//   while input is provably dead. NULL permissions = a legacy agent (pre
//   0.6.0) never advertised.

/** The advertised macOS TCC state — the wire shape the agent sends and the
 *  row stores (JSONB). null = never advertised (legacy agent). */
export interface AgentPermissions {
  ax: boolean;
  sr: boolean;
  fda: boolean;
  relaunch: boolean;
  /** macOS Calendar read (TCC "Calendars", ticket 1ea9a120). OPTIONAL: agents
   *  before v0.7.0 never advertise it, so an absent key must never clobber a
   *  stored true — callers merge per-key (mergeAgentPermissions). */
  cal?: boolean;
  /** 30d3c366: Input Monitoring (TCC kTCCServiceListenEvent). OPTIONAL for the
   *  same absent-never-clobbers reason as `cal` — an agent whose bridge cannot
   *  answer omits it, and pre-0.9.13 agents never send it at all. */
  im?: boolean;
}

/** '1'/'0' string (poll query), 1/0 number, or a real boolean (the stored
 *  JSONB form — normalizeAgentPermissions round-trips its own output, so
 *  agentPermissions() reading a row back must accept booleans) → boolean;
 *  anything else is not a valid flag. */
function flagOf(raw: unknown): boolean | undefined {
  if (raw === true || raw === '1' || raw === 1) return true;
  if (raw === false || raw === '0' || raw === 0) return false;
  return undefined;
}

/**
 * Normalize the four permission flags from the poll query (`ax`, `sr`, `fda`,
 * `relaunch` — each '1'/'0', numbers accepted) or the pair body (booleans or
 * the same 1/0 literals). Returns the object ONLY when ALL FOUR params are
 * present and valid; ANY absent/garbage param → undefined, so an absent
 * advertisement never clobbers the stored value (the exact contract of
 * normalizePlatform/normalizeCapabilities).
 */
export function normalizeAgentPermissions(
  q: { ax?: unknown; sr?: unknown; fda?: unknown; relaunch?: unknown; cal?: unknown; im?: unknown },
): AgentPermissions | undefined {
  const ax = flagOf(q?.ax);
  const sr = flagOf(q?.sr);
  const fda = flagOf(q?.fda);
  const relaunch = flagOf(q?.relaunch);
  if (ax === undefined || sr === undefined || fda === undefined || relaunch === undefined) return undefined;
  // cal is OPTIONAL (ticket 1ea9a120): the four-flag legacy gate above stays
  // byte-identical — a pre-0.7.0 advert still normalizes. cal rides along only
  // when present/valid; an absent key never clobbers a stored value (callers
  // merge per-key via mergeAgentPermissions).
  const base: AgentPermissions = { ax, sr, fda, relaunch };
  const cal = flagOf(q?.cal);
  if (cal !== undefined) base.cal = cal;
  // 30d3c366: Input Monitoring — same optional/absent-never-clobbers contract
  // as cal. An agent whose bridge cannot answer omits the key entirely.
  const im = flagOf(q?.im);
  if (im !== undefined) base.im = im;
  return base;
}

/** The stored permission advertisement of a row, or null when the row never
 *  advertised one (legacy pre-0.6.0 agent) or the JSON is malformed. */
export function agentPermissions(
  agent: { permissions?: unknown } | null | undefined,
): AgentPermissions | null {
  const p = (agent as { permissions?: Record<string, unknown> } | null | undefined)?.permissions;
  if (!p || typeof p !== 'object') return null;
  const normalized = normalizeAgentPermissions(p as { ax?: unknown; sr?: unknown; fda?: unknown; relaunch?: unknown });
  return normalized ?? null;
}

/**
 * The pair body carries the permission advertisement as an OBJECT (unlike the
 * poll query's four flat params): { ax, sr, fda, relaunch } with boolean
 * values. Returns the normalized object only when ALL FOUR keys are real
 * booleans — a partial/garbage body advertises nothing (absent never clobbers).
 */
export function permissionsFromBody(p: unknown): AgentPermissions | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const o = p as Record<string, unknown>;
  if (
    typeof o.ax !== 'boolean' ||
    typeof o.sr !== 'boolean' ||
    typeof o.fda !== 'boolean' ||
    typeof o.relaunch !== 'boolean'
  ) {
    return undefined;
  }
  // cal is optional (ticket 1ea9a120): carried only when a real boolean — a
  // cal-less pair body advertises the four legacy flags and leaves any stored
  // cal untouched (callers merge per-key via mergeAgentPermissions).
  const base: AgentPermissions = { ax: o.ax, sr: o.sr, fda: o.fda, relaunch: o.relaunch };
  if (typeof o.cal === 'boolean') base.cal = o.cal;
  return base;
}

/**
 * Per-key merge of a NEW permission advertisement into the STORED one (ticket
 * 1ea9a120): every key the advert carries wins; keys it omits keep the stored
 * value — a pre-0.7.0 four-flag advert must never drop a stored cal:true.
 * Either side may be null/undefined (no stored row / no advert at all): then
 * the other side wins as-is (no advert + no stored row → undefined).
 */
export function mergeAgentPermissions(
  stored: AgentPermissions | null | undefined,
  advert: AgentPermissions | undefined,
): AgentPermissions | undefined {
  if (!advert) return stored ?? undefined;
  if (!stored) return { ...advert };
  const merged: AgentPermissions = { ax: advert.ax, sr: advert.sr, fda: advert.fda, relaunch: advert.relaunch };
  if (advert.cal !== undefined) merged.cal = advert.cal;
  else if (stored.cal !== undefined) merged.cal = stored.cal;
  // 30d3c366: same per-key merge for Input Monitoring.
  if (advert.im !== undefined) merged.im = advert.im;
  else if (stored.im !== undefined) merged.im = stored.im;
  return merged;
}

/** Human noun for status strings: "Mac" vs "Windows PC". Legacy default Mac. */
export function platformNoun(agent: { platform?: string | null } | null | undefined): string {
  return agentPlatform(agent) === 'windows' ? 'Windows PC' : 'Mac';
}
