/**
 * Reflection council editor helpers (F2, owner 2026-10-06 late) — pure, so the
 * option / diff / badge rules are tested without rendering
 * (app/crossmodel/account/ReflectionCouncilPanel.tsx renders them).
 */
import type { FrontierCouncilModel } from '@/lib/api/model-endpoints';

/** Frontier models an admin may add: listed candidates not already on the council. */
export function addableCouncilModels(candidates: readonly FrontierCouncilModel[], current: readonly string[]): FrontierCouncilModel[] {
  return candidates.filter(c => !current.includes(c.spec));
}

/** The stored list differs from the draft (order matters — the first is asked first in the log, all run at once). */
export function councilDirty(stored: readonly string[], draft: readonly string[]): boolean {
  return stored.length !== draft.length || stored.some((s, i) => s !== draft[i]);
}

/** Short badges: vendor family · tier · price ($/1M in→out) or "price unknown". */
export function councilBadges(m: FrontierCouncilModel | undefined): string[] {
  if (!m) return ['not available here'];
  const out = [m.family, m.tier];
  out.push(m.priceIn !== null || m.priceOut !== null ? `$${m.priceIn ?? 0}→$${m.priceOut ?? 0}/M` : 'price unknown (estimated)');
  return out;
}
