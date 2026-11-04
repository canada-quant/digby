/**
 * W3 (Windows agent 0.9.0, 2026-09-25) — UI Automation actions.
 *
 * Two new wire methods join the computer vocabulary: computer_uia_tree (read
 * the accessibility tree — a TEXT observation) and computer_uia_invoke
 * (activate an element by runtime_id — a normal input action, auto-screenshot
 * follow-up). Both ride a STRICTER dispatch gate: minAgentVersion '0.9.0'
 * (the macOS agent is 0.5.x and must never claim them).
 *
 * This suite pins:
 *   • driver param shaping + server-side clamps (max_depth 1..12, max_nodes 1..1000)
 *   • the 0.9.0 dispatch gate on the wire (vs 0.3.2 for the core vocabulary)
 *   • uia_invoke → exactly ONE follow-up screenshot (the shared post-input path)
 *   • uia_tree → text + node_count observation, NO follow-up screenshot
 *   • '<CODE>: guidance' refusal strings propagate VERBATIM (UIA_E_* codes)
 *   • the macOS tool set is unchanged (no uia_* tools on the macOS branch)
 *   • the loop-instruction splice mentions uia_tree/uia_invoke ONLY on windows
 *   • the loop feeds a uia_tree text observation to the model and strips older
 *     trees from the input (the stripOlderImages discipline, applied to text)
 *
 * Edges mocked exactly like computer-agent.test.ts (no redis/prisma/axios load).
 */

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../imessage/imessage.service", () => ({
  listAgents: jest.fn(),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || "Windows PC"),
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

import { runComputerAgentSession, computerToolsForPlatform, COMPUTER_TOOLS, instructionsForPlatform } from "./computer-loop";
import { LocalComputerDriver, selectComputerDriver } from "./driver";
import { acquireComputerUseLock, releaseComputerUseLock } from "./use-lock";
import { agentBroker } from "../imessage/agent-link";
import { listAgents, isOnline } from "../imessage/imessage.service";
import { visionChat, visionConfigured } from "./vision-client";
import { ComputerAction } from "./types";

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
  label: "Windows PC",
  deviceId: "device-1",
  isDefault: true,
  agentVersion: "0.9.0",
  platform: "windows",
  capabilities: ["browser", "computer"],
  lastSeenAt: new Date(),
  ...over,
});

const SHOT = {
  ok: true,
  // ~0.12 bpp content-rich frame (above the degenerate floor — see
  // computer-agent.test.ts for the calibration rationale).
  screenshotBase64: "RnJhbWUx".repeat(46000),
  imageWidth: 1568,
  imageHeight: 980,
  screenWidth: 1512,
  screenHeight: 982,
};

const TREE_RESULT = {
  ok: true,
  node_count: 42,
  text: [
    "window 'Settings' [runtime 123]",
    "  text 'Display' [runtime 124]",
    "  button 'Apply' [runtime 130]",
  ].join("\n"),
  tree: { name: "Settings", role: "window", runtime_id: [123], children: [] },
};

const baseInput = () => ({
  userId: "user-1",
  chatId: null,
  message: "Open Settings and turn on the toggle",
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
  // resetAllMocks (not clearAllMocks): the once-queues (mockResolvedValueOnce)
  // must die with their test — a defensively-queued extra value would leak into
  // the NEXT test's dispatches and cascade (seen while writing this suite).
  jest.resetAllMocks();
  mockVisionConfigured.mockReturnValue(true);
  mockIsOnline.mockReturnValue(true);
  mockListAgents.mockResolvedValue([agentRow()]);
  mockAcquireLock.mockResolvedValue("lock-token-1");
  mockReleaseLock.mockResolvedValue(undefined);
});

