/**
 * Account → Coding → Dev container (tailnet): what the status panel says
 * (2026-10-13 — owner: "properly configure it for professional config").
 *
 * Pure: status in, display decisions out — so every panel state is testable
 * without rendering the effectful tab. Rules:
 *  - the coding server not answering is "state unknown", never "not running";
 *  - with a saved key the fix is Reconnect with that key — the login link is
 *    shown ONLY when no key is saved (the keyless path);
 *  - a node that expires, or is untagged, gets a plain warning: tagged nodes
 *    don't expire and run with the tag's permissions, not a person's.
 */

import type { DevContainerStatus, DevContainerActionRecord } from './api/coding';

export type PanelTone = 'warn' | 'muted' | 'success';

export interface PanelMessage {
  tone: PanelTone;
  text: string;
}

export interface DevContainerPanelView {
  /** "running", "not running" or "state unknown". */
  containerState: string;
  /** "tailnet: Running · 100.x.y.z" — null when there is no tailnet read. */
  tailnetLine: string | null;
  messages: PanelMessage[];
  /** Offer the "approve the node" link — keyless path only. */
  showLoginLink: boolean;
  reconnectEnabled: boolean;
  /** Draw attention to Reconnect (key saved and the node is down / expiring / untagged). */
  reconnectRecommended: boolean;
  restartEnabled: boolean;
  actionRunning: boolean;
  actionMessage: PanelMessage | null;
}

const DATE_FMT = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const TIME_FMT = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

/** "Nov 27, 2026" (UTC — the same date for every viewer). */
export function formatExpiryDate(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? DATE_FMT.format(new Date(t)) : iso;
}

const ACTION_LABEL: Record<DevContainerActionRecord['action'], string> = {
  restart: 'Rebuilding the container',
  tailnet_reconnect: 'Reconnecting the tailnet',
  tailnet_restart: 'Restarting the tailnet daemon',
};

/** A finished action's note stays on screen this long. */
export const ACTION_RESULT_VISIBLE_MS = 30 * 60_000;

export function devContainerPanelView(dc: DevContainerStatus, now: number = Date.now()): DevContainerPanelView {
  const unknown = dc.reach === 'unreachable';
  const ts = dc.tailscale;
  const joined = !!ts && ts.state === 'Running';
  const action = dc.action ?? null;
  const actionRunning = action?.state === 'running';
  const messages: PanelMessage[] = [];

  let reconnectRecommended = false;
  if (unknown) {
    messages.push({ tone: 'muted', text: dc.note || "The coding server didn't answer, so the container's live state is unknown right now. Try again in a minute." });
  } else if (!dc.keyConfigured) {
    messages.push({
      tone: 'warn',
      text: 'No Tailscale auth key is saved. Save a tagged, reusable auth key below — until the container joins your tailnet, sessions use per-session containers.',
    });
  } else if (!dc.running) {
    messages.push({ tone: 'muted', text: "The container isn't running. It starts with the next coding session, or press Restart to rebuild it now with your saved key." });
  } else if (!joined) {
    reconnectRecommended = true;
    messages.push({ tone: 'warn', text: "The container isn't connected to your tailnet. Press Reconnect to join with your saved key." });
  } else if (ts?.keyExpiry) {
    reconnectRecommended = true;
    const past = Date.parse(ts.keyExpiry) <= now;
    messages.push({
      tone: 'warn',
      text: past
        ? `This tailnet node's key expired on ${formatExpiryDate(ts.keyExpiry)} — save a tagged auth key and press Reconnect; tagged nodes don't expire.`
        : `This tailnet node expires on ${formatExpiryDate(ts.keyExpiry)} — save a tagged auth key and press Reconnect; tagged nodes don't expire.`,
    });
  } else if (ts && Array.isArray(ts.tags) && ts.tags.length === 0) {
    reconnectRecommended = true;
    messages.push({ tone: 'warn', text: "This tailnet node isn't tagged, so it runs with your personal tailnet permissions. Save a tagged auth key and press Reconnect." });
  }

  let actionMessage: PanelMessage | null = null;
  if (action) {
    if (actionRunning) {
      const started = Date.parse(action.startedAt);
      actionMessage = { tone: 'muted', text: `${ACTION_LABEL[action.action]}…${Number.isFinite(started) ? ` (started ${TIME_FMT.format(new Date(started))} UTC)` : ''}` };
    } else {
      const finished = Date.parse(action.finishedAt ?? action.startedAt);
      if (Number.isFinite(finished) && now - finished < ACTION_RESULT_VISIBLE_MS && action.note) {
        actionMessage = { tone: action.state === 'done' ? 'success' : 'warn', text: action.note };
      }
    }
  }

  return {
    containerState: unknown ? 'state unknown' : dc.running ? 'running' : 'not running',
    tailnetLine: ts && !unknown ? `tailnet: ${ts.state}${ts.ip4 ? ` · ${ts.ip4}` : ''}` : null,
    messages,
    showLoginLink: !dc.keyConfigured && !!ts?.loginUrl && !joined,
    reconnectEnabled: dc.enabled && dc.keyConfigured && dc.running && !unknown && !actionRunning,
    reconnectRecommended: reconnectRecommended && !actionRunning,
    restartEnabled: dc.enabled && !unknown && !actionRunning,
    actionRunning,
    actionMessage,
  };
}
