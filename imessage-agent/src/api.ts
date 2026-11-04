/**
 * HTTP client for the Digby backend. All calls are OUTBOUND from the Mac
 * (the backend never connects to us), so this works behind any home NAT/firewall.
 */

import { AgentConfig, AGENT_VERSION } from './config';
import { PermissionStatus } from './permissions';
import { UpdateAdvert } from './self-update';

export interface AgentCommand {
  cmdId: string;
  method: string;
  params: Record<string, unknown>;
}

/**
 * The four permission flags as poll-query params (ticket 2f646c10): each is
 * '1' or '0'. Returns an empty string for a null status (a legacy poll that
 * could not compute permissions advertises nothing — the backend keeps the
 * stored value, same absent-never-clobbers contract as every other advert).
 */
function permissionsQuery(p: PermissionStatus | null): string {
  if (!p) return '';
  let q = `&ax=${p.ax ? 1 : 0}&sr=${p.sr ? 1 : 0}&fda=${p.fda ? 1 : 0}&relaunch=${p.relaunch ? 1 : 0}`;
  // 1ea9a120: calendar is derived from real calendar reads, not a probe —
  // undefined means "never read" and the key stays ABSENT (backend keeps its
  // stored value; absent-never-clobbers, same contract as the four above).
  if (p.calendar !== undefined) q += `&cal=${p.calendar ? 1 : 0}`;
  // 30d3c366: Input Monitoring rides the same contract — undefined means the
  // bridge could not answer, so the key stays ABSENT and the backend keeps its
  // stored value (an unknown must never overwrite a known grant).
  if (p.inputMonitoring !== undefined) q += `&im=${p.inputMonitoring ? 1 : 0}`;
  return q;
}

/**
 * 1ea9a120: the pair body's permissions object carries the backend's
 * canonical advert keys — `calendar` is this module's local property name
 * and maps to `cal` at the wire boundary, exactly as permissionsQuery maps
 * it for the poll params. One key per fact on the wire: the backend's
 * permissionsFromBody reads `cal`, and a raw PermissionStatus would land a
 * calendar grant under a key the parser never reads (the pair/poll asymmetry
 * the 0.7.0 adversarial review caught).
 */
function pairPermissions(p: PermissionStatus): Record<string, boolean> {
  const wire: Record<string, boolean> = { ax: p.ax, sr: p.sr, fda: p.fda, relaunch: p.relaunch };
  if (p.calendar !== undefined) wire.cal = p.calendar;
  // 30d3c366: same boundary mapping for Input Monitoring (`im` on the wire).
  if (p.inputMonitoring !== undefined) wire.im = p.inputMonitoring;
  return wire;
}

/**
 * Redeem a pairing code for a permanent agent token.
 * deviceId (multi-Mac, 2026-09-24): this Mac's stable uuid — the backend
 * upserts on (userId, deviceId), so re-pairing rotates only this Mac's token
 * and the user's OTHER Macs keep their sessions untouched.
 * permissions (2f646c10): the TCC state at pair time, sent when computable —
 * a fresh pair usually lacks FDA, and the card should say so from second one.
 */
