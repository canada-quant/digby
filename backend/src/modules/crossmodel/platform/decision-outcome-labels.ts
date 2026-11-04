/**
 * Decision-outcome labels (WI-C, 2026-09-25) — the `actual` for the decision
 * purposes whose truth is only visible when the MACHINE RUN they gated
 * finalizes, recorded against the stashed decision so the shadow rows carry
 * `agreed` (decision-gate.ts recordDecisionOutcome). Before this, every
 * wake_triage / delta_material outcome row was actual:null by construction —
 * the rollout rule "≥200 labelled outcomes over ≥3 days, agreement ≥0.9" could
 * never be met, so no purpose could ever flip to act.
 *
 * The labels are HARNESS-derived (never model-claimed), from what the run
 * measurably did:
 *   wake_triage   — needs_turn_now ⇔ the woken run ACTED: it executed at least
 *                   one MUTATING platform tool (send_chat_message,
 *                   dispatch_platform_task, schedule_message,
 *                   flag_owner_question, todo/goal writes, …; the supervisor's
 *                   own state-ledger write is exempt because every wake does
 *                   it), or its note classified as supervisor_action (the
 *                   'ACTIONS TAKEN' receipt marker — supervisor.service
 *                   classifySupervisorNote, the same classifier behind the
 *                   fleet's "wake no-op share").
 *                   wake-cadence-5 (fixer 2026-09-27): a wake whose ONLY
 *                   mutation was a send_chat_message to the owner's Fleet
 *                   Supervisor chat (a REPORT-UP) labels NOT acted — for
 *                   wake_triage, sweep_triage, drain_triage and
 *                   supervisor_turn_noop (meta.reportUpOnly on the row;
 *                   SUPERVISOR_REPORT_UP_IS_ACTION=1 restores). Same rule the
 *                   attention watchdog applies to the loop_metrics kind, so
 *                   the act-mode gates stop learning to wake for report-ups.
 *   delta_material — material ⇔ the fired run produced a NON-NOOP final: at
 *                   least one evidence-bearing tool call (coding/evidence-tools
 *                   vocabulary) AND a final that is not an explicit no-op
 *                   marker / markerless one-liner.
 *   sweep_triage  — (N2, 2026-09-25) needs_turn_now ⇔ the fired SWEEP acted,
 *                   exactly the wake_triage derivation (the stash rides the
 *                   sweep firing from platform/sweep-triage.ts).
 *   drain_triage  — (N6, 2026-09-25) disposition ⇔ act_now when the DRAINED
 *                   agent-message turn acted (same vocabulary), ack_only
 *                   otherwise; a coalesce prediction agrees with ack_only
 *                   (the stash rides ChatAgentRunArgs.decision from
 *                   chat-agent.service drainChatQueue via platform/drain-triage.ts).
 *   firing_superseded — (N7, 2026-09-25) the busy-parked firing was WORTH
 *                   firing ⇔ the fired run did real work: a mutating platform
 *                   tool, or a non-noop final with ≥1 evidence-bearing call
 *                   (the delta_material rule). The boolean maps onto the
 *                   Choice vocabulary via PURPOSE_CHOICE_LABELS (true → 'fire',
 *                   false → 'drop_superseded'; a 'merge_into_next' prediction
 *                   agrees with a false actual — both mean "no work lost").
 *                   KNOWN BIAS (review 2026-09-25): 'fire' = "the run did
 *                   work", NOT "the work was needed" — a parked firing that
 *                   merely REPEATS the finished run's sweep and re-reports the
 *                   same facts via send_chat_message labels 'fire', so the
 *                   label is biased toward 'fire' and UNDERSTATES
 *                   drop_superseded precision. Fine for a shadow series;
 *                   before this purpose is ever considered for act it needs
 *                   a secondary signal (final-text similarity to the
 *                   finished run's final, or "no mutating target id the
 *                   finished run did not already touch").
 * A FAILED run evidences nothing about the question → actual:null (paired,
 * unlabelled). Fire-and-forget throughout; never throws into a finalize.
 */

import { PLATFORM_MUTATING_TOOLS } from './platform-tool-names';
import { isEvidenceToolName } from '../coding/evidence-tools';
import { supervisorReportUpIsAction } from '../coding/schedule-cadence';
import { reconstructDecision, recordDecisionOutcome, stashExtra, stashSiblings, type DecisionPurpose, type DecisionStash } from './decision-gate';

/** Mutating platform tools that do NOT count as "acting on the wake": the
 *  supervisor's own state-ledger write happens on every wake by doctrine. */
export const WAKE_ACTION_EXEMPT_TOOLS: ReadonlySet<string> = new Set(['update_supervisor_state']);

const MUTATING_SET: ReadonlySet<string> = new Set(PLATFORM_MUTATING_TOOLS as readonly string[]);

export type NoteKind = 'supervisor_noop' | 'supervisor_action' | 'supervisor_note';

/** Tool names called in a run's transcript parts (chat + coding share the
 *  `{type:'tool_call', name}` part shape) — every call, in order, duplicates kept. */
export function toolNamesCalled(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const p of parts as Array<{ type?: unknown; name?: unknown } | null>) {
    if (p?.type === 'tool_call' && typeof p.name === 'string' && p.name) out.push(p.name);
  }
  return out;
}

/** True when the run executed a mutating platform tool that counts as an action. */
export function tookPlatformAction(toolNames: readonly string[]): boolean {
  return toolNames.some((n) => MUTATING_SET.has(n) && !WAKE_ACTION_EXEMPT_TOOLS.has(n));
}

// ── audit 2026-10-08 W6-3 (P1-10): the "needed a turn" label is HARNESS-only ──
// wake_triage was auto-demoted (10-07 18:24Z, precision 0.727) on a biased
// label: of 23 in-band act-period misses, 7 were HOUSEKEEPING (archive_chat /
// add_knowledge_note — the owner's "archive completed sessions" directive made
// every lane completion an archive turn) and 5 had ZERO mutating calls but
// were labelled acted because the note carried "ACTIONS TAKEN" (c0e22e36
// 14:57 / 15:08, daee2916 21:17, 41bd202a 04:15). The label now counts only a
// mutating action on lanes / goals / schedules / tickets / owner messages:
// housekeeping never counts, a send_chat_message to the run's OWN chat never
// counts, and the model's own ACTIONS TAKEN text never counts. Applies to the
// four "should this supervisor take a turn" purposes (wake_triage,
// sweep_triage, drain_triage, supervisor_turn_noop); rows stamp
// extra.labelSource 'harness_v2' + legacyActed (the old label) so the ruler can
// partition. Kill switch WAKE_TRIAGE_HARNESS_LABEL_DISABLED=1 restores the
// pre-2026-10-08 label byte-for-byte.
/** Mutating platform tools that are HOUSEKEEPING, never "acting on the wake". */
export const WAKE_HOUSEKEEPING_TOOLS: ReadonlySet<string> = new Set([
  'update_supervisor_state', 'archive_chat', 'rename_chat',
  'remember_fact', 'forget_fact', 'add_knowledge_url', 'add_knowledge_note', 'add_knowledge_file',
  'create_canvas', 'update_canvas', 'observe_resource', 'ack_digest_item', 'unack_digest_item',
  'consolidate_memory', 'rebuild_memory', 'stage_upload', 'set_preferences',
]);

