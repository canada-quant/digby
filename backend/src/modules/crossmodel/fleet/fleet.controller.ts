/**
 * Fleet Management — thin HTTP transport over fleet.service.ts (mirrors
 * crossmodel.controller.ts style: try/catch → next(error), AppError carries
 * the status). All endpoints are owner-scoped in the service layer.
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../../middleware/auth';
import * as fleetService from './fleet.service';
import type { FleetLogRow } from './fleet.service';
import { resolveViewModeForRequest } from '../view/view-mode';
import { minimalMessages, minimalText } from '../view/minimal-view';

/**
 * Minimal-view sanitizers for fleet log rows / wake notes (ticket 24dd04d5): the
 * Logs tab renders summaries verbatim and the dashboard card renders note
 * content, so a minimal viewer must never receive harness chrome (verifier /
 * evidence-guard banners), a guard-struck note, or a raw machine-wake prompt —
 * automation STAYS visible (the row, the card, a neutral one-liner); machinery
 * does not. Mirrors view/minimal-view.ts (chrome split + WITHHELD classes).
 */
const CHROME_LEADS = ['[HARNESS EVIDENCE GUARD', '[ACTION VERIFIER'];

function isChromeLead(s: string): boolean {
  const lead = (s || '').trimStart();
  return CHROME_LEADS.some((p) => lead.startsWith(p));
}

/**
 * The neutral automation one-liner. Fleet-surface-specific wording (review nit,
 * ticket 24dd04d5): the chat thread's minimal view HIDES machine wakes entirely
 * (stub(row, {hidden:true})); here the row stays visible — automation stays on
 * the dashboard — with a neutral one-liner instead of the raw wake prompt.
 */
export const FLEET_AUTOMATION_STUB = 'Fleet automation ran — open Supervisor Chat for details.';

/**
 * Sanitize one raw-log summary for a minimal viewer. Returns null = the row is
 * withheld entirely (a supervisor note that is ONLY chrome), otherwise the
 * summary to serve: a machine wake becomes the neutral stub; a supervisor
 * reply keeps its body with any trailing chrome stripped (splitHarnessChrome).
 */
function minimalLogSummary(r: Pick<FleetLogRow, 'kind' | 'summary'>): string | null {
  if (r.kind === 'machine_wake') return FLEET_AUTOMATION_STUB;
  if (r.kind !== 'supervisor_reply') return r.summary;
  if (isChromeLead(r.summary)) return null;
  const body = minimalText(r.summary).trim();
  return body || null;
}


