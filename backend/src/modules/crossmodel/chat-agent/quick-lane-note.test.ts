import { quickLaneBrief, QUICK_LANE_BRIEF_DISABLED_ENV } from './quick-lane-note';

describe('quickLaneBrief', () => {
  it('caps the lookup at one search, names the heavy tools to skip and points at Dig deeper', () => {
    const brief = quickLaneBrief({});
    expect(brief).toMatch(/^## Quick answer lane/);
    expect(brief).toMatch(/At most ONE search_engine call/);
    expect(brief).toMatch(/Skip web_pipe, delegate, browser_task and search_memory/);
    expect(brief).toMatch(/unless the user explicitly asked for that tool/); // an explicit ask ("use the browser") beats the lane brief
    expect(brief).toMatch(/Dig deeper/);
  });

  it('roster 2026-10-06 C-4: an ACTING harness web budget is stated up front; shadow / off say nothing extra', () => {
    expect(quickLaneBrief({}, { webBudgetEnforced: true })).toMatch(/ENFORCED: a second search, or a second page read, is refused/);
    expect(quickLaneBrief({})).not.toMatch(/ENFORCED/);
    expect(quickLaneBrief({}, { webBudgetEnforced: false })).not.toMatch(/ENFORCED/);
  });

  it('self-host 2026-10-20: with no web search the brief orders no search and names no web tool; configured / omitted is byte-identical', () => {
    const noWeb = quickLaneBrief({}, { webSearchConfigured: false });
    expect(noWeb).toMatch(/NO live web tools/);
    expect(noWeb).not.toMatch(/search_engine|scrape_as_markdown|web_pipe/);
    expect(quickLaneBrief({}, { webSearchConfigured: true })).toBe(quickLaneBrief({}));
    expect(quickLaneBrief({}, { webBudgetEnforced: true, webSearchConfigured: true })).toBe(quickLaneBrief({}, { webBudgetEnforced: true }));
    expect(quickLaneBrief({}, { webBudgetEnforced: true, webSearchConfigured: false })).not.toMatch(/ENFORCED/); // nothing to budget
  });

  it(`${QUICK_LANE_BRIEF_DISABLED_ENV}=1 returns nothing (the plain chat doctrine)`, () => {
    expect(quickLaneBrief({ [QUICK_LANE_BRIEF_DISABLED_ENV]: '1' })).toBe('');
  });
});
