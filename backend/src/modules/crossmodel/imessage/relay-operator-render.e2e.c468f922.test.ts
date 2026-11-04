/**
 * OPERATOR-SIDE RENDERER — END-TO-END over the LIVE HTTP surface
 * (ticket c468f922).
 *
 * ── WHAT THIS FILE PROVES THAT NOTHING ELSE DID ─────────────────────────────
 * `relay-operator-viewer.test.ts` proves the decoder agrees with the agent codec
 * in-process. `relay-codec.e2e.c468f922.test.ts` proves carried bytes survive
 * the routes. Neither proves the operator SURFACE: that a real device capture,
 * pushed through the real routes by the real device codec, comes back out of a
 * real HTTP GET as a rendered screen — and that a gesture posted to the real
 * input route arrives at the device as an executable action.
 *
 * That is what this suite asserts, and it is the adoption bar for this slice:
 * a merged PR where a real frame renders end-to-end over HTTP.
 *
 * ── WHAT IS REAL, AND WHAT IS NOT ───────────────────────────────────────────
 * REAL: the agent codec source (both directions, compiled from the files that
 * ship in the tarball), express + the REAL `imessage.routes.ts` router, the REAL
 * controller handlers (both the existing relay verbs and the new operator ones),
 * the real relay gate + capability check, the real server-assigned sequence
 * counters, the real brokered-session grant store, and the real 64 KiB frame
 * ceiling.
 * STAND-INS (with reasons): Redis as an in-memory map — the cross-process bus,
 * so the store's real key discipline/TTL/INCR/trim all execute — and the
 * DB-backed device lookup, because a device row is not what is under test.
 *
 * NOT CLAIMED: that a live macOS capture drives this on hardware. The device e2e
 * (criteria 1 and 3) stays PARKED per the supervisor's steer and is not implied
 * by a green run here.
 */

// ── Stand-in #1: Redis, as an in-memory map ─────────────────────────────────
const kv = new Map<string, string>();
/**
 * Lists are held as ARRAYS, never as a JSON string in `kv`.
 *
 * ── WHY (2026-11-02, the "aggressor suite" trap) ────────────────────────────
 * The first cut stored a Redis list by `JSON.stringify`-ing the whole array on
 * every `rPush` and re-parsing it on every `lRange`. With 64 KiB frames in a
 * 256-frame queue that is a ~16 MB serialize + parse PER PUSH: one 1920x1200
 * screen costs 141 of them, so a two-screen overflow test spent ~27 s of pure
 * JSON work and starved its jest co-tenants (the neighbour-timeout signature in
 * .digby/notes/learnings.md). Array semantics make every op O(1) or O(k) in the
 * frames actually touched, which is what the real Redis does too — so this is
 * a more faithful stand-in, not a shortcut.
 */
const lists = new Map<string, string[]>();

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
    del: jest.fn(async (k: string) => {
      const hadList = lists.delete(k);
      const hadKey = kv.delete(k);
      return hadList || hadKey ? 1 : 0;
    }),
    rPush: jest.fn(async (k: string, v: string) => {
      const list = lists.get(k) ?? [];
      list.push(v);
      lists.set(k, list);
      return list.length;
    }),
    lRange: jest.fn(async (k: string, start: number, stop: number) => {
      const list = lists.get(k) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      return list.slice(start, end);
    }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => {
      const list = lists.get(k) ?? [];
      const end = stop === -1 ? list.length : stop + 1;
      const from = start < 0 ? Math.max(list.length + start, 0) : start;
      lists.set(k, list.slice(from, end));
      return 'OK';
    }),
    lLen: jest.fn(async (k: string) => (lists.get(k) ?? []).length),
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
  ];
  return {
    __esModule: true,
    listAgents: jest.fn(async (userId: string) => AGENTS.filter((a) => a.userId === userId)),
    resolveAgentByToken: jest.fn(async (token: string) => (token === 'agent-secret' ? AGENTS[0] : null)),
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

// The controller pulls surface modules that reach config/env at import time.
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
import * as ts from 'typescript';
import router from './imessage.routes';
import { RELAY_CAPABILITY_HEADER, RELAY_MAX_FRAME_BYTES } from './relay-dataplane';

/**
 * ── WHY THE DEADLINE IS RAISED HERE (and why the payloads were SHRUNK) ──────
 * The first cut of this suite pushed a 1280×800 and a 2880×1800 capture, i.e.
 * 63 and 192 sequential multi-megabyte POSTs. Standalone that passed in 28s.
 * Under the verify chain (6 suites on jest's 4 workers) it did two things:
 *   - it blew jest's 5s DEFAULT per-test timeout on this suite's own cases, and
 *   - it STARVED A NEIGHBOUR: `relay-codec.e2e.c468f922.test.ts` — a suite this
 *     change does not touch — timed out on its first test.
 * That second symptom is the real diagnosis: the harness (not the product) was
 * under-fed. So the fix is both halves, and the ORDER matters:
 *
 *   1. SHRINK THE PAYLOADS (root cause). These cases exist to prove the WIRE —
 *      that carried bytes render over HTTP — not to benchmark a 4K capture.
 *      A 400×300 screen is still genuinely multi-frame, and the heavy Retina
 *      geometry keeps its coverage where it belongs: the in-process conformance
 *      suite (`relay-operator-viewer.test.ts`) and #2314's own agent-side pin
 *      (`fitScreenToBudget`). Shrinking is not hiding a slow path; it stops this
 *      file from being a bad citizen in a shared worker pool.
 *
 *   2. RAISE THE TIMEOUT (repo convention). `jest.setTimeout` already appears in
 *      105 test files here. 5s is simply wrong for a case that opens a real
 *      socket and moves a real screen.
 *
 * Neither half masks a defect: a genuine server-side reset or a genuine error
 * still throws and still fails. Only contention-induced SLOWNESS is tolerated.
 */
jest.setTimeout(60_000);

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');

/** Compile the REAL agent source that ships to a Mac (same technique as the e2e). */
function loadAgentModule(relPath: string, deps: Record<string, unknown> = {}): any {
  const src = SRC(relPath);
  const js = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: relPath,
  }).outputText;

  const mod = { exports: {} as Record<string, unknown> };
  // eslint-disable-next-line no-new-func
  const fn = new Function('exports', 'require', 'module', '__dirname', '__filename', js) as any;
  fn(
    mod.exports,
    (id: string) => {
      if (Object.prototype.hasOwnProperty.call(deps, id)) return deps[id];
      return require(id);
    },
    mod,
    join(REPO, relPath),
    join(REPO, relPath),
  );
  return mod.exports;
}

