/**
 * Ticket 2d461d80 (bug_report, 2026-11-06) — DETECTOR-RECALL REPLAY.
 *
 * The report: a project lane ran three `computer_task` attempts explicitly
 * pinned `device: cql-stanne-msi-win` (a paired Windows PC) while a Mac was
 * also paired. Every attempt header printed `mac: connected`, and the frames
 * could not be proven to come from the pinned box. The lane concluded the
 * device pin was ignored and a Mac (or a cache) was serving the frames, and
 * mis-diagnosed the failure as an OS lock screen for 7+ firings.
 *
 * WHAT WAS ACTUALLY WRONG (reproduced against the code, not the narration):
 *   • the tool-result header hard-coded the label ` · mac: ` — so a
 *     Windows-pinned run read "mac: connected (Windows agent v0.9.10)". The
 *     platform was NEVER typed on the result, so no consumer could render it;
 *   • the attached-screenshot caption hard-coded "Your Mac";
 *   • a PRESENT-but-BLANK `device` pin ("", "   ") fell through the selection
 *     guard to the default device with NO flag and NO warning — the one truly
 *     silent substitution in the path.
 *
 * WHAT WAS **NOT** WRONG (refuted, pinned here as positive controls so a future
 * regression is caught rather than re-diagnosed):
 *   • the pin IS honored end-to-end: an explicit Windows pin with a Mac also
 *     paired selects the Windows row — never the Mac default;
 *   • `steps: 12` is the loop's MAX_STEPS budget (`computer-loop.ts:60`), not
 *     a wrong-device signature.
 *
 * Pin shape: `mac:` stays the label when the platform is macos/absent (legacy
 * callers and existing pinned tests keep their exact bytes); only a run that
 * actually drove Windows says so.
 */

jest.mock('../imessage/imessage.service', () => ({
  listAgents: jest.fn(),
  agentDisplayName: (a: any) => a?.label || a?.deviceName || 'Mac',
  isOnline: jest.fn(() => true),
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
}));
// The loop's steps-0 shapes are pinned below (adversarial review A1), so the
// lock + vision seat must be inert.
jest.mock('./use-lock', () => ({
  acquireComputerUseLock: jest.fn(async () => 'lock-tok'),
  releaseComputerUseLock: jest.fn(async () => undefined),
  recordComputerUseHolder: jest.fn(async () => undefined),
  LOCK_TTL_MARGIN_MS: 120_000,
}));
jest.mock('./vision-client', () => ({
  visionChat: jest.fn(),
  visionConfigured: jest.fn(() => true),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, default: {} }));
jest.mock('../mcp-search', () => ({ callMcpTool: jest.fn(), webToolsDegraded: jest.fn(() => false) }));

import { listAgents } from '../imessage/imessage.service';
import { agentBroker } from '../imessage/agent-link';
import { selectComputerDriver } from './driver';
import { runComputerAgentSession } from './computer-loop';
import { formatComputerTaskToolResult, screenshotCaption } from '../tool-executor';

const mockListAgents = listAgents as jest.Mock;

const row = (over: Record<string, unknown> = {}) => ({
  id: 'agent-1',
  userId: 'user-1',
  label: 'device',
  deviceId: 'device-1',
  deviceName: 'host.local',
  isDefault: false,
  agentVersion: '0.9.10',
  lastSeenAt: new Date(),
  platform: 'macos',
  capabilities: ['computer', 'browser'],
  ...over,
});

/** The reporter's exact fleet shape: a default Mac AND a paired Windows PC,
 *  both online — the configuration in which "the pin was ignored" is possible. */
const INCIDENT_FLEET = () => [
  row({ id: 'agent-mac', label: 'example-tailnet-peer', deviceName: 'mini.local', deviceId: 'device-mac', isDefault: true, platform: 'macos' }),
  row({ id: 'agent-win', label: 'cql-stanne-msi-win', deviceName: 'msi-win.local', deviceId: 'device-win', isDefault: false, platform: 'windows' }),
];

/** The header's Windows availability line, verbatim from
 *  computerAgentStatus() for a capable Windows row (availability.ts:82). */
const WIN_STATUS = 'connected (Windows agent v0.9.10)';
const MAC_STATUS = 'connected (Mac app v0.9.10)';

beforeEach(() => {
  jest.clearAllMocks();
  mockListAgents.mockResolvedValue(INCIDENT_FLEET());
});

