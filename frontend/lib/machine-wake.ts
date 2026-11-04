/**
 * Machine-wake envelope classification (Fleet Supervisor UX overhaul Phase C —
 * goal 49dd1b20 / todo 9cf23892).
 *
 * Machine-triggered wakes (schedule firings, hook wakes, webhook fires) persist
 * as USER-role rows whose content begins with the literal WAKE_PREFIX below
 * (baked by the backend's machineWakePreamble() —
 * backend/src/modules/crossmodel/chat-agent/machine-wake.ts). The preamble +
 * [FRESHNESS CONTRACT + optional [SUPERVISOR STATE block + payload are all in
 * the ONE persisted content string, so hook/schedule-heavy chats fill with
 * 100+-line envelopes that bury the real conversation.
 *
 * Phase C COLLAPSES these rows to a one-line expandable summary in the UI
 * (presentation-layer only — zero data loss, persistence untouched). A previous
 * attempt FILTERED them and hid real owner messages (2026-08-26 regression) —
 * the rules below are therefore deliberately conservative:
 *
 *  - Interactive UI sends carry NO metadata.origin, and the legacy view's
 *    mapStoredMessages rebuilds metadata with a pick-list that DROPS origin —
 *    so classification is content-prefix-based first. Absent metadata ⇒ human,
 *    always visible.
 *  - The prefix must be at position 0 of a USER row — an assistant note that
 *    quotes an envelope, or a human pasting the prefix mid-sentence, is NOT a
 *    machine wake.
 *
 * Pure functions, no imports — mirrors the repo's lib-test idiom (vitest, node
 * environment) and the backend machine-wake.ts leaf-module pattern.
 */

/**
 * Byte-identical with the start of the backend preamble
 * (backend/src/modules/crossmodel/chat-agent/machine-wake.ts
 * machineWakePreamble()). If the backend preamble's first line ever changes,
 * this MUST change with it or machine rows silently revert to full bubbles.
 */
export const WAKE_PREFIX = '[MACHINE-TRIGGERED RUN';

/** Origins the backend stamps on machine-triggered sends (interactive sends
 *  carry none). Used only as a SECONDARY signal for future envelope shapes
 *  whose content might not start with WAKE_PREFIX — never required. */
const MACHINE_ORIGINS = ['schedule', 'hook', 'webhook'];

/**
 * True iff the message is a machine-wake envelope:
 *   (a) a USER row whose content STARTS with WAKE_PREFIX, OR
 *   (b) a USER row whose metadata.origin is schedule/hook/webhook
 *       (future envelope shapes).
 * NEVER true otherwise: assistant rows (even with the prefix), origins
 * 'agent'/'user', absent metadata, content merely CONTAINING the prefix
 * mid-string, or empty/undefined content all classify as human ⇒ visible.
 */
export function isMachineWakeEnvelope(msg: {
  role?: string;
  content?: string | null;
  metadata?: any;
}): boolean {
  if (!msg || msg.role !== 'user') return false;
  if (typeof msg.content === 'string' && msg.content.startsWith(WAKE_PREFIX)) {
    return true;
  }
  return MACHINE_ORIGINS.includes(msg.metadata?.origin);
}

/**
 * Best-effort one-line summary of a wake envelope for the collapsed row.
 * Fields that aren't found are omitted (undefined) — never fabricated.
 */
export function summarizeWakeEnvelope(content: string): {
  eventType?: string;
  sourceTitle?: string;
  hasStateBlock: boolean;
} {
  const eventMatch = content.match(
    /\b(run_completed|run_failed|attention_needed|goal_blocked|todo_done|schedule_cap_skipped|schedule_disabled|schedule_near_cap)\b/
  );
  const titleMatch = content.match(/(?:from|chat|source)\s+['"]([^'"]{1,80})['"]/i);
  return {
    eventType: eventMatch?.[1],
    sourceTitle: titleMatch?.[1],
    hasStateBlock: content.includes('[SUPERVISOR STATE'),
  };
}

/* ── System-row classification (feedback 4959bb1c) ───────────────────────────
 * Phase C covered only machine WAKES. The same wall-of-text problem applies to
 * the rest of the machine traffic: inter-agent send_chat_message relays
 * (metadata.origin 'agent' — no WAKE_PREFIX, so they render as owner bubbles
 * indistinguishable from the human typing) and harness/system rows
 * ('machine', 'attention-watchdog', 'orphan-recovery', 'heartbeat'). The owner
 * asked for these to collapse the same way in BOTH chat UIs.
 *
 * Same conservative discipline as isMachineWakeEnvelope: a row classifies as a
 * system row ONLY on an explicit machine signal (prefix at position 0 or a
 * known machine origin). 'user'/absent/unknown origins are human ⇒ visible.
 */

/** origin 'agent' = another agent/session speaking to this chat (send_chat_message). */
const AGENT_ORIGIN = 'agent';
/** Harness/system origins that are never the owner typing. */
const SYSTEM_ORIGINS = ['machine', 'attention-watchdog', 'orphan-recovery', 'heartbeat'];

