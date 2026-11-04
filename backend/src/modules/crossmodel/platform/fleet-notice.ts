/**
 * FLEET NOTICE — one owner-written block every agent of that owner reads.
 *
 * Why (2026-10-12 credential incident; docs/FRAMEWORK_LESSONS.md): after a
 * shared host was breached and retired, the owner needed EVERY existing agent —
 * coding lanes, project / fleet supervisors, plain chats — to know at once
 * what was gone, what replaced it and how to reach things now. No channel did
 * that: a lane reads its own repo's .digby/rules, a supervisor its project
 * brief and supervisor state, a chat its relevance-gated user memory. Stale
 * repo learnings kept steering agents to the dead box.
 *
 * What it is: ONE text per user (context store ['user', <userId>] /
 * 'fleet-notice'), written by that user (Account → Agents → Fleet notice, or
 * PUT /api/crossmodel/fleet-notice), with a mandatory expiry (default 30 days,
 * max 90). Until it expires it is injected verbatim into:
 *   - every coding-lane run's system prompt (coding/agent.ts systemPrompt,
 *     beside the stable doctrine so the provider prompt cache keeps working);
 *   - every chat-agent turn's system context (chat-agent/chat-context.ts —
 *     plain chats, project supervisors and the Fleet Supervisor alike).
 * Owner content, not doctrine: it is never part of the generic core, so the
 * prompt-hygiene lint does not apply; the incident lives here only for as
 * long as the owner keeps it.
 *
 * Safety: secret-shaped substrings are REDACTED on save (the block is sent to
 * every model provider on every turn), the text is capped at
 * FLEET_NOTICE_MAX_CHARS, and an expired notice renders nothing.
 *
 * Kill switch FLEET_NOTICE_DISABLED=1 (read per call): nothing is injected; the
 * stored row is kept.
 */

import { storeGet, storePut, storeDelete } from '../memory/context-store';
import { redactSecrets } from './secret-scan';

export const FLEET_NOTICE_KEY = 'fleet-notice';
export const FLEET_NOTICE_MAX_CHARS = 4_000;
export const FLEET_NOTICE_DEFAULT_DAYS = 30;
export const FLEET_NOTICE_MAX_DAYS = 90;
const CACHE_TTL_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface FleetNotice {
  text: string;
  /** ISO time after which nothing is injected. */
  expiresAt: string;
  updatedAt: string;
  /** Who saved it (user id). */
  updatedBy: string;
}

export function fleetNoticeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FLEET_NOTICE_DISABLED === '1';
}

const ns = (userId: string) => ['user', userId];

const cache = new Map<string, { at: number; notice: FleetNotice | null }>();

/** Test hook. */
export function resetFleetNoticeCache(): void { cache.clear(); }

function isNotice(v: unknown): v is FleetNotice {
  const n = v as FleetNotice;
  return !!n && typeof n.text === 'string' && typeof n.expiresAt === 'string';
}

/** The stored notice (expired or not), or null. Never throws. */
export async function getFleetNotice(userId: string | null | undefined, opts: { fresh?: boolean; now?: () => number } = {}): Promise<FleetNotice | null> {
  if (!userId) return null;
  const now = (opts.now ?? Date.now)();
  const hit = cache.get(userId);
  if (!opts.fresh && hit && now - hit.at < CACHE_TTL_MS) return hit.notice;
  try {
    const raw = await storeGet<unknown>(ns(userId), FLEET_NOTICE_KEY);
    const notice = isNotice(raw) ? raw : null;
    cache.set(userId, { at: now, notice });
    return notice;
  } catch {
    return hit?.notice ?? null; // a store hiccup keeps the last known notice, never throws
  }
}

export interface SetFleetNoticeInput {
  text: string;
  /** Days until expiry (1..90). Ignored when expiresAt is given. */
  days?: number;
  /** Explicit ISO expiry (must be in the future and ≤ 90 days out). */
  expiresAt?: string;
}

export type SetFleetNoticeResult =
  | { ok: true; notice: FleetNotice; redacted: string[] }
  | { ok: false; error: string };

/** Validate + redact + store. Pure validation first; one store write. */
export async function setFleetNotice(userId: string, input: SetFleetNoticeInput, opts: { now?: () => number } = {}): Promise<SetFleetNoticeResult> {
  const now = (opts.now ?? Date.now)();
  const raw = String(input?.text ?? '').replace(/\r\n/g, '\n').trim();
  if (!raw) return { ok: false, error: 'text is required (use DELETE to clear the notice)' };
  if (raw.length > FLEET_NOTICE_MAX_CHARS) return { ok: false, error: `text is ${raw.length} chars — the limit is ${FLEET_NOTICE_MAX_CHARS} (every agent reads it on every turn; keep it to the facts that change what they do)` };
  let expiresMs: number;
  if (input.expiresAt) {
    expiresMs = Date.parse(input.expiresAt);
    if (!Number.isFinite(expiresMs)) return { ok: false, error: 'expiresAt is not a valid date' };
  } else {
    const days = input.days === undefined ? FLEET_NOTICE_DEFAULT_DAYS : Number(input.days);
    if (!Number.isFinite(days) || days < 1) return { ok: false, error: 'days must be at least 1' };
    expiresMs = now + Math.round(days) * DAY_MS;
  }
  if (expiresMs <= now) return { ok: false, error: 'the expiry must be in the future' };
  if (expiresMs > now + FLEET_NOTICE_MAX_DAYS * DAY_MS + 60_000) return { ok: false, error: `the expiry can be at most ${FLEET_NOTICE_MAX_DAYS} days out — renew it if the notice is still true then` };
  const { text, hits } = redactSecrets(raw);
  const notice: FleetNotice = { text, expiresAt: new Date(expiresMs).toISOString(), updatedAt: new Date(now).toISOString(), updatedBy: userId };
  await storePut(ns(userId), FLEET_NOTICE_KEY, notice as unknown as Record<string, unknown>);
  cache.set(userId, { at: now, notice });
  return { ok: true, notice, redacted: [...new Set(hits)] };
}

export async function clearFleetNotice(userId: string): Promise<void> {
  await storeDelete(ns(userId), FLEET_NOTICE_KEY);
  cache.set(userId, { at: Date.now(), notice: null });
}

export function fleetNoticeActive(notice: FleetNotice | null, now = Date.now()): notice is FleetNotice {
  return !!notice && !!notice.text.trim() && Date.parse(notice.expiresAt) > now;
}

/** The block injected into prompts ('' when there is nothing to say). */
export function renderFleetNoticeBlock(notice: FleetNotice | null, now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  if (fleetNoticeDisabled(env) || !fleetNoticeActive(notice, now)) return '';
  const set = notice.updatedAt.slice(0, 10);
  const until = notice.expiresAt.slice(0, 10);
  return `═══ OWNER FLEET NOTICE (set ${set}, in force until ${until}) ═══
The owner wrote this for every agent working for them. It describes the CURRENT state of their infrastructure and access. Where it conflicts with a repo doc, AGENTS.md, .digby notes or learnings, memory, a schedule prompt or your own earlier assumptions, THIS notice wins — do not use anything it says is gone, and say so in your final if your task depended on it.
${notice.text.trim()}
═══════════════════`;
}

/** Convenience: read + render for one user. Never throws. */
export async function fleetNoticeBlockFor(userId: string | null | undefined): Promise<string> {
  if (fleetNoticeDisabled()) return '';
  const notice = await getFleetNotice(userId);
  return renderFleetNoticeBlock(notice);
}
