/**
 * Characterization pin — log-signal ticket c97f78b3 (2026-10-22, lane
 * e5738c79): the "ToolExecutor: computer_task unavailable — COMPUTER USE
 * UNAVAILABLE — 'cqlstannembp<n>' cannot run computer use — offline" warn
 * fingerprint the hourly log-signal-sweep filed is DESIGNED per-call
 * capability observability, not a defect. This suite pins the exact warn
 * shape, the warn LEVEL (the sweep reads warn+error — the level IS the
 * observability contract), and the containment bounds (ONE warn per call,
 * steps=0, nothing dispatched, no use-lock taken) so a future refactor cannot
 * silently change what the sweep fingerprints or let an "unavailable" call
 * touch the device.
 *
 * WHERE THE ROWS COME FROM (adjudicated 2026-10-22, live evidence this run):
 * the OAuth-demo lane's recurring availability probe (schedule 24fd9577,
 * chat e9aa6744, machine-armed 2026-10-21, maxRuns 24, owner notified
 * 20:06Z Oct 21) fires a read-only computer_task at BOTH paired Macs every
 * 20 minutes while the demo video waits on the owner. The mbp-2 leg returns
 * the "Missing macOS permission(s): Screen Recording" sibling fingerprint;
 * the mbp-1 leg — that Mac being OFFLINE — returns the notice this ticket
 * fingerprints. One call → ONE warn row at the probe's ~20-minute cadence:
 * 22 rows in the sweep's filing window, 23 rows in the trailing 24 h at
 * adjudication (newest 2026-10-22T00:09:02Z, "last seen 6 h ago"), plus a
 * denser manual-probe cluster 19:04–19:35Z Oct 21. That is probe cadence,
 * never a retry storm: the composition below is a single check-and-return
 * with no retry loop, no dispatch, no lock — and the ToolCache dedupes an
 * IDENTICAL repeat within one run (pinned below), so each row is a fresh
 * probe firing with its own cache, never a re-warn.
 *
 * THE CHAIN (three legs, all pinned below):
 *   1. driver.selectComputerDriver — the explicit-target path names the
 *      device and its availability:
 *      `'cqlstannembp1' cannot run computer use — offline — your paired Mac
 *      is last seen 5 h ago (open the Digby Mac app to reconnect)`.
 *   2. computer-loop.runComputerAgentSession — no driver → one structured
 *      capabilityNotice, steps=0, elapsed ~0, NOTHING dispatched to the
 *      device and NO use-lock taken ("Nothing on the Mac was seen or
 *      touched" is a pinned contract, not copy).
 *   3. tool-executor ToolCache — logs EXACTLY ONE logger.warn
 *      ("ToolExecutor: computer_task unavailable — <notice>") and hands the
 *      calling agent the [COMPUTER_TASK — UNAVAILABLE] banner — the surface
 *      the probe reads as its result.
 *
 * Containment bounds that keep the class bounded: the warn fires once per
 * TOOL CALL (probe fires are bounded by the probe schedule's own maxRuns;
 * there is no in-call retry), and the no-driver return happens BEFORE the
 * vision-seat check, the use-lock, and every dispatch path.
 */

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tool-executor's static import graph — the same mock set its own suite
// (tool-executor.attached-images.test.ts) uses to stay hermetic.
jest.mock("../../../config/database", () => ({ __esModule: true, default: {} }));
// The REAL imessage.service (requireActual'd below for agentDisplayName)
// imports config/redis at load — mock the boundary like multi-mac-routing
// .test.ts does, or the real env parser process.exit(1)s the worker.
jest.mock("../../../config/redis", () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn() },
}));
jest.mock("../mcp-search", () => ({ __esModule: true, callMcpTool: jest.fn(), webToolsDegraded: () => false }));
jest.mock("../upload.controller", () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock("../coding/web-pipe", () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock("../coding/youtube-pipe", () => ({ __esModule: true, runYoutubePipe: jest.fn() }));
// the computer-agent graph's live boundaries (the watchdog suite's set):
jest.mock("../imessage/imessage.service", () => ({
  listAgents: jest.fn(),
  // The REAL naming rule, not a stub (reviewer finding 6): label, else the
  // pair-time hostname — the composed fingerprint names the ROW LABEL, so
  // the pin must follow any production change to this rule.
  agentDisplayName: jest.requireActual("../imessage/imessage.service").agentDisplayName,
  // The REAL 45s online window, inline — offline-ness in these tests is
  // genuine (a lastSeenAt 5 h old), never a stubbed verdict.
  isOnline: (d: Date | null | undefined) => !!d && Date.now() - new Date(d).getTime() < 45_000,
}));
jest.mock("../imessage/agent-link", () => ({ agentBroker: { dispatch: jest.fn() } }));
jest.mock("./use-lock", () => ({
  acquireComputerUseLock: jest.fn(),
  releaseComputerUseLock: jest.fn(),
  recordComputerUseHolder: jest.fn(),
  describeComputerUseHolder: jest.fn(),
  LOCK_TTL_MARGIN_MS: 120_000,
}));
jest.mock("./vision-client", () => ({
  visionChat: jest.fn(),
  visionConfigured: jest.fn(() => true),
}));

import logger from "../../../utils/logger";
import { selectComputerDriver } from "./driver";
import { runComputerAgentSession } from "./computer-loop";
import { ToolCache } from "../tool-executor";
import { listAgents } from "../imessage/imessage.service";
import { agentBroker } from "../imessage/agent-link";
import { acquireComputerUseLock } from "./use-lock";
import { visionChat, visionConfigured } from "./vision-client";

const mockListAgents = listAgents as jest.Mock;
const mockDispatch = agentBroker.dispatch as jest.Mock;
const mockAcquireLock = acquireComputerUseLock as jest.Mock;
const mockVisionChat = visionChat as jest.Mock;
const mockVisionConfigured = visionConfigured as jest.Mock;
const mockWarn = logger.warn as jest.Mock;
const mockError = logger.error as jest.Mock;

const H = 3_600_000;
/** The live fleet shape at adjudication (2026-10-22): cqlstannembp1 offline
 *  ~5–6 h, cqlstannembp2 online — the OAuth-demo probe's two legs. The
 *  device hint 'cql-stanne-mbp-1' is the probe's own arg shape (it reaches
 *  the row label via the fuzzy normalized match). */
const mbp1 = (over: Record<string, unknown> = {}) => ({
  id: "agent-mbp1",
  userId: "u1",
  label: "cqlstannembp1",
  deviceName: "cql-stanne-mbp-1.local",
  agentVersion: "0.9.2",
  isDefault: false,
  lastSeenAt: new Date(Date.now() - 5 * H), // offline — past the 45 s window
  pairedAt: new Date(),
  ...over,
});
const mbp2 = (over: Record<string, unknown> = {}) => ({
  id: "agent-mbp2",
  userId: "u1",
  label: "cqlstannembp2",
  deviceName: "cql-stanne-mbp-2.local",
  agentVersion: "0.9.2",
  isDefault: true,
  // Fixed recent timestamp (reviewer finding 8) — "online" for the full 45 s
  // window regardless of runner pause, never a wall-clock edge.
  lastSeenAt: new Date(Date.now() - 1_000),
  pairedAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.COMPUTER_DEVICE_MATCH_STRICT;
  mockListAgents.mockReset();
  mockListAgents.mockResolvedValue([mbp1(), mbp2()]);
});

describe("log-signal c97f78b3 — leg 1: the driver names the offline device (the fingerprint's core)", () => {
  it("explicit-target probe on an OFFLINE Mac: driver null, status = \"'cqlstannembp1' cannot run computer use — offline — your paired Mac is last seen 5 h ago (open the Digby Mac app to reconnect)\"", async () => {
    const sel = await selectComputerDriver("u1", "cql-stanne-mbp-1");
    expect(sel.driver).toBeNull();
    // The NAMED device is reported — never the online twin, never a guess.
    expect(sel.agentId).toBe("agent-mbp1");
    expect(sel.device).toBe("cqlstannembp1");
    expect(sel.platform).toBe("macos");
    expect(sel.status).toBe(
      "'cqlstannembp1' cannot run computer use — offline — your paired Mac is last seen 5 h ago (open the Digby Mac app to reconnect)",
    );
  });

  it("the offline Mac excludes only itself — the online twin stays drivable (one probe leg per device, each with its own fingerprint)", async () => {
    const sel = await selectComputerDriver("u1", "cql-stanne-mbp-2");
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-mbp2");
    expect(sel.device).toBe("cqlstannembp2");
    // Stronger than field-echo (reviewer finding 4): the driver REALLY holds
    // mbp-2's agent id — a dispatch through it is broker-routed to
    // 'agent-mbp2', proving the constructor got the MATCH's id, not all[0]'s.
    mockDispatch.mockResolvedValueOnce({ ok: true });
    await sel.driver!.execute({ name: "screenshot" } as never);
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent-mbp2",
      "computer_screenshot",
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ capability: "computer" }),
    );
  });
});

