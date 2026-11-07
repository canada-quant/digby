/**
 * Apple (macOS) Calendar — ONE device policy + one read contract, shared by
 * every Digby surface that touches it (ticket: "still no calendar sync on new
 * chats", 2026-11-06).
 *
 * WHY THIS MODULE EXISTS. Before this file the Apple calendar read existed in
 * exactly ONE place — the `mac_calendar_list_events` model tool — and had three
 * consequences the owner hit at once:
 *
 *   1. NOTHING ELSE COULD REACH IT. New-chat integration context prefetched
 *      Google Calendar on calendar intent and had no Apple leg at all, and the
 *      home "Today" card was Google-only by construction (its route answers
 *      `connected:false` with no Google row). An owner whose Apple calendar was
 *      the real one got an empty card and an assistant that never knew.
 *   2. THE DEVICE POLICY WAS IMPLICIT. `selectAgent` falls over from the
 *      default Mac to any online sibling, which is right for iMessage and
 *      WRONG for Apple Calendar: a Mac that is not signed in to the owner's
 *      Apple account answers `no-calendar-account`, so failing over elects a
 *      Mac that structurally cannot hold the events. Worse, when the caller
 *      ASKED for a specific Mac, a silent fall-over answers about a different
 *      machine than the one named.
 *   3. A SIGNED-OUT MAC LOOKED LIKE AN EMPTY DAY. `events: []` from a Mac with
 *      no account, a Mac with an undecided consent, and a genuinely free day
 *      were three shapes the callers could confuse.
 *
 * THE POLICY, stated once here and enforced everywhere:
 *   • An EXPLICIT device is honoured exactly: it answers, or the result says
 *     why it could not — the request is NEVER silently re-routed to a sibling.
 *   • With no explicit device, the DEFAULT Mac answers. Only when it cannot
 *     serve at all (offline / too old / no calendar capability) does a sibling
 *     take over, and the result always NAMES the device that answered.
 *   • A Mac that answered `no-calendar-account` (EventKit reported zero
 *     calendars ⇒ not signed in to an Apple account) is remembered for a short
 *     window and SKIPPED by the proactive/automatic path — so a signed-out Mac
 *     can never stand in for a signed-in one. It is still tried when it is the
 *     only candidate or when the caller named it (its honest refusal is better
 *     than a fabricated empty day).
 *   • `events: null` + a classified state is a FAILURE, never an empty day. Only
 *     `state:'ok'` with a (possibly empty) array is "nothing on your calendar".
 *   • Every result carries the source device label + the TCC client binary, so
 *     a user can see WHICH machine and WHICH binary the answer came from.
 *
 * OWNER DIRECTIVE (standing, 2026-10-07): Apple services must only be used on
 * Macs signed in to the owner's PERSONAL Apple account — `cql-stanne-mbp-2` is
 * known NOT to be, and is excluded. The mechanism below never hard-codes Mac
 * names (that would rot the moment a machine is renamed or re-paired): it
 * derives sign-in state from what each Mac actually reported and skips on that.
 */

import logger from '../../../utils/logger';
import { selectAgent, agentDisplayName, isOnline, listAgents, type IMessageAgentRow } from '../imessage/imessage.service';
import { agentBroker, IMESSAGE_READ_DISPATCH_TIMEOUT_MS } from '../imessage/agent-link';
import { hasCapability, agentPlatform } from '../imessage/agent-capabilities';

/** The classified outcomes of a macOS Calendar read. `ok` is the ONLY state
 *  that may be rendered as a calendar day; every other state is a reason. */
export type AppleCalendarState =
  | 'ok'
  | 'no-calendar-account'
  | 'calendar-denied'
  | 'calendar-never-requested'
  | 'calendar-unreachable'
  | 'unsupported'
  | 'no-agent';

/** The consent episode an agent reported with its read (agent ≥ 0.9.24).
 *  Mirrors imessage-agent/src/calendar-consent.ts — additive, absent on older
 *  agents, and NEVER inferred by the backend when absent. */
