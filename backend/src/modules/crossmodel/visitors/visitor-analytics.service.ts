/**
 * First-party visitor analytics — the READ side + maintenance (owner 2026-10-07). Serves Account → Admin →
 * "Users & traffic" (admin-only routes in visitor.routes.ts):
 *
 *  - trafficSources: per CHANNEL and per CAMPAIGN (utm_campaign) in a date range — visitors (first seen), guest
 *    chatters, signups, activated (≥ 1 human chat message), retained D7 (active ≥ 7 days after signing up, of the
 *    signups at least 7 days old) and API cost — plus the visitor-cohort FUNNEL per channel (landed → signed up →
 *    first chat → D7 active) and the top page / landing paths.
 *  - trafficUsers: ONE server-side sorted / searched / paginated table of signed-in users AND anonymous visitors:
 *    first-touch channel + campaign, signed up, last active, chats / messages (7 d / 30 d), API cost (24 h / 7 d /
 *    30 d / all), the short ip hash and the device family.
 *  - trafficFlow: one user's (or visitor's) timeline — landing with source → pages → signup → first chat → daily
 *    chat activity → coding sessions — merged from visit_events and the authoritative DB rows (so a user who signed
 *    up before the capture shipped still has a timeline).
 *  - rollupSpendDaily / runVisitorAnalyticsMaintenanceOnce: the worker cron — rolls loop_metrics run_spend (kept
 *    30 days) into spend_daily_rollups so the per-user "all" cost outlives the loop_metrics sweep, and deletes
 *    visit_events older than VISIT_EVENTS_RETENTION_DAYS (default 400) + never-linked visitors unseen as long.
 *
 * API COST attribution (one rule everywhere — resolveSpendSql): a run_spend row whose sessionId is a chat → that
 * chat's owner (decision-gate rows on a chat included); a guest turn's `anon-<session>` → the visitor whose
 * server chat_sent event carried that spendSessionId, else the "guest" bucket; `chatless-…` → "chatless";
 * the synthetic 'decision-gate' session → "decision_gate"; anything else (a deleted chat) → "other". A visitor's
 * guest spend is re-keyed to the user it later linked to (the earliest link). "all" = the daily rollup for days
 * before the split (start of today − 28 d) + live loop_metrics from the split — never double counted.
 *
 * Every statement is positional-param raw SQL (SqlParams) — user input is never interpolated; sort columns come
 * from a whitelist. Read-only except the maintenance functions.
 */
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { CHANNEL_LABELS, PAID_CHANNELS, Channel } from './attribution';
import { visitorAnalyticsDisabled } from './visitor.service';

const DAY_MS = 86_400_000;
/** The synthetic run_spend session of decision-gate calls with no chat (platform/decision-gate-pricing.ts). */
export const DECISION_GATE_SPEND_SESSION = 'decision-gate';
/** The live/rollup split sits this many days before today's UTC midnight (loop_metrics keeps 30). */
export const SPEND_SPLIT_DAYS = 28;
/** The rollup cron rebuilds at most this many past days per firing (loop_metrics retention − 1). */
export const ROLLUP_MAX_DAYS = 29;
/** One $0 sentinel row per rolled day (a day with no spend still marks progress) — excluded from every sum. */
export const ROLLUP_SENTINEL_KIND = '_rolled';
export const VISIT_EVENTS_RETENTION_DEFAULT_DAYS = 400;
export const RETENTION_BATCH = 5_000;
export const RETENTION_MAX_BATCHES = 20;

type RawDb = {
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
  $queryRawUnsafe: <T = unknown>(sql: string, ...params: unknown[]) => Promise<T>;
};

function db(): RawDb {
  return prisma as unknown as RawDb;
}

