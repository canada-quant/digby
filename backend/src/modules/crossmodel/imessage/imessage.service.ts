/**
 * iMessage Agent Service
 *
 * Pairing + agent-registry helpers for the macOS iMessage bridge.
 *
 * Security model: the agent authenticates to the backend with a bearer token.
 * We only ever VERIFY that token (we never need to call out with it), so we store
 * a SHA-256 hash — never the plaintext. The plaintext is shown once at pairing and
 * kept locally on the user's Mac. There is nothing to decrypt server-side, which
 * is both simpler and safer than the OAuth-token-at-rest pattern.
 *
 * Multi-Mac (owner 2026-09-24): an account may pair SEVERAL Macs. Each Mac
 * carries a stable agent-generated deviceId (uuid persisted in its local
 * config); pairing upserts on (userId, deviceId) so re-pairing rotates only
 * that Mac's token and never evicts the others. Legacy clients that send no
 * deviceId keep the old single-Mac behavior: they land on the user's legacy
 * row (the one with deviceId IS NULL), and the FIRST device paired wins —
 * a legacy re-pair rotates that row's token, matching pre-multi-Mac semantics.
 */

import { createHash, randomBytes } from 'crypto';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import { AgentCapability, AgentPlatform, AgentPermissions, agentPermissions, mergeAgentPermissions } from './agent-capabilities';

const PAIR_TTL_SECONDS = 600;          // pairing code valid for 10 minutes
const ONLINE_WINDOW_MS = 45_000;       // agent considered "online" if seen within 45s
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
/** Hard cap on paired Macs per account (multi-Mac guard against unbounded rows). */
export const MAX_AGENTS_PER_USER = 5;

export interface IMessageAgentRow {
  id: string;
  userId: string;
  label: string;
  deviceId: string | null;
  deviceName: string | null;
  agentVersion: string | null;
  /** Agent-advertised OS ('macos' | 'windows'); null/absent = legacy row → treated
   *  as macos (agent-capabilities handshake, Windows client W0 2026-09-25).
   *  Optional so hand-built rows (tests, older stand-ins) keep compiling. */
  platform?: string | null;
  /** Agent-advertised capabilities (imessage/browser/computer). Absent/empty =
   *  legacy row → the historical Mac version gates apply. */
  capabilities?: string[];
  /** Agent-advertised macOS TCC state {ax,sr,fda,relaunch} (ticket 2f646c10).
   *  null/absent = legacy agent (pre-0.6.0) never advertised — the UI shows
   *  the update hint, never a checklist. Optional so hand-built rows (tests,
   *  older stand-ins) keep compiling. */
  permissions?: AgentPermissions | null;
  /** Agent-advertised "unattended / autonomous use" preset (2026-10-28): 
   *  {enabled, blockers[]}. null/absent = a legacy agent that never advertised,
   *  or a device whose user has not opted in (opt-in per device, off by
   *  default). Optional so hand-built rows (tests, older stand-ins) compile. */
  unattended?: unknown;
  /** Agent-advertised BROKERED REMOTE ACCESS (ticket c468f922, owner ruling
   *  2026-10-29): {enabled, tunnelOnly, blockers[]} for the OS's own remote
   *  channel. null/absent = a legacy agent that never advertised, or a device
   *  whose user has not opted in. Optional so hand-built rows compile. */
  remoteAccess?: unknown;
  /** Agent-advertised PRE-LOGIN HELPER (ticket c468f922, the (d) capability of
   *  the owner's 2026-11-01 ruling on card oq_96b31bed): {installed, loaded,
   *  blockers[]}. null/absent = a legacy agent that never advertised — unknown
   *  is never ready. CAPABILITY ONLY: no credential has a field here. */
  preloginHelper?: unknown;
  isDefault: boolean;
  lastSeenAt: Date | null;
  pairedAt: Date;
}

/** What a pairing/polling agent advertises about itself (W0 capability
 *  handshake + 2f646c10 permission advertisement). Absent fields never
 *  clobber stored values. */