export interface AppleCalendarConsent {
  state: 'dialog-open' | 'dispatched' | 'granted' | 'denied' | 'bridge-failed' | 'request-failed';
  at: string;
  observedTier: number | null;
  idiom: string;
  requestExit: 'ok' | 'timeout' | 'error' | 'staging-failed';
  version: string;
}

export interface AppleCalendarEvent {
  /** EventKit event identifier — stable per event per calendar. */
  id: string;
  calendar: string;
  title: string | null;
  startDate: string | null;
  endDate: string | null;
  location: string | null;
  allDay: boolean;
  notes: string | null;
}

export interface AppleCalendarRead {
  state: AppleCalendarState;
  /** Human label of the Mac that answered (or that WOULD have answered). */
  device: string | null;
  /** Paired-agent id of that Mac (null when nothing served). */
  agentId: string | null;
  /** 'targeted' when the caller named this Mac, 'default' when it is the
   *  default Mac, 'fallback' when a sibling took over, 'none' when nothing
   *  served. The copy must never present a fallback as "your Mac". */
  via: 'targeted' | 'default' | 'fallback' | 'none';
  /** Events ONLY when state === 'ok' — null otherwise (never [] for a failure). */
  events: AppleCalendarEvent[] | null;
  /** TCC client binary the EventKit request ran in (agent ≥ 0.9.11). */
  client?: string;
  consent?: AppleCalendarConsent;
  /** Short model/user-facing explanation for a non-ok state. */
  error?: string;
  /** Macs that were skipped because they last reported no Apple account. */
  skippedSignedOut?: string[];
}

// ── Read-derived sign-in memory ──────────────────────────────────────────────
//
// A Mac that answers `no-calendar-account` told us something durable about
// itself: EventKit reports ZERO calendars, which on macOS means no Apple
// account is signed in. Re-asking it on every proactive prefetch wastes a
// dispatch AND — worse — lets a signed-out Mac be chosen as the "available"
// device. So we remember it for a bounded window and skip it on the AUTOMATIC
// path. Read-derived, never configured: the moment the owner signs the Mac in,
// one read (explicit or after the window) clears the mark.
//
// Process-local on purpose: this is a routing HINT, not truth. A restart
// simply forgets and tries once more — the honest failure mode.
export const APPLE_SIGNED_OUT_TTL_MS = 30 * 60 * 1000;

const signedOutAt = new Map<string, number>();

/** Remember that this Mac reported no Apple account (read-derived). */
export function noteAppleCalendarSignedOut(agentId: string, at: number = Date.now()): void {
  signedOutAt.set(agentId, at);
}

/** Clear the mark — a read SUCCEEDED on this Mac, so it is signed in. */
export function clearAppleCalendarSignedOut(agentId: string): void {
  signedOutAt.delete(agentId);
}

/** True when this Mac last reported "no Apple account" inside the window. */
export function appleCalendarKnownSignedOut(agentId: string, now: number = Date.now()): boolean {
  const at = signedOutAt.get(agentId);
  if (at === undefined) return false;
  if (now - at >= APPLE_SIGNED_OUT_TTL_MS) {
    signedOutAt.delete(agentId);
    return false;
  }
  return true;
}

/** Test seam — the map is module state. */
export function resetAppleCalendarSignedOut(): void {
  signedOutAt.clear();
}

// ── The read ─────────────────────────────────────────────────────────────────

