/**
 * Web-search configuration state — a PURE, import-free leaf (the
 * serp-provider-guard / instance-targets pattern; ticket 6f4d42f2).
 *
 * WHY this exists: the agent-facing search consumers (tool-executor's
 * search_engine / web_pipe tools, coding/web-pipe.ts) must report WHY search
 * failed when the instance has no search credentials — "search not configured
 * — set a Bright Data key in Admin → Settings" instead of the generic
 * unreachable/rate-limited text the owner saw on his self-hosted deployment.
 * But those consumers import mcp-search through PARTIAL-FACTORY jest mocks
 * ({ callMcpTool, extractPdfTextFromUrl } only — see the module-mock rule in
 * coding/web-pipe.ts), so they can never import a new symbol from it. This
 * leaf carries the signal through: the search tier (mcp-search.callMcpTool)
 * records the outcome of its credential resolution here, and every consumer
 * reads it — no new import edges, no mock contract change.
 *
 * Last-known state ONLY — the live answer always comes from the tier itself
 * (a fresh callMcpTool records a fresh row). Never a source of truth for
 * routing decisions: callMcpTool routes on what IT resolved this call.
 */

export interface SearchConfigState {
  /** Timestamp (Date.now()) of the last callMcpTool credential resolution. */
  at: number;
  /** True when EITHER tier could run this call: a Bright Data credential was
   *  resolved from env or the admin store, or the gateway tier is armed
   *  (MCP_DIGBY_TOKEN present — the gateway carries its own credentials). */
  anyBackendArmed: boolean;
}

let _last: SearchConfigState | null = null;

/** The operator-facing failure text for an instance with NO search credentials
 *  configured (ticket 6f4d42f2's ask #3): names the missing configuration and
 *  where to fix it, never the generic unreachable/rate-limited wording. */
export const SEARCH_NOT_CONFIGURED_MSG =
  'Web search is not configured on this Digby instance — no Bright Data credential is set, so every search/scrape path fails. ' +
  'An admin must set a Bright Data API key in Admin → Settings → Web search (a self-hosted/Edge instance has no env config for it; the cloud instance gets it from env). ' +
  'Do not retry this tool this session: answer from your existing knowledge, tell the user web search is not configured, and ask them to set the key in Admin → Settings.';

/** Record the outcome of a credential resolution (called by the search tier). Pure setter — never throws. */
export function recordSearchConfigState(s: SearchConfigState): void {
  _last = { at: s.at, anyBackendArmed: !!s.anyBackendArmed };
}

/** The last recorded resolution (null before the first callMcpTool in this process). */
export function lastSearchConfigState(): SearchConfigState | null {
  return _last;
}

/** Test-only reset (keeps suites independent). */
export function __resetSearchConfigStateForTest(): void {
  _last = null;
}