export interface AgentAdvertisement {
  platform?: AgentPlatform;
  capabilities?: AgentCapability[];
  permissions?: AgentPermissions;
  /** The unattended preset advert {enabled, blockers[]} — normalized + token
   *  filtered by unattended-verdict.ts, so an agent can never inject arbitrary
   *  blocker tokens into the fleet verdict. */
  unattended?: { enabled: boolean; blockers: string[] };
  /** The brokered remote-access advert {enabled, tunnelOnly, blockers[]} —
   *  normalized + token filtered by remote-access-verdict.ts, so an agent can
   *  never inject arbitrary blocker tokens into the fleet verdict (ticket
   *  c468f922, owner ruling 2026-10-29). */
  remoteAccess?: { enabled: boolean; tunnelOnly: boolean; blockers: string[] };
  /** PRE-LOGIN HELPER advert {installed, loaded, blockers[]} — normalized and
   *  token-filtered by prelogin-helper.ts, so an agent can never inject
   *  arbitrary blocker tokens into the fleet verdict (ticket c468f922, the (d)
   *  capability of the owner's 2026-11-01 ruling). */
  preloginHelper?: { installed: boolean; loaded: boolean; blockers: string[] };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Normalize a user-entered pairing code: strip separators, uppercase. */
function normalizeCode(input: string): string {
  return (input || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function generatePairingCode(): { display: string; key: string } {
  const bytes = randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i++) raw += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return { display: `${raw.slice(0, 4)}-${raw.slice(4)}`, key: raw };
}

export function isOnline(lastSeenAt: Date | null | undefined): boolean {
  return !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < ONLINE_WINDOW_MS;
}

/** Human name for an agent row — the editable label, else the pair-time hostname. */
export function agentDisplayName(agent: { label: string; deviceName?: string | null } | null | undefined): string {
  if (!agent) return 'Mac';
  return agent.label || agent.deviceName || 'Mac';
}

/** Step 1 (web UI, authenticated): mint a short-lived pairing code for this user. */
export async function startPairing(userId: string): Promise<{ pairingCode: string; expiresInSec: number }> {
  const { display, key } = generatePairingCode();
  await redisClient.setEx(`imessage_pair:${key}`, PAIR_TTL_SECONDS, userId);
  logger.info(`iMessage: pairing code issued for userId=${userId}`);
  return { pairingCode: display, expiresInSec: PAIR_TTL_SECONDS };
}

/** De-dupe a candidate label against existing rows: "Mac mini" → "Mac mini 2", "Mac mini 3", … */
function uniquifyLabel(base: string, taken: Set<string>): string {
  const clean = (base || 'Mac').trim().slice(0, 60) || 'Mac';
  if (!taken.has(clean.toLowerCase())) return clean;
  for (let n = 2; n < 100; n++) {
    const candidate = `${clean} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${clean} ${Date.now() % 10000}`;
}

/**
 * Step 2 (agent, no JWT): redeem the pairing code for a permanent agent token.
 * Single-use — the code is deleted on redemption. Returns null on invalid/expired code.
 *
 * Multi-Mac: a client that sends a stable `deviceId` upserts on (userId, deviceId)
 * — re-pairing rotates ONLY that Mac's token; other Macs are never touched. A
 * legacy client (no deviceId) keeps the old behavior: it re-pairs the user's
 * LEGACY row (deviceId IS NULL) if one exists, else creates its own row.
 */
export async function completePairing(
  pairingCode: string,
  deviceName?: string,
  agentVersion?: string,
  deviceId?: string,
  advert?: AgentAdvertisement,
): Promise<{ agentId: string; agentToken: string } | null> {
  const key = `imessage_pair:${normalizeCode(pairingCode)}`;
  const userId = await redisClient.get(key);
  if (userId) await redisClient.del(key);
  if (!userId) return null;

  const token = randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const now = new Date();
  const cleanDeviceId = deviceId && /^[A-Za-z0-9-]{8,64}$/.test(deviceId) ? deviceId : null;

  let agent;
  if (cleanDeviceId) {
    // ── Multi-Mac path: this physical Mac already has a row → rotate ITS token.
    const existing = await (prisma as any).iMessageAgent.findUnique({
      where: { userId_deviceId: { userId, deviceId: cleanDeviceId } },
    });
    if (existing) {
      agent = await (prisma as any).iMessageAgent.update({
        where: { id: existing.id },
        data: {
          tokenHash,
          deviceName: deviceName || existing.deviceName,
          agentVersion: agentVersion || null,
          // W0 capability handshake: an agent that advertises overwrites BOTH
          // fields (self-healing after an agent upgrade); absent fields keep
          // the stored values (legacy agents never clobber a stored advert).
          ...(advert?.platform ? { platform: advert.platform } : {}),
          ...(advert?.capabilities ? { capabilities: advert.capabilities } : {}),
          // Per-key permission merge (ticket 1ea9a120): a cal-less re-pair
          // (pre-0.7.0 agent) never clobbers a stored cal:true; an advertised
          // key always wins (downgrade visible after the next agent restart).
          ...(advert?.permissions
            ? { permissions: mergeAgentPermissions(agentPermissions(existing), advert.permissions) ?? advert.permissions }
            : {}),
          ...(advert?.unattended ? { unattended: advert.unattended } : {}),
          ...(advert?.remoteAccess ? { remoteAccess: advert.remoteAccess } : {}),
          ...(advert?.preloginHelper ? { preloginHelper: advert.preloginHelper } : {}),
          lastSeenAt: now, pairedAt: now,
        },
      });
    } else {
      // New device — enforce the per-account cap, then create with a unique label.
      const count = await (prisma as any).iMessageAgent.count({ where: { userId } });
      if (count >= MAX_AGENTS_PER_USER) {
        throw new Error(`Too many paired Macs (limit ${MAX_AGENTS_PER_USER}). Disconnect one in Account → Integrations first.`);
      }
      const rows = await (prisma as any).iMessageAgent.findMany({ where: { userId }, select: { label: true } });
      const label = uniquifyLabel(deviceName || 'Mac', new Set(rows.map((r: any) => String(r.label || '').toLowerCase())));
      agent = await (prisma as any).iMessageAgent.create({
        data: {
          userId, label, tokenHash, deviceId: cleanDeviceId,
          deviceName: deviceName || null,
          agentVersion: agentVersion || null,
          // W0 capability handshake: the deviceId path is what a Windows agent
          // (and every current Mac agent ≥ multi-Mac) pairs through — store the
          // advertisement. Legacy agents send no advert → NULL platform / []
          // capabilities → the Mac version gates keep governing them.
          ...(advert?.platform ? { platform: advert.platform } : {}),
          ...(advert?.capabilities ? { capabilities: advert.capabilities } : {}),
          ...(advert?.permissions ? { permissions: advert.permissions } : {}),
          ...(advert?.unattended ? { unattended: advert.unattended } : {}),
          ...(advert?.remoteAccess ? { remoteAccess: advert.remoteAccess } : {}),
          ...(advert?.preloginHelper ? { preloginHelper: advert.preloginHelper } : {}),
          isDefault: count === 0, // the account's first Mac is the default target
          lastSeenAt: now, pairedAt: now,
        },
      });
    }
  } else {
    // ── Legacy single-Mac path (old agent binary, no deviceId): keep the exact
    // pre-multi-Mac contract — the user's legacy row (deviceId NULL) is re-paired;
    // a user with ONLY deviceId-carrying Macs gets a new row like a fresh device.
    const legacy = await (prisma as any).iMessageAgent.findFirst({ where: { userId, deviceId: null } });
    if (legacy) {
      agent = await (prisma as any).iMessageAgent.update({
        where: { id: legacy.id },
        data: {
          tokenHash,
          deviceName: deviceName || legacy.deviceName,
          agentVersion: agentVersion || null,
          lastSeenAt: now, pairedAt: now,
        },
      });
    } else {
      const count = await (prisma as any).iMessageAgent.count({ where: { userId } });
      if (count >= MAX_AGENTS_PER_USER) {
        throw new Error(`Too many paired Macs (limit ${MAX_AGENTS_PER_USER}). Disconnect one in Account → Integrations first.`);
      }
      const rows = await (prisma as any).iMessageAgent.findMany({ where: { userId }, select: { label: true } });
      const label = uniquifyLabel(deviceName || 'Primary', new Set(rows.map((r: any) => String(r.label || '').toLowerCase())));
      agent = await (prisma as any).iMessageAgent.create({
        data: {
          userId, label, tokenHash,
          deviceName: deviceName || null,
          agentVersion: agentVersion || null,
          // Legacy agents (no advert) create rows with platform NULL +
          // capabilities [] — exactly the pre-W0 semantics, so the version
          // gates keep governing them unchanged.
          ...(advert?.platform ? { platform: advert.platform } : {}),
          ...(advert?.capabilities ? { capabilities: advert.capabilities } : {}),
          isDefault: count === 0,
          lastSeenAt: now, pairedAt: now,
        },
      });
      // Normalize: a create without an explicit deviceId lands as null (legacy row).
      if (agent && agent.deviceId === undefined) agent = { ...agent, deviceId: null };
    }
  }

  logger.info(`iMessage: agent paired userId=${userId} agentId=${agent.id} device=${deviceName || 'unknown'} deviceId=${cleanDeviceId || 'legacy'}`);
  return { agentId: agent.id, agentToken: token };
}

/** Resolve an agent row from its bearer token (by hash). */
export async function resolveAgentByToken(token: string): Promise<IMessageAgentRow | null> {
  if (!token) return null;
  try {
    return await (prisma as any).iMessageAgent.findUnique({ where: { tokenHash: hashToken(token) } });
  } catch {
    return null;
  }
}

/** The user's default (isDefault) agent, else the most recently paired — or null. */
export async function getPrimaryAgent(userId: string): Promise<IMessageAgentRow | null> {
  try {
    const rows = await (prisma as any).iMessageAgent.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { pairedAt: 'desc' }],
    });
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/** One paired agent by id (ticket e6b16c4e — the browser router's result-time
 *  presence re-read). Not user-scoped by design: callers pass an agent id the
 *  platform itself stamped on a selection; returns null on any miss/error. */
export async function findAgentById(agentId: string): Promise<IMessageAgentRow | null> {
  if (!agentId) return null;
  try {
    return await (prisma as any).iMessageAgent.findUnique({ where: { id: agentId } });
  } catch {
    return null;
  }
}

/** All the user's paired Macs, default first, then most recently paired. */
export async function listAgents(userId: string): Promise<IMessageAgentRow[]> {
  try {
    return await (prisma as any).iMessageAgent.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { pairedAt: 'desc' }],
    });
  } catch {
    return [];
  }
}

