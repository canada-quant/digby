/**
 * Ticket 09c984d8 — write-path watchdog probe accounting + focus restore.
 *
 * FOLLOW-UP from ticket a40f64d9 (PR #2382). Two non-blocking findings the
 * adversarial reviewer raised there:
 *
 * MEDIUM-1 — AN INCONCLUSIVE LEG MUST NOT SPEND THE CONCLUSIVE BUDGET.
 *   The a40f64d9 fix made an inconclusive leg STOP the probe (correct: a leg
 *   that may have landed unreadably must not be followed by more input). But
 *   that probe still consumed one of MAX_PROBE_ATTEMPTS, so with a budget of 2
 *   two unreadable probes exhausted it without a single compared frame pair —
 *   and on the next fresh streak the attempt that WOULD have produced the
 *   conclusive inert frame pair was never dispatched. The session then ended on
 *   the hedged "it was inconclusive … could not settle whether input lands"
 *   copy instead of the STRICTER dead-input verdict the evidence supported.
 *   The inverse of the failure a40f64d9 fixed: a REAL dead write path
 *   exonerated. Now only a probe that produced a compared frame pair spends
 *   MAX_PROBE_ATTEMPTS; inconclusive probes extend it, bounded by the hard
 *   per-session dispatch ceiling.
 *
 * MEDIUM-2 — THE FOCUS RESTORE ASKED THE VERDICT, NOT THE DEVICE.
 *   The restore was gated `passed?.label === Cmd+Tab && frontmost !== preApp`.
 *   Cmd+Tab COMMITS an app switch, so the switch happens whether or not the
 *   probe could read its result: the switcher's two targets can be
 *   pixel-identical (verdict "inert") or the frame read can fail, and in both
 *   cases the app DID change while the restore branch never ran — leaving the
 *   user parked on someone else's window. The decision now reads the LIVE
 *   frontmost app taken after the leg; only a chord that provably never reached
 *   the device, or was refused, skips the restore.
 *
 * The ticket's own suggested shapes are replayed below: an inconclusive leg
 * followed (on a later attempt) by a genuinely-inert one must NOT conclude; a
 * Cmd+Tab leg that reads inert while the live frontmost differs must dispatch
 * the switch-back.
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

import { runComputerAgentSession, probeLeftFocusMoved, PROBE_LEGS } from "./computer-loop";
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

// Content-rich frame ≈0.18 bpp (the 6f4f8b36 calibration) — a verifiable
// capture, so byte-identity is real dead-input evidence, never a capture blip.
const RICH_A = {
  ok: true,
  screenshotBase64: "RnJhbWUx".repeat(46000),
  imageWidth: 1568,
  imageHeight: 980,
  screenWidth: 1512,
  screenHeight: 982,
};
const RICH_B = { ...RICH_A, screenshotBase64: "RnJhbWUy".repeat(46000) }; // byte-distinct rich
const F = { ...RICH_A, frontmostApp: "Finder" };
const T = { ...RICH_A, frontmostApp: "Terminal" };
const OK = { ok: true };
/** A dispatch REFUSED by the agent: reached the device, no frame, no effect. */
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

/** The keys the harness (and the model) actually dispatched, in order. */
const dispatchedKeys = (): string[] =>
  mockDispatch.mock.calls
    .filter((c) => c[1] === "computer_key")
    .map((c) => c[2].key + (c[2].modifiers?.length ? "+" + c[2].modifiers.join("+") : ""));

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

