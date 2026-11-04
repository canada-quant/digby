/**
 * integration-error — the shared failure text every connector client returns
 * (2026-10-04). Pure leaf: no mocks needed.
 */
import {
  INTEGRATION_SERVICES, IntegrationApiError, integrationErrorText, classifyUpstreamErrorText,
  kindFromHttpStatus, clipErrorDetail, connectorTransportError, mcpOperationLabel, stripErrorPrefix,
  isErrorShapedText, surfacedOrEmpty, integrationErrorSurfaceDisabled,
} from './integration-error';
import { xeroApiErrorText } from '../xero/xero-mcp';

jest.mock('../xero/token-manager', () => ({ getValidToken: jest.fn(), listXeroAccounts: jest.fn(), accountMatchesLabel: jest.fn(), xeroAccountDisplayName: jest.fn() }));
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

describe('integrationErrorText', () => {
  const slack = INTEGRATION_SERVICES.slack;

  it('auth names the exact reconnect path; with and without an HTTP status', () => {
    expect(integrationErrorText(slack, 'search messages call', 'auth', null, 'invalid_auth'))
      .toBe('Slack search messages call was rejected by Slack (invalid_auth) — the Slack connection needs re-authorizing: Account → Integrations → Slack → reconnect.');
    expect(integrationErrorText(INTEGRATION_SERVICES.plaid, 'balance read for Chase', 'auth', 400, 'ITEM_LOGIN_REQUIRED'))
      .toContain('(HTTP 400: ITEM_LOGIN_REQUIRED) — the Plaid connection needs re-authorizing: Account → Integrations → Plaid Banking → link the bank again.');
  });

  it('gateway and not_configured say reconnecting will NOT help', () => {
    expect(integrationErrorText(slack, 'x call', 'gateway', null, 'HTTP 502')).toContain('reconnecting will not help');
    expect(integrationErrorText(slack, 'x call', 'not_configured', null, 'SLACK_MCP_API_KEY unset')).toContain('reconnecting will not help');
  });

  it('the Xero shape is byte-identical through the shared mapping (xeroApiErrorText delegates)', () => {
    expect(xeroApiErrorText('/Organisation', 401, 'AuthenticationUnsuccessful'))
      .toBe('Xero Organisation was rejected by Xero (HTTP 401: AuthenticationUnsuccessful) — the Xero connection needs re-authorizing: Account → Integrations → Xero → reconnect.');
    expect(xeroApiErrorText('/Contacts', null, '')).toBe('Xero Contacts could not be called: the Xero connection has no valid token (refresh failed) — the user should reconnect Xero in Account → Integrations.');
    expect(xeroApiErrorText('/Contacts', 0, 'xero down')).toBe('Xero Contacts could not reach Xero (network error: xero down) — try again shortly.');
    expect(xeroApiErrorText('/Invoices', 429, 'slow down')).toBe('Xero Invoices was rate-limited by Xero (HTTP 429) — try again in a minute.');
    expect(xeroApiErrorText('/Invoices', 503, 'x')).toBe("Xero Invoices failed on Xero's side (HTTP 503) — Xero is unavailable right now; try again later.");
    expect(xeroApiErrorText('/Invoices', 400, 'bad where')).toBe('Xero Invoices failed (HTTP 400: bad where).');
    expect(xeroApiErrorText('/Invoices', 400, '')).toBe('Xero Invoices failed (HTTP 400).');
  });
});

describe('classifyUpstreamErrorText', () => {
  it.each([
    ['An API error occurred: invalid_auth', 'auth'],
    ['An API error occurred: token_revoked', 'auth'],
    ['Bad credentials', 'auth'],
    ['Not Authorized', 'auth'],
    ['Request had insufficient authentication scopes.', 'auth'],
    ['invalid_grant', 'auth'],
    ['API rate limit exceeded for user ID 1 (HTTP 403)', 'rate_limited'],
    ['A rate limit was exceeded', 'rate_limited'],
    ["Quota exceeded for quota metric 'Queries'", 'rate_limited'],
    ['Backend Error', 'down'],
    ['An HTTP protocol error occurred: statusCode = 503', 'down'],
    ['Request failed with status code 500', 'down'],
  ])('%s → %s', (text, kind) => {
    expect(classifyUpstreamErrorText(text)).toBe(kind);
  });

  it.each([
    'Requested entity was not found.',
    'The caller does not have permission',
    'An API error occurred: channel_not_found',
    'Not Found',
    'Invoice 401 is overdue',
  ])('leaves %s unclassified (per-resource / not-found keep today\'s behaviour)', (text) => {
    expect(classifyUpstreamErrorText(text)).toBeNull();
  });
});

describe('helpers', () => {
  it('kindFromHttpStatus', () => {
    expect([0, 401, 403, 429, 500, 503, 400, 404, null].map(kindFromHttpStatus))
      .toEqual(['network', 'auth', 'auth', 'rate_limited', 'down', 'down', 'other', 'other', 'other']);
  });

  it('clipErrorDetail keeps ONE line, ≤120 chars, never a credential', () => {
    const d = clipErrorDetail('Authorization: Bearer abc.def-123\nfailed for https://x-access-token:ghs_secret@github.com token xoxp-1234-5678 ghp_abcdefghij');
    expect(d).not.toMatch(/\n/);
    expect(d).not.toContain('abc.def-123');
    expect(d).not.toContain('ghs_secret');
    expect(d).not.toContain('xoxp-1234');
    expect(clipErrorDetail('x'.repeat(500))).toHaveLength(120);
  });

  it('connectorTransportError: container status / network code / stream text are all gateway', () => {
    const svc = INTEGRATION_SERVICES.asana;
    expect(connectorTransportError(svc, 'op', { response: { status: 401 } }).message).toContain("refused Digby's service key");
    expect(connectorTransportError(svc, 'op', { code: 'ECONNREFUSED' }).message).toContain('(network error: ECONNREFUSED)');
    expect(connectorTransportError(svc, 'op', new Error('Asana MCP x timed out')).kind).toBe('gateway');
    const passthrough = new IntegrationApiError(svc, 'op', 'auth', null, 'Not Authorized');
    expect(connectorTransportError(svc, 'op', passthrough)).toBe(passthrough);
  });

  it('operation labels, error-shaped text, prefix stripping, the catch helper and the switch', () => {
    expect(mcpOperationLabel('slack_search_messages', 'slack_')).toBe('search messages call');
    expect(isErrorShapedText('Error listing projects: Not Authorized')).toBe(true);
    expect(isErrorShapedText('No projects found.')).toBe(false);
    expect(stripErrorPrefix('Error slackListChannels: An API error occurred: invalid_auth')).toBe('An API error occurred: invalid_auth');
    expect(stripErrorPrefix('Error: Backend Error')).toBe('Backend Error');
    expect(surfacedOrEmpty(new Error('plain'))).toBe('');
    expect(surfacedOrEmpty(new IntegrationApiError(INTEGRATION_SERVICES.github, 'op', 'down', 503, ''))).toContain("GitHub's side");
    process.env.INTEGRATION_ERROR_SURFACE_DISABLED = '1';
    try { expect(integrationErrorSurfaceDisabled()).toBe(true); } finally { delete process.env.INTEGRATION_ERROR_SURFACE_DISABLED; }
    expect(integrationErrorSurfaceDisabled()).toBe(false);
  });
});