/** Positional parameter collector — `p.add(v)` returns "$n". */
export class SqlParams {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The live / rollup boundary for "all" (UTC midnight, SPEND_SPLIT_DAYS before today). */
export function spendSplit(now: Date): Date {
  return new Date(startOfUtcDay(now).getTime() - SPEND_SPLIT_DAYS * DAY_MS);
}

function num(v: unknown): number {
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function money(v: unknown): number {
  return Math.round(num(v) * 10_000) / 10_000;
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/** A human (not machine / agent / schedule) user-role message — the live-chat-audit population rule. */
const HUMAN_MSG = `m."role" = 'user' AND COALESCE(m."metadata"->>'origin', 'user') = 'user'`;

/**
 * Every run_spend row in [from, to) resolved to its subject (kind, sid). See the header for the rule.
 * Columns: at, usd, kind, sid.
 */
export function resolveSpendSql(p: SqlParams, from: Date, to: Date): string {
  return `SELECT lm."createdAt" AS at, COALESCE(lm."value", 0)::float AS usd,
      CASE WHEN c."userId" IS NOT NULL THEN 'user'
           WHEN lm."sessionId" LIKE 'anon-%' AND ve."visitorId" IS NOT NULL THEN 'visitor'
           WHEN lm."sessionId" LIKE 'anon-%' THEN 'guest'
           WHEN lm."sessionId" LIKE 'chatless-%' THEN 'chatless'
           WHEN lm."sessionId" = '${DECISION_GATE_SPEND_SESSION}' THEN 'decision_gate'
           ELSE 'other' END AS kind,
      COALESCE(c."userId", ve."visitorId", '') AS sid
    FROM "loop_metrics" lm
    LEFT JOIN "crossmodel_chats" c ON c."id" = lm."sessionId"
    LEFT JOIN LATERAL (
      SELECT e."visitorId" FROM "visit_events" e
      WHERE lm."sessionId" LIKE 'anon-%' AND e."spendSessionId" = lm."sessionId" AND e."visitorId" IS NOT NULL
      ORDER BY e."createdAt" ASC LIMIT 1
    ) ve ON true
    WHERE lm."kind" = 'run_spend' AND lm."createdAt" >= ${p.add(from)} AND lm."createdAt" < ${p.add(to)}`;
}

/** visitor → the user it first linked to (a visitor's guest spend is re-keyed to that user). */
const VOWNER_CTE = `vowner AS (
  SELECT DISTINCT ON (l."visitorId") l."visitorId" AS vid, l."userId" AS uid
  FROM "visitor_links" l ORDER BY l."visitorId", l."linkedAt" ASC, l."userId")`;

/** Each user's FIRST-touch visitor (the earliest-seen linked visitor). */
const FT_CTE = `ft AS (
  SELECT DISTINCT ON (l."userId") l."userId" AS uid, v."channel" AS channel, v."campaign" AS campaign, v."id" AS vid
  FROM "visitor_links" l JOIN "visitors" v ON v."id" = l."visitorId"
  ORDER BY l."userId", v."firstSeen" ASC, v."id")`;

/**
 * Spend in [from, to) per (kind, sid) — live loop_metrics from max(from, split), the rollup for the days before the
 * split — with visitor spend re-keyed to its linked user. Columns: kind, sid, usd. Needs VOWNER_CTE in the WITH.
 */
function rangeCostCtes(p: SqlParams, from: Date, to: Date, now: Date): string {
  const split = spendSplit(now);
  const liveFrom = from.getTime() > split.getTime() ? from : split;
  const parts: string[] = [];
  if (liveFrom.getTime() < to.getTime()) parts.push(`SELECT kind, sid, usd FROM (${resolveSpendSql(p, liveFrom, to)}) live`);
  if (from.getTime() < split.getTime()) {
    const rollTo = to.getTime() < split.getTime() ? to : split;
    parts.push(`SELECT "subjectKind" AS kind, "subjectId" AS sid, "usd" AS usd FROM "spend_daily_rollups"
      WHERE "day" >= ${p.add(isoDay(from))}::date AND "day" < ${p.add(isoDay(rollTo))}::date AND "subjectKind" <> '${ROLLUP_SENTINEL_KIND}'`);
  }
  const union = parts.length ? parts.join(' UNION ALL ') : `SELECT NULL::text AS kind, NULL::text AS sid, 0::float AS usd WHERE false`;
  return `rc_raw AS (${union}),
  rc AS (
    SELECT CASE WHEN r.kind = 'visitor' AND vo.uid IS NOT NULL THEN 'user' ELSE r.kind END AS kind,
           CASE WHEN r.kind = 'visitor' AND vo.uid IS NOT NULL THEN vo.uid ELSE r.sid END AS sid,
           SUM(r.usd)::float AS usd
    FROM rc_raw r LEFT JOIN vowner vo ON r.kind = 'visitor' AND vo.vid = r.sid
    GROUP BY 1, 2)`;
}

// ── SOURCES ──────────────────────────────────────────────────────────────────

export interface ChannelRow {
  channel: string;
  label: string;
  paid: boolean;
  visitors: number;
  guestChatters: number;
  signups: number;
  activated: number;
  d7Eligible: number;
  retainedD7: number;
  costUsd: number;
}
export interface CampaignRow extends ChannelRow { campaign: string }
export interface FunnelRow {
  channel: string;
  label: string;
  landed: number;
  signedUp: number;
  firstChat: number;
  d7Eligible: number;
  d7Active: number;
  guestChatted: number;
}
export interface TrafficSources {
  from: string;
  to: string;
  captureEnabled: boolean;
  totals: Omit<ChannelRow, 'channel' | 'label' | 'paid'>;
  channels: ChannelRow[];
  campaigns: CampaignRow[];
  funnel: FunnelRow[];
  spendByKind: Array<{ kind: string; usd: number }>;
  topPaths: Array<{ path: string; views: number; visitors: number }>;
  topLandings: Array<{ path: string; visitors: number }>;
}

function labelOf(channel: string): string {
  return (CHANNEL_LABELS as Record<string, string>)[channel] ?? channel;
}

function emptyRow(channel: string): ChannelRow {
  return { channel, label: labelOf(channel), paid: PAID_CHANNELS.has(channel as Channel), visitors: 0, guestChatters: 0, signups: 0, activated: 0, d7Eligible: 0, retainedD7: 0, costUsd: 0 };
}

/** Parse a YYYY-MM-DD (UTC) day; null when malformed. */
export function parseDay(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** The [from, to) window of a request: `to` is inclusive as a DAY (to+1d exclusive); default the last 30 days. */
export function resolveRange(fromRaw: unknown, toRaw: unknown, now: Date): { from: Date; to: Date } {
  const today = startOfUtcDay(now);
  let to = parseDay(toRaw);
  let from = parseDay(fromRaw);
  to = to ? new Date(to.getTime() + DAY_MS) : new Date(today.getTime() + DAY_MS);
  if (!from) from = new Date(to.getTime() - 30 * DAY_MS);
  if (from.getTime() >= to.getTime()) from = new Date(to.getTime() - DAY_MS);
  // ≤ 400 days per query (the event retention) — a wider range is clamped from the start.
  if (to.getTime() - from.getTime() > 400 * DAY_MS) from = new Date(to.getTime() - 400 * DAY_MS);
  return { from, to };
}

export async function trafficSources(opts: { from: Date; to: Date; now?: Date }): Promise<TrafficSources> {
  const now = opts.now ?? new Date();
  const { from, to } = opts;
  const d = db();
  const d7 = new Date(now.getTime() - 7 * DAY_MS);

  const p1 = new SqlParams();
  const visitorsSql = `SELECT COALESCE(v."channel", 'unknown') AS channel, COALESCE(v."campaign", '') AS campaign,
      COUNT(*)::int AS visitors,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "visit_events" e WHERE e."visitorId" = v."id" AND e."userId" IS NULL AND e."type" IN ('chat_sent', 'first_chat')))::int AS guest_chatters
    FROM "visitors" v
    WHERE v."isBot" = false AND v."firstSeen" >= ${p1.add(from)} AND v."firstSeen" < ${p1.add(to)}
    GROUP BY 1, 2`;

  const p2 = new SqlParams();
  const signupsSql = `WITH ${FT_CTE},
    su AS (
      SELECT u."id", u."createdAt", COALESCE(ft.channel, 'unknown') AS channel, COALESCE(ft.campaign, '') AS campaign
      FROM "users" u LEFT JOIN ft ON ft.uid = u."id"
      WHERE u."isChild" = false AND u."deletedAt" IS NULL AND u."createdAt" >= ${p2.add(from)} AND u."createdAt" < ${p2.add(to)})
    SELECT su.channel, su.campaign, COUNT(*)::int AS signups,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "crossmodel_chats" c JOIN "crossmodel_messages" m ON m."chatId" = c."id" WHERE c."userId" = su."id" AND ${HUMAN_MSG}))::int AS activated,
      COUNT(*) FILTER (WHERE su."createdAt" <= ${p2.add(d7)})::int AS d7_eligible,
      COUNT(*) FILTER (WHERE su."createdAt" <= ${p2.add(d7)} AND (
        EXISTS (SELECT 1 FROM "crossmodel_chats" c JOIN "crossmodel_messages" m ON m."chatId" = c."id" WHERE c."userId" = su."id" AND ${HUMAN_MSG} AND m."createdAt" >= su."createdAt" + interval '7 days')
        OR EXISTS (SELECT 1 FROM "visit_events" e WHERE e."userId" = su."id" AND e."createdAt" >= su."createdAt" + interval '7 days')))::int AS retained
    FROM su GROUP BY 1, 2`;

  const p3 = new SqlParams();
  const costSql = `WITH ${VOWNER_CTE}, ${FT_CTE}, ${rangeCostCtes(p3, from, to, now)}
    SELECT CASE WHEN rc.kind = 'user' AND u."id" IS NOT NULL AND u."isChild" = false THEN COALESCE(ft.channel, 'unknown')
                WHEN rc.kind = 'visitor' THEN COALESCE(v."channel", 'unknown')
                ELSE 'unattributed' END AS channel,
           CASE WHEN rc.kind = 'user' AND u."id" IS NOT NULL AND u."isChild" = false THEN COALESCE(ft.campaign, '')
                WHEN rc.kind = 'visitor' THEN COALESCE(v."campaign", '')
                ELSE '' END AS campaign,
           CASE WHEN rc.kind = 'user' AND (u."id" IS NULL OR u."isChild") THEN 'other' ELSE rc.kind END AS kind,
           SUM(rc.usd)::float AS usd
    FROM rc
    LEFT JOIN "users" u ON rc.kind = 'user' AND u."id" = rc.sid
    LEFT JOIN ft ON rc.kind = 'user' AND ft.uid = rc.sid
    LEFT JOIN "visitors" v ON rc.kind = 'visitor' AND v."id" = rc.sid
    GROUP BY 1, 2, 3`;

  const p4 = new SqlParams();
  const funnelSql = `SELECT COALESCE(v."channel", 'unknown') AS channel,
      COUNT(*)::int AS landed,
      COUNT(*) FILTER (WHERE x.uid IS NOT NULL)::int AS signed_up,
      COUNT(*) FILTER (WHERE x.chatted)::int AS first_chat,
      COUNT(*) FILTER (WHERE x.d7_eligible)::int AS d7_eligible,
      COUNT(*) FILTER (WHERE x.d7)::int AS d7_active,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "visit_events" e WHERE e."visitorId" = v."id" AND e."userId" IS NULL AND e."type" IN ('chat_sent', 'first_chat')))::int AS guest_chatted
    FROM "visitors" v
    LEFT JOIN LATERAL (
      SELECT u."id" AS uid,
        EXISTS (SELECT 1 FROM "crossmodel_chats" c JOIN "crossmodel_messages" m ON m."chatId" = c."id" WHERE c."userId" = u."id" AND ${HUMAN_MSG}) AS chatted,
        (u."createdAt" <= ${p4.add(d7)}) AS d7_eligible,
        (u."createdAt" <= ${p4.add(d7)} AND (
          EXISTS (SELECT 1 FROM "crossmodel_chats" c JOIN "crossmodel_messages" m ON m."chatId" = c."id" WHERE c."userId" = u."id" AND ${HUMAN_MSG} AND m."createdAt" >= u."createdAt" + interval '7 days')
          OR EXISTS (SELECT 1 FROM "visit_events" e WHERE e."userId" = u."id" AND e."createdAt" >= u."createdAt" + interval '7 days'))) AS d7
      FROM "visitor_links" l JOIN "users" u ON u."id" = l."userId"
      WHERE l."visitorId" = v."id" AND u."isChild" = false AND u."deletedAt" IS NULL AND u."createdAt" >= v."firstSeen" - interval '1 day'
      ORDER BY u."createdAt" ASC LIMIT 1
    ) x ON true
    WHERE v."isBot" = false AND v."firstSeen" >= ${p4.add(from)} AND v."firstSeen" < ${p4.add(to)}
    GROUP BY 1`;

  const p5 = new SqlParams();
  const pathsSql = `SELECT COALESCE(e."path", '/') AS path, COUNT(*)::int AS views, COUNT(DISTINCT e."visitorId")::int AS visitors
    FROM "visit_events" e JOIN "visitors" v ON v."id" = e."visitorId"
    WHERE e."type" = 'page_view' AND v."isBot" = false AND e."createdAt" >= ${p5.add(from)} AND e."createdAt" < ${p5.add(to)}
    GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 25`;

  const p6 = new SqlParams();
  const landingsSql = `SELECT COALESCE(v."firstTouch"->>'landing', '/') AS path, COUNT(*)::int AS visitors
    FROM "visitors" v
    WHERE v."isBot" = false AND v."firstSeen" >= ${p6.add(from)} AND v."firstSeen" < ${p6.add(to)}
    GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 15`;

  const [vRows, sRows, cRows, fRows, pathRows, landRows] = await Promise.all([
    d.$queryRawUnsafe<any[]>(visitorsSql, ...p1.values),
    d.$queryRawUnsafe<any[]>(signupsSql, ...p2.values),
    d.$queryRawUnsafe<any[]>(costSql, ...p3.values),
    d.$queryRawUnsafe<any[]>(funnelSql, ...p4.values),
    d.$queryRawUnsafe<any[]>(pathsSql, ...p5.values),
    d.$queryRawUnsafe<any[]>(landingsSql, ...p6.values),
  ]);

  const byChannel = new Map<string, ChannelRow>();
  const byCampaign = new Map<string, CampaignRow>();
  const ch = (c: string) => { let r = byChannel.get(c); if (!r) { r = emptyRow(c); byChannel.set(c, r); } return r; };
  const cp = (c: string, k: string) => {
    const key = `${c}\u0000${k}`;
    let r = byCampaign.get(key);
    if (!r) { r = { ...emptyRow(c), campaign: k }; byCampaign.set(key, r); }
    return r;
  };
  for (const r of vRows ?? []) {
    const c = String(r.channel || 'unknown'); const k = String(r.campaign || '');
    for (const row of [ch(c), cp(c, k)]) { row.visitors += num(r.visitors); row.guestChatters += num(r.guest_chatters); }
  }
  for (const r of sRows ?? []) {
    const c = String(r.channel || 'unknown'); const k = String(r.campaign || '');
    for (const row of [ch(c), cp(c, k)]) {
      row.signups += num(r.signups); row.activated += num(r.activated); row.d7Eligible += num(r.d7_eligible); row.retainedD7 += num(r.retained);
    }
  }
  const spendByKind = new Map<string, number>();
  for (const r of cRows ?? []) {
    const c = String(r.channel || 'unattributed'); const k = String(r.campaign || '');
    const usd = num(r.usd);
    for (const row of [ch(c), cp(c, k)]) row.costUsd += usd;
    spendByKind.set(String(r.kind || 'other'), (spendByKind.get(String(r.kind || 'other')) ?? 0) + usd);
  }
  const channels = [...byChannel.values()].map((r) => ({ ...r, costUsd: money(r.costUsd) }))
    .sort((a, b) => Number(b.paid) - Number(a.paid) || b.visitors - a.visitors || b.signups - a.signups || b.costUsd - a.costUsd || a.channel.localeCompare(b.channel));
  const campaigns = [...byCampaign.values()].filter((r) => r.campaign).map((r) => ({ ...r, costUsd: money(r.costUsd) }))
    .sort((a, b) => b.visitors - a.visitors || b.signups - a.signups || b.costUsd - a.costUsd || a.campaign.localeCompare(b.campaign));
  const totals = channels.reduce((t, r) => ({
    visitors: t.visitors + r.visitors, guestChatters: t.guestChatters + r.guestChatters, signups: t.signups + r.signups,
    activated: t.activated + r.activated, d7Eligible: t.d7Eligible + r.d7Eligible, retainedD7: t.retainedD7 + r.retainedD7, costUsd: money(t.costUsd + r.costUsd),
  }), { visitors: 0, guestChatters: 0, signups: 0, activated: 0, d7Eligible: 0, retainedD7: 0, costUsd: 0 });
  const funnel: FunnelRow[] = (fRows ?? []).map((r) => ({
    channel: String(r.channel || 'unknown'), label: labelOf(String(r.channel || 'unknown')),
    landed: num(r.landed), signedUp: num(r.signed_up), firstChat: num(r.first_chat), d7Eligible: num(r.d7_eligible), d7Active: num(r.d7_active), guestChatted: num(r.guest_chatted),
  })).sort((a, b) => b.landed - a.landed || a.channel.localeCompare(b.channel));

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    captureEnabled: !visitorAnalyticsDisabled(),
    totals,
    channels,
    campaigns: campaigns.slice(0, 100),
    funnel,
    spendByKind: [...spendByKind.entries()].map(([kind, usd]) => ({ kind, usd: money(usd) })).sort((a, b) => b.usd - a.usd),
    topPaths: (pathRows ?? []).map((r) => ({ path: String(r.path), views: num(r.views), visitors: num(r.visitors) })),
    topLandings: (landRows ?? []).map((r) => ({ path: String(r.path), visitors: num(r.visitors) })),
  };
}

// ── USERS TABLE ──────────────────────────────────────────────────────────────

export const USER_SORTS: Record<string, string> = {
  label: 'label',
  channel: 'channel',
  signedUp: 'signed_up',
  lastActive: 'last_active',
  chats7: 'chats7',
  chats30: 'chats30',
  msgs7: 'msgs7',
  msgs30: 'msgs30',
  cost1: 'cost1',
  cost7: 'cost7',
  cost30: 'cost30',
  costAll: 'cost_all',
};

export interface TrafficUserRow {
  kind: 'user' | 'visitor';
  id: string;
  label: string;
  channel: string;
  channelLabel: string;
  campaign: string | null;
  signedUpAt: string | null;
  lastActiveAt: string | null;
  chats7: number;
  chats30: number;
  msgs7: number;
  msgs30: number;
  cost1: number;
  cost7: number;
  cost30: number;
  costAll: number;
  ipHash: string | null;
  device: string | null;
}
export interface TrafficUsersPage {
  rows: TrafficUserRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: string;
  dir: 'asc' | 'desc';
}

export interface TrafficUsersQuery {
  q?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
  kind?: string;
  channel?: string;
  now?: Date;
}

/** Escape LIKE wildcards in a search term (ESCAPE '\'). */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function trafficUsers(query: TrafficUsersQuery): Promise<TrafficUsersPage> {
  const now = query.now ?? new Date();
  const sortKey = query.sort && USER_SORTS[query.sort] ? query.sort : 'lastActive';
  const dir: 'asc' | 'desc' = query.dir === 'asc' ? 'asc' : 'desc';
  const pageSize = Math.min(Math.max(Math.floor(Number(query.pageSize) || 25), 1), 100);
  const page = Math.max(Math.floor(Number(query.page) || 1), 1);
  const kind = query.kind === 'users' ? 'user' : query.kind === 'visitors' ? 'visitor' : 'all';
  const channel = typeof query.channel === 'string' ? query.channel.trim().slice(0, 40) : '';
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 120) : '';
  const d1 = new Date(now.getTime() - DAY_MS);
  const d7 = new Date(now.getTime() - 7 * DAY_MS);
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const split = spendSplit(now);

  const p = new SqlParams();
  const pD7 = p.add(d7);
  const pD30 = p.add(d30);
  const pD1 = p.add(d1);
  const pSplit = p.add(split);
  const liveSql = resolveSpendSql(p, d30, new Date(now.getTime() + 60_000));
  const pSplitDay = p.add(isoDay(split));
  const pKind = p.add(kind);
  const pChannel = p.add(channel);
  const pQ = p.add(q ? `%${likeEscape(q)}%` : '');
  const pQPrefix = p.add(q ? `${likeEscape(q.toLowerCase())}%` : '');
  const pLimit = p.add(pageSize);
  const pOffset = p.add((page - 1) * pageSize);
  const orderCol = USER_SORTS[sortKey];

  const sql = `WITH ${VOWNER_CTE}, ${FT_CTE},
    lv AS (
      SELECT DISTINCT ON (l."userId") l."userId" AS uid, v."ipHash" AS ip_hash, v."uaFamily" AS device
      FROM "visitor_links" l JOIN "visitors" v ON v."id" = l."visitorId"
      ORDER BY l."userId", v."lastSeen" DESC, v."id"),
    msg AS (
      SELECT c."userId" AS uid,
        COUNT(*) FILTER (WHERE m."createdAt" >= ${pD7})::int AS msgs7,
        COUNT(*)::int AS msgs30,
        COUNT(DISTINCT m."chatId") FILTER (WHERE m."createdAt" >= ${pD7})::int AS chats7,
        COUNT(DISTINCT m."chatId")::int AS chats30,
        MAX(m."createdAt") AS last_msg
      FROM "crossmodel_messages" m JOIN "crossmodel_chats" c ON c."id" = m."chatId"
      WHERE ${HUMAN_MSG} AND m."createdAt" >= ${pD30}
      GROUP BY 1),
    uev AS (SELECT e."userId" AS uid, MAX(e."createdAt") AS at FROM "visit_events" e WHERE e."userId" IS NOT NULL GROUP BY 1),
    lc AS (
      SELECT c."userId" AS uid, MAX(c."updatedAt") AS at FROM "crossmodel_chats" c
      WHERE c."isSupervisor" = false AND c."isProjectSupervisor" = false AND c."parentChatId" IS NULL GROUP BY 1),
    vev AS (
      SELECT e."visitorId" AS vid,
        COUNT(*) FILTER (WHERE e."type" = 'chat_sent' AND e."createdAt" >= ${pD7})::int AS msgs7,
        COUNT(*) FILTER (WHERE e."type" = 'chat_sent')::int AS msgs30,
        COUNT(DISTINCT e."spendSessionId") FILTER (WHERE e."type" = 'chat_sent' AND e."createdAt" >= ${pD7})::int AS chats7,
        COUNT(DISTINCT e."spendSessionId") FILTER (WHERE e."type" = 'chat_sent')::int AS chats30
      FROM "visit_events" e WHERE e."visitorId" IS NOT NULL AND e."userId" IS NULL AND e."createdAt" >= ${pD30}
      GROUP BY 1),
    cost_raw AS (
      SELECT kind, sid,
        CASE WHEN at >= ${pD1} THEN usd ELSE 0 END AS c1,
        CASE WHEN at >= ${pD7} THEN usd ELSE 0 END AS c7,
        usd AS c30,
        CASE WHEN at >= ${pSplit} THEN usd ELSE 0 END AS c_all
      FROM (${liveSql}) live WHERE kind IN ('user', 'visitor')
      UNION ALL
      SELECT "subjectKind", "subjectId", 0, 0, 0, "usd" FROM "spend_daily_rollups"
      WHERE "day" < ${pSplitDay}::date AND "subjectKind" IN ('user', 'visitor')),
    cost AS (
      SELECT CASE WHEN r.kind = 'visitor' AND vo.uid IS NOT NULL THEN 'user' ELSE r.kind END AS kind,
             CASE WHEN r.kind = 'visitor' AND vo.uid IS NOT NULL THEN vo.uid ELSE r.sid END AS sid,
             SUM(r.c1)::float AS c1, SUM(r.c7)::float AS c7, SUM(r.c30)::float AS c30, SUM(r.c_all)::float AS c_all
      FROM cost_raw r LEFT JOIN vowner vo ON r.kind = 'visitor' AND vo.vid = r.sid
      GROUP BY 1, 2),
    subjects AS (
      SELECT 'user'::text AS kind, u."id" AS sid, u."email" AS label, COALESCE(ft.channel, 'unknown') AS channel, ft.campaign AS campaign,
        u."createdAt" AS signed_up,
        GREATEST(msg.last_msg, uev.at, lc.at, u."createdAt") AS last_active,
        COALESCE(msg.chats7, 0) AS chats7, COALESCE(msg.chats30, 0) AS chats30, COALESCE(msg.msgs7, 0) AS msgs7, COALESCE(msg.msgs30, 0) AS msgs30,
        lv.ip_hash, lv.device
      FROM "users" u
      LEFT JOIN ft ON ft.uid = u."id" LEFT JOIN lv ON lv.uid = u."id" LEFT JOIN msg ON msg.uid = u."id"
      LEFT JOIN uev ON uev.uid = u."id" LEFT JOIN lc ON lc.uid = u."id"
      WHERE u."isChild" = false AND u."deletedAt" IS NULL
      UNION ALL
      SELECT 'visitor'::text, v."id", 'visitor ' || LEFT(COALESCE(v."ipHash", REPLACE(v."id", '-', '')), 8), COALESCE(v."channel", 'unknown'), v."campaign",
        NULL::timestamp, v."lastSeen",
        COALESCE(vev.chats7, 0), COALESCE(vev.chats30, 0), COALESCE(vev.msgs7, 0), COALESCE(vev.msgs30, 0),
        v."ipHash", v."uaFamily"
      FROM "visitors" v LEFT JOIN vev ON vev.vid = v."id"
      WHERE v."isBot" = false AND NOT EXISTS (SELECT 1 FROM "visitor_links" l WHERE l."visitorId" = v."id")),
    rows AS (
      SELECT s.*, COALESCE(c.c1, 0)::float AS cost1, COALESCE(c.c7, 0)::float AS cost7, COALESCE(c.c30, 0)::float AS cost30, COALESCE(c.c_all, 0)::float AS cost_all
      FROM subjects s LEFT JOIN cost c ON c.kind = s.kind AND c.sid = s.sid)
    SELECT rows.*, COUNT(*) OVER()::int AS total_count FROM rows
    WHERE (${pKind} = 'all' OR rows.kind = ${pKind})
      AND (${pChannel} = '' OR rows.channel = ${pChannel})
      AND (${pQ} = '' OR rows.label ILIKE ${pQ} ESCAPE '\\' OR rows.sid ILIKE ${pQPrefix} ESCAPE '\\'
           OR COALESCE(rows.ip_hash, '') ILIKE ${pQPrefix} ESCAPE '\\' OR COALESCE(rows.campaign, '') ILIKE ${pQ} ESCAPE '\\' OR rows.channel ILIKE ${pQ} ESCAPE '\\')
    ORDER BY ${orderCol} ${dir.toUpperCase()} NULLS LAST, rows.sid ASC
    LIMIT ${pLimit} OFFSET ${pOffset}`;

  const raw = await db().$queryRawUnsafe<any[]>(sql, ...p.values);
  const list = Array.isArray(raw) ? raw : [];
  const rows: TrafficUserRow[] = list.map((r) => ({
    kind: r.kind === 'visitor' ? 'visitor' : 'user',
    id: String(r.sid),
    label: String(r.label ?? ''),
    channel: String(r.channel || 'unknown'),
    channelLabel: labelOf(String(r.channel || 'unknown')),
    campaign: r.campaign ? String(r.campaign) : null,
    signedUpAt: iso(r.signed_up),
    lastActiveAt: iso(r.last_active),
    chats7: num(r.chats7), chats30: num(r.chats30), msgs7: num(r.msgs7), msgs30: num(r.msgs30),
    cost1: money(r.cost1), cost7: money(r.cost7), cost30: money(r.cost30), costAll: money(r.cost_all),
    ipHash: r.ip_hash ? String(r.ip_hash).slice(0, 8) : null,
    device: r.device ? String(r.device) : null,
  }));
  return { rows, total: list.length ? num(list[0].total_count) : 0, page, pageSize, sort: sortKey, dir };
}

// ── FLOW (one subject's timeline) ────────────────────────────────────────────

export interface FlowItem {
  at: string;
  kind: 'landing' | 'event' | 'signup' | 'first_chat' | 'chat_day' | 'coding_session';
  type: string;
  path?: string | null;
  source?: 'client' | 'server' | 'db';
  detail?: Record<string, unknown> | null;
}
export interface FlowVisitor {
  id: string;
  ipHash: string | null;
  device: string | null;
  channel: string;
  channelLabel: string;
  campaign: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  firstTouch: Record<string, unknown> | null;
  lastTouch: Record<string, unknown> | null;
  isBot: boolean;
}
export interface TrafficFlow {
  subject: { kind: 'user' | 'visitor'; id: string; label: string; signedUpAt: string | null; linkedUserIds?: string[] };
  attribution: { channel: string; channelLabel: string; campaign: string | null; firstTouch: Record<string, unknown> | null } | null;
  visitors: FlowVisitor[];
  cost: { cost1: number; cost7: number; cost30: number; costAll: number };
  items: FlowItem[];
  truncated: boolean;
}

export const FLOW_EVENT_LIMIT = 500;

function flowVisitor(r: any): FlowVisitor {
  const channel = String(r.channel || 'unknown');
  return {
    id: String(r.id),
    ipHash: r.ipHash ? String(r.ipHash).slice(0, 8) : null,
    device: r.uaFamily ? String(r.uaFamily) : null,
    channel,
    channelLabel: labelOf(channel),
    campaign: r.campaign ? String(r.campaign) : null,
    firstSeen: iso(r.firstSeen),
    lastSeen: iso(r.lastSeen),
    firstTouch: redactTouch(r.firstTouch && typeof r.firstTouch === 'object' ? r.firstTouch : (typeof r.firstTouch === 'string' ? safeJson(r.firstTouch) : null)),
    lastTouch: redactTouch(r.lastTouch && typeof r.lastTouch === 'object' ? r.lastTouch : (typeof r.lastTouch === 'string' ? safeJson(r.lastTouch) : null)),
    isBot: r.isBot === true,
  };
}

const CLICK_ID_FIELDS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'ttclid', 'li_fat_id'];

/** A stored touch for the admin view: ad-network click ids shown as PRESENCE only (true), never the id itself. */
export function redactTouch(t: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!t) return null;
  const out: Record<string, unknown> = { ...t };
  for (const k of CLICK_ID_FIELDS) if (out[k]) out[k] = true;
  return out;
}