describe("09c984d8 MEDIUM-1 — an inconclusive probe does not spend the conclusive budget", () => {
  it("REPLAY: two INCONCLUSIVE probes (dispatch refused) then a third, CONCLUSIVE inert probe ⇒ the probe still settles DEAD INPUT (the strict verdict), never the hedged 'could not settle' copy", async () => {
    mockDispatch
      // ── fresh streak #1 → probe #1 (INCONCLUSIVE: leg refused) ──
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type a ⇒ strike 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type b ⇒ strike 2 ⇒ probe #1
      .mockResolvedValueOnce(REFUSED) // probe #1 leg 1 (Cmd+Space) REFUSED ⇒ inconclusive, probe stops
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // probe #1 escape cleanup
      // ── a visible change starts a fresh streak → probe #2 (INCONCLUSIVE) ──
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // type c ⇒ CHANGED ⇒ streak reset
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // type d ⇒ strike 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // type e ⇒ strike 2 ⇒ probe #2
      .mockResolvedValueOnce(REFUSED) // probe #2 leg 1 REFUSED again ⇒ inconclusive
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // probe #2 escape cleanup
      // ── a third streak → the CONCLUSIVE attempt the old budget never ran ──
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type f ⇒ CHANGED ⇒ streak reset
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type g ⇒ strike 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type h ⇒ strike 2 ⇒ probe #3
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // probe #3 leg 1 (Cmd+Space) ⇒ identical frame, same frontmost
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // probe #3 leg 2 (Cmd+Tab) ⇒ identical too ⇒ EVERY leg inert
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A); // probe #3 escape cleanup
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "c" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "d" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "e" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "f" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "g" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "h" })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);

    // THREE probes ran. Only the third produced a compared frame pair, so only
    // ONE conclusive observation was ever counted — the two unreadable ones
    // extended the budget instead of spending it.
    expect(r.harness).toMatchObject({ probesRun: 3, probesPassed: 0, probesConclusive: 1, inputProven: false });
    expect(progressMessages(input).filter((m) => m.includes("running a harness positive-control probe"))).toHaveLength(3);
    expect(dispatchedKeys()).toEqual(["space+cmd", "escape", "space+cmd", "escape", "space+cmd", "tab+cmd", "escape"]);

    // THE POINT: the probe SETTLES on the conclusive attempt — the strict
    // dead-input verdict, with the multi-leg copy — rather than the hedged
    // "it was inconclusive … could not settle whether input lands" copy the old
    // attempt accounting forced (it would have stopped at probe #2).
    expect(r.finalResponse).toContain("EVERY leg produced a byte-identical frame with an unchanged frontmost app");
    expect(r.finalResponse).not.toContain("but it was inconclusive");
    expect(progressMessages(input).some((m) => m.includes("and a failed harness positive-control probe"))).toBe(true);
    // …and the session ENDED there (the watchdog's verdict, not a wrap-up).
    expect(r.steps).toBe(8);
    expect(mockVisionChat).toHaveBeenCalledTimes(8);
  });

  it("a CONCLUSIVE passing observation DOES spend the attempt (probesConclusive increments), so the budget is not free", async () => {
    // Scope note (adversarial review 2026-11-03): this pins that a conclusive
    // observation advances probesConclusive — it does NOT drive the
    // MAX_PROBE_DISPATCHES ceiling to exhaustion (that ceiling is structurally
    // bounded by the legacy NO_CHANGE_LIMIT abort, which fires at strike 3).
    // Probe #1 is conclusive but PASSING (input proven ⇒ no abort); no further
    // probing follows because inputProven latches.
    mockDispatch
      .mockResolvedValueOnce(RICH_A) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type a ⇒ 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A) // type b ⇒ 2 ⇒ probe
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_B) // probe leg 1 (Cmd+Space) ⇒ CHANGED ⇒ PASS
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(RICH_A); // probe escape cleanup
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Typed elsewhere." })], text: "" });

    const r = await runComputerAgentSession(baseInput());
    expect(r.finalResponse).toBe("Typed elsewhere.");
    expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 1, probesConclusive: 1, inputProven: true });
  });
});

