/**
 * Local computer driver + availability gate.
 *
 * Executes the computer-use action vocabulary on the user's paired Mac via the
 * agentBroker (the same Redis-backed long-poll channel as iMessage and the
 * local browser). The Mac agent must be online AND new enough (v0.3.0 ships the
 * computer_* methods) — the status line mirrors the browser-agent's
 * localBrowserStatus so the caller can always answer "why didn't computer use
 * engage?" (feedback 2027d98d pattern).
 *
 * After every successful input action (click/type/key/scroll/open) the driver
 * auto-dispatches a fresh screenshot and merges it into the observation, so the
 * loop's model ALWAYS sees the result of its last action — one observation, one
 * round-trip pair.
 */

import logger from "../../../utils/logger";
import { agentBroker } from "../imessage/agent-link";
import { listAgents, agentDisplayName, IMessageAgentRow } from "../imessage/imessage.service";
import { agentPlatform } from "../imessage/agent-capabilities";
import { preloginInputFor, PreloginInputCapability } from "../imessage/prelogin-capability";
import { remoteAccessReadyFor, RemoteAccessVerdict } from "../imessage/remote-access-verdict";
import { ComputerAction, ComputerDriver, ComputerObservation } from "./types";
import {
  computerAgentStatus,
  computerUseAvailable,
  MIN_COMPUTER_VERSION,
  UIA_DISPATCH_MIN_AGENT_VERSION,
} from "./availability";

// The availability gate + status line moved to ./availability.ts (2026-09-09)
// so the browser router and the /status endpoint share the exact same gate —
// re-exported here for the existing importers.
export { computerAgentStatus, computerUseAvailable, MIN_COMPUTER_VERSION };
// W3: the UIA dispatch gate ALSO lives in the pure leaf (the loop's tool-offer
// gate needs the same constant without importing this redis/prisma-adjacent
// module) — re-exported here for the driver's own callers.
export { UIA_DISPATCH_MIN_AGENT_VERSION };

/** Minimum agent version allowed to CLAIM computer_* commands off the queue.
 *  0.3.2 = the macOS-26 JXA AppKit-bridging fix; older agents crash on the
 *  unbridged CG C-function symbols. */
const COMPUTER_DISPATCH_MIN_AGENT_VERSION = "0.3.2";

/** Server-side bounds for uia_tree params (the agent clamps too, but the
 *  backend never trusts the model with an unbounded tree walk — a 500-deep /
 *  million-node request would hang the agent's UIA thread past the 45s
 *  broker TTL). */
const UIA_MAX_DEPTH_DEFAULT = 6;
const UIA_MAX_DEPTH_MIN = 1;
const UIA_MAX_DEPTH_MAX = 12;
const UIA_MAX_NODES_DEFAULT = 300;
const UIA_MAX_NODES_MIN = 1;
const UIA_MAX_NODES_MAX = 1000;

/** Clamp an integer with a default for missing/non-numeric input. */
function clampInt(
  raw: unknown,
  def: number,
  min: number,
  max: number,
): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : def;
  return Math.min(max, Math.max(min, n));
}

/** Computer ops are screen-bound (screencapture + downscale, JXA spawns) —
 *  comfortably inside the broker's 120s queue TTL at 45s. */
const COMPUTER_OP_TIMEOUT_MS = 45000;

// ── Settle delay before the post-action auto-screenshot (cu-diag 2026-09-25
// fix #9) ─────────────────────────────────────────────────────────────────────
// The auto-screenshot used to fire the instant the action returned — before
// Spotlight had rendered, before a launched app had a window — so healthy
// actions scored isolated "no visible change (1)" advisories that later frames
// proved wrong. Default 600 ms; 1500 ms after `open` and after Return pressed
// while Spotlight is armed (Cmd+Space was the previous key). COMPUTER_SETTLE_MS=0
// disables (kill switch); COMPUTER_SETTLE_LONG_MS tunes the long case.
export const COMPUTER_SETTLE_MS_DEFAULT = 600;
export const COMPUTER_SETTLE_LONG_MS_DEFAULT = 1500;

