/**
 * Display-normalization for LEGACY stored model ids (UI overhaul Phase 2,
 * item 7). Sessions/prefs persisted before a model cutover still carry the
 * old id (e.g. a coding session stamped `glm-5.2` pre the 2026-09-03
 * GLM-5.3 cutover). Reads that SHOW a model id to the user — the session ⋯
 * menu's workspace block, the Account → Coding picker — normalize through
 * this map; writes still store whatever the picker selected (the backend
 * applies its own read-aliases at run time).
 *
 * Extracted from account/CodingTab.tsx's inline ternary so every surface
 * shares ONE alias table.
 */
export const MODEL_ID_READ_ALIASES: Record<string, string> = {
  'kimi-k2.6': 'kimi-k3', // pre-K3 switch (2026-08-01)
  'glm-5.2': 'glm-5.3', // pre-GLM-5.3 cutover (2026-09-03)
  'deepseek-v4-pro': 'deepseek-flash', // pre-DeepSeek V4.1 Flash cutover (2026-09-10; the vendor routes it there from 09-14)
};

/** Map a stored (possibly legacy) model id to its current display id. */
export function displayModelId(id: string): string {
  return MODEL_ID_READ_ALIASES[id] ?? id;
}
