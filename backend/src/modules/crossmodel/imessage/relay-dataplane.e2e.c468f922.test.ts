/**
 * RELAY DATA PLANE — END-TO-END: an AUTHORIZED brokered session CARRIES bytes
 * (ticket c468f922, owner ruling 2026-10-29/30 on card oq_b5118c38:
 * "can we do option three but a little more secure like how it's just like
 * TeamViewer").
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS NOT ANOTHER UNIT TEST ───────────────
 * The defect this ticket keeps re-learning is a requirement that no LIVE
 * SURFACE satisfies: `stale` was declared, both agents listed it, and nothing
 * emitted it (D1). A unit test that imports `pushRelayFrame` and asserts it
 * returns ok would repeat that mistake exactly — it proves the store works WHEN
 * CALLED, never that a route calls it, that both ends are reachable, or that a
 * byte which one peer sends is the byte the other peer receives.
 *
 * So this suite mounts the REAL `imessage.routes.ts` router over a REAL HTTP
 * listener and drives it with the global `fetch` (the `route-posture.test.ts`
 * precedent — supertest is deliberately not a dependency). Underneath it are
 * the REAL components: the real route table, the real controller handlers, the
 * real relay gate, the real server-assigned sequence counters, and the REAL
 * brokered-session leaf and grant store. Only two things are stand-ins:
 *
 *   - Redis, as an in-memory map (which IS the cross-process bus here, so the
 *     store's real key discipline, TTLs, `SET NX` claim and `INCR` counters all
 *     execute), and
 *   - the DB-backed device lookup (`imessage.service`), because a device row is
 *     not what this suite is testing.
 *
 * ── WHAT IT PROVES ──────────────────────────────────────────────────────────
 *   1. THE CARRY, both directions. A byte the operator sends arrives at the
 *      device and a byte the device sends arrives at the operator, through the
 *      live route surface, decoded byte-for-byte.
 *   2. NO INBOUND PORT. Every request is initiated by a client polling OUT —
 *      asserted structurally against the source, because "we did not add a
 *      listener" is a claim about code that no runtime assertion can make.
 *   3. PER-SESSION AUTH. The session capability gates traffic: a `sessionId`
 *      alone, or a wrong capability, is refused even with a perfectly valid
 *      user JWT.
 *   4. EVERY REFUSAL PATH refuses, and the dangerous ones are named: a session
 *      that was never consumed, one that was closed, and one that went STALE
 *      past its window all stop carrying — the last one being the whole reason
 *      the `stale` token exists.
 */