function envMs(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === "") return def;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 10_000) : def;
}

/** Pure: how long to wait before the auto-screenshot for this action.
 *  `spotlightArmed` = the previous action was Cmd+Space (Spotlight open). */
export function settleDelayMs(
  action: Pick<ComputerAction, "name" | "key" | "modifiers">,
  spotlightArmed: boolean,
  env: { settleMs?: number; longMs?: number } = {},
): number {
  const base = env.settleMs ?? envMs("COMPUTER_SETTLE_MS", COMPUTER_SETTLE_MS_DEFAULT);
  if (base <= 0) return 0; // kill switch: no delay at all
  const long = env.longMs ?? envMs("COMPUTER_SETTLE_LONG_MS", COMPUTER_SETTLE_LONG_MS_DEFAULT);
  if (action.name === "open") return Math.max(base, long);
  if (action.name === "key") {
    const key = String(action.key || "").trim().toLowerCase();
    if (spotlightArmed && (key === "return" || key === "enter")) return Math.max(base, long);
  }
  return base;
}

/** Pure: does this action open Spotlight (Cmd+Space)? */
export function isSpotlightKey(action: Pick<ComputerAction, "name" | "key" | "modifiers">): boolean {
  if (action.name !== "key") return false;
  const key = String(action.key || "").trim().toLowerCase();
  const mods = (action.modifiers || []).map((m) => String(m).toLowerCase());
  return key === "space" && mods.some((m) => m === "cmd" || m === "command");
}

// ── Device-name matching (cu-diag 2026-09-25 fix #6) ─────────────────────────
// Exact, case-sensitive matching refused "MacBook Pro" against a device
// labelled "Pauls-MBP" and left a single-Mac user with no driver at all.
// Now: case-insensitive, punctuation/whitespace-insensitive SUBSTRING match
// across label / deviceName / id / deviceId (exact normalized matches win;
// several substring hits = ambiguous, refused with the list); and when
// exactly ONE device is paired an unmatched hint is ignored with a note (the
// hint could only have meant that device). COMPUTER_DEVICE_MATCH_STRICT=1
// restores exact matching (kill switch).
//
// Review 2026-09-25 (non-blocking #4): substring alone never made "MacBook
// Pro" reach "Pauls-MBP" — normalized 'macbookpro' vs 'paulsmbp' share no
// substring, so with a SECOND paired Mac the hint was still refused. The
// common Apple abbreviations are expanded on BOTH sides (deviceNameVariants:
// macbookpro⇄mbp, macbookair⇄mba, macmini⇄mini, macstudio⇄studio,
// macpro⇄mp) before the substring pass; the same kill switch covers it.
export function normalizeDeviceName(s: string | null | undefined): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const DEVICE_NAME_ALIASES: Array<[string, string]> = [
  ["macbookpro", "mbp"],
  ["macbookair", "mba"],
  ["macmini", "mini"],
  ["macstudio", "studio"],
  ["macpro", "mp"],
];

/** Every normalized spelling a device name / hint may go by (the name itself
 *  plus each alias substitution, both directions). Pure. */
export function deviceNameVariants(normalized: string): string[] {
  const out = new Set<string>();
  if (!normalized) return [];
  out.add(normalized);
  for (const [long, short] of DEVICE_NAME_ALIASES) {
    if (normalized.includes(long)) out.add(normalized.split(long).join(short));
    if (normalized.includes(short)) out.add(normalized.split(short).join(long));
  }
  return [...out];
}

export type DeviceMatch<T> =
  | { kind: "match"; device: T; note?: string }
  | { kind: "ambiguous"; candidates: T[] }
  | { kind: "none" };

