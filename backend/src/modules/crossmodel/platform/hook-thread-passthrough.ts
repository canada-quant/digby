/**
 * SAA-1.2 — Thread pass-through: route a wake to the lane that OWNS the thread.
 * PHASE 2: APPLIES (the flip). Phase 1 measured; this decides and re-targets.
 *
 * THE GAP (docs/FRAMEWORK_BACKLOG.md §SAA-1.2, essay §3.2). A hook's target is
 * fixed at subscribe time and never re-derived: `subscribeHook` writes
 * `targetChatId` once (hooks.service.ts) and delivery reads it back verbatim at
 * the fire site. For a WILDCARD supervisor hook that is correct — the Fleet /
 * Project Supervisor standing in for the owner wants the fan-in. But it is wrong
 * for a chat that is part of a multi-turn thread: the wake lands on the
 * supervisor, which then has to RE-DERIVE the thread (list_chats, get_chat_messages,
 * memory search) before it can act, instead of waking the lane already holding
 * the prior context. The graph edge that resolves this already exists in the
 * data model — `CrossModelChat.parentChatId` is the one lineage authority — it
 * is simply never consulted on the delivery path.
 *
 * WHAT PHASE 1 SHIPPED (measured, 2026-11-03/04): the next-hop RESOLVER plus the
 * decision it would take, with the fire site UNCHANGED. It produced its first
 * production row at 01:10:54Z — `owner_is_other_lane`, wildcard hook, source
 * 2c354da1 whose parentChatId is the Fleet Supervisor c0e22e36, independently
 * corroborated by the auto-wired child-result hook for that same pair. So the
 * resolver names the real lineage authority, not an artifact.
 *
 * WHAT THIS PHASE DOES: re-targets the firing at that owning lane.
 *
 * ── THE DELIVERABILITY GUARD IS NOT OPTIONAL ──
 * `parentChatId` is a lineage fact, NOT a statement that the parent is a good
 * place to deliver a wake. Re-targeting on lineage alone would let a wake leave
 * a live supervisor for a parent that is ARCHIVED (fireScheduleTarget refuses,
 * rows stay pending, and the supervisor wake that used to get acted on is
 * silently skipped) or, worse, for a parent owned by a DIFFERENT user (a wake
 * delivered into another account's chat). Both are refused here and fall back to
 * the subscribed target — fail-safe, because the old route is always correct,
 * only less efficient. The caller supplies those facts; this leaf stays pure.
 *
 * THE TWO STATES:
 *   unset / '' / '0'  → mode 'apply' — re-target to the owning lane when the
 *                       guard passes; ONE metric row per group that moved.
 *   '1' / 'true'/'on' → mode 'off'   — Phase-1/today's behaviour: fixed target.
 *
 * Kill switch: HOOK_THREAD_PASSTHROUGH_DISABLED=1 (release; restores fixed-target
 * delivery from box env with no deploy, and records no rows).
 *
 * Pure leaf: no imports, no I/O, no clock. The caller owns the DB reads and the
 * metric write — this module only decides WHAT would change.
 */

/** The hook shapes whose target this resolver is allowed to reason about. */
export const THREAD_PASSTHROUGH_HOOK_CLASSES = ['wildcard', 'specific'] as const;
export type ThreadPassthroughHookClass = (typeof THREAD_PASSTHROUGH_HOOK_CLASSES)[number];

/** Why the resolver did (or did not) name an owning lane other than the target. */
export const THREAD_PASSTHROUGH_REASONS = [
  /** The hook names its source explicitly — a child→parent hook already picked a deliberate target. */
  'specific_hook',
  /** The target is neither a Fleet nor a Project Supervisor: it is a lane wake already. */
  'target_not_supervisor',
  /** The emitting chat has no parentChatId — it is a root, so there is no thread to walk. */
  'no_lineage',
  /** The lineage resolves back to the subscribed target — the supervisor IS the owning lane. */
  'owner_is_target',
  /** The parent is gone / not readable (fail-safe: name nothing, deliver unchanged). */
  'lineage_unresolved',
  /** The owning lane is ARCHIVED — not a delivery target, so the subscribed target keeps the wake. */
  'owner_archived',
  /** The owning lane belongs to a DIFFERENT account — a wake must never cross accounts. */
  'owner_other_account',
  /** The delivery group spans SEVERAL threads — routing it to one of them would
   *  mis-deliver every other thread's events (see the continuity guard below). */
  'multi_source_group',
  /** A different, deliverable lane owns the thread — the one case that re-targets. */
  'owner_is_other_lane',
] as const;
export type ThreadPassthroughReason = (typeof THREAD_PASSTHROUGH_REASONS)[number];

/** The env key this leaf reads. Exported so the pinning test and the registry
 *  scan agree on ONE spelling rather than three copies of the string. */
