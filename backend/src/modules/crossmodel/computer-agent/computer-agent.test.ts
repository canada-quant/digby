/**
 * Computer-agent tests — availability gate + vision loop with mocked edges.
 *
 * Edges mocked (never really imported, so no redis/prisma/axios load):
 *   - ../imessage/imessage.service — getPrimaryAgent / isOnline (agent row)
 *   - ../imessage/agent-link       — agentBroker.dispatch (the fake Mac)
 *   - ./vision-client              — visionChat / visionConfigured (the fake model)
 *
 * Everything BETWEEN those edges is real: computerAgentStatus, selectComputerDriver,
 * LocalComputerDriver (action→method mapping + auto-screenshot chaining), and the
 * computer-loop (step cap, terminal actions, degeneration guard, wrap-up).
 */

import { runComputerAgentSession } from "./computer-loop";
import { computerAgentStatus, selectComputerDriver } from "./driver";
import { acquireComputerUseLock, releaseComputerUseLock } from "./use-lock";
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
// The per-user computer-use mutex (ticket 4e4d56ff) — mocked so no redis load.
jest.mock("./use-lock", () => ({
  acquireComputerUseLock: jest.fn(),
  releaseComputerUseLock: jest.fn(),
  LOCK_TTL_MARGIN_MS: 120_000,
}));
// The logger sinks errors to prisma (appErrorLog) — mock it out of the graph.
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockListAgents = listAgents as jest.Mock;
const mockIsOnline = isOnline as jest.Mock;
const mockDispatch = agentBroker.dispatch as jest.Mock;
const mockVisionChat = visionChat as jest.Mock;
const mockVisionConfigured = visionConfigured as jest.Mock;
const mockAcquireLock = acquireComputerUseLock as jest.Mock;
const mockReleaseLock = releaseComputerUseLock as jest.Mock;

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  userId: "user-1",
  label: "MacBook Pro",
  deviceId: "device-1",
  isDefault: true,
  agentVersion: "0.3.0",
  lastSeenAt: new Date(),
  ...over,
});

const SHOT = {
  ok: true,
  // Ticket 33401f39 reconciliation: this suite's old placeholder frames
  // ("anEieA==", 6 raw bytes at 1568×980 → bpp ≈ 0.000003) are structurally
  // impossible as real screenshots — a real macOS capture always carries the
  // menu bar and renders at bpp ≈ 0.15 — and the degenerate-frame gate
  // (DEGENERATE_BPP_THRESHOLD 0.03) correctly fires on them. Realistic mock
  // frames: ~0.08–0.15 bpp content-rich lengths. Length only matters to the
  // ratio; the byte payloads stay distinct for the byte-identity watchdog.
  screenshotBase64: "RnJhbWUx".repeat(46000), // ~184,000 raw bytes → bpp ≈ 0.12
  imageWidth: 1568,
  imageHeight: 980,
  screenWidth: 1512,
  screenHeight: 982,
};

const baseInput = () => ({
  userId: "user-1",
  chatId: null,
  message: "Open Notes and type hello",
  sendEvent: jest.fn(),
});

const fnCall = (
  name: string,
  args: Record<string, unknown>,
  callId = `call_${Math.random().toString(36).slice(2, 8)}`,
) => ({
  callId,
  name,
  arguments: JSON.stringify(args),
});

beforeEach(() => {
  jest.clearAllMocks();
  mockVisionConfigured.mockReturnValue(true);
  mockIsOnline.mockReturnValue(true);
  mockListAgents.mockResolvedValue([agentRow()]);
  // Default: the per-user computer-use lock is free (ticket 4e4d56ff).
  mockAcquireLock.mockResolvedValue("lock-token-1");
  mockReleaseLock.mockResolvedValue(undefined);
});

