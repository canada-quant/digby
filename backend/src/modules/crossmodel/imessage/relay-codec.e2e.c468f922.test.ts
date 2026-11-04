/**
 * RFB CODEC — END-TO-END over the LIVE HTTP surface (ticket c468f922).
 *
 * ── WHAT THIS FILE ADDS OVER THE TWO UNIT SUITES ────────────────────────────
 * `imessage-agent/test/rfb-codec.c468f922.test.mjs` proves the codec is correct
 * against hand-built RFC 6143 bytes. `relay-dataplane.e2e.c468f922.test.ts`
 * proves the relay CARRIES opaque bytes. Neither proves the thing this ticket
 * keeps failing to prove: that the two meet — that a screen captured on the
 * device, encoded by the REAL device codec, pushed through the REAL routes,
 * drained by the REAL operator code, comes out as the SAME pixels.
 *
 * That gap is this ticket's signature defect. The relay's first cut shipped
 * routes, gates, queues, a capability mint and 31 passing tests, and NOTHING
 * that ever dialled them; the review's finding was that a data plane whose only
 * peer is a test suite carries nothing. So this suite refuses to mock the
 * codec. It loads `imessage-agent/src/rfb-codec.ts` and
 * `imessage-agent/src/relay-session.ts` — the ACTUAL files that ship in the
 * agent tarball — compiles them here, and runs them on BOTH ends of a real HTTP
 * conversation.
 *
 * ── WHAT IS REAL, AND WHAT IS NOT ───────────────────────────────────────────
 * REAL: the agent codec source (both directions), express + the real
 * `imessage.routes.ts` router, the real controller handlers, the real relay
 * gate, the real server-assigned sequence counters, the real brokered-session
 * grant store, and the real 64 KiB frame ceiling.
 * STAND-INS (with reasons): Redis as an in-memory map (the cross-process bus, so
 * the store's real key discipline/TTL/INCR all execute), and the DB-backed
 * device lookup (a device row is not what is being tested).
 *
 * NOT CLAIMED: that a live macOS capture drives this on hardware. The capture
 * decoder is unit-tested against a real BMP; the live device e2e is parked by
 * the supervisor's steer and is NOT implied by a green run here.
 */

// ── Stand-in #1: Redis, as an in-memory map ─────────────────────────────────
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
import { join, dirname } from 'path';
import * as ts from 'typescript';
import router from './imessage.routes';
import { RELAY_CAPABILITY_HEADER, RELAY_MAX_FRAME_BYTES, validateRelayPayload } from './relay-dataplane';

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Load the REAL agent codec from the files that ship in the tarball
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compile ONE `imessage-agent/src/*.ts` file in-process and return its exports.
 *
 * WHY THIS EXISTS instead of a mock. The defect this ticket keeps re-learning
 * is "a requirement no live surface satisfies" — and a hand-written test double
 * for the codec would be exactly that: a second implementation that agrees with
 * the assertions while the shipped one does something else. Loading the real
 * source means the bytes under test are produced and consumed by the code that
 * goes to a Mac.
 *
 * `typescript` is a backend devDependency (`^5.9.3`), so this needs no network,
 * no Mac and no build step in CI.
 */
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
      // Anything else resolves normally — `crypto` is the codec's only import.
      return require(id);
    },
    mod,
    dirname(join(REPO, relPath)),
    join(REPO, relPath),
  );
  return mod.exports;
}

/** The real codec, loaded once (it is a pure leaf — no side effects). */
const RFB = loadAgentModule('imessage-agent/src/rfb-codec.ts');
/** The real joint (control/screen channels), bound to the real codec. */
const RELAY_SESSION = loadAgentModule('imessage-agent/src/relay-session.ts', {
  './rfb-codec': RFB,
});

const {
  RFB_RELAY_FRAME_BYTES,
  encodePointerEvent,
  encodeKeyEvent,
  encodeFramebufferUpdateRequest,
  RFB_PIXEL_FORMAT,
} = RFB;

const { RelayScreenChannel, RelayViewer, RelayControlChannel, parseBmpToRgba } = RELAY_SESSION;

// ─────────────────────────────────────────────────────────────────────────────
// The live HTTP surface
// ─────────────────────────────────────────────────────────────────────────────

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

/** The device dials OUT and pushes one payload. Returns the HTTP result. */
const devicePush = (payloadB64: string) =>
  api('/api/crossmodel/imessage/agent/relay/frames', {
    method: 'POST',
    headers: { ...AGENT, ...json },
    body: { payload: payloadB64 },
  });

