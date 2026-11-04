/**
 * FRAMEWORK FACTS — layer 2 of the layered prompt (prompt-layers.ts): what the
 * harness does NOW, composed at prompt time from live values instead of typed
 * into doctrine and left to rot. The rule that governs these facts (a parked
 * or skipped turn is a decision-gate outcome, never a lost wake) lives ONCE in
 * core-doctrine.ts; this block only names WHICH purposes act today and their
 * bounds, plus the receipt / depth / switch / computer-use facts every lane
 * misreads without them.
 *
 * Contract (pinned by prompt-layers.test.ts + prompt-hygiene.test.ts):
 *   - ≤ FRAMEWORK_FACTS_MAX_CHARS (2,500) with EVERY registered purpose in act;
 *   - exactly ONE date — the "as of" header — and the named live values
 *     (purpose ids, bounds) are the only allowlisted specifics; no ticket ids,
 *     project names, model names, agent versions, DMG / keychain / deploy-
 *     minute ops trivia (those are infra-alert content or a project's brief).
 *
 * The act set is read from the decision-gate mode cache (store → env →
 * registry cap) synchronously — the same resolution the runtime uses — so a
 * stored prompt embeds the act set at compose time and the stock-prompt heals
 * (fleet: the 15-min watchdog; project: ensure on every wake) rewrite it when
 * a purpose flips. Tests pass `actPurposes` explicitly (NODE_ENV=test resolves
 * every purpose to 'off').
 */

import {
  DECISION_PURPOSES,
  storedDecisionModeSync,
  envDecisionMode,
  capDecisionMode,
  purposeActCap,
} from './decision-gate-modes';
import type { DecisionMode, DecisionPurpose } from './decision-gate';
import { ROLLOUT_TIER_RULE } from './decision-gate-registry';
import { parkedPurposesSync, rolloutRecentLineSync, rolloutStateSync } from './decision-gate-rollout';

/** Raised 2,500 → 3,400 with the roll-out line (rollout self-governance 2026-09-27): the
 *  act list, the shadow / off / parked / capped lists and the tier rule all ride the block.
 *  3,400 → 4,050 with the FRAMEWORK BACKLOG line (backlog audit 2026-09-28): the full
 *  render with EVERY purpose in act measured 3,893; cap = measured + 4%. */
export const FRAMEWORK_FACTS_MAX_CHARS = 4_050;
export const FRAMEWORK_FACTS_HEADING = '## Harness facts as of';
/** The ONE doctrine sentence about what the gate can and cannot do (stated here, never in the core). */
export const GATE_SELF_KNOWLEDGE_SENTENCE =
  "The decision gate can only remove or reorder the harness's own small judgments; it never blocks a lane; a wrong act shows up as an auto-demote — read get_decision_gate_status before diagnosing a 'skipped' wake.";

/** What ACT means per purpose — the bound the lane must not misread. Purposes
 *  without an entry are named without a bound (their consumer documents it). */
export const PURPOSE_ACT_BOUNDS: Readonly<Partial<Record<string, string>>> = {
  wake_triage: 'parks a non-alarm hook wake ≤2 h, then delivers',
  sweep_triage: 'skips a no-op stock sweep tick; a heartbeat floor still fires',
  drain_triage: 'parks a quiet queued agent batch ≤15 min',
  imessage_send: 'skips the send-intent call when confident',
  auto_route: 'picks the level for mode=auto sends',
  supervisor_turn_noop: 'skips a sweep / parks a drain, heartbeat floor',
  session_topology: 'may route an ambiguous spawn to reuse / merge / retire',
  compute_policy: 'may add a checker BEHIND the answer',
  wake_effort: 'may lower a wake\'s lead effort',
};

/** Effective mode for a purpose on THIS process: store cache → env → registry cap. */
export function effectiveDecisionModeSync(purpose: DecisionPurpose): DecisionMode {
  if (process.env.DECISION_GATE_DISABLED === '1') return 'off';
  const stored = storedDecisionModeSync(purpose);
  const resolved = stored ? { mode: stored, source: 'store' as const } : envDecisionMode(purpose);
  return capDecisionMode(purpose, resolved).mode;
}

