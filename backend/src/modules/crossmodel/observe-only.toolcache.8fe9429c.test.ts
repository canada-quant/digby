/**
 * Ticket 8fe9429c — wiring pins (the ToolCache → executor → sub-session
 * threading + the agentLoop role-scoped marking).
 *
 * The device gate itself (the enforcement that actually protects the Mac) is
 * pinned in computer-agent/observe-only.8fe9429c.test.ts. This suite pins the
 * WIRING that gets a read-only worker's session to that gate:
 *   1. ToolCache's computerInputMode flag threads 'observe' into the
 *      browser_task sub-session (computerInputMode) and the computer_task
 *      sub-session (inputMode).
 *   2. A default cache (the orchestrator's) threads NOTHING — the sub-sessions
 *      keep the historical full-control behavior.
 *   3. agentLoop marks its per-run ToolCache observe-only whenever the run is
 *      role-scoped (a delegate worker or a runChatWorker peer) and leaves the
 *      orchestrator's cache full — pinned at the source: the ONLY non-test
 *      `new ToolCache(` site in backend/src (coding/agent.ts).
 *   4. ROLE_TOOLS: browser_task reaches exactly the read-only research roles
 *      (web_researcher + cross_checker); computer_task is in NO role (the
 *      allowedTools gate refuses it) — the tool-surface half of the incident's
 *      mechanism.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  generatedFile: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    aggregate: jest.fn(),
  },
  projectDocument: { findFirst: jest.fn(), findMany: jest.fn() },
  projectChunk: { findMany: jest.fn() },
  chatFile: { findMany: jest.fn() },
};
jest.mock('../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('./upload.controller', () => ({
  __esModule: true,
  loadAttachment: jest.fn(async () => null),
}));

jest.mock('./mcp-search', () => ({
  callMcpTool: jest.fn(async () => null),
  webToolsDegraded: jest.fn(() => false),
}));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

// The sub-session runners are the mocked seams — the executor's own flag
// threading is the code under test, so mock the run functions and inspect the
// input each received (the tool-executor.24fe90cb pattern).
const mockRunBrowser = jest.fn();
const mockRunComputer = jest.fn();
jest.mock('./browser-agent', () => ({
  __esModule: true,
  runBrowserAgentSession: (...a: any[]) => mockRunBrowser(...a),
}));
jest.mock('./computer-agent', () => ({
  __esModule: true,
  runComputerAgentSession: (...a: any[]) => mockRunComputer(...a),
}));

import { ToolCache, TOOL_DEFINITIONS } from './tool-executor';
import { ROLE_TOOLS } from './coding/roles';

const TASK = 'look at the Mac screen and report what Terminal shows';

beforeEach(() => {
  jest.clearAllMocks();
  mockRunBrowser.mockResolvedValue({
    finalResponse: 'saw the screen', elapsed: 1, title: null, driverUsed: 'cloud', steps: 1,
  });
  mockRunComputer.mockResolvedValue({
    finalResponse: 'saw the screen', elapsed: 1, steps: 1,
  });
});

describe('8fe9429c — ToolCache flag → sub-session threading', () => {
  it("an OBSERVE-marked cache passes computerInputMode 'observe' to the browser_task sub-session", async () => {
    const cache = new ToolCache('u1', null, undefined, { computerInputMode: 'observe' });
    await cache.getOrExecute('browser_task', { task: TASK });
    expect(mockRunBrowser).toHaveBeenCalledTimes(1);
    const arg = mockRunBrowser.mock.calls[0][0];
    expect(arg.computerInputMode).toBe('observe');
  });

  it("an OBSERVE-marked cache passes inputMode 'observe' to the computer_task sub-session", async () => {
    const cache = new ToolCache('u1', null, undefined, { computerInputMode: 'observe' });
    await cache.getOrExecute('computer_task', { task: TASK });
    expect(mockRunComputer).toHaveBeenCalledTimes(1);
    const arg = mockRunComputer.mock.calls[0][0];
    expect(arg.inputMode).toBe('observe');
  });

  it('a DEFAULT cache (the orchestrator/lead) threads NO mode — full control, the historical behavior', async () => {
    const cache = new ToolCache('u1');
    await cache.getOrExecute('browser_task', { task: TASK });
    await cache.getOrExecute('computer_task', { task: TASK });
    expect(mockRunBrowser.mock.calls[0][0].computerInputMode).toBeUndefined();
    expect(mockRunComputer.mock.calls[0][0].inputMode).toBeUndefined();
  });

  it("an explicit 'full' cache also threads nothing (only 'observe' is special)", async () => {
    const cache = new ToolCache('u1', null, undefined, { computerInputMode: 'full' });
    await cache.getOrExecute('computer_task', { task: TASK });
    expect(mockRunComputer.mock.calls[0][0].inputMode).toBeUndefined();
  });

  it('browser_task and computer_task are BOTH in TOOL_DEFINITIONS (the executor cases exist for both)', () => {
    const names = TOOL_DEFINITIONS.map((t: any) => t.function.name);
    expect(names).toContain('browser_task');
    expect(names).toContain('computer_task');
  });
});

describe('8fe9429c — the tool-surface mechanism (ROLE_TOOLS)', () => {
  it('browser_task (the incident path: router → COMPUTER handoff → full input) reaches ONLY the read-only research roles', () => {
    const holders = Object.entries(ROLE_TOOLS)
      .filter(([, tools]) => (tools as string[]).includes('browser_task'))
      .map(([role]) => role);
    expect(holders.sort()).toEqual(['cross_checker', 'web_researcher']);
    // both are read-only roles — the incident's exact mechanism
    for (const r of holders) {
      expect((ROLE_TOOLS as Record<string, string[]>)[r].includes('write_file')).toBe(false);
    }
  });

  it('computer_task is in NO role — the allowedTools gate refuses it for every worker', () => {
    for (const [role, tools] of Object.entries(ROLE_TOOLS)) {
      expect({ role, granted: tools.includes('computer_task') }).toEqual({ role, granted: false });
    }
  });
});

describe('8fe9429c — the agentLoop role-scoped marking (source pin)', () => {
  // The only non-test ToolCache constructor in backend/src lives in
  // coding/agent.ts and marks the cache observe-only iff opts.role is set.
  // Reading the file at test time pins the wiring against silent regressions
  // (a future edit could move the constructor or drop the flag without
  // breaking any type).
  const fs = require('fs');
  const path = require('path');
  const agentSrc = fs.readFileSync(
    path.join(__dirname, 'coding', 'agent.ts'),
    'utf8',
  );

  it('the ToolCache constructor marks role-scoped runs observe-only', () => {
    expect(agentSrc).toContain("opts.role ? { computerInputMode: 'observe' as const } : {}");
  });

  it('the orchestrator path (no role) passes an empty options object', () => {
    const m = agentSrc.match(/new ToolCache\(\s*input\.userId,\s*runChatId,\s*\(ev, data\) => input\.emit\(ev, data\),\s*opts\.role \? \{ computerInputMode: 'observe' as const \} : \{\},?\s*\)/s);
    expect(m).not.toBeNull();
  });

  it('there is exactly ONE non-test ToolCache construction in the coding module (the guarded seam)', () => {
    const codingDir = path.join(__dirname, 'coding');
    const files = fs.readdirSync(codingDir).filter((f: string) => f.endsWith('.ts') && !f.includes('.test.'));
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(codingDir, f), 'utf8');
      const count = (src.match(/new ToolCache\(/g) || []).length;
      if (f === 'agent.ts') {
        expect(count).toBe(1);
      } else if (count > 0) {
        offenders.push(`${f}:${count}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('8fe9429c — the browser COMPUTER handoff threads the mode (source pin)', () => {
  const fs = require('fs');
  const path = require('path');
  const glmSrc = fs.readFileSync(
    path.join(__dirname, 'browser-agent', 'glm-loop.ts'),
    'utf8',
  );

  it('the handoff passes computerInputMode through to runComputerAgentSession as inputMode', () => {
    expect(glmSrc).toContain('...(input.computerInputMode ? { inputMode: input.computerInputMode } : {})');
  });

  it("the ROUTER call also threads computerInputMode into selectBrowserDriver (reviewer F1: glm-loop.ts:343)", () => {
    // 8fe9429c F1: without this, a read-only worker's router prompt still
    // advertises the full-input COMPUTER description — the hard gate holds, but
    // the model is sold an input-capable destination it can never use.
    expect(glmSrc).toContain('...(input.computerInputMode ? { computerInputMode: input.computerInputMode } : {})');
  });

  it('the handoff result carries the observeOnly flag to the browser result surface', () => {
    expect(glmSrc).toContain('...(r.observeOnly ? { computerObserveOnly: true } : {})');
  });
});

describe('8fe9429c — result disclosures (the caller learns the camera-only limit)', () => {
  it('formatBrowserTaskToolResult discloses an observe-only COMPUTER handoff', async () => {
    mockRunBrowser.mockResolvedValueOnce({
      finalResponse: 'screen observed', elapsed: 1, title: null, driverUsed: 'computer', steps: 2,
      computerObserveOnly: true,
    });
    const cache = new ToolCache('u1', null, undefined, { computerInputMode: 'observe' });
    const out = await cache.getOrExecute('browser_task', { task: TASK });
    expect(out).toContain('COMPUTER DESTINATION — OBSERVE-ONLY');
    expect(out).toContain('NO clicks, keystrokes, scrolling, app opens or quits were possible');
  });

  it('a normal browser result carries NO observe disclosure', async () => {
    mockRunBrowser.mockResolvedValueOnce({
      finalResponse: 'page read', elapsed: 1, title: null, driverUsed: 'cloud', steps: 1,
    });
    const cache = new ToolCache('u1');
    const out = await cache.getOrExecute('browser_task', { task: TASK });
    expect(out).not.toContain('OBSERVE-ONLY');
  });

  it('formatComputerTaskToolResult flags an observe-only session in the header', async () => {
    mockRunComputer.mockResolvedValueOnce({
      finalResponse: 'screen observed', elapsed: 1, steps: 1, observeOnly: true,
    });
    const cache = new ToolCache('u1', null, undefined, { computerInputMode: 'observe' });
    const out = await cache.getOrExecute('computer_task', { task: TASK });
    expect(out).toContain('OBSERVE-ONLY (camera; no input was possible)');
  });
});
