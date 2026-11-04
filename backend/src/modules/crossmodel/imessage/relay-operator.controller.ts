/**
 * OPERATOR-SIDE RENDER ROUTES over the relay (ticket c468f922).
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT IS SEPARATE ────────────────────────────
 * `relay-dataplane.ts` carries frames and `relay-operator-viewer.ts` decodes
 * them. Neither answers the question the operator actually asks: *what is on
 * the screen right now?* This controller is that surface — it drains the
 * carried frames, renders them, and returns an image.
 *
 * It lives in its OWN file, not in `imessage.controller.ts`, for a mechanical
 * reason that is worth writing down: `agent-derail-break.9cc62eef.test.ts` pins
 * ABSOLUTE line windows of the main controller (236-243, 250-305, 1101-1110)
 * because that suite replays a real `read_file` incident against the real file.
 * Inserting ~150 lines at the relay section would slide the 1101-1110 window and
 * turn a green suite red for no behavioural reason. So the operator surface gets
 * its own module and the main controller keeps its line map.
 *
 * ── THE STATELESSNESS CONSTRAINT (this is the design) ───────────────────────
 * The backend runs as multiple containers behind an ALB. A per-session decoder
 * held in process memory would therefore render HALF a screen on one box and
 * nothing on the next — a bug that would only appear in production, under load,
 * and would look like "the screen flickers" rather than like a design error.
 *
 * So there is NO in-process decoder cache here. Every request re-decodes from
 * the frames still present in the session's Redis queue, which is shared by
 * every box. That is correct by construction: the queue holds up to
 * RELAY_QUEUE_MAX_FRAMES (256) and a fitted screen is at most
 * RELAY_SCREEN_FRAME_BUDGET (192) frames, so a whole screen is normally still
 * present.
 *
 * ── WHEN IT IS NOT (audit D1, 2026-11-02) ───────────────────────────────────
 * The paragraph above used to end "…the response says `partial: true`", and that
 * promise was NOT kept: `partial` was computed as `firstSeq > 1`, so a window
 * that overflowed the cap without ever being trimmed reported `false` while
 * showing a screen that could be several captures stale. The device, meanwhile,
 * had its remaining frames refused 429 forever because nothing ever freed a slot.
 *
 * Now the route renders the NEWEST screen that actually arrived whole, reports
 * `partial: true` with a named `partialReason` (`truncated-screen` /
 * `trimmed-window` / `no-coherent-message`), and — only while the queue is at its
 * cap — compacts the frames it has already superseded so the in-flight screen can
 * land. A stale picture is still a real picture; it is never labelled live.
 *
 * Below the cap this is a pure read: it never consumes or advances the operator's
 * cursor, so it can be polled repeatedly by a UI without stealing frames from the
 * consuming client. The compaction above is the single deliberate exception, and
 * it only ever drops frames older than the newest screen.
 */

import { Request, Response, NextFunction } from 'express';
import { listAgents } from './imessage.service';
import { agentPlatform } from './agent-capabilities';
import { remoteChannelFor } from './remote-access-verdict';
import {
  RELAY_CAPABILITY_HEADER,
  RELAY_MAX_FRAME_BYTES,
  RELAY_QUEUE_MAX_FRAMES,
  reasonForRelayRefusal,
  type RelayFrame,
  type RelayRefusal,
} from './relay-dataplane';
import { pollRelayFrames, pushRelayFrame, relayGate, trimRelayQueueBefore } from './relay-dataplane.store';
import {
  OperatorScreenDecoder,
  operatorFrameStartsUpdate,
  operatorFrameCompletesUpdate,
  type OperatorScreenSnapshot,
  chunkOperatorBytes,
  encodeOperatorKeyEvent,
  encodeOperatorPointerEvent,
  encodeOperatorScreenPng,
} from './relay-operator-viewer';

/** HTTP status for a relay refusal — the same mapping the main controller uses. */
function relayStatusFor(refusal: RelayRefusal): number {
  switch (refusal) {
    case 'wrong-device':
    case 'wrong-capability':
      return 403;
    case 'no-session':
      return 404;
    case 'frame-too-large':
      return 413;
    case 'queue-full':
      return 429;
    case 'not-open':
    case 'stale':
      return 409;
    case 'malformed':
    case 'capability-in-url':
    default:
      return 400;
  }
}

