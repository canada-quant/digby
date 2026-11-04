/**
 * User Space (P3 — docs/USER_SPACE_DESIGN.md §2): every user gets ONE hidden,
 * personal "Workspace" project, and every chat they create is filed into it
 * by default (auto-filing, §3). Because the space is workspace-capable
 * ('blank' provider), every chat is code-CAPABLE from birth — but capability
 * only means "attachable on demand": THE ROUTING RULE (§4) keys the coding
 * pipeline off the ChatCodingState satellite, never off folder capability, so
 * plain sends stay plain until an attach trigger (router §4a / attach_workspace
 * tool §4b / manual menu item) adds the satellite.
 *
 * ensureUserSpace follows the ensureFleetSupervisor invariants
 * (platform/supervisor.service.ts): find-first → create with P2002 convergence
 * (the partial unique index crossmodel_projects_one_userspace_per_owner backs
 * the race) → NEVER throw (a hiccup must not fail the triggering chat
 * creation/move — log and return null; the chat proceeds unfiled).
 */

import { randomUUID } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';

/** The user space's fixed display name (hidden from every project surface). */
export const USER_SPACE_NAME = 'Workspace';

export interface UserSpaceRef {
  id: string;
  repoProvider: string | null;
}

/**
 * Ensure the user's ONE user-space project exists (idempotent) and return it.
 * Adults get a 'blank' (workspace-capable, legacy session-chained) provider —
 * v1 per spec §8 open question 1; KID accounts get repoProvider NULL (a PLAIN
 * space, spec §2/§4c — non-negotiable: a capable folder would break the kid
 * chat attach and open the platform-path hole, so kid chats are never
 * codeCapable). Returns null on any failure (logged, never thrown).
 */
export async function ensureUserSpace(userId: string): Promise<UserSpaceRef | null> {
  try {
    if (!userId) return null;

    // Kid variant (spec §2): the account kind decides the space's provider, so
    // read it up front (same select the fleet supervisor's kid guard uses).
    const user = await prisma.user
      .findUnique({ where: { id: userId }, select: { isChild: true } })
      .catch(() => null);
    if (!user) return null;

    // 1. Already there? Return it (no drift to heal — the row is system-owned
    //    and project mutations guard on ownership already).
    const existing = await prisma.crossModelProject.findFirst({
      where: { userId, isUserSpace: true },
      select: { id: true, repoProvider: true },
    });
    if (existing) return existing;

    // 2. Create it. The partial unique index (one user space per OWNER) backs
    //    this find-then-create: a concurrent ensure loses with a P2002 and
    //    converges on the winner's row.
    const id = randomUUID();
    try {
      const created = await prisma.crossModelProject.create({
        data: {
          id,
          userId,
          name: USER_SPACE_NAME,
          isUserSpace: true,
          isPublic: false,   // personal forever — never shareable (spec §2)
          // supervised TRUE (2026-09-02 integration fix): false would deafen
          // wildcard-hook emission (hooks.service.ts:252), delivery re-check
          // (:516) and the attention watchdog (:360) for every auto-filed
          // chat — most of the owner's fleet lives here. Digests + the fleet
          // overview stay clean: their mappings key on isUserSpace, not
          // supervised.
          supervised: true,
          repoProvider: user.isChild ? null : 'blank',
          // P2 folder-tree invariants: roots carry depth 0 + a materialized
          // path (pre-P2 creates omitted path and broke subtree queries).
          depth: 0,
          path: `/${id}`,
        },
        select: { id: true, repoProvider: true },
      });
      logger.info(`user space: created for owner ${userId.slice(0, 8)} (provider ${created.repoProvider ?? 'plain'})`);
      return created;
    } catch (err: any) {
      if (err?.code !== 'P2002') throw err; // outer wrapper logs + returns null
      const winner = await prisma.crossModelProject.findFirst({
        where: { userId, isUserSpace: true },
        select: { id: true, repoProvider: true },
      });
      if (!winner) throw err; // index fired on something else — surface it
      return winner;
    }
  } catch (err: any) {
    logger.warn(`user space: ensure failed for owner ${String(userId).slice(0, 8)}: ${err?.message}`);
    return null;
  }
}

/**
 * Plain chats in the user space keep their own memory (2026-10-20 real-user
 * audit). The user space is ONE hidden project holding every ungrouped chat,
 * so its project memory — the "[Project Context — Shared across all chats in
 * this project]" state and the 'decision' rows the extractor files — mixed
 * unrelated conversations: a fresh "make me a logo" chat answered from another
 * chat's dog-walking brief, and a fresh cover letter opened "complete this
 * time — no truncation" after an earlier chat's cut-off draft. The user never
 * made a project, so a plain chat there neither reads nor writes the space's
 * project memory: no shared state block, no learnings / decisions from the
 * space (injected or via search_memory), no extraction. Learnings from the
 * user's REAL owned projects still blend in (labelled with their project), and
 * the space is left out of every project chat's owned-project learnings blend
 * (project supervisors included). User memory, uploaded files (RAG), coding
 * sessions and the Fleet Supervisor's fleet-learnings blend (it audits lanes
 * that may live in the space) are unchanged; supervisor chats never sit in the
 * user space. Kill switch
 * USER_SPACE_CHAT_ISOLATION_DISABLED=1 restores the shared state.
 */
export function userSpaceChatIsolated(
  chat: { isUserSpace?: boolean | null; isSupervisorChat?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (userSpaceIsolationDisabled(env)) return false;
  return chat.isUserSpace === true && chat.isSupervisorChat !== true;
}

/** The kill switch for the whole isolation: also keeps the user space in other chats' owned-project learnings blend. */
export function userSpaceIsolationDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.USER_SPACE_CHAT_ISOLATION_DISABLED === '1';
}
