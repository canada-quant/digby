/**
 * dedupById (UI overhaul Phase 2, item 5) — render-side safety net for the
 * converged transcript: the SAME message id must never render twice (React
 * key collisions + visually duplicated bubbles). Distinct ids always pass —
 * genuinely duplicated DB rows (e.g. the pre-fix interrupted-resume
 * double-persist left one partial + one full assistant row with different
 * ids) are REAL rows and stay; this only collapses id collisions that can
 * arise from merge/attach races (page prepend overlap, echo + reload, a
 * replayed terminal frame).
 *
 * First occurrence keeps its position; identity-preserving when there is
 * nothing to drop (no re-render churn for the common case).
 */
export function dedupById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  let hasDupe = false;
  for (const r of rows) {
    if (seen.has(r.id)) { hasDupe = true; break; }
    seen.add(r.id);
  }
  if (!hasDupe) return rows;
  seen.clear();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}