// ── Task-text device detection (ticket d427c381, 2026-10-27) ─────────────────
// A caller may name the target device ONLY in the task prose ("check the menu
// bar on cql-stanne-mbp1") while omitting the `device` param — the natural
// shape. Before this fix selectComputerDriver silently fell back to the
// owner's default Mac and the result header named it, so a lane could report
// "capture is healthy" from the WRONG machine (the live incident: the
// peruse lane nearly cleared a capture-dead diagnosis off a healthy capture
// of example-tailnet-peer). detectNamedDevices is the PURE half of the guard:
// find every paired device whose label / deviceName / id / deviceId appears
// verbatim in the task text (exact or word-boundary, NOT substring —
// 'mini' must not match inside 'minimal'), via the same normalize/alias
// machinery matchDeviceTarget already trusts.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pure: which paired devices does this task text NAME? Two passes, both built
 * on the normalize/alias machinery matchDeviceTarget already trusts:
 *  1. FIELD-IN-TEXT — a device identifier (label / deviceName / id /
 *     deviceId) appears in the text as a whole word (raw or normalized).
 *     Whole-word, never a bare substring: 'mini' must not fire inside
 *     'minimal'.
 *  2. WORD-AS-HINT — every text word (≥3 chars) resolves against the paired
 *     devices exactly like an explicit `device: '<word>'` param would
 *     (normalized contains + Apple-abbreviation variants), so prose "is the
 *     mbp online?" names the same machine the param 'mbp' would.
 * Returns at most one entry per device, in fleet order.
 */
export function detectNamedDevices<T extends { id: string; label: string; deviceName?: string | null; deviceId?: string | null }>(
  taskText: string | null | undefined,
  all: T[],
): T[] {
  const text = String(taskText || "");
  if (!text.trim() || all.length === 0) return [];
  const named = new Set<string>();
  const hit = (needle: string) => {
    const n = normalizeDeviceName(needle);
    if (!n) return false;
    // Whole-word on the RAW text (case-insensitive): an id like d1 stays a
    // token; a label like cql-stanne-mbp1 reads as one hyphenated word. The
    // normalized form (punctuation stripped) is only consulted when the raw
    // form is multi-token ('Pauls-MBP.local' → 'pauls mbp local').
    const raw = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle.toLowerCase())}([^a-z0-9]|$)`, "i").test(text);
    if (raw) return true;
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(n)}([^a-z0-9]|$)`, "i").test(normalizeDeviceName(text));
  };
  // Pass 1: whole device fields, word-boundary in the text.
  for (const d of all) {
    for (const field of [d.label, d.deviceName, d.id, d.deviceId]) {
      const f = String(field || "").trim();
      if (f && hit(f)) {
        named.add(d.id);
        break;
      }
    }
  }
  // Pass 2: each text word resolves like an explicit device hint would —
  // against the DISTINGUISHABLE fields only (label + deviceName, with the
  // mDNS '.local' suffix stripped: a prose word like 'local' or the common
  // noun 'device' must never name a machine through an id/suffix collision;
  // verbatim id mentions are Pass 1's job). Generic hardware nouns are
  // stoplisted: prose "run this on my mac" names NO device — without the
  // stoplist, 'mac' contains-matches every Mac-labeled row and would
  // spuriously refuse a multi-Mac owner's ordinary phrasing.
  const COMMON_NOUNS = new Set(["mac", "computer", "desktop", "laptop", "pc", "machine", "device"]);
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !COMMON_NOUNS.has(w));
  if (words.length > 0) {
    const fields = all
      .filter((d) => !named.has(d.id))
      .map((d) => ({
        d,
        norms: [d.label, d.deviceName]
          .map((f) => normalizeDeviceName(String(f || "").replace(/\.local$/i, "")))
          .filter(Boolean),
      }));
    for (const w of words) {
      for (const variant of deviceNameVariants(w)) {
        for (const f of fields) {
          if (named.has(f.d.id)) continue;
          if (f.norms.some((n) => n.includes(variant))) named.add(f.d.id);
        }
      }
    }
  }
  return all.filter((d) => named.has(d.id));
}

