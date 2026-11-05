/**
 * Ticket d427c381 (mishap, 2026-10-27) — the computer_task task-text device
 * guard. DETECTOR-RECALL REPLAY: this suite replays the ticket's live mishap
 * (the One Piece TCG peruse lane's mis-resolved probe) and pins the guard.
 *
 * The mishap: the device name 'cql-stanne-mbp1' appeared ONLY in the task
 * text; the `device` param was omitted. selectComputerDriver silently used
 * the owner's default Mac (example-tailnet-peer) and returned a healthy
 * capture — verbatim header "device: example-tailnet-peer · …
 * degenerateFrames=0" — which the lane nearly reported as "mbp-1 capture is
 * healthy, menu bar visible", clearing a device-specific capture-dead
 * diagnosis off the WRONG machine's evidence.
 *
 * Guard now: the task text is consulted at selection. Exactly one named
 * paired device (≠ the default pick) → auto-bound + flagged
 * (deviceAutoBound); several named paired devices → refused with the list;
 * an explicit `device` param still wins over prose but the mismatch rides
 * the header; and the tool-result header renders the device line LOUD in
 * both flagged shapes.
 */

jest.mock("../imessage/imessage.service", () => ({
  listAgents: jest.fn(),
  agentDisplayName: (a: any) => a?.label || a?.deviceName || "Mac",
  isOnline: jest.fn(() => true),
}));
jest.mock("../imessage/agent-link", () => ({
  agentBroker: { dispatch: jest.fn() },
}));
jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tool-executor (the formatter's home) loads the config graph at import —
// mock it out of the test the same way tool-executor.computer-unverified-label
// does (paths resolve to the same src/config modules after jest resolution).
jest.mock("../../../config/database", () => ({ __esModule: true, default: {} }));
jest.mock("../../../config/redis", () => ({ __esModule: true, default: {} }));
jest.mock("../../../config/env", () => ({ __esModule: true, default: {} }));
jest.mock("../mcp-search", () => ({ callMcpTool: jest.fn(), webToolsDegraded: jest.fn(() => false) }));

import { listAgents } from "../imessage/imessage.service";
import { detectNamedDevices, selectComputerDriver } from "./driver";
import { formatComputerTaskToolResult } from "../tool-executor";

const mockListAgents = listAgents as jest.Mock;

const row = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  userId: "user-1",
  label: "cql-stanne-mbp1",
  deviceId: "device-1",
  deviceName: "mbp-1.local",
  isDefault: false,
  agentVersion: "0.9.10",
  lastSeenAt: new Date(),
  ...over,
});

// The mishap's exact fleet: the default Mac mini + the mis-resolved MBP.
const INCIDENT_FLEET = () => [
  row({ id: "agent-mini", label: "example-tailnet-peer", deviceName: "mini.local", deviceId: "device-mini", isDefault: true }),
  row({ id: "agent-mbp", label: "cql-stanne-mbp1", deviceName: "mbp-1.local", deviceId: "device-mbp", isDefault: false }),
];

// The mishap's task text: the device named ONLY in prose.
const INCIDENT_TASK = "Check the menu bar on cql-stanne-mbp1 — is capture healthy?";

beforeEach(() => {
  jest.clearAllMocks();
  mockListAgents.mockResolvedValue(INCIDENT_FLEET());
});

