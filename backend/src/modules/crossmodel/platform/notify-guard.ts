/**
 * notify_user guards (audit 2026-10-06 T3-6, fleet F8).
 *
 * Prod: the Fleet Supervisor pushed the SAME news to the owner's Telegram twice
 * (05 06:46 + 06:57, "node-a 42.7 tok/s"; 06 00:02 + 00:54, the AGX "2-minute
 * wizard step"), and the 00:54 push cited "question oq_e5338871 in your Digby
 * inbox" — a question the owner had DISMISSED at 00:28 ("stop raising it").
 * notify_user had rate caps but no content dedupe and no check against the
 * owner's dismissals; the 24 h re-flag cooldown only ever guarded
 * flag_owner_question. Two refusals, each telling the model WHY:
 *
 *  1. NEAR-DUPLICATE: the normalized token set of the message is compared with
 *     the user's pushes of the last NOTIFY_USER_DEDUPE_WINDOW_MIN (default 360
 *     = 6 h; Redis, token HASHES only — no message text is stored); Jaccard ≥
 *     NOTIFY_USER_DEDUPE_SIMILARITY (default 0.7) refuses. Kill switch
 *     NOTIFY_USER_DEDUPE_DISABLED=1.
 *  2. DISMISSED QUESTION: the message cites an oq_ id (≥ 8 hex) of an owner
 *     question the owner DISMISSED within the flag_owner_question cooldown
 *     (24 h), or re-raises one (same-topic match AND ask-shaped wording).
 *     Kill switch NOTIFY_USER_DISMISSED_GUARD_DISABLED=1.
 *
 * Fail-open on every read (a down cache / DB never silences the user's own
 * alerts — the notify_user rate-cap doctrine). Lazy prisma / redis imports: a
 * static config import would drag config/env into every jest graph reaching
 * account-tools.ts.
 */

import { createHash } from 'crypto';
import { DISMISSED_COOLDOWN_MS, questionTopicDedupeMatch } from './owner-questions';
import {
  kpiAnnounceStateOf, kpiAnnouncedBy, kpiAnnouncementIsRepeat, kpiValueText,
  type KpiAnnounceState, type KpiView,
} from './kpi-of-record';

export const NOTIFY_DEDUPE_DEFAULT_WINDOW_MIN = 360;
export const NOTIFY_DEDUPE_DEFAULT_SIMILARITY = 0.7;
/** Recent pushes remembered per user (newest kept). */
export const NOTIFY_DEDUPE_MAX_ENTRIES = 40;
const RECENT_KEY = (userId: string) => `notify:recent:${userId}`;

export function notifyDedupeDisabled(): boolean { return process.env.NOTIFY_USER_DEDUPE_DISABLED === '1'; }
export function notifyDismissedGuardDisabled(): boolean { return process.env.NOTIFY_USER_DISMISSED_GUARD_DISABLED === '1'; }

export function notifyDedupeWindowMs(): number {
  const raw = Number(process.env.NOTIFY_USER_DEDUPE_WINDOW_MIN);
  const min = Number.isFinite(raw) && raw > 0 ? Math.min(48 * 60, raw) : NOTIFY_DEDUPE_DEFAULT_WINDOW_MIN;
  return min * 60 * 1000;
}
export function notifyDedupeSimilarity(): number {
  const raw = Number(process.env.NOTIFY_USER_DEDUPE_SIMILARITY);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : NOTIFY_DEDUPE_DEFAULT_SIMILARITY;
}