describe("computerAgentStatus", () => {
  it("no agent paired → not connected", () => {
    expect(computerAgentStatus(null)).toContain("not connected");
  });

  it("agent offline → offline with guidance", () => {
    mockIsOnline.mockReturnValue(false);
    const s = computerAgentStatus(
      agentRow({ lastSeenAt: new Date(Date.now() - 30 * 60_000) }),
    );
    expect(s).toContain("offline");
    expect(s).toContain("open the Digby Mac app");
  });

  it("agent too old (0.2.1) → connected but too old, names v0.3.0", () => {
    const s = computerAgentStatus(agentRow({ agentVersion: "0.2.1" }));
    expect(s).toContain("too old");
    expect(s).toContain("v0.3.0 or newer");
  });

  it("online 0.3.0 agent → connected", () => {
    expect(computerAgentStatus(agentRow())).toBe("connected (Mac app v0.3.0)");
  });
});

describe("selectComputerDriver", () => {
  it("returns a driver for an online 0.3.0 agent", async () => {
    const sel = await selectComputerDriver("user-1");
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-1");
    expect(sel.status).toContain("connected");
  });

  it("returns no driver (with status) for an old agent", async () => {
    mockListAgents.mockResolvedValue([agentRow({ agentVersion: "0.1.5" })]);
    const sel = await selectComputerDriver("user-1");
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("too old");
  });
});