/** The purposes in ACT mode right now (sorted, stable). */
export function actPurposesSync(): string[] {
  return DECISION_PURPOSES
    .map(p => p.purpose)
    .filter(p => effectiveDecisionModeSync(p) === 'act')
    .sort();
}

/** The roll-out facts the block names beside the act set (all lists sorted, live). */
export interface GateRolloutFacts {
  shadow: string[];
  off: string[];
  parked: string[];
  capped: string[];
  /** 'on' | 'on (dry run)' | 'off' | null when unknown on this process. */
  autoRollout: string | null;
  /** ONE short relative-time line of recent automaton actions, or null. */
  recent: string | null;
}

/** The live roll-out facts on THIS process (store caches → env → registry cap). */
export function gateRolloutFactsSync(actPurposes?: string[]): GateRolloutFacts {
  const act = new Set(actPurposes ?? actPurposesSync());
  const parked = new Set(parkedPurposesSync());
  const shadow: string[] = [];
  const off: string[] = [];
  const capped: string[] = [];
  for (const { purpose } of DECISION_PURPOSES) {
    if (purposeActCap(purpose)) capped.push(purpose);
    if (act.has(purpose)) continue;
    const mode = effectiveDecisionModeSync(purpose);
    if (mode === 'off') off.push(purpose);
    else if (!parked.has(purpose)) shadow.push(purpose);
  }
  const state = rolloutStateSync();
  const autoRollout = state ? (state.lastSummary?.startsWith('auto-rollout OFF') ? 'off' : state.lastSummary?.startsWith('DRY RUN') ? 'on (dry run)' : 'on') : null;
  return { shadow: shadow.sort(), off: off.sort(), parked: [...parked].sort(), capped: capped.sort(), autoRollout, recent: rolloutRecentLineSync() };
}

export interface FrameworkFactsOpts {
  /** Override the live act set (tests / offline composition). */
  actPurposes?: string[];
  /** Override the live roll-out facts (tests / offline composition). */
  rollout?: Partial<GateRolloutFacts>;
  /** The "as of" date for the header (default: today, UTC). */
  asOf?: Date;
  /** Who reads it — chat turns get the gate + receipts facts only. */
  audience?: 'supervisor' | 'coding' | 'chat';
}

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The roll-out line: what is NOT acting and why, the tier rule, recent automaton actions, the self-knowledge sentence. */
function rolloutLine(r: GateRolloutFacts, compact: boolean): string {
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'none');
  const lists = compact
    ? `shadow ${r.shadow.length}, off ${r.off.length}, parked ${r.parked.length}, capped ${r.capped.length} (names: get_decision_gate_status)`
    : `shadow: ${list(r.shadow)}; off: ${list(r.off)}; parked (auto-demoted twice, held a week): ${list(r.parked)}; capped at shadow in code: ${list(r.capped)}`;
  const auto = r.autoRollout ? `Auto-rollout is ${r.autoRollout}` : 'Auto-rollout state unknown on this process';
  const recent = r.recent ? ` Recent: ${r.recent}.` : '';
  return `- DECISION GATE ROLL-OUT — ${lists}. ${auto}: ${ROLLOUT_TIER_RULE}.${recent} ${GATE_SELF_KNOWLEDGE_SENTENCE}`;
}

/**
 * The composed facts block. Never exceeds FRAMEWORK_FACTS_MAX_CHARS: the act list is the only unbounded input
 * (≤ the registry); prompt-layers.test.ts renders it with EVERY purpose in act.
 */