/** WAKE_TRIAGE_HARNESS_LABEL_DISABLED=1 — the pre-2026-10-08 label (any mutating tool OR an ACTIONS TAKEN note). */
export function wakeTriageHarnessLabelDisabled(): boolean {
  const s = String(process.env.WAKE_TRIAGE_HARNESS_LABEL_DISABLED ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
}

/** A mutating platform tool that is a real action (not housekeeping). Pure. */
export function isRealActionTool(name: string): boolean {
  return MUTATING_SET.has(name) && !WAKE_HOUSEKEEPING_TOOLS.has(name);
}

/**
 * The run's REAL actions from its transcript parts: mutating platform calls
 * minus housekeeping, minus a send_chat_message addressed to the run's own
 * chat (`sessionId`). Every call, in order, duplicates kept. Pure.
 */
export function realActionToolNames(parts: unknown, sessionId?: string): string[] {
  if (!Array.isArray(parts)) return [];
  const out: string[] = [];
  for (const p of parts as Array<{ type?: unknown; name?: unknown; args?: unknown } | null>) {
    if (p?.type !== 'tool_call' || typeof p.name !== 'string' || !isRealActionTool(p.name)) continue;
    if (p.name === 'send_chat_message' && sessionId) {
      const target = p.args && typeof p.args === 'object' ? String((p.args as { chatId?: unknown }).chatId ?? '') : '';
      if (target && target === sessionId) continue;
    }
    out.push(p.name);
  }
  return out;
}

/** Evidence-bearing tool calls in the run (the zero-tool gate's vocabulary). */
export function evidenceToolCallCount(toolNames: readonly string[]): number {
  return toolNames.filter(isEvidenceToolName).length;
}

export interface MachineRunEvidence {
  toolNames: readonly string[];
  /** Harness classification of the run's final (null when unavailable). */
  noteKind: NoteKind | null;
  /** wake-cadence-5 (fixer 2026-09-27): the run's ONLY mutating platform calls were send_chat_message to the
   *  owner's Fleet Supervisor chat — a REPORT-UP, not lane work. The triage purposes label such a wake as NOT
   *  acted (SUPERVISOR_REPORT_UP_IS_ACTION=1 restores the old label). undefined = not evaluated for this purpose. */
  reportUpOnly?: boolean;
  /** W6-3 (2026-10-08): the run's REAL actions (realActionToolNames — housekeeping and self-sends removed);
   *  absent ⇒ derived from toolNames (housekeeping removed, self-sends not detectable). */
  actionToolNames?: readonly string[];
}

/** The pre-2026-10-08 "acted" label (any mutating tool except the ledger write, OR an ACTIONS TAKEN note). Pure. */
export function legacyWakeActed(ev: MachineRunEvidence): boolean {
  return tookPlatformAction(ev.toolNames) || ev.noteKind === 'supervisor_action';
}

/** wake_triage / sweep_triage / drain_triage (+ the v2 rows): the wake ACTED — a REAL action (W6-3: housekeeping,
 *  self-sends and the note's own ACTIONS TAKEN text never count) — unless its only mutation was a report-up
 *  (wake-cadence-5, fixer 2026-09-27). WAKE_TRIAGE_HARNESS_LABEL_DISABLED=1 restores legacyWakeActed. Pure. */
export function wakeActed(ev: MachineRunEvidence): boolean {
  if (ev.reportUpOnly === true) return false;
  if (wakeTriageHarnessLabelDisabled()) return legacyWakeActed(ev);
  return (ev.actionToolNames ?? ev.toolNames.filter(isRealActionTool)).length > 0;
}

/** The purposes whose label carries the report-up verdict: the three the act-mode gates learn from + the turn pre-triage. */
export const REPORT_UP_LABELLED_PURPOSES: ReadonlySet<string> = new Set(['wake_triage', 'sweep_triage', 'drain_triage', 'supervisor_turn_noop']);

/**
 * PURE over a run's transcript parts: true iff ≥1 send_chat_message targeted
 * `fleetSupervisorChatId` (tool_call part args.chatId — chat and coding parts
 * both carry the parsed args) and NO other mutating platform call landed
 * (update_supervisor_state exempt). A send whose target cannot be read from
 * its args is NOT a report-up (fail toward the old label). Mirrors
 * fleet/attention-watchdog receiptsAreReportUpOnly over receipts.
 */
export function partsAreReportUpOnly(parts: unknown, fleetSupervisorChatId: string): boolean {
  if (!fleetSupervisorChatId || !Array.isArray(parts)) return false;
  let reportUps = 0;
  for (const p of parts as Array<{ type?: unknown; name?: unknown; args?: unknown } | null>) {
    if (p?.type !== 'tool_call' || typeof p.name !== 'string') continue;
    if (!MUTATING_SET.has(p.name) || WAKE_ACTION_EXEMPT_TOOLS.has(p.name)) continue;
    if (p.name !== 'send_chat_message') return false;
    const target = p.args && typeof p.args === 'object' ? String((p.args as { chatId?: unknown }).chatId ?? '') : '';
    if (target !== fleetSupervisorChatId) return false;
    reportUps += 1;
  }
  return reportUps >= 1;
}

/**
 * The run-level report-up verdict for the label site: a free transcript
 * pre-check (only a run whose mutating calls are ALL send_chat_message pays
 * the lookup), then the session's report-up target (supervisor.service
 * reportUpTargetForSession — null for anything but a project-supervisor chat,
 * so a worker lane messaging the fleet never counts). Never throws; false on
 * any failure or under the kill switch.
 */
export async function runReportUpOnly(run: { parts: unknown; sessionId?: string }): Promise<boolean> {
  try {
    if (supervisorReportUpIsAction() || !run.sessionId) return false;
    const mutating = toolNamesCalled(run.parts).filter((n) => MUTATING_SET.has(n) && !WAKE_ACTION_EXEMPT_TOOLS.has(n));
    if (!mutating.length || mutating.some((n) => n !== 'send_chat_message')) return false;
    const mod: { reportUpTargetForSession?: (id: string) => Promise<string | null> } = await import('./supervisor.service');
    const target = typeof mod.reportUpTargetForSession === 'function' ? await mod.reportUpTargetForSession(run.sessionId) : null;
    return target ? partsAreReportUpOnly(run.parts, target) : false;
  } catch {
    return false;
  }
}

/**
 * The `actual` for a purpose from what the finalized run measurably did — the
 * PURE core (tested directly). null = this purpose is not labelled here.
 */
export function deriveMachineRunActual(purpose: DecisionPurpose, ev: MachineRunEvidence): boolean | number | null {
  switch (purpose) {
    case 'wake_effort':
      // agent-decisions prerequisite 1 (2026-09-27): HARNESS-COUNTED label — the
      // deliberation the run measurably needed: 2 ⇔ ≥ WAKE_EFFORT_HARNESS_MIN_EVIDENCE_CALLS
      // evidence-bearing tool calls (coding/evidence-tools vocabulary) OR a mutating
      // platform tool call (an action / escalation); 1 ⇔ it read something (1–2
      // evidence calls) without acting; 0 ⇔ no evidence call at all. The model's
      // own "ACTIONS TAKEN" marker is a CLAIM and no longer labels anything — the
      // old clause survives as shadow telemetry (meta.legacyLabel).
      return deriveWakeEffortHarnessActual(ev);
    case 'wake_triage':
      // wake-cadence-5 (fixer 2026-09-27): a report-up-only wake is NOT acted (wakeActed).
      return wakeActed(ev);
    case 'sweep_triage':
      // N2 (2026-09-25): same vocabulary as wake_triage — the sweep "needed
      // a turn" iff the fired sweep ACTED (a mutating platform tool, or an
      // ACTIONS TAKEN receipt note); a 'SWEEP: no-op' close is the negative.
      return wakeActed(ev);
    case 'delta_material':
      return evidenceToolCallCount(ev.toolNames) >= 1 && ev.noteKind !== 'supervisor_noop';
    case 'drain_triage': // N6 (2026-09-25): the drained turn ACTED ⇒ act_now; otherwise ack_only (MACHINE_RUN_CHOICE_LABELS maps the boolean).
      return wakeActed(ev);
    case 'firing_superseded': // N7 (2026-09-25): the parked firing did real work ⇔ a mutating platform tool OR a non-noop evidenced final
      return tookPlatformAction(ev.toolNames) || (evidenceToolCallCount(ev.toolNames) >= 1 && ev.noteKind !== 'supervisor_noop');
    case 'supervisor_turn_noop':
      // agent-decisions 2026-09-27 (fixer): will_act ⇔ HARNESS evidence that the turn
      // acted — a mutating platform tool call in the transcript (PLATFORM_MUTATING_TOOLS
      // minus update_supervisor_state; every receipt-minting mutation in
      // coding/run-receipts RECEIPT_TOOLS is inside that set, verified 2026-09-27).
      // The model's own "ACTIONS TAKEN" marker is a CLAIM, not evidence: a final that
      // narrates actions with zero tool calls labels FALSE; the note kind rides the
      // row's note only. (The older purposes above keep their marker clause — their
      // rows were fitted and flipped on it; changing them is a partition question.)
      // wake-cadence-5 (fixer 2026-09-27): a report-up-only turn did not act.
      // W6-3 (audit 2026-10-08): housekeeping / self-sends are not acting (wakeActed's harness rule).
      if (wakeTriageHarnessLabelDisabled()) return ev.reportUpOnly !== true && tookPlatformAction(ev.toolNames);
      return wakeActed({ ...ev, noteKind: null });
    default:
      return null;
  }
}

/** The question key each labelled purpose asked (decision sites' vocabulary). */
export const PURPOSE_QUESTION: Partial<Record<DecisionPurpose, string>> = {
  wake_triage: 'needs_turn_now',
  delta_material: 'material',
  sweep_triage: 'needs_turn_now',
  // checker_route (N4): NO machine-run label — chat-agent/checker-route-gate.ts recordCheckerRouteOutcome labels depth / needs_live_web at the chat finalize.
  drain_triage: 'disposition',
  firing_superseded: 'disposition', // N7 (2026-09-25) — a Choice; PURPOSE_CHOICE_LABELS maps the boolean label onto its keys
  wake_effort: 'deliberation',
  supervisor_turn_noop: 'will_act', // agent-decisions 2026-09-27 — the probe `has_new_input` is labelled at decision time (platform/supervisor-turn-noop.ts), never here
};

/** N6 (2026-09-25): purposes whose machine-run label is a CHOICE key derived
 *  from the boolean "the run acted" — `true` / `false` name the actual, and
 *  `alsoAgreesWithFalse` lists predictions that AGREE with the false actual
 *  (a `coalesce` hold is not observable from one run, like wake_triage's). */
export const MACHINE_RUN_CHOICE_LABELS: Partial<Record<DecisionPurpose, { true: string; false: string; alsoAgreesWithFalse?: readonly string[] }>> = {
  drain_triage: { true: 'act_now', false: 'ack_only', alsoAgreesWithFalse: ['coalesce'] },
};

/** Purposes whose question is a CHOICE but whose run-derived label is a boolean
 *  (deriveMachineRunActual): `positive` is the key a true label means, `negative`
 *  the key a false label means, `alsoNegative` further keys that AGREE with a
 *  false label (not distinguishable from one run). Additive registry — one line
 *  per purpose. */
export const PURPOSE_CHOICE_LABELS: Partial<Record<DecisionPurpose, { positive: string; negative: string; alsoNegative?: readonly string[] }>> = {
  firing_superseded: { positive: 'fire', negative: 'drop_superseded', alsoNegative: ['merge_into_next'] }, // N7 (2026-09-25)
};

/** The outcome-row `actual` (in the choice vocabulary) and explicit agreement for a
 *  boolean-labelled CHOICE purpose. `agreed` is undefined when the stash carries no
 *  choice answer for the question. Pure. */
export function choiceLabelFor(purpose: DecisionPurpose, predicted: string | null, actual: boolean): { actualKey: string; agreed?: boolean } | null {
  const map = PURPOSE_CHOICE_LABELS[purpose];
  if (!map) return null;
  const actualKey = actual ? map.positive : map.negative;
  if (predicted === null) return { actualKey };
  const negative = predicted === map.negative || (map.alsoNegative ?? []).includes(predicted);
  const agreed = predicted === map.positive ? actual : negative ? !actual : false;
  return { actualKey, agreed };
}

// ── wake_triage v2 (E7, 2026-09-25) — the fan-out's run-derived labels ──────
// The v2 request (wake-triage-request.ts) adds `disposition` (choice) and
// `urgency` (score) next to `needs_turn_now`; the two batch-property nouls
// (`addressed_to_supervisor`, `contains_failure_or_block`) are labelled at
// decision time from the code flags and never reach this finalize. Labels
// here are HARNESS-derived from the same evidence as needs_turn_now:
//   disposition — escalate_owner ⇔ the run reached the owner
//                 (WAKE_OWNER_ESCALATION_TOOLS); act_now ⇔ it acted on the
//                 wake (mutating platform tool or ACTIONS TAKEN note); ack
//                 otherwise. `coalesce` is not observable from one run, so a
//                 `coalesce` prediction AGREES with an `ack` actual (both are
//                 "no turn needed now") — `agreed` is passed explicitly.
//   urgency     — the level the run's behaviour evidences: 3 escalated to
//                 the owner, 2 acted, 1 wrote a substantive note without
//                 acting, 0 no-op.
/** Mutating platform tools that reach the human owner (an escalation, not a supervisor action). */
export const WAKE_OWNER_ESCALATION_TOOLS: ReadonlySet<string> = new Set(['flag_owner_question', 'notify_user']);

export type WakeDispositionActual = 'ack' | 'act_now' | 'escalate_owner';

/** The v2 run-derived labels; null when the run evidences nothing (failed). Pure. */
export function deriveWakeTriageV2Actuals(ev: MachineRunEvidence): { disposition: WakeDispositionActual; urgency: 0 | 1 | 2 | 3 } {
  const escalated = ev.toolNames.some((n) => WAKE_OWNER_ESCALATION_TOOLS.has(n));
  const acted = wakeActed(ev);
  const disposition: WakeDispositionActual = escalated ? 'escalate_owner' : acted ? 'act_now' : 'ack';
  const urgency = escalated ? 3 : acted ? 2 : ev.noteKind === 'supervisor_note' ? 1 : 0;
  return { disposition, urgency };
}

/** N9: the highest deliberation level the wake_effort consumer still lowers effort on (mirrors ACT_POLICIES.wake_effort.maxScore). */
export const WAKE_EFFORT_ACT_MAX_SCORE = 1;

// ── wake_effort HARNESS label (agent-decisions prerequisite 1, 2026-09-27) ──
// The judge's readout: `wake_effort` was fitted (45 % agreed, 1,012 labels)
// against a noteKind PROXY — `labelMachineRunOutcome` accepted the model's
// "ACTIONS TAKEN" marker as evidence of deliberation, so a wake that narrated
// actions with zero tool calls labelled 2. The label is now HARNESS-COUNTED
// from the transcript alone (design §2.3 wake_deliberation): the run needed
// deliberation ⇔ it made ≥ WAKE_EFFORT_HARNESS_MIN_EVIDENCE_CALLS
// evidence-bearing calls (coding/evidence-tools — the zero-tool gate's exact
// vocabulary, update_supervisor_state included) or fired a mutating platform
// tool (PLATFORM_MUTATING_TOOLS minus the ledger write). Below the bar the
// 0/1 split (nothing read / something read) is informational — the
// consumer's binary call (wakeEffortAgreed) keys on ≤ 1 vs 2 only.
// Every row stamps meta.labelSource:'harness' + meta.legacyLabel (the N9
// proxy, shadow telemetry) + meta.evidenceCalls so the two series can be
// compared.
/** Evidence-bearing calls that make a wake "needed deliberation" (the design's ≥ 3). */
export const WAKE_EFFORT_HARNESS_MIN_EVIDENCE_CALLS = 3;

/** The N9 proxy (pre-2026-09-27 acting label; now shadow telemetry only — meta.legacyLabel): 2 acted / escalated (mutating tool OR ACTIONS TAKEN note), 1 substantive note, 0 no-op. Pure. */
export function deriveWakeEffortLegacyActual(ev: MachineRunEvidence): 0 | 1 | 2 {
  // W6-3 (2026-10-08): the N9 proxy keeps its own pre-2026-10-08 "acted" (mutating OR ACTIONS TAKEN) — byte-identical.
  const escalated = ev.toolNames.some((n) => WAKE_OWNER_ESCALATION_TOOLS.has(n));
  if (escalated) return 2;
  const acted = ev.reportUpOnly !== true && legacyWakeActed(ev);
  return acted ? 2 : ev.noteKind === 'supervisor_note' ? 1 : 0;
}

/** The harness-counted label: 2 ⇔ ≥ min evidence calls OR a mutating platform tool; 1 ⇔ ≥ 1 evidence call; 0 otherwise. Pure — never reads the note. */
export function deriveWakeEffortHarnessActual(ev: MachineRunEvidence): 0 | 1 | 2 {
  const evidence = evidenceToolCallCount(ev.toolNames);
  if (evidence >= WAKE_EFFORT_HARNESS_MIN_EVIDENCE_CALLS || tookPlatformAction(ev.toolNames)) return 2;
  return evidence >= 1 ? 1 : 0;
}

/**
 * The harness facts a machine-run outcome row carries next to its label
 * (meta.* via the consumer-extra budget). Pure; exported for tests.
 *   wake_effort           — labelSource ('harness' | 'legacy'), legacyLabel
 *                           (the N9 proxy, always), evidenceCalls.
 *   wake_triage / sweep_triage / drain_triage — harnessActed: the transcript
 *                           holds a mutating platform tool call. Their ACTING
 *                           label is UNCHANGED (they were fitted and flipped
 *                           on the "mutating tool OR ACTIONS TAKEN note"
 *                           clause; relabelling an act purpose is a
 *                           partition question for the ruler) — the field
 *                           only makes the marker-only share measurable.
 */
export function machineRunLabelExtras(purpose: DecisionPurpose, ev: MachineRunEvidence): Record<string, unknown> {
  switch (purpose) {
    case 'wake_effort':
      return {
        labelSource: 'harness',
        legacyLabel: deriveWakeEffortLegacyActual(ev),
        evidenceCalls: evidenceToolCallCount(ev.toolNames),
      };
    case 'wake_triage':
    case 'sweep_triage':
    case 'drain_triage':
      return {
        harnessActed: tookPlatformAction(ev.toolNames), ...(ev.reportUpOnly === true ? { reportUpOnly: true } : {}),
        // W6-3 (audit 2026-10-08): which label definition produced `actual` + the old label beside it.
        labelSource: wakeTriageHarnessLabelDisabled() ? 'legacy' : 'harness_v2', legacyActed: ev.reportUpOnly !== true && legacyWakeActed(ev),
      };
    case 'supervisor_turn_noop':
      return { ...(ev.reportUpOnly === true ? { reportUpOnly: true } : {}), labelSource: wakeTriageHarnessLabelDisabled() ? 'legacy' : 'harness_v2' };
    default:
      return {};
  }
}

/** N9 agreement for the deliberation score: both sides of the consumer's binary call (level ≤ 1 ⇒ 'high' suffices; 2 ⇒ keep 'max'). undefined when the answer is not a score. */
export function wakeEffortAgreed(answer: { type: string; score?: number } | undefined, actual: number): boolean | undefined {
  if (!answer || answer.type !== 'score' || typeof answer.score !== 'number' || !Number.isFinite(answer.score)) return undefined;
  return (Math.round(answer.score) <= WAKE_EFFORT_ACT_MAX_SCORE) === (Math.round(actual) <= WAKE_EFFORT_ACT_MAX_SCORE);
}

/** Agreement for the disposition choice: exact, or `coalesce` predicted against an `ack` actual. */
export function wakeDispositionAgreed(predicted: string, actual: WakeDispositionActual): boolean {
  return predicted === actual || (predicted === 'coalesce' && actual === 'ack');
}

/**
 * Record the deferred outcome for a stash the run carried. Called from the
 * chat finalize (chat-agent.service) and the coding finalize (run-executor);
 * both fire-and-forget it. Never throws.
 */
export async function labelMachineRunOutcome(
  stash: unknown,
  run: {
    parts: unknown; finalText: string; sessionId?: string; failed?: boolean;
    /** N9: the consumer ACTED on this decision (wake_effort applied a lower effort) — the outcome row's `acted`. */
    acted?: boolean;
    /** N9: appended to the note (run length / cost / the effort applied) — harness-measured, never model-claimed. */
    extraNote?: string;
  },
): Promise<void> {
  // agent-decisions 2026-09-27: a stash may carry SIBLINGS (DecisionStash.also — a
  // second purpose asked at the same site while both are shadow); each is
  // labelled from the same run evidence, one level deep, each in its own try.
  for (const sibling of stashSiblings(stash)) await labelOneMachineRunOutcome(sibling, run);
  await labelOneMachineRunOutcome(stash, run);
}

async function labelOneMachineRunOutcome(stash: unknown, run: Parameters<typeof labelMachineRunOutcome>[1]): Promise<void> {
  try {
    const decision = reconstructDecision(stash);
    if (!decision) return;
    const question = PURPOSE_QUESTION[decision.purpose];
    if (!question) return;
    // agent-decisions 2026-09-27: consumer meta the stash carried (e.g. supervisor_turn_noop { origin, control }) rides every row it writes.
    const extra = stashExtra(stash);
    // fixer 2026-09-27: a consumer whose act rule could never have skipped this turn
    // (supervisor_turn_noop pins — new input / alarm / cap bypass / user row waiting)
    // stamps `pinned:true` on its stash; the row is a measured fact but NOT a label the
    // fit / readiness ruler / auto-demote window may learn from (meta.excludeFromFit) —
    // the band then holds only turns the consumer could act on.
    const withExtra = { ...(Object.keys(extra).length ? { extra } : {}), ...(extra.pinned === true ? { excludeFromFit: true as const } : {}) };
    if (run.failed) {
      recordDecisionOutcome(decision, decision.purpose, { question, actual: null, acted: run.acted === true, sessionId: run.sessionId, note: `run failed — outcome unknown${run.extraNote ? `; ${run.extraNote}` : ''}`, ...withExtra });
      return;
    }
    const toolNames = toolNamesCalled(run.parts);
    let noteKind: NoteKind | null = null;
    try {
      // Dynamic: supervisor.service pulls prisma + the platform graph; this
      // leaf must stay importable from both the chat and the coding finalize.
      const { classifySupervisorNote } = await import('./supervisor.service');
      noteKind = classifySupervisorNote(run.finalText);
    } catch { noteKind = null; }
    // wake-cadence-5 (fixer 2026-09-27): the report-up verdict rides the evidence
    // of the purposes the act-mode gates learn from — a project-supervisor wake
    // whose only mutation was a send to the Fleet Supervisor labels NOT acted.
    const reportUpOnly = REPORT_UP_LABELLED_PURPOSES.has(decision.purpose) ? await runReportUpOnly(run) : undefined;
    // W6-3 (audit 2026-10-08): the run's REAL actions (housekeeping + self-sends removed) ride the evidence.
    const ev: MachineRunEvidence = { toolNames, noteKind, actionToolNames: realActionToolNames(run.parts, run.sessionId), ...(reportUpOnly !== undefined ? { reportUpOnly } : {}) };
    const derived = deriveMachineRunActual(decision.purpose, ev);
    // agent-decisions prerequisite 1 (2026-09-27): the harness facts ride the
    // row's consumer-extra budget (labelSource / legacyLabel / evidenceCalls
    // on wake_effort; harnessActed on the three triage purposes) — merged
    // UNDER the stash's own extra so a consumer key of the same name wins.
    const labelExtras = machineRunLabelExtras(decision.purpose, ev);
    const rowExtra = { ...labelExtras, ...(withExtra.extra ?? {}) };
    const rowMeta = { ...withExtra, ...(Object.keys(rowExtra).length ? { extra: rowExtra } : {}) };
    const mutating = toolNames.filter((n) => MUTATING_SET.has(n) && !WAKE_ACTION_EXEMPT_TOOLS.has(n));
    const note = `finalized: ${noteKind ?? 'unclassified'}; mutating ${mutating.length}${mutating.length ? ` (${[...new Set(mutating)].slice(0, 4).join(',')})` : ''}; evidence ${evidenceToolCallCount(toolNames)}${reportUpOnly ? '; report-up only' : ''}${run.extraNote ? `; ${run.extraNote}` : ''}`;
    // ONE outcome row per question. N6: a CHOICE-labelled purpose (MACHINE_RUN_CHOICE_LABELS) maps the boolean
    // onto its option keys and passes agreement explicitly (a hold prediction agrees with a quiet run). N7: a
    // CHOICE purpose with a boolean run label (PURPOSE_CHOICE_LABELS / choiceLabelFor) records the actual in the
    // choice vocabulary with explicit agreement the same way. N9: a score purpose's `agreed` is the BINARY call
    // the consumer makes (level ≤ maxScore ⇔ lower effort was right), not exact-level equality — the same
    // semantic-agreement rule as wakeDispositionAgreed (coalesce vs ack); agreedAtCutoff on the row carries the
    // act-band view. Nouls record as before.
    const stashedAnswer = decision.answers[question];
    let actual: string | boolean | number | null = derived;
    let agreed: boolean | undefined;
    const choiceMap = MACHINE_RUN_CHOICE_LABELS[decision.purpose];
    if (choiceMap && typeof derived === 'boolean' && stashedAnswer?.type === 'choice') {
      actual = derived ? choiceMap.true : choiceMap.false;
      agreed = stashedAnswer.choice === actual || (!derived && (choiceMap.alsoAgreesWithFalse ?? []).includes(stashedAnswer.choice));
    } else if (typeof derived === 'boolean') {
      const choiceLabel = choiceLabelFor(decision.purpose, stashedAnswer?.type === 'choice' ? stashedAnswer.choice : null, derived);
      if (choiceLabel) {
        actual = choiceLabel.actualKey;
        if (choiceLabel.agreed !== undefined) agreed = choiceLabel.agreed;
      }
    } else if (decision.purpose === 'wake_effort' && typeof derived === 'number') {
      agreed = wakeEffortAgreed(stashedAnswer, derived);
    }
    recordDecisionOutcome(decision, decision.purpose, { question, actual, acted: run.acted === true, sessionId: run.sessionId, note, ...(agreed !== undefined ? { agreed } : {}), ...rowMeta });
    if (decision.purpose === 'wake_triage') labelWakeTriageV2(decision, ev, run.sessionId, note);
  } catch { /* labels never break a finalize */ }
}

/** E7: the extra outcome rows for a v2 wake_triage stash (a v1 stash answered neither key → no rows). Never throws. */
function labelWakeTriageV2(decision: ReturnType<typeof reconstructDecision> & object, ev: MachineRunEvidence, sessionId: string | undefined, baseNote: string): void {
  try {
    const d = decision.answers.disposition;
    const u = decision.answers.urgency;
    if (!d && !u) return;
    const v2 = deriveWakeTriageV2Actuals(ev);
    if (d && d.type === 'choice') {
      recordDecisionOutcome(decision, 'wake_triage', {
        question: 'disposition', actual: v2.disposition, acted: false, sessionId,
        agreed: wakeDispositionAgreed(d.choice, v2.disposition), note: baseNote,
      });
    }
    if (u && u.type === 'score') {
      recordDecisionOutcome(decision, 'wake_triage', { question: 'urgency', actual: v2.urgency, acted: false, sessionId, note: baseNote });
    }
  } catch { /* labels never break a finalize */ }
}

// ── Compute policy (2026-09-26, docs/DEPTH_UX_SOTA_2026-09-26.md §4 D2) ──────
// The labels for the three compute-policy purposes are USER-BEHAVIOUR and
// HARNESS facts, never a model's self-report (Cheap Verifiers, Large Blind
// Spots — the checker's own "agrees" is never a label):
//   compute_policy  — question `depth` (the act question): the PRIMARY label is
//                     `escalated` (a Dig-deeper tap ≤ 30 min on that message),
//                     written EXACTLY ONCE per decision — at the tap
//                     (escalated:true) or when the 30-min window CLOSES with no
//                     tap (escalated:false + windowClosed:true). The finalize
//                     writes the facts-only `facts` row instead (never
//                     `escalated`): the readiness ruler keeps the EARLIEST
//                     `escalated` row per decision, so a finalize-time
//                     escalated:false would hide every later tap (review
//                     2026-09-26 — labelComputePolicyOutcome refuses it).
//                     Secondary rows `escalated_late` (a tap AFTER the 30-min
//                     window — cp/labels 2026-09-26: written instead of
//                     nothing, never the fit's label), `facts`, `reask_5m`,
//                     `thumbs`, `revision_material`, `checker_skipped_material`
//                     (meta.label tells them apart; OUTCOME_LABEL_FOR_FIT keeps
//                     `escalated` for the fit AND for the act-band precision
//                     window — decision-gate recordDecisionOutcome applies
//                     outcomeLabelEntersFit before noteActBandOutcome, so the
//                     secondary rows never feed the auto-demote window). The
//                     readiness RULER (decision-gate-fit pairing) additionally
//                     admits a decision's `facts` row as the window-closed
//                     negative once it is older than the escalation window and
//                     no `escalated` row exists (OUTCOME_LABEL_FALLBACK_FOR_FIT)
//                     — the same actual a windowClosed row would carry. The
//                     `research_request` noul is labelled on the escalated row
//                     (tap to research / the user picked the L3 preset). Every
//                     row stamps `meta.source` (ComputePolicyLabelSource).
//   drafts_agree    — `agree` ⇔ the reconcile did NOT change a material claim.
//   revision_material — `material` ⇔ the user thumbed down or escalated after
//                     the revision (the change mattered to them).
// Each writer takes the decision STASH the plan carried (compute-policy-gate
// DepthPlan.stash, or the contract fields decisionId / mode / answers via
// computePlanStash) so the row pairs with its decision row by id.

import logger from '../../../utils/logger';
import { CHECKER_SIMPLE_MAX_FINAL_CHARS, deriveCheckerDepthActual, type CheckerDepth } from '../chat-agent/checker-route-gate';
import { computePlanStash, DEPTH_QUESTION, DRAFTS_AGREE_QUESTION, RESEARCH_REQUEST_QUESTION, REVISION_MATERIAL_QUESTION, type DepthPreset } from './compute-policy-gate';

export type ComputePolicyLabel = 'escalated' | 'escalated_late' | 'facts' | 'reask_5m' | 'thumbs' | 'revision_material' | 'checker_skipped_material' | 'machine';
export const COMPUTE_POLICY_LABELS: readonly ComputePolicyLabel[] = ['escalated', 'escalated_late', 'facts', 'reask_5m', 'thumbs', 'revision_material', 'checker_skipped_material', 'machine'];

// ── backlog DOI-21 (2026-09-28): the MACHINE / SUPERVISOR label ──────────────
// A supervisor-chat or machine-origin turn shows no Dig-deeper chip, receives
// no thumbs and is never re-asked, so its compute_policy decision (93 % of the
// purpose's volume) could never be labelled — the segment partition could never
// reach READY. The window closer now writes ONE `machine` row per such decision
// once the escalation window has passed, with a HARNESS-DERIVABLE PROXY for the
// right depth (deriveMachineDepthProxy):
//   contestable  — the late reconcile REWROTE the answer (pill 'updated'), or the
//                  checker merged a changed claim, or the turn made ≥ 3 lead tool
//                  calls (research-grade work — the same "≥ 3 evidence-bearing
//                  calls" tier wake_effort's harness label uses for score 2);
//   ordinary     — 1–2 lead tool calls, or a long final with none;
//   simple_lookup — no tool call and a short final (≤ CHECKER_SIMPLE_MAX_FINAL_CHARS).
// Rows are `excludeFromFit` until COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS (30) of
// them exist (the closer counts once per pass) so the first handful never
// decides a partition; MACHINE_SEGMENT_LABEL_FOR_FIT (decision-gate-fit) admits
// them to the segment's own fit.
export const COMPUTE_POLICY_MACHINE_LABEL: ComputePolicyLabel = 'machine';
export const COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS_DEFAULT = 30;
export const MACHINE_DEPTH_CONTESTABLE_MIN_TOOL_CALLS = 3;
/** COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS (default 30, clamped 0..10000): machine rows are excludeFromFit until this many exist. */
export function computePolicyMachineLabelMinRows(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS);
  if (!Number.isFinite(n) || n < 0) return COMPUTE_POLICY_MACHINE_LABEL_MIN_ROWS_DEFAULT;
  return Math.min(10_000, Math.floor(n));
}
/** The machine-turn depth proxy (pure; see the block above). null only when no facts were persisted. */
export function deriveMachineDepthProxy(facts: Pick<ComputePolicyTurnFacts, 'leadToolCalls' | 'finalChars' | 'checkerMerged'> | null | undefined, checkState?: string | null): 'simple_lookup' | 'ordinary' | 'contestable' | null {
  if (!facts) return null;
  if (checkState === 'updated') return 'contestable';
  if (facts.leadToolCalls >= MACHINE_DEPTH_CONTESTABLE_MIN_TOOL_CALLS) return 'contestable';
  if (facts.checkerMerged && facts.leadToolCalls > 0) return 'contestable';
  if (facts.leadToolCalls > 0) return 'ordinary';
  return facts.finalChars <= CHECKER_SIMPLE_MAX_FINAL_CHARS ? 'simple_lookup' : 'ordinary';
}
/**
 * Where a compute-policy label came from (cp/labels 2026-09-26) — stamped on
 * the row (`meta.source`) and in the note so the readiness ruler / a reviewer
 * can tell the writers apart: the chat finalize (`facts`), the Dig-deeper tap
 * handler (`escalated` ≤ 30 min / `escalated_late` after), the next-human-turn
 * hook (`reask_5m`), the thumbs feedback handler (`thumbs`), the late check
 * (`revision_material` / `checker_skipped_material`) and a future window
 * closer (`escalated` false + windowClosed).
 */
