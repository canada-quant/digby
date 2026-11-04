// coding/agent.ts (systemPrompt) pulls config/env, logger, prisma, redis and the
// MCP clients at import — the standard agent-test mock set (agent-answer-first-split.test.ts).
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../middleware/error-handler', () => ({ __esModule: true, AppError: class AppError extends Error {} }));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/env', () => ({ __esModule: true, env: { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), JWT_REFRESH_SECRET: 'y'.repeat(32) } }));
jest.mock('../../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), set: jest.fn(), del: jest.fn() }, redisSubscriber: { subscribe: jest.fn(), on: jest.fn() } }));
jest.mock('../github/github-mcp', () => ({ __esModule: true, isGitHubMcpConfigured: jest.fn(() => false), callGitHubMcpTool: jest.fn() }));
jest.mock('../google/google-mcp', () => ({ __esModule: true, isGoogleMcpConfigured: jest.fn(() => false), callGoogleMcpTool: jest.fn() }));
jest.mock('../imessage/agent-link', () => ({ agentBroker: { dispatch: jest.fn() } }));
const store = new Map<string, unknown>();
jest.mock('../memory/context-store', () => ({
  storeGet: jest.fn(async (ns: string[], key: string) => store.get(`${ns.join('/')}::${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: unknown) => { store.set(`${ns.join('/')}::${key}`, value); }),
  storeDelete: jest.fn(async (ns: string[], key: string) => { store.delete(`${ns.join('/')}::${key}`); }),
}));

import {
  clearFleetNotice,
  fleetNoticeActive,
  fleetNoticeBlockFor,
  FLEET_NOTICE_MAX_CHARS,
  getFleetNotice,
  renderFleetNoticeBlock,
  resetFleetNoticeCache,
  setFleetNotice,
} from './fleet-notice';
import { systemPrompt } from '../coding/agent';

const NOW = Date.parse('2026-10-12T08:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => { store.clear(); resetFleetNoticeCache(); delete process.env.FLEET_NOTICE_DISABLED; });

describe('setFleetNotice', () => {
  it('stores the text with a 30-day default expiry and renders it as the owner block', async () => {
    const r = await setFleetNotice('u1', { text: '  CQL-Public is retired — never SSH to it.  ' }, { now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notice.text).toBe('CQL-Public is retired — never SSH to it.');
    expect(Date.parse(r.notice.expiresAt) - NOW).toBe(30 * DAY);
    const block = renderFleetNoticeBlock(r.notice, NOW);
    expect(block).toContain('OWNER FLEET NOTICE (set 2026-10-12, in force until 2026-11-11)');
    expect(block).toContain('THIS notice wins');
    expect(block).toContain('CQL-Public is retired — never SSH to it.');
  });

  it('redacts secret-shaped values before storing (the block goes to every model provider)', async () => {
    const key = 'sk-' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6';
    const r = await setFleetNotice('u1', { text: `New DeepSeek key is ${key} — use it.` }, { now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.notice.text).not.toContain(key);
    expect(r.redacted.length).toBeGreaterThan(0);
  });

  it('refuses empty text, oversize text, past and too-distant expiries', async () => {
    expect((await setFleetNotice('u1', { text: '   ' }, { now: () => NOW })).ok).toBe(false);
    expect((await setFleetNotice('u1', { text: 'x'.repeat(FLEET_NOTICE_MAX_CHARS + 1) }, { now: () => NOW })).ok).toBe(false);
    expect((await setFleetNotice('u1', { text: 'x', expiresAt: '2026-10-01T00:00:00Z' }, { now: () => NOW })).ok).toBe(false);
    expect((await setFleetNotice('u1', { text: 'x', days: 91 }, { now: () => NOW })).ok).toBe(false);
    expect((await setFleetNotice('u1', { text: 'x', days: 0 }, { now: () => NOW })).ok).toBe(false);
    expect((await setFleetNotice('u1', { text: 'x', expiresAt: 'not a date' }, { now: () => NOW })).ok).toBe(false);
    expect(store.size).toBe(0);
  });

  it('accepts an explicit expiry within 90 days', async () => {
    const r = await setFleetNotice('u1', { text: 'x', expiresAt: '2026-12-01T00:00:00Z' }, { now: () => NOW });
    expect(r.ok && r.notice.expiresAt).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('reading and rendering', () => {
  it('is per user — another user sees nothing', async () => {
    await setFleetNotice('owner', { text: 'owner-only facts' });
    expect(await fleetNoticeBlockFor('someone-else')).toBe('');
    expect(await fleetNoticeBlockFor('owner')).toContain('owner-only facts');
    expect(await fleetNoticeBlockFor(null)).toBe('');
  });

  it('an expired notice renders nothing (but stays stored)', async () => {
    const r = await setFleetNotice('u1', { text: 'old news', days: 1 }, { now: () => NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fleetNoticeActive(r.notice, NOW + 2 * DAY)).toBe(false);
    expect(renderFleetNoticeBlock(r.notice, NOW + 2 * DAY)).toBe('');
    expect(await getFleetNotice('u1', { fresh: true })).not.toBeNull();
  });

  it('FLEET_NOTICE_DISABLED=1 injects nothing', async () => {
    await setFleetNotice('u1', { text: 'facts' });
    process.env.FLEET_NOTICE_DISABLED = '1';
    expect(await fleetNoticeBlockFor('u1')).toBe('');
  });

  it('clear removes it', async () => {
    await setFleetNotice('u1', { text: 'facts' });
    await clearFleetNotice('u1');
    expect(await fleetNoticeBlockFor('u1')).toBe('');
  });
});

describe('coding lane system prompt', () => {
  const input = (fleetNotice?: string) => ({
    worktree: '/w', sessionId: 's', projectId: 'p', userId: 'u', permissionMode: 'auto', projectName: 'Proj', branch: 'b',
    ...(fleetNotice ? { fleetNotice } : {}),
  }) as any;

  it('carries the notice ahead of the repo context, and nothing when there is none', () => {
    const block = '═══ OWNER FLEET NOTICE (set 2026-10-12, in force until 2026-11-11) ═══\nfacts\n═══════════════════';
    const withNotice = systemPrompt(input(block), 'REPO-CONTEXT', '', '', 'DATE');
    expect(withNotice).toContain(block);
    expect(withNotice.indexOf(block)).toBeLessThan(withNotice.indexOf('REPO-CONTEXT'));
    const without = systemPrompt(input(), 'REPO-CONTEXT', '', '', 'DATE');
    expect(without).not.toContain('OWNER FLEET NOTICE');
  });

  it('the Safety section carries the dependency + public-host rules', () => {
    const p = systemPrompt(input(), '', '', '', '');
    expect(p).toContain('**Dependency security:**');
    expect(p).toContain('a public app must never share such a host');
    expect(p).toContain('Never copy cloud or admin credentials from your environment onto a server');
  });
});
