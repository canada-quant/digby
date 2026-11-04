/**
 * Browser-agent activity model (UI overhaul Phase 6a — "the browser program").
 *
 * The backend emits per-action `browser-observation` transparency events for
 * every agent browse step (browser-agent/glm-loop.ts): one frame per action —
 * `{ action, ok, url, driver, preview, reasoning }` — plus a separate
 * screenshot frame `{ action: 'screenshot', ok, url, driver, screenshotBase64 }`.
 * They reach the client on BOTH lanes:
 *   - plain chat: legacy SSE `browser-observation` → makeLegacyNormalizer maps
 *     it to the coding-vocabulary `browser_observation`;
 *   - coding sessions: `browser_observation` rides the run stream natively
 *     (ToolCache forwards the browser_task sub-session's frames).
 *
 * This module is the PURE state layer the views share: the accumulating
 * activity log (reducer), display helpers, and the mobile bottom-sheet
 * open/dismiss state machine. No React, fully unit-tested.
 */

export interface BrowserActivityEntry {
  /** 1-based arrival index within the current log window. */
  step: number;
  /** Action vocabulary: navigate/get_content/click/type/scroll/screenshot/extract… */
  action: string;
  ok: boolean;
  url?: string;
  /** Which driver executed it — 'cloud' (BrightData) or 'local' (paired Mac). */
  driver?: string;
  /** First ~280 chars of the observation (or a ⚠-prefixed error line). */
  preview?: string;
  /** The model's own one-line rationale for the step. */
  reasoning?: string;
  /** True when this frame carried a screenshot (held on state.screenshot). */
  hasScreenshot: boolean;
  /** Client ingest time (ms epoch) — the wire frames carry no timestamps. */
  ts: number;
}

export interface BrowserScreenshot {
  /** data: URL, directly renderable (ExpandableDataImage / <img>). */
  src: string;
  url?: string;
  ts: number;
}

export interface BrowserActivityState {
  /** Oldest → newest (views render reversed for the reverse-chron log). */
  entries: BrowserActivityEntry[];
  /** The LATEST screenshot — the live view. Older ones are dropped (memory). */
  screenshot: BrowserScreenshot | null;
  /** Last URL any observation reported — the URL-bar chrome. */
  currentUrl: string | null;
  /** Driver of the latest frame — 'cloud' | 'local' | 'computer' (the user's
   *  Mac screen, computer-use). Drives the chrome (URL pill vs "Your Mac"). */
  currentDriver: string | null;
  /** Frontmost app reported by the latest computer-use frame, if any. */
  currentApp: string | null;
}

export const EMPTY_BROWSER_ACTIVITY: BrowserActivityState = {
  entries: [], screenshot: null, currentUrl: null, currentDriver: null, currentApp: null,
};

/** Log window cap — a bounded browser_task runs ≤ ~12 actions, so 80 comfortably
 *  holds several browse turns of one chat before the oldest rows roll off. */
export const MAX_BROWSER_LOG_ENTRIES = 80;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** Image MIME for a frame's screenshot: the wire's `mime` when it is an
 *  image type, else PNG (the pre-2026-09-09 frames carried no mime and were
 *  always PNG). JPEG frames come from the Mac agent's live-view captures and
 *  from computer-use screenshots. */
export function screenshotMime(data: any): string {
  const m = data && typeof data === 'object' ? str(data.mime) : undefined;
  return m && /^image\/[a-z0-9.+-]+$/i.test(m) ? m : 'image/png';
}

/**
 * Fold one `browser_observation` frame into the log. Malformed frames (no
 * string `action`) return the SAME state reference so React updates no-op.
 * Screenshot base64 is held ONLY on `state.screenshot` (latest wins) — the log
 * entry keeps a `hasScreenshot` marker, so an 80-row log can't pin dozens of
 * PNGs in memory.
 *
 * LIVE-VIEW frames (`live: true`, 2026-09-09): the drivers now capture a
 * screenshot after EVERY action purely for the panel (the model never asked
 * for it). Those refresh the live view — and flag the last logged action as
 * carrying a screenshot — WITHOUT appending a "Captured the page" row, so the
 * action log stays the model's own steps.
 */
export function reduceBrowserActivity(
  state: BrowserActivityState,
  data: any,
  nowMs: number = Date.now(),
): BrowserActivityState {
  const action = data && typeof data === 'object' ? str(data.action) : undefined;
  if (!action) return state;
  const shot = str(data.screenshotBase64);
  const driver = str(data.driver) || state.currentDriver;
  const app = str(data.app) || (str(data.driver) === 'computer' ? state.currentApp : null);
  if (data.live === true) {
    if (!shot) return state; // a live frame with no pixels carries nothing for the panel
    const url = str(data.url) || state.currentUrl;
    const entries = state.entries.length
      ? [...state.entries.slice(0, -1), { ...state.entries[state.entries.length - 1], hasScreenshot: true }]
      : state.entries;
    return {
      entries,
      screenshot: { src: `data:${screenshotMime(data)};base64,${shot}`, url: url || undefined, ts: nowMs },
      currentUrl: url,
      currentDriver: driver,
      currentApp: app,
    };
  }
  const entry: BrowserActivityEntry = {
    step: (state.entries[state.entries.length - 1]?.step ?? 0) + 1,
    action,
    ok: data.ok !== false,
    url: str(data.url),
    driver: str(data.driver),
    preview: str(data.preview),
    reasoning: str(data.reasoning),
    hasScreenshot: !!shot,
    ts: nowMs,
  };
  const entries = [...state.entries, entry];
  if (entries.length > MAX_BROWSER_LOG_ENTRIES) entries.splice(0, entries.length - MAX_BROWSER_LOG_ENTRIES);
  return {
    entries,
    screenshot: shot ? { src: `data:${screenshotMime(data)};base64,${shot}`, url: entry.url, ts: nowMs } : state.screenshot,
    currentUrl: entry.url || state.currentUrl,
    currentDriver: driver,
    currentApp: app,
  };
}

