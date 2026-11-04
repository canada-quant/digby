/**
 * Depth UX — the client contract for the outcome-driven compute policy
 * (docs/DEPTH_UX_SOTA_2026-09-26.md §4; shared contract 2026-09-26, Module C).
 *
 * Every signed-in human web send is `mode='auto'` — Digby picks depth and
 * models per message (roster 2026-10-06 B-3: the Account → Advanced "Default
 * depth" presets and the dead composer-picker paths are GONE — and the Advanced
 * TAB itself was removed outright 2026-10-27, ticket c99b404a; the API still
 * accepts every mode alias for stored rows, mobile, REST and schedules). The
 * server tells the client what it did through three harness-driven surfaces,
 * all typed here so the view never trusts model prose:
 *
 *   · `check_state` SSE events → ONE pill under the assistant bubble
 *     (Checking… → Checked ✓ / Updated · what changed / Check didn't finish);
 *   · `progress` events keyed on a FIXED set → a status line from the lookup
 *     table below (a key the table doesn't know falls back to the server's
 *     own `message`, exactly like today — never invented client-side);
 *   · the followups/chips event's ONE `escalate` chip → the single "Dig
 *     deeper" control, which re-sends with `escalationOf=<assistantMessageId>`
 *     (guests get `signin_deeper` instead). The SERVER is the only source of
 *     a chip (fail-closed): no chips on the row ⇒ no control — never derived
 *     from a stored level, never under a machine-origin row, and nothing
 *     renders when DIG_DEEPER_DISABLED=1 stops the server appending one.
 *
 * The seam names the client reads (event types, metadata keys, the request
 * param) are pinned in lib/depth-ux-contract.json — ONE fixture Module B's
 * jest suite must import too, so drift on either side fails CI.
 *
 * Fail-open by construction: no event ⇒ nothing renders; a malformed payload
 * is dropped (never thrown); the legacy pendingCrossCheck / revision /
 * crossCheck metadata still drive the pill for rows persisted before the
 * policy shipped. The former build-time kill switch NEXT_PUBLIC_DEPTH_UX_DISABLED
 * (the composer picker) was never forwarded into the frontend build and is
 * retired with the picker (roster 2026-10-06 B-3); the server-side
 * `patience_auto_only` switch and the API's mode aliases are unchanged.
 */

import type { ActivePatienceMode } from '@/lib/preferences';
import { isMachineStampOrigin } from '@/lib/machine-wake';

/** How a send's level was chosen (the server's label-window vocabulary; the web client now only ever sends 'default' — a guest's forced Ensemble). */
export type PlainModeSource = 'picked' | 'default' | 'restored';

// ── Presets ──────────────────────────────────────────────────────────────────

export type DepthPreset = 'single_thinking' | 'thinking' | 'deep_research';

const PRESETS: readonly DepthPreset[] = ['single_thinking', 'thinking', 'deep_research'];
export function isDepthPreset(v: unknown): v is DepthPreset {
  return typeof v === 'string' && (PRESETS as readonly string[]).includes(v);
}

/** Legacy stored modes collapse onto the three presets (the server aliases the
 *  same way — `normalizePatienceMode`). */
export function presetFromMode(mode: unknown): DepthPreset | null {
  if (mode === 'single' || mode === 'fast' || mode === 'single_thinking') return 'single_thinking';
  if (mode === 'thinking' || mode === 'code') return 'thinking';
  if (mode === 'deep_research' || mode === 'deep_research_all') return 'deep_research';
  return null;
}

// ── check_state ──────────────────────────────────────────────────────────────

export type CheckStateName = 'checking' | 'checked' | 'updated' | 'interrupted' | 'skipped';
const CHECK_STATES: readonly CheckStateName[] = ['checking', 'checked', 'updated', 'interrupted', 'skipped'];

export interface CheckState {
  state: CheckStateName;
  /** What the revision changed (numbers / dates / entities / recommendations) — 'updated' only. */
  changed?: string[];
  revisionId?: string;
}