/**
 * Position-0 literal of the agent-send provenance header (hardening review
 * 2026-09-14 — backend/src/modules/crossmodel/platform/agent-send-header.ts
 * AGENT_SEND_PREFIX): '[AGENT-SENT MESSAGE — from chat "<title>" (<id8>),
 * another Digby agent, NOT the owner. …]'. Byte-identical with the backend
 * literal — a USER row starting with it is an inter-agent relay even when
 * the origin stamp was dropped by a metadata pick-list.
 */
export const AGENT_SEND_PREFIX = '[AGENT-SENT MESSAGE';

/** True iff a USER row's content starts with the agent-send provenance header. */
export function hasAgentSendHeader(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith(AGENT_SEND_PREFIX);
}

export interface AgentSendHeader {
  /** True iff the header was present at position 0. */
  hasHeader: boolean;
  /** Sender chat title from `from chat "<title>"` (undefined when absent). */
  title?: string;
  /** The 8-char sender chat id prefix from `(<id8>)` (undefined when absent). */
  id8?: string;
  /** The content with the header line (and its trailing blank line) removed. */
  body: string;
}

/**
 * Parse the agent-send header off a relay row: sender title + id8 for the
 * card header, body for the card. Mirrors the backend's stripAgentSendHeader
 * regex (one bracketed line, no inner ']' or newline). Never fabricates — a
 * row without the header returns {hasHeader:false, body: content}.
 */
export function parseAgentSendHeader(content: string | null | undefined): AgentSendHeader {
  const c = typeof content === 'string' ? content : '';
  const m = c.match(/^\[AGENT-SENT MESSAGE — ([^\]\n]*)\]\s*/);
  if (!m) return { hasHeader: false, body: c };
  const from = m[1];
  const t = from.match(/from chat "([^"]*)"(?:\s*\(([^)\s]{1,8})\))?/);
  const title = t?.[1]?.trim();
  const id8 = t?.[2];
  return {
    hasHeader: true,
    ...(title ? { title } : {}),
    ...(id8 ? { id8 } : {}),
    body: c.slice(m[0].length),
  };
}

/**
 * Machine STAMP origins for rows of ANY role — byte-parity with the backend's
 * noise set (backend/src/modules/crossmodel/fleet/fleet.service.ts
 * MACHINE_ORIGINS, :125): the set the fleet thread's retro-classifier uses to
 * mark noise rows, assistant rows included. Deliberately NARROWER than
 * SYSTEM_ORIGINS: an 'attention-watchdog'/'orphan-recovery'/'heartbeat' stamp
 * on an ASSISTANT row is a notice the backend keeps visible (noise=false), so
 * the frontend must not collapse it either. If the backend set changes, this
 * MUST change with it or the two surfaces diverge on the same row.
 */
export const MACHINE_STAMP_ORIGINS = ['schedule', 'hook', 'machine', 'agent', 'webhook'] as const;

/** True iff origin is a backend machine noise stamp (any role). */
export function isMachineStampOrigin(origin: unknown): boolean {
  return typeof origin === 'string' && (MACHINE_STAMP_ORIGINS as readonly string[]).includes(origin);
}

export type SystemRowKind = 'wake' | 'agent' | 'system';

/**
 * Classify a message row for system-row rendering:
 *   'wake'   — machine-wake envelope (schedule/hook/webhook; same rule as
 *              isMachineWakeEnvelope, kept byte-compatible),
 *   'agent'  — inter-agent relay (origin 'agent'),
 *   'system' — other harness machine rows (action-verifier notices, the
 *              attention watchdog, orphan recovery, heartbeats),
 *   null     — a human (or assistant) row: render normally, always visible.
 */
export function classifySystemRow(msg: {
  role?: string;
  content?: string | null;
  metadata?: any;
}): SystemRowKind | null {
  if (!msg || msg.role !== 'user') return null;
  if (isMachineWakeEnvelope(msg)) return 'wake';
  const origin = msg.metadata?.origin;
  if (origin === AGENT_ORIGIN) return 'agent';
  // Provenance header at position 0 (2026-09-14): the relay classifies even
  // when the origin stamp did not survive a metadata pick-list — these rows
  // otherwise render as the OWNER's bubble (the owner's screenshots).
  if (hasAgentSendHeader(msg.content)) return 'agent';
  if (SYSTEM_ORIGINS.includes(origin)) return 'system';
  return null;
}

/* ── Assistant-side machine cards (owner ask 2026-09-14) ──────────────────────
 * Two harness-authored ASSISTANT row shapes render today as walls of text:
 *   owner-inbox   — platform/owner-questions.ts + pending-confirmations.ts post
 *                   `[Owner inbox] …` notes with metadata.origin 'owner-inbox'
 *                   (the Fleet Supervisor / owner answered a lane's flagged
 *                   question; auto-resolutions; dismissals);
 *   project_status — the per-project supervisor's status row (SHARED CONTRACT:
 *                   metadata { origin:'project_status', kind:'project_status',
 *                   generatedAt, since, status:{…} } + a plain-language
 *                   Markdown body).
 * Same conservative discipline: classify ONLY on the explicit stamp or the
 * exact position-0 prefix; anything else is a normal assistant reply.
 */

