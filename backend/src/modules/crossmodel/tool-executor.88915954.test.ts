/**
 * Ticket 88915954 (mishap, 2026-09-22) — the local browser agent confirmed "the
 * real (non-headless) browser" while driving a SEPARATE Digby-managed profile.
 *
 * The mishap (owner report, Fleet Supervisor chat): over several days the
 * browser/computer-use agent kept hitting CAPTCHA + sliding-puzzle loops on the
 * owner's MacBook Pro. Asked what it was driving, the agent "confirmed" it used
 * the real (non-headless) browser — eliding that the local destination is BY
 * DESIGN a separate Digby browser profile (none of the owner's everyday Chrome
 * logins), launched with Playwright's default --no-sandbox (the "unsupported
 * command-line flag" warning the owner saw; a strong automation tell on
 * anti-bot surfaces).
 *
 * The fix (ticket asks a+b; ask c — CDP attach to the owner's running Chrome —
 * is a separate longer-term feature, not this PR):
 *   1. formatBrowserTaskToolResult: a LOCAL run's result header now carries a
 *      LOCAL BROWSER disclosure line the calling model must state plainly in
 *      its answer — "a SEPARATE Digby browser profile … NOT their everyday
 *      Chrome/Safari", never just "your real browser" / "not headless".
 *   2. browser_task tool description: binds the model to ALWAYS make that
 *      plain statement when the LOCAL destination ran.
 *   3. glm-loop local system prompt: the sub-agent's own user-facing text
 *      (done / ask_user) must call it "Digby's separate browser profile on
 *      your Mac" — never "your real browser" or just "not headless".
 *   4. imessage-agent browser.ts launches with chromiumSandbox: true (drops
 *      --no-sandbox) — pinned by imessage-agent/test/browser-launch.88915954.test.mjs.
 *
 * These tests replay the mishap at the two backend surfaces the calling model
 * reads — the tool-result header (1) and the tool description (2) — plus a
 * source-bytes pin on the sub-agent prompt (3).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Repo idiom (browser-agent.test.ts): mock the logger BEFORE requiring
// tool-executor — logger imports config/env, which zod-validates process.env
// and exits at module load; the formatter/description surface under test does
// not need real env.
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
// Same env-severing idiom as tool-executor.24fe90cb.test.ts: these modules
// (or their deps) touch config/env at load; the surfaces under test never call
// them.
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('./mcp-search', () => ({
  __esModule: true,
  callMcpTool: jest.fn(async () => null),
  webToolsDegraded: jest.fn(() => false),
}));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

describe('feedback 88915954 — local-browser separation can never be elided again', () => {
  const { formatBrowserTaskToolResult, TOOL_DEFINITIONS } = require('./tool-executor');

  const localResult = {
    finalResponse: '  filled the form and read the confirmation  ',
    elapsed: 4200,
    title: null,
    driverUsed: 'local',
    driverReason: 'Your Mac browser is connected, so using it.',
    localBrowserStatus: 'connected (Mac app v0.4.3)',
    steps: 4,
  };

  it('1. a LOCAL result header carries the plain separate-profile disclosure the agent elided', () => {
    const out = formatBrowserTaskToolResult(localResult);
    expect(out).toContain('[Browser agent result — driver: local, steps: 4');
    expect(out).toContain(' · local browser: connected (Mac app v0.4.3)');
    // The disclosure is a MUST-RELAY line riding the header the model relays:
    expect(out).toContain('[LOCAL BROWSER — DISCLOSE PLAINLY IN YOUR ANSWER:');
    expect(out).toContain('SEPARATE Digby browser profile');
    expect(out).toContain('NOT their everyday Chrome/Safari');
    expect(out).toContain('Never call it just "your real browser" or "not headless"');
    // The sub-agent's findings still ride below, trimmed:
    expect(out.endsWith('\nfilled the form and read the confirmation')).toBe(true);
  });

  it('2. cloud and computer results carry NO local disclosure (their shapes unchanged)', () => {
    const cloud = formatBrowserTaskToolResult({ ...localResult, driverUsed: 'cloud' });
    expect(cloud).not.toContain('LOCAL BROWSER — DISCLOSE');
    const computer = formatBrowserTaskToolResult({ ...localResult, driverUsed: 'computer' });
    expect(computer).not.toContain('LOCAL BROWSER — DISCLOSE');
  });

  it('3. the browser_task tool description binds the model to ALWAYS state the separation for LOCAL runs', () => {
    const def = TOOL_DEFINITIONS.find((t: any) => t.function?.name === 'browser_task');
    expect(def).toBeTruthy();
    expect(def.function.description).toContain(
      'MUST ALWAYS state plainly that it used a separate Digby browser profile',
    );
    expect(def.function.description).toContain(
      'never describe it as just "their real browser" or "not headless"',
    );
  });

  it('4. the local sub-agent prompt instructs "Digby\'s separate browser profile" wording in user-facing text', () => {
    const src = readFileSync(join(__dirname, 'browser-agent', 'glm-loop.ts'), 'utf8');
    expect(src).toContain('always call it');
    expect(src).toContain('separate browser profile on your Mac');
    expect(src).toContain('never "your real browser" or just "not headless"');
    expect(src).toContain('88915954');
  });
});
