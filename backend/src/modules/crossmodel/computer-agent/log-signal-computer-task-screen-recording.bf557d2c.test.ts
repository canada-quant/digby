/**
 * Characterization pin — log-signal ticket bf557d2c (2026-10-23, family lane
 * ecc2bb0d): the "ToolExecutor: computer_task unavailable — Computer use
 * could not get a first screenshot from your Mac: Missing macOS
 * permission(s): Screen Recording …" warn fingerprint the hourly
 * log-signal-sweep filed is DESIGNED per-call capability observability, not a
 * defect. Sibling of the offline fingerprint pinned by
 * log-signal-computer-task-offline.c97f78b3.test.ts (PR #1882) — same probe,
 * same emitting chain, different leg: THAT Mac is offline; THIS Mac is ONLINE
 * but its agent cannot capture (no Screen Recording TCC grant for
 * "DigbyAgent"), so the FIRST screenshot fails and the session returns one
 * structured notice at steps 0.
 *
 * WHERE THE ROWS COME FROM (adjudicated 2026-10-23, live evidence this run):
 * the OAuth-demo lane's recurring availability probe (schedule 24fd9577,
 * machine-armed 2026-10-21, owner notified 20:06Z Oct 21) fires a read-only
 * computer_task at BOTH paired Macs every 20 minutes while the demo video
 * waits on the owner. The mbp-2 leg — ONLINE, but missing the Screen
 * Recording permission — returns THIS fingerprint; the offline mbp-1 leg
 * returns the c97f78b3 one. The ticket's filing window (14 rows Oct 21
 * 18:51Z→23:48Z) is exactly that cadence; at pin time (00:18Z Oct 23) the
 * class shows 19 rows in the trailing 24 h with the NEWEST at 06:29:59Z Oct
 * 22 — ~18 h of silence: the bounded probe ENDED (maxRuns) and the class
 * self-stopped, which a retry storm or a lost-suppression-state defect would
 * not do.
 *
 * THE CHAIN (three legs, all pinned below):
 *   1. driver — the ONLINE Mac yields a real driver bound to its agent id
 *      (this is the delta vs c97f78b3, where the offline Mac yields none).
 *   2. computer-loop — the first screenshot dispatch returns ok:false with
 *      the agent's permission error; the loop composes
 *      "Computer use could not get a first screenshot from your Mac:
 *      <error>. If this mentions Screen Recording permission, follow the
 *      setup dialog that appeared on the Mac, then retry." and returns it as
 *      ONE capabilityNotice at steps=0 — the vision seat is never called, no
 *      input action runs, the per-device use-lock is taken and ALWAYS
 *      released (the finally), and there is NO retry of the first screenshot
 *      (one dispatch per call).
 *   3. tool-executor ToolCache — logs EXACTLY ONE logger.warn
 *      ("ToolExecutor: computer_task unavailable — <notice>") and hands the
 *      calling agent the [COMPUTER_TASK — UNAVAILABLE] banner — the surface
 *      the probe reads as its result.
 *
 * WHY: the warn is the designed per-call degradation signal for a device the
 * fleet CANNOT see (the alternative — silence — is what let a dead-branch
 * class go unobserved for weeks). The notice embeds the REMEDY (the setup
 * dialog was already shown on the Mac; add "DigbyAgent" under System Settings
 * → Privacy & Security → Screen Recording; no restart needed). The underlying
 * wait is the owner's one physical action on mbp-2 — project decision f192
 * (owner notified 2026-10-21); no code change shortens it.
 *
 * RE-OPEN BAR: re-open when this fingerprint's 24 h row count exceeds 200
 * (~14× the filing baseline — unreachable without either an in-call retry
 * loop or an unbounded probe; only a genuine hot-loop reaches it, and that
 * would be a new defect, not probe cadence).
 */

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tool-executor's static import graph — the same mock set the sibling pin
// (log-signal-computer-task-offline.c97f78b3.test.ts) uses to stay hermetic.
jest.mock("../../../config/database", () => ({ __esModule: true, default: {} }));
// The REAL imessage.service (requireActual'd below for agentDisplayName)
// imports config/redis at load — mock the boundary or the real env parser
// process.exit(1)s the worker.
jest.mock("../../../config/redis", () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn() },
}));
jest.mock("../mcp-search", () => ({ __esModule: true, callMcpTool: jest.fn(), webToolsDegraded: () => false }));
jest.mock("../upload.controller", () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock("../coding/web-pipe", () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock("../coding/youtube-pipe", () => ({ __esModule: true, runYoutubePipe: jest.fn() }));
jest.mock("../imessage/imessage.service", () => ({
  listAgents: jest.fn(),
  agentDisplayName: jest.requireActual("../imessage/imessage.service").agentDisplayName,
  // The REAL 45s online window, inline — mbp-2's online-ness below is genuine.
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
import { acquireComputerUseLock, releaseComputerUseLock, recordComputerUseHolder } from "./use-lock";
import { visionChat } from "./vision-client";

const mockListAgents = listAgents as jest.Mock;
const mockDispatch = agentBroker.dispatch as jest.Mock;
const mockAcquireLock = acquireComputerUseLock as jest.Mock;
const mockReleaseLock = releaseComputerUseLock as jest.Mock;
const mockRecordHolder = recordComputerUseHolder as jest.Mock;
const mockVisionChat = visionChat as jest.Mock;
const mockWarn = logger.warn as jest.Mock;
const mockError = logger.error as jest.Mock;

const H = 3_600_000;
/** mbp-1: offline twin (the c97f78b3 fingerprint's leg). */
const mbp1 = (over: Record<string, unknown> = {}) => ({
  id: "agent-mbp1",
  userId: "u1",
  label: "cqlstannembp1",
  deviceName: "cql-stanne-mbp-1.local",
  agentVersion: "0.9.2",
  isDefault: false,
  lastSeenAt: new Date(Date.now() - 5 * H),
  pairedAt: new Date(),
  ...over,
});
/** mbp-2: ONLINE — THIS ticket's leg. The Mac answers, but its agent cannot
 * capture: the Screen Recording TCC grant for "DigbyAgent" is missing. */
const mbp2 = (over: Record<string, unknown> = {}) => ({
  id: "agent-mbp2",
  userId: "u1",
  label: "cqlstannembp2",
  deviceName: "cql-stanne-mbp-2.local",
  agentVersion: "0.9.2",
  isDefault: true,
  lastSeenAt: new Date(Date.now() - 1_000),
  pairedAt: new Date(),
  ...over,
});

/** The live agent-side error (row evidence, bf557d2c example message): the
 * setup dialog was shown on the Mac and no restart is needed — the remedy
 * rides the notice, and the trailing "." + ". " join reproduces the ".."
 * seen in the swept row verbatim. */
const SCREEN_REC_ERROR =
  'Missing macOS permission(s): Screen Recording. A setup dialog was shown on the user\'s Mac (add "DigbyAgent" under System Settings → Privacy & Security → Screen Recording), then retry — no restart needed.';
const NOTICE =
  `Computer use could not get a first screenshot from your Mac: ${SCREEN_REC_ERROR}. ` +
  `If this mentions Screen Recording permission, follow the setup dialog that appeared on the Mac, then retry.`;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.COMPUTER_DEVICE_MATCH_STRICT;
  mockListAgents.mockReset();
  mockListAgents.mockResolvedValue([mbp1(), mbp2()]);
  // The ONLINE Mac's agent answers every dispatch with the permission error —
  // the broker link itself is healthy; only the capture is denied.
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({ ok: false, error: SCREEN_REC_ERROR });
  mockAcquireLock.mockReset();
  mockAcquireLock.mockResolvedValue("lock-tok-1");
  mockReleaseLock.mockReset();
  mockRecordHolder.mockReset();
  mockRecordHolder.mockResolvedValue(undefined);
});

describe("log-signal bf557d2c — leg 1: the ONLINE Mac yields a real driver (the delta vs the offline sibling)", () => {
  it("explicit-target probe on the permission-denied Mac: driver NON-null, bound to mbp-2's agent id", async () => {
    const sel = await selectComputerDriver("u1", "cql-stanne-mbp-2");
    // Not the offline sibling's null-driver return: this device is REACHABLE,
    // so the failure class is capture-permission, not availability.
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-mbp2");
    expect(sel.device).toBe("cqlstannembp2");
    expect(sel.platform).toBe("macos");
  });
});

describe("log-signal bf557d2c — leg 2: the failed FIRST screenshot is ONE structured notice at steps 0", () => {
  it("online Mac + permission-denied capture: steps=0, capabilityNotice === finalResponse === the swept notice, ONE dispatch, no retry, no vision call, lock taken and ALWAYS released", async () => {
    const events: Array<{ t: string; d: any }> = [];
    const result = await runComputerAgentSession({
      userId: "u1",
      chatId: null,
      message: "read-only look at the screen",
      device: "cql-stanne-mbp-2",
      sendEvent: (t: string, d: any) => {
        events.push({ t, d });
      },
    });
    expect(result.steps).toBe(0);
    expect(result.capabilityNotice).toBe(NOTICE);
    expect(result.finalResponse).toBe(result.capabilityNotice);
    // The steps-0 screenshot-failure return carries no device field (unlike
    // the lock-busy return) — the driven device is pinned by the dispatched
    // agent id below.
    expect(result.elapsed).toBeLessThan(2_000);

    // ONE first-screenshot dispatch — there is NO retry ladder on this path
    // (the containment bound behind "rows = probe calls, never a storm").
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      "agent-mbp2",
      "computer_screenshot",
      {},
      expect.any(Number),
      expect.objectContaining({ capability: "computer" }),
    );

    // The per-device use-lock was taken for mbp-2's agent and released in the
    // finally — an unavailable capture never leaks the device to the next
    // contender.
    expect(mockAcquireLock).toHaveBeenCalledTimes(1);
    expect(mockAcquireLock).toHaveBeenCalledWith("u1", expect.any(Number), "agent-mbp2");
    expect(mockReleaseLock).toHaveBeenCalledWith("u1", "lock-tok-1", "agent-mbp2");

    // The vision seat is never consulted — the session ends at the failed
    // first screenshot, before any model turn.
    expect(mockVisionChat).not.toHaveBeenCalled();

    // Exactly one observation event — the failed screenshot itself; no input
    // action ever ran against the Mac.
    const observations = events.filter((e) => e.t === "computer-observation");
    expect(observations).toHaveLength(1);
    expect(observations[0].d).toMatchObject({ action: "screenshot", ok: false });
    expect(events.filter((e) => e.t === "computer-observation" && e.d?.action !== "screenshot")).toHaveLength(0);
  });
});

describe("log-signal bf557d2c — leg 3: ToolExecutor emits exactly ONE warn per call, at warn level, with the swept prefix", () => {
  it("computer_task on the permission-denied Mac: ONE logger.warn carrying the fingerprint text; the caller gets the UNAVAILABLE banner at steps: 0", async () => {
    const tc = new ToolCache("u1", "chat1", () => {});
    const out = await tc.getOrExecute("computer_task", {
      task: "read-only look at the screen",
      device: "cql-stanne-mbp-2",
    });
    // ONE warn per call — the containment contract behind "14 rows in the
    // filing window = 14 probe calls". Level warn (never error): the sweep's
    // observability contract — and logger.error is asserted NEVER, so a
    // refactor cannot silently mint a second app_error_logs row per call.
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toBe(`ToolExecutor: computer_task unavailable — ${NOTICE}`);
    expect(mockError).not.toHaveBeenCalled();
    // The model-facing surface — what the probe reads as its result, remedy
    // text included.
    expect(out).toContain("[COMPUTER_TASK — UNAVAILABLE]");
    expect(out).toContain("[Computer task result — steps: 0");
    expect(out).toContain("follow the setup dialog that appeared on the Mac, then retry.");
    // Nothing was seen → no screenshot attaches to the calling run.
    expect(tc.takeAttachedImages()).toEqual([]);
  });

  it("an IDENTICAL repeat in the same run re-warns NOTHING — the ToolCache serves the deduped notice (mirror of the sibling pin)", async () => {
    const tc = new ToolCache("u1", "chat1", () => {});
    const first = await tc.getOrExecute("computer_task", {
      task: "read-only look at the screen",
      device: "cql-stanne-mbp-2",
    });
    const second = await tc.getOrExecute("computer_task", {
      task: "read-only look at the screen",
      device: "cql-stanne-mbp-2",
    });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });
});
