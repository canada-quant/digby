/**
 * Per-platform computer-use tools (W1 2026-09-25): a Windows-driven session must
 * get Windows doctrine (Win key / ctrl-alt-shift-win modifiers / Chrome-Notepad-
 * Settings examples / "Windows screen") while the macOS toolset stays
 * byte-identical — the descriptions are pinned by product copy and the params
 * schemas are the backend↔vision-model contract. This suite pins both sides:
 *   • macos/null → the exact macOS COMPUTER_TOOLS (same reference)
 *   • windows → same tool NAMES, same params schemas, no macOS doctrine
 */

jest.mock("../../../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock("./driver", () => ({ selectComputerDriver: jest.fn() }));
// W3: computer-loop now imports ./availability (the UIA offer-gate constant),
// which transitively loads imessage.service → config — mock the service edge
// like every other suite in this directory does.
jest.mock("../imessage/imessage.service", () => ({
  listAgents: jest.fn(),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || "Mac"),
  isOnline: jest.fn(),
}));
jest.mock("./use-lock", () => ({
  acquireComputerUseLock: jest.fn(),
  releaseComputerUseLock: jest.fn(),
  LOCK_TTL_MARGIN_MS: 5000,
}));
jest.mock("./vision-client", () => ({
  visionChat: jest.fn(),
  visionConfigured: jest.fn(),
}));

import { COMPUTER_TOOLS, computerToolsForPlatform } from "./computer-loop";

describe("computerToolsForPlatform (W1 per-platform tools)", () => {
  it("macos/null/undefined return the macOS toolset byte-identical (same reference)", () => {
    expect(computerToolsForPlatform("macos")).toBe(COMPUTER_TOOLS);
    expect(computerToolsForPlatform(null)).toBe(COMPUTER_TOOLS);
    expect(computerToolsForPlatform(undefined)).toBe(COMPUTER_TOOLS);
  });

  it("windows keeps the SAME core tool names, types, and parameter schemas (+ W3 UIA additions)", () => {
    const win = computerToolsForPlatform("windows", "0.9.0");
    // W3 (2026-09-25): windows = the eight core tools PLUS uia_tree/uia_invoke
    // (Windows-only, agent 0.9.0). The CORE eight keep identical schemas.
    expect(win.map((t) => t.name)).toEqual([
      ...COMPUTER_TOOLS.map((t) => t.name),
      "uia_tree",
      "uia_invoke",
    ]);
    COMPUTER_TOOLS.forEach((macTool, i) => {
      expect(win[i].type).toBe(macTool.type);
      expect(win[i].parameters).toEqual(macTool.parameters);
    });
  });

  it("windows descriptions drop macOS doctrine", () => {
    const win = computerToolsForPlatform("windows", "0.9.0");
    const keyTool = win.find((t) => t.name === "key")!;
    const all = win.map((t) => `${t.name}: ${t.description}`).join("\n");
    expect(all).not.toContain("Spotlight");
    expect(all).not.toContain("Safari");
    expect(all).not.toContain("System Settings");
    expect(all).not.toContain("Mac screen");
    expect(all).not.toContain("the Mac");
    // macOS modifier names are gone from the key tool (not just any substring)
    expect(keyTool.description).not.toMatch(/\b(cmd|option)\b/);
  });

  it("windows descriptions carry Windows doctrine", () => {
    const all = computerToolsForPlatform("windows", "0.9.0")
      .map((t) => `${t.name}: ${t.description}`)
      .join("\n");
    expect(all).toContain("Windows screen");
    expect(all).toContain("Modifiers: ctrl, alt, shift, win");
    expect(all).toContain('key "win"');
    expect(all).toContain("[\"ctrl\"]");
    expect(all).toContain("Chrome");
    expect(all).toContain("Notepad");
  });

  it("the macOS toolset itself is untouched (regression pin)", () => {
    const all = COMPUTER_TOOLS.map((t) => `${t.name}: ${t.description}`).join("\n");
    expect(all).toContain("Mac screen");
    expect(all).toContain("Modifiers: cmd, shift, ctrl, option");
    expect(all).toContain("Spotlight");
    expect(all).toContain("System Settings");
  });
});
