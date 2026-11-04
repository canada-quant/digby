/**
 * ── THE "NOT ACTUALLY WIRED" FIX, PINNED (ticket c468f922) ─────────────────
 *
 * A post-merge independent review of PR #2341 (squash 30dc4b3d6f) returned
 * BLOCKING DEFECTS: "the flagship contract is not actually wired". It was
 * right, and this file exists so it cannot happen again. The three breaks were
 * each verified at source before anything was written:
 *
 *   B1  NOTHING ADVERTISED THE ENCODINGS. `encodeOperatorSetEncodings`
 *       (relay-operator-viewer.ts:1472) and `encodeSetEncodings`
 *       (imessage-agent/src/rfb-codec.ts:889) had ZERO production callers —
 *       grep found only test files. Under RFC 6143 §7.5.2 a server picks from
 *       what the client LISTED, so Hextile(5), CopyRect(1) and LastRect(-224)
 *       could never arrive. The decoder grew for encodings no server sends.
 *
 *   B2  NO RFB SESSION WAS EVER ESTABLISHED. `OperatorScreenDecoder` is fed
 *       from the relay queue (relay-operator.controller.ts:147). Nothing on a
 *       Windows PC put a server's bytes in it: `queueRelayFrame`
 *       (windows-agent/src/index.ts:346) had NO CALLERS — the file says
 *       "Deliberately NOT wired to capture/input yet" — and the macOS agent's
 *       `sendScreen` emits Raw only (rfb-codec.ts:803). Every byte that ever
 *       reached the decoder was Raw.
 *
 *   B3  ALSO UNADVERTISED: `FramebufferUpdateRequest`. A server sends no pixels
 *       until asked (§7.5.1), so a session that negotiated correctly would
 *       still sit silent.
 *
 * ── WHY THE TEST THAT MATTERS IS A NEGOTIATION, NOT A DECODE ───────────────
 * A fixture that unconditionally emits Hextile proves the decoder can decode
 * Hextile — which the merged PR already proved, and which is why its tests were
 * green while the feature was unreachable. So the fixture here implements
 * §7.5.2's SELECTION RULE (`serverEncodingChoice`): it emits Hextile only when
 * the operator offered Hextile, and falls back to Raw otherwise. The positive
 * and negative pins therefore differ ONLY in what the client advertised, which
 * is exactly the property that was missing.
 *
 * The bytes are produced by the REAL shipping modules — `windows-agent/src/
 * rfb-client.ts` and `relay-rfb.ts` are transpiled in-process (the technique
 * relay-operator-viewer.test.ts:69 already uses) and decoded by the REAL
 * backend `relay-operator-viewer.ts`. Nothing is mocked at the codec boundary.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import ts from 'typescript';
import { deflateSync } from 'zlib';
import { RELAY_MAX_FRAME_BYTES } from './relay-dataplane';
import {
  OperatorScreenDecoder,
  OPERATOR_RFB_ENCODING_COPY_RECT,
  OPERATOR_RFB_ENCODING_HEXTILE,
  OPERATOR_RFB_ENCODING_LAST_RECT,
  OPERATOR_RFB_ENCODING_RAW,
  OPERATOR_RFB_ENCODING_TIGHT,
  OPERATOR_RFB_ENCODING_TRLE,
  OPERATOR_RFB_ENCODING_ZRLE,
  decodeHextileToWirePixels,
  operatorFrameStartsUpdate,
  operatorUpdateShape,
} from './relay-operator-viewer';

jest.setTimeout(30_000);

const REPO = join(__dirname, '..', '..', '..', '..', '..');
const SRC = (p: string) => readFileSync(join(REPO, p), 'utf8');

/** Compile ONE agent .ts file in-process (same helper as the sibling suites). */
function loadAgentModule(relPath: string, deps: Record<string, unknown> = {}): any {
  const js = ts.transpileModule(SRC(relPath), {
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

// The PRODUCTION Windows-agent modules — the ones that carry the fix.
const RFB_CLIENT = loadAgentModule('windows-agent/src/rfb-client.ts');
const RELAY_RFB = loadAgentModule('windows-agent/src/relay-rfb.ts', {
  './rfb-client': RFB_CLIENT,
});

// ── A minimal RFC 6143 §7.5.2 SERVER, so the negotiation is real ────────────

/**
 * The selection rule itself, isolated so a NEGATIVE control can call it.
 *
 * This is RFC 6143 §7.5.2 in one line: the server emits one of the encodings
 * the client LISTED, preferring its own order, and Raw is always legal
 * ("pixel data may always be sent in raw encoding even if not specified").
 */
function serverEncodingChoice(offered: readonly number[], supports: readonly number[]): number {
  for (const enc of supports) if (offered.includes(enc)) return enc;
  return OPERATOR_RFB_ENCODING_RAW;
}

interface FakeServerOpts {
  width: number;
  height: number;
  /** Encodings this server can emit, most preferred first. */
  supports: readonly number[];
  /** Sub-pixel pattern so a wrong row or byte order changes the result. */
  fill: (x: number, y: number) => [number, number, number];
}

/**
 * An in-process RFB 3.8 server implementing the handshake a real Windows VNC
 * server drives (TightVNC/TigerVNC/UltraVNC all follow §7.1).
 *
 * `receive()` takes client bytes and returns the server bytes to send back —
 * so it can be wired to the carrier socket with no timers and no network.
 */
class FakeRfbServer {
  phase:
    | 'await-version'
    | 'await-security-choice'
    | 'await-client-init'
    | 'await-set-encodings'
    | 'await-update-request'
    | 'done' = 'await-version';
  q = Buffer.alloc(0);

  /** What the client actually put on the wire — the fact B1 was missing. */
  offered: number[] = [];
  chosenEncoding: number | null = null;
  updateRequests = 0;
  /** The incremental flag of every FramebufferUpdateRequest, in order. */
  incrementalFlags: boolean[] = [];
  /** Every byte this server emits, in order. */
  emitted: Buffer[] = [];

  constructor(private readonly opts: FakeServerOpts) {}

  private send(bytes: Buffer): Buffer {
    this.emitted.push(bytes);
    return bytes;
  }

  /** The greeting a server sends unprompted on connect. */
  start(): Buffer {
    return this.send(Buffer.from('RFB 003.008\n', 'latin1'));
  }

  /** ServerInit: w(2) h(2) pixelformat(16) namelen(4) name. §7.3.2. */
  private serverInit(): Buffer {
    const name = Buffer.from('fake-win-vnc', 'latin1');
    const b = Buffer.alloc(24 + name.length);
    b.writeUInt16BE(this.opts.width, 0);
    b.writeUInt16BE(this.opts.height, 2);
    // 32bpp, depth 24, little-endian, true colour, maxes 255, shifts R16 G8 B0.
    b.writeUInt8(32, 4);
    b.writeUInt8(24, 5);
    b.writeUInt8(0, 6);
    b.writeUInt8(1, 7);
    b.writeUInt16BE(255, 8);
    b.writeUInt16BE(255, 10);
    b.writeUInt16BE(255, 12);
    b.writeUInt8(16, 14);
    b.writeUInt8(8, 15);
    b.writeUInt8(0, 16);
    b.writeUInt32BE(name.length, 20);
    name.copy(b, 24);
    return this.send(b);
  }

  /** The rect list, encoded the way the chosen encoding requires. */
  private framebufferUpdate(): Buffer {
    const enc = this.chosenEncoding!;
    const { width, height } = this.opts;
    const head = Buffer.alloc(16);
    head.writeUInt8(0, 0); // FramebufferUpdate
    head.writeUInt8(0, 1);
    head.writeUInt16BE(1, 2); // one rectangle
    head.writeUInt16BE(0, 4);
    head.writeUInt16BE(0, 6);
    head.writeUInt16BE(width, 8);
    head.writeUInt16BE(height, 10);
    head.writeInt32BE(enc, 12);

    const body =
      enc === OPERATOR_RFB_ENCODING_HEXTILE
        ? this.hextilePayload()
        : enc === OPERATOR_RFB_ENCODING_TIGHT
          ? this.tightPayload()
          : this.rawPayload();
    return this.send(Buffer.concat([head, body]));
  }

  /**
   * Tight — genuinely ENCODED, forward, from the spec (never decoded back).
   *
   * CopyFilter (filter-id omitted, so no filter byte) + real zlib, with the
   * compact length in front. That exercises the whole framing: control byte,
   * length prefix, inflate, and the TPIXEL → wire-order conversion. A fixture
   * that emitted the decoder's own output, or skipped the compression, would
   * pass even if the framing were wrong.
   */
  private tightPayload(): Buffer {
    const { width, height } = this.opts;
    const filtered = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [r, g, b] = this.opts.fill(x, y);
        const at = (y * width + x) * 3;
        filtered[at] = r;
        filtered[at + 1] = g;
        filtered[at + 2] = b;
      }
    }
    // control 0x00 = BasicCompression, stream 0, no filter byte (CopyFilter).
    const parts: Buffer[] = [Buffer.from([0x00])];
    if (filtered.length < 12) {
      // "sent as is, uncompressed" — with NO length prefix.
      parts.push(filtered);
    } else {
      const data = deflateSync(filtered);
      const len = data.length;
      const compact: number[] = [];
      if (len <= 0x7f) compact.push(len);
      else if (len <= 0x3fff) compact.push((len & 0x7f) | 0x80, (len >> 7) & 0x7f);
      else compact.push((len & 0x7f) | 0x80, ((len >> 7) & 0x7f) | 0x80, (len >> 14) & 0xff);
      parts.push(Buffer.from(compact), data);
    }
    return Buffer.concat(parts);
  }

  /** BB GG RR 00 on the wire, per the pixel format above. */
  private encodePixels(w: number, h: number): Buffer {
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const [r, g, b] = this.opts.fill(x, y);
        const at = (y * w + x) * 4;
        out[at] = b;
        out[at + 1] = g;
        out[at + 2] = r;
        out[at + 3] = 0;
      }
    }
    return out;
  }

  private rawPayload(): Buffer {
    return this.encodePixels(this.opts.width, this.opts.height);
  }

  /**
   * Hextile §7.7.4 — but genuinely Encoded: 16x16 tiles, each carrying a
   * subencoding mask. A RAISE-only tile uses the Raw subencoding (0x01) and is
   * the simplest legal form; using it keeps the fixture small while still
   * forcing the decoder through the tile walker rather than the Raw path.
   */
  private hextilePayload(): Buffer {
    const { width, height } = this.opts;
    const parts: Buffer[] = [];
    for (let ty = 0; ty < height; ty += 16) {
      for (let tx = 0; tx < width; tx += 16) {
        const tw = Math.min(16, width - tx);
        const th = Math.min(16, height - ty);
        const tile = Buffer.alloc(1 + tw * th * 4);
        tile.writeUInt8(0x01, 0); // Raw subencoding: pixels follow verbatim
        let at = 1;
        for (let y = 0; y < th; y++) {
          for (let x = 0; x < tw; x++) {
            const [r, g, b] = this.opts.fill(tx + x, ty + y);
            tile[at++] = b;
            tile[at++] = g;
            tile[at++] = r;
            tile[at++] = 0;
          }
        }
        parts.push(tile);
      }
    }
    return Buffer.concat(parts);
  }

  /** Take client bytes; return what to send back (possibly nothing). */
  receive(chunk: Buffer): Buffer {
    this.q = this.q.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.q, Buffer.from(chunk)]);
    let out = Buffer.alloc(0);
    for (;;) {
      const step = this.next();
      if (step === null) break;
      out = Buffer.concat([out, step]);
    }
    return out;
  }

  private next(): Buffer | null {
    switch (this.phase) {
      case 'await-version': {
        if (this.q.length < 12) return null;
        this.q = this.q.subarray(12);
        this.phase = 'await-security-choice';
        // One security type: None (1). §7.1.2
        return this.send(Buffer.from([1, 1]));
      }
      case 'await-security-choice': {
        if (this.q.length < 1) return null;
        this.q = this.q.subarray(1);
        this.phase = 'await-client-init';
        return this.send(Buffer.from([0, 0, 0, 0])); // SecurityResult = ok
      }
      case 'await-client-init': {
        if (this.q.length < 1) return null;
        this.q = this.q.subarray(1);
        this.phase = 'await-set-encodings';
        return this.serverInit();
      }
      case 'await-set-encodings': {
        if (this.q.length < 4) return null;
        const type = this.q.readUInt8(0);
        if (type !== 2) {
          throw new Error(`expected SetEncodings(2), got client message ${type}`);
        }
        const count = this.q.readUInt16BE(2);
        if (this.q.length < 4 + count * 4) return null;
        this.offered = [];
        for (let i = 0; i < count; i++) this.offered.push(this.q.readInt32BE(4 + i * 4));
        this.q = this.q.subarray(4 + count * 4);
        // §7.5.2 — pick from what was LISTED. This is the line the merged PR
        // never exercised, because nothing ever listed anything.
        this.chosenEncoding = serverEncodingChoice(this.offered, this.opts.supports);
        this.phase = 'await-update-request';
        return null;
      }
      case 'await-update-request':
      case 'done': {
        // A REAL server answers EVERY FramebufferUpdateRequest (§7.5.1); it does
        // not answer once and stop. The first cut of this fixture went to a
        // terminal `done` phase, which made a SECOND request — precisely what
        // review finding D1 is about — impossible to observe.
        if (this.q.length < 1) return null;
        const type = this.q.readUInt8(0);
        // §7.5.3/§7.5.4: a server accepts PointerEvent(5) and KeyEvent(4) at any
        // time, interleaved with update requests. Consuming them here is what a
        // real server does; throwing on them made this fixture reject a legal
        // client stream (and collided with the carrier's re-request timer).
        if (type === 5) {
          if (this.q.length < 6) return null;
          this.q = this.q.subarray(6);
          return null;
        }
        if (type === 4) {
          if (this.q.length < 8) return null;
          this.q = this.q.subarray(8);
          return null;
        }
        if (type !== 3) throw new Error(`expected FramebufferUpdateRequest(3), got ${type}`);
        if (this.q.length < 10) return null;
        this.incrementalFlags.push(this.q.readUInt8(1) === 1);
        this.q = this.q.subarray(10);
        this.updateRequests += 1;
        this.phase = 'done';
        return this.framebufferUpdate();
      }
      default:
        return null;
    }
  }
}

