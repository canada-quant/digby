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

/**
 * A live ZONE rejection seen by the search tier (ticket 02f8c83f).
 *
 * THE DEFECT CLASS this closes: a saved Bright Data key with a zone that does
 * not exist on the account. Bright Data answers **HTTP 200 with a zero-byte
 * body** and puts the truth only in headers (`x-brd-err-code: client_10002`,
 * `x-brd-status-code: 407`, `x-brd-error: Zone not found`), so the settings
 * page showed "saved key ••••7b31 / zone (default: web_unlocker1)" while every
 * SERP and scrape returned nothing. The tier now records the rejection HERE
 * (this module is an import-free leaf both sides already load), so the admin
 * status read can say "that zone does not exist" instead of staying green.
 */
export interface ZoneFailureState {
  /** Timestamp (Date.now()) of the observation. */
  at: number;
  /** The zone name the failed call used. */
  zone: string;
  /** The provider's own err-code — normally 'client_10002'. */
  code: string;
}

let _lastZoneFailure: ZoneFailureState | null = null;

/** Record a provider ZONE rejection (pure setter — never throws). */
export function recordZoneFailure(f: ZoneFailureState): void {
  _lastZoneFailure = { at: f.at, zone: String(f.zone || ''), code: String(f.code || '') };
}

/** The last zone rejection observed by this process, or null. */
export function lastZoneFailure(): ZoneFailureState | null {
  return _lastZoneFailure;
}

/** Forget a recorded zone rejection — called when the zone is confirmed GOOD
 *  again (a successful save, or a probe that verifies the zone exists), so a
 *  repaired config never keeps rendering the old failure (reviewer F3). */
export function clearZoneFailure(): void {
  _lastZoneFailure = null;
}

/** Test-only: forget the recorded zone rejection. */
export function __clearZoneFailureForTest(): void {
  _lastZoneFailure = null;
}

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
