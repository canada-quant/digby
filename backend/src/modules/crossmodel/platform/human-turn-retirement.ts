/**
 * roster 2026-10-06 B-2 — the ONE check every retired-on-human-turns ask site
 * makes (auto_route, compute_policy, checker_route, drafts_agree; the table and
 * its kill switches live in decision-gate-modes.ts PURPOSE_RETIRED_ON_HUMAN_TURNS).
 *
 * `skipRetiredHumanAsk(purpose, …)` answers "skip this ask?" for a HUMAN turn and,
 * when it says yes, writes ONE `decision_ask_retired` loop_metrics row
 * (meta { purpose, site, segment? }) so the retirement is countable next to the
 * decision_gate rows it replaces. The caller then does exactly what the purpose's
 * OFF mode does at that site — the fail-open it already had — so a human turn's
 * run is byte-identical to today's shadow run (nothing these purposes answered in
 * shadow ever changed a human run). Never throws: an error answers false (the ask
 * runs as before).
 */

import { recordLoopMetric } from './loop-metrics.service';
import { purposeRetiredOnHumanTurns } from './decision-gate-modes';
import type { DecisionPurpose } from './decision-gate';

/** The loop_metrics kind (literal: partial LOOP_METRIC_KINDS mocks in the consumers' suites cannot drop it). */
export const DECISION_ASK_RETIRED_KIND = 'decision_ask_retired';

export function skipRetiredHumanAsk(purpose: DecisionPurpose, opts: { site: string; segment?: string; sessionId?: string }): boolean {
  try {
    if (!purposeRetiredOnHumanTurns(purpose)) return false;
    recordLoopMetric({
      kind: DECISION_ASK_RETIRED_KIND,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      meta: { purpose, site: opts.site, ...(opts.segment ? { segment: opts.segment } : {}) },
    });
    return true;
  } catch {
    return false;
  }
}