function safeJson(s: string): Record<string, unknown> | null {
  try { const v = JSON.parse(s); return v && typeof v === 'object' ? v : null; } catch { return null; }
}

/** The cost of ONE subject (user incl. its linked visitors' guest spend, or an unlinked visitor). */
async function subjectCost(kind: 'user' | 'visitor', id: string, now: Date): Promise<TrafficFlow['cost']> {
  const p = new SqlParams();
  const d1 = p.add(new Date(now.getTime() - DAY_MS));
  const d7 = p.add(new Date(now.getTime() - 7 * DAY_MS));
  const split = spendSplit(now);
  const pSplit = p.add(split);
  const live = resolveSpendSql(p, new Date(now.getTime() - 30 * DAY_MS), new Date(now.getTime() + 60_000));
  const pSplitDay = p.add(isoDay(split));
  const pKind = p.add(kind);
  const pId = p.add(id);
  const sql = `WITH ${VOWNER_CTE},
    raw AS (
      SELECT kind, sid, CASE WHEN at >= ${d1} THEN usd ELSE 0 END AS c1, CASE WHEN at >= ${d7} THEN usd ELSE 0 END AS c7, usd AS c30,
             CASE WHEN at >= ${pSplit} THEN usd ELSE 0 END AS c_all
      FROM (${live}) live WHERE kind IN ('user', 'visitor')
      UNION ALL
      SELECT "subjectKind", "subjectId", 0, 0, 0, "usd" FROM "spend_daily_rollups" WHERE "day" < ${pSplitDay}::date AND "subjectKind" IN ('user', 'visitor')),
    keyed AS (
      SELECT CASE WHEN r.kind = 'visitor' AND vo.uid IS NOT NULL THEN 'user' ELSE r.kind END AS kind,
             CASE WHEN r.kind = 'visitor' AND vo.uid IS NOT NULL THEN vo.uid ELSE r.sid END AS sid, r.c1, r.c7, r.c30, r.c_all
      FROM raw r LEFT JOIN vowner vo ON r.kind = 'visitor' AND vo.vid = r.sid)
    SELECT COALESCE(SUM(c1), 0)::float AS c1, COALESCE(SUM(c7), 0)::float AS c7, COALESCE(SUM(c30), 0)::float AS c30, COALESCE(SUM(c_all), 0)::float AS c_all
    FROM keyed WHERE kind = ${pKind} AND sid = ${pId}`;
  const rows = await db().$queryRawUnsafe<any[]>(sql, ...p.values);
  const r = Array.isArray(rows) && rows[0] ? rows[0] : {};
  return { cost1: money(r.c1), cost7: money(r.c7), cost30: money(r.c30), costAll: money(r.c_all) };
}