export type ComputePolicyLabelSource = 'finalize' | 'dig_deeper' | 'dig_deeper_late' | 'reask' | 'feedback' | 'late_check' | 'window_close';
/** Harness-measured turn stats the finalize `facts` row carries beside the facts (never a model's claim). */
export interface ComputePolicyTurnStats {
  ttftMs?: number;
  completionMs?: number;
  spentUsd?: number;
  /** The plan's council ('none' | 'background') — the deep_research preset's inline council is the preset itself. */
  council?: string;
  /** The pill state the turn ended in (metadata.check.state) — 'updated' = a material late revision landed by finalize. */
  checkState?: string;
  /** A Dig-deeper run's rung ('verify' | 'research'); absent on a first send. */
  escalationRung?: string;
}
/** The ONE label the fit / readiness / act-band window read for compute_policy (mirrors decision-gate-fit OUTCOME_LABEL_FOR_FIT). */
export const COMPUTE_POLICY_PRIMARY_LABEL: ComputePolicyLabel = 'escalated';
/** The escalation label window (a tap after this is a new question, not a label). */
export const COMPUTE_POLICY_ESCALATION_WINDOW_MS = 30 * 60_000;
export const COMPUTE_POLICY_REASK_WINDOW_MS = 5 * 60_000;

/** What the finalized turn measurably did (harness facts; the checker-route vocabulary). */
export interface ComputePolicyTurnFacts {
  leadToolCalls: number;
  webToolCalls: number;
  finalChars: number;
  /** A Double Checker ran on this message (spawned by the plan or an escalation). */
  checkerSpawned: boolean;
  /** The checker's draft was reconciled into THIS answer (inline or late). */
  checkerMerged: boolean;
  /** The reasoning_effort the checker ACTUALLY received (audit 2026-09-26 budgets-cost-2). */
  checkerEffortSent?: 'high' | 'max';
  /** H2 (2026-09-26): a background council's lead reached DepthBudget.maxBackgroundMs and answered via the FINAL-TURN collapse (absent ⇒ never fired). */
  backgroundDeadlineHit?: boolean;
}

