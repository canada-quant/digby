/**
 * Project-wide and fleet-wide cost + token usage for the supervisor side panels (owner 2026-10-08: "project
 * supervisor chats on the sidebar dont show the projects overview and schedules and everything goals sessions
 * working on todos cost and token usage project wide etc … a special sidebar for project supervisors … and the
 * fleet supervisor").
 *
 * Source: the same loop_metrics rows the API-cost page reads — `run_spend` (USD) and `run_tokens_in` /
 * `run_tokens_out` — keyed by chat id (`sessionId`), joined to the chats of the project (or of the account) the
 * caller may read. Rows whose sessionId is not a chat (the synthetic decision-gate session) do not join and are not
 * counted. Windows are UTC: today (since midnight), 7 days, 30 days; plus a 14-day daily series and the top chats.
 *   GET /api/crossmodel/projects/:id/usage  → ProjectUsage   (any project member — the owner's rows, like /sessions)
 *   GET /api/crossmodel/fleet/usage         → FleetUsage     (the caller's own account, grouped per project)
 * Kill switch SUPERVISOR_USAGE_DISABLED=1 → 404 (the panels hide the usage block).
 */
import prisma from '../../../config/database';

export const USAGE_KINDS = ['run_spend', 'run_tokens_in', 'run_tokens_out'] as const;
const DAY_MS = 86_400_000;
export const USAGE_DAILY_DAYS = 14;

export function supervisorUsageDisabled(): boolean {
  return process.env.SUPERVISOR_USAGE_DISABLED === '1';
}

export interface UsageWindow { usd: number; tokensIn: number; tokensOut: number }
export interface UsageRow { kind: string; day: Date | string; key: string | null; v: number | string | null }

const emptyWindow = (): UsageWindow => ({ usd: 0, tokensIn: 0, tokensOut: 0 });

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function add(w: UsageWindow, kind: string, v: number): void {
  if (kind === 'run_spend') w.usd += v;
  else if (kind === 'run_tokens_in') w.tokensIn += v;
  else if (kind === 'run_tokens_out') w.tokensOut += v;
}

function round(w: UsageWindow): UsageWindow {
  return { usd: Number(w.usd.toFixed(4)), tokensIn: Math.round(w.tokensIn), tokensOut: Math.round(w.tokensOut) };
}

export interface UsageSummary {
  today: UsageWindow;
  d7: UsageWindow;
  d30: UsageWindow;
  /** oldest → newest, USD_DAILY_DAYS entries, every day present */
  daily: Array<{ date: string; usd: number; tokens: number }>;
  /** per key (chat id or project id), 7-day window */
  byKey: Map<string, { today: UsageWindow; d7: UsageWindow; d30: UsageWindow }>;
}

/** Pure: daily per-key rows (≤ 30 days) → the windows + series. */
export function summarizeUsage(rows: UsageRow[], now: Date): UsageSummary {
  const today0 = startOfUtcDay(now).getTime();
  const d7From = today0 - 6 * DAY_MS;
  const dailyFrom = today0 - (USAGE_DAILY_DAYS - 1) * DAY_MS;
  const out: UsageSummary = { today: emptyWindow(), d7: emptyWindow(), d30: emptyWindow(), daily: [], byKey: new Map() };
  const daily = new Map<number, { usd: number; tokens: number }>();
  for (let t = dailyFrom; t <= today0; t += DAY_MS) daily.set(t, { usd: 0, tokens: 0 });
  for (const r of rows) {
    const v = Number(r.v ?? 0);
    if (!Number.isFinite(v) || v === 0) continue;
    const dayMs = startOfUtcDay(new Date(r.day)).getTime();
    const key = r.key ?? '';
    let k = out.byKey.get(key);
    if (!k) { k = { today: emptyWindow(), d7: emptyWindow(), d30: emptyWindow() }; out.byKey.set(key, k); }
    add(out.d30, r.kind, v); add(k.d30, r.kind, v);
    if (dayMs >= d7From) { add(out.d7, r.kind, v); add(k.d7, r.kind, v); }
    if (dayMs >= today0) { add(out.today, r.kind, v); add(k.today, r.kind, v); }
    const d = daily.get(dayMs);
    if (d) { if (r.kind === 'run_spend') d.usd += v; else d.tokens += v; }
  }
  out.today = round(out.today); out.d7 = round(out.d7); out.d30 = round(out.d30);
  for (const [key, k] of out.byKey) out.byKey.set(key, { today: round(k.today), d7: round(k.d7), d30: round(k.d30) });
  out.daily = [...daily.entries()].map(([t, d]) => ({ date: new Date(t).toISOString().slice(0, 10), usd: Number(d.usd.toFixed(4)), tokens: Math.round(d.tokens) }));
  return out;
}