describe("runComputerAgentSession", () => {
  it("no agent → capabilityNotice, steps 0, vision never called", async () => {
    mockListAgents.mockResolvedValue([]);
    const r = await runComputerAgentSession(baseInput());
    expect(r.capabilityNotice).toContain("UNAVAILABLE");
    expect(r.steps).toBe(0);
    expect(mockVisionChat).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("vision unconfigured → capabilityNotice before touching the Mac", async () => {
    mockVisionConfigured.mockReturnValue(false);
    const r = await runComputerAgentSession(baseInput());
    expect(r.capabilityNotice).toContain("Computer-use vision seat");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("first screenshot failure (permission) → capabilityNotice relays the error", async () => {
    mockDispatch.mockResolvedValue({
      ok: false,
      error:
        "Missing macOS permission(s): Screen Recording. A setup dialog was shown…",
    });
    const r = await runComputerAgentSession(baseInput());
    expect(r.capabilityNotice).toContain("first screenshot");
    expect(r.capabilityNotice).toContain("Screen Recording");
    expect(r.steps).toBe(0);
    expect(mockVisionChat).not.toHaveBeenCalled();
  });

  it("happy path: click then done — click params mapped, auto-screenshot chained", async () => {
    mockDispatch
      .mockResolvedValueOnce(SHOT) // initial screenshot
      .mockResolvedValueOnce({ ok: true }) // computer_click
      .mockResolvedValueOnce(SHOT); // chained auto-screenshot
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [
          fnCall("click", { x: 100, y: 200, reasoning: "click the field" }),
        ],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("done", { message: "Typed hello into Notes." })],
        text: "",
      });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Typed hello into Notes.");
    expect(r.steps).toBe(2);
    expect(r.localStatus).toContain("connected");

    const methods = mockDispatch.mock.calls.map((c) => c[1]);
    expect(methods).toEqual([
      "computer_screenshot",
      "computer_click",
      "computer_screenshot",
    ]);
    expect(mockDispatch.mock.calls[1][2]).toEqual({
      x: 100,
      y: 200,
      button: "left",
      clicks: 1,
    });
  });

  it("plain-text model answer ends the loop with no further dispatch", async () => {
    mockDispatch.mockResolvedValueOnce(SHOT);
    mockVisionChat.mockResolvedValueOnce({
      functionCalls: [],
      text: 'The screen already shows Notes with "hello" typed.',
    });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toContain("The screen already shows Notes");
    expect(r.steps).toBe(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1); // just the initial screenshot
  });

  it("ask_user is terminal and surfaces the question", async () => {
    mockDispatch.mockResolvedValueOnce(SHOT);
    mockVisionChat.mockResolvedValueOnce({
      functionCalls: [
        fnCall("ask_user", {
          message: "Which Apple ID should I sign in with?",
        }),
      ],
      text: "",
    });
    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toContain("Which Apple ID should I sign in with?");
    expect(r.steps).toBe(1);
  });

  it("degeneration guard: identical action 3× running → nudge fed back, loop recovers", async () => {
    mockDispatch.mockResolvedValue(SHOT); // screenshots everywhere (initial + chained)
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [fnCall("click", { x: 10, y: 10 })],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("click", { x: 10, y: 10 })],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("click", { x: 10, y: 10 })],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [
          fnCall("done", { message: "Recovered with a different approach." }),
        ],
        text: "",
      });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Recovered with a different approach.");

    // The 3rd repeat must be answered with the nudge instead of a dispatch.
    const outputs = mockVisionChat.mock.calls.map((c) => c[0].input).flat();
    const nudge = outputs.find(
      (item: any) =>
        item.type === "function_call_output" &&
        typeof item.output === "string" &&
        item.output.includes("repeated the identical action"),
    );
    expect(nudge).toBeTruthy();
    // click dispatched for the first two repeats only; the third was intercepted.
    const clicks = mockDispatch.mock.calls.filter(
      (c) => c[1] === "computer_click",
    );
    expect(clicks.length).toBe(2);
  });

  it("auto-screenshot failure after a successful action is non-fatal (stability)", async () => {
    mockDispatch
      .mockResolvedValueOnce(SHOT) // initial
      .mockResolvedValueOnce({ ok: true }) // click ok
      .mockRejectedValueOnce(
        new Error("iMessage agent did not respond within 45000ms"),
      ); // chained shot dies
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [fnCall("click", { x: 5, y: 5 })],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [
          fnCall("done", { message: "Clicked; lost the camera after." }),
        ],
        text: "",
      });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Clicked; lost the camera after.");
    // The model was told the action succeeded but the screenshot failed.
    const outputs = mockVisionChat.mock.calls.map((c) => c[0].input).flat();
    const note = outputs.find(
      (item: any) =>
        item.type === "function_call_output" &&
        typeof item.output === "string" &&
        item.output.includes("follow-up screenshot failed"),
    );
    expect(note).toBeTruthy();
  });

  it("action dispatch failure reaches the model as an error observation (loop continues)", async () => {
    mockDispatch
      .mockResolvedValueOnce(SHOT)
      .mockRejectedValueOnce(
        new Error("iMessage agent did not respond within 45000ms"),
      );
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [fnCall("key", { key: "return" })],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [
          fnCall("done", { message: "Could not reach the Mac mid-task." }),
        ],
        text: "",
      });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Could not reach the Mac mid-task.");
    const outputs = mockVisionChat.mock.calls.map((c) => c[0].input).flat();
    const err = outputs.find(
      (item: any) =>
        item.type === "function_call_output" &&
        typeof item.output === "string" &&
        item.output.includes("did not respond"),
    );
    expect(err).toBeTruthy();
  });

  it("only the most recent screenshot is kept in the model input (context discipline)", async () => {
    const SHOT2 = { ...SHOT, screenshotBase64: "RnJhbWUxLjI=".repeat(46000) }; // distinct, content-rich (33401f39 reconciliation)
    mockDispatch
      .mockResolvedValueOnce(SHOT) // initial
      .mockResolvedValueOnce({ ok: true }) // key
      .mockResolvedValueOnce(SHOT2); // chained shot
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [fnCall("key", { key: "space", modifiers: ["cmd"] })],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("done", { message: "Opened Spotlight." })],
        text: "",
      });

    await runComputerAgentSession(baseInput());
    const secondCallInput: any[] = mockVisionChat.mock.calls[1][0].input;
    const images = secondCallInput
      .filter((i) => i.role === "user")
      .flatMap((i) => i.content)
      .filter((c: any) => c.type === "input_image");
    expect(images.length).toBe(1);
    expect(images[0].image_url).toContain("RnJhbWUxLjI="); // the NEW screenshot, not the first (33401f39 reconciliation)
  });
});