export interface ComputePolicyLabelEvent {
  label: ComputePolicyLabel;
  facts?: ComputePolicyTurnFacts | null;
  /** escalated: the user tapped Dig deeper ≤ 30 min; `escalatedTo` = the rung the tap asked for. */
  escalated?: boolean;
  escalatedTo?: 'verify' | 'research' | null;
  /**
   * escalated: how `escalatedTo` was picked — 'forced' = the server's next-rung
   * rule (today's single Dig deeper chip), 'chosen' = the user picked the rung on
   * an explicit chip. A forced rung never labels research_request (audit
   * 2026-09-26); rides meta.rungChoice so the ruler can tell the rows apart.
   */
  rungChoice?: 'forced' | 'chosen';
  /** escalated: the 30-min window closed with NO tap — the only way an `escalated:false` row may be written (the finalize uses label `facts`). */
  windowClosed?: boolean;
  /** reask_5m: the user re-asked (a new human turn in the same chat ≤ 5 min that the harness classed as a re-ask). */
  reasked?: boolean;
  /** reask_5m: a late-check ADDENDUM sat between the answer and the re-ask (the user may be reacting to the correction, not the answer). */
  afterAddendum?: boolean;
  /** thumbs: the user's rating on the message (+ the reason chip). */
  thumbs?: 'up' | 'down' | null;
  thumbsReason?: string | null;
  /** revision_material / checker_skipped_material: the (late or escalated) check changed a material claim (decideRevisionMaterial / the diff). */
  material?: boolean | null;
  /** The preset the send carried (deep_research ⇒ the user asked for research). */
  requestedPreset?: DepthPreset;
  sessionId?: string;
  /** The turn failed (empty finalize) — evidences nothing. */
  failed?: boolean;
  /** The consumer ACTED on this decision (checker skipped / stakes wait / council started). */
  acted?: boolean;
  /** Which writer produced this label (cp/labels 2026-09-26) — rides meta.source + the note. */
  source?: ComputePolicyLabelSource;
  /** Harness turn stats for the finalize `facts` row (ttft / completion / spend / council / pill). */
  turn?: ComputePolicyTurnStats | null;
  /** A guest (anonymous) turn — a guest can never escalate, so the ruler keeps these out of the window-closed-negative rule (audit 2026-09-26 guest-persistence-2). */
  guest?: boolean;
  /** The sender segment (user / guest / supervisor / machine / telegram) — rides the row so the ruler can partition. */
  segment?: string;
  /** The predicted depth the window closer judges an UNTAPPED acted decision by (audit 2026-09-26 telemetry-readiness-1: silence on an acted skip = the skip stood). */
  actualOverride?: string | null;
  /** 2026-09-26 (audit): the row is a measured fact but NOT a fit / readiness label (a `facts` row on a turn whose
   *  Dig-deeper chip was never shown — no `escalated:true` can ever pair with it). Rides meta.excludeFromFit. */
  excludeFromFit?: boolean;
}

