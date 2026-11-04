/**
 * Ticket 8fe9429c — read-only sub-agent quit Terminal on a paired Mac via
 * computer use, killing a nohup'd transfer (mishap replay suite).
 *
 * THE MISHAP (2026-09-25 ~20:20Z): during the canlegal-bench Mac citator
 * harvest endgame, a READ-ONLY sub-agent of lane 11449a0a — dispatched to
 * OBSERVE the Mac — quit the Terminal app via computer use. Terminal's death
 * killed the harvest pusher's nohup'd tar+scp child, which was shipping the
 * ~100MB results bundle Mac→box. The completed 371/371 harvest's bundle
 * transfer died; ~1h of recovery followed.
 *
 * MECHANISM: read-only delegate roles cannot create or edit files, but they
 * CAN drive computer use on a paired device. `computer_task` is in no
 * ROLE_TOOLS role (refused at the agent.ts allowedTools gate), but
 * `browser_task` IS granted to web_researcher/cross_checker — and the
 * browser_task router can hand the task to the COMPUTER destination
 * (runComputerAgentSession) with the FULL input vocabulary (click / type /
 * key — including app-quit keystrokes — / scroll / open / uia_invoke). The
 * lane's own "camera-only computer_task, zero input" convention was prompt
 * discipline, not framework enforcement.
 *
 * THE FIX (this suite's subject) — observe-only device access for role-scoped
 * workers, enforced at FOUR layers so no single regression reopens the hole:
 *   1. ToolCache gains a `computerInputMode` constructor flag; agentLoop marks
 *      the per-run cache 'observe' whenever the run is a WORKER (opts.role
 *      set). The orchestrator/lead keeps 'full'.
 *   2. tool-executor threads the flag into BOTH browser_task (as
 *      computerInputMode) and computer_task (as inputMode) sub-sessions.
 *   3. glm-loop passes computerInputMode through the COMPUTER handoff.
 *   4. computer-loop — the enforcement point — refuses every input action
 *      (click/type/key/scroll/open/uia_invoke) BEFORE driver.execute when
 *      inputMode === 'observe': nothing is dispatched to the device.
 *      Screenshots and uia_tree reads stay available (camera-only).
 *
 * Pins BOTH directions per the __replays__ convention:
 *   - the incident shape IS refused (an input action from an observe-only
 *     session never reaches the driver),
 *   - the honest twins stay clean (observe-only screenshots DO work;
 *     full-mode sessions are byte-identical to the historical behavior),
 *   - the wiring invariants (the only non-test ToolCache constructor marks
 *     role-scoped runs observe-only; both executor cases thread the flag).
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

import {
  runComputerAgentSession,
  observeOnlyTools,
  OBSERVE_ONLY_REFUSAL,
  COMPUTER_TOOLS,
  computerToolsForPlatform,
} from "./computer-loop";
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

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  userId: "user-1",
  label: "MacBook Pro",
  deviceId: "device-1",
  isDefault: true,
  agentVersion: "0.5.0",
  lastSeenAt: new Date(),
  ...over,
});

// Content-rich frame ≈0.18 bpp (the 6f4f8b36 calibration).
const RICH_A = {
  ok: true,
  screenshotBase64: "RnJhbWUx".repeat(46000),
  imageWidth: 1568,
  imageHeight: 980,
  screenWidth: 1512,
  screenHeight: 982,
  frontmostApp: "Terminal",
};
const RICH_B = { ...RICH_A, screenshotBase64: "RnJhbWUy".repeat(46000) };

/** The incident's observation worker: a read-only delegate's session. */
const observeInput = () => ({
  userId: "user-1",
  chatId: null,
  message: "Look at the Mac screen and report what Terminal shows — do not touch anything.",
  sendEvent: jest.fn(),
  inputMode: "observe" as const,
});