export function matchDeviceTarget<T extends { id: string; label: string; deviceName?: string | null; deviceId?: string | null }>(
  all: T[],
  target: string,
  opts: { strict?: boolean } = {},
): DeviceMatch<T> {
  const t = String(target).trim().toLowerCase();
  const exact = all.find((a) =>
    a.label.toLowerCase() === t ||
    (a.deviceName || "").toLowerCase() === t ||
    a.id.toLowerCase() === t ||
    (a.deviceId || "").toLowerCase() === t,
  );
  if (exact) return { kind: "match", device: exact };
  const strict = opts.strict ?? String(process.env.COMPUTER_DEVICE_MATCH_STRICT ?? "").trim() === "1";
  if (strict) return { kind: "none" };
  const nt = normalizeDeviceName(t);
  if (!nt) return { kind: "none" };
  const fields = (a: T) => [a.label, a.deviceName, a.id, a.deviceId].map(normalizeDeviceName).filter(Boolean);
  const normExact = all.filter((a) => fields(a).some((f) => f === nt));
  if (normExact.length === 1) return { kind: "match", device: normExact[0] };
  if (normExact.length > 1) return { kind: "ambiguous", candidates: normExact };
  const hintVariants = deviceNameVariants(nt);
  const sub = all.filter((a) =>
    fields(a).some((f) => {
      const fv = deviceNameVariants(f);
      return hintVariants.some((h) => fv.some((v) => v.includes(h) || h.includes(v)));
    }),
  );
  if (sub.length === 1) return { kind: "match", device: sub[0] };
  if (sub.length > 1) return { kind: "ambiguous", candidates: sub };
  if (all.length === 1) {
    return {
      kind: "match",
      device: all[0],
      note: `hint '${String(target).trim()}' matched no device name; using the only paired device '${all[0].label || all[0].deviceName || all[0].id}'`,
    };
  }
  return { kind: "none" };
}

export interface ComputerDriverSelection {
  driver: ComputerDriver | null;
  agentId: string | null;
  status: string;
  /** Multi-Mac (2026-09-24): which device was selected, for result headers. */
  device: string | null;
  /** W0 (2026-09-25): the selected device's platform ('macos' | 'windows') —
   *  the loop picks per-platform model instructions; null when no driver. */
  platform: 'macos' | 'windows' | null;
  /** W3 (2026-09-25): the selected device's agentVersion (raw string) — the
   *  loop gates the UIA tools on it (a Windows agent older than 0.9.0 must
   *  never be OFFERED uia_*: the dispatch gate would requeue every call and
   *  burn the full 45s broker timeout with a misleading error). */
  agentVersion: string | null;
  /** Ticket d427c381 (2026-10-27): true when the device was chosen because the
   *  TASK TEXT named it (the `device` param was omitted) — the tool-result
   *  header renders the device line loudly so a caller can never mistake
   *  another Mac's healthy capture for the named machine's. */
  deviceAutoBound?: boolean;
  /** Ticket d427c381: device names the task text mentioned (resolved to paired
   *  rows) — a multi-name refusal carries the list; a success carries the
   *  bound name(s). */
  taskTextNamedDevices?: string[];
  /** Ticket d427c381: the task text named a DIFFERENT paired device than the
   *  explicit `device` param drives — the header warns about the mismatch. */
  taskTextNamesOtherThanParam?: string[];
  /** Ticket c468f922 (2026-10-28): the PRE-LOGIN INPUT capability of the
   *  selected device — can it be typed into while no user session exists, and
   *  is it sitting at a lock/login screen RIGHT NOW. Present on every path
   *  that selects a device; absent when no device was selected at all.
   *  `blockedNow: true` means a dispatch must fail fast (see
   *  imessage/prelogin-capability.ts) instead of burning the run. */
  prelogin?: PreloginInputCapability;
  /** Ticket c468f922 (owner ruling 2026-10-29): BROKERED REMOTE ACCESS for the
   *  selected device — the OS's own remote channel (macOS Screen Sharing /
   *  Windows RDP), hardened tunnel-only. Deliberately a SEPARATE fact from
   *  `prelogin`: they answer different questions ("can computer_task type at a
   *  login window?" = NO — versus "is there a hardened operator channel that
   *  reaches the login window?" = maybe). Merging them would let a lane act on
   *  a half-truth, which is the exact bug c468f922 exists to end. */
  remoteAccess?: RemoteAccessVerdict;
}

