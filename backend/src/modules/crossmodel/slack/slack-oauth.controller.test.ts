/**
 * slack-oauth.controller startAuth — ticket 8cb3aa34 (Mac desktop white screen).
 *
 * Pins the 2026-09-12 contract:
 *  1. An UNAUTHENTICATED navigation to /slack/auth redirects to the real
 *     integrations UI with slack=auth_required — never a bare 401 JSON body,
 *     which rendered as a white page with no way back inside the Mac app's
 *     chromeless WKWebView.
 *  2. desktop=1 (the frontend appends it when window.__digbyDesktop is set)
 *     renders a handoff interstitial with a REAL <a> link to the Slack consent
 *     URL — a real link click is the only navigation type the Mac webview
 *     hands to the system browser (.linkActivated + non-whitelisted host) —
 *     plus a whitelisted "Back to Digby" link. No 302 (a redirect would load
 *     slack.com INSIDE the webview and dead-end).
 *  3. The classic browser flow (no desktop param) still 302s to slack.com,
 *     and the missing-env redirect to slack=not_configured is unchanged.
 */

jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { setEx: jest.fn().mockResolvedValue('OK'), get: jest.fn(), del: jest.fn() },
}));
jest.mock('axios');
jest.mock('../google/crypto', () => ({ encryptWith: jest.fn() }));
jest.mock('../langgraph/integration-status-cache', () => ({ invalidateIntegrationStatusCache: jest.fn() }));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import axios from 'axios';
import controller from './slack-oauth.controller';
import logger from '../../../utils/logger';
import redisClient from '../../../config/redis';

function mockRes() {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.redirect = jest.fn().mockReturnValue(res);
  res.type = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.set = jest.fn().mockReturnValue(res);
  return res;
}

const ENV = {
  SLACK_CLIENT_ID: 'cid-123',
  SLACK_CLIENT_SECRET: 'test-secret',
  SLACK_OAUTH_REDIRECT_URI: 'https://digby.example.com/api/crossmodel/slack/callback',
  FRONTEND_URL: 'https://digby.example.com',
};

describe('SlackOAuthController.startAuth (ticket 8cb3aa34)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, ENV);
    jest.clearAllMocks();
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  it('unauthenticated → redirect to the integrations UI with slack=auth_required (never a bare 401 JSON white page)', async () => {
    const res = mockRes();
    const next = jest.fn();
    await controller.startAuth({ user: undefined, query: {} } as any, res, next);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith(
      'https://digby.example.com/account?tab=integrations&slack=auth_required',
    );
  });

  it('missing Slack env → slack=not_configured redirect (pre-existing behavior unchanged)', async () => {
    delete process.env.SLACK_CLIENT_ID;
    delete process.env.SLACK_CLIENT_SECRET;
    const res = mockRes();
    const next = jest.fn();
    await controller.startAuth({ user: { id: 'u1' }, query: {} } as any, res, next);
    expect(res.redirect).toHaveBeenCalledWith(
      'https://digby.example.com/account?tab=integrations&slack=not_configured',
    );
  });

  it('browser client (no desktop param) → classic 302 to the Slack consent URL with server-stored single-use state', async () => {
    const res = mockRes();
    const next = jest.fn();
    await controller.startAuth({ user: { id: 'u1' }, query: {} } as any, res, next);
    expect(redisClient.setEx).toHaveBeenCalledWith(expect.stringMatching(/^slack_oauth_state:/), 300, 'u1');
    const url = (res.redirect as jest.Mock).mock.calls[0][0] as string;
    expect(url).toMatch(/^https:\/\/slack\.com\/oauth\/v2\/authorize\?/);
    expect(url).toContain('client_id=cid-123');
    expect(url).toContain('state=');
    expect(res.type).not.toHaveBeenCalled();
    expect(res.send).not.toHaveBeenCalled();
  });

  it('desktop=1 → handoff interstitial HTML with a REAL consent link + whitelisted back link, no 302, no-store', async () => {
    const res = mockRes();
    const next = jest.fn();
    await controller.startAuth({ user: { id: 'u1' }, query: { desktop: '1' } } as any, res, next);
    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(res.type).toHaveBeenCalledWith('html');
    const html = (res.send as jest.Mock).mock.calls[0][0] as string;
    // The consent URL is present as a clickable <a href> — HTML-escaped (& → &amp;).
    expect(html).toContain('href="https://slack.com/oauth/v2/authorize?client_id=cid-123&amp;');
    expect(html).toContain('Continue in your browser');
    // The way back stays on the whitelisted app host.
    expect(html).toContain('href="https://digby.example.com/account?tab=integrations"');
    // State is still stored server-side so the callback exchange works from the system browser.
    expect(redisClient.setEx).toHaveBeenCalledWith(expect.stringMatching(/^slack_oauth_state:/), 300, 'u1');
  });

  it('the interstitial embeds the SAME consent URL a 302 would have used (state included, escaped)', async () => {
    const res = mockRes();
    const next = jest.fn();
    await controller.startAuth({ user: { id: 'u1' }, query: { desktop: '1' } } as any, res, next);
    const html = (res.send as jest.Mock).mock.calls[0][0] as string;
    const m = html.match(/href="(https:\/\/slack\.com\/oauth\/v2\/authorize\?[^"]+)"/);
    expect(m).toBeTruthy();
    const unescaped = m![1].replace(/&amp;/g, '&');
    const parsed = new URL(unescaped);
    expect(parsed.searchParams.get('client_id')).toBe('cid-123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://digby.example.com/api/crossmodel/slack/callback');
    expect(parsed.searchParams.get('state')).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.searchParams.get('user_scope')).toContain('search:read');
  });
});