/** A full-control session (the orchestrator / lead). */
const fullInput = () => ({
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

/** The input actions the observe-only gate must refuse (ticket 8fe9429c's
 *  vocabulary — 'key q + cmd' is the exact incident keystroke). */
const INCIDENT_INPUT_ACTIONS: Array<[string, Record<string, unknown>]> = [
  ["key", { key: "q", modifiers: ["cmd"] }], // the incident: quit Terminal
  ["click", { x: 40, y: 8 }],
  ["type", { text: "text edit" }],
  ["scroll", { direction: "down" }],
  ["open", { target: "TextEdit" }],
];

beforeEach(() => {
  jest.clearAllMocks();
  mockVisionConfigured.mockReturnValue(true);
  mockIsOnline.mockReturnValue(true);
  mockListAgents.mockResolvedValue([agentRow()]);
  mockAcquireLock.mockResolvedValue("lock-token-1");
});

describe("REPLAY 8fe9429c — the incident shape is refused at the dispatch gate", () => {
  it("THE INCIDENT: an observe-only session's cmd+q NEVER reaches the driver — Terminal cannot be quit by an observation worker", async () => {
    const input = observeInput();
    // The initial screenshot is ALLOWED (camera): one dispatch.
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial screenshot (observe: allowed)
      .mockResolvedValueOnce(RICH_B); // a follow-up screenshot the model takes
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "q", modifiers: ["cmd"] })], text: "" }) // the incident keystroke
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" }) // model re-grounds (allowed)
      .mockResolvedValueOnce({
        functionCalls: [fnCall("done", { message: "Observation complete — Terminal shows the harvest runner at 371/371. No input was sent." })],
        text: "",
      });

    const r = await runComputerAgentSession(input);

    // THE pin: no input dispatch happened. Only screenshot dispatches
    // (computer_screenshot) were sent to the device — the cmd+q was refused
    // at the gate BEFORE driver.execute, so Terminal stays alive.
    const dispatched = mockDispatch.mock.calls.map((c) => c[1]);
    expect(dispatched).toEqual(["computer_screenshot", "computer_screenshot"]);
    // The model SAW a hard refusal naming the observe-only limit…
    const outputs = (mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[])
      .filter((i: any) => i?.type === "function_call_output")
      .map((i: any) => JSON.parse(i.output));
    const refused = outputs.find((o: any) => o.ok === false);
    expect(refused?.error).toContain("OBSERVE-ONLY SESSION");
    // …and the session still produced its observation report.
    expect(r.steps).toBe(3);
    expect(r.finalResponse).toContain("371/371");
    expect(r.observeOnly).toBe(true);
  });

  it.each(INCIDENT_INPUT_ACTIONS)(
    "every input action (%s) is refused in observe-only mode — never dispatched",
    async (name, args) => {
      const input = observeInput();
      mockDispatch.mockResolvedValue(RICH_A); // screenshots only
      mockVisionChat
        .mockResolvedValueOnce({ functionCalls: [fnCall(name, args)], text: "" })
        .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "done" })], text: "" });

      const r = await runComputerAgentSession(input);

      // The ONLY dispatch is the initial screenshot (plus any explicit
      // screenshot the model took — here none): the input action never
      // produced a computer_click/type/key/scroll/open dispatch.
      const inputDispatches = mockDispatch.mock.calls
        .map((c) => String(c[1]))
        .filter((m) => m !== "computer_screenshot");
      expect(inputDispatches).toEqual([]);
      expect(r.observeOnly).toBe(true);
      const outputs = (mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[])
        .filter((i: any) => i?.type === "function_call_output")
        .map((i: any) => JSON.parse(i.output));
      expect(outputs.some((o: any) => o.ok === false && String(o.error).includes("OBSERVE-ONLY"))).toBe(true);
    },
  );

  it("a Windows uia_invoke (the click-free activation) is ALSO refused in observe-only mode", async () => {
    mockListAgents.mockResolvedValue([agentRow({ platform: "windows", agentVersion: "0.9.0" })]);
    const input = observeInput();
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("uia_invoke", { runtime_id: [1, 2], pattern: "invoke" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "done" })], text: "" });

    await runComputerAgentSession(input);

    const dispatched = mockDispatch.mock.calls.map((c) => String(c[1]));
    expect(dispatched.filter((m) => m.startsWith("computer_uia"))).toEqual([]);
    expect(
      mockDispatch.mock.calls.some((c) => String(c[1]) === "computer_uia_invoke"),
    ).toBe(false);
  });

  it("HONEST TWIN: an observe-only session CAN screenshot and read (the camera works)", async () => {
    const input = observeInput();
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce(RICH_B); // explicit screenshot tool call — allowed
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", { reasoning: "re-ground" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Saw the screen fine." })], text: "" });

    const r = await runComputerAgentSession(input);

    expect(mockDispatch.mock.calls.filter((c) => c[1] === "computer_screenshot")).toHaveLength(2);
    expect(r.finalResponse).toBe("Saw the screen fine.");
    expect(r.observeOnly).toBe(true);
  });
});