/** Resolve a computer-use driver from the user's paired Macs, or explain why not.
 *
 *  Task-text guard (ticket d427c381, 2026-10-27): the task prose may name a
 *  paired device while the `device` param is omitted. When the text names
 *  exactly ONE paired device that is NOT the param-less default pick, it is
 *  auto-bound (deviceAutoBound) — never silently drive a machine the task did
 *  not name. When the text names SEVERAL paired devices, selection REFUSES
 *  with the list (an implicit pick could be the wrong one — the live incident
 *  nearly cleared a capture-dead diagnosis off a healthy capture of a
 *  different Mac). The refusal carries `taskTextNamedDevices` for the header. */
export async function selectComputerDriver(
  userId: string,
  target?: string | null,
  taskText?: string | null,
): Promise<ComputerDriverSelection> {
  try {
    // Multi-Mac: reason over ALL paired Macs. An explicit target names one; the
    // default Mac is preferred otherwise; a too-old/offline Mac excludes only
    // itself — another capable Mac keeps computer use available.
    const all: IMessageAgentRow[] = await listAgents(userId);
    if (all.length === 0) {
      return { driver: null, agentId: null, status: computerAgentStatus(null), device: null, platform: null, agentVersion: null };
    }
    const nameOf = (a: IMessageAgentRow) => agentDisplayName(a);
    const capable = all.filter((a) => computerUseAvailable(a));

    // ── Task-text device guard (ticket d427c381) ─────────────────────────────
    // Prose may name the device ("… on cql-stanne-mbp1") while the `device`
    // param is omitted. Resolve the param-less default pick FIRST, then:
    //  • the text names exactly one paired device ≠ the default pick → auto-bind
    //    it (deviceAutoBound: the header renders the device line LOUD, so a
    //    caller can never again mistake another Mac's healthy capture for the
    //    named machine's);
    //  • the text names several paired devices → REFUSE with the list (an
    //    implicit pick could be the wrong machine — the mishap's exact shape);
    //  • the text names only the default pick, or nothing resolvable → the
    //    historical behavior byte-for-byte.
    // An explicit `target` param always wins over prose; the mismatch flag
    // (taskTextNamesOtherThanParam) still rides the selection so the header can
    // warn that the named machine was NOT the one driven.
    const named = taskText ? detectNamedDevices(String(taskText), all) : [];
    let defaultPick: IMessageAgentRow | null = null;
    if (capable.length > 0) defaultPick = capable.find((a) => a.isDefault) ?? capable[0];

    if (!target && named.length > 1) {
      const names = named.map((a) => `'${nameOf(a)}'`).join(', ');
      return {
        driver: null, agentId: null,
        status: `the task names several paired devices (${names}) but no device parameter was set — name one exactly (device: '…').`,
        device: null, platform: null, agentVersion: null,
        taskTextNamedDevices: named.map(nameOf),
      };
    }

    if (!target && named.length === 1 && (!defaultPick || defaultPick.id !== named[0].id)) {
      const match = named[0];
      if (!computerUseAvailable(match)) {
        return {
          driver: null, agentId: match.id,
          status: `'${nameOf(match)}' (named in the task) cannot run computer use — ${computerAgentStatus(match)}`,
          device: nameOf(match), platform: agentPlatform(match), agentVersion: match.agentVersion || null,
          taskTextNamedDevices: [nameOf(match)],
        };
      }
      return {
        driver: new LocalComputerDriver(match.id),
        agentId: match.id,
        status: `${computerAgentStatus(match)} [device auto-bound from the task text — pass device: '${nameOf(match)}' explicitly next time]`,
        device: nameOf(match),
        platform: agentPlatform(match),
        agentVersion: match.agentVersion || null,
        deviceAutoBound: true,
        taskTextNamedDevices: [nameOf(match)],
        prelogin: preloginInputFor(match),
        remoteAccess: remoteAccessReadyFor(match),
      };
    }

    if (target && String(target).trim()) {
      // cu-diag fix #6: fuzzy (normalized substring) matching + the
      // single-device carve-out; exact matches behave exactly as before.
      const m = matchDeviceTarget(all, String(target));
      if (m.kind === "ambiguous") {
        const names = m.candidates.map((a) => `'${nameOf(a)}'`).join(', ');
        return {
          driver: null, agentId: null,
          status: `'${target}' matches several paired devices (${names}) — name one exactly.`,
          device: null, platform: null, agentVersion: null,
        };
      }
      if (m.kind === "none") {
        const available = all.map((a) => `'${nameOf(a)}'`).join(', ');
        return {
          driver: null, agentId: null,
          status: `no paired device matches '${target}'. Paired devices: ${available}.`,
          device: null, platform: null, agentVersion: null,
        };
      }
      const match = m.device;
      const noteSuffix = m.note ? ` [${m.note}]` : '';
      // d427c381 mismatch disclosure: the task prose named a DIFFERENT paired
      // device than the explicit param drives — the header must say so, or a
      // caller skimming for the named machine's result reads the wrong one.
      const otherNamed = named.filter((d) => d.id !== match.id).map(nameOf);
      if (!computerUseAvailable(match)) {
        return {
          driver: null, agentId: match.id,
          status: `'${nameOf(match)}' cannot run computer use — ${computerAgentStatus(match)}${noteSuffix}`,
          device: nameOf(match), platform: agentPlatform(match), agentVersion: match.agentVersion || null,
          ...(otherNamed.length > 0 ? { taskTextNamesOtherThanParam: otherNamed } : {}),
        };
      }
      return {
        driver: new LocalComputerDriver(match.id),
        agentId: match.id,
        status: computerAgentStatus(match) + noteSuffix,
        device: nameOf(match),
        platform: agentPlatform(match),
        agentVersion: match.agentVersion || null,
        ...(otherNamed.length > 0 ? { taskTextNamesOtherThanParam: otherNamed } : {}),
        prelogin: preloginInputFor(match),
        remoteAccess: remoteAccessReadyFor(match),
      };
    }

    if (capable.length > 0) {
      const chosen = capable.find((a) => a.isDefault) ?? capable[0];
      const suffix = all.length > 1 ? ` [device: '${nameOf(chosen)}']` : '';
      return {
        driver: new LocalComputerDriver(chosen.id),
        agentId: chosen.id,
        status: computerAgentStatus(chosen) + suffix,
        device: nameOf(chosen),
        platform: agentPlatform(chosen),
        agentVersion: chosen.agentVersion || null,
        prelogin: preloginInputFor(chosen),
        remoteAccess: remoteAccessReadyFor(chosen),
      };
    }

    // None capable — per-device reasons, "too old" never hides another device.
    const perDevice = all.map((a) => `'${nameOf(a)}' ${computerAgentStatus(a)}`).join('; ');
    return { driver: null, agentId: null, status: `no capable device — ${perDevice}`, device: null, platform: null, agentVersion: null };
  } catch (e: any) {
    logger.warn(`computer driver: agent lookup failed: ${e?.message || e}`);
    return {
      driver: null,
      agentId: null,
      status: "unknown — could not check your paired devices (the lookup failed)",
      device: null,
      platform: null,
      agentVersion: null,
    };
  }
}

