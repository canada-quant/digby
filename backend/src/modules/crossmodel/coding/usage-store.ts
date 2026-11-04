/**
 * Durable per-SESSION token/cost totals — the sidebar meter's "whole session"
 * numbers, including every subagent, across every run, surviving reloads.
 *
 * One context-store row per session. Each finished run merges its
 * UsageAccumulator snapshot in exactly once (idempotent via seenRuns), and the
 * live view merges the in-flight run on the fly without persisting.
 */

import { storeGet, storePut } from '../memory/context-store';
import { RunUsage, AgentUsageRow } from './cost';

const NS = (sessionId: string) => [sessionId, 'coding-usage'];
const KEY = 'session-total';
const MAX_SEEN_RUNS = 50;

export interface SessionUsage {
  inTokens: number;
  outTokens: number;
  costUsd: number;
  turns: number;
  runs: number;
  estimated: boolean;
  agents: AgentUsageRow[];
  seenRuns: string[];
}

export function emptySessionUsage(): SessionUsage {
  return { inTokens: 0, outTokens: 0, costUsd: 0, turns: 0, runs: 0, estimated: false, agents: [], seenRuns: [] };
}

/** Merge a run snapshot into session totals. Idempotent per runId. Pure. */
export function mergeRunIntoSession(stored: SessionUsage, run: RunUsage): SessionUsage {
  if (!run || stored.seenRuns.includes(run.runId)) return stored;
  const agents = stored.agents.map(a => ({ ...a }));
  for (const r of run.agents) {
    const hit = agents.find(a => a.agent === r.agent && a.model === r.model);
    if (hit) {
      hit.inTokens += r.inTokens; hit.outTokens += r.outTokens; hit.costUsd += r.costUsd;
      hit.turns += r.turns; hit.estimated = hit.estimated || r.estimated;
    } else {
      agents.push({ ...r });
    }
  }
  agents.sort((a, b) => b.costUsd - a.costUsd);
  return {
    inTokens: stored.inTokens + run.totalInTokens,
    outTokens: stored.outTokens + run.totalOutTokens,
    costUsd: stored.costUsd + run.totalCostUsd,
    turns: stored.turns + run.turns,
    runs: stored.runs + 1,
    estimated: stored.estimated || run.estimated,
    agents,
    seenRuns: [...stored.seenRuns, run.runId].slice(-MAX_SEEN_RUNS),
  };
}

export async function loadSessionUsage(sessionId: string): Promise<SessionUsage> {
  try {
    const v = await storeGet<SessionUsage>(NS(sessionId), KEY);
    return v && Array.isArray(v.agents) && Array.isArray(v.seenRuns) ? v : emptySessionUsage();
  } catch { return emptySessionUsage(); }
}

/** Persist a finished run into the session totals (idempotent per runId). */
export async function commitRunUsage(sessionId: string, run: RunUsage): Promise<SessionUsage> {
  const stored = await loadSessionUsage(sessionId);
  const merged = mergeRunIntoSession(stored, run);
  if (merged !== stored) {
    try { await storePut(NS(sessionId), KEY, merged as any); } catch { /* meter is best-effort */ }
  }
  return merged;
}
