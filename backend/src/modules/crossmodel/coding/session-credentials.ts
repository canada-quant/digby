/**
 * Digby Code — per-session credential pass-through.
 *
 * Gives a coding session's SHELL (run_command / scripts / git / gh / curl) the
 * SAME access the user granted Digby for chat: their GitHub / Google / Slack /
 * Asana OAuth tokens. Chat already reaches these via the backend tool layer
 * (userId → per-user tokens); this makes the same credentials available INSIDE
 * the session's execution environment so the agent's own commands (push a repo,
 * clone a private repo, hit the Google/Slack/Asana APIs) work like the user does.
 * Web search/scrape is NOT exposed here — it stays a server-side tool so the
 * shared platform BrightData secret never reaches user-controlled shell code.
 *
 * Delivery: the env is merged PER COMMAND (docker exec -e … / in-process env),
 * NOT baked into a long-lived container — so a token refresh is picked up on the
 * next command instead of going stale.
 *
 * SECURITY NOTE (deliberate, product-owner-directed): these are the USER's real
 * OAuth tokens, and the session shell runs arbitrary repo + AI-written code, so a
 * malicious dependency/step could read them from the env. This is the accepted
 * tradeoff for full chat-parity access. What is NOT passed: Digby's own infra LLM
 * / provider API keys (OpenAI/Gemini/DeepSeek/ZAI/Moonshot/DashScope/JWT/DB/etc.)
 * — those are Digby's, not "the user's access", and must never reach a container.
 */

import logger from '../../../utils/logger';
import { getValidToken as githubToken } from '../github/token-manager';
import { getValidToken as googleToken } from '../google/token-manager';
import { getValidToken as slackToken } from '../slack/token-manager';
import { getValidToken as asanaToken } from '../asana/token-manager';
import { getCredentialEnv } from './credentials.service';
import {
  credentialProxySwitchOn, decideProxyEnv, buildProxyEnv, countRawPlatformCreds, recordCredentialProxyMetric,
  ghKitEnabled, buildGhKitEnv, GH_KIT_ENV_KEYS,
  type ProxyEnvDecision,
} from './credential-proxy';

/**
 * Gather the user's connected-integration credentials as an env map to inject into
 * the session shell. Every lookup is best-effort — a not-connected integration is
 * simply omitted; a failure never blocks a command.
 */
export async function gatherSessionCredentialEnv(
  userId: string,
  githubLabel?: string | null,
  /** build 2026-10-08 ISO: the run's session + whether it has a shell (the credential proxy mints per session, shell runs only). */
  opts?: { sessionId?: string; shell?: boolean },
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  if (!userId) return env;

  const [gh, google, slack, asana, userCreds] = await Promise.all([
    githubToken(userId, githubLabel || undefined).catch(() => null),
    googleToken(userId).catch(() => null),
    slackToken(userId).catch(() => null),
    asanaToken(userId).catch(() => null),
    getCredentialEnv(userId).catch(() => ({} as Record<string, string>)),
  ]);

  // User-managed CLI/API credentials (Cloudflare, AWS, Namecheap, Brev, …)
  // merge FIRST so the platform-managed keys below always win a collision
  // (the service deny-lists them anyway — defense in depth).
  Object.assign(env, userCreds);

  // build 2026-10-08 ISO — credential proxy (switch CODING_CREDENTIAL_PROXY):
  // a shell run of a user in the switch gets a session-bound capability and
  // git routed through Digby's proxy INSTEAD of the raw platform tokens
  // (credential-proxy.ts). Fail-to-direct (no https base / key / reachable
  // proxy) keeps today's injection below. One telemetry row per shell run
  // while the switch is on (the "0 raw credentials in the shell env" bar).
  const decision = opts?.shell && opts.sessionId && credentialProxySwitchOn()
    ? await decideProxyEnv({ userId, sessionId: opts.sessionId, githubLabel: githubLabel ?? null }).catch(() => ({ mode: 'fail_to_direct', reason: 'decide_failed' } as ProxyEnvDecision))
    : null;
  if (decision?.mode === 'proxy') {
    const apis = [gh && 'github', google && 'google', slack && 'slack', asana && 'asana'].filter(Boolean) as string[];
    Object.assign(env, buildProxyEnv(decision.base, decision.cap, apis));
    // build 2026-10-11 ISO-GH: the gh kit (wrapper + git shim + forwarder — code, never a secret)
    // so the gh CLI works through the proxy with the capability as its token. Only with a GitHub
    // account connected (without one, direct mode has no GH_TOKEN either — gh stays as it was).
    const ghKit = !!gh && ghKitEnabled();
    if (ghKit) Object.assign(env, buildGhKitEnv(decision.base));
    env.DIGBY_USER_ID = userId;
    recordCredentialProxyMetric({ phase: 'env', mode: 'proxy', rawPlatform: countRawPlatformCreds(env), userManaged: Object.keys(userCreds).length, apis, ghKit }, opts?.sessionId);
    logger.info(`coding: session credential env for user ${userId.slice(0, 8)} — credential PROXY (${apis.join(', ') || 'no platform accounts'})${Object.keys(userCreds).length ? ` + ${Object.keys(userCreds).length} user credential(s)` : ''}`);
    return env;
  }

  if (gh) {
    env.GITHUB_TOKEN = gh;
    env.GH_TOKEN = gh;               // GitHub CLI (`gh`)
    // Make plain `git` (clone/fetch/push over https) authenticate as the user
    // WITHOUT writing the token to a file — an inline credential helper that reads
    // it from the env only for `get`. Uses GIT_CONFIG_* so no `git config` step is
    // needed and it applies to every git invocation in the shell.
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper';
    env.GIT_CONFIG_VALUE_0 = "!f() { test \"$1\" = get && printf 'username=x-access-token\\npassword=%s\\n' \"$GITHUB_TOKEN\"; }; f";
  }
  if (google) env.GOOGLE_ACCESS_TOKEN = google;
  if (slack)  { env.SLACK_TOKEN = slack; env.SLACK_USER_TOKEN = slack; }
  if (asana)  env.ASANA_ACCESS_TOKEN = asana;

  // The shared platform BrightData secret (MCP_DIGBY_TOKEN) is deliberately NOT
  // injected into the session shell: it is a single platform-wide secret, not
  // "the user's access", and arbitrary repo/agent-written code in the shell could
  // read it from the env and exfiltrate it (the output scrubber only sanitizes
  // transcript text, not an outbound curl). Web search/scrape from a coding session
  // goes through the SERVER-SIDE tools (search_engine / scrape_as_markdown /
  // scrape_batch / web_pipe / browser_task), which hold the token in the backend
  // process (mcp-search.ts) and never expose it to user code.
  env.DIGBY_USER_ID = userId;

  const connected = ['github', gh && 'gh', google && 'google', slack && 'slack', asana && 'asana']
    .filter(Boolean);
  const userKeys = Object.keys(userCreds);
  if (decision) recordCredentialProxyMetric({ phase: 'env', mode: decision.mode, reason: (decision as any).reason, rawPlatform: countRawPlatformCreds(env), userManaged: userKeys.length }, opts?.sessionId);
  logger.info(`coding: session credential env for user ${userId.slice(0, 8)} — ${connected.filter(c => c !== 'github').join(', ') || '(none connected)'}${userKeys.length ? ` + ${userKeys.length} user credential(s)` : ''}`);
  return env;
}

