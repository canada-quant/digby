/**
 * Reasoning effort for the orchestrator on a HUMAN-typed chat turn (owner
 * 2026-09-22, after a 10-minute wait for "have you served glm5.3?": 48 h p50
 * 655 s / p90 851 s from question to answer across the supervisor chats, 14 of
 * 19 over five minutes — the orchestrator itself thinking at
 * reasoning_effort 'max' over ~215k tokens of context). Built-in glm/deepseek
 * seats answer a HUMAN turn at CHAT_HUMAN_TURN_EFFORT (default 'high' ≈ 3
 * min/turn vs 'max' ≈ 12 on glm-5.3); machine wakes keep 'max' (nobody is
 * waiting). Leaf module (no imports) so tests never load the chat-agent chain.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

/** env CHAT_HUMAN_TURN_EFFORT; default 'high'; 'max' restores the 2026-09-03 everywhere-max behaviour. */
export function humanTurnEffort(): ReasoningEffort {
  const v = String(process.env.CHAT_HUMAN_TURN_EFFORT || 'high').trim().toLowerCase();
  return v === 'low' || v === 'medium' || v === 'high' || v === 'max' ? v : 'high';
}

/**
 * Per-run provider override for a human-typed turn: built-in glm-* / deepseek-*
 * seats take `reasoning_effort` (the same param the seat already sends at
 * 'max'); kimi-k3 and custom endpoints are left alone (unknown param support —
 * a 400 there would cost the whole answer). Machine turns: no override. Pure.
 */
export function humanTurnProviderExtra(model: string, machineTriggered: boolean): { providerExtra?: Record<string, any> } {
  if (machineTriggered) return {};
  return effortProviderExtra(model, humanTurnEffort());
}

/**
 * The provider override for ONE effort level on ONE model — the model rule
 * shared by the human-turn path above and the N9 machine-wake effort gate
 * (platform/wake-effort.ts): built-in glm-* / deepseek-* seats take
 * `reasoning_effort`; kimi-k3 and custom endpoints ('label:model') are left
 * alone; 'max' (the seat's own default) and null send nothing. Pure.
 */
export function effortProviderExtra(model: string, effort: ReasoningEffort | null | undefined): { providerExtra?: Record<string, any> } {
  if (!effort || effort === 'max') return {};
  const m = String(model || '').toLowerCase();
  if (!m || m.includes(':')) return {};
  if (m.startsWith('glm') || m.startsWith('deepseek')) return { providerExtra: { reasoning_effort: effort } };
  return {};
}

/**
 * LEAD-EFFORT A/B (owner 2026-10-04, "A/B lower lead effort"). Real users' first token on the custom-endpoint
 * lead (`cql-litellm:api-optimize-zai-glm-5.3-flash`) was L1 p50 152 s / L2 p50 183 s (p90 677 s) over 7 days: the
 * human-turn cut above never reaches a custom endpoint, so every human turn reasoned at 'max'. A stable per-turn
 * hash puts CHAT_LEAD_EFFORT_AB_SHARE (default 0.5) of eligible human turns in arm 'high' — the agent loop CAPS
 * the lead's already-sent reasoning_effort to 'high' (coding/effort-cap.ts; never adds the param) — and the rest in
 * the 'max' control. The arm rides metadata.ux.effortArm + the ux_ttft row; the nightly live-chat audit and the
 * query suite compare first-token time and outcome labels by arm. CHAT_LEAD_EFFORT_AB_DISABLED=1 → null (no arm,
 * today's behaviour); CHAT_LEAD_EFFORT_AB_SHARE=1 → every eligible turn capped (the "keep it" setting). Pure.
 */
export type LeadEffortArm = 'high' | 'max';

export function leadEffortAbShare(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CHAT_LEAD_EFFORT_AB_SHARE;
  if (raw === undefined || String(raw).trim() === '') return 0.5;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
}

/** FNV-1a over the key → [0, 1). Pure. */
export function stableUnit(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 0x100000000;
}

/** The turn's arm, or null when the A/B is off / the turn is not eligible (the caller decides eligibility). Pure. */
export function leadEffortArm(turnKey: string, env: Record<string, string | undefined> = process.env): LeadEffortArm | null {
  if (env.CHAT_LEAD_EFFORT_AB_DISABLED === '1' || !turnKey) return null;
  return stableUnit(`lead-effort-ab:${turnKey}`) < leadEffortAbShare(env) ? 'high' : 'max';
}