export class LocalComputerDriver implements ComputerDriver {
  constructor(private readonly agentId: string) {}

  /** cu-diag fix #9: Spotlight-armed state for the settle delay — set by
   *  Cmd+Space, consumed by the next Return, cleared by a click/open. */
  private spotlightArmed = false;

  /** Sleep before the post-action auto-screenshot (cu-diag fix #9). Pure
   *  timing — never touches the device. */
  private async settle(action: ComputerAction): Promise<void> {
    const ms = settleDelayMs(action, this.spotlightArmed);
    if (action.name === "key") {
      if (isSpotlightKey(action)) this.spotlightArmed = true;
      else if (/^(return|enter)$/i.test(String(action.key || "").trim())) this.spotlightArmed = false;
    } else if (action.name === "click" || action.name === "open" || action.name === "uia_invoke") {
      this.spotlightArmed = false;
    }
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    // minAgentVersion: computer_* commands must never be claimed by an agent
    // older than 0.3.2 (the macOS-26 JXA AppKit-bridging fix). Multi-device
    // fleets share one agentId — without the gate an old clone wins the Redis
    // LPOP race and crashes on unbridged CG symbols (seen live 2026-08-31).
    // capability (W1, 2026-09-25): broker-side claiming gate — a poller that
    // advertises a capability set WITHOUT 'computer' (none today, but the
    // handshake allows it) requeues instead of claiming; a legacy Mac (no
    // advertisement) claims everything as before.
    return agentBroker.dispatch(
      this.agentId,
      method,
      params,
      COMPUTER_OP_TIMEOUT_MS,
      {
        minAgentVersion: COMPUTER_DISPATCH_MIN_AGENT_VERSION,
        capability: "computer",
      },
    );
  }

