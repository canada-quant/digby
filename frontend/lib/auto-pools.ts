/**
 * Auto pools editor helpers (dynamic roster phase 1, 2026-10-03) — pure, so
 * the draft / diff / option rules are tested without rendering
 * (app/crossmodel/account/AutoPoolsPanel.tsx renders them).
 */
import type { AutoPoolRole, AutoPoolsView, CatalogModelCard } from '@/lib/api/model-endpoints';

export const AUTO_POOL_ROLES: readonly AutoPoolRole[] = ['quick', 'lead', 'checker', 'colleague'];

/** What each pool is for — plain words for the admin. */
export const AUTO_POOL_HELP: Readonly<Record<AutoPoolRole, string>> = {
  quick: 'Answers lookups and live facts (weather, scores, prices, definitions) with web search and thinking off — the first model that is up is used.',
  lead: 'Leads every other Auto answer (Standard, Checked and Research lanes) — the first model that is up is used; a later one covers an image the first cannot see.',
  checker: 'The second opinion on a Checked answer — the planner picks the first model from a DIFFERENT family than the lead, so the check is independent.',
  colleague: 'The research council — the planner takes as many as the question needs, from the top of the list.',
};

export type PoolDraft = Record<AutoPoolRole, string[]>;

/** The editable draft: the STORED lists (an empty list = following the seats). */
export function draftFromView(view: Pick<AutoPoolsView, 'config'>): PoolDraft {
  const out = {} as PoolDraft;
  for (const r of AUTO_POOL_ROLES) out[r] = [...(view.config.pools[r] ?? [])];
  return out;
}

/** The PUT body: only the roles whose list changed ([] clears back to the seats). */
export function dirtyPoolPatch(view: Pick<AutoPoolsView, 'config'>, draft: PoolDraft): Partial<Record<AutoPoolRole, string[]>> {
  const patch: Partial<Record<AutoPoolRole, string[]>> = {};
  for (const r of AUTO_POOL_ROLES) {
    const stored = view.config.pools[r] ?? [];
    const next = draft[r] ?? [];
    if (stored.length !== next.length || stored.some((s, i) => s !== next[i])) patch[r] = next;
  }
  return patch;
}

/** Models an admin may add to a pool: open (auto-eligible) chat models not already listed, fast tier first for the Quick pool. */
export function addableModels(catalog: readonly CatalogModelCard[], role: AutoPoolRole, current: readonly string[]): CatalogModelCard[] {
  const rank = (c: CatalogModelCard) => (role === 'quick' ? (c.tier === 'fast' ? 0 : c.tier === 'standard' ? 1 : 2) : 0);
  return catalog
    .filter(c => c.autoEligible && !c.frontier && !current.includes(c.spec))
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(x => x.c);
}

/** Short badges for a card: family · tier · vision · price ($/1M in→out) · no-think · not servable. */
export function cardBadges(card: CatalogModelCard | undefined): string[] {
  if (!card) return ['unknown model'];
  const out = [card.family, card.tier];
  if (card.vision) out.push('vision');
  if (card.thinkingOff) out.push('no-think');
  if (card.priceIn !== null && card.priceOut !== null) out.push(`$${card.priceIn}→$${card.priceOut}/M`);
  if (!card.servable) out.push('no key here');
  if (card.frontier) out.push('frontier — not allowed');
  return out;
}

/** Move one entry up (-1) or down (+1) — a no-op at the ends. */
export function movePoolEntry(list: readonly string[], index: number, delta: -1 | 1): string[] {
  const j = index + delta;
  if (index < 0 || index >= list.length || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[index], next[j]] = [next[j], next[index]];
  return next;
}