export async function pairComplete(
  apiBaseUrl: string,
  pairingCode: string,
  deviceName: string,
  deviceId?: string,
  permissions?: PermissionStatus | null,
): Promise<{ agentId: string; agentToken: string }> {
  const res = await fetch(`${apiBaseUrl}/crossmodel/imessage/pair/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairingCode, deviceName, agentVersion: AGENT_VERSION,
      ...(deviceId ? { deviceId } : {}),
      ...(permissions ? { permissions: pairPermissions(permissions) } : {}),
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    throw new Error(json?.error || `Pairing failed (HTTP ${res.status})`);
  }
  return json.data;
}

/** Long-poll for the next command (resolves with null if none within the window).
 *  permissions (ticket 2f646c10): when provided, the four TCC flags ride EVERY
 *  poll as ax/sr/fda/relaunch query params — the Account → Integrations card
 *  reads them live. Null (not computable) omits them; the backend then keeps
 *  the last stored state (never clobbers).
 *  update (ticket 4e75cdea): the response may carry an additive `update`
 *  block (the released agent version + artifact URL + sha256) when THIS agent
 *  is older than the release. Returned alongside the command so the run loop
 *  can act; pre-0.8.0 agents read only `command` and ignore the extra key. */
export interface PollResult {
  command: AgentCommand | null;
  update?: UpdateAdvert;
}

export async function pollCommand(
  config: AgentConfig,
  permissions?: PermissionStatus | null,
  regrant?: string | null,
  unattended?: string | null,
  remoteAccess?: string | null,
): Promise<PollResult> {
  const url =
    `${config.apiBaseUrl}/crossmodel/imessage/agent/poll?version=${encodeURIComponent(AGENT_VERSION)}` +
    permissionsQuery(permissions ?? null) +
    (regrant ? `&regrant=${encodeURIComponent(regrant)}` : '') +
    // "Unattended / Autonomous use" preset advert (2026-10-28): a comma list of
    // `on` + blocker tokens ('on,ok' / 'on,filevault'), never anything secret.
    // '' / null omits the param entirely — absent-never-clobbers on the
    // backend (a preset that is off advertises nothing at all).
    (unattended ? `&unattended=${encodeURIComponent(unattended)}` : '') +
    // BROKERED REMOTE ACCESS advert (ticket c468f922, owner ruling 2026-10-29):
    // `on,tunnel,<blockers>` from a CLOSED vocabulary. The dedicated VNC
    // credential NEVER rides this param — remoteAccessAdvertValue() emits only
    // vocabulary tokens, so a secret has nowhere to go (pinned by test).
    (remoteAccess ? `&remoteaccess=${encodeURIComponent(remoteAccess)}` : '');
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Agent-Token': config.agentToken },
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error(`poll failed (HTTP ${res.status})`);
  const json: any = await res.json().catch(() => ({}));
  const update = json?.update;
  return {
    command: json?.command ?? null,
    ...(update && typeof update === 'object' ? { update: update as UpdateAdvert } : {}),
  };
}

/**
 * ── RELAY DATA PLANE — the device's dial-OUT channel (ticket c468f922) ───────
 *
 * Independent review of the first cut (2026-11-02) found the backend had a relay
 * and NO CLIENT: the routes existed, the gates existed, and nothing ever dialled
 * them. "A relay forwarder + an agent-side dial-out channel" was the request;
 * only the forwarder had shipped. A data plane with no peer is the same
 * no-live-producer defect as D1, one layer out.
 *
 * These two calls are what make this Mac an actual peer:
 *   - `fetchRelayFrames` polls OUT for operator frames (screen/control in)
 *   - `postRelayFrame`    pushes OUT with this Mac's own frames (input back)
 *
 * Both are ordinary HTTPS requests this agent initiates, so the ruling's core
 * property holds: THERE IS NO INBOUND LISTENING PORT. The backend cannot reach
 * this Mac; the Mac reaches it. That is also why it works behind a home NAT.
 *
 * Auth is the SAME agent token every other agent call uses — the device does not
 * hold a session capability, and does not need one: it cannot NAME a session
 * (the backend resolves the session from this device's own grant), so there is
 * no session id here to steal. The operator's side is the one that needs the
 * session-scoped secret, because a human JWT outlives any one session.
 */

/** One frame as it travels over the relay. `seq` is assigned by the SERVER. */
export interface RelayFrame {
  seq: number;
  /** Opaque base64 payload — this agent never treats it as text. */
  payloadB64: string;
  sentAt: number;
  final?: boolean;
}

export interface RelayPollResult {
  frames: RelayFrame[];
  /** Echo the next request's `after` with this. Idempotent across processes. */
  cursor: number;
  more: boolean;
  sessionId?: string;
}

/**
 * Why a relay call was refused. Mirrors the backend's closed vocabulary so a
 * caller switches on a code, never on a message string.
 *
 * `not-open`/`stale`/`no-session` are the NORMAL steady state on a Mac that is
 * paired but not currently being brokered — they mean "stay quiet", not
 * "something is broken", and must never be logged as errors on every poll.
 */
export type RelayRefusalCode =
  | 'no-session'
  | 'not-open'
  | 'stale'
  | 'wrong-device'
  | 'wrong-capability'
  | 'frame-too-large'
  | 'malformed'
  | 'queue-full'
  | 'capability-in-url';

export type RelayPollOutcome =
  | { ok: true; data: RelayPollResult }
  | { ok: false; code: RelayRefusalCode };

export type RelayPushOutcome =
  | { ok: true; seq: number }
  | { ok: false; code: RelayRefusalCode };

/** Parse the backend's refusal body without trusting its shape. */
function relayRefusalFrom(body: any, status: number): RelayRefusalCode {
  const code = body && typeof body.code === 'string' ? body.code : '';
  const known: RelayRefusalCode[] = [
    'no-session',
    'not-open',
    'stale',
    'wrong-device',
    'wrong-capability',
    'frame-too-large',
    'malformed',
    'queue-full',
    'capability-in-url',
  ];
  if (known.includes(code as RelayRefusalCode)) return code as RelayRefusalCode;
  // An unrecognized refusal must not be mistaken for success or for "no
  // session" — surface it as malformed so it is visible, not silently a no-op.
  return status === 401 ? 'wrong-device' : 'malformed';
}

/**
 * Drain the frames the operator queued for this Mac.
 *
 * `after` is the caller's cursor; the returned `cursor` is what to pass next
 * time. A frame already delivered is never re-delivered (the backend filters by
 * sequence, not queue position), so a retried poll after a dropped response is
 * safe by construction.
 *
 * NOTE the capability is absent by design — see the block comment above. If a
 * future operator-style variant is added here, the capability goes in a HEADER
 * and never in this URL: a query string is written to access logs, proxies and
 * `Referer` before any application code runs.
 */
export async function fetchRelayFrames(
  config: AgentConfig,
  after: number,
  limit?: number,
): Promise<RelayPollOutcome> {
  const url =
    `${config.apiBaseUrl}/crossmodel/imessage/agent/relay/frames?after=${encodeURIComponent(String(after))}` +
    (limit ? `&limit=${encodeURIComponent(String(limit))}` : '');
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Agent-Token': config.agentToken },
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, code: relayRefusalFrom(body, res.status) };
  const data = body?.data;
  if (!data || !Array.isArray(data.frames)) return { ok: false, code: 'malformed' };
  return {
    ok: true,
    data: {
      frames: data.frames,
      cursor: typeof data.cursor === 'number' ? data.cursor : after,
      more: data.more === true,
      ...(typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : {}),
    },
  };
}

/**
 * Send ONE frame to the operator.
 *
 * The payload is base64 and opaque; this function does not inspect, decode or
 * log it. `final` marks the last frame of a burst so the peer can stop early.
 * Best-effort by contract — a refused frame is reported to the caller, never
 * thrown into the poll loop, because one bad frame must not tear down a session.
 */
export async function postRelayFrame(
  config: AgentConfig,
  payloadB64: string,
  final = false,
): Promise<RelayPushOutcome> {
  const res = await fetch(`${config.apiBaseUrl}/crossmodel/imessage/agent/relay/frames`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': config.agentToken },
    body: JSON.stringify({ payload: payloadB64, final }),
  }).catch(() => null);
  // A transport failure is reported as a refusal rather than thrown: the caller
  // decides whether to retry, and the session stays open either way.
  if (!res) return { ok: false, code: 'malformed' };
  const body: any = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, code: relayRefusalFrom(body, res.status) };
  const seq = body?.data?.seq;
  return { ok: true, seq: typeof seq === 'number' ? seq : 0 };
}

/**
 * Is this refusal just "nobody is brokering this Mac right now"?
 *
 * The distinction matters for logging volume: on a paired-but-idle Mac these
 * occur on EVERY relay poll, and treating them as errors would bury a real
 * failure in noise (the same "a token that cries wolf is a token lanes learn to
 * ignore" rule the `stale` blocker's tests pin).
 */
export function isIdleRelayRefusal(code: RelayRefusalCode): boolean {
  return code === 'no-session' || code === 'not-open' || code === 'stale';
}
export async function postResult(
  config: AgentConfig,
  cmdId: string,
  ok: boolean,
  result?: unknown,
  error?: string,
): Promise<void> {
  await fetch(`${config.apiBaseUrl}/crossmodel/imessage/agent/result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Agent-Token': config.agentToken },
    body: JSON.stringify({ cmdId, ok, result, error }),
  }).catch(() => {
    /* best-effort; the backend command will simply time out and the user retries */
  });
}