describe("09c984d8 MEDIUM-2 — the focus restore reads the LIVE frontmost app, not the inert verdict", () => {
  it("REPLAY: the Cmd+Tab leg reads INERT (byte-identical frame, frontmost field still preApp) but the live frontmost read differs ⇒ a switch-back Cmd+Tab IS dispatched", async () => {
    mockDispatch
      .mockResolvedValueOnce(F) // initial — Finder frontmost
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type a ⇒ strike 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type b ⇒ strike 2 ⇒ probe
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // probe leg 1 (Cmd+Space) ⇒ inert
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // probe leg 2 (Cmd+Tab) ⇒ INERT: identical frame AND its own frontmost field still says Finder
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(T) // probe escape cleanup ⇒ the LIVE frontmost read says TERMINAL: the switch DID commit
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F); // ⇒ focus restore (Cmd+Tab back to Finder)
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" });

    const input = baseInput();
    const r = await runComputerAgentSession(input);

    // No leg PASSED (both looked inert), yet the switch-back was dispatched
    // because the DEVICE said the focus moved. Under the a40f64d9 gate
    // (`passed?.label === Cmd+Tab && …`) it never ran and the user stayed on
    // Terminal.
    expect(dispatchedKeys()).toEqual(["space+cmd", "tab+cmd", "escape", "tab+cmd"]);
    // Both legs were conclusive and inert ⇒ the probe failed ⇒ the watchdog's
    // strict multi-leg verdict (unchanged passing-path behaviour).
    expect(r.finalResponse).toContain("EVERY leg produced a byte-identical frame");
    expect(r.harness).toMatchObject({ probesRun: 1, probesPassed: 0, probesConclusive: 1, inputProven: false });
  });

  it("a REFUSED Cmd+Tab is not 'landed' — nothing moved, so NO switch-back is dispatched (the restore must never move the focus itself)", async () => {
    mockDispatch
      .mockResolvedValueOnce(F) // initial
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type a ⇒ 1
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // type b ⇒ 2 ⇒ probe
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(F) // probe leg 1 (Cmd+Space) ⇒ inert
      .mockResolvedValueOnce({ ok: false, error: "computer_key refused: hotkey unavailable" }) // probe leg 2 (Cmd+Tab) REFUSED ⇒ moved nothing
      .mockResolvedValueOnce(OK).mockResolvedValueOnce(T); // probe escape cleanup — a stale/other frontmost read
    mockVisionChat
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "a" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("type", { text: "b" })], text: "" })
      .mockResolvedValueOnce({ functionCalls: [fnCall("done", { message: "Stopped." })], text: "" });

    await runComputerAgentSession(baseInput());
    // Leg 2 was refused ⇒ it never landed ⇒ no restore, even though the live
    // frontmost read afterwards differs.
    expect(dispatchedKeys()).toEqual(["space+cmd", "tab+cmd", "escape"]);
  });

  it("probeLeftFocusMoved truth table (the rule, pinned without driving the loop)", () => {
    // Never reached the device (transport failure) / refused ⇒ nothing moved.
    expect(probeLeftFocusMoved({ dispatched: false, landed: false, preApp: "Finder", observed: "Terminal" })).toBe(false);
    expect(probeLeftFocusMoved({ dispatched: true, landed: false, preApp: "Finder", observed: "Terminal" })).toBe(false);
    // No baseline to compare against ⇒ no basis to move the focus.
    expect(probeLeftFocusMoved({ dispatched: true, landed: true, preApp: undefined, observed: "Terminal" })).toBe(false);
    // Landed and the live read says the app changed ⇒ hand it back.
    expect(probeLeftFocusMoved({ dispatched: true, landed: true, preApp: "Finder", observed: "Terminal" })).toBe(true);
    // Landed and the live read says nothing moved ⇒ leave it alone.
    expect(probeLeftFocusMoved({ dispatched: true, landed: true, preApp: "Finder", observed: "Finder" })).toBe(false);
    // Landed with an UNREADABLE frontmost: Cmd+Tab almost certainly committed a
    // switch, and leaving the user elsewhere is the side effect this prevents.
    expect(probeLeftFocusMoved({ dispatched: true, landed: true, preApp: "Finder", observed: null })).toBe(true);
  });

  it("the multi-leg control is still the a40f64d9 control (Cmd+Space then Cmd+Tab) — the accounting fix never changes the passing path", () => {
    expect(PROBE_LEGS.map((l) => `${l.key}+${l.modifiers.join("+")}`)).toEqual(["space+cmd", "tab+cmd"]);
  });
});