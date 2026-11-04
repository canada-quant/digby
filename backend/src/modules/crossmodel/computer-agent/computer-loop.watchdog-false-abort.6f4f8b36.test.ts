/**
 * Ticket 6f4f8b36 — write-path watchdog FALSE ABORTS (backend replay suite).
 *
 * The live incident (2026-09-25, Mac app v0.4.2, owner watching the screen):
 * three consecutive computer_task runs aborted with "3 consecutive input
 * actions produced NO visible change — the input is not landing" while the
 * owner watched ⌘+Space open Spotlight, "text edit" get typed, and TextEdit
 * launch. Two independent false-abort classes, both replayed here:
 *
 * RC1 — BROKEN CAPTURE SCORED AS DEAD INPUT: after a Screen Recording /
 *   Accessibility grant, macOS serves the new permission only to a freshly
 *   launched process (ticket 33401f39) — the helper predating the grant
 *   captures SOLID frames while reporting "connected". The old watchdog
 *   compared blank-vs-blank, found byte-identical, and graded every healthy
 *   input action as a strike. Fix: a byte-identity comparison is dead-INPUT
 *   evidence only when BOTH legs are content-rich captures (bpp ≥
 *   DEGENERATE_BPP_THRESHOLD); an unverifiable leg scores NO strike and
 *   RESETS the streak (the capture window is transient — relaunch fixes it —
 *   and the 33401f39 advisory on the same observation carries that remedy).
 *
 * RC2 — NO-OP KEYS SCORED AS STRIKES: with capture confirmed healthy (8/8
 *   full live frames), Escape presses with no menu/dropdown open left the
 *   screen pixel-identical — the CORRECT outcome — and three of them aborted
 *   the run with the same false verdict. Fix: bare (modifier-less)
 *   dismissal/navigation keys (escape/tab/arrows/home/end/pageup/pagedown)
 *   never strike on pixel-identity (the streak HOLDS — genuinely dead clicks
 *   around them still accumulate, so a real dead write path is still caught).
 *
 * Also pinned: the abort copy now says the input effect "could not be
 * verified" instead of asserting "the input is not landing" (fix d) — the old
 * text sent the owner chasing Accessibility permissions that were fine.
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

import { runComputerAgentSession, noOpProneKey } from "./computer-loop";
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

// Content-rich frame ≈0.18 bpp (the computer-agent.test.ts calibration:
// real captures carry the menu bar and render ≈0.07+; the degenerate floor
// is 0.03).
const RICH_A = {
  ok: true,
  screenshotBase64: "RnJhbWUx".repeat(46000), // 368,000 b64 chars → 276,000 bytes / 1,536,640 px ≈ 0.180
  imageWidth: 1568,
  imageHeight: 980,
  screenWidth: 1512,
  screenHeight: 982,
};
const RICH_B = { ...RICH_A, screenshotBase64: "RnJhbWUy".repeat(46000) }; // byte-distinct rich

// SOLID-capture class (ticket 33401f39): structurally valid, byte-identical
// when reused, ≈0.012 bpp — below the 0.03 degenerate floor.
const SOLID_A = { ...RICH_A, screenshotBase64: "U29saWQh".repeat(3000) }; // 24,000 chars → 18,000 bytes ≈ 0.0117
const SOLID_B = { ...RICH_A, screenshotBase64: "U29saWQy".repeat(3000) }; // byte-DISTINCT solid

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

const fedOutputs = (): any[] =>
  (mockVisionChat.mock.calls.at(-1)?.[0]?.input as any[])
    .filter((i: any) => i?.type === "function_call_output")
    .map((i: any) => JSON.parse(i.output));

const progressMessages = (input: ReturnType<typeof baseInput>): string[] =>
  input.sendEvent.mock.calls
    .filter((c: any[]) => c[0] === "progress")
    .map((c: any[]) => c[1]?.message || "");

beforeEach(() => {
  jest.clearAllMocks();
  mockVisionConfigured.mockReturnValue(true);
  mockIsOnline.mockReturnValue(true);
  mockListAgents.mockResolvedValue([agentRow()]);
  mockAcquireLock.mockResolvedValue("lock-token-1");
});

describe("6f4f8b36 RC1 — a broken capture path is never scored as dead input", () => {
  it("REPLAY (the 2026-09-25 incident): solid first frame + byte-identical solid post-action frames → NO strikes, NO input-watchdog abort; the capture advisory carries the quit-and-relaunch remedy", async () => {
    const input = baseInput();
    mockDispatch
      .mockResolvedValueOnce(SOLID_A) // initial — solid capture (the broken-camera window)
      .mockResolvedValueOnce({ ok: true }) // click dispatched
      .mockResolvedValueOnce(SOLID_A) // auto-shot — byte-IDENTICAL solid (blank-vs-blank)
      .mockResolvedValueOnce({ ok: true }) // type dispatched
      .mockResolvedValueOnce(SOLID_A) // byte-identical solid again
      .mockResolvedValueOnce({ ok: true }) // key dispatched
      .mockResolvedValueOnce(SOLID_A); // byte-identical solid again
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("click", { x: 40, y: 8 })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "text edit" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" })
      .mockResolvedValueOnce({
        functionCalls: [
          fnCall("done", { message: "Blocked by capture: every frame is a flat solid — quit and relaunch the Digby Mac app." }),
        ],
        text: "",
      });

    const r = await runComputerAgentSession(input);

    // The input watchdog NEVER fired — the session ran its full course and
    // the MODEL (holding the capture advisory) produced the verdict.
    expect(r.steps).toBe(4); // NOT aborted at step 3
    expect(r.finalResponse).toContain("Blocked by capture");
    expect(progressMessages(input).some((m) => m.includes("Input watchdog"))).toBe(false);
    // Zero no-change strikes were scored on the blank-vs-blank comparisons.
    const flagged = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(flagged).toEqual([]);
    // cu-diag fix #4: the capture caution fires ONCE per low-readability
    // streak — the initial solid frame opened the streak (its caution rides
    // the task message below), so the action outcomes carry NO repeated
    // caution; the harness still COUNTED every unreadable frame.
    const degenerate = fedOutputs().filter((o) => o.degenerateFrame !== undefined);
    expect(degenerate).toEqual([]);
    expect(r.harness?.degenerateFrames).toBe(4);
    // …and the initial solid frame carried the caution naming the
    // quit-and-relaunch fix to the model on its first turn.
    const firstTurn = (mockVisionChat.mock.calls[0][0].input as any[])
      .filter((i: any) => i?.role === "user")
      .flatMap((i: any) => i.content ?? [i])
      .map((c: any) => (typeof c === "string" ? c : c.text || ""))
      .join(" ");
    expect(firstTurn).toContain("CAUTION");
    expect(firstTurn).toMatch(/QUIT \+ RELAUNCH/);
  });

  it("a capture break mid-run scores no strike and RESETS the streak — recovery starts a fresh count, never inherits pre-break strikes", async () => {
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial — healthy baseline
      .mockResolvedValueOnce({ ok: true }) // type (cu-diag fix #2: clicks are advisory — type strikes)
      .mockResolvedValueOnce(RICH_A) // byte-identical RICH ⇒ genuine strike 1
      .mockResolvedValueOnce({ ok: true }) // type
      .mockResolvedValueOnce(SOLID_A) // capture breaks: solid post-frame (≠ RICH_A bytes)
      .mockResolvedValueOnce({ ok: true }) // key return
      .mockResolvedValueOnce(RICH_B) // capture recovered: rich frame (≠ SOLID_A bytes)
      .mockResolvedValueOnce({ ok: true }) // type
      .mockResolvedValueOnce(RICH_B); // byte-identical to the recovered rich baseline ⇒ fresh strike 1
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "hi" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Done after a camera blip." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("Done after a camera blip.");
    expect(r.steps).toBe(5); // no abort — the break reset, recovery restarted at 1
    expect(progressMessages(input).some((m) => m.includes("Input watchdog"))).toBe(false);
    const flagged = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    // strike 1 (pre-break type) and a FRESH strike 1 (post-recovery type) —
    // never 2, never 3: the unverifiable leg reset the chain.
    expect(flagged.map((o) => o.noVisibleChange)).toEqual([1, 1]);
  });

  it("a solid post-action frame against a solid baseline never strikes even when byte-identical (blank-vs-blank, both legs unverifiable)", async () => {
    mockDispatch
      .mockResolvedValueOnce(SOLID_A) // initial — solid
      .mockResolvedValueOnce({ ok: true }) // type
      .mockResolvedValueOnce(SOLID_A) // byte-identical solid post — the exact incident comparison
      .mockResolvedValueOnce({ ok: true }) // type
      .mockResolvedValueOnce(SOLID_B); // byte-DISTINCT solid (still degenerate) — must not strike either
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Cannot see the screen." })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("Cannot see the screen.");
    const flagged = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(flagged).toEqual([]); // no strikes on any solid-leg comparison
  });
});

describe("6f4f8b36 RC2 — no-op-prone keys never strike on pixel-identity", () => {
  it("REPLAY: dismissal/navigation keys on a closed UI (pixel-identical rich frames — the CORRECT outcome) → NO strikes, NO abort, session continues", async () => {
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial — healthy capture
      .mockResolvedValueOnce({ ok: true }) // escape
      .mockResolvedValueOnce(RICH_A) // nothing open ⇒ pixel-identical (correct)
      .mockResolvedValueOnce({ ok: true }) // tab
      .mockResolvedValueOnce(RICH_A) // no focus change visible ⇒ identical
      .mockResolvedValueOnce({ ok: true }) // down arrow
      .mockResolvedValueOnce(RICH_A) // no list focused ⇒ identical
      .mockResolvedValueOnce({ ok: true }) // pageup
      .mockResolvedValueOnce(RICH_A); // identical
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "escape" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "tab" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "down" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "pageup" })], text: "" })
      .mockResolvedValueOnce({
        functionCalls: [fnCall("done", { message: "Nothing was open; dismissed nothing. Task fine." })],
        text: "",
      });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.finalResponse).toBe("Nothing was open; dismissed nothing. Task fine.");
    expect(r.steps).toBe(5); // ran to done — never aborted at 3
    expect(progressMessages(input).some((m) => m.includes("Input watchdog"))).toBe(false);
    const flagged = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(flagged).toEqual([]); // zero strikes, zero warnings on expected no-ops
  });

  it("a genuinely dead write path is STILL caught: strikes accumulate around no-op keys, the harness probe at 2 FAILS, and the session aborts with the hedged (could-not-verify) copy", async () => {
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce({ ok: true }) // type (cu-diag fix #2: clicks are advisory — type strikes)
      .mockResolvedValueOnce(RICH_A) // identical rich ⇒ STRIKE 1
      .mockResolvedValueOnce({ ok: true }) // escape (no-op-prone)
      .mockResolvedValueOnce(RICH_A) // identical ⇒ hold at 1
      .mockResolvedValueOnce({ ok: true }) // key return
      .mockResolvedValueOnce(RICH_A) // identical rich ⇒ STRIKE 2 ⇒ the HARNESS probes
      .mockResolvedValueOnce({ ok: true }) // probe: cmd+space
      .mockResolvedValueOnce(RICH_A) // probe frame identical, frontmost unchanged ⇒ probe FAILED ⇒ abort
      .mockResolvedValueOnce({ ok: true }) // probe cleanup: escape
      .mockResolvedValueOnce(RICH_A);
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "escape" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("key", { key: "return" })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);
    expect(r.steps).toBe(3); // aborted on the 2nd STRIKE-ELIGIBLE dead action + failed probe
    expect(progressMessages(input).some((m) => m.includes("Input watchdog"))).toBe(true);
    // Fix (d): the verdict is phrased as UNVERIFIABLE, never asserted dead —
    // the old text ("the input is not landing" as fact) sent the owner
    // chasing permissions that were fine.
    expect(r.finalResponse).toContain("could not be verified");
    expect(r.finalResponse).toContain("pixel-identical");
    expect(r.finalResponse).toContain("on verifiable screenshots");
    expect(r.finalResponse).not.toContain("could not affect your Mac's screen");
    // The per-action warning carries the same hedged epistemics.
    const flagged = fedOutputs().filter((o) => o.noVisibleChange !== undefined);
    expect(flagged.map((o) => o.noVisibleChange)).toEqual([1, 2]);
    expect(flagged[0].warning).toContain("may not be reaching the screen");
    expect(flagged[0].warning).toContain("may simply have had no visible effect");
    expect(flagged[0].warning).not.toContain("almost certainly NOT");
  });
});

describe("6f4f8b36 — noOpProneKey truth table (the RC2 carve-out is narrow on purpose)", () => {
  it("bare dismissal/navigation keys are no-op-prone", () => {
    for (const key of ["escape", "tab", "left", "right", "up", "down", "home", "end", "pageup", "pagedown"]) {
      expect(noOpProneKey({ name: "key", key, modifiers: undefined })).toBe(true);
      expect(noOpProneKey({ name: "key", key, modifiers: [] })).toBe(true); // empty modifiers = bare
    }
  });

  it("review finding 1: casing/whitespace from the model never decides the carve-out (both agents lowercase key names)", () => {
    expect(noOpProneKey({ name: "key", key: "Escape", modifiers: undefined })).toBe(true);
    expect(noOpProneKey({ name: "key", key: "TAB", modifiers: undefined })).toBe(true);
    expect(noOpProneKey({ name: "key", key: " Down ", modifiers: undefined })).toBe(true);
  });

  it("modifier-bearing keys stay strike-eligible (they DO carry visible effects: cmd+space, cmd+tab, cmd+c…)", () => {
    expect(noOpProneKey({ name: "key", key: "space", modifiers: ["cmd"] })).toBe(false);
    expect(noOpProneKey({ name: "key", key: "tab", modifiers: ["cmd"] })).toBe(false);
    expect(noOpProneKey({ name: "key", key: "c", modifiers: ["cmd", "shift"] })).toBe(false);
  });

  it("visible-effect keys (return/space/delete/f-keys) and every non-key action stay strike-eligible", () => {
    for (const key of ["return", "space", "delete", "f3", "f11"]) {
      expect(noOpProneKey({ name: "key", key, modifiers: undefined })).toBe(false);
    }
    expect(noOpProneKey({ name: "click", modifiers: undefined })).toBe(false);
    expect(noOpProneKey({ name: "type", modifiers: undefined })).toBe(false);
    expect(noOpProneKey({ name: "scroll", modifiers: undefined })).toBe(false);
    expect(noOpProneKey({ name: "screenshot", modifiers: undefined })).toBe(false);
  });
});
