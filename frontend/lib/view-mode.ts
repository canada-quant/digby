'use client';

/**
 * Viewer mode (owner 2026-10-16: "clean up what users see … very very very minimal … I don't want anything changed
 * for the admin view … a mode on the admin account that is debug mode that shows everything how it is today").
 *
 *   'full'    — an admin with Debug mode ON (every admin's default): today's view, unchanged.
 *   'minimal' — everyone else, and an admin who turned Debug mode OFF: the Grok-style view. The SERVER already
 *               withholds the machinery for this viewer (backend view/minimal-view.ts); the client only renders
 *               what it is given in the minimal layout.
 *
 * One module-level store, read with useViewMode() anywhere. The server's answer (GET /crossmodel/view-mode) is the
 * truth; the last answer is remembered in localStorage only to avoid a flash on the next load (a per-viewer
 * convenience — a failed read falls back to 'minimal', the safe default). Turning Debug mode on or off reloads
 * the page, because transcripts already on screen were filtered for the previous mode.
 *
 * NEXT_PUBLIC_MINIMAL_VIEW_DISABLED=1 (build-time) ⇒ always 'full'.
 */

import { useSyncExternalStore } from 'react';
import apiClient from './api-client';

export type ViewMode = 'full' | 'minimal';

export interface ViewModeState {
  viewMode: ViewMode;
  isAdmin: boolean;
  /** An admin's Debug mode; null for a non-admin (or before the first answer). */
  debugMode: boolean | null;
  loaded: boolean;
}

const CACHE_KEY = 'digby_view_mode';
const DISABLED = process.env.NEXT_PUBLIC_MINIMAL_VIEW_DISABLED === '1';

function readCache(): ViewModeState | null {
  try {
    const raw = typeof window !== 'undefined' ? window.localStorage.getItem(CACHE_KEY) : null;
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (v && (v.viewMode === 'full' || v.viewMode === 'minimal')) {
      return { viewMode: v.viewMode, isAdmin: !!v.isAdmin, debugMode: typeof v.debugMode === 'boolean' ? v.debugMode : null, loaded: false };
    }
  } catch { /* storage blocked — no cache */ }
  return null;
}

function writeCache(s: ViewModeState): void {
  try { window.localStorage.setItem(CACHE_KEY, JSON.stringify({ viewMode: s.viewMode, isAdmin: s.isAdmin, debugMode: s.debugMode })); } catch { /* ignore */ }
}

const SERVER_DEFAULT: ViewModeState = { viewMode: 'minimal', isAdmin: false, debugMode: null, loaded: false };
let state: ViewModeState = DISABLED ? { viewMode: 'full', isAdmin: false, debugMode: null, loaded: true } : SERVER_DEFAULT;
let hydrated = false;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: ViewModeState): void {
  state = next;
  listeners.forEach(l => l());
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!hydrated && !DISABLED) {
    hydrated = true;
    const cached = readCache();
    if (cached) set(cached);
    void loadViewMode();
  }
  return () => { listeners.delete(l); };
}