describe("driver — uia action param shaping + clamps", () => {
  it("uia_tree sends {root, max_depth, max_nodes} with defaults foreground/6/300", async () => {
    mockDispatch.mockResolvedValueOnce(TREE_RESULT);
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({ name: "uia_tree" } as ComputerAction);
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent-1",
      "computer_uia_tree",
      { root: "foreground", max_depth: 6, max_nodes: 300 },
      expect.any(Number),
      expect.objectContaining({ minAgentVersion: "0.9.0", capability: "computer" }),
    );
    expect(obs.ok).toBe(true);
    expect(obs.text).toBe(TREE_RESULT.text);
    expect(obs.node_count).toBe(42);
  });

  it("uia_tree passes explicit root=desktop and clamps max_depth/max_nodes into 1..12 / 1..1000", async () => {
    mockDispatch.mockResolvedValueOnce(TREE_RESULT);
    const d = new LocalComputerDriver("agent-1");
    await d.execute({
      name: "uia_tree",
      root: "desktop",
      max_depth: 99,
      max_nodes: 5000,
    } as ComputerAction);
    expect(mockDispatch.mock.calls[0][2]).toEqual({
      root: "desktop",
      max_depth: 12,
      max_nodes: 1000,
    });

    mockDispatch.mockClear();
    mockDispatch.mockResolvedValueOnce(TREE_RESULT);
    await d.execute({ name: "uia_tree", max_depth: 0, max_nodes: -5 } as ComputerAction);
    expect(mockDispatch.mock.calls[0][2]).toEqual({
      root: "foreground",
      max_depth: 1,
      max_nodes: 1,
    });
  });

  it("uia_tree with an unrecognized root value falls back to 'foreground'", async () => {
    mockDispatch.mockResolvedValueOnce(TREE_RESULT);
    const d = new LocalComputerDriver("agent-1");
    await d.execute({ name: "uia_tree", root: "sideways" } as ComputerAction);
    expect(mockDispatch.mock.calls[0][2].root).toBe("foreground");
  });

  it("uia_invoke requires a non-empty numeric runtime_id — rejected WITHOUT a dispatch", async () => {
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({ name: "uia_invoke", pattern: "invoke" } as ComputerAction);
    expect(obs.ok).toBe(false);
    expect(obs.error).toContain("uia_invoke requires runtime_id");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("uia_invoke with pattern 'set_value' requires text (the value) — rejected WITHOUT a dispatch", async () => {
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({
      name: "uia_invoke",
      runtime_id: [7, 8],
      pattern: "set_value",
    } as ComputerAction);
    expect(obs.ok).toBe(false);
    expect(obs.error).toContain("set_value");
    expect(obs.error).toContain("text");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("uia_invoke sends {runtime_id, pattern} and the value for set_value", async () => {
    mockDispatch
      .mockResolvedValueOnce({ ok: true }) // computer_uia_invoke
      .mockResolvedValueOnce(SHOT); // follow-up screenshot
    const d = new LocalComputerDriver("agent-1");
    await d.execute({
      name: "uia_invoke",
      runtime_id: [7.4, 8.9],
      pattern: "set_value",
      text: "hello world",
    } as ComputerAction);
    expect(mockDispatch.mock.calls[0]).toEqual([
      "agent-1",
      "computer_uia_invoke",
      { runtime_id: [7, 9], pattern: "set_value", value: "hello world" },
      expect.any(Number),
      expect.objectContaining({ minAgentVersion: "0.9.0", capability: "computer" }),
    ]);
  });

  it("uia_invoke with an unknown pattern falls back to 'invoke'", async () => {
    mockDispatch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(SHOT);
    const d = new LocalComputerDriver("agent-1");
    await d.execute({
      name: "uia_invoke",
      runtime_id: [5],
      pattern: "hover" as ComputerAction["pattern"],
    } as ComputerAction);
    expect(mockDispatch.mock.calls[0][2].pattern).toBe("invoke");
  });
});

describe("driver — the 0.9.0 dispatch gate on the wire", () => {
  it("uia_tree and uia_invoke dispatch with minAgentVersion '0.9.0'", async () => {
    mockDispatch
      .mockResolvedValueOnce(TREE_RESULT)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(SHOT);
    const d = new LocalComputerDriver("agent-1");
    await d.execute({ name: "uia_tree" } as ComputerAction);
    await d.execute({ name: "uia_invoke", runtime_id: [1], pattern: "focus" } as ComputerAction);
    expect(mockDispatch.mock.calls.filter((c) => c[1].startsWith("computer_uia_")).every(
      (c) => c[4]?.minAgentVersion === "0.9.0",
    )).toBe(true);
  });

  it("the CORE vocabulary keeps its historical 0.3.2 gate (macOS untouched)", async () => {
    mockDispatch
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(SHOT);
    const d = new LocalComputerDriver("agent-1");
    await d.execute({ name: "click", x: 10, y: 20 } as ComputerAction);
    expect(mockDispatch.mock.calls[0][4]).toEqual({
      minAgentVersion: "0.3.2",
      capability: "computer",
    });
  });
});

describe("driver — uia_invoke triggers the follow-up screenshot exactly once", () => {
  it("invoke → invoke result, then ONE computer_screenshot (the post-input path)", async () => {
    mockDispatch
      .mockResolvedValueOnce({ ok: true }) // computer_uia_invoke
      .mockResolvedValueOnce(SHOT); // the follow-up screenshot
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({
      name: "uia_invoke",
      runtime_id: [130],
      pattern: "invoke",
    } as ComputerAction);
    const methods = mockDispatch.mock.calls.map((c) => c[1]);
    expect(methods).toEqual(["computer_uia_invoke", "computer_screenshot"]);
    expect(mockDispatch).toHaveBeenCalledTimes(2);
    expect(obs.ok).toBe(true);
    expect(obs.screenshotBase64).toBe(SHOT.screenshotBase64);
  });

  it("a failed follow-up screenshot after a successful invoke is non-fatal (stability parity)", async () => {
    mockDispatch
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error("camera died"));
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({
      name: "uia_invoke",
      runtime_id: [130],
      pattern: "invoke",
    } as ComputerAction);
    expect(obs.ok).toBe(true);
    expect(obs.error).toContain("follow-up screenshot failed");
    expect(obs.error).toContain("camera died");
  });
});

describe("driver — uia_tree is a text observation, never a follow-up screenshot", () => {
  it("tree → ONE dispatch total, observation carries text + node_count, no screenshotBase64", async () => {
    mockDispatch.mockResolvedValueOnce(TREE_RESULT);
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({ name: "uia_tree" } as ComputerAction);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][1]).toBe("computer_uia_tree");
    expect(obs.ok).toBe(true);
    expect(obs.text).toBe(TREE_RESULT.text);
    expect(obs.node_count).toBe(42);
    expect(obs.screenshotBase64).toBeUndefined();
  });

  it("a tree result that (contrary to contract) carries a frame keeps it — no second dispatch", async () => {
    mockDispatch.mockResolvedValueOnce({ ...TREE_RESULT, screenshotBase64: " Frame2 " });
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({ name: "uia_tree" } as ComputerAction);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(obs.screenshotBase64).toBe(" Frame2 ");
    expect(obs.text).toBe(TREE_RESULT.text);
  });
});