/**
 * Drain the session's `to-operator` queue in sequence order.
 *
 * `pollRelayFrames` clamps one call to RELAY_MAX_FRAMES_PER_POLL (32), while a
 * screen is up to 192 frames, so this loops on the cursor. The bound is the
 * queue ceiling: after RELAY_QUEUE_MAX_FRAMES frames there is nothing older to
 * find, because the store trims beyond it.
 */
async function drainOperatorFrames(sessionId: string): Promise<RelayFrame[]> {
  const out: RelayFrame[] = [];
  let cursor = 0;
  for (let guard = 0; guard < Math.ceil(RELAY_QUEUE_MAX_FRAMES / 32) + 1; guard++) {
    const page = await pollRelayFrames({ sessionId, direction: 'to-operator', after: cursor, limit: 32 });
    if (page.frames.length === 0) break;
    out.push(...page.frames);
    cursor = page.cursor;
    if (!page.more) break;
  }
  return out;
}

/** Why a rendered screen is `partial` — a name, never a bare boolean. */
export type OperatorPartialReason =
  /** Older frames were dropped from the window, so the decode did not start at
   *  the very beginning of what this session ever carried. */
  | 'trimmed-window'
  /** A NEWER screen is present but incomplete: the queue filled mid-send and the
   *  rest of its frames were refused. The screen returned is therefore STALE. */
  | 'truncated-screen'
  /** The window begins mid-message AND no whole update could be recovered. */
  | 'no-coherent-message';

interface RenderOutcome {
  snapshot: OperatorScreenSnapshot | null;
  decoder: OperatorScreenDecoder;
  firstSeq: number | null;
  partial: boolean;
  partialReason: OperatorPartialReason | null;
  framesSeen: number;
  /** How many leading frames were skipped to reach a decodable message start. */
  framesSkipped: number;
  /** The seq the successful decode started at, or null when nothing decoded. */
  decodedFromSeq: number | null;
  /** The seq of the newest update that was found but could not be completed. */
  truncatedFromSeq: number | null;
  /** Where a read-path compaction should keep from, or null when it must not. */
  keepFromSeq: number | null;
}

/** Decode `frames` starting at `from` with a fresh decoder. */
function decodeFrom(frames: RelayFrame[], from: number): OperatorScreenDecoder {
  const decoder = new OperatorScreenDecoder();
  for (let i = from; i < frames.length; i++) decoder.ingest(frames[i].payloadB64);
  return decoder;
}

interface FrameScan {
  bufs: Buffer[];
  /** Bytes available from frame i to the end of the window. */
  suffix: number[];
  /** Indices whose payload looks like the first chunk of an update message. */
  starts: number[];
  /** The newest start whose whole message fits inside the window. */
  newestComplete: number | null;
  /** The newest start of any kind — even one whose message does not fit yet. */
  newestStart: number | null;
}

/**
 * Locate message boundaries in the retained window, newest first.
 *
 * ── WHY THIS EXISTS AT ALL (audit D1, 2026-11-02) ───────────────────────────
 * `pushRelayFrame` refuses a push once the queue holds RELAY_QUEUE_MAX_FRAMES
 * and NEVER trims the head, so an un-consumed session's window is the FIRST 256
 * frames: the first screen whole, the next one cut off. Measured at 1920x1200 —
 * one screen is 141 frames, two are 282, so 26 frames of the second screen are
 * refused, and they are refused again on every retry because nothing frees a
 * slot. Before this fix the route decoded that window from frame 0, returned the
 * FIRST screen and called it COMPLETE (`partial: false` — the window really did
 * start at seq 1), so an operator watched a frozen picture the API swore was live
 * and the device could never deliver the newer one.
 *
 * `sendScreen` emits ONE rectangle covering the whole framebuffer, optionally
 * preceded by a DesktopSize pseudo-rect, and always chunks from byte 0 of that
 * screen's own buffer — so a screen's first chunk is structurally identifiable.
 * That is what makes both questions answerable without guessing: WHERE the
 * screens are, and WHICH one arrived whole.
 */