/** Normalized token set of a push (lowercase alphanumeric runs; one-letter noise dropped). Pure. */
export function notifyTokens(text: string): string[] {
  const toks = String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t.length >= 2 || /[0-9]/.test(t));
  return [...new Set(toks)];
}
/** Short token hashes — what Redis keeps (never the text). Pure. */
export function notifyTokenHashes(text: string): string[] {
  return notifyTokens(text).map((t) => createHash('sha1').update(t).digest('hex').slice(0, 10));
}
/** Jaccard similarity of two hash sets. Pure. */
export function notifySimilarity(a: readonly string[], b: readonly string[]): number {
  if (!a.length || !b.length) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

interface RecentPush { at: number; h: string[] }

async function redis(): Promise<any> {
  return (await import('../../../config/redis')).default;
}

async function readRecent(userId: string): Promise<RecentPush[]> {
  const raw = await (await redis()).get(RECENT_KEY(userId));
  if (!raw) return [];
  const parsed = JSON.parse(String(raw));
  return Array.isArray(parsed) ? parsed.filter((e: any) => e && typeof e.at === 'number' && Array.isArray(e.h)) : [];
}

export interface NotifyDuplicate { duplicate: true; priorAt: string; similarity: number }

/** The newest push of the window this message near-duplicates, or null. Fail-open (null). */
export async function findNotifyDuplicate(userId: string, message: string, now: number = Date.now()): Promise<NotifyDuplicate | null> {
  if (notifyDedupeDisabled() || !userId) return null;
  try {
    const h = notifyTokenHashes(message);
    if (!h.length) return null;
    const windowMs = notifyDedupeWindowMs();
    const bar = notifyDedupeSimilarity();
    const recent = (await readRecent(userId)).filter((e) => now - e.at <= windowMs).sort((a, b) => b.at - a.at);
    for (const e of recent) {
      const sim = notifySimilarity(h, e.h);
      if (sim >= bar) return { duplicate: true, priorAt: new Date(e.at).toISOString(), similarity: Number(sim.toFixed(2)) };
    }
    return null;
  } catch {
    return null;
  }
}

/** Record a DELIVERED push (token hashes + time). Best-effort. */
export async function rememberNotify(userId: string, message: string, now: number = Date.now()): Promise<void> {
  if (notifyDedupeDisabled() || !userId) return;
  try {
    const h = notifyTokenHashes(message);
    if (!h.length) return;
    const windowMs = notifyDedupeWindowMs();
    const kept = (await readRecent(userId).catch(() => [])).filter((e) => now - e.at <= windowMs);
    const next = [...kept, { at: now, h }].sort((a, b) => b.at - a.at).slice(0, NOTIFY_DEDUPE_MAX_ENTRIES);
    await (await redis()).set(RECENT_KEY(userId), JSON.stringify(next), { EX: Math.ceil(windowMs / 1000) });
  } catch { /* best-effort */ }
}

/** oq_ ids a push cites (≥ 8 hex after the prefix), lowercased, distinct. Pure. */
export function citedOwnerQuestionIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of String(text ?? '').matchAll(/\boq_([0-9a-f][0-9a-f-]{7,45})/gi)) out.add(`oq_${m[1].toLowerCase().replace(/-+$/, '')}`);
  return [...out];
}

/** Ask-shaped wording — a push that re-asks rather than reports. Pure regex. */
export const NOTIFY_ASK_CUE_RE = /\?|\b(?:need(?:s)? (?:you|your)|your (?:decision|call|answer|approval|input|ok)|waiting (?:on|for) you|please|approve|confirm|inbox|decide|pick (?:one|an option)|reply)\b/i;

export interface DismissedHit { id: string; question: string; resolvedAt: string | null; via: 'cited' | 'topic'; dismissedBy?: string | null }

/**
 * The owner question this push cites or re-raises that the owner DISMISSED
 * within the flag_owner_question cooldown, or null. Fail-open (null).
 */
export async function findDismissedQuestionRaised(userId: string, message: string, now: number = Date.now()): Promise<DismissedHit | null> {
  if (notifyDismissedGuardDisabled() || !userId) return null;
  try {
    const prisma = (await import('../../../config/database')).default;
    const rows: any[] = (await prisma.ownerQuestion.findMany({
      where: { userId, status: 'dismissed', resolvedAt: { gte: new Date(now - DISMISSED_COOLDOWN_MS) } },
      orderBy: { resolvedAt: 'desc' },
      take: 50,
      select: { id: true, question: true, resolvedAt: true, dismissedBy: true },
    })) ?? [];
    if (!rows.length) return null;
    const stamp = (r: any) => (r?.resolvedAt ? new Date(r.resolvedAt).toISOString() : null);
    const cited = citedOwnerQuestionIds(message);
    for (const c of cited) {
      const row = rows.find((r) => String(r.id).toLowerCase().startsWith(c));
      if (row) return { id: String(row.id), question: String(row.question ?? ''), resolvedAt: stamp(row), via: 'cited', dismissedBy: row.dismissedBy ?? null };
    }
    if (!NOTIFY_ASK_CUE_RE.test(message)) return null;
    const topical = rows.find((r) => questionTopicDedupeMatch(String(r.question ?? ''), message));
    return topical ? { id: String(topical.id), question: String(topical.question ?? ''), resolvedAt: stamp(topical), via: 'topic', dismissedBy: topical.dismissedBy ?? null } : null;
  } catch {
    return null;
  }
}

/** The model-facing refusal sentences (say WHY; nothing was sent). */
export function renderNotifyDuplicateRefusal(d: NotifyDuplicate): string {
  return `Nothing was sent: a near-identical notification (similarity ${d.similarity}) already reached the user's Telegram at ${d.priorAt.slice(11, 16)}Z, inside the ${Math.round(notifyDedupeWindowMs() / 3600000)} h duplicate window. Do not re-push the same news — put any new detail in the chat answer, and push again only when something actually changed.`;
}