/**
 * Wire a FakeRfbServer to `runRfbCarrier` through the injected socket seam.
 *
 * The returned `frames` are exactly what the carrier handed the relay — every
 * byte of them came off the fake server. A `send` helper lets a test drive the
 * greeting the way a real server does (unprompted).
 */
/**
 * Carriers opened by a test, torn down in afterEach.
 *
 * ── WHY THIS EXISTS (CI fix, 2026-11-02) ───────────────────────────────────
 * The D1 re-request loop arms a timer on every server arrival and RESCHEDULES on
 * every answer, so a carrier left running keeps a live timer chain for the life
 * of the worker. CI proved this is not theoretical: shard 4/4 reported "A worker
 * process has failed to exit gracefully … Active timers can also cause this" and
 * then SIGTERM'd a CO-TENANT suite (`mcp-search.throttle-injection`) which failed
 * to run at all — one suite's leaked timers red a shard whose own tests passed.
 *
 * `unref()` keeps a timer from holding the event loop open, but it does not
 * cancel the WORK; explicit teardown is the only correct answer.
 */
const openCarriers: Array<{ stop: () => void }> = [];
afterEach(() => {
  while (openCarriers.length > 0) {
    try {
      openCarriers.pop()!.stop();
    } catch {
      /* teardown must never fail a test */
    }
  }
});

