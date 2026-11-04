/**
 * Quick-lane WEB-TOOL BUDGET — the harness half of the lane brief (roster 2026-10-06 C-4; readiness report #9).
 *
 * The Quick lane exists to answer a lookup FAST: one search, answer from its results, open one page only when they
 * do not answer it (chat-agent/quick-lane-note.ts quickLaneBrief). The brief is advice — real Quick answers on prod
 * made 6, 2, 4, 4, 0, 4, 3, 1 web calls (2026-10-04..06) and the first word took ~91 s p50; every extra web call
 * costs ~25 s on that lane (prod 14 d: first word 13 / 37 / 66 / 144 s at 0 / 1 / 2 / 3 calls). This leaf ENFORCES
 * it in the agent loop (coding/agent.ts, pre-flight block):
 *
 *   search class  search_engine, web_pipe, youtube_pipe              — at most QUICK_WEB_CAP_SEARCH (1) per run
 *   fetch class   scrape_as_markdown, scrape_as_html, scrape_batch,
 *                 browser_task                                       — at most QUICK_WEB_CAP_FETCH (1) per run
 *
 * Past a class's cap the call is refused BEFORE it runs with a harness note ("answer now from what you have; Dig
 * deeper is one tap away") and the class leaves the run's tool list. Mode 'shadow' counts the calls that WOULD be
 * refused and changes nothing. The run result carries the counts (AgentRunResult.webToolCap) and the chat agent
 * records one `quick_lane_tools` loop metric per Quick run.
 *
 * Gate: roster-policy.ts `quickWebCap` 'off' | 'shadow' (default) | 'act' + `quickWebCapCanaryUserIds`;
 * QUICK_LANE_WEB_CAP_DISABLED=1 = off. Pure (the agent loop owns the state object).
 */

export type WebToolClass = 'search' | 'fetch';

export const WEB_TOOL_CLASS: Readonly<Record<string, WebToolClass>> = {
  search_engine: 'search',
  web_pipe: 'search',
  youtube_pipe: 'search',
  scrape_as_markdown: 'fetch',
  scrape_as_html: 'fetch',
  scrape_batch: 'fetch',
  browser_task: 'fetch',
};

export const QUICK_WEB_CAP_SEARCH = 1;
export const QUICK_WEB_CAP_FETCH = 1;

export interface WebToolCaps {
  search: number;
  fetch: number;
  /** 'act' refuses past the cap; 'shadow' only counts. */
  mode: 'act' | 'shadow';
}

export interface WebToolCapState {
  search: number;
  fetch: number;
  /** Calls refused (act). */
  refused: number;
  /** Calls a shadow run would have refused. */
  wouldRefuse: number;
  refusedTools: string[];
}

export function quickWebToolCaps(mode: 'act' | 'shadow'): WebToolCaps {
  return { search: QUICK_WEB_CAP_SEARCH, fetch: QUICK_WEB_CAP_FETCH, mode };
}

export function newWebToolCapState(): WebToolCapState {
  return { search: 0, fetch: 0, refused: 0, wouldRefuse: 0, refusedTools: [] };
}

export function webToolClassOf(tool: string): WebToolClass | null {
  return WEB_TOOL_CLASS[String(tool ?? '')] ?? null;
}

/** The tools of one class (what leaves the tool list once the class is spent). */
export function webToolsOfClass(cls: WebToolClass): string[] {
  return Object.entries(WEB_TOOL_CLASS).filter(([, c]) => c === cls).map(([t]) => t);
}

/**
 * Count one about-to-execute call against the budget. Mutates `state`. Returns whether the call must be REFUSED
 * (act mode, over the cap) — a refused call is not counted as executed. Pure otherwise.
 */
export function webToolCapCheck(caps: WebToolCaps, state: WebToolCapState, tool: string): { cls: WebToolClass | null; over: boolean; refuse: boolean } {
  const cls = webToolClassOf(tool);
  if (!cls) return { cls: null, over: false, refuse: false };
  const cap = cls === 'search' ? caps.search : caps.fetch;
  const used = cls === 'search' ? state.search : state.fetch;
  const over = used >= cap;
  if (over && caps.mode === 'act') {
    state.refused += 1;
    if (!state.refusedTools.includes(tool)) state.refusedTools.push(tool);
    return { cls, over, refuse: true };
  }
  if (over) state.wouldRefuse += 1;
  if (cls === 'search') state.search += 1; else state.fetch += 1;
  return { cls, over, refuse: false };
}

/** The refusal the model reads (failure-shaped: the derail streak sees it). Pure. */
export function webToolCapRefusal(tool: string, cls: WebToolClass, caps: WebToolCaps): string {
  const kind = cls === 'search' ? 'search' : 'page read';
  return `Tool ${tool} failed: [HARNESS — Quick lane web budget] this Quick answer has already used its ${kind} budget (the lane allows ${caps.search} search + ${caps.fetch} page read, then answers). Do NOT search or read more: answer NOW from what you already have, name the source, and if it does not fully answer the question say so briefly — a deeper look is one tap away ("Dig deeper"). ${tool} and its kind are removed from your tool list for the rest of this answer.`;
}