/** Fetch the viewer's mode from the server (idempotent while in flight). */
export function loadViewMode(): Promise<void> {
  if (DISABLED) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await apiClient.get('/crossmodel/view-mode');
      const d = r.data?.data || {};
      const next: ViewModeState = {
        viewMode: d.viewMode === 'full' ? 'full' : 'minimal',
        isAdmin: !!d.isAdmin,
        debugMode: typeof d.debugMode === 'boolean' ? d.debugMode : null,
        loaded: true,
      };
      writeCache(next);
      set(next);
    } catch {
      // Signed out, network down, or an older server: the safe default.
      set({ ...SERVER_DEFAULT, loaded: true });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Admins only: turn Debug mode on (full view) or off (see what users see). Reloads the page. */
export async function setDebugMode(debugMode: boolean): Promise<void> {
  const r = await apiClient.put('/crossmodel/view-mode', { debugMode });
  const d = r.data?.data || {};
  writeCache({ viewMode: d.viewMode === 'full' ? 'full' : 'minimal', isAdmin: true, debugMode, loaded: true });
  if (typeof window !== 'undefined') window.location.reload();
}

/** Test seam: pin the mode (wins over the server answer and the build switch). null releases it. */
let forced: ViewModeState | null = null;
export function __setViewModeForTests(next: Partial<ViewModeState> | null): void {
  forced = next ? { viewMode: 'minimal', isAdmin: false, debugMode: null, loaded: true, ...next } : null;
  listeners.forEach(l => l());
}

const clientSnapshot = (): ViewModeState => forced ?? state;
const serverSnapshot = (): ViewModeState => forced ?? (DISABLED ? state : SERVER_DEFAULT);

export function useViewMode(): ViewModeState {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
}

/** True when the minimal (user) view should render. */
export function useMinimalView(): boolean {
  return useViewMode().viewMode === 'minimal';
}

// ── Row stubs the server sends a minimal viewer (backend view/minimal-view.ts) ─────────────────────────────

/** A machine row the server withheld (kept as an empty stub so lists and cursors stay aligned). */
export function isMinimalHidden(meta: unknown): boolean {
  return !!(meta && typeof meta === 'object' && (meta as any).minimal?.hidden === true);
}

/** The sender an inter-agent message note names ("Hyperstack 8xA100"), or null when the row is not a note. */
function minimalNoteSender(meta: unknown): string | null {
  const m = meta && typeof meta === 'object' ? (meta as any).minimal : null;
  if (!m || m.note !== 'message_from') return null;
  return typeof m.label === 'string' && m.label.trim() ? m.label.trim() : 'another session';
}

/** The one-line note for an inter-agent message ("Message from Hyperstack 8xA100"), or null. */
export function minimalNoteLabel(meta: unknown): string | null {
  const sender = minimalNoteSender(meta);
  return sender === null ? null : `Message from ${sender}`;
}

/** Sender names a grouped note line shows before "+N more". */
export const NOTE_STRETCH_MAX_NAMES = 3;

/**
 * The text of a stretch of notes, one sender per note in order: a single note keeps "Message from X"; more read
 * "Messages from crossmodel Supervisor (3), Schooltime Supervisor, +2 more" (first-seen order, per-sender counts).
 */
export function minimalNotesText(senders: readonly string[], maxNames: number = NOTE_STRETCH_MAX_NAMES): string {
  if (senders.length === 1) return `Message from ${senders[0]}`;
  const counts = new Map<string, number>();
  for (const s of senders) counts.set(s, (counts.get(s) ?? 0) + 1);
  const names = [...counts].map(([name, n]) => (n > 1 ? `${name} (${n})` : name));
  const shown = names.slice(0, Math.max(1, maxNames));
  const more = names.length - shown.length;
  return `Messages from ${shown.join(', ')}${more > 0 ? `, +${more} more` : ''}`;
}

export type MinimalTranscriptItem<T> =
  | { kind: 'row'; row: T }
  /** One line for a stretch of notes. `rows` are its members (hidden stubs between notes included); `title` is the
   *  uncapped text when the line had to say "+N more". */
  | { kind: 'notes'; key: string; text: string; title?: string; rows: T[] };

/**
 * Owner 2026-10-21 ("what are these messages over and over again?"): a supervisor chat read as a column of bare
 * "Message from …" lines. Consecutive notes render as ONE line; a hidden stub between two notes does not break the
 * stretch, any other row does. Rendering only — every row stays in the list (keys, cursors). Pure.
 */
export function groupMinimalNotes<T>(rows: readonly T[], metaOf: (row: T) => unknown, idOf: (row: T) => string): MinimalTranscriptItem<T>[] {
  const out: MinimalTranscriptItem<T>[] = [];
  let stretch: { key: string; rows: T[]; senders: string[] } | null = null;
  // Hidden stubs after the stretch's last note: members only when another note follows.
  let held: T[] = [];
  const close = () => {
    if (stretch) {
      const text = minimalNotesText(stretch.senders);
      const full = minimalNotesText(stretch.senders, Infinity);
      out.push({ kind: 'notes', key: stretch.key, text, ...(full !== text ? { title: full } : {}), rows: stretch.rows });
      stretch = null;
    }
    for (const row of held) out.push({ kind: 'row', row });
    held = [];
  };
  for (const row of rows) {
    const meta = metaOf(row);
    const sender = minimalNoteSender(meta);
    if (sender !== null) {
      if (stretch) { stretch.rows.push(...held, row); held = []; } else stretch = { key: idOf(row), rows: [row], senders: [] };
      stretch.senders.push(sender);
    } else if (stretch && isMinimalHidden(meta)) {
      held.push(row);
    } else {
      close();
      out.push({ kind: 'row', row });
    }
  }
  close();
  return out;
}