// ── Ticket 24541fb3: DM/group-DM history scopes ────────────────────────────────
//
// ROOT CAUSE (live-verified 2026-10-12 against the owner's connected token):
// USER_SCOPES requested im:read/mpim:read (LISTING scopes) but never
// im:history/mpim:history — which conversations.history needs to read DM and
// group-DM messages with a user token. Every reconnect faithfully re-granted
// the same DM-blind scope set, so "reconnect to fix it" was a loop, not a fix.
// The auth.test x-oauth-scopes header read exactly USER_SCOPES + identify, and
// conversations.history on a real group-DM answered
// {"ok":false,"error":"missing_scope","needed":"mpim:history",…}.
//
// This block pins the FIX contract:
//  1. The authorize URL (both the 302 and the desktop handoff) requests
//     im:history and mpim:history.
//  2. The user_scope list is comma-joined with no spaces (Slack rejects spaces).
//  3. A token granted WITHOUT the history scopes warns at connect time (it is
//     still saved — Slack grants are additive; a reconnect heals them).
//  4. The Slack OAuth `error` param (invalid_scope, access_denied …) is passed
//     through to the UI (sanitized), instead of being flattened to a generic
//     error — the owner reconnected three times against an error he was never
//     shown.
//  5. /slack/status reports missingScopes so the UI can say WHY DM reads fail.
describe('SlackOAuthController — DM history scopes (ticket 24541fb3)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, ENV);
    jest.clearAllMocks();
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  /** Extract the user_scope list from a 302 redirect target. */
  function userScopeFromRedirect(res: any): string[] {
    const url = (res.redirect as jest.Mock).mock.calls[0][0] as string;
    return String(new URL(url).searchParams.get('user_scope') || '').split(',').filter(Boolean);
  }

  it('requests im:history and mpim:history in the authorize URL (the scopes conversations.history needs for DMs)', async () => {
    const res = mockRes();
    await controller.startAuth({ user: { id: 'u1' }, query: {} } as any, res, jest.fn());
    const scopes = userScopeFromRedirect(res);
    expect(scopes).toContain('im:history');
    expect(scopes).toContain('mpim:history');
    // The listing scopes stay (conversations.list still needs them).
    expect(scopes).toContain('im:read');
    expect(scopes).toContain('mpim:read');
    // And nothing was dropped from the pre-fix contract.
    for (const s of ['channels:read', 'groups:read', 'channels:history', 'groups:history', 'search:read', 'users:read', 'chat:write']) {
      expect(scopes).toContain(s);
    }
    // Slack rejects a scope list with spaces — pins the join(',').
    expect(scopes.every((s: string) => !s.includes(' '))).toBe(true);
  });

  it('the desktop handoff consent URL requests the SAME history scopes (no divergent flows)', async () => {
    const res = mockRes();
    await controller.startAuth({ user: { id: 'u1' }, query: { desktop: '1' } } as any, res, jest.fn());
    const html = (res.send as jest.Mock).mock.calls[0][0] as string;
    const m = html.match(/href="(https:\/\/slack\.com\/oauth\/v2\/authorize\?[^"]+)"/);
    expect(m).toBeTruthy();
    const parsed = new URL(m![1].replace(/&amp;/g, '&'));
    const scopes = String(parsed.searchParams.get('user_scope') || '').split(',').filter(Boolean);
    expect(scopes).toContain('im:history');
    expect(scopes).toContain('mpim:history');
  });

  it('a token granted WITHOUT the history scopes is still saved but logs a warning naming the missing scopes', async () => {
    const prismaMock = (await import('../../../config/database')).default as any;
    prismaMock.slackOAuthToken = { upsert: jest.fn().mockResolvedValue({}) };

    (redisClient.get as jest.Mock).mockResolvedValue('u1');
    (axios.post as jest.Mock).mockResolvedValue({
      data: {
        ok: true,
        team: { id: 'T1', name: 'Old Grant Workspace' },
        // A pre-fix grant: every scope EXCEPT im:history/mpim:history.
        authed_user: {
          id: 'U1',
          scope: 'channels:read,groups:read,channels:history,groups:history,im:read,mpim:read,search:read,users:read,chat:write',
          access_token: 'dummy-old-grant-token',
          token_type: 'user',
        },
      },
    });

    const res = mockRes();
    await controller.handleCallback(
      { query: { code: 'c-code', state: 's-state' } } as any,
      res,
      jest.fn(),
    );

    // The connection still saves (additive reconnect heals it).
    expect(prismaMock.slackOAuthToken.upsert).toHaveBeenCalledTimes(1);
    // And the degradation is named in the logs.
    const warned = (logger.warn as jest.Mock).mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(warned).toContain('im:history');
    expect(warned).toContain('mpim:history');
    expect(res.redirect).toHaveBeenCalledWith(
      'https://digby.example.com/account?tab=integrations&slack=connected',
    );
  });

  it('a FULL grant (history scopes included) connects without the missing-scope warning', async () => {
    const prismaMock = (await import('../../../config/database')).default as any;
    prismaMock.slackOAuthToken = { upsert: jest.fn().mockResolvedValue({}) };

    (redisClient.get as jest.Mock).mockResolvedValue('u1');
    (axios.post as jest.Mock).mockResolvedValue({
      data: {
        ok: true,
        team: { id: 'T1', name: 'Healed Workspace' },
        authed_user: {
          id: 'U1',
          scope: 'im:history,mpim:history,im:read,mpim:read,channels:read,groups:read,channels:history,groups:history,search:read,users:read,chat:write,identify',
          access_token: 'dummy-full-grant-token',
          token_type: 'user',
        },
      },
    });

    const res = mockRes();
    await controller.handleCallback(
      { query: { code: 'c-code', state: 's-state' } } as any,
      res,
      jest.fn(),
    );

    expect(prismaMock.slackOAuthToken.upsert).toHaveBeenCalledTimes(1);
    const warned = (logger.warn as jest.Mock).mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
    expect(warned).not.toContain('im:history');
    expect(res.redirect).toHaveBeenCalledWith(
      'https://digby.example.com/account?tab=integrations&slack=connected',
    );
  });

  it('a Slack OAuth error (invalid_scope) is passed through to the UI sanitized — not flattened to a generic error', async () => {
    const res = mockRes();
    await controller.handleCallback(
      { query: { error: 'invalid_scope', state: 's' } } as any,
      res,
      jest.fn(),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'https://digby.example.com/account?tab=integrations&slack=error&reason=invalid_scope',
    );
  });

  it('a hostile error param is sanitized before it reaches the redirect URL', async () => {
    const res = mockRes();
    await controller.handleCallback(
      { query: { error: 'x"><script>alert(1)</script>', state: 's' } } as any,
      res,
      jest.fn(),
    );
    const target = (res.redirect as jest.Mock).mock.calls[0][0] as string;
    expect(target).not.toContain('<script');
    expect(target).toContain('reason=error');
  });

  it('status reports missingScopes for a stored token that lacks the history scopes (and [] once healed)', async () => {
    const prismaMock = (await import('../../../config/database')).default as any;
    const res = mockRes();

    prismaMock.slackOAuthToken = {
      findFirst: jest.fn()
        .mockResolvedValueOnce({ teamName: 'Blind Workspace', label: 'Blind Workspace', scopes: ['im:read', 'mpim:read', 'channels:history'], createdAt: new Date() })
        .mockResolvedValueOnce({ teamName: 'Healed', label: 'Healed', scopes: ['im:read', 'mpim:read', 'im:history', 'mpim:history'], createdAt: new Date() }),
    };

    await controller.getStatus({ user: { id: 'u1' } } as any, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ connected: true, missingScopes: ['im:history', 'mpim:history'] }),
    }));

    await controller.getStatus({ user: { id: 'u1' } } as any, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ connected: true, missingScopes: [] }),
    }));
  });
});