function landingItem(v: FlowVisitor): FlowItem | null {
  if (!v.firstSeen) return null;
  const t = v.firstTouch ?? {};
  const detail: Record<string, unknown> = { channel: v.channel, channelLabel: v.channelLabel, visitorId: v.id };
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer']) if ((t as any)[k]) detail[k] = (t as any)[k];
  for (const k of CLICK_ID_FIELDS) if ((t as any)[k]) detail[k] = true; // presence only — never the id
  return { at: v.firstSeen, kind: 'landing', type: 'landing', path: typeof (t as any).landing === 'string' ? (t as any).landing : null, source: 'client', detail };
}

/**
 * One subject's timeline. `null` when the subject does not exist — or is a Digby Kids child (never shown).
 * Events are the newest FLOW_EVENT_LIMIT (truncated flag), returned oldest-first.
 */
export async function trafficFlow(opts: { userId?: string; visitorId?: string; now?: Date }): Promise<TrafficFlow | null> {
  const now = opts.now ?? new Date();
  const d = db();
  if (opts.userId) {
    const users = await d.$queryRawUnsafe<any[]>('SELECT "id", "email", "createdAt", "isChild" FROM "users" WHERE "id" = $1 AND "deletedAt" IS NULL LIMIT 1', opts.userId);
    const u = Array.isArray(users) ? users[0] : null;
    if (!u || u.isChild === true) return null;
    const [vRows, evRows, firstMsg, dayRows, codingRows, cost] = await Promise.all([
      d.$queryRawUnsafe<any[]>(`SELECT v.* FROM "visitor_links" l JOIN "visitors" v ON v."id" = l."visitorId" WHERE l."userId" = $1 ORDER BY v."firstSeen" ASC LIMIT 20`, u.id),
      d.$queryRawUnsafe<any[]>(`SELECT e."type", e."path", e."props", e."source", e."createdAt", e."visitorId" FROM "visit_events" e
        WHERE e."userId" = $1 OR e."visitorId" IN (SELECT l."visitorId" FROM "visitor_links" l WHERE l."userId" = $1)
        ORDER BY e."createdAt" DESC LIMIT ${FLOW_EVENT_LIMIT + 1}`, u.id),
      d.$queryRawUnsafe<any[]>(`SELECT MIN(m."createdAt") AS at FROM "crossmodel_messages" m JOIN "crossmodel_chats" c ON c."id" = m."chatId" WHERE c."userId" = $1 AND ${HUMAN_MSG}`, u.id),
      d.$queryRawUnsafe<any[]>(`SELECT date_trunc('day', m."createdAt") AS day, COUNT(*)::int AS msgs, COUNT(DISTINCT m."chatId")::int AS chats
        FROM "crossmodel_messages" m JOIN "crossmodel_chats" c ON c."id" = m."chatId"
        WHERE c."userId" = $1 AND ${HUMAN_MSG} AND m."createdAt" >= $2 GROUP BY 1 ORDER BY 1`, u.id, new Date(now.getTime() - 90 * DAY_MS)),
      d.$queryRawUnsafe<any[]>(`SELECT s."id", s."createdAt" FROM "coding_sessions" s JOIN "crossmodel_chats" c ON c."id" = s."id"
        LEFT JOIN "crossmodel_chats" p ON p."id" = c."parentChatId"
        WHERE s."userId" = $1 AND c."isSupervisor" = false AND c."isProjectSupervisor" = false
          AND NOT COALESCE(p."isSupervisor" OR p."isProjectSupervisor", false)
        ORDER BY s."createdAt" DESC LIMIT 50`, u.id),
      subjectCost('user', u.id, now),
    ]);
    const visitors = (vRows ?? []).map(flowVisitor);
    const first = visitors[0] ?? null;
    const items: FlowItem[] = [];
    for (const v of visitors) { const li = landingItem(v); if (li) items.push(li); }
    const events = (evRows ?? []).slice(0, FLOW_EVENT_LIMIT);
    for (const e of events) items.push({ at: iso(e.createdAt) ?? now.toISOString(), kind: 'event', type: String(e.type), path: e.path ?? null, source: e.source === 'server' ? 'server' : 'client', detail: e.props && typeof e.props === 'object' ? e.props : null });
    items.push({ at: iso(u.createdAt)!, kind: 'signup', type: 'account_created', source: 'db' });
    const fm = Array.isArray(firstMsg) && firstMsg[0] ? iso(firstMsg[0].at) : null;
    if (fm) items.push({ at: fm, kind: 'first_chat', type: 'first_message', source: 'db' });
    for (const r of dayRows ?? []) items.push({ at: iso(r.day)!, kind: 'chat_day', type: 'chat_activity', source: 'db', detail: { messages: num(r.msgs), chats: num(r.chats) } });
    for (const r of codingRows ?? []) items.push({ at: iso(r.createdAt)!, kind: 'coding_session', type: 'coding_session_started', source: 'db', detail: { sessionId: String(r.id) } });
    items.sort((a, b) => a.at.localeCompare(b.at));
    return {
      subject: { kind: 'user', id: u.id, label: String(u.email), signedUpAt: iso(u.createdAt) },
      attribution: first ? { channel: first.channel, channelLabel: first.channelLabel, campaign: first.campaign, firstTouch: first.firstTouch } : null,
      visitors,
      cost,
      items,
      truncated: (evRows ?? []).length > FLOW_EVENT_LIMIT,
    };
  }
  if (opts.visitorId) {
    const vr = await d.$queryRawUnsafe<any[]>('SELECT v.* FROM "visitors" v WHERE v."id" = $1 LIMIT 1', opts.visitorId);
    if (!Array.isArray(vr) || !vr[0]) return null;
    const v = flowVisitor(vr[0]);
    const [links, evRows, cost] = await Promise.all([
      d.$queryRawUnsafe<any[]>('SELECT l."userId" FROM "visitor_links" l JOIN "users" u ON u."id" = l."userId" WHERE l."visitorId" = $1 AND u."isChild" = false ORDER BY l."linkedAt" ASC', v.id),
      d.$queryRawUnsafe<any[]>(`SELECT e."type", e."path", e."props", e."source", e."createdAt" FROM "visit_events" e WHERE e."visitorId" = $1 ORDER BY e."createdAt" DESC LIMIT ${FLOW_EVENT_LIMIT + 1}`, v.id),
      subjectCost('visitor', v.id, now),
    ]);
    const items: FlowItem[] = [];
    const li = landingItem(v);
    if (li) items.push(li);
    for (const e of (evRows ?? []).slice(0, FLOW_EVENT_LIMIT)) items.push({ at: iso(e.createdAt) ?? now.toISOString(), kind: 'event', type: String(e.type), path: e.path ?? null, source: e.source === 'server' ? 'server' : 'client', detail: e.props && typeof e.props === 'object' ? e.props : null });
    items.sort((a, b) => a.at.localeCompare(b.at));
    return {
      subject: { kind: 'visitor', id: v.id, label: `visitor ${v.ipHash ?? v.id.replace(/-/g, '').slice(0, 8)}`, signedUpAt: null, linkedUserIds: (links ?? []).map((l) => String(l.userId)) },
      attribution: { channel: v.channel, channelLabel: v.channelLabel, campaign: v.campaign, firstTouch: v.firstTouch },
      visitors: [v],
      cost,
      items,
      truncated: (evRows ?? []).length > FLOW_EVENT_LIMIT,
    };
  }
  return null;
}