export function frameworkFactsBlock(opts: FrameworkFactsOpts = {}): string {
  const act = (opts.actPurposes ?? actPurposesSync()).filter(Boolean);
  const audience = opts.audience ?? 'supervisor';
  const live = gateRolloutFactsSync(act);
  const rollout: GateRolloutFacts = { ...live, ...(opts.rollout ?? {}) };
  // Bounds ride the act list while it fits; a long act list (every purpose
  // flipped) degrades to names only, then the roll-out lists degrade to counts,
  // BEFORE the hard clip below.
  const withBounds = act.map(p => (PURPOSE_ACT_BOUNDS[p] ? `${p} (${PURPOSE_ACT_BOUNDS[p]})` : p)).join('; ');
  const namesOnly = act.join(', ');
  const render = (actLine: string, compactRollout: boolean): string => composeLines(actLine, rolloutLine(rollout, compactRollout), audience, opts.asOf ?? new Date()).join('\n');
  const full = render(act.length ? withBounds : 'none — every purpose is shadow on this process', false);
  if (full.length <= FRAMEWORK_FACTS_MAX_CHARS) return full;
  const compact = render(act.length ? `${namesOnly} (bounds: get_model_roles)` : 'none', false);
  if (compact.length <= FRAMEWORK_FACTS_MAX_CHARS) return compact;
  const compactest = render(act.length ? `${namesOnly} (bounds: get_model_roles)` : 'none', true);
  return compactest.length <= FRAMEWORK_FACTS_MAX_CHARS ? compactest : `${compactest.slice(0, FRAMEWORK_FACTS_MAX_CHARS - 1)}…`;
}

function composeLines(actLine: string, rolloutText: string, audience: NonNullable<FrameworkFactsOpts['audience']>, asOf: Date): string[] {
  const opts = { asOf };
  const lines: string[] = [
    `${FRAMEWORK_FACTS_HEADING} ${dateOnly(opts.asOf ?? new Date())} (live values composed at prompt time)`,
    `- DECISION GATE — in ACT now: ${actLine}. Every other purpose is shadow (telemetry only). A flip is an admin action against a readiness stamp (Account → Admin → Endpoints → Model roles → Decision gate) or the rollout automaton's; a precision breach auto-demotes. You never flip, re-arm around, or ticket a gate outcome (rule gate.outcome).`,
    rolloutText,
    `- RECEIPTS: a confirmation-STAGED call answers ok:false {staged:true, confirmationId} — never evidence; the owner's confirm mints its own row with ids.confirmationId + ids.ownerConfirmed — cite THAT. stage_upload mints a receipt. get_run_receipts always carries chatTurns.`,
    `- DEPTH: every chat, supervisors included, is stored on Auto; a machine wake runs the machine preset (lead max, no checker, no council) unless compute_policy / wake_effort act — a checker-less wake is the standing rule.`,
  ];
  if (audience !== 'chat') {
    lines.push(
      `- SUPERVISOR SWITCHES: an admin can turn the fleet / project supervisors OFF (Account → Admin → Settings → Supervisors; admin-only, no platform tool). OFF = that tier's wakes are skipped and counted, never replayed; in-flight runs finish; lanes and human turns are untouched. "supervisor: OFF" on your board or in a spawn refusal is the admin's decision — never re-enable, re-arm around it, relay via a peer, or ticket it.`,
      `- COMPUTER USE (paired Mac): '[COMPUTER_TASK — BUSY]' names the holder — never re-dispatch that device. '[FOCUS ON UNCAPTURED DISPLAY]' + the result header's counters (refusedRepeats / noChangeStrikes / degenerateFrames / probe / displays) are ground truth; a sub-agent's narration about capture, input or permissions is unverified — never send the owner to permissions from it. A MACHINE run is camera-only while the owner is active (on the result). A bounded wait action exists; a missing agent capability is named in the result.`,
      `- DEPLOYS: a deploy wave is a bounded clock owned by CI — never poll it; read get_fleet_telemetry view 'deploy' on your next firing. Tuning switches are CI-side, never box env.`,
      `- FRAMEWORK BACKLOG: docs/FRAMEWORK_BACKLOG.md in the platform repository is the framework's living backlog and the Fleet Supervisor OWNS it — every deferred harness item (status, evidence, next step, kill switch) lives there, never in a prompt, a ticket thread or a lane's memory; the Framework Operator lane works it top-down and a closed item is moved to its Closed section with the commit that closed it. Read it before filing a framework ticket; a gap already listed there is a backlog item to advance, not a new ticket.`,
    );
  }
  return lines;
}
