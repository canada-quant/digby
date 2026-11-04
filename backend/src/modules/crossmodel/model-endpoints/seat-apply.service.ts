/**
 * "Apply seats to existing sessions" (seats govern sessions, 2026-09-28).
 *
 * POST /admin/model-roles/apply-seats { dryRun } — the admin's one-click
 * version of what the owner did by hand on 2026-09-28 when re-seating the
 * Workspace default did not reach the sessions already alive:
 *
 *   projects  — a project codingModel override that a MACHINE wrote
 *               (settings.codingModelSource 'machine') OR a legacy override
 *               with no provenance that points at a BUILT-IN id is CLEARED
 *               (the seat governs); a human-set override ('user') or a
 *               registry-spec override with no provenance is KEPT and listed;
 *   sessions  — a live session (ready / running / provisioning) whose stamp
 *               has NO provenance (modelSource NULL) and differs from the seat
 *               is RE-STAMPED to the seat (the stamp is a record — the run
 *               path already resolves the seat live; this makes the side
 *               panel and older readers agree); a session with an explicit
 *               pick ('spawn-param' / 'explicit') is listed and left alone;
 *   prefs     — READ-ONLY: users whose stored codingModel is a pick value are
 *               listed as explicit (marker present — their sessions follow
 *               their own pick) or ignored (no marker — the seat governs them
 *               under the new rule; nothing to change).
 *
 * dryRun (the UI's preview) reports the same plan without writing. Every
 * run — dry or not — records loop_metrics `seat_apply` {projects, sessions,
 * prefs} (value = sessions re-stamped) and an Activity row. Never throws on a
 * per-row failure: each is counted under `errors` and named.
 */

import logger from '../../../utils/logger';
import prisma from '../../../config/database';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

export const LIVE_SESSION_STATUSES: readonly string[] = ['ready', 'running', 'provisioning'];

export interface SeatApplyProjectRow { projectId: string; codingModel: string; source: 'user' | 'machine' | null; action: 'cleared' | 'kept'; reason: string }
export interface SeatApplySessionRow { sessionId: string; projectId: string; from: string; to: string; action: 'restamped' | 'explicit' | 'already_on_seat'; modelSource: string | null }
export interface SeatApplyPrefRow { userId: string; codingModel: string; action: 'explicit' | 'ignored' }

export interface SeatApplyReport {
  dryRun: boolean;
  seat: string;
  at: string;
  projects: { cleared: number; kept: number; rows: SeatApplyProjectRow[] };
  sessions: { restamped: number; explicit: number; alreadyOnSeat: number; rows: SeatApplySessionRow[] };
  prefs: { explicit: number; ignored: number; rows: SeatApplyPrefRow[] };
  errors: string[];
}

/** A built-in coding model id (no '<label>:' prefix) — the ones the owner's hand script cleared. */
export function isBuiltInCodingId(model: string): boolean {
  return !!model && !model.includes(':');
}

/** Pure: what to do with one project override. */
export function classifyProjectOverride(pick: string, source: 'user' | 'machine' | null): { action: 'cleared' | 'kept'; reason: string } {
  if (source === 'user') return { action: 'kept', reason: 'human-set project pick' };
  if (source === 'machine') return { action: 'cleared', reason: 'machine-written override (never shadows the seat)' };
  if (isBuiltInCodingId(pick)) return { action: 'cleared', reason: 'legacy built-in override with no provenance (framework-stamped)' };
  return { action: 'kept', reason: 'legacy registry-spec override with no provenance (treated as user-set)' };
}