describe("degenerate-frame caution (ticket 33401f39, PR #1030 review B1)", () => {
  // A sparse-but-REAL screen (dark desktop + menu bar ≈ 0.019 bpp) overlaps
  // the solid-capture band (≈ 0.0162), so density can never PROVE a frame is
  // unreadable — the loop must CAUTION the model (which sees the frame) and
  // CONTINUE, never refuse at steps 0 with a wrong quit-and-relaunch remedy.
  it("a low-density first frame does NOT end the session — the caution rides the first model turn instead", async () => {
    const darkDesktopShot = {
      ...SHOT,
      // ~0.019 bpp: measured dark desktop + menu bar (adversarial review B1)
      screenshotBase64: "RnJhbWU".repeat(3900), // 27,300 raw bytes / 1,536,640 px ≈ 0.0178… below 0.03
    };
    mockDispatch.mockResolvedValueOnce(darkDesktopShot); // initial screenshot
    mockVisionChat.mockResolvedValueOnce({
      functionCalls: [fnCall("done", { message: "Dark but readable — nothing to do." })],
      text: "",
    });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("Dark but readable — nothing to do.");
    expect(r.steps).toBe(1); // NOT 0 — the session ran; the model judged the frame
    // The caution was surfaced: a computer-observation event named the low-density frame…
    const previews = input.sendEvent.mock.calls
      .filter((c: any[]) => c[0] === "computer-observation")
      .map((c: any[]) => c[1]?.preview || "");
    expect(previews.some((p: string) => p.includes("low-readability first frame"))).toBe(true); // cu-diag fix #4: decoded metric (bpp is the undecodable fallback)
    // …and the first model turn carried the caution text (the model sees the frame and decides).
    const firstTurn = (mockVisionChat.mock.calls[0][0].input as any[])
      .filter((i) => i?.role === "user")
      .flatMap((i) => i.content ?? [i])
      .map((c: any) => (typeof c === "string" ? c : c.text || ""))
      .join(" ");
    expect(firstTurn).toContain("CAUTION");
  });

  it("a low-density POST-ACTION frame does NOT terminate — the caution rides the action outcome (PR #1030 follow-up review)", async () => {
    // The reviewer's probe: pre-seeded streak + one dark post-action frame hit
    // the removed `degenerateStreak >= 2 → terminal` stop one frame in, on a
    // dark-but-readable screen. Advisory-only now: the session continues and
    // the MODEL decides.
    const darkShot = {
      ...SHOT,
      screenshotBase64: "RnJhbWU".repeat(3900), // ≈0.018 bpp — below the threshold
    };
    const darkShot2 = {
      ...SHOT,
      screenshotBase64: "RnJhbWV6".repeat(3900), // byte-DISTINCT (avoids the no-change watchdog) but ≈0.019 bpp — still below
    };
    mockDispatch
      .mockResolvedValueOnce(darkShot) // initial — pre-seeds the streak at 1
      .mockResolvedValueOnce({ ok: true }) // click
      .mockResolvedValueOnce(darkShot2); // post-action — streak 1→2: must NOT terminate
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 5, y: 5 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Dark screen, but I could read it — done." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("Dark screen, but I could read it — done.");
    expect(r.steps).toBe(2); // NOT terminated at 1 — no density-driven code stop
    expect(mockVisionChat).toHaveBeenCalledTimes(2);
    // cu-diag fix #4: the caution fires ONCE per low-readability streak. The
    // first frame pre-seeded the streak (its caution rode the task message),
    // so the post-action low frame carries NO repeated caution — the incident
    // run got 44 of them on readable dark Terminal frames.
    const outcome = (mockVisionChat.mock.calls[1][0].input as any[])
      .filter((i) => i?.type === "function_call_output")
      .map((i) => JSON.parse(i.output))
      .find((o) => o.degenerateFrame !== undefined);
    expect(outcome).toBeUndefined();
    const firstTurn = (mockVisionChat.mock.calls[0][0].input as any[])
      .filter((i) => i?.role === "user")
      .flatMap((i) => i.content ?? [i])
      .map((c: any) => (typeof c === "string" ? c : c.text || ""))
      .join(" ");
    expect(firstTurn).toContain("CAUTION");
    // The harness counted both frames.
    expect(r.harness?.degenerateFrames).toBe(2);
  });
});