  /** W3: UIA commands ride the stricter 0.9.0 gate — the macOS agent (0.5.x)
   *  must never claim them. Same capability field: the Windows agent
   *  advertises ['browser','computer']. */
  private async dispatchUia(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    return agentBroker.dispatch(
      this.agentId,
      method,
      params,
      COMPUTER_OP_TIMEOUT_MS,
      {
        minAgentVersion: UIA_DISPATCH_MIN_AGENT_VERSION,
        capability: "computer",
      },
    );
  }

  private async takeScreenshot(
    action: ComputerAction["name"],
  ): Promise<ComputerObservation> {
    const r = await this.dispatch("computer_screenshot", {});
    return { ...r, action };
  }

  async execute(action: ComputerAction): Promise<ComputerObservation> {
    try {
      switch (action.name) {
        case "screenshot":
          return this.takeScreenshot("screenshot");
        case "click":
        case "type":
        case "key":
        case "scroll":
        case "open": {
          const params: Record<string, unknown> = {};
          if (action.name === "click") {
            if (typeof action.x !== "number" || typeof action.y !== "number") {
              return {
                ok: false,
                action: action.name,
                error:
                  "click requires x and y (image pixels of the last screenshot)",
              };
            }
            params.x = Math.round(action.x);
            params.y = Math.round(action.y);
            params.button = action.button === "right" ? "right" : "left";
            params.clicks = action.clicks === 2 ? 2 : 1;
          } else if (action.name === "type") {
            params.text = String(action.text || "");
          } else if (action.name === "key") {
            params.key = String(action.key || "");
            params.modifiers = Array.isArray(action.modifiers)
              ? action.modifiers
              : [];
          } else if (action.name === "scroll") {
            params.direction = action.direction === "up" ? "up" : "down";
            params.amount =
              typeof action.amount === "number" && action.amount > 0
                ? Math.round(action.amount)
                : 10;
            // v0.4.3 (ticket 4e4d56ff): optional target — the agent moves and
            // verifies the pointer at this image-pixel point before the wheel,
            // so the scroll hits the content the model aimed at.
            if (typeof action.x === "number" && typeof action.y === "number") {
              params.x = Math.round(action.x);
              params.y = Math.round(action.y);
            }
          } else {
            params.target = String(action.target || "");
          }
          const method = `computer_${action.name}`;
          const r: any = await this.dispatch(method, params);
          if (r && r.ok === false) {
            return { ...r, action: action.name };
          }
          // Input succeeded — auto-screenshot so the model sees the result,
          // after a short settle so the screen has rendered it (fix #9).
          try {
            await this.settle(action);
            return await this.takeScreenshot(action.name);
          } catch (shotErr: any) {
            // The action ran but the camera didn't — report the action's own
            // success and let the model decide whether to retry a screenshot.
            return {
              ok: true,
              action: action.name,
              error: `action succeeded but the follow-up screenshot failed: ${shotErr?.message || shotErr}`,
            };
          }
        }
        case "uia_tree": {
          // W3 (Windows 0.9.0): read the accessibility tree — a TEXT
          // observation, not a screenshot. Only the params are shaped here;
          // the result carries { ok, tree, text, node_count } straight from
          // the agent (the tree object is for future use; the loop feeds the
          // compact text linearization to the model). NO follow-up screenshot:
          // the agent does not send one, and the tree IS the observation —
          // appending a frame here would double the round-trip for nothing.
          const params: Record<string, unknown> = {
            root: action.root === "desktop" ? "desktop" : "foreground",
            max_depth: clampInt(action.max_depth, UIA_MAX_DEPTH_DEFAULT, UIA_MAX_DEPTH_MIN, UIA_MAX_DEPTH_MAX),
            max_nodes: clampInt(action.max_nodes, UIA_MAX_NODES_DEFAULT, UIA_MAX_NODES_MIN, UIA_MAX_NODES_MAX),
          };
          const r: any = await this.dispatchUia("computer_uia_tree", params);
          if (r && r.ok === false) {
            return { ...r, action: action.name };
          }
          // Normalize the success shape: keep tree/text/node_count as sent
          // (the agent's text is the contract), defaulting missing text so
          // the loop's model always gets something readable.
          return {
            ok: true,
            action: action.name,
            text: typeof r?.text === "string" ? r.text : "",
            node_count:
              typeof r?.node_count === "number" ? r.node_count : 0,
            ...(r?.tree ? { tree: r.tree } : {}),
            // Only if the agent (contrary to contract) sent a frame along —
            // never dispatch one ourselves for a read.
            ...(typeof r?.screenshotBase64 === "string"
              ? { screenshotBase64: r.screenshotBase64 }
              : {}),
          };
        }
        case "uia_invoke": {
          // W3 (Windows 0.9.0): activate a UIA element by runtime_id — the
          // reliable alternative to coordinate clicks in elevated-sibling
          // apps (UIPI eats synthetic clicks but UIA patterns go through).
          // Validation BEFORE dispatch (no agent round-trip for garbage).
          if (
            !Array.isArray(action.runtime_id) ||
            action.runtime_id.length === 0 ||
            !action.runtime_id.every((n) => typeof n === "number" && Number.isFinite(n))
          ) {
            return {
              ok: false,
              action: action.name,
              error:
                "uia_invoke requires runtime_id: a non-empty array of numbers (from a uia_tree observation)",
            };
          }
          const pattern =
            action.pattern === "toggle" ||
            action.pattern === "expand" ||
            action.pattern === "select" ||
            action.pattern === "focus" ||
            action.pattern === "set_value"
              ? action.pattern
              : "invoke";
          if (pattern === "set_value" && typeof action.text !== "string") {
            return {
              ok: false,
              action: action.name,
              error:
                "uia_invoke with pattern 'set_value' requires text (the value to set)",
            };
          }
          const params: Record<string, unknown> = {
            runtime_id: action.runtime_id.map((n) => Math.round(n as number)),
            pattern,
            ...(pattern === "set_value" ? { value: action.text } : {}),
          };
          const r: any = await this.dispatchUia("computer_uia_invoke", params);
          if (r && r.ok === false) {
            return { ...r, action: action.name };
          }
          // Input succeeded — the SAME auto-screenshot path as click/type/key/
          // scroll/open: the model must see the effect of its action.
          try {
            await this.settle(action);
            return await this.takeScreenshot(action.name);
          } catch (shotErr: any) {
            return {
              ok: true,
              action: action.name,
              error: `action succeeded but the follow-up screenshot failed: ${shotErr?.message || shotErr}`,
            };
          }
        }
        default:
          return {
            ok: false,
            action: action.name,
            error: `action '${action.name}' is not dispatchable`,
          };
      }
    } catch (e: any) {
      return { ok: false, action: action.name, error: e?.message || String(e) };
    }
  }
}
