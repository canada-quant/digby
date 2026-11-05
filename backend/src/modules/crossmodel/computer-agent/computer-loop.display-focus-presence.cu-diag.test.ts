/**
 * cu-diag 2026-09-25 — computer-loop pieces of fix #1 (display geometry
 * forwarding + the focus-split notice) and fix #6 (owner-presence gate +
 * named busy refusal).
 *
 * THE INCIDENT (Pauls-MBP, 23:55Z–00:07Z): lid closed, the built-in LCD still
 * CG-main, a Dell at x=1728. The agent captured display 1 forever while
 * Cmd+Space → "TextEdit" → Return opened TextEdit on the Dell — agent_events
 * show frontmost flipping Terminal→TextEdit on a byte-identical frame. The
 * loop scored dead-input strikes; the supervisor told the owner keystrokes
 * were dead; tccd had allowed every event. Three drivers (two lanes, a
 * supervisor, the owner over Screen Sharing) shared the Mac that evening.
 *
 * Pins, both directions:
 *   - geometry/display fields ride the screenshot frame and the per-action
 *     computer-observation event; older agents (no fields) leave both shapes
 *     byte-identical;
 *   - a focus split (frontmostWindowDisplayId ≠ displayId) on an unchanged
 *     frame emits [FOCUS ON UNCAPTURED DISPLAY] and scores NO strike — three
 *     such actions do NOT abort; the same three on an older agent still do
 *     (the 6f4f8b36 watchdog is untouched);
 *   - the owner-presence gate turns a MACHINE run camera-only (recent human
 *     input or a remote session), notes-only for an interactive run, nothing
 *     for older agents, and flips mid-run;
 *   - a contended lock returns a STRUCTURED busy result naming the holder,
 *     and a winner records its own holder (chat id + lane).
 */

import { runComputerAgentSession, focusSplit, focusSplitNotice, ownerPresence, observationGeometry, FOCUS_SPLIT_TAG, sessionDeadline } from "./computer-loop";
import { formatComputerTaskToolResult } from "../tool-executor";
import { acquireComputerUseLock, releaseComputerUseLock, recordComputerUseHolder, describeComputerUseHolder } from "./use-lock";
import { agentBroker } from "../imessage/agent-link";
import { listAgents, isOnline } from "../imessage/imessage.service";
import { visionChat, visionConfigured } from "./vision-client";

jest.mock("../imessage/imessage.service", () => ({
  listAgents: jest.fn(),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || "Mac"),
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
  recordComputerUseHolder: jest.fn(),
  describeComputerUseHolder: jest.fn(),
  LOCK_TTL_MARGIN_MS: 120_000,
}));
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tool-executor pulls a wide import graph; the formatter is pure, so stub the
// heavy leaves it touches at module load.
jest.mock("../../../config/database", () => ({ __esModule: true, default: {} }));
jest.mock("../../../config/redis", () => ({ __esModule: true, default: {} }));

const mockListAgents = listAgents as jest.Mock;
const mockIsOnline = isOnline as jest.Mock;
const mockDispatch = agentBroker.dispatch as jest.Mock;
const mockVisionChat = visionChat as jest.Mock;
const mockVisionConfigured = visionConfigured as jest.Mock;
const mockAcquireLock = acquireComputerUseLock as jest.Mock;
const mockReleaseLock = releaseComputerUseLock as jest.Mock;
const mockRecordHolder = recordComputerUseHolder as jest.Mock;
const mockDescribeHolder = describeComputerUseHolder as jest.Mock;

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  userId: "user-1",
  label: "Pauls-MBP",
  deviceId: "device-1",
  isDefault: true,
  agentVersion: "0.6.1",
  lastSeenAt: new Date(),
  ...over,
});

// Content-rich frames (bpp ≈ 0.12 — above the 33401f39 floor so the byte-
// identity watchdog is ARMED, exactly the incident's bright-screen case).
const FRAME_A = "RnJhbWUx".repeat(46000);
const FRAME_B = "RnJhbWUy".repeat(46000);

