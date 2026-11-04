/**
 * The `triggerKind` an agent loop stamps on every loop_metrics row it records (MetricStamp, run_spend included).
 *
 * audit 2026-10-06 T8-11 (stanne P3): sub-agent rows inside schedule-origin runs were stamped triggerKind 'user'
 * (seat_fallback / guard_strike rows of runs 7a5e8e7d, 462137dd). The delegate spread strips the parent's
 * machineTriggered + evidenceGuardRejectBack (worker posture must stay interactive), so a worker's stamp fell to
 * 'user'. The parent now hands its own stamp down as `parentTriggerKind` — TELEMETRY ONLY, it changes no posture.
 * SUBAGENT_TRIGGER_KIND_INHERIT_DISABLED=1 restores the 'user' stamp. Pure leaf.
 */

export type LoopTriggerKind = 'user' | 'schedule' | 'hook' | 'machine';

export function subagentTriggerKindInheritDisabled(): boolean {
  return process.env.SUBAGENT_TRIGGER_KIND_INHERIT_DISABLED === '1';
}

export function metricTriggerKindFor(input: {
  evidenceGuardRejectBack?: { triggerKind: LoopTriggerKind } | null;
  parentTriggerKind?: string | null;
  machineTriggered?: boolean;
}): string {
  const inherited = !subagentTriggerKindInheritDisabled() && typeof input.parentTriggerKind === 'string' && input.parentTriggerKind
    ? input.parentTriggerKind
    : undefined;
  return input.evidenceGuardRejectBack?.triggerKind ?? inherited ?? (input.machineTriggered ? 'machine' : 'user');
}
