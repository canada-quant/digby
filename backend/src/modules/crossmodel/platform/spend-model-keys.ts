/**
 * One name per model in the spend views (audit 2026-10-08 W3-4 — plumbing F10).
 *
 * run_spend / run_tokens rows named the same gateway model two ways: coding
 * rows the bare id the endpoint serves (`api-optimize-zai-glm-5.3`), chat rows
 * the registry spec (`cql-litellm:api-optimize-zai-glm-5.3`) — $156.07 and
 * $13.69 on two lines for one model in the window. New rows key a custom
 * endpoint by its spec at write time (coding-model spendModelKey); this leaf
 * folds the 30-day history on READ: a bare id that exactly ONE enabled
 * registry endpoint serves — and that is not itself a built-in id — is shown
 * under that endpoint's spec. Ambiguous ids (two endpoints serving the same
 * id) and built-in ids stay as they are.
 *
 * Pure. Kill switch SPEND_MODEL_KEY_NORMALIZE_DISABLED=1 (the caller skips the fold).
 */

export interface RegistryEndpointLike {
  label: string;
  enabled?: boolean;
  models?: Array<{ id?: string | null }> | null;
}

/** bare model id → the ONE enabled spec that serves it (ambiguous / built-in ids omitted). */
export function bareToSpecMap(endpoints: RegistryEndpointLike[], isBuiltIn: (id: string) => boolean): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const ep of endpoints ?? []) {
    if (!ep || ep.enabled === false || !ep.label) continue;
    for (const m of ep.models ?? []) {
      const id = String(m?.id ?? '').trim();
      if (!id || isBuiltIn(id)) continue;
      const set = seen.get(id) ?? new Set<string>();
      set.add(`${ep.label}:${id}`);
      seen.set(id, set);
    }
  }
  const out = new Map<string, string>();
  for (const [id, specs] of seen) if (specs.size === 1) out.set(id, [...specs][0]);
  return out;
}

/** The display key for a recorded model key. */
export function canonicalSpendModelKey(model: string, map: Map<string, string>): string {
  if (!model || model.includes(':')) return model;
  return map.get(model) ?? model;
}

/**
 * Fold rows keyed by model: rows whose key maps to the same canonical key are
 * merged with `merge(into, from)`. Order of first appearance is kept.
 */
export function foldByCanonicalModel<T extends { model: string }>(rows: T[], map: Map<string, string>, merge: (into: T, from: T) => void): T[] {
  const out = new Map<string, T>();
  for (const row of rows) {
    const key = canonicalSpendModelKey(row.model, map);
    const prev = out.get(key);
    if (!prev) {
      out.set(key, { ...row, model: key });
      continue;
    }
    merge(prev, row);
  }
  return [...out.values()];
}