async function runCarrierAgainstFixture(
  opts: FakeServerOpts & { chunkLimit?: number; requestCoalesceMs?: number },
) {
  const server = new FakeRfbServer(opts);
  const frames: string[] = [];
  const writes: Buffer[] = [];
  let clientOnData: ((b: Buffer) => void) | null = null;

  const carrier = await RELAY_RFB.runRfbCarrier({
    openSocket: async ({ onData }: { onData: (b: Buffer) => void }) => {
      clientOnData = onData;
      return {
        write: (bytes: Buffer) => {
          writes.push(bytes);
          // Deliver the server's answer synchronously, like a local socket.
          const reply = server.receive(bytes);
          if (reply.length > 0) onData(reply);
        },
        close: () => {},
      };
    },
    emit: (chunk: { payloadB64: string }) => frames.push(chunk.payloadB64),
    log: () => {},
    // 0 = fire the re-request on the next macrotask, so a test can observe it
    // without sleeping out a 120 ms coalesce window.
    requestCoalesceMs: opts.requestCoalesceMs ?? 0,
  });

  // The greeting arrives on connect, before the client has said anything.
  if (clientOnData) (clientOnData as (b: Buffer) => void)(server.start());

  // Never leak the re-request timer out of the test that opened it.
  openCarriers.push(carrier);
  return { carrier, server, frames, writes };
}

/** Concatenate the carried frames back into the server's byte stream. */
const carriedBytes = (frames: string[]): Buffer =>
  Buffer.concat(frames.map((f) => Buffer.from(f, 'base64')));

// ── B1: the advertisement exists, is correct, and is not test-only ──────────

