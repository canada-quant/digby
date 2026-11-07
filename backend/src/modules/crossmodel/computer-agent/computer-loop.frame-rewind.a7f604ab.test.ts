/**
 * Ticket a7f604ab — a probe-triggered rewind must never re-serve a stale frame
 * as the current screen, and every served frame must carry provenance.
 *
 * THE DEFECT (as filed, with the sibling ticket 0d4dfdeb naming the same two
 * surfaces):
 *   `computer_task` attempts against one correctly-pinned device served frames
 *   whose taskbar clocks read 10/25/2026, 2/6/2026 and "no readable clock"
 *   inside one hour, against an owner-measured 11/6/2026. The device PIN was
 *   proven correct by the separate 2d461d80 fix, so those could not be another
 *   machine's pixels: they were OLDER frames of the same box re-presented as
 *   current. The close of 2d461d80 explicitly recorded this surface as NOT
 *   fixed, and there was no per-frame provenance anywhere in the result — so a
 *   caller could not machine-prove freshness even when content looked
 *   plausible, and the peruse attempt had to go VOID.
 *
 * THE CAUSE (this test pins it):
 *   In the write-path watchdog probe, the post-Escape capture was treated as
 *   the probe frame, with a fallback when it produced no frame:
 *
 *     probeFrame = (p2.ok && p2.screenshotBase64) ? p2
 *                : lastLegObs?.screenshotBase64 ? lastLegObs : null;
 *
 *   `lastLegObs` is a frame captured SEVERAL dispatches earlier (an earlier
 *   probe leg, a focus restore). Everything downstream then treated it as the
 *   live screen: emitted `screenshotFrame(probeFrame, live: true)`, handed to
 *   the vision model captioned "Screenshot after … and the harness probe …
 *   click in THIS pixel space" (so the model's next click used stale
 *   coordinates), and adopted as the dead-input watchdog baseline.
 *
 * THE CONTRACT THIS PINS:
 *   1. Every frame carries `frame` provenance: a monotonic session `seq`, the
 *      HARNESS-clock `capturedAt`, and the paired device that produced it.
 *      A frame served later with a LOWER seq than one already seen is provably
 *      a rewind.
 *   2. A frame is `live` ONLY when it is the freshest capture the session took.
 *      A re-served older frame is labelled `replay: true` with its wall-clock
 *      age and a reason, and is NEVER emitted `live: true`.
 *   3. The model is told plainly that the pixels are STALE and that it must
 *      not click in their pixel space.
 *   4. The attempt result exposes the replay count (`probeFrameReplays`) and a
 *      `frameProvenance` summary, so a lane can VOID deterministically.
 */
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../imessage/imessage.service", () => ({
  listAgents: jest.fn(),
  agentDisplayName: (a: any) => a?.label || a?.deviceName || "Mac",
  isOnline: jest.fn(),
}));
jest.mock("../imessage/agent-link", () => ({
  agentBroker: { dispatch: jest.fn() },
}));
jest.mock("./vision-client", () => ({
  visionChat: jest.fn(),
  visionConfigured: jest.fn(() => true),
}));
jest.mock("./use-lock", () => ({
  acquireComputerUseLock: jest.fn(),
  releaseComputerUseLock: jest.fn(),
  LOCK_TTL_MARGIN_MS: 120_000,
}));

import { runComputerAgentSession } from "./computer-loop";
import { agentBroker } from "../imessage/agent-link";
import { listAgents, isOnline } from "../imessage/imessage.service";
import { visionChat, visionConfigured } from "./vision-client";
import { acquireComputerUseLock } from "./use-lock";

const mockListAgents = listAgents as jest.Mock;
const mockIsOnline = isOnline as jest.Mock;
const mockDispatch = agentBroker.dispatch as jest.Mock;
const mockVisionChat = visionChat as jest.Mock;
const mockVisionConfigured = visionConfigured as jest.Mock;
const mockAcquireLock = acquireComputerUseLock as jest.Mock;

const agentRow = () => ({
  id: "agent-1",
  userId: "user-1",
  label: "STANNE-MSI",
  deviceId: "device-win-1",
  isDefault: true,
  agentVersion: "0.9.4",
  lastSeenAt: new Date(),
});

/** A content-rich frame (~0.18 bpp, the 6f4f8b36 calibration) so byte-identity
 *  is real dead-input evidence rather than a capture blip. */
const RICH = {
  ok: true,
  screenshotBase64: "RnJhbWUx".repeat(46000),
  imageWidth: 1568,
  imageHeight: 980,
  screenWidth: 1512,
  screenHeight: 982,
};
/** Same box, same app: an INERT capture (identical bytes, unchanged frontmost). */
const F = { ...RICH, frontmostApp: "Finder" };
const OK = { ok: true };
/** A dispatch the device refused: reached the device, no frame, no effect. */
const REFUSED = { ok: false, error: "computer_key refused: hotkey unavailable" };

