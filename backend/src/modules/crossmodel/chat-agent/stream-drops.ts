/**
 * Stream drops (2026-10-20, owner: "why does connection drop?").
 *
 * The 207 s reset of the sandbox test was the sandbox's own egress proxy, but
 * real users lose live answers too, and nothing recorded it: a viewer that
 * closed its SSE connection mid-run only flipped a flag (controller
 * streamQuery) or unsubscribed (live-runs / run-event-mirror attach). This
 * module holds the switches of the stream-drop wave and the THROTTLED loop
 * metrics that make drops and reattaches countable:
 *
 *   - sse_viewer_drop — a viewer connection closed before the final event
 *     while its run was still active. meta { surface: stream | attach | guest,
 *     path: local | remote, elapsedMs (connection lifetime), eventsWritten,
 *     runElapsedMs?, guest, host, colour? } — never text.
 *   - sse_reattach — a viewer reattached to a live / just-finished run.
 *     meta { surface: attach | guest, source: local | remote | truncated,
 *     events?, guest, host, colour? }.
 *   - the ux beacon's stream_drop / stream_resume events ride the same
 *     per-key throttle (POST /ux/beacon is public — a flapping client must not
 *     flood loop_metrics) but their OWN per-minute ceiling.
 *
 * Throttle: per key (kind + surface + chat / guest session) at most one row
 * per STREAM_METRIC_KEY_INTERVAL_MS, and at most STREAM_METRIC_MAX_PER_MIN rows
 * per process per minute in each of two budgets — the server-observed rows
 * (sse_viewer_drop / sse_reattach) and the client beacons. The beacons are
 * UNTRUSTED (anyone may post them, with any chat uuid), so they never spend the
 * server rows' budget (review 2026-10-20: 60 beacons with fresh uuids used to
 * silence every server drop row for the minute), and one client — keyed on its
 * hashed client ip — admits at most STREAM_BEACON_MAX_PER_CLIENT_PER_MIN of
 * them however many chat ids it rotates. The key maps are bounded. In-process
 * only (a key never leaves memory).
 *
 * Switches (all release, restore the pre-2026-10-20 behaviour):
 *   GUEST_STREAM_ATTACH_DISABLED=1 — GET /session/:sessionId/stream answers
 *     404 and guest runs are not mirrored to Redis.
 *   SSE_EARLY_HEARTBEAT_DISABLED=1 — streamQuery's 20 s heartbeat starts after
 *     the routing awaits again (not at the header flush).
 *   SSE_DROP_TELEMETRY_DISABLED=1 — no sse_viewer_drop / sse_reattach rows and
 *     the stream_drop / stream_resume beacons record nothing.
 */

import os from 'os';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

export function guestStreamAttachDisabled(): boolean {
  return process.env.GUEST_STREAM_ATTACH_DISABLED === '1';
}

export function sseEarlyHeartbeatDisabled(): boolean {
  return process.env.SSE_EARLY_HEARTBEAT_DISABLED === '1';
}

export function sseDropTelemetryDisabled(): boolean {
  return process.env.SSE_DROP_TELEMETRY_DISABLED === '1';
}

export type SseSurface = 'stream' | 'attach' | 'guest';
export type SseReattachSource = 'local' | 'remote' | 'truncated';

/** One row per key per this window (a reconnect loop on one chat writes one row, not one per retry). */
export const STREAM_METRIC_KEY_INTERVAL_MS = 30_000;
/** Process-wide ceiling per minute across every key — per budget (server rows / client beacons). */
export const STREAM_METRIC_MAX_PER_MIN = 60;
/** One client (hashed client ip) admits at most this many beacons per minute, whatever chat ids it sends. */
export const STREAM_BEACON_MAX_PER_CLIENT_PER_MIN = 6;
/** Bound on the per-key maps (pruned past it). */
export const STREAM_METRIC_MAX_KEYS = 5_000;

/** The two per-minute budgets: rows the SERVER observed, and the public client beacons. */
export type StreamMetricBudget = 'server' | 'beacon';

const lastByKey = new Map<string, number>();
const windows: Record<StreamMetricBudget, { start: number; count: number }> = {
  server: { start: 0, count: 0 },
  beacon: { start: 0, count: 0 },
};
const beaconClients = new Map<string, { start: number; count: number }>();

/**
 * True when a stream metric under `key` may be written now (and counts it):
 * the key's interval, `budget`'s per-minute ceiling and — when a `client` is
 * named — that client's per-minute beacon cap must all admit it; a refusal
 * spends nothing. Pure but for the module state.
 */
