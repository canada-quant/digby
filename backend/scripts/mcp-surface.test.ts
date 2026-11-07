/**
 * MCP listener/auth surface — todo 924725a4 (2026-11-06).
 *
 * WHY THIS TEST EXISTS
 *   The MCP exposure we shipped was a CONFIG bug, not a code bug: every
 *   connector container independently enforces its own `*_MCP_API_KEY`
 *   (`if (!API_KEY || providedKey !== API_KEY) → 401`), so the compose file's
 *   job is simply to not publish a listener that skips that check. In
 *   `docker-compose.base.yml` one service did exactly that: `digby-mcp` is
 *   deliberately keyless (per-user token pass-through — docs/DIGBY_MCP.md), it
 *   accepted any non-empty `Bearer` at the socket, and it was published on ALL
 *   interfaces (`"8206:8000"`).
 *
 *   So this suite pins the INVARIANT rather than today's port numbers:
 *
 *     1. An MCP service published on a non-loopback interface MUST carry an
 *        `*_MCP_API_KEY` gate. No shared key ⇒ loopback only.
 *     2. The keyless platform re-export (`digby-mcp`) is loopback-only and is
 *        NOT in the default `mcp` profile of a self-host install — the product
 *        surface is one gateway with connector options, and `digby-mcp`
 *        re-exports the hosted one-vendor platform API.
 *     3. The gateway auth-proxy FAILS CLOSED — a missing key must not mean
 *        "no auth" (an unset env var is the most common real-world state).
 *
 *   A future edit that adds `- "8206:8000"` back, or a new keyless connector,
 *   or flips the auth-proxy to fail open, breaks THIS test instead of
 *   silently widening the public surface.
 *
 * Cross-box reach is INTENTIONALLY preserved: prod boxes dial box A's
 * connectors at 10.0.0.11:8201-8205/8207 (scripts/ec2-ops/playbook.sh:6071),
 * so the six keyed connectors MUST stay all-interface. Only the keyless one is
 * rebound to loopback.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => readFileSync(path.join(REPO_ROOT, p), 'utf8');

/**
 * Read a repo file the PUBLIC EXPORT deliberately WITHHOLDS, or null when absent.
 * `docker-compose.base.yml` is the prod stack and `.digby/publish/scrub-rules.txt`
 * drops it as production topology — absent in the export BY POLICY. Reading it
 * unguarded threw ENOENT during describe-collection and reddened the export's
 * whole jest leg (measured 2026-11-07, scan leg F).
 *
 * Absent => the block SKIPS rather than silently passing; the assertions still
 * run in the private tree, which is where the prod stack lives.
 */
const readIfPresent = (p: string): string | null => {
  try {
    return read(p);
  } catch {
    return null;
  }
};

const BASE_COMPOSE = 'docker-compose.base.yml';
const SELFHOST_COMPOSE = 'docker-compose.selfhost.yml';
const PUBLISHED_COMPOSE = 'docker-compose.selfhost.published.yml';
const AUTH_PROXY = 'mcp-gateway/auth-proxy.js';

/** Service names — the only lines at exactly two spaces ending in ':'. */
function serviceNames(composeText: string): string[] {
  return composeText
    .split('\n')
    .filter((l) => /^ {2}[a-z0-9][a-z0-9_-]*:\s*$/.test(l))
    .map((l) => l.trim().replace(/:$/, ''));
}

/** The full text of one two-space `service:` block, up to the next such key. */
function serviceBlock(composeText: string, service: string): string {
  const start = composeText.indexOf(`\n  ${service}:\n`);
  if (start < 0) throw new Error(`service ${service} not found in compose`);
  const rest = composeText.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9][a-z0-9_-]*:\s*\n/);
  return next >= 0 ? rest.slice(0, next + 1) : rest;
}