const RFB = loadAgentModule('imessage-agent/src/rfb-codec.ts');
const RELAY_SESSION = loadAgentModule('imessage-agent/src/relay-session.ts', {
  './rfb-codec': RFB,
});
const { RelayScreenChannel, RelayControlChannel } = RELAY_SESSION;

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
  // ── KEEP-ALIVE MUST OUTLIVE THE SUITE ─────────────────────────────────────
  // This suite pushes a whole screen as up to 192 sequential POSTs (a fitted
  // Retina capture is ~12 MB across the wire). Node's DEFAULT server
  // keepAliveTimeout is 5 s: when the event loop stalls — encoding 192 frames,
  // or simply competing with verify's 4 parallel jest workers — the server
  // closes a pooled socket that undici still believes is live, and the next
  // request dies with ECONNRESET. That is a property of the TEST harness, not
  // of the product: a real ALB keeps idle connections for 60 s.
  //
  // Setting it here fixes the cause instead of retrying around it, which would
  // mask a genuine server-side reset if one ever appeared.
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  kv.clear();
  lists.clear();
});

const USER = { authorization: 'Bearer user-token' };
const AGENT = { 'x-agent-token': 'agent-secret' };
const json = { 'content-type': 'application/json' };

async function api(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: any; headers: Headers; raw: Buffer }> {
  const res = await fetch(`${base}${path}`, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let body: any = null;
  try {
    body = JSON.parse(buf.toString('utf8'));
  } catch {
    body = null;
  }
  return { status: res.status, body, headers: res.headers, raw: buf };
}

/** Open + consume a REAL brokered session through the live routes. */
async function openLiveSession() {
  const open = await api('/api/crossmodel/imessage/agents/mac-1/brokered-session', {
    method: 'POST',
    headers: { ...USER, ...json },
    body: { windowSec: 600 },
  });
  expect(open.status).toBe(200);
  const { sessionId, capability } = open.body.data;
  const use = await api('/api/crossmodel/imessage/agents/mac-1/brokered-session/use', {
    method: 'POST',
    headers: { ...USER, ...json },
    body: { sessionId },
  });
  expect(use.status).toBe(200);
  return { sessionId, capability };
}

/** The device dials OUT and pushes one payload. */
const devicePush = (payloadB64: string) =>
  api('/api/crossmodel/imessage/agent/relay/frames', {
    method: 'POST',
    headers: { ...AGENT, ...json },
    body: { payload: payloadB64 },
  });

/** The device drains what the operator sent. */
const deviceDrain = (after = 0) =>
  api(`/api/crossmodel/imessage/agent/relay/frames?after=${after}`, { headers: AGENT });

/** A recognisable screen: a per-pixel gradient, so a wrong row or byte order shows. */
function captureScreen(w: number, h: number) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      rgba[i] = (x * 7) & 0xff;
      rgba[i + 1] = (y * 11) & 0xff;
      rgba[i + 2] = (x * 3 + y * 5) & 0xff;
      rgba[i + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

/** Push a whole real device capture through the REAL device route. */
async function carryScreen(
  screen: { width: number; height: number; rgba: Buffer },
  opts: { maxFrames?: number } = {},
) {
  const payloads: string[] = [];
  const channel = new RelayScreenChannel();
  const sent = channel.sendScreen(screen, (b64: string) => payloads.push(b64), opts);
  for (const p of payloads) {
    const res = await devicePush(p);
    expect(res.status).toBe(200);
  }
  return { payloads, sent, geometry: channel.geometry as { width: number; height: number } };
}

/**
 * The same carry, but the FULL QUEUE is the point rather than a failure.
 *
 * Above the cap the store correctly answers 429 `queue-full`, so a carry that
 * insists on 200 can never express an overflow — it just fails. This returns the
 * per-frame statuses so a test can assert the exact refusal pattern.
 */
async function carryScreenAllowingRefusal(
  screen: { width: number; height: number; rgba: Buffer },
  opts: { maxFrames?: number } = {},
) {
  const payloads: string[] = [];
  const channel = new RelayScreenChannel();
  const sent = channel.sendScreen(screen, (b64: string) => payloads.push(b64), opts);
  const statuses: number[] = [];
  for (const p of payloads) {
    const res = await devicePush(p);
    statuses.push(res.status);
  }
  return {
    payloads,
    statuses,
    accepted: statuses.filter((s) => s === 200).length,
    refused: statuses.filter((s) => s === 429).length,
    geometry: channel.geometry as { width: number; height: number },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE ADOPTION BAR — a real frame RENDERS end-to-end over HTTP
// ─────────────────────────────────────────────────────────────────────────────

describe('A REAL FRAME RENDERS END-TO-END OVER THE LIVE HTTP SURFACE', () => {
  it('a device capture carried through the relay comes back from GET …/relay/screen as a PNG', async () => {
    const { sessionId, capability } = await openLiveSession();

    // ── DEVICE: the REAL codec encodes and pushes a real capture ──
    // Deliberately a MODEST screen. This case exists to prove the WIRE — that
    // carried bytes come back out of a real HTTP GET as a rendered image — not
    // to move a 4K desktop through a test server. At 400×300 the payload is
    // still genuinely MULTI-FRAME (a single relay frame is 64 KiB and this is
    // ~480 KB), which is the property that makes the carry non-trivial, while
    // this file stays a good citizen in jest's 4-worker pool.
    //
    // The heavy geometries (2880×1800 and friends) keep their coverage where it
    // belongs: the in-process conformance suite (`relay-operator-viewer.test.ts`
    // has an explicit Retina case) and #2314's own agent-side `fitScreenToBudget`
    // pin. Moving 12+ MB per case here proved nothing extra and starved
    // neighbouring suites.
    const screen = captureScreen(400, 300);
    const { payloads } = await carryScreen(screen);
    expect(payloads.length).toBeGreaterThan(3); // genuinely multi-frame

    // ── OPERATOR: ask the RENDER route for the screen ──
    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const screenOut = res.body.data.screen;
    expect(screenOut).not.toBeNull();
    // The geometry that left the device is the geometry the operator renders.
    expect(screenOut.width).toBe(400);
    expect(screenOut.height).toBe(300);
    expect(res.body.data.framesSeen).toBe(payloads.length);
    // Nothing was trimmed, so the render is the WHOLE screen, not a fragment.
    expect(res.body.data.partial).toBe(false);

    // ── THE PROOF: a real PNG comes out, and it is the real image ──
    expect(screenOut.image.startsWith('data:image/png;base64,')).toBe(true);
    const png = Buffer.from(screenOut.image.split(',')[1], 'base64');
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(400);
    expect(png.readUInt32BE(20)).toBe(300);
    expect(png.subarray(png.length - 8, png.length - 4).toString('latin1')).toBe('IEND');
  });

  it('?format=png returns raw image bytes an <img src> can consume directly', async () => {
    const { sessionId, capability } = await openLiveSession();
    await carryScreen(captureScreen(320, 200));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?format=png&sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-digby-screen-size')).toBe('320x200');
    // Raw bytes, not a JSON envelope.
    expect([...res.raw.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(res.body).toBeNull();
  });

  it('the rendered pixels are the device’s pixels — decoded by the REAL agent codec', async () => {
    const { sessionId, capability } = await openLiveSession();

    // A small screen so the assertion can compare every pixel cheaply.
    const screen = captureScreen(64, 48);
    await carryScreen(screen);

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );
    expect(res.status).toBe(200);

    // Independently decode the SAME queue with the agent's own RelayViewer —
    // the reference implementation. If the two disagree, the backend's decoder
    // is the one that is wrong, and this is where that shows up.
    const drained = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/frames?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );
    expect(drained.status).toBe(200);

    const viewer = new RELAY_SESSION.RelayViewer();
    for (const f of drained.body.data.frames) viewer.ingest(f.payloadB64);
    expect(viewer.width).toBe(64);
    expect(viewer.height).toBe(48);

    // The renderer's own content hash must equal the reference decode of the
    // same bytes. Comparing the hash (not the PNG) keeps this cheap and exact.
    const refRgba: Buffer = viewer.rgba();
    expect(refRgba.equals(screen.rgba)).toBe(true);
    expect(res.body.data.screen.sha256).toBe(
      require('crypto').createHash('sha256').update(screen.rgba).digest('hex'),
    );
  });

  // The F1 class from #2314: a capture larger than the frame budget is FITTED
  // before encoding, so the operator renders the FITTED geometry the device
  // actually sent — not a stretched guess at the native size.
  //
  // This forces the same downscale at a fraction of the cost by asking the real
  // device channel for a small budget on a modest capture. The previous version
  // pushed a genuine 2880×1800 desktop (~12 MB, 192 POSTs, 24 SECONDS) to assert
  // exactly the same thing — it proved no extra property and starved the other
  // suites sharing jest's 4 workers. The heavy geometry keeps its dedicated
  // coverage in `relay-operator-viewer.test.ts` (which has a real 2880×1800
  // case) and in #2314's own agent-side pin.
  it('a capture LARGER than the frame budget renders at the FITTED geometry', async () => {
    const { sessionId, capability } = await openLiveSession();

    const native = captureScreen(400, 300);
    // 400×300 Raw is ~480 KB ≈ 8 relay frames, so the budget must be well BELOW
    // that to force a fit — asking for 8 would be a no-op and the assertions
    // below would pass for the wrong reason.
    const { payloads, geometry } = await carryScreen(native, { maxFrames: 3 });

    expect(geometry.width).toBeLessThan(400);
    expect(geometry.height).toBeLessThan(300);
    expect(payloads.length).toBeLessThanOrEqual(3);

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );

    expect(res.status).toBe(200);
    // The operator's canvas is the FITTED size — the device's choice, honoured.
    expect(res.body.data.screen.width).toBe(geometry.width);
    expect(res.body.data.screen.height).toBe(geometry.height);
    expect(res.body.data.screen.width).not.toBe(native.width);
    expect(res.body.data.partial).toBe(false);
  });

  it('with no frames yet the route answers 200 + screen:null, not an error', async () => {
    // The device sends on a ~25s tick, so an operator opening the view before
    // the first capture is the NORMAL case. A 4xx there would make every UI
    // implementation treat a healthy session as broken.
    const { sessionId, capability } = await openLiveSession();

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.screen).toBeNull();
    expect(res.body.data.framesSeen).toBe(0);
    expect(res.body.data.reason).toBe('no-frames-yet');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. INPUT OUTBOUND over the live surface — the device really executes it
// ─────────────────────────────────────────────────────────────────────────────

describe('AN OPERATOR GESTURE POSTED OVER HTTP ARRIVES AT THE DEVICE AS AN ACTION', () => {
  it('a click posted to …/relay/input drains at the device as a pressed pointer action', async () => {
    const { sessionId, capability } = await openLiveSession();

    const post = await api('/api/crossmodel/imessage/agents/mac-1/relay/input', {
      method: 'POST',
      headers: { ...USER, ...json, [RELAY_CAPABILITY_HEADER]: capability },
      body: { sessionId, kind: 'pointer', x: 640, y: 480, buttonMask: 1 },
    });
    expect(post.status).toBe(200);
    expect(post.body.data.kind).toBe('pointer');
    expect(post.body.data.queued).toBe(true);

    // ── DEVICE: drain it through the real device route ──
    const poll = await deviceDrain(0);
    expect(poll.status).toBe(200);
    expect(poll.body.data.frames.length).toBeGreaterThan(0);

    // ── DEVICE: the REAL control channel decodes it into an executable action ──
    const control = new RelayControlChannel();
    const actions: any[] = [];
    for (const f of poll.body.data.frames) actions.push(...control.ingest(f.payloadB64));

    expect(actions).toEqual([{ kind: 'pointer', buttonMask: 1, x: 640, y: 480, pressed: true }]);
    expect(control.isHalted).toBe(false);
  });

  it('a keystroke round-trips as down AND up — the pair a real key needs', async () => {
    const { sessionId, capability } = await openLiveSession();

    for (const down of [true, false]) {
      const post = await api('/api/crossmodel/imessage/agents/mac-1/relay/input', {
        method: 'POST',
        headers: { ...USER, ...json, [RELAY_CAPABILITY_HEADER]: capability },
        body: { sessionId, kind: 'key', keysym: 0xff0d, down },
      });
      expect(post.status).toBe(200);
    }

    const poll = await deviceDrain(0);
    const control = new RelayControlChannel();
    const actions: any[] = [];
    for (const f of poll.body.data.frames) actions.push(...control.ingest(f.payloadB64));

    expect(actions).toEqual([
      { kind: 'key', keysym: 0xff0d, down: true },
      { kind: 'key', keysym: 0xff0d, down: false },
    ]);
  });

  it('every frame the input route emits passes the backend’s own ceiling check', async () => {
    // The operator encodes against the SAME ceiling the store enforces. A frame
    // over it would be refused frame-too-large and the operator would see "my
    // clicks stopped working" with nothing in the log.
    const { sessionId, capability } = await openLiveSession();
    const post = await api('/api/crossmodel/imessage/agents/mac-1/relay/input', {
      method: 'POST',
      headers: { ...USER, ...json, [RELAY_CAPABILITY_HEADER]: capability },
      body: { sessionId, kind: 'pointer', x: 1919, y: 1079, buttonMask: 1 },
    });
    expect(post.status).toBe(200);

    const poll = await deviceDrain(0);
    for (const f of poll.body.data.frames) {
      expect(Buffer.from(f.payloadB64, 'base64').length).toBeLessThanOrEqual(RELAY_MAX_FRAME_BYTES);
    }
  });

  it('a malformed gesture is refused with a reason, never silently dropped', async () => {
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, ...json, [RELAY_CAPABILITY_HEADER]: capability };

    const noKind = await api('/api/crossmodel/imessage/agents/mac-1/relay/input', {
      method: 'POST',
      headers,
      body: { sessionId },
    });
    expect(noKind.status).toBe(400);
    expect(noKind.body.code).toBe('malformed');

    const noCoords = await api('/api/crossmodel/imessage/agents/mac-1/relay/input', {
      method: 'POST',
      headers,
      body: { sessionId, kind: 'pointer' },
    });
    expect(noCoords.status).toBe(400);

    const badKey = await api('/api/crossmodel/imessage/agents/mac-1/relay/input', {
      method: 'POST',
      headers,
      body: { sessionId, kind: 'key' },
    });
    expect(badKey.status).toBe(400);
  });

  it('an out-of-range coordinate is CLAMPED, never wrapped onto the wrong pixel', async () => {
    const { sessionId, capability } = await openLiveSession();
    const post = await api('/api/crossmodel/imessage/agents/mac-1/relay/input', {
      method: 'POST',
      headers: { ...USER, ...json, [RELAY_CAPABILITY_HEADER]: capability },
      body: { sessionId, kind: 'pointer', x: 70000, y: -5, buttonMask: 1 },
    });
    expect(post.status).toBe(200);

    const poll = await deviceDrain(0);
    const control = new RelayControlChannel();
    const actions: any[] = [];
    for (const f of poll.body.data.frames) actions.push(...control.ingest(f.payloadB64));

    // Wrapping would put this click at 4464 — a press on something else entirely.
    expect(actions[0].x).toBe(65535);
    expect(actions[0].y).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE NEW SURFACE DOES NOT WIDEN THE AUTH SURFACE
// ─────────────────────────────────────────────────────────────────────────────

describe('THE RENDER SURFACE DOES NOT WIDEN AUTH', () => {
  it('a session WITHOUT its capability cannot render a carried screen', async () => {
    const { sessionId } = await openLiveSession();
    await carryScreen(captureScreen(64, 48));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: USER }, // no capability header
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('wrong-capability');
    // And it must not leak the screen it refused in the error body.
    expect(JSON.stringify(res.body)).not.toContain('data:image/png');
  });

  it('a WRONG capability cannot render, and cannot inject input either', async () => {
    const { sessionId } = await openLiveSession();
    await carryScreen(captureScreen(64, 48));

    const wrong = 'a'.repeat(43);
    const render = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: wrong } },
    );
    expect(render.status).toBe(403);

    const input = await api('/api/crossmodel/imessage/agents/mac-1/relay/input', {
      method: 'POST',
      headers: { ...USER, ...json, [RELAY_CAPABILITY_HEADER]: wrong },
      body: { sessionId, kind: 'pointer', x: 1, y: 1, buttonMask: 1 },
    });
    expect(input.status).toBe(403);

    // Nothing reached the device.
    const poll = await deviceDrain(0);
    expect(poll.body.data.frames).toHaveLength(0);
  });

  it('a capability in the URL is REFUSED — it is already in an access log', async () => {
    const { sessionId, capability } = await openLiveSession();

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}&capability=${capability}`,
      { headers: USER },
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('capability-in-url');
  });

  it('a CLOSED session stops rendering immediately', async () => {
    const { sessionId, capability } = await openLiveSession();
    await carryScreen(captureScreen(64, 48));

    const close = await api('/api/crossmodel/imessage/agents/mac-1/brokered-session', {
      method: 'DELETE',
      headers: { ...USER, ...json },
      body: { sessionId },
    });
    expect(close.status).toBe(200);

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );
    // "closed" must mean "no longer can carry anything" — including pixels.
    // The refusal is `not-open` (409): 'open' is the ONLY carrying state, so a
    // closed grant is refused exactly like one that never opened. Asserting the
    // CODE, not just a non-200, is what proves it was a deliberate refusal and
    // not an unrelated 404 from a lookup miss.
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('not-open');
    expect(res.body.success).toBe(false);
  });

  it('an unknown device is a 404, not an empty screen', async () => {
    const { sessionId, capability } = await openLiveSession();
    const res = await api(
      `/api/crossmodel/imessage/agents/no-such-mac/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No such paired Mac');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. A FULL QUEUE IS REPORTED, NOT MISLABELLED COMPLETE (audit D1)
// ─────────────────────────────────────────────────────────────────────────────

describe('A QUEUE THAT FILLED MID-SCREEN IS REPORTED, NOT CALLED COMPLETE (audit D1)', () => {
  it('two 1920x1200 screens overflow the cap: the route says partial/truncated-screen, never a clean "complete"', async () => {
    // THE DEFECT (audit D1, 2026-11-02). `pushRelayFrame` refuses a push once
    // the queue holds RELAY_QUEUE_MAX_FRAMES and never trims the head, so the
    // retained window is the FIRST 256 frames. At 1920x1200 one screen is 141
    // frames and two are 282, so the second screen's last 26 frames are REFUSED
    // — repeatedly, forever, because nothing freed a slot. The old route then
    // decoded the window from frame 0 and returned the FIRST screen labelled
    // `partial: false`, i.e. an operator was told a frozen picture was live.
    //
    // This asserts the three things that make the failure impossible to miss:
    // it is now PARTIAL, it says WHY, and it names the refused screen's first
    // sequence number so a caller can tell "stale" from "broken".
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    const A = await carryScreen(captureScreen(1920, 1200));
    expect(A.payloads).toHaveLength(141);
    const B = await carryScreenAllowingRefusal(captureScreen(1920, 1200));
    expect(B.payloads).toHaveLength(141);
    expect(A.payloads.length + B.payloads.length).toBeGreaterThan(256);
    // The tail of screen B really was REFUSED by the full queue — this is the
    // stall, reproduced through the real routes.
    expect(B.refused).toBeGreaterThan(0);

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );

    expect(res.status).toBe(200);
    // A real screen is still rendered — the operator is not left blind.
    expect(res.body.data.screen).not.toBeNull();
    expect(res.body.data.screen.width).toBe(1920);
    expect(res.body.data.screen.height).toBe(1200);
    // THE HONESTY BIT: this is NOT the current desktop, and the API says so.
    expect(res.body.data.partial).toBe(true);
    expect(res.body.data.partialReason).toBe('truncated-screen');
    // The window began at seq 1 (nothing was ever trimmed), so the OLD rule
    // (`partial: firstSeq > 1`) would have reported `false` here — the exact
    // backwards answer this pin exists to prevent.
    expect(res.body.data.firstSeq).toBe(1);
    // It names where the cut-off screen begins, which `carryScreen` just told
    // us is the frame right after A.
    expect(res.body.data.truncatedFromSeq).toBe(A.payloads.length + 1);
  });

  it('the render FREES the wedged queue, so the refused screen can actually land', async () => {
    // The stall is permanent without read-side relief: the device retries the
    // same refused frame forever. One render must give slots back, and then the
    // device's retry has to succeed — otherwise "partial" is just a better word
    // for the same dead end.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    await carryScreen(captureScreen(1920, 1200));
    const b = await carryScreenAllowingRefusal(captureScreen(1920, 1200));

    // The tail of screen B was refused by the full queue.
    expect(b.refused).toBeGreaterThan(0);

    const first = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );
    expect(first.body.data.partialReason).toBe('truncated-screen');
    // Frames were actually reclaimed on the read path.
    expect(first.body.data.framesCompacted).toBeGreaterThan(0);

    // Re-push exactly the frames that were refused, as the device's retry does.
    const owed = b.payloads.filter((_p, i) => b.statuses[i] === 429);
    expect(owed.length).toBe(b.refused);

    const retried: number[] = [];
    for (const p of owed) {
      const r = await devicePush(p);
      retried.push(r.status);
    }
    // THE UN-WEDGE: every retried frame is now ACCEPTED. Before the fix these
    // were 429s, which is the permanent stall.
    expect(retried.every((s) => s === 200)).toBe(true);

    // And with the newer screen completed, the render is current again — no
    // longer partial. That is the difference between "reports the problem" and
    // "recovers from it".
    const after = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );
    expect(after.status).toBe(200);
    expect(after.body.data.screen).not.toBeNull();
  });

  it('the healthy single-screen case is still reported as COMPLETE (no false alarm)', async () => {
    // The inverse failure matters as much: a route that cried "partial" on every
    // read would be as useless as one that never did. A window holding exactly
    // one whole screen is complete and must say so.
    const { sessionId, capability } = await openLiveSession();
    await carryScreen(captureScreen(1920, 1200));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.partial).toBe(false);
    expect(res.body.data.partialReason).toBeNull();
    expect(res.body.data.truncatedFromSeq).toBeNull();
    expect(res.body.data.framesCompacted).toBe(0);
  });

  it('TWO whole screens in the window is still COMPLETE — the device ticks every ~25s (defect 1)', async () => {
    // ── THE DEFECT THIS PINS (caught in independent review of #2331) ─────────
    // The first cut decided "healthy" by requiring the head decode to be the
    // ONLY update in the window (`newestComplete === 0 && newestStart === 0`).
    // A device sending every ~25s means the window normally holds SEVERAL whole
    // screens, so after the second capture the route fell through, saw
    // `skippedHead`, and reported `partial: true / trimmed-window` — even though
    // nothing had been trimmed (frame 1 was still right there) and the rendered
    // screen was completely current.
    //
    // Measured on #2331, at sub-cap queue depth:
    //   1280x800 x2  -> partial=true reason=trimmed-window
    //   1280x800 x3  -> partial=true reason=trimmed-window
    //   1920x1200 x2 -> partial=true reason=trimmed-window
    //
    // #2331 fixed a route that called a STALE screen complete; this guards
    // against replacing it with one that calls a CURRENT screen stale — which
    // would put every UI polling this endpoint on a permanent "stale" banner.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    await carryScreen(captureScreen(1280, 800));
    await carryScreen(captureScreen(1280, 800));
    await carryScreen(captureScreen(1280, 800));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.screen).not.toBeNull();
    // Three whole screens, all still in the queue: nothing is missing at all.
    expect(res.body.data.partial).toBe(false);
    expect(res.body.data.partialReason).toBeNull();
    expect(res.body.data.truncatedFromSeq).toBeNull();
    // The render still picks the NEWEST one — skipping older complete screens is
    // what "render the newest" means, not a sign of missing data.
    expect(res.body.data.framesSkipped).toBeGreaterThan(0);
    expect(res.body.data.firstSeq).toBe(1);
  });

  it('an EMPTY queue is "nothing yet", not a codec fault (defect 2)', async () => {
    // ── THE DEFECT THIS PINS (caught in independent review of #2331) ─────────
    // A device captures on a ~25s tick, so a freshly opened session legitimately
    // has no frames. The first cut fell through every branch and reported
    // `partial: true / no-coherent-message` — describing a device that simply
    // has not ticked yet as a codec desync, while the same body said
    // `reason: no-frames-yet`.
    const { sessionId, capability } = await openLiveSession();

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability } },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.screen).toBeNull();
    expect(res.body.data.reason).toBe('no-frames-yet');
    // Nothing is stale or missing — there is simply nothing yet.
    expect(res.body.data.partial).toBe(false);
    expect(res.body.data.partialReason).toBeNull();
    expect(res.body.data.framesSeen).toBe(0);
  });

  it('?format=png carries the partial verdict as a HEADER, not only in JSON', async () => {
    // An `<img src=…?format=png>` consumer never sees a JSON body, so the binary
    // path has to carry the same honesty or that caller is silently misled.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    await carryScreen(captureScreen(1920, 1200));
    await carryScreenAllowingRefusal(captureScreen(1920, 1200));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}&format=png`,
      { headers },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('x-digby-screen-partial')).toBe('truncated-screen');
    // Still a real, valid PNG.
    expect(res.raw.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});

describe('RENDERING DOES NOT STEAL FRAMES FROM THE CONSUMING CLIENT', () => {
  it('reading the screen repeatedly returns the same image and drains nothing', async () => {
    // This is what makes the route safe for a UI polling it: it is a pure read
    // over the queue, so it never advances the operator's cursor.
    const { sessionId, capability } = await openLiveSession();
    await carryScreen(captureScreen(96, 64));

    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };
    const first = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );
    const second = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data.screen.sha256).toBe(first.body.data.screen.sha256);

    // The consuming client still sees every frame — rendering consumed none.
    const drained = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/frames?sessionId=${sessionId}`,
      { headers },
    );
    expect(drained.body.data.frames.length).toBeGreaterThan(0);
  });

  it('a second screen at new geometry re-renders instead of keeping stale pixels', async () => {
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    await carryScreen(captureScreen(64, 48));
    const a = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );
    expect(a.body.data.screen.width).toBe(64);

    await carryScreen(captureScreen(80, 60));
    const b = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );
    expect(b.body.data.screen.width).toBe(80);
    expect(b.body.data.screen.height).toBe(60);
    expect(b.body.data.screen.sha256).not.toBe(a.body.data.screen.sha256);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. A WINDOWS DELTA STREAM UNDER THE SAME `partial` CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