export const OWNER_INBOX_ORIGIN = 'owner-inbox';
export const OWNER_INBOX_PREFIX = '[Owner inbox]';
export const PROJECT_STATUS_ORIGIN = 'project_status';
/** Per-SESSION status card (owner ask 2026-09-15) — same contract shape, session facts. */
export const SESSION_STATUS_ORIGIN = 'session_status';

export type AssistantCardKind = 'owner-inbox' | 'project-status' | 'session-status';

/** True iff an ASSISTANT row is an owner-inbox note (stamp OR position-0 prefix). */
export function isOwnerInboxRow(msg: { role?: string; content?: string | null; metadata?: any }): boolean {
  if (!msg || msg.role !== 'assistant') return false;
  if (msg.metadata?.origin === OWNER_INBOX_ORIGIN) return true;
  return typeof msg.content === 'string' && msg.content.startsWith(OWNER_INBOX_PREFIX);
}

/** True iff an ASSISTANT row is a project-status row (origin or kind stamp). */
export function isProjectStatusRow(msg: { role?: string; content?: string | null; metadata?: any }): boolean {
  if (!msg || msg.role !== 'assistant') return false;
  return msg.metadata?.origin === PROJECT_STATUS_ORIGIN || msg.metadata?.kind === PROJECT_STATUS_ORIGIN;
}

/** Which card (if any) an assistant row renders as — null ⇒ ordinary markdown reply. */
export function isSessionStatusRow(msg: { role?: string; content?: string | null; metadata?: any }): boolean {
  if (!msg || msg.role !== 'assistant') return false;
  return msg.metadata?.origin === SESSION_STATUS_ORIGIN || msg.metadata?.kind === SESSION_STATUS_ORIGIN;
}

/** Either harness status card — the rows the machine-turn grouping must keep VISIBLE. */
export function isStatusCardRow(msg: { role?: string; content?: string | null; metadata?: any }): boolean {
  return isProjectStatusRow(msg) || isSessionStatusRow(msg);
}

export function classifyAssistantCard(msg: { role?: string; content?: string | null; metadata?: any }): AssistantCardKind | null {
  if (isProjectStatusRow(msg)) return 'project-status';
  if (isSessionStatusRow(msg)) return 'session-status';
  if (isOwnerInboxRow(msg)) return 'owner-inbox';
  return null;
}

export interface OwnerInboxNote {
  /** Card title: "Owner inbox — the Fleet Supervisor answered a lane's question" or the row's first clause. */
  title: string;
  /** The first clause after the prefix (before the first " — "), verbatim. */
  lead: string;
  question?: string;
  answer?: string;
  answeredBy?: string;
  /** "Answered by X under Y" — the Y part. */
  under?: string;
  rationale?: string;
  /** A trailing "(auto-resolved: …)" parenthetical. */
  note?: string;
  /** The content with the prefix removed, verbatim (the "full text" fallback). */
  rest: string;
}

const FLEET_SUPERVISOR_TITLE = "Owner inbox — the Fleet Supervisor answered a lane's question";

/**
 * Parse an `[Owner inbox] …` note into labelled parts. Every field is best-
 * effort and omitted when not found — never fabricated. Shapes (backend
 * owner-questions.ts / pending-confirmations.ts):
 *   [Owner inbox] <lead> — Q: "…" A: "…"
 *   [Owner inbox] <lead> — Q: "…" A: "…" (auto-resolved: …)
 *   [Owner inbox] The owner dismissed this flagged question — stop raising it: "…"
 *   [Owner inbox] Auto-resolved … — because …
 *   … Answered by <who> under <what>. Rationale: <why>
 */
