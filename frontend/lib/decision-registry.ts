/**
 * Decision-role registry helpers (rollout self-governance, 2026-09-27) — pure,
 * DOM-free, so the Model roles section's registry table stays testable
 * without rendering (the same split as lib/decision-backends.ts).
 */
import type { DecisionRegistryRow } from './api/model-endpoints';

export type RegistrySortKey = 'purpose' | 'tier' | 'effective' | 'ready' | 'label';

export const TIER_TITLE: Record<1 | 2 | 3, string> = {
  1: 'Tier 1 — the rollout automaton flips it to act on a fresh MEASURED READY stamp (never an owner-override stamp).',
  2: 'Tier 2 — READY is reported to the owner as ONE question; a "flip" answer flips it through the same admission.',
  3: 'Tier 3 — never flipped automatically (no act consumer, or retired for a deterministic rule); by hand only.',
};

/** Pure: sort the registry rows by one key (ties broken by purpose id). */
export function sortRegistryRows(rows: DecisionRegistryRow[], key: RegistrySortKey, dir: 'asc' | 'desc'): DecisionRegistryRow[] {
  const readyRank = (r: DecisionRegistryRow) => (r.readiness ? (r.readiness.ready && !r.readiness.stale ? 0 : r.readiness.ready ? 1 : 2) : 3);
  const modeRank = (r: DecisionRegistryRow) => ({ act: 0, shadow: 1, off: 2 } as Record<string, number>)[r.effective ?? 'off'] ?? 3;
  const cmp = (a: DecisionRegistryRow, b: DecisionRegistryRow): number => {
    let c = 0;
    if (key === 'tier') c = a.tier - b.tier;
    else if (key === 'effective') c = modeRank(a) - modeRank(b);
    else if (key === 'ready') c = readyRank(a) - readyRank(b);
    else if (key === 'label') c = a.label.localeCompare(b.label);
    return c !== 0 ? c : a.purpose.localeCompare(b.purpose);
  };
  const out = [...rows].sort(cmp);
  return dir === 'asc' ? out : out.reverse();
}