export interface AgentSelection {
  agent: IMessageAgentRow | null;
  /** Which device was chosen and why — rides the result header (routing transparency). */
  note: string;
  /** Model/agent-facing status when no capable Mac was found. */
  error: string | null;
}

/**
 * Per-surface capability gate (multi-Mac steer 2026-09-24): an ONLINE Mac may
 * still be unable to serve a surface — the local browser needs Mac app ≥ 0.2.0,
 * computer use ≥ 0.3.0. The gate answers "can this online Mac serve the calling
 * surface" and phrases the per-device reason when it cannot, so "too old"
 * excludes only THAT Mac — a capable sibling serves instead of failing the
 * whole surface. Omitted ⇒ every online Mac is capable (the iMessage tool
 * surface needs only the agent link itself — pre-gate behavior, byte-identical).
 */
export interface AgentCapabilityGate {
  /** True when this ONLINE Mac can serve the calling surface. */
  capable: (a: IMessageAgentRow) => boolean;
  /** Short per-device reason when an online Mac is not capable (e.g. "too old (v0.1.9 < 0.2.0)"). */
  reason: (a: IMessageAgentRow) => string;
  /** Surface name for error lines (e.g. "the local browser"). */
  surface: string;
}

/**
 * Device-aware routing selection (multi-Mac). Callers pass an optional target:
 * a device label ("MacBook Pro"), a deviceName, or a raw agent/device id.
 *
 * Selection order:
 *   1. explicit target → that device (matched case-insensitively against
 *      label, then deviceName, then id/deviceId); unknown → clean error naming
 *      the available devices; targeted-but-incapable (with a gate) → error
 *      naming THAT Mac's reason — an explicit ask is never silently re-routed
 *   2. the default Mac, when online (and capable, when a gate is given)
 *   3. the most recently ONLINE (and capable) Mac — the default may be asleep
 *      or too old for this surface; fall over to a sibling rather than fail
 *   4. nothing serves → per-device reasons ("too old" excludes only that Mac,
 *      never the whole surface)
 *
 * Exactly one paired Mac keeps today's behavior: no target needed, that Mac
 * is always the answer. Without a gate this is byte-identical to the
 * pre-gate selection (every online Mac is capable).
 */
