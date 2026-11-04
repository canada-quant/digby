/**
 * First-party visitor analytics — the read side + maintenance (owner 2026-10-07). A fake raw-SQL Prisma answers by
 * statement shape; these pin the merge logic, the per-user cost rule, server-side pagination / sort whitelist,
 * the kid exclusion and the rollup / retention bookkeeping. (Every statement was also executed against Postgres 16
 * — PGlite with the full schema — with fixtures; see the AGENTS.md bullet.)
 */
const mockExec = jest.fn(async (..._a: any[]) => 0);
const mockQuery = jest.fn(async (..._a: any[]): Promise<any> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $executeRawUnsafe: (...a: any[]) => mockExec(...a), $queryRawUnsafe: (...a: any[]) => mockQuery(...a) },
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  trafficSources, trafficUsers, trafficFlow, rollupSpendDaily, sweepVisitEvents, runVisitorAnalyticsMaintenanceOnce,
  resolveRange, spendSplit, likeEscape, resolveSpendSql, SqlParams, USER_SORTS, redactTouch, DECISION_GATE_SPEND_SESSION,
  visitEventsRetentionDays, ROLLUP_SENTINEL_KIND, RETENTION_BATCH,
} from './visitor-analytics.service';
import { DECISION_GATE_SYNTHETIC_SESSION } from '../platform/decision-gate-pricing';

const NOW = new Date('2026-10-07T12:00:00.000Z');
const DAY = 86_400_000;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VISITOR_ANALYTICS_DISABLED;
  delete process.env.SPEND_ROLLUP_DISABLED;
  delete process.env.VISIT_EVENTS_RETENTION_DAYS;
});

describe('spend attribution SQL (resolveSpendSql)', () => {
  it('maps chat → owner, anon- → the visitor that carried that spendSessionId else guest, chatless, decision-gate, other', () => {
    const p = new SqlParams();
    const sql = resolveSpendSql(p, new Date(0), NOW);
    expect(sql).toContain(`WHEN c."userId" IS NOT NULL THEN 'user'`);
    expect(sql).toContain(`WHEN lm."sessionId" LIKE 'anon-%' AND ve."visitorId" IS NOT NULL THEN 'visitor'`);
    expect(sql).toContain(`WHEN lm."sessionId" LIKE 'anon-%' THEN 'guest'`);
    expect(sql).toContain(`WHEN lm."sessionId" LIKE 'chatless-%' THEN 'chatless'`);
    expect(sql).toContain(`WHEN lm."sessionId" = 'decision-gate' THEN 'decision_gate'`);
    expect(sql).toContain(`e."spendSessionId" = lm."sessionId"`);
    expect(sql).toContain(`lm."kind" = 'run_spend'`);
    expect(p.values).toEqual([new Date(0), NOW]);
  });

  it('the decision-gate synthetic session literal matches platform/decision-gate-pricing', () => {
    expect(DECISION_GATE_SPEND_SESSION).toBe(DECISION_GATE_SYNTHETIC_SESSION);
  });

  it('the live/rollup split is UTC midnight 28 days before today (inside the 30-day loop_metrics retention)', () => {
    expect(spendSplit(NOW).toISOString()).toBe('2026-09-09T00:00:00.000Z');
  });
});

