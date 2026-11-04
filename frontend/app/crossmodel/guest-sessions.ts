/**
 * Guest session store (feedback ticket 63bb607f) — browser-local, NON-durable
 * history for anonymous (not-logged-in) chat users.
 *
 * Guests already chat on the open /crossmodel/stream endpoint with server-side
 * context in a 24h Redis key (cm_session:<uuid>); before this store the
 * TRANSCRIPT died with the page. Now each guest conversation is also kept in
 * localStorage (this module is the only reader/writer) so the guest sidebar
 * can list, reopen, and delete past conversations — while the copy stays
 * explicitly browser-local ("saved only in this browser") to preserve the
 * sign-up value proposition. Sign-in migration of the SERVER-side context is
 * unchanged (auth.controller migrateSessionToChat).
 *
 * Design constraints:
 *  - PURE module, no React — unit-tested like plain-session.ts.
 *  - SSR-safe: every localStorage touch sits behind a `typeof window` guard.
 *  - Chat must never break: all writes are try/catch'd; a full/blocked
 *    localStorage (Safari private mode, quota) silently skips persistence.
 *  - Bounded: 20 sessions max (LRU tail evicted on upsert), 60 messages per
 *    session (latest kept), heavy plainMeta payloads (per-model responses +
 *    labels — admin/debug surfaces) stripped on write, and a 200 KB per-session
 *    serialized cap enforced by dropping message `parts` (the work-trail, the
 *    bulk of the size) first.
 */

import type { CodingMessage } from '@/lib/api/coding';
import { isPlaceholderChatTitle } from '@/lib/chat-title';

export interface GuestSessionRecord {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: CodingMessage[];
}

interface GuestSessionStore {
  version: 1;
  sessions: GuestSessionRecord[];
}

const STORE_KEY = 'digbyGuestSessions.v1';

/** Cap on stored conversations — the LRU tail evicts on upsert beyond this. */
export const MAX_SESSIONS = 20;
/** Cap on messages kept per session (the LATEST window is kept). */
export const MAX_MESSAGES = 60;
/** Serialized per-session byte cap — enforced by dropping message `parts`. */
export const MAX_SESSION_BYTES = 200_000;

const byUpdatedDesc = (a: GuestSessionRecord, b: GuestSessionRecord): number =>
  b.updatedAt.localeCompare(a.updatedAt);

function isRecord(v: any): v is GuestSessionRecord {
  return !!v
    && typeof v.id === 'string' && typeof v.title === 'string'
    && typeof v.createdAt === 'string' && typeof v.updatedAt === 'string'
    && Array.isArray(v.messages);
}

function readStore(): GuestSessionStore {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return { version: 1, sessions: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      return { version: 1, sessions: [] };
    }
    // Defensive re-sort: the store is written sorted, but a hand-edited or
    // version-skewed blob must still load in the rail's display order.
    return { version: 1, sessions: parsed.sessions.filter(isRecord).sort(byUpdatedDesc) };
  } catch {
    // Corrupted JSON / blocked storage — treat as empty, never break chat.
    return { version: 1, sessions: [] };
  }
}

function writeStore(store: GuestSessionStore): void {
  window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
}

/**
 * Sanitize a record for persistence: trim to the latest MAX_MESSAGES window,
 * strip the heavy plainMeta.models/modelLabels payloads (full per-model
 * responses — the single largest field), then enforce the byte cap by
 * dropping message `parts` (reasoning/tool work-trail) when still over.
 */
function sanitizeRecord(rec: GuestSessionRecord): GuestSessionRecord {
  let messages = rec.messages.length > MAX_MESSAGES
    ? rec.messages.slice(-MAX_MESSAGES)
    : rec.messages;
  messages = messages.map(m => {
    if (!m.plainMeta || (m.plainMeta.models === undefined && m.plainMeta.modelLabels === undefined)) return m;
    const { models: _models, modelLabels: _labels, ...rest } = m.plainMeta;
    return { ...m, plainMeta: rest };
  });
  let out: GuestSessionRecord = { ...rec, messages };
  if (JSON.stringify(out).length > MAX_SESSION_BYTES) {
    out = { ...out, messages: out.messages.map(m => (m.parts ? { ...m, parts: undefined } : m)) };
  }
  return out;
}

