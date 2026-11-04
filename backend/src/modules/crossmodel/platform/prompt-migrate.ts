/**
 * PROMPT MIGRATE — re-scaffold every stored supervisor prompt onto the layered
 * composition (prompt-layers.ts, 2026-09-27). The helper an admin action
 * (POST /api/crossmodel/admin/prompts/rescaffold) or a one-shot job calls; the
 * per-wake path is ensureProjectSupervisor / healSupervisorStockPrompt, which
 * re-scaffold ONE lane when its stored text differs from the composed one.
 *
 * What it walks: every `isProjectSupervisor` chat — INCLUDING lanes whose
 * project is PAUSED (projectSupervisorEnabled=false, which ensure returns
 * early on) — and every `isSupervisor` (fleet) chat, optionally for one owner.
 * Stored stock sweep bodies (CodingSchedule.prompt opening with a stock
 * opener) are rewritten to the current generic builders too, so no firing
 * carries the incident-laden step text after the wave.
 *
 * Never throws; returns a per-chat outcome list. `dryRun` reports what would
 * change.
 *
 * Import discipline: DYNAMIC imports of both supervisor services (they import
 * autonomy.service → crossmodel.service at module scope).
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { isLayeredPrompt } from './prompt-layers';
import { SWEEP_PROMPT_OPENER, PROJECT_SWEEP_PROMPT_OPENER } from './supervisor-doctrine';

export interface MigrateOpts {
  userId?: string | null;
  dryRun?: boolean;
  /** Also rewrite stored STOCK sweep bodies (default true). */
  sweeps?: boolean;
  limit?: number;
}

export interface MigrateOutcome {
  chatId: string;
  kind: 'project' | 'fleet' | 'sweep';
  outcome: string;
  wasLayered?: boolean;
  detail?: string;
}

export interface MigrateReport {
  scanned: number;
  rewritten: number;
  outcomes: MigrateOutcome[];
}

export async function migrateSupervisorPrompts(opts: MigrateOpts = {}): Promise<MigrateReport> {
  const outcomes: MigrateOutcome[] = [];
  const limit = Math.max(1, Math.min(5_000, opts.limit ?? 5_000));
  let rewritten = 0;
  try {
    const { rescaffoldProjectSupervisorPrompt, buildProjectSupervisorSweepPrompt } = await import('./project-supervisor.service');
    const { healSupervisorStockPrompt, buildFleetSweepPrompt, findFleetSupervisorChat } = await import('./supervisor.service');

    const projectLanes = await prisma.crossModelChat.findMany({
      where: { isProjectSupervisor: true, ...(opts.userId ? { userId: opts.userId } : {}) },
      select: { id: true, userId: true, projectId: true, systemPrompt: true },
      take: limit,
    });
    for (const lane of projectLanes) {
      if (opts.dryRun) {
        const r = await rescaffoldProjectSupervisorPrompt(lane.id, { dryRun: true });
        outcomes.push({ chatId: lane.id, kind: 'project', outcome: r.outcome, wasLayered: isLayeredPrompt(lane.systemPrompt), detail: r.detail });
        continue;
      }
      const r = await rescaffoldProjectSupervisorPrompt(lane.id);
      if (r.outcome === 'rewritten') rewritten++;
      outcomes.push({ chatId: lane.id, kind: 'project', outcome: r.outcome, wasLayered: r.wasLayered, detail: r.detail });
    }

    const fleetLanes = await prisma.crossModelChat.findMany({
      where: { isSupervisor: true, ...(opts.userId ? { userId: opts.userId } : {}) },
      select: { id: true, userId: true, systemPrompt: true },
      take: limit,
    });
    for (const lane of fleetLanes) {
      const wasLayered = isLayeredPrompt(lane.systemPrompt);
      if (opts.dryRun) { outcomes.push({ chatId: lane.id, kind: 'fleet', outcome: wasLayered ? 'current-or-minor' : 'would-rewrite', wasLayered }); continue; }
      const did = await healSupervisorStockPrompt(lane.id).catch((err: any) => { logger.warn(`prompt-migrate: fleet heal failed ${lane.id.slice(0, 8)}: ${err?.message}`); return false; });
      if (did) rewritten++;
      outcomes.push({ chatId: lane.id, kind: 'fleet', outcome: did ? 'rewritten' : 'current', wasLayered });
    }

    if (opts.sweeps !== false) {
      const sweeps = await prisma.codingSchedule.findMany({
        where: {
          kind: 'recurring',
          OR: [{ prompt: { startsWith: SWEEP_PROMPT_OPENER } }, { prompt: { startsWith: PROJECT_SWEEP_PROMPT_OPENER } }],
          ...(opts.userId ? { userId: opts.userId } : {}),
        },
        select: { id: true, sessionId: true, prompt: true, chat: { select: { id: true, userId: true, projectId: true, isSupervisor: true, isProjectSupervisor: true, project: { select: { name: true } } } } },
        take: limit,
      } as any);
      for (const s of sweeps as any[]) {
        const chat = s.chat;
        if (!chat) continue;
        let current: string | null = null;
        if (chat.isSupervisor && String(s.prompt).startsWith(SWEEP_PROMPT_OPENER)) current = buildFleetSweepPrompt();
        else if (chat.isProjectSupervisor && chat.projectId && String(s.prompt).startsWith(PROJECT_SWEEP_PROMPT_OPENER)) {
          const fleet = await findFleetSupervisorChat(chat.userId).catch(() => null);
          current = buildProjectSupervisorSweepPrompt({ projectName: chat.project?.name ?? 'project', projectId: chat.projectId, fleetSupervisorChatId: fleet?.id ?? null });
        }
        if (!current || current === s.prompt) { outcomes.push({ chatId: chat.id, kind: 'sweep', outcome: current ? 'current' : 'not-stock' }); continue; }
        if (opts.dryRun) { outcomes.push({ chatId: chat.id, kind: 'sweep', outcome: 'would-rewrite', detail: `${String(s.prompt).length} → ${current.length} chars` }); continue; }
        await prisma.codingSchedule.update({ where: { id: s.id }, data: { prompt: current, promptSetBy: 'system' } as any }).catch((err: any) => logger.warn(`prompt-migrate: sweep rewrite failed ${String(s.id).slice(0, 8)}: ${err?.message}`));
        rewritten++;
        outcomes.push({ chatId: chat.id, kind: 'sweep', outcome: 'rewritten' });
      }
    }
  } catch (err: any) {
    logger.warn(`prompt-migrate: failed: ${err?.message}`);
    outcomes.push({ chatId: '-', kind: 'fleet', outcome: 'error', detail: err?.message });
  }
  return { scanned: outcomes.length, rewritten, outcomes };
}