describe('resolveRange', () => {
  it('defaults to the last 30 days ending tomorrow-midnight (to inclusive as a day)', () => {
    const r = resolveRange(undefined, undefined, NOW);
    expect(r.to.toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(r.from.toISOString()).toBe('2026-09-08T00:00:00.000Z');
  });
  it('honours YYYY-MM-DD, fixes an inverted range and clamps to 400 days', () => {
    expect(resolveRange('2026-10-01', '2026-10-03', NOW)).toEqual({ from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-04T00:00:00Z') });
    expect(resolveRange('2026-10-05', '2026-10-01', NOW).from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    const wide = resolveRange('2020-01-01', '2026-10-01', NOW);
    expect((wide.to.getTime() - wide.from.getTime()) / DAY).toBe(400);
    expect(resolveRange('junk', "'; drop", NOW).to.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });
});

describe('trafficSources — merges the per-metric queries by channel + campaign', () => {
  it('builds channel rows (Google Ads and Facebook Ads separate), campaigns, funnel, cost buckets, paths', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/guest_chatters/.test(sql)) return [
        { channel: 'google_ads', campaign: 'fall', visitors: 10, guest_chatters: 4 },
        { channel: 'facebook_ads', campaign: '', visitors: 5, guest_chatters: 1 },
        { channel: 'direct', campaign: '', visitors: 3, guest_chatters: 0 },
      ];
      if (/AS signups/.test(sql)) return [
        { channel: 'google_ads', campaign: 'fall', signups: 3, activated: 2, d7_eligible: 1, retained: 1 },
        { channel: 'unknown', campaign: '', signups: 2, activated: 2, d7_eligible: 2, retained: 0 },
      ];
      if (/rc_raw/.test(sql)) return [
        { channel: 'google_ads', campaign: 'fall', kind: 'user', usd: 1.25 },
        { channel: 'google_ads', campaign: 'fall', kind: 'visitor', usd: 0.25 },
        { channel: 'unattributed', campaign: '', kind: 'guest', usd: 0.1 },
        { channel: 'unattributed', campaign: '', kind: 'decision_gate', usd: 0.01 },
      ];
      if (/AS landed/.test(sql)) return [{ channel: 'google_ads', landed: 10, signed_up: 3, first_chat: 2, d7_eligible: 1, d7_active: 1, guest_chatted: 4 }];
      if (/AS views/.test(sql)) return [{ path: '/crossmodel', views: 20, visitors: 9 }];
      if (/firstTouch"->>'landing'/.test(sql)) return [{ path: '/', visitors: 12 }];
      return [];
    });
    const s = await trafficSources({ from: new Date(NOW.getTime() - 30 * DAY), to: NOW, now: NOW });
    const g = s.channels.find((c) => c.channel === 'google_ads')!;
    expect(g).toMatchObject({ label: 'Google Ads', paid: true, visitors: 10, guestChatters: 4, signups: 3, activated: 2, d7Eligible: 1, retainedD7: 1, costUsd: 1.5 });
    const f = s.channels.find((c) => c.channel === 'facebook_ads')!;
    expect(f).toMatchObject({ label: 'Facebook / Instagram Ads', paid: true, visitors: 5 });
    // paid channels sort first
    expect(s.channels.slice(0, 2).map((c) => c.channel)).toEqual(['google_ads', 'facebook_ads']);
    expect(s.campaigns).toEqual([expect.objectContaining({ channel: 'google_ads', campaign: 'fall', visitors: 10, signups: 3, costUsd: 1.5 })]);
    expect(s.totals).toMatchObject({ visitors: 18, signups: 5, activated: 4, costUsd: 1.61 });
    expect(s.spendByKind).toEqual([{ kind: 'user', usd: 1.25 }, { kind: 'visitor', usd: 0.25 }, { kind: 'guest', usd: 0.1 }, { kind: 'decision_gate', usd: 0.01 }]);
    expect(s.funnel[0]).toMatchObject({ channel: 'google_ads', landed: 10, signedUp: 3, firstChat: 2, d7Active: 1 });
    expect(s.topPaths).toEqual([{ path: '/crossmodel', views: 20, visitors: 9 }]);
    expect(s.topLandings).toEqual([{ path: '/', visitors: 12 }]);
    expect(s.captureEnabled).toBe(true);
  });

  it('every query excludes bots / kids / deleted users and counts HUMAN messages only', async () => {
    await trafficSources({ from: new Date(NOW.getTime() - DAY), to: NOW, now: NOW });
    const sqls = mockQuery.mock.calls.map((c) => String(c[0]));
    expect(sqls.filter((s) => /FROM "visitors" v/.test(s)).every((s) => /v."isBot" = false/.test(s))).toBe(true);
    expect(sqls.find((s) => /AS signups/.test(s))).toMatch(/u."isChild" = false AND u."deletedAt" IS NULL/);
    expect(sqls.find((s) => /AS signups/.test(s))).toContain(`COALESCE(m."metadata"->>'origin', 'user') = 'user'`);
    // a child's spend never lands on a channel row
    expect(sqls.find((s) => /rc_raw/.test(s))).toContain(`u."isChild" = false THEN COALESCE(ft.channel, 'unknown')`);
  });

  it('a range older than the split reads the rollup (sentinel rows excluded); a recent one reads live only', async () => {
    await trafficSources({ from: new Date(NOW.getTime() - 90 * DAY), to: NOW, now: NOW });
    const old = String(mockQuery.mock.calls.find((c) => /rc_raw/.test(String(c[0])))![0]);
    expect(old).toContain('FROM "spend_daily_rollups"');
    expect(old).toContain(`"subjectKind" <> '${ROLLUP_SENTINEL_KIND}'`);
    expect(old).toContain('FROM "loop_metrics" lm');
    jest.clearAllMocks();
    await trafficSources({ from: new Date(NOW.getTime() - 3 * DAY), to: NOW, now: NOW });
    const recent = String(mockQuery.mock.calls.find((c) => /rc_raw/.test(String(c[0])))![0]);
    expect(recent).not.toContain('spend_daily_rollups');
  });

  it('reports the capture switch', async () => {
    process.env.VISITOR_ANALYTICS_DISABLED = '1';
    expect((await trafficSources({ from: new Date(0), to: NOW, now: NOW })).captureEnabled).toBe(false);
  });
});

describe('trafficUsers — one server-side sorted / searched / paginated table', () => {
  const row = (over: Record<string, any> = {}) => ({
    kind: 'user', sid: 'u1', label: 'a@b.c', channel: 'google_ads', campaign: 'fall', signed_up: new Date('2026-09-01'), last_active: new Date('2026-10-06'),
    chats7: 1, chats30: 2, msgs7: 3, msgs30: 4, cost1: 0.1, cost7: 0.2, cost30: 0.3, cost_all: 1.23456, ip_hash: 'abcdef0123456789', device: 'chrome/macos/desktop', total_count: 42, ...over,
  });

  it('maps rows: short ip hash, channel label, money rounded, total from the window count', async () => {
    mockQuery.mockResolvedValueOnce([row(), row({ kind: 'visitor', sid: 'v1', label: 'visitor abcdef01', signed_up: null, campaign: null })]);
    const page = await trafficUsers({ now: NOW, page: 2, pageSize: 10 });
    expect(page.total).toBe(42);
    expect(page.rows[0]).toMatchObject({ kind: 'user', id: 'u1', channelLabel: 'Google Ads', ipHash: 'abcdef01', costAll: 1.2346, signedUpAt: '2026-09-01T00:00:00.000Z' });
    expect(page.rows[1]).toMatchObject({ kind: 'visitor', signedUpAt: null, campaign: null });
    expect(page).toMatchObject({ page: 2, pageSize: 10, sort: 'lastActive', dir: 'desc' });
    const [sql, ...params] = mockQuery.mock.calls[0];
    expect(params.slice(-2)).toEqual([10, 10]); // LIMIT pageSize OFFSET (page-1)*pageSize
    expect(String(sql)).toContain('ORDER BY last_active DESC NULLS LAST, rows.sid ASC');
  });

  it('sort is a whitelist (an injection attempt falls back to lastActive); pageSize is clamped 1..100', async () => {
    await trafficUsers({ now: NOW, sort: 'cost_all; DROP TABLE users', dir: 'asc', pageSize: 5000 });
    const [sql, ...params] = mockQuery.mock.calls[0];
    expect(String(sql)).not.toContain('DROP');
    expect(String(sql)).toContain('ORDER BY last_active ASC NULLS LAST');
    expect(params.slice(-2)).toEqual([100, 0]);
    for (const [key, col] of Object.entries(USER_SORTS)) {
      jest.clearAllMocks();
      await trafficUsers({ now: NOW, sort: key, dir: 'desc' });
      expect(String(mockQuery.mock.calls[0][0])).toContain(`ORDER BY ${col} DESC NULLS LAST`);
    }
  });

  it('search terms are parameters with LIKE wildcards escaped; kind / channel filters are parameters', async () => {
    await trafficUsers({ now: NOW, q: "50%_off' OR 1=1", kind: 'visitors', channel: 'facebook_ads' });
    const [sql, ...params] = mockQuery.mock.calls[0];
    expect(String(sql)).not.toContain('OR 1=1');
    expect(params).toContain("%50\\%\\_off' OR 1=1%");
    expect(params).toContain('visitor');
    expect(params).toContain('facebook_ads');
    expect(likeEscape('a%b_c\\')).toBe('a\\%b\\_c\\\\');
  });

  it('kids, deleted users and bots are never subjects; a user\'s cost includes its linked visitors\' guest spend', async () => {
    await trafficUsers({ now: NOW });
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toContain(`WHERE u."isChild" = false AND u."deletedAt" IS NULL`);
    expect(sql).toContain(`WHERE v."isBot" = false AND NOT EXISTS (SELECT 1 FROM "visitor_links" l WHERE l."visitorId" = v."id")`);
    expect(sql).toContain(`CASE WHEN r.kind = 'visitor' AND vo.uid IS NOT NULL THEN 'user' ELSE r.kind END AS kind`);
    expect(sql).toContain(`"day" < `); // all = rollup before the split + live after
  });
});

describe('trafficFlow', () => {
  it('a Digby Kids account (or a missing user) has no flow', async () => {
    mockQuery.mockResolvedValueOnce([{ id: 'k', email: 'k@x', createdAt: NOW, isChild: true }]);
    expect(await trafficFlow({ userId: 'k', now: NOW })).toBeNull();
    mockQuery.mockResolvedValueOnce([]);
    expect(await trafficFlow({ userId: 'nope', now: NOW })).toBeNull();
    expect(await trafficFlow({ now: NOW })).toBeNull();
  });

  it('merges landing (click ids as presence only) + events + DB rows (signup, first chat, chat days, coding) oldest-first', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM "users" WHERE "id" = \$1/.test(sql)) return [{ id: 'u1', email: 'a@b.c', createdAt: new Date('2026-09-02T10:00:00Z'), isChild: false }];
      if (/SELECT v\.\* FROM "visitor_links"/.test(sql)) return [{ id: 'v1', ipHash: 'abcdef0123', uaFamily: 'safari/ios/mobile', channel: 'google_ads', campaign: 'fall', firstSeen: new Date('2026-09-02T09:00:00Z'), lastSeen: NOW, firstTouch: { utm_source: 'google', gclid: 'SECRET-CLICK', landing: '/' }, lastTouch: null, isBot: false }];
      if (/FROM "visit_events" e\s+WHERE e."userId" = \$1 OR/.test(sql)) return [{ type: 'page_view', path: '/login', props: null, source: 'client', createdAt: new Date('2026-09-02T09:30:00Z') }];
      if (/MIN\(m."createdAt"\)/.test(sql)) return [{ at: new Date('2026-09-02T10:05:00Z') }];
      if (/date_trunc\('day'/.test(sql)) return [{ day: new Date('2026-09-02T00:00:00Z'), msgs: 4, chats: 1 }];
      if (/FROM "coding_sessions" s/.test(sql)) return [{ id: 's1', createdAt: new Date('2026-09-03T00:00:00Z') }];
      if (/AS c_all/.test(sql)) return [{ c1: 0, c7: 0.5, c30: 1, c_all: 2 }];
      return [];
    });
    const f = (await trafficFlow({ userId: 'u1', now: NOW }))!;
    expect(f.subject).toMatchObject({ kind: 'user', label: 'a@b.c' });
    expect(f.attribution).toMatchObject({ channel: 'google_ads', campaign: 'fall' });
    expect(f.cost).toEqual({ cost1: 0, cost7: 0.5, cost30: 1, costAll: 2 });
    expect(f.items.map((i) => i.kind)).toEqual(['chat_day', 'landing', 'event', 'signup', 'first_chat', 'coding_session']);
    expect(JSON.stringify(f)).not.toContain('SECRET-CLICK');
    expect(f.items.find((i) => i.kind === 'landing')!.detail).toMatchObject({ utm_source: 'google', gclid: true });
    expect(f.visitors[0].ipHash).toBe('abcdef01');
    // the coding sessions read excludes supervisor-spawned lanes
    const codingSql = String(mockQuery.mock.calls.find((c) => /coding_sessions/.test(String(c[0])))![0]);
    expect(codingSql).toContain('NOT COALESCE(p."isSupervisor" OR p."isProjectSupervisor", false)');
  });

  it('redactTouch keeps everything but the click id values', () => {
    expect(redactTouch({ fbclid: 'x', utm_source: 'fb' })).toEqual({ fbclid: true, utm_source: 'fb' });
    expect(redactTouch(null)).toBeNull();
  });
});