/** Parse one `check_state` payload; null for anything malformed (dropped, never thrown). */
export function parseCheckState(raw: unknown): CheckState | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.state !== 'string' || !(CHECK_STATES as readonly string[]).includes(r.state)) return null;
  const changed = Array.isArray(r.changed)
    ? r.changed.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim())
    : undefined;
  const out: CheckState = { state: r.state as CheckStateName };
  if (changed && changed.length) out.changed = changed;
  if (typeof r.revisionId === 'string' && r.revisionId) out.revisionId = r.revisionId;
  return out;
}

/**
 * The pill state machine. The server's events are the truth, so a valid event
 * replaces the previous state — with ONE guard: an 'updated' state never
 * regresses to 'checked'/'skipped' for the SAME revision (a replayed or
 * out-of-order frame must not hide a correction the user was told about).
 * A malformed event keeps the previous state.
 */
export function reduceCheckState(prev: CheckState | undefined, raw: unknown): CheckState | undefined {
  const next = parseCheckState(raw);
  if (!next) return prev;
  if (
    prev?.state === 'updated' &&
    (next.state === 'checked' || next.state === 'skipped') &&
    (!next.revisionId || next.revisionId === prev.revisionId)
  ) {
    return prev;
  }
  return next;
}

// ── The pill ─────────────────────────────────────────────────────────────────

export type PillState =
  | { kind: 'checking' }
  | { kind: 'checked' }
  | { kind: 'updated'; changed: string[] }
  | { kind: 'interrupted' }
  /** Dynamic roster (2026-10-03): the answer ran on the QUICK lane (one fast model + web search, no checker). */
  | { kind: 'quick' }
  | null;

/** The subset of PlainMessageMeta the pill reads (typed here so the module has
 *  no dependency on lib/api/coding.ts). */
export interface PillMetaInput {
  check?: CheckState;
  pendingCrossCheck?: boolean;
  revision?: { previousContent?: string; reason?: string } | null;
  crossCheck?: { outcome?: string } | null;
  /** metadata.depth — the plan's `lane: 'quick'` marks a Quick-lane answer. */
  depth?: { plan?: { lane?: string } } | null;
}

/**
 * Pill state for a bubble. Precedence: the live stream's last check_state
 * (while the turn streams) → the persisted metadata.check → the LEGACY
 * cross-check metadata (rows from before the policy: pendingCrossCheck ⇒
 * checking; revision ⇒ updated; crossCheck.outcome unchanged ⇒ checked;
 * reconcile_failed/timeout ⇒ interrupted). 'skipped' renders nothing — a
 * quiet answer needs no badge.
 */
export function pillFromMeta(meta: PillMetaInput | undefined, live?: CheckState): PillState {
  const c = live ?? meta?.check;
  if (c) {
    switch (c.state) {
      case 'checking': return { kind: 'checking' };
      case 'checked': return { kind: 'checked' };
      case 'updated': return { kind: 'updated', changed: c.changed ?? [] };
      case 'interrupted': return { kind: 'interrupted' };
      case 'skipped': return null;
    }
  }
  if (!meta) return null;
  // A Quick-lane answer (no checker ran) says so quietly — Dig deeper is the way to a checked answer.
  if (meta.depth?.plan?.lane === 'quick') return { kind: 'quick' };
  if (meta.pendingCrossCheck === true) return { kind: 'checking' };
  if (meta.revision) return { kind: 'updated', changed: [] };
  const outcome = meta.crossCheck?.outcome;
  if (outcome === 'unchanged') return { kind: 'checked' };
  if (outcome === 'reconcile_failed' || outcome === 'timeout') return { kind: 'interrupted' };
  return null;
}

/** The pill's copy — one string per state, never model prose. */
export const PILL_TEXT: Record<Exclude<PillState, null>['kind'], string> = {
  checking: 'Checking…',
  checked: 'Checked ✓',
  updated: 'Updated',
  interrupted: 'Check didn’t finish',
  quick: 'Quick answer',
};

// ── progress keys ────────────────────────────────────────────────────────────

export type ProgressKey =
  | 'planning'
  | 'checking_web'
  | 'second_opinion'
  | 'double_checking_stakes'
  | 'deeper_findings_started'
  | 'deeper_findings_ready';