type DepthActual = Exclude<CheckerDepth, 'unclear'>;
const DEPTH_ORDER: Record<DepthActual, number> = { simple_lookup: 0, ordinary: 1, contestable: 2 };

/** Thumbs-down reasons that say "too slow / too much", not "wrong" — they never bump the depth. */
export const THUMBS_SLOW_REASONS: ReadonlySet<string> = new Set(['slow', 'too_slow', 'too_long', 'verbose']);

/**
 * The depth the turn evidences for `label` (pure). Base = the checker-route
 * derivation from the harness facts (simple_lookup ⇔ no tool round + short
 * final; heavy + merged ⇒ contestable; heavy + unmerged ⇒ unknown; else
 * ordinary). A "wanted more" signal (tap / re-ask / thumbs-down-wrong /
 * material revision) BUMPS it: to `ordinary` when no checker ran (the user
 * wanted verification), to `contestable` when one did (they wanted more than
 * a check) or when the tap asked for research. A wording-only reconcile caps
 * it at `ordinary`; a right skip (`checker_skipped_material` false) is
 * `simple_lookup`. null = unknown.
 */
export function deriveComputePolicyDepthActual(ev: ComputePolicyLabelEvent): DepthActual | null {
  const f = ev.facts;
  const base: DepthActual | null = f
    ? deriveCheckerDepthActual({ regexSimple: false, leadToolCalls: f.leadToolCalls, webToolCalls: f.webToolCalls, finalChars: f.finalChars, checkerMerged: f.checkerMerged, lateArmed: false })
    : null;
  const checkerRan = !!f?.checkerSpawned;
  const bumpTo = (): DepthActual => (checkerRan || ev.escalatedTo === 'research' ? 'contestable' : 'ordinary');
  const max = (a: DepthActual | null, b: DepthActual): DepthActual => (a && DEPTH_ORDER[a] > DEPTH_ORDER[b] ? a : b);
  const min = (a: DepthActual | null, b: DepthActual): DepthActual => (a && DEPTH_ORDER[a] < DEPTH_ORDER[b] ? a : b);
  switch (ev.label) {
    case 'escalated':
    case 'escalated_late': // a tap after the window is still "wanted more" — a SECONDARY row, never the fit's label
      return ev.escalated ? max(base, bumpTo()) : base;
    case 'facts':
      return base;
    case 'reask_5m':
      return ev.reasked ? max(base, bumpTo()) : base;
    case 'thumbs':
      if (ev.thumbs === 'down' && !THUMBS_SLOW_REASONS.has(String(ev.thumbsReason ?? '').toLowerCase())) return max(base, bumpTo());
      return base;
    case 'revision_material':
      if (ev.material === true) return 'contestable';
      if (ev.material === false) return min(base, 'ordinary');
      return base;
    case 'checker_skipped_material':
      if (ev.material === true) return 'contestable';
      if (ev.material === false) return 'simple_lookup';
      return base;
    default:
      return base;
  }
}

