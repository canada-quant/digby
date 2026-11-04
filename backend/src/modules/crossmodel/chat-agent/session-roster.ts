/**
 * SESSION ROSTER — dynamic roster phase 4 (roster 2026-10-06 D-1; docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §4 B.4:
 * "Session roster, persisted per chat: re-planned every turn with hysteresis (upgrade at once, drop at most one lane
 * per turn, keep the lead model stable for cache), so the team grows and shrinks with the conversation").
 *
 * What is stored — ONE context-store row per plain chat, [chatId, 'roster'] / 'session' (no migration):
 *   sessionLane  the lane the conversation is IN after hysteresis — the next turn's priorLane;
 *   last         the newest turn: the turn plan's lane (planLane — the classifier, null when it was silent), the lane
 *                the dispatch RAN (ranLane), the lane the turn turned out to NEED (needLane = the plan's lane, raised
 *                by a Dig-deeper rung or the lead's call_in), and the models that worked on it (lead / checker /
 *                colleagues / call_in);
 *   history      the last ROSTER_HISTORY_MAX turns (newest last), for readouts.
 *
 * Hysteresis (pure, nextSessionLane): a turn that needs MORE than the session lane raises it AT ONCE; a turn that
 * needs less lowers it by AT MOST ONE lane (research → checked → standard → quick). The input is the NEED lane, not the
 * ran lane: until the turn plan sets the checker (roster plan A2), every keyword-L2 turn RUNS a checker, and feeding
 * that into the session would shut the Quick lane out of every follow-up for the preset's sake, not the user's.
 *
 * Who reads it (chat-agent.service.ts, the roster seam):
 *   - the Quick-lane guard's priorLane (turn-plan.ts quickLaneEligibility: a follow-up in a checked / research session
 *     never takes Quick) — the session lane instead of the last answer's raw lane. The decision-model STATE keeps the
 *     legacy previous_answer_lane (the ask's text and inputs stay comparable with its calibration);
 *   - the per-turn model pick, through applyStickyLead: a switch away from the session's lead needs a margin
 *     (STICKY_LEAD_MARGIN) — swapping the lead mid-conversation throws away the provider's prompt cache.
 * Both only when the roster ACTS for the sender (platform/roster-config.ts: store mode 'act', or a canary user while
 * 'shadow'); in shadow the row is written and the would-be read recorded (loop_metrics session_roster).
 *
 * Kill switches: SESSION_ROSTER_DISABLED=1 (no read, no write — today's priorLane), SESSION_ROSTER_STICKY_LEAD_DISABLED=1
 * (the lane acts, the lead never sticks). Never throws; every I/O path fails open to today's behaviour.
 */

import type { Lane } from '../platform/turn-plan';
import { QUALITY_SLACK, SWITCH_MARGIN, frontierBlockedFromPick, type ModelPick, type RankedModel } from '../platform/model-pick';
import { DEFAULT_ROSTER_CONFIG, rosterConfig, type RosterConfig, type SessionRosterMode } from '../platform/roster-config';

export const LANE_ORDER: readonly Lane[] = ['quick', 'standard', 'checked', 'research'];
const RANK: Record<Lane, number> = { quick: 0, standard: 1, checked: 2, research: 3 };
const isLane = (v: unknown): v is Lane => typeof v === 'string' && (LANE_ORDER as readonly string[]).includes(v);

export const SESSION_ROSTER_KEY = 'session';
export const sessionRosterNamespace = (chatId: string): string[] => [chatId, 'roster'];
export const ROSTER_HISTORY_MAX = 6;
/** How long the turn may wait for the roster row before the turn plan fires without it. */
export const ROSTER_READ_TIMEOUT_MS = 300;
/** A switch away from the session's lead must beat it by this much more utility than a plain switch. */
export const STICKY_LEAD_MARGIN = SWITCH_MARGIN;

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};
export function sessionRosterDisabled(env: Record<string, string | undefined> = process.env): boolean { return onFlag(env.SESSION_ROSTER_DISABLED); }
export function stickyLeadDisabled(env: Record<string, string | undefined> = process.env): boolean { return onFlag(env.SESSION_ROSTER_STICKY_LEAD_DISABLED); }