describe('DETECTOR-RECALL REPLAY — 2d461d80: the pinned platform is what the header reports', () => {
  it('CONTROL (refutes "the pin is ignored"): an explicit Windows pin with a Mac also paired drives the WINDOWS row', async () => {
    const sel = await selectComputerDriver('user-1', 'cql-stanne-msi-win', 'Open Discord on cql-stanne-msi-win');
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe('agent-win');
    expect(sel.device).toBe('cql-stanne-msi-win');
    expect(sel.platform).toBe('windows');
  });

  it('REPLAYS the defect: a Windows-pinned result header says `win:`, never `mac:`', () => {
    const header = formatComputerTaskToolResult({
      finalResponse: 'I opened Discord.',
      elapsed: 1000,
      steps: 12,
      localStatus: WIN_STATUS,
      device: 'cql-stanne-msi-win',
      platform: 'windows',
    } as any);
    // The exact wrong bytes the reporter quoted.
    expect(header).not.toContain('mac:');
    expect(header).toContain(` · win: ${WIN_STATUS}`);
    expect(header).toContain('device: cql-stanne-msi-win');
  });

  it('a macOS run keeps the historical `mac:` label byte-for-byte (no collateral change)', () => {
    const header = formatComputerTaskToolResult({
      finalResponse: 'done',
      elapsed: 1,
      steps: 3,
      localStatus: MAC_STATUS,
      device: 'example-tailnet-peer',
      platform: 'macos',
    } as any);
    expect(header).toContain(` · mac: ${MAC_STATUS}`);
  });

  it('a legacy result shape with NO platform still says `mac:` (back-compat, pinned)', () => {
    const header = formatComputerTaskToolResult({
      finalResponse: 'done',
      elapsed: 1,
      steps: 3,
      localStatus: MAC_STATUS,
    } as any);
    expect(header).toContain(` · mac: ${MAC_STATUS}`);
  });

  it('the header names NO platform label when there is no availability line (steps-0 shapes)', () => {
    const header = formatComputerTaskToolResult({
      finalResponse: 'no device',
      elapsed: 1,
      steps: 0,
      capabilityNotice: 'no paired device matches it',
    } as any);
    expect(header).not.toContain('· win:');
    expect(header).not.toContain('· mac:');
    expect(header).toContain('[COMPUTER_TASK — UNAVAILABLE]');
  });

  it('REPLAYS the caption defect: a Windows capture is captioned "Your PC", a Mac one "Your Mac"', () => {
    expect(screenshotCaption('computer', { app: 'Discord', platform: 'windows' })).toBe('Final screen · Your PC · Discord');
    expect(screenshotCaption('computer', { app: 'Discord', platform: 'macos' })).toBe('Final screen · Your Mac · Discord');
    // No platform (legacy caller) keeps the historical caption exactly.
    expect(screenshotCaption('computer', { app: 'Discord' })).toBe('Final screen · Your Mac · Discord');
  });

  it('REPLAYS the silent substitution: a PRESENT-but-BLANK pin REFUSES instead of quietly driving the default Mac', async () => {
    for (const blank of ['', '   ', '\t\n']) {
      const sel = await selectComputerDriver('user-1', blank, 'Open Discord');
      expect(sel.driver).toBeNull();
      expect(sel.agentId).toBeNull();
      expect(sel.device).toBeNull();
      expect(sel.status).toContain('was set but empty');
      // The refusal must name the alternatives so the caller can retry correctly.
      expect(sel.status).toContain("'example-tailnet-peer'");
      expect(sel.status).toContain("'cql-stanne-msi-win'");
    }
  });

  it('an OMITTED pin is still the historical default pick (the blank guard must not change it)', async () => {
    const sel = await selectComputerDriver('user-1', undefined, 'Open Discord');
    expect(sel.driver).not.toBeNull();
    expect(sel.agentId).toBe('agent-mac'); // the default Mac, as always
    expect(sel.platform).toBe('macos');
  });

  it('an UNMATCHED pin still REFUSES with the paired list — never a silent Mac fallback', async () => {
    const sel = await selectComputerDriver('user-1', 'no-such-box', 'Open Discord');
    expect(sel.driver).toBeNull();
    expect(sel.status).toContain("no paired device matches 'no-such-box'");
    expect(sel.status).toContain("'cql-stanne-msi-win'");
  });
});

describe('DETECTOR-RECALL REPLAY — 2d461d80 (adversarial review A1): the steps-0 shapes carry the platform too', () => {
  // The reviewer's A1 finding: the first-screenshot throw and the
  // first-screenshot `!ok` returns did NOT spread selectionDeviceFlags(), so a
  // genuinely reachable Windows path (UIPI / missing capture grant) still
  // rendered ` · mac: connected (Windows agent v0.9.10)` — the incident's exact
  // bytes. Main behaved the same way (so it was never a regression), but a
  // close claiming the class fixed must cover them.
  const mockDispatch = agentBroker.dispatch as jest.Mock;

  beforeEach(() => { mockDispatch.mockReset(); });

  it('the first-screenshot !ok shape on a Windows pin reports platform=windows (so the header cannot say `mac:`)', async () => {
    mockDispatch.mockResolvedValue({ ok: false, error: 'UIPI: the window is elevated' });
    const result = await runComputerAgentSession({
      userId: 'user-1',
      chatId: null,
      message: 'Open Discord',
      device: 'cql-stanne-msi-win',
      sendEvent: () => {},
    });
    expect(result.steps).toBe(0);
    expect(result.capabilityNotice).toContain('Windows PC');
    expect(result.platform).toBe('windows');

    // End-to-end: the formatter must render `win:`, never the incident bytes.
    const header = formatComputerTaskToolResult(result);
    expect(header).not.toContain('mac:');
    expect(header).toContain(` · win: ${WIN_STATUS}`);
  });

  it('the first-screenshot THROW shape on a Windows pin reports platform=windows too', async () => {
    mockDispatch.mockRejectedValue(new Error('broker timeout'));
    const result = await runComputerAgentSession({
      userId: 'user-1',
      chatId: null,
      message: 'Open Discord',
      device: 'cql-stanne-msi-win',
      sendEvent: () => {},
    });
    expect(result.steps).toBe(0);
    expect(result.platform).toBe('windows');
    const header = formatComputerTaskToolResult(result);
    expect(header).not.toContain('mac:');
    expect(header).toContain(` · win: ${WIN_STATUS}`);
  });
});