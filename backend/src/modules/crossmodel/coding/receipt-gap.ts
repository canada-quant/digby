/**
 * Receipt-gap classification — the monitor heuristic (todo 76d78ad7, the PR
 * #1576 lane suggestion, 2026-10-16; goal fa54f4b9 framework audit).
 *
 * THE HEURISTIC the monitor asked for, verbatim: "the missing-receipt check
 * should read the deploy timeline — a receipt gap inside a deploy window with
 * a durable state row classifies as drain-loss, not invented-claim."
 *
 * WHY (docs/FRAMEWORK_LESSONS.md row 1e356736, the caveat row that is this
 * leaf's starting point): the 2026-10-16 08:09–08:32Z #1568 deploy window
 * lost TWO update_supervisor_state receipts (Fleet save ~08:34Z, crossmodel
 * save ~08:31Z) whose supervisor_states rows ARE durable — the deploy
 * teardown killed the old web color between the side-effect commit (the
 * supervisor_states upsert) and the receipt INSERT (run-receipts.service.ts
 * drain-loss class). A monitor that counts every missing receipt as an
 * invented claim convicts infrastructure loss as model fabrication.
 *
 * THREE verdicts, in priority order:
 *   expected_pre_class — the run STARTED before the receipt class shipped
 *     (the class shipped IN a deploy; a run begun on the old color could
 *     never have minted it — the #1576 monitor caveat). Never any signal.
 *   drain_loss         — a durable state row EXISTS and the action time
 *     falls inside a deploy window extended by the drain margin (the old
 *     color keeps serving — and being killed — past the recorded window
 *     end; the Fleet specimen's 08:34Z save sits 2 min past the 08:32Z
 *     end). Watch-list only, never invented-claim signal.
 *   unexplained_gap    — a durable row, but NO window covers the action:
 *     the side effect landed, so the claim was TRUE, yet the evidence
 *     channel lost the row outside any deploy. Watch-list (reconcile
 *     before convicting); a batch of these is a receipts-write defect
 *     signal, not a model-behavior signal.
 *   invented_claim     — NO durable row anywhere: nothing landed, no
 *     receipt exists, no window excuses it. THIS is the monitor's
 *     invented-claim signal class.
 *
 * PURE: every input is injected (dates, windows, flags) — no prisma, no
 * env, no clock. The probe (scripts/framework-audit/probe-76d78ad7.js)
 * feeds it live data; receipt-gap.76d78ad7.test.ts pins both #1576
 * specimens. Fail-closed is the caller's job: an unreadable deploy
 * timeline should pass deployWindows: [] (which can only ever produce
 * unexplained_gap / invented_claim — the conservative verdicts), never a
 * synthesized window.
 */

/** One completed deploy wave — the window receipts can drain in. */
export interface DeployWindow {
  /** The deploy run id (wave identity, e.g. '38869942923') — reporting only. */
  runId: string;
  /** When the deploy run started (wave created). */
  startedAt: Date;
  /** When the deploy run concluded (success or failure — either way the boxes restarted). */
  concludedAt: Date;
}

export interface ReceiptGapInput {
  /** The tool whose receipt is missing (e.g. 'update_supervisor_state'). */
  tool: string;
  /**
   * When the claimed action happened — the durable row's updatedAt (or the
   * receipt-window timestamp the check is scoring).
   */
  actionAt: Date;
  /**
   * When the agent run that performed the action STARTED. The pre-class
   * caveat keys on this: a run begun on the pre-class color is expected to
   * lack the receipt, deploy window or not.
   */
  runStartedAt?: Date | null;
  /**
   * When the receipt class shipped (the deploy conclusion that first served
   * RECEIPT_TOOLS membership for this tool). Null = the class predates the
   * lookback (no pre-class filtering).
   */
  classShippedAt?: Date | null;
  /**
   * A durable state row evidencing the side effect landed (e.g. the
   * supervisor_states row for an update_supervisor_state claim).
   */
  durableRow: boolean;
  /** Deploy windows overlapping the lookback. */
  deployWindows?: DeployWindow[];
}

export type ReceiptGapVerdict = 'drain_loss' | 'expected_pre_class' | 'unexplained_gap' | 'invented_claim';