export const HOOK_THREAD_PASSTHROUGH_DISABLED_KILL_TAG = 'HOOK_THREAD_PASSTHROUGH_DISABLED';

/** HOOK_THREAD_PASSTHROUGH_DISABLED=1 — the release kill switch (records no observe rows). */
export function hookThreadPassthroughDisabled(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): boolean {
  const raw = String(env?.HOOK_THREAD_PASSTHROUGH_DISABLED ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'on';
}

export interface ThreadPassthroughHook {
  /** NULL = wildcard (owner-scope or project-scope) — the only class that can be re-targeted. */
  sourceChatId: string | null;
  /** The subscribed wake target, read verbatim at the fire site today. */
  targetChatId: string;
}

export interface ThreadPassthroughSourceFacts {
  /** `CrossModelChat.parentChatId` — the one lineage authority. NULL/absent = a root chat. */
  parentChatId?: string | null;
}

export interface ThreadPassthroughTargetFacts {
  isSupervisor?: boolean | null;
  isProjectSupervisor?: boolean | null;
}

/**
 * Facts about the RESOLVED parent chat, read by the caller. Absent/null means
 * the parent row does not exist — a dead lineage edge, never a delivery target.
 * These exist because `parentChatId` is a lineage fact, NOT a deliverability
 * fact: the guard below is what stops a wake leaving a live supervisor for an
 * archived lane or another account's chat.
 */
export interface ThreadPassthroughParentFacts {
  /** Non-null = archived: fireScheduleTarget refuses, rows stay pending, wake lost. */
  archivedAt?: Date | string | null;
  /** The parent's owner id; compared against the hook's owning user. */
  userId?: string | null;
}

export interface ThreadPassthroughDecision {
  /** TRUE only when this decision moved the wake to a different, deliverable lane. */
  applied: boolean;
  mode: 'apply' | 'off';
  hookClass: ThreadPassthroughHookClass;
  /** The lane that WOULD own the thread (the parent), or '' when nothing was named. */
  wouldTargetChatId: string;
  /** THE lane to deliver to. Always non-empty: the owning lane when applied, else the subscribed target. */
  targetChatId: string;
  reason: ThreadPassthroughReason;
  /** The chat whose event triggered the wake (the emitting lane). */
  sourceChatId: string;
}

/**
 * The DISTINCT, non-empty source-chat ids inside one delivery GROUP.
 *
 * WHY THIS EXISTS (SAA-1.2 thread-key continuity, 2026-11-05): the sweep groups
 * pending rows by `hookId` ALONE (`hooks.service.ts` — `groups.get(row.hookId)`),
 * so a WILDCARD hook's group routinely fans in from SEVERAL chats at once. The
 * coalesce contract already has to say so out loud — it renders
 * `Source chat id: multiple (see per-source headers)` when the rows disagree.
 * Routing is what never learned that fact.
 */
export function distinctGroupSourceChatIds(
  sourceChatIds: readonly (string | null | undefined)[] | null | undefined,
  fallback?: string | null,
): string[] {
  const raw = sourceChatIds ?? (fallback ? [fallback] : []);
  const out: string[] = [];
  for (const v of raw) {
    const id = typeof v === 'string' ? v.trim() : '';
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * TRUE when this group carries events from MORE THAN ONE thread.
 *
 * A multi-thread group must NEVER be re-targeted: the wake would hand every
 * other thread's events to ONE thread's owning lane — the exact opposite of
 * continuity, and a mis-delivery that no later guard could undo. The subscribed
 * target is the only correct route for such a group.
 *
 * A caller that predates this field (or passes nothing) falls back to the
 * single `sourceChatId`, which reads as "one thread" — never as a licence to
 * re-target a group whose shape it did not establish.
 */
export function groupSpansMultipleThreads(
  sourceChatIds: readonly (string | null | undefined)[] | null | undefined,
  fallback?: string | null,
): boolean {
  return distinctGroupSourceChatIds(sourceChatIds, fallback).length > 1;
}

/**
 * Resolve the delivery target for ONE delivery group. Pure; never throws.
 *
 * The ONE case that moves a wake is a WILDCARD hook whose target is a
 * supervisor and whose emitting chat carries a parentChatId that is a
 * DIFFERENT, DELIVERABLE lane (exists, not archived, same account). Every other
 * shape delivers to the subscribed target unchanged — the old route is always
 * correct, only less efficient, so every uncertainty resolves to it.
 */
export function planThreadPassthrough(
  input: {
    hook: ThreadPassthroughHook;
    sourceChatId: string;
    source: ThreadPassthroughSourceFacts | null | undefined;
    target: ThreadPassthroughTargetFacts | null | undefined;
    /** The resolved parent row. null/absent = the edge is dead. */
    parent?: ThreadPassthroughParentFacts | null;
    /** The hook's owning user — a re-target must never cross accounts. */
    ownerUserId?: string | null;
    /** DISTINCT source chats inside the GROUP being routed. Omitted ⇒ the group
     *  is treated as the single `sourceChatId` (see groupSpansMultipleThreads). */
    groupSourceChatIds?: readonly (string | null | undefined)[] | null;
  },
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): ThreadPassthroughDecision {
  const hook = input?.hook;
  const sourceChatId = String(input?.sourceChatId ?? '');
  const subscribed = String(hook?.targetChatId ?? '');
  const specific = typeof hook?.sourceChatId === 'string' && hook.sourceChatId.length > 0;
  const hookClass: ThreadPassthroughHookClass = specific ? 'specific' : 'wildcard';
  const base = { applied: false, hookClass, sourceChatId, targetChatId: subscribed, wouldTargetChatId: '' };

  if (hookThreadPassthroughDisabled(env)) {
    return { ...base, mode: 'off', reason: 'target_not_supervisor' };
  }
  // A specific hook (child→parent result hook, todo_wake self-hook) already
  // names a deliberate target; re-deriving it would undo that decision.
  if (specific) return { ...base, mode: 'apply', reason: 'specific_hook' };
  // Only a supervisor wake is the interceptable class — a lane wake is already
  // at the lane that owns the work.
  const target = input?.target;
  if (!target || (target.isSupervisor !== true && target.isProjectSupervisor !== true)) {
    return { ...base, mode: 'apply', reason: 'target_not_supervisor' };
  }
  // ── THREAD-KEY CONTINUITY GUARD (SAA-1.2 residual, 2026-11-05) ──
  // A delivery GROUP is keyed by hookId alone, so it can carry events from MANY
  // source chats. The lineage facts handed to this leaf describe ONE of them
  // (the first row's), so re-targeting the group would deliver every other
  // thread's events to that one thread's owning lane. Routing must therefore
  // refuse to move any group that spans more than one thread — the subscribed
  // target is the only route that is correct for all of its rows.
  if (groupSpansMultipleThreads(input?.groupSourceChatIds, sourceChatId)) {
    return { ...base, mode: 'apply', reason: 'multi_source_group' };
  }
  const parent = typeof input?.source?.parentChatId === 'string' ? input.source.parentChatId : '';
  if (!parent) return { ...base, mode: 'apply', reason: 'no_lineage' };
  // The lineage resolves back to the subscribed target: the supervisor is the
  // owning lane, so the wake is already in the right place.
  if (parent === hook.targetChatId) return { ...base, mode: 'apply', reason: 'owner_is_target' };
  // A parent id we cannot distinguish from the emitting chat itself is not a
  // walkable edge (a self-parent would recommend waking the emitter).
  if (parent === sourceChatId) return { ...base, mode: 'apply', reason: 'lineage_unresolved' };
  // ── THE DELIVERABILITY GUARD (see the module header) ──
  const parentFacts = input?.parent;
  if (!parentFacts) return { ...base, mode: 'apply', wouldTargetChatId: parent, reason: 'lineage_unresolved' };
  if (parentFacts.archivedAt) return { ...base, mode: 'apply', wouldTargetChatId: parent, reason: 'owner_archived' };
  const parentUser = typeof parentFacts.userId === 'string' ? parentFacts.userId : '';
  const ownerUser = typeof input?.ownerUserId === 'string' ? input.ownerUserId : '';
  // FAIL-CLOSED ON IDENTITY: without BOTH ids there is no positive proof the
  // parent belongs to the same account, and "probably the same owner" is not a
  // licence to deliver a wake into another account's chat.
  if (!parentUser || !ownerUser) return { ...base, mode: 'apply', wouldTargetChatId: parent, reason: 'lineage_unresolved' };
  if (parentUser !== ownerUser) {
    return { ...base, mode: 'apply', wouldTargetChatId: parent, reason: 'owner_other_account' };
  }
  return { ...base, applied: true, mode: 'apply', targetChatId: parent, wouldTargetChatId: parent, reason: 'owner_is_other_lane' };
}

/**
 * The loop-metric meta for a re-target — ids and counts only. Returns null when
 * there is nothing to record (kill switch on, or this group already delivered at
 * its owning lane), so an unchanged delivery writes no row. Pure.
 */
export function threadPassthroughMetricMeta(decision: ThreadPassthroughDecision): Record<string, unknown> | null {
  if (!decision || decision.mode !== 'apply') return null;
  if (decision.reason !== 'owner_is_other_lane' || !decision.applied || !decision.wouldTargetChatId) return null;
  return {
    reason: decision.reason,
    hookClass: decision.hookClass,
    sourceChatId: decision.sourceChatId.slice(0, 64),
    wouldTargetChatId: decision.wouldTargetChatId.slice(0, 64),
    applied: decision.applied,
  };
}