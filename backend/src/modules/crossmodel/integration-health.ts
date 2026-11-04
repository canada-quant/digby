/**
 * Platform-level integration READ-path health (ticket fa956f09, 2026-09-24).
 *
 * The 2026-09-22 X outage: x_search / x_get_trends silently returned empty
 * results for a full day while Account → Integrations kept showing X
 * "connected" — "connected" only reflects the per-user OAuth row, and the
 * platform-side read path (x-mcp → Bright Data gateway) had failed with no
 * state recorded anywhere. This module is that state: ONE row per provider
 * (Prisma `IntegrationHealth`, table `integration_health`) holding the read
 * path's LAST outcome, written by the MCP client wrapper on every read call.
 *
 * Why Postgres and not a process-local latch (the DeepSeek billing-latch
 * pattern): X reads execute in the WORKER process while the integrations
 * status API is served by WEB — only the database is shared state both see.
 *
 * Every write here is BEST-EFFORT: health recording must never break or slow
 * the read it observes, so failures are swallowed with one warn line.
 */

import prisma from '../../config/database';
import logger from '../../utils/logger';

export type ReadHealthStatus = 'ok' | 'fail';

export interface ReadHealth {
  status: ReadHealthStatus;
  lastError: string | null;
  lastErrorAt: Date | null;
  lastSuccessAt: Date | null;
  failureCount: number;
  updatedAt: Date;
}

/** Cap stored error text — reasons are short, payloads can be huge. */
const MAX_ERROR_CHARS = 500;

/**
 * Record the outcome of one integration read call. Never throws.
 * A success resets the consecutive-failure counter; a failure increments it.
 */
export async function recordReadOutcome(
  provider: string,
  ok: boolean,
  reason?: string,
): Promise<void> {
  const shortReason = (reason ?? 'unknown error').slice(0, MAX_ERROR_CHARS);
  const now = new Date();
  try {
    await (prisma as any).integrationHealth.upsert({
      where: { provider },
      create: ok
        ? { provider, status: 'ok', lastSuccessAt: now, failureCount: 0 }
        : { provider, status: 'fail', lastError: shortReason, lastErrorAt: now, failureCount: 1 },
      update: ok
        ? { status: 'ok', lastSuccessAt: now, failureCount: 0 }
        : { status: 'fail', lastError: shortReason, lastErrorAt: now, failureCount: { increment: 1 } },
    });
  } catch (err: any) {
    logger.warn(`integration-health: recording ${provider}=${ok ? 'ok' : 'fail'} failed (non-blocking): ${err?.message || err}`);
  }
}

/**
 * The provider's last recorded read outcome, or null when it has never been
 * written (a fresh deploy before any read — treat as healthy/unknown).
 * Never throws.
 */
export async function getReadHealth(provider: string): Promise<ReadHealth | null> {
  try {
    const row = await (prisma as any).integrationHealth.findUnique({ where: { provider } });
    return row ?? null;
  } catch {
    return null;
  }
}