describe("HONEST TWIN — full-control sessions are byte-identical to the historical behavior", () => {
  it("a full session (no inputMode) still dispatches click/type/key to the device", async () => {
    const input = fullInput();
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce({ ok: true }) // click dispatched
      .mockResolvedValueOnce(RICH_B) // auto-shot
      .mockResolvedValueOnce({ ok: true }) // type dispatched
      .mockResolvedValueOnce(RICH_B); // auto-shot
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 40, y: 8 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "note" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Typed the note." })], text: "" });

    const r = await runComputerAgentSession(input);

    expect(mockDispatch.mock.calls.map((c) => c[1])).toEqual([
      "computer_screenshot",
      "computer_click",
      "computer_screenshot",
      "computer_type",
      "computer_screenshot",
    ]);
    expect(r.finalResponse).toBe("Typed the note.");
    expect(r.observeOnly).toBeUndefined(); // full mode: the flag is absent, not false
  });

  it("explicit inputMode 'full' behaves like the historical default", async () => {
    const input = { ...fullInput(), inputMode: "full" as const };
    mockDispatch
      .mockResolvedValueOnce(RICH_A)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(RICH_B);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });

    const r = await runComputerAgentSession(input);
    expect(mockDispatch.mock.calls.map((c) => c[1])).toContain("computer_key");
    expect(r.observeOnly).toBeUndefined();
  });
});

describe("the observe-only OFFERED vocabulary (camera tools only)", () => {
  it("observeOnlyTools offers ONLY screenshot + done on macOS (no input tools named to the model)", () => {
    const tools = observeOnlyTools("macos", "0.5.0");
    expect(tools.map((t) => t.name).sort()).toEqual(["done", "screenshot"]);
    // the incident vocabulary is absent by name
    for (const banned of ["click", "type", "key", "scroll", "open", "uia_invoke", "uia_tree", "ask_user"]) {
      expect(tools.map((t) => t.name)).not.toContain(banned);
    }
  });

  it("a Windows agent new enough for UIA keeps the uia_tree READ but not uia_invoke", () => {
    const tools = observeOnlyTools("windows", "0.9.0");
    expect(tools.map((t) => t.name).sort()).toEqual(["done", "screenshot", "uia_tree"]);
    expect(tools.map((t) => t.name)).not.toContain("uia_invoke");
  });

  it("an observe-only session's vision calls offer the camera vocabulary (and the instructions say camera-only)", async () => {
    const input = observeInput();
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "done" })], text: "" });
    await runComputerAgentSession(input);

    const offered = (mockVisionChat.mock.calls[0][0] as any).tools as Array<{ name: string }>;
    expect(offered.map((t) => t.name).sort()).toEqual(["done", "screenshot", "wait"]); // wait is camera-safe (cu-diag fix #3)
    const instructions = (mockVisionChat.mock.calls[0][0] as any).instructions as string;
    expect(instructions).toContain("OBSERVE-ONLY SESSION");
  });

  it("the full vocabulary (macOS) is untouched by the change — still the historical eight tools", () => {
    // computerToolsForPlatform(null) === COMPUTER_TOOLS byte-identically (W1 pin)
    expect(computerToolsForPlatform(null)).toBe(COMPUTER_TOOLS);
    const names = COMPUTER_TOOLS.map((t: { name: string }) => t.name);
    for (const needed of ["screenshot", "click", "type", "key", "scroll", "open", "ask_user", "done"]) {
      expect(names).toContain(needed);
    }
  });

  it("OBSERVE_ONLY_REFUSAL names the limit and the escape hatch (a contract the model reads)", () => {
    expect(OBSERVE_ONLY_REFUSAL).toContain("OBSERVE-ONLY SESSION");
    expect(OBSERVE_ONLY_REFUSAL).toContain("NOT dispatched to the device");
    expect(OBSERVE_ONLY_REFUSAL).toContain("call done");
  });
});

describe("wiring — the mode travels from the worker's cache to the device gate", () => {
  it("runComputerAgentSession defaults to FULL when inputMode is absent (the orchestrator's ToolCache passes nothing)", async () => {
    const input = fullInput();
    mockDispatch
      .mockResolvedValueOnce(RICH_A)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce(RICH_B);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 1, y: 1 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    const r = await runComputerAgentSession(input);
    expect(mockDispatch.mock.calls.map((c) => c[1])).toContain("computer_click");
    expect(r.observeOnly).toBeUndefined();
  });
});

// The ToolCache flag → executor threading + the agentLoop role-scoped marking
// are pinned in the adjacent integration suite (computer-agent/
// observe-only.toolcache.8fe9429c.test.ts) because they need the tool-executor
// mock surface; the device gate itself (the enforcement that actually protects
// the Mac) is fully pinned above.