describe("driver — '<CODE>: guidance' refusals propagate verbatim", () => {
  it.each([
    "UIA_E_ELEVATED: the target window runs elevated (administrator) — click it yourself or rerun from a non-admin window",
    "UIA_E_SECURE_DESKTOP: the secure desktop (UAC prompt) blocks UIA — answer the prompt yourself, then retry",
    "UIA_E_DRM: the window refuses automation (DRM) — use the keyboard instead",
    "UIA_E_ANTICHEAT: the app blocks automation (anti-cheat) — use the keyboard instead",
    "UIA_E_NOT_FOUND: that runtime_id is gone — re-read the tree with uia_tree",
    "UIA_E_UNSUPPORTED: the element supports none of those patterns — try a different one",
  ])("agent refusal %j reaches the observation error UNMODIFIED", async (errString) => {
    mockDispatch.mockResolvedValueOnce({ ok: false, error: errString });
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({ name: "uia_tree" } as ComputerAction);
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe(errString); // byte-identical — the loop's Windows instructions name these codes
  });
});

describe("computerToolsForPlatform — W3 windows-only UIA tools", () => {
  it("macOS (and null/undefined) tool set is UNCHANGED — no uia_tree, no uia_invoke", () => {
    expect(computerToolsForPlatform("macos")).toBe(COMPUTER_TOOLS);
    expect(computerToolsForPlatform(null)).toBe(COMPUTER_TOOLS);
    expect(computerToolsForPlatform(undefined)).toBe(COMPUTER_TOOLS);
    const names = COMPUTER_TOOLS.map((t) => t.name);
    expect(names).not.toContain("uia_tree");
    expect(names).not.toContain("uia_invoke");
  });

  it("windows = the eight core tools (windows doctrine) PLUS uia_tree + uia_invoke", () => {
    const win = computerToolsForPlatform("windows", "0.9.0");
    const names = win.map((t) => t.name);
    expect(names).toEqual([
      ...COMPUTER_TOOLS.map((t) => t.name),
      "uia_tree",
      "uia_invoke",
    ]);
    // The core eight keep their W1 windows doctrine (no macOS strings leaked).
    const all = win.map((t) => `${t.name}: ${t.description}`).join("\n");
    expect(all).not.toContain("Mac screen");
    expect(all).toContain("Windows screen");
  });

  it("the UIA tool descriptions name the refusal codes verbatim", () => {
    const all = computerToolsForPlatform("windows", "0.9.0")
      .filter((t) => t.name.startsWith("uia_"))
      .map((t) => t.description)
      .join("\n");
    for (const code of [
      "UIA_E_ELEVATED",
      "UIA_E_SECURE_DESKTOP",
      "UIA_E_DRM",
      "UIA_E_ANTICHEAT",
      "UIA_E_NOT_FOUND",
      "UIA_E_UNSUPPORTED",
    ]) {
      expect(all).toContain(code);
    }
    // The warning class flows through the tree text (nothing to parse).
    expect(all).toContain("UIA_W_DRM_SUSPECTED");
  });

  it("uia_invoke's schema: runtime_id (number[]) + pattern enum + optional text", () => {
    const tool = computerToolsForPlatform("windows", "0.9.0").find((t) => t.name === "uia_invoke")!;
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        runtime_id: { type: "array", items: { type: "number" } },
        pattern: { type: "string", enum: ["invoke", "toggle", "expand", "select", "focus", "set_value"] },
        text: { type: "string" },
      },
      required: ["runtime_id", "pattern"],
    });
  });

  it("uia_tree's schema: root enum + max_depth + max_nodes, all optional", () => {
    const tool = computerToolsForPlatform("windows", "0.9.0").find((t) => t.name === "uia_tree")!;
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        root: { type: "string", enum: ["foreground", "desktop"] },
        max_depth: { type: "number" },
        max_nodes: { type: "number" },
      },
    });
    expect((tool.parameters as any).required).toBeUndefined();
  });

  it("the returned windows tool array is a COPY — mutating it never touches COMPUTER_TOOLS", () => {
    const win = computerToolsForPlatform("windows", "0.9.0");
    win.push({ type: "function", name: "rogue", description: "x", parameters: {} });
    expect(COMPUTER_TOOLS.map((t) => t.name)).not.toContain("rogue");
  });
});