const isQuotaError = (e: any): boolean =>
  e?.name === 'QuotaExceededError' || e?.code === 22;

/** All stored guest sessions, newest-updated first. [] during SSR. */
export function loadGuestSessions(): GuestSessionRecord[] {
  if (typeof window === 'undefined') return [];
  return readStore().sessions;
}

/** One session by id (undefined when absent or during SSR). */
export function getGuestSession(id: string): GuestSessionRecord | undefined {
  if (typeof window === 'undefined') return undefined;
  return readStore().sessions.find(s => s.id === id);
}

/**
 * Insert or replace a session (matched by id), keeping the list sorted
 * newest-first and capped at MAX_SESSIONS (LRU tail evicted). Never throws:
 * on QuotaExceededError the oldest half of the list is evicted and the write
 * retried ONCE; any other failure silently no-ops — chat must never break.
 */
export function upsertGuestSession(rec: GuestSessionRecord): void {
  if (typeof window === 'undefined') return;
  try {
    const clean = sanitizeRecord(rec);
    const rest = readStore().sessions.filter(s => s.id !== clean.id);
    writeStore({ version: 1, sessions: [clean, ...rest].sort(byUpdatedDesc).slice(0, MAX_SESSIONS) });
  } catch (err) {
    if (!isQuotaError(err)) return; // blocked storage etc. — silently skip
    try {
      const clean = sanitizeRecord(rec);
      const rest = readStore().sessions.filter(s => s.id !== clean.id);
      // Evict the older HALF of the list, then retry the write once.
      const kept = rest.slice(0, Math.floor(MAX_SESSIONS / 2));
      writeStore({ version: 1, sessions: [clean, ...kept].sort(byUpdatedDesc).slice(0, MAX_SESSIONS) });
    } catch {
      /* still full — history is best-effort, chat wins */
    }
  }
}

/** Delete one session. No-op during SSR or on storage failure. */
export function removeGuestSession(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    const rest = readStore().sessions.filter(s => s.id !== id);
    writeStore({ version: 1, sessions: rest });
  } catch {
    /* best-effort */
  }
}

/**
 * Sidebar title from the first user message — the same 60-char placeholder
 * shape the backend and the authed send path use (slice + '…'), with
 * whitespace collapsed so the single-line rail row renders cleanly.
 */
export function guestSessionTitle(firstUserText: string): string {
  const clean = (firstUserText || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'New conversation';
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

/**
 * Apply the SERVER-generated title to a stored guest session (owner report
 * 2026-09-26: "guest mode, chat title generation didn't work" — the backend
 * never generated one for a chatId-less run, and the client never applied
 * one). The title arrives on the 'chat-title' stream frame and as `autoTitle`
 * on 'complete'; it replaces ONLY a title that is still the first-message
 * placeholder (isPlaceholderChatTitle — the same shapes the server treats as
 * stale), so a title already applied by the earlier frame is left alone.
 * Returns true when the record changed. Never throws; no-op for a missing
 * record (the transcript upsert after the user echo always precedes the
 * stream), an empty title, or during SSR.
 */
export function retitleGuestSession(id: string, title: string): boolean {
  if (typeof window === 'undefined') return false;
  const next = (title || '').replace(/\s+/g, ' ').trim();
  if (!next) return false;
  const rec = getGuestSession(id);
  if (!rec || rec.title === next) return false;
  const firstUser = rec.messages.find(m => m.role === 'user');
  if (!isPlaceholderChatTitle(rec.title, typeof firstUser?.content === 'string' ? firstUser.content : '')) return false;
  upsertGuestSession({ ...rec, title: next });
  return true;
}