/** A 0.6.1-agent screenshot: geometry + display + presence facts. */
const shot061 = (over: Record<string, unknown> = {}) => ({
  ok: true,
  screenshotBase64: FRAME_A,
  imageWidth: 1568,
  imageHeight: 1013,
  screenWidth: 1728,
  screenHeight: 1117,
  frontmostApp: "Terminal",
  displayId: 1,
  displayIndex: 1,
  displayCount: 2,
  displayName: "Color LCD",
  frontmostWindowDisplayId: 1,
  pointerDisplayId: 1,
  captureReason: "frontmost",
  hidIdleSeconds: 900,
  hidIdleRawSeconds: 900,
  remoteSession: { active: false, kinds: [] },
  ...over,
});

/** A pre-0.6.1 agent screenshot: no display / presence fields at all. */
const shotLegacy = (over: Record<string, unknown> = {}) => ({
  ok: true,
  screenshotBase64: FRAME_A,
  imageWidth: 1568,
  imageHeight: 1013,
  screenWidth: 1728,
  screenHeight: 1117,
  frontmostApp: "Terminal",
  ...over,
});

const baseInput = (over: Record<string, unknown> = {}) => ({
  userId: "user-1",
  chatId: "chat-77" as string | null,
  message: "Open TextEdit and type hello",
  sendEvent: jest.fn(),
  ...over,
});

const fnCall = (name: string, args: Record<string, unknown>, callId = `call_${Math.random().toString(36).slice(2, 8)}`) => ({
  callId,
  name,
  arguments: JSON.stringify(args),
});

const outputs = (input: any) =>
  (input.sendEvent.mock.calls as any[][]).map((c) => c[1]);

const visionInputsOf = (): any[][] => (mockVisionChat.mock.calls as any[]).map((c) => c[0].input);

beforeEach(() => {
  // resetAllMocks (not clearAllMocks): several replays end EARLY on purpose
  // (the watchdog abort), leaving queued mockResolvedValueOnce values that
  // clearAllMocks would let leak into the next test (learnings.md jest mock trap).
  jest.resetAllMocks();
  process.env.COMPUTER_SETTLE_MS = "0";
  delete process.env.OWNER_PRESENCE_IDLE_SEC;
  mockVisionConfigured.mockReturnValue(true);
  mockIsOnline.mockReturnValue(true);
  mockListAgents.mockResolvedValue([agentRow()]);
  mockAcquireLock.mockResolvedValue("lock-token-1");
  mockReleaseLock.mockResolvedValue(undefined);
  mockRecordHolder.mockResolvedValue(undefined);
  mockDescribeHolder.mockResolvedValue(null);
});

// ── pure helpers ─────────────────────────────────────────────────────────────