// ── Stand-in #1: Redis, as an in-memory map ─────────────────────────────────
// Covers every command the grant store AND the relay store use. `INCR` and the
// `SET NX` claim are implemented faithfully, because they are the atomicity
// mechanisms the contracts rest on — a fake that let two callers win would make
// the single-use test vacuous.
const kv = new Map<string, string>();

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => kv.get(k) ?? null),
    setEx: jest.fn(async (k: string, _sec: number, v: string) => {
      kv.set(k, v);
      return 'OK';
    }),
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean; EX?: number }) => {
      if (opts?.NX && kv.has(k)) return null;
      kv.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => (kv.delete(k) ? 1 : 0)),
    rPush: jest.fn(async (k: string, v: string) => {
      const cur = kv.get(k);
      const list = cur ? (JSON.parse(cur) as string[]) : [];
      list.push(v);
      kv.set(k, JSON.stringify(list));
      return list.length;
    }),
    lRange: jest.fn(async (k: string, start: number, stop: number) => {
      const cur = kv.get(k);
      const list = cur ? (JSON.parse(cur) as string[]) : [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => {
      const cur = kv.get(k);
      const list = cur ? (JSON.parse(cur) as string[]) : [];
      const end = stop === -1 ? list.length : stop + 1;
      const from = start < 0 ? Math.max(list.length + start, 0) : start;
      kv.set(k, JSON.stringify(list.slice(from, end)));
      return 'OK';
    }),
    lLen: jest.fn(async (k: string) => {
      const cur = kv.get(k);
      return cur ? (JSON.parse(cur) as string[]).length : 0;
    }),
    incr: jest.fn(async (k: string) => {
      const next = (parseInt(kv.get(k) || '0', 10) || 0) + 1;
      kv.set(k, String(next));
      return next;
    }),
    expire: jest.fn(async () => 1),
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── Stand-in #2: the DB-backed device lookup ────────────────────────────────
// Two paired devices so "wrong device" is expressible, and the token→row lookup
// that `authenticateAgent` performs. Everything else in the module is real.
jest.mock('./imessage.service', () => {
  const AGENTS = [
    {
      id: 'mac-1',
      userId: 'user-1',
      label: 'Office Mac',
      platform: 'macos',
      tokenHash: 'hash-of-agent-secret',
      remoteAccess: { enabled: true, tunnelOnly: true, blockers: [] },
      isDefault: true,
      pairedAt: new Date(),
      lastSeenAt: new Date(),
    },
    {
      id: 'mac-2',
      userId: 'user-1',
      label: 'Home Mini',
      platform: 'macos',
      tokenHash: 'hash-of-other-agent',
      remoteAccess: { enabled: true, tunnelOnly: true, blockers: [] },
      isDefault: false,
      pairedAt: new Date(),
      lastSeenAt: new Date(),
    },
  ];
  return {
    __esModule: true,
    listAgents: jest.fn(async (userId: string) => AGENTS.filter((a) => a.userId === userId)),
    resolveAgentByToken: jest.fn(async (token: string) =>
      token === 'agent-secret' ? AGENTS[0] : token === 'other-agent' ? AGENTS[1] : null,
    ),
    agentDisplayName: (a: any) => a?.label ?? 'Mac',
    getPrimaryAgent: jest.fn(async () => AGENTS[0]),
    selectAgent: jest.fn(async () => AGENTS[0]),
    touchAgent: jest.fn(async () => undefined),
    isOnline: jest.fn(async () => true),
    disconnectAgent: jest.fn(async () => 1),
    renameAgent: jest.fn(async () => AGENTS[0]),
    setDefaultAgent: jest.fn(async () => AGENTS[0]),
    deleteAgent: jest.fn(async () => true),
    startPairing: jest.fn(async () => ({ code: 'ABC12345', expiresAt: new Date() })),
    completePairing: jest.fn(async () => ({ agentToken: 'agent-secret', agent: AGENTS[0] })),
  };
});

// The controller pulls three surface modules that reach config/env at import
// time (the trap that turned 53 suites red — see brokered-session.store.ts).
jest.mock('../browser-agent/router', () => ({
  __esModule: true,
  localBrowserAvailable: () => false,
  localBrowserStatus: () => null,
  localBrowserStatusMulti: () => [],
}));
jest.mock('../computer-agent/availability', () => ({
  __esModule: true,
  computerAgentStatus: () => null,
  computerUseAvailable: () => false,
}));
jest.mock('../computer-agent/vision-client', () => ({
  __esModule: true,
  visionConfigured: () => false,
}));

// The user JWT guard: the REAL `authenticate` middleware runs, so the 401 posture
// is exercised for real; only token verification is stubbed.
jest.mock('../../../utils/jwt', () => ({
  __esModule: true,
  verifyAccessToken: jest.fn((token: string) => {
    if (token === 'user-token') return { userId: 'user-1', email: 'p@example.com', role: 'user' };
    throw new Error('bad token');
  }),
}));
jest.mock('../../../modules/auth/password-change-cutoff', () => ({
  __esModule: true,
  isRevokedByPasswordChange: async () => false,
}));

import express from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import router from './imessage.routes';
import { hashRelayCapability, RELAY_MAX_FRAME_BYTES, RELAY_QUEUE_MAX_FRAMES, RELAY_CAPABILITY_HEADER } from './relay-dataplane';

/** The header sync so the suite and the product cannot drift on its spelling. */
const CAPABILITY_HEADER = RELAY_CAPABILITY_HEADER;

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '75mb' }));
  app.use('/api/crossmodel/imessage', router);
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(500).json({ success: false, error: String(err?.message ?? err) });
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  kv.clear();
});