describe('B1 — the encodings are ADVERTISED (RFC 6143 §7.5.2)', () => {
  it('the client advertises Tight, Hextile, CopyRect, Raw, DesktopSize and LastRect', () => {
    const msg = RFB_CLIENT.encodeEncodingAdvertisement();
    expect(msg.readUInt8(0)).toBe(2); // SetEncodings
    expect(msg.readUInt8(1)).toBe(0); // padding
    const count = msg.readUInt16BE(2);
    expect(msg.length).toBe(4 + count * 4);
    const offered: number[] = [];
    for (let i = 0; i < count; i++) offered.push(msg.readInt32BE(4 + i * 4));

    // The encodings the decoder implements but the merged slice advertised
    // NONE of.
    expect(offered).toContain(RFB_CLIENT.RFB_ENCODING_TIGHT);
    expect(offered).toContain(OPERATOR_RFB_ENCODING_HEXTILE);
    expect(offered).toContain(OPERATOR_RFB_ENCODING_COPY_RECT);
    expect(offered).toContain(OPERATOR_RFB_ENCODING_LAST_RECT);
    expect(offered).toContain(OPERATOR_RFB_ENCODING_RAW);
    // TIGHT FIRST: TightVNC/TigerVNC take the first listed supported encoding
    // as their preferred one, so order is behaviour, not style. Both PREFER
    // Tight, so listing Hextile first ordered them to send the costlier
    // encoding — and a host forced to `tight` had no legal answer but a rect
    // we refused.
    expect(offered[0]).toBe(RFB_CLIENT.RFB_ENCODING_TIGHT);
  });

  it('REFUSES to advertise an encoding no decoder claims (drift guard)', () => {
    // TRLE(16) and ZRLE(17) are real, desirable encodings — and still
    // FOLLOW-ON slices. Listing one now would recreate the original defect
    // from the other direction: a server would answer in an encoding whose
    // framing we cannot walk, and every later byte would be unattributable.
    for (const unimplemented of [OPERATOR_RFB_ENCODING_TRLE, OPERATOR_RFB_ENCODING_ZRLE]) {
      expect(() =>
        RFB_CLIENT.encodeSetEncodings([OPERATOR_RFB_ENCODING_RAW, unimplemented]),
      ).toThrow(/no decoder claims it/);
    }
    // And the shipping list passes its own guard.
    expect(() => RFB_CLIENT.assertAdvertisable(RFB_CLIENT.advertisedEncodings())).not.toThrow();
  });

  it('the advertisement REACHES THE WIRE from production code, not just a test', async () => {
    // `runRfbCarrier` is the production Windows-agent path. If SetEncodings
    // were still test-only, `server.offered` below would be empty.
    const { server } = await runCarrierAgainstFixture({
      width: 16,
      height: 16,
      supports: [OPERATOR_RFB_ENCODING_HEXTILE],
      fill: () => [200, 100, 50],
    });
    expect(server.phase).toBe('done');
    expect(server.offered).toContain(OPERATOR_RFB_ENCODING_HEXTILE);
    expect(server.offered).toContain(OPERATOR_RFB_ENCODING_LAST_RECT);
  });
});

// ── B1b: the server picks Hextile BECAUSE we offered it ────────────────────

describe('B1b — the server chooses Hextile only because the operator offered it', () => {
  it('chooses Hextile when it is offered, and Raw when it is not', () => {
    const supports = [OPERATOR_RFB_ENCODING_HEXTILE];

    // Positive: the production advertisement lists Hextile → the server picks it.
    expect(serverEncodingChoice(RFB_CLIENT.advertisedEncodings(), supports)).toBe(
      OPERATOR_RFB_ENCODING_HEXTILE,
    );

    // NEGATIVE CONTROL — this is what stops the suite being tautological.
    // Same server, same rule, an advertisement WITHOUT Hextile: it must fall
    // back to Raw. Without this assertion a fixture that emits Hextile
    // unconditionally would pass every other test in this file.
    expect(serverEncodingChoice([OPERATOR_RFB_ENCODING_RAW], supports)).toBe(
      OPERATOR_RFB_ENCODING_RAW,
    );
  });

  it('end-to-end: negotiation → Hextile frame → the BACKEND decoder renders it', async () => {
    const fill = (x: number, y: number): [number, number, number] => [x * 16, y * 16, 64];
    const { server, frames } = await runCarrierAgainstFixture({
      width: 16,
      height: 16,
      supports: [OPERATOR_RFB_ENCODING_HEXTILE],
      fill,
    });

    // The server really did answer with Hextile, chosen from our list…
    expect(server.chosenEncoding).toBe(OPERATOR_RFB_ENCODING_HEXTILE);
    // …and its bytes travelled the relay as frames.
    const bytes = carriedBytes(frames);
    expect(bytes.length).toBeGreaterThan(0);

    // Asserted with the GENERAL walker, deliberately not the narrower
    // `operatorFrameStartsUpdate`: that predicate is sendScreen-shaped (one Raw
    // rect at the origin) and MUST stay narrow — loosening it is what let a
    // 16-byte CopyRect pattern inside a truncated screen parse as a complete
    // message and re-broke D1. A Hextile update is not its shape by design.
    const shape = operatorUpdateShape(bytes, 0, bytes.length);
    expect(shape.isUpdate).toBe(true);
    expect(shape.complete).toBe(true);
    expect(shape.numRects).toBe(1);

    // The REAL backend decoder (not the agent's) decodes those carried bytes.
    const decoder = new OperatorScreenDecoder();
    const events = decoder.push(bytes);
    expect(decoder.isHalted).toBe(false);
    // Narrow the event union explicitly: only a `rect` carries an encoding and
    // pixels, and the assertions below are about exactly those two fields.
    const rects = events.filter((e) => e.type === 'rect') as unknown as Array<{
      type: string;
      encoding: number;
      pixels: Buffer | null;
    }>;
    const painted = rects.find(
      (e) => e.encoding === OPERATOR_RFB_ENCODING_HEXTILE && e.pixels !== null,
    );
    expect(painted).toBeTruthy();

    // The PIXELS are right, which is the whole contract: a Hextile tile with
    // the Raw subencoding carries BB GG RR 00, so pixel (0,0) is (0,0,64) and
    // pixel (1,0) is (16,0,64) — a byte-order or tile-stride bug changes these.
    const snap = decoder.snapshot();
    expect(snap).not.toBeNull();
    const rgba = snap!.rgba;
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 0, 64]);
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([16, 0, 64]);
  });
});

// ── B2: a real server stream is carried, not synthesised ────────────────────

