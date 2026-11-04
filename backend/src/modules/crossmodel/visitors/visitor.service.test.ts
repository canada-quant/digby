/**
 * First-party visitor analytics — the write side (owner 2026-10-07). A fake raw-SQL Prisma records every statement
 * + its params, so these pin WHAT is written (never a raw IP, the first-touch-never-overwritten upsert, the dedupe
 * rules, the Digby Kids exclusion, the kill switch). The SQL semantics themselves were validated against Postgres 16
 * (PGlite) with the full schema — see the AGENTS.md bullet.
 */
const mockExec = jest.fn(async (..._a: any[]) => 1);
const mockQuery = jest.fn(async (..._a: any[]): Promise<any> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { $executeRawUnsafe: (...a: any[]) => mockExec(...a), $queryRawUnsafe: (...a: any[]) => mockQuery(...a) },
}));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  ingestVisitBatch, recordServerVisitEvent, recordAuthVisit, visitorIdFromRequest, cookieTouch, clientIpForHash,
  sanitizeProps, dedupeKeyFor, __resetVisitorCachesForTest, MAX_EVENTS_PER_BATCH, isChildUser,
} from './visitor.service';
import { hashIp } from './ip-hash';

const V = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const U = '11111111-1111-4111-8111-111111111111';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const req = (over: Record<string, any> = {}) => ({ headers: { 'user-agent': UA, 'x-forwarded-for': '203.0.113.7, 10.0.0.1', ...(over.headers ?? {}) }, cookies: over.cookies ?? {} });
const NOW = new Date('2026-10-07T12:00:00.000Z');

const statements = () => mockExec.mock.calls.map((c) => String(c[0]));
const callsMatching = (re: RegExp) => mockExec.mock.calls.filter((c) => re.test(String(c[0])));
/** isChild lookups answer from this map; everything else answers []. */
let children: Record<string, boolean> = {};

beforeEach(() => {
  jest.clearAllMocks();
  __resetVisitorCachesForTest();
  children = {};
  delete process.env.VISITOR_ANALYTICS_DISABLED;
  process.env.VISITOR_HASH_SECRET = 'test-secret';
  mockQuery.mockImplementation(async (sql: string, ...p: any[]) => {
    if (/SELECT "isChild" FROM "users"/.test(sql)) return p[0] in children ? [{ isChild: children[p[0]] }] : [];
    return [];
  });
});