/** The operator dials OUT and drains. Capability rides the HEADER, never the URL. */
const operatorDrain = (sessionId: string, capability: string, after = 0) =>
  api(`/api/crossmodel/imessage/agents/mac-1/relay/frames?sessionId=${sessionId}&after=${after}`, {
    headers: { ...USER, [RELAY_CAPABILITY_HEADER]: capability },
  });

/** The device drains what the operator sent. */
const deviceDrain = (after = 0) =>
  api(`/api/crossmodel/imessage/agent/relay/frames?after=${after}`, { headers: AGENT });

/**
 * A recognisable captured screen: a per-pixel gradient, so a single wrong row or
 * a byte-order mistake changes the hash rather than passing as "black screen".
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE CARRY, WITH A REAL SCREEN — device codec → routes → operator codec
// ─────────────────────────────────────────────────────────────────────────────

describe('AN AUTHORIZED SESSION CARRIES A REAL SCREEN END TO END', () => {
  // 30s: a real 1280×800 capture crosses the relay as MANY frames and each is
  // decoded byte-for-byte — the 5s default is the documented parallel-load
  // timeout class (ticket 61024ae3), not a code defect. Scoped to this one
  // test so a genuine hang elsewhere still fails fast.
  it('a captured 1280×800 screen crosses the relay as many frames and decodes byte-identically', async () => {
    const { sessionId, capability } = await openLiveSession();

    // ── DEVICE: the REAL agent codec encodes + chunks a real capture ──
    const screen = captureScreen(1280, 800);
    const payloads: string[] = [];
    const sent = new RelayScreenChannel().sendScreen(screen, (b64: string) => payloads.push(b64));

    // The design constraint, restated on the live path: one Raw screen is far
    // larger than one relay frame, so the carry MUST be multi-frame.
    expect(screen.rgba.length).toBe(4_096_000);
    expect(RELAY_MAX_FRAME_BYTES).toBe(64 * 1024);
    expect(sent).toBeGreaterThan(60);
    expect(payloads).toHaveLength(sent);

    // ── THE WIRE: every frame goes through the REAL device route ──
    for (const p of payloads) {
      const res = await devicePush(p);
      // A refused frame here would be the whole feature failing silently, so the
      // status is asserted per frame rather than only at the end.
      expect(res.status).toBe(200);
      expect(res.body.data.seq).toBeGreaterThan(0);
    }

    // ── OPERATOR: drain through the REAL operator route, with the capability ──
    const drained: string[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 20; guard++) {
      const res = await operatorDrain(sessionId, capability, cursor);
      expect(res.status).toBe(200);
      for (const f of res.body.data.frames) drained.push(f.payloadB64);
      cursor = res.body.data.cursor;
      if (!res.body.data.more) break;
    }
    expect(drained).toHaveLength(payloads.length);
    // Order is preserved by the server-assigned sequence, not by luck.
    expect(drained).toEqual(payloads);

    // ── OPERATOR: the REAL codec reassembles it into screen state ──
    const viewer = new RelayViewer();
    for (const p of drained) viewer.ingest(p);

    expect(viewer.isHalted).toBe(false);
    expect(viewer.width).toBe(1280);
    expect(viewer.height).toBe(800);

    const snap = viewer.snapshot();
    expect(snap).not.toBeNull();
    expect(snap.rectsApplied).toBe(1);
    // THE PROOF: the pixels that left the device are the pixels the operator sees.
    expect(viewer.rgba().equals(screen.rgba)).toBe(true);
  }, 30000);

  it('an operator INPUT event crosses the relay and decodes into an executable action', async () => {
    const { sessionId, capability } = await openLiveSession();

    // ── OPERATOR: the REAL codec encodes a click at (640, 480) ──
    const keyDown = encodeKeyEvent(0xff0d, true).toString('base64');
    const click = encodePointerEvent(1, 640, 480).toString('base64');

    for (const payload of [click, keyDown]) {
      const push = await api('/api/crossmodel/imessage/agents/mac-1/relay/frames', {
        method: 'POST',
        headers: { ...USER, ...json },
        body: { sessionId, capability, direction: 'to-device', payload },
      });
      expect(push.status).toBe(200);
    }

    // ── DEVICE: drain through the REAL device route ──
    const poll = await deviceDrain(0);
    expect(poll.status).toBe(200);
    expect(poll.body.data.sessionId).toBe(sessionId);
    expect(poll.body.data.frames).toHaveLength(2);

    // ── DEVICE: the REAL codec decodes them into actions it can execute ──
    const control = new RelayControlChannel();
    const actions: any[] = [];
    for (const f of poll.body.data.frames) actions.push(...control.ingest(f.payloadB64));

    expect(actions).toEqual([
      { kind: 'pointer', buttonMask: 1, x: 640, y: 480, pressed: true },
      { kind: 'key', keysym: 0xff0d, down: true },
    ]);
    expect(control.isHalted).toBe(false);
  });

  it('input that is SPLIT across two relay frames still decodes into one action', async () => {
    const { sessionId, capability } = await openLiveSession();

    // A single PointerEvent, deliberately cut in half — the receiver is a stream
    // decoder, so the sender's frame boundaries must be irrelevant.
    const whole = encodePointerEvent(4, 100, 200);
    const a = whole.subarray(0, 3).toString('base64');
    const b = whole.subarray(3).toString('base64');

    for (const payload of [a, b]) {
      const push = await api('/api/crossmodel/imessage/agents/mac-1/relay/frames', {
        method: 'POST',
        headers: { ...USER, ...json },
        body: { sessionId, capability, direction: 'to-device', payload },
      });
      expect(push.status).toBe(200);
    }

    const poll = await deviceDrain(0);
    const control = new RelayControlChannel();
    const actions: any[] = [];
    for (const f of poll.body.data.frames) actions.push(...control.ingest(f.payloadB64));

    expect(actions).toEqual([{ kind: 'pointer', buttonMask: 4, x: 100, y: 200, pressed: true }]);
  });

  it('a 1080p screen (~127 frames) still carries whole, well inside the 256-frame queue cap', async () => {
    const { sessionId, capability } = await openLiveSession();
    // 1920×1080 Raw = 8.3 MB → ~127 relay frames. Deliberately BELOW the backend's
    // RELAY_QUEUE_MAX_FRAMES (256), so this asserts a bigger screen still arrives
    // intact. (The queue-full refusal itself is covered by
    // relay-dataplane.e2e.c468f922.test.ts's "429 queue-full" case — not here.
    // An earlier version of this test claimed to test the cap and did not.)
    const screen = captureScreen(1920, 1080); // 8.3 MB → ~127 frames
    const payloads: string[] = [];
    new RelayScreenChannel().sendScreen(screen, (b64: string) => payloads.push(b64));
    expect(payloads.length).toBeLessThan(256);
    expect(payloads.length).toBeGreaterThan(100);

    const statuses: number[] = [];
    for (const p of payloads) statuses.push((await devicePush(p)).status);
    expect(statuses.every((s) => s === 200)).toBe(true);

    // …and the operator can still reassemble the whole 1080p frame.
    const drained: string[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 30; guard++) {
      const res = await operatorDrain(sessionId, capability, cursor);
      for (const f of res.body.data.frames) drained.push(f.payloadB64);
      cursor = res.body.data.cursor;
      if (!res.body.data.more) break;
    }
    const viewer = new RelayViewer();
    for (const p of drained) viewer.ingest(p);
    expect(viewer.width).toBe(1920);
    expect(viewer.height).toBe(1080);
    expect(viewer.rgba().equals(screen.rgba)).toBe(true);
  }, 30_000); // ~250 sequential HTTP round trips to a loopback server
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The gates still gate the codec path
// ─────────────────────────────────────────────────────────────────────────────

describe('THE CODEC DOES NOT WIDEN THE AUTH SURFACE', () => {
  it('a sessionId WITHOUT the capability cannot drain a real screen', async () => {
    const { sessionId } = await openLiveSession();
    await devicePush(encodeFramebufferUpdateRequest({ incremental: false, width: 4, height: 4 }).toString('base64'));

    const res = await api(`/api/crossmodel/imessage/agents/mac-1/relay/frames?sessionId=${sessionId}&after=0`, {
      headers: USER,
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('wrong-capability');
  });

  it('a CLOSED session stops carrying screen bytes immediately', async () => {
    const { sessionId, capability } = await openLiveSession();
    await devicePush(Buffer.from('SCREEN').toString('base64'));

    const close = await api('/api/crossmodel/imessage/agents/mac-1/brokered-session', {
      method: 'DELETE',
      headers: USER,
    });
    expect(close.status).toBe(200);

    const after = await operatorDrain(sessionId, capability, 0);
    expect(after.status).toBe(409);
    expect(after.body.code).toBe('not-open');
  });

  it('a STALE session refuses screen bytes — the "authenticated with nobody behind it" case', async () => {
    const { sessionId, capability } = await openLiveSession();
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

    const res = await operatorDrain(sessionId, capability, 0);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Drift guards: the two halves cannot disagree silently
// ─────────────────────────────────────────────────────────────────────────────

describe('THE AGENT AND THE BACKEND AGREE ON THE WIRE', () => {
  it('the agent’s frame ceiling EQUALS the backend’s — duplicated constant, drift-guarded', () => {
    // The agent ships as a src-only tarball with no backend in it, so it cannot
    // import RELAY_MAX_FRAME_BYTES. It duplicates the number instead — and this
    // assertion is what makes the duplication safe: a drift here would show up
    // in the field as an agent whose frames the backend refuses as
    // `frame-too-large`, i.e. no screen at all.
    expect(RFB_RELAY_FRAME_BYTES).toBe(RELAY_MAX_FRAME_BYTES);
  });

  // ── REGRESSION: the exact-ceiling frame (found 2026-11-02) ────────────────
  //
  // The backend's cheap base64 pre-check used `Math.ceil(len * 3 / 4)`, which
  // IGNORES padding and so overestimates by up to 2 bytes. A payload of EXACTLY
  // RELAY_MAX_FRAME_BYTES encodes to a string whose 3/4 length is
  // RELAY_MAX_FRAME_BYTES + 2 → the pre-check refused the largest LEGAL frame
  // as `frame-too-large`, before the exact check could run.
  //
  // Invisible until now because no test had ever pushed a payload AT the ceiling
  // (small payloads stay under the overestimate). The RFB codec makes it fatal:
  // `chunkForRelay` emits FULL-CEILING frames, so in the field every frame of
  // every screen would have been refused — a permanent 413 on the whole feature,
  // indistinguishable from a caller bug. This test would have caught it.
  it('a payload of EXACTLY the frame ceiling is ACCEPTED (base64 padding regression)', () => {
    const atCeiling = Buffer.alloc(RELAY_MAX_FRAME_BYTES, 0x41).toString('base64');
    expect(validateRelayPayload(atCeiling)).toEqual({ ok: true, bytes: RELAY_MAX_FRAME_BYTES });

    // One byte over is still refused — the fix must not widen the ceiling.
    const overCeiling = Buffer.alloc(RELAY_MAX_FRAME_BYTES + 1, 0x41).toString('base64');
    expect(validateRelayPayload(overCeiling)).toEqual({ ok: false, refusal: 'frame-too-large' });
  });

  it('every chunk the agent actually emits at the ceiling is accepted by the backend', () => {
    // Not a synthetic string: the REAL chunker's output, at the REAL ceiling.
    const bytes = Buffer.alloc(RELAY_MAX_FRAME_BYTES * 3 + 17, 0x5a);
    const chunks = RFB.chunkForRelay(bytes);
    expect(chunks.length).toBeGreaterThan(1);
    // The first chunks are exactly full — the case that was broken.
    for (const c of chunks) {
      const verdict = validateRelayPayload(c);
      expect(verdict.ok).toBe(true);
    }
    // …and the chunks rejoin to the original bytes.
    expect(RFB.joinRelayChunks(chunks).equals(bytes)).toBe(true);
  });

  it('the agent’s declared pixel format is 32bpp true-colour little-endian', () => {
    expect(RFB_PIXEL_FORMAT.bitsPerPixel).toBe(32);
    expect(RFB_PIXEL_FORMAT.depth).toBe(24);
    expect(RFB_PIXEL_FORMAT.trueColour).toBe(true);
    expect(RFB_PIXEL_FORMAT.bigEndian).toBe(false);
    expect(RFB_PIXEL_FORMAT.bytesPerPixel).toBe(32 / 8);
  });

  it('the codec source genuinely lives in the AGENT tree that ships', () => {
    // If the codec were imported from anywhere but the agent's own src, it would
    // not be in the tarball and no device could ever run it — the exact "merged
    // but never shipped" defect agent-release.c468f922 exists for.
    for (const rel of ['imessage-agent/src/rfb-codec.ts', 'imessage-agent/src/relay-session.ts']) {
      expect(SRC(rel).length).toBeGreaterThan(1000);
    }
    const index = SRC('imessage-agent/src/index.ts');
    expect(index).toMatch(/from '\.\/relay-session'/);
  });

  it('an undecodable capture is REFUSED by the real parser, never guessed', () => {
    // The refusal path the agent logs ("the operator sees no video this session")
    // depends on this returning null rather than a plausible wrong picture.
    expect(parseBmpToRgba(Buffer.alloc(0))).toBeNull();
    expect(parseBmpToRgba(Buffer.from('not a bmp at all, just some bytes here'))).toBeNull();
  });
});