describe('maintenance (worker cron)', () => {
  it('rollup: an empty table backfills 29 days (one upsert + sentinel + stale-row delete per day)', async () => {
    mockQuery.mockResolvedValueOnce([{ d: null }]);
    const r = await rollupSpendDaily(NOW);
    expect(r.days).toBe(29);
    const upserts = mockExec.mock.calls.filter((c) => /INSERT INTO "spend_daily_rollups"/.test(String(c[0])) && /SELECT \$1::date, kind, sid/.test(String(c[0])));
    expect(upserts).toHaveLength(29);
    expect(upserts[0][1]).toBe('2026-09-08'); // oldest first
    expect(upserts[28][1]).toBe('2026-10-06'); // yesterday — today is never rolled
    expect(mockExec.mock.calls.filter((c) => String(c[0]).includes(`'${ROLLUP_SENTINEL_KIND}'`))).toHaveLength(29);
    expect(mockExec.mock.calls.filter((c) => /DELETE FROM "spend_daily_rollups"/.test(String(c[0])))).toHaveLength(29);
  });

  it('rollup: after yesterday was rolled it rebuilds the last 2 days (late rows); never more than 29', async () => {
    mockQuery.mockResolvedValueOnce([{ d: '2026-10-06' }]);
    expect((await rollupSpendDaily(NOW)).days).toBe(2);
    mockQuery.mockResolvedValueOnce([{ d: '2026-01-01' }]);
    expect((await rollupSpendDaily(NOW)).days).toBe(29);
  });

  it('retention: deletes events older than VISIT_EVENTS_RETENTION_DAYS (default 400) in batches + unlinked stale visitors', async () => {
    expect(visitEventsRetentionDays()).toBe(400);
    process.env.VISIT_EVENTS_RETENTION_DAYS = '90';
    expect(visitEventsRetentionDays()).toBe(90);
    process.env.VISIT_EVENTS_RETENTION_DAYS = '5'; // below the 30-day floor → default
    expect(visitEventsRetentionDays()).toBe(400);
    delete process.env.VISIT_EVENTS_RETENTION_DAYS;
    mockExec.mockResolvedValueOnce(RETENTION_BATCH).mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    const r = await sweepVisitEvents(NOW);
    expect(r).toEqual({ events: RETENTION_BATCH + 7, visitors: 3 });
    expect(mockExec.mock.calls[0][1]).toEqual(new Date(NOW.getTime() - 400 * DAY));
    expect(String(mockExec.mock.calls[2][0])).toContain('NOT EXISTS (SELECT 1 FROM "visitor_links"');
  });

  it('the cron body always runs retention, skips the rollup under SPEND_ROLLUP_DISABLED=1, never throws', async () => {
    process.env.SPEND_ROLLUP_DISABLED = '1';
    expect(await runVisitorAnalyticsMaintenanceOnce(NOW)).toBe('retention: -0 events, -0 visitors; rollup disabled');
    delete process.env.SPEND_ROLLUP_DISABLED;
    mockExec.mockRejectedValueOnce(new Error('boom'));
    mockQuery.mockRejectedValueOnce(new Error('bang'));
    const s = await runVisitorAnalyticsMaintenanceOnce(NOW);
    expect(s).toContain('retention failed: boom');
    expect(s).toContain('rollup failed: bang');
  });
});