export interface ReceiptGapResult {
  verdict: ReceiptGapVerdict;
  /** Machine-checkable reason — the verdict's ground, for the probe's output. */
  reason: string;
  /** The covering window's runId when a window covers actionAt (else null). */
  coveredByWindow: string | null;
}

/**
 * Drain margin past a deploy's CONCLUDED time, minutes. The recorded
 * box-restart window ends when the last box reports the new sha, but the
 * old color's processes drain past that (blue-green overlap) — the Fleet
 * specimen's ~08:34Z save sits 2 min past the 08:32Z window end and its
 * receipt died with the draining web process. Overridable by the probe
 * (DEPLOY_DRAIN_MARGIN_MIN) for measurement; the classifier takes the
 * resolved value.
 */
export const DEFAULT_DEPLOY_DRAIN_MARGIN_MIN = 15;

/**
 * True iff actionAt falls inside [startedAt, concludedAt + margin] of any
 * window. The margin is applied ONLY past the end (a save before the wave
 * started ran on a healthy old color — receipts worked).
 */
export function coveringWindow(
  actionAt: Date,
  windows: DeployWindow[],
  marginMin: number = DEFAULT_DEPLOY_DRAIN_MARGIN_MIN,
): DeployWindow | null {
  for (const w of windows) {
    const end = new Date(w.concludedAt.getTime() + marginMin * 60_000);
    if (actionAt >= w.startedAt && actionAt <= end) return w;
  }
  return null;
}

/**
 * Classify one missing receipt. Order is the contract:
 *   pre-class → drain-loss → unexplained → invented.
 * Pre-class wins even when a window covers the action (a run that started
 * before the class shipped could not mint the receipt regardless of how it
 * died); a covering window only excuses a gap whose side effect LANDED
 * (durableRow) — a window never launders a claim with no durable row.
 */
export function classifyReceiptGap(
  input: ReceiptGapInput,
  marginMin: number = DEFAULT_DEPLOY_DRAIN_MARGIN_MIN,
): ReceiptGapResult {
  const windows = input.deployWindows ?? [];
  const win = coveringWindow(input.actionAt, windows, marginMin);
  const coveredByWindow = win ? win.runId : null;

  // (1) Pre-class: the run predates the receipt class — expected, any window.
  if (input.classShippedAt && input.runStartedAt && input.runStartedAt < input.classShippedAt) {
    return {
      verdict: 'expected_pre_class',
      reason: `run started ${input.runStartedAt.toISOString()} before the ${input.tool} receipt class shipped ${input.classShippedAt.toISOString()} — the class shipped in that deploy; a run begun on the old color could never mint it`,
      coveredByWindow,
    };
  }

  // (2) Drain-loss: the side effect landed AND a deploy window covers the action.
  if (input.durableRow && win) {
    return {
      verdict: 'drain_loss',
      reason: `durable state row exists and action ${input.actionAt.toISOString()} sits inside deploy window ${win.runId} (${win.startedAt.toISOString()} → ${win.concludedAt.toISOString()} + ${marginMin}m drain margin) — the teardown could kill the writer between the side-effect commit and the receipt INSERT (audit-1e356736 class)`,
      coveredByWindow,
    };
  }

  // (3) Durable row, no window: the claim was TRUE but the evidence row is
  // gone outside any deploy — reconcile before convicting; never model-
  // behavior signal on its own.
  if (input.durableRow) {
    return {
      verdict: 'unexplained_gap',
      reason: `durable state row exists (the claim was true) but no deploy window covers action ${input.actionAt.toISOString()} — an evidence-channel loss with no deploy excuse; watch-list for a receipts-write defect, not invented-claim signal`,
      coveredByWindow: null,
    };
  }

  // (4) Nothing landed anywhere — the monitor's invented-claim signal class.
  return {
    verdict: 'invented_claim',
    reason: `no durable state row and no receipt for a ${input.tool} claim at ${input.actionAt.toISOString()}${win ? ` (deploy window ${win.runId} covers it, but a window never excuses a claim whose side effect never landed)` : ''}`,
    coveredByWindow,
  };
}