describe("computer-use arbitration (ticket 4e4d56ff)", () => {  // The 2026-09-09 incident: two concurrent computer-agent loops drove one
  // Mac — each loop's clicks were scaled against screen state the OTHER loop
  // had already changed ("clicks at wrong coordinates", dead scrolls/keys,
  // while every action reported success). Sessions are now serialized per
  // user; a contended lock returns a busy notice WITHOUT touching the Mac.

  it("contended lock → busy capabilityNotice; the Mac and the model are never touched", async () => {
    mockAcquireLock.mockResolvedValueOnce(null);
    const r = await runComputerAgentSession(baseInput());
    expect(r.capabilityNotice).toContain("BUSY");
    expect(r.capabilityNotice).toContain("another computer-use session");
    expect(r.steps).toBe(0);
    expect(mockVisionChat).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    // Never held → never released (a compare-and-delete release of a lock we
    // do not hold would delete the REAL holder's lock if tokens collided).
    expect(mockReleaseLock).not.toHaveBeenCalled();
  });

  it("a held lock is released with its token after a clean session", async () => {
    mockDispatch.mockResolvedValueOnce(SHOT); // initial screenshot
    mockVisionChat.mockResolvedValueOnce({
      functionCalls: [fnCall("done", { message: "All set." })],
      text: "",
    });
    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("All set.");
    expect(mockAcquireLock).toHaveBeenCalledWith("user-1", expect.any(Number), "agent-1"); // per-device lock (multi-Mac 2026-09-24)
    expect(mockReleaseLock).toHaveBeenCalledWith("user-1", "lock-token-1", "agent-1"); // per-device lock (multi-Mac 2026-09-24)
  });

  it("the lock is released even when the session dies mid-flight", async () => {
    mockDispatch.mockRejectedValueOnce(new Error("broker down")); // initial screenshot throws
    const r = await runComputerAgentSession(baseInput());
    expect(r.capabilityNotice).toContain("could not see");
    expect(mockReleaseLock).toHaveBeenCalledWith("user-1", "lock-token-1", "agent-1"); // per-device lock (multi-Mac 2026-09-24)
  });

  it("the lock is NOT acquired when the session never gets a driver", async () => {
    mockListAgents.mockResolvedValue([]);
    await runComputerAgentSession(baseInput());
    expect(mockAcquireLock).not.toHaveBeenCalled();
  });
});

describe("targeted scroll (ticket 4e4d56ff)", () => {
  it("scroll with x/y forwards the image-pixel target to the agent", async () => {
    mockDispatch
      .mockResolvedValueOnce(SHOT) // initial
      .mockResolvedValueOnce({ ok: true }) // computer_scroll
      .mockResolvedValueOnce(SHOT); // chained auto-screenshot
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [
          fnCall("scroll", { direction: "down", amount: 12, x: 400, y: 300 }),
        ],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("done", { message: "Scrolled the list." })],
        text: "",
      });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Scrolled the list.");
    const scrollCall = mockDispatch.mock.calls.find(
      (c) => c[1] === "computer_scroll",
    );
    expect(scrollCall?.[2]).toEqual({
      direction: "down",
      amount: 12,
      x: 400,
      y: 300,
    });
  });

  it("scroll without x/y keeps the legacy shape (no target keys sent)", async () => {
    mockDispatch
      .mockResolvedValueOnce(SHOT) // initial
      .mockResolvedValueOnce({ ok: true }) // computer_scroll
      .mockResolvedValueOnce(SHOT); // chained auto-screenshot
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [fnCall("scroll", { direction: "up" })],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("done", { message: "Scrolled up." })],
        text: "",
      });

    await runComputerAgentSession(baseInput());
    const scrollCall = mockDispatch.mock.calls.find(
      (c) => c[1] === "computer_scroll",
    );
    expect(scrollCall?.[2]).toEqual({ direction: "up", amount: 10 });
    expect(scrollCall?.[2]).not.toHaveProperty("x");
  });
});

