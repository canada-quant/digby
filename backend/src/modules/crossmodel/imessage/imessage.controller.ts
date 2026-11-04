/**
 * iMessage Agent Controller
 *
 * Two audiences:
 *   • The web UI (JWT-authenticated user) — pairing, status, and read/send actions.
 *   • The macOS agent (X-Agent-Token authenticated) — long-poll + result transport.
 *
 * Read/send actions translate a user request into a command dispatched to the
 * paired Mac over the Redis-backed broker (the poll/result requests may land on
 * a different backend process than the dispatcher); the agent does the actual
 * chat.db read / AppleScript send and returns the result.
 *
 * Multi-Mac (owner 2026-09-24): a user may pair SEVERAL Macs. Read/send
 * routes through selectAgent (explicit ?device= target → default Mac →
 * most-recently-online), and every action reports WHICH Mac served it in
 * the response's `device` field. The /status payload keeps the legacy
 * aggregate fields (connected/online/deviceName — single-Mac clients see
 * zero change) and adds an `agents[]` list + `defaultAgentId`.
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import logger from '../../../utils/logger';
import { agentBroker } from './agent-link';
import {
  startPairing,
  completePairing,
  getPrimaryAgent,
  selectAgent,
  touchAgent,
  isOnline,
  listAgents,
  disconnectAgent,
  renameAgent,
  setDefaultAgent,
  deleteAgent,
  agentDisplayName,
  IMessageAgentRow,
} from './imessage.service';
import { normalizePlatform, normalizeCapabilities, normalizeAgentPermissions, permissionsFromBody, mergeAgentPermissions, resolvedCapabilities, platformNoun, agentPlatform, hasCapability, agentPermissions } from './agent-capabilities';
import { normalizeUnattended, unattendedReadyFor } from './unattended-verdict';
import { normalizeRemoteAccess, remoteAccessVerdict, remoteChannelFor } from './remote-access-verdict';
import { withBrokeredSessionWindow, createBrokeredSession, consumeStoredBrokeredSession, closeStoredBrokeredSession } from './brokered-session.store';
// RELAY DATA PLANE (ticket c468f922, owner ruling 2026-10-29/30) — the half
// that CARRIES a brokered session's bytes. The grant store authorizes; this
// module moves frames over the same outbound long-poll the agent already runs,
// so no new listening port exists on any device.
import {
  RELAY_CAPABILITY_BYTES,
  RELAY_CAPABILITY_HEADER,
  reasonForRelayRefusal,
  type RelayDirection,
  type RelayRefusal,
} from './relay-dataplane';
import {
  clearRelaySession,
  mintRelayCapability,
  pollRelayFrames,
  pushRelayFrame,
  relayDeviceGate,
  relayGate,
} from './relay-dataplane.store';
import { preloginInputFor, PRELOGIN_CREDENTIAL_POLICY } from './prelogin-capability';
import { normalizePreloginHelper, preloginHelperReadyFor } from './prelogin-helper';
import { agentUpdateAdvert, agentReleaseVersion } from './agent-release';
import {
  whichTccPermissionsRegressed,
  shouldPushTccRegression,
  tccRegressionPushText,
  versionTransitionCause,
  joinedKeySet,
  tccRegressionDedupeKey,
} from './agent-perm-regression';
import {
  parseRegrantParam,
  shouldPushReGrant,
  tccReGrantPushText,
  regrantEpisodeKey,
  regrantDedupeKey,
  regrantCoversRegression,
} from './agent-tcc-regrant';
import redisClient from '../../../config/redis';
// Local browser-driver availability (UI Phase 6a): the /status payload carries
// the SAME gate + human-readable line the browser router routes on, so the
// Connected-instances "Browser:" row can't drift from actual routing behavior.
import { localBrowserAvailable, localBrowserStatus, localBrowserStatusMulti } from '../browser-agent/router';
import { computerAgentStatus, computerUseAvailable } from '../computer-agent/availability';
import { visionConfigured } from '../computer-agent/vision-client';

const DISPATCH_TIMEOUT_MS = 20_000;

interface AgentRequest extends Request {
  // Full row shape from resolveAgentByToken / completePairing — permissions is
  // the stored JSON advertisement (read via agentPermissions()); only the
  // fields each handler dereferences are declared here. platform (4e75cdea):
  // the self-update advert never targets a Windows agent. label/agentVersion
  // (e2915963): the TCC-regression detector names the device and attributes
  // the version transition it just observed.
  agent?: {
    id: string;
    userId: string;
    deviceName: string | null;
    label?: string | null;
    agentVersion?: string | null;
    permissions?: unknown;
    platform?: string | null;
  };
}

/** Device-target query param: ?device=<label|deviceName|id> (optional). */
function deviceTarget(req: Request): string | undefined {
  const d = req.query.device;
  return typeof d === 'string' && d.trim() ? d.trim() : undefined;
}

/** Per-device capability block for /status + /agents payloads. */
async function devicePayload(agent: IMessageAgentRow, visionOk: boolean) {
  return {
    id: agent.id,
    label: agent.label,
    deviceId: agent.deviceId,
    deviceName: agent.deviceName,
    name: agentDisplayName(agent),
    isDefault: !!agent.isDefault,
    agentVersion: agent.agentVersion,
    platform: agentPlatform(agent),
    capabilities: resolvedCapabilities(agent),
    // Agent-advertised macOS TCC state (ticket 2f646c10) — null = a legacy
    // agent (pre-0.6.0) never advertised; the card shows the update hint.
    permissions: agent.permissions ?? null,
    online: isOnline(agent.lastSeenAt),
    lastSeenAt: agent.lastSeenAt,
    pairedAt: agent.pairedAt,
    localBrowser: { available: localBrowserAvailable(agent), status: localBrowserStatus(agent) },
    computerUse: {
      available: computerUseAvailable(agent) && visionOk,
      status: visionOk ? computerAgentStatus(agent) : 'unavailable — the Computer-use vision seat is not configured on this server (Account → Admin → Endpoints → Model roles)',
    },
    // UNATTENDED PRESET (2026-10-28): will this device still have a live
    // session, and if not the ONE setting to change. Ticket 11b6974f: the
    // verdict is TYPED (`state`) and its reason names the exact per-platform
    // command, so a lane can tell "the owner never enabled it" apart from
    // "this agent build never reported it".
    unattendedReady: unattendedReadyFor(agent),
    // PRE-LOGIN INPUT (ticket c468f922): can input be delivered while no user
    // session exists, and is the console at a lock screen RIGHT NOW.
    // `unavailable` in this build is the honest typed fact lanes fail fast on.
    prelogin: preloginInputFor(agent),
    // BROKERED REMOTE ACCESS (ticket c468f922, owner ruling 2026-10-29).
    // SEPARATE from `prelogin` deliberately: prelogin answers "can THIS run's
    // input land at a login window" (still no), this answers "does a hardened
    // OPERATOR channel exist". Presenting one as the other is the bug class
    // this ticket exists to end.
    //
    // THE SESSION WINDOW IS FOLDED IN HERE (owner ruling, the "strong
    // per-session auth" property). The harden contract already DECLARED a
    // session-window requirement and a `stale` blocker, but nothing produced
    // `stale` — so a channel authenticated by an operator session that walked
    // away still read ready. A stored overrun grant now flips this to
    // `blocked`; a device with no session is byte-identical to before (the
    // folder returns the advert unchanged and only ever ADDS a blocker).
    remoteAccess: remoteAccessVerdict(
      await withBrokeredSessionWindow(agent.id, normalizeRemoteAccess(agent.remoteAccess)),
    ),
    // PRE-LOGIN HELPER (ticket c468f922, option (d) of the owner's 2026-11-01
    // ruling on card oq_96b31bed): is a privileged helper installed AND loaded
    // in the system launchd domain on this device, so input can be posted at
    // the login window? `ready` is never true for a device that advertised
    // nothing, and never true while a blocker (credential custody above all)
    // is set. The password is still typed by a human — never stored.
    //
    // THE POLICY IS PASSED HERE, not left to the default: this is the surface
    // lanes actually read, so it must enforce the owner's ruling identically to
    // prelogin_input. Without it the two surfaces could disagree — a custody
    // flip would block the capability while this row still read ready:true.
    preloginHelper: preloginHelperReadyFor(agent, PRELOGIN_CREDENTIAL_POLICY),
  };
}