/** The status line per key — code-composed, keyed on what the harness is doing. */
// Digby's status voice (2026-10-04): the SAME text as the server's PROGRESS_LINES
// (backend chat-agent/compute-policy-wiring.ts — mobile renders the server's), minus the trailing ellipsis the
// status row adds itself. Change both together.
export const PROGRESS_KEY_TEXT: Record<ProgressKey, string> = {
  planning: 'Digby is working out the best way to answer',
  checking_web: 'Digby is checking the web',
  second_opinion: 'A second opinion is running alongside — this answer updates if it finds something',
  double_checking_stakes: 'This one matters — Digby is double-checking before answering',
  deeper_findings_started: 'Digging deeper — “Deeper findings” will post here as a new message when they’re ready',
  deeper_findings_ready: 'Deeper findings are ready',
};

export function isProgressKey(v: unknown): v is ProgressKey {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PROGRESS_KEY_TEXT, v);
}

/**
 * The status text for a `progress` payload: a KNOWN key wins (the server's
 * `message` for that key is ignored — the client owns the wording); an unknown
 * key or no key falls back to the server's own `message` string (today's
 * behaviour: kid status lines, harness stage notices); nothing usable → null.
 */
export function progressTextFor(data: unknown): { message: string; key?: ProgressKey } | null {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (isProgressKey(d.key)) return { message: PROGRESS_KEY_TEXT[d.key], key: d.key };
  const message = typeof d.message === 'string' ? d.message : '';
  return message ? { message } : null;
}

// ── chips ────────────────────────────────────────────────────────────────────

export type NextRung = 'verify' | 'research';

export interface EscalateChip {
  kind: 'escalate';
  label: string;
  escalationOf: string;
  nextRung: NextRung;
  /** Harness-owned wait, from the server ("as long as it needs — I'll post it here when it's ready"). */
  etaText?: string;
}

export interface SigninDeeperChip {
  kind: 'signin_deeper';
  label: string;
}

export type DepthChip = EscalateChip | SigninDeeperChip;

export const ESCALATE_LABEL = 'Dig deeper';
export const SIGNIN_DEEPER_LABEL = 'Sign in for a deeper look';

/**
 * The server's Dig-deeper REFUSAL codes (crossmodel.controller.ts escalation
 * block — audit 2026-09-26 sse-ui-restore-3). Each says whether the tap can
 * be retried later (the chip stays) or the rung is gone for good (strip it),
 * and whether the daily quota should be re-read.
 */
export const ESCALATION_REFUSAL_CODES: ReadonlySet<string> = new Set([
  // DEPTH_BUDGET_EXCEEDED: LEGACY — the server has not emitted it since 2026-09-27
  // (owner: no cost caps; a Dig-deeper tap is never refused on cost). Kept so an
  // old frame is still handled as terminal instead of toasting "Agent error".
  'SIGNIN_DEEPER', 'ESCALATION_BUSY', 'ESCALATION_EXHAUSTED', 'ESCALATION_QUOTA', 'DEPTH_BUDGET_EXCEEDED',
  'DIG_DEEPER_DISABLED', 'ESCALATION_NOT_FOUND', 'ESCALATION_NO_QUESTION', 'ESCALATION_NO_CHAT', 'RATE_LIMIT_DEEP_RESEARCH',
]);
export interface EscalationRefusal { code: string; /** the rung can never run on this row — drop the chip */ stripChips: boolean; /** re-read the daily quota */ refreshQuota: boolean }
export function escalationRefusalFor(code: string): EscalationRefusal {
  const gone = code === 'ESCALATION_EXHAUSTED' || code === 'DEPTH_BUDGET_EXCEEDED' || code === 'DIG_DEEPER_DISABLED' || code === 'ESCALATION_NOT_FOUND' || code === 'ESCALATION_NO_QUESTION';
  const quota = code === 'ESCALATION_QUOTA' || code === 'RATE_LIMIT_DEEP_RESEARCH';
  return { code, stripChips: gone || quota, refreshQuota: quota };
}

/** Client-side fallback ETA per rung when the server sent none (the doc's
 *  harness-measured numbers, phrased as ranges — never a model's guess). */
export const RUNG_ETA_TEXT: Record<NextRung, string> = {
  verify: 'a couple of minutes',
  // Deep research has no wall clock (2026-10-20): no fixed time is promised. Byte-identical to the server's ETA_TEXT.
  research: 'as long as it needs — I’ll post it here when it’s ready',
};

