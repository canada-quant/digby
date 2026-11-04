/**
 * Per-chat LEAD-SEAT override for plain chats (WI-O #4c, 2026-09-25).
 *
 * The Digby seat is instance-wide (model-roles.service, admin PUT). A coding
 * session can already pick its own agent (set_session_model → the satellite's
 * model), but a plain chat could not — every plain chat ran the instance's
 * lead seat. `crossmodel_chats.leadModel` (nullable, additive) stores ONE
 * chat's pick; the run path (chat-agent.service seat resolution) prefers it
 * over resolveRoleModelForRun('chat_orchestrator'). Supervisor chats resolve
 * their OWN seats ('supervisor' / 'project_supervisor') and never honour the
 * column; coding sessions keep set_session_model.
 *
 * The pick set is EXACTLY what the Digby seat offers the admin: the built-ins
 * from builtInOptionsFor('chat_orchestrator') plus enabled registry models
 * flagged [coding] (assertAssignable's rule for chat seats). Legacy ids alias
 * forward the way resolveOneCodingPick does. Servability is checked at RUN
 * time (seatUnservableReason on the resolved lead) so a keyless pick fails
 * fast with the same named-fix message as a dead seat.
 */

const LEGACY_ALIASES: Record<string, string> = {
  'kimi-k2.6': 'kimi-k3',
  'glm-5.2': 'glm-5.3',
  'deepseek-v4-pro': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
};

/**
 * Validate a lead-model pick against the Digby seat's pick set. Returns the
 * canonical spec to store, or null when it is not offered. Dynamic imports
 * keep this leaf import-light (crossmodel.service loads it on every update).
 */
export async function resolveChatLeadPick(pick: string | null | undefined, userId?: string): Promise<string | null> {
  const raw = String(pick ?? '').trim();
  if (!raw) return null;
  const aliased = Object.hasOwn(LEGACY_ALIASES, raw) ? LEGACY_ALIASES[raw] : raw;
  if (aliased.includes(':')) {
    try {
      const { resolveRegistryModel } = await import('../model-endpoints/model-endpoints.service');
      const reg = await resolveRegistryModel(aliased, userId);
      return reg?.coding ? aliased : null;
    } catch {
      return null;
    }
  }
  try {
    const { builtInOptionsFor } = await import('../model-endpoints/model-roles.service');
    return builtInOptionsFor('chat_orchestrator').includes(aliased) ? aliased : null;
  } catch {
    return null;
  }
}

/** Human list of the built-in picks for refusal messages (fail-safe: the known lineup). */
export async function chatLeadBuiltInOptions(): Promise<string[]> {
  try {
    const { builtInOptionsFor } = await import('../model-endpoints/model-roles.service');
    return builtInOptionsFor('chat_orchestrator');
  } catch {
    return ['kimi-k3', 'glm-5.3', 'deepseek-flash', 'qwen3.6-27b'];
  }
}

/**
 * The lead override the RUN should honour for this chat row, or null: a
 * non-empty stored pick on a NON-supervisor chat. Pure — the row comes from
 * the run's existing chat read.
 */
export function chatLeadOverrideForRun(
  row: { leadModel?: string | null; isSupervisor?: boolean | null; isProjectSupervisor?: boolean | null } | null | undefined,
): string | null {
  if (!row) return null;
  if (row.isSupervisor === true || row.isProjectSupervisor === true) return null;
  const v = typeof row.leadModel === 'string' ? row.leadModel.trim() : '';
  return v || null;
}