export async function selectAgent(
  userId: string,
  target?: string | null,
  gate?: AgentCapabilityGate | null,
): Promise<AgentSelection> {
  const rows = await listAgents(userId);
  if (rows.length === 0) {
    return { agent: null, note: 'no paired Mac', error: 'No Mac is connected. Pair your Mac first.' };
  }
  const online = (a: IMessageAgentRow) => isOnline(a.lastSeenAt);
  const nameOf = (a: IMessageAgentRow) => agentDisplayName(a);
  const serves = (a: IMessageAgentRow) => online(a) && (!gate || gate.capable(a));

  // 1. Explicit target.
  if (target && String(target).trim()) {
    const t = String(target).trim().toLowerCase();
    const match = rows.find((a) =>
      a.label.toLowerCase() === t ||
      (a.deviceName || '').toLowerCase() === t ||
      a.id.toLowerCase() === t ||
      (a.deviceId || '').toLowerCase() === t,
    );
    if (!match) {
      const available = rows.map((a) => `'${nameOf(a)}'${online(a) ? '' : ' (offline)'}`).join(', ');
      return {
        agent: null,
        note: `unknown device '${target}'`,
        error: `No paired Mac matches '${target}'. Paired Macs: ${available}.`,
      };
    }
    if (!online(match)) {
      const others = rows.filter((a) => a.id !== match.id && online(a)).map((a) => `'${nameOf(a)}'`).join(', ');
      return {
        agent: null,
        note: `device '${nameOf(match)}' offline`,
        error: `'${nameOf(match)}' is offline. ${others ? `Online now: ${others}.` : 'No other paired Mac is online.'}`,
      };
    }
    if (gate && !gate.capable(match)) {
      const others = rows.filter((a) => a.id !== match.id && serves(a)).map((a) => `'${nameOf(a)}'`).join(', ');
      return {
        agent: null,
        note: `device '${nameOf(match)}' cannot serve ${gate.surface}`,
        error: `'${nameOf(match)}' cannot serve ${gate.surface} — ${gate.reason(match)}.${others ? ` Capable now: ${others}.` : ''}`,
      };
    }
    return { agent: match, note: `device '${nameOf(match)}' (targeted)`, error: null };
  }

  // 2. Default Mac, when online (and capable).
  const def = rows.find((a) => a.isDefault) ?? rows[0];
  if (serves(def)) {
    return { agent: def, note: rows.length === 1 ? 'the paired Mac' : `device '${nameOf(def)}' (default)`, error: null };
  }

  // 3. Most recently online (and capable) Mac — a capable sibling serves when
  // the default cannot (offline, or too old for this surface).
  const anyServing = rows.find(serves);
  if (anyServing) {
    const why = !online(def)
      ? `default '${nameOf(def)}' offline`
      : `default '${nameOf(def)}' ${gate!.reason(def)}`;
    return {
      agent: anyServing,
      note: `device '${nameOf(anyServing)}' (${why})`,
      error: null,
    };
  }

  // 4. Nothing serves. All offline → the canonical offline line (identical to
  // the no-gate path); otherwise name each Mac's per-device reason.
  const names = rows.map((a) => `'${nameOf(a)}'`).join(', ');
  if (!rows.some(online)) {
    return {
      agent: null,
      note: 'all paired Macs offline',
      error: `Your Mac agent is offline (${names}). Make sure the Digby agent is running.`,
    };
  }
  const perDevice = rows
    .map((a) => `'${nameOf(a)}': ${online(a) ? gate!.reason(a) : 'offline'}`)
    .join(', ');
  return {
    agent: null,
    note: 'no capable Mac',
    error: `No paired Mac can serve ${gate!.surface} right now (${perDevice}). Update the Digby Mac app on a paired Mac, or pair another Mac.`,
  };
}