/** Parse the chips array a followups / complete payload may carry. Unknown
 *  kinds and malformed entries are dropped; at most ONE escalate chip survives. */
export function parseChips(raw: unknown): DepthChip[] {
  if (!Array.isArray(raw)) return [];
  const out: DepthChip[] = [];
  let sawEscalate = false;
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (c.kind === 'escalate') {
      if (sawEscalate) continue;
      if (typeof c.escalationOf !== 'string' || !c.escalationOf) continue;
      if (c.nextRung !== 'verify' && c.nextRung !== 'research') continue;
      sawEscalate = true;
      out.push({
        kind: 'escalate',
        label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : ESCALATE_LABEL,
        escalationOf: c.escalationOf,
        nextRung: c.nextRung,
        ...(typeof c.etaText === 'string' && c.etaText.trim() ? { etaText: c.etaText.trim() } : {}),
      });
    } else if (c.kind === 'signin_deeper') {
      if (out.some((x) => x.kind === 'signin_deeper')) continue;
      out.push({ kind: 'signin_deeper', label: typeof c.label === 'string' && c.label.trim() ? c.label.trim() : SIGNIN_DEEPER_LABEL });
    }
  }
  return out;
}

/** Persisted `metadata.depth` on an assistant row (Module B writes it). */
export interface DepthMeta {
  plan?: {
    preset?: DepthPreset;
    spawnChecker?: boolean;
    checkerWaitMs?: number;
    council?: 'none' | 'background';
    source?: string;
    /** Dynamic roster (2026-10-03): 'quick' = the Quick lane ran this answer. */
    lane?: 'quick';
  };
  budget?: Record<string, unknown>;
  decisionId?: string;
}

/** Persisted crossmodel message ids are UUIDs; streamed placeholders
 *  (a-<ts>, tmp-<ts>, m-<i>-…) can never be escalated. */
const MSG_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isEscalatableMessageId(id: unknown): id is string {
  return typeof id === 'string' && MSG_ID_RE.test(id);
}

/** The rung after `preset`, with `spent` escalations already run on the message. */
export function nextRungFor(preset: DepthPreset | null, spent: number): NextRung | null {
  if (!preset) return null;
  const ladder: NextRung[] = preset === 'single_thinking' ? ['verify', 'research'] : preset === 'thinking' ? ['research'] : [];
  return ladder[spent] ?? null;
}

export interface EscalationChipInput {
  /** Chips the server appended to this answer — the followups/complete event
   *  or the persisted `metadata.chips`. The ONLY source of a control. */
  chips?: DepthChip[];
  /** The row's persisted depth plan — read only to walk the ladder past a rung
   *  spent THIS session (never to invent a control). */
  depth?: DepthMeta;
  /** The row's origin stamp (`metadata.origin`): a machine row — schedule /
   *  hook / agent / webhook / machine — never carries a control. */
  origin?: string;
  messageId: string;
  guest: boolean;
  /** Escalations already sent against this message (echo rows carrying escalationOf). */
  spent?: number;
  /** Chips render only under the LATEST answer and only while nothing streams. */
  isLast: boolean;
  running: boolean;
  /** Kid path / a page-level switch — the page passes false. */
  enabled?: boolean;
}

/**
 * Which chip (if any) renders under an answer — FAIL-CLOSED: the server is the
 * only source. No chips on the row ⇒ no control, whatever `metadata.mode` or a
 * stored level says (a legacy row, today's backend, a machine/supervisor
 * reply, or DIG_DEEPER_DISABLED=1 all render nothing — a tap posts a paid
 * turn, so the client never invents the offer). With a server chip: the chip
 * as sent while nothing was spent on the message this session; once a rung
 * was spent, the next rung of the PERSISTED plan (no plan ⇒ nothing). Guests
 * get the server's sign-in affordance and nothing else.
 */