describe('B1c — the server chooses TIGHT only because the operator offered it', () => {
  it('chooses Tight when it is offered, and Raw when it is not', () => {
    const supports = [OPERATOR_RFB_ENCODING_TIGHT];

    // Positive: the production advertisement lists Tight → the server picks it.
    expect(serverEncodingChoice(RFB_CLIENT.advertisedEncodings(), supports)).toBe(
      OPERATOR_RFB_ENCODING_TIGHT,
    );

    // NEGATIVE CONTROL — the assertion that stops this suite being tautological.
    // Same server, same rule, an advertisement WITHOUT Tight: it must fall back
    // to Raw. Without this leg, deleting the advertisement entirely would leave
    // every other Tight test passing, which is exactly the defect class the
    // Hextile slice was created to catch.
    expect(
      serverEncodingChoice(
        RFB_CLIENT.advertisedEncodings().filter((e: number) => e !== OPERATOR_RFB_ENCODING_TIGHT),
        supports,
      ),
    ).toBe(OPERATOR_RFB_ENCODING_RAW);
  });

  it('prefers Tight over Hextile when a server supports BOTH (order is behaviour)', () => {
    // TightVNC and TigerVNC both take "the first normal encoding in the
    // client's list" they support. Both PREFER Tight, so listing Hextile first
    // ordered them to send the costlier encoding on every single update.
    expect(
      serverEncodingChoice(RFB_CLIENT.advertisedEncodings(), [
        OPERATOR_RFB_ENCODING_TIGHT,
        OPERATOR_RFB_ENCODING_HEXTILE,
      ]),
    ).toBe(OPERATOR_RFB_ENCODING_TIGHT);
  });

  it('end-to-end: negotiation → Tight frame → the BACKEND decoder renders it', async () => {
    const fill = (x: number, y: number): [number, number, number] => [x * 16, y * 16, 64];
    const { server, frames } = await runCarrierAgainstFixture({
      width: 16,
      height: 16,
      supports: [OPERATOR_RFB_ENCODING_TIGHT],
      fill,
    });

    // The server really did answer with Tight, chosen from our list…
    expect(server.chosenEncoding).toBe(OPERATOR_RFB_ENCODING_TIGHT);
    // …and its bytes travelled the relay as frames.
    const bytes = carriedBytes(frames);
    expect(bytes.length).toBeGreaterThan(0);

    // Asserted with the GENERAL walker: a Tight update is not
    // `operatorFrameStartsUpdate`'s shape (that predicate is sendScreen-shaped
    // and MUST stay narrow — see D1).
    const shape = operatorUpdateShape(bytes, 0, bytes.length);
    expect(shape.isUpdate).toBe(true);
    expect(shape.complete).toBe(true);
    expect(shape.numRects).toBe(1);

    // The REAL backend decoder (not the agent's) decodes those carried bytes.
    const decoder = new OperatorScreenDecoder();
    const events = decoder.push(bytes);
    expect(decoder.isHalted).toBe(false);
    const rects = events.filter((e) => e.type === 'rect') as unknown as Array<{
      type: string;
      encoding: number;
      pixels: Buffer | null;
    }>;
    const painted = rects.find(
      (e) => e.encoding === OPERATOR_RFB_ENCODING_TIGHT && e.pixels !== null,
    );
    expect(painted).toBeTruthy();

    // The PIXELS are right — the whole contract. TPIXEL is R,G,B → wire order
    // BB GG RR 00, so pixel (0,0) is (0,0,64) and (1,0) is (16,0,64): a
    // byte-order, stride or filter bug changes these.
    const snap = decoder.snapshot();
    expect(snap).not.toBeNull();
    const rgba = snap!.rgba;
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 0, 64]);
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([16, 0, 64]);
    // Last row/column too: an off-by-one stride survives a corner check.
    const last = (15 * 16 + 15) * 4;
    expect([rgba[last], rgba[last + 1], rgba[last + 2]]).toEqual([240, 240, 64]);
  });

  it('the NEGATIVE control renders the SAME image in Raw when Tight is not offered', async () => {
    // Same fixture, same image, but this server supports ONLY Tight and the
    // client did not list it. The selection rule must fall back to Raw, and the
    // image must still be correct — proving the two legs differ ONLY in what
    // was advertised, not in what was drawn.
    const fill = (x: number, y: number): [number, number, number] => [x * 16, y * 16, 64];
    const offered = RFB_CLIENT
      .advertisedEncodings()
      .filter((e: number) => e !== OPERATOR_RFB_ENCODING_TIGHT);
    expect(serverEncodingChoice(offered, [OPERATOR_RFB_ENCODING_TIGHT])).toBe(
      OPERATOR_RFB_ENCODING_RAW,
    );

    // And the decoder still paints it, so "fell back to Raw" is not "produced
    // nothing" — a distinction that matters when the assertion above is the
    // only thing that changes between the legs.
    const rawPayload = Buffer.alloc(16 * 16 * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const [r, g, b] = fill(x, y);
        const at = (y * 16 + x) * 4;
        rawPayload[at] = b;
        rawPayload[at + 1] = g;
        rawPayload[at + 2] = r;
        rawPayload[at + 3] = 0;
      }
    }
    const head = Buffer.alloc(16);
    head.writeUInt8(0, 0);
    head.writeUInt8(0, 1);
    head.writeUInt16BE(1, 2);
    head.writeUInt16BE(0, 4);
    head.writeUInt16BE(0, 6);
    head.writeUInt16BE(16, 8);
    head.writeUInt16BE(16, 10);
    head.writeInt32BE(OPERATOR_RFB_ENCODING_RAW, 12);
    const decoder = new OperatorScreenDecoder();
    decoder.push(Buffer.concat([head, rawPayload]));
    expect(decoder.isHalted).toBe(false);
    const rgba = decoder.snapshot()!.rgba;
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([0, 0, 64]);
    expect([rgba[4], rgba[5], rgba[6]]).toEqual([16, 0, 64]);
  });
});

// ── B2: a real server stream is carried, not synthesised ────────────────────

