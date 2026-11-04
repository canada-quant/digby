/** Ticket e6b16c4e — LocalBrowserDriver defensive content clip + the broker
 *  error the driver surfaces when the device is gone.
 *
 *  The incident: a browser_task on a Windows agent that died mid-task returned
 *  page content verbatim (a degenerate slider-CAPTCHA interstitial) and a
 *  mislabeled "iMessage agent did not respond within 45000ms" error. The agent
 *  sides (mac/win browser.ts) and CloudBrowserDriver all cap content at 8k —
 *  this driver trusted the wire. The clip here is defense in depth.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDispatch = jest.fn();
jest.mock('../imessage/agent-link', () => ({
  __esModule: true,
  agentBroker: { dispatch: (...a: any[]) => mockDispatch(...a) },
  agentVersionAtLeast: (version: string | null | undefined, min: string) => {
    if (!version) return false;
    const a = String(version).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(min).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true;
  },
}));

import { LocalBrowserDriver } from './local-driver';

beforeEach(() => jest.clearAllMocks());

const NAVIGATE = { name: 'navigate' as const, url: 'https://example.com' };

describe('LocalBrowserDriver content cap (e6b16c4e)', () => {
  it('passes agent content under the cap through unchanged', async () => {
    mockDispatch.mockResolvedValue({ ok: true, url: 'https://example.com', content: 'a'.repeat(7999) });
    const obs = await new LocalBrowserDriver('agent-1', '0.5.0').execute(NAVIGATE);
    expect(obs.content).toBe('a'.repeat(7999));
    expect(obs.truncated).toBeFalsy();
  });

  it('clips an oversized payload to 8k + marker and stamps truncated', async () => {
    // The incident's shape class: an interstitial page whose "content" is a
    // wall of filler markup far past any sane page-text budget.
    const wall = Array(3000).fill('<div>（拖拽）（拖拽）（拖拽）</div>').join('');
    expect(wall.length).toBeGreaterThan(8000);
    mockDispatch.mockResolvedValue({ ok: true, url: 'https://example.com', content: wall });
    const obs = await new LocalBrowserDriver('agent-1', '0.9.0').execute(NAVIGATE);
    expect(obs.content!.length).toBeLessThanOrEqual(8000 + '\n…[truncated]'.length);
    expect(obs.content!.endsWith('\n…[truncated]')).toBe(true);
    expect(obs.truncated).toBe(true);
  });

  it('preserves the agent-side truncated flag for in-cap content', async () => {
    mockDispatch.mockResolvedValue({ ok: true, url: 'https://example.com', content: 'short page', truncated: true });
    const obs = await new LocalBrowserDriver('agent-1', '0.5.0').execute(NAVIGATE);
    expect(obs.content).toBe('short page');
    expect(obs.truncated).toBe(true);
  });

  it('a dispatch timeout surfaces the surface-correct error text', async () => {
    // The driver catches the broker error into the observation; the broker's
    // wording is covered by agent-link.surface.e6b16c4e.test.ts — here we pin
    // that the message reaches the observation verbatim (this is the exact
    // string the incident's tool result showed, mislabeled).
    mockDispatch.mockRejectedValue(new Error('browser agent did not respond within 45000ms'));
    const obs = await new LocalBrowserDriver('win-agent', '0.9.0').execute(NAVIGATE);
    expect(obs.ok).toBe(false);
    expect(obs.error).toBe('browser agent did not respond within 45000ms');
    expect(obs.error).not.toContain('iMessage');
  });
});