/** English phrase naming who dismissed a card (ticket abca56ce: dismissal
 *  attribution — the refusal must never attribute a supervisor/system
 *  dismissal to the owner). */
export function dismissedByPhrase(dismissedBy?: string | null): string {
  if (dismissedBy === 'supervisor') return 'the Fleet Supervisor (on the owner\'s behalf) DISMISSED';
  if (dismissedBy === 'system') return 'DISMISSED by the system (a replacement card superseded it — no owner ruling)';
  if (dismissedBy === 'agent') return 'the filing chat DISMISSED';
  return 'the OWNER DISMISSED';
}
export function renderNotifyDismissedRefusal(h: DismissedHit): string {
  const when = h.resolvedAt ? ` at ${h.resolvedAt.slice(11, 16)}Z` : '';
  return `Nothing was sent: this push ${h.via === 'cited' ? 'cites' : 're-raises'} owner question ${h.id.slice(0, 11)} ("${h.question.replace(/\s+/g, ' ').slice(0, 140)}"), which ${dismissedByPhrase(h.dismissedBy)}${when}${h.dismissedBy && h.dismissedBy !== 'owner' ? '' : ' — "stop raising it"'}. Re-raising it by Telegram inside the ${Math.round(DISMISSED_COOLDOWN_MS / 3600000)} h cooldown is refused, exactly like flag_owner_question. If the work it gated is still blocked, record that on the todo and move on; do not ask again.`;
}

// ── KPI re-announcement guard (ticket abca56ce) ──────────────────────────────
// The near-duplicate guard is blind to KPI re-announcements: every different
// number is a different token set, so "Schooltime MET at 103.9" then "162.9"
// then "113.4" sailed through while the of-record state never changed. This
// leg anchors on the REGISTER: the last-announced {value, met} state per KPI
// (Redis, per user) and the live register read at push time. A push is
// refused only when it ANNOUNCES the KPI (names the key, quotes the register
// figure, or names a distinctive key word + a rate in the unit) AND the
// of-record state is a repeat (met/unmet unchanged, value moved ≤ threshold).
// Fail-open everywhere: a down cache / DB read never silences a push.

export const NOTIFY_KPI_REANNOUNCE_DISABLED_ENV = 'NOTIFY_USER_KPI_REANNOUNCE_DISABLED';
/** Fraction of the last-announced value within which a move is not news. */
export const NOTIFY_KPI_REANNOUNCE_THRESHOLD_ENV = 'NOTIFY_USER_KPI_REANNOUNCE_THRESHOLD';
export const NOTIFY_KPI_REANNOUNCE_DEFAULT_THRESHOLD = 0.10;
/** How long a remembered announcement state is honored (ms) — matches the
 *  near-duplicate window's default 6 h so both guards age out together. */
export const NOTIFY_KPI_REANNOUNCE_WINDOW_MIN_ENV = 'NOTIFY_USER_KPI_REANNOUNCE_WINDOW_MIN';
export const NOTIFY_KPI_REANNOUNCE_DEFAULT_WINDOW_MIN = 360;
/** KPIs remembered per user (a fleet owner's supervisor can see ~40 projects). */
export const NOTIFY_KPI_REANNOUNCE_MAX_ENTRIES = 40;

export function notifyKpiReannounceDisabled(): boolean { return process.env[NOTIFY_KPI_REANNOUNCE_DISABLED_ENV] === '1'; }

export function notifyKpiReannounceThreshold(): number {
  const raw = Number(process.env[NOTIFY_KPI_REANNOUNCE_THRESHOLD_ENV]);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : NOTIFY_KPI_REANNOUNCE_DEFAULT_THRESHOLD;
}

export function notifyKpiReannounceWindowMs(): number {
  const raw = Number(process.env[NOTIFY_KPI_REANNOUNCE_WINDOW_MIN_ENV]);
  const min = Number.isFinite(raw) && raw > 0 ? Math.min(48 * 60, raw) : NOTIFY_KPI_REANNOUNCE_DEFAULT_WINDOW_MIN;
  return min * 60 * 1000;
}

const KPI_RECENT_KEY = (userId: string) => `notify:kpi-announced:${userId}`;
/** The remember-map slot for a KPI — goal-scoped, not key-scoped (review F3:
 *  two projects sharing a template KPI key must not collide — project B's
 *  first-ever push would otherwise be refused on project A's remembered
 *  state, and A's memory overwritten). */
const kpiSlot = (kpi: KpiView): string => `${kpi.goalId}:${kpi.key}`;
type KpiRecentMap = Record<string, KpiAnnounceState>; // slot → last announced of-record state