// ── Lanes (pure) ─────────────────────────────────────────────────────────────

export function maxLane(...lanes: Array<Lane | null | undefined>): Lane {
  let best: Lane = 'quick';
  for (const l of lanes) if (l && RANK[l] > RANK[best]) best = l;
  return best;
}

/** Hysteresis: up at once, down at most one lane per turn. No prior ⇒ the need. Pure. */
export function nextSessionLane(prior: Lane | null | undefined, need: Lane): Lane {
  if (!prior || !isLane(prior)) return need;
  if (RANK[need] >= RANK[prior]) return need;
  return LANE_ORDER[Math.max(RANK[need], RANK[prior] - 1)];
}

/** The lane the dispatch ran: a council ⇒ research, a checker ⇒ checked, the Quick lane ⇒ quick, else standard. Pure. */
export function ranLaneOf(f: { quick: boolean; council: boolean; checker: boolean }): Lane {
  if (f.council) return 'research';
  if (f.checker) return 'checked';
  if (f.quick) return 'quick';
  return 'standard';
}

export type CallInRole = 'checker' | 'colleague';

/**
 * The lane the turn NEEDED: the turn plan's lane (the ran lane when the plan was silent), raised by a council that RAN
 * (Level 3 is reached only by an explicit research request, the user's Advanced preset or a Dig-deeper tap — a strong
 * intent signal, unlike the default Level 2 checker), by a Dig-deeper rung (verify ⇒ checked, research ⇒ research — the
 * user asked for more) and by a successful call_in (the lead found the question harder than it looked: a checker ⇒
 * checked, a research colleague ⇒ research). Pure.
 */
export function needLaneOf(f: { planLane: Lane | null; ranLane: Lane; escalationRung?: 'verify' | 'research' | null; callInRole?: CallInRole | null }): Lane {
  const rung: Lane | null = f.escalationRung === 'research' ? 'research' : f.escalationRung === 'verify' ? 'checked' : null;
  const callIn: Lane | null = f.callInRole === 'colleague' ? 'research' : f.callInRole === 'checker' ? 'checked' : null;
  const council: Lane | null = f.ranLane === 'research' ? 'research' : null;
  return maxLane(f.planLane ?? f.ranLane, council, rung, callIn);
}

// ── The record (pure) ────────────────────────────────────────────────────────

export interface SessionRosterTurn {
  at: string;
  messageId: string | null;
  planLane: Lane | null;
  ranLane: Lane;
  needLane: Lane;
  /** The session lane AFTER this turn. */
  sessionLane: Lane;
  lead: string | null;
  checker: string | null;
  colleagues: string[];
  callIn: { role: CallInRole; model: string; ok: boolean } | null;
  escalation?: 'verify' | 'research';
}

export interface SessionRoster {
  v: 1;
  sessionLane: Lane;
  turns: number;
  last: SessionRosterTurn;
  history: SessionRosterTurn[];
  updatedAt: string;
}

const str = (v: unknown, n = 200): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

function parseTurn(raw: unknown): SessionRosterTurn | null {
  const t = raw && typeof raw === 'object' ? (raw as Record<string, any>) : null;
  if (!t || !isLane(t.ranLane) || !isLane(t.needLane) || !isLane(t.sessionLane)) return null;
  const ci = t.callIn && typeof t.callIn === 'object' && (t.callIn.role === 'checker' || t.callIn.role === 'colleague') && str(t.callIn.model)
    ? { role: t.callIn.role as CallInRole, model: str(t.callIn.model)!, ok: t.callIn.ok === true }
    : null;
  return {
    at: str(t.at, 40) ?? new Date(0).toISOString(),
    messageId: str(t.messageId, 80),
    planLane: isLane(t.planLane) ? t.planLane : null,
    ranLane: t.ranLane,
    needLane: t.needLane,
    sessionLane: t.sessionLane,
    lead: str(t.lead),
    checker: str(t.checker),
    colleagues: Array.isArray(t.colleagues) ? t.colleagues.map((c: unknown) => str(c)).filter((c: string | null): c is string => !!c).slice(0, 6) : [],
    callIn: ci,
    ...(t.escalation === 'verify' || t.escalation === 'research' ? { escalation: t.escalation } : {}),
  };
}

