/**
 * Product watch — measured PRODUCT regressions become [PRODUCT ALERT] wakes to
 * the admin owner's Fleet Supervisor (owner 2026-09-18: "harden the fleet
 * supervisor so you can retire and it can take over your role as the
 * framework operator").
 *
 * The infra watch covers the platform's body (disk, deploys, backups, cards).
 * This covers what the owner otherwise notices by hand in the UI: on
 * 2026-09-18 the follow-up chips had silently stopped persisting at Level 2
 * ("what happened to the follow-ups?") and nothing in the fleet could have
 * said so — the signal existed (loop_metrics `chat_platform_usage` carries
 * `followUps` per finalized run since that day's fix) but nobody read it.
 *
 * Signal 1 — FOLLOW-UP CHIPS per level, USER turns only (machine runs carry
 * none by design — the capability doctrine's no-chips variant): over the last
 * FOLLOWUP_WINDOW_H, per mode, if at least FOLLOWUP_MIN_USER_TURNS user turns
 * finalized and ≥ FOLLOWUP_ZERO_SHARE of them carried zero follow-ups → one
 * alert per mode, deduped PRODUCT_ALERT_DEDUPE_SEC. Rows that predate the
 * `followUps` key are skipped (they say nothing). Baseline the day it
 * shipped: 7 of 8 user turns at Level 2 carried chips.
 *
 * Runs inside the attention watchdog after the infra sweep; delivery reuses
 * infra-watch's deliver() (Redis dedupe, one wake per admin Fleet
 * Supervisor) with metric kind `product_alert`. Kill switch:
 * PRODUCT_WATCH_DISABLED=1. Pure classification/rendering, injected wake.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { adminFleetSupervisors, deliver } from './infra-watch.service';

const SOURCE = 'product-watch';
export const PRODUCT_WATCH_DISABLED_ENV = 'PRODUCT_WATCH_DISABLED';
export const FOLLOWUP_WINDOW_H = 24;
export const FOLLOWUP_MIN_USER_TURNS = 12;
export const FOLLOWUP_ZERO_SHARE = 0.75;
export const PRODUCT_ALERT_DEDUPE_SEC = 24 * 3600;
const ALERT_KEY = (kind: string, subject: string) => `product-watch:alert:${kind}:${subject}`;

export function productWatchDisabled(): boolean {
  return process.env[PRODUCT_WATCH_DISABLED_ENV] === '1';
}

/** Owner-facing level names — raw mode ids stay in parentheses for the lane. */
export const MODE_LABEL: Record<string, string> = {
  single_thinking: 'Level 1 (Single Thinking)',
  thinking: 'Level 2 (Thinking)',
  deep_research: 'Level 3 (Deep Research)',
  deep_research_all: 'Level 3 (Deep Research)',
};
export const modeLabel = (mode: string): string => MODE_LABEL[mode] ?? mode;

export interface FollowUpSummary { mode: string; n: number; zero: number; share: number }

/** Is this chat_platform_usage row a USER turn (not a machine run)? */
export function isUserTurnRow(meta: any): boolean {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.machine === true) return false;
  const trigger = meta.triggerKind;
  return trigger == null || trigger === 'user';
}

/** Per-mode zero-follow-up share over USER turns; rows without the followUps key are skipped. */
export function summarizeFollowUps(rows: Array<{ meta: any }>): FollowUpSummary[] {
  const byMode = new Map<string, { n: number; zero: number }>();
  for (const r of rows) {
    const meta = r?.meta;
    if (!isUserTurnRow(meta)) continue;
    if (meta.followUps === undefined || meta.followUps === null) continue; // pre-metric row
    const mode = String(meta.mode ?? 'unknown');
    const acc = byMode.get(mode) ?? { n: 0, zero: 0 };
    acc.n++;
    if (Number(meta.followUps) === 0) acc.zero++;
    byMode.set(mode, acc);
  }
  return [...byMode.entries()]
    .map(([mode, a]) => ({ mode, n: a.n, zero: a.zero, share: a.n ? Math.round((a.zero / a.n) * 1000) / 1000 : 0 }))
    .sort((a, b) => b.n - a.n);
}