const USER = { authorization: 'Bearer user-token' };
const AGENT = { 'x-agent-token': 'agent-secret' };
const json = { 'content-type': 'application/json' };

/** One real HTTP round trip, with the parsed body typed for assertions. */
async function api(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Open + consume a real session through the LIVE routes. Returns its handle. */
async function openLiveSession(agentId = 'mac-1') {
  const open = await api(`/api/crossmodel/imessage/agents/${agentId}/brokered-session`, {
    method: 'POST',
    headers: { ...USER, ...json },
    body: { windowSec: 600 },
  });
  expect(open.status).toBe(200);
  const { sessionId, capability } = open.body.data;
  const use = await api(`/api/crossmodel/imessage/agents/${agentId}/brokered-session/use`, {
    method: 'POST',
    headers: { ...USER, ...json },
    body: { sessionId },
  });
  expect(use.status).toBe(200);
  return { sessionId, capability };
}

/**
 * Operator drain — the capability rides the x-session-capability HEADER.
 *
 * Deliberately NOT `?capability=`: independent review (2026-11-02) caught the
 * first cut putting a credential in the query string, where it is written to
 * ALB/nginx access logs, proxies and `Referer` before any application code runs.
 * If this helper ever regresses to the query form, the suite's own
 * "capability-in-url is refused" test fails — the guard is in the product, not
 * just in this file's convention.
 */
const operatorFrames = (sessionId: string, capability: string, after = 0) =>
  api(`/api/crossmodel/imessage/agents/mac-1/relay/frames?sessionId=${sessionId}&after=${after}`, {
    headers: { ...USER, [CAPABILITY_HEADER]: capability },
  });

const devicePush = (payloadB64: string, extra: Record<string, unknown> = {}) =>
  api('/api/crossmodel/imessage/agent/relay/frames', {
    method: 'POST',
    headers: { ...AGENT, ...json },
    body: { payload: payloadB64, ...extra },
  });

describe('THE CARRY — an authorized session moves bytes end to end', () => {
  it('carries a device→operator byte through the live HTTP surface, decoded exactly', async () => {
    const { sessionId, capability } = await openLiveSession();

    // The DEVICE dials out and pushes a frame. No inbound connection to it.
    const push = await devicePush(b64('SCREEN-TILE-ONE'));
    expect(push.status).toBe(200);
    expect(push.body.data.seq).toBe(1); // server-assigned, first frame

    // The OPERATOR dials out and drains it.
    const poll = await operatorFrames(sessionId, capability);
    expect(poll.status).toBe(200);

    // THE PROOF: the byte that left one peer is the byte the other received.
    expect(poll.body.data.frames).toHaveLength(1);
    expect(unb64(poll.body.data.frames[0].payloadB64)).toBe('SCREEN-TILE-ONE');
    expect(poll.body.data.cursor).toBe(poll.body.data.frames[0].seq);
    expect(poll.body.data.more).toBe(false);
  });

  it('carries an operator→device byte back the other way, on its own cursor', async () => {
    const { sessionId, capability } = await openLiveSession();

    const push = await api('/api/crossmodel/imessage/agents/mac-1/relay/frames', {
      method: 'POST',
      headers: { ...USER, ...json },
      body: { sessionId, capability, direction: 'to-device', payload: b64('MOUSE-MOVE-42') },
    });
    expect(push.status).toBe(200);
    // The two directions have SEPARATE counters: the operator's queue started
    // at 1 even though the device's queue is a different stream.
    expect(push.body.data.seq).toBe(1);

    const poll = await api('/api/crossmodel/imessage/agent/relay/frames?after=0', { headers: AGENT });
    expect(poll.status).toBe(200);
    expect(poll.body.data.sessionId).toBe(sessionId);
    expect(poll.body.data.frames).toHaveLength(1);
    expect(unb64(poll.body.data.frames[0].payloadB64)).toBe('MOUSE-MOVE-42');
  });

  it('a cursor is idempotent — draining twice yields the frame once, then nothing', async () => {
    const { sessionId, capability } = await openLiveSession();
    await devicePush(b64('ONCE'));

    const first = await operatorFrames(sessionId, capability, 0);
    expect(first.body.data.frames).toHaveLength(1);
    const cursor = first.body.data.cursor;

    const second = await operatorFrames(sessionId, capability, cursor);
    expect(second.body.data.frames).toEqual([]);
    expect(second.body.data.cursor).toBe(cursor);
  });

  it('delivers only frames newer than the cursor, in sequence order', async () => {
    const { sessionId, capability } = await openLiveSession();
    for (const tag of ['A', 'B', 'C']) await devicePush(b64(tag));

    const res = await operatorFrames(sessionId, capability, 1);
    expect(res.body.data.frames.map((f: any) => unb64(f.payloadB64))).toEqual(['B', 'C']);
    expect(res.body.data.frames.map((f: any) => f.seq)).toEqual([2, 3]);
  });
});

describe('PER-SESSION AUTH — the capability is what authorizes traffic', () => {
  it('refuses a sessionId with NO capability, even with a valid user JWT', async () => {
    const { sessionId } = await openLiveSession();
    const res = await api(`/api/crossmodel/imessage/agents/mac-1/relay/frames?sessionId=${sessionId}&after=0`, {
      headers: USER,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('wrong-capability');
  });

  it('refuses a WRONG capability on both the read and the write path', async () => {
    const { sessionId } = await openLiveSession();
    const read = await operatorFrames(sessionId, 'not-the-capability', 0);
    expect(read.status).toBe(403);
    expect(read.body.code).toBe('wrong-capability');

    const write = await api('/api/crossmodel/imessage/agents/mac-1/relay/frames', {
      method: 'POST',
      headers: { ...USER, ...json },
      body: { sessionId, capability: 'not-the-capability', payload: b64('x') },
    });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe('wrong-capability');
  });

  it('the capability is 32 CSPRNG bytes, and stored ONLY as a hash', async () => {
    const open = await api('/api/crossmodel/imessage/agents/mac-1/brokered-session', {
      method: 'POST',
      headers: { ...USER, ...json },
      body: { windowSec: 600 },
    });
    const { sessionId, capability } = open.body.data;
    expect(capability).toMatch(/^[0-9a-f]{64}$/); // 32 bytes, hex

    // The stored value is the HASH, never the capability itself.
    expect(kv.get(`imsg:relay:cap:${sessionId}`)).toBe(hashRelayCapability(capability));
    expect(kv.get(`imsg:relay:cap:${sessionId}`)).not.toBe(capability);
    // And nothing anywhere in the store holds the plaintext.
    expect([...kv.values()].join('\n')).not.toContain(capability);
  });

  it('refuses an operator request with no JWT at all (401, before any relay logic)', async () => {
    const res = await api('/api/crossmodel/imessage/agents/mac-1/relay/frames?sessionId=s&after=0');
    expect(res.status).toBe(401);
  });

  it('refuses a device presenting no/invalid agent token (401)', async () => {
    await openLiveSession();
    const noToken = await api('/api/crossmodel/imessage/agent/relay/frames?after=0');
    expect(noToken.status).toBe(401);
    const badToken = await api('/api/crossmodel/imessage/agent/relay/frames?after=0', {
      headers: { 'x-agent-token': 'stolen-or-wrong' },
    });
    expect(badToken.status).toBe(401);
  });
});

describe('EVERY REFUSAL PATH refuses rather than carries', () => {
  it('404 no-session when nothing was ever opened', async () => {
    const res = await operatorFrames('ghost', 'whatever', 0);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('no-session');
  });

  it('409 not-open for a grant minted but NEVER consumed — a capability alone is not a session', async () => {
    const open = await api('/api/crossmodel/imessage/agents/mac-1/brokered-session', {
      method: 'POST',
      headers: { ...USER, ...json },
      body: { windowSec: 600 },
    });
    const { sessionId, capability } = open.body.data;

    // NOTE: deliberately NOT consumed via /use.
    const res = await operatorFrames(sessionId, capability, 0);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not-open');
  });

  it('409 not-open once the session is CLOSED, and the frames it queued are gone', async () => {
    const { sessionId, capability } = await openLiveSession();
    await devicePush(b64('PRE-CLOSE'));

    const close = await api('/api/crossmodel/imessage/agents/mac-1/brokered-session', {
      method: 'DELETE',
      headers: USER,
    });
    expect(close.status).toBe(200);

    const res = await operatorFrames(sessionId, capability, 0);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not-open');
    // Closing cleared the transport state, so the last screen frame is not
    // still readable by anyone who kept the capability.
    expect(kv.get(`imsg:relay:q:${sessionId}:to-operator`)).toBeUndefined();
    expect(kv.get(`imsg:relay:cap:${sessionId}`)).toBeUndefined();
  });

  it('409 STALE for a live session that outlived its window — the dangerous shape', async () => {
    const { sessionId, capability } = await openLiveSession();

    // Simulate the passage of time by rewriting the grant as consumed in the
    // past with an already-passed window (the same row the store would hold
    // hours later). This is the ONE state that means "authenticated with nobody
    // behind it", and it must stop carrying IMMEDIATELY.
    const row = JSON.parse(kv.get('imsg:brokered:mac-1')!);
    kv.set(
      'imsg:brokered:mac-1',
      JSON.stringify({
        ...row,
        issuedAt: Date.now() - 7200_000,
        consumedAt: Date.now() - 3600_000,
        expiresAt: Date.now() - 60_000,
      }),
    );

    const res = await operatorFrames(sessionId, capability, 0);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale');

    // And the device cannot push either — a stale session carries nothing.
    const dev = await devicePush(b64('x'));
    expect(dev.status).toBe(409);
    expect(dev.body.code).toBe('stale');
  });

  it('413 frame-too-large refuses an oversized frame instead of carrying it', async () => {
    const { sessionId, capability } = await openLiveSession();
    const big = Buffer.alloc(RELAY_MAX_FRAME_BYTES + 1, 0x41).toString('base64');
    const res = await api('/api/crossmodel/imessage/agents/mac-1/relay/frames', {
      method: 'POST',
      headers: { ...USER, ...json },
      body: { sessionId, capability, payload: big },
    });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('frame-too-large');
  });

  it('400 malformed refuses a non-base64 payload rather than carrying garbage', async () => {
    const { sessionId, capability } = await openLiveSession();
    const res = await api('/api/crossmodel/imessage/agents/mac-1/relay/frames', {
      method: 'POST',
      headers: { ...USER, ...json },
      body: { sessionId, capability, payload: 'this is not base64!!!' },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('malformed');
  });

  it('429 queue-full when the peer is not reading — an honest refusal, never a silent drop', async () => {
    await openLiveSession();
    // Fill the operator's inbox to the cap, then one more.
    for (let i = 0; i < RELAY_QUEUE_MAX_FRAMES; i++) {
      const r = await devicePush(b64(`f${i}`));
      expect(r.status).toBe(200);
    }
    const over = await devicePush(b64('one-too-many'));
    expect(over.status).toBe(429);
    expect(over.body.code).toBe('queue-full');
  });

  it("404 for another user's device id — ownership scoping, indistinguishable from nonexistent", async () => {
    const res = await api('/api/crossmodel/imessage/agents/not-my-mac/relay/frames?sessionId=s&after=0', {
      headers: USER,
    });
    expect(res.status).toBe(404);
  });

  // ── INDEPENDENT REVIEW (2026-11-02), finding D-B ──────────────────────────
  it('REFUSES a capability sent in the URL — a query-string secret is already in an access log', async () => {
    const { sessionId, capability } = await openLiveSession();

    // The first cut took `?capability=`. That is a credential in a URL: it lands
    // in the ALB's and nginx's access logs, any proxy, `Referer`, and browser
    // history — none of which our code controls. This must be REFUSED, not
    // ignored: silently ignoring it would leave the secret logged while the
    // caller debugged something else.
    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/frames?sessionId=${sessionId}&capability=${capability}&after=0`,
      { headers: USER },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability-in-url');
    // And it is refused even though the capability itself is VALID — proving the
    // refusal is about where it travelled, not who was asking.
    const viaHeader = await operatorFrames(sessionId, capability, 0);
    expect(viaHeader.status).toBe(200);
  });

  it('the operator handler reads the capability from the HEADER, and only TOUCHES req.query to refuse it', () => {
    const CTRL_SRC = SRC('backend/src/modules/crossmodel/imessage/imessage.controller.ts');
    const getStart = CTRL_SRC.search(/async getRelayFrames\(req: Request/);
    const devStart = CTRL_SRC.search(/async agentPostRelayFrame\(/);
    expect(getStart).toBeGreaterThan(-1);
    expect(devStart).toBeGreaterThan(getStart);
    const get = CTRL_SRC.slice(getStart, devStart);

    // The capability the gate receives comes from the HEADER.
    expect(get).toMatch(/capability: String\(req\.headers\[RELAY_CAPABILITY_HEADER\]/);

    // `req.query.capability` may appear ONLY inside the refusal guard — never as
    // the value handed to the gate. (Asserting "not present at all" would be
    // wrong: the guard has to look at it in order to refuse it.)
    const queryMentions = get.match(/req\.query\.capability/g) ?? [];
    expect(queryMentions).toHaveLength(1);
    const guardAt = get.search(/req\.query\.capability/);
    const guardWindow = get.slice(Math.max(0, guardAt - 260), guardAt + 260);
    expect(guardWindow).toMatch(/capability-in-url/);
    expect(guardWindow).not.toMatch(/relayGate\(/);

    // And the POST path never sources a capability from the query at all. Its
    // window ends at getRelayFrames, not at the device handler — the GET
    // handler in between legitimately contains the refusal guard.
    const opStart = CTRL_SRC.search(/async postRelayFrame\(req: Request/);
    const getStartAgain = CTRL_SRC.search(/async getRelayFrames\(req: Request/);
    expect(opStart).toBeGreaterThan(-1);
    expect(getStartAgain).toBeGreaterThan(opStart);
    expect(CTRL_SRC.slice(opStart, getStartAgain)).not.toMatch(/req\.query\.capability/);
  });
});

describe('SOURCE PINS — the properties no runtime assertion can make', () => {
  const ROUTES = SRC('backend/src/modules/crossmodel/imessage/imessage.routes.ts');
  const CTRL = SRC('backend/src/modules/crossmodel/imessage/imessage.controller.ts');
  const RELAY = SRC('backend/src/modules/crossmodel/imessage/relay-dataplane.ts');
  const STORE = SRC('backend/src/modules/crossmodel/imessage/relay-dataplane.store.ts');

  /**
   * Locate a region of the controller between two REGEX anchors.
   *
   * Anchors are method declarations found by regex, never a camel-cased name
   * spliced into a string: a window built on a name that does not match yields
   * an EMPTY string, which matches nothing while looking exactly like a failed
   * assertion. (Learned the hard way in the first cut of this file.) The two
   * `expect`s make a miss loud instead of silent.
   */
  const at = (re: RegExp): number => {
    const m = CTRL.match(re);
    expect(m).not.toBeNull();
    return m!.index!;
  };
  const between = (from: RegExp, to: RegExp): string => {
    const a = at(from);
    const b = at(to);
    expect(b).toBeGreaterThan(a);
    return CTRL.slice(a, b);
  };
  const OPEN = /async open\w+\(req: Request/;
  const USE = /async use\w+\(req: Request/;
  const CLOSE = /async close\w+\(req: Request/;
  const OP_POST = /async postRelayFrame\(req: Request/;
  const OP_GET = /async getRelayFrames\(req: Request/;
  const DEV_POST = /async agentPostRelayFrame\(/;
  const DEV_GET = /async agentGetRelayFrames\(/;
  const DISCONNECT = /async disconnect\(req: Request/;

  it('the device relay routes are registered under authenticateAgent, before the JWT routes', () => {
    expect(ROUTES).toMatch(/router\.get\('\/agent\/relay\/frames', authenticateAgent/);
    expect(ROUTES).toMatch(/router\.post\('\/agent\/relay\/frames', authenticateAgent/);
    // Order matters: an agent request must never be asked for a user token, so
    // the agent-token routes are declared ABOVE the first `authenticate` route.
    const firstAgentRelay = ROUTES.indexOf("'/agent/relay/frames'");
    const firstAuthed = ROUTES.indexOf('authenticate,');
    expect(firstAgentRelay).toBeGreaterThan(0);
    expect(firstAgentRelay).toBeLessThan(firstAuthed);
  });

  it('the operator relay routes carry BOTH the JWT guard and the capability gate', () => {
    expect(ROUTES).toMatch(/router\.post\('\/agents\/:id\/relay\/frames', authenticate/);
    expect(ROUTES).toMatch(/router\.get\('\/agents\/:id\/relay\/frames', authenticate/);
    // Every OPERATOR relay handler must consult relayGate (session +
    // capability). A handler that skipped it would carry unauthenticated.
    expect(between(OP_POST, OP_GET)).toMatch(/await relayGate\(/);
    expect(between(OP_GET, DEV_POST)).toMatch(/await relayGate\(/);
    // …and every DEVICE handler must consult the device gate.
    expect(between(DEV_POST, DEV_GET)).toMatch(/await relayDeviceGate\(/);
    expect(between(DEV_GET, DISCONNECT)).toMatch(/await relayDeviceGate\(/);
  });

  it('NO INBOUND LISTENER: the relay opens no server, socket or port of its own', () => {
    // The ruling's core property. A listening socket here would be a
    // permanently open door on every device running this code.
    for (const src of [RELAY, STORE]) {
      expect(src).not.toMatch(/\bcreateServer\b/);
      expect(src).not.toMatch(/\.listen\(/);
      expect(src).not.toMatch(/\bnet\.connect\b/);
      expect(src).not.toMatch(/\bnew WebSocket\b/);
      expect(src).not.toMatch(/\bwss?:\/\//);
      expect(src).not.toMatch(/dgram/);
    }
    // Both peers POLL; neither is ever dialled. The device route is a GET the
    // device initiates, which is what makes "the server never connects to it"
    // structural rather than a promise.
    expect(ROUTES).toMatch(/router\.get\('\/agent\/relay\/frames'/);
  });

  it('opening a session mints a capability, and a mint failure refuses the session', () => {
    const open = between(OPEN, USE);
    expect(open).toMatch(/randomBytes\(RELAY_CAPABILITY_BYTES\)/);
    expect(open).toMatch(/await mintRelayCapability\(/);
    // A session that cannot record its capability can never carry a frame, so
    // reporting success would be a session that is dead at first use.
    expect(open).toMatch(/if \(!minted\)/);
    expect(open).toMatch(/clearRelaySession/);
  });

  it('closing a session clears its transport state in the SAME handler', () => {
    // Anchor on the RELAY DATA PLANE *section header* comment, not the bare
    // phrase — the same words appear in a top-of-file import comment, and
    // matching that one first would produce a backwards window.
    const close = between(CLOSE, /\/\/ ── RELAY DATA PLANE \(ticket/);
    expect(close).toMatch(/await clearRelaySession\(closed\.sessionId\)/);
  });

  it('the sequence number is allocated SERVER-side, never taken from the client', () => {
    // A client-chosen seq would make replay representable and require a
    // dedupe check the receiving side could get wrong. INCR removes the class.
    expect(STORE).toMatch(/redis\.incr\(seqKey\(/);
    expect(STORE).not.toMatch(/args\.seq\b/);
    expect(RELAY).toMatch(/ASSIGNED BY THE SERVER/);
  });

  it('the relay modules take Redis and the logger LAZILY (the 53-suite env trap)', () => {
    // A top-level import of config/redis boots config/env's parseEnv in every
    // suite that reaches the tool registry — measured 2026-11-02: 53 unrelated
    // suites went red with a worker-crash message that named nothing.
    expect(STORE).toMatch(/await import\('\.\.\/\.\.\/\.\.\/config\/redis'\)/);
    expect(STORE).toMatch(/await import\('\.\.\/\.\.\/\.\.\/utils\/logger'\)/);
    expect(STORE).not.toMatch(/^import .*config\/redis/m);
    expect(STORE).not.toMatch(/^import .*utils\/logger/m);
  });

  it('no credential has a slot: the refusal vocabulary never asks for one', () => {
    const reasons = RELAY.match(/RELAY_REFUSAL_REASONS[^;]+;/s)?.[0] ?? '';
    expect(reasons.length).toBeGreaterThan(200);
    expect(reasons).not.toMatch(/enter (your )?password|provide a password|paste .*credential|vnc password/i);
    // And the frame shape is opaque bytes plus a server counter — no field a
    // password could ride in on.
    expect(RELAY).toMatch(/export interface RelayFrame/);
    expect(RELAY).not.toMatch(/^\s*(password|secret|passcode)\s*[?:]/m);
  });

  // ── INDEPENDENT REVIEW (2026-11-02), finding D-A ──────────────────────────
  //
  // The blocking one. The first cut shipped a relay with NO CLIENT: routes,
  // gates, queues — and nothing on earth that ever dialled them. Both agents were
  // grep-clean for "relay". A data plane whose only peer is a test suite is the
  // D1 defect one layer out: "a forwarder + an agent-side dial-out channel" was
  // the request and only the forwarder existed.
  //
  // Pinned per agent, on the REAL source, so a future refactor that drops the
  // pump fails HERE rather than in the field.
  const MACOS_API = SRC('imessage-agent/src/api.ts');
  const MACOS_INDEX = SRC('imessage-agent/src/index.ts');
  const WIN_API = SRC('windows-agent/src/api.ts');
  const WIN_INDEX = SRC('windows-agent/src/index.ts');

  it.each([
    ['macOS', MACOS_API, MACOS_INDEX],
    ['Windows', WIN_API, WIN_INDEX],
  ])('%s agent has a REAL relay dial-out channel, wired into its poll loop', (_os, apiSrc, indexSrc) => {
    // (1) the client actually calls the live routes
    expect(apiSrc).toMatch(/\/crossmodel\/imessage\/agent\/relay\/frames/);
    expect(apiSrc).toMatch(/export async function fetchRelayFrames\(/);
    expect(apiSrc).toMatch(/export async function postRelayFrame\(/);

    // (2) the LOOP calls it — a client nobody calls is not a channel. This is the
    //     assertion the first cut would have failed.
    expect(indexSrc).toMatch(/await pumpRelay\(/);
    expect(indexSrc).toMatch(/from '\.\/api'/);
    expect(indexSrc).toMatch(/\bpumpRelay\b/);
    // …and the drain/ flush both happen inside that pump.
    const pump = indexSrc.slice(indexSrc.indexOf('async function pumpRelay'));
    expect(pump.length).toBeGreaterThan(200);
    expect(pump).toMatch(/await fetchRelayFrames\(/);
    expect(pump).toMatch(/await postRelayFrame\(/);
  });

  it('NO INBOUND PORT on the device either: both agents only ever FETCH out', () => {
    // The ruling's property has to hold on the device side too. If either agent
    // opened a listening socket for the relay, every paired Mac/PC would be a
    // permanently open door — the exact thing option three was chosen to avoid.
    for (const src of [MACOS_API, MACOS_INDEX, WIN_API, WIN_INDEX]) {
      expect(src).not.toMatch(/createServer\(/);
      expect(src).not.toMatch(/\bnet\.createServer\b/);
    }
    // The relay client's only transport is an outbound fetch.
    for (const apiSrc of [MACOS_API, WIN_API]) {
      const relaySection = apiSrc.slice(apiSrc.indexOf('RELAY DATA PLANE'));
      expect(relaySection.length).toBeGreaterThan(500);
      expect(relaySection).toMatch(/await fetch\(/);
      expect(relaySection).not.toMatch(/\.listen\(/);
    }
  });

  it('the DEVICE relay client never puts a capability in a URL (it holds none)', () => {
    for (const apiSrc of [MACOS_API, WIN_API]) {
      const relaySection = apiSrc.slice(apiSrc.indexOf('RELAY DATA PLANE'));
      expect(relaySection).not.toMatch(/capability=/);
      expect(relaySection).not.toMatch(/req\.query\.capability/);
    }
  });
});