/** A stored row → the roster, or null when it is absent / malformed (a bad row reads as no roster). Pure. */
export function parseSessionRoster(raw: unknown): SessionRoster | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, any>) : null;
  if (!r || r.v !== 1 || !isLane(r.sessionLane)) return null;
  const last = parseTurn(r.last);
  if (!last) return null;
  const history = (Array.isArray(r.history) ? r.history : []).map(parseTurn).filter((t: SessionRosterTurn | null): t is SessionRosterTurn => !!t).slice(-ROSTER_HISTORY_MAX);
  return { v: 1, sessionLane: r.sessionLane, turns: Number.isFinite(r.turns) && r.turns > 0 ? Math.floor(r.turns) : history.length || 1, last, history, updatedAt: str(r.updatedAt, 40) ?? last.at };
}

export type RosterTurnInput = Omit<SessionRosterTurn, 'sessionLane' | 'needLane' | 'at'> & { escalationRung?: 'verify' | 'research' | null; at?: string };

/** Fold one turn into the roster (pure): need lane → hysteresis → newest turn + bounded history. */
export function applyRosterTurn(prior: SessionRoster | null, input: RosterTurnInput, now: Date = new Date()): SessionRoster {
  const needLane = needLaneOf({ planLane: input.planLane, ranLane: input.ranLane, escalationRung: input.escalationRung ?? null, callInRole: input.callIn?.ok ? input.callIn.role : null });
  const sessionLane = nextSessionLane(prior?.sessionLane ?? null, needLane);
  const { escalationRung, at, ...rest } = input;
  const turn: SessionRosterTurn = {
    ...rest,
    at: at ?? now.toISOString(),
    needLane,
    sessionLane,
    colleagues: [...new Set(input.colleagues ?? [])].slice(0, 6),
    ...(escalationRung ? { escalation: escalationRung } : {}),
  };
  const history = [...(prior?.history ?? []), turn].slice(-ROSTER_HISTORY_MAX);
  return { v: 1, sessionLane, turns: (prior?.turns ?? 0) + 1, last: turn, history, updatedAt: now.toISOString() };
}

// ── Reading for a turn ───────────────────────────────────────────────────────

export interface RosterRead {
  mode: SessionRosterMode;
  /** The roster governs this turn (store mode act, or a canary user while shadow). */
  acts: boolean;
  roster: SessionRoster | null;
}

export const ROSTER_OFF: RosterRead = Object.freeze({ mode: 'off', acts: false, roster: null }) as RosterRead;

export interface RosterIo {
  config: () => Promise<RosterConfig>;
  get: (ns: string[], key: string) => Promise<unknown>;
  put: (ns: string[], key: string, value: Record<string, unknown>) => Promise<void>;
}

const defaultIo: RosterIo = {
  config: () => rosterConfig(),
  get: async (ns, key) => (await import('../memory/context-store')).storeGet<unknown>(ns, key),
  put: async (ns, key, value) => (await import('../memory/context-store')).storePut(ns, key, value),
};

/** Whether the roster ACTS for this sender under a config (pure). */
export function rosterActsFor(config: RosterConfig, userId: string | null | undefined): boolean {
  if (config.sessionRoster === 'act') return true;
  return config.sessionRoster === 'shadow' && !!userId && config.canary.has(userId);
}