export function parseOwnerInboxNote(content: string | null | undefined): OwnerInboxNote {
  const c = typeof content === 'string' ? content : '';
  const rest = c.startsWith(OWNER_INBOX_PREFIX) ? c.slice(OWNER_INBOX_PREFIX.length).trim() : c.trim();
  const firstLine = rest.split('\n')[0] ?? '';
  const dash = firstLine.indexOf(' — ');
  const lead = (dash >= 0 ? firstLine.slice(0, dash) : firstLine).trim();
  const title = /Fleet Supervisor answered/i.test(lead)
    ? FLEET_SUPERVISOR_TITLE
    : lead ? `Owner inbox — ${lead}` : 'Owner inbox';

  const out: OwnerInboxNote = { title, lead, rest };
  const STOP = String.raw`(?=\s*(?:A:|Answered by\b|Rationale:|\(auto-resolved|$))`;
  const q = rest.match(new RegExp(String.raw`\bQ:\s*"([\s\S]*?)"` + STOP));
  if (q?.[1]?.trim()) out.question = q[1].trim();
  else {
    const dismissed = rest.match(/stop raising it:\s*"([\s\S]*?)"\s*$/);
    if (dismissed?.[1]?.trim()) out.question = dismissed[1].trim();
  }
  const a = rest.match(new RegExp(String.raw`\bA:\s*"([\s\S]*?)"` + String.raw`(?=\s*(?:Answered by\b|Rationale:|\(auto-resolved|$))`));
  if (a?.[1]?.trim()) out.answer = a[1].trim();

  const abIdx = rest.search(/\bAnswered by\s+/);
  if (abIdx >= 0) {
    let seg = rest.slice(abIdx).replace(/^Answered by\s+/, '');
    const cut = seg.search(/\n|\s+Rationale:|\s+—\s|\.\s|\.$/);
    if (cut >= 0) seg = seg.slice(0, cut);
    const under = seg.match(/^(.*?)\s+under\s+(.+)$/);
    if (under) { out.answeredBy = under[1].trim(); out.under = under[2].trim(); }
    else if (seg.trim()) out.answeredBy = seg.trim();
  }
  const r = rest.match(/\bRationale:\s*([\s\S]*?)\s*$/);
  if (r?.[1]?.trim()) out.rationale = r[1].trim();
  const n = rest.match(/\((auto-resolved:[^)]*)\)/);
  if (n?.[1]) out.note = n[1].trim();
  return out;
}

export interface ProjectStatusCounters {
  goals?: { active?: number; done?: number; blocked?: number };
  todos?: { inProgress?: number; pending?: number; blocked?: number; doneSince?: number };
  /** Lanes with a RUNNING agent_run. */
  lanesRunning?: number;
  /** 2026-09-24 (owner: "Lanes 3 running" / "Three work sessions are still
   *  running … but no active work item" while nothing ran): lanes that only
   *  hold an ENABLED coding_schedule, counted apart from lanesRunning so the
   *  counters never call a scheduled lane "running". Additive metadata — rows
   *  older than the split carry none (see normalizeProjectStatus for how those
   *  are reconciled against the measured timing lanes). */
  lanesScheduled?: number;
  ownerItems?: number;
  /** Session-card counters (origin session_status, 2026-09-15). */
  plan?: { done?: number; total?: number; blocked?: number };
  runs?: { completed?: number; failed?: number; running?: number };
  /** Pull requests in the window (session_status origin). `merged` / `docsOnly` are the additive fields the backend ships since the docs-churn work (2026-09-27); the card renders them since 2026-09-28. */
  prs?: { opened?: number; merged?: number; docsOnly?: number };
  spendUsd?: number;
}

/** Owner 2026-09-17: harness-measured timing that rides metadata.status.timing
 *  (durations, next wakes, reported progress fractions, rate-based estimates).
 *  Every field is optional on the wire — old cards have none. */
export interface ProjectTimingLaneData {
  chatId?: string;
  title: string;
  state: 'running' | 'scheduled';
  runningForMin?: number;
  lastActivityMin?: number;
  nextWakeAt?: string;
  progress?: { done: number; total: number; label?: string; stalled?: boolean };
  eta?: { minutes: number; confidence?: string };
}
export interface ProjectTimingData {
  lanes: ProjectTimingLaneData[];
  goals: Array<{ id?: string; title: string; status?: string; done: number; total: number }>;
  closures: string[];
  nextCheckAt?: string;
  nextStatusAt?: string;
  noEstimateReason?: string;
}

/**
 * 2026-09-24 older-row lane reconciliation (see normalizeProjectStatus): the
 * counts the measured timing lanes proved, stamped ONLY when they CHANGED the
 * wire's pre-split lanesRunning. Rows from the fixed backend (lanesScheduled
 * present) never carry it, so their headline and brief pass through untouched.
 */
export interface LaneReconciliation { running: number; scheduled: number }

export interface ProjectStatusData extends ProjectStatusCounters {
  projectName?: string;
  /** Session card: the coding session's title. */
  sessionTitle?: string;
  headline: string;
  workingOn: string[];
  doneSince: string[];
  blocked: string[];
  next: string[];
  timing?: ProjectTimingData;
  /** Set when the older-row reconciliation changed the lane counts (the
   *  headline was rewritten to match; the card hands it to the brief). */
  lanesReconciled?: LaneReconciliation;
}

