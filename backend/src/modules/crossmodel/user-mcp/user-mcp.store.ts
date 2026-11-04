/**
 * User-added MCP servers (ticket e294f9a4) — persistence. NO migration: the
 * records live in the context store (table "store", memory/context-store.ts)
 * under two fixed namespaces, one row per server each:
 *
 *   ['user-mcp']        key `<userId>:<serverId>` → StoredMcpServer (the user's
 *                       config — written only by the user's own API calls);
 *   ['user-mcp-health'] key `<userId>:<serverId>` → StoredMcpHealth (health +
 *                       the cached tools/list — written by probes and by call
 *                       outcomes through an atomic JSONB MERGE, so a call's
 *                       counter update never clobbers a probe's fresh tool list).
 *
 * Fixed namespaces keep every lookup on the table's primary key: a user's
 * servers = namespace equality + a key prefix inside that small partition;
 * the health sweep = namespace equality.
 *
 * Secrets (the auth header VALUE and the URL — a URL can embed a token) are
 * AES-256-GCM encrypted at rest with a key derived from JWT_SECRET under the
 * label "digby-user-mcp:" (domain-separated from coding credentials; no new
 * deployment secret). Rotating JWT_SECRET ⇒ the user re-enters the token —
 * the read path answers that honestly instead of throwing.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import prisma from '../../../config/database';
import { storeGet, storePut, storeDelete } from '../memory/context-store';
import type { CachedMcpTool, McpHealthStatus, McpErrorClassLite } from './user-mcp-tools';
import type { McpTransport, McpTransportPref } from './mcp-client';

export const SERVERS_NS = ['user-mcp'];
export const HEALTH_NS = ['user-mcp-health'];
const SERVERS_NS_PATH = 'user-mcp';
const HEALTH_NS_PATH = 'user-mcp-health';

export const rowKey = (userId: string, serverId: string): string => `${userId}:${serverId}`;

export interface StoredMcpServer {
  id: string;
  userId: string;
  name: string;
  slug: string;
  /** Encrypted full URL. */
  urlEnc: string;
  /** Display form (secrets masked) — safe to show / log. */
  urlDisplay: string;
  transport: McpTransportPref;
  /** Auth header NAME ('' = no auth). */
  authHeader: string;
  /** Encrypted auth header VALUE (null = none). */
  authEnc: string | null;
  /** "••••abcd" — the last 4 chars of the token. */
  authPreview: string | null;
  enabled: boolean;
  /** Allow tools that change data on unattended (machine) runs. Default false. */
  machineWrites: boolean;
  /** Original tool names the user switched off. */
  disabledTools: string[];
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMcpHealth {
  status: McpHealthStatus;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorClass: McpErrorClassLite | null;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  nextCheckAt: string | null;
  lastLatencyMs: number | null;
  /** Transport the last successful probe used (calls skip auto-detection). */
  transport: McpTransport | null;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  tools: CachedMcpTool[];
  toolsAt: string | null;
  toolsTruncated: boolean;
  callsOk: number;
  callsFailed: number;
  lastCallAt: string | null;
}

export function emptyHealth(): StoredMcpHealth {
  return {
    status: 'unknown', consecutiveFailures: 0, lastError: null, lastErrorClass: null,
    lastCheckAt: null, lastOkAt: null, nextCheckAt: null, lastLatencyMs: null,
    transport: null, serverName: null, serverVersion: null, protocolVersion: null,
    tools: [], toolsAt: null, toolsTruncated: false, callsOk: 0, callsFailed: 0, lastCallAt: null,
  };
}

// ── Secrets ──────────────────────────────────────────────────────────────────