/** Rename a paired Mac (label = display name). Returns the updated row or null. */
export async function renameAgent(userId: string, agentId: string, label: string): Promise<IMessageAgentRow | null> {
  const clean = label.trim().slice(0, 60);
  // An empty label is a client error (400), not a 500 — the controller checks
  // this before calling, but the service stays safe for other callers too.
  if (!clean) return null;
  try {
    const existing = await (prisma as any).iMessageAgent.findFirst({ where: { id: agentId, userId } });
    if (!existing) return null;
    // Best-effort label de-dupe against the user's OTHER Macs.
    const others = await (prisma as any).iMessageAgent.findMany({ where: { userId, id: { not: agentId } }, select: { label: true } });
    const final = uniquifyLabel(clean, new Set(others.map((r: any) => String(r.label || '').toLowerCase())));
    return await (prisma as any).iMessageAgent.update({ where: { id: agentId }, data: { label: final } });
  } catch (e: any) {
    logger.warn(`iMessage: rename failed: ${e?.message || e}`);
    return null;
  }
}

/** Make a paired Mac the default routing target (exclusively). Returns the row or null. */
export async function setDefaultAgent(userId: string, agentId: string): Promise<IMessageAgentRow | null> {
  try {
    const existing = await (prisma as any).iMessageAgent.findFirst({ where: { id: agentId, userId } });
    if (!existing) return null;
    // Transactional exclusive flip: the partial unique index
    // imessage_agents_one_default_per_user backs this at the storage layer.
    await (prisma as any).$transaction([
      (prisma as any).iMessageAgent.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } }),
      (prisma as any).iMessageAgent.update({ where: { id: agentId }, data: { isDefault: true } }),
    ]);
    return await (prisma as any).iMessageAgent.findUnique({ where: { id: agentId } });
  } catch (e: any) {
    logger.warn(`iMessage: set-default failed: ${e?.message || e}`);
    return null;
  }
}