/** The roster for this turn — bounded by ROSTER_READ_TIMEOUT_MS; off / disabled / error ⇒ ROSTER_OFF-like (never throws). */
export async function readSessionRosterForTurn(chatId: string | null | undefined, userId: string | null | undefined, io: RosterIo = defaultIo): Promise<RosterRead> {
  if (!chatId || !userId || sessionRosterDisabled()) return ROSTER_OFF;
  try {
    const config = await io.config().catch(() => DEFAULT_ROSTER_CONFIG);
    if (config.sessionRoster === 'off') return ROSTER_OFF;
    const acts = rosterActsFor(config, userId);
    const TIMED_OUT = Symbol('roster-timeout');
    const raw = await Promise.race([
      io.get(sessionRosterNamespace(chatId), SESSION_ROSTER_KEY),
      new Promise<typeof TIMED_OUT>((res) => setTimeout(() => res(TIMED_OUT), ROSTER_READ_TIMEOUT_MS).unref?.()),
    ]);
    return { mode: config.sessionRoster, acts, roster: raw === TIMED_OUT ? null : parseSessionRoster(raw) };
  } catch {
    return ROSTER_OFF;
  }
}

/** The lane the Quick guard reads: the session lane when the roster acts and has one, else the legacy priorLane. Pure. */
export function guardPriorLane(read: RosterRead | null | undefined, legacy: Lane | null): { lane: Lane | null; source: 'roster' | 'legacy' } {
  if (read?.acts && read.roster) return { lane: read.roster.sessionLane, source: 'roster' };
  return { lane: legacy, source: 'legacy' };
}

/** Read-modify-write ONE turn (never throws; returns the stored roster, or null when off / failed). */
export async function saveSessionRosterTurn(chatId: string, input: RosterTurnInput, io: RosterIo = defaultIo, now: Date = new Date()): Promise<{ prior: SessionRoster | null; next: SessionRoster } | null> {
  if (!chatId || sessionRosterDisabled()) return null;
  try {
    const config = await io.config().catch(() => DEFAULT_ROSTER_CONFIG);
    if (config.sessionRoster === 'off') return null;
    const ns = sessionRosterNamespace(chatId);
    const prior = parseSessionRoster(await io.get(ns, SESSION_ROSTER_KEY).catch(() => null));
    const next = applyRosterTurn(prior, input, now);
    await io.put(ns, SESSION_ROSTER_KEY, next as unknown as Record<string, unknown>);
    return { prior, next };
  } catch {
    return null;
  }
}

// ── Lead stickiness (pure) ───────────────────────────────────────────────────

/** 'dropped_frontier' (owner 2026-10-06 late): the persisted session lead was a frontier-class model — never kept. */
export type StickyOutcome = 'kept_seat' | 'kept_prior' | 'dropped_frontier' | null;

/**
 * Keep the session's lead when the pick would swap it for a model only marginally better (prompt cache, a steady
 * voice). Applies only when the pick SWITCHES away from the seat (pick.changed):
 *   - the prior lead is the seat ⇒ the seat stays unless the pick beats it by SWITCH_MARGIN + margin;
 *   - the prior lead is another ranked candidate that would itself be a valid switch (beats the seat by SWITCH_MARGIN,
 *     quality within QUALITY_SLACK of the pick's) ⇒ it stays unless the pick beats it by `margin`.
 * A persisted FRONTIER-class lead that is not the seat (a pick made under the retired C-1 "any and all models" rule)
 * is DROPPED — never kept, whatever the margin (owner 2026-10-06 late: "pickers should never choose frontier"); the
 * pick stands and the outcome reads 'dropped_frontier'. The admin's own seat is never dropped (a seat is not a pick).
 * Anything else (an unranked / unmeasured prior, the pick already IS the prior) leaves the pick alone. Pure over env.
 */