const ALGO = 'aes-256-gcm';
function secretKey(): Buffer {
  const secret = process.env.JWT_SECRET || '';
  if (!secret) throw new Error('JWT_SECRET is not set');
  return createHash('sha256').update(`digby-user-mcp:${secret}`).digest();
}
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, secretKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
export function decryptSecret(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const decipher = createDecipheriv(ALGO, secretKey(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return decipher.update(buf.subarray(28)).toString('utf8') + decipher.final('utf8');
}
/** Decrypt or null (a JWT_SECRET rotation leaves undecryptable rows — the caller says "re-enter"). */
export function tryDecrypt(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  try { return decryptSecret(ciphertext); } catch { return null; }
}

// ── Servers ──────────────────────────────────────────────────────────────────

function asServer(v: unknown): StoredMcpServer | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as StoredMcpServer;
  return typeof s.id === 'string' && typeof s.userId === 'string' && typeof s.urlEnc === 'string' ? s : null;
}

export async function listUserServers(userId: string): Promise<StoredMcpServer[]> {
  const rows = await prisma.contextStoreEntry.findMany({
    where: { namespacePath: SERVERS_NS_PATH, key: { startsWith: `${userId}:` } },
    select: { value: true },
  });
  return rows.map((r) => asServer(r.value)).filter((s): s is StoredMcpServer => !!s && s.userId === userId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listAllServers(): Promise<StoredMcpServer[]> {
  const rows = await prisma.contextStoreEntry.findMany({ where: { namespacePath: SERVERS_NS_PATH }, select: { value: true } });
  return rows.map((r) => asServer(r.value)).filter((s): s is StoredMcpServer => !!s);
}

export async function getServer(userId: string, serverId: string): Promise<StoredMcpServer | null> {
  const s = asServer(await storeGet<StoredMcpServer>(SERVERS_NS, rowKey(userId, serverId)));
  return s && s.userId === userId ? s : null;
}

export async function putServer(s: StoredMcpServer): Promise<void> {
  await storePut(SERVERS_NS, rowKey(s.userId, s.id), s as unknown as Record<string, unknown>);
}

export async function deleteServerRows(userId: string, serverId: string): Promise<void> {
  await storeDelete(SERVERS_NS, rowKey(userId, serverId));
  await storeDelete(HEALTH_NS, rowKey(userId, serverId));
}

// ── Health ───────────────────────────────────────────────────────────────────

function asHealth(v: unknown): StoredMcpHealth {
  const base = emptyHealth();
  if (!v || typeof v !== 'object') return base;
  const h = v as Partial<StoredMcpHealth>;
  return { ...base, ...h, tools: Array.isArray(h.tools) ? h.tools : [] };
}

export async function getHealth(userId: string, serverId: string): Promise<StoredMcpHealth> {
  return asHealth(await storeGet<StoredMcpHealth>(HEALTH_NS, rowKey(userId, serverId)));
}

/** Every health row for the given user (one query on the namespace partition). */
export async function listUserHealth(userId: string): Promise<Map<string, StoredMcpHealth>> {
  const rows = await prisma.contextStoreEntry.findMany({
    where: { namespacePath: HEALTH_NS_PATH, key: { startsWith: `${userId}:` } },
    select: { key: true, value: true },
  });
  const out = new Map<string, StoredMcpHealth>();
  for (const r of rows) out.set(r.key.slice(userId.length + 1), asHealth(r.value));
  return out;
}

export async function listAllHealth(): Promise<Map<string, StoredMcpHealth>> {
  const rows = await prisma.contextStoreEntry.findMany({ where: { namespacePath: HEALTH_NS_PATH }, select: { key: true, value: true } });
  const out = new Map<string, StoredMcpHealth>();
  for (const r of rows) out.set(r.key, asHealth(r.value));
  return out;
}

/**
 * Merge top-level health fields into the row ATOMICALLY (jsonb `||`), creating
 * the row when absent. Fields not in `patch` (e.g. the cached tools on a call
 * outcome) are left exactly as the database holds them.
 */
export async function mergeHealth(userId: string, serverId: string, patch: Partial<StoredMcpHealth>): Promise<void> {
  const key = rowKey(userId, serverId);
  const json = JSON.stringify(patch);
  const updated = await prisma.$executeRaw`UPDATE "store" SET "value" = "value" || ${json}::jsonb, "updated_at" = now() WHERE "namespace_path" = ${HEALTH_NS_PATH} AND "key" = ${key}`;
  if (!updated) await storePut(HEALTH_NS, key, { ...emptyHealth(), ...patch } as unknown as Record<string, unknown>);
}

export async function resetHealth(userId: string, serverId: string): Promise<void> {
  await storePut(HEALTH_NS, rowKey(userId, serverId), emptyHealth() as unknown as Record<string, unknown>);
}
