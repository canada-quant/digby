/**
 * GET /api/crossmodel/instance/setup — what THIS instance has configured.
 *
 * Any signed-in user gets the per-feature booleans (the Integrations / Feeds
 * tabs render "not set up on this instance" from them); an admin also gets the
 * env NAMES that are missing, the how-to hints, the OAuth callback URLs and the
 * seat / Docker / endpoint probe results (the Admin → Setup checklist). Values
 * never leave the server — names and booleans only (platform/instance-setup.ts).
 *
 * The probes are best-effort and bounded: a failed seat read, Docker probe or
 * registry count degrades to "not probed" (null), never a 500 — a setup page
 * that cannot load on a half-configured box would defeat its purpose.
 */

import { Request, Response, NextFunction } from 'express';
import logger from '../../../utils/logger';
import { isAdminViewer } from '../view/view-mode';
import { computeInstanceSetup, redactSetupForViewer, type SeatView } from './instance-setup';
import { probeTelegramWebhook } from './telegram-webhook-probe';

const PROBE_TIMEOUT_MS = 4_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const t = setTimeout(() => { logger.debug(`instance-setup: ${label} probe timed out after ${ms} ms`); resolve(null); }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); logger.debug(`instance-setup: ${label} probe failed: ${err?.message || err}`); resolve(null); });
  });
}

async function loadSeats(userId: string | undefined): Promise<SeatView[] | null> {
  const { listModelRoles } = await import('../model-endpoints/model-roles.service');
  const roles = await listModelRoles(userId);
  return roles.map((r) => ({
    key: String(r.key),
    persona: r.persona,
    effective: r.effective,
    servable: r.servable !== false,
    unservableReason: r.unservableReason,
    missingEnvKey: r.missingEnvKey,
  }));
}

async function probeDocker(): Promise<boolean | null> {
  const { dockerProbeSkipReason, isDockerAvailable } = await import('../coding/container.service');
  if (dockerProbeSkipReason()) return null; // a cron-only / web-tier process never probes
  return isDockerAvailable();
}

async function countEnabledEndpoints(): Promise<number | null> {
  const { listEndpoints } = await import('../model-endpoints/model-endpoints.service');
  const rows = await listEndpoints();
  return rows.filter((e) => e.enabled !== false).length;
}

export async function getInstanceSetup(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user as any;
    const admin = isAdminViewer(user);
    // The seat / Docker / registry probes are ADMIN-grade (the viewer projection
    // only ever shows the env-derived booleans): a plain user's chat-page mount
    // must not spawn `docker info` or a registry read on production.
    const [seats, dockerAvailable, registeredEndpoints, telegramWebhook] = await Promise.all([
      admin ? withTimeout(loadSeats(user?.id), PROBE_TIMEOUT_MS, 'seats') : Promise.resolve(null),
      admin ? withTimeout(probeDocker(), PROBE_TIMEOUT_MS, 'docker') : Promise.resolve(null),
      admin ? withTimeout(countEnabledEndpoints(), PROBE_TIMEOUT_MS, 'endpoints') : Promise.resolve(null),
      probeTelegramWebhook(), // cached, non-prod only
    ]);
    const setup = computeInstanceSetup(process.env, { seats, dockerAvailable, registeredEndpoints, telegramWebhook });
    res.json({ success: true, data: { ...(admin ? setup : redactSetupForViewer(setup)), viewer: { admin } } });
  } catch (err) {
    next(err);
  }
}