export function applyStickyLead(pick: ModelPick, priorLead: string | null | undefined, margin: number = STICKY_LEAD_MARGIN, env: Record<string, string | undefined> = process.env): { pick: ModelPick; stuck: StickyOutcome } {
  if (priorLead && priorLead !== pick.seat && frontierBlockedFromPick({ spec: priorLead }, env)) return { pick, stuck: 'dropped_frontier' };
  if (!priorLead || !pick.changed || priorLead === pick.spec || pick.seatUtility === null) return { pick, stuck: null };
  const best: RankedModel | undefined = pick.ranked.find((r) => r.spec === pick.spec);
  if (!best) return { pick, stuck: null };
  if (priorLead === pick.seat) {
    // The pick's own switch margin (a kind-keyed pick's is wider than SWITCH_MARGIN) plus the stickiness.
    const keep = (best.margin ?? SWITCH_MARGIN) + margin;
    if (best.utility - pick.seatUtility < keep) {
      return {
        pick: { ...pick, spec: pick.seat, changed: false, expectedTtftMs: null, reason: `session lead ${pick.seat} kept — ${pick.spec} (u ${best.utility.toFixed(2)}) is within ${keep.toFixed(2)} of it (u ${pick.seatUtility.toFixed(2)}); ${pick.reason}`.slice(0, 400) },
        stuck: 'kept_seat',
      };
    }
    return { pick, stuck: null };
  }
  const prior = pick.ranked.find((r) => r.spec === priorLead);
  if (!prior) return { pick, stuck: null };
  const validOnItsOwn = prior.utility - pick.seatUtility >= (prior.margin ?? SWITCH_MARGIN)
    && (prior.quality === null || best.quality === null || prior.quality >= best.quality - QUALITY_SLACK);
  if (validOnItsOwn && best.utility - prior.utility < margin) {
    return {
      pick: { ...pick, spec: prior.spec, changed: true, expectedTtftMs: prior.ttftP50Ms, reason: `session lead ${prior.spec} kept (u ${prior.utility.toFixed(2)}) — ${pick.spec} (u ${best.utility.toFixed(2)}) is within ${margin.toFixed(2)}; ${pick.reason}`.slice(0, 400) },
      stuck: 'kept_prior',
    };
  }
  return { pick, stuck: null };
}

// ── The turn's trace (what the seam read / did) + its telemetry (pure) ───────

export interface RosterTrace {
  read: RosterRead | null;
  /** The last answer's own lane (turn-plan-labels turnPlanFromMetadata) — what the guard read before the roster. */
  legacyPriorLane: Lane | null;
  /** What the Quick guard actually read this turn. */
  priorLaneRead: Lane | null;
  source: 'roster' | 'legacy' | null;
  sticky: StickyOutcome;
}

export function newRosterTrace(): RosterTrace {
  return { read: null, legacyPriorLane: null, priorLaneRead: null, source: null, sticky: null };
}

/** The compact record persisted on the answer row (metadata.depth.roster), or null when the roster is off. Pure. */
export function rosterDepthRecord(trace: RosterTrace): Record<string, unknown> | null {
  if (!trace.read || trace.read.mode === 'off') return null;
  return {
    mode: trace.read.mode,
    acts: trace.read.acts,
    ...(trace.source ? { priorLane: trace.priorLaneRead, source: trace.source } : {}),
    ...(trace.read.roster ? { sessionLaneBefore: trace.read.roster.sessionLane } : {}),
    ...(trace.sticky ? { sticky: trace.sticky } : {}),
  };
}

/** The loop_metrics `session_roster` row's meta for one saved turn. Pure. */
export function sessionRosterMetricMeta(chatId: string, saved: { prior: SessionRoster | null; next: SessionRoster }, trace: RosterTrace): Record<string, unknown> {
  const t = saved.next.last;
  return {
    chatId,
    planLane: t.planLane, ranLane: t.ranLane, needLane: t.needLane,
    sessionLanePrev: saved.prior?.sessionLane ?? null, sessionLane: saved.next.sessionLane,
    changed: (saved.prior?.sessionLane ?? null) !== saved.next.sessionLane,
    lead: t.lead, checker: t.checker, colleagues: t.colleagues,
    ...(t.callIn ? { callIn: t.callIn } : {}),
    ...(t.escalation ? { escalation: t.escalation } : {}),
    turns: saved.next.turns,
    mode: trace.read?.mode ?? null,
    acts: trace.read?.acts === true,
    priorLaneRead: trace.priorLaneRead, legacyPriorLane: trace.legacyPriorLane,
    rosterPriorLane: trace.read?.roster?.sessionLane ?? null,
    ...(trace.source ? { priorLaneSource: trace.source } : {}),
    ...(trace.sticky ? { sticky: trace.sticky } : {}),
  };
}
