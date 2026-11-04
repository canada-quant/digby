/**
 * GitHub MCP Client
 *
 * Calls the github-mcp Docker container via JSON-RPC 2.0 / MCP Streamable HTTP.
 * Passes the user's GitHub access token via X-GitHub-Token header.
 *
 * The GitHub MCP container runs at http://github-mcp-prod:8000 (Docker network).
 * It validates X-API-Key then forwards X-GitHub-Token to the inner MCP server.
 *
 * Returns formatted context strings. READS surface a failed call as ONE readable
 * line (2026-10-04, integrations/integration-error.ts) — GitHub rejected the
 * credentials (reconnect) / rate-limited / GitHub down / the github-mcp
 * connector did not answer / not configured — instead of '' (which the coding
 * executor turned into "No result from GitHub … may not be connected … or
 * nothing matched"). Not-connected and genuinely-empty results keep ''.
 * INTEGRATION_ERROR_SURFACE_DISABLED=1 restores the old silent ''.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { getValidToken, getAllValidTokens, hasGitHubConnected } from './token-manager';
import {
  IntegrationApiError, INTEGRATION_SERVICES, integrationErrorSurfaceDisabled, surfacedOrEmpty,
  connectorTransportError, mcpOperationLabel, isErrorShapedText, classifyUpstreamErrorText, stripErrorPrefix, clipErrorDetail,
} from '../integrations/integration-error';
import { githubFileReadToolDisabled, isGitHubFileNotFoundText } from '../coding/integration-tool-schema';

const SERVICE = INTEGRATION_SERVICES.github;
/** Reads run strict (a failure throws IntegrationApiError) unless the kill switch is set. */
const strictRead = () => !integrationErrorSurfaceDisabled();
const opOf = (toolName: string) => mcpOperationLabel(toolName, 'github_');

/** A connected user whose every stored token is unusable (decrypt failed) — not "not connected". */
async function noTokenButConnected(userId: string): Promise<boolean> {
  return Promise.resolve().then(() => hasGitHubConnected(userId)).catch(() => false);
}

/** Fan-out failure → IntegrationApiError (a plain rejection keeps its words as kind 'other'). */
function asIntegrationError(toolName: string, err: any): IntegrationApiError {
  return err instanceof IntegrationApiError ? err : new IntegrationApiError(SERVICE, opOf(toolName), 'other', null, String(err?.message ?? err));
}

const GITHUB_MCP_URL    = process.env.GITHUB_MCP_URL || 'http://github-mcp-prod:8000/mcp';
const GITHUB_MCP_API_KEY = process.env.GITHUB_MCP_API_KEY;

// ── Core MCP call (SSE streaming response) ────────────────────────────────────

/**
 * `strict` (reads only): a transport failure, a JSON-RPC error, a missing
 * server key, and a provider error the container returned as "Error …" text
 * that classifies as auth / rate-limited / down all THROW IntegrationApiError
 * (an auth/rate error on one credential therefore falls through to the next
 * connected one in callGitHubMcpTool). Non-strict is byte-identical to before.
 */