/** Delete ONE paired Mac row (scoped to the user — no cross-user deletes). */
export async function deleteAgent(userId: string, agentId: string): Promise<boolean> {
  try {
    const existing = await (prisma as any).iMessageAgent.findFirst({ where: { id: agentId, userId } });
    if (!existing) return false;
    await (prisma as any).iMessageAgent.delete({ where: { id: agentId } });
    // If that was the default, promote the most recently paired remaining Mac.
    if (existing.isDefault) {
      const next = await (prisma as any).iMessageAgent.findFirst({ where: { userId }, orderBy: { pairedAt: 'desc' } });
      if (next) await (prisma as any).iMessageAgent.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    return true;
  } catch (e: any) {
    logger.warn(`iMessage: delete failed: ${e?.message || e}`);
    return false;
  }
}

/** Bump lastSeenAt (and optionally version) on every poll — per-device presence.
 *  W0: the poll also refreshes the agent's platform/capability advertisement
 *  (an agent that upgrades mid-life self-heals on its next poll). 2f646c10:
 *  ditto the macOS TCC permission advertisement — present overwrites, absent
 *  never clobbers (a legacy agent keeps its stored state). */
export async function touchAgent(
  agentId: string,
  agentVersion?: string,
  advert?: AgentAdvertisement,
): Promise<void> {
  try {
    await (prisma as any).iMessageAgent.update({
      where: { id: agentId },
      data: {
        lastSeenAt: new Date(),
        ...(agentVersion ? { agentVersion } : {}),
        ...(advert?.platform ? { platform: advert.platform } : {}),
        ...(advert?.capabilities ? { capabilities: advert.capabilities } : {}),
        ...(advert?.permissions ? { permissions: advert.permissions } : {}),
        ...(advert?.unattended ? { unattended: advert.unattended } : {}),
        ...(advert?.remoteAccess ? { remoteAccess: advert.remoteAccess } : {}),
      },
    });
  } catch { /* non-critical */ }
}

export async function disconnectAgent(userId: string, label?: string): Promise<number> {
  try {
    const where = label ? { userId, label } : { userId };
    const result = await (prisma as any).iMessageAgent.deleteMany({ where });
    return result.count ?? 0;
  } catch {
    return 0;
  }
}

export async function hasIMessageConnected(userId: string): Promise<boolean> {
  const agent = await getPrimaryAgent(userId);
  return !!agent;
}