describe('B2 — a real RFB server’s bytes reach the operator decoder', () => {
  it('carries the server stream byte-for-byte (no synthesis, no invented framing)', async () => {
    const { server, frames } = await runCarrierAgainstFixture({
      width: 32,
      height: 32,
      supports: [OPERATOR_RFB_ENCODING_HEXTILE],
      fill: (x, y) => [x, y, 7],
    });

    const expected = Buffer.concat(server.emitted);
    const carried = carriedBytes(frames);

    // The carrier forwards from the point the handshake completes; the greeting
    // and ServerInit were consumed by the handshake state machine by design.
    // What must hold is that EVERY carried byte is a suffix of what the server
    // emitted — i.e. nothing was fabricated on the way out.
    const tail = expected.subarray(expected.length - carried.length);
    expect(carried.equals(tail)).toBe(true);
    expect(carried.length).toBeGreaterThan(0);
  });

  it('asks the server for a frame (§7.5.1) — negotiating alone would sit silent', async () => {
    const { server } = await runCarrierAgainstFixture({
      width: 16,
      height: 16,
      supports: [OPERATOR_RFB_ENCODING_HEXTILE],
      fill: () => [0, 0, 0],
    });
    // No FramebufferUpdateRequest ⇒ no pixels, ever. This is B3.
    expect(server.updateRequests).toBeGreaterThanOrEqual(1);
  });

  it('chunks so no single relay frame exceeds the relay cap', async () => {
    // 256x256 Raw = 256 KB, over the relay's per-frame ceiling: unsplit, the
    // push would be refused outright and the screen would never arrive.
    const { frames } = await runCarrierAgainstFixture({
      width: 256,
      height: 256,
      supports: [OPERATOR_RFB_ENCODING_RAW],
      fill: () => [1, 2, 3],
    });
    expect(frames.length).toBeGreaterThan(1);
    for (const f of frames) {
      expect(Buffer.from(f, 'base64').length).toBeLessThanOrEqual(RELAY_MAX_FRAME_BYTES);
    }
    // …and the whole update still reassembles.
    const decoder = new OperatorScreenDecoder();
    decoder.push(carriedBytes(frames));
    expect(decoder.snapshot()).not.toBeNull();
  });
});

// ── B2b: the PRODUCTION pump actually drives it ────────────────────────────