describe("pure helpers", () => {
  it("observationGeometry forwards exactly the 0.6.1 facts and nothing for a legacy shot", () => {
    expect(observationGeometry(shot061() as any)).toEqual({
      imageWidth: 1568, imageHeight: 1013, displayId: 1, displayCount: 2, displayIndex: 1, frontmostWindowDisplayId: 1, hidIdleSeconds: 900,
    });
    expect(observationGeometry(shotLegacy() as any)).toEqual({ imageWidth: 1568, imageHeight: 1013 });
  });

  it("focusSplit: both ids known and different → split; unknown → never a split", () => {
    expect(focusSplit({ displayId: 1, frontmostWindowDisplayId: 2 })).toBe(true);
    expect(focusSplit({ displayId: 1, frontmostWindowDisplayId: 1 })).toBe(false);
    expect(focusSplit({ displayId: 1, frontmostWindowDisplayId: null })).toBe(false);
    expect(focusSplit({})).toBe(false);
  });

  it("focusSplitNotice is loud, names both displays and the app, and says the unchanged frame is not evidence", () => {
    const n = focusSplitNotice({ displayId: 1, frontmostWindowDisplayId: 2, displayCount: 2, frontmostApp: "TextEdit" });
    expect(n.startsWith(FOCUS_SPLIT_TAG)).toBe(true);
    expect(n).toContain("[FOCUS ON UNCAPTURED DISPLAY]");
    expect(n).toContain("(TextEdit) is on display 2");
    expect(n).toContain("shows display 1 of 2");
    expect(n).toContain("NOT evidence that input failed");
  });

  it("ownerPresence: recent input or a remote session = active; unknown idle is NOT presence; window", () => {
    expect(ownerPresence({ hidIdleSeconds: 5 })).toEqual({ active: true, reason: "human input 5 s ago" });
    expect(ownerPresence({ hidIdleSeconds: 900 })).toMatchObject({ active: false });
    expect(ownerPresence({ hidIdleSeconds: null })).toEqual({ active: false, reason: "owner idle time unknown" });
    expect(ownerPresence({})).toMatchObject({ active: false });
    expect(ownerPresence({ hidIdleSeconds: 900, remoteSession: { active: true, kinds: ["screensharingd"] } })).toEqual({
      active: true, reason: "remote-control session attached (screensharingd)",
    });
    expect(ownerPresence({ hidIdleSeconds: 5, remoteSession: { active: true, kinds: ["teamviewer_desktop"] } }).reason)
      .toBe("human input 5 s ago; remote-control session attached (teamviewer_desktop)");
    process.env.OWNER_PRESENCE_IDLE_SEC = "3";
    expect(ownerPresence({ hidIdleSeconds: 5 })).toMatchObject({ active: false });
  });
});

// ── fix #1: geometry forwarding + focus split in the loop ────────────────────

describe("fix #1 — display geometry rides the frames and events", () => {
  it("the first frame and each action's frame carry width/height/displayId/… and the task text names the captured display", async () => {
    const input = baseInput();
    mockDispatch
      .mockResolvedValueOnce(shot061())                 // initial screenshot
      .mockResolvedValueOnce({ ok: true })              // click
      .mockResolvedValueOnce(shot061({ screenshotBase64: FRAME_B, frontmostApp: "TextEdit" })); // auto-screenshot
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 10, y: 10 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(input);
    const frames = outputs(input).filter((e) => e?.action === "screenshot" && e?.screenshotBase64);
    expect(frames.length).toBe(2);
    for (const f of frames) {
      expect(f).toMatchObject({ imageWidth: 1568, imageHeight: 1013, displayId: 1, displayCount: 2, displayIndex: 1, frontmostWindowDisplayId: 1, hidIdleSeconds: 900 });
    }
    const clickEvent = outputs(input).find((e) => e?.action === "click");
    expect(clickEvent).toMatchObject({ imageWidth: 1568, imageHeight: 1013, displayId: 1, displayCount: 2 });
    const taskText = visionInputsOf()[0][0].content[0].text as string;
    expect(taskText).toContain("Captured display: 1 of 2 (Color LCD).");
  });

  it("a legacy agent leaves the frame + event shapes without any display keys (byte-identical to before)", async () => {
    const input = baseInput();
    mockDispatch
      .mockResolvedValueOnce(shotLegacy())
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(shotLegacy({ screenshotBase64: FRAME_B }));
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 10, y: 10 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(input);
    for (const e of outputs(input)) {
      for (const k of ["displayId", "displayCount", "displayIndex", "frontmostWindowDisplayId", "hidIdleSeconds", "focusSplit"]) {
        expect(e).not.toHaveProperty(k);
      }
    }
    const taskText = visionInputsOf()[0][0].content[0].text as string;
    expect(taskText).not.toContain("Captured display");
  });
});

