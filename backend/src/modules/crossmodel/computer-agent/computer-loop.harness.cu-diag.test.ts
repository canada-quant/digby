/**
 * cu-diag fixes #2 / #3 / #4 / #5 (2026-09-25) — the computer-use HARNESS
 * replay suite. The incident (runs fa6eb1b1 / f19b0636, agent v0.4.3, the
 * owner's MacBook with the lid closed + a Dell + a Screen Sharing virtual
 * display): input LANDED (frontmost Terminal→TextEdit on byte-identical
 * frames — the app opened on a display the agent was not capturing) while
 *   • the write-path watchdog scored dead-input strikes and aborted (#2),
 *   • the degeneration guard refused the 3rd/6th screenshot of an 8-shot
 *     camera task and read cmd+space as a repeat of space (#3),
 *   • the bytes/pixel proxy graded readable dark Terminal frames "degenerate"
 *     44 times, disarming the watchdog and escalating "call done NOW" (#4),
 *   • the finalize site shipped leaked DSML markup as the final answer and
 *     the "[earlier screenshot omitted]" placeholder was narrated as capture
 *     failure (#5).
 *
 * Mock topology = computer-loop.watchdog-false-abort.6f4f8b36.test.ts (real
 * driver + loop between mocked edges).
 */

import * as fs from "fs";
import * as path from "path";

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

import logger from "../../../utils/logger";
import {
  runComputerAgentSession,
  actionSignature,
  clampWaitSeconds,
  looksLikeVisionSeatLeak,
  withWaitTool,
  COMPUTER_TOOLS,
  EARLIER_FRAME_PLACEHOLDER,
  VISION_LEAK_NUDGE,
  WAIT_MAX_SECONDS,
  describeFrameDiff,
  gradeFrame,
  harnessFactsAddendum,
} from "./computer-loop";
import { platformPlaybookBlock } from "../chat-agent/capability-doctrine";
import { agentBroker } from "../imessage/agent-link";
import { listAgents, isOnline } from "../imessage/imessage.service";
import { visionChat, visionConfigured } from "./vision-client";
import { acquireComputerUseLock } from "./use-lock";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const jpeg = require("jpeg-js");

const mockListAgents = listAgents as jest.Mock;
const mockIsOnline = isOnline as jest.Mock;
const mockDispatch = agentBroker.dispatch as jest.Mock;
const mockVisionChat = visionChat as jest.Mock;
const mockVisionConfigured = visionConfigured as jest.Mock;
const mockAcquireLock = acquireComputerUseLock as jest.Mock;
const mockWarn = (logger as any).warn as jest.Mock;

const agentRow = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  userId: "user-1",
  label: "MacBook Pro",
  deviceId: "device-1",
  isDefault: true,
  agentVersion: "0.4.3",
  lastSeenAt: new Date(),
  ...over,
});

// Fake (undecodable) content-rich frames — graded by the bpp fallback exactly
// like the 6f4f8b36 suite (≈0.18 bpp ⇒ readable).
const RICH_A = {
  ok: true,
  screenshotBase64: "RnJhbWUx".repeat(46000),
  imageWidth: 1568,
  imageHeight: 980,
  screenWidth: 1512,
  screenHeight: 982,
};
const RICH_B = { ...RICH_A, screenshotBase64: "RnJhbWUy".repeat(46000) };
const OK = { ok: true };

// Decoded frames (the readability metric runs on real JPEG bytes). The dark
// Terminal is the SYNTHETIC stand-in for the incident frame — the real capture
// showed the owner's hostname/username and is not in the repository; see
// backend/scripts/make-dark-terminal-fixture.js.
const TERMINAL_B64 = fs
  .readFileSync(path.join(__dirname, "__fixtures__", "dark-terminal-synthetic.jpg"))
  .toString("base64");
const TERMINAL = { ok: true, screenshotBase64: TERMINAL_B64, imageWidth: 1568, imageHeight: 1013, frontmostApp: "Terminal" };
function solidJpeg(v: number, width = 1568, height = 1013): string {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255; }
  return Buffer.from(jpeg.encode({ data, width, height }, 75).data).toString("base64");
}
const BLACK = { ok: true, screenshotBase64: solidJpeg(0), imageWidth: 1568, imageHeight: 1013, frontmostApp: "Terminal" };

const baseInput = () => ({
  userId: "user-1",
  chatId: null,
  message: "Open TextEdit and type a note",
  sendEvent: jest.fn(),
});

const fnCall = (name: string, args: Record<string, unknown>, callId = `call_${Math.random().toString(36).slice(2, 8)}`) =>
  ({ callId, name, arguments: JSON.stringify(args) });

const fedOutputs = (): any[] =>
  (mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[])
    .filter((i: any) => i?.type === "function_call_output")
    .map((i: any) => JSON.parse(i.output));

const userTexts = (): string[] =>
  (mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[])
    .filter((i: any) => i?.role === "user")
    .flatMap((i: any) => i.content ?? [])
    .map((c: any) => (typeof c === "string" ? c : c.text || ""));