export function escalationChipFor(input: EscalationChipInput): DepthChip | null {
  if (input.enabled === false || !input.isLast || input.running) return null;
  if (isMachineStampOrigin(input.origin)) return null;
  const chips = input.chips ?? [];
  if (input.guest) return chips.find((c): c is SigninDeeperChip => c.kind === 'signin_deeper') ?? null;
  const server = chips.find((c): c is EscalateChip => c.kind === 'escalate');
  if (!server) return null;
  const spent = input.spent ?? 0;
  if (spent === 0) return server;
  // A plan marked `council:'background'` is NOT a council that ran (audit
  // 2026-09-26 routing-unify-3 — nothing consumes the marker; the server no
  // longer emits it by default): the ladder walks the preset like any row.
  const nextRung = nextRungFor(input.depth?.plan?.preset ?? null, spent);
  if (!nextRung) return null;
  return { kind: 'escalate', label: ESCALATE_LABEL, escalationOf: server.escalationOf, nextRung, etaText: RUNG_ETA_TEXT[nextRung] };
}

/** Count the escalations already sent against `messageId` (the user echoes
 *  carry `escalationOf` in their metadata). */
export function countSpentEscalations(rows: Array<{ role: string; escalationOf?: string }>, messageId: string): number {
  let n = 0;
  for (const r of rows) if (r.role === 'user' && r.escalationOf === messageId) n++;
  return n;
}

// ── quota ────────────────────────────────────────────────────────────────────

export interface DepthQuotaView { remaining: number; limit: number; allowed: boolean; authenticated?: boolean }

/** The council rung is the one bound by the daily deep-research quota — the
 *  badge moved from the retired Level-3 picker state to the research chip. */
export function quotaHintFor(quota: DepthQuotaView | null | undefined, nextRung: NextRung): string | null {
  if (nextRung !== 'research' || !quota || quota.authenticated === false) return null;
  if (!Number.isFinite(quota.remaining) || !Number.isFinite(quota.limit)) return null;
  return `${quota.remaining}/${quota.limit} deeper looks left today`;
}

export function quotaBlocksResearch(quota: DepthQuotaView | null | undefined, nextRung: NextRung): boolean {
  return nextRung === 'research' && !!quota && quota.authenticated !== false && !quota.allowed;
}

// ── the wire mode a human send carries ───────────────────────────────────────

export interface DepthWire { mode: string; modeSource?: PlainModeSource }

/**
 * What a human web send carries (roster 2026-10-06 B-3 — Digby picks depth and
 * models per message; there is no depth control left to set):
 *   signed-in — always 'auto' (no modeSource — the router's own rows cover it).
 *               A preset stored in the browser preference by the retired
 *               Account → Advanced radios (removed with the TAB itself,
 *               2026-10-27 — ticket c99b404a) is IGNORED: nothing in the UI
 *               could change it any more, so honouring it would pin the user's depth
 *               invisibly (the server's always-Auto switch routed it as Auto
 *               anyway since 2026-09-26);
 *   guest     — the POPULATION policy only: today's forced Ensemble for
 *               anonymous callers, modeSource 'default' (the server routes a
 *               guest under the always-Auto switch too);
 *   kid       — untouched: the stored mode as today, no modeSource (the kid
 *               pipeline never routes).
 */
export function depthPrefToWire(pref: ActivePatienceMode, opts: { guest: boolean; isKid?: boolean }): DepthWire {
  if (opts.isKid) return { mode: pref };
  if (opts.guest) return { mode: 'thinking', modeSource: 'default' };
  return { mode: 'auto' };
}

// ── Admin always-Auto switch ─────────────────────────────────────────────────

/** Admin panel fact line for the switch: "ON since 2026-09-26 20:35Z by paul@…" | "ON since … (actor unrecorded)" | "OFF (default, env PATIENCE_AUTO_ONLY)". */
export function describeAutoOnlyState(s: { enabled: boolean; since: string | null; updatedBy: string | null; source: 'setting' | 'env'; envVar: string }): string {
  const since = (() => {
    if (!s.since) return null;
    const d = new Date(s.since);
    return Number.isNaN(d.getTime()) ? null : `${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
  })();
  const by = s.updatedBy ? ` by ${s.updatedBy}` : (s.source === 'setting' ? ' (actor unrecorded — pre-audit flip)' : '');
  const state = s.enabled ? 'ON' : 'OFF';
  if (s.source === 'env' || !since) return `${state} (default, env ${s.envVar})`;
  return `${state} since ${since}${by}`;
}