describe("write-path watchdog (ticket ac9022a0)", () => {
  // The 2026-09-21 incident (owner-reported, two independent lanes): the Mac
  // rendered pages fine but every click/form interaction silently no-op'd —
  // CGEventPost returns void, so dropped input reports ok:true and the loop
  // burned its whole 12-step budget retrying with zero signal. The watchdog:
  // the driver auto-screenshots after every input action; a post-action frame
  // BYTE-IDENTICAL to the previous one proves the action changed nothing
  // (fail-open detector — any pixel change yields different bytes). One notice
  // rides the action's own result; 3 consecutive no-change input actions end
  // the task with a loud blocked report.
  const SHOT_A = { ...SHOT, screenshotBase64: "RnJhbWUx".repeat(46000) }; // content-rich, distinct (33401f39 reconciliation)
  const SHOT_B = { ...SHOT, screenshotBase64: "RnJhbWUy".repeat(46000) }; // content-rich, distinct
  const ACTION_OK = { ok: true };

  /** Parse every function_call_output the loop fed the model (the input array
   *  is shared across vision calls — the last reference holds them all). */
  const fedOutputs = (): any[] =>
    (mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[])
      .filter((i) => i?.type === "function_call_output")
      .map((i) => JSON.parse(i.output));

  it("a byte-identical post-action frame → the action's own result carries the NO VISIBLE CHANGE warning (and the SSE row shows it), the loop keeps going", async () => {
    const input = baseInput();
    mockDispatch
      .mockResolvedValueOnce(SHOT_A) // initial screenshot
      .mockResolvedValueOnce(ACTION_OK) // computer_type (cu-diag fix #2: clicks are advisory — type strikes)
      .mockResolvedValueOnce(SHOT_A); // auto-screenshot — identical ⇒ streak 1
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [fnCall("type", { text: "hello" })],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("done", { message: "Finished fine." })],
        text: "",
      });

    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("Finished fine.");

    const flagged = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(flagged.length).toBe(1);
    expect(flagged[0].noVisibleChange).toBe(1);
    expect(flagged[0].warning).toContain("NO VISIBLE CHANGE");
    expect(flagged[0].warning).toContain("pixel-identical");
    expect(flagged[0].warning).toContain("Accessibility");

    const previews = input.sendEvent.mock.calls
      .filter((c: any[]) => c[0] === "computer-observation")
      .map((c: any[]) => c[1]?.preview || "");
    expect(previews.some((p: string) => p.includes("no visible change (1)"))).toBe(true);
  });

  it("a changed frame resets the streak — only the provably-dead actions are flagged", async () => {
    mockDispatch
      .mockResolvedValueOnce(SHOT_A) // initial
      .mockResolvedValueOnce(ACTION_OK) // type (cu-diag fix #2: clicks are advisory — type strikes)
      .mockResolvedValueOnce(SHOT_A) // identical ⇒ streak 1
      .mockResolvedValueOnce(ACTION_OK) // type
      .mockResolvedValueOnce(SHOT_B) // CHANGED ⇒ reset
      .mockResolvedValueOnce(ACTION_OK) // key
      .mockResolvedValueOnce(SHOT_B); // identical to last ⇒ streak 1 (not 2)
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "hi" })], text: "" })
      // 6f4f8b36: a bare "tab" is now no-op-prone (never a strike) — this
      // test pins the RESET semantics, so the third action stays
      // strike-eligible (return); the tab carve-out has its own suite in
      // computer-loop.watchdog-false-abort.6f4f8b36.test.ts.
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Done cleanly." })], text: "" });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Done cleanly.");

    const flagged = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(flagged.map((o) => o.noVisibleChange)).toEqual([1, 1]); // type + return, never 2
  });

  it("2 consecutive no-change input actions + a FAILED harness positive-control probe → LOUD blocked termination at step 2 (no silent 12-step burn, no wrap-up call; cu-diag fix #2)", async () => {
    const input = baseInput();
    mockDispatch
      .mockResolvedValueOnce(SHOT_A) // initial
      .mockResolvedValueOnce(ACTION_OK) // type
      .mockResolvedValueOnce(SHOT_A) // streak 1
      .mockResolvedValueOnce(ACTION_OK) // key return
      .mockResolvedValueOnce(SHOT_A) // streak 2 ⇒ the HARNESS probes
      .mockResolvedValueOnce(ACTION_OK) // probe leg 1: key cmd+space
      .mockResolvedValueOnce(SHOT_A) // probe frame — IDENTICAL, frontmost unchanged (remap-shaped)
      .mockResolvedValueOnce(ACTION_OK) // probe leg 2: key cmd+tab (ticket a40f64d9)
      .mockResolvedValueOnce(SHOT_A) // probe frame — IDENTICAL too ⇒ EVERY leg inert ⇒ probe FAILED
      .mockResolvedValueOnce(ACTION_OK) // probe cleanup: key escape
      .mockResolvedValueOnce(SHOT_A); // post-cleanup frame
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "x" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" });

    const r = await runComputerAgentSession(input);
    expect(r.steps).toBe(2); // terminated at the failed probe — 10 steps never burned
    expect(mockVisionChat).toHaveBeenCalledTimes(2); // finalText set ⇒ no wrap-up call
    expect(r.finalResponse).toContain("pixel-identical");
    expect(r.finalResponse).toContain("positive-control probe");
    expect(r.finalResponse).toContain("Accessibility");
    // The copy names the ACTUAL agent version and the uncaptured-display cause —
    // never the old "older than v0.4.3" guess.
    expect(r.finalResponse).toContain("v0.3.0");
    expect(r.finalResponse).not.toContain("v0.4.3");
    expect(r.finalResponse).toContain("display I am not capturing");
    expect(r.finalResponse).toContain("Nothing on the Mac was verifiably changed");
    // The probe keystrokes were dispatched by the HARNESS (cmd+space, escape).
    const keys = mockDispatch.mock.calls.filter((c) => c[1] === "computer_key").map((c) => c[2]);
    expect(keys).toEqual([
      { key: "return", modifiers: [] },
      { key: "space", modifiers: ["cmd"] },
      { key: "tab", modifiers: ["cmd"] },
      { key: "escape", modifiers: [] },
    ]);
    expect(r.harness).toMatchObject({ noChangeStrikes: 2, probesRun: 1, probesPassed: 0, inputProven: false });

    const progress = input.sendEvent.mock.calls
      .filter((c: any[]) => c[0] === "progress")
      .map((c: any[]) => c[1]?.message || "");
    expect(progress.some((m: string) => m.includes("Input watchdog"))).toBe(true);
  });

  it("a screenshot action between dead inputs does NOT advance (or reset) the streak", async () => {
    mockDispatch
      .mockResolvedValueOnce(SHOT_A) // initial
      .mockResolvedValueOnce(ACTION_OK) // type (cu-diag fix #2: clicks are advisory)
      .mockResolvedValueOnce(SHOT_A) // streak 1
      .mockResolvedValueOnce(SHOT_A) // explicit screenshot action — non-mutating
      .mockResolvedValueOnce(ACTION_OK) // key return
      .mockResolvedValueOnce(SHOT_A) // streak 2 (not 3) ⇒ the harness probes
      .mockResolvedValueOnce(ACTION_OK) // probe: key cmd+space
      .mockResolvedValueOnce(SHOT_B) // probe frame CHANGED ⇒ probe PASSED, input proven
      .mockResolvedValueOnce(ACTION_OK) // probe cleanup: escape
      .mockResolvedValueOnce(SHOT_A); // back to the pre-probe screen
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "y" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Wrapped." })], text: "" });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Wrapped."); // no termination at 2

    const flagged = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(flagged.map((o) => o.noVisibleChange)).toEqual([1, 2]); // type, then return
    // The passed probe rode the return's outcome and proved input lands.
    expect(flagged[1].harnessProbe).toContain("POSITIVE CONTROL PASSED");
    expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 1, inputProven: true });
  });
});
