/**
 * Ghost-mode RUNTIME shared leaf (import-light on purpose — chat-agent.service
 * imports it; the designation service imports only the switch read from here).
 *
 * Keeps the kill switch + the per-chat/run ghost predicates in ONE place so
 * the schema flag, the run seam and the privacy gates can never disagree.
 */

/** Kill switch: CHAT_GHOST_MODE_DISABLED=1 turns ghost mode off instance-wide
 *  (the designation is kept but never honoured; chats run their normal lineup). */
export function ghostModeDisabled(): boolean {
  return process.env.CHAT_GHOST_MODE_DISABLED === '1';
}

/** A ghost RUN is a run whose chat row (or guest send) asked for ghost mode. */
export function isGhostChatRow(row: { ghostMode?: boolean | null } | null | undefined): boolean {
  return row?.ghostMode === true;
}

/**
 * GHOST = ONE LEAD INFERENCE (owner ruling 2026-11-03, superseding the
 * 2026-10-22 routing rule).
 *
 * What #1888 built is still right about the PRIVACY half: a ghost chat must
 * never send its content to a second provider, so every leg it DOES run stays
 * on the admin-designated self-hosted endpoint and the cloud fallbacks are
 * cleared. What the owner retired is the "every leg" half — a ghost run used
 * to RE-ROUTE the Double Checker and the council colleagues onto the ghost
 * endpoint (`ghostEndpoint.spec ? Promise.resolve(ghostEndpoint.spec) : …`),
 * which meant a ghost turn still spawned a second model, still streamed the
 * Double Checker banner, and still paid a second inference for a posture whose
 * whole point is one private answer. Owner's words (verbatim): ghost mode
 * "should never run on any other model besides the obliterated" one.
 *
 * So a ghost run with a LIVE designation is collapsed to a single answer:
 *
 *   one call        the lead, on the designated spec, and nothing else
 *   no checker      no Double Checker, no L2 ensemble, no late reconcile,
 *                   no checker decision ask, no checker pill / banner
 *   no council      no L3 colleagues, no research rung council
 *   no wait         checkerWaitMs 0 (there is nothing to wait for)
 *
 * This is a HARD short-circuit, not another gate: it is applied to the plan
 * AFTER every other plan mutation (the compute-policy gate, lane depth, the
 * Quick lane, an escalation rung) and it is also enforced at the decision
 * point itself (`shouldSpawnChecker` takes `ghost`), so a future seam that
 * reintroduces a second leg still cannot spawn one on a ghost run.
 *
 * A ghost run with NO live designation is NOT collapsed: it keeps the normal
 * lineup (and the honest notice saying why) — the privacy posture never bricks
 * the chat, and the owner's directive is about the designated ghost path.
 *
 * Pure / import-light on purpose (this file is imported by the designation
 * service too, which must not pull the chat-agent graph in).
 */
export const GHOST_SINGLE_MODEL_PRESET = 'single_thinking';

/** The subset of DepthPlan this collapse reads and writes (structural — no cycle). */
export interface GhostCollapsiblePlan {
  preset: 'single_thinking' | 'thinking' | 'deep_research';
  spawnChecker: boolean;
  checkerWaitMs: number;
  leadEffort: 'high' | 'max';
  council: 'none' | 'background';
  lane?: 'quick' | 'standard' | 'checked' | 'research';
  /** The plan's code-composed audit string (DepthPlan.reason) — appended to, never discarded. */
  reason?: string;
}

/**
 * Collapse ANY plan to the ghost single-answer shape (pure). Keeps the plan's
 * `leadEffort` and its audit fields (`reason` / `source` / decision stash) so
 * the telemetry still says what the gate thought before the collapse — the
 * collapse is appended to `reason`, never substituted for it.
 */
export function ghostSingleModelPlan<T extends GhostCollapsiblePlan>(plan: T, why = 'ghost: one lead inference'): T & GhostCollapsiblePlan {
  const collapsed = {
    ...plan,
    preset: GHOST_SINGLE_MODEL_PRESET,
    spawnChecker: false,
    checkerWaitMs: 0,
    council: 'none' as const,
    ...('lane' in plan ? { lane: 'standard' } : {}),
    reason: plan.reason ? `${plan.reason} [${why}]` : why,
  };
  return collapsed as unknown as T & GhostCollapsiblePlan;
}