/** COMPUTE_POLICY_RESEARCH_LABEL_FORCED_RUNG=1 — the pre-audit derivation: a Dig-deeper tap labels research_request from the rung the SERVER chose. */
export function researchLabelFromForcedRung(): boolean {
  const v = String(process.env.COMPUTE_POLICY_RESEARCH_LABEL_FORCED_RUNG ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * The `research_request` actual on the escalated row — or null when the
 * event carries NO signal about what the question asks ("the MESSAGE
 * explicitly asks for a research job", compute-policy-gate). Audit
 * 2026-09-26 (telemetry-readiness-8): the rung a Dig-deeper tap runs is the
 * server's next-rung rule (nextRungForMessage — an L2 row ⇒ 'research'),
 * never the user's wish, so a FORCED-rung tap says nothing and writes no row
 * (before: every L2 tap labelled research_request:true — a near-guaranteed
 * high-confidence disagreement that doubled the ruler's n). The row is
 * written only when the signal reflects the question: the send carried the
 * L3 preset (true); the user CHOSE the rung on an explicit chip
 * (`rungChoice:'chosen'` — no such chip exists today; true ⇔ research); or
 * the 30-min window closed untapped (false). Pure.
 */
export function deriveResearchRequestActual(ev: ComputePolicyLabelEvent): boolean | null {
  if (ev.requestedPreset === 'deep_research') return true;
  if (ev.escalated === true) {
    if (ev.rungChoice === 'chosen' || researchLabelFromForcedRung()) return ev.escalatedTo === 'research';
    return null;
  }
  if (ev.escalated === false && ev.windowClosed === true) return false;
  return null;
}

function computePolicyNote(ev: ComputePolicyLabelEvent): string {
  const f = ev.facts;
  const facts = f ? `tools:${f.leadToolCalls}; web:${f.webToolCalls}; chars:${f.finalChars}; checker:${f.checkerSpawned ? 1 : 0}; merged:${f.checkerMerged ? 1 : 0}` : 'facts:none';
  const sig = ev.label === 'escalated' ? `escalated:${ev.escalated ? 1 : 0}${ev.escalatedTo ? `→${ev.escalatedTo}` : ''}${ev.escalated && ev.rungChoice ? ` (${ev.rungChoice} rung)` : ''}${!ev.escalated && ev.windowClosed ? ' (window closed)' : ''}`
    : ev.label === 'escalated_late' ? `late tap${ev.escalatedTo ? `→${ev.escalatedTo}` : ''} (after the window — secondary)`
    : ev.label === 'facts' ? `facts only${ev.turn?.checkState ? `; check:${ev.turn.checkState}` : ''}${ev.excludeFromFit ? '; no chip (excluded from fit)' : ''}`
    : ev.label === 'reask_5m' ? `reasked:${ev.reasked ? 1 : 0}${ev.afterAddendum ? ' (after addendum)' : ''}`
    : ev.label === 'thumbs' ? `thumbs:${ev.thumbs ?? '—'}${ev.thumbsReason ? `/${String(ev.thumbsReason).slice(0, 24)}` : ''}`
    : ev.label === 'machine' ? `machine proxy${ev.turn?.checkState ? `; check:${ev.turn.checkState}` : ''}${ev.excludeFromFit ? ' (ramp — excluded from fit)' : ''}`
    : `material:${ev.material === true ? 1 : ev.material === false ? 0 : '—'}`;
  return `${ev.label}${ev.source ? ` src:${ev.source}` : ''}; ${sig}; ${facts}${ev.requestedPreset ? `; preset:${ev.requestedPreset}` : ''}${ev.acted ? '; acted' : ''}`;
}

/** The bounded turn-stat keys the finalize row carries (recordDecisionOutcome keeps the FIRST 16 extra keys — order matters). */
function turnExtra(turn: ComputePolicyTurnStats | null | undefined): Record<string, number | string> {
  if (!turn) return {};
  const out: Record<string, number | string> = {};
  if (typeof turn.ttftMs === 'number' && Number.isFinite(turn.ttftMs)) out.ttftMs = Math.round(turn.ttftMs);
  if (typeof turn.completionMs === 'number' && Number.isFinite(turn.completionMs)) out.completionMs = Math.round(turn.completionMs);
  if (typeof turn.spentUsd === 'number' && Number.isFinite(turn.spentUsd)) out.spentUsd = Number(turn.spentUsd.toFixed(4));
  if (turn.council) out.council = String(turn.council).slice(0, 20);
  if (turn.escalationRung) out.escalationRung = String(turn.escalationRung).slice(0, 20);
  return out;
}

/** A stash or a DepthPlan (contract fields) → the decision to label against. */
function decisionFrom(stashOrPlan: unknown): ReturnType<typeof reconstructDecision> {
  const direct = reconstructDecision(stashOrPlan);
  if (direct) return direct;
  const p = stashOrPlan as { decisionId?: unknown } | null;
  if (p && typeof p === 'object' && typeof p.decisionId === 'string') return reconstructDecision(computePlanStash(p as any));
  return null;
}

/**
 * True when an `escalated` event may NOT be written: escalated:false without
 * `windowClosed:true`. The primary label is written exactly once per decision
 * — at the tap, or when the 30-min window closes untapped; a finalize-time
 * row must use label `facts`. Pure; exported for tests.
 */
export function escalatedLabelRefused(ev: Pick<ComputePolicyLabelEvent, 'label' | 'escalated' | 'windowClosed'>): boolean {
  return ev.label === COMPUTE_POLICY_PRIMARY_LABEL && ev.escalated !== true && ev.windowClosed !== true;
}

/**
 * Write ONE compute_policy outcome row (question `depth`, meta.label = the
 * event's label) — plus the `research_request` row on the escalated label —
 * against the stash the plan carried. Callers: the chat finalize writes the
 * facts-only `facts` row; the Dig-deeper tap handler writes `escalated`
 * (escalated:true); the 30-min window closer writes `escalated`
 * (escalated:false, windowClosed:true) ONLY when no tap landed; the re-ask /
 * thumbs handlers and the late-check reconcile write their secondary labels.
 * An `escalated:false` event without `windowClosed:true` is REFUSED (nothing
 * written — review 2026-09-26: the readiness ruler keeps the earliest
 * `escalated` row per decision, so a premature false would hide the tap the
 * label is defined by). Fire-and-forget; never throws.
 */
export function labelComputePolicyOutcome(stashOrPlan: unknown, ev: ComputePolicyLabelEvent): void {
  try {
    const decision = decisionFrom(stashOrPlan);
    if (!decision || decision.purpose !== 'compute_policy') return;
    if (!COMPUTE_POLICY_LABELS.includes(ev.label)) return;
    if (escalatedLabelRefused(ev)) {
      logger.debug(`compute-policy labels: refused a premature escalated:false row for ${decision.id} (use label 'facts' at finalize; escalated:false needs windowClosed:true)`);
      return;
    }
    const acted = ev.acted === true;
    // Key ORDER is load-bearing: recordDecisionOutcome keeps the first 16 extra
    // keys (COMPACT_EXTRA_MAX_KEYS). site + source + stakes / guest / segment /
    // windowClosed, the five facts, the label-specific signals, the preset, then
    // the finalize turn stats (ttft / completion / spend / council).
    // The `stakes` noul the act rule reads next to `depth` (audit 2026-09-26
    // telemetry-readiness-2): the ruler's compound band needs it when the decision row is gone.
    const stakesAnswer = decision.answers['stakes'];
    const stakes = stakesAnswer && stakesAnswer.type === 'noul' ? Number(stakesAnswer.noul.toFixed(3)) : undefined;
    const extra = {
      site: 'compute_policy',
      ...(ev.source ? { source: ev.source } : {}),
      ...(typeof stakes === 'number' ? { stakes } : {}),
      ...(ev.guest !== undefined ? { guest: ev.guest } : {}),
      ...(ev.segment ? { segment: String(ev.segment).slice(0, 16) } : {}),
      ...(ev.windowClosed ? { windowClosed: true } : {}),
      ...(ev.facts ? { leadToolCalls: ev.facts.leadToolCalls, webToolCalls: ev.facts.webToolCalls, finalChars: ev.facts.finalChars, checkerSpawned: ev.facts.checkerSpawned, checkerMerged: ev.facts.checkerMerged } : {}),
      ...(ev.facts?.backgroundDeadlineHit ? { backgroundDeadlineHit: true } : {}),
      ...(typeof ev.escalated === 'boolean' ? { escalated: ev.escalated } : {}),
      ...(ev.escalatedTo ? { escalatedTo: ev.escalatedTo } : {}),
      ...(ev.escalated === true && ev.rungChoice ? { rungChoice: ev.rungChoice } : {}),
      ...(typeof ev.material === 'boolean' ? { material: ev.material } : {}),
      ...(ev.afterAddendum ? { afterAddendum: true } : {}),
      ...(ev.requestedPreset ? { requestedPreset: ev.requestedPreset } : {}),
      ...turnExtra(ev.turn),
    };
    const excludeFromFit = ev.excludeFromFit === true;
    if (ev.failed) {
      recordDecisionOutcome(decision, 'compute_policy', { question: DEPTH_QUESTION, actual: null, acted, sessionId: ev.sessionId, label: ev.label, note: `run failed — outcome unknown (${ev.label})`, extra, excludeFromFit });
      return;
    }
    const note = computePolicyNote(ev);
    if (decision.answers[DEPTH_QUESTION]) {
      const depthActual = ev.actualOverride !== undefined ? (ev.actualOverride as DepthActual | null) : deriveComputePolicyDepthActual(ev);
      recordDecisionOutcome(decision, 'compute_policy', {
        question: DEPTH_QUESTION, actual: depthActual, acted, sessionId: ev.sessionId, label: ev.label,
        note: depthActual === null ? `${note}; depth unknown — heavy turn, no merged check` : note, extra, excludeFromFit,
      });
    }
    if (ev.label === 'escalated' && decision.answers[RESEARCH_REQUEST_QUESTION]) {
      // null = no signal about what the message asked (a forced-rung tap) ⇒ no row (audit 2026-09-26).
      const researchActual = deriveResearchRequestActual(ev);
      if (researchActual !== null) {
        recordDecisionOutcome(decision, 'compute_policy', { question: RESEARCH_REQUEST_QUESTION, actual: researchActual, acted, sessionId: ev.sessionId, label: ev.label, note, extra });
      }
    }
  } catch { /* labels never break a finalize */ }
}

/**
 * drafts_agree label: the reconcile's revision_material verdict — `agree`
 * actual ⇔ the reconcile did NOT change a material claim. `acted` = the
 * reconcile pass was skipped on this decision (act). `material` null (the
 * reconcile never landed / interrupted) ⇒ actual null. Never throws.
 */
export function labelDraftsAgreeOutcome(stash: unknown, ev: { material: boolean | null; sessionId?: string; acted?: boolean; note?: string; label?: string; source?: string }): void {
  try {
    const decision = reconstructDecision(stash);
    if (!decision || decision.purpose !== 'drafts_agree' || !decision.answers[DRAFTS_AGREE_QUESTION]) return;
    const actual = ev.material === null || ev.material === undefined ? null : !ev.material;
    recordDecisionOutcome(decision, 'drafts_agree', {
      question: DRAFTS_AGREE_QUESTION, actual, acted: ev.acted === true, sessionId: ev.sessionId,
      // drafts_agree label semantics (2026-09-26): `label` tells the writers apart — 'reconcile' (the
      // shadow reconcile's verdict) vs the acted row's later user signal ('thumbs_up' / 'thumbs_down' /
      // 'escalated' / 'window_closed'); no OUTCOME_LABEL_FOR_FIT entry, so every row still enters the fit
      // (acted rows are excluded there by `acted`, and feed only the E12 act-band window).
      ...(ev.label ? { label: ev.label } : {}),
      note: `${ev.source ? `src:${ev.source}; ` : ''}reconcile ${actual === null ? 'did not land' : ev.material ? 'changed a material claim' : 'wording-only'}${ev.acted ? '; reconcile skipped (acted)' : ''}${ev.note ? `; ${ev.note.slice(0, 120)}` : ''}`,
      extra: { site: 'drafts_agree', ...(ev.source ? { source: ev.source } : {}), ...(typeof ev.material === 'boolean' ? { material: ev.material } : {}) },
    });
  } catch { /* labels never break a finalize */ }
}

/**
 * revision_material label: the user thumbed down or escalated after the
 * revision ⇒ `material` actual true (the change mattered); neither within the
 * window ⇒ false; `unknown` (window not closed / turn interrupted) ⇒ null.
 * `acted` = the rewrite was skipped on this decision (the user then judged
 * the UNREVISED text — audit 2026-09-26: a thumbs-down / tap on it = the
 * withheld rewrite may have mattered; the act-band window admits the row).
 * `note` is appended by the adapter (the pill state the row carried). Never throws.
 */
export function labelRevisionMaterialOutcome(stash: unknown, ev: { thumbsDown?: boolean; escalated?: boolean; sessionId?: string; acted?: boolean; unknown?: boolean; note?: string }): void {
  try {
    const decision = reconstructDecision(stash);
    if (!decision || decision.purpose !== 'revision_material' || !decision.answers[REVISION_MATERIAL_QUESTION]) return;
    const actual = ev.unknown ? null : !!(ev.thumbsDown || ev.escalated);
    recordDecisionOutcome(decision, 'revision_material', {
      question: REVISION_MATERIAL_QUESTION, actual, acted: ev.acted === true, sessionId: ev.sessionId,
      // backlog E10 (2026-09-28): the human signal is the PRIMARY fit label (OUTCOME_LABEL_FOR_FIT 'human'); the
      // window closer's harness row (label 'harness') stands in only when no human row exists for the decision.
      label: REVISION_MATERIAL_HUMAN_LABEL,
      note: `thumbsDown:${ev.thumbsDown ? 1 : 0}; escalated:${ev.escalated ? 1 : 0}${ev.acted ? '; rewrite skipped (acted)' : ''}${ev.unknown ? '; window not closed' : ''}${ev.note ? `; ${ev.note.slice(0, 120)}` : ''}`,
      extra: { site: 'revision_material', source: 'human', ...(typeof ev.thumbsDown === 'boolean' ? { thumbsDown: ev.thumbsDown } : {}), ...(typeof ev.escalated === 'boolean' ? { escalated: ev.escalated } : {}) },
    });
  } catch { /* labels never break a finalize */ }
}

// ── backlog E10 (2026-09-28): the revision_material HARNESS label ────────────
// 106 decisions, 0 outcome rows all-time: the only writers were the thumbs hook
// and the Dig-deeper tap on an 'updated' row — with five human accounts that
// signal does not arrive. The deterministic numbers / dates / entities /
// negations diff decideRevisionMaterial computes FIRST is a harness-derivable
// label for the same question ("did a claim change?"): a diff-decided verdict
// (source 'diff') ⇒ material TRUE; a diff that said unchanged and fell back to
// the rewrite (source 'fallback') ⇒ material FALSE. A gate-decided verdict
// (source 'gate' — act only; the diff said unchanged by construction) is
// recorded acted:true and excludeFromFit (a measured fact, never a label the
// act's own band may learn from). The window closer writes it ≥ 30 min after
// the reconcile; the human label (above) overrides it in the fit
// (OUTCOME_LABEL_FOR_FIT 'human' primary, OUTCOME_LABEL_FALLBACK_FOR_FIT
// 'harness').
export const REVISION_MATERIAL_HUMAN_LABEL = 'human';
export const REVISION_MATERIAL_HARNESS_LABEL = 'harness';
/**
 * The harness actual from a persisted verdict's `source` (pure): 'diff' ⇒ true, 'fallback' ⇒ false, 'gate' ⇒ false
 * (acted; excluded), anything else ⇒ null. Audit 2026-10-06 T6-2: a 'diff' verdict persisted `material:false` (an
 * additions-only / stamp-drift diff — compute-policy-gate decideRevisionMaterial) changed no claim ⇒ false.
 */
export function revisionMaterialHarnessActual(source: unknown, material?: unknown): { actual: boolean | null; acted: boolean; excludeFromFit: boolean } {
  if (source === 'diff') return { actual: material !== false, acted: false, excludeFromFit: false };
  if (source === 'fallback') return { actual: false, acted: false, excludeFromFit: false };
  if (source === 'gate') return { actual: false, acted: true, excludeFromFit: true };
  return { actual: null, acted: false, excludeFromFit: true };
}
/** Write the harness row (label 'harness') for a revision_material stash. Never throws; false when nothing was written. */
export function labelRevisionMaterialHarnessOutcome(stash: unknown, ev: { source: unknown; material?: unknown; changed?: number; sessionId?: string; note?: string }): boolean {
  try {
    const decision = reconstructDecision(stash);
    if (!decision || decision.purpose !== 'revision_material' || !decision.answers[REVISION_MATERIAL_QUESTION]) return false;
    const v = revisionMaterialHarnessActual(ev.source, ev.material);
    recordDecisionOutcome(decision, 'revision_material', {
      question: REVISION_MATERIAL_QUESTION, actual: v.actual, acted: v.acted, sessionId: ev.sessionId,
      label: REVISION_MATERIAL_HARNESS_LABEL,
      note: `harness src:window_close; diff source:${String(ev.source ?? '—')}; material:${v.actual === null ? '—' : v.actual ? 1 : 0}${typeof ev.changed === 'number' ? `; changed:${ev.changed}` : ''}${v.acted ? '; rewrite withheld (acted, excluded)' : ''}${ev.note ? `; ${ev.note.slice(0, 120)}` : ''}`,
      extra: { site: 'revision_material', source: 'window_close', harness: true, diffSource: String(ev.source ?? '').slice(0, 16), ...(typeof ev.changed === 'number' ? { changed: ev.changed } : {}) },
      ...(v.excludeFromFit ? { excludeFromFit: true } : {}),
    });
    return true;
  } catch { return false; }
}