export async function applySeatsToExistingSessions(opts: { dryRun: boolean; actorId?: string }): Promise<SeatApplyReport> {
  const dryRun = opts.dryRun !== false;
  const at = new Date().toISOString();
  const errors: string[] = [];
  const governance = await import('../coding/seat-governance');
  const seat = await governance.resolveCodingSeatModel();

  // ── Projects: every leaf settings row that carries a codingModel override. ──
  const projects: SeatApplyProjectRow[] = [];
  try {
    const rows = await prisma.contextStoreEntry.findMany({
      where: { key: 'state', namespacePath: { endsWith: ':settings' } },
      select: { namespacePath: true, value: true },
    });
    const { setProjectSettings } = await import('../langgraph/memory.graph');
    for (const row of rows) {
      const v = (row.value && typeof row.value === 'object' ? row.value : {}) as { codingModel?: unknown; codingModelSource?: unknown };
      const pick = typeof v.codingModel === 'string' ? v.codingModel.trim() : '';
      if (!pick) continue;
      const projectId = row.namespacePath.slice(0, -':settings'.length);
      const source = v.codingModelSource === 'user' || v.codingModelSource === 'machine' ? v.codingModelSource : null;
      const verdict = classifyProjectOverride(pick, source);
      projects.push({ projectId, codingModel: pick, source, action: verdict.action, reason: verdict.reason });
      if (verdict.action === 'cleared' && !dryRun) {
        try { await setProjectSettings(projectId, { codingModel: '' }); } catch (err: any) { errors.push(`project ${projectId.slice(0, 8)}: ${String(err?.message || err)}`); }
      }
    }
  } catch (err: any) {
    errors.push(`projects: ${String(err?.message || err)}`);
  }

  // ── Sessions: live rows, NULL provenance, not on the seat → re-stamp. ──
  const sessions: SeatApplySessionRow[] = [];
  try {
    const rows: Array<{ id: string; projectId: string; model: string; modelSource: string | null }> = await (prisma as any).chatCodingState.findMany({
      where: { status: { in: [...LIVE_SESSION_STATUSES] } },
      select: { id: true, projectId: true, model: true, modelSource: true },
    });
    for (const s of rows) {
      if (governance.isExplicitModelSource(s.modelSource)) {
        sessions.push({ sessionId: s.id, projectId: s.projectId, from: s.model, to: s.model, action: 'explicit', modelSource: s.modelSource });
        continue;
      }
      if (s.model === seat) {
        sessions.push({ sessionId: s.id, projectId: s.projectId, from: s.model, to: seat, action: 'already_on_seat', modelSource: s.modelSource });
        continue;
      }
      sessions.push({ sessionId: s.id, projectId: s.projectId, from: s.model, to: seat, action: 'restamped', modelSource: s.modelSource });
      if (!dryRun) {
        try {
          await (prisma as any).chatCodingState.update({ where: { id: s.id }, data: { model: seat } });
        } catch (err: any) {
          errors.push(`session ${s.id.slice(0, 8)}: ${String(err?.message || err)}`);
        }
      }
    }
  } catch (err: any) {
    errors.push(`sessions: ${String(err?.message || err)}`);
  }

  // ── Preferences: read-only listing. ──
  const prefs: SeatApplyPrefRow[] = [];
  try {
    const rows: Array<{ userId: string; codingModel: string | null }> = await prisma.userPreferences.findMany({ select: { userId: true, codingModel: true } });
    for (const p of rows) {
      const stored = typeof p.codingModel === 'string' ? p.codingModel.trim() : '';
      if (!governance.isCodingModelPickValue(stored)) continue;
      const explicit = await governance.isCodingModelExplicit(p.userId, stored).catch(() => false);
      prefs.push({ userId: p.userId, codingModel: stored, action: explicit ? 'explicit' : 'ignored' });
    }
  } catch (err: any) {
    errors.push(`prefs: ${String(err?.message || err)}`);
  }

  const report: SeatApplyReport = {
    dryRun, seat, at,
    projects: { cleared: projects.filter(r => r.action === 'cleared').length, kept: projects.filter(r => r.action === 'kept').length, rows: projects },
    sessions: {
      restamped: sessions.filter(r => r.action === 'restamped').length,
      explicit: sessions.filter(r => r.action === 'explicit').length,
      alreadyOnSeat: sessions.filter(r => r.action === 'already_on_seat').length,
      rows: sessions,
    },
    prefs: { explicit: prefs.filter(r => r.action === 'explicit').length, ignored: prefs.filter(r => r.action === 'ignored').length, rows: prefs },
    errors,
  };

  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.SEAT_APPLY,
      value: report.sessions.restamped,
      meta: {
        dryRun, seat,
        projects: { cleared: report.projects.cleared, kept: report.projects.kept },
        sessions: { restamped: report.sessions.restamped, explicit: report.sessions.explicit, alreadyOnSeat: report.sessions.alreadyOnSeat },
        prefs: { explicit: report.prefs.explicit, ignored: report.prefs.ignored },
        errors: errors.length,
        ...(opts.actorId ? { actorId: opts.actorId } : {}),
      },
    });
  } catch { /* telemetry never fails the action */ }
  if (opts.actorId) {
    try {
      await prisma.activity.create({ data: { userId: opts.actorId, action: dryRun ? 'model_roles.apply_seats_preview' : 'model_roles.apply_seats', resource: 'platform', metadata: { seat, projects: report.projects.cleared, sessions: report.sessions.restamped, prefsIgnored: report.prefs.ignored, errors: errors.length } } });
    } catch (err: any) {
      logger.warn(`seat-apply: audit write failed: ${err?.message}`);
    }
  }
  logger.info(`seat-apply: ${dryRun ? 'DRY RUN' : 'APPLIED'} seat=${seat} projects cleared=${report.projects.cleared} kept=${report.projects.kept} sessions restamped=${report.sessions.restamped} explicit=${report.sessions.explicit} onSeat=${report.sessions.alreadyOnSeat} prefs explicit=${report.prefs.explicit} ignored=${report.prefs.ignored} errors=${errors.length}`);
  return report;
}