describe("instructionsForPlatform — the UIA splice is windows-only", () => {
  it("windows instructions mention uia_tree and uia_invoke (agent ≥ 0.9.0)", () => {
    const win = instructionsForPlatform("windows", "0.9.0");
    expect(win).toContain("uia_tree");
    expect(win).toContain("uia_invoke");
    expect(win).toContain("accessibility tree");
    expect(win).toContain("runtime_id");
  });

  it("B1 (review, PR #1064): a Windows agent OLDER than 0.9.0 gets NO uia_* tools and NO uia_* instructions — the model is never steered into a 45s version-gate timeout", () => {
    // Tools: the plain windows core set (8 tools, no uia_*).
    const win080 = computerToolsForPlatform("windows", "0.8.0");
    expect(win080.map((t) => t.name)).toEqual(COMPUTER_TOOLS.map((t) => t.name));
    // The W1 windows doctrine still applies (screenshot tool, not the mac copy).
    expect(win080.map((t) => t.description).join("\n")).toContain("Windows screen");

    // Instructions: no uia_* sentence.
    const ins080 = instructionsForPlatform("windows", "0.8.0");
    expect(ins080).not.toContain("uia_tree");
    expect(ins080).not.toContain("uia_invoke");
    // …but the W1 windows-only notices are still there.
    expect(ins080).toContain("UIPI");

    // An unknown/missing version is CONSERVATIVE: no UIA tools offered.
    const winUnknown = computerToolsForPlatform("windows", undefined);
    expect(winUnknown.map((t) => t.name)).toEqual(COMPUTER_TOOLS.map((t) => t.name));
    expect(computerToolsForPlatform("windows", null).map((t) => t.name)).toEqual(
      COMPUTER_TOOLS.map((t) => t.name),
    );

    // Boundary: exactly 0.9.0 IS UIA-capable.
    expect(computerToolsForPlatform("windows", "0.9.0").map((t) => t.name)).toContain("uia_tree");
    // And a future 1.0.0 too.
    expect(computerToolsForPlatform("windows", "1.0.0").map((t) => t.name)).toContain("uia_tree");
  });

  it("macOS (and null) instructions never mention uia_* — byte-identical to the historical text", () => {
    const mac = instructionsForPlatform("macos");
    const null_ = instructionsForPlatform(null);
    expect(mac).toBe(null_);
    expect(mac).not.toContain("uia_tree");
    expect(mac).not.toContain("uia_invoke");
    expect(mac).not.toContain("UIA");
    // The W1 windows-only notices are absent from macOS too (regression pin).
    expect(mac).not.toContain("UIPI");
    expect(mac).toContain("Screen Recording / Accessibility");
  });
});

