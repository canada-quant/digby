/**
 * Ticket 24afad95 — computer_task TASK-TEXT TRUNCATION (backend replay suite).
 *
 * The live incident (2026-09-25 ~19:20-19:45Z, paired Mac 'Primary', a
 * canlegal-bench computer-use handoff): a ~4KB computer_task task text was
 * dispatched and the sub-agent REFUSED it claiming its payload arrived
 * truncated — "no commands delivered" — while SHORT computer_task prompts in
 * the same hour executed correctly (19:06Z verified input test). Size-
 * dependent, deterministic.
 *
 * ROOT CAUSE: computer-loop.ts built the sub-agent's first prompt with
 * `Task: ${String(message || "").slice(0, 2000)}` — a SILENT 2,000-char cap
 * from the original computer-use commit (f7786aa0, 2026-08-30). A ~4,000-
 * char handoff kept chars 0–1,999 and silently dropped the rest (~50%) —
 * and because structured handoffs put context/goal first and the command
 * list LAST, the dropped tail was exactly the command section → the vision
 * model saw a task with no commands and refused. The wrap-up re-quote had a
 * second, harder clip (`slice(0, 500)`).
 *
 * THE FIX (this suite replays it): the task text rides to the sub-agent
 *   INTACT up to a 16,000-char guard cap, and when that guard DOES clip it
 *   is NEVER silent — an explicit `[TASK TRUNCATED at …]` marker with the
 *   full length tells the model (and the owner, via its final answer) that
 *   content was cut. The wrap-up re-quote uses the same capped+marked text.
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

const RICH = {
  ok: true,
  screenshotBase64: "RnJhbWUx".repeat(46000),
  imageWidth: 1568,
  imageHeight: 980,
  screenWidth: 1512,
  screenHeight: 982,
};

const baseInput = () => ({
  userId: "user-1",
  chatId: null,
  message: "",
  sendEvent: jest.fn(),
});

const fnCall = (
  name: string,
  args: Record<string, unknown>,
  callId = `call_${Math.random().toString(36).slice(2, 8)}`,
) => ({ callId, name, arguments: JSON.stringify(args) });

/** The first user message the sub-agent received (Task: … Begin.) — the
 *  userImageMessage shape: content is a parts array with an input_text part. */
const firstTaskText = (): string => {
  const input = mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[];
  const parts = input?.flatMap((i: any) => (Array.isArray(i?.content) ? i.content : [])) ?? [];
  const part = parts.find((p: any) => p?.type === "input_text" && String(p.text ?? "").startsWith("Task:"));
  return part?.text ?? "";
};

/** The wrap-up re-quote text ("Answer the ORIGINAL task now: …"). */
const wrapUpText = (): string => {
  const input = mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[];
  const parts = input?.flatMap((i: any) => (Array.isArray(i?.content) ? i.content : [])) ?? [];
  const part = parts.find((p: any) => p?.type === "input_text" && String(p.text ?? "").includes("Answer the ORIGINAL task now"));
  return part?.text ?? "";
};

beforeEach(() => {
  jest.clearAllMocks();
  mockVisionConfigured.mockReturnValue(true);
  mockIsOnline.mockReturnValue(true);
  mockListAgents.mockResolvedValue([agentRow()]);
  mockAcquireLock.mockResolvedValue("lock-token-1");
  // Screenshot every dispatch; the loop's first visionChat call carries the Task prompt.
  mockDispatch.mockImplementation(async (_agentId: string, method: string) => {
    if (method === "computer_screenshot") return { ...RICH };
    return { ok: true };
  });
  // First vision turn: done immediately (no steps) so the session closes cleanly.
  mockVisionChat.mockResolvedValueOnce({
    output: [{ type: "message", content: [{ type: "output_text", text: "done early" }] }],
  });
});

describe("24afad95 — a ~4KB computer_task task arrives INTACT (replay of the 2026-09-25 'no commands delivered' refusal)", () => {
  const PREFIX = "Audit the Edge auto-update behavior. Context: the owner's self-hosted instance may be behind. ".repeat(2);
  const COMMANDS = [
    "COMMAND 1: open System Settings and read the General → Software Update pane state.",
    "COMMAND 2: in Terminal, run `defaults read ai.digby.edge` and capture the output verbatim.",
    "COMMAND 3: read the launchd plist at ~/Library/LaunchAgents/ and report its ProgramArguments.",
    "COMMAND 4: compare the installed app version against the latest release feed and state whether an auto-updater exists.",
    "COMMAND 5: summarize whether auto-update is configured, and what would trigger it.",
  ].join("\n");
  // ~4,600 chars total — the incident's size class. The command section starts
  // well past char 2,000, so the OLD slice(0, 2000) cut every command.
  const LONG_TASK = `${PREFIX}${"Background: this is a handoff from the harvest lane; every fact must be verified on the live machine before it is reported. ".repeat(40)}\n\n${COMMANDS}`;

  it("the sub-agent's first prompt carries the FULL task — every COMMAND line, past char 2000, byte-intact", async () => {
    expect(LONG_TASK.length).toBeGreaterThan(4_000);
    for (const line of COMMANDS.split("\n")) expect(LONG_TASK.indexOf(line)).toBeGreaterThan(2_000); // the regression shape: all commands live past the old cap

    await runComputerAgentSession({ ...baseInput(), message: LONG_TASK });

    const prompt = firstTaskText();
    expect(prompt.startsWith("Task: ")).toBe(true);
    for (const line of COMMANDS.split("\n")) {
      expect(prompt).toContain(line); // THE REPLAY: the old code lost every one of these
    }
    expect(prompt).not.toContain("[TASK TRUNCATED"); // under the cap → no marker
  });

  it("short tasks (< 2,000 chars) stay byte-identical (the same-hour control that always worked)", async () => {
    const short = "Open TextEdit and type the word ready.";
    await runComputerAgentSession({ ...baseInput(), message: short });
    expect(firstTaskText()).toContain(short);
  });

  it("a task beyond the 16K guard cap is clipped but NEVER silently — the marker names the cap and the true length", async () => {
    const huge = "X".repeat(20_000) + "\nFINAL COMMAND: report truncation.";
    await runComputerAgentSession({ ...baseInput(), message: huge });
    const prompt = firstTaskText();
    expect(prompt).toContain(`[TASK TRUNCATED at 16000 chars — the full task is ${huge.length} chars`);
    expect(prompt).toContain("report the truncation in your final answer");
    expect(prompt).not.toContain("FINAL COMMAND"); // the tail IS dropped at the guard cap — but the model is TOLD
  });

  it("source pins: the old silent cap code shapes are gone from computer-loop.ts", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const src = fs.readFileSync(
      path.join(__dirname, "computer-loop.ts"),
      "utf8",
    );
    // The OLD harmful shapes (from the original f7786aa0 design): the task text
    // and the wrap-up re-quote silently sliced.
    expect(src).not.toMatch(/String\(message \|\| ""\)\.slice\(0,\s*2000\)/); // the old silent task cap
    expect(src).not.toMatch(/String\(message \|\| ""\)\.slice\(0,\s*500\)/); // the old wrap-up re-quote cap
    expect(src).toMatch(/TASK_TEXT_CHAR_CAP = 16_000/);
    expect(src).toMatch(/\[TASK TRUNCATED at \$\{TASK_TEXT_CHAR_CAP\} chars/); // the never-silent marker
    // The wrap-up re-quote rides the same capped+marked text (no second clip).
    expect(src).toMatch(/Answer the ORIGINAL task now: "\$\{taskLine\}"/);
  });
});
