/**
 * Multi-Mac routing for computer use (owner 2026-09-24) — the second of the two
 * single-Mac enforcement points (the browser router is covered by its own
 * suites). selectComputerDriver now reasons over ALL paired Macs:
 *
 *   • single Mac, capable → that Mac (unchanged behavior)
 *   • multiple, no target → the default Mac when capable
 *   • default too old/offline → ANOTHER capable Mac keeps computer use on
 *     ("too old" excludes only that Mac, never the whole surface)
 *   • explicit target by label → that Mac; unknown → clean error listing devices
 *   • result carries `device` so headers can name WHICH Mac ran
 */

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("../../../config/database", () => ({ __esModule: true, default: {} }));
jest.mock("../../../config/env", () => ({ __esModule: true, env: { NODE_ENV: "test" } }));
jest.mock("../../../config/redis", () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn() },
}));

import { selectComputerDriver } from "./driver";
import { listAgents } from "../imessage/imessage.service";

jest.mock("../imessage/imessage.service", () => ({
  listAgents: jest.fn(),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || "Mac"),
  isOnline: (d: Date | null | undefined) => !!d && Date.now() - new Date(d).getTime() < 45_000,
}));

const asMock = (fn: unknown) => fn as jest.Mock;

const mac = (over: Record<string, unknown> = {}) => ({
  id: "agent-1",
  userId: "u1",
  label: "MacBook Pro",
  deviceId: "device-1",
  deviceName: "book.local",
  agentVersion: "0.4.0",
  isDefault: true,
  lastSeenAt: new Date(), // online
  pairedAt: new Date(),
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("selectComputerDriver — multi-Mac routing", () => {
  it("single capable Mac (any default state) → that Mac, device named", async () => {
    asMock(listAgents).mockResolvedValue([mac()]);
    const sel = await selectComputerDriver("u1");
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("agent-1");
    expect(sel.device).toBe("MacBook Pro");
  });

  it("multiple capable Macs, no target → the DEFAULT Mac", async () => {
    asMock(listAgents).mockResolvedValue([
      mac({ id: "a1", label: "MacBook Pro", deviceId: "d1", isDefault: true }),
      mac({ id: "a2", label: "Mac mini", deviceId: "d2", isDefault: false }),
    ]);
    const sel = await selectComputerDriver("u1");
    expect(sel.agentId).toBe("a1");
    expect(sel.device).toBe("MacBook Pro");
  });

  it("default Mac TOO OLD → the other capable Mac keeps computer use available", async () => {
    asMock(listAgents).mockResolvedValue([
      mac({ id: "a1", label: "MacBook Pro", deviceId: "d1", isDefault: true, agentVersion: "0.1.9" }),
      mac({ id: "a2", label: "Mac mini", deviceId: "d2", isDefault: false, agentVersion: "0.4.0" }),
    ]);
    const sel = await selectComputerDriver("u1");
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("a2");
    expect(sel.device).toBe("Mac mini");
  });

  it("default Mac OFFLINE → the other capable Mac serves", async () => {
    asMock(listAgents).mockResolvedValue([
      mac({ id: "a1", label: "MacBook Pro", deviceId: "d1", isDefault: true, lastSeenAt: new Date(Date.now() - 10 * 60_000) }),
      mac({ id: "a2", label: "Mac mini", deviceId: "d2", isDefault: false }),
    ]);
    const sel = await selectComputerDriver("u1");
    expect(sel.agentId).toBe("a2");
  });

  it("ALL Macs too old → no driver, status names EACH Mac (per-device reasons)", async () => {
    asMock(listAgents).mockResolvedValue([
      mac({ id: "a1", label: "MacBook Pro", isDefault: true, agentVersion: "0.1.9" }),
      mac({ id: "a2", label: "Mac mini", isDefault: false, agentVersion: "0.2.5" }),
    ]);
    const sel = await selectComputerDriver("u1");
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("no capable device");
    expect(sel.status).toContain("'MacBook Pro'");
    expect(sel.status).toContain("'Mac mini'");
  });

  it("explicit target by label → that Mac", async () => {
    asMock(listAgents).mockResolvedValue([
      mac({ id: "a1", label: "MacBook Pro", deviceId: "d1", isDefault: true }),
      mac({ id: "a2", label: "Mac mini", deviceId: "d2", isDefault: false }),
    ]);
    const sel = await selectComputerDriver("u1", "Mac mini");
    expect(sel.agentId).toBe("a2");
    expect(sel.device).toBe("Mac mini");
  });

  it("explicit target by raw agent id → that Mac", async () => {
    asMock(listAgents).mockResolvedValue([
      mac({ id: "a1", label: "MacBook Pro", deviceId: "d1", isDefault: true }),
      mac({ id: "a2", label: "Mac mini", deviceId: "d2", isDefault: false }),
    ]);
    const sel = await selectComputerDriver("u1", "a2");
    expect(sel.agentId).toBe("a2");
  });

  it("UNKNOWN target → clean error listing the paired Macs, no driver", async () => {
    asMock(listAgents).mockResolvedValue([
      mac({ id: "a1", label: "MacBook Pro", isDefault: true }),
      mac({ id: "a2", label: "Mac mini", isDefault: false }),
    ]);
    const sel = await selectComputerDriver("u1", "iMac");
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("paired device matches 'iMac'");
    expect(sel.status).toContain("'MacBook Pro'");
    expect(sel.status).toContain("'Mac mini'");
  });

  it("targeted Mac too old → names THAT Mac, keeps others listed", async () => {
    asMock(listAgents).mockResolvedValue([
      mac({ id: "a1", label: "MacBook Pro", isDefault: true, agentVersion: "0.4.0" }),
      mac({ id: "a2", label: "Mac mini", isDefault: false, agentVersion: "0.1.9" }),
    ]);
    const sel = await selectComputerDriver("u1", "Mac mini");
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("'Mac mini' cannot run computer use");
    expect(sel.status).toContain("too old");
  });

  it("no Macs paired at all → the canonical not-connected status", async () => {
    asMock(listAgents).mockResolvedValue([]);
    const sel = await selectComputerDriver("u1");
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("not connected");
  });
});