/**
 * The iMessage capability gate (W1 multi-device, 2026-09-25): iMessage runs on
 * the Mac agent — a Windows PC advertises ['browser','computer'] and NEVER
 * 'imessage', so without this gate a Windows-only fleet received list_chats /
 * send_message commands and errored on the unknown method. Legacy Mac rows
 * (no advertisement) pass the W0 version-gate fallback (imessage: always),
 * so an all-Mac fleet routes exactly as before.
 */
const IMESSAGE_GATE = {
  capable: (a: { platform?: string | null; capabilities?: readonly string[] | null; agentVersion?: string | null }) =>
    hasCapability(a, 'imessage'),
  reason: (a: { platform?: string | null }) =>
    a?.platform === 'windows' ? 'a Windows PC (no iMessage)' : 'iMessage not supported',
  surface: 'iMessage',
};

/**
 * Resolve the device this request targets and require it online, or send the
 * appropriate error response. `device` rides the response payload so callers
 * can report WHICH Mac served the action (routing transparency).
 */
async function requireOnlineAgent(
  req: Request,
  res: Response,
  device?: string | null,
): Promise<{ agent: IMessageAgentRow; device: string } | null> {
  const target = device && String(device).trim() ? String(device).trim() : deviceTarget(req);
  const selection = await selectAgent(req.user!.id, target, IMESSAGE_GATE);
  if (!selection.agent) {
    if (selection.error && selection.error.startsWith('No paired Mac matches')) {
      res.status(404).json({ success: false, error: selection.error, code: 'UNKNOWN_DEVICE' });
      return null;
    }
    // Capability failure (W1): devices are ONLINE but none can send iMessage —
    // a Windows-only fleet. That is permanent for the surface, not a transient
    // offline condition, so it maps to 404 NO_AGENT with the GATE's own error
    // (e.g. "No paired Mac can serve iMessage right now ('DESKTOP-XY': a
    // Windows PC (no iMessage))…") instead of the Mac pairing guidance. Covers
    // both shapes: no-capable-device (note 'no capable Mac') and an explicitly
    // targeted device that lacks iMessage (note "device 'X' cannot serve").
    if (selection.note === 'no capable Mac' || selection.note.includes('cannot serve')) {
      res.status(404).json({ success: false, error: selection.error || 'No paired device can send iMessage. iMessage runs on the Mac agent.', code: 'NO_AGENT' });
      return null;
    }
    if (!selection.error || selection.error.startsWith('No Mac is connected')) {
      // Zero paired devices at all → the canonical pairing guidance (pinned by
      // multi-mac.test.ts: "No Mac is connected" when there are no rows).
      res.status(404).json({ success: false, error: 'No Mac is connected. Pair your Mac first.', code: 'NO_AGENT' });
      return null;
    }
    res.status(503).json({ success: false, error: selection.error, code: 'AGENT_OFFLINE' });
    return null;
  }
  return { agent: selection.agent, device: agentDisplayName(selection.agent) };
}

export class IMessageController {
  // ── Web UI: pairing ──────────────────────────────────────────────────────────