async function callMcpWithToken(
  token: string,
  toolName: string,
  params: Record<string, unknown>,
  strict = false,
): Promise<string | null> {
  const op = opOf(toolName);
  if (!GITHUB_MCP_API_KEY) {
    logger.warn(`GitHub MCP: GITHUB_MCP_API_KEY not set, skipping ${toolName}`);
    if (strict) throw new IntegrationApiError(SERVICE, op, 'not_configured', null, 'GITHUB_MCP_API_KEY unset');
    return null;
  }

  const requestId = Date.now() + Math.floor(Math.random() * 10000);

  try {
    const response = await axios.post(
      GITHUB_MCP_URL,
      {
        jsonrpc: '2.0',
        method:  'tools/call',
        params:  { name: toolName, arguments: params },
        id:      requestId,
      },
      {
        headers: {
          'Content-Type':   'application/json',
          'Accept':         'application/json, text/event-stream',
          'X-API-Key':      GITHUB_MCP_API_KEY,
          'X-GitHub-Token': token,
        },
        timeout:      25000,
        responseType: 'stream',
      }
    );

    return new Promise((resolve, reject) => {
      const stream = response.data;
      let buffer   = '';
      let resolved = false;

      const safetyTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          stream.destroy();
          const e = new Error(`GitHub MCP ${toolName} timed out`);
          reject(strict ? connectorTransportError(SERVICE, op, e) : e);
        }
      }, 25000);

      stream.on('data', (chunk: Buffer) => {
        if (resolved) return;
        buffer += chunk.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const rawJson = trimmed.slice(5).trim();
          if (!rawJson || rawJson === '[DONE]') continue;

          try {
            const parsed = JSON.parse(rawJson);
            if (parsed.id !== requestId) continue;

            resolved = true;
            clearTimeout(safetyTimer);
            stream.destroy();

            if (parsed.error) {
              reject(strict
                ? new IntegrationApiError(SERVICE, op, 'other', null, `MCP error: ${parsed.error.message || 'unknown'}`)
                : new Error(parsed.error.message || 'MCP error'));
              return;
            }

            const content = parsed.result?.content;
            if (!content || !Array.isArray(content)) { resolve(null); return; }
            const text = content.find((c: any) => c.type === 'text')?.text || null;
            // github-mcp answers an Octokit error as "Error <doing x>: <reason>" text. An
            // actionable class (Bad credentials / rate limit / GitHub 5xx) becomes the
            // standard line; anything else (Not Found …) stays the container's own words.
            if (strict && isErrorShapedText(text)) {
              const kind = classifyUpstreamErrorText(text as string);
              if (kind) { reject(new IntegrationApiError(SERVICE, op, kind, null, stripErrorPrefix(text as string))); return; }
            }
            resolve(text);
          } catch { /* skip non-JSON SSE lines */ }
        }
      });

      stream.on('error', (err: Error) => {
        if (!resolved) { resolved = true; clearTimeout(safetyTimer); reject(strict ? connectorTransportError(SERVICE, op, err) : err); }
      });

      stream.on('end', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(safetyTimer);
          const e = new Error(`SSE stream ended without response for ${toolName}`);
          reject(strict ? connectorTransportError(SERVICE, op, e) : e);
        }
      });
    });
  } catch (error: any) {
    logger.warn(`GitHub MCP ${toolName} failed: ${error.message}`);
    if (strict) throw connectorTransportError(SERVICE, op, error);
    return null;
  }
}

/**
 * GITHUB_NOT_FOUND_FALLTHROUGH_DISABLED=1 (review 2026-10-22): getFileContents
 * returns the FIRST connected account's "Not Found" text again, without trying
 * the others.
 */
const notFoundFallthroughDisabled = () => process.env.GITHUB_NOT_FOUND_FALLTHROUGH_DISABLED === '1';