describe("log-signal c97f78b3 — leg 2: the session is ONE structured notice; nothing was seen or touched", () => {
  it("offline target: steps=0, capabilityNotice === finalResponse, NO dispatch / lock / vision call, no progress event", async () => {
    const events: string[] = [];
    const result = await runComputerAgentSession({
      userId: "u1",
      chatId: null,
      message: "read-only look at the screen",
      device: "cql-stanne-mbp-1",
      sendEvent: (t: string) => {
        events.push(t);
      },
    });
    expect(result.steps).toBe(0);
    expect(result.capabilityNotice).toBe(
      "COMPUTER USE UNAVAILABLE — 'cqlstannembp1' cannot run computer use — offline — your paired Mac is last seen 5 h ago (open the Digby Mac app to reconnect). Nothing on the Mac was seen or touched. Pair/update the Digby Mac app, then retry.",
    );
    expect(result.finalResponse).toBe(result.capabilityNotice);
    expect(result.device).toBe("cqlstannembp1");
    expect(result.elapsed).toBeLessThan(2_000);
    // "Nothing on the Mac was seen or touched" — pinned, not narrated: the
    // no-driver return happens before the use-lock, every dispatch path and
    // the vision seat, so an unavailable call can never touch the device.
    // visionConfigured NOT called pins the ORDERING (reviewer finding 2): the
    // availability check precedes the vision-seat check, so an offline Mac
    // reports its offline notice even when the seat is also unconfigured —
    // a reorder here would swap which UNAVAILABLE notice the sweep sees.
    expect(mockVisionConfigured).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(mockVisionChat).not.toHaveBeenCalled();
    // The no-driver return precedes even the progress event.
    expect(events).toEqual([]);
  });
});