function scanFrames(frames: RelayFrame[]): FrameScan {
  const bufs = frames.map((f) => Buffer.from(f.payloadB64, 'base64'));
  const suffix = new Array<number>(bufs.length + 1).fill(0);
  for (let i = bufs.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + bufs[i].length;

  const starts: number[] = [];
  for (let i = 0; i < bufs.length; i++) {
    if (operatorFrameStartsUpdate(bufs[i])) starts.push(i);
  }
  const complete = starts.filter((i) => operatorFrameCompletesUpdate(bufs[i], suffix[i]));
  return {
    bufs,
    suffix,
    starts,
    newestComplete: complete.length ? complete[complete.length - 1] : null,
    newestStart: starts.length ? starts[starts.length - 1] : null,
  };
}

/**
 * Decode the frames and report what the operator can see.
 *
 * ── THE CONTRACT (rewritten by audit D1, 2026-11-02) ────────────────────────
 * Render the NEWEST COMPLETE screen in the window, and say plainly when that is
 * not the newest thing the device was sending. Two separate lies the first cut
 * told, both fixed here:
 *
 *  1. It rendered the window from frame 0. Under the queue's refuse-don't-trim
 *     discipline that is the FIRST screen of the window, which may be several
 *     screens behind — served with `partial: false`.
 *  2. `partial` was only ever `firstSeq > 1`. But a window that starts at seq 1
 *     because nothing was ever trimmed can still be missing the newest screen
 *     entirely (its frames were refused). Reporting "not partial" there is
 *     exactly backwards.
 *
 * `partial` now means "what you are looking at is not the whole, current
 * picture", and `partialReason` says which way it is incomplete. The screen
 * itself is always a real, whole framebuffer the device sent — never a partial
 * composite.
 */
function renderFrames(frames: RelayFrame[]): RenderOutcome {
  const firstSeq = frames.length ? frames[0].seq : null;

  // ── NO PIXELS YET IS NOT A FAULT (defect 2, caught in review) ─────────────
  // An empty queue is the documented NORMAL state — the device captures on a
  // ~25s tick, so a freshly opened session legitimately has nothing to render.
  // The first cut fell through every branch and reported
  // `partial: true / no-coherent-message` here, i.e. it described a device that
  // simply has not ticked yet as a codec desync, while the same body said
  // `reason: no-frames-yet`. Say "nothing yet" and say nothing more.
  if (frames.length === 0) {
    return {
      snapshot: null,
      decoder: new OperatorScreenDecoder(),
      firstSeq: null,
      partial: false,
      partialReason: null,
      framesSeen: 0,
      framesSkipped: 0,
      decodedFromSeq: null,
      truncatedFromSeq: null,
      keepFromSeq: null,
    };
  }

  const scan = scanFrames(frames);

  // ── Render the newest screen that actually arrived whole. ──
  //
  // ── WHY `partial` IS NOT "skipped something" (defect 1, caught in review) ──
  // The first cut gated the healthy path on the head decode being the ONLY
  // update in the window (`newestComplete === 0 && newestStart === 0`). But a
  // device sending every ~25s means the window normally holds SEVERAL whole
  // screens, so that condition was almost never true: every poll after the
  // device's second capture fell through with `skippedHead` set and reported
  // `partial: true / trimmed-window` even though nothing had been trimmed and
  // the rendered screen was perfectly current. Measured on the pre-fix branch:
  // `1280x800 x2 -> partial=true reason=trimmed-window`, same for x3 and for
  // `1920x1200 x2`. The original defect was a route that called a STALE screen
  // complete; that fix must not replace it with a route that calls a CURRENT
  // screen stale, or every UI watching this endpoint sits on a permanent
  // "stale" banner.
  //
  // So the two questions are now answered separately, which is what they always
  // were:
  //   * STALENESS — is there a newer screen we could not complete? (`truncated`)
  //   * HISTORY   — did frames ever go missing from the start of the session?
  //                 (`historyTrimmed`, i.e. firstSeq > 1: the store's push-time
  //                 trim really did drop the head)
  // Skipping older COMPLETE screens is neither: it is what "render the newest"
  // means, and it costs freshness in no way.
  const from = scan.newestComplete;
  const renderFrom = from !== null ? from : 0;
  const decoder = renderFrom === 0 ? decodeFrom(frames, 0) : decodeFrom(frames, renderFrom);
  const snapshot = decoder.snapshot();

  if (decoder.isHalted || snapshot === null) {
    // Nothing in the window is a whole decodable screen. If a start IS present
    // whose frames were refused, this is a screen still in flight — name that,
    // because `unknown-message-type` sends an operator hunting a codec bug when
    // the real condition is "poll again in a moment".
    const inFlight = scan.newestStart !== null;
    return {
      snapshot,
      decoder,
      firstSeq,
      partial: true,
      partialReason: inFlight ? 'truncated-screen' : 'no-coherent-message',
      framesSeen: frames.length,
      framesSkipped: 0,
      decodedFromSeq: null,
      truncatedFromSeq: inFlight ? frames[scan.newestStart!].seq : null,
      keepFromSeq: inFlight ? frames[scan.newestStart!].seq : null,
    };
  }

  // ── A WINDOW THAT ENDS MID-MESSAGE IS NOT CURRENT (Windows slice) ─────────
  // `pushed` bytes the decoder never consumed mean the last message in the
  // window was cut off: the device was still sending when the queue filled. A
  // screen built from base + deltas is therefore one update behind, and calling
  // that complete is the D1 lie in its Windows form.
  //
  // This is the signal that works for BOTH stream shapes. The frame-index rule
  // below only fires when a whole screen starts after the render point, which is
  // exactly the shape a delta-coded stream does not have — so a Windows window
  // truncated mid-delta would otherwise be served as `partial: false`.
  const endsMidMessage = decoder.pending > 0;
  const truncated =
    endsMidMessage || (scan.newestStart !== null && from !== null && scan.newestStart > from);
  const historyTrimmed = firstSeq !== null && firstSeq > 1;
  const partialReason: OperatorPartialReason | null = truncated
    ? 'truncated-screen'
    : historyTrimmed
      ? 'trimmed-window'
      : null;
  // Where the cut-off screen begins. The frame-index answer is precise when a
  // whole screen started after the render point; for a delta stream the cut is
  // the window's own tail, so the last frame the device got through is named.
  const truncatedFromSeq = truncated
    ? scan.newestStart !== null && from !== null && scan.newestStart > from
      ? frames[scan.newestStart].seq
      : frames[frames.length - 1].seq
    : null;

  return {
    snapshot,
    decoder,
    firstSeq,
    partial: partialReason !== null,
    partialReason,
    framesSeen: frames.length,
    framesSkipped: renderFrom,
    decodedFromSeq: frames[renderFrom].seq,
    // ── NEVER DEREFERENCE `newestStart` WHEN IT IS NULL (finding 3) ─────────
    // `truncated` is `endsMidMessage || (newestStart !== null && …)`. The first
    // disjunct alone makes `truncated` true while `newestStart` is STILL NULL —
    // which is exactly the shape of a delta-coded Windows stream that ends
    // part-way through a Hextile rectangle. The previous `frames[newestStart!]`
    // therefore threw `TypeError: Cannot read properties of undefined (reading
    // 'seq')` on that stream, and because `renderFrames` is called outside the
    // controller's try/catch the operator got a 500 instead of the honest
    // `partial: true / truncated-screen` verdict this route exists to give.
    //
    // The shipped e2e missed it because its only truncation fixture cuts a RAW
    // rect short, and a truncated Raw rect still leaves a strict `newestStart`.
    // So the crash needed precisely the new feature's own encoding.
    //
    // `truncatedFromSeq` above is already computed for both shapes, so both
    // fields now read from it rather than re-deriving an unsafe index.
    truncatedFromSeq,
    // ── WHAT A COMPACTION MAY DROP (defect 3, caught in review) ─────────────
    // The queue is RELIEVED only when it is at the cap (the controller checks
    // that), and the frames to drop are the ones this render has SUPERSEDED: the
    // screens older than what the operator is now looking at.
    //
    // This is why `keepFromSeq` is the render start and not "null when healthy":
    // a full queue holding two complete screens would otherwise free nothing,
    // and since `pushRelayFrame` refuses at the cap BEFORE pushing, the device
    // could never even start its next screen. Pointing at the newest complete
    // screen keeps exactly what is rendered and gives the rest back.
    keepFromSeq: truncated
      ? (truncatedFromSeq ?? frames[0].seq)
      : renderFrom > 0
        ? frames[renderFrom].seq
        : null,
  };
}

/** Shared preamble: resolve the device, then run the three relay gates. */
async function gateOperator(
  req: Request,
  res: Response,
): Promise<{ agentId: string; sessionId: string } | null> {
  const id = String(req.params.id || '');
  const agents = await listAgents(req.user!.id);
  const agent = agents.find((a: { id: string }) => a.id === id);
  if (!agent) {
    res.status(404).json({ success: false, error: 'No such paired Mac' });
    return null;
  }
  // A credential in a URL is in an access log before this line runs. Same
  // refusal as the main controller — silently ignoring it would leave the
  // secret logged while the caller debugged somewhere else.
  if (req.query.capability !== undefined) {
    res.status(400).json({
      success: false,
      error: reasonForRelayRefusal('capability-in-url'),
      code: 'capability-in-url',
    });
    return null;
  }
  const sessionId = String(req.body?.sessionId ?? req.query.sessionId ?? '');
  const refusal = await relayGate({
    agentId: agent.id,
    sessionId,
    channel: remoteChannelFor(agentPlatform(agent)),
    capability: String(req.headers[RELAY_CAPABILITY_HEADER] || ''),
  });
  if (refusal) {
    res.status(relayStatusFor(refusal)).json({
      success: false,
      error: reasonForRelayRefusal(refusal),
      code: refusal,
    });
    return null;
  }
  return { agentId: agent.id, sessionId };
}

class RelayOperatorController {
  /**
   * GET /imessage/agents/:id/relay/screen — RENDER the session's carried screen.
   *
   * Returns the rendered screen as JSON metadata plus a PNG data URI, or as raw
   * PNG bytes with `?format=png`. This is the endpoint that turns a carried
   * byte stream into something an operator can look at.
   */
  async getScreen(req: Request, res: Response, next: NextFunction) {
    try {
      const gated = await gateOperator(req, res);
      if (!gated) return;

      const frames = await drainOperatorFrames(gated.sessionId);
      const outcome = renderFrames(frames);
      const {
        snapshot,
        decoder,
        firstSeq,
        partial,
        partialReason,
        framesSeen,
        framesSkipped,
        decodedFromSeq,
        truncatedFromSeq,
        keepFromSeq,
      } = outcome;

      // ── RELIEVE THE QUEUE WHEN IT IS FULL (audit D1, 2026-11-02) ──────────
      // `pushRelayFrame` REFUSES a push once the queue holds
      // RELAY_QUEUE_MAX_FRAMES and never trims the head on the write side, so a
      // device streaming with no consumer wedges permanently: measured at
      // 1920x1200, one screen is 141 frames and two are 282 against a 256 cap,
      // so the second screen's last 26 frames are refused — and refused again on
      // every retry, because nothing ever frees a slot. The operator then sees
      // the FIRST screen for all time, which the route called COMPLETE.
      //
      // `keepFromSeq` is the compaction point, and it is deliberately NOT the
      // decode start: it is the START OF THE IN-FLIGHT SCREEN, so the frames
      // dropped are the older screen(s) the operator has already been shown. That
      // gives the device room to finish the newer send instead of staying wedged.
      //
      // Fires ONLY under pressure (at/over the cap) and only when the render
      // actually identified a boundary, so the "rendering drains nothing"
      // guarantee holds for every normal read.
      let framesCompacted = 0;
      if (keepFromSeq !== null && frames.length >= RELAY_QUEUE_MAX_FRAMES) {
        framesCompacted = await trimRelayQueueBefore({
          sessionId: gated.sessionId,
          direction: 'to-operator',
          beforeSeq: keepFromSeq,
        });
      }

      // A desync is reported, never papered over: the operator is told the
      // stream could not be decoded rather than shown a stale or wrong picture.
      // After the D1 resync a halt here means NO retained window decoded — a
      // real fault, and now a distinguishable one.
      if (decoder.isHalted) {
        return res.status(409).json({
          success: false,
          error: `the carried screen stream could not be decoded: ${decoder.haltReasonCode}`,
          code: 'codec-desync',
          data: { reason: decoder.haltReasonCode, framesSeen, partialReason, framesSkipped },
        });
      }

      if (!snapshot) {
        // No pixels yet is a NORMAL state (the device sends on its ~25s tick),
        // so this is a 200 with a null screen, not an error the UI must handle.
        return res.json({
          success: true,
          data: {
            screen: null,
            framesSeen,
            firstSeq,
            partial,
            partialReason,
            framesSkipped,
            framesCompacted,
            truncatedFromSeq,
            reason: framesSeen === 0 ? 'no-frames-yet' : 'no-complete-frame-yet',
          },
        });
      }

      const png = encodeOperatorScreenPng(snapshot);

      if (String(req.query.format || '') === 'png') {
        // Raw bytes: a browser <img src> can point straight at this.
        res.setHeader('content-type', 'image/png');
        res.setHeader('cache-control', 'no-store');
        res.setHeader('x-digby-screen-sha256', snapshot.sha256);
        res.setHeader('x-digby-screen-size', `${snapshot.width}x${snapshot.height}`);
        // `partial` travels on the binary response as a HEADER too, or a
        // `?format=png` consumer — the <img src> path — could never learn it.
        res.setHeader('x-digby-screen-partial', partial ? partialReason || 'true' : 'false');
        return res.send(png);
      }

      res.json({
        success: true,
        data: {
          screen: {
            width: snapshot.width,
            height: snapshot.height,
            sha256: snapshot.sha256,
            rectsApplied: snapshot.rectsApplied,
            /** A PNG the UI can put straight in an <img src>. */
            image: `data:image/png;base64,${png.toString('base64')}`,
            bytes: png.length,
          },
          framesSeen,
          firstSeq,
          partial,
          partialReason,
          framesSkipped,
          framesCompacted,
          /** Where the successful decode began (null when nothing decoded). */
          decodedFromSeq,
          /** Set when a NEWER screen was present but its frames were refused. */
          truncatedFromSeq,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /imessage/agents/:id/relay/input — send ONE operator gesture.
   *
   * Body: { sessionId, kind: 'pointer'|'key', x?, y?, buttonMask?, keysym?, down? }
   *
   * The gesture is encoded into real RFB client bytes and pushed to the
   * device's `to-device` queue, where the agent's existing pump decodes it into
   * `pointer`/`key` actions and executes it. Coordinates are in the FITTED image
   * space the operator is looking at — which is exactly what the device primes
   * its geometry with (audit F2), so the click lands where it was aimed.
   */
  async postInput(req: Request, res: Response, next: NextFunction) {
    try {
      // The input route takes the capability from the header ONLY (same rule as
      // the read path); gateOperator enforces that and would 400 a query one.
      const gated = await gateOperator(req, res);
      if (!gated) return;

      const body = (req.body || {}) as Record<string, unknown>;
      const kind = body.kind === 'key' ? 'key' : body.kind === 'pointer' ? 'pointer' : null;
      if (!kind) {
        return res.status(400).json({
          success: false,
          error: "kind must be 'pointer' or 'key'",
          code: 'malformed',
        });
      }

      let bytes: Buffer;
      if (kind === 'pointer') {
        const x = Number(body.x);
        const y = Number(body.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          return res.status(400).json({
            success: false,
            error: 'pointer input needs a finite x and y',
            code: 'malformed',
          });
        }
        // Clamp to the RFB 16-bit field: wrapping a click onto the wrong pixel
        // is worse than a refused one — the operator would see a press land
        // somewhere they did not point.
        const cx = Math.max(0, Math.min(0xffff, Math.round(x)));
        const cy = Math.max(0, Math.min(0xffff, Math.round(y)));
        const mask = Number(body.buttonMask);
        bytes = encodeOperatorPointerEvent(Number.isFinite(mask) ? Math.round(mask) & 0xff : 0, cx, cy);
      } else {
        const keysym = Number(body.keysym);
        if (!Number.isFinite(keysym) || keysym <= 0) {
          return res.status(400).json({
            success: false,
            error: 'key input needs a positive keysym',
            code: 'malformed',
          });
        }
        bytes = encodeOperatorKeyEvent(Math.floor(keysym), body.down === true);
      }

      // Chunk at the BACKEND's ceiling, never a local guess: a frame over
      // RELAY_MAX_FRAME_BYTES is refused as frame-too-large and the operator
      // would see "my clicks stopped working" with nothing in the log.
      const payloads = chunkOperatorBytes(bytes, RELAY_MAX_FRAME_BYTES);
      const seqs: number[] = [];
      for (const payload of payloads) {
        const out = await pushRelayFrame({
          sessionId: gated.sessionId,
          direction: 'to-device',
          payloadB64: payload,
        });
        if (!out.ok) {
          return res.status(relayStatusFor(out.refusal)).json({
            success: false,
            error: reasonForRelayRefusal(out.refusal),
            code: out.refusal,
          });
        }
        seqs.push(out.frame.seq);
      }

      res.json({
        success: true,
        data: {
          kind,
          bytes: bytes.length,
          frames: payloads.length,
          seqs,
          /** Sent, not yet executed: the device drains on its next pump tick. */
          queued: true,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

/** Re-exported so the route module has one import for the controller. */
export const relayOperatorController = new RelayOperatorController();
export default relayOperatorController;