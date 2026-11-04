/** Quick-lane web budget — the pure leaf (roster 2026-10-06 C-4). */
import {
  newWebToolCapState, quickWebToolCaps, webToolCapCheck, webToolCapRefusal, webToolClassOf, webToolsOfClass,
  QUICK_WEB_CAP_FETCH, QUICK_WEB_CAP_SEARCH,
} from './web-tool-cap';

describe('web-tool-cap', () => {
  it('classes: searches (incl. the pipes) vs page reads (incl. browser_task); everything else is not budgeted', () => {
    expect(['search_engine', 'web_pipe', 'youtube_pipe'].map(webToolClassOf)).toEqual(['search', 'search', 'search']);
    expect(['scrape_as_markdown', 'scrape_as_html', 'scrape_batch', 'browser_task'].map(webToolClassOf)).toEqual(['fetch', 'fetch', 'fetch', 'fetch']);
    expect(webToolClassOf('search_memory')).toBeNull();
    expect(webToolClassOf('fetch_image')).toBeNull();
    expect(webToolsOfClass('search').sort()).toEqual(['search_engine', 'web_pipe', 'youtube_pipe']);
  });

  it('the Quick budget is one search + one page read', () => {
    expect([QUICK_WEB_CAP_SEARCH, QUICK_WEB_CAP_FETCH]).toEqual([1, 1]);
    expect(quickWebToolCaps('act')).toEqual({ search: 1, fetch: 1, mode: 'act' });
  });

  it('act: the first of each class runs, the next is refused (not counted as executed)', () => {
    const caps = quickWebToolCaps('act');
    const st = newWebToolCapState();
    expect(webToolCapCheck(caps, st, 'search_engine')).toEqual({ cls: 'search', over: false, refuse: false });
    expect(webToolCapCheck(caps, st, 'web_pipe')).toEqual({ cls: 'search', over: true, refuse: true });
    expect(webToolCapCheck(caps, st, 'scrape_as_markdown').refuse).toBe(false);
    expect(webToolCapCheck(caps, st, 'browser_task').refuse).toBe(true);
    expect(webToolCapCheck(caps, st, 'search_memory')).toEqual({ cls: null, over: false, refuse: false });
    expect(st).toEqual({ search: 1, fetch: 1, refused: 2, wouldRefuse: 0, refusedTools: ['web_pipe', 'browser_task'] });
  });

  it('shadow: nothing is refused, the would-be refusals are counted', () => {
    const caps = quickWebToolCaps('shadow');
    const st = newWebToolCapState();
    for (const t of ['search_engine', 'search_engine', 'search_engine', 'scrape_as_markdown']) expect(webToolCapCheck(caps, st, t).refuse).toBe(false);
    expect(st).toMatchObject({ search: 3, fetch: 1, refused: 0, wouldRefuse: 2 });
  });

  it('the refusal is failure-shaped and steers to answering now + Dig deeper', () => {
    const t = webToolCapRefusal('search_engine', 'search', quickWebToolCaps('act'));
    expect(t.startsWith('Tool search_engine failed:')).toBe(true);
    expect(t).toMatch(/answer NOW/);
    expect(t).toMatch(/Dig deeper/);
  });
});