async function callGitHubMcpTool(
  userId: string,
  toolName: string,
  params: Record<string, unknown>,
  strict = false,
  opts: { isMiss?: (text: string) => boolean } = {},
): Promise<string | null> {
  // Try EVERY connected credential (OAuth accounts + PATs + multiple labels), not
  // just the first. A given repo may only be visible to one specific connection
  // (e.g. an org PAT, or a "Work" account), so we fall through on per-credential
  // errors/empties and return the first connection that actually returns data.
  const accounts = await getAllValidTokens(userId);
  if (accounts.length === 0) {
    logger.warn(`GitHub MCP: No valid token for userId=${userId}, skipping ${toolName}`);
    if (strict && await noTokenButConnected(userId)) throw new IntegrationApiError(SERVICE, opOf(toolName), 'no_token', null, '');
    return null;
  }
  let lastErr: any = null;
  let errCount = 0;
  // `isMiss`: an answer that is really "this credential cannot see it" (GitHub's
  // 404 for a private repo the token has no access to). It is remembered and the
  // next account is tried; it becomes the answer only once every account missed.
  let firstMiss: string | null = null;
  let missCount = 0;
  for (const account of accounts) {
    try {
      const result = await callMcpWithToken(account.token, toolName, params, strict);
      if (result && opts.isMiss?.(result)) { firstMiss ??= result; missCount++; continue; }
      if (result) return result;
    } catch (err: any) {
      // 403/404/no-access on this credential → try the next connected one.
      lastErr = err;
      errCount++;
    }
  }
  if (firstMiss) {
    // The miss is only as strong as the accounts that answered it — say how many
    // were tried and which could not be checked (that one may see the path).
    const lines = [firstMiss];
    if (accounts.length > 1 && missCount === accounts.length) lines.push(`(every connected GitHub account (${missCount}) answered Not Found)`);
    if (errCount > 0) {
      const why = clipErrorDetail(lastErr?.message ?? lastErr, 200);
      lines.push(`(${errCount} other connected GitHub account${errCount === 1 ? '' : 's'} could not be checked (${why}) — the path may be visible to ${errCount === 1 ? 'it' : 'them'})`);
    }
    return lines.join('\n');
  }
  if (lastErr) {
    logger.warn(`GitHub MCP ${toolName}: all ${accounts.length} connected account(s) failed (last: ${lastErr.message})`);
    // Strict: every credential failed — the last reason is the answer, never ''.
    if (strict) throw asIntegrationError(toolName, lastErr);
  }
  return null;
}

/**
 * Strict fan-out bookkeeping: the labeled failure lines for the accounts whose
 * call failed. All failed → the lines ARE the answer; some failed → they ride
 * under the successful sections so the model knows the listing is partial.
 */
function failureSections(failures: Array<{ label: string; err: IntegrationApiError }>, accountCount: number): string[] {
  return failures.map(f => (accountCount > 1 ? `--- ${f.label} ---\n${f.err.message}` : f.err.message));
}

// ── Public tool functions ─────────────────────────────────────────────────────