describe("DETECTOR-RECALL REPLAY — ticket d427c381 (the task-text device guard)", () => {
  it("replays the mishap: prose-only device name + omitted param → the NAMED Mac is auto-bound, never the default", async () => {
    const sel = await selectComputerDriver("user-1", undefined, INCIDENT_TASK);
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-mbp");
    expect(sel.device).toBe("cql-stanne-mbp1");
    expect(sel.deviceAutoBound).toBe(true);
    expect(sel.status).toContain("auto-bound");
    expect(sel.taskTextNamedDevices).toEqual(["cql-stanne-mbp1"]);
  });

  it("replays the control: the explicit device param still binds the named Mac (byte-shape preserved, no flags)", async () => {
    const sel = await selectComputerDriver("user-1", "cql-stanne-mbp1", INCIDENT_TASK);
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-mbp");
    expect(sel.deviceAutoBound).toBeUndefined();
  });

  it("the flagged result renders a LOUD header device line naming the auto-bind (the near-miss's cure)", () => {
    const header = formatComputerTaskToolResult({
      finalResponse: "The menu bar is visible; capture is healthy.",
      elapsed: 1000,
      steps: 4,
      localStatus: "connected (Mac app v0.9.10)",
      device: "cql-stanne-mbp1",
      deviceAutoBound: true,
      taskTextNamedDevices: ["cql-stanne-mbp1"],
    } as any);
    expect(header).toContain("device: cql-stanne-mbp1");
    expect(header).toContain("DEVICE AUTO-BOUND FROM THE TASK TEXT");
    expect(header).toContain("it named 'cql-stanne-mbp1'");
    expect(header).toContain("confirm this is the machine the caller meant");
  });

  it("several paired devices named in prose → REFUSED with the list (an implicit pick could be the wrong machine)", async () => {
    const sel = await selectComputerDriver(
      "user-1",
      undefined,
      "Screenshot both cql-stanne-mbp1 and example-tailnet-peer.",
    );
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("several paired devices");
    expect(sel.status).toContain("cql-stanne-mbp1");
    expect(sel.status).toContain("example-tailnet-peer");
    expect(sel.taskTextNamedDevices).toEqual(expect.arrayContaining(["cql-stanne-mbp1", "example-tailnet-peer"]));
  });

  it("prose names a device other than the explicit param → selection binds the PARAM and flags the mismatch", async () => {
    const sel = await selectComputerDriver("user-1", "cql-stanne-mbp1", "check example-tailnet-peer too");
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-mbp");
    expect(sel.taskTextNamesOtherThanParam).toEqual(["example-tailnet-peer"]);
    const header = formatComputerTaskToolResult({
      finalResponse: "done",
      elapsed: 1,
      steps: 2,
      localStatus: "connected (Mac app v0.9.10)",
      device: "cql-stanne-mbp1",
      taskTextNamesOtherThanParam: ["example-tailnet-peer"],
    } as any);
    expect(header).toContain("DEVICE MISMATCH");
    expect(header).toContain("the task text named 'example-tailnet-peer'");
    expect(header).toContain("device: 'cql-stanne-mbp1' was driven");
  });

  it("reviewer F1 regression: the MISMATCH banner renders even when the driven device's display name is bare 'Mac' (deviceLine empty)", () => {
    const header = formatComputerTaskToolResult({
      finalResponse: "done",
      elapsed: 1,
      steps: 2,
      device: "Mac",
      taskTextNamesOtherThanParam: ["example-tailnet-peer"],
    } as any);
    expect(header).toContain("DEVICE MISMATCH");
    expect(header).toContain("the task text named 'example-tailnet-peer'");
    expect(header).toContain("device: 'Mac' was driven");
  });

  it("reviewer F1 regression: the AUTO-BOUND banner renders even when the bound device's display name is bare 'Mac'", () => {
    const header = formatComputerTaskToolResult({
      finalResponse: "done",
      elapsed: 1,
      steps: 2,
      device: "Mac",
      deviceAutoBound: true,
      taskTextNamedDevices: ["Mac"],
    } as any);
    expect(header).toContain("DEVICE AUTO-BOUND FROM THE TASK TEXT");
    expect(header).toContain("it named 'Mac'");
  });
});