describe("fix #1 — focus split: unchanged frame of the WRONG display is not dead input", () => {
  /** The incident: three input actions, every post-action frame byte-identical
   *  to the baseline, but the frontmost window lives on display 2 while the
   *  agent captured display 1. */
  const splitRun = (input: any, shot: (o?: Record<string, unknown>) => any) => {
    mockDispatch.mockResolvedValueOnce(shot());
    for (let i = 0; i < 3; i++) {
      mockDispatch.mockResolvedValueOnce({ ok: true }); // key
      mockDispatch.mockResolvedValueOnce(shot({ frontmostApp: "TextEdit", frontmostWindowDisplayId: 2 })); // identical frame, focus elsewhere
    }
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "space", modifiers: ["cmd"] })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "TextEdit" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "TextEdit is open on the other display." })], text: "" });
  };

  it("incident replay (0.6.1 agent): [FOCUS ON UNCAPTURED DISPLAY] on each result, NO strikes, NO abort — the model's done is honored", async () => {
    const input = baseInput();
    splitRun(input, shot061);
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("TextEdit is open on the other display.");
    expect(r.finalResponse).not.toContain("Computer use stopped");
    // Every action's tool result carries the notice…
    const results = visionInputsOf().at(-1)!
      .filter((i: any) => i?.type === "function_call_output")
      .map((i: any) => JSON.parse(i.output));
    const splits = results.filter((o: any) => typeof o.focusSplit === "string");
    expect(splits.length).toBe(3);
    for (const o of splits) {
      expect(o.focusSplit).toContain("[FOCUS ON UNCAPTURED DISPLAY]");
      expect(o.noVisibleChange).toBeUndefined(); // never a strike
    }
    // …the user image message repeats it…
    const lastUser = visionInputsOf().at(-1)!.filter((i: any) => i?.role === "user").at(-1);
    expect(lastUser.content[0].text).toContain("[FOCUS ON UNCAPTURED DISPLAY]");
    // …and the SSE previews say focus, not "no visible change".
    const previews = outputs(input).map((e) => e?.preview || "");
    expect(previews.some((p) => p.includes("focus on uncaptured display 2 (captured 1)"))).toBe(true);
    expect(previews.some((p) => p.includes("no visible change"))).toBe(false);
    const evs = outputs(input).filter((e) => e?.focusSplit === true);
    expect(evs.length).toBe(3);
    expect(mockVisionChat).toHaveBeenCalledTimes(4);
  });

  /** cu-diag fix #2 (merged 2026-09-25): a legacy agent cannot say WHERE the
   *  focus went, but the SAME frames still trip the watchdog — through the
   *  harness's own positive-control probe (Cmd+Space → Cmd+Tab → Escape at
   *  strike 2), not a blind third strike. The first action's
   *  Terminal→TextEdit on a byte-identical frame is positive input evidence
   *  (fix #2a: the incident's own signature), so it is never a strike; the
   *  next two are. The probe below is fed the same identical frame with an
   *  unchanged frontmost app on EVERY leg (ticket a40f64d9 made the control
   *  multi-leg) — a FAILED probe — which is the only ground the merged loop
   *  aborts on. */
  const failingProbe = (shot: (o?: Record<string, unknown>) => any) => {
    mockDispatch
      .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(shot({ frontmostApp: "TextEdit", frontmostWindowDisplayId: 2 })) // probe leg 1: cmd+space (inert)
      .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(shot({ frontmostApp: "TextEdit", frontmostWindowDisplayId: 2 })) // probe leg 2: cmd+tab (inert)
      .mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(shot({ frontmostApp: "TextEdit", frontmostWindowDisplayId: 2 })); // probe: escape
  };
  const resultsOf = () =>
    visionInputsOf().at(-1)!.filter((i: any) => i?.type === "function_call_output").map((i: any) => JSON.parse(i.output));

  it("the honest twin (legacy agent, no display facts): the first frontmost change is input proof, the SAME identical frames then strike, and the FAILED harness probe trips the watchdog", async () => {
    const input = baseInput();
    splitRun(input, shotLegacy);
    failingProbe(shotLegacy);
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toContain("Computer use stopped: 2 consecutive input actions produced no visible change");
    expect(r.finalResponse).toContain("positive-control probe");
    expect(r.finalResponse).toContain("a display I am not capturing");
    expect(r.harness).toMatchObject({ frontmostChanges: 1, noChangeStrikes: 2, probesRun: 1, probesPassed: 0, inputProven: false });
    const results = resultsOf();
    expect(results[0].inputDelivered).toBe(true); // Terminal→TextEdit on identical bytes: evidence, not a strike
    expect(results[0].noVisibleChange).toBeUndefined();
    expect(results[1].noVisibleChange).toBe(1);
    expect(mockVisionChat).toHaveBeenCalledTimes(3);
  });

  it("a split on the FIRST frame is announced in the task text", async () => {
    const input = baseInput();
    mockDispatch.mockResolvedValueOnce(shot061({ frontmostApp: "TextEdit", frontmostWindowDisplayId: 2 }));
    mockVisionChat.mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "seen" })], text: "" });
    await runComputerAgentSession(input);
    const taskText = visionInputsOf()[0][0].content[0].text as string;
    expect(taskText).toContain("[FOCUS ON UNCAPTURED DISPLAY]");
    expect(taskText).toContain("(TextEdit) is on display 2");
  });
});