const baseInput = () => ({
  userId: "user-1",
  chatId: null,
  message: "Open TextEdit and type a note",
  sendEvent: jest.fn(),
});

const fnCall = (
  name: string,
  args: Record<string, unknown>,
  callId = `call_${Math.random().toString(36).slice(2, 8)}`,
) => ({ callId, name, arguments: JSON.stringify(args) });

/** Every `computer-observation` event the harness emitted, in order. */
const observations = (input: ReturnType<typeof baseInput>): any[] =>
  input.sendEvent.mock.calls
    .filter((c: any[]) => c[0] === "computer-observation")
    .map((c: any[]) => c[1]);

/** The text of the nth vision call's input (what the MODEL actually read). */
const modelText = (n: number): string =>
  JSON.stringify(mockVisionChat.mock.calls[n]?.[0]?.input ?? "");

/** The caption attached to the NEWEST frame in the nth vision call — the one
 *  instruction the model acts on. Scoped deliberately: the full input history
 *  legitimately contains earlier (live) captions, so a whole-string assertion
 *  would prove nothing about the frame under test. */
const newestFrameCaption = (n: number): string => {
  const input: any[] = mockVisionChat.mock.calls[n]?.[0]?.input ?? [];
  for (let i = input.length - 1; i >= 0; i--) {
    const content = input[i]?.content;
    if (!Array.isArray(content)) continue;
    if (!content.some((c: any) => c?.type === "input_image")) continue;
    const text = content.find((c: any) => c?.type === "input_text")?.text;
    if (typeof text === "string") return text;
  }
  return "";
};

beforeEach(() => {
  jest.clearAllMocks();
  mockVisionConfigured.mockReturnValue(true);
  mockIsOnline.mockReturnValue(true);
  mockListAgents.mockResolvedValue([agentRow()]);
  mockAcquireLock.mockResolvedValue("lock-token-1");
});