const progressMessages = (input: ReturnType<typeof baseInput>): string[] =>
  input.sendEvent.mock.calls.filter((c: any[]) => c[0] === "progress").map((c: any[]) => c[1]?.message || "");

const dispatchedMethods = () => mockDispatch.mock.calls.map((c) => c[1]);

const ENV_KEYS = [
  "COMPUTER_CLICK_STRIKES_LEGACY",
  "COMPUTER_DEGENERATION_GUARD_LEGACY",
];

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks keeps queued mockResolvedValueOnce values — an aborted
  // session leaves its queue behind for the next test. Drain them.
  mockVisionChat.mockReset();
  mockDispatch.mockReset();
  for (const k of ENV_KEYS) delete process.env[k];
  mockVisionConfigured.mockReturnValue(true);
  mockIsOnline.mockReturnValue(true);
  mockListAgents.mockResolvedValue([agentRow()]);
  mockAcquireLock.mockResolvedValue("lock-token-1");
});
afterAll(() => { for (const k of ENV_KEYS) delete process.env[k]; });

// ═══════════════════════════════════════════════════════════════════════════
describe("fix #2 — write-path watchdog: frontmost change is POSITIVE input evidence", () => {
  it("REPLAY fa6eb1b1: cmd+space (identical, Terminal) → return (identical, but frontmost Terminal→TextEdit) ⇒ streak RESET + 'INPUT DELIVERED' note, no probe, no abort", async () => {
    const T = { ...RICH_A, frontmostApp: "Terminal" };
    const TE = { ...RICH_A, frontmostApp: "TextEdit" }; // byte-identical frame, different frontmost
    mockDispatch
      .mockResolvedValueOnce(T) // initial
      .mockResolvedValueOnce(OK) // cmd+space
      .mockResolvedValueOnce(T) // identical, same app ⇒ strike 1
      .mockResolvedValueOnce(OK) // return
      .mockResolvedValueOnce(TE); // identical bytes, frontmost changed ⇒ RESET
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "space", modifiers: ["cmd"] })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "TextEdit is open." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("TextEdit is open.");
    expect(progressMessages(input).some((m) => m.includes("Input watchdog"))).toBe(false);
    expect(dispatchedMethods().filter((m) => m === "computer_key")).toHaveLength(2); // NO probe keystrokes
    const outs = fedOutputs();
    expect(outs[0].noVisibleChange).toBe(1);
    expect(outs[1].noVisibleChange).toBeUndefined();
    expect(outs[1].inputDelivered).toBe(true);
    expect(outs[1].note).toContain("INPUT DELIVERED");
    expect(outs[1].note).toContain("Terminal→TextEdit");
    expect(outs[1].harness).toContain("bytes identical");
    expect(outs[1].harness).toContain("frontmost changed Terminal→TextEdit");
    expect(r.harness).toMatchObject({ noChangeStrikes: 1, frontmostChanges: 1, probesRun: 0 });
  });

  it("no-op CLICKS are advisory: three identical-frame clicks ⇒ zero strikes, three advisories, no probe, no abort (the 18:10Z false abort)", async () => {
    mockDispatch.mockResolvedValue(RICH_A);
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 10, y: 10 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 20, y: 20 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 30, y: 30 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Selected already." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("Selected already.");
    expect(r.steps).toBe(4);
    expect(progressMessages(input).some((m) => m.includes("Input watchdog"))).toBe(false);
    const outs = fedOutputs();
    expect(outs.filter((o) => o.noVisibleChange !== undefined)).toEqual([]);
    expect(outs.filter((o) => o.noVisibleChangeAdvisory === true)).toHaveLength(3);
    expect(outs[0].warning).toContain("advisory");
    expect(outs[0].warning).toContain("NOT counted");
    expect(r.harness?.noChangeStrikes).toBe(0);
    expect(r.harness?.probesRun).toBe(0);
    // Kill switch: clicks strike again.
    process.env.COMPUTER_CLICK_STRIKES_LEGACY = "1";
    jest.clearAllMocks();
    mockListAgents.mockResolvedValue([agentRow()]);
    mockIsOnline.mockReturnValue(true);
    mockAcquireLock.mockResolvedValue("lock-token-1");
    mockVisionConfigured.mockReturnValue(true);
    mockDispatch.mockResolvedValueOnce(RICH_A).mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 10, y: 10 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "x" })], text: "" });
    const r2 = await runComputerAgentSession(baseInput());
    expect(fedOutputs()[0].noVisibleChange).toBe(1);
    expect(r2.harness?.noChangeStrikes).toBe(1);
  });

  it("a PASSED probe proves input lands: later strikes annotate ('PROVEN to land') but NEVER abort, even past the legacy limit", async () => {
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type ⇒ strike 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type ⇒ strike 2 ⇒ probe
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // probe cmd+space ⇒ CHANGED ⇒ pass
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // escape ⇒ back
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type ⇒ strike 1 (proven)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type ⇒ 2
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type ⇒ 3 — would abort legacy
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A); // type ⇒ 4
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "c" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "d" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "e" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "f" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Typed into a field off-camera." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("Typed into a field off-camera.");
    expect(r.steps).toBe(7);
    expect(progressMessages(input).some((m) => m.includes("stopping with a blocked report"))).toBe(false);
    const outs = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(outs.map((o) => o.noVisibleChange)).toEqual([1, 2, 1, 2, 3, 4]);
    expect(outs[1].harnessProbe).toContain("POSITIVE CONTROL PASSED");
    expect(outs[2].warning).toContain("PROVEN to land");
    expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 1, inputProven: true, noChangeStrikes: 6 });
    // The model saw the post-probe frame (the screen after Escape), stamped as such.
    expect(userTexts().some((t) => t.includes("and the harness probe"))).toBe(true);
  });

  it("an observe-only session never dispatches the probe (it IS input)", async () => {
    // Input actions are refused before dispatch in observe mode, so strikes
    // cannot accrue — pin that no computer_key ever leaves the loop.
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "camera only" })], text: "" });
    await runComputerAgentSession({ ...baseInput(), inputMode: "observe" });
    expect(dispatchedMethods()).toEqual(["computer_screenshot"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("fix #2 review follow-up — the probe fires only on the action that SCORED a strike; inconclusive ⇒ one retry; FAILED ⇒ abort", () => {
  const probeProgress = (input: ReturnType<typeof baseInput>) =>
    progressMessages(input).filter((m) => m.includes("running a harness positive-control probe"));
  const probeKeys = () =>
    mockDispatch.mock.calls.filter((c) => c[1] === "computer_key").map((c) => c[2].key + (c[2].modifiers?.length ? "+" + c[2].modifiers.join("+") : ""));

  it("REPLAY (reviewer): INCONCLUSIVE probe (ok:false dispatch) at strike 2, then screenshot / wait / screenshot / bare Escape / done ⇒ exactly ONE probe, ONE Cmd+Space, zero probes on read or no-op turns, no abort", async () => {
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type a ⇒ strike 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type b ⇒ strike 2 ⇒ probe
      .mockResolvedValueOnce({ ok: false, error: "computer_key refused: hotkey unavailable" }) // probe cmd+space REFUSED (no frame)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // probe escape cleanup
      .mockResolvedValueOnce(RICH_A) // screenshot
      .mockResolvedValueOnce(RICH_A) // wait ⇒ screenshot
      .mockResolvedValueOnce(RICH_A) // screenshot
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A); // key escape (no-op-prone: streak HOLDS at 2)
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("wait", { seconds: 0.5 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "escape" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "gave up on the field" })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("gave up on the field");
    expect(progressMessages(input).some((m) => m.includes("stopping with a blocked report"))).toBe(false);
    // ONE probe, on the strike-2 action only: one Cmd+Space + its Escape, then the model's own Escape.
    expect(probeProgress(input)).toHaveLength(1);
    expect(probeKeys()).toEqual(["space+cmd", "escape", "escape"]);
    expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 0, inputProven: false, noChangeStrikes: 2 });
    const probeEvents = input.sendEvent.mock.calls.filter((c: any[]) => c[0] === "computer-observation" && c[1]?.action === "probe");
    expect(probeEvents).toHaveLength(1);
    expect(probeEvents[0][1].preview).toContain("inconclusive");
    // No read / wait / no-op-key outcome carries a probe verdict.
    const outs = fedOutputs();
    expect(outs).toHaveLength(7); // type, type, screenshot, wait, screenshot, escape, done
    expect(outs.slice(2).every((o) => o.harnessProbe === undefined)).toBe(true);
    expect(outs[1].noVisibleChange).toBe(2);
  });

  it("INCONCLUSIVE twice (refused at strike 2, no frame at strike 3) ⇒ the retry runs on the strike-3 action only, then the legacy abort names the inconclusive probes (not a FAILED probe)", async () => {
    mockListAgents.mockResolvedValue([agentRow({ agentVersion: "0.5.1" })]);
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type a ⇒ 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type b ⇒ 2 ⇒ probe #1
      .mockResolvedValueOnce({ ok: false, error: "refused" }) // probe cmd+space refused
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // probe escape
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type c ⇒ 3 ⇒ probe #2 (retry)
      .mockResolvedValueOnce(OK).mockRejectedValueOnce(new Error("capture failed")) // probe cmd+space ok, follow-up screenshot FAILS ⇒ no frame
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A); // probe escape
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "c" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "unreachable" })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.steps).toBe(3);
    expect(probeProgress(input)).toHaveLength(2);
    expect(probeKeys()).toEqual(["space+cmd", "escape", "space+cmd", "escape"]);
    expect(r.harness).toMatchObject({ probesRun: 2, probesPassed: 0, inputProven: false, noChangeStrikes: 3 });
    expect(r.finalResponse).toContain("Computer use stopped: 3 consecutive input actions");
    expect(r.finalResponse).toContain("tried its own positive-control probe (Cmd+Space, then Cmd+Tab, then Escape) 2 times but it was inconclusive");
    expect(r.finalResponse).not.toContain("ALSO produced a byte-identical frame");
    expect(r.finalResponse).toContain("v0.5.1");
    const stop = progressMessages(input).find((m) => m.includes("stopping with a blocked report"));
    expect(stop).toContain("3 consecutive");
    expect(stop).not.toContain("failed harness positive-control probe");
    expect(mockWarn.mock.calls.some((c) => String(c[0]).includes("probe unavailable"))).toBe(true);
  });

  it("a fresh streak after an inconclusive probe (visible change in between) may probe again at ITS strike 2 — within the 2-per-session budget — and a PASS then proves input", async () => {
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type ⇒ 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type ⇒ 2 ⇒ probe #1 (inconclusive)
      .mockResolvedValueOnce({ ok: false, error: "refused" })
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // type ⇒ CHANGED ⇒ streak reset
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // type ⇒ 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // type ⇒ 2 ⇒ probe #2
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // probe cmd+space ⇒ CHANGED ⇒ PASS
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B); // probe escape
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "c" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "d" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "e" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "proven" })], text: "" });
    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("proven");
    expect(probeProgress(input)).toHaveLength(2);
    expect(r.harness).toMatchObject({ probesRun: 2, probesPassed: 1, inputProven: true });
    const outs = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(outs.map((o) => o.noVisibleChange)).toEqual([1, 2, 1, 2]);
    expect(outs[3].harnessProbe).toContain("POSITIVE CONTROL PASSED");
  });

  it("FAILED probe (EVERY leg ⇒ identical frame, unchanged frontmost) at strike 2 ⇒ abort with the probe copy, geometry suffix and the 'failed harness positive-control probe' progress line — earlier than the legacy 3", async () => {
    mockListAgents.mockResolvedValue([agentRow({ agentVersion: "0.5.0" })]);
    const T = { ...RICH_A, frontmostApp: "Finder", displayCount: 2 };
    mockDispatch
      .mockResolvedValueOnce(T) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(T) // type ⇒ 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(T) // type ⇒ 2 ⇒ probe
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(T) // probe leg 1 cmd+space ⇒ IDENTICAL, same frontmost
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(T) // probe leg 2 cmd+tab ⇒ IDENTICAL too ⇒ FAILED
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(T); // probe escape
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "unreachable" })], text: "" });
    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.steps).toBe(2);
    expect(probeKeys()).toEqual(["space+cmd", "tab+cmd", "escape"]);
    expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 0, inputProven: false, noChangeStrikes: 2, frameGeometry: "1568×980", displayCount: 2 });
    expect(r.finalResponse).toContain("Computer use stopped: 2 consecutive input actions");
    expect(r.finalResponse).toContain("(last attempted: type) (frames 1568×980, 2 displays reported)");
    expect(r.finalResponse).toContain("The harness then ran its own positive-control probe (Cmd+Space, then Cmd+Tab, then Escape) and EVERY leg produced a byte-identical frame with an unchanged frontmost app.");
    expect(r.finalResponse).toContain("v0.5.0");
    expect(r.finalResponse).toContain("display I am not capturing");
    expect(r.finalResponse).not.toContain("older than");
    const stop = progressMessages(input).find((m) => m.includes("stopping with a blocked report"));
    expect(stop).toBe("Input watchdog: 2 consecutive no-visible-change actions and a failed harness positive-control probe — stopping with a blocked report.");
    const probeEvents = input.sendEvent.mock.calls.filter((c: any[]) => c[0] === "computer-observation" && c[1]?.action === "probe");
    expect(probeEvents).toHaveLength(1);
    expect(probeEvents[0][1]).toMatchObject({ ok: false, app: "Finder" });
    expect(probeEvents[0][1].preview).toContain("identical frame with an unchanged frontmost app");
    expect(mockWarn.mock.calls.some((c) => String(c[0]).includes("harness probe failed"))).toBe(true);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // ticket a40f64d9 — a REMAPPED single shortcut is not dead input.
  //
  // The reported symptom (lane 375ce2aa on cqlstannembp2): two Cmd+Space
  // presses produced pixel-identical frames and Shift+Cmd+A moved <0.1%, while
  // Escape dismissed a screensaver and mouse clicks landed in the SAME run.
  // The controlled probe then proved typing lands (discord.com/download typed
  // into Chrome's address bar, 5.3% pixel delta) — so key DELIVERY was fine and
  // the class was shortcut mapping. But the single-leg positive control graded
  // an inert-but-DELIVERED Cmd+Space as "input is not landing" and would abort
  // a healthy session with the WRONG owner-facing remedy (check Accessibility).
  // The control now runs a second leg before any such verdict.
  describe("ticket a40f64d9 — multi-leg positive control (a remapped shortcut is NOT dead input)", () => {
    it("REPLAY a40f64d9: Cmd+Space delivered-but-inert, Cmd+Tab proves input ⇒ PASS + remap note naming the OPEN-tool route, and NO abort", async () => {
      // Same screen for every frame the model never changes, but Cmd+Tab
      // switches frontmost Finder → Terminal: delivered input, on a frame shape
      // that is byte-identical.
      const F = { ...RICH_A, frontmostApp: "Finder" };
      const T = { ...RICH_A, frontmostApp: "Terminal" };
      mockDispatch
        .mockResolvedValueOnce(F) // initial
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type a ⇒ strike 1
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type b ⇒ strike 2 ⇒ probe
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // probe leg 1 cmd+space ⇒ identical, same frontmost (REMAPPED)
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(T) // probe leg 2 cmd+tab ⇒ frontmost changed ⇒ PASS
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // probe restore cmd+tab ⇒ back to Finder
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // probe escape cleanup
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type c (post-proof)
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F); // type d
      mockVisionChat
        .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
        .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
        .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "c" })], text: "" })
        .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Typed via a different route." })], text: "" });

      const input = baseInput();
      const r = await runComputerAgentSession(input);

      // The session is NOT killed and the input-delivery hypothesis is closed.
      expect(r.finalResponse).toBe("Typed via a different route.");
      expect(progressMessages(input).some((m) => m.includes("stopping with a blocked report"))).toBe(false);
      expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 1, inputProven: true });

      // Both legs ran, then the restore Tab and the Escape cleanup.
      const keys = mockDispatch.mock.calls.filter((c) => c[1] === "computer_key").map((c) => c[2]);
      expect(keys).toEqual([
        { key: "space", modifiers: ["cmd"] }, // leg 1 — inert
        { key: "tab", modifiers: ["cmd"] }, // leg 2 — proves input
        { key: "tab", modifiers: ["cmd"] }, // focus restored
        { key: "escape", modifiers: [] }, // cleanup
      ]);

      // The verdict rides the outcome AND names the remap + the open-tool route.
      const proven = fedOutputs().find((o) => o.harnessProbe);
      expect(proven.harnessProbe).toContain("POSITIVE CONTROL PASSED");
      expect(proven.harnessProbe).toContain("Cmd+Tab");
      expect(proven.harnessProbe).toContain("Cmd+Space changed nothing on this Mac");
      expect(proven.harnessProbe).toContain("use the open tool");
      expect(proven.harnessProbe).toContain("do not read an inert shortcut as dead input");
      // …and it must NOT diagnose a permission/input problem.
      expect(proven.harnessProbe).not.toContain("input-delivery hypothesis is open");
    });

    it("an INCONCLUSIVE first leg is NOT called remapped — no leg-1 remap claim when its dispatch was refused", async () => {
      const F = { ...RICH_A, frontmostApp: "Finder" };
      const T = { ...RICH_A, frontmostApp: "Terminal" };
      mockDispatch
        .mockResolvedValueOnce(F) // initial
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type ⇒ 1
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type ⇒ 2 ⇒ probe
        .mockResolvedValueOnce({ ok: false, error: "computer_key refused: hotkey unavailable" }) // leg 1 INCONCLUSIVE (no frame) ⇒ probe stops
        .mockResolvedValueOnce(OK).mockResolvedValueOnce(T); // probe escape cleanup
      mockVisionChat
        .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
        .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
        .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Stopped cleanly." })], text: "" });

      const input = baseInput();
      const r = await runComputerAgentSession(input);
      // Inconclusive ⇒ NO verdict, no abort, streak stands (existing contract).
      expect(r.finalResponse).toBe("Stopped cleanly.");
      expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 0, inputProven: false });
      // The second leg was never dispatched — an unread leg must not be
      // followed by more input (Cmd+Tab would switch apps blind).
      const keys = mockDispatch.mock.calls.filter((c) => c[1] === "computer_key").map((c) => c[2]);
      expect(keys).toEqual([
        { key: "space", modifiers: ["cmd"] },
        { key: "escape", modifiers: [] },
      ]);
      const probeEvents = input.sendEvent.mock.calls.filter((c: any[]) => c[0] === "computer-observation" && c[1]?.action === "probe");
      expect(probeEvents[0][1].preview).toContain("inconclusive");
      expect(probeEvents[0][1].preview).not.toContain("remapped");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("fix #3 — degeneration guard, wait tool, harness counters", () => {
  it("4 consecutive screenshots are ALL dispatched — never an ok:false nudge; identical repeats get a soft 'use wait' hint", async () => {
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "8-shot camera task ok" })], text: "" });
    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("8-shot camera task ok");
    expect(dispatchedMethods().filter((m) => m === "computer_screenshot")).toHaveLength(5); // initial + 4
    const outs = fedOutputs();
    expect(outs.every((o) => o.ok === true)).toBe(true);
    expect(outs.some((o) => String(o.error || "").includes("repeated the identical action"))).toBe(false);
    expect(outs[2].hint).toContain("use the wait tool");
    expect(r.harness?.refusedRepeats).toBe(0);
    expect(mockWarn.mock.calls.some((c) => String(c[0]).includes("repeated-action"))).toBe(false);
  });

  it("three `key up` presses are all dispatched (navigation keys are not degeneration); cmd+space after two bare spaces is a DIFFERENT action", async () => {
    // Every frame distinct: this pins the DEGENERATION guard, not the watchdog
    // (two bare spaces on identical frames would rightly strike).
    let n = 0;
    mockDispatch.mockImplementation(async (_agent: string, method: string) =>
      method === "computer_screenshot" ? { ...RICH_A, screenshotBase64: RICH_A.screenshotBase64 + "QUJD".repeat(++n) } : OK,
    );
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "up" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "up" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "up" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "space" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "space" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "space", modifiers: ["cmd"] })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "navigated" })], text: "" });
    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("navigated");
    const keys = mockDispatch.mock.calls.filter((c) => c[1] === "computer_key").map((c) => c[2].key + (c[2].modifiers.length ? "+" + c[2].modifiers.join("+") : ""));
    expect(keys).toEqual(["up", "up", "up", "space", "space", "space+cmd"]);
    expect(r.harness?.refusedRepeats).toBe(0);
  });

  it("actionSignature: reads/waits/navigation/scroll → null; modifiers, button, clicks and amount shape the signature", () => {
    expect(actionSignature({ name: "screenshot" })).toBeNull();
    expect(actionSignature({ name: "uia_tree" })).toBeNull();
    expect(actionSignature({ name: "wait", seconds: 2 })).toBeNull();
    expect(actionSignature({ name: "key", key: "up" })).toBeNull();
    expect(actionSignature({ name: "scroll", direction: "down", amount: 10 })).toBeNull();
    expect(actionSignature({ name: "key", key: "space" })).not.toEqual(actionSignature({ name: "key", key: "space", modifiers: ["cmd"] }));
    expect(actionSignature({ name: "key", key: "space", modifiers: ["cmd"] })).toEqual(actionSignature({ name: "key", key: "space", modifiers: ["CMD"] }));
    expect(actionSignature({ name: "click", x: 1, y: 2, button: "left", clicks: 1 })).not.toEqual(actionSignature({ name: "click", x: 1, y: 2, button: "right", clicks: 1 }));
    expect(actionSignature({ name: "click", x: 1, y: 2, button: "left", clicks: 1 })).not.toEqual(actionSignature({ name: "click", x: 1, y: 2, button: "left", clicks: 2 }));
    process.env.COMPUTER_DEGENERATION_GUARD_LEGACY = "1";
    expect(actionSignature({ name: "screenshot" })).toBe('screenshot:[null,null,null,null,null,null]');
    expect(actionSignature({ name: "key", key: "space" })).toEqual(actionSignature({ name: "key", key: "space", modifiers: ["cmd"] })); // the old blindness
  });

  it("the repeated-action nudge costs NO step, is logged as 'repeated-action nudged' (never 'wrapping'), and is counted", async () => {
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 10, y: 10 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 10, y: 10 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 10, y: 10 })], text: "" }) // nudged, free
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "changed approach" })], text: "" });
    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("changed approach");
    expect(r.steps).toBe(3); // click, click, done — the nudge round was free
    expect(dispatchedMethods().filter((m) => m === "computer_click")).toHaveLength(2);
    expect(r.harness?.refusedRepeats).toBe(1);
    const warns = mockWarn.mock.calls.map((c) => String(c[0]));
    expect(warns.some((w) => w.includes("repeated-action nudged"))).toBe(true);
    expect(warns.some((w) => w.includes("wrapping"))).toBe(false);
  });

  it("wait: bounded pause (clamp helper), then a fresh screenshot, NO step charged", async () => {
    expect(clampWaitSeconds(30, 300_000)).toBe(WAIT_MAX_SECONDS);
    expect(clampWaitSeconds(0.1, 300_000)).toBe(0.5);
    expect(clampWaitSeconds(undefined, 300_000)).toBe(2);
    expect(clampWaitSeconds("x", 300_000)).toBe(2);
    expect(clampWaitSeconds(5, 1_000)).toBe(1);
    expect(clampWaitSeconds(5, -1)).toBe(0);
    expect(withWaitTool(COMPUTER_TOOLS).map((t) => t.name)).toEqual([...COMPUTER_TOOLS.map((t) => t.name), "wait"]);
    expect(withWaitTool(withWaitTool(COMPUTER_TOOLS)).filter((t) => t.name === "wait")).toHaveLength(1);

    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("wait", { seconds: 0.5, reasoning: "app launching" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "settled" })], text: "" });
    const input = baseInput();
    const t0 = Date.now();
    const r = await runComputerAgentSession(input);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(450);
    expect(r.finalResponse).toBe("settled");
    expect(r.steps).toBe(1); // the wait was free
    expect(dispatchedMethods()).toEqual(["computer_screenshot", "computer_screenshot"]); // never a "wait" on the wire
    expect(fedOutputs()[0]).toMatchObject({ ok: true, waited: 0.5 });
    expect(progressMessages(input).some((m) => m.startsWith("Waiting 0.5s"))).toBe(true);
    const offered = (mockVisionChat.mock.calls[0][0] as any).tools.map((t: any) => t.name);
    expect(offered).toContain("wait");
    expect(harnessFactsAddendum()).toContain("HARNESS FACTS");
    expect(harnessFactsAddendum()).toContain('A "wait" tool is available');
  });

  it("a screenshot produced by `wait` neither advances nor resets the identical-shot run, so the 'use the wait tool' hint never follows a wait", async () => {
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("wait", { seconds: 0.5 })], text: "" }) // identical, but a wait: no hint
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" }) // run continues: 3rd explicit identical shot
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(baseInput());
    const outs = fedOutputs();
    expect(outs[1].hint).toContain("The last 3 screenshots are byte-identical"); // initial + 2 explicit
    expect(outs[2].waited).toBe(0.5);
    expect(outs[2].hint).toBeUndefined(); // the wait's own frame: no "use the wait tool"
    expect(outs[3].hint).toContain("The last 4 screenshots are byte-identical"); // the run held across the wait
    expect(outs[3].hint).toContain("use the wait tool");
  });

});