// ── MAINTENANCE (worker cron) ────────────────────────────────────────────────

export function visitEventsRetentionDays(): number {
  const n = Number(process.env.VISIT_EVENTS_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 30 ? Math.floor(n) : VISIT_EVENTS_RETENTION_DEFAULT_DAYS;
}

export function spendRollupDisabled(): boolean {
  return process.env.SPEND_ROLLUP_DISABLED === '1';
}

/**
 * Rebuild spend_daily_rollups for the recent complete UTC days still inside loop_metrics: from the day after the
 * newest rolled day − 1 (so yesterday's late rows are re-counted) back at most ROLLUP_MAX_DAYS; an empty table
 * backfills all ROLLUP_MAX_DAYS. Idempotent per day (upsert + drop that day's rows the rebuild did not touch).
 */
export async function rollupSpendDaily(now: Date = new Date()): Promise<{ days: number; rows: number }> {
  const d = db();
  const today = startOfUtcDay(now);
  const maxRows = await d.$queryRawUnsafe<Array<{ d: string | null }>>(`SELECT MAX("day")::text AS d FROM "spend_daily_rollups" WHERE "subjectKind" = '${ROLLUP_SENTINEL_KIND}'`);
  const maxDay = Array.isArray(maxRows) && maxRows[0]?.d ? parseDay(String(maxRows[0].d).slice(0, 10)) : null;
  let span = ROLLUP_MAX_DAYS;
  if (maxDay) span = Math.min(ROLLUP_MAX_DAYS, Math.max(2, Math.round((today.getTime() - maxDay.getTime()) / DAY_MS) + 1));
  let rows = 0;
  for (let i = span; i >= 1; i--) {
    const dayStart = new Date(today.getTime() - i * DAY_MS);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const stamp = new Date();
    const p = new SqlParams();
    const pDay = p.add(isoDay(dayStart));
    const live = resolveSpendSql(p, dayStart, dayEnd);
    const pStamp = p.add(stamp);
    const n = await d.$executeRawUnsafe(
      `INSERT INTO "spend_daily_rollups" ("day", "subjectKind", "subjectId", "usd", "runs", "updatedAt")
       SELECT ${pDay}::date, kind, sid, SUM(usd)::float, COUNT(*)::int, ${pStamp} FROM (${live}) live GROUP BY kind, sid
       ON CONFLICT ("day", "subjectKind", "subjectId") DO UPDATE SET "usd" = EXCLUDED."usd", "runs" = EXCLUDED."runs", "updatedAt" = EXCLUDED."updatedAt"`,
      ...p.values,
    );
    rows += num(n);
    await d.$executeRawUnsafe(
      `INSERT INTO "spend_daily_rollups" ("day", "subjectKind", "subjectId", "usd", "runs", "updatedAt") VALUES ($1::date, '${ROLLUP_SENTINEL_KIND}', '', 0, 0, $2)
       ON CONFLICT ("day", "subjectKind", "subjectId") DO UPDATE SET "updatedAt" = EXCLUDED."updatedAt"`,
      isoDay(dayStart), stamp,
    );
    await d.$executeRawUnsafe('DELETE FROM "spend_daily_rollups" WHERE "day" = $1::date AND "updatedAt" < $2', isoDay(dayStart), stamp);
  }
  return { days: span, rows };
}

/** Delete visit_events older than the retention (batched) + never-linked visitors unseen as long. */
export async function sweepVisitEvents(now: Date = new Date()): Promise<{ events: number; visitors: number }> {
  const d = db();
  const cutoff = new Date(now.getTime() - visitEventsRetentionDays() * DAY_MS);
  let events = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
    const n = num(await d.$executeRawUnsafe(
      `DELETE FROM "visit_events" WHERE "id" IN (SELECT "id" FROM "visit_events" WHERE "createdAt" < $1 ORDER BY "createdAt" ASC LIMIT ${RETENTION_BATCH})`,
      cutoff,
    ));
    events += n;
    if (n < RETENTION_BATCH) break;
  }
  const visitors = num(await d.$executeRawUnsafe(
    `DELETE FROM "visitors" v WHERE v."lastSeen" < $1 AND NOT EXISTS (SELECT 1 FROM "visitor_links" l WHERE l."visitorId" = v."id")`,
    cutoff,
  ));
  return { events, visitors };
}

/** The worker cron body: retention always (privacy), the spend rollup unless SPEND_ROLLUP_DISABLED=1. Never throws. */
export async function runVisitorAnalyticsMaintenanceOnce(now: Date = new Date()): Promise<string> {
  const parts: string[] = [];
  try {
    const s = await sweepVisitEvents(now);
    parts.push(`retention: -${s.events} events, -${s.visitors} visitors`);
  } catch (err: any) {
    parts.push(`retention failed: ${String(err?.message ?? err).slice(0, 60)}`);
  }
  if (spendRollupDisabled()) {
    parts.push('rollup disabled');
  } else {
    try {
      const r = await rollupSpendDaily(now);
      parts.push(`rollup: ${r.days} day(s), ${r.rows} row(s)`);
    } catch (err: any) {
      parts.push(`rollup failed: ${String(err?.message ?? err).slice(0, 60)}`);
    }
  }
  const summary = parts.join('; ').slice(0, 200);
  logger.info(`visitor-analytics: ${summary}`);
  return summary;
}