export function allowStreamMetric(key: string, now: number = Date.now(), budget: StreamMetricBudget = 'server', client?: string | null): boolean {
  const w = windows[budget];
  if (now - w.start >= 60_000) { w.start = now; w.count = 0; }
  if (w.count >= STREAM_METRIC_MAX_PER_MIN) return false;
  const last = lastByKey.get(key);
  if (last !== undefined && now - last < STREAM_METRIC_KEY_INTERVAL_MS) return false;
  let c: { start: number; count: number } | undefined;
  if (client) {
    c = beaconClients.get(client);
    if (c && now - c.start >= 60_000) c = undefined;
    if (c && c.count >= STREAM_BEACON_MAX_PER_CLIENT_PER_MIN) return false;
  }
  if (lastByKey.size >= STREAM_METRIC_MAX_KEYS) {
    for (const [k, at] of lastByKey) if (now - at >= STREAM_METRIC_KEY_INTERVAL_MS) lastByKey.delete(k);
    if (lastByKey.size >= STREAM_METRIC_MAX_KEYS) lastByKey.clear();
  }
  lastByKey.set(key, now);
  w.count++;
  if (client) {
    if (!c && beaconClients.size >= STREAM_METRIC_MAX_KEYS) {
      for (const [k, v] of beaconClients) if (now - v.start >= 60_000) beaconClients.delete(k);
      if (beaconClients.size >= STREAM_METRIC_MAX_KEYS) beaconClients.clear();
    }
    beaconClients.set(client, c ? { start: c.start, count: c.count + 1 } : { start: now, count: 1 });
  }
  return true;
}

/** Test seam: how many keys the throttle holds. */
export function __streamMetricKeyCount(): number {
  return lastByKey.size;
}

/** Test seam: forget the throttle state. */
export function __resetStreamMetricThrottle(): void {
  lastByKey.clear();
  beaconClients.clear();
  for (const w of Object.values(windows)) { w.start = 0; w.count = 0; }
}

/** The box this process runs on — BOX_NAME (deploy override) else the container hostname; BG_COLOR when set. */
export function streamBoxMeta(env: NodeJS.ProcessEnv = process.env, hostname: string = os.hostname()): { host: string; colour?: string } {
  const host = String(env.BOX_NAME || '').trim() || String(hostname || '').slice(0, 12);
  const colour = String(env.BG_COLOR || '').trim();
  return { host, ...(colour ? { colour } : {}) };
}

/** The loop_metrics session key for a viewer: the chat id, else `anon-<sid>` (the ux_ttft / ux_beacon guest key). */
export function streamSessionKey(chatId?: string | null, guestSessionId?: string | null): string | undefined {
  if (chatId) return chatId;
  if (guestSessionId) return `anon-${guestSessionId}`;
  return undefined;
}

const clampMs = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

/**
 * Record ONE sse_viewer_drop row (throttled). The caller decides it WAS a
 * drop: the viewer closed before the final event while the run is active.
 * Returns whether a row was written. Never throws.
 */
export function recordSseViewerDrop(args: {
  surface: SseSurface;
  path?: 'local' | 'remote';
  sessionKey?: string;
  elapsedMs: number;
  eventsWritten: number;
  runElapsedMs?: number | null;
  guest: boolean;
}): boolean {
  try {
    if (sseDropTelemetryDisabled()) return false;
    if (!allowStreamMetric(`drop:${args.surface}:${args.sessionKey ?? 'none'}`)) return false;
    const elapsedMs = clampMs(args.elapsedMs);
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SSE_VIEWER_DROP,
      ...(args.sessionKey ? { sessionId: args.sessionKey } : {}),
      value: elapsedMs,
      unit: 'ms',
      meta: {
        surface: args.surface,
        path: args.path ?? 'local',
        elapsedMs,
        eventsWritten: Math.max(0, Math.floor(args.eventsWritten || 0)),
        ...(typeof args.runElapsedMs === 'number' ? { runElapsedMs: clampMs(args.runElapsedMs) } : {}),
        guest: args.guest,
        ...streamBoxMeta(),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Record ONE sse_reattach row (throttled). Never throws. */
export function recordSseReattach(args: {
  surface: 'attach' | 'guest';
  source: SseReattachSource;
  sessionKey?: string;
  events?: number;
  guest: boolean;
}): boolean {
  try {
    if (sseDropTelemetryDisabled()) return false;
    if (!allowStreamMetric(`reattach:${args.surface}:${args.sessionKey ?? 'none'}`)) return false;
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SSE_REATTACH,
      ...(args.sessionKey ? { sessionId: args.sessionKey } : {}),
      meta: {
        surface: args.surface,
        source: args.source,
        ...(typeof args.events === 'number' ? { events: Math.max(0, Math.floor(args.events)) } : {}),
        guest: args.guest,
        ...streamBoxMeta(),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** The ux beacon's stream events — recorded only when telemetry is on and the throttle admits them. */
export const STREAM_BEACON_EVENTS: ReadonlySet<string> = new Set(['stream_drop', 'stream_resume']);

/**
 * The beacon gate: per event + key (the chat / guest session the client
 * named), on the BEACON budget, capped per `client` (the hashed client ip;
 * null when unknown — then only the key and the budget apply).
 */
export function allowStreamBeacon(event: string, key: string | undefined, client?: string | null, now: number = Date.now()): boolean {
  if (sseDropTelemetryDisabled()) return false;
  return allowStreamMetric(`beacon:${event}:${key ?? 'none'}`, now, 'beacon', client ?? null);
}