const pluralN = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * 2026-09-24 (review C15): when the reconciliation changes the counts, the
 * headline's lane clause ("5 lanes working") must move with them or the
 * headline contradicts the counters row under it. running → 0 ⇒
 * "<M> lanes scheduled, none running" (the fixed backend's own wording);
 * otherwise "<N> lanes working, <M> scheduled". A headline without the clause
 * is returned untouched. Pure.
 */
export function reconcileHeadlineLanes(headline: string, r: LaneReconciliation): string {
  return headline.replace(/\b\d+ lanes? working\b/, () => (
    r.running === 0
      ? `${pluralN(r.scheduled, 'lane')} scheduled, none running`
      : `${pluralN(r.running, 'lane')} working${r.scheduled > 0 ? `, ${r.scheduled} scheduled` : ''}`
  ));
}

/** The brief.now sentence an older row wrote from the pre-split count. */
const BRIEF_NOW_RUNNING_RE = /\d+ work sessions? (?:is|are) running/;

/**
 * 2026-09-24 (review C15): an older brief's "3 work sessions are running"
 * sentence is dropped when the lanes reconciled to NONE running, replaced by
 * "Nothing is running right now; <M> sessions are scheduled to wake later."
 * (the truth the counters now show). Untouched when nothing reconciled, when
 * something still runs, or when no sentence matches. Pure.
 */
export function reconcileBriefNow(now: string | undefined, r: LaneReconciliation | undefined): string | undefined {
  if (!now || !r || r.running !== 0) return now;
  const sentences = now.split(/(?<=[.!?])\s+/);
  if (!sentences.some((s) => BRIEF_NOW_RUNNING_RE.test(s))) return now;
  const replacement = r.scheduled > 0
    ? `Nothing is running right now; ${pluralN(r.scheduled, 'session')} ${r.scheduled === 1 ? 'is' : 'are'} scheduled to wake later.`
    : 'Nothing is running right now.';
  const out: string[] = [];
  let replaced = false;
  for (const s of sentences) {
    if (BRIEF_NOW_RUNNING_RE.test(s)) {
      if (!replaced) { out.push(replacement); replaced = true; }
      continue;
    }
    out.push(s);
  }
  return out.join(' ');
}

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Byte-parity with the backend's TIMING_MAX_LANES
 * (backend/src/modules/crossmodel/fleet/project-status.service.ts): the
 * timing strip lists at most this many lanes, running ones first. A lane list
 * SHORTER than this is complete. If the backend cap changes, this MUST change
 * with it or the older-row lane reconciliation in normalizeProjectStatus
 * mis-counts.
 */
export const TIMING_LANES_CAP = 6;

/** Defensive parse of metadata.status.timing — undefined unless it carries at least one renderable part. */
export function normalizeProjectTiming(v: unknown): ProjectTimingData | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = v as Record<string, any>;
  const lanes: ProjectTimingLaneData[] = Array.isArray(t.lanes)
    ? t.lanes.flatMap((l: any) => {
      const title = asStr(l?.title);
      const state = l?.state === 'running' || l?.state === 'scheduled' ? l.state : undefined;
      if (!title || !state) return [];
      const pd = l.progress && typeof l.progress === 'object' ? l.progress : null;
      const progress = pd && typeof pd.done === 'number' && typeof pd.total === 'number' && pd.total > 0 && pd.done >= 0
        ? { done: pd.done, total: pd.total, ...(asStr(pd.label) ? { label: asStr(pd.label) } : {}), ...(pd.stalled === true ? { stalled: true } : {}) }
        : undefined;
      const eta = l.eta && typeof l.eta === 'object' && typeof l.eta.minutes === 'number' && l.eta.minutes >= 0
        ? { minutes: l.eta.minutes, ...(asStr(l.eta.confidence) ? { confidence: asStr(l.eta.confidence) } : {}) }
        : undefined;
      const lane: ProjectTimingLaneData = { title, state };
      if (asStr(l.chatId)) lane.chatId = asStr(l.chatId);
      if (typeof l.runningForMin === 'number' && l.runningForMin >= 0) lane.runningForMin = l.runningForMin;
      if (typeof l.lastActivityMin === 'number' && l.lastActivityMin >= 0) lane.lastActivityMin = l.lastActivityMin;
      if (asStr(l.nextWakeAt)) lane.nextWakeAt = asStr(l.nextWakeAt);
      if (progress) lane.progress = progress;
      if (eta) lane.eta = eta;
      return [lane];
    })
    : [];
  const goals = Array.isArray(t.goals)
    ? t.goals.flatMap((g: any) => {
      const title = asStr(g?.title);
      if (!title || typeof g.done !== 'number' || typeof g.total !== 'number' || g.total <= 0) return [];
      return [{ title, done: g.done, total: g.total, ...(asStr(g.id) ? { id: asStr(g.id) } : {}), ...(asStr(g.status) ? { status: asStr(g.status) } : {}) }];
    })
    : [];
  const closures = Array.isArray(t.closures) ? t.closures.filter((c: unknown): c is string => typeof c === 'string') : [];
  const out: ProjectTimingData = { lanes, goals, closures };
  if (asStr(t.nextCheckAt)) out.nextCheckAt = asStr(t.nextCheckAt);
  if (asStr(t.nextStatusAt)) out.nextStatusAt = asStr(t.nextStatusAt);
  if (asStr(t.noEstimateReason)) out.noEstimateReason = asStr(t.noEstimateReason);
  return lanes.length || goals.length || closures.length || out.nextStatusAt || out.noEstimateReason ? out : undefined;
}

type StatusSectionKey = 'workingOn' | 'doneSince' | 'blocked' | 'next';