// ── fix #6: owner-presence gate ──────────────────────────────────────────────

describe("fix #6 — owner-presence gate", () => {
  const activeShot = (over: Record<string, unknown> = {}) => shot061({ hidIdleSeconds: 4, hidIdleRawSeconds: 0.3, ...over });

  it("a MACHINE-triggered run with the owner active becomes camera-only: input tools withdrawn, click refused, result gated", async () => {
    const input = baseInput({ machineTriggered: true });
    mockDispatch.mockResolvedValueOnce(activeShot());
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 5, y: 5 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "reported" })], text: "" });
    const r = await runComputerAgentSession(input);
    // The offered vocabulary is the camera set…
    const offered = (mockVisionChat.mock.calls[0][0] as any).tools.map((t: any) => t.name).sort();
    expect(offered).toEqual(["done", "screenshot", "wait"]); // wait is camera-safe (cu-diag fix #3)
    expect((mockVisionChat.mock.calls[0][0] as any).instructions).toContain("OBSERVE-ONLY SESSION");
    // …the click never reached the device…
    expect(mockDispatch.mock.calls.map((c) => c[1])).not.toContain("computer_click");
    // …the task text says why…
    const taskText = visionInputsOf()[0][0].content[0].text as string;
    expect(taskText).toContain("OWNER ACTIVE — CAMERA-ONLY");
    expect(taskText).toContain("human input 4 s ago");
    // …and the result is structured.
    expect(r.observeOnly).toBe(true);
    expect(r.ownerPresence).toEqual({ active: true, reason: "human input 4 s ago", gated: true });
    expect(outputs(input).some((e) => String(e?.message || "").includes("camera-only"))).toBe(true);
    // formatter discloses the gate on the tool-result header
    const formatted = formatComputerTaskToolResult(r);
    expect(formatted).toContain("OBSERVE-ONLY (owner active: human input 4 s ago — machine run was camera-only)");
  });

  it("a remote-control session alone (owner idle at the keyboard) gates a machine run", async () => {
    const input = baseInput({ machineTriggered: true });
    mockDispatch.mockResolvedValueOnce(shot061({ hidIdleSeconds: 900, remoteSession: { active: true, kinds: ["screen_sharing_virtual_display", "screensharingd"] } }));
    mockVisionChat.mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "x" })], text: "" });
    const r = await runComputerAgentSession(input);
    expect(r.ownerPresence).toMatchObject({ active: true, gated: true });
    expect(r.ownerPresence!.reason).toContain("remote-control session attached (screen_sharing_virtual_display, screensharingd)");
  });

  it("an INTERACTIVE run with the owner active keeps full control and gets the one-line note", async () => {
    const input = baseInput();
    mockDispatch
      .mockResolvedValueOnce(activeShot())
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(activeShot({ screenshotBase64: FRAME_B }));
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 5, y: 5 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "done" })], text: "" });
    const r = await runComputerAgentSession(input);
    expect(mockDispatch.mock.calls.map((c) => c[1])).toContain("computer_click");
    const taskText = visionInputsOf()[0][0].content[0].text as string;
    expect(taskText).toContain("Note: the owner appears active on this Mac (human input 4 s ago)");
    expect(taskText).not.toContain("CAMERA-ONLY");
    expect(r.observeOnly).toBeUndefined();
    expect(r.ownerPresence).toEqual({ active: true, reason: "human input 4 s ago", gated: false });
    expect(formatComputerTaskToolResult(r)).toContain("· owner active (human input 4 s ago)");
  });

  it("an idle owner (or a legacy agent) never gates and leaves the result shape untouched", async () => {
    for (const shot of [shot061(), shotLegacy()]) {
      jest.resetAllMocks();
      mockListAgents.mockResolvedValue([agentRow()]);
      mockIsOnline.mockReturnValue(true);
      mockAcquireLock.mockResolvedValue("lock-token-1");
      mockVisionConfigured.mockReturnValue(true);
      const input = baseInput({ machineTriggered: true });
      mockDispatch.mockResolvedValueOnce(shot).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ...shot, screenshotBase64: FRAME_B });
      mockVisionChat
        .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 5, y: 5 })], text: "" })
        .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "done" })], text: "" });
      const r = await runComputerAgentSession(input);
      expect(mockDispatch.mock.calls.map((c) => c[1])).toContain("computer_click");
      expect(r).not.toHaveProperty("ownerPresence");
      expect(r.observeOnly).toBeUndefined();
    }
  });

  it("the owner sitting down MID-RUN flips a machine run to camera-only (one-way) and the model is told on the action's result", async () => {
    const input = baseInput({ machineTriggered: true });
    mockDispatch
      .mockResolvedValueOnce(shot061())                                         // idle at start
      .mockResolvedValueOnce({ ok: true })                                      // click 1
      .mockResolvedValueOnce(activeShot({ screenshotBase64: FRAME_B }));        // owner active now
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 5, y: 5 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 6, y: 6 })], text: "" }) // refused
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "handed back" })], text: "" });
    const r = await runComputerAgentSession(input);
    expect(mockDispatch.mock.calls.filter((c) => c[1] === "computer_click").length).toBe(1);
    const results = visionInputsOf().at(-1)!
      .filter((i: any) => i?.type === "function_call_output")
      .map((i: any) => JSON.parse(i.output));
    expect(results.some((o: any) => typeof o.ownerActive === "string" && o.ownerActive.includes("CAMERA-ONLY from now on"))).toBe(true);
    expect(results.some((o: any) => o.ok === false && String(o.error).includes("OBSERVE-ONLY SESSION"))).toBe(true);
    const offeredLater = (mockVisionChat.mock.calls[1][0] as any).tools.map((t: any) => t.name).sort();
    expect(offeredLater).toEqual(["done", "screenshot", "wait"]); // wait is camera-safe (cu-diag fix #3)
    expect(r.ownerPresence).toEqual({ active: true, reason: "human input 4 s ago", gated: true });
    expect(outputs(input).some((e) => e?.ownerPresenceGated === true)).toBe(true);
  });
});