const KINDS_SQL = USAGE_KINDS.map(k => `'${k}'`).join(',');

export interface ProjectUsage {
  projectId: string;
  today: UsageWindow; d7: UsageWindow; d30: UsageWindow;
  daily: Array<{ date: string; usd: number; tokens: number }>;
  topChats: Array<{ chatId: string; title: string | null; usd7d: number; tokens7d: number }>;
}

export async function projectUsage(projectId: string, ownerId: string, now: Date = new Date()): Promise<ProjectUsage> {
  const from = new Date(startOfUtcDay(now).getTime() - 29 * DAY_MS);
  const rows = await prisma.$queryRawUnsafe<UsageRow[]>(
    `SELECT lm.kind AS kind, date_trunc('day', lm."createdAt") AS day, lm."sessionId" AS key, SUM(lm.value)::float AS v
       FROM loop_metrics lm JOIN crossmodel_chats c ON c.id = lm."sessionId"
      WHERE c."projectId" = $1 AND c."userId" = $2 AND lm.kind IN (${KINDS_SQL}) AND lm."createdAt" >= $3
      GROUP BY 1, 2, 3`,
    projectId, ownerId, from,
  );
  const s = summarizeUsage(rows, now);
  const top = [...s.byKey.entries()]
    .map(([chatId, k]) => ({ chatId, usd7d: k.d7.usd, tokens7d: k.d7.tokensIn + k.d7.tokensOut }))
    .filter(r => r.usd7d > 0 || r.tokens7d > 0)
    .sort((a, b) => b.usd7d - a.usd7d || b.tokens7d - a.tokens7d)
    .slice(0, 6);
  const titles = top.length
    ? await prisma.crossModelChat.findMany({ where: { id: { in: top.map(t => t.chatId) } }, select: { id: true, title: true } })
    : [];
  const titleBy = new Map(titles.map(t => [t.id, t.title ?? null]));
  return {
    projectId, today: s.today, d7: s.d7, d30: s.d30, daily: s.daily,
    topChats: top.map(t => ({ ...t, title: titleBy.get(t.chatId) ?? null })),
  };
}

export interface FleetUsage {
  today: UsageWindow; d7: UsageWindow; d30: UsageWindow;
  daily: Array<{ date: string; usd: number; tokens: number }>;
  projects: Array<{ projectId: string | null; name: string; supervisorChatId: string | null; usdToday: number; usd7d: number; tokens7d: number }>;
}

export async function fleetUsage(userId: string, now: Date = new Date()): Promise<FleetUsage> {
  const from = new Date(startOfUtcDay(now).getTime() - 29 * DAY_MS);
  const rows = await prisma.$queryRawUnsafe<UsageRow[]>(
    `SELECT lm.kind AS kind, date_trunc('day', lm."createdAt") AS day, c."projectId" AS key, SUM(lm.value)::float AS v
       FROM loop_metrics lm JOIN crossmodel_chats c ON c.id = lm."sessionId"
      WHERE c."userId" = $1 AND lm.kind IN (${KINDS_SQL}) AND lm."createdAt" >= $2
      GROUP BY 1, 2, 3`,
    userId, from,
  );
  const s = summarizeUsage(rows, now);
  const projectIds = [...s.byKey.keys()].filter(Boolean);
  const [projects, supervisors] = await Promise.all([
    projectIds.length ? prisma.crossModelProject.findMany({ where: { id: { in: projectIds } }, select: { id: true, name: true } }) : Promise.resolve([]),
    projectIds.length ? prisma.crossModelChat.findMany({ where: { userId, isProjectSupervisor: true, projectId: { in: projectIds }, archivedAt: null }, select: { id: true, projectId: true } }) : Promise.resolve([]),
  ]);
  const nameBy = new Map(projects.map(p => [p.id, p.name]));
  const supBy = new Map(supervisors.map(c => [c.projectId as string, c.id]));
  const list = [...s.byKey.entries()].map(([key, k]) => ({
    projectId: key || null,
    name: key ? nameBy.get(key) ?? 'Project' : 'No project',
    supervisorChatId: key ? supBy.get(key) ?? null : null,
    usdToday: k.today.usd, usd7d: k.d7.usd, tokens7d: k.d7.tokensIn + k.d7.tokensOut,
  })).filter(p => p.usd7d > 0 || p.tokens7d > 0 || p.usdToday > 0)
    .sort((a, b) => b.usd7d - a.usd7d || b.tokens7d - a.tokens7d);
  return { today: s.today, d7: s.d7, d30: s.d30, daily: s.daily, projects: list };
}