/** Map a heading line to a contract section (case-insensitive, markup-stripped). */
function statusSectionOf(line: string): StatusSectionKey | null {
  const t = line.replace(/^[#>\s*_-]+/, '').replace(/[*_:]+\s*$/, '').trim().toLowerCase();
  if (!t || t.length > 40) return null;
  if (/^working on\b/.test(t)) return 'workingOn';
  if (/^done\b/.test(t)) return 'doneSince';
  if (/^blocked\b|^needs you\b/.test(t)) return 'blocked';
  if (/^next\b/.test(t)) return 'next';
  return null;
}

/** Strip list markers + emphasis for a status line (display-label only). */
function statusItemText(line: string): string {
  return line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/^_+|_+$/g, '').trim();
}

/**
 * Fallback parser for a project-status Markdown body (headline line, then
 * "Working on / Done in the last hour / Blocked or needs you / Next"
 * sections) — used when metadata.status is absent. Counters only ever come
 * from metadata (never guessed from prose).
 */
export function parseProjectStatusMarkdown(content: string | null | undefined): ProjectStatusData {
  const out: ProjectStatusData = { headline: '', workingOn: [], doneSince: [], blocked: [], next: [] };
  const lines = (typeof content === 'string' ? content : '').split('\n');
  let section: StatusSectionKey | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const sec = statusSectionOf(line);
    if (sec) { section = sec; continue; }
    if (section) {
      if (/^(?:[-*•]|\d+[.)])\s+/.test(line)) out[section].push(statusItemText(line));
      else if (out[section].length === 0 && !/^(?:none|nothing|—|-)\.?$/i.test(line)) out[section].push(statusItemText(line));
      continue;
    }
    if (!out.headline) out.headline = statusItemText(line.replace(/^#+\s*/, ''));
  }
  return out;
}

const asList = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
const asNum = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/**
 * Normalize a project-status row for the card: metadata.status (the SHARED
 * CONTRACT) wins field-by-field; the Markdown body fills whatever the
 * metadata lacks (older rows, dropped pick-lists).
 */
/** Owner 2026-09-22: the plain-language brief riding metadata.brief on a status row. */
export interface ProjectBriefAskData {
  at: string;
  text: string;
  /** 'answered' (2026-09-24): the supervisor replied in chat — the backend now
   *  loads its own replies, so an in-chat answer is no longer invisible (the
   *  owner's asks read "→ no record yet" for 12+ hours although each was
   *  answered within 6 minutes). 'unknown' = nothing in the inputs tracks it. */
  status: 'done' | 'answered' | 'in_progress' | 'open' | 'unknown';
  note?: string;
}

/** Ask statuses that still want something — rendered first in "You asked". */
export function isUnresolvedAsk(status: ProjectBriefAskData['status']): boolean {
  return status === 'open' || status === 'in_progress' || status === 'unknown';
}

/**
 * The asks the card shows (2026-09-24): the NEWEST `cap` by `at` (the backend
 * lists newest-first; sorted here so the cap never depends on wire order),
 * then unresolved (open / in progress / not tracked) ahead of done / answered,
 * each group keeping its newest-first order. Pure; never mutates the input.
 */
export function visibleAsks(asks: ProjectBriefAskData[], cap = 6): ProjectBriefAskData[] {
  const ms = (a: ProjectBriefAskData): number => { const t = Date.parse(a.at); return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t; };
  const newest = asks
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (ms(y.a) - ms(x.a)) || (x.i - y.i))
    .slice(0, Math.max(0, cap))
    .map((x) => x.a);
  return [...newest.filter((a) => isUnresolvedAsk(a.status)), ...newest.filter((a) => !isUnresolvedAsk(a.status))];
}

/**
 * 2026-09-24 (owner: eight near-identical hourly cards overnight, "no change
 * in the last hour"): the no-change stub's quiet facts ride the ROW metadata —
 * `unchanged: true` + `quietSince` (ISO — when the status last changed) +
 * `quietChecks` (how many hourly checks found nothing). The card renders a
 * compact variant from these. A changed set of asks becomes a REAL card (the
 * backend treats a moved asks fingerprint as a change), so stubs carry no
 * asks and the card never renders a brief for one; the one signal a stub
 * keeps is the owner question (headline clause + "Needs you" counter).
 * undefined unless the row is stamped unchanged === true (a boolean, never a
 * string) — a full card must not be demoted by a malformed stamp.
 */
export interface ProjectStatusQuietData {
  quietSince?: string;
  quietChecks?: number;
}
export function normalizeProjectStatusQuiet(v: unknown): ProjectStatusQuietData | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const m = v as Record<string, unknown>;
  if (m.unchanged !== true) return undefined;
  const out: ProjectStatusQuietData = {};
  if (typeof m.quietSince === 'string' && m.quietSince.trim() && !Number.isNaN(Date.parse(m.quietSince))) out.quietSince = m.quietSince.trim();
  if (typeof m.quietChecks === 'number' && Number.isFinite(m.quietChecks) && m.quietChecks >= 0) out.quietChecks = Math.floor(m.quietChecks);
  return out;
}
/**
 * Owner 2026-09-29 (the digby-benchmarks recording: "see how unhelpful the
 * project status are and im still constantly asking for where the project is
 * at"): the at-a-glance update the status card now LEADS with, riding
 * metadata.update (backend fleet/project-update.ts) — one state pill, one
 * summary line, what changed since the last update, the open owner questions
 * in their own words, the next check. Rows older than 2026-09-29 carry none
 * and render the previous layout.
 */
