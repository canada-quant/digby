/**
 * cu-diag 2026-09-25 — driver-side pieces of fix #6 (device-name matching)
 * and fix #9 (settle delay before the post-action auto-screenshot).
 *
 * fix #6: exact, case-sensitive matching refused "MacBook Pro" against a
 * device labelled "Pauls-MBP" and left a single-Mac owner with no driver.
 * Now: normalized (case + punctuation insensitive) substring matching across
 * label / deviceName / id / deviceId, ambiguity refused with the list, and a
 * single paired device ignores an unmatched hint with a note.
 * COMPUTER_DEVICE_MATCH_STRICT=1 restores exact-only.
 *
 * fix #9: the auto-screenshot fired before the screen rendered the action —
 * 600 ms default, 1.5 s after `open` and after Return while Spotlight is
 * armed; COMPUTER_SETTLE_MS=0 disables.
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

import { listAgents } from "../imessage/imessage.service";
import { agentBroker } from "../imessage/agent-link";
import {
  selectComputerDriver,
  matchDeviceTarget,
  deviceNameVariants,
  normalizeDeviceName,
  settleDelayMs,
  isSpotlightKey,
  COMPUTER_SETTLE_MS_DEFAULT,
  COMPUTER_SETTLE_LONG_MS_DEFAULT,
} from "./driver";

const mockListAgents = listAgents as jest.Mock;
const mockDispatch = agentBroker.dispatch as jest.Mock;

const mac = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  userId: "u1",
  label: "Pauls-MBP",
  deviceId: "d1",
  deviceName: "Pauls-MBP.local",
  isDefault: true,
  agentVersion: "0.6.1",
  lastSeenAt: new Date(),
  pairedAt: new Date(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.COMPUTER_DEVICE_MATCH_STRICT;
  delete process.env.COMPUTER_SETTLE_MS;
  delete process.env.COMPUTER_SETTLE_LONG_MS;
});

describe("device-name matching (fix #6)", () => {
  it("normalizeDeviceName drops case, spaces and punctuation", () => {
    expect(normalizeDeviceName("Pauls-MBP.local")).toBe("paulsmbplocal");
    expect(normalizeDeviceName("  MacBook Pro ")).toBe("macbookpro");
    expect(normalizeDeviceName(null)).toBe("");
  });

  it("exact match still wins byte-identically (case-insensitive on the raw fields)", () => {
    const all = [mac(), mac({ id: "a2", label: "Mac mini", deviceName: "mini.local", deviceId: "d2" })];
    expect(matchDeviceTarget(all, "mac mini")).toMatchObject({ kind: "match", device: { id: "a2" } });
    expect(matchDeviceTarget(all, "a1")).toMatchObject({ kind: "match", device: { id: "a1" } });
  });

  it("incident replay: 'pauls mbp' / 'MBP' / 'PAULS-MBP.LOCAL' all resolve to Pauls-MBP", () => {
    const all = [mac(), mac({ id: "a2", label: "Mac mini", deviceName: "mini.local", deviceId: "d2" })];
    for (const hint of ["pauls mbp", "MBP", "PAULS-MBP.LOCAL", "Pauls MBP"]) {
      expect(matchDeviceTarget(all, hint)).toMatchObject({ kind: "match", device: { id: "a1" } });
    }
  });

  it("several substring hits → ambiguous with the candidate list (never a silent pick)", () => {
    const all = [mac({ id: "a1", label: "Mac mini office" }), mac({ id: "a2", label: "Mac mini home", deviceName: "home", deviceId: "d2" })];
    const r = matchDeviceTarget(all, "mac mini");
    expect(r.kind).toBe("ambiguous");
    expect((r as any).candidates.map((c: any) => c.id).sort()).toEqual(["a1", "a2"]);
  });

  // Review 2026-09-25 (non-blocking #4): 'MacBook Pro' vs 'Pauls-MBP' share no
  // substring — the diag's "fuzzy match" claim held only through the
  // single-device carve-out. The abbreviation aliases make it a REAL match,
  // including with a second paired Mac.
  it("alias expansion: 'MacBook Pro' resolves to Pauls-MBP even with a Mac mini paired (no carve-out needed)", () => {
    const all = [mac(), mac({ id: "a2", label: "home-pauls-mac-mini", deviceName: "mini.local", deviceId: "d2" })];
    const r = matchDeviceTarget(all, "MacBook Pro");
    expect(r).toMatchObject({ kind: "match", device: { id: "a1" } });
    expect((r as any).note).toBeUndefined();
    expect(matchDeviceTarget(all, "mac mini")).toMatchObject({ kind: "match", device: { id: "a2" } });
    expect(deviceNameVariants("macbookpro")).toEqual(expect.arrayContaining(["macbookpro", "mbp"]));
    expect(deviceNameVariants("paulsmbp")).toEqual(expect.arrayContaining(["paulsmbp", "paulsmacbookpro"]));
    expect(deviceNameVariants("")).toEqual([]);
  });

  it("alias expansion never invents a match: 'MacBook Air' vs Pauls-MBP + Mac mini → none", () => {
    const all = [mac(), mac({ id: "a2", label: "Mac mini", deviceName: "mini.local", deviceId: "d2" })];
    expect(matchDeviceTarget(all, "MacBook Air")).toEqual({ kind: "none" });
  });

  it("a single paired device ignores an unmatched hint with a note ('iMac' → Pauls-MBP)", () => {
    const r = matchDeviceTarget([mac()], "iMac");
    expect(r.kind).toBe("match");
    expect((r as any).device.id).toBe("a1");
    expect((r as any).note).toContain("matched no device name");
    expect((r as any).note).toContain("Pauls-MBP");
  });

  it("two paired devices + no match → none (the hint could mean either)", () => {
    const all = [mac(), mac({ id: "a2", label: "Mac mini", deviceName: "mini.local", deviceId: "d2" })];
    expect(matchDeviceTarget(all, "iMac")).toEqual({ kind: "none" });
  });

  it("COMPUTER_DEVICE_MATCH_STRICT=1 restores exact-only matching (aliases included)", () => {
    process.env.COMPUTER_DEVICE_MATCH_STRICT = "1";
    expect(matchDeviceTarget([mac()], "MacBook Pro")).toEqual({ kind: "none" });
    expect(matchDeviceTarget([mac()], "iMac")).toEqual({ kind: "none" });
    expect(matchDeviceTarget([mac()], "pauls-mbp")).toMatchObject({ kind: "match" });
  });

  it("selectComputerDriver: the single-device carve-out yields a driver whose status carries the note", async () => {
    mockListAgents.mockResolvedValue([mac()]);
    const sel = await selectComputerDriver("u1", "iMac"); // 'MacBook Pro' is a REAL alias match since the 2026-09-25 review
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe("a1");
    expect(sel.status).toContain("matched no device name");
  });

  it("selectComputerDriver: ambiguity is refused with both names", async () => {
    mockListAgents.mockResolvedValue([
      mac({ id: "a1", label: "Mac mini office" }),
      mac({ id: "a2", label: "Mac mini home", deviceName: "home", deviceId: "d2" }),
    ]);
    const sel = await selectComputerDriver("u1", "mac mini");
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("several paired devices");
    expect(sel.status).toContain("'Mac mini office'");
    expect(sel.status).toContain("'Mac mini home'");
  });

  it("selectComputerDriver: the multi-device unknown-target refusal is unchanged", async () => {
    mockListAgents.mockResolvedValue([mac(), mac({ id: "a2", label: "Mac mini", deviceName: "mini.local", deviceId: "d2" })]);
    const sel = await selectComputerDriver("u1", "iMac");
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("no paired device matches 'iMac'");
  });
});

describe("settle delay before the auto-screenshot (fix #9)", () => {
  it("defaults: 600 ms for ordinary input, 1500 ms after open", () => {
    expect(COMPUTER_SETTLE_MS_DEFAULT).toBe(600);
    expect(COMPUTER_SETTLE_LONG_MS_DEFAULT).toBe(1500);
    expect(settleDelayMs({ name: "click" }, false)).toBe(600);
    expect(settleDelayMs({ name: "type" }, false)).toBe(600);
    expect(settleDelayMs({ name: "key", key: "return" }, false)).toBe(600);
    expect(settleDelayMs({ name: "open" }, false)).toBe(1500);
  });

  it("Return while Spotlight is armed (Cmd+Space was the previous key) gets the long settle", () => {
    expect(settleDelayMs({ name: "key", key: "return" }, true)).toBe(1500);
    expect(settleDelayMs({ name: "key", key: "Enter" }, true)).toBe(1500);
    expect(settleDelayMs({ name: "key", key: "tab" }, true)).toBe(600);
    expect(isSpotlightKey({ name: "key", key: "space", modifiers: ["cmd"] })).toBe(true);
    expect(isSpotlightKey({ name: "key", key: "space", modifiers: ["Command"] })).toBe(true);
    expect(isSpotlightKey({ name: "key", key: "space" })).toBe(false);
    expect(isSpotlightKey({ name: "click" })).toBe(false);
  });

  it("COMPUTER_SETTLE_MS=0 disables every delay (kill switch); env tunes both values", () => {
    process.env.COMPUTER_SETTLE_MS = "0";
    expect(settleDelayMs({ name: "open" }, false)).toBe(0);
    expect(settleDelayMs({ name: "key", key: "return" }, true)).toBe(0);
    process.env.COMPUTER_SETTLE_MS = "250";
    process.env.COMPUTER_SETTLE_LONG_MS = "900";
    expect(settleDelayMs({ name: "click" }, false)).toBe(250);
    expect(settleDelayMs({ name: "open" }, false)).toBe(900);
    process.env.COMPUTER_SETTLE_MS = "garbage";
    expect(settleDelayMs({ name: "click" }, false)).toBe(600);
  });

  it("the driver sleeps between the action and its auto-screenshot (and not before a bare screenshot)", async () => {
    process.env.COMPUTER_SETTLE_MS = "200";
    mockListAgents.mockResolvedValue([mac()]);
    const sel = await selectComputerDriver("u1");
    const times: Array<{ method: string; at: number }> = [];
    mockDispatch.mockImplementation(async (_id: string, method: string) => {
      times.push({ method, at: Date.now() });
      return method === "computer_screenshot" ? { ok: true, screenshotBase64: "x", imageWidth: 10, imageHeight: 10 } : { ok: true };
    });
    await sel.driver!.execute({ name: "click", x: 1, y: 1 });
    expect(times.map((t) => t.method)).toEqual(["computer_click", "computer_screenshot"]);
    expect(times[1].at - times[0].at).toBeGreaterThanOrEqual(180);
    times.length = 0;
    await sel.driver!.execute({ name: "screenshot" });
    expect(times.map((t) => t.method)).toEqual(["computer_screenshot"]);
  });

  it("the Spotlight arm/disarm state lives per driver: Cmd+Space then Return sleeps the long delay", async () => {
    process.env.COMPUTER_SETTLE_MS = "50";
    process.env.COMPUTER_SETTLE_LONG_MS = "300";
    mockListAgents.mockResolvedValue([mac()]);
    const sel = await selectComputerDriver("u1");
    const times: Array<{ method: string; at: number }> = [];
    mockDispatch.mockImplementation(async (_id: string, method: string) => {
      times.push({ method, at: Date.now() });
      return method === "computer_screenshot" ? { ok: true, screenshotBase64: "x", imageWidth: 10, imageHeight: 10 } : { ok: true };
    });
    await sel.driver!.execute({ name: "key", key: "space", modifiers: ["cmd"] });
    times.length = 0;
    await sel.driver!.execute({ name: "key", key: "return" });
    expect(times[1].at - times[0].at).toBeGreaterThanOrEqual(280);
    // Disarmed after Return: the next Return is a short settle again.
    times.length = 0;
    await sel.driver!.execute({ name: "key", key: "return" });
    expect(times[1].at - times[0].at).toBeLessThan(250);
  });
});