describe("log-signal c97f78b3 — leg 3: ToolExecutor emits exactly ONE warn per call, at warn level, with the swept prefix", () => {
  it("computer_task on the offline Mac: ONE logger.warn carrying the fingerprint text; the caller gets the UNAVAILABLE banner at steps: 0", async () => {
    const tc = new ToolCache("u1", "chat1", () => {});
    const out = await tc.getOrExecute("computer_task", {
      task: "read-only look at the screen",
      device: "cql-stanne-mbp-1",
    });
    // ONE warn per call — the containment contract behind "22 rows in 24 h =
    // 22 probe calls, not a storm". Level warn (never error): the sweep's
    // observability contract — and logger.error is asserted NEVER (reviewer
    // finding 1): the DB transport persists error+warn, so a stray
    // logger.error on this path would mint a second app_error_logs row the
    // pin must catch, not wave through.
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toBe(
      "ToolExecutor: computer_task unavailable — COMPUTER USE UNAVAILABLE — 'cqlstannembp1' cannot run computer use — offline — your paired Mac is last seen 5 h ago (open the Digby Mac app to reconnect). Nothing on the Mac was seen or touched. Pair/update the Digby Mac app, then retry.",
    );
    expect(mockError).not.toHaveBeenCalled();
    // The model-facing surface — what the probe reads as its result.
    expect(out).toContain("[COMPUTER_TASK — UNAVAILABLE]");
    expect(out).toContain("[Computer task result — steps: 0 · ");
    expect(out).toContain("· device: cqlstannembp1");
    expect(out).toContain("Nothing on the Mac was seen or touched.");
    // Nothing was seen → no screenshot attaches to the calling run.
    expect(tc.takeAttachedImages()).toEqual([]);
  });

  it("an IDENTICAL repeat in the same run re-warns NOTHING — the ToolCache serves the deduped notice without re-probing (reviewer finding 3)", async () => {
    const tc = new ToolCache("u1", "chat1", () => {});
    const first = await tc.getOrExecute("computer_task", {
      task: "read-only look at the screen",
      device: "cql-stanne-mbp-1",
    });
    const second = await tc.getOrExecute("computer_task", {
      task: "read-only look at the screen",
      device: "cql-stanne-mbp-1",
    });
    // Still exactly ONE warn — the second call is a cache HIT: the row
    // arithmetic is one row per fresh probe firing (each with its own
    // ToolCache), never a re-warn loop inside one run.
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });
});