/** Modes whose user-turn volume is meaningful AND whose zero-chip share crossed the line. */
export function classifyFollowUps(summary: FollowUpSummary[], minN: number = FOLLOWUP_MIN_USER_TURNS, share: number = FOLLOWUP_ZERO_SHARE): FollowUpSummary[] {
  return summary.filter((s) => s.n >= minN && s.share >= share);
}

const hhmmz = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}Z`;

export function renderFollowUpAlert(s: FollowUpSummary, now: Date, windowH: number = FOLLOWUP_WINDOW_H): string {
  const pct = Math.round(s.share * 100);
  const label = modeLabel(s.mode);
  return `[PRODUCT ALERT — follow-ups missing at ${label}] In the last ${windowH} h, ${s.zero} of ${s.n} user-turn answers at ${label} (mode '${s.mode}') carried NO follow-up chips (${pct}%; a healthy day is under 25% — most user turns end with three chips; machine runs are excluded, they carry none by design) as of ${hhmmz(now)}. This is the contract the owner noticed by hand on 2026-09-18 ("what happened to the follow-ups?"): the model's [FOLLOWUPS] block must survive the Level 2 reconcile (chat-agent.service parseFollowUps → metadata.followUps persisted at finalize) and the client renders the chips from that persisted metadata on reload. Playbook: dispatch_platform_task "Follow-up chips missing at ${label} — ${s.zero}/${s.n} user turns in ${windowH} h" carrying these numbers; the lane reproduces with the UI test account at that level, checks the finalize path (parseFollowUps, the safety-net re-append after reconcile, metadata persistence) and the frontend renderer, fixes on main, and verifies LIVE with one authed query whose persisted metadata carries followUps. Verify: get_fleet_telemetry view 'metrics' kind 'chat_platform_usage' — the latest user-turn rows (machine false) show followUps > 0 again — and this alert does not recur tomorrow. Never ask the owner whether the UI looks right; measure it.`;
}

export interface ProductWatchDeps {
  now?: Date;
  enqueueDirectWake?: (opts: { targetChatId: string; prompt: string; meta?: Record<string, unknown> }) => Promise<unknown>;
}

export async function sweepProductWatch(deps: ProductWatchDeps = {}): Promise<{ alerts: number }> {
  const counters = { alerts: 0 };
  if (productWatchDisabled()) return counters;
  const now = deps.now ?? new Date();
  const wake = deps.enqueueDirectWake ?? (async (o) => (await import('../platform/hooks.service')).enqueueDirectWake(o));
  try {
    const targets = await adminFleetSupervisors();
    if (!targets.length) return counters;
    const since = new Date(now.getTime() - FOLLOWUP_WINDOW_H * 3600 * 1000);
    const rows = (await prisma.loopMetric.findMany({
      where: { kind: LOOP_METRIC_KINDS.CHAT_PLATFORM_USAGE, createdAt: { gte: since } },
      select: { meta: true },
      take: 5000,
    }).catch(() => [])) as Array<{ meta: any }>;
    const alerts = classifyFollowUps(summarizeFollowUps(rows));
    for (const a of alerts) {
      counters.alerts += await deliver(
        targets,
        ALERT_KEY('followups', a.mode),
        PRODUCT_ALERT_DEDUPE_SEC,
        renderFollowUpAlert(a, now),
        { kind: 'followups', mode: a.mode, n: a.n, zero: a.zero, share: a.share },
        wake,
        LOOP_METRIC_KINDS.PRODUCT_ALERT,
      );
    }
  } catch (err: any) {
    logger.warn(`${SOURCE}: sweep failed (non-fatal): ${err?.message ?? err}`, { source: SOURCE });
  }
  return counters;
}
