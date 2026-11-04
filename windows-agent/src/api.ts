/**
 * HTTP client for the Digby backend — the SAME endpoints the macOS agent
 * speaks (roadmap §1: "the agent is a dumb executor; the intelligence is
 * server-side"). All calls are OUTBOUND from this PC, so it works behind any
 * home NAT/firewall with no inbound ports.
 *
 * W0 capability handshake: pair + poll carry the platform/capability
 * advertisement (advertisement.ts) so the backend's gates answer from it
 * instead of the legacy Mac version gates.
 */

import { AgentConfig } from './config';
import { AGENT_VERSION, pairAdvertisement, pollAdvertisementQuery } from './advertisement';

export interface AgentCommand {
  cmdId: string;
  method: string;
  params: Record<string, unknown>;
  /** The broker's version-gate wire field (agents ignore it; the broker
   *  enforces it). Present so the type matches the wire. */
  minAgentVersion?: string;
}

/**
 * Redeem a pairing code for a permanent agent token.
 * deviceId: this PC's stable uuid — the backend upserts on (userId, deviceId).
 */
export async function pairComplete(
  apiBaseUrl: string,
  pairingCode: string,
  deviceName: string,
  deviceId?: string,
): Promise<{ agentId: string; agentToken: string }> {
  const res = await fetch(`${apiBaseUrl}/crossmodel/imessage/pair/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairingCode,
      deviceName,
      agentVersion: AGENT_VERSION,
      ...(deviceId ? { deviceId } : {}),
      ...pairAdvertisement(),
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok || !json?.success) {
    throw new Error(json?.error || `Pairing failed (HTTP ${res.status})`);
  }
  return json.data;
}

/** Long-poll for the next command (resolves with null if none within the window). */
export async function pollCommand(
  config: AgentConfig,
  unattended?: string | null,
  remoteAccess?: string | null,
): Promise<AgentCommand | null> {
  // "Unattended / Autonomous use" preset advert (2026-10-28, owner request
  // oq_f7955582): `on` + the blocker tokens the detector found on this pass
  // ('on,ok' / 'on,bitlocker-pin') — a comma list, never anything secret.
  // '' / null omits the param: absent-never-clobbers on the backend.
  const extra = unattended ? `&unattended=${encodeURIComponent(unattended)}` : '';
  // BROKERED REMOTE ACCESS advert (ticket c468f922, owner ruling 2026-10-29):
  // `on,tunnel,<blockers>` from a CLOSED vocabulary. The brokered account's
  // secret NEVER rides this param — remoteAccessAdvertValue() emits only
  // vocabulary tokens, so a credential has nowhere to go (pinned by test).
  const extraRemote = remoteAccess ? `&remoteaccess=${encodeURIComponent(remoteAccess)}` : '';
  const url = `${config.apiBaseUrl}/crossmodel/imessage/agent/poll?${pollAdvertisementQuery()}${extra}${extraRemote}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { 'X-Agent-Token': config.agentToken },
  });
  if (res.status === 401) throw new Error('UNAUTHORIZED');
  if (!res.ok) throw new Error(`poll failed (HTTP ${res.status})`);
  const json: any = await res.json().catch(() => ({}));
  return json?.command ?? null;
}

/**
 * ── RELAY DATA PLANE — the PC's dial-OUT channel (ticket c468f922) ───────────
 *
 * Independent review of the first cut (2026-11-02) found the backend had a relay
 * and NO CLIENT. "A relay forwarder + an agent-side dial-out channel" was the
 * request; only the forwarder had shipped — the same no-live-producer defect as
 * D1, one layer out.
 *
 * Both calls below are ordinary HTTPS requests THIS process initiates, so the
 * ruling's core property holds on Windows exactly as on macOS: THERE IS NO
 * INBOUND LISTENING PORT, and the backend cannot connect to this PC (it works
 * behind a home NAT / corporate firewall).
 *
 * Auth is the SAME agent token every other agent call uses. The device does not
 * hold and does not need a session capability: it cannot NAME a session (the
 * backend resolves the session from this PC's own grant), so there is no
 * session id here to steal.
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
 * Why a relay call was refused — mirrors the backend's closed vocabulary so a
 * caller switches on a code, never on a message string.
 *
 * `no-session`/`not-open`/`stale` are the NORMAL steady state on a paired PC
 * nobody is brokering: they mean "stay quiet", not "something is broken".
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

const RELAY_REFUSAL_CODES: RelayRefusalCode[] = [
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

/** Parse the backend's refusal body without trusting its shape. */
function relayRefusalFrom(body: any, status: number): RelayRefusalCode {
  const code = body && typeof body.code === 'string' ? body.code : '';
  if (RELAY_REFUSAL_CODES.includes(code as RelayRefusalCode)) return code as RelayRefusalCode;
  // An unrecognized refusal must never be mistaken for success or for "no
  // session" — surface it as malformed so it is visible rather than a silent
  // no-op.
  return status === 401 ? 'wrong-device' : 'malformed';
}

/** Is this refusal just "nobody is brokering this PC right now"? */
export function isIdleRelayRefusal(code: RelayRefusalCode): boolean {
  return code === 'no-session' || code === 'not-open' || code === 'stale';
}

/**
 * Drain the frames the operator queued for this PC.
 *
 * `after` is the caller's cursor; the returned `cursor` is what to pass next
 * time. Already-delivered frames are never re-delivered (the backend filters by
 * sequence, not queue position), so a retried poll after a dropped response is
 * safe by construction.
 *
 * NOTE the capability is absent by design. If a future operator-style variant is
 * added here, the capability goes in a HEADER and never in this URL: a query
 * string reaches access logs, proxies and `Referer` before any application code
 * runs, which is the defect the review caught on the backend's own GET route.
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
 * Send ONE frame to the operator. The payload is base64 and opaque; this
 * function does not inspect, decode or log it. Best-effort by contract — a
 * refused frame is RETURNED, never thrown into the poll loop, because one bad
 * frame must not tear down a session or the command channel.
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
  if (!res) return { ok: false, code: 'malformed' };
  const body: any = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, code: relayRefusalFrom(body, res.status) };
  const seq = body?.data?.seq;
  return { ok: true, seq: typeof seq === 'number' ? seq : 0 };
}

/** Return a command's result to the backend. */
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