export type ProjectUpdateState = 'needs_you' | 'blocked' | 'stalled' | 'working' | 'idle' | 'done' | 'no_goals';
export interface ProjectUpdateData {
  state: ProjectUpdateState;
  stateLabel: string;
  focus?: string;
  progress?: { done: number; total: number; label?: string };
  etaMinutes?: number;
  summary: string;
  changes: string[];
  needsYou: string[];
  needsYouCount: number;
  nextCheckAt?: string;
  since?: string;
}
const UPDATE_STATES: ProjectUpdateState[] = ['needs_you', 'blocked', 'stalled', 'working', 'idle', 'done', 'no_goals'];
const UPDATE_STATE_LABELS: Record<ProjectUpdateState, string> = {
  needs_you: 'Needs you', blocked: 'Blocked', stalled: 'Stalled', working: 'Working', idle: 'Idle', done: 'Done', no_goals: 'No goals',
};

/** Defensive parse of metadata.update — undefined unless it has a known state
 *  and a summary. */
export function normalizeProjectUpdate(v: unknown): ProjectUpdateData | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const u = v as Record<string, any>;
  const state = UPDATE_STATES.includes(u.state) ? (u.state as ProjectUpdateState) : undefined;
  const summary = typeof u.summary === 'string' ? u.summary.trim() : '';
  if (!state || !summary) return undefined;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((i): i is string => typeof i === 'string' && i.trim().length > 0).map((i) => i.trim()) : []);
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  const iso = (x: unknown) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? x : undefined);
  const p = u.progress && typeof u.progress === 'object' ? u.progress : undefined;
  const pd = num(p?.done); const pt = num(p?.total);
  const needsYou = list(u.needsYou);
  return {
    state,
    stateLabel: typeof u.stateLabel === 'string' && u.stateLabel.trim() ? u.stateLabel.trim() : UPDATE_STATE_LABELS[state],
    ...(typeof u.focus === 'string' && u.focus.trim() ? { focus: u.focus.trim() } : {}),
    ...(pd !== undefined && pt !== undefined && pt > 0 && pd >= 0 && pd <= pt
      ? { progress: { done: pd, total: pt, ...(typeof p?.label === 'string' && p.label.trim() ? { label: p.label.trim() } : {}) } }
      : {}),
    ...(num(u.etaMinutes) ? { etaMinutes: num(u.etaMinutes) } : {}),
    summary,
    changes: list(u.changes),
    needsYou,
    needsYouCount: Math.max(num(u.needsYouCount) ?? 0, needsYou.length),
    ...(iso(u.nextCheckAt) ? { nextCheckAt: iso(u.nextCheckAt) } : {}),
    ...(iso(u.since) ? { since: iso(u.since) } : {}),
  };
}

export interface ProjectBriefData {
  mission?: string;
  now?: string;
  changed: string[];
  blocked: string[];
  next?: string;
  asks: ProjectBriefAskData[];
  source?: 'model' | 'fallback';
}

/** Defensive parse of metadata.brief — undefined unless it carries something
 *  renderable. `lanesReconciled` (2026-09-24, from normalizeProjectStatus on
 *  an OLDER row) rewrites a "N work sessions are running" sentence in `now`
 *  when nothing runs — see reconcileBriefNow; absent ⇒ byte-for-byte. */
export function normalizeProjectBrief(v: unknown, lanesReconciled?: LaneReconciliation): ProjectBriefData | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const b = v as Record<string, any>;
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  const list = (x: unknown) => (Array.isArray(x) ? x.map(str).filter((s): s is string => !!s) : []);
  const now = reconcileBriefNow(str(b.now), lanesReconciled);
  const asks: ProjectBriefAskData[] = Array.isArray(b.asks)
    ? b.asks.flatMap((a: any) => {
      const text = str(a?.text); const at = str(a?.at);
      if (!text || !at) return [];
      const status = a?.status === 'done' || a?.status === 'answered' || a?.status === 'in_progress' || a?.status === 'open' ? a.status : 'unknown';
      const note = str(a?.note);
      return [{ at, text, status, ...(note ? { note } : {}) }];
    })
    : [];
  const out: ProjectBriefData = {
    ...(str(b.mission) ? { mission: str(b.mission) } : {}),
    ...(now ? { now } : {}),
    changed: list(b.changed),
    blocked: list(b.blocked),
    ...(str(b.next) ? { next: str(b.next) } : {}),
    asks,
    ...(b.source === 'model' || b.source === 'fallback' ? { source: b.source } : {}),
  };
  if (!out.mission && !out.now && !out.next && !out.asks.length && !out.changed.length) return undefined;
  return out;
}