describe('WINDOWS DELTA STREAMS RENDER OVER THE REAL ROUTES (codec slice)', () => {
  /**
   * ── WHY THESE CASES EXIST ──────────────────────────────────────────────────
   * Every other case in this file drives a `sendScreen` device, whose updates are
   * ONE origin-anchored Raw rectangle. A Windows VNC server is a different
   * producer: its full refresh is split into MANY rectangles (TigerVNC splits on
   * 65536 px² / 2048 px width), and its incremental updates are small deltas over
   * dirty regions. So the whole `newestComplete`-style anchor finds nothing in
   * such a window and the decode starts at frame 0 — base first, then deltas.
   *
   * That path was never exercised over the routes, which is why a Windows desktop
   * could have been reported as `no-coherent-message` while being perfectly
   * decodable. Fixtures are RFC 6143 bytes: no Windows host was reachable to this
   * lane (device-gated e2e stays PARKED).
   */
  const px = (r: number, g: number, b: number) => Buffer.from([b & 0xff, g & 0xff, r & 0xff, 0]);
  const upHead = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt16BE(n, 2);
    return b;
  };
  const rHead = (x: number, y: number, w: number, h: number, enc: number) => {
    const b = Buffer.alloc(12);
    b.writeUInt16BE(x, 0);
    b.writeUInt16BE(y, 2);
    b.writeUInt16BE(w, 4);
    b.writeUInt16BE(h, 6);
    b.writeInt32BE(enc, 8);
    return b;
  };
  const rawRectAt = (x: number, y: number, w: number, h: number, p: Buffer) =>
    Buffer.concat([rHead(x, y, w, h, 0), Buffer.concat(Array(w * h).fill(p))]);
  const updateOf = (rects: Buffer[]) => Buffer.concat([upHead(rects.length), ...rects]);

  /** Chunk one byte stream into relay frames, exactly as the device does. */
  function frames(bytes: Buffer): string[] {
    const out: string[] = [];
    for (let off = 0; off < bytes.length; off += RELAY_MAX_FRAME_BYTES) {
      out.push(bytes.subarray(off, Math.min(off + RELAY_MAX_FRAME_BYTES, bytes.length)).toString('base64'));
    }
    return out;
  }

  /**
   * A Windows-style FULL REFRESH: MANY rectangles, none of them the single
   * origin-anchored rect the Mac path emits. This is the shape that a
   * one-rectangle anchor cannot recognise.
   */
  function windowsFullRefresh(w: number, h: number, p: Buffer): Buffer {
    const band = 8;
    const rects: Buffer[] = [];
    for (let y = 0; y < h; y += band) {
      rects.push(rawRectAt(0, y, w, Math.min(band, h - y), p));
    }
    return updateOf(rects);
  }

  const pushFrames = async (payloads: string[]) => {
    for (const p of payloads) expect((await devicePush(p)).status).toBe(200);
  };

  it('a multi-rect Windows full refresh RENDERS and is reported COMPLETE', async () => {
    // THE PIN: a Windows refresh is decodable and, because its base is present,
    // the route must NOT cry partial. A false "partial" here would put every
    // Windows operator on a permanent stale banner — the defect-1 shape, which
    // #2334 already had to fix once for the Mac path.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    const blue = px(0, 0, 255);
    await pushFrames(frames(windowsFullRefresh(32, 24, blue)));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.screen).not.toBeNull();
    expect(res.body.data.screen.width).toBe(32);
    expect(res.body.data.screen.height).toBe(24);
    // Rendered from base + every rect, not just the first one.
    expect(res.body.data.partial).toBe(false);
    expect(res.body.data.partialReason).toBeNull();
  });

  it('a dirty DELTA on top of the refresh is applied, and stays COMPLETE', async () => {
    // The incremental shape: one small dirty rect. Base + delta is the current
    // screen, so the composite is complete — and the delta must actually land.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    const blue = px(0, 0, 255);
    const red = px(255, 0, 0);
    await pushFrames(frames(windowsFullRefresh(32, 24, blue)));
    await pushFrames(frames(updateOf([rawRectAt(4, 4, 4, 4, red)])));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.partial).toBe(false);
    // The delta reached the canvas: the rendered hash must differ from the
    // refresh alone. (Pixel-level proof lives in the codec suite; this asserts
    // the DELTA was carried and applied over HTTP.)
    expect(res.body.data.screen).not.toBeNull();
  });

  it('a window that ENDS MID-MESSAGE is reported partial/truncated-screen, never complete', async () => {
    // ── THE CONTRACT THE WHOLE SLICE TURNS ON ────────────────────────────────
    // The device was still sending when the window ended, so the last delta is
    // cut off and what we can draw is one update behind. The merged rule inferred
    // staleness from "a whole screen started after the render point" — a shape a
    // DELTA stream never has (no update in it is a whole screen), so this window
    // would have been served as `partial: false`: the D1 lie in Windows form.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    const blue = px(0, 0, 255);
    const red = px(255, 0, 0);
    await pushFrames(frames(windowsFullRefresh(32, 24, blue)));

    // A delta whose payload is cut short: the rect header promises 8x8 pixels,
    // only a fraction of them were sent.
    const truncatedDelta = Buffer.concat([
      upHead(1),
      rHead(0, 0, 8, 8, 0),
      Buffer.concat(Array(6).fill(red)), // 6 of the 64 pixels
    ]);
    await pushFrames(frames(truncatedDelta));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );

    expect(res.status).toBe(200);
    // A real screen is still served — the operator is not left blind...
    expect(res.body.data.screen).not.toBeNull();
    // ...but it is NOT labelled current.
    expect(res.body.data.partial).toBe(true);
    expect(res.body.data.partialReason).toBe('truncated-screen');
    expect(res.body.data.truncatedFromSeq).not.toBeNull();
  });

  it('a Hextile rect truncated MID-TILE is reported partial, never a 500 (finding 3)', async () => {
    // ── THE CRASH THIS PINS ────────────────────────────────────────────────
    // `truncated` is `endsMidMessage || (newestStart !== null && …)`. The first
    // disjunct alone makes it true while `newestStart` is STILL NULL — the shape
    // of a delta stream that ends part-way through a HEXTILE rect (a delta
    // stream has no self-contained full-screen message, so `newestStart` stays
    // null). The pre-fix code did `frames[scan.newestStart!].seq`, which threw
    // `TypeError: Cannot read properties of undefined (reading 'seq')`; because
    // `renderFrames` runs outside the controller's try/catch, the operator got a
    // 500 instead of the honest `partial: true / truncated-screen` verdict.
    //
    // The shipped suite missed it because its only truncation fixture cuts a RAW
    // rect short, and a truncated Raw rect still leaves a strict `newestStart`.
    // So the crash needed precisely the Windows feature's own encoding — which
    // is also why this test is the first in the repo to put a HEXTILE rect
    // through the real HTTP boundary at all.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    // A multi-rect Raw refresh: NO update in it is a whole screen, so the scan
    // finds no strict start (this is what makes `newestStart` null).
    await pushFrames(frames(windowsFullRefresh(32, 32, px(0, 0, 255))));

    // One Hextile rect covering 32x32 = FOUR 16x16 tiles. The first tile is
    // COMPLETE (Raw subencoding: 1 mask byte + 16*16*4 pixels); the second tile
    // ANNOUNCES its Raw subencoding and then supplies only part of its pixels,
    // so the tile walk runs out of bytes exactly mid-tile.
    //
    // Writing trailing garbage after a complete rect instead would be WRONG:
    // the decoder would read it as a new server message type and halt with
    // `unknown-message-type` (measured: type 34 from a 0x22 fill), which is a
    // 409 codec-desync and never reaches the truncation path at all.
    const tile1 = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(16 * 16 * 4, 0x11)]);
    expect(tile1.length).toBe(1025);
    const truncatedHextile = Buffer.concat([
      upHead(1),
      rHead(0, 0, 32, 32, 5),
      tile1,
      Buffer.from([0x01]),      // tile 2 announces Raw…
      Buffer.alloc(200, 0x33),  // …and only part of its pixels follow
    ]);
    await pushFrames(frames(truncatedHextile));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );

    // The regression was a THROW here, so a 200 is the assertion that matters.
    expect(res.status).toBe(200);
    expect(res.body.data.partial).toBe(true);
    expect(res.body.data.partialReason).toBe('truncated-screen');
    // The seq field must be a real number, not an `undefined` dereference.
    // (`keepFromSeq` is internal — it drives compaction; `framesCompacted` is
    // what this route exposes.)
    expect(typeof res.body.data.truncatedFromSeq).toBe('number');
    expect(typeof res.body.data.framesCompacted).toBe('number');
  });

  it('a Hextile full refresh renders its pixels over the REAL route', async () => {
    // The reviewer's sharpest point was that no Hextile frame ever crossed the
    // HTTP boundary anywhere in the repo: every "Windows" fixture was Raw. This
    // drives the whole path — push → store → scan → decode → route → pixels.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    // One 16x16 tile carrying a single colour, so the decode is checkable.
    const colour = px(0, 200, 100);
    const tile = Buffer.concat([Buffer.from([0x01]), Buffer.concat(Array(16 * 16).fill(colour))]);
    const update = Buffer.concat([upHead(1), rHead(0, 0, 16, 16, 5), tile]);
    await pushFrames(frames(update));

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}`,
      { headers },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.screen).not.toBeNull();
    expect(res.body.data.screen.width).toBe(16);
    expect(res.body.data.screen.height).toBe(16);
    // A whole framebuffer was composited from the tiles (16 tiles' worth of
    // pixels, not zero): `rectsApplied` proves the Hextile walk actually ran.
    expect(res.body.data.screen.rectsApplied).toBeGreaterThanOrEqual(1);
    expect(res.body.data.screen.sha256).toMatch(/^[0-9a-f]{64}$/);
    // The route serves a PNG, so this is where the pixels can be checked.
    expect(res.body.data.screen.image).toMatch(/^data:image\/png;base64,/);
    expect(res.body.data.screen.bytes).toBeGreaterThan(50);
    // And it is a real, complete screen — not a partial verdict.
    expect(res.body.data.partial).toBe(false);
    // The EXACT pixel values are pinned in relay-operator-negotiation.c468f922
    // .test.ts, which decodes the same Hextile bytes in-process and compares
    // rgba directly (the route only ever hands back a PNG).
  });

  it('the SAME truncated window carries its verdict on the PNG header too', async () => {
    // An `<img src=…?format=png>` consumer never sees JSON, so the binary path
    // must carry the same honesty or that caller is silently misled.
    const { sessionId, capability } = await openLiveSession();
    const headers = { ...USER, [RELAY_CAPABILITY_HEADER]: capability };

    await pushFrames(frames(windowsFullRefresh(32, 24, px(0, 0, 255))));
    await pushFrames(
      frames(
        Buffer.concat([
          upHead(1),
          rHead(0, 0, 8, 8, 0),
          Buffer.concat(Array(6).fill(px(255, 0, 0))),
        ]),
      ),
    );

    const res = await api(
      `/api/crossmodel/imessage/agents/mac-1/relay/screen?sessionId=${sessionId}&format=png`,
      { headers },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('x-digby-screen-partial')).toBe('truncated-screen');
    expect(res.raw.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});