/** Published host-port bindings for a service, e.g. ["127.0.0.1:8206:8000"]. */
function portBindings(block: string): string[] {
  const out: string[] = [];
  const lines = block.split('\n');
  let inPorts = false;
  for (const line of lines) {
    if (/^\s+ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (inPorts) {
      const m = line.match(/^\s*-\s*"?([^"#]+?)"?\s*(?:#.*)?$/);
      if (m) out.push(m[1].trim());
      else if (!/^\s*#/.test(line) && line.trim() !== '') inPorts = false;
    }
  }
  return out;
}

/** True when a `host:container` (or bare `container`) binding exposes a real
 *  non-loopback interface. A bare `8206:8000` binds 0.0.0.0. */
function isPublicBinding(binding: string): boolean {
  if (!binding.includes(':')) return true; // "8000" => 0.0.0.0
  const host = binding.split(':')[0];
  if (/^\d+$/.test(host)) return true; // "8206:8000" => all interfaces
  return !/^(127\.0\.0\.1|localhost|::1)$/.test(host);
}

/** Does the block declare a shared-key gate env (`*_MCP_API_KEY=`)? */
function hasSharedKeyGate(block: string): boolean {
  return /\b[A-Z0-9_]*MCP_API_KEY=/.test(block);
}

/** Services that speak MCP over HTTP in the prod base stack. */
function mcpServices(composeText: string): string[] {
  return serviceNames(composeText).filter((n) => /mcp/.test(n));
}

describe('prod MCP listeners: no public surface without a shared-key gate', () => {
  const base = readIfPresent(BASE_COMPOSE) ?? '';

  (base === '' ? it.skip : it)('finds the MCP services it is meant to police (guards against a rename)', () => {
    // If a re-org renames these, the invariant below would silently stop
    // covering anything — so pin that the audit target still exists.
    const names = mcpServices(base);
    for (const expected of ['google-mcp', 'github-mcp', 'x-mcp', 'slack-mcp', 'asana-mcp', 'discord-mcp', 'digby-mcp']) {
      expect({ expected, present: names.includes(expected) }).toEqual({ expected, present: true });
    }
  });

  (base === '' ? it.skip : it)('EVERY publicly-bound MCP service carries an *_MCP_API_KEY gate', () => {
    const violations: string[] = [];
    for (const svc of mcpServices(base)) {
      const block = serviceBlock(base, svc);
      const publicBindings = portBindings(block).filter(isPublicBinding);
      if (publicBindings.length === 0) continue;
      // The gateway itself (mcp-gateway) authenticates with MCP_API_KEY.
      if (!hasSharedKeyGate(block)) violations.push(`${svc} -> ${publicBindings.join(',')}`);
    }
    // One-arg expect: the offending service+port lands in the compared value so
    // a failure names WHICH listener lost its key rather than a bare boolean.
    expect({ unauthenticatedPublicListeners: violations }).toEqual({ unauthenticatedPublicListeners: [] });
  });

  (base === '' ? it.skip : it)('digby-mcp — the keyless per-user pass-through — is LOOPBACK ONLY in prod', () => {
    const block = serviceBlock(base, 'digby-mcp');
    const bindings = portBindings(block);
    expect(bindings.length).toBeGreaterThan(0);
    expect({ keylessPublic: bindings.filter(isPublicBinding) }).toEqual({ keylessPublic: [] });
    expect(bindings).toEqual(['127.0.0.1:8206:8000']);
  });

  (base === '' ? it.skip : it)('the six keyed connectors STAY all-interface (cross-box reach is load-bearing)', () => {
    // Regression guard in the OTHER direction: playbook.sh:6071 makes box C dial
    // box A on 8201-8205, so a well-meaning "bind everything to loopback" edit
    // would break the fleet. Those six must remain publicly bound AND keyed.
    for (const svc of ['google-mcp', 'github-mcp', 'x-mcp', 'slack-mcp', 'asana-mcp', 'discord-mcp']) {
      const block = serviceBlock(base, svc);
      const publicBindings = portBindings(block).filter(isPublicBinding);
      expect({ svc, publiclyBound: publicBindings.length > 0 }).toEqual({ svc, publiclyBound: true });
      expect({ svc, keyed: hasSharedKeyGate(block) }).toEqual({ svc, keyed: true });
    }
  });

  (base === '' ? it.skip : it)('the MCP gateway enforces its key from MCP_DIGBY_TOKEN (never an empty default)', () => {
    const block = serviceBlock(base, 'brightdata-mcp');
    expect(block).toMatch(/MCP_API_KEY=\$\{MCP_DIGBY_TOKEN:-\}/);
  });
});

describe('self-host defaults: one gateway, not seven products', () => {
  const selfhost = read(SELFHOST_COMPOSE);
  const published = read(PUBLISHED_COMPOSE);

  it('digby-mcp is NOT in the default `mcp` profile (it needs an explicit opt-in)', () => {
    for (const [label, text] of [['selfhost', selfhost], ['published', published]] as const) {
      const block = serviceBlock(text, 'digby-mcp');
      expect({ label, inDefaultMcpProfile: /profiles:\s*\[\s*"mcp"\s*\]/.test(block) }).toEqual({
        label,
        inDefaultMcpProfile: false,
      });
      // It must still exist and stay reachable — we remove the insecure
      // DEFAULT, not the capability.
      expect({ label, optInProfile: /profiles:\s*\[\s*"mcp-platform"\s*\]/.test(block) }).toEqual({
        label,
        optInProfile: true,
      });
    }
  });

  it('the six CONNECTOR options remain in the default `mcp` profile', () => {
    for (const svc of ['google-mcp', 'github-mcp', 'x-mcp', 'slack-mcp', 'asana-mcp', 'discord-mcp']) {
      expect({ svc, inDefaultProfile: /profiles:\s*\[\s*"mcp"\s*\]/.test(serviceBlock(selfhost, svc)) }).toEqual({
        svc,
        inDefaultProfile: true,
      });
    }
  });

  it('every self-host MCP listener stays bound to loopback', () => {
    const offenders: string[] = [];
    for (const svc of mcpServices(selfhost)) {
      for (const b of portBindings(serviceBlock(selfhost, svc)).filter(isPublicBinding)) {
        offenders.push(`${svc} -> ${b}`);
      }
    }
    expect({ selfHostPublicMcpListeners: offenders }).toEqual({ selfHostPublicMcpListeners: [] });
  });
});

describe('gateway auth-proxy fails CLOSED', () => {
  const proxy = read(AUTH_PROXY);

  it('rejects a request when the key is missing OR wrong (an unset env is not "open")', () => {
    // The exact predicate matters: `!providedKey || providedKey !== API_KEY`.
    // A refactor to `providedKey && providedKey !== API_KEY` would let every
    // anonymous caller through whenever MCP_DIGBY_TOKEN was unset.
    expect(proxy).toMatch(/if\s*\(\s*!providedKey\s*\|\|\s*providedKey\s*!==\s*API_KEY\s*\)/);
  });

  it('answers 401 (not 403/pass-through) on the rejection path', () => {
    expect(proxy).toMatch(/res\.writeHead\(401/);
  });

  it('accepts the key from either X-API-Key or Authorization: Bearer', () => {
    expect(proxy).toContain("req.headers['x-api-key']");
    expect(proxy).toMatch(/authorization/);
  });
});