  /** POST /imessage/pair/start — issue a pairing code for the logged-in user. */
  async startPair(req: Request, res: Response, next: NextFunction) {
    try {
      const { pairingCode, expiresInSec } = await startPairing(req.user!.id);
      res.json({ success: true, data: { pairingCode, expiresInSec } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /imessage/pair/complete — agent redeems a pairing code for a token.
   * No JWT (the agent has none); validated by the single-use code.
   * Body: { pairingCode, deviceName?, agentVersion?, deviceId?, platform?, capabilities? }
   * (deviceId = stable agent-generated uuid, multi-Mac: upserts that Mac's row;
   *  platform/capabilities = the W0 capability handshake — a Windows agent
   *  advertises platform:'windows', capabilities:['browser','computer'].)
   */
  async completePair(req: Request, res: Response, next: NextFunction) {
    try {
      const { pairingCode, deviceName, agentVersion, deviceId, platform, capabilities } = req.body || {};
      if (!pairingCode || typeof pairingCode !== 'string') {
        return res.status(400).json({ success: false, error: 'pairingCode is required' });
      }
      if (deviceId !== undefined && (typeof deviceId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(deviceId))) {
        return res.status(400).json({ success: false, error: 'deviceId must be 8-64 chars of [A-Za-z0-9-]' });
      }
      // Capability handshake (W0): normalize + persist only KNOWN values — an
      // agent can never inject arbitrary capability tokens into the registry.
      const advertPlatform = normalizePlatform(platform);
      const advertCaps = normalizeCapabilities(capabilities);
      // TCC permission advertisement (ticket 2f646c10): the pair body carries
      // { ax, sr, fda, relaunch } as booleans (the object form; the poll uses
      // four flat query params). Absent/garbage → undefined → never clobbers.
      const advertPerms = permissionsFromBody((req.body || {}).permissions);
      // Unattended preset advert (2026-10-28): normally arrives on the poll, so
      // a pair body that omits it advertises nothing (absent-never-clobbers).
      const advertUnattended = normalizeUnattended((req.body || {}).unattended);
      // Brokered remote access (ticket c468f922, owner ruling 2026-10-29): same
      // absent-never-clobbers contract — a pair body that omits it advertises
      // nothing and leaves any stored verdict untouched.
      const advertRemoteAccess = normalizeRemoteAccess((req.body || {}).remoteAccess);
      // PRE-LOGIN HELPER advert (ticket c468f922, option (d) of the owner's
      // 2026-11-01 ruling): same absent-never-clobbers contract. CAPABILITY
      // ONLY — normalizePreloginHelper() carries installed/loaded/blockers from
      // a CLOSED vocabulary, so a credential has no field to ride in on.
      const advertPreloginHelper = normalizePreloginHelper((req.body || {}).preloginHelper);
      let result;
      try {
        result = await completePairing(pairingCode, deviceName, agentVersion, deviceId, {
          ...(advertPlatform ? { platform: advertPlatform } : {}),
          ...(advertCaps ? { capabilities: advertCaps } : {}),
          ...(advertPerms ? { permissions: advertPerms } : {}),
          ...(advertUnattended ? { unattended: advertUnattended } : {}),
          ...(advertRemoteAccess ? { remoteAccess: advertRemoteAccess } : {}),
          ...(advertPreloginHelper ? { preloginHelper: advertPreloginHelper } : {}),
        });
      } catch (e: any) {
        return res.status(400).json({ success: false, error: e?.message || 'Pairing failed' });
      }
      if (!result) {
        return res.status(400).json({ success: false, error: 'Invalid or expired pairing code' });
      }
      // Self-update advert (ticket 4e75cdea): a freshly-paired agent that is
      // already behind the release learns it on its FIRST poll anyway; carrying
      // it at registration too just makes the very first cycle the one that
      // upgrades. Additive — pre-0.8.0 agents read only agentId/agentToken.
      const update = agentUpdateAdvert(typeof agentVersion === 'string' ? agentVersion : undefined, advertPlatform);
      res.json({ success: true, data: { ...result, ...(update ? { update } : {}) } });
    } catch (error) {
      next(error);
    }
  }

  // ── Web UI: status / management ────────────────────────────────────────────────

  /** GET /imessage/status — connection + online state for the UI. */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await listAgents(req.user!.id);
      // Computer-use vision is a SEAT now (2026-09-22): its availability is an
      // async resolver read (model role override + provider key), fail-open.
      const visionOk = await visionConfigured();
      const agents = await Promise.all(rows.map((r) => devicePayload(r, visionOk)));

      if (rows.length === 0) {
        return res.json({
          success: true,
          data: {
            connected: false,
            online: false,
            agents: [],
            defaultAgentId: null,
            // Ticket 31fd8440: the current released agent, so the UI can always
            // say what the latest is — even before any Mac is paired.
            latestAgentVersion: agentReleaseVersion(),
            // Additive (UI Phase 6a): browser-driver availability for status
            // surfaces — no paired Mac ⇒ the agent browser is cloud read-only.
            localBrowser: { available: false, status: localBrowserStatus(null) },
            computerUse: { available: false, status: computerAgentStatus(null) },
          },
        });
      }

      // Legacy aggregate fields (single-Mac backward compat): the DEFAULT Mac
      // is "the" Mac for old clients — exactly the row selectAgent routes to.
      const primary = await getPrimaryAgent(req.user!.id);
      const primaryOnline = isOnline(primary?.lastSeenAt);
      res.json({
        success: true,
        data: {
          connected: true,
          online: primaryOnline,
          deviceName: primary?.deviceName,
          agentVersion: primary?.agentVersion,
          lastSeenAt: primary?.lastSeenAt,
          pairedAt: primary?.pairedAt,
          // Ticket 31fd8440: the current released agent version, so the card
          // can say "agent vX — update available (latest vY)" instead of the
          // user having to guess from a re-download. Additive — old clients
          // ignore the unknown field.
          latestAgentVersion: agentReleaseVersion(),
          // Additive (UI Phase 6a): the browser router's OWN availability gate
          // + human-readable line (online AND app ≥ 0.2.0) — what the local
          // browser driver would actually do right now. Multi-Mac: ANY capable
          // Mac makes the surface available (steer 2026-09-24 — "too old"
          // excludes only that Mac); single-Mac output is unchanged
          // (localBrowserStatusMulti([one]) === localBrowserStatus(one)).
          localBrowser: {
            available: rows.some((a) => localBrowserAvailable(a)),
            status: localBrowserStatusMulti(rows),
          },
          // Computer use (2026-09-09): the computer-agent's OWN gate (online AND
          // app ≥ 0.3.0 AND vision configured server-side) + status line — can
          // Digby see and drive this user's actual screen right now?
          computerUse: {
            available: !!(primary && computerUseAvailable(primary) && visionOk),
            status: primary && visionOk ? computerAgentStatus(primary) : 'unavailable — the Computer-use vision seat is not configured on this server (Account → Admin → Endpoints → Model roles)',
          },
          // Multi-Mac (2026-09-24): the full device list + routing target.
          agents,
          defaultAgentId: (rows.find((r) => r.isDefault) ?? rows[0]).id,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /imessage/agents — list all paired Macs (multi-Mac management). */
  async listAgents(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await listAgents(req.user!.id);
      const visionOk = await visionConfigured();
      res.json({
        success: true,
        data: await Promise.all(rows.map((r) => devicePayload(r, visionOk))),
      });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /imessage/agents/:id — unpair ONE Mac (scoped to the caller). */
  async deleteAgent(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      const ok = await deleteAgent(req.user!.id, id);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      res.json({ success: true, message: 'Mac disconnected' });
    } catch (error) {
      next(error);
    }
  }

  /** PATCH /imessage/agents/:id — rename a Mac (body: { label }). */
  async renameAgent(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      const label = String((req.body || {}).label || '');
      if (!label.trim()) {
        return res.status(400).json({ success: false, error: 'label is required (1-60 chars)' });
      }
      const row = await renameAgent(req.user!.id, id, label);
      if (!row) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      res.json({ success: true, data: { id: row.id, label: row.label } });
    } catch (error) {
      next(error);
    }
  }

  /** POST /imessage/agents/:id/default — make a Mac the default routing target. */
  async setDefaultAgent(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      const row = await setDefaultAgent(req.user!.id, id);
      if (!row) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      res.json({ success: true, data: { id: row.id, isDefault: true } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /imessage/agents/:id/permission-action — the permission-onboarding
   * buttons (ticket 2f646c10, agent ≥ 0.6.0). Body: { action, pane? } where
   * action ∈ 'relaunch' | 'open-pane' | 'reveal' and, for 'open-pane', pane ∈
   * 'accessibility' | 'screen-recording' | 'full-disk-access'. The row is
   * resolved scoped to the caller (same contract as rename/set-default) and the
   * action is dispatched to the agent over the broker.
   */
  async permissionAction(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      const action = String((req.body || {}).action || '');
      const pane = String((req.body || {}).pane || '');
      const VALID_ACTIONS: readonly string[] = ['relaunch', 'open-pane', 'reveal'];
      // 30d3c366: 'input-monitoring' (Privacy_ListenEvent) and 'automation'
      // (Privacy_Automation) join — the two panes the owner actually had to
      // find by hand. The agent's PANE_URLS is the source of truth for the
      // deep links; this list is the validation gate, kept in step.
      const VALID_PANES: readonly string[] = ['accessibility', 'screen-recording', 'full-disk-access', 'calendars', 'input-monitoring', 'automation'];
      if (!VALID_ACTIONS.includes(action)) {
        return res.status(400).json({ success: false, error: `action must be one of ${VALID_ACTIONS.join(', ')}` });
      }
      if (action === 'open-pane' && !VALID_PANES.includes(pane)) {
        return res.status(400).json({ success: false, error: `pane must be one of ${VALID_PANES.join(', ')}` });
      }
      const rows = await listAgents(req.user!.id);
      const agent = rows.find((r) => r.id === id);
      if (!agent) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      const method = action === 'relaunch' ? 'permission_relaunch' : action === 'open-pane' ? 'permission_open_pane' : 'permission_reveal';
      const params: Record<string, unknown> = action === 'open-pane' ? { pane } : {};
      try {
        const data = await agentBroker.dispatch(agent.id, method, params, DISPATCH_TIMEOUT_MS);
        res.json({ success: true, data, device: agentDisplayName(agent) });
      } catch (error: any) {
        // permission_relaunch makes the helper exit (launchd's KeepAlive
        // restarts it from the CURRENT bundle, re-evaluating TCC). The helper
        // posts its result BEFORE exiting so the dispatch normally resolves —
        // but if it is already gone (ghost bundle self-exit) or a pre-0.6.0
        // helper answered "unknown method", the relaunch intent has still been
        // served: the helper is either restarting or never understood the
        // command. Report success with the reason instead of a scary 504.
        if (action === 'relaunch') {
          return res.json({
            success: true,
            data: {
              relaunching: true,
              note: `helper did not confirm (${error?.message || 'no response'}) — it may have exited mid-relaunch; launchd restarts it within ~10s`,
            },
            device: agentDisplayName(agent),
          });
        }
        res.status(504).json({ success: false, error: error.message, device: agentDisplayName(agent) });
      }
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /imessage/agents/:id/brokered-session — OPEN a time-boxed operator
   * session on one paired device (ticket c468f922, owner ruling 2026-10-29:
   * "can we do option three but a little more secure like how it's just like
   * TeamViewer" — the "strong per-session auth" property).
   *
   * THIS IS THE PRODUCER'S OTHER HALF. `brokered-session.store.ts` shipped with
   * a reader (`withBrokeredSessionWindow`) but nothing that could WRITE a grant,
   * so the `stale` blocker it surfaces was unreachable in production: the Redis
   * key it reads was never written by any route, controller or agent verb.
   * Review caught it (2026-11-02) and this endpoint is the fix.
   *
   * GATED ON THE VERDICT, NOT ON A FLAG: `createBrokeredSession` refuses unless
   * remoteAccess is `ready` (enabled + tunnel-bound + zero blockers), so a
   * session can never be minted onto an exposed or half-configured channel.
   * The 409 carries the leaf's own refusal code so the UI can act on it.
   *
   * The response deliberately has no field a credential could occupy, and the
   * grant is bound to THIS device id — a grant for one Mac cannot drive another.
   */
  async openBrokeredSession(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      // Ownership-scoped exactly like rename/set-default/delete: resolving
      // through the caller's own device list means another user's agent id is
      // indistinguishable from a nonexistent one.
      const agents = await listAgents(req.user!.id);
      const agent = agents.find((a) => a.id === id);
      if (!agent) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      const verdict = remoteAccessVerdict(
        await withBrokeredSessionWindow(agent.id, normalizeRemoteAccess((agent as any).remoteAccess)),
      );
      const windowSec = Number((req.body || {}).windowSec);
      const issued = await createBrokeredSession(
        {
          sessionId: String((req.body || {}).sessionId || randomUUID()),
          agentId: agent.id,
          channel: remoteChannelFor(agentPlatform(agent)),
          ...(Number.isFinite(windowSec) && windowSec > 0 ? { windowSec } : {}),
        },
        verdict,
      );
      if (!issued.ok) {
        return res.status(409).json({ success: false, error: issued.reason, code: issued.refusal });
      }

      // ── THE SESSION CAPABILITY (the ruling's "strong per-session auth") ─────
      // 32 bytes of CSPRNG output, handed to the operator EXACTLY ONCE and
      // stored only as a SHA-256 hash by `mintRelayCapability`. This is what
      // makes a stolen `sessionId` useless on its own: the id NAMES the
      // session, the capability PROVES the caller was given it. Same
      // show-once contract `completePairing` uses for the agent token — and
      // deliberately NOT a field on the grant, so the grant stays credential-
      // free (its own key-set test pins that).
      const capability = randomBytes(RELAY_CAPABILITY_BYTES).toString('hex');
      const minted = await mintRelayCapability(issued.grant.sessionId, capability);
      if (!minted) {
        // A session whose capability could not be recorded can never carry a
        // frame, so reporting success would be a session the operator can only
        // discover is dead at its first use. Refuse and let them re-mint.
        await clearRelaySession(issued.grant.sessionId);
        return res.status(503).json({
          success: false,
          error: 'the relay could not record this session capability — the session would be unable to carry any frames; retry once the broker store recovers',
          code: 'relay-unavailable',
        });
      }

      res.json({
        success: true,
        data: {
          sessionId: issued.grant.sessionId,
          device: agentDisplayName(agent),
          expiresInSec: issued.expiresInSec,
          expiresAt: new Date(issued.grant.expiresAt).toISOString(),
          // SHOWN ONCE. Never logged, never persisted in the clear.
          capability,
          capabilityNote:
            'store this capability now — it is shown once and never again; every relay frame you send or receive must present it',
          // Never a credential: the grant is an authorization, not a secret.
          note: 'a brokered session is time-boxed, single-use and bound to this device; close it when done so the fleet does not report it stale',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /imessage/agents/:id/brokered-session/use — CONSUME the device's grant
   * exactly once. Atomic across processes (`SET NX`), so a replayed
   * authorization cannot open a second session anywhere in the fleet.
   */
  async useBrokeredSession(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      const agents = await listAgents(req.user!.id);
      const agent = agents.find((a) => a.id === id);
      if (!agent) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      const sessionId = String((req.body || {}).sessionId || '');
      if (!sessionId) {
        return res.status(400).json({ success: false, error: 'sessionId is required' });
      }
      const out = await consumeStoredBrokeredSession({
        sessionId,
        agentId: agent.id,
        channel: remoteChannelFor(agentPlatform(agent)),
      });
      if (!out.ok) {
        return res.status(409).json({ success: false, error: out.reason, code: out.refusal });
      }
      res.json({
        success: true,
        data: { sessionId: out.grant.sessionId, consumedAt: new Date(out.grant.consumedAt!).toISOString() },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /imessage/agents/:id/brokered-session — CLOSE the session.
   *
   * The control that keeps `stale` meaningful: a host that closes its sessions
   * reads clean forever, and one that never does is exactly what the fleet
   * should see. Without this endpoint every session would eventually report
   * `stale`, which would make the token noise instead of a finding.
   */
  async closeBrokeredSession(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      const agents = await listAgents(req.user!.id);
      const agent = agents.find((a) => a.id === id);
      if (!agent) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      const closed = await closeStoredBrokeredSession(agent.id);
      if (!closed) {
        return res.status(404).json({ success: false, error: 'No brokered session to close' });
      }
      // Drop the session's transport state with the grant. Without this a
      // closed session would leave its last frames readable and its capability
      // hash live until TTL — and "closed" would stop meaning "no longer can
      // carry anything", which is the only thing the operator is told.
      await clearRelaySession(closed.sessionId);
      res.json({
        success: true,
        data: { sessionId: closed.sessionId, closedAt: new Date(closed.closedAt!).toISOString() },
      });
    } catch (error) {
      next(error);
    }
  }

  // ── RELAY DATA PLANE (ticket c468f922, owner ruling 2026-10-29/30) ───────────
  //
  // The grant verbs above AUTHORIZE a session; these four CARRY it. Every one
  // of them is a plain HTTPS request the caller initiates — the device polls
  // OUT (`GET /agent/relay/frames`) and the operator polls OUT, so NO device
  // ever opens an inbound port and the server never dials out to a Mac. That
  // is the ruling's "option three, more secure, like TeamViewer" property, and
  // it is why this needs no new listener, no ws upgrade and no TLS change.
  //
  // Directions are named from the OPERATOR's point of view: `to-device` is
  // screen/control going to the Mac, `to-operator` is input/screen coming back.
  // The two directions have separate queues AND separate sequence counters, so
  // a busy stream on one side can never consume the other side's cursor.

  /**
   * POST /imessage/agents/:id/relay/frames — OPERATOR sends one frame to the
   * device. Requires the session capability minted when the session was opened;
   * a `sessionId` alone is never enough.
   */
  async postRelayFrame(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      const agents = await listAgents(req.user!.id);
      const agent = agents.find((a) => a.id === id);
      if (!agent) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      const body = (req.body || {}) as Record<string, unknown>;
      const direction: RelayDirection = body.direction === 'to-operator' ? 'to-operator' : 'to-device';
      const refusal = await relayGate({
        agentId: agent.id,
        sessionId: String(body.sessionId || ''),
        channel: remoteChannelFor(agentPlatform(agent)),
        capability: String(body.capability || ''),
      });
      if (refusal) {
        return res.status(relayStatusFor(refusal)).json({
          success: false,
          error: reasonForRelayRefusal(refusal),
          code: refusal,
        });
      }
      const out = await pushRelayFrame({
        sessionId: String(body.sessionId),
        direction,
        payloadB64: String(body.payload || ''),
        final: body.final === true,
      });
      if (!out.ok) {
        return res.status(relayStatusFor(out.refusal)).json({
          success: false,
          error: reasonForRelayRefusal(out.refusal),
          code: out.refusal,
        });
      }
      res.json({ success: true, data: { seq: out.frame.seq, sentAt: out.frame.sentAt, depth: out.depth } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /imessage/agents/:id/relay/frames — OPERATOR drains frames the device
   * queued (`direction=to-operator`, the default for a read).
   *
   * A long-poll by construction, same as the agent's: the caller re-requests
   * with its returned cursor. `cursor` is echoed on every response — including
   * an empty one — so a client never has to infer where it is.
   */
  async getRelayFrames(req: Request, res: Response, next: NextFunction) {
    try {
      const id = String(req.params.id || '');
      const agents = await listAgents(req.user!.id);
      const agent = agents.find((a) => a.id === id);
      if (!agent) {
        return res.status(404).json({ success: false, error: 'No such paired Mac' });
      }
      // A credential in a URL is already in an access log by the time this line
      // runs (independent review, 2026-11-02). Refuse loudly: silently ignoring
      // it would leave the secret logged while the caller debugged elsewhere.
      if (req.query.capability !== undefined) {
        return res.status(400).json({
          success: false,
          error: reasonForRelayRefusal('capability-in-url'),
          code: 'capability-in-url',
        });
      }
      const direction: RelayDirection = req.query.direction === 'to-device' ? 'to-device' : 'to-operator';
      const refusal = await relayGate({
        agentId: agent.id,
        sessionId: String(req.query.sessionId || ''),
        channel: remoteChannelFor(agentPlatform(agent)),
        // HEADER ONLY — see RELAY_CAPABILITY_HEADER.
        capability: String(req.headers[RELAY_CAPABILITY_HEADER] || ''),
      });
      if (refusal) {
        return res.status(relayStatusFor(refusal)).json({
          success: false,
          error: reasonForRelayRefusal(refusal),
          code: refusal,
        });
      }
      const out = await pollRelayFrames({
        sessionId: String(req.query.sessionId),
        direction,
        after: req.query.after,
        limit: req.query.limit,
      });
      res.json({ success: true, data: out });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /agent/relay/frames — DEVICE sends one frame to the operator.
   *
   * Authenticated by the AGENT token (`authenticateAgent`), not a capability:
   * the device cannot name a session, so it is answered for the session minted
   * for it. See `relayDeviceGate` for why that is a distinct protection and
   * not a weakening.
   */
  async agentPostRelayFrame(req: AgentRequest, res: Response, next: NextFunction) {
    try {
      const agent = req.agent!;
      const body = (req.body || {}) as Record<string, unknown>;
      const gate = await relayDeviceGate({
        agentId: agent.id,
        channel: remoteChannelFor(agentPlatform(agent)),
      });
      if ('refusal' in gate) {
        return res.status(relayStatusFor(gate.refusal)).json({
          success: false,
          error: reasonForRelayRefusal(gate.refusal),
          code: gate.refusal,
        });
      }
      const direction: RelayDirection = body.direction === 'to-device' ? 'to-device' : 'to-operator';
      const out = await pushRelayFrame({
        sessionId: gate.sessionId,
        direction,
        payloadB64: String(body.payload || ''),
        final: body.final === true,
      });
      if (!out.ok) {
        return res.status(relayStatusFor(out.refusal)).json({
          success: false,
          error: reasonForRelayRefusal(out.refusal),
          code: out.refusal,
        });
      }
      res.json({ success: true, data: { seq: out.frame.seq, sentAt: out.frame.sentAt, depth: out.depth } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /agent/relay/frames — DEVICE drains the frames the operator queued.
   *
   * This is the device's dial-OUT: the Mac makes this request and holds it, the
   * server never connects to the Mac. `sessionId` is echoed so an agent that
   * lost its own state learns which session it is serving.
   */
  async agentGetRelayFrames(req: AgentRequest, res: Response, next: NextFunction) {
    try {
      const agent = req.agent!;
      const gate = await relayDeviceGate({
        agentId: agent.id,
        channel: remoteChannelFor(agentPlatform(agent)),
      });
      if ('refusal' in gate) {
        return res.status(relayStatusFor(gate.refusal)).json({
          success: false,
          error: reasonForRelayRefusal(gate.refusal),
          code: gate.refusal,
        });
      }
      const out = await pollRelayFrames({
        sessionId: gate.sessionId,
        direction: 'to-device',
        after: req.query.after,
        limit: req.query.limit,
      });
      res.json({ success: true, data: { ...out, sessionId: gate.sessionId } });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /imessage/disconnect — revoke paired Mac(s) (?label= optional, legacy). */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const label = typeof req.query.label === 'string' ? req.query.label : undefined;
      const count = await disconnectAgent(req.user!.id, label);
      res.json({ success: true, message: count > 0 ? 'Disconnected' : 'Nothing to disconnect' });
    } catch (error) {
      next(error);
    }
  }

  // ── Web UI: iMessage read / send (dispatched to the Mac) ───────────────────────

  /** GET /imessage/chats?limit=&device= — recent conversations. */
  async getChats(req: Request, res: Response) {
    const picked = await requireOnlineAgent(req, res);
    if (!picked) return;
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    try {
      const data = await agentBroker.dispatch(picked.agent.id, 'list_chats', { limit }, DISPATCH_TIMEOUT_MS, { capability: 'imessage' });
      res.json({ success: true, data, device: picked.device });
    } catch (error: any) {
      res.status(504).json({ success: false, error: error.message, device: picked.device });
    }
  }

  /** GET /imessage/messages?chat=&limit=&device= — messages in one conversation. */
  async getMessages(req: Request, res: Response) {
    const picked = await requireOnlineAgent(req, res);
    if (!picked) return;
    const chat = typeof req.query.chat === 'string' ? req.query.chat : '';
    if (!chat) {
      res.status(400).json({ success: false, error: 'chat (id or handle) is required' });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
    try {
      const data = await agentBroker.dispatch(picked.agent.id, 'get_messages', { chat, limit }, DISPATCH_TIMEOUT_MS, { capability: 'imessage' });
      res.json({ success: true, data, device: picked.device });
    } catch (error: any) {
      res.status(504).json({ success: false, error: error.message, device: picked.device });
    }
  }

  /**
   * POST /imessage/send — send an iMessage. Body: { to, text, device?, decisionId? }.
   * `decisionId` (E5, 2026-09-25) is the confirm card's parked imessage_send
   * decision: tapping Send labels it CONFIRMED (actual:true) before the
   * dispatch — the user's intent is the label, not the dispatch's fate.
   * Telemetry only; a missing / expired id changes nothing about the send.
   */
  async send(req: Request, res: Response) {
    const { to, text, device, decisionId } = req.body || {};
    // Body `device` wins (the UI sends it there); fall back to ?device= for
    // query-string callers. REVIEW B1: without this the send silently went to
    // the DEFAULT Mac while the UI attributed it to the selected one.
    const picked = await requireOnlineAgent(req, res, typeof device === 'string' ? device : undefined);
    if (!picked) return;
    if (!to || !text || typeof to !== 'string' || typeof text !== 'string') {
      res.status(400).json({ success: false, error: '"to" (phone/email) and "text" are required' });
      return;
    }
    if (typeof decisionId === 'string' && decisionId) {
      void import('./send-draft-outcome')
        .then((m) => m.recordSendDraftOutcome(req.user!.id, decisionId, 'confirmed'))
        .catch(() => false);
    }
    try {
      const data = await agentBroker.dispatch(picked.agent.id, 'send_message', { to, text }, DISPATCH_TIMEOUT_MS, { capability: 'imessage' });
      logger.info(`iMessage send dispatched userId=${req.user!.id} to=${to.substring(0, 6)}… device=${picked.device}`);
      res.json({ success: true, data, device: picked.device });
    } catch (error: any) {
      res.status(504).json({ success: false, error: error.message, device: picked.device });
    }
  }

  /**
   * POST /imessage/draft-outcome — the confirm card was DISMISSED without a
   * send (E5, 2026-09-25). Body: { decisionId, outcome: 'declined' }. Labels the
   * parked imessage_send decision actual:false. Idempotent and fail-open:
   * an unknown / expired / already-labelled id answers `recorded:false`.
   */
  async draftOutcome(req: Request, res: Response) {
    const { decisionId, outcome } = req.body || {};
    if (typeof decisionId !== 'string' || !decisionId || outcome !== 'declined') {
      res.status(400).json({ success: false, error: '"decisionId" and outcome "declined" are required' });
      return;
    }
    let recorded = false;
    try {
      const { recordSendDraftOutcome } = await import('./send-draft-outcome');
      recorded = await recordSendDraftOutcome(req.user!.id, decisionId, 'declined');
    } catch { recorded = false; }
    res.json({ success: true, data: { recorded } });
  }

  // ── Agent transport (X-Agent-Token authenticated) ─────────────────────────────

  /** GET /imessage/agent/poll — long-poll for the next command (or null). */
  async agentPoll(req: AgentRequest, res: Response) {
    const agent = req.agent!;
    const version = typeof req.query.version === 'string' ? req.query.version : undefined;
    // W0 capability handshake: the poll refreshes the platform/capability
    // advertisement (an agent that upgrades self-heals on its next poll).
    const advertPlatform = normalizePlatform(req.query.platform);
    const advertCaps = normalizeCapabilities(req.query.capabilities);
    // TCC permission advertisement (ticket 2f646c10): the agent sends the four
    // flags as flat query params ('1'/'0', numbers accepted) on EVERY poll —
    // all four valid or the stored value is left untouched.
    const advertPerms = normalizeAgentPermissions(req.query);
    // Per-key merge (ticket 1ea9a120): a cal-less advert (pre-0.7.0 agent) must
    // never clobber a stored cal:true — `agent` is the FULL row from
    // resolveAgentByToken, so the stored advertisement is in hand here.
    const mergedPerms = mergeAgentPermissions(agentPermissions(agent), advertPerms);

    // ── "Unattended / Autonomous use" preset advert (2026-10-28) ────────────
    // The agent re-reads every setting the preset owns on EVERY poll (that is
    // the drift detector: a macOS/Windows update silently resets auto-login)
    // and sends `?unattended=on,<blockers>` — a closed token vocabulary.
    // normalizeUnattended drops unknown tokens (a newer agent must never break
    // the poll, and must never read as a false "ready"), and returns undefined
    // for an ABSENT param so a legacy agent never clobbers a stored verdict.
    const advertUnattended = normalizeUnattended(req.query.unattended);

    // ── BROKERED REMOTE ACCESS advert (ticket c468f922, owner ruling 2026-10-29) ──
    // The agent re-probes the OS channel on EVERY poll (drift detector: a macOS
    // update resets ALLOW_SCREENSHARING, a policy reset re-enables RDP without
    // NLA) and sends `?remoteaccess=on,tunnel,<blockers>`. normalizeRemoteAccess
    // drops unknown tokens so a newer agent never breaks the poll and never
    // reads as a false "ready", and returns undefined for an ABSENT param so a
    // legacy agent never clobbers a stored verdict. NO SECRET can ride this
    // param: the vocabulary is closed and the credential never leaves the
    // device (see remote-access-verdict.ts).
    const advertRemoteAccess = normalizeRemoteAccess(req.query.remoteaccess);

    // ── PRE-LOGIN HELPER advert (ticket c468f922, the (d) capability) ──────
    // The agent re-probes on EVERY poll whether the privileged helper is
    // installed AND bootstrapped into the system launchd domain — a plist on
    // disk that launchd never loaded is inert, so "installed" alone would be a
    // false green. normalizePreloginHelper drops unknown tokens (a newer agent
    // never breaks the poll, never reads as a false "ready") and returns
    // undefined for an ABSENT param so a legacy agent never clobbers a stored
    // verdict. NO SECRET can ride this param: the vocabulary is closed, and
    // option (d) never creates a credential to carry (owner ruling on
    // oq_96b31bed rejected the helper-holds-the-password option (a)).
    const advertPreloginHelper = normalizePreloginHelper(req.query.preloginhelper);

    // TCC permission-REGRESSION detection (ticket e2915963, 2026-10-24):
    // the agent's self-update / runtime heal swaps its runtime binary, which
    // silently orphans the Accessibility / Screen Recording / Full Disk
    // Access grants macOS attaches to the exact file. The stored advertisement
    // (pre-update) is in hand HERE — the only seam that can see the
    // before→after flip. A stored-true key flipping false on this poll pushes
    // the owner ONCE (deduped per regression episode) instead of the
    // regression being discovered at task time with "Missing macOS
    // permission(s): Accessibility", steps 0. Fire-and-forget: the poll path
    // must never depend on Redis/Telegram availability.
    // ── c44b19e9: parse the re-grant episode param FIRST (the covered-guard
    // below needs it — a regression set the open consolidated episode already
    // covers is suppressed: ONE incident, ONE message). An ABSENT param is
    // null (no episode open).
    const regrantGrants = parseRegrantParam(req.query.regrant);
    if (mergedPerms) {
      const regressed = whichTccPermissionsRegressed(agentPermissions(agent), mergedPerms);
      if (regressed.length > 0) {
        const key = tccRegressionDedupeKey(agent.id);
        const pushedKeySet = (await (redisClient as any).get(key).catch(() => null)) as string | null;
        // T1 (follow-up review): a regression the consolidated re-grant
        // card already covers does not push here — the card is the ONE
        // message for that incident (it names every lost grant incl.
        // Calendars and carries the relaunch line). A partial overlap does
        // NOT suppress (uncovered keys keep their message); no open episode
        // (an agent older than 0.9.9) pushes exactly as before.
        if (shouldPushTccRegression(regressed, pushedKeySet) && !regrantCoversRegression(regressed, regrantGrants)) {
          const device = agent?.deviceName || agent.label || 'your Mac';
          const cause = versionTransitionCause(agent.agentVersion, version);
          const text = tccRegressionPushText(device, regressed, cause);
          void pushTccRegressionToOwner(agent.userId, device, text, key, joinedKeySet(regressed))
            .catch((e) => logger.warn(`imessage: TCC regression push failed (poll continues): ${e?.message ?? e}`));
        }
      } else {
        // Grants healed (owner re-granted) — clear the episode so a future
        // regression pushes fresh. Best-effort; wrapped so a redis client
        // shape that returns void (some mock/legacy shapes) can't throw into
        // the poll path.
        try { void await (redisClient as any).del(tccRegressionDedupeKey(agent.id)); } catch { /* best-effort */ }
      }
    }

    // ── Consolidated TCC re-grant card (ticket c44b19e9, agent 0.9.9) ──
    // While the agent's grant-loss episode is OPEN, every poll carries the
    // joined grant set (`regrant=cal,sr`). ONE owner push per episode (Redis
    // dedupe, the e2915963 discipline — the agent re-sends the key every 25 s
    // while the owner is at System Settings; the backend must not echo that
    // as a message storm). The push carries every grant's pane + the
    // quit-and-relaunch line. An ABSENT param releases the episode key so a
    // future episode pushes fresh (absent-never-clobbers, same contract).
    // regrantGrants was parsed ABOVE (the covered-guard needs it first).
    if (regrantGrants) {
      const key = regrantDedupeKey(agent.id);
      const pushedKeySet = (await (redisClient as any).get(key).catch(() => null)) as string | null;
      if (shouldPushReGrant(regrantGrants, pushedKeySet)) {
        const device = agent?.deviceName || agent.label || 'your Mac';
        const cause = versionTransitionCause(agent.agentVersion, version);
        const text = tccReGrantPushText(device, regrantGrants, cause);
        void pushTccReGrantToOwner(agent.userId, device, text, key, regrantEpisodeKey(regrantGrants))
          .catch((e) => logger.warn(`imessage: TCC re-grant push failed (poll continues): ${e?.message ?? e}`));
      }
    } else {
      // Episode healed / never open — release the dedupe key so a future
      // episode pushes fresh. Best-effort (same wrap as the seam above).
      try { void await (redisClient as any).del(regrantDedupeKey(agent.id)); } catch { /* best-effort */ }
    }

    await touchAgent(agent.id, version, {
      ...(advertPlatform ? { platform: advertPlatform } : {}),
      ...(advertCaps ? { capabilities: advertCaps } : {}),
      ...(mergedPerms ? { permissions: mergedPerms } : {}),
      ...(advertUnattended ? { unattended: advertUnattended } : {}),
      ...(advertRemoteAccess ? { remoteAccess: advertRemoteAccess } : {}),
      ...(advertPreloginHelper ? { preloginHelper: advertPreloginHelper } : {}),
    });

    // If the HTTP client goes away, stop the poll loop (a command popped after
    // the disconnect is requeued for the agent's next poll).
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
    });

    try {
      const command = await agentBroker.waitForCommand(agent.id, 25_000, () => clientGone || res.writableEnded, version, advertCaps);
      if (!res.writableEnded) {
        // Self-update advert (ticket 4e75cdea): additive `update` block — an
        // old agent ignores the unknown field; an agent at 0.8.0+ acts on it.
        // Null (up-to-date / disabled / malformed release) omits the key.
        const update = agentUpdateAdvert(version, agent?.platform ?? undefined);
        if (!res.writableEnded) res.json({ command, ...(update ? { update } : {}) });
      }
    } catch {
      if (!res.writableEnded) res.json({ command: null });
    }
  }

  /** POST /imessage/agent/result — deliver a command result. */
  async agentResult(req: AgentRequest, res: Response) {
    const { cmdId, ok, result, error } = req.body || {};
    if (!cmdId || typeof cmdId !== 'string') {
      res.status(400).json({ success: false, error: 'cmdId is required' });
      return;
    }
    const delivered = await agentBroker.deliverResult(cmdId, !!ok, result, error);
    res.json({ success: true, delivered });
  }
}

/**
 * e2915963: deliver the TCC-regression owner push and mark the episode as
 * pushed (Redis, 7-day TTL — the same discipline as the watchdog's
 * dedupe keys). Reuses the notify_user Telegram channel
 * (telegram.service.sendMessage + the user's TelegramLink — the exact
 * pattern of attention-watchdog.service.ts pushOutageToOwnerTelegram).
 * Never throws to the caller (fire-and-forget from the poll path).
 */
async function pushTccRegressionToOwner(
  userId: string,
  device: string,
  text: string,
  dedupeKey: string,
  episodeKeySet: string,
): Promise<void> {
  try {
    // Mark the episode FIRST (anti-spam: a redis/Telegram outage must not
    // re-fire on every 25 s poll). If the send then FAILS (review F5), the
    // key is RELEASED below so the next poll retries — at most one attempt
    // per poll, which is the same ceiling the incident window tolerates.
    // T3 (follow-up review): the NO-CHANNEL early returns (Telegram not
    // configured / no linked chat) ALSO release — a permanently-marked key
    // with nowhere to send would dedupe the episode into silence for its
    // whole 7-day TTL.
    await (redisClient as any).set(dedupeKey, episodeKeySet, { EX: 7 * 86400 }).catch(() => {});
    const tg: any = await import('../telegram/telegram.service');
    if (!tg?.isConfigured?.()) {
      await (redisClient as any).del(dedupeKey).catch(() => {});
      return;
    }
    const prisma = (await import('../../../config/database')).default;
    const link = await (prisma as any).telegramLink.findUnique({ where: { userId }, select: { chatId: true } }).catch(() => null);
    if (!link?.chatId) {
      await (redisClient as any).del(dedupeKey).catch(() => {});
      return;
    }
    const sent = (await tg.sendMessage(link.chatId, text)) === true;
    if (sent) {
      logger.info(`imessage: TCC permission regression on ${device} pushed to owner Telegram (e2915963)`);
    } else {
      logger.warn(`imessage: TCC regression Telegram send failed on ${device} — releasing the dedupe key so the next poll retries (e2915963)`);
      await (redisClient as any).del(dedupeKey).catch(() => {});
    }
  } catch (err: any) {
    logger.warn(`imessage: TCC regression push failed: ${err?.message ?? err}`);
    try { await (redisClient as any).del(dedupeKey).catch(() => {}); } catch { /* best-effort */ }
  }
}

/**
 * c44b19e9: deliver the CONSOLIDATED re-grant push (the same Telegram
 * channel + the same mark-first/release-on-failure discipline as the
 * e2915963 seam above — one implementation, one behavior).
 */
async function pushTccReGrantToOwner(
  userId: string,
  device: string,
  text: string,
  dedupeKey: string,
  episodeKeySet: string,
): Promise<void> {
  try {
    // T3 (follow-up review): same no-channel release discipline as the
    // e2915963 seam above — mark first, release on ANY non-send outcome
    // (unconfigured Telegram, no linked chat, send failure, error) so the
    // episode is never deduped into 7 days of silence.
    await (redisClient as any).set(dedupeKey, episodeKeySet, { EX: 7 * 86400 }).catch(() => {});
    const tg: any = await import('../telegram/telegram.service');
    if (!tg?.isConfigured?.()) {
      await (redisClient as any).del(dedupeKey).catch(() => {});
      return;
    }
    const prisma = (await import('../../../config/database')).default;
    const link = await (prisma as any).telegramLink.findUnique({ where: { userId }, select: { chatId: true } }).catch(() => null);
    if (!link?.chatId) {
      await (redisClient as any).del(dedupeKey).catch(() => {});
      return;
    }
    const sent = (await tg.sendMessage(link.chatId, text)) === true;
    if (sent) {
      logger.info(`imessage: consolidated TCC re-grant card pushed to owner Telegram on ${device} (c44b19e9)`);
    } else {
      logger.warn(`imessage: TCC re-grant Telegram send failed on ${device} — releasing the dedupe key so the next poll retries (c44b19e9)`);
      await (redisClient as any).del(dedupeKey).catch(() => {});
    }
  } catch (err: any) {
    logger.warn(`imessage: TCC re-grant push failed: ${err?.message ?? err}`);
    try { await (redisClient as any).del(dedupeKey).catch(() => {}); } catch { /* best-effort */ }
  }
}

/**
 * Map a relay refusal to its HTTP status.
 *
 * One place, so the four relay handlers cannot drift apart on what a given
 * refusal means over the wire. The split is deliberate:
 *   403 — the caller is not who this session belongs to (`wrong-device`,
 *         `wrong-capability`). Retrying with the same credentials is futile.
 *   404 — there is no session at all (`no-session`); often just "not opened yet".
 *   409 — there IS a session, but it is not in a carrying state (`not-open`,
 *         `stale`). The operator's next move differs per code, so `code` is
 *         always in the body.
 *   413 — an oversized frame (`frame-too-large`); the caller must split it.
 *   429 — the peer is not reading (`queue-full`); back off, do not split.
 */
function relayStatusFor(refusal: RelayRefusal): number {
  switch (refusal) {
    case 'wrong-device':
    case 'wrong-capability':
      return 403;
    case 'no-session':
      return 404;
    case 'frame-too-large':
      return 413;
    case 'queue-full':
      return 429;
    case 'not-open':
    case 'stale':
      return 409;
    case 'malformed':
    case 'capability-in-url':
    default:
      return 400;
  }
}

export default new IMessageController();