/** Bare host ('https://www.example.com/x?y' → 'example.com'); '' if unparseable. */
export function browserHost(url: string | null | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** URL path for the chrome pill ('/' renders as nothing, like InAppBrowser). */
export function browserPath(url: string | null | undefined): string {
  if (!url) return '';
  try { const p = new URL(url).pathname; return p !== '/' ? p : ''; } catch { return ''; }
}

/** Sheet/section header title. No <title> rides the wire — the host stands in
 *  (favicon services are external hosts, so the icon is always lucide Globe). */
export function browserPageLabel(state: BrowserActivityState): string {
  if (state.currentDriver === 'computer') return state.currentApp ? `Your Mac · ${state.currentApp}` : 'Your Mac';
  return browserHost(state.currentUrl) || 'Agent browser';
}

/** Compact human line for a log row (the entry's own reasoning wins). */
export function browserActionLabel(e: Pick<BrowserActivityEntry, 'action' | 'url'> & { driver?: string }): string {
  const host = browserHost(e.url);
  const mac = e.driver === 'computer';
  switch (e.action) {
    case 'navigate': return host ? `Opened ${host}` : 'Opened a page';
    case 'get_content': return 'Read the page';
    case 'extract': return 'Extracted details';
    case 'click': return mac ? 'Clicked on screen' : 'Clicked an element';
    case 'type': return mac ? 'Typed' : 'Typed into a field';
    case 'scroll': return mac ? 'Scrolled' : 'Scrolled the page';
    case 'screenshot': return mac ? 'Looked at the screen' : 'Captured the page';
    // computer-use vocabulary (computer-agent/computer-loop.ts)
    case 'key': return 'Pressed a key';
    case 'open': return 'Opened an app';
    default: return e.action.replace(/_/g, ' ');
  }
}

/**
 * Which surface renders the agent-browser view (Phase 6a): the workspace-panel
 * section on desktop, the ChatGPT-style bottom sheet on mobile (the app's ONE
 * mobile line is the `md:` breakpoint), nothing without activity.
 */
export type BrowserSurface = 'panel' | 'sheet' | 'none';
export function browserSurface(hasActivity: boolean, isMobile: boolean): BrowserSurface {
  if (!hasActivity) return 'none';
  return isMobile ? 'sheet' : 'panel';
}

/**
 * Mobile bottom-sheet state machine. Auto-opens on browser activity (the
 * ChatGPT pattern) but STAYS closed once the user dismissed it — until they
 * reopen it themselves or a fresh context ('reset': chat switch / full replay)
 * clears the dismissal.
 */
export interface BrowserSheetState { open: boolean; dismissed: boolean }
export const CLOSED_BROWSER_SHEET: BrowserSheetState = { open: false, dismissed: false };

export type BrowserSheetEvent = 'observation' | 'dismiss' | 'open' | 'reset';
export function nextBrowserSheetState(s: BrowserSheetState, ev: BrowserSheetEvent): BrowserSheetState {
  switch (ev) {
    case 'observation': return s.dismissed || s.open ? s : { open: true, dismissed: false };
    case 'dismiss': return { open: false, dismissed: true };
    case 'open': return { open: true, dismissed: false };
    case 'reset': return CLOSED_BROWSER_SHEET;
  }
}

/**
 * Seed the panel from PERSISTED screenshots (2026-09-23 — owner: "I don't see
 * where the browser tab is"): the live stream is the only source of frames, so
 * a reloaded chat (or a plain chat, which has no run replay) showed an empty
 * Browser tab even though the run's final screenshot now lives in the
 * transcript as an assistant `image` part (source 'browser' | 'computer').
 * Returns a state showing the LATEST such screenshot as the live view with one
 * log row, or null when the transcript carries none. Pure.
 */
export function seedBrowserActivityFromMessages(
  messages: ReadonlyArray<{ role: string; createdAt?: string; parts?: ReadonlyArray<any> | null }>,
  nowMs: number = Date.now(),
): BrowserActivityState | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.parts)) continue;
    for (let j = m.parts.length - 1; j >= 0; j--) {
      const p = m.parts[j];
      if (!p || p.type !== 'image' || (p.source !== 'browser' && p.source !== 'computer')) continue;
      const src = typeof p.url === 'string' && p.url
        ? p.url
        : typeof p.data === 'string' && p.data ? `data:${p.mediaType || 'image/png'};base64,${p.data}` : '';
      if (!src) continue;
      const ts = p.ts ? Date.parse(p.ts) : (m.createdAt ? Date.parse(m.createdAt) : NaN);
      const at = Number.isFinite(ts) ? ts : nowMs;
      const computer = p.source === 'computer';
      return {
        entries: [{
          step: 1, action: 'screenshot', ok: true, url: p.pageUrl, driver: computer ? 'computer' : undefined,
          preview: p.name, hasScreenshot: true, ts: at,
        }],
        screenshot: { src, url: p.pageUrl, ts: at },
        currentUrl: p.pageUrl || null,
        currentDriver: computer ? 'computer' : null,
        currentApp: computer && typeof p.app === 'string' ? p.app : null,
      };
    }
  }
  return null;
}