describe("detectNamedDevices (pure)", () => {
  it("finds the named device by label across the incident fleet, single hit", () => {
    const named = detectNamedDevices(INCIDENT_TASK, INCIDENT_FLEET());
    expect(named.map((d: any) => d.id)).toEqual(["agent-mbp"]);
  });

  it("returns every distinct named device on a multi-name text", () => {
    const named = detectNamedDevices("use cql-stanne-mbp1 then example-tailnet-peer", INCIDENT_FLEET());
    expect(named.map((d: any) => d.id).sort()).toEqual(["agent-mbp", "agent-mini"]);
  });

  it("never matches a bare substring: 'mini' must not fire inside 'minimal'", () => {
    const fleet = [row({ id: "agent-mini", label: "mini", isDefault: true })];
    expect(detectNamedDevices("watch the minimal editor window", fleet)).toEqual([]);
    expect(detectNamedDevices("check the mini status light", fleet)).toHaveLength(1);
  });

  it("matches deviceName and deviceId fields too (word-boundary)", () => {
    const fleet = INCIDENT_FLEET();
    expect(detectNamedDevices("look at mbp-1.local", fleet).map((d: any) => d.id)).toEqual(["agent-mbp"]);
    expect(detectNamedDevices("look at device-mbp", fleet).map((d: any) => d.id)).toEqual(["agent-mbp"]);
  });

  it("matches the Apple-abbreviation alias (mbp) via the shared variant machinery", () => {
    const fleet = INCIDENT_FLEET();
    expect(detectNamedDevices("is the mbp online?", fleet).map((d: any) => d.id)).toEqual(["agent-mbp"]);
  });

  it("matches case-insensitively and once per device", () => {
    const fleet = INCIDENT_FLEET();
    const named = detectNamedDevices("CQL-STANNE-MBP1 and cql-stanne-mbp1 again", fleet);
    expect(named.map((d: any) => d.id)).toEqual(["agent-mbp"]);
  });

  it("empty text / no devices / unrelated text → no named devices", () => {
    const fleet = INCIDENT_FLEET();
    expect(detectNamedDevices("", fleet)).toEqual([]);
    expect(detectNamedDevices(INCIDENT_TASK, [])).toEqual([]);
    expect(detectNamedDevices("open Notes and type hello", fleet)).toEqual([]);
  });

  it("generic hardware nouns never name a machine ('mac' would contains-match every Mac label)", () => {
    const fleet = INCIDENT_FLEET();
    expect(detectNamedDevices("run this on my mac, please", fleet)).toEqual([]);
    expect(detectNamedDevices("check the computer's desktop", fleet)).toEqual([]);
    expect(detectNamedDevices("open Mail on the laptop", fleet)).toEqual([]);
  });

  it("a task naming the default device itself yields exactly that one (the historical pick, no behavior change)", () => {
    const named = detectNamedDevices("check example-tailnet-peer", INCIDENT_FLEET());
    expect(named.map((d: any) => d.id)).toEqual(["agent-mini"]);
  });
});

describe("guard interplay with the historical paths (no regression)", () => {
  it("no device named in prose → the historical default pick, byte-shape preserved", async () => {
    const sel = await selectComputerDriver("user-1", undefined, "Open Notes and type hello");
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-mini");
    expect(sel.deviceAutoBound).toBeUndefined();
    expect(sel.taskTextNamedDevices).toBeUndefined();
  });

  it("prose names the default Mac only → the default pick, no auto-bind flag", async () => {
    const sel = await selectComputerDriver("user-1", undefined, "check example-tailnet-peer");
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-mini");
    expect(sel.deviceAutoBound).toBeUndefined();
  });

  it("auto-bind honors the capability gate: a named but offline/incapable Mac is refused, not bypassed", async () => {
    mockListAgents.mockResolvedValue([
      row({ id: "agent-mini", label: "example-tailnet-peer", deviceName: "mini.local", deviceId: "device-mini", isDefault: true }),
      row({ id: "agent-mbp", label: "cql-stanne-mbp1", deviceName: "mbp-1.local", deviceId: "device-mbp", agentVersion: "0.2.0" }),
    ]);
    const sel = await selectComputerDriver("user-1", undefined, INCIDENT_TASK);
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("cannot run computer use");
    expect(sel.status).toContain("too old");
  });

  it("no text passed (legacy callers) → historical behavior, no flags", async () => {
    const sel = await selectComputerDriver("user-1");
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-mini");
    expect(sel.deviceAutoBound).toBeUndefined();
  });

  it("single-Mac owner naming their only Mac in prose → that Mac runs, no flag (no behavior change)", async () => {
    mockListAgents.mockResolvedValue([row({ label: "cql-stanne-mbp1", isDefault: true })]);
    const sel = await selectComputerDriver("user-1", undefined, INCIDENT_TASK);
    expect(sel.driver).not.toBeNull();
    expect(sel.deviceAutoBound).toBeUndefined();
  });
});