export function normalizeProjectStatus(status: unknown, content: string | null | undefined): ProjectStatusData {
  const md = parseProjectStatusMarkdown(content);
  const s = (status && typeof status === 'object' ? status : {}) as Record<string, any>;
  const goals = s.goals && typeof s.goals === 'object' ? { active: asNum(s.goals.active), done: asNum(s.goals.done), blocked: asNum(s.goals.blocked) } : undefined;
  const todos = s.todos && typeof s.todos === 'object'
    ? { inProgress: asNum(s.todos.inProgress), pending: asNum(s.todos.pending), blocked: asNum(s.todos.blocked), doneSince: asNum(s.todos.doneSince) }
    : undefined;
  const plan = s.plan && typeof s.plan === 'object' ? { done: asNum(s.plan.done), total: asNum(s.plan.total), blocked: asNum(s.plan.blocked) } : undefined;
  const runs = s.runs && typeof s.runs === 'object' ? { completed: asNum(s.runs.completed), failed: asNum(s.runs.failed), running: asNum(s.runs.running) } : undefined;
  const prs = s.prs && typeof s.prs === 'object'
    ? {
      opened: asNum(s.prs.opened),
      ...(asNum(s.prs.merged) !== undefined ? { merged: asNum(s.prs.merged) } : {}),
      ...(asNum(s.prs.docsOnly) !== undefined ? { docsOnly: asNum(s.prs.docsOnly) } : {}),
    }
    : undefined;
  const timing = normalizeProjectTiming(s.timing);
  let lanesRunning = asNum(s.lanesRunning);
  let lanesScheduled = asNum(s.lanesScheduled);
  // 2026-09-24 older-row reconciliation (owner: "Lanes 3 running" while every
  // timing lane read "scheduled"): before the lanesRunning / lanesScheduled
  // split the backend counted a lane as running when it merely held an ENABLED
  // schedule. Those rows stay in the chat, and their measured timing lanes are
  // the ground truth — the backend lists running lanes FIRST, so a visible
  // scheduled lane proves the running prefix is complete (even when capped),
  // and a list under the cap is complete outright (review C14). Only an
  // all-running CAPPED list is ambiguous (more may run past the cap) and is
  // left alone. Only rows WITHOUT lanesScheduled are touched; the fixed
  // backend's rows pass through byte-for-byte. When the counts CHANGE, the
  // headline's lane clause moves with them (reconcileHeadlineLanes) and the
  // result is stamped so the card can hand it to the brief (review C15).
  let lanesReconciled: LaneReconciliation | undefined;
  if (lanesScheduled === undefined && lanesRunning !== undefined && lanesRunning > 0 && timing && timing.lanes.length > 0) {
    const running = timing.lanes.filter((l) => l.state === 'running').length;
    if (running < timing.lanes.length || timing.lanes.length < TIMING_LANES_CAP) {
      const scheduled = Math.max(0, lanesRunning - running);
      if (running !== lanesRunning) lanesReconciled = { running, scheduled };
      lanesScheduled = scheduled;
      lanesRunning = running;
    }
  }
  const headline = (typeof s.headline === 'string' && s.headline.trim()) ? s.headline.trim() : md.headline;
  return {
    ...(typeof s.projectName === 'string' && s.projectName.trim() ? { projectName: s.projectName.trim() } : {}),
    ...(typeof s.sessionTitle === 'string' && s.sessionTitle.trim() ? { sessionTitle: s.sessionTitle.trim() } : {}),
    ...(plan ? { plan } : {}),
    ...(runs ? { runs } : {}),
    ...(prs ? { prs } : {}),
    ...(asNum(s.spendUsd) !== undefined ? { spendUsd: asNum(s.spendUsd) } : {}),
    headline: lanesReconciled ? reconcileHeadlineLanes(headline, lanesReconciled) : headline,
    workingOn: asList(s.workingOn).length ? asList(s.workingOn) : md.workingOn,
    doneSince: asList(s.doneSince).length ? asList(s.doneSince) : md.doneSince,
    blocked: asList(s.blocked).length ? asList(s.blocked) : md.blocked,
    next: asList(s.next).length ? asList(s.next) : md.next,
    ...(goals ? { goals } : {}),
    ...(todos ? { todos } : {}),
    ...(lanesRunning !== undefined ? { lanesRunning } : {}),
    ...(lanesScheduled !== undefined ? { lanesScheduled } : {}),
    ...(asNum(s.ownerItems) !== undefined ? { ownerItems: asNum(s.ownerItems) } : {}),
    ...(timing ? { timing } : {}),
    ...(lanesReconciled ? { lanesReconciled } : {}),
  };
}

/**
 * One-line preview for a collapsed agent/system row: the first non-empty line,
 * whitespace-collapsed and capped — never fabricated, just truncated.
 */
export function summarizeSystemRow(content: string, max = 90): string {
  const first = (content || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  const flat = first.replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