// ── fix #6: named busy refusal + holder record ───────────────────────────────

describe("fix #6 — busy refusal names the holder; a winner records itself", () => {
  it("contended lock → structured busy result naming holder chat + lane; the formatter emits a BUSY banner (not UNAVAILABLE)", async () => {
    mockAcquireLock.mockResolvedValueOnce(null);
    mockDescribeHolder.mockResolvedValueOnce({ chatId: "chat-11449a0a", lane: "coding session chat-11449a0a", since: "2026-09-25T23:56:00.000Z" });
    const r = await runComputerAgentSession(baseInput());
    expect(r.steps).toBe(0);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(r.busy).toEqual({ holderChatId: "chat-11449a0a", holderLane: "coding session chat-11449a0a", since: "2026-09-25T23:56:00.000Z", waitedMs: expect.any(Number) });
    expect(r.capabilityNotice).toContain("YOUR MAC IS BUSY");
    expect(r.capabilityNotice).toContain("Holder: coding session chat-11449a0a in chat chat-11449a0a since 2026-09-25T23:56:00.000Z.");
    expect(r.capabilityNotice).toMatch(/waited \d+ s for the device/);
    const formatted = formatComputerTaskToolResult(r);
    expect(formatted.startsWith("[COMPUTER_TASK — BUSY]")).toBe(true);
    expect(formatted).toContain("holder: coding session chat-11449a0a · chat chat-11449a0a · since 2026-09-25T23:56:00.000Z · waited");
    expect(formatted).not.toContain("[COMPUTER_TASK — UNAVAILABLE]");
    expect(mockReleaseLock).not.toHaveBeenCalled();
    expect(mockRecordHolder).not.toHaveBeenCalled();
  });

  it("an unknown holder (legacy session / redis hiccup) still yields the historical text with null holder fields", async () => {
    mockAcquireLock.mockResolvedValueOnce(null);
    const r = await runComputerAgentSession(baseInput());
    expect(r.busy).toEqual({ holderChatId: null, holderLane: null, since: null, waitedMs: expect.any(Number) });
    expect(r.capabilityNotice).toContain("another computer-use session is already driving it");
    expect(r.capabilityNotice).not.toContain("Holder:");
  });

  it("a winning session records its holder (input.holder wins; chatId falls back to input.chatId)", async () => {
    mockDispatch.mockResolvedValueOnce(shot061());
    mockVisionChat.mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(baseInput({ holder: { chatId: "chat-A", lane: "chat chat-A" } }));
    expect(mockRecordHolder).toHaveBeenCalledWith("user-1", "agent-1", { chatId: "chat-A", lane: "chat chat-A" }, expect.any(Number));
    jest.resetAllMocks();
    mockListAgents.mockResolvedValue([agentRow()]);
    mockIsOnline.mockReturnValue(true);
    mockAcquireLock.mockResolvedValue("lock-token-2");
    mockVisionConfigured.mockReturnValue(true);
    mockDispatch.mockResolvedValueOnce(shot061());
    mockVisionChat.mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(baseInput());
    expect(mockRecordHolder).toHaveBeenCalledWith("user-1", "agent-1", { chatId: "chat-77", lane: null }, expect.any(Number));
  });

  it("a holder-record failure never fails the session", async () => {
    mockRecordHolder.mockRejectedValueOnce(new Error("redis down"));
    mockDispatch.mockResolvedValueOnce(shot061());
    mockVisionChat.mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "fine" })], text: "" });
    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("fine");
  });
});