describe('ingestVisitBatch — the open endpoint body', () => {
  const body = (over: Record<string, any> = {}) => ({
    visitorId: V,
    events: [{ type: 'page_view', path: '/crossmodel?secret=1', ts: NOW.getTime() - 1000 }],
    attribution: { first: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'fall', gclid: 'g1', landing: '/?gclid=g1' } },
    ...over,
  });

  it('upserts the visitor with the HASHED ip (never the raw ip) + the coarse UA family, and inserts the events', async () => {
    const r = await ingestVisitBatch({ body: body(), req: req(), now: NOW });
    expect(r).toEqual({ status: 'stored', events: 1, visitorId: V });
    const upsert = callsMatching(/INSERT INTO "visitors"/)[0];
    expect(upsert).toBeDefined();
    const flat = JSON.stringify(mockExec.mock.calls);
    expect(flat).not.toContain('203.0.113.7');
    expect(upsert[2]).toBe(hashIp('203.0.113.7'));
    expect(upsert[10]).toBe('chrome/macos/desktop');
    expect(upsert[5]).toBe('google_ads'); // channel classified SERVER-side
    expect(upsert[6]).toBe('fall');
    const ev = callsMatching(/INSERT INTO "visit_events"/)[0];
    expect(ev[4]).toBe('page_view');
    expect(ev[5]).toBe('/crossmodel'); // normalized — the query string never stored
    expect(ev[7]).toBe('client');
  });

  it('the upsert never overwrites a stored first touch (COALESCE old-first; channel / campaign only while firstTouch IS NULL)', async () => {
    await ingestVisitBatch({ body: body(), req: req(), now: NOW });
    const sql = String(callsMatching(/INSERT INTO "visitors"/)[0][0]);
    expect(sql).toContain('"firstTouch"  = COALESCE("visitors"."firstTouch", EXCLUDED."firstTouch")');
    expect(sql).toContain('"channel"     = CASE WHEN "visitors"."firstTouch" IS NULL AND EXCLUDED."firstTouch" IS NOT NULL THEN EXCLUDED."channel" ELSE "visitors"."channel" END');
    expect(sql).toContain('"firstSeen"   = LEAST("visitors"."firstSeen", EXCLUDED."firstSeen")');
  });

  it('a direct (sourceless) last touch is not written — lastTouch only moves on a sourced landing', async () => {
    await ingestVisitBatch({ body: body({ attribution: { first: { landing: '/' }, last: { landing: '/x' } } }), req: req(), now: NOW });
    const up = callsMatching(/INSERT INTO "visitors"/)[0];
    expect(up[4]).toBeNull(); // lastTouch
    expect(up[5]).toBe('direct');
  });

  it('accepts a sendBeacon text/plain body (a JSON string)', async () => {
    const r = await ingestVisitBatch({ body: JSON.stringify(body()), req: req(), now: NOW });
    expect(r.status).toBe('stored');
  });

  it('rejects a malformed body (400 shape) but silently drops unknown event types', async () => {
    expect((await ingestVisitBatch({ body: { visitorId: 'nope', events: [] }, req: req() })).status).toBe('invalid');
    expect((await ingestVisitBatch({ body: '{not json', req: req() })).status).toBe('invalid');
    expect((await ingestVisitBatch({ body: { visitorId: V, events: Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, () => ({ type: 'page_view' })) }, req: req() })).status).toBe('invalid');
    jest.clearAllMocks();
    const r = await ingestVisitBatch({ body: { visitorId: V, events: [{ type: 'future_type' }, { type: 'first_chat' }] }, req: req(), now: NOW });
    expect(r).toEqual({ status: 'stored', events: 0, visitorId: V });
    expect(callsMatching(/INSERT INTO "visit_events"/)).toHaveLength(0); // first_chat is server-only
  });

  it('drops an obvious bot before anything is written; navigator.webdriver is kept as isBot', async () => {
    const r = await ingestVisitBatch({ body: body(), req: req({ headers: { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' } }), now: NOW });
    expect(r).toEqual({ status: 'skipped', reason: 'bot' });
    expect(mockExec).not.toHaveBeenCalled();
    await ingestVisitBatch({ body: body({ webdriver: true }), req: req(), now: NOW });
    expect(callsMatching(/INSERT INTO "visitors"/)[0][11]).toBe(true);
  });

  it('links the visitor to a signed-in adult', async () => {
    children[U] = false;
    await ingestVisitBatch({ body: body(), req: req(), user: { id: U, isChild: false }, now: NOW });
    const link = callsMatching(/INSERT INTO "visitor_links"/)[0];
    expect(link.slice(1, 3)).toEqual([V, U]);
  });

  it('Digby Kids: a child token or a DB child stores NOTHING and erases the visitor (unless an adult owns it)', async () => {
    let r = await ingestVisitBatch({ body: body(), req: req(), user: { id: 'kid', isChild: true }, now: NOW });
    expect(r).toEqual({ status: 'skipped', reason: 'child' });
    expect(statements().some((s) => /INSERT/.test(s))).toBe(false);
    expect(statements().some((s) => /DELETE FROM "visitors"/.test(s) && /u."isChild" = false/.test(s))).toBe(true);
    jest.clearAllMocks();
    children.kid2 = true; // stale token without the claim — the DB says child
    r = await ingestVisitBatch({ body: body(), req: req(), user: { id: 'kid2' }, now: NOW });
    expect(r).toEqual({ status: 'skipped', reason: 'child' });
    expect(statements().some((s) => /INSERT/.test(s))).toBe(false);
  });

  it('kill switch VISITOR_ANALYTICS_DISABLED=1: nothing written', async () => {
    process.env.VISITOR_ANALYTICS_DISABLED = '1';
    expect(await ingestVisitBatch({ body: body(), req: req(), now: NOW })).toEqual({ status: 'skipped', reason: 'disabled' });
    expect(mockExec).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a client copy of a server-authoritative type yields to a server row in the ±5 min window', async () => {
    mockQuery.mockImplementation(async (sql: string) => (/"source" = 'server'/.test(sql) ? [{ '?column?': 1 }] : []));
    await ingestVisitBatch({ body: body({ events: [{ type: 'chat_sent', ts: NOW.getTime() }, { type: 'page_view' }] }), req: req(), now: NOW });
    const ev = callsMatching(/INSERT INTO "visit_events"/)[0];
    expect(ev.filter((v: any) => v === 'chat_sent')).toHaveLength(0);
    expect(ev.filter((v: any) => v === 'page_view')).toHaveLength(1);
  });

  it('once types carry the subject dedupe key (the unique index makes client + server one row)', async () => {
    children[U] = false;
    await ingestVisitBatch({ body: body({ events: [{ type: 'signup_complete' }] }), req: req(), user: { id: U, isChild: false }, now: NOW });
    const ev = callsMatching(/INSERT INTO "visit_events"/)[0];
    expect(String(ev[0])).toContain('ON CONFLICT ("dedupeKey") DO NOTHING');
    expect(ev).toContain(`signup_complete:u:${U}`);
  });

  it('a client timestamp outside [now − 24 h, now + 60 s] is stamped now', async () => {
    await ingestVisitBatch({ body: body({ events: [{ type: 'page_view', ts: 1 }] }), req: req(), now: NOW });
    const ev = callsMatching(/INSERT INTO "visit_events"/)[0];
    expect(ev[10]).toEqual(NOW);
  });
});

describe('recordServerVisitEvent — authoritative backend events', () => {
  it('chat_sent for a guest: spendSessionId recorded, first_chat derived once per visitor (dedupe key)', async () => {
    await recordServerVisitEvent({ type: 'chat_sent', userId: null, req: req({ cookies: { dg_vid: V } }), spendSessionId: 'anon-s1', at: NOW });
    const ev = callsMatching(/INSERT INTO "visit_events"/)[0];
    expect(ev).toContain('chat_sent');
    expect(ev).toContain('first_chat');
    expect(ev).toContain('anon-s1');
    expect(ev).toContain(`first_chat:v:${V}`);
    expect(ev).toContain('server');
    // server rows win: the client copies of this type in the window are deleted first
    expect(callsMatching(/DELETE FROM "visit_events" WHERE "type" = \$1 AND "source" = 'client'/)).toHaveLength(1);
  });

  it('chat_sent for a signed-in user with history: no first_chat (prior human message or a stored first_chat)', async () => {
    children[U] = false;
    mockQuery.mockImplementation(async (sql: string, ...p: any[]) => {
      if (/SELECT "isChild"/.test(sql)) return [{ isChild: false }];
      if (/AS hit/.test(sql)) { expect(p[0]).toBe(`first_chat:u:${U}`); return [{ hit: true }]; }
      return [];
    });
    await recordServerVisitEvent({ type: 'chat_sent', userId: U, at: NOW });
    const ev = callsMatching(/INSERT INTO "visit_events"/)[0];
    expect(ev).not.toContain('first_chat');
  });

  it('chat_sent for a brand-new user: first_chat recorded with the user key', async () => {
    mockQuery.mockImplementation(async (sql: string) => (/SELECT "isChild"/.test(sql) ? [{ isChild: false }] : /AS hit/.test(sql) ? [{ hit: false }] : []));
    await recordServerVisitEvent({ type: 'chat_sent', userId: U, at: NOW });
    expect(callsMatching(/INSERT INTO "visit_events"/)[0]).toContain(`first_chat:u:${U}`);
  });

  it('Digby Kids: never recorded (caller-known or DB child), and the browser\'s visitor id is erased', async () => {
    await recordServerVisitEvent({ type: 'chat_sent', userId: 'k', isChild: true, req: req({ cookies: { dg_vid: V } }), at: NOW });
    children.k2 = true;
    await recordServerVisitEvent({ type: 'chat_sent', userId: 'k2', req: req({ cookies: { dg_vid: V } }), at: NOW });
    expect(statements().some((s) => /INSERT/.test(s))).toBe(false);
    expect(callsMatching(/DELETE FROM "visitors"/)).toHaveLength(2);
  });

  it('an unknown user (no row) is treated as never-record (fails closed)', async () => {
    await recordServerVisitEvent({ type: 'chat_sent', userId: 'ghost', at: NOW });
    expect(statements().some((s) => /INSERT/.test(s))).toBe(false);
  });

  it('kill switch: nothing; no subject at all: nothing', async () => {
    process.env.VISITOR_ANALYTICS_DISABLED = '1';
    await recordServerVisitEvent({ type: 'chat_sent', userId: U, isChild: false, at: NOW });
    delete process.env.VISITOR_ANALYTICS_DISABLED;
    await recordServerVisitEvent({ type: 'chat_sent', userId: null, at: NOW });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('a native app\'s HTTP-library UA does not drop a server event (only the family is skipped)', async () => {
    await recordServerVisitEvent({ type: 'login', userId: U, isChild: false, req: req({ headers: { 'user-agent': 'okhttp/4.12.0' }, cookies: { dg_vid: V } }), at: NOW });
    const up = callsMatching(/INSERT INTO "visitors"/)[0];
    expect(up[10]).toBeNull();
    expect(callsMatching(/INSERT INTO "visit_events"/)).toHaveLength(1);
  });

  it('never throws (a DB error is swallowed)', async () => {
    mockExec.mockRejectedValueOnce(new Error('db down'));
    await expect(recordServerVisitEvent({ type: 'login', userId: U, isChild: false, req: req({ cookies: { dg_vid: V } }), at: NOW })).resolves.toBeUndefined();
  });
});

describe('recordAuthVisit — stitching at register / login', () => {
  it('an adult: links visitor → user and records the authoritative event', async () => {
    await recordAuthVisit(req({ cookies: { dg_vid: V } }), { id: U, isChild: false }, 'signup_complete');
    expect(callsMatching(/INSERT INTO "visitor_links"/)[0].slice(1, 3)).toEqual([V, U]);
    const ev = callsMatching(/INSERT INTO "visit_events"/)[0];
    expect(ev).toContain(`signup_complete:u:${U}`);
  });

  it('a child login: no link, no event — the visitor id is erased', async () => {
    await recordAuthVisit(req({ cookies: { dg_vid: V } }), { id: 'kid', isChild: true }, 'login');
    expect(callsMatching(/INSERT/)).toHaveLength(0);
    expect(callsMatching(/DELETE FROM "visitors"/)[0][1]).toBe(V);
  });
});

describe('request helpers', () => {
  it('visitor id: the header first, then the cookie; uuid-shaped only', () => {
    expect(visitorIdFromRequest({ headers: { 'x-digby-visitor': V.toUpperCase() }, cookies: { dg_vid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } })).toBe(V);
    expect(visitorIdFromRequest({ headers: {}, cookies: { dg_vid: V } })).toBe(V);
    expect(visitorIdFromRequest({ headers: { 'x-digby-visitor': 'evil' }, cookies: { dg_vid: '1; drop' } })).toBeNull();
    expect(visitorIdFromRequest(undefined)).toBeNull();
  });

  it('touch cookies parse URI-encoded JSON and sanitize it', () => {
    const c = encodeURIComponent(JSON.stringify({ utm_source: 'fb', fbclid: 'x', referrer: 'https://l.facebook.com/x', junk: 1 }));
    expect(cookieTouch({ cookies: { dg_ft: c } }, 'dg_ft')).toEqual({ utm_source: 'fb', fbclid: 'x', referrer: 'l.facebook.com' });
    expect(cookieTouch({ cookies: { dg_ft: '%%%' } }, 'dg_ft')).toBeNull();
    expect(cookieTouch({ cookies: {} }, 'dg_ft')).toBeNull();
  });

  it('client ip: first XFF entry by default; QUOTA_TRUSTED_PROXY_HOPS takes the entry the last trusted proxy appended', () => {
    const r = { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' }, ip: '9.9.9.9' };
    expect(clientIpForHash(r)).toBe('1.1.1.1');
    process.env.QUOTA_TRUSTED_PROXY_HOPS = '2';
    try { expect(clientIpForHash(r)).toBe('2.2.2.2'); } finally { delete process.env.QUOTA_TRUSTED_PROXY_HOPS; }
    expect(clientIpForHash({ headers: {}, ip: '9.9.9.9' })).toBe('9.9.9.9');
  });

  it('props: ≤ 12 identifier keys, scalar values, strings capped', () => {
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeProps(many)!)).toHaveLength(12);
    expect(sanitizeProps({ 'bad key': 1, ok: 'x'.repeat(300), n: Infinity, b: true, o: { nested: 1 } })).toEqual({ ok: 'x'.repeat(200), b: true });
    expect(sanitizeProps(null)).toBeNull();
  });

  it('dedupe keys: once types only, user before visitor', () => {
    expect(dedupeKeyFor('first_chat', U, V)).toBe(`first_chat:u:${U}`);
    expect(dedupeKeyFor('first_chat', null, V)).toBe(`first_chat:v:${V}`);
    expect(dedupeKeyFor('page_view', U, V)).toBeNull();
    expect(dedupeKeyFor('signup_complete', null, null)).toBeNull();
  });

  it('isChildUser caches and fails closed on a DB error', async () => {
    children[U] = false;
    expect(await isChildUser(U)).toBe(false);
    expect(await isChildUser(U)).toBe(false);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    mockQuery.mockRejectedValueOnce(new Error('x'));
    expect(await isChildUser('other')).toBe(true);
  });
});

describe('wiring — the authoritative hooks (source pins)', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, rel), 'utf8');

  it('streamQuery records chat_sent / dig_deeper for every human send — never a kid — with the guest spend session', () => {
    const c = read('../crossmodel.controller.ts');
    expect(c).toContain('if (!isChild && !(req.user as any)?.isChild) {');
    expect(c).toContain("type: escalation ? 'dig_deeper' : 'chat_sent',");
    expect(c).toContain('spendSessionId: !userId && !chatId && sessionId ? `anon-${sessionId}` : null,');
    // the chat-agent bills a guest turn to exactly that key
    expect(read('../chat-agent/chat-agent.service.ts')).toContain("const runSessionId = chatId || `${userId ? 'chatless' : 'anon'}-${args.sessionId || randomUUID()}`;");
  });

  it('register / login stitch the visitor (auth.controller); human-started coding sessions are recorded (UI + human-turn spawn)', () => {
    const a = read('../../auth/auth.controller.ts');
    expect(a).toContain("void recordAuthVisit(req, result.user, 'signup_complete');");
    expect(a).toContain("void recordAuthVisit(req, result.user, 'login');");
    expect(read('../coding/coding.controller.ts')).toContain("m.recordServerVisitEvent({ type: 'coding_session_started', userId, req: req as any, props: { via: 'ui' } })");
    expect(read('../platform/platform-tools.ts')).toContain("if (humanSpawn) void import('../visitors/visitor.service').then((m) => m.recordServerVisitEvent({ type: 'coding_session_started', userId, props: { via: 'chat' } }))");
  });

  it('the open endpoint sits in the OPEN router with optionalAuthenticate + the text/plain parser (sendBeacon)', () => {
    expect(read('../crossmodel-open.routes.ts')).toContain("router.post('/visit-events', visitEventsBodyParser, optionalAuthenticate, postVisitEvents);");
  });
});
