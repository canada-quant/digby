/**
 * Schedule PROVENANCE — who authored an arm (audit 2026-10-06 T4-5;
 * schooltime.md F9, spark.md F14). LEAF: no imports, so both coding/tools.ts
 * (schedule_self) and platform/platform-tools.ts (schedule_message /
 * update_schedule / cancel_schedule initiator) can share one rule without a
 * cycle.
 *
 * WHY: the stamps keyed on `ctx.userTurnAt` alone. An OWNER-DISPATCH run (a
 * supervisor relayed the owner's own-turn ask — platform/agent-send-header
 * isOwnerDispatchRun) carries the owner turn's userTurnAt for its whole life,
 * and so does an agent-origin send from a user-anchored run (classified
 * machine by the executor). Every schedule such a run armed was stamped
 * promptSetBy 'user' — "owner-armed" — 48–250 min after the owner's turn
 * (184d1d38 an hourly Drive watch the owner had ordered stopped; 772cde44,
 * 071e13d3, debe6a0d). An owner-armed stamp is owner-locked everywhere
 * (dormancy carve-out, no cadence stretch, never cancelled by a supervisor,
 * reported UP as the owner's), so a laundered stamp is sticky.
 *
 * RULE: an arm is OWNER-authored only on a real user turn (userTurnAt set)
 * that is neither machine-classified (ctx.machineTriggered — schedule / hook /
 * agent / webhook origins) nor an owner-dispatch run (ctx.ownerDispatch), and
 * not the card-free work-tool path (ctx.workToolDirect — the model's own args,
 * the 2026-09-28 rule kept verbatim). Kill switch
 * SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED=1 restores the userTurnAt-only
 * test (work-tool rule kept). Read per call.
 */

export interface ScheduleProvenanceCtx {
  userTurnAt?: Date | null;
  machineTriggered?: boolean;
  ownerDispatch?: boolean;
  workToolDirect?: boolean;
}

export function scheduleProvenanceMachineRunsDisabled(): boolean {
  return process.env.SCHEDULE_PROVENANCE_MACHINE_RUNS_DISABLED === '1';
}

/** TRUE when an arm/edit/cancel from this run is the OWNER's own act. Pure apart from the env read. */
export function scheduleArmOwnerAuthored(ctx: ScheduleProvenanceCtx | null | undefined): boolean {
  if (!ctx || !ctx.userTurnAt) return false;
  if (ctx.workToolDirect === true) return false;
  if (scheduleProvenanceMachineRunsDisabled()) return true;
  return ctx.machineTriggered !== true && ctx.ownerDispatch !== true;
}