function asNumber(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalise whatever the agent sent into the read contract. Older agents
 *  (≤0.9.23) send exactly `{events}` or `{events:null, unavailable:{reason,
 *  pane, client?}}` — every shape below is additive over that. */
export function interpretAgentCalendarResult(raw: unknown): Pick<AppleCalendarRead, 'state' | 'events' | 'client' | 'consent'> {
  const res = (typeof raw === 'object' && raw !== null ? raw : null) as
    | { events?: unknown; unavailable?: { reason?: unknown; client?: unknown }; consent?: unknown }
    | null;
  if (!res) return { state: 'calendar-unreachable', events: null };

  const consent = interpretConsent(res.consent);
  const client = typeof res.unavailable?.client === 'string' && res.unavailable.client ? res.unavailable.client : undefined;

  if (Array.isArray(res.events)) {
    const events: AppleCalendarEvent[] = [];
    for (const e of res.events) {
      const o = (typeof e === 'object' && e !== null ? e : null) as Record<string, unknown> | null;
      if (!o) continue;
      const id = typeof o.id === 'string' ? o.id : '';
      if (!id) continue; // not dedupable / not referenceable — dropped, as the agent does
      const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
      events.push({
        id,
        calendar: str(o.calendar) ?? '',
        title: str(o.title),
        startDate: str(o.startDate),
        endDate: str(o.endDate),
        location: str(o.location),
        allDay: o.allDay === true,
        notes: str(o.notes),
      });
    }
    return { state: 'ok', events, client, consent };
  }

  const reason = typeof res.unavailable?.reason === 'string' ? res.unavailable.reason : '';
  const known: AppleCalendarState[] = [
    'no-calendar-account', 'calendar-denied', 'calendar-never-requested', 'calendar-unreachable',
  ];
  const state = (known as string[]).includes(reason) ? (reason as AppleCalendarState) : 'calendar-unreachable';
  return { state, events: null, client, consent };
}

/** Accept only a fully-formed consent episode — a partial one is DROPPED
 *  rather than half-rendered (an unverified state must not reach the copy). */
export function interpretConsent(raw: unknown): AppleCalendarConsent | undefined {
  const o = (typeof raw === 'object' && raw !== null ? raw : null) as Record<string, unknown> | null;
  if (!o) return undefined;
  const states = ['dialog-open', 'dispatched', 'granted', 'denied', 'bridge-failed', 'request-failed'];
  if (typeof o.state !== 'string' || !states.includes(o.state)) return undefined;
  if (typeof o.at !== 'string' || !o.at) return undefined;
  const tier = asNumber(o.observedTier);
  const exits = ['ok', 'timeout', 'error', 'staging-failed'];
  return {
    state: o.state as AppleCalendarConsent['state'],
    at: o.at,
    observedTier: tier === null ? null : tier,
    idiom: typeof o.idiom === 'string' ? o.idiom : 'none',
    requestExit: (typeof o.requestExit === 'string' && exits.includes(o.requestExit))
      ? (o.requestExit as AppleCalendarConsent['requestExit'])
      : 'error',
    version: typeof o.version === 'string' ? o.version : 'unknown',
  };
}

/**
 * Pick the Mac that should answer an Apple Calendar read.
 *
 * Explicit device → exactly that (never re-routed). Otherwise the default Mac;
 * an online sibling only when the default cannot serve at all. A Mac known to
 * have no Apple account is skipped by the AUTOMATIC path (default and
 * fallback), never when it is the only online candidate or when the caller
 * named it.
 *
 * Exported for the device-policy tests.
 */
export function chooseAppleCalendarDevice(args: {
  agents: IMessageAgentRow[];
  explicit?: string | null;
  now?: number;
}): { agent: IMessageAgentRow | null; via: AppleCalendarRead['via']; skipped: string[]; reason?: string } {
  const now = args.now ?? Date.now();
  const online = (a: IMessageAgentRow) => isOnline(a.lastSeenAt);
  const canServe = (a: IMessageAgentRow) => online(a) && agentPlatform(a) === 'macos' && hasCapability(a, 'calendar');
  const skipped: string[] = [];

  if (args.explicit && String(args.explicit).trim()) {
    // EXACT: a named Mac answers about itself, or the result explains why not.
    const t = String(args.explicit).trim().toLowerCase();
    const match = args.agents.find((a) =>
      (a.label || '').toLowerCase() === t ||
      (a.deviceName || '').toLowerCase() === t ||
      a.id.toLowerCase() === t ||
      (a.deviceId || '').toLowerCase() === t,
    );
    if (!match) {
      const available = args.agents.map((a) => `'${agentDisplayName(a)}'${online(a) ? '' : ' (offline)'}`).join(', ');
      return { agent: null, via: 'none', skipped, reason: `No paired Mac matches '${args.explicit}'. Paired Macs: ${available}.` };
    }
    if (!online(match)) {
      return { agent: null, via: 'none', skipped, reason: `'${agentDisplayName(match)}' is offline.` };
    }
    if (agentPlatform(match) !== 'macos' || !hasCapability(match, 'calendar')) {
      return { agent: null, via: 'none', skipped, reason: `'${agentDisplayName(match)}' cannot read Calendar (Mac agent 0.7.0+ required${match.agentVersion ? `; runs v${match.agentVersion}` : ''}).` };
    }
    // Named Mac that is known signed-out is still tried: its honest refusal
    // is the ONLY correct answer for a name the caller chose.
    return { agent: match, via: 'targeted', skipped };
  }

  const def = args.agents.find((a) => a.isDefault) ?? args.agents[0] ?? null;
  const candidates: { a: IMessageAgentRow; via: 'default' | 'fallback' }[] = [];
  if (def) candidates.push({ a: def, via: 'default' });
  for (const a of args.agents) if (def && a.id !== def.id) candidates.push({ a, via: 'fallback' });

  for (const c of candidates) {
    if (!canServe(c.a)) continue;
    if (appleCalendarKnownSignedOut(c.a.id, now)) {
      skipped.push(agentDisplayName(c.a));
      continue;
    }
    return { agent: c.a, via: c.via === 'default' ? 'default' : 'fallback', skipped };
  }

  // Nothing left: either every candidate was skipped as signed-out, or none
  // could serve. A skipped Mac is STILL a better answer than "no device" when
  // it is online and capable — it will report the honest no-account state,
  // which the copy turns into "sign in on that Mac".
  const servable = candidates.filter((c) => canServe(c.a));
  if (servable.length > 0) {
    return { agent: servable[0].a, via: 'fallback', skipped };
  }
  if (args.agents.length === 0) return { agent: null, via: 'none', skipped, reason: 'No Mac is connected. Pair your Mac first.' };
  if (!args.agents.some(online)) {
    return { agent: null, via: 'none', skipped, reason: 'Your Mac agent is offline. Make sure the Digby agent is running.' };
  }
  return {
    agent: null,
    via: 'none',
    skipped,
    reason: `No paired Mac can read Calendar right now (${args.agents.map((a) => `'${agentDisplayName(a)}': ${online(a) ? 'too old for Calendar reads' : 'offline'}`).join(', ')}).`,
  };
}

/**
 * Read Apple Calendar events from the Mac the policy selects.
 *
 * NEVER throws and NEVER returns `events: []` for a failure: a caller may
 * render a day ONLY on `state === 'ok'`. Dispatch failures (timeout, agent
 * gone) are `calendar-unreachable` — distinct from a denial.
 */
export async function readAppleCalendar(
  userId: string,
  opts: { device?: string | null; days?: number; timeoutMs?: number; agents?: IMessageAgentRow[] } = {},
): Promise<AppleCalendarRead> {
  const days = Math.min(Math.max(Math.floor(Number(opts.days) || 1), 1), 120);
  let agents: IMessageAgentRow[];
  try {
    agents = opts.agents ?? (await listAgents(userId));
  } catch (e: any) {
    logger.warn(`apple-calendar: listAgents failed (non-blocking): ${e?.message || e}`);
    return { state: 'no-agent', device: null, agentId: null, via: 'none', events: null, error: 'Could not list your paired Macs.' };
  }

  // selectAgent owns the wording for "unknown device"/"offline"/"no capable
  // Mac"; chooseAppleCalendarDevice owns the Apple-specific skip policy. We
  // call ours first so a signed-out Mac is not silently elected, then fall
  // back to selectAgent's message when ours finds nothing (identical wording).
  const choice = chooseAppleCalendarDevice({ agents, explicit: opts.device ?? null });
  if (!choice.agent) {
    const selection = await selectAgent(userId, opts.device ?? undefined);
    return {
      state: 'no-agent', device: null, agentId: null, via: 'none', events: null,
      error: choice.reason || selection.error || 'No paired Mac can read Calendar right now.',
      ...(choice.skipped.length ? { skippedSignedOut: choice.skipped } : {}),
    };
  }

  const agent = choice.agent;
  const device = agentDisplayName(agent);
  const timeoutMs = opts.timeoutMs ?? IMESSAGE_READ_DISPATCH_TIMEOUT_MS;

  let result: unknown;
  try {
    // No capability opt here: the policy above already gated on
    // hasCapability(a,'calendar'), and the 4-arg dispatch shape is what the
    // existing tests (and the mac tool's documented contract) pin.
    result = await agentBroker.dispatch(agent.id, 'calendar_list_events', { days }, timeoutMs);
  } catch (e: any) {
    logger.warn(`apple-calendar: dispatch to '${device}' failed (non-blocking): ${e?.message || e}`);
    return {
      state: 'calendar-unreachable', device, agentId: agent.id, via: choice.via, events: null,
      error: `${device} did not answer the Calendar read.`,
      ...(choice.skipped.length ? { skippedSignedOut: choice.skipped } : {}),
    };
  }

  const interpreted = interpretAgentCalendarResult(result);
  if (interpreted.state === 'ok') clearAppleCalendarSignedOut(agent.id);
  if (interpreted.state === 'no-calendar-account') noteAppleCalendarSignedOut(agent.id);

  return {
    state: interpreted.state,
    device,
    agentId: agent.id,
    via: choice.via,
    events: interpreted.events,
    ...(interpreted.client ? { client: interpreted.client } : {}),
    ...(interpreted.consent ? { consent: interpreted.consent } : {}),
    ...(interpreted.state === 'ok' ? {} : { error: appleCalendarStateLine(interpreted.state, device, interpreted.consent, interpreted.client) }),
    ...(choice.skipped.length ? { skippedSignedOut: choice.skipped } : {}),
  };
}

/**
 * ONE sentence per classified state — the single place Apple Calendar copy is
 * written, so the tool, the chat context and the home card can never drift
 * into three different stories about the same Mac.
 *
 * Every sentence states only what was OBSERVED. In particular a tier-0 read
 * must never again claim "a consent dialog was just triggered": the request
 * is asynchronous and unverifiable, so the copy now says what the LAST episode
 * observed (or that none was observed yet) and gives the manual path.
 */
export function appleCalendarStateLine(
  state: AppleCalendarState,
  device: string,
  consent?: AppleCalendarConsent,
  client?: string,
): string {
  // The TCC client the user must enable is the AGENT BINARY, not the "Digby"
  // app — daf8706a's incident was an owner toggling the app row ON while the
  // binary stayed ungranted. Whenever the agent told us its path, name it.
  const clientNote = client ? ` The binary that needs the grant is: ${client}.` : '';
  switch (state) {
    case 'no-calendar-account':
      return `${device} is not signed in to an Apple account (its Calendar reports no calendars), so it cannot hold your events. Sign in to the Apple account on that Mac (System Settings → Apple Account), or read the calendar from a Mac that is signed in.`;
    case 'calendar-never-requested': {
      const base = `${device} has never been granted Calendar access — macOS has no Calendars entry for the Digby agent yet, so an existing grant (e.g. to the "Digby" app) cannot reach it.`;
      const episode = consentCopy(consent);
      const head = `${base}${episode ? ` ${episode}` : ' No consent attempt has been recorded on that Mac yet.'}${clientNote}`;
      // The manual-toggle instruction below is only followable when the agent
      // actually ASKED: macOS mints the Calendars TCC row for a client when
      // that client requests access (the module premise this whole file rests
      // on), so a `bridge-failed`/`request-failed` episode means no request
      // reached macOS on that build and no row can exist to toggle. Measured
      // live 2026-11-06T18:19:55Z on example-tailnet-peer, agent 0.9.24 —
      // telling the owner to "enable the binary directly" there contradicts
      // the sentence it follows ("no Calendars entry … yet").
      const requestNeverIssued = consent?.state === 'bridge-failed' || consent?.state === 'request-failed';
      if (requestNeverIssued) {
        return `${head} macOS lists a client in Privacy & Security → Calendars only after that client asks it for access, and this request never reached macOS — so no row can appear for that binary and re-granting (or retrying) it cannot fix this. It is an agent-side defect, not a setting you can flip: Apple Calendar stays unavailable here until a fixed agent is installed on that Mac. Read the calendar from another signed-in Mac in the meantime.`;
      }
      return `${head} If no prompt appears, open System Settings → Privacy & Security → Calendars on ${device} and enable the Digby agent binary directly — the "Digby" app row is a DIFFERENT client.`;
    }
    case 'calendar-denied':
      return `Calendar access is switched OFF for the Digby agent on ${device}. Open System Settings → Privacy & Security → Calendars on that Mac and enable the agent binary (a "Digby" app row, if present, is a DIFFERENT client and does not grant the agent).${clientNote}`;
    case 'calendar-unreachable':
      return `Could not read the calendar on ${device} (the agent did not answer or EventKit failed). The Mac's calendar may be fine — retry, or check that the Digby agent is running on that Mac.`;
    case 'unsupported':
      return `${device} cannot read Apple Calendar (the Digby Mac agent needs 0.7.0+).`;
    case 'no-agent':
      return 'No paired Mac can read Apple Calendar right now.';
    case 'ok':
    default:
      return '';
  }
}

/** What the last consent episode OBSERVED, in one clause — or '' when no
 *  episode was ever recorded (older agent, or never attempted). Deliberately
 *  blunt about the difference between "asked" and "confirmed". */
export function consentCopy(c: AppleCalendarConsent | undefined): string {
  if (!c) return '';
  switch (c.state) {
    case 'granted':
      return `The last consent request (${c.at}) WAS granted on that Mac.`;
    case 'denied':
      return `The last consent request (${c.at}) was answered with a DENY on that Mac.`;
    case 'dialog-open':
      return `A consent request was issued at ${c.at} and had not returned when the agent stopped waiting — a macOS prompt may still be waiting on that Mac's screen.`;
    case 'dispatched':
      return `A consent request was issued at ${c.at} and macOS reported no decision afterwards (the access level is unchanged) — the prompt may have been dismissed, or macOS did not present it.`;
    case 'bridge-failed':
      return `A consent request was attempted at ${c.at} but macOS refused it (the agent could not issue the request) — approving a dialog is not possible from the agent; grant it by hand.`;
    case 'request-failed':
      return `The agent could not stage a consent request at ${c.at} (its own request plumbing failed).`;
    default:
      return '';
  }
}

/** A short `[device: X, via default]` prefix — every Apple Calendar answer
 *  names its source so a fallback is never mistaken for the named Mac. */
export function appleCalendarDeviceTag(read: AppleCalendarRead): string {
  if (!read.device) return '';
  const via = read.via === 'targeted' ? 'requested' : read.via === 'fallback' ? 'fallback' : read.via === 'default' ? 'default' : 'none';
  return `[device: ${read.device}${via !== 'none' ? `, via ${via}` : ''}]`;
}

/** Compact event lines for a prompt block (never used for an error state). */
export function appleCalendarEventsForPrompt(read: AppleCalendarRead, limit = 20): string {
  if (read.state !== 'ok' || !read.events) return '';
  if (read.events.length === 0) return `No Apple Calendar events on ${read.device}.`;
  const lines = read.events.slice(0, limit).map((e) => {
    const when = e.allDay
      ? `${(e.startDate || '').slice(0, 10)} (all day)`
      : `${e.startDate || '?'} → ${e.endDate || '?'}`;
    const where = e.location ? ` @ ${e.location}` : '';
    return `- ${e.title || '(untitled)'} — ${when}${where} [${e.calendar}]`;
  });
  return `Apple Calendar on ${read.device} (${read.events.length} event${read.events.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
}