class FleetController {
  /** GET /fleet/supervisor — the caller's auto-provisioned supervisor chat + live view (read-only). */
  async getSupervisor(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      res.json(await fleetService.getFleetSupervisor(req.user!.id));
    } catch (error) {
      next(error);
    }
  }

  /** GET /fleet/overview — aggregate counts + summary rows (no transcripts). */
  async getOverview(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      res.json(await fleetService.getFleetOverview(req.user!.id));
    } catch (error) {
      next(error);
    }
  }

  /** GET /fleet/usage — account-wide spend + tokens per project for the Fleet Supervisor side panel (platform/usage-rollup.ts). */
  async getUsage(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { fleetUsage, supervisorUsageDisabled } = await import('../platform/usage-rollup');
      if (supervisorUsageDisabled()) { res.status(404).json({ error: 'Not found' }); return; }
      // Minimal view (2026-10-16): no cost or token figures for this viewer — the panel hides itself on a 404.
      if ((await resolveViewModeForRequest(req as any)) === 'minimal') { res.status(404).json({ error: 'Not found' }); return; }
      res.json(await fleetUsage(req.user!.id));
    } catch (error) {
      next(error);
    }
  }

  /** GET /fleet/pulse — the management dashboard's one-glance digest (PRs/deploy + ticket queue are ADMIN-only sections). */
  async getPulse(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      res.json(await fleetService.getFleetPulse(req.user!.id, (req.user as any)?.role ?? 'USER'));
    } catch (error) {
      next(error);
    }
  }

  /** GET /fleet/supervisor/thread?before&limit&includeMachine — interactive by default; includeMachine returns the full transcript. */
  async getThread(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { before, limit, includeMachine } = req.query as any;
      const page = await fleetService.getSupervisorThread(req.user!.id, { before, limit, includeMachine });
      // Minimal view (2026-10-16, view/minimal-view.ts): machine turns arrive as hidden stubs.
      if ((await resolveViewModeForRequest(req as any)) === 'minimal' && page && Array.isArray((page as any).messages)) {
        res.json({ ...page, messages: minimalMessages((page as any).messages) });
        return;
      }
      res.json(page);
    } catch (error) {
      next(error);
    }
  }

  /** GET /fleet/supervisor/latest-summary — the dashboard Fleet-summary card's source: the durable transcript's newest machine wake note (single source of truth — no second summarizer).
   *  Minimal view (ticket 24dd04d5): a raw wake note is internal machinery (machine prompts, harness
   *  chrome) — a regular user's dashboard card gets the owner-briefing plain-English layer only; a
   *  technical note becomes the same neutral "Fleet automation ran" stub the thread stubs carry, and a
   *  guard-struck note (chrome-only) is withheld outright. Briefings are themselves the briefing layer
   *  (plain-English, chrome-free) and pass through unchanged. */
  async getLatestSummary(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const result = await fleetService.getLatestSupervisorWakeNote(req.user!.id);
      if (
        (await resolveViewModeForRequest(req as any)) === 'minimal' &&
        result?.note &&
        result.note.kind !== 'briefing'
      ) {
        const hasBody = minimalText(result.note.content).trim().length > 0;
        res.json({
          ...result,
          note: !isChromeLead(result.note.content) && hasBody
            ? { ...result.note, content: FLEET_AUTOMATION_STUB }
            : null, // guard chrome only — never served (isVerifierStruckNote class)
        });
        return;
      }
      res.json(result);
    } catch (error) {
      next(error);
    }
  }

  /** POST /fleet/supervisor/messages { content, uploadIds? } — sends now, or queues on busy. */
  async postMessage(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const result = await fleetService.sendSupervisorMessage(req.user!.id, req.body.content, req.body.uploadIds);
      res.status(result.queued ? 202 : 200).json(result);
    } catch (error) {
      next(error);
    }
  }

  /** GET /fleet/log?before&limit — the merged raw log (noise included).
   *  Minimal view (ticket 24dd04d5): machinery must not leave the server for a
   *  regular user — the Logs tab renders every row's raw summary, so wake rows
   *  (raw machine prompts) and guard-struck supervisor chrome must be filtered
   *  exactly like the thread endpoint above. */
  async getLog(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { before, limit } = req.query as any;
      const page = await fleetService.getFleetLog(req.user!.id, { before, limit });
      if ((await resolveViewModeForRequest(req as any)) === 'minimal') {
        const messages: FleetLogRow[] = Array.isArray(page?.messages) ? page.messages : [];
        const kept: Array<FleetLogRow & { summary: string }> = [];
        for (const r of messages) {
          const summary = minimalLogSummary(r);
          if (summary !== null) kept.push({ ...r, summary });
        }
        res.json({ ...page, messages: kept });
        return;
      }
      res.json(page);
    } catch (error) {
      next(error);
    }
  }

  /** GET /fleet/digests?showAcked=1|true — the stored hourly per-project digests (read-only; acked items excluded unless showAcked). */
  async getDigests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const q = (req.query as any).showAcked;
      const showAcked = q === '1' || q === 'true';
      res.json(await fleetService.getProjectDigests(req.user!.id, { showAcked }));
    } catch (error) {
      next(error);
    }
  }

  /** POST /fleet/digests/ack { key, snoozeHours? } — silence one attention item (survives the hourly overwrite). */
  async ackDigestItem(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      res.json(await fleetService.ackDigestItem(req.user!.id, req.body ?? {}));
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /fleet/digests/ack/:key — lift a silence (idempotent). */
  async unackDigestItem(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      // The client percent-encodes the key exactly once (lib/api/fleet.ts) and
      // Express decodes route params exactly once — decoding AGAIN here mangled
      // any key containing a literal escape sequence (e.g. a title-fallback key
      // with "%2F" became "/"), so deleteMany matched nothing and the silence
      // could never be lifted (review 2026-08-16). Use the param as-is.
      res.json(await fleetService.unackDigestItem(req.user!.id, req.params.key));
    } catch (error) {
      next(error);
    }
  }

  /** GET /fleet/schedules — every schedule the caller owns (full lifecycle fields), for the Schedules tab. */
  async getSchedules(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      res.json(await fleetService.getFleetSchedules(req.user!.id));
    } catch (error) {
      next(error);
    }
  }

  /** POST /fleet/schedules/:id/cancel — disable one of the caller's schedules (audited). */
  async cancelSchedule(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      res.json(await fleetService.dismissFleetSchedule(req.user!.id, req.params.id));
    } catch (error) {
      next(error);
    }
  }
}

export default new FleetController();