export async function listUserRepos(
  userId: string,
  sort?: string,
  perPage = 10,
): Promise<string> {
  try {
    const accounts = await getAllValidTokens(userId);

    const strict = strictRead();
    if (accounts.length === 0) {
      if (strict && await noTokenButConnected(userId)) return new IntegrationApiError(SERVICE, opOf('github_list_repos'), 'no_token', null, '').message;
      return '';
    }

    const failures: Array<{ label: string; err: IntegrationApiError }> = [];
    const settled = await Promise.allSettled(
      accounts.map(async (account) => {
        const label = account.username
          ? `${account.label} (@${account.username})`
          : account.label;
        let result: string | null;
        try {
          result = await callMcpWithToken(account.token, 'github_list_repos', {
            sort,
            perPage,
          }, strict);
        } catch (err: any) {
          if (strict) failures.push({ label, err: asIntegrationError('github_list_repos', err) });
          throw err;
        }
        if (!result) return null;
        return `--- ${label} ---\n${result}`;
      })
    );

    const sections = settled
      .filter((r): r is PromiseFulfilledResult<string> =>
        r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    if (sections.length === 0) return failureSections(failures, accounts.length).join('\n');
    sections.push(...failureSections(failures, 2));

    logger.info(
      `GitHub MCP: github_list_repos for userId=${userId} across ${accounts.length} account(s)`
    );
    return `[GitHub Repositories]\n${sections.join('\n\n')}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function getRepo(
  userId: string,
  owner: string,
  repo: string,
): Promise<string> {
  try {
    const result = await callGitHubMcpTool(userId, 'github_get_repo', { owner, repo }, strictRead());
    if (!result) return '';
    return `[GitHub Repository: ${owner}/${repo}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

// ── Code-search scoping (ticket 0b35a32c) ────────────────────────────────────
// github_search_code used to forward the caller's query VERBATIM to GitHub's
// /search/code endpoint — a GLOBAL search across every public repo on GitHub.
// Plain queries (e.g. a ticket id like "065caccb") returned plausible-looking
// hits from unrelated public repos — a verification hazard for an agent asking
// about the user's OWN code (2026-09-15, live-reproduced: 12 hits in defold/
// defold etc., none in the connected account's repos). Unscoped queries are
// now auto-scoped per connected account (user:<login> + org:<org> for each org
// the token belongs to, plus fork:true so the account's own forks count as
// "connected repos"). Queries that already carry an explicit scope qualifier
// (user:/org:/repo:/owner:) pass through unchanged.
// GitHub's code-search index covers each repo's DEFAULT branch only and does
// not index every private repo (verified live 2026-09-15 with the owner's
// token: org-owned private repos ARE searchable — repo:canada-quant/bearclaw
// import → 535 — while the user-owned private repo canada-quant/digby
// returns 0 for every term). The header + the MCP server's empty-result text
// state this instead of letting silence look like "no matches in your code".

/** Matches an explicit GitHub code-search scope qualifier in the query. */
const CODE_SEARCH_SCOPE_RE = /(?:^|\s)(?:user|org|repo|owner):/i;

/** Cap on org: qualifiers appended to a scoped query (query-length sanity). */
const MAX_SCOPE_ORGS = 10;

// The known-path pointer names a tool only while it is exposed
// (GITHUB_FILE_READ_TOOL_DISABLED=1 removes it — integration-tool-schema.ts).
const codeSearchIndexNote = (): string =>
  "GitHub's code-search index covers each repo's default branch only; forks match only with fork:true, and some private repos are not indexed"
  + (githubFileReadToolDisabled() ? '' : ' (for a known path, use github_get_file_contents)');

const accountScopeCache = new Map<string, { login?: string; orgs: string[]; at: number }>();
const ACCOUNT_SCOPE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolve the account's login (when token-manager doesn't have it) and its org
 * memberships via the GitHub REST API, cached briefly per token. THROWS on
 * HTTP failure — callers catch and fall back to the scope they already have.
 */
async function fetchAccountScope(
  token: string,
  knownLogin?: string,
): Promise<{ login?: string; orgs: string[] }> {
  const cached = accountScopeCache.get(token);
  if (cached && Date.now() - cached.at < ACCOUNT_SCOPE_TTL_MS) {
    return { login: cached.login ?? knownLogin, orgs: cached.orgs };
  }
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
  let login = knownLogin;
  if (!login) {
    const me = await axios.get('https://api.github.com/user', { headers, timeout: 10_000 });
    login = me.data?.login || undefined;
  }
  const orgsResp = await axios.get('https://api.github.com/user/orgs?per_page=100', { headers, timeout: 10_000 });
  const orgs: string[] = Array.isArray(orgsResp.data)
    ? orgsResp.data
        .map((o: any) => o?.login)
        .filter((l: any): l is string => typeof l === 'string' && l.length > 0)
    : [];
  accountScopeCache.set(token, { login, orgs, at: Date.now() });
  return { login, orgs };
}

/**
 * Append a connected-account scope to a code-search query that lacks one.
 * Exported for tests. `scoped` reports whether the returned query carries any
 * scope (explicit or appended); without a login there is nothing to scope to.
 */
export function buildScopedCodeQuery(
  query: string,
  login?: string,
  orgs: string[] = [],
): { q: string; scoped: boolean } {
  const trimmed = query.trim();
  if (!trimmed) return { q: trimmed, scoped: false };
  if (CODE_SEARCH_SCOPE_RE.test(trimmed)) return { q: trimmed, scoped: true };
  const scope: string[] = [];
  if (login) scope.push(`user:${login}`);
  for (const org of orgs.slice(0, MAX_SCOPE_ORGS)) scope.push(`org:${org}`);
  if (scope.length === 0) return { q: trimmed, scoped: false };
  return { q: `${trimmed} ${scope.join(' ')} fork:true`, scoped: true };
}

export async function searchCode(
  userId: string,
  query: string,
  perPage = 10,
): Promise<string> {
  try {
    // Explicit scope (user:/org:/repo:/owner:) → keep the historical
    // first-account-with-results behavior; the caller targeted a specific
    // scope, so one account's answer is the right one.
    if (CODE_SEARCH_SCOPE_RE.test(query.trim())) {
      const result = await callGitHubMcpTool(userId, 'github_search_code', { query, perPage }, strictRead());
      if (!result) return '';
      return `[GitHub Code Search — explicit scope; ${codeSearchIndexNote()}]\n${result}`;
    }

    // Unscoped → auto-scope per connected account and merge labeled sections,
    // so a plain query can never silently return GitHub-wide hits again.
    const accounts = await getAllValidTokens(userId);
    const strict = strictRead();
    if (accounts.length === 0) {
      if (strict && await noTokenButConnected(userId)) return new IntegrationApiError(SERVICE, opOf('github_search_code'), 'no_token', null, '').message;
      return '';
    }

    const failures: Array<{ label: string; err: IntegrationApiError }> = [];
    const settled = await Promise.allSettled(
      accounts.map(async (account) => {
        let login = account.username;
        let orgs: string[] = [];
        try {
          const scope = await fetchAccountScope(account.token, login);
          login = scope.login ?? login;
          orgs = scope.orgs;
        } catch { /* login/org lookup failed → scope with what we have */ }
        const { q, scoped } = buildScopedCodeQuery(query, login, orgs);
        const label = account.username ? `${account.label} (@${account.username})` : account.label;
        let result: string | null;
        try {
          result = await callMcpWithToken(account.token, 'github_search_code', { query: q, perPage }, strict);
        } catch (err: any) {
          if (strict) failures.push({ label, err: asIntegrationError('github_search_code', err) });
          throw err;
        }
        if (!result) return null;
        const scopeDesc = scoped
          ? `effective query: ${q}`
          : 'UNSCOPED (GitHub-wide — connected account login unknown)';
        return `--- ${label} | ${scopeDesc} ---\n${result}`;
      })
    );

    const sections = settled
      .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);
    if (sections.length === 0) return failureSections(failures, accounts.length).join('\n');
    sections.push(...failureSections(failures, 2));

    return [
      `[GitHub Code Search — scoped to the connected GitHub account(s); ${codeSearchIndexNote()}]`,
      sections.join('\n\n'),
    ].join('\n');
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function listIssues(
  userId: string,
  owner: string,
  repo: string,
  state?: string,
  perPage = 10,
): Promise<string> {
  try {
    const result = await callGitHubMcpTool(userId, 'github_list_issues', {
      owner, repo, state, perPage,
    }, strictRead());
    if (!result) return '';
    return `[GitHub Issues: ${owner}/${repo}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function getIssue(
  userId: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string> {
  try {
    const result = await callGitHubMcpTool(userId, 'github_get_issue', {
      // The github-mcp server's zod schema requires snake_case `issue_number`
      // (github-mcp/src/server.ts). Sending camelCase `issueNumber` fails
      // validation with -32602 "path [issue_number]: Required".
      owner, repo, issue_number: issueNumber,
    }, strictRead());
    if (!result) return '';
    return `[GitHub Issue #${issueNumber}: ${owner}/${repo}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function listPullRequests(
  userId: string,
  owner: string,
  repo: string,
  state?: string,
  perPage = 10,
): Promise<string> {
  try {
    const result = await callGitHubMcpTool(userId, 'github_list_pull_requests', {
      owner, repo, state, perPage,
    }, strictRead());
    if (!result) return '';
    return `[GitHub Pull Requests: ${owner}/${repo}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function getFileContents(
  userId: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string,
): Promise<string> {
  try {
    // GitHub 404s a private repo the token cannot see exactly like a missing
    // path, so a "Not Found" from one account is a per-account miss: the next
    // connected account is tried before the 404 is the answer (review 2026-10-22).
    const result = await callGitHubMcpTool(userId, 'github_get_file_contents', {
      owner, repo, path, ref,
    }, strictRead(), notFoundFallthroughDisabled() ? {} : { isMiss: isGitHubFileNotFoundText });
    if (!result) return '';
    return `[GitHub File: ${owner}/${repo}/${path}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function getAuthenticatedUser(userId: string): Promise<string> {
  try {
    const result = await callGitHubMcpTool(userId, 'github_get_user', {}, strictRead());
    if (!result) return '';
    return `[GitHub User]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}