describe('B2b — the production pump has a real caller (the exact thing that was missing)', () => {
  const INDEX_SRC = SRC('windows-agent/src/index.ts');

  it('queueRelayFrame is called from production code, not only defined', () => {
    // THE BLOCKING FINDING, PINNED AS A SHAPE. Before this fix a grep for
    // `queueRelayFrame` in windows-agent/src found the declaration and NOTHING
    // else — the outbox had no producer, so no byte was ever carried and the
    // backend decoder could never run. Assert on call sites, not definition.
    const callSites = INDEX_SRC.match(/queueRelayFrame\(/g) ?? [];
    // One declaration (`export function queueRelayFrame(`) + at least one call.
    expect(callSites.length).toBeGreaterThanOrEqual(2);
    // And the caller is the carrier's emit, i.e. server bytes really flow out.
    expect(INDEX_SRC).toMatch(/emit:\s*\(chunk\)\s*=>\s*queueRelayFrame\(/);
  });

  it('pumpRelay starts the carrier and forwards operator input into it', () => {
    const pump = INDEX_SRC.slice(INDEX_SRC.indexOf('async function pumpRelay'));
    const pumpBody = pump.slice(0, pump.indexOf('\n}\n') + 1);
    // A live session must bring a carrier up…
    expect(pumpBody).toContain('startRelayCarrier()');
    // …and the operator's bytes must be forwarded, not acknowledged and dropped
    // (the pre-fix body logged the frame and threw it away).
    expect(pumpBody).toContain('relayCarrier.write(');
  });

  it('forwards operator input bytes to the RFB server VERBATIM', async () => {
    const server = new FakeRfbServer({
      width: 16,
      height: 16,
      supports: [OPERATOR_RFB_ENCODING_HEXTILE],
      fill: () => [0, 0, 0],
    });
    const writes: Buffer[] = [];
    const sinks: Array<(b: Buffer) => void> = [];

    const carrier = await RELAY_RFB.runRfbCarrier({
      openSocket: async ({ onData: od }: { onData: (b: Buffer) => void }) => {
        sinks.push(od);
        return {
          write: (bytes: Buffer) => {
            writes.push(bytes);
            const reply = server.receive(bytes);
            if (reply.length > 0) od(reply);
          },
          close: () => {},
        };
      },
      emit: () => {},
      log: () => {},
    });
    sinks[0](server.start());
    openCarriers.push(carrier);
    expect(carrier.state).toBe('carrying');

    // A PointerEvent as the BACKEND would encode it (§7.5.3): type 5, mask, x, y.
    const pointer = Buffer.from([5, 1, 0x01, 0x02, 0x00, 0x03]);
    carrier.write(pointer);

    const forwarded = writes.find((w) => w.equals(pointer));
    expect(forwarded).toBeTruthy();
  });
});

// ── D1/D2: the carrier must STREAM, and must start exactly once ─────────────

describe('D1 — the carrier keeps asking for frames (RFC 6143 §7.5.1)', () => {
  /** Let queued timers/microtasks run (the re-request uses a 0-ms timer). */
  const tick = (ms = 5) => new Promise<void>((res) => setTimeout(res, ms));

  it('issues a SECOND FramebufferUpdateRequest after the first update arrives', async () => {
    // ── THE DEFECT THIS PINS ───────────────────────────────────────────────
    // The first cut of the carrier had exactly ONE `requestFrame` call site in
    // the whole production tree — at handshake. RFC 6143 §7.5.1: a server sends
    // an update ONLY when asked, so the live session delivered ONE screen and
    // then went permanently silent, while the backend kept re-rendering that
    // first frame as `partial: false`. That is the "stale screen reported
    // current" lie this ticket exists to kill, in its Windows form.
    const { server } = await runCarrierAgainstFixture({
      width: 16,
      height: 16,
      supports: [OPERATOR_RFB_ENCODING_HEXTILE],
      fill: () => [10, 20, 30],
      requestCoalesceMs: 0,
    });

    // The handshake alone asks once (the first, full frame).
    expect(server.updateRequests).toBe(1);

    // Arrival of that frame must schedule the NEXT request.
    await tick();
    expect(server.updateRequests).toBeGreaterThanOrEqual(2);

    // And it keeps going: every answered request schedules another, so the
    // stream is continuous rather than one-shot.
    const afterTwo = server.updateRequests;
    await tick();
    expect(server.updateRequests).toBeGreaterThan(afterTwo);
  });

  it('asks INCREMENTALLY after the first full frame (deltas, not whole screens)', async () => {
    // Request #1 must be non-incremental (nothing is held yet); every later one
    // incremental, which is what makes the server send just the DIRTY regions —
    // the CopyRect/Hextile path this slice exists to decode.
    const { server } = await runCarrierAgainstFixture({
      width: 16,
      height: 16,
      supports: [OPERATOR_RFB_ENCODING_HEXTILE],
      fill: () => [1, 2, 3],
      requestCoalesceMs: 0,
    });
    await tick();
    await tick();

    expect(server.incrementalFlags.length).toBeGreaterThanOrEqual(2);
    expect(server.incrementalFlags[0]).toBe(false);
    expect(server.incrementalFlags.slice(1).every((f) => f === true)).toBe(true);
  });

  it('COALESCES a many-chunk screen into one request, not one per chunk', async () => {
    // A 256x256 Raw screen arrives as several relay-sized chunks. Requesting
    // after each one would multiply request traffic by the chunk count for no
    // freshness gain — the coalescing window is the reason it does not.
    const { frames, server } = await runCarrierAgainstFixture({
      width: 256,
      height: 256,
      supports: [OPERATOR_RFB_ENCODING_RAW],
      fill: () => [4, 5, 6],
      requestCoalesceMs: 0,
    });
    await tick();
    // That screen really did arrive in more than one chunk…
    expect(frames.length).toBeGreaterThan(1);
    // …yet the request count stays well BELOW the chunk count: the coalescing
    // window collapses a multi-chunk screen into one request, which is the
    // property. (A per-chunk loop would be at least frames.length requests.)
    expect(server.updateRequests).toBeLessThan(frames.length);
  });
});

describe('D2 — the carrier start is guarded SYNCHRONOUSLY (no thundering herd)', () => {
  const INDEX = SRC('windows-agent/src/index.ts');

  it('sets an in-flight flag BEFORE the first await', () => {
    // ── THE DEFECT THIS PINS ───────────────────────────────────────────────
    // `relayCarrier` was assigned only in `.then()`, while `startRelayCarrier`
    // runs from `pumpRelay` every 5 s. For the whole connect+handshake window
    // the guard `if (relayCarrier) return` was therefore inert: every tick
    // started ANOTHER carrier, opening another socket to 5900 and another relay
    // stream. The flag must be set synchronously, before `runRfbCarrier` is
    // called, or the guard does not guard.
    const startFn = INDEX.slice(INDEX.indexOf('function startRelayCarrier'));
    const body = startFn.slice(0, startFn.indexOf('\n}\n') + 1);

    // The guard consults BOTH the running carrier and the in-flight flag.
    expect(body).toMatch(/if\s*\(relayCarrier\s*\|\|\s*relayCarrierStarting\)\s*return;/);
    // …and the flag is set BEFORE the dial, not after it resolves.
    const flagAt = body.indexOf('relayCarrierStarting = true;');
    const dialAt = body.indexOf('runRfbCarrier(');
    expect(flagAt).toBeGreaterThan(-1);
    expect(dialAt).toBeGreaterThan(-1);
    expect(flagAt).toBeLessThan(dialAt);
  });

  it('clears the flag on BOTH settle paths, so a retry is possible', () => {
    const startFn = INDEX.slice(INDEX.indexOf('function startRelayCarrier'));
    const body = startFn.slice(0, startFn.indexOf('\n}\n') + 1);
    // Two clears: the resolve path and the catch path. A flag left set on
    // failure would wedge the PC into never retrying, which is worse than the
    // duplicate-dial it was added to prevent.
    const clears = body.match(/relayCarrierStarting = false;/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT cache a failed carrier (the server may start later)', () => {
    const startFn = INDEX.slice(INDEX.indexOf('function startRelayCarrier'));
    const body = startFn.slice(0, startFn.indexOf('\n}\n') + 1);
    // A dead carrier cached in `relayCarrier` would make `startRelayCarrier`
    // return forever, so a PC whose RFB server was started a minute later could
    // never begin carrying.
    expect(body).toMatch(/carrier\.state === 'failed'/);
  });
});

// ── D3: the new config is documented, and the defaults match the code ──────

describe('D3 — DIGBY_RFB_HOST / DIGBY_RFB_PORT are documented and truthful', () => {
  const README = SRC('windows-agent/README.md');
  const INDEX = SRC('windows-agent/src/index.ts');

  it('the README documents both env vars with the port the code actually uses', () => {
    // The carrier introduced two env vars. Undocumented config is a defect of
    // its own: an operator whose RFB server is not on 5900 has no way to find
    // out that DIGBY_RFB_PORT exists.
    expect(README).toContain('DIGBY_RFB_HOST');
    expect(README).toContain('DIGBY_RFB_PORT');
    // …and the documented default must be the one in the code (127.0.0.1:5900),
    // or the doc quietly lies.
    expect(INDEX).toContain("process.env.DIGBY_RFB_HOST || '127.0.0.1'");
    expect(INDEX).toContain('process.env.DIGBY_RFB_PORT || 5900');
    expect(README).toMatch(/`DIGBY_RFB_HOST`\s*\|\s*`127\.0\.0\.1`/);
    expect(README).toMatch(/`DIGBY_RFB_PORT`\s*\|\s*`5900`/);
  });

  it('the README states the security-type limit (None only, VncAuth refused)', () => {
    // The honest limit, documented: a reader must not assume password auth
    // works because the product normally expects it.
    expect(README).toMatch(/VncAuth/);
    expect(README).toMatch(/security type 1/i);
  });
});

// ── D3b: the documented ENCODING LIST matches what the code actually does ───

describe('D3b — the README documents the encodings the code really decodes', () => {
  const README = SRC('windows-agent/README.md');
  const VIEWER = SRC('backend/src/modules/crossmodel/imessage/relay-operator-viewer.ts');

  it('every advertised encoding is named in the README', () => {
    // The D3 pattern applied to encodings: the advertisement is a behaviour, so
    // an operator reading the README must be able to see what the host may send
    // back. A README that still said "Tight is refused" would describe the
    // OPPOSITE of what this client now does.
    for (const enc of RFB_CLIENT.advertisedEncodings()) {
      if (enc === RFB_CLIENT.RFB_ENCODING_TIGHT) expect(README).toContain('Tight');
      if (enc === RFB_CLIENT.RFB_ENCODING_HEXTILE) expect(README).toContain('Hextile');
      if (enc === RFB_CLIENT.RFB_ENCODING_COPY_RECT) expect(README).toContain('CopyRect');
      if (enc === RFB_CLIENT.RFB_ENCODING_RAW) expect(README).toContain('Raw');
      if (enc === RFB_CLIENT.RFB_ENCODING_DESKTOP_SIZE) expect(README).toContain('DesktopSize');
      if (enc === RFB_CLIENT.RFB_ENCODING_LAST_RECT) expect(README).toContain('LastRect');
    }
  });

  it('the README documents Tight as SUPPORTED, not refused', () => {
    // The specific reversal this slice makes. The pre-slice README said
    // "Tight / RRE / TRLE / ZRLE are not decoded" — true then, false now.
    expect(README).toMatch(/decodeTightRect/);
    // …and RRE/TRLE/ZRLE must STILL be documented as refused, because they are.
    expect(README).toMatch(/TRLE/);
    expect(README).toMatch(/ZRLE/);
    expect(README).toMatch(/not decoded/i);
    // The persistence property is the non-obvious one an operator debugging a
    // blank screen needs; documenting it is the difference between "codec bug"
    // and "your host restarted its stream".
    expect(README).toMatch(/persist across rectangles/i);
  });


  it('the decoder really implements the filters the README claims', () => {
    // The pin above only checks prose. This one checks the SOURCE, so the README
    // cannot promise a filter the decoder does not have.
    for (const fn of ['decodeTightRect', 'tightPayloadBytes', 'createTightStreams']) {
      expect(VIEWER).toContain(`export function ${fn}`);
    }
    expect(VIEWER).toContain('OPERATOR_TIGHT_FILTER_PALETTE');
    expect(VIEWER).toContain('OPERATOR_TIGHT_FILTER_GRADIENT');
    expect(VIEWER).toContain('OPERATOR_TIGHT_FILTER_COPY');
  });
});

// ── Finding 4: the DECODED size has its own ceiling ────────────────────────

describe('B4 — a Hextile rect cannot exhaust memory (decoded size is not wire size)', () => {
  it('refuses a rect whose DECODED size passes the framebuffer ceiling', () => {
    // The reviewer measured a 0.67 MB Hextile payload decoding to 137 MB and
    // spiking RSS 145 MB — inside every PAYLOAD cap, over the FRAMEBUFFER cap,
    // and reported as a healthy rect with `snapshot: null`. The exported helper
    // must be safe on its own, so this calls it directly.
    const payload = Buffer.alloc(64, 0x01);
    const decoded = decodeHextileToWirePixels(payload, 6000, 6000);
    expect(decoded).toBeNull();
  });

  it('does not throw RangeError on an absurd 65535x65535 header', () => {
    // 65535*65535*4 = 17 GB. A `Buffer.alloc` here throws RangeError out of a
    // socket callback; a refusal is the only acceptable answer.
    const payload = Buffer.alloc(64, 0x01);
    expect(() => decodeHextileToWirePixels(payload, 65535, 65535)).not.toThrow();
    expect(decodeHextileToWirePixels(payload, 65535, 65535)).toBeNull();
  });

  it('halts the STREAM on such a rect — it is a refusal, not a silent skip', () => {
    const head = Buffer.alloc(16);
    head.writeUInt8(0, 0);
    head.writeUInt16BE(1, 2);
    head.writeUInt16BE(0, 4);
    head.writeUInt16BE(0, 6);
    head.writeUInt16BE(6000, 8);
    head.writeUInt16BE(6000, 10);
    head.writeInt32BE(OPERATOR_RFB_ENCODING_HEXTILE, 12);

    const decoder = new OperatorScreenDecoder();
    const events = decoder.push(Buffer.concat([head, Buffer.alloc(64, 0x01)]));
    const desync = events.find((e) => e.type === 'desync') as
      | { type: string; reason: string; detail?: string }
      | undefined;
    expect(desync).toBeTruthy();
    expect(desync!.reason).toBe('rect-too-large');
    expect(decoder.isHalted).toBe(true);
  });

  it('still decodes a legitimate screen under the ceiling', () => {
    // The guard must not be so eager it refuses real screens: 1920x1200 is
    // 9.2 MB, comfortably inside 128 MB.
    const w = 1920;
    const h = 1200;
    const tiles: Buffer[] = [];
    const colour = Buffer.from([0x00, 0xc8, 0x64, 0x00]); // BB GG RR 00
    for (let ty = 0; ty < h; ty += 16) {
      for (let tx = 0; tx < w; tx += 16) {
        const tw = Math.min(16, w - tx);
        const th = Math.min(16, h - ty);
        tiles.push(Buffer.from([0x01]), Buffer.concat(Array(tw * th).fill(colour)));
      }
    }
    const decoded = decodeHextileToWirePixels(Buffer.concat(tiles), w, h);
    expect(decoded).not.toBeNull();
    expect(decoded!.length).toBe(w * h * 4);
  });
});

// ── D1 must stay intact: this fix must not loosen the merged guarantee ─────

describe('D1 — the merged partial/staleness guarantee is untouched', () => {
  it('a chunk that begins mid-message is NOT a message start', async () => {
    const { frames } = await runCarrierAgainstFixture({
      width: 16,
      height: 16,
      supports: [OPERATOR_RFB_ENCODING_HEXTILE],
      fill: () => [9, 9, 9],
    });
    const bytes = carriedBytes(frames);
    // Every byte after the first is a continuation, and must not be mistaken
    // for the head of an update — that predicate is what the D1 fix relies on.
    expect(operatorFrameStartsUpdate(bytes.subarray(1))).toBe(false);
  });

  it('refuses an encoding it cannot frame instead of guessing (fail-loud kept)', () => {
    // LastRect proves the halt path is still live after the Hextile work: a
    // stream we cannot walk must STOP, because a resynchronised RFB stream
    // would paint plausible garbage into a live screen.
    const head = Buffer.alloc(16);
    head.writeUInt8(0, 0);
    head.writeUInt16BE(1, 2);
    head.writeUInt16BE(0, 4);
    head.writeUInt16BE(0, 6);
    head.writeUInt16BE(4, 8);
    head.writeUInt16BE(4, 10);
    head.writeInt32BE(16, 12); // ZRLE — not implemented

    const decoder = new OperatorScreenDecoder();
    const events = decoder.push(head);
    const desync = events.find((e: { type: string }) => e.type === 'desync');
    expect(desync).toBeTruthy();
    expect((desync as { reason: string }).reason).toBe('unsupported-encoding');
    expect(decoder.isHalted).toBe(true);
  });
});