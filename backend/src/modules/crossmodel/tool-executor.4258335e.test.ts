/**
 * Ticket 4258335e — the local-browser disclosure branches on the mode that
 * ACTUALLY ran (88915954 ask c follow-through).
 *
 * 88915954 pinned the separate-profile disclosure for the ONLY mode that then
 * existed. CDP-attach mode (agent v0.5.0) adds a second: a dedicated new tab of
 * the user's EVERYDAY Chrome. The disclosure must follow the ACTUAL mode
 * (stamped by the agent on every observation), never the request:
 *   - mode 'attached'      → name their real Chrome, FORBID the separate-profile line
 *   - mode 'digby-profile' → the 88915954 line; PLUS an attach-fallback note
 *                            when attach was requested but did not engage
 *   - no mode (legacy agent) + attach requested → same fallback note
 *   - no attach requested → the 88915954 line, byte-identical (sibling pins hold)
 */

import { readFileSync } from 'fs';
import { join } from 'path';

// Repo idiom (tool-executor.88915954.test.ts): env-severing mocks — the
// formatter surface under test never calls these.
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('./upload.controller', () => ({ __esModule: true, loadAttachment: jest.fn(async () => null) }));
jest.mock('./mcp-search', () => ({
  __esModule: true,
  callMcpTool: jest.fn(async () => null),
  webToolsDegraded: jest.fn(() => false),
}));
jest.mock('./coding/web-pipe', () => ({ __esModule: true, runWebPipe: jest.fn() }));
jest.mock('./coding/youtube-pipe', () => ({ __esModule: true, runYoutubePipe: jest.fn() }));

describe('feedback 4258335e — disclosure follows the ACTUAL local-browser mode', () => {
  const { formatBrowserTaskToolResult, TOOL_DEFINITIONS } = require('./tool-executor');

  const baseLocal = {
    finalResponse: 'read the page',
    elapsed: 3000,
    title: null,
    driverUsed: 'local',
    driverReason: 'Your Mac browser is connected, so using it.',
    localBrowserStatus: 'connected (Mac app v0.5.0)',
    steps: 3,
  };

  it('mode "attached" → names the user\'s EVERYDAY Chrome and forbids the separate-profile wording', () => {
    const out = formatBrowserTaskToolResult({ ...baseLocal, attachRequested: true, localBrowserMode: 'attached' });
    expect(out).toContain('LOCAL BROWSER — CDP ATTACH');
    expect(out).toContain("NEW TAB of the user's EVERYDAY Chrome");
    expect(out).toContain('their real signed-in profile');
    expect(out).toContain('Never call it a separate Digby profile');
    expect(out).toContain('no typing into password/credential fields, no form submits');
    expect(out).not.toContain('SEPARATE Digby browser profile');
  });

  it('mode "digby-profile" + attachRequested → 88915954 line PLUS the attach-fallback note', () => {
    const out = formatBrowserTaskToolResult({ ...baseLocal, attachRequested: true, localBrowserMode: 'digby-profile' });
    expect(out).toContain('SEPARATE Digby browser profile');
    expect(out).toContain('CDP attach was requested for this task but did NOT engage');
    expect(out).toContain("Digby's separate profile ran instead");
    expect(out).not.toContain('CDP ATTACH');
  });

  it('attach requested but a legacy agent stamped no mode → fallback note still fires', () => {
    const out = formatBrowserTaskToolResult({ ...baseLocal, attachRequested: true });
    expect(out).toContain('SEPARATE Digby browser profile');
    expect(out).toContain('CDP attach was requested for this task but did NOT engage');
  });

  it('no attach requested → the 88915954 line rides alone (no attach text at all)', () => {
    const out = formatBrowserTaskToolResult(baseLocal);
    expect(out).toContain('SEPARATE Digby browser profile');
    expect(out).not.toContain('CDP attach');
    expect(out).not.toContain('CDP ATTACH');
  });

  it('the browser_task schema exposes the per-task attach opt-in (never a default)', () => {
    const def = TOOL_DEFINITIONS.find((t: any) => t.function?.name === 'browser_task');
    expect(def).toBeTruthy();
    const attach = def.function.parameters?.properties?.attach;
    expect(attach).toBeTruthy();
    expect(attach.type).toBe('boolean');
    expect(attach.description).toContain('OPT-IN');
    expect(attach.description).toContain('v0.5.0');
    // Not in required — the model must pass it explicitly, per task.
    expect(def.function.parameters.required).toEqual(['task']);
  });

  it('the local sub-agent prompt names the rails + both modes when attach was requested', () => {
    const src = readFileSync(join(__dirname, 'browser-agent', 'glm-loop.ts'), 'utf8');
    expect(src).toContain('THIS SESSION requested CDP-attach mode');
    expect(src).toContain('mode "attached"');
    expect(src).toContain('mode "digby-profile"');
    expect(src).toContain('HARD-REFUSE');
    // The 88915954 base wording survived the attach append:
    expect(src).toContain('separate browser profile on your Mac');
  });
});