// ═══════════════════════════════════════════════════════════════════════════
describe("fix #4 — decoded readability keeps the watchdog ARMED on dark screens", () => {
  it("REPLAY: the dark Terminal frame is readable — no CAUTION on the first turn, and a byte-identical frame after `type` IS a strike", async () => {
    mockDispatch
      .mockResolvedValueOnce(TERMINAL)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(TERMINAL);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "TextEdit" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "typed" })], text: "" });
    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("typed");
    expect(userTexts()[0]).not.toContain("CAUTION");
    expect(fedOutputs()[0].noVisibleChange).toBe(1); // armed on a dark, readable screen
    expect(fedOutputs()[0].degenerateFrame).toBeUndefined();
    expect(r.harness?.degenerateFrames).toBe(0);
    expect(r.harness?.frameGeometry).toBe("1568×1013");
  });

  it("a solid black capture → ONE low-readability caution per streak, no 'call done NOW'; the streak resets on a readable frame", async () => {
    mockDispatch
      .mockResolvedValueOnce(TERMINAL) // readable baseline
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(BLACK) // unreadable ⇒ caution (streak 1)
      .mockResolvedValueOnce(OK).mockResolvedValueOnce({ ...BLACK, screenshotBase64: solidJpeg(1) }) // still unreadable ⇒ NO repeat
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(TERMINAL) // readable ⇒ streak reset
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(BLACK); // unreadable again ⇒ a NEW caution
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "c" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "d" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    const input = baseInput();
    const r = await runComputerAgentSession(input);
    const outs = fedOutputs();
    expect(outs.map((o) => o.degenerateFrame)).toEqual([1, undefined, undefined, 1]);
    expect(outs[0].warning).toContain("LOW-READABILITY FRAME");
    expect(outs[0].warning).not.toContain("call done NOW");
    expect(outs[0].warning).toContain("will not repeat");
    // No dead-input strikes on unreadable legs (both legs must be readable).
    expect(outs.filter((o) => o.noVisibleChange !== undefined)).toEqual([]);
    expect(progressMessages(input).some((m) => m.includes("Input watchdog"))).toBe(false);
    expect(r.harness?.degenerateFrames).toBe(3);
  });

  it("gradeFrame: decoded metric for real JPEGs, bpp fallback for undecodable payloads", () => {
    expect(gradeFrame(TERMINAL)).toMatchObject({ readable: true, basis: "metric" });
    expect(gradeFrame(BLACK)).toMatchObject({ readable: false, basis: "metric" });
    expect(gradeFrame(RICH_A)).toMatchObject({ readable: true, basis: "bpp" });
    expect(gradeFrame({ ...RICH_A, screenshotBase64: "U29saWQh".repeat(3000) })).toMatchObject({ readable: false, basis: "bpp" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("fix #5 — vision-seat hygiene", () => {
  it("looksLikeVisionSeatLeak: DSML / <tool_result> / written-out calls are leaks; plain narration is not", () => {
    expect(looksLikeVisionSeatLeak("<tool_result>screenshot called</｜｜DSML｜｜ parameter>")).toBe(true);
    expect(looksLikeVisionSeatLeak("<｜DSML｜>click")).toBe(true);
    expect(looksLikeVisionSeatLeak("<tool_call>{\"name\":\"screenshot\"}</tool_call>")).toBe(true);
    expect(looksLikeVisionSeatLeak("computer_task({\"task\": \"open TextEdit\"})")).toBe(true);
    expect(looksLikeVisionSeatLeak("I opened TextEdit via Spotlight and typed the note. Nothing is left for you to do.")).toBe(false);
    expect(looksLikeVisionSeatLeak("")).toBe(false);
  });

  it("REPLAY 871bf82b: leaked DSML as tool-less text → corrective re-call (free step) → the real answer; a second leak yields a harness message, never the markup", async () => {
    const LEAK = "<tool_result>screenshot called</｜｜DSML｜｜ parameter>";
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [], text: LEAK })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "The screen shows Terminal; nothing typed." })], text: "" });
    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("The screen shows Terminal; nothing typed.");
    expect(r.steps).toBe(1); // the corrective round was free
    expect(mockVisionChat).toHaveBeenCalledTimes(2);
    expect(userTexts().some((t) => t === VISION_LEAK_NUDGE)).toBe(true);

    jest.clearAllMocks();
    mockListAgents.mockResolvedValue([agentRow()]);
    mockIsOnline.mockReturnValue(true);
    mockAcquireLock.mockResolvedValue("lock-token-1");
    mockVisionConfigured.mockReturnValue(true);
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [], text: LEAK })
      .mockResolvedValueOnce({ functionCalls: [], text: LEAK });
    const r2 = await runComputerAgentSession(baseInput());
    expect(r2.finalResponse).not.toContain("DSML");
    expect(r2.finalResponse).not.toContain("<tool_result>");
    expect(r2.finalResponse).toContain("tool-call markup as text twice");
    expect(r2.finalResponse).toContain("Harness facts");
    expect(mockVisionChat).toHaveBeenCalledTimes(2); // no wrap-up call either
  });

  it("the earlier-frame placeholder says the CURRENT frame is attached below (never 'omitted')", async () => {
    mockDispatch.mockResolvedValue(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("screenshot", {})], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    await runComputerAgentSession(baseInput());
    const texts = userTexts();
    expect(EARLIER_FRAME_PLACEHOLDER).toBe("[earlier frame dropped to save context — the CURRENT frame is attached below]");
    expect(texts.filter((t) => t === EARLIER_FRAME_PLACEHOLDER).length).toBeGreaterThanOrEqual(2);
    expect(texts.some((t) => t.includes("[earlier screenshot omitted]"))).toBe(false);
    // Exactly one live image remains in the input (context discipline unchanged).
    const images = (mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[])
      .filter((i: any) => i?.role === "user")
      .flatMap((i: any) => i.content)
      .filter((c: any) => c.type === "input_image");
    expect(images).toHaveLength(1);
  });

  it("the harness states the diff after every action: bytes identical / N% of pixels changed / frontmost / display M of K", async () => {
    const TERM_D2 = { ...TERMINAL, displayIndex: 1, displayCount: 2 };
    mockDispatch
      .mockResolvedValueOnce(TERM_D2) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce({ ...TERM_D2, screenshotBase64: TERMINAL_B64 }) // identical
      .mockResolvedValueOnce(OK).mockResolvedValueOnce({ ...BLACK, displayIndex: 1, displayCount: 2, frontmostApp: "Finder" }); // changed
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "ok" })], text: "" });
    const r = await runComputerAgentSession(baseInput());
    const outs = fedOutputs();
    expect(outs[0].harness).toBe("bytes identical / frontmost unchanged (Terminal) / display 1 of 2");
    expect(outs[1].harness).toMatch(/^\d+(\.\d+)?% of pixels changed \/ frontmost changed Terminal→Finder \/ display 1 of 2$/);
    expect(userTexts().some((t) => t.includes('Harness measured after "type": bytes identical'))).toBe(true);
    expect(r.harness?.displayCount).toBe(2);
    // Pure helper shapes.
    expect(describeFrameDiff({ prevB64: null, nextB64: "x", prevMetrics: null, nextMetrics: null })).toBe("first frame");
    expect(describeFrameDiff({ prevB64: "a", nextB64: undefined, prevMetrics: null, nextMetrics: null })).toBe("no frame captured");
    expect(describeFrameDiff({ prevB64: "a", nextB64: "b", prevMetrics: null, nextMetrics: null, displayCount: 1 })).toBe("frame changed (bytes differ; pixel diff unavailable) / 1 display");
    // Review follow-up: a sub-thumbnail change (bytes differ, 0% on the grid) is never reported as "0% of pixels changed".
    const m = gradeFrame(TERMINAL).metrics;
    expect(describeFrameDiff({ prevB64: "a", nextB64: "b", prevMetrics: m, nextMetrics: m })).toBe("bytes differ, <0.1% of pixels changed (below the harness thumbnail — e.g. a caret or cursor)");
    expect(describeFrameDiff({ prevB64: "a", nextB64: "b", prevMetrics: m, nextMetrics: m })).not.toMatch(/\b0% of pixels/);
  });

  it("doctrine: the playbook tells the lead that computer_task capture/input/permission claims are unverified narration and to cite the harness counters first", () => {
    const block = platformPlaybookBlock({ chatId: "c1", chatTitle: null, projectId: null, isSupervisor: false, hasUser: true });
    expect(block).toContain("[SUB-AGENT NARRATION — unverified]");
    expect(block).toContain("harness counters");
    expect(block).toContain("before telling the user to touch any permission");
  });
});