describe("runComputerAgentSession — uia actions through the loop (windows platform)", () => {
  it("uia_tree observation reaches the model as TEXT (no screenshot round-trip), and older trees are stripped", async () => {
    mockListAgents.mockResolvedValue([agentRow()]);
    mockDispatch
      .mockResolvedValueOnce(SHOT) // initial screenshot
      .mockResolvedValueOnce(TREE_RESULT) // uia_tree #1
      .mockResolvedValueOnce({ ...TREE_RESULT, text: "second tree", node_count: 3 }); // uia_tree #2
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("uia_tree", { reasoning: "list is dense" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("uia_tree", { root: "desktop" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Toggled." })], text: "" });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Toggled.");
    expect(r.steps).toBe(3);

    // Wire: screenshot → two uia_tree dispatches. NO screenshot after either tree.
    const methods = mockDispatch.mock.calls.map((c) => c[1]);
    expect(methods).toEqual([
      "computer_screenshot",
      "computer_uia_tree",
      "computer_uia_tree",
    ]);

    // The second uia_tree call carries root: "desktop".
    expect(mockDispatch.mock.calls[2][2]).toMatchObject({ root: "desktop" });

    // The LAST model input contains the newest tree text and NOT the older one
    // (stripOlderTrees discipline), and no uia_* tool result hides the text.
    const lastInput = mockVisionChat.mock.calls[mockVisionChat.mock.calls.length - 1][0]
      .input as any[];
    const flat = JSON.stringify(lastInput);
    expect(flat).toContain("second tree");
    expect(flat).not.toContain("window 'Settings'");
    expect(flat).toContain("Accessibility tree of the desktop");
    expect(flat).toContain("[earlier accessibility tree omitted]");
  });

  it("uia_invoke observation reaches the model WITH its follow-up screenshot", async () => {
    mockDispatch
      .mockResolvedValueOnce(SHOT) // initial
      .mockResolvedValueOnce({ ok: true }) // computer_uia_invoke
      .mockResolvedValueOnce(SHOT); // follow-up screenshot
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [
          fnCall("uia_invoke", { runtime_id: [130], pattern: "toggle", reasoning: "the toggle" }),
        ],
        text: "",
      })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Done." })], text: "" });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Done.");
    const methods = mockDispatch.mock.calls.map((c) => c[1]);
    expect(methods).toEqual([
      "computer_screenshot",
      "computer_uia_invoke",
      "computer_screenshot",
    ]);
    expect(mockDispatch.mock.calls[1][2]).toEqual({ runtime_id: [130], pattern: "toggle" });
    // The model input after the invoke carries the fresh screenshot as an image.
    const lastInput = mockVisionChat.mock.calls[mockVisionChat.mock.calls.length - 1][0]
      .input as any[];
    const lastUser = [...lastInput].reverse().find((i: any) => i.role === "user") as any;
    expect(lastUser.content.some((c: any) => c.type === "input_image")).toBe(true);
  });

  it("an agent refusal string is fed back to the model VERBATIM in the tool result", async () => {
    const refusal = "UIA_E_ELEVATED: the target window runs elevated (administrator) — click it yourself or rerun from a non-admin window";
    mockDispatch
      .mockResolvedValueOnce(SHOT) // initial screenshot
      .mockResolvedValueOnce({ ok: false, error: refusal }); // uia_invoke refused
    mockVisionChat
      .mockResolvedValueOnce({
        functionCalls: [
          fnCall("uia_invoke", { runtime_id: [9], pattern: "invoke", reasoning: "elevated app" }),
        ],
        text: "",
      })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("done", { message: "Blocked — elevated." })],
        text: "",
      });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Blocked — elevated.");
    const secondCall = mockVisionChat.mock.calls[1][0].input as any[];
    const out = secondCall.find((i: any) => i.type === "function_call_output") as any;
    expect(JSON.parse(out.output).error).toBe(refusal);
  });

  it("the loop offers the UIA tools ONLY on the windows branch (macos session keeps the eight)", async () => {
    // macOS agent row (legacy — no platform/capability fields).
    mockListAgents.mockResolvedValue([agentRow({ platform: undefined, capabilities: undefined, agentVersion: "0.4.0", label: "MacBook Pro" })]);
    mockDispatch.mockResolvedValueOnce(SHOT);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(baseInput());
    const toolsArg = mockVisionChat.mock.calls[0][0].tools as { name: string }[];
    // cu-diag fix #3: + the harness `wait` tool (offered on every platform).
    expect(toolsArg.map((t) => t.name)).toEqual([...COMPUTER_TOOLS.map((t) => t.name), "wait"]);

    // Windows agent row — RE-MOCK listAgents for the second half (resetAllMocks
    // in beforeEach nukes the macOS setup; each half owns its state).
    mockListAgents.mockResolvedValue([agentRow()]);
    mockIsOnline.mockReturnValue(true);
    mockAcquireLock.mockResolvedValue("lock-token-1");
    mockVisionConfigured.mockReturnValue(true);
    mockDispatch.mockClear();
    mockVisionChat.mockClear();
    mockDispatch.mockResolvedValueOnce(SHOT);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(baseInput());
    const winTools = mockVisionChat.mock.calls[0][0].tools as { name: string }[];
    expect(winTools.map((t) => t.name)).toEqual([
      ...COMPUTER_TOOLS.map((t) => t.name),
      "uia_tree",
      "uia_invoke",
      "wait", // cu-diag fix #3
    ]);
  });

  it("B1 (review, PR #1064): a session against a Windows agent OLDER than 0.9.0 is never offered the uia tools", async () => {
    // The currently-shipped Windows agent is 0.8.x — offering uia_* there
    // would steer the model into version-gated 45s broker timeouts.
    mockListAgents.mockResolvedValue([agentRow({ agentVersion: "0.8.0" })]);
    mockDispatch.mockResolvedValueOnce(SHOT);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(baseInput());
    const toolsArg = mockVisionChat.mock.calls[0][0].tools as { name: string }[];
    expect(toolsArg.map((t) => t.name)).toEqual([...COMPUTER_TOOLS.map((t) => t.name), "wait"]); // + wait (cu-diag fix #3)
    // And the instructions for that session carry no uia_* sentence either.
    const ins = mockVisionChat.mock.calls[0][0].instructions as string;
    expect(ins).not.toContain("uia_tree");
    expect(ins).not.toContain("uia_invoke");
  });

  it("a uia action on a non-windows driver still dispatches (the wire is platform-blind; the tools are not offered on macOS)", async () => {
    // Defensive pin: the driver executes whatever the action union allows — the
    // PLATFORM TOOL GATING is what keeps uia_* off macOS sessions.
    mockDispatch.mockResolvedValueOnce(TREE_RESULT);
    const d = new LocalComputerDriver("agent-1");
    const obs = await d.execute({ name: "uia_tree", root: "desktop" } as ComputerAction);
    expect(obs.ok).toBe(true);
    expect(mockDispatch.mock.calls[0][4].minAgentVersion).toBe("0.9.0");
  });
});