/**
 * The env-var NAMES available to a session's shell (values never included) —
 * injected into the system prompt so the agent knows which provider CLIs are
 * already authenticated (wrangler, aws, brev, …) instead of asking for keys.
 */
export function credentialEnvNote(env: Record<string, string>): string {
  const HIDDEN = new Set(['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'DIGBY_USER_ID', 'MCP_DIGBY_URL']);
  // build 2026-10-08 ISO: the credential-proxy block is described on its own (never as "credentials").
  const PROXY_KEYS = new Set<string>(['GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_1', 'GIT_TERMINAL_PROMPT', 'DIGBY_CREDENTIAL_PROXY', 'DIGBY_CREDENTIAL_PROXY_TOKEN', 'DIGBY_CREDENTIAL_PROXY_APIS', ...GH_KIT_ENV_KEYS]);
  const proxy = typeof env.DIGBY_CREDENTIAL_PROXY_TOKEN === 'string';
  const keys = Object.keys(env).filter(k => !HIDDEN.has(k) && !(proxy && PROXY_KEYS.has(k))).sort();
  // build 2026-10-11 ISO-GH: with the gh kit delivered, gh works through the proxy too.
  const ghLine = typeof env.DIGBY_GH_KIT_DIR === 'string'
    ? 'The gh CLI works through the proxy too (gh pr / run / api / issue / repo / workflow; `gh auth status` shows the proxy session) — do not log gh in or set GH_TOKEN (that bypasses the proxy). Release asset uploads (uploads.github.com) are not available through it.'
    : 'The gh CLI is NOT authenticated here.';
  const proxyNote = proxy
    ? `\n\n[CREDENTIAL PROXY]\nYour GitHub / Google / Slack / Asana access goes through Digby's credential proxy — no raw token is in your shell. Plain git over https://github.com (clone, fetch, pull, push) is ALREADY authenticated through it; for publishing prefer the git_push / open_pull_request / merge_pull_request tools. ${ghLine} For a REST call use curl -H "X-Digby-Cap: $DIGBY_CREDENTIAL_PROXY_TOKEN" "$DIGBY_CREDENTIAL_PROXY/api/<provider>/<path>" with <provider> one of: ${env.DIGBY_CREDENTIAL_PROXY_APIS || 'github'} (github → api.github.com/<path>; google → /api/google/<service>.googleapis.com/<path>; slack → slack.com/api/<method>; asana → app.asana.com/api/1.0/<path>). Never print $DIGBY_CREDENTIAL_PROXY_TOKEN.`
    : '';
  if (!keys.length) return proxyNote;
  return `\n\n[CONNECTED CREDENTIALS]\nThese environment variables are ALREADY SET in your shell for every command (values hidden; never echo them): ${keys.join(', ')}. Use the matching CLIs/APIs directly (e.g. wrangler for CLOUDFLARE_*, aws for AWS_*, gh/git for GITHUB_*) — never ask the user for keys that are listed here, and never print their values.${proxyNote}`;
}
