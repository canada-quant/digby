/**
 * Quick-lane brief — dynamic roster (docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §7, 2026-10-04).
 * A pure LEAF appended to the chat doctrine ONLY on a turn the Quick lane runs.
 *
 * Why: the first live query-suite run (scripts/e2e/query-suite.py, seed 303) put six turns on
 * the Quick lane. The two with no tools answered in 7.8 s / 19.1 s, but the web lookups chained
 * 3–5 tools under the full chat doctrine ("use web_pipe … fastest path", memory search first):
 * weather 44.6 s / 93.2 s, sports 68.8 s, news 161.8 s to the first token — the lane's speed was
 * spent in the tool loop, not the model. The brief keeps the lane what the turn plan chose it for:
 * one search, answer from its results, open one page only when they do not answer it.
 * Kill switch QUICK_LANE_BRIEF_DISABLED=1 (the Quick lane runs on the plain chat doctrine).
 */
export const QUICK_LANE_BRIEF_DISABLED_ENV = 'QUICK_LANE_BRIEF_DISABLED';

export function quickLaneBrief(env: Record<string, string | undefined> = process.env, opts: { webBudgetEnforced?: boolean; webSearchConfigured?: boolean } = {}): string {
  if (env[QUICK_LANE_BRIEF_DISABLED_ENV] === '1') return '';
  // Self-host setup hardening (2026-10-20): an instance with no search backend
  // must not be ordered to "search once and name the source".
  const noWeb = opts.webSearchConfigured === false;
  return [
    '## Quick answer lane (this turn)',
    'This question was routed to the QUICK lane: a short lookup that a fast model answers as well as a strong one. Answer it fast:',
    ...(noWeb
      ? ['- This instance has NO live web tools (web search is not set up here): answer from your own knowledge in a few sentences, and say so in one sentence when the question needs current facts.']
      : [
        '- At most ONE search_engine call, then answer straight from its results when they contain the answer (name the source). Open ONE page with scrape_as_markdown only when the results do not answer it.',
        '- Skip web_pipe, delegate, browser_task and search_memory here — unless the user explicitly asked for that tool ("use the browser…") or the question is about the user\'s own data, files or account.',
      ]),
    '- Answer in a few sentences. If the question turns out to need real research, answer what you found and say a deeper look is one tap away ("Dig deeper").',
    // roster 2026-10-06 C-4: when the harness budget ACTS (coding/web-tool-cap.ts) the model is told up front, so it
    // never spends a round on a call that will be refused.
    ...(opts.webBudgetEnforced && !noWeb ? ['- This budget is ENFORCED: a second search, or a second page read, is refused by the harness — plan for one of each.'] : []),
  ].join('\n');
}
