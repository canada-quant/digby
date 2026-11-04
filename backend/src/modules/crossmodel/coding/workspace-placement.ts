/**
 * PER-USER WORKSPACE SUBTREE — placement of NEW data (build 2026-10-08 ISO-2).
 *
 * workspace-layout.ts answers "where IS it" (dual-read, sync, always on). This
 * module answers "where does a NEW worktree / mirror go", which needs the DB
 * (the session's owner, its recorded path, the project's owner):
 *
 *   - worktree of session S (user U): per-user (<U>/worktrees/S) when the
 *     switch applies to U AND S has no recorded LEGACY path — "new sessions
 *     first": a session whose recorded worktree path is legacy keeps the
 *     legacy layout (its env, notes and absolute paths assume it); a session
 *     whose path is null (never provisioned, or reaped — the reaper nulls it)
 *     is new. A recorded per-user path stays per-user even with the switch off.
 *   - mirror of project P (owner O): per-user (<O>/repos/P.git) when the switch
 *     applies to O; only ever consulted when NO mirror exists anywhere — an
 *     existing (legacy) mirror stays where it is and is mounted on its own.
 *
 * FAIL-SAFE: switch off → legacy with NO DB access (byte-identical to today);
 * any DB / fs error → legacy. The DB import is dynamic so this module (and
 * workspace.service, which imports it statically) stays DB-free for tests that
 * never enable the switch.
 */

import * as path from 'path';
import {
  LAYOUT_ROOT, perUserSubtreeAppliesTo, perUserSubtreeSetting, userSubtreeKey, ensureUserSubtreeSync,
  legacyWorktreePath, legacyMirrorPath, subtreeWorktreePath, subtreeMirrorPath, pathSubtreeKey,
  resolveWorktreePathSync, mirrorOfWorktreeSync,
} from './workspace-layout';

export type PlacementLayout = 'legacy' | 'per_user';
export interface Placement {
  layout: PlacementLayout;
  path: string;
  /** Why this layout (telemetry): switch_off | recorded_legacy | recorded_per_user | new_per_user | user_not_in_canary | key_collision | lookup_failed | no_owner. */
  reason: string;
  key?: string;
}

/** Telemetry: one `workspace_isolation` row (phase given). Never throws. */
export function recordIsolationMetric(phase: string, meta: Record<string, unknown>, sessionId?: string): void {
  void import('../platform/loop-metrics.service')
    .then((m) => m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS.WORKSPACE_ISOLATION, sessionId, meta: { phase, ...meta } }))
    .catch(() => {});
}

async function prismaClient(): Promise<any> {
  return (await import('../../../config/database')).default as any;
}

/**
 * Where a NEW worktree for this session goes. Only called when no worktree for
 * the session exists on disk (callers check the dual-read path first).
 */
export async function placeNewWorktree(sessionId: string, root = LAYOUT_ROOT): Promise<Placement> {
  const legacy = { layout: 'legacy' as const, path: legacyWorktreePath(sessionId, root) };
  // Switch off → today's placement with no DB access. (A per-user worktree that
  // already EXISTS is still found by the dual-read resolver before this runs;
  // only a re-provision of a wiped one lands back on the legacy path.)
  if (perUserSubtreeSetting().mode === 'off') return { ...legacy, reason: 'switch_off' };
  try {
    const prisma = await prismaClient();
    const row = await prisma.chatCodingState.findUnique({ where: { id: sessionId }, select: { userId: true, worktreePath: true } });
    if (!row?.userId) return { ...legacy, reason: 'no_owner' };
    const recorded: string | null = row.worktreePath ?? null;
    if (recorded) {
      const recKey = pathSubtreeKey(recorded, root);
      if (!recKey) return { ...legacy, reason: 'recorded_legacy' };
      return { layout: 'per_user', path: subtreeWorktreePath(recKey, sessionId, root), key: recKey, reason: 'recorded_per_user' };
    }
    if (!perUserSubtreeAppliesTo(row.userId)) return { ...legacy, reason: 'user_not_in_canary' };
    let key: string;
    try { key = ensureUserSubtreeSync(row.userId, root); } catch { return { ...legacy, reason: 'key_collision' }; }
    return { layout: 'per_user', path: subtreeWorktreePath(key, sessionId, root), key, reason: 'new_per_user' };
  } catch {
    return { ...legacy, reason: 'lookup_failed' };
  }
}

/**
 * Where a NEW mirror for this project goes (no mirror exists anywhere yet):
 * under the project OWNER's subtree when the switch applies to the owner.
 */
export async function placeNewMirror(projectId: string, root = LAYOUT_ROOT): Promise<Placement> {
  const legacy = { layout: 'legacy' as const, path: legacyMirrorPath(projectId, root) };
  if (perUserSubtreeSetting().mode === 'off') return { ...legacy, reason: 'switch_off' };
  try {
    const prisma = await prismaClient();
    const p = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { userId: true } });
    if (!p?.userId) return { ...legacy, reason: 'no_owner' };
    if (!perUserSubtreeAppliesTo(p.userId)) return { ...legacy, reason: 'user_not_in_canary' };
    let key: string;
    try { key = ensureUserSubtreeSync(p.userId, root); } catch { return { ...legacy, reason: 'key_collision' }; }
    return { layout: 'per_user', path: subtreeMirrorPath(key, projectId, root), key, reason: 'new_per_user' };
  } catch {
    return { ...legacy, reason: 'lookup_failed' };
  }
}

// ── Containment census (the dev container's mount plan) ─────────────────────

export interface ContainmentCensus {
  userId: string;
  key: string;
  /** non-archived sessions whose worktree is on disk under the user's subtree */
  perUser: number;
  /** … whose worktree is on disk at a LEGACY path (blocks a subtree-only mount) */
  legacy: number;
  legacyIds: string[];
  /** mirrors the user's per-user worktrees point at that live OUTSIDE the user's subtree (mounted one by one) */
  extraMirrors: string[];
  /** worktrees found under ANOTHER user's subtree (should be 0) */
  foreign: number;
}

/**
 * Census of a user's live (non-archived) session worktrees for the dev
 * container's mount plan. Throws on a DB error (callers keep the whole-volume
 * posture on uncertainty).
 */
export async function userContainmentCensus(userId: string, root = LAYOUT_ROOT): Promise<ContainmentCensus> {
  const prisma = await prismaClient();
  const rows: Array<{ id: string; status: string }> = await prisma.chatCodingState.findMany({
    where: { userId, status: { not: 'archived' } }, select: { id: true, status: true },
  });
  const key = userSubtreeKey(userId);
  const ownRoot = path.join(root, key);
  const out: ContainmentCensus = { userId, key, perUser: 0, legacy: 0, legacyIds: [], extraMirrors: [], foreign: 0 };
  const mirrors = new Set<string>();
  const { existsSync } = await import('fs');
  for (const r of rows) {
    const wt = resolveWorktreePathSync(r.id, root);
    if (!existsSync(wt)) continue;
    const k = pathSubtreeKey(wt, root);
    if (!k) { out.legacy++; if (out.legacyIds.length < 10) out.legacyIds.push(r.id); continue; }
    if (k !== key) { out.foreign++; continue; }
    out.perUser++;
    const mirror = mirrorOfWorktreeSync(wt);
    if (mirror && !(mirror === ownRoot || mirror.startsWith(`${ownRoot}/`)) && existsSync(mirror)) mirrors.add(mirror);
  }
  out.extraMirrors = Array.from(mirrors).sort();
  return out;
}