async function readKpiRecent(userId: string): Promise<KpiRecentMap> {
  const raw = await (await redis()).get(KPI_RECENT_KEY(userId));
  if (!raw) return {};
  const parsed = JSON.parse(String(raw));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

export interface KpiReannounceHit {
  key: string;           // the register's premise key (kpi:-prefixed)
  goalId: string;
  value: number;         // the live of-record value
  unit?: string;
  met: boolean;          // the live of-record met/unmet verdict
  priorValue: number;    // the value the last push announced
  priorAt: string;       // when that push landed
  threshold: number;
}

/**
 * The KPI this push RE-ANNOUNCES (unchanged of-record state, value within the
 * threshold), or null. Order: read the user's KPIs from the register, keep the
 * ones this push announces, and return the first whose remembered state says
 * the announcement carries no news. Fail-open (null) on every error.
 */
export async function findKpiReannouncement(userId: string, message: string, now: number = Date.now()): Promise<KpiReannounceHit | null> {
  if (notifyKpiReannounceDisabled() || !userId) return null;
  try {
    const { loadKpisForOwner } = await import('./kpi-register.service');
    const kpis: KpiView[] = await loadKpisForOwner(userId).catch(() => []);
    if (!kpis.length) return null;
    const announced = kpis.filter((k) => Number.isFinite(Number(k.value)) && kpiAnnouncedBy(message, k));
    if (!announced.length) return null;
    const threshold = notifyKpiReannounceThreshold();
    const recent = await readKpiRecent(userId);
    const windowMs = notifyKpiReannounceWindowMs();
    for (const kpi of announced) {
      const last = recent[kpiSlot(kpi)];
      if (!last || !Number.isFinite(Number(last.value))) continue;
      if (now - Number(last.at) > windowMs) continue; // aged out — announce again
      const live = kpiAnnounceStateOf(kpi, now);
      if (!kpiAnnouncementIsRepeat(last, live, threshold)) continue;
      return {
        key: String(kpi.key), goalId: String(kpi.goalId ?? ''), value: live.value,
        unit: kpi.unit ? String(kpi.unit) : undefined, met: live.met,
        priorValue: Number(last.value), priorAt: new Date(Number(last.at)).toISOString(),
        threshold,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Record the of-record state of every KPI a DELIVERED push announced. Best-effort. */
export async function rememberKpiAnnouncements(userId: string, message: string, now: number = Date.now()): Promise<void> {
  if (notifyKpiReannounceDisabled() || !userId) return;
  try {
    const { loadKpisForOwner } = await import('./kpi-register.service');
    const kpis: KpiView[] = await loadKpisForOwner(userId).catch(() => []);
    const announced = kpis.filter((k) => Number.isFinite(Number(k.value)) && kpiAnnouncedBy(message, k));
    if (!announced.length) return;
    const windowMs = notifyKpiReannounceWindowMs();
    const recent = await readKpiRecent(userId).catch(() => ({} as KpiRecentMap));
    for (const kpi of announced) recent[kpiSlot(kpi)] = kpiAnnounceStateOf(kpi, now);
    const keys = Object.keys(recent);
    // Cap the map: drop the OLDEST entries beyond the cap.
    if (keys.length > NOTIFY_KPI_REANNOUNCE_MAX_ENTRIES) {
      for (const k of keys.sort((a, b) => Number(recent[a]?.at ?? 0) - Number(recent[b]?.at ?? 0)).slice(0, keys.length - NOTIFY_KPI_REANNOUNCE_MAX_ENTRIES)) delete recent[k];
    }
    await (await redis()).set(KPI_RECENT_KEY(userId), JSON.stringify(recent), { EX: Math.ceil(windowMs / 1000) });
  } catch { /* best-effort */ }
}

/** The model-facing refusal for a KPI re-announcement (says WHY; names the register figure). */
export function renderKpiReannounceRefusal(h: KpiReannounceHit): string {
  const figure = kpiValueText({ value: h.value, unit: h.unit });
  return `Nothing was sent: this push re-announces KPI ${h.key} (${h.goalId ? `goal ${h.goalId.slice(0, 8)}, ` : ''}of record ${figure}, ${h.met ? 'bar MET' : 'bar not met'}) — the same state you last pushed at ${h.priorAt.slice(11, 16)}Z (${kpiValueText({ value: h.priorValue, unit: h.unit })}), with the value inside the ${Math.round(h.threshold * 100)}% re-announcement threshold. Push this KPI again only when its of-record state CHANGES (the bar flips, or the value moves more than ${Math.round(h.threshold * 100)}%) — a different measured number within the threshold is not news.`;
}