// Review 2026-09-25 (non-blocking #1): the deadline is re-based once the
// use-lock is held — a 60 s contended wait must not eat a 120 s handoff.
describe("sessionDeadline: the lock wait is not the session's budget", () => {
  afterEach(() => { delete process.env.COMPUTER_DEADLINE_INCLUDES_LOCK_WAIT; });

  it("re-bases to lockAcquiredAt + deadlineMs after a contended wait", () => {
    const t0 = 1_000_000;
    const pre = t0 + 120_000;
    expect(sessionDeadline(pre, t0 + 58_000, 120_000)).toBe(t0 + 178_000);
  });

  it("an uncontended lock leaves the deadline where it was (never shortens)", () => {
    const t0 = 1_000_000;
    const pre = t0 + 120_000;
    expect(sessionDeadline(pre, t0 + 5, 120_000)).toBe(pre + 5);
    expect(sessionDeadline(pre, t0 - 1, 120_000)).toBe(pre);
  });

  it("COMPUTER_DEADLINE_INCLUDES_LOCK_WAIT=1 restores the pre-lock clock (kill switch)", () => {
    const t0 = 1_000_000;
    const pre = t0 + 120_000;
    expect(sessionDeadline(pre, t0 + 58_000, 120_000, { COMPUTER_DEADLINE_INCLUDES_LOCK_WAIT: "1" } as any)).toBe(pre);
    process.env.COMPUTER_DEADLINE_INCLUDES_LOCK_WAIT = "1";
    expect(sessionDeadline(pre, t0 + 58_000, 120_000)).toBe(pre);
  });
});