describe("a7f604ab — probe rewind is labelled, never served as live", () => {
  it("REPLAY: the post-Escape capture returns NO frame, so the probe re-serves an OLDER leg frame ⇒ it is marked replay (with age + reason), never live:true, and the model is told the pixels are STALE", async () => {
    mockDispatch
      // ── normal steps: two inert input actions ⇒ strike 2 ⇒ probe ──
      .mockResolvedValueOnce(F) // initial screenshot (seq 1)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type a ⇒ strike 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type b ⇒ strike 2 ⇒ probe
      // ── the probe ──
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // leg 1 (Cmd+Space) ⇒ CONCLUSIVE, inert ⇒ lastLegObs
      .mockResolvedValueOnce(REFUSED) // leg 2 (Cmd+Tab) REFUSED ⇒ inconclusive ⇒ probe stops
      .mockResolvedValueOnce(REFUSED); // Escape cleanup ⇒ NO FRAME ⇒ the rewind this ticket is about
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Could not verify the screen." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);

    // ── 1. THE CALLER-VISIBLE MARKER: a screenshot event exists for the
    //       re-served frame and it says replay, NOT live.
    const shotEvents = observations(input).filter((o) => o.action === "screenshot");
    const replayEvents = shotEvents.filter((o) => o.replay === true);
    expect(replayEvents).toHaveLength(1);
    const replay = replayEvents[0];
    // The whole point: the old code emitted this frame with `live: true`.
    expect(replay.live).not.toBe(true);
    expect(replay.live).toBeUndefined();

    // ── 2. PROVENANCE on the frame: a sequence, a harness capture clock, and
    //       the paired device that produced those pixels.
    expect(replay.frame).toMatchObject({
      deviceId: expect.anything(),
      device: expect.anything(),
    });
    expect(typeof replay.frame.seq).toBe("number");
    expect(replay.frame.seq).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(replay.frame.capturedAt))).toBe(false);
    expect(replay.frame.replayReason).toEqual(expect.stringContaining("NOT the current screen"));
    expect(typeof replay.frame.replayAgeMs).toBe("number");
    expect(replay.frame.replayAgeMs).toBeGreaterThanOrEqual(0);

    // ── 3. Every REAL capture also carries provenance (seq monotonic, never
    //       reused): the rewind is only provable because the served seq can be
    //       compared against the ones already seen.
    const liveShots = shotEvents.filter((o) => o.replay !== true && o.live === true);
    expect(liveShots.length).toBeGreaterThan(0);
    const seqs = liveShots.map((o) => o.frame.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // non-decreasing
    expect(new Set(seqs).size).toBe(seqs.length); // no seq ever reused
    // …and the replayed frame is NOT one of the live seqs (it is behind them).
    expect(seqs).not.toContain(replay.frame.seq);

    // ── 4. THE MODEL is told plainly: stale, not the current screen, and the
    //       "click in THIS pixel space" instruction is WITHDRAWN.
    const captionAfterProbe = newestFrameCaption(2);
    expect(captionAfterProbe).toContain("STALE FRAME");
    expect(captionAfterProbe).toContain("NOT THE CURRENT SCREEN");
    expect(captionAfterProbe).toContain("Do NOT click in this image's pixel space");
    expect(captionAfterProbe).not.toContain("click in THIS pixel space");

    // ── 5. THE RESULT lets a lane VOID deterministically.
    expect(r.harness).toMatchObject({ probeFrameReplays: 1 });
    expect(r.frameProvenance).toMatchObject({
      replays: 1,
      device: "STANNE-MSI",
      platform: "macos",
    });
    expect(r.frameProvenance!.frames).toBeGreaterThanOrEqual(4);
    expect(Number.isNaN(Date.parse(r.frameProvenance!.lastCapturedAt!))).toBe(false);
  });

  it("CONTROL: when the probe's own Escape capture DOES return a frame it is the newest capture, served live with provenance and NO replay marker", async () => {
    mockDispatch
      .mockResolvedValueOnce(F) // initial (seq 1)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type a ⇒ 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type b ⇒ 2 ⇒ probe
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // leg 1 ⇒ conclusive, inert
      .mockResolvedValueOnce(REFUSED) // leg 2 REFUSED ⇒ inconclusive
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F); // Escape cleanup ⇒ a FRESH frame
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Stopped." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);

    // No rewind happened, so nothing is replayed…
    expect(observations(input).filter((o) => o.replay === true)).toHaveLength(0);
    expect(r.harness).toMatchObject({ probeFrameReplays: 0 });
    expect(r.frameProvenance?.replays).toBe(0);

    // …the probe frame IS served as the live screen, and it is the newest seq.
    const probeShot = observations(input)
      .filter((o) => o.action === "screenshot" && o.live === true)
      .pop();
    expect(probeShot).toBeDefined();
    expect(probeShot!.frame.seq).toBe(r.frameProvenance!.frames);

    // …and the model gets the ordinary, actionable caption.
    const controlCaption = newestFrameCaption(2);
    expect(controlCaption).toContain("click in THIS pixel space");
    expect(controlCaption).not.toContain("STALE FRAME");
  });

  it("the replayed frame never becomes the dead-input watchdog baseline (a stale baseline would corrupt every later strike)", async () => {
    // Same rewind as the first case, but the probe has already failed: the
    // session ends on the dead-input verdict. The assertion is about the
    // BASELINE: the replay must not be adopted for grading.
    mockDispatch
      .mockResolvedValueOnce(F) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type a ⇒ 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type b ⇒ 2 ⇒ probe
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // leg 1 ⇒ conclusive, inert
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // leg 2 ⇒ conclusive, inert ⇒ EVERY leg inert
      .mockResolvedValueOnce(REFUSED); // Escape ⇒ no frame ⇒ rewind
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);

    // The probe settled on the strict dead-input verdict…
    expect(r.finalResponse).toContain("EVERY leg produced a byte-identical frame");
    expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 0, probeFrameReplays: 1 });
    // …and the rewind is still labelled on the wire, never live.
    const replayEvents = observations(input).filter((o) => o.replay === true);
    expect(replayEvents).toHaveLength(1);
    expect(replayEvents[0].live).toBeUndefined();
    // The frame geometry recorded by the harness is the REAL captured one, not
    // a stale frame adopted after the rewind.
    expect(r.harness!.frameGeometry).toBe("1568×980");
  });
});

describe("a7f604ab — provenance is a property of the frame, not of a caption", () => {
  it("two frames of the SAME pixels from the SAME device still get distinct, increasing seqs (the property a rewind is detected by)", async () => {
    const DISTINCT = { ...RICH, screenshotBase64: "RnJhbWUy".repeat(46000) };
    mockDispatch
      .mockResolvedValueOnce(F) // seq 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(DISTINCT) // seq 2 — a visible change
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(DISTINCT); // seq 3 — inert
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Done." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);

    const seqs = observations(input)
      .filter((o) => o.action === "screenshot" && o.frame)
      .map((o) => o.frame.seq);
    // Strictly increasing: identity of pixels is irrelevant to identity of
    // capture, which is exactly what makes a rewind detectable.
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(r.frameProvenance!.frames).toBe(Math.max(...seqs));
    // Every frame names its producing device — never a platform-derived caption.
    for (const o of observations(input).filter((x) => x.action === "screenshot" && x.frame)) {
      expect(o.frame.device).toBe("STANNE-MSI");
      expect(o.frame.platform).toBe("macos");
    }
  });
});