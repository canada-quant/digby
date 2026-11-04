/**
 * User-added MCP servers (ticket e294f9a4) — the SSRF boundary: a user's MCP
 * URL is fetched from the backend, so private / internal targets are refused
 * up front AND at connect time (DNS answers re-checked by guardedLookup).
 */

import dns from 'dns';
import {
  assertUserMcpUrl, guardedLookup, isBlockedMcpAddress, isBlockedMcpHostname, McpUrlError, redactMcpUrl,
} from './url-guard';

const ENV = { ...process.env };
afterEach(() => { process.env = { ...ENV }; jest.restoreAllMocks(); });

describe('isBlockedMcpAddress', () => {
  it.each([
    '127.0.0.1', '10.0.0.22', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.99.3.52',
    '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.0.8', '198.18.0.1', '::1', '::', 'fd00::1', 'fe80::1', 'ff02::1',
    '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '[::1]',
  ])('blocks %s', (ip) => expect(isBlockedMcpAddress(ip)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'allows public %s', (ip) => expect(isBlockedMcpAddress(ip)).toBe(false),
  );
});

describe('isBlockedMcpHostname', () => {
  it.each(['localhost', 'api.localhost', 'printer.local', 'metadata.google.internal', 'svc.internal', 'router.lan', 'slack-mcp-prod', 'redis', ''])(
    'blocks %p', (h) => expect(isBlockedMcpHostname(h)).toBe(true),
  );
  it.each(['mcp.linear.app', 'api.githubcopilot.com', 'huggingface.co'])('allows %s', (h) => expect(isBlockedMcpHostname(h)).toBe(false));
});

describe('assertUserMcpUrl', () => {
  it('accepts a public https URL', () => {
    expect(assertUserMcpUrl(' https://mcp.linear.app/mcp ').toString()).toBe('https://mcp.linear.app/mcp');
  });
  it.each([
    ['', /required/],
    ['not a url', /not a valid URL/],
    ['http://mcp.linear.app/mcp', /https/],
    ['ftp://x.example.com', /scheme/],
    ['https://user:pass@mcp.example.com/mcp', /credentials/],
    ['https://127.0.0.1/mcp', /private/],
    ['https://169.254.169.254/latest/meta-data', /private/],
    ['https://[::1]/mcp', /private/],
    ['https://localhost:4001/api', /local/],
    ['https://slack-mcp-prod:8000/mcp', /local/],
  ])('refuses %p', (url, re) => {
    expect(() => assertUserMcpUrl(url)).toThrow(McpUrlError);
    expect(() => assertUserMcpUrl(url)).toThrow(re);
  });
  it('USER_MCP_ALLOW_HTTP / USER_MCP_ALLOW_PRIVATE_HOSTS lift their rule (edge instances on a LAN)', () => {
    process.env.USER_MCP_ALLOW_HTTP = '1';
    expect(assertUserMcpUrl('http://mcp.example.com/mcp').protocol).toBe('http:');
    expect(() => assertUserMcpUrl('http://10.0.0.5/mcp')).toThrow(/private/);
    process.env.USER_MCP_ALLOW_PRIVATE_HOSTS = '1';
    expect(assertUserMcpUrl('http://10.0.0.5/mcp').hostname).toBe('10.0.0.5');
  });
});

describe('guardedLookup (connect-time DNS check — rebinding safe)', () => {
  const lookupReturning = (addresses: Array<{ address: string; family: number }>) =>
    jest.spyOn(dns, 'lookup').mockImplementation(((_h: string, _o: any, cb: any) => cb(null, addresses)) as any);

  it('refuses a host whose answer contains ANY private address', (done) => {
    lookupReturning([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.7', family: 4 }]);
    guardedLookup('rebind.example.com', {}, (err) => {
      expect(err).toBeTruthy();
      expect((err as any).code).toBe('EMCPBLOCKED');
      done();
    });
  });

  it('answers the single-address shape and the all:true shape for public hosts', (done) => {
    lookupReturning([{ address: '93.184.216.34', family: 4 }]);
    guardedLookup('example.com', {}, (err, address, family) => {
      expect(err).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
      guardedLookup('example.com', { all: true }, (err2, list) => {
        expect(err2).toBeNull();
        expect(list).toEqual([{ address: '93.184.216.34', family: 4 }]);
        done();
      });
    });
  });

  it('USER_MCP_ALLOW_PRIVATE_HOSTS=1 lets a private answer through', (done) => {
    process.env.USER_MCP_ALLOW_PRIVATE_HOSTS = '1';
    lookupReturning([{ address: '192.168.0.2', family: 4 }]);
    guardedLookup('nas.example.com', {}, (err, address) => {
      expect(err).toBeNull();
      expect(address).toBe('192.168.0.2');
      done();
    });
  });
});

describe('redactMcpUrl', () => {
  it('masks a token-looking path segment and every query value, keeps readable paths', () => {
    expect(redactMcpUrl('https://mcp.zapier.com/api/mcp/s/ZjA1N2Q4YjItMTk3My00YzNhLWE2YzEtYjM3ZDg5/mcp')).toBe('https://mcp.zapier.com/api/mcp/s/••••/mcp');
    expect(redactMcpUrl('https://mcp.supabase.com/mcp?project_ref=abc&read_only=true')).toBe('https://mcp.supabase.com/mcp?project_ref=••••&read_only=••••');
    expect(redactMcpUrl('https://mcp.linear.app/mcp')).toBe('https://mcp.linear.app/mcp');
    expect(redactMcpUrl('https://docs.mcp.cloudflare.com/model-context-protocol/mcp')).toBe('https://docs.mcp.cloudflare.com/model-context-protocol/mcp');
    expect(redactMcpUrl('garbage')).toBe('');
